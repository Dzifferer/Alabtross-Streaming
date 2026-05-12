/**
 * Test helper: tmpdir lifecycle.
 *
 * withTmpDir(t, prefix) creates a fresh empty directory inside os.tmpdir()
 * and schedules `t.after` cleanup so it disappears when the test ends. The
 * caller gets the absolute path back synchronously.
 *
 * Usage:
 *   const { withTmpDir } = require('./helpers/tmpdir');
 *   test('something', (t) => {
 *     const dir = withTmpDir(t);
 *     // ... use dir ...
 *   });
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function withTmpDir(t, prefix = 'alabtross-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  return dir;
}

module.exports = { withTmpDir };
