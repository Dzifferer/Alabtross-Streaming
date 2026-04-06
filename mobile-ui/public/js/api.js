/**
 * Alabtross Mobile — Stremio API Layer
 *
 * Supports two modes:
 *   - "stremio" : Original behavior — addons + Stremio server for streams
 *   - "custom"  : Direct torrent sources (YTS/EZTV/1337x) + local WebTorrent engine
 */

const CINEMETA_URL = 'https://v3-cinemeta.strem.io';

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

    const resp = await fetch(addonUrl + '/manifest.json');
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
    let url = `${addonUrl}/catalog/${type}/${catalogId}`;
    if (extra) url += `/${extra}`;
    url += '.json';

    try {
      const resp = await fetch(url);
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

        const resp = await fetch(`${addon.url}/meta/${type}/${id}.json`);
        if (!resp.ok) continue;
        const data = await resp.json();
        if (data.meta) return data.meta;
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

        const resp = await fetch(`${addon.url}/stream/${type}/${id}.json`);
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
   * Custom mode: fetch streams from our backend scrapers.
   */
  async _getCustomStreams(type, id, seasonEpisode) {
    // Extract IMDB ID from the content ID
    const imdbId = id.match(/^tt\d+/) ? id.match(/^(tt\d+)/)[1] : id;

    let url;
    if (type === 'movie') {
      url = `/api/streams/movie/${imdbId}`;
    } else {
      url = `/api/streams/series/${imdbId}`;
      // If seasonEpisode provided (e.g. from episode click), append query params
      if (seasonEpisode && seasonEpisode.season !== undefined) {
        const params = new URLSearchParams();
        params.set('season', seasonEpisode.season);
        if (seasonEpisode.episode !== undefined) params.set('episode', seasonEpisode.episode);
        url += '?' + params.toString();
      }
    }

    try {
      const resp = await fetch(url);
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.streams || []).map(s => ({
        ...s,
        addonName: s.source || 'Custom',
        // In custom mode, streams have magnetUri and infoHash
        _customMode: true,
      }));
    } catch (e) {
      console.warn('Custom stream fetch failed:', e);
      return [];
    }
  }

  // ─── Playback URL Resolution ─────────────────────

  getPlaybackUrl(stream) {
    // Custom mode: use local streaming endpoint
    if (stream._customMode && stream.infoHash) {
      if (!/^[0-9a-f]{40}$/i.test(stream.infoHash)) return null;
      let url = `/api/play/${stream.infoHash}`;
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
}

window.api = new StremioAPI();
