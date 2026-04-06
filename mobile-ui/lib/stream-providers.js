/**
 * Alabtross — Custom Stream Providers
 *
 * Scrapes popular torrent sources directly, removing the need for
 * Torrentio or any Stremio addon for stream discovery.
 *
 * Providers:
 *   - YTS (yts.mx)     — Movies with quality/size metadata
 *   - EZTV (eztv.re)   — TV series episodes
 *   - 1337x            — General fallback for both
 */

const cheerio = require('cheerio');

// ─── Helpers ────────────────────────────────────────

function sanitizeImdbId(id) {
  if (/^tt\d{7,10}$/.test(id)) return id;
  return null;
}

async function fetchJSON(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Alabtross/1.0' },
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

async function fetchHTML(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Alabtross/1.0' },
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    clearTimeout(timer);
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

// ─── YTS Provider (Movies) ──────────────────────────

async function searchYTS(imdbId) {
  const streams = [];
  const data = await fetchJSON(
    `https://yts.mx/api/v2/list_movies.json?query_term=${imdbId}&limit=1`
  );
  if (!data || !data.data || !data.data.movies) return streams;

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
  if (!data || !data.torrents) return streams;

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
 * Queries YTS first, then 1337x as fallback.
 */
async function getMovieStreams(imdbId) {
  const id = sanitizeImdbId(imdbId);
  if (!id) return [];

  // Query YTS and 1337x in parallel
  const [ytsStreams, fallbackStreams] = await Promise.all([
    searchYTS(id).catch(() => []),
    search1337x(id).catch(() => []),
  ]);

  // Deduplicate by infoHash, prefer YTS
  const seen = new Set();
  const combined = [];
  for (const s of [...ytsStreams, ...fallbackStreams]) {
    if (!seen.has(s.infoHash)) {
      seen.add(s.infoHash);
      combined.push(s);
    }
  }

  // Sort by seeds descending
  combined.sort((a, b) => (b.seeds || 0) - (a.seeds || 0));
  return combined;
}

/**
 * Get streams for a TV episode by IMDB ID + season/episode.
 * Queries EZTV first, then 1337x as fallback.
 */
async function getSeriesStreams(imdbId, season, episode) {
  const id = sanitizeImdbId(imdbId);
  if (!id) return [];

  const se = season !== undefined && episode !== undefined;
  const seTag = se
    ? `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
    : '';

  const [eztvStreams, fallbackStreams] = await Promise.all([
    searchEZTV(id).catch(() => []),
    se ? search1337x(`${id} ${seTag}`).catch(() => []) : Promise.resolve([]),
  ]);

  // Filter EZTV results to matching season/episode if specified
  let filtered = eztvStreams;
  if (se) {
    filtered = eztvStreams.filter(s =>
      s.season === season && s.episode === episode
    );
    // If exact match fails, try title matching
    if (filtered.length === 0) {
      filtered = eztvStreams.filter(s =>
        s.title && s.title.toUpperCase().includes(seTag)
      );
    }
  }

  const seen = new Set();
  const combined = [];
  for (const s of [...filtered, ...fallbackStreams]) {
    if (!seen.has(s.infoHash)) {
      seen.add(s.infoHash);
      combined.push(s);
    }
  }

  combined.sort((a, b) => (b.seeds || 0) - (a.seeds || 0));
  return combined;
}

module.exports = {
  getMovieStreams,
  getSeriesStreams,
};
