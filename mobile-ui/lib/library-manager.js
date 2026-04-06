/**
 * Alabtross — Library Manager
 *
 * Manages downloading movies/episodes to permanent server storage.
 * Metadata is persisted as a JSON file alongside the video files.
 *
 * Features:
 *   - Download torrents to a dedicated library directory
 *   - Track download progress per item
 *   - Serve completed downloads directly (no re-seeding needed)
 *   - Persistent metadata across server restarts
 */

const torrentStream = require('torrent-stream');
const path = require('path');
const fs = require('fs');
const { TRACKERS, isFileNameSafe, getMimeType } = require('./file-safety');

const MAX_CONCURRENT_DOWNLOADS = 5;
const MAX_FILE_SIZE = 20 * 1024 * 1024 * 1024; // 20 GB
const METADATA_SAVE_INTERVAL = 30 * 1000; // Save metadata every 30s during active downloads

class LibraryManager {
  constructor(opts = {}) {
    this._libraryPath = opts.libraryPath || path.join(process.cwd(), 'library');
    this._metadataFile = path.join(this._libraryPath, '_metadata.json');
    this._items = new Map();       // id -> library item
    this._engines = new Map();     // id -> torrent engine (active downloads only)
    this._progressTimers = new Map(); // id -> interval timer
    this._metadataSaveTimer = null;

    // Ensure library directory exists
    if (!fs.existsSync(this._libraryPath)) {
      fs.mkdirSync(this._libraryPath, { recursive: true });
    }

    this._cleanupStaleTmpFiles();
    this._loadMetadata();
    console.log(`[Library] Initialized at ${this._libraryPath}, ${this._items.size} items loaded`);

    // Auto-resume any downloads that were interrupted (power loss, crash, restart)
    this._resumeInterruptedDownloads();
  }

  // ─── Public API ──────────────────────────────────

  /**
   * Add a movie/episode to the library and start downloading.
   */
  addItem(opts) {
    const { imdbId, type, name, poster, year, magnetUri, infoHash, quality, size, season, episode } = opts;

    if (!infoHash || !magnetUri) {
      throw new Error('infoHash and magnetUri are required');
    }

    // Generate a unique ID
    const id = season != null && episode != null
      ? `${imdbId}_s${season}e${episode}_${infoHash.slice(0, 8)}`
      : `${imdbId}_${infoHash.slice(0, 8)}`;

    // Check if already in library
    if (this._items.has(id)) {
      const existing = this._items.get(id);
      if (existing.status === 'complete') {
        return { id, status: 'already_exists' };
      }
      // If failed or cancelled, allow re-download
      if (existing.status !== 'downloading') {
        this._items.delete(id);
      } else {
        return { id, status: 'already_downloading' };
      }
    }

    // Check concurrent download limit
    const activeDownloads = [...this._items.values()].filter(i => i.status === 'downloading').length;
    if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
      throw new Error(`Max ${MAX_CONCURRENT_DOWNLOADS} concurrent downloads allowed`);
    }

    const item = {
      id,
      imdbId,
      type: type || 'movie',
      name: name || 'Unknown',
      poster: poster || '',
      year: year || '',
      quality: quality || '',
      size: size || '',
      season: season != null ? season : null,
      episode: episode != null ? episode : null,
      infoHash,
      magnetUri,
      status: 'downloading',   // downloading | complete | failed
      progress: 0,
      downloadSpeed: 0,
      numPeers: 0,
      filePath: null,
      fileName: null,
      fileSize: 0,
      addedAt: Date.now(),
      completedAt: null,
      error: null,
    };

    this._items.set(id, item);
    this._saveMetadata();
    this._startDownload(id);

    return { id, status: 'started' };
  }

  /**
   * Get all library items.
   */
  getAll() {
    const items = [...this._items.values()].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    return items.map(i => this._sanitizeItem(i));
  }

  /**
   * Get a single library item by ID.
   */
  getItem(id) {
    const item = this._items.get(id);
    if (!item) return null;
    return this._sanitizeItem(item);
  }

  /**
   * Remove a library item and its file.
   */
  removeItem(id) {
    const item = this._items.get(id);
    if (!item) return false;

    // Stop download if active
    this._stopDownload(id);

    // Delete file
    if (item.filePath) {
      const fullPath = path.join(this._libraryPath, item.filePath);
      try {
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        // Try to remove parent directory if empty
        const dir = path.dirname(fullPath);
        if (dir !== this._libraryPath) {
          try { fs.rmdirSync(dir); } catch { /* not empty, fine */ }
        }
      } catch (err) {
        console.error(`[Library] Failed to delete file: ${err.message}`);
      }
    }

    this._items.delete(id);
    this._saveMetadata();
    return true;
  }

  /**
   * Get the full file path for streaming a completed item.
   */
  getFilePath(id) {
    const item = this._items.get(id);
    if (!item || item.status !== 'complete' || !item.filePath) return null;

    const fullPath = path.join(this._libraryPath, item.filePath);
    if (!fs.existsSync(fullPath)) {
      // File was deleted externally
      item.status = 'failed';
      item.error = 'File not found on disk';
      this._saveMetadata();
      return null;
    }

    return fullPath;
  }

  /**
   * Get MIME type for a video file.
   */
  getMimeType(filename) {
    return getMimeType(filename);
  }

  destroy() {
    console.log('[Library] Shutting down — saving download state for resumption...');
    if (this._metadataSaveTimer) {
      clearInterval(this._metadataSaveTimer);
      this._metadataSaveTimer = null;
    }
    for (const [id] of this._engines) {
      this._stopDownload(id);
    }
    // Downloads keep status='downloading' so they auto-resume on next startup
    this._saveMetadata();
    console.log('[Library] State saved — downloads will resume on next start');
  }

  // ─── Download Management ────────────────────────

  _startDownload(id) {
    const item = this._items.get(id);
    if (!item) return;

    console.log(`[Library] Starting download: "${item.name}" (${item.infoHash.slice(0, 8)}...)`);

    const itemDir = path.join(this._libraryPath, this._safeDirectoryName(item));

    const engine = torrentStream(item.magnetUri, {
      connections: 500,
      uploads: 0,
      dht: true,
      verify: true,
      path: itemDir,
      trackers: TRACKERS,
    });

    this._engines.set(id, engine);
    this._startPeriodicSave();

    const timeout = setTimeout(() => {
      if (item.status === 'downloading' && !item.filePath) {
        console.error(`[Library] Metadata timeout for "${item.name}"`);
        item.status = 'failed';
        item.error = 'Torrent metadata timeout (90s) — try a torrent with more seeds';
        this._stopDownload(id);
        this._saveMetadata();
      }
    }, 90000);

    engine.on('ready', () => {
      clearTimeout(timeout);

      // Find the best video file
      const file = this._selectVideoFile(engine.files);
      if (!file) {
        item.status = 'failed';
        item.error = 'No valid video file found in torrent';
        this._stopDownload(id);
        this._saveMetadata();
        return;
      }

      // Deselect all non-target files
      for (const f of engine.files) {
        if (f !== file) f.deselect();
      }

      // Select and start downloading the video file
      file.select();

      const relativePath = path.relative(this._libraryPath, path.join(itemDir, file.path));
      item.filePath = relativePath;
      item.fileName = path.basename(file.name);
      item.fileSize = file.length;

      console.log(`[Library] Downloading: "${file.name}" (${(file.length / 1e9).toFixed(2)} GB)`);

      // Track progress
      const expectedSize = file.length;
      console.log(`[Library] Expected file size: ${expectedSize} bytes (${(expectedSize / 1e9).toFixed(2)} GB)`);

      // Guard against nonsensical file sizes (< 50MB for a movie is almost certainly wrong)
      if (expectedSize < 50 * 1024 * 1024) {
        console.warn(`[Library] Suspiciously small file size (${(expectedSize / 1e6).toFixed(1)} MB) — may be corrupt torrent metadata`);
      }

      const progressTimer = setInterval(() => {
        if (!this._engines.has(id)) {
          clearInterval(progressTimer);
          return;
        }
        const sw = engine.swarm;
        item.downloadSpeed = sw ? sw.downloadSpeed() : 0;
        item.numPeers = sw ? sw.wires.length : 0;

        // Calculate progress from on-disk file size vs expected torrent file size
        const fullPath = path.join(this._libraryPath, item.filePath);
        try {
          if (fs.existsSync(fullPath)) {
            const stat = fs.statSync(fullPath);
            item.progress = Math.min(100, Math.round((stat.size / expectedSize) * 100));
          }
        } catch {
          // File might not exist yet
        }

        // Check if download is complete — require file size to match expected size
        // (not just progress >= 100) to guard against sparse files or rounding
        if (item.progress >= 100) {
          const fullPath2 = path.join(this._libraryPath, item.filePath);
          try {
            const finalSize = fs.statSync(fullPath2).size;
            if (finalSize < expectedSize * 0.99) {
              // File is not actually complete despite rounding to 100%
              console.warn(`[Library] Progress shows 100% but file size ${finalSize} < expected ${expectedSize} — continuing download`);
              item.progress = Math.round((finalSize / expectedSize) * 100);
              return;
            }
          } catch { /* ignore */ }

          item.status = 'complete';
          item.completedAt = Date.now();
          item.downloadSpeed = 0;
          console.log(`[Library] Download complete: "${item.name}" (${(expectedSize / 1e9).toFixed(2)} GB)`);
          this._stopDownload(id);
          this._saveMetadata();
        }
      }, 2000);

      this._progressTimers.set(id, progressTimer);
      this._saveMetadata();
    });

    engine.on('error', (err) => {
      clearTimeout(timeout);
      console.error(`[Library] Download error for "${item.name}": ${err.message}`);
      item.status = 'failed';
      item.error = err.message;
      this._stopDownload(id);
      this._saveMetadata();
    });
  }

  _stopDownload(id) {
    const timer = this._progressTimers.get(id);
    if (timer) {
      clearInterval(timer);
      this._progressTimers.delete(id);
    }

    const engine = this._engines.get(id);
    if (engine) {
      try { engine.destroy(); } catch { /* ignore */ }
      this._engines.delete(id);
    }

    // Stop periodic save when no downloads are active
    if (this._engines.size === 0) {
      this._stopPeriodicSave();
    }
  }

  _selectVideoFile(files) {
    const videoFiles = files.filter(f => isFileNameSafe(f.name));
    if (videoFiles.length === 0) return null;
    if (videoFiles.length === 1) return videoFiles[0];

    // Filter out samples/trailers, pick largest remaining
    const dominated = /\b(sample|trailer|extra|bonus|featurette|interview)\b/i;
    const mainFiles = videoFiles.filter(f => !dominated.test(f.name));
    const candidates = mainFiles.length > 0 ? mainFiles : videoFiles;

    // Pick the largest file (likely the main video)
    return candidates.reduce((a, b) => (a.length > b.length ? a : b));
  }

  _startPeriodicSave() {
    if (this._metadataSaveTimer) return;
    this._metadataSaveTimer = setInterval(() => {
      this._saveMetadata();
    }, METADATA_SAVE_INTERVAL);
  }

  _stopPeriodicSave() {
    if (this._metadataSaveTimer) {
      clearInterval(this._metadataSaveTimer);
      this._metadataSaveTimer = null;
    }
  }

  // ─── Metadata Persistence ──────────────────────

  _cleanupStaleTmpFiles() {
    try {
      const files = fs.readdirSync(this._libraryPath);
      for (const f of files) {
        if (f.startsWith('_metadata.json.tmp.')) {
          const tmpPath = path.join(this._libraryPath, f);
          fs.unlinkSync(tmpPath);
          console.log(`[Library] Cleaned up stale temp file: ${f}`);
        }
      }
    } catch {
      // Non-critical — ignore
    }
  }

  _loadMetadata() {
    const backupFile = this._metadataFile + '.bak';
    const filesToTry = [this._metadataFile, backupFile];

    for (const file of filesToTry) {
      try {
        if (!fs.existsSync(file)) continue;
        const raw = fs.readFileSync(file, 'utf8');
        if (!raw.trim()) continue;
        const data = JSON.parse(raw);
        if (!Array.isArray(data)) continue;

        for (const item of data) {
          // Mark interrupted downloads for auto-resume instead of failing them
          if (item.status === 'downloading') {
            item._needsResume = true;
            item.downloadSpeed = 0;
            item.numPeers = 0;
          }
          this._items.set(item.id, item);
        }

        if (file === backupFile) {
          console.warn(`[Library] Primary metadata was corrupted — recovered from backup (${data.length} items)`);
        }
        return;
      } catch (err) {
        if (file === this._metadataFile) {
          console.error(`[Library] Primary metadata corrupted: ${err.message} — trying backup...`);
        } else {
          console.error(`[Library] Backup metadata also failed: ${err.message}`);
        }
      }
    }
  }

  _resumeInterruptedDownloads() {
    const toResume = [...this._items.values()].filter(i => i._needsResume);
    if (toResume.length === 0) return;

    console.log(`[Library] Found ${toResume.length} interrupted download(s) — resuming...`);

    let started = 0;
    for (const item of toResume) {
      delete item._needsResume;

      // Respect concurrent download limit
      if (started >= MAX_CONCURRENT_DOWNLOADS) {
        console.log(`[Library] Queued "${item.name}" — concurrent limit reached, marked for retry`);
        item.status = 'failed';
        item.error = 'Queued — re-add to resume (concurrent limit reached during restart)';
        continue;
      }

      // Check if partial file exists on disk to log resume progress
      if (item.filePath) {
        const fullPath = path.join(this._libraryPath, item.filePath);
        try {
          if (fs.existsSync(fullPath) && item.fileSize > 0) {
            const stat = fs.statSync(fullPath);
            const resumeProgress = Math.round((stat.size / item.fileSize) * 100);
            console.log(`[Library] Resuming "${item.name}" from ${resumeProgress}% (${(stat.size / 1e6).toFixed(1)} / ${(item.fileSize / 1e6).toFixed(1)} MB)`);
          } else {
            console.log(`[Library] Resuming "${item.name}" from 0% (no partial file found)`);
            item.progress = 0;
          }
        } catch {
          console.log(`[Library] Resuming "${item.name}" from 0%`);
          item.progress = 0;
        }
      } else {
        console.log(`[Library] Resuming "${item.name}" (metadata not yet resolved)`);
        item.progress = 0;
      }

      this._startDownload(item.id);
      started++;
    }

    this._saveMetadata();
  }

  _saveMetadata() {
    try {
      const data = [...this._items.values()].map(item => {
        const { _needsResume, ...clean } = item;
        return clean;
      });
      const json = JSON.stringify(data, null, 2);
      const tmpFile = this._metadataFile + '.tmp.' + process.pid;
      const backupFile = this._metadataFile + '.bak';

      // Rotate current -> backup before writing new version
      try {
        if (fs.existsSync(this._metadataFile)) {
          fs.copyFileSync(this._metadataFile, backupFile);
        }
      } catch {
        // Non-critical — proceed without backup
      }

      // Atomic write: write to temp file then rename to prevent corruption
      fs.writeFileSync(tmpFile, json, 'utf8');
      fs.renameSync(tmpFile, this._metadataFile);
    } catch (err) {
      console.error(`[Library] Failed to save metadata: ${err.message}`);
    }
  }

  _sanitizeItem(item) {
    return {
      id: item.id,
      imdbId: item.imdbId,
      type: item.type,
      name: item.name,
      poster: item.poster,
      year: item.year,
      quality: item.quality,
      size: item.size,
      season: item.season,
      episode: item.episode,
      status: item.status,
      progress: item.progress,
      downloadSpeed: item.downloadSpeed,
      numPeers: item.numPeers,
      fileName: item.fileName,
      fileSize: item.fileSize,
      addedAt: item.addedAt,
      completedAt: item.completedAt,
      error: item.error,
    };
  }

  _safeDirectoryName(item) {
    const base = (item.name || 'unknown').replace(/[^\w\s.\-()[\]]/g, '_').substring(0, 100);
    return `${base}_${item.infoHash.slice(0, 8)}`;
  }
}

module.exports = LibraryManager;
