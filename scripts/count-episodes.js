#!/usr/bin/env node
/**
 * Albatross — Episode Count by State
 *
 * Reads the library's _metadata.json and reports how many episodes live on
 * the drive, grouped by their current `status` field
 * (complete / downloading / queued / converting / paused / failed / …).
 *
 * An "episode" is any library item with `type === 'series'` that has a
 * concrete season or episode number. Series-level aggregate items and
 * movies are excluded from the count.
 *
 * Usage:
 *   node scripts/count-episodes.js                      # default library path
 *   node scripts/count-episodes.js --library /path      # custom library root
 *   node scripts/count-episodes.js --json               # machine-readable output
 *
 * Typical SSH invocation from your laptop:
 *   ssh albatross 'node ~/Alabtross-Streaming/scripts/count-episodes.js'
 */

'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let libraryPath = '/mnt/movies/torrent-cache/library';
let jsonOut = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--library') libraryPath = args[++i];
  else if (a === '--json') jsonOut = true;
  else if (a === '-h' || a === '--help') {
    console.log('Usage: node scripts/count-episodes.js [--library <path>] [--json]');
    process.exit(0);
  } else {
    console.error(`Unknown argument: ${a}`);
    process.exit(2);
  }
}

const metadataFile = path.join(libraryPath, '_metadata.json');
if (!fs.existsSync(metadataFile)) {
  console.error(`[count-episodes] _metadata.json not found at ${metadataFile}`);
  process.exit(1);
}

let metadata;
try {
  metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
} catch (err) {
  console.error(`[count-episodes] Failed to parse _metadata.json: ${err.message}`);
  process.exit(1);
}
if (!Array.isArray(metadata)) {
  console.error('[count-episodes] _metadata.json is not an array');
  process.exit(1);
}

const episodes = metadata.filter(
  item => item && item.type === 'series' && (item.episode != null || item.season != null)
);

const byStatus = new Map();
for (const ep of episodes) {
  const status = ep.status || 'unknown';
  byStatus.set(status, (byStatus.get(status) || 0) + 1);
}

if (jsonOut) {
  process.stdout.write(
    JSON.stringify(
      {
        libraryPath,
        totalEpisodes: episodes.length,
        byStatus: Object.fromEntries(byStatus),
      },
      null,
      2
    ) + '\n'
  );
  process.exit(0);
}

console.log('── Albatross Episode Count ──');
console.log(`Library       : ${libraryPath}`);
console.log(`Total episodes: ${episodes.length}`);
console.log('');
console.log('By state:');
const rows = [...byStatus.entries()].sort((a, b) => b[1] - a[1]);
if (rows.length === 0) {
  console.log('  (no episodes found)');
} else {
  for (const [status, count] of rows) {
    console.log(`  ${status.padEnd(14)} ${String(count).padStart(6)}`);
  }
}
