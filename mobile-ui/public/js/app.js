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

  let _streamLoadGeneration = 0; // incremented each loadStreams call to detect stale async completions

  // ─── State ───────────────────────────────────────

  const state = {
    currentView: 'home',
    viewHistory: [],
    currentType: null,    // 'movie' or 'series'
    currentMeta: null,
    currentSeason: 1,
    searchTimeout: null,
    vpnVerified: false,
    activeFilter: '',     // currently selected filter chip value
    playerStarted: false, // true after first 'playing' event, prevents overlay clobber during initial load
  };

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

    const target = $(('#' + (VIEW_MAP[view] || 'view-home')));
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
      dom.videoPlayer.pause();
      dom.videoPlayer.src = '';
      dom.videoPlayer.load(); // release previous resource from memory
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

    return `
      <div class="card" data-type="${type}" data-id="${id}">
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
        openDetail(card.dataset.type, card.dataset.id);
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
    const typeLabel = group.type === 'collection' ? 'movies' : 'titles';

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
      attachChannelListeners(grid);
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

  async function openDetail(type, id) {
    navigateTo('detail', { title: 'Loading...' });
    preload.cancel(); // invalidate any preload from a previously viewed title
    if (api._speedTestController) api._speedTestController.abort(); // cancel stale speed tests
    ++_streamLoadGeneration; // invalidate any in-flight loadStreams from a previous title
    _autoSelectedStream = null;

    dom.detailContent.innerHTML = `
      <div class="loading-state"><div class="spinner"></div><p>Loading details...</p></div>
    `;

    // For movies with IMDB IDs, start fetching streams in parallel with metadata
    let streamsPromise = (type === 'movie' && !id.startsWith('tmdb:')) ? api.getStreams(type, id) : null;

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
        streamsPromise = api.getStreams(type, id);
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
        // Re-attach episode click handlers
        attachEpisodeHandlers();
        // Hide stream container
        const sc = document.getElementById('stream-container');
        if (sc) sc.classList.add('hidden');
      });
    });

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

  function attachEpisodeHandlers() {
    document.querySelectorAll('.episode-item').forEach(ep => {
      ep.addEventListener('click', () => {
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
    });
  }

  // ─── Stream Loading with Speed Testing ───────────

  async function loadStreams(type, id, seasonEpisode, prefetchedStreamsPromise) {
    const generation = ++_streamLoadGeneration;

    const container = document.getElementById('stream-container');
    if (!container) return;

    // Use pre-fetched streams if available (from parallel fetch in openDetail)
    const streams = prefetchedStreamsPromise
      ? await prefetchedStreamsPromise
      : await api.getStreams(type, id, seasonEpisode);

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
                resultsDiv.innerHTML = `<div style="color:var(--accent-red)">Diagnostics failed: ${e.message}</div>`;
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
      }, 1600);
    } else {
      dom.playerOverlay.classList.add('hidden');
      enterPlayerFullscreen();
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

  async function playStream(stream) {
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
      await dom.videoPlayer.play();
      openCurtains();

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
      dom.videoPlayer.addEventListener('waiting', onStalled);
      dom.videoPlayer.addEventListener('stalled', onStalled);
      dom.videoPlayer.addEventListener('playing', onPlaying);
    } catch (e) {
      if (statusInterval) clearInterval(statusInterval);
      let hint = escapeHTML(e.message);
      if (e.message.includes('Media error') || e.message.includes('no supported source')) {
        hint += '<br><span style="font-size:12px">The file format may not be supported by your browser</span>';
      }
      showPlayerError('Playback failed', hint);
    }
  }

  async function playFromDetail() {
    if (!state.currentMeta) return;
    const type = state.currentType;
    const id = state.currentMeta.imdb_id || state.currentMeta.id;

    showToast('Finding best stream...');

    const { bestStream } = await api.getStreamsRanked(type, id);
    if (bestStream) {
      playStream(bestStream);
    } else {
      showToast('No playable streams found');
    }
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
      const libResp = await fetch('/api/library').then(r => { if (!r.ok) throw new Error(`Library API ${r.status}`); return r.json(); }).catch(e => { console.error('[Library] fetch failed:', e); return { items: [] }; });

      const libraryItems = libResp.items || [];
      console.log(`[Library] ${libraryItems.length} library items`);

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

      // Group shows by name (imdbId or name), then by season
      const showGroups = new Map();
      for (const ep of shows) {
        const showKey = ep.imdbId || ep.name || 'Unknown Show';
        if (!showGroups.has(showKey)) {
          showGroups.set(showKey, { name: ep.name, poster: ep.poster, year: ep.year, seasons: new Map() });
        }
        const group = showGroups.get(showKey);
        // Use the best poster/name available
        if (!group.poster && ep.poster) group.poster = ep.poster;
        const seasonNum = ep.season || 1;
        if (!group.seasons.has(seasonNum)) {
          group.seasons.set(seasonNum, []);
        }
        group.seasons.get(seasonNum).push(ep);
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
            _libraryGroupData[colId] = { name: col.name, poster: col.poster || colMovies[0].poster, movies: colMovies };
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
          _libraryGroupData[genreId] = { name: genre, poster: genreMovies[0].poster, movies: genreMovies };
          html += libraryGroupTileHTML({ id: genreId, name: genre, poster: genreMovies[0].poster, count: genreMovies.length, type: 'genre' });
        }

        // Render remaining movies that have no genre or are alone in their genre
        if (noGenreMovies.length > 0) {
          noGenreMovies.sort((a, b) => {
            const yearA = (metaMap[a.imdbId]?.year || a.year || '9999');
            const yearB = (metaMap[b.imdbId]?.year || b.year || '9999');
            return yearA.localeCompare(yearB);
          });
          html += noGenreMovies.map(item => renderLibraryItem(item)).join('');
        }
      }

      // TV Shows section (collapsible show headers with nested collapsible seasons)
      if (showGroups.size > 0) {
        html += `<div class="library-section-header">TV Shows</div>`;
        let showIndex = 0;
        for (const [, group] of showGroups) {
          const totalEpisodes = [...group.seasons.values()].reduce((sum, eps) => sum + eps.length, 0);
          const showId = 'show_' + showIndex++;
          html += `<div class="library-collection-group">`;
          html += `<div class="library-collection-header collapsed" data-collection-id="${escapeHTML(showId)}">${escapeHTML(group.name)}${group.year ? ' (' + escapeHTML(group.year) + ')' : ''} — ${totalEpisodes} episode${totalEpisodes !== 1 ? 's' : ''}</div>`;
          html += `<div class="library-collection-movies collapsed" data-collection-id="${escapeHTML(showId)}">`;
          const sortedSeasons = [...group.seasons.keys()].sort((a, b) => a - b);
          for (const seasonNum of sortedSeasons) {
            const episodes = group.seasons.get(seasonNum);
            const seasonId = showId + '_s' + seasonNum;
            html += `<div class="library-collection-group" style="grid-column:1/-1">`;
            html += `<div class="library-collection-header collapsed" data-collection-id="${escapeHTML(seasonId)}" style="padding-left:12px;font-size:13px">Season ${seasonNum} (${episodes.length})</div>`;
            html += `<div class="library-collection-movies collapsed" data-collection-id="${escapeHTML(seasonId)}">`;
            html += episodes.map(ep => renderLibraryItem(ep)).join('');
            html += `</div></div>`;
          }
          html += `</div></div>`;
        }
      }

      dom.libraryContent.innerHTML = html;

      // Attach collapse/expand handlers for TV Show headers only
      dom.libraryContent.querySelectorAll('.library-collection-header').forEach(header => {
        header.addEventListener('click', () => {
          const colId = header.dataset.collectionId;
          const moviesDiv = dom.libraryContent.querySelector(`.library-collection-movies[data-collection-id="${CSS.escape(colId)}"]`);
          if (moviesDiv) {
            header.classList.toggle('collapsed');
            moviesDiv.classList.toggle('collapsed');
          }
        });
      });

      // Attach click handlers for movie collection/genre tiles
      attachLibraryGroupTileListeners(dom.libraryContent, _libraryGroupData);

      attachLibraryHandlers();

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
      overlayHtml = `<div class="library-card-overlay failed">${escapeHTML(item.error || 'Failed')}</div>`;
      metaHtml = `<div class="library-card-meta failed">Failed</div>`;
    }

    return `
      <div class="card" data-id="${escapeHTML(item.id)}" data-status="${item.status}">
        <div class="card-poster">
          ${poster ? `<img src="${poster}" alt="${title}">` : ''}
          ${!poster ? `<div class="poster-placeholder">${title}</div>` : ''}
          ${overlayHtml}
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

  function showLibraryGroupOverlay(groupId, groupData) {
    let overlay = document.getElementById('library-group-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'library-group-overlay';
      overlay.className = 'library-group-overlay hidden';
      document.getElementById('view-library').appendChild(overlay);
    }

    const name = escapeHTML(groupData.name);
    overlay.innerHTML = `
      <div class="library-group-overlay-header">
        <button class="library-group-overlay-back" aria-label="Back">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
        <span class="library-group-overlay-title">${name}</span>
      </div>
      <div class="library-group-overlay-grid library-grid">
        ${groupData.movies.map(item => renderLibraryItem(item)).join('')}
      </div>
    `;

    overlay.classList.remove('hidden');
    dom.libraryContent.classList.add('hidden');
    const emptyEl = document.getElementById('library-empty');
    if (emptyEl) emptyEl.classList.add('hidden');

    // Attach play/remove handlers inside overlay
    attachLibraryHandlers(overlay.querySelector('.library-group-overlay-grid'));

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

  function hideLibraryGroupOverlay() {
    const overlay = document.getElementById('library-group-overlay');
    if (overlay) {
      overlay.classList.add('hidden');
      overlay.innerHTML = '';
    }
    dom.libraryContent.classList.remove('hidden');
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

    // Click on card to play if complete or converting (converting items still play via remux)
    container.querySelectorAll('.card[data-status="complete"], .card[data-status="converting"]').forEach(card => {
      card.addEventListener('click', () => {
        playLibraryItem(card.dataset.id);
      });
    });
  }

  async function playLibraryItem(id) {
    // Grab poster/title from DOM before navigating away
    const itemEl = dom.libraryContent.querySelector(`.library-item[data-id="${CSS.escape(id)}"]`);
    const libPoster = itemEl?.querySelector('.library-item-poster img')?.src || '';
    const libTitle = itemEl?.querySelector('.library-item-title')?.textContent || '';

    navigateTo('player');
    showCurtainOverlay({ poster: libPoster, title: libTitle, status: 'Loading from library...' });

    try {
      // Probe the file to decide the best playback strategy.
      // Direct stream supports range requests (seeking, duration, mobile).
      // Remux is needed for MKV containers or incompatible audio (AC3/DTS).
      const encodedId = encodeURIComponent(id);
      let url;
      let useRemux = true;

      try {
        const probeResp = await fetch(`/api/library/${encodedId}/probe`);
        if (probeResp.ok) {
          const probe = await probeResp.json();
          console.log('[Library] Probe result:', probe);
          if (probe.directPlay) {
            useRemux = false;
          }
        }
      } catch (e) {
        console.warn('[Library] Probe failed, falling back to remux:', e.message);
      }

      if (useRemux) {
        url = `/api/library/${encodedId}/stream/remux`;
        const statusEl = dom.playerOverlay.querySelector('.loading-status');
        if (statusEl) statusEl.textContent = 'Preparing for playback...';
      } else {
        url = `/api/library/${encodedId}/stream`;
      }

      dom.videoPlayer.src = url;
      dom.videoPlayer.load();

      await new Promise((resolve, reject) => {
        const onCanPlay = () => { cleanup(); resolve(); };
        const onError = () => {
          cleanup();
          const err = dom.videoPlayer.error;
          reject(new Error(err ? `Media error (code ${err.code}): ${useRemux ? 'remux' : 'direct'}` : 'Failed to load video'));
        };
        const cleanup = () => {
          dom.videoPlayer.removeEventListener('canplay', onCanPlay);
          dom.videoPlayer.removeEventListener('error', onError);
          clearTimeout(timer);
        };
        const timeoutMs = 240000;
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('Playback timed out — try again'));
        }, timeoutMs);
        dom.videoPlayer.addEventListener('canplay', onCanPlay, { once: true });
        dom.videoPlayer.addEventListener('error', onError, { once: true });
      });

      await dom.videoPlayer.play();
      openCurtains();
    } catch (e) {
      let hint = escapeHTML(e.message);
      if (e.message.includes('Media error') && e.message.includes('direct')) {
        // Direct stream failed — retry with remux (audio may be incompatible)
        console.warn('[Library] Direct stream failed, retrying with remux');
        try {
          const encodedId = encodeURIComponent(id);
          const statusEl = dom.playerOverlay.querySelector('.loading-status');
          if (statusEl) statusEl.textContent = 'Retrying with audio transcode...';
          dom.videoPlayer.src = `/api/library/${encodedId}/stream/remux`;
          dom.videoPlayer.load();
          await new Promise((resolve, reject) => {
            const onCanPlay = () => { dom.videoPlayer.removeEventListener('error', onErr); resolve(); };
            const onErr = () => { dom.videoPlayer.removeEventListener('canplay', onCanPlay); reject(new Error('Remux also failed')); };
            dom.videoPlayer.addEventListener('canplay', onCanPlay, { once: true });
            dom.videoPlayer.addEventListener('error', onErr, { once: true });
          });
          await dom.videoPlayer.play();
          openCurtains();
          return;
        } catch (retryErr) {
          hint = escapeHTML(retryErr.message);
        }
      }
      if (e.message.includes('Media error')) {
        hint += '<br><span style="font-size:12px">The file format may not be supported by your browser</span>';
      } else if (e.message.includes('timed out')) {
        hint += '<br><span style="font-size:12px">Try again — playback may work on a second attempt</span>';
      }
      showPlayerError('Playback failed', hint);
    }
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
        const downloading = items.filter(i => i.status === 'downloading');

        // Update progress for downloading items in-place
        for (const item of items) {
          const el = dom.libraryContent.querySelector(`.card[data-id="${CSS.escape(item.id)}"]`);
          if (!el) continue;

          if (item.status === 'downloading') {
            const bar = el.querySelector('.library-card-progress-bar');
            const overlay = el.querySelector('.library-card-overlay');
            const meta = el.querySelector('.library-card-meta');
            if (bar) bar.style.width = item.progress + '%';
            if (overlay) overlay.textContent = item.progress + '%';
            if (meta) {
              const speed = item.downloadSpeed > 0 ? formatSpeed(item.downloadSpeed) : '';
              meta.innerHTML = `${speed || 'Starting...'}${item.numPeers ? ' &middot; ' + item.numPeers + ' peers' : ''}`;
            }
          } else if (item.status === 'converting') {
            const bar = el.querySelector('.library-card-progress-bar');
            const overlay = el.querySelector('.library-card-overlay');
            const meta = el.querySelector('.library-card-meta');
            const pct = item.convertProgress || 0;
            if (bar) bar.style.width = pct + '%';
            if (overlay) overlay.textContent = pct + '%';
            if (meta) meta.textContent = 'Converting to MP4...';
          } else if (el.dataset.status !== item.status) {
            // Status changed — reload full list
            loadLibrary();
            return;
          }
        }

        const queued = items.filter(i => i.status === 'queued');
        const converting = items.filter(i => i.status === 'converting');
        if (downloading.length === 0 && queued.length === 0 && converting.length === 0) {
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

  // ─── Share / Tailscale VPN ──────────────────────────

  function initShare() {
    // Tailscale share page is static — no dynamic logic needed
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

  async function renderDownloads() {
    const panel = $('#downloads-panel');
    if (!panel) return;

    try {
      const resp = await fetch('/api/library');
      if (!resp.ok) throw new Error('Failed');
      const data = await resp.json();
      const items = data.items || [];

      // Split into categories
      const downloading = items.filter(i => i.status === 'downloading');
      const paused = items.filter(i => i.status === 'paused');
      const queued = items.filter(i => i.status === 'queued');
      const completed = items.filter(i => i.status === 'complete').slice(0, 5);
      const failed = items.filter(i => i.status === 'failed');

      if (downloading.length === 0 && paused.length === 0 && queued.length === 0 && completed.length === 0 && failed.length === 0) {
        panel.innerHTML = '<div class="downloads-empty"><span class="setting-hint">No downloads</span></div>';
        renderSourceStats(items);
        return;
      }

      let html = '';

      // Active downloads
      if (downloading.length > 0) {
        html += '<div class="download-section-label">Downloading</div>';
        html += downloading.map(i => downloadItemHTML(i)).join('');
      }

      // Paused
      if (paused.length > 0) {
        html += '<div class="download-section-label">Paused</div>';
        html += paused.map(i => downloadItemHTML(i)).join('');
      }

      // Queue
      if (queued.length > 0) {
        html += '<div class="download-section-label">Queue (' + queued.length + ')</div>';
        html += queued.map((i, idx) => downloadItemHTML(i, idx, queued.length)).join('');
      }

      // Failed
      if (failed.length > 0) {
        html += '<div class="download-section-label">Failed</div>';
        html += failed.map(i => downloadItemHTML(i)).join('');
      }

      // Recent completed
      if (completed.length > 0) {
        html += '<div class="download-section-label">Completed</div>';
        html += completed.map(i => downloadItemHTML(i)).join('');
      }

      panel.innerHTML = html;
      attachDownloadListeners(panel);
      renderSourceStats(items);
    } catch {
      panel.innerHTML = '<div class="downloads-empty"><span class="setting-hint">Could not load downloads</span></div>';
    }
  }

  function downloadItemHTML(item, queueIdx, queueLen) {
    const poster = item.poster
      ? `<img class="download-poster" src="${escapeHTML(item.poster)}" alt="" loading="lazy">`
      : '<div class="download-poster"></div>';

    const speed = item.downloadSpeed > 0
      ? `${(item.downloadSpeed / 1e6).toFixed(1)} MB/s`
      : '';
    const peers = item.numPeers > 0 ? `${item.numPeers} peers` : '';
    const meta = [item.quality, speed, peers].filter(Boolean).join(' \u00b7 ');

    const sizeStr = item.fileSize > 0
      ? `${(item.fileSize / 1e9).toFixed(2)} GB`
      : item.size || '';

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
      const upBtn = queueIdx > 0
        ? `<button class="queue-move-btn" data-id="${escapeHTML(item.id)}" data-action="move-up" title="Move up">\u25B2</button>`
        : '';
      const downBtn = queueIdx < queueLen - 1
        ? `<button class="queue-move-btn" data-id="${escapeHTML(item.id)}" data-action="move-down" title="Move down">\u25BC</button>`
        : '';
      actions = `
        <div class="download-queue-controls">${upBtn}${downBtn}</div>
        <button class="download-action-btn cancel" data-id="${escapeHTML(item.id)}" data-action="remove" title="Remove">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>`;
    } else if (item.status === 'failed') {
      actions = `
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
        const action = btn.dataset.action;

        if (action === 'pause') {
          await fetch(`/api/library/${encodeURIComponent(id)}/pause`, { method: 'POST' });
          renderDownloads();
        } else if (action === 'resume') {
          await fetch(`/api/library/${encodeURIComponent(id)}/resume`, { method: 'POST' });
          renderDownloads();
        } else if (action === 'remove') {
          await fetch(`/api/library/${encodeURIComponent(id)}`, { method: 'DELETE' });
          renderDownloads();
          showToast('Download removed');
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

  const _escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>"]/g, ch => _escapeMap[ch]);
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
          <button class="cast-device-item" data-device='${JSON.stringify(device).replace(/'/g, '&#39;')}'>
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

  function init() {
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

    // Player back button
    dom.playerBackBtn.addEventListener('click', () => {
      dom.videoPlayer.pause();
      dom.videoPlayer.src = '';
      dom.videoPlayer.load();
      goBack();
    });

    // Video stall/buffering detection — re-show overlay during mid-playback stalls
    // Only activate after the video has played at least once (playerStarted) to avoid
    // clobbering the detailed loading overlay during initial torrent buffering.
    dom.videoPlayer.addEventListener('waiting', () => {
      if (state.currentView === 'player' && state.playerStarted && dom.videoPlayer.src) {
        dom.playerOverlay.classList.remove('hidden');
        dom.playerOverlay.innerHTML = `
          <div class="spinner"></div>
          <p>Buffering...</p>
        `;
      }
    });
    dom.videoPlayer.addEventListener('stalled', () => {
      if (state.currentView === 'player' && state.playerStarted && dom.videoPlayer.src) {
        dom.playerOverlay.classList.remove('hidden');
        dom.playerOverlay.innerHTML = `
          <div class="spinner"></div>
          <p>Stream stalled — waiting for data...</p>
        `;
      }
    });
    dom.videoPlayer.addEventListener('playing', () => {
      state.playerStarted = true;
      dom.playerOverlay.classList.add('hidden');
    });

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
          if (!document.fullscreenElement) {
            v.pause();
            v.src = '';
            v.load();
            goBack();
          }
          break;
      }
    });

    // Search
    initSearch();

    // Filters
    initFilters();

    // Settings
    initSettings();

    // Share / QR Code
    initShare();

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
