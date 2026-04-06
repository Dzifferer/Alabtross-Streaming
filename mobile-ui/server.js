const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const dns = require('dns');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { getMovieStreams, getSeriesStreams } = require('./lib/stream-providers');
const TorrentEngine = require('./lib/torrent-engine');
const LibraryManager = require('./lib/library-manager');

const app = express();
const PORT = process.env.PORT || 8080;
const STREMIO_SERVER = process.env.STREMIO_SERVER || 'http://localhost:11470';
const TORRENT_CACHE_PATH = process.env.TORRENT_CACHE || path.join(__dirname, '.torrent-cache');
const LIBRARY_PATH = process.env.LIBRARY_PATH || path.join(__dirname, 'library');

// JSON body parsing for library POST/DELETE requests
app.use(express.json({ limit: '10kb' }));

// ─── Rate Limiting (simple in-memory, per-IP) ────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 30;           // max requests per window

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

// ─── Torrent Engine (lazy-initialized on first custom-mode request) ───
let engine = null;
function getEngine() {
  if (!engine) {
    engine = new TorrentEngine({ downloadPath: TORRENT_CACHE_PATH });
    console.log(`[TorrentEngine] Initialized, cache path: ${TORRENT_CACHE_PATH}`);
  }
  return engine;
}

// ─── Library Manager (initialized on startup) ─────────────────────────
const library = new LibraryManager({ libraryPath: LIBRARY_PATH });

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https: data:",
    "connect-src 'self' https://v3-cinemeta.strem.io https://torrentio.strem.io https://*.strem.io https://*.stremio.com https://api.themoviedb.org",
    "media-src 'self' blob: http: https:",
    "frame-ancestors 'none'",
  ].join('; '));
  next();
});

// ─── Stremio Proxy (for Stremio mode) ─────────────────────────────────
const ALLOWED_PROXY_PREFIXES = ['/stats.json', '/hlsv2/'];
app.use('/stremio-api', (req, res, next) => {
  const proxyPath = req.path || '/';
  if (!ALLOWED_PROXY_PREFIXES.some(p => proxyPath.startsWith(p))) {
    return res.status(403).json({ error: 'Path not allowed through proxy' });
  }
  next();
}, createProxyMiddleware({
  target: STREMIO_SERVER,
  changeOrigin: true,
  pathRewrite: { '^/stremio-api': '' },
}));

// ─── TMDB Search API ─────────────────────────────────────────────────

const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const TMDB_BASE = 'https://api.themoviedb.org/3';

function tmdbFetch(endpoint, params = {}) {
  if (!TMDB_API_KEY) return Promise.reject(new Error('No TMDB API key'));
  const qs = new URLSearchParams({ api_key: TMDB_API_KEY, ...params });
  const url = `${TMDB_BASE}${endpoint}?${qs}`;
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 8000 }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`TMDB HTTP ${res.statusCode}`));
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('Timeout')); });
  });
}

// GET /api/search?q=query&type=movie|series
app.get('/api/search', rateLimit, async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query || query.length > 200) return res.json({ results: [] });

  const type = req.query.type; // 'movie', 'series', or undefined for both
  const results = [];

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

    // Sort by popularity descending
    results.sort((a, b) => b.popularity - a.popularity);

    // Fetch IMDB IDs for top results (parallel, limited to top 20)
    const topResults = results.slice(0, 20);
    const imdbLookups = topResults.map(async (item) => {
      try {
        const tmdbType = item.type === 'series' ? 'tv' : 'movie';
        const ext = await tmdbFetch(`/${tmdbType}/${item.tmdb_id}/external_ids`);
        item.imdb_id = ext.imdb_id || null;
        item.id = ext.imdb_id || `tmdb:${item.tmdb_id}`;
      } catch {
        item.id = `tmdb:${item.tmdb_id}`;
      }
    });
    await Promise.all(imdbLookups);

    // Filter out results without IMDB IDs (can't stream without them)
    const withImdb = topResults.filter(r => r.imdb_id);

    res.json({ results: withImdb });
  } catch (err) {
    console.error('[TMDB] Search error:', err.message);
    res.json({ results: [], error: 'Search failed' });
  }
});

// ─── Custom Mode API Routes ───────────────────────────────────────────

// GET /api/streams/movie/:imdbId
app.get('/api/streams/movie/:imdbId', rateLimit, async (req, res) => {
  const { imdbId } = req.params;
  if (!/^tt\d{1,10}$/.test(imdbId)) {
    return res.status(400).json({ error: 'Invalid IMDB ID' });
  }
  const title = req.query.title || '';
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
  const { imdbId } = req.params;
  if (!/^tt\d{1,10}$/.test(imdbId)) {
    return res.status(400).json({ error: 'Invalid IMDB ID' });
  }
  const season = req.query.season ? parseInt(req.query.season, 10) : undefined;
  const episode = req.query.episode ? parseInt(req.query.episode, 10) : undefined;
  const title = req.query.title || '';
  try {
    const streams = await getSeriesStreams(imdbId, season, episode, title);
    res.json({ streams });
  } catch (err) {
    console.error('[API] Series stream error:', err.message);
    res.status(500).json({ error: 'Failed to fetch streams' });
  }
});

// GET /api/play/:infoHash — stream video from torrent
// Optional query: ?fileIdx=N&magnet=<uri>
app.get('/api/play/:infoHash', rateLimit, (req, res) => {
  const { infoHash } = req.params;
  if (!/^[0-9a-f]{40}$/i.test(infoHash)) {
    return res.status(400).json({ error: 'Invalid infoHash' });
  }
  const fileIdx = req.query.fileIdx !== undefined
    ? parseInt(req.query.fileIdx, 10)
    : undefined;

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

  getEngine().serveStream(req, res, magnet, fileIdx);
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
app.get('/api/torrent-status/:infoHash', (req, res) => {
  const { infoHash } = req.params;
  if (!/^[0-9a-f]{40}$/i.test(infoHash)) {
    return res.status(400).json({ error: 'Invalid infoHash' });
  }
  const eng = getEngine();
  const status = eng.getStatus(infoHash);
  if (!status) {
    return res.status(404).json({ error: 'Torrent not active' });
  }
  res.json(status);
});

// ─── Library API Routes ───────────────────────────────────────────────

// GET /api/library — list all library items
app.get('/api/library', rateLimit, (req, res) => {
  res.json({ items: library.getAll() });
});

// GET /api/library/:id — get single library item
app.get('/api/library/:id', rateLimit, (req, res) => {
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

// DELETE /api/library/:id — remove item from library
app.delete('/api/library/:id', rateLimit, (req, res) => {
  const removed = library.removeItem(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Item not found' });
  res.json({ success: true });
});

// GET /api/library/:id/stream — stream a completed library item
app.get('/api/library/:id/stream', rateLimit, async (req, res) => {
  const item = library.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.status !== 'complete') {
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
  const safeFilename = path.basename(filePath).replace(/[^\w\s.\-()[\]]/g, '_').substring(0, 200);

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

    if (start >= fileSize || end >= fileSize || start > end) {
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

// GET /api/library/:id/stream/remux — stream a library MKV remuxed to MP4
app.get('/api/library/:id/stream/remux', rateLimit, async (req, res) => {
  const item = library.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.status !== 'complete') {
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

  const safeFilename = path.basename(filePath).replace(/[^\w\s.\-()[\]]/g, '_').replace(/\.mkv$/i, '.mp4').substring(0, 200);
  const { spawn } = require('child_process');

  res.status(200);
  res.set({
    'Content-Type': 'video/mp4',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename="${safeFilename}"`,
    'Cache-Control': 'no-store',
    'Transfer-Encoding': 'chunked',
  });

  const ffmpeg = spawn('ffmpeg', [
    '-i', filePath,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', 'frag_keyframe+empty_moov+faststart',
    '-f', 'mp4',
    '-loglevel', 'warning',
    'pipe:1',
  ]);

  ffmpeg.stdout.pipe(res);

  ffmpeg.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.log(`[FFmpeg/Library] ${msg}`);
  });

  ffmpeg.on('error', (err) => {
    console.error(`[Library] FFmpeg spawn error: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Remux failed — FFmpeg not available' });
    }
  });

  ffmpeg.on('close', (code) => {
    if (code && code !== 0 && code !== 255) {
      console.warn(`[Library] FFmpeg exited with code ${code}`);
    }
    res.end();
  });

  res.on('close', () => {
    ffmpeg.kill('SIGTERM');
  });
});

// ─── IPTV / Live TV Endpoints ─────────────────────────────────────────

// In-memory playlist cache: { url, channels, fetchedAt }
let playlistCache = null;
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

function fetchUrl(url, redirectCount = 0) {
  if (redirectCount > MAX_REDIRECTS) {
    return Promise.reject(new Error('Too many redirects'));
  }
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Alabtross/1.0' }, timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, redirectCount + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
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

    channels.push({
      id: idMatch ? idMatch[1] : String(channels.length),
      name: nameMatch ? nameMatch[1].trim() : 'Unknown',
      logo: logoMatch ? logoMatch[1] : '',
      group: groupMatch ? groupMatch[1] : '',
      url: urlLine,
    });
  }
  return channels;
}

// GET /api/iptv/channels?url=<m3u-playlist-url>
app.get('/api/iptv/channels', rateLimit, async (req, res) => {
  const playlistUrl = req.query.url;
  if (!playlistUrl) return res.status(400).json({ error: 'Missing url parameter' });

  try {
    await validateUrlNotSSRF(playlistUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid or blocked URL' });
  }

  // Return cached if same URL and fresh
  if (playlistCache && playlistCache.url === playlistUrl &&
      Date.now() - playlistCache.fetchedAt < PLAYLIST_CACHE_TTL) {
    return res.json({ channels: playlistCache.channels });
  }

  try {
    const body = await fetchUrl(playlistUrl);
    const channels = parseM3U(body);
    playlistCache = { url: playlistUrl, channels, fetchedAt: Date.now() };
    res.json({ channels });
  } catch (err) {
    console.error('[IPTV] Playlist fetch error:', err.message);
    res.status(502).json({ error: 'Failed to fetch playlist' });
  }
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
    headers: { 'User-Agent': 'Alabtross/1.0' },
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

// ─── WireGuard VPN Profile API ─────────────────────────────────────
const WG_CONFIGS_DIR = process.env.WG_CONFIGS_DIR || '/etc/wireguard/configs';

app.get('/api/vpn/profiles', (req, res) => {
  try {
    if (!fs.existsSync(WG_CONFIGS_DIR)) {
      return res.json({ profiles: [], error: 'WireGuard config directory not found' });
    }
    const files = fs.readdirSync(WG_CONFIGS_DIR)
      .filter(f => f.endsWith('.conf'))
      .map(f => f.replace(/\.conf$/, ''));
    res.json({ profiles: files });
  } catch (e) {
    res.json({ profiles: [], error: 'Cannot read VPN profiles' });
  }
});

app.get('/api/vpn/profile/:name', (req, res) => {
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  const confPath = path.join(WG_CONFIGS_DIR, `${name}.conf`);
  try {
    if (!fs.existsSync(confPath)) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    const config = fs.readFileSync(confPath, 'utf-8');
    res.json({ name, config });
  } catch (e) {
    res.status(500).json({ error: 'Cannot read profile' });
  }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Alabtross Mobile UI running on http://0.0.0.0:${PORT}`);
  console.log(`Stremio proxy target: ${STREMIO_SERVER}`);
  console.log(`Custom mode available at /api/streams/* and /api/play/*`);
});

// Graceful shutdown
function shutdown() {
  clearInterval(rateLimitCleanupTimer);
  if (engine) engine.destroy();
  library.destroy();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
