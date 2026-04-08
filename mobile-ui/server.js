const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const dns = require('dns');
// http-proxy-middleware removed — Stremio server proxy no longer needed
const { getMovieStreams, getSeriesStreams, getSeasonPackStreams, getCompleteStreams, diagnoseProviders } = require('./lib/stream-providers');
const TorrentEngine = require('./lib/torrent-engine');
const LibraryManager = require('./lib/library-manager');
const { discoverDevices, getLocalIP } = require('./lib/local-discovery');
const castManager = require('./lib/cast-manager');

const app = express();
const PORT = process.env.PORT || 8080;
const TORRENT_CACHE_PATH = process.env.TORRENT_CACHE || path.join(__dirname, '.torrent-cache');
const LIBRARY_PATH = process.env.LIBRARY_PATH || path.join(TORRENT_CACHE_PATH, 'library');
const SETTINGS_PATH = path.join(TORRENT_CACHE_PATH, 'settings.json');
let MAX_CONCURRENT_STREAMS = parseInt(process.env.MAX_CONCURRENT_STREAMS, 10) || 5;

// Load persisted settings from disk
try {
  if (fs.existsSync(SETTINGS_PATH)) {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    if (saved.maxConcurrentStreams >= 1 && saved.maxConcurrentStreams <= 20) {
      MAX_CONCURRENT_STREAMS = saved.maxConcurrentStreams;
    }
  }
} catch (e) {
  console.warn('[Settings] Failed to load saved settings:', e.message);
}

// JSON body parsing for library POST/DELETE requests
app.use(express.json({ limit: '10kb' }));

// ─── Rate Limiting (simple in-memory, per-IP) ────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 300;          // max requests per window

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW) {
    entry = { start: now, count: 0 };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests — try again later' });
  }
  next();
}

// Clean up rate limit map periodically
const rateLimitCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.start > RATE_LIMIT_WINDOW) rateLimitMap.delete(ip);
  }
}, RATE_LIMIT_WINDOW);

// ─── Torrent Engine (lazy-initialized on first custom-mode request) ───
let engine = null;
function getEngine() {
  if (!engine) {
    engine = new TorrentEngine({ downloadPath: TORRENT_CACHE_PATH, maxConcurrent: MAX_CONCURRENT_STREAMS });
    console.log(`[TorrentEngine] Initialized, cache path: ${TORRENT_CACHE_PATH}`);
  }
  return engine;
}

// ─── Library Manager (initialized on startup) ─────────────────────────
const library = new LibraryManager({ libraryPath: LIBRARY_PATH, maxConcurrentDownloads: MAX_CONCURRENT_STREAMS });
console.log(`[Debug] LIBRARY_PATH resolved to: ${LIBRARY_PATH}`);
console.log(`[Debug] LIBRARY_PATH exists: ${fs.existsSync(LIBRARY_PATH)}`);
console.log(`[Debug] TORRENT_CACHE_PATH: ${TORRENT_CACHE_PATH}`);

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'sha256-ZswfTY7H35rbv8WC7NXBoiC7WNu86vSzCDChNWwZZDM='",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https: data:",
    "connect-src 'self'",
    "media-src 'self' blob: http: https:",
    "frame-ancestors 'none'",
  ].join('; '));
  next();
});

// ─── TMDB Search API ─────────────────────────────────────────────────

const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const TMDB_BASE = 'https://api.themoviedb.org/3';

function tmdbFetch(endpoint, params = {}) {
  if (!TMDB_API_KEY) return Promise.reject(new Error('No TMDB API key'));
  const qs = new URLSearchParams({ api_key: TMDB_API_KEY, ...params });
  const url = `${TMDB_BASE}${endpoint}?${qs}`;
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 8000 }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`TMDB HTTP ${res.statusCode}`));
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('Timeout')); });
  });
}

// Compute how relevant a title is to the search query (0.0 - 1.0)
function relevanceScore(title, query) {
  const t = title.toLowerCase();
  const q = query.toLowerCase();
  if (t === q) return 1.0;
  let score = 0;
  if (t.startsWith(q)) score = 0.75;
  else if (t.includes(q)) score = 0.5;
  const coverage = Math.min(q.length / t.length, 1.0);
  score += coverage * 0.25;
  const qWords = q.split(/\s+/);
  const tWords = t.split(/\s+/);
  const matched = qWords.filter(w => tWords.includes(w)).length;
  score += (matched / tWords.length) * 0.15;
  return Math.min(score, 1.0);
}

// GET /api/search?q=query&type=movie|series
app.get('/api/search', rateLimit, async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query || query.length > 200) return res.json({ results: [] });

  const type = req.query.type; // 'movie', 'series', or undefined for both
  const results = [];

  if (!TMDB_API_KEY) {
    return res.json({ results: [], error: 'TMDB API key not configured' });
  }

  try {
    const types = type === 'movie' ? ['movie'] : type === 'series' ? ['tv'] : ['movie', 'tv'];
    const searches = types.map(t =>
      tmdbFetch(`/search/${t}`, { query, include_adult: 'false' })
        .then(data => (data.results || []).map(item => ({ ...item, media_type: t })))
        .catch(() => [])
    );
    const searchResults = await Promise.all(searches);

    for (const items of searchResults) {
      for (const item of items) {
        // Get IMDB ID via external IDs lookup
        const tmdbType = item.media_type;
        const tmdbId = item.id;
        const title = tmdbType === 'movie' ? item.title : item.name;
        const year = (item.release_date || item.first_air_date || '').slice(0, 4);
        const poster = item.poster_path
          ? `https://image.tmdb.org/t/p/w342${item.poster_path}`
          : null;

        results.push({
          tmdb_id: tmdbId,
          type: tmdbType === 'tv' ? 'series' : 'movie',
          name: title,
          year,
          poster,
          popularity: item.popularity || 0,
          vote_average: item.vote_average || 0,
          overview: item.overview || '',
        });
      }
    }

    // Sort by relevance to query, then popularity as tiebreaker
    results.sort((a, b) => {
      const relDiff = relevanceScore(b.name, query) - relevanceScore(a.name, query);
      if (relDiff !== 0) return relDiff;
      return b.popularity - a.popularity;
    });

    // Fetch IMDB IDs for top results (concurrency-limited to avoid TMDB rate limits)
    const topResults = results.slice(0, 20);
    const CONCURRENCY = 5;
    for (let i = 0; i < topResults.length; i += CONCURRENCY) {
      const batch = topResults.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (item) => {
        try {
          const tmdbType = item.type === 'series' ? 'tv' : 'movie';
          const ext = await tmdbFetch(`/${tmdbType}/${item.tmdb_id}/external_ids`);
          item.imdb_id = ext.imdb_id || null;
          item.id = ext.imdb_id || `tmdb:${item.tmdb_id}`;
        } catch {
          item.imdb_id = null;
          item.id = `tmdb:${item.tmdb_id}`;
        }
      }));
    }

    // Sort: IMDB availability first, then relevance, then popularity
    topResults.sort((a, b) => {
      const aHas = a.imdb_id ? 1 : 0;
      const bHas = b.imdb_id ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas;
      const relDiff = relevanceScore(b.name, query) - relevanceScore(a.name, query);
      if (relDiff !== 0) return relDiff;
      return b.popularity - a.popularity;
    });

    res.json({ results: topResults });
  } catch (err) {
    console.error('[TMDB] Search error:', err.message);
    res.json({ results: [], error: 'Search failed' });
  }
});

// ─── TMDB Metadata Endpoint (for items without IMDB IDs) ────────────

app.get('/api/tmdb-meta/:type/:tmdbId', rateLimit, async (req, res) => {
  const { type, tmdbId } = req.params;
  if (!/^\d+$/.test(tmdbId) || !['movie', 'series'].includes(type)) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }

  if (!TMDB_API_KEY) {
    return res.status(503).json({ error: 'TMDB API key not configured' });
  }

  try {
    const tmdbType = type === 'series' ? 'tv' : 'movie';
    const data = await tmdbFetch(`/${tmdbType}/${tmdbId}`);

    const meta = {
      id: `tmdb:${tmdbId}`,
      type,
      name: tmdbType === 'movie' ? data.title : data.name,
      year: (data.release_date || data.first_air_date || '').slice(0, 4),
      poster: data.poster_path ? `https://image.tmdb.org/t/p/w342${data.poster_path}` : null,
      background: data.backdrop_path ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}` : null,
      description: data.overview || '',
      genres: (data.genres || []).map(g => g.name),
      runtime: data.runtime ? `${data.runtime} min` : undefined,
      imdbRating: data.vote_average ? String(data.vote_average) : undefined,
    };

    // Try to resolve IMDB ID one more time
    try {
      const ext = await tmdbFetch(`/${tmdbType}/${tmdbId}/external_ids`);
      if (ext.imdb_id) {
        meta.imdb_id = ext.imdb_id;
        meta.id = ext.imdb_id;
      }
    } catch { /* keep tmdb: ID */ }

    // For series, include season/episode data
    if (type === 'series' && data.seasons) {
      meta.videos = [];
      for (const season of data.seasons) {
        if (season.season_number === 0) continue; // skip specials
        try {
          const seasonData = await tmdbFetch(`/tv/${tmdbId}/season/${season.season_number}`);
          for (const ep of (seasonData.episodes || [])) {
            meta.videos.push({
              id: `tmdb:${tmdbId}:${season.season_number}:${ep.episode_number}`,
              season: season.season_number,
              episode: ep.episode_number,
              title: ep.name || `Episode ${ep.episode_number}`,
              overview: ep.overview || '',
              released: ep.air_date || undefined,
            });
          }
        } catch { /* skip season on error */ }
      }
    }

    res.json({ meta });
  } catch (err) {
    console.error('[TMDB] Meta fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch metadata' });
  }
});

// ─── TMDB Metadata by IMDB ID (replaces Cinemeta) ────────────────────

app.get('/api/tmdb-meta-imdb/:type/:imdbId', rateLimit, async (req, res) => {
  const { type, imdbId } = req.params;
  if (!/^tt\d+$/.test(imdbId) || !['movie', 'series'].includes(type)) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }

  if (!TMDB_API_KEY) {
    return res.status(503).json({ error: 'TMDB API key not configured' });
  }

  try {
    // Step 1: IMDB ID → TMDB ID
    const tmdbType = type === 'series' ? 'tv' : 'movie';
    const findResult = await tmdbFetch(`/find/${imdbId}`, { external_source: 'imdb_id' });
    const results = tmdbType === 'tv'
      ? (findResult.tv_results || [])
      : (findResult.movie_results || []);

    if (results.length === 0) {
      return res.status(404).json({ error: 'Not found on TMDB' });
    }

    const tmdbId = results[0].id;

    // Step 2: Full metadata
    const data = await tmdbFetch(`/${tmdbType}/${tmdbId}`);

    const meta = {
      id: imdbId,
      imdb_id: imdbId,
      type,
      name: tmdbType === 'movie' ? data.title : data.name,
      year: (data.release_date || data.first_air_date || '').slice(0, 4),
      poster: data.poster_path ? `https://image.tmdb.org/t/p/w342${data.poster_path}` : null,
      background: data.backdrop_path ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}` : null,
      description: data.overview || '',
      genres: (data.genres || []).map(g => g.name),
      runtime: data.runtime ? `${data.runtime} min` : undefined,
      imdbRating: data.vote_average ? String(data.vote_average) : undefined,
    };

    // For series, include season/episode data
    if (type === 'series' && data.seasons) {
      meta.videos = [];
      for (const season of data.seasons) {
        if (season.season_number === 0) continue; // skip specials
        try {
          const seasonData = await tmdbFetch(`/tv/${tmdbId}/season/${season.season_number}`);
          for (const ep of (seasonData.episodes || [])) {
            meta.videos.push({
              id: `${imdbId}:${season.season_number}:${ep.episode_number}`,
              season: season.season_number,
              episode: ep.episode_number,
              title: ep.name || `Episode ${ep.episode_number}`,
              overview: ep.overview || '',
              released: ep.air_date || undefined,
            });
          }
        } catch { /* skip season on error */ }
      }
    }

    res.json({ meta });
  } catch (err) {
    console.error('[TMDB] IMDB meta fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch metadata' });
  }
});

// ─── Collection / Franchise Grouping ─────────────────────────────────

const COLLECTION_CACHE_PATH = path.join(TORRENT_CACHE_PATH, 'collection-cache.json');
let collectionCache = {}; // imdbId -> { collectionId, collectionName, collectionPoster, genres, year } | null

// Load persistent collection cache
try {
  if (fs.existsSync(COLLECTION_CACHE_PATH)) {
    collectionCache = JSON.parse(fs.readFileSync(COLLECTION_CACHE_PATH, 'utf8'));
    // Purge stale null entries and entries missing genres so they get re-fetched
    const beforeCount = Object.keys(collectionCache).length;
    for (const key of Object.keys(collectionCache)) {
      if (!collectionCache[key] || !collectionCache[key].genres) {
        delete collectionCache[key];
      }
    }
    const purged = beforeCount - Object.keys(collectionCache).length;
    console.log(`[Collections] Loaded cache with ${Object.keys(collectionCache).length} entries${purged > 0 ? ` (purged ${purged} stale entries)` : ''}`);
  }
} catch (e) {
  console.warn('[Collections] Failed to load cache:', e.message);
}

function saveCollectionCache() {
  try {
    fs.writeFileSync(COLLECTION_CACHE_PATH, JSON.stringify(collectionCache), 'utf8');
  } catch (e) {
    console.warn('[Collections] Failed to save cache:', e.message);
  }
}

// Title-based franchise detection (works without TMDB)
const FRANCHISE_PATTERNS = [
  { pattern: /^star\s*wars/i, name: 'Star Wars Collection', id: 'franchise_starwars' },
  { pattern: /^avatar/i, name: 'Avatar Collection', id: 'franchise_avatar', exclude: /avatar:\s*the\s*last\s*air/i },
  { pattern: /^indiana\s*jones|^raiders\s*of\s*the\s*lost\s*ark/i, name: 'Indiana Jones Collection', id: 'franchise_indianajones' },
  { pattern: /james\s*bond|^0{0,2}7\b|^dr\.?\s*no$|^goldfinger$|^thunderball$|^goldeneye$|^skyfall$|^spectre$|^casino\s*royale|^quantum\s*of\s*solace|^no\s*time\s*to\s*die|^die\s*another\s*day|^tomorrow\s*never\s*dies|^the\s*world\s*is\s*not\s*enough|^licence\s*to\s*kill|^the\s*living\s*daylights|^a\s*view\s*to\s*a\s*kill|^octopussy|^for\s*your\s*eyes\s*only|^moonraker|^the\s*spy\s*who\s*loved\s*me|^the\s*man\s*with\s*the\s*golden\s*gun|^live\s*and\s*let\s*die|^diamonds\s*are\s*forever|^on\s*her\s*majesty/i, name: 'James Bond Collection', id: 'franchise_jamesbond' },
  { pattern: /^pirates\s*of\s*the\s*caribbean/i, name: 'Pirates of the Caribbean Collection', id: 'franchise_potc' },
  { pattern: /^the\s*lord\s*of\s*the\s*rings|^the\s*hobbit/i, name: 'Middle-earth Collection', id: 'franchise_middleearth' },
  { pattern: /^harry\s*potter|^fantastic\s*beasts/i, name: 'Wizarding World Collection', id: 'franchise_wizardingworld' },
  { pattern: /^the\s*hunger\s*games/i, name: 'The Hunger Games Collection', id: 'franchise_hungergames' },
  { pattern: /^transformers/i, name: 'Transformers Collection', id: 'franchise_transformers' },
  { pattern: /^mission:?\s*impossible/i, name: 'Mission: Impossible Collection', id: 'franchise_mi' },
  { pattern: /^fast\s*(&|and)\s*furious|^the\s*fast\s*(and|&)\s*(the\s*)?furious|^furious\s*\d|^f\d|^fast\s*five|^fast\s*x/i, name: 'Fast & Furious Collection', id: 'franchise_fastandfurious' },
  { pattern: /^jurassic\s*(park|world)/i, name: 'Jurassic Collection', id: 'franchise_jurassic' },
  { pattern: /^the\s*matrix/i, name: 'The Matrix Collection', id: 'franchise_matrix' },
  { pattern: /^john\s*wick/i, name: 'John Wick Collection', id: 'franchise_johnwick' },
  { pattern: /^toy\s*story/i, name: 'Toy Story Collection', id: 'franchise_toystory' },
  { pattern: /^shrek/i, name: 'Shrek Collection', id: 'franchise_shrek' },
  { pattern: /^ice\s*age/i, name: 'Ice Age Collection', id: 'franchise_iceage' },
  { pattern: /^despicable\s*me|^minions/i, name: 'Despicable Me Collection', id: 'franchise_despicableme' },
  { pattern: /^kung\s*fu\s*panda/i, name: 'Kung Fu Panda Collection', id: 'franchise_kungfupanda' },
  { pattern: /^how\s*to\s*train\s*your\s*dragon/i, name: 'How to Train Your Dragon Collection', id: 'franchise_httyd' },
  { pattern: /^madagascar/i, name: 'Madagascar Collection', id: 'franchise_madagascar' },
  { pattern: /^the\s*dark\s*knight|^batman\s*begins/i, name: 'The Dark Knight Collection', id: 'franchise_darkknight' },
  { pattern: /^spider-?\s*man|^the\s*amazing\s*spider/i, name: 'Spider-Man Collection', id: 'franchise_spiderman' },
  { pattern: /^x-?\s*men|^logan$|^deadpool|^the\s*wolverine/i, name: 'X-Men Collection', id: 'franchise_xmen' },
  { pattern: /^guardians\s*of\s*the\s*galaxy/i, name: 'Guardians of the Galaxy Collection', id: 'franchise_gotg' },
  { pattern: /^captain\s*america/i, name: 'Captain America Collection', id: 'franchise_captainamerica' },
  { pattern: /^iron\s*man/i, name: 'Iron Man Collection', id: 'franchise_ironman' },
  { pattern: /^thor\s*(:|$)/i, name: 'Thor Collection', id: 'franchise_thor' },
  { pattern: /^the\s*avengers|^avengers/i, name: 'The Avengers Collection', id: 'franchise_avengers' },
  { pattern: /^alien\s*(:|$)|^aliens$|^alien\s*3|^alien\s*resurr|^prometheus|^alien:\s*covenant|^alien:\s*romulus/i, name: 'Alien Collection', id: 'franchise_alien' },
  { pattern: /^terminator/i, name: 'Terminator Collection', id: 'franchise_terminator' },
  { pattern: /^rocky\s|^rocky$|^creed/i, name: 'Rocky / Creed Collection', id: 'franchise_rocky' },
  { pattern: /^the\s*godfather/i, name: 'The Godfather Collection', id: 'franchise_godfather' },
  { pattern: /^back\s*to\s*the\s*future/i, name: 'Back to the Future Collection', id: 'franchise_bttf' },
  { pattern: /^ghostbusters/i, name: 'Ghostbusters Collection', id: 'franchise_ghostbusters' },
  { pattern: /^the\s*conjuring|^annabelle|^the\s*nun/i, name: 'The Conjuring Universe', id: 'franchise_conjuring' },
  { pattern: /^saw\s/i, name: 'Saw Collection', id: 'franchise_saw' },
  { pattern: /^happy\s*gilmore|^billy\s*madison|^the\s*waterboy|^big\s*daddy|^mr\.?\s*deeds|^click$|^grown\s*ups|^you\s*don.t\s*mess\s*with\s*the\s*zohan|^just\s*go\s*with\s*it|^blended$|^the\s*longest\s*yard.*2005|^50\s*first\s*dates/i, name: 'Adam Sandler Comedies', id: 'franchise_sandler' },
  { pattern: /^a\s*knight.s\s*tale/i, name: null, id: null }, // Not a franchise
];

function matchFranchiseByTitle(title) {
  if (!title) return null;
  for (const f of FRANCHISE_PATTERNS) {
    if (f.exclude && f.exclude.test(title)) continue;
    if (f.pattern.test(title)) {
      if (!f.id) return null; // Explicit non-franchise
      return { collectionId: f.id, collectionName: f.name, collectionPoster: null };
    }
  }
  return null;
}

// In-memory cache for full collection details (1-hour TTL)
const collectionDetailCache = new Map();
const COLLECTION_DETAIL_TTL = 60 * 60 * 1000;

async function lookupCollectionForImdbId(imdbId) {
  // Already cached — but re-fetch if missing genres (old cache format)
  // null entries are from errors/old format and should be retried
  if (imdbId in collectionCache) {
    const cached = collectionCache[imdbId];
    if (cached?.genres) return cached;
    // null or old cache entry without genres — re-fetch
  }

  try {
    // Step 1: IMDB ID -> TMDB movie ID
    const findResult = await tmdbFetch(`/find/${imdbId}`, { external_source: 'imdb_id' });
    const movieResults = findResult.movie_results || [];
    if (movieResults.length === 0) {
      collectionCache[imdbId] = { collectionId: null, genres: [], year: '' };
      return collectionCache[imdbId];
    }
    const tmdbId = movieResults[0].id;

    // Step 2: Get movie details including belongs_to_collection and genres
    const movieDetail = await tmdbFetch(`/movie/${tmdbId}`);
    const genres = (movieDetail.genres || []).map(g => g.name);
    const year = (movieDetail.release_date || '').slice(0, 4);
    const col = movieDetail.belongs_to_collection;

    if (!col) {
      // No collection, but still store genres/year for genre grouping
      collectionCache[imdbId] = { collectionId: null, genres, year };
      return collectionCache[imdbId];
    }

    const entry = {
      collectionId: col.id,
      collectionName: col.name,
      collectionPoster: col.poster_path ? `https://image.tmdb.org/t/p/w342${col.poster_path}` : null,
      genres,
      year,
    };
    collectionCache[imdbId] = entry;
    return entry;
  } catch (e) {
    console.warn(`[Collections] TMDB lookup failed for ${imdbId}:`, e.message);
    // Don't cache errors — allow retry on next request
    return null;
  }
}

// GET /api/collections/enrich?ids=tt123,tt456,...&names=Movie+One,Movie+Two,...
app.get('/api/collections/enrich', rateLimit, async (req, res) => {
  const idsParam = (req.query.ids || '').trim();
  const namesParam = (req.query.names || '').trim();
  if (!idsParam) return res.json({ collections: {} });

  const ids = idsParam.split(',').filter(id => /^tt\d+$/.test(id)).slice(0, 50);
  if (ids.length === 0) return res.json({ collections: {} });

  const names = namesParam ? namesParam.split('||') : [];

  // Try TMDB enrichment first (if API key is configured)
  let tmdbWorked = false;
  if (TMDB_API_KEY) {
    const batchSize = 5;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      await Promise.allSettled(batch.map(id => lookupCollectionForImdbId(id)));
      if (i + batchSize < ids.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }
    saveCollectionCache();
    // Check if TMDB returned any real results
    tmdbWorked = ids.some(id => collectionCache[id] && collectionCache[id].collectionId);
  }

  // Build response: group by collection + per-movie metadata (genres, year)
  const collections = {};
  const movieMeta = {}; // imdbId -> { genres: [...], year: "2005" }

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    let entry = collectionCache[id];

    // Fallback to title-based matching if no collection found via TMDB
    if ((!entry || !entry.collectionId) && names[i]) {
      const titleMatch = matchFranchiseByTitle(names[i]);
      if (titleMatch) {
        // Merge: keep genres/year from TMDB cache if available
        entry = { ...titleMatch, genres: entry?.genres || [], year: entry?.year || '' };
      }
    }

    // Apply manual category overrides
    const manual = manualCategories[id];
    if (manual) {
      if (manual.genre) {
        const genres = entry?.genres || [];
        if (!genres.includes(manual.genre)) genres.unshift(manual.genre);
        entry = entry || { collectionId: null, genres, year: '' };
        entry.genres = genres;
      }
      if (manual.collectionId) {
        entry = entry || { genres: [], year: '' };
        entry.collectionId = manual.collectionId;
        entry.collectionName = manual.collectionName;
      }
    }

    // Store per-movie metadata (genres, year) for genre grouping
    movieMeta[id] = { genres: entry?.genres || [], year: entry?.year || '' };

    if (!entry || !entry.collectionId) continue;
    const key = String(entry.collectionId);
    if (!collections[key]) {
      collections[key] = {
        name: entry.collectionName,
        poster: entry.collectionPoster,
        movieIds: [],
      };
    }
    if (!collections[key].movieIds.includes(id)) {
      collections[key].movieIds.push(id);
    }
  }

  console.log(`[Collections] Enriched ${ids.length} IDs -> ${Object.keys(collections).length} collections (TMDB: ${tmdbWorked ? 'yes' : 'no'})`);
  res.json({ collections, movieMeta });
});

// GET /api/collections/:collectionId
app.get('/api/collections/:collectionId', rateLimit, async (req, res) => {
  const collectionId = parseInt(req.params.collectionId, 10);
  if (isNaN(collectionId)) return res.status(400).json({ error: 'Invalid collection ID' });

  // Check in-memory cache
  const cached = collectionDetailCache.get(collectionId);
  if (cached && Date.now() - cached.ts < COLLECTION_DETAIL_TTL) {
    return res.json(cached.data);
  }

  try {
    const detail = await tmdbFetch(`/collection/${collectionId}`);
    const parts = detail.parts || [];

    // Fetch IMDB IDs for all movies in the collection (batch 5 at a time)
    const movies = [];
    for (let i = 0; i < parts.length; i += 5) {
      const batch = parts.slice(i, i + 5);
      const results = await Promise.allSettled(batch.map(async (part) => {
        try {
          const ext = await tmdbFetch(`/movie/${part.id}/external_ids`);
          return {
            imdb_id: ext.imdb_id || null,
            name: part.title,
            year: (part.release_date || '').slice(0, 4),
            poster: part.poster_path ? `https://image.tmdb.org/t/p/w342${part.poster_path}` : null,
            overview: part.overview || '',
          };
        } catch {
          return {
            imdb_id: null,
            name: part.title,
            year: (part.release_date || '').slice(0, 4),
            poster: part.poster_path ? `https://image.tmdb.org/t/p/w342${part.poster_path}` : null,
            overview: part.overview || '',
          };
        }
      }));
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.imdb_id) {
          movies.push(r.value);
        }
      }
      if (i + 5 < parts.length) await new Promise(r => setTimeout(r, 300));
    }

    // Sort by year
    movies.sort((a, b) => (a.year || '9999').localeCompare(b.year || '9999'));

    const data = {
      name: detail.name,
      poster: detail.poster_path ? `https://image.tmdb.org/t/p/w342${detail.poster_path}` : null,
      movies,
    };

    collectionDetailCache.set(collectionId, { ts: Date.now(), data });
    res.json(data);
  } catch (err) {
    console.error('[Collections] Detail fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch collection details' });
  }
});

// ─── Manual Category Overrides ───────────────────────────────────────

const MANUAL_CATEGORIES_PATH = path.join(TORRENT_CACHE_PATH, 'manual-categories.json');
let manualCategories = {}; // imdbId -> { genre: "Comedy" } or { collectionId: "...", collectionName: "..." }

try {
  if (fs.existsSync(MANUAL_CATEGORIES_PATH)) {
    manualCategories = JSON.parse(fs.readFileSync(MANUAL_CATEGORIES_PATH, 'utf8'));
    console.log(`[Categories] Loaded ${Object.keys(manualCategories).length} manual overrides`);
  }
} catch (e) {
  console.warn('[Categories] Failed to load manual categories:', e.message);
}

function saveManualCategories() {
  try {
    fs.writeFileSync(MANUAL_CATEGORIES_PATH, JSON.stringify(manualCategories), 'utf8');
  } catch (e) {
    console.warn('[Categories] Failed to save manual categories:', e.message);
  }
}

// POST /api/library/categorize - manually assign a genre or collection to a movie
app.post('/api/library/categorize', rateLimit, (req, res) => {
  const { imdbId, genre, collectionId, collectionName } = req.body || {};
  if (!imdbId) return res.status(400).json({ error: 'imdbId is required' });

  if (genre) {
    manualCategories[imdbId] = { genre };
    // Also update the collection cache so the genre persists for enrichment
    if (collectionCache[imdbId]) {
      if (!collectionCache[imdbId].genres) collectionCache[imdbId].genres = [];
      if (!collectionCache[imdbId].genres.includes(genre)) {
        collectionCache[imdbId].genres.unshift(genre);
      }
    } else {
      collectionCache[imdbId] = { collectionId: null, genres: [genre], year: '' };
    }
    saveCollectionCache();
  } else if (collectionId && collectionName) {
    manualCategories[imdbId] = { collectionId, collectionName };
  } else {
    return res.status(400).json({ error: 'Provide genre or collectionId+collectionName' });
  }

  saveManualCategories();
  console.log(`[Categories] Manual override for ${imdbId}:`, manualCategories[imdbId]);
  res.json({ ok: true });
});

// DELETE /api/library/categorize/:imdbId - remove manual category override
app.delete('/api/library/categorize/:imdbId', rateLimit, (req, res) => {
  const { imdbId } = req.params;
  delete manualCategories[imdbId];
  saveManualCategories();
  res.json({ ok: true });
});

// GET /api/library/categories - get all manual category overrides
app.get('/api/library/categories', (req, res) => {
  res.json(manualCategories);
});

// ─── Custom Mode API Routes ───────────────────────────────────────────

// Helper: resolve a tmdb: ID to an IMDB ID via TMDB external_ids
async function resolveTmdbToImdb(tmdbId, type) {
  if (!TMDB_API_KEY) return null;
  try {
    const tmdbType = type === 'series' ? 'tv' : 'movie';
    const ext = await tmdbFetch(`/${tmdbType}/${tmdbId}/external_ids`);
    return ext.imdb_id || null;
  } catch {
    return null;
  }
}

/**
 * Search TMDB for a TV show by name and return the best match's metadata.
 * Returns { imdbId, poster, year, name } or null if not found.
 */
async function lookupShowByName(showName) {
  if (!TMDB_API_KEY || !showName) return null;
  try {
    const data = await tmdbFetch('/search/tv', { query: showName, include_adult: 'false' });
    const results = data.results || [];
    if (results.length === 0) return null;

    // Pick the best match by relevance score
    results.sort((a, b) => relevanceScore(b.name || '', showName) - relevanceScore(a.name || '', showName));
    const best = results[0];

    // Resolve IMDB ID
    const ext = await tmdbFetch(`/tv/${best.id}/external_ids`);
    const imdbId = ext.imdb_id || null;
    const poster = best.poster_path
      ? `https://image.tmdb.org/t/p/w342${best.poster_path}`
      : null;
    const year = (best.first_air_date || '').slice(0, 4);

    return { imdbId, poster, year, name: best.name || showName };
  } catch (err) {
    console.warn(`[TMDB] lookupShowByName("${showName}") failed:`, err.message);
    return null;
  }
}

// GET /api/streams/movie/:imdbId
app.get('/api/streams/movie/:imdbId', rateLimit, async (req, res) => {
  let { imdbId } = req.params;
  const title = req.query.title || '';

  // Support tmdb: IDs — try to resolve to IMDB first
  if (/^tmdb:\d+$/.test(imdbId)) {
    const tmdbId = imdbId.replace('tmdb:', '');
    const resolved = await resolveTmdbToImdb(tmdbId, 'movie');
    if (resolved) {
      imdbId = resolved;
    } else if (title) {
      // Can't resolve IMDB ID — use title-based scraping only
      try {
        const streams = await getMovieStreams(null, title);
        return res.json({ streams });
      } catch (err) {
        console.error('[API] Movie stream error (title-only):', err.message);
        return res.status(500).json({ error: 'Failed to fetch streams' });
      }
    } else {
      return res.status(400).json({ error: 'Cannot resolve TMDB ID and no title provided' });
    }
  }

  if (!/^tt\d{1,10}$/.test(imdbId)) {
    return res.status(400).json({ error: 'Invalid IMDB ID' });
  }
  try {
    const streams = await getMovieStreams(imdbId, title);
    res.json({ streams });
  } catch (err) {
    console.error('[API] Movie stream error:', err.message);
    res.status(500).json({ error: 'Failed to fetch streams' });
  }
});

// GET /api/streams/series/:imdbId?season=N&episode=N
app.get('/api/streams/series/:imdbId', rateLimit, async (req, res) => {
  let { imdbId } = req.params;

  // Support tmdb: IDs — try to resolve to IMDB first
  if (/^tmdb:\d+$/.test(imdbId)) {
    const tmdbId = imdbId.replace('tmdb:', '');
    const resolved = await resolveTmdbToImdb(tmdbId, 'series');
    if (resolved) {
      imdbId = resolved;
    }
    // For series without IMDB ID, title-based search handled below
  }

  if (!/^tt\d{1,10}$/.test(imdbId)) {
    // For tmdb: IDs that couldn't be resolved, try title-based search
    const title = req.query.title || '';
    if (!title) return res.status(400).json({ error: 'Invalid IMDB ID' });
    const season = req.query.season ? parseInt(req.query.season, 10) : undefined;
    const episode = req.query.episode ? parseInt(req.query.episode, 10) : undefined;
    const absEp = req.query.absEp ? parseInt(req.query.absEp, 10) : undefined;
    const genres = req.query.genres ? req.query.genres.split(',').filter(Boolean) : [];
    try {
      const streams = await getSeriesStreams(null, season, episode, title, { absEp, genres });
      return res.json({ streams });
    } catch (err) {
      console.error('[API] Series stream error (title-only):', err.message);
      return res.status(500).json({ error: 'Failed to fetch streams' });
    }
  }
  const season = req.query.season ? parseInt(req.query.season, 10) : undefined;
  const episode = req.query.episode ? parseInt(req.query.episode, 10) : undefined;
  const title = req.query.title || '';
  const absEp = req.query.absEp ? parseInt(req.query.absEp, 10) : undefined;
  const genres = req.query.genres ? req.query.genres.split(',').filter(Boolean) : [];
  try {
    const streams = await getSeriesStreams(imdbId, season, episode, title, { absEp, genres });
    res.json({ streams });
  } catch (err) {
    console.error('[API] Series stream error:', err.message);
    res.status(500).json({ error: 'Failed to fetch streams' });
  }
});

// GET /api/streams/season-pack/:imdbId?season=N&title=ShowName — search for season pack torrents
app.get('/api/streams/season-pack/:imdbId', rateLimit, async (req, res) => {
  const { imdbId } = req.params;
  const season = req.query.season ? parseInt(req.query.season, 10) : undefined;
  const title = req.query.title || '';

  if (season === undefined || isNaN(season)) {
    return res.status(400).json({ error: 'season query parameter is required' });
  }

  try {
    const streams = await getSeasonPackStreams(title, season, imdbId);
    res.json({ streams });
  } catch (err) {
    console.error('[API] Season pack stream error:', err.message);
    res.status(500).json({ error: 'Failed to fetch season pack streams' });
  }
});

// GET /api/streams/complete/:imdbId?title=ShowName — search for complete series/movie torrents
app.get('/api/streams/complete/:imdbId', rateLimit, async (req, res) => {
  const { imdbId } = req.params;
  const title = req.query.title || '';

  try {
    const streams = await getCompleteStreams(title, imdbId);
    res.json({ streams });
  } catch (err) {
    console.error('[API] Complete stream error:', err.message);
    res.status(500).json({ error: 'Failed to fetch complete streams' });
  }
});

// GET /api/streams/diagnose — test connectivity to all providers
app.get('/api/streams/diagnose', rateLimit, async (req, res) => {
  try {
    console.log('[API] Running provider diagnostics...');
    const results = await diagnoseProviders();
    console.log('[API] Diagnostics complete:', JSON.stringify(results._summary));
    res.json(results);
  } catch (err) {
    console.error('[API] Diagnostics error:', err.message);
    res.status(500).json({ error: 'Diagnostics failed' });
  }
});

// GET /api/play/:infoHash — stream video from torrent
// Optional query: ?fileIdx=N&magnet=<uri>
app.get('/api/play/:infoHash', rateLimit, (req, res) => {
  const { infoHash } = req.params;
  if (!/^[0-9a-f]{40}$/i.test(infoHash)) {
    return res.status(400).json({ error: 'Invalid infoHash' });
  }
  const fileIdx = req.query.fileIdx !== undefined
    ? parseInt(req.query.fileIdx, 10)
    : undefined;

  // Validate magnet URI if provided — must be a proper magnet link
  // containing this exact infoHash (prevents using the endpoint to
  // fetch arbitrary content)
  let magnet = infoHash;
  if (req.query.magnet) {
    const magnetStr = req.query.magnet;
    if (!magnetStr.startsWith('magnet:?') ||
        !magnetStr.toLowerCase().includes(infoHash.toLowerCase())) {
      return res.status(400).json({ error: 'Magnet URI does not match infoHash' });
    }
    magnet = magnetStr;
  }

  getEngine().serveStream(req, res, magnet, fileIdx);
});

// GET /api/cache — list items in torrent cache on disk
app.get('/api/cache', async (req, res) => {
  try {
    const cacheDir = TORRENT_CACHE_PATH;
    if (!fs.existsSync(cacheDir)) return res.json({ items: [] });

    const entries = await fs.promises.readdir(cacheDir, { withFileTypes: true });
    const items = [];
    const libraryDirName = path.basename(LIBRARY_PATH);

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === libraryDirName) continue; // skip library subdirectory
      const dirPath = path.join(cacheDir, entry.name);
      const files = await fs.promises.readdir(dirPath).catch(() => []);
      let totalSize = 0;
      let videoFile = null;
      for (const f of files) {
        try {
          const stat = await fs.promises.stat(path.join(dirPath, f));
          totalSize += stat.size;
          if (/\.(mp4|mkv|avi|webm|mov)$/i.test(f) && (!videoFile || stat.size > videoFile.size)) {
            videoFile = { name: f, size: stat.size };
          }
        } catch {}
      }
      items.push({
        name: entry.name,
        totalSize,
        videoFile: videoFile ? videoFile.name : null,
        videoSize: videoFile ? videoFile.size : 0,
      });
    }

    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/torrent-status — list all active torrents
app.get('/api/torrent-status', (req, res) => {
  const eng = getEngine();
  res.json({ torrents: eng.getAllStatus() });
});

// GET /api/play/:infoHash/remux — stream video remuxed from MKV to MP4
// Uses FFmpeg to copy video + transcode audio to AAC in fragmented MP4 container
app.get('/api/play/:infoHash/remux', rateLimit, (req, res) => {
  const { infoHash } = req.params;
  if (!/^[0-9a-f]{40}$/i.test(infoHash)) {
    return res.status(400).json({ error: 'Invalid infoHash' });
  }
  const fileIdx = req.query.fileIdx !== undefined
    ? parseInt(req.query.fileIdx, 10)
    : undefined;

  let magnet = infoHash;
  if (req.query.magnet) {
    const magnetStr = req.query.magnet;
    if (!magnetStr.startsWith('magnet:?') ||
        !magnetStr.toLowerCase().includes(infoHash.toLowerCase())) {
      return res.status(400).json({ error: 'Magnet URI does not match infoHash' });
    }
    magnet = magnetStr;
  }

  getEngine().serveRemuxedStream(req, res, magnet, fileIdx);
});

// GET /api/torrent-status/:infoHash — check download progress
app.get('/api/torrent-status/:infoHash', (req, res) => {
  const { infoHash } = req.params;
  if (!/^[0-9a-f]{40}$/i.test(infoHash)) {
    return res.status(400).json({ error: 'Invalid infoHash' });
  }
  const eng = getEngine();
  const status = eng.getStatus(infoHash);
  if (!status) {
    return res.status(404).json({ error: 'Torrent not active' });
  }
  res.json(status);
});

// ─── Library API Routes ───────────────────────────────────────────────

// GET /api/library — list all library items
app.get('/api/library', (req, res) => {
  try {
    const items = library.getAll();
    console.log(`[Debug] GET /api/library: returning ${items.length} items`);
    res.json({ items });
  } catch (err) {
    console.error('[Library] getAll() failed:', err.message);
    res.status(500).json({ items: [], error: err.message });
  }
});

// GET /api/library/debug — diagnostic endpoint for troubleshooting
app.get('/api/library/debug', (req, res) => {
  const { VIDEO_EXTENSIONS } = require('./lib/file-safety');
  const diag = {};

  // 1. Path configuration
  diag.libraryPath = LIBRARY_PATH;
  diag.torrentCachePath = TORRENT_CACHE_PATH;
  diag.envLibraryPath = process.env.LIBRARY_PATH || '(not set, using default)';
  diag.envTorrentCache = process.env.TORRENT_CACHE || '(not set, using default)';

  // 2. Directory existence and permissions
  try {
    diag.directoryExists = fs.existsSync(LIBRARY_PATH);
    if (diag.directoryExists) {
      const stat = fs.statSync(LIBRARY_PATH);
      diag.directoryMode = '0' + (stat.mode & 0o777).toString(8);
      diag.directoryUid = stat.uid;
    }
  } catch (err) {
    diag.directoryError = err.message;
  }

  // 3. Raw directory listing
  try {
    if (diag.directoryExists) {
      const entries = fs.readdirSync(LIBRARY_PATH, { withFileTypes: true });
      diag.directoryEntries = entries.map(e => ({
        name: e.name,
        isFile: e.isFile(),
        isDirectory: e.isDirectory(),
        ext: path.extname(e.name).toLowerCase(),
      }));
    }
  } catch (err) {
    diag.directoryListError = err.message;
  }

  // 4. Metadata file status
  const metadataPath = path.join(LIBRARY_PATH, '_metadata.json');
  const backupPath = metadataPath + '.bak';
  try {
    diag.metadataExists = fs.existsSync(metadataPath);
    diag.metadataBackupExists = fs.existsSync(backupPath);
    if (diag.metadataExists) {
      const raw = fs.readFileSync(metadataPath, 'utf8');
      diag.metadataSize = raw.length;
      diag.metadataEmpty = !raw.trim();
      try {
        const parsed = JSON.parse(raw);
        diag.metadataIsArray = Array.isArray(parsed);
        diag.metadataItemCount = Array.isArray(parsed) ? parsed.length : null;
      } catch (e) {
        diag.metadataParseError = e.message;
      }
    }
  } catch (err) {
    diag.metadataReadError = err.message;
  }

  // 5. Internal state
  diag.trackedItemCount = library._items.size;
  diag.trackedItemIds = [...library._items.keys()];

  // 6. getAll() result
  try {
    const all = library.getAll();
    diag.getAllCount = all.length;
    diag.getAllSample = all.slice(0, 3);
  } catch (err) {
    diag.getAllError = err.message;
  }

  // 7. VIDEO_EXTENSIONS for reference
  diag.videoExtensions = [...VIDEO_EXTENSIONS];

  // 8. Process info
  diag.processUid = process.getuid ? process.getuid() : 'N/A';
  diag.processCwd = process.cwd();

  res.json(diag);
});

// GET /api/library/:id — get single library item
app.get('/api/library/:id', (req, res) => {
  const item = library.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  res.json(item);
});

// POST /api/library/add — add item to library and start download
app.post('/api/library/add', rateLimit, (req, res) => {
  const { imdbId, type, name, poster, year, magnetUri, infoHash, quality, size, season, episode } = req.body;

  if (!infoHash || !/^[0-9a-f]{40}$/i.test(infoHash)) {
    return res.status(400).json({ error: 'Invalid infoHash' });
  }
  if (!magnetUri || !magnetUri.startsWith('magnet:?')) {
    return res.status(400).json({ error: 'Invalid magnet URI' });
  }
  if (!magnetUri.toLowerCase().includes(infoHash.toLowerCase())) {
    return res.status(400).json({ error: 'Magnet URI does not match infoHash' });
  }

  try {
    const result = library.addItem({ imdbId, type, name, poster, year, magnetUri, infoHash, quality, size, season, episode });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/library/add-pack — add season pack to library (downloads all episodes)
app.post('/api/library/add-pack', rateLimit, async (req, res) => {
  const { imdbId, name, poster, year, magnetUri, infoHash, quality, size, season } = req.body;

  if (!infoHash || !/^[0-9a-f]{40}$/i.test(infoHash)) {
    return res.status(400).json({ error: 'Invalid infoHash' });
  }
  if (!magnetUri || !magnetUri.startsWith('magnet:?')) {
    return res.status(400).json({ error: 'Invalid magnet URI' });
  }
  if (!magnetUri.toLowerCase().includes(infoHash.toLowerCase())) {
    return res.status(400).json({ error: 'Magnet URI does not match infoHash' });
  }
  if (season === undefined || season === null) {
    return res.status(400).json({ error: 'season is required' });
  }

  try {
    const result = await library.addSeasonPack({ imdbId, name, poster, year, magnetUri, infoHash, quality, size, season });

    // After pack is created, resolve correct TMDB metadata for any episodes
    // whose filename-derived show name differs from the torrent-level name.
    // This runs in the background so it doesn't block the response.
    if (result.items && result.items.length > 0 && TMDB_API_KEY) {
      (async () => {
        try {
          const allItems = library.getAll();
          const packItems = allItems.filter(i => i.type === 'series' && i.packId === `pack_${infoHash}`);
          // Group by unique showName to minimize TMDB lookups
          const showNames = [...new Set(packItems.map(i => i.showName).filter(Boolean))];
          const torrentName = name || '';

          for (const sn of showNames) {
            // Skip if show name matches the torrent-level name (already has correct metadata)
            if (sn.toLowerCase() === torrentName.toLowerCase()) continue;

            const meta = await lookupShowByName(sn);
            if (!meta || !meta.imdbId) continue;

            // Update all episodes with this show name
            for (const ep of packItems) {
              if (ep.showName === sn) {
                library.relinkItem(ep.id, {
                  imdbId: meta.imdbId,
                  showName: meta.name,
                  poster: meta.poster,
                  year: meta.year,
                });
              }
            }
            console.log(`[Library] Resolved "${sn}" -> ${meta.name} (${meta.imdbId})`);
          }
        } catch (err) {
          console.warn('[Library] Background metadata resolution failed:', err.message);
        }
      })();
    }

    res.json(result);
  } catch (err) {
    console.error('[API] Season pack download error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/library/repair-metadata — one-time repair: re-derive show names from filenames
// and look up correct IMDB IDs, posters, and year from TMDB.
app.post('/api/library/repair-metadata', rateLimit, async (req, res) => {
  if (!TMDB_API_KEY) {
    return res.status(400).json({ error: 'TMDB API key not configured' });
  }

  try {
    const allItems = library.getAll();
    const seriesItems = allItems.filter(i => i.type === 'series' && i.fileName);

    // Derive show names from filenames and group episodes
    const showMap = new Map(); // showName -> [item ids]
    for (const item of seriesItems) {
      const derivedName = library._deriveShowNameFromFile(item.fileName);
      if (!derivedName) continue;

      // Only process items where the derived name differs from current showName
      if (derivedName.toLowerCase() !== (item.showName || '').toLowerCase()) {
        if (!showMap.has(derivedName)) showMap.set(derivedName, []);
        showMap.get(derivedName).push(item.id);
      }
    }

    const repaired = [];

    // Look up each unique show name on TMDB
    for (const [derivedName, itemIds] of showMap) {
      const meta = await lookupShowByName(derivedName);
      const updates = {
        showName: (meta && meta.name) || derivedName,
        imdbId: meta && meta.imdbId ? meta.imdbId : undefined,
        poster: meta ? meta.poster : undefined,
        year: meta ? meta.year : undefined,
      };

      for (const id of itemIds) {
        library.relinkItem(id, updates);
      }

      repaired.push({
        showName: updates.showName,
        imdbId: updates.imdbId || 'not found',
        episodesUpdated: itemIds.length,
      });
      console.log(`[Repair] "${derivedName}" -> ${updates.showName} (${updates.imdbId || 'no IMDB'}), ${itemIds.length} episodes`);
    }

    res.json({ repaired, totalUpdated: repaired.reduce((s, r) => s + r.episodesUpdated, 0) });
  } catch (err) {
    console.error('[API] Repair metadata error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/library/restart-pack — restart a pack download (re-scan torrent for all episodes)
app.post('/api/library/restart-pack', rateLimit, async (req, res) => {
  const { packId } = req.body;
  if (!packId) return res.status(400).json({ error: 'packId is required' });

  try {
    const result = await library.restartPack(packId);
    res.json(result);
  } catch (err) {
    console.error('[API] Restart pack error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/library/:id — remove item from library
app.delete('/api/library/:id', rateLimit, (req, res) => {
  const removed = library.removeItem(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Item not found' });
  res.json({ success: true });
});

// POST /api/library/:id/pause — pause a downloading item
app.post('/api/library/:id/pause', rateLimit, (req, res) => {
  const paused = library.pauseItem(req.params.id);
  if (!paused) return res.status(400).json({ error: 'Cannot pause this item' });
  res.json({ success: true });
});

// POST /api/library/:id/resume — resume a paused item
app.post('/api/library/:id/resume', rateLimit, (req, res) => {
  const resumed = library.resumeItem(req.params.id);
  if (!resumed) return res.status(400).json({ error: 'Cannot resume this item' });
  res.json({ success: true });
});

// POST /api/library/:id/retry — retry a failed download
app.post('/api/library/:id/retry', rateLimit, (req, res) => {
  const retried = library.retryItem(req.params.id);
  if (!retried) return res.status(400).json({ error: 'Cannot retry this item' });
  res.json({ success: true });
});

// POST /api/library/:id/reorder — reorder a queued item
app.post('/api/library/:id/reorder', rateLimit, (req, res) => {
  const position = parseInt(req.body.position, 10);
  if (isNaN(position) || position < 0) {
    return res.status(400).json({ error: 'Invalid position' });
  }
  const reordered = library.reorderQueue(req.params.id, position);
  if (!reordered) return res.status(400).json({ error: 'Cannot reorder this item' });
  res.json({ success: true });
});

// POST /api/library/bulk-relink — re-link all episodes matching a showName to a new IMDB entry.
// Auto-fetches poster from TMDB if not provided.
app.post('/api/library/bulk-relink', rateLimit, async (req, res) => {
  const { matchShowName, imdbId, showName, year } = req.body || {};
  if (!matchShowName) return res.status(400).json({ error: 'matchShowName is required' });
  if (!imdbId || !/^tt\d{1,10}$/.test(imdbId)) return res.status(400).json({ error: 'Valid imdbId is required' });

  // Auto-fetch poster and year from TMDB if available
  let poster = req.body.poster || null;
  let resolvedYear = year;
  if (TMDB_API_KEY) {
    try {
      const findData = await tmdbFetch('/find/' + imdbId, { external_source: 'imdb_id' });
      const tvResults = findData.tv_results || [];
      if (tvResults.length > 0) {
        const show = tvResults[0];
        if (!poster && show.poster_path) poster = `https://image.tmdb.org/t/p/w342${show.poster_path}`;
        if (!resolvedYear) resolvedYear = (show.first_air_date || '').slice(0, 4);
      }
    } catch (err) {
      console.warn('[Bulk-relink] TMDB poster lookup failed:', err.message);
    }
  }

  const allItems = library.getAll();
  const matches = allItems.filter(i => i.showName === matchShowName);
  let updated = 0;

  for (const item of matches) {
    const success = library.relinkItem(item.id, {
      imdbId,
      showName: showName || matchShowName,
      poster,
      year: resolvedYear,
    });
    if (success) updated++;
  }

  console.log(`[Bulk-relink] "${matchShowName}" -> "${showName || matchShowName}" (${imdbId}), ${updated}/${matches.length} updated`);
  res.json({ matched: matches.length, updated, showName: showName || matchShowName, imdbId, poster, year: resolvedYear });
});

// POST /api/library/:id/relink — manually re-link a library item to a different IMDB entry
app.post('/api/library/:id/relink', rateLimit, (req, res) => {
  const { imdbId, name, poster, year, type, showName } = req.body || {};
  if (!imdbId) return res.status(400).json({ error: 'imdbId is required' });
  if (!/^tt\d{1,10}$/.test(imdbId)) return res.status(400).json({ error: 'Invalid IMDB ID format' });

  const success = library.relinkItem(req.params.id, { imdbId, name, poster, year, type, showName });
  if (!success) return res.status(404).json({ error: 'Item not found' });
  res.json({ success: true });
});

// GET /api/library/:id/stream — stream a completed library item
app.get('/api/library/:id/stream', async (req, res) => {
  const item = library.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.status !== 'complete' && item.status !== 'converting') {
    return res.status(400).json({ error: 'Download not complete' });
  }

  const filePath = library.getFilePath(req.params.id);
  if (!filePath) return res.status(404).json({ error: 'File not found' });

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  const fileSize = stat.size;
  const mimeType = library.getMimeType(filePath);
  const safeFilename = path.basename(filePath).replace(/[^\w\s.\-()[\]]/g, '_').substring(0, 200);

  const headers = {
    'Content-Type': mimeType,
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename="${safeFilename}"`,
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
  };

  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize || start > end) {
      res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
      return;
    }

    res.status(206).set({
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': end - start + 1,
    });

    const stream = fs.createReadStream(filePath, { start, end });
    stream.pipe(res);
    stream.on('error', () => res.end());
    res.on('close', () => stream.destroy());
  } else {
    res.status(200).set({ ...headers, 'Content-Length': fileSize });
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('error', () => res.end());
    res.on('close', () => stream.destroy());
  }
});

// GET /api/library/:id/stream/remux — stream a library file remuxed to MP4 (AAC audio)
app.get('/api/library/:id/stream/remux', async (req, res) => {
  const item = library.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.status !== 'complete' && item.status !== 'converting') {
    return res.status(400).json({ error: 'Download not complete' });
  }

  const filePath = library.getFilePath(req.params.id);
  if (!filePath) return res.status(404).json({ error: 'File not found' });

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  const safeFilename = path.basename(filePath).replace(/[^\w\s.\-()[\]]/g, '_').replace(/\.(mkv|avi|wmv|mp4)$/i, '.mp4').substring(0, 200);
  const { spawn } = require('child_process');

  res.status(200);
  res.set({
    'Content-Type': 'video/mp4',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename="${safeFilename}"`,
    'Cache-Control': 'no-store',
    'Transfer-Encoding': 'chunked',
  });

  // Pipe file through stdin (like the working torrent stream remux) so ffmpeg
  // processes sequentially instead of seeking around the file on disk.
  const ffmpeg = spawn('ffmpeg', [
    '-probesize', '5000000',
    '-analyzeduration', '5000000',
    '-i', 'pipe:0',
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', 'frag_keyframe+empty_moov',
    '-f', 'mp4',
    '-loglevel', 'warning',
    'pipe:1',
  ]);

  const source = fs.createReadStream(filePath);
  source.pipe(ffmpeg.stdin);

  ffmpeg.stdout.pipe(res);

  source.on('error', (err) => {
    console.error(`[Library] Source stream error during remux: ${err.message}`);
    ffmpeg.kill('SIGTERM');
  });

  ffmpeg.stdin.on('error', () => {
    // FFmpeg closed stdin early (e.g., client disconnected) — not a real error
  });

  ffmpeg.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.log(`[FFmpeg/Library] ${msg}`);
  });

  ffmpeg.on('error', (err) => {
    console.error(`[Library] FFmpeg spawn error: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Remux failed — FFmpeg not available' });
    }
  });

  ffmpeg.on('close', (code) => {
    if (code && code !== 0 && code !== 255) {
      console.warn(`[Library] FFmpeg exited with code ${code}`);
    }
    source.destroy();
    res.end();
  });

  res.on('close', () => {
    source.destroy();
    ffmpeg.kill('SIGTERM');
  });
});

// GET /api/library/:id/probe — check if file is directly browser-playable
app.get('/api/library/:id/probe', async (req, res) => {
  const item = library.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.status !== 'complete' && item.status !== 'converting') {
    return res.status(400).json({ error: 'Download not complete' });
  }

  const filePath = library.getFilePath(req.params.id);
  if (!filePath) return res.status(404).json({ error: 'File not found' });

  const ext = path.extname(filePath).toLowerCase();
  const { spawn } = require('child_process');

  // Use ffprobe to check container and codec info
  const ffprobe = spawn('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);

  let output = '';
  ffprobe.stdout.on('data', (d) => { output += d.toString(); });

  ffprobe.on('close', (code) => {
    if (code !== 0) {
      return res.json({ directPlay: false, reason: 'ffprobe failed' });
    }

    try {
      const info = JSON.parse(output);
      const videoStream = (info.streams || []).find(s => s.codec_type === 'video');
      const audioStream = (info.streams || []).find(s => s.codec_type === 'audio');

      const videoCodec = videoStream ? videoStream.codec_name : null;
      const audioCodec = audioStream ? audioStream.codec_name : null;
      const container = info.format ? info.format.format_name : null;
      const duration = info.format ? parseFloat(info.format.duration) : null;

      // Browser-compatible: MP4 container + H.264 video + AAC audio
      const compatibleVideo = ['h264', 'hevc'].includes(videoCodec);
      const compatibleAudio = !audioStream || ['aac', 'mp3'].includes(audioCodec);
      const compatibleContainer = ext === '.mp4' || ext === '.m4v';
      const directPlay = compatibleVideo && compatibleAudio && compatibleContainer;

      res.json({
        directPlay,
        container,
        ext,
        videoCodec,
        audioCodec,
        duration,
        reason: !directPlay
          ? (!compatibleContainer ? 'container needs remux' : !compatibleVideo ? 'video codec incompatible' : 'audio codec needs transcode')
          : null,
      });
    } catch {
      res.json({ directPlay: false, reason: 'probe parse error' });
    }
  });

  ffprobe.on('error', () => {
    res.json({ directPlay: false, reason: 'ffprobe not available' });
  });
});

// ─── Stremio Addon Proxy ──────────────────────────────────────────────
// Proxy JSON requests to Stremio addons to avoid CORS issues.
const ADDON_JSON_PATH_RE = /^\/(manifest\.json|catalog\/|meta\/|stream\/)/;
app.get('/api/addon-proxy', rateLimit, async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'Missing url parameter' });

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'Invalid URL protocol' });
  }

  if (!ADDON_JSON_PATH_RE.test(parsed.pathname)) {
    return res.status(400).json({ error: 'Disallowed path' });
  }

  try {
    await validateUrlNotSSRF(targetUrl);
    const body = await fetchUrl(targetUrl);
    const data = JSON.parse(body);
    res.json(data);
  } catch (err) {
    console.error(`[AddonProxy] Error fetching ${targetUrl}: ${err.message}`);
    res.status(502).json({ error: 'Failed to fetch addon data' });
  }
});

// ─── IPTV / Live TV Endpoints ─────────────────────────────────────────

// In-memory playlist cache: Map<url, { channels, fetchedAt }>
const playlistCache = new Map();
const PLAYLIST_CACHE_MAX = 20;
const PLAYLIST_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// ─── SSRF Protection ──────────────────────────────────────────────────
const BLOCKED_IP_RANGES = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^169\.254\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./, /^::1$/,
  /^fc00:/, /^fe80:/, /^fd/, /^localhost$/i,
];

function isBlockedHost(hostname) {
  return BLOCKED_IP_RANGES.some(re => re.test(hostname));
}

async function validateUrlNotSSRF(urlStr) {
  const parsed = new URL(urlStr);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Invalid URL protocol');
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new Error('Blocked host');
  }
  // Resolve DNS to check the actual IP
  try {
    const { address } = await dns.promises.lookup(parsed.hostname);
    if (isBlockedHost(address)) {
      throw new Error('Blocked host (resolved IP)');
    }
  } catch (err) {
    if (err.message.includes('Blocked')) throw err;
    // DNS resolution failure — allow the request to fail naturally
  }
}

const MAX_REDIRECTS = 5;

function fetchUrl(url, redirectCount = 0) {
  if (redirectCount > MAX_REDIRECTS) {
    return Promise.reject(new Error('Too many redirects'));
  }
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Albatross/1.0' }, timeout: 8000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, redirectCount + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function parseM3U(text) {
  const lines = text.split('\n').map(l => l.trim());
  const channels = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXTINF:')) continue;
    const info = lines[i];
    const urlLine = lines[i + 1];
    if (!urlLine || urlLine.startsWith('#')) continue;

    // Parse attributes from #EXTINF line
    const nameMatch = info.match(/,(.+)$/);
    const logoMatch = info.match(/tvg-logo="([^"]*)"/);
    const groupMatch = info.match(/group-title="([^"]*)"/);
    const idMatch = info.match(/tvg-id="([^"]*)"/);
    const tvgNameMatch = info.match(/tvg-name="([^"]*)"/);
    const countryMatch = info.match(/tvg-country="([^"]*)"/);
    const languageMatch = info.match(/tvg-language="([^"]*)"/);

    const name = (nameMatch ? nameMatch[1].trim() : 'Unknown');
    const group = groupMatch ? groupMatch[1] : '';
    const country = countryMatch ? countryMatch[1] : '';
    const language = languageMatch ? languageMatch[1] : '';

    channels.push({
      id: idMatch ? idMatch[1] : String(channels.length),
      name,
      tvgName: tvgNameMatch ? tvgNameMatch[1] : '',
      logo: logoMatch ? logoMatch[1] : '',
      group,
      country,
      language,
      url: urlLine,
      // Pre-computed lowercase search text for fast filtering
      _search: `${name} ${group} ${country} ${language}`.toLowerCase(),
    });
  }
  return channels;
}

// GET /api/iptv/channels?url=<m3u-playlist-url>[&search=X&group=X&country=X&limit=N&offset=N]
app.get('/api/iptv/channels', rateLimit, async (req, res) => {
  const playlistUrl = req.query.url;
  if (!playlistUrl) return res.status(400).json({ error: 'Missing url parameter' });

  try {
    await validateUrlNotSSRF(playlistUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid or blocked URL' });
  }

  // Fetch and cache playlist
  let channels;
  const cached = playlistCache.get(playlistUrl);
  if (cached && Date.now() - cached.fetchedAt < PLAYLIST_CACHE_TTL) {
    channels = cached.channels;
  } else {
    try {
      const body = await fetchUrl(playlistUrl);
      channels = parseM3U(body);
      if (playlistCache.size >= PLAYLIST_CACHE_MAX) {
        const oldest = playlistCache.keys().next().value;
        playlistCache.delete(oldest);
      }
      playlistCache.set(playlistUrl, { channels, fetchedAt: Date.now() });
    } catch (err) {
      console.error('[IPTV] Playlist fetch error:', err.message);
      return res.status(502).json({ error: 'Failed to fetch playlist' });
    }
  }

  // Apply optional search/filter params (no-op if none provided)
  let filtered = channels;
  const search = (req.query.search || '').trim().toLowerCase();
  const group = (req.query.group || '').trim();
  const country = (req.query.country || '').trim();

  if (search) {
    filtered = filtered.filter(ch => ch._search.includes(search));
  }
  if (group) {
    filtered = filtered.filter(ch => ch.group === group);
  }
  if (country) {
    const lc = country.toLowerCase();
    filtered = filtered.filter(ch => ch.country.toLowerCase().includes(lc));
  }

  // Pagination
  const limit = Math.min(parseInt(req.query.limit, 10) || 0, 500);
  const offset = parseInt(req.query.offset, 10) || 0;
  const total = filtered.length;
  if (limit > 0) {
    filtered = filtered.slice(offset, offset + limit);
  }

  // Build group list from full (unfiltered) channels for filter UI
  const groups = req.query.groups === '1'
    ? [...new Set(channels.map(ch => ch.group).filter(Boolean))].sort()
    : undefined;

  res.json({ channels: filtered, total, groups });
});

// GET /api/iptv/stream?url=<stream-url> — proxy HLS/stream to avoid CORS
app.get('/api/iptv/stream', rateLimit, async (req, res) => {
  const streamUrl = req.query.url;
  if (!streamUrl) return res.status(400).json({ error: 'Missing url parameter' });

  let parsedUrl;
  try {
    parsedUrl = new URL(streamUrl);
    await validateUrlNotSSRF(streamUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid or blocked URL' });
  }

  const mod = parsedUrl.protocol === 'https:' ? https : http;
  const proxyReq = mod.get(streamUrl, {
    headers: { 'User-Agent': 'Albatross/1.0' },
    timeout: 15000,
  }, (upstream) => {
    if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
      // Follow redirect through proxy (SSRF check happens on re-entry)
      const redirectCount = parseInt(req.query._rd || '0', 10);
      if (redirectCount >= MAX_REDIRECTS) {
        upstream.resume();
        return res.status(502).json({ error: 'Too many redirects' });
      }
      const rdUrl = '/api/iptv/stream?url=' + encodeURIComponent(upstream.headers.location) + '&_rd=' + (redirectCount + 1);
      res.redirect(302, rdUrl);
      upstream.resume();
      return;
    }

    const ct = upstream.headers['content-type'] || '';
    res.setHeader('Content-Type', ct || 'application/octet-stream');
    if (upstream.headers['content-length']) {
      res.setHeader('Content-Length', upstream.headers['content-length']);
    }

    // If m3u8 playlist, rewrite URLs to go through proxy
    if (streamUrl.endsWith('.m3u8') || ct.includes('mpegurl')) {
      let body = '';
      upstream.setEncoding('utf8');
      upstream.on('data', chunk => body += chunk);
      upstream.on('end', () => {
        // Resolve relative URLs against the original stream URL
        const base = streamUrl.substring(0, streamUrl.lastIndexOf('/') + 1);
        const rewritten = body.replace(/^(?!#)(\S+)$/gm, (match) => {
          const absolute = match.startsWith('http') ? match : base + match;
          return '/api/iptv/stream?url=' + encodeURIComponent(absolute);
        });
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(rewritten);
      });
    } else {
      upstream.pipe(res);
    }
  });
  proxyReq.on('error', (err) => {
    console.error('[IPTV] Stream proxy error:', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Stream unavailable' });
  });
  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).json({ error: 'Stream timeout' });
  });
});


// ─── Concurrent Streams Settings API ──────────────────────────────────
app.get('/api/settings/max-streams', (req, res) => {
  res.json({ maxConcurrentStreams: MAX_CONCURRENT_STREAMS });
});

app.post('/api/settings/max-streams', (req, res) => {
  const value = parseInt(req.body.maxConcurrentStreams, 10);
  if (!value || value < 1 || value > 20) {
    return res.status(400).json({ error: 'maxConcurrentStreams must be between 1 and 20' });
  }
  MAX_CONCURRENT_STREAMS = value;
  // Update running engines
  if (engine) engine._maxConcurrent = value;
  library._maxConcurrentDownloads = value;
  // Persist to disk
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ maxConcurrentStreams: value }), 'utf8');
  } catch (e) {
    console.warn('[Settings] Failed to persist settings:', e.message);
  }
  console.log(`[Settings] Max concurrent streams updated to ${value}`);
  res.json({ maxConcurrentStreams: value });
});

// ─── Cast / Local Discovery API ──────────────────────────────────────
// These endpoints let a Tailscale-connected phone discover and cast to devices
// on the Jetson's local network. The Jetson acts as the casting bridge.

// Device discovery cache (refreshed on demand, cached briefly)
let discoveryCache = { devices: [], fetchedAt: 0 };
const DISCOVERY_CACHE_TTL = 15 * 1000; // 15 seconds

// GET /api/cast/devices — discover castable devices on LAN
app.get('/api/cast/devices', rateLimit, async (req, res) => {
  const forceRefresh = req.query.refresh === '1';
  const now = Date.now();

  if (!forceRefresh && discoveryCache.devices.length > 0 &&
      now - discoveryCache.fetchedAt < DISCOVERY_CACHE_TTL) {
    return res.json({
      devices: discoveryCache.devices,
      cached: true,
      localIP: getLocalIP(),
      chromecastSupported: castManager.isCastv2Available(),
    });
  }

  try {
    console.log('[Cast API] Scanning for local devices...');
    const devices = await discoverDevices(5000);
    discoveryCache = { devices, fetchedAt: Date.now() };
    console.log(`[Cast API] Found ${devices.length} castable device(s)`);
    res.json({
      devices,
      cached: false,
      localIP: getLocalIP(),
      chromecastSupported: castManager.isCastv2Available(),
    });
  } catch (err) {
    console.error('[Cast API] Discovery error:', err.message);
    res.status(500).json({ error: 'Device discovery failed' });
  }
});

// POST /api/cast/play — start casting to a device
// Body: { device, streamUrl, title, mimeType }
//   - device: a device object from /api/cast/devices
//   - streamUrl: the path to the stream (e.g. /api/play/<hash> or /api/library/<id>/stream)
//   - title: display title
//   - mimeType: optional, defaults to video/mp4
app.post('/api/cast/play', rateLimit, async (req, res) => {
  const { device, streamPath, title, mimeType } = req.body;

  if (!device || !device.id || !device.type) {
    return res.status(400).json({ error: 'Invalid device' });
  }
  if (!streamPath) {
    return res.status(400).json({ error: 'Missing streamPath' });
  }

  // Build a LAN-reachable URL for the cast device
  // The stream path is relative to this server, so we build an absolute URL
  // using the server's LAN IP (not Tailscale IP)
  const lanIP = getLocalIP();
  const mediaUrl = `http://${lanIP}:${PORT}${streamPath}`;

  try {
    console.log(`[Cast API] Casting to ${device.friendlyName}: ${mediaUrl}`);
    await castManager.castToDevice(device, mediaUrl, title || 'Albatross', mimeType || 'video/mp4');
    res.json({ success: true, mediaUrl, device: device.friendlyName });
  } catch (err) {
    console.error(`[Cast API] Cast failed: ${err.message}`);
    res.status(500).json({ error: `Cast failed: ${err.message}` });
  }
});

// POST /api/cast/stop — stop casting on a device
app.post('/api/cast/stop', rateLimit, async (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ error: 'Missing deviceId' });

  try {
    await castManager.stopDevice(deviceId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cast/pause — toggle pause on a device
app.post('/api/cast/pause', rateLimit, async (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ error: 'Missing deviceId' });

  try {
    const status = await castManager.pauseDevice(deviceId);
    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cast/status/:deviceId — get playback status
app.get('/api/cast/status/:deviceId', async (req, res) => {
  const status = await castManager.getDeviceStatus(req.params.deviceId);
  if (!status) return res.status(404).json({ error: 'No active session' });
  res.json(status);
});

// GET /api/cast/sessions — list all active cast sessions
app.get('/api/cast/sessions', (req, res) => {
  res.json({ sessions: castManager.getAllSessions() });
});

// Serve static files (no caching for JS/CSS to avoid stale code)
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

// Lightweight health endpoint for Docker HEALTHCHECK
app.get('/health', (req, res) => {
  res.status(200).send('ok');
});

// Health endpoint for VPN detection (if the client can reach this, the server is accessible)
app.get('/api/stats', (req, res) => {
  res.json({ ok: true });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Albatross Mobile UI running on http://0.0.0.0:${PORT}`);
  console.log(`Stream endpoints: /api/streams/* and /api/play/*`);
});

// Graceful shutdown with timeout to ensure metadata is saved even if engines hang
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[Server] Shutting down gracefully...');

  // Force exit after 8s if cleanup hangs (Docker sends SIGKILL at 10s)
  const forceExit = setTimeout(() => {
    console.error('[Server] Shutdown timeout — forcing exit');
    process.exit(1);
  }, 8000);
  forceExit.unref();

  clearInterval(rateLimitCleanupTimer);
  try { library.destroy(); } catch (err) {
    console.error(`[Server] Library shutdown error: ${err.message}`);
  }
  try { if (engine) engine.destroy(); } catch (err) {
    console.error(`[Server] Engine shutdown error: ${err.message}`);
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
