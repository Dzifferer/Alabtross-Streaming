/**
 * Albatross Mobile — Streaming API Layer
 *
 * Unified mode: fetches streams from both direct torrent scrapers (YTS/EZTV/1337x)
 * and configured Stremio addons, merged into a single list.
 */

const CINEMETA_URL = 'https://v3-cinemeta.strem.io';

// Torrentio is now fetched server-side via the backend /api/streams/* endpoints
// to avoid browser DNS resolution issues with torrentio.strem.io.

class StremioAPI {
  constructor() {
    this.addons = this._loadAddons();
    this._manifestCache = new Map();
    this._cacheTimestamps = new Map();
    this._speedTestInProgress = false;
    this._speedTestController = null;
    this._searchController = null;
    this._searchCache = new Map();
    this._searchCacheTimestamps = new Map();
    this._streamCache = new Map();
    this._streamCacheTimestamps = new Map();
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

  // ─── Manifest Fetching (with TTL cache) ──────────

  async _fetchManifest(addonUrl) {
    const now = Date.now();
    const cached = this._manifestCache.get(addonUrl);
    const ts = this._cacheTimestamps.get(addonUrl) || 0;

    // Cache for 5 minutes
    if (cached && (now - ts) < 300000) {
      return cached;
    }

    const resp = await fetch('/api/addon-proxy?url=' + encodeURIComponent(addonUrl + '/manifest.json'), {
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    this._manifestCache.set(addonUrl, data);
    this._cacheTimestamps.set(addonUrl, now);
    return data;
  }

  // ─── Catalogs ────────────────────────────────────

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
      const resp = await fetch('/api/addon-proxy?url=' + encodeURIComponent(addonPath), {
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.metas || []).slice(0, 50);
    } catch {
      return [];
    }
  }

  // ─── Search ──────────────────────────────────────

  async search(query, type) {
    if (!query || query.length > 200) return [];

    // Abort any in-flight search request
    if (this._searchController) this._searchController.abort();
    this._searchController = new AbortController();
    const signal = this._searchController.signal;

    // Check cache (60-second TTL)
    const cacheKey = `${query}:${type || ''}`;
    const cachedTs = this._searchCacheTimestamps.get(cacheKey) || 0;
    if (this._searchCache.has(cacheKey) && (Date.now() - cachedTs) < 60000) {
      return this._searchCache.get(cacheKey);
    }

    let results;

    // Try TMDB first (better relevance and fuzzy matching)
    try {
      const params = new URLSearchParams({ q: query });
      if (type) params.set('type', type);
      const resp = await fetch(`/api/search?${params}`, { signal });
      if (resp.ok) {
        const data = await resp.json();
        if (data.results && data.results.length > 0) {
          results = data.results;
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') return [];
      console.warn('TMDB search failed, falling back to Cinemeta', e);
    }

    // Fallback to Cinemeta addon search (parallel across all addons)
    if (!results) {
      const types = type ? [type] : ['movie', 'series'];
      const searchPromises = [];

      for (const addon of this.addons) {
        searchPromises.push((async () => {
          try {
            const manifest = await this._fetchManifest(addon.url);
            if (!manifest.catalogs) return [];

            const catalogPromises = [];
            for (const catalog of manifest.catalogs) {
              if (!types.includes(catalog.type)) continue;
              const hasSearch = catalog.extra &&
                catalog.extra.some(e => e.name === 'search');
              if (!hasSearch) continue;

              catalogPromises.push(
                this.getCatalogItems(
                  addon.url, catalog.type, catalog.id,
                  `search=${encodeURIComponent(query)}`
                )
              );
            }
            const catalogResults = await Promise.all(catalogPromises);
            return catalogResults.flat();
          } catch (e) {
            console.warn('Search failed for addon', addon.url, e);
            return [];
          }
        })());
      }

      if (signal.aborted) return [];

      const allResultArrays = await Promise.all(searchPromises);
      const allResults = allResultArrays.flat();

      const seen = new Set();
      results = allResults.filter(item => {
        const id = item.imdb_id || item.id;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      }).slice(0, 100);
    }

    // Cache the results
    this._searchCache.set(cacheKey, results);
    this._searchCacheTimestamps.set(cacheKey, Date.now());

    return results;
  }

  // ─── Metadata ────────────────────────────────────

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
          // Cache the title for stream searches (TPB needs name, not IMDB ID)
          this._lastTitle = data.meta.name || null;
          return data.meta;
        }
      } catch (e) {
        console.warn('Meta fetch failed for', addon.url, e);
      }
    }

    // Fallback: fetch metadata directly from TMDB for tmdb: IDs
    if (id.startsWith('tmdb:')) {
      try {
        const tmdbId = id.replace('tmdb:', '');
        const resp = await fetch(`/api/tmdb-meta/${type}/${tmdbId}`);
        if (resp.ok) {
          const data = await resp.json();
          if (data.meta) {
            this._lastTitle = data.meta.name || null;
            // If TMDB resolved an IMDB ID, update the ID for stream lookups
            if (data.meta.imdb_id) {
              data.meta._resolvedImdbId = data.meta.imdb_id;
            }
            return data.meta;
          }
        }
      } catch (e) {
        console.warn('TMDB meta fallback failed:', e);
      }
    }

    return null;
  }

  // ─── Streams ─────────────────────────────────────

  /**
   * Fetch streams from both backend scrapers and configured Stremio addons,
   * then merge and deduplicate into a single list.
   */
  async getStreams(type, id, seasonEpisode) {
    const cacheKey = `${type}:${id}:${seasonEpisode?.season}:${seasonEpisode?.episode}`;
    const cachedTs = this._streamCacheTimestamps.get(cacheKey) || 0;
    if (this._streamCache.has(cacheKey) && (Date.now() - cachedTs) < 300000) {
      return this._streamCache.get(cacheKey);
    }

    const [custom, addon] = await Promise.all([
      this._getCustomStreams(type, id, seasonEpisode),
      this._getAddonStreams(type, id).catch(() => []),
    ]);
    const merged = this._mergeStreams(custom, addon);
    if (merged.length > 0) {
      this._streamCache.set(cacheKey, merged);
      this._streamCacheTimestamps.set(cacheKey, Date.now());
    }
    return merged;
  }

  /**
   * Fetch streams from configured Stremio addons, tagged for local playback.
   */
  async _getAddonStreams(type, id) {
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
          allStreams.push(...data.streams.slice(0, 50).map(s => {
            // Extract seed count from title if present (e.g. "👤 45")
            let seeds = 0;
            const seedMatch = (s.title || '').match(/👤\s*(\d+)/);
            if (seedMatch) seeds = parseInt(seedMatch[1], 10);
            return {
              ...s,
              _customMode: true,
              seeds: seeds || s.seeds || 0,
              source: addon.name,
              addonName: addon.name,
            };
          }));
        }
      } catch (e) {
        console.warn('Stream fetch failed for', addon.url, e);
      }
    }
    return allStreams;
  }

  /**
   * Merge scraped and addon streams, deduplicating by infoHash.
   * Scraped streams take priority over addon duplicates.
   */
  _mergeStreams(custom, addon) {
    const seen = new Set();
    const merged = [];

    // Custom (scraped) streams first — they have richer metadata
    for (const s of custom) {
      if (s.infoHash) seen.add(s.infoHash.toLowerCase());
      merged.push(s);
    }

    // Add unique addon streams
    for (const s of addon) {
      if (s.infoHash && seen.has(s.infoHash.toLowerCase())) continue;
      if (s.infoHash) seen.add(s.infoHash.toLowerCase());
      merged.push(s);
    }

    return merged;
  }

  /**
   * Fetch streams from the backend, which queries Torrentio + scrapers server-side.
   */
  async _getCustomStreams(type, id, seasonEpisode) {
    const imdbId = id.match(/^tt\d+/) ? id.match(/^(tt\d+)/)[1] : id;

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
        if (seasonEpisode.absoluteEpisode !== undefined) params.set('absEp', seasonEpisode.absoluteEpisode);
        if (seasonEpisode.genres && seasonEpisode.genres.length > 0) params.set('genres', seasonEpisode.genres.join(','));
      }
    }
    const qs = params.toString();
    if (qs) backendUrl += '?' + qs;

    const streams = await this._fetchBackendStreams(backendUrl);

    // Filter out truly unplayable formats — keep x265/HEVC since server can remux
    const filtered = streams.filter(s => {
      const t = s.title || '';
      if (/\.avi\b/i.test(t) || /\bXviD\b/i.test(t) || /\bDivX\b/i.test(t)) return false;
      if (/\.wmv\b/i.test(t)) return false;
      return true;
    });

    return this._narrowStreams(filtered);
  }

  /**
   * Narrow streams to the best ~6 options by scoring quality, format, seeds, and size.
   * Reduces cognitive load and makes preload hit rate high.
   */
  _narrowStreams(streams) {
    const qualityScore = { '2160p': 4, '4K': 4, '1080p': 3, '720p': 2, '480p': 1 };
    const formatScore = { 'MP4': 2, 'WebM': 2, 'MKV': 1 };

    const scored = streams
      .filter(s => (s.seeds || 0) >= 3) // drop dead torrents
      .map(s => {
        const title = s.title || '';
        // Detect quality from title
        const qMatch = title.match(/\b(4K|2160p|1080p|720p|480p)\b/i);
        const q = qMatch ? (qualityScore[qMatch[1].toUpperCase()] || 0) : 0;
        const f = formatScore[s.format] || 0;
        const seeds = s.seeds || 0;
        const seedScore = Math.min(Math.log10(seeds + 1) * 2, 4);
        // Penalise very large files (slow to buffer)
        const sizeVal = parseFloat(s.size);
        const sizePenalty = (sizeVal > 5 && /GB/i.test(s.size || '')) ? -1 : 0;
        const qualityKey = qMatch ? qMatch[1].toUpperCase() : 'unknown';
        return { ...s, _score: q + f + seedScore + sizePenalty, _qualityKey: qualityKey };
      })
      .sort((a, b) => b._score - a._score);

    if (scored.length === 0) return streams.slice(0, 6); // fallback if all <3 seeds

    // Keep best per quality tier so user has resolution choice
    const bestPerQuality = new Map();
    for (const s of scored) {
      if (!bestPerQuality.has(s._qualityKey)) bestPerQuality.set(s._qualityKey, s);
    }

    // Merge top-3 by score + best-per-quality, dedup by infoHash
    const top3 = scored.slice(0, 3);
    const merged = new Map();
    for (const s of [...top3, ...bestPerQuality.values()]) {
      if (s.infoHash && !merged.has(s.infoHash)) merged.set(s.infoHash, s);
      else if (!s.infoHash) merged.set(Math.random(), s);
    }

    const result = [...merged.values()].slice(0, 6);
    // Clean up internal scoring fields
    return result.map(({ _score, _qualityKey, ...rest }) => rest);
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
    // All infoHash streams use local remux endpoint for browser-compatible audio.
    // FFmpeg copies video (-c:v copy) and transcodes audio to AAC — lightweight.
    if (stream.infoHash) {
      if (!/^[0-9a-f]{40}$/i.test(stream.infoHash)) return null;
      let url = `/api/play/${stream.infoHash}/remux`;
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

    // Torrent streams: rank by seeds instead of speed testing
    if (stream.infoHash) {
      const seeds = stream.seeds || 0;
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
    const concurrency = 5;
    const results = [];
    let nextIdx = 0;

    async function runNext(self) {
      while (nextIdx < total) {
        const i = nextIdx++;
        const result = await self._testStreamSpeed(streams[i], 8000, signal);
        result.index = i;
        results.push(result);
        tested++;
        if (onProgress) onProgress(tested, total, result);
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, total) }, () => runNext(this));
    await Promise.all(workers);
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
      url: 'https://stremio-iptv-org.vercel.app',
      name: 'IPTV-org',
      description: 'Community IPTV — 8000+ channels worldwide',
    },
    {
      url: 'https://7a82163c306e-livetv.baby-beamup.club',
      name: 'Live TV',
      description: 'International live TV channels',
    },
    {
      url: 'https://848b3516657c-usatv.baby-beamup.club',
      name: 'USA TV',
      description: 'US live TV — news, sports, entertainment (180+ channels)',
    },
  ];

  // Default source added on first launch
  static DEFAULT_TV_SOURCE = {
    type: 'stremio-tv',
    url: 'https://stremio-iptv-org.vercel.app',
    name: 'IPTV-org',
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
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
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

    // First launch or empty — add default TV source
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
          const resp = await fetch('/api/addon-proxy?url=' + encodeURIComponent(`${addonUrl}/catalog/tv/${catalog.id}.json`), {
            signal: AbortSignal.timeout(8000),
          });
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

  // ─── Live TV Search ────────────────────────────────

  /**
   * Search Live TV channels across all enabled sources.
   * Queries M3U playlists (server-side filter) and Stremio TV addon search extras in parallel.
   * Returns flat array of channel objects, max 50 results.
   */
  async searchLiveTVChannels(query) {
    if (!query || query.length < 2) return [];
    const sources = this._loadLiveTVSources().filter(s => s.enabled);
    if (sources.length === 0) return [];

    const results = await Promise.allSettled(sources.map(async (source) => {
      if (source.type === 'playlist') {
        return this._searchPlaylistChannels(source.url, query);
      } else if (source.type === 'stremio-tv') {
        return this._searchStremioTVChannels(source.url, query);
      }
      return [];
    }));

    const all = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        all.push(...r.value);
      }
    }
    return all.slice(0, 50);
  }

  async _searchPlaylistChannels(playlistUrl, query) {
    try {
      const resp = await fetch(
        '/api/iptv/channels?url=' + encodeURIComponent(playlistUrl) +
        '&search=' + encodeURIComponent(query) + '&limit=30',
        { signal: AbortSignal.timeout(6000) }
      );
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.channels || []).map(ch => ({ ...ch, _sourceType: 'playlist' }));
    } catch {
      return [];
    }
  }

  async _searchStremioTVChannels(addonUrl, query) {
    try {
      const manifest = await this._fetchManifest(addonUrl);
      if (!manifest.catalogs) return [];

      const tvCatalogs = manifest.catalogs.filter(c => c.type === 'tv');
      const searchable = tvCatalogs.filter(c =>
        c.extra && c.extra.some(e => e.name === 'search')
      );

      if (searchable.length === 0) {
        // Addon doesn't support search — fall back to client-side filter of cached channels
        return this._filterCachedStremioChannels(addonUrl, query);
      }

      // Query search-capable catalogs
      const channelResults = [];
      for (const catalog of searchable.slice(0, 3)) {
        try {
          const searchPath = `${addonUrl}/catalog/tv/${catalog.id}/search=${encodeURIComponent(query)}.json`;
          const resp = await fetch('/api/addon-proxy?url=' + encodeURIComponent(searchPath), {
            signal: AbortSignal.timeout(6000),
          });
          if (!resp.ok) continue;
          const data = await resp.json();
          for (const meta of (data.metas || [])) {
            channelResults.push({
              id: meta.id || '',
              name: meta.name || 'Channel',
              logo: meta.logo || meta.poster || '',
              group: catalog.name || '',
              _sourceType: 'stremio-tv',
              _addonUrl: addonUrl,
              _stremioId: meta.id,
            });
          }
        } catch { /* skip failed catalog */ }
      }
      return channelResults;
    } catch {
      return [];
    }
  }

  /**
   * Client-side filter of previously-fetched Stremio TV channels (for addons without search extra).
   * Uses the last fetched channel list from getAllLiveTVChannels if available.
   */
  async _filterCachedStremioChannels(addonUrl, query) {
    try {
      // Re-fetch channels (they're manifest-cached so this is fast)
      const channels = await this._fetchStremioTVChannels(addonUrl);
      const lc = query.toLowerCase();
      return channels.filter(ch =>
        ch.name.toLowerCase().includes(lc) ||
        ch.group.toLowerCase().includes(lc)
      ).slice(0, 30);
    } catch {
      return [];
    }
  }

  /**
   * Get available channel groups from a playlist source.
   */
  async getPlaylistGroups(playlistUrl) {
    try {
      const resp = await fetch(
        '/api/iptv/channels?url=' + encodeURIComponent(playlistUrl) + '&groups=1&limit=1',
        { signal: AbortSignal.timeout(6000) }
      );
      if (!resp.ok) return [];
      const data = await resp.json();
      return data.groups || [];
    } catch {
      return [];
    }
  }

  /**
   * Get channels from a playlist filtered by group.
   */
  async getPlaylistChannelsByGroup(playlistUrl, group) {
    try {
      const resp = await fetch(
        '/api/iptv/channels?url=' + encodeURIComponent(playlistUrl) +
        '&group=' + encodeURIComponent(group) + '&limit=100',
        { signal: AbortSignal.timeout(6000) }
      );
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.channels || []).map(ch => ({ ...ch, _sourceType: 'playlist' }));
    } catch {
      return [];
    }
  }
  // ─── Collection / Franchise Grouping ──────────────

  /**
   * Enrich a list of movies with collection/franchise info.
   * @param {string[]} imdbIds - IMDB IDs
   * @param {string[]} [names] - Movie names (for title-based fallback)
   * Returns { collections: { "collectionId": { name, poster, movieIds: [imdbIds] } } }
   */
  async enrichWithCollections(imdbIds, names) {
    const validIds = imdbIds.filter(id => /^tt\d+$/.test(id));
    if (validIds.length === 0) return { collections: {} };
    try {
      let url = '/api/collections/enrich?ids=' + validIds.join(',');
      if (names && names.length > 0) {
        url += '&names=' + encodeURIComponent(names.join('||'));
      }
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) return { collections: {} };
      return resp.json();
    } catch {
      return { collections: {} };
    }
  }

  /**
   * Get full details of a collection (all movies with IMDB IDs, posters, years).
   * Returns { name, poster, movies: [{ imdb_id, name, year, poster }] }
   */
  async getCollectionMovies(collectionId) {
    try {
      const resp = await fetch(`/api/collections/${collectionId}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) return null;
      return resp.json();
    } catch {
      return null;
    }
  }
}

window.api = new StremioAPI();
