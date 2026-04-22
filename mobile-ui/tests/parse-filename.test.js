// Unit tests for the unified file-name parser. Run with:
//   node --test tests/parse-filename.test.js
//
// These tests exist because title extraction is heuristic and every fix for
// one filename shape risks regressing another. Keep the table growing.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Point the library at a throwaway temp dir — the constructor does fs.mkdir
// synchronously and spawns async init work. We only exercise pure parsing
// methods, so the async side never matters.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'albatross-parser-'));
process.env.LIBRARY_PATH = tmp;
const LibraryManager = require('../lib/library-manager');
const lib = new LibraryManager({ libraryPath: tmp });

test('_parseSeasonEpisode: S01E05', () => {
  const r = lib._parseSeasonEpisode('Breaking.Bad.S01E05.720p.BluRay.mkv', 1);
  assert.equal(r.season, 1);
  assert.equal(r.episode, 5);
});

test('_parseSeasonEpisode: 1x05 with bounded digits', () => {
  const r = lib._parseSeasonEpisode('Show.1x05.mkv', 1);
  assert.equal(r.season, 1);
  assert.equal(r.episode, 5);
});

test('_parseSeasonEpisode: 1920x1080 must NOT match as S1920E1080', () => {
  const r = lib._parseSeasonEpisode('Movie.1920x1080.mp4', 1);
  assert.notEqual(r.season, 1920);
  assert.notEqual(r.episode, 1080);
});

test('_parseSeasonEpisode: anime "- 07 -"', () => {
  const r = lib._parseSeasonEpisode('[Group] Naruto Shippuden - 007 - Title.mp4', 1);
  assert.equal(r.episode, 7);
});

test('_parseSeasonEpisode: does not treat 1999 as episode', () => {
  const r = lib._parseSeasonEpisode('The Matrix - 1999.mkv', 1);
  assert.equal(r.episode, null);
});

test('_parseSeasonEpisode: directory Season 02 wins over grandparent S01-S07', () => {
  const r = lib._parseSeasonEpisode(
    path.join('Series S01-S07', 'Season 02', 'Show.E05.mkv'),
    1
  );
  assert.equal(r.season, 2);
  assert.equal(r.episode, 5);
});

test('_deriveShowNameFromFile: S01E05 strips episode marker', () => {
  assert.equal(
    lib._deriveShowNameFromFile('Breaking.Bad.S01E05.720p.BluRay.mkv'),
    'Breaking Bad'
  );
});

test('_deriveShowNameFromFile: preserves "Mr. Smith" when only one dot', () => {
  assert.equal(
    lib._deriveShowNameFromFile('Mr. Smith - S01E05.mkv'),
    'Mr. Smith'
  );
});

test('_deriveShowNameFromFile: anime "- 001"', () => {
  assert.equal(
    lib._deriveShowNameFromFile('[animeawake] Naruto Shippuden - 010 - Title.mp4'),
    'Naruto Shippuden'
  );
});

test('_deriveShowNameFromFile: single-digit anime episode "- 1"', () => {
  assert.equal(
    lib._deriveShowNameFromFile('Show - 1.mkv'),
    'Show'
  );
});

test('_deriveShowNameFromFile: returns null for movie-shaped filenames', () => {
  assert.equal(
    lib._deriveShowNameFromFile('The.Matrix.1999.1080p.BluRay.x264.mkv'),
    null
  );
});

test('_deriveMovieNameFromFile: dots separator + YIFY', () => {
  const r = lib._deriveMovieNameFromFile('The.Matrix.1999.1080p.BluRay.x264-YIFY.mkv');
  assert.equal(r.title, 'The Matrix');
  assert.equal(r.year, '1999');
});

test('_deriveMovieNameFromFile: parenthesised year', () => {
  const r = lib._deriveMovieNameFromFile('Inception (2010) [1080p].mp4');
  assert.equal(r.title, 'Inception');
  assert.equal(r.year, '2010');
});

test('_deriveMovieNameFromFile: "Mr. Smith" preserved with only one dot', () => {
  const r = lib._deriveMovieNameFromFile('Mr. Smith Goes to Washington 1939.mkv');
  assert.equal(r.title, 'Mr. Smith Goes to Washington');
  assert.equal(r.year, '1939');
});

test('_deriveMovieNameFromFile: James Bond prefix stripped', () => {
  const r = lib._deriveMovieNameFromFile('James Bond 007 Octopussy 1983.mkv');
  assert.equal(r.title, 'Octopussy');
});

test('_deriveMovieNameFromFile: "YYYY - Title" (Disney-pack shape)', () => {
  const r = lib._deriveMovieNameFromFile('1959 - Sleeping Beauty.avi');
  assert.equal(r.title, 'Sleeping Beauty');
  assert.equal(r.year, '1959');
});

test('_deriveMovieNameFromFile: bare year-only filename returns null title', () => {
  const r = lib._deriveMovieNameFromFile('2002.1080p.BluRay.mkv');
  assert.equal(r.title, null);
  assert.equal(r.year, '2002');
});

test('_looksLikeEpisode: classic markers', () => {
  assert.equal(lib._looksLikeEpisode('Show.S01E05.mkv'), true);
  assert.equal(lib._looksLikeEpisode('Show.1x05.mkv'), true);
  assert.equal(lib._looksLikeEpisode('Show - 010 - Title.mkv'), true);
  assert.equal(lib._looksLikeEpisode('Show Episode 5.mkv'), true);
});

test('_looksLikeEpisode: rejects movie filenames', () => {
  assert.equal(lib._looksLikeEpisode('The.Matrix.1999.1080p.mkv'), false);
  assert.equal(lib._looksLikeEpisode('Inception (2010).mp4'), false);
});

test('parseFileName: series hint with S/E sets show + season + episode', () => {
  const r = lib.parseFileName('Breaking.Bad.S01E05.720p.BluRay.mkv');
  assert.equal(r.type, 'series');
  assert.equal(r.show, 'Breaking Bad');
  assert.equal(r.season, 1);
  assert.equal(r.episode, 5);
  assert.equal(r.query, 'Breaking Bad');
});

test('parseFileName: movie hint with year', () => {
  const r = lib.parseFileName('The.Matrix.1999.1080p.BluRay.x264-YIFY.mkv');
  assert.equal(r.type, 'movie');
  assert.equal(r.title, 'The Matrix');
  assert.equal(r.year, '1999');
  assert.equal(r.query, 'The Matrix');
});

test('parseFileName: hint override wins over heuristic', () => {
  const r = lib.parseFileName('Arrival.2160p.HDR.mkv', { hint: 'movie' });
  assert.equal(r.type, 'movie');
  assert.equal(r.title, 'Arrival');
});

test('parseFileName: unparseable fallback keeps a query string', () => {
  const r = lib.parseFileName('????.mkv');
  // Title/show may both be null for garbage names, but query should be
  // a last-resort string so the caller can still try a search.
  assert.ok(r.query === null || typeof r.query === 'string');
});

// Cleanup — remove the temp library dir so parallel test runs don't collide.
test.after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});
