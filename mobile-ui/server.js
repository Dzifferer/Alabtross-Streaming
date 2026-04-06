const express = require('express');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 8080;
const STREMIO_SERVER = process.env.STREMIO_SERVER || 'http://localhost:11470';

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

// Proxy API requests to the Stremio server — restrict to known paths
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

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Alabtross Mobile UI running on http://0.0.0.0:${PORT}`);
  console.log(`Proxying Stremio API from ${STREMIO_SERVER}`);
});
