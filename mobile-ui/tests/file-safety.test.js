/**
 * Tests for lib/file-safety.js — the path-traversal / MIME-confusion
 * boundary used by every fs-touching route. Pure functions, no fixtures.
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  DANGEROUS_EXTENSIONS,
  PACK_MIN_FILE_BYTES,
  MIN_PLAYABLE_VIDEO_BYTES,
  JUNK_FILE_REGEX,
  isFileNameSafe,
  getMimeType,
  sanitizeFilename,
} = require('../lib/file-safety');

test('isFileNameSafe — basic acceptance', () => {
  for (const ext of VIDEO_EXTENSIONS) {
    assert.strictEqual(isFileNameSafe(`movie${ext}`), true, `should accept video ext ${ext}`);
  }
  assert.strictEqual(isFileNameSafe('A Movie [2024] 1080p.mkv'), true);
});

test('isFileNameSafe — path traversal rejected', () => {
  assert.strictEqual(isFileNameSafe('../etc/passwd.mp4'), false);
  assert.strictEqual(isFileNameSafe('../../escape.mkv'), false);
  assert.strictEqual(isFileNameSafe('foo/../bar.mp4'), false);
});

test('isFileNameSafe — NUL byte rejected', () => {
  assert.strictEqual(isFileNameSafe('movie\0.mp4'), false);
  assert.strictEqual(isFileNameSafe('\0movie.mp4'), false);
});

test('isFileNameSafe — absolute paths rejected', () => {
  assert.strictEqual(isFileNameSafe('/etc/passwd.mp4'), false);
});

test('isFileNameSafe — empty / missing input rejected', () => {
  assert.strictEqual(isFileNameSafe(''), false);
  assert.strictEqual(isFileNameSafe(null), false);
  assert.strictEqual(isFileNameSafe(undefined), false);
});

test('isFileNameSafe — dangerous mid-extension blocked', () => {
  // movie.exe.mp4 / video.sh.mkv have a dangerous extension somewhere
  // in the chain even though the final ext is media. The split-and-scan
  // protects against the "save as media then rename" attack.
  assert.strictEqual(isFileNameSafe('movie.exe.mp4'), false);
  assert.strictEqual(isFileNameSafe('foo.bat.mkv'), false);
  assert.strictEqual(isFileNameSafe('thing.sh.webm'), false);
});

test('isFileNameSafe — unknown extension rejected for video kind', () => {
  assert.strictEqual(isFileNameSafe('movie.txt'), false);
  assert.strictEqual(isFileNameSafe('movie.json'), false);
  assert.strictEqual(isFileNameSafe('movie'), false);
});

test('isFileNameSafe — audio kind branching', () => {
  assert.strictEqual(isFileNameSafe('track.mp3', 'audio'), true);
  assert.strictEqual(isFileNameSafe('track.m4a', 'audio'), true);
  // mp4 is not an audio extension on the audio branch
  assert.strictEqual(isFileNameSafe('movie.mp4', 'audio'), false);
});

test('isFileNameSafe — any kind accepts both', () => {
  assert.strictEqual(isFileNameSafe('movie.mp4', 'any'), true);
  assert.strictEqual(isFileNameSafe('track.mp3', 'any'), true);
  // Still rejects non-media
  assert.strictEqual(isFileNameSafe('readme.txt', 'any'), false);
});

test('getMimeType — known extensions', () => {
  assert.strictEqual(getMimeType('movie.mp4'), 'video/mp4');
  assert.strictEqual(getMimeType('movie.mkv'), 'video/x-matroska');
  assert.strictEqual(getMimeType('movie.webm'), 'video/webm');
});

test('getMimeType — unknown extension falls back to octet-stream', () => {
  assert.strictEqual(getMimeType('movie.unknown'), 'application/octet-stream');
  assert.strictEqual(getMimeType('noextension'), 'application/octet-stream');
});

test('getMimeType — case-insensitive', () => {
  assert.strictEqual(getMimeType('MOVIE.MP4'), 'video/mp4');
  assert.strictEqual(getMimeType('Movie.Mkv'), 'video/x-matroska');
});

test('sanitizeFilename — strips dangerous chars', () => {
  assert.match(sanitizeFilename('weird"name\\.mp4'), /^[\w. \-()[\]]+$/);
});

test('sanitizeFilename — truncates at 200 chars', () => {
  const long = 'a'.repeat(500) + '.mp4';
  const out = sanitizeFilename(long);
  assert.ok(out.length <= 200, `length=${out.length} should be ≤ 200`);
});

test('sanitizeFilename — strips path components via basename', () => {
  // path.basename strips ../etc, leaving the leaf — the sanitize step
  // does not by itself prevent traversal, but combined with isFileNameSafe
  // at intake the leaf becomes a single segment.
  assert.strictEqual(sanitizeFilename('/etc/passwd'), 'passwd');
});

test('size thresholds are sensible constants', () => {
  assert.ok(PACK_MIN_FILE_BYTES > 0);
  assert.ok(MIN_PLAYABLE_VIDEO_BYTES > PACK_MIN_FILE_BYTES,
    'playable threshold should be stricter than pack-file threshold');
});

test('JUNK_FILE_REGEX — matches common throwaway files', () => {
  // Whole-word match (\b…\b) — keep the test strict to the spec so any
  // future regex tweak that loosens or tightens the boundary is caught.
  for (const name of [
    'sample.mkv', 'Sample.MP4', 'movie.trailer.mp4',
    'BONUS.featurette.mp4', 'interview-with-director.mp4',
    'movie.extra.mp4', 'movie.bonus.mp4',
  ]) {
    assert.ok(JUNK_FILE_REGEX.test(name), `should flag ${name}`);
  }
});

test('JUNK_FILE_REGEX — does not match normal titles', () => {
  for (const name of [
    'My Movie 2024.mp4',
    'Episode_05.mkv',
    'Show.S01E05.x265.mkv',
    // Sub-strings of junk words shouldn't false-positive on real titles:
    // "Extras_BehindTheScenes" has "extras" not "extra" at the boundary.
    'Extraordinary.Adventures.mp4',
  ]) {
    assert.strictEqual(JUNK_FILE_REGEX.test(name), false, `should NOT flag ${name}`);
  }
});

test('DANGEROUS_EXTENSIONS — sample executable types are in the set', () => {
  for (const ext of ['.exe', '.sh', '.bat', '.cmd', '.ps1', '.js', '.svg', '.html']) {
    assert.ok(DANGEROUS_EXTENSIONS.has(ext), `${ext} should be marked dangerous`);
  }
});

test('AUDIO_EXTENSIONS — common formats present', () => {
  for (const ext of ['.mp3', '.m4a', '.ogg', '.opus']) {
    assert.ok(AUDIO_EXTENSIONS.has(ext));
  }
});
