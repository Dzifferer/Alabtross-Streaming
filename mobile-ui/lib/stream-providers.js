/**
 * Alabtross — Custom Stream Providers
 *
 * Providers (in priority order):
 *   - Torrentio       — Primary, pre-indexed torrent database (no Cloudflare)
 *   - The Pirate Bay   — Fallback, JSON API
 *   - YTS (yts.mx)    — Fallback, movies with quality/size metadata
 *   - EZTV (eztv.re)  — Fallback, TV series episodes
 *   - 1337x           — Fallback, general
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

function resolveWithFallback(hostname) {
  return new Promise((resolve, reject) => {
    // Try system DNS first
    dns.resolve4(hostname, (err, addresses) => {
      if (!err && addresses && addresses.length > 0) {
        return resolve(addresses[0]);
      }
      // System DNS failed — try public resolvers
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

// ─── Helpers ────────────────────────────────────────

function sanitizeImdbId(id) {
  // Accept tt followed by 1-10 digits (covers old and new IMDB IDs)
  if (/^tt\d{1,10}$/.test(id)) return id;
  return null;
}

// Use Node's https module instead of undici fetch — undici has connectivity
// issues on ARM/Jetson with Cloudflare IPs, while https module works fine.
const MAX_REDIRECTS = 5;

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
        ...(resolvedIp ? { Host: parsedUrl.hostname } : {}),
      },
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
  try {
    return await httpGetDirect(url, timeoutMs, _redirectCount);
  } catch (e) {
    // If DNS resolution failed, try with fallback DNS resolvers
    if (e.message && (e.message.includes('ENOTFOUND') || e.message.includes('EAI_AGAIN'))) {
      const parsedUrl = new URL(url);
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

  // Try each config variation until one returns results
  let data = null;
  for (const config of TORRENTIO_CONFIGS) {
    const url = config
      ? `${TORRENTIO_BASE}/${config}/stream/${type}/${stremioId}.json`
      : `${TORRENTIO_BASE}/stream/${type}/${stremioId}.json`;
    data = await fetchJSON(url, 12000, 1);
    if (data && Array.isArray(data.streams) && data.streams.length > 0) {
      console.log(`[Torrentio] Config "${config || '(bare)'}" returned ${data.streams.length} results`);
      break;
    }
  }

  if (!data || !Array.isArray(data.streams)) {
    console.log(`[Torrentio] No results for ${type}/${stremioId} (tried ${TORRENTIO_CONFIGS.length} configs)`);
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

async function searchTPB(query) {
  const streams = [];
  // Clean query: remove special chars that confuse search, trim to reasonable length
  const cleanQuery = query.replace(/['']/g, ' ').replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  // apibay.org is the public TPB API — returns JSON array
  const data = await fetchJSON(
    `https://apibay.org/q.php?q=${encodeURIComponent(cleanQuery)}&cat=200,205,207,208`
  );
  // cat 200=Video, 205=TV, 207=HD Movies, 208=HD TV
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

async function searchYTS(imdbId) {
  const streams = [];
  const data = await fetchJSON(
    `https://yts.mx/api/v2/list_movies.json?query_term=${imdbId}&limit=1`
  );
  if (!data || !data.data || !data.data.movies) {
    console.log(`[YTS] No results for ${imdbId}`);
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

async function searchEZTV(imdbId, targetSeason, targetEpisode) {
  const streams = [];
  // EZTV wants numeric IMDB ID without 'tt' prefix
  const numericId = imdbId.replace(/^tt0*/, '');

  // First, get page 1 to find total_count and check for matches
  const limit = 100;
  const firstPage = await fetchJSON(
    `https://eztv.re/api/get-torrents?imdb_id=${numericId}&limit=${limit}&page=1`
  );
  if (!firstPage || !firstPage.torrents || firstPage.torrents.length === 0) {
    console.log(`[EZTV] No results for ${imdbId} (numeric: ${numericId})`);
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
        fetchJSON(`https://eztv.re/api/get-torrents?imdb_id=${numericId}&limit=${limit}&page=${page}`)
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
        `https://eztv.re/api/get-torrents?imdb_id=${numericId}&limit=${limit}&page=${page}`
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
  // Try primary domain first, then mirror if 403/blocked
  const domains = ['1337x.to', '1337x.st', '1337x.gd'];
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

async function searchNyaa(query, season, episode) {
  const streams = [];

  // Build search query — for anime, try title + episode number
  let searchQuery = query;
  if (season !== undefined && episode !== undefined) {
    // Anime uses multiple numbering conventions
    const epPadded = String(episode).padStart(2, '0');
    const epPadded3 = String(episode).padStart(3, '0');
    // Try absolute episode number (most common for anime)
    searchQuery = `${query} ${epPadded}`;
  }

  // Nyaa.si RSS feed returns XML with torrent data
  // Category 1_2 = Anime - English-translated
  const url = `https://nyaa.si/?f=0&c=1_2&q=${encodeURIComponent(searchQuery)}&s=seeders&o=desc&page=rss`;
  const xml = await fetchHTML(url, 12000);
  if (!xml) {
    console.log(`[Nyaa] No response for "${searchQuery}"`);
    return streams;
  }

  // Parse RSS XML manually (no cheerio needed for simple RSS)
  const items = xml.split('<item>').slice(1);
  for (const item of items.slice(0, 20)) {
    const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
    const linkMatch = item.match(/<nyaa:infoHash>(.*?)<\/nyaa:infoHash>/);
    const seedMatch = item.match(/<nyaa:seeders>(.*?)<\/nyaa:seeders>/);
    const sizeMatch = item.match(/<nyaa:size>(.*?)<\/nyaa:size>/);

    if (!linkMatch) continue;
    const hash = linkMatch[1].toLowerCase();
    const title = (titleMatch ? (titleMatch[1] || titleMatch[2]) : 'Unknown').trim();
    const seeds = seedMatch ? parseInt(seedMatch[1], 10) : 0;
    const sizeStr = sizeMatch ? sizeMatch[1] : '';

    const quality = title.match(/\b(2160p|1080p|720p|480p)\b/i);

    // Detect if this is a batch/pack release
    const isBatch = /\bbatch\b/i.test(title) || /\bcomplete\b/i.test(title) ||
      /\d+\s*[-~]\s*\d+/.test(title) || /\bseason\s*\d/i.test(title) ||
      /\bS\d+\b/i.test(title) && !/\bS\d+E\d+\b/i.test(title);

    streams.push({
      infoHash: hash,
      title: `${title}\n${quality ? quality[1] + ' ' : ''}${sizeStr} | Seeds: ${seeds}${isBatch ? ' | BATCH' : ''}`,
      magnetUri: buildMagnet(hash, title),
      quality: quality ? quality[1] : '',
      size: sizeStr,
      seeds,
      source: 'Nyaa',
      isBatch,
    });
  }

  // If we didn't find individual episodes, try batch/pack search
  if (streams.length < 3 && season !== undefined) {
    const batchQuery = `${query} batch`;
    const batchUrl = `https://nyaa.si/?f=0&c=1_2&q=${encodeURIComponent(batchQuery)}&s=seeders&o=desc&page=rss`;
    const batchXml = await fetchHTML(batchUrl, 12000);
    if (batchXml) {
      const batchItems = batchXml.split('<item>').slice(1);
      for (const item of batchItems.slice(0, 10)) {
        const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
        const linkMatch = item.match(/<nyaa:infoHash>(.*?)<\/nyaa:infoHash>/);
        const seedMatch = item.match(/<nyaa:seeders>(.*?)<\/nyaa:seeders>/);
        const sizeMatch = item.match(/<nyaa:size>(.*?)<\/nyaa:size>/);

        if (!linkMatch) continue;
        const hash = linkMatch[1].toLowerCase();
        if (streams.some(s => s.infoHash === hash)) continue; // dedup

        const title = (titleMatch ? (titleMatch[1] || titleMatch[2]) : 'Unknown').trim();
        const seeds = seedMatch ? parseInt(seedMatch[1], 10) : 0;
        const sizeStr = sizeMatch ? sizeMatch[1] : '';
        const quality = title.match(/\b(2160p|1080p|720p|480p)\b/i);

        streams.push({
          infoHash: hash,
          title: `${title}\n${quality ? quality[1] + ' ' : ''}${sizeStr} | Seeds: ${seeds} | BATCH`,
          magnetUri: buildMagnet(hash, title),
          quality: quality ? quality[1] : '',
          size: sizeStr,
          seeds,
          source: 'Nyaa',
          isBatch: true,
        });
      }
    }
  }

  console.log(`[Nyaa] Found ${streams.length} results for "${searchQuery}"`);
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
function filterAndRank(streams) {
  console.log(`[FilterRank] Input: ${streams.length} streams`);

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

  // Sort: native browser-playable > remuxable > unknown, then by seeds descending
  filtered.sort((a, b) => {
    const scoreA = a.browserPlayable ? 2 : (a.remuxPlayable ? 1 : 0);
    const scoreB = b.browserPlayable ? 2 : (b.remuxPlayable ? 1 : 0);
    if (scoreA !== scoreB) return scoreB - scoreA;
    return (b.seeds || 0) - (a.seeds || 0);
  });

  return filtered;
}

// ─── Public API ─────────────────────────────────────

/**
 * Get streams for a movie by IMDB ID.
 * Queries Torrentio first, then fallback scrapers.
 * Always runs fallbacks if filtered results are too few.
 */
async function getMovieStreams(imdbId, title) {
  const id = sanitizeImdbId(imdbId);
  if (!id) return [];

  console.log(`[Streams] Searching movie streams for ${id} (title: "${title || 'unknown'}")`);

  // Run Torrentio AND fallbacks in parallel — don't wait for Torrentio first.
  // This halves latency when Torrentio is slow/down, and ensures fallbacks
  // always contribute results regardless of Torrentio's response.
  const tpbQuery = title || id;
  const [torrentioStreams, tpb, yts, x1337] = await Promise.all([
    searchTorrentio('movie', id).catch(e => {
      console.log(`[Torrentio] Error: ${e.message}`);
      return [];
    }),
    searchTPB(tpbQuery).catch(e => { console.log(`[TPB] Error: ${e.message}`); return []; }),
    searchYTS(id).catch(e => { console.log(`[YTS] Error: ${e.message}`); return []; }),
    search1337x(title || id).catch(e => { console.log(`[1337x] Error: ${e.message}`); return []; }),
  ]);

  const fallbackStreams = [...tpb, ...yts, ...x1337];
  console.log(`[Streams] Provider results — Torrentio: ${torrentioStreams.length}, TPB: ${tpb.length}, YTS: ${yts.length}, 1337x: ${x1337.length}`);

  // Deduplicate by infoHash, prefer Torrentio > fallbacks
  const seen = new Set();
  const combined = [];
  for (const s of [...torrentioStreams, ...fallbackStreams]) {
    if (!seen.has(s.infoHash)) {
      seen.add(s.infoHash);
      combined.push(s);
    }
  }

  console.log(`[Streams] Combined: ${combined.length} unique streams for ${id}`);

  const ranked = filterAndRank(combined);
  console.log(`[Streams] Total: ${ranked.length} streams (${ranked.filter(s => s.browserPlayable).length} browser-playable, ${ranked.filter(s => s.remuxPlayable).length} remuxable) for ${id}`);
  return ranked;
}

/**
 * Detect if a title is likely anime based on common patterns.
 */
function isLikelyAnime(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  // Common anime keywords/patterns
  return /\b(anime|sub|dub|dual[\s-]?audio|multi[\s-]?sub)\b/i.test(t) ||
    /\b(shippuden|boruto|piece|naruto|bleach|dragon\s*ball|attack\s*on\s*titan|jujutsu|demon\s*slayer|one\s*punch|hunter\s*x|fullmetal|my\s*hero|sword\s*art)\b/i.test(t);
}

/**
 * Get streams for a TV episode by IMDB ID + season/episode.
 * Queries Torrentio, fallback scrapers, and Nyaa (for anime) in parallel.
 * Supports absolute episode numbering and batch/pack torrents.
 */
async function getSeriesStreams(imdbId, season, episode, title) {
  const id = sanitizeImdbId(imdbId);
  if (!id) return [];

  const se = season !== undefined && episode !== undefined;
  const seTag = se
    ? `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
    : '';

  console.log(`[Streams] Searching series streams for ${id} ${seTag} (title: "${title || 'unknown'}")`);

  // Determine if this might be anime (for Nyaa search)
  const anime = isLikelyAnime(title);
  const tpbQuery = se ? `${title || id} ${seTag}` : (title || id);

  // Run ALL providers in parallel — don't wait for Torrentio first.
  // This eliminates the sequential bottleneck when Torrentio is slow/down.
  const providerPromises = [
    searchTorrentio('series', id, season, episode).catch(e => { console.log(`[Torrentio] Error: ${e.message}`); return []; }),
    searchEZTV(id, season, episode).catch(e => { console.log(`[EZTV] Error: ${e.message}`); return []; }),
    searchTPB(tpbQuery).catch(e => { console.log(`[TPB] Error: ${e.message}`); return []; }),
    se ? search1337x(`${title || id} ${seTag}`).catch(e => { console.log(`[1337x] Error: ${e.message}`); return []; }) : Promise.resolve([]),
  ];

  // Always search Nyaa for anime
  if (anime) {
    providerPromises.push(
      searchNyaa(title || id, season, episode).catch(e => { console.log(`[Nyaa] Error: ${e.message}`); return []; })
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
    lateNyaaStreams = await searchNyaa(title || id, season, episode).catch(e => {
      console.log(`[Nyaa] Error: ${e.message}`);
      return [];
    });
  }

  const seen = new Set();
  const combined = [];
  for (const s of [...torrentioStreams, ...tpbStreams, ...filteredEztv, ...x1337Streams, ...nyaaStreams, ...lateNyaaStreams]) {
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

  const ranked = filterAndRank(combined);
  const batchCount = ranked.filter(s => s.isBatch).length;
  console.log(`[Streams] Total: ${ranked.length} streams (${ranked.filter(s => s.browserPlayable).length} browser-playable, ${ranked.filter(s => s.remuxPlayable).length} remuxable, ${batchCount} batch) for ${id} ${seTag}`);
  return ranked;
}

// ─── Diagnostics ──────────────────────────────────

/**
 * Test connectivity to each provider and return status.
 * Uses a well-known IMDB ID (The Shawshank Redemption) for testing.
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

  await Promise.all([
    testProvider('torrentio', async () => {
      for (const config of TORRENTIO_CONFIGS) {
        const url = config
          ? `${TORRENTIO_BASE}/${config}/stream/movie/${testImdb}.json`
          : `${TORRENTIO_BASE}/stream/movie/${testImdb}.json`;
        const data = await fetchJSON(url, 12000, 0);
        if (data && Array.isArray(data.streams) && data.streams.length > 0) {
          results._torrentioConfig = config || '(bare)';
          return data.streams;
        }
      }
      return [];
    }),
    testProvider('tpb', () => searchTPB('Shawshank Redemption')),
    testProvider('yts', () => searchYTS(testImdb)),
    testProvider('eztv', async () => {
      // EZTV is TV-only, just test connectivity
      const data = await fetchJSON('https://eztv.re/api/get-torrents?imdb_id=303461&limit=5&page=1', 10000, 0);
      return data && data.torrents ? data.torrents : [];
    }),
    testProvider('1337x', () => search1337x('Shawshank Redemption')),
  ]);

  // Overall status
  const working = Object.entries(results)
    .filter(([k, v]) => !k.startsWith('_') && v.ok && v.count > 0)
    .map(([k]) => k);
  results._summary = {
    working,
    total: Object.keys(results).filter(k => !k.startsWith('_')).length,
    allDown: working.length === 0,
  };

  return results;
}

module.exports = {
  getMovieStreams,
  getSeriesStreams,
  diagnoseProviders,
};
