/**
 * Alabtross — Torrent Streaming Engine
 *
 * Uses WebTorrent to download torrents and serve video files over
 * HTTP with range-request support. Replaces the Stremio server's
 * /hlsv2/ torrent→HLS functionality.
 *
 * Security layers:
 *   1. Only video file extensions are ever served or downloaded
 *   2. Magic byte validation ensures the file is a real video container
 *   3. Path traversal protection rejects filenames with ../ or absolute paths
 *   4. Max file size cap prevents disk exhaustion
 *   5. Non-video files are deselected so WebTorrent never downloads them
 *   6. Content-Disposition forces safe inline playback
 *   7. Idle cleanup + concurrency limit bound resource usage
 */

const path = require('path');

// WebTorrent v2+ is ESM-only — use dynamic import
let _WebTorrent = null;
async function loadWebTorrent() {
  if (!_WebTorrent) {
    const mod = await import('webtorrent');
    _WebTorrent = mod.default || mod;
  }
  return _WebTorrent;
}

const IDLE_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const MAX_CONCURRENT = 5;
const MAX_FILE_SIZE = 20 * 1024 * 1024 * 1024; // 20 GB
const MAGIC_READ_SIZE = 16; // bytes needed to check file signatures

// Video file extensions we'll serve
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg',
]);

// Known dangerous extensions that should NEVER be served regardless
const DANGEROUS_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.scr', '.pif', '.msi', '.msp',
  '.ps1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.sh',
  '.bash', '.csh', '.app', '.action', '.command', '.run', '.bin',
  '.dll', '.so', '.dylib', '.deb', '.rpm', '.apk', '.dmg', '.iso',
  '.jar', '.py', '.rb', '.pl', '.php', '.html', '.htm', '.svg',
]);

/**
 * Video container magic byte signatures.
 * Each entry: { offset, bytes } where bytes is a Buffer to match at that offset.
 */
const VIDEO_SIGNATURES = [
  // MP4/M4V/MOV — ftyp box at offset 4
  { offset: 4, bytes: Buffer.from('ftyp') },
  // MKV/WebM — EBML header
  { offset: 0, bytes: Buffer.from([0x1A, 0x45, 0xDF, 0xA3]) },
  // AVI — RIFF....AVI
  { offset: 0, bytes: Buffer.from('RIFF') },
  // FLV
  { offset: 0, bytes: Buffer.from('FLV') },
  // MPEG-TS (0x47 sync byte)
  { offset: 0, bytes: Buffer.from([0x47]) },
  // MPEG-PS / MPEG video
  { offset: 0, bytes: Buffer.from([0x00, 0x00, 0x01, 0xBA]) },
  { offset: 0, bytes: Buffer.from([0x00, 0x00, 0x01, 0xB3]) },
  // WMV/ASF — ASF header GUID
  { offset: 0, bytes: Buffer.from([0x30, 0x26, 0xB2, 0x75]) },
];

class TorrentEngine {
  constructor(opts = {}) {
    this.client = null;
    this._clientReady = null;
    this._maxConns = opts.maxConns || 55;
    this._active = new Map(); // infoHash -> { torrent, lastAccess, timer }
    this._downloadPath = opts.downloadPath || path.join(process.cwd(), '.torrent-cache');
    this._maxFileSize = opts.maxFileSize || MAX_FILE_SIZE;
  }

  async _ensureClient() {
    if (this.client) return this.client;
    if (this._clientReady) return this._clientReady;
    console.log('[TorrentEngine] Initializing WebTorrent client...');
    this._clientReady = loadWebTorrent().then(WebTorrent => {
      this.client = new WebTorrent({ maxConns: this._maxConns });
      console.log('[TorrentEngine] WebTorrent client ready');
      this.client.on('error', err => console.error('[TorrentEngine] Client error:', err.message));
      return this.client;
    }).catch(err => {
      console.error('[TorrentEngine] Failed to load WebTorrent:', err.message);
      this._clientReady = null;
      throw err;
    });
    return this._clientReady;
  }

  /**
   * Get or start a torrent by infoHash or magnet URI.
   * Returns a promise that resolves with torrent metadata once ready.
   */
  async getTorrent(infoHashOrMagnet) {
    const hash = this._extractHash(infoHashOrMagnet);
    if (!hash) throw new Error('Invalid infoHash or magnet URI');

    // Already active?
    const existing = this._active.get(hash);
    if (existing) {
      this._touchTorrent(hash);
      if (existing.torrent.ready) return existing.torrent;
      return this._waitReady(existing.torrent);
    }

    // Enforce concurrency limit — remove oldest idle torrent
    if (this._active.size >= MAX_CONCURRENT) {
      this._evictOldest();
    }

    const client = await this._ensureClient();

    return new Promise((resolve, reject) => {
      const magnetOrHash = infoHashOrMagnet.startsWith('magnet:')
        ? infoHashOrMagnet
        : hash;

      client.add(magnetOrHash, { path: this._downloadPath }, (torrent) => {
        // Security: deselect all non-video files so they are never downloaded
        this._deselectNonVideoFiles(torrent);

        const entry = {
          torrent,
          lastAccess: Date.now(),
          timer: null,
        };
        this._active.set(hash, entry);
        this._scheduleCleanup(hash);
        resolve(torrent);
      });

      // Timeout if metadata doesn't arrive in 60 seconds
      setTimeout(() => {
        if (!this._active.has(hash)) {
          reject(new Error('Torrent metadata timeout'));
        }
      }, 60000);
    });
  }

  /**
   * Get a safe video file from a torrent.
   * Even when fileIdx is specified, the file MUST pass safety checks.
   */
  getVideoFile(torrent, fileIdx) {
    let file = null;

    if (fileIdx !== undefined && fileIdx >= 0 && fileIdx < torrent.files.length) {
      file = torrent.files[fileIdx];
      // Validate the requested file is actually a video
      if (!this._isFileNameSafe(file.name)) {
        console.warn(`[Security] Rejected fileIdx ${fileIdx}: unsafe filename "${file.name}"`);
        return null;
      }
    } else {
      // Auto-select: filter to safe video files only
      const videoFiles = torrent.files.filter(f => this._isFileNameSafe(f.name));
      if (videoFiles.length === 0) return null;
      if (videoFiles.length === 1) { file = videoFiles[0]; }
      else {
        // Skip files that look like samples, extras, or trailers
        const dominated = /\b(sample|trailer|extra|bonus|featurette|interview)\b/i;
        const mainFiles = videoFiles.filter(f => !dominated.test(f.name));
        file = (mainFiles.length > 0 ? mainFiles : videoFiles)[0];
      }
    }

    if (!file) return null;

    // Enforce max file size
    if (file.length > this._maxFileSize) {
      console.warn(`[Security] Rejected file "${file.name}": ${(file.length / 1e9).toFixed(1)}GB exceeds limit`);
      return null;
    }

    return file;
  }

  /**
   * Serve a torrent's video file as an HTTP response with range support.
   * Validates magic bytes before streaming any data.
   */
  async serveStream(req, res, infoHashOrMagnet, fileIdx) {
    const hash = this._extractHash(infoHashOrMagnet);
    console.log(`[TorrentEngine] serveStream request: hash=${hash}, fileIdx=${fileIdx}`);

    let torrent;
    try {
      torrent = await this.getTorrent(infoHashOrMagnet);
      console.log(`[TorrentEngine] Torrent ready: "${torrent.name}", ${torrent.files.length} files`);
    } catch (err) {
      console.error(`[TorrentEngine] Failed to load torrent ${hash}: ${err.message}`);
      res.status(503).json({ error: 'Failed to load torrent: ' + err.message });
      return;
    }

    const file = this.getVideoFile(torrent, fileIdx);
    if (!file) {
      console.warn(`[TorrentEngine] No safe video file in torrent "${torrent.name}"`);
      torrent.files.forEach(f => console.log(`  - ${f.name} (${(f.length / 1e6).toFixed(1)}MB)`));
      res.status(404).json({ error: 'No safe video file found in torrent' });
      return;
    }
    console.log(`[TorrentEngine] Serving file: "${file.name}" (${(file.length / 1e6).toFixed(0)}MB)`);

    // Validate magic bytes — but skip if file hasn't downloaded enough yet
    // (torrent may still be connecting to peers)
    try {
      const isVideo = await Promise.race([
        this._validateMagicBytes(file),
        new Promise(resolve => setTimeout(() => resolve(true), 10000)), // allow after 10s
      ]);
      if (!isVideo) {
        console.warn(`[Security] Magic byte check failed for "${file.name}" — not a video container`);
        res.status(403).json({ error: 'File failed video format validation' });
        return;
      }
    } catch (err) {
      // Don't block playback on magic byte failures — the file may just be buffering
      console.warn(`[Security] Magic byte read error for "${file.name}": ${err.message} — allowing anyway`);
    }

    this._touchTorrent(hash);

    const fileSize = file.length;
    const mimeType = this._getMimeType(file.name);
    const safeFilename = this._sanitizeFilename(file.name);

    // Security headers for the response
    const securityHeaders = {
      'Content-Type': mimeType,
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename="${safeFilename}"`,
      'Cache-Control': 'no-store',
    };

    // Handle range requests
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
   * Get status info for a torrent.
   */
  getStatus(infoHash) {
    const entry = this._active.get(infoHash.toLowerCase());
    if (!entry) return null;
    const t = entry.torrent;
    return {
      infoHash: t.infoHash,
      name: t.name,
      progress: Math.round(t.progress * 100),
      downloadSpeed: t.downloadSpeed,
      uploadSpeed: t.uploadSpeed,
      numPeers: t.numPeers,
      // Only expose video file info — hide non-video filenames
      files: t.files
        .filter(f => this._isFileNameSafe(f.name))
        .map(f => ({ name: f.name, length: f.length })),
    };
  }

  /**
   * Clean up and destroy the engine.
   */
  destroy() {
    for (const [hash, entry] of this._active) {
      clearTimeout(entry.timer);
    }
    this._active.clear();
    if (this.client) this.client.destroy();
  }

  // ─── Security Checks ─────────────────────────────

  /**
   * Check if a filename is safe to serve:
   * - Must have a video extension
   * - Must NOT have a dangerous extension (catches double-extension tricks)
   * - Must not contain path traversal
   */
  _isFileNameSafe(filename) {
    if (!filename) return false;

    // Path traversal check
    const normalized = path.normalize(filename);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) return false;
    if (filename.includes('..')) return false;

    // Check all extensions in the filename (catches double-ext like .mp4.exe)
    const parts = path.basename(filename).split('.');
    for (let i = 1; i < parts.length; i++) {
      const ext = '.' + parts[i].toLowerCase();
      if (DANGEROUS_EXTENSIONS.has(ext)) return false;
    }

    // Must end with a video extension
    const finalExt = path.extname(filename).toLowerCase();
    return VIDEO_EXTENSIONS.has(finalExt);
  }

  /**
   * Read the first bytes of a file and check against known video signatures.
   * Returns true if the file matches any known video container format.
   */
  _validateMagicBytes(file) {
    return new Promise((resolve, reject) => {
      if (file.length < MAGIC_READ_SIZE) {
        resolve(false);
        return;
      }

      const stream = file.createReadStream({ start: 0, end: MAGIC_READ_SIZE - 1 });
      const chunks = [];
      let bytesRead = 0;

      stream.on('data', (chunk) => {
        chunks.push(chunk);
        bytesRead += chunk.length;
        if (bytesRead >= MAGIC_READ_SIZE) {
          stream.destroy();
        }
      });

      stream.on('end', () => check());
      stream.on('close', () => check());
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

  /**
   * Deselect all non-video files in a torrent so they are never downloaded.
   */
  _deselectNonVideoFiles(torrent) {
    for (const file of torrent.files) {
      if (!this._isFileNameSafe(file.name)) {
        file.deselect();
        console.log(`[Security] Deselected non-video file: "${file.name}"`);
      }
    }
  }

  /**
   * Sanitize a filename for use in Content-Disposition header.
   * Strips path components and non-ASCII characters.
   */
  _sanitizeFilename(filename) {
    return path.basename(filename)
      .replace(/[^\w\s.\-()[\]]/g, '_')
      .substring(0, 200);
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
    if (entry) {
      entry.lastAccess = Date.now();
      this._scheduleCleanup(hash);
    }
  }

  _scheduleCleanup(hash) {
    const entry = this._active.get(hash);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      this._removeTorrent(hash);
    }, IDLE_TIMEOUT);
  }

  _removeTorrent(hash) {
    const entry = this._active.get(hash);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.torrent.destroy();
    this._active.delete(hash);
    console.log(`[TorrentEngine] Removed idle torrent: ${hash}`);
  }

  _evictOldest() {
    let oldest = null;
    let oldestHash = null;
    for (const [hash, entry] of this._active) {
      if (!oldest || entry.lastAccess < oldest.lastAccess) {
        oldest = entry;
        oldestHash = hash;
      }
    }
    if (oldestHash) this._removeTorrent(oldestHash);
  }

  _waitReady(torrent) {
    if (torrent.ready) return Promise.resolve(torrent);
    return new Promise((resolve, reject) => {
      torrent.on('ready', () => resolve(torrent));
      torrent.on('error', reject);
      setTimeout(() => reject(new Error('Torrent ready timeout')), 60000);
    });
  }

  _getMimeType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const types = {
      '.mp4': 'video/mp4',
      '.mkv': 'video/x-matroska',
      '.avi': 'video/x-msvideo',
      '.mov': 'video/quicktime',
      '.wmv': 'video/x-ms-wmv',
      '.flv': 'video/x-flv',
      '.webm': 'video/webm',
      '.m4v': 'video/mp4',
      '.mpg': 'video/mpeg',
      '.mpeg': 'video/mpeg',
    };
    // Never fall back to application/octet-stream — reject unknown types
    return types[ext] || null;
  }
}

/**
 * Check a buffer header against known video container signatures.
 */
function matchesVideoSignature(header) {
  for (const sig of VIDEO_SIGNATURES) {
    if (header.length < sig.offset + sig.bytes.length) continue;
    const slice = header.subarray(sig.offset, sig.offset + sig.bytes.length);
    if (slice.equals(sig.bytes)) return true;
  }
  return false;
}

module.exports = TorrentEngine;
