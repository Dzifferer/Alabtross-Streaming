/**
 * Alabtross — Custom Stream Providers
 *
 * Scrapes popular torrent sources directly, removing the need for
 * Torrentio or any Stremio addon for stream discovery.
 *
 * Providers (in priority order):
 *   - The Pirate Bay  — tried first, JSON API, fast
 *   - YTS (yts.mx)    — Movies with quality/size metadata
 *   - EZTV (eztv.re)  — TV series episodes
 *   - 1337x           — General fallback for both
 */

const cheerio = require('cheerio');

// ─── Helpers ────────────────────────────────────────

function sanitizeImdbId(id) {
  // Accept tt followed by 1-10 digits (covers old and new IMDB IDs)
  if (/^tt\d{1,10}$/.test(id)) return id;
  return null;
}

async function fetchJSON(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    });
    clearTimeout(timer);
    if (!resp.ok) {
      console.log(`[Provider] fetchJSON ${resp.status} for ${url}`);
      return null;
    }
    return await resp.json();
  } catch (e) {
    clearTimeout(timer);
    console.log(`[Provider] fetchJSON error for ${url}: ${e.message}`);
    return null;
  }
}

async function fetchHTML(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    });
    clearTimeout(timer);
    if (!resp.ok) {
      console.log(`[Provider] fetchHTML ${resp.status} for ${url}`);
      return null;
    }
    return await resp.text();
  } catch (e) {
    clearTimeout(timer);
    console.log(`[Provider] fetchHTML error for ${url}: ${e.message}`);
    return null;
  }
}

function buildMagnet(infoHash, name) {
  const trackers = [
    'udp://open.demonii.com:1337/announce',
    'udp://tracker.openbittorrent.com:80',
    'udp://tracker.coppersurfer.tk:6969',
    'udp://glotorrents.pw:6969/announce',
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://torrent.gresille.org:80/announce',
    'udp://p4p.arenabg.com:1337',
    'udp://tracker.leechers-paradise.org:6969',
  ];
  const encoded = encodeURIComponent(name || 'Unknown');
  const tr = trackers.map(t => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${infoHash}&dn=${encoded}${tr}`;
}

// ─── The Pirate Bay Provider (Primary) ──────────────

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

// ─── Public API ─────────────────────────────────────

/**
 * Get streams for a movie by IMDB ID.
 * Queries TPB first, then YTS and 1337x in parallel.
 */
async function getMovieStreams(imdbId, title) {
  const id = sanitizeImdbId(imdbId);
  if (!id) return [];

  console.log(`[Streams] Searching movie streams for ${id} (title: "${title || 'unknown'}")`);

  // TPB searches by title (it doesn't index by IMDB ID)
  // YTS and 1337x search by IMDB ID
  const tpbQuery = title || id;
  const [tpbStreams, ytsStreams, fallbackStreams] = await Promise.all([
    searchTPB(tpbQuery).catch(e => { console.log(`[TPB] Error: ${e.message}`); return []; }),
    searchYTS(id).catch(e => { console.log(`[YTS] Error: ${e.message}`); return []; }),
    search1337x(title || id).catch(e => { console.log(`[1337x] Error: ${e.message}`); return []; }),
  ]);

  // Deduplicate by infoHash, prefer TPB > YTS > 1337x
  const seen = new Set();
  const combined = [];
  for (const s of [...tpbStreams, ...ytsStreams, ...fallbackStreams]) {
    if (!seen.has(s.infoHash)) {
      seen.add(s.infoHash);
      combined.push(s);
    }
  }

  // Sort by seeds descending
  combined.sort((a, b) => (b.seeds || 0) - (a.seeds || 0));
  console.log(`[Streams] Total: ${combined.length} unique streams for ${id}`);
  return combined;
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

  // TPB searches by title + S01E01 tag
  const tpbQuery = se ? `${title || id} ${seTag}` : (title || id);

  const [tpbStreams, eztvStreams, fallbackStreams] = await Promise.all([
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
    // If exact match fails, try title matching
    if (filteredEztv.length === 0) {
      filteredEztv = eztvStreams.filter(s =>
        s.title && s.title.toUpperCase().includes(seTag)
      );
    }
  }

  const seen = new Set();
  const combined = [];
  for (const s of [...tpbStreams, ...filteredEztv, ...fallbackStreams]) {
    if (!seen.has(s.infoHash)) {
      seen.add(s.infoHash);
      combined.push(s);
    }
  }

  combined.sort((a, b) => (b.seeds || 0) - (a.seeds || 0));
  console.log(`[Streams] Total: ${combined.length} unique streams for ${id} ${seTag}`);
  return combined;
}

module.exports = {
  getMovieStreams,
  getSeriesStreams,
};
