/**
 * Albatross — System Diagnostics
 *
 * Samples CPU / memory / disk / network utilization over a short window
 * so the operator can figure out which system resource (if any) is capping
 * torrent throughput. Linux-only for disk/network (reads /proc); on other
 * platforms those fields come back empty and CPU+memory still work.
 */

const os = require('os');
const fs = require('fs');

function cpuSnapshot() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

function readProcNetDev() {
  try {
    const raw = fs.readFileSync('/proc/net/dev', 'utf8');
    const result = {};
    // First two lines are headers.
    for (const line of raw.split('\n').slice(2)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [nameWithColon, rest] = trimmed.split(/:\s*/, 2);
      if (!rest) continue;
      const iface = nameWithColon.trim();
      if (iface === 'lo') continue;
      const fields = rest.split(/\s+/);
      // Receive: bytes packets errs drop fifo frame compressed multicast
      // Transmit: bytes packets errs drop fifo colls carrier compressed
      const rxBytes = parseInt(fields[0], 10);
      const txBytes = parseInt(fields[8], 10);
      if (Number.isFinite(rxBytes) && Number.isFinite(txBytes)) {
        result[iface] = { rxBytes, txBytes };
      }
    }
    return result;
  } catch {
    return null;
  }
}

function readProcDiskstats() {
  try {
    const raw = fs.readFileSync('/proc/diskstats', 'utf8');
    const result = {};
    for (const line of raw.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 14) continue;
      const name = parts[2];
      // Skip pseudo-devices and partitions we don't care about.
      if (name.startsWith('loop') || name.startsWith('ram') || name.startsWith('dm-')) continue;
      // /proc/diskstats: [major minor name reads_completed reads_merged sectors_read ms_reading writes_completed ...]
      // sectors_read = parts[5], sectors_written = parts[9], sector size = 512 bytes
      const sectorsRead = parseInt(parts[5], 10);
      const sectorsWritten = parseInt(parts[9], 10);
      if (!Number.isFinite(sectorsRead) || !Number.isFinite(sectorsWritten)) continue;
      result[name] = {
        bytesRead: sectorsRead * 512,
        bytesWritten: sectorsWritten * 512,
      };
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * Sample system utilization over `sampleMs` milliseconds.
 * Returns CPU %, load average, memory, per-interface net rates,
 * per-device disk rates.
 */
async function getSystemDiag(sampleMs = 1000) {
  const tsBefore = Date.now();
  const cpuBefore = cpuSnapshot();
  const netBefore = readProcNetDev();
  const diskBefore = readProcDiskstats();

  await new Promise(r => setTimeout(r, sampleMs));

  const cpuAfter = cpuSnapshot();
  const netAfter = readProcNetDev();
  const diskAfter = readProcDiskstats();
  const elapsedSec = Math.max(0.001, (Date.now() - tsBefore) / 1000);

  const idleDelta = cpuAfter.idle - cpuBefore.idle;
  const totalDelta = cpuAfter.total - cpuBefore.total;
  const cpuUsagePct = totalDelta > 0
    ? Math.round(100 * (1 - idleDelta / totalDelta))
    : 0;

  const network = {};
  if (netBefore && netAfter) {
    for (const iface of Object.keys(netAfter)) {
      const before = netBefore[iface];
      const after = netAfter[iface];
      if (!before) continue;
      const rx = Math.max(0, Math.round((after.rxBytes - before.rxBytes) / elapsedSec));
      const tx = Math.max(0, Math.round((after.txBytes - before.txBytes) / elapsedSec));
      if (rx === 0 && tx === 0) continue; // hide silent interfaces
      network[iface] = { rxBytesPerSec: rx, txBytesPerSec: tx };
    }
  }

  const disk = {};
  if (diskBefore && diskAfter) {
    for (const dev of Object.keys(diskAfter)) {
      const before = diskBefore[dev];
      const after = diskAfter[dev];
      if (!before) continue;
      const read = Math.max(0, Math.round((after.bytesRead - before.bytesRead) / elapsedSec));
      const write = Math.max(0, Math.round((after.bytesWritten - before.bytesWritten) / elapsedSec));
      if (read === 0 && write === 0) continue;
      disk[dev] = { readBytesPerSec: read, writeBytesPerSec: write };
    }
  }

  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  return {
    sampleMs,
    cpu: {
      usagePct: cpuUsagePct,
      loadAvg: os.loadavg().map(n => +n.toFixed(2)),
      cores: os.cpus().length,
    },
    memory: {
      totalBytes: totalMem,
      freeBytes: freeMem,
      usedPct: Math.round(100 * (1 - freeMem / totalMem)),
    },
    network,  // may be {} on non-Linux
    disk,     // may be {} on non-Linux
    platform: process.platform,
  };
}

module.exports = { getSystemDiag };
