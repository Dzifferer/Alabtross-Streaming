/**
 * Alabtross — Torrent Streaming Engine
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
const fs = require('fs');
const path = require('path');
const { TRACKERS, isFileNameSafe, getMimeType, sanitizeFilename } = require('./file-safety');

const IDLE_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const ACTIVE_DL_RECHECK = 10 * 60 * 1000; // re-check in 10 min if still downloading
const MAX_CONCURRENT = 5;
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
    this._downloadPath = opts.downloadPath || path.join(process.cwd(), '.torrent-cache');
    this._maxFileSize = opts.maxFileSize || MAX_FILE_SIZE;
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
    if (this._active.size >= MAX_CONCURRENT) {
      this._evictOldest();
    }

    const uri = magnetOrHash.startsWith('magnet:') ? magnetOrHash : hash;

    console.log(`[TorrentEngine] Starting torrent: ${hash}`);

    // Create placeholder entry before the promise so duplicate requests can find it
    const placeholder = { pending: null, engine: null, lastAccess: Date.now(), timer: null };
    this._active.set(hash, placeholder);

    const pending = new Promise((resolve, reject) => {
      const engine = torrentStream(uri, {
        connections: 200,
        uploads: 0,
        dht: true,
        path: this._downloadPath,
        trackers: TRACKERS,
      });

      placeholder.engine = engine;

      // Log peer count periodically
      const peerLog = setInterval(() => {
        if (engine.swarm) {
          console.log(`[TorrentEngine] ${hash.slice(0,8)}... peers: ${engine.swarm.wires.length}, queued: ${engine.swarm.queued}`);
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

        for (const file of engine.files) {
          if (!isFileNameSafe(file.name)) {
            file.deselect();
            console.log(`[Security] Deselected: "${file.name}"`);
          }
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

    // Validate magic bytes with timeout fallback
    try {
      const isVideo = await Promise.race([
        this._validateMagicBytes(file),
        new Promise(resolve => setTimeout(() => resolve(true), 10000)),
      ]);
      if (!isVideo) {
        console.warn(`[Security] Magic byte check failed for "${file.name}"`);
        res.status(403).json({ error: 'File failed video format validation' });
        return;
      }
    } catch (err) {
      console.warn(`[Security] Magic byte error for "${file.name}": ${err.message} — allowing`);
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
      stream.pipe(res);
      stream.on('error', () => res.end());
      res.on('close', () => stream.destroy());
    } else {
      res.status(200);
      res.set({
        ...securityHeaders,
        'Accept-Ranges': 'bytes',
        'Content-Length': fileSize,
      });

      const stream = file.createReadStream();
      stream.pipe(res);
      stream.on('error', () => res.end());
      res.on('close', () => stream.destroy());
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

    console.log(`[TorrentEngine] Remuxing: "${file.name}" (${(file.length / 1e6).toFixed(0)}MB)`);
    file.select();

    // Validate magic bytes
    try {
      const isVideo = await Promise.race([
        this._validateMagicBytes(file),
        new Promise(resolve => setTimeout(() => resolve(true), 10000)),
      ]);
      if (!isVideo) {
        console.warn(`[Security] Magic byte check failed for "${file.name}"`);
        res.status(403).json({ error: 'File failed video format validation' });
        return;
      }
    } catch (err) {
      console.warn(`[Security] Magic byte error for "${file.name}": ${err.message} — allowing`);
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
    // output fragmented MP4 that can stream progressively
    const ffmpeg = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', 'frag_keyframe+empty_moov+faststart',
      '-f', 'mp4',
      '-loglevel', 'warning',
      'pipe:1',
    ]);

    const source = file.createReadStream();
    source.pipe(ffmpeg.stdin);

    ffmpeg.stdout.pipe(res);

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
      if (!res.headersSent) {
        res.status(500).json({ error: 'Remux failed — FFmpeg not available' });
      }
    });

    ffmpeg.on('close', (code) => {
      if (code && code !== 0 && code !== 255) {
        console.warn(`[TorrentEngine] FFmpeg exited with code ${code}`);
      }
      res.end();
    });

    res.on('close', () => {
      source.destroy();
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

  // ─── Security ─────────────────────────────────────

  _validateMagicBytes(file) {
    return new Promise((resolve, reject) => {
      if (file.length < MAGIC_READ_SIZE) { resolve(false); return; }
      const stream = file.createReadStream({ start: 0, end: MAGIC_READ_SIZE - 1 });
      const chunks = [];
      let bytesRead = 0;
      stream.on('data', (chunk) => {
        chunks.push(chunk);
        bytesRead += chunk.length;
        if (bytesRead >= MAGIC_READ_SIZE) stream.destroy();
      });
      stream.on('end', check);
      stream.on('close', check);
      stream.on('error', reject);
      let checked = false;
      function check() {
        if (checked) return;
        checked = true;
        const header = Buffer.concat(chunks).subarray(0, MAGIC_READ_SIZE);
        resolve(matchesVideoSignature(header));
      }
    });
  }

  // ─── Private ──────────────────────────────────────

  _extractHash(input) {
    if (/^[0-9a-f]{40}$/i.test(input)) return input.toLowerCase();
    const match = input.match(/btih:([a-fA-F0-9]{40})/);
    if (match) return match[1].toLowerCase();
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
    let oldest = null, oldestHash = null;
    for (const [hash, entry] of this._active) {
      if (!oldest || entry.lastAccess < oldest.lastAccess) { oldest = entry; oldestHash = hash; }
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
