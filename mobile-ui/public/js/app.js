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
  };

  // ─── DOM Refs ────────────────────────────────────

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

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
    bottomNav: $('#bottom-nav'),
    navBtns: $$('.nav-btn'),
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

    // Map nav views to their actual view IDs
    const viewMap = {
      'home': 'view-home',
      'movies': 'view-home',
      'series': 'view-home',
      'search': 'view-search',
      'detail': 'view-detail',
      'settings': 'view-settings',
      'player': 'view-player',
    };

    const target = $(('#' + (viewMap[view] || 'view-home')));
    if (target) target.classList.add('active');

    // Update UI
    updateNavUI(view);
    updateTopBar(view, opts);

    // Scroll to top
    dom.content.scrollTop = 0;
  }

  function goBack() {
    const prev = state.viewHistory.pop();
    if (prev) {
      state.currentView = prev;
      $$('.view').forEach(v => v.classList.remove('active'));

      const viewMap = {
        'home': 'view-home', 'movies': 'view-home', 'series': 'view-home',
        'search': 'view-search', 'detail': 'view-detail',
        'settings': 'view-settings', 'player': 'view-player',
      };
      const target = $('#' + (viewMap[prev] || 'view-home'));
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
        (btn.dataset.view === 'home' && !['movies', 'series', 'search', 'detail', 'settings', 'player'].includes(view)));
    });

    // Show/hide bottom nav
    const hideNav = view === 'player';
    dom.bottomNav.style.display = hideNav ? 'none' : '';
  }

  function updateTopBar(view, opts = {}) {
    const showBack = ['detail', 'settings', 'player'].includes(view);
    dom.backBtn.classList.toggle('hidden', !showBack);

    const titles = {
      'home': 'Alabtross',
      'movies': 'Movies',
      'series': 'Series',
      'search': 'Search',
      'detail': opts.title || 'Details',
      'settings': 'Settings',
      'player': 'Now Playing',
    };
    dom.pageTitle.textContent = titles[view] || 'Alabtross';

    // Show/hide top bar in player
    const hideTop = view === 'player';
    $('#top-bar').style.display = hideTop ? 'none' : '';
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

  function cardHTML(item, type) {
    const poster = item.poster || '';
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

  // ─── Search ──────────────────────────────────────

  function initSearch() {
    dom.searchToggle.addEventListener('click', () => {
      const isHidden = dom.searchBar.classList.contains('hidden');
      dom.searchBar.classList.toggle('hidden');
      if (isHidden) {
        dom.searchInput.focus();
        navigateTo('search');
      }
    });

    dom.searchInput.addEventListener('input', () => {
      const q = dom.searchInput.value.trim();
      dom.searchClear.classList.toggle('hidden', !q);

      clearTimeout(state.searchTimeout);
      if (q.length >= 2) {
        state.searchTimeout = setTimeout(() => performSearch(q), 400);
      } else {
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
      const hint = api.getMode() === 'custom'
        ? 'No torrents found on TPB, YTS, EZTV, or 1337x — check server terminal for details'
        : 'Try adding more stream addons in Settings';
      container.innerHTML = `
        <div class="empty-state" style="padding:32px 0">
          <p>No streams found</p>
          <p style="font-size:12px;color:var(--text-muted)">${hint}</p>
        </div>
      `;
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

    return `
      <div class="stream-item" data-index="${index}" id="stream-${index}">
        <div class="stream-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
        </div>
        <div class="stream-info">
          <div class="stream-title">${mainTitle}</div>
          <div class="stream-detail">${detail || addon}${quality ? ' &middot; ' + quality : ''}</div>
        </div>
        ${speedBadge}
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

  function attachStreamHandlers() {
    const list = document.getElementById('stream-list');
    if (!list) return;
    // Event delegation — single listener for all stream items
    list.addEventListener('click', (e) => {
      const item = e.target.closest('.stream-item');
      if (!item) return;
      const idx = parseInt(item.dataset.index);
      if (idx >= 0 && idx < _lastRankedStreams.length) {
        playStream(_lastRankedStreams[idx].stream);
      }
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

    // Custom mode torrents need time to connect — show status
    if (stream._customMode) {
      dom.playerOverlay.innerHTML = `
        <div class="spinner"></div>
        <p>Connecting to torrent peers...</p>
        <p style="font-size:12px;color:var(--text-muted)">This may take 30-60 seconds</p>
      `;
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

      await dom.videoPlayer.play();
      dom.playerOverlay.classList.add('hidden');
    } catch (e) {
      let hint = escapeHTML(e.message);
      if (e.message.includes('Media error') || e.message.includes('no supported source')) {
        hint += '<br><span style="font-size:12px">The file may be MKV format — browsers only support MP4/WebM</span>';
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

    dom.customAddCinemeta.addEventListener('click', async () => {
      const result = await api.addAddon('https://v3-cinemeta.strem.io');
      if (result.error) showToast(result.error);
      else { renderAddonList(); showToast('Added Cinemeta'); }
    });

    dom.settingsToggle.addEventListener('click', () => {
      navigateTo('settings');
      updateModeUI(api.getMode());
      renderAddonList();
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

  // ─── Init ────────────────────────────────────────

  function init() {
    // Bottom nav
    dom.navBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        state.viewHistory = [];
        if (view === 'movies') {
          navigateTo('movies');
          loadHome('movie');
        } else if (view === 'series') {
          navigateTo('series');
          loadHome('series');
        } else {
          navigateTo('home');
          loadHome();
        }
      });
    });

    // Back button
    dom.backBtn.addEventListener('click', goBack);

    // Search
    initSearch();

    // Settings
    initSettings();

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
