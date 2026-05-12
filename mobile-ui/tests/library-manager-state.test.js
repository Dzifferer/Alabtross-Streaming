/**
 * Tests for pure state-shaping methods on LibraryManager that don't depend
 * on disk recovery, torrent engines, or any timers. Instances are built
 * with { noAutoInit: true } so the constructor skips _loadMetadata,
 * _loadPackCatalog, PeerReputation, the cpu-monitor interval, and
 * _initAsync — leaving us with a deterministic in-memory shell.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const LibraryManager = require('../lib/library-manager');
const { withTmpDir } = require('./helpers/tmpdir');

function makeLib(t) {
  const dir = withTmpDir(t);
  const lib = new LibraryManager({ libraryPath: dir, noAutoInit: true });
  // Stub _startDownload so addItem() doesn't try to construct a real
  // torrent-stream engine — we only care about the bookkeeping side.
  lib._startDownload = () => {};
  // Make _saveMetadata a no-op so tests don't leak a setTimeout into the
  // event loop; flushing it would race with t.after cleanup.
  lib._saveMetadata = () => { lib._getAllCache = null; };
  return { lib, dir };
}

test('getReviewQueue — filters by matchState', (t) => {
  const { lib } = makeLib(t);
  lib._items.set('a', { id: 'a', name: 'matched item',   imdbId: 'tt0001', status: 'complete' });
  lib._items.set('b', { id: 'b', name: 'unmatched item', imdbId: null,    status: 'complete' });
  lib._items.set('c', { id: 'c', name: 'needsReview',    imdbId: 'tt0003', matchState: 'needsReview', status: 'complete' });
  lib._items.set('d', { id: 'd', name: 'manual',         imdbId: 'tt0004', matchState: 'manual',      status: 'complete' });
  const queue = lib.getReviewQueue();
  const ids = queue.map(i => i.id).sort();
  // Only b (unmatched) and c (needsReview) should be in the queue.
  assert.deepEqual(ids, ['b', 'c']);
});

test('_computeMatchState — item with tt-prefixed imdbId is matched', (t) => {
  const { lib } = makeLib(t);
  assert.equal(lib._computeMatchState({ imdbId: 'tt1234567' }), 'matched');
});

test('_computeMatchState — item with no imdbId / tmdbId / posterUrl is unmatched', (t) => {
  const { lib } = makeLib(t);
  assert.equal(lib._computeMatchState({}), 'unmatched');
  assert.equal(lib._computeMatchState({ imdbId: null }), 'unmatched');
  // tmdbId / posterUrl alone do NOT promote to matched — imdbId is the
  // sole match indicator in _computeMatchState today.
  assert.equal(lib._computeMatchState({ tmdbId: 123, posterUrl: 'x.jpg' }), 'unmatched');
});

test('_computeMatchState — explicit needsReview / manual flags win', (t) => {
  const { lib } = makeLib(t);
  assert.equal(lib._computeMatchState({ matchState: 'needsReview', imdbId: 'tt0001' }), 'needsReview');
  assert.equal(lib._computeMatchState({ matchState: 'manual',      imdbId: null     }), 'manual');
});

test('_sanitizeItem — strips private _* fields, no absolute path leak', (t) => {
  const { lib } = makeLib(t);
  const item = {
    id: 'x', imdbId: 'tt0001', type: 'movie', name: 'Test',
    poster: 'p.jpg', year: '2020', status: 'complete', progress: 100,
    // Private fields that must not be returned:
    _internal: 'secret', _seederIps: ['1.2.3.4'], _scratchPath: '/secret/path',
    filePath: '/abs/library/Movie/file.mkv',
    fileName: 'file.mkv',
  };
  const sanitized = lib._sanitizeItem(item);
  // Whitelist-style sanitize: no underscore-prefixed keys allowed.
  for (const key of Object.keys(sanitized)) {
    assert.ok(!key.startsWith('_'), `should not leak private key ${key}`);
  }
  // filePath is intentionally NOT in the sanitized projection — that would
  // expose the absolute on-disk layout to the client.
  assert.equal(sanitized.filePath, undefined);
  assert.equal(sanitized.name, 'Test');
  assert.equal(sanitized.fileName, 'file.mkv');
});

test('_sanitizeItem — music album carries tracks + mbid', (t) => {
  const { lib } = makeLib(t);
  const album = {
    id: 'm1', type: 'album', name: 'Album A', status: 'complete',
    mbid: 'abc-123', artistMbid: 'def-456', artist: 'Artist',
    title: 'Album A', coverUrl: 'http://example.com/cover.jpg',
    tracks: [{ title: 'T1', trackNumber: 1 }, { title: 'T2', trackNumber: 2 }],
    genres: ['rock'], playCount: 3, favorite: true,
  };
  const out = lib._sanitizeItem(album);
  assert.equal(out.mbid, 'abc-123');
  assert.equal(out.artistMbid, 'def-456');
  assert.equal(out.artist, 'Artist');
  assert.deepEqual(out.tracks, album.tracks);
  assert.deepEqual(out.genres, ['rock']);
  assert.equal(out.playCount, 3);
  assert.equal(out.favorite, true);
});

test('_sanitizeItem — non-music item does not gain tracks field', (t) => {
  const { lib } = makeLib(t);
  const movie = { id: 'm', type: 'movie', name: 'M', status: 'complete' };
  const out = lib._sanitizeItem(movie);
  assert.equal(out.tracks, undefined);
  assert.equal(out.mbid, undefined);
});

test('_safeDirectoryName — strips path separators, control chars', (t) => {
  const { lib } = makeLib(t);
  const sep = lib._safeDirectoryName({ name: 'foo/bar:baz\\qux', infoHash: 'abcd1234567890' });
  // '/' ':' '\' all replaced with underscores.
  assert.ok(!sep.includes('/'));
  assert.ok(!sep.includes(':'));
  assert.ok(!sep.includes('\\'));
});

test('_safeDirectoryName — truncates over-long names', (t) => {
  const { lib } = makeLib(t);
  const long = 'A'.repeat(500);
  const out = lib._safeDirectoryName({ name: long, infoHash: 'deadbeef00112233' });
  // Internal cap is 100 chars on the base + an 8-char hash suffix + the
  // joining underscore — must be at most ~110 chars no matter the input.
  assert.ok(out.length <= 120, `safe-dir-name length should be bounded; got ${out.length}`);
});

test('_isPathSafe — rejects .. escape', (t) => {
  const { lib, dir } = makeLib(t);
  // Path that resolves outside the library root should be rejected.
  assert.equal(lib._isPathSafe(path.join(dir, '..', 'escape.mp4')), false);
  assert.equal(lib._isPathSafe(path.join(dir, 'subdir', '..', '..', 'escape.mp4')), false);
});

test('_isPathSafe — rejects absolute path outside library', (t) => {
  const { lib } = makeLib(t);
  assert.equal(lib._isPathSafe('/etc/passwd'), false);
  assert.equal(lib._isPathSafe('/tmp/some-other.mkv'), false);
});

test('_isPathSafe — rejects NUL byte', (t) => {
  const { lib, dir } = makeLib(t);
  assert.equal(lib._isPathSafe(path.join(dir, 'bad\0name.mp4')), false);
});

test('_isPathSafe — accepts in-tree path', (t) => {
  const { lib, dir } = makeLib(t);
  assert.equal(lib._isPathSafe(path.join(dir, 'inside.mp4')), true);
  assert.equal(lib._isPathSafe(path.join(dir, 'sub', 'nested.mp4')), true);
});

test('addItem → getReviewQueue → removeItem round-trip leaves _items empty', (t) => {
  const { lib, dir } = makeLib(t);
  fs.mkdirSync(dir, { recursive: true });
  // Use a fresh infoHash; no imdbId so the item lands in the review queue.
  const r = lib.addItem({
    type: 'movie',
    name: 'Test Movie',
    infoHash: 'aa'.repeat(20), // 40-char hex
    magnetUri: 'magnet:?xt=urn:btih:' + 'aa'.repeat(20),
  });
  assert.ok(r.id);
  assert.equal(lib._items.size, 1);
  // No imdbId → review queue should include it.
  const reviewIds = lib.getReviewQueue().map(i => i.id);
  assert.ok(reviewIds.includes(r.id));
  // removeItem returns true on success.
  const removed = lib.removeItem(r.id);
  assert.equal(removed, true);
  assert.equal(lib._items.size, 0);
});

test('packCatalog dedup on infoHash', (t) => {
  const { lib } = makeLib(t);
  // Stub the catalog save to avoid the async fs.writeFile + fsync on the
  // libuv threadpool, which would otherwise outlive the test.
  lib._savePackCatalog = () => {};
  lib._registerPackInCatalog({
    imdbId: 'tt0001', title: 'Pack A', magnetUri: 'magnet:?xt=urn:btih:AAA',
    infoHash: 'AAA', rootDir: 'rA',
  });
  lib._registerPackInCatalog({
    imdbId: 'tt0001', title: 'Pack A (replayed)', magnetUri: 'magnet:?xt=urn:btih:AAA',
    infoHash: 'AAA', rootDir: 'rA',
  });
  // Same infoHash twice → single entry (keyed by lowercase infoHash).
  assert.equal(lib._packCatalog.size, 1);
  // The most recent registration replaces the older one's `title` field.
  const entry = lib._packCatalog.get('aaa');
  assert.equal(entry.title, 'Pack A (replayed)');
});
