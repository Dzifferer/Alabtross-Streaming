const express = require('express');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 8080;
const STREMIO_SERVER = process.env.STREMIO_SERVER || 'http://localhost:11470';

// Proxy API requests to the Stremio server to avoid CORS issues
app.use('/stremio-api', createProxyMiddleware({
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
