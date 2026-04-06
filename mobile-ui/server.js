const express = require('express');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { getMovieStreams, getSeriesStreams } = require('./lib/stream-providers');
const TorrentEngine = require('./lib/torrent-engine');

const app = express();
const PORT = process.env.PORT || 8080;
const STREMIO_SERVER = process.env.STREMIO_SERVER || 'http://localhost:11470';
const TORRENT_CACHE_PATH = process.env.TORRENT_CACHE || path.join(__dirname, '.torrent-cache');

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
app.get('/api/streams/movie/:imdbId', async (req, res) => {
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
app.get('/api/streams/series/:imdbId', async (req, res) => {
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
app.get('/api/play/:infoHash', (req, res) => {
  const { infoHash } = req.params;
  if (!/^[0-9a-f]{40}$/i.test(infoHash)) {
    return res.status(400).json({ error: 'Invalid infoHash' });
  }
  const fileIdx = req.query.fileIdx !== undefined
    ? parseInt(req.query.fileIdx, 10)
    : undefined;
  const magnet = req.query.magnet || infoHash;

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
