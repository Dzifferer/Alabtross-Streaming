/**
 * Alabtross Mobile — Stremio API Layer
 *
 * Handles communication with:
 * - Stremio addons (Cinemeta for metadata, Torrentio for streams, etc.)
 * - Local Stremio streaming server (for actual playback URLs)
 */

const CINEMETA_URL = 'https://v3-cinemeta.strem.io';
const TORRENTIO_URL = 'https://torrentio.strem.io';

class StremioAPI {
  constructor() {
    this.addons = this._loadAddons();
    this.serverUrl = localStorage.getItem('stremio_server') || '';
    this._manifestCache = new Map();
  }

  // ─── Addon Management ────────────────────────────

  _loadAddons() {
    const saved = localStorage.getItem('stremio_addons');
    if (saved) return JSON.parse(saved);
    // Default addons
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
    url = url.replace(/\/manifest\.json$/, '').replace(/\/$/, '');
    // Check if already added
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
      return { error: 'Failed to load addon manifest: ' + e.message };
    }
  }

  removeAddon(url) {
    const updated = this.addons.filter(a => a.url !== url);
    this._saveAddons(updated);
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
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ─── Manifest Fetching ───────────────────────────

  async _fetchManifest(addonUrl) {
    if (this._manifestCache.has(addonUrl)) {
      return this._manifestCache.get(addonUrl);
    }
    const resp = await fetch(addonUrl + '/manifest.json');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    this._manifestCache.set(addonUrl, data);
    return data;
  }

  // ─── Catalogs ────────────────────────────────────

  async getCatalogs(type) {
    const results = [];

    for (const addon of this.addons) {
      try {
        const manifest = await this._fetchManifest(addon.url);
        if (!manifest.catalogs) continue;

        const typeCatalogs = manifest.catalogs.filter(c => c.type === type);
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
      return data.metas || [];
    } catch (e) {
      console.warn('Failed to fetch catalog', url, e);
      return [];
    }
  }

  // ─── Search ──────────────────────────────────────

  async search(query, type) {
    const allResults = [];
    const types = type ? [type] : ['movie', 'series'];

    for (const addon of this.addons) {
      try {
        const manifest = await this._fetchManifest(addon.url);
        if (!manifest.catalogs) continue;

        for (const catalog of manifest.catalogs) {
          if (!types.includes(catalog.type)) continue;

          // Check if this catalog supports search
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

    // Deduplicate by imdb_id
    const seen = new Set();
    return allResults.filter(item => {
      const id = item.imdb_id || item.id;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
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

  async getStreams(type, id) {
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
          allStreams.push(...data.streams.map(s => ({
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

  // ─── Playback URL Resolution ─────────────────────

  getPlaybackUrl(stream) {
    // Direct HTTP URL
    if (stream.url) return stream.url;

    // Torrent/infoHash — route through local Stremio server
    if (stream.infoHash) {
      const server = this.serverUrl || '/stremio-api';
      let url = `${server}/hlsv2/${stream.infoHash}`;
      if (stream.fileIdx !== undefined) {
        url += `/${stream.fileIdx}`;
      }
      // Return master.m3u8 for HLS playback
      return url + '/master.m3u8';
    }

    // YouTube
    if (stream.ytId) {
      return `https://www.youtube.com/watch?v=${stream.ytId}`;
    }

    // External URL (open in new tab)
    if (stream.externalUrl) return stream.externalUrl;

    return null;
  }

  // ─── Stream Speed Testing ────────────────────────

  /**
   * Tests the response speed of a stream by measuring how quickly we get
   * the first bytes back. Returns time in ms, or Infinity on failure.
   */
  async _testStreamSpeed(stream, timeoutMs = 8000) {
    const url = this.getPlaybackUrl(stream);
    if (!url) return { stream, responseTime: Infinity, error: 'No URL' };

    // Skip external URLs (YouTube etc) — we can't meaningfully test these
    if (stream.ytId || stream.externalUrl) {
      return { stream, responseTime: Infinity, error: 'External' };
    }

    const start = performance.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const resp = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        mode: 'cors',
      });
      clearTimeout(timer);

      const elapsed = performance.now() - start;

      if (!resp.ok) {
        // Try GET with range header as fallback (some servers don't support HEAD)
        const start2 = performance.now();
        const controller2 = new AbortController();
        const timer2 = setTimeout(() => controller2.abort(), timeoutMs);

        const resp2 = await fetch(url, {
          method: 'GET',
          headers: { 'Range': 'bytes=0-1023' },
          signal: controller2.signal,
          mode: 'cors',
        });
        clearTimeout(timer2);

        if (resp2.body) {
          const reader = resp2.body.getReader();
          await reader.read();
          reader.cancel();
        }

        return { stream, responseTime: performance.now() - start2 };
      }

      return { stream, responseTime: elapsed };
    } catch (e) {
      // On HEAD failure, try a quick GET with range
      try {
        const start2 = performance.now();
        const controller2 = new AbortController();
        const timer2 = setTimeout(() => controller2.abort(), timeoutMs);

        const resp = await fetch(url, {
          method: 'GET',
          headers: { 'Range': 'bytes=0-1023' },
          signal: controller2.signal,
        });
        clearTimeout(timer2);

        if (resp.body) {
          const reader = resp.body.getReader();
          await reader.read();
          reader.cancel();
        }

        return { stream, responseTime: performance.now() - start2 };
      } catch {
        return { stream, responseTime: Infinity, error: e.message };
      }
    }
  }

  /**
   * Tests all streams in parallel, returns them sorted fastest-first.
   * Emits progress via the optional callback: (testedCount, total, currentResult)
   */
  async testAndRankStreams(streams, onProgress) {
    const total = streams.length;
    let tested = 0;

    const promises = streams.map(async (stream) => {
      const result = await this._testStreamSpeed(stream);
      tested++;
      if (onProgress) onProgress(tested, total, result);
      return result;
    });

    const results = await Promise.all(promises);

    // Sort by response time (fastest first), Infinity goes last
    results.sort((a, b) => a.responseTime - b.responseTime);

    return results;
  }

  /**
   * Gets streams and automatically tests + ranks them.
   * Returns { streams: [...ranked], bestStream, testing: true }
   */
  async getStreamsRanked(type, id, onProgress) {
    const streams = await this.getStreams(type, id);
    if (streams.length === 0) return { streams: [], bestStream: null };

    const ranked = await this.testAndRankStreams(streams, onProgress);
    const best = ranked.find(r => r.responseTime < Infinity) || null;

    return {
      streams: ranked,
      bestStream: best ? best.stream : null,
    };
  }
}

// Global instance
window.api = new StremioAPI();
