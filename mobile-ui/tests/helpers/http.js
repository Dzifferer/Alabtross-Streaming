/**
 * Test helper: spin up an Express server via createApp() bound to an
 * ephemeral port (port 0). SSDP discovery is stubbed to return [] so the
 * tests don't open multicast sockets or wait 5 seconds. Returns the base
 * URL and a stop() that closes the listener and tears down the libraries.
 *
 * Usage:
 *   const { startTestServer } = require('./helpers/http');
 *   const srv = await startTestServer({ libraryPath, musicLibraryPath });
 *   const r = await fetch(`${srv.url}/health`);
 *   await srv.stop();
 */
const { createApp } = require('../../server');

async function startTestServer(opts = {}) {
  const created = createApp({
    ...opts,
    // Force the port option to 0 so the OS picks any free port.
    port: 0,
    // Stub SSDP/mDNS so we don't open multicast sockets in tests.
    discoverDevices: opts.discoverDevices || (async () => []),
    // Keep process.exit() out of shutdown — tests need to continue.
    skipExit: true,
  });
  const { app, library, musicLibrary, shutdown } = created;
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', (err) => {
      if (err) reject(err);
      else resolve(s);
    });
    s.on('error', reject);
  });
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  async function stop() {
    await new Promise((resolve) => server.close(() => resolve()));
    try { await shutdown(); } catch { /* ignore */ }
  }
  return { url, server, library, musicLibrary, stop };
}

module.exports = { startTestServer };
