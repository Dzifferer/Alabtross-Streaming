/**
 * Albatross — Fire TV / D-pad remote navigation
 *
 * Makes the touch-first UI usable with a TV remote (Amazon Fire TV, Android
 * TV, or any keyboard) so the app can be deployed on a television:
 *
 *   - Spatial navigation: D-pad arrows move an on-screen focus highlight to
 *     the nearest interactive element in the pressed direction.
 *   - OK / Select (Enter) activates the focused element.
 *   - Back (Escape / Backspace / hardware back) navigates back, closing any
 *     open overlay first.
 *   - Media keys (Play/Pause, Rewind, Fast-Forward) drive the video player.
 *
 * TV mode is auto-detected on Fire TV / Android TV user agents and can be
 * forced on or off from Settings. When off, this module is inert and the
 * app behaves exactly as the plain touch build.
 */
(function () {
  'use strict';

  // ─── Interactive element selector ───────────────────────────────
  // Native controls plus the app's clickable <div> components (cards,
  // list rows, chips) which carry click handlers but no native focus.
  const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
    '[role="button"]',
    '.card', '.channel-card', '.channel-group-chip',
    '.library-card', '.library-group-tile', '.episode-item',
    '.cast-device-item', '.addon-item', '.source-item', '.diag-item',
    '.download-item', '.download-pack-item', '.complete-pack-item',
    '.review-card', '.music-card', '.artist-card', '.release-card',
    '.lib-card', '.song-row', '.stream-row', '.queue-item',
    '.playlist-row', '.genre-chip', '.filter-chip',
    '.settings-section-toggle',
    '[data-view]', '[data-music-tab]', '[data-selector-target]',
    '[data-filter]',
  ].join(',');

  // Overlays/modals that, when present, should trap focus.
  const OVERLAY_SELECTOR =
    '.categorize-modal, .relink-modal, #library-group-overlay, ' +
    '#cast-device-picker, .up-next-card';

  // ─── TV mode state ──────────────────────────────────────────────
  let tvMode = false;

  function isTvDevice() {
    const ua = navigator.userAgent || '';
    // Fire TV stick/cube model codes (AFTB, AFTS, AFTMM, ...), Android TV,
    // and generic "TV" / "SmartTV" / "GoogleTV" / "Web0S" / Tizen agents.
    return /AFT[A-Z0-9]{1,6}|Fire ?TV|Android ?TV|GoogleTV|SMART-TV|SmartTV|\bTV\b.*Safari|Web0S|Tizen/i
      .test(ua);
  }

  function readStored() {
    try { return localStorage.getItem('tv_mode'); } catch { return null; }
  }
  function writeStored(val) {
    try { localStorage.setItem('tv_mode', val); } catch { /* quota */ }
  }

  function setTvMode(on, persist) {
    tvMode = !!on;
    document.documentElement.classList.toggle('tv-mode', tvMode);
    const cb = document.getElementById('setting-tv-mode');
    if (cb) cb.checked = tvMode;
    if (persist) writeStored(tvMode ? 'on' : 'off');
    if (tvMode) {
      pushHistorySentinel();
      syncFocus();
    } else {
      clearHighlight();
    }
  }

  // ─── Visibility & geometry helpers ──────────────────────────────
  function isVisible(el) {
    if (!el || el.disabled) return false;
    if (el.getClientRects().length === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.opacity === '0') return false;
    return true;
  }

  function center(r) {
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  // ─── Scope resolution ───────────────────────────────────────────
  // Focus is confined to the top-most open overlay, or otherwise to the
  // whole document (inactive views are display:none and excluded
  // automatically by the visibility check).
  function openOverlay() {
    const overlays = Array.prototype.slice
      .call(document.querySelectorAll(OVERLAY_SELECTOR))
      .filter((el) => !el.classList.contains('hidden') && isVisible(el));
    if (!overlays.length) return null;
    // Last in DOM order is the most recently opened / top-most.
    for (let i = overlays.length - 1; i >= 0; i--) {
      if (collect(overlays[i]).length) return overlays[i];
    }
    return null;
  }

  function activeViewEl() {
    return document.querySelector('.view.active');
  }

  function currentScope() {
    return openOverlay() || document;
  }

  function collect(root) {
    return Array.prototype.slice
      .call((root || document).querySelectorAll(FOCUSABLE))
      .filter(isVisible);
  }

  // ─── Focus highlight ────────────────────────────────────────────
  let highlighted = null;

  function clearHighlight() {
    if (highlighted) {
      highlighted.classList.remove('tv-focus');
      highlighted = null;
    }
  }

  function ensureFocusable(el) {
    const t = el.tagName;
    const native = t === 'A' || t === 'BUTTON' || t === 'INPUT' ||
                   t === 'SELECT' || t === 'TEXTAREA';
    // Only <div>-style components need a synthetic tabindex; leave native
    // controls untouched so the keyboard Tab order is unaffected.
    if (!native && !el.hasAttribute('tabindex')) {
      el.setAttribute('tabindex', '-1');
    }
  }

  function focusEl(el) {
    if (!el) return;
    if (highlighted && highlighted !== el) {
      highlighted.classList.remove('tv-focus');
    }
    ensureFocusable(el);
    try { el.focus({ preventScroll: true }); } catch { el.focus(); }
    el.classList.add('tv-focus');
    highlighted = el;
    try {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    } catch {
      el.scrollIntoView(false);
    }
  }

  function currentEl() {
    const a = document.activeElement;
    if (a && a !== document.body && isVisible(a)) return a;
    if (highlighted && isVisible(highlighted)) return highlighted;
    return null;
  }

  function firstInScope() {
    const view = activeViewEl();
    let list = view ? collect(view) : [];
    if (!list.length) list = collect(document);
    if (!list.length) return null;
    // Top-most, then left-most in reading order.
    list.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return (ra.top - rb.top) || (ra.left - rb.left);
    });
    return list[0];
  }

  // ─── Spatial navigation ─────────────────────────────────────────

  // Persistent chrome (top bar, search/filter bars, bottom nav, mini
  // player) lives outside the scrollable content area. Geometrically the
  // fixed bottom nav often sits closer to a card than the next — still
  // off-screen — row of cards, so a naive nearest-neighbour search would
  // jump into the nav bar instead of scrolling the content. Tracking
  // which cluster an element belongs to lets navigation exhaust the
  // scrollable content before crossing into the chrome.
  const CHROME_SELECTOR =
    '#top-bar, #search-bar, #filter-bar, #bottom-nav, #music-player-bar';

  function isChrome(el) {
    return !!(el && el.closest && el.closest(CHROME_SELECTOR));
  }

  // Best candidate from `list` in direction `dir` relative to `cur`.
  // Prefers the tight 45-degree cone, falling back to anything in the
  // correct half-plane so grid rows wrap cleanly.
  function bestInDirection(cur, list, dir) {
    const cc = center(cur.getBoundingClientRect());
    let best = null, bestScore = Infinity;
    let loose = null, looseScore = Infinity;

    for (const el of list) {
      const c = center(el.getBoundingClientRect());
      const dx = c.x - cc.x;
      const dy = c.y - cc.y;

      let main, cross, moving;
      if (dir === 'left' || dir === 'right') {
        main = dx; cross = Math.abs(dy);
        moving = dir === 'left' ? dx < -1 : dx > 1;
      } else {
        main = dy; cross = Math.abs(dx);
        moving = dir === 'up' ? dy < -1 : dy > 1;
      }
      if (!moving) continue;

      const score = Math.abs(main) + cross * 3;
      if (Math.abs(main) >= cross && score < bestScore) {
        bestScore = score; best = el;
      }
      if (score < looseScore) { looseScore = score; loose = el; }
    }
    return best || loose;
  }

  function move(dir) {
    const scope = currentScope();
    const cur = currentEl();
    if (!cur || (scope !== document && !scope.contains(cur))) {
      const overlay = openOverlay();
      focusEl(overlay ? collect(overlay)[0] : firstInScope());
      return;
    }
    const candidates = collect(scope).filter((el) => el !== cur);
    if (!candidates.length) return;

    const content = candidates.filter((el) => !isChrome(el));
    const chrome = candidates.filter((el) => isChrome(el));
    const contentBest = bestInDirection(cur, content, dir);
    const chromeBest = bestInDirection(cur, chrome, dir);

    let target;
    if (!isChrome(cur)) {
      // Inside scrollable content: stay in the content (scrolling to
      // off-screen rows) until it is exhausted, only then enter chrome.
      target = contentBest || chromeBest;
    } else {
      // Inside chrome: pressing toward the content area dives back in;
      // otherwise move within the chrome cluster.
      const atBottom = !!cur.closest('#bottom-nav, #music-player-bar');
      const towardContent = atBottom ? dir === 'up' : dir === 'down';
      target = towardContent
        ? (contentBest || chromeBest)
        : (chromeBest || contentBest);
    }

    focusEl(target);
  }

  // ─── Activation ─────────────────────────────────────────────────
  function activate(el) {
    if (!el) return;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      el.focus();
      return;
    }
    if (tag === 'SELECT') {
      el.focus();
      return; // native open on key handled by the browser
    }
    el.click();
  }

  // ─── Back handling ──────────────────────────────────────────────
  let lastBackAt = 0;

  function dismissOverlay(overlay) {
    const closers = [
      '[data-tv-back]', '.relink-modal-close', '.categorize-modal-close',
      '.manual-import-close', '.library-group-overlay-back',
      '#up-next-cancel', '.cast-picker-close',
    ];
    for (const sel of closers) {
      const btn = overlay.querySelector(sel);
      if (btn) { btn.click(); return true; }
    }
    // The cast picker closes when its backdrop is clicked.
    if (overlay.id === 'cast-device-picker') { overlay.click(); return true; }
    return false;
  }

  function goBack() {
    const now = Date.now();
    if (now - lastBackAt < 350) return; // de-dupe key + popstate
    lastBackAt = now;

    const overlay = openOverlay();
    if (overlay && dismissOverlay(overlay)) return;

    if (typeof window.__app_goBack === 'function') {
      window.__app_goBack();
    }
  }

  // ─── Key handling ───────────────────────────────────────────────
  function inPlayer() {
    const v = activeViewEl();
    return v && v.id === 'view-player';
  }

  function isTextField(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    return !/^(checkbox|radio|button|submit|range|color|file)$/i.test(el.type);
  }

  const ARROWS = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  };
  const BACK_KEYS = ['Escape', 'GoBack', 'BrowserBack', 'Backspace'];

  function onKeyDown(e) {
    if (!tvMode || e.defaultPrevented) return;

    const dir = ARROWS[e.key];
    const active = document.activeElement;

    // The video player owns its own D-pad / media keys (seek, volume,
    // play/pause) — leave it alone unless an overlay is open on top.
    if (inPlayer() && !openOverlay()) return;

    if (dir) {
      // Let native controls keep the axis they need: text fields keep
      // left/right for the caret, range sliders keep left/right for value,
      // selects keep up/down for option changes.
      if (isTextField(active) && (dir === 'left' || dir === 'right')) return;
      if (active && active.tagName === 'INPUT' && active.type === 'range' &&
          (dir === 'left' || dir === 'right')) return;
      if (active && active.tagName === 'SELECT' &&
          (dir === 'up' || dir === 'down')) return;
      e.preventDefault();
      move(dir);
      return;
    }

    if (e.key === 'Enter') {
      const el = currentEl();
      if (isTextField(el)) return; // allow form submit / keyboard
      if (el) { e.preventDefault(); activate(el); }
      return;
    }

    if (BACK_KEYS.indexOf(e.key) !== -1) {
      // Backspace must still delete characters inside a text field.
      if (e.key === 'Backspace' && isTextField(active)) return;
      e.preventDefault();
      goBack();
    }
  }

  // Fire TV's hardware Back button often arrives as a history navigation
  // rather than a key event. A sentinel history entry lets us intercept it
  // and route through the in-app back stack instead of exiting the app.
  // The sentinel is only pushed while TV mode is active, so plain browser
  // history is left alone for touch/desktop users.
  let historyGuarded = false;
  function pushHistorySentinel() {
    if (historyGuarded) return;
    try { history.pushState({ tvNav: true }, ''); historyGuarded = true; }
    catch { /* history unavailable */ }
  }

  function installHistoryGuard() {
    window.addEventListener('popstate', () => {
      historyGuarded = false;
      if (!tvMode) return;
      const v = activeViewEl();
      // At the home screen, allow the navigation through (exit the app).
      if (!v || v.id === 'view-home') return;
      goBack();
      pushHistorySentinel();
    });
  }

  // ─── Focus syncing on view / overlay changes ────────────────────
  let syncTimer = null;
  function syncFocus() {
    if (!tvMode) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      if (inPlayer() && !openOverlay()) { clearHighlight(); return; }
      const scope = currentScope();
      const cur = currentEl();
      // Re-home focus when the highlighted element vanished (view switch,
      // overlay open/close) or drifted outside the active scope.
      if (!cur || !scope.contains(cur)) {
        const overlay = openOverlay();
        const target = overlay
          ? collect(overlay)[0]
          : firstInScope();
        if (target) focusEl(target);
        else clearHighlight();
      }
    }, 90);
  }

  function installObservers() {
    const appEl = document.getElementById('app');
    if (appEl) {
      new MutationObserver(syncFocus).observe(appEl, {
        attributes: true, subtree: true, attributeFilter: ['class'],
      });
    }
    // Modals are appended as direct children of <body>.
    new MutationObserver(syncFocus).observe(document.body, { childList: true });
  }

  // ─── Settings toggle wiring ─────────────────────────────────────
  function wireSettingsToggle() {
    const cb = document.getElementById('setting-tv-mode');
    if (!cb) return;
    cb.checked = tvMode;
    cb.addEventListener('change', () => setTvMode(cb.checked, true));
  }

  // ─── Init ───────────────────────────────────────────────────────
  function init() {
    const stored = readStored();
    if (stored === 'on') tvMode = true;
    else if (stored === 'off') tvMode = false;
    else tvMode = isTvDevice();

    document.documentElement.classList.toggle('tv-mode', tvMode);

    wireSettingsToggle();
    installObservers();
    installHistoryGuard();
    document.addEventListener('keydown', onKeyDown, true);

    if (tvMode) {
      pushHistorySentinel();
      syncFocus();
    }

    window.AlbatrossTV = {
      isEnabled: () => tvMode,
      setEnabled: (on) => setTvMode(on, true),
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
