// Unit tests for TMDB match scoring. Run with:
//   node --test tests/tmdb-scoring.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { titleWordOverlap } = require('../lib/tmdb-scoring');

// Regression: previously the overlap divided by the longer side, so short
// franchise queries against long TMDB subtitled titles fell below the 0.5
// hard-reject threshold in lookupMovieByName and never got linked.

test('titleWordOverlap: "Harry Potter" matches a long franchise title', () => {
  const o = titleWordOverlap('Harry Potter', "Harry Potter and the Philosopher's Stone");
  assert.equal(o, 1);
});

test('titleWordOverlap: "Star Wars" matches "Star Wars: The Force Awakens"', () => {
  const o = titleWordOverlap('Star Wars', 'Star Wars: The Force Awakens');
  assert.equal(o, 1);
});

test('titleWordOverlap: "Lord of the Rings" matches the long Fellowship title', () => {
  const o = titleWordOverlap('Lord of the Rings', 'The Lord of the Rings: The Fellowship of the Ring');
  assert.equal(o, 1);
});

test('titleWordOverlap: punctuation-heavy query still matches (Spider-Man)', () => {
  const o = titleWordOverlap('Spider-Man', 'Spider-Man: No Way Home');
  assert.equal(o, 1);
});

test('titleWordOverlap: extra query words missing from title drag the score down', () => {
  // The original guarded case: we don't want "Avatar Fire and Ash" to get
  // silently matched to "Avatar: The Way of Water" just because it shares
  // "avatar". 1/4 words in common → below the 0.5 floor.
  const o = titleWordOverlap('Avatar Fire and Ash', 'Avatar: The Way of Water');
  assert.ok(o < 0.5, `expected <0.5, got ${o}`);
});

test('titleWordOverlap: identical titles score 1', () => {
  assert.equal(titleWordOverlap('The Matrix', 'The Matrix'), 1);
});

test('titleWordOverlap: case and punctuation are normalized', () => {
  assert.equal(titleWordOverlap('star wars', 'STAR WARS!!!'), 1);
});

test('titleWordOverlap: empty inputs return 0', () => {
  assert.equal(titleWordOverlap('', 'Star Wars'), 0);
  assert.equal(titleWordOverlap('Star Wars', ''), 0);
  assert.equal(titleWordOverlap(null, null), 0);
});
