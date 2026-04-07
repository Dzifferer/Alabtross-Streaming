/**
 * Albatross — Library Manager
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
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { VIDEO_EXTENSIONS, TRACKERS, isFileNameSafe, getMimeType } = require('./file-safety');

const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 5;
const MAX_FILE_SIZE = 20 * 1024 * 1024 * 1024; // 20 GB
const METADATA_SAVE_INTERVAL = 30 * 1000; // Save metadata every 30s during active downloads

class LibraryManager {
  constructor(opts = {}) {
    this._libraryPath = opts.libraryPath || path.join(process.cwd(), 'library');
    this._metadataFile = path.join(this._libraryPath, '_metadata.json');
    this._maxConcurrentDownloads = opts.maxConcurrentDownloads || DEFAULT_MAX_CONCURRENT_DOWNLOADS;
    this._items = new Map();       // id -> library item
    this._engines = new Map();     // id -> torrent engine (active downloads only)
    this._progressTimers = new Map(); // id -> interval timer
    this._convertProcesses = new Map(); // id -> FFmpeg child process (active conversions)
    this._maxConcurrentConversions = 1;
    this._metadataSaveTimer = null;

    // Ensure library directory exists
    if (!fs.existsSync(this._libraryPath)) {
      fs.mkdirSync(this._libraryPath, { recursive: true });
    }

    this._cleanupStaleTmpFiles();
    this._loadMetadata();
    console.log(`[Library] Initialized at ${this._libraryPath}, ${this._items.size} items loaded`);

    // Auto-resume any downloads/conversions that were interrupted (power loss, crash, restart)
    this._resumeInterruptedDownloads();
    this._resumeInterruptedConversions();
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
      if (existing.status === 'complete' || existing.status === 'converting') {
        return { id, status: 'already_exists' };
      }
      if (existing.status === 'queued') {
        return { id, status: 'already_queued' };
      }
      // If failed or cancelled, allow re-download
      if (existing.status !== 'downloading') {
        this._items.delete(id);
      } else {
        return { id, status: 'already_downloading' };
      }
    }

    // Check concurrent download limit — queue if at capacity
    const activeDownloads = [...this._items.values()].filter(i => i.status === 'downloading').length;
    const shouldQueue = activeDownloads >= this._maxConcurrentDownloads;

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
      status: shouldQueue ? 'queued' : 'downloading',   // downloading | complete | failed | queued | paused
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

    if (shouldQueue) {
      console.log(`[Library] Queued: "${item.name}" — ${activeDownloads}/${this._maxConcurrentDownloads} slots in use`);
      return { id, status: 'queued' };
    }

    this._startDownload(id);
    return { id, status: 'started' };
  }

  /**
   * Add an entire season pack to the library. Downloads ALL video files
   * from the torrent, creating a separate library item for each episode.
   * Returns a promise that resolves once the torrent metadata is loaded
   * and all items are created.
   */
  addSeasonPack(opts) {
    const { imdbId, name, poster, year, magnetUri, infoHash, quality, size, season } = opts;

    if (!infoHash || !magnetUri) {
      throw new Error('infoHash and magnetUri are required');
    }

    const packId = `pack_${infoHash}`;

    // Check if this pack is already being downloaded
    if (this._engines.has(packId)) {
      return Promise.resolve({ status: 'already_downloading', items: [] });
    }

    const packDir = path.join(this._libraryPath, this._safeDirectoryName({ name: `${name} S${String(season).padStart(2, '0')}`, infoHash }));

    return new Promise((resolve, reject) => {
      const engine = torrentStream(magnetUri, {
        connections: 500,
        uploads: 0,
        dht: true,
        verify: true,
        path: packDir,
        trackers: TRACKERS,
      });

      const timeout = setTimeout(() => {
        engine.destroy();
        reject(new Error('Torrent metadata timeout (90s) — try a torrent with more seeds'));
      }, 90000);

      engine.on('error', (err) => {
        clearTimeout(timeout);
        try { engine.destroy(); } catch { /* ignore */ }
        reject(err);
      });

      engine.on('ready', () => {
        clearTimeout(timeout);

        // Find all video files, excluding samples/trailers/promos and tiny junk files
        const PACK_MIN_FILE_SIZE = 10 * 1024 * 1024; // 10 MB — skip promo/ad files
        const dominated = /\b(sample|trailer|extra|bonus|featurette|interview)\b/i;
        const videoFiles = engine.files.filter(f =>
          isFileNameSafe(f.name) && !dominated.test(f.name) && f.length >= PACK_MIN_FILE_SIZE
        );

        if (videoFiles.length === 0) {
          engine.destroy();
          return resolve({ status: 'no_video_files', items: [] });
        }

        // Deselect all files first
        for (const f of engine.files) f.deselect();

        // Select and create items for each video file
        const createdItems = [];
        const seasonNum = parseInt(season, 10) || 1;

        for (const file of videoFiles) {
          file.select();

          // Try to parse episode number from filename
          const episodeNum = this._parseEpisodeNumber(file.name, seasonNum);

          const itemId = episodeNum
            ? `${imdbId}_s${seasonNum}e${episodeNum}_${infoHash.slice(0, 8)}`
            : `${imdbId}_pack_${infoHash.slice(0, 8)}_${path.basename(file.name, path.extname(file.name)).replace(/[^\w]/g, '_').slice(0, 30)}`;

          // Skip if already in library
          if (this._items.has(itemId)) {
            const existing = this._items.get(itemId);
            if (existing.status === 'complete' || existing.status === 'downloading') {
              createdItems.push({ id: itemId, status: 'already_exists', episode: episodeNum });
              continue;
            }
            this._items.delete(itemId);
          }

          const relativePath = path.relative(this._libraryPath, path.join(packDir, file.path));

          // Use filename-derived name for individual episodes (e.g., "Naruto Shippuden - 010 - Sealing Jutsu")
          const episodeName = this._deriveEpisodeName(file.name);

          const item = {
            id: itemId,
            imdbId,
            type: 'series',
            name: episodeName,
            showName: name || 'Unknown',
            poster: poster || '',
            year: year || '',
            quality: quality || '',
            size: (file.length / (1024 * 1024 * 1024)).toFixed(1) + ' GB',
            season: seasonNum,
            episode: episodeNum,
            infoHash,
            magnetUri,
            packId,
            status: 'downloading',
            progress: 0,
            downloadSpeed: 0,
            numPeers: 0,
            filePath: relativePath,
            fileName: path.basename(file.name),
            fileSize: file.length,
            addedAt: Date.now(),
            completedAt: null,
            error: null,
          };

          this._items.set(itemId, item);
          createdItems.push({ id: itemId, status: 'started', episode: episodeNum });
        }

        if (createdItems.filter(i => i.status === 'started').length === 0) {
          engine.destroy();
          this._saveMetadata();
          return resolve({ status: 'all_exist', items: createdItems });
        }

        // Store the shared engine
        this._engines.set(packId, engine);
        this._startPeriodicSave();

        // Track progress for each file individually
        const progressTimer = setInterval(() => {
          if (!this._engines.has(packId)) {
            clearInterval(progressTimer);
            return;
          }

          const sw = engine.swarm;
          const speed = sw ? sw.downloadSpeed() : 0;
          const peers = sw ? sw.wires.length : 0;
          let allComplete = true;

          for (const [itemId, item] of this._items) {
            if (item.packId !== packId || item.status !== 'downloading') continue;

            item.downloadSpeed = speed;
            item.numPeers = peers;

            // Calculate progress from file size on disk
            const fullPath = path.join(this._libraryPath, item.filePath);
            try {
              if (fs.existsSync(fullPath)) {
                const stat = fs.statSync(fullPath);
                item.progress = Math.min(100, Math.round((stat.size / item.fileSize) * 100));
              }
            } catch { /* file might not exist yet */ }

            if (item.progress >= 100) {
              // Verify file is actually complete
              const fullPath2 = path.join(this._libraryPath, item.filePath);
              try {
                const finalSize = fs.statSync(fullPath2).size;
                if (finalSize < item.fileSize * 0.99) {
                  item.progress = Math.round((finalSize / item.fileSize) * 100);
                  allComplete = false;
                  continue;
                }
              } catch {
                allComplete = false;
                continue;
              }

              item.status = 'complete';
              item.completedAt = Date.now();
              item.downloadSpeed = 0;
              console.log(`[Library] Pack episode complete: "${item.fileName}"`);
              this._checkAndConvert(itemId);
            } else {
              allComplete = false;
            }
          }

          // If all pack items are complete, destroy the shared engine
          if (allComplete) {
            clearInterval(progressTimer);
            this._stopPackEngine(packId);
            this._saveMetadata();
          }
        }, 2000);

        this._progressTimers.set(packId, progressTimer);
        this._saveMetadata();

        console.log(`[Library] Season pack started: "${name}" S${String(seasonNum).padStart(2, '0')} — ${videoFiles.length} episodes`);
        resolve({ status: 'started', items: createdItems });
      });
    });
  }

  _parseEpisodeNumber(fileName, seasonNum) {
    const base = path.basename(fileName);
    // Try S01E05 pattern
    const seMatch = base.match(/S(\d+)E(\d+)/i);
    if (seMatch) return parseInt(seMatch[2], 10);
    // Try E05 pattern (without season)
    const eMatch = base.match(/\bE(\d+)\b/i);
    if (eMatch) return parseInt(eMatch[1], 10);
    // Try "- 05 -" or "- 05." or "- 05 " at end before extension (anime fansub convention)
    const dashMatch = base.match(/[-–]\s*(\d{1,4})\s*(?:[-–.\s]|$)/);
    if (dashMatch) return parseInt(dashMatch[1], 10);
    // Try "Episode 5" pattern
    const epMatch = base.match(/Episode\s*(\d+)/i);
    if (epMatch) return parseInt(epMatch[1], 10);
    // Try "x05" pattern (1x05)
    const xMatch = base.match(/\d+x(\d+)/i);
    if (xMatch) return parseInt(xMatch[1], 10);
    return null;
  }

  /**
   * Derive a display name for a pack episode from its filename.
   * Strips group tags, file extension, and cleans up separators.
   * e.g. "[animeawake] Naruto Shippuden - 010 - Sealing Jutsu.mp4"
   *   -> "Naruto Shippuden - 010 - Sealing Jutsu"
   */
  _deriveEpisodeName(fileName) {
    let name = path.basename(fileName, path.extname(fileName));
    // Strip [group] tags at start
    name = name.replace(/^\[[^\]]*\]\s*/g, '');
    // Strip trailing whitespace/dots
    name = name.replace(/[\s.]+$/, '');
    // Replace underscores/dots with spaces (if used as separators)
    if (!name.includes(' ') && (name.includes('.') || name.includes('_'))) {
      name = name.replace(/[._]/g, ' ');
    }
    return name.trim() || path.basename(fileName);
  }

  _stopPackEngine(packId) {
    const timer = this._progressTimers.get(packId);
    if (timer) {
      clearInterval(timer);
      this._progressTimers.delete(packId);
    }
    const engine = this._engines.get(packId);
    if (engine) {
      try { engine.destroy(); } catch { /* ignore */ }
      this._engines.delete(engine);
    }
    this._engines.delete(packId);

    if (this._engines.size === 0 && this._convertProcesses.size === 0) {
      this._stopPeriodicSave();
    }
  }

  /**
   * Get all library items, including untracked video files found on disk.
   */
  getAll() {
    const tracked = [...this._items.values()];
    const discovered = this._discoverUntrackedFiles();
    const all = [...tracked, ...discovered].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    return all.map(i => this._sanitizeItem(i));
  }

  /**
   * Get a single library item by ID.
   */
  getItem(id) {
    const item = this._items.get(id);
    if (item) return this._sanitizeItem(item);

    // Handle discovered (untracked) files
    if (id.startsWith('disk_')) {
      const relPath = id.slice(5);
      const fullPath = path.join(this._libraryPath, relPath);
      try {
        if (!fs.existsSync(fullPath)) return null;
        const stat = fs.statSync(fullPath);
        const fileName = path.basename(relPath);
        const ext = path.extname(fileName).toLowerCase();
        return {
          id,
          name: path.basename(fileName, ext).replace(/[._]/g, ' ').trim(),
          type: 'movie',
          status: 'complete',
          filePath: relPath,
          fileName,
          fileSize: stat.size,
          addedAt: stat.mtimeMs,
        };
      } catch { return null; }
    }

    return null;
  }

  /**
   * Pause an active download. Stops the torrent engine but keeps the item
   * in 'paused' status so it can be resumed later.
   */
  pauseItem(id) {
    const item = this._items.get(id);
    if (!item) return false;
    if (item.status !== 'downloading') return false;

    this._stopDownload(id);
    item.status = 'paused';
    item.downloadSpeed = 0;
    item.numPeers = 0;
    this._saveMetadata();
    this._processQueue();
    console.log(`[Library] Paused: "${item.name}"`);
    return true;
  }

  /**
   * Resume a paused download. Re-starts the torrent engine.
   */
  resumeItem(id) {
    const item = this._items.get(id);
    if (!item) return false;
    if (item.status !== 'paused') return false;

    const activeDownloads = [...this._items.values()].filter(i => i.status === 'downloading').length;
    if (activeDownloads >= this._maxConcurrentDownloads) {
      item.status = 'queued';
      this._saveMetadata();
      console.log(`[Library] Resume queued (at capacity): "${item.name}"`);
      return true;
    }

    item.status = 'downloading';
    item.error = null;
    this._startDownload(id);
    this._saveMetadata();
    console.log(`[Library] Resumed: "${item.name}"`);
    return true;
  }

  /**
   * Reorder an item in the queue. newPosition is 0-based index within queued items.
   */
  reorderQueue(id, newPosition) {
    const item = this._items.get(id);
    if (!item || item.status !== 'queued') return false;

    // Get all queued items sorted by addedAt
    const queued = [...this._items.values()]
      .filter(i => i.status === 'queued')
      .sort((a, b) => a.addedAt - b.addedAt);

    if (queued.length <= 1) return true;
    newPosition = Math.max(0, Math.min(newPosition, queued.length - 1));

    // Reassign addedAt timestamps to reflect new order
    const currentIdx = queued.findIndex(i => i.id === id);
    if (currentIdx === -1) return false;

    queued.splice(currentIdx, 1);
    queued.splice(newPosition, 0, item);

    // Reassign timestamps to maintain order
    const baseTime = Date.now() - queued.length * 1000;
    for (let i = 0; i < queued.length; i++) {
      queued[i].addedAt = baseTime + i * 1000;
    }

    this._saveMetadata();
    console.log(`[Library] Reordered queue: "${item.name}" to position ${newPosition}`);
    return true;
  }

  /**
   * Remove a library item and its file.
   */
  removeItem(id) {
    // Handle discovered (untracked) files
    if (id.startsWith('disk_') && !this._items.has(id)) {
      const relPath = id.slice(5);
      const fullPath = path.join(this._libraryPath, relPath);
      try {
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        const dir = path.dirname(fullPath);
        if (dir !== this._libraryPath) {
          try { fs.rmdirSync(dir); } catch { /* not empty */ }
        }
      } catch (err) {
        console.error(`[Library] Failed to delete discovered file: ${err.message}`);
      }
      return true;
    }

    const item = this._items.get(id);
    if (!item) return false;

    // Stop download if active
    this._stopDownload(id);

    // If this item belongs to a pack, check if we should stop the shared engine
    if (item.packId) {
      const remainingPackItems = [...this._items.values()].filter(
        i => i.packId === item.packId && i.id !== id && i.status === 'downloading'
      );
      if (remainingPackItems.length === 0) {
        this._stopPackEngine(item.packId);
      }
    }

    // Kill conversion process if active
    this._stopConversion(id);

    // Delete file(s) — current file and any temp conversion file
    if (item.filePath) {
      const fullPath = path.join(this._libraryPath, item.filePath);
      try {
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      } catch (err) {
        console.error(`[Library] Failed to delete file: ${err.message}`);
      }
    }
    if (item.originalFilePath && item.originalFilePath !== item.filePath) {
      const origPath = path.join(this._libraryPath, item.originalFilePath);
      try {
        if (fs.existsSync(origPath)) fs.unlinkSync(origPath);
      } catch { /* ignore */ }
    }
    // Clean up temp .converting.mp4 file
    if (item.filePath) {
      const tempPath = this._getConvertTempPath(path.join(this._libraryPath, item.filePath));
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch { /* ignore */ }
    }
    // Try to remove parent directory if empty
    if (item.filePath) {
      const dir = path.dirname(path.join(this._libraryPath, item.filePath));
      if (dir !== this._libraryPath) {
        try { fs.rmdirSync(dir); } catch { /* not empty, fine */ }
      }
    }

    this._items.delete(id);
    this._saveMetadata();
    this._processQueue();
    return true;
  }

  /**
   * Get the full file path for streaming a completed item.
   */
  getFilePath(id) {
    let item = this._items.get(id);

    // Handle discovered (untracked) files
    if (!item && id.startsWith('disk_')) {
      const relPath = id.slice(5); // strip 'disk_' prefix
      const fullPath = path.join(this._libraryPath, relPath);
      if (fs.existsSync(fullPath)) return fullPath;
      return null;
    }

    if (!item || (item.status !== 'complete' && item.status !== 'converting') || !item.filePath) return null;

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
    // Kill active conversions — they keep status='converting' for auto-resume on restart
    for (const [id, proc] of this._convertProcesses) {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    }
    this._convertProcesses.clear();
    // Downloads keep status='downloading' so they auto-resume on next startup
    this._saveMetadata();
    console.log('[Library] State saved — downloads and conversions will resume on next start');
  }

  // ─── Queue Processing ──────────────────────────

  _processQueue() {
    const activeDownloads = [...this._items.values()].filter(i => i.status === 'downloading').length;
    const available = this._maxConcurrentDownloads - activeDownloads;
    if (available <= 0) return;

    const queued = [...this._items.values()]
      .filter(i => i.status === 'queued')
      .sort((a, b) => a.addedAt - b.addedAt);

    const toStart = queued.slice(0, available);
    for (const item of toStart) {
      item.status = 'downloading';
      item.progress = 0;
      console.log(`[Library] Dequeuing: "${item.name}"`);
      this._startDownload(item.id);
    }

    if (toStart.length > 0) {
      this._saveMetadata();
    }
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
        this._processQueue();
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
        this._processQueue();
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
          this._processQueue();

          // Check if conversion to browser-compatible MP4 is needed
          this._checkAndConvert(id);
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
      this._processQueue();
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

    // Stop periodic save when no downloads or conversions are active
    if (this._engines.size === 0 && this._convertProcesses.size === 0) {
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
      // Clean up orphaned .converting.mp4 files in subdirectories
      // (these are handled per-item in _resumeInterruptedConversions)
    } catch {
      // Non-critical — ignore
    }
  }

  _loadMetadata() {
    const backupFile = this._metadataFile + '.bak';
    const filesToTry = [this._metadataFile, backupFile];

    console.log(`[Debug] _loadMetadata: looking for ${this._metadataFile}`);
    console.log(`[Debug] _loadMetadata: file exists: ${fs.existsSync(this._metadataFile)}, backup exists: ${fs.existsSync(backupFile)}`);

    for (const file of filesToTry) {
      try {
        if (!fs.existsSync(file)) continue;
        const raw = fs.readFileSync(file, 'utf8');
        if (!raw.trim()) {
          console.log(`[Debug] _loadMetadata: ${path.basename(file)} exists but is empty`);
          continue;
        }
        const data = JSON.parse(raw);
        if (!Array.isArray(data)) {
          console.log(`[Debug] _loadMetadata: ${path.basename(file)} parsed but is not an array`);
          continue;
        }

        for (const item of data) {
          // Mark interrupted downloads for auto-resume instead of failing them
          if (item.status === 'downloading') {
            item._needsResume = true;
            item.downloadSpeed = 0;
            item.numPeers = 0;
          }
          // Mark interrupted conversions for auto-resume
          if (item.status === 'converting') {
            item._needsConversion = true;
            item.convertProgress = 0;
          }
          this._items.set(item.id, item);
        }

        console.log(`[Debug] _loadMetadata: loaded ${this._items.size} items from ${path.basename(file)}`);
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

    console.log(`[Debug] _loadMetadata: no metadata loaded — _items.size = ${this._items.size}`);
  }

  _resumeInterruptedDownloads() {
    const toResume = [...this._items.values()].filter(i => i._needsResume);
    if (toResume.length === 0) return;

    console.log(`[Library] Found ${toResume.length} interrupted download(s) — resuming...`);

    let started = 0;
    for (const item of toResume) {
      delete item._needsResume;

      // Respect concurrent download limit — queue excess
      if (started >= this._maxConcurrentDownloads) {
        console.log(`[Library] Queued "${item.name}" — concurrent limit reached during restart`);
        item.status = 'queued';
        item.error = null;
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

    // Process any pre-existing queued items if slots are available
    this._processQueue();
  }

  _resumeInterruptedConversions() {
    const toConvert = [...this._items.values()].filter(i => i._needsConversion);
    if (toConvert.length === 0) return;

    console.log(`[Library] Found ${toConvert.length} interrupted conversion(s) — resuming...`);

    for (const item of toConvert) {
      delete item._needsConversion;

      // Clean up any leftover temp file from interrupted conversion
      if (item.filePath || item.originalFilePath) {
        const sourcePath = item.originalFilePath || item.filePath;
        const tempPath = this._getConvertTempPath(path.join(this._libraryPath, sourcePath));
        try {
          if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
            console.log(`[Library] Cleaned up interrupted conversion temp file for "${item.name}"`);
          }
        } catch { /* ignore */ }
      }

      // Ensure original file still exists
      const sourcePath = item.originalFilePath || item.filePath;
      const fullPath = path.join(this._libraryPath, sourcePath);
      if (!fs.existsSync(fullPath)) {
        console.error(`[Library] Cannot resume conversion for "${item.name}" — source file missing`);
        item.status = 'failed';
        item.error = 'Source file missing after restart';
        continue;
      }

      // Reset filePath to original if it was changed
      if (item.originalFilePath) {
        item.filePath = item.originalFilePath;
      }

      console.log(`[Library] Resuming conversion: "${item.name}"`);
      this._startConversion(item.id);
    }

    this._saveMetadata();
  }

  _saveMetadata() {
    try {
      const data = [...this._items.values()].map(item => {
        const { _needsResume, _needsConversion, ...clean } = item;
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

  /**
   * Scan the library directory for video files not tracked in metadata.
   * Returns them as synthetic library items so they show up in the UI.
   */
  _discoverUntrackedFiles() {
    const discovered = [];
    const trackedPaths = new Set(
      [...this._items.values()]
        .filter(i => i.filePath)
        .map(i => i.filePath)
    );

    console.log(`[Debug] _discoverUntrackedFiles: scanning ${this._libraryPath}`);
    console.log(`[Debug] _discoverUntrackedFiles: ${trackedPaths.size} tracked paths`);

    try {
      const entries = fs.readdirSync(this._libraryPath, { withFileTypes: true });
      console.log(`[Debug] _discoverUntrackedFiles: found ${entries.length} entries: ${entries.map(e => `${e.name} (${e.isFile() ? 'file' : 'dir'})`).join(', ')}`);

      for (const entry of entries) {
        if (entry.name.startsWith('_metadata')) continue;
        if (entry.name.endsWith('.tmp')) continue;

        const entryPath = path.join(this._libraryPath, entry.name);

        if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (!VIDEO_EXTENSIONS.has(ext)) {
            console.log(`[Debug] _discoverUntrackedFiles: skipping "${entry.name}" — ext "${ext}" not in VIDEO_EXTENSIONS`);
            continue;
          }
          if (trackedPaths.has(entry.name)) continue;

          const stat = fs.statSync(entryPath);
          const name = path.basename(entry.name, ext).replace(/[._]/g, ' ').trim();
          discovered.push({
            id: 'disk_' + entry.name,
            name,
            type: 'movie',
            status: 'complete',
            filePath: entry.name,
            fileName: entry.name,
            fileSize: stat.size,
            addedAt: stat.mtimeMs,
          });
        } else if (entry.isDirectory()) {
          // Scan subdirectory for video files
          try {
            const subFiles = fs.readdirSync(entryPath);
            let bestVideo = null;
            let bestSize = 0;
            for (const f of subFiles) {
              const ext = path.extname(f).toLowerCase();
              if (!VIDEO_EXTENSIONS.has(ext)) continue;
              const relPath = path.join(entry.name, f);
              if (trackedPaths.has(relPath)) continue;
              const stat = fs.statSync(path.join(entryPath, f));
              if (stat.size > bestSize) {
                bestVideo = { name: f, relPath, size: stat.size, mtime: stat.mtimeMs };
                bestSize = stat.size;
              }
            }
            if (bestVideo && !trackedPaths.has(bestVideo.relPath)) {
              const name = entry.name.replace(/[._]/g, ' ').trim();
              discovered.push({
                id: 'disk_' + bestVideo.relPath,
                name,
                type: 'movie',
                status: 'complete',
                filePath: bestVideo.relPath,
                fileName: bestVideo.name,
                fileSize: bestVideo.size,
                addedAt: bestVideo.mtime,
              });
            }
          } catch { /* skip unreadable dirs */ }
        }
      }
    } catch (err) {
      console.error(`[Debug] _discoverUntrackedFiles: disk scan error: ${err.message} (code: ${err.code})`);
    }

    if (discovered.length > 0) {
      console.log(`[Library] Discovered ${discovered.length} untracked file(s) on disk`);
    }
    return discovered;
  }

  // ─── Video Conversion ──────────────────────────

  /**
   * Probe a video file with ffprobe to check codec/container compatibility.
   * Returns a Promise resolving to { directPlay, videoCodec, audioCodec, container, duration, ext }.
   */
  _probeFile(filePath) {
    return new Promise((resolve) => {
      const ext = path.extname(filePath).toLowerCase();
      const ffprobe = spawn('ffprobe', [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath,
      ]);

      let output = '';
      ffprobe.stdout.on('data', (d) => { output += d.toString(); });

      ffprobe.on('close', (code) => {
        if (code !== 0) {
          return resolve({ directPlay: false, reason: 'ffprobe failed' });
        }
        try {
          const info = JSON.parse(output);
          const videoStream = (info.streams || []).find(s => s.codec_type === 'video');
          const audioStream = (info.streams || []).find(s => s.codec_type === 'audio');

          const videoCodec = videoStream ? videoStream.codec_name : null;
          const audioCodec = audioStream ? audioStream.codec_name : null;
          const container = info.format ? info.format.format_name : null;
          const duration = info.format ? parseFloat(info.format.duration) : null;

          const compatibleVideo = ['h264', 'hevc'].includes(videoCodec);
          const compatibleAudio = !audioStream || ['aac', 'mp3'].includes(audioCodec);
          const compatibleContainer = ext === '.mp4' || ext === '.m4v';
          const directPlay = compatibleVideo && compatibleAudio && compatibleContainer;

          resolve({ directPlay, videoCodec, audioCodec, container, duration, ext });
        } catch {
          resolve({ directPlay: false, reason: 'probe parse error' });
        }
      });

      ffprobe.on('error', () => {
        resolve({ directPlay: false, reason: 'ffprobe not available' });
      });
    });
  }

  /**
   * Check if a completed library item needs conversion and start it if so.
   */
  async _checkAndConvert(id) {
    const item = this._items.get(id);
    if (!item || item.status !== 'complete' || !item.filePath) return;

    const fullPath = path.join(this._libraryPath, item.filePath);
    if (!fs.existsSync(fullPath)) return;

    const probe = await this._probeFile(fullPath);

    if (probe.directPlay) {
      console.log(`[Library] "${item.name}" is already browser-compatible — no conversion needed`);
      return;
    }

    // Only convert if video codec can be copied (h264/hevc) — otherwise too expensive
    if (!['h264', 'hevc'].includes(probe.videoCodec)) {
      console.log(`[Library] "${item.name}" has unsupported video codec (${probe.videoCodec}) — skipping conversion, on-the-fly remux available`);
      return;
    }

    // Respect concurrent conversion limit
    if (this._convertProcesses.size >= this._maxConcurrentConversions) {
      console.log(`[Library] Conversion queued for "${item.name}" — waiting for active conversion to finish`);
      // Store that this needs conversion and check again when a conversion completes
      item._pendingConversion = true;
      item._probeDuration = probe.duration;
      return;
    }

    item.status = 'converting';
    item.convertProgress = 0;
    item.convertError = null;
    item._probeDuration = probe.duration;
    this._saveMetadata();
    this._startPeriodicSave();

    console.log(`[Library] Starting conversion: "${item.name}" (${probe.ext} → .mp4, video: ${probe.videoCodec}, audio: ${probe.audioCodec || 'none'})`);
    this._startConversion(id);
  }

  /**
   * Get the temp file path used during conversion.
   */
  _getConvertTempPath(inputPath) {
    const dir = path.dirname(inputPath);
    const base = path.basename(inputPath, path.extname(inputPath));
    return path.join(dir, base + '.converting.mp4');
  }

  /**
   * Get the final MP4 output path for a converted file.
   */
  _getConvertOutputPath(inputPath) {
    const dir = path.dirname(inputPath);
    const base = path.basename(inputPath, path.extname(inputPath));
    return path.join(dir, base + '.mp4');
  }

  /**
   * Start FFmpeg conversion of a library item to browser-compatible MP4.
   */
  _startConversion(id) {
    const item = this._items.get(id);
    if (!item || !item.filePath) return;

    const inputPath = path.join(this._libraryPath, item.filePath);
    const tempOutputPath = this._getConvertTempPath(inputPath);
    const finalOutputPath = this._getConvertOutputPath(inputPath);

    // Store original file path for rollback on failure
    if (!item.originalFilePath) {
      item.originalFilePath = item.filePath;
    }

    const duration = item._probeDuration || 0;

    const ffmpeg = spawn('ffmpeg', [
      '-i', inputPath,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      '-f', 'mp4',
      '-y',
      '-progress', 'pipe:1',
      '-loglevel', 'warning',
      tempOutputPath,
    ]);

    this._convertProcesses.set(id, ffmpeg);

    // Parse progress from FFmpeg stdout
    let progressBuf = '';
    ffmpeg.stdout.on('data', (data) => {
      progressBuf += data.toString();
      const lines = progressBuf.split('\n');
      progressBuf = lines.pop(); // keep incomplete line

      for (const line of lines) {
        const match = line.match(/^out_time_us=(\d+)/);
        if (match && duration > 0) {
          const currentSec = parseInt(match[1], 10) / 1e6;
          item.convertProgress = Math.min(99, Math.round((currentSec / duration) * 100));
        }
      }
    });

    ffmpeg.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.log(`[FFmpeg/Convert] ${msg}`);
    });

    ffmpeg.on('error', (err) => {
      console.error(`[Library] FFmpeg conversion error for "${item.name}": ${err.message}`);
      this._onConversionFailure(id, `FFmpeg error: ${err.message}`);
    });

    ffmpeg.on('close', (code) => {
      this._convertProcesses.delete(id);

      if (code === 0) {
        this._onConversionSuccess(id, inputPath, tempOutputPath, finalOutputPath);
      } else {
        this._onConversionFailure(id, `FFmpeg exited with code ${code}`);
      }
    });
  }

  /**
   * Handle successful conversion: rename temp file, delete original, update metadata.
   */
  _onConversionSuccess(id, inputPath, tempOutputPath, finalOutputPath) {
    const item = this._items.get(id);
    if (!item) return;

    try {
      // Verify output file exists and has non-zero size
      const stat = fs.statSync(tempOutputPath);
      if (stat.size === 0) {
        this._onConversionFailure(id, 'Conversion produced empty file');
        return;
      }

      // Rename temp to final
      fs.renameSync(tempOutputPath, finalOutputPath);

      // Delete original file (only if it's different from the output)
      if (inputPath !== finalOutputPath && fs.existsSync(inputPath)) {
        fs.unlinkSync(inputPath);
      }

      // Update item metadata
      const newRelPath = path.relative(this._libraryPath, finalOutputPath);
      item.filePath = newRelPath;
      item.fileName = path.basename(finalOutputPath);
      item.fileSize = stat.size;
      item.status = 'complete';
      item.convertProgress = 100;
      item.originalFilePath = null;
      delete item._probeDuration;

      this._saveMetadata();
      console.log(`[Library] Conversion complete: "${item.name}" → ${item.fileName} (${(stat.size / 1e9).toFixed(2)} GB)`);

      // Check if there are pending conversions waiting for a slot
      this._processConversionQueue();

      // Stop periodic save if nothing active
      if (this._engines.size === 0 && this._convertProcesses.size === 0) {
        this._stopPeriodicSave();
      }
    } catch (err) {
      console.error(`[Library] Conversion finalization error: ${err.message}`);
      this._onConversionFailure(id, `Finalization error: ${err.message}`);
    }
  }

  /**
   * Handle failed conversion: clean up temp file, revert to original, allow on-the-fly remux.
   */
  _onConversionFailure(id, reason) {
    const item = this._items.get(id);
    if (!item) return;

    console.error(`[Library] Conversion failed for "${item.name}": ${reason}`);

    // Delete temp file if it exists
    const sourcePath = item.originalFilePath || item.filePath;
    const tempPath = this._getConvertTempPath(path.join(this._libraryPath, sourcePath));
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch { /* ignore */ }

    // Revert to original file — on-the-fly remux still works
    if (item.originalFilePath) {
      item.filePath = item.originalFilePath;
      item.originalFilePath = null;
    }
    item.status = 'complete';
    item.convertError = reason;
    item.convertProgress = null;
    delete item._probeDuration;

    this._saveMetadata();
    this._processConversionQueue();

    if (this._engines.size === 0 && this._convertProcesses.size === 0) {
      this._stopPeriodicSave();
    }
  }

  /**
   * Kill an active conversion process for the given item.
   */
  _stopConversion(id) {
    const proc = this._convertProcesses.get(id);
    if (proc) {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      this._convertProcesses.delete(id);
    }
  }

  /**
   * Check for items pending conversion and start them if a slot is available.
   */
  _processConversionQueue() {
    if (this._convertProcesses.size >= this._maxConcurrentConversions) return;

    const pending = [...this._items.values()].find(i => i._pendingConversion);
    if (!pending) return;

    delete pending._pendingConversion;
    pending.status = 'converting';
    pending.convertProgress = 0;
    pending.convertError = null;
    this._saveMetadata();
    this._startPeriodicSave();

    console.log(`[Library] Starting queued conversion: "${pending.name}"`);
    this._startConversion(pending.id);
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
      convertProgress: item.convertProgress || null,
      convertError: item.convertError || null,
      packId: item.packId || null,
      showName: item.showName || null,
    };
  }

  _safeDirectoryName(item) {
    const base = (item.name || 'unknown').replace(/[^\w\s.\-()[\]]/g, '_').substring(0, 100);
    return `${base}_${item.infoHash.slice(0, 8)}`;
  }
}

module.exports = LibraryManager;
