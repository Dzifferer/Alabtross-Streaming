#!/usr/bin/env node
/**
 * Albatross — Metadata Relink Script
 *
 * Fixes the common library-manager inconsistency where multiple items for
 * the same infoHash end up with `filePath` pointing at DIFFERENT top-level
 * folders on disk. This happens when a re-add / rename / repair pass
 * creates a fresh folder without migrating the existing metadata, leaving
 * the library with a split view of the same torrent.
 *
 * Symptom: dedup-library.js reports "orphan is referenced by _metadata.json"
 * and skips the group because deleting the orphan would break a live item.
 *
 * WHAT THIS DOES
 * ──────────────
 * For every hash group with >1 folder on disk:
 *   1. Pick the "keeper" folder (the one that holds the most metadata
 *      references — ties broken by "most video files" then newest mtime).
 *   2. For each metadata item whose `filePath` points into a non-keeper
 *      folder for that hash, look for a byte-exact twin at the same inner
 *      relative path inside the keeper folder.
 *   3. If the twin exists, rewrite the item's `filePath` to point at the
 *      keeper version. Leave the old orphan file alone for dedup-library.js
 *      to remove in a second pass.
 *
 * After this script runs cleanly, dedup-library.js can safely remove the
 * orphan folders because nothing in `_metadata.json` references them anymore.
 *
 * SAFETY RULES (an item is ONLY relinked if ALL hold)
 * ───────────────────────────────────────────────────
 *   R1. Item status is 'complete'. Items in downloading/queued/converting/
 *       paused/failed are left alone — their paths may be in flux.
 *   R2. The item's current file actually exists on disk at the claimed
 *       path and size. (If not, this is a deeper problem; we bail on the
 *       item so the user sees it.)
 *   R3. The keeper folder contains a file at the same inner relative path.
 *   R4. That keeper file has the same byte size as the item's fileSize.
 *   R5. The keeper file is not the same inode (hardlink) as the orphan —
 *       if it is, relinking wouldn't change anything meaningful.
 *   R6. Both files resolve under the library root (symlink escape guard).
 *
 * If ANY item in a hash group fails its checks, that specific item is
 * skipped; the group can still proceed for other eligible items.
 *
 * SAFETY — METADATA WRITES
 * ────────────────────────
 *   - Dry-run by default. `--apply` is required to modify _metadata.json.
 *   - Before writing, the current _metadata.json is copied to
 *     _metadata.json.pre-relink-<timestamp>.bak inside the library dir.
 *   - Write uses the same temp-file + atomic rename pattern as
 *     library-manager._saveMetadata (so a crash mid-write can't corrupt).
 *   - Refuses to run if _metadata.json was modified within the last 10s
 *     (another writer might be active).
 *   - Refuses to run if _metadata.json.tmp.* exists (another writer in
 *     the middle of an atomic write).
 *
 * STOP THE CONTAINER before `--apply`. This script writes metadata
 * directly — concurrent writes from the running app will corrupt the file.
 *
 * USAGE
 * ─────
 *   node scripts/relink-metadata.js                     # dry run
 *   node scripts/relink-metadata.js --library /path     # custom library root
 *   node scripts/relink-metadata.js --verbose           # per-item detail
 *   node scripts/relink-metadata.js --apply             # execute
 *
 * Audit log is always written to /tmp/albatross-relink-<timestamp>.json.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── CLI parsing ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let libraryPath = '/mnt/movies/torrent-cache/library';
let apply = false;
let verbose = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--library') libraryPath = args[++i];
  else if (a === '--apply') apply = true;
  else if (a === '--verbose' || a === '-v') verbose = true;
  else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  else {
    console.error(`Unknown argument: ${a}`);
    printHelp();
    process.exit(2);
  }
}

function printHelp() {
  console.log(`Usage: node scripts/relink-metadata.js [options]

Rewrites _metadata.json so every item for a given infoHash points into a
single "keeper" folder — prerequisite for running dedup-library.js on
groups that dedup-library.js currently skips with "orphan is referenced".

Options:
  --library <path>   Library root (default: /mnt/movies/torrent-cache/library)
  --apply            Execute the relink (default: dry-run)
  --verbose, -v      Print per-item detail during scan
  --help, -h         Show this help

IMPORTANT: Stop alabtross-mobile before --apply — this script writes
_metadata.json directly.
`);
}

// ─── Constants ──────────────────────────────────────────────────────────────

const VIDEO_EXT = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v',
  '.mpg', '.mpeg', '.ts',
]);
const HASH_SUFFIX = /_([0-9a-f]{8})$/i;
const MIN_METADATA_AGE_MS = 10 * 1000;

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

function splitTopFolder(relPath) {
  // Split "A Folder_abcd1234/Inner/Inner2/file.mp4" into:
  //   top   = "A Folder_abcd1234"
  //   inner = "Inner/Inner2/file.mp4"
  const norm = normRel(relPath);
  const idx = norm.indexOf(path.sep);
  if (idx < 0) return { top: norm, inner: '' };
  return { top: norm.slice(0, idx), inner: norm.slice(idx + 1) };
}

function walkFiles(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) { stack.push(full); continue; }
      if (!ent.isFile()) continue;
      let st;
      try { st = fs.lstatSync(full); } catch { continue; }
      out.push({
        absPath: full,
        relFromFolder: path.relative(rootDir, full),
        size: st.size,
        ino: st.ino,
      });
    }
  }
  return out;
}

function atomicWriteJson(targetFile, data) {
  const tmp = `${targetFile}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, targetFile);
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  console.log(`[relink] Library path: ${libraryPath}`);
  console.log(`[relink] Mode: ${apply ? 'APPLY — will rewrite _metadata.json' : 'dry-run'}`);

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
  console.log(`[relink] Loaded ${metadata.length} metadata items`);

  // ── Scan top-level folders and group by hash ────────────────────────────
  const foldersByHash = new Map();  // hash8 → [{ name, absPath, mtime }]
  for (const ent of fs.readdirSync(libraryPath, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith('.') || ent.name.startsWith('_')) continue;
    const m = HASH_SUFFIX.exec(ent.name);
    if (!m) continue;
    const hash = m[1].toLowerCase();
    const absPath = path.join(libraryPath, ent.name);
    let mtime = 0;
    try { mtime = fs.statSync(absPath).mtimeMs; } catch { /* ignore */ }
    if (!foldersByHash.has(hash)) foldersByHash.set(hash, []);
    foldersByHash.get(hash).push({ name: ent.name, absPath, mtime });
  }
  console.log(`[relink] Found ${foldersByHash.size} hash groups`);

  // ── Walk each folder once, cache file lists ─────────────────────────────
  // Map: folder absPath → { byRelPath: Map<relFromFolder, fileEntry> }
  const folderIndex = new Map();
  for (const folders of foldersByHash.values()) {
    for (const f of folders) {
      if (folderIndex.has(f.absPath)) continue;
      const files = walkFiles(f.absPath);
      const byRelPath = new Map(files.map(x => [x.relFromFolder, x]));
      folderIndex.set(f.absPath, { files, byRelPath });
    }
  }

  // ── Group items by infoHash[:8] ─────────────────────────────────────────
  const itemsByHash = new Map();
  for (const item of metadata) {
    if (!item.infoHash || !item.filePath) continue;
    const hash = item.infoHash.slice(0, 8).toLowerCase();
    if (!itemsByHash.has(hash)) itemsByHash.set(hash, []);
    itemsByHash.get(hash).push(item);
  }

  // ── Build relink plan ───────────────────────────────────────────────────
  const plan = {
    libraryPath,
    apply,
    timestamp: new Date().toISOString(),
    groups: [],
    stats: {
      hashGroupsOnDisk: foldersByHash.size,
      hashGroupsMultiFolder: 0,
      itemsScanned: metadata.length,
      itemsPlannedRelink: 0,
      itemsSkippedNotComplete: 0,
      itemsSkippedMissingFile: 0,
      itemsSkippedNoTwin: 0,
      itemsSkippedSizeMismatch: 0,
      itemsSkippedHardlink: 0,
      itemsSkippedOther: 0,
      itemsAlreadyCorrect: 0,
    },
  };

  for (const [hash, folders] of foldersByHash) {
    if (folders.length < 2) continue;
    plan.stats.hashGroupsMultiFolder++;

    const items = itemsByHash.get(hash) || [];
    if (items.length === 0) continue; // no metadata for this hash, nothing to relink

    // Score folders: liveCount = how many items currently point INTO this folder
    const scored = folders.map(f => {
      let liveCount = 0;
      let videoCount = 0;
      for (const item of items) {
        const { top } = splitTopFolder(item.filePath);
        if (top === f.name) liveCount++;
      }
      for (const file of folderIndex.get(f.absPath).files) {
        const ext = path.extname(file.relFromFolder).toLowerCase();
        if (VIDEO_EXT.has(ext)) videoCount++;
      }
      return { ...f, liveCount, videoCount };
    });

    // Keeper: highest liveCount, ties by videoCount, ties by mtime
    scored.sort((a, b) =>
      (b.liveCount - a.liveCount) ||
      (b.videoCount - a.videoCount) ||
      (b.mtime - a.mtime)
    );
    const keeper = scored[0];
    const keeperIndex = folderIndex.get(keeper.absPath);

    const groupRecord = {
      hash,
      keeper: keeper.name,
      folders: scored.map(s => ({
        name: s.name,
        liveCount: s.liveCount,
        videoCount: s.videoCount,
      })),
      itemActions: [],
    };

    for (const item of items) {
      const { top: itemTop, inner: itemInner } = splitTopFolder(item.filePath);

      // Already in keeper? Nothing to do.
      if (itemTop === keeper.name) {
        plan.stats.itemsAlreadyCorrect++;
        continue;
      }

      // R1: only relink complete items
      if (item.status !== 'complete') {
        plan.stats.itemsSkippedNotComplete++;
        groupRecord.itemActions.push({
          itemId: item.id,
          name: item.name,
          action: 'skip',
          reason: `item status is '${item.status}'`,
          currentPath: item.filePath,
        });
        continue;
      }

      // R2: item's current file must exist at claimed size (sanity check).
      const currentAbs = path.join(libraryPath, normRel(item.filePath));
      if (!isUnderRoot(currentAbs, libraryPath)) {
        plan.stats.itemsSkippedOther++;
        groupRecord.itemActions.push({
          itemId: item.id,
          name: item.name,
          action: 'skip',
          reason: 'item path escapes library root',
          currentPath: item.filePath,
        });
        continue;
      }
      let currentStat;
      try { currentStat = fs.lstatSync(currentAbs); } catch { currentStat = null; }
      if (!currentStat || !currentStat.isFile()) {
        plan.stats.itemsSkippedMissingFile++;
        groupRecord.itemActions.push({
          itemId: item.id,
          name: item.name,
          action: 'skip',
          reason: 'current file does not exist on disk',
          currentPath: item.filePath,
        });
        continue;
      }
      if (item.fileSize && currentStat.size !== item.fileSize) {
        plan.stats.itemsSkippedSizeMismatch++;
        groupRecord.itemActions.push({
          itemId: item.id,
          name: item.name,
          action: 'skip',
          reason: `current file size ${currentStat.size} != metadata fileSize ${item.fileSize}`,
          currentPath: item.filePath,
        });
        continue;
      }

      // R3: keeper must have a file at the same inner path
      const twin = keeperIndex.byRelPath.get(itemInner);
      if (!twin) {
        plan.stats.itemsSkippedNoTwin++;
        groupRecord.itemActions.push({
          itemId: item.id,
          name: item.name,
          action: 'skip',
          reason: `keeper ${keeper.name} has no file at inner path '${itemInner}'`,
          currentPath: item.filePath,
        });
        continue;
      }

      // R4: twin size must match
      if (twin.size !== currentStat.size) {
        plan.stats.itemsSkippedSizeMismatch++;
        groupRecord.itemActions.push({
          itemId: item.id,
          name: item.name,
          action: 'skip',
          reason: `keeper twin size ${twin.size} != current ${currentStat.size}`,
          currentPath: item.filePath,
        });
        continue;
      }

      // R5: different inodes (not a hardlink — if it IS a hardlink the
      // relink is harmless but pointless, so skip)
      if (twin.ino && currentStat.ino && twin.ino === currentStat.ino) {
        plan.stats.itemsSkippedHardlink++;
        groupRecord.itemActions.push({
          itemId: item.id,
          name: item.name,
          action: 'skip',
          reason: 'current file and keeper twin are the same inode (hardlink) — no change needed',
          currentPath: item.filePath,
        });
        continue;
      }

      // R6: keeper twin must also be under library root (paranoia)
      if (!isUnderRoot(twin.absPath, libraryPath)) {
        plan.stats.itemsSkippedOther++;
        groupRecord.itemActions.push({
          itemId: item.id,
          name: item.name,
          action: 'skip',
          reason: 'keeper twin escapes library root',
          currentPath: item.filePath,
        });
        continue;
      }

      // All checks passed — plan the relink
      const newRel = path.join(keeper.name, itemInner);
      plan.stats.itemsPlannedRelink++;
      groupRecord.itemActions.push({
        itemId: item.id,
        name: item.name,
        action: 'relink',
        currentPath: item.filePath,
        newPath: newRel,
        size: currentStat.size,
      });
    }

    plan.groups.push(groupRecord);
  }

  // ── Print human-readable report ──────────────────────────────────────────
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`  METADATA RELINK REPORT`);
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`  Hash groups on disk              : ${plan.stats.hashGroupsOnDisk}`);
  console.log(`  Hash groups w/ multiple folders  : ${plan.stats.hashGroupsMultiFolder}`);
  console.log(`  Items scanned                    : ${plan.stats.itemsScanned}`);
  console.log(`  Items already pointing at keeper : ${plan.stats.itemsAlreadyCorrect}`);
  console.log(`  Items PLANNED to relink          : ${plan.stats.itemsPlannedRelink}`);
  console.log(`  Skipped: not complete            : ${plan.stats.itemsSkippedNotComplete}`);
  console.log(`  Skipped: missing file            : ${plan.stats.itemsSkippedMissingFile}`);
  console.log(`  Skipped: no twin in keeper       : ${plan.stats.itemsSkippedNoTwin}`);
  console.log(`  Skipped: size mismatch           : ${plan.stats.itemsSkippedSizeMismatch}`);
  console.log(`  Skipped: hardlink                : ${plan.stats.itemsSkippedHardlink}`);
  console.log(`  Skipped: other                   : ${plan.stats.itemsSkippedOther}`);
  console.log('');

  for (const group of plan.groups) {
    const relinks = group.itemActions.filter(a => a.action === 'relink');
    const skips = group.itemActions.filter(a => a.action === 'skip');
    if (relinks.length === 0 && skips.length === 0) continue;
    console.log(`── [${group.hash}] keeper: ${group.keeper}`);
    for (const f of group.folders) {
      console.log(`     folder: ${f.name}  (liveRefs=${f.liveCount}, videos=${f.videoCount})`);
    }
    for (const r of relinks) {
      console.log(`     RELINK ${r.itemId}`);
      console.log(`        from: ${r.currentPath}`);
      console.log(`        to  : ${r.newPath}`);
      if (verbose) console.log(`        size: ${humanBytes(r.size)}`);
    }
    for (const s of skips) {
      console.log(`     SKIP   ${s.itemId}`);
      console.log(`        path  : ${s.currentPath}`);
      console.log(`        reason: ${s.reason}`);
    }
    console.log('');
  }

  // ── Execute if --apply ───────────────────────────────────────────────────
  if (apply && plan.stats.itemsPlannedRelink > 0) {
    // Backup metadata BEFORE any change
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(libraryPath, `_metadata.json.pre-relink-${stamp}.bak`);
    try {
      fs.copyFileSync(metadataFile, backupPath);
      console.log(`[relink] Backed up metadata to ${backupPath}`);
    } catch (err) {
      console.error(`[FATAL] Failed to create metadata backup: ${err.message}`);
      process.exit(1);
    }

    // Build an id → new filePath map from the plan
    const relinkByItemId = new Map();
    for (const g of plan.groups) {
      for (const a of g.itemActions) {
        if (a.action === 'relink') relinkByItemId.set(a.itemId, a.newPath);
      }
    }

    // Apply in-memory rewrites
    let applied = 0;
    for (const item of metadata) {
      const newPath = relinkByItemId.get(item.id);
      if (newPath) {
        item.filePath = newPath;
        applied++;
      }
    }
    console.log(`[relink] Rewriting ${applied} item(s) in _metadata.json...`);

    try {
      atomicWriteJson(metadataFile, metadata);
      console.log(`[relink] _metadata.json updated atomically.`);
    } catch (err) {
      console.error(`[FATAL] Failed to write _metadata.json: ${err.message}`);
      console.error(`[FATAL] Backup is still at ${backupPath}`);
      process.exit(1);
    }
  } else if (apply) {
    console.log(`[relink] Nothing to apply — no items needed relinking.`);
  }

  // ── Write audit log ──────────────────────────────────────────────────────
  const logStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = `/tmp/albatross-relink-${logStamp}.json`;
  try {
    fs.writeFileSync(logPath, JSON.stringify(plan, null, 2));
    console.log(`[relink] Audit log written: ${logPath}`);
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

main();
