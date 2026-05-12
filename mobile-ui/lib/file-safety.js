/**
 * Albatross — Shared File Safety & Configuration
 *
 * Centralizes video file validation, MIME types, and tracker lists
 * used by both TorrentEngine and LibraryManager.
 */

const path = require('path');

// Video container extensions accepted by the streaming hot path. Includes
// the long tail (Blu-ray .m2ts/.mts, legacy .divx/.vob/.asf/.f4v, mobile
// .3gp/.3g2) so disk-discovered files in real-world libraries aren't
// silently rejected by the disk_* isFileNameSafe gate.
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.mkv', '.mov', '.webm', '.ts', '.m2ts', '.mts',
  '.avi', '.divx', '.vob', '.flv', '.f4v', '.wmv', '.asf',
  '.mpg', '.mpeg', '.mp2', '.m2v', '.3gp', '.3g2', '.ogv', '.rm', '.rmvb', '.dat',
]);

// Audio extensions used for music-library streaming. Lossless formats
// (FLAC, WAV, ALAC, APE, DSF) were missing pre-fix, which broke any
// disk-discovered FLAC library after the security gate was added.
const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.m4a', '.m4b', '.aac', '.ogg', '.oga', '.opus',
  '.flac', '.wav', '.wma', '.alac', '.ape', '.dsf', '.dff', '.aiff', '.aif',
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
  // tracker.leechers-paradise.org removed: defunct since Nov 2019; DNS no
  // longer resolves so every announce cycle pays the resolver-timeout cost
  // for nothing. Was a contributor to slow startup on cold caches.
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
  // Video
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.mts': 'video/mp2t',
  '.avi': 'video/x-msvideo',
  '.divx': 'video/x-msvideo',
  '.vob': 'video/dvd',
  '.flv': 'video/x-flv',
  '.f4v': 'video/mp4',
  '.wmv': 'video/x-ms-wmv',
  '.asf': 'video/x-ms-asf',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.mp2': 'video/mpeg',
  '.m2v': 'video/mpeg',
  '.3gp': 'video/3gpp',
  '.3g2': 'video/3gpp2',
  '.ogv': 'video/ogg',
  '.rm': 'application/vnd.rn-realmedia',
  '.rmvb': 'application/vnd.rn-realmedia-vbr',
  '.dat': 'application/octet-stream',
  // Audio
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.wma': 'audio/x-ms-wma',
  '.alac': 'audio/mp4',
  '.ape': 'audio/x-monkeys-audio',
  '.dsf': 'audio/x-dsf',
  '.dff': 'audio/x-dff',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
};

/**
 * Check if a filename is safe to serve/download.
 * Rejects path traversal, dangerous extensions, and non-media files.
 *
 * @param {string} filename
 * @param {'video'|'audio'|'any'} [kind='video'] - which media kind to allow.
 *   'video' (default, backward-compatible) allows only VIDEO_EXTENSIONS.
 *   'audio' allows only AUDIO_EXTENSIONS.
 *   'any' allows either.
 */
function isFileNameSafe(filename, kind = 'video') {
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
  if (kind === 'audio') return AUDIO_EXTENSIONS.has(finalExt);
  if (kind === 'any') return VIDEO_EXTENSIONS.has(finalExt) || AUDIO_EXTENSIONS.has(finalExt);
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
  return path.basename(filename).replace(/[^\w .\-()[\]]/g, '_').replace(/["\\]/g, '_').substring(0, 200);
}

// Size thresholds for distinguishing real media from samples/extras when
// picking files out of a multi-file torrent. Previously inlined at three
// sites in library-manager.js (addSeasonPack, addManual, repairPack) and
// two in the disk-discovery walk — now shared so a future tweak hits
// every call site at once.
const PACK_MIN_FILE_BYTES = 10 * 1024 * 1024;        // 10 MB
const MIN_PLAYABLE_VIDEO_BYTES = 50 * 1024 * 1024;   // 50 MB

// Junk-file pattern for samples, trailers, featurettes, etc. Used when
// scanning a pack to skip non-main files. Previously copied verbatim in
// four places (addSeasonPack, addManual, repairPack, _selectVideoFile).
const JUNK_FILE_REGEX = /\b(sample|trailer|extra|bonus|featurette|interview)\b/i;

module.exports = {
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  DANGEROUS_EXTENSIONS,
  TRACKERS,
  MIME_TYPES,
  PACK_MIN_FILE_BYTES,
  MIN_PLAYABLE_VIDEO_BYTES,
  JUNK_FILE_REGEX,
  isFileNameSafe,
  getMimeType,
  sanitizeFilename,
};
