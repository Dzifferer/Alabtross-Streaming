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
const { WorkerClient } = require('./worker-client');

const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 5;
const METADATA_SAVE_INTERVAL = 30 * 1000; // Save metadata every 30s during active downloads
const PROGRESS_POLL_INTERVAL = 3000; // 3s — matches frontend poll cadence

// Optional ffmpeg hwaccel (e.g. 'cuda', 'nvdec', 'v4l2m2m'). On Jetson Orin
// Nano this offloads the DECODE side of a transcode to NVDEC; the encode
// stays on libx264 because the SoC has no NVENC. Opt-in because stock
// ffmpeg builds without cuvid would otherwise fail every conversion.
const FFMPEG_HWACCEL = (process.env.FFMPEG_HWACCEL || '').trim();
function getHwaccelArgs() {
  return FFMPEG_HWACCEL ? ['-hwaccel', FFMPEG_HWACCEL] : [];
}

// LRU cache of ffprobe results, keyed on (path, mtimeMs, size). ffprobe is
// a child-process spawn that takes ~100-250ms on the Orin, and the deep
// audit / startup sweep / per-completion classifier all probe the same
// files repeatedly. Only successful probes are cached so transient empty
// results from in-flight downloads don't get pinned.
const PROBE_CACHE_MAX = 1024;
const _probeCache = new Map();
function _probeCacheGet(key) {
  const hit = _probeCache.get(key);
  if (!hit) return null;
  // Touch on read so the eviction below removes the genuinely
  // least-recently-used entry, not just the oldest insertion.
  _probeCache.delete(key);
  _probeCache.set(key, hit);
  return hit;
}
function _probeCacheSet(key, value) {
  if (_probeCache.size >= PROBE_CACHE_MAX) {
    const oldest = _probeCache.keys().next().value;
    if (oldest !== undefined) _probeCache.delete(oldest);
  }
  _probeCache.set(key, value);
}

// Per-file completion cache for computeFileProgress. WeakMap so the entry
// is collected automatically when the torrent-stream engine drops the file
// object — and so we never mutate a third-party object with our own field.
const _completedFileProgress = new WeakMap();

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

  // Bitfield bits are monotonic, so once a file is fully verified its
  // progress can never regress. Skip the per-piece scan on subsequent
  // polls — significant savings on multi-file packs where most items are
  // already done but the timer keeps iterating until the LAST one finishes.
  const cached = _completedFileProgress.get(file);
  if (cached) return cached;

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

  const result = {
    downloadedBytes,
    progressPct: Math.min(100, Math.round((downloadedBytes / file.length) * 100)),
    isComplete: allPiecesPresent,
  };

  if (allPiecesPresent) {
    _completedFileProgress.set(file, result);
  }

  return result;
}

class LibraryManager {
  constructor(opts = {}) {
    this._libraryPath = opts.libraryPath || path.join(process.cwd(), 'library');
    this._metadataFile = path.join(this._libraryPath, '_metadata.json');
    // Persistent cache for torrent-stream's BEP-9 metadata (.torrent files).
    // torrent-stream writes each successfully-received torrent metadata blob
    // to `<opts.tmp>/<opts.name>/<infoHash>.torrent` and, on subsequent
    // engine starts, reads that file instead of re-running the ut_metadata
    // handshake. The default location is /tmp/torrent-stream, which is
    // wiped on container/system restart — so after every restart every
    // resume must re-fetch metadata from peers, and usually times out for
    // old / low-seed packs even though we already have several episodes on
    // disk. Pointing `tmp`/`name` here keeps the cache alive with the
    // library volume so resume becomes instant.
    this._torrentCacheName = '_torrent-cache';
    this._torrentCachePath = path.join(this._libraryPath, this._torrentCacheName);
    this._maxConcurrentDownloads = opts.maxConcurrentDownloads || DEFAULT_MAX_CONCURRENT_DOWNLOADS;
    this._items = new Map();       // id -> library item
    this._engines = new Map();     // id -> torrent engine (active downloads only)
    // PeerManager instances keyed by engine reference. WeakMap so entries are
    // garbage-collected when the engine is released, and every engine.destroy
    // site can look up its peer manager without a parallel id map. See
    // lib/peer-manager.js for why this exists at all.
    this._peerMgrByEngine = new WeakMap();
    this._progressTimers = new Map(); // id -> interval timer
    this._convertProcesses = new Map(); // id -> conversion handle (local ffmpeg or remote worker)
    // Local conversions run libx264 on the Jetson CPU and saturate all
    // cores, so running more than one at a time is pointless. Remote
    // conversions offload to the NVENC-equipped worker; that GPU can
    // comfortably run several encodes in parallel, so we cap them
    // separately and higher.
    this._maxConcurrentConversions = 1;
    this._maxConcurrentRemoteConversions = typeof opts.maxConcurrentRemoteConversions === 'number'
      ? Math.max(1, opts.maxConcurrentRemoteConversions)
      : 3;
    // Free-space reserve kept below the library's current usage. New
    // downloads / conversions are refused when they would eat into this
    // headroom. 1 GB is enough for metadata.json churn, ffmpeg temp
    // output, and logs. Override with DISK_RESERVE_BYTES.
    this._diskReserveBytes = typeof opts.diskReserveBytes === 'number'
      ? opts.diskReserveBytes
      : 1 * 1024 * 1024 * 1024;
    // Lifetime conversion counters. Help the operator spot systemic
    // issues ("80% of worker transcodes fail") that per-item error
    // messages bury in the log. Reset on process restart.
    this._convertStats = {
      startedAt:     Date.now(),
      successLocal:  0,
      successRemote: 0,
      failLocal:     0,
      failRemote:    0,
    };
    this._metadataSaveTimer = null;
    this._discoveryCache = null;      // cached result of _discoverUntrackedFiles
    this._discoveryCacheTs = 0;       // timestamp of last discovery scan

    // Optional remote GPU conversion worker. When configured AND reachable
    // we route full transcodes to a Windows PC with NVENC instead of
    // running libx264 on the Orin's CPU. See lib/worker-client.js and
    // worker/README.md for the worker side.
    //
    // _workerHealth is null when the worker is offline / unconfigured and
    // a JSON object (the /health response) when it's reachable. Refreshed
    // every WORKER_HEALTH_INTERVAL_MS by _startWorkerHealthProbe(). Used
    // by _canStartConversionNow() to gate the download/conversion conflict.
    this._workerClient = new WorkerClient({
      workerUrl: opts.workerUrl || '',
      secret:    opts.workerSecret || '',
    });
    this._workerHealth = null;
    this._workerHealthTimer = null;

    // Ensure library directory exists
    if (!fs.existsSync(this._libraryPath)) {
      fs.mkdirSync(this._libraryPath, { recursive: true });
    }
    // Ensure the persistent torrent-metadata cache directory exists so
    // torrent-stream can write .torrent files into it immediately.
    if (!fs.existsSync(this._torrentCachePath)) {
      fs.mkdirSync(this._torrentCachePath, { recursive: true });
    }
    this._migrateLegacyTorrentCache();

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
      // If a remote GPU worker is configured, probe it now and start the
      // periodic health refresh. We do this BEFORE the conversion sweep so
      // the very first batch of background conversions can route to the
      // worker if it's online.
      if (this._workerClient.enabled()) {
        await this._refreshWorkerHealth();
        this._startWorkerHealthProbe();
      }

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
      // Drop .torrent metadata files for items the user has since deleted
      // so the cache doesn't grow forever. Only touches files older than
      // the safety window to avoid racing an active download.
      this._gcTorrentCache();
    } catch (err) {
      console.error('[Library] Async init failed:', err);
    }
  }

  /**
   * Probe the GPU worker's /health endpoint and stash the result. Called
   * once at startup and then every 30s by _startWorkerHealthProbe(). Logs
   * transitions (offline ↔ online) so the operator can see what's going on.
   */
  async _refreshWorkerHealth() {
    if (!this._workerClient.enabled()) return;
    const prev = this._workerHealth;
    const next = await this._workerClient.checkHealth();
    this._workerHealth = next;
    if (!prev && next) {
      console.log(`[Library] GPU worker reachable: ${next.encoder} preset=${next.preset} cq=${next.cq} maxWidth=${next.maxWidth}${next.gpu ? ` (${next.gpu})` : ''}`);
    } else if (prev && !next) {
      console.warn('[Library] GPU worker became unreachable — falling back to local libx264 for new conversions');
    }
  }

  _startWorkerHealthProbe() {
    if (this._workerHealthTimer) return;
    // 30s cadence is enough — the only thing this gates is whether new
    // conversions go remote or local, and we always re-probe right before
    // dispatching anyway.
    this._workerHealthTimer = setInterval(() => {
      this._refreshWorkerHealth().catch(() => {});
    }, 30000);
    if (this._workerHealthTimer.unref) this._workerHealthTimer.unref();
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

        // Skip the persistent torrent-metadata cache directory at the root.
        if (!relDir && entry.name === this._torrentCacheName) {
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
    const {
      imdbId, type, name, poster, year, magnetUri, infoHash, quality, size, season, episode,
      // Music-only fields (ignored for movies/series):
      mbid, artistMbid, artist, title, coverUrl, genres,
    } = opts;

    if (!infoHash || !magnetUri) {
      throw new Error('infoHash and magnetUri are required');
    }

    const isMusic = type === 'album' || type === 'artist';

    // Generate a unique ID
    const idPrefix = imdbId || (isMusic && mbid ? `mb_${mbid.slice(0, 8)}` : 'manual');
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
      name: name || title || 'Unknown',
      poster: poster || coverUrl || '',
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
      // Music-only fields populated for type: 'album' / 'artist'.
      ...(isMusic ? {
        mbid: mbid || null,
        artistMbid: artistMbid || null,
        artist: artist || '',
        title: title || name || 'Unknown',
        coverUrl: coverUrl || poster || '',
        genres: Array.isArray(genres) ? genres : [],
        manualOverride: {},
        tracks: [],
        playCount: 0,
        lastPlayedAt: null,
        favorite: false,
      } : {}),
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

    const cacheHit = this._hasCachedTorrentMetadata(infoHash);
    return new Promise((resolve, reject) => {
      const engine = torrentStream(magnetUri, this._baseTorrentOpts(packDir));
      this._pauseRunningConversionsForDownloads();
      this._attachPeerManager(engine, `pack ${infoHash.slice(0, 8)}`);
      this._startIncomingListener(engine, `pack ${infoHash.slice(0, 8)}`);
      if (cacheHit) {
        console.log(`[Library] pack ${infoHash.slice(0, 8)}: using cached torrent metadata (skipping BEP-9)`);
      }

      const tm = this._startMetadataTimeout(
        engine,
        `pack ${infoHash.slice(0, 8)}`,
        ({ diag, reason, totalMs }) => {
          const totalS = (totalMs / 1000) | 0;
          console.error(`[Library] pack ${infoHash.slice(0, 8)}: metadata timeout — ${diag} — ${reason}`);
          this._destroyEngine(engine);
          reject(new Error(`Torrent metadata timeout (${totalS}s) — ${diag} — ${reason}`));
        }
      );

      engine.on('error', (err) => {
        tm.clear();
        this._destroyEngine(engine);
        reject(err);
      });

      engine.on('ready', () => {
        tm.clear();

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

    const cacheHit = this._hasCachedTorrentMetadata(infoHash);
    return new Promise((resolve, reject) => {
      const engine = torrentStream(magnetUri, this._baseTorrentOpts(scanDir));
      this._pauseRunningConversionsForDownloads();
      this._attachPeerManager(engine, `scan ${infoHash.slice(0, 8)}`);
      this._startIncomingListener(engine, `scan ${infoHash.slice(0, 8)}`);
      if (cacheHit) {
        console.log(`[Library] scan ${infoHash.slice(0, 8)}: using cached torrent metadata (skipping BEP-9)`);
      }

      const tm = this._startMetadataTimeout(
        engine,
        `scan ${infoHash.slice(0, 8)}`,
        ({ diag, reason, totalMs }) => {
          const totalS = (totalMs / 1000) | 0;
          console.error(`[Library] scan ${infoHash.slice(0, 8)}: metadata timeout — ${diag} — ${reason}`);
          this._destroyEngine(engine);
          reject(new Error(`Torrent metadata timeout (${totalS}s) — ${diag} — ${reason}`));
        }
      );

      engine.on('error', (err) => {
        tm.clear();
        this._destroyEngine(engine);
        reject(err);
      });

      engine.on('ready', () => {
        tm.clear();

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
    // Try 1x05 pattern — anchor on word boundaries and bound episode digits
    // so raw resolutions like "1920x1080" don't falsely match as S1920E1080.
    const xMatch = base.match(/\b(\d{1,2})x(\d{1,3})\b/i);
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
    // Unified separator rule (same as _deriveMovieNameFromFile): collapse
    // dots/underscores when the filename is a scene-style name (no spaces)
    // or has 2+ of them used as word separators. This preserves titles like
    // "Mr. Smith - S01E05" instead of mangling them to "Mr  Smith".
    const hasSpace = /\s/.test(base);
    const dotCount = (base.match(/\./g) || []).length;
    const underCount = (base.match(/_/g) || []).length;
    if (!hasSpace || dotCount >= 2 || underCount >= 2) {
      base = base.replace(/[._]/g, ' ');
    }
    base = base.replace(/\s+/g, ' ').trim();

    // Try S01E05 pattern — show name is everything before it
    let match = base.match(/^(.+?)\s*S\d+\s*E\d+/i);
    if (match) return match[1].replace(/[-–\s]+$/, '').trim() || null;

    // Try 1x05 pattern (bounded so "1920x1080" resolutions don't match)
    match = base.match(/^(.+?)\s*\b\d{1,2}x\d{1,3}\b/i);
    if (match) return match[1].replace(/[-–\s]+$/, '').trim() || null;

    // Try "- 001" or "- 1" anime convention (e.g., "Naruto Shippuden - 001").
    // Accepts 1-4 digits; negative lookahead prevents matching year-like
    // numbers (1900-2099).
    match = base.match(/^(.+?)\s*[-–]\s*(?!(?:19|20)\d{2}\b)\d{1,4}\b/);
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
   * Returns true if the filename has an unambiguous episode marker
   * (S01E05, 1x05, "- 07", "Episode 5"). Used to decide whether to treat
   * a disk-discovered file as a series episode or a movie.
   */
  _looksLikeEpisode(fileName) {
    const base = path.basename(fileName, path.extname(fileName));
    if (/S\d+\s*E\d+/i.test(base)) return true;
    if (/\b\d{1,2}x\d{1,3}\b/i.test(base)) return true;
    if (/\bE\d{1,3}\b/i.test(base)) return true;
    if (/\bEpisode\s*\d+/i.test(base)) return true;
    // Anime " - 012" convention, rejecting year-like numbers
    if (/[-–]\s*(?!(?:19|20)\d{2}\b)\d{2,4}\b/.test(base)) return true;
    return false;
  }

  /**
   * Single entry-point file-name parser. Consolidates episode-name,
   * show-name, movie-name, and season/episode parsing into one result so
   * every caller — downloads, manual imports, disk discovery, auto-match —
   * sees consistent output.
   *
   * @param {string} fileName - basename or relative path
   * @param {object} opts
   * @param {'movie'|'series'|null} opts.hint - caller's best guess of type;
   *   informs the type heuristic when the filename alone is ambiguous
   * @param {number} opts.fallbackSeason - season to assume when the path
   *   contains no season indicator (default 1)
   * @returns {{
   *   fileName: string,
   *   isEpisode: boolean,
   *   type: 'movie'|'series',
   *   title: string|null,       // movie-style title (for movies or episodes)
   *   show: string|null,        // show name (for episodes)
   *   year: string|null,        // 4-digit YYYY
   *   season: number|null,
   *   episode: number|null,
   *   episodeName: string,      // cleaned pack-style episode display name
   *   query: string|null,       // best query string to send to TMDB
   * }}
   */
  parseFileName(fileName, { hint = null, fallbackSeason = 1 } = {}) {
    const base = path.basename(fileName);
    const isEpisode = this._looksLikeEpisode(base);
    const type = hint === 'movie' || hint === 'series'
      ? hint
      : (isEpisode ? 'series' : 'movie');

    const se = this._parseSeasonEpisode(fileName, fallbackSeason);
    const show = this._deriveShowNameFromFile(base);
    const episodeName = this._deriveEpisodeName(base);
    const movie = this._deriveMovieNameFromFile(base);

    // _parseSeasonEpisode always returns the fallback season (usually 1)
    // even when there's no episode marker — clear it for non-series items
    // so the UI doesn't render "S01" on a movie.
    const seasonOut = (type === 'series' && se.episode != null) ? se.season : (isEpisode ? se.season : null);

    const result = {
      fileName: base,
      isEpisode,
      type,
      title: movie.title,
      show,
      year: movie.year,
      season: seasonOut,
      episode: se.episode,
      episodeName,
      query: null,
    };

    // Pick the best TMDB search query: show name for series, movie title for
    // movies, episodeName as a last-resort fallback.
    if (type === 'series' && show) {
      result.query = show;
    } else if (type === 'movie' && movie.title) {
      result.query = movie.title;
    } else {
      result.query = show || movie.title || episodeName || null;
    }

    return result;
  }

  /**
   * Extract a movie title (and optional year) from a filename by stripping
   * quality/codec/source/group tags. When a 4-digit year (1900-2099) appears,
   * everything before it is the title and the year is captured as a hint.
   * e.g. "The.Matrix.1999.1080p.BluRay.x264-YIFY.mkv"
   *        -> { title: "The Matrix", year: "1999" }
   *      "Inception (2010) [1080p].mp4"
   *        -> { title: "Inception", year: "2010" }
   *      "Arrival.2160p.HDR.mkv"
   *        -> { title: "Arrival", year: null }
   * Returns { title: null, year: null } when nothing usable remains.
   */
  _deriveMovieNameFromFile(fileName) {
    let base = path.basename(fileName, path.extname(fileName));
    // Strip [group] tags
    base = base.replace(/\[[^\]]*\]/g, '');
    // Capture a year in parentheses, then drop the parens so later regex can match
    let year = null;
    const parenYear = base.match(/\((19\d{2}|20\d{2})\)/);
    if (parenYear) { year = parenYear[1]; base = base.replace(parenYear[0], ' '); }
    // If the base has NO spaces at all, dots/underscores are scene-name
    // separators — always replace them. Otherwise only replace when there
    // are 2+ of them, so a title like "Mr. Smith" stays intact.
    const hasSpace = /\s/.test(base);
    const dotCount = (base.match(/\./g) || []).length;
    const underCount = (base.match(/_/g) || []).length;
    if (!hasSpace || dotCount >= 2 || underCount >= 2) {
      base = base.replace(/[._]/g, ' ');
    }
    base = base.replace(/\s+/g, ' ').trim();

    // Strip known franchise prefixes that confuse the TMDB lookup when they
    // appear before the actual movie title. "James Bond 007 Octopussy 1983"
    // derives to { title: "James Bond 007 Octopussy" } under the default
    // rules, and the movie-lookup word-overlap guard then rejects TMDB's
    // correct "Octopussy" match (1/4 word overlap). Stripping the prefix
    // here yields the clean title before lookup runs.
    base = base.replace(/^(?:007\s+james\s+bond|james\s+bond\s+007|james\s+bond|007)\s+/i, '').trim();

    // Leading-year pattern: "YYYY - Title" or "YYYY Title" (Disney collection
    // packs use this form, e.g. "1959 - Sleeping Beauty.avi"). Must come
    // before the bareYear regex since the year is AT the start.
    const leadYear = base.match(/^(19\d{2}|20\d{2})\s*[-–]\s*(.+)$/);
    if (leadYear) {
      const title = leadYear[2].replace(/[-–.\s]+$/, '').trim();
      if (title && !/^(19|20)\d{2}$/.test(title)) {
        return { title, year: year || leadYear[1] };
      }
    }

    // If a bare year (1900-2099) is present, everything before it is the title
    const bareYear = base.match(/^(.+?)\s+(19\d{2}|20\d{2})\b/);
    if (bareYear) {
      if (!year) year = bareYear[2];
      const title = bareYear[1].replace(/[-–.\s]+$/, '').trim();
      if (title && !/^(19|20)\d{2}$/.test(title)) return { title, year };
    }

    // No year found — strip common quality/codec/source/release-group tags.
    // Trailing `.` is included in the trim so that filenames like
    // "1959.xvid" (cleaned to "1959.") normalize to "1959" and get caught
    // by the just-a-year guard below.
    const cleaned = base
      .replace(/\b(2160p|1080p|720p|480p|4k|uhd|hdr|dv|dolby\s*vision)\b.*/i, '')
      .replace(/\b(bluray|blu-ray|brrip|bdrip|webrip|web-dl|webdl|web|hdrip|dvdrip|dvd|hdtv|pdtv)\b.*/i, '')
      .replace(/\b(x264|x265|h264|h265|hevc|xvid|divx|av1|aac|ac3|dts|ddp5|flac|mp3|10bit)\b.*/i, '')
      .replace(/\b(yify|yts|rarbg|ettv|eztv|fgt|ntg|tgx|psa|galaxyrg)\b.*/i, '')
      .replace(/[-–.\s]+$/, '')
      .replace(/^[-–.\s]+/, '')
      .trim();

    // Guard: a "title" that's literally just a 4-digit year is a parser
    // failure (filename like "2002.1080p.BluRay.mkv") — returning "2002"
    // will collide with real movies on TMDB. Treat as unparseable.
    if (/^(19|20)\d{2}$/.test(cleaned)) {
      return { title: null, year: year || cleaned };
    }
    if (cleaned) return { title: cleaned, year };

    return { title: null, year };
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
      let anyJustCompleted = false;

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
          anyJustCompleted = true;
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

      // Persist on every episode transition so a power loss mid-pack doesn't
      // lose the "this episode is already done" fact — the startup sweep can
      // recover the file from disk, but surfacing it correctly in the UI
      // during the gap between completion and the next periodic save matters.
      // Skipped when allComplete is about to save anyway.
      if (anyJustCompleted && !allComplete) {
        this._saveMetadata();
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

    // Same reasoning as _stopDownload: downloads may have just ended, so
    // poke the conversion queue in case a pending transcode was waiting
    // for all engines to clear.
    this._processConversionQueue();

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

    const cacheHit = this._hasCachedTorrentMetadata(first.infoHash);
    console.log(`[Library] Resuming pack "${first.showName || first.name}" (${items.length} episodes) in ${packDir}${cacheHit ? ' — cached metadata available' : ' — no cached metadata'}`);

    const engine = torrentStream(first.magnetUri, this._baseTorrentOpts(packDir));
    this._pauseRunningConversionsForDownloads();
    this._attachPeerManager(engine, `resume ${first.infoHash.slice(0, 8)}`);
    this._startIncomingListener(engine, `resume ${first.infoHash.slice(0, 8)}`);

    // Store engine immediately to prevent retryItem from creating duplicates
    // (engine is usable before 'ready' — it just won't have files yet)
    this._engines.set(packId, engine);

    const tm = this._startMetadataTimeout(
      engine,
      `resume ${first.infoHash.slice(0, 8)}`,
      ({ diag, reason, totalMs }) => {
        const totalS = (totalMs / 1000) | 0;
        console.error(`[Library] resume ${first.infoHash.slice(0, 8)}: metadata timeout — ${diag} — ${reason}`);
        // Fail ALL downloading items for this pack, not just the ones passed in
        for (const [, item] of this._items) {
          if (item.packId === packId && item.status === 'downloading') {
            item.status = 'failed';
            item.error = `Torrent metadata timeout on resume (${totalS}s) — ${diag} — ${reason}`;
          }
        }
        this._destroyEngine(engine);
        this._engines.delete(packId);
        this._saveMetadata();
        this._processQueue();
      }
    );

    engine.on('error', (err) => {
      tm.clear();
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
      tm.clear();

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
   *
   * @param {string} id
   * @param {object} updates
   * @param {'manual'|'auto'} source - whether this was a user-driven link
   *   (locks the item against future auto-match overwrites) or an automated
   *   match (can still be overridden by user or a higher-confidence pass)
   */
  relinkItem(id, { imdbId, name, poster, year, type, showName }, source = 'manual') {
    const item = this._items.get(id);
    if (!item) return false;

    if (imdbId) item.imdbId = imdbId;
    if (name) item.name = name;
    if (showName) item.showName = showName;
    if (poster !== undefined) item.poster = poster;
    if (year !== undefined) item.year = year;
    if (type) item.type = type;

    item.matchState = source === 'manual' ? 'manual' : 'matched';
    item.matchSource = source;
    item.matchedAt = Date.now();
    // Clear cached candidates — they're stale after a successful link.
    delete item.candidates;
    delete item.candidatesTs;

    this._saveMetadata();
    console.log(`[Library] ${source === 'manual' ? 'User-linked' : 'Auto-matched'} "${item.name}" (${id}) -> ${imdbId}`);
    return true;
  }

  /**
   * Store auto-match candidates (top N TMDB results) on an item so the UI
   * can render them as one-click options without re-hitting the TMDB API.
   */
  setCandidates(id, candidates, confidence = 0) {
    const item = this._items.get(id);
    if (!item) return false;
    item.candidates = Array.isArray(candidates) ? candidates.slice(0, 5) : [];
    item.candidatesTs = Date.now();
    item.matchConfidence = confidence;
    // Only downgrade state if not already user-linked.
    if (item.matchState !== 'manual') {
      item.matchState = 'needsReview';
    }
    this._saveMetadata();
    return true;
  }

  /**
   * Promote a disk-discovered item (id starts with "disk_") into a real
   * tracked library item. Disk items are otherwise ephemeral — synthesized
   * fresh on every getAll() call from the filesystem scan — so they can't
   * hold match state or candidates on their own. Any caller that needs to
   * write to a disk item (relink, auto-match) should promote it first.
   *
   * Returns the promoted item's id (unchanged) or null if the disk file
   * has disappeared.
   */
  promoteDiskItem(id) {
    if (!id.startsWith('disk_')) return null;
    if (this._items.has(id)) return id; // already promoted

    const relPath = id.slice(5);
    const fullPath = path.join(this._libraryPath, relPath);
    if (!this._isPathSafe(fullPath)) return null;
    let stat;
    try {
      if (!fs.existsSync(fullPath)) return null;
      stat = fs.statSync(fullPath);
    } catch {
      return null;
    }

    const fileName = path.basename(relPath);
    const parsed = this.parseFileName(fileName);
    const displayName = parsed.type === 'series'
      ? (parsed.show || parsed.episodeName || fileName)
      : (parsed.title || parsed.episodeName || fileName);

    const item = {
      id,
      imdbId: null,
      type: parsed.type,
      name: displayName,
      showName: parsed.type === 'series' ? parsed.show : null,
      poster: '',
      year: parsed.year || '',
      quality: '',
      size: '',
      season: parsed.season,
      episode: parsed.episode,
      infoHash: null,
      magnetUri: null,
      status: 'complete',
      progress: 100,
      downloadSpeed: 0,
      numPeers: 0,
      filePath: relPath,
      fileName,
      fileSize: stat.size,
      addedAt: stat.mtimeMs,
      completedAt: stat.mtimeMs,
      error: null,
      matchState: 'unmatched',
      matchConfidence: 0,
      parsed,
    };
    this._items.set(id, item);
    // Force a fresh discovery scan so the now-tracked item drops off the
    // virtual list.
    this._discoveryCache = null;
    this._saveMetadata();
    return id;
  }

  /**
   * Compute the current match state for an item. Items become 'matched'
   * as soon as a valid IMDB id is present (unless the user marked it manual).
   */
  _computeMatchState(item) {
    if (item.matchState === 'manual') return 'manual';
    if (item.matchState === 'needsReview') return 'needsReview';
    if (item.imdbId && /^tt\d+$/.test(item.imdbId)) return 'matched';
    return 'unmatched';
  }

  /**
   * Return every item whose match is not confirmed. Includes both tracked
   * items with a stale/missing IMDB id AND disk-discovered files that have
   * never been matched.
   */
  getReviewQueue() {
    const all = this.getAll();
    return all.filter(i => {
      const state = i.matchState || this._computeMatchState(i);
      return state === 'needsReview' || state === 'unmatched';
    });
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

  // For music albums: resolve a specific track's on-disk path.
  // trackIndex is 0-based into item.tracks[].
  getTrackFilePath(id, trackIndex) {
    const item = this._items.get(id);
    if (!item || item.type !== 'album' || !Array.isArray(item.tracks)) return null;
    if (!Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex >= item.tracks.length) return null;
    const track = item.tracks[trackIndex];
    if (!track || !track.file) return null;
    if (!item.filePath) return null;
    const fullPath = path.join(this._libraryPath, item.filePath, track.file);
    if (!this._isPathSafe(fullPath)) return null;
    if (!fs.existsSync(fullPath)) return null;
    return fullPath;
  }

  // ─── Music-specific helpers ─────────────────────

  setMusicGenre(id, genre) {
    const item = this._items.get(id);
    if (!item || item.type !== 'album') return false;
    if (!item.manualOverride) item.manualOverride = {};
    item.manualOverride.genre = (genre || '').trim();
    item.updatedAt = Date.now();
    this._saveMetadata();
    return true;
  }

  toggleMusicFavorite(id) {
    const item = this._items.get(id);
    if (!item || (item.type !== 'album' && item.type !== 'artist')) return null;
    item.favorite = !item.favorite;
    item.updatedAt = Date.now();
    this._saveMetadata();
    return item.favorite;
  }

  markMusicPlayed(id) {
    const item = this._items.get(id);
    if (!item || item.type !== 'album') return false;
    item.playCount = (item.playCount || 0) + 1;
    item.lastPlayedAt = Date.now();
    // Don't call _saveMetadata on every play — it's a hot path. Defer to
    // the existing periodic save (every 30s) to batch these updates.
    return true;
  }

  // Group album items by effective genre. Manual override wins; otherwise
  // the first MusicBrainz tag. Returns a map of genre -> [albumId, ...].
  getMusicGenres() {
    const out = {};
    for (const item of this._items.values()) {
      if (item.type !== 'album') continue;
      const manual = item.manualOverride && item.manualOverride.genre;
      const genre = (manual || (item.genres && item.genres[0]) || '').toString().toLowerCase().trim();
      if (!genre) continue;
      if (!out[genre]) out[genre] = [];
      out[genre].push(item.id);
    }
    return out;
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

  /**
   * Lifetime conversion success/failure counters since process start.
   * Resets on restart. Exposed so operators can see systemic issues
   * (consistently-failing worker, every HEVC source erroring, etc.).
   */
  getConversionStats() {
    const s = this._convertStats;
    const { local, remote } = this._countActiveConversions();
    const pending = [...this._items.values()].filter(i => i._pendingConversion).length;
    return {
      ...s,
      uptimeSec: Math.round((Date.now() - s.startedAt) / 1000),
      active: { local, remote },
      pending,
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

    const cacheHit = this._hasCachedTorrentMetadata(item.infoHash);
    const engine = torrentStream(item.magnetUri, this._baseTorrentOpts(itemDir));
    this._pauseRunningConversionsForDownloads();
    this._attachPeerManager(engine, `dl ${item.infoHash.slice(0, 8)}`);
    this._startIncomingListener(engine, `dl ${item.infoHash.slice(0, 8)}`);
    if (cacheHit) {
      console.log(`[Library] dl ${item.infoHash.slice(0, 8)}: using cached torrent metadata (skipping BEP-9)`);
    }

    this._engines.set(id, engine);
    this._startPeriodicSave();

    const tm = this._startMetadataTimeout(
      engine,
      `dl ${item.infoHash.slice(0, 8)}`,
      ({ diag, reason, totalMs }) => {
        if (item.status === 'downloading' && !item.filePath) {
          const totalS = (totalMs / 1000) | 0;
          console.error(`[Library] Metadata timeout for "${item.name}" — ${diag} — ${reason}`);
          item.status = 'failed';
          item.error = `Torrent metadata timeout (${totalS}s) — ${diag} — ${reason}`;
          this._stopDownload(id);
          this._saveMetadata();
          this._processQueue();
        }
      }
    );

    engine.on('ready', async () => {
      tm.clear();

      // Music album branch: audio torrents contain multiple tracks rather
      // than one dominant video file. Select every safe audio file and
      // watch them collectively for completion.
      if (item.type === 'album') {
        return this._startMusicAlbumFromEngine(id, engine, itemDir);
      }

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

      // Disk-space preflight: refuse to start downloading a file we can't
      // fit. Runs here (not in _startDownload) because we only know the
      // file size after torrent metadata arrives.
      const space = await this._checkFreeSpace(file.length, `download "${item.name}"`);
      if (!space.ok) {
        console.error(`[Library] ${space.reason}`);
        item.status = 'failed';
        item.error = space.reason;
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
      tm.clear();
      console.error(`[Library] Download error for "${item.name}": ${err.message}`);
      item.status = 'failed';
      item.error = err.message;
      this._stopDownload(id);
      this._saveMetadata();
      this._processQueue();
    });
  }

  // Music album variant of the post-ready download branch. Selects every
  // safe audio file in the torrent, tracks collective completion, then
  // scans the item folder to build tracks[] metadata when done. Skips the
  // video codec/remux/worker-transcode pipeline entirely.
  async _startMusicAlbumFromEngine(id, engine, itemDir) {
    const item = this._items.get(id);
    if (!item) { this._destroyEngine(engine); return; }

    const audioFiles = engine.files.filter(f => isFileNameSafe(f.name, 'audio'));
    if (!audioFiles.length) {
      item.status = 'failed';
      item.error = 'No audio files found in torrent';
      this._stopDownload(id);
      this._saveMetadata();
      this._processQueue();
      return;
    }

    const totalBytes = audioFiles.reduce((n, f) => n + (f.length || 0), 0);
    const space = await this._checkFreeSpace(totalBytes, `music "${item.name}"`);
    if (!space.ok) {
      console.error(`[Library] ${space.reason}`);
      item.status = 'failed';
      item.error = space.reason;
      this._stopDownload(id);
      this._saveMetadata();
      this._processQueue();
      return;
    }

    for (const f of engine.files) {
      if (audioFiles.includes(f)) f.select();
      else f.deselect();
    }

    // Sort by filename so track ordering reflects the usual "01 - …, 02 - …"
    // naming convention torrents use. Fall back to natural locale order.
    audioFiles.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true }));

    // itemDir is the folder torrent-stream writes to.
    const itemDirRel = path.relative(this._libraryPath, itemDir);
    item.filePath = itemDirRel; // Pointing at the directory, not a single file.
    item.fileName = path.basename(audioFiles[0].name);
    item.fileSize = totalBytes;
    item.tracks = audioFiles.map((f, i) => ({
      position: i + 1,
      file: f.path,
      title: this._prettifyTrackName(path.basename(f.name)),
      duration: null,
      fileSize: f.length,
    }));
    this._saveMetadata();

    console.log(`[Library] Downloading album "${item.name}": ${audioFiles.length} tracks, ${(totalBytes / 1e6).toFixed(0)}MB`);

    const progressTimer = setInterval(() => {
      if (!this._engines.has(id)) {
        clearInterval(progressTimer);
        return;
      }
      const sw = engine.swarm;
      item.downloadSpeed = sw ? sw.downloadSpeed() : 0;
      item.numPeers = sw ? sw.wires.length : 0;

      let completedBytes = 0;
      let allComplete = true;
      for (const f of audioFiles) {
        const { progressPct, isComplete } = computeFileProgress(engine, f);
        completedBytes += (f.length || 0) * (progressPct / 100);
        if (!isComplete) allComplete = false;
      }
      item.progress = totalBytes > 0 ? Math.min(100, Math.round((completedBytes / totalBytes) * 100)) : 0;

      if (allComplete) {
        // Re-map tracks[] indices to match engine.files indices so /stream?fileIdx
        // on a served torrent (or on a library path) resolves reliably.
        item.tracks = audioFiles.map((f, i) => ({
          position: i + 1,
          file: f.path,
          title: this._prettifyTrackName(path.basename(f.name)),
          duration: null,
          fileSize: f.length,
        }));
        item.status = 'complete';
        item.completedAt = Date.now();
        item.downloadSpeed = 0;
        console.log(`[Library] Music album complete: "${item.name}" (${audioFiles.length} tracks)`);
        this._stopDownload(id);
        this._saveMetadata();
        this._processQueue();
      }
    }, PROGRESS_POLL_INTERVAL);

    this._progressTimers.set(id, progressTimer);
  }

  // "01 - Everything In Its Right Place.mp3" → "Everything In Its Right Place"
  _prettifyTrackName(filename) {
    const base = filename.replace(/\.[a-z0-9]+$/i, '');
    return base
      .replace(/^\s*\d+\s*[-._)]\s*/, '')
      .replace(/[_]+/g, ' ')
      .trim();
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

    // Downloads just ended. If there are pending conversions waiting on us,
    // _processConversionQueue will no-op if any OTHER download is still
    // running (via _hasActiveDownloads) or kick off the next transcode if
    // we were the last one. Must be called AFTER the engine is removed
    // from _engines so _hasActiveDownloads sees the updated state.
    this._processConversionQueue();

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
   * Build a diagnostic string describing why metadata fetch timed out.
   * Called from every 90s timeout site so the error surfaced to the user /
   * logs tells them whether the torrent is dead, the swarm is unreachable,
   * or the handshake is failing — three very different problems that look
   * identical under the old "metadata timeout" message.
   *
   * Returns { diag, reason } where diag is compact counters and reason is
   * a human-readable hypothesis.
   */
  _metadataTimeoutDiag(engine) {
    const sw = engine && engine.swarm;
    const wires = sw && sw.wires ? sw.wires.length : 0;
    const mgr = this._peerMgrByEngine.get(engine);
    const stats = mgr ? mgr.stats() : { watching: 0, bannedIps: 0 };
    const watching = stats.watching;
    const banned = stats.bannedIps;
    const diag = `wires=${wires} watching=${watching} banned=${banned}`;
    let reason;
    if (watching === 0 && wires === 0) {
      reason = 'no peers discovered (trackers/DHT returned nothing)';
    } else if (wires === 0) {
      reason = `${watching} peers discovered but none completed BT handshake — possible MSE/PE encryption mismatch, firewall on outbound BT, or all-IPv6 swarm (torrent-stream is v4-only)`;
    } else {
      reason = `${wires} wires handshook but metadata (ut_metadata / BEP-9) never arrived`;
    }
    return { diag, reason };
  }

  /**
   * Adaptive metadata-fetch deadline.
   *
   * Replaces the old hard `setTimeout(..., 90000)` pattern that killed any
   * download whose BEP-9 info-dict took longer than 90s to trickle in. On
   * season packs the info dict is large (hundreds of files × piece hashes)
   * and is served 16 KiB at a time from only those peers that actually
   * respond to ut_metadata — handshakes complete fine, but the full dict
   * can take 2-3 minutes even on a healthy swarm. That pattern was the
   * dominant cause of "failed" packs: the diag showed wires>0 the entire
   * time, i.e. peers were talking to us, we just weren't patient enough.
   *
   * Strategy: after `initialMs` with no 'ready' event, check swarm state.
   *   - If there are zero wires, fail immediately (nothing is going to
   *     change — the swarm is dead or unreachable).
   *   - If wires > 0, grant another `extensionMs` and re-check, up to a
   *     hard cap of `maxMs` from the original start.
   *
   * Returns a handle with `clear()` so the caller cancels the deadline on
   * 'ready' / 'error'. `onTimeout` is fired with `{ diag, reason, totalMs }`
   * when the deadline finally expires.
   */
  _startMetadataTimeout(engine, label, onTimeout, opts = {}) {
    const initialMs = opts.initialMs != null ? opts.initialMs : 90000;
    const extensionMs = opts.extensionMs != null ? opts.extensionMs : 60000;
    const maxMs = opts.maxMs != null ? opts.maxMs : 300000;
    const startedAt = Date.now();
    let timer = null;
    let cleared = false;

    const tick = () => {
      if (cleared) return;
      const elapsed = Date.now() - startedAt;
      const sw = engine && engine.swarm;
      const wires = sw && sw.wires ? sw.wires.length : 0;
      const { diag, reason } = this._metadataTimeoutDiag(engine);

      // Wires > 0 means peers have completed the BT handshake and we're
      // inside the "metadata is plausibly in flight" regime — extend the
      // deadline up to the hard cap rather than killing a download that's
      // probably making real progress. Wires == 0 is a dead swarm; no
      // amount of waiting will produce metadata, so bail immediately.
      if (wires > 0 && elapsed + extensionMs <= maxMs) {
        console.log(
          `[Library] ${label}: metadata still pending after ${(elapsed / 1000) | 0}s — ${diag} — extending +${(extensionMs / 1000) | 0}s (handshakes active)`
        );
        timer = setTimeout(tick, extensionMs);
        return;
      }

      cleared = true;
      timer = null;
      onTimeout({ diag, reason, totalMs: elapsed });
    };

    timer = setTimeout(tick, initialMs);
    return {
      clear() {
        cleared = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      },
    };
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

  // ─── Torrent metadata cache ────────────────────

  /**
   * Default torrent-stream options used by every engine this manager
   * spins up. The `tmp`/`name` fields redirect torrent-stream's built-in
   * .torrent metadata cache from the ephemeral /tmp/torrent-stream
   * directory to `<libraryPath>/_torrent-cache/<infoHash>.torrent`, which
   * lives alongside the library volume and therefore survives container
   * restarts. Once the cache is populated for a given infoHash, restart /
   * retry / click-pack-in-library loads metadata instantly instead of
   * rolling the BEP-9 dice against slow peers.
   */
  _baseTorrentOpts(downloadPath) {
    // See torrent-engine.js for rationale on connections/uploads values.
    return {
      connections: 50,
      uploads: 4,
      dht: true,
      verify: true,
      path: downloadPath,
      trackers: TRACKERS,
      tmp: this._libraryPath,
      name: this._torrentCacheName,
    };
  }

  /**
   * Returns true if torrent-stream already has cached metadata for this
   * infoHash in our persistent cache. When true, the next engine start
   * for this torrent will skip peer metadata exchange entirely.
   */
  _hasCachedTorrentMetadata(infoHash) {
    if (!infoHash) return false;
    try {
      return fs.existsSync(path.join(this._torrentCachePath, `${infoHash}.torrent`));
    } catch {
      return false;
    }
  }

  /**
   * On first run after this fix lands, /tmp/torrent-stream may still hold
   * the cached .torrent files from the previous process (if the box
   * hasn't been rebooted yet). Copy any such files into our persistent
   * cache so the very next restart benefits, not just the one after it.
   */
  /**
   * Remove .torrent metadata files from the persistent cache that no
   * tracked library item references any more. Preserves files younger
   * than 24h so a torrent added moments before this call isn't wiped
   * before its engine has a chance to use the cache.
   */
  _gcTorrentCache() {
    try {
      const referenced = new Set();
      for (const it of this._items.values()) {
        if (it.infoHash) referenced.add(String(it.infoHash).toLowerCase());
      }
      const now = Date.now();
      const MIN_AGE_MS = 24 * 60 * 60 * 1000;
      let removed = 0;
      let freedBytes = 0;
      for (const name of fs.readdirSync(this._torrentCachePath)) {
        if (!name.endsWith('.torrent')) continue;
        const infoHash = name.slice(0, -'.torrent'.length).toLowerCase();
        if (referenced.has(infoHash)) continue;
        const p = path.join(this._torrentCachePath, name);
        try {
          const st = fs.statSync(p);
          if (now - st.mtimeMs < MIN_AGE_MS) continue;
          fs.unlinkSync(p);
          removed++;
          freedBytes += st.size;
        } catch { /* ignore */ }
      }
      if (removed > 0) {
        console.log(`[Library] GC: removed ${removed} orphaned torrent metadata file(s) (${(freedBytes / 1024).toFixed(1)} KB)`);
      }
    } catch { /* non-fatal */ }
  }

  _migrateLegacyTorrentCache() {
    try {
      const legacy = path.join('/tmp', 'torrent-stream');
      if (!fs.existsSync(legacy)) return;
      let migrated = 0;
      for (const entry of fs.readdirSync(legacy)) {
        if (!entry.endsWith('.torrent')) continue;
        const src = path.join(legacy, entry);
        const dst = path.join(this._torrentCachePath, entry);
        if (fs.existsSync(dst)) continue;
        try {
          fs.copyFileSync(src, dst);
          migrated++;
        } catch { /* non-fatal — skip unreadable entry */ }
      }
      if (migrated > 0) {
        console.log(`[Library] Migrated ${migrated} torrent metadata cache file(s) from ${legacy}`);
      }
    } catch { /* non-fatal */ }
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
      this._stashProbeForConversion(item, probe);

      console.log(`[Library] Resuming ${kind}: "${item.name}"`);
      // Go through _checkAndConvert so the concurrency cap is honoured —
      // 10 interrupted conversions should NOT spawn 10 ffmpeg at once.
      // Also defer to the queue when downloads are active and the remote
      // worker isn't online; _processConversionQueue picks up pending
      // items as soon as either condition flips.
      if (this._convertProcesses.size >= this._maxConcurrentConversions || !this._canStartConversionNow()) {
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

  /**
   * Check that at least `requiredBytes + reserve` are free on the library
   * filesystem. Returns { ok, freeBytes, neededBytes, reason? }. When
   * statfs is unavailable (rare — unsupported FS, older kernel) returns
   * `{ ok: true, unknown: true }` so we fail open rather than block every
   * download on a diagnostic gap.
   */
  async _checkFreeSpace(requiredBytes, label) {
    try {
      const s = await fs.promises.statfs(this._libraryPath);
      const freeBytes = Number(s.bavail) * Number(s.bsize);
      const neededBytes = Math.max(0, Number(requiredBytes) || 0) + this._diskReserveBytes;
      if (freeBytes < neededBytes) {
        return {
          ok: false,
          freeBytes,
          neededBytes,
          reason: `Insufficient disk space for ${label}: need ${(neededBytes / 1e9).toFixed(2)} GB (incl. ${(this._diskReserveBytes / 1e9).toFixed(2)} GB reserve), have ${(freeBytes / 1e9).toFixed(2)} GB free`,
        };
      }
      return { ok: true, freeBytes, neededBytes };
    } catch (err) {
      console.warn(`[Library] Disk-space check failed (${this._libraryPath}): ${err.message} — proceeding without check`);
      return { ok: true, unknown: true };
    }
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
          _probeVideoCodec,
          _probeAudioCodec,
          _probeAudioProfile,
          _probeAudioChannels,
          _probeAudioSampleRate,
          _probeHasAudio,
          _workerFailed,
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

      // Atomic + durable write: write to temp file, fsync contents to disk,
      // then rename. Without fsync a power loss between writeFileSync and
      // rename can leave the tmp file with zero bytes — the rename then
      // publishes an empty metadata.json even though `renameSync` itself is
      // atomic. fsync-then-rename is the classic POSIX pattern for durable
      // small-file updates.
      const fd = fs.openSync(tmpFile, 'w');
      try {
        fs.writeSync(fd, json, 0, 'utf8');
        try { fs.fsyncSync(fd); } catch { /* fsync unsupported on some FS */ }
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpFile, this._metadataFile);
      // Also fsync the parent directory so the rename itself survives power
      // loss. Opening a directory for fsync is a no-op on Windows (EISDIR);
      // swallow the error there — NTFS metadata ops are already journaled.
      try {
        const dirFd = fs.openSync(path.dirname(this._metadataFile), 'r');
        try { fs.fsyncSync(dirFd); } catch { /* ignore */ }
        finally { fs.closeSync(dirFd); }
      } catch { /* ignore */ }
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
        .map(i => path.normalize(i.filePath))
    );

    // Files smaller than this are almost always samples/trailers/featurettes
    // shipped alongside the real content. Skipping them stops the review
    // queue from being drowned in noise on the first scan of a big library.
    const MIN_VIDEO_SIZE = 50 * 1024 * 1024;
    const MAX_DEPTH = 6;
    const MAX_DISCOVERED = 5000;

    const buildItem = (relPath, stat) => {
      const fileName = path.basename(relPath);
      const dirName  = path.dirname(relPath);
      // Prefer the inner-file parse (has codec/quality hints), but fall back
      // to the enclosing directory name for torrents that store the real
      // title on the folder and a generic "video.mkv" inside.
      const innerParsed = this.parseFileName(fileName);
      const needsDirFallback = !innerParsed.title && !innerParsed.show;
      const dirHint = dirName && dirName !== '.' ? path.basename(dirName) : null;
      const parsed = needsDirFallback && dirHint ? this.parseFileName(dirHint) : innerParsed;
      const displayName = parsed.type === 'series'
        ? (parsed.show || parsed.episodeName || fileName)
        : (parsed.title || parsed.episodeName || fileName);
      return {
        id: 'disk_' + relPath,
        name: displayName,
        showName: parsed.type === 'series' ? parsed.show : null,
        type: parsed.type,
        year: parsed.year || '',
        season: parsed.season,
        episode: parsed.episode,
        status: 'complete',
        filePath: relPath,
        fileName,
        fileSize: stat.size,
        addedAt: stat.mtimeMs,
        matchState: 'unmatched',
        matchConfidence: 0,
        parsed,
        imdbId: null,
      };
    };

    const walk = (absDir, relDir, depth) => {
      if (discovered.length >= MAX_DISCOVERED) return;
      if (depth > MAX_DEPTH) return;

      let entries;
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch (err) {
        if (depth === 0) console.error(`[Library] Disk scan error: ${err.message}`);
        return;
      }

      for (const entry of entries) {
        if (discovered.length >= MAX_DISCOVERED) return;

        // Skip internal bookkeeping at the library root.
        if (depth === 0) {
          if (entry.name.startsWith('_metadata')) continue;
          if (entry.name === this._torrentCacheName) continue;
        }
        if (entry.name.endsWith('.tmp')) continue;
        if (entry.name.startsWith('.')) continue; // hidden / .Trash / .DS_Store

        const absPath = path.join(absDir, entry.name);
        const relPath = relDir ? path.join(relDir, entry.name) : entry.name;

        if (entry.isDirectory()) {
          walk(absPath, relPath, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;

        const ext = path.extname(entry.name).toLowerCase();
        if (!VIDEO_EXTENSIONS.has(ext)) continue;

        const normRel = path.normalize(relPath);
        if (trackedPaths.has(normRel)) continue;
        // Also match legacy tracked entries that stored just a basename.
        if (trackedPaths.has(entry.name)) continue;

        let stat;
        try { stat = fs.statSync(absPath); }
        catch { continue; }
        if (stat.size < MIN_VIDEO_SIZE) continue;

        discovered.push(buildItem(relPath, stat));
      }
    };

    walk(this._libraryPath, '', 0);

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
   *
   * Runs up to three tiers of ffprobe, escalating only if the previous
   * tier failed. Empirically this rescues ~80% of the files that used
   * to log as "ffprobe failed" — the default ffprobe settings bail too
   * eagerly on sparse streams, tail-resident moov atoms, and minor
   * bitstream corruption from interrupted copies.
   *
   *   Tier 1: fast default — what ffprobe does out of the box.
   *   Tier 2: deep scan (-analyzeduration 100M -probesize 100M). Helps
   *           files with long silent leaders, sparse streams, or an MP4
   *           moov that lives tens of megabytes into the file.
   *   Tier 3: tolerant bitstream (-err_detect ignore_err +
   *           -fflags +genpts+igndts+discardcorrupt). Skips bad packets
   *           instead of aborting on the first CRC / NAL size mismatch,
   *           which rescues the "truncated during copy" class.
   *
   * Only successful probes are cached so a transient tier-3 rescue
   * doesn't pin a broken result if the file is later repaired. The
   * caller sees the most informative stderr line as `reason` (moov not
   * found, NAL size mismatch, truncated header, etc.) instead of the
   * old opaque "ffprobe failed".
   */
  async _probeFile(filePath) {
    // Cache key includes mtime+size so any rewrite (conversion, remux,
    // re-download) automatically invalidates the entry. If stat fails
    // we let ffprobe produce its own canonical error path below.
    let cacheKey = null;
    try {
      const st = fs.statSync(filePath);
      cacheKey = `${filePath}\u0000${st.mtimeMs}\u0000${st.size}`;
      const cached = _probeCacheGet(cacheKey);
      if (cached) return cached;
    } catch { /* stat failed — let ffprobe report it */ }

    // Escalation ladder. Each tier strictly supersets the previous in
    // tolerance, so if tier N rejects a file, tier N+1 is worth trying.
    const tiers = [
      [],
      ['-analyzeduration', '100M', '-probesize', '100M'],
      [
        '-analyzeduration', '100M',
        '-probesize',       '100M',
        '-err_detect',      'ignore_err',
        '-fflags',          '+genpts+igndts+discardcorrupt',
      ],
    ];

    let result;
    for (let i = 0; i < tiers.length; i++) {
      result = await this._runFfprobeOnce(filePath, tiers[i]);
      if (result.probeOk) break;
      // Permanent env failure — no amount of flag juggling will fix a
      // missing binary, so short-circuit the remaining tiers.
      if (result.reason === 'ffprobe not available') break;
    }

    // Failure paths are intentionally NOT cached — they're either
    // transient (still downloading) or environmental, and the caller
    // needs to see a fresh diagnosis on the next sweep.
    if (result && result.probeOk && cacheKey) _probeCacheSet(cacheKey, result);
    return result;
  }

  /**
   * Single ffprobe invocation with an optional list of extra input
   * flags. Used by _probeFile() to escalate from fast → permissive
   * probing. Returns the same shape as _probeFile() — probeOk true on
   * success, or probeOk false with a `reason` drawn from ffprobe's
   * stderr so the caller can see exactly why the file failed.
   */
  _runFfprobeOnce(filePath, extraArgs) {
    return new Promise((resolve) => {
      const ext = path.extname(filePath).toLowerCase();
      // -v error (not quiet) so we can surface the actual failure
      // reason. Without this every failure collapses into an opaque
      // "ffprobe failed" and we can't tell moov-not-found from a
      // truncated NAL from a sparse stream.
      const ffprobe = spawn('ffprobe', [
        '-v', 'error',
        ...extraArgs,
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath,
      ]);

      let output = '';
      let stderr = '';
      ffprobe.stdout.on('data', (d) => { output += d.toString(); });
      ffprobe.stderr.on('data', (d) => { stderr += d.toString(); });

      ffprobe.on('close', (code) => {
        const lastErrLine = stderr.trim().split('\n').pop() || '';
        if (code !== 0) {
          return resolve({
            probeOk: false,
            ext,
            reason: lastErrLine || 'ffprobe failed',
          });
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
          // Audio profile / channel layout / sample rate let us decide
          // whether the source audio is already universal enough to
          // stream-copy through the conversion (skip the AAC re-encode).
          // Browsers reliably play AAC LC stereo (or mono) at ≤48 kHz; HE-AAC,
          // 5.1 layouts, and high sample rates can confuse the mp4 audio
          // pipeline so we still re-encode those.
          const audioProfile = audioStream ? (audioStream.profile || null) : null;
          const audioChannels = audioStream && audioStream.channels != null
            ? parseInt(audioStream.channels, 10)
            : null;
          const audioSampleRate = audioStream && audioStream.sample_rate != null
            ? parseInt(audioStream.sample_rate, 10)
            : null;
          const container = info.format ? info.format.format_name : null;
          const duration = info.format && info.format.duration != null
            ? parseFloat(info.format.duration)
            : null;

          // Empty / broken probe — ffprobe succeeded but found no streams.
          // Usually means the file is still downloading or truncated on disk.
          // Still non-ok so the caller can escalate to the next tier; a
          // larger probesize occasionally surfaces streams tier 1 missed.
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
            audioProfile,
            audioChannels,
            audioSampleRate,
            duration,
            hasAudio: !!audioStream,
          });
        } catch {
          resolve({
            probeOk: false,
            ext,
            reason: lastErrLine ? `probe parse error: ${lastErrLine}` : 'probe parse error',
          });
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
    // Music albums don't get transcoded — the audio pipeline has a
    // lossy-only whitelist, so every file is already browser-playable.
    if (item.type === 'album') return;

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

    // Respect concurrent conversion limits. Local and remote encodes have
    // independent caps — a packed local slot shouldn't block a remote
    // transcode the worker can handle, and vice versa.
    const { local, remote } = this._countActiveConversions();
    const wouldUseRemote = this._pendingItemWouldUseRemote({
      _pendingConvertKind: kind,
      _workerFailed: item._workerFailed,
    });
    const atCapacity = wouldUseRemote
      ? remote >= this._maxConcurrentRemoteConversions
      : local >= this._maxConcurrentConversions;
    if (atCapacity) {
      console.log(`[Library] Conversion queued for "${item.name}" (${kind}) — waiting for ${wouldUseRemote ? 'remote' : 'local'} slot`);
      // Store that this needs conversion and check again when a conversion completes
      item._pendingConversion = true;
      item._pendingConvertKind = kind;
      this._stashProbeForConversion(item, probe);
      return;
    }

    // Don't start a transcode while BT downloads are active — libx264 would
    // starve the download pipeline of CPU and disk bandwidth. EXCEPT if a
    // remote GPU worker is online, in which case the encode runs off-box
    // and the only Orin-side cost is reading the source and streaming it
    // over Tailscale, neither of which competes meaningfully with BT.
    if (!this._canStartConversionNow()) {
      console.log(`[Library] Deferring conversion of "${item.name}" (${kind}) — downloads active and no GPU worker available`);
      item._pendingConversion = true;
      item._pendingConvertKind = kind;
      this._stashProbeForConversion(item, probe);
      return;
    }

    item.status = 'converting';
    item.convertKind = kind;
    item.convertProgress = 0;
    item.convertError = null;
    this._stashProbeForConversion(item, probe);
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
   * Build the FFmpeg command line for a LOCAL background conversion. Kind:
   *   'remux'     — stream-copy video, transcode audio to AAC (or copy if
   *                 already universal), re-wrap in an MP4 with +faststart.
   *                 Cheap; bound by disk I/O.
   *   'transcode' — full re-encode to H.264 main L4.1 yuv420p 8-bit +
   *                 AAC (or copy if already universal), 1080p-capped.
   *                 Slow (CPU-bound on Orin Nano without NVENC) but runs
   *                 once per file and the stored result is universally
   *                 direct-playable so no ffmpeg touches it on future plays.
   *
   * `audioCopy=true` skips the AAC re-encode when _canCopyAudio() said the
   * source audio is already universal (AAC LC stereo @ ≤48 kHz). This
   * shaves a small but real chunk off both remux and transcode wall clock
   * and avoids a generation-loss step on already-clean audio.
   */
  _buildConversionArgs(inputPath, tempOutputPath, kind, audioCopy) {
    const common = [
      '-hide_banner',
      '-fflags', '+genpts',
      // Hwaccel is a no-op for kind='remux' (-c:v copy bypasses decode)
      // but ffmpeg accepts it harmlessly, so both kinds share one prefix.
      ...getHwaccelArgs(),
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

    const audioArgs = audioCopy
      ? ['-c:a', 'copy']
      : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000'];

    if (kind === 'remux') {
      return [
        ...common,
        '-c:v', 'copy',
        ...audioArgs,
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
    // game in town WHEN the remote GPU worker is unreachable. 'veryfast'
    // gives a much better size/quality tradeoff than 'ultrafast' while
    // still averaging ~15-25 fps at 1080p on the 6-core Cortex-A78AE, i.e.
    // a 2-hour movie lands in 2-4 hours wall-clock. When WORKER_URL is set
    // and the worker is online, _startConversion routes around this path
    // entirely and the encode runs on a desktop NVIDIA card in minutes.
    // (See FFMPEG_HWACCEL at the top of this file for the NVDEC decode
    // offload that frees additional libx264 headroom on HEVC sources.)
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
      ...audioArgs,
      '-movflags', '+faststart',
      '-f', 'mp4',
      '-y',
      '-progress', 'pipe:1',
      '-loglevel', 'warning',
      tempOutputPath,
    ];
  }

  /**
   * Decide if the source audio is universal enough to stream-copy through
   * the conversion. Browsers reliably play AAC LC, stereo (or mono), at
   * sample rates ≤48 kHz, inside an MP4 container. Anything else (HE-AAC,
   * 5.1+, 96 kHz, AC-3, EAC-3, DTS, TrueHD, FLAC, Opus-in-mp4) gets
   * re-encoded to AAC LC stereo 48k for portability.
   */
  _canCopyAudio(probe) {
    if (!probe || !probe.hasAudio) return false;
    if (probe.audioCodec !== 'aac') return false;
    const prof = (probe.audioProfile || '').toLowerCase();
    // ffprobe reports the AAC profile as e.g. "LC", "HE-AAC", "HE-AACv2".
    // Anything that isn't plain LC gets re-encoded — HE-AAC playback in
    // mp4 is patchy across browsers.
    if (prof && prof !== 'lc' && prof !== 'main') return false;
    if (probe.audioChannels && probe.audioChannels > 2) return false;
    if (probe.audioSampleRate && probe.audioSampleRate > 48000) return false;
    return true;
  }

  /**
   * Stash the bits of a probe result that downstream conversion code
   * (local libx264 args, remote worker hints, audio-copy decision) needs
   * to see when the conversion eventually runs. We don't want to re-probe
   * inside _startConversion because the file might not even exist anymore
   * (deleted, renamed) and the probe is the wrong place to retry that.
   */
  _stashProbeForConversion(item, probe) {
    if (!item || !probe) return;
    item._probeDuration       = probe.duration;
    item._probeVideoCodec     = probe.videoCodec || null;
    item._probeAudioCodec     = probe.audioCodec || null;
    item._probeAudioProfile   = probe.audioProfile || null;
    item._probeAudioChannels  = probe.audioChannels || null;
    item._probeAudioSampleRate = probe.audioSampleRate || null;
    item._probeHasAudio       = !!probe.hasAudio;
  }

  /**
   * Build the audioCopy boolean for a queued conversion from the stashed
   * probe fields on the item. Mirrors _canCopyAudio() but reads from the
   * item-side cache so we don't have to keep the original probe object
   * around between queue and dispatch.
   */
  _itemCanCopyAudio(item) {
    return this._canCopyAudio({
      hasAudio:        item._probeHasAudio,
      audioCodec:      item._probeAudioCodec,
      audioProfile:    item._probeAudioProfile,
      audioChannels:   item._probeAudioChannels,
      audioSampleRate: item._probeAudioSampleRate,
    });
  }

  /**
   * Decide whether it's safe to start a new conversion right now. The
   * historical rule was "no conversions while downloads are active" because
   * libx264 on the Orin starves the BT pipeline. With a remote GPU worker
   * online the encode runs off-box, so the rule relaxes to "always OK".
   */
  _canStartConversionNow() {
    if (this._workerClient && this._workerClient.enabled() && this._workerHealth) {
      return true;
    }
    return !this._hasActiveDownloads();
  }

  /**
   * Start a background conversion of a library item to browser-compatible
   * MP4. Dispatches to either the remote GPU worker (when configured and
   * reachable) or the local libx264 path. The kind of conversion (remux
   * vs full transcode) is read from item.convertKind, which must have
   * been set by _checkAndConvert or the resume path before calling this.
   */
  async _startConversion(id) {
    const item = this._items.get(id);
    if (!item || !item.filePath) return;

    // Disk-space preflight: the output MP4 is written to a temp file
    // alongside the source until finalization, so we briefly need up to
    // ~2× source size on disk. Use source size as a conservative proxy
    // (typical CRF-23 transcodes land at 60-90% of source size).
    const sourceBytes = Number(item.fileSize) || 0;
    const space = await this._checkFreeSpace(sourceBytes, `conversion of "${item.name}"`);
    if (!space.ok) {
      this._onConversionFailure(id, space.reason);
      return;
    }

    // Route to the remote GPU worker when:
    //   - it's configured (WORKER_URL set)
    //   - we last saw it healthy in the periodic probe
    //   - this item hasn't already failed once on the worker (avoids loops
    //     on a file the worker can't actually decode)
    //   - the kind is 'transcode' — remux is so cheap on the Orin's CPU
    //     that round-tripping over the network would be a net loss
    const kind = item.convertKind === 'transcode' ? 'transcode' : 'remux';
    const useRemote =
      kind === 'transcode' &&
      this._workerClient &&
      this._workerClient.enabled() &&
      this._workerHealth &&
      !item._workerFailed;

    if (useRemote) {
      this._startRemoteConversion(id);
    } else {
      this._startLocalConversion(id);
    }
  }

  /**
   * Run a conversion locally with libx264 (or stream-copy for remux).
   * This is the fallback path when the GPU worker is unavailable, plus
   * the only path for cheap remux jobs.
   */
  _startLocalConversion(id) {
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
    const audioCopy = this._itemCanCopyAudio(item);

    const ffmpeg = spawn('ffmpeg', this._buildConversionArgs(inputPath, tempOutputPath, kind, audioCopy));

    // Wrap the child process in a uniform handle so the pause / shutdown
    // path can treat local and remote conversions the same way.
    const handle = {
      isRemote: false,
      process: ffmpeg,
      kill: () => { try { ffmpeg.kill('SIGTERM'); } catch { /* ignore */ } },
      _pausedForDownloads: false,
    };
    this._convertProcesses.set(id, handle);

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

      // Intentional SIGTERM from _pauseRunningConversionsForDownloads —
      // don't treat as failure, just requeue. Must check before the
      // code === 0 branch because a SIGTERM'd ffmpeg can sometimes
      // exit cleanly if it happened to be between frames.
      if (handle._pausedForDownloads) {
        this._onConversionPausedForDownloads(id);
        if (this._engines.size === 0 && this._convertProcesses.size === 0) {
          this._stopPeriodicSave();
        }
        return;
      }

      if (code === 0) {
        this._onConversionSuccess(id, inputPath, tempOutputPath, finalOutputPath);
      } else {
        this._onConversionFailure(id, `FFmpeg exited with code ${code}`);
      }
    });
  }

  /**
   * Run a conversion on the remote GPU worker. Streams the source file to
   * the worker over HTTP, gets the H.264/AAC MP4 back, and lets the normal
   * _onConversionSuccess path take over from there. On any worker failure
   * (network, ffmpeg error, GPU error, …) we set _workerFailed on the item
   * and fall through to libx264 — the remote attempt is best-effort, never
   * a hard dependency.
   */
  _startRemoteConversion(id) {
    const item = this._items.get(id);
    if (!item || !item.filePath) return;

    const inputPath = path.join(this._libraryPath, item.filePath);
    const tempOutputPath = this._getConvertTempPath(inputPath);
    const finalOutputPath = this._getConvertOutputPath(inputPath);

    if (!item.originalFilePath) {
      item.originalFilePath = item.filePath;
    }

    const audioCopy = this._itemCanCopyAudio(item);
    const totalIn = (() => {
      try { return fs.statSync(inputPath).size; }
      catch { return 0; }
    })();

    // Uniform handle — the kill() function gets filled in by the worker
    // client's registerHandle callback once the request is in flight.
    const handle = {
      isRemote: true,
      kill: () => { /* replaced via registerHandle */ },
      _pausedForDownloads: false,
    };
    this._convertProcesses.set(id, handle);

    console.log(`[Library] Starting REMOTE transcode: "${item.name}" (${(totalIn / 1e9).toFixed(2)} GB, codec=${item._probeVideoCodec || '?'}, audio=${item._probeAudioCodec || '?'}${audioCopy ? ' COPY' : ''})`);

    this._workerClient.transcode(inputPath, tempOutputPath, {
      filename:    path.basename(inputPath),
      sourceCodec: item._probeVideoCodec || undefined,
      sourceAudio: item._probeAudioCodec || undefined,
      audioCopy,
      onProgress: ({ phase, bytesUp, bytesDown, totalUp }) => {
        // Map (upload → encode → download) phases onto the 0-99% scale
        // the UI uses. We don't have per-frame progress on the remote
        // path, so the bands are coarse but they're enough for the
        // converting indicator to look like it's moving.
        let p;
        if (phase === 'upload') {
          p = totalUp > 0 ? Math.round((bytesUp / totalUp) * 33) : 0;
        } else if (phase === 'encode') {
          p = 40;
        } else {
          // download phase — we don't know the output size up front, so
          // crawl from 60 → 99 based on bytes received vs the input size
          // (output is typically 30-70% of input for H.264 from HEVC).
          const denom = Math.max(totalUp * 0.6, 1);
          p = 60 + Math.min(39, Math.round((bytesDown / denom) * 39));
        }
        item.convertProgress = Math.min(99, Math.max(0, p));
      },
      registerHandle: (workerHandle) => {
        handle.kill = () => workerHandle.kill();
      },
    }).then((result) => {
      this._convertProcesses.delete(id);

      // Pause path: a download started while we were converting, the
      // pause was a no-op for remote (see _pauseRunningConversionsForDownloads)
      // so this branch should normally not fire — but if some other code
      // path called handle.kill() with the flag set, honour it.
      if (handle._pausedForDownloads) {
        this._onConversionPausedForDownloads(id);
        if (this._engines.size === 0 && this._convertProcesses.size === 0) {
          this._stopPeriodicSave();
        }
        return;
      }

      console.log(`[Library] Remote transcode finished for "${item.name}": ${(result.outputBytes / 1e9).toFixed(2)} GB in ${result.encodeSec}s (${(result.outputBytes / Math.max(result.inputBytes, 1) * 100).toFixed(0)}% of source)`);
      this._onConversionSuccess(id, inputPath, tempOutputPath, finalOutputPath, true);
    }).catch((err) => {
      this._convertProcesses.delete(id);

      // Clean up any partial output the worker may have left behind.
      try { if (fs.existsSync(tempOutputPath)) fs.unlinkSync(tempOutputPath); } catch { /* ignore */ }

      if (handle._pausedForDownloads) {
        this._onConversionPausedForDownloads(id);
        if (this._engines.size === 0 && this._convertProcesses.size === 0) {
          this._stopPeriodicSave();
        }
        return;
      }

      // Mark this item so we don't loop forever if the worker can't
      // handle this particular source (e.g. exotic codec, corrupt file).
      // The flag is in-memory only — a server restart will retry the
      // remote path one more time, which is what we want.
      item._workerFailed = true;
      // Count the remote attempt as failed even though we're about to
      // retry locally — the remote path did fail and the operator needs
      // to see that in the counters to catch a flaky worker.
      this._convertStats.failRemote++;
      console.warn(`[Library] Remote transcode failed for "${item.name}" (${err.message}) — falling back to local libx264`);
      // Force the next probe of worker health so a transient blip doesn't
      // keep us locked out of the remote path for the full 30s interval.
      this._refreshWorkerHealth().catch(() => {});
      this._startLocalConversion(id);
    });
  }

  /**
   * Handle successful conversion: rename temp file, delete original, update metadata.
   */
  _onConversionSuccess(id, inputPath, tempOutputPath, finalOutputPath, isRemote = false) {
    const item = this._items.get(id);
    if (!item) return;

    try {
      // Verify output file exists and has non-zero size
      const stat = fs.statSync(tempOutputPath);
      if (stat.size === 0) {
        this._onConversionFailure(id, 'Conversion produced empty file', isRemote);
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

      if (isRemote) this._convertStats.successRemote++;
      else this._convertStats.successLocal++;

      this._saveMetadata();
      const s = this._convertStats;
      console.log(`[Library] Conversion complete: "${item.name}" → ${item.fileName} (${(stat.size / 1e9).toFixed(2)} GB) — totals: local ${s.successLocal}✓/${s.failLocal}✗ remote ${s.successRemote}✓/${s.failRemote}✗`);

      // Check if there are pending conversions waiting for a slot
      this._processConversionQueue();

      // Stop periodic save if nothing active
      if (this._engines.size === 0 && this._convertProcesses.size === 0) {
        this._stopPeriodicSave();
      }
    } catch (err) {
      console.error(`[Library] Conversion finalization error: ${err.message}`);
      this._onConversionFailure(id, `Finalization error: ${err.message}`, isRemote);
    }
  }

  /**
   * Handle failed conversion: clean up temp file, revert to original, allow on-the-fly remux.
   */
  _onConversionFailure(id, reason, isRemote = false) {
    const item = this._items.get(id);
    if (!item) return;

    if (isRemote) this._convertStats.failRemote++;
    else this._convertStats.failLocal++;

    const s = this._convertStats;
    console.error(`[Library] Conversion failed for "${item.name}": ${reason} — totals: local ${s.successLocal}✓/${s.failLocal}✗ remote ${s.successRemote}✓/${s.failRemote}✗`);

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
   * Count currently-running conversions by routing kind so the queue can
   * respect separate caps for local (CPU-bound) and remote (GPU-bound)
   * encodes.
   */
  _countActiveConversions() {
    let local = 0, remote = 0;
    for (const h of this._convertProcesses.values()) {
      if (h.isRemote) remote++;
      else local++;
    }
    return { local, remote };
  }

  /**
   * Replicates the routing decision _startConversion makes, but against
   * a pending item's convertKind hint rather than its live state — used
   * by the queue to figure out which cap this item counts against.
   */
  _pendingItemWouldUseRemote(item) {
    const kind = item._pendingConvertKind === 'transcode' ? 'transcode' : 'remux';
    if (kind !== 'transcode') return false;
    if (!this._workerClient || !this._workerClient.enabled()) return false;
    if (!this._workerHealth) return false;
    if (item._workerFailed) return false;
    return true;
  }

  /**
   * Check for items pending conversion and start them if a slot is available.
   * Gated on _hasActiveDownloads() so we never transcode while BT downloads
   * are running — see _pauseRunningConversionsForDownloads for the rationale.
   *
   * Local and remote conversions have independent caps, so this loops
   * greedily — on a healthy worker we might start 3 remote encodes in a
   * single tick without burning any Jetson CPU.
   */
  async _processConversionQueue() {
    // _canStartConversionNow() returns true when downloads are idle OR
    // when the remote GPU worker is online (since remote conversions
    // don't compete with downloads on the Orin).
    if (!this._canStartConversionNow()) return;

    for (;;) {
      const { local, remote } = this._countActiveConversions();
      const localFull  = local  >= this._maxConcurrentConversions;
      const remoteFull = remote >= this._maxConcurrentRemoteConversions;
      if (localFull && remoteFull) return;

      const pending = [...this._items.values()].find(i => {
        if (!i._pendingConversion) return false;
        return this._pendingItemWouldUseRemote(i) ? !remoteFull : !localFull;
      });
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
      // Await so the handle lands in _convertProcesses before we loop and
      // re-count — otherwise we'd over-start items on the first tick.
      await this._startConversion(pending.id);
    }
  }

  /**
   * True if any library item has an active torrent-stream engine OR is
   * marked as 'downloading' in metadata. Used to decide whether it's safe
   * to run an ffmpeg conversion right now.
   */
  _hasActiveDownloads() {
    if (this._engines.size > 0) return true;
    for (const item of this._items.values()) {
      if (item.status === 'downloading') return true;
    }
    return false;
  }

  /**
   * Kill every running ffmpeg conversion and requeue it as pending. Called
   * whenever a torrent-stream engine is about to start (or is already
   * running) so downloads don't have to fight a libx264 software transcode
   * for CPU, disk, and memory bandwidth.
   *
   * Why this exists: on Jetson-class hardware a single 1080p libx264
   * veryfast encode will peg 4-6 ARM cores, saturate the disk write queue,
   * and starve the Node event loop handling BT piece I/O. Observed effect
   * was 0 KB/s on swarms with 10+ healthy wires because piece verification
   * (SHA-1) couldn't keep up with incoming blocks and seeders started
   * choking us. Once the transcode is out of the picture the same swarm
   * immediately climbs to 200-500 KB/s per wire.
   *
   * The killed conversions lose any partial progress — the `.converting.mp4`
   * temp file is cleaned up via _onConversionPausedForDownloads — and will
   * restart from scratch when _processConversionQueue runs after the last
   * download finishes. Accepting the lost CPU time is the right tradeoff:
   * the transcode was actively starving downloads, and it will finish much
   * faster from a cold start in an idle system than limping along under
   * contention.
   */
  _pauseRunningConversionsForDownloads() {
    if (this._convertProcesses.size === 0) return;
    for (const [id, handle] of this._convertProcesses) {
      // Remote conversions run on the GPU worker, not on the Orin's CPU.
      // The only Orin-side cost is reading the source file off disk and
      // streaming it over Tailscale, neither of which competes with BT
      // piece writes in any meaningful way. Letting them keep running
      // during downloads is the whole point of having a remote worker.
      if (handle.isRemote) continue;

      const item = this._items.get(id);
      const name = item ? item.name : id;
      console.log(`[Library] Pausing local conversion "${name}" to free CPU for downloads`);
      handle._pausedForDownloads = true;
      handle.kill();
    }
  }

  /**
   * Cleanup path for a conversion that was intentionally killed by
   * _pauseRunningConversionsForDownloads. Reverts the item to 'complete'
   * with _pendingConversion set so _processConversionQueue picks it back
   * up once downloads are idle. Distinct from _onConversionFailure — we
   * don't want to surface a convertError to the user or stamp the item
   * as a failed conversion when nothing actually went wrong.
   */
  _onConversionPausedForDownloads(id) {
    const item = this._items.get(id);
    if (!item) return;

    // Discard the partial temp file — we're restarting from scratch later.
    const sourcePath = item.originalFilePath || item.filePath;
    if (sourcePath) {
      const tempPath = this._getConvertTempPath(path.join(this._libraryPath, sourcePath));
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { /* ignore */ }
    }

    // Revert filePath if _startConversion stashed the original.
    if (item.originalFilePath) {
      item.filePath = item.originalFilePath;
      item.originalFilePath = null;
    }

    // Requeue for the pending-conversion queue. Keep the kind so
    // _processConversionQueue picks it up unchanged when it fires.
    const kind = item.convertKind || 'transcode';
    item.status = 'complete';
    item._pendingConversion = true;
    item._pendingConvertKind = kind;
    item.convertKind = null;
    item.convertProgress = null;
    item.convertError = null;
    delete item._probeDuration;

    this._saveMetadata();
  }

  _sanitizeItem(item) {
    const matchState = item.matchState || this._computeMatchState(item);
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
      matchState,
      matchConfidence: item.matchConfidence || 0,
      matchSource: item.matchSource || null,
      parsed: item.parsed || null,
      candidates: Array.isArray(item.candidates) ? item.candidates : [],
    };
  }

  _safeDirectoryName(item) {
    const base = (item.name || 'unknown').replace(/[^\w\s.\-()[\]]/g, '_').substring(0, 100);
    return `${base}_${item.infoHash.slice(0, 8)}`;
  }
}

module.exports = LibraryManager;
