#!/usr/bin/env node
/**
 * Albatross — Download Bottleneck Diagnostic
 *
 * Hits the server's /api/diagnostics/system endpoint and pretty-prints:
 *   • the bottleneck hint
 *   • host CPU / memory / NIC rx+tx / disk I/O
 *   • the gap between host NIC rx and torrent-accounted throughput
 *     (a big gap usually means a stream-playback engine is pulling
 *      bytes that don't show up in the Downloads panel)
 *   • a per-engine table sorted by speed, with download + upload columns
 *
 * One row per *real* torrent-stream engine, not per library item: a pack
 * engine shared by 55 episodes shows up as a single row tagged with the
 * currently-active file and the number of queued episodes, so the peer
 * count reflects the actual swarm.
 *
 * Usage:
 *   node scripts/diag-downloads.js                  # http://localhost:8080
 *   node scripts/diag-downloads.js --host 1.2.3.4
 *   node scripts/diag-downloads.js --port 8081
 *   node scripts/diag-downloads.js --ms 2000        # sample window (200-5000)
 *   node scripts/diag-downloads.js --json           # raw payload, no formatting
 *   node scripts/diag-downloads.js --watch          # re-sample every 3s
 *
 * Exits non-zero if the server is unreachable or returns an error.
 */

'use strict';

function parseArgs(argv) {
  const out = {
    host: process.env.ALBATROSS_HOST || 'localhost',
    port: parseInt(process.env.PORT, 10) || 8080,
    ms: 1000,
    json: false,
    watch: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') out.host = argv[++i];
    else if (a === '--port') out.port = parseInt(argv[++i], 10);
    else if (a === '--ms') out.ms = parseInt(argv[++i], 10);
    else if (a === '--json') out.json = true;
    else if (a === '--watch') out.watch = true;
    else if (a === '-h' || a === '--help') {
      process.stdout.write(
        'Usage: diag-downloads.js [--host H] [--port P] [--ms N] [--json] [--watch]\n'
      );
      process.exit(0);
    }
  }
  return out;
}

function fmtBps(bps) {
  if (!bps || bps < 1) return '    0 B/s';
  if (bps < 1024) return `${bps.toFixed(0).padStart(5)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1).padStart(5)} KB/s`;
  if (bps < 1024 * 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(2).padStart(5)} MB/s`;
  return `${(bps / 1024 / 1024 / 1024).toFixed(2).padStart(5)} GB/s`;
}

function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return '  ?';
  return `${n.toFixed(0).padStart(3)}%`;
}

function truncate(s, n) {
  s = String(s || '');
  return s.length <= n ? s.padEnd(n) : s.slice(0, n - 1) + '…';
}

function hintColor(hint) {
  if (!hint) return '';
  const isErr = /cpu_bound|memory_pressure|host_has_headroom/.test(hint);
  const isWarn = /swarm_or_protocol|network_or_swarm/.test(hint);
  if (isErr) return '\x1b[31m'; // red
  if (isWarn) return '\x1b[33m'; // yellow
  return '\x1b[32m'; // green
}
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

async function fetchDiag({ host, port, ms }) {
  const url = `http://${host}:${port}/api/diagnostics/system?ms=${ms}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  return res.json();
}

function render(d) {
  const lines = [];
  const hint = d.hint || 'unknown';
  const c = hintColor(hint);

  lines.push(`${BOLD}── Albatross Download Diagnostic ──${RESET}  (sampled ${d.sampleMs}ms)`);
  lines.push('');
  lines.push(`${BOLD}Bottleneck${RESET}: ${c}${hint}${RESET}`);
  lines.push('');

  // Host
  const h = d.host || {};
  const cpu = h.cpu || {};
  const mem = h.memory || {};
  lines.push(`${BOLD}Host${RESET}`);
  lines.push(
    `  cpu    ${fmtPct(cpu.usagePct)}` +
      (cpu.loadAvg ? `   load ${cpu.loadAvg.map(n => n.toFixed(2)).join(' ')}` : '')
  );
  lines.push(`  memory ${fmtPct(mem.usedPct)}`);
  lines.push(`  net    rx ${fmtBps(h.totalNetRxBps)}   tx ${fmtBps(h.totalNetTxBps)}`);
  lines.push(
    `  disk   rd ${fmtBps(h.totalDiskReadBps)}   wr ${fmtBps(h.totalDiskWriteBps)}`
  );
  lines.push('');

  // Accounted-vs-host gap. This is the key number for "UI says X, device says Y".
  const t = d.torrents || {};
  const acc = t.totalDownloadBps || 0;
  const up = t.totalUploadBps || 0;
  const rx = h.totalNetRxBps || 0;
  const gap = Math.max(0, rx - acc);
  const accountedPct = rx > 0 ? (acc / rx) * 100 : null;

  lines.push(`${BOLD}Torrents${RESET}  (${t.active || 0} engines, ${t.totalPeers || 0} peers total)`);
  lines.push(`  down accounted: ${fmtBps(acc)}`);
  lines.push(`  up accounted:   ${fmtBps(up)}`);
  lines.push(`  host nic rx:    ${fmtBps(rx)}`);
  lines.push(
    `  unaccounted:    ${fmtBps(gap)}` +
      (accountedPct != null ? `   ${DIM}(${accountedPct.toFixed(0)}% of rx attributed to torrents)${RESET}` : '')
  );
  if (gap > 500 * 1024 && gap > acc * 0.5) {
    lines.push(
      `  ${c}⚠ large gap — likely a stream-playback engine is pulling bytes not shown in Downloads UI,${RESET}`
    );
    lines.push(
      `  ${c}  or another process on the host is using the NIC (check with: iftop / nethogs)${RESET}`
    );
  }
  lines.push('');

  // Per-engine table — one row per real torrent-stream engine.
  // Sort primarily by download speed, then by upload speed so seeding-only
  // engines still bubble up above fully idle ones.
  const rows = (t.perEngine || []).slice().sort((a, b) => {
    const d1 = (b.downloadBps || 0) - (a.downloadBps || 0);
    if (d1 !== 0) return d1;
    return (b.uploadBps || 0) - (a.uploadBps || 0);
  });
  if (rows.length === 0) {
    lines.push(`${DIM}(no active engines)${RESET}`);
  } else {
    lines.push(`${BOLD}Per-engine${RESET}`);
    lines.push(
      `  ${'source'.padEnd(8)} ${'name'.padEnd(42)} ${'down'.padStart(10)}  ${'up'.padStart(10)}  ${'peers'.padStart(5)}  items`
    );
    lines.push(
      `  ${DIM}${'-'.repeat(8)} ${'-'.repeat(42)} ${'-'.repeat(10)}  ${'-'.repeat(10)}  ${'-'.repeat(5)}  -----${RESET}`
    );
    for (const row of rows) {
      const label = row.isPack && row.itemCount > 1
        ? `${row.name} [${row.downloadingCount}/${row.itemCount}]`
        : row.name;
      const itemsCol = row.isPack
        ? `${row.downloadingCount || 0}dl/${row.completeCount || 0}ok/${row.itemCount || 0}`
        : '-';
      lines.push(
        `  ${truncate(row.source, 8)} ${truncate(label, 42)} ${fmtBps(row.downloadBps).padStart(10)}  ${fmtBps(row.uploadBps).padStart(10)}  ${String(row.peers || 0).padStart(5)}  ${itemsCol}`
      );
      if (row.isPack && row.activeFileName) {
        lines.push(`  ${DIM}${' '.repeat(9)}→ ${truncate(row.activeFileName, 72)}${RESET}`);
      }
    }
  }

  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);

  const runOnce = async () => {
    const d = await fetchDiag(args);
    if (args.json) {
      process.stdout.write(JSON.stringify(d, null, 2) + '\n');
    } else {
      // Clear screen in watch mode for a cleaner refresh.
      if (args.watch) process.stdout.write('\x1b[2J\x1b[H');
      process.stdout.write(render(d) + '\n');
    }
  };

  try {
    await runOnce();
    if (args.watch) {
      // Re-sample every 3s. The endpoint itself samples for `ms` ms,
      // so actual cadence is ~ms + 3000ms.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await new Promise(r => setTimeout(r, 3000));
        try {
          await runOnce();
        } catch (e) {
          process.stderr.write(`[diag] ${e.message}\n`);
        }
      }
    }
  } catch (e) {
    process.stderr.write(`[diag] failed: ${e.message}\n`);
    process.stderr.write(
      `[diag] is the server running on http://${args.host}:${args.port}?\n`
    );
    process.exit(1);
  }
}

main();
