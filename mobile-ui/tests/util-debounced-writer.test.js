/**
 * Tests for lib/util.js — createDebouncedAtomicWriter.
 *
 * Covers:
 *   - Multiple rapid schedule() calls produce ONE write after waitMs.
 *   - The trailing write captures the LATEST snapshot (getData called at
 *     timer fire, not at schedule time).
 *   - Concurrent writes coalesce — no parallel writes against the same path.
 *   - flush() resolves only after the latest data is on disk.
 *   - Atomic: writes use tempfile+rename so a kill mid-write can't leave a
 *     partial file. We simulate by hooking fs.promises.rename to spy on the
 *     order of operations and verify no stray tmp file is left after a
 *     successful write.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createDebouncedAtomicWriter } = require('../lib/util');

function tmpFile(t, name = 'state.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alabtross-writer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}

test('schedule — single call writes after waitMs', async (t) => {
  const filePath = tmpFile(t);
  let data = { count: 1 };
  const w = createDebouncedAtomicWriter({ path: filePath, getData: () => data, waitMs: 30 });
  w.schedule();
  // No write yet — debounce window hasn't elapsed.
  assert.equal(fs.existsSync(filePath), false);
  await new Promise(r => setTimeout(r, 80));
  assert.equal(fs.existsSync(filePath), true);
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(onDisk, { count: 1 });
});

test('schedule — multiple rapid calls coalesce into ONE write', async (t) => {
  const filePath = tmpFile(t);
  let writeCount = 0;
  let data = { count: 0 };
  // Hook fs.promises.writeFile to count actual writes.
  const origWriteFile = fs.promises.writeFile;
  fs.promises.writeFile = function (...args) { writeCount++; return origWriteFile.apply(this, args); };
  t.after(() => { fs.promises.writeFile = origWriteFile; });

  const w = createDebouncedAtomicWriter({ path: filePath, getData: () => data, waitMs: 50 });
  // Burst of 20 schedule() calls inside the window. Each mutation updates
  // `data` so the trailing snapshot must capture the latest value.
  for (let i = 1; i <= 20; i++) {
    data = { count: i };
    w.schedule();
    await new Promise(r => setTimeout(r, 1));
  }
  // Wait long enough for the trailing debounce to fire and the write to land.
  await w.flush();
  assert.equal(writeCount, 1, 'expected exactly one write across 20 schedule() calls');
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(onDisk, { count: 20 }, 'trailing write should capture the latest snapshot');
});

test('schedule — getData called at write time, not at schedule time', async (t) => {
  const filePath = tmpFile(t);
  let callCount = 0;
  let data = { v: 'initial' };
  const w = createDebouncedAtomicWriter({
    path: filePath,
    getData: () => { callCount++; return data; },
    waitMs: 40,
  });
  // 5 schedule() calls before the timer fires.
  w.schedule(); w.schedule(); w.schedule(); w.schedule(); w.schedule();
  // At this point getData has NOT been called.
  assert.equal(callCount, 0);
  data = { v: 'final' };
  await w.flush();
  // After flush, getData was called exactly once for the single write.
  assert.equal(callCount, 1);
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(onDisk, { v: 'final' });
});

test('flush — resolves only after the latest data is on disk', async (t) => {
  const filePath = tmpFile(t);
  let data = { stage: 'first' };
  const w = createDebouncedAtomicWriter({ path: filePath, getData: () => data, waitMs: 100 });
  w.schedule();
  // Before flush, the file may or may not exist (depending on timing).
  // After flush, it MUST exist and reflect `data` as of the flush moment.
  data = { stage: 'second' };
  await w.flush();
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(onDisk, { stage: 'second' });
});

test('schedule during in-flight write — coalesces into ONE follow-up', async (t) => {
  const filePath = tmpFile(t);
  let inFlight = 0;
  let peakInFlight = 0;
  let data = { tick: 0 };

  const origWriteFile = fs.promises.writeFile;
  fs.promises.writeFile = async function (...args) {
    inFlight++;
    if (inFlight > peakInFlight) peakInFlight = inFlight;
    // Hold the write open long enough that follow-up schedule()s land.
    await new Promise(r => setTimeout(r, 30));
    try { return await origWriteFile.apply(this, args); }
    finally { inFlight--; }
  };
  t.after(() => { fs.promises.writeFile = origWriteFile; });

  const w = createDebouncedAtomicWriter({ path: filePath, getData: () => data, waitMs: 10 });

  // First schedule + flush to kick off a write.
  data = { tick: 1 };
  w.schedule();
  // While the write is in flight (held by our writeFile hook), fire many
  // more schedule() calls. They must coalesce into ONE follow-up pass.
  const flushP = w.flush();
  await new Promise(r => setTimeout(r, 15));
  for (let i = 2; i <= 50; i++) {
    data = { tick: i };
    w.schedule();
  }
  await flushP;
  // Drain any remaining follow-up via a second flush().
  await w.flush();

  assert.equal(peakInFlight, 1, 'never more than one parallel write should exist');
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(onDisk, { tick: 50 }, 'final write should capture the very last snapshot');
});

test('atomic — uses tempfile + rename (no .tmp left after success)', async (t) => {
  const filePath = tmpFile(t);
  const data = { v: 42 };
  const w = createDebouncedAtomicWriter({ path: filePath, getData: () => data, waitMs: 10 });
  w.schedule();
  await w.flush();
  // After a successful write the destination exists.
  assert.equal(fs.existsSync(filePath), true);
  // No `.tmp.*` file should remain in the directory — the rename consumed it.
  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const stragglers = fs.readdirSync(dir).filter(n => n.startsWith(baseName + '.tmp'));
  assert.deepEqual(stragglers, [], `stale tempfiles left behind: ${stragglers.join(', ')}`);
});

test('atomic — previous file untouched if rename fails mid-write', async (t) => {
  const filePath = tmpFile(t);
  // Seed the destination with known-good content so we can verify it's
  // preserved across a failed write.
  fs.writeFileSync(filePath, '{"good":true}', 'utf8');

  // Hook fs.promises.rename to fail. The writer must clean up the tmp
  // file and leave the destination intact (atomic-rename contract).
  const origRename = fs.promises.rename;
  fs.promises.rename = async function () { throw new Error('simulated rename failure'); };
  t.after(() => { fs.promises.rename = origRename; });

  let data = { evil: true };
  const w = createDebouncedAtomicWriter({ path: filePath, getData: () => data, waitMs: 10 });
  w.schedule();
  // flush() resolves even on internal write failure (errors are logged,
  // not propagated past .flush) — the contract is "best effort".
  await w.flush();

  // Destination still has the good content.
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(onDisk, { good: true });
  // No leftover tmp files in the directory.
  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const stragglers = fs.readdirSync(dir).filter(n => n.startsWith(baseName + '.tmp'));
  assert.deepEqual(stragglers, [], `stale tempfiles left behind: ${stragglers.join(', ')}`);
});

test('constructor — throws on missing path / getData', () => {
  assert.throws(() => createDebouncedAtomicWriter({ getData: () => ({}) }), /path is required/);
  assert.throws(() => createDebouncedAtomicWriter({ path: '/tmp/x' }), /getData must be a function/);
});

test('flush — works even when nothing was scheduled', async (t) => {
  const filePath = tmpFile(t);
  const w = createDebouncedAtomicWriter({ path: filePath, getData: () => ({ initial: true }), waitMs: 10 });
  // flush() with no pending schedule() should still produce a snapshot
  // (this is the semantics shutdown relies on: "force a write right now").
  await w.flush();
  assert.equal(fs.existsSync(filePath), true);
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(onDisk, { initial: true });
});
