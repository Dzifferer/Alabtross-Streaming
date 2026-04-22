/**
 * Albatross Mobile — Main Application
 *
 * Mobile-first streaming interface with:
 * - Auto stream speed testing (picks fastest source)
 * - VPN safety checks (warns if not on Tailscale)
 * - Catalog browsing, search, detail views
 * - Built-in video player
 */

(function () {
  'use strict';

  // Playback event tracing (added in b2f63a5 to diagnose direct playback
  // stalls on a single problem file). Firehose-style — one console.log
  // per video element event during load, including 'progress' which
  // fires many times per second. Gated off by default so it doesn't
  // pile console I/O onto every failing playback attempt in production.
  // Flip to true when actively debugging playback.
  const DEBUG_PLAYBACK = false;

  let _streamLoadGeneration = 0; // incremented each loadStreams call to detect stale async completions

  // ─── State ───────────────────────────────────────

  const state = {
    currentView: 'home',
    viewHistory: [],
    currentType: null,    // 'movie' or 'series'
    currentMeta: null,
    currentSeason: 1,
    currentSeasonEp: null, // { season, episode } for the episode currently loaded/playing
    searchTimeout: null,
    vpnVerified: false,
    activeFilter: '',     // currently selected filter chip value
    playerStarted: false, // true after first 'playing' event, prevents overlay clobber during initial load
  };

  // ─── Auto-play Next Settings ─────────────────────
  // When a movie or episode finishes, the client can automatically line up the
  // next item in the series (by season/episode) or in the TMDB collection (by
  // release year) and start playing it after a short countdown.
  const AUTOPLAY_DEFAULT_COUNTDOWN = 8;

  function getAutoplaySettings() {
    try {
      const enabledRaw = localStorage.getItem('autoplay_next_enabled');
      const countdownRaw = localStorage.getItem('autoplay_next_countdown');
      const countdown = parseInt(countdownRaw, 10);
      return {
        enabled: enabledRaw === null ? true : enabledRaw === 'true',
        countdownSeconds: Number.isFinite(countdown) && countdown >= 0 ? countdown : AUTOPLAY_DEFAULT_COUNTDOWN,
      };
    } catch {
      return { enabled: true, countdownSeconds: AUTOPLAY_DEFAULT_COUNTDOWN };
    }
  }

  function setAutoplaySettings({ enabled, countdownSeconds }) {
    try {
      if (enabled != null) localStorage.setItem('autoplay_next_enabled', String(!!enabled));
      if (countdownSeconds != null) localStorage.setItem('autoplay_next_countdown', String(countdownSeconds));
    } catch { /* ignore quota errors */ }
  }

  // ─── Resume Playback (video progress) ────────────
  // Remember where the user was watching each video so playback can pick
  // up after a disconnection, a manual exit, or a tab close. A single
  // localStorage entry holds an object keyed by a stable source identifier
  // (torrent infoHash+fileIdx, library item id, or direct URL). Each entry
  // stores { time, duration, updatedAt, title }. Saves are throttled to
  // once every few seconds during playback plus forced saves on pause,
  // visibilitychange, and beforeunload.
  const RESUME_STORAGE_KEY = 'video_progress_v1';
  const RESUME_MIN_SECONDS = 10;       // ignore resumes for first few seconds
  const RESUME_NEAR_END_SECONDS = 30;  // treat last 30s as "finished"
  const RESUME_SAVE_THROTTLE_MS = 5000;
  const RESUME_MAX_ENTRIES = 200;

  function loadResumeStore() {
    try {
      const raw = localStorage.getItem(RESUME_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch { return {}; }
  }

  function writeResumeStore(store) {
    try {
      const keys = Object.keys(store);
      if (keys.length > RESUME_MAX_ENTRIES) {
        keys.sort((a, b) => (store[a].updatedAt || 0) - (store[b].updatedAt || 0));
        const removeCount = keys.length - RESUME_MAX_ENTRIES;
        for (let i = 0; i < removeCount; i++) delete store[keys[i]];
      }
      localStorage.setItem(RESUME_STORAGE_KEY, JSON.stringify(store));
    } catch { /* quota or serialization — drop silently */ }
  }

  function getResumeEntry(key) {
    if (!key) return null;
    const store = loadResumeStore();
    return store[key] || null;
  }

  function saveResumeEntry(key, time, duration, meta) {
    if (!key) return;
    if (!Number.isFinite(time) || time < 0) return;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const store = loadResumeStore();
    store[key] = {
      time,
      duration,
      updatedAt: Date.now(),
      title: (meta && meta.title) || (store[key] && store[key].title) || '',
    };
    writeResumeStore(store);
  }

  function clearResumeEntry(key) {
    if (!key) return;
    const store = loadResumeStore();
    if (store[key]) {
      delete store[key];
      writeResumeStore(store);
    }
  }

  function resumeKeyForStream(stream) {
    if (!stream) return null;
    if (stream.infoHash) {
      const idx = stream.fileIdx !== undefined && stream.fileIdx !== null ? stream.fileIdx : 'main';
      return `torrent:${stream.infoHash}:${idx}`;
    }
    if (stream.url) return `url:${stream.url}`;
    return null;
  }

  function resumeKeyForLibrary(id) {
    if (!id) return null;
    return `library:${id}`;
  }

  function shouldResume(entry, duration) {
    if (!entry) return false;
    const t = Number(entry.time);
    if (!Number.isFinite(t) || t < RESUME_MIN_SECONDS) return false;
    const dur = Number.isFinite(duration) && duration > 0 ? duration : entry.duration;
    if (Number.isFinite(dur) && dur > 0 && t > dur - RESUME_NEAR_END_SECONDS) return false;
    return true;
  }

  function formatResumeTimecode(secs) {
    const s = Math.max(0, Math.floor(secs));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
  }

  // Seek the video element to a saved resume time if one exists and is
  // worth resuming to. Intended to be called after the element has enough
  // metadata to accept a seek (e.g. on loadedmetadata/canplay). Returns
  // true if a seek was performed.
  function applyResumeSeek(key) {
    if (!key) return false;
    const entry = getResumeEntry(key);
    if (!shouldResume(entry, dom.videoPlayer.duration)) return false;
    try {
      dom.videoPlayer.currentTime = entry.time;
      showToast(`Resumed at ${formatResumeTimecode(entry.time)}`);
      return true;
    } catch (e) {
      console.warn('[resume] seek failed:', e);
      return false;
    }
  }

  // Attach listeners that persist the current playback position. Returns
  // a detach function; pass false to skip the final save-on-detach.
  let _resumeTrackerDetach = null;
  function attachResumeTracker(key, meta) {
    if (!key) return () => {};
    const v = dom.videoPlayer;
    let lastSaveAt = 0;

    const persist = (force) => {
      const dur = v.duration;
      if (!Number.isFinite(dur) || dur <= 0) return;
      if (v.currentTime <= 0.5) return; // ignore preload zero
      const now = Date.now();
      if (!force && now - lastSaveAt < RESUME_SAVE_THROTTLE_MS) return;
      lastSaveAt = now;
      // Past the near-end cutoff we treat it as done — clear instead of save.
      if (v.currentTime > dur - RESUME_NEAR_END_SECONDS) {
        clearResumeEntry(key);
        return;
      }
      saveResumeEntry(key, v.currentTime, dur, meta);
    };

    const onTimeUpdate = () => persist(false);
    const onPause = () => persist(true);
    const onEnded = () => clearResumeEntry(key);
    const onBeforeUnload = () => persist(true);
    const onVisibility = () => { if (document.visibilityState === 'hidden') persist(true); };

    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onEnded);
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('visibilitychange', onVisibility);

    return function detach(saveOnDetach) {
      if (saveOnDetach !== false) persist(true);
      v.removeEventListener('timeupdate', onTimeUpdate);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onEnded);
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }

  function stopResumeTracker(saveOnDetach) {
    if (_resumeTrackerDetach) {
      try { _resumeTrackerDetach(saveOnDetach); } catch { /* ignore */ }
      _resumeTrackerDetach = null;
    }
  }

  // ─── DOM Refs ────────────────────────────────────

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const VIEW_MAP = {
    'home': 'view-home',
    'movies': 'view-home',
    'series': 'view-home',
    'search': 'view-search',
    'detail': 'view-detail',
    'settings': 'view-settings',
    'library': 'view-library',
    'share': 'view-share',
    'player': 'view-player',
  };

  const dom = {
    backBtn: $('#back-btn'),
    pageTitle: $('#page-title'),
    searchToggle: $('#search-toggle'),
    searchBar: $('#search-bar'),
    searchInput: $('#search-input'),
    searchClear: $('#search-clear'),
    settingsToggle: $('#settings-toggle'),
    content: $('#content'),
    homeLoading: $('#home-loading'),
    homeCatalogs: $('#home-catalogs'),
    searchResults: $('#search-results'),
    searchEmpty: $('#search-empty'),
    detailContent: $('#detail-content'),
    videoPlayer: $('#video-player'),
    playerOverlay: $('#player-overlay'),
    playerBackBtn: $('#player-back-btn'),
    castBtn: $('#cast-btn'),
    castOverlay: $('#cast-overlay'),
    castDeviceName: $('#cast-device-name'),
    castStopBtn: $('#cast-stop-btn'),
    castDevicePicker: $('#cast-device-picker'),
    castDeviceList: $('#cast-device-list'),
    bottomNav: $('#bottom-nav'),
    navBtns: $$('.nav-btn'),
    // Filter bar
    filterBar: $('#filter-bar'),
    filterChips: $$('.filter-chip'),
    // Library
    libraryContent: $('#library-content'),
    libraryEmpty: $('#library-empty'),
    // Settings
    addonList: $('#addon-list'),
    addonUrlInput: $('#addon-url-input'),
    addonAddBtn: $('#addon-add-btn'),
    addonAddCinemeta: $('#addon-add-cinemeta'),
    addonAddTorrentio: $('#addon-add-torrentio'),
    // IPTV / Live TV
    iptvUrlInput: $('#setting-iptv-url'),
    iptvSaveBtn: $('#setting-iptv-save'),
    iptvStatus: $('#iptv-status'),
    liveTvAddonInput: $('#setting-livetv-addon-url'),
    liveTvAddonAddBtn: $('#setting-livetv-addon-add'),
    liveTvAddonStatus: $('#livetv-addon-status'),
  };

  // ─── Recently Played ─────────────────────────────

  function getRecentlyPlayed() {
    try {
      const saved = localStorage.getItem('recently_played');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  }

  function addRecentlyPlayed(type, meta) {
    const items = getRecentlyPlayed();
    const id = meta.imdb_id || meta.id;
    // Remove duplicate if exists
    const filtered = items.filter(i => i.id !== id);
    filtered.unshift({
      id,
      type,
      name: meta.name,
      poster: meta.poster || '',
      releaseInfo: meta.releaseInfo || meta.year || '',
    });
    // Keep last 20
    localStorage.setItem('recently_played', JSON.stringify(filtered.slice(0, 20)));
  }

  // ─── VPN Safety Check ───────────────────────────

  async function checkVPNStatus() {
    // Strategy: Try to detect if we're accessing the server through a
    // private/VPN IP. If the page is served from the Jetson (which is
    // behind Tailscale), the connection itself proves VPN is active.
    // We also check if the server is reachable on its local IP.

    try {
      const resp = await fetch('/api/stats', {
        signal: AbortSignal.timeout(5000),
      });

      if (resp.ok) {
        state.vpnVerified = true;
        return { connected: true };
      }
    } catch (e) {
      // Server unreachable — likely not on VPN
    }

    state.vpnVerified = false;
    return { connected: false };
  }

  function showVPNWarning() {
    const existing = document.querySelector('.vpn-banner');
    if (existing) return;

    const banner = document.createElement('div');
    banner.className = 'vpn-banner fade-in';
    banner.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; z-index: 300;
      padding: calc(env(safe-area-inset-top, 0px) + 12px) 16px 12px;
      background: linear-gradient(135deg, #e74c3c, #c0392b);
      color: white; font-size: 14px; text-align: center;
      display: flex; align-items: center; justify-content: center; gap: 8px;
    `;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.innerHTML = '<path d="M12 9v4M12 17h.01"/><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>';

    const msg = document.createElement('span');
    msg.textContent = 'VPN not detected \u2014 connect to Tailscale for safe streaming';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '\u00d7';
    closeBtn.style.cssText = 'background:none;border:none;color:white;font-size:20px;margin-left:8px;cursor:pointer';
    closeBtn.addEventListener('click', () => banner.remove());

    banner.appendChild(svg);
    banner.appendChild(msg);
    banner.appendChild(closeBtn);
    document.body.prepend(banner);
  }

  // ─── Navigation ──────────────────────────────────

  function navigateTo(view, opts = {}) {
    if (state.currentView !== view) {
      state.viewHistory.push(state.currentView);
    }

    state.currentView = view;

    // Hide all views, show target
    $$('.view').forEach(v => v.classList.remove('active'));

    const target = $('#' + (VIEW_MAP[view] || 'view-home'));
    if (target) target.classList.add('active');

    // Update UI
    updateNavUI(view);
    updateTopBar(view, opts);

    // Clean up stream action bar and preload when leaving detail view
    const actionBar = document.querySelector('.stream-action-bar');
    if (actionBar) actionBar.remove();
    preload.cancel();

    // Abort in-flight speed tests and clean up stale ranked streams when leaving detail
    if (view !== 'detail') {
      if (api._speedTestController) api._speedTestController.abort();
      _lastRankedStreams = [];
      _selectedStreamIndex = -1;
    }

    // Scroll to top
    dom.content.scrollTop = 0;
  }

  function goBack() {
    // If library group overlay is open, close it instead of navigating back
    const libOverlay = document.getElementById('library-group-overlay');
    if (libOverlay && !libOverlay.classList.contains('hidden')) {
      hideLibraryGroupOverlay();
      return;
    }

    preload.cancel();
    _lastRankedStreams = [];
    _selectedStreamIndex = -1;

    const prev = state.viewHistory.pop();
    if (prev) {
      state.currentView = prev;
      $$('.view').forEach(v => v.classList.remove('active'));

      const target = $('#' + (VIEW_MAP[prev] || 'view-home'));
      if (target) target.classList.add('active');
      updateNavUI(prev);
      updateTopBar(prev);
    }

    // Abort in-flight speed tests when leaving detail
    if (api._speedTestController) api._speedTestController.abort();

    // Stop video if leaving player
    if (state.currentView !== 'player') {
      state.playerStarted = false;
      stopResumeTracker(true); // force a final save before we drop src
      clearUpNextOverlay();
      dom.videoPlayer.pause();
      dom.videoPlayer.src = '';
      dom.videoPlayer.load(); // release previous resource from memory
      clearPlayerControlsTimer();
      exitPlayerFullscreen();
    }
  }

  // Enter true fullscreen for immersive playback (mobile + desktop)
  function enterPlayerFullscreen() {
    const container = document.getElementById('view-player');
    try {
      if (container.requestFullscreen) {
        container.requestFullscreen().catch(() => {});
      } else if (container.webkitRequestFullscreen) {
        container.webkitRequestFullscreen();
      }
    } catch (_) { /* fullscreen not supported or blocked — player still fills viewport via CSS */ }
  }

  function exitPlayerFullscreen() {
    try {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else if (document.webkitFullscreenElement) {
        document.webkitExitFullscreen();
      }
    } catch (_) {}
  }

  function updateNavUI(view) {
    dom.navBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === view ||
        (btn.dataset.view === 'home' && !['movies', 'series', 'search', 'detail', 'settings', 'library', 'share', 'player'].includes(view)));
    });

    // Show/hide bottom nav
    const hideNav = view === 'player';
    dom.bottomNav.style.display = hideNav ? 'none' : '';
  }

  function updateTopBar(view, opts = {}) {
    const showBack = ['detail', 'settings', 'share', 'player'].includes(view);
    dom.backBtn.classList.toggle('hidden', !showBack);

    const titles = {
      'home': 'Albatross',
      'movies': 'Movies',
      'series': 'Series',
      'search': 'Search',
      'detail': opts.title || 'Details',
      'settings': 'Settings',
      'library': 'Library',
      'share': 'Share',
      'player': 'Now Playing',
    };
    dom.pageTitle.textContent = titles[view] || 'Albatross';

    // Show/hide top bar in player
    const hideTop = view === 'player';
    $('#top-bar').style.display = hideTop ? 'none' : '';

    // Show search bar and filter bar only on browsing views
    const browsingViews = ['home', 'movies', 'series', 'search'];
    const showSearchAndFilters = browsingViews.includes(view);
    dom.searchBar.classList.toggle('search-bar--hidden', !showSearchAndFilters);
    dom.filterBar.classList.toggle('filter-bar--hidden', !showSearchAndFilters);
  }

  // ─── Home / Catalog Loading ──────────────────────

  async function loadHome(type) {
    state.currentType = type || null;
    dom.homeCatalogs.innerHTML = '';
    dom.homeLoading.classList.remove('hidden');

    // Simple layout: Recently Played, Movies, Shows, Live TV
    if (!type) {
      await loadHomeCustom();
      return;
    }

    const types = type ? [type] : ['movie', 'series'];
    const allCatalogs = [];

    for (const t of types) {
      const cats = await api.getCatalogs(t);
      allCatalogs.push(...cats);
    }

    dom.homeLoading.classList.add('hidden');

    if (allCatalogs.length === 0) {
      dom.homeCatalogs.innerHTML = `
        <div class="empty-state">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
            <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/>
            <path d="M7 2v20M17 2v20M2 12h20"/>
          </svg>
          <p>No catalogs available</p>
          <p style="font-size:13px;color:var(--text-muted)">Add addons in Settings to browse content</p>
        </div>
      `;
      return;
    }

    // Load each catalog row
    for (const catalog of allCatalogs) {
      await loadCatalogRow(catalog);
    }

    // Live TV — append after catalog rows (same as custom mode)
    if (!type) {
      appendLiveTVSection();
    }
  }

  async function appendLiveTVSection() {
    try {
      const tvGroups = await api.getAllLiveTVChannels();
      if (tvGroups.length > 0) {
        for (const group of tvGroups) {
          const tvRow = document.createElement('div');
          tvRow.className = 'catalog-row';
          tvRow.innerHTML = `
            <div class="catalog-row-header">
              <h3 class="catalog-row-title">${escapeHTML(group.sourceName)}</h3>
              <span class="catalog-row-badge">LIVE</span>
              <button class="catalog-row-more livetv-browse-btn">Browse All</button>
            </div>
            <div class="catalog-scroll">${group.channels.slice(0, 30).map(ch => channelCardHTML(ch)).join('')}</div>
          `;
          dom.homeCatalogs.appendChild(tvRow);
          attachChannelListeners(tvRow);
          tvRow.querySelector('.livetv-browse-btn')?.addEventListener('click', () => {
            openChannelBrowser(group);
          });
        }
      } else {
        const sources = api.getLiveTVSources();
        const tvRow = document.createElement('div');
        tvRow.className = 'catalog-row';
        if (sources.length > 0) {
          tvRow.innerHTML = `
            <div class="catalog-row-header">
              <h3 class="catalog-row-title">Live TV</h3>
              <span class="catalog-row-badge">LIVE</span>
            </div>
            <div class="livetv-error-state">
              <p>Unable to load channels — sources may be offline or unreachable.</p>
              <button class="btn-sm livetv-goto-settings">Configure in Settings</button>
            </div>
          `;
        } else {
          tvRow.innerHTML = `
            <div class="catalog-row-header">
              <h3 class="catalog-row-title">Live TV</h3>
              <span class="catalog-row-badge">LIVE</span>
            </div>
            <div class="livetv-error-state">
              <p>No live TV sources configured.</p>
              <button class="btn-sm livetv-goto-settings">Add Sources in Settings</button>
            </div>
          `;
        }
        dom.homeCatalogs.appendChild(tvRow);
        tvRow.querySelector('.livetv-goto-settings')?.addEventListener('click', (e) => {
          e.preventDefault();
          navigateTo('settings');
        });
      }
    } catch (e) {
      console.warn('[LiveTV] Error loading channels for homepage:', e);
    }
  }

  async function loadHomeCustom() {
    // Row 1: Recently Played (sync — from localStorage)
    const recent = getRecentlyPlayed();
    dom.homeLoading.classList.add('hidden');

    if (recent.length > 0) {
      const recentRow = document.createElement('div');
      recentRow.className = 'catalog-row';
      recentRow.innerHTML = `
        <div class="catalog-row-header">
          <h3 class="catalog-row-title">Recently Played</h3>
        </div>
        <div class="catalog-scroll">${recent.slice(0, 20).map(item => cardHTML(item, item.type)).join('')}</div>
      `;
      dom.homeCatalogs.appendChild(recentRow);
      attachCardListeners(recentRow);
    }

    // Show Live TV section FIRST (right after Recently Played) so it's always visible.
    // Render a placeholder immediately, then fill it when data arrives.
    const tvContainer = document.createElement('div');
    tvContainer.id = 'home-livetv-section';
    tvContainer.className = 'catalog-row';
    tvContainer.innerHTML = `
      <div class="catalog-row-header">
        <h3 class="catalog-row-title">Live TV</h3>
        <span class="catalog-row-badge">LIVE</span>
      </div>
      <div class="catalog-scroll"><div class="row-loading"><div class="spinner-sm"></div> Loading channels...</div></div>
    `;
    dom.homeCatalogs.appendChild(tvContainer);

    // Movie and Series placeholders below Live TV
    const moviePlaceholder = document.createElement('div');
    moviePlaceholder.className = 'catalog-row';
    moviePlaceholder.innerHTML = `
      <div class="catalog-row-header"><h3 class="catalog-row-title">Movies</h3></div>
      <div class="catalog-scroll"><div class="row-loading"><div class="spinner-sm"></div> Loading...</div></div>
    `;
    dom.homeCatalogs.appendChild(moviePlaceholder);

    const seriesPlaceholder = document.createElement('div');
    seriesPlaceholder.className = 'catalog-row';
    seriesPlaceholder.innerHTML = `
      <div class="catalog-row-header"><h3 class="catalog-row-title">Shows</h3></div>
      <div class="catalog-scroll"><div class="row-loading"><div class="spinner-sm"></div> Loading...</div></div>
    `;
    dom.homeCatalogs.appendChild(seriesPlaceholder);

    // Fetch movies, series, and Live TV in parallel
    const [movieResult, seriesResult, tvResult] = await Promise.allSettled([
      // Movies
      (async () => {
        const movieCatalogs = await api.getCatalogs('movie');
        if (movieCatalogs.length === 0) return [];
        const cat = movieCatalogs[0];
        return api.getCatalogItems(cat.addonUrl, cat.type, cat.id);
      })(),
      // Series
      (async () => {
        const seriesCatalogs = await api.getCatalogs('series');
        if (seriesCatalogs.length === 0) return [];
        const cat = seriesCatalogs[0];
        return api.getCatalogItems(cat.addonUrl, cat.type, cat.id);
      })(),
      // Live TV
      api.getAllLiveTVChannels(),
    ]);

    // Render Movies row (replace placeholder) — then enrich with collections
    const movieItems = movieResult.status === 'fulfilled' ? movieResult.value : [];
    if (movieItems.length > 0) {
      // Render individual cards immediately
      const movieSlice = movieItems.slice(0, 20);
      moviePlaceholder.innerHTML = `
        <div class="catalog-row-header"><h3 class="catalog-row-title">Movies</h3></div>
        <div class="catalog-scroll">${movieSlice.map(item => cardHTML(item, 'movie')).join('')}</div>
      `;
      attachCardListeners(moviePlaceholder);

      // Asynchronously enrich with collection data and re-render with grouping
      const imdbIds = movieSlice.map(item => item.imdb_id || item.id);
      const movieNames = movieSlice.map(item => item.name || '');
      const validIds = imdbIds.filter(id => /^tt\d+$/.test(id));
      if (validIds.length > 0) {
        api.enrichWithCollections(imdbIds, movieNames).then(enrichment => {
          const colEntries = Object.entries(enrichment.collections || {});
          // Only re-render if there are collections with 2+ movies
          const hasGroups = colEntries.some(([, c]) => (c.movieIds || []).length >= 2);
          if (!hasGroups) return;

          const { collections: grouped, ungrouped } = groupByCollection(movieSlice, enrichment);
          if (grouped.length === 0) return;

          // Build new scroll content: collection tiles first, then ungrouped movies
          const scrollEl = moviePlaceholder.querySelector('.catalog-scroll');
          if (!scrollEl) return;

          let html = '';
          html += grouped.map(col => collectionCardHTML(col)).join('');
          html += ungrouped.map(item => cardHTML(item, 'movie')).join('');
          scrollEl.innerHTML = html;

          // Store collection data on card elements for expand
          scrollEl.querySelectorAll('.card-collection').forEach(cardEl => {
            const colId = cardEl.dataset.collectionId;
            const col = grouped.find(c => c.id === colId);
            if (col) cardEl._collectionData = col;
          });

          attachCardListeners(scrollEl);
          attachCollectionListeners(scrollEl, movieSlice);
        }).catch(err => {
          console.warn('[Collections] Enrichment failed:', err.message);
        });
      }
    } else {
      moviePlaceholder.innerHTML = `
        <div class="catalog-row-header"><h3 class="catalog-row-title">Movies</h3></div>
        <div class="catalog-scroll"><div class="row-loading" style="color:var(--text-muted)">Unable to load — check connection or try searching</div></div>
      `;
    }

    // Render Series row (replace placeholder)
    const seriesItems = seriesResult.status === 'fulfilled' ? seriesResult.value : [];
    if (seriesItems.length > 0) {
      seriesPlaceholder.innerHTML = `
        <div class="catalog-row-header"><h3 class="catalog-row-title">Shows</h3></div>
        <div class="catalog-scroll">${seriesItems.slice(0, 20).map(item => cardHTML(item, 'series')).join('')}</div>
      `;
      attachCardListeners(seriesPlaceholder);
    } else {
      seriesPlaceholder.innerHTML = `
        <div class="catalog-row-header"><h3 class="catalog-row-title">Shows</h3></div>
        <div class="catalog-scroll"><div class="row-loading" style="color:var(--text-muted)">Unable to load — check connection or try searching</div></div>
      `;
    }

    // Render Live TV section (replace placeholder content in tvContainer)
    try {
      const tvGroups = tvResult.status === 'fulfilled' ? tvResult.value : [];
      console.log('[LiveTV] Home results:', tvGroups.length, 'groups,', tvResult.status);

      if (tvGroups.length > 0) {
        // Replace the placeholder with first group's channels inline
        const firstGroup = tvGroups[0];
        tvContainer.innerHTML = `
          <div class="catalog-row-header">
            <h3 class="catalog-row-title">${escapeHTML(firstGroup.sourceName)}</h3>
            <span class="catalog-row-badge">LIVE</span>
            <button class="catalog-row-more livetv-browse-btn">Browse All</button>
          </div>
          <div class="catalog-scroll">${firstGroup.channels.slice(0, 30).map(ch => channelCardHTML(ch)).join('')}</div>
        `;
        attachChannelListeners(tvContainer);
        tvContainer.querySelector('.livetv-browse-btn')?.addEventListener('click', () => {
          openChannelBrowser(firstGroup);
        });

        // Append additional groups as separate rows after tvContainer
        for (let i = 1; i < tvGroups.length; i++) {
          const extraRow = document.createElement('div');
          extraRow.className = 'catalog-row';
          extraRow.innerHTML = `
            <div class="catalog-row-header">
              <h3 class="catalog-row-title">${escapeHTML(tvGroups[i].sourceName)}</h3>
              <span class="catalog-row-badge">LIVE</span>
              <button class="catalog-row-more livetv-browse-btn">Browse All</button>
            </div>
            <div class="catalog-scroll">${tvGroups[i].channels.slice(0, 30).map(ch => channelCardHTML(ch)).join('')}</div>
          `;
          tvContainer.insertAdjacentElement('afterend', extraRow);
          attachChannelListeners(extraRow);
          const groupRef = tvGroups[i];
          extraRow.querySelector('.livetv-browse-btn')?.addEventListener('click', () => {
            openChannelBrowser(groupRef);
          });
        }
      } else {
        // Show error/config state — always keep the section visible
        const sources = api.getLiveTVSources();
        console.log('[LiveTV] No channels loaded. Sources:', sources.length, sources.map(s => s.name + '(' + (s.enabled ? 'on' : 'off') + ')').join(', '));
        if (sources.length > 0 && sources.some(s => s.enabled)) {
          tvContainer.innerHTML = `
            <div class="catalog-row-header">
              <h3 class="catalog-row-title">Live TV</h3>
              <span class="catalog-row-badge">LIVE</span>
            </div>
            <div class="livetv-error-state">
              <p>Unable to load channels — sources may be offline or unreachable.</p>
              <button class="btn-sm livetv-goto-settings">Configure in Settings</button>
            </div>
          `;
        } else {
          tvContainer.innerHTML = `
            <div class="catalog-row-header">
              <h3 class="catalog-row-title">Live TV</h3>
              <span class="catalog-row-badge">LIVE</span>
            </div>
            <div class="livetv-error-state">
              <p>No live TV sources configured.</p>
              <button class="btn-sm livetv-goto-settings">Add Sources in Settings</button>
            </div>
          `;
        }
        tvContainer.querySelector('.livetv-goto-settings')?.addEventListener('click', (e) => {
          e.preventDefault();
          navigateTo('settings');
        });
      }
    } catch (e) {
      console.error('[LiveTV] Error rendering Live TV section:', e);
      tvContainer.innerHTML = `
        <div class="catalog-row-header">
          <h3 class="catalog-row-title">Live TV</h3>
          <span class="catalog-row-badge">LIVE</span>
        </div>
        <div class="livetv-error-state">
          <p>Error loading Live TV: ${escapeHTML(String(e.message || e))}</p>
          <button class="btn-sm livetv-goto-settings">Go to Settings</button>
        </div>
      `;
      tvContainer.querySelector('.livetv-goto-settings')?.addEventListener('click', (e) => {
        e.preventDefault();
        navigateTo('settings');
      });
    }

    // If nothing meaningful loaded, show a retry option
    const hasContent = movieItems.length > 0 || seriesItems.length > 0 || recent.length > 0;
    if (!hasContent) {
      const retryRow = document.createElement('div');
      retryRow.className = 'catalog-row';
      retryRow.innerHTML = `
        <div class="empty-state" style="padding:24px 16px;text-align:center">
          <p style="margin:0 0 8px">Unable to load catalogs</p>
          <p style="font-size:13px;color:var(--text-muted);margin:0 0 16px">The catalog server may be unreachable. You can still search for content directly.</p>
          <button class="btn-sm" id="home-retry-btn" style="margin:0 auto">Retry</button>
        </div>
      `;
      dom.homeCatalogs.appendChild(retryRow);
      retryRow.querySelector('#home-retry-btn')?.addEventListener('click', () => {
        loadHome();
      });
    }
  }

  async function loadCatalogRow(catalog) {
    const items = await api.getCatalogItems(
      catalog.addonUrl, catalog.type, catalog.id
    );
    if (items.length === 0) return;

    const row = document.createElement('div');
    row.className = 'catalog-row';

    const displayName = catalog.name.charAt(0).toUpperCase() + catalog.name.slice(1);
    const typeLabel = catalog.type === 'movie' ? 'Movies' : 'Series';

    row.innerHTML = `
      <div class="catalog-row-header">
        <h3 class="catalog-row-title">${displayName} ${state.currentType ? '' : '(' + typeLabel + ')'}</h3>
      </div>
      <div class="catalog-scroll">${items.slice(0, 20).map(item => cardHTML(item, catalog.type)).join('')}</div>
    `;

    dom.homeCatalogs.appendChild(row);
    attachCardListeners(row);
  }

  // ─── Card Rendering ──────────────────────────────

  function isSafePosterUrl(url) {
    if (!url) return false;
    try {
      const u = new URL(url, window.location.origin);
      return u.protocol === 'https:' || u.protocol === 'http:' || u.pathname.startsWith('/');
    } catch { return false; }
  }

  function cardHTML(item, type) {
    const rawPoster = item.poster || '';
    const poster = isSafePosterUrl(rawPoster) ? rawPoster : '';
    const title = escapeHTML(item.name || 'Unknown');
    const year = item.releaseInfo || item.year || '';
    const id = item.imdb_id || item.id;
    const rawName = escapeHTML(item.name || '');

    return `
      <div class="card" data-type="${type}" data-id="${id}" data-name="${rawName}">
        <div class="card-poster">
          ${poster
            ? `<img src="${poster}" alt="${title}" loading="lazy" class="loading">`
            : ''}
          <div class="poster-placeholder">${!poster ? title : ''}</div>
        </div>
        <div class="card-info">
          <div class="card-title">${title}</div>
          <div class="card-year">${year}</div>
        </div>
      </div>
    `;
  }

  function attachCardListeners(container) {
    // Use event delegation to avoid listener accumulation
    container.addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      if (card) {
        openDetail(card.dataset.type, card.dataset.id, card.dataset.name);
      }
    });

    // Attach load/error handlers to poster images (CSP forbids inline handlers)
    container.querySelectorAll('img.loading').forEach(img => {
      img.addEventListener('load', () => img.classList.remove('loading'));
      img.addEventListener('error', () => { img.style.display = 'none'; });
    });
  }

  // ─── Collection / Franchise Grouping ─────────────

  /**
   * Group catalog items by collection. Only groups when 2+ movies share a collection.
   * Returns { collections: [{ id, name, poster, movies: [...items] }], ungrouped: [...items] }
   */
  function groupByCollection(items, enrichmentData) {
    const collections = enrichmentData.collections || {};
    // Build reverse map: imdbId -> collectionId
    const imdbToCollection = {};
    for (const [colId, col] of Object.entries(collections)) {
      for (const movieId of col.movieIds || []) {
        imdbToCollection[movieId] = colId;
      }
    }

    // Group items
    const collectionItems = {};
    const ungrouped = [];
    for (const item of items) {
      const id = item.imdb_id || item.id;
      const colId = imdbToCollection[id];
      if (colId) {
        if (!collectionItems[colId]) collectionItems[colId] = [];
        collectionItems[colId].push(item);
      } else {
        ungrouped.push(item);
      }
    }

    // Only group if 2+ movies; otherwise treat as ungrouped
    const grouped = [];
    for (const [colId, movies] of Object.entries(collectionItems)) {
      if (movies.length >= 2) {
        const col = collections[colId];
        grouped.push({
          id: colId,
          name: col.name,
          poster: col.poster || movies[0].poster,
          movies,
        });
      } else {
        ungrouped.push(...movies);
      }
    }

    return { collections: grouped, ungrouped };
  }

  function collectionCardHTML(collection) {
    const poster = isSafePosterUrl(collection.poster || '') ? collection.poster : '';
    const name = escapeHTML(collection.name || 'Collection');
    const count = collection.movies.length;

    return `
      <div class="card card-collection" data-collection-id="${escapeHTML(collection.id)}">
        <div class="card-poster collection-poster-stack">
          ${poster
            ? `<img src="${poster}" alt="${name}" loading="lazy" class="loading">`
            : ''}
          <div class="poster-placeholder">${!poster ? name : ''}</div>
          <div class="collection-badge">${count} movies</div>
        </div>
        <div class="card-info">
          <div class="card-title">${name}</div>
        </div>
      </div>
    `;
  }

  function libraryGroupTileHTML(group) {
    const poster = isSafePosterUrl(group.poster || '') ? group.poster : '';
    const name = escapeHTML(group.name || 'Group');
    const count = group.count;
    let typeLabel;
    if (group.type === 'collection') typeLabel = count === 1 ? 'movie' : 'movies';
    else if (group.type === 'show') typeLabel = count === 1 ? 'episode' : 'episodes';
    else typeLabel = count === 1 ? 'title' : 'titles';

    return `
      <div class="card library-group-tile" data-group-id="${escapeHTML(group.id)}" data-group-type="${group.type}">
        <div class="card-poster collection-poster-stack">
          ${poster ? `<img src="${poster}" alt="${name}" loading="lazy" class="loading">` : ''}
          <div class="poster-placeholder">${!poster ? name : ''}</div>
          <div class="collection-badge">${count} ${typeLabel}</div>
        </div>
        <div class="card-info">
          <div class="card-title">${name}</div>
        </div>
      </div>
    `;
  }

  function attachCollectionListeners(container, allItems) {
    container.querySelectorAll('.card-collection').forEach(card => {
      card.addEventListener('click', (e) => {
        e.stopPropagation();
        const colId = card.dataset.collectionId;
        expandCollection(colId, card, container, allItems);
      });
    });
    // Also attach image load handlers for collection posters
    container.querySelectorAll('.card-collection img.loading').forEach(img => {
      img.addEventListener('load', () => img.classList.remove('loading'));
      img.addEventListener('error', () => { img.style.display = 'none'; });
    });
  }

  function expandCollection(collectionId, cardEl, container, allItems) {
    // Find the scroll container
    const scrollContainer = cardEl.closest('.catalog-scroll') || cardEl.parentElement;

    // Create expanded wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'collection-expanded';
    wrapper.dataset.collectionId = collectionId;

    // Collapse button
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'collection-collapse-btn';
    collapseBtn.textContent = '\u2190 Back';
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      collapseCollection(collectionId, wrapper, cardEl, scrollContainer);
    });
    wrapper.appendChild(collapseBtn);

    // Find movies for this collection from the stored data
    const collectionData = cardEl._collectionData;
    if (collectionData && collectionData.movies) {
      for (const movie of collectionData.movies) {
        const type = movie.type || 'movie';
        const id = movie.imdb_id || movie.id;
        const div = document.createElement('div');
        div.innerHTML = cardHTML(movie, type);
        const movieCard = div.firstElementChild;
        wrapper.appendChild(movieCard);
      }
    }

    // Hide the collection card and insert expanded view
    cardEl.style.display = 'none';
    cardEl.insertAdjacentElement('afterend', wrapper);

    // Attach card listeners for the expanded movies
    attachCardListeners(wrapper);
  }

  function collapseCollection(collectionId, wrapper, cardEl, scrollContainer) {
    cardEl.style.display = '';
    wrapper.remove();
  }

  // ─── Channel Card (Live TV) ─────────────────────

  function channelCardHTML(channel) {
    const name = escapeHTML(channel.name || 'Channel');
    const logo = channel.logo || '';
    const group = escapeHTML(channel.group || '');
    const url = channel.url || '';
    const sourceType = channel._sourceType || 'playlist';
    const addonUrl = channel._addonUrl || '';
    const stremioId = channel._stremioId || '';

    return `
      <div class="channel-card" data-url="${escapeHTML(url)}" data-name="${name}"
           data-source-type="${sourceType}" data-addon-url="${escapeHTML(addonUrl)}"
           data-stremio-id="${escapeHTML(stremioId)}">
        <div class="channel-poster">
          ${logo
            ? `<img src="${logo}" alt="${name}" loading="lazy" class="loading">`
            : ''}
          <div class="channel-placeholder">${!logo ? name.substring(0, 3).toUpperCase() : ''}</div>
          <span class="channel-live-badge">LIVE</span>
        </div>
        <div class="channel-info">
          <div class="channel-name">${name}</div>
          ${group ? `<div class="channel-group">${group}</div>` : ''}
        </div>
      </div>
    `;
  }

  function attachChannelListeners(container) {
    // Only attach click delegation once per container to prevent stacking
    if (!container._channelClickDelegated) {
      container._channelClickDelegated = true;
      container.addEventListener('click', (e) => {
        const card = e.target.closest('.channel-card');
        if (card) {
          const channel = {
            url: card.dataset.url || '',
            name: card.dataset.name || 'Channel',
            _sourceType: card.dataset.sourceType || 'playlist',
            _addonUrl: card.dataset.addonUrl || '',
            _stremioId: card.dataset.stremioId || '',
          };
          playChannel(channel);
        }
      });
    }

    container.querySelectorAll('.channel-poster img.loading').forEach(img => {
      img.addEventListener('load', () => img.classList.remove('loading'));
      img.addEventListener('error', () => { img.style.display = 'none'; });
    });
  }

  async function playChannel(channel) {
    const name = channel.name || 'Channel';
    const proxyUrl = await api.getChannelStreamUrl(channel);
    if (!proxyUrl) {
      showToast('Cannot play this channel');
      return;
    }

    navigateTo('player');
    const logo = channel.logo || '';
    showCurtainOverlay({ poster: logo, title: name, status: `Tuning to ${name}...` });

    try {
      dom.videoPlayer.src = proxyUrl;
      dom.videoPlayer.load();

      await new Promise((resolve, reject) => {
        const onCanPlay = () => { cleanup(); resolve(); };
        const onError = () => {
          cleanup();
          const err = dom.videoPlayer.error;
          reject(new Error(err ? `Media error (code ${err.code})` : 'Failed to load stream'));
        };
        const cleanup = () => {
          dom.videoPlayer.removeEventListener('canplay', onCanPlay);
          dom.videoPlayer.removeEventListener('error', onError);
          clearTimeout(timer);
        };
        const timer = setTimeout(() => { cleanup(); reject(new Error('Stream timed out')); }, 30000);
        dom.videoPlayer.addEventListener('canplay', onCanPlay, { once: true });
        dom.videoPlayer.addEventListener('error', onError, { once: true });
      });

      await dom.videoPlayer.play();
      openCurtains();
    } catch (e) {
      showPlayerError('Channel unavailable', escapeHTML(e.message));
    }
  }

  // ─── Channel Browser (Browse All Live TV) ───────

  function openChannelBrowser(group) {
    navigateTo('search');
    dom.searchEmpty.classList.add('hidden');
    dom.searchInput.value = '';
    dom.searchClear.classList.add('hidden');

    const channels = group.channels || [];
    // Extract unique groups for filter chips
    const groups = [...new Set(channels.map(ch => ch.group).filter(Boolean))].sort();

    let html = `<div class="channel-browser" style="grid-column:1/-1">
      <div class="channel-browser-header">
        <h3>${escapeHTML(group.sourceName)} — ${channels.length} channels</h3>
      </div>`;

    // Group filter chips
    if (groups.length > 1) {
      html += `<div class="channel-browser-filters">
        <button class="filter-chip active channel-group-chip" data-group="">All</button>
        ${groups.slice(0, 30).map(g => `<button class="filter-chip channel-group-chip" data-group="${escapeHTML(g)}">${escapeHTML(g)}</button>`).join('')}
      </div>`;
    }

    // Search within channels
    html += `<div class="channel-browser-search">
      <input type="search" class="channel-search-input" placeholder="Search channels..." autocomplete="off">
    </div>`;

    // Channel grid
    html += `<div class="channel-browser-grid" id="channel-browser-grid">
      ${channels.slice(0, 100).map(ch => channelCardHTML(ch)).join('')}
    </div>`;

    if (channels.length > 100) {
      html += `<div class="channel-browser-more" style="text-align:center;padding:16px;">
        <button class="btn-sm" id="channel-load-more">Show More (${channels.length - 100} remaining)</button>
      </div>`;
    }

    html += `</div>`;

    dom.searchResults.innerHTML = html;
    attachChannelListeners(dom.searchResults);

    // Local search within this group's channels
    const searchInput = dom.searchResults.querySelector('.channel-search-input');
    const grid = document.getElementById('channel-browser-grid');
    let activeGroup = '';
    let searchTimer;

    function filterChannels() {
      const q = (searchInput?.value || '').trim().toLowerCase();
      let filtered = channels;
      if (activeGroup) {
        filtered = filtered.filter(ch => ch.group === activeGroup);
      }
      if (q.length >= 2) {
        filtered = filtered.filter(ch =>
          ch.name.toLowerCase().includes(q) ||
          (ch.group || '').toLowerCase().includes(q) ||
          (ch.country || '').toLowerCase().includes(q)
        );
      }
      grid.innerHTML = filtered.slice(0, 100).map(ch => channelCardHTML(ch)).join('');
      // Only re-attach image load/error handlers; click delegation is on the grid once
      grid.querySelectorAll('.channel-poster img.loading').forEach(img => {
        img.addEventListener('load', () => img.classList.remove('loading'));
        img.addEventListener('error', () => { img.style.display = 'none'; });
      });
    }

    if (searchInput) {
      searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(filterChannels, 250);
      });
    }

    // Group filter chip handlers
    dom.searchResults.querySelectorAll('.channel-group-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        dom.searchResults.querySelectorAll('.channel-group-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        activeGroup = chip.dataset.group;
        filterChannels();
      });
    });

    // Load more button
    const loadMoreBtn = document.getElementById('channel-load-more');
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener('click', () => {
        grid.innerHTML = channels.map(ch => channelCardHTML(ch)).join('');
        attachChannelListeners(grid);
        loadMoreBtn.parentElement.remove();
      });
    }
  }

  // ─── Search ──────────────────────────────────────

  function initSearch() {
    // Search toggle now focuses the always-visible search input
    dom.searchToggle.addEventListener('click', () => {
      dom.searchInput.focus();
      if (state.currentView !== 'search') {
        navigateTo('search');
      }
    });

    dom.searchInput.addEventListener('focus', () => {
      if (state.currentView !== 'search') {
        navigateTo('search');
      }
    });

    dom.searchInput.addEventListener('input', () => {
      const q = dom.searchInput.value.trim();
      dom.searchClear.classList.toggle('hidden', !q);

      clearTimeout(state.searchTimeout);
      if (q.length >= 2) {
        // Clear active filter when typing a manual search
        clearActiveFilter();
        state.searchTimeout = setTimeout(() => performSearch(q), 400);
      } else if (q.length === 0 && !state.activeFilter) {
        dom.searchResults.innerHTML = '';
        dom.searchEmpty.classList.remove('hidden');
      }
    });

    dom.searchClear.addEventListener('click', () => {
      dom.searchInput.value = '';
      dom.searchClear.classList.add('hidden');
      dom.searchResults.innerHTML = '';
      dom.searchEmpty.classList.remove('hidden');
      dom.searchInput.focus();
    });
  }

  // ─── Filters ──────────────────────────────────────

  function initFilters() {
    dom.filterChips.forEach(chip => {
      chip.addEventListener('click', () => {
        const filter = chip.dataset.filter;

        // Update active state
        dom.filterChips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.activeFilter = filter;

        if (!filter) {
          // "All" selected — go back to home catalogs
          dom.searchInput.value = '';
          dom.searchClear.classList.add('hidden');
          navigateTo('home');
          loadHome(state.currentType);
        } else {
          // Filter selected — search for this term
          dom.searchInput.value = '';
          dom.searchClear.classList.add('hidden');
          navigateTo('search');
          performFilterSearch(filter);
        }
      });
    });
  }

  function clearActiveFilter() {
    state.activeFilter = '';
    dom.filterChips.forEach(c => c.classList.remove('active'));
    // Re-activate "All" chip
    const allChip = document.querySelector('.filter-chip[data-filter=""]');
    if (allChip) allChip.classList.add('active');
  }

  async function performFilterSearch(filter) {
    dom.searchEmpty.classList.add('hidden');
    dom.searchResults.innerHTML = `
      <div class="loading-state" style="grid-column:1/-1">
        <div class="spinner"></div>
        <p>Finding ${escapeHTML(filter)} titles...</p>
      </div>
    `;

    const typeFilter = state.currentType || null;
    const results = await api.search(filter, typeFilter);

    if (results.length === 0) {
      dom.searchResults.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1">
          <p>No results for "${escapeHTML(filter)}"</p>
        </div>
      `;
      return;
    }

    dom.searchResults.innerHTML = results.map(item => {
      const type = item.type || 'movie';
      return cardHTML(item, type);
    }).join('');

    attachCardListeners(dom.searchResults);
  }

  async function performSearch(query) {
    dom.searchEmpty.classList.add('hidden');
    dom.searchResults.innerHTML = `
      <div class="loading-state" style="grid-column:1/-1">
        <div class="spinner"></div>
        <p>Searching...</p>
      </div>
    `;

    const typeFilter = state.currentType || null;

    // Search movies/series and Live TV in parallel
    const [results, tvChannels] = await Promise.all([
      api.search(query, typeFilter),
      api.searchLiveTVChannels(query),
    ]);

    if (results.length === 0 && tvChannels.length === 0) {
      dom.searchResults.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1">
          <p>No results for "${escapeHTML(query)}"</p>
        </div>
      `;
      return;
    }

    let html = '';

    // Live TV results first (if any)
    if (tvChannels.length > 0) {
      html += `<div class="search-section-header" style="grid-column:1/-1">
        <h3>Live TV Channels</h3>
      </div>`;
      html += `<div class="search-tv-row" style="grid-column:1/-1">
        <div class="catalog-scroll">${tvChannels.map(ch => channelCardHTML(ch)).join('')}</div>
      </div>`;
    }

    // Movie/series results
    if (results.length > 0) {
      if (tvChannels.length > 0) {
        html += `<div class="search-section-header" style="grid-column:1/-1">
          <h3>Movies & Shows</h3>
        </div>`;
      }
      html += results.map(item => {
        const type = item.type || 'movie';
        return cardHTML(item, type);
      }).join('');
    }

    dom.searchResults.innerHTML = html;

    // Attach listeners for both card types
    attachCardListeners(dom.searchResults);
    attachChannelListeners(dom.searchResults);
  }

  // ─── Detail View ─────────────────────────────────

  async function openDetail(type, id, hintTitle) {
    navigateTo('detail', { title: 'Loading...' });
    preload.cancel(); // invalidate any preload from a previously viewed title
    if (api._speedTestController) api._speedTestController.abort(); // cancel stale speed tests
    ++_streamLoadGeneration; // invalidate any in-flight loadStreams from a previous title
    _autoSelectedStream = null;

    dom.detailContent.innerHTML = `
      <div class="loading-state"><div class="spinner"></div><p>Loading details...</p></div>
    `;

    // For movies with IMDB IDs, start fetching streams in parallel with metadata.
    // Passing hintTitle (from the card the user clicked) ensures the provider
    // query uses the correct title, not a stale global.
    let streamsPromise = (type === 'movie' && !id.startsWith('tmdb:'))
      ? api.getStreams(type, id, undefined, hintTitle)
      : null;

    const meta = await api.getMeta(type, id);
    if (!meta) {
      dom.detailContent.innerHTML = `
        <div class="empty-state"><p>Could not load details</p></div>
      `;
      return;
    }

    // If TMDB metadata resolved an IMDB ID, use it for streams and update the working ID
    if (meta._resolvedImdbId && id.startsWith('tmdb:')) {
      id = meta._resolvedImdbId;
      // Start the movie stream fetch now that we have a real IMDB ID
      if (type === 'movie' && !streamsPromise) {
        streamsPromise = api.getStreams(type, id, undefined, meta.name || hintTitle);
      }
    }

    state.currentMeta = meta;
    state.currentType = type;
    dom.pageTitle.textContent = meta.name || 'Details';

    // Track recently played
    addRecentlyPlayed(type, meta);

    const bgImage = meta.background || meta.poster || '';
    const genres = (meta.genres || []).slice(0, 4);
    const rating = meta.imdbRating || meta.rating;
    const year = meta.releaseInfo || meta.year || '';

    let html = `
      <div class="detail-hero">
        ${bgImage ? `<img src="${bgImage}" alt="">` : '<div style="height:100%;background:var(--bg-card)"></div>'}
        <div class="detail-hero-gradient"></div>
      </div>
      <div class="detail-body fade-in">
        <h2 class="detail-title">${escapeHTML(meta.name)}</h2>
        <div class="detail-meta">
          ${year ? `<span class="detail-tag">${year}</span>` : ''}
          ${rating ? `<span class="detail-tag rating">&#9733; ${rating}</span>` : ''}
          ${genres.map(g => `<span class="detail-tag">${escapeHTML(g)}</span>`).join('')}
          <span class="detail-tag">${type === 'movie' ? 'Movie' : 'Series'}</span>
        </div>
        ${meta.description ? `<p class="detail-description">${escapeHTML(meta.description)}</p>` : ''}
    `;

    if (type === 'series' && meta.videos && meta.videos.length > 0) {
      html += renderSeriesSection(meta);
    } else {
      // Movie — show streams directly
      html += `
        <h3 class="detail-section-title">Streams</h3>
        <div id="stream-container">
          <div class="loading-state"><div class="spinner"></div><p>Finding streams & testing speeds...</p></div>
        </div>
      `;
      html += `
        <div style="margin-top:12px">
          <button class="search-complete-btn" id="search-complete-btn" title="Search for complete download with 'complete' keyword">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            Search Complete
          </button>
        </div>
        <div id="complete-container" class="hidden"></div>
      `;
    }

    // Add to Library button (torrent data available for download)
    {
      html += `
        <div id="library-add-section" class="library-add-section" style="margin-top:20px">
          <h3 class="detail-section-title">Download</h3>
          <p class="setting-hint" style="margin-bottom:12px">Select a stream above first, then save it to your server library</p>
          <button id="add-to-library-btn" class="btn-library-add" disabled>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Add to Library
          </button>
        </div>
      `;
    }

    html += '</div>';
    dom.detailContent.innerHTML = html;

    // Load streams for movies — use pre-fetched promise if available
    if (type === 'movie') {
      loadStreams(type, id, undefined, streamsPromise);
    }

    // Attach series handlers
    if (type === 'series') {
      attachSeriesHandlers(meta);
    }

    // Attach Search Complete handler for movies
    if (type === 'movie') {
      const completeBtn = document.getElementById('search-complete-btn');
      if (completeBtn) {
        completeBtn.addEventListener('click', () => {
          const showId = meta.imdb_id || meta.id;
          const cc = document.getElementById('complete-container');
          if (cc) {
            cc.classList.remove('hidden');
            cc.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Searching for complete download...</p></div>`;
            cc.scrollIntoView({ behavior: 'smooth' });
          }
          loadCompleteStreams(showId, meta, 'complete-container');
        });
      }
    }
  }

  // ─── Series Section ──────────────────────────────

  function renderSeriesSection(meta) {
    const videos = meta.videos || [];
    const seasons = [...new Set(videos.map(v => v.season).filter(s => s != null))].sort((a, b) => a - b);

    if (seasons.length === 0) return '';

    state.currentSeason = seasons[0];

    let html = '<h3 class="detail-section-title">Episodes</h3>';
    html += '<div class="season-tabs">';
    seasons.forEach(s => {
      html += `<button class="season-tab ${s === state.currentSeason ? 'active' : ''}" data-season="${s}">
        Season ${s}
      </button>`;
    });
    html += `<button class="season-pack-btn" id="season-pack-btn" data-season="${state.currentSeason}" title="Search for season pack download">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      Season Pack
    </button>`;
    html += `<button class="search-complete-btn" id="search-complete-btn" title="Search for complete series download">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="8"/>
        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      Search Complete
    </button>`;
    html += '</div>';
    html += `<div id="episode-list" class="episode-list">${renderEpisodes(videos, state.currentSeason)}</div>`;
    html += `<div id="stream-container" class="hidden"></div>`;

    return html;
  }

  const EPISODES_PER_PAGE = 50;

  function renderEpisodes(videos, season, offset = 0) {
    const eps = videos
      .filter(v => v.season === season)
      .sort((a, b) => (a.episode || 0) - (b.episode || 0));

    const slice = eps.slice(offset, offset + EPISODES_PER_PAGE);
    const remaining = eps.length - offset - EPISODES_PER_PAGE;

    let html = slice.map(ep => `
      <div class="episode-item" data-id="${ep.id}" data-season="${ep.season}" data-episode="${ep.episode}">
        <div class="episode-num">${ep.episode || '?'}</div>
        <div class="episode-info">
          <div class="episode-title">${escapeHTML(ep.title || ep.name || `Episode ${ep.episode}`)}</div>
          ${ep.overview ? `<div class="episode-overview">${escapeHTML(ep.overview)}</div>` : ''}
        </div>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
      </div>
    `).join('');

    if (remaining > 0) {
      html += `<button class="load-more-episodes" data-season="${season}" data-offset="${offset + EPISODES_PER_PAGE}">
        Load More (${remaining} remaining)
      </button>`;
    }

    return html;
  }

  function attachSeriesHandlers(meta) {
    // Season tabs
    document.querySelectorAll('.season-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const season = parseInt(tab.dataset.season);
        state.currentSeason = season;
        document.querySelectorAll('.season-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const list = document.getElementById('episode-list');
        if (list) list.innerHTML = renderEpisodes(meta.videos, season);
        // Update season pack button's data-season
        const packBtn = document.getElementById('season-pack-btn');
        if (packBtn) packBtn.dataset.season = season;
        // Re-attach episode click handlers
        attachEpisodeHandlers();
        // Hide stream container
        const sc = document.getElementById('stream-container');
        if (sc) sc.classList.add('hidden');
      });
    });

    // Season Pack button
    const packBtn = document.getElementById('season-pack-btn');
    if (packBtn) {
      packBtn.addEventListener('click', () => {
        const season = parseInt(packBtn.dataset.season, 10);
        const showId = meta.imdb_id || meta.id;
        const sc = document.getElementById('stream-container');
        if (sc) {
          sc.classList.remove('hidden');
          sc.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Searching for Season ${season} packs...</p></div>`;
          sc.scrollIntoView({ behavior: 'smooth' });
        }
        loadSeasonPacks(showId, season, meta);
      });
    }

    // Search Complete button (series)
    const completeBtn = document.getElementById('search-complete-btn');
    if (completeBtn) {
      completeBtn.addEventListener('click', () => {
        const showId = meta.imdb_id || meta.id;
        const sc = document.getElementById('stream-container');
        if (sc) {
          sc.classList.remove('hidden');
          sc.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Searching for complete series...</p></div>`;
          sc.scrollIntoView({ behavior: 'smooth' });
        }
        loadCompleteStreams(showId, meta);
      });
    }

    // Event delegation for "Load More" episodes button
    const episodeList = document.getElementById('episode-list');
    if (episodeList) {
      episodeList.addEventListener('click', (e) => {
        const btn = e.target.closest('.load-more-episodes');
        if (!btn) return;
        const season = parseInt(btn.dataset.season, 10);
        const offset = parseInt(btn.dataset.offset, 10);
        const moreHtml = renderEpisodes(meta.videos, season, offset);
        btn.insertAdjacentHTML('beforebegin', moreHtml);
        btn.remove();
        attachEpisodeHandlers();
      });
    }

    attachEpisodeHandlers();
  }

  // Episode click handler — uses event delegation to avoid stacking listeners
  let _episodeDelegationAttached = false;
  function attachEpisodeHandlers() {
    const episodeList = document.getElementById('episode-list');
    if (!episodeList || _episodeDelegationAttached) return;
    _episodeDelegationAttached = true;

    episodeList.addEventListener('click', (e) => {
      const ep = e.target.closest('.episode-item');
      if (!ep) return;

      const id = ep.dataset.id;
      const season = parseInt(ep.dataset.season, 10);
      const episode = parseInt(ep.dataset.episode, 10);
      const sc = document.getElementById('stream-container');
      if (sc) {
        sc.classList.remove('hidden');
        sc.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Finding streams & testing speeds...</p></div>`;
        sc.scrollIntoView({ behavior: 'smooth' });
      }
      // In custom mode, we need the show's IMDB ID + season/episode
      const showId = state.currentMeta
        ? (state.currentMeta.imdb_id || state.currentMeta.id)
        : id;

      // Compute absolute episode number for anime (fansubs use absolute numbering)
      let absoluteEpisode;
      if (state.currentMeta && state.currentMeta.videos) {
        const allEps = state.currentMeta.videos
          .filter(v => v.season != null && v.episode != null)
          .sort((a, b) => a.season - b.season || a.episode - b.episode);
        const absIndex = allEps.findIndex(v => v.season === season && v.episode === episode);
        if (absIndex >= 0) absoluteEpisode = absIndex + 1;
      }

      const genres = state.currentMeta && state.currentMeta.genres
        ? state.currentMeta.genres : undefined;

      loadStreams('series', showId, { season, episode, absoluteEpisode, genres });
    });
  }

  // ─── Stream Loading with Speed Testing ───────────

  async function loadStreams(type, id, seasonEpisode, prefetchedStreamsPromise) {
    const generation = ++_streamLoadGeneration;

    // Record the episode we're about to load so the "ended" handler can
    // compute the next one in order.
    if (type === 'series' && seasonEpisode && seasonEpisode.season != null && seasonEpisode.episode != null) {
      state.currentSeasonEp = { season: seasonEpisode.season, episode: seasonEpisode.episode };
    } else if (type === 'movie') {
      state.currentSeasonEp = null;
    }

    const container = document.getElementById('stream-container');
    if (!container) return;

    // Use pre-fetched streams if available (from parallel fetch in openDetail)
    let streams;
    try {
      const currentTitle = (state.currentMeta && state.currentMeta.name) || '';
      streams = prefetchedStreamsPromise
        ? await prefetchedStreamsPromise
        : await api.getStreams(type, id, seasonEpisode, currentTitle);
    } catch (e) {
      console.warn('[loadStreams] Failed to fetch streams:', e.message);
      streams = [];
    }

    // If user navigated to a different title while we were fetching, discard results
    if (generation !== _streamLoadGeneration) return;

    if (streams.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="padding:32px 0">
          <p>No streams found</p>
          <p style="font-size:12px;color:var(--text-muted)">All providers returned empty — this usually means a network issue on the server</p>
          <button id="diagnose-btn" style="
            margin-top:12px; padding:8px 16px; border:1px solid var(--text-muted);
            border-radius:var(--radius-sm); background:transparent; color:var(--text);
            font-size:13px; cursor:pointer;
          ">Run Provider Diagnostics</button>
          <div id="diagnose-results" style="margin-top:12px;font-size:12px;text-align:left;display:none"></div>
        </div>
      `;
      {
        const diagBtn = document.getElementById('diagnose-btn');
        if (diagBtn) {
          diagBtn.addEventListener('click', async () => {
            diagBtn.textContent = 'Testing providers...';
            diagBtn.disabled = true;
            try {
              const resp = await fetch('/api/streams/diagnose');
              const data = await resp.json();
              const resultsDiv = document.getElementById('diagnose-results');
              if (resultsDiv) {
                resultsDiv.style.display = 'block';
                const providers = Object.entries(data).filter(([k]) => !k.startsWith('_'));
                let html = '<div style="font-family:monospace">';
                for (const [name, info] of providers) {
                  const icon = info.ok && info.count > 0 ? '&#9989;' : (info.ok ? '&#9888;' : '&#10060;');
                  const detail = info.ok
                    ? `${info.count} results (${info.ms}ms)`
                    : `${info.error} (${info.ms}ms)`;
                  html += `<div style="margin:4px 0">${icon} <strong>${name}</strong>: ${detail}</div>`;
                }
                if (data._torrentioConfig) {
                  html += `<div style="margin:4px 0;color:var(--text-dim)">Torrentio config: ${data._torrentioConfig}</div>`;
                }
                const summary = data._summary || {};
                html += `<div style="margin-top:8px;color:${summary.allDown ? 'var(--accent-red)' : 'var(--text-dim)'}">`;
                html += summary.allDown
                  ? 'All providers unreachable — check server network/DNS'
                  : `${summary.working.length}/${summary.total} providers working`;
                html += '</div></div>';
                resultsDiv.innerHTML = html;
              }
            } catch (e) {
              const resultsDiv = document.getElementById('diagnose-results');
              if (resultsDiv) {
                resultsDiv.style.display = 'block';
                resultsDiv.innerHTML = `<div style="color:var(--accent-red)">Diagnostics failed: ${escapeHTML(e.message)}</div>`;
              }
            }
            diagBtn.textContent = 'Re-run Diagnostics';
            diagBtn.disabled = false;
          });
        }
      }
      return;
    }

    // Phase A: Race top 3 streams to find a clear winner
    container.innerHTML = `
      <div class="stream-speed-status" style="
        text-align:center; padding:12px; margin-bottom:8px;
        font-size:13px; color:var(--text-dim);
        background:var(--bg-card); border-radius:var(--radius-sm);
      ">
        <div class="spinner" style="width:20px;height:20px;margin:0 auto 8px;border-width:2px"></div>
        Finding best stream...
      </div>
    `;

    const raceResult = await api.raceTopStreams(streams);
    if (generation !== _streamLoadGeneration) return;

    if (raceResult.winner) {
      // Clear winner found — show Play + Add to Library directly
      renderWinnerPanel(container, raceResult.winner);
      preload.warmStream(raceResult.winner);
      _autoSelectedStream = raceResult.winner;

      // Hide the standalone download section (winner panel has its own Add to Library)
      const libSection = document.getElementById('library-add-section');
      if (libSection) libSection.style.display = 'none';

      // Background: run full ranking to populate "More options"
      runBackgroundRanking(streams, generation);
      return;
    }

    // Phase B: No clear winner — fall back to full stream list
    container.innerHTML = `
      <div class="stream-speed-status" style="
        text-align:center; padding:12px; margin-bottom:8px;
        font-size:13px; color:var(--text-dim);
        background:var(--bg-card); border-radius:var(--radius-sm);
      ">
        <div class="spinner" style="width:20px;height:20px;margin:0 auto 8px;border-width:2px"></div>
        Ranking streams... <span id="speed-progress">0/${streams.length}</span>
      </div>
      <div class="stream-list" id="stream-list">
        ${streams.map((s, i) => renderStreamItem(s, i, 'testing')).join('')}
      </div>
    `;

    const ranked = await api.testAndRankStreams(streams, (tested, total, result) => {
      const progress = document.getElementById('speed-progress');
      if (progress) progress.textContent = `${tested}/${total}`;
      updateStreamItemSpeed(result);
    });

    if (generation !== _streamLoadGeneration) return;

    const bestPlayable = ranked.find(r => r.responseTime < Infinity);
    if (bestPlayable) {
      preload.warmStream(bestPlayable.stream);
    }

    const statusEl = container.querySelector('.stream-speed-status');
    if (statusEl) {
      const fastest = ranked.find(r => r.responseTime < Infinity);
      if (fastest) {
        const seeds = fastest.stream.seeds || 0;
        const sourceLabel = fastest.stream.source || fastest.stream.addonName || 'Scraped';
        statusEl.innerHTML = `
          <span style="color:var(--success)">&#9889;</span>
          Best stream: <strong>${seeds} seeds</strong>
          <span style="color:var(--success)"> &mdash; ${sourceLabel}</span>
        `;
      } else {
        statusEl.innerHTML = `
          <span style="color:var(--warning)">&#9888;</span>
          Could not verify stream speeds — streams may still work
        `;
      }
    }

    _lastRankedStreams = ranked;
    const listEl = document.getElementById('stream-list');
    if (listEl) {
      listEl.innerHTML = ranked.map((r, i) => renderStreamItem(r.stream, i, 'done', r.responseTime)).join('');
      attachStreamHandlers();
    }

    const addBtn = document.getElementById('add-to-library-btn');
    if (addBtn && ranked.length > 0) {
      addBtn.disabled = false;
      addBtn.addEventListener('click', () => showLibraryStreamPicker(ranked));
    }
  }

  function renderStreamItem(stream, index, status, responseTime) {
    const title = stream.title || stream.name || 'Unknown Stream';
    const lines = title.split('\n');
    const mainTitle = escapeHTML(lines[0]);
    const detail = lines.slice(1).map(l => escapeHTML(l)).join(' &middot; ');
    const addon = stream.addonName ? escapeHTML(stream.addonName) : '';

    let speedBadge = '';
    if (status === 'done') {
      const seeds = stream.seeds || 0;
      let color = 'var(--success)';
      let bg = 'rgba(0, 206, 201, 0.15)';
      if (seeds < 5) { color = 'var(--danger)'; bg = 'rgba(255, 107, 107, 0.15)'; }
      else if (seeds < 20) { color = 'var(--warning)'; bg = 'rgba(253, 203, 110, 0.15)'; }
      speedBadge = `<span class="stream-quality" style="background:${bg};color:${color}">${seeds} seeds</span>`;
    } else if (status === 'testing') {
      speedBadge = '<span class="stream-quality" style="background:rgba(255,255,255,0.05);color:var(--text-muted)">Testing...</span>';
    } else {
      speedBadge = '<span class="stream-quality" style="background:rgba(255,107,107,0.1);color:var(--danger)">Timeout</span>';
    }

    // Detect quality from title
    let quality = '';
    const qualityMatch = title.match(/\b(4K|2160p|1080p|720p|480p|HDR|HEVC|H\.265|H\.264)\b/i);
    if (qualityMatch) quality = qualityMatch[1].toUpperCase();

    // Format badge
    let formatBadge = '';
    if (stream.format) {
      const playable = stream.browserPlayable;
      const remuxable = stream.needsRemux || stream.remuxPlayable;
      const fColor = playable ? 'var(--success)' : (remuxable ? 'var(--accent)' : 'var(--warning)');
      const fBg = playable ? 'rgba(0,206,201,0.1)' : (remuxable ? 'rgba(99,110,250,0.1)' : 'rgba(253,203,110,0.1)');
      const label = stream.needsRemux ? `${stream.format} (remux)` : stream.format;
      formatBadge = `<span class="stream-quality" style="background:${fBg};color:${fColor};margin-right:4px">${escapeHTML(label)}</span>`;
    }

    let batchBadge = '';
    if (stream.isBatch) {
      batchBadge = `<span class="stream-quality" style="background:rgba(155,89,182,0.15);color:#b388ff;margin-right:4px">BATCH</span>`;
    }

    return `
      <div class="stream-item${stream.format && !stream.browserPlayable && !stream.remuxPlayable ? ' stream-non-playable' : ''}" data-index="${index}" id="stream-${index}">
        <div class="stream-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
        </div>
        <div class="stream-info">
          <div class="stream-title">${mainTitle}</div>
          <div class="stream-detail">${detail || addon}${quality ? ' &middot; ' + quality : ''}</div>
        </div>
        ${batchBadge}${formatBadge}${speedBadge}
      </div>
    `;
  }

  function updateStreamItemSpeed(result) {
    const item = document.getElementById('stream-' + result.index);
    if (!item) return;
    const badge = item.querySelector('.stream-quality');
    if (!badge || badge.textContent !== 'Testing...') return;

    const seeds = result.stream.seeds || 0;
    let color = 'var(--success)';
    let bg = 'rgba(0, 206, 201, 0.15)';
    if (seeds < 5) { color = 'var(--danger)'; bg = 'rgba(255, 107, 107, 0.15)'; }
    else if (seeds < 20) { color = 'var(--warning)'; bg = 'rgba(253, 203, 110, 0.15)'; }
    badge.style.background = bg;
    badge.style.color = color;
    badge.textContent = seeds + ' seeds';
  }

  // ─── Winner Panel (auto-selected best stream) ──────────────────────

  function renderWinnerPanel(container, winner) {
    const title = winner.title || winner.name || 'Best Stream';
    const lines = title.split('\n');
    const mainTitle = escapeHTML(lines[0]);
    const seeds = winner.seeds || 0;
    const source = winner.source || winner.addonName || 'Scraped';
    const qualityMatch = title.match(/\b(4K|2160p|1080p|720p|480p)\b/i);
    const quality = qualityMatch ? qualityMatch[1].toUpperCase() : '';
    const format = winner.format || '';

    container.innerHTML = `
      <div class="winner-panel" style="background:var(--bg-card);border-radius:var(--radius);padding:20px;text-align:center;">
        <div style="color:var(--success);font-size:14px;margin-bottom:8px;">
          &#9889; Best stream found
        </div>
        <div style="font-size:15px;font-weight:600;margin-bottom:4px;">${mainTitle}</div>
        <div style="font-size:13px;color:var(--text-dim);margin-bottom:16px;">
          ${[quality, format, seeds + ' seeds', source].filter(Boolean).join(' \u00b7 ')}
        </div>
        <div style="display:flex;gap:12px;justify-content:center;">
          <button class="btn-play" id="auto-play-btn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Play
          </button>
          <button class="btn-library" id="auto-library-btn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Add to Library
          </button>
        </div>
        <div id="more-options-toggle" style="margin-top:16px;font-size:13px;color:var(--text-muted);cursor:pointer;">
          More options &#9662;
        </div>
        <div id="more-options-list" style="display:none;margin-top:12px;text-align:left;">
          <div class="stream-list" id="stream-list">
            <div style="text-align:center;padding:12px;color:var(--text-dim);font-size:12px;">
              <div class="spinner" style="width:16px;height:16px;margin:0 auto 6px;border-width:2px"></div>
              Loading alternatives...
            </div>
          </div>
        </div>
      </div>
    `;

    document.getElementById('auto-play-btn').addEventListener('click', () => playStream(winner));
    document.getElementById('auto-library-btn').addEventListener('click', () => addToLibrary(winner));
    document.getElementById('more-options-toggle').addEventListener('click', () => {
      const list = document.getElementById('more-options-list');
      const toggle = document.getElementById('more-options-toggle');
      if (list.style.display === 'none') {
        list.style.display = 'block';
        toggle.innerHTML = 'Fewer options &#9652;';
      } else {
        list.style.display = 'none';
        toggle.innerHTML = 'More options &#9662;';
      }
    });
  }

  async function runBackgroundRanking(streams, generation) {
    const ranked = await api.testAndRankStreams(streams);
    if (generation !== _streamLoadGeneration) return;

    _lastRankedStreams = ranked;
    const listEl = document.getElementById('stream-list');
    if (listEl) {
      listEl.innerHTML = ranked.map((r, i) => renderStreamItem(r.stream, i, 'done', r.responseTime)).join('');
      attachStreamHandlers();
    }
  }

  // ─── Preload Manager ───────────────────────────────────────────────
  // Warms the top-ranked stream in the background so torrent peers are
  // already connecting by the time the user taps Play.
  const preload = (() => {
    let _controller = null;
    let _preloadedHash = null;

    function cancel() {
      if (_controller) {
        _controller.abort();
        _controller = null;
      }
      _preloadedHash = null;
    }

    async function warmStream(stream) {
      if (!stream || !stream.infoHash) return;
      if (_preloadedHash === stream.infoHash) return; // already warming

      cancel();

      _preloadedHash = stream.infoHash;
      _controller = new AbortController();

      const url = api.getPlaybackUrl(stream);
      if (!url) return;

      try {
        // Range: bytes=0-0 causes the server to connect to peers and start buffering
        // without streaming the full response
        const resp = await fetch(url, {
          headers: { 'Range': 'bytes=0-0' },
          signal: _controller.signal,
        });
        if (resp.body) {
          const reader = resp.body.getReader();
          await reader.read();
          reader.cancel();
        }
        console.debug('[preload] warm complete for', stream.infoHash.slice(0, 8));
      } catch (e) {
        if (e.name !== 'AbortError') {
          console.debug('[preload] warm failed:', e.message);
        }
      }
    }

    function isWarmed(stream) {
      return stream && stream.infoHash === _preloadedHash;
    }

    return { warmStream, cancel, isWarmed };
  })();

  // Store ranked results so stream items can reference them by index
  let _lastRankedStreams = [];

  let _selectedStreamIndex = -1;
  let _autoSelectedStream = null;

  function attachStreamHandlers() {
    const list = document.getElementById('stream-list');
    if (!list) return;
    // Event delegation — single listener for all stream items
    list.addEventListener('click', (e) => {
      const item = e.target.closest('.stream-item');
      if (!item) return;
      const idx = parseInt(item.dataset.index);
      if (idx >= 0 && idx < _lastRankedStreams.length) {
        selectStream(idx);
      }
    });
  }

  function selectStream(idx) {
    _selectedStreamIndex = idx;

    // Highlight selected stream
    document.querySelectorAll('.stream-item').forEach(el => el.classList.remove('selected'));
    const selected = document.getElementById('stream-' + idx);
    if (selected) selected.classList.add('selected');

    // Remove existing action bar
    const existing = document.querySelector('.stream-action-bar');
    if (existing) existing.remove();

    // Create floating action bar
    const bar = document.createElement('div');
    bar.className = 'stream-action-bar';
    bar.innerHTML = `
      <button class="btn-play" id="action-play">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        Play
      </button>
      <button class="btn-library" id="action-library">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Add to Library
      </button>
    `;
    document.body.appendChild(bar);

    bar.querySelector('#action-play').addEventListener('click', () => {
      bar.remove();
      playStream(_lastRankedStreams[idx].stream);
    });

    bar.querySelector('#action-library').addEventListener('click', () => {
      addToLibrary(_lastRankedStreams[idx].stream);
      bar.remove();
      document.querySelectorAll('.stream-item').forEach(el => el.classList.remove('selected'));
    });
  }

  // ─── Playback ────────────────────────────────────

  function showCurtainOverlay(opts = {}) {
    const { poster = '', title = '', status = 'Loading...', subtitle = '' } = opts;
    dom.playerOverlay.classList.remove('hidden');
    dom.playerOverlay.innerHTML = `
      <div class="curtain-stage dropping">
        <div class="curtain-valance"></div>
        <div class="curtain-lights"></div>
        <div class="curtain-poster-wrap">
          ${poster ? `<img src="${poster}" alt="">` : ''}
          ${title ? `<div class="curtain-poster-title">${escapeHTML(title)}</div>` : ''}
          <div class="curtain-loading-bar"><div class="loading-bar"></div></div>
          <div class="curtain-poster-status loading-status">${status}</div>
          ${subtitle ? `<div class="curtain-poster-status" style="opacity:0.5">${subtitle}</div>` : ''}
        </div>
        <div class="curtain-panel curtain-panel-left"></div>
        <div class="curtain-panel curtain-panel-right"></div>
      </div>
    `;
  }

  let _curtainAnimating = false;

  /* ── Player controls auto-hide (fade after 3s of inactivity) ── */
  let _playerControlsTimer = null;

  function showPlayerControls() {
    dom.playerBackBtn.classList.remove('player-controls-hidden');
    if (!dom.castBtn.classList.contains('hidden')) {
      dom.castBtn.classList.remove('player-controls-hidden');
    }
    resetPlayerControlsTimer();
  }

  function hidePlayerControls() {
    // Don't hide if buffering overlay or cast overlay is visible
    if (!dom.playerOverlay.classList.contains('hidden') ||
        !dom.castOverlay.classList.contains('hidden')) {
      return;
    }
    dom.playerBackBtn.classList.add('player-controls-hidden');
    dom.castBtn.classList.add('player-controls-hidden');
  }

  function resetPlayerControlsTimer() {
    clearTimeout(_playerControlsTimer);
    _playerControlsTimer = setTimeout(hidePlayerControls, 3000);
  }

  function clearPlayerControlsTimer() {
    clearTimeout(_playerControlsTimer);
    dom.playerBackBtn.classList.remove('player-controls-hidden');
    dom.castBtn.classList.remove('player-controls-hidden');
  }

  function openCurtains() {
    const curtainStage = dom.playerOverlay.querySelector('.curtain-stage');
    if (curtainStage) {
      _curtainAnimating = true;
      curtainStage.classList.remove('dropping');
      curtainStage.classList.add('opening');
      // Wait for curtain panels to fully slide off-screen (1.2s transition)
      // then hide the overlay and enter fullscreen
      setTimeout(() => {
        _curtainAnimating = false;
        dom.playerOverlay.classList.add('hidden');
        enterPlayerFullscreen();
        showPlayerControls();
      }, 1600);
    } else {
      dom.playerOverlay.classList.add('hidden');
      enterPlayerFullscreen();
      showPlayerControls();
    }
  }

  function showPlayerError(title, hint) {
    dom.playerOverlay.innerHTML = `
      <p style="color:var(--danger)">${escapeHTML(title)}</p>
      <p style="font-size:13px;color:var(--text-muted)">${hint}</p>
      <button id="player-go-back" style="
        margin-top:16px; padding:10px 24px; background:var(--accent);
        border:none; border-radius:8px; color:white; font-size:14px; cursor:pointer;
      ">Go Back</button>
    `;
    document.getElementById('player-go-back').addEventListener('click', () => goBack());
  }

  // Clean up stale video event listeners from previous playStream calls
  let _playStreamCleanup = null;

  async function playStream(stream) {
    if (_playStreamCleanup) { _playStreamCleanup(); _playStreamCleanup = null; }
    stopResumeTracker(true); // save any in-progress position before switching
    clearUpNextOverlay();

    const url = api.getPlaybackUrl(stream);
    if (!url) {
      showToast('Cannot play this stream');
      return;
    }

    // External URLs — open in new tab
    if (stream.externalUrl || stream.ytId) {
      window.open(url, '_blank');
      return;
    }

    navigateTo('player');

    const alreadyWarmed = preload.isWarmed(stream);
    preload.cancel(); // stop background fetch — playback takes over now

    // Build stage curtain loading screen with poster
    const poster = state.currentMeta?.poster || '';
    const title = state.currentMeta?.name || '';
    const statusLabel = alreadyWarmed
      ? 'Starting playback...'
      : (stream.infoHash ? 'Connecting to torrent peers...' : 'Loading stream...');
    showCurtainOverlay({
      poster,
      title,
      status: statusLabel,
      subtitle: stream.infoHash && !alreadyWarmed ? 'This may take 30-60 seconds' : '',
    });

    // Poll torrent status for torrent streams
    let statusInterval = null;
    if (stream.infoHash) {
      statusInterval = setInterval(async () => {
        try {
          const res = await fetch(`/api/torrent-status/${stream.infoHash}`);
          if (!res.ok) return;
          const data = await res.json();
          const statusEl = dom.playerOverlay.querySelector('.loading-status');
          if (statusEl) {
            const speed = data.downloadSpeed > 0
              ? (data.downloadSpeed / 1024).toFixed(0) + ' KB/s'
              : '';
            statusEl.textContent = data.numPeers > 0
              ? `Buffering from ${data.numPeers} peer${data.numPeers !== 1 ? 's' : ''}${speed ? ' · ' + speed : ''}`
              : 'Connecting to torrent peers...';
          }
        } catch (_) { /* ignore polling errors */ }
      }, 2000);
    }

    try {
      dom.videoPlayer.src = url;
      dom.videoPlayer.load();

      // Wait for enough data before trying to play
      await new Promise((resolve, reject) => {
        const onCanPlay = () => { cleanup(); resolve(); };
        const onError = () => {
          cleanup();
          const err = dom.videoPlayer.error;
          reject(new Error(err ? `Media error (code ${err.code})` : 'Failed to load video'));
        };
        const cleanup = () => {
          dom.videoPlayer.removeEventListener('canplay', onCanPlay);
          dom.videoPlayer.removeEventListener('error', onError);
          clearTimeout(timer);
        };
        // 2 minute timeout for torrent to buffer enough
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('Torrent buffering timed out — try a stream with more seeds'));
        }, 120000);
        dom.videoPlayer.addEventListener('canplay', onCanPlay, { once: true });
        dom.videoPlayer.addEventListener('error', onError, { once: true });
      });

      if (statusInterval) clearInterval(statusInterval);
      const resumeKey = resumeKeyForStream(stream);
      if (resumeKey) applyResumeSeek(resumeKey);
      await dom.videoPlayer.play();
      openCurtains();

      if (resumeKey) {
        _resumeTrackerDetach = attachResumeTracker(resumeKey, {
          title: (state.currentMeta && state.currentMeta.name) || '',
        });
      }

      // Mid-playback stall detection — re-show overlay during rebuffering
      const onStalled = () => {
        dom.playerOverlay.innerHTML = `
          <div class="loading-info">
            <div class="spinner" style="width:32px;height:32px;margin:0 auto 12px;border-width:3px"></div>
            <div class="loading-status">Buffering...</div>
          </div>
        `;
        dom.playerOverlay.classList.remove('hidden');
      };
      const onPlaying = () => {
        if (!_curtainAnimating) dom.playerOverlay.classList.add('hidden');
      };

      // End-of-playback detection. Torrent streams often reach the final
      // frame without the browser firing the native 'ended' event — the
      // media element's duration metadata can be a hair short of the
      // actual data, or the final bytes stall, leaving the video paused
      // on the last frame. We therefore combine the native event with a
      // near-end fallback driven by timeupdate + pause.
      let _endFired = false;
      let _nearEndTimer = null;
      const fireEnded = (reason) => {
        if (_endFired) return;
        _endFired = true;
        if (_nearEndTimer) { clearTimeout(_nearEndTimer); _nearEndTimer = null; }
        console.log(`[autoplay] playback ended (${reason})`);
        // Synthetic end-of-playback paths bypass the native 'ended' event,
        // so clear the saved position here too — otherwise we'd offer to
        // resume a finished video next time it's opened.
        if (resumeKey) clearResumeEntry(resumeKey);
        handlePlaybackEnded();
      };
      const onEnded = () => fireEnded('ended-event');
      const remainingSecs = () => {
        const v = dom.videoPlayer;
        const dur = v.duration;
        if (!Number.isFinite(dur) || dur <= 0) return Infinity;
        return Math.max(0, dur - v.currentTime);
      };
      // Primary detection: close enough that the native 'ended' event
      // should be moments away. Used for timeupdate-based fallback.
      const isAtEnd = () => remainingSecs() <= 0.75;
      // Conservative detection: the stream visibly stalled in the final
      // seconds. Used for pause-based fallback so a user pausing during
      // credits (more than a few seconds from the end) doesn't trigger
      // autoplay by accident.
      const isStalledAtEnd = () => remainingSecs() <= 2.5;
      const onTimeUpdate = () => {
        if (_endFired || _nearEndTimer) return;
        if (!isAtEnd()) return;
        // Give the browser a short window to fire 'ended' on its own.
        // If it doesn't, trigger autoplay handling ourselves.
        _nearEndTimer = setTimeout(() => {
          _nearEndTimer = null;
          if (_endFired) return;
          if (isAtEnd()) fireEnded('near-end-timeout');
        }, 1500);
      };
      const onPause = () => {
        // Torrent streams sometimes stall a few frames before the
        // native 'ended' fires, leaving the video paused in the final
        // couple of seconds. Treat that as end-of-playback, but only
        // within a tight window so ordinary user pauses during credits
        // don't trigger autoplay by mistake.
        if (_endFired || _nearEndTimer) return;
        if (!isStalledAtEnd()) return;
        _nearEndTimer = setTimeout(() => {
          _nearEndTimer = null;
          if (_endFired) return;
          if (dom.videoPlayer.paused && isStalledAtEnd()) {
            fireEnded('pause-at-stream-end');
          }
        }, 1500);
      };
      dom.videoPlayer.addEventListener('waiting', onStalled);
      dom.videoPlayer.addEventListener('stalled', onStalled);
      dom.videoPlayer.addEventListener('playing', onPlaying);
      dom.videoPlayer.addEventListener('ended', onEnded);
      dom.videoPlayer.addEventListener('timeupdate', onTimeUpdate);
      dom.videoPlayer.addEventListener('pause', onPause);
      _playStreamCleanup = () => {
        dom.videoPlayer.removeEventListener('waiting', onStalled);
        dom.videoPlayer.removeEventListener('stalled', onStalled);
        dom.videoPlayer.removeEventListener('playing', onPlaying);
        dom.videoPlayer.removeEventListener('ended', onEnded);
        dom.videoPlayer.removeEventListener('timeupdate', onTimeUpdate);
        dom.videoPlayer.removeEventListener('pause', onPause);
        if (_nearEndTimer) { clearTimeout(_nearEndTimer); _nearEndTimer = null; }
      };
    } catch (e) {
      if (statusInterval) clearInterval(statusInterval);
      let hint = escapeHTML(e.message);
      if (e.message.includes('Media error') || e.message.includes('no supported source')) {
        hint += '<br><span style="font-size:12px">The file format may not be supported by your browser</span>';
      }
      showPlayerError('Playback failed', hint);
    }
  }

  // ─── Auto-play Next ──────────────────────────────
  //
  // When a movie or episode finishes playing we look for the next item in
  // order:
  //   * Series: the next episode by (season, episode) within meta.videos.
  //             Released episodes only (drop unaired ones with a future
  //             `released` date).
  //   * Movies: if the movie belongs to a TMDB collection, fetch the
  //             collection and use the next movie sorted by release year.
  //
  // A short countdown overlay ("Up next...") is shown so the user can cancel
  // or jump in immediately. The feature is controlled by the settings in
  // getAutoplaySettings().

  let _upNextState = null; // { timer, interval, cleanup }

  function clearUpNextOverlay() {
    if (_upNextState) {
      if (_upNextState.timer) clearTimeout(_upNextState.timer);
      if (_upNextState.interval) clearInterval(_upNextState.interval);
      _upNextState = null;
    }
    const el = document.getElementById('up-next-card');
    if (el) el.remove();
  }

  function findNextEpisode(meta, currentSeasonEp) {
    if (!meta || !Array.isArray(meta.videos) || !currentSeasonEp) return null;

    const now = Date.now();
    const eps = meta.videos
      .filter(v => v.season != null && v.episode != null)
      .filter(v => {
        // Drop unreleased episodes (air date in the future) so we don't try
        // to play something that doesn't exist yet.
        if (!v.released) return true;
        const t = Date.parse(v.released);
        return !Number.isFinite(t) || t <= now;
      })
      .sort((a, b) => (a.season - b.season) || (a.episode - b.episode));

    const idx = eps.findIndex(v =>
      v.season === currentSeasonEp.season && v.episode === currentSeasonEp.episode
    );
    if (idx < 0 || idx >= eps.length - 1) return null;

    const next = eps[idx + 1];
    // Compute absolute episode index (1-based) for anime numbering, matching
    // the calculation in attachEpisodeHandlers().
    const absoluteEpisode = idx + 2;
    return { ...next, absoluteEpisode };
  }

  // Return shape:
  //   { status: 'no-collection' }       — movie is not part of a collection
  //   { status: 'ok', next }             — found the next movie
  //   { status: 'end' }                  — this is the final movie in the collection
  //   { status: 'not-found' }            — current movie not present in server response
  //   { status: 'error', message }       — fetch / parse failure
  async function findNextMovieInCollection(meta) {
    if (!meta || !meta.collectionId) return { status: 'no-collection' };
    const currentImdb = meta.imdb_id || (typeof meta.id === 'string' && meta.id.startsWith('tt') ? meta.id : null);
    if (!currentImdb) return { status: 'no-collection' };

    try {
      const resp = await fetch(`/api/collections/${encodeURIComponent(meta.collectionId)}`);
      if (!resp.ok) {
        return { status: 'error', message: `Collection lookup failed (HTTP ${resp.status})` };
      }
      const data = await resp.json();
      const movies = Array.isArray(data.movies) ? data.movies : [];
      // Server already sorts by year, but sort again defensively.
      const sorted = movies
        .filter(m => m && m.imdb_id)
        .slice()
        .sort((a, b) => String(a.year || '9999').localeCompare(String(b.year || '9999')));

      if (sorted.length === 0) {
        return { status: 'error', message: 'Collection returned no movies' };
      }

      const idx = sorted.findIndex(m => m.imdb_id === currentImdb);
      if (idx < 0) return { status: 'not-found' };
      if (idx >= sorted.length - 1) return { status: 'end' };
      return { status: 'ok', next: sorted[idx + 1] };
    } catch (e) {
      console.warn('[autoplay] collection fetch failed:', e);
      return { status: 'error', message: e.message || 'Collection lookup failed' };
    }
  }

  // Resolve a stream for the next item and start playing it without relying
  // on the detail-view DOM. Used by the auto-play-next flow so it can work
  // while the user is still inside the player.
  async function autoplayLoadAndPlay({ type, id, seasonEpisode, nextMeta, fallbackTitle }) {
    // Update app state so the player, Back navigation, and future auto-play
    // decisions all operate on the new item.
    state.currentType = type;
    if (nextMeta) state.currentMeta = nextMeta;
    if (type === 'series' && seasonEpisode) {
      state.currentSeasonEp = { season: seasonEpisode.season, episode: seasonEpisode.episode };
      state.currentSeason = seasonEpisode.season;
    } else if (type === 'movie') {
      state.currentSeasonEp = null;
    }

    // Show the curtain overlay while we look for a stream, reusing the
    // existing loading UX.
    const poster = (state.currentMeta && state.currentMeta.poster) || '';
    const title = (state.currentMeta && state.currentMeta.name) || fallbackTitle || '';
    showCurtainOverlay({
      poster,
      title,
      status: 'Finding next stream...',
      subtitle: '',
    });

    try {
      const streams = await api.getStreams(type, id, seasonEpisode, title);
      if (!streams || streams.length === 0) {
        showPlayerError('No streams found', 'Could not find a stream for the next item');
        return;
      }

      // Prefer the quick race for a clear winner, then fall back to a full
      // ranking to pick the best playable stream.
      let chosen = null;
      try {
        const raceResult = await api.raceTopStreams(streams);
        if (raceResult && raceResult.winner) chosen = raceResult.winner;
      } catch (e) {
        console.warn('[autoplay] race failed:', e);
      }

      if (!chosen) {
        const ranked = await api.testAndRankStreams(streams);
        const best = ranked.find(r => r.responseTime < Infinity);
        chosen = best ? best.stream : null;
      }

      if (!chosen) {
        showPlayerError('No playable stream', 'Could not find a playable stream for the next item');
        return;
      }

      playStream(chosen);
    } catch (e) {
      console.warn('[autoplay] stream lookup failed:', e);
      showPlayerError('Auto-play failed', escapeHTML(e.message || 'Unknown error'));
    }
  }

  async function handlePlaybackEnded() {
    const settings = getAutoplaySettings();
    if (!settings.enabled) return;
    if (state.currentView !== 'player') return;
    const meta = state.currentMeta;
    if (!meta) return;

    if (state.currentType === 'series') {
      const next = findNextEpisode(meta, state.currentSeasonEp);
      if (!next) {
        showToast('End of series');
        return;
      }
      showUpNextOverlay({
        title: next.title || `Episode ${next.episode}`,
        subtitle: `Season ${next.season} · Episode ${next.episode}`,
        poster: meta.poster || '',
        countdownSeconds: settings.countdownSeconds,
        onPlay: () => {
          const showId = meta.imdb_id || meta.id;
          autoplayLoadAndPlay({
            type: 'series',
            id: showId,
            seasonEpisode: {
              season: next.season,
              episode: next.episode,
              absoluteEpisode: next.absoluteEpisode,
              genres: meta.genres,
            },
            nextMeta: meta, // stay on the same show meta for series
            fallbackTitle: `${meta.name || ''} — S${next.season}E${next.episode}`,
          });
        },
      });
      return;
    }

    if (state.currentType === 'movie') {
      const result = await findNextMovieInCollection(meta);
      if (result.status === 'no-collection') return; // silent — most movies aren't in a collection
      if (result.status === 'end') {
        showToast(`End of ${meta.collectionName || 'collection'}`);
        return;
      }
      if (result.status === 'not-found') {
        showToast('Could not locate this movie in its collection');
        return;
      }
      if (result.status === 'error') {
        showToast(`Auto-play unavailable: ${result.message}`);
        return;
      }
      const next = result.next;
      if (!next || !next.imdb_id) return;
      showUpNextOverlay({
        title: next.name || 'Next movie',
        subtitle: next.year ? `${meta.collectionName || 'Next in collection'} · ${next.year}` : (meta.collectionName || ''),
        poster: next.poster || meta.poster || '',
        countdownSeconds: settings.countdownSeconds,
        onPlay: async () => {
          // Load full meta for the next movie so the player header, recently
          // played entry, and future auto-play lookups all reflect it.
          let nextMeta = null;
          try { nextMeta = await api.getMeta('movie', next.imdb_id); } catch {}
          if (!nextMeta) {
            // Minimal shim so state.currentMeta is still useful.
            nextMeta = {
              id: next.imdb_id,
              imdb_id: next.imdb_id,
              type: 'movie',
              name: next.name,
              poster: next.poster || '',
              year: next.year || '',
              description: next.overview || '',
            };
          }
          // Track in recently played, same as openDetail does.
          try { addRecentlyPlayed('movie', nextMeta); } catch {}
          autoplayLoadAndPlay({
            type: 'movie',
            id: next.imdb_id,
            seasonEpisode: undefined,
            nextMeta,
            fallbackTitle: next.name || '',
          });
        },
      });
    }
  }

  function showUpNextOverlay({ title, subtitle, poster, countdownSeconds, onPlay }) {
    clearUpNextOverlay();

    const container = document.getElementById('player-container') || document.body;
    const card = document.createElement('div');
    card.id = 'up-next-card';
    card.className = 'up-next-card';
    const safeTitle = escapeHTML(title || '');
    const safeSubtitle = escapeHTML(subtitle || '');
    card.innerHTML = `
      <div class="up-next-header">Up next</div>
      <div class="up-next-body">
        ${poster ? `<img class="up-next-poster" src="${poster}" alt="">` : ''}
        <div class="up-next-info">
          <div class="up-next-title">${safeTitle}</div>
          ${safeSubtitle ? `<div class="up-next-subtitle">${safeSubtitle}</div>` : ''}
          <div class="up-next-countdown">Playing in <span id="up-next-seconds">${countdownSeconds}</span>s</div>
        </div>
      </div>
      <div class="up-next-actions">
        <button type="button" class="up-next-cancel" id="up-next-cancel">Cancel</button>
        <button type="button" class="up-next-play" id="up-next-play">Play now</button>
      </div>
    `;
    container.appendChild(card);

    let remaining = countdownSeconds;
    const secondsEl = card.querySelector('#up-next-seconds');
    const interval = setInterval(() => {
      remaining -= 1;
      if (secondsEl) secondsEl.textContent = String(Math.max(0, remaining));
      if (remaining <= 0) {
        clearInterval(interval);
      }
    }, 1000);

    const timer = setTimeout(() => {
      clearUpNextOverlay();
      try { onPlay && onPlay(); } catch (e) { console.warn('[autoplay] onPlay failed:', e); }
    }, Math.max(0, countdownSeconds) * 1000);

    _upNextState = { timer, interval };

    card.querySelector('#up-next-cancel').addEventListener('click', () => {
      clearUpNextOverlay();
    });
    card.querySelector('#up-next-play').addEventListener('click', () => {
      clearUpNextOverlay();
      try { onPlay && onPlay(); } catch (e) { console.warn('[autoplay] onPlay failed:', e); }
    });
  }

  // ─── Library ─────────────────────────────────────

  function showLibraryStreamPicker(ranked) {
    if (!state.currentMeta || ranked.length === 0) {
      showToast('No streams available to download');
      return;
    }

    // Use the best stream by default
    const best = ranked[0].stream;
    addToLibrary(best);
  }

  async function addToLibrary(stream) {
    const meta = state.currentMeta;
    if (!meta || !stream) return;

    const infoHash = stream.infoHash;
    const magnetUri = stream.magnetUri || stream.url;
    if (!infoHash || !magnetUri) {
      showToast('This stream cannot be downloaded');
      return;
    }

    const btn = document.getElementById('add-to-library-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Adding...';
    }

    try {
      const body = {
        imdbId: meta.imdb_id || meta.id,
        type: state.currentType || 'movie',
        name: meta.name || 'Unknown',
        poster: meta.poster || '',
        year: meta.releaseInfo || meta.year || '',
        magnetUri,
        infoHash,
        quality: stream.quality || '',
        size: stream.size || '',
      };

      const resp = await fetch('/api/library/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || 'Failed to add to library');
      }

      if (data.status === 'already_exists') {
        showToast('Already in your library');
      } else if (data.status === 'already_downloading') {
        showToast('Already downloading');
      } else if (data.status === 'already_queued') {
        showToast('Already queued for download');
      } else if (data.status === 'queued') {
        showToast('Download queued — will start when a slot opens');
      } else {
        showToast('Added to library — downloading...');
      }

      if (btn) {
        btn.innerHTML = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
          In Library
        `;
      }
    } catch (err) {
      showToast(err.message);
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Add to Library
        `;
      }
    }
  }

  async function loadSeasonPacks(showId, season, meta) {
    const sc = document.getElementById('stream-container');
    if (!sc) return;

    const streams = await api.getSeasonPackStreams(showId, season, meta && meta.name);

    if (streams.length === 0) {
      sc.innerHTML = `
        <div class="empty-state" style="padding:24px 0">
          <p>No season packs found</p>
          <p style="font-size:12px;color:var(--text-muted)">Try downloading episodes individually instead</p>
        </div>
      `;
      return;
    }

    let html = `<h4 style="margin:0 0 12px;font-size:14px;color:var(--text-dim)">Season ${season} Packs (${streams.length} found)</h4>`;
    html += '<div class="season-pack-results">';
    streams.forEach((s, i) => {
      const title = s.title || 'Unknown';
      const lines = title.split('\n');
      const mainTitle = escapeHTML(lines[0]);
      const detail = lines.slice(1).map(l => escapeHTML(l)).join(' &middot; ');
      const seeds = s.seeds || 0;
      let seedColor = 'var(--success)';
      let seedBg = 'rgba(0,206,201,0.15)';
      if (seeds < 5) { seedColor = 'var(--danger)'; seedBg = 'rgba(255,107,107,0.15)'; }
      else if (seeds < 20) { seedColor = 'var(--warning)'; seedBg = 'rgba(253,203,110,0.15)'; }

      html += `
        <div class="stream-item season-pack-item" data-pack-index="${i}">
          <div class="stream-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          </div>
          <div class="stream-info">
            <div class="stream-title">${mainTitle}</div>
            <div class="stream-detail">${detail}</div>
          </div>
          <span class="stream-quality" style="background:${seedBg};color:${seedColor}">${seeds} seeds</span>
        </div>
      `;
    });
    html += '</div>';

    sc.innerHTML = html;

    // Attach click handlers to pack items
    sc.querySelectorAll('.season-pack-item').forEach(item => {
      item.addEventListener('click', () => {
        const idx = parseInt(item.dataset.packIndex, 10);
        const stream = streams[idx];
        if (!stream) return;

        // Highlight selected
        sc.querySelectorAll('.season-pack-item').forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');

        // Show or update download button
        let dlBtn = document.getElementById('season-pack-dl-btn');
        if (!dlBtn) {
          const btnHtml = `<button id="season-pack-dl-btn" class="season-pack-download-btn">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Download Season ${season}
          </button>`;
          sc.insertAdjacentHTML('beforeend', btnHtml);
          dlBtn = document.getElementById('season-pack-dl-btn');
        }

        dlBtn.onclick = () => addSeasonPackToLibrary(stream, season, meta);
      });
    });
  }

  async function addSeasonPackToLibrary(stream, season, meta) {
    const btn = document.getElementById('season-pack-dl-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Starting download...';
    }

    try {
      const body = {
        imdbId: meta.imdb_id || meta.id,
        name: meta.name || 'Unknown',
        poster: meta.poster || '',
        year: meta.releaseInfo || meta.year || '',
        magnetUri: stream.magnetUri || stream.url,
        infoHash: stream.infoHash,
        quality: stream.quality || '',
        size: stream.size || '',
        season,
      };

      const resp = await fetch('/api/library/add-pack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || 'Failed to start season pack download');
      }

      if (data.status === 'already_downloading') {
        showToast('This season pack is already downloading');
      } else if (data.status === 'no_video_files') {
        showToast('No video files found in this torrent');
      } else if (data.status === 'all_exist') {
        showToast('All episodes already in library');
      } else {
        const count = (data.items || []).filter(i => i.status === 'started').length;
        showToast(`Season pack downloading — ${count} episode${count !== 1 ? 's' : ''} added to library`);
      }

      if (btn) {
        btn.innerHTML = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
          Downloading
        `;
      }
    } catch (err) {
      showToast(err.message);
      if (btn) {
        btn.disabled = false;
        btn.textContent = `Download Season ${season}`;
      }
    }
  }

  async function loadCompleteStreams(showId, meta, containerId) {
    const sc = document.getElementById(containerId || 'stream-container');
    if (!sc) return;

    const streams = await api.getCompleteStreams(showId, meta && meta.name);

    if (streams.length === 0) {
      sc.innerHTML = `
        <div class="empty-state" style="padding:24px 0">
          <p>No complete packs found</p>
          <p style="font-size:12px;color:var(--text-muted)">Try searching for individual seasons or episodes instead</p>
        </div>
      `;
      return;
    }

    let html = `<h4 style="margin:0 0 12px;font-size:14px;color:var(--text-dim)">Complete Packs (${streams.length} found)</h4>`;
    html += '<div class="season-pack-results">';
    streams.forEach((s, i) => {
      const title = s.title || 'Unknown';
      const lines = title.split('\n');
      const mainTitle = escapeHTML(lines[0]);
      const detail = lines.slice(1).map(l => escapeHTML(l)).join(' &middot; ');
      const seeds = s.seeds || 0;
      let seedColor = 'var(--success)';
      let seedBg = 'rgba(0,206,201,0.15)';
      if (seeds < 5) { seedColor = 'var(--danger)'; seedBg = 'rgba(255,107,107,0.15)'; }
      else if (seeds < 20) { seedColor = 'var(--warning)'; seedBg = 'rgba(253,203,110,0.15)'; }

      html += `
        <div class="stream-item complete-pack-item" data-pack-index="${i}">
          <div class="stream-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          </div>
          <div class="stream-info">
            <div class="stream-title">${mainTitle}</div>
            <div class="stream-detail">${detail}</div>
          </div>
          <span class="stream-quality" style="background:${seedBg};color:${seedColor}">${seeds} seeds</span>
        </div>
      `;
    });
    html += '</div>';

    sc.innerHTML = html;

    // Attach click handlers to complete pack items
    sc.querySelectorAll('.complete-pack-item').forEach(item => {
      item.addEventListener('click', () => {
        const idx = parseInt(item.dataset.packIndex, 10);
        const stream = streams[idx];
        if (!stream) return;

        // Highlight selected
        sc.querySelectorAll('.complete-pack-item').forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');

        // Show or update download button
        let dlBtn = document.getElementById('complete-pack-dl-btn');
        if (!dlBtn) {
          const btnHtml = `<button id="complete-pack-dl-btn" class="season-pack-download-btn">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Download Complete
          </button>`;
          sc.insertAdjacentHTML('beforeend', btnHtml);
          dlBtn = document.getElementById('complete-pack-dl-btn');
        }

        dlBtn.onclick = () => addCompletePackToLibrary(stream, meta);
      });
    });
  }

  async function addCompletePackToLibrary(stream, meta) {
    const btn = document.getElementById('complete-pack-dl-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Starting download...';
    }

    try {
      const body = {
        imdbId: meta.imdb_id || meta.id,
        name: meta.name || 'Unknown',
        poster: meta.poster || '',
        year: meta.releaseInfo || meta.year || '',
        magnetUri: stream.magnetUri || stream.url,
        infoHash: stream.infoHash,
        quality: stream.quality || '',
        size: stream.size || '',
        season: 0,
      };

      const resp = await fetch('/api/library/add-pack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || 'Failed to start complete pack download');
      }

      if (data.status === 'already_downloading') {
        showToast('This pack is already downloading');
      } else if (data.status === 'no_video_files') {
        showToast('No video files found in this torrent');
      } else if (data.status === 'all_exist') {
        showToast('All files already in library');
      } else {
        const count = (data.items || []).filter(i => i.status === 'started').length;
        showToast(`Complete pack downloading — ${count} file${count !== 1 ? 's' : ''} added to library`);
      }

      if (btn) {
        btn.innerHTML = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
          Downloading
        `;
      }
    } catch (err) {
      showToast(err.message);
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Download Complete';
      }
    }
  }

  async function loadLibrary() {
    hideLibraryGroupOverlay();
    dom.libraryContent.innerHTML = '';
    dom.libraryEmpty.classList.add('hidden');

    dom.libraryContent.innerHTML = `
      <div class="loading-state" style="grid-column:1/-1">
        <div class="spinner"></div>
        <p>Loading library...</p>
      </div>
    `;

    try {
      const [libResp, reviewResp] = await Promise.all([
        fetch('/api/library').then(r => { if (!r.ok) throw new Error(`Library API ${r.status}`); return r.json(); }).catch(e => { console.error('[Library] fetch failed:', e); return { items: [] }; }),
        fetch('/api/library/review-queue').then(r => r.ok ? r.json() : { items: [] }).catch(() => ({ items: [] })),
      ]);

      const libraryItems = libResp.items || [];
      const reviewItems = reviewResp.items || [];
      console.log(`[Library] ${libraryItems.length} library items, ${reviewItems.length} in review queue`);
      updateLibraryBadge(reviewItems.length);

      // Compute queue positions for queued items (FIFO by addedAt)
      const queuedItems = libraryItems.filter(i => i.status === 'queued').sort((a, b) => a.addedAt - b.addedAt);
      queuedItems.forEach((item, idx) => { item._queuePosition = idx + 1; });

      if (libraryItems.length === 0) {
        dom.libraryContent.innerHTML = '';
        dom.libraryEmpty.classList.remove('hidden');
        return;
      }

      // Separate movies and TV shows
      const movies = libraryItems.filter(i => i.type !== 'series');
      const shows = libraryItems.filter(i => i.type === 'series');

      // Group shows so different series in the same torrent ("Naruto" vs
      // "Naruto Shippuden") stay separate but episodes of the same show land
      // together even when only half of them have an imdbId yet.
      //
      // Key priority:
      //   1. imdbId when present — the canonical identity
      //   2. a normalized showName (lowercase, punctuation/year stripped)
      //   3. a normalized name as a last resort
      // After the initial grouping we fold same-imdbId groups into one so
      // items that get matched mid-session don't spawn a duplicate tile.
      const normShowKey = (s) => (s || '')
        .toLowerCase()
        .replace(/\s*\(\d{4}\)\s*$/, '')
        .replace(/\s+\d{4}\s*$/, '')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const showGroups = new Map();
      for (const ep of shows) {
        const normName = normShowKey(ep.showName || ep.name);
        const showKey = ep.imdbId ? `imdb:${ep.imdbId}` : (normName ? `name:${normName}` : 'unknown');
        if (!showGroups.has(showKey)) {
          showGroups.set(showKey, { name: ep.showName || ep.name, imdbId: ep.imdbId, poster: ep.poster, year: ep.year, seasons: new Map(), _normKey: normName });
        }
        const group = showGroups.get(showKey);
        if (!group.poster && ep.poster) group.poster = ep.poster;
        if (!group.imdbId && ep.imdbId) group.imdbId = ep.imdbId;
        if (!group.year && ep.year) group.year = ep.year;
        if (ep.showName && (!group.name || group.name.includes(' - '))) group.name = ep.showName;
        const seasonNum = ep.season || 1;
        if (!group.seasons.has(seasonNum)) {
          group.seasons.set(seasonNum, []);
        }
        group.seasons.get(seasonNum).push(ep);
      }

      // Second pass: merge a "name:Foo" group into an "imdb:tt123" group
      // when they share a normalized show name — the imdb-keyed version
      // won because some episodes were matched, but earlier episodes had
      // no imdbId yet and live in the name-keyed group.
      const mergeTargets = new Map(); // normName -> imdb-keyed group
      for (const [key, group] of showGroups) {
        if (key.startsWith('imdb:') && group._normKey) {
          mergeTargets.set(group._normKey, group);
        }
      }
      for (const [key, group] of [...showGroups]) {
        if (!key.startsWith('name:')) continue;
        const target = mergeTargets.get(group._normKey);
        if (!target) continue;
        for (const [seasonNum, episodes] of group.seasons) {
          if (!target.seasons.has(seasonNum)) target.seasons.set(seasonNum, []);
          target.seasons.get(seasonNum).push(...episodes);
        }
        if (!target.poster && group.poster) target.poster = group.poster;
        showGroups.delete(key);
      }

      // Sort episodes within each season
      for (const group of showGroups.values()) {
        for (const [, episodes] of group.seasons) {
          episodes.sort((a, b) => (a.episode || 0) - (b.episode || 0));
        }
      }

      // Enrich movies with collection data, then render
      let movieCollectionData = { collections: {} };
      if (movies.length > 0) {
        const movieImdbIds = movies.map(m => m.imdbId || '');
        const movieNames = movies.map(m => m.name || '');
        const validIds = movieImdbIds.filter(id => id && /^tt\d+$/.test(id));
        if (validIds.length > 0) {
          try {
            movieCollectionData = await api.enrichWithCollections(movieImdbIds, movieNames);
          } catch (e) {
            console.warn('[Library] Collection enrichment failed:', e.message);
          }
        }
      }

      let html = '';

      // ── Needs Review: items the auto-matcher couldn't confirm ────────
      // Rendered at the top so the user sees ambiguous imports before
      // scrolling through matched content. Each card shows the raw
      // filename plus up to 5 candidate posters for one-click relink.
      if (reviewItems.length > 0) {
        html += `
          <div class="library-section-header library-review-header">
            <span>Needs Review</span>
            <span class="library-review-count">${reviewItems.length}</span>
            <button class="library-review-run" title="Re-run auto-matcher">Auto-match</button>
          </div>
          <div class="library-review-grid">
            ${reviewItems.map(item => renderReviewCard(item)).join('')}
          </div>
        `;
      }

      // Movies section (with collection grouping + genre grouping)
      if (movies.length > 0) {
        html += `<div class="library-section-header">Movies</div>`;

        const colMap = movieCollectionData.collections || {};
        const metaMap = movieCollectionData.movieMeta || {};

        // Build reverse map: imdbId -> collectionId
        const imdbToCol = {};
        for (const [colId, col] of Object.entries(colMap)) {
          for (const movieId of col.movieIds || []) {
            imdbToCol[movieId] = colId;
          }
        }

        const collectionGroups = {};
        const ungroupedMovies = [];
        for (const movie of movies) {
          const colId = imdbToCol[movie.imdbId];
          if (colId) {
            if (!collectionGroups[colId]) collectionGroups[colId] = [];
            collectionGroups[colId].push(movie);
          } else {
            ungroupedMovies.push(movie);
          }
        }

        // Render collection groups as poster tiles (only if 2+ movies)
        _libraryGroupData = {};
        for (const [colId, colMovies] of Object.entries(collectionGroups)) {
          if (colMovies.length >= 2) {
            const col = colMap[colId];
            // Sort by year (from metadata or item.year)
            colMovies.sort((a, b) => {
              const yearA = (metaMap[a.imdbId]?.year || a.year || '9999');
              const yearB = (metaMap[b.imdbId]?.year || b.year || '9999');
              return yearA.localeCompare(yearB);
            });
            _libraryGroupData[colId] = { type: 'collection', name: col.name, poster: col.poster || colMovies[0].poster, movies: colMovies };
            html += libraryGroupTileHTML({ id: colId, name: col.name, poster: col.poster || colMovies[0].poster, count: colMovies.length, type: 'collection' });
          } else {
            ungroupedMovies.push(...colMovies);
          }
        }

        // Group ungrouped movies by genre (smart: try all genres for best fit)
        const genreGroups = {};
        const noGenreMovies = [];

        // First pass: count how many movies each genre would have
        const genreCounts = {};
        for (const movie of ungroupedMovies) {
          const meta = metaMap[movie.imdbId];
          const genres = meta?.genres || [];
          for (const g of genres) {
            genreCounts[g] = (genreCounts[g] || 0) + 1;
          }
        }

        // Second pass: assign each movie to its best genre (largest group)
        for (const movie of ungroupedMovies) {
          const meta = metaMap[movie.imdbId];
          const genres = meta?.genres || [];
          if (genres.length > 0) {
            // Pick the genre with the most movies
            let bestGenre = genres[0];
            let bestCount = genreCounts[genres[0]] || 0;
            for (let i = 1; i < genres.length; i++) {
              const count = genreCounts[genres[i]] || 0;
              if (count > bestCount) {
                bestCount = count;
                bestGenre = genres[i];
              }
            }
            if (!genreGroups[bestGenre]) genreGroups[bestGenre] = [];
            genreGroups[bestGenre].push(movie);
          } else {
            noGenreMovies.push(movie);
          }
        }

        // Sort genres alphabetically, render each as a poster tile
        const sortedGenres = Object.keys(genreGroups).sort();
        for (const genre of sortedGenres) {
          const genreMovies = genreGroups[genre];
          // Sort by year within genre
          genreMovies.sort((a, b) => {
            const yearA = (metaMap[a.imdbId]?.year || a.year || '9999');
            const yearB = (metaMap[b.imdbId]?.year || b.year || '9999');
            return yearA.localeCompare(yearB);
          });
          const genreId = 'genre_' + genre.toLowerCase().replace(/[^a-z0-9]/g, '_');
          _libraryGroupData[genreId] = { type: 'genre', name: genre, poster: genreMovies[0].poster, movies: genreMovies };
          html += libraryGroupTileHTML({ id: genreId, name: genre, poster: genreMovies[0].poster, count: genreMovies.length, type: 'genre' });
        }

        // Render remaining movies that have no genre or are alone in their genre
        if (noGenreMovies.length > 0) {
          noGenreMovies.sort((a, b) => {
            const yearA = (metaMap[a.imdbId]?.year || a.year || '9999');
            const yearB = (metaMap[b.imdbId]?.year || b.year || '9999');
            return yearA.localeCompare(yearB);
          });
          if (noGenreMovies.length > 0) {
            html += `<div class="library-section-header" style="font-size:14px;margin-top:12px">Uncategorized</div>`;
          }
          html += noGenreMovies.map(item => {
            const card = renderLibraryItem(item);
            // Inject data-uncategorized and data-imdb attributes for the categorize feature
            return card.replace('<div class="card"', `<div class="card" data-uncategorized="true" data-imdb="${escapeHTML(item.imdbId || '')}" data-movie-name="${escapeHTML(item.name || '')}"`);
          }).join('');
        }
      }

      // TV Shows section — render each show as a poster tile (like movies).
      // Tapping a tile opens an overlay with seasons + episode list.
      if (showGroups.size > 0) {
        html += `<div class="library-section-header">TV Shows</div>`;
        let showIndex = 0;
        for (const [, group] of showGroups) {
          const totalEpisodes = [...group.seasons.values()].reduce((sum, eps) => sum + eps.length, 0);
          const showId = 'show_' + showIndex++;
          // Convert seasons Map -> sorted array for the overlay renderer.
          const seasonsArr = [...group.seasons.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([seasonNum, episodes]) => ({ season: seasonNum, episodes }));
          _libraryGroupData[showId] = {
            type: 'show',
            name: group.name,
            year: group.year,
            poster: group.poster,
            imdbId: group.imdbId,
            seasons: seasonsArr,
            totalEpisodes,
          };
          html += libraryGroupTileHTML({
            id: showId,
            name: group.name,
            poster: group.poster,
            count: totalEpisodes,
            type: 'show',
          });
        }
      }

      dom.libraryContent.innerHTML = html;

      // Attach click handlers for movie collection/genre/show tiles
      attachLibraryGroupTileListeners(dom.libraryContent, _libraryGroupData);

      attachLibraryHandlers();

      // Attach categorize buttons on uncategorized movie cards
      attachCategorizeHandlers(dom.libraryContent);

      // Start progress polling for downloading/converting items
      const needsPoll = libraryItems.some(i => i.status === 'downloading' || i.status === 'queued' || i.status === 'converting');
      if (needsPoll) {
        startLibraryProgressPoll();
      }
    } catch (err) {
      dom.libraryContent.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1">
          <p>Failed to load library</p>
          <p style="font-size:12px;color:var(--text-muted)">${escapeHTML(err.message)}</p>
        </div>
      `;
    }
  }

  // Render a Needs Review card: raw filename + up to 5 candidate posters.
  // Candidates come from the auto-matcher's cached TMDB results so clicking
  // one commits the link without a round-trip through the search modal.
  function renderReviewCard(item) {
    const fileName = item.fileName || item.name || '?';
    const parsed = item.parsed || {};
    const guess = parsed.query || parsed.title || parsed.show || '';
    const confidence = item.matchConfidence || 0;
    const confLabel = confidence > 0 ? `${Math.round(confidence * 100)}%` : '—';
    const candidates = Array.isArray(item.candidates) ? item.candidates : [];

    const candHtml = candidates.map(c => {
      const poster = isSafePosterUrl(c.poster) ? c.poster : '';
      const imdb = c.imdbId || '';
      return `
        <button class="review-candidate" data-id="${escapeHTML(item.id)}" data-imdb-id="${escapeHTML(imdb)}" data-name="${escapeHTML(c.name || '')}" data-poster="${escapeHTML(c.poster || '')}" data-year="${escapeHTML(c.year || '')}" data-type="${escapeHTML(c.type || item.type || 'movie')}" title="${escapeHTML((c.name || '') + (c.year ? ' (' + c.year + ')' : ''))}" ${imdb ? '' : 'disabled'}>
          <div class="review-candidate-poster">
            ${poster ? `<img src="${poster}" alt="${escapeHTML(c.name || '')}">` : `<div class="review-candidate-no-poster">${escapeHTML((c.name || '?').slice(0, 2).toUpperCase())}</div>`}
          </div>
          <div class="review-candidate-meta">
            <div class="review-candidate-title">${escapeHTML(c.name || 'Unknown')}</div>
            <div class="review-candidate-sub">${escapeHTML(c.year || '')}${c.imdbId ? '' : ' · no IMDb'}</div>
          </div>
        </button>
      `;
    }).join('');

    const hintLine = [
      parsed.show || parsed.title || '',
      parsed.year ? `(${parsed.year})` : '',
      parsed.season ? `S${String(parsed.season).padStart(2, '0')}` : '',
      parsed.episode ? `E${String(parsed.episode).padStart(2, '0')}` : '',
    ].filter(Boolean).join(' ');

    return `
      <div class="review-card" data-id="${escapeHTML(item.id)}" data-item-name="${escapeHTML(guess || item.name || '')}">
        <div class="review-card-head">
          <div class="review-card-filename" title="${escapeHTML(fileName)}">${escapeHTML(fileName)}</div>
          <div class="review-card-actions">
            <span class="review-card-confidence" title="Auto-matcher confidence">${confLabel}</span>
            <button class="review-card-search" title="Search IMDb manually">Search IMDb</button>
            <button class="review-card-skip" title="Keep current metadata (stop asking)">Keep</button>
          </div>
        </div>
        <div class="review-card-hint">${hintLine ? 'Parsed: ' + escapeHTML(hintLine) : 'Parser couldn\'t recognise this file.'}</div>
        ${candidates.length > 0
          ? `<div class="review-card-candidates">${candHtml}</div>`
          : `<div class="review-card-empty">No auto-match candidates yet — tap "Search IMDb".</div>`}
      </div>
    `;
  }

  function renderLibraryItem(item) {
    const poster = item.poster || '';
    const title = escapeHTML(item.name || 'Unknown');
    const year = item.year || '';
    const quality = item.quality || '';

    // Build poster overlay based on status
    let overlayHtml = '';
    let metaHtml = '';

    if (item.status === 'downloading') {
      const speed = item.downloadSpeed > 0 ? formatSpeed(item.downloadSpeed) : '';
      overlayHtml = `
        <div class="library-card-overlay downloading">${item.progress}%</div>
        <div class="library-card-progress">
          <div class="library-card-progress-bar" style="width:${item.progress}%"></div>
        </div>`;
      metaHtml = `<div class="library-card-meta downloading">${speed || 'Starting...'}${item.numPeers ? ' &middot; ' + item.numPeers + ' peers' : ''}</div>`;
    } else if (item.status === 'converting') {
      const pct = item.convertProgress || 0;
      overlayHtml = `
        <div class="library-card-overlay converting">${pct}%</div>
        <div class="library-card-progress">
          <div class="library-card-progress-bar converting" style="width:${pct}%"></div>
        </div>
        <div class="library-card-play">
          <div class="library-card-play-circle">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </div>
        </div>`;
      metaHtml = `<div class="library-card-meta converting">Converting to MP4...${item.convertError ? ' (retry failed)' : ''}</div>`;
    } else if (item.status === 'paused') {
      overlayHtml = `
        <div class="library-card-overlay paused">Paused ${item.progress || 0}%</div>
        <div class="library-card-progress">
          <div class="library-card-progress-bar paused" style="width:${item.progress || 0}%"></div>
        </div>
        <div class="library-card-play library-card-resume" data-id="${escapeHTML(item.id)}">
          <div class="library-card-play-circle">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </div>
        </div>`;
      metaHtml = `<div class="library-card-meta paused">Paused</div>`;
    } else if (item.status === 'queued') {
      const posText = item._queuePosition ? `#${item._queuePosition} in queue` : 'Waiting...';
      overlayHtml = `<div class="library-card-overlay queued">Queued</div>`;
      metaHtml = `<div class="library-card-meta queued">${posText}</div>`;
    } else if (item.status === 'complete') {
      const size = item.fileSize ? formatSize(item.fileSize) : item.size || '';
      overlayHtml = `
        <div class="library-card-play">
          <div class="library-card-play-circle">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </div>
        </div>`;
      metaHtml = `<div class="library-card-meta complete">${size ? size : 'Ready'}</div>`;
    } else if (item.status === 'failed') {
      overlayHtml = `
        <div class="library-card-overlay failed">${escapeHTML(item.error || 'Failed')}</div>
        <div class="library-card-play library-card-retry" data-id="${escapeHTML(item.id)}">
          <div class="library-card-play-circle">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </div>
        </div>`;
      metaHtml = `<div class="library-card-meta failed">Failed &middot; tap to retry</div>`;
    }

    // Match-state badge: "NEW" for unmatched, "?" for auto-match candidates
    // still pending confirmation, "AUTO" for auto-matched (user can still
    // override via the relink button). Confirmed manual matches get no badge.
    let matchBadge = '';
    if (item.matchState === 'unmatched') {
      matchBadge = `<span class="library-card-match-badge unmatched" title="No IMDb match yet">NEW</span>`;
    } else if (item.matchState === 'needsReview') {
      matchBadge = `<span class="library-card-match-badge needsReview" title="Auto-match uncertain — tap to review">?</span>`;
    } else if (item.matchSource === 'auto') {
      matchBadge = `<span class="library-card-match-badge auto" title="Auto-matched — tap to override">AUTO</span>`;
    }

    return `
      <div class="card" data-id="${escapeHTML(item.id)}" data-imdb-id="${escapeHTML(item.imdbId || '')}" data-item-name="${escapeHTML(item.name || '')}" data-status="${item.status}">
        <div class="card-poster">
          ${poster ? `<img src="${poster}" alt="${title}">` : ''}
          ${!poster ? `<div class="poster-placeholder">${title}</div>` : ''}
          ${matchBadge}
          ${overlayHtml}
          <button class="library-card-relink" data-id="${escapeHTML(item.id)}" title="Re-link to correct IMDB">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
          </button>
          <button class="library-card-remove" data-id="${escapeHTML(item.id)}" title="Remove">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>
        <div class="card-info">
          <div class="card-title">${title}</div>
          <div class="card-year">${year}${quality ? ' &middot; ' + escapeHTML(quality) : ''}</div>
          ${metaHtml}
        </div>
      </div>`;
  }

  // ─── Library Group Overlay ─────────────────────

  let _libraryGroupData = {};
  // Title map for the currently-open TV show overlay. Populated once the
  // Cinemeta metadata resolves; read by the library progress poll so that
  // in-place episode row re-renders (on status transitions) keep the
  // IMDb-derived episode titles instead of reverting to filename-derived
  // fallbacks. Cleared when the overlay is hidden.
  let _showOverlayTitleMap = null;

  function showLibraryGroupOverlay(groupId, groupData) {
    let overlay = document.getElementById('library-group-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'library-group-overlay';
      overlay.className = 'library-group-overlay hidden';
      document.getElementById('view-library').appendChild(overlay);
    }

    const titleText = groupData.name + (groupData.type === 'show' && groupData.year ? ` (${groupData.year})` : '');
    const name = escapeHTML(titleText);

    let bodyHtml;
    if (groupData.type === 'show') {
      bodyHtml = `<div class="library-show-overlay-body">${renderShowOverlayBody(groupData, {})}</div>`;
    } else {
      bodyHtml = `<div class="library-group-overlay-grid library-grid">
        ${(groupData.movies || []).map(item => renderLibraryItem(item)).join('')}
      </div>`;
    }

    overlay.innerHTML = `
      <div class="library-group-overlay-header">
        <button class="library-group-overlay-back" aria-label="Back">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
        <span class="library-group-overlay-title">${name}</span>
      </div>
      ${bodyHtml}
    `;

    overlay.classList.remove('hidden');
    dom.libraryContent.classList.add('hidden');
    const emptyEl = document.getElementById('library-empty');
    if (emptyEl) emptyEl.classList.add('hidden');

    if (groupData.type === 'show') {
      _showOverlayTitleMap = {};
      attachShowOverlayHandlers(overlay);
      // Fetch IMDb episode titles in background and re-render the body
      // when they arrive. We don't block the initial render on this.
      if (groupData.imdbId && /^tt\d+$/.test(groupData.imdbId)) {
        api.getMeta('series', groupData.imdbId).then(meta => {
          const stillOpen = !overlay.classList.contains('hidden');
          if (!stillOpen) return;
          const titleMap = buildEpisodeTitleMap(meta);
          if (Object.keys(titleMap).length === 0) return;
          _showOverlayTitleMap = titleMap;
          const body = overlay.querySelector('.library-show-overlay-body');
          if (!body) return;
          body.innerHTML = renderShowOverlayBody(groupData, titleMap);
          attachShowOverlayHandlers(overlay);
        }).catch(() => {});
      }
    } else {
      // Attach play/remove handlers inside overlay (movie collection/genre)
      attachLibraryHandlers(overlay.querySelector('.library-group-overlay-grid'));
    }

    // Back button
    overlay.querySelector('.library-group-overlay-back').addEventListener('click', () => {
      hideLibraryGroupOverlay();
    });

    // Image load/error handlers
    overlay.querySelectorAll('img.loading').forEach(img => {
      img.addEventListener('load', () => img.classList.remove('loading'));
      img.addEventListener('error', () => { img.style.display = 'none'; });
    });
  }

  // Build a map of `s${season}e${episode}` -> IMDb episode title
  // from a Cinemeta/TMDB series meta object.
  function buildEpisodeTitleMap(meta) {
    const map = {};
    if (!meta || !Array.isArray(meta.videos)) return map;
    for (const v of meta.videos) {
      if (v.season == null || v.episode == null) continue;
      const key = `s${v.season}e${v.episode}`;
      const title = v.title || v.name;
      if (title) map[key] = title;
    }
    return map;
  }

  // Render the body of a show overlay: each season as a list section,
  // and each episode as a row showing the IMDb title (when available).
  function renderShowOverlayBody(groupData, titleMap) {
    const seasons = groupData.seasons || [];
    let html = '';
    for (const { season, episodes } of seasons) {
      html += `<div class="library-show-season">`;
      html += `<div class="library-show-season-header">Season ${season} <span class="library-show-season-count">(${episodes.length} episode${episodes.length !== 1 ? 's' : ''})</span></div>`;
      html += `<div class="library-show-episode-list">`;
      for (const ep of episodes) {
        html += renderLibraryEpisodeRow(ep, titleMap);
      }
      html += `</div></div>`;
    }
    return html;
  }

  // Render a single episode row for the show overlay. Shows the IMDb
  // title when we have one, otherwise falls back to the filename-derived
  // name. Includes status indicators (downloading/queued/etc).
  function renderLibraryEpisodeRow(item, titleMap) {
    const epNum = item.episode != null ? item.episode : null;
    const seasonNum = item.season != null ? item.season : null;
    const key = (seasonNum != null && epNum != null) ? `s${seasonNum}e${epNum}` : null;
    const imdbTitle = key ? (titleMap || {})[key] : null;
    const fallbackName = item.name || (epNum != null ? `Episode ${epNum}` : 'Episode');
    const displayTitle = imdbTitle || fallbackName;
    const subText = imdbTitle && imdbTitle !== fallbackName ? fallbackName : '';
    const numLabel = epNum != null ? String(epNum) : '?';

    let statusHtml = '';
    let statusClass = '';
    const status = item.status;
    if (status === 'downloading') {
      const speed = item.downloadSpeed > 0 ? formatSpeed(item.downloadSpeed) : '';
      statusClass = 'is-downloading';
      statusHtml = `
        <div class="library-episode-status downloading">${item.progress || 0}%${speed ? ' &middot; ' + speed : ''}</div>
        <div class="library-episode-progress"><div class="library-episode-progress-bar" style="width:${item.progress || 0}%"></div></div>
      `;
    } else if (status === 'converting') {
      const pct = item.convertProgress || 0;
      statusClass = 'is-converting';
      statusHtml = `
        <div class="library-episode-status converting">Converting ${pct}%</div>
        <div class="library-episode-progress"><div class="library-episode-progress-bar converting" style="width:${pct}%"></div></div>
      `;
    } else if (status === 'paused') {
      statusClass = 'is-paused';
      statusHtml = `<div class="library-episode-status paused">Paused ${item.progress || 0}%</div>`;
    } else if (status === 'queued') {
      const posText = item._queuePosition ? `#${item._queuePosition} in queue` : 'Queued';
      statusClass = 'is-queued';
      statusHtml = `<div class="library-episode-status queued">${posText}</div>`;
    } else if (status === 'failed') {
      statusClass = 'is-failed';
      statusHtml = `<div class="library-episode-status failed">Failed &middot; tap to retry</div>`;
    } else if (status === 'complete') {
      statusClass = 'is-complete';
    }

    return `
      <div class="library-episode-row ${statusClass}" data-id="${escapeHTML(item.id)}" data-status="${escapeHTML(status || '')}">
        <div class="library-episode-num">${numLabel}</div>
        <div class="library-episode-info">
          <div class="library-episode-title">${escapeHTML(displayTitle)}</div>
          ${subText ? `<div class="library-episode-sub">${escapeHTML(subText)}</div>` : ''}
          ${statusHtml}
        </div>
        <button class="library-episode-remove" data-id="${escapeHTML(item.id)}" title="Remove">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
        </button>
      </div>
    `;
  }

  function attachEpisodeRowHandlers(row) {
    row.addEventListener('click', async (e) => {
      // Ignore clicks on the remove button
      if (e.target.closest('.library-episode-remove')) return;
      const id = row.dataset.id;
      const status = row.dataset.status;
      if (status === 'complete' || status === 'converting') {
        playLibraryItem(id);
      } else if (status === 'paused') {
        try {
          await fetch(`/api/library/${encodeURIComponent(id)}/resume`, { method: 'POST' });
          showToast('Resuming download...');
          loadLibrary();
        } catch { showToast('Failed to resume'); }
      } else if (status === 'failed') {
        try {
          await fetch(`/api/library/${encodeURIComponent(id)}/retry`, { method: 'POST' });
          showToast('Retrying download...');
          loadLibrary();
        } catch { showToast('Failed to retry'); }
      }
    });

    const removeBtn = row.querySelector('.library-episode-remove');
    if (removeBtn) {
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeLibraryItem(removeBtn.dataset.id);
      });
    }
  }

  function attachShowOverlayHandlers(overlay) {
    overlay.querySelectorAll('.library-episode-row').forEach(attachEpisodeRowHandlers);
  }

  function hideLibraryGroupOverlay() {
    const overlay = document.getElementById('library-group-overlay');
    if (overlay) {
      overlay.classList.add('hidden');
      overlay.innerHTML = '';
    }
    _showOverlayTitleMap = null;
    dom.libraryContent.classList.remove('hidden');
  }

  function showManualImportModal() {
    const existing = document.getElementById('manual-import-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'manual-import-modal';
    modal.className = 'categorize-modal';

    modal.innerHTML = `
      <div class="categorize-modal-backdrop"></div>
      <div class="categorize-modal-content" style="max-width:420px">
        <div class="categorize-modal-header">
          <span>Import Torrent</span>
          <button class="categorize-modal-close" aria-label="Close">&times;</button>
        </div>
        <div class="manual-import-form">
          <label class="manual-import-label">Magnet URI or Info Hash <span style="color:var(--danger)">*</span></label>
          <textarea id="manual-import-magnet" class="manual-import-input" rows="3" placeholder="magnet:?xt=urn:btih:... or 40-char hex hash" spellcheck="false"></textarea>
          <label class="manual-import-label">Name <span style="color:var(--text-muted);font-weight:400">(optional)</span></label>
          <input id="manual-import-name" class="manual-import-input" type="text" placeholder="e.g. Movie Name (2024)" maxlength="200">
          <label class="manual-import-label">Type</label>
          <select id="manual-import-type" class="manual-import-input">
            <option value="movie">Movie</option>
            <option value="series">TV Series</option>
          </select>
          <label class="manual-import-label">Quality <span style="color:var(--text-muted);font-weight:400">(optional)</span></label>
          <input id="manual-import-quality" class="manual-import-input" type="text" placeholder="e.g. 1080p, 4K, 720p" maxlength="50">
          <button id="manual-import-submit" class="manual-import-submit-btn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Add to Library
          </button>
          <p id="manual-import-error" class="manual-import-error" style="display:none"></p>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector('.categorize-modal-backdrop').addEventListener('click', close);
    modal.querySelector('.categorize-modal-close').addEventListener('click', close);

    const magnetInput = modal.querySelector('#manual-import-magnet');
    const nameInput = modal.querySelector('#manual-import-name');
    const typeSelect = modal.querySelector('#manual-import-type');
    const qualityInput = modal.querySelector('#manual-import-quality');
    const submitBtn = modal.querySelector('#manual-import-submit');
    const errorEl = modal.querySelector('#manual-import-error');

    magnetInput.focus();

    submitBtn.addEventListener('click', async () => {
      const raw = magnetInput.value.trim();
      if (!raw) {
        errorEl.textContent = 'Please enter a magnet URI or info hash';
        errorEl.style.display = 'block';
        return;
      }

      errorEl.style.display = 'none';
      submitBtn.disabled = true;
      submitBtn.textContent = 'Adding...';

      // Determine if input is magnet URI or bare info hash
      const body = { name: nameInput.value.trim() || undefined, type: typeSelect.value, quality: qualityInput.value.trim() || undefined };
      if (raw.startsWith('magnet:')) {
        body.magnetUri = raw;
      } else if (/^[0-9a-f]{40}$/i.test(raw)) {
        body.infoHash = raw;
      } else {
        errorEl.textContent = 'Enter a valid magnet URI or 40-character hex info hash';
        errorEl.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Add to Library';
        return;
      }

      try {
        const resp = await fetch('/api/library/add-manual', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Failed to add torrent');

        // Multi-file torrents return { status, items: [...] }; single-file
        // returns { id, status, items: [...] } — handle both shapes.
        const startedCount = Array.isArray(data.items)
          ? data.items.filter(i => i.status === 'started').length
          : 0;

        if (data.status === 'no_video_files') {
          throw new Error('No playable video files found in torrent');
        } else if (data.status === 'all_exist') {
          showToast('All files from this torrent are already in your library');
        } else if (data.status === 'already_exists') {
          showToast('Already in your library');
        } else if (data.status === 'already_downloading') {
          showToast('Already downloading');
        } else if (data.status === 'already_queued') {
          showToast('Already queued');
        } else if (data.status === 'queued') {
          showToast('Download queued — will start when a slot opens');
        } else if (startedCount > 1) {
          showToast(`Collection added — downloading ${startedCount} files...`);
        } else {
          showToast('Torrent added — downloading...');
        }

        close();
        loadLibrary();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Add to Library';
      }
    });
  }

  function showCategorizeModal(imdbId, movieName) {
    // Remove any existing modal
    const existing = document.getElementById('categorize-modal');
    if (existing) existing.remove();

    // Collect existing group names from current _libraryGroupData
    const existingGroups = [];
    for (const [groupId, data] of Object.entries(_libraryGroupData)) {
      existingGroups.push({ id: groupId, name: data.name, type: groupId.startsWith('genre_') ? 'genre' : 'collection' });
    }

    const modal = document.createElement('div');
    modal.id = 'categorize-modal';
    modal.className = 'categorize-modal';

    let groupListHtml = '';
    if (existingGroups.length > 0) {
      groupListHtml = `<div class="categorize-section-label">Add to existing group</div>
        <div class="categorize-group-list">
          ${existingGroups.map(g => `<button class="categorize-group-btn" data-genre="${escapeHTML(g.name)}">${escapeHTML(g.name)}</button>`).join('')}
        </div>`;
    }

    modal.innerHTML = `
      <div class="categorize-modal-backdrop"></div>
      <div class="categorize-modal-content">
        <div class="categorize-modal-header">
          <span>Categorize: ${escapeHTML(movieName)}</span>
          <button class="categorize-modal-close" aria-label="Close">&times;</button>
        </div>
        ${groupListHtml}
        <div class="categorize-section-label">Or create new genre</div>
        <div class="categorize-new-genre">
          <input type="text" class="categorize-genre-input" placeholder="e.g. Comedy, Drama, Action..." maxlength="50">
          <button class="categorize-genre-submit">Add</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Close handlers
    const close = () => modal.remove();
    modal.querySelector('.categorize-modal-backdrop').addEventListener('click', close);
    modal.querySelector('.categorize-modal-close').addEventListener('click', close);

    // Existing group buttons
    modal.querySelectorAll('.categorize-group-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const genre = btn.dataset.genre;
        await submitCategorize(imdbId, genre);
        close();
        loadLibrary();
      });
    });

    // New genre submit
    const input = modal.querySelector('.categorize-genre-input');
    const submitBtn = modal.querySelector('.categorize-genre-submit');
    const submitNew = async () => {
      const genre = input.value.trim();
      if (!genre) return;
      await submitCategorize(imdbId, genre);
      close();
      loadLibrary();
    };
    submitBtn.addEventListener('click', submitNew);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitNew(); });
    input.focus();
  }

  async function submitCategorize(imdbId, genre) {
    try {
      await fetch('/api/library/categorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imdbId, genre }),
      });
    } catch (e) {
      console.error('[Library] Categorize failed:', e.message);
    }
  }

  // ─── Re-link Modal (Manual IMDB Linking) ─────────

  function showRelinkModal(itemId, currentName) {
    const existing = document.getElementById('relink-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'relink-modal';
    modal.className = 'relink-modal';

    modal.innerHTML = `
      <div class="relink-modal-backdrop"></div>
      <div class="relink-modal-content">
        <div class="relink-modal-header">
          <span>Re-link: ${escapeHTML(currentName)}</span>
          <button class="relink-modal-close" aria-label="Close">&times;</button>
        </div>
        <div class="relink-search-row">
          <input type="text" class="relink-search-input" placeholder="Search for correct movie or show..." maxlength="200" value="${escapeHTML(currentName)}">
          <button class="relink-search-btn">Search</button>
        </div>
        <div class="relink-results"></div>
      </div>
    `;

    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector('.relink-modal-backdrop').addEventListener('click', close);
    modal.querySelector('.relink-modal-close').addEventListener('click', close);

    const input = modal.querySelector('.relink-search-input');
    const searchBtn = modal.querySelector('.relink-search-btn');
    const resultsDiv = modal.querySelector('.relink-results');

    const doSearch = async () => {
      const query = input.value.trim();
      if (!query) return;
      resultsDiv.innerHTML = '<div class="relink-loading">Searching...</div>';
      searchBtn.disabled = true;

      try {
        const resp = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        if (!resp.ok) throw new Error('Search failed');
        const data = await resp.json();
        const results = data.results || [];

        if (results.length === 0) {
          resultsDiv.innerHTML = '<div class="relink-empty">No results found. Try a different search.</div>';
          return;
        }

        resultsDiv.innerHTML = results.map(r => {
          const poster = isSafePosterUrl(r.poster) ? r.poster : '';
          const imdbId = r.imdb_id || r.id || '';
          const typeBadge = r.type === 'series' ? 'TV' : 'Movie';
          return `
            <div class="relink-result" data-imdb-id="${escapeHTML(imdbId)}" data-name="${escapeHTML(r.name || '')}" data-poster="${escapeHTML(poster)}" data-year="${escapeHTML(r.year || '')}" data-type="${escapeHTML(r.type || 'movie')}">
              <div class="relink-result-poster">
                ${poster ? `<img src="${poster}" alt="${escapeHTML(r.name || '')}">` : `<div class="relink-result-no-poster">${escapeHTML(r.name || '?')}</div>`}
              </div>
              <div class="relink-result-info">
                <div class="relink-result-title">${escapeHTML(r.name || 'Unknown')}</div>
                <div class="relink-result-meta">${r.year || ''}${r.year ? ' · ' : ''}${typeBadge}${imdbId ? ' · ' + escapeHTML(imdbId) : ''}</div>
                ${r.overview ? `<div class="relink-result-overview">${escapeHTML(r.overview.substring(0, 120))}${r.overview.length > 120 ? '...' : ''}</div>` : ''}
              </div>
            </div>
          `;
        }).join('');

        // Attach click handlers on results
        resultsDiv.querySelectorAll('.relink-result').forEach(el => {
          el.addEventListener('click', async () => {
            const imdbId = el.dataset.imdbId;
            const name = el.dataset.name;
            const poster = el.dataset.poster;
            const year = el.dataset.year;
            const type = el.dataset.type;

            if (!imdbId || !imdbId.startsWith('tt')) {
              resultsDiv.innerHTML = '<div class="relink-empty">This item has no IMDB ID and cannot be linked.</div>';
              return;
            }

            el.style.opacity = '0.5';
            el.style.pointerEvents = 'none';

            try {
              const resp = await fetch(`/api/library/${encodeURIComponent(itemId)}/relink`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ imdbId, name, poster, year, type }),
              });
              if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.error || 'Re-link failed');
              }
              close();
              loadLibrary();
            } catch (e) {
              el.style.opacity = '1';
              el.style.pointerEvents = '';
              console.error('[Library] Re-link failed:', e.message);
              resultsDiv.insertAdjacentHTML('afterbegin', `<div class="relink-empty" style="color:var(--danger)">Error: ${escapeHTML(e.message)}</div>`);
            }
          });
        });
      } catch (e) {
        resultsDiv.innerHTML = `<div class="relink-empty">Search failed: ${escapeHTML(e.message)}</div>`;
      } finally {
        searchBtn.disabled = false;
      }
    };

    searchBtn.addEventListener('click', doSearch);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
    input.select();

    // Auto-search with current name
    doSearch();
  }

  function attachCategorizeHandlers(container) {
    container.querySelectorAll('.card[data-uncategorized="true"]').forEach(card => {
      const imdbId = card.dataset.imdb;
      const movieName = card.dataset.movieName;
      if (!imdbId) return;

      // Add a visible categorize button
      const btn = document.createElement('button');
      btn.className = 'library-card-categorize';
      btn.title = 'Categorize';
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h7"/><path d="M15 15l2 2 4-4"/></svg>`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        showCategorizeModal(imdbId, movieName);
      });
      const posterDiv = card.querySelector('.card-poster');
      if (posterDiv) posterDiv.appendChild(btn);
    });
  }

  function attachLibraryGroupTileListeners(container, groupData) {
    container.querySelectorAll('.library-group-tile').forEach(tile => {
      tile.addEventListener('click', (e) => {
        e.stopPropagation();
        const groupId = tile.dataset.groupId;
        const data = groupData[groupId];
        if (data) {
          showLibraryGroupOverlay(groupId, data);
        }
      });
    });

    // Image load/error handlers for tile poster images
    container.querySelectorAll('.library-group-tile img.loading').forEach(img => {
      img.addEventListener('load', () => img.classList.remove('loading'));
      img.addEventListener('error', () => { img.style.display = 'none'; });
    });
  }

  function attachLibraryHandlers(container) {
    container = container || dom.libraryContent;
    // Remove buttons
    container.querySelectorAll('.library-card-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeLibraryItem(btn.dataset.id);
      });
    });

    // Re-link buttons
    container.querySelectorAll('.library-card-relink').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const card = btn.closest('.card');
        const itemId = card.dataset.id;
        const itemName = card.dataset.itemName || '';
        showRelinkModal(itemId, itemName);
      });
    });

    // ── Needs Review handlers ──────────────────────────────────────
    // Candidate poster clicks commit a relink without the search modal.
    container.querySelectorAll('.review-candidate').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (btn.disabled) return;
        const { id, imdbId, name, poster, year, type } = btn.dataset;
        if (!imdbId || !imdbId.startsWith('tt')) {
          showToast('This candidate has no IMDb id');
          return;
        }
        btn.classList.add('is-busy');
        try {
          const resp = await fetch(`/api/library/${encodeURIComponent(id)}/relink`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imdbId, name, poster, year, type }),
          });
          if (!resp.ok) throw new Error('Relink failed');
          showToast(`Linked to ${name}`);
          loadLibrary();
        } catch (err) {
          btn.classList.remove('is-busy');
          showToast('Relink failed');
        }
      });
    });

    // "Search IMDb" opens the full search modal seeded with the parsed query.
    container.querySelectorAll('.review-card-search').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const card = btn.closest('.review-card');
        showRelinkModal(card.dataset.id, card.dataset.itemName || '');
      });
    });

    // "Keep" marks the item manual so auto-match stops nagging.
    container.querySelectorAll('.review-card-skip').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const card = btn.closest('.review-card');
        const id = card.dataset.id;
        try {
          await fetch(`/api/library/${encodeURIComponent(id)}/mark-manual`, { method: 'POST' });
          loadLibrary();
        } catch { showToast('Failed to update'); }
      });
    });

    // Section-header "Auto-match" button re-runs the pass. Paginates so
    // libraries with more than one page worth of unmatched items all get
    // checked in a single click.
    container.querySelectorAll('.library-review-run').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        btn.disabled = true;
        btn.textContent = 'Matching…';
        const totals = { matched: 0, needsReview: 0 };
        let offset = 0;
        const MAX_PAGES = 50;
        try {
          for (let page = 0; page < MAX_PAGES; page++) {
            const resp = await fetch('/api/library/auto-match-all', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ offset }),
            });
            if (!resp.ok) throw new Error('Auto-match failed');
            const data = await resp.json();
            totals.matched     += data.matched     || 0;
            totals.needsReview += data.needsReview || 0;
            if (data.total) btn.textContent = `Matching ${Math.min(data.nextOffset, data.total)}/${data.total}…`;
            if (!data.remaining || data.remaining <= 0) break;
            if (typeof data.nextOffset !== 'number' || data.nextOffset <= offset) break;
            offset = data.nextOffset;
          }
          showToast(`Matched ${totals.matched}, ${totals.needsReview} need review`);
          loadLibrary();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Auto-match';
          showToast('Auto-match failed');
        }
      });
    });

    // Resume buttons on paused library cards
    container.querySelectorAll('.library-card-resume').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        try {
          await fetch(`/api/library/${encodeURIComponent(id)}/resume`, { method: 'POST' });
          showToast('Resuming download...');
          loadLibrary();
        } catch { showToast('Failed to resume'); }
      });
    });

    // Retry buttons on failed library cards
    container.querySelectorAll('.library-card-retry').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        try {
          await fetch(`/api/library/${encodeURIComponent(id)}/retry`, { method: 'POST' });
          showToast('Retrying download...');
          loadLibrary();
        } catch { showToast('Failed to retry'); }
      });
    });

    // Click on card to play if complete or converting (converting items still play via remux)
    container.querySelectorAll('.card[data-status="complete"], .card[data-status="converting"]').forEach(card => {
      card.addEventListener('click', () => {
        playLibraryItem(card.dataset.id);
      });
    });
  }

  // ─── Client media capability detection (lazy, cached) ────────────
  // The browser's <video> element is the source of truth for what codecs
  // will ACTUALLY decode — not user agent strings, not feature flags. We
  // ask canPlayType() once on first call and cache the answer for the
  // rest of the session. The server uses these caps to decide whether a
  // given library file can be direct-played, remuxed, or must be
  // transcoded to a universal H.264/AAC/MP4 target.
  //
  // canPlayType() returns 'probably', 'maybe', or ''. We only trust
  // 'probably' — 'maybe' is the polite "might work" answer browsers give
  // for codecs whose decoder may or may not be installed (HEVC on
  // desktop Chrome is the canonical example). Treating 'maybe' as no
  // means we transcode a handful of extra files, but we never hand the
  // browser something it can't decode and hang for four minutes.
  let _clientCaps = null;
  function getClientCaps() {
    if (_clientCaps) return _clientCaps;
    const v = document.createElement('video');
    const probably = (type) => v.canPlayType(type) === 'probably';
    _clientCaps = {
      h264: probably('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'),
      // Both hvc1 and hev1 fourccs are valid HEVC containers; some browsers
      // only answer yes to one of them. Accept either.
      hevc: probably('video/mp4; codecs="hvc1.1.6.L93.90, mp4a.40.2"')
         || probably('video/mp4; codecs="hev1.1.6.L93.90, mp4a.40.2"'),
      aac:  probably('audio/mp4; codecs="mp4a.40.2"'),
      mp3:  probably('audio/mpeg'),
    };
    console.log('[Client] Media capabilities:', _clientCaps);
    return _clientCaps;
  }

  function clientCapsQuery() {
    const c = getClientCaps();
    return Object.entries(c).filter(([, v]) => v).map(([k]) => k).join(',');
  }

  // Set video src, wait for a playable signal (with timeout), then play().
  // Resolves on successful play(), rejects with a specific Error describing
  // which stage failed — the caller uses that to fall back to transcode.
  //
  // The timeout is NOT a hard deadline. Large MP4s with moov-at-end can
  // take 30-60s to reach 'canplay' on a spinning USB drive because the
  // browser has to do multiple range requests to locate the moov atom
  // before it knows where keyframes are. We watch for activity events
  // (progress, loadedmetadata, suspend) and reset the stall timer on
  // each one. Only a genuinely stuck stream — no bytes received, no
  // metadata parsed, nothing — will actually time out.
  function tryLibraryStream(url, action, resumeKey) {
    return new Promise((resolve, reject) => {
      const v = dom.videoPlayer;

      // Time budget for reaching 'canplay' with NO activity. Any progress
      // event resets this. Transcode gets longer because libx264 on Orin
      // Nano needs a few seconds before it emits the first mp4 fragment.
      const stallMs = action === 'transcode' ? 30000 : 25000;
      // Hard ceiling regardless of activity — protects against pathological
      // cases where the server keeps dribbling bytes but never reaches a
      // playable state.
      const hardMs  = action === 'transcode' ? 120000 : 90000;

      let settled = false;
      let stallTimer = null;
      const startedAt = Date.now();

      // Diagnostic: log every significant video element event so we can
      // see exactly what the browser is doing during playback setup.
      // Gated behind DEBUG_PLAYBACK — 'progress' fires many times per
      // second during load, and during failing playback attempts the
      // hard timer lets us accumulate 90+ seconds of log spam per try
      // across the probe → direct → remux → transcode fallback chain.
      const logEvent = (name) => {
        if (!DEBUG_PLAYBACK) return;
        if (settled) return;
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        console.log(`[Library/${action}] +${elapsed}s ${name} readyState=${v.readyState} networkState=${v.networkState} buffered=${v.buffered.length > 0 ? v.buffered.end(0).toFixed(1) + 's' : '0s'}`);
      };

      const resetStall = () => {
        if (settled) return;
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          if (settled) return; settled = true;
          cleanupListeners();
          reject(new Error(`${action} stalled (no activity for ${stallMs / 1000}s)`));
        }, stallMs);
      };

      const hardTimer = setTimeout(() => {
        if (settled) return; settled = true;
        cleanupListeners();
        const rs = v.readyState;
        const ns = v.networkState;
        const buf = v.buffered.length > 0 ? v.buffered.end(0).toFixed(1) + 's' : '0s';
        reject(new Error(`${action} timed out after ${Math.round((Date.now() - startedAt) / 1000)}s (hard) [readyState=${rs} networkState=${ns} buffered=${buf}]`));
      }, hardMs);

      // Decoder-stuck watchdog. Some files are parseable (metadata loads,
      // progress events fire, the stall timer keeps resetting) but the
      // browser never actually decodes a frame — readyState stays at 1
      // (HAVE_METADATA) forever. Observed on Firefox/Linux with some
      // 8-bit H.264 High profile files whose exact cause isn't
      // determined. If we hit loadedmetadata but never reach loadeddata
      // (readyState 2) within `decoderStuckMs` despite buffered data
      // growing, give up on this action and let the fallback transcode
      // run. Transcode re-encodes to a known-good H.264 baseline that
      // Firefox always decodes.
      //
      // Only armed for direct/remux — transcode's first fragment always
      // produces a loadeddata quickly, so if transcode gets stuck that's
      // a real server problem and the stall/hard timers should catch it.
      const decoderStuckMs = 15000;
      let decoderStuckTimer = null;
      const armDecoderStuckWatchdog = () => {
        if (action === 'transcode') return;
        if (decoderStuckTimer) clearTimeout(decoderStuckTimer);
        decoderStuckTimer = setTimeout(() => {
          if (settled) return;
          // Only fire if we're STILL stuck at HAVE_METADATA. If the browser
          // made it to HAVE_CURRENT_DATA (2) or beyond, onReady will have
          // already resolved this promise.
          if (v.readyState <= 1) {
            settled = true;
            cleanupListeners();
            const buf = v.buffered.length > 0 ? v.buffered.end(0).toFixed(1) + 's' : '0s';
            reject(new Error(`${action} decoder stuck at HAVE_METADATA (buffered=${buf}) — browser can't decode this file`));
          }
        }, decoderStuckMs);
      };

      const cleanupListeners = () => {
        v.removeEventListener('canplay', onReady);
        v.removeEventListener('loadeddata', onReady);
        v.removeEventListener('error', onError);
        v.removeEventListener('progress', onProgress);
        v.removeEventListener('loadedmetadata', onLoadedMetadata);
        v.removeEventListener('loadstart', onLoadStart);
        v.removeEventListener('suspend', onSuspend);
        v.removeEventListener('stalled', onStalled);
        v.removeEventListener('waiting', onWaiting);
        if (stallTimer) clearTimeout(stallTimer);
        if (decoderStuckTimer) clearTimeout(decoderStuckTimer);
        clearTimeout(hardTimer);
      };

      // Ready to play: either canplay OR loadeddata — whichever comes
      // first. loadeddata fires as soon as the first frame is decoded,
      // which is usually earlier and more reliable than canplay.
      const onReady = async (e) => {
        if (settled) return;
        logEvent(e.type + ' (READY)');
        settled = true;
        cleanupListeners();
        // Seek to saved position BEFORE play() so playback starts from the
        // resume point without a visible jump. Ignored if no saved entry,
        // duration unknown, or within the near-end cutoff.
        if (resumeKey) applyResumeSeek(resumeKey);
        try {
          await v.play();
          resolve();
        } catch (playErr) {
          reject(new Error(`play() rejected: ${playErr.message}`));
        }
      };
      const onError = () => {
        if (settled) return;
        logEvent('error');
        settled = true;
        cleanupListeners();
        const err = v.error;
        const code = err ? `code ${err.code}` : 'unknown';
        reject(new Error(`Media error (${code}) on ${action}`));
      };
      const onProgress = () => { logEvent('progress'); resetStall(); };
      const onLoadedMetadata = () => {
        logEvent('loadedmetadata');
        resetStall();
        // Start watching for a stuck decoder. If readyState doesn't
        // advance from HAVE_METADATA (1) to HAVE_CURRENT_DATA (2) within
        // the next few seconds, we know the browser can't decode this
        // file and we should fall back to transcode.
        armDecoderStuckWatchdog();
      };
      const onLoadStart = () => { logEvent('loadstart'); resetStall(); };
      const onSuspend = () => { logEvent('suspend'); resetStall(); };
      const onStalled = () => { logEvent('stalled'); /* don't reset */ };
      const onWaiting = () => { logEvent('waiting'); /* don't reset */ };

      // Attach listeners BEFORE setting src. Firefox can fire events from
      // the synchronous part of the resource selection algorithm when the
      // resource is cached or when the load resolves very fast, and we
      // need to catch those.
      v.addEventListener('canplay', onReady);
      v.addEventListener('loadeddata', onReady);
      v.addEventListener('error', onError, { once: true });
      v.addEventListener('progress', onProgress);
      v.addEventListener('loadedmetadata', onLoadedMetadata);
      v.addEventListener('loadstart', onLoadStart);
      v.addEventListener('suspend', onSuspend);
      v.addEventListener('stalled', onStalled);
      v.addEventListener('waiting', onWaiting);

      // Assign src and start loading. No defensive reset — it introduced
      // more bugs than it fixed. If the element was in an error state
      // from a previous attempt, setting a fresh src triggers a new
      // resource selection algorithm per HTML5 spec, which clears the
      // prior error automatically.
      v.src = url;
      v.load();
      logEvent('src set + load() called');

      resetStall();
    });
  }

  // Single-flight guard for library playback. If the user clicks another
  // item (or the same one twice) while one is already loading, we cancel
  // the in-flight attempt by bumping the generation counter. This prevents
  // concurrent playLibraryItem calls from fighting over the same <video>
  // element, which previously caused "Media error (code 4)" and spurious
  // timeouts because one attempt's v.src assignment was aborting another's.
  let _libraryPlayGeneration = 0;

  async function playLibraryItem(id) {
    // Claim this playback attempt. Any subsequent call to playLibraryItem
    // will bump the generation and our `isStale()` checks will bail out
    // of the older attempt's loops and pending awaits.
    const myGeneration = ++_libraryPlayGeneration;
    const isStale = () => _libraryPlayGeneration !== myGeneration;

    // Flush any prior playback's position and detach its tracker so the
    // upcoming attempt starts clean. (The fallback chain can rebuild src
    // several times, and we only want one tracker attached at a time.)
    stopResumeTracker(true);

    // Grab poster/title from the library card before we navigate away —
    // once we're on the player view, the library DOM is gone.
    const itemEl = dom.libraryContent.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
    const libPoster = itemEl?.querySelector('.card-poster img')?.src || '';
    const libTitle = itemEl?.querySelector('.card-title')?.textContent || '';
    const resumeKey = resumeKeyForLibrary(id);

    navigateTo('player');
    showCurtainOverlay({ poster: libPoster, title: libTitle, status: 'Checking file...' });

    const encodedId = encodeURIComponent(id);
    const caps = clientCapsQuery();

    // ── 1. Probe the file ────────────────────────────────────────────
    // The server uses our caps to pick the right playback endpoint.
    // We trust its decision and follow whatever it tells us to call.
    let probe;
    try {
      // Abort the probe after 10s so we never hang the UI waiting for
      // ffprobe on a broken file.
      const ctrl = new AbortController();
      const probeTimeout = setTimeout(() => ctrl.abort(), 10000);
      let probeResp;
      try {
        probeResp = await fetch(`/api/library/${encodedId}/probe?caps=${caps}`, { signal: ctrl.signal });
      } finally {
        clearTimeout(probeTimeout);
      }

      if (!probeResp.ok) {
        // Parse the server's error body once; never consume the response twice.
        const errData = await probeResp.json().catch(() => ({}));
        if (probeResp.status === 400 && errData.error === 'Download not complete') {
          showPlayerError(
            'Still downloading',
            'This episode hasn\'t finished downloading yet.<br>' +
            '<span style="font-size:12px">Wait for the download to complete and try again.</span>'
          );
          return;
        }
        throw new Error(errData.error || `probe HTTP ${probeResp.status}`);
      }

      probe = await probeResp.json();
      if (isStale()) {
        console.log('[Library] Playback attempt superseded before probe completed — aborting');
        return;
      }
      console.log('[Library] Probe:', probe);
    } catch (e) {
      if (isStale()) return;
      showPlayerError(
        'Playback failed',
        `Couldn\'t check file: ${escapeHTML(e.message)}`
      );
      return;
    }

    // ── 2. Handle unplayable files immediately ───────────────────────
    // These are files where ffprobe itself failed — usually because the
    // file is still downloading, the container is broken, or the disk
    // is missing the bytes we need. No amount of transcoding fixes that.
    if (probe.action === 'unplayable' || !probe.endpoint) {
      const detail = probe.reason || 'Unable to read this file.';
      showPlayerError(
        'Cannot play file',
        `${escapeHTML(detail)}<br>` +
        `<span style="font-size:12px">` +
          `video: ${escapeHTML(probe.videoCodec || '?')}, ` +
          `audio: ${escapeHTML(probe.audioCodec || '?')}, ` +
          `container: ${escapeHTML(probe.ext || '?')}` +
        `</span>`
      );
      return;
    }

    // ── 2b. Handle in-progress background conversion ─────────────────
    // If the server is currently re-encoding this item to a universal
    // MP4, don't spin up a competing live transcode — we'd peg CPU on
    // the Jetson and starve both processes. Show a progress message
    // and let the user come back when it's done.
    if (probe.conversion && probe.conversion.active && probe.action === 'transcode') {
      const pct = probe.conversion.progress || 0;
      const kind = probe.conversion.kind || 'converting';
      showPlayerError(
        'Preparing file for playback',
        `Background ${escapeHTML(kind)} is ${pct}% complete.<br>` +
        `<span style="font-size:12px">` +
          `We're storing a universally playable copy so this only happens once. ` +
          `Try again in a few minutes.` +
        `</span>`
      );
      return;
    }

    // ── 3. Attempt playback with fallback to transcode ───────────────
    // Build an attempt list: first whatever the server recommended,
    // then transcode as a universal fallback if we weren't already
    // transcoding. This handles the corner case where the client's
    // canPlayType() lied ("probably" but actually can't decode).
    const attempts = [{ action: probe.action, endpoint: probe.endpoint }];
    if (probe.action !== 'transcode') {
      attempts.push({
        action: 'transcode',
        endpoint: `/api/library/${encodedId}/stream/transcode?caps=${caps}`,
      });
    }

    const statusText = {
      direct:    'Starting playback...',
      remux:     'Preparing for playback...',
      transcode: 'Transcoding for your browser... (this may take a moment)',
    };

    for (let i = 0; i < attempts.length; i++) {
      if (isStale()) return;
      const { action, endpoint } = attempts[i];
      const statusEl = dom.playerOverlay.querySelector('.loading-status');
      if (statusEl) {
        statusEl.textContent = i > 0
          ? `Retrying: ${statusText[action] || action}`
          : (statusText[action] || 'Loading...');
      }

      try {
        await tryLibraryStream(endpoint, action, resumeKey);
        if (isStale()) return;
        openCurtains();
        if (resumeKey) {
          _resumeTrackerDetach = attachResumeTracker(resumeKey, { title: libTitle });
        }
        return;
      } catch (e) {
        if (isStale()) return;
        console.warn(`[Library] ${action} playback failed:`, e.message);
        const isLastAttempt = i === attempts.length - 1;
        if (isLastAttempt) {
          const hint = formatLibraryPlaybackError(e, probe, action);
          showPlayerError('Playback failed', hint);
          return;
        }
        // fall through and try the next attempt (transcode)
      }
    }
  }

  // Format a user-facing error hint for a failed library playback attempt.
  // The shape of the message depends on WHICH attempt failed — transcode
  // failing means the server itself had a problem, while a direct/remux
  // failure after a successful probe usually means capability detection
  // was wrong and we should've gone straight to transcode.
  function formatLibraryPlaybackError(err, probe, lastAction) {
    const base = escapeHTML(err.message);
    if (lastAction === 'transcode') {
      return `${base}<br>` +
        `<span style="font-size:12px">` +
          `Server transcoding failed. Check the Jetson logs:<br>` +
          `<code>docker logs alabtross-mobile</code>` +
        `</span>`;
    }
    if (err.message.includes('timed out')) {
      return `${base}<br>` +
        `<span style="font-size:12px">Try again — playback sometimes works on a second attempt.</span>`;
    }
    return `${base}<br>` +
      `<span style="font-size:12px">` +
        `video: ${escapeHTML(probe?.videoCodec || '?')}, ` +
        `audio: ${escapeHTML(probe?.audioCodec || '?')}, ` +
        `container: ${escapeHTML(probe?.ext || '?')}` +
      `</span>`;
  }

  async function removeLibraryItem(id) {
    try {
      const resp = await fetch(`/api/library/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!resp.ok) {
        const data = await resp.json();
        throw new Error(data.error || 'Failed to remove');
      }
      showToast('Removed from library');
      loadLibrary();
    } catch (err) {
      showToast(err.message);
    }
  }

  let _libraryPollTimer = null;

  // Re-render a single library card in place after a status transition.
  // Preserves the categorize-feature data-uncategorized/data-imdb attrs
  // that loadLibrary() injects into uncategorized movie cards, and
  // re-binds click/remove/retry/etc. handlers on the freshly-rendered
  // element via a throwaway wrapper (attachLibraryHandlers uses
  // querySelectorAll which wouldn't otherwise match the card itself).
  function replaceLibraryCardInPlace(oldCard, item) {
    const wasUncat = oldCard.dataset.uncategorized === 'true';
    const imdbAttr = oldCard.dataset.imdb || '';
    const movieNameAttr = oldCard.dataset.movieName || '';

    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderLibraryItem(item);
    const newCard = wrapper.firstElementChild;
    if (!newCard) return;

    if (wasUncat) {
      newCard.dataset.uncategorized = 'true';
      newCard.dataset.imdb = imdbAttr;
      newCard.dataset.movieName = movieNameAttr;
    }

    attachLibraryHandlers(wrapper);
    if (wasUncat) attachCategorizeHandlers(wrapper);

    oldCard.replaceWith(newCard);
  }

  function replaceEpisodeRowInPlace(oldRow, item) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderLibraryEpisodeRow(item, _showOverlayTitleMap || {});
    const newRow = wrapper.firstElementChild;
    if (!newRow) return;
    attachEpisodeRowHandlers(newRow);
    oldRow.replaceWith(newRow);
  }

  function startLibraryProgressPoll() {
    stopLibraryProgressPoll();
    _libraryPollTimer = setInterval(async () => {
      if (state.currentView !== 'library') {
        stopLibraryProgressPoll();
        return;
      }
      try {
        const resp = await fetch('/api/library');
        const data = await resp.json();
        const items = data.items || [];

        // Build per-tick element caches so item lookup is O(1). The
        // previous implementation issued one querySelector + CSS.escape
        // per item per tick, which scales as O(n) DOM walks per item
        // — meaningful jank for libraries with hundreds of items.
        const cardMap = new Map();
        dom.libraryContent.querySelectorAll('.card[data-id]').forEach(el => {
          cardMap.set(el.dataset.id, el);
        });

        const showOverlay = document.getElementById('library-group-overlay');
        const showOverlayOpen = showOverlay && !showOverlay.classList.contains('hidden');
        const rowMap = new Map();
        if (showOverlayOpen) {
          showOverlay.querySelectorAll('.library-episode-row[data-id]').forEach(el => {
            rowMap.set(el.dataset.id, el);
          });
        }

        let anyActive = false;
        for (const item of items) {
          const status = item.status;
          if (status === 'downloading' || status === 'queued' || status === 'converting') {
            anyActive = true;
          }

          const el = cardMap.get(item.id);
          if (el) {
            if (el.dataset.status !== status) {
              // Status transition — re-render this single card in place
              // instead of rebuilding the entire library grid.
              replaceLibraryCardInPlace(el, item);
              continue;
            }
            // Same status — update progress fields in place using
            // textContent (never innerHTML) so we don't re-parse HTML
            // or thrash layout on every tick.
            if (status === 'downloading') {
              const bar = el.querySelector('.library-card-progress-bar');
              const overlay = el.querySelector('.library-card-overlay');
              const meta = el.querySelector('.library-card-meta');
              if (bar) bar.style.width = item.progress + '%';
              if (overlay) overlay.textContent = item.progress + '%';
              if (meta) {
                const speed = item.downloadSpeed > 0 ? formatSpeed(item.downloadSpeed) : '';
                const peers = item.numPeers ? ' \u00b7 ' + item.numPeers + ' peers' : '';
                meta.textContent = `${speed || 'Starting...'}${peers}`;
              }
            } else if (status === 'converting') {
              const bar = el.querySelector('.library-card-progress-bar');
              const overlay = el.querySelector('.library-card-overlay');
              const meta = el.querySelector('.library-card-meta');
              const pct = item.convertProgress || 0;
              if (bar) bar.style.width = pct + '%';
              if (overlay) overlay.textContent = pct + '%';
              if (meta) meta.textContent = 'Converting to MP4...';
            }
            continue;
          }

          // Episode rows inside the show overlay (TV episodes)
          if (showOverlayOpen) {
            const row = rowMap.get(item.id);
            if (!row) continue;
            if (row.dataset.status !== (status || '')) {
              // Status transition — re-render this single row in place.
              replaceEpisodeRowInPlace(row, item);
              continue;
            }
            if (status === 'downloading') {
              const bar = row.querySelector('.library-episode-progress-bar');
              const statusEl = row.querySelector('.library-episode-status');
              if (bar) bar.style.width = (item.progress || 0) + '%';
              if (statusEl) {
                const speed = item.downloadSpeed > 0 ? formatSpeed(item.downloadSpeed) : '';
                const speedTxt = speed ? ' \u00b7 ' + speed : '';
                statusEl.textContent = `${item.progress || 0}%${speedTxt}`;
              }
            } else if (status === 'converting') {
              const bar = row.querySelector('.library-episode-progress-bar');
              const statusEl = row.querySelector('.library-episode-status');
              const pct = item.convertProgress || 0;
              if (bar) bar.style.width = pct + '%';
              if (statusEl) statusEl.textContent = `Converting ${pct}%`;
            }
          }
        }

        if (!anyActive) {
          stopLibraryProgressPoll();
        }
      } catch { /* ignore polling errors */ }
    }, 3000);
  }

  function stopLibraryProgressPoll() {
    if (_libraryPollTimer) {
      clearInterval(_libraryPollTimer);
      _libraryPollTimer = null;
    }
  }

  function formatSpeed(bytesPerSec) {
    if (bytesPerSec >= 1e6) return (bytesPerSec / 1e6).toFixed(1) + ' MB/s';
    if (bytesPerSec >= 1e3) return (bytesPerSec / 1e3).toFixed(0) + ' KB/s';
    return bytesPerSec + ' B/s';
  }

  function formatSize(bytes) {
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
    if (bytes >= 1e3) return (bytes / 1e3).toFixed(0) + ' KB';
    return bytes + ' B';
  }

  // ─── Settings ────────────────────────────────────

  function initSettings() {
    // ─── Max Concurrent Streams ─────────────────────
    const maxStreamsInput = $('#setting-max-streams');
    const maxStreamsSave = $('#setting-max-streams-save');
    const maxStreamsStatus = $('#max-streams-status');

    // Load current value from server
    fetch('/api/settings/max-streams').then(r => r.json()).then(data => {
      maxStreamsInput.value = data.maxConcurrentStreams;
    }).catch(() => {});

    maxStreamsSave.addEventListener('click', async () => {
      const value = parseInt(maxStreamsInput.value, 10);
      if (!value || value < 1 || value > 20) {
        maxStreamsStatus.textContent = 'Must be between 1 and 20';
        maxStreamsStatus.style.color = 'var(--danger, #ff6b6b)';
        return;
      }
      try {
        const resp = await fetch('/api/settings/max-streams', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ maxConcurrentStreams: value }),
        });
        if (resp.ok) {
          maxStreamsStatus.textContent = `Saved — max ${value} concurrent streams`;
          maxStreamsStatus.style.color = 'var(--success, #51cf66)';
          showToast(`Max concurrent streams set to ${value}`);
        } else {
          const err = await resp.json();
          maxStreamsStatus.textContent = err.error || 'Failed to save';
          maxStreamsStatus.style.color = 'var(--danger, #ff6b6b)';
        }
      } catch {
        maxStreamsStatus.textContent = 'Network error';
        maxStreamsStatus.style.color = 'var(--danger, #ff6b6b)';
      }
    });

    // ─── Auto-play Next ─────────────────────────────
    const autoplayEnabledInput = $('#setting-autoplay-enabled');
    const autoplayCountdownInput = $('#setting-autoplay-countdown');
    if (autoplayEnabledInput && autoplayCountdownInput) {
      const current = getAutoplaySettings();
      autoplayEnabledInput.checked = current.enabled;
      autoplayCountdownInput.value = String(current.countdownSeconds);

      autoplayEnabledInput.addEventListener('change', () => {
        setAutoplaySettings({ enabled: autoplayEnabledInput.checked });
        showToast(autoplayEnabledInput.checked ? 'Auto-play next enabled' : 'Auto-play next disabled');
      });
      autoplayCountdownInput.addEventListener('change', () => {
        const n = parseInt(autoplayCountdownInput.value, 10);
        if (!Number.isFinite(n) || n < 0 || n > 60) {
          autoplayCountdownInput.value = String(getAutoplaySettings().countdownSeconds);
          return;
        }
        setAutoplaySettings({ countdownSeconds: n });
      });
    }

    // ─── Stremio Addons ──────────────────────────────

    // Add addon
    dom.addonAddBtn.addEventListener('click', async () => {
      const url = dom.addonUrlInput.value.trim();
      if (!url) return;
      dom.addonAddBtn.textContent = '...';
      const result = await api.addAddon(url);
      dom.addonAddBtn.textContent = 'Add';

      if (result.error) {
        showToast(result.error);
      } else {
        dom.addonUrlInput.value = '';
        renderAddonList();
        showToast('Added ' + result.name);
      }
    });

    // Quick-add buttons
    if (dom.addonAddCinemeta) {
      // Cinemeta removed — metadata now served by TMDB. Button kept for backwards compat.
      dom.addonAddCinemeta.style.display = 'none';
    }

    dom.addonAddTorrentio.addEventListener('click', async () => {
      const result = await api.addAddon('https://torrentio.strem.io');
      if (result.error) showToast(result.error);
      else { renderAddonList(); showToast('Added Torrentio'); }
    });

    // ─── Custom Mode Settings ───────────────────────

    // ─── Live TV Sources ───────────────────────────
    renderLiveTVSources();

    // Add M3U playlist
    dom.iptvSaveBtn.addEventListener('click', async () => {
      const url = dom.iptvUrlInput.value.trim();
      if (!url) {
        dom.iptvStatus.textContent = 'Enter a playlist URL';
        dom.iptvStatus.className = 'setting-hint';
        return;
      }
      dom.iptvStatus.textContent = 'Testing playlist...';
      dom.iptvStatus.className = 'setting-hint';
      try {
        const resp = await fetch('/api/iptv/channels?url=' + encodeURIComponent(url));
        const data = resp.ok ? await resp.json() : { channels: [] };
        const count = (data.channels || []).length;
        if (count > 0) {
          const result = api.addLiveTVSource({ type: 'playlist', url, name: 'Playlist' });
          if (result.error) {
            dom.iptvStatus.textContent = result.error;
            dom.iptvStatus.className = 'setting-hint error';
          } else {
            dom.iptvStatus.textContent = `Added — ${count} channels found`;
            dom.iptvStatus.className = 'setting-hint success';
            dom.iptvUrlInput.value = '';
            renderLiveTVSources();
          }
        } else {
          dom.iptvStatus.textContent = 'No channels found — check the URL';
          dom.iptvStatus.className = 'setting-hint error';
        }
      } catch {
        dom.iptvStatus.textContent = 'Failed to fetch playlist';
        dom.iptvStatus.className = 'setting-hint error';
      }
    });

    // Add Stremio TV addon
    if (dom.liveTvAddonInput && dom.liveTvAddonAddBtn) {
      dom.liveTvAddonAddBtn.addEventListener('click', async () => {
        const url = dom.liveTvAddonInput.value.trim().replace(/\/manifest\.json$/, '').replace(/\/$/, '');
        if (!url) return;
        dom.liveTvAddonStatus.textContent = 'Checking addon...';
        dom.liveTvAddonStatus.className = 'setting-hint';
        try {
          const resp = await fetch('/api/addon-proxy?url=' + encodeURIComponent(url + '/manifest.json'), { signal: AbortSignal.timeout(10000) });
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          const manifest = await resp.json();
          const hasTv = manifest.catalogs && manifest.catalogs.some(c => c.type === 'tv');
          if (!hasTv) {
            dom.liveTvAddonStatus.textContent = 'This addon has no TV catalogs';
            dom.liveTvAddonStatus.className = 'setting-hint error';
            return;
          }
          const result = api.addLiveTVSource({
            type: 'stremio-tv',
            url,
            name: manifest.name || 'TV Addon',
          });
          if (result.error) {
            dom.liveTvAddonStatus.textContent = result.error;
            dom.liveTvAddonStatus.className = 'setting-hint error';
          } else {
            dom.liveTvAddonStatus.textContent = `Added ${manifest.name || 'addon'}`;
            dom.liveTvAddonStatus.className = 'setting-hint success';
            dom.liveTvAddonInput.value = '';
            renderLiveTVSources();
          }
        } catch {
          dom.liveTvAddonStatus.textContent = 'Failed to load addon manifest';
          dom.liveTvAddonStatus.className = 'setting-hint error';
        }
      });
    }

    // Quick-add known TV addons
    document.querySelectorAll('.livetv-quick-add').forEach(btn => {
      btn.addEventListener('click', async () => {
        const url = btn.dataset.url;
        const name = btn.dataset.name;
        btn.disabled = true;
        btn.textContent = 'Adding...';
        const result = api.addLiveTVSource({ type: 'stremio-tv', url, name });
        if (result.error) {
          showToast(result.error);
          btn.textContent = `Add ${name}`;
          btn.disabled = false;
        } else {
          showToast(`Added ${name}`);
          btn.textContent = 'Added';
          renderLiveTVSources();
        }
      });
    });

    // ─── Diagnostics Button ───────────────────────
    const diagBtn = $('#run-diagnostics-btn');
    if (diagBtn) {
      diagBtn.addEventListener('click', () => {
        runDiagnostics();
      });
    }

    dom.settingsToggle.addEventListener('click', () => {
      navigateTo('settings');
      renderAddonList();
      renderLiveTVSources();
      refreshDownloads();
    });

    renderAddonList();
  }

  // ─── Downloads Panel ────────────────────────────

  let _downloadsTimer = null;

  function refreshDownloads() {
    // Stop any existing timer
    if (_downloadsTimer) {
      clearInterval(_downloadsTimer);
      _downloadsTimer = null;
    }

    renderDownloads();

    // Auto-refresh while on settings view
    _downloadsTimer = setInterval(() => {
      if (state.currentView === 'settings') {
        renderDownloads();
      } else {
        clearInterval(_downloadsTimer);
        _downloadsTimer = null;
      }
    }, 3000);
  }

  // Group items by packId — pack items become a single aggregate row
  function groupPackItems(items) {
    const packs = new Map();   // packId -> array of items
    const singles = [];
    for (const item of items) {
      if (item.packId) {
        if (!packs.has(item.packId)) packs.set(item.packId, []);
        packs.get(item.packId).push(item);
      } else {
        singles.push(item);
      }
    }
    // Build merged list: singles stay as-is, packs become aggregate objects
    const result = [...singles];
    for (const [packId, packItems] of packs) {
      // Sort episodes within pack
      packItems.sort((a, b) => (a.season || 0) - (b.season || 0) || (a.episode || 0) - (b.episode || 0));
      const first = packItems[0];
      const totalSize = packItems.reduce((s, i) => s + (i.fileSize || 0), 0);
      const completedCount = packItems.filter(i => i.status === 'complete').length;
      const failedCount = packItems.filter(i => i.status === 'failed').length;
      // Weighted progress: aggregate by bytes actually downloaded, not by
      // episode count. A simple average under-reports progress when episode
      // sizes differ (common — S01E01 is often a double episode) and misleads
      // the user about how much of the pack has landed on disk. Fall back to
      // a per-episode average only if we don't have file sizes yet.
      // 'complete' items are always counted as 100% regardless of stored
      // progress — the bitfield-based progress can be 99 when the last piece
      // rounds down, and stale metadata from older sessions may be missing
      // progress entirely.
      const effectivePct = (i) => (i.status === 'complete' ? 100 : (i.progress || 0));
      let totalProgress;
      if (totalSize > 0) {
        const downloadedBytes = packItems.reduce(
          (s, i) => s + ((i.fileSize || 0) * effectivePct(i) / 100),
          0,
        );
        totalProgress = Math.round((downloadedBytes / totalSize) * 100);
      } else {
        totalProgress = packItems.length > 0
          ? Math.round(packItems.reduce((s, i) => s + effectivePct(i), 0) / packItems.length)
          : 0;
      }
      // Aggregate speed/peers (shared engine, so take max — they're the same)
      const speed = Math.max(...packItems.map(i => i.downloadSpeed || 0));
      const peers = Math.max(...packItems.map(i => i.numPeers || 0));
      // Determine aggregate status
      const hasDownloading = packItems.some(i => i.status === 'downloading');
      const hasPaused = packItems.some(i => i.status === 'paused');
      const hasConverting = packItems.some(i => i.status === 'converting');
      const hasQueued = packItems.some(i => i.status === 'queued');
      let aggStatus = 'queued';
      if (completedCount === packItems.length) aggStatus = 'complete';
      else if (failedCount === packItems.length) aggStatus = 'failed';
      else if (hasDownloading) aggStatus = 'downloading';
      else if (hasConverting) aggStatus = 'downloading';
      else if (hasPaused) aggStatus = 'paused';
      else if (hasQueued) aggStatus = 'queued';
      else if (completedCount > 0) aggStatus = 'complete';

      // Determine season label: single season or multi-season
      const uniqueSeasons = [...new Set(packItems.map(i => i.season).filter(Boolean))].sort((a, b) => a - b);
      const packSeason = uniqueSeasons.length === 1 ? uniqueSeasons[0] : null;

      result.push({
        _isPack: true,
        packId,
        name: first.showName || first.name,
        poster: first.poster,
        season: packSeason,
        seasons: uniqueSeasons,
        quality: first.quality,
        status: aggStatus,
        progress: totalProgress,
        downloadSpeed: speed,
        numPeers: peers,
        fileSize: totalSize,
        episodes: packItems,
        completedCount,
        totalCount: packItems.length,
        addedAt: first.addedAt,
      });
    }
    return result;
  }

  // Track which packs are expanded so state survives re-renders
  const _expandedPacks = new Set();

  async function renderDownloads() {
    const panel = $('#downloads-panel');
    if (!panel) return;

    try {
      const resp = await fetch('/api/library');
      if (!resp.ok) throw new Error('Failed');
      const data = await resp.json();
      const items = data.items || [];
      const slots = data.slots || { active: 0, max: 5 };
      const hasSlots = slots.active < slots.max;

      // Group pack items into single aggregate rows
      const grouped = groupPackItems(items);

      // Split into categories (sort queued by addedAt to match actual queue priority)
      const downloading = grouped.filter(i => i.status === 'downloading');
      const paused = grouped.filter(i => i.status === 'paused');
      const queued = grouped.filter(i => i.status === 'queued').sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
      const completed = grouped.filter(i => i.status === 'complete').slice(0, 5);
      const failed = grouped.filter(i => i.status === 'failed');

      if (downloading.length === 0 && paused.length === 0 && queued.length === 0 && completed.length === 0 && failed.length === 0) {
        panel.innerHTML = '<div class="downloads-empty"><span class="setting-hint">No downloads</span></div>';
        renderSourceStats(items);
        return;
      }

      const renderItem = (i, idx, len) => i._isPack ? downloadPackHTML(i, idx, len, hasSlots) : downloadItemHTML(i, idx, len, hasSlots);

      let html = '';

      // Active downloads
      if (downloading.length > 0) {
        html += '<div class="download-section-label">Downloading</div>';
        html += downloading.map(i => renderItem(i)).join('');
      }

      // Paused
      if (paused.length > 0) {
        html += '<div class="download-section-label">Paused</div>';
        html += paused.map(i => renderItem(i)).join('');
      }

      // Queue
      if (queued.length > 0) {
        html += '<div class="download-section-label">Queue (' + queued.length + ')</div>';
        html += queued.map((i, idx) => renderItem(i, idx, queued.length)).join('');
      }

      // Failed
      if (failed.length > 0) {
        html += '<div class="download-section-label">Failed</div>';
        html += failed.map(i => renderItem(i)).join('');
      }

      // Recent completed
      if (completed.length > 0) {
        html += '<div class="download-section-label">Completed</div>';
        html += completed.map(i => renderItem(i)).join('');
      }

      panel.innerHTML = html;
      attachDownloadListeners(panel);

      // Restore expanded state for packs that were open before re-render
      for (const packId of _expandedPacks) {
        const detail = panel.querySelector(`[data-pack-detail="${CSS.escape(packId)}"]`);
        const btn = panel.querySelector(`.pack-expand-btn[data-pack-id="${CSS.escape(packId)}"]`);
        if (detail) detail.classList.remove('collapsed');
        if (btn) btn.classList.add('expanded');
      }

      renderSourceStats(items);
    } catch {
      panel.innerHTML = '<div class="downloads-empty"><span class="setting-hint">Could not load downloads</span></div>';
    }
  }

  function downloadPackHTML(pack, queueIdx, queueLen, hasSlots) {
    const poster = pack.poster
      ? `<img class="download-poster" src="${escapeHTML(pack.poster)}" alt="" loading="lazy">`
      : '<div class="download-poster"></div>';

    // Use formatSpeed/formatSize so slow transfers show KB/s instead of "0.0 MB/s"
    // and small packs render as "450 MB" instead of "0.4 GB".
    const speed = pack.downloadSpeed > 0 ? formatSpeed(pack.downloadSpeed) : '';
    const peers = pack.numPeers > 0 ? `${pack.numPeers} peers` : '';
    const meta = [pack.quality, speed, peers].filter(Boolean).join(' \u00b7 ');

    const totalSizeStr = pack.fileSize > 0 ? formatSize(pack.fileSize) : '';

    const seasonLabel = pack.season
      ? `S${String(pack.season).padStart(2, '0')}`
      : pack.seasons && pack.seasons.length > 1
        ? `S${String(pack.seasons[0]).padStart(2, '0')}-S${String(pack.seasons[pack.seasons.length - 1]).padStart(2, '0')}`
        : 'Pack';
    const episodeCount = `${pack.completedCount}/${pack.totalCount} episodes`;

    const progressClass = pack.status === 'complete' ? 'complete'
      : pack.status === 'paused' ? 'paused' : '';

    const statusLabel = pack.status === 'downloading'
      ? `${pack.progress}% \u00b7 ${episodeCount}`
      : pack.status === 'complete'
      ? `${episodeCount} \u00b7 ${totalSizeStr}`
      : pack.status === 'paused'
      ? `Paused at ${pack.progress}% \u00b7 ${episodeCount}`
      : pack.status === 'failed'
      ? `Failed \u00b7 ${episodeCount}`
      : `Queued \u00b7 ${episodeCount}`;

    // Restart button shared across all statuses
    const restartBtn = `
      <button class="download-action-btn resume" data-pack-id="${escapeHTML(pack.packId)}" data-action="restart-pack" title="Restart Download">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
      </button>`;

    // Actions apply to all episodes in the pack
    let actions = '';
    const firstEpId = pack.episodes[0]?.id || '';
    if (pack.status === 'downloading') {
      actions = `
        <button class="download-action-btn pause" data-pack-id="${escapeHTML(pack.packId)}" data-action="pause-pack" title="Pause All">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
        </button>
        ${restartBtn}
        <button class="download-action-btn cancel" data-pack-id="${escapeHTML(pack.packId)}" data-action="remove-pack" title="Cancel All">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>`;
    } else if (pack.status === 'paused') {
      actions = `
        <button class="download-action-btn resume" data-pack-id="${escapeHTML(pack.packId)}" data-action="resume-pack" title="Resume All">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
        ${restartBtn}
        <button class="download-action-btn cancel" data-pack-id="${escapeHTML(pack.packId)}" data-action="remove-pack" title="Remove All">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>`;
    } else if (pack.status === 'complete') {
      actions = `
        ${restartBtn}
        <button class="download-action-btn cancel" data-pack-id="${escapeHTML(pack.packId)}" data-action="remove-pack" title="Remove All">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>`;
    } else if (pack.status === 'failed') {
      actions = `
        <button class="download-action-btn resume" data-pack-id="${escapeHTML(pack.packId)}" data-action="retry-pack" title="Retry All">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
        ${restartBtn}
        <button class="download-action-btn cancel" data-pack-id="${escapeHTML(pack.packId)}" data-action="remove-pack" title="Remove All">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>`;
    } else if (pack.status === 'queued') {
      const firstEpIdQ = pack.episodes[0]?.id || '';
      const startBtn = hasSlots
        ? `<button class="download-action-btn resume" data-pack-id="${escapeHTML(pack.packId)}" data-id="${escapeHTML(firstEpIdQ)}" data-action="start-pack" title="Start Now">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </button>`
        : '';
      const upBtn = queueIdx > 0
        ? `<button class="queue-move-btn" data-pack-id="${escapeHTML(pack.packId)}" data-action="move-up-pack" title="Move up">\u25B2</button>`
        : '';
      const downBtn = queueIdx < queueLen - 1
        ? `<button class="queue-move-btn" data-pack-id="${escapeHTML(pack.packId)}" data-action="move-down-pack" title="Move down">\u25BC</button>`
        : '';
      actions = `
        ${startBtn}
        <div class="download-queue-controls">${upBtn}${downBtn}</div>
        <button class="download-action-btn cancel" data-pack-id="${escapeHTML(pack.packId)}" data-action="remove-pack" title="Remove All">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>`;
    }

    const showProgress = ['downloading', 'paused', 'queued'].includes(pack.status);
    const progressBar = showProgress
      ? `<div class="download-progress-bar"><div class="download-progress-fill ${progressClass}" style="width:${pack.progress || 0}%"></div></div>`
      : '';

    // Build collapsed episode list (hidden by default)
    const isMultiSeason = pack.seasons && pack.seasons.length > 1;
    let episodeListHtml = pack.episodes.map(ep => {
      const seasonPrefix = isMultiSeason && ep.season ? `S${String(ep.season).padStart(2, '0')}` : '';
      const epLabel = ep.episode != null
        ? `${seasonPrefix}E${String(ep.episode).padStart(2, '0')}`
        : seasonPrefix || '?';
      const epName = ep.name || ep.fileName || '';
      const epPct = ep.status === 'complete' ? '100%' : `${ep.progress || 0}%`;
      const epStatus = ep.status === 'complete' ? 'done' : ep.status === 'failed' ? 'fail' : '';
      return `<div class="pack-episode-row ${epStatus}"><span class="pack-ep-label">${escapeHTML(epLabel)}</span><span class="pack-ep-file">${escapeHTML(epName)}</span><span class="pack-ep-pct">${epPct}</span></div>`;
    }).join('');

    const queueIdxAttr = queueIdx != null ? ` data-queue-idx="${queueIdx}"` : '';
    return `
      <div class="download-item download-pack-item" data-pack-id="${escapeHTML(pack.packId)}"${queueIdxAttr}>
        ${poster}
        <div class="download-info">
          <div class="download-name">${escapeHTML(pack.name)} <span class="pack-season-tag">${seasonLabel}</span></div>
          <div class="download-meta">${escapeHTML(statusLabel)}${meta ? ' \u00b7 ' + escapeHTML(meta) : ''}</div>
          ${progressBar}
        </div>
        <div class="download-actions">
          <button class="download-action-btn pack-expand-btn" data-pack-id="${escapeHTML(pack.packId)}" title="Show episodes">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          ${actions}
        </div>
      </div>
      <div class="pack-episodes-detail collapsed" data-pack-detail="${escapeHTML(pack.packId)}">
        ${episodeListHtml}
      </div>`;
  }

  function downloadItemHTML(item, queueIdx, queueLen, hasSlots) {
    const poster = item.poster
      ? `<img class="download-poster" src="${escapeHTML(item.poster)}" alt="" loading="lazy">`
      : '<div class="download-poster"></div>';

    // Use formatSpeed/formatSize helpers so sub-MB/s transfers don't render as
    // "0.0 MB/s" and small files don't show "0.01 GB".
    const speed = item.downloadSpeed > 0 ? formatSpeed(item.downloadSpeed) : '';
    const peers = item.numPeers > 0 ? `${item.numPeers} peers` : '';
    const meta = [item.quality, speed, peers].filter(Boolean).join(' \u00b7 ');

    const sizeStr = item.fileSize > 0 ? formatSize(item.fileSize) : (item.size || '');

    const progressClass = item.status === 'complete' ? 'complete'
      : item.status === 'paused' ? 'paused' : '';

    let actions = '';
    if (item.status === 'downloading') {
      actions = `
        <button class="download-action-btn pause" data-id="${escapeHTML(item.id)}" data-action="pause" title="Pause">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
        </button>
        <button class="download-action-btn cancel" data-id="${escapeHTML(item.id)}" data-action="remove" title="Cancel">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>`;
    } else if (item.status === 'paused') {
      actions = `
        <button class="download-action-btn resume" data-id="${escapeHTML(item.id)}" data-action="resume" title="Resume">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
        <button class="download-action-btn cancel" data-id="${escapeHTML(item.id)}" data-action="remove" title="Remove">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>`;
    } else if (item.status === 'queued') {
      const startBtn = hasSlots
        ? `<button class="download-action-btn resume" data-id="${escapeHTML(item.id)}" data-action="start" title="Start Now">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </button>`
        : '';
      const upBtn = queueIdx > 0
        ? `<button class="queue-move-btn" data-id="${escapeHTML(item.id)}" data-action="move-up" title="Move up">\u25B2</button>`
        : '';
      const downBtn = queueIdx < queueLen - 1
        ? `<button class="queue-move-btn" data-id="${escapeHTML(item.id)}" data-action="move-down" title="Move down">\u25BC</button>`
        : '';
      actions = `
        ${startBtn}
        <div class="download-queue-controls">${upBtn}${downBtn}</div>
        <button class="download-action-btn cancel" data-id="${escapeHTML(item.id)}" data-action="remove" title="Remove">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>`;
    } else if (item.status === 'failed') {
      actions = `
        <button class="download-action-btn resume" data-id="${escapeHTML(item.id)}" data-action="retry" title="Retry">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
        <button class="download-action-btn cancel" data-id="${escapeHTML(item.id)}" data-action="remove" title="Remove">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>`;
    }

    const showProgress = ['downloading', 'paused', 'queued'].includes(item.status);
    const progressBar = showProgress
      ? `<div class="download-progress-bar"><div class="download-progress-fill ${progressClass}" style="width:${item.progress || 0}%"></div></div>`
      : '';

    const statusLabel = item.status === 'downloading'
      ? `${item.progress || 0}%` + (sizeStr ? ` of ${sizeStr}` : '')
      : item.status === 'paused'
      ? `Paused at ${item.progress || 0}%`
      : item.status === 'failed'
      ? (item.error || 'Failed')
      : item.status === 'complete'
      ? (sizeStr || 'Complete')
      : 'Queued';

    const queueIdxAttr = queueIdx != null ? ` data-queue-idx="${queueIdx}"` : '';
    return `
      <div class="download-item"${queueIdxAttr}>
        ${poster}
        <div class="download-info">
          <div class="download-name">${escapeHTML(item.name)}</div>
          <div class="download-meta">${escapeHTML(statusLabel)}${meta ? ' \u00b7 ' + escapeHTML(meta) : ''}</div>
          ${progressBar}
        </div>
        <div class="download-actions">${actions}</div>
      </div>`;
  }

  function attachDownloadListeners(panel) {
    panel.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const packId = btn.dataset.packId;
        const action = btn.dataset.action;

        if (action === 'remove-pack' && packId) {
          // Atomic server-side removal: stops the shared engine before deleting
          // files and avoids the race window where parallel DELETEs would leave
          // the engine writing to files we've just unlinked.
          try {
            const r = await fetch(`/api/library/pack/${encodeURIComponent(packId)}`, { method: 'DELETE' });
            if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Remove failed'); }
            showToast('Season pack removed');
          } catch (err) { showToast('Failed to remove pack: ' + err.message); }
          renderDownloads();
          return;
        }

        if (action === 'pause-pack' && packId) {
          try {
            const r = await fetch('/api/library/pause-pack', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ packId }),
            });
            if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Pause failed'); }
            showToast('Pack downloads paused');
          } catch (err) { showToast('Failed to pause pack: ' + err.message); }
          renderDownloads();
          return;
        }

        if (action === 'resume-pack' && packId) {
          try {
            const r = await fetch('/api/library/resume-pack', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ packId }),
            });
            if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Resume failed'); }
            showToast('Pack downloads resumed');
          } catch (err) { showToast('Failed to resume pack: ' + err.message); }
          renderDownloads();
          return;
        }

        if (action === 'retry-pack' && packId) {
          try {
            const r = await fetch('/api/library/retry-pack', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ packId }),
            });
            if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Retry failed'); }
            showToast('Retrying failed episodes...');
          } catch (err) { showToast('Failed to retry pack: ' + err.message); }
          renderDownloads();
          return;
        }

        if (action === 'restart-pack' && packId) {
          try {
            const resp = await fetch('/api/library/restart-pack', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ packId }),
            });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error || 'Restart failed');
            const count = (data.items || []).filter(i => i.status === 'started').length;
            showToast(`Pack restarted — ${count} episode${count !== 1 ? 's' : ''} downloading`);
          } catch (err) { showToast('Failed to restart pack: ' + err.message); }
          renderDownloads();
          return;
        }

        if (action === 'start' && id) {
          try {
            const r = await fetch(`/api/library/${encodeURIComponent(id)}/start`, { method: 'POST' });
            if (!r.ok) { const d = await r.json(); showToast(d.error || 'Cannot start'); }
          } catch { showToast('Failed to start'); }
          renderDownloads();
        } else if (action === 'start-pack' && packId) {
          try {
            const r = await fetch('/api/library/start-pack', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ packId }),
            });
            if (!r.ok) { const d = await r.json().catch(() => ({})); showToast(d.error || 'Cannot start pack'); }
          } catch { showToast('Failed to start pack'); }
          renderDownloads();
        } else if (action === 'pause') {
          try {
            await fetch(`/api/library/${encodeURIComponent(id)}/pause`, { method: 'POST' });
          } catch { showToast('Failed to pause'); }
          renderDownloads();
        } else if (action === 'resume') {
          try {
            await fetch(`/api/library/${encodeURIComponent(id)}/resume`, { method: 'POST' });
          } catch { showToast('Failed to resume'); }
          renderDownloads();
        } else if (action === 'retry') {
          try {
            await fetch(`/api/library/${encodeURIComponent(id)}/retry`, { method: 'POST' });
            showToast('Retrying download...');
          } catch { showToast('Failed to retry'); }
          renderDownloads();
        } else if (action === 'remove') {
          try {
            await fetch(`/api/library/${encodeURIComponent(id)}`, { method: 'DELETE' });
            showToast('Download removed');
          } catch { showToast('Failed to remove'); }
          renderDownloads();
        } else if (action === 'move-up' || action === 'move-down') {
          const row = btn.closest('.download-item');
          const currentIdx = parseInt(row?.dataset?.queueIdx || '0', 10);
          const newPos = action === 'move-up' ? Math.max(0, currentIdx - 1) : currentIdx + 1;
          await fetch(`/api/library/${encodeURIComponent(id)}/reorder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ position: newPos }),
          });
          renderDownloads();
        } else if (action === 'move-up-pack' || action === 'move-down-pack') {
          const row = btn.closest('.download-item');
          const currentIdx = parseInt(row?.dataset?.queueIdx || '0', 10);
          const newPos = action === 'move-up-pack' ? Math.max(0, currentIdx - 1) : currentIdx + 1;
          await fetch('/api/library/reorder-pack', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ packId, position: newPos }),
          });
          renderDownloads();
        }
      });
    });

    // Pack expand/collapse toggle
    panel.querySelectorAll('.pack-expand-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const packId = btn.dataset.packId;
        const detail = panel.querySelector(`[data-pack-detail="${CSS.escape(packId)}"]`);
        if (detail) {
          detail.classList.toggle('collapsed');
          btn.classList.toggle('expanded');
          // Track expanded state so it survives auto-refresh
          if (_expandedPacks.has(packId)) {
            _expandedPacks.delete(packId);
          } else {
            _expandedPacks.add(packId);
          }
        }
      });
    });
  }

  // ─── Source Stats ───────────────────────────────

  function renderSourceStats(items) {
    const panel = $('#source-stats');
    if (!panel) return;

    const total = items.length;
    const downloading = items.filter(i => i.status === 'downloading').length;
    const completed = items.filter(i => i.status === 'complete').length;
    const queued = items.filter(i => i.status === 'queued').length;
    const paused = items.filter(i => i.status === 'paused').length;
    const failed = items.filter(i => i.status === 'failed').length;
    const totalSizeBytes = items
      .filter(i => i.status === 'complete' && i.fileSize > 0)
      .reduce((sum, i) => sum + i.fileSize, 0);
    const totalSizeGB = (totalSizeBytes / 1e9).toFixed(1);

    panel.innerHTML = `
      <div class="source-stat-row">
        <span class="source-stat-label">Total Library Items</span>
        <span class="source-stat-value">${total}</span>
      </div>
      <div class="source-stat-row">
        <span class="source-stat-label">Active Downloads</span>
        <span class="source-stat-value">${downloading}</span>
      </div>
      <div class="source-stat-row">
        <span class="source-stat-label">Queued</span>
        <span class="source-stat-value">${queued}</span>
      </div>
      <div class="source-stat-row">
        <span class="source-stat-label">Paused</span>
        <span class="source-stat-value">${paused}</span>
      </div>
      <div class="source-stat-row">
        <span class="source-stat-label">Completed</span>
        <span class="source-stat-value">${completed}</span>
      </div>
      ${failed > 0 ? `<div class="source-stat-row">
        <span class="source-stat-label">Failed</span>
        <span class="source-stat-value" style="color:var(--danger)">${failed}</span>
      </div>` : ''}
      <div class="source-stat-row">
        <span class="source-stat-label">Library Size</span>
        <span class="source-stat-value">${totalSizeGB} GB</span>
      </div>
    `;
  }

  // ─── Source Diagnostics ─────────────────────────

  async function runDiagnostics() {
    const panel = $('#diagnostics-panel');
    const btn = $('#run-diagnostics-btn');
    if (!panel || !btn) return;

    btn.disabled = true;
    btn.textContent = 'Testing...';

    // Show testing state
    const providers = ['Torrentio', 'The Pirate Bay', 'YTS', 'EZTV', '1337x'];
    panel.innerHTML = providers.map(name => `
      <div class="diag-item">
        <div class="diag-indicator testing"></div>
        <div class="diag-info">
          <div class="diag-name">${name}</div>
          <div class="diag-detail">Testing...</div>
        </div>
      </div>
    `).join('');

    try {
      const resp = await fetch('/api/streams/diagnose', { signal: AbortSignal.timeout(30000) });
      if (!resp.ok) throw new Error('Diagnostics failed');
      const results = await resp.json();

      const providerMap = {
        torrentio: 'Torrentio',
        tpb: 'The Pirate Bay',
        yts: 'YTS',
        eztv: 'EZTV',
        '1337x': '1337x',
      };

      const summary = results._summary || {};
      const summaryClass = summary.allDown ? 'all-fail'
        : summary.working?.length === summary.total ? 'all-ok' : 'some-fail';
      const summaryText = summary.allDown ? 'All sources unreachable'
        : summary.working?.length === summary.total ? 'All sources operational'
        : `${summary.working?.length || 0} of ${summary.total || 0} sources working`;

      let html = `<div class="diag-summary ${summaryClass}">${summaryText}</div>`;

      for (const [key, label] of Object.entries(providerMap)) {
        const r = results[key];
        if (!r) continue;

        const httpInfo = results[key + '_http'];

        // Determine indicator: green (results), amber (reachable no results), red (unreachable)
        let indicator, detail;
        if (r.ok && r.count > 0) {
          indicator = 'ok';
          detail = `${r.count} results returned`;
        } else if (r.ok && r.count === 0) {
          // Reachable but no results — check HTTP info for why
          indicator = 'warn';
          if (httpInfo && httpInfo.cloudflare) {
            detail = 'Blocked by Cloudflare challenge';
          } else if (httpInfo && httpInfo.htmlResponse) {
            detail = 'Received HTML instead of JSON (possible block/redirect)';
          } else if (httpInfo && !httpInfo.ok) {
            detail = `HTTP ${httpInfo.status || 'error'} — endpoint returned error`;
          } else {
            detail = 'Reachable but returned no results';
          }
        } else {
          indicator = 'fail';
          if (httpInfo && httpInfo.cloudflare) {
            detail = 'Blocked by Cloudflare';
          } else {
            detail = r.error || 'Unreachable';
          }
        }

        const latency = r.ms ? `${r.ms}ms` : '';
        const httpLatency = httpInfo?.ms ? `${httpInfo.ms}ms` : '';
        let configNote = '';
        if (key === 'torrentio' && results._torrentioMirror) {
          configNote = ` (via ${escapeHTML(results._torrentioMirror.replace('https://', ''))})`;
        } else if (key === 'eztv' && results._eztvMirror) {
          configNote = ` (via ${escapeHTML(results._eztvMirror)})`;
        }

        // HTTP connectivity sub-detail
        let httpDetail = '';
        if (httpInfo) {
          const httpStatus = httpInfo.ok ? `HTTP ${httpInfo.status || 200}` : `HTTP ${httpInfo.status || 'fail'}`;
          const flags = [];
          if (httpInfo.cloudflare) flags.push('Cloudflare');
          if (httpInfo.htmlResponse) flags.push('HTML response');
          if (httpInfo.error) flags.push(httpInfo.error);
          httpDetail = `Connectivity: ${httpStatus}${flags.length ? ' — ' + flags.join(', ') : ''} (${httpLatency})`;
        }

        html += `
          <div class="diag-item">
            <div class="diag-indicator ${indicator}"></div>
            <div class="diag-info">
              <div class="diag-name">${label}${configNote}</div>
              <div class="diag-detail">${escapeHTML(detail)}</div>
              ${httpDetail ? `<div class="diag-detail" style="opacity:0.6;margin-top:2px">${escapeHTML(httpDetail)}</div>` : ''}
            </div>
            <div class="diag-stats">
              ${latency ? `<div class="diag-latency">${latency}</div>` : ''}
              ${r.count > 0 ? `<div class="diag-count">${r.count} results</div>` : ''}
            </div>
          </div>`;
      }

      panel.innerHTML = html;
    } catch (e) {
      panel.innerHTML = `<div class="diagnostics-empty"><span class="setting-hint" style="color:var(--danger)">Diagnostics failed: ${escapeHTML(e.message)}</span></div>`;
    }

    btn.disabled = false;
    btn.textContent = 'Run Diagnostics';
  }

  function renderAddonList() {
    const addons = api.getAddons();
    if (addons.length === 0) {
      dom.addonList.innerHTML = '<p class="setting-hint">No addons configured</p>';
      return;
    }

    dom.addonList.innerHTML = addons.map(a => `
      <div class="addon-item">
        <div>
          <div class="addon-item-name">${escapeHTML(a.name)}</div>
          <div class="addon-item-url">${escapeHTML(a.url)}</div>
        </div>
        <button class="addon-remove" data-url="${escapeHTML(a.url)}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>
    `).join('');

    dom.addonList.querySelectorAll('.addon-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        api.removeAddon(btn.dataset.url);
        renderAddonList();
        showToast('Addon removed');
      });
    });
  }

  function renderLiveTVSources() {
    const container = document.getElementById('livetv-source-list');
    if (!container) return;

    const sources = api.getLiveTVSources();
    if (sources.length === 0) {
      container.innerHTML = '<p class="setting-hint">No live TV sources configured</p>';
      return;
    }

    container.innerHTML = sources.map(s => {
      const icon = s.type === 'playlist' ? 'M3U' : 'TV';
      const typeLabel = s.type === 'playlist' ? 'M3U Playlist' : 'Stremio TV Addon';
      const enabled = s.enabled !== false;
      return `
        <div class="source-item${enabled ? '' : ' source-item--disabled'}">
          <div class="source-icon">${icon}</div>
          <div class="source-info">
            <div class="source-name">${escapeHTML(s.name || s.url)}</div>
            <div class="source-desc">${typeLabel}</div>
          </div>
          <label class="livetv-source-toggle" title="${enabled ? 'Disable' : 'Enable'}">
            <input type="checkbox" class="livetv-source-toggle-input" data-url="${escapeHTML(s.url)}" ${enabled ? 'checked' : ''}>
            <span class="livetv-source-toggle-slider"></span>
          </label>
          <button class="livetv-source-remove" data-url="${escapeHTML(s.url)}" title="Remove">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.livetv-source-toggle-input').forEach(toggle => {
      toggle.addEventListener('change', () => {
        api.toggleLiveTVSource(toggle.dataset.url, toggle.checked);
        renderLiveTVSources();
        showToast(toggle.checked ? 'Source enabled' : 'Source disabled');
      });
    });

    container.querySelectorAll('.livetv-source-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        api.removeLiveTVSource(btn.dataset.url);
        renderLiveTVSources();
        showToast('Source removed');
      });
    });
  }

  // ─── Toast ───────────────────────────────────────

  function showToast(message) {
    let toast = document.querySelector('.toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
  }

  // ─── Theme ───────────────────────────────────────

  function applyTheme() {
    const app = document.getElementById('app');
    app.classList.add('theme-custom');
  }

  // ─── Utility ─────────────────────────────────────

  const _escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, ch => _escapeMap[ch]);
  }

  // ─── Casting ─────────────────────────────────────
  //
  // Strategy for Tailscale + local casting:
  //   1. Phone discovers devices on its OWN WiFi via browser Remote Playback API
  //      (AirPlay / Chromecast). Tailscale runs alongside WiFi so local network
  //      traffic stays on WiFi while Jetson traffic goes through the Tailscale tunnel.
  //   2. For AirPlay: the phone streams from Tailscale and relays to the AirPlay device
  //      on the local network — this works natively.
  //   3. For Chromecast: the browser handles proxying the media data.
  //   4. Server-side casting (Jetson → LAN devices) available as fallback.

  const castState = { available: false, active: false, serverCast: null };

  function initCasting() {
    const video = dom.videoPlayer;

    // Remote Playback API — discovers devices on the PHONE's local WiFi
    // Works with AirPlay (Safari) and Chromecast (Chrome/Edge)
    if (video.remote) {
      video.disableRemotePlayback = false;
      dom.castBtn.classList.remove('hidden');

      video.remote.addEventListener('connecting', () => {
        dom.castBtn.classList.add('casting');
        dom.castDeviceName.textContent = 'Connecting to device...';
        dom.castOverlay.classList.remove('hidden');
      });

      video.remote.addEventListener('connect', () => {
        castState.active = true;
        dom.castBtn.classList.add('casting');
        dom.castDeviceName.textContent = 'Casting to device';
        dom.castOverlay.classList.remove('hidden');
        showToast('Connected — casting to device');
      });

      video.remote.addEventListener('disconnect', () => {
        castState.active = false;
        dom.castBtn.classList.remove('casting');
        dom.castOverlay.classList.add('hidden');
        showToast('Casting stopped');
      });
    } else {
      // No Remote Playback API — still show button for server-side fallback
      dom.castBtn.classList.remove('hidden');
    }

    // Cast button: show picker with phone-discovered + server-discovered devices
    dom.castBtn.addEventListener('click', () => showCastPicker());

    // Stop casting button
    dom.castStopBtn.addEventListener('click', async () => {
      if (castState.serverCast) {
        try {
          await fetch('/api/cast/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId: castState.serverCast.deviceId }),
          });
        } catch {}
        castState.serverCast = null;
        castState.active = false;
        dom.castBtn.classList.remove('casting');
        dom.castOverlay.classList.add('hidden');
        if (castState._pollInterval) {
          clearInterval(castState._pollInterval);
          castState._pollInterval = null;
        }
        showToast('Casting stopped');
        return;
      }

      // Browser Remote Playback
      try {
        dom.videoPlayer.pause();
        if (dom.videoPlayer.remote && dom.videoPlayer.remote.state === 'connected') {
          dom.videoPlayer.remote.prompt();
        }
      } catch {
        castState.active = false;
        dom.castBtn.classList.remove('casting');
        dom.castOverlay.classList.add('hidden');
      }
    });
  }

  /**
   * Show cast device picker.
   * Primary: browser's native device picker (phone's WiFi network).
   * Fallback: server-side discovery (Jetson's LAN — for when phone and Jetson
   * share the same network, or as a backup).
   */
  async function showCastPicker() {
    const picker = dom.castDevicePicker;
    const list = dom.castDeviceList;
    if (!picker || !list) return;

    picker.classList.remove('hidden');

    // Build the picker content
    let html = '';

    // ── Section 1: Phone's local devices (via browser) ──
    if (dom.videoPlayer.remote) {
      html += `
        <div class="cast-section-label">Your devices (phone WiFi)</div>
        <button class="cast-device-item" id="cast-browser-prompt-btn">
          <div class="cast-device-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M2 16.1A5 5 0 015.9 20M2 12.05A9 9 0 019.95 20M2 8V6a2 2 0 012-2h16a2 2 0 012 2v12a2 2 0 01-2 2h-6"/>
              <circle cx="2" cy="20" r="1" fill="currentColor"/>
            </svg>
          </div>
          <div class="cast-device-info">
            <div class="cast-device-name">Choose AirPlay or Chromecast</div>
            <div class="cast-device-type">Discovers devices on your phone's WiFi network</div>
          </div>
          <svg class="cast-device-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
        </button>
        <div class="cast-split-hint" id="cast-split-hint">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
          <span>Not seeing devices? Tailscale runs alongside your WiFi so local casting should work automatically.
          If not, check that your WiFi is connected and Tailscale is active.</span>
        </div>
      `;
    }

    // ── Section 2: Server-side devices (Jetson's network) ──
    html += `
      <div class="cast-section-label" style="margin-top:12px">Server's network devices</div>
      <div id="cast-server-devices">
        <div class="cast-loading"><div class="spinner" style="width:20px;height:20px;border-width:2px"></div><span>Scanning Jetson's LAN...</span></div>
      </div>
    `;

    list.innerHTML = html;

    // Wire up browser prompt button
    document.getElementById('cast-browser-prompt-btn')?.addEventListener('click', async () => {
      picker.classList.add('hidden');
      try {
        await dom.videoPlayer.remote.prompt();
      } catch (e) {
        if (e.name === 'NotFoundError') {
          showToast('No cast devices found — check your WiFi and Tailscale connection');
        } else if (e.name !== 'NotAllowedError') {
          showToast('Cast not available');
        }
      }
    });

    // Fetch server-side devices in background
    const serverList = document.getElementById('cast-server-devices');
    try {
      const res = await fetch('/api/cast/devices?refresh=1');
      const data = await res.json();

      if (!data.devices || data.devices.length === 0) {
        serverList.innerHTML = `
          <div class="cast-empty-inline">No devices found on the server's network</div>
        `;
      } else {
        serverList.innerHTML = data.devices.map(device => `
          <button class="cast-device-item" data-device='${escapeHTML(JSON.stringify(device))}'>
            <div class="cast-device-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                ${device.type === 'chromecast'
                  ? '<path d="M2 16.1A5 5 0 015.9 20M2 12.05A9 9 0 019.95 20M2 8V6a2 2 0 012-2h16a2 2 0 012 2v12a2 2 0 01-2 2h-6"/><circle cx="2" cy="20" r="1" fill="currentColor"/>'
                  : '<rect x="2" y="7" width="20" height="15" rx="2" ry="2"/><polyline points="17 2 12 7 7 2"/>'}
              </svg>
            </div>
            <div class="cast-device-info">
              <div class="cast-device-name">${escapeHTML(device.friendlyName)}</div>
              <div class="cast-device-type">${device.type === 'chromecast' ? 'Google Cast' : 'DLNA'} · ${escapeHTML(device.host)}</div>
            </div>
          </button>
        `).join('');

        serverList.querySelectorAll('.cast-device-item[data-device]').forEach(btn => {
          btn.addEventListener('click', () => {
            const device = JSON.parse(btn.dataset.device);
            picker.classList.add('hidden');
            castToServerDevice(device);
          });
        });
      }
    } catch {
      serverList.innerHTML = `<div class="cast-empty-inline">Could not reach server for device scan</div>`;
    }

    // Close picker on background click
    function closePicker(e) {
      if (e.target === picker) {
        picker.classList.add('hidden');
        picker.removeEventListener('click', closePicker);
      }
    }
    picker.addEventListener('click', closePicker);
  }

  /**
   * Cast current stream to a server-discovered device (Jetson → LAN device)
   */
  async function castToServerDevice(device) {
    const videoSrc = dom.videoPlayer.src;
    let streamPath = '';
    if (videoSrc) {
      try {
        const url = new URL(videoSrc);
        streamPath = url.pathname + url.search;
      } catch {
        streamPath = videoSrc;
      }
    }

    if (!streamPath || streamPath === '/') {
      showToast('No stream playing — start a video first, then cast');
      return;
    }

    const title = state.currentMeta?.name || 'Albatross';
    showToast(`Casting to ${device.friendlyName}...`);

    try {
      const res = await fetch('/api/cast/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device, streamPath, title, mimeType: 'video/mp4' }),
      });
      const data = await res.json();
      if (!res.ok) { showToast(data.error || 'Cast failed'); return; }

      castState.active = true;
      castState.serverCast = { deviceId: device.id, deviceName: device.friendlyName };
      dom.castBtn.classList.add('casting');
      dom.castDeviceName.textContent = `Casting to ${device.friendlyName}`;
      dom.castOverlay.classList.remove('hidden');
      dom.videoPlayer.pause();
      showToast(`Now casting to ${device.friendlyName}`);

      // Poll status
      castState._pollInterval = setInterval(async () => {
        try {
          const sRes = await fetch(`/api/cast/status/${encodeURIComponent(device.id)}`);
          if (!sRes.ok) {
            clearInterval(castState._pollInterval);
            castState._pollInterval = null;
            castState.serverCast = null;
            castState.active = false;
            dom.castBtn.classList.remove('casting');
            dom.castOverlay.classList.add('hidden');
            return;
          }
          const status = await sRes.json();
          if (status.status === 'stopped' || status.status === 'finished') {
            clearInterval(castState._pollInterval);
            castState._pollInterval = null;
            castState.serverCast = null;
            castState.active = false;
            dom.castBtn.classList.remove('casting');
            dom.castOverlay.classList.add('hidden');
            showToast('Casting ended');
          } else if (status.position && status.duration) {
            dom.castDeviceName.textContent =
              `Casting to ${device.friendlyName} · ${status.position} / ${status.duration}`;
          }
        } catch {}
      }, 5000);
    } catch (err) {
      showToast(`Cast error: ${err.message}`);
    }
  }

  // ─── Init ────────────────────────────────────────

  // Keep the Library nav badge fresh with the review-queue count.
  function updateLibraryBadge(count) {
    const el = document.getElementById('nav-library-badge');
    if (!el) return;
    if (count > 0) {
      el.textContent = count > 99 ? '99+' : String(count);
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }
  async function refreshLibraryBadge() {
    try {
      const r = await fetch('/api/library/review-queue');
      if (!r.ok) return;
      const data = await r.json();
      updateLibraryBadge(data.count || 0);
    } catch { /* silent — badge is best-effort */ }
  }

  function init() {
    // Kick off an initial badge refresh on app load so the count shows even
    // when the user hasn't visited the library tab yet.
    refreshLibraryBadge();

    // Bottom nav
    dom.navBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        state.viewHistory = [];
        clearActiveFilter();
        dom.searchInput.value = '';
        dom.searchClear.classList.add('hidden');
        if (view === 'movies') {
          navigateTo('movies');
          loadHome('movie');
        } else if (view === 'series') {
          navigateTo('series');
          loadHome('series');
        } else if (view === 'library') {
          navigateTo('library');
          loadLibrary();
        } else if (view === 'share') {
          navigateTo('share');
        } else {
          navigateTo('home');
          loadHome();
        }
      });
    });

    // Back button
    dom.backBtn.addEventListener('click', goBack);

    // Manual torrent import button
    const manualImportBtn = document.getElementById('manual-import-btn');
    if (manualImportBtn) {
      manualImportBtn.addEventListener('click', showManualImportModal);
    }

    // Library toolbar: Auto-match (only unmatched/needsReview) + Re-match
    // (force: everything, including already-linked). Both call the same
    // endpoint with a different body.
    const autoMatchBtn = document.getElementById('library-automatch-btn');
    const reMatchBtn  = document.getElementById('library-rematch-btn');
    async function runAutoMatch(force) {
      const btn = force ? reMatchBtn : autoMatchBtn;
      if (!btn || btn.disabled) return;
      const label = btn.querySelector('.library-automatch-label');
      const origLabel = label ? label.textContent : null;
      btn.disabled = true;
      if (label) label.textContent = 'Matching…';
      // Loop through pages so libraries larger than the per-request cap
      // (100 items) are fully processed. Without this, "total recheck"
      // would only re-run against the first 100 items in the library.
      const totals = { matched: 0, needsReview: 0, skipped: 0, errors: 0, processed: 0 };
      let offset = 0;
      const MAX_PAGES = 50;
      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          const resp = await fetch('/api/library/auto-match-all', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ force: !!force, offset }),
          });
          if (resp.status === 503) {
            showToast('TMDB key not configured on server');
            return;
          }
          if (!resp.ok) throw new Error('Auto-match failed');
          const data = await resp.json();
          totals.matched     += data.matched     || 0;
          totals.needsReview += data.needsReview || 0;
          totals.skipped     += data.skipped     || 0;
          totals.errors      += data.errors      || 0;
          totals.processed   += data.processed   || 0;

          if (label && data.total) {
            label.textContent = `Matching ${Math.min(data.nextOffset, data.total)}/${data.total}…`;
          }

          // Advance. Stop when the server says nothing is left, or when it
          // failed to advance (defensive: prevents an infinite loop if the
          // response is missing pagination fields).
          if (!data.remaining || data.remaining <= 0) break;
          if (typeof data.nextOffset !== 'number' || data.nextOffset <= offset) break;
          offset = data.nextOffset;
        }
        showToast(`Matched ${totals.matched} · ${totals.needsReview} need review`);
        refreshLibraryBadge();
        // Only reload library view if user is currently on it
        const libView = document.getElementById('view-library');
        if (libView && !libView.classList.contains('hidden')) {
          loadLibrary();
        }
      } catch (err) {
        showToast('Auto-match failed');
      } finally {
        btn.disabled = false;
        if (label && origLabel) label.textContent = origLabel;
      }
    }
    if (autoMatchBtn) autoMatchBtn.addEventListener('click', () => runAutoMatch(false));
    if (reMatchBtn)   reMatchBtn.addEventListener('click', () => {
      if (confirm('Re-match every item against TMDB?\nThis overwrites auto-matched links (manual matches are preserved).')) {
        runAutoMatch(true);
      }
    });

    // Player back button — navigate back (goBack handles video cleanup after hiding view)
    dom.playerBackBtn.addEventListener('click', () => {
      goBack();
    });

    // Video stall/buffering detection — re-show overlay during mid-playback stalls
    // Only activate after the video has played at least once (playerStarted) to avoid
    // clobbering the detailed loading overlay during initial torrent buffering.
    //
    // Why this is event-gated rather than purely event-driven:
    //   - 'waiting' and 'stalled' can fire spuriously. The browser emits
    //     'stalled' any time it hasn't received bytes for 3s; that can
    //     happen during perfectly healthy playback when the client has
    //     enough buffered data to keep going and the server goes quiet.
    //   - 'playing' alone doesn't reliably dismiss the overlay, because
    //     it only fires on a paused→playing transition, not on each
    //     decoded frame. If 'stalled' fires mid-playback the overlay
    //     would stay pinned forever even though currentTime keeps
    //     advancing.
    //
    // Solution: track currentTime on every timeupdate. If the clock
    // moved since the last stall/waiting event, the video is healthy
    // and the overlay should go away. We also dismiss on canplay /
    // canplaythrough which fire once the buffer is comfortable again.
    let _lastVideoTime = 0;
    let _stallOverlayShown = false;
    const hideStallOverlay = () => {
      if (!_stallOverlayShown) return;
      _stallOverlayShown = false;
      dom.playerOverlay.classList.add('hidden');
    };
    const showStallOverlay = (message) => {
      if (state.currentView !== 'player' || !state.playerStarted || !dom.videoPlayer.src) return;
      // Don't show the overlay if the stream is actually advancing; the
      // 'stalled' event is unreliable enough that we verify with the
      // clock before committing to a user-visible message.
      if (dom.videoPlayer.readyState >= 3 && !dom.videoPlayer.paused) return;
      _stallOverlayShown = true;
      dom.playerOverlay.classList.remove('hidden');
      dom.playerOverlay.innerHTML = `
        <div class="spinner"></div>
        <p>${message}</p>
      `;
    };
    dom.videoPlayer.addEventListener('waiting', () => {
      showStallOverlay('Buffering...');
    });
    dom.videoPlayer.addEventListener('stalled', () => {
      showStallOverlay('Stream stalled — waiting for data...');
    });
    dom.videoPlayer.addEventListener('playing', () => {
      state.playerStarted = true;
      hideStallOverlay();
    });
    dom.videoPlayer.addEventListener('canplay', hideStallOverlay);
    dom.videoPlayer.addEventListener('canplaythrough', hideStallOverlay);
    dom.videoPlayer.addEventListener('timeupdate', () => {
      // currentTime advanced since the last tick → the video is
      // playing back fine, any earlier stall/waiting event was a blip.
      if (dom.videoPlayer.currentTime > _lastVideoTime) {
        _lastVideoTime = dom.videoPlayer.currentTime;
        hideStallOverlay();
      }
    });
    dom.videoPlayer.addEventListener('seeking', () => {
      _lastVideoTime = dom.videoPlayer.currentTime;
    });
    dom.videoPlayer.addEventListener('emptied', () => {
      _lastVideoTime = 0;
      _stallOverlayShown = false;
    });

    // Auto-fade player controls on touch/mouse inactivity
    const playerContainer = document.getElementById('player-container');
    if (playerContainer) {
      ['touchstart', 'touchmove', 'mousemove', 'click'].forEach(evt => {
        playerContainer.addEventListener(evt, () => {
          if (state.currentView === 'player') showPlayerControls();
        }, { passive: true });
      });
    }

    // Keyboard controls for video player
    document.addEventListener('keydown', (e) => {
      if (state.currentView !== 'player') return;
      const v = dom.videoPlayer;
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault();
          v.paused ? v.play() : v.pause();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          v.currentTime = Math.max(0, v.currentTime - 10);
          break;
        case 'ArrowRight':
          e.preventDefault();
          v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 10);
          break;
        case 'ArrowUp':
          e.preventDefault();
          v.volume = Math.min(1, v.volume + 0.1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          v.volume = Math.max(0, v.volume - 0.1);
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          if (document.fullscreenElement) {
            document.exitFullscreen();
          } else if (v.requestFullscreen) {
            v.requestFullscreen();
          } else if (v.webkitEnterFullscreen) {
            v.webkitEnterFullscreen();
          }
          break;
        case 'm':
        case 'M':
          e.preventDefault();
          v.muted = !v.muted;
          break;
        case 'Escape':
          goBack();
          break;
      }
    });

    // Search
    initSearch();

    // Filters
    initFilters();

    // Settings
    initSettings();

    // Casting (Chromecast / AirPlay)
    initCasting();

    // Apply theme based on current mode
    applyTheme();

    // Initial load
    navigateTo('home');
    loadHome().catch(err => console.error('[Init] loadHome failed:', err));

    // VPN check
    checkVPNStatus()
      .then(result => { if (!result.connected) showVPNWarning(); })
      .catch(() => showVPNWarning());

    // Staggered card reveal — IntersectionObserver for catalog rows
    const rowObserver = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          e.target.classList.add('visible');
          rowObserver.unobserve(e.target);
        }
      });
    }, { threshold: 0.1 });

    // Observe catalog rows as they get added to the DOM
    const catalogObserver = new MutationObserver((mutations) => {
      mutations.forEach(m => {
        m.addedNodes.forEach(node => {
          if (node.nodeType === 1 && node.classList.contains('catalog-row')) {
            rowObserver.observe(node);
          }
        });
      });
    });
    catalogObserver.observe(dom.homeCatalogs, { childList: true });

    // Button ripple effect
    document.getElementById('app').addEventListener('click', (e) => {
      const target = e.target.closest('.btn-sm, .nav-btn, .filter-chip, .btn-block');
      if (!target) return;
      target.style.position = target.style.position || 'relative';
      target.style.overflow = 'hidden';
      const rect = target.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height) * 2;
      const ripple = document.createElement('span');
      ripple.className = 'ripple';
      ripple.style.width = ripple.style.height = size + 'px';
      ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
      ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
      target.appendChild(ripple);
      ripple.addEventListener('animationend', () => ripple.remove());
    });

    // Parallax hero on detail view scroll
    const contentEl = document.getElementById('content');
    contentEl.addEventListener('scroll', () => {
      if (state.currentView !== 'detail') return;
      const heroImg = document.querySelector('.detail-hero img');
      if (!heroImg) return;
      requestAnimationFrame(() => {
        const scrollTop = contentEl.scrollTop;
        heroImg.style.transform = `scale(${1 + scrollTop * 0.0003}) translateY(${scrollTop * 0.3}px)`;
      });
    });

    // Expose for inline handlers
    window.app = { goBack };
  }

  // Start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
