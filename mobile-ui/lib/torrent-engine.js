/**
 * Alabtross — Torrent Streaming Engine
 *
 * Uses WebTorrent to download torrents and serve video files over
 * HTTP with range-request support. Replaces the Stremio server's
 * /hlsv2/ torrent→HLS functionality.
 *
 * Active torrents are cached in memory and cleaned up after a
 * configurable idle timeout (default 30 min).
 */

const WebTorrent = require('webtorrent');
const path = require('path');

const IDLE_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const MAX_CONCURRENT = 5;

// Video file extensions we'll serve
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg',
]);

class TorrentEngine {
  constructor(opts = {}) {
    this.client = new WebTorrent({
      maxConns: opts.maxConns || 55,
    });
    this._active = new Map(); // infoHash -> { torrent, lastAccess, timer }
    this._downloadPath = opts.downloadPath || path.join(process.cwd(), '.torrent-cache');
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

    return new Promise((resolve, reject) => {
      const magnetOrHash = infoHashOrMagnet.startsWith('magnet:')
        ? infoHashOrMagnet
        : hash;

      this.client.add(magnetOrHash, { path: this._downloadPath }, (torrent) => {
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
   * Get the largest video file from a torrent, or a specific file by index.
   */
  getVideoFile(torrent, fileIdx) {
    if (fileIdx !== undefined && fileIdx >= 0 && fileIdx < torrent.files.length) {
      return torrent.files[fileIdx];
    }

    // Find largest video file
    let best = null;
    for (const file of torrent.files) {
      const ext = path.extname(file.name).toLowerCase();
      if (!VIDEO_EXTENSIONS.has(ext)) continue;
      if (!best || file.length > best.length) best = file;
    }
    return best;
  }

  /**
   * Serve a torrent's video file as an HTTP response with range support.
   */
  async serveStream(req, res, infoHashOrMagnet, fileIdx) {
    let torrent;
    try {
      torrent = await this.getTorrent(infoHashOrMagnet);
    } catch (err) {
      res.status(503).json({ error: 'Failed to load torrent: ' + err.message });
      return;
    }

    const file = this.getVideoFile(torrent, fileIdx);
    if (!file) {
      res.status(404).json({ error: 'No video file found in torrent' });
      return;
    }

    const hash = this._extractHash(infoHashOrMagnet);
    this._touchTorrent(hash);

    const fileSize = file.length;
    const mimeType = this._getMimeType(file.name);

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
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': mimeType,
      });

      const stream = file.createReadStream({ start, end });
      stream.pipe(res);
      stream.on('error', () => res.end());
      res.on('close', () => stream.destroy());
    } else {
      res.status(200);
      res.set({
        'Accept-Ranges': 'bytes',
        'Content-Length': fileSize,
        'Content-Type': mimeType,
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
      files: t.files.map(f => ({ name: f.name, length: f.length })),
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
    this.client.destroy();
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
    return types[ext] || 'application/octet-stream';
  }
}

module.exports = TorrentEngine;
