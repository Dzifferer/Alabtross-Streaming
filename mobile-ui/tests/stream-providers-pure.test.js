/**
 * Tests for the pure helpers in lib/stream-providers.js.
 *
 * These cover the playback-correctness funnel: format detection, the
 * remux-vs-direct decision, IMDb id sanitization, magnet-link construction,
 * and the season-pack heuristics. All functions are side-effect-free and
 * exported (no module-level state mutated by these tests).
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  sanitizeImdbId,
  buildMagnet,
  detectFormat,
  needsRemux,
  isSeasonPack,
  parsePackSizeBytes,
  isCompletePack,
} = require('../lib/stream-providers');

test('sanitizeImdbId — accepts canonical tt-prefixed ids', () => {
  assert.strictEqual(sanitizeImdbId('tt0133093'), 'tt0133093');
  assert.strictEqual(sanitizeImdbId('tt1'), 'tt1');
  assert.strictEqual(sanitizeImdbId('tt1234567890'), 'tt1234567890');
});

test('sanitizeImdbId — rejects malformed ids', () => {
  assert.strictEqual(sanitizeImdbId('abc'), null);
  assert.strictEqual(sanitizeImdbId('tt'), null);
  assert.strictEqual(sanitizeImdbId('tt12345678901'), null); // 11 digits — over limit
  assert.strictEqual(sanitizeImdbId('tt<script>'), null);
  assert.strictEqual(sanitizeImdbId('123456'), null);
  assert.strictEqual(sanitizeImdbId('tt0a133093'), null);
});

test('buildMagnet — produces a magnet URI with xt and announce trackers', () => {
  const magnet = buildMagnet('1234567890ABCDEF1234567890ABCDEF12345678', 'My Movie');
  assert.ok(magnet.startsWith('magnet:?'), 'should start with magnet:?');
  assert.ok(magnet.includes('xt=urn:btih:1234567890ABCDEF1234567890ABCDEF12345678'),
    'should include the bare info-hash');
  assert.ok(magnet.includes('dn=My%20Movie') || magnet.includes('dn=My+Movie'),
    'should URL-encode the display name');
  assert.ok(/tr=[^&]+/.test(magnet), 'should carry at least one tracker');
});

test('detectFormat — MKV signals', () => {
  assert.strictEqual(detectFormat('Movie.2024.1080p.BluRay.x265.HEVC.mkv'), 'MKV');
  assert.strictEqual(detectFormat('Movie.x265.10bit'), 'MKV');
  assert.strictEqual(detectFormat('Movie.H.265.something'), 'MKV');
});

test('detectFormat — MP4 signals', () => {
  assert.strictEqual(detectFormat('Movie.WEB-DL.x264.mp4'), 'MP4');
  assert.strictEqual(detectFormat('Movie.WEBRip.x264'), 'MP4');
});

test('detectFormat — AVI / WMV', () => {
  assert.strictEqual(detectFormat('Movie.XviD.avi'), 'AVI');
  assert.strictEqual(detectFormat('Movie.something.wmv'), 'WMV');
});

test('detectFormat — Unknown fallback', () => {
  assert.strictEqual(detectFormat('Movie.2024'), 'Unknown');
});

test('needsRemux — x265/HEVC', () => {
  assert.strictEqual(needsRemux('Movie.x265.1080p'), true);
  assert.strictEqual(needsRemux('Movie.HEVC.1080p'), true);
  assert.strictEqual(needsRemux('Movie.H265'), true);
});

test('needsRemux — non-browser audio codecs', () => {
  for (const codec of ['AC3', 'AC-3', 'DTS', 'DTS-HD', 'EAC3', 'EAC-3', 'TrueHD', 'Atmos', 'FLAC']) {
    assert.strictEqual(needsRemux(`Movie.${codec}.1080p.x264`), true, `${codec} should need remux`);
  }
});

test('needsRemux — plain x264 + AAC does NOT need remux', () => {
  assert.strictEqual(needsRemux('Movie.x264.AAC.1080p'), false);
});

test('parsePackSizeBytes — TB / GB / MB', () => {
  assert.strictEqual(parsePackSizeBytes('1.5 GB'), 1.5 * 1024 * 1024 * 1024);
  assert.strictEqual(parsePackSizeBytes('700 MB'), 700 * 1024 * 1024);
  assert.strictEqual(parsePackSizeBytes('2 TB'), 2 * 1024 * 1024 * 1024 * 1024);
});

test('parsePackSizeBytes — garbage returns 0', () => {
  assert.strictEqual(parsePackSizeBytes(''), 0);
  assert.strictEqual(parsePackSizeBytes('lots'), 0);
  assert.strictEqual(parsePackSizeBytes(null), 0);
  assert.strictEqual(parsePackSizeBytes(undefined), 0);
});

test('parsePackSizeBytes — case-insensitive unit', () => {
  assert.strictEqual(parsePackSizeBytes('1 gb'), 1 * 1024 * 1024 * 1024);
  assert.strictEqual(parsePackSizeBytes('500 mb'), 500 * 1024 * 1024);
});

test('isSeasonPack — rejects single-episode names', () => {
  assert.strictEqual(isSeasonPack('Breaking Bad S01E05 1080p.mkv', 5 * 1024 * 1024 * 1024), false);
  assert.strictEqual(isSeasonPack('Show S03E11.mkv', 0), false);
});

test('isSeasonPack — positive signals', () => {
  assert.strictEqual(isSeasonPack('Breaking Bad Complete S01 1080p', 0), true);
  assert.strictEqual(isSeasonPack('Show Season 02', 0), true);
  assert.strictEqual(isSeasonPack('Show S01 1080p', 0), true);
  assert.strictEqual(isSeasonPack('Show E01-E10 1080p', 0), true);
});

test('isSeasonPack — large size alone is sufficient when no episode pattern', () => {
  // No S/E pattern, no pack keyword, but 5GB > 1.5GB threshold
  assert.strictEqual(isSeasonPack('Some Show 1080p', 5 * 1024 * 1024 * 1024), true);
});

test('isCompletePack — exists and is a function', () => {
  // Sanity check — semantics differ per implementation tweak so just
  // verify the export hasn't disappeared.
  assert.strictEqual(typeof isCompletePack, 'function');
});
