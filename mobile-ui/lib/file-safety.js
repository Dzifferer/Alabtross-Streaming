/**
 * Albatross — Shared File Safety & Configuration
 *
 * Centralizes video file validation, MIME types, and tracker lists
 * used by both TorrentEngine and LibraryManager.
 */

const path = require('path');

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.ts',
]);

const DANGEROUS_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.scr', '.pif', '.msi', '.msp',
  '.ps1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.sh',
  '.bash', '.csh', '.app', '.action', '.command', '.run', '.bin',
  '.dll', '.so', '.dylib', '.deb', '.rpm', '.apk', '.dmg', '.iso',
  '.jar', '.py', '.rb', '.pl', '.php', '.html', '.htm', '.svg',
]);

const TRACKERS = [
  // High-reliability public trackers
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://explodie.org:6969/announce',
  // Additional active trackers for better peer discovery
  'udp://opentracker.i2p.rocks:6969/announce',
  'udp://tracker.internetwarriors.net:1337/announce',
  'udp://tracker.leechers-paradise.org:6969/announce',
  'udp://tracker.cyberia.is:6969/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.altrosky.nl:6969/announce',
  'udp://tracker.theoks.net:6969/announce',
  'udp://tracker.monitorit4.me:6969/announce',
  'udp://tracker.0x7c0.com:6969/announce',
  'udp://retracker01-msk-virt.corbina.net:80/announce',
  'udp://uploads.gamecoast.net:6969/announce',
  'udp://tracker1.bt.moack.co.kr:80/announce',
  'udp://tracker.dump.cl:6969/announce',
  'https://tracker.tamersunion.org:443/announce',
  'https://tracker.gbitt.info:443/announce',
  'http://tracker.files.fm:6969/announce',
  // WebSocket trackers for WebRTC peer discovery
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
];

const MIME_TYPES = {
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
  '.ts': 'video/mp2t',
};

/**
 * Check if a filename is safe to serve/download.
 * Rejects path traversal, dangerous extensions, and non-video files.
 */
function isFileNameSafe(filename) {
  if (!filename) return false;
  if (filename.includes('\0')) return false;
  const normalized = path.normalize(filename);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return false;
  if (filename.includes('..')) return false;
  const parts = path.basename(filename).split('.');
  for (let i = 1; i < parts.length; i++) {
    const ext = '.' + parts[i].toLowerCase();
    if (DANGEROUS_EXTENSIONS.has(ext)) return false;
  }
  const finalExt = path.extname(filename).toLowerCase();
  return VIDEO_EXTENSIONS.has(finalExt);
}

/**
 * Get MIME type for a video file, with safe fallback.
 */
function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * Sanitize a filename for use in Content-Disposition headers.
 */
function sanitizeFilename(filename) {
  return path.basename(filename).replace(/[^\w\s.\-()[\]]/g, '_').replace(/["\\]/g, '_').substring(0, 200);
}

// ─── Metadata-fetch timeout ─────────────────────────
//
// How long to wait for a torrent engine to emit 'ready' (i.e. finish
// fetching the infoDict via ut_metadata) before giving up.
//
// The old flat 90s limit was the single biggest cause of download failures
// in practice. On a cold container start, DHT bootstrap + tracker announce
// + peer handshake + ut_metadata exchange legitimately take well over 90s
// for anything but the most heavily-seeded torrents. Resumes are hit
// particularly hard because there is no warm DHT routing table to reuse,
// so every pack that failed to reach metadata within 90s on resume got
// permanently stuck in 'failed' — even though the files were usually
// already complete on disk.
//
// The fix has two parts:
//   1. Raise the baseline from 90s → 180s. This alone covers the majority
//      of real-world cold-start metadata fetches observed in the field.
//   2. Adaptive extension. If the baseline expires AND the engine has
//      connected peers, grant one 90s extension. Connected peers almost
//      always means we're actively receiving the metadata piece stream
//      but just haven't finished reassembling it yet — killing the engine
//      in that window throws away real progress and guarantees another
//      cold start on the next retry.
//
// Worst-case wait is METADATA_TIMEOUT_MS + METADATA_EXTENSION_MS = 270s.
// Torrents that truly have no peers fall through the extension check
// immediately, so dead torrents still fail at the baseline (no regression).
const METADATA_TIMEOUT_MS = 180 * 1000;
const METADATA_EXTENSION_MS = 90 * 1000;

/**
 * Schedule an adaptive metadata-fetch timeout on a torrent-stream engine.
 *
 * Returns an object with a `clear()` method that MUST be called from the
 * engine's 'ready' and 'error' handlers to cancel the pending timer(s).
 *
 * When the baseline fires we look at engine.swarm.wires: if any peers are
 * connected, log and extend once by METADATA_EXTENSION_MS before giving up.
 * If no peers are connected, fail immediately — there is nothing to wait
 * for and extending would just defer the inevitable user-visible error.
 *
 * onTimeout is invoked at most once, either at the baseline (dead torrent)
 * or after the extension (connected peers that still couldn't deliver the
 * infoDict). It is the caller's responsibility to destroy the engine and
 * mark the item failed — this helper only owns the timer.
 *
 * The label parameter is used purely for log output so operators can tell
 * which download is extending its metadata window.
 */
function scheduleMetadataTimeout(engine, label, onTimeout) {
  let handle = null;
  let extended = false;
  let cancelled = false;

  const fire = () => {
    if (cancelled) return;
    const peers = (engine && engine.swarm && engine.swarm.wires)
      ? engine.swarm.wires.length
      : 0;
    if (peers > 0 && !extended) {
      extended = true;
      console.warn(
        `[MetadataTimeout] ${label}: baseline ${METADATA_TIMEOUT_MS / 1000}s ` +
        `elapsed with ${peers} peer(s) connected — extending ` +
        `${METADATA_EXTENSION_MS / 1000}s for metadata exchange to complete`
      );
      handle = setTimeout(fire, METADATA_EXTENSION_MS);
      return;
    }
    handle = null;
    onTimeout();
  };

  handle = setTimeout(fire, METADATA_TIMEOUT_MS);

  return {
    clear() {
      cancelled = true;
      if (handle) {
        clearTimeout(handle);
        handle = null;
      }
    },
  };
}

module.exports = {
  VIDEO_EXTENSIONS,
  DANGEROUS_EXTENSIONS,
  TRACKERS,
  MIME_TYPES,
  METADATA_TIMEOUT_MS,
  METADATA_EXTENSION_MS,
  isFileNameSafe,
  getMimeType,
  sanitizeFilename,
  scheduleMetadataTimeout,
};
