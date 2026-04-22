/**
 * Albatross — MusicBrainz + Cover Art Archive Client
 *
 * MusicBrainz requires a meaningful User-Agent and enforces ~1 req/s per IP
 * across the public API. We serialize all outbound calls through a single
 * promise-chain queue to stay comfortably under that limit.
 *
 * Cover art is fetched from coverartarchive.org, which redirects to raw image
 * URLs on archive.org; the front 500px variant is returned for cards.
 *
 * No API key required. Returns null on failure (callers decide fallbacks).
 */

const https = require('https');

const MB_BASE = 'https://musicbrainz.org/ws/2';
const CAA_BASE = 'https://coverartarchive.org';
const UA = 'AlabtrossStreaming/1.0 (https://github.com/Dzifferer/alabtross-streaming)';

// Serial queue — MusicBrainz rate limits to ~1 req/s per IP.
const MIN_INTERVAL_MS = 1100;
let _lastCall = 0;
let _chain = Promise.resolve();

function schedule(fn) {
  const run = async () => {
    const wait = Math.max(0, _lastCall + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _lastCall = Date.now();
    return fn();
  };
  _chain = _chain.then(run, run);
  return _chain;
}

function httpGetJSON(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      if (req) req.destroy();
      reject(new Error(`Timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    const req = https.get(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
      },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(deadline);
        res.resume();
        httpGetJSON(res.headers.location, timeoutMs).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        clearTimeout(deadline);
        res.resume();
        resolve({ ok: false, status: res.statusCode });
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => {
        clearTimeout(deadline);
        try { resolve({ ok: true, data: JSON.parse(body) }); }
        catch (e) { resolve({ ok: false, status: 200, error: 'parse' }); }
      });
    });
    req.on('error', (e) => { clearTimeout(deadline); reject(e); });
    req.on('timeout', () => { clearTimeout(deadline); req.destroy(); reject(new Error('Socket timeout')); });
  });
}

async function mbFetch(path, params = {}) {
  const qs = new URLSearchParams({ fmt: 'json', ...params }).toString();
  const url = `${MB_BASE}${path}?${qs}`;
  return schedule(async () => {
    try {
      const res = await httpGetJSON(url);
      if (!res || !res.ok) {
        console.log(`[MB] ${res && res.status} for ${url}`);
        return null;
      }
      return res.data;
    } catch (e) {
      console.log(`[MB] error for ${url}: ${e.message}`);
      return null;
    }
  });
}

// Dedupe and normalize MB tags (array of {name, count}) into a sorted genre list.
function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .filter(t => t && t.name && (t.count === undefined || t.count >= 1))
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .map(t => t.name.toLowerCase())
    .slice(0, 6);
}

async function mbSearchRelease(query, limit = 15) {
  const data = await mbFetch('/release', { query, limit: String(limit) });
  if (!data || !Array.isArray(data.releases)) return [];
  return data.releases.map(r => ({
    mbid: r.id,
    title: r.title,
    artist: (r['artist-credit'] || []).map(a => a.name).join(', '),
    artistMbid: (r['artist-credit'] && r['artist-credit'][0] && r['artist-credit'][0].artist && r['artist-credit'][0].artist.id) || null,
    year: (r.date || '').slice(0, 4),
    country: r.country || '',
    trackCount: (r['track-count'] !== undefined) ? r['track-count'] : (r.media && r.media.reduce((n, m) => n + (m['track-count'] || 0), 0)) || 0,
    score: r.score || 0,
    coverUrl: `${CAA_BASE}/release/${r.id}/front-500`,
  }));
}

async function mbSearchArtist(query, limit = 10) {
  const data = await mbFetch('/artist', { query, limit: String(limit) });
  if (!data || !Array.isArray(data.artists)) return [];
  return data.artists.map(a => ({
    mbid: a.id,
    name: a.name,
    sortName: a['sort-name'] || a.name,
    country: a.country || '',
    type: a.type || '',
    disambiguation: a.disambiguation || '',
    tags: normalizeTags(a.tags),
    score: a.score || 0,
  }));
}

async function mbGetRelease(mbid) {
  const data = await mbFetch(`/release/${mbid}`, {
    inc: 'artist-credits+recordings+release-groups+tags+genres',
  });
  if (!data) return null;
  const tracks = [];
  for (const medium of (data.media || [])) {
    for (const t of (medium.tracks || [])) {
      tracks.push({
        position: tracks.length + 1,
        discNumber: medium.position || 1,
        trackNumber: t.position || tracks.length + 1,
        title: t.title,
        duration: t.length ? Math.round(t.length / 1000) : null,
        recordingMbid: t.recording && t.recording.id,
      });
    }
  }
  const rg = data['release-group'] || {};
  const genres = normalizeTags(data.genres || data.tags || []);
  const rgGenres = normalizeTags(rg.genres || rg.tags || []);
  return {
    mbid: data.id,
    title: data.title,
    artist: (data['artist-credit'] || []).map(a => a.name).join(', '),
    artistMbid: (data['artist-credit'] && data['artist-credit'][0] && data['artist-credit'][0].artist && data['artist-credit'][0].artist.id) || null,
    year: (data.date || rg['first-release-date'] || '').slice(0, 4),
    country: data.country || '',
    genres: genres.length ? genres : rgGenres,
    primaryType: rg['primary-type'] || '',
    tracks,
    coverUrl: `${CAA_BASE}/release/${mbid}/front-500`,
  };
}

async function mbGetArtist(mbid) {
  const data = await mbFetch(`/artist/${mbid}`, {
    inc: 'release-groups+tags+genres+url-rels',
  });
  if (!data) return null;
  // Filter to studio albums + EPs; skip compilations and live by default.
  const releaseGroups = (data['release-groups'] || [])
    .filter(rg => {
      const primary = (rg['primary-type'] || '').toLowerCase();
      const secondaries = (rg['secondary-types'] || []).map(s => s.toLowerCase());
      if (!['album', 'ep', 'single'].includes(primary)) return false;
      if (secondaries.includes('compilation') || secondaries.includes('live')) return false;
      return true;
    })
    .sort((a, b) => (a['first-release-date'] || '').localeCompare(b['first-release-date'] || ''))
    .map(rg => ({
      releaseGroupMbid: rg.id,
      title: rg.title,
      year: (rg['first-release-date'] || '').slice(0, 4),
      primaryType: rg['primary-type'] || '',
    }));
  return {
    mbid: data.id,
    name: data.name,
    sortName: data['sort-name'] || data.name,
    country: data.country || '',
    type: data.type || '',
    disambiguation: data.disambiguation || '',
    lifeSpan: data['life-span'] || null,
    genres: normalizeTags(data.genres || data.tags || []),
    releaseGroups,
  };
}

// Expand a release-group MBID to a representative release (for playback).
async function mbGetReleaseForGroup(releaseGroupMbid) {
  const data = await mbFetch('/release', {
    'release-group': releaseGroupMbid,
    inc: 'recordings',
    limit: '10',
  });
  if (!data || !Array.isArray(data.releases) || !data.releases.length) return null;
  // Prefer the release with the most tracks (typically the canonical edition).
  const best = data.releases.sort((a, b) => {
    const at = (a.media || []).reduce((n, m) => n + (m['track-count'] || 0), 0);
    const bt = (b.media || []).reduce((n, m) => n + (m['track-count'] || 0), 0);
    return bt - at;
  })[0];
  return best ? best.id : null;
}

function mbGetCoverArt(releaseMbid, size = 500) {
  return `${CAA_BASE}/release/${releaseMbid}/front-${size}`;
}

module.exports = {
  mbSearchRelease,
  mbSearchArtist,
  mbGetRelease,
  mbGetArtist,
  mbGetReleaseForGroup,
  mbGetCoverArt,
};
