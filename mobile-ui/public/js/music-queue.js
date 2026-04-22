// Albatross — Music Queue Manager
// Central playback controller for the Music tab. Drives a single shared
// <audio id="audio-player">, persists state in localStorage, fires events to
// the UI layer for rendering the mini-player and full-player.

(function () {
  'use strict';

  const STORAGE_KEY = 'music:queue';
  const RECENT_KEY = 'music:recent';
  const RECENT_MAX = 50;

  // Queue item shape:
  //   { kind: 'torrent'|'youtube', src, infoHash?, fileIdx?, videoId?,
  //     albumId?, trackIndex?, title, artist, album, coverUrl, duration }

  const listeners = new Set();
  function emit() {
    for (const fn of listeners) {
      try { fn(state); } catch (e) { console.error('[MusicQueue] listener error', e); }
    }
  }

  const state = {
    queue: [],          // upcoming + current + history (same array, indexed by currentIndex)
    currentIndex: -1,
    shuffle: false,
    repeat: 'off',      // 'off' | 'all' | 'one'
    paused: true,
    position: 0,        // seconds
    duration: 0,
    shuffleOrder: null, // array of queue indices; null when shuffle=off
  };

  const audio = document.getElementById('audio-player');

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        queue: state.queue,
        currentIndex: state.currentIndex,
        shuffle: state.shuffle,
        repeat: state.repeat,
        shuffleOrder: state.shuffleOrder,
        position: Math.round(state.position || 0),
      }));
    } catch {}
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      Object.assign(state, parsed);
      // Don't autoplay on load — restore state paused.
      state.paused = true;
    } catch {}
  }

  function buildSrc(item) {
    if (!item) return '';
    if (item.kind === 'youtube' && item.videoId) {
      return `/api/play/youtube/${encodeURIComponent(item.videoId)}`;
    }
    if (item.kind === 'torrent' && item.infoHash) {
      const params = new URLSearchParams({ kind: 'audio' });
      if (item.fileIdx !== undefined && item.fileIdx !== null) params.set('fileIdx', item.fileIdx);
      if (item.magnet) params.set('magnet', item.magnet);
      return `/api/play/${item.infoHash}?${params.toString()}`;
    }
    if (item.kind === 'library' && item.libraryId) {
      const params = new URLSearchParams();
      if (item.fileIdx !== undefined && item.fileIdx !== null) params.set('fileIdx', item.fileIdx);
      return `/api/library/${item.libraryId}/stream?${params.toString()}`;
    }
    return item.src || '';
  }

  function currentItem() {
    if (state.currentIndex < 0 || state.currentIndex >= state.queue.length) return null;
    return state.queue[state.currentIndex];
  }

  // ─── Playback control ─────────────────────

  function _startCurrent() {
    const item = currentItem();
    if (!item) return;
    const src = buildSrc(item);
    if (!src) return;
    const absolute = new URL(src, window.location.href).href;
    if (audio.src !== absolute) {
      audio.src = src;
      audio.load();
    }
    state.paused = false;
    audio.play().catch(err => console.log('[MusicQueue] play() rejected', err.message));
    if (item.albumId && window.MusicAPI) {
      window.MusicAPI.markPlayed(item.albumId);
      pushRecent(item);
    }
    emit();
  }

  function playQueue(items, startIndex = 0) {
    if (!items || !items.length) return;
    state.queue = items.slice();
    state.currentIndex = Math.max(0, Math.min(startIndex, state.queue.length - 1));
    state.shuffleOrder = state.shuffle ? _makeShuffleOrder(state.queue.length, state.currentIndex) : null;
    save();
    _startCurrent();
  }

  function enqueueNext(item) {
    if (state.currentIndex < 0) return playQueue([item], 0);
    state.queue.splice(state.currentIndex + 1, 0, item);
    if (state.shuffleOrder) state.shuffleOrder.splice(state.shuffleOrder.indexOf(state.currentIndex) + 1, 0, state.queue.length - 1);
    save(); emit();
  }

  function enqueueLast(item) {
    if (state.currentIndex < 0) return playQueue([item], 0);
    state.queue.push(item);
    if (state.shuffleOrder) state.shuffleOrder.push(state.queue.length - 1);
    save(); emit();
  }

  function togglePlay() {
    if (!currentItem()) return;
    if (audio.paused) {
      state.paused = false;
      audio.play().catch(() => {});
    } else {
      state.paused = true;
      audio.pause();
    }
    emit();
  }

  function next() {
    if (!state.queue.length) return;
    if (state.repeat === 'one') {
      audio.currentTime = 0;
      audio.play().catch(() => {});
      return;
    }
    const order = state.shuffleOrder || state.queue.map((_, i) => i);
    const pos = order.indexOf(state.currentIndex);
    const nextPos = pos + 1;
    if (nextPos >= order.length) {
      if (state.repeat === 'all') {
        state.currentIndex = order[0];
        _startCurrent();
      } else {
        audio.pause();
        state.paused = true;
        emit();
      }
      return;
    }
    state.currentIndex = order[nextPos];
    save();
    _startCurrent();
  }

  function prev() {
    if (!state.queue.length) return;
    // Restart track if > 3s in
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    const order = state.shuffleOrder || state.queue.map((_, i) => i);
    const pos = order.indexOf(state.currentIndex);
    if (pos <= 0) { audio.currentTime = 0; return; }
    state.currentIndex = order[pos - 1];
    save();
    _startCurrent();
  }

  function jumpTo(queueIdx) {
    if (queueIdx < 0 || queueIdx >= state.queue.length) return;
    state.currentIndex = queueIdx;
    save();
    _startCurrent();
  }

  function seek(seconds) {
    if (!isFinite(seconds)) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration || seconds, seconds));
  }

  // ─── Shuffle / repeat ─────────────────────

  function _makeShuffleOrder(n, pinIndex) {
    const arr = [];
    for (let i = 0; i < n; i++) arr.push(i);
    // Fisher-Yates shuffle
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    // Move pinIndex to the front so current track stays current.
    if (pinIndex !== undefined && pinIndex >= 0) {
      const p = arr.indexOf(pinIndex);
      if (p > 0) { arr.splice(p, 1); arr.unshift(pinIndex); }
    }
    return arr;
  }

  function toggleShuffle() {
    state.shuffle = !state.shuffle;
    state.shuffleOrder = state.shuffle ? _makeShuffleOrder(state.queue.length, state.currentIndex) : null;
    save(); emit();
  }

  function cycleRepeat() {
    state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
    save(); emit();
  }

  // ─── Recently Played ─────────────────────

  function pushRecent(item) {
    if (!item || !item.albumId) return;
    let recent = [];
    try { recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch {}
    recent = recent.filter(r => !(r.albumId === item.albumId && r.trackIndex === item.trackIndex));
    recent.unshift({ albumId: item.albumId, trackIndex: item.trackIndex, playedAt: Date.now(), title: item.title, artist: item.artist, coverUrl: item.coverUrl });
    recent = recent.slice(0, RECENT_MAX);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch {}
  }

  function getRecent() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
  }

  function clearRecent() {
    try { localStorage.removeItem(RECENT_KEY); } catch {}
  }

  // ─── Audio element wiring ─────────────────

  audio.addEventListener('timeupdate', () => {
    state.position = audio.currentTime || 0;
    state.duration = audio.duration || 0;
    emit();
  });
  audio.addEventListener('play', () => { state.paused = false; emit(); });
  audio.addEventListener('pause', () => { state.paused = true; emit(); });
  audio.addEventListener('ended', () => { next(); });
  audio.addEventListener('error', (e) => {
    console.warn('[MusicQueue] audio error', e);
    // Try next track instead of hanging.
    setTimeout(() => next(), 500);
  });

  // Periodic save so we don't lose position on tab close.
  setInterval(() => {
    if (audio && !audio.paused) save();
  }, 5000);

  // ─── Public API ─────────────────────

  window.MusicQueue = {
    state,
    on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    currentItem,
    playQueue,
    enqueueNext,
    enqueueLast,
    togglePlay,
    next,
    prev,
    jumpTo,
    seek,
    toggleShuffle,
    cycleRepeat,
    getRecent,
    clearRecent,
  };

  // Rehydrate on load.
  load();
  emit();
})();
