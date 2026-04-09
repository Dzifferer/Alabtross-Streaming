/**
 * Albatross — Peer Manager
 *
 * Detects dead peers and permanently bans them for the lifetime of a
 * torrent-stream engine. Exists because torrent-stream + peer-wire-swarm
 * have no dead-peer memory: they retry a failing address 3 times
 * (1s/5s/15s backoff) then drop it, but the very next tracker re-announce
 * (~30 min) puts the same dead address right back in the swarm, where it
 * consumes one of our scarce connection slots (connections: 50) through
 * the whole 21s retry cycle all over again.
 *
 * On low-seeder torrents this is the dominant cause of slow / stalled
 * downloads: a handful of dead addresses cycle endlessly and starve the
 * swarm of real peers. Dropping `connections` from 500 → 50 (commit
 * 19456b2) mitigated the symptom by shrinking the blast radius, but the
 * underlying churn is still there.
 *
 * Detection strategy
 * ──────────────────
 * torrent-stream exposes two events we can observe at the public API:
 *
 *   engine.on('peer', addr)   // discovered (tracker/DHT/PEX), pre-connect
 *   engine.on('wire', wire)   // successfully handshook — wire.peerAddress
 *
 * There is NO public event for "connection attempt failed". But we can
 * infer it: peer-wire-swarm keeps every discovered peer in swarm._peers
 * from swarm.add() until it has exhausted all retries, at which point it
 * calls _remove(addr). So if we watch a peer from its 'peer' event, and
 * some time later it is both (a) not in swarm._peers and (b) never
 * appeared as a wire, peer-wire-swarm silently gave up on it — it's dead.
 *
 * We also catch post-handshake duds: if a wire closes shortly after
 * connecting without transferring any useful data, it's a flaky/rude
 * peer that wasted a slot.
 *
 * After FAIL_THRESHOLD failures for the same address, we call
 * engine.block(addr), which adds the IP to torrent-stream's own
 * blocklist. The critical property: the `discovery.on('peer', ...)`
 * handler inside torrent-stream checks that blocklist BEFORE emitting
 * 'peer' or calling swarm.add — so future tracker re-announces for that
 * IP are dropped at the source and never touch a connection slot again.
 *
 * Private-field note
 * ──────────────────
 * We read swarm._peers, which is a private field of peer-wire-swarm
 * 0.12.x. It is guarded — if the field shape changes in a future version
 * the manager falls back to wire-close-only detection and logs a warning.
 * Pinned in package.json at "torrent-stream": "^1.2.1" → peer-wire-swarm
 * "^0.12.0", so this is stable for the current dependency set.
 */

// How long a wire must live + how little it must transfer to count as a dud.
// Chosen so a peer that completes a BitTorrent handshake and exchanges a few
// have/bitfield messages but never serves a block before closing is treated
// as dead. A peer that sticks around longer than this but stays choked is NOT
// counted — that's a legitimately uninterested seed, not a dead host.
const SHORT_LIVED_WIRE_MS = 15000;

// "Never connected" is a strong failure signal — peer-wire-swarm has exhausted
// its entire retry budget (~21s of TCP attempts with 1s/5s/15s backoff) AND
// our grace window has passed AND the peer never appeared in swarm._peers
// any more. One confirmed observation of this is enough to permanently ban.
// Downloads rarely last longer than one tracker announce cycle, so we can't
// afford to wait for a second discovery before acting.
const HARD_FAIL_BAN_AT = 1;

// "Short-lived wire" is a weaker signal — the peer handshook successfully
// but closed within SHORT_LIVED_WIRE_MS without sending a byte. This can
// happen to legitimate peers that choke then disconnect us under load, so
// require two independent observations before banning.
const SOFT_FAIL_BAN_AT = 2;

// How often we reconcile our watch list against swarm._peers to detect
// silent give-ups. 10s is frequent enough to catch the 21s retry cycle
// (1+5+15) without burning CPU on the poll.
const RECONCILE_INTERVAL_MS = 10000;

// How long after first discovery we wait before declaring a never-seen-as-wire
// peer dead. Must exceed peer-wire-swarm's total retry budget (~21s) with
// margin for drain scheduling under a saturated connection pool.
const GIVEUP_GRACE_MS = 45000;

// How often to log a summary line. 0 = never.
const SUMMARY_LOG_INTERVAL_MS = 60000;

class PeerManager {
  /**
   * @param {object} engine - torrent-stream engine
   * @param {object} [opts]
   * @param {string} [opts.label] - short tag for log lines (e.g. infoHash prefix)
   * @param {boolean} [opts.verbose] - log each ban as it happens
   */
  constructor(engine, opts = {}) {
    this._engine = engine;
    this._label = opts.label || 'peer-mgr';
    this._verbose = opts.verbose !== false;

    // addr ("ip:port") → { firstSeen: number, fails: number }
    // Persists across disappearance/re-appearance cycles so re-announced
    // dead peers accumulate strikes rather than resetting each round.
    this._state = new Map();

    // addr → number (Date.now of first observation on current cycle)
    // Cleared when the addr becomes a wire or we judge it dead.
    this._watch = new Map();

    // addr → true, for peers that have handshook at least once in this
    // engine. Used to avoid giving-up on a peer that's actively exchanging.
    this._connected = new Set();

    // IPs we've already told the engine to block. Tracked for stats + to
    // avoid redundant block() calls.
    this._bannedIps = new Set();

    // Bound handlers so removeListener works on destroy().
    this._onPeer = this._onPeer.bind(this);
    this._onWire = this._onWire.bind(this);

    this._reconcileTimer = null;
    this._summaryTimer = null;
    this._destroyed = false;
    this._privateFieldWarned = false;

    this._attach();
  }

  _attach() {
    const engine = this._engine;
    engine.on('peer', this._onPeer);
    engine.on('wire', this._onWire);

    this._reconcileTimer = setInterval(() => this._reconcile(), RECONCILE_INTERVAL_MS);
    if (this._reconcileTimer.unref) this._reconcileTimer.unref();

    if (SUMMARY_LOG_INTERVAL_MS > 0) {
      this._summaryTimer = setInterval(() => this._logSummary(), SUMMARY_LOG_INTERVAL_MS);
      if (this._summaryTimer.unref) this._summaryTimer.unref();
    }
  }

  _onPeer(addr) {
    if (this._destroyed || typeof addr !== 'string') return;

    // Drop garbage tracker entries (unspecified address, port 0, localhost,
    // broadcast) before they enter the watch list. These are never going to
    // become a real connection and spamming ban logs for 0.0.0.0:0 is noise.
    if (isBogusAddr(addr)) return;

    // Banned peer re-announced: block() is idempotent on the underlying
    // ip-set, but calling it keeps the log chain honest if a new port of
    // an already-blocked IP slips through.
    const ip = ipOf(addr);
    if (ip && this._bannedIps.has(ip)) {
      this._safeBlock(addr);
      return;
    }

    // Already connected in this session — nothing to watch.
    if (this._connected.has(addr)) return;

    if (!this._watch.has(addr)) {
      this._watch.set(addr, Date.now());
    }
  }

  _onWire(wire) {
    if (this._destroyed || !wire) return;
    const addr = wire.peerAddress;
    if (!addr || isBogusAddr(addr)) return;

    this._connected.add(addr);
    this._watch.delete(addr);

    // Track useful work so we can distinguish "connected but never sent a
    // byte" from "connected and downloading". wire.downloaded is the public
    // cumulative counter exposed by peer-wire-protocol.
    const connectedAt = Date.now();
    const initialDown = typeof wire.downloaded === 'number' ? wire.downloaded : 0;

    // Guard so wire.once('close') and wire.once('end') don't both score the
    // same wire twice — some peer-wire-protocol paths fire both in quick
    // succession.
    let scored = false;
    const onClose = () => {
      if (scored || this._destroyed) return;
      scored = true;

      const lived = Date.now() - connectedAt;
      const delta = (typeof wire.downloaded === 'number' ? wire.downloaded : 0) - initialDown;

      if (delta > 0) {
        // Successful exchange — reset any accumulated strikes.
        this._state.delete(addr);
        return;
      }

      // Short-lived AND zero bytes → dud. Long-lived with zero bytes is
      // just a choked seed; leave it alone.
      if (lived < SHORT_LIVED_WIRE_MS) {
        this._recordFailure(addr, 'short-lived');
      }
    };

    wire.once('close', onClose);
    wire.once('end', onClose);
  }

  /**
   * Diff our watch list against the swarm's internal peer table. Any watched
   * address that is no longer known to the swarm AND never became a wire has
   * been silently given up on after its retry budget — mark it failed.
   *
   * Also prunes expired watches past the give-up grace window as a belt-and-
   * braces fallback in case the private field read fails.
   */
  _reconcile() {
    if (this._destroyed) return;

    const swarm = this._engine && this._engine.swarm;
    const peersTable = swarm && swarm._peers;
    const hasPeersTable = peersTable && typeof peersTable === 'object';

    if (!hasPeersTable && !this._privateFieldWarned) {
      console.warn(`[PeerManager] ${this._label}: swarm._peers not available — dead-peer detection degraded to wire-close only`);
      this._privateFieldWarned = true;
    }

    const now = Date.now();
    for (const [addr, firstSeen] of this._watch) {
      if (this._connected.has(addr)) {
        this._watch.delete(addr);
        continue;
      }

      let gone = false;
      if (hasPeersTable) {
        // peer-wire-swarm keys _peers by the raw addr string.
        gone = !Object.prototype.hasOwnProperty.call(peersTable, addr);
      }

      const aged = now - firstSeen >= GIVEUP_GRACE_MS;

      if (gone && aged) {
        // Confirmed dead by both signals: the swarm gave up AND enough time
        // elapsed that we're not in a transient drain-queue backlog.
        this._watch.delete(addr);
        this._recordFailure(addr, 'never-connected');
      } else if (!hasPeersTable && aged) {
        // Degraded mode: no private-field signal, so fall back to a pure
        // time-based heuristic. This is less precise (may ban peers that
        // are still in the retry queue), which is why we only use it when
        // we can't read _peers at all.
        this._watch.delete(addr);
        this._recordFailure(addr, 'timeout-degraded');
      }
    }
  }

  _recordFailure(addr, reason) {
    const entry = this._state.get(addr) || { firstSeen: Date.now(), fails: 0 };
    entry.fails += 1;
    this._state.set(addr, entry);

    // Hard signals ban on first strike; soft signals need two.
    const isHard = (reason === 'never-connected' || reason === 'timeout-degraded');
    const threshold = isHard ? HARD_FAIL_BAN_AT : SOFT_FAIL_BAN_AT;

    if (entry.fails >= threshold) {
      const ip = ipOf(addr);
      if (ip && !this._bannedIps.has(ip)) {
        this._bannedIps.add(ip);
        this._safeBlock(addr);
        if (this._verbose) {
          console.log(`[PeerManager] ${this._label}: banned ${addr} (${reason}, strikes=${entry.fails})`);
        }
      }
    }
  }

  _safeBlock(addr) {
    try {
      if (this._engine && typeof this._engine.block === 'function') {
        this._engine.block(addr);
      }
    } catch (err) {
      // Never let a banning glitch take down the parent download.
      console.warn(`[PeerManager] ${this._label}: block(${addr}) threw: ${err.message}`);
    }
  }

  _logSummary() {
    if (this._destroyed) return;
    const swarm = this._engine && this._engine.swarm;
    const wires = swarm && swarm.wires ? swarm.wires.length : 0;
    const queued = swarm ? swarm.queued : 0;
    // engine.port is set by engine.listen's findPort callback, which is
    // async — it'll be undefined for the first summary or two. Print "-"
    // while the listener is still binding so the column stays aligned.
    const port = (this._engine && this._engine.port) || '-';
    console.log(
      `[PeerManager] ${this._label}: port=${port} wires=${wires} queued=${queued} ` +
      `watching=${this._watch.size} tracked=${this._state.size} bannedIps=${this._bannedIps.size}`
    );
  }

  /**
   * Public snapshot for UI / progress loggers.
   */
  stats() {
    return {
      watching: this._watch.size,
      tracked: this._state.size,
      bannedIps: this._bannedIps.size,
    };
  }

  /**
   * Tear down timers and detach listeners. Idempotent. MUST be called
   * before or alongside engine.destroy() to release timer references.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    if (this._reconcileTimer) {
      clearInterval(this._reconcileTimer);
      this._reconcileTimer = null;
    }
    if (this._summaryTimer) {
      clearInterval(this._summaryTimer);
      this._summaryTimer = null;
    }

    if (this._engine) {
      try { this._engine.removeListener('peer', this._onPeer); } catch { /* ignore */ }
      try { this._engine.removeListener('wire', this._onWire); } catch { /* ignore */ }
    }

    this._engine = null;
    this._state.clear();
    this._watch.clear();
    this._connected.clear();
    // Keep _bannedIps around in case stats() is called after destroy.
  }
}

function ipOf(addr) {
  if (typeof addr !== 'string') return null;
  // IPv4: "1.2.3.4:6881". IPv6 would be "[::1]:6881" but peer-wire-swarm
  // only uses v4 today — stay symmetric with torrent-stream's own
  // addr.split(':')[0] in engine.block().
  const idx = addr.lastIndexOf(':');
  return idx > 0 ? addr.slice(0, idx) : addr;
}

/**
 * Reject peer addresses that can never represent a real, reachable host:
 * the unspecified address, localhost (we are not our own peer), broadcast,
 * port 0, malformed strings. Trackers and DHT occasionally return these
 * — silently drop them at intake rather than letting them clog the watch
 * list and spam ban logs.
 */
function isBogusAddr(addr) {
  if (typeof addr !== 'string' || addr.length === 0) return true;
  const idx = addr.lastIndexOf(':');
  if (idx <= 0) return true;
  const ip = addr.slice(0, idx);
  const portStr = addr.slice(idx + 1);
  const port = Number.parseInt(portStr, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return true;
  if (ip === '0.0.0.0') return true;
  if (ip === '255.255.255.255') return true;
  if (ip === '127.0.0.1' || ip === 'localhost') return true;
  return false;
}

module.exports = { PeerManager };
