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

// Covers are returned as proxied paths (/api/cover/release/...) instead of
// the direct coverartarchive.org URL. coverartarchive 307-redirects to
// archive.org which is slow and flaky over VPN; our server proxy caches
// the bytes and sets a long Cache-Control so cards paint instantly on the
// second load.
function coverProxyUrl(releaseMbid, size = 500) {
  return `/api/cover/release/${releaseMbid}?size=${size}`;
}

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

function httpGetJSON(url, timeoutMs = 10000, redirectsLeft = 5) {
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
        if (redirectsLeft <= 0) {
          reject(new Error('Too many redirects'));
          return;
        }
        httpGetJSON(res.headers.location, timeoutMs, redirectsLeft - 1).then(resolve, reject);
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

// MusicBrainz' default query parser requires Lucene syntax and is unforgiving
// of real-world inputs (e.g. "the beatles" underweights the noise word "the"
// and can bury the canonical artist beneath compilations). `dismax=true`
// switches to the DisMax parser which is designed for end-user free-text
// queries and matches better across name/alias fields — this is what actually
// surfaces major artists when users type a plain name.
async function mbSearchRelease(query, limit = 25) {
  const data = await mbFetch('/release', { query, limit: String(limit), dismax: 'true' });
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
    coverUrl: coverProxyUrl(r.id, 500),
  }));
}

async function mbSearchArtist(query, limit = 25) {
  const data = await mbFetch('/artist', { query, limit: String(limit), dismax: 'true' });
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

async function mbSearchRecording(query, limit = 25) {
  const data = await mbFetch('/recording', { query, limit: String(limit), dismax: 'true' });
  if (!data || !Array.isArray(data.recordings)) return [];
  return data.recordings.map(r => {
    const releases = Array.isArray(r.releases) ? r.releases : [];
    const firstRelease = releases[0] || null;
    return {
      mbid: r.id,
      title: r.title,
      artist: (r['artist-credit'] || []).map(a => a.name).join(', '),
      artistMbid: (r['artist-credit'] && r['artist-credit'][0] && r['artist-credit'][0].artist && r['artist-credit'][0].artist.id) || null,
      duration: r.length ? Math.round(r.length / 1000) : null,
      releaseMbid: firstRelease ? firstRelease.id : null,
      releaseTitle: firstRelease ? firstRelease.title : '',
      year: firstRelease && firstRelease.date ? firstRelease.date.slice(0, 4) : '',
      score: r.score || 0,
      coverUrl: firstRelease ? coverProxyUrl(firstRelease.id, 500) : null,
    };
  });
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
    coverUrl: coverProxyUrl(mbid, 500),
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
  return coverProxyUrl(releaseMbid, size);
}

module.exports = {
  mbSearchRelease,
  mbSearchArtist,
  mbSearchRecording,
  mbGetRelease,
  mbGetArtist,
  mbGetReleaseForGroup,
  mbGetCoverArt,
};
