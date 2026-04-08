/**
 * Albatross — Torrent Streaming Engine
 *
 * Pure JavaScript torrent client using torrent-stream (same engine
 * as Peerflix/Popcorn Time). No native C++ modules required.
 *
 * Streams video files over HTTP with range-request support.
 *
 * Security layers:
 *   1. Only video file extensions are ever served or downloaded
 *   2. Magic byte validation ensures the file is a real video container
 *   3. Path traversal protection rejects filenames with ../ or absolute paths
 *   4. Max file size cap prevents disk exhaustion
 *   5. Non-video files are deselected so they never download
 *   6. Content-Disposition forces safe inline playback
 *   7. Idle cleanup + concurrency limit bound resource usage
 */

const torrentStream = require('torrent-stream');
const { spawn } = require('child_process');
const { Transform } = require('stream');
const fs = require('fs');
const path = require('path');
const { TRACKERS, isFileNameSafe, getMimeType, sanitizeFilename } = require('./file-safety');

const IDLE_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const ACTIVE_DL_RECHECK = 10 * 60 * 1000; // re-check in 10 min if still downloading
const DEFAULT_MAX_CONCURRENT = 5;
const MAX_FILE_SIZE = 20 * 1024 * 1024 * 1024; // 20 GB
const MAGIC_READ_SIZE = 16;

const VIDEO_SIGNATURES = [
  { offset: 4, bytes: Buffer.from('ftyp') },       // MP4/M4V/MOV
  { offset: 0, bytes: Buffer.from([0x1A, 0x45, 0xDF, 0xA3]) }, // MKV/WebM
  { offset: 0, bytes: Buffer.from('RIFF') },        // AVI
  { offset: 0, bytes: Buffer.from('FLV') },         // FLV
  { offset: 0, bytes: Buffer.from([0x47]) },        // MPEG-TS
  { offset: 0, bytes: Buffer.from([0x00, 0x00, 0x01, 0xBA]) }, // MPEG-PS
  { offset: 0, bytes: Buffer.from([0x00, 0x00, 0x01, 0xB3]) }, // MPEG video
  { offset: 0, bytes: Buffer.from([0x30, 0x26, 0xB2, 0x75]) }, // WMV/ASF
];

class TorrentEngine {
  constructor(opts = {}) {
    this._active = new Map(); // infoHash -> { engine, files, lastAccess, timer }
    this._streamStats = new Map(); // streamKey -> { bytesSent, startTime, lastBytes, lastTime, egressRate, mode, hash }
    this._streamIdCounter = 0;
    // Tracks in-flight ffmpeg remux pipelines so two near-simultaneous probe
    // requests from the same player don't spawn duplicate ffmpeg processes.
    // Key = `${hash}:${fileIdx ?? '*'}`, Value = { startedAt }
    this._remuxInFlight = new Map();
    this._downloadPath = opts.downloadPath || path.join(process.cwd(), '.torrent-cache');
    this._maxFileSize = opts.maxFileSize || MAX_FILE_SIZE;
    this._maxConcurrent = opts.maxConcurrent || DEFAULT_MAX_CONCURRENT;
  }

  /**
   * Get or start a torrent by magnet URI or infoHash.
   * Returns a promise that resolves with { engine, files } once metadata is ready.
   */
  async getTorrent(magnetOrHash) {
    const hash = this._extractHash(magnetOrHash);
    if (!hash) throw new Error('Invalid infoHash or magnet URI');

    // Already active?
    const existing = this._active.get(hash);
    if (existing && existing.files) {
      this._touchTorrent(hash);
      return existing;
    }
    if (existing && existing.pending) {
      return existing.pending;
    }

    // Enforce concurrency limit
    if (this._active.size >= this._maxConcurrent) {
      this._evictOldest();
    }

    const uri = magnetOrHash.startsWith('magnet:') ? magnetOrHash : hash;

    console.log(`[TorrentEngine] Starting torrent: ${hash}`);

    // Create placeholder entry before the promise so duplicate requests can find it
    const placeholder = { pending: null, engine: null, lastAccess: Date.now(), timer: null };
    this._active.set(hash, placeholder);

    const pending = new Promise((resolve, reject) => {
      // connections: torrent-stream's default (100). Higher values (e.g. 500)
      // don't gain real peers on swarms with ~20 seeders and instead cause
      // file-descriptor pressure and TCP retry storms on low-power hardware,
      // especially when multiple torrents are active at once.
      //
      // uploads: 4 enables BitTorrent tit-for-tat reciprocity. With uploads:0
      // peers choke us because we never reciprocate, so we only receive via
      // their optimistic-unchoke slots and download speeds collapse to
      // ~10-20% of what the swarm can actually give us.
      const engine = torrentStream(uri, {
        connections: 100,
        uploads: 4,
        dht: true,
        path: this._downloadPath,
        trackers: TRACKERS,
      });

      placeholder.engine = engine;

      // Log peer count when it changes, not every 10 seconds. The old
      // behavior spammed `peers: 0, queued: 0` for the full 90s metadata
      // window on dead torrents, which made logs noisy and was the only
      // signal coming from a torrent that was going nowhere.
      let lastPeers = -1;
      let lastQueued = -1;
      const peerLog = setInterval(() => {
        if (!engine.swarm) return;
        const peers = engine.swarm.wires.length;
        const queued = engine.swarm.queued;
        if (peers !== lastPeers || queued !== lastQueued) {
          console.log(`[TorrentEngine] ${hash.slice(0,8)}... peers: ${peers}, queued: ${queued}`);
          lastPeers = peers;
          lastQueued = queued;
        }
      }, 10000);

      const timeout = setTimeout(() => {
        clearInterval(peerLog);
        if (!this._active.has(hash) || !this._active.get(hash).files) {
          engine.destroy();
          this._active.delete(hash);
          reject(new Error('Torrent metadata timeout (90s) — try a torrent with more seeds'));
        }
      }, 90000);

      engine.on('ready', () => {
        clearTimeout(timeout);
        clearInterval(peerLog);
        const peerCount = engine.swarm ? engine.swarm.wires.length : 0;
        console.log(`[TorrentEngine] Torrent ready: "${engine.torrent.name}", ${engine.files.length} files, ${peerCount} peers`);

        // Deselect non-video files and find the largest video file to pre-select
        let largestVideo = null;
        for (const file of engine.files) {
          if (!isFileNameSafe(file.name)) {
            file.deselect();
            console.log(`[Security] Deselected: "${file.name}"`);
          } else if (!largestVideo || file.length > largestVideo.length) {
            largestVideo = file;
          }
        }

        // Pre-select the largest video file so piece downloading starts immediately
        // rather than waiting for the first HTTP request
        if (largestVideo) {
          largestVideo.select();
          console.log(`[TorrentEngine] Pre-selected: "${largestVideo.name}" (${(largestVideo.length / 1e6).toFixed(0)}MB)`);
        }

        const entry = {
          engine,
          files: engine.files,
          name: engine.torrent.name,
          infoHash: hash,
          lastAccess: Date.now(),
          timer: null,
          pending: null,
        };
        this._active.set(hash, entry);
        this._scheduleCleanup(hash);
        resolve(entry);
      });

      engine.on('error', (err) => {
        clearTimeout(timeout);
        clearInterval(peerLog);
        console.error(`[TorrentEngine] Engine error for ${hash}: ${err.message}`);
        this._active.delete(hash);
        reject(err);
      });
    });

    // Store the promise so duplicate requests wait for it
    placeholder.pending = pending;

    return pending;
  }

  /**
   * Get a safe video file from the torrent.
   */
  getVideoFile(entry, fileIdx) {
    const files = entry.files;
    let file = null;

    if (fileIdx !== undefined && fileIdx >= 0 && fileIdx < files.length) {
      file = files[fileIdx];
      if (!isFileNameSafe(file.name)) {
        console.warn(`[Security] Rejected fileIdx ${fileIdx}: unsafe "${file.name}"`);
        return null;
      }
    } else {
      const videoFiles = files.filter(f => isFileNameSafe(f.name));
      if (videoFiles.length === 0) return null;
      if (videoFiles.length === 1) { file = videoFiles[0]; }
      else {
        const dominated = /\b(sample|trailer|extra|bonus|featurette|interview)\b/i;
        const mainFiles = videoFiles.filter(f => !dominated.test(f.name));
        file = (mainFiles.length > 0 ? mainFiles : videoFiles)[0];
      }
    }

    if (!file) return null;

    if (file.length > this._maxFileSize) {
      console.warn(`[Security] Rejected "${file.name}": ${(file.length / 1e9).toFixed(1)}GB exceeds limit`);
      return null;
    }

    return file;
  }

  /**
   * Serve a torrent's video file over HTTP with range support.
   */
  async serveStream(req, res, magnetOrHash, fileIdx) {
    const hash = this._extractHash(magnetOrHash);
    console.log(`[TorrentEngine] serveStream: hash=${hash}, fileIdx=${fileIdx}`);

    let entry;
    try {
      entry = await this.getTorrent(magnetOrHash);
    } catch (err) {
      console.error(`[TorrentEngine] Failed to load torrent ${hash}: ${err.message}`);
      res.status(503).json({ error: 'Failed to load torrent: ' + err.message });
      return;
    }

    const file = this.getVideoFile(entry, fileIdx);
    if (!file) {
      console.warn(`[TorrentEngine] No safe video file in "${entry.name}"`);
      entry.files.forEach(f => console.log(`  - ${f.name} (${(f.length / 1e6).toFixed(1)}MB)`));
      res.status(404).json({ error: 'No safe video file found in torrent' });
      return;
    }

    console.log(`[TorrentEngine] Serving: "${file.name}" (${(file.length / 1e6).toFixed(0)}MB)`);

    // Select the file for download (torrent-stream won't download until selected)
    file.select();

    // Validate magic bytes with timeout fallback. We treat 'incomplete' (data
    // not arrived in time) as a soft pass — the extension was already
    // validated by isFileNameSafe, so we don't fail-closed on slow torrents.
    try {
      const result = await Promise.race([
        this._validateMagicBytes(file),
        new Promise(resolve => setTimeout(() => resolve('incomplete'), 15000)),
      ]);
      if (result === 'mismatch') {
        console.warn(`[Security] Magic byte mismatch for "${file.name}" — rejecting`);
        res.status(403).json({ error: 'File failed video format validation' });
        return;
      }
      if (result === 'incomplete') {
        console.warn(`[Security] Magic bytes not yet available for "${file.name}" — extension-only validation`);
      }
    } catch (err) {
      console.warn(`[Security] Magic byte read error for "${file.name}": ${err.message} — extension-only validation`);
    }

    this._touchTorrent(hash);

    const fileSize = file.length;
    const mimeType = getMimeType(file.name);
    const safeFilename = sanitizeFilename(file.name);

    const securityHeaders = {
      'Content-Type': mimeType,
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename="${safeFilename}"`,
      'Cache-Control': 'no-store',
    };

    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (start >= fileSize || end >= fileSize || start > end) {
        res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
        return;
      }

      res.status(206);
      res.set({
        ...securityHeaders,
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });

      const stream = file.createReadStream({ start, end });
      const meter = this._createMeter(hash, 'direct');
      stream.pipe(meter).pipe(res);
      stream.on('error', (err) => { console.error(`[TorrentEngine] Stream error: ${err.message}`); meter.destroy(); if (!res.destroyed) res.end(); });
      res.on('close', () => { stream.destroy(); meter.destroy(); });
    } else {
      res.status(200);
      res.set({
        ...securityHeaders,
        'Accept-Ranges': 'bytes',
        'Content-Length': fileSize,
      });

      const stream = file.createReadStream();
      const meter = this._createMeter(hash, 'direct');
      stream.pipe(meter).pipe(res);
      stream.on('error', (err) => { console.error(`[TorrentEngine] Stream error: ${err.message}`); meter.destroy(); if (!res.destroyed) res.end(); });
      res.on('close', () => { stream.destroy(); meter.destroy(); });
    }
  }

  /**
   * Serve a torrent's video file remuxed from MKV to fragmented MP4.
   * Uses FFmpeg to copy video and transcode audio to AAC for browser compat.
   * No range-request support (output size is unknown); browser buffers progressively.
   */
  async serveRemuxedStream(req, res, magnetOrHash, fileIdx) {
    const hash = this._extractHash(magnetOrHash);
    console.log(`[TorrentEngine] serveRemuxedStream: hash=${hash}, fileIdx=${fileIdx}`);

    // Reject duplicate concurrent remuxes for the same hash+fileIdx. Browser
    // video players typically probe the URL and then issue a real GET; without
    // this guard both requests spawn ffmpeg, doubling CPU and torrent reads.
    const remuxKey = `${hash}:${fileIdx ?? '*'}`;
    const inFlight = this._remuxInFlight.get(remuxKey);
    if (inFlight && Date.now() - inFlight.startedAt < 30000) {
      console.warn(`[TorrentEngine] Duplicate remux request for ${remuxKey} — already in flight, rejecting`);
      res.set('Retry-After', '5');
      res.status(503).json({ error: 'Already remuxing this file — retry in a moment' });
      return;
    }

    let entry;
    try {
      entry = await this.getTorrent(magnetOrHash);
    } catch (err) {
      console.error(`[TorrentEngine] Failed to load torrent ${hash}: ${err.message}`);
      res.status(503).json({ error: 'Failed to load torrent: ' + err.message });
      return;
    }

    const file = this.getVideoFile(entry, fileIdx);
    if (!file) {
      console.warn(`[TorrentEngine] No safe video file in "${entry.name}"`);
      res.status(404).json({ error: 'No safe video file found in torrent' });
      return;
    }

    // Re-check the in-flight map now that we know the actual file (the
    // initial check happened before getTorrent resolved, so a race could
    // have let two requests through).
    if (this._remuxInFlight.has(remuxKey)) {
      console.warn(`[TorrentEngine] Duplicate remux race for ${remuxKey} — second arrival, rejecting`);
      res.set('Retry-After', '5');
      res.status(503).json({ error: 'Already remuxing this file — retry in a moment' });
      return;
    }
    this._remuxInFlight.set(remuxKey, { startedAt: Date.now() });

    console.log(`[TorrentEngine] Remuxing: "${file.name}" (${(file.length / 1e6).toFixed(0)}MB)`);
    file.select();

    const releaseInFlight = () => this._remuxInFlight.delete(remuxKey);

    // Validate magic bytes (see serveStream for the soft-pass rationale).
    try {
      const result = await Promise.race([
        this._validateMagicBytes(file),
        new Promise(resolve => setTimeout(() => resolve('incomplete'), 15000)),
      ]);
      if (result === 'mismatch') {
        console.warn(`[Security] Magic byte mismatch for "${file.name}" — rejecting`);
        releaseInFlight();
        res.status(403).json({ error: 'File failed video format validation' });
        return;
      }
      if (result === 'incomplete') {
        console.warn(`[Security] Magic bytes not yet available for "${file.name}" — extension-only validation`);
      }
    } catch (err) {
      console.warn(`[Security] Magic byte read error for "${file.name}": ${err.message} — extension-only validation`);
    }

    this._touchTorrent(hash);

    const safeFilename = sanitizeFilename(file.name).replace(/\.mkv$/i, '.mp4');

    res.status(200);
    res.set({
      'Content-Type': 'video/mp4',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename="${safeFilename}"`,
      'Cache-Control': 'no-store',
      'Transfer-Encoding': 'chunked',
    });

    // Pipe torrent file through FFmpeg: copy video, transcode audio to AAC,
    // output fragmented MP4 that can stream progressively.
    // -map 0:v:0 -map 0:a:0? ensures we explicitly select the first video and
    // first audio track (the '?' makes audio optional so files without audio
    // don't cause FFmpeg to error out).
    const ffmpeg = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', 'frag_keyframe+empty_moov',
      '-f', 'mp4',
      '-loglevel', 'warning',
      'pipe:1',
    ]);

    const source = file.createReadStream();
    source.pipe(ffmpeg.stdin);

    const meter = this._createMeter(hash, 'remux');
    ffmpeg.stdout.pipe(meter).pipe(res);

    source.on('error', (err) => {
      console.error(`[TorrentEngine] Source stream error during remux: ${err.message}`);
      ffmpeg.kill('SIGTERM');
    });

    ffmpeg.stdin.on('error', () => {
      // FFmpeg closed stdin early (e.g., client disconnected) — not a real error
    });

    ffmpeg.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.log(`[FFmpeg] ${msg}`);
    });

    ffmpeg.on('error', (err) => {
      console.error(`[TorrentEngine] FFmpeg spawn error: ${err.message}`);
      releaseInFlight();
      if (!res.headersSent) {
        res.status(500).json({ error: 'Remux failed — FFmpeg not available' });
      } else if (!res.destroyed) {
        res.destroy();
      }
    });

    ffmpeg.on('close', (code) => {
      if (code && code !== 0 && code !== 255) {
        console.warn(`[TorrentEngine] FFmpeg exited with code ${code}`);
      }
      releaseInFlight();
      if (!res.destroyed) res.end();
    });

    res.on('close', () => {
      releaseInFlight();
      source.destroy();
      meter.destroy();
      ffmpeg.kill('SIGTERM');
    });
  }

  /**
   * Get status info for a torrent.
   */
  getStatus(infoHash) {
    const entry = this._active.get(infoHash.toLowerCase());
    if (!entry || !entry.files) return null;
    const sw = entry.engine.swarm;
    return {
      infoHash: entry.infoHash,
      name: entry.name,
      downloadSpeed: sw ? sw.downloadSpeed() : 0,
      uploadSpeed: sw ? sw.uploadSpeed() : 0,
      numPeers: sw ? sw.wires.length : 0,
      files: entry.files
        .filter(f => isFileNameSafe(f.name))
        .map(f => ({ name: f.name, length: f.length })),
    };
  }

  /**
   * Get status info for all active torrents.
   */
  getAllStatus() {
    const results = [];
    for (const [hash, entry] of this._active) {
      if (!entry.files) continue;
      const sw = entry.engine.swarm;
      results.push({
        infoHash: hash,
        name: entry.name,
        downloadSpeed: sw ? sw.downloadSpeed() : 0,
        uploadSpeed: sw ? sw.uploadSpeed() : 0,
        numPeers: sw ? sw.wires.length : 0,
        files: entry.files
          .filter(f => isFileNameSafe(f.name))
          .map(f => ({ name: f.name, length: f.length })),
      });
    }
    return results;
  }

  destroy() {
    for (const [hash, entry] of this._active) {
      clearTimeout(entry.timer);
      if (entry.engine) entry.engine.destroy();
    }
    this._active.clear();
  }

  // ─── Throughput Metering ───────────────────────────

  /**
   * Create a pass-through transform that meters bytes flowing to the client.
   * Returns the transform stream (pipe source → meter → res).
   */
  _createMeter(hash, mode) {
    const now = Date.now();
    const streamKey = `${hash}-${++this._streamIdCounter}`;
    const stat = { bytesSent: 0, startTime: now, lastBytes: 0, lastTime: now, egressRate: 0, mode, hash };
    this._streamStats.set(streamKey, stat);

    const meter = new Transform({
      transform(chunk, _enc, cb) {
        stat.bytesSent += chunk.length;
        // Update rolling egress rate every second
        const elapsed = Date.now() - stat.lastTime;
        if (elapsed >= 1000) {
          stat.egressRate = ((stat.bytesSent - stat.lastBytes) / elapsed) * 1000;
          stat.lastBytes = stat.bytesSent;
          stat.lastTime = Date.now();
        }
        cb(null, chunk);
      },
    });

    meter.on('close', () => this._streamStats.delete(streamKey));
    meter.on('error', () => this._streamStats.delete(streamKey));
    return meter;
  }

  /**
   * Diagnose whether the torrent or the server/network is the bottleneck.
   */
  getBottleneckDiag(infoHash) {
    const hash = infoHash.toLowerCase();
    const entry = this._active.get(hash);
    if (!entry || !entry.files) return null;

    const sw = entry.engine.swarm;
    const torrentSpeed = sw ? sw.downloadSpeed() : 0; // bytes/sec from peers
    const numPeers = sw ? sw.wires.length : 0;
    // Find the most recent active stream stat for this hash
    let stat = null;
    for (const s of this._streamStats.values()) {
      if (s.hash === hash && (!stat || s.startTime > stat.startTime)) stat = s;
    }

    // Check if any file is still incomplete
    let progress = null;
    const videoFile = entry.files.find(f => isFileNameSafe(f.name));
    if (videoFile) {
      try {
        const fullPath = path.join(this._downloadPath, videoFile.path);
        const diskSize = fs.existsSync(fullPath) ? fs.statSync(fullPath).size : 0;
        progress = { downloaded: diskSize, total: videoFile.length, pct: +(diskSize / videoFile.length * 100).toFixed(1) };
      } catch {}
    }

    // Decay egress rate to 0 if no data has flowed for >5 seconds
    const STALE_THRESHOLD = 5000;
    let clientEgress = stat ? stat.egressRate : 0;
    if (stat && Date.now() - stat.lastTime > STALE_THRESHOLD) clientEgress = 0;
    const clientMode = stat ? stat.mode : null;
    const clientBytesSent = stat ? stat.bytesSent : 0;
    const clientUptime = stat ? Date.now() - stat.startTime : 0;

    // Determine bottleneck
    let bottleneck = 'unknown';
    let explanation = '';

    if (!stat) {
      bottleneck = 'no_active_stream';
      explanation = 'No client is currently streaming this torrent. Cannot compare throughput.';
    } else if (progress && progress.pct >= 100) {
      bottleneck = 'none';
      explanation = 'File is fully downloaded. Serving from disk — torrent speed is irrelevant.';
    } else if (torrentSpeed < 50 * 1024 && numPeers < 3) {
      bottleneck = 'torrent';
      explanation = `Torrent is slow: ${(torrentSpeed / 1024).toFixed(0)} KB/s from ${numPeers} peers. Few seeders or bad connectivity.`;
    } else if (clientEgress > 0 && torrentSpeed > clientEgress * 1.5) {
      bottleneck = 'server_or_network';
      explanation = `Torrent pulls ${(torrentSpeed / 1024).toFixed(0)} KB/s but client only receives ${(clientEgress / 1024).toFixed(0)} KB/s. Server processing or network to client is the bottleneck.`;
    } else if (clientEgress > 0 && clientEgress >= torrentSpeed * 0.8) {
      bottleneck = 'torrent';
      explanation = `Client egress (${(clientEgress / 1024).toFixed(0)} KB/s) keeps up with torrent (${(torrentSpeed / 1024).toFixed(0)} KB/s). Torrent download speed is the limiting factor.`;
    } else if (torrentSpeed > 0 && clientEgress === 0) {
      bottleneck = 'server_or_network';
      explanation = `Torrent is downloading at ${(torrentSpeed / 1024).toFixed(0)} KB/s but no bytes are reaching the client. Possible backpressure or FFmpeg stall.`;
    } else {
      explanation = 'Not enough data to determine bottleneck yet. Try again in a few seconds.';
    }

    return {
      bottleneck,
      explanation,
      torrent: {
        downloadSpeed: torrentSpeed,
        downloadSpeedKBs: +(torrentSpeed / 1024).toFixed(1),
        numPeers,
        progress,
      },
      client: {
        egressRate: clientEgress,
        egressRateKBs: +(clientEgress / 1024).toFixed(1),
        mode: clientMode,
        bytesSent: clientBytesSent,
        streamingFor: clientUptime ? `${(clientUptime / 1000).toFixed(0)}s` : null,
      },
    };
  }

  // ─── Security ─────────────────────────────────────

  /**
   * Read the first MAGIC_READ_SIZE bytes of a torrent file and check
   * the video container signature.
   *
   * Returns:
   *   'match'      — signature matches a known video container
   *   'mismatch'   — we got enough bytes and they didn't match (hard reject)
   *   'incomplete' — stream closed/timed out before delivering enough bytes
   *                  (torrent piece not downloaded yet — DO NOT hard-reject,
   *                  the caller should fall back to extension validation
   *                  which has already passed at this point)
   */
  _validateMagicBytes(file) {
    return new Promise((resolve, reject) => {
      if (file.length < MAGIC_READ_SIZE) { resolve('incomplete'); return; }
      const stream = file.createReadStream({ start: 0, end: MAGIC_READ_SIZE - 1 });
      const chunks = [];
      let bytesRead = 0;
      let settled = false;

      const settle = (result) => {
        if (settled) return;
        settled = true;
        try { stream.destroy(); } catch {}
        resolve(result);
      };

      stream.on('data', (chunk) => {
        chunks.push(chunk);
        bytesRead += chunk.length;
        if (bytesRead >= MAGIC_READ_SIZE) {
          const header = Buffer.concat(chunks).subarray(0, MAGIC_READ_SIZE);
          settle(matchesVideoSignature(header) ? 'match' : 'mismatch');
        }
      });
      stream.on('end', () => {
        // Stream ended naturally — either we got enough bytes (handled in
        // 'data' above) or it closed early with a partial read.
        if (!settled) settle('incomplete');
      });
      stream.on('close', () => {
        if (!settled) settle('incomplete');
      });
      stream.on('error', (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
    });
  }

  // ─── Private ──────────────────────────────────────

  _extractHash(input) {
    if (/^[0-9a-f]{40}$/i.test(input)) return input.toLowerCase();
    const hexMatch = input.match(/btih:([a-fA-F0-9]{40})/);
    if (hexMatch) return hexMatch[1].toLowerCase();
    // Support Base32-encoded info hashes (32 chars)
    const b32Match = input.match(/btih:([A-Za-z2-7]{32})/);
    if (b32Match) {
      try {
        const hex = Buffer.from(b32Match[1], 'base32').toString('hex').toLowerCase();
        if (hex.length === 40) return hex;
      } catch {}
    }
    return null;
  }

  _touchTorrent(hash) {
    const entry = this._active.get(hash);
    if (entry) { entry.lastAccess = Date.now(); this._scheduleCleanup(hash); }
  }

  _scheduleCleanup(hash) {
    const entry = this._active.get(hash);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this._removeTorrent(hash), IDLE_TIMEOUT);
  }

  _removeTorrent(hash) {
    const entry = this._active.get(hash);
    if (!entry) return;

    // Don't remove if the torrent is still actively downloading
    if (entry.engine && entry.engine.swarm) {
      const sw = entry.engine.swarm;
      const speed = sw.downloadSpeed();
      const peers = sw.wires.length;

      // Check if any selected file is still incomplete
      const hasIncomplete = entry.files && entry.files.some(f => {
        // torrent-stream file objects don't expose a simple "complete" flag,
        // but we can check via the on-disk file size vs declared length
        try {
          const fullPath = path.join(this._downloadPath, f.path);
          if (!fs.existsSync(fullPath)) return true; // not even started
          const stat = fs.statSync(fullPath);
          return stat.size < f.length;
        } catch {
          return true;
        }
      });

      if (hasIncomplete && (speed > 0 || peers > 0)) {
        console.log(`[TorrentEngine] Torrent ${hash.slice(0,8)}... still downloading (${(speed / 1024).toFixed(0)} KB/s, ${peers} peers) — extending lifetime`);
        entry.timer = setTimeout(() => this._removeTorrent(hash), ACTIVE_DL_RECHECK);
        return;
      }
    }

    clearTimeout(entry.timer);
    if (entry.engine) entry.engine.destroy();
    this._active.delete(hash);
    console.log(`[TorrentEngine] Removed idle torrent: ${hash}`);
  }

  _evictOldest() {
    // Prefer evicting torrents with no active client streams
    const activeStreamHashes = new Set();
    for (const s of this._streamStats.values()) activeStreamHashes.add(s.hash);

    let oldest = null, oldestHash = null;
    // First pass: try to find a non-streaming torrent to evict
    for (const [hash, entry] of this._active) {
      if (activeStreamHashes.has(hash)) continue;
      if (!oldest || entry.lastAccess < oldest.lastAccess) { oldest = entry; oldestHash = hash; }
    }
    // Fallback: evict the oldest regardless
    if (!oldestHash) {
      for (const [hash, entry] of this._active) {
        if (!oldest || entry.lastAccess < oldest.lastAccess) { oldest = entry; oldestHash = hash; }
      }
    }
    if (oldestHash) this._removeTorrent(oldestHash);
  }

}

function matchesVideoSignature(header) {
  for (const sig of VIDEO_SIGNATURES) {
    if (header.length < sig.offset + sig.bytes.length) continue;
    if (header.subarray(sig.offset, sig.offset + sig.bytes.length).equals(sig.bytes)) return true;
  }
  return false;
}

module.exports = TorrentEngine;
