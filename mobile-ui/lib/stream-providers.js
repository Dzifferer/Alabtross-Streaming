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
const { TRACKERS } = require('./file-safety');

// ─── Helpers ────────────────────────────────────────

function sanitizeImdbId(id) {
  // Accept tt followed by 1-10 digits (covers old and new IMDB IDs)
  if (/^tt\d{1,10}$/.test(id)) return id;
  return null;
}

// Use Node's https module instead of undici fetch — undici has connectivity
// issues on ARM/Jetson with Cloudflare IPs, while https module works fine.
function httpGet(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      timeout: timeoutMs,
      family: 4, // Force IPv4
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpGet(res.headers.location, timeoutMs).then(resolve, reject);
        res.resume();
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        resolve({ ok: false, status: res.statusCode, body: '' });
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ ok: true, status: 200, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function fetchJSON(url, timeoutMs = 10000) {
  try {
    const res = await httpGet(url, timeoutMs);
    if (!res.ok) {
      console.log(`[Provider] fetchJSON ${res.status} for ${url}`);
      return null;
    }
    return JSON.parse(res.body);
  } catch (e) {
    console.log(`[Provider] fetchJSON error for ${url}: ${e.message}`);
    return null;
  }
}

async function fetchHTML(url, timeoutMs = 10000) {
  try {
    const res = await httpGet(url, timeoutMs);
    if (!res.ok) {
      console.log(`[Provider] fetchHTML ${res.status} for ${url}`);
      return null;
    }
    return res.body;
  } catch (e) {
    console.log(`[Provider] fetchHTML error for ${url}: ${e.message}`);
    return null;
  }
}

function buildMagnet(infoHash, name) {
  const encoded = encodeURIComponent(name || 'Unknown');
  const tr = TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${infoHash}&dn=${encoded}${tr}`;
}

// ─── Torrentio Provider (Primary) ───────────────────

const TORRENTIO_BASE = 'https://torrentio.strem.io';

async function searchTorrentio(type, imdbId, season, episode) {
  const streams = [];
  let stremioId = imdbId;
  if (type === 'series' && season !== undefined && episode !== undefined) {
    stremioId = `${imdbId}:${season}:${episode}`;
  }

  const data = await fetchJSON(`${TORRENTIO_BASE}/stream/${type}/${stremioId}.json`);
  if (!data || !Array.isArray(data.streams)) {
    console.log(`[Torrentio] No results for ${type}/${stremioId}`);
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

    // Extract seeds from Torrentio's title (e.g., "👤 45")
    const seedMatch = details.match(/👤\s*(\d+)/);
    const seeds = seedMatch ? parseInt(seedMatch[1], 10) : 0;

    // Extract size
    const sizeMatch = details.match(/([\d.]+\s*(?:GB|MB))/i);
    const sizeStr = sizeMatch ? sizeMatch[1] : '';

    // Extract quality
    const qualityMatch = (s.title || '').match(/\b(2160p|1080p|720p|480p)\b/i);
    const quality = qualityMatch ? qualityMatch[1] : '';

    streams.push({
      infoHash: hash,
      title: `${displayName}\n${quality ? quality + ' ' : ''}${sizeStr}${seeds ? ' | Seeds: ' + seeds : ''}${details ? '\n' + details : ''}`,
      magnetUri: buildMagnet(hash, displayName),
      quality,
      size: sizeStr,
      seeds,
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
  // apibay.org is the public TPB API — returns JSON array
  const data = await fetchJSON(
    `https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=200,205,207,208`
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

async function searchEZTV(imdbId) {
  const streams = [];
  // EZTV wants numeric IMDB ID without 'tt' prefix
  const numericId = imdbId.replace(/^tt0*/, '');
  const data = await fetchJSON(
    `https://eztv.re/api/get-torrents?imdb_id=${numericId}&limit=50`
  );
  if (!data || !data.torrents) {
    console.log(`[EZTV] No results for ${imdbId} (numeric: ${numericId})`);
    return streams;
  }

  for (const t of data.torrents) {
    if (!t.hash) continue;
    const hash = t.hash.toLowerCase();
    const seeds = t.seeds || 0;
    const sizeBytes = parseInt(t.size_bytes || '0', 10);
    const sizeMB = sizeBytes > 0 ? (sizeBytes / (1024 * 1024)).toFixed(0) + ' MB' : '';
    const quality = t.filename && t.filename.match(/\b(2160p|1080p|720p|480p)\b/i)
      ? t.filename.match(/\b(2160p|1080p|720p|480p)\b/i)[1]
      : '';

    streams.push({
      infoHash: hash,
      title: `${t.title || t.filename}\n${quality} ${sizeMB} | Seeds: ${seeds}`,
      magnetUri: t.magnet_url || buildMagnet(hash, t.title || t.filename),
      quality,
      size: sizeMB,
      seeds,
      season: t.season ? parseInt(t.season, 10) : undefined,
      episode: t.episode ? parseInt(t.episode, 10) : undefined,
      source: 'EZTV',
    });
  }

  console.log(`[EZTV] Found ${streams.length} results for ${imdbId}`);
  return streams;
}

// ─── 1337x Provider (Fallback) ──────────────────────

async function search1337x(query) {
  const streams = [];
  const html = await fetchHTML(
    `https://1337x.to/search/${encodeURIComponent(query)}/1/`
  );
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

// ─── Stream Filtering & Ranking ─────────────────────

const MIN_SEEDS = 3;

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
 * Filter and rank streams:
 * - Remove torrents with too few seeds
 * - Tag each with detected format
 * - Sort: browser-playable first, then by seeds
 */
function filterAndRank(streams) {
  // Filter dead torrents
  let filtered = streams.filter(s => (s.seeds || 0) >= MIN_SEEDS);

  // Tag each stream with format info
  for (const s of filtered) {
    s.format = detectFormat(s.title);
    s.browserPlayable = s.format === 'MP4' || s.format === 'WebM';
    // Add format to the display title
    if (s.format !== 'Unknown') {
      s.title = s.title.replace(/\n/, ` [${s.format}]\n`);
    }
  }

  // Sort: browser-playable first, then by seeds descending
  filtered.sort((a, b) => {
    if (a.browserPlayable && !b.browserPlayable) return -1;
    if (!a.browserPlayable && b.browserPlayable) return 1;
    return (b.seeds || 0) - (a.seeds || 0);
  });

  return filtered;
}

// ─── Public API ─────────────────────────────────────

/**
 * Get streams for a movie by IMDB ID.
 * Queries TPB first, then YTS and 1337x in parallel.
 */
async function getMovieStreams(imdbId, title) {
  const id = sanitizeImdbId(imdbId);
  if (!id) return [];

  console.log(`[Streams] Searching movie streams for ${id} (title: "${title || 'unknown'}")`);

  // Torrentio first (most reliable), then fallback scrapers in parallel
  const torrentioStreams = await searchTorrentio('movie', id).catch(e => {
    console.log(`[Torrentio] Error: ${e.message}`);
    return [];
  });

  // If Torrentio returned enough results, skip flaky scrapers
  let fallbackStreams = [];
  if (torrentioStreams.length < 3) {
    const tpbQuery = title || id;
    const [tpb, yts, x1337] = await Promise.all([
      searchTPB(tpbQuery).catch(e => { console.log(`[TPB] Error: ${e.message}`); return []; }),
      searchYTS(id).catch(e => { console.log(`[YTS] Error: ${e.message}`); return []; }),
      search1337x(title || id).catch(e => { console.log(`[1337x] Error: ${e.message}`); return []; }),
    ]);
    fallbackStreams = [...tpb, ...yts, ...x1337];
  }

  // Deduplicate by infoHash, prefer Torrentio > fallbacks
  const seen = new Set();
  const combined = [];
  for (const s of [...torrentioStreams, ...fallbackStreams]) {
    if (!seen.has(s.infoHash)) {
      seen.add(s.infoHash);
      combined.push(s);
    }
  }

  const ranked = filterAndRank(combined);
  console.log(`[Streams] Total: ${ranked.length} streams (${ranked.filter(s => s.browserPlayable).length} browser-playable) for ${id}`);
  return ranked;
}

/**
 * Get streams for a TV episode by IMDB ID + season/episode.
 * Queries TPB and EZTV first, then 1337x as fallback.
 */
async function getSeriesStreams(imdbId, season, episode, title) {
  const id = sanitizeImdbId(imdbId);
  if (!id) return [];

  const se = season !== undefined && episode !== undefined;
  const seTag = se
    ? `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
    : '';

  console.log(`[Streams] Searching series streams for ${id} ${seTag} (title: "${title || 'unknown'}")`);

  // Torrentio first (most reliable)
  const torrentioStreams = await searchTorrentio('series', id, season, episode).catch(e => {
    console.log(`[Torrentio] Error: ${e.message}`);
    return [];
  });

  // If Torrentio returned enough results, skip flaky scrapers
  let fallbackCombined = [];
  if (torrentioStreams.length < 3) {
    const tpbQuery = se ? `${title || id} ${seTag}` : (title || id);

    const [tpbStreams, eztvStreams, x1337Streams] = await Promise.all([
      searchTPB(tpbQuery).catch(e => { console.log(`[TPB] Error: ${e.message}`); return []; }),
      searchEZTV(id).catch(e => { console.log(`[EZTV] Error: ${e.message}`); return []; }),
      se ? search1337x(`${title || id} ${seTag}`).catch(e => { console.log(`[1337x] Error: ${e.message}`); return []; }) : Promise.resolve([]),
    ]);

    // Filter EZTV results to matching season/episode if specified
    let filteredEztv = eztvStreams;
    if (se) {
      filteredEztv = eztvStreams.filter(s =>
        s.season === season && s.episode === episode
      );
      if (filteredEztv.length === 0) {
        filteredEztv = eztvStreams.filter(s =>
          s.title && s.title.toUpperCase().includes(seTag)
        );
      }
    }

    fallbackCombined = [...tpbStreams, ...filteredEztv, ...x1337Streams];
  }

  const seen = new Set();
  const combined = [];
  for (const s of [...torrentioStreams, ...fallbackCombined]) {
    if (!seen.has(s.infoHash)) {
      seen.add(s.infoHash);
      combined.push(s);
    }
  }

  const ranked = filterAndRank(combined);
  console.log(`[Streams] Total: ${ranked.length} streams (${ranked.filter(s => s.browserPlayable).length} browser-playable) for ${id} ${seTag}`);
  return ranked;
}

module.exports = {
  getMovieStreams,
  getSeriesStreams,
};
