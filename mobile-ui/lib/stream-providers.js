/**
 * Albatross — Custom Stream Providers
 *
 * Providers (in priority order):
 *   - Torrentio       — Primary, pre-indexed torrent database (no Cloudflare)
 *   - The Pirate Bay   — Fallback, JSON API
 *   - YTS (yts.mx)    — Fallback, movies with quality/size metadata
 *   - EZTV (eztv.re)  — Fallback, TV series episodes
 *   - 1337x           — Fallback, general
 *   - Nyaa.si         — Anime, with title aliases and mirror support
 */

const cheerio = require('cheerio');
const https = require('https');
const http = require('http');
const dns = require('dns');
const { TRACKERS } = require('./file-safety');

// ─── DNS Fallback ──────────────────────────────────
// When system DNS fails (ENOTFOUND), retry with public resolvers.
// This fixes environments where default DNS can't resolve torrent sites.
const fallbackResolver = new dns.Resolver();
fallbackResolver.setServers(['1.1.1.1', '8.8.8.8', '1.0.0.1', '8.8.4.4']);

// Positive + negative DNS cache. Without this, every failed lookup re-runs
// system DNS + fallback DNS on every request, which causes a CPU-burning
// retry storm whenever a tracker domain dies.
const DNS_TTL_OK = 5 * 60 * 1000;     // 5 min for successful lookups
const DNS_TTL_FAIL = 2 * 60 * 1000;   // 2 min for failures (so dead sites
                                       // don't get re-queried on every search)
const dnsCache = new Map(); // hostname -> { ip, error, expires }

function resolveWithFallback(hostname) {
  const cached = dnsCache.get(hostname);
  if (cached && cached.expires > Date.now()) {
    if (cached.ip) return Promise.resolve(cached.ip);
    return Promise.reject(cached.error);
  }

  return new Promise((resolve, reject) => {
    // Try system DNS first
    dns.resolve4(hostname, (err, addresses) => {
      if (!err && addresses && addresses.length > 0) {
        dnsCache.set(hostname, { ip: addresses[0], expires: Date.now() + DNS_TTL_OK });
        return resolve(addresses[0]);
      }
      // System DNS failed — try public resolvers
      console.log(`[DNS] System DNS failed for ${hostname}, trying fallback resolvers...`);
      fallbackResolver.resolve4(hostname, (err2, addresses2) => {
        if (!err2 && addresses2 && addresses2.length > 0) {
          console.log(`[DNS] Fallback resolved ${hostname} → ${addresses2[0]}`);
          dnsCache.set(hostname, { ip: addresses2[0], expires: Date.now() + DNS_TTL_OK });
          return resolve(addresses2[0]);
        }
        const finalErr = err2 || err;
        dnsCache.set(hostname, { error: finalErr, expires: Date.now() + DNS_TTL_FAIL });
        reject(finalErr);
      });
    });
  });
}

// ─── Helpers ────────────────────────────────────────

function sanitizeImdbId(id) {
  // Accept tt followed by 1-10 digits (covers old and new IMDB IDs)
  if (/^tt\d{1,10}$/.test(id)) return id;
  return null;
}

// Use Node's https module instead of undici fetch — undici has connectivity
// issues on ARM/Jetson with Cloudflare IPs, while https module works fine.
const MAX_REDIRECTS = 5;

// Persistent agents so repeat requests to the same provider host reuse
// the existing TCP/TLS connection instead of paying ~150-400ms of fresh
// handshake on the Orin's CPU per fetch. `family: 4` matches the
// IPv4-only policy used everywhere else in this file.
const KEEP_ALIVE_AGENT_OPTS = {
  keepAlive: true,
  keepAliveMsecs: 30 * 1000,
  maxSockets: 8,
  maxFreeSockets: 4,
  scheduling: 'lifo',
  family: 4,
};
const httpAgent  = new http.Agent(KEEP_ALIVE_AGENT_OPTS);
const httpsAgent = new https.Agent(KEEP_ALIVE_AGENT_OPTS);

function httpGetDirect(url, timeoutMs = 10000, _redirectCount = 0, resolvedIp = null) {
  return new Promise((resolve, reject) => {
    if (_redirectCount > MAX_REDIRECTS) {
      return reject(new Error('Too many redirects'));
    }

    // Hard deadline covers DNS + connect + transfer (Node's `timeout` option
    // only starts after the socket is assigned, so DNS hangs bypass it).
    const deadline = setTimeout(() => {
      if (req) req.destroy();
      reject(new Error(`Timeout after ${timeoutMs}ms (including DNS)`));
    }, timeoutMs);

    const mod = url.startsWith('https') ? https : http;
    const parsedUrl = new URL(url);
    const options = {
      hostname: resolvedIp || parsedUrl.hostname,
      port: parsedUrl.port || (mod === https ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        // Some peers/middleboxes FIN-close after the first response
        // unless the client explicitly asks to keep the socket open.
        'Connection': 'keep-alive',
        ...(resolvedIp ? { Host: parsedUrl.hostname } : {}),
      },
      agent: mod === https ? httpsAgent : httpAgent,
      timeout: timeoutMs,
      family: 4, // Force IPv4
      servername: parsedUrl.hostname, // SNI for TLS when using resolved IP
    };

    const req = mod.get(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(deadline);
        httpGet(res.headers.location, timeoutMs, _redirectCount + 1).then(resolve, reject);
        res.resume();
        return;
      }
      if (res.statusCode !== 200) {
        clearTimeout(deadline);
        res.resume();
        resolve({ ok: false, status: res.statusCode, body: '' });
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => { clearTimeout(deadline); resolve({ ok: true, status: 200, body }); });
    });
    req.on('error', (e) => { clearTimeout(deadline); reject(e); });
    req.on('timeout', () => { clearTimeout(deadline); req.destroy(); reject(new Error('Socket timeout')); });
  });
}

async function httpGet(url, timeoutMs = 10000, _redirectCount = 0) {
  // Short-circuit if we already know this hostname is unresolvable, so we
  // don't burn CPU re-running system DNS on every search.
  const parsedUrl = new URL(url);
  const cached = dnsCache.get(parsedUrl.hostname);
  if (cached && cached.expires > Date.now() && cached.error) {
    throw cached.error;
  }
  // If we have a cached IP, skip system DNS and connect directly.
  if (cached && cached.expires > Date.now() && cached.ip) {
    return await httpGetDirect(url, timeoutMs, _redirectCount, cached.ip);
  }

  try {
    return await httpGetDirect(url, timeoutMs, _redirectCount);
  } catch (e) {
    // If DNS resolution failed, try with fallback DNS resolvers
    if (e.message && (e.message.includes('ENOTFOUND') || e.message.includes('EAI_AGAIN'))) {
      try {
        const ip = await resolveWithFallback(parsedUrl.hostname);
        console.log(`[DNS] Retrying ${parsedUrl.hostname} via resolved IP ${ip}`);
        return await httpGetDirect(url, timeoutMs, _redirectCount, ip);
      } catch (dnsErr) {
        console.log(`[DNS] Fallback DNS also failed for ${parsedUrl.hostname}: ${dnsErr.message}`);
        throw e; // throw original error
      }
    }
    throw e;
  }
}

function isUnresolvableError(e) {
  return e && e.message && (e.message.includes('ENOTFOUND') || e.message.includes('ENODATA'));
}

async function fetchJSON(url, timeoutMs = 10000, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await httpGet(url, timeoutMs);
      if (!res.ok) {
        console.log(`[Provider] fetchJSON ${res.status} for ${url}`);
        return null;
      }
      return JSON.parse(res.body);
    } catch (e) {
      const isLast = attempt === retries;
      console.log(`[Provider] fetchJSON error (attempt ${attempt + 1}/${retries + 1}) for ${url}: ${e.message}`);
      // If the host is unresolvable, retrying will hit the same negative cache.
      // Bail out immediately instead of sleeping.
      if (isUnresolvableError(e)) return null;
      if (!isLast) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return null;
}

async function fetchHTML(url, timeoutMs = 10000, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await httpGet(url, timeoutMs);
      if (!res.ok) {
        console.log(`[Provider] fetchHTML ${res.status} for ${url}`);
        return null;
      }
      return res.body;
    } catch (e) {
      const isLast = attempt === retries;
      console.log(`[Provider] fetchHTML error (attempt ${attempt + 1}/${retries + 1}) for ${url}: ${e.message}`);
      if (isUnresolvableError(e)) return null;
      if (!isLast) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return null;
}

function buildMagnet(infoHash, name) {
  const encoded = encodeURIComponent(name || 'Unknown');
  const tr = TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${infoHash}&dn=${encoded}${tr}`;
}

// ─── Torrentio Provider (Primary) ───────────────────

// Torrentio requires a configuration prefix to return results from all providers.
// The bare URL (no config) may return empty or limited results.
// We try multiple config variations in case the API has changed.
const TORRENTIO_CONFIG = process.env.TORRENTIO_CONFIG || '';
const TORRENTIO_BASE = process.env.TORRENTIO_BASE || 'https://torrentio.strem.io';

// Alternative Torrentio instances to try if primary DNS fails
const TORRENTIO_MIRRORS = [
  TORRENTIO_BASE,
  'https://torrentio.strem.fun',
];

// Config variations to try — ordered by most likely to work.
// Torrentio may require explicit provider selection depending on version.
const TORRENTIO_CONFIGS = TORRENTIO_CONFIG
  ? [TORRENTIO_CONFIG]
  : [
    'providers=yts,eztv,rarbg,1337x,thepiratebay,kickasstorrents,torrentgalaxy|sort=qualitysize|qualityfilter=other',
    'sort=qualitysize|qualityfilter=other',
    '',
  ];

async function searchTorrentio(type, imdbId, season, episode) {
  const streams = [];
  let stremioId = imdbId;
  if (type === 'series' && season !== undefined && episode !== undefined) {
    stremioId = `${imdbId}:${season}:${episode}`;
  }

  // Try each mirror + config variation until one returns results
  let data = null;
  for (const base of TORRENTIO_MIRRORS) {
    for (const config of TORRENTIO_CONFIGS) {
      const url = config
        ? `${base}/${config}/stream/${type}/${stremioId}.json`
        : `${base}/stream/${type}/${stremioId}.json`;
      data = await fetchJSON(url, 12000, 1);
      if (data && Array.isArray(data.streams) && data.streams.length > 0) {
        console.log(`[Torrentio] ${base} config "${config || '(bare)'}" returned ${data.streams.length} results`);
        break;
      }
    }
    if (data && Array.isArray(data.streams) && data.streams.length > 0) break;
  }

  if (!data || !Array.isArray(data.streams)) {
    console.log(`[Torrentio] No results for ${type}/${stremioId} (tried ${TORRENTIO_MIRRORS.length} mirrors × ${TORRENTIO_CONFIGS.length} configs)`);
    return streams;
  }

  for (const s of data.streams) {
    if (!s.infoHash) continue;
    const hash = s.infoHash.toLowerCase();

    // Parse title lines from Torrentio format:
    // Line 1: source + quality info
    // Line 2: size, seeds, etc.
    const titleParts = (s.title || '').split('\n');
    const displayName = s.name || titleParts[0] || 'Unknown';
    const details = titleParts.slice(1).join(' ').trim();

    // Extract seeds from Torrentio's title — handles multiple formats:
    // "👤 45", "⬆️ 45", "seeders: 45", "S: 45", "seeds: 45"
    const seedMatch = details.match(/(?:👤|⬆️|⬆|seeders?|peers?|S)\s*[:：]?\s*(\d+)/i)
      || (s.title || '').match(/(?:👤|⬆️|⬆|seeders?|peers?|S)\s*[:：]?\s*(\d+)/i);
    const seeds = seedMatch ? parseInt(seedMatch[1], 10) : -1; // -1 = unknown (don't filter)

    // Extract size
    const sizeMatch = details.match(/([\d.]+\s*(?:GB|MB))/i);
    const sizeStr = sizeMatch ? sizeMatch[1] : '';

    // Extract quality
    const qualityMatch = (s.title || '').match(/\b(2160p|1080p|720p|480p)\b/i);
    const quality = qualityMatch ? qualityMatch[1] : '';

    streams.push({
      infoHash: hash,
      title: `${displayName}\n${quality ? quality + ' ' : ''}${sizeStr}${seeds > 0 ? ' | Seeds: ' + seeds : ''}${details ? '\n' + details : ''}`,
      magnetUri: buildMagnet(hash, displayName),
      quality,
      size: sizeStr,
      seeds: seeds >= 0 ? seeds : 0,
      _seedsUnknown: seeds < 0,
      fileIdx: s.fileIdx,
      source: 'Torrentio',
    });
  }

  console.log(`[Torrentio] Found ${streams.length} results for ${type}/${stremioId}`);
  return streams;
}

// ─── The Pirate Bay Provider (Fallback) ─────────────

async function searchTPB(query, cats = '200,205,207,208') {
  const streams = [];
  // Clean query: remove special chars that confuse search, trim to reasonable length
  const cleanQuery = query.replace(/['']/g, ' ').replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  // apibay.org is the public TPB API — returns JSON array
  // Video cats: 200=Video, 205=TV, 207=HD Movies, 208=HD TV
  // Audio cats: 100=Audio, 101=Music, 104=FLAC
  const data = await fetchJSON(
    `https://apibay.org/q.php?q=${encodeURIComponent(cleanQuery)}&cat=${encodeURIComponent(cats)}`
  );
  if (!data || !Array.isArray(data)) return streams;

  for (const t of data) {
    // apibay returns {id:"0"} for no results
    if (!t.info_hash || t.info_hash === '0' || t.id === '0') continue;
    const hash = t.info_hash.toLowerCase();
    const seeds = parseInt(t.seeders, 10) || 0;
    const sizeBytes = parseInt(t.size || '0', 10);
    const sizeMB = sizeBytes > 0 ? (sizeBytes / (1024 * 1024)).toFixed(0) + ' MB' : '';
    const sizeGB = sizeBytes > 1e9 ? (sizeBytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB' : '';
    const sizeStr = sizeGB || sizeMB;
    const name = t.name || 'Unknown';
    const quality = name.match(/\b(2160p|1080p|720p|480p)\b/i);

    streams.push({
      infoHash: hash,
      title: `${name}\n${quality ? quality[1] + ' ' : ''}${sizeStr} | Seeds: ${seeds}`,
      magnetUri: buildMagnet(hash, name),
      quality: quality ? quality[1] : '',
      size: sizeStr,
      seeds,
      source: 'TPB',
    });
  }

  console.log(`[TPB] Found ${streams.length} results for "${query}"`);
  return streams;
}

// ─── YTS Provider (Movies) ──────────────────────────

const YTS_DOMAINS = ['yts.mx', 'yts.torrentbay.net', 'yts.do', 'yts.rs'];

async function searchYTS(imdbId) {
  const streams = [];
  let data = null;
  for (const domain of YTS_DOMAINS) {
    data = await fetchJSON(
      `https://${domain}/api/v2/list_movies.json?query_term=${imdbId}&limit=1`
    );
    if (data && data.data && data.data.movies) {
      console.log(`[YTS] Using mirror: ${domain}`);
      break;
    }
  }
  if (!data || !data.data || !data.data.movies) {
    console.log(`[YTS] No results for ${imdbId} (tried ${YTS_DOMAINS.length} mirrors)`);
    return streams;
  }

  for (const movie of data.data.movies) {
    const torrents = movie.torrents || [];
    for (const t of torrents) {
      if (!t.hash) continue;
      const hash = t.hash.toLowerCase();
      const quality = t.quality || 'Unknown';
      const size = t.size || '';
      const codec = t.video_codec || '';
      const seeds = t.seeds || 0;
      const title = `${movie.title_long || movie.title}\n${quality} ${codec} ${size} | Seeds: ${seeds}`;

      streams.push({
        infoHash: hash,
        title,
        magnetUri: buildMagnet(hash, movie.title),
        quality,
        size,
        seeds,
        source: 'YTS',
      });
    }
  }

  console.log(`[YTS] Found ${streams.length} results for ${imdbId}`);
  return streams;
}

// ─── EZTV Provider (TV Series) ──────────────────────

const EZTV_DOMAINS = ['eztv.re', 'eztv.wf', 'eztv.tf', 'eztv.yt'];

async function searchEZTV(imdbId, targetSeason, targetEpisode) {
  const streams = [];
  // EZTV wants numeric IMDB ID without 'tt' prefix
  const numericId = imdbId.replace(/^tt0*/, '');

  // First, get page 1 to find total_count and check for matches
  const limit = 100;
  let firstPage = null;
  let eztvDomain = EZTV_DOMAINS[0];
  for (const domain of EZTV_DOMAINS) {
    firstPage = await fetchJSON(
      `https://${domain}/api/get-torrents?imdb_id=${numericId}&limit=${limit}&page=1`
    );
    if (firstPage && firstPage.torrents && firstPage.torrents.length > 0) {
      eztvDomain = domain;
      console.log(`[EZTV] Using mirror: ${domain}`);
      break;
    }
  }
  if (!firstPage || !firstPage.torrents || firstPage.torrents.length === 0) {
    console.log(`[EZTV] No results for ${imdbId} (numeric: ${numericId}, tried ${EZTV_DOMAINS.length} mirrors)`);
    return streams;
  }

  const allTorrents = [...firstPage.torrents];
  const totalCount = firstPage.torrents_count || allTorrents.length;
  const totalPages = Math.ceil(totalCount / limit);

  // Build a season/episode tag to look for in titles
  const seTag = targetSeason !== undefined && targetEpisode !== undefined
    ? `S${String(targetSeason).padStart(2, '0')}E${String(targetEpisode).padStart(2, '0')}`
    : null;

  // Check if first page already has our target episode
  let foundTarget = seTag ? allTorrents.some(t =>
    (t.season === targetSeason && t.episode === targetEpisode) ||
    (t.title || t.filename || '').toUpperCase().includes(seTag)
  ) : true;

  // If target not found and there are more pages, fetch more aggressively
  // EZTV returns newest first, so older seasons need deeper pagination
  if (!foundTarget && totalPages > 1) {
    // Fetch up to 10 more pages (1000 more results) to find the target episode
    const maxPages = Math.min(totalPages, 11);
    const pagePromises = [];
    for (let page = 2; page <= maxPages; page++) {
      pagePromises.push(
        fetchJSON(`https://${eztvDomain}/api/get-torrents?imdb_id=${numericId}&limit=${limit}&page=${page}`)
          .catch(() => null)
      );
    }
    const pageResults = await Promise.all(pagePromises);
    for (const data of pageResults) {
      if (data && data.torrents && data.torrents.length > 0) {
        allTorrents.push(...data.torrents);
      }
    }
  } else if (totalPages > 1 && totalPages <= 4) {
    // Small show — fetch remaining pages sequentially
    for (let page = 2; page <= totalPages; page++) {
      const data = await fetchJSON(
        `https://${eztvDomain}/api/get-torrents?imdb_id=${numericId}&limit=${limit}&page=${page}`
      );
      if (!data || !data.torrents || data.torrents.length === 0) break;
      allTorrents.push(...data.torrents);
    }
  }

  console.log(`[EZTV] Fetched ${allTorrents.length}/${totalCount} torrents for ${imdbId} (numeric: ${numericId})`);

  for (const t of allTorrents) {
    if (!t.hash) continue;
    const hash = t.hash.toLowerCase();
    const seeds = t.seeds || 0;
    const sizeBytes = parseInt(t.size_bytes || '0', 10);
    const sizeMB = sizeBytes > 0 ? (sizeBytes / (1024 * 1024)).toFixed(0) + ' MB' : '';
    const quality = t.filename && t.filename.match(/\b(2160p|1080p|720p|480p)\b/i)
      ? t.filename.match(/\b(2160p|1080p|720p|480p)\b/i)[1]
      : '';

    // Parse season/episode from API fields, falling back to title extraction
    let eSeason = t.season ? parseInt(t.season, 10) : undefined;
    let eEpisode = t.episode ? parseInt(t.episode, 10) : undefined;
    if ((eSeason === undefined || eEpisode === undefined) && (t.title || t.filename)) {
      const seMatch = (t.title || t.filename).match(/[Ss](\d{1,2})\s*[Ee](\d{1,3})/);
      if (seMatch) {
        if (eSeason === undefined) eSeason = parseInt(seMatch[1], 10);
        if (eEpisode === undefined) eEpisode = parseInt(seMatch[2], 10);
      }
    }

    streams.push({
      infoHash: hash,
      title: `${t.title || t.filename}\n${quality} ${sizeMB} | Seeds: ${seeds}`,
      magnetUri: t.magnet_url || buildMagnet(hash, t.title || t.filename),
      quality,
      size: sizeMB,
      seeds,
      season: eSeason,
      episode: eEpisode,
      source: 'EZTV',
    });
  }

  console.log(`[EZTV] Found ${streams.length} results for ${imdbId}`);
  return streams;
}

// ─── 1337x Provider (Fallback) ──────────────────────

async function search1337x(query) {
  const streams = [];
  // Clean query: remove special chars that confuse search
  const cleanQuery = query.replace(/['']/g, ' ').replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  // Try primary domain first, then mirrors if 403/blocked
  const domains = ['1337x.to', '1337x.st', '1337x.gd', '1337x.ws', '1337x.is'];
  let html = null;
  for (const domain of domains) {
    html = await fetchHTML(
      `https://${domain}/search/${encodeURIComponent(cleanQuery)}/1/`
    );
    if (html) break;
  }
  if (!html) return streams;

  const $ = cheerio.load(html);
  const links = [];
  $('td.name a[href^="/torrent/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) links.push(href);
  });

  console.log(`[1337x] Found ${links.length} search results for "${query}"`);

  // Fetch details for top 10 results to get magnet/hash
  const detailPromises = links.slice(0, 10).map(async (path) => {
    const detailHtml = await fetchHTML(`https://1337x.to${path}`);
    if (!detailHtml) return null;

    const d$ = cheerio.load(detailHtml);
    const magnetLink = d$('a[href^="magnet:"]').attr('href');
    if (!magnetLink) return null;

    const hashMatch = magnetLink.match(/btih:([a-fA-F0-9]{40})/);
    if (!hashMatch) return null;

    const title = d$('h1').first().text().trim();
    const seedsText = d$('.seeds').first().text().trim();
    const sizeText = d$('.info-row .list li:contains("Total size") span').text().trim()
      || d$('.torrent-detail-page .list li').filter((_, el) => d$(el).text().includes('Total size')).find('span').text().trim();

    const quality = title.match(/\b(2160p|1080p|720p|480p)\b/i);

    return {
      infoHash: hashMatch[1].toLowerCase(),
      title: `${title}\n${quality ? quality[1] + ' ' : ''}${sizeText} | Seeds: ${seedsText}`,
      magnetUri: magnetLink,
      quality: quality ? quality[1] : '',
      size: sizeText,
      seeds: parseInt(seedsText, 10) || 0,
      source: '1337x',
    };
  });

  const results = await Promise.all(detailPromises);
  for (const r of results) {
    if (r) streams.push(r);
  }

  return streams;
}

// ─── Nyaa.si Provider (Anime) ──────────────────────

// Mirror domains — try next if primary is unreachable
const NYAA_DOMAINS = ['nyaa.si', 'nyaa.land', 'nyaa.ink'];

// Anime title aliases: TMDB/English title → Nyaa fansub naming conventions
const ANIME_TITLE_ALIASES = {
  'naruto shippuden': ['naruto shippuuden'],
  'naruto: shippuden': ['naruto shippuuden'],
  'attack on titan': ['shingeki no kyojin'],
  'my hero academia': ['boku no hero academia'],
  'demon slayer': ['kimetsu no yaiba'],
  'demon slayer: kimetsu no yaiba': ['kimetsu no yaiba'],
  'jujutsu kaisen': ['jujutsu kaisen'],
  'spy x family': ['spy x family'],
  'one punch man': ['one punch man'],
  'fullmetal alchemist: brotherhood': ['fullmetal alchemist brotherhood'],
  'hunter x hunter': ['hunter x hunter'],
  'dragon ball super': ['dragon ball super'],
  'dragon ball super: super hero': ['dragon ball super super hero'],
  'sword art online': ['sword art online'],
  'tokyo ghoul': ['tokyo ghoul'],
  'black clover': ['black clover'],
  'fairy tail': ['fairy tail'],
  'solo leveling': ['ore dake level up na ken', 'solo leveling'],
  "frieren: beyond journey's end": ['sousou no frieren'],
  'frieren beyond journeys end': ['sousou no frieren'],
  'dandadan': ['dandadan', 'dandan'],
  'one piece': ['one piece'],
  'bleach': ['bleach'],
  'bleach: thousand-year blood war': ['bleach sennen kessen-hen', 'bleach thousand year blood war'],
  'vinland saga': ['vinland saga'],
  'chainsaw man': ['chainsaw man'],
  'mob psycho 100': ['mob psycho 100'],
  're:zero': ['re zero'],
  'mushoku tensei': ['mushoku tensei'],
  'mushoku tensei: jobless reincarnation': ['mushoku tensei'],
  'the eminence in shadow': ['kage no jitsuryokusha ni naritakute'],
  'kaiju no. 8': ['kaiju no 8', 'kaiju 8-gou'],
  'undead unluck': ['undead unluck'],
  'mashle': ['mashle'],
  'sakamoto days': ['sakamoto days'],
};

// Trusted fansub groups — boosted in ranking (not filtered)
const TRUSTED_GROUPS = [
  'subsplease', 'erai-raws', 'judas', 'ember', 'horriblesubs',
  'commie', 'damedesuyo', 'chihiro', 'horrible subs', 'hs',
  'sallysubs', 'yameii', 'tenshi', 'anime time', 'bonkai77',
];

/**
 * Clean anime title for Nyaa search: strip unicode, punctuation, normalize whitespace.
 * Returns array of unique search title variants (original cleaned + aliases).
 */
function getAnimeSearchTitles(rawTitle) {
  // Normalize unicode: ū→u, ō→o, etc.
  const normalized = rawTitle
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\u016b/g, 'u').replace(/\u014d/g, 'o')
    .replace(/\u016a/g, 'U').replace(/\u014c/g, 'O');
  // Strip colons, parentheses, and other search-breaking punctuation
  const cleaned = normalized
    .replace(/[:()[\]!?'".,;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const titles = new Set();
  titles.add(cleaned);

  // Look up aliases by lowercase cleaned title
  const lower = cleaned.toLowerCase();
  for (const [key, aliases] of Object.entries(ANIME_TITLE_ALIASES)) {
    if (lower === key || lower.startsWith(key + ' ') || lower.includes(key)) {
      for (const alias of aliases) titles.add(alias);
    }
  }

  return [...titles];
}

/**
 * Fetch Nyaa RSS from first responsive mirror domain.
 */
async function fetchNyaaRss(queryString, timeout = 12000) {
  for (const domain of NYAA_DOMAINS) {
    const url = `https://${domain}/?f=0&c=1_2&s=seeders&o=desc&page=rss&q=${encodeURIComponent(queryString)}`;
    const xml = await fetchHTML(url, timeout).catch(() => null);
    if (xml) return xml;
  }
  return null;
}

/**
 * Parse Nyaa RSS XML into stream objects, deduplicating by infoHash.
 */
function parseNyaaRss(xml, seenHashes, maxItems = 40) {
  const results = [];
  if (!xml) return results;
  const items = xml.split('<item>').slice(1);
  for (const item of items.slice(0, maxItems)) {
    const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
    const linkMatch = item.match(/<nyaa:infoHash>(.*?)<\/nyaa:infoHash>/);
    const seedMatch = item.match(/<nyaa:seeders>(.*?)<\/nyaa:seeders>/);
    const sizeMatch = item.match(/<nyaa:size>(.*?)<\/nyaa:size>/);

    if (!linkMatch) continue;
    const hash = linkMatch[1].toLowerCase();
    if (seenHashes.has(hash)) continue;
    seenHashes.add(hash);

    const title = (titleMatch ? (titleMatch[1] || titleMatch[2]) : 'Unknown').trim();
    const seeds = seedMatch ? parseInt(seedMatch[1], 10) : 0;
    const sizeStr = sizeMatch ? sizeMatch[1] : '';

    const quality = title.match(/\b(2160p|1080p|720p|480p)\b/i);

    // Detect if this is a batch/pack release
    const isBatch = /\bbatch\b/i.test(title) || /\bcomplete\b/i.test(title) ||
      /\d+\s*[-~]\s*\d+/.test(title) || /\bseason\s*\d/i.test(title) ||
      (/\bS\d+\b/i.test(title) && !/\bS\d+E\d+\b/i.test(title));

    // Detect trusted fansub group: [GroupName] prefix
    const groupMatch = title.match(/^\[([^\]]+)\]/);
    const isTrusted = groupMatch
      ? TRUSTED_GROUPS.some(g => groupMatch[1].toLowerCase().includes(g))
      : false;

    results.push({
      infoHash: hash,
      title: `${title}\n${quality ? quality[1] + ' ' : ''}${sizeStr} | Seeds: ${seeds}${isBatch ? ' | BATCH' : ''}${isTrusted ? ' | \u2605' : ''}`,
      magnetUri: buildMagnet(hash, title),
      quality: quality ? quality[1] : '',
      size: sizeStr,
      seeds,
      source: 'Nyaa',
      isBatch,
      _isTrusted: isTrusted,
    });
  }
  return results;
}

async function searchNyaa(query, season, episode, absoluteEpisode) {
  const streams = [];

  // Use absolute episode number when available (more accurate for anime)
  const ep = absoluteEpisode || episode;

  // Get all title variants (cleaned original + aliases)
  const searchTitles = getAnimeSearchTitles(query);
  console.log(`[Nyaa] Search titles for "${query}": ${JSON.stringify(searchTitles)}`);

  // Build search URLs for all title variants × episode format combinations
  const searchQueries = new Set();
  for (const title of searchTitles) {
    if (ep !== undefined) {
      const epStr2 = String(ep).padStart(2, '0');
      const epStr3 = String(ep).padStart(3, '0');
      // Format 1: "Title 05" (standard)
      searchQueries.add(`${title} ${epStr2}`);
      // Format 2: "Title - 05" (fansub dash convention)
      searchQueries.add(`${title} - ${epStr2}`);
      if (ep >= 100) {
        // Format 3: 3-digit padding for long-running series
        searchQueries.add(`${title} ${epStr3}`);
        searchQueries.add(`${title} - ${epStr3}`);
      }
    } else {
      searchQueries.add(title);
    }
  }

  // Fetch all search variants in parallel (across mirrors)
  const xmlResults = await Promise.all(
    [...searchQueries].map(q => fetchNyaaRss(q).catch(() => null))
  );

  if (xmlResults.every(x => !x)) {
    console.log(`[Nyaa] No response for any query variant`);
    return streams;
  }

  // Parse all results, dedup by infoHash
  const seenHashes = new Set();
  for (const xml of xmlResults) {
    streams.push(...parseNyaaRss(xml, seenHashes));
  }

  // Post-fetch episode filtering: verify results actually match the requested episode
  if (ep !== undefined && streams.length > 0) {
    const epStr = String(ep);
    const epPatterns = [
      // Match "- 05" or "- 005" (fansub convention) but not inside resolution like "1080"
      new RegExp(`(?:^|\\s|-)\\s*0*${epStr}\\b(?!\\d|p)`, 'i'),
      // Match "E05" or "EP05"
      new RegExp(`E[Pp]?0*${epStr}\\b`, 'i'),
      // Match "Episode 5" or "Episode 05"
      new RegExp(`Episode\\s*0*${epStr}\\b`, 'i'),
      // Match v2/v3 variants: "05v2", "05 v2"
      new RegExp(`0*${epStr}\\s*v\\d\\b`, 'i'),
    ];
    const filtered = streams.filter(s => {
      if (s.isBatch) {
        // For batches, check if episode falls within the range (e.g., "01-26")
        const t = (s.title || '').split('\n')[0];
        const rangeMatch = t.match(/(\d+)\s*[-~]\s*(\d+)/);
        if (rangeMatch) {
          const lo = parseInt(rangeMatch[1], 10);
          const hi = parseInt(rangeMatch[2], 10);
          return ep >= lo && ep <= hi;
        }
        return true; // keep batches without clear range
      }
      const t = (s.title || '').split('\n')[0];
      return epPatterns.some(p => p.test(t));
    });
    if (filtered.length > 0) {
      console.log(`[Nyaa] Episode filter: ${filtered.length}/${streams.length} match ep ${ep}`);
      streams.length = 0;
      streams.push(...filtered);
    }
  }

  // If we didn't find individual episodes, try batch/pack search
  if (streams.length < 3 && season !== undefined) {
    const batchTitles = getAnimeSearchTitles(query);
    const batchQueries = [];
    for (const title of batchTitles) {
      batchQueries.push(`${title} batch`);
      batchQueries.push(`${title} complete`);
    }
    const batchResults = await Promise.all(
      batchQueries.map(q => fetchNyaaRss(q).catch(() => null))
    );
    for (const xml of batchResults) {
      streams.push(...parseNyaaRss(xml, seenHashes, 10));
    }
  }

  // Sort: trusted groups first, then by seed count
  streams.sort((a, b) => {
    if (a._isTrusted !== b._isTrusted) return a._isTrusted ? -1 : 1;
    return (b.seeds || 0) - (a.seeds || 0);
  });

  console.log(`[Nyaa] Found ${streams.length} results for "${query}" (${searchQueries.size} query variants)`);
  return streams;
}

// ─── Stream Filtering & Ranking ─────────────────────

// Only filter torrents that we KNOW are dead (confirmed 0 seeds).
// Streams where seed count couldn't be parsed are kept (_seedsUnknown).
const MIN_SEEDS = 0;

/**
 * Detect the likely file format from the torrent name.
 */
function detectFormat(name) {
  if (/\.mp4\b/i.test(name) || /\bx264\b/i.test(name) || /\bH\.?264\b/i.test(name)) return 'MP4';
  if (/\.webm\b/i.test(name)) return 'WebM';
  if (/\.mkv\b/i.test(name) || /\bx265\b/i.test(name) || /\bH\.?265\b/i.test(name) || /\bHEVC\b/i.test(name)) return 'MKV';
  if (/\.avi\b/i.test(name) || /\bXviD\b/i.test(name) || /\bDivX\b/i.test(name)) return 'AVI';
  if (/\.wmv\b/i.test(name)) return 'WMV';
  if (/\bWEB-?DL\b/i.test(name) || /\bWEB-?Rip\b/i.test(name) || /\bWEBRip\b/i.test(name)) return 'MP4'; // WEB-DL is almost always MP4
  if (/\bBluRay\b/i.test(name) || /\bBDRip\b/i.test(name)) return 'MKV'; // BluRay rips are usually MKV
  if (/\bHDRip\b/i.test(name)) return 'MP4'; // HDRip usually MP4
  return 'Unknown';
}

/**
 * Check if a stream needs FFmpeg remuxing to be playable.
 * x265/HEVC video needs remuxing. Non-browser audio codecs (AC3, DTS, etc.)
 * also need remuxing — browsers only natively support AAC/MP3/Opus audio.
 */
function needsRemux(name) {
  // Video codecs that need remux
  if (/\bx265\b/i.test(name) || /\bH\.?265\b/i.test(name) || /\bHEVC\b/i.test(name)) return true;
  // Audio codecs that browsers can't play natively
  if (/\b(AC-?3|DTS|DTS-HD|EAC-?3|DD[P+]|TrueHD|Atmos|FLAC)\b/i.test(name)) return true;
  return false;
}

/**
 * Filter and rank streams:
 * - Remove torrents with too few seeds
 * - Tag each with detected format
 * - x265/HEVC streams are kept but marked as needing remux
 * - Sort: native-playable first, then remuxable, then by seeds
 */
function filterAndRank(streams, expectedTitle) {
  console.log(`[FilterRank] Input: ${streams.length} streams, expectedTitle: "${expectedTitle || ''}"`);

  // Filter confirmed-dead torrents (seeds === 0 and seed count was actually parsed).
  // Keep streams where seed count is unknown (_seedsUnknown) — they may still be alive.
  let filtered = streams.filter(s => s._seedsUnknown || (s.seeds || 0) >= MIN_SEEDS);
  if (filtered.length !== streams.length) {
    console.log(`[FilterRank] After seed filter: ${filtered.length} (removed ${streams.length - filtered.length} dead)`);
  }

  // Tag each stream with format info
  const formatCounts = {};
  for (const s of filtered) {
    s.format = detectFormat(s.title);
    s.needsRemux = needsRemux(s.title);
    s.browserPlayable = (s.format === 'MP4' || s.format === 'WebM') && !s.needsRemux;
    s.remuxPlayable = s.format === 'MKV' || s.needsRemux;
    formatCounts[s.format] = (formatCounts[s.format] || 0) + 1;
    // Add format to the display title
    if (s.format !== 'Unknown') {
      const remuxTag = s.needsRemux ? ' ⟳REMUX' : '';
      s.title = s.title.replace(/\n/, ` [${s.format}${remuxTag}]\n`);
    }
  }
  console.log(`[FilterRank] Formats: ${JSON.stringify(formatCounts)}`);

  // Only remove truly unplayable formats (AVI, WMV) — keep x265 since we can remux
  const beforeFormat = filtered.length;
  filtered = filtered.filter(s => {
    if (s.format === 'AVI' || s.format === 'WMV') return false;
    return true;
  });
  if (filtered.length !== beforeFormat) {
    console.log(`[FilterRank] After format filter: ${filtered.length} (removed ${beforeFormat - filtered.length} AVI/WMV)`);
  }

  // Score title relevance — penalize torrents that don't match the expected title
  if (expectedTitle) {
    const normalise = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const expectedWords = normalise(expectedTitle).split(/\s+/).filter(w => w.length > 1);
    for (const s of filtered) {
      const torrentName = normalise((s.title || '').split('\n')[0]);
      // Count how many words from the expected title appear in the torrent name
      const matchCount = expectedWords.filter(w => torrentName.includes(w)).length;
      s._titleRelevance = expectedWords.length > 0 ? matchCount / expectedWords.length : 1;
    }
    const mismatches = filtered.filter(s => s._titleRelevance < 0.5).length;
    if (mismatches > 0) {
      console.log(`[FilterRank] Title relevance: ${mismatches} streams have <50% word match with "${expectedTitle}"`);
    }
  } else {
    for (const s of filtered) s._titleRelevance = 1;
  }

  // Sort: title relevance first (>= 50% match vs < 50%),
  // then browser-playable > remuxable > unknown,
  // then prefer direct sources over Torrentio,
  // then by seeds descending
  filtered.sort((a, b) => {
    // Strong title mismatches sink to the bottom
    const relA = a._titleRelevance >= 0.5 ? 1 : 0;
    const relB = b._titleRelevance >= 0.5 ? 1 : 0;
    if (relA !== relB) return relB - relA;

    const scoreA = a.browserPlayable ? 2 : (a.remuxPlayable ? 1 : 0);
    const scoreB = b.browserPlayable ? 2 : (b.remuxPlayable ? 1 : 0);
    if (scoreA !== scoreB) return scoreB - scoreA;
    // Prefer direct provider results over Torrentio (aggregator)
    const directA = (a.source && a.source !== 'Torrentio') ? 1 : 0;
    const directB = (b.source && b.source !== 'Torrentio') ? 1 : 0;
    if (directA !== directB) return directB - directA;
    // Among similar relevance, prefer higher relevance
    if (Math.abs(a._titleRelevance - b._titleRelevance) > 0.2) return b._titleRelevance - a._titleRelevance;
    return (b.seeds || 0) - (a.seeds || 0);
  });

  return filtered;
}

// ─── Stream Cache ──────────────────────────────────────
// In-memory cache for stream results to avoid redundant provider queries.
// Particularly important for anime with deep episode history where users
// navigate back and forth between episodes.

const _streamCache = new Map();
const STREAM_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const STREAM_CACHE_MAX = 200;

function getCachedStreams(key) {
  const entry = _streamCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > STREAM_CACHE_TTL) {
    _streamCache.delete(key);
    return null;
  }
  return entry.streams;
}

function setCachedStreams(key, streams) {
  if (_streamCache.size >= STREAM_CACHE_MAX) {
    // Evict oldest entry
    const oldest = _streamCache.keys().next().value;
    _streamCache.delete(oldest);
  }
  _streamCache.set(key, { streams, ts: Date.now() });
}

// ─── Public API ─────────────────────────────────────

/**
 * Get streams for a movie by IMDB ID.
 * Queries Torrentio first, then fallback scrapers.
 * Always runs fallbacks if filtered results are too few.
 */
async function getMovieStreams(imdbId, title) {
  const id = sanitizeImdbId(imdbId);
  if (!id && !title) return [];

  const cacheKey = `movie:${id || `title:${title}`}`;
  const cached = getCachedStreams(cacheKey);
  if (cached) {
    console.log(`[Streams] Cache hit for ${cacheKey} (${cached.length} streams)`);
    return cached;
  }

  console.log(`[Streams] Searching movie streams for ${id || 'no-imdb'} (title: "${title || 'unknown'}")`);

  // Run Torrentio AND fallbacks in parallel — don't wait for Torrentio first.
  // This halves latency when Torrentio is slow/down, and ensures fallbacks
  // always contribute results regardless of Torrentio's response.
  // When no IMDB ID is available, skip providers that require it (Torrentio, YTS).
  const tpbQuery = title || id;
  const [torrentioStreams, tpb, yts, x1337] = await Promise.all([
    id ? searchTorrentio('movie', id).catch(e => {
      console.log(`[Torrentio] Error: ${e.message}`);
      return [];
    }) : Promise.resolve([]),
    searchTPB(tpbQuery).catch(e => { console.log(`[TPB] Error: ${e.message}`); return []; }),
    id ? searchYTS(id).catch(e => { console.log(`[YTS] Error: ${e.message}`); return []; }) : Promise.resolve([]),
    search1337x(title || id).catch(e => { console.log(`[1337x] Error: ${e.message}`); return []; }),
  ]);

  console.log(`[Streams] Provider results — Torrentio: ${torrentioStreams.length}, TPB: ${tpb.length}, YTS: ${yts.length}, 1337x: ${x1337.length}`);

  // Deduplicate by infoHash, prefer TPB first (most reliable direct results),
  // then other fallbacks, then Torrentio
  const seen = new Set();
  const combined = [];
  for (const s of [...tpb, ...yts, ...x1337, ...torrentioStreams]) {
    if (!seen.has(s.infoHash)) {
      seen.add(s.infoHash);
      combined.push(s);
    }
  }

  console.log(`[Streams] Combined: ${combined.length} unique streams for ${id}`);

  const ranked = filterAndRank(combined, title);
  console.log(`[Streams] Total: ${ranked.length} streams (${ranked.filter(s => s.browserPlayable).length} browser-playable, ${ranked.filter(s => s.remuxPlayable).length} remuxable) for ${id}`);
  if (ranked.length > 0) setCachedStreams(cacheKey, ranked);
  return ranked;
}

/**
 * Detect if a title is likely anime based on title patterns and genre metadata.
 */
function isLikelyAnime(title, genres) {
  if (!title) return false;
  const t = title.toLowerCase();

  // Signal 1: Explicit anime keywords
  if (/\b(anime|sub|dub|dual[\s-]?audio|multi[\s-]?sub)\b/i.test(t)) return true;

  // Signal 2: Known anime titles
  if (/\b(shippuden|boruto|piece|naruto|bleach|dragon\s*ball|attack\s*on\s*titan|jujutsu|demon\s*slayer|one\s*punch|hunter\s*x|fullmetal|my\s*hero|sword\s*art|death\s*note|cowboy\s*bebop|neon\s*genesis|mob\s*psycho|chainsaw\s*man|spy\s*x|vinland|tokyo\s*ghoul|fairy\s*tail|black\s*clover|haikyuu|jojo|overlord|konosuba|re:?\s*zero|mushoku|frieren|eminence|solo\s*leveling|kaiju|dandadan|sakamoto|mashle|undead\s*unluck)\b/i.test(t)) return true;

  // Signal 3: Genre metadata from TMDB
  if (genres && Array.isArray(genres) && genres.length > 0) {
    const g = genres.map(x => x.toLowerCase());
    if (g.includes('anime')) return true;
    if (g.includes('animation') && g.some(x => x === 'action' || x === 'fantasy' || x === 'sci-fi' || x === 'adventure')) return true;
  }

  return false;
}

/**
 * Get streams for a TV episode by IMDB ID + season/episode.
 * Queries Torrentio, fallback scrapers, and Nyaa (for anime) in parallel.
 * Supports absolute episode numbering and batch/pack torrents.
 */
async function getSeriesStreams(imdbId, season, episode, title, opts = {}) {
  const id = sanitizeImdbId(imdbId);
  if (!id && !title) return [];

  const cacheKey = `series:${id || `title:${title}`}:${season}:${episode}`;
  const cached = getCachedStreams(cacheKey);
  if (cached) {
    console.log(`[Streams] Cache hit for ${cacheKey} (${cached.length} streams)`);
    return cached;
  }

  const se = season !== undefined && episode !== undefined;
  const seTag = se
    ? `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
    : '';

  console.log(`[Streams] Searching series streams for ${id || 'no-imdb'} ${seTag} (title: "${title || 'unknown'}")`);

  // Determine if this might be anime (for Nyaa search)
  const { absEp, genres = [] } = opts;
  const anime = isLikelyAnime(title, genres);
  const tpbQuery = se ? `${title || id} ${seTag}` : (title || id);

  // Run ALL providers in parallel — don't wait for Torrentio first.
  // This eliminates the sequential bottleneck when Torrentio is slow/down.
  // When no IMDB ID is available, skip providers that require it (Torrentio, EZTV).
  const providerPromises = [
    id ? searchTorrentio('series', id, season, episode).catch(e => { console.log(`[Torrentio] Error: ${e.message}`); return []; }) : Promise.resolve([]),
    id ? searchEZTV(id, season, episode).catch(e => { console.log(`[EZTV] Error: ${e.message}`); return []; }) : Promise.resolve([]),
    searchTPB(tpbQuery).catch(e => { console.log(`[TPB] Error: ${e.message}`); return []; }),
    se ? search1337x(`${title || id} ${seTag}`).catch(e => { console.log(`[1337x] Error: ${e.message}`); return []; }) : Promise.resolve([]),
  ];

  // Always search Nyaa for anime, passing absolute episode number
  if (anime) {
    providerPromises.push(
      searchNyaa(title || id, season, episode, absEp).catch(e => { console.log(`[Nyaa] Error: ${e.message}`); return []; })
    );
  }

  const [torrentioStreams, eztvStreams, tpbStreams, x1337Streams, ...rest] = await Promise.all(providerPromises);
  const nyaaStreams = anime ? (rest[0] || []) : [];

  console.log(`[Streams] Provider results — Torrentio: ${torrentioStreams.length}, EZTV: ${eztvStreams.length}, TPB: ${tpbStreams.length}, 1337x: ${x1337Streams.length}${anime ? `, Nyaa: ${nyaaStreams.length}` : ''}`);

  // Filter EZTV results to matching season/episode if specified
  let filteredEztv = eztvStreams;
  if (se) {
    filteredEztv = eztvStreams.filter(s =>
      s.season === season && s.episode === episode
    );
    console.log(`[EZTV] Season/episode match (s=${season} e=${episode}): ${filteredEztv.length}/${eztvStreams.length}`);
    if (filteredEztv.length === 0) {
      // Log sample EZTV data to debug mismatches
      if (eztvStreams.length > 0) {
        const sample = eztvStreams.slice(0, 3).map(s => ({ season: s.season, episode: s.episode, title: (s.title || '').split('\n')[0] }));
        console.log(`[EZTV] Sample data (no s/e match): ${JSON.stringify(sample)}`);
      }
      filteredEztv = eztvStreams.filter(s =>
        s.title && s.title.toUpperCase().includes(seTag)
      );
      console.log(`[EZTV] Title tag match ("${seTag}"): ${filteredEztv.length}/${eztvStreams.length}`);
    }
    // For anime: also try absolute episode number (e.g., "- 05" or "E05" without season)
    if (filteredEztv.length === 0 && episode !== undefined) {
      const absEp = String(episode).padStart(2, '0');
      const absEp3 = String(episode).padStart(3, '0');
      filteredEztv = eztvStreams.filter(s => {
        const t = (s.title || '').toUpperCase();
        return t.includes(`- ${absEp}`) || t.includes(`- ${absEp3}`) ||
          t.includes(`E${absEp}`) || t.includes(`EP${absEp}`) ||
          t.includes(`EPISODE ${episode}`);
      });
    }
  }

  // Also try Nyaa on non-anime titles if all other providers returned nothing
  let lateNyaaStreams = [];
  if (!anime && torrentioStreams.length === 0 && tpbStreams.length === 0 && x1337Streams.length === 0 && filteredEztv.length === 0) {
    console.log(`[Streams] All providers empty, trying Nyaa as last resort...`);
    lateNyaaStreams = await searchNyaa(title || id, season, episode, absEp).catch(e => {
      console.log(`[Nyaa] Error: ${e.message}`);
      return [];
    });
  }

  // Deduplicate by infoHash, prefer TPB first (most reliable direct results),
  // then other fallbacks, then Torrentio
  const seen = new Set();
  const combined = [];
  for (const s of [...tpbStreams, ...filteredEztv, ...x1337Streams, ...torrentioStreams, ...nyaaStreams, ...lateNyaaStreams]) {
    if (!seen.has(s.infoHash)) {
      seen.add(s.infoHash);
      combined.push(s);
    }
  }

  console.log(`[Streams] Combined: ${combined.length} unique streams (Torrentio: ${torrentioStreams.length}, TPB: ${tpbStreams.length}, EZTV filtered: ${filteredEztv.length}, 1337x: ${x1337Streams.length})`);
  if (combined.length > 0 && combined.length <= 3) {
    // Log details for debugging when few results
    for (const s of combined) {
      console.log(`[Streams]   → [${s.source}] ${(s.title || '').split('\n')[0]} (seeds: ${s.seeds}, hash: ${s.infoHash.substring(0, 8)}...)`);
    }
  }

  const ranked = filterAndRank(combined, title);
  const batchCount = ranked.filter(s => s.isBatch).length;
  console.log(`[Streams] Total: ${ranked.length} streams (${ranked.filter(s => s.browserPlayable).length} browser-playable, ${ranked.filter(s => s.remuxPlayable).length} remuxable, ${batchCount} batch) for ${id} ${seTag}`);
  if (ranked.length > 0) setCachedStreams(cacheKey, ranked);
  return ranked;
}

// ─── Diagnostics ──────────────────────────────────

/**
 * Test connectivity to each provider and return status.
 * Uses a well-known IMDB ID (The Shawshank Redemption) for testing.
 * Reports both raw HTTP connectivity and actual search results.
 */
async function diagnoseProviders() {
  const testImdb = 'tt0111161'; // The Shawshank Redemption
  const results = {};

  const testProvider = async (name, fn) => {
    const start = Date.now();
    try {
      const data = await fn();
      const ms = Date.now() - start;
      results[name] = { ok: true, count: Array.isArray(data) ? data.length : 0, ms };
    } catch (e) {
      const ms = Date.now() - start;
      results[name] = { ok: false, error: e.message, ms };
    }
  };

  // Raw connectivity checks (HTTP status + response snippet)
  const testConnectivity = async (name, url) => {
    const start = Date.now();
    try {
      const res = await httpGet(url, 10000);
      const ms = Date.now() - start;
      const bodySnippet = (res.body || '').slice(0, 200);
      const isCloudflare = bodySnippet.includes('cf-') || bodySnippet.includes('Cloudflare') || bodySnippet.includes('Just a moment');
      const isHtml = bodySnippet.trim().startsWith('<');
      results[name + '_http'] = {
        status: res.status || (res.ok ? 200 : 0),
        ok: res.ok,
        cloudflare: isCloudflare,
        htmlResponse: isHtml && !bodySnippet.includes('{'),
        ms,
      };
    } catch (e) {
      const ms = Date.now() - start;
      results[name + '_http'] = {
        status: 0,
        ok: false,
        error: e.message,
        ms,
      };
    }
  };

  await Promise.all([
    // Connectivity checks (test primary domain)
    testConnectivity('torrentio', `${TORRENTIO_BASE}/manifest.json`),
    testConnectivity('yts', `https://${YTS_DOMAINS[0]}/api/v2/list_movies.json?limit=1`),
    testConnectivity('eztv', `https://${EZTV_DOMAINS[0]}/api/get-torrents?limit=1&page=1`),
    testConnectivity('tpb', 'https://apibay.org/q.php?q=test&cat=200'),
    testConnectivity('1337x', 'https://1337x.to/'),

    // Search result checks (these try all mirrors automatically)
    testProvider('torrentio', async () => {
      for (const base of TORRENTIO_MIRRORS) {
        for (const config of TORRENTIO_CONFIGS) {
          const url = config
            ? `${base}/${config}/stream/movie/${testImdb}.json`
            : `${base}/stream/movie/${testImdb}.json`;
          const data = await fetchJSON(url, 12000, 0);
          if (data && Array.isArray(data.streams) && data.streams.length > 0) {
            results._torrentioConfig = config || '(bare)';
            results._torrentioMirror = base;
            return data.streams;
          }
        }
      }
      return [];
    }),
    testProvider('tpb', () => searchTPB('Shawshank Redemption')),
    testProvider('yts', () => searchYTS(testImdb)),
    testProvider('eztv', async () => {
      // EZTV is TV-only — test with Breaking Bad (tt0903747) which always has results
      const numericId = '903747';
      for (const domain of EZTV_DOMAINS) {
        const data = await fetchJSON(`https://${domain}/api/get-torrents?imdb_id=${numericId}&limit=5&page=1`, 10000, 0);
        if (data && data.torrents && data.torrents.length > 0) {
          results._eztvMirror = domain;
          return data.torrents;
        }
      }
      return [];
    }),
    testProvider('1337x', () => search1337x('Shawshank Redemption')),
  ]);

  // Overall status
  const working = Object.entries(results)
    .filter(([k, v]) => !k.startsWith('_') && !k.includes('_http') && v.ok && v.count > 0)
    .map(([k]) => k);
  results._summary = {
    working,
    total: Object.keys(results).filter(k => !k.startsWith('_') && !k.includes('_http')).length,
    allDown: working.length === 0,
  };

  return results;
}

// ─── Season Pack Search ────────────────────────────
// Search for full-season pack torrents (e.g., "Breaking Bad S01 Complete 1080p")
// across TPB and 1337x. Filters out individual episodes, keeping only packs.

const SEASON_PACK_MIN_SIZE_BYTES = 1.5 * 1024 * 1024 * 1024; // 1.5 GB minimum for a season pack

function isSeasonPack(name, sizeBytes) {
  const upper = (name || '').toUpperCase();
  // Must NOT be a single episode (S01E05 pattern)
  if (/\bS\d+E\d+\b/i.test(name)) return false;
  // Positive signals: "Complete", "Season N", "S01" without episode, range like "E01-E10"
  const hasPackSignal =
    /\bcomplete\b/i.test(name) ||
    /\bseason\s*\d/i.test(name) ||
    /\bfull\s*season\b/i.test(name) ||
    /\bS\d+\b/i.test(name) ||
    /E\d+\s*[-–~]\s*E?\d+/i.test(name) ||
    /\d+\s*[-–~]\s*\d+/.test(name) ||
    /\bbatch\b/i.test(name);
  // If size is known and large enough, that's a strong signal even without keywords
  const isLarge = sizeBytes > 0 && sizeBytes >= SEASON_PACK_MIN_SIZE_BYTES;
  return hasPackSignal || isLarge;
}

function parsePackSizeBytes(sizeStr) {
  if (!sizeStr) return 0;
  const match = sizeStr.match(/([\d.]+)\s*(GB|MB|TB)/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  if (unit === 'TB') return num * 1024 * 1024 * 1024 * 1024;
  if (unit === 'GB') return num * 1024 * 1024 * 1024;
  if (unit === 'MB') return num * 1024 * 1024;
  return 0;
}

async function getSeasonPackStreams(title, season, imdbId) {
  if (!title && !imdbId) return [];

  const seasonNum = parseInt(season, 10);
  if (isNaN(seasonNum)) return [];

  const sTag = `S${String(seasonNum).padStart(2, '0')}`;
  const searchTitle = (title || '').replace(/['']/g, ' ').replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim();

  const cacheKey = `season-pack:${imdbId || searchTitle}:${seasonNum}`;
  const cached = getCachedStreams(cacheKey);
  if (cached) {
    console.log(`[SeasonPack] Cache hit for ${cacheKey} (${cached.length} streams)`);
    return cached;
  }

  console.log(`[SeasonPack] Searching packs for "${searchTitle}" ${sTag}`);

  // Build multiple search queries to maximize coverage
  const queries = [
    `${searchTitle} ${sTag}`,
    `${searchTitle} Season ${seasonNum}`,
    `${searchTitle} ${sTag} Complete`,
  ];

  // Run TPB and 1337x searches in parallel with all query variants
  const promises = [];
  for (const q of queries) {
    promises.push(searchTPB(q).catch(e => { console.log(`[SeasonPack/TPB] Error: ${e.message}`); return []; }));
    promises.push(search1337x(q).catch(e => { console.log(`[SeasonPack/1337x] Error: ${e.message}`); return []; }));
  }

  const results = await Promise.all(promises);
  const allStreams = results.flat();

  // Deduplicate by infoHash
  const seen = new Set();
  const unique = [];
  for (const s of allStreams) {
    if (!seen.has(s.infoHash)) {
      seen.add(s.infoHash);
      unique.push(s);
    }
  }

  console.log(`[SeasonPack] Raw results: ${allStreams.length}, unique: ${unique.length}`);

  // Filter to only season packs
  const packs = unique.filter(s => {
    const name = (s.title || '').split('\n')[0]; // First line is the torrent name
    const sizeBytes = parsePackSizeBytes(s.size);
    return isSeasonPack(name, sizeBytes);
  });

  // Tag them as packs
  for (const s of packs) {
    s.isSeasonPack = true;
  }

  console.log(`[SeasonPack] After pack filter: ${packs.length} packs`);

  const ranked = filterAndRank(packs, title);
  if (ranked.length > 0) setCachedStreams(cacheKey, ranked);
  return ranked;
}

// ─── Complete Search ──────────────────────────────
// Search for complete series/movie torrents (e.g., "Mad Men Complete Series 1080p")
// across TPB and 1337x. Appends "complete" to the search query to find bulk downloads
// containing all seasons in a single torrent.

const COMPLETE_MIN_SIZE_BYTES = 3 * 1024 * 1024 * 1024; // 3 GB minimum for a complete pack

function isCompletePack(name, sizeBytes) {
  const upper = (name || '').toUpperCase();
  // Must NOT be a single episode (S01E05 pattern)
  if (/\bS\d+E\d+\b/i.test(name)) return false;
  // Positive signals: "complete", "complete series", "all seasons", "collection", "boxset"
  const hasCompleteSignal =
    /\bcomplete\b/i.test(name) ||
    /\ball\s*seasons?\b/i.test(name) ||
    /\bcollection\b/i.test(name) ||
    /\bbox\s*set\b/i.test(name) ||
    /\bfull\s*series\b/i.test(name) ||
    /\bintegrale?\b/i.test(name) ||
    /\bS\d+\s*[-–~]\s*S?\d+/i.test(name);
  // If size is known and large enough, that's a strong signal even without keywords
  const isLarge = sizeBytes > 0 && sizeBytes >= COMPLETE_MIN_SIZE_BYTES;
  return hasCompleteSignal || isLarge;
}

async function getCompleteStreams(title, imdbId) {
  if (!title && !imdbId) return [];

  const searchTitle = (title || '').replace(/['']/g, ' ').replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim();

  const cacheKey = `complete:${imdbId || searchTitle}`;
  const cached = getCachedStreams(cacheKey);
  if (cached) {
    console.log(`[Complete] Cache hit for ${cacheKey} (${cached.length} streams)`);
    return cached;
  }

  console.log(`[Complete] Searching complete packs for "${searchTitle}"`);

  // Build multiple search queries to maximize coverage
  const queries = [
    `${searchTitle} complete`,
    `${searchTitle} complete series`,
    `${searchTitle} all seasons`,
  ];

  // Run TPB and 1337x searches in parallel with all query variants
  const promises = [];
  for (const q of queries) {
    promises.push(searchTPB(q).catch(e => { console.log(`[Complete/TPB] Error: ${e.message}`); return []; }));
    promises.push(search1337x(q).catch(e => { console.log(`[Complete/1337x] Error: ${e.message}`); return []; }));
  }

  const results = await Promise.all(promises);
  const allStreams = results.flat();

  // Deduplicate by infoHash
  const seen = new Set();
  const unique = [];
  for (const s of allStreams) {
    if (!seen.has(s.infoHash)) {
      seen.add(s.infoHash);
      unique.push(s);
    }
  }

  console.log(`[Complete] Raw results: ${allStreams.length}, unique: ${unique.length}`);

  // Filter to only complete packs
  const packs = unique.filter(s => {
    const name = (s.title || '').split('\n')[0];
    const sizeBytes = parsePackSizeBytes(s.size);
    return isCompletePack(name, sizeBytes);
  });

  // Tag them as complete packs
  for (const s of packs) {
    s.isCompletePack = true;
  }

  console.log(`[Complete] After pack filter: ${packs.length} packs`);

  const ranked = filterAndRank(packs, title);
  if (ranked.length > 0) setCachedStreams(cacheKey, ranked);
  return ranked;
}

// ─── YouTube (via yt-dlp) ──────────────────────────────
// Non-torrent source. Requires `yt-dlp` binary on the system PATH. Used as a
// fallback when no torrent seeds an obscure track.

const { spawn } = require('child_process');

let _ytdlpAvailable = null;

function isYtdlpAvailable() {
  if (_ytdlpAvailable !== null) return _ytdlpAvailable;
  return new Promise((resolve) => {
    const proc = spawn('yt-dlp', ['--version'], { stdio: 'ignore' });
    proc.on('error', () => { _ytdlpAvailable = false; resolve(false); });
    proc.on('exit', (code) => { _ytdlpAvailable = code === 0; resolve(_ytdlpAvailable); });
  });
}

async function searchYoutubeAudio(query) {
  if (!await isYtdlpAvailable()) return [];
  return new Promise((resolve) => {
    const results = [];
    // ytsearch5: returns up to 5 results. --flat-playlist skips per-video metadata fetches.
    const args = ['--dump-single-json', '--flat-playlist', '--no-warnings', `ytsearch5:${query}`];
    const proc = spawn('yt-dlp', args);
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => resolve([]));
    proc.on('exit', () => {
      try {
        const parsed = JSON.parse(out);
        const entries = (parsed && parsed.entries) || [];
        for (const e of entries) {
          if (!e || !e.id) continue;
          results.push({
            infoHash: null,
            source: 'YouTube',
            videoId: e.id,
            title: `${e.title || 'YouTube audio'}\n${e.channel || ''} | ${e.duration ? Math.round(e.duration) + 's' : ''}`,
            duration: e.duration,
            seeds: null,
            magnetUri: null,
            browserPlayable: true,
            _rawName: e.title || '',
          });
        }
      } catch { /* malformed output */ }
      resolve(results);
    });
    // Hard timeout — yt-dlp search can hang if the network's slow.
    setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, 15000);
  });
}

// ─── Music Providers ──────────────────────────────────
// Audio-category scrapers + aggregator. Audio torrents are typically tagged
// by format (MP3/FLAC) and bitrate (e.g. "320kbps") rather than video codec,
// so we use a dedicated filter/rank path instead of filterAndRank().

async function searchTPBAudio(query) {
  // Audio + Music + FLAC (ignore Audio Books 102 / Sound Clips 103 to reduce noise).
  return searchTPB(query, '100,101,104');
}

async function search1337xMusic(query) {
  const streams = [];
  const cleanQuery = query.replace(/['']/g, ' ').replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  const domains = ['1337x.to', '1337x.st', '1337x.gd', '1337x.ws', '1337x.is'];
  let html = null;
  for (const domain of domains) {
    html = await fetchHTML(
      `https://${domain}/category-search/${encodeURIComponent(cleanQuery)}/Music/1/`
    );
    if (html) break;
  }
  if (!html) return streams;

  const $ = cheerio.load(html);
  const links = [];
  $('td.name a[href^="/torrent/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) links.push(href);
  });

  console.log(`[1337xMusic] Found ${links.length} search results for "${query}"`);

  const detailPromises = links.slice(0, 10).map(async (p) => {
    const detailHtml = await fetchHTML(`https://1337x.to${p}`);
    if (!detailHtml) return null;
    const d$ = cheerio.load(detailHtml);
    const magnetLink = d$('a[href^="magnet:"]').attr('href');
    if (!magnetLink) return null;
    const hashMatch = magnetLink.match(/btih:([a-fA-F0-9]{40})/);
    if (!hashMatch) return null;
    const title = d$('h1').first().text().trim();
    const seedsText = d$('.seeds').first().text().trim();
    const sizeText = d$('.info-row .list li:contains("Total size") span').text().trim()
      || d$('.torrent-detail-page .list li').filter((_, el) => d$(el).text().includes('Total size')).find('span').text().trim();
    return {
      infoHash: hashMatch[1].toLowerCase(),
      title: `${title}\n${sizeText} | Seeds: ${seedsText}`,
      magnetUri: magnetLink,
      size: sizeText,
      seeds: parseInt(seedsText, 10) || 0,
      source: '1337xMusic',
      _rawName: title,
    };
  });

  const results = await Promise.all(detailPromises);
  for (const r of results) if (r) streams.push(r);
  return streams;
}

// Extract audio format and bitrate hints from torrent names.
function _audioClassify(name) {
  const n = (name || '').toLowerCase();
  let format = null;
  if (/\bflac\b/.test(n)) format = 'FLAC';
  else if (/\balac\b/.test(n)) format = 'ALAC';
  else if (/\b(m4a|aac)\b/.test(n)) format = 'AAC';
  else if (/\bogg\b|\bopus\b|\bvorbis\b/.test(n)) format = 'OGG';
  else if (/\bmp3\b/.test(n)) format = 'MP3';
  else if (/\bwav\b/.test(n)) format = 'WAV';

  // Lossy bitrate like "320kbps", "V0", "V2"
  let bitrate = null;
  const kbps = n.match(/(\b|[\s_[({])(\d{2,4})\s*kbps\b/);
  if (kbps) bitrate = parseInt(kbps[2], 10);
  else if (/\bv0\b/.test(n)) bitrate = 245;  // LAME V0 avg
  else if (/\bv2\b/.test(n)) bitrate = 190;
  else if (/\b320\b/.test(n)) bitrate = 320;

  // Lossless torrents are very large but we won't transcode — excluded from
  // the default browser-playable set. Still returned; UI can note "lossless".
  const browserPlayable = !['FLAC', 'ALAC', 'WAV'].includes(format || '');

  return { format, bitrate, browserPlayable };
}

function _rankAudioStreams(streams, expectedTitle) {
  const normalise = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const expectedWords = expectedTitle
    ? normalise(expectedTitle).split(/\s+/).filter(w => w.length > 1)
    : [];

  for (const s of streams) {
    const rawName = s._rawName || (s.title || '').split('\n')[0];
    const cls = _audioClassify(rawName);
    s.format = cls.format;
    s.bitrate = cls.bitrate;
    s.browserPlayable = cls.browserPlayable;
    s.lossless = !cls.browserPlayable && !!cls.format;
    const torrentName = normalise(rawName);
    const matchCount = expectedWords.length
      ? expectedWords.filter(w => torrentName.includes(w)).length
      : 0;
    s._titleRelevance = expectedWords.length ? matchCount / expectedWords.length : 1;
  }

  streams.sort((a, b) => {
    // Strong title mismatches sink
    const relA = a._titleRelevance >= 0.5 ? 1 : 0;
    const relB = b._titleRelevance >= 0.5 ? 1 : 0;
    if (relA !== relB) return relB - relA;
    // Browser-playable (lossy) first; lossless still surfaced but below
    const playA = a.browserPlayable ? 1 : 0;
    const playB = b.browserPlayable ? 1 : 0;
    if (playA !== playB) return playB - playA;
    // Higher relevance within tier
    if (Math.abs(a._titleRelevance - b._titleRelevance) > 0.2) return b._titleRelevance - a._titleRelevance;
    // Then by seeds
    return (b.seeds || 0) - (a.seeds || 0);
  });

  return streams;
}

async function getAlbumStreams(mbid, artist, albumTitle) {
  const cacheKey = `album:${mbid || 'na'}:${(artist || '').toLowerCase()}:${(albumTitle || '').toLowerCase()}`;
  const cached = getCachedStreams(cacheKey);
  if (cached) {
    console.log(`[MusicStreams] Cache hit for ${cacheKey} (${cached.length} streams)`);
    return cached;
  }

  const query = [artist, albumTitle].filter(Boolean).join(' ').trim();
  if (!query) return [];

  console.log(`[MusicStreams] Searching album streams for "${query}"`);

  const [tpb, x1337, yt] = await Promise.all([
    searchTPBAudio(query).catch(e => { console.log(`[TPBAudio] Error: ${e.message}`); return []; }),
    search1337xMusic(query).catch(e => { console.log(`[1337xMusic] Error: ${e.message}`); return []; }),
    searchYoutubeAudio(query).catch(e => { console.log(`[YouTube] Error: ${e.message}`); return []; }),
  ]);

  console.log(`[MusicStreams] Provider results — TPB: ${tpb.length}, 1337xMusic: ${x1337.length}, YouTube: ${yt.length}`);

  // Dedupe by infoHash for torrents; YouTube entries always pass (videoId-scoped).
  const seen = new Set();
  const combined = [];
  for (const s of [...tpb, ...x1337]) {
    if (!seen.has(s.infoHash)) {
      seen.add(s.infoHash);
      combined.push(s);
    }
  }
  combined.push(...yt);

  const expectedTitle = [artist, albumTitle].filter(Boolean).join(' ');
  const ranked = _rankAudioStreams(combined, expectedTitle);
  console.log(`[MusicStreams] Total: ${ranked.length} streams (${ranked.filter(s => s.browserPlayable).length} browser-playable)`);
  if (ranked.length > 0) setCachedStreams(cacheKey, ranked);
  return ranked;
}

async function getArtistDiscographyStreams(mbid, artistName) {
  const cacheKey = `discog:${mbid || 'na'}:${(artistName || '').toLowerCase()}`;
  const cached = getCachedStreams(cacheKey);
  if (cached) return cached;

  if (!artistName) return [];

  const q = `${artistName} discography`;
  console.log(`[MusicStreams] Searching discography packs for "${q}"`);

  const [tpb, x1337] = await Promise.all([
    searchTPBAudio(q).catch(() => []),
    search1337xMusic(q).catch(() => []),
  ]);

  const seen = new Set();
  const combined = [];
  for (const s of [...tpb, ...x1337]) {
    if (!seen.has(s.infoHash)) {
      seen.add(s.infoHash);
      combined.push(s);
    }
  }

  const ranked = _rankAudioStreams(combined, artistName);
  if (ranked.length > 0) setCachedStreams(cacheKey, ranked);
  return ranked;
}

module.exports = {
  getMovieStreams,
  getSeriesStreams,
  getSeasonPackStreams,
  getCompleteStreams,
  diagnoseProviders,
  getAlbumStreams,
  getArtistDiscographyStreams,
  // Exposed so other server modules (e.g. tmdbFetch in server.js) can
  // share the same keep-alive pool instead of opening fresh sockets.
  httpAgent,
  httpsAgent,
};
