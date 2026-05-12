# Code-Review Follow-Up Plan — Phased Execution

This document plans the remaining work surfaced by the multi-agent review (`docs/code-review-2026-05.md`) and pass-2 audits posted in PR #244. The work is too large for a single PR; this file slices it into **independently committable phases**, each with:

- explicit **scope** and **exclusions** so an agent can execute without re-deriving context
- a ready-to-launch **agent prompt** (drop-in copy)
- a **success-criteria** checklist the agent must satisfy before declaring done
- a **review checklist** the human reviewer (or a regression-review agent) uses to gate the phase
- explicit **dependencies** on prior phases

Default branching: each phase ships as one or more PRs against `main`. Phases without inter-dependencies can run in parallel.

---

## Phase ordering and dependencies

```
            Phase 0  ── (test infrastructure)
                │
   ┌────────────┼─────────────┬──────────────┐
   ▼            ▼             ▼              ▼
Phase 1     Phase 2       Phase 3        Phase 4a
(algorithm  (hot-path     (route +       (castv2-client
 / index    async fs)     subsystem      → castv2)
 perf)                    fixes)
   │            │             │              │
   └────────────┴─────────────┴──────────────┘
                              │
                              ▼
                          Phase 4b
                          (torrent-stream → webtorrent)
                              │
                              ▼
                          Phase 5
                          (architecture migration, 5a–5h)
                              │
                              ▼
                          Phase 6 (optional polish)
```

Phase 0 is a hard prerequisite for everything that needs HTTP-level smoke tests. Phases 1–4a are independent of each other after Phase 0 lands. Phase 4b should not start until Phases 0 + the test files from Phase 0 are merged. Phase 5 should not start until Phases 1–4 have stabilized for a release cycle.

---

## Phase 0 — Test infrastructure

**Goal:** make every later phase land safely. Right now `library-manager.js` and `server.js` can only be exercised via the existing 101 unit tests, none of which boot the HTTP server.

**Scope (commit boundary):**
- Extract `createApp({ libraryPath, torrentCachePath, library, musicLibrary, ... })` factory from `mobile-ui/server.js`. The module's bottom-of-file `app.listen(...)` lives behind `if (require.main === module)`.
- Add `{ noAutoInit: true }` constructor option to `LibraryManager` that gates `_loadMetadata`, `_loadPackCatalog`, `_initAsync` (and its children: `_recoverFromDiskState`, `_resumeInterruptedDownloads`, `_scanCompleteItemsForConversion`, `_startAutoRetryDaemon`), the `PeerReputation` ctor + persist timer, and the `fs.mkdirSync` calls.
- Add `{ skipLoad: true, now: () => fakeTs }` constructor options to `PeerReputation`.
- Add `{ snapshotFn }` constructor injection to `CpuMonitor`.
- Add `{ skipLoad: true, persistSync: false }` constructor options to `MusicPlaylists`.
- Add `tests/helpers/tmpdir.js` — `withTmpDir(t, prefix)` mkdtemp + after-hook cleanup wrapper.
- Add `tests/helpers/http.js` — `startTestServer(opts)` factory using `createApp` + ephemeral port.
- Add 5 new test files:
  - `tests/library-manager-state.test.js` — `getReviewQueue`, `_computeMatchState`, `_sanitizeItem`, `_safeDirectoryName`, addItem/removeItem roundtrip.
  - `tests/peer-reputation.test.js` — strike accumulation, good-bytes carve-out, LRU eviction, stale drop on load, atomic write.
  - `tests/cpu-monitor.test.js` — hysteresis, sustained-overload window.
  - `tests/ffmpeg-hw.test.js` — decode matrix across cuda/nvmpi/none, scale filter, `buildLiveEncoderArgs(maxThreads)` emits `-threads` only when > 0.
  - `tests/server-smoke.test.js` — boot `createApp({...})` against tmpdir, `fetch('/health')`, `/api/library`, `/api/cast/devices` with mocked SSDP. 304 ETag round-trip.
- Coverage report: add `c8` as devDep, wire `npm run test:cov`. No threshold gate yet — just baseline measurement so later phases can ratchet.

**Exclusions:**
- Do NOT touch any production code beyond constructor-flag plumbing and the `createApp()` extraction.
- Do NOT add an eslint config (deferred to Phase 6).
- Do NOT add Playwright / browser e2e (deferred to Phase 6).

**Files touched:**
- `mobile-ui/server.js` (factory extraction only)
- `mobile-ui/lib/library-manager.js`, `peer-reputation.js`, `cpu-monitor.js`, `music-playlists.js` (constructor-flag plumbing only)
- `mobile-ui/tests/helpers/*` (new)
- `mobile-ui/tests/{library-manager-state,peer-reputation,cpu-monitor,ffmpeg-hw,server-smoke}.test.js` (new)
- `mobile-ui/package.json` (add `c8` devDep, `test:cov` script)

**Risk:** Low. Touches construction paths only; existing 101 tests must still pass.

**Success criteria the agent must verify:**
- `npm ci && npm test` passes.
- `npm run test:cov` runs and emits a coverage report.
- New test files cover ≥ 80% of their target module's pure functions.
- `node -e "const { createApp } = require('./server.js'); const { app } = createApp({...}); /* no listen */"` does NOT bind a port.
- `if (require.main === module)` path still boots the listener in normal `node server.js` use.

**Review checklist:**
- [ ] Existing 101 tests still pass byte-identically (no test removed, no flake added).
- [ ] `noAutoInit: true` skips every documented side effect (verify by stubbing `fs.mkdirSync` and grepping for any uncovered call).
- [ ] `createApp` returns the app, library, musicLibrary, engine handles — verify the surface is sufficient for the smoke test.
- [ ] No production behaviour change when the flags are unset (the default code path must be byte-equivalent).

**Agent prompt (drop-in):**

```
Execute Phase 0 of docs/code-review-2026-05-plan.md. Read that file and
docs/code-review-2026-05.md first. Implementation scope is fully
specified in the Phase 0 section — do not expand. Pre-flight:
  1) git log --oneline origin/main..HEAD to understand recent work.
  2) Read mobile-ui/server.js entry/exit, the four lib constructors in
     scope, and the existing 5 test files in mobile-ui/tests/.

For each constructor-flag addition, ensure default code path is byte-
equivalent. For createApp, the listen call moves into the
`if (require.main === module)` guard. The factory accepts a config
object and returns { app, library, musicLibrary, engine }.

Each new test file must pass with `node --test tests/<file>`. Do not
land if any existing test fails. Run `npm test` after each new file.
Report coverage numbers from `c8` at the end.

Stay strictly inside Phase 0 scope. If you discover a real bug, file
it as a comment in the PR body, do NOT fix it (Phase 3 will).

Hand off: commit in 3 batches (1) constructor flags, (2) createApp +
helpers, (3) new test files. Push to a feature branch and open a PR
against main titled "Phase 0: test infrastructure". Under 1200 words
in the PR body.
```

---

## Phase 1 — Algorithm / index performance

**Goal:** kill the O(n²) sanitize patterns and the polling bandwidth on `/api/library`. Highest-leverage perf changes with zero architectural impact.

**Scope:**
- **`_byPackId` secondary index** (`library-manager.js`): mirror `_items` ↔ `Set<id>` for every pack. Update in `addItem`/`removeItem`/`_reKey`. Replace all `[...this._items.values()].filter(i => i.packId === X)` sites (22 sites identified by the optimization agent — see "A1" in the agent transcript). `_trackPackProgress` tick alone drops from O(n) to O(pack-size).
- **`_byStatus` secondary index** (`library-manager.js`): same pattern for the `status` field. Status transitions through ~6 specific methods — invalidate the index there. Replace `[...this._items.values()].filter(i => i.status === 'downloading')` sites.
- **Browser conditional GET on `/api/library` poll** (`public/js/app.js`): track `_lastLibraryEtag`, send `If-None-Match` on each poll, capture the new ETag from response. With server-side `_libraryCachedJson` already in place, idle polls become 304 + 0-byte body. ~80 KB / poll saved.
- **Debounce manualCategories + collectionCache writes** (`server.js`): wrap `saveManualCategories` and `saveCollectionCache` in a 500ms trailing debounce, same shape as `_writeMetadataNow`. Replace direct calls. Make the write atomic (tmp+rename).
- **Cover-proxy and MusicBrainz HTTP keep-alive agents** (`server.js`, `lib/metadata-musicbrainz.js`): module-scope `new https.Agent({ keepAlive: true, maxSockets: 2 })`. Pass via `agent:` option. ~150ms saved per cover/MB call after the first.
- **`_addonProxyCache` and `playlistCache` key normalization**: sort URL search params via `new URL(...).toString()` before keying so `?a=1&b=2` and `?b=2&a=1` share a cache entry.

**Exclusions:**
- Do NOT touch `parseM3U` (Phase 2).
- Do NOT touch the `_writeMetadataNow` JSON.stringify (Phase 2).
- Do NOT add the `_probeCache` / `dnsCache` memoization improvements (deferred — measure first).
- Do NOT bump `compression()` level (need benchmarking).

**Files touched:** `mobile-ui/lib/library-manager.js`, `mobile-ui/server.js`, `mobile-ui/lib/metadata-musicbrainz.js`, `mobile-ui/public/js/app.js`.

**Risk:** Medium. Index invariants must be exact — a missed mutator silently corrupts query results. Mitigation: assert-once-per-tick in dev mode that the indexes match a fresh `[...items].filter(...)` rebuild, drop the assertion after a release.

**Success criteria:**
- All existing tests pass; new test in `tests/library-manager-state.test.js` (Phase 0) extended to assert index correctness over addItem/status-transition/removeItem cycles.
- Add a microbenchmark script in `scripts/bench/pack-progress.js` measuring `_trackPackProgress` cost on a synthetic 1000-item library before/after. Report numbers in PR body.
- ETag 304 path verified via `curl -I -H 'If-None-Match: "lib-N"' http://...` returning 304 with empty body.

**Review checklist:**
- [ ] Every `_items.set` / `_items.delete` / re-key site updates the indexes.
- [ ] Every `item.status =` / `item.packId =` mutation goes through a method that maintains the indexes (or directly updates them).
- [ ] Browser poll captures the *new* ETag from each response, not just the first one.
- [ ] Debounced category writes use tempfile + rename (atomic) — verify with a chaos-monkey kill mid-write.
- [ ] Keep-alive agent passes `family: 4` if the rest of the file enforces IPv4-only.

**Agent prompt (drop-in):**

```
Execute Phase 1 of docs/code-review-2026-05-plan.md. Phase 0 must be
merged first. Read the optimization-agent findings A1, A2, F1, F2,
G1, G2, H1, H2, K3 in PR #244 comment thread for full context.

Implementation strategy:
1) Indexes: add a tiny IndexedItems mixin / inline maps. Pick the
   minimal-touch shape — Map<key, Set<id>>. Maintain via the existing
   addItem/removeItem/status-transition methods. Add a debug assertion
   (gated on process.env.DEBUG_LIBRARY_INDEX) that rebuilds the index
   from scratch and diffs it. Comment that the assertion comes out in
   the next release.
2) Conditional GET: track `state.lastLibraryEtag = null` (or similar)
   in the SPA; on every fetch send `If-None-Match`; on 304, no-op the
   render. Tests should verify a 304 response is handled.
3) Debounce: extract a tiny `debouncedAtomicWriter(path, getData,
   waitMs)` helper to lib/util.js. Use for both manualCategories and
   collectionCache.
4) Keep-alive agents: confirm the agent is shared between the cover
   proxy and MB module. Document the maxSockets choice.

Tests: extend Phase 0's tests/library-manager-state.test.js with
20+ index-correctness cases. Add tests/util-debounced-writer.test.js.

Stay strictly in Phase 1 scope. Other perf items are in Phases 2/3.

Hand off: one commit per item above. PR title "Phase 1: algorithm
and IO perf wins". Include benchmark numbers in PR body.
```

---

## Phase 2 — Hot-path async fs and event-loop hogs

**Goal:** eliminate the remaining sync-fs and event-loop-blocking work on the streaming hot path. Touches lower-level code than Phase 1; needs care.

**Scope:**
- **`_resumeInterruptedDownloads` async batched walk** (`library-manager.js:5063-5137`). Mirror the `_recoverFromDiskState` BATCH_SIZE=32 `Promise.all` pattern. Synchronous on startup blocks Express boot.
- **`auditDiskState` and `_findVideoFilesRecursive` walks** (`library-manager.js:780-840, 2450`) — convert to `fs.promises.readdir`/`stat`. Async sibling already exists at `:5624`; delete the sync twin.
- **HLS playlist & segment polling** (`server.js:4582, 4630`) — replace `fs.promises.readFile` / `fs.promises.stat` poll loops with `fs.watch` on the session dir, debounced 50ms.
- **`_writeMetadataNow` JSON.stringify worker_thread** (`library-manager.js:5301-5323`). On a 500-item library the stringify alone is 50-150ms of blocked event loop per save. Move stringify into a `worker_threads` pool; keep the rename + dir-fsync on the main thread (those are fast).
- **`parseM3U` streaming parser** (`server.js:5068-5105`). Stream `byline`-style chunk-by-chunk, run a single combined regex via `matchAll` per `#EXTINF:` block. Avoids the 100MB string accumulation on big IPTV lists.
- **`qrcode.js` lazy-load** — drop the eager `<script>` tag in `public/index.html`. Replace with a dynamic `import()` on the first connect-device flow open. Saves ~13 KB JS parse on every cold load.

**Exclusions:**
- Do NOT touch `_libraryCachedJson` shape (already addressed in pass 2).
- Do NOT convert all sync-fs sites in `library-manager.js` — only the ones in the streaming / startup hot path.
- Do NOT introduce a job queue abstraction for the worker_thread; one dedicated thread is enough.

**Files touched:** `mobile-ui/lib/library-manager.js`, `mobile-ui/server.js`, `mobile-ui/public/index.html`, `mobile-ui/public/js/app.js`.

**Risk:** High — touches hot path and adds a worker thread. Mitigations:
- Worker thread should fall back to main-thread stringify if the worker fails to start.
- `fs.watch` is platform-dependent — keep a poll fallback gated on `process.platform === 'linux'` (or where `fs.watch` is reliable).
- Land behind no flags but bisect-friendly commits (one item per commit).

**Success criteria:**
- Boot time on a 500-item library library measurably faster (record before/after in PR body via `time node server.js` with a synthetic dataset).
- HLS first-segment latency unchanged or improved.
- `npm test` passes; new `tests/util-stringify-worker.test.js` covers the fallback path.

**Review checklist:**
- [ ] Sync-fs grep on `library-manager.js` hot path returns no new sites after the change.
- [ ] worker_thread file initialization is cached (one thread for the process lifetime, not per save).
- [ ] `fs.watch` close() called on shutdown / session end.
- [ ] M3U streaming parser produces byte-identical output on a fixture playlist.
- [ ] `qrcode.js` no longer loads on initial page paint (verify in Network panel).

**Agent prompt (drop-in):**

```
Execute Phase 2 of docs/code-review-2026-05-plan.md. Phase 0 must be
merged. Phase 1's index changes do not conflict — can run in parallel
but coordinate the library-manager.js commits.

For worker_thread: create mobile-ui/lib/workers/stringify-worker.js
with the MessagePort protocol. Cache one Worker instance at LibraryManager
construction; on error or unavailable, fall back to main-thread JSON.stringify
with a [Library] warning. Keep the worker file self-contained — no
require of other repo code.

For fs.watch: extract a small `watchPlaylist(dir, onChange)` helper to
lib/util.js. Linux uses `fs.watch`; other platforms fall back to the
existing 200ms readFile poll.

For parseM3U: write the streaming version, but keep the original
parseM3U exported as `parseM3UEager(text)` for tests. Verify byte-
identical output against a golden 10k-channel fixture (commit
tests/fixtures/iptv-10k.m3u).

Test plan in PR body:
- Boot time on a synthetic 500-item library (script in scripts/bench).
- HLS first-segment latency (3 trials, before/after).
- Memory rss after 1 minute of /api/library polling.

Hand off: one commit per scope item. PR title "Phase 2: hot-path
async fs + event-loop hogs".
```

---

## Phase 3 — Outstanding bug fixes from pass-2 reviews

**Goal:** sweep up the medium / low severity items that the route-audit, music-subsystem, and worker reviews surfaced but weren't important enough to land in pass-2's primary batch.

**Scope (grouped by source):**

**Server.js route audit (remaining items from agent transcript in PR #244):**
- `/api/torrent-status/:infoHash/bottleneck` (2511) — auth-gate so unauthenticated callers can't probe active infoHashes.
- `/api/cache` listing (2422) — gate behind auth.
- `/api/settings/max-streams` (5267) — replace direct `engine._maxConcurrent = value` / `library._maxConcurrentDownloads = value` writes with a public setter that re-evaluates the queue.
- `/api/library/bulk-relink` (3904) — length-cap `showName` / `name` at 200 chars.
- `/api/library/:id/reorder` (3832) — cap `position` at 10000.
- `/api/library/repair-metadata` error messages (3158, 3162) — static message; log path server-side only.
- `parseInt`/`Number(...)` normalization (server.js multiple sites) — standardize on `Number.isInteger(n) && n >= 0 && n < MAX`.
- `/api/diagnostics/system` 403 response — add `Content-Type: text/plain`.

**Music subsystem (agent findings):**
- M3 frontend save throttle: replace the 5s `setInterval` save in `music-queue.js` with event-driven `audio.pause`/`audio.ended`/`visibilitychange` saves + a short debounce for `timeupdate`-driven position.
- M4 queue reorder DnD: rewrite the broken `state.shuffle === false` branch in `music-ui.js:942-954`; persist with `save()`.
- H4 `music-queue.js`: fix the `'off'` vs `'none'` repeat-enum mismatch — schema validator accepts `'none'/'one'/'all'` but default is `'off'`.
- H3 queue corrupt-state normalization in `load()`: drop `shuffleOrder` when its max ≥ queue.length; clamp `currentIndex < queue.length`.
- L2 `playRemoteAlbumStream` 6s blocking poll — add visible spinner update + AbortController on view-switch.
- L4 `getRecent` localStorage `Array.isArray` guard.

**Worker / scripts (agent findings):**
- F6 disk-space preflight on `/transcode` — `fs.statfsSync(TEMP_DIR)`, reject 507 if free < `declaredLen * 1.2`.
- F8 ffmpeg stderr ring-buffer chunk-level cap.
- F9 cap `X-Source-Filename` and `ext` length before tempfile naming.
- F10 worker `headersTimeout=0` — set to 60s.
- F18 worker output-size cap multiplier — make configurable.
- F19 worker output file leak on rejection — `unlink(outputPath)` on cleanup.
- F20 stallTimer try/finally guard.
- F21 `dedup-library.js` `bytesReclaimed` accounting fix (account per-rm-success, not divided up-front).
- F25 add `fsync` to `atomicWriteJson` in `scripts/fix-metadata-size.js` + `relink-metadata.js`.
- F27 cap `tolerancePct` at 25% in `fix-metadata-size.js`.
- F29 document the `fix-metadata-size` → `relink-metadata` operator ordering in `scripts/README.md` (create if missing).
- F31 `relink-metadata.js` `splitTopFolder` should normalize backslashes to forward slashes before split.

**Browser frontend:**
- Toast div: add `role="status" aria-live="polite"`.
- Icon-only buttons (`.library-card-relink`, `.library-card-remove`, etc.): add `aria-label` matching `title`.
- Global `keydown` Space/k/f handler: check `e.target` is body or video element before hijacking.
- `prefers-reduced-motion`: gate the JS parallax + ripple effects on `matchMedia('(prefers-reduced-motion: reduce)').matches`.

**Exclusions:**
- Do NOT add focus traps to modals (deferred to Phase 6 a11y batch).
- Do NOT change the `window.MusicAPI` / `window.app` global pollution structure (Phase 5).
- Do NOT add lint config (Phase 6).

**Files touched:** widely scattered across `mobile-ui/server.js`, `lib/library-manager.js`, `public/js/{app,music-queue,music-ui}.js`, `worker/server.js`, `scripts/*.js`.

**Risk:** Low–Medium. Each item is small but the breadth means it's easy to miss one or introduce a typo. Land in 4–6 commits grouped by subsystem.

**Success criteria:**
- All 101 tests still pass.
- For each new validation: add at least one unit test covering the reject case.

**Review checklist:**
- [ ] Each item from the source list above is addressed OR has a tracked TODO in the PR body explaining why deferred.
- [ ] No new sync fs introduced in worker.
- [ ] Worker disk-preflight covers both upload and output stages.
- [ ] Browser a11y additions don't break existing styling.

**Agent prompt (drop-in):**

```
Execute Phase 3 of docs/code-review-2026-05-plan.md. Walk each
sub-list in the Phase 3 scope; for each item, read the cited file:line
to confirm the issue still exists, then fix it. The agent transcripts
in PR #244 contain the full original justifications — read them first.

Group commits by subsystem:
  1) server.js route hardening (auth gates + input validation +
     parseInt normalization)
  2) settings/max-streams refactor (public setter + queue re-eval)
  3) music subsystem (queue + UI fixes)
  4) worker hardening (F6 + F8 + F9 + F10 + F18 + F19 + F20)
  5) scripts (F21 + F25 + F27 + F29 + F31)
  6) browser a11y batch

PR title "Phase 3: pass-2 follow-up fixes". Be exhaustive — every
item in the scope must be either fixed or explicitly deferred with
justification.
```

---

## Phase 4a — `castv2-client` → `castv2` swap

**Goal:** the declared `^1.4.0` is unsatisfiable on npm; the latest published is 1.2.0 (2022, abandoned). `npm install` reports `UNMET OPTIONAL DEPENDENCY`. Switch to `castv2` direct.

**Scope:**
- Update `mobile-ui/package.json` optionalDependencies: remove `castv2-client`, add `castv2: ^0.1.x` (or current latest).
- Re-implement the small `Client` / `DefaultMediaReceiver` surface against `castv2`'s `Client` + `createChannel`. `cast-manager.js` already wraps the protocol behind a thin abstraction with try/catch loading — the optional-dep name change + a few lines of channel setup.
- Add `tests/cast-manager-protocol.test.js` covering the `urn:x-cast:com.google.cast.media` LOAD / STOP / PAUSE / GET_STATUS message round-trips against a fake socket.

**Exclusions:**
- Do NOT change the DLNA path.
- Do NOT touch the discovery cache.

**Files touched:** `mobile-ui/package.json`, `mobile-ui/package-lock.json`, `mobile-ui/lib/cast-manager.js`, `mobile-ui/tests/cast-manager-protocol.test.js`.

**Risk:** Low. Cast layer already degrades gracefully when the optional dep is missing, and Phase 3 already validates `deviceId` against `discoveryCache` so even regressions are bounded.

**Review checklist:**
- [ ] `npm install` no longer reports `UNMET OPTIONAL DEPENDENCY`.
- [ ] Cast to a real Chromecast (manual test) — verify play / pause / stop / seek.
- [ ] Falls back to "Chromecast disabled" message when `castv2` is missing (re-run with `npm install --omit=optional`).

**Agent prompt (drop-in):**

```
Execute Phase 4a of docs/code-review-2026-05-plan.md. Independent of
Phases 1–3 except needing Phase 0's test infra. Phase 0 should be
landed first for the new test file.

castv2's API surface (from npm docs):
  const client = new Client();
  client.connect(host, () => { ... });
  client.getSessions(cb)
  const channel = client.createChannel('sender-id', 'receiver-id', 'urn:x-cast:com.google.cast.receiver');
  channel.send({ type: 'LAUNCH', appId: 'CC1AD845', requestId: 1 });

DefaultMediaReceiver in castv2-client is convenience-only — the
re-implementation is ~80 lines.

Hand off: single commit. PR title "Phase 4a: castv2-client → castv2".
```

---

## Phase 4b — `torrent-stream` → `webtorrent`

**Goal:** resolve all 6 high-severity `npm audit` findings (`ip@1.1.9` SSRF CVSS 8.1, `ws@1.1.5` DoS, etc.). This is the largest single security win in the entire plan. **High-risk** — touches the core download path.

**Scope:**
- Add `webtorrent` to deps. Remove `torrent-stream`.
- Introduce `lib/torrent-backend.js` adapter that exports the shape `TorrentEngine` and `LibraryManager` consume today: `{ getTorrent, _active, _evictOldest, _remuxInFlight, serveStream, ... }`.
- Adapter delegates to `webtorrent`'s `client.add(magnet, { path, announce })`.
- API mapping (from the review doc's §Dependencies):
  - `engine.files[i]` → `torrent.files[i]` (same shape: `.select`, `.deselect`, `.createReadStream`).
  - `engine.swarm.downloadSpeed()` → `torrent.downloadSpeed` (property, not method).
  - `engine.swarm.wires` → `torrent.wires` (same).
  - `engine.bitfield.buffer` — **bit order differs** between `bitfield@0.1.0` (torrent-stream) and `bitfield@4` (webtorrent). One-line tweak in `_computeProgress`.
  - `engine.block(ip)` does not exist on webtorrent — use the `blocklist` option at client construction (accepts an array or a function). PeerManager will need to rebuild the blocklist function on every strike, or have a single shared `blockedSet` the function consults.
  - `engine.connect(addr)` → `torrent.addPeer(addr)`.
  - `engine.listen(cb)` / `engine.destroy(cb)` → `torrent.destroy(cb)`.
- Rollout: introduce `TORRENT_BACKEND` env var (`torrent-stream` | `webtorrent`, default `torrent-stream`). Both backends compiled into the same build for one release cycle. After validation, flip the default; remove `torrent-stream` one minor release later.
- Disable WebRTC peers (`private: true` per torrent) to match torrent-stream parity. Document the option to enable as a feature win later.
- Disable IPv6 DHT initially (torrent-stream is v4-only). The PR body must document this and add a TODO for re-enabling.
- Persistent `.torrent` metadata cache: webtorrent doesn't write `.torrent` automatically. On `torrent.on('metadata')`, dump `torrent.torrentFile` to disk using the existing `_torrent-cache` layout so the resume-on-restart path still works.

**Exclusions:**
- Do NOT touch peer-reputation's persistence layer; only how the engine consults it.
- Do NOT enable WebRTC trackers (yet).
- Do NOT change the magnet-URI format or the tracker list.

**Files touched:** `mobile-ui/package.json`, `mobile-ui/package-lock.json`, new `mobile-ui/lib/torrent-backend-webtorrent.js`, `mobile-ui/lib/torrent-engine.js` (refactor to consume adapter), `mobile-ui/lib/library-manager.js` (any direct `engine.x` accesses).

**Risk:** **High.** The torrent engine is the single biggest blast-radius component in the codebase.

**Mitigations:**
- Side-by-side staging for at least 1 week before flipping the default.
- Both backends compiled in for one minor release.
- Add `tests/torrent-backend-contract.test.js` that runs the same contract against both backends with a stubbed/mocked tracker.
- Pre-flight: `npm audit` before/after must show 6 high → 0 high.
- Add operator-facing migration note to `README.md`.

**Success criteria:**
- `npm audit --omit=dev --audit-level=high` returns 0 findings.
- All existing 101+ tests pass against both backends.
- New contract test passes against both backends.
- Staging environment runs `TORRENT_BACKEND=webtorrent` for ≥ 7 days without regressions in download success rate / peer count / stall-recycle frequency.

**Review checklist:**
- [ ] Every `engine.X` reference in `library-manager.js` and `torrent-engine.js` goes through the adapter, not the raw underlying lib.
- [ ] PeerManager's blocklist rebuild is bounded (don't reinstantiate the client on every strike).
- [ ] Peer-cache `.torrent` file dump matches the byte layout the existing recovery path expects.
- [ ] Idle-timer / engine-recycle semantics match (webtorrent emits `idle` differently — verify behaviour).
- [ ] Operator migration note in README explains the env var.

**Agent prompt (drop-in):**

```
Execute Phase 4b of docs/code-review-2026-05-plan.md. **DO NOT START
until Phase 0 is merged and the contract test framework from Phase 0
is available.** This is the highest-risk phase in the plan — a bug
here breaks every download.

Pre-flight:
  1) Read docs/code-review-2026-05.md §Dependencies §B4.
  2) Run npm audit and screenshot the output for the PR body baseline.
  3) Read mobile-ui/lib/torrent-engine.js end-to-end. Catalogue every
     engine.X access in lib/library-manager.js by grep.

Implementation:
  1) New file: lib/torrent-backend-torrentstream.js wrapping the
     existing torrent-stream calls behind the adapter interface.
  2) New file: lib/torrent-backend-webtorrent.js implementing the
     same interface against webtorrent.
  3) Refactor torrent-engine.js + library-manager.js to consume the
     adapter via lib/torrent-backend.js (dispatcher keyed on
     TORRENT_BACKEND env var).
  4) New file: tests/torrent-backend-contract.test.js parameterized
     across both backends with a mocked tracker.

Hand off as a draft PR titled "Phase 4b: torrent-stream → webtorrent
(BEHIND FEATURE FLAG)". Do NOT mark ready for review until the
contract test passes on both backends. Include npm audit before/after
in PR body. Include a TODO list for the post-merge follow-up that
removes the old backend.
```

---

## Phase 5 — Architecture migration (5a–5h)

**Goal:** execute the 8-step migration from `docs/code-review-2026-05.md` §Architecture §6. Each step is **one PR** of roughly one developer-week.

Steps (one phase each, identical structure to phases above — read the architecture review for full per-step scope):

- **5a** Extract `AppConfig` (`app/config.js`).
- **5b** Extract `Settings` service.
- **5c** Move filename parsing + relevance + extras + episode-detect to `shared/title/`; switch both `library-manager.js` and `server.js` to consume it.
- **5d** Extract `StreamProviderRegistry` + split scrapers into `lib/stream-providers/sources/*.js`.
- **5e** Extract `ProbeService` (probe LRU + `_probeFile` + `classifyForClient` + `_isBrowserDecodable`).
- **5f** Extract `ConversionPipeline` (the 1100-LOC chunk inside `library-manager.js`).
- **5g** Extract `DownloadScheduler` (engines, pack progress, slots, peer cache, stall recycle, auto-retry).
- **5h** Final reduction: `LibraryManager` → `LibraryStore`; split `server.js` into the route tree (`routes/streams.js`, `routes/library.js`, ..., `routes/cast.js`).

**Prerequisites for all 5x phases:** Phases 0–3 merged. Phase 4b ideally landed and stable.

**Per-step deliverable:** one PR with the extracted module, the call-site updates, the new tests, and a delta line-count for both `library-manager.js` and `server.js`. The goal is `library-manager.js` < 1000 LOC and `server.js` < 1500 LOC by end of 5h.

**Risk per step:** Medium–High. Each is bounded but the cumulative refactor is the largest change in the project's lifetime. Mitigations:
- Each step ships behind a commit hash on a feature branch; never combine two steps in one PR.
- Each step's PR must include a `git diff --stat` showing the old file shrinking and the new file emerging — no net code growth without justification.
- Each step must pass the full test suite without any test changes (tests target behaviour, not internal structure).

**Review checklist (per step):**
- [ ] LOC delta is explained in PR body (new file = N lines, old file = M lines smaller, residual = ?).
- [ ] No new module loads more than 800 LOC.
- [ ] Every callsite of the extracted symbol goes through the new module's public API; no `_private` reach-throughs introduced.
- [ ] Architecture-review-doc state-ownership table still describes reality after the change.

**Agent prompt template (each 5x phase):**

```
Execute Phase 5<step> of docs/code-review-2026-05-plan.md. Read the
8-step migration plan in docs/code-review-2026-05.md §Architecture.
Implement exactly the step listed; do not bundle steps. Phases
0–4 must be merged.

Pre-flight: cite the current LOC of every file you intend to touch.
Cite the target LOC. If the diff would grow either file, stop and
report why before writing code.

Hand off: PR titled "Phase 5<step>: <one-line description>". Body
must include diff stats and the state-ownership table update.
```

---

## Phase 6 — Optional polish

**Goal:** items not on the critical path. Land opportunistically.

**Scope:**
- ESLint + Prettier config; `npm run lint` script; fix the 60+ empty-catch sites, 20+ `==` cases, mixed module-exports forms.
- Modal focus traps (relink, categorize, manual-import, cast picker).
- `prefers-reduced-motion` respected by every JS animation.
- `qrcode.js` rendering in a Web Worker (OffscreenCanvas).
- `loading="lazy"` + `srcset` audit across all `<img>` tags.
- Playwright smoke test: `await expect(page.locator('#library')).toBeVisible()` + click-through key flows.
- Replace `console.*` (528 calls) with the `lib/log.js` helper from the review report.
- Express 4 → 5 upgrade (resolves trailing body-parser/cookie/qs/send).

**Risk:** Mixed. Land each as an independent small PR.

---

## Phase execution protocol

Each phase follows the same loop. The user (or you, if delegating end-to-end) is the gatekeeper between steps.

1. **Spawn the implementation agent** with the drop-in prompt above.
2. **Wait for the agent's PR.** Read its self-reported test results and diff stats. Do not skip.
3. **Spawn a regression-review agent** with this prompt:
   ```
   Regression-review the changes in Phase <X> against
   docs/code-review-2026-05-plan.md. Walk every item in the phase's
   "Review checklist" — for each, find the relevant lines in the
   diff and verify the claim. Run `npm test` and the smoke checks.
   Report findings as PASS/FAIL/CONCERN per checklist item, plus
   any new bugs you spot.
   ```
4. **Address concerns** before merging. Loop steps 1–3 if the regression review finds issues.
5. **Merge to main.** Update `docs/code-review-2026-05-plan.md` to mark the phase complete.
6. **Pause for a release cycle** before starting the next dependent phase (gives operators a chance to file regressions).

---

## Estimated effort

| Phase | Scope size | Risk | Agent invocations (est.) |
|---|---|---|---|
| 0 | Medium | Low | 1 |
| 1 | Small | Medium | 1 |
| 2 | Medium | High | 1 |
| 3 | Large breadth | Low–Medium | 1–2 |
| 4a | Small | Low | 1 |
| 4b | Large depth | High | 2 (impl + contract tests) |
| 5a–5h | Each medium | Medium–High | 8 |
| 6 | Mixed | Low | Opportunistic |

**Total estimated agent invocations:** 16–20, depending on regression-review loop count.

---

## Operating principles (for the agents and the human reviewer)

1. **Stay strictly in phase scope.** Bugs discovered out of scope go in the PR body as a "follow-up findings" section, never silently fixed.
2. **One commit per logical fix** within a phase. The PR body summarizes; the commit history is the audit trail.
3. **No new sync-fs** anywhere on the request path. If a phase needs to add sync fs, justify in the PR body.
4. **No new module exceeds 800 LOC.** New modules add lines linearly; the architecture migration's goal is to *reduce* file sizes.
5. **Test before claiming done.** `npm test` must pass before "ready for review."
6. **The regression-review agent is mandatory** for Phases 1, 2, 4b, and every 5x step. Optional for 4a, 3, and 6 unless concerns are flagged.
