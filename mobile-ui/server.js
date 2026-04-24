const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const dns = require('dns');
const { spawn } = require('child_process');

// ─── DNS Fallback (matches stream-providers.js) ──────────────────────
const fallbackResolver = new dns.Resolver();
fallbackResolver.setServers(['1.1.1.1', '8.8.8.8', '1.0.0.1', '8.8.4.4']);

function resolveWithFallback(hostname) {
  return new Promise((resolve, reject) => {
    dns.resolve4(hostname, (err, addresses) => {
      if (!err && addresses && addresses.length > 0) {
        return resolve(addresses[0]);
      }
      console.log(`[DNS] System DNS failed for ${hostname}, trying fallback resolvers...`);
      fallbackResolver.resolve4(hostname, (err2, addresses2) => {
        if (!err2 && addresses2 && addresses2.length > 0) {
          console.log(`[DNS] Fallback resolved ${hostname} → ${addresses2[0]}`);
          return resolve(addresses2[0]);
        }
        reject(err2 || err);
      });
    });
  });
}
// http-proxy-middleware removed — Stremio server proxy no longer needed
const {
  getMovieStreams, getSeriesStreams, getSeasonPackStreams, getCompleteStreams, diagnoseProviders,
  getAlbumStreams, getArtistDiscographyStreams,
  httpsAgent: providersHttpsAgent,
} = require('./lib/stream-providers');
const TorrentEngine = require('./lib/torrent-engine');
const LibraryManager = require('./lib/library-manager');
const {
  mbSearchRelease, mbSearchArtist, mbSearchRecording, mbGetRelease, mbGetArtist, mbGetReleaseForGroup,
} = require('./lib/metadata-musicbrainz');
const { getSystemDiag } = require('./lib/system-diag');
const { discoverDevices, getLocalIP } = require('./lib/local-discovery');
const castManager = require('./lib/cast-manager');

const compression = require('compression');

const app = express();
// Gzip JSON / text responses. /api/library alone can ship 50-200 KB
// of metadata for a mid-sized library; gzip compresses that down to
// ~10-30 KB and noticeably cuts first-byte-to-rendered latency on
// cellular. Video / audio stream responses are intentionally skipped
// because the range-request ffmpeg-pipe paths have their own Content-
// Type we don't want to double-compress. The default filter already
// skips responses with `Cache-Control: no-transform` and binary MIME
// types, so this is safe to apply globally.
app.use(compression());
const PORT = process.env.PORT || 8080;
const TORRENT_CACHE_PATH = process.env.TORRENT_CACHE || path.join(__dirname, '.torrent-cache');
const LIBRARY_PATH = process.env.LIBRARY_PATH || path.join(TORRENT_CACHE_PATH, 'library');
// Music library defaults to a sibling folder on the same drive so music
// albums don't commingle with movie folders on disk. Override with
// MUSIC_LIBRARY_PATH if you want them elsewhere entirely.
const MUSIC_LIBRARY_PATH = process.env.MUSIC_LIBRARY_PATH
  || path.join(path.dirname(LIBRARY_PATH), 'music-library');
const SETTINGS_PATH = path.join(TORRENT_CACHE_PATH, 'settings.json');

// Optional ffmpeg hwaccel for the live transcode endpoint. Mirrors the
// FFMPEG_HWACCEL handling in lib/library-manager.js — set =cuda / =nvdec /
// =v4l2m2m to offload decode to NVDEC on Jetson and free CPU for libx264.
const FFMPEG_HWACCEL = (process.env.FFMPEG_HWACCEL || '').trim();
const FFMPEG_HWACCEL_ARGS = FFMPEG_HWACCEL ? ['-hwaccel', FFMPEG_HWACCEL] : [];
// Default is intentionally low. 6 concurrent torrents on a Jetson-class box
// starve each other for CPU (piece verify), disk I/O (random writes on eMMC/SD),
// and BT reciprocity slots, so aggregate throughput is usually *better* with
// fewer parallel downloads that individually saturate available resources.
// Override with the MAX_CONCURRENT_STREAMS env var or the in-app setting.
let MAX_CONCURRENT_STREAMS = parseInt(process.env.MAX_CONCURRENT_STREAMS, 10) || 2;

// Which background work gets right-of-way when downloads and local
// conversions would contend for CPU. See LibraryManager._taskPriority
// for the semantics. Default matches the old behavior.
const VALID_TASK_PRIORITIES = ['downloads-first', 'conversions-first', 'both'];
let TASK_PRIORITY = 'downloads-first';

// Hardware protection — primary protection is a hard core cap on local
// ffmpeg so it can't pin every core. CPU-% auto-pause is secondary
// (sustained window + cooldown) because on Jetson-class hardware the
// encode itself saturates CPU, so a naive "pause at 90%" would fire on
// the workload we're trying to protect.
const DEFAULT_CPU_PROTECTION = {
  enabled: true,
  pauseThreshold: 95,       // only catches TRUE runaway — thread cap keeps the normal encode under this
  resumeThreshold: 70,
  sustainedMs: 20000,       // CPU must stay above pauseThreshold for 20s before firing
  cooldownMs: 5 * 60 * 1000, // 5 min after a pause before we'll retry
  // maxConversionCores default is "cores - 2" and is computed inside
  // LibraryManager since it needs os.cpus() anyway. Leave it unset here
  // so a fresh install gets the hardware-aware default.
  niceLevel: 10,
};
let CPU_PROTECTION = { ...DEFAULT_CPU_PROTECTION };

function _clampPct(n, fallback) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(1, Math.min(100, v));
}
function _clampInt(n, min, max, fallback) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

// Load persisted settings from disk
try {
  if (fs.existsSync(SETTINGS_PATH)) {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    if (saved.maxConcurrentStreams >= 1 && saved.maxConcurrentStreams <= 20) {
      MAX_CONCURRENT_STREAMS = saved.maxConcurrentStreams;
    }
    if (VALID_TASK_PRIORITIES.includes(saved.taskPriority)) {
      TASK_PRIORITY = saved.taskPriority;
    }
    if (saved.cpuProtection && typeof saved.cpuProtection === 'object') {
      const s = saved.cpuProtection;
      CPU_PROTECTION = {
        enabled: s.enabled !== false,
        pauseThreshold:  _clampPct(s.pauseThreshold,  DEFAULT_CPU_PROTECTION.pauseThreshold),
        resumeThreshold: _clampPct(s.resumeThreshold, DEFAULT_CPU_PROTECTION.resumeThreshold),
        sustainedMs:     _clampInt(s.sustainedMs, 0, 600000, DEFAULT_CPU_PROTECTION.sustainedMs),
        cooldownMs:      _clampInt(s.cooldownMs,  0, 60 * 60 * 1000, DEFAULT_CPU_PROTECTION.cooldownMs),
        niceLevel:       _clampInt(s.niceLevel,   0, 19, DEFAULT_CPU_PROTECTION.niceLevel),
      };
      // Only persist maxConversionCores if the operator has actually set
      // one; otherwise fall back to the hardware-aware default computed
      // inside LibraryManager.
      if (s.maxConversionCores != null) {
        const n = _clampInt(s.maxConversionCores, 1, 128, null);
        if (n != null) CPU_PROTECTION.maxConversionCores = n;
      }
      // Enforce hysteresis at load time too so a hand-edited settings file
      // with pause=70,resume=80 doesn't flap the conversion queue.
      if (CPU_PROTECTION.resumeThreshold >= CPU_PROTECTION.pauseThreshold) {
        CPU_PROTECTION.resumeThreshold = Math.max(10, CPU_PROTECTION.pauseThreshold - 10);
      }
    }
  }
} catch (e) {
  console.warn('[Settings] Failed to load saved settings:', e.message);
}

// Centralized writer: always persist the full known setting set so a later
// toggle doesn't silently drop unrelated keys. Swallows errors because a
// failed write is a logged warning, not a request failure.
function persistSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify({
      maxConcurrentStreams: MAX_CONCURRENT_STREAMS,
      taskPriority: TASK_PRIORITY,
      cpuProtection: CPU_PROTECTION,
    }), 'utf8');
  } catch (e) {
    console.warn('[Settings] Failed to persist settings:', e.message);
  }
}

// JSON body parsing for library POST/DELETE requests
app.use(express.json({ limit: '10kb' }));

// ─── Rate Limiting (simple in-memory, per-IP) ────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 300;          // max requests per window

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW) {
    entry = { start: now, count: 0 };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests — try again later' });
  }
  next();
}

// Clean up rate limit map periodically
const rateLimitCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.start > RATE_LIMIT_WINDOW) rateLimitMap.delete(ip);
  }
}, RATE_LIMIT_WINDOW);

// ─── Concurrency Gate (per-IP + global) ──────────────────────────────
// Caps how many ffmpeg-backed streaming sessions can run at once. The
// per-IP `rateLimit` above throttles request *rate*, but a client can
// still hold open N long-lived transcode connections and spawn N ffmpeg
// processes. On the Orin Nano each libx264 transcode occupies multiple
// cores, so without this gate a handful of abusive clients can DoS the
// entire box.
const MAX_CONCURRENT_TRANSCODE = parseInt(process.env.MAX_CONCURRENT_TRANSCODE, 10) || 2;
const MAX_CONCURRENT_TRANSCODE_PER_IP = parseInt(process.env.MAX_CONCURRENT_TRANSCODE_PER_IP, 10) || 1;
const MAX_CONCURRENT_REMUX = parseInt(process.env.MAX_CONCURRENT_REMUX, 10) || 4;
const MAX_CONCURRENT_REMUX_PER_IP = parseInt(process.env.MAX_CONCURRENT_REMUX_PER_IP, 10) || 2;

function concurrencyGate(label, maxGlobal, maxPerIp) {
  let active = 0;
  const perIp = new Map();
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const ipCount = perIp.get(ip) || 0;
    if (active >= maxGlobal) {
      return res.status(429).set('Retry-After', '30').json({
        error: `Server busy — too many concurrent ${label} sessions. Try again shortly.`,
      });
    }
    if (ipCount >= maxPerIp) {
      return res.status(429).set('Retry-After', '10').json({
        error: `Too many concurrent ${label} sessions from this client.`,
      });
    }
    active++;
    perIp.set(ip, ipCount + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active--;
      const remaining = (perIp.get(ip) || 1) - 1;
      if (remaining <= 0) perIp.delete(ip);
      else perIp.set(ip, remaining);
    };
    res.on('close', release);
    res.on('finish', release);
    next();
  };
}

const transcodeGate = concurrencyGate('transcode', MAX_CONCURRENT_TRANSCODE, MAX_CONCURRENT_TRANSCODE_PER_IP);
const remuxGate = concurrencyGate('remux', MAX_CONCURRENT_REMUX, MAX_CONCURRENT_REMUX_PER_IP);

// ─── HLS Session Manager ──────────────────────────────────────────────
// HLS exists for clients (iOS Safari chief among them) where the fMP4
// transcode path doesn't work reliably: empty_moov + chunked transfer
// isn't trusted by the iOS <video> pipeline, so we instead hand Safari a
// plain .m3u8 playlist pointing at per-segment .ts URLs. ffmpeg writes
// segments to a session directory; we serve them right off disk.
//
// Sessions are keyed by library item id so two clients watching the same
// movie share a single ffmpeg. We DON'T key on client IP or session id —
// that would spawn redundant ffmpegs and defeat the point of this path.
//
// Session lifecycle:
//   * first /hls/playlist.m3u8 request creates the dir + spawns ffmpeg
//   * subsequent requests (playlist polls, segment fetches) bump lastAccessMs
//   * idle cleanup runs every 30s; sessions with >HLS_IDLE_TIMEOUT_MS of
//     inactivity get their ffmpeg SIGTERMed and their dir removed
//   * server shutdown kills every active session
const HLS_CACHE_PATH = path.join(TORRENT_CACHE_PATH, 'hls-cache');
const HLS_IDLE_TIMEOUT_MS = 120 * 1000;  // keep session alive 2 min after last request (survives tab backgrounding)
const HLS_CLEANUP_INTERVAL_MS = 30 * 1000;
const HLS_FIRST_SEGMENT_WAIT_MS = 20 * 1000;  // max time to wait on /playlist.m3u8 for ffmpeg's first segment
const HLS_SEGMENT_WAIT_MS = 15 * 1000;        // max time a /segment request waits if the segment isn't yet written
const HLS_SEGMENT_DURATION = 4;               // seconds per segment
const MAX_CONCURRENT_HLS_SESSIONS = MAX_CONCURRENT_TRANSCODE;

try { fs.mkdirSync(HLS_CACHE_PATH, { recursive: true }); } catch (e) {
  console.warn(`[HLS] Could not create cache dir ${HLS_CACHE_PATH}: ${e.message}`);
}

// Clean any leftover session directories from a previous server run —
// they're worthless without the ffmpeg process that was writing them.
try {
  for (const name of fs.readdirSync(HLS_CACHE_PATH)) {
    try { fs.rmSync(path.join(HLS_CACHE_PATH, name), { recursive: true, force: true }); } catch { /* ignore */ }
  }
} catch { /* dir might not exist on very first boot */ }

const hlsSessions = new Map(); // itemId -> { dir, ffmpeg, playlistPath, lastAccessMs, startedAt, firstSegmentPromise, ended }

function _hlsSessionDirFor(itemId) {
  // Sanitize the id into a filesystem-safe directory name. The id usually
  // comes from torrent infoHash (hex) or "disk_" + path fragment, but we
  // don't trust it — replace anything outside [A-Za-z0-9_-] with '_'. We
  // intentionally DROP dots from the allowed set: an id of `..` would
  // otherwise pass through and path.join(cacheDir, '..') would escape.
  // library.getItem() blocks malformed ids upstream, but a route-level
  // mistake shouldn't be able to cascade into a cache-dir escape.
  const safe = itemId.replace(/[^\w-]/g, '_').substring(0, 120) || '_';
  return path.join(HLS_CACHE_PATH, safe);
}

function _stopHlsSession(itemId, reason) {
  const sess = hlsSessions.get(itemId);
  if (!sess) return;
  hlsSessions.delete(itemId);
  sess.ended = true;
  // Release the live-transcode slot so any background conversion that
  // was deferred by this HLS session can resume when we hit zero.
  try { library.decrementLiveTranscodes(); } catch { /* library not ready */ }
  try { sess.ffmpeg.kill('SIGTERM'); } catch { /* already dead */ }
  // Give ffmpeg a beat to release file handles, then rm with a short
  // retry schedule. Under load on eMMC / SD, Windows-via-Samba mounts,
  // or a busy Jetson, 500ms isn't always enough for the OS to actually
  // release the handles — the rm then fails silently and we'd leak a
  // session dir until the startup wipe cleans it up. Three tries at
  // 500ms / 2s / 5s covers every slow-disk case we've seen without
  // delaying the common case.
  const retryDelays = [500, 2000, 5000];
  const attempt = (i) => {
    try {
      fs.rmSync(sess.dir, { recursive: true, force: true });
    } catch (err) {
      if (i + 1 < retryDelays.length) {
        setTimeout(() => attempt(i + 1), retryDelays[i + 1]);
      } else {
        console.warn(`[HLS] Failed to remove ${sess.dir} after ${retryDelays.length} attempts: ${err.message} (startup wipe will clean it up)`);
      }
    }
  };
  setTimeout(() => attempt(0), retryDelays[0]);
  console.log(`[HLS] Session ended for ${itemId}: ${reason}`);
}

function _startHlsSession(itemId, filePath) {
  const dir = _hlsSessionDirFor(itemId);
  // Wipe any stale contents from a previous run of the same id.
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.mkdirSync(dir, { recursive: true });
  const playlistPath = path.join(dir, 'playlist.m3u8');

  // HLS args. Differences from /stream/transcode:
  //   * -f hls (instead of fragmented mp4)
  //   * GOP sized to the segment duration so every segment starts on an
  //     IDR — required for HLS seek-to-segment to work
  //   * -hls_playlist_type event so the playlist grows as segments land
  //     and the client can detect EOF via #EXT-X-ENDLIST
  //   * independent_segments so each .ts can be decoded on its own
  //   * temp_file so partially-written segments don't get served
  const gop = HLS_SEGMENT_DURATION * 24; // safe for 24/30fps sources
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner',
    '-fflags', '+genpts',
    ...FFMPEG_HWACCEL_ARGS,
    '-probesize', '1000000',
    '-analyzeduration', '1000000',
    '-i', filePath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-sn',
    '-dn',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-profile:v', 'main',
    '-level', '4.1',
    '-pix_fmt', 'yuv420p',
    '-crf', '23',
    '-vf', "scale='min(1280,iw)':'-2'",
    '-g', String(gop),
    '-keyint_min', String(gop),
    '-sc_threshold', '0',
    '-force_key_frames', `expr:gte(t,n_forced*${HLS_SEGMENT_DURATION})`,
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ac', '2',
    '-ar', '48000',
    '-f', 'hls',
    '-hls_time', String(HLS_SEGMENT_DURATION),
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_segment_type', 'mpegts',
    '-hls_flags', 'independent_segments+temp_file',
    '-hls_segment_filename', path.join(dir, 'segment_%d.ts'),
    '-loglevel', 'warning',
    playlistPath,
  ]);

  const session = {
    dir,
    ffmpeg,
    playlistPath,
    lastAccessMs: Date.now(),
    startedAt: Date.now(),
    stderrTail: '',
    ended: false,
  };

  ffmpeg.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (!msg) return;
    console.log(`[FFmpeg/HLS ${itemId}] ${msg}`);
    const last = msg.split('\n').pop();
    if (last) session.stderrTail = last;
  });

  ffmpeg.on('error', (err) => {
    console.error(`[HLS] FFmpeg spawn error for ${itemId}: ${err.message}`);
    session.stderrTail = err.message;
    _stopHlsSession(itemId, 'ffmpeg spawn error');
  });

  ffmpeg.on('close', (code) => {
    // Normal end-of-file exit: ffmpeg wrote #EXT-X-ENDLIST to the playlist
    // and we can leave the segments on disk until the idle timer reaps the
    // session. Abnormal exit: nuke the session so the client doesn't keep
    // polling a dead playlist.
    if (code !== 0 && code !== 255 && !session.ended) {
      console.warn(`[HLS] FFmpeg exited abnormally for ${itemId}: code ${code}`);
      _stopHlsSession(itemId, `ffmpeg exit ${code}`);
    }
  });

  hlsSessions.set(itemId, session);
  // Claim a live-transcode slot so background libx264 conversions defer
  // to us. _stopHlsSession mirrors this with decrementLiveTranscodes().
  library.incrementLiveTranscodes();
  console.log(`[HLS] Session started for ${itemId} → ${dir}`);
  return session;
}

const hlsCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, sess] of hlsSessions) {
    if (now - sess.lastAccessMs > HLS_IDLE_TIMEOUT_MS) {
      _stopHlsSession(id, `idle for ${Math.round((now - sess.lastAccessMs) / 1000)}s`);
    }
  }
}, HLS_CLEANUP_INTERVAL_MS);
hlsCleanupTimer.unref();

// ─── Torrent Engine (lazy-initialized on first custom-mode request) ───
let engine = null;
function getEngine() {
  if (!engine) {
    engine = new TorrentEngine({ downloadPath: TORRENT_CACHE_PATH, maxConcurrent: MAX_CONCURRENT_STREAMS });
    console.log(`[TorrentEngine] Initialized, cache path: ${TORRENT_CACHE_PATH}`);
  }
  return engine;
}

// ─── Library Manager (initialized on startup) ─────────────────────────
// WORKER_URL points at the optional remote GPU conversion worker (a small
// HTTP service running on a Windows PC with NVENC). When set AND reachable,
// background transcodes are streamed there over Tailscale instead of
// running libx264 on the Orin's CPU. See worker/README.md.
const WORKER_URL    = process.env.WORKER_URL || '';
const WORKER_SECRET = process.env.WORKER_SECRET || '';
if (WORKER_URL && !WORKER_SECRET) {
  console.warn('[Config] WORKER_URL is set but WORKER_SECRET is empty — worker traffic will be unauthenticated. Consider setting WORKER_SECRET on both ends for defence-in-depth on top of Tailscale.');
}
const DISK_RESERVE_BYTES = (() => {
  const n = parseInt(process.env.DISK_RESERVE_BYTES, 10);
  return Number.isFinite(n) && n >= 0 ? n : 1 * 1024 * 1024 * 1024;
})();
const MAX_CONCURRENT_REMOTE_CONVERSIONS = parseInt(process.env.MAX_CONCURRENT_REMOTE_CONVERSIONS, 10) || 3;
const library = new LibraryManager({
  libraryPath: LIBRARY_PATH,
  maxConcurrentDownloads: MAX_CONCURRENT_STREAMS,
  workerUrl: WORKER_URL,
  workerSecret: WORKER_SECRET,
  diskReserveBytes: DISK_RESERVE_BYTES,
  maxConcurrentRemoteConversions: MAX_CONCURRENT_REMOTE_CONVERSIONS,
  taskPriority: TASK_PRIORITY,
  cpuProtection: CPU_PROTECTION,
});
// Separate LibraryManager instance for music with its own _metadata.json.
// Music items are type: 'album' and take a different completion path
// internally (multi-file audio download, tracks[] scan, no video transcode).
// Workers aren't useful for audio so it doesn't receive the worker config.
fs.mkdirSync(MUSIC_LIBRARY_PATH, { recursive: true });
const musicLibrary = new LibraryManager({
  libraryPath: MUSIC_LIBRARY_PATH,
  maxConcurrentDownloads: MAX_CONCURRENT_STREAMS,
  diskReserveBytes: DISK_RESERVE_BYTES,
  cpuProtection: CPU_PROTECTION,
});
const MusicPlaylists = require('./lib/music-playlists');
const musicPlaylists = new MusicPlaylists(MUSIC_LIBRARY_PATH);

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'sha256-ZswfTY7H35rbv8WC7NXBoiC7WNu86vSzCDChNWwZZDM='",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https: data:",
    "connect-src 'self'",
    "media-src 'self' blob: http: https:",
    "frame-ancestors 'none'",
  ].join('; '));
  next();
});

// ─── TMDB Search API ─────────────────────────────────────────────────

const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const TMDB_BASE = 'https://api.themoviedb.org/3';

// In-memory cache of TMDB responses. TMDB metadata changes slowly — we
// can safely serve a 30-min-old /movie/123 detail payload while
// drastically cutting API hits (the same id is queried for search
// hits, detail view, poster refresh, season enrichment, and
// auto-match all in one session). Negative entries (404 / non-200)
// are remembered for 1 hour so a mistyped id doesn't retry on every
// page load and chew into the 40-req/10s rate limit. Process-local
// Map; clears on restart. Size cap keeps memory bounded.
const TMDB_CACHE_MAX        = 2048;
const TMDB_CACHE_TTL_OK_MS  = 30 * 60 * 1000;
const TMDB_CACHE_TTL_ERR_MS = 60 * 60 * 1000;
const _tmdbCache = new Map();   // url -> { ok, value, expiresAt }
function _tmdbCacheGet(url) {
  const hit = _tmdbCache.get(url);
  if (!hit) return null;
  if (Date.now() >= hit.expiresAt) {
    _tmdbCache.delete(url);
    return null;
  }
  // Touch for LRU
  _tmdbCache.delete(url);
  _tmdbCache.set(url, hit);
  return hit;
}
function _tmdbCacheSet(url, ok, value, ttlMs) {
  if (_tmdbCache.size >= TMDB_CACHE_MAX) {
    const oldest = _tmdbCache.keys().next().value;
    if (oldest !== undefined) _tmdbCache.delete(oldest);
  }
  _tmdbCache.set(url, { ok, value, expiresAt: Date.now() + ttlMs });
}

function tmdbFetch(endpoint, params = {}) {
  if (!TMDB_API_KEY) return Promise.reject(new Error('No TMDB API key'));
  const qs = new URLSearchParams({ api_key: TMDB_API_KEY, ...params });
  const url = `${TMDB_BASE}${endpoint}?${qs}`;

  const cached = _tmdbCacheGet(url);
  if (cached) {
    if (cached.ok) return Promise.resolve(cached.value);
    return Promise.reject(cached.value);
  }

  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      if (req) req.destroy();
      reject(new Error('Timeout'));
    }, 10000);
    // Reuse the keep-alive agent from stream-providers so per-page-load TMDB
    // calls (search, details, season metadata) skip the TLS handshake on
    // the Orin's CPU after the first one.
    const req = https.get(url, { timeout: 10000, family: 4, agent: providersHttpsAgent }, (res) => {
      if (res.statusCode !== 200) {
        clearTimeout(deadline);
        res.resume();
        const err = new Error(`TMDB HTTP ${res.statusCode}`);
        // Remember non-200s so we don't hammer TMDB on broken ids /
        // transient server errors. Rate-limit replies (429) get the
        // same cache; the 1-hr miss window is shorter than a TMDB
        // cool-off anyway.
        _tmdbCacheSet(url, false, err, TMDB_CACHE_TTL_ERR_MS);
        return reject(err);
      }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        clearTimeout(deadline);
        try {
          const value = JSON.parse(body);
          _tmdbCacheSet(url, true, value, TMDB_CACHE_TTL_OK_MS);
          resolve(value);
        }
        catch (e) { reject(e); }
      });
    });
    req.on('error', (e) => { clearTimeout(deadline); reject(e); });
    req.on('timeout', () => { clearTimeout(deadline); req.destroy(); reject(new Error('Timeout')); });
  });
}

// Lowercase + strip diacritics so titles with macrons/accents (e.g. TMDB's
// "Naruto Shippūden") compare equal to their ASCII-spelled filenames.
function normalizeForMatch(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

// Compute how relevant a title is to the search query (0.0 - 1.0)
function relevanceScore(title, query) {
  const t = normalizeForMatch(title);
  const q = normalizeForMatch(query);
  if (t === q) return 1.0;
  let score = 0;
  if (t.startsWith(q)) score = 0.75;
  else if (t.includes(q)) score = 0.5;
  const coverage = Math.min(q.length / t.length, 1.0);
  score += coverage * 0.25;
  const qWords = q.split(/\s+/);
  const tWords = t.split(/\s+/);
  const matched = qWords.filter(w => tWords.includes(w)).length;
  score += (matched / tWords.length) * 0.15;
  return Math.min(score, 1.0);
}

// GET /api/search?q=query&type=movie|series
app.get('/api/search', rateLimit, async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query || query.length > 200) return res.json({ results: [] });

  const type = req.query.type; // 'movie', 'series', 'album', 'artist', 'music', or undefined for both movie+series
  const results = [];

  // Music types dispatch to MusicBrainz; no TMDB key required.
  // Results are returned tagged by `type` ('artist' | 'album' | 'song') so the
  // client can render them as separate sections. Each type gets its own bucket
  // with its own limit so high-scoring album hits can't crowd out the artist
  // the user was actually searching for (and vice versa).
  if (type === 'album' || type === 'artist' || type === 'song' || type === 'music') {
    try {
      const wantArtists = type === 'artist' || type === 'music';
      const wantAlbums = type === 'album' || type === 'music';
      const wantSongs = type === 'song' || type === 'music';

      const artistTask = wantArtists
        ? mbSearchArtist(query).then(rs => rs.map(r => ({
            id: `mba:${r.mbid}`,
            mbid: r.mbid,
            type: 'artist',
            name: r.name,
            artist: r.disambiguation || r.country || '',
            year: r.country || '',
            poster: null,
            overview: r.disambiguation || '',
            vote_average: 0,
            popularity: r.score || 0,
          }))).catch(() => [])
        : Promise.resolve([]);

      const albumTask = wantAlbums
        ? mbSearchRelease(query).then(rs => rs.map(r => ({
            id: `mbr:${r.mbid}`,
            mbid: r.mbid,
            artistMbid: r.artistMbid,
            type: 'album',
            name: r.title,
            artist: r.artist,
            year: r.year,
            poster: r.coverUrl,
            overview: '',
            vote_average: 0,
            popularity: r.score || 0,
          })).filter(r => r.name && r.artist)).catch(() => [])
        : Promise.resolve([]);

      const songTask = wantSongs
        ? mbSearchRecording(query).then(rs => rs.map(r => ({
            id: `mbrec:${r.mbid}`,
            mbid: r.mbid,
            artistMbid: r.artistMbid,
            releaseMbid: r.releaseMbid,
            type: 'song',
            name: r.title,
            artist: r.artist,
            album: r.releaseTitle,
            duration: r.duration,
            year: r.year,
            poster: r.coverUrl,
            overview: r.releaseTitle || '',
            vote_average: 0,
            popularity: r.score || 0,
          })).filter(r => r.name && r.artist)).catch(() => [])
        : Promise.resolve([]);

      const [artists, albums, songs] = await Promise.all([artistTask, albumTask, songTask]);
      const sortByScore = (a, b) => b.popularity - a.popularity;
      artists.sort(sortByScore);
      albums.sort(sortByScore);
      songs.sort(sortByScore);

      // Flat `results` preserves the existing API shape; `groups` lets the
      // client render typed sections without re-bucketing.
      return res.json({
        results: [...artists, ...albums, ...songs],
        groups: { artists, albums, songs },
      });
    } catch (err) {
      console.error('[MB] Search error:', err.message);
      return res.json({ results: [], groups: { artists: [], albums: [], songs: [] }, error: 'Music search failed' });
    }
  }

  if (!TMDB_API_KEY) {
    return res.json({ results: [], error: 'TMDB API key not configured' });
  }

  try {
    const types = type === 'movie' ? ['movie'] : type === 'series' ? ['tv'] : ['movie', 'tv'];
    const searches = types.map(t =>
      tmdbFetch(`/search/${t}`, { query, include_adult: 'false' })
        .then(data => (data.results || []).map(item => ({ ...item, media_type: t })))
        .catch(() => [])
    );
    const searchResults = await Promise.all(searches);

    for (const items of searchResults) {
      for (const item of items) {
        // Get IMDB ID via external IDs lookup
        const tmdbType = item.media_type;
        const tmdbId = item.id;
        const title = tmdbType === 'movie' ? item.title : item.name;
        const year = (item.release_date || item.first_air_date || '').slice(0, 4);
        const poster = item.poster_path
          ? `https://image.tmdb.org/t/p/w342${item.poster_path}`
          : null;

        results.push({
          tmdb_id: tmdbId,
          type: tmdbType === 'tv' ? 'series' : 'movie',
          name: title,
          year,
          poster,
          popularity: item.popularity || 0,
          vote_average: item.vote_average || 0,
          overview: item.overview || '',
        });
      }
    }

    // Sort by relevance to query, then popularity as tiebreaker
    results.sort((a, b) => {
      const relDiff = relevanceScore(b.name, query) - relevanceScore(a.name, query);
      if (relDiff !== 0) return relDiff;
      return b.popularity - a.popularity;
    });

    // Fetch IMDB IDs for top results (concurrency-limited to avoid TMDB rate limits)
    const topResults = results.slice(0, 20);
    const CONCURRENCY = 5;
    for (let i = 0; i < topResults.length; i += CONCURRENCY) {
      const batch = topResults.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (item) => {
        try {
          const tmdbType = item.type === 'series' ? 'tv' : 'movie';
          const ext = await tmdbFetch(`/${tmdbType}/${item.tmdb_id}/external_ids`);
          item.imdb_id = ext.imdb_id || null;
          item.id = ext.imdb_id || `tmdb:${item.tmdb_id}`;
        } catch {
          item.imdb_id = null;
          item.id = `tmdb:${item.tmdb_id}`;
        }
      }));
    }

    // Sort: IMDB availability first, then relevance, then popularity
    topResults.sort((a, b) => {
      const aHas = a.imdb_id ? 1 : 0;
      const bHas = b.imdb_id ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas;
      const relDiff = relevanceScore(b.name, query) - relevanceScore(a.name, query);
      if (relDiff !== 0) return relDiff;
      return b.popularity - a.popularity;
    });

    res.json({ results: topResults });
  } catch (err) {
    console.error('[TMDB] Search error:', err.message);
    res.json({ results: [], error: 'Search failed' });
  }
});

// ─── TMDB Metadata Endpoint (for items without IMDB IDs) ────────────

app.get('/api/tmdb-meta/:type/:tmdbId', rateLimit, async (req, res) => {
  const { type, tmdbId } = req.params;
  if (!/^\d+$/.test(tmdbId) || !['movie', 'series'].includes(type)) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }

  if (!TMDB_API_KEY) {
    return res.status(503).json({ error: 'TMDB API key not configured' });
  }

  try {
    const tmdbType = type === 'series' ? 'tv' : 'movie';
    const data = await tmdbFetch(`/${tmdbType}/${tmdbId}`);

    const meta = {
      id: `tmdb:${tmdbId}`,
      type,
      name: tmdbType === 'movie' ? data.title : data.name,
      year: (data.release_date || data.first_air_date || '').slice(0, 4),
      poster: data.poster_path ? `https://image.tmdb.org/t/p/w342${data.poster_path}` : null,
      background: data.backdrop_path ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}` : null,
      description: data.overview || '',
      genres: (data.genres || []).map(g => g.name),
      runtime: data.runtime ? `${data.runtime} min` : undefined,
      imdbRating: data.vote_average ? String(data.vote_average) : undefined,
    };

    // Try to resolve IMDB ID one more time
    try {
      const ext = await tmdbFetch(`/${tmdbType}/${tmdbId}/external_ids`);
      if (ext.imdb_id) {
        meta.imdb_id = ext.imdb_id;
        meta.id = ext.imdb_id;
      }
    } catch { /* keep tmdb: ID */ }

    // For series, include season/episode data
    if (type === 'series' && data.seasons) {
      meta.videos = [];
      for (const season of data.seasons) {
        if (season.season_number === 0) continue; // skip specials
        try {
          const seasonData = await tmdbFetch(`/tv/${tmdbId}/season/${season.season_number}`);
          for (const ep of (seasonData.episodes || [])) {
            meta.videos.push({
              id: `tmdb:${tmdbId}:${season.season_number}:${ep.episode_number}`,
              season: season.season_number,
              episode: ep.episode_number,
              title: ep.name || `Episode ${ep.episode_number}`,
              overview: ep.overview || '',
              released: ep.air_date || undefined,
            });
          }
        } catch { /* skip season on error */ }
      }
    }

    // For movies, expose the TMDB collection so the client can auto-play the
    // next entry in a franchise when the current one ends.
    if (type === 'movie' && data.belongs_to_collection) {
      meta.collectionId = data.belongs_to_collection.id;
      meta.collectionName = data.belongs_to_collection.name;
    }

    res.json({ meta });
  } catch (err) {
    console.error('[TMDB] Meta fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch metadata' });
  }
});

// ─── TMDB Metadata by IMDB ID (replaces Cinemeta) ────────────────────

app.get('/api/tmdb-meta-imdb/:type/:imdbId', rateLimit, async (req, res) => {
  const { type, imdbId } = req.params;
  if (!/^tt\d+$/.test(imdbId) || !['movie', 'series'].includes(type)) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }

  if (!TMDB_API_KEY) {
    return res.status(503).json({ error: 'TMDB API key not configured' });
  }

  try {
    // Step 1: IMDB ID → TMDB ID
    const tmdbType = type === 'series' ? 'tv' : 'movie';
    const findResult = await tmdbFetch(`/find/${imdbId}`, { external_source: 'imdb_id' });
    const results = tmdbType === 'tv'
      ? (findResult.tv_results || [])
      : (findResult.movie_results || []);

    if (results.length === 0) {
      return res.status(404).json({ error: 'Not found on TMDB' });
    }

    const tmdbId = results[0].id;

    // Step 2: Full metadata
    const data = await tmdbFetch(`/${tmdbType}/${tmdbId}`);

    const meta = {
      id: imdbId,
      imdb_id: imdbId,
      type,
      name: tmdbType === 'movie' ? data.title : data.name,
      year: (data.release_date || data.first_air_date || '').slice(0, 4),
      poster: data.poster_path ? `https://image.tmdb.org/t/p/w342${data.poster_path}` : null,
      background: data.backdrop_path ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}` : null,
      description: data.overview || '',
      genres: (data.genres || []).map(g => g.name),
      runtime: data.runtime ? `${data.runtime} min` : undefined,
      imdbRating: data.vote_average ? String(data.vote_average) : undefined,
    };

    // For series, include season/episode data
    if (type === 'series' && data.seasons) {
      meta.videos = [];
      for (const season of data.seasons) {
        if (season.season_number === 0) continue; // skip specials
        try {
          const seasonData = await tmdbFetch(`/tv/${tmdbId}/season/${season.season_number}`);
          for (const ep of (seasonData.episodes || [])) {
            meta.videos.push({
              id: `${imdbId}:${season.season_number}:${ep.episode_number}`,
              season: season.season_number,
              episode: ep.episode_number,
              title: ep.name || `Episode ${ep.episode_number}`,
              overview: ep.overview || '',
              released: ep.air_date || undefined,
            });
          }
        } catch { /* skip season on error */ }
      }
    }

    // For movies, expose the TMDB collection so the client can auto-play the
    // next entry in a franchise when the current one ends.
    if (type === 'movie' && data.belongs_to_collection) {
      meta.collectionId = data.belongs_to_collection.id;
      meta.collectionName = data.belongs_to_collection.name;
    }

    res.json({ meta });
  } catch (err) {
    console.error('[TMDB] IMDB meta fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch metadata' });
  }
});

// ─── MusicBrainz Metadata Endpoints ─────────────────────────────────
// GET /api/mb-meta/release/:mbid  — album detail (tracklist, cover, genres)
// GET /api/mb-meta/artist/:mbid   — artist detail (bio, discography, tags)

const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.get('/api/mb-meta/:type/:mbid', rateLimit, async (req, res) => {
  const { type, mbid } = req.params;
  if (!MBID_RE.test(mbid)) {
    return res.status(400).json({ error: 'Invalid MBID' });
  }
  try {
    if (type === 'release' || type === 'album') {
      const meta = await mbGetRelease(mbid);
      if (!meta) return res.status(404).json({ error: 'Not found' });
      return res.json({ meta: { ...meta, type: 'album', id: `mbr:${meta.mbid}` } });
    }
    if (type === 'artist') {
      const meta = await mbGetArtist(mbid);
      if (!meta) return res.status(404).json({ error: 'Not found' });
      return res.json({ meta: { ...meta, type: 'artist', id: `mba:${meta.mbid}` } });
    }
    if (type === 'release-group') {
      // Resolve to a representative release, then return release metadata.
      const releaseMbid = await mbGetReleaseForGroup(mbid);
      if (!releaseMbid) return res.status(404).json({ error: 'No releases in group' });
      const meta = await mbGetRelease(releaseMbid);
      if (!meta) return res.status(404).json({ error: 'Not found' });
      return res.json({ meta: { ...meta, type: 'album', id: `mbr:${meta.mbid}`, releaseGroupMbid: mbid } });
    }
    return res.status(400).json({ error: 'Invalid type (expected release|artist|release-group)' });
  } catch (err) {
    console.error('[MB] Meta fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch music metadata' });
  }
});

// ─── Cover Art Proxy ────────────────────────────────────────────────
// coverartarchive.org 307-redirects to archive.org for every request; on a
// slow VPN this chain dominates cover-load latency and saturates parallel
// image connections. Proxy through the server with a small in-memory LRU
// cache so the first client request warms the cache and everyone else
// (plus the next page load from the same device) gets it instantly from
// both this cache and the browser's HTTP cache.

const _coverCache = new Map();              // mbid@size -> { buf, type, ts }
const _coverMisses = new Map();             // mbid@size -> ts (404s)
const COVER_CACHE_MAX = 256;                // ~256 * 500KB ≈ 130MB worst case
const COVER_CACHE_TTL = 7 * 24 * 3600 * 1000;   // 1 week
const COVER_MISS_TTL = 60 * 60 * 1000;          // 1 hour

function _coverCacheGet(key) {
  const hit = _coverCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > COVER_CACHE_TTL) { _coverCache.delete(key); return null; }
  // LRU: touch on read.
  _coverCache.delete(key); _coverCache.set(key, hit);
  return hit;
}

function _coverCacheSet(key, buf, type) {
  if (_coverCache.size >= COVER_CACHE_MAX) {
    _coverCache.delete(_coverCache.keys().next().value);
  }
  _coverCache.set(key, { buf, type, ts: Date.now() });
}

function _fetchImage(url, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const http = require('http');
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': 'AlabtrossStreaming/1.0', 'Accept': 'image/*' },
      timeout: 12000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        res.resume();
        return _fetchImage(res.headers.location, maxRedirects - 1).then(resolve, reject);
      }
      if (res.statusCode === 404) {
        res.resume();
        return resolve({ ok: false, status: 404 });
      }
      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ ok: false, status: res.statusCode });
      }
      const type = res.headers['content-type'] || 'image/jpeg';
      const chunks = [];
      let total = 0;
      const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB safety cap
      res.on('data', c => {
        total += c.length;
        if (total > MAX_IMAGE_BYTES) { res.destroy(); return reject(new Error('Image too large')); }
        chunks.push(c);
      });
      res.on('end', () => resolve({ ok: true, buf: Buffer.concat(chunks), type }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Socket timeout')); });
  });
}

const COVER_MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.get('/api/cover/release/:mbid', async (req, res) => {
  const { mbid } = req.params;
  if (!COVER_MBID_RE.test(mbid)) return res.status(400).send('Invalid MBID');
  const sizeRaw = parseInt(req.query.size, 10);
  const size = [250, 500, 1200].includes(sizeRaw) ? sizeRaw : 500;
  const key = `${mbid.toLowerCase()}@${size}`;

  // Short-TTL negative cache so we don't re-fetch 404s on every card render.
  const miss = _coverMisses.get(key);
  if (miss && Date.now() - miss < COVER_MISS_TTL) {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(404).end();
  }

  const hit = _coverCacheGet(key);
  if (hit) {
    res.setHeader('Content-Type', hit.type);
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.setHeader('X-Cache', 'HIT');
    return res.end(hit.buf);
  }

  try {
    const upstream = `https://coverartarchive.org/release/${mbid}/front-${size}`;
    const result = await _fetchImage(upstream);
    if (!result.ok) {
      if (result.status === 404) {
        _coverMisses.set(key, Date.now());
        if (_coverMisses.size > 1000) _coverMisses.delete(_coverMisses.keys().next().value);
      }
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(result.status || 502).end();
    }
    _coverCacheSet(key, result.buf, result.type);
    res.setHeader('Content-Type', result.type);
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.setHeader('X-Cache', 'MISS');
    res.end(result.buf);
  } catch (err) {
    console.warn('[CoverProxy] fetch failed:', err.message);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.status(502).end();
  }
});

// ─── Music Library Helpers ──────────────────────────────────────────

// GET /api/library/music/genres — group album library items by genre
app.get('/api/library/music/genres', (req, res) => {
  try {
    res.json({ genres: musicLibrary.getMusicGenres() });
  } catch (err) {
    console.error('[Music] genres error:', err.message);
    res.status(500).json({ error: 'Failed to compute genres' });
  }
});

// POST /api/library/music/:id/genre  body: { genre: "..." }
app.post('/api/library/music/:id/genre', rateLimit, express.json(), (req, res) => {
  const { id } = req.params;
  const genre = (req.body && req.body.genre) || '';
  const ok = musicLibrary.setMusicGenre(id, genre);
  if (!ok) return res.status(404).json({ error: 'Album not found' });
  res.json({ ok: true, genre });
});

// POST /api/library/music/:id/favorite — toggle favorite
app.post('/api/library/music/:id/favorite', rateLimit, (req, res) => {
  const { id } = req.params;
  const result = musicLibrary.toggleMusicFavorite(id);
  if (result === null) return res.status(404).json({ error: 'Album not found' });
  res.json({ ok: true, favorite: result });
});

// POST /api/library/music/:id/played — increment playCount, update lastPlayedAt
app.post('/api/library/music/:id/played', rateLimit, (req, res) => {
  const { id } = req.params;
  const ok = musicLibrary.markMusicPlayed(id);
  if (!ok) return res.status(404).json({ error: 'Album not found' });
  res.json({ ok: true });
});

// ─── Music Library (separate LibraryManager instance, disk sibling) ────
// These mirror /api/library/* but hit the music-specific instance so the
// metadata file, on-disk folder layout, and ingest path stay separate
// from movies/series. Music items are always type: 'album'.

// GET /api/music-library — list music library items
app.get('/api/music-library', (req, res) => {
  res.json({ items: musicLibrary.getAll() });
});

// GET /api/music-library/:id — fetch a single music item
app.get('/api/music-library/:id', (req, res) => {
  const item = musicLibrary.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  res.json({ item });
});

// POST /api/music-library/add — add an album from a torrent to the music library
// body: { magnetUri, infoHash, mbid, title, artist, coverUrl, year, genres? }
app.post('/api/music-library/add', rateLimit, express.json(), (req, res) => {
  const b = req.body || {};
  if (!b.infoHash || !b.magnetUri) {
    return res.status(400).json({ error: 'infoHash and magnetUri are required' });
  }
  if (!/^[0-9a-f]{40}$/i.test(b.infoHash)) {
    return res.status(400).json({ error: 'Invalid infoHash' });
  }
  try {
    const result = musicLibrary.addItem({
      type: 'album',
      infoHash: b.infoHash.toLowerCase(),
      magnetUri: b.magnetUri,
      mbid: b.mbid || null,
      artistMbid: b.artistMbid || null,
      name: [b.artist, b.title].filter(Boolean).join(' — ') || b.title || 'Album',
      title: b.title || '',
      artist: b.artist || '',
      year: b.year || '',
      coverUrl: b.coverUrl || '',
      genres: Array.isArray(b.genres) ? b.genres : [],
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[MusicLibrary] add error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/music-library/:id
app.delete('/api/music-library/:id', rateLimit, (req, res) => {
  const ok = musicLibrary.removeItem(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Item not found' });
  res.json({ ok: true });
});

// POST /api/music-library/:id/pause | /resume | /retry
app.post('/api/music-library/:id/pause', rateLimit, (req, res) => {
  const ok = musicLibrary.pauseItem(req.params.id);
  res.json({ ok });
});
app.post('/api/music-library/:id/resume', rateLimit, (req, res) => {
  const ok = musicLibrary.resumeItem(req.params.id);
  res.json({ ok });
});
app.post('/api/music-library/:id/retry', rateLimit, (req, res) => {
  const ok = musicLibrary.retryItem(req.params.id);
  res.json({ ok });
});

// GET /api/music-library/:id/stream?track=N — stream a specific track file
app.get('/api/music-library/:id/stream', async (req, res) => {
  const item = musicLibrary.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.status !== 'complete') {
    return res.status(400).json({ error: 'Download not complete' });
  }
  const trackIndex = req.query.track !== undefined
    ? parseInt(req.query.track, 10)
    : 0;
  if (!Number.isInteger(trackIndex) || trackIndex < 0) {
    return res.status(400).json({ error: 'Invalid track index' });
  }
  const filePath = musicLibrary.getTrackFilePath(req.params.id, trackIndex);
  if (!filePath) return res.status(404).json({ error: 'Track file not found' });

  let stat;
  try { stat = await fs.promises.stat(filePath); }
  catch { return res.status(404).json({ error: 'Track file not found on disk' }); }

  const fileSize = stat.size;
  const mimeType = musicLibrary.getMimeType(filePath);
  const safeFilename = path.basename(filePath)
    .replace(/[^\w\s.\-()[\]]/g, '_').replace(/["\\]/g, '_').substring(0, 200);

  const headers = {
    'Content-Type': mimeType,
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename="${safeFilename}"`,
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
  };

  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    if (isNaN(start) || isNaN(end) || start >= fileSize || end >= fileSize || start > end) {
      return res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
    }
    res.status(206).set({
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': end - start + 1,
    });
    const stream = fs.createReadStream(filePath, { start, end });
    stream.pipe(res);
    stream.on('error', () => res.end());
    res.on('close', () => stream.destroy());
  } else {
    res.status(200).set({ ...headers, 'Content-Length': fileSize });
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('error', () => res.end());
    res.on('close', () => stream.destroy());
  }
});

// ─── Music Playlists ────────────────────────────────────────────────

app.get('/api/music/playlists', (req, res) => {
  res.json({ playlists: musicPlaylists.list() });
});

app.post('/api/music/playlists', rateLimit, express.json(), (req, res) => {
  try {
    const pl = musicPlaylists.create((req.body && req.body.name) || '');
    res.json({ playlist: pl });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/music/playlists/:id', rateLimit, express.json(), (req, res) => {
  try {
    const pl = musicPlaylists.rename(req.params.id, (req.body && req.body.name) || '');
    if (!pl) return res.status(404).json({ error: 'Playlist not found' });
    res.json({ playlist: pl });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/music/playlists/:id', rateLimit, (req, res) => {
  const ok = musicPlaylists.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Playlist not found' });
  res.json({ ok: true });
});

app.post('/api/music/playlists/:id/items', rateLimit, express.json(), (req, res) => {
  try {
    const { albumId, trackIndex } = req.body || {};
    const pl = musicPlaylists.addItem(req.params.id, albumId, trackIndex);
    if (!pl) return res.status(404).json({ error: 'Playlist not found' });
    res.json({ playlist: pl });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/music/playlists/:id/items/reorder', rateLimit, express.json(), (req, res) => {
  try {
    const { from, to } = req.body || {};
    const pl = musicPlaylists.reorderItem(req.params.id, from, to);
    if (!pl) return res.status(404).json({ error: 'Playlist not found' });
    res.json({ playlist: pl });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/music/playlists/:id/items/:index', rateLimit, (req, res) => {
  try {
    const index = parseInt(req.params.index, 10);
    const pl = musicPlaylists.removeItem(req.params.id, index);
    if (!pl) return res.status(404).json({ error: 'Playlist not found' });
    res.json({ playlist: pl });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Collection / Franchise Grouping ─────────────────────────────────

const COLLECTION_CACHE_PATH = path.join(TORRENT_CACHE_PATH, 'collection-cache.json');
let collectionCache = {}; // imdbId -> { collectionId, collectionName, collectionPoster, genres, year } | null

// Load persistent collection cache
try {
  if (fs.existsSync(COLLECTION_CACHE_PATH)) {
    collectionCache = JSON.parse(fs.readFileSync(COLLECTION_CACHE_PATH, 'utf8'));
    // Purge stale null entries and entries missing genres so they get re-fetched
    const beforeCount = Object.keys(collectionCache).length;
    for (const key of Object.keys(collectionCache)) {
      if (!collectionCache[key] || !collectionCache[key].genres) {
        delete collectionCache[key];
      }
    }
    const purged = beforeCount - Object.keys(collectionCache).length;
    console.log(`[Collections] Loaded cache with ${Object.keys(collectionCache).length} entries${purged > 0 ? ` (purged ${purged} stale entries)` : ''}`);
  }
} catch (e) {
  console.warn('[Collections] Failed to load cache:', e.message);
}

function saveCollectionCache() {
  try {
    fs.writeFileSync(COLLECTION_CACHE_PATH, JSON.stringify(collectionCache), 'utf8');
  } catch (e) {
    console.warn('[Collections] Failed to save cache:', e.message);
  }
}

// Title-based franchise detection (works without TMDB)
const FRANCHISE_PATTERNS = [
  { pattern: /^star\s*wars/i, name: 'Star Wars Collection', id: 'franchise_starwars' },
  { pattern: /^avatar/i, name: 'Avatar Collection', id: 'franchise_avatar', exclude: /avatar:\s*the\s*last\s*air/i },
  { pattern: /^indiana\s*jones|^raiders\s*of\s*the\s*lost\s*ark/i, name: 'Indiana Jones Collection', id: 'franchise_indianajones' },
  { pattern: /james\s*bond|^0{0,2}7\b|^dr\.?\s*no$|^goldfinger$|^thunderball$|^goldeneye$|^skyfall$|^spectre$|^casino\s*royale|^quantum\s*of\s*solace|^no\s*time\s*to\s*die|^die\s*another\s*day|^tomorrow\s*never\s*dies|^the\s*world\s*is\s*not\s*enough|^licence\s*to\s*kill|^the\s*living\s*daylights|^a\s*view\s*to\s*a\s*kill|^octopussy|^for\s*your\s*eyes\s*only|^moonraker|^the\s*spy\s*who\s*loved\s*me|^the\s*man\s*with\s*the\s*golden\s*gun|^live\s*and\s*let\s*die|^diamonds\s*are\s*forever|^on\s*her\s*majesty/i, name: 'James Bond Collection', id: 'franchise_jamesbond' },
  { pattern: /^pirates\s*of\s*the\s*caribbean/i, name: 'Pirates of the Caribbean Collection', id: 'franchise_potc' },
  { pattern: /^the\s*lord\s*of\s*the\s*rings|^the\s*hobbit/i, name: 'Middle-earth Collection', id: 'franchise_middleearth' },
  { pattern: /^harry\s*potter|^fantastic\s*beasts/i, name: 'Wizarding World Collection', id: 'franchise_wizardingworld' },
  { pattern: /^the\s*hunger\s*games/i, name: 'The Hunger Games Collection', id: 'franchise_hungergames' },
  { pattern: /^transformers/i, name: 'Transformers Collection', id: 'franchise_transformers' },
  { pattern: /^mission:?\s*impossible/i, name: 'Mission: Impossible Collection', id: 'franchise_mi' },
  { pattern: /^fast\s*(&|and)\s*furious|^the\s*fast\s*(and|&)\s*(the\s*)?furious|^furious\s*\d|^f\d|^fast\s*five|^fast\s*x/i, name: 'Fast & Furious Collection', id: 'franchise_fastandfurious' },
  { pattern: /^jurassic\s*(park|world)/i, name: 'Jurassic Collection', id: 'franchise_jurassic' },
  { pattern: /^the\s*matrix/i, name: 'The Matrix Collection', id: 'franchise_matrix' },
  { pattern: /^john\s*wick/i, name: 'John Wick Collection', id: 'franchise_johnwick' },
  { pattern: /^toy\s*story/i, name: 'Toy Story Collection', id: 'franchise_toystory' },
  { pattern: /^shrek/i, name: 'Shrek Collection', id: 'franchise_shrek' },
  { pattern: /^ice\s*age/i, name: 'Ice Age Collection', id: 'franchise_iceage' },
  { pattern: /^despicable\s*me|^minions/i, name: 'Despicable Me Collection', id: 'franchise_despicableme' },
  { pattern: /^kung\s*fu\s*panda/i, name: 'Kung Fu Panda Collection', id: 'franchise_kungfupanda' },
  { pattern: /^how\s*to\s*train\s*your\s*dragon/i, name: 'How to Train Your Dragon Collection', id: 'franchise_httyd' },
  { pattern: /^madagascar/i, name: 'Madagascar Collection', id: 'franchise_madagascar' },
  { pattern: /^the\s*dark\s*knight|^batman\s*begins/i, name: 'The Dark Knight Collection', id: 'franchise_darkknight' },
  { pattern: /^spider-?\s*man|^the\s*amazing\s*spider/i, name: 'Spider-Man Collection', id: 'franchise_spiderman' },
  { pattern: /^x-?\s*men|^logan$|^deadpool|^the\s*wolverine/i, name: 'X-Men Collection', id: 'franchise_xmen' },
  { pattern: /^guardians\s*of\s*the\s*galaxy/i, name: 'Guardians of the Galaxy Collection', id: 'franchise_gotg' },
  { pattern: /^captain\s*america/i, name: 'Captain America Collection', id: 'franchise_captainamerica' },
  { pattern: /^iron\s*man/i, name: 'Iron Man Collection', id: 'franchise_ironman' },
  { pattern: /^thor\s*(:|$)/i, name: 'Thor Collection', id: 'franchise_thor' },
  { pattern: /^the\s*avengers|^avengers/i, name: 'The Avengers Collection', id: 'franchise_avengers' },
  { pattern: /^alien\s*(:|$)|^aliens$|^alien\s*3|^alien\s*resurr|^prometheus|^alien:\s*covenant|^alien:\s*romulus/i, name: 'Alien Collection', id: 'franchise_alien' },
  { pattern: /^terminator/i, name: 'Terminator Collection', id: 'franchise_terminator' },
  { pattern: /^rocky\s|^rocky$|^creed/i, name: 'Rocky / Creed Collection', id: 'franchise_rocky' },
  { pattern: /^the\s*godfather/i, name: 'The Godfather Collection', id: 'franchise_godfather' },
  { pattern: /^back\s*to\s*the\s*future/i, name: 'Back to the Future Collection', id: 'franchise_bttf' },
  { pattern: /^ghostbusters/i, name: 'Ghostbusters Collection', id: 'franchise_ghostbusters' },
  { pattern: /^the\s*conjuring|^annabelle|^the\s*nun/i, name: 'The Conjuring Universe', id: 'franchise_conjuring' },
  { pattern: /^saw\s/i, name: 'Saw Collection', id: 'franchise_saw' },
  { pattern: /^happy\s*gilmore|^billy\s*madison|^the\s*waterboy|^big\s*daddy|^mr\.?\s*deeds|^click$|^grown\s*ups|^you\s*don.t\s*mess\s*with\s*the\s*zohan|^just\s*go\s*with\s*it|^blended$|^the\s*longest\s*yard.*2005|^50\s*first\s*dates/i, name: 'Adam Sandler Comedies', id: 'franchise_sandler' },
  { pattern: /^a\s*knight.s\s*tale/i, name: null, id: null }, // Not a franchise
];

function matchFranchiseByTitle(title) {
  if (!title) return null;
  for (const f of FRANCHISE_PATTERNS) {
    if (f.exclude && f.exclude.test(title)) continue;
    if (f.pattern.test(title)) {
      if (!f.id) return null; // Explicit non-franchise
      return { collectionId: f.id, collectionName: f.name, collectionPoster: null };
    }
  }
  return null;
}

// In-memory cache for full collection details (1-hour TTL)
const collectionDetailCache = new Map();
const COLLECTION_DETAIL_TTL = 60 * 60 * 1000;

async function lookupCollectionForImdbId(imdbId) {
  // Already cached — but re-fetch if missing genres (old cache format)
  // null entries are from errors/old format and should be retried
  if (imdbId in collectionCache) {
    const cached = collectionCache[imdbId];
    if (cached?.genres) return cached;
    // null or old cache entry without genres — re-fetch
  }

  try {
    // Step 1: IMDB ID -> TMDB movie ID
    const findResult = await tmdbFetch(`/find/${imdbId}`, { external_source: 'imdb_id' });
    const movieResults = findResult.movie_results || [];
    if (movieResults.length === 0) {
      collectionCache[imdbId] = { collectionId: null, genres: [], year: '' };
      return collectionCache[imdbId];
    }
    const tmdbId = movieResults[0].id;

    // Step 2: Get movie details including belongs_to_collection and genres
    const movieDetail = await tmdbFetch(`/movie/${tmdbId}`);
    const genres = (movieDetail.genres || []).map(g => g.name);
    const year = (movieDetail.release_date || '').slice(0, 4);
    const col = movieDetail.belongs_to_collection;

    if (!col) {
      // No collection, but still store genres/year for genre grouping
      collectionCache[imdbId] = { collectionId: null, genres, year };
      return collectionCache[imdbId];
    }

    const entry = {
      collectionId: col.id,
      collectionName: col.name,
      collectionPoster: col.poster_path ? `https://image.tmdb.org/t/p/w342${col.poster_path}` : null,
      genres,
      year,
    };
    collectionCache[imdbId] = entry;
    return entry;
  } catch (e) {
    console.warn(`[Collections] TMDB lookup failed for ${imdbId}:`, e.message);
    // Don't cache errors — allow retry on next request
    return null;
  }
}

// GET /api/collections/enrich?ids=tt123,tt456,...&names=Movie+One,Movie+Two,...
// Per-request IMDb-ID cap. The client chunks larger libraries into multiple
// requests; this cap keeps any single request inside the TMDB rate budget
// and the client-side 15s fetch timeout (~5 parallel TMDB calls per batch
// with a 300ms gap → ~200 IDs finish well under 15s).
const COLLECTIONS_ENRICH_MAX_IDS = 200;
app.get('/api/collections/enrich', rateLimit, async (req, res) => {
  const idsParam = (req.query.ids || '').trim();
  const namesParam = (req.query.names || '').trim();
  if (!idsParam) return res.json({ collections: {} });

  const ids = idsParam.split(',').filter(id => /^tt\d+$/.test(id)).slice(0, COLLECTIONS_ENRICH_MAX_IDS);
  if (ids.length === 0) return res.json({ collections: {} });

  const names = namesParam ? namesParam.split('||') : [];

  // Try TMDB enrichment first (if API key is configured)
  let tmdbWorked = false;
  if (TMDB_API_KEY) {
    const batchSize = 5;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      await Promise.allSettled(batch.map(id => lookupCollectionForImdbId(id)));
      if (i + batchSize < ids.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }
    saveCollectionCache();
    // Check if TMDB returned any real results
    tmdbWorked = ids.some(id => collectionCache[id] && collectionCache[id].collectionId);
  }

  // Build response: group by collection + per-movie metadata (genres, year)
  const collections = {};
  const movieMeta = {}; // imdbId -> { genres: [...], year: "2005" }

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    let entry = collectionCache[id];

    // Fallback to title-based matching if no collection found via TMDB
    if ((!entry || !entry.collectionId) && names[i]) {
      const titleMatch = matchFranchiseByTitle(names[i]);
      if (titleMatch) {
        // Merge: keep genres/year from TMDB cache if available
        entry = { ...titleMatch, genres: entry?.genres || [], year: entry?.year || '' };
      }
    }

    // Apply manual category overrides
    const manual = manualCategories[id];
    if (manual) {
      if (manual.genre) {
        const genres = entry?.genres || [];
        if (!genres.includes(manual.genre)) genres.unshift(manual.genre);
        entry = entry || { collectionId: null, genres, year: '' };
        entry.genres = genres;
      }
      if (manual.collectionId) {
        entry = entry || { genres: [], year: '' };
        entry.collectionId = manual.collectionId;
        entry.collectionName = manual.collectionName;
      }
    }

    // Store per-movie metadata (genres, year) for genre grouping
    movieMeta[id] = { genres: entry?.genres || [], year: entry?.year || '' };

    if (!entry || !entry.collectionId) continue;
    const key = String(entry.collectionId);
    if (!collections[key]) {
      collections[key] = {
        name: entry.collectionName,
        poster: entry.collectionPoster,
        movieIds: [],
      };
    }
    if (!collections[key].movieIds.includes(id)) {
      collections[key].movieIds.push(id);
    }
  }

  console.log(`[Collections] Enriched ${ids.length} IDs -> ${Object.keys(collections).length} collections (TMDB: ${tmdbWorked ? 'yes' : 'no'})`);
  res.json({ collections, movieMeta });
});

// GET /api/collections/:collectionId
app.get('/api/collections/:collectionId', rateLimit, async (req, res) => {
  const collectionId = parseInt(req.params.collectionId, 10);
  if (isNaN(collectionId)) return res.status(400).json({ error: 'Invalid collection ID' });

  // Check in-memory cache
  const cached = collectionDetailCache.get(collectionId);
  if (cached && Date.now() - cached.ts < COLLECTION_DETAIL_TTL) {
    return res.json(cached.data);
  }

  try {
    const detail = await tmdbFetch(`/collection/${collectionId}`);
    const parts = detail.parts || [];

    // Fetch IMDB IDs for all movies in the collection (batch 5 at a time)
    const movies = [];
    for (let i = 0; i < parts.length; i += 5) {
      const batch = parts.slice(i, i + 5);
      const results = await Promise.allSettled(batch.map(async (part) => {
        try {
          const ext = await tmdbFetch(`/movie/${part.id}/external_ids`);
          return {
            imdb_id: ext.imdb_id || null,
            name: part.title,
            year: (part.release_date || '').slice(0, 4),
            poster: part.poster_path ? `https://image.tmdb.org/t/p/w342${part.poster_path}` : null,
            overview: part.overview || '',
          };
        } catch {
          return {
            imdb_id: null,
            name: part.title,
            year: (part.release_date || '').slice(0, 4),
            poster: part.poster_path ? `https://image.tmdb.org/t/p/w342${part.poster_path}` : null,
            overview: part.overview || '',
          };
        }
      }));
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.imdb_id) {
          movies.push(r.value);
        }
      }
      if (i + 5 < parts.length) await new Promise(r => setTimeout(r, 300));
    }

    // Sort by year
    movies.sort((a, b) => (a.year || '9999').localeCompare(b.year || '9999'));

    const data = {
      name: detail.name,
      poster: detail.poster_path ? `https://image.tmdb.org/t/p/w342${detail.poster_path}` : null,
      movies,
    };

    // Evict stale entries to prevent unbounded cache growth
    if (collectionDetailCache.size > 200) {
      const now = Date.now();
      for (const [key, val] of collectionDetailCache) {
        if (now - val.ts > COLLECTION_DETAIL_TTL) collectionDetailCache.delete(key);
      }
    }
    collectionDetailCache.set(collectionId, { ts: Date.now(), data });
    res.json(data);
  } catch (err) {
    console.error('[Collections] Detail fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch collection details' });
  }
});

// ─── Manual Category Overrides ───────────────────────────────────────

const MANUAL_CATEGORIES_PATH = path.join(TORRENT_CACHE_PATH, 'manual-categories.json');
let manualCategories = {}; // imdbId -> { genre: "Comedy" } or { collectionId: "...", collectionName: "..." }

try {
  if (fs.existsSync(MANUAL_CATEGORIES_PATH)) {
    manualCategories = JSON.parse(fs.readFileSync(MANUAL_CATEGORIES_PATH, 'utf8'));
    console.log(`[Categories] Loaded ${Object.keys(manualCategories).length} manual overrides`);
  }
} catch (e) {
  console.warn('[Categories] Failed to load manual categories:', e.message);
}

function saveManualCategories() {
  try {
    fs.writeFileSync(MANUAL_CATEGORIES_PATH, JSON.stringify(manualCategories), 'utf8');
  } catch (e) {
    console.warn('[Categories] Failed to save manual categories:', e.message);
  }
}

// POST /api/library/categorize - manually assign a genre or collection to a movie
app.post('/api/library/categorize', rateLimit, (req, res) => {
  const { imdbId, genre, collectionId, collectionName } = req.body || {};
  if (!imdbId) return res.status(400).json({ error: 'imdbId is required' });

  if (genre) {
    manualCategories[imdbId] = { genre };
    // Also update the collection cache so the genre persists for enrichment
    if (collectionCache[imdbId]) {
      if (!collectionCache[imdbId].genres) collectionCache[imdbId].genres = [];
      if (!collectionCache[imdbId].genres.includes(genre)) {
        collectionCache[imdbId].genres.unshift(genre);
      }
    } else {
      collectionCache[imdbId] = { collectionId: null, genres: [genre], year: '' };
    }
    saveCollectionCache();
  } else if (collectionId && collectionName) {
    manualCategories[imdbId] = { collectionId, collectionName };
  } else {
    return res.status(400).json({ error: 'Provide genre or collectionId+collectionName' });
  }

  saveManualCategories();
  console.log(`[Categories] Manual override for ${imdbId}:`, manualCategories[imdbId]);
  res.json({ ok: true });
});

// DELETE /api/library/categorize/:imdbId - remove manual category override
app.delete('/api/library/categorize/:imdbId', rateLimit, (req, res) => {
  const { imdbId } = req.params;
  delete manualCategories[imdbId];
  saveManualCategories();
  res.json({ ok: true });
});

// GET /api/library/categories - get all manual category overrides
app.get('/api/library/categories', (req, res) => {
  res.json(manualCategories);
});

// ─── Custom Mode API Routes ───────────────────────────────────────────

// Helper: resolve a tmdb: ID to an IMDB ID via TMDB external_ids
async function resolveTmdbToImdb(tmdbId, type) {
  if (!TMDB_API_KEY) return null;
  try {
    const tmdbType = type === 'series' ? 'tv' : 'movie';
    const ext = await tmdbFetch(`/${tmdbType}/${tmdbId}/external_ids`);
    return ext.imdb_id || null;
  } catch {
    return null;
  }
}

/**
 * Search TMDB for a TV show by name and return the best match's metadata.
 * If the full name doesn't produce a good match, progressively drops trailing
 * words and retries (e.g. "Naruto Shippuden Cuarta Guerra Mundial Shinobi"
 * -> "Naruto Shippuden Cuarta Guerra Mundial" -> ... -> "Naruto Shippuden").
 * Returns { imdbId, poster, year, name } or null if not found.
 */
async function lookupShowByName(showName) {
  if (!TMDB_API_KEY || !showName) return null;

  // Strip trailing year in parentheses e.g. "Mad Men (2007)" -> "Mad Men"
  const cleaned = showName.trim().replace(/\s*\(\d{4}\)\s*$/, '').replace(/\s+\d{4}\s*$/, '');
  const words = cleaned.split(/\s+/);
  // Try the full name first, then progressively shorter (minimum 2 words)
  for (let len = words.length; len >= Math.min(2, words.length); len--) {
    const query = words.slice(0, len).join(' ');
    try {
      const data = await tmdbFetch('/search/tv', { query, include_adult: 'false' });
      const results = data.results || [];
      if (results.length === 0) continue;

      // Pick the best match by relevance score against the query used
      results.sort((a, b) => relevanceScore(b.name || '', query) - relevanceScore(a.name || '', query));
      const best = results[0];

      // Require a minimum relevance to avoid false matches on short queries
      const score = relevanceScore(best.name || '', query);
      if (score < 0.3 && len < words.length) continue;

      // Resolve IMDB ID
      const ext = await tmdbFetch(`/tv/${best.id}/external_ids`);
      const imdbId = ext.imdb_id || null;
      const poster = best.poster_path
        ? `https://image.tmdb.org/t/p/w342${best.poster_path}`
        : null;
      const year = (best.first_air_date || '').slice(0, 4);

      console.log(`[TMDB] lookupShowByName("${showName}") matched "${best.name}" using query "${query}"`);
      return { imdbId, poster, year, name: best.name || showName };
    } catch (err) {
      console.warn(`[TMDB] lookupShowByName query="${query}" failed:`, err.message);
    }
  }
  return null;
}

/**
 * Compute word-level overlap between two titles, normalized to lowercase and
 * stripped of punctuation. Returns the fraction of common words over the
 * larger of the two word counts — i.e. both "missing words" (query has more
 * than title) and "extra words" (title has more than query) drag the score
 * down. Used to sanity-check TMDB matches: a low overlap means the match is
 * a different movie that just happened to share a word.
 */
function titleWordOverlap(a, b) {
  const norm = s => normalizeForMatch(s)
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const wa = norm(a), wb = norm(b);
  if (wa.length === 0 || wb.length === 0) return 0;
  const common = wa.filter(w => wb.includes(w)).length;
  return common / Math.max(wa.length, wb.length);
}

/**
 * Search TMDB for a movie by name (and optional year hint) and return the
 * best match's metadata. Like lookupShowByName, it progressively drops trailing
 * words if the full query doesn't produce a confident match. If the year-scoped
 * search comes up empty the query is retried without the year filter.
 *
 * Guards against wrong matches:
 *   1. Word-overlap floor (0.5): the match's title must share at least half
 *      its words with the cleaned query. Rejects e.g. "Avatar Fire and Ash"
 *      matching "Avatar: The Way of Water" (only "avatar" in common).
 *   2. Year delta (±2): if both a filename year hint and the TMDB release
 *      year are present and differ by more than 2 years, reject. Catches the
 *      case where TMDB returns a related movie from a different era.
 *
 * Returns { imdbId, poster, year, name } or null if not found.
 */
async function lookupMovieByName(movieName, yearHint) {
  if (!TMDB_API_KEY || !movieName) return null;

  // Strip trailing year in parentheses e.g. "Inception (2010)" -> "Inception"
  const cleaned = movieName.trim().replace(/\s*\(\d{4}\)\s*$/, '').replace(/\s+\d{4}\s*$/, '');
  const words = cleaned.split(/\s+/);
  for (let len = words.length; len >= Math.min(2, words.length); len--) {
    const query = words.slice(0, len).join(' ');
    try {
      const params = { query, include_adult: 'false' };
      if (yearHint) params.year = yearHint;
      let data = await tmdbFetch('/search/movie', params);
      let results = data.results || [];
      // If a year filter yielded nothing, retry without the year
      if (results.length === 0 && yearHint) {
        data = await tmdbFetch('/search/movie', { query, include_adult: 'false' });
        results = data.results || [];
      }
      if (results.length === 0) continue;

      // Rank against the FULL cleaned title, not the progressively-trimmed
      // query — otherwise shortening "Avatar Fire and Ash" down to "Avatar"
      // would pick "Avatar" (2009) as a 1.0 match.
      results.sort((a, b) => relevanceScore(b.title || '', cleaned) - relevanceScore(a.title || '', cleaned));
      const best = results[0];

      // Word-overlap sanity check (see titleWordOverlap comment).
      const overlap = titleWordOverlap(cleaned, best.title || '');
      if (overlap < 0.5) {
        console.log(`[TMDB] lookupMovieByName: rejected "${best.title}" for "${movieName}" — word overlap ${overlap.toFixed(2)} < 0.5`);
        continue;
      }

      // Year-delta sanity check.
      const bestYear = (best.release_date || '').slice(0, 4);
      if (yearHint && bestYear && Math.abs(parseInt(yearHint, 10) - parseInt(bestYear, 10)) > 2) {
        console.log(`[TMDB] lookupMovieByName: rejected "${best.title}" (${bestYear}) for "${movieName}" — year delta ${Math.abs(parseInt(yearHint, 10) - parseInt(bestYear, 10))} > 2`);
        continue;
      }

      const ext = await tmdbFetch(`/movie/${best.id}/external_ids`);
      const imdbId = ext.imdb_id || null;
      const poster = best.poster_path
        ? `https://image.tmdb.org/t/p/w342${best.poster_path}`
        : null;
      const year = (best.release_date || '').slice(0, 4);

      console.log(`[TMDB] lookupMovieByName("${movieName}") matched "${best.title}" (${year}) using query "${query}" overlap=${overlap.toFixed(2)}`);
      return { imdbId, poster, year, name: best.title || movieName };
    } catch (err) {
      console.warn(`[TMDB] lookupMovieByName query="${query}" failed:`, err.message);
    }
  }
  return null;
}

/**
 * Resolve a TMDB result to an IMDB id with a small per-run memoization so
 * the auto-matcher doesn't fetch external_ids for the same TMDB id twice
 * when it turns up in candidates for multiple episodes in a pack.
 */
function _makeExtIdCache() {
  const cache = new Map();
  return async function resolveImdbId(mediaType, tmdbId) {
    const key = `${mediaType}:${tmdbId}`;
    if (cache.has(key)) return cache.get(key);
    try {
      const ext = await tmdbFetch(`/${mediaType}/${tmdbId}/external_ids`);
      const id = ext.imdb_id || null;
      cache.set(key, id);
      return id;
    } catch {
      cache.set(key, null);
      return null;
    }
  };
}

/**
 * Search TMDB for the top candidates for a name, returning both the best
 * match (if any) and up to 5 ranked alternatives. Used by the auto-match
 * pipeline so the UI can render one-click options for items that don't
 * clear the confidence threshold.
 *
 * Returns:
 *   {
 *     best: { imdbId, tmdbId, poster, year, name, type } | null,
 *     confidence: 0..1,   // relevance × overlap × yearMatch
 *     candidates: [ { imdbId, tmdbId, name, year, poster, type, score, overlap } ]
 *   }
 */
async function searchCandidates(kind, query, yearHint, extIdCache) {
  if (!TMDB_API_KEY || !query) return { best: null, confidence: 0, candidates: [] };
  const mediaType = kind === 'series' ? 'tv' : 'movie';
  const resolveImdbId = extIdCache || _makeExtIdCache();

  const cleaned = (query || '').trim()
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .replace(/\s+\d{4}\s*$/, '');
  if (!cleaned) return { best: null, confidence: 0, candidates: [] };

  try {
    const params = { query: cleaned, include_adult: 'false' };
    if (yearHint && mediaType === 'movie') params.year = yearHint;
    if (yearHint && mediaType === 'tv') params.first_air_date_year = yearHint;

    let data = await tmdbFetch(`/search/${mediaType}`, params);
    let results = data.results || [];

    // If the year filter killed all results, retry without it.
    if (results.length === 0 && yearHint) {
      data = await tmdbFetch(`/search/${mediaType}`, { query: cleaned, include_adult: 'false' });
      results = data.results || [];
    }

    // If still nothing, try progressively shorter queries (2+ words).
    if (results.length === 0) {
      const words = cleaned.split(/\s+/);
      for (let len = words.length - 1; len >= Math.min(2, words.length); len--) {
        const shorter = words.slice(0, len).join(' ');
        try {
          const r = await tmdbFetch(`/search/${mediaType}`, { query: shorter, include_adult: 'false' });
          if ((r.results || []).length > 0) { results = r.results; break; }
        } catch { /* try next */ }
      }
    }

    if (results.length === 0) return { best: null, confidence: 0, candidates: [] };

    // Rank results by relevance to the cleaned query.
    const ranked = results
      .map(r => {
        const name = mediaType === 'movie' ? (r.title || '') : (r.name || '');
        const year = (mediaType === 'movie' ? r.release_date : r.first_air_date || '').slice(0, 4);
        const score = relevanceScore(name, cleaned);
        const overlap = titleWordOverlap(cleaned, name);
        return { tmdbId: r.id, name, year, poster_path: r.poster_path, score, overlap };
      })
      .sort((a, b) => b.score - a.score);

    const top = ranked.slice(0, 5);

    // Resolve IMDB ids for the top 5 (parallel, with memoization).
    await Promise.all(top.map(async (c) => {
      c.imdbId = await resolveImdbId(mediaType, c.tmdbId);
    }));

    // Prefer IMDb-backed entries over TMDB-only ones (often fan/unofficial
    // duplicates). Stable sort preserves relevance order within each group.
    top.sort((a, b) => {
      const aHas = a.imdbId ? 1 : 0;
      const bHas = b.imdbId ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas;
      return b.score - a.score;
    });

    const candidates = top.map(c => ({
      imdbId: c.imdbId || null,
      tmdbId: c.tmdbId,
      name: c.name,
      year: c.year,
      poster: c.poster_path ? `https://image.tmdb.org/t/p/w342${c.poster_path}` : null,
      type: kind,
      score: Number(c.score.toFixed(3)),
      overlap: Number(c.overlap.toFixed(3)),
    }));

    const topPick = candidates[0];
    if (!topPick) return { best: null, confidence: 0, candidates: [] };

    // Confidence combines:
    //   - relevance (how well the TMDB title matches our query)
    //   - word overlap (penalizes "Avatar" matching "Avatar Fire and Ash")
    //   - year agreement (boost when yearHint matches ±1)
    //   - imdb availability (modest boost — matched items need an imdbId)
    let confidence = topPick.score * 0.6 + topPick.overlap * 0.4;
    if (yearHint && topPick.year) {
      const delta = Math.abs(parseInt(yearHint, 10) - parseInt(topPick.year, 10));
      if (delta <= 1) confidence = Math.min(1, confidence + 0.08);
      else if (delta > 2) confidence = Math.max(0, confidence - 0.2);
    }
    if (topPick.imdbId) confidence = Math.min(1, confidence + 0.05);
    // A clear runner-up eats into confidence — if the #2 is within 10% of #1,
    // we're not sure enough to auto-apply.
    if (candidates.length >= 2) {
      const gap = topPick.score - candidates[1].score;
      if (gap < 0.08) confidence = Math.min(confidence, 0.75);
    }

    const best = topPick.imdbId
      ? { imdbId: topPick.imdbId, tmdbId: topPick.tmdbId, name: topPick.name, year: topPick.year, poster: topPick.poster, type: kind }
      : null;

    return { best, confidence: Number(confidence.toFixed(3)), candidates };
  } catch (err) {
    console.warn(`[TMDB] searchCandidates(${kind}, "${query}") failed:`, err.message);
    return { best: null, confidence: 0, candidates: [] };
  }
}

/**
 * Auto-match a single library item. Runs parseFileName → searchCandidates,
 * auto-applies if confidence ≥ AUTO_MATCH_THRESHOLD, otherwise stores the
 * top candidates for the UI.
 */
const AUTO_MATCH_THRESHOLD = 0.65;

async function autoMatchOne(item, extIdCache) {
  // Respect user locks.
  if (item.matchState === 'manual') return { id: item.id, action: 'skipped', reason: 'manual' };
  // Only process items we can actually read a filename from.
  if (!item.fileName) return { id: item.id, action: 'skipped', reason: 'no_filename' };

  const parsed = library.parseFileName(item.fileName, { hint: item.type || null });
  if (!parsed.query) return { id: item.id, action: 'skipped', reason: 'unparseable' };

  const kind = parsed.type === 'series' ? 'series' : 'movie';
  let { best, confidence, candidates } = await searchCandidates(kind, parsed.query, parsed.year, extIdCache);

  // For series, the filename sometimes carries only an episode title
  // (e.g. "Ep 01 - Box Cutter.mkv"). Also search using the enclosing
  // directory as a show-name query and keep whichever result is stronger.
  if (kind === 'series' && item.filePath) {
    const dirHint = library.deriveSeriesQueryFromPath(item.filePath);
    if (dirHint && dirHint.query && dirHint.query.toLowerCase() !== String(parsed.query).toLowerCase()) {
      const dirResult = await searchCandidates(kind, dirHint.query, dirHint.year || parsed.year, extIdCache);
      const currentHasBest = best ? 1 : 0;
      const dirHasBest = dirResult.best ? 1 : 0;
      const dirWins = dirHasBest > currentHasBest
        || (dirHasBest === currentHasBest && dirResult.confidence > confidence);
      if (dirWins) ({ best, confidence, candidates } = dirResult);
    }
  }

  // Persist the parsed fields and candidates regardless of outcome — the UI
  // uses both. setCandidates also bumps the state to needsReview.
  if (candidates.length > 0) {
    library.setCandidates(item.id, candidates, confidence);
  }

  if (best && confidence >= AUTO_MATCH_THRESHOLD) {
    library.relinkItem(item.id, {
      imdbId: best.imdbId,
      name: best.name,
      poster: best.poster,
      year: best.year,
      type: kind,
      showName: kind === 'series' ? best.name : undefined,
    }, 'auto');
    return { id: item.id, action: 'matched', imdbId: best.imdbId, name: best.name, confidence };
  }

  return { id: item.id, action: 'needsReview', confidence, candidateCount: candidates.length };
}

// GET /api/streams/movie/:imdbId
app.get('/api/streams/movie/:imdbId', rateLimit, async (req, res) => {
  let { imdbId } = req.params;
  const title = req.query.title || '';

  // Support tmdb: IDs — try to resolve to IMDB first
  if (/^tmdb:\d+$/.test(imdbId)) {
    const tmdbId = imdbId.replace('tmdb:', '');
    const resolved = await resolveTmdbToImdb(tmdbId, 'movie');
    if (resolved) {
      imdbId = resolved;
    } else if (title) {
      // Can't resolve IMDB ID — use title-based scraping only
      try {
        const streams = await getMovieStreams(null, title);
        return res.json({ streams });
      } catch (err) {
        console.error('[API] Movie stream error (title-only):', err.message);
        return res.status(500).json({ error: 'Failed to fetch streams' });
      }
    } else {
      return res.status(400).json({ error: 'Cannot resolve TMDB ID and no title provided' });
    }
  }

  if (!/^tt\d{1,10}$/.test(imdbId)) {
    return res.status(400).json({ error: 'Invalid IMDB ID' });
  }
  try {
    const streams = await getMovieStreams(imdbId, title);
    res.json({ streams });
  } catch (err) {
    console.error('[API] Movie stream error:', err.message);
    res.status(500).json({ error: 'Failed to fetch streams' });
  }
});

// GET /api/streams/series/:imdbId?season=N&episode=N
app.get('/api/streams/series/:imdbId', rateLimit, async (req, res) => {
  let { imdbId } = req.params;

  // Support tmdb: IDs — try to resolve to IMDB first
  if (/^tmdb:\d+$/.test(imdbId)) {
    const tmdbId = imdbId.replace('tmdb:', '');
    const resolved = await resolveTmdbToImdb(tmdbId, 'series');
    if (resolved) {
      imdbId = resolved;
    }
    // For series without IMDB ID, title-based search handled below
  }

  if (!/^tt\d{1,10}$/.test(imdbId)) {
    // For tmdb: IDs that couldn't be resolved, try title-based search
    const title = req.query.title || '';
    if (!title) return res.status(400).json({ error: 'Invalid IMDB ID' });
    const season = req.query.season ? parseInt(req.query.season, 10) : undefined;
    const episode = req.query.episode ? parseInt(req.query.episode, 10) : undefined;
    const absEp = req.query.absEp ? parseInt(req.query.absEp, 10) : undefined;
    const genres = req.query.genres ? req.query.genres.split(',').filter(Boolean) : [];
    try {
      const streams = await getSeriesStreams(null, season, episode, title, { absEp, genres });
      return res.json({ streams });
    } catch (err) {
      console.error('[API] Series stream error (title-only):', err.message);
      return res.status(500).json({ error: 'Failed to fetch streams' });
    }
  }
  const season = req.query.season ? parseInt(req.query.season, 10) : undefined;
  const episode = req.query.episode ? parseInt(req.query.episode, 10) : undefined;
  const title = req.query.title || '';
  const absEp = req.query.absEp ? parseInt(req.query.absEp, 10) : undefined;
  const genres = req.query.genres ? req.query.genres.split(',').filter(Boolean) : [];
  try {
    const streams = await getSeriesStreams(imdbId, season, episode, title, { absEp, genres });
    res.json({ streams });
  } catch (err) {
    console.error('[API] Series stream error:', err.message);
    res.status(500).json({ error: 'Failed to fetch streams' });
  }
});

// GET /api/streams/album/:mbid?artist=X&title=Y — search for album torrents
app.get('/api/streams/album/:mbid', rateLimit, async (req, res) => {
  const { mbid } = req.params;
  const artist = (req.query.artist || '').toString().slice(0, 200);
  const title = (req.query.title || '').toString().slice(0, 200);
  if (mbid !== 'na' && !MBID_RE.test(mbid)) {
    return res.status(400).json({ error: 'Invalid MBID' });
  }
  if (!artist && !title) {
    return res.status(400).json({ error: 'artist or title query param is required' });
  }
  try {
    const streams = await getAlbumStreams(mbid === 'na' ? null : mbid, artist, title);
    res.json({ streams });
  } catch (err) {
    console.error('[API] Album stream error:', err.message);
    res.status(500).json({ error: 'Failed to fetch streams' });
  }
});

// GET /api/streams/artist/:mbid?name=Artist — search for artist discography packs
app.get('/api/streams/artist/:mbid', rateLimit, async (req, res) => {
  const { mbid } = req.params;
  const name = (req.query.name || '').toString().slice(0, 200);
  if (mbid !== 'na' && !MBID_RE.test(mbid)) {
    return res.status(400).json({ error: 'Invalid MBID' });
  }
  if (!name) {
    return res.status(400).json({ error: 'name query param is required' });
  }
  try {
    const streams = await getArtistDiscographyStreams(mbid === 'na' ? null : mbid, name);
    res.json({ streams });
  } catch (err) {
    console.error('[API] Artist stream error:', err.message);
    res.status(500).json({ error: 'Failed to fetch streams' });
  }
});

// GET /api/streams/season-pack/:imdbId?season=N&title=ShowName — search for season pack torrents
app.get('/api/streams/season-pack/:imdbId', rateLimit, async (req, res) => {
  const { imdbId } = req.params;
  const season = req.query.season ? parseInt(req.query.season, 10) : undefined;
  const title = req.query.title || '';

  if (season === undefined || isNaN(season)) {
    return res.status(400).json({ error: 'season query parameter is required' });
  }

  try {
    const streams = await getSeasonPackStreams(title, season, imdbId);
    res.json({ streams });
  } catch (err) {
    console.error('[API] Season pack stream error:', err.message);
    res.status(500).json({ error: 'Failed to fetch season pack streams' });
  }
});

// GET /api/streams/complete/:imdbId?title=ShowName — search for complete series/movie torrents
app.get('/api/streams/complete/:imdbId', rateLimit, async (req, res) => {
  const { imdbId } = req.params;
  const title = req.query.title || '';

  try {
    const streams = await getCompleteStreams(title, imdbId);
    res.json({ streams });
  } catch (err) {
    console.error('[API] Complete stream error:', err.message);
    res.status(500).json({ error: 'Failed to fetch complete streams' });
  }
});

// GET /api/streams/diagnose — test connectivity to all providers
app.get('/api/streams/diagnose', rateLimit, async (req, res) => {
  try {
    console.log('[API] Running provider diagnostics...');
    const results = await diagnoseProviders();
    console.log('[API] Diagnostics complete:', JSON.stringify(results._summary));
    res.json(results);
  } catch (err) {
    console.error('[API] Diagnostics error:', err.message);
    res.status(500).json({ error: 'Diagnostics failed' });
  }
});

// POST /api/library/diagnose — probe a magnet URI for BitTorrent
// connectivity. Used to debug "download keeps failing / timing out"
// without having to grep logs: returns peer-discovery counts,
// handshake counts, and a plain-English reason for each failure mode.
// Body: { magnet: "magnet:?xt=..." [, durationMs: number] }
app.post('/api/library/diagnose', rateLimit, express.json({ limit: '4kb' }), async (req, res) => {
  const magnet = req.body && typeof req.body.magnet === 'string' ? req.body.magnet : '';
  if (!/^magnet:\?/i.test(magnet)) {
    return res.status(400).json({ error: 'Missing or invalid magnet URI' });
  }
  const durationMs = Number(req.body.durationMs) || 60000;
  try {
    console.log(`[API] Running torrent diagnostic for ${magnet.slice(0, 60)}...`);
    const result = await library.diagnoseTorrent(magnet, { durationMs });
    console.log(`[API] Torrent diagnostic done: ok=${result.ok} peers=${result.finalPeers} wires=${result.finalWires}`);
    res.json(result);
  } catch (err) {
    console.error(`[API] Torrent diagnostic error: ${err.message}`);
    res.status(400).json({ error: err.message || 'Diagnostic failed' });
  }
});

// GET /api/play/youtube/:videoId — pipe yt-dlp audio to the response
// Spawns yt-dlp with -f bestaudio and streams the extracted audio bytes directly.
app.get('/api/play/youtube/:videoId', rateLimit, (req, res) => {
  const { videoId } = req.params;
  if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid videoId' });
  }
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  // -f bestaudio gives a single-track audio file (usually m4a/webm). We
  // pipe it through without re-encoding to keep CPU minimal on the Jetson.
  const proc = spawn('yt-dlp', [
    '-f', 'bestaudio[ext=m4a]/bestaudio/best',
    '-o', '-',     // stdout
    '--no-warnings',
    '--no-part',
    '--quiet',
    url,
  ]);
  res.setHeader('Content-Type', 'audio/mp4');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  proc.stdout.pipe(res);
  proc.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.log(`[yt-dlp] ${msg}`);
  });
  proc.on('error', (err) => {
    console.error('[yt-dlp] spawn error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'yt-dlp not available' });
  });
  req.on('close', () => { try { proc.kill('SIGTERM'); } catch {} });
});

// GET /api/play/:infoHash — stream video or audio from torrent
// Optional query: ?fileIdx=N&magnet=<uri>&kind=video|audio|any
app.get('/api/play/:infoHash', rateLimit, (req, res) => {
  const { infoHash } = req.params;
  if (!/^[0-9a-f]{40}$/i.test(infoHash)) {
    return res.status(400).json({ error: 'Invalid infoHash' });
  }
  const fileIdx = req.query.fileIdx !== undefined
    ? parseInt(req.query.fileIdx, 10)
    : undefined;
  const kindRaw = (req.query.kind || 'video').toString();
  const kind = ['video', 'audio', 'any'].includes(kindRaw) ? kindRaw : 'video';

  // Validate magnet URI if provided — must be a proper magnet link
  // containing this exact infoHash (prevents using the endpoint to
  // fetch arbitrary content)
  let magnet = infoHash;
  if (req.query.magnet) {
    const magnetStr = req.query.magnet;
    if (!magnetStr.startsWith('magnet:?') ||
        !magnetStr.toLowerCase().includes(infoHash.toLowerCase())) {
      return res.status(400).json({ error: 'Magnet URI does not match infoHash' });
    }
    magnet = magnetStr;
  }

  getEngine().serveStream(req, res, magnet, fileIdx, kind);
});

// GET /api/cache — list items in torrent cache on disk
app.get('/api/cache', async (req, res) => {
  try {
    const cacheDir = TORRENT_CACHE_PATH;
    if (!fs.existsSync(cacheDir)) return res.json({ items: [] });

    const entries = await fs.promises.readdir(cacheDir, { withFileTypes: true });
    const items = [];
    const libraryDirName = path.basename(LIBRARY_PATH);

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === libraryDirName) continue; // skip library subdirectory
      const dirPath = path.join(cacheDir, entry.name);
      const files = await fs.promises.readdir(dirPath).catch(() => []);
      let totalSize = 0;
      let videoFile = null;
      for (const f of files) {
        try {
          const stat = await fs.promises.stat(path.join(dirPath, f));
          totalSize += stat.size;
          if (/\.(mp4|mkv|avi|webm|mov)$/i.test(f) && (!videoFile || stat.size > videoFile.size)) {
            videoFile = { name: f, size: stat.size };
          }
        } catch {}
      }
      items.push({
        name: entry.name,
        totalSize,
        videoFile: videoFile ? videoFile.name : null,
        videoSize: videoFile ? videoFile.size : 0,
      });
    }

    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/torrent-status — list all active torrents
app.get('/api/torrent-status', (req, res) => {
  const eng = getEngine();
  res.json({ torrents: eng.getAllStatus() });
});

// GET /api/play/:infoHash/remux — stream video remuxed from MKV to MP4
// Uses FFmpeg to copy video + transcode audio to AAC in fragmented MP4 container
app.get('/api/play/:infoHash/remux', rateLimit, (req, res) => {
  const { infoHash } = req.params;
  if (!/^[0-9a-f]{40}$/i.test(infoHash)) {
    return res.status(400).json({ error: 'Invalid infoHash' });
  }
  const fileIdx = req.query.fileIdx !== undefined
    ? parseInt(req.query.fileIdx, 10)
    : undefined;

  let magnet = infoHash;
  if (req.query.magnet) {
    const magnetStr = req.query.magnet;
    if (!magnetStr.startsWith('magnet:?') ||
        !magnetStr.toLowerCase().includes(infoHash.toLowerCase())) {
      return res.status(400).json({ error: 'Magnet URI does not match infoHash' });
    }
    magnet = magnetStr;
  }

  getEngine().serveRemuxedStream(req, res, magnet, fileIdx);
});

// GET /api/torrent-status/:infoHash — check download progress
// Optional query: ?kind=video|audio|any  (default video, for backward compat)
app.get('/api/torrent-status/:infoHash', (req, res) => {
  const { infoHash } = req.params;
  if (!/^[0-9a-f]{40}$/i.test(infoHash)) {
    return res.status(400).json({ error: 'Invalid infoHash' });
  }
  const kindRaw = (req.query.kind || 'video').toString();
  const kind = ['video', 'audio', 'any'].includes(kindRaw) ? kindRaw : 'video';
  const eng = getEngine();
  const status = eng.getStatus(infoHash, kind);
  if (!status) {
    return res.status(404).json({ error: 'Torrent not active' });
  }
  res.json(status);
});

// GET /api/torrent-status/:infoHash/bottleneck — diagnose speed bottleneck
// Compares torrent swarm download speed vs client egress rate to determine
// whether the torrent or the server/network is the limiting factor.
app.get('/api/torrent-status/:infoHash/bottleneck', (req, res) => {
  const { infoHash } = req.params;
  if (!/^[0-9a-f]{40}$/i.test(infoHash)) {
    return res.status(400).json({ error: 'Invalid infoHash' });
  }
  const eng = getEngine();
  const diag = eng.getBottleneckDiag(infoHash);
  if (!diag) {
    return res.status(404).json({ error: 'Torrent not active' });
  }
  res.json(diag);
});

// GET /api/diagnostics/system — sample host CPU / memory / disk / network over
// ~1 second and aggregate all active torrent speeds. Use this to figure out
// whether slow downloads are bottlenecked on the host (CPU / disk / network
// saturated) or on the BT swarm (torrent speeds low but host is idle).
app.get('/api/diagnostics/system', async (req, res) => {
  try {
    const sampleMs = Math.min(5000, Math.max(200, parseInt(req.query.ms, 10) || 1000));
    const sys = await getSystemDiag(sampleMs);

    // Aggregate torrent throughput across both streaming engine and library.
    //
    // One row per actual torrent-stream engine, NOT per library item. Pack
    // engines are shared across every episode in the pack, so the naïve
    // per-item loop inflated counts (55 episodes × 7 peers = 385 "peers"
    // for one real 7-peer swarm). See LibraryManager.getActiveEngineStats.
    let torrentDownloadBps = 0;
    let torrentUploadBps = 0;
    let torrentPeers = 0;
    let activeTorrents = 0;
    const perEngine = [];

    try {
      const eng = engine; // don't lazy-init just for diagnostics
      if (eng) {
        for (const s of eng.getAllStatus()) {
          torrentDownloadBps += s.downloadSpeed || 0;
          torrentUploadBps += s.uploadSpeed || 0;
          torrentPeers += s.numPeers || 0;
          activeTorrents++;
          perEngine.push({
            source: 'stream',
            name: s.name,
            isPack: false,
            activeFileName: null,
            downloadBps: s.downloadSpeed || 0,
            uploadBps: s.uploadSpeed || 0,
            peers: s.numPeers || 0,
            itemCount: 1,
            downloadingCount: 1,
            completeCount: 0,
          });
        }
      }
    } catch (e) {
      console.warn('[Diag] engine status failed:', e.message);
    }

    try {
      for (const stat of library.getActiveEngineStats()) {
        torrentDownloadBps += stat.downloadBps || 0;
        torrentUploadBps += stat.uploadBps || 0;
        torrentPeers += stat.peers || 0;
        activeTorrents++;
        perEngine.push({
          source: 'library',
          name: stat.name,
          isPack: stat.isPack,
          activeFileName: stat.activeFileName,
          downloadBps: stat.downloadBps,
          uploadBps: stat.uploadBps,
          peers: stat.peers,
          itemCount: stat.itemCount,
          downloadingCount: stat.downloadingCount,
          completeCount: stat.completeCount,
        });
      }
    } catch (e) {
      console.warn('[Diag] library status failed:', e.message);
    }

    // Total network rx across non-loopback interfaces (host-wide, not just BT).
    let hostNetRxBps = 0;
    let hostNetTxBps = 0;
    for (const iface of Object.values(sys.network)) {
      hostNetRxBps += iface.rxBytesPerSec;
      hostNetTxBps += iface.txBytesPerSec;
    }

    // Total disk write across non-pseudo devices.
    let hostDiskWriteBps = 0;
    let hostDiskReadBps = 0;
    for (const dev of Object.values(sys.disk)) {
      hostDiskWriteBps += dev.writeBytesPerSec;
      hostDiskReadBps += dev.readBytesPerSec;
    }

    // Best-effort bottleneck hint — compares torrent pull rate to host
    // resource usage. This is heuristic, not authoritative.
    let hint = 'unknown';
    const torrentMBps = torrentDownloadBps / 1e6;
    if (activeTorrents === 0) {
      hint = 'idle (no active downloads)';
    } else if (sys.cpu.usagePct >= 90) {
      hint = `cpu_bound (${sys.cpu.usagePct}% cpu) — likely verify-pass or too many concurrent torrents`;
    } else if (sys.memory.usedPct >= 95) {
      hint = `memory_pressure (${sys.memory.usedPct}% used) — may be swapping`;
    } else if (hostNetRxBps > 0 && torrentDownloadBps > 0 && torrentDownloadBps >= hostNetRxBps * 0.9) {
      // Torrent pull is close to total host network rx — suggests either
      // swarm-limited or link-limited, not something else on the box.
      hint = `network_or_swarm (torrents = ${(torrentMBps).toFixed(2)} MB/s, host rx = ${(hostNetRxBps / 1e6).toFixed(2)} MB/s) — either the swarm is giving all it has or the uplink/VPN is the cap`;
    } else if (hostNetRxBps > torrentDownloadBps * 1.5) {
      hint = `host_has_headroom — host is receiving ${(hostNetRxBps / 1e6).toFixed(2)} MB/s total but torrents only account for ${(torrentMBps).toFixed(2)} MB/s. BT protocol (e.g. uploads:0 choking) or swarm health is the cap, not your link.`;
    } else {
      hint = `swarm_or_protocol — torrents ${(torrentMBps).toFixed(2)} MB/s, ${torrentPeers} peers total across ${activeTorrents} torrents. Nothing on the host is saturated.`;
    }

    res.json({
      hint,
      torrents: {
        active: activeTorrents,
        totalDownloadBps: torrentDownloadBps,
        totalDownloadMBps: +(torrentMBps).toFixed(3),
        totalUploadBps: torrentUploadBps,
        totalUploadMBps: +(torrentUploadBps / 1e6).toFixed(3),
        totalPeers: torrentPeers,
        perEngine,
      },
      host: {
        cpu: sys.cpu,
        memory: sys.memory,
        network: sys.network,
        disk: sys.disk,
        totalNetRxBps: hostNetRxBps,
        totalNetTxBps: hostNetTxBps,
        totalDiskReadBps: hostDiskReadBps,
        totalDiskWriteBps: hostDiskWriteBps,
      },
      sampleMs: sys.sampleMs,
      platform: sys.platform,
    });
  } catch (err) {
    console.error('[Diag] system diagnostic failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Library API Routes ───────────────────────────────────────────────

// GET /api/library — list all library items
app.get('/api/library', (req, res) => {
  try {
    const items = library.getAll();
    const slots = library.getDownloadSlots();
    res.json({ items, slots });
  } catch (err) {
    console.error('[Library] getAll() failed:', err.message);
    res.status(500).json({ items: [], error: err.message });
  }
});

// GET /api/library/debug — diagnostic endpoint for troubleshooting
app.get('/api/library/debug', (req, res) => {
  const { VIDEO_EXTENSIONS } = require('./lib/file-safety');
  const diag = {};

  // 1. Path configuration
  diag.libraryPath = LIBRARY_PATH;
  diag.torrentCachePath = TORRENT_CACHE_PATH;
  diag.envLibraryPath = process.env.LIBRARY_PATH || '(not set, using default)';
  diag.envTorrentCache = process.env.TORRENT_CACHE || '(not set, using default)';

  // 2. Directory existence and permissions
  try {
    diag.directoryExists = fs.existsSync(LIBRARY_PATH);
    if (diag.directoryExists) {
      const stat = fs.statSync(LIBRARY_PATH);
      diag.directoryMode = '0' + (stat.mode & 0o777).toString(8);
      diag.directoryUid = stat.uid;
    }
  } catch (err) {
    diag.directoryError = err.message;
  }

  // 3. Raw directory listing
  try {
    if (diag.directoryExists) {
      const entries = fs.readdirSync(LIBRARY_PATH, { withFileTypes: true });
      diag.directoryEntries = entries.map(e => ({
        name: e.name,
        isFile: e.isFile(),
        isDirectory: e.isDirectory(),
        ext: path.extname(e.name).toLowerCase(),
      }));
    }
  } catch (err) {
    diag.directoryListError = err.message;
  }

  // 4. Metadata file status
  const metadataPath = path.join(LIBRARY_PATH, '_metadata.json');
  const backupPath = metadataPath + '.bak';
  try {
    diag.metadataExists = fs.existsSync(metadataPath);
    diag.metadataBackupExists = fs.existsSync(backupPath);
    if (diag.metadataExists) {
      const raw = fs.readFileSync(metadataPath, 'utf8');
      diag.metadataSize = raw.length;
      diag.metadataEmpty = !raw.trim();
      try {
        const parsed = JSON.parse(raw);
        diag.metadataIsArray = Array.isArray(parsed);
        diag.metadataItemCount = Array.isArray(parsed) ? parsed.length : null;
      } catch (e) {
        diag.metadataParseError = e.message;
      }
    }
  } catch (err) {
    diag.metadataReadError = err.message;
  }

  // 5. Internal state
  diag.trackedItemCount = library._items.size;
  diag.trackedItemIds = [...library._items.keys()];

  // 6. getAll() result
  try {
    const all = library.getAll();
    diag.getAllCount = all.length;
    diag.getAllSample = all.slice(0, 3);
  } catch (err) {
    diag.getAllError = err.message;
  }

  // 7. VIDEO_EXTENSIONS for reference
  diag.videoExtensions = [...VIDEO_EXTENSIONS];

  // 8. Process info
  diag.processUid = process.getuid ? process.getuid() : 'N/A';
  diag.processCwd = process.cwd();

  res.json(diag);
});

// GET /api/library/audit — walk the library directory and report every
// tracked item that doesn't match its on-disk file, plus orphaned files
// (untracked videos, leftover ffmpeg temp files, empty directories).
//
// Query params:
//   ?deep=1 — additionally run ffprobe against every complete file to
//             catch truncated/corrupt downloads that happen to have the
//             right byte count. Slower but thorough.
app.get('/api/library/audit', async (req, res) => {
  try {
    const deep = req.query.deep === '1' || req.query.deep === 'true';
    const report = await library.auditDiskState({ deep });
    res.json(report);
  } catch (err) {
    console.error('[API] Audit failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/library/audit/remediate — run the audit and act on the issues.
// Body:
//   {
//     action: 'redownload' | 'remove',   // what to do with broken items
//     removeOrphanFiles?: bool,          // default false
//     removeOrphanTempFiles?: bool,      // default true
//     removeEmptyDirectories?: bool,     // default true
//     deep?: bool,                       // default false (ffprobe check)
//     dryRun?: bool                      // default false
//   }
app.post('/api/library/audit/remediate', rateLimit, async (req, res) => {
  const {
    action = 'remove',
    removeOrphanFiles = false,
    removeOrphanTempFiles = true,
    removeEmptyDirectories = true,
    deep = false,
    dryRun = false,
  } = req.body || {};

  if (!['redownload', 'remove'].includes(action)) {
    return res.status(400).json({ error: "action must be 'redownload' or 'remove'" });
  }

  try {
    const result = await library.remediateAudit({
      action,
      removeOrphanFiles: !!removeOrphanFiles,
      removeOrphanTempFiles: !!removeOrphanTempFiles,
      removeEmptyDirectories: !!removeEmptyDirectories,
      deep: !!deep,
      dryRun: !!dryRun,
    });
    res.json(result);
  } catch (err) {
    console.error('[API] Audit remediation failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/library/:id — get single library item
// GET /api/library/packs — list all packs with a quick classification summary
// so you can tell which ones need reclassify-pack before running repair.
// MUST be registered BEFORE the /api/library/:id wildcard below, otherwise
// Express routes the request to the :id handler and returns "Item not found".
app.get('/api/library/packs', rateLimit, (req, res) => {
  const allItems = library.getAll();
  const packs = new Map();
  for (const i of allItems) {
    if (!i.packId) continue;
    if (!packs.has(i.packId)) packs.set(i.packId, []);
    packs.get(i.packId).push(i);
  }

  const out = [];
  for (const [packId, items] of packs) {
    const types = [...new Set(items.map(i => i.type))];
    const showNames = [...new Set(items.map(i => i.showName || null).filter(Boolean))];
    const statuses = {};
    for (const i of items) statuses[i.status] = (statuses[i.status] || 0) + 1;

    // Classification hint: what would auto mode do?
    let autoMovieCount = 0, autoSeriesCount = 0;
    for (const i of items) {
      if (fileNameLooksLikeEpisode(i.fileName)) autoSeriesCount++;
      else autoMovieCount++;
    }

    const mixed = types.length > 1;
    const autoDisagreesWithCurrent = items.some(i =>
      (fileNameLooksLikeEpisode(i.fileName) ? 'series' : 'movie') !== i.type
    );

    out.push({
      packId,
      itemCount: items.length,
      currentTypes: types,
      mixed,
      showNames: showNames.slice(0, 3),
      statuses,
      autoMovieCount,
      autoSeriesCount,
      autoDisagreesWithCurrent,
      suggestion: mixed || autoDisagreesWithCurrent
        ? (autoMovieCount > 0 && autoSeriesCount === 0
            ? 'all-movies'
            : autoMovieCount === 0 && autoSeriesCount > 0
              ? 'all-series'
              : 'auto')
        : null,
      sampleFileNames: items.slice(0, 3).map(i => i.fileName),
    });
  }

  // Put packs that need attention first
  out.sort((a, b) => {
    if (a.suggestion && !b.suggestion) return -1;
    if (!a.suggestion && b.suggestion) return 1;
    return b.itemCount - a.itemCount;
  });

  res.json({ packCount: out.length, packs: out });
});

// GET /api/library/review-queue — list every item that isn't a confirmed match.
// Includes disk-discovered files that have never been matched.
// Defined before `/:id` so Express does not match it as an item id.
app.get('/api/library/review-queue', (req, res) => {
  try {
    const items = library.getReviewQueue();
    // Sort worst (unmatched) first so the UI emphasises items with no options.
    items.sort((a, b) => {
      const rank = { unmatched: 0, needsReview: 1, matched: 2, manual: 3 };
      const ra = rank[a.matchState] ?? 9;
      const rb = rank[b.matchState] ?? 9;
      if (ra !== rb) return ra - rb;
      return (a.matchConfidence || 0) - (b.matchConfidence || 0);
    });
    res.json({ items, count: items.length });
  } catch (err) {
    console.error('[API] review-queue error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/library/:id', (req, res) => {
  const item = library.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  res.json(item);
});

// POST /api/library/add — add item to library and start download
app.post('/api/library/add', rateLimit, (req, res) => {
  const { imdbId, type, name, poster, year, magnetUri, infoHash, quality, size, season, episode } = req.body;

  if (!infoHash || !/^[0-9a-f]{40}$/i.test(infoHash)) {
    return res.status(400).json({ error: 'Invalid infoHash' });
  }
  if (!magnetUri || !magnetUri.startsWith('magnet:?')) {
    return res.status(400).json({ error: 'Invalid magnet URI' });
  }
  if (!magnetUri.toLowerCase().includes(infoHash.toLowerCase())) {
    return res.status(400).json({ error: 'Magnet URI does not match infoHash' });
  }

  try {
    const result = library.addItem({ imdbId, type, name, poster, year, magnetUri, infoHash, quality, size, season, episode });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/library/add-pack — add season pack to library (downloads all episodes)
app.post('/api/library/add-pack', rateLimit, async (req, res) => {
  const { imdbId, name, poster, year, magnetUri, infoHash, quality, size, season } = req.body;

  if (!infoHash || !/^[0-9a-f]{40}$/i.test(infoHash)) {
    return res.status(400).json({ error: 'Invalid infoHash' });
  }
  if (!magnetUri || !magnetUri.startsWith('magnet:?')) {
    return res.status(400).json({ error: 'Invalid magnet URI' });
  }
  if (!magnetUri.toLowerCase().includes(infoHash.toLowerCase())) {
    return res.status(400).json({ error: 'Magnet URI does not match infoHash' });
  }
  if (season === undefined || season === null) {
    return res.status(400).json({ error: 'season is required' });
  }

  try {
    const result = await library.addSeasonPack({ imdbId, name, poster, year, magnetUri, infoHash, quality, size, season });

    // After pack is created, resolve correct TMDB metadata for any episodes
    // whose filename-derived show name differs from the torrent-level name.
    // This runs in the background so it doesn't block the response.
    if (result.items && result.items.length > 0 && TMDB_API_KEY) {
      (async () => {
        try {
          const allItems = library.getAll();
          const packItems = allItems.filter(i => i.type === 'series' && i.packId === `pack_${infoHash}`);
          // Group by unique showName to minimize TMDB lookups
          const showNames = [...new Set(packItems.map(i => i.showName).filter(Boolean))];
          const torrentName = name || '';

          for (const sn of showNames) {
            // Skip if show name matches the torrent-level name (already has correct metadata)
            if (sn.toLowerCase() === torrentName.toLowerCase()) continue;

            const meta = await lookupShowByName(sn);
            if (!meta || !meta.imdbId) continue;

            // Update all episodes with this show name
            for (const ep of packItems) {
              if (ep.showName === sn) {
                library.relinkItem(ep.id, {
                  imdbId: meta.imdbId,
                  showName: meta.name,
                  poster: meta.poster,
                  year: meta.year,
                });
              }
            }
            console.log(`[Library] Resolved "${sn}" -> ${meta.name} (${meta.imdbId})`);
          }
        } catch (err) {
          console.warn('[Library] Background metadata resolution failed:', err.message);
        }
      })().catch(err => console.warn('[Library] Background metadata error:', err.message));
    }

    res.json(result);
  } catch (err) {
    console.error('[API] Season pack download error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Keyword pattern that marks an item as bonus / extras content rather than a
// standalone movie. Matched against the fileName AND the filePath (so a clip
// living in an "Extras/" subfolder is caught even if its own filename is
// generic). Items that match are left completely untouched by repair —
// they stay in the library with whatever metadata they already had.
//
// Only strong multi-word phrases are used. Single-word triggers like
// "interview", "extras", "trailer", "commentary", "bonus" were removed
// because they collide with real movie titles (e.g. "The Interview" (2014),
// "Trailer Park Boys: The Movie", etc.). If you need to mark a single-word
// item as extras, add it to its filePath under a subfolder that matches.
const MOVIE_EXTRAS_PATTERN = new RegExp(
  '\\b(' +
  [
    'making[\\s._-]*of',
    'behind[\\s._-]*the[\\s._-]*scenes',
    'beyond[\\s._-]*the[\\s._-]*movie',
    'deleted[\\s._-]*scenes?',
    'greatest[\\s._-]*moments',
    'gag[\\s._-]*reels?',
    'sneak[\\s._-]*peeks?',
    'live[\\s._-]*tour',
    'bonus[\\s._-]*(?:features?|material|disc|episodes?|dvd)',
    'bts',
    'featurettes?',
    'bloopers',
    'anniversaire',
  ].join('|') +
  ')\\b',
  'i'
);

// Folder-segment check for the catch-all "Extras" / "Bonus Features" / etc.
// This is path-only so a filename that happens to contain "Extras" as a word
// won't be flagged — only items that actually live inside one of these
// folders. Matches any path segment, case-insensitive.
const EXTRAS_FOLDER_PATTERN = /(?:^|\/)(extras?|bonus(?:\s*features?|\s*material|\s*disc)?|featurettes?|behind[\s._-]*the[\s._-]*scenes|deleted[\s._-]*scenes?|interviews?)(?:\/|$)/i;

function isMovieExtras(item) {
  const fileName = item.fileName || '';
  const filePath = item.filePath || '';
  if (MOVIE_EXTRAS_PATTERN.test(fileName) || MOVIE_EXTRAS_PATTERN.test(filePath)) return true;
  // Normalize backslashes to forward slashes for the folder check
  if (EXTRAS_FOLDER_PATTERN.test(filePath.replace(/\\/g, '/'))) return true;
  return false;
}

// Detect filenames that look like a TV episode so:
//   (a) the repair loop can skip movie items whose underlying file is
//       actually a series episode in disguise, and
//   (b) the /api/library/packs auto classifier can correctly distinguish
//       series packs from movie packs.
//
// Covered formats (all tested against a 24-case fixture):
//   SxxExx             Breaking.Bad.S01E05 / Mad Men S07E01
//   NxNN               Naruto.Shippuden.1x05
//   Episode NNN        Naruto Shippuden Episode 489 The State of Affairs
//   Ep NN              Ep 03 - Cancer Man (Italian breaking bad)
//   Show - NNN         [AnimeRG] Naruto Shippuden - 495 [720p] ...
//                      (anime scene convention — requires letters BEFORE
//                       the dash so leading-year movie filenames like
//                       "1959 - Sleeping Beauty.avi" do NOT match, and
//                       rejects 4-digit numbers in the 1900-2099 range as
//                       probable years rather than episode numbers)
function fileNameLooksLikeEpisode(fileName) {
  if (!fileName) return false;
  const base = String(fileName).replace(/\.[^.]+$/, '');
  if (/\bS\d{1,2}[\s._-]?E\d{1,3}\b/i.test(base)) return true;
  if (/\b\d{1,2}x\d{1,3}\b/i.test(base)) return true;
  if (/\bEpisode[\s._-]+\d{1,4}\b/i.test(base)) return true;
  if (/\bEp[\s._-]+\d{1,4}\b/i.test(base)) return true;
  const anime = base.match(/[a-z][a-z\s._-]*[-–][\s._-]*(\d{2,4})(?:$|[^\d])/i);
  if (anime) {
    const n = parseInt(anime[1], 10);
    if (!(n >= 1900 && n <= 2099)) return true;
  }
  return false;
}

// POST /api/library/repair-metadata — one-time repair: re-derive titles from
// filenames and look up correct IMDB IDs, posters, and years from TMDB.
// 'downloading' and 'queued' items are always skipped (the pack flow may
// still be writing their metadata). Everything else is repairable.
// Backs up _metadata.json before making any changes.
//
// Query params:
//   ?dryRun=1           — return the plan without writing anything.
//   ?statuses=a,b,c     — only process items whose status is in the given
//                         comma-separated list. Defaults to all repairable
//                         statuses (complete, failed, paused, converting).
//                         Useful for staging: run with ?statuses=complete
//                         first, then ?statuses=paused, then
//                         ?statuses=failed as the riskiest batch last.
//
// Items are processed in this order within each run: complete → converting
// → paused → failed, so if something goes wrong partway through, the safest
// groups land first.
app.post('/api/library/repair-metadata', rateLimit, async (req, res) => {
  if (!TMDB_API_KEY) {
    return res.status(400).json({ error: 'TMDB API key not configured' });
  }

  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';

  const DEFAULT_STATUSES = ['complete', 'converting', 'paused', 'failed'];
  const STATUS_ORDER = { complete: 0, converting: 1, paused: 2, failed: 3 };
  const allowedStatuses = req.query.statuses
    ? new Set(String(req.query.statuses).split(',').map(s => s.trim()).filter(Boolean))
    : new Set(DEFAULT_STATUSES);
  // Never allow in-flight statuses even if the caller asks for them
  allowedStatuses.delete('downloading');
  allowedStatuses.delete('queued');

  // Normalize titles for comparison: lowercase, strip year, punctuation, whitespace
  const normTitle = (s) => (s || '')
    .toLowerCase()
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .replace(/\s+\d{4}\s*$/, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Back up _metadata.json before touching anything, so a bad repair run
  // can be reverted by copying the .bak over the live file. If backup
  // fails and this is NOT a dry run, abort — writing without a safety net
  // is exactly what broke things last time.
  let backupPath = null;
  if (!dryRun) {
    try {
      const metadataFile = library._metadataFile;
      if (metadataFile && fs.existsSync(metadataFile)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        backupPath = `${metadataFile}.pre-repair-${stamp}.bak`;
        fs.copyFileSync(metadataFile, backupPath);
        console.log(`[Repair] Backed up metadata to ${backupPath}`);
      } else {
        console.error(`[Repair] Metadata file not found at ${metadataFile} — aborting to avoid writing without a backup`);
        return res.status(500).json({ error: 'metadata file not found; refusing to run without a backup' });
      }
    } catch (err) {
      console.error(`[Repair] Could not create metadata backup: ${err.message}`);
      return res.status(500).json({ error: `failed to create metadata backup: ${err.message}; refusing to run without a backup` });
    }
  }

  try {
    const allItems = library.getAll();
    // Only skip items the pack/add flow might still be actively writing to:
    // 'downloading' is mid-transfer and 'queued' is about to be picked. Both
    // have metadata that's still being populated and can race with a repair.
    const IN_FLIGHT = new Set(['downloading', 'queued']);

    const repairableItems = allItems
      .filter(i => i.fileName && !IN_FLIGHT.has(i.status) && allowedStatuses.has(i.status))
      // Process safest status class first so a crash partway through
      // damages the least-trusted items last.
      .sort((a, b) => (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99));
    const seriesItems = repairableItems.filter(i => i.type === 'series');
    const movieItems = repairableItems.filter(i => i.type === 'movie');

    const repaired = [];
    const stats = {
      inFlightSkipped: allItems.filter(i => i.fileName && IN_FLIGHT.has(i.status)).length,
      statusFilterSkipped: allItems.filter(i => i.fileName && !IN_FLIGHT.has(i.status) && !allowedStatuses.has(i.status)).length,
      eligibleByStatus: Object.fromEntries(
        [...allowedStatuses].map(s => [s, repairableItems.filter(i => i.status === s).length])
      ),
      moviesExtrasSkipped: 0,
      moviesNoMatchSkipped: 0,
      moviesUnparseableSkipped: 0,
      moviesAlreadyCorrect: 0,
    };

    // ── Series: derive show names and group episodes ────────────────────
    const showMap = new Map(); // showName -> [item ids]
    for (const item of seriesItems) {
      const derivedName = library._deriveShowNameFromFile(item.fileName);
      if (!derivedName) continue;

      // Only process items where the derived name differs from current showName
      if (derivedName.toLowerCase() !== (item.showName || '').toLowerCase()) {
        if (!showMap.has(derivedName)) showMap.set(derivedName, []);
        showMap.get(derivedName).push(item.id);
      }
    }

    for (const [derivedName, itemIds] of showMap) {
      const meta = await lookupShowByName(derivedName);
      // Symmetry with movies: only write when TMDB matched with a real imdbId.
      // The previous behavior of falling back to the raw derived name on miss
      // could corrupt working showNames on in-progress series.
      if (!meta || !meta.imdbId) {
        console.log(`[Repair] Series "${derivedName}" — no TMDB match, leaving ${itemIds.length} episode(s) untouched`);
        continue;
      }
      const updates = {
        showName: meta.name || derivedName,
        imdbId: meta.imdbId,
        poster: meta.poster,
        year: meta.year,
      };

      if (!dryRun) {
        for (const id of itemIds) {
          library.relinkItem(id, updates);
        }
      }

      repaired.push({
        type: 'series',
        showName: updates.showName,
        imdbId: updates.imdbId,
        episodesUpdated: itemIds.length,
      });
      console.log(`[Repair]${dryRun ? ' [dry-run]' : ''} "${derivedName}" -> ${updates.showName} (${updates.imdbId}), ${itemIds.length} episodes`);
    }

    // ── Movies: derive title (+ year hint) and look up on TMDB ──────────
    stats.moviesEpisodeFormatSkipped = 0;
    stats.moviesNoOpSkipped = 0;
    let moviesUpdated = 0;
    for (const item of movieItems) {
      // Skip bonus / featurette / concert / making-of content entirely.
      // These stay in the library with whatever metadata they already had.
      if (isMovieExtras(item)) {
        stats.moviesExtrasSkipped++;
        continue;
      }

      // Skip type:movie items whose filename is actually a TV episode —
      // misclassified series content. Feeding "Game.of.Thrones.S03E10.mkv"
      // to the movie parser derives a garbage query that word-overlaps into
      // unrelated films.
      if (fileNameLooksLikeEpisode(item.fileName)) {
        stats.moviesEpisodeFormatSkipped++;
        continue;
      }

      const { title: derivedTitle, year: derivedYear } = library._deriveMovieNameFromFile(item.fileName);
      if (!derivedTitle) {
        stats.moviesUnparseableSkipped++;
        continue;
      }

      // Skip items that already have a valid IMDB id AND a name matching
      // the derived title — nothing to fix. Items missing imdbId are still
      // re-processed so disk-discovered movies get tagged.
      const currentNorm = normTitle(item.name);
      const derivedNorm = normTitle(derivedTitle);
      if (item.imdbId && /^tt\d+$/.test(item.imdbId) && currentNorm === derivedNorm) {
        stats.moviesAlreadyCorrect++;
        continue;
      }

      const meta = await lookupMovieByName(derivedTitle, derivedYear);
      // Only write changes when TMDB actually matched. A "not found" used
      // to overwrite item.name with the raw derived string — that stomped
      // on decent existing names and filled the response with garbage.
      if (!meta || !meta.imdbId) {
        stats.moviesNoMatchSkipped++;
        console.log(`[Repair] "${derivedTitle}" — no TMDB match, leaving item untouched`);
        continue;
      }

      const newName = meta.name || derivedTitle;
      // Skip writes that wouldn't change anything — same name AND same
      // imdbId as already stored. These no-op updates cluttered the
      // response with dozens of "Licence to Kill -> Licence to Kill" lines
      // because the "already correct" shortcut only checks derivedTitle,
      // not what TMDB actually returns.
      if (
        item.imdbId === meta.imdbId &&
        normTitle(item.name) === normTitle(newName)
      ) {
        stats.moviesNoOpSkipped++;
        continue;
      }

      const updates = {
        name: newName,
        imdbId: meta.imdbId,
        poster: meta.poster,
        year: meta.year || derivedYear || undefined,
      };
      if (!dryRun) {
        library.relinkItem(item.id, updates);
      }
      moviesUpdated++;

      repaired.push({
        type: 'movie',
        itemId: item.id,
        previousName: item.name,
        previousImdbId: item.imdbId || null,
        name: updates.name,
        imdbId: updates.imdbId,
        moviesUpdated: 1,
      });
      console.log(`[Repair]${dryRun ? ' [dry-run]' : ''} "${derivedTitle}" -> ${updates.name} (${updates.imdbId})`);
    }

    const episodesUpdated = repaired
      .filter(r => r.type === 'series')
      .reduce((s, r) => s + r.episodesUpdated, 0);

    res.json({
      dryRun,
      repaired,
      totalUpdated: dryRun ? 0 : episodesUpdated + moviesUpdated,
      plannedUpdates: dryRun ? episodesUpdated + moviesUpdated : undefined,
      episodesUpdated: dryRun ? 0 : episodesUpdated,
      moviesUpdated: dryRun ? 0 : moviesUpdated,
      skipped: stats,
      backupPath: backupPath ? path.basename(backupPath) : null,
    });
  } catch (err) {
    console.error('[API] Repair metadata error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/library/reclassify-pack — flip a pack's items between movie and
// series classifications. Prerequisite step for repairing packs that were
// imported with the wrong type (e.g. a Disney movie collection imported as
// series, or a TV pack that swept up theatrical movies alongside episodes).
//
// Query params:
//   packId=<id>            required — the packId to target
//   mode=<mode>            required — one of:
//                            all-movies   flip every item to type:movie
//                            all-series   flip every item to type:series
//                            auto         per-item: episode pattern -> series,
//                                         else movie (uses fileNameLooksLikeEpisode)
//   dryRun=1               preview only, no writes, no backup
//   clearMetadata=1        also wipe imdbId/showName/poster/year on reclassified
//                          items so the next repair-metadata run starts fresh
//                          (name is kept so the UI still has a label until
//                          repair re-derives)
//
// Response: { packId, mode, dryRun, clearMetadata, reclassified[], stats, backupPath }
app.post('/api/library/reclassify-pack', rateLimit, async (req, res) => {
  const packId = (req.query.packId || '').toString();
  const mode = (req.query.mode || '').toString();
  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  const clearMetadata = req.query.clearMetadata === '1' || req.query.clearMetadata === 'true';

  if (!packId) return res.status(400).json({ error: 'packId query param is required' });
  if (!['all-movies', 'all-series', 'auto'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be one of: all-movies, all-series, auto' });
  }

  const allItems = library.getAll();
  const packItems = allItems.filter(i => i.packId === packId);
  if (packItems.length === 0) {
    return res.status(404).json({ error: `no items found for packId ${packId}` });
  }

  // Back up _metadata.json before any write. Mirrors the repair endpoint's
  // safety net: if the backup can't be written, refuse to proceed.
  let backupPath = null;
  if (!dryRun) {
    try {
      const metadataFile = library._metadataFile;
      if (metadataFile && fs.existsSync(metadataFile)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        backupPath = `${metadataFile}.pre-reclassify-${stamp}.bak`;
        fs.copyFileSync(metadataFile, backupPath);
        console.log(`[Reclassify] Backed up metadata to ${backupPath}`);
      } else {
        return res.status(500).json({ error: 'metadata file not found; refusing to run without a backup' });
      }
    } catch (err) {
      return res.status(500).json({ error: `failed to create metadata backup: ${err.message}` });
    }
  }

  const reclassified = [];
  const stats = {
    total: packItems.length,
    toMovie: 0,
    toSeries: 0,
    typeUnchanged: 0,
    metadataCleared: 0,
  };

  for (const item of packItems) {
    let newType;
    if (mode === 'all-movies') newType = 'movie';
    else if (mode === 'all-series') newType = 'series';
    else newType = fileNameLooksLikeEpisode(item.fileName) ? 'series' : 'movie';

    const typeChanged = newType !== item.type;
    if (!typeChanged && !clearMetadata) {
      stats.typeUnchanged++;
      continue;
    }

    const record = {
      itemId: item.id,
      fileName: item.fileName,
      previousType: item.type,
      newType,
      previousName: item.name,
      previousImdbId: item.imdbId || null,
      previousShowName: item.showName || null,
      typeChanged,
      metadataCleared: !!clearMetadata,
    };

    if (!dryRun) {
      // Direct access to the internal items map. relinkItem() can't clear
      // fields (its `if (x) item.x = x` guards block null/empty), and this
      // endpoint lives in the same process as library-manager so it's safe
      // to mutate items directly before a single _saveMetadata() at the end.
      const stored = library._items.get(item.id);
      if (stored) {
        if (typeChanged) stored.type = newType;
        if (clearMetadata) {
          stored.imdbId = null;
          stored.showName = null;
          stored.poster = '';
          stored.year = '';
          // Leave `name` untouched — the UI needs something to display
          // until the next repair-metadata run re-derives a clean name.
        }
      }
    }

    if (typeChanged) {
      if (newType === 'movie') stats.toMovie++;
      else stats.toSeries++;
    }
    if (clearMetadata) stats.metadataCleared++;
    reclassified.push(record);
  }

  if (!dryRun && reclassified.length > 0) {
    library._saveMetadata();
    console.log(`[Reclassify] Pack ${packId} (${mode}): ${stats.toMovie} to movie, ${stats.toSeries} to series, ${stats.metadataCleared} metadata cleared`);
  }

  res.json({
    packId,
    mode,
    dryRun,
    clearMetadata,
    reclassified: dryRun ? reclassified : reclassified.map(r => ({
      itemId: r.itemId,
      previousType: r.previousType,
      newType: r.newType,
      previousName: r.previousName,
    })),
    stats,
    backupPath: backupPath ? path.basename(backupPath) : null,
  });
});

// GET /api/library/packs — list all packs with a quick classification summary
// so you can tell which ones need reclassify-pack before running repair.
// POST /api/library/purge-failed — remove library entries stuck in the
// 'failed' status whose error indicates the download is dead and can't
// recover on its own ("metadata timeout" = couldn't fetch .torrent info
// on resume, which means the tracker/swarm is gone). Does NOT delete any
// files on disk — only removes the library rows so the UI stops listing
// them. Backs up _metadata.json before writing.
//
// Query params:
//   ?dryRun=1              preview only
//   ?includeFileMissing=1  also remove items whose error is
//                          "File not found on disk" (default: off)
//   ?includeAnyFailed=1    remove every 'failed' item regardless of
//                          error string. ONLY use this if you've
//                          verified the dry-run list looks right.
app.post('/api/library/purge-failed', rateLimit, (req, res) => {
  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  const includeFileMissing = req.query.includeFileMissing === '1' || req.query.includeFileMissing === 'true';
  const includeAnyFailed = req.query.includeAnyFailed === '1' || req.query.includeAnyFailed === 'true';

  const allItems = library.getAll();
  const failed = allItems.filter(i => i.status === 'failed');

  const toDelete = failed.filter(item => {
    if (includeAnyFailed) return true;
    const err = (item.error || '').toLowerCase();
    if (err.includes('metadata timeout')) return true;
    if (includeFileMissing && err.includes('file not found')) return true;
    return false;
  });

  // Backup before any write. Mirrors the repair endpoint's safety contract.
  let backupPath = null;
  if (!dryRun && toDelete.length > 0) {
    try {
      const metadataFile = library._metadataFile;
      if (metadataFile && fs.existsSync(metadataFile)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        backupPath = `${metadataFile}.pre-purge-${stamp}.bak`;
        fs.copyFileSync(metadataFile, backupPath);
        console.log(`[Purge] Backed up metadata to ${backupPath}`);
      } else {
        return res.status(500).json({ error: 'metadata file not found; refusing to run without a backup' });
      }
    } catch (err) {
      return res.status(500).json({ error: `failed to create metadata backup: ${err.message}` });
    }

    // Direct removal from the in-memory map. We deliberately DO NOT call
    // library.removeItem() because that also stops downloads, reshuffles
    // pack selection, and deletes files — none of which make sense here
    // (the items are already dead, have no file, and aren't downloading).
    // One _saveMetadata() at the end batches all deletions into a single
    // atomic metadata write.
    for (const item of toDelete) {
      library._items.delete(item.id);
    }
    library._saveMetadata();
    console.log(`[Purge] Removed ${toDelete.length} dead 'failed' items`);
  }

  // Group by error string for the summary
  const errorGroups = {};
  for (const item of toDelete) {
    const key = (item.error || '(no error)').slice(0, 80);
    errorGroups[key] = (errorGroups[key] || 0) + 1;
  }

  res.json({
    dryRun,
    failedTotal: failed.length,
    wouldRemove: toDelete.length,
    removed: dryRun ? 0 : toDelete.length,
    errorGroups,
    sample: toDelete.slice(0, 10).map(i => ({
      id: i.id,
      name: i.name,
      fileName: i.fileName,
      error: (i.error || '').slice(0, 80),
    })),
    backupPath: backupPath ? path.basename(backupPath) : null,
  });
});

// POST /api/library/add-manual — add a torrent by magnet URI or info hash.
// Handles both single-file and multi-file (collection) torrents automatically.
app.post('/api/library/add-manual', rateLimit, async (req, res) => {
  const { TRACKERS } = require('./lib/file-safety');
  let { magnetUri, infoHash, name, type, quality } = req.body;

  // Accept either a magnet URI or a bare info hash
  if (!magnetUri && !infoHash) {
    return res.status(400).json({ error: 'Provide a magnet URI or info hash' });
  }

  // Extract info hash from magnet URI
  if (magnetUri && !infoHash) {
    // Try hex (40 chars) then Base32 (32 chars) encoded info hashes
    const hexMatch = magnetUri.match(/xt=urn:btih:([a-f0-9]{40})/i);
    if (hexMatch) {
      infoHash = hexMatch[1].toLowerCase();
    } else {
      const b32Match = magnetUri.match(/xt=urn:btih:([A-Za-z2-7]{32})/);
      if (b32Match) {
        try { infoHash = Buffer.from(b32Match[1], 'base32').toString('hex').toLowerCase(); } catch {}
      }
      if (!infoHash) {
        return res.status(400).json({ error: 'Could not extract info hash from magnet URI' });
      }
    }
  }

  // Also accept Base32 bare info hashes
  if (infoHash && /^[A-Za-z2-7]{32}$/.test(infoHash)) {
    try { infoHash = Buffer.from(infoHash, 'base32').toString('hex').toLowerCase(); } catch {}
  }

  if (!/^[0-9a-f]{40}$/i.test(infoHash)) {
    return res.status(400).json({ error: 'Invalid info hash — must be 40 hex characters or 32 Base32 characters' });
  }
  infoHash = infoHash.toLowerCase();

  // Build a magnet URI from info hash if only hash was provided
  if (!magnetUri) {
    const trackerParams = TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');
    magnetUri = `magnet:?xt=urn:btih:${infoHash}${trackerParams}`;
  }

  if (!magnetUri.startsWith('magnet:?')) {
    return res.status(400).json({ error: 'Invalid magnet URI' });
  }

  // Extract display name from magnet URI dn= param if no name provided
  if (!name) {
    const dnMatch = magnetUri.match(/[?&]dn=([^&]+)/);
    name = dnMatch ? decodeURIComponent(dnMatch[1]).replace(/\+/g, ' ') : `Torrent ${infoHash.slice(0, 8)}`;
  }

  try {
    const result = await library.addManual({
      imdbId: null,
      type: ['movie', 'series'].includes(type) ? type : 'movie',
      name,
      poster: '',
      year: '',
      magnetUri,
      infoHash,
      quality: quality || '',
      size: '',
    });
    res.json(result);
  } catch (err) {
    console.error('[API] Manual torrent add error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/library/restart-pack — restart a pack download (re-scan torrent for all episodes)
app.post('/api/library/restart-pack', rateLimit, async (req, res) => {
  const { packId } = req.body;
  if (!packId) return res.status(400).json({ error: 'packId is required' });

  try {
    const result = await library.restartPack(packId);
    res.json(result);
  } catch (err) {
    console.error('[API] Restart pack error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/library/find-missing-show — find missing episodes for a tracked
// show. Uses TMDB to determine the show's true season/episode list, then
// for every season that's not fully present locally, searches for a season
// pack torrent and adds it. addSeasonPack dedupes by (imdbId, season,
// episode) so episodes already on disk are not re-downloaded.
app.post('/api/library/find-missing-show', rateLimit, express.json(), async (req, res) => {
  const { imdbId } = req.body || {};
  let { title, year, poster } = req.body || {};

  if (!imdbId || !/^tt\d+$/.test(imdbId)) {
    return res.status(400).json({ error: 'Valid imdbId is required' });
  }
  if (!TMDB_API_KEY) {
    return res.status(503).json({ error: 'TMDB API key not configured' });
  }

  // Fill missing title/year/poster from an existing library item for this show.
  if (!title || !poster) {
    const existing = library.getAll().find(i => i.imdbId === imdbId);
    if (existing) {
      title = title || existing.showName || existing.name;
      year = year || existing.year;
      poster = poster || existing.poster;
    }
  }
  if (!title) return res.status(400).json({ error: 'title is required (none inferred from existing items)' });

  try {
    // IMDb → TMDB id, then fetch season list with episode counts.
    const findResult = await tmdbFetch(`/find/${imdbId}`, { external_source: 'imdb_id' });
    const tvResults = findResult.tv_results || [];
    if (tvResults.length === 0) return res.status(404).json({ error: 'Show not found on TMDB' });
    const tmdbId = tvResults[0].id;
    const seriesData = await tmdbFetch(`/tv/${tmdbId}`);
    const tmdbSeasons = (seriesData.seasons || []).filter(s => s.season_number > 0 && (s.episode_count || 0) > 0);
    if (tmdbSeasons.length === 0) return res.status(404).json({ error: 'No seasons found on TMDB' });

    // What do we already have locally for this show?
    const haveBySeason = new Map(); // seasonNum -> Set<episodeNum>
    for (const i of library.getAll()) {
      if (i.imdbId !== imdbId) continue;
      if (!i.season || !i.episode) continue;
      if (!haveBySeason.has(i.season)) haveBySeason.set(i.season, new Set());
      haveBySeason.get(i.season).add(i.episode);
    }

    // Which seasons are incomplete? (Includes fully-missing seasons.)
    const incompleteSeasons = tmdbSeasons
      .map(s => ({ season: s.season_number, expected: s.episode_count, have: (haveBySeason.get(s.season_number) || new Set()).size }))
      .filter(s => s.have < s.expected);

    if (incompleteSeasons.length === 0) {
      return res.json({ started: 0, seasons: [], message: 'All seasons fully present' });
    }

    // For each incomplete season, search for a season pack and add it.
    // Sequential to avoid hammering torrent providers and to let each
    // addSeasonPack finish registering items before the next one starts.
    const seasonResults = [];
    let totalStarted = 0;
    for (const s of incompleteSeasons) {
      try {
        const streams = await getSeasonPackStreams(title, s.season, imdbId);
        if (!streams || streams.length === 0) {
          seasonResults.push({ season: s.season, missing: s.expected - s.have, error: 'no_pack_found' });
          continue;
        }
        const top = streams[0];
        const r = await library.addSeasonPack({
          imdbId,
          name: title,
          poster: poster || '',
          year: year || '',
          magnetUri: top.magnetUri,
          infoHash: top.infoHash,
          quality: top.quality || '',
          size: top.size || '',
          season: s.season,
        });
        const started = (r.items || []).filter(i => i.status === 'started').length;
        totalStarted += started;
        seasonResults.push({ season: s.season, missing: s.expected - s.have, started });
      } catch (err) {
        seasonResults.push({ season: s.season, missing: s.expected - s.have, error: err.message });
      }
    }

    res.json({ started: totalStarted, seasons: seasonResults });
  } catch (err) {
    console.error('[API] Find-missing-show error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/library/:id — remove item from library
app.delete('/api/library/:id', rateLimit, (req, res) => {
  const removed = library.removeItem(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Item not found' });
  res.json({ success: true });
});

// POST /api/library/:id/pause — pause a downloading item
app.post('/api/library/:id/pause', rateLimit, (req, res) => {
  const paused = library.pauseItem(req.params.id);
  if (!paused) return res.status(400).json({ error: 'Cannot pause this item' });
  res.json({ success: true });
});

// POST /api/library/:id/resume — resume a paused item
app.post('/api/library/:id/resume', rateLimit, (req, res) => {
  const resumed = library.resumeItem(req.params.id);
  if (!resumed) return res.status(400).json({ error: 'Cannot resume this item' });
  res.json({ success: true });
});

// POST /api/library/:id/retry — retry a failed download
app.post('/api/library/:id/retry', rateLimit, (req, res) => {
  const retried = library.retryItem(req.params.id);
  if (!retried) return res.status(400).json({ error: 'Cannot retry this item' });
  res.json({ success: true });
});

// POST /api/library/:id/start — force-start a queued item (if slots available)
app.post('/api/library/:id/start', rateLimit, (req, res) => {
  const started = library.startQueuedItem(req.params.id);
  if (!started) return res.status(400).json({ error: 'Cannot start this item (no available slots or not queued)' });
  res.json({ success: true });
});

// POST /api/library/:id/reorder — reorder a queued item
app.post('/api/library/:id/reorder', rateLimit, (req, res) => {
  const position = parseInt(req.body.position, 10);
  if (isNaN(position) || position < 0) {
    return res.status(400).json({ error: 'Invalid position' });
  }
  const reordered = library.reorderQueue(req.params.id, position);
  if (!reordered) return res.status(400).json({ error: 'Cannot reorder this item' });
  res.json({ success: true });
});

// POST /api/library/pause-pack — atomically pause every item in a pack
app.post('/api/library/pause-pack', rateLimit, (req, res) => {
  const { packId } = req.body;
  if (!packId) return res.status(400).json({ error: 'packId is required' });
  const paused = library.pausePack(packId);
  if (!paused) return res.status(400).json({ error: 'Cannot pause this pack' });
  res.json({ success: true });
});

// POST /api/library/resume-pack — atomically resume every paused item in a pack
app.post('/api/library/resume-pack', rateLimit, (req, res) => {
  const { packId } = req.body;
  if (!packId) return res.status(400).json({ error: 'packId is required' });
  const resumed = library.resumePack(packId);
  if (!resumed) return res.status(400).json({ error: 'Cannot resume this pack' });
  res.json({ success: true });
});

// POST /api/library/retry-pack — atomically retry every failed item in a pack
app.post('/api/library/retry-pack', rateLimit, (req, res) => {
  const { packId } = req.body;
  if (!packId) return res.status(400).json({ error: 'packId is required' });
  const retried = library.retryPack(packId);
  if (!retried) return res.status(400).json({ error: 'Cannot retry this pack' });
  res.json({ success: true });
});

// POST /api/library/start-pack — force-start a queued pack (if slots available)
app.post('/api/library/start-pack', rateLimit, (req, res) => {
  const { packId } = req.body;
  if (!packId) return res.status(400).json({ error: 'packId is required' });
  const started = library.startPack(packId);
  if (!started) return res.status(400).json({ error: 'Cannot start this pack (no free slots or no queued items)' });
  res.json({ success: true });
});

// DELETE /api/library/pack/:packId — atomically remove every item in a pack
app.delete('/api/library/pack/:packId', rateLimit, (req, res) => {
  const removed = library.removePack(req.params.packId);
  if (!removed) return res.status(404).json({ error: 'Pack not found' });
  res.json({ success: true });
});

// POST /api/library/reorder-pack — reorder a queued pack in the queue
app.post('/api/library/reorder-pack', rateLimit, (req, res) => {
  const { packId, position } = req.body;
  if (!packId) return res.status(400).json({ error: 'packId is required' });
  const pos = parseInt(position, 10);
  if (isNaN(pos) || pos < 0) return res.status(400).json({ error: 'Invalid position' });
  const reordered = library.reorderPackQueue(packId, pos);
  if (!reordered) return res.status(400).json({ error: 'Cannot reorder this pack' });
  res.json({ success: true });
});

// POST /api/library/bulk-relink — re-link all episodes matching a showName to a new IMDB entry.
// Auto-fetches poster from TMDB if not provided.
app.post('/api/library/bulk-relink', rateLimit, async (req, res) => {
  const { matchShowName, imdbId, showName, year } = req.body || {};
  if (!matchShowName) return res.status(400).json({ error: 'matchShowName is required' });
  if (!imdbId || !/^tt\d{1,10}$/.test(imdbId)) return res.status(400).json({ error: 'Valid imdbId is required' });

  // Auto-fetch poster and year from TMDB if available
  let poster = req.body.poster || null;
  let resolvedYear = year;
  if (TMDB_API_KEY) {
    try {
      const findData = await tmdbFetch('/find/' + imdbId, { external_source: 'imdb_id' });
      const tvResults = findData.tv_results || [];
      if (tvResults.length > 0) {
        const show = tvResults[0];
        if (!poster && show.poster_path) poster = `https://image.tmdb.org/t/p/w342${show.poster_path}`;
        if (!resolvedYear) resolvedYear = (show.first_air_date || '').slice(0, 4);
      }
    } catch (err) {
      console.warn('[Bulk-relink] TMDB poster lookup failed:', err.message);
    }
  }

  const allItems = library.getAll();
  const matchLower = matchShowName.toLowerCase();
  const matches = allItems.filter(i => (i.showName || '').toLowerCase() === matchLower);
  let updated = 0;

  for (const item of matches) {
    const success = library.relinkItem(item.id, {
      imdbId,
      showName: showName || matchShowName,
      poster,
      year: resolvedYear,
    });
    if (success) updated++;
  }

  console.log(`[Bulk-relink] "${matchShowName}" -> "${showName || matchShowName}" (${imdbId}), ${updated}/${matches.length} updated`);
  res.json({ matched: matches.length, updated, showName: showName || matchShowName, imdbId, poster, year: resolvedYear });
});

// POST /api/library/:id/relink — manually re-link a library item to a different IMDB entry
app.post('/api/library/:id/relink', rateLimit, (req, res) => {
  const { imdbId, name, poster, year, type, showName } = req.body || {};
  if (!imdbId) return res.status(400).json({ error: 'imdbId is required' });
  if (!/^tt\d{1,10}$/.test(imdbId)) return res.status(400).json({ error: 'Invalid IMDB ID format' });

  let targetId = req.params.id;
  // Disk-discovered items are virtual — promote to a tracked item before writing.
  if (targetId.startsWith('disk_')) {
    const promoted = library.promoteDiskItem(targetId);
    if (!promoted) return res.status(404).json({ error: 'File not found on disk' });
    targetId = promoted;
  }

  const success = library.relinkItem(targetId, { imdbId, name, poster, year, type, showName }, 'manual');
  if (!success) return res.status(404).json({ error: 'Item not found' });
  res.json({ success: true, id: targetId });
});

// ─── Auto-match / Review queue ─────────────────────────────────────
// Runs the unified filename parser → TMDB candidate search → auto-apply
// at high confidence, else stash the top 5 candidates on the item so the
// UI can render them as one-click options.
// (The GET /review-queue route lives above /:id to avoid the :id match.)

// POST /api/library/:id/auto-match — run the auto-matcher on a single item.
// Use this after editing the parsed query or after adding new torrents.
app.post('/api/library/:id/auto-match', rateLimit, async (req, res) => {
  if (!TMDB_API_KEY) return res.status(503).json({ error: 'TMDB API key not configured' });

  let targetId = req.params.id;
  if (targetId.startsWith('disk_')) {
    const promoted = library.promoteDiskItem(targetId);
    if (!promoted) return res.status(404).json({ error: 'File not found on disk' });
    targetId = promoted;
  }

  const item = library.getItem(targetId);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  try {
    const result = await autoMatchOne(item);
    res.json({ ...result, item: library.getItem(targetId) });
  } catch (err) {
    console.error('[API] auto-match error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/library/auto-match-all — run the auto-matcher against every
// unresolved item in the library. Returns a summary of outcomes.
//
// Body (optional):
//   { force: true }   — re-match items that already have an imdbId but
//                       weren't confirmed manually (useful after a TMDB
//                       outage or a parser change)
//   { limit: 100 }    — cap the number of items processed per call so large
//                       libraries don't hold a request open for minutes.
//                       Defaults to 100.
//   { offset: 0 }     — skip the first N targets. Used by the client to
//                       paginate through large libraries without timing out.
//
// Response includes { total, remaining, nextOffset } so the client can loop
// until every target has been processed (previously the server silently
// dropped everything beyond the first `limit` items, so "total recheck"
// never actually rechecked libraries with more than 100 entries).
app.post('/api/library/auto-match-all', rateLimit, async (req, res) => {
  if (!TMDB_API_KEY) return res.status(503).json({ error: 'TMDB API key not configured' });

  const { force = false, limit = 100, offset = 0 } = req.body || {};
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const extIdCache = _makeExtIdCache();

  // Pick targets. When `force` is true we still respect items that were
  // already promoted to 'matched' during THIS recheck session — otherwise a
  // looping client would re-process the same items forever. We use the
  // auto-matcher's own audit trail (matchSource='auto' + recent matchedAt)
  // to detect that, but the simpler solution is pagination: the client
  // advances `offset` past items it has already seen this session.
  const all = library.getAll();
  const filtered = all.filter(i => {
    if (i.matchState === 'manual') return false;
    if (!i.fileName) return false;
    if (force) return true;
    const state = i.matchState || (i.imdbId && /^tt\d+$/.test(i.imdbId) ? 'matched' : 'unmatched');
    return state === 'unmatched' || state === 'needsReview';
  });
  const total = filtered.length;
  const targets = filtered.slice(safeOffset, safeOffset + safeLimit);
  const nextOffset = safeOffset + targets.length;
  const remaining = Math.max(0, total - nextOffset);

  console.log(`[AutoMatch] pass ${safeOffset}..${nextOffset}/${total} (force=${force})`);

  // Promote any disk items we're about to process.
  for (const t of targets) {
    if (t.id.startsWith('disk_')) library.promoteDiskItem(t.id);
  }

  const summary = { processed: 0, matched: 0, needsReview: 0, skipped: 0, errors: 0, items: [], total, remaining, nextOffset };

  // Sequential to stay polite with the TMDB rate limit.
  for (const t of targets) {
    try {
      const current = library.getItem(t.id);
      if (!current) { summary.skipped++; continue; }
      const outcome = await autoMatchOne(current, extIdCache);
      summary.processed++;
      if (outcome.action === 'matched') summary.matched++;
      else if (outcome.action === 'needsReview') summary.needsReview++;
      else summary.skipped++;
      summary.items.push(outcome);
    } catch (err) {
      summary.errors++;
      console.warn(`[AutoMatch] ${t.id}:`, err.message);
    }
  }

  console.log(`[AutoMatch] done: ${summary.matched} matched, ${summary.needsReview} needReview, ${summary.skipped} skipped, ${summary.errors} errors`);
  res.json(summary);
});

// POST /api/library/:id/mark-manual — mark an item as manually curated so
// subsequent auto-match passes leave it alone. Useful when the user accepts
// the current metadata even if no imdbId is attached.
app.post('/api/library/:id/mark-manual', rateLimit, (req, res) => {
  const item = library.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  // Re-use relinkItem so matchState flips to manual. Pass current metadata
  // as-is so the write is a no-op for fields the user didn't change.
  const ok = library.relinkItem(req.params.id, {
    imdbId: item.imdbId,
    name: item.name,
    poster: item.poster,
    year: item.year,
    type: item.type,
    showName: item.showName,
  }, 'manual');
  if (!ok) return res.status(404).json({ error: 'Item not found' });
  res.json({ success: true });
});

// GET /api/library/:id/stream — stream a completed library item
app.get('/api/library/:id/stream', async (req, res) => {
  const item = library.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.status !== 'complete' && item.status !== 'converting') {
    return res.status(400).json({ error: 'Download not complete' });
  }

  const filePath = library.getFilePath(req.params.id);
  if (!filePath) return res.status(404).json({ error: 'File not found' });

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  const fileSize = stat.size;
  const mimeType = library.getMimeType(filePath);
  const safeFilename = path.basename(filePath).replace(/[^\w\s.\-()[\]]/g, '_').replace(/["\\]/g, '_').substring(0, 200);

  const headers = {
    'Content-Type': mimeType,
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename="${safeFilename}"`,
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
  };

  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (isNaN(start) || isNaN(end) || start >= fileSize || end >= fileSize || start > end) {
      res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
      return;
    }

    res.status(206).set({
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': end - start + 1,
    });

    const stream = fs.createReadStream(filePath, { start, end });
    stream.pipe(res);
    stream.on('error', () => res.end());
    res.on('close', () => stream.destroy());
  } else {
    res.status(200).set({ ...headers, 'Content-Length': fileSize });
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('error', () => res.end());
    res.on('close', () => stream.destroy());
  }
});

// GET /api/library/:id/stream/remux — stream a library file remuxed to MP4 (AAC audio)
app.get('/api/library/:id/stream/remux', rateLimit, remuxGate, async (req, res) => {
  const item = library.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.status !== 'complete' && item.status !== 'converting') {
    return res.status(400).json({ error: 'Download not complete' });
  }

  const filePath = library.getFilePath(req.params.id);
  if (!filePath) return res.status(404).json({ error: 'File not found' });

  try {
    await fs.promises.stat(filePath);
  } catch {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  const safeFilename = path.basename(filePath).replace(/[^\w\s.\-()[\]]/g, '_').replace(/\.(mkv|avi|wmv|mp4)$/i, '.mp4').substring(0, 200);

  // Read the file directly (not via stdin pipe) so ffmpeg can seek within
  // it. MP4 sources that aren't faststart keep the moov atom at the END
  // of the file; a stdin-fed ffmpeg cannot rewind to fetch it and the
  // remux hangs until the client timeout. `-i filePath` lets ffmpeg seek,
  // which works for every mp4 regardless of moov position and is just as
  // fast (the kernel page cache hides the seeks).
  const ffmpeg = spawn('ffmpeg', [
    '-probesize', '5000000',
    '-analyzeduration', '5000000',
    '-i', filePath,
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

  // Same deferred-headers pattern as /stream/transcode: only commit to an
  // HTTP 200 + video/mp4 response once ffmpeg writes its first byte. If it
  // dies before emitting anything (input parse error, missing audio codec,
  // seek failure on a truncated moov) the client gets a real 5xx JSON
  // error instead of a zero-byte 200 that presents as MediaError code 4.
  let firstByteSent = false;
  let lastStderrLine = '';

  ffmpeg.stdout.once('data', (firstChunk) => {
    firstByteSent = true;
    res.status(200);
    res.set({
      'Content-Type': 'video/mp4',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename="${safeFilename}"`,
      'Cache-Control': 'no-store',
      'Transfer-Encoding': 'chunked',
    });
    res.write(firstChunk);
    ffmpeg.stdout.pipe(res);
  });

  ffmpeg.stderr.on('data', (data) => {
    const msg = data.toString();
    const trimmed = msg.trim();
    if (trimmed) {
      console.log(`[FFmpeg/Library] ${trimmed}`);
      const last = trimmed.split('\n').pop();
      if (last) lastStderrLine = last;
    }
  });

  ffmpeg.on('error', (err) => {
    console.error(`[Library] FFmpeg spawn error: ${err.message}`);
    if (!firstByteSent && !res.headersSent) {
      res.status(500).json({ error: 'Remux failed — FFmpeg not available' });
    } else {
      try { res.end(); } catch { /* ignore */ }
    }
  });

  ffmpeg.on('close', (code) => {
    if (code && code !== 0 && code !== 255) {
      console.warn(`[Library] FFmpeg exited with code ${code}`);
    }
    if (!firstByteSent && !res.headersSent) {
      res.status(502).json({
        error: 'Remux failed',
        reason: lastStderrLine || `ffmpeg exited with code ${code ?? 'unknown'}`,
      });
      return;
    }
    try { res.end(); } catch { /* ignore */ }
  });

  res.on('close', () => {
    try { ffmpeg.kill('SIGTERM'); } catch { /* ignore */ }
  });
});

// GET /api/library/:id/stream/transcode?caps=...
// Full video re-encode to H.264 + AAC in fragmented MP4. This is the
// LAST-RESORT fallback for clients that can't play the source video
// codec AND the background pre-transcode hasn't produced a universal
// MP4 yet. In the happy path this endpoint is never hit — the library
// manager pre-converts non-universal sources to stored H.264/AAC/MP4
// at download time and serves them through the plain /stream endpoint.
//
// Output target is intentionally conservative for maximum compatibility:
//   Video : H.264 main profile, level 4.1, yuv420p, max 720p
//   Audio : AAC-LC, 192k, stereo downmix
//   Container : fragmented MP4 (streamable over HTTP, no seek)
//
// libx264 -preset ultrafast is used because the Jetson Orin Nano has NO
// hardware video encoder — this path is CPU-bound. 720p keeps us within
// realtime budget on the Orin's Cortex-A78AE cores for typical 24/30 fps
// source material. Set FFMPEG_HWACCEL=cuda (or =nvdec / =auto / =v4l2m2m
// depending on the local ffmpeg build) to offload the DECODE side of the
// pipeline to NVDEC, which alone buys ~30-50% more CPU headroom for
// libx264 on HEVC sources. If you upgrade to a Jetson with NVENC later,
// swap the encoder args for h264_nvenc or h264_nvmpi.
app.get('/api/library/:id/stream/transcode', rateLimit, transcodeGate, async (req, res) => {
  const item = library.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.status !== 'complete' && item.status !== 'converting') {
    return res.status(400).json({ error: 'Download not complete' });
  }

  // CPU contention guard: if a background conversion is actively running
  // for THIS item, two ffmpeg processes on the same source starve each
  // other on the Orin Nano's 6 cores and neither finishes in time to
  // satisfy the client's stall timer. Tell the client to wait for the
  // background job instead — it will produce a directly-playable MP4.
  const convState = library.getConversionState(req.params.id);
  if (convState && convState.active) {
    res.status(503).set({
      'Content-Type': 'application/json',
      'X-Conversion-Kind': convState.kind || 'unknown',
      'X-Conversion-Progress': String(convState.progress || 0),
      'Retry-After': '60',
    });
    return res.json({
      error: 'Background conversion in progress',
      convertKind: convState.kind,
      convertProgress: convState.progress,
      message: 'A universal MP4 is being prepared. Try again in a few minutes.',
    });
  }

  const filePath = library.getFilePath(req.params.id);
  if (!filePath) return res.status(404).json({ error: 'File not found' });

  try {
    await fs.promises.stat(filePath);
  } catch {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  // Disk preflight. A live transcode emits into memory (no output file)
  // but ffmpeg still needs scratch space for its input buffers, and a
  // full disk has a way of wedging every open fd at once. Refuse early
  // with a real HTTP error so the client can show a meaningful message
  // instead of waiting out the 90s stall timer on a doomed request.
  const diskCheck = await library.hasLiveTranscodeDiskSpace();
  if (!diskCheck.ok) {
    return res.status(507).set('Retry-After', '300').json({
      error: 'Insufficient disk space',
      reason: diskCheck.reason,
    });
  }

  const safeFilename = path.basename(filePath)
    .replace(/[^\w\s.\-()[\]]/g, '_')
    .replace(/\.(mkv|avi|wmv|mp4|mov|m4v|flv|webm|ts|mpg|mpeg)$/i, '.mp4')
    .substring(0, 200);

  // Read the source file directly (not via stdin). For a full transcode we
  // read the whole file anyway so there's no benefit to the sequential
  // pipe trick the remux endpoint uses, and letting ffmpeg open the file
  // itself means it can read the moov atom up front (faster startup).
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner',
    '-fflags', '+genpts',
    ...FFMPEG_HWACCEL_ARGS,
    // Keep initial input parse cheap — 1MB / 1s probe is plenty for
    // every container we ingest, and waiting any longer just delays
    // the first MP4 fragment on the wire.
    '-probesize', '1000000',
    '-analyzeduration', '1000000',
    '-i', filePath,

    // Select first video + first audio stream, drop everything else.
    // Subtitles and data streams in MKV files routinely break ffmpeg
    // when mapped to mp4 without explicit handling.
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-sn',
    '-dn',

    // Video: H.264 main profile L4.1, widest compatibility. ultrafast
    // preset is the only one that keeps up with realtime on Orin Nano
    // software encoding. zerolatency trims the GOP to minimize first-
    // frame delay. Scale to 720p max, preserve aspect, even height.
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-profile:v', 'main',
    '-level', '4.1',
    '-pix_fmt', 'yuv420p',
    '-crf', '23',
    '-vf', "scale='min(1280,iw)':'-2'",
    // Short GOP so we get an IDR — and therefore a flushable fragment —
    // within ~2 seconds regardless of the source's native keyframe
    // interval. This is the single biggest knob for first-byte latency
    // on a live transcode.
    '-g', '48',
    '-keyint_min', '48',
    '-sc_threshold', '0',

    // Audio: AAC LC stereo. Even 5.1 sources get downmixed so phone
    // speakers and stereo laptops don't get a broken center channel.
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ac', '2',
    '-ar', '48000',

    // Fragmented MP4 that can be streamed over a single HTTP response
    // with no server-side seeking. Browsers can play it back as it arrives
    // but cannot seek past what's been received. 500ms fragment duration
    // pairs with the short GOP to flush the first playable byte to the
    // client well before any client-side stall timer fires.
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration', '500000',
    '-f', 'mp4',
    '-loglevel', 'warning',
    'pipe:1',
  ]);

  // Claim a live-transcode slot so any background local-libx264 job
  // defers instead of racing us for the Orin's 6 cores. Must be released
  // exactly once regardless of which exit path we take (first-byte vs
  // early-death vs client abort), so a flag + guarded release on 'close'.
  library.incrementLiveTranscodes();
  let liveSlotReleased = false;
  const releaseLiveSlot = () => {
    if (liveSlotReleased) return;
    liveSlotReleased = true;
    library.decrementLiveTranscodes();
  };

  // Defer flushing the HTTP response headers until ffmpeg actually writes
  // its first output byte. If ffmpeg dies early (bad hwaccel arg, codec
  // missing, input parse error, file truncation caught by the decoder) we
  // can still send a proper 5xx JSON error — instead of a 200 + video/mp4
  // with a zero-byte body, which every browser's <video> element surfaces
  // as MEDIA_ERR_SRC_NOT_SUPPORTED (code 4) with no usable diagnostics.
  let firstByteSent = false;
  let lastStderrLine = '';

  const flushHeadersAndWrite = (firstChunk) => {
    firstByteSent = true;
    res.status(200);
    res.set({
      'Content-Type': 'video/mp4',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename="${safeFilename}"`,
      'Cache-Control': 'no-store',
      'Transfer-Encoding': 'chunked',
    });
    res.write(firstChunk);
    ffmpeg.stdout.pipe(res);
  };

  ffmpeg.stdout.once('data', flushHeadersAndWrite);

  ffmpeg.stderr.on('data', (data) => {
    const msg = data.toString();
    const trimmed = msg.trim();
    if (trimmed) {
      console.log(`[FFmpeg/Transcode] ${trimmed}`);
      const last = trimmed.split('\n').pop();
      if (last) lastStderrLine = last;
    }
  });

  ffmpeg.on('error', (err) => {
    // Node normally also fires 'close' after a failed spawn, but this
    // is belt-and-suspenders: release the slot here too, guarded by
    // the liveSlotReleased flag so the real 'close' still sees it as
    // already-released and no-ops. Cheaper than reasoning about the
    // exact Node edge cases where only 'error' fires.
    releaseLiveSlot();
    console.error(`[Library] FFmpeg transcode spawn error: ${err.message}`);
    if (!firstByteSent && !res.headersSent) {
      res.status(500).json({ error: 'Transcode failed — FFmpeg not available' });
    } else {
      try { res.end(); } catch { /* ignore */ }
    }
  });

  ffmpeg.on('close', (code) => {
    releaseLiveSlot();
    if (code && code !== 0 && code !== 255) {
      console.warn(`[Library] FFmpeg transcode exited with code ${code}`);
    }
    if (!firstByteSent && !res.headersSent) {
      // Dead on arrival — no bytes ever made it to `res`, so we still own
      // the status line. Send a real HTTP error with the ffmpeg stderr
      // tail so the client can log / display something actionable instead
      // of the opaque MediaError code 4.
      res.status(502).json({
        error: 'Transcode failed',
        reason: lastStderrLine || `ffmpeg exited with code ${code ?? 'unknown'}`,
      });
      return;
    }
    try { res.end(); } catch { /* ignore */ }
  });

  // Client aborted (tab closed, seek requested, fallback triggered) —
  // kill ffmpeg immediately so we don't waste CPU on output nobody wants.
  res.on('close', () => {
    try { ffmpeg.kill('SIGTERM'); } catch { /* ignore */ }
  });
});

// GET /api/library/:id/stream/hls/playlist.m3u8
// HLS-based transcode path, used in preference to /stream/transcode by
// clients whose browsers natively speak HLS (all Safari variants, iOS
// in particular — the fMP4 transcode path's chunked + empty_moov combo
// isn't reliably playable there). Spawns one ffmpeg per library item,
// blocks until the first .ts segment is on disk, then serves the m3u8
// playlist so the browser can start pulling segments. The playlist uses
// relative URLs so /segment requests resolve under this same path.
app.get('/api/library/:id/stream/hls/playlist.m3u8', rateLimit, async (req, res) => {
  const item = library.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.status !== 'complete' && item.status !== 'converting') {
    return res.status(400).json({ error: 'Download not complete' });
  }

  const filePath = library.getFilePath(req.params.id);
  if (!filePath) return res.status(404).json({ error: 'File not found' });

  try {
    await fs.promises.stat(filePath);
  } catch {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  // Look up the session AFTER the awaits above — if we looked earlier
  // two simultaneous playlist requests for the same item could both race
  // past `if (!session)` during the fs.stat await and both spawn ffmpeg.
  // All checks from here down are synchronous, so the second caller of a
  // pair sees the session the first created and skips the spawn.
  let session = hlsSessions.get(req.params.id);
  if (!session) {
    // Own the cpu-bound session count independently from the fMP4
    // transcodeGate. An HLS session runs ffmpeg for the full movie
    // duration, so it's fundamentally different from per-request gating.
    if (hlsSessions.size >= MAX_CONCURRENT_HLS_SESSIONS) {
      return res.status(429).set('Retry-After', '30').json({
        error: 'Server busy — too many concurrent HLS sessions. Try again shortly.',
      });
    }
    // Don't spin up HLS while a background conversion is already producing
    // a direct-playable mp4 — two parallel libx264 processes starve the
    // Jetson of CPU and both finish slower than one.
    const convState = library.getConversionState(req.params.id);
    if (convState && convState.active) {
      return res.status(503).set({
        'X-Conversion-Kind': convState.kind || 'unknown',
        'X-Conversion-Progress': String(convState.progress || 0),
        'Retry-After': '60',
      }).json({
        error: 'Background conversion in progress',
        convertKind: convState.kind,
        convertProgress: convState.progress,
      });
    }
    // Disk preflight. HLS writes .ts segments to a per-session dir and
    // a full disk lets ffmpeg hang silently on ENOSPC. Fail fast.
    const diskCheck = await library.hasLiveTranscodeDiskSpace();
    if (!diskCheck.ok) {
      return res.status(507).set('Retry-After', '300').json({
        error: 'Insufficient disk space',
        reason: diskCheck.reason,
      });
    }
    try {
      session = _startHlsSession(req.params.id, filePath);
    } catch (err) {
      console.error(`[HLS] Could not start session for ${req.params.id}: ${err.message}`);
      return res.status(500).json({ error: 'Could not start HLS transcode', reason: err.message });
    }
  }

  session.lastAccessMs = Date.now();

  // Block until ffmpeg has produced at least one segment and written the
  // playlist file. Poll every 200ms up to HLS_FIRST_SEGMENT_WAIT_MS. We
  // also exit the wait early if the session gets killed (ffmpeg crashed).
  const waitStart = Date.now();
  while (Date.now() - waitStart < HLS_FIRST_SEGMENT_WAIT_MS) {
    if (session.ended) break;
    try {
      const content = await fs.promises.readFile(session.playlistPath, 'utf8');
      // A usable playlist has at least one #EXTINF + segment_N.ts pair.
      if (content.includes('#EXTINF:') && /segment_\d+\.ts/.test(content)) {
        session.lastAccessMs = Date.now();
        res.set({
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-store',
        });
        return res.send(content);
      }
    } catch { /* playlist not yet written */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // Didn't get a first segment in time — surface ffmpeg's last stderr
  // line so we can diagnose from `docker logs`.
  const reason = session.ended
    ? (session.stderrTail || 'ffmpeg exited before first segment')
    : 'timeout waiting for first segment';
  _stopHlsSession(req.params.id, reason);
  return res.status(502).json({ error: 'HLS transcode failed', reason });
});

// GET /api/library/:id/stream/hls/:segment
// Serves .ts segments that ffmpeg is writing to the session directory.
// If a segment hasn't been written yet (client is asking ahead of the
// transcoder), block briefly for it to appear. Segment requests keep the
// session alive so the idle cleanup doesn't kill ffmpeg mid-watch.
app.get('/api/library/:id/stream/hls/:segment', rateLimit, async (req, res) => {
  // Pin the segment name to the exact pattern ffmpeg writes so a client
  // can't use this endpoint to read arbitrary files under the cache dir.
  const name = req.params.segment;
  if (!/^segment_\d+\.ts$/.test(name)) {
    return res.status(400).json({ error: 'Invalid segment name' });
  }

  const session = hlsSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'HLS session not found — start by requesting playlist.m3u8' });

  session.lastAccessMs = Date.now();
  const segmentPath = path.join(session.dir, name);

  // The segment may not exist yet if the client is asking ahead of the
  // transcoder. Poll for up to HLS_SEGMENT_WAIT_MS before giving up.
  const waitStart = Date.now();
  while (Date.now() - waitStart < HLS_SEGMENT_WAIT_MS) {
    if (session.ended) break;
    try {
      const st = await fs.promises.stat(segmentPath);
      if (st.size > 0) break;
    } catch { /* not there yet */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  if (session.ended && !fs.existsSync(segmentPath)) {
    return res.status(502).json({ error: 'HLS session ended before segment was produced', reason: session.stderrTail });
  }
  if (!fs.existsSync(segmentPath)) {
    return res.status(404).json({ error: 'Segment not available yet' });
  }

  session.lastAccessMs = Date.now();
  res.set({
    'Content-Type': 'video/mp2t',
    // Segments don't change once written — let the browser cache them
    // within the tab for smooth seeking back. no-store would force a
    // re-fetch every time the user scrubs back a few seconds.
    'Cache-Control': 'public, max-age=3600, immutable',
  });

  const stream = fs.createReadStream(segmentPath);
  stream.on('error', (err) => {
    console.warn(`[HLS] Segment stream error for ${req.params.id}/${name}: ${err.message}`);
    try { res.end(); } catch { /* ignore */ }
  });
  stream.pipe(res);
});

// ─── Library Probe Helpers ───────────────────────────────────────────
// Parse the `caps` query param the client sends to /probe and /transcode.
// Format: comma-separated feature tokens — "h264,hevc,aac,mp3". Any token
// missing from the list is treated as false (conservative default). Any
// unknown token is ignored. Invalid input falls back to an empty caps set
// which will force transcode for every codec — safe but slow.
function parseClientCaps(rawCaps) {
  const caps = { h264: false, hevc: false, aac: false, mp3: false };
  if (typeof rawCaps !== 'string' || !rawCaps) return caps;
  for (const token of rawCaps.split(',')) {
    const t = token.trim().toLowerCase();
    if (t in caps) caps[t] = true;
  }
  return caps;
}

// GET /api/library/:id/probe?caps=h264,hevc,aac,mp3
// Probes the file and tells the client exactly which playback endpoint
// to use: direct, remux, transcode, or unplayable. The `caps` query
// parameter lets the server reason about THIS client's decoder — a file
// that's "direct play" on Safari may need transcoding on Linux Firefox.
app.get('/api/library/:id/probe', async (req, res) => {
  const item = library.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.status !== 'complete' && item.status !== 'converting') {
    return res.status(400).json({ error: 'Download not complete' });
  }

  const filePath = library.getFilePath(req.params.id);
  if (!filePath) return res.status(404).json({ error: 'File not found' });

  const probe = await library._probeFile(filePath);
  const caps = parseClientCaps(req.query.caps);
  const decision = library.classifyForClient(probe, caps);

  // Log the probe outcome so we can diagnose failed playbacks from the
  // server side. Include enough context to correlate with client reports:
  // item name, full file path, decision action, and ffprobe reason if any.
  if (decision.action === 'unplayable') {
    let fileSize = '?';
    try { fileSize = String(fs.statSync(filePath).size); } catch { /* ignore */ }
    console.warn(
      `[Library] Probe UNPLAYABLE: "${item.name}" ` +
      `file=${filePath} size=${fileSize}B ` +
      `reason=${decision.reason || '?'}`
    );
  } else {
    console.log(
      `[Library] Probe ${decision.action}: "${item.name}" ` +
      `video=${decision.videoCodec || '?'} profile=${decision.videoProfile || '?'} ` +
      `pix=${decision.pixFmt || '?'} audio=${decision.audioCodec || '?'} ` +
      `ext=${decision.ext} caps=${req.query.caps || '(none)'} ` +
      `${decision.reason ? 'reason=' + decision.reason : ''}`
    );
  }

  // Suggest the exact path the client should request. Keeps the client
  // logic dumb — it just follows whatever we say.
  const idParam = encodeURIComponent(req.params.id);
  const endpoints = {
    direct:   `/api/library/${idParam}/stream`,
    remux:    `/api/library/${idParam}/stream/remux`,
    transcode: `/api/library/${idParam}/stream/transcode?caps=${encodeURIComponent(req.query.caps || '')}`,
  };

  // Expose background-conversion state so the client can show a
  // "Converting X%" message instead of hammering live transcode while
  // the permanent MP4 is being produced.
  const convState = library.getConversionState(req.params.id);

  res.json({
    action: decision.action,
    reason: decision.reason,
    endpoint: endpoints[decision.action] || null,
    container: decision.container,
    ext: decision.ext,
    videoCodec: decision.videoCodec,
    videoProfile: decision.videoProfile,
    pixFmt: decision.pixFmt,
    audioCodec: decision.audioCodec,
    duration: decision.duration,
    conversion: convState,
    // Legacy flag kept so older clients still get a sensible answer while
    // rolling out. TRUE only for the 'direct' action.
    directPlay: decision.action === 'direct',
  });
});

// ─── Stremio Addon Proxy ──────────────────────────────────────────────
// Proxy JSON requests to Stremio addons to avoid CORS issues.
const ADDON_JSON_PATH_RE = /^\/(manifest\.json|catalog\/|meta\/|stream\/)/;
// In-memory cache of Stremio addon-proxy responses. Every home/catalog
// browse resolves the same handful of addon manifests and catalogs, so
// a short TTL here eliminates the repeat upstream fetch while still
// picking up addon changes within a few minutes. Size-capped LRU so
// a long-running server doesn't grow the map forever. Failures are
// NOT cached — addon downtime should retry on the next request.
const ADDON_PROXY_CACHE_MAX    = 256;
const ADDON_PROXY_CACHE_TTL_MS = 5 * 60 * 1000;
const _addonProxyCache = new Map(); // url -> { value, expiresAt }

app.get('/api/addon-proxy', rateLimit, async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'Missing url parameter' });

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'Invalid URL protocol' });
  }

  if (!ADDON_JSON_PATH_RE.test(parsed.pathname)) {
    return res.status(400).json({ error: 'Disallowed path' });
  }

  const cached = _addonProxyCache.get(targetUrl);
  if (cached && Date.now() < cached.expiresAt) {
    // LRU touch
    _addonProxyCache.delete(targetUrl);
    _addonProxyCache.set(targetUrl, cached);
    return res.json(cached.value);
  }

  try {
    await validateUrlNotSSRF(targetUrl);
    const body = await fetchUrl(targetUrl);
    const data = JSON.parse(body);
    if (_addonProxyCache.size >= ADDON_PROXY_CACHE_MAX) {
      const oldest = _addonProxyCache.keys().next().value;
      if (oldest !== undefined) _addonProxyCache.delete(oldest);
    }
    _addonProxyCache.set(targetUrl, { value: data, expiresAt: Date.now() + ADDON_PROXY_CACHE_TTL_MS });
    res.json(data);
  } catch (err) {
    console.error(`[AddonProxy] Error fetching ${targetUrl}: ${err.message}`);
    res.status(502).json({ error: 'Failed to fetch addon data' });
  }
});

// ─── IPTV / Live TV Endpoints ─────────────────────────────────────────

// In-memory playlist cache: Map<url, { channels, fetchedAt }>
const playlistCache = new Map();
const PLAYLIST_CACHE_MAX = 20;
const PLAYLIST_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// ─── SSRF Protection ──────────────────────────────────────────────────
const BLOCKED_IP_RANGES = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^169\.254\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./, /^::1$/,
  /^fc00:/, /^fe80:/, /^fd/, /^localhost$/i,
];

function isBlockedHost(hostname) {
  return BLOCKED_IP_RANGES.some(re => re.test(hostname));
}

async function validateUrlNotSSRF(urlStr) {
  const parsed = new URL(urlStr);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Invalid URL protocol');
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new Error('Blocked host');
  }
  // Resolve DNS to check the actual IP
  try {
    const { address } = await dns.promises.lookup(parsed.hostname);
    if (isBlockedHost(address)) {
      throw new Error('Blocked host (resolved IP)');
    }
  } catch (err) {
    if (err.message.includes('Blocked')) throw err;
    // DNS resolution failure — allow the request to fail naturally
  }
}

const MAX_REDIRECTS = 5;

const MAX_FETCH_BODY = 10 * 1024 * 1024; // 10 MB max response body

function fetchUrlDirect(url, redirectCount = 0, resolvedIp = null) {
  if (redirectCount > MAX_REDIRECTS) {
    return Promise.reject(new Error('Too many redirects'));
  }
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const parsedUrl = new URL(url);
    const deadline = setTimeout(() => {
      if (req) req.destroy();
      reject(new Error('Timeout'));
    }, 10000);
    const options = {
      hostname: resolvedIp || parsedUrl.hostname,
      port: parsedUrl.port || (mod === https ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'User-Agent': 'Albatross/1.0',
        ...(resolvedIp ? { Host: parsedUrl.hostname } : {}),
      },
      timeout: 10000,
      family: 4,
      servername: parsedUrl.hostname,
    };
    const req = mod.get(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(deadline);
        const redirectUrl = res.headers.location;
        res.resume();
        return validateUrlNotSSRF(redirectUrl)
          .then(() => fetchUrl(redirectUrl, redirectCount + 1))
          .then(resolve, reject);
      }
      if (res.statusCode !== 200) { clearTimeout(deadline); res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > MAX_FETCH_BODY) { clearTimeout(deadline); res.destroy(); reject(new Error('Response too large')); }
      });
      res.on('end', () => { clearTimeout(deadline); resolve(body); });
    });
    req.on('error', (e) => { clearTimeout(deadline); reject(e); });
    req.on('timeout', () => { clearTimeout(deadline); req.destroy(); reject(new Error('Timeout')); });
  });
}

async function fetchUrl(url, redirectCount = 0) {
  try {
    return await fetchUrlDirect(url, redirectCount);
  } catch (e) {
    if (e.message && (e.message.includes('ENOTFOUND') || e.message.includes('EAI_AGAIN'))) {
      const parsedUrl = new URL(url);
      try {
        const ip = await resolveWithFallback(parsedUrl.hostname);
        return await fetchUrlDirect(url, redirectCount, ip);
      } catch (_) {
        throw e;
      }
    }
    throw e;
  }
}

function parseM3U(text) {
  const lines = text.split('\n').map(l => l.trim());
  const channels = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXTINF:')) continue;
    const info = lines[i];
    const urlLine = lines[i + 1];
    if (!urlLine || urlLine.startsWith('#')) continue;

    // Parse attributes from #EXTINF line
    const nameMatch = info.match(/,(.+)$/);
    const logoMatch = info.match(/tvg-logo="([^"]*)"/);
    const groupMatch = info.match(/group-title="([^"]*)"/);
    const idMatch = info.match(/tvg-id="([^"]*)"/);
    const tvgNameMatch = info.match(/tvg-name="([^"]*)"/);
    const countryMatch = info.match(/tvg-country="([^"]*)"/);
    const languageMatch = info.match(/tvg-language="([^"]*)"/);

    const name = (nameMatch ? nameMatch[1].trim() : 'Unknown');
    const group = groupMatch ? groupMatch[1] : '';
    const country = countryMatch ? countryMatch[1] : '';
    const language = languageMatch ? languageMatch[1] : '';

    channels.push({
      id: idMatch ? idMatch[1] : String(channels.length),
      name,
      tvgName: tvgNameMatch ? tvgNameMatch[1] : '',
      logo: logoMatch ? logoMatch[1] : '',
      group,
      country,
      language,
      url: urlLine,
      // Pre-computed lowercase search text for fast filtering
      _search: `${name} ${group} ${country} ${language}`.toLowerCase(),
    });
  }
  return channels;
}

// GET /api/iptv/channels?url=<m3u-playlist-url>[&search=X&group=X&country=X&limit=N&offset=N]
app.get('/api/iptv/channels', rateLimit, async (req, res) => {
  const playlistUrl = req.query.url;
  if (!playlistUrl) return res.status(400).json({ error: 'Missing url parameter' });

  try {
    await validateUrlNotSSRF(playlistUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid or blocked URL' });
  }

  // Fetch and cache playlist
  let channels;
  const cached = playlistCache.get(playlistUrl);
  if (cached && Date.now() - cached.fetchedAt < PLAYLIST_CACHE_TTL) {
    channels = cached.channels;
  } else {
    try {
      const body = await fetchUrl(playlistUrl);
      channels = parseM3U(body);
      if (playlistCache.size >= PLAYLIST_CACHE_MAX) {
        const oldest = playlistCache.keys().next().value;
        playlistCache.delete(oldest);
      }
      playlistCache.set(playlistUrl, { channels, fetchedAt: Date.now() });
    } catch (err) {
      console.error('[IPTV] Playlist fetch error:', err.message);
      return res.status(502).json({ error: 'Failed to fetch playlist' });
    }
  }

  // Apply optional search/filter params (no-op if none provided)
  let filtered = channels;
  const search = (req.query.search || '').trim().toLowerCase();
  const group = (req.query.group || '').trim();
  const country = (req.query.country || '').trim();

  if (search) {
    filtered = filtered.filter(ch => ch._search.includes(search));
  }
  if (group) {
    filtered = filtered.filter(ch => ch.group === group);
  }
  if (country) {
    const lc = country.toLowerCase();
    filtered = filtered.filter(ch => ch.country.toLowerCase().includes(lc));
  }

  // Pagination
  const limit = Math.min(parseInt(req.query.limit, 10) || 0, 500);
  const offset = parseInt(req.query.offset, 10) || 0;
  const total = filtered.length;
  if (limit > 0) {
    filtered = filtered.slice(offset, offset + limit);
  }

  // Build group list from full (unfiltered) channels for filter UI
  const groups = req.query.groups === '1'
    ? [...new Set(channels.map(ch => ch.group).filter(Boolean))].sort()
    : undefined;

  res.json({ channels: filtered, total, groups });
});

// GET /api/iptv/stream?url=<stream-url> — proxy HLS/stream to avoid CORS
app.get('/api/iptv/stream', rateLimit, async (req, res) => {
  const streamUrl = req.query.url;
  if (!streamUrl) return res.status(400).json({ error: 'Missing url parameter' });

  let parsedUrl;
  try {
    parsedUrl = new URL(streamUrl);
    await validateUrlNotSSRF(streamUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid or blocked URL' });
  }

  const mod = parsedUrl.protocol === 'https:' ? https : http;
  const proxyReq = mod.get(streamUrl, {
    headers: { 'User-Agent': 'Albatross/1.0' },
    timeout: 15000,
  }, (upstream) => {
    if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
      // Follow redirect through proxy (SSRF check happens on re-entry)
      const redirectCount = parseInt(req.query._rd || '0', 10);
      if (redirectCount >= MAX_REDIRECTS) {
        upstream.resume();
        return res.status(502).json({ error: 'Too many redirects' });
      }
      const rdUrl = '/api/iptv/stream?url=' + encodeURIComponent(upstream.headers.location) + '&_rd=' + (redirectCount + 1);
      res.redirect(302, rdUrl);
      upstream.resume();
      return;
    }

    const ct = upstream.headers['content-type'] || '';
    res.setHeader('Content-Type', ct || 'application/octet-stream');
    if (upstream.headers['content-length']) {
      res.setHeader('Content-Length', upstream.headers['content-length']);
    }

    // If m3u8 playlist, rewrite URLs to go through proxy
    if (streamUrl.endsWith('.m3u8') || ct.includes('mpegurl')) {
      let body = '';
      upstream.setEncoding('utf8');
      upstream.on('data', chunk => body += chunk);
      upstream.on('end', () => {
        // Resolve relative URLs against the original stream URL
        const base = streamUrl.substring(0, streamUrl.lastIndexOf('/') + 1);
        const rewritten = body.replace(/^(?!#)(\S+)$/gm, (match) => {
          const absolute = match.startsWith('http') ? match : base + match;
          return '/api/iptv/stream?url=' + encodeURIComponent(absolute);
        });
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(rewritten);
      });
    } else {
      upstream.pipe(res);
    }
  });
  proxyReq.on('error', (err) => {
    console.error('[IPTV] Stream proxy error:', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Stream unavailable' });
  });
  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).json({ error: 'Stream timeout' });
  });
});


// ─── Concurrent Streams Settings API ──────────────────────────────────
app.get('/api/settings/max-streams', (req, res) => {
  res.json({ maxConcurrentStreams: MAX_CONCURRENT_STREAMS });
});

app.post('/api/settings/max-streams', (req, res) => {
  const value = parseInt(req.body.maxConcurrentStreams, 10);
  if (!value || value < 1 || value > 20) {
    return res.status(400).json({ error: 'maxConcurrentStreams must be between 1 and 20' });
  }
  MAX_CONCURRENT_STREAMS = value;
  // Update running engines
  if (engine) engine._maxConcurrent = value;
  library._maxConcurrentDownloads = value;
  persistSettings();
  console.log(`[Settings] Max concurrent streams updated to ${value}`);
  res.json({ maxConcurrentStreams: value });
});

// Task priority: 'downloads-first' | 'conversions-first' | 'both'
app.get('/api/settings/task-priority', (req, res) => {
  res.json({
    taskPriority: library.getTaskPriority(),
    options: VALID_TASK_PRIORITIES,
  });
});

app.post('/api/settings/task-priority', (req, res) => {
  const value = String(req.body.taskPriority || '');
  if (!VALID_TASK_PRIORITIES.includes(value)) {
    return res.status(400).json({
      error: `taskPriority must be one of ${VALID_TASK_PRIORITIES.join(', ')}`,
    });
  }
  try {
    library.setTaskPriority(value);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  TASK_PRIORITY = value;
  persistSettings();
  res.json({ taskPriority: value });
});

// ─── Hardware Protection (CPU) Settings API ──────────────────────────
// Lets the operator cap host CPU pressure by pausing conversions when
// the box heats up, and manually stop all conversions mid-flight. The
// manual pause is intentionally NOT persisted — it's an instant-stop
// button, not a policy. The auto-pause thresholds ARE persisted.
app.get('/api/settings/cpu-protection', (req, res) => {
  // library.getCpuProtection() returns live monitor state (currentCpuPct,
  // overloaded) alongside the stored config, so the UI doesn't need a
  // separate poll of /api/diagnostics/system just to show the gauge.
  res.json(library.getCpuProtection());
});

app.post('/api/settings/cpu-protection', (req, res) => {
  const body = req.body || {};
  const update = {};
  if (typeof body.enabled === 'boolean') update.enabled = body.enabled;
  if (body.pauseThreshold  != null) update.pauseThreshold  = _clampPct(body.pauseThreshold,  CPU_PROTECTION.pauseThreshold);
  if (body.resumeThreshold != null) update.resumeThreshold = _clampPct(body.resumeThreshold, CPU_PROTECTION.resumeThreshold);
  if (body.sustainedMs != null)        update.sustainedMs        = _clampInt(body.sustainedMs, 0, 600000, CPU_PROTECTION.sustainedMs);
  if (body.cooldownMs != null)         update.cooldownMs         = _clampInt(body.cooldownMs,  0, 60 * 60 * 1000, CPU_PROTECTION.cooldownMs);
  if (body.niceLevel != null)          update.niceLevel          = _clampInt(body.niceLevel,   0, 19, CPU_PROTECTION.niceLevel);
  if (body.maxConversionCores != null) update.maxConversionCores = _clampInt(body.maxConversionCores, 1, 128, null);

  try {
    const applied = library.setCpuProtection(update);
    // Mirror monitor state back to the persisted config so a restart picks
    // up the operator's tuned thresholds. Manual pause is skipped on purpose.
    CPU_PROTECTION = {
      enabled:            applied.enabled,
      pauseThreshold:     applied.pauseThreshold,
      resumeThreshold:    applied.resumeThreshold,
      sustainedMs:        applied.sustainedMs,
      cooldownMs:         applied.cooldownMs,
      niceLevel:          applied.niceLevel,
      maxConversionCores: applied.maxConversionCores,
    };
    // Also apply to the music LibraryManager so a manual pause covers
    // album downloads as well (music workloads are lighter but still
    // share the same CPU budget on Jetson-class hardware).
    try { musicLibrary.setCpuProtection(update); } catch { /* music mgr may not be ready yet */ }

    // Manual-pause toggle is orthogonal to the threshold config — accept
    // it in the same POST body for UI convenience. Apply BEFORE the JSON
    // response so the snapshot reflects the final state.
    if (typeof body.manualPaused === 'boolean') {
      library.setConversionsPaused(body.manualPaused);
      try { musicLibrary.setConversionsPaused(body.manualPaused); } catch { /* ignore */ }
    }

    persistSettings();
    res.json(library.getCpuProtection());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Dedicated manual pause/resume endpoint — simpler shape for the "big red
// button" UI control. Accepts { paused: true|false } or a toggle if no
// body is provided.
app.post('/api/settings/cpu-protection/pause', (req, res) => {
  const body = req.body || {};
  let paused;
  if (typeof body.paused === 'boolean') {
    paused = body.paused;
  } else {
    // Toggle current state.
    paused = !library.getCpuProtection().manualPaused;
  }
  library.setConversionsPaused(paused);
  try { musicLibrary.setConversionsPaused(paused); } catch { /* ignore */ }
  res.json(library.getCpuProtection());
});

// ─── Cast / Local Discovery API ──────────────────────────────────────
// These endpoints let a Tailscale-connected phone discover and cast to devices
// on the Jetson's local network. The Jetson acts as the casting bridge.

// Device discovery cache (refreshed on demand, cached briefly)
let discoveryCache = { devices: [], fetchedAt: 0 };
const DISCOVERY_CACHE_TTL = 15 * 1000; // 15 seconds

// GET /api/cast/devices — discover castable devices on LAN
app.get('/api/cast/devices', rateLimit, async (req, res) => {
  const forceRefresh = req.query.refresh === '1';
  const now = Date.now();

  if (!forceRefresh && discoveryCache.devices.length > 0 &&
      now - discoveryCache.fetchedAt < DISCOVERY_CACHE_TTL) {
    return res.json({
      devices: discoveryCache.devices,
      cached: true,
      localIP: getLocalIP(),
      chromecastSupported: castManager.isCastv2Available(),
    });
  }

  try {
    console.log('[Cast API] Scanning for local devices...');
    const devices = await discoverDevices(5000);
    discoveryCache = { devices, fetchedAt: Date.now() };
    console.log(`[Cast API] Found ${devices.length} castable device(s)`);
    res.json({
      devices,
      cached: false,
      localIP: getLocalIP(),
      chromecastSupported: castManager.isCastv2Available(),
    });
  } catch (err) {
    console.error('[Cast API] Discovery error:', err.message);
    res.status(500).json({ error: 'Device discovery failed' });
  }
});

// POST /api/cast/play — start casting to a device
// Body: { device, streamUrl, title, mimeType }
//   - device: a device object from /api/cast/devices
//   - streamUrl: the path to the stream (e.g. /api/play/<hash> or /api/library/<id>/stream)
//   - title: display title
//   - mimeType: optional, defaults to video/mp4
app.post('/api/cast/play', rateLimit, async (req, res) => {
  const { device, streamPath, title, mimeType } = req.body;

  if (!device || !device.id || !device.type) {
    return res.status(400).json({ error: 'Invalid device' });
  }
  if (!streamPath) {
    return res.status(400).json({ error: 'Missing streamPath' });
  }

  // Build a LAN-reachable URL for the cast device
  // The stream path is relative to this server, so we build an absolute URL
  // using the server's LAN IP (not Tailscale IP)
  const lanIP = getLocalIP();
  const mediaUrl = `http://${lanIP}:${PORT}${streamPath}`;

  try {
    console.log(`[Cast API] Casting to ${device.friendlyName}: ${mediaUrl}`);
    await castManager.castToDevice(device, mediaUrl, title || 'Albatross', mimeType || 'video/mp4');
    res.json({ success: true, mediaUrl, device: device.friendlyName });
  } catch (err) {
    console.error(`[Cast API] Cast failed: ${err.message}`);
    res.status(500).json({ error: `Cast failed: ${err.message}` });
  }
});

// POST /api/cast/stop — stop casting on a device
app.post('/api/cast/stop', rateLimit, async (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ error: 'Missing deviceId' });

  try {
    await castManager.stopDevice(deviceId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cast/pause — toggle pause on a device
app.post('/api/cast/pause', rateLimit, async (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ error: 'Missing deviceId' });

  try {
    const status = await castManager.pauseDevice(deviceId);
    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cast/status/:deviceId — get playback status
app.get('/api/cast/status/:deviceId', async (req, res) => {
  const status = await castManager.getDeviceStatus(req.params.deviceId);
  if (!status) return res.status(404).json({ error: 'No active session' });
  res.json(status);
});

// GET /api/cast/sessions — list all active cast sessions
app.get('/api/cast/sessions', (req, res) => {
  res.json({ sessions: castManager.getAllSessions() });
});

// Serve static files. HTML/JS/CSS use `no-cache` (NOT `no-store`) so
// the browser may keep a copy but must revalidate on every load —
// express.static emits an ETag by default, so revalidation typically
// returns 304 Not Modified and skips the full transfer. Previous
// `no-store` forced a full download on every page load, including
// several hundred KB of app.js on cellular.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// Lightweight health endpoint for Docker HEALTHCHECK
app.get('/health', (req, res) => {
  res.status(200).send('ok');
});

// Health endpoint for VPN detection (if the client can reach this, the server is accessible)
app.get('/api/stats', (req, res) => {
  res.json({
    ok: true,
    conversion: library.getConversionStats(),
  });
});

// Lightweight system-status snapshot for the Downloads page indicator bar.
// Unlike /api/diagnostics/system (which samples CPU over ~1 s and walks every
// interface), this returns just what the status pills need: CPU %, GPU worker
// state, and counts of active streams / conversions.
//
// Uses a short 200 ms CPU sample so polling every few seconds doesn't starve
// the event loop but still produces a responsive number.
app.get('/api/status', async (req, res) => {
  try {
    const sys = await getSystemDiag(200);
    const conversion = library.getConversionStats();
    res.json({
      ok: true,
      cpu: {
        usagePct: sys.cpu.usagePct,
        cores: sys.cpu.cores,
        loadAvg: sys.cpu.loadAvg,
      },
      memory: {
        usedPct: sys.memory.usedPct,
      },
      gpu: library.getWorkerStatus(),
      streams: {
        active: hlsSessions.size,
      },
      conversion: {
        activeLocal: conversion.active.local,
        activeRemote: conversion.active.remote,
        pending: conversion.pending,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Albatross Mobile UI running on http://0.0.0.0:${PORT}`);
  console.log(`Stream endpoints: /api/streams/* and /api/play/*`);
});

// Graceful shutdown with timeout to ensure metadata is saved even if engines hang
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[Server] Shutting down gracefully...');

  // Force exit after 8s if cleanup hangs (Docker sends SIGKILL at 10s)
  const forceExit = setTimeout(() => {
    console.error('[Server] Shutdown timeout — forcing exit');
    process.exit(1);
  }, 8000);
  forceExit.unref();

  clearInterval(rateLimitCleanupTimer);
  clearInterval(hlsCleanupTimer);
  // Kill every active HLS ffmpeg so we don't leak child processes or hold
  // open file handles into the HLS cache that block the rm below.
  for (const id of [...hlsSessions.keys()]) {
    _stopHlsSession(id, 'server shutdown');
  }
  try { library.destroy(); } catch (err) {
    console.error(`[Server] Library shutdown error: ${err.message}`);
  }
  try { if (engine) engine.destroy(); } catch (err) {
    console.error(`[Server] Engine shutdown error: ${err.message}`);
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
