/**
 * Albatross — Cross-torrent Peer Reputation
 *
 * Peers on the public BitTorrent swarm typically serve many torrents at
 * once. A peer that wasted our connection slot on torrent A (handshook
 * and never delivered a block, or never handshook at all) is the same
 * peer that will waste our slot on torrent B five minutes later — but
 * PeerManager's ban list lives per-engine, so the lesson is lost every
 * time we start a fresh download. Same for the inverse: a peer that
 * reliably delivered bytes on torrent A is a great first choice when
 * torrent B starts up.
 *
 * PeerReputation is a process-wide scoring map keyed by "ip:port":
 *
 *   { goodBytes, strikes, lastSeenAt }
 *
 * `goodBytes`   — lifetime bytes this peer has delivered to us.
 * `strikes`     — count of bans / failures recorded by PeerManager.
 * `lastSeenAt`  — ms timestamp of the last record update, used for
 *                 decay (entries older than ENTRY_MAX_AGE_MS are dropped
 *                 on load / save so IP reassignment doesn't permanently
 *                 pin stale bans on addresses that have changed hands).
 *
 * The map is persisted to `<cacheDir>/peer-reputation.json` on shutdown
 * and every ~5 min while running. Size-capped at MAX_ENTRIES with LRU
 * eviction so a long-running server can't grow the file forever.
 *
 * Two primary consumers:
 *   - PeerManager calls `recordDelivery` / `recordStrike` as wires
 *     close or ban thresholds are hit.
 *   - LibraryManager calls `knownBadIps()` before each new engine is
 *     created, so the engine pre-blocks IPs that have a bad history
 *     before wasting connection slots on them, and `topGoodAddrs()`
 *     to jumpstart the swarm with peers that have a proven track record.
 */

const fs = require('fs');
const path = require('path');

// Drop entries whose last update is older than this. IP addresses churn
// (DHCP, residential NAT re-assignment, mobile); a peer banned a month
// ago may be an entirely different machine today. 14 days is a compromise
// between "learn from recent misbehavior" and "don't pin permanent bans".
const ENTRY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// Per-IP strike count at which we pre-block the peer on every new engine.
// 3 means the peer has failed us on three separate occasions before it's
// considered bad — under a single-engine 2-strike ban threshold this can
// reasonably only accumulate across torrents.
const PREBLOCK_STRIKE_THRESHOLD = 3;

// Minimum delivered-bytes to count a peer as "good" for the priming list.
// Below this a peer might just have handshook and flushed a bitfield.
// 256 KiB filters out the dust while still being easy to accumulate on
// a healthy peer.
const GOOD_BYTES_THRESHOLD = 256 * 1024;

// Cap on map size. 10 000 entries at ~80 B each is < 1 MB in memory and
// < 1 MB on disk — trivial for a Jetson. LRU-evict the oldest-updated
// entry to stay under the cap.
const MAX_ENTRIES = 10_000;

// How often to flush the in-memory map to disk. Saving on every record
// update would thrash eMMC; the 5 min debounce keeps I/O bounded while
// losing at most a few minutes of reputation on an abrupt restart.
const PERSIST_INTERVAL_MS = 5 * 60 * 1000;

// Extract "ip" from "ip:port". Entries are stored by "ip:port" because
// peer-wire's block() is port-agnostic but our reputation scoring is
// against the exact (ip, port) pair we last saw. For pre-blocking we
// return IPs only, so a misbehaving port on a peer doesn't ban the
// whole box — PeerManager already aggregates by IP when calling block().
function ipOf(addr) {
  if (typeof addr !== 'string') return null;
  const i = addr.lastIndexOf(':');
  if (i <= 0) return null;
  return addr.slice(0, i);
}

class PeerReputation {
  /**
   * @param {object} opts
   * @param {string} opts.cacheDir - directory to load/save reputation JSON from
   */
  constructor(opts = {}) {
    this._cacheDir = opts.cacheDir || '.';
    this._file = path.join(this._cacheDir, 'peer-reputation.json');
    this._entries = new Map(); // addr -> { goodBytes, strikes, lastSeenAt }
    this._persistTimer = null;
    this._dirty = false;

    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this._file)) return;
      const raw = fs.readFileSync(this._file, 'utf8');
      if (!raw.trim()) return;
      const data = JSON.parse(raw);
      if (!data || typeof data.entries !== 'object') return;
      const now = Date.now();
      let kept = 0, dropped = 0;
      for (const [addr, entry] of Object.entries(data.entries)) {
        if (!entry || typeof entry !== 'object') { dropped++; continue; }
        const lastSeenAt = Number(entry.lastSeenAt) || 0;
        if (!lastSeenAt || now - lastSeenAt > ENTRY_MAX_AGE_MS) { dropped++; continue; }
        this._entries.set(addr, {
          goodBytes: Math.max(0, Number(entry.goodBytes) || 0),
          strikes: Math.max(0, Number(entry.strikes) || 0),
          lastSeenAt,
        });
        kept++;
      }
      if (kept || dropped) {
        console.log(`[PeerReputation] loaded ${kept} entries (dropped ${dropped} stale) from ${this._file}`);
      }
    } catch (err) {
      console.warn(`[PeerReputation] load failed: ${err.message} — starting fresh`);
      this._entries.clear();
    }
  }

  /**
   * Flush the in-memory map to disk. Returns a Promise that resolves
   * once the bytes are durable. Atomic: write to .tmp, rename over.
   * An abrupt crash during the write leaves the previous snapshot
   * intact. Concurrent callers coalesce: a save in flight + new
   * mutations marks a single follow-up so we don't queue up multiple
   * full writes back-to-back.
   *
   * Now async (fs.promises) so the write runs on the libuv threadpool
   * instead of blocking the event loop. The previous sync writeFile +
   * rename interleaved with library metadata writes and the HTTP
   * stream handlers' fs.promises.stat calls, which is enough to
   * cause sub-second event-loop pauses on slow storage.
   */
  async save() {
    if (!this._dirty) return;
    if (this._saveInFlight) {
      this._saveQueued = true;
      return this._saveInFlight;
    }

    const doSave = async () => {
      this._dirty = false;
      this._expireStale();
      try {
        await fs.promises.mkdir(this._cacheDir, { recursive: true });
        const out = { version: 1, savedAt: Date.now(), entries: {} };
        for (const [addr, entry] of this._entries) out.entries[addr] = entry;
        const tmp = this._file + '.tmp';
        await fs.promises.writeFile(tmp, JSON.stringify(out));
        await fs.promises.rename(tmp, this._file);
      } catch (err) {
        // A failed write means the in-memory state is still ahead of
        // disk; mark dirty so the next tick retries instead of dropping
        // updates silently.
        this._dirty = true;
        console.warn(`[PeerReputation] save failed: ${err.message}`);
      }
    };

    const promise = doSave().then(() => {
      this._saveInFlight = null;
      if (this._saveQueued) {
        this._saveQueued = false;
        return this.save();
      }
    });
    this._saveInFlight = promise;
    return promise;
  }

  /**
   * Start the periodic save timer. Safe to call multiple times — no-op
   * if already running. Consumer is expected to call stop() on shutdown.
   */
  startPersistTimer() {
    if (this._persistTimer) return;
    this._persistTimer = setInterval(() => {
      // Fire-and-forget; the caller is the timer, no one is awaiting.
      this.save().catch(() => { /* logged inside save() */ });
    }, PERSIST_INTERVAL_MS);
    if (this._persistTimer.unref) this._persistTimer.unref();
  }

  /**
   * Stop the periodic timer and flush. Returns a Promise; shutdown
   * paths must await it so the final save reaches disk before exit.
   */
  async stop() {
    if (this._persistTimer) {
      clearInterval(this._persistTimer);
      this._persistTimer = null;
    }
    await this.save();
  }

  _touch(addr) {
    let e = this._entries.get(addr);
    if (!e) {
      e = { goodBytes: 0, strikes: 0, lastSeenAt: 0 };
      this._entries.set(addr, e);
    }
    e.lastSeenAt = Date.now();
    this._dirty = true;
    if (this._entries.size > MAX_ENTRIES) this._evictOldest();
    return e;
  }

  // Remove the single oldest (least-recently-updated) entry. Called when
  // we cross MAX_ENTRIES so we don't pay the cost of a full sort on
  // every touch. O(n) but fires at most once per new entry past the cap.
  _evictOldest() {
    let oldestAddr = null;
    let oldestAt = Infinity;
    for (const [addr, entry] of this._entries) {
      if (entry.lastSeenAt < oldestAt) {
        oldestAt = entry.lastSeenAt;
        oldestAddr = addr;
      }
    }
    if (oldestAddr) this._entries.delete(oldestAddr);
  }

  _expireStale() {
    const now = Date.now();
    for (const [addr, entry] of this._entries) {
      if (now - entry.lastSeenAt > ENTRY_MAX_AGE_MS) this._entries.delete(addr);
    }
  }

  /**
   * Record that a peer delivered `bytes` bytes to us. Called from
   * PeerManager when a wire closes with positive delta-down. Successful
   * exchanges also decay any accumulated strikes — if the peer has
   * started behaving again, don't hold old failures against them.
   */
  recordDelivery(addr, bytes) {
    if (!addr || !bytes || bytes <= 0) return;
    const e = this._touch(addr);
    e.goodBytes += bytes;
    if (e.strikes > 0) e.strikes = Math.max(0, e.strikes - 1);
  }

  /**
   * Record that a peer failed us (timeout, short-lived, never-connected,
   * etc). PeerManager calls this when it'd normally ban the peer; we
   * accumulate across torrents so a serially-bad peer hits the pre-block
   * threshold regardless of which download it attached to.
   */
  recordStrike(addr /* , reason */) {
    if (!addr) return;
    const e = this._touch(addr);
    e.strikes += 1;
  }

  /**
   * Return the set of IPs that should be pre-blocked on a new engine.
   * These are peers whose cumulative strike count crosses the threshold
   * with no offsetting good-bytes delivery. IP-only (not ip:port) so
   * PeerManager's engine.block() calls cover every port the peer serves.
   */
  knownBadIps() {
    const out = new Set();
    for (const [addr, entry] of this._entries) {
      if (entry.strikes < PREBLOCK_STRIKE_THRESHOLD) continue;
      // A peer that's both bad AND good recently (strikes but also
      // goodBytes) is probably a flaky peer we want to retry. Only
      // pre-block the pure-bad ones.
      if (entry.goodBytes >= GOOD_BYTES_THRESHOLD) continue;
      const ip = ipOf(addr);
      if (ip) out.add(ip);
    }
    return out;
  }

  /**
   * Return up to `limit` peer addresses (ip:port) ranked by delivered
   * bytes, descending. Consumer feeds these to swarm.add() so they get
   * the first crack at our connection slots on a new torrent — if they
   * delivered for us before they'll usually deliver again, even on a
   * different infoHash (public seeders cover many torrents).
   */
  topGoodAddrs(limit = 20) {
    const ranked = [];
    for (const [addr, entry] of this._entries) {
      if (entry.goodBytes < GOOD_BYTES_THRESHOLD) continue;
      ranked.push({ addr, goodBytes: entry.goodBytes, lastSeenAt: entry.lastSeenAt });
    }
    ranked.sort((a, b) => b.goodBytes - a.goodBytes);
    return ranked.slice(0, limit).map((r) => r.addr);
  }

  /** Diagnostic snapshot — useful from a status endpoint or log line. */
  stats() {
    let goodCount = 0;
    let badCount = 0;
    let totalGoodBytes = 0;
    for (const entry of this._entries.values()) {
      if (entry.goodBytes >= GOOD_BYTES_THRESHOLD) goodCount++;
      if (entry.strikes >= PREBLOCK_STRIKE_THRESHOLD && entry.goodBytes < GOOD_BYTES_THRESHOLD) badCount++;
      totalGoodBytes += entry.goodBytes;
    }
    return {
      entries: this._entries.size,
      good: goodCount,
      bad: badCount,
      totalGoodBytes,
    };
  }
}

module.exports = { PeerReputation };
