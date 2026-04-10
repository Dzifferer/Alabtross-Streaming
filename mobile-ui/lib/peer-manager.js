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

// Long-lived but unproductive: a wire that we have been actively ASKING
// for pieces from (amInterested=true) for at least this long AND has
// delivered zero bytes is dead weight in our slot pool. Default chosen
// so a well-behaved peer has had ~9 BT rechoke rounds (~10s each) to
// unchoke us before we give up on it. Shorter than this falsely punishes
// seeds that are still optimistically rotating their upload slots; longer
// wastes one of our 50 connection slots on a peer that is statistically
// never going to serve us this session.
//
// IMPORTANT: this clock starts when the sweep first observes
// wire.amInterested=true, NOT at handshake. Under the original
// measure-from-handshake design, a wire that sat through a 3-minute
// BEP-9 metadata fetch would be evicted within one sweep cycle (~10s)
// of metadata arriving, because lived > 90s was already true but we
// had only actually wanted bytes from it for 10s. That killed
// season-pack downloads — every handshook peer got guillotined the
// instant the rechoker finally asked them for data.
const UNPRODUCTIVE_WIRE_MS = 90000;

// Starvation detection: when fewer than LOW_WATER_WIRES peers have
// handshook and stayed connected across several consecutive reconcile
// cycles, we switch the watch-list stale threshold from STALE_WATCH_MS
// (5 min) to STARVED_STALE_WATCH_MS (1 min). The normal 5-minute window
// is too lenient under slot pressure: peer-wire-swarm can park dead
// addresses in its internal retry-forever loop indefinitely, so the
// only way fresh tracker candidates get a chance is if we actively
// clear the backlog. Under starvation we want that backlog drained
// ~5x faster so new discoveries reach the slot pool sooner.
const LOW_WATER_WIRES = 5;
const STARVATION_STREAK_BEFORE_DECAY = 2;
const STARVED_STALE_WATCH_MS = 60 * 1000;

// How often we reconcile our watch list against swarm._peers to detect
// silent give-ups. 10s is frequent enough to catch the 21s retry cycle
// (1+5+15) without burning CPU on the poll.
const RECONCILE_INTERVAL_MS = 10000;

// How long after first discovery we wait before declaring a never-seen-as-wire
// peer dead. Must exceed peer-wire-swarm's total retry budget (~21s) with
// margin for drain scheduling under a saturated connection pool.
const GIVEUP_GRACE_MS = 45000;

// Absolute maximum time a peer is allowed to linger in the watch list without
// ever producing a wire. If peer-wire-swarm is keeping a peer in its _peers
// table indefinitely (observed in the wild on some low-seed torrents: the
// retry setTimeout just keeps repushing to the queue forever without ever
// succeeding or giving up), the watch list never drains via the normal
// swarm._peers diff path. 5 minutes is far past any legitimate connection
// backoff so anything still sitting here is effectively dead from our POV —
// evict it and count it as a strike.
const STALE_WATCH_MS = 5 * 60 * 1000;

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

    // addr → { wire, connectedAt, initialDown }
    // Active handshook wires that we are sweeping for productivity. Entries
    // are added in _onWire and removed on close OR when the periodic sweep
    // evicts them. Holding the wire reference (vs. re-reading swarm.wires
    // every cycle) means a quick-flap reconnect under the same addr can't
    // confuse us about which physical socket we're judging.
    this._liveWires = new Map();

    // Count of wires we've evicted from the swarm because they sat in our
    // slot pool without delivering data. Surfaced via stats() so the UI /
    // logs can show how aggressively the slot pool is churning.
    this._evictedWires = 0;

    // Starvation tracking: consecutive reconcile cycles where
    // swarm.wires.length < LOW_WATER_WIRES. When this crosses
    // STARVATION_STREAK_BEFORE_DECAY we switch to a shorter stale window
    // so the watch list can drain faster. Reset when wires recover.
    // _starvationActive is a one-shot flag so we only log the transition
    // once per starvation episode instead of every 10s.
    this._starvationStreak = 0;
    this._starvationActive = false;

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
    //
    // interestedSince is armed the first time the sweep observes
    // wire.amInterested=true. Null until then so pre-metadata wires (where
    // the engine has no piece selection yet, so amInterested stays false
    // for every wire) never start the unproductive-budget clock. Once
    // armed, the UNPRODUCTIVE_WIRE_MS gate is measured from this moment,
    // which gives the BT rechoker a fair 9 rounds to unchoke us no matter
    // how long BEP-9 metadata exchange kept the wire alive beforehand.
    const info = {
      wire,
      connectedAt: Date.now(),
      initialDown: typeof wire.downloaded === 'number' ? wire.downloaded : 0,
      interestedSince: null,
    };
    // Note: a quick-flap reconnect (same addr, new socket) will overwrite
    // the previous entry here. The close handler below uses identity
    // comparison so the OLD wire's close path doesn't clobber the NEW
    // wire's _liveWires entry.
    this._liveWires.set(addr, info);

    // Guard so wire.once('close') and wire.once('end') don't both score the
    // same wire twice — some peer-wire-protocol paths fire both in quick
    // succession.
    let scored = false;
    const onClose = () => {
      if (scored || this._destroyed) return;
      scored = true;

      // Only release our _liveWires slot if it's still pointing at THIS
      // wire instance. A faster reconnect under the same addr could have
      // already replaced it, in which case the new entry must survive.
      const current = this._liveWires.get(addr);
      if (current && current.wire === wire) {
        this._liveWires.delete(addr);
      }

      const lived = Date.now() - info.connectedAt;
      const delta = (typeof wire.downloaded === 'number' ? wire.downloaded : 0) - info.initialDown;

      if (delta > 0) {
        // Successful exchange — reset any accumulated strikes.
        this._state.delete(addr);
        return;
      }

      // Short-lived AND zero bytes → dud. Long-lived with zero bytes is
      // handled by the periodic sweep instead, so we don't double-count it
      // here.
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
    const activeWires = (swarm && swarm.wires) ? swarm.wires.length : 0;

    if (!hasPeersTable && !this._privateFieldWarned) {
      console.warn(`[PeerManager] ${this._label}: swarm._peers not available — dead-peer detection degraded to wire-close only`);
      this._privateFieldWarned = true;
    }

    // Slot-starvation state machine. If fewer than LOW_WATER_WIRES wires
    // are handshook for several cycles in a row, peer-wire-swarm's drain
    // queue is almost certainly clogged with addresses stuck in its
    // retry-forever loop. Shrink the stale window so the watch-list pass
    // below evicts and ip-bans those clogs ~5x sooner and fresh tracker
    // candidates get a shot at our slot pool.
    if (activeWires < LOW_WATER_WIRES) {
      this._starvationStreak += 1;
    } else {
      if (this._starvationActive) {
        console.log(
          `[PeerManager] ${this._label}: swarm recovered (wires=${activeWires}) — restoring normal stale window`
        );
        this._starvationActive = false;
      }
      this._starvationStreak = 0;
    }
    const starved = this._starvationStreak >= STARVATION_STREAK_BEFORE_DECAY;
    const effectiveStaleMs = starved ? STARVED_STALE_WATCH_MS : STALE_WATCH_MS;
    if (starved && !this._starvationActive) {
      console.log(
        `[PeerManager] ${this._label}: swarm starved (wires=${activeWires} < ${LOW_WATER_WIRES}) — ` +
        `accelerating watch-list decay from ${STALE_WATCH_MS / 1000}s to ${STARVED_STALE_WATCH_MS / 1000}s`
      );
      this._starvationActive = true;
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

      const age = now - firstSeen;
      const aged = age >= GIVEUP_GRACE_MS;
      const stale = age >= effectiveStaleMs;

      if (gone && aged) {
        // Confirmed dead by both signals: the swarm gave up AND enough time
        // elapsed that we're not in a transient drain-queue backlog.
        this._watch.delete(addr);
        this._recordFailure(addr, 'never-connected');
      } else if (stale) {
        // Has been in our watch list for >5 minutes without ever connecting
        // AND without leaving swarm._peers. Observed on low-seed torrents
        // where peer-wire-swarm keeps retrying the same dead addresses
        // forever via its internal setTimeout loop — the normal "gone from
        // _peers" signal never fires. Evict and count as dead anyway; by
        // this point the peer is unambiguously useless to us.
        this._watch.delete(addr);
        this._recordFailure(addr, 'stale');
      } else if (!hasPeersTable && aged) {
        // Degraded mode: no private-field signal, so fall back to a pure
        // time-based heuristic. This is less precise (may ban peers that
        // are still in the retry queue), which is why we only use it when
        // we can't read _peers at all.
        this._watch.delete(addr);
        this._recordFailure(addr, 'timeout-degraded');
      }
    }

    // Pass 2: scan handshook wires for unproductive ones holding our slots.
    this._sweepLiveWires();
  }

  /**
   * Evict wires we have been asking for bytes from for ≥ UNPRODUCTIVE_WIRE_MS
   * without receiving a single byte. The original peer-manager only caught
   * SHORT-lived wires (<15s) on close — but the dominant slot-burning
   * pattern in low-seeder swarms is the long-lived dud: a peer that
   * handshakes cleanly, sits choked for the entire metadata or download
   * window, and only releases the slot when WE eventually destroy the
   * engine. With a 50-slot ceiling and a handful of these per swarm,
   * effective parallelism collapses to single digits.
   *
   * Clock semantics
   * ───────────────
   * The 90-second budget is measured from the first sweep that observes
   * `wire.amInterested === true`, NOT from handshake. This distinction
   * matters enormously for season packs:
   *
   *   t=0    wire handshakes (BEP-9 metadata exchange begins)
   *   t=150  metadata finally arrives, piece selection flips
   *          engine.amInterested=true → every wire is marked interested
   *   t=160  our sweep fires. The wire has lived=160s but we have only
   *          actually been asking for pieces for 10s. Ten seconds is
   *          less than one full BT rechoke round; the peer hasn't had
   *          a chance to unchoke us yet. Evicting here (as the original
   *          lived-based design did) guillotines every wire in the pool
   *          at the exact moment they become useful, which is the
   *          slowdown we're fixing.
   *
   * Under the interested-timer design, t=160 sweep sees amInterested=true
   * for the first time and arms the clock; the wire isn't a candidate
   * for eviction until t=250 at the earliest, which is a full 9 rechoke
   * rounds of being asked for data. Peers that were going to serve us
   * will have done so by then.
   *
   * Productive wires (delta > 0) clear both their strikes and their
   * interested-clock, so a peer that delivers then briefly stalls isn't
   * punished for the stall.
   *
   * Wires that the engine is not interested in at all (pre-metadata, or
   * during rechoker uninterest) have their clock held at null and are
   * exempt from eviction — that's the rechoker's choice, not the peer's
   * fault.
   *
   * Eviction path: engine.disconnect(addr) → swarm._remove(addr) which
   * removes the addr from swarm._peers entirely so peer-wire-swarm's
   * internal reconnect timer can't bounce it right back into our slot
   * pool. Freed slot → swarm._drain pulls a new candidate from the
   * queue → effectively "search for fresh peers". Two evictions of the
   * same addr cross the existing 2-strike soft-fail threshold and
   * permanent-ban via _recordFailure → engine.block.
   */
  _sweepLiveWires() {
    if (this._destroyed || !this._engine) return;
    if (this._liveWires.size === 0) return;

    const now = Date.now();

    for (const [addr, info] of this._liveWires) {
      const wire = info.wire;
      const cur = (wire && typeof wire.downloaded === 'number') ? wire.downloaded : 0;
      const delta = cur - info.initialDown;

      if (delta > 0) {
        // Productive — credit the peer immediately rather than waiting for
        // the close handler. This lets a peer with prior strikes (e.g.
        // short-lived in a previous engine session) recover its reputation
        // the moment it starts serving us, instead of being one short flap
        // away from a ban. Also clear the interested-clock so a transient
        // post-productive stall doesn't pick up where the clock left off.
        if (this._state.has(addr)) this._state.delete(addr);
        info.interestedSince = null;
        continue;
      }

      // Rechoker isn't asking this peer for data (pre-metadata has no
      // piece selection so this covers every wire; post-metadata it
      // covers peers the rechoker has temporarily backed off of). Pause
      // the clock — when the engine decides it wants something from them
      // again, the next sweep will re-arm it from THAT moment.
      if (!wire || wire.amInterested !== true) {
        info.interestedSince = null;
        continue;
      }

      // First sweep where we observe interest → arm the clock, skip this
      // round. Eviction can't happen until we've at least had one full
      // sweep interval (RECONCILE_INTERVAL_MS) of confirmed interest to
      // measure against.
      if (info.interestedSince === null) {
        info.interestedSince = now;
        continue;
      }

      const interestedFor = now - info.interestedSince;
      if (interestedFor < UNPRODUCTIVE_WIRE_MS) continue;

      // Interested for UNPRODUCTIVE_WIRE_MS+ (≥9 rechoke rounds) with
      // zero bytes delivered. Slot is genuinely wasted — evict.
      this._evictedWires += 1;
      this._liveWires.delete(addr);
      this._recordFailure(addr, 'unproductive');

      // _recordFailure may have already called engine.block(addr), which
      // internally invokes engine.disconnect → swarm._remove → wire.destroy.
      // If this is only strike 1 (no ban yet) we still need to physically
      // free the slot, otherwise the wire just sits there until the next
      // sweep notices the same dud all over again.
      const ip = ipOf(addr);
      if (!ip || !this._bannedIps.has(ip)) {
        try {
          if (typeof this._engine.disconnect === 'function') {
            this._engine.disconnect(addr);
          } else if (wire && typeof wire.destroy === 'function') {
            // Last-resort fallback if torrent-stream ever drops the public
            // disconnect helper. Less ideal because peer-wire-swarm's
            // internal reconnect timer may bounce the addr back into our
            // slot pool within ~1s, but better than leaking the slot.
            wire.destroy();
          }
        } catch (err) {
          console.warn(`[PeerManager] ${this._label}: disconnect(${addr}) threw: ${err.message}`);
        }
      }

      if (this._verbose) {
        const ageSec = ((now - info.connectedAt) / 1000) | 0;
        console.log(
          `[PeerManager] ${this._label}: evicted ${addr} ` +
          `(unproductive, interested=${(interestedFor / 1000) | 0}s, age=${ageSec}s, dl=0)`
        );
      }
    }
  }

  _recordFailure(addr, reason) {
    const entry = this._state.get(addr) || { firstSeen: Date.now(), fails: 0 };
    entry.fails += 1;
    this._state.set(addr, entry);

    // Hard signals ban on first strike; soft signals need two.
    // 'stale' is also a hard signal — 5+ minutes of non-progress is
    // overwhelming proof that this address will never be useful to us.
    const isHard = (reason === 'never-connected' || reason === 'timeout-degraded' || reason === 'stale');
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
      `live=${this._liveWires.size} watching=${this._watch.size} tracked=${this._state.size} ` +
      `bannedIps=${this._bannedIps.size} evicted=${this._evictedWires}`
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
      liveWires: this._liveWires.size,
      evicted: this._evictedWires,
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
    this._liveWires.clear();
    // Keep _bannedIps and _evictedWires around in case stats() is called
    // after destroy.
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
