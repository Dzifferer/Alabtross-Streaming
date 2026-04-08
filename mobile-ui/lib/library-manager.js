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
const METADATA_SAVE_INTERVAL = 30 * 1000; // Save metadata every 30s during active downloads
const PROGRESS_POLL_INTERVAL = 3000; // 3s — matches frontend poll cadence

/**
 * Compute file download progress from torrent-stream's bitfield.
 *
 * This is the source of truth — we cannot use fs.statSync on the output
 * file because torrent-stream writes pieces in-place at their byte offsets,
 * creating a sparse file whose stat.size reflects the highest-offset piece
 * written, not the actual amount of downloaded data. Symptom: a torrent
 * stuck at 79% with non-zero download speed because rare pieces are landing
 * at offsets below the highest piece already written.
 *
 * The bitfield is set only after a piece is hash-verified, so it's also
 * authoritative for completion detection — no need for the old "wait for
 * file size to stabilize" hack.
 */
function computeFileProgress(engine, file) {
  if (!engine || !engine.bitfield || !engine.torrent || !file || file.length <= 0) {
    return { downloadedBytes: 0, progressPct: 0, isComplete: false };
  }
  const pieceLength = engine.torrent.pieceLength;
  const torrentLength = engine.torrent.length;
  const fileStart = file.offset;
  const fileEnd = file.offset + file.length;
  const firstPiece = Math.floor(fileStart / pieceLength);
  const lastPiece = Math.floor((fileEnd - 1) / pieceLength);

  let downloadedBytes = 0;
  let allPiecesPresent = true;
  for (let i = firstPiece; i <= lastPiece; i++) {
    if (engine.bitfield.get(i)) {
      const pieceStart = i * pieceLength;
      const pieceEnd = Math.min(pieceStart + pieceLength, torrentLength);
      const overlapStart = Math.max(pieceStart, fileStart);
      const overlapEnd = Math.min(pieceEnd, fileEnd);
      if (overlapEnd > overlapStart) downloadedBytes += overlapEnd - overlapStart;
    } else {
      allPiecesPresent = false;
    }
  }

  return {
    downloadedBytes,
    progressPct: Math.min(100, Math.round((downloadedBytes / file.length) * 100)),
    isComplete: allPiecesPresent,
  };
}

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
    this._discoveryCache = null;      // cached result of _discoverUntrackedFiles
    this._discoveryCacheTs = 0;       // timestamp of last discovery scan

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

    // Auto-repair season metadata for packs (deferred to avoid blocking startup)
    setImmediate(() => this.repairPackMetadata());
  }

  /**
   * Verify that a resolved path is contained within the library directory.
   * Prevents path traversal attacks via crafted IDs (e.g. disk_../../etc/passwd).
   */
  _isPathSafe(fullPath) {
    const resolved = path.resolve(fullPath);
    const libraryRoot = path.resolve(this._libraryPath);
    return resolved === libraryRoot || resolved.startsWith(libraryRoot + path.sep);
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
    const idPrefix = imdbId || 'manual';
    const id = season != null && episode != null
      ? `${idPrefix}_s${season}e${episode}_${infoHash.slice(0, 8)}`
      : `${idPrefix}_${infoHash.slice(0, 8)}`;

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

    const isCompletePack = parseInt(season, 10) === 0;
    const packLabel = isCompletePack ? name : `${name} S${String(season).padStart(2, '0')}`;
    const packDir = path.join(this._libraryPath, this._safeDirectoryName({ name: packLabel, infoHash }));

    return new Promise((resolve, reject) => {
      // See torrent-engine.js for rationale on connections/uploads values.
      // uploads:0 is intentional leech-only mode (legal/privacy).
      const engine = torrentStream(magnetUri, {
        connections: 100,
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
        // season=0 means "complete pack — detect seasons from filenames"
        const fallbackSeason = parseInt(season, 10) || 1;

        for (const file of videoFiles) {
          file.select();

          // Parse season and episode from filename
          const parsed = this._parseSeasonEpisode(file.name, fallbackSeason);
          const seasonNum = parsed.season || fallbackSeason;
          const episodeNum = parsed.episode;

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
          const episodeTitle = this._deriveEpisodeTitle(file.name);

          // Prefer show name derived from the actual filename over the torrent-level name.
          // This correctly separates e.g. "Naruto Shippuden" episodes from "Naruto" when
          // they are bundled in the same torrent/download.
          const fileShowName = this._deriveShowNameFromFile(file.name);

          const item = {
            id: itemId,
            imdbId,
            type: 'series',
            name: episodeName,
            episodeTitle,
            showName: fileShowName || name || 'Unknown',
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

        this._trackPackProgress(packId, engine);
        this._saveMetadata();

        console.log(`[Library] Season pack started: "${name}" ${isCompletePack ? '(complete pack)' : `S${String(fallbackSeason).padStart(2, '0')}`} — ${videoFiles.length} episodes`);
        resolve({ status: 'started', items: createdItems });
      });
    });
  }

  /**
   * Parse season and episode numbers from a filename.
   * Returns { season, episode } where either may be null.
   * @param {string} fileName
   * @param {number} fallbackSeason - season to use when filename has no season indicator
   */
  _parseSeasonEpisode(fileName, fallbackSeason) {
    const base = path.basename(fileName);
    // Try S01E05 pattern in filename
    const seMatch = base.match(/S(\d+)E(\d+)/i);
    if (seMatch) return { season: parseInt(seMatch[1], 10), episode: parseInt(seMatch[2], 10) };
    // Try 1x05 pattern in filename
    const xMatch = base.match(/(\d+)x(\d+)/i);
    if (xMatch) return { season: parseInt(xMatch[1], 10), episode: parseInt(xMatch[2], 10) };

    // No season+episode combo in filename — try to extract season from directory path.
    // Check from the immediate parent directory upward so "Season 02" in the child dir
    // takes priority over "Season 1-18" in the grandparent dir.
    let dirSeason = fallbackSeason;
    const dirPart = path.dirname(fileName);
    if (dirPart && dirPart !== '.') {
      const segments = dirPart.split(path.sep).reverse(); // innermost first
      for (const seg of segments) {
        // Try "S02" (but not "S01-S07" range patterns)
        const sMatch = seg.match(/\bS(\d+)\b(?!\s*-\s*S?\d)/i);
        if (sMatch) { dirSeason = parseInt(sMatch[1], 10); break; }
        // Try "Season 2" or "Season 02"
        const seasonMatch = seg.match(/\bSeason\s*(\d+)\b(?!\s*-)/i);
        if (seasonMatch) { dirSeason = parseInt(seasonMatch[1], 10); break; }
      }
    }

    // Try E05 pattern (without season)
    const eMatch = base.match(/\bE(\d+)\b/i);
    if (eMatch) return { season: dirSeason, episode: parseInt(eMatch[1], 10) };
    // Try "- 05 -" or "- 05." or "- 05 " at end before extension (anime fansub convention)
    // Negative lookahead prevents matching year-like numbers (1900-2099)
    const dashMatch = base.match(/[-–]\s*(?!(?:19|20)\d{2}\b)(\d{1,4})\s*(?:[-–.\s]|$)/);
    if (dashMatch) return { season: dirSeason, episode: parseInt(dashMatch[1], 10) };
    // Try "Episode 5" pattern
    const epMatch = base.match(/Episode\s*(\d+)/i);
    if (epMatch) return { season: dirSeason, episode: parseInt(epMatch[1], 10) };
    // Try "Ep 14" / "Ep14" / "Ep.14" / "Ep_14" — shorthand episode marker.
    // \b before E avoids matching mid-word ("Steps14" → no match), and the
    // required digits after the optional separator avoid matching "Eps 14"
    // (the "s" breaks the pattern). For packs whose filenames only carry
    // episode info ("Ep 14 - Title.mkv") and rely on the pack's metadata
    // for the season number.
    const epShortMatch = base.match(/\bEp\.?[\s_]*(\d+)\b/i);
    if (epShortMatch) return { season: dirSeason, episode: parseInt(epShortMatch[1], 10) };
    return { season: dirSeason, episode: null };
  }

  /**
   * Backwards-compatible wrapper for code that only needs the episode number.
   */
  _parseEpisodeNumber(fileName, seasonNum) {
    return this._parseSeasonEpisode(fileName, seasonNum).episode;
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

  /**
   * Extract just the episode title from a filename, e.g.:
   *   "Ep 14 - Ozymandias - Declino.mkv"        -> "Ozymandias"
   *   "Breaking.Bad.S05E14.Ozymandias.720p.mkv" -> "Ozymandias"
   *   "Show - 010 - Sealing Jutsu.mp4"          -> "Sealing Jutsu"
   *   "Naruto - 042 [720p][x265].mkv"           -> null   (no title)
   *
   * Strategy: drop the extension, group/quality tags, then locate the
   * episode marker and capture what follows. For dual-language titles
   * ("Original - Translated"), the original (first) title is preferred
   * since it matches TMDB / search queries better.
   *
   * Returns null when no title can be confidently extracted, so callers
   * should fall back to _deriveEpisodeName for display.
   */
  _deriveEpisodeTitle(fileName) {
    let base = path.basename(fileName, path.extname(fileName));
    // Strip [group] / (group) tags
    base = base.replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '');
    // Normalize separators if file uses dots/underscores instead of spaces
    if (!base.includes(' ') && (base.includes('.') || base.includes('_'))) {
      base = base.replace(/[._]/g, ' ');
    }
    base = base.replace(/\s+/g, ' ').trim();

    // Cut everything from the first quality/codec/source tag onward.
    const tagRegex = /\b(?:480p|576p|720p|1080p|2160p|4K|UHD|x26[45]|h\.?26[45]|HEVC|HDR(?:10)?|10bit|8bit|BluRay|BDRip|BRRip|WEB[-.]?DL|WEB[-.]?Rip|HDTV|DVDRip|REMUX|PROPER|REPACK|UNCUT|EXTENDED|DD5\.1|DD2\.0|AC3|AAC|DTS|FLAC|MULTI|DUAL|SUBBED|DUBBED|pseudo)\b/i;
    const tagIdx = base.search(tagRegex);
    if (tagIdx > 0) base = base.slice(0, tagIdx).trim();

    // Locate an episode marker and take what follows it as the title.
    const markers = [
      /S\d+\s*E\d+\s*[-–:]?\s*/i,
      /\b\d+x\d+\s*[-–:]?\s*/i,
      /\bEp(?:isode)?\.?[\s_]*\d+\s*[-–:]?\s*/i,
      /[-–]\s*(?!(?:19|20)\d{2}\b)\d{1,4}\s*[-–]\s*/,
    ];
    let title = null;
    for (const re of markers) {
      const m = base.match(re);
      if (m) {
        const after = base.slice(m.index + m[0].length).trim();
        if (after) { title = after; break; }
      }
    }
    if (!title) return null;

    // Trim leading/trailing punctuation
    title = title.replace(/^[-–:\s]+|[-–:\s]+$/g, '').trim();

    // Dual-language ("Ozymandias - Declino"): take the first part if both
    // halves look like real titles. Single-dashed titles like
    // "The Lion and the Rose" are unaffected because they don't contain
    // " - " separators.
    const dashSplit = title.split(/\s+[-–]\s+/);
    if (dashSplit.length >= 2 && dashSplit[0].length >= 3 && dashSplit[1].length >= 3) {
      title = dashSplit[0].trim();
    }

    return title || null;
  }

  /**
   * Extract the show/series name from a filename by stripping episode
   * numbers, quality tags, group tags, and codec info.
   * e.g. "Naruto Shippuden - 001 [720p] [x265] [pseudo].mkv" -> "Naruto Shippuden"
   *      "[animeawake] Naruto Shippuden - 010 - Sealing Jutsu.mp4" -> "Naruto Shippuden"
   *      "Breaking.Bad.S01E05.720p.BluRay.mkv" -> "Breaking Bad"
   * Returns null if no show name can be extracted.
   */
  _deriveShowNameFromFile(fileName) {
    let base = path.basename(fileName, path.extname(fileName));
    // Strip [group] tags
    base = base.replace(/\[[^\]]*\]/g, '');
    // Replace underscores/dots with spaces (if used as separators)
    if (!base.includes(' ') || /^[\w.]+$/.test(base.replace(/\s/g, ''))) {
      base = base.replace(/[._]/g, ' ');
    }
    base = base.trim();

    // Try S01E05 pattern — show name is everything before it
    let match = base.match(/^(.+?)\s*S\d+\s*E\d+/i);
    if (match) return match[1].replace(/[-–\s]+$/, '').trim() || null;

    // Try 1x05 pattern
    match = base.match(/^(.+?)\s*\d+x\d+/i);
    if (match) return match[1].replace(/[-–\s]+$/, '').trim() || null;

    // Try "- 001" anime convention (e.g., "Naruto Shippuden - 001")
    // Negative lookahead prevents matching year-like numbers (1900-2099)
    match = base.match(/^(.+?)\s*[-–]\s*(?!(?:19|20)\d{2}\b)\d{2,4}\b/);
    if (match) return match[1].replace(/[-–\s]+$/, '').trim() || null;

    // Try E05 pattern (without season)
    match = base.match(/^(.+?)\s*E\d+\b/i);
    if (match) return match[1].replace(/[-–\s]+$/, '').trim() || null;

    // Try "Episode 5" pattern
    match = base.match(/^(.+?)\s*Episode\s*\d+/i);
    if (match) return match[1].replace(/[-–\s]+$/, '').trim() || null;

    return null;
  }

  /**
   * Shared progress tracking for pack downloads (used by both addSeasonPack and _resumePackDownload).
   * Polls file sizes every 2s to track progress, marks items complete when stable, and tears down
   * the engine when all items finish.
   */
  _trackPackProgress(packId, engine) {
    // Build basename → file map once. engine.files is stable after 'ready'.
    const filesByName = new Map();
    for (const f of engine.files) {
      filesByName.set(path.basename(f.name), f);
    }

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

        const file = filesByName.get(item.fileName);
        if (!file) {
          // File not in this engine — leave alone, allComplete stays false
          allComplete = false;
          continue;
        }

        // Bitfield-based progress (see computeFileProgress for rationale)
        const { progressPct, isComplete } = computeFileProgress(engine, file);
        item.progress = progressPct;

        if (isComplete) {
          item.status = 'complete';
          item.completedAt = Date.now();
          item.downloadSpeed = 0;
          console.log(`[Library] Pack episode complete: "${item.fileName}"`);
          this._checkAndConvert(itemId);
        } else {
          allComplete = false;
        }
      }

      if (allComplete) {
        clearInterval(progressTimer);
        this._stopPackEngine(packId);
        this._saveMetadata();
        this._processQueue();
      }
    }, PROGRESS_POLL_INTERVAL);

    this._progressTimers.set(packId, progressTimer);
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
      this._engines.delete(packId);
    }

    if (this._engines.size === 0 && this._convertProcesses.size === 0) {
      this._stopPeriodicSave();
    }
  }

  /**
   * Resume a pack download with a single shared torrent engine.
   * Selects each item's specific file by matching fileName.
   */
  _resumePackDownload(packId, items) {
    if (items.length === 0) return;

    // Prevent duplicate engines — if one is already starting/running, skip
    if (this._engines.has(packId)) return;

    const first = items[0];

    // Derive pack directory from the first item's filePath
    // filePath is relative, e.g., "ShowName_S01_hash/path/to/episode.mkv"
    const packDirName = first.filePath ? first.filePath.split(path.sep)[0] : null;
    const packDir = packDirName
      ? path.join(this._libraryPath, packDirName)
      : path.join(this._libraryPath, this._safeDirectoryName({ name: first.showName || first.name, infoHash: first.infoHash }));

    console.log(`[Library] Resuming pack "${first.showName || first.name}" (${items.length} episodes) in ${packDir}`);

    // See torrent-engine.js for rationale on connections/uploads values.
    const engine = torrentStream(first.magnetUri, {
      connections: 100,
      uploads: 0,
      dht: true,
      verify: true,
      path: packDir,
      trackers: TRACKERS,
    });

    // Store engine immediately to prevent retryItem from creating duplicates
    // (engine is usable before 'ready' — it just won't have files yet)
    this._engines.set(packId, engine);

    const timeout = setTimeout(() => {
      // Fail ALL downloading items for this pack, not just the ones passed in
      for (const [, item] of this._items) {
        if (item.packId === packId && item.status === 'downloading') {
          item.status = 'failed';
          item.error = 'Torrent metadata timeout (90s) on resume';
        }
      }
      try { engine.destroy(); } catch {}
      this._engines.delete(packId);
      this._saveMetadata();
      this._processQueue();
    }, 90000);

    engine.on('error', (err) => {
      clearTimeout(timeout);
      for (const [, item] of this._items) {
        if (item.packId === packId && item.status === 'downloading') {
          item.status = 'failed';
          item.error = err.message;
        }
      }
      try { engine.destroy(); } catch {}
      this._engines.delete(packId);
      this._saveMetadata();
      this._processQueue();
    });

    engine.on('ready', () => {
      clearTimeout(timeout);

      // Deselect all files first
      for (const f of engine.files) f.deselect();

      // Select files for ALL downloading items in this pack (not just the ones
      // originally passed in — more may have been retried since engine creation)
      for (const [, item] of this._items) {
        if (item.packId !== packId || item.status !== 'downloading') continue;

        const file = engine.files.find(f => path.basename(f.name) === item.fileName);
        if (file) {
          file.select();
          console.log(`[Library] Pack resume: selected "${file.name}" for "${item.name}"`);
        } else {
          console.error(`[Library] Pack resume: could not find file "${item.fileName}" in torrent`);
          item.status = 'failed';
          item.error = 'File not found in torrent on resume';
        }
      }

      this._startPeriodicSave();
      this._trackPackProgress(packId, engine);
      this._saveMetadata();
    });
  }

  /**
   * Get all library items, including untracked video files found on disk.
   */
  getAll() {
    const tracked = [...this._items.values()];
    const now = Date.now();
    if (!this._discoveryCache || now - this._discoveryCacheTs > 10000) {
      this._discoveryCache = this._discoverUntrackedFiles();
      this._discoveryCacheTs = now;
    }
    const all = [...tracked, ...this._discoveryCache].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
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
      if (!this._isPathSafe(fullPath)) return null;
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
   * Repair metadata for pack items that were saved with incorrect season numbers.
   * Re-parses season/episode from each item's fileName, fixes the season field,
   * re-keys items with corrected IDs, and discovers missing episodes on disk
   * that were downloaded but never tracked due to ID collisions.
   */
  repairPackMetadata() {
    const fixes = { retagged: 0, discovered: 0, errors: [] };
    const PACK_MIN_FILE_SIZE = 10 * 1024 * 1024;
    const dominated = /\b(sample|trailer|extra|bonus|featurette|interview)\b/i;

    // ── Phase 1: Fix season numbers on existing pack items ──
    const packItems = [...this._items.values()].filter(i => i.packId);
    for (const item of packItems) {
      if (!item.fileName) continue;
      const parsed = this._parseSeasonEpisode(item.fileName, item.season || 1);
      const newSeason = parsed.season || item.season;
      const newEpisode = parsed.episode;

      if (newSeason === item.season && newEpisode === item.episode) continue;

      // Build the corrected ID
      const newId = newEpisode
        ? `${item.imdbId}_s${newSeason}e${newEpisode}_${item.infoHash.slice(0, 8)}`
        : item.id; // keep existing ID if we can't determine episode

      // Re-key if the ID changed
      if (newId !== item.id) {
        if (this._items.has(newId)) {
          // Target ID already exists — skip to avoid overwriting
          fixes.errors.push(`Skipped "${item.fileName}": target ID ${newId} already exists`);
          continue;
        }
        this._items.delete(item.id);
        item.id = newId;
        this._items.set(newId, item);
      }

      item.season = newSeason;
      item.episode = newEpisode;
      fixes.retagged++;
    }

    // ── Phase 2: Discover missing episodes on disk ──
    // Group existing items by packId to find their pack directories
    const packGroups = new Map();
    for (const item of this._items.values()) {
      if (!item.packId || !item.filePath) continue;
      if (!packGroups.has(item.packId)) packGroups.set(item.packId, []);
      packGroups.get(item.packId).push(item);
    }

    const trackedFileNames = new Set(
      [...this._items.values()].filter(i => i.fileName).map(i => i.fileName)
    );

    for (const [packId, items] of packGroups) {
      const first = items[0];
      // Derive pack directory from first item's filePath
      const packDirName = first.filePath.split(path.sep)[0];
      const packDir = path.join(this._libraryPath, packDirName);

      if (!fs.existsSync(packDir)) continue;

      // Recursively find all video files in the pack directory
      const diskFiles = this._findVideoFilesRecursive(packDir);

      for (const fullPath of diskFiles) {
        const fileName = path.basename(fullPath);
        if (trackedFileNames.has(fileName)) continue;
        if (dominated.test(fileName)) continue;

        let fileSize;
        try {
          const stat = fs.statSync(fullPath);
          fileSize = stat.size;
        } catch { continue; }

        if (fileSize < PACK_MIN_FILE_SIZE) continue;

        const parsed = this._parseSeasonEpisode(fileName, first.season || 1);
        const seasonNum = parsed.season || first.season || 1;
        const episodeNum = parsed.episode;

        const itemId = episodeNum
          ? `${first.imdbId}_s${seasonNum}e${episodeNum}_${first.infoHash.slice(0, 8)}`
          : `${first.imdbId}_pack_${first.infoHash.slice(0, 8)}_${path.basename(fileName, path.extname(fileName)).replace(/[^\w]/g, '_').slice(0, 30)}`;

        if (this._items.has(itemId)) continue;

        const relativePath = path.relative(this._libraryPath, fullPath);
        const episodeName = this._deriveEpisodeName(fileName);
        const episodeTitle = this._deriveEpisodeTitle(fileName);
        const fileShowName = this._deriveShowNameFromFile(fileName);

        const newItem = {
          id: itemId,
          imdbId: first.imdbId,
          type: 'series',
          name: episodeName,
          episodeTitle,
          showName: fileShowName || first.showName || first.name,
          poster: first.poster || '',
          year: first.year || '',
          quality: first.quality || '',
          size: (fileSize / (1024 * 1024 * 1024)).toFixed(1) + ' GB',
          season: seasonNum,
          episode: episodeNum,
          infoHash: first.infoHash,
          magnetUri: first.magnetUri,
          packId,
          status: 'complete',
          progress: 100,
          downloadSpeed: 0,
          numPeers: 0,
          filePath: relativePath,
          fileName,
          fileSize,
          addedAt: Date.now(),
          completedAt: Date.now(),
          error: null,
        };

        this._items.set(itemId, newItem);
        trackedFileNames.add(fileName);
        fixes.discovered++;

        // Check if conversion is needed
        this._checkAndConvert(itemId);
      }
    }

    if (fixes.retagged > 0 || fixes.discovered > 0) {
      this._saveMetadata();
    }

    console.log(`[Library] Metadata repair: ${fixes.retagged} items retagged, ${fixes.discovered} missing episodes discovered`);
    return fixes;
  }

  /**
   * Recursively find all video files in a directory.
   */
  _findVideoFilesRecursive(dir) {
    const results = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...this._findVideoFilesRecursive(full));
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (VIDEO_EXTENSIONS.has(ext)) {
            results.push(full);
          }
        }
      }
    } catch { /* skip unreadable dirs */ }
    return results;
  }

  /**
   * Restart a pack download: stops the engine, clears all items for the pack,
   * and re-runs addSeasonPack so every episode is properly detected.
   * Already-downloaded files on disk are kept and verified by torrent-stream.
   */
  async restartPack(packId) {
    const packItems = [...this._items.values()].filter(i => i.packId === packId);
    if (packItems.length === 0) return { error: 'Pack not found' };

    const first = packItems[0];
    const { imdbId, showName, poster, year, magnetUri, infoHash, quality, size } = first;

    // Always use season=0 (complete pack mode) so addSeasonPack detects
    // seasons from filenames/directories rather than assuming a single season
    const season = 0;

    // Stop engine but only remove non-complete items (preserve already downloaded episodes)
    this._stopPackEngine(packId);
    const completedCount = packItems.filter(i => i.status === 'complete' || i.status === 'converting').length;
    for (const item of packItems) {
      if (item.status === 'complete' || item.status === 'converting') continue;
      this._stopDownload(item.id);
      this._items.delete(item.id);
    }
    this._saveMetadata();

    console.log(`[Library] Restarting pack "${showName || first.name}" (${packItems.length - completedCount} items to retry, ${completedCount} already complete)`);

    // Re-add with corrected season parsing — addSeasonPack will skip items
    // that still exist in this._items (the completed ones we preserved)
    return this.addSeasonPack({
      imdbId,
      name: showName || first.name,
      poster,
      year,
      magnetUri,
      infoHash,
      quality,
      size,
      season,
    });
  }

  /**
   * Pause an active download. Stops the torrent engine but keeps the item
   * in 'paused' status so it can be resumed later.
   */
  pauseItem(id) {
    const item = this._items.get(id);
    if (!item) return false;
    if (item.status !== 'downloading' && item.status !== 'queued') return false;

    const wasDownloading = item.status === 'downloading';
    item.status = 'paused';
    item.downloadSpeed = 0;
    item.numPeers = 0;

    if (wasDownloading) {
      if (item.packId) {
        // For pack items, only stop the shared engine if no other items are still downloading
        const remainingActive = [...this._items.values()].filter(
          i => i.packId === item.packId && i.id !== id && i.status === 'downloading'
        );
        if (remainingActive.length === 0) {
          this._stopPackEngine(item.packId);
        }
      } else {
        this._stopDownload(id);
      }
    }

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

    // For pack items, don't count sibling pack items individually — they share one engine.
    // Count each active pack as 1 slot, plus individual (non-pack) downloads.
    const activeItems = [...this._items.values()].filter(i => i.status === 'downloading');
    const activePacks = new Set(activeItems.filter(i => i.packId).map(i => i.packId));
    const activeSingles = activeItems.filter(i => !i.packId).length;
    const effectiveActive = activePacks.size + activeSingles;

    // If this item's pack already has an active engine, it doesn't consume an extra slot
    const packAlreadyActive = item.packId && activePacks.has(item.packId);
    if (!packAlreadyActive && effectiveActive >= this._maxConcurrentDownloads) {
      item.status = 'queued';
      this._saveMetadata();
      console.log(`[Library] Resume queued (at capacity): "${item.name}"`);
      return true;
    }

    item.status = 'downloading';
    item.error = null;

    if (item.packId) {
      const engine = this._engines.get(item.packId);
      if (!engine) {
        // No pack engine running — restart it with all downloading items in this pack
        const packItems = [...this._items.values()].filter(
          i => i.packId === item.packId && i.status === 'downloading'
        );
        this._resumePackDownload(item.packId, packItems);
      } else if (engine.files) {
        // Engine already ready — select this item's file directly
        const file = engine.files.find(f => path.basename(f.name) === item.fileName);
        if (file) {
          file.select();
          console.log(`[Library] Added to running pack engine: "${item.fileName}"`);
        }
      }
      // If engine exists but not ready yet, the ready handler will pick up this item
    } else {
      this._startDownload(id);
    }

    this._saveMetadata();
    console.log(`[Library] Resumed: "${item.name}"`);
    return true;
  }

  /**
   * Force-start a queued item immediately (if download slots are available).
   */
  startQueuedItem(id) {
    const item = this._items.get(id);
    if (!item) return false;
    if (item.status !== 'queued') return false;

    const activeItems = [...this._items.values()].filter(i => i.status === 'downloading');
    const activePacks = new Set(activeItems.filter(i => i.packId).map(i => i.packId));
    const activeSingles = activeItems.filter(i => !i.packId).length;
    const effectiveActive = activePacks.size + activeSingles;

    const packAlreadyActive = item.packId && activePacks.has(item.packId);
    if (!packAlreadyActive && effectiveActive >= this._maxConcurrentDownloads) {
      return false; // No slots available
    }

    item.status = 'downloading';
    item.progress = item.progress || 0;
    item.error = null;

    if (item.packId) {
      // Also start all other queued items in the same pack
      const packItems = [...this._items.values()].filter(
        i => i.packId === item.packId && i.status === 'queued'
      );
      for (const pi of packItems) {
        pi.status = 'downloading';
        pi.progress = pi.progress || 0;
      }
      if (!this._engines.has(item.packId)) {
        const allDownloading = [...this._items.values()].filter(
          i => i.packId === item.packId && i.status === 'downloading'
        );
        this._resumePackDownload(item.packId, allDownloading);
      }
    } else {
      this._startDownload(id);
    }

    this._saveMetadata();
    console.log(`[Library] Force-started queued: "${item.name}"`);
    return true;
  }

  /**
   * Returns the current effective active download count and max.
   */
  getDownloadSlots() {
    const activeItems = [...this._items.values()].filter(i => i.status === 'downloading');
    const activePacks = new Set(activeItems.filter(i => i.packId).map(i => i.packId));
    const activeSingles = activeItems.filter(i => !i.packId).length;
    return {
      active: activePacks.size + activeSingles,
      max: this._maxConcurrentDownloads,
    };
  }

  /**
   * Retry a failed download. Resets status and re-starts the torrent engine.
   */
  retryItem(id) {
    const item = this._items.get(id);
    if (!item) return false;
    if (item.status !== 'failed') return false;

    // Same pack-aware concurrent limit as resumeItem
    const activeItems = [...this._items.values()].filter(i => i.status === 'downloading');
    const activePacks = new Set(activeItems.filter(i => i.packId).map(i => i.packId));
    const activeSingles = activeItems.filter(i => !i.packId).length;
    const effectiveActive = activePacks.size + activeSingles;
    const packAlreadyActive = item.packId && activePacks.has(item.packId);

    if (!packAlreadyActive && effectiveActive >= this._maxConcurrentDownloads) {
      item.status = 'queued';
      item.error = null;
      this._saveMetadata();
      console.log(`[Library] Retry queued (at capacity): "${item.name}"`);
      return true;
    }

    item.status = 'downloading';
    item.error = null;
    // Don't reset progress — torrent engine uses verify:true to skip existing data,
    // and progress will be recalculated from disk size on the next poll cycle.
    item.downloadSpeed = 0;
    item.numPeers = 0;

    if (item.packId) {
      const engine = this._engines.get(item.packId);
      if (!engine) {
        // No engine yet — start one for all downloading items in this pack
        const packItems = [...this._items.values()].filter(
          i => i.packId === item.packId && i.status === 'downloading'
        );
        this._resumePackDownload(item.packId, packItems);
      } else if (engine.files) {
        // Engine already ready — select this item's file directly
        const file = engine.files.find(f => path.basename(f.name) === item.fileName);
        if (file) {
          file.select();
          console.log(`[Library] Added to running pack engine: "${item.fileName}"`);
        }
        // If engine.files exists but file not found, _trackPackProgress will
        // still monitor the item — it may already be on disk from a prior run
      }
      // If engine exists but not ready yet (no .files), the ready handler
      // will pick up this item since it scans all downloading pack items
    } else {
      this._startDownload(id);
    }

    this._saveMetadata();
    console.log(`[Library] Retrying: "${item.name}"`);
    return true;
  }

  /**
   * Reorder a single (non-pack) item in the queue. newPosition is 0-based among
   * logical queue entries (each pack = 1 entry, each single = 1 entry).
   */
  reorderQueue(id, newPosition) {
    const item = this._items.get(id);
    if (!item || item.status !== 'queued') return false;
    // Only for non-pack items; packs use reorderPackQueue
    if (item.packId) return false;

    // Build logical queue entries
    const queued = [...this._items.values()]
      .filter(i => i.status === 'queued')
      .sort((a, b) => a.addedAt - b.addedAt);

    const entries = [];
    const seenPacks = new Set();
    for (const qi of queued) {
      if (qi.packId) {
        if (!seenPacks.has(qi.packId)) {
          seenPacks.add(qi.packId);
          entries.push({ type: 'pack', packId: qi.packId, items: queued.filter(x => x.packId === qi.packId) });
        }
      } else {
        entries.push({ type: 'single', id: qi.id, items: [qi] });
      }
    }

    if (entries.length <= 1) return true;
    newPosition = Math.max(0, Math.min(newPosition, entries.length - 1));

    const currentIdx = entries.findIndex(e => e.type === 'single' && e.id === id);
    if (currentIdx === -1) return false;

    const [entry] = entries.splice(currentIdx, 1);
    entries.splice(newPosition, 0, entry);

    // Reassign timestamps to reflect new order
    const baseTime = Date.now() - entries.length * 1000;
    for (let i = 0; i < entries.length; i++) {
      for (const ei of entries[i].items) {
        ei.addedAt = baseTime + i * 1000;
      }
    }

    this._saveMetadata();
    console.log(`[Library] Reordered queue: "${item.name}" to position ${newPosition}`);
    return true;
  }

  /**
   * Reorder a pack in the queue. newPosition is 0-based among queue entries
   * (each pack = 1 entry, each single item = 1 entry).
   */
  reorderPackQueue(packId, newPosition) {
    const packItems = [...this._items.values()].filter(
      i => i.packId === packId && i.status === 'queued'
    );
    if (packItems.length === 0) return false;

    // Build logical queue entries: each pack = 1 entry, each single = 1 entry
    const queued = [...this._items.values()]
      .filter(i => i.status === 'queued')
      .sort((a, b) => a.addedAt - b.addedAt);

    const entries = [];       // { type, id/packId, items[] }
    const seenPacks = new Set();
    for (const item of queued) {
      if (item.packId) {
        if (!seenPacks.has(item.packId)) {
          seenPacks.add(item.packId);
          entries.push({
            type: 'pack',
            packId: item.packId,
            items: queued.filter(i => i.packId === item.packId),
          });
        }
      } else {
        entries.push({ type: 'single', items: [item] });
      }
    }

    if (entries.length <= 1) return true;
    newPosition = Math.max(0, Math.min(newPosition, entries.length - 1));

    const currentIdx = entries.findIndex(e => e.type === 'pack' && e.packId === packId);
    if (currentIdx === -1) return false;

    const [entry] = entries.splice(currentIdx, 1);
    entries.splice(newPosition, 0, entry);

    // Reassign addedAt timestamps to reflect new order
    const baseTime = Date.now() - entries.length * 1000;
    for (let i = 0; i < entries.length; i++) {
      for (const item of entries[i].items) {
        item.addedAt = baseTime + i * 1000;
      }
    }

    this._saveMetadata();
    console.log(`[Library] Reordered pack queue: "${packId}" to position ${newPosition}`);
    return true;
  }

  /**
   * Re-link a library item to a different IMDB entry.
   * Updates the imdbId, name, poster, year, and optionally showName
   * without touching the downloaded file.
   */
  relinkItem(id, { imdbId, name, poster, year, type, showName }) {
    const item = this._items.get(id);
    if (!item) return false;

    if (imdbId) item.imdbId = imdbId;
    if (name) item.name = name;
    if (showName) item.showName = showName;
    if (poster !== undefined) item.poster = poster;
    if (year !== undefined) item.year = year;
    if (type) item.type = type;

    this._saveMetadata();
    console.log(`[Library] Re-linked "${item.name}" (${id}) -> ${imdbId}`);
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
      if (!this._isPathSafe(fullPath)) return false;
      this._discoveryCache = null;
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
    this._discoveryCache = null; // invalidate discovery cache after deletion
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
      if (!this._isPathSafe(fullPath)) return null;
      if (fs.existsSync(fullPath)) return fullPath;
      return null;
    }

    if (!item || (item.status !== 'complete' && item.status !== 'converting') || !item.filePath) return null;

    const fullPath = path.join(this._libraryPath, item.filePath);
    if (!this._isPathSafe(fullPath)) return null;
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
    for (const id of [...this._engines.keys()]) {
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

    // Group queued pack items so they start together with one engine
    const packGroups = new Map();
    const singles = [];
    for (const item of queued) {
      if (item.packId) {
        if (!packGroups.has(item.packId)) packGroups.set(item.packId, []);
        packGroups.get(item.packId).push(item);
      } else {
        singles.push(item);
      }
    }

    let started = 0;

    // Start individual items
    for (const item of singles) {
      if (started >= available) break;
      item.status = 'downloading';
      item.progress = 0;
      console.log(`[Library] Dequeuing: "${item.name}"`);
      this._startDownload(item.id);
      started++;
    }

    // Start pack groups
    for (const [packId, items] of packGroups) {
      if (started >= available) break;
      for (const item of items) {
        item.status = 'downloading';
      }
      if (this._engines.has(packId)) {
        // Engine already running, items will be picked up by progress timer
      } else {
        this._resumePackDownload(packId, items);
      }
      started++;
    }

    if (started > 0) {
      this._saveMetadata();
    }
  }

  // ─── Download Management ────────────────────────

  _startDownload(id) {
    const item = this._items.get(id);
    if (!item) return;

    console.log(`[Library] Starting download: "${item.name}" (${item.infoHash.slice(0, 8)}...)`);

    const itemDir = path.join(this._libraryPath, this._safeDirectoryName(item));

    // See torrent-engine.js for rationale on connections/uploads values.
    const engine = torrentStream(item.magnetUri, {
      connections: 100,
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

        // Use bitfield for progress, NOT fs.statSync — see computeFileProgress()
        // for why. Briefly: torrent-stream writes pieces in-place at their byte
        // offsets, so the on-disk file size is unrelated to actual progress.
        const { progressPct, isComplete } = computeFileProgress(engine, file);
        item.progress = progressPct;

        if (isComplete) {
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
      }, PROGRESS_POLL_INTERVAL);

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
          // Mark interrupted conversions for auto-resume
          if (item.status === 'converting') {
            item._needsConversion = true;
            item.convertProgress = 0;
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

    // Separate pack items from individual items
    const packGroups = new Map(); // packId -> [items]
    const singles = [];
    for (const item of toResume) {
      delete item._needsResume;
      if (item.packId) {
        if (!packGroups.has(item.packId)) packGroups.set(item.packId, []);
        packGroups.get(item.packId).push(item);
      } else {
        singles.push(item);
      }
    }

    let started = 0;

    // Resume individual downloads
    for (const item of singles) {
      if (started >= this._maxConcurrentDownloads) {
        console.log(`[Library] Queued "${item.name}" — concurrent limit reached during restart`);
        item.status = 'queued';
        item.error = null;
        continue;
      }

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

    // Resume pack downloads — one shared engine per pack
    for (const [packId, items] of packGroups) {
      if (started >= this._maxConcurrentDownloads) {
        for (const item of items) {
          console.log(`[Library] Queued "${item.name}" — concurrent limit reached during restart`);
          item.status = 'queued';
          item.error = null;
        }
        continue;
      }

      console.log(`[Library] Resuming pack ${packId} with ${items.length} episodes`);
      this._resumePackDownload(packId, items);
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
        const { _needsResume, _needsConversion, _pendingConversion, _probeDuration, ...clean } = item;
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

    try {
      const entries = fs.readdirSync(this._libraryPath, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.name.startsWith('_metadata')) continue;
        if (entry.name.endsWith('.tmp')) continue;

        const entryPath = path.join(this._libraryPath, entry.name);

        if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (!VIDEO_EXTENSIONS.has(ext)) continue;
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
      console.error(`[Library] Disk scan error: ${err.message}`);
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
