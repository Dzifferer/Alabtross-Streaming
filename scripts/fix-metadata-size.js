#!/usr/bin/env node
/**
 * Albatross — Metadata Size Repair Script
 *
 * Fixes the common "wrong_size" audit finding where an item's on-disk file
 * is slightly smaller (0.1-2%) than its metadata `fileSize` claims, but the
 * file itself is a valid, playable video. This happens when a torrent's
 * reported piece length changed, when a file was re-encoded by YIFY-style
 * groups, or when metadata captured the wrong number at item creation time.
 *
 * Without this script, running `POST /api/library/audit/remediate` with
 * `action: "remove"` or `"redownload"` will unlink those files (see
 * library-manager.js:602-608), forcing a redownload of ~50 GB of perfectly
 * good movies just because metadata is stale.
 *
 * WHAT THIS DOES
 * ──────────────
 * For every item whose on-disk file size differs from `fileSize`:
 *   1. Compute the percentage difference.
 *   2. If it's within the tolerance (default: 5%), run ffprobe against the
 *      file.
 *   3. If ffprobe reports a valid video stream with a plausible duration,
 *      rewrite the item's `fileSize` to match reality.
 *   4. Otherwise leave the item alone — it's either genuinely truncated or
 *      corrupt and should be re-downloaded through the normal audit flow.
 *
 * SAFETY RULES
 * ────────────
 *   R1. Only `status: complete` items are considered.
 *   R2. Only files that actually exist on disk and resolve under the
 *       library root (symlink escape guard).
 *   R3. The on-disk size must be within `--tolerance` percent of the
 *       metadata size. Anything bigger is treated as a real truncation.
 *   R4. ffprobe must return cleanly AND find a video stream AND report a
 *       duration > 0. If any of those fail, the item is left alone.
 *   R5. fileSize is the only field modified. Nothing else is touched — no
 *       rename, no move, no delete.
 *
 * SAFETY — METADATA WRITES
 * ────────────────────────
 *   - Dry-run by default. `--apply` is required to modify _metadata.json.
 *   - Before writing, the current _metadata.json is copied to
 *     _metadata.json.pre-sizefix-<timestamp>.bak inside the library dir.
 *   - Atomic temp-file + rename write (same pattern as library-manager).
 *   - Refuses to run if _metadata.json was modified within the last 10s
 *     (another writer might be active).
 *   - Refuses to run if _metadata.json.tmp.* exists.
 *
 * STOP THE CONTAINER before `--apply`. This script writes metadata
 * directly; concurrent writes from the running app will corrupt the file.
 *
 * USAGE
 * ─────
 *   node scripts/fix-metadata-size.js                    # dry run
 *   node scripts/fix-metadata-size.js --tolerance 2      # stricter (2%)
 *   node scripts/fix-metadata-size.js --verbose          # per-item detail
 *   node scripts/fix-metadata-size.js --apply            # execute
 *
 * Audit log is written to /tmp/albatross-sizefix-<timestamp>.json.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ─── CLI parsing ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let libraryPath = '/mnt/movies/torrent-cache/library';
let apply = false;
let verbose = false;
let tolerancePct = 5;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--library') libraryPath = args[++i];
  else if (a === '--apply') apply = true;
  else if (a === '--verbose' || a === '-v') verbose = true;
  else if (a === '--tolerance') {
    tolerancePct = parseFloat(args[++i]);
    if (!Number.isFinite(tolerancePct) || tolerancePct < 0) {
      console.error('--tolerance must be a non-negative number');
      process.exit(2);
    }
  }
  else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  else {
    console.error(`Unknown argument: ${a}`);
    printHelp();
    process.exit(2);
  }
}

function printHelp() {
  console.log(`Usage: node scripts/fix-metadata-size.js [options]

Updates _metadata.json fileSize fields for items where the on-disk file is
slightly different from what metadata expected, but ffprobe confirms the
file is a valid video. Saves running audit/remediate from re-downloading
playable movies.

Options:
  --library <path>    Library root (default: /mnt/movies/torrent-cache/library)
  --tolerance <pct>   Max % size diff to auto-fix (default: 5)
  --apply             Execute the fix (default: dry-run)
  --verbose, -v       Print per-item detail
  --help, -h          Show this help

IMPORTANT: Stop alabtross-mobile before --apply — this script writes
_metadata.json directly.
`);
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MIN_METADATA_AGE_MS = 10 * 1000;
const FFPROBE_TIMEOUT_MS = 30 * 1000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function humanBytes(n) {
  if (!Number.isFinite(n) || n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[u]}`;
}

function isUnderRoot(abs, root) {
  const r = path.resolve(abs), R = path.resolve(root);
  return r === R || r.startsWith(R + path.sep);
}

function normRel(p) {
  if (!p) return p;
  return path.normalize(p).replace(/^(\.\/)+/, '');
}

/**
 * Probe a file with ffprobe. Returns { ok: bool, reason: string, duration: number|null }.
 * Same invocation style as library-manager._probeFile so behavior stays consistent.
 */
function probeFile(absPath) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      absPath,
    ]);

    let output = '';
    let killedByTimeout = false;

    const timer = setTimeout(() => {
      killedByTimeout = true;
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }, FFPROBE_TIMEOUT_MS);

    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, reason: 'ffprobe spawn failed', duration: null });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killedByTimeout) return resolve({ ok: false, reason: `ffprobe timeout (${FFPROBE_TIMEOUT_MS}ms)`, duration: null });
      if (code !== 0) return resolve({ ok: false, reason: `ffprobe exit ${code}`, duration: null });

      try {
        const info = JSON.parse(output);
        const videoStream = (info.streams || []).find(s => s.codec_type === 'video');
        if (!videoStream) {
          return resolve({ ok: false, reason: 'no video stream', duration: null });
        }
        const duration = info.format && info.format.duration != null
          ? parseFloat(info.format.duration)
          : null;
        if (!Number.isFinite(duration) || duration <= 0) {
          return resolve({ ok: false, reason: 'zero/missing duration', duration });
        }
        resolve({ ok: true, reason: null, duration });
      } catch (err) {
        resolve({ ok: false, reason: `ffprobe output parse: ${err.message}`, duration: null });
      }
    });
  });
}

function atomicWriteJson(targetFile, data) {
  const tmp = `${targetFile}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, targetFile);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[sizefix] Library path: ${libraryPath}`);
  console.log(`[sizefix] Mode: ${apply ? 'APPLY — will rewrite _metadata.json' : 'dry-run'}`);
  console.log(`[sizefix] Tolerance: ${tolerancePct}%`);

  if (!fs.existsSync(libraryPath)) {
    console.error(`[FATAL] Library path does not exist: ${libraryPath}`);
    process.exit(1);
  }
  if (!fs.statSync(libraryPath).isDirectory()) {
    console.error(`[FATAL] Library path is not a directory: ${libraryPath}`);
    process.exit(1);
  }

  const metadataFile = path.join(libraryPath, '_metadata.json');
  if (!fs.existsSync(metadataFile)) {
    console.error(`[FATAL] _metadata.json not found at ${metadataFile}`);
    process.exit(1);
  }

  // ── Concurrency guards ──────────────────────────────────────────────────
  const metaStat = fs.statSync(metadataFile);
  const ageMs = Date.now() - metaStat.mtimeMs;
  if (apply && ageMs < MIN_METADATA_AGE_MS) {
    console.error(`[FATAL] _metadata.json was modified ${Math.round(ageMs / 1000)}s ago — another writer may be active.`);
    console.error(`        Stop the alabtross-mobile container first, then retry.`);
    process.exit(1);
  }
  const tmpWriters = fs.readdirSync(libraryPath).filter(n => n.startsWith('_metadata.json.tmp.'));
  if (tmpWriters.length > 0) {
    console.error(`[FATAL] Found atomic-write temp file(s): ${tmpWriters.join(', ')}`);
    console.error(`        Another process is writing metadata. Aborting.`);
    process.exit(1);
  }

  // ── Load metadata ────────────────────────────────────────────────────────
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  } catch (err) {
    console.error(`[FATAL] Failed to parse _metadata.json: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(metadata)) {
    console.error(`[FATAL] _metadata.json is not an array`);
    process.exit(1);
  }
  console.log(`[sizefix] Loaded ${metadata.length} metadata items`);

  // ── Classify items ───────────────────────────────────────────────────────
  // Work in three passes so we don't waste ffprobe calls on items that would
  // be skipped anyway:
  //   Pass 1: filter to complete items whose on-disk size differs from
  //           metadata within the tolerance.
  //   Pass 2: ffprobe each candidate.
  //   Pass 3: apply fixes to the items whose probe passed.
  const plan = {
    libraryPath,
    apply,
    tolerancePct,
    timestamp: new Date().toISOString(),
    stats: {
      total: metadata.length,
      skippedNotComplete: 0,
      skippedNoFilePath: 0,
      skippedMissing: 0,
      skippedUnsafe: 0,
      skippedExactMatch: 0,
      skippedOutsideTolerance: 0,
      probeOk: 0,
      probeFailed: 0,
      plannedFix: 0,
      bytesAdjustment: 0,
    },
    candidates: [],   // items within tolerance, before ffprobe
    fixes: [],        // items passing ffprobe — the actual plan
    skipsOutsideTolerance: [], // items too far off — audit/remediate territory
    skipsProbeFailed: [],      // ffprobe said the file is broken
  };

  // Pass 1: build candidate list
  for (const item of metadata) {
    if (item.status !== 'complete') {
      plan.stats.skippedNotComplete++;
      continue;
    }
    if (!item.filePath || !item.fileSize || item.fileSize <= 0) {
      plan.stats.skippedNoFilePath++;
      continue;
    }

    const abs = path.join(libraryPath, normRel(item.filePath));
    if (!isUnderRoot(abs, libraryPath)) {
      plan.stats.skippedUnsafe++;
      continue;
    }

    let st;
    try { st = fs.lstatSync(abs); } catch { st = null; }
    if (!st || !st.isFile()) {
      plan.stats.skippedMissing++;
      continue;
    }

    if (st.size === item.fileSize) {
      plan.stats.skippedExactMatch++;
      continue;
    }

    const diffPct = Math.abs(st.size - item.fileSize) / item.fileSize * 100;
    if (diffPct > tolerancePct) {
      plan.stats.skippedOutsideTolerance++;
      plan.skipsOutsideTolerance.push({
        id: item.id,
        name: item.name || '?',
        filePath: item.filePath,
        metadataSize: item.fileSize,
        diskSize: st.size,
        diffPct: Number(diffPct.toFixed(2)),
      });
      continue;
    }

    plan.candidates.push({
      id: item.id,
      name: item.name || '?',
      filePath: item.filePath,
      absPath: abs,
      metadataSize: item.fileSize,
      diskSize: st.size,
      diffPct: Number(diffPct.toFixed(2)),
    });
  }

  console.log(`[sizefix] ${plan.candidates.length} candidate(s) within ${tolerancePct}% tolerance — running ffprobe...`);

  // Pass 2: ffprobe each candidate (sequential — ffprobe is IO-bound and we
  // don't want to thrash the drive)
  for (let i = 0; i < plan.candidates.length; i++) {
    const c = plan.candidates[i];
    if (verbose) {
      console.log(`  [${i + 1}/${plan.candidates.length}] probing: ${c.filePath}`);
    }
    const probe = await probeFile(c.absPath);
    if (probe.ok) {
      plan.stats.probeOk++;
      plan.stats.plannedFix++;
      plan.stats.bytesAdjustment += (c.diskSize - c.metadataSize);
      plan.fixes.push({
        ...c,
        duration: probe.duration,
        action: 'update-fileSize',
      });
    } else {
      plan.stats.probeFailed++;
      plan.skipsProbeFailed.push({
        ...c,
        probeReason: probe.reason,
      });
    }
  }

  // ── Print human-readable report ──────────────────────────────────────────
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`  METADATA SIZE FIX REPORT`);
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`  Items total                        : ${plan.stats.total}`);
  console.log(`  Items with exact size match        : ${plan.stats.skippedExactMatch}`);
  console.log(`  Skipped (not complete)             : ${plan.stats.skippedNotComplete}`);
  console.log(`  Skipped (no filePath/size)         : ${plan.stats.skippedNoFilePath}`);
  console.log(`  Skipped (file missing on disk)     : ${plan.stats.skippedMissing}`);
  console.log(`  Skipped (unsafe path)              : ${plan.stats.skippedUnsafe}`);
  console.log(`  Skipped (outside ${tolerancePct}% tolerance)     : ${plan.stats.skippedOutsideTolerance}`);
  console.log(`  ffprobe failed (genuinely broken)  : ${plan.stats.probeFailed}`);
  console.log(`  PLANNED to fix                     : ${plan.stats.plannedFix}`);
  if (plan.stats.plannedFix > 0) {
    const deltaBytes = plan.stats.bytesAdjustment;
    const sign = deltaBytes >= 0 ? '+' : '-';
    console.log(`  Total fileSize adjustment          : ${sign}${humanBytes(Math.abs(deltaBytes))}`);
  }
  console.log('');

  if (plan.fixes.length > 0) {
    console.log('── Items to fix (ffprobe OK) ──────────────────────────────────────────');
    for (const f of plan.fixes) {
      console.log(`  ${f.name}`);
      console.log(`    id       : ${f.id}`);
      console.log(`    diff     : ${f.diffPct}%  (disk ${humanBytes(f.diskSize)} vs meta ${humanBytes(f.metadataSize)})`);
      if (verbose) {
        console.log(`    duration : ${f.duration ? Math.round(f.duration) + 's' : '?'}`);
        console.log(`    path     : ${f.filePath}`);
      }
    }
    console.log('');
  }

  if (plan.skipsProbeFailed.length > 0) {
    console.log('── Items skipped — ffprobe FAILED (let audit/remediate handle) ───────');
    for (const s of plan.skipsProbeFailed) {
      console.log(`  ${s.name}`);
      console.log(`    id       : ${s.id}`);
      console.log(`    diff     : ${s.diffPct}%  (disk ${humanBytes(s.diskSize)} vs meta ${humanBytes(s.metadataSize)})`);
      console.log(`    reason   : ${s.probeReason}`);
    }
    console.log('');
  }

  if (plan.skipsOutsideTolerance.length > 0) {
    console.log(`── Items skipped — diff > ${tolerancePct}% (likely truncated, let audit/remediate handle) ──`);
    for (const s of plan.skipsOutsideTolerance) {
      console.log(`  ${s.name}`);
      console.log(`    id       : ${s.id}`);
      console.log(`    diff     : ${s.diffPct}%  (disk ${humanBytes(s.diskSize)} vs meta ${humanBytes(s.metadataSize)})`);
    }
    console.log('');
  }

  // ── Execute if --apply ───────────────────────────────────────────────────
  if (apply && plan.fixes.length > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(libraryPath, `_metadata.json.pre-sizefix-${stamp}.bak`);
    try {
      fs.copyFileSync(metadataFile, backupPath);
      console.log(`[sizefix] Backed up metadata to ${backupPath}`);
    } catch (err) {
      console.error(`[FATAL] Failed to create metadata backup: ${err.message}`);
      process.exit(1);
    }

    const fixById = new Map(plan.fixes.map(f => [f.id, f.diskSize]));
    let applied = 0;
    for (const item of metadata) {
      const newSize = fixById.get(item.id);
      if (newSize != null) {
        item.fileSize = newSize;
        applied++;
      }
    }
    console.log(`[sizefix] Rewriting ${applied} fileSize field(s) in _metadata.json...`);

    try {
      atomicWriteJson(metadataFile, metadata);
      console.log(`[sizefix] _metadata.json updated atomically.`);
    } catch (err) {
      console.error(`[FATAL] Failed to write _metadata.json: ${err.message}`);
      console.error(`[FATAL] Backup is still at ${backupPath}`);
      process.exit(1);
    }
  } else if (apply) {
    console.log(`[sizefix] Nothing to apply — no items needed fixing.`);
  }

  // ── Write audit log ──────────────────────────────────────────────────────
  const logStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = `/tmp/albatross-sizefix-${logStamp}.json`;
  try {
    fs.writeFileSync(logPath, JSON.stringify(plan, null, 2));
    console.log(`[sizefix] Audit log written: ${logPath}`);
  } catch (err) {
    console.error(`[WARN] Could not write audit log: ${err.message}`);
  }

  if (!apply) {
    console.log('');
    console.log('This was a DRY RUN. No files were touched.');
    console.log('Re-run with --apply to actually rewrite _metadata.json.');
    console.log('IMPORTANT: stop the alabtross-mobile container first.');
  }
}

main().catch(err => {
  console.error(`[FATAL] ${err.stack || err.message}`);
  process.exit(1);
});
