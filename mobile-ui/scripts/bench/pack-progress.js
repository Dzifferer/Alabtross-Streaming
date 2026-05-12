#!/usr/bin/env node
/**
 * Microbenchmark: pack-progress filter cost before/after the secondary
 * _byPackId index.
 *
 * The _trackPackProgress tick rescans the entire library every 3s with
 *   [...this._items.values()].filter(i => i.packId === packId && ...)
 * which is O(N) on the total library size. Phase 1 added a _byPackId
 * Map<packId, Set<id>> so that scan becomes O(packSize). This script
 * quantifies the speedup on a synthetic 1000-item library with a 500-
 * item pack.
 *
 * Run with: node scripts/bench/pack-progress.js
 */

const LibraryManager = require('../../lib/library-manager');

function bench(label, iters, fn) {
  // Warmup the JIT
  for (let i = 0; i < 50; i++) fn();
  const start = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const end = process.hrtime.bigint();
  const totalNs = Number(end - start);
  const perOp = totalNs / iters;
  return { label, iters, totalMs: totalNs / 1e6, perOpUs: perOp / 1000, perOpNs: perOp };
}

function main() {
  // Construct with noAutoInit so we don't trigger fs mkdir / metadata load /
  // peer-reputation persist timer / cpu-monitor interval.
  const lib = new LibraryManager({
    libraryPath: '/tmp/alabtross-bench-doesnt-exist',
    noAutoInit: true,
  });
  // _saveMetadata is normally a debounced fs.writeFile — short-circuit so
  // a 1000-item insert doesn't schedule 1000 timers.
  lib._saveMetadata = () => {};

  // Insert 1000 synthetic items, 500 of which share packId 'pack_synth'.
  // The remaining 500 are split across 50 other packs (10 each) so the
  // _byPackId index has realistic non-trivial size.
  const PACK_TARGET = 'pack_synth';
  for (let i = 0; i < 500; i++) {
    const item = {
      id: `synth_${i}`,
      packId: PACK_TARGET,
      status: i % 4 === 0 ? 'complete' : 'downloading',
    };
    lib._items.set(item.id, item);
    lib._indexItem(item);
  }
  for (let i = 0; i < 500; i++) {
    const packBucket = `pack_other_${i % 50}`;
    const item = {
      id: `other_${i}`,
      packId: packBucket,
      status: i % 3 === 0 ? 'complete' : (i % 3 === 1 ? 'queued' : 'downloading'),
    };
    lib._items.set(item.id, item);
    lib._indexItem(item);
  }

  console.log(`Library: ${lib._items.size} items`);
  console.log(`Target pack '${PACK_TARGET}': ${lib._getPackItems(PACK_TARGET).length} items`);
  console.log();

  const ITERS = 50_000;

  // Old pattern: full scan + filter
  const beforeFilter = bench('OLD: [...items.values()].filter(i => i.packId === X)', ITERS, () => {
    const matches = [...lib._items.values()].filter(i => i.packId === PACK_TARGET);
    if (matches.length !== 500) throw new Error('sanity: pack-size drift');
  });

  // New pattern: _byPackId index
  const afterFilter = bench('NEW: lib._getPackItems(X)', ITERS, () => {
    const matches = lib._getPackItems(PACK_TARGET);
    if (matches.length !== 500) throw new Error('sanity: pack-size drift');
  });

  // Also benchmark the combined filter that _trackPackProgress uses:
  // i.packId === X && i.status === 'downloading'
  const beforeCombined = bench("OLD: filter(packId === X && status === 'downloading')", ITERS, () => {
    [...lib._items.values()].filter(i => i.packId === PACK_TARGET && i.status === 'downloading');
  });
  const afterCombined = bench("NEW: _getPackItems(X).filter(status === 'downloading')", ITERS, () => {
    lib._getPackItems(PACK_TARGET).filter(i => i.status === 'downloading');
  });

  for (const r of [beforeFilter, afterFilter, beforeCombined, afterCombined]) {
    console.log(`${r.label.padEnd(70)} ${r.perOpUs.toFixed(2).padStart(7)} µs/op    (${r.iters} iters, ${r.totalMs.toFixed(1)} ms total)`);
  }
  console.log();

  console.log(`Speedup (single-key)  : ${(beforeFilter.perOpNs / afterFilter.perOpNs).toFixed(1)}x`);
  console.log(`Speedup (compound)    : ${(beforeCombined.perOpNs / afterCombined.perOpNs).toFixed(1)}x`);

  // ── A more realistic shape ──
  //
  // When the pack-of-interest is a small fraction of the library (5-10
  // pack-items in a 2000-item library), the index advantage is much
  // larger — _trackPackProgress is the canonical case. Add a second
  // batch matching that shape and report the speedup.
  console.log();
  console.log('── Realistic shape: small pack inside large library ──');

  const lib2 = new LibraryManager({
    libraryPath: '/tmp/alabtross-bench-doesnt-exist-2',
    noAutoInit: true,
  });
  lib2._saveMetadata = () => {};

  const SMALL_PACK = 'pack_target';
  for (let i = 0; i < 10; i++) {
    const item = { id: `tp_${i}`, packId: SMALL_PACK, status: 'downloading' };
    lib2._items.set(item.id, item);
    lib2._indexItem(item);
  }
  // 1990 unrelated items (movies + episodes in other packs)
  for (let i = 0; i < 1990; i++) {
    const packBucket = i % 5 === 0 ? null : `pack_other_${i % 200}`;
    const item = {
      id: `bg_${i}`,
      packId: packBucket || undefined,
      status: i % 4 === 0 ? 'complete' : (i % 4 === 1 ? 'queued' : 'downloading'),
    };
    lib2._items.set(item.id, item);
    lib2._indexItem(item);
  }
  console.log(`Library: ${lib2._items.size} items`);
  console.log(`Target pack '${SMALL_PACK}': ${lib2._getPackItems(SMALL_PACK).length} items`);
  console.log();

  const r1 = bench(`OLD: filter (${lib2._items.size}-item scan)`, ITERS, () => {
    [...lib2._items.values()].filter(i => i.packId === SMALL_PACK && i.status === 'downloading');
  });
  const r2 = bench(`NEW: _getPackItems().filter`, ITERS, () => {
    lib2._getPackItems(SMALL_PACK).filter(i => i.status === 'downloading');
  });
  for (const r of [r1, r2]) {
    console.log(`${r.label.padEnd(70)} ${r.perOpUs.toFixed(2).padStart(7)} µs/op    (${r.iters} iters, ${r.totalMs.toFixed(1)} ms total)`);
  }
  console.log();
  console.log(`Speedup (realistic)   : ${(r1.perOpNs / r2.perOpNs).toFixed(1)}x`);
}

main();
