const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const dns = require('dns');
const { spawn } = require('child_process');

// ─── DNS Fallback (matches stream-providers.js) ──────────────────────
const fallbackResolver = new dns.Resolver();
fallbackResolver.setServers(['1.1.1.1', '8.8.8.8', '1.0.0.1', '8.8.4.4']);

function resolveWithFallback(hostname) {
  return new Promise((resolve, reject) => {
    dns.resolve4(hostname, (err, addresses) => {
      if (!err && addresses && addresses.length > 0) {
        return resolve(addresses[0]);
      }
      console.log(`[DNS] System DNS failed for ${hostname}, trying fallback resolvers...`);
      fallbackResolver.resolve4(hostname, (err2, addresses2) => {
        if (!err2 && addresses2 && addresses2.length > 0) {
          console.log(`[DNS] Fallback resolved ${hostname} → ${addresses2[0]}`);
          return resolve(addresses2[0]);
        }
        reject(err2 || err);
      });
    });
  });
}
// http-proxy-middleware removed — Stremio server proxy no longer needed
const {
  getMovieStreams, getSeriesStreams, getSeasonPackStreams, getCompleteStreams, diagnoseProviders,
  httpsAgent: providersHttpsAgent,
} = require('./lib/stream-providers');
const TorrentEngine = require('./lib/torrent-engine');
const LibraryManager = require('./lib/library-manager');
const { getSystemDiag } = require('./lib/system-diag');
const { discoverDevices, getLocalIP } = require('./lib/local-discovery');
const castManager = require('./lib/cast-manager');

const app = express();
const PORT = process.env.PORT || 8080;
const TORRENT_CACHE_PATH = process.env.TORRENT_CACHE || path.join(__dirname, '.torrent-cache');
const LIBRARY_PATH = process.env.LIBRARY_PATH || path.join(TORRENT_CACHE_PATH, 'library');
const SETTINGS_PATH = path.join(TORRENT_CACHE_PATH, 'settings.json');

// Optional ffmpeg hwaccel for the live transcode endpoint. Mirrors the
// FFMPEG_HWACCEL handling in lib/library-manager.js — set =cuda / =nvdec /
// =v4l2m2m to offload decode to NVDEC on Jetson and free CPU for libx264.
const FFMPEG_HWACCEL = (process.env.FFMPEG_HWACCEL || '').trim();
const FFMPEG_HWACCEL_ARGS = FFMPEG_HWACCEL ? ['-hwaccel', FFMPEG_HWACCEL] : [];
// Default is intentionally low. 6 concurrent torrents on a Jetson-class box
// starve each other for CPU (piece verify), disk I/O (random writes on eMMC/SD),
// and BT reciprocity slots, so aggregate throughput is usually *better* with
// fewer parallel downloads that individually saturate available resources.
// Override with the MAX_CONCURRENT_STREAMS env var or the in-app setting.
let MAX_CONCURRENT_STREAMS = parseInt(process.env.MAX_CONCURRENT_STREAMS, 10) || 2;

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
// WORKER_URL points at the optional remote GPU conversion worker (a small
// HTTP service running on a Windows PC with NVENC). When set AND reachable,
// background transcodes are streamed there over Tailscale instead of
// running libx264 on the Orin's CPU. See worker/README.md.
const WORKER_URL    = process.env.WORKER_URL || '';
const WORKER_SECRET = process.env.WORKER_SECRET || '';
const library = new LibraryManager({
  libraryPath: LIBRARY_PATH,
  maxConcurrentDownloads: MAX_CONCURRENT_STREAMS,
  workerUrl: WORKER_URL,
  workerSecret: WORKER_SECRET,
});

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
    const deadline = setTimeout(() => {
      if (req) req.destroy();
      reject(new Error('Timeout'));
    }, 10000);
    // Reuse the keep-alive agent from stream-providers so per-page-load TMDB
    // calls (search, details, season metadata) skip the TLS handshake on
    // the Orin's CPU after the first one.
    const req = https.get(url, { timeout: 10000, family: 4, agent: providersHttpsAgent }, (res) => {
      if (res.statusCode !== 200) { clearTimeout(deadline); res.resume(); return reject(new Error(`TMDB HTTP ${res.statusCode}`)); }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        clearTimeout(deadline);
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', (e) => { clearTimeout(deadline); reject(e); });
    req.on('timeout', () => { clearTimeout(deadline); req.destroy(); reject(new Error('Timeout')); });
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

    // For movies, expose the TMDB collection so the client can auto-play the
    // next entry in a franchise when the current one ends.
    if (type === 'movie' && data.belongs_to_collection) {
      meta.collectionId = data.belongs_to_collection.id;
      meta.collectionName = data.belongs_to_collection.name;
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

    // For movies, expose the TMDB collection so the client can auto-play the
    // next entry in a franchise when the current one ends.
    if (type === 'movie' && data.belongs_to_collection) {
      meta.collectionId = data.belongs_to_collection.id;
      meta.collectionName = data.belongs_to_collection.name;
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

    // Evict stale entries to prevent unbounded cache growth
    if (collectionDetailCache.size > 200) {
      const now = Date.now();
      for (const [key, val] of collectionDetailCache) {
        if (now - val.ts > COLLECTION_DETAIL_TTL) collectionDetailCache.delete(key);
      }
    }
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
 * If the full name doesn't produce a good match, progressively drops trailing
 * words and retries (e.g. "Naruto Shippuden Cuarta Guerra Mundial Shinobi"
 * -> "Naruto Shippuden Cuarta Guerra Mundial" -> ... -> "Naruto Shippuden").
 * Returns { imdbId, poster, year, name } or null if not found.
 */
async function lookupShowByName(showName) {
  if (!TMDB_API_KEY || !showName) return null;

  // Strip trailing year in parentheses e.g. "Mad Men (2007)" -> "Mad Men"
  const cleaned = showName.trim().replace(/\s*\(\d{4}\)\s*$/, '').replace(/\s+\d{4}\s*$/, '');
  const words = cleaned.split(/\s+/);
  // Try the full name first, then progressively shorter (minimum 2 words)
  for (let len = words.length; len >= Math.min(2, words.length); len--) {
    const query = words.slice(0, len).join(' ');
    try {
      const data = await tmdbFetch('/search/tv', { query, include_adult: 'false' });
      const results = data.results || [];
      if (results.length === 0) continue;

      // Pick the best match by relevance score against the query used
      results.sort((a, b) => relevanceScore(b.name || '', query) - relevanceScore(a.name || '', query));
      const best = results[0];

      // Require a minimum relevance to avoid false matches on short queries
      const score = relevanceScore(best.name || '', query);
      if (score < 0.3 && len < words.length) continue;

      // Resolve IMDB ID
      const ext = await tmdbFetch(`/tv/${best.id}/external_ids`);
      const imdbId = ext.imdb_id || null;
      const poster = best.poster_path
        ? `https://image.tmdb.org/t/p/w342${best.poster_path}`
        : null;
      const year = (best.first_air_date || '').slice(0, 4);

      console.log(`[TMDB] lookupShowByName("${showName}") matched "${best.name}" using query "${query}"`);
      return { imdbId, poster, year, name: best.name || showName };
    } catch (err) {
      console.warn(`[TMDB] lookupShowByName query="${query}" failed:`, err.message);
    }
  }
  return null;
}

/**
 * Search TMDB for a movie by name (and optional year hint) and return the
 * best match's metadata. Like lookupShowByName, it progressively drops trailing
 * words if the full query doesn't produce a confident match. If the year-scoped
 * search comes up empty the query is retried without the year filter.
 * Returns { imdbId, poster, year, name } or null if not found.
 */
async function lookupMovieByName(movieName, yearHint) {
  if (!TMDB_API_KEY || !movieName) return null;

  // Strip trailing year in parentheses e.g. "Inception (2010)" -> "Inception"
  const cleaned = movieName.trim().replace(/\s*\(\d{4}\)\s*$/, '').replace(/\s+\d{4}\s*$/, '');
  const words = cleaned.split(/\s+/);
  for (let len = words.length; len >= Math.min(2, words.length); len--) {
    const query = words.slice(0, len).join(' ');
    try {
      const params = { query, include_adult: 'false' };
      if (yearHint) params.year = yearHint;
      let data = await tmdbFetch('/search/movie', params);
      let results = data.results || [];
      // If a year filter yielded nothing, retry without the year
      if (results.length === 0 && yearHint) {
        data = await tmdbFetch('/search/movie', { query, include_adult: 'false' });
        results = data.results || [];
      }
      if (results.length === 0) continue;

      results.sort((a, b) => relevanceScore(b.title || '', query) - relevanceScore(a.title || '', query));
      const best = results[0];

      const score = relevanceScore(best.title || '', query);
      if (score < 0.3 && len < words.length) continue;

      const ext = await tmdbFetch(`/movie/${best.id}/external_ids`);
      const imdbId = ext.imdb_id || null;
      const poster = best.poster_path
        ? `https://image.tmdb.org/t/p/w342${best.poster_path}`
        : null;
      const year = (best.release_date || '').slice(0, 4);

      console.log(`[TMDB] lookupMovieByName("${movieName}") matched "${best.title}" using query "${query}"`);
      return { imdbId, poster, year, name: best.title || movieName };
    } catch (err) {
      console.warn(`[TMDB] lookupMovieByName query="${query}" failed:`, err.message);
    }
  }
  return null;
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

// GET /api/torrent-status/:infoHash/bottleneck — diagnose speed bottleneck
// Compares torrent swarm download speed vs client egress rate to determine
// whether the torrent or the server/network is the limiting factor.
app.get('/api/torrent-status/:infoHash/bottleneck', (req, res) => {
  const { infoHash } = req.params;
  if (!/^[0-9a-f]{40}$/i.test(infoHash)) {
    return res.status(400).json({ error: 'Invalid infoHash' });
  }
  const eng = getEngine();
  const diag = eng.getBottleneckDiag(infoHash);
  if (!diag) {
    return res.status(404).json({ error: 'Torrent not active' });
  }
  res.json(diag);
});

// GET /api/diagnostics/system — sample host CPU / memory / disk / network over
// ~1 second and aggregate all active torrent speeds. Use this to figure out
// whether slow downloads are bottlenecked on the host (CPU / disk / network
// saturated) or on the BT swarm (torrent speeds low but host is idle).
app.get('/api/diagnostics/system', async (req, res) => {
  try {
    const sampleMs = Math.min(5000, Math.max(200, parseInt(req.query.ms, 10) || 1000));
    const sys = await getSystemDiag(sampleMs);

    // Aggregate torrent throughput across both streaming engine and library.
    //
    // One row per actual torrent-stream engine, NOT per library item. Pack
    // engines are shared across every episode in the pack, so the naïve
    // per-item loop inflated counts (55 episodes × 7 peers = 385 "peers"
    // for one real 7-peer swarm). See LibraryManager.getActiveEngineStats.
    let torrentDownloadBps = 0;
    let torrentUploadBps = 0;
    let torrentPeers = 0;
    let activeTorrents = 0;
    const perEngine = [];

    try {
      const eng = engine; // don't lazy-init just for diagnostics
      if (eng) {
        for (const s of eng.getAllStatus()) {
          torrentDownloadBps += s.downloadSpeed || 0;
          torrentUploadBps += s.uploadSpeed || 0;
          torrentPeers += s.numPeers || 0;
          activeTorrents++;
          perEngine.push({
            source: 'stream',
            name: s.name,
            isPack: false,
            activeFileName: null,
            downloadBps: s.downloadSpeed || 0,
            uploadBps: s.uploadSpeed || 0,
            peers: s.numPeers || 0,
            itemCount: 1,
            downloadingCount: 1,
            completeCount: 0,
          });
        }
      }
    } catch (e) {
      console.warn('[Diag] engine status failed:', e.message);
    }

    try {
      for (const stat of library.getActiveEngineStats()) {
        torrentDownloadBps += stat.downloadBps || 0;
        torrentUploadBps += stat.uploadBps || 0;
        torrentPeers += stat.peers || 0;
        activeTorrents++;
        perEngine.push({
          source: 'library',
          name: stat.name,
          isPack: stat.isPack,
          activeFileName: stat.activeFileName,
          downloadBps: stat.downloadBps,
          uploadBps: stat.uploadBps,
          peers: stat.peers,
          itemCount: stat.itemCount,
          downloadingCount: stat.downloadingCount,
          completeCount: stat.completeCount,
        });
      }
    } catch (e) {
      console.warn('[Diag] library status failed:', e.message);
    }

    // Total network rx across non-loopback interfaces (host-wide, not just BT).
    let hostNetRxBps = 0;
    let hostNetTxBps = 0;
    for (const iface of Object.values(sys.network)) {
      hostNetRxBps += iface.rxBytesPerSec;
      hostNetTxBps += iface.txBytesPerSec;
    }

    // Total disk write across non-pseudo devices.
    let hostDiskWriteBps = 0;
    let hostDiskReadBps = 0;
    for (const dev of Object.values(sys.disk)) {
      hostDiskWriteBps += dev.writeBytesPerSec;
      hostDiskReadBps += dev.readBytesPerSec;
    }

    // Best-effort bottleneck hint — compares torrent pull rate to host
    // resource usage. This is heuristic, not authoritative.
    let hint = 'unknown';
    const torrentMBps = torrentDownloadBps / 1e6;
    if (activeTorrents === 0) {
      hint = 'idle (no active downloads)';
    } else if (sys.cpu.usagePct >= 90) {
      hint = `cpu_bound (${sys.cpu.usagePct}% cpu) — likely verify-pass or too many concurrent torrents`;
    } else if (sys.memory.usedPct >= 95) {
      hint = `memory_pressure (${sys.memory.usedPct}% used) — may be swapping`;
    } else if (hostNetRxBps > 0 && torrentDownloadBps > 0 && torrentDownloadBps >= hostNetRxBps * 0.9) {
      // Torrent pull is close to total host network rx — suggests either
      // swarm-limited or link-limited, not something else on the box.
      hint = `network_or_swarm (torrents = ${(torrentMBps).toFixed(2)} MB/s, host rx = ${(hostNetRxBps / 1e6).toFixed(2)} MB/s) — either the swarm is giving all it has or the uplink/VPN is the cap`;
    } else if (hostNetRxBps > torrentDownloadBps * 1.5) {
      hint = `host_has_headroom — host is receiving ${(hostNetRxBps / 1e6).toFixed(2)} MB/s total but torrents only account for ${(torrentMBps).toFixed(2)} MB/s. BT protocol (e.g. uploads:0 choking) or swarm health is the cap, not your link.`;
    } else {
      hint = `swarm_or_protocol — torrents ${(torrentMBps).toFixed(2)} MB/s, ${torrentPeers} peers total across ${activeTorrents} torrents. Nothing on the host is saturated.`;
    }

    res.json({
      hint,
      torrents: {
        active: activeTorrents,
        totalDownloadBps: torrentDownloadBps,
        totalDownloadMBps: +(torrentMBps).toFixed(3),
        totalUploadBps: torrentUploadBps,
        totalUploadMBps: +(torrentUploadBps / 1e6).toFixed(3),
        totalPeers: torrentPeers,
        perEngine,
      },
      host: {
        cpu: sys.cpu,
        memory: sys.memory,
        network: sys.network,
        disk: sys.disk,
        totalNetRxBps: hostNetRxBps,
        totalNetTxBps: hostNetTxBps,
        totalDiskReadBps: hostDiskReadBps,
        totalDiskWriteBps: hostDiskWriteBps,
      },
      sampleMs: sys.sampleMs,
      platform: sys.platform,
    });
  } catch (err) {
    console.error('[Diag] system diagnostic failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Library API Routes ───────────────────────────────────────────────

// GET /api/library — list all library items
app.get('/api/library', (req, res) => {
  try {
    const items = library.getAll();
    const slots = library.getDownloadSlots();
    res.json({ items, slots });
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

// GET /api/library/audit — walk the library directory and report every
// tracked item that doesn't match its on-disk file, plus orphaned files
// (untracked videos, leftover ffmpeg temp files, empty directories).
//
// Query params:
//   ?deep=1 — additionally run ffprobe against every complete file to
//             catch truncated/corrupt downloads that happen to have the
//             right byte count. Slower but thorough.
app.get('/api/library/audit', async (req, res) => {
  try {
    const deep = req.query.deep === '1' || req.query.deep === 'true';
    const report = await library.auditDiskState({ deep });
    res.json(report);
  } catch (err) {
    console.error('[API] Audit failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/library/audit/remediate — run the audit and act on the issues.
// Body:
//   {
//     action: 'redownload' | 'remove',   // what to do with broken items
//     removeOrphanFiles?: bool,          // default false
//     removeOrphanTempFiles?: bool,      // default true
//     removeEmptyDirectories?: bool,     // default true
//     deep?: bool,                       // default false (ffprobe check)
//     dryRun?: bool                      // default false
//   }
app.post('/api/library/audit/remediate', rateLimit, async (req, res) => {
  const {
    action = 'remove',
    removeOrphanFiles = false,
    removeOrphanTempFiles = true,
    removeEmptyDirectories = true,
    deep = false,
    dryRun = false,
  } = req.body || {};

  if (!['redownload', 'remove'].includes(action)) {
    return res.status(400).json({ error: "action must be 'redownload' or 'remove'" });
  }

  try {
    const result = await library.remediateAudit({
      action,
      removeOrphanFiles: !!removeOrphanFiles,
      removeOrphanTempFiles: !!removeOrphanTempFiles,
      removeEmptyDirectories: !!removeEmptyDirectories,
      deep: !!deep,
      dryRun: !!dryRun,
    });
    res.json(result);
  } catch (err) {
    console.error('[API] Audit remediation failed:', err.message);
    res.status(500).json({ error: err.message });
  }
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
      })().catch(err => console.warn('[Library] Background metadata error:', err.message));
    }

    res.json(result);
  } catch (err) {
    console.error('[API] Season pack download error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Keyword pattern that marks an item as bonus / extras content rather than a
// standalone movie. Matched against the fileName AND the filePath (so a clip
// living in an "Extras/" subfolder is caught even if its own filename is
// generic). Items that match are left completely untouched by repair —
// they stay in the library with whatever metadata they already had.
const MOVIE_EXTRAS_PATTERN = /\b(making[\s._-]*of|behind[\s._-]*the[\s._-]*scenes|bts|featurettes?|deleted[\s._-]*scenes?|interviews?|greatest[\s._-]*moments|beyond[\s._-]*the[\s._-]*movie|bonus(?:[\s._-]*(?:features?|material|disc))?|extras?|gag[\s._-]*reel|bloopers?|commentary|trailers?|teasers?|sneak[\s._-]*peek|live[\s._-]*tour|concerts?|anniversa(?:ire|ry))\b/i;

function isMovieExtras(item) {
  const hay = `${item.fileName || ''} ${item.filePath || ''}`;
  return MOVIE_EXTRAS_PATTERN.test(hay);
}

// POST /api/library/repair-metadata — one-time repair: re-derive titles from
// filenames and look up correct IMDB IDs, posters, and years from TMDB.
// Only touches items whose download is complete — in-progress / queued /
// paused items are left alone so we don't stomp on metadata that is still
// being filled in by the pack download flow. Backs up _metadata.json before
// making any changes.
app.post('/api/library/repair-metadata', rateLimit, async (req, res) => {
  if (!TMDB_API_KEY) {
    return res.status(400).json({ error: 'TMDB API key not configured' });
  }

  // Normalize titles for comparison: lowercase, strip year, punctuation, whitespace
  const normTitle = (s) => (s || '')
    .toLowerCase()
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .replace(/\s+\d{4}\s*$/, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Back up _metadata.json before touching anything, so a bad repair run
  // can be reverted by copying the .bak over the live file.
  let backupPath = null;
  try {
    const metadataFile = library._metadataFile;
    if (metadataFile && fs.existsSync(metadataFile)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      backupPath = `${metadataFile}.pre-repair-${stamp}.bak`;
      fs.copyFileSync(metadataFile, backupPath);
      console.log(`[Repair] Backed up metadata to ${backupPath}`);
    }
  } catch (err) {
    console.warn(`[Repair] Could not create metadata backup: ${err.message}`);
    backupPath = null;
  }

  try {
    const allItems = library.getAll();
    // Only repair items that are fully downloaded. Anything in-flight
    // (downloading / queued / paused / converting / failed) has metadata
    // that may still be getting populated by the pack flow — touching it
    // mid-download overwrites the correct showName/name that the importer
    // is about to write, which is how bulk downloads got mangled last run.
    const completeItems = allItems.filter(i => i.status === 'complete' && i.fileName);
    const seriesItems = completeItems.filter(i => i.type === 'series');
    const movieItems = completeItems.filter(i => i.type === 'movie');

    const repaired = [];
    const stats = {
      inProgressSkipped: allItems.length - completeItems.length,
      moviesExtrasSkipped: 0,
      moviesNoMatchSkipped: 0,
      moviesAlreadyCorrect: 0,
    };

    // ── Series: derive show names and group episodes ────────────────────
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
        type: 'series',
        showName: updates.showName,
        imdbId: updates.imdbId || 'not found',
        episodesUpdated: itemIds.length,
      });
      console.log(`[Repair] "${derivedName}" -> ${updates.showName} (${updates.imdbId || 'no IMDB'}), ${itemIds.length} episodes`);
    }

    // ── Movies: derive title (+ year hint) and look up on TMDB ──────────
    let moviesUpdated = 0;
    for (const item of movieItems) {
      // Skip bonus / featurette / concert / making-of content entirely.
      // These stay in the library with whatever metadata they already had.
      if (isMovieExtras(item)) {
        stats.moviesExtrasSkipped++;
        continue;
      }

      const { title: derivedTitle, year: derivedYear } = library._deriveMovieNameFromFile(item.fileName);
      if (!derivedTitle) {
        stats.moviesNoMatchSkipped++;
        continue;
      }

      // Skip items that already have a valid IMDB id AND a name matching
      // the derived title — nothing to fix. Items missing imdbId are still
      // re-processed so disk-discovered movies get tagged.
      const currentNorm = normTitle(item.name);
      const derivedNorm = normTitle(derivedTitle);
      if (item.imdbId && /^tt\d+$/.test(item.imdbId) && currentNorm === derivedNorm) {
        stats.moviesAlreadyCorrect++;
        continue;
      }

      const meta = await lookupMovieByName(derivedTitle, derivedYear);
      // Only write changes when TMDB actually matched. A "not found" used
      // to overwrite item.name with the raw derived string — that stomped
      // on decent existing names and filled the response with garbage.
      if (!meta || !meta.imdbId) {
        stats.moviesNoMatchSkipped++;
        console.log(`[Repair] "${derivedTitle}" — no TMDB match, leaving item untouched`);
        continue;
      }

      const updates = {
        name: meta.name || derivedTitle,
        imdbId: meta.imdbId,
        poster: meta.poster,
        year: meta.year || derivedYear || undefined,
      };
      library.relinkItem(item.id, updates);
      moviesUpdated++;

      repaired.push({
        type: 'movie',
        name: updates.name,
        imdbId: updates.imdbId,
        moviesUpdated: 1,
      });
      console.log(`[Repair] "${derivedTitle}" -> ${updates.name} (${updates.imdbId})`);
    }

    const episodesUpdated = repaired
      .filter(r => r.type === 'series')
      .reduce((s, r) => s + r.episodesUpdated, 0);

    res.json({
      repaired,
      totalUpdated: episodesUpdated + moviesUpdated,
      episodesUpdated,
      moviesUpdated,
      skipped: stats,
      backupPath: backupPath ? path.basename(backupPath) : null,
    });
  } catch (err) {
    console.error('[API] Repair metadata error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/library/add-manual — add a torrent by magnet URI or info hash.
// Handles both single-file and multi-file (collection) torrents automatically.
app.post('/api/library/add-manual', rateLimit, async (req, res) => {
  const { TRACKERS } = require('./lib/file-safety');
  let { magnetUri, infoHash, name, type, quality } = req.body;

  // Accept either a magnet URI or a bare info hash
  if (!magnetUri && !infoHash) {
    return res.status(400).json({ error: 'Provide a magnet URI or info hash' });
  }

  // Extract info hash from magnet URI
  if (magnetUri && !infoHash) {
    // Try hex (40 chars) then Base32 (32 chars) encoded info hashes
    const hexMatch = magnetUri.match(/xt=urn:btih:([a-f0-9]{40})/i);
    if (hexMatch) {
      infoHash = hexMatch[1].toLowerCase();
    } else {
      const b32Match = magnetUri.match(/xt=urn:btih:([A-Za-z2-7]{32})/);
      if (b32Match) {
        try { infoHash = Buffer.from(b32Match[1], 'base32').toString('hex').toLowerCase(); } catch {}
      }
      if (!infoHash) {
        return res.status(400).json({ error: 'Could not extract info hash from magnet URI' });
      }
    }
  }

  // Also accept Base32 bare info hashes
  if (infoHash && /^[A-Za-z2-7]{32}$/.test(infoHash)) {
    try { infoHash = Buffer.from(infoHash, 'base32').toString('hex').toLowerCase(); } catch {}
  }

  if (!/^[0-9a-f]{40}$/i.test(infoHash)) {
    return res.status(400).json({ error: 'Invalid info hash — must be 40 hex characters or 32 Base32 characters' });
  }
  infoHash = infoHash.toLowerCase();

  // Build a magnet URI from info hash if only hash was provided
  if (!magnetUri) {
    const trackerParams = TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');
    magnetUri = `magnet:?xt=urn:btih:${infoHash}${trackerParams}`;
  }

  if (!magnetUri.startsWith('magnet:?')) {
    return res.status(400).json({ error: 'Invalid magnet URI' });
  }

  // Extract display name from magnet URI dn= param if no name provided
  if (!name) {
    const dnMatch = magnetUri.match(/[?&]dn=([^&]+)/);
    name = dnMatch ? decodeURIComponent(dnMatch[1]).replace(/\+/g, ' ') : `Torrent ${infoHash.slice(0, 8)}`;
  }

  try {
    const result = await library.addManual({
      imdbId: null,
      type: ['movie', 'series'].includes(type) ? type : 'movie',
      name,
      poster: '',
      year: '',
      magnetUri,
      infoHash,
      quality: quality || '',
      size: '',
    });
    res.json(result);
  } catch (err) {
    console.error('[API] Manual torrent add error:', err.message);
    res.status(400).json({ error: err.message });
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

// POST /api/library/:id/start — force-start a queued item (if slots available)
app.post('/api/library/:id/start', rateLimit, (req, res) => {
  const started = library.startQueuedItem(req.params.id);
  if (!started) return res.status(400).json({ error: 'Cannot start this item (no available slots or not queued)' });
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

// POST /api/library/pause-pack — atomically pause every item in a pack
app.post('/api/library/pause-pack', rateLimit, (req, res) => {
  const { packId } = req.body;
  if (!packId) return res.status(400).json({ error: 'packId is required' });
  const paused = library.pausePack(packId);
  if (!paused) return res.status(400).json({ error: 'Cannot pause this pack' });
  res.json({ success: true });
});

// POST /api/library/resume-pack — atomically resume every paused item in a pack
app.post('/api/library/resume-pack', rateLimit, (req, res) => {
  const { packId } = req.body;
  if (!packId) return res.status(400).json({ error: 'packId is required' });
  const resumed = library.resumePack(packId);
  if (!resumed) return res.status(400).json({ error: 'Cannot resume this pack' });
  res.json({ success: true });
});

// POST /api/library/retry-pack — atomically retry every failed item in a pack
app.post('/api/library/retry-pack', rateLimit, (req, res) => {
  const { packId } = req.body;
  if (!packId) return res.status(400).json({ error: 'packId is required' });
  const retried = library.retryPack(packId);
  if (!retried) return res.status(400).json({ error: 'Cannot retry this pack' });
  res.json({ success: true });
});

// POST /api/library/start-pack — force-start a queued pack (if slots available)
app.post('/api/library/start-pack', rateLimit, (req, res) => {
  const { packId } = req.body;
  if (!packId) return res.status(400).json({ error: 'packId is required' });
  const started = library.startPack(packId);
  if (!started) return res.status(400).json({ error: 'Cannot start this pack (no free slots or no queued items)' });
  res.json({ success: true });
});

// DELETE /api/library/pack/:packId — atomically remove every item in a pack
app.delete('/api/library/pack/:packId', rateLimit, (req, res) => {
  const removed = library.removePack(req.params.packId);
  if (!removed) return res.status(404).json({ error: 'Pack not found' });
  res.json({ success: true });
});

// POST /api/library/reorder-pack — reorder a queued pack in the queue
app.post('/api/library/reorder-pack', rateLimit, (req, res) => {
  const { packId, position } = req.body;
  if (!packId) return res.status(400).json({ error: 'packId is required' });
  const pos = parseInt(position, 10);
  if (isNaN(pos) || pos < 0) return res.status(400).json({ error: 'Invalid position' });
  const reordered = library.reorderPackQueue(packId, pos);
  if (!reordered) return res.status(400).json({ error: 'Cannot reorder this pack' });
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
  const matchLower = matchShowName.toLowerCase();
  const matches = allItems.filter(i => (i.showName || '').toLowerCase() === matchLower);
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
  const safeFilename = path.basename(filePath).replace(/[^\w\s.\-()[\]]/g, '_').replace(/["\\]/g, '_').substring(0, 200);

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

    if (isNaN(start) || isNaN(end) || start >= fileSize || end >= fileSize || start > end) {
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

// GET /api/library/:id/stream/transcode?caps=...
// Full video re-encode to H.264 + AAC in fragmented MP4. This is the
// LAST-RESORT fallback for clients that can't play the source video
// codec AND the background pre-transcode hasn't produced a universal
// MP4 yet. In the happy path this endpoint is never hit — the library
// manager pre-converts non-universal sources to stored H.264/AAC/MP4
// at download time and serves them through the plain /stream endpoint.
//
// Output target is intentionally conservative for maximum compatibility:
//   Video : H.264 main profile, level 4.1, yuv420p, max 720p
//   Audio : AAC-LC, 192k, stereo downmix
//   Container : fragmented MP4 (streamable over HTTP, no seek)
//
// libx264 -preset ultrafast is used because the Jetson Orin Nano has NO
// hardware video encoder — this path is CPU-bound. 720p keeps us within
// realtime budget on the Orin's Cortex-A78AE cores for typical 24/30 fps
// source material. Set FFMPEG_HWACCEL=cuda (or =nvdec / =auto / =v4l2m2m
// depending on the local ffmpeg build) to offload the DECODE side of the
// pipeline to NVDEC, which alone buys ~30-50% more CPU headroom for
// libx264 on HEVC sources. If you upgrade to a Jetson with NVENC later,
// swap the encoder args for h264_nvenc or h264_nvmpi.
app.get('/api/library/:id/stream/transcode', async (req, res) => {
  const item = library.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.status !== 'complete' && item.status !== 'converting') {
    return res.status(400).json({ error: 'Download not complete' });
  }

  // CPU contention guard: if a background conversion is actively running
  // for THIS item, two ffmpeg processes on the same source starve each
  // other on the Orin Nano's 6 cores and neither finishes in time to
  // satisfy the client's stall timer. Tell the client to wait for the
  // background job instead — it will produce a directly-playable MP4.
  const convState = library.getConversionState(req.params.id);
  if (convState && convState.active) {
    res.status(503).set({
      'Content-Type': 'application/json',
      'X-Conversion-Kind': convState.kind || 'unknown',
      'X-Conversion-Progress': String(convState.progress || 0),
      'Retry-After': '60',
    });
    return res.json({
      error: 'Background conversion in progress',
      convertKind: convState.kind,
      convertProgress: convState.progress,
      message: 'A universal MP4 is being prepared. Try again in a few minutes.',
    });
  }

  const filePath = library.getFilePath(req.params.id);
  if (!filePath) return res.status(404).json({ error: 'File not found' });

  try {
    await fs.promises.stat(filePath);
  } catch {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  const safeFilename = path.basename(filePath)
    .replace(/[^\w\s.\-()[\]]/g, '_')
    .replace(/\.(mkv|avi|wmv|mp4|mov|m4v|flv|webm|ts|mpg|mpeg)$/i, '.mp4')
    .substring(0, 200);

  res.status(200);
  res.set({
    'Content-Type': 'video/mp4',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename="${safeFilename}"`,
    'Cache-Control': 'no-store',
    'Transfer-Encoding': 'chunked',
  });

  // Read the source file directly (not via stdin). For a full transcode we
  // read the whole file anyway so there's no benefit to the sequential
  // pipe trick the remux endpoint uses, and letting ffmpeg open the file
  // itself means it can read the moov atom up front (faster startup).
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner',
    '-fflags', '+genpts',
    ...FFMPEG_HWACCEL_ARGS,
    // Keep initial input parse cheap — 1MB / 1s probe is plenty for
    // every container we ingest, and waiting any longer just delays
    // the first MP4 fragment on the wire.
    '-probesize', '1000000',
    '-analyzeduration', '1000000',
    '-i', filePath,

    // Select first video + first audio stream, drop everything else.
    // Subtitles and data streams in MKV files routinely break ffmpeg
    // when mapped to mp4 without explicit handling.
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-sn',
    '-dn',

    // Video: H.264 main profile L4.1, widest compatibility. ultrafast
    // preset is the only one that keeps up with realtime on Orin Nano
    // software encoding. zerolatency trims the GOP to minimize first-
    // frame delay. Scale to 720p max, preserve aspect, even height.
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-profile:v', 'main',
    '-level', '4.1',
    '-pix_fmt', 'yuv420p',
    '-crf', '23',
    '-vf', "scale='min(1280,iw)':'-2'",
    // Short GOP so we get an IDR — and therefore a flushable fragment —
    // within ~2 seconds regardless of the source's native keyframe
    // interval. This is the single biggest knob for first-byte latency
    // on a live transcode.
    '-g', '48',
    '-keyint_min', '48',
    '-sc_threshold', '0',

    // Audio: AAC LC stereo. Even 5.1 sources get downmixed so phone
    // speakers and stereo laptops don't get a broken center channel.
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ac', '2',
    '-ar', '48000',

    // Fragmented MP4 that can be streamed over a single HTTP response
    // with no server-side seeking. Browsers can play it back as it arrives
    // but cannot seek past what's been received. 500ms fragment duration
    // pairs with the short GOP to flush the first playable byte to the
    // client well before any client-side stall timer fires.
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration', '500000',
    '-f', 'mp4',
    '-loglevel', 'warning',
    'pipe:1',
  ]);

  ffmpeg.stdout.pipe(res);

  ffmpeg.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.log(`[FFmpeg/Transcode] ${msg}`);
  });

  ffmpeg.on('error', (err) => {
    console.error(`[Library] FFmpeg transcode spawn error: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Transcode failed — FFmpeg not available' });
    } else {
      try { res.end(); } catch { /* ignore */ }
    }
  });

  ffmpeg.on('close', (code) => {
    if (code && code !== 0 && code !== 255) {
      console.warn(`[Library] FFmpeg transcode exited with code ${code}`);
    }
    try { res.end(); } catch { /* ignore */ }
  });

  // Client aborted (tab closed, seek requested, fallback triggered) —
  // kill ffmpeg immediately so we don't waste CPU on output nobody wants.
  res.on('close', () => {
    try { ffmpeg.kill('SIGTERM'); } catch { /* ignore */ }
  });
});

// ─── Library Probe Helpers ───────────────────────────────────────────
// Parse the `caps` query param the client sends to /probe and /transcode.
// Format: comma-separated feature tokens — "h264,hevc,aac,mp3". Any token
// missing from the list is treated as false (conservative default). Any
// unknown token is ignored. Invalid input falls back to an empty caps set
// which will force transcode for every codec — safe but slow.
function parseClientCaps(rawCaps) {
  const caps = { h264: false, hevc: false, aac: false, mp3: false };
  if (typeof rawCaps !== 'string' || !rawCaps) return caps;
  for (const token of rawCaps.split(',')) {
    const t = token.trim().toLowerCase();
    if (t in caps) caps[t] = true;
  }
  return caps;
}

// GET /api/library/:id/probe?caps=h264,hevc,aac,mp3
// Probes the file and tells the client exactly which playback endpoint
// to use: direct, remux, transcode, or unplayable. The `caps` query
// parameter lets the server reason about THIS client's decoder — a file
// that's "direct play" on Safari may need transcoding on Linux Firefox.
app.get('/api/library/:id/probe', async (req, res) => {
  const item = library.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.status !== 'complete' && item.status !== 'converting') {
    return res.status(400).json({ error: 'Download not complete' });
  }

  const filePath = library.getFilePath(req.params.id);
  if (!filePath) return res.status(404).json({ error: 'File not found' });

  const probe = await library._probeFile(filePath);
  const caps = parseClientCaps(req.query.caps);
  const decision = library.classifyForClient(probe, caps);

  // Log the probe outcome so we can diagnose failed playbacks from the
  // server side. Include enough context to correlate with client reports:
  // item name, full file path, decision action, and ffprobe reason if any.
  if (decision.action === 'unplayable') {
    let fileSize = '?';
    try { fileSize = String(fs.statSync(filePath).size); } catch { /* ignore */ }
    console.warn(
      `[Library] Probe UNPLAYABLE: "${item.name}" ` +
      `file=${filePath} size=${fileSize}B ` +
      `reason=${decision.reason || '?'}`
    );
  } else {
    console.log(
      `[Library] Probe ${decision.action}: "${item.name}" ` +
      `video=${decision.videoCodec || '?'} profile=${decision.videoProfile || '?'} ` +
      `pix=${decision.pixFmt || '?'} audio=${decision.audioCodec || '?'} ` +
      `ext=${decision.ext} caps=${req.query.caps || '(none)'} ` +
      `${decision.reason ? 'reason=' + decision.reason : ''}`
    );
  }

  // Suggest the exact path the client should request. Keeps the client
  // logic dumb — it just follows whatever we say.
  const idParam = encodeURIComponent(req.params.id);
  const endpoints = {
    direct:   `/api/library/${idParam}/stream`,
    remux:    `/api/library/${idParam}/stream/remux`,
    transcode: `/api/library/${idParam}/stream/transcode?caps=${encodeURIComponent(req.query.caps || '')}`,
  };

  // Expose background-conversion state so the client can show a
  // "Converting X%" message instead of hammering live transcode while
  // the permanent MP4 is being produced.
  const convState = library.getConversionState(req.params.id);

  res.json({
    action: decision.action,
    reason: decision.reason,
    endpoint: endpoints[decision.action] || null,
    container: decision.container,
    ext: decision.ext,
    videoCodec: decision.videoCodec,
    videoProfile: decision.videoProfile,
    pixFmt: decision.pixFmt,
    audioCodec: decision.audioCodec,
    duration: decision.duration,
    conversion: convState,
    // Legacy flag kept so older clients still get a sensible answer while
    // rolling out. TRUE only for the 'direct' action.
    directPlay: decision.action === 'direct',
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

const MAX_FETCH_BODY = 10 * 1024 * 1024; // 10 MB max response body

function fetchUrlDirect(url, redirectCount = 0, resolvedIp = null) {
  if (redirectCount > MAX_REDIRECTS) {
    return Promise.reject(new Error('Too many redirects'));
  }
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const parsedUrl = new URL(url);
    const deadline = setTimeout(() => {
      if (req) req.destroy();
      reject(new Error('Timeout'));
    }, 10000);
    const options = {
      hostname: resolvedIp || parsedUrl.hostname,
      port: parsedUrl.port || (mod === https ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'User-Agent': 'Albatross/1.0',
        ...(resolvedIp ? { Host: parsedUrl.hostname } : {}),
      },
      timeout: 10000,
      family: 4,
      servername: parsedUrl.hostname,
    };
    const req = mod.get(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(deadline);
        const redirectUrl = res.headers.location;
        res.resume();
        return validateUrlNotSSRF(redirectUrl)
          .then(() => fetchUrl(redirectUrl, redirectCount + 1))
          .then(resolve, reject);
      }
      if (res.statusCode !== 200) { clearTimeout(deadline); res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > MAX_FETCH_BODY) { clearTimeout(deadline); res.destroy(); reject(new Error('Response too large')); }
      });
      res.on('end', () => { clearTimeout(deadline); resolve(body); });
    });
    req.on('error', (e) => { clearTimeout(deadline); reject(e); });
    req.on('timeout', () => { clearTimeout(deadline); req.destroy(); reject(new Error('Timeout')); });
  });
}

async function fetchUrl(url, redirectCount = 0) {
  try {
    return await fetchUrlDirect(url, redirectCount);
  } catch (e) {
    if (e.message && (e.message.includes('ENOTFOUND') || e.message.includes('EAI_AGAIN'))) {
      const parsedUrl = new URL(url);
      try {
        const ip = await resolveWithFallback(parsedUrl.hostname);
        return await fetchUrlDirect(url, redirectCount, ip);
      } catch (_) {
        throw e;
      }
    }
    throw e;
  }
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
