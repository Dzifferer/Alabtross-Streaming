/**
 * HTTP-level smoke tests for the createApp() factory. Each test spins up a
 * fresh Express server on an ephemeral port against tmp library dirs. SSDP
 * is mocked to return [] so the cast endpoints don't open multicast sockets.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { withTmpDir } = require('./helpers/tmpdir');
const { startTestServer } = require('./helpers/http');

async function boot(t) {
  // node:test runs t.after hooks in FIFO order. The server's shutdown
  // path triggers a final _writeMetadataNow(); if the tmpdirs are
  // unlinked before the server stops, that write fails with ENOENT and
  // spams the log. Register the server-stop hook FIRST so it runs
  // before the tmpdir cleanup that withTmpDir registers below.
  let srv;
  t.after(async () => { if (srv) await srv.stop(); });
  const libraryPath = withTmpDir(t, 'alabtross-lib-');
  const musicLibraryPath = withTmpDir(t, 'alabtross-music-');
  const torrentCachePath = withTmpDir(t, 'alabtross-cache-');
  srv = await startTestServer({ libraryPath, musicLibraryPath, torrentCachePath });
  return srv;
}

test('GET /health → 200', async (t) => {
  const srv = await boot(t);
  const r = await fetch(`${srv.url}/health`);
  assert.equal(r.status, 200);
});

test('GET /api/library → 200 with { items: [], slots }', async (t) => {
  const srv = await boot(t);
  const r = await fetch(`${srv.url}/api/library`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(Array.isArray(body.items), '`items` should be an array');
  assert.equal(body.items.length, 0);
  // The response shape includes `slots` (download-slot accounting).
  assert.ok(body.slots !== undefined, '`slots` should be present on the response');
});

test('GET /api/library second call with If-None-Match echoing the ETag → 304', async (t) => {
  const srv = await boot(t);
  const r1 = await fetch(`${srv.url}/api/library`);
  assert.equal(r1.status, 200);
  const etag = r1.headers.get('etag');
  assert.ok(etag, 'first response must include an ETag header');
  const r2 = await fetch(`${srv.url}/api/library`, {
    headers: { 'If-None-Match': etag },
  });
  assert.equal(r2.status, 304);
  // 304 responses have no body — fetch() will return an empty string here.
  const body = await r2.text();
  assert.equal(body, '');
});

test('GET /api/library — ETag stays stable across idle polls', async (t) => {
  // The browser poll captures a new ETag from every 200 response and sends
  // it on the next If-None-Match. An idle library must keep returning 304
  // for the same ETag indefinitely — that's the bandwidth-saving guarantee.
  const srv = await boot(t);
  const r1 = await fetch(`${srv.url}/api/library`);
  const etag = r1.headers.get('etag');
  assert.ok(etag);
  // Three consecutive conditional GETs against an idle server.
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${srv.url}/api/library`, { headers: { 'If-None-Match': etag } });
    assert.equal(r.status, 304, `cycle ${i}: idle library should 304`);
    const body = await r.text();
    assert.equal(body, '', `cycle ${i}: 304 should have empty body`);
  }
});

test('GET /api/nonexistent → 404 JSON (not HTML)', async (t) => {
  const srv = await boot(t);
  const r = await fetch(`${srv.url}/api/this-does-not-exist`);
  assert.equal(r.status, 404);
  const ct = r.headers.get('content-type') || '';
  assert.ok(ct.includes('application/json'), `expected JSON 404, got Content-Type: ${ct}`);
  const body = await r.json();
  assert.ok(body.error, '404 body should have error field');
});

test('GET /api/cast/devices → 200 with empty devices array (SSDP mocked)', async (t) => {
  const srv = await boot(t);
  const r = await fetch(`${srv.url}/api/cast/devices`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(Array.isArray(body.devices));
  assert.equal(body.devices.length, 0, 'mocked SSDP must yield empty devices');
});

test('POST /api/library/categorize with missing imdbId → 400', async (t) => {
  const srv = await boot(t);
  const r = await fetch(`${srv.url}/api/library/categorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': srv.url },
    body: JSON.stringify({ category: 'manual' }), // no imdbId
  });
  assert.equal(r.status, 400);
});

test('POST /api/library/categorize with valid input → 200', async (t) => {
  const srv = await boot(t);
  // Route requires `imdbId` matching tt\d{1,10} AND either `genre` OR
  // (collectionId+collectionName) — provide genre.
  const r = await fetch(`${srv.url}/api/library/categorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': srv.url },
    body: JSON.stringify({ imdbId: 'tt1234567', genre: 'Action' }),
  });
  assert.equal(r.status, 200);
});
