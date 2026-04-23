// Albatross — Music UI
// Renders the Music tab, search, album/artist/playlist detail views, and
// wires the mini-player + full-player DOM to MusicQueue.

(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => (root || document).querySelectorAll(sel);

  // ─── Tiny DOM helpers ─────────────────────

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'onclick') e.addEventListener('click', attrs[k]);
      else if (k.startsWith('data-')) e.setAttribute(k, attrs[k]);
      else e[k] = attrs[k];
    }
    if (children) {
      for (const c of [].concat(children)) {
        if (c == null) continue;
        e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return e;
  }

  function fmtTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function escapeHTML(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ─── State ─────────────────────────────

  let currentTab = 'home';

  // ─── Music tab landing ─────────────────

  async function renderMusicHome() {
    const content = $('#music-content');
    content.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Loading music...</p></div>';

    const [library, genres] = await Promise.all([
      window.MusicAPI.getLibrary().catch(() => []),
      window.MusicAPI.getGenres().catch(() => ({})),
    ]);

    const albums = library.filter(i => i.type === 'album');

    if (!albums.length) {
      content.innerHTML = `
        <div class="empty-state">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
          <p>No music yet. Search for an album or artist above.</p>
        </div>`;
      return;
    }

    content.innerHTML = '';
    const recents = window.MusicQueue.getRecent();
    if (recents.length) {
      content.appendChild(renderShelf('Recently Played', recents.slice(0, 12).map(r => ({
        id: r.albumId, type: 'album', name: r.title, artist: r.artist, poster: r.coverUrl,
      })), 'recent'));
    }

    const genreKeys = Object.keys(genres).sort();
    for (const g of genreKeys) {
      const ids = genres[g] || [];
      const items = ids.map(id => albums.find(a => a.id === id)).filter(Boolean);
      if (!items.length) continue;
      content.appendChild(renderShelf(capitalize(g), items.map(a => ({
        id: a.id, type: 'album', name: a.title, artist: a.artist, poster: a.coverUrl,
      })), 'library'));
    }
    // Fallback shelf for items without genre.
    const ungrouped = albums.filter(a => {
      const g = (a.manualOverride && a.manualOverride.genre) || (a.genres && a.genres[0]);
      return !g;
    });
    if (ungrouped.length) {
      content.appendChild(renderShelf('All albums', ungrouped.map(a => ({
        id: a.id, type: 'album', name: a.title, artist: a.artist, poster: a.coverUrl,
      })), 'library'));
    }
  }

  function capitalize(s) { return (s || '').replace(/\b\w/g, c => c.toUpperCase()); }

  function renderShelf(title, items, source) {
    const row = el('div', { class: 'music-shelf' });
    row.appendChild(el('h3', { class: 'music-shelf__title' }, title));
    const scroll = el('div', { class: 'music-shelf__scroll' });
    for (const it of items) {
      const card = renderCard(it, source);
      scroll.appendChild(card);
    }
    row.appendChild(scroll);
    return row;
  }

  function renderCard(item, source) {
    const card = el('div', { class: 'music-card', 'data-id': item.id || '' });
    const cover = el('div', { class: 'music-card__cover' });
    if (item.poster) cover.style.backgroundImage = `url(${item.poster})`;
    card.appendChild(cover);
    card.appendChild(el('div', { class: 'music-card__title' }, item.name || ''));
    if (item.artist) card.appendChild(el('div', { class: 'music-card__subtitle' }, item.artist));
    card.addEventListener('click', () => {
      if (item.type === 'artist' && item.mbid) {
        openArtistDetail(item.mbid);
      } else if (source === 'library' || (item.id && !item.id.startsWith('mbr:') && !item.id.startsWith('mba:'))) {
        openLibraryAlbumDetail(item.id);
      } else if (item.id && item.id.startsWith('mbr:')) {
        openAlbumDetail(item.id.slice(4));
      } else if (item.mbid) {
        openAlbumDetail(item.mbid);
      } else {
        openLibraryAlbumDetail(item.id);
      }
    });
    return card;
  }

  // ─── Tabs ─────────────────────────────

  async function renderAlbumsTab() {
    const content = $('#music-content');
    const albums = (await window.MusicAPI.getLibrary()).filter(i => i.type === 'album');
    if (!albums.length) { content.innerHTML = '<div class="empty-state"><p>No albums yet.</p></div>'; return; }
    content.innerHTML = '';
    const grid = el('div', { class: 'music-grid' });
    for (const a of albums) {
      grid.appendChild(renderCard({ id: a.id, type: 'album', name: a.title, artist: a.artist, poster: a.coverUrl }, 'library'));
    }
    content.appendChild(grid);
  }

  async function renderArtistsTab() {
    const content = $('#music-content');
    const albums = (await window.MusicAPI.getLibrary()).filter(i => i.type === 'album');
    const byArtist = new Map();
    for (const a of albums) {
      const k = (a.artistMbid || a.artist || '').toString();
      if (!byArtist.has(k)) byArtist.set(k, { mbid: a.artistMbid, name: a.artist, count: 0, poster: a.coverUrl });
      byArtist.get(k).count += 1;
    }
    if (!byArtist.size) { content.innerHTML = '<div class="empty-state"><p>No artists yet.</p></div>'; return; }
    content.innerHTML = '';
    const grid = el('div', { class: 'music-grid' });
    for (const [, info] of byArtist) {
      grid.appendChild(renderCard({ type: 'artist', name: info.name, artist: `${info.count} album${info.count !== 1 ? 's' : ''}`, poster: info.poster, mbid: info.mbid }, 'library'));
    }
    content.appendChild(grid);
  }

  async function renderRecentTab() {
    const content = $('#music-content');
    const recents = window.MusicQueue.getRecent();
    if (!recents.length) { content.innerHTML = '<div class="empty-state"><p>Nothing played recently.</p></div>'; return; }
    content.innerHTML = '';
    const grid = el('div', { class: 'music-grid' });
    for (const r of recents) {
      grid.appendChild(renderCard({ id: r.albumId, type: 'album', name: r.title, artist: r.artist, poster: r.coverUrl }, 'recent'));
    }
    content.appendChild(grid);
  }

  async function renderFavoritesTab() {
    const content = $('#music-content');
    const library = (await window.MusicAPI.getLibrary()).filter(i => i.type === 'album' && i.favorite);
    if (!library.length) { content.innerHTML = '<div class="empty-state"><p>Mark favorites from album detail to see them here.</p></div>'; return; }
    content.innerHTML = '';
    const grid = el('div', { class: 'music-grid' });
    for (const a of library) {
      grid.appendChild(renderCard({ id: a.id, type: 'album', name: a.title, artist: a.artist, poster: a.coverUrl }, 'library'));
    }
    content.appendChild(grid);
  }

  async function renderPlaylistsTab() {
    const content = $('#music-content');
    const playlists = await window.MusicAPI.listPlaylists().catch(() => []);
    content.innerHTML = '';

    const header = el('div', { class: 'playlists-header' });
    const createBtn = el('button', { class: 'btn-block' }, '+ New playlist');
    createBtn.addEventListener('click', async () => {
      const name = prompt('Playlist name?');
      if (!name) return;
      await window.MusicAPI.createPlaylist(name.trim());
      renderPlaylistsTab();
    });
    header.appendChild(createBtn);
    content.appendChild(header);

    if (!playlists.length) {
      content.appendChild(el('div', { class: 'empty-state' }, el('p', {}, 'No playlists yet.')));
      return;
    }

    const list = el('div', { class: 'playlists-list' });
    for (const pl of playlists) {
      const row = el('div', { class: 'playlist-row' });
      row.appendChild(el('div', { class: 'playlist-row__name' }, pl.name));
      row.appendChild(el('div', { class: 'playlist-row__count' }, `${(pl.items || []).length} track${(pl.items || []).length !== 1 ? 's' : ''}`));
      row.addEventListener('click', () => openPlaylistDetail(pl.id));
      list.appendChild(row);
    }
    content.appendChild(list);
  }

  // ─── Detail views ─────────────────────

  async function openAlbumDetail(mbid) {
    if (window.__app_navigate) window.__app_navigate('music-detail');
    const container = $('#music-detail-content');
    container.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Loading album...</p></div>';
    try {
      const meta = await window.MusicAPI.getReleaseMeta(mbid);
      if (!meta) throw new Error('Not found');
      await renderAlbumDetailBody(container, meta, { source: 'remote' });
    } catch (e) {
      container.innerHTML = `<div class="empty-state"><p>Failed to load album: ${escapeHTML(e.message)}</p></div>`;
    }
  }

  async function openLibraryAlbumDetail(itemId) {
    if (window.__app_navigate) window.__app_navigate('music-detail');
    const container = $('#music-detail-content');
    container.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Loading album...</p></div>';
    const library = await window.MusicAPI.getLibrary();
    const item = library.find(i => i.id === itemId);
    if (!item) {
      container.innerHTML = '<div class="empty-state"><p>Album not found in library.</p></div>';
      return;
    }
    await renderAlbumDetailBody(container, item, { source: 'library' });
  }

  async function renderAlbumDetailBody(container, meta, opts) {
    const title = meta.title || meta.name || 'Album';
    const artist = meta.artist || '';
    const cover = meta.coverUrl || meta.poster || '';
    const tracks = meta.tracks || [];
    const inLibrary = opts.source === 'library';

    container.innerHTML = '';
    const hero = el('div', { class: 'album-hero' });
    const coverDiv = el('div', { class: 'album-hero__cover' });
    if (cover) coverDiv.style.backgroundImage = `url(${cover})`;
    hero.appendChild(coverDiv);
    const info = el('div', { class: 'album-hero__info' });
    info.appendChild(el('h2', {}, title));
    info.appendChild(el('p', { class: 'album-hero__artist' }, artist));
    if (meta.year) info.appendChild(el('p', { class: 'album-hero__year' }, meta.year));
    const genres = (meta.manualOverride && meta.manualOverride.genre) ? [meta.manualOverride.genre] : (meta.genres || []);
    if (genres.length) info.appendChild(el('p', { class: 'album-hero__genres' }, genres.slice(0, 3).map(capitalize).join(' · ')));
    hero.appendChild(info);
    container.appendChild(hero);

    // Action row
    const actions = el('div', { class: 'album-actions' });
    if (tracks.length) {
      const playAll = el('button', { class: 'btn-primary' }, 'Play album');
      playAll.addEventListener('click', () => playAlbum(meta, tracks, 0, inLibrary));
      actions.appendChild(playAll);
    }
    if (inLibrary) {
      const favBtn = el('button', { class: 'btn-block' }, meta.favorite ? '★ Favorited' : '☆ Favorite');
      favBtn.addEventListener('click', async () => {
        const r = await window.MusicAPI.toggleFavorite(meta.id);
        meta.favorite = r && r.favorite;
        favBtn.textContent = meta.favorite ? '★ Favorited' : '☆ Favorite';
      });
      actions.appendChild(favBtn);

      const genreBtn = el('button', { class: 'btn-block' }, 'Set genre');
      genreBtn.addEventListener('click', async () => {
        const next = prompt('Genre:', (meta.manualOverride && meta.manualOverride.genre) || (meta.genres && meta.genres[0]) || '');
        if (next === null) return;
        await window.MusicAPI.setGenre(meta.id, next.trim());
        alert('Saved');
      });
      actions.appendChild(genreBtn);
    } else {
      // Remote album — offer "Add to library" (fetch streams and pick one).
      const addBtn = el('button', { class: 'btn-block' }, 'Find streams');
      addBtn.addEventListener('click', () => renderRemoteStreams(container, meta));
      actions.appendChild(addBtn);
    }
    container.appendChild(actions);

    // Tracklist
    if (tracks.length) {
      const list = el('ol', { class: 'tracklist' });
      tracks.forEach((t, i) => {
        const li = el('li', { class: 'tracklist__item' });
        li.appendChild(el('span', { class: 'tracklist__num' }, String(t.position || i + 1)));
        li.appendChild(el('span', { class: 'tracklist__title' }, t.title || `Track ${i + 1}`));
        if (t.duration) li.appendChild(el('span', { class: 'tracklist__dur' }, fmtTime(t.duration)));
        li.addEventListener('click', () => playAlbum(meta, tracks, i, inLibrary));
        list.appendChild(li);
      });
      container.appendChild(list);
    }
  }

  async function renderRemoteStreams(container, meta) {
    const streamsHost = el('div', { class: 'album-streams' });
    streamsHost.appendChild(el('h3', {}, 'Streams'));
    streamsHost.appendChild(el('p', { class: 'loading-inline' }, 'Searching providers...'));
    container.appendChild(streamsHost);
    try {
      const streams = await window.MusicAPI.getAlbumStreams(meta.mbid, meta.artist, meta.title);
      streamsHost.innerHTML = '';
      streamsHost.appendChild(el('h3', {}, `Streams (${streams.length})`));
      if (!streams.length) {
        streamsHost.appendChild(el('p', {}, 'No streams found.'));
        return;
      }
      const list = el('div', { class: 'stream-list' });
      for (const s of streams) {
        const row = el('div', { class: 'stream-row' });
        const lines = (s.title || '').split('\n');
        row.appendChild(el('div', { class: 'stream-row__title' }, lines[0] || ''));
        const tags = [];
        if (s.format) tags.push(s.format);
        if (s.bitrate) tags.push(`${s.bitrate}kbps`);
        if (s.seeds) tags.push(`${s.seeds} seeds`);
        if (s.size) tags.push(s.size);
        if (s.source) tags.push(s.source);
        row.appendChild(el('div', { class: 'stream-row__tags' }, tags.join(' · ')));
        const actions = el('div', { class: 'stream-row__actions' });
        const playBtn = el('button', { class: 'btn-sm' }, 'Play');
        playBtn.addEventListener('click', (ev) => { ev.stopPropagation(); playRemoteAlbumStream(meta, s); });
        actions.appendChild(playBtn);
        if (s.source !== 'YouTube' && s.infoHash) {
          const addBtn = el('button', { class: 'btn-sm' }, 'Add to library');
          addBtn.addEventListener('click', (ev) => { ev.stopPropagation(); addAlbumToLibrary(meta, s); });
          actions.appendChild(addBtn);
        }
        row.appendChild(actions);
        row.addEventListener('click', () => playRemoteAlbumStream(meta, s));
        list.appendChild(row);
      }
      streamsHost.appendChild(list);
    } catch (e) {
      streamsHost.innerHTML = `<p>Error: ${escapeHTML(e.message)}</p>`;
    }
  }

  async function playRemoteAlbumStream(meta, stream) {
    // YouTube entries are a single track, not an album — just play them.
    if (stream.source === 'YouTube' && stream.videoId) {
      const queue = [{
        kind: 'youtube',
        videoId: stream.videoId,
        title: (stream.title || '').split('\n')[0] || meta.title,
        artist: meta.artist,
        album: meta.title,
        coverUrl: meta.coverUrl,
      }];
      window.MusicQueue.playQueue(queue, 0);
      if (window.__app_navigate) window.__app_navigate('music-player');
      return;
    }
    // Start the torrent, list its audio files, build a queue from them.
    const hash = stream.infoHash;
    // Kick the torrent by hitting torrent-status which ensures the engine is active.
    // Actually the torrent isn't active until /api/play/:hash is called. Fire a HEAD
    // so the engine is warmed; then list files.
    try {
      // Trigger engine warm-up (range 0-0 is quick).
      await fetch(`/api/play/${hash}?kind=audio`, { method: 'GET', headers: { Range: 'bytes=0-0' } });
    } catch {}

    // Poll briefly for the engine to list files.
    let files = [];
    for (let i = 0; i < 10 && !files.length; i++) {
      await new Promise(r => setTimeout(r, 600));
      files = await window.MusicAPI.listTorrentAudioFiles(hash).catch(() => []);
    }
    if (!files.length) {
      alert('Could not list audio files — torrent may have no seeds or only non-audio content.');
      return;
    }
    files.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true }));
    const queue = files.map((f, i) => ({
      kind: 'torrent',
      infoHash: hash,
      fileIdx: f.idx,
      magnet: stream.magnetUri,
      title: cleanTrackName(f.name),
      artist: meta.artist,
      album: meta.title,
      coverUrl: meta.coverUrl,
      trackIndex: i,
    }));
    window.MusicQueue.playQueue(queue, 0);
    if (window.__app_navigate) window.__app_navigate('music-player');
  }

  function cleanTrackName(filename) {
    const base = filename.replace(/\.[a-z0-9]+$/i, '');
    return base.replace(/^\d+\s*[-.]\s*/, '').replace(/_/g, ' ').trim();
  }

  async function playAlbum(meta, tracks, startIndex, inLibrary) {
    if (!inLibrary) {
      // Remote album with no torrent yet — nudge the user to pick a stream.
      renderRemoteStreams($('#music-detail-content'), meta);
      return;
    }
    // Library: build queue from on-disk tracks. Music items stream via
    // /api/music-library/:id/stream?track=N (the separate music-specific
    // endpoint); using kind:'library' would hit the video library and 404.
    const queue = tracks.map((t, i) => ({
      kind: 'music-library',
      libraryId: meta.id,
      trackIndex: i,
      albumId: meta.id,
      title: t.title || `Track ${i + 1}`,
      artist: meta.artist,
      album: meta.title || meta.name,
      coverUrl: meta.coverUrl,
      duration: t.duration,
    }));
    window.MusicQueue.playQueue(queue, startIndex);
    if (window.__app_navigate) window.__app_navigate('music-player');
  }

  async function openArtistDetail(mbid) {
    if (window.__app_navigate) window.__app_navigate('music-detail');
    const container = $('#music-detail-content');
    container.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Loading artist...</p></div>';
    try {
      const meta = await window.MusicAPI.getArtistMeta(mbid);
      container.innerHTML = '';
      const hero = el('div', { class: 'album-hero' });
      const info = el('div', { class: 'album-hero__info' });
      info.appendChild(el('h2', {}, meta.name));
      if (meta.disambiguation) info.appendChild(el('p', { class: 'album-hero__year' }, meta.disambiguation));
      if (meta.genres && meta.genres.length) info.appendChild(el('p', { class: 'album-hero__genres' }, meta.genres.slice(0, 3).map(capitalize).join(' · ')));
      hero.appendChild(info);
      container.appendChild(hero);

      const grid = el('div', { class: 'music-grid' });
      for (const rg of (meta.releaseGroups || [])) {
        const card = el('div', { class: 'music-card' });
        card.appendChild(el('div', { class: 'music-card__cover' }));
        card.appendChild(el('div', { class: 'music-card__title' }, rg.title));
        if (rg.year) card.appendChild(el('div', { class: 'music-card__subtitle' }, rg.year));
        card.addEventListener('click', async () => {
          const rel = await window.MusicAPI.getReleaseForGroup(rg.releaseGroupMbid).catch(() => null);
          if (rel && rel.mbid) openAlbumDetail(rel.mbid);
          else alert('No release found for this album.');
        });
        grid.appendChild(card);
      }
      container.appendChild(grid);
    } catch (e) {
      container.innerHTML = `<div class="empty-state"><p>Failed to load artist: ${escapeHTML(e.message)}</p></div>`;
    }
  }

  async function openPlaylistDetail(playlistId) {
    if (window.__app_navigate) window.__app_navigate('music-detail');
    const container = $('#music-detail-content');
    container.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Loading playlist...</p></div>';

    const [playlists, library] = await Promise.all([
      window.MusicAPI.listPlaylists(),
      window.MusicAPI.getLibrary(),
    ]);
    const pl = playlists.find(p => p.id === playlistId);
    if (!pl) { container.innerHTML = '<div class="empty-state"><p>Playlist not found.</p></div>'; return; }
    const albumMap = new Map(library.map(a => [a.id, a]));

    container.innerHTML = '';
    const hero = el('div', { class: 'album-hero' });
    const info = el('div', { class: 'album-hero__info' });
    info.appendChild(el('h2', {}, pl.name));
    info.appendChild(el('p', { class: 'album-hero__artist' }, `${(pl.items || []).length} tracks`));
    hero.appendChild(info);
    container.appendChild(hero);

    const actions = el('div', { class: 'album-actions' });
    const playBtn = el('button', { class: 'btn-primary' }, 'Play');
    playBtn.addEventListener('click', () => {
      const queue = (pl.items || []).map(it => {
        const album = albumMap.get(it.albumId);
        if (!album) return null;
        const track = (album.tracks || [])[it.trackIndex] || {};
        return {
          kind: 'library',
          libraryId: album.id,
          fileIdx: track.fileIdx !== undefined ? track.fileIdx : it.trackIndex,
          albumId: album.id,
          trackIndex: it.trackIndex,
          title: track.title || `Track ${it.trackIndex + 1}`,
          artist: album.artist,
          album: album.title,
          coverUrl: album.coverUrl,
          duration: track.duration,
        };
      }).filter(Boolean);
      if (!queue.length) { alert('No playable tracks in this playlist.'); return; }
      window.MusicQueue.playQueue(queue, 0);
      if (window.__app_navigate) window.__app_navigate('music-player');
    });
    actions.appendChild(playBtn);

    const renameBtn = el('button', { class: 'btn-block' }, 'Rename');
    renameBtn.addEventListener('click', async () => {
      const next = prompt('Rename playlist:', pl.name);
      if (!next) return;
      await window.MusicAPI.renamePlaylist(pl.id, next.trim());
      openPlaylistDetail(playlistId);
    });
    actions.appendChild(renameBtn);

    const delBtn = el('button', { class: 'btn-block' }, 'Delete');
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Delete playlist "${pl.name}"?`)) return;
      await window.MusicAPI.deletePlaylist(pl.id);
      switchMusicTab('playlists');
    });
    actions.appendChild(delBtn);
    container.appendChild(actions);

    const list = el('ol', { class: 'tracklist' });
    (pl.items || []).forEach((it, i) => {
      const album = albumMap.get(it.albumId);
      const track = album ? (album.tracks || [])[it.trackIndex] : null;
      const li = el('li', { class: 'tracklist__item' });
      li.appendChild(el('span', { class: 'tracklist__num' }, String(i + 1)));
      li.appendChild(el('span', { class: 'tracklist__title' }, (track && track.title) || (album && album.title) || 'Unknown'));
      if (album) li.appendChild(el('span', { class: 'tracklist__dur' }, album.artist || ''));
      const rm = el('button', { class: 'icon-btn-sm' }, '✕');
      rm.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        await window.MusicAPI.removePlaylistItem(pl.id, i);
        openPlaylistDetail(playlistId);
      });
      li.appendChild(rm);
      list.appendChild(li);
    });
    container.appendChild(list);
  }

  // ─── Music search ─────────────────────

  let _searchTimer = null;
  function wireMusicSearch() {
    const input = $('#music-search-input');
    const clearBtn = $('#music-search-clear');
    if (!input) return;
    input.addEventListener('input', () => {
      const q = input.value.trim();
      clearBtn.classList.toggle('hidden', !q);
      clearTimeout(_searchTimer);
      _searchTimer = setTimeout(() => runMusicSearch(q), 300);
    });
    clearBtn.addEventListener('click', () => {
      input.value = '';
      clearBtn.classList.add('hidden');
      switchMusicTab(currentTab);
    });
  }

  async function runMusicSearch(q) {
    const content = $('#music-content');
    if (!q) { switchMusicTab(currentTab); return; }
    content.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Searching MusicBrainz...</p></div>';
    try {
      const groups = await window.MusicAPI.searchMusicGrouped(q);
      const { artists = [], albums = [], songs = [] } = groups || {};
      content.innerHTML = '';
      if (!artists.length && !albums.length && !songs.length) {
        content.innerHTML = '<div class="empty-state"><p>No results.</p></div>';
        return;
      }
      if (artists.length) content.appendChild(renderSearchSection('Artists', artists, 'grid'));
      if (albums.length) content.appendChild(renderSearchSection('Albums', albums, 'grid'));
      if (songs.length) content.appendChild(renderSearchSection('Songs', songs, 'list'));
    } catch (e) {
      content.innerHTML = `<div class="empty-state"><p>Search failed: ${escapeHTML(e.message)}</p></div>`;
    }
  }

  function renderSearchSection(title, items, layout) {
    const section = el('div', { class: 'music-search-section' });
    section.appendChild(el('h3', { class: 'music-search-section__title' }, `${title} (${items.length})`));
    if (layout === 'list') {
      const list = el('div', { class: 'music-song-list' });
      for (const it of items) list.appendChild(renderSongRow(it));
      section.appendChild(list);
    } else {
      const grid = el('div', { class: 'music-grid' });
      for (const it of items) grid.appendChild(renderCard(it, 'remote'));
      section.appendChild(grid);
    }
    return section;
  }

  function renderSongRow(item) {
    const row = el('div', { class: 'music-song-row', 'data-id': item.id || '' });
    const cover = el('div', { class: 'music-song-row__cover' });
    if (item.poster) cover.style.backgroundImage = `url(${item.poster})`;
    row.appendChild(cover);
    const meta = el('div', { class: 'music-song-row__meta' });
    meta.appendChild(el('div', { class: 'music-song-row__title' }, item.name || ''));
    const sub = [item.artist, item.album].filter(Boolean).join(' — ');
    if (sub) meta.appendChild(el('div', { class: 'music-song-row__subtitle' }, sub));
    row.appendChild(meta);
    if (item.duration) row.appendChild(el('div', { class: 'music-song-row__time' }, fmtTime(item.duration)));
    row.addEventListener('click', () => {
      // Clicking a song opens the album detail it appears on; users can then
      // play the full album or jump to the track from there.
      if (item.releaseMbid) openAlbumDetail(item.releaseMbid);
    });
    return row;
  }

  // ─── Tab switching ─────────────────────

  function switchMusicTab(tab) {
    currentTab = tab;
    $$('.music-tab').forEach(b => b.classList.toggle('active', b.dataset.musicTab === tab));
    if (tab === 'home') renderMusicHome();
    else if (tab === 'playlists') renderPlaylistsTab();
    else if (tab === 'albums') renderAlbumsTab();
    else if (tab === 'artists') renderArtistsTab();
    else if (tab === 'recent') renderRecentTab();
    else if (tab === 'favorites') renderFavoritesTab();
  }

  function enterMusicTab() {
    // Ensure the active tab button visually matches the in-memory state —
    // users returning from album/artist detail expect the correct tab pill
    // to stay highlighted.
    const tab = currentTab || 'home';
    $$('.music-tab').forEach(b => b.classList.toggle('active', b.dataset.musicTab === tab));
    switchMusicTab(tab);
  }

  // ─── Mini / Full player wiring ─────────

  function renderMiniPlayer(state) {
    const bar = $('#music-player-bar');
    if (!bar) return;
    const item = window.MusicQueue.currentItem();
    if (!item) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    const cover = $('#mpb-cover');
    if (item.coverUrl) cover.style.backgroundImage = `url(${item.coverUrl})`;
    else cover.style.backgroundImage = '';
    $('#mpb-title').textContent = item.title || '—';
    $('#mpb-artist').textContent = [item.artist, item.album].filter(Boolean).join(' — ');
    $('#mpb-playicon').classList.toggle('hidden', !state.paused);
    $('#mpb-pauseicon').classList.toggle('hidden', state.paused);
    const pct = state.duration ? (state.position / state.duration) * 100 : 0;
    $('#mpb-progress-fill').style.width = `${Math.min(100, Math.max(0, pct))}%`;
  }

  function renderFullPlayer(state) {
    const view = $('#view-music-player');
    if (!view) return;
    const item = window.MusicQueue.currentItem();
    if (!item) return;
    const cover = $('#mpf-cover');
    if (item.coverUrl) cover.style.backgroundImage = `url(${item.coverUrl})`;
    else cover.style.backgroundImage = '';
    $('#mpf-title').textContent = item.title || '—';
    $('#mpf-artist').textContent = item.artist || '';
    $('#mpf-album').textContent = item.album || '';
    $('#mpf-duration').textContent = fmtTime(state.duration);
    const seek = $('#mpf-seek');
    if (seek && !seek.dataset.dragging) {
      // Keep the slider and current-time label in sync with playback.
      seek.value = state.duration ? Math.round((state.position / state.duration) * 1000) : 0;
      $('#mpf-current').textContent = fmtTime(state.position);
    } else if (seek && state.duration) {
      // While dragging, show the scrubbed time instead of the still-playing
      // position so the user can preview where they're seeking to.
      $('#mpf-current').textContent = fmtTime((seek.value / 1000) * state.duration);
    }
    $('#mpf-playicon').classList.toggle('hidden', !state.paused);
    $('#mpf-pauseicon').classList.toggle('hidden', state.paused);
    $('#mpf-shuffle').classList.toggle('active', !!state.shuffle);
    const rep = $('#mpf-repeat');
    rep.classList.toggle('active', state.repeat !== 'off');
    rep.setAttribute('data-state', state.repeat);

    // Queue list: show the current track first (marked) then the upcoming
    // tracks. Users often want to confirm what's playing and jump back to
    // earlier queue items, so rendering only "upcoming" hides useful context.
    const ol = $('#mpf-queue');
    ol.innerHTML = '';
    const order = state.shuffleOrder || state.queue.map((_, i) => i);
    const currentPos = order.indexOf(state.currentIndex);
    for (let i = 0; i < order.length; i++) {
      const qi = order[i];
      const q = state.queue[qi];
      const isCurrent = i === currentPos;
      const li = el('li', {
        class: 'queue-item' + (isCurrent ? ' now-playing' : ''),
        draggable: !isCurrent,
      });
      li.dataset.queueIdx = qi;
      li.appendChild(el('span', { class: 'queue-item__title' }, q.title || '—'));
      li.appendChild(el('span', { class: 'queue-item__artist' }, q.artist || ''));
      li.addEventListener('click', () => window.MusicQueue.jumpTo(qi));
      ol.appendChild(li);
    }
  }

  function wirePlayerControls() {
    $('#mpb-playpause').addEventListener('click', () => window.MusicQueue.togglePlay());
    $('#mpb-next').addEventListener('click', () => window.MusicQueue.next());
    $('#mpb-prev').addEventListener('click', () => window.MusicQueue.prev());
    $('#mpb-cover').addEventListener('click', () => { if (window.__app_navigate) window.__app_navigate('music-player'); });
    $('#mpb-title').addEventListener('click', () => { if (window.__app_navigate) window.__app_navigate('music-player'); });

    $('#mpf-playpause').addEventListener('click', () => window.MusicQueue.togglePlay());
    $('#mpf-next').addEventListener('click', () => window.MusicQueue.next());
    $('#mpf-prev').addEventListener('click', () => window.MusicQueue.prev());
    $('#mpf-shuffle').addEventListener('click', () => window.MusicQueue.toggleShuffle());
    $('#mpf-repeat').addEventListener('click', () => window.MusicQueue.cycleRepeat());
    $('#music-player-close').addEventListener('click', () => {
      if (window.__app_goBack) window.__app_goBack();
    });

    const seek = $('#mpf-seek');
    seek.addEventListener('input', () => {
      seek.dataset.dragging = '1';
      // Live-update the current-time label so the user can tell where
      // they're dragging to even while audio is paused.
      const dur = window.MusicQueue.state.duration || 0;
      if (dur) {
        const cur = document.getElementById('mpf-current');
        if (cur) cur.textContent = fmtTime((seek.value / 1000) * dur);
      }
    });
    seek.addEventListener('change', () => {
      const dur = window.MusicQueue.state.duration || 0;
      if (dur) window.MusicQueue.seek((seek.value / 1000) * dur);
      delete seek.dataset.dragging;
    });

    // HTML5 DnD queue reorder (best-effort)
    const ol = $('#mpf-queue');
    let dragged = null;
    ol.addEventListener('dragstart', (e) => {
      if (e.target.matches('.queue-item')) {
        dragged = e.target;
        e.target.classList.add('dragging');
      }
    });
    ol.addEventListener('dragover', (e) => {
      e.preventDefault();
      const over = e.target.closest('.queue-item');
      if (over && over !== dragged) {
        const rect = over.getBoundingClientRect();
        const after = (e.clientY - rect.top) > rect.height / 2;
        ol.insertBefore(dragged, after ? over.nextSibling : over);
      }
    });
    ol.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!dragged) return;
      dragged.classList.remove('dragging');
      // Rebuild shuffleOrder (or queue) from DOM order.
      const newOrder = Array.from(ol.children).map(li => parseInt(li.dataset.queueIdx, 10));
      const state = window.MusicQueue.state;
      const full = (state.shuffleOrder || state.queue.map((_, i) => i)).slice();
      const currentPos = full.indexOf(state.currentIndex);
      const head = full.slice(0, currentPos + 1);
      state.shuffleOrder = state.shuffle ? [...head, ...newOrder] : null;
      if (!state.shuffle) {
        // Reorder the actual queue array to match.
        const before = state.queue.slice(0, currentPos + 1);
        const after = newOrder.map(i => state.queue[i]);
        state.queue = [...before.map((_, i) => full[i] < full.length ? state.queue[full[i]] : null).filter(Boolean), ...after];
        state.currentIndex = currentPos;
      }
      dragged = null;
    });
  }

  // ─── Library selector + music library view ─────────────

  async function refreshLibrarySelectorCounts() {
    try {
      const [videos, albums] = await Promise.all([
        fetch('/api/library').then(r => r.json()).then(d => (d.items || []).length).catch(() => null),
        fetch('/api/music-library').then(r => r.json()).then(d => (d.items || []).length).catch(() => null),
      ]);
      const v = document.getElementById('library-selector-video-count');
      const m = document.getElementById('library-selector-music-count');
      if (v && videos != null) v.textContent = `${videos} item${videos === 1 ? '' : 's'}`;
      if (m && albums != null) m.textContent = `${albums} album${albums === 1 ? '' : 's'}`;
    } catch {}
  }

  function wireLibrarySelector() {
    $$('.library-selector__card').forEach(card => {
      card.addEventListener('click', () => {
        const target = card.dataset.selectorTarget;
        if (!window.__app_navigate) return;
        if (target === 'library') {
          window.__app_navigate('library');
        } else if (target === 'music-library') {
          window.__app_navigate('music-library');
          renderMusicLibrary();
        }
      });
    });
  }

  async function renderMusicLibrary() {
    const host = document.getElementById('music-library-content');
    const empty = document.getElementById('music-library-empty');
    if (!host) return;
    host.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Loading music library...</p></div>';
    let items = [];
    try {
      const data = await fetch('/api/music-library').then(r => r.json());
      items = data.items || [];
    } catch {}
    host.innerHTML = '';
    if (!items.length) {
      empty && empty.classList.remove('hidden');
      return;
    }
    empty && empty.classList.add('hidden');
    // Newest-first.
    items.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    for (const item of items) {
      const card = el('div', { class: 'music-card music-lib-card', 'data-id': item.id });
      const cover = el('div', { class: 'music-card__cover' });
      if (item.coverUrl) cover.style.backgroundImage = `url(${item.coverUrl})`;
      card.appendChild(cover);
      card.appendChild(el('div', { class: 'music-card__title' }, item.title || item.name));
      if (item.artist) card.appendChild(el('div', { class: 'music-card__subtitle' }, item.artist));
      if (item.status && item.status !== 'complete') {
        const pct = Math.max(0, Math.min(100, Math.round(item.progress || 0)));
        card.appendChild(el('div', { class: 'music-lib-card__status' }, `${item.status} · ${pct}%`));
      }
      card.addEventListener('click', () => {
        if (item.status === 'complete') playMusicLibraryAlbum(item);
        else alert(`${item.status === 'downloading' ? 'Still downloading' : 'Not playable yet'} — ${Math.round(item.progress || 0)}%`);
      });
      host.appendChild(card);
    }
  }

  async function playMusicLibraryAlbum(item, startIndex = 0) {
    const tracks = item.tracks || [];
    if (!tracks.length) { alert('No tracks found in this album.'); return; }
    const queue = tracks.map((t, i) => ({
      kind: 'music-library',
      libraryId: item.id,
      trackIndex: i,
      albumId: item.id,
      title: t.title || `Track ${i + 1}`,
      artist: item.artist,
      album: item.title,
      coverUrl: item.coverUrl,
      duration: t.duration,
    }));
    window.MusicQueue.playQueue(queue, startIndex);
    if (window.__app_navigate) window.__app_navigate('music-player');
  }

  // ─── Add-to-library action from remote album streams ─────────

  async function addAlbumToLibrary(meta, stream) {
    if (stream.source === 'YouTube') {
      alert('YouTube streams play directly — no library storage.');
      return;
    }
    if (!stream.infoHash || !stream.magnetUri) {
      alert('This stream has no magnet URI, can’t add to library.');
      return;
    }
    try {
      const res = await fetch('/api/music-library/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          infoHash: stream.infoHash,
          magnetUri: stream.magnetUri,
          mbid: meta.mbid,
          artistMbid: meta.artistMbid,
          title: meta.title,
          artist: meta.artist,
          year: meta.year,
          coverUrl: meta.coverUrl,
          genres: meta.genres || [],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Add failed');
      alert(`Added to Music Library — ${data.status || 'started'}`);
    } catch (err) {
      alert('Failed to add to library: ' + err.message);
    }
  }

  // ─── Wire up on load ─────────────────────

  function init() {
    $$('.music-tab').forEach(b => b.addEventListener('click', () => switchMusicTab(b.dataset.musicTab)));
    wireMusicSearch();
    wirePlayerControls();
    wireLibrarySelector();

    // Toggle body.music-player-open so CSS can hide the redundant mini-player
    // while the full-screen player is on screen. Uses a MutationObserver to
    // track .active class changes so we stay in sync regardless of which
    // part of the app triggered the navigation.
    const fullView = document.getElementById('view-music-player');
    if (fullView) {
      const syncOpen = () => {
        const isOpen = fullView.classList.contains('active');
        document.body.classList.toggle('music-player-open', isOpen);
        // Paint the full player immediately when the view becomes active;
        // otherwise it'd show stale DOM until the next timeupdate tick.
        if (isOpen) renderFullPlayer(window.MusicQueue.state);
      };
      new MutationObserver(syncOpen).observe(fullView, { attributes: true, attributeFilter: ['class'] });
      syncOpen();
    }

    window.MusicQueue.on((state) => {
      renderMiniPlayer(state);
      if (fullView && fullView.classList.contains('active')) {
        renderFullPlayer(state);
      }
    });
    // Paint initial mini-player state on load.
    renderMiniPlayer(window.MusicQueue.state);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.MusicUI = {
    enterMusicTab,
    switchMusicTab,
    openAlbumDetail,
    openLibraryAlbumDetail,
    openArtistDetail,
    openPlaylistDetail,
    refreshLibrarySelectorCounts,
    renderMusicLibrary,
    addAlbumToLibrary,
  };
})();
