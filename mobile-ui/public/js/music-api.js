// Albatross — Music API client
// Thin wrapper around the server's music endpoints. Mirrors the style of
// api.js (the StremioAPI client) but uses plain functions keyed on globals.

(function () {
  'use strict';

  const CACHE_TTL = 60 * 1000;
  const _cache = new Map();

  function cacheGet(key) {
    const hit = _cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.ts > CACHE_TTL) { _cache.delete(key); return null; }
    return hit.value;
  }
  function cacheSet(key, value) {
    if (_cache.size > 200) _cache.delete(_cache.keys().next().value);
    _cache.set(key, { value, ts: Date.now() });
  }

  async function json(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

  // ─── Search & Metadata ─────────────────────────────

  async function searchMusic(query, type = 'music') {
    const q = (query || '').trim();
    if (!q) return [];
    const key = `search:${type}:${q.toLowerCase()}`;
    const cached = cacheGet(key);
    if (cached) return cached;
    const data = await json(`/api/search?q=${encodeURIComponent(q)}&type=${type}`);
    const results = data.results || [];
    cacheSet(key, results);
    return results;
  }

  async function getReleaseMeta(mbid) {
    const key = `rel:${mbid}`;
    const cached = cacheGet(key);
    if (cached) return cached;
    const data = await json(`/api/mb-meta/release/${mbid}`);
    cacheSet(key, data.meta);
    return data.meta;
  }

  async function getArtistMeta(mbid) {
    const key = `art:${mbid}`;
    const cached = cacheGet(key);
    if (cached) return cached;
    const data = await json(`/api/mb-meta/artist/${mbid}`);
    cacheSet(key, data.meta);
    return data.meta;
  }

  async function getReleaseForGroup(releaseGroupMbid) {
    const key = `rg:${releaseGroupMbid}`;
    const cached = cacheGet(key);
    if (cached) return cached;
    const data = await json(`/api/mb-meta/release-group/${releaseGroupMbid}`);
    cacheSet(key, data.meta);
    return data.meta;
  }

  // ─── Streams ─────────────────────────────

  async function getAlbumStreams(mbid, artist, title) {
    const params = new URLSearchParams();
    if (artist) params.set('artist', artist);
    if (title) params.set('title', title);
    const data = await json(`/api/streams/album/${mbid || 'na'}?${params.toString()}`);
    return data.streams || [];
  }

  async function getArtistStreams(mbid, name) {
    const params = new URLSearchParams({ name: name || '' });
    const data = await json(`/api/streams/artist/${mbid || 'na'}?${params.toString()}`);
    return data.streams || [];
  }

  // List files in a torrent (audio only).
  async function listTorrentAudioFiles(infoHash) {
    const data = await json(`/api/torrent-status/${infoHash}?kind=audio`);
    return data.files || [];
  }

  // ─── Library (music items) ─────────────────────────

  async function getLibrary() {
    const data = await json('/api/library');
    return (data.items || []).filter(i => i.type === 'album' || i.type === 'artist');
  }

  async function getGenres() {
    try {
      const data = await json('/api/library/music/genres');
      return data.genres || {};
    } catch {
      return {};
    }
  }

  async function setGenre(itemId, genre) {
    return json(`/api/library/music/${itemId}/genre`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ genre }),
    });
  }

  async function toggleFavorite(itemId) {
    return json(`/api/library/music/${itemId}/favorite`, { method: 'POST' });
  }

  async function markPlayed(itemId) {
    // Fire-and-forget; server throttles.
    fetch(`/api/library/music/${itemId}/played`, { method: 'POST' }).catch(() => {});
  }

  // ─── Playlists ─────────────────────────

  async function listPlaylists() {
    const data = await json('/api/music/playlists');
    return data.playlists || [];
  }

  async function createPlaylist(name) {
    return json('/api/music/playlists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  }

  async function renamePlaylist(id, name) {
    return json(`/api/music/playlists/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  }

  async function deletePlaylist(id) {
    return json(`/api/music/playlists/${id}`, { method: 'DELETE' });
  }

  async function addToPlaylist(id, albumId, trackIndex) {
    return json(`/api/music/playlists/${id}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ albumId, trackIndex }),
    });
  }

  async function reorderPlaylistItem(id, from, to) {
    return json(`/api/music/playlists/${id}/items/reorder`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
  }

  async function removePlaylistItem(id, index) {
    return json(`/api/music/playlists/${id}/items/${index}`, { method: 'DELETE' });
  }

  window.MusicAPI = {
    searchMusic,
    getReleaseMeta,
    getArtistMeta,
    getReleaseForGroup,
    getAlbumStreams,
    getArtistStreams,
    listTorrentAudioFiles,
    getLibrary,
    getGenres,
    setGenre,
    toggleFavorite,
    markPlayed,
    listPlaylists,
    createPlaylist,
    renamePlaylist,
    deletePlaylist,
    addToPlaylist,
    reorderPlaylistItem,
    removePlaylistItem,
  };
})();
