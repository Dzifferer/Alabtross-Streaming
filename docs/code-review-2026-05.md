# Alabtross Streaming — Multi-Agent Code Review

Commit reviewed: `a7bb91a` (main HEAD at time of review, 2026-05-12).
Method: nine parallel review agents covering correctness, security (HTTP and shell/supply), performance, concurrency/state, browser/frontend, architecture, code quality, testing, and dependencies. Each agent read the major files end-to-end rather than sampling.

Findings are numbered by category for cross-reference. File paths are absolute; line numbers refer to the commit above.

---

## Executive top-10 (cross-validated by multiple agents)

1. **Default-no-auth + 0.0.0.0 bind + Origin-only CSRF** — the single biggest exposure. A casual LAN visitor can drive the box; combined with #2, an internet visitor can too if the port is forwarded.
2. **SSRF blocklist gaps** (`server.js:4818-4854`): regex-based, misses IPv6-mapped IMDS `::ffff:a9fe:a9fe`, ULA edge forms, decimal/hex IP encodings, GCP `metadata.google.internal`. Reachable via `/api/addon-proxy`, `/api/iptv/channels`, `/api/iptv/stream`, `/api/cover/release/:mbid` (no SSRF check at all).
3. **`disk_*` ID path leak** (`library-manager.js:3574-3608`): `GET /api/library/disk_..%2F_metadata.json/stream` returns `_metadata.json`, `pre-repair-*.bak`, and `_pack-catalog.json` — every magnet URI in the library. `_isPathSafe` passes because the file is inside `LIBRARY_PATH`; no media-extension check.
4. **Cast SSRF**: `device.host` and `device.location` in `POST /api/cast/play` are attacker-controlled and bypass the SSRF guard.
5. **HLS waiter deadlock** (`server.js:4546-4571`): on disk-space-precheck or session-start failure the `finally` deletes the lock map entry but never resolves/rejects `lockPromise`. Concurrent requests that captured `existingLock` hang on a never-settling promise until socket timeout.
6. **`torrent-stream@1.2.1`** is the root cause of **all 6 high-severity audit findings** (ip@1.1.9 SSRF CVSS 8.1, ws@1.1.5 DoS, etc.). Migration path to `webtorrent` is in the deps section.
7. **Sync fs in 4 startup/hot-path locations** blocks the event loop and causes mid-playback rebuffering on Jetson: `_resumeInterruptedDownloads` (5063), `auditDiskState` walks (780), HLS playlist read every 200ms (4582), `_writeMetadataNow` `JSON.stringify` of multi-MB blob (5301).
8. **Live ffmpeg invocations missing `-threads`** — pegs all 4 cores on Jetson, starving Node and BT verify. CPU monitor only caps *background* conversions.
9. **Conversion slot reservations done AFTER `await`** (`library-manager.js:6989-7026`): two concurrent queue ticks can both spawn ffmpeg for the same item.
10. **Lockfile drift breaks `npm ci`**: `http-proxy-middleware ^3.0.0` orphan in `package-lock.json` (already removed from `package.json`). Dockerfile's `npm ci || npm install` silently falls back to mutating install, but local `npm ci` will refuse. Regenerate the lockfile.

---

## Correctness (24 findings)

### Critical

- **HLS waiter deadlock** — `server.js:4546-4571`. Disk precheck `return res.status(507)` and `_startHlsSession` catch path return inside the `try`. The `finally` deletes the lock map entry but `lockResolve`/`lockReject` are never called. Concurrent requests that captured `existingLock` hang until their HTTP socket times out. Fix: call `lockResolve()` (or reject) on every early-return path inside the `try`, or move the resolve into the `finally`.
- **`musicLibrary` never destroyed on shutdown** — `server.js:5438-5468`. `shutdown()` only awaits `library.destroy()`. The 8s force-exit timer kills the process and any pending debounced music-library writes are lost (download state, play counts, favorites, manual genres). Fix: `await Promise.all([library.destroy(), musicLibrary.destroy()])`.
- **Recursive `httpGet` loses keep-alive `agent` + redirect counter** — `stream-providers.js:124-130`. On 3xx, `httpGetDirect` calls top-level `httpGet(location, timeoutMs, _redirectCount+1)` instead of recursing through `httpGetDirect`. The wrapper re-runs DNS, drops the `resolvedIp`/`Host` rewrite, and `_redirectCount` resets — `MAX_REDIRECTS` can be exceeded. Same path forgets `clearTimeout(deadline)` on body-too-large reject (line 142-145).
- **`destroy()` `kill('SIGTERM')` races metadata flush** — `library-manager.js:3848-3851`. ffmpeg `close` listener can write conversion-progress mutations *after* the final `_writeMetadataNow` already serialized. Fix: set a `_shuttingDown` flag and `await Promise.allSettled` on the child-exit promises before the final save.

### High

- Pack engine recycle leaves `engine.on('wire'|'piece')` listeners attached to destroyed engines (`library-manager.js:2113-2127, 4410-4426`). `_destroyEngine` needs `engine.removeAllListeners()` before `engine.destroy()`.
- `_recordGoodPeer` Set eviction drops the *first* peer recorded, not the least-recently-seen (`library-manager.js:4637-4645`). Re-recorded peers don't refresh their position.
- `PeerReputation.save()` retries indefinitely with no backoff on a permanently-failing FS (`peer-reputation.js:140-175`).
- `PeerManager._recordFailure` runs after destroy and grows `_state` against irrelevant peers (`peer-manager.js:539-565`).
- SSDP `local-discovery.js:243-302` 1.5s early-exit truncates the MX window and drops late responders. Also: `enrichAndFinish` can be called twice (early-completion + `mainTimeout`) — guard with a `finished` flag.
- `cast-manager.js:308-317` — `'status'` listener is added with `player.on('status', ...)` but never removed; old listener still mutates `activeSessions` after the session ends.
- `stream-providers.js:140-147` — `httpGetDirect` body-overflow path forgets `clearTimeout(deadline)`.
- `library-manager.js:4044-4075` — `_progressTimers.set(id, t)` happens AFTER timer creation; if the first tick fires synchronously, `_stopDownload(id)` is invoked before the map entry exists, leaking the interval.

### Medium

- `getAll()` cache stale after `promoteDiskItem` — `library-manager.js:2252-2274` nulls `_discoveryCache` but not `_getAllCache`.
- `_onConversionSuccess` unlinks the source file *before* the new path is durable in metadata (`library-manager.js:6802-6807`).
- `_packStallRecycles` never reset on success (`library-manager.js:196, 2108`).
- Probe-cache mtime collision on rewrites within the same second (`library-manager.js:5706-5775`).
- Non-atomic `.bak` write in `music-playlists.js:56-60`.
- Cast `client.connect` 10s timeout fires before `connect` callback — racing reject vs. success (`cast-manager.js:259-323`).
- `worker/server.js:381-390` — `req.on('close')` checks `req.destroyed` to detect client abort, but Node also destroys req on normal completion → can kill in-progress ffmpeg and delete its input on success. Track explicit `uploadComplete` flag.
- `_metadataWriteInFlight` cleared unconditionally in `.then` — `library-manager.js:5371-5377`. Re-entrant writes overwrite the newer in-flight reference. Guard with `=== promise`.

### Low

- `worker/server.js:56` startup banner claims "bound to localhost only" regardless of `WORKER_HOST` override.
- `tmdbFetch` body accumulator is unbounded — `server.js:619-623`.
- `_writeMetadataNow` directory-fsync error path swallows without logging — `library-manager.js:5358-5362`.

---

## Security — HTTP / server-side (27 findings)

### Critical

- **SSRF blocklist gaps** — `server.js:4818-4854`. Regex-based; misses `::ffff:169.254.169.254` (IPv6-mapped IMDS), `fc12::1` ULA, decimal/hex IP encodings, `metadata.google.internal`. PoC: `GET /api/iptv/channels?url=http://[::ffff:a9fe:a9fe]/latest/meta-data/`. Fix: parse via `net.isIP` + range checks (BigInt or `ipaddr.js`).
- **Cast SSRF via `device.location` / `device.host`** — `server.js:5282-5306` → `cast-manager.js:85-119` → `local-discovery.js:313-352`. Both fields are attacker-controlled in `POST /api/cast/play`; only `soapAction` does a partial loopback check and the location-fetch in `getAVTransportControlURL` has *no* SSRF check. Fix: only accept devices that match a recently-discovered entry in `discoveryCache`.
- **`/api/iptv/stream` is an unauthenticated SSRF + open-redirect proxy** — `server.js:5030-5116`. The redirect path forwards `upstream.headers.location` into a same-origin URL without re-validation.

### High

- **`disk_*` ID path leak** — `library-manager.js:3574-3608`. `relPath = id.slice(5)` joined into `libraryPath`; `_isPathSafe` passes for files inside the library, but no media-extension check. `GET /api/library/disk_..%2F_metadata.json/stream` returns the JSON file. Fix: call `isFileNameSafe(relPath, 'any')` and reject filenames starting with `_` or matching `\.json$`.
- **CSRF bypass on missing Origin** — `server.js:231-242`. `if (!origin) return next();` — `curl`, no-cors `fetch`, `<form>` POSTs all skip the check. No SameSite cookie, no token. Fix: require Origin (reject if missing for non-GET methods), or implement a true CSRF token, or enforce `API_KEY` for all `/api/*`.
- **`/api/iptv/stream` open egress proxy** reachable on LAN; allows 500MB/request attributed to the home IP.
- **`/api/diagnostics/system` and `/api/library/debug` localhost-auth bypass** — `server.js:2500-2504, 2664-2666`. Use `req.socket.remoteAddress === '127.0.0.1'`. Behind any reverse proxy this becomes universally true. Fix: gate behind a separate `DIAG_KEY` or refuse when `app.get('trust proxy')` is truthy.
- **Cover-proxy SSRF chain** — `server.js:1056-1090`. `/api/cover/release/:mbid` performs no SSRF validation and follows up to 3 redirects. coverartarchive is public today, but DNS hijack or future open-redirect at archive.org yields full SSRF.
- **HLS dir collision** — `server.js:332-342`. `_hlsSessionDirFor` sanitizes to `\w-`, so two different raw ids can collapse to the same dir. Key `hlsSessions` Map by the sanitized name, not the raw `req.params.id`.
- **Worker SOAP smuggle via `streamPath`** — `server.js:5296`. `streamPath` is taken from request body with only truthiness check; cast device fetches arbitrary same-origin URL. Validate against `^/api/(play|library|music-library)/[A-Za-z0-9._/-]+(\?.*)?$`.
- **`worker/install.ps1:172-183`** — `WORKER_SECRET` baked into world-readable `.cmd`. Use DPAPI / SYSTEM-only ACLs.

### Medium

- ReDoS via `FRANCHISE_PATTERNS` on `/api/collections/enrich?names=…` with 200 long crafted names (`server.js:1465+`).
- Cache poisoning of `_streamCache`/`_tmdbCache`/`_addonProxyCache`/`playlistCache` — keys don't include auth tier.
- `/api/addon-proxy` JSON.parse of up to 10MB into 256-entry LRU → ~2.5GB worst case.
- `/api/play/youtube/:videoId` regex allows leading `-`; yt-dlp is multipurpose and resolves arbitrary URLs.
- `/api/cast/devices?refresh=1` triggers 5s SSDP broadcast with no concurrency cap → amplification.
- 30+ handlers do `res.status(500).json({ error: err.message })` leaking filesystem paths and ffmpeg stderr.
- Worker `crypto.timingSafeEqual` correctly used, but `WORKER_SECRET=""` (empty env) makes `!SECRET` truthy → no-auth mode while binding may still be 0.0.0.0 if `WORKER_HOST` is set independently.

### Low

- CSP allows `'unsafe-inline'` for style (`server.js:535-543`).
- `Buffer.from(string, 'base32')` in `/api/library/add-manual` is brittle (Node has no native base32).
- M3U playlist cache 20 × 10MB = 200MB resident worst case.

---

## Security — Shell / deploy / supply chain (22 findings)

### Critical-tier

- `jetson_setup.sh:909` — `curl -fsSL https://tailscale.com/install.sh | sh`. Pipe to shell, no checksum, runs as root.
- `mobile-ui/Dockerfile:204` — `curl -fsSL https://deb.nodesource.com/setup_20.x | bash -`. Same pattern inside image build.

### High

- yt-dlp downloaded with no checksum (`jetson_setup.sh:492`, Dockerfile:208).
- `get.docker.com` downloaded then `sh`-executed (`jetson_setup.sh:658-665`).
- `deploy.sh:18-22` — `set -a; . .env` *sources* the file. A `$(reboot)`-style line executes.
- `alabtross-mobile.service` — no `User=`, `NoNewPrivileges=`, `ProtectSystem=`, `PrivateTmp=`, `CapabilityBoundingSet=`. Runs as root with full ambient caps.
- `deploy.sh:140-155` — `docker run --net=host` for the public mobile UI container. Mobile UI has no auth by default.

### Medium

- Worker `WORKER_SECRET=` (empty env) collapses `BIND_HOST` to 127.0.0.1 but `WORKER_HOST=0.0.0.0` overrides → unauth tailnet transcoder.
- `worker/install.ps1` — `Gyan.FFmpeg` winget install unpinned; scheduled task runs as SYSTEM.
- DuckDNS crontab edit is non-atomic; can silently drop other entries mentioning `duck.sh`.
- NVIDIA repo dearmor failure swallowed with `|| true`.
- Dockerfile `npm ci --production 2>/dev/null || npm install --production` — falls back to mutating install on any failure; `--production` is deprecated (use `--omit=dev`).
- Dockerfile base `nvcr.io/nvidia/l4t-jetpack:r36.4.0` pinned to floating tag, no digest.
- `Keylost/jetson-ffmpeg` cloned at HEAD-of-master in Dockerfile.

### Low

- `.gitignore` narrow — doesn't exclude `*.env`, `*.key`, `*.pem`, `worker/launch-worker.cmd`.
- `mobile-ui/.dockerignore` missing — `.env`, `*.log`, `tests/`, `*.md` will COPY into the image if present.
- `deploy.sh:42-43, 50, 140` — heavy `sudo docker` usage instead of `docker` group membership.

### Positive

- All `child_process.spawn` uses array form — no command injection.
- `crypto.timingSafeEqual` for worker secret.
- Tempfiles use `crypto.randomBytes(8)`.
- Container runs as non-root `nodejs` user.
- DuckDNS subdomain validated against `^[a-z0-9-]+$`; LAN bind IP validated via regex.
- NVIDIA container toolkit install uses keyring + `signed-by=` correctly — use as template for the others.

---

## Performance (35 findings)

### Critical

- HLS playlist read every 200ms via `fs.promises.readFile` (`server.js:4582`). Replace with `fs.watch` on the session dir.
- `_resumeInterruptedDownloads` does sync `existsSync`+`statSync` in a loop over potentially hundreds of items at startup (`library-manager.js:5063-5137`).
- `_findVideoFilesRecursive` (`library-manager.js:2450`) and `auditDiskState` walks (`:780-840`) are fully synchronous recursion. Convert to the async sibling already at `:5624`.
- Live ffmpeg invocations omit `-threads` (`server.js:4341-4392, 396-426`). On Jetson Nano (4 cores) ultrafast x264 auto-detects all cores, starving Node + BT verify.
- `compression()` middleware recompresses HLS playlists every poll. Add `Cache-Control: no-transform` on the playlist response.
- `_writeMetadataNow` `JSON.stringify` of multi-MB metadata blob on the event loop (`library-manager.js:5301-5323`). Worker-thread stringify or per-pack files.

### High

- HLS segment-wait loop fires `fs.promises.stat` every 150ms until segment appears (`server.js:4630`).
- Startup `fs.readdirSync(HLS_CACHE_PATH)` + per-leftover `fs.rmSync` (`server.js:317-326`).
- `rateLimitMap` cleanup grows unbounded between sweeps; `concurrencyGate.perIp` never sweeps (`server.js:256-287`).
- `/api/collections/enrich` does hardcoded 300ms sleeps between 5-item batches — up to ~12s per request for 200 ids (`server.js:1572-1599`).
- `_sanitizeItem.canRepair` triggers O(n) recovery-index build per item ⇒ O(n²) sanitize (`library-manager.js:7271-7273`).
- `/api/cache` does N+1 sequential `fs.promises.stat` (`server.js:2393-2430`).
- `/api/collections/:collectionId` — same hardcoded 300ms sleep between batches (`server.js:1672-1700`).
- `/api/library` ETag includes `Math.floor(Date.now()/2000)`, busting the version-counter cache every 2s.
- `/api/library/repair-metadata` and `auto-match-all` block in-flight for minutes; return `202 Accepted` and run in background.
- `stream-providers.js` Promise.all fanouts to 6+ providers share `maxSockets: 8` agent → queue starves under concurrent stream lookups.
- `app.js:5320-5400` library poll rebuilds `cardMap` every tick from `querySelectorAll`.

### Medium / Low

- `_fetchImage` cover proxy buffers up to 8MB in JS heap.
- `parseM3U` upfront parse can take 5–10s on 100k-channel IPTV lists (block event loop). Stream-parse.
- `_probeFile` does sync `fs.statSync` before async ffprobe (`library-manager.js:6816, 5713`).
- `app.js:1078-1112` card HTML uses no `srcset` for retina/mobile.
- `app.js:5293, 5311` `replaceLibraryCardInPlace` uses `wrapper.innerHTML = renderHTML` per item — many parses per tick on mass status transitions.
- `app.js:5318` no IntersectionObserver / virtual scroll on long libraries.
- 4 periodic timers (worker-health 455, auto-retry 4478, periodic save 4460) run independently every 30s. Coalesce.
- `Cache-Control: no-store` on `/api/library/:id/stream` (line 4110) forces full re-download on Safari scrub. Use `private, max-age=0, must-revalidate`.
- 18 more — see full performance report.

---

## Concurrency & state (31 findings)

Five antipatterns dominate:

1. **Async slot reservation done AFTER `await`** (H1, H2, H7). Two concurrent queue ticks can both spawn ffmpeg for the same item. Fix: reserve `_convertProcesses.set(id, {placeholder:true})` synchronously before the first await; replace with the real handle after spawn.
2. **Cleanup tied to handlers that may not fire** (H6 HLS lock; `_remuxInFlight`; `_streamStats`). Pair every `set` with an active timeout, not only "delete on event."
3. **Stale state through engine recycle** (H3). `_destroyEngine` doesn't `removeAllListeners()`; `engine.on('wire')` keeps mutating peer-cache state on the destroyed engine.
4. **Counter never reset on success** (`_packStallRecycles`, `_autoRetryState`, `goodPeers` order-broken eviction).
5. **Cast session-swap antipattern on `device.id`** — `player.on('status')` closure unconditionally `activeSessions.delete(device.id)` when the OLD player goes IDLE, wiping the NEW session.

Full file:line list of 31 findings in the agent transcript.

---

## Browser / frontend (55 findings)

Highlights:

- `window.open(url, '_blank')` with no `noopener,noreferrer` (`app.js:7531`).
- `Object.assign(state, JSON.parse(localStorage))` with no schema validation (`music-queue.js:58`).
- `JSON.parse(btn.dataset.device)` with no try/catch (`app.js:7162`).
- `meta.background` and IPTV channel `logo` bypass `isSafePosterUrl` (`app.js:1685, 1287`).
- `AbortSignal.timeout()` unguarded on iOS 15 (`api.js`).
- `MutationObserver` on `dom.homeCatalogs` never disconnected.
- `beforeunload` resume-tracker listener can stack across edge-case nav paths.
- No focus trap on modals (relink, categorize, manual-import, cast picker).
- Toast div lacks `role="status" aria-live="polite"`.
- Icon-only buttons missing `aria-label` (only `title=`).
- Global `keydown` Space/k/f handler hijacks button activation when focus lands in player area.
- `prefers-reduced-motion` ignored by JS parallax + ripple.
- `qrcode.js` Reed-Solomon synchronous on main thread — Web Worker candidate.
- 8 concrete extractions from `app.js` with line ranges (PlayerService, LibraryService, DownloadsPanel, SettingsPanel, NavigationService, CastService, CatalogHome, LibraryPlaybackService).

---

## Architecture

### Worst module-by-module scope creep

`library-manager.js` (7,314 LOC) owns 10+ unrelated subsystems: engine pool, metadata persistence, pack catalog, peer cache, conversion pipeline (local + remote), filename parsing, disk audit, probe cache, repair-magnet recovery, disk-space gating, discovery cache, CPU monitor wiring, worker health probe, auto-retry daemon, music ingest glue.

### Boundary violations: `server.js` reaching into `library._private`

Eleven sites, with line refs:

- `server.js:2727-2728` — `library._items.size`, `library._items.keys()`
- `server.js:3121, 3355, 3486` — `library._metadataFile` for backup paths
- `server.js:3168` — `library._deriveShowNameFromFile(item.fileName)`
- `server.js:3230` — `library._deriveMovieNameFromFile(item.fileName)`
- `server.js:3407, 3506` — `library._items.get/delete`
- `server.js:3430, 3508` — `library._saveMetadata()`
- `server.js:4694` — `library._probeFile(filePath)`
- `server.js:5132` — `library._maxConcurrentDownloads = value`

Each is a missing public method (`snapshotItems`, `metadataBackupPath`, `deriveTitle`, `mutateItem`, `persistNow`, `probe`, `setMaxConcurrentDownloads`).

### Browser ↔ server contract drift

- `fileNameLooksLikeEpisode` in `server.js:3052` and `library._looksLikeEpisode` + `parseFileName` in `library-manager.js:1681, 1717`.
- Quality regex duplicated in `app.js:2159, 2218` and `stream-providers.js:887-970`.
- Codec/profile decode-capability enum hard-coded on both sides (`library-manager.js:5983-6013` and client `caps` token list).

### State-ownership table

| Store | Owner | Mutators | Hazards |
|---|---|---|---|
| `_metadata.json` | LibraryManager | LM + 4 server.js sites | Double-mutation |
| `_pack-catalog.json` | LM only | LM only | None |
| `_torrent-cache/*` | torrent-stream + `_gcTorrentCache` | external + LM | None |
| `settings.json` | server.js | server.js only | CPU-protection persisted in settings AND mirrored onto each LM — drift risk |
| `collection-cache.json` | server.js | 3 sites | Sync write on every enrichment, no debounce |
| `manual-categories.json` | server.js | server.js only | Same pattern |
| `peer-*.json` per infohash | LM `_flushPeerCache` | LM | Separate from `peer-reputation.js`'s file |
| `_items` Map | LM | LM + server.js direct mutations | Direct mutation bypasses change tracking |
| `_probeCache` | module-scope shared across both LM instances | LM | Cross-instance eviction |
| `_getAllCache` / `_discoveryCache` | LM | LM | `promoteDiskItem` only nulls one |
| `_streamCache` (stream-providers) | provider module | provider module | LRU touch broken under concurrent in-flight |
| `dnsCache` | duplicated between provider + server | both | No shared resolver |
| HLS session Map + `_hlsLocks` | server.js | server.js | Lock never resolved on early-return |
| TMDB cache + inflight | server.js | server.js | OK |
| MusicBrainz | **no cache** | — | Every page load hits MB at 1 req/s |

### 8-step migration plan (each ≈ 1 dev-week)

1. **Extract `AppConfig`** (`app/config.js`). Parse + validate env once. Tests: env snapshot. Unblocks every later step.
2. **Extract `Settings` service** from `server.js:124-176, 5120-5210`. Tests: roundtrip, hysteresis, validation.
3. **Move filename parsing + relevance + extras + episode-detect to `shared/title/`** and switch both `library-manager.js` and `server.js` over. Tests: golden table of 80+ filename → parsed pairs.
4. **Extract `StreamProviderRegistry`** + split scrapers into `lib/stream-providers/sources/*.js`. Define the provider plugin contract (specified below). Tests: snapshot fixtures per scraper.
5. **Extract `ProbeService`** (`_probeCache` + `_probeFile` + `classifyForClient` + `_isBrowserDecodable`). Tests: probe→classify table.
6. **Extract `ConversionPipeline`** (`library-manager.js:6127-7232` + CPU monitor + worker fallback). Tests: fake-ffmpeg, fairness, cooldown loop, priority matrix.
7. **Extract `DownloadScheduler`** (engines, pack progress, slots, peer cache, stall recycle, auto-retry).
8. **Reduce `LibraryManager`** to `LibraryStore` (items + metadata + audit only). Split `server.js` into `routes/{streams,library,library-stream,music,metadata,settings,diagnostics,iptv,cast}.js`.

### Provider plugin contract

```ts
interface StreamProvider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: {
    movies?: boolean; series?: boolean;
    seasonPacks?: boolean; completePacks?: boolean;
    audio?: boolean;
    requiresImdbId?: boolean;
    requiresTitle?: boolean;
    supportsAnime?: boolean;
  };
  readonly priority?: number;
  search(query: SearchQuery, ctx: ProviderCtx): Promise<RawStream[]>;
  diagnose?(ctx: ProviderCtx): Promise<{ ok: boolean; reason?: string }>;
}

SearchQuery = {
  kind: 'movie' | 'series' | 'seasonPack' | 'completePack' | 'album' | 'discography',
  imdbId?: string, title?: string, year?: string,
  season?: number, episode?: number, absEp?: number, genres?: string[],
  artist?: string, mbid?: string
}

ProviderCtx = { http, dns, log, signal, config }
```

---

## Code quality

### Worst functions

1. `library-manager.js:607` `auditDiskState` — ~292 LOC, CC ~35
2. `library-manager.js:163` constructor — ~232 LOC, CC ~25
3. `library-manager.js:1929` `_trackPackProgress` — ~199, CC ~30
4. `library-manager.js:1136` `addSeasonPack` — ~189, CC ~24 (90% overlap with `addManual`)
5. `library-manager.js:1336` `addManual` — ~180, CC ~22
6. `library-manager.js:3917` `_startDownload` — ~172, CC ~20
7. `library-manager.js:5387/5547` `_discoverUntrackedFilesSync/Async` — 152/127, 95% identical
8. `library-manager.js:2315` `repairPackMetadata` — ~131, CC ~24
9. `library-manager.js:6127` `_checkAndConvert` — ~125, CC ~18
10. `server.js:1977` `searchCandidates` — ~108
11. `app.js:4898` `tryLibraryStream` — ~164, CC ~22

### Duplication hotspots

- `_discoverUntrackedFilesSync` vs `_discoverUntrackedFilesAsync` (95% identical)
- Junk-file regex `\b(sample|trailer|extra|bonus|featurette|interview)\b/i` repeated 4 places
- `PACK_MIN_FILE_SIZE = 10*1024*1024` declared inline 3 places
- `MIN_VIDEO_SIZE = 50*1024*1024` declared inline 2 places
- Quality regex `\b(2160p|1080p|720p|480p)\b/i` repeated 5 places
- Magnet/infohash extraction duplicated 4 places (`torrent-engine.js:797`, `server.js:3548`, `stream-providers.js:567/1579`)
- ffmpeg spawn skeleton repeats in `server.js:396, 4179, 4341` and `library-manager.js:6602`
- DNS fallback resolver in `server.js:11-30` and `stream-providers.js:22-61`

### Magic-number consolidations

Proposed homes:

- `lib/file-safety.js`: `PACK_MIN_FILE_BYTES`, `MIN_PLAYABLE_VIDEO_BYTES`, `MAX_FILENAME_LEN`, `INFOHASH_TAG_LEN`, `IMDB_ID_RE`, `JUNK_FILE_REGEX`
- `lib/format.js`: `BYTES_PER_GB`, `formatGB(bytes)`, `formatSpeed(bytes)`
- `lib/timing.js`: `ONE_MINUTE_MS`, `FIVE_MINUTES_MS`, `THIRTY_MIN_MS`, `ONE_HOUR_MS`, `CPU_COOLDOWN_MS`
- `lib/ffmpeg-hw.js`: `LIVE_TRANSCODE_MAX_WIDTH`, `ARCHIVAL_MAX_WIDTH`, `AAC_STEREO_AAC_ARGS`

### Logging

- 528 `console.*` calls, ~50 unique tag prefixes including typos `[Ee]`, `[Pp]`, `[Ss]` near `server.js:547`.
- No log levels; one-off `DEBUG_PLAYBACK` flag.
- Zero `TODO`/`FIXME`/`XXX`/`HACK` markers anywhere in 30k LOC.

### Lint gaps

No `.eslintrc.*` / `.prettierrc.*` / `.editorconfig`. ~60 `catch {}` empty handlers; ~20 `== null` cases; mixed `module.exports = X` vs `module.exports = { X }`; no `npm run lint` script.

Proposed `mobile-ui/.eslintrc.json`:

```json
{
  "extends": "eslint:recommended",
  "parserOptions": { "ecmaVersion": 2022, "sourceType": "script" },
  "env": { "node": true, "es2022": true, "browser": true },
  "rules": {
    "no-empty": ["error", { "allowEmptyCatch": true }],
    "eqeqeq": ["error", "always", { "null": "ignore" }],
    "no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
    "no-var": "error",
    "prefer-const": "warn"
  }
}
```

---

## Testing

Existing suite: **23/23 passing**, covering filename heuristics only. ~19,000 LOC of `lib/` is untested.

### Modules that unlock testing with a one-line opt-in

- `LibraryManager` — `{ noAutoInit: true }` to gate `_loadMetadata`, `_initAsync`, `PeerReputation` ctor, `fs.mkdirSync`.
- `TorrentEngine` — inject `opts.engineFactory = torrentStream`.
- `PeerReputation` — `{ skipLoad: true, now: () => fakeTs }`.
- `CpuMonitor` — inject `opts.snapshotFn`.
- `MusicPlaylists` — `{ skipLoad: true }`.

### Pure functions needing only an `export`

`peer-manager.js`: `ipOf`, `isBogusAddr`.
`local-discovery.js`: `parseSSDPResponse`, `extractXmlTag`, `isLocationSafe`.
`cast-manager.js`: `escapeXml`, `extractXmlValue`.
`stream-providers.js`: `sanitizeImdbId`, `buildMagnet`, `detectFormat`, `needsRemux`, `filterAndRank`, `isSeasonPack`, `parsePackSizeBytes`, `isCompletePack`, `_audioClassify`.

### Test files to write first (priority order)

1. `tests/file-safety.test.js` — path traversal, double-extension `.mp4.exe`, MIME fallback, kind branching.
2. `tests/stream-providers-pure.test.js` — `detectFormat`, `needsRemux`, `parsePackSizeBytes`, `isSeasonPack`, `filterAndRank` ordering.
3. `tests/ffmpeg-hw.test.js` — cuvid/nvmpi/none decode matrix, scale filter, nvmpi pix_fmt rejection.
4. `tests/peer-reputation.test.js` — strike accumulation, good-bytes carve-out, LRU eviction, stale drop on load, atomic write.
5. `tests/peer-manager-helpers.test.js` — `ipOf`, `isBogusAddr` boundary cases (after exporting).
6. `tests/local-discovery-pure.test.js` — SSDP parse, `isLocationSafe` SSRF guard.
7. `tests/cast-manager-soap.test.js` — `escapeXml`, `extractXmlValue`, `soapAction` loopback rejection.
8. `tests/library-manager-state.test.js` — `getReviewQueue`, `_computeMatchState`, `_sanitizeItem`, `_safeDirectoryName`, addItem/removeItem roundtrip.
9. `tests/cpu-monitor.test.js` — hysteresis, sustained-overload window.
10. `tests/music-playlists.test.js` — CRUD roundtrip, atomic save.
11. `tests/torrent-engine-helpers.test.js` — `_extractHash`, `_active` eviction.
12. `tests/system-diag.test.js` — `/proc` parsing.
13. `tests/worker-client.test.js` — health-check TTL extension.
14. `tests/integration-server-smoke.test.js` — `/health`, `/api/library`, 304 ETag (requires `createApp()` extraction).
15. `tests/stream-providers-network.test.js` — mock HTTP server, dedup across providers, mirror fallback.

### CI proposal

GitHub Actions matrix on Node 20/22/24, `node --test --experimental-test-coverage`, plus `bash -n` and `shellcheck` for shell scripts. Coverage target: lines ≥ 60% on `lib/*` (excluding `library-manager.js` until split).

---

## Dependencies

### `npm audit` results

6 high, 0 critical/moderate. All under `torrent-stream`:

| Pkg | Severity | Advisory | CVSS |
|---|---|---|---|
| ip ≤2.0.1 | high | GHSA-2p57-rm9w-gvfp (SSRF) | 8.1 |
| ws 2.0.0–5.2.3 | high | GHSA-5v72-xg48-5rpm + GHSA-3h5v-q93c-6h6q | 7.5 ea. |
| bittorrent-tracker / ip-set / torrent-discovery | high | inherits ip SSRF | — |
| torrent-stream ≥0.14.0 | high (direct) | aggregator | — |

### Lockfile drift

`mobile-ui/package-lock.json` declares `http-proxy-middleware ^3.0.0` in the root `packages.""` entry, but `package.json` does not list it. `npm ci` will refuse to install. Regenerate.

### `castv2-client@^1.4.0`

**Unsatisfiable** — no 1.4.x exists on npm; latest is 1.2.0 (2022). `npm install` reports `UNMET OPTIONAL DEPENDENCY`. Switch to `castv2` direct (still maintained); cast-manager already wraps the protocol behind a thin abstraction.

### `torrent-stream` → `webtorrent` migration

API surface used today: `torrentStream(uri, opts)`, events `ready`/`download`/`idle`, `engine.files[i]` with `.select()/.deselect()/.createReadStream()`, `engine.swarm.{downloadSpeed, uploadSpeed, wires, peers}`, `engine.bitfield`, `engine.block(ip)`, `engine.connect(addr)`, `engine.listen(cb)`, `engine.destroy(cb)`.

WebTorrent equivalents (`webtorrent@2.8.5`):

- `client = new WebTorrent({ dht, tracker, maxConns })`, then `client.add(magnet, { path, announce })`.
- Same event names; `torrent.files` shape unchanged.
- `torrent.bitfield.buffer` uses `bitfield@4` (different bit-order vs `bitfield@0.1.0`) — one-line tweak in `_computeProgress`.
- No `engine.block(ip)` — use `blocklist` option at client construction (accepts function), then rebuild on bans.
- No `engine.connect(addr)` — use `torrent.addPeer(addr)`.
- DHT defaults to IPv4+IPv6 (torrent-stream is v4-only) — audit the "all-IPv6 swarm" tracker comment at `library-manager.js:4313`.
- WebRTC peers on by default — disable via `private: true` for parity, or keep as a feature win.
- Persistent `.torrent` metadata cache: webtorrent doesn't write `.torrent` automatically; dump `torrent.torrentFile` to disk on `metadata` event.

Rollout: introduce `TORRENT_BACKEND` env var; ship adapter; staging side-by-side for a week; flip default; remove old path one minor release later.

### Direct deps status

| Pkg | Declared | Latest | Action |
|---|---|---|---|
| express | ^4.21.0 | 5.2.1 | bump — Express 5 resolves trailing body-parser/cookie/qs/send chain |
| cheerio | ^1.0.0 | 1.2.0 | keep (caret already covers) |
| compression | ^1.8.1 | 1.8.1 | keep |
| torrent-stream | ^1.2.1 | 1.2.1 (unmaintained subtree) | replace with webtorrent |
| castv2-client | ^1.4.0 (unsatisfiable) | 1.2.0 (abandoned) | replace with castv2 |

### License audit

Clean. 184 MIT, 11 ISC, 10 BSD-2-Clause, 1 BSD-3-Clause, 1 MIT/X11 (`hat@0.0.3` — MIT-equivalent), 2 unknown (`bitfield@0.1.0`, `compact2string@1.4.1` — both BSD-2 from source). **Zero GPL/AGPL/LGPL.**

### CI supply-chain proposal

- `npm audit --omit=dev --audit-level=high` gate.
- Dependabot grouped by `express-stack` and `cheerio-stack`, with `torrent-stream` ignored (manual migration).
- Docker & GitHub Actions updates on monthly cadence.

---

## Execution order (suggested)

1. Regenerate lockfile (drops `http-proxy-middleware` orphan); fix Dockerfile `npm ci || npm install`.
2. Auth/CSRF — refuse to start without API_KEY in non-loopback bind; reject state-changing requests with missing Origin.
3. Cast SSRF + `disk_*` path-leak — allow-list devices against `discoveryCache`; reject `disk_*` IDs that don't resolve to a media-extension file.
4. SSRF blocklist rewrite — `net.isIP` + range checks (or `ipaddr.js`); include `::ffff:169.254.169.254`, ULA, GCP/Azure IMDS, `0.0.0.0/8`.
5. HLS waiter deadlock — resolve/reject `lockPromise` on every early-return path.
6. Hot-path sync-fs — async `_resumeInterruptedDownloads`, async audit walks, `fs.watch` on HLS session dir.
7. `-threads` cap on live ffmpeg in `buildLiveEncoderArgs`.
8. Conversion slot pre-reservation in `_convertProcesses`.
9. Engine recycle: `removeAllListeners` in `_destroyEngine`; cast-session identity check in `player.on('status')`.
10. Export pure functions + land the first 5 test files so subsequent refactors are made safely.

The architecture migration (8-step plan above) is the multi-month follow-up; do not attempt it in the same series as the bug fixes.
