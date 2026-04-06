/**
 * Alabtross Mobile — Stremio API Layer
 *
 * Supports two modes:
 *   - "stremio" : Original behavior — addons + Stremio server for streams
 *   - "custom"  : Direct torrent sources (YTS/EZTV/1337x) + local WebTorrent engine
 */

const CINEMETA_URL = 'https://v3-cinemeta.strem.io';

// Torrentio requires a config prefix to return results from all providers.
// We try multiple configs since the API format may have changed.
const TORRENTIO_BASE = 'https://torrentio.strem.io';
const TORRENTIO_CONFIGS = [
  'providers=yts,eztv,rarbg,1337x,thepiratebay,kickasstorrents,torrentgalaxy|sort=qualitysize|qualityfilter=other',
  'sort=qualitysize|qualityfilter=other',
  '',
];

// Common trackers for building magnet URIs (Torrentio returns bare infoHash)
const MAGNET_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
];

class StremioAPI {
  constructor() {
    this.mode = localStorage.getItem('streaming_mode') || 'custom';
    this.addons = this._loadAddons();
    this.serverUrl = localStorage.getItem('stremio_server') || '';
    this._manifestCache = new Map();
    this._cacheTimestamps = new Map();
    this._speedTestInProgress = false;
    this._speedTestController = null;
  }

  // ─── Mode Management ─────────────────────────────

  getMode() {
    return this.mode;
  }

  setMode(mode) {
    if (mode !== 'stremio' && mode !== 'custom') return;
    this.mode = mode;
    localStorage.setItem('streaming_mode', mode);
  }

  // ─── Addon Management ────────────────────────────

  _loadAddons() {
    try {
      const saved = localStorage.getItem('stremio_addons');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          return parsed.filter(a => a && typeof a.url === 'string');
        }
      }
    } catch (e) {
      console.warn('Corrupted addon data — resetting', e);
      localStorage.removeItem('stremio_addons');
    }
    const defaults = [
      { url: CINEMETA_URL, name: 'Cinemeta', types: ['movie', 'series'] },
    ];
    this._saveAddons(defaults);
    return defaults;
  }

  _saveAddons(addons) {
    localStorage.setItem('stremio_addons', JSON.stringify(addons));
    this.addons = addons;
  }

  async addAddon(url) {
    // Validate URL
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
        return { error: 'Only HTTPS addon URLs are allowed (or localhost)' };
      }
    } catch {
      return { error: 'Invalid URL' };
    }

    url = url.replace(/\/manifest\.json$/, '').replace(/\/$/, '');
    if (this.addons.find(a => a.url === url)) {
      return { error: 'Addon already added' };
    }
    try {
      const manifest = await this._fetchManifest(url);
      const addon = {
        url,
        name: manifest.name || url,
        types: manifest.types || [],
        catalogs: manifest.catalogs || [],
        resources: manifest.resources || [],
      };
      const updated = [...this.addons, addon];
      this._saveAddons(updated);
      return addon;
    } catch (e) {
      return { error: 'Failed to load addon manifest' };
    }
  }

  removeAddon(url) {
    this._saveAddons(this.addons.filter(a => a.url !== url));
  }

  getAddons() {
    return this.addons;
  }

  // ─── Server Configuration ────────────────────────

  setServerUrl(url) {
    this.serverUrl = url.replace(/\/$/, '');
    localStorage.setItem('stremio_server', this.serverUrl);
  }

  getServerUrl() {
    return this.serverUrl;
  }

  async testServer() {
    const url = this.serverUrl || '/stremio-api';
    try {
      const resp = await fetch(url + '/stats.json', { signal: AbortSignal.timeout(5000) });
      if (resp.ok) return { ok: true };
      return { ok: false, error: 'Server responded with ' + resp.status };
    } catch {
      return { ok: false, error: 'Server unreachable' };
    }
  }

  // ─── Manifest Fetching (with TTL cache) ──────────

  async _fetchManifest(addonUrl) {
    const now = Date.now();
    const cached = this._manifestCache.get(addonUrl);
    const ts = this._cacheTimestamps.get(addonUrl) || 0;

    // Cache for 5 minutes
    if (cached && (now - ts) < 300000) {
      return cached;
    }

    const resp = await fetch('/api/addon-proxy?url=' + encodeURIComponent(addonUrl + '/manifest.json'));
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    this._manifestCache.set(addonUrl, data);
    this._cacheTimestamps.set(addonUrl, now);
    return data;
  }

  // ─── Catalogs ────────────────────────────────────
  // Catalogs always come from addons (Cinemeta) regardless of mode

  async getCatalogs(type) {
    const results = [];
    for (const addon of this.addons) {
      try {
        const manifest = await this._fetchManifest(addon.url);
        if (!manifest.catalogs) continue;
        const typeCatalogs = manifest.catalogs.filter(c => c.type === type).slice(0, 5);
        for (const catalog of typeCatalogs) {
          results.push({
            addon: addon.name,
            addonUrl: addon.url,
            id: catalog.id,
            type: catalog.type,
            name: catalog.name || catalog.id,
            extra: catalog.extra || [],
          });
        }
      } catch (e) {
        console.warn('Failed to get catalogs from', addon.url, e);
      }
    }
    return results;
  }

  async getCatalogItems(addonUrl, type, catalogId, extra) {
    let addonPath = `${addonUrl}/catalog/${type}/${catalogId}`;
    if (extra) addonPath += `/${extra}`;
    addonPath += '.json';

    try {
      const resp = await fetch('/api/addon-proxy?url=' + encodeURIComponent(addonPath));
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.metas || []).slice(0, 50);
    } catch {
      return [];
    }
  }

  // ─── Search ──────────────────────────────────────
  // Search always uses addon catalogs (Cinemeta) regardless of mode

  async search(query, type) {
    if (!query || query.length > 200) return [];

    // Try TMDB first (better relevance and fuzzy matching)
    try {
      const params = new URLSearchParams({ q: query });
      if (type) params.set('type', type);
      const resp = await fetch(`/api/search?${params}`);
      if (resp.ok) {
        const data = await resp.json();
        if (data.results && data.results.length > 0) {
          return data.results;
        }
      }
    } catch (e) {
      console.warn('TMDB search failed, falling back to Cinemeta', e);
    }

    // Fallback to Cinemeta addon search
    const allResults = [];
    const types = type ? [type] : ['movie', 'series'];

    for (const addon of this.addons) {
      try {
        const manifest = await this._fetchManifest(addon.url);
        if (!manifest.catalogs) continue;

        for (const catalog of manifest.catalogs) {
          if (!types.includes(catalog.type)) continue;
          const hasSearch = catalog.extra &&
            catalog.extra.some(e => e.name === 'search');
          if (!hasSearch) continue;

          const items = await this.getCatalogItems(
            addon.url, catalog.type, catalog.id,
            `search=${encodeURIComponent(query)}`
          );
          allResults.push(...items);
        }
      } catch (e) {
        console.warn('Search failed for addon', addon.url, e);
      }
    }

    const seen = new Set();
    return allResults.filter(item => {
      const id = item.imdb_id || item.id;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }).slice(0, 100);
  }

  // ─── Metadata ────────────────────────────────────
  // Metadata always comes from addons (Cinemeta) regardless of mode

  async getMeta(type, id) {
    for (const addon of this.addons) {
      try {
        const manifest = await this._fetchManifest(addon.url);
        const resources = manifest.resources || [];
        const hasMeta = resources.includes('meta') ||
          resources.some(r => r.name === 'meta' &&
            (!r.types || r.types.includes(type)));
        if (!hasMeta) continue;

        const resp = await fetch('/api/addon-proxy?url=' + encodeURIComponent(`${addon.url}/meta/${type}/${id}.json`));
        if (!resp.ok) continue;
        const data = await resp.json();
        if (data.meta) {
          // Cache the title for custom mode stream searches (TPB needs name, not IMDB ID)
          this._lastTitle = data.meta.name || null;
          return data.meta;
        }
      } catch (e) {
        console.warn('Meta fetch failed for', addon.url, e);
      }
    }
    return null;
  }

  // ─── Streams ─────────────────────────────────────

  async getStreams(type, id, seasonEpisode) {
    if (this.mode === 'custom') {
      return this._getCustomStreams(type, id, seasonEpisode);
    }
    return this._getStremioStreams(type, id);
  }

  /**
   * Stremio mode: fetch streams from all added addons.
   */
  async _getStremioStreams(type, id) {
    const allStreams = [];
    for (const addon of this.addons) {
      try {
        const manifest = await this._fetchManifest(addon.url);
        const resources = manifest.resources || [];
        const hasStream = resources.includes('stream') ||
          resources.some(r => r.name === 'stream' &&
            (!r.types || r.types.includes(type)));
        if (!hasStream) continue;

        const resp = await fetch('/api/addon-proxy?url=' + encodeURIComponent(`${addon.url}/stream/${type}/${id}.json`));
        if (!resp.ok) continue;
        const data = await resp.json();
        if (data.streams) {
          allStreams.push(...data.streams.slice(0, 50).map(s => ({
            ...s,
            addonName: addon.name,
          })));
        }
      } catch (e) {
        console.warn('Stream fetch failed for', addon.url, e);
      }
    }
    return allStreams;
  }

  /**
   * Custom mode: fetch streams from Torrentio (browser-side) + backend scrapers.
   * Torrentio is called directly from the browser to avoid Jetson DNS issues.
   */
  async _getCustomStreams(type, id, seasonEpisode) {
    const imdbId = id.match(/^tt\d+/) ? id.match(/^(tt\d+)/)[1] : id;

    // Build Torrentio stream ID
    let torrentioId = imdbId;
    if (type === 'series' && seasonEpisode && seasonEpisode.season !== undefined && seasonEpisode.episode !== undefined) {
      torrentioId = `${imdbId}:${seasonEpisode.season}:${seasonEpisode.episode}`;
    }

    // Build backend scraper URL
    let backendUrl;
    const params = new URLSearchParams();
    if (this._lastTitle) params.set('title', this._lastTitle);
    if (type === 'movie') {
      backendUrl = `/api/streams/movie/${imdbId}`;
    } else {
      backendUrl = `/api/streams/series/${imdbId}`;
      if (seasonEpisode && seasonEpisode.season !== undefined) {
        params.set('season', seasonEpisode.season);
        if (seasonEpisode.episode !== undefined) params.set('episode', seasonEpisode.episode);
      }
    }
    const qs = params.toString();
    if (qs) backendUrl += '?' + qs;

    // Fetch Torrentio (browser-side, tries multiple configs) + backend in parallel
    const [torrentioStreams, backendStreams] = await Promise.all([
      this._fetchTorrentioWithFallback(type, torrentioId),
      this._fetchBackendStreams(backendUrl),
    ]);

    // Deduplicate by infoHash, prefer Torrentio
    const seen = new Set();
    const combined = [];
    for (const s of [...torrentioStreams, ...backendStreams]) {
      if (s.infoHash && !seen.has(s.infoHash)) {
        seen.add(s.infoHash);
        combined.push(s);
      }
    }

    // Filter out truly unplayable formats — keep x265/HEVC since server can remux
    return combined.filter(s => {
      const t = s.title || '';
      if (/\.avi\b/i.test(t) || /\bXviD\b/i.test(t) || /\bDivX\b/i.test(t)) return false;
      if (/\.wmv\b/i.test(t)) return false;
      return true;
    });
  }

  /**
   * Try Torrentio with multiple config variations until one returns results.
   */
  async _fetchTorrentioWithFallback(type, torrentioId) {
    for (const config of TORRENTIO_CONFIGS) {
      const url = config
        ? `${TORRENTIO_BASE}/${config}/stream/${type}/${torrentioId}.json`
        : `${TORRENTIO_BASE}/stream/${type}/${torrentioId}.json`;
      const streams = await this._fetchTorrentioStreams(url);
      if (streams.length > 0) {
        console.log(`[Torrentio] Browser: config "${config || '(bare)'}" returned ${streams.length} results`);
        return streams;
      }
    }
    console.warn('[Torrentio] Browser: all configs returned empty');
    return [];
  }

  async _fetchTorrentioStreams(url) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) return [];
      const data = await resp.json();
      if (!data.streams || !Array.isArray(data.streams)) return [];

      return data.streams.map(s => {
        if (!s.infoHash) return null;
        const titleParts = (s.title || '').split('\n');
        const seedMatch = (s.title || '').match(/(?:👤|⬆️|⬆|seeders?|peers?|S)\s*[:：]?\s*(\d+)/i);
        const seeds = seedMatch ? parseInt(seedMatch[1], 10) : 0;
        const sizeMatch = (s.title || '').match(/([\d.]+\s*(?:GB|MB))/i);
        const qualityMatch = (s.title || '').match(/\b(2160p|1080p|720p|480p)\b/i);

        const trackerParams = MAGNET_TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');
        return {
          infoHash: s.infoHash.toLowerCase(),
          title: s.title || s.name || 'Unknown',
          name: s.name || 'Torrentio',
          magnetUri: `magnet:?xt=urn:btih:${s.infoHash}${trackerParams}`,
          quality: qualityMatch ? qualityMatch[1] : '',
          size: sizeMatch ? sizeMatch[1] : '',
          seeds,
          fileIdx: s.fileIdx,
          source: 'Torrentio',
          addonName: 'Torrentio',
          _customMode: true,
        };
      }).filter(Boolean);
    } catch (e) {
      console.warn('Torrentio fetch failed:', e);
      return [];
    }
  }

  async _fetchBackendStreams(url) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.streams || []).map(s => ({
        ...s,
        addonName: s.source || 'Custom',
        _customMode: true,
      }));
    } catch (e) {
      console.warn('Backend stream fetch failed:', e);
      return [];
    }
  }

  // ─── Playback URL Resolution ─────────────────────

  getPlaybackUrl(stream) {
    // Custom mode: use local streaming endpoint
    if (stream._customMode && stream.infoHash) {
      if (!/^[0-9a-f]{40}$/i.test(stream.infoHash)) return null;
      // Use remux endpoint for MKV and x265/HEVC streams (FFmpeg remuxes to fragmented MP4)
      const title = stream.title || '';
      const isHEVC = /\bx265\b/i.test(title) || /\bH\.?265\b/i.test(title) || /\bHEVC\b/i.test(title);
      const needsRemux = stream.format === 'MKV' || stream.needsRemux || isHEVC;
      let url = needsRemux
        ? `/api/play/${stream.infoHash}/remux`
        : `/api/play/${stream.infoHash}`;
      const params = new URLSearchParams();
      if (stream.fileIdx !== undefined) {
        params.set('fileIdx', stream.fileIdx);
      }
      if (stream.magnetUri) {
        params.set('magnet', stream.magnetUri);
      }
      const qs = params.toString();
      return qs ? url + '?' + qs : url;
    }

    if (stream.url) {
      try {
        const u = new URL(stream.url);
        if (!['http:', 'https:'].includes(u.protocol)) return null;
        return stream.url;
      } catch { return null; }
    }

    if (stream.infoHash) {
      // Validate infoHash is a hex string
      if (!/^[0-9a-f]{40}$/i.test(stream.infoHash)) return null;

      const server = this.serverUrl || '/stremio-api';
      let url = `${server}/hlsv2/${stream.infoHash}`;
      if (stream.fileIdx !== undefined) {
        const idx = parseInt(stream.fileIdx, 10);
        if (isNaN(idx) || idx < 0) return null;
        url += `/${idx}`;
      }
      return url + '/master.m3u8';
    }

    if (stream.ytId) {
      if (!/^[a-zA-Z0-9_-]{11}$/.test(stream.ytId)) return null;
      return `https://www.youtube.com/watch?v=${stream.ytId}`;
    }

    if (stream.externalUrl) {
      try {
        const u = new URL(stream.externalUrl);
        if (!['http:', 'https:'].includes(u.protocol)) return null;
        return stream.externalUrl;
      } catch { return null; }
    }

    return null;
  }

  // ─── Stream Speed Testing ────────────────────────

  async _testStreamSpeed(stream, timeoutMs, signal) {
    timeoutMs = timeoutMs || 8000;
    const url = this.getPlaybackUrl(stream);
    if (!url) return { stream, responseTime: Infinity, error: 'No URL' };

    if (stream.ytId || stream.externalUrl) {
      return { stream, responseTime: Infinity, error: 'External' };
    }

    // In custom mode, skip speed testing — rank by seeds instead
    if (stream._customMode) {
      const seeds = stream.seeds || 0;
      // Simulate response time inversely proportional to seeds
      const fakeTime = seeds > 0 ? Math.max(50, 5000 / seeds) : 9999;
      return { stream, responseTime: fakeTime };
    }

    const start = performance.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      // Respect parent signal
      if (signal) {
        signal.addEventListener('abort', () => controller.abort(), { once: true });
      }

      const resp = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) {
        // Fallback: GET with range
        const start2 = performance.now();
        const c2 = new AbortController();
        const t2 = setTimeout(() => c2.abort(), timeoutMs);
        if (signal) signal.addEventListener('abort', () => c2.abort(), { once: true });

        const r2 = await fetch(url, {
          method: 'GET',
          headers: { 'Range': 'bytes=0-1023' },
          signal: c2.signal,
        });
        clearTimeout(t2);
        if (r2.body) { const reader = r2.body.getReader(); await reader.read(); reader.cancel(); }
        return { stream, responseTime: performance.now() - start2 };
      }

      return { stream, responseTime: performance.now() - start };
    } catch (e) {
      // Fallback GET on HEAD failure
      try {
        const start2 = performance.now();
        const c2 = new AbortController();
        const t2 = setTimeout(() => c2.abort(), timeoutMs);
        if (signal) signal.addEventListener('abort', () => c2.abort(), { once: true });

        const r = await fetch(url, {
          method: 'GET',
          headers: { 'Range': 'bytes=0-1023' },
          signal: c2.signal,
        });
        clearTimeout(t2);
        if (r.body) { const reader = r.body.getReader(); await reader.read(); reader.cancel(); }
        return { stream, responseTime: performance.now() - start2 };
      } catch {
        return { stream, responseTime: Infinity, error: 'Timeout' };
      }
    }
  }

  async testAndRankStreams(streams, onProgress) {
    // Cancel any in-progress test
    if (this._speedTestController) {
      this._speedTestController.abort();
    }
    this._speedTestController = new AbortController();
    const signal = this._speedTestController.signal;

    let tested = 0;
    const total = streams.length;

    const promises = streams.map(async (stream) => {
      const result = await this._testStreamSpeed(stream, 8000, signal);
      tested++;
      if (onProgress) onProgress(tested, total, result);
      return result;
    });

    const results = await Promise.all(promises);
    results.sort((a, b) => a.responseTime - b.responseTime);
    return results;
  }

  async getStreamsRanked(type, id, onProgress, seasonEpisode) {
    const streams = await this.getStreams(type, id, seasonEpisode);
    if (streams.length === 0) return { streams: [], bestStream: null };

    const ranked = await this.testAndRankStreams(streams, onProgress);
    const best = ranked.find(r => r.responseTime < Infinity) || null;

    return {
      streams: ranked,
      bestStream: best ? best.stream : null,
    };
  }
  // ─── Live TV / IPTV ──────────────────────────────

  // Known Stremio TV addons that users can quick-add
  static KNOWN_TV_ADDONS = [
    {
      url: 'https://848b3516657c-usatv.baby-beamup.club',
      name: 'USA TV',
      description: 'US live TV — news, sports, entertainment (180+ channels)',
    },
    {
      url: 'https://7a82163c306e-livetv.baby-beamup.club',
      name: 'Live TV',
      description: 'International live TV channels',
    },
    {
      url: 'https://stremio-iptv-org.vercel.app',
      name: 'IPTV-org',
      description: 'Community IPTV — 8000+ channels worldwide',
    },
  ];

  // Default source added on first launch
  static DEFAULT_TV_SOURCE = {
    type: 'stremio-tv',
    url: 'https://848b3516657c-usatv.baby-beamup.club',
    name: 'USA TV',
    enabled: true,
  };

  // ─── Legacy single-playlist support (migration) ──

  getPlaylistUrl() {
    return localStorage.getItem('iptv_playlist_url') || '';
  }

  setPlaylistUrl(url) {
    localStorage.setItem('iptv_playlist_url', url);
  }

  // ─── Multi-source Live TV management ─────────────

  _loadLiveTVSources() {
    try {
      const saved = localStorage.getItem('livetv_sources');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      localStorage.removeItem('livetv_sources');
    }

    // Migrate from legacy single playlist URL
    const legacyUrl = this.getPlaylistUrl();
    if (legacyUrl) {
      const sources = [{ type: 'playlist', url: legacyUrl, name: 'My Playlist', enabled: true }];
      this._saveLiveTVSources(sources);
      return sources;
    }

    // First launch — add default TV source
    const defaults = [{ ...StremioAPI.DEFAULT_TV_SOURCE }];
    this._saveLiveTVSources(defaults);
    return defaults;
  }

  _saveLiveTVSources(sources) {
    localStorage.setItem('livetv_sources', JSON.stringify(sources));
  }

  getLiveTVSources() {
    return this._loadLiveTVSources();
  }

  addLiveTVSource(source) {
    const sources = this._loadLiveTVSources();
    // Prevent duplicates by URL
    if (sources.find(s => s.url === source.url)) {
      return { error: 'Source already added' };
    }
    sources.push({ ...source, enabled: true });
    this._saveLiveTVSources(sources);
    // Also keep legacy field in sync for first playlist
    if (source.type === 'playlist') {
      const firstPlaylist = sources.find(s => s.type === 'playlist' && s.enabled);
      if (firstPlaylist) this.setPlaylistUrl(firstPlaylist.url);
    }
    return { ok: true };
  }

  removeLiveTVSource(url) {
    const sources = this._loadLiveTVSources().filter(s => s.url !== url);
    this._saveLiveTVSources(sources);
  }

  toggleLiveTVSource(url, enabled) {
    const sources = this._loadLiveTVSources();
    const source = sources.find(s => s.url === url);
    if (source) {
      source.enabled = enabled;
      this._saveLiveTVSources(sources);
    }
  }

  /**
   * Fetch channels from ALL enabled live TV sources.
   * Returns an array of { sourceName, channels[] } groups.
   */
  async getAllLiveTVChannels() {
    const sources = this._loadLiveTVSources().filter(s => s.enabled);
    if (sources.length === 0) return [];

    const results = await Promise.all(sources.map(async (source) => {
      try {
        if (source.type === 'playlist') {
          return { sourceName: source.name || 'Playlist', channels: await this._fetchPlaylistChannels(source.url) };
        } else if (source.type === 'stremio-tv') {
          return { sourceName: source.name || 'TV Addon', channels: await this._fetchStremioTVChannels(source.url) };
        }
      } catch (e) {
        console.warn('[LiveTV] Failed to fetch from', source.url, e);
      }
      return { sourceName: source.name || 'Unknown', channels: [] };
    }));

    return results.filter(r => r.channels.length > 0);
  }

  async _fetchPlaylistChannels(playlistUrl) {
    const resp = await fetch('/api/iptv/channels?url=' + encodeURIComponent(playlistUrl));
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.channels || []).map(ch => ({
      ...ch,
      _sourceType: 'playlist',
    }));
  }

  async _fetchStremioTVChannels(addonUrl) {
    try {
      // Fetch the addon manifest to discover TV catalogs
      const manifest = await this._fetchManifest(addonUrl);
      if (!manifest.catalogs) return [];

      const tvCatalogs = manifest.catalogs.filter(c => c.type === 'tv');
      if (tvCatalogs.length === 0) return [];

      const allChannels = [];
      for (const catalog of tvCatalogs.slice(0, 5)) {
        try {
          const resp = await fetch('/api/addon-proxy?url=' + encodeURIComponent(`${addonUrl}/catalog/tv/${catalog.id}.json`));
          if (!resp.ok) continue;
          const data = await resp.json();
          const metas = data.metas || [];
          for (const meta of metas) {
            allChannels.push({
              id: meta.id || '',
              name: meta.name || 'Channel',
              logo: meta.logo || meta.poster || '',
              group: catalog.name || '',
              _sourceType: 'stremio-tv',
              _addonUrl: addonUrl,
              _stremioId: meta.id,
            });
          }
        } catch (e) {
          console.warn('[LiveTV] Catalog fetch failed:', catalog.id, e);
        }
      }
      return allChannels;
    } catch (e) {
      console.warn('[LiveTV] Manifest fetch failed:', addonUrl, e);
      return [];
    }
  }

  /**
   * Get the playable stream URL for a channel.
   * For playlists, proxy through IPTV endpoint.
   * For Stremio TV addons, fetch stream from addon then proxy.
   */
  async getChannelStreamUrl(channel) {
    if (!channel) return null;

    // Playlist-based channel — direct proxy
    if (channel._sourceType === 'playlist' || (!channel._sourceType && channel.url)) {
      if (!channel.url) return null;
      return '/api/iptv/stream?url=' + encodeURIComponent(channel.url);
    }

    // Stremio TV addon — fetch stream URL from addon, then proxy
    if (channel._sourceType === 'stremio-tv' && channel._addonUrl && channel._stremioId) {
      try {
        const streamUrl = `${channel._addonUrl}/stream/tv/${encodeURIComponent(channel._stremioId)}.json`;
        const resp = await fetch('/api/addon-proxy?url=' + encodeURIComponent(streamUrl));
        if (!resp.ok) return null;
        const data = await resp.json();
        const streams = data.streams || [];
        if (streams.length === 0) return null;

        // Pick the first stream with a URL
        const stream = streams.find(s => s.url) || streams[0];
        if (stream.url) {
          return '/api/iptv/stream?url=' + encodeURIComponent(stream.url);
        }
        if (stream.externalUrl) {
          return stream.externalUrl;
        }
      } catch (e) {
        console.warn('[LiveTV] Stream fetch failed for', channel.name, e);
      }
      return null;
    }

    return null;
  }

  /**
   * Legacy compatibility — returns flat channel list from all sources.
   */
  async getChannels() {
    const groups = await this.getAllLiveTVChannels();
    const flat = [];
    for (const group of groups) {
      flat.push(...group.channels);
    }
    return flat;
  }
}

window.api = new StremioAPI();
