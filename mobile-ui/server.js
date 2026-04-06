const express = require('express');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { getMovieStreams, getSeriesStreams } = require('./lib/stream-providers');
const TorrentEngine = require('./lib/torrent-engine');

const app = express();
const PORT = process.env.PORT || 8080;
const STREMIO_SERVER = process.env.STREMIO_SERVER || 'http://localhost:11470';
const TORRENT_CACHE_PATH = process.env.TORRENT_CACHE || path.join(__dirname, '.torrent-cache');

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
setInterval(() => {
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
    "connect-src 'self' https://v3-cinemeta.strem.io https://torrentio.strem.io https://*.strem.io",
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

// ─── Custom Mode API Routes ───────────────────────────────────────────

// GET /api/streams/movie/:imdbId
app.get('/api/streams/movie/:imdbId', rateLimit, async (req, res) => {
  const { imdbId } = req.params;
  if (!/^tt\d{7,10}$/.test(imdbId)) {
    return res.status(400).json({ error: 'Invalid IMDB ID' });
  }
  try {
    const streams = await getMovieStreams(imdbId);
    res.json({ streams });
  } catch (err) {
    console.error('[API] Movie stream error:', err.message);
    res.status(500).json({ error: 'Failed to fetch streams' });
  }
});

// GET /api/streams/series/:imdbId?season=N&episode=N
app.get('/api/streams/series/:imdbId', rateLimit, async (req, res) => {
  const { imdbId } = req.params;
  if (!/^tt\d{7,10}$/.test(imdbId)) {
    return res.status(400).json({ error: 'Invalid IMDB ID' });
  }
  const season = req.query.season ? parseInt(req.query.season, 10) : undefined;
  const episode = req.query.episode ? parseInt(req.query.episode, 10) : undefined;
  try {
    const streams = await getSeriesStreams(imdbId, season, episode);
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
process.on('SIGTERM', () => {
  if (engine) engine.destroy();
  process.exit(0);
});
