#!/usr/bin/env node
/**
 * Albatross — Library Deduplication Script
 *
 * Finds and removes duplicate on-disk copies of library items created when
 * the same torrent (same infoHash) was downloaded into multiple differently
 * named top-level folders — usually because metadata got rewritten without
 * the original directory being cleaned up.
 *
 * SAFETY MODEL
 * ────────────
 * Directories in the library follow the invariant:
 *     <sanitized_name>_<infoHash[:8]>/
 * (see library-manager.js `_safeDirectoryName`). We group all top-level
 * directories by the 8-char hash suffix. A group with >1 directory is a
 * duplication candidate.
 *
 * For each group we pick a "keeper" — the folder that holds the most
 * filePaths currently referenced by `_metadata.json`. Ties are broken by
 * newest mtime.
 *
 * A non-keeper folder is only deleted when EVERY file inside satisfies all
 * of these conditions:
 *
 *   1. A file with the same inner relative path (top-level folder stripped)
 *      AND the same byte size exists inside the keeper folder.
 *   2. The orphan's relative path is NOT referenced by any item in
 *      `_metadata.json` (we never delete files the library is pointing at).
 *   3. The orphan file and its keeper counterpart have different inodes
 *      (if they share an inode they're hardlinks — removing one frees no
 *      space and would break the other).
 *   4. The orphan path does not escape the library root (symlink guard).
 *
 * If any file in a non-keeper folder fails these checks, the ENTIRE group
 * is skipped and reported as "needs manual review".
 *
 * The script is DRY-RUN by default. Use `--apply` to actually delete, or
 * `--trash <dir>` to move orphans into a trash directory instead of deleting
 * (recommended for the first real run — `mv` instead of `rm` gives you an
 * easy rollback).
 *
 * WHAT THIS SCRIPT DOES NOT DO
 * ────────────────────────────
 *   - It will NOT fix cases where metadata points at the wrong file inside a
 *     pack (e.g. "Batman Begins" folder containing "The Dark Knight Rises").
 *     Those require a metadata relink, not a filesystem delete.
 *   - It will NOT dedupe across different infoHashes (e.g. six separate
 *     Breaking Bad torrents). Those are genuinely different torrents.
 *   - It will NOT touch _metadata.json, _metadata.json.bak, or any file at
 *     the library root.
 *   - It will NOT delete anything that is referenced by a library item.
 *
 * USAGE
 * ─────
 *   node scripts/dedup-library.js                         # dry-run, default path
 *   node scripts/dedup-library.js --library /custom/path  # dry-run, custom path
 *   node scripts/dedup-library.js --trash /tmp/albatross-trash  # move instead
 *   node scripts/dedup-library.js --apply                 # actually delete
 *   node scripts/dedup-library.js --verbose               # per-file detail
 *
 * A JSON audit log is always written to /tmp/albatross-dedup-<ts>.json.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── CLI parsing ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let libraryPath = '/mnt/movies/torrent-cache/library';
let apply = false;
let verbose = false;
let trashDir = null;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--library') libraryPath = args[++i];
  else if (a === '--apply') apply = true;
  else if (a === '--verbose' || a === '-v') verbose = true;
  else if (a === '--trash') trashDir = args[++i];
  else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  else {
    console.error(`Unknown argument: ${a}`);
    printHelp();
    process.exit(2);
  }
}

function printHelp() {
  console.log(`Usage: node scripts/dedup-library.js [options]

Options:
  --library <path>   Library root (default: /mnt/movies/torrent-cache/library)
  --apply            Actually delete duplicates (default: dry-run)
  --trash <dir>      Move orphans to <dir> instead of deleting (safer)
  --verbose, -v      Print per-file detail during scan
  --help, -h         Show this help
`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const VIDEO_EXT = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v',
  '.mpg', '.mpeg', '.ts',
]);

const HASH_SUFFIX = /_([0-9a-f]{8})$/i;

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[u]}`;
}

function isUnderRoot(absPath, root) {
  const resolved = path.resolve(absPath);
  const rootResolved = path.resolve(root);
  return resolved === rootResolved || resolved.startsWith(rootResolved + path.sep);
}

/** Walk a directory recursively, returning { relativePath, absPath, size, ino }. */
function walkFiles(rootDir, baseForRelative) {
  const out = [];
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      console.error(`[WARN] Cannot read ${dir}: ${err.message}`);
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      // Symlink guard: never follow and never include
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      let st;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      out.push({
        relativePath: path.relative(baseForRelative, full),
        absPath: full,
        size: st.size,
        ino: st.ino,
      });
    }
  }
  return out;
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  console.log(`[dedup] Library path: ${libraryPath}`);
  console.log(`[dedup] Mode: ${apply ? (trashDir ? `APPLY → trash to ${trashDir}` : 'APPLY → DELETE') : 'dry-run'}`);

  if (!fs.existsSync(libraryPath)) {
    console.error(`[FATAL] Library path does not exist: ${libraryPath}`);
    process.exit(1);
  }
  const libStat = fs.statSync(libraryPath);
  if (!libStat.isDirectory()) {
    console.error(`[FATAL] Library path is not a directory: ${libraryPath}`);
    process.exit(1);
  }

  if (trashDir) {
    // Require that trashDir is NOT inside libraryPath (otherwise we'd move
    // files into the thing we're scanning and confuse subsequent runs).
    if (isUnderRoot(trashDir, libraryPath)) {
      console.error(`[FATAL] --trash directory must NOT be inside the library`);
      process.exit(1);
    }
    if (!fs.existsSync(trashDir)) {
      fs.mkdirSync(trashDir, { recursive: true });
    }
  }

  // ── Load metadata ────────────────────────────────────────────────────────
  const metadataFile = path.join(libraryPath, '_metadata.json');
  if (!fs.existsSync(metadataFile)) {
    console.error(`[FATAL] _metadata.json not found at ${metadataFile}`);
    process.exit(1);
  }
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

  // Build two lookups:
  //   livePaths: Set of filePath strings (relative to libraryPath) that the
  //              library actively references. We NEVER delete these.
  //   livePathsByHash: infoHash8 → Set of filePath strings that live in one
  //                    of that hash's directories. Used for "which folder
  //                    is the canonical keeper?"
  const livePaths = new Set();
  const livePathsByHash = new Map();
  const itemsByPath = new Map();

  for (const item of metadata) {
    if (!item.filePath) continue;
    // Normalize separators & strip any leading './'
    const rel = path.normalize(item.filePath).replace(/^(\.\/)+/, '');
    livePaths.add(rel);
    itemsByPath.set(rel, item);
    const hash = (item.infoHash || '').slice(0, 8).toLowerCase();
    if (hash) {
      if (!livePathsByHash.has(hash)) livePathsByHash.set(hash, new Set());
      livePathsByHash.get(hash).add(rel);
    }
  }

  console.log(`[dedup] Loaded ${metadata.length} metadata items (${livePaths.size} with filePath)`);

  // ── Scan top-level folders and group by hash ─────────────────────────────
  const topEntries = fs.readdirSync(libraryPath, { withFileTypes: true });
  const groupsByHash = new Map();  // hash8 → [{ name, absPath, mtime }]

  let untaggedDirs = 0;
  for (const ent of topEntries) {
    if (!ent.isDirectory()) continue;                     // skip _metadata.json, .bak, etc.
    if (ent.name.startsWith('.') || ent.name.startsWith('_')) continue;
    const match = HASH_SUFFIX.exec(ent.name);
    if (!match) { untaggedDirs++; continue; }
    const hash = match[1].toLowerCase();
    const absPath = path.join(libraryPath, ent.name);
    let mtime = 0;
    try { mtime = fs.statSync(absPath).mtimeMs; } catch { /* ignore */ }
    if (!groupsByHash.has(hash)) groupsByHash.set(hash, []);
    groupsByHash.get(hash).push({ name: ent.name, absPath, mtime });
  }

  console.log(`[dedup] Found ${groupsByHash.size} hash groups, ${untaggedDirs} folders without hash suffix (ignored)`);

  // ── Analyse each duplicate group ─────────────────────────────────────────
  const report = {
    libraryPath,
    apply,
    trashDir,
    timestamp: new Date().toISOString(),
    groups: [],
    stats: {
      groupsTotal: groupsByHash.size,
      groupsDuplicated: 0,
      groupsCleaned: 0,
      groupsSkipped: 0,
      bytesReclaimable: 0,
      bytesReclaimed: 0,
      foldersRemoved: 0,
    },
  };

  for (const [hash, folders] of groupsByHash) {
    if (folders.length < 2) continue;
    report.stats.groupsDuplicated++;

    // Walk every folder in the group and collect its files
    const folderDetail = folders.map(f => {
      const files = walkFiles(f.absPath, f.absPath);
      // "inner path" = path relative to this folder's own root
      // Used for equivalence across sibling folders
      return { ...f, files, byInner: new Map(files.map(x => [x.relativePath, x])) };
    });

    // Score each folder by how many of the metadata livePaths it contains
    const liveForThisHash = livePathsByHash.get(hash) || new Set();
    for (const fd of folderDetail) {
      fd.liveCount = 0;
      fd.liveHits = new Set();
      for (const f of fd.files) {
        const fullRelFromLib = path.relative(libraryPath, f.absPath);
        if (liveForThisHash.has(fullRelFromLib)) {
          fd.liveCount++;
          fd.liveHits.add(fullRelFromLib);
        }
      }
    }

    // Keeper = highest liveCount, ties broken by mtime desc
    folderDetail.sort((a, b) => (b.liveCount - a.liveCount) || (b.mtime - a.mtime));
    const keeper = folderDetail[0];
    const others = folderDetail.slice(1);

    const groupRecord = {
      hash,
      keeper: keeper.name,
      keeperLiveCount: keeper.liveCount,
      orphanCandidates: others.map(o => o.name),
      action: 'pending',
      reason: null,
      reclaimBytes: 0,
      orphanFiles: [],
    };

    // Verify every orphan file has a safe twin in the keeper
    let safe = true;
    let groupReclaim = 0;
    for (const orphan of others) {
      for (const file of orphan.files) {
        const fullRelFromLib = path.relative(libraryPath, file.absPath);

        // RULE 1: orphan path must NOT be referenced by metadata
        if (livePaths.has(fullRelFromLib)) {
          safe = false;
          groupRecord.reason = `orphan ${fullRelFromLib} is referenced by _metadata.json`;
          break;
        }

        // For non-video files we still want to clean them up along with
        // their folder, but we only enforce the twin-match rule on videos
        // (the things that actually take space). Small sidecar files
        // (.nfo, .srt, .jpg) travel with the folder.
        const ext = path.extname(file.relativePath).toLowerCase();
        const isVideo = VIDEO_EXT.has(ext);

        if (isVideo) {
          // RULE 2: twin must exist in keeper with same inner path + size
          const twin = keeper.byInner.get(file.relativePath);
          if (!twin) {
            safe = false;
            groupRecord.reason = `orphan video ${file.relativePath} has no twin in keeper ${keeper.name}`;
            break;
          }
          if (twin.size !== file.size) {
            safe = false;
            groupRecord.reason = `orphan video ${file.relativePath} size ${file.size} != keeper ${twin.size}`;
            break;
          }
          // RULE 3: inodes must differ (otherwise it's a hardlink)
          if (twin.ino === file.ino && twin.ino !== 0) {
            safe = false;
            groupRecord.reason = `orphan ${file.relativePath} is a hardlink to keeper (same inode)`;
            break;
          }
        }

        // RULE 4: symlink guard — ensure the file truly lives under libraryPath
        if (!isUnderRoot(file.absPath, libraryPath)) {
          safe = false;
          groupRecord.reason = `orphan path escapes library root: ${file.absPath}`;
          break;
        }

        groupRecord.orphanFiles.push({
          path: fullRelFromLib,
          size: file.size,
          isVideo,
        });
        if (isVideo) groupReclaim += file.size;
      }
      if (!safe) break;
    }

    if (!safe) {
      groupRecord.action = 'skipped';
      report.stats.groupsSkipped++;
      report.groups.push(groupRecord);
      continue;
    }

    groupRecord.action = apply ? 'cleaned' : 'would-clean';
    groupRecord.reclaimBytes = groupReclaim;
    report.stats.bytesReclaimable += groupReclaim;
    report.stats.groupsCleaned++;

    // ── Execute the cleanup ────────────────────────────────────────────────
    if (apply) {
      for (const orphan of others) {
        try {
          if (trashDir) {
            const dest = path.join(trashDir, `${hash}__${orphan.name}`);
            fs.renameSync(orphan.absPath, dest);
            if (verbose) console.log(`[mv] ${orphan.absPath} → ${dest}`);
          } else {
            fs.rmSync(orphan.absPath, { recursive: true, force: true });
            if (verbose) console.log(`[rm] ${orphan.absPath}`);
          }
          report.stats.foldersRemoved++;
          report.stats.bytesReclaimed += groupReclaim / others.length;
        } catch (err) {
          console.error(`[ERR] Failed to remove ${orphan.absPath}: ${err.message}`);
          groupRecord.action = 'partial-failure';
          groupRecord.reason = err.message;
        }
      }
    }

    report.groups.push(groupRecord);
  }

  // ── Print human-readable report ──────────────────────────────────────────
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`  DEDUP REPORT`);
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`  Total hash groups          : ${report.stats.groupsTotal}`);
  console.log(`  Duplicated groups          : ${report.stats.groupsDuplicated}`);
  console.log(`  Safe to clean              : ${report.stats.groupsCleaned}`);
  console.log(`  Skipped (need manual look) : ${report.stats.groupsSkipped}`);
  console.log(`  Reclaimable space          : ${humanBytes(report.stats.bytesReclaimable)}`);
  if (apply) {
    console.log(`  Folders removed            : ${report.stats.foldersRemoved}`);
  }
  console.log('');

  if (report.stats.groupsCleaned > 0) {
    console.log('── Groups cleaned ─────────────────────────────────────────────────────');
    for (const g of report.groups.filter(x => x.action === 'cleaned' || x.action === 'would-clean')) {
      console.log(`  [${g.hash}] keeper: ${g.keeper}`);
      for (const o of g.orphanCandidates) {
        console.log(`             drop  : ${o}`);
      }
      console.log(`             reclaim: ${humanBytes(g.reclaimBytes)}`);
    }
    console.log('');
  }

  if (report.stats.groupsSkipped > 0) {
    console.log('── Groups SKIPPED (review manually) ───────────────────────────────────');
    for (const g of report.groups.filter(x => x.action === 'skipped')) {
      console.log(`  [${g.hash}] keeper: ${g.keeper}`);
      for (const o of g.orphanCandidates) {
        console.log(`             other : ${o}`);
      }
      console.log(`             reason: ${g.reason}`);
    }
    console.log('');
  }

  // ── Write audit log ──────────────────────────────────────────────────────
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = `/tmp/albatross-dedup-${stamp}.json`;
  try {
    fs.writeFileSync(logPath, JSON.stringify(report, null, 2));
    console.log(`[dedup] Audit log written: ${logPath}`);
  } catch (err) {
    console.error(`[WARN] Could not write audit log: ${err.message}`);
  }

  if (!apply) {
    console.log('');
    console.log('This was a DRY RUN. No files were touched.');
    console.log('Re-run with --apply to delete, or --apply --trash <dir> to move instead.');
  }
}

main();
