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
const { PeerManager } = require('./peer-manager');

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
    // PeerManager instances keyed by engine reference. WeakMap so entries are
    // garbage-collected when the engine is released, and every engine.destroy
    // site can look up its peer manager without a parallel id map. See
    // lib/peer-manager.js for why this exists at all.
    this._peerMgrByEngine = new WeakMap();
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

    // Disk recovery + resume + metadata repair are deferred to an async
    // init chain so the constructor (and therefore Express startup) does
    // not block on hundreds of fs.stat calls. The chain is strictly
    // ordered: _recoverFromDiskState MUST complete before
    // _resumeInterruptedDownloads so that items whose files are already
    // complete on disk don't trigger unnecessary torrent engine spin-up.
    this._initPromise = this._initAsync();
  }

  async _initAsync() {
    try {
      // Recover items that are fully downloaded on disk but stuck in the
      // wrong status (most commonly 'failed' from a torrent-metadata-timeout
      // during resume, or 'downloading' from a container crash mid-download).
      await this._recoverFromDiskState();
      // Auto-resume any downloads/conversions that were interrupted
      // (power loss, crash, restart).
      this._resumeInterruptedDownloads();
      await this._resumeInterruptedConversions();
      // Auto-repair season metadata for packs.
      this.repairPackMetadata();
      // Sweep the library for files that should be pre-transcoded to
      // universal H.264/AAC/MP4 so live transcoding never has to run.
      // Fire-and-forget: the sweep yields between probes and queues
      // conversions through the normal concurrency cap, so it's safe
      // to let it run alongside Express and active downloads.
      this._scanCompleteItemsForConversion().catch(err => {
        console.error('[Library] Conversion sweep failed:', err);
      });
    } catch (err) {
      console.error('[Library] Async init failed:', err);
    }
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

  /**
   * Returns true when an item's file is fully present on disk at the
   * exact expected size. Used by startup recovery to distinguish items
   * that are genuinely still downloading from items that are actually
   * complete but got stuck in 'downloading' (container crash) or
   * 'failed' (torrent resume metadata timeout) in metadata.
   *
   * Uses only fs.promises.stat() — no ffprobe, no torrent engine — and
   * yields back to the event loop between syscalls, so it's safe to
   * run against every item at startup without blocking Express.
   */
  async _isFileCompleteOnDisk(item) {
    if (!item || !item.filePath || !item.fileSize || item.fileSize <= 0) {
      return false;
    }
    const fullPath = path.join(this._libraryPath, item.filePath);
    if (!this._isPathSafe(fullPath)) return false;
    try {
      const stat = await fs.promises.stat(fullPath);
      return stat.isFile() && stat.size === item.fileSize;
    } catch {
      return false;
    }
  }

  /**
   * Scan every item after metadata load and auto-recover any that are
   * in 'failed' or 'downloading' but whose files are already fully
   * present on disk at the expected size.
   *
   * Fixes the common failure mode where a container restart triggers
   * _resumeInterruptedDownloads() for items whose torrents can no longer
   * reach metadata within the 90s timeout — even though the underlying
   * files had long since finished downloading to disk. Without this
   * recovery, those items get stuck permanently in 'failed' with
   * "Torrent metadata timeout (90s) on resume" until the user manually
   * retries each one.
   *
   * Runs once at startup via the async init chain. Stats are issued in
   * bounded-concurrency batches using fs.promises.stat so the event
   * loop stays responsive even for libraries with hundreds of items.
   */
  async _recoverFromDiskState() {
    const candidates = [];
    for (const item of this._items.values()) {
      const needsCheck =
        item.status === 'failed' ||
        item.status === 'downloading' ||
        item._needsResume;
      if (needsCheck) candidates.push(item);
    }
    if (candidates.length === 0) return;

    let recoveredFailed = 0;
    let skippedResume = 0;
    const BATCH_SIZE = 32;
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(item => this._isFileCompleteOnDisk(item))
      );
      for (let j = 0; j < batch.length; j++) {
        if (!results[j]) continue;
        const item = batch[j];
        const wasFailed = item.status === 'failed';
        item.status = 'complete';
        item.error = null;
        item.progress = 100;
        item.downloadSpeed = 0;
        item.numPeers = 0;
        if (!item.completedAt) item.completedAt = Date.now();
        if (item._needsResume) delete item._needsResume;
        if (wasFailed) recoveredFailed++;
        else skippedResume++;
      }
    }

    if (recoveredFailed || skippedResume) {
      console.log(
        `[Library] Disk recovery: ${recoveredFailed} failed items restored, ` +
        `${skippedResume} resumes skipped (files already complete on disk)`
      );
      this._saveMetadata();
    }
  }

  // ─── Disk Audit ──────────────────────────────────

  /**
   * Walk the library directory and classify every tracked item and every
   * on-disk file so the caller can decide what to re-download or delete.
   *
   * This is the "disk memory audit" entry point. Unlike _recoverFromDiskState
   * (which only flips stuck items to 'complete' when the file is perfect),
   * this produces a full report of anything that is wrong AND of anything
   * that sits on disk without a matching tracked item.
   *
   * The fast path uses only fs.statSync, so it's cheap to run on demand.
   * Passing { deep: true } additionally spawns ffprobe against every
   * "complete" file and flags the item as corrupt when ffprobe can't find
   * a video stream — this catches truncated or half-written files that
   * still happen to have the right byte count (rare but possible).
   *
   * Returns:
   *   {
   *     libraryPath,
   *     scannedItems, scannedDiskBytes,
   *     issues: [ { id, kind, reason, ...fields } ],
   *     orphans: [ { relPath, sizeBytes, kind, reason } ],
   *     summary: { ok, missingFile, wrongSize, zeroByte, corrupt,
   *                unsafePath, badMetadata, orphanedFiles,
   *                orphanedTempFiles, orphanedEmptyDirs, totalBytes }
   *   }
   *
   * Issue kinds (for tracked items):
   *   - 'missing_file'   — status=complete but filePath does not exist
   *   - 'wrong_size'     — on-disk size != item.fileSize
   *   - 'zero_byte'      — on-disk file exists but is empty
   *   - 'corrupt'        — ffprobe found no video stream (deep mode only)
   *   - 'unsafe_path'    — filePath escapes the library root
   *   - 'bad_metadata'   — filePath/fileSize missing for a complete item
   *   - 'stale_downloading' — status=downloading but no engine + partial or
   *                            missing file; caller can redownload
   *
   * Orphan kinds (for untracked disk entries):
   *   - 'video_file'         — a .mkv/.mp4/... not referenced by any item
   *   - 'converting_temp'    — leftover *.converting.mp4 from a crashed convert
   *   - 'metadata_temp'      — leftover _metadata.json.tmp.*
   *   - 'empty_directory'    — directory with no files left inside it
   */
  async auditDiskState(opts = {}) {
    const deep = !!opts.deep;
    const issues = [];
    const orphans = [];
    const summary = {
      ok: 0,
      missingFile: 0,
      wrongSize: 0,
      zeroByte: 0,
      corrupt: 0,
      unsafePath: 0,
      badMetadata: 0,
      staleDownloading: 0,
      orphanedFiles: 0,
      orphanedTempFiles: 0,
      orphanedEmptyDirs: 0,
      totalBytes: 0,
    };

    // ── Phase 1: every tracked item vs. disk ──
    for (const item of this._items.values()) {
      // Items that are supposed to be in-flight are not audit targets — an
      // in-progress download legitimately has partial or missing bytes.
      if (item.status === 'queued' || item.status === 'paused') {
        continue;
      }

      // status=downloading with no engine running is actually stuck — the
      // process crashed or resume failed. Surface it so the UI can retry.
      if (item.status === 'downloading') {
        const hasEngine = item.packId
          ? this._engines.has(item.packId)
          : this._engines.has(item.id);
        if (!hasEngine) {
          issues.push({
            id: item.id,
            name: item.name,
            kind: 'stale_downloading',
            reason: 'status=downloading but no active torrent engine',
            filePath: item.filePath || null,
            fileSize: item.fileSize || 0,
          });
          summary.staleDownloading++;
        }
        continue;
      }

      if (item.status !== 'complete' && item.status !== 'converting' &&
          item.status !== 'failed') {
        continue;
      }

      if (!item.filePath) {
        // A complete item without a filePath is a metadata bug, not a
        // disk problem — leave 'failed' alone (its torrent never resolved).
        if (item.status === 'complete' || item.status === 'converting') {
          issues.push({
            id: item.id,
            name: item.name,
            kind: 'bad_metadata',
            reason: 'complete item has no filePath',
          });
          summary.badMetadata++;
        }
        continue;
      }

      const fullPath = path.join(this._libraryPath, item.filePath);
      if (!this._isPathSafe(fullPath)) {
        issues.push({
          id: item.id,
          name: item.name,
          kind: 'unsafe_path',
          reason: 'filePath escapes library root',
          filePath: item.filePath,
        });
        summary.unsafePath++;
        continue;
      }

      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        // Only flag missing files for items that claim to be complete.
        // Items in 'failed' that don't exist on disk are a valid state.
        if (item.status === 'complete' || item.status === 'converting') {
          issues.push({
            id: item.id,
            name: item.name,
            kind: 'missing_file',
            reason: 'file not found on disk',
            filePath: item.filePath,
            fileSize: item.fileSize || 0,
          });
          summary.missingFile++;
        }
        continue;
      }

      if (!stat.isFile()) {
        issues.push({
          id: item.id,
          name: item.name,
          kind: 'bad_metadata',
          reason: 'filePath is not a regular file',
          filePath: item.filePath,
        });
        summary.badMetadata++;
        continue;
      }

      summary.totalBytes += stat.size;

      if (stat.size === 0) {
        issues.push({
          id: item.id,
          name: item.name,
          kind: 'zero_byte',
          reason: 'on-disk file is empty',
          filePath: item.filePath,
          fileSize: item.fileSize || 0,
          diskSize: 0,
        });
        summary.zeroByte++;
        continue;
      }

      // item.fileSize may be 0 when the torrent metadata never resolved
      // on a prior run — treat that as "size unknown, size check skipped"
      // rather than an issue, because we legitimately don't know what the
      // expected size is.
      if (item.fileSize && stat.size !== item.fileSize) {
        issues.push({
          id: item.id,
          name: item.name,
          kind: 'wrong_size',
          reason: `on-disk size ${stat.size} != expected ${item.fileSize}`,
          filePath: item.filePath,
          fileSize: item.fileSize,
          diskSize: stat.size,
        });
        summary.wrongSize++;
        continue;
      }

      // At this point the file exists and size matches (or fileSize unknown).
      // Only complete/converting items count towards the ok tally — failed
      // items that happen to have a perfect file on disk are a different
      // kind of problem (handled by _recoverFromDiskState, not here).
      if (item.status === 'complete' || item.status === 'converting') {
        if (deep) {
          const probe = await this._probeFile(fullPath);
          if (!probe.probeOk || !probe.videoCodec) {
            issues.push({
              id: item.id,
              name: item.name,
              kind: 'corrupt',
              reason: probe.reason || 'ffprobe found no video stream',
              filePath: item.filePath,
              fileSize: item.fileSize || stat.size,
              diskSize: stat.size,
            });
            summary.corrupt++;
            continue;
          }
        }
        summary.ok++;
      }
    }

    // ── Phase 2: disk entries without a tracked item ──
    const trackedPaths = new Set();
    for (const it of this._items.values()) {
      if (it.filePath) trackedPaths.add(path.normalize(it.filePath));
    }

    const walk = (absDir, relDir) => {
      let entries;
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch {
        return { hadFiles: false };
      }
      let hadFiles = false;
      for (const entry of entries) {
        const absPath = path.join(absDir, entry.name);
        const relPath = relDir ? path.join(relDir, entry.name) : entry.name;

        // Skip metadata files at the library root.
        if (!relDir && (entry.name === '_metadata.json' || entry.name === '_metadata.json.bak')) {
          hadFiles = true;
          continue;
        }

        if (entry.isDirectory()) {
          const childResult = walk(absPath, relPath);
          if (childResult.hadFiles) hadFiles = true;
          else {
            orphans.push({
              relPath,
              kind: 'empty_directory',
              reason: 'directory contains no files',
              sizeBytes: 0,
            });
            summary.orphanedEmptyDirs++;
          }
          continue;
        }

        if (!entry.isFile()) continue;
        hadFiles = true;

        let size = 0;
        try { size = fs.statSync(absPath).size; } catch { /* ignore */ }

        // Stale _metadata.json.tmp.* files at the library root
        if (!relDir && entry.name.startsWith('_metadata.json.tmp.')) {
          orphans.push({
            relPath,
            kind: 'metadata_temp',
            reason: 'stale metadata temp file from a crashed save',
            sizeBytes: size,
          });
          summary.orphanedTempFiles++;
          continue;
        }

        // Leftover ffmpeg conversion temp files (*.converting.mp4)
        if (entry.name.endsWith('.converting.mp4')) {
          // Skip if there's an active conversion that owns it
          const activeConvert = [...this._items.values()].some(i => {
            if (i.status !== 'converting') return false;
            const src = i.originalFilePath || i.filePath;
            if (!src) return false;
            const tmp = this._getConvertTempPath(path.join(this._libraryPath, src));
            return path.relative(this._libraryPath, tmp) === relPath;
          });
          if (activeConvert) continue;
          orphans.push({
            relPath,
            kind: 'converting_temp',
            reason: 'leftover conversion temp file (no active conversion)',
            sizeBytes: size,
          });
          summary.orphanedTempFiles++;
          continue;
        }

        // Untracked video files
        const ext = path.extname(entry.name).toLowerCase();
        if (!VIDEO_EXTENSIONS.has(ext)) continue;
        if (trackedPaths.has(path.normalize(relPath))) continue;

        orphans.push({
          relPath,
          kind: 'video_file',
          reason: 'video file is not referenced by any library item',
          sizeBytes: size,
        });
        summary.orphanedFiles++;
        summary.totalBytes += size;
      }
      return { hadFiles };
    };

    try {
      walk(this._libraryPath, '');
    } catch (err) {
      console.error(`[Library] Audit walk failed: ${err.message}`);
    }

    console.log(
      `[Library] Audit: ${summary.ok} ok, ${issues.length} issues, ${orphans.length} orphans`
    );

    return {
      libraryPath: this._libraryPath,
      scannedItems: this._items.size,
      scannedDiskBytes: summary.totalBytes,
      issues,
      orphans,
      summary,
      deep,
    };
  }

  /**
   * Act on the output of auditDiskState(). `action` selects what to do with
   * broken tracked items:
   *   - 'redownload' — delete the bad file, clear progress, and re-queue
   *     the item through retryItem() so the torrent engine re-verifies
   *     whatever's on disk and fetches missing pieces
   *   - 'remove'     — delete the bad file and drop the item from the library
   *
   * Orphan handling is independent of `action`:
   *   - removeOrphanFiles:      unlink untracked video files
   *   - removeOrphanTempFiles:  unlink *.converting.mp4 and _metadata.json.tmp.*
   *   - removeEmptyDirectories: rmdir empty subdirectories
   *
   * { dryRun: true } runs the classification without touching anything.
   */
  async remediateAudit(opts = {}) {
    const {
      action = 'remove',
      removeOrphanFiles = false,
      removeOrphanTempFiles = true,
      removeEmptyDirectories = true,
      dryRun = false,
      deep = false,
    } = opts;

    if (!['redownload', 'remove'].includes(action)) {
      throw new Error(`Invalid action: ${action} (expected 'redownload' or 'remove')`);
    }

    const report = await this.auditDiskState({ deep });
    const actions = [];

    // ── Tracked item issues ──
    for (const issue of report.issues) {
      const item = this._items.get(issue.id);
      if (!item) continue;

      // stale_downloading: item is stuck in 'downloading' with no engine.
      // 'redownload' kicks the engine back on; 'remove' wipes it.
      if (issue.kind === 'stale_downloading') {
        if (action === 'redownload') {
          if (!dryRun) {
            item.status = 'failed';
            item.error = 'Audit: stuck downloading with no active engine';
            this.retryItem(item.id);
          }
          actions.push({ id: item.id, kind: issue.kind, action: 'retry' });
          continue;
        }
        if (!dryRun) this.removeItem(item.id);
        actions.push({ id: item.id, kind: issue.kind, action: 'removed' });
        continue;
      }

      // Files that should exist but are missing/empty/wrong-size/corrupt:
      // delete any partial bytes on disk, then either re-queue or drop.
      const hasOnDiskFile = ['wrong_size', 'zero_byte', 'corrupt'].includes(issue.kind);
      if (!dryRun && hasOnDiskFile && item.filePath) {
        const fullPath = path.join(this._libraryPath, item.filePath);
        if (this._isPathSafe(fullPath)) {
          try { fs.unlinkSync(fullPath); } catch { /* already gone */ }
        }
      }

      if (action === 'redownload') {
        // Don't retry items that lack a magnet URI — nothing to redownload from.
        if (!item.magnetUri || !item.infoHash) {
          if (!dryRun) this.removeItem(item.id);
          actions.push({ id: item.id, kind: issue.kind, action: 'removed', reason: 'no magnet' });
          continue;
        }
        if (!dryRun) {
          item.status = 'failed';
          item.progress = 0;
          item.error = `Audit: ${issue.reason}`;
          item.completedAt = null;
          this.retryItem(item.id);
        }
        actions.push({ id: item.id, kind: issue.kind, action: 'retry' });
      } else {
        if (!dryRun) this.removeItem(item.id);
        actions.push({ id: item.id, kind: issue.kind, action: 'removed' });
      }
    }

    // ── Orphan handling ──
    for (const orphan of report.orphans) {
      const absPath = path.join(this._libraryPath, orphan.relPath);
      if (!this._isPathSafe(absPath)) continue;

      if (orphan.kind === 'video_file' && removeOrphanFiles) {
        if (!dryRun) {
          try { fs.unlinkSync(absPath); } catch (err) {
            console.error(`[Library] Audit failed to delete orphan ${orphan.relPath}: ${err.message}`);
            continue;
          }
        }
        actions.push({ relPath: orphan.relPath, kind: orphan.kind, action: 'removed' });
        continue;
      }

      if ((orphan.kind === 'converting_temp' || orphan.kind === 'metadata_temp') && removeOrphanTempFiles) {
        if (!dryRun) {
          try { fs.unlinkSync(absPath); } catch (err) {
            console.error(`[Library] Audit failed to delete temp ${orphan.relPath}: ${err.message}`);
            continue;
          }
        }
        actions.push({ relPath: orphan.relPath, kind: orphan.kind, action: 'removed' });
        continue;
      }

      if (orphan.kind === 'empty_directory' && removeEmptyDirectories) {
        if (!dryRun) {
          try { fs.rmdirSync(absPath); } catch { /* might have become non-empty */ continue; }
        }
        actions.push({ relPath: orphan.relPath, kind: orphan.kind, action: 'removed' });
      }
    }

    if (!dryRun) {
      this._discoveryCache = null; // force a fresh scan next getAll()
      this._saveMetadata();
    }

    return {
      dryRun,
      action,
      report,
      actions,
      actionCount: actions.length,
    };
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
    const { imdbId, name, poster, year, magnetUri, infoHash, quality, size, season, packDirOverride } = opts;

    if (!infoHash || !magnetUri) {
      throw new Error('infoHash and magnetUri are required');
    }

    const packId = `pack_${infoHash}`;

    // Check if this pack is already being downloaded
    if (this._engines.has(packId)) {
      return Promise.resolve({ status: 'already_downloading', items: [] });
    }

    // packDirOverride lets restartPack keep the pack on disk at the directory
    // the torrent engine originally downloaded to, so verify:true can pick up
    // partial/complete pieces instead of re-downloading from scratch.
    const isCompletePack = parseInt(season, 10) === 0;
    const packLabel = isCompletePack ? name : `${name} S${String(season).padStart(2, '0')}`;
    const packDir = packDirOverride
      ? path.join(this._libraryPath, packDirOverride)
      : path.join(this._libraryPath, this._safeDirectoryName({ name: packLabel, infoHash }));

    return new Promise((resolve, reject) => {
      // See torrent-engine.js for rationale on connections/uploads values.
      const engine = torrentStream(magnetUri, {
        connections: 50,
        uploads: 6,
        dht: true,
        verify: true,
        path: packDir,
        trackers: TRACKERS,
      });
      this._attachPeerManager(engine, `pack ${infoHash.slice(0, 8)}`);
      this._startIncomingListener(engine, `pack ${infoHash.slice(0, 8)}`);

      const timeout = setTimeout(() => {
        this._destroyEngine(engine);
        reject(new Error('Torrent metadata timeout (90s) — try a torrent with more seeds'));
      }, 90000);

      engine.on('error', (err) => {
        clearTimeout(timeout);
        this._destroyEngine(engine);
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
          this._destroyEngine(engine);
          return resolve({ status: 'no_video_files', items: [] });
        }

        // Deselect all files. Sequential mode (see _selectOnePackFile) selects
        // exactly one file at a time below, after every item is registered.
        for (const f of engine.files) f.deselect();

        // Create an item per video file. We do NOT call file.select() here —
        // _selectOnePackFile picks the first episode in season/episode order
        // once all items are in this._items.
        const createdItems = [];
        // season=0 means "complete pack — detect seasons from filenames"
        const fallbackSeason = parseInt(season, 10) || 1;

        for (const file of videoFiles) {
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

          // Prefer show name derived from the actual filename over the torrent-level name.
          // This correctly separates e.g. "Naruto Shippuden" episodes from "Naruto" when
          // they are bundled in the same torrent/download.
          const fileShowName = this._deriveShowNameFromFile(file.name);

          const item = {
            id: itemId,
            imdbId,
            type: 'series',
            name: episodeName,
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
          this._destroyEngine(engine);
          this._saveMetadata();
          return resolve({ status: 'all_exist', items: createdItems });
        }

        // Store the shared engine
        this._engines.set(packId, engine);
        this._startPeriodicSave();

        // Sequential pack download: pick the first episode now that all items
        // are registered. The progress timer auto-advances on completion.
        this._selectOnePackFile(packId, engine);

        this._trackPackProgress(packId, engine);
        this._saveMetadata();

        console.log(`[Library] Season pack started: "${name}" ${isCompletePack ? '(complete pack)' : `S${String(fallbackSeason).padStart(2, '0')}`} — ${videoFiles.length} episodes (sequential)`);
        resolve({ status: 'started', items: createdItems });
      });
    });
  }

  /**
   * Add a torrent from a raw magnet URI, auto-detecting whether it contains
   * a single video file or a collection of files. Collections create a
   * separate library item per video (using a shared torrent engine via
   * packId, same as addSeasonPack); single-file torrents fall back to the
   * simple addItem flow.
   *
   * Always async — torrent metadata must be fetched before we know how
   * many video files the torrent contains.
   */
  addManual(opts) {
    const { imdbId, type, name, poster, year, magnetUri, infoHash, quality, size } = opts;

    if (!infoHash || !magnetUri) {
      throw new Error('infoHash and magnetUri are required');
    }

    const packId = `pack_${infoHash}`;

    // Already downloading as a pack — don't start a second engine on the same torrent
    if (this._engines.has(packId)) {
      return Promise.resolve({ status: 'already_downloading', items: [] });
    }

    const scanLabel = name || `Torrent ${infoHash.slice(0, 8)}`;
    const scanDir = path.join(this._libraryPath, this._safeDirectoryName({ name: scanLabel, infoHash }));

    return new Promise((resolve, reject) => {
      // See torrent-engine.js for rationale on connections/uploads values.
      const engine = torrentStream(magnetUri, {
        connections: 50,
        uploads: 6,
        dht: true,
        verify: true,
        path: scanDir,
        trackers: TRACKERS,
      });
      this._attachPeerManager(engine, `scan ${infoHash.slice(0, 8)}`);
      this._startIncomingListener(engine, `scan ${infoHash.slice(0, 8)}`);

      const timeout = setTimeout(() => {
        this._destroyEngine(engine);
        reject(new Error('Torrent metadata timeout (90s) — try a torrent with more seeds'));
      }, 90000);

      engine.on('error', (err) => {
        clearTimeout(timeout);
        this._destroyEngine(engine);
        reject(err);
      });

      engine.on('ready', () => {
        clearTimeout(timeout);

        // Find all usable video files, excluding samples/trailers/promos and tiny junk files
        const PACK_MIN_FILE_SIZE = 10 * 1024 * 1024; // 10 MB — skip promo/ad files
        const dominated = /\b(sample|trailer|extra|bonus|featurette|interview)\b/i;
        const videoFiles = engine.files.filter(f =>
          isFileNameSafe(f.name) && !dominated.test(f.name) && f.length >= PACK_MIN_FILE_SIZE
        );

        if (videoFiles.length === 0) {
          this._destroyEngine(engine);
          return resolve({ status: 'no_video_files', items: [] });
        }

        // ─── Single-file torrent: delegate to addItem (it will re-open the engine) ───
        // The redundant metadata fetch is a small cost (usually cached locally) in
        // exchange for reusing all of addItem's queue/dedup/start logic unchanged.
        if (videoFiles.length === 1) {
          this._destroyEngine(engine);
          try {
            const result = this.addItem({
              imdbId: imdbId || null,
              type: type || 'movie',
              name,
              poster: poster || '',
              year: year || '',
              magnetUri,
              infoHash,
              quality: quality || '',
              size: size || '',
            });
            return resolve({ ...result, items: [{ id: result.id, status: result.status }] });
          } catch (err) {
            return reject(err);
          }
        }

        // ─── Multi-file torrent: one item per video, shared engine via packId ───
        const safeType = ['movie', 'series'].includes(type) ? type : 'movie';
        const idPrefix = imdbId || 'manual';
        const fallbackSeason = 1;

        // Deselect everything. Sequential mode selects exactly one file at
        // a time below, once every item is registered.
        for (const f of engine.files) f.deselect();

        const createdItems = [];

        for (const file of videoFiles) {
          let seasonNum = null;
          let episodeNum = null;
          let showName = null;
          if (safeType === 'series') {
            const parsed = this._parseSeasonEpisode(file.name, fallbackSeason);
            seasonNum = parsed.season || fallbackSeason;
            episodeNum = parsed.episode;
            showName = this._deriveShowNameFromFile(file.name) || name || 'Unknown';
          }

          // Episode items use S/E in the ID; everything else uses a filename slug
          const filenameSlug = path.basename(file.name, path.extname(file.name))
            .replace(/[^\w]/g, '_')
            .slice(0, 30);
          const itemId = (safeType === 'series' && episodeNum)
            ? `${idPrefix}_s${seasonNum}e${episodeNum}_${infoHash.slice(0, 8)}`
            : `${idPrefix}_${infoHash.slice(0, 8)}_${filenameSlug}`;

          if (this._items.has(itemId)) {
            const existing = this._items.get(itemId);
            if (existing.status === 'complete' || existing.status === 'downloading') {
              createdItems.push({ id: itemId, status: 'already_exists' });
              continue;
            }
            this._items.delete(itemId);
          }

          const relativePath = path.relative(this._libraryPath, path.join(scanDir, file.path));
          const displayName = this._deriveEpisodeName(file.name) || name || 'Unknown';

          const item = {
            id: itemId,
            imdbId: imdbId || null,
            type: safeType,
            name: displayName,
            showName,
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
          createdItems.push({ id: itemId, status: 'started' });
        }

        if (createdItems.filter(i => i.status === 'started').length === 0) {
          this._destroyEngine(engine);
          this._saveMetadata();
          return resolve({ status: 'all_exist', items: createdItems });
        }

        // Share the engine across all pack items (same mechanism as addSeasonPack)
        this._engines.set(packId, engine);
        this._startPeriodicSave();

        // Sequential pack download — select only one file to start.
        this._selectOnePackFile(packId, engine);

        this._trackPackProgress(packId, engine);
        this._saveMetadata();

        console.log(`[Library] Manual torrent started: "${scanLabel}" — ${videoFiles.length} files (sequential)`);
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
   * Pick the next episode in a pack to download. Sequential mode: only one
   * file is selected in the torrent engine at a time so its bandwidth isn't
   * spread across dozens of episodes (which made each one crawl at a few
   * KB/s and finish nothing for hours).
   *
   * Sort order: lowest season → lowest episode → earliest addedAt → id.
   * Items without a season/episode number (featurettes, extras) sort to the
   * end of their season.
   */
  _pickNextPackItem(packId) {
    const candidates = [];
    for (const item of this._items.values()) {
      if (item.packId !== packId) continue;
      if (item.status !== 'downloading') continue;
      // Don't skip on progress >= 100: pct is rounded, so a file can read 100
      // while a piece or two is still missing. _trackPackProgress transitions
      // to status='complete' only when all pieces are verifiably present, so
      // filtering by status alone is the authoritative "done" check.
      candidates.push(item);
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      const sa = a.season ?? 999;
      const sb = b.season ?? 999;
      if (sa !== sb) return sa - sb;
      const ea = a.episode ?? 999;
      const eb = b.episode ?? 999;
      if (ea !== eb) return ea - eb;
      if (a.addedAt !== b.addedAt) return a.addedAt - b.addedAt;
      return a.id.localeCompare(b.id);
    });
    return candidates[0];
  }

  /**
   * Select exactly one file in the pack engine — the next one in episode
   * order. Deselects every other file first so torrent-stream concentrates
   * peer bandwidth on a single episode at a time.
   *
   * Returns the selected item, or null if everything in the pack is done
   * or paused. Items whose fileName cannot be matched to a file in the
   * torrent are marked failed and skipped.
   */
  _selectOnePackFile(packId, engine) {
    if (!engine || !engine.files) return null;
    for (const f of engine.files) f.deselect();

    // Loop in case the next-picked item turns out to have a missing file —
    // mark it failed and try again.
    while (true) {
      const next = this._pickNextPackItem(packId);
      if (!next) return null;
      const file = engine.files.find(f => path.basename(f.name) === next.fileName);
      if (!file) {
        console.error(`[Library] Pack sequential: file "${next.fileName}" not found in torrent — marking failed`);
        next.status = 'failed';
        next.error = 'File not found in torrent';
        continue;
      }
      file.select();
      console.log(`[Library] Pack sequential: now downloading "${next.fileName}"`);
      return next;
    }
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

      // In sequential mode, only one file at a time is selected in the engine,
      // so attribute speed only to the currently-active item. Other "downloading"
      // items in the pack are queued behind it and stay at 0 KB/s in the UI.
      const activeItem = this._pickNextPackItem(packId);
      const activeId = activeItem ? activeItem.id : null;

      let allComplete = true;
      let advanceToNext = false;

      for (const [itemId, item] of this._items) {
        if (item.packId !== packId || item.status !== 'downloading') continue;

        if (itemId === activeId) {
          item.downloadSpeed = speed;
          item.numPeers = peers;
        } else {
          item.downloadSpeed = 0;
          item.numPeers = peers;
        }

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
          if (itemId === activeId) advanceToNext = true;
        } else {
          allComplete = false;
        }
      }

      // If the active file just finished, immediately select the next one so
      // peers don't sit idle until the next poll tick.
      if (advanceToNext && !allComplete) {
        this._selectOnePackFile(packId, engine);
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
      this._destroyEngine(engine);
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
      connections: 50,
      uploads: 6,
      dht: true,
      verify: true,
      path: packDir,
      trackers: TRACKERS,
    });
    this._attachPeerManager(engine, `resume ${first.infoHash.slice(0, 8)}`);
    this._startIncomingListener(engine, `resume ${first.infoHash.slice(0, 8)}`);

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
      this._destroyEngine(engine);
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
      this._destroyEngine(engine);
      this._engines.delete(packId);
      this._saveMetadata();
      this._processQueue();
    });

    engine.on('ready', () => {
      clearTimeout(timeout);

      // Deselect all files first
      for (const f of engine.files) f.deselect();

      // Validate that every downloading item in this pack still has a matching
      // file in the torrent. Items whose file vanished get marked failed so
      // _selectOnePackFile won't try to pick them.
      for (const [, item] of this._items) {
        if (item.packId !== packId || item.status !== 'downloading') continue;
        const file = engine.files.find(f => path.basename(f.name) === item.fileName);
        if (!file) {
          console.error(`[Library] Pack resume: could not find file "${item.fileName}" in torrent`);
          item.status = 'failed';
          item.error = 'File not found in torrent on resume';
        }
      }

      // Sequential pack download — select only the first remaining episode.
      // The progress timer auto-advances when this one finishes.
      this._selectOnePackFile(packId, engine);

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
        const fileShowName = this._deriveShowNameFromFile(fileName);

        const newItem = {
          id: itemId,
          imdbId: first.imdbId,
          type: 'series',
          name: episodeName,
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

    // Recover the directory the pack originally downloaded into. addSeasonPack
    // computes packDir from `name`, but on restart `name` is lost — all we
    // have per-item is `showName` (file-derived) and the episode name, both
    // of which almost always differ from the torrent-level name. Without this
    // override, restart would point the torrent engine at a brand-new empty
    // directory, causing every episode — including ones already complete on
    // disk — to re-download from scratch. The first path segment of any
    // item's filePath is the original pack directory name, so we reuse it.
    const itemWithFilePath = packItems.find(i => i.filePath);
    const packDirOverride = itemWithFilePath
      ? itemWithFilePath.filePath.split(path.sep)[0]
      : null;

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
      packDirOverride,
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
        } else {
          // Sequential mode: if we just paused the file currently selected
          // in the engine, re-pick the next remaining episode so peers don't
          // keep downloading something we no longer want.
          const engine = this._engines.get(item.packId);
          if (engine && engine.files) {
            this._selectOnePackFile(item.packId, engine);
          }
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
        // Engine already ready — re-pick the active file. If the resumed
        // item is earlier in episode order than whatever is currently
        // selected, _selectOnePackFile will switch to it. Otherwise the
        // currently-active episode keeps running until it finishes.
        this._selectOnePackFile(item.packId, engine);
        console.log(`[Library] Added to running pack engine: "${item.fileName}"`);
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
    return {
      active: this._countActiveSlots(),
      max: this._maxConcurrentDownloads,
    };
  }

  /**
   * Return one entry per active torrent-stream engine (not per library item).
   *
   * Pack engines are keyed by packId and shared by every episode in the pack,
   * so iterating library items directly would inflate counts — e.g. a 55-ep
   * Breaking Bad pack with 7 peers would look like 55 "torrents" × 7 peers =
   * 385 peers, when there's actually one swarm with 7 peers. This method
   * consolidates each engine into a single row, tags the currently-selected
   * file in sequential pack mode, and exposes both download and upload speed.
   *
   * Used by /api/diagnostics/system.
   */
  getActiveEngineStats() {
    const results = [];
    for (const [engineKey, engine] of this._engines) {
      if (!engine) continue;
      const sw = engine.swarm;
      const downloadBps = sw ? sw.downloadSpeed() : 0;
      const uploadBps = sw ? sw.uploadSpeed() : 0;
      const peers = sw ? sw.wires.length : 0;

      // Collect every library item that maps to this engine. Pack engines
      // are keyed by packId; standalone-item engines are keyed by item id.
      const members = [];
      for (const item of this._items.values()) {
        if (item.packId === engineKey || item.id === engineKey) {
          members.push(item);
        }
      }

      const isPack = members.some(i => i.packId === engineKey);
      let name;
      let activeFileName = null;
      if (isPack) {
        const first = members[0];
        name = (first && (first.showName || first.name)) || 'Unknown pack';
        // In sequential pack mode, only one file is .select()ed at a time.
        const activeItem = this._pickNextPackItem(engineKey);
        if (activeItem) {
          activeFileName = activeItem.fileName || activeItem.name || null;
        }
      } else if (members.length > 0) {
        name = members[0].name || 'Unknown';
        activeFileName = members[0].fileName || null;
      } else {
        // Engine exists but no item references it — shouldn't normally
        // happen, but don't crash the diag endpoint over it.
        name = 'Orphaned engine';
      }

      const downloadingCount = members.filter(i => i.status === 'downloading').length;
      const completeCount = members.filter(i => i.status === 'complete').length;

      results.push({
        engineKey,
        name,
        isPack,
        activeFileName,
        downloadBps,
        uploadBps,
        peers,
        itemCount: members.length,
        downloadingCount,
        completeCount,
      });
    }
    return results;
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
        // Engine already ready — re-pick the active file. If this retried
        // item is earlier in episode order it will become the active one.
        this._selectOnePackFile(item.packId, engine);
        console.log(`[Library] Added to running pack engine: "${item.fileName}"`);
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
   * Count active download slots in a pack-aware way: each pack with an active
   * engine counts as 1 slot, regardless of how many items it contains, plus
   * each non-pack 'downloading' item counts as 1 slot.
   */
  _countActiveSlots() {
    const activeItems = [...this._items.values()].filter(i => i.status === 'downloading');
    const activePacks = new Set(activeItems.filter(i => i.packId).map(i => i.packId));
    const activeSingles = activeItems.filter(i => !i.packId).length;
    return activePacks.size + activeSingles;
  }

  /**
   * Atomically pause every active/queued item in a pack with one shared engine
   * teardown. This avoids the race where the frontend fires parallel pause
   * requests per-item, each triggering engine reselection or partial state.
   */
  pausePack(packId) {
    const packItems = [...this._items.values()].filter(i => i.packId === packId);
    if (packItems.length === 0) return false;

    let changed = 0;
    for (const item of packItems) {
      if (item.status !== 'downloading' && item.status !== 'queued') continue;
      item.status = 'paused';
      item.downloadSpeed = 0;
      item.numPeers = 0;
      changed++;
    }

    if (changed === 0) return false;

    // Tear down the shared engine once — everything in the pack is now paused.
    if (this._engines.has(packId)) {
      this._stopPackEngine(packId);
    }

    this._saveMetadata();
    this._processQueue();
    console.log(`[Library] Paused pack: ${packId} (${changed} items)`);
    return true;
  }

  /**
   * Atomically resume every paused item in a pack. Starts the shared engine
   * once, then lets it download files sequentially. If the concurrent-download
   * limit is reached, the items are re-queued instead.
   */
  resumePack(packId) {
    const packItems = [...this._items.values()].filter(i => i.packId === packId);
    if (packItems.length === 0) return false;

    const pausedItems = packItems.filter(i => i.status === 'paused');
    if (pausedItems.length === 0) return false;

    // Pack-aware slot check: a single pack engine counts as 1 slot.
    const activePacks = new Set(
      [...this._items.values()]
        .filter(i => i.status === 'downloading' && i.packId)
        .map(i => i.packId),
    );
    const packAlreadyActive = activePacks.has(packId);
    if (!packAlreadyActive && this._countActiveSlots() >= this._maxConcurrentDownloads) {
      // No free slots — re-queue the items so they start later.
      for (const item of pausedItems) {
        item.status = 'queued';
      }
      this._saveMetadata();
      console.log(`[Library] Resume-pack queued (at capacity): ${packId}`);
      return true;
    }

    for (const item of pausedItems) {
      item.status = 'downloading';
      item.error = null;
    }

    const engine = this._engines.get(packId);
    if (!engine) {
      const allDownloading = [...this._items.values()].filter(
        i => i.packId === packId && i.status === 'downloading',
      );
      this._resumePackDownload(packId, allDownloading);
    } else if (engine.files) {
      this._selectOnePackFile(packId, engine);
    }

    this._saveMetadata();
    console.log(`[Library] Resumed pack: ${packId} (${pausedItems.length} items)`);
    return true;
  }

  /**
   * Atomically force-start a queued pack. Used by the "Start Now" button on
   * queued packs in the downloads UI.
   */
  startPack(packId) {
    const packItems = [...this._items.values()].filter(i => i.packId === packId);
    if (packItems.length === 0) return false;

    const queuedItems = packItems.filter(i => i.status === 'queued');
    if (queuedItems.length === 0) return false;

    const activePacks = new Set(
      [...this._items.values()]
        .filter(i => i.status === 'downloading' && i.packId)
        .map(i => i.packId),
    );
    const packAlreadyActive = activePacks.has(packId);
    if (!packAlreadyActive && this._countActiveSlots() >= this._maxConcurrentDownloads) {
      return false;
    }

    for (const item of queuedItems) {
      item.status = 'downloading';
      item.progress = item.progress || 0;
      item.error = null;
    }

    if (!this._engines.has(packId)) {
      const allDownloading = [...this._items.values()].filter(
        i => i.packId === packId && i.status === 'downloading',
      );
      this._resumePackDownload(packId, allDownloading);
    }

    this._saveMetadata();
    console.log(`[Library] Force-started pack: ${packId} (${queuedItems.length} items)`);
    return true;
  }

  /**
   * Atomically retry every failed item in a pack.
   */
  retryPack(packId) {
    const packItems = [...this._items.values()].filter(i => i.packId === packId);
    if (packItems.length === 0) return false;

    const failedItems = packItems.filter(i => i.status === 'failed');
    if (failedItems.length === 0) return false;

    const activePacks = new Set(
      [...this._items.values()]
        .filter(i => i.status === 'downloading' && i.packId)
        .map(i => i.packId),
    );
    const packAlreadyActive = activePacks.has(packId);
    const atCapacity = !packAlreadyActive && this._countActiveSlots() >= this._maxConcurrentDownloads;

    for (const item of failedItems) {
      item.status = atCapacity ? 'queued' : 'downloading';
      item.error = null;
      item.downloadSpeed = 0;
      item.numPeers = 0;
    }

    if (!atCapacity) {
      if (!this._engines.has(packId)) {
        const allDownloading = [...this._items.values()].filter(
          i => i.packId === packId && i.status === 'downloading',
        );
        this._resumePackDownload(packId, allDownloading);
      } else {
        const engine = this._engines.get(packId);
        if (engine && engine.files) {
          this._selectOnePackFile(packId, engine);
        }
      }
    }

    this._saveMetadata();
    console.log(`[Library] Retry pack: ${packId} (${failedItems.length} items${atCapacity ? ' queued' : ''})`);
    return true;
  }

  /**
   * Atomically remove every item in a pack. Stops the shared engine BEFORE
   * deleting files so the engine no longer holds file handles to paths we are
   * about to unlink, then removes items one at a time (removeItem handles the
   * per-item filesystem cleanup).
   */
  removePack(packId) {
    const packItems = [...this._items.values()].filter(i => i.packId === packId);
    if (packItems.length === 0) return false;

    // Stop the shared engine first so it releases file handles and the
    // sequential file-picker doesn't try to re-select a file we're deleting.
    if (this._engines.has(packId)) {
      this._stopPackEngine(packId);
    }

    for (const item of packItems) {
      this.removeItem(item.id);
    }

    console.log(`[Library] Removed pack: ${packId} (${packItems.length} items)`);
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

    // If this item belongs to a pack, decide whether to stop the shared
    // engine or re-pick a different file. Note: we intentionally do NOT call
    // _selectOnePackFile while this item is still in this._items — if the
    // removed item's file was the one currently being downloaded, the sequential
    // picker might re-select it. We remove the item from the map first (below)
    // and do the reselect afterwards.
    const packIdForRemoval = item.packId;

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

    // After removal, fix up the shared pack engine (if any):
    //   - If no other items remain downloading in the pack, stop the engine.
    //   - Otherwise, re-pick the next file so the engine doesn't keep
    //     downloading bytes for the item we just removed.
    if (packIdForRemoval) {
      const remainingActive = [...this._items.values()].filter(
        i => i.packId === packIdForRemoval && i.status === 'downloading',
      );
      if (remainingActive.length === 0) {
        if (this._engines.has(packIdForRemoval)) {
          this._stopPackEngine(packIdForRemoval);
        }
      } else {
        const engine = this._engines.get(packIdForRemoval);
        if (engine && engine.files) {
          this._selectOnePackFile(packIdForRemoval, engine);
        }
      }
    }

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

  /**
   * Probe a library item's file and return codec/container metadata.
   * Returns null if the item or its file can't be found. Otherwise returns
   * whatever _probeFile() returns — see that method's docstring.
   */
  async probeItem(id) {
    const filePath = this.getFilePath(id);
    if (!filePath) return null;
    return this._probeFile(filePath);
  }

  /**
   * Return the current background-conversion state for an item, or null
   * if none is running or queued. Used by the live transcode endpoint
   * to detect CPU contention (and tell the client to wait) and by the
   * probe endpoint to expose convertKind + progress in its response.
   */
  getConversionState(id) {
    const item = this._items.get(id);
    if (!item) return null;
    const active = this._convertProcesses.has(id);
    const pending = !!item._pendingConversion;
    if (!active && !pending && item.status !== 'converting') return null;
    return {
      active,
      pending,
      kind: item.convertKind || item._pendingConvertKind || null,
      progress: item.convertProgress || 0,
    };
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
    // Pack-aware slot counting: a single pack engine counts as 1 slot
    // regardless of how many episodes share it. Otherwise a single active
    // pack would lock out every queued item because raw counts see N>=max.
    const available = this._maxConcurrentDownloads - this._countActiveSlots();
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
      connections: 50,
      uploads: 6,
      dht: true,
      verify: true,
      path: itemDir,
      trackers: TRACKERS,
    });
    this._attachPeerManager(engine, `dl ${item.infoHash.slice(0, 8)}`);
    this._startIncomingListener(engine, `dl ${item.infoHash.slice(0, 8)}`);

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
      this._destroyEngine(engine);
      this._engines.delete(id);
    }

    // Stop periodic save when no downloads or conversions are active
    if (this._engines.size === 0 && this._convertProcesses.size === 0) {
      this._stopPeriodicSave();
    }
  }

  /**
   * Attach a PeerManager to a freshly-created torrent-stream engine so dead
   * peers get blocked instead of cycling back in on every tracker announce.
   * See lib/peer-manager.js for the full rationale.
   */
  _attachPeerManager(engine, label) {
    const mgr = new PeerManager(engine, { label });
    this._peerMgrByEngine.set(engine, mgr);
    return mgr;
  }

  /**
   * Start a TCP listener on the engine so remote peers can initiate
   * connections to us. Without this the engine is outbound-only: we can
   * talk to peers the tracker tells us about, but no peer can reach US
   * via PEX advertisements or DHT lookups, which caps the effective
   * swarm size at whatever the tracker hands back.
   *
   * torrent-stream's engine.listen(cb) starts at port 6881 (BT tradition)
   * and falls back to an OS-assigned port if 6881 is busy. The first
   * engine to start in a given session grabs 6881 — that's the port a
   * user will typically forward on their router, giving at least one of
   * our concurrent downloads maximum reachability. Other engines end up
   * on ephemeral ports and only benefit from UPnP/DHT.
   *
   * Whichever port is chosen is automatically announced to the tracker
   * and advertised via DHT, because engine.listen() ends with
   * discovery.updatePort(engine.port) internally.
   */
  _startIncomingListener(engine, label) {
    try {
      engine.listen((err) => {
        if (err) {
          console.warn(`[Library] ${label}: incoming listener failed: ${err.message}`);
          return;
        }
        console.log(`[Library] ${label}: listening for incoming peers on :${engine.port}`);
      });
    } catch (err) {
      console.warn(`[Library] ${label}: engine.listen threw: ${err.message}`);
    }
  }

  /**
   * Tear down a torrent-stream engine and its PeerManager in the right order.
   * Safe to call on any engine — if no peer manager was attached it's a noop
   * for that side. Use this in every place the old code called engine.destroy.
   */
  _destroyEngine(engine) {
    if (!engine) return;
    const mgr = this._peerMgrByEngine.get(engine);
    if (mgr) {
      this._peerMgrByEngine.delete(engine);
      try { mgr.destroy(); } catch { /* ignore */ }
    }
    try { engine.destroy(); } catch { /* ignore */ }
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

  async _resumeInterruptedConversions() {
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

      // Re-probe to recover convertKind — it may not be in metadata if
      // the item was written out before this field existed, and we
      // want to be sure the kind still matches the current source
      // (e.g. user replaced the file).
      const probe = await this._probeFile(fullPath);
      if (!probe.probeOk) {
        console.error(`[Library] Cannot resume conversion for "${item.name}" — probe failed: ${probe.reason}`);
        item.status = 'complete';
        item.convertError = `Resume probe failed: ${probe.reason}`;
        item.convertKind = null;
        continue;
      }
      const kind = this._classifyConversionKind(probe);
      if (!kind) {
        console.log(`[Library] "${item.name}" no longer needs conversion — marking complete`);
        item.status = 'complete';
        item.convertKind = null;
        item.convertProgress = null;
        item.conversionCheckedAt = Date.now();
        continue;
      }
      item.convertKind = kind;
      item._probeDuration = probe.duration;

      console.log(`[Library] Resuming ${kind}: "${item.name}"`);
      // Go through _checkAndConvert so the concurrency cap is honoured —
      // 10 interrupted conversions should NOT spawn 10 ffmpeg at once.
      if (this._convertProcesses.size >= this._maxConcurrentConversions) {
        item._pendingConversion = true;
        item._pendingConvertKind = kind;
        item.status = 'complete'; // keep out of the "in-flight" set until started
      } else {
        item.status = 'converting';
        item.convertProgress = 0;
        this._startPeriodicSave();
        this._startConversion(item.id);
      }
    }

    this._saveMetadata();
  }

  _saveMetadata() {
    try {
      const data = [...this._items.values()].map(item => {
        const {
          _needsResume,
          _needsConversion,
          _pendingConversion,
          _pendingConvertKind,
          _probeDuration,
          ...clean
        } = item;
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
   * Probe a video file with ffprobe to extract codec / container metadata.
   * Returns a Promise resolving to {
   *   probeOk, videoCodec, audioCodec, container, duration, ext, reason
   * }. Callers should use classifyForClient() or _isServerConvertible()
   * to interpret the result — this method does NOT decide playability,
   * it only reports what's in the file.
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
          return resolve({ probeOk: false, ext, reason: 'ffprobe failed' });
        }
        try {
          const info = JSON.parse(output);
          const videoStream = (info.streams || []).find(s => s.codec_type === 'video');
          const audioStream = (info.streams || []).find(s => s.codec_type === 'audio');

          const videoCodec = videoStream ? videoStream.codec_name : null;
          const audioCodec = audioStream ? audioStream.codec_name : null;
          // Profile and pixel format are needed to detect 10-bit / high-profile
          // H.264 encodes that browsers (especially Firefox on Linux) can parse
          // the metadata of but cannot actually decode. A file that says
          // codec=h264 but uses yuv420p10le will load metadata, fire progress
          // events, buffer plenty of data, and then just sit at readyState=1
          // (HAVE_METADATA) forever because the decoder refuses to produce
          // frames. classifyForClient uses these fields to route such files
          // to /stream/transcode instead of falsely marking them direct-play.
          const videoProfile = videoStream ? (videoStream.profile || null) : null;
          const pixFmt = videoStream ? (videoStream.pix_fmt || null) : null;
          const container = info.format ? info.format.format_name : null;
          const duration = info.format && info.format.duration != null
            ? parseFloat(info.format.duration)
            : null;

          // Empty / broken probe — ffprobe succeeded but found no streams.
          // Usually means the file is still downloading or truncated on disk.
          if (!videoStream) {
            return resolve({
              probeOk: false,
              ext,
              container,
              videoCodec: null,
              audioCodec,
              duration,
              reason: 'no video stream (file may still be downloading)',
            });
          }

          resolve({
            probeOk: true,
            ext,
            container,
            videoCodec,
            videoProfile,
            pixFmt,
            audioCodec,
            duration,
            hasAudio: !!audioStream,
          });
        } catch {
          resolve({ probeOk: false, ext, reason: 'probe parse error' });
        }
      });

      ffprobe.on('error', () => {
        resolve({ probeOk: false, ext, reason: 'ffprobe not available' });
      });
    });
  }

  /**
   * Decide what background conversion (if any) should run against a probed
   * file. This is capability-AGNOSTIC — it runs at download time when we
   * don't know which client will eventually play the file. The goal is to
   * land every file on disk as a UNIVERSALLY direct-playable MP4 so we
   * NEVER have to transcode on the fly. On-the-fly libx264 on Jetson Orin
   * Nano CPU is borderline real-time for 1080p and hopeless for 4K /
   * HEVC sources, which is exactly why the live /stream/transcode path
   * times out on files like 10-bit x265 or DV/HDR rips.
   *
   * Universal direct-play target (what every modern browser can decode
   * without any server ffmpeg in the loop):
   *   Video : H.264 Baseline/Main/High, 8-bit, 4:2:0 (yuv420p / yuvj420p)
   *   Audio : AAC (stereo or surround — the client downmixes if needed)
   *   Container : .mp4 or .m4v with a faststart moov
   *
   * Returns one of:
   *   null         — already universal, leave it alone
   *   'remux'      — video is universal but container/audio need a cheap
   *                  stream-copy remux (no video re-encode, fast)
   *   'transcode'  — video must be re-encoded to hit the universal target
   *                  (HEVC, 10-bit, VP9, MPEG4, DV, HDR, high-profile
   *                  variants browsers can't decode in software). This
   *                  is the slow path but runs once per file and the
   *                  stored result plays instantly forever after.
   */
  _classifyConversionKind(probe) {
    if (!probe || !probe.probeOk || !probe.videoCodec) return null;

    // Strict allowlist for the video side. Anything outside this must
    // be re-encoded. Note that HEVC is INTENTIONALLY excluded even
    // though some clients can decode it — browser HEVC support is so
    // uneven across platforms (Firefox/Linux has none; Chrome needs HW;
    // Safari mostly works) that storing it guarantees on-the-fly
    // transcode for a non-trivial slice of playbacks, which is exactly
    // what this classifier exists to prevent.
    const H264_OK_PROFILES = new Set([
      '', // profile unknown — trust pix_fmt
      'baseline',
      'constrained baseline',
      'main',
      'high',
      'high progressive',
      'progressive high',
    ]);
    const H264_OK_PIXFMTS = new Set(['', 'yuv420p', 'yuvj420p']);

    const profile = (probe.videoProfile || '').toLowerCase();
    const pix = (probe.pixFmt || '').toLowerCase();

    const videoUniversal = (
      probe.videoCodec === 'h264' &&
      H264_OK_PROFILES.has(profile) &&
      H264_OK_PIXFMTS.has(pix)
    );

    if (!videoUniversal) return 'transcode';

    const containerOk = probe.ext === '.mp4' || probe.ext === '.m4v';
    const audioOk = !probe.hasAudio || probe.audioCodec === 'aac';

    if (!containerOk || !audioOk) return 'remux';
    return null;
  }

  /**
   * Whether a probed video stream uses a profile / pixel format that
   * browsers can actually decode in software. The codec name alone is
   * NOT enough — Firefox will happily parse the metadata of a 10-bit
   * H.264 High 10 file, report codec_name=h264, and then stall forever
   * at readyState=1 because its software decoder can't produce frames.
   * Same trap with HEVC Main 10: canPlayType() says "probably" on
   * Chrome/Linux because the HW decoder registers, but the actual
   * decode path refuses 10-bit and the <video> element sits at
   * readyState=1 until the watchdog gives up.
   *
   * Conservative browser-decodable matrix:
   *   H.264:
   *     profile in  {Baseline, Main, High, Constrained Baseline, High Progressive}
   *     pix_fmt in  {yuv420p, yuvj420p}
   *   HEVC:
   *     NOT browser-decodable — coverage is too uneven across platforms
   *     (Firefox/Linux: none, Chrome: HW-only and flaky on 10-bit,
   *     Safari: OK) to trust canPlayType(). Always route HEVC to
   *     transcode. Background conversion will produce an H.264 mirror
   *     so the retranscode cost is paid once per file.
   *
   * Anything else → must transcode, not direct-play.
   */
  _isBrowserDecodable(probe) {
    if (!probe || !probe.probeOk) return false;
    const codec = probe.videoCodec;
    const profile = (probe.videoProfile || '').toLowerCase();
    const pix = (probe.pixFmt || '').toLowerCase();

    if (codec === 'h264') {
      // 10-bit / 4:2:2 / 4:4:4 pixel formats are not in any browser's
      // H.264 decoder. yuv420p / yuvj420p (range-tagged) are the only
      // universally supported ones.
      if (pix && pix !== 'yuv420p' && pix !== 'yuvj420p') return false;
      // High 10, High 4:2:2, High 4:4:4, Hi10P, etc. are not browser-safe.
      // Standard browser-playable H.264 profiles are Baseline / Main /
      // Constrained Baseline / High / High Progressive.
      const h264Ok = (
        profile === '' /* unknown — trust pix_fmt */ ||
        profile === 'baseline' ||
        profile === 'constrained baseline' ||
        profile === 'main' ||
        profile === 'high' ||
        profile === 'high progressive' ||
        profile === 'progressive high'
      );
      return h264Ok;
    }

    // HEVC + everything else (vp9, av1, mpeg4, mpeg2, …) → transcode.
    // Pre-transcoding in the background removes the "wait for live
    // transcode" penalty after the file has been through conversion.
    return false;
  }

  /**
   * Decide how a SPECIFIC client should play a probed file. This is the
   * single source of truth for the probe endpoint and the client's playback
   * decision tree. `caps` describes what the browser can decode:
   *   { h264: bool, hevc: bool, aac: bool, mp3: bool }
   * All caps default to false if omitted — be explicit on the client.
   *
   * Returns one of the following actions:
   *   'direct'    — serve the raw file (fast, seekable, no ffmpeg)
   *   'remux'     — container + audio fix, stream-copy video (cheap ffmpeg)
   *   'transcode' — full video re-encode to H.264 + AAC (expensive ffmpeg)
   *   'unplayable' — cannot play at all (probe failed, corrupt, etc.)
   */
  classifyForClient(probe, caps) {
    const c = caps || {};
    const result = {
      action: 'unplayable',
      reason: null,
      videoCodec: probe ? probe.videoCodec : null,
      videoProfile: probe ? probe.videoProfile : null,
      pixFmt: probe ? probe.pixFmt : null,
      audioCodec: probe ? probe.audioCodec : null,
      container: probe ? probe.container : null,
      ext: probe ? probe.ext : null,
      duration: probe ? probe.duration : null,
    };

    if (!probe || !probe.probeOk) {
      result.reason = (probe && probe.reason) || 'probe failed';
      return result;
    }

    // Video codec check, in two layers:
    //   1. Is the codec name in the client's capability set?
    //   2. Is the specific profile / pixel format browser-decodable?
    // Layer 2 catches files that ffprobe reports as h264 but whose
    // High 10 profile / 10-bit pixel format can't actually be decoded.
    const codecInCaps =
      (probe.videoCodec === 'h264' && c.h264) ||
      (probe.videoCodec === 'hevc' && c.hevc);

    const profileDecodable = this._isBrowserDecodable(probe);
    const videoPlayable = codecInCaps && profileDecodable;

    if (!videoPlayable) {
      result.action = 'transcode';
      if (!codecInCaps) {
        result.reason = `video codec ${probe.videoCodec || 'unknown'} not playable by client`;
      } else {
        result.reason = `video profile ${probe.videoProfile || '?'} / pix_fmt ${probe.pixFmt || '?'} not browser-decodable`;
      }
      return result;
    }

    // Audio codec check. Browser-native: aac, mp3. Everything else (ac3,
    // eac3, dts, truehd, flac, opus-in-mp4) needs transcoding. Files with
    // no audio stream at all are fine to direct-play.
    const audioPlayable =
      !probe.hasAudio ||
      (probe.audioCodec === 'aac' && c.aac) ||
      (probe.audioCodec === 'mp3' && c.mp3);

    // Container check. Browsers play mp4/m4v natively; anything else
    // needs at minimum a container remux.
    const containerPlayable = probe.ext === '.mp4' || probe.ext === '.m4v';

    if (containerPlayable && audioPlayable) {
      result.action = 'direct';
      return result;
    }

    // Container wrong or audio wrong — both fixable with a stream-copy
    // remux through ffmpeg (video is untouched, audio transcoded to aac).
    result.action = 'remux';
    result.reason = !containerPlayable
      ? `container ${probe.ext} needs remux to mp4`
      : `audio codec ${probe.audioCodec} needs transcode to aac`;
    return result;
  }

  /**
   * Check if a completed library item needs conversion and start it if so.
   * Probes the source, classifies via _classifyConversionKind, and either:
   *   - marks the item conversionCheckedAt and returns (already universal)
   *   - queues for conversion (no free slot)
   *   - starts conversion immediately
   */
  async _checkAndConvert(id) {
    const item = this._items.get(id);
    if (!item || item.status !== 'complete' || !item.filePath) return;

    const fullPath = path.join(this._libraryPath, item.filePath);
    if (!fs.existsSync(fullPath)) return;

    const probe = await this._probeFile(fullPath);

    if (!probe.probeOk) {
      console.log(`[Library] "${item.name}" probe failed (${probe.reason}) — skipping background conversion`);
      return;
    }

    const kind = this._classifyConversionKind(probe);

    if (!kind) {
      // Already universal direct-playable — stamp it so the startup sweep
      // doesn't re-probe this file on every restart.
      if (!item.conversionCheckedAt) {
        item.conversionCheckedAt = Date.now();
        this._saveMetadata();
      }
      console.log(`[Library] "${item.name}" is already direct-play (${probe.ext}, video=${probe.videoCodec} ${probe.videoProfile || ''} ${probe.pixFmt || ''}, audio=${probe.audioCodec || 'none'})`);
      return;
    }

    // Respect concurrent conversion limit
    if (this._convertProcesses.size >= this._maxConcurrentConversions) {
      console.log(`[Library] Conversion queued for "${item.name}" (${kind}) — waiting for active conversion to finish`);
      // Store that this needs conversion and check again when a conversion completes
      item._pendingConversion = true;
      item._pendingConvertKind = kind;
      item._probeDuration = probe.duration;
      return;
    }

    item.status = 'converting';
    item.convertKind = kind;
    item.convertProgress = 0;
    item.convertError = null;
    item._probeDuration = probe.duration;
    this._saveMetadata();
    this._startPeriodicSave();

    const pretty = kind === 'transcode' ? 'full transcode' : 'remux';
    console.log(`[Library] Starting ${pretty}: "${item.name}" (${probe.ext}, video=${probe.videoCodec} ${probe.videoProfile || ''} ${probe.pixFmt || ''} → H.264 main yuv420p, audio=${probe.audioCodec || 'none'} → aac)`);
    this._startConversion(id);
  }

  /**
   * Walk every 'complete' library item that hasn't been classified for
   * conversion yet and run _checkAndConvert on it. This is the "retrofit"
   * path for libraries that existed before background transcoding was
   * enabled — without this sweep, old files would sit on disk requiring
   * live transcode on every play until someone re-downloaded them.
   *
   * Runs serially with a small yield between probes so it doesn't starve
   * the event loop, and relies on _checkAndConvert's queueing to cap
   * concurrent ffmpeg processes at _maxConcurrentConversions.
   */
  async _scanCompleteItemsForConversion() {
    const candidates = [];
    for (const item of this._items.values()) {
      if (item.status !== 'complete') continue;
      if (!item.filePath) continue;
      if (item.conversionCheckedAt) continue;
      // Skip items whose last conversion attempt failed — don't retry
      // forever on every restart. The user can trigger a manual retry.
      if (item.convertError) continue;
      candidates.push(item.id);
    }

    if (candidates.length === 0) return;

    console.log(`[Library] Sweep: probing ${candidates.length} unchecked item(s) for background conversion`);

    for (const id of candidates) {
      try {
        await this._checkAndConvert(id);
      } catch (err) {
        console.error(`[Library] Sweep: _checkAndConvert(${id}) failed: ${err.message}`);
      }
      // Yield to the event loop between probes so HTTP and downloads
      // stay responsive during the sweep. ffprobe itself is cheap
      // (~50-200ms per file) but a library of thousands adds up.
      await new Promise(resolve => setImmediate(resolve));
    }

    console.log('[Library] Sweep complete');
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
   * Build the FFmpeg command line for a background conversion. Kind:
   *   'remux'     — stream-copy video, transcode audio to AAC, re-wrap
   *                 in an MP4 with +faststart (seekable). Cheap; bound
   *                 by disk I/O.
   *   'transcode' — full re-encode to H.264 main L4.1 yuv420p 8-bit +
   *                 AAC, 1080p-capped. Slow (CPU-bound on Orin Nano
   *                 without NVENC) but runs once per file and the
   *                 stored result is universally direct-playable so
   *                 no ffmpeg touches it on future plays.
   */
  _buildConversionArgs(inputPath, tempOutputPath, kind) {
    const common = [
      '-hide_banner',
      '-fflags', '+genpts',
      '-i', inputPath,
      // Keep the first video stream and (optionally) the first audio
      // stream. Strip subtitles and data streams explicitly — muxing
      // them into MP4 is a well-known source of ffmpeg errors and the
      // browser player can't render them anyway.
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-sn',
      '-dn',
    ];

    if (kind === 'remux') {
      return [
        ...common,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        '-f', 'mp4',
        '-y',
        '-progress', 'pipe:1',
        '-loglevel', 'warning',
        tempOutputPath,
      ];
    }

    // kind === 'transcode' — full video re-encode.
    // Preset choice rationale: libx264 on Jetson Orin Nano is the only
    // game in town (no NVENC). 'veryfast' gives a much better
    // size/quality tradeoff than 'ultrafast' while still averaging
    // ~15-25 fps at 1080p on the 6-core Cortex-A78AE, i.e. a 2-hour
    // movie lands in 2-4 hours wall-clock. Acceptable for a background
    // task and the stored file is half the size of an ultrafast output.
    //
    // 1920px cap (not 1280) preserves resolution when the source is
    // already 1080p — we're storing permanently, not transcoding for
    // an unknown mobile screen, so there's no reason to throw pixels
    // away. Sources above 1080p get downscaled to fit 1080p width,
    // which keeps libx264 realtime-adjacent and cuts file size for
    // 4K inputs significantly.
    return [
      ...common,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-profile:v', 'main',
      '-level', '4.1',
      '-pix_fmt', 'yuv420p',
      '-crf', '23',
      '-vf', "scale='min(1920,iw)':'-2'",
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ac', '2',
      '-ar', '48000',
      '-movflags', '+faststart',
      '-f', 'mp4',
      '-y',
      '-progress', 'pipe:1',
      '-loglevel', 'warning',
      tempOutputPath,
    ];
  }

  /**
   * Start FFmpeg conversion of a library item to browser-compatible MP4.
   * The kind of conversion (remux vs full transcode) is read from
   * item.convertKind, which must have been set by _checkAndConvert or
   * the resume path before calling this.
   */
  _startConversion(id) {
    const item = this._items.get(id);
    if (!item || !item.filePath) return;

    const kind = item.convertKind === 'transcode' ? 'transcode' : 'remux';

    const inputPath = path.join(this._libraryPath, item.filePath);
    const tempOutputPath = this._getConvertTempPath(inputPath);
    const finalOutputPath = this._getConvertOutputPath(inputPath);

    // Store original file path for rollback on failure
    if (!item.originalFilePath) {
      item.originalFilePath = item.filePath;
    }

    const duration = item._probeDuration || 0;

    const ffmpeg = spawn('ffmpeg', this._buildConversionArgs(inputPath, tempOutputPath, kind));

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
      item.convertKind = null;
      item.convertError = null;
      item.originalFilePath = null;
      item.conversionCheckedAt = Date.now();
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

    // Revert to original file — on-the-fly transcode still works as a
    // fallback but we stamp convertError so the startup sweep doesn't
    // retry this file indefinitely on every restart.
    if (item.originalFilePath) {
      item.filePath = item.originalFilePath;
      item.originalFilePath = null;
    }
    item.status = 'complete';
    item.convertError = reason;
    item.convertProgress = null;
    item.convertKind = null;
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

    const kind = pending._pendingConvertKind === 'transcode' ? 'transcode' : 'remux';
    delete pending._pendingConversion;
    delete pending._pendingConvertKind;
    pending.status = 'converting';
    pending.convertKind = kind;
    pending.convertProgress = 0;
    pending.convertError = null;
    this._saveMetadata();
    this._startPeriodicSave();

    console.log(`[Library] Starting queued ${kind}: "${pending.name}"`);
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
      convertKind: item.convertKind || null,
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
