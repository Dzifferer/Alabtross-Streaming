/**
 * Alabtross Mobile — Main Application
 *
 * Mobile-first streaming interface with:
 * - Auto stream speed testing (picks fastest source)
 * - VPN safety checks (warns if not on VPN)
 * - Catalog browsing, search, detail views
 * - Built-in video player
 */

(function () {
  'use strict';

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
    bottomNav: $('#bottom-nav'),
    navBtns: $$('.nav-btn'),
    // Filter bar
    filterBar: $('#filter-bar'),
    filterChips: $$('.filter-chip'),
    // Library
    libraryContent: $('#library-content'),
    libraryEmpty: $('#library-empty'),
    // Settings
    modeToggle: $('#mode-toggle'),
    modeHint: $('#mode-hint'),
    stremioSettings: $('#stremio-settings'),
    customSettings: $('#custom-settings'),
    settingServer: $('#setting-server'),
    settingServerTest: $('#setting-server-test'),
    serverStatus: $('#server-status'),
    addonList: $('#addon-list'),
    addonUrlInput: $('#addon-url-input'),
    addonAddBtn: $('#addon-add-btn'),
    addonAddCinemeta: $('#addon-add-cinemeta'),
    addonAddTorrentio: $('#addon-add-torrentio'),
    customAddCinemeta: $('#custom-add-cinemeta'),
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
    // behind WireGuard), the connection itself proves VPN is active.
    // We also check if the server is reachable on its local IP.

    try {
      const serverUrl = api.getServerUrl() || '/stremio-api';
      const resp = await fetch(serverUrl + '/stats.json', {
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
    msg.textContent = 'VPN not detected \u2014 connect to WireGuard for safe streaming';

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

    // Clean up stream action bar when leaving detail view
    const actionBar = document.querySelector('.stream-action-bar');
    if (actionBar) actionBar.remove();

    // Scroll to top
    dom.content.scrollTop = 0;
  }

  function goBack() {
    const prev = state.viewHistory.pop();
    if (prev) {
      state.currentView = prev;
      $$('.view').forEach(v => v.classList.remove('active'));

      const target = $('#' + (VIEW_MAP[prev] || 'view-home'));
      if (target) target.classList.add('active');
      updateNavUI(prev);
      updateTopBar(prev);
    }

    // Stop video if leaving player
    if (state.currentView !== 'player') {
      dom.videoPlayer.pause();
      dom.videoPlayer.src = '';
    }
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
      'home': 'Alabtross',
      'movies': 'Movies',
      'series': 'Series',
      'search': 'Search',
      'detail': opts.title || 'Details',
      'settings': 'Settings',
      'library': 'Library',
      'share': 'Share',
      'player': 'Now Playing',
    };
    dom.pageTitle.textContent = titles[view] || 'Alabtross';

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

    // Custom mode: simple 3-row layout
    if (api.getMode() === 'custom' && !type) {
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
  }

  async function loadHomeCustom() {
    // Row 1: Recently Played
    const recent = getRecentlyPlayed();
    dom.homeLoading.classList.add('hidden');

    if (recent.length > 0) {
      const recentRow = document.createElement('div');
      recentRow.className = 'catalog-row fade-in';
      recentRow.innerHTML = `
        <div class="catalog-row-header">
          <h3 class="catalog-row-title">Recently Played</h3>
        </div>
        <div class="catalog-scroll">${recent.slice(0, 20).map(item => cardHTML(item, item.type)).join('')}</div>
      `;
      dom.homeCatalogs.appendChild(recentRow);
      attachCardListeners(recentRow);
    }

    // Row 2: Movies — first movie catalog from addons
    const movieCatalogs = await api.getCatalogs('movie');
    if (movieCatalogs.length > 0) {
      const cat = movieCatalogs[0];
      const movieItems = await api.getCatalogItems(cat.addonUrl, cat.type, cat.id);
      if (movieItems.length > 0) {
        const movieRow = document.createElement('div');
        movieRow.className = 'catalog-row fade-in';
        movieRow.innerHTML = `
          <div class="catalog-row-header">
            <h3 class="catalog-row-title">Movies</h3>
          </div>
          <div class="catalog-scroll">${movieItems.slice(0, 20).map(item => cardHTML(item, 'movie')).join('')}</div>
        `;
        dom.homeCatalogs.appendChild(movieRow);
        attachCardListeners(movieRow);
      }
    }

    // Row 3: Shows — first series catalog from addons
    const seriesCatalogs = await api.getCatalogs('series');
    if (seriesCatalogs.length > 0) {
      const cat = seriesCatalogs[0];
      const seriesItems = await api.getCatalogItems(cat.addonUrl, cat.type, cat.id);
      if (seriesItems.length > 0) {
        const seriesRow = document.createElement('div');
        seriesRow.className = 'catalog-row fade-in';
        seriesRow.innerHTML = `
          <div class="catalog-row-header">
            <h3 class="catalog-row-title">Shows</h3>
          </div>
          <div class="catalog-scroll">${seriesItems.slice(0, 20).map(item => cardHTML(item, 'series')).join('')}</div>
        `;
        dom.homeCatalogs.appendChild(seriesRow);
        attachCardListeners(seriesRow);
      }
    }

    // Row 4+: Live TV — from all configured sources (playlists + Stremio TV addons)
    const tvGroups = await api.getAllLiveTVChannels();
    for (const group of tvGroups) {
      const tvRow = document.createElement('div');
      tvRow.className = 'catalog-row fade-in';
      tvRow.innerHTML = `
        <div class="catalog-row-header">
          <h3 class="catalog-row-title">${escapeHTML(group.sourceName)}</h3>
          <span class="catalog-row-badge">LIVE</span>
        </div>
        <div class="catalog-scroll">${group.channels.slice(0, 30).map(ch => channelCardHTML(ch)).join('')}</div>
      `;
      dom.homeCatalogs.appendChild(tvRow);
      attachChannelListeners(tvRow);
    }

    // If nothing at all loaded, show empty state
    if (dom.homeCatalogs.children.length === 0) {
      dom.homeCatalogs.innerHTML = `
        <div class="empty-state">
          <p>No content available</p>
          <p style="font-size:13px;color:var(--text-muted)">Add Cinemeta addon in Settings to browse content</p>
        </div>
      `;
    }
  }

  async function loadCatalogRow(catalog) {
    const items = await api.getCatalogItems(
      catalog.addonUrl, catalog.type, catalog.id
    );
    if (items.length === 0) return;

    const row = document.createElement('div');
    row.className = 'catalog-row fade-in';

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
            ? `<img src="${poster}" alt="${title}" class="loading">`
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
            ? `<img src="${logo}" alt="${name}" class="loading">`
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
    dom.playerOverlay.classList.remove('hidden');
    dom.playerOverlay.innerHTML = `
      <div class="spinner"></div>
      <p>Tuning to ${escapeHTML(name)}...</p>
    `;

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
      dom.playerOverlay.classList.add('hidden');
    } catch (e) {
      dom.playerOverlay.innerHTML = `
        <p style="color:var(--danger)">Channel unavailable</p>
        <p style="font-size:13px;color:var(--text-muted)">${escapeHTML(e.message)}</p>
        <button id="player-go-back" style="
          margin-top:16px; padding:10px 24px; background:var(--accent);
          border:none; border-radius:8px; color:white; font-size:14px; cursor:pointer;
        ">Go Back</button>
      `;
      document.getElementById('player-go-back').addEventListener('click', () => goBack());
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
    const results = await api.search(query, typeFilter);

    if (results.length === 0) {
      dom.searchResults.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1">
          <p>No results for "${escapeHTML(query)}"</p>
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

  // ─── Detail View ─────────────────────────────────

  async function openDetail(type, id) {
    navigateTo('detail', { title: 'Loading...' });
    dom.detailContent.innerHTML = `
      <div class="loading-state"><div class="spinner"></div><p>Loading details...</p></div>
    `;

    const meta = await api.getMeta(type, id);
    if (!meta) {
      dom.detailContent.innerHTML = `
        <div class="empty-state"><p>Could not load details</p></div>
      `;
      return;
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

    // Add to Library button (only for custom mode where we have torrent data)
    if (api.getMode() === 'custom') {
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

    // Load streams for movies
    if (type === 'movie') {
      loadStreams(type, id);
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

  function renderEpisodes(videos, season) {
    const eps = videos
      .filter(v => v.season === season)
      .sort((a, b) => (a.episode || 0) - (b.episode || 0));

    return eps.map(ep => `
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
        loadStreams('series', showId, { season, episode });
      });
    });
  }

  // ─── Stream Loading with Speed Testing ───────────

  async function loadStreams(type, id, seasonEpisode) {
    const container = document.getElementById('stream-container');
    if (!container) return;

    // First, check VPN status (Stremio mode only)
    if (api.getMode() === 'stremio' && !state.vpnVerified) {
      const vpn = await checkVPNStatus();
      if (!vpn.connected) {
        showVPNWarning();
      }
    }

    const streams = await api.getStreams(type, id, seasonEpisode);

    if (streams.length === 0) {
      const isCustom = api.getMode() === 'custom';
      const hint = isCustom
        ? 'All providers returned empty — this usually means a network issue on the server'
        : 'Try adding more stream addons in Settings';
      container.innerHTML = `
        <div class="empty-state" style="padding:32px 0">
          <p>No streams found</p>
          <p style="font-size:12px;color:var(--text-muted)">${hint}</p>
          ${isCustom ? `<button id="diagnose-btn" style="
            margin-top:12px; padding:8px 16px; border:1px solid var(--text-muted);
            border-radius:var(--radius-sm); background:transparent; color:var(--text);
            font-size:13px; cursor:pointer;
          ">Run Provider Diagnostics</button>
          <div id="diagnose-results" style="margin-top:12px;font-size:12px;text-align:left;display:none"></div>` : ''}
        </div>
      `;
      if (isCustom) {
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

    // Show streams with a "testing" state
    const isCustom = api.getMode() === 'custom';
    const statusLabel = isCustom ? 'Ranking by seeds...' : 'Testing stream speeds...';
    container.innerHTML = `
      <div class="stream-speed-status" style="
        text-align:center; padding:12px; margin-bottom:8px;
        font-size:13px; color:var(--text-dim);
        background:var(--bg-card); border-radius:var(--radius-sm);
      ">
        <div class="spinner" style="width:20px;height:20px;margin:0 auto 8px;border-width:2px"></div>
        ${statusLabel} <span id="speed-progress">0/${streams.length}</span>
      </div>
      <div class="stream-list" id="stream-list">
        ${streams.map((s, i) => renderStreamItem(s, i, 'testing')).join('')}
      </div>
    `;

    // Now test all streams in parallel
    const ranked = await api.testAndRankStreams(streams, (tested, total, result) => {
      const progress = document.getElementById('speed-progress');
      if (progress) progress.textContent = `${tested}/${total}`;

      // Update individual stream items with their speed
      updateStreamItemSpeed(result);
    });

    // Re-render sorted by speed
    const statusEl = container.querySelector('.stream-speed-status');
    if (statusEl) {
      const fastest = ranked.find(r => r.responseTime < Infinity);
      if (fastest) {
        if (isCustom) {
          const seeds = fastest.stream.seeds || 0;
          statusEl.innerHTML = `
            <span style="color:var(--success)">&#9889;</span>
            Best stream: <strong>${seeds} seeds</strong>
            <span style="color:var(--success)"> &mdash; ${fastest.stream.source || 'Custom'}</span>
          `;
        } else {
          statusEl.innerHTML = `
            <span style="color:var(--success)">&#9889;</span>
            Best stream: <strong>${Math.round(fastest.responseTime)}ms</strong> response time
            <span style="color:var(--success)"> &mdash; Auto-selected</span>
          `;
        }
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

    // Enable the "Add to Library" button now that streams are available
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
    if (stream._customMode && status === 'done') {
      // Custom mode: show seed count
      const seeds = stream.seeds || 0;
      let color = 'var(--success)';
      let bg = 'rgba(0, 206, 201, 0.15)';
      if (seeds < 5) { color = 'var(--danger)'; bg = 'rgba(255, 107, 107, 0.15)'; }
      else if (seeds < 20) { color = 'var(--warning)'; bg = 'rgba(253, 203, 110, 0.15)'; }
      speedBadge = `<span class="stream-quality" style="background:${bg};color:${color}">${seeds} seeds</span>`;
    } else if (status === 'testing') {
      speedBadge = '<span class="stream-quality" style="background:rgba(255,255,255,0.05);color:var(--text-muted)">Testing...</span>';
    } else if (responseTime < Infinity) {
      const ms = Math.round(responseTime);
      let color = 'var(--success)';
      let bg = 'rgba(0, 206, 201, 0.15)';
      if (ms > 3000) { color = 'var(--danger)'; bg = 'rgba(255, 107, 107, 0.15)'; }
      else if (ms > 1000) { color = 'var(--warning)'; bg = 'rgba(253, 203, 110, 0.15)'; }
      speedBadge = `<span class="stream-quality" style="background:${bg};color:${color}">${ms}ms</span>`;
    } else {
      speedBadge = '<span class="stream-quality" style="background:rgba(255,107,107,0.1);color:var(--danger)">Timeout</span>';
    }

    // Detect quality from title
    let quality = '';
    const qualityMatch = title.match(/\b(4K|2160p|1080p|720p|480p|HDR|HEVC|H\.265|H\.264)\b/i);
    if (qualityMatch) quality = qualityMatch[1].toUpperCase();

    // Format badge for custom mode
    let formatBadge = '';
    if (stream._customMode && stream.format) {
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
      <div class="stream-item${stream._customMode && !stream.browserPlayable && !stream.remuxPlayable ? ' stream-non-playable' : ''}" data-index="${index}" id="stream-${index}">
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
    // Find the matching stream item by comparing stream objects
    const items = document.querySelectorAll('.stream-item');
    items.forEach(item => {
      const title = item.querySelector('.stream-title');
      const streamTitle = (result.stream.title || result.stream.name || 'Unknown Stream').split('\n')[0];
      if (title && title.textContent === streamTitle) {
        const badge = item.querySelector('.stream-quality');
        if (badge && badge.textContent === 'Testing...') {
          if (result.responseTime < Infinity) {
            const ms = Math.round(result.responseTime);
            let color = 'var(--success)';
            let bg = 'rgba(0, 206, 201, 0.15)';
            if (ms > 3000) { color = 'var(--danger)'; bg = 'rgba(255, 107, 107, 0.15)'; }
            else if (ms > 1000) { color = 'var(--warning)'; bg = 'rgba(253, 203, 110, 0.15)'; }
            badge.style.background = bg;
            badge.style.color = color;
            badge.textContent = ms + 'ms';
          } else {
            badge.style.background = 'rgba(255,107,107,0.1)';
            badge.style.color = 'var(--danger)';
            badge.textContent = 'Timeout';
          }
        }
      }
    });
  }

  // Store ranked results so stream items can reference them by index
  let _lastRankedStreams = [];

  let _selectedStreamIndex = -1;

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
    dom.playerOverlay.classList.remove('hidden');

    // Build loading screen with poster
    const poster = state.currentMeta?.poster || '';
    const title = state.currentMeta?.name || '';
    const statusLabel = stream._customMode ? 'Connecting to torrent peers...' : 'Loading stream...';
    dom.playerOverlay.innerHTML = `
      ${poster ? `<img class="loading-poster" src="${poster}" alt="">` : ''}
      ${title ? `<div class="loading-title">${escapeHTML(title)}</div>` : ''}
      <div class="loading-bar-container"><div class="loading-bar"></div></div>
      <div class="loading-status">${statusLabel}</div>
      ${stream._customMode ? '<div class="loading-sub">This may take 30-60 seconds</div>' : ''}
    `;

    // Poll torrent status for custom mode streams
    let statusInterval = null;
    if (stream._customMode && stream.infoHash) {
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
      dom.playerOverlay.classList.add('hidden');
    } catch (e) {
      if (statusInterval) clearInterval(statusInterval);
      let hint = escapeHTML(e.message);
      if (e.message.includes('Media error') || e.message.includes('no supported source')) {
        hint += '<br><span style="font-size:12px">The file format may not be supported by your browser</span>';
      }
      dom.playerOverlay.innerHTML = `
        <p style="color:var(--danger)">Playback failed</p>
        <p style="font-size:13px;color:var(--text-muted)">${hint}</p>
        <button id="player-go-back" style="
          margin-top:16px; padding:10px 24px; background:var(--accent);
          border:none; border-radius:8px; color:white; font-size:14px; cursor:pointer;
        ">Go Back</button>
      `;
      document.getElementById('player-go-back').addEventListener('click', () => goBack());
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
    dom.libraryContent.innerHTML = '';
    dom.libraryEmpty.classList.add('hidden');

    dom.libraryContent.innerHTML = `
      <div class="loading-state" style="grid-column:1/-1">
        <div class="spinner"></div>
        <p>Loading library...</p>
      </div>
    `;

    try {
      // Fetch library items, cache items, and active torrents in parallel
      const [libResp, cacheResp, torrentResp] = await Promise.all([
        fetch('/api/library').then(r => r.json()).catch(() => ({ items: [] })),
        fetch('/api/cache').then(r => r.json()).catch(() => ({ items: [] })),
        fetch('/api/torrent-status').then(r => r.json()).catch(() => ({ torrents: [] })),
      ]);

      const libraryItems = libResp.items || [];
      const cacheItems = cacheResp.items || [];
      const activeTorrents = torrentResp.torrents || [];

      // Build a set of names already in library to avoid duplicates
      const libraryNames = new Set(libraryItems.map(i => (i.name || '').toLowerCase()));

      // Add cached items not in library
      const cachedEntries = cacheItems
        .filter(c => !libraryNames.has(c.name.toLowerCase()))
        .map(c => {
          // Check if this is actively streaming
          const active = activeTorrents.find(t => t.name === c.name);
          return {
            id: 'cache_' + c.name,
            name: c.name,
            type: 'movie',
            status: 'cached',
            fileSize: c.videoSize || c.totalSize,
            videoFile: c.videoFile,
            downloadSpeed: active ? active.downloadSpeed : 0,
            numPeers: active ? active.numPeers : 0,
            poster: '',
            year: '',
            quality: '',
          };
        });

      const allItems = [...libraryItems, ...cachedEntries];

      if (allItems.length === 0) {
        dom.libraryContent.innerHTML = '';
        dom.libraryEmpty.classList.remove('hidden');
        return;
      }

      dom.libraryContent.innerHTML = allItems.map(item => renderLibraryItem(item)).join('');
      attachLibraryHandlers();

      // Start progress polling for downloading or active items
      const needsPoll = allItems.some(i => i.status === 'downloading' || i.downloadSpeed > 0);
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
    const quality = item.quality ? `<span class="library-quality">${escapeHTML(item.quality)}</span>` : '';

    let statusBadge = '';
    if (item.status === 'downloading') {
      const speed = item.downloadSpeed > 0 ? formatSpeed(item.downloadSpeed) : '';
      statusBadge = `
        <div class="library-progress">
          <div class="library-progress-bar" style="width:${item.progress}%"></div>
        </div>
        <div class="library-status downloading">
          ${item.progress}%${speed ? ' &middot; ' + speed : ''}${item.numPeers ? ' &middot; ' + item.numPeers + ' peers' : ''}
        </div>
      `;
    } else if (item.status === 'complete') {
      const size = item.fileSize ? formatSize(item.fileSize) : item.size || '';
      statusBadge = `<div class="library-status complete">${size ? size + ' &middot; ' : ''}Ready to play</div>`;
    } else if (item.status === 'cached') {
      const size = item.fileSize ? formatSize(item.fileSize) : '';
      const speed = item.downloadSpeed > 0 ? formatSpeed(item.downloadSpeed) : '';
      const peers = item.numPeers > 0 ? item.numPeers + ' peers' : '';
      const details = [size, speed, peers].filter(Boolean).join(' &middot; ');
      statusBadge = `<div class="library-status cached" style="color:var(--text-muted)">${details || 'In cache'}</div>`;
    } else if (item.status === 'failed') {
      statusBadge = `<div class="library-status failed">${escapeHTML(item.error || 'Download failed')}</div>`;
    }

    return `
      <div class="library-item" data-id="${escapeHTML(item.id)}" data-status="${item.status}">
        <div class="library-item-poster">
          ${poster ? `<img src="${poster}" alt="${title}">` : `<div class="poster-placeholder">${title}</div>`}
        </div>
        <div class="library-item-info">
          <div class="library-item-title">${title}</div>
          <div class="library-item-meta">${year}${quality ? ' &middot; ' : ''}${quality}</div>
          ${statusBadge}
        </div>
        <div class="library-item-actions">
          ${item.status === 'complete' ? `
            <button class="library-play-btn" data-id="${escapeHTML(item.id)}" title="Play">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </button>
          ` : ''}
          <button class="library-remove-btn" data-id="${escapeHTML(item.id)}" title="Remove">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>
      </div>
    `;
  }

  function attachLibraryHandlers() {
    // Play buttons
    dom.libraryContent.querySelectorAll('.library-play-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        playLibraryItem(btn.dataset.id);
      });
    });

    // Remove buttons
    dom.libraryContent.querySelectorAll('.library-remove-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeLibraryItem(btn.dataset.id);
      });
    });

    // Click on item to play if complete
    dom.libraryContent.querySelectorAll('.library-item[data-status="complete"]').forEach(item => {
      item.addEventListener('click', () => {
        playLibraryItem(item.dataset.id);
      });
    });
  }

  async function playLibraryItem(id) {
    navigateTo('player');
    dom.playerOverlay.classList.remove('hidden');
    dom.playerOverlay.innerHTML = `
      <div class="spinner"></div>
      <p>Loading from library...</p>
    `;

    try {
      // Always use remux endpoint to ensure browser-compatible audio.
      // Many files use AC3/DTS audio that browsers can't decode natively.
      // FFmpeg copies video and transcodes audio to AAC — lightweight.
      const url = `/api/library/${encodeURIComponent(id)}/stream/remux`;
      dom.videoPlayer.src = url;
      dom.videoPlayer.load();

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
        const timeoutMs = 240000;
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('Remux timed out — try again'));
        }, timeoutMs);
        dom.videoPlayer.addEventListener('canplay', onCanPlay, { once: true });
        dom.videoPlayer.addEventListener('error', onError, { once: true });
      });

      await dom.videoPlayer.play();
      dom.playerOverlay.classList.add('hidden');
    } catch (e) {
      let hint = escapeHTML(e.message);
      if (e.message.includes('Media error')) {
        hint += '<br><span style="font-size:12px">The file format may not be supported by your browser</span>';
      } else if (e.message.includes('timed out')) {
        hint += '<br><span style="font-size:12px">Try again — playback may work on a second attempt</span>';
      }
      dom.playerOverlay.innerHTML = `
        <p style="color:var(--danger)">Playback failed</p>
        <p style="font-size:13px;color:var(--text-muted)">${hint}</p>
        <button id="player-go-back" style="
          margin-top:16px; padding:10px 24px; background:var(--accent);
          border:none; border-radius:8px; color:white; font-size:14px; cursor:pointer;
        ">Go Back</button>
      `;
      document.getElementById('player-go-back').addEventListener('click', () => goBack());
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
          const el = dom.libraryContent.querySelector(`.library-item[data-id="${CSS.escape(item.id)}"]`);
          if (!el) continue;

          if (item.status === 'downloading') {
            const bar = el.querySelector('.library-progress-bar');
            const status = el.querySelector('.library-status');
            if (bar) bar.style.width = item.progress + '%';
            if (status) {
              const speed = item.downloadSpeed > 0 ? formatSpeed(item.downloadSpeed) : '';
              status.innerHTML = `${item.progress}%${speed ? ' &middot; ' + speed : ''}${item.numPeers ? ' &middot; ' + item.numPeers + ' peers' : ''}`;
            }
          } else if (el.dataset.status !== item.status) {
            // Status changed — reload full list
            loadLibrary();
            return;
          }
        }

        if (downloading.length === 0) {
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

  // ─── Share / VPN QR Code ──────────────────────────

  let currentVPNConfig = '';

  function generateConfigQR(config) {
    const container = $('#qr-code-container');
    try {
      const svg = QRCode.toSVG(config, {
        moduleSize: 6,
        margin: 3,
        dark: '#000000',
        light: '#ffffff',
      });
      container.innerHTML = svg;
    } catch (e) {
      container.innerHTML = '<p style="color:#ff6b6b;">Config too long for QR code — try a shorter config</p>';
    }
  }

  async function loadVPNProfiles() {
    const list = $('#vpn-profile-list');
    try {
      const resp = await fetch('/api/vpn/profiles');
      const data = await resp.json();

      if (data.profiles.length === 0) {
        list.innerHTML = `<div class="vpn-profile-empty">
          <p>${data.error || 'No VPN profiles found'}</p>
          <p style="margin-top:8px;">Create profiles with: <code>pivpn add</code></p>
        </div>`;
        return;
      }

      list.innerHTML = data.profiles.map(name => `
        <button class="vpn-profile-btn" data-profile="${name}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2"/>
            <circle cx="8.5" cy="7" r="4"/><path d="M20 8v6M23 11h-6"/>
          </svg>
          ${name}
        </button>
      `).join('');

      list.querySelectorAll('.vpn-profile-btn').forEach(btn => {
        btn.addEventListener('click', () => selectVPNProfile(btn.dataset.profile));
      });
    } catch (e) {
      list.innerHTML = '<div class="vpn-profile-empty">Failed to load VPN profiles</div>';
    }
  }

  async function selectVPNProfile(name) {
    const container = $('#qr-code-container');
    const profileName = $('#vpn-profile-name');
    const urlBox = $('#share-url-display');
    const urlText = $('#share-url-text');

    // Highlight selected button
    $$('.vpn-profile-btn').forEach(b => b.classList.toggle('active', b.dataset.profile === name));

    container.innerHTML = '<div class="spinner"></div><p>Loading config...</p>';

    try {
      const resp = await fetch(`/api/vpn/profile/${encodeURIComponent(name)}`);
      if (!resp.ok) throw new Error('Profile not found');
      const data = await resp.json();
      currentVPNConfig = data.config;

      generateConfigQR(data.config);
      profileName.textContent = name;
      profileName.classList.remove('hidden');
      urlBox.classList.remove('hidden');
      urlText.textContent = `${name}.conf`;
    } catch (e) {
      container.innerHTML = '<p style="color:#ff6b6b;">Failed to load profile</p>';
      currentVPNConfig = '';
    }
  }

  function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
      showToast('Copied to clipboard');
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('Copied to clipboard');
    });
  }

  function initShare() {
    $('#share-copy-btn').addEventListener('click', () => {
      if (currentVPNConfig) copyToClipboard(currentVPNConfig);
    });

    $('#share-manual-btn').addEventListener('click', () => {
      const input = $('#share-custom-config');
      const config = input.value.trim();
      if (!config) { showToast('Paste a WireGuard config first'); return; }
      currentVPNConfig = config;
      generateConfigQR(config);
      $('#vpn-profile-name').textContent = 'Manual Config';
      $('#vpn-profile-name').classList.remove('hidden');
      $('#share-url-display').classList.remove('hidden');
      $('#share-url-text').textContent = 'manual.conf';
      $$('.vpn-profile-btn').forEach(b => b.classList.remove('active'));
    });
  }

  // ─── Settings ────────────────────────────────────

  function initSettings() {
    // ─── Mode Toggle ────────────────────────────────
    const modeHints = {
      stremio: 'Uses Stremio server + addons for streams',
      custom: 'Uses YTS, EZTV, 1337x directly — no Stremio needed',
    };

    function updateModeUI(mode) {
      const btns = dom.modeToggle.querySelectorAll('.mode-btn');
      btns.forEach(btn => btn.classList.toggle('active', btn.dataset.mode === mode));

      // Move slider
      const slider = dom.modeToggle.querySelector('.mode-slider');
      slider.style.transform = mode === 'custom' ? 'translateX(100%)' : 'translateX(0)';

      // Show/hide mode-specific settings
      dom.stremioSettings.classList.toggle('hidden', mode !== 'stremio');
      dom.customSettings.classList.toggle('hidden', mode !== 'custom');
      dom.modeHint.textContent = modeHints[mode];
    }

    // Init mode from saved state
    updateModeUI(api.getMode());

    dom.modeToggle.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        api.setMode(mode);
        updateModeUI(mode);
        applyTheme(mode);
        showToast(mode === 'custom' ? 'Custom mode — direct sources' : 'Stremio mode');
      });
    });

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

    // ─── Stremio Mode Settings ──────────────────────

    // Load saved server URL
    dom.settingServer.value = api.getServerUrl();

    // Test server
    dom.settingServerTest.addEventListener('click', async () => {
      const url = dom.settingServer.value.trim();
      if (url) api.setServerUrl(url);
      dom.serverStatus.textContent = 'Testing...';
      dom.serverStatus.className = 'setting-hint';

      const result = await api.testServer();
      if (result.ok) {
        dom.serverStatus.textContent = 'Connected!';
        dom.serverStatus.className = 'setting-hint success';
        state.vpnVerified = true;
      } else {
        dom.serverStatus.textContent = 'Failed: ' + result.error;
        dom.serverStatus.className = 'setting-hint error';
      }
    });

    // Save server URL on blur
    dom.settingServer.addEventListener('change', () => {
      const url = dom.settingServer.value.trim();
      if (url) api.setServerUrl(url);
    });

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
    dom.addonAddCinemeta.addEventListener('click', async () => {
      const result = await api.addAddon('https://v3-cinemeta.strem.io');
      if (result.error) showToast(result.error);
      else { renderAddonList(); showToast('Added Cinemeta'); }
    });

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
          const resp = await fetch(url + '/manifest.json', { signal: AbortSignal.timeout(10000) });
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

    dom.customAddCinemeta.addEventListener('click', async () => {
      const result = await api.addAddon('https://v3-cinemeta.strem.io');
      if (result.error) showToast(result.error);
      else { renderAddonList(); showToast('Added Cinemeta'); }
    });

    dom.settingsToggle.addEventListener('click', () => {
      navigateTo('settings');
      updateModeUI(api.getMode());
      renderAddonList();
      renderLiveTVSources();
    });

    renderAddonList();
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
      return `
        <div class="source-item">
          <div class="source-icon">${icon}</div>
          <div class="source-info">
            <div class="source-name">${escapeHTML(s.name || s.url)}</div>
            <div class="source-desc">${typeLabel}</div>
          </div>
          <button class="livetv-source-remove" data-url="${escapeHTML(s.url)}" title="Remove">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>
      `;
    }).join('');

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

  function applyTheme(mode) {
    const app = document.getElementById('app');
    app.classList.toggle('theme-custom', mode === 'custom');
  }

  // ─── Utility ─────────────────────────────────────

  function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ─── Casting ─────────────────────────────────────

  const castState = { available: false, active: false };

  function initCasting() {
    const video = dom.videoPlayer;

    // Remote Playback API — supported in Chrome, Edge, Safari (Chromecast + AirPlay)
    if (!video.remote) {
      return;
    }

    video.disableRemotePlayback = false;

    // Always show the cast button — let prompt() handle device discovery
    dom.castBtn.classList.remove('hidden');

    // Cast button: prompt device picker
    dom.castBtn.addEventListener('click', async () => {
      try {
        await video.remote.prompt();
      } catch (e) {
        if (e.name === 'NotFoundError') {
          showToast('No cast devices found on your network');
        } else if (e.name !== 'NotAllowedError') {
          showToast('Cast not available');
        }
      }
    });

    // Track connection state changes
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

    // Stop casting button
    dom.castStopBtn.addEventListener('click', () => {
      try {
        // Pause the remote playback — the connection will trigger disconnect
        video.pause();
        if (video.remote.state === 'connected') {
          video.remote.prompt(); // re-opening prompt allows disconnecting
        }
      } catch {
        // Fallback — just hide overlay
        castState.active = false;
        dom.castBtn.classList.remove('casting');
        dom.castOverlay.classList.add('hidden');
      }
    });
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
          loadVPNProfiles();
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
      goBack();
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
    applyTheme(api.getMode());

    // Initial load
    loadHome();

    // VPN check
    checkVPNStatus()
      .then(result => { if (!result.connected) showVPNWarning(); })
      .catch(() => showVPNWarning());

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
