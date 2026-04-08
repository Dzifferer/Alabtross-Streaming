/**
 * Albatross — Shared File Safety & Configuration
 *
 * Centralizes video file validation, MIME types, and tracker lists
 * used by both TorrentEngine and LibraryManager.
 */

const path = require('path');

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg',
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
};

/**
 * Check if a filename is safe to serve/download.
 * Rejects path traversal, dangerous extensions, and non-video files.
 */
function isFileNameSafe(filename) {
  if (!filename) return false;
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
  return path.basename(filename).replace(/[^\w\s.\-()[\]]/g, '_').substring(0, 200);
}

module.exports = {
  VIDEO_EXTENSIONS,
  DANGEROUS_EXTENSIONS,
  TRACKERS,
  MIME_TYPES,
  isFileNameSafe,
  getMimeType,
  sanitizeFilename,
};
