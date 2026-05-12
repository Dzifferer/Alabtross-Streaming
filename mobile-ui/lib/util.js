/**
 * Albatross — small reusable utilities.
 *
 * Kept small on purpose — anything that grows past ~200 LOC moves into
 * its own module. The current contents:
 *
 *   createDebouncedAtomicWriter — trailing-debounce + tempfile+rename
 *     wrapper for small JSON state files (manualCategories,
 *     collectionCache, …). Coalesces many rapid mutations into a
 *     single fs.writeFile + fs.rename and guarantees atomicity even
 *     across mid-write kills.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Returns a `{ schedule, flush }` writer that persists a JSON state file
 * atomically and with trailing-debounce coalescing.
 *
 * @param {object} opts
 * @param {string} opts.path     — destination file path
 * @param {() => any} opts.getData — snapshot callback; called at write time
 *   (NOT at schedule time) so the trailing write captures the LATEST state.
 *   Return value is JSON.stringified.
 * @param {number} [opts.waitMs=500] — debounce window in ms
 * @param {string} [opts.label] — log prefix (default: basename of path)
 * @returns {{ schedule: () => void, flush: () => Promise<void> }}
 *
 * Semantics:
 *   - Many `schedule()` calls inside the waitMs window coalesce into one
 *     fs.writeFile + rename at the END of the window.
 *   - At most one write is in flight at a time. If new `schedule()` calls
 *     arrive during a write, they queue exactly one follow-up so we never
 *     fan out parallel writes against the same file.
 *   - `flush()` resolves only after the latest scheduled data is on disk;
 *     used by graceful-shutdown to make sure the final mutation isn't lost.
 *   - Atomic: writes go to `<path>.tmp.<rand>`, then fs.rename overwrites
 *     `<path>`. A kill mid-write leaves the previous `<path>` intact (the
 *     rename is the commit point). The tempfile may be left behind on a
 *     crash; that's fine — it's a new random name each time and ignored
 *     by the loader.
 */
function createDebouncedAtomicWriter({ path: filePath, getData, waitMs = 500, label }) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('createDebouncedAtomicWriter: path is required');
  }
  if (typeof getData !== 'function') {
    throw new Error('createDebouncedAtomicWriter: getData must be a function');
  }
  const lbl = label || path.basename(filePath);

  let pendingTimer = null;     // setTimeout handle for the trailing write
  let writeInFlight = null;    // Promise of the currently-running write, or null
  let followUpScheduled = false; // a schedule() arrived during an in-flight write
  // Resolvers for any flush() callers waiting on the next clean state.
  let flushWaiters = [];

  function settleFlushWaiters(err) {
    // We always resolve flush() — errors are logged by flushPipeline below
    // and the caller (shutdown) can't usefully recover. Best-effort
    // semantics are exactly what shutdown needs: "make sure we tried."
    // If `err` is non-null the corresponding data is NOT on disk; the
    // operator sees the warn in stderr.
    void err;
    const waiters = flushWaiters;
    flushWaiters = [];
    for (const w of waiters) w.resolve();
  }

  async function writeNow() {
    // Take a snapshot at the moment the timer fires (NOT at schedule
    // time) so the trailing write picks up every coalesced mutation.
    let data;
    try {
      data = getData();
    } catch (err) {
      console.warn(`[${lbl}] getData() failed: ${err.message}`);
      return;
    }
    let json;
    try {
      json = JSON.stringify(data);
    } catch (err) {
      console.warn(`[${lbl}] JSON.stringify failed: ${err.message}`);
      return;
    }
    // Random suffix so concurrent processes (rare, but possible during a
    // crash + restart race) don't trample each other's tempfile.
    const tmpPath = `${filePath}.tmp.${crypto.randomBytes(4).toString('hex')}`;
    try {
      await fs.promises.writeFile(tmpPath, json, 'utf8');
      // Rename is the atomic commit. On POSIX this is a single
      // syscall; readers either see the old file or the new file,
      // never a half-written one.
      await fs.promises.rename(tmpPath, filePath);
    } catch (err) {
      // Best-effort cleanup of the temp file on failure.
      try { await fs.promises.unlink(tmpPath); } catch { /* not there, fine */ }
      throw err;
    }
  }

  async function flushPipeline() {
    // Single-flight: only one writer goroutine runs at a time. New
    // schedule()s during a write are coalesced into ONE follow-up
    // pass via followUpScheduled.
    while (true) {
      let err = null;
      try {
        await writeNow();
      } catch (e) {
        err = e;
        console.warn(`[${lbl}] write failed: ${e.message}`);
      }
      // If a schedule() came in during the write, drain it here so
      // flush() sees the truly-final state on disk before resolving.
      if (followUpScheduled) {
        followUpScheduled = false;
        continue;
      }
      // No follow-up — settle any flush waiters and exit the loop.
      settleFlushWaiters(err);
      return;
    }
  }

  function startWrite() {
    if (writeInFlight) {
      // Already writing — record that another pass is needed.
      followUpScheduled = true;
      return;
    }
    writeInFlight = flushPipeline().finally(() => { writeInFlight = null; });
  }

  function schedule() {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      startWrite();
    }, waitMs);
    // Prevent the debounce timer from keeping the event loop alive
    // by itself — the writer is bookkeeping, not critical path. The
    // shutdown path calls flush() before exit which kicks startWrite
    // synchronously anyway.
    if (pendingTimer && typeof pendingTimer.unref === 'function') pendingTimer.unref();
  }

  async function flush() {
    // Cancel any pending debounce timer and write immediately.
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    return new Promise((resolve, reject) => {
      flushWaiters.push({ resolve, reject });
      if (writeInFlight) {
        // A write is in flight — followUpScheduled ensures the latest
        // state lands. flushWaiters get resolved at the end of
        // flushPipeline().
        followUpScheduled = true;
      } else {
        // No write in flight — kick one off now.
        startWrite();
      }
    });
  }

  return { schedule, flush };
}

module.exports = { createDebouncedAtomicWriter };
