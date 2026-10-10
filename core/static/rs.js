/* grokbot-desk page core (spec 2.4-2.8, 4.3, 5.2).
 *
 * Load order (shell.html <head>): count.js, rs.js, components.js; then the
 * inline template blocks call RS._define(id, fn). Everything that touches
 * the DOM starts on DOMContentLoaded.
 *
 * window.RS is the page-wide API (components use RS.t / copy / toast /
 * count). Each template gets its own scoped API object as its `RS`
 * parameter; calls from a template that is no longer active are ignored.
 */
(function () {
  'use strict';

  var boot = JSON.parse(document.getElementById('rs-boot').textContent);
  var strings = boot.strings || {};
  var definitions = {};
  var query = new URLSearchParams(location.search);
  // Window-close liveness uses an SSE subscriber id and POST /bye on pagehide.
  var sid = (function () {
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.prototype.map.call(b, function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
  })();
  window.addEventListener('pagehide', function () {
    try {
      fetch('/bye', { method: 'POST', keepalive: true, cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-RS-CSRF': boot.csrf },
        body: JSON.stringify({ sid: sid }) }).catch(function () {});
    } catch (e) { /* page is going away */ }
  });
  /* P8d fix1: the window the CLI launched with --app carries that launch's
     one-time token (?app=); the page presents it on /events and only a
     confirmed page (event window) may close itself after its last decision.
     The token leaves the address at once. P8d fix2: the confirmed window
     keeps the token and this page's sid in window.name, not in
     sessionStorage: a tab opened from the app inherits its sessionStorage
     but starts with an empty name. A reload (a new page, a new sid) presents
     both; the server hands the window on only from a page that is gone.
     Ordinary tabs and windows never close. */
  var APP_NAME = /^rs-app:([0-9a-f]{32}):([0-9a-f]{32})$/;
  var appToken = /^[0-9a-f]{32}$/.test(query.get('app') || '') ? query.get('app') : null;
  var appPrevious = null;
  if (!appToken) {
    var appNamed = APP_NAME.exec(window.name || '');
    if (appNamed) { appToken = appNamed[1]; appPrevious = appNamed[2]; }
  }
  if (query.has('app')) {
    query.delete('app');
    var cleanUrl = new URL(location.href);
    cleanUrl.searchParams.delete('app');
    history.replaceState(history.state, '', cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
  }
  var appWindow = false;
  var THEME_KEY = 'rs-theme';
  var DRAFT_PREFIX = 'rs-draft:';
  var FOCUS_PREFIX = 'rs-focus:';
  var DRAFT_MAX_AGE = 30 * 24 * 3600 * 1000;
  var reloadFocusPending = !!(window.performance && performance.getEntriesByType
    && performance.getEntriesByType('navigation')[0]
    && performance.getEntriesByType('navigation')[0].type === 'reload');

  if (window.RS_COUNT && boot.platforms && boot.platforms.platforms) RS_COUNT.setPlatforms(boot.platforms);

  // ------------------------------------------------------------ theme --
  function storedTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
  }
  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
  }
  function effectiveTheme() {
    var set = document.documentElement.getAttribute('data-theme');
    if (set === 'light' || set === 'dark') return set;
    return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  applyTheme(storedTheme());

  // ---------------------------------------------------------- strings --
  function t(key, params) {
    var value = Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : key;
    return value.replace(/\{([a-z][a-z0-9_]*)\}/g, function (m, name) {
      return params && Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m;
    });
  }

  var T_ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  function fillStrings(root) {
    root.querySelectorAll('[data-rs-t]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-rs-t'));
    });
    // data-rs-t-<attr>="key" fills a localized attribute.
    T_ATTRS.forEach(function (name) {
      root.querySelectorAll('[data-rs-t-' + name + ']').forEach(function (el) {
        el.setAttribute(name, t(el.getAttribute('data-rs-t-' + name)));
      });
    });
    root.querySelectorAll('[data-rs-icon]').forEach(function (el) {
      if (el.querySelector('svg') || !window.RS || !window.RS.icon) return;
      el.insertBefore(window.RS.icon(el.getAttribute('data-rs-icon')), el.firstChild);
    });
  }

  // ------------------------------------------------- locale formats --
  // Dates and numbers follow the selected string table (de default, en):
  // German "15.10." / "99.999", English "Oct 15" / "99,999". Timestamps are
  // always Europe/Vienna (spec 2.9), whatever the machine's time zone:
  // German "Do 08.10.2026 · 10:39", English "Thu, Oct 8, 2026 · 10:39".
  var LOCALE = boot.lang === 'en' ? 'en-US' : 'de-DE';
  var numberFmt = new Intl.NumberFormat(LOCALE);
  var dayFmt = new Intl.DateTimeFormat(LOCALE, boot.lang === 'en'
    ? { month: 'short', day: 'numeric', timeZone: 'UTC' }
    : { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
  var timeFmt = new Intl.DateTimeFormat(LOCALE, boot.lang === 'en'
    ? { timeZone: 'Europe/Vienna', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
    : { timeZone: 'Europe/Vienna', weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  function toDate(iso) {
    if (iso instanceof Date) return iso;
    /* a plain calendar date ("2026-10-15") is the same day everywhere */
    return new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(iso)) ? iso + 'T12:00:00Z' : iso);
  }
  /** Short calendar date: "15.10." (de) / "Oct 15" (en). */
  function date(iso) {
    var d = toDate(iso);
    return isNaN(d.getTime()) ? '' : dayFmt.format(d);
  }
  /** Vienna timestamp: "Do 08.10.2026 · 10:39" (de) / "Thu, Oct 8, 2026 · 10:39" (en). */
  function time(iso) {
    var d = toDate(iso);
    if (isNaN(d.getTime())) return '';
    var p = {};
    timeFmt.formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
    var clock = p.hour + ':' + p.minute;
    if (boot.lang === 'en') return p.weekday + ', ' + p.month + ' ' + p.day + ', ' + p.year + ' ' + t('sep') + ' ' + clock;
    return p.weekday.replace(/\.$/, '') + ' ' + p.day + '.' + p.month + '.' + p.year + ' ' + t('sep') + ' ' + clock;
  }
  function number(n) { return numberFmt.format(n); }

  // ------------------------------------------------------------- http --
  function request(method, path, body) {
    var opts = { method: method, headers: { 'X-RS-CSRF': boot.csrf }, cache: 'no-store' };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        return { status: res.status, ok: res.ok, body: json };
      });
    });
  }
  function post(path, body) { return request('POST', path, body); }

  // ------------------------------------------------------------ state --
  var state = {
    runs: [],          // open run summaries from the server (max 12, newest first)
    known: null,       // run ids seen so far (null until the first list)
    active: null,      // detail of the shown run
    activeId: null,
    result: null,
    touched: false,
    listeners: [],
    status: null,
    submitLabel: null,
    operations: {},    // run id -> { token, kind }; completions clear only their own token
    alternative: null,
    pending: null,     // run id being loaded
    discardTarget: null, // run id the open Verwerfen confirmation is about
    reading: {},       // run id -> true while POST /read is in flight
    hydrated: null,    // key of the decided run the template shows (hydrationKey)
    requestGen: 0,     // activation request order; stale responses are ignored
    templateGen: 0,    // rendered-template lifetime; stale template calls are ignored
    gone: {},          // run id -> true once this page decided it (before SSE says so)
    done: null         // null, 'closing' or 'kept': the calm done state after the last decision
  };
  var el = {};

  // ----------------------------------------------------------- drafts --
  function draftKey(runId) { return DRAFT_PREFIX + runId; }
  function draftRaw(runId) {
    try { return localStorage.getItem(draftKey(runId)); } catch (e) { return null; }
  }
  function draftGet(runId) {
    try {
      var raw = draftRaw(runId);
      if (!raw) return null;
      var v = JSON.parse(raw);
      return v && Object.prototype.hasOwnProperty.call(v, 'value') ? v.value : null;
    } catch (e) { return null; }
  }
  function draftSet(runId, value) {
    try {
      if (value === null || value === undefined) localStorage.removeItem(draftKey(runId));
      else {
        var previous;
        try { previous = JSON.parse(draftRaw(runId) || 'null'); } catch (e) { previous = null; }
        var revision = previous && Number.isSafeInteger(previous.revision) ? previous.revision + 1 : 1;
        localStorage.setItem(draftKey(runId), JSON.stringify({ ts: Date.now(), revision: revision, value: value }));
      }
    } catch (e) { /* storage full or disabled: drafts are best effort */ }
  }
  function clearDraftIfUnchanged(runId, expected) {
    try {
      if (localStorage.getItem(draftKey(runId)) === expected) localStorage.removeItem(draftKey(runId));
    } catch (e) { /* drafts are best effort */ }
  }
  function pruneDrafts() {
    try {
      for (var i = localStorage.length - 1; i >= 0; i--) {
        var k = localStorage.key(i);
        if (!k || k.indexOf(DRAFT_PREFIX) !== 0) continue;
        var v = JSON.parse(localStorage.getItem(k) || '{}');
        if (!v.ts || Date.now() - v.ts > DRAFT_MAX_AGE) localStorage.removeItem(k);
      }
    } catch (e) { /* ignore */ }
  }

  function rememberTemplateFocus(target) {
    if (!state.activeId || !target || !el.mount.contains(target) || !target.id) return;
    var saved = { id: target.id };
    if (typeof target.selectionStart === 'number') {
      saved.start = target.selectionStart;
      saved.end = target.selectionEnd;
      saved.direction = target.selectionDirection;
    }
    try { sessionStorage.setItem(FOCUS_PREFIX + state.activeId, JSON.stringify(saved)); } catch (e) { /* best effort */ }
  }

  function restoreReloadFocus(runId, root) {
    if (!reloadFocusPending || query.get('run') !== runId) return false;
    reloadFocusPending = false;
    var saved;
    try { saved = JSON.parse(sessionStorage.getItem(FOCUS_PREFIX + runId) || 'null'); } catch (e) { return false; }
    if (!saved || typeof saved.id !== 'string') return false;
    var target = document.getElementById(saved.id);
    if (!target || !root.contains(target) || target.disabled) return false;
    target.focus({ preventScroll: true });
    if (typeof target.setSelectionRange === 'function' && typeof saved.start === 'number') {
      var length = typeof target.value === 'string' ? target.value.length : 0;
      target.setSelectionRange(
        Math.min(saved.start, length),
        Math.min(typeof saved.end === 'number' ? saved.end : saved.start, length),
        saved.direction || 'none'
      );
    }
    return true;
  }

  // ----------------------------------------------------------- toasts --
  function toast(text, tone) {
    if (!el.toasts || !text) return;
    var item = document.createElement('div');
    item.className = 'rs-toast';
    if (tone) item.setAttribute('data-tone', tone);
    item.textContent = text;
    el.toasts.appendChild(item);
    while (el.toasts.children.length > 3) el.toasts.firstChild.remove();
    setTimeout(function () { item.remove(); }, 3000);
  }

  // ------------------------------------------------------ core API ----
  function activeRunId() { return state.activeId; }

  function copyFor(runId, text) {
    if (!runId) return Promise.resolve({ ok: false });
    if (state.activeId === runId) markTouched();
    return post('/copy', { run_id: runId, text: String(text) }).then(function (r) {
      if (r.ok) return { ok: true };
      if (r.status === 423) return { ok: false, busy: true };
      return { ok: false, status: r.status };
    }, function () { return { ok: false }; });
  }
  function copy(text) { return copyFor(activeRunId(), text); }

  function revealFor(runId, mediaId) {
    if (!runId) return Promise.resolve({ ok: false });
    return post('/reveal', { run_id: runId, media_id: mediaId }).then(function (r) {
      if (state.activeId === runId) toast(t(r.ok ? 'reveal_done' : 'reveal_failed'));
      return { ok: r.ok };
    }, function () {
      if (state.activeId === runId) toast(t('reveal_failed'));
      return { ok: false };
    });
  }
  function reveal(mediaId) { return revealFor(activeRunId(), mediaId); }

  function media(id) { return '/media/' + encodeURIComponent(id); }

  function count(text, platform) { return window.RS_COUNT.count(text, platform); }

  // -------------------------------------------------------- fold fade --
  /* While the report's content continues below the fold, the mount carries
     data-rs-more and shell.css fades the last lines above the submit bar
     (or the window edge in a read-only view) into the paper, so a
     half-visible line never reads as cut. Gone when it fits or at the end;
     the mount's own bottom padding alone never counts. */
  var fold = { observer: null, root: null };
  function updateFold() {
    var m = el.mount;
    var last = m.lastElementChild;
    var more = !!last && last.getBoundingClientRect().bottom - m.getBoundingClientRect().bottom > 1;
    if (more !== m.hasAttribute('data-rs-more')) m.toggleAttribute('data-rs-more', more);
  }
  /* A resize (an opened disclosure, the window) can switch the fade on over
     keyboard focus that is already held: scroll its ring clear by the same
     scroll-padding the browser uses for new focus. Focus does not move; user
     scrolling (the scroll listener) is never corrected. */
  function keepFocusClear() {
    var m = el.mount;
    var a = document.activeElement;
    if (!m.hasAttribute('data-rs-more') || !a || a === m || !m.contains(a) || !a.matches(':focus-visible')) return;
    var top = m.getBoundingClientRect().top + m.clientTop;
    var bottom = top + m.clientHeight;
    var clear = bottom - (parseFloat(getComputedStyle(m).scrollPaddingBottom) || 0);
    var r = a.getBoundingClientRect();
    if (r.bottom <= clear || r.top >= bottom) return;
    /* never past the top: an element taller than the view keeps its start */
    var ring = (parseFloat(getComputedStyle(a).outlineWidth) || 0) + (parseFloat(getComputedStyle(a).outlineOffset) || 0);
    var by = Math.min(r.bottom - clear, r.top - ring - top);
    if (by > 0) m.scrollTo({ top: m.scrollTop + by, behavior: 'instant' });
  }
  function onFoldResize() {
    updateFold();
    keepFocusClear();
  }
  function watchFold(root) {
    if (fold.observer) {
      if (fold.root) fold.observer.unobserve(fold.root);
      if (root) fold.observer.observe(root);
    }
    fold.root = root;
    updateFold();
  }

  // ------------------------------------------------------------ title --
  function anyUnread() {
    return state.runs.some(function (r) { return r.unread; });
  }
  function updateTitle() {
    var a = state.active;
    var open = state.runs.length > 0;
    var title;
    if (a && (a.state === 'open' || open)) title = t('window_title', { title: a.title, bot: a.bot_display });
    else title = t('window_title_empty');
    document.title = (anyUnread() ? t('unread_prefix') : '') + title;
    reportTitle(document.title);
  }

  // the server finds/flashes the browser window by its title (POST /title)
  var reportedTitle = null;
  function reportTitle(value) {
    var title = Array.from(value).slice(0, 300).join('');
    if (!title || title === reportedTitle) return;
    reportedTitle = title;
    post('/title', { title: title }).then(function (r) {
      if (!r.ok && reportedTitle === title) reportedTitle = null;
    }, function () { if (reportedTitle === title) reportedTitle = null; });
  }

  // ------------------------------------------------------------- read --
  function maybeMarkRead() {
    var a = state.active;
    if (!a || a.state !== 'open') return;
    var summary = findRun(a.run_id);
    if (!summary || !summary.unread) return;
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    var id = a.run_id;
    if (state.reading[id]) return;
    state.reading[id] = true;
    // unread is cleared only once the server acknowledged; otherwise the
    // next focus/pointer/key event retries
    post('/read', { run_id: id }).then(function (r) {
      delete state.reading[id];
      if (!r.ok) return;
      var s = findRun(id);
      if (s) s.unread = false;
      renderStrip();
      updateTitle();
    }, function () { delete state.reading[id]; });
  }

  function findRun(id) {
    for (var i = 0; i < state.runs.length; i++) if (state.runs[i].run_id === id) return state.runs[i];
    return null;
  }

  // --------------------------------------------------------- identity --
  // Each run carries its bot's name, avatar URL (same origin, or null for
  // initials) and, for the shown run only, accent tokens per theme. The shown
  // run sets the one accent; strip entries never carry one (C16/K1).
  // P8c: a run may also name a shape and colour. The page draws the shape from
  // the core set in boot.avatar_shapes (path data only, never bot SVG); the
  // eyes are holes. Precedence: image > shape > initials.
  var HEX = /^#[0-9a-f]{6}$/;
  var ACCENT_TOKENS = ['--rs-accent', '--rs-accent-hover', '--rs-on-accent', '--rs-focus'];
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var SHAPES = boot.avatar_shapes || { shapes: {}, colors: [] };
  var accentStyle = null;

  function known(table, name) {
    return typeof name === 'string' && Object.prototype.hasOwnProperty.call(table, name) ? name : null;
  }

  function identityOf(run) {
    var id = (run && run.identity) || {};
    return {
      name: typeof id.name === 'string' && id.name ? id.name : (run && run.bot_display) || '',
      initials: typeof id.initials === 'string' ? id.initials : '',
      avatar: typeof id.avatar === 'string' && /^\/avatar\/[0-9a-f]{64}$/.test(id.avatar) ? id.avatar : null,
      shape: known(SHAPES.shapes, id.shape),
      color: SHAPES.colors.indexOf(id.color) >= 0 ? id.color : null
    };
  }

  function shapeSvg(shape) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', SHAPES.view_box);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('data-rs-shape', shape);
    var path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('fill-rule', SHAPES.fill_rule);
    path.setAttribute('d', SHAPES.shapes[shape]);
    svg.appendChild(path);
    return svg;
  }

  /* image avatar; else the bot's shape; else initials (also when the image
     fails to load) */
  function fillAvatar(box, who) {
    function fallback() {
      box.textContent = '';
      if (who.shape) {
        box.setAttribute('data-shape', who.shape);
        box.setAttribute('data-color', who.color || 'default');
        box.appendChild(shapeSvg(who.shape));
        return;
      }
      box.setAttribute('data-initials', who.initials);
    }
    box.textContent = '';
    box.removeAttribute('data-initials');
    box.removeAttribute('data-shape');
    box.removeAttribute('data-color');
    if (!who.avatar) { fallback(); return; }
    var img = document.createElement('img');
    img.alt = '';
    /* a late error of a replaced image must not repaint the reused header box */
    img.addEventListener('error', function () { if (img.parentNode === box) fallback(); });
    img.src = who.avatar;
    box.appendChild(img);
  }

  function avatarBox(who, size) {
    var box = document.createElement('span');
    box.className = 'rs-avatar' + (size ? ' rs-avatar--' + size : '');
    box.setAttribute('data-rs-avatar', '');
    box.setAttribute('aria-hidden', 'true');
    fillAvatar(box, who);
    return box;
  }

  /* "Erstellt Do 08.10.2026 · 10:39": German uses the server's display (Vienna) */
  function createdText(run) {
    return t('created_at', { time: boot.lang === 'en' || !run.created_display ? time(run.created) : run.created_display });
  }

  function accentRule(selector, tokens) {
    var parts = [];
    for (var i = 0; i < ACCENT_TOKENS.length; i++) {
      var value = tokens && tokens[ACCENT_TOKENS[i]];
      if (typeof value !== 'string' || !HEX.test(value)) return null;
      parts.push(ACCENT_TOKENS[i] + ': ' + value + ';');
    }
    return selector + ' { ' + parts.join(' ') + ' }';
  }

  /* the shown report's accent per theme (the server already fell back to the
     default accent where a theme failed its contrast checks) */
  function applyAccent(run) {
    var accent = run && run.identity && run.identity.accent;
    var light = accent && accentRule('html[data-rs-accent]', accent.light);
    var darkOs = accent && accentRule('html[data-rs-accent]:not([data-theme="light"])', accent.dark);
    var dark = accent && accentRule('html[data-rs-accent][data-theme="dark"]', accent.dark);
    if (!light || !dark) {
      if (accentStyle) accentStyle.textContent = '';
      document.documentElement.removeAttribute('data-rs-accent');
      return;
    }
    if (!accentStyle) {
      accentStyle = document.createElement('style');
      accentStyle.setAttribute('data-rs-accent', '');
      document.head.appendChild(accentStyle);
    }
    accentStyle.textContent = [light, '@media (prefers-color-scheme: dark) { ' + darkOs + ' }', dark].join('\n');
    document.documentElement.setAttribute('data-rs-accent', '');
  }

  /* P8d header: the avatar, the bot's name in bold and, as the one quiet
     line below it, the report title (the page's h1); a decided report says
     so in its result banner, times stay in the "…" menu (K11) */
  function renderBot(run) {
    applyAccent(run);
    if (!run) {
      el.bot.hidden = true;
      el.botName.textContent = '';
      return;
    }
    var who = identityOf(run);
    el.botName.textContent = who.name;
    fillAvatar(el.botAvatar, who);
    el.bot.hidden = false;
  }

  // ------------------------------------------------------------ strip --
  /* P8d: the window is a pop-up for one decision at a time. With 2+ open
     reports a slim strip above the header shows each one's avatar with its
     waiting dot (filled while new, a ring once seen), the active one
     underlined, and "n of m open". It is one Tab stop (roving tabindex):
     Left/Right/Home/End switch along it, Ctrl+1..9 from anywhere. Decided
     reports leave the strip; with one open report there is none (K3). */
  function openRuns() {
    return state.runs.filter(function (r) {
      return (r.state === undefined || r.state === 'open') && !state.gone[r.run_id];
    });
  }

  function stripRuns() { return openRuns().slice(0, 12); }

  function stripButtons() {
    return Array.prototype.slice.call(el.strip.querySelectorAll('.rs-strip__run'));
  }

  function focusStrip(runId) {
    var b = stripButtons().filter(function (x) { return x.getAttribute('data-run-id') === runId; })[0]
      || el.strip.querySelector('.rs-strip__run[tabindex="0"]');
    if (b && !el.stripNav.hidden) b.focus();
  }

  function renderStrip() {
    var list = stripRuns();
    var held = el.strip.contains(document.activeElement) ? document.activeElement.getAttribute('data-run-id') : null;
    var at = -1;
    list.forEach(function (run, i) { if (run.run_id === state.activeId) at = i; });
    el.strip.textContent = '';
    list.forEach(function (run, i) {
      var current = i === at;
      var who = identityOf(run);
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'rs-strip__run';
      b.setAttribute('data-run-id', run.run_id);
      /* accessible name and tooltip: the bot and the report title */
      var label = t('strip_item', { bot: who.name, title: run.title });
      if (run.unread && !current) label += ' ' + t('sep') + ' ' + t('new');
      b.setAttribute('aria-label', label);
      b.title = label;
      if (current) b.setAttribute('aria-current', 'page');
      b.tabIndex = i === Math.max(at, 0) ? 0 : -1;
      if (i < 9) b.setAttribute('aria-keyshortcuts', 'Control+' + (i + 1));
      b.appendChild(avatarBox(who, 'md'));
      var dot = document.createElement('span');
      dot.className = 'rs-strip__dot';
      if (run.unread && !current) dot.setAttribute('data-new', '');
      b.appendChild(dot);
      b.addEventListener('click', function () {
        if (run.run_id !== state.activeId) activate(run.run_id, { focusStrip: true });
      });
      el.strip.appendChild(b);
    });
    el.stripCount.textContent = at >= 0
      ? t('strip_count', { n: at + 1, m: list.length })
      : t('strip_count_all', { m: list.length });
    var on = list.length >= 2;
    el.stripNav.hidden = !on;
    el.app.setAttribute('data-strip', on ? 'on' : 'off');
    if (held) focusStrip(held);
  }

  function onStripKey(e) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    var buttons = stripButtons();
    var i = buttons.indexOf(document.activeElement);
    var n = buttons.length;
    if (i < 0 || !n) return;
    var j;
    if (e.key === 'ArrowRight') j = (i + 1) % n;
    else if (e.key === 'ArrowLeft') j = (i - 1 + n) % n;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = n - 1;
    else return;
    e.preventDefault();
    var target = buttons[j];
    buttons.forEach(function (b) { b.tabIndex = b === target ? 0 : -1; });
    target.focus();
    var id = target.getAttribute('data-run-id');
    if (id !== state.activeId) activate(id, { focusStrip: true });
  }

  // ----------------------------------------------------- submit bar --
  function activeBusy() {
    return !!(state.activeId && state.operations[state.activeId]);
  }

  function decisionRoot() {
    return el.mount.querySelector('.rs-tpl');
  }

  function decisionControlKey(control) {
    if (control.id) return 'id:' + control.id;
    var item = control.closest('rs-action-row[data-item]');
    if (item) {
      return 'item:' + item.getAttribute('data-item')
        + (control === item ? '' : ':button:' + (control.value || ''));
    }
    var spp = control.getAttribute('data-spp');
    var platform = control.closest('[data-platform]');
    if (spp && platform) return 'platform:' + platform.getAttribute('data-platform') + ':' + spp;
    if (control.name) return 'name:' + control.name + ':' + (control.type || '') + ':' + (control.value || '');
    return null;
  }

  function captureDecisionState(root) {
    if (!root) return [];
    return Array.prototype.map.call(
      root.querySelectorAll('rs-action-row, input, textarea, select, button'),
      function (control, index) {
        return {
          control: control,
          index: index,
          key: decisionControlKey(control),
          tag: control.tagName,
          type: control.type || '',
          value: 'value' in control ? control.value : null,
          checked: 'checked' in control ? control.checked : null,
          disabled: 'disabled' in control ? control.disabled : null,
          readOnly: 'readOnly' in control ? control.readOnly : null
        };
      }
    );
  }

  function restoreDecisionState(root, snapshot) {
    if (!root || !snapshot) return;
    var controls = root.querySelectorAll('rs-action-row, input, textarea, select, button');
    snapshot.forEach(function (saved) {
      var control = saved.control && root.contains(saved.control) ? saved.control : null;
      if (!control && saved.key) {
        control = Array.prototype.find.call(controls, function (candidate) {
          return decisionControlKey(candidate) === saved.key;
        });
      }
      if (!control) control = controls[saved.index];
      if (!control || control.tagName !== saved.tag || (control.type || '') !== saved.type) return;
      var blocked = control.hasAttribute('data-rs-blocked');
      if (saved.value !== null && 'value' in control) control.value = saved.value;
      if (saved.checked !== null && 'checked' in control) control.checked = blocked ? false : saved.checked;
      if (saved.readOnly !== null && 'readOnly' in control) control.readOnly = saved.readOnly;
      if (saved.disabled !== null && 'disabled' in control) control.disabled = blocked || saved.disabled;
    });
  }

  function lockDecisionControls(root, allowTemplateNavigation) {
    root.querySelectorAll('rs-action-row').forEach(function (row) { row.setAttribute('disabled', ''); });
    root.querySelectorAll('textarea').forEach(function (input) { input.readOnly = true; });
    root.querySelectorAll('input').forEach(function (input) {
      var type = (input.type || 'text').toLowerCase();
      if (type === 'hidden') return;
      if (/^(text|search|tel|url|email|password|date|month|week|time|datetime-local|number)$/.test(type)) {
        input.readOnly = true;
      } else {
        input.disabled = true;
      }
    });
    root.querySelectorAll('select').forEach(function (input) { input.disabled = true; });
    root.querySelectorAll('button').forEach(function (button) {
      var navigation = allowTemplateNavigation && button.matches('[role="tab"], [aria-expanded]');
      /* copies and view-only actions (e.g. reloading an image) never change the decision */
      if (!button.closest('rs-copy') && !button.hasAttribute('data-rs-view-action') && !navigation) {
        button.disabled = true;
      }
    });
  }

  function applyPendingLock(root) {
    if (!root) return;
    root.setAttribute('data-rs-pending', '');
    lockDecisionControls(root, false);
  }

  function renderPendingOperation(runId, root) {
    var operation = state.operations[runId];
    if (!operation) return;
    restoreDecisionState(root, operation.snapshot);
    applyPendingLock(root);
    if (operation.observer) operation.observer.disconnect();
    operation.observer = new MutationObserver(function () { applyPendingLock(root); });
    operation.observer.observe(root, { childList: true, subtree: true });
  }

  function beginOperation(runId, kind) {
    if (state.operations[runId]) return null;
    var token = {};
    var operation = {
      token: token,
      kind: kind,
      snapshot: captureDecisionState(state.activeId === runId ? decisionRoot() : null),
      draft: draftRaw(runId)
    };
    state.operations[runId] = operation;
    if (state.activeId === runId) {
      renderPendingOperation(runId, decisionRoot());
      renderBar();
    }
    return token;
  }

  function finishOperation(runId, token) {
    var operation = state.operations[runId];
    if (!operation || operation.token !== token) return null;
    delete state.operations[runId];
    if (operation.observer) operation.observer.disconnect();
    if (state.activeId === runId) {
      var root = decisionRoot();
      restoreDecisionState(root, operation.snapshot);
      if (root) root.removeAttribute('data-rs-pending');
      if (root && root.hasAttribute('data-rs-locked')) applyLock(root);
      renderBar();
    }
    return operation;
  }

  function renderBar() {
    var a = state.active;
    var open = !!(a && a.state === 'open');
    var busy = activeBusy();
    el.submit.disabled = !open || state.result === null || busy;
    el.discard.disabled = !open || busy;
    el.submitLabel.textContent = state.submitLabel || t('submit');
    /* the alternative button exists only while a template offers one */
    var alt = state.alternative;
    if (open && alt) {
      el.alt.textContent = alt.label;
      el.alt.hidden = false;
      if (!el.alt.isConnected) el.submit.parentNode.insertBefore(el.alt, el.submit);
    } else if (el.alt.isConnected) {
      el.alt.remove();
    }
    el.alt.disabled = busy;
    var s = state.status;
    el.status.textContent = s ? s.text : '';
    if (s && s.tone) el.status.setAttribute('data-tone', s.tone); else el.status.removeAttribute('data-tone');
    el.bar.hidden = !open;
  }

  function setBanner(kind) {
    var mount = el.mount;
    var old = mount.querySelector(':scope > .rs-banner');
    var held = !!old && old.contains(document.activeElement);
    if (old) old.remove();
    if (!kind) return null;
    var b = document.createElement('div');
    b.className = 'rs-banner';
    b.setAttribute('data-banner', kind);
    b.setAttribute('role', 'status');
    b.tabIndex = -1;
    var text = document.createElement('span');
    if (kind === 'submitted') { b.setAttribute('data-tone', 'ok'); text.textContent = t('sent'); }
    else if (kind === 'expired') { b.setAttribute('data-tone', 'warn'); text.textContent = t('run_expired_msg'); }
    else if (kind === 'cancelled') { text.textContent = t('run_cancelled_msg'); }
    b.appendChild(text);
    var next = openRuns().filter(function (r) { return r.run_id !== state.activeId; })[0];
    if (next) {
      var go = document.createElement('button');
      go.type = 'button';
      go.className = 'rs-btn rs-banner__next';
      go.textContent = t('next_report', { title: next.title });
      go.addEventListener('click', function () { activate(next.run_id, { focusTitle: true }); });
      b.appendChild(go);
    } else if (state.done) {
      doneParts(b);
    }
    mount.insertBefore(b, mount.firstChild);
    /* a rebuilt banner (the next SSE list) keeps the keyboard on the result */
    if (held) b.focus();
    return b;
  }

  // ------------------------------------------------ after a decision --
  /* P8d: after the person's own decision (send or discard) the pop-up moves
     on to the next open report. After the last one it shows a calm done
     state in the result banner; the app window the server launched (see
     appWindow) then closes after a moment; "Keep open", a new report or a
     switch stop that. Any other tab or window just shows "All done.".
     Closing fires pagehide, so POST /bye tells the server at once. A test
     client (?client=test) closes only with ?autoclose=1. */
  var DONE_CLOSE_MS = 4000;
  var closeTimer = null;

  /* a test client shows the closing state but closes only with ?autoclose=1 */
  function mayClose() {
    if (query.get('client') === 'test') return query.get('autoclose') === '1';
    return appWindow;
  }

  /* The strip order after a report (then wrapping), captured when its
     decision starts: the server's list drops the report before our own
     answer may arrive, so the order is not read again afterwards. */
  function successorsOf(runId) {
    var ids = openRuns().map(function (r) { return r.run_id; });
    var at = ids.indexOf(runId);
    return at < 0 ? ids : ids.slice(at + 1).concat(ids.slice(0, at));
  }

  /* the intended successor if it is still open, else the next of the
     captured order, else any open report (one that arrived meanwhile) */
  function nextOpenAfter(runId, successors) {
    var rest = openRuns().filter(function (r) { return r.run_id !== runId; });
    if (!rest.length) return null;
    var open = {};
    rest.forEach(function (r) { open[r.run_id] = true; });
    var next = (successors || []).filter(function (id) { return open[id]; })[0];
    return next || rest[0].run_id;
  }

  function afterDecision(runId, successors) {
    state.gone[runId] = true;
    if (!state.active || state.active.run_id !== runId) return;
    var next = nextOpenAfter(runId, successors);
    if (next) { activate(next, { focusTitle: true }); return; }
    state.done = appWindow || query.get('client') === 'test' ? 'closing' : 'kept';
    document.documentElement.setAttribute('data-rs-done', '1');
    var banner = setBanner(state.active.state);
    if (banner) banner.focus();
    renderStrip();
    if (state.done === 'closing' && mayClose()) scheduleClose();
  }

  function doneParts(banner) {
    banner.setAttribute('data-done', '');
    var text = document.createElement('span');
    text.setAttribute('data-rs-done-text', '');
    text.textContent = state.done === 'closing' ? t('done_title') + ' ' + t('done_closing') : t('done_title');
    banner.appendChild(text);
    if (state.done !== 'closing') return;
    var keep = document.createElement('button');
    keep.type = 'button';
    keep.className = 'rs-btn rs-btn--quiet rs-banner__keep';
    keep.textContent = t('done_keep_open');
    keep.addEventListener('click', function () {
      cancelClose();
      state.done = 'kept';
      var b = setBanner(state.active ? state.active.state : null);
      if (b) b.focus();
    });
    banner.appendChild(keep);
  }

  function scheduleClose() {
    cancelClose();
    var test = query.get('client') === 'test';
    var ms = test && /^\d{1,5}$/.test(query.get('close_ms') || '') ? Number(query.get('close_ms')) : DONE_CLOSE_MS;
    closeTimer = setTimeout(function () {
      closeTimer = null;
      if (state.done !== 'closing') return;
      /* never while a report loads, a decision is in flight or one is open */
      if (state.pending || Object.keys(state.operations).length || openRuns().length) {
        state.done = 'kept';
        if (state.active && state.active.state !== 'open') setBanner(state.active.state);
        return;
      }
      window.close();
    }, ms);
  }

  function cancelClose() {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = null;
  }

  function clearDone() {
    cancelClose();
    state.done = null;
    document.documentElement.removeAttribute('data-rs-done');
  }

  /* A decided report stays readable: decisions and text become read-only,
     while copies, tabs, disclosures and item rows (aria-expanded) keep
     working. The lock is re-applied to content the template mounts later. */
  function applyLock(root) {
    lockDecisionControls(root, true);
  }

  /* A template focused a control that the lock then disabled (e.g. the
     choice of a lazily mounted item): focus the item's opener instead of
     leaving it on <body>, else the result banner. */
  function rescueFocus(root, lost) {
    var item = lost.closest('[data-rs-item]');
    var target = item && Array.prototype.find.call(
      item.querySelectorAll('[aria-expanded], [role="tab"]'),
      function (candidate) {
        return !candidate.disabled && root.contains(candidate) && candidate.getClientRects().length > 0;
      }
    );
    if (!target) target = el.mount.querySelector(':scope > .rs-banner');
    if (target) target.focus();
  }

  function lockTemplate() {
    var root = el.mount.querySelector('.rs-tpl');
    if (!root || root.hasAttribute('data-rs-locked')) return;
    root.setAttribute('data-rs-locked', '');
    applyLock(root);
    new MutationObserver(function () {
      var focused = document.activeElement;
      var wasEnabled = !!(focused && root.contains(focused) && !focused.disabled);
      applyLock(root);
      if (wasEnabled && focused.disabled) rescueFocus(root, focused);
    }).observe(root, { childList: true, subtree: true });
  }

  function showDecided(kind) {
    if (!state.active) return;
    var operation = state.operations[state.active.run_id];
    if (operation) restoreDecisionState(decisionRoot(), operation.snapshot);
    state.active.state = kind;
    closeDiscardFor(state.active.run_id);
    setBanner(kind);
    lockTemplate();
    renderBar();
    renderStrip();
    updateTitle();
    focusResult();
  }

  /* keyboard users land on the way forward, or on the announced result */
  function focusResult() {
    var banner = el.mount.querySelector(':scope > .rs-banner');
    var next = banner && banner.querySelector('.rs-banner__next');
    if (next) next.focus();
    else if (banner) banner.focus();
  }

  // ------------------------------------------------------- touched --
  function markTouched() { state.touched = true; }

  function notifyChange(ev) {
    markTouched();
    state.listeners.forEach(function (fn) {
      try { fn(ev); } catch (e) { console.error(e); }
    });
  }

  // ------------------------------------------------------ activate --
  function setReady(on) {
    if (on) document.documentElement.dataset.rsReady = '1';
    else delete document.documentElement.dataset.rsReady;
  }

  function scopedApi(run, templateGen) {
    function live() { return templateGen === state.templateGen; }
    return {
      data: run.data,
      run: {
        run_id: run.run_id, template: run.template, title: run.title, bot: run.bot,
        bot_display: run.bot_display, created: run.created, created_display: run.created_display,
        expires: run.expires, state: run.state,
        /* the immutable result of a submitted report (read-only view) */
        result: run.result === undefined ? null : run.result
      },
      t: t,
      time: time,
      date: date,
      number: number,
      count: count,
      copy: function (text) {
        return live() ? copyFor(run.run_id, text) : Promise.resolve({ ok: false, stale: true });
      },
      toast: function (text, tone) { if (live()) toast(text, tone); },
      media: media,
      reveal: function (mediaId) {
        return live() ? revealFor(run.run_id, mediaId) : Promise.resolve({ ok: false, stale: true });
      },
      setResult: function (value) {
        if (!live()) return;
        state.result = value === undefined ? null : value;
        renderBar();
      },
      onChange: function (fn) {
        if (!live() || typeof fn !== 'function') return function () {};
        state.listeners.push(fn);
        return function () { state.listeners = state.listeners.filter(function (x) { return x !== fn; }); };
      },
      draft: {
        get: function () { return draftGet(run.run_id); },
        set: function (value) { if (live()) draftSet(run.run_id, value); },
        clear: function () { if (live()) draftSet(run.run_id, null); }
      },
      setStatus: function (text, tone) {
        if (!live()) return;
        state.status = text ? { text: String(text), tone: tone || null } : null;
        renderBar();
      },
      setSubmitLabel: function (text) {
        if (!live()) return;
        state.submitLabel = text ? String(text) : null;
        renderBar();
      },
      /* One quiet alternative next to the primary (e.g. "Request changes"); null removes it. */
      setAlternative: function (label, onClick) {
        if (!live()) return;
        state.alternative = label ? { label: String(label), run: onClick } : null;
        renderBar();
      },
      /* Move focus to the footer alternative (e.g. after leaving a sub-mode). */
      focusAlternative: function () {
        if (!live() || !el.alt.isConnected || el.alt.hidden) return false;
        el.alt.focus();
        return true;
      },
      /* A quiet metadata line in the header overflow panel (not an action). */
      addMenuMeta: function (text) {
        if (!live() || !text) return;
        var line = document.createElement('span');
        line.textContent = String(text);
        el.meta.appendChild(line);
      },
      /* An extra entry in the header overflow panel (e.g. "Show in folder"). */
      addMenuItem: function (label, onClick) {
        if (!live()) return;
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'rs-more__item';
        b.textContent = String(label);
        b.addEventListener('click', function () { closeMore(); onClick(); });
        el.moreExtra.appendChild(b);
      },
      icon: function (name) { return window.RS.icon ? window.RS.icon(name) : document.createElement('span'); },
      submit: function () { return live() ? submit(run.run_id) : Promise.resolve(false); }
    };
  }

  /* A decided run detail is immutable: the same key means the same view. */
  function hydrationKey(run) {
    return JSON.stringify([run.run_id, run.state, run.result === undefined ? null : run.result]);
  }

  /** Renders a fetched run detail: template, banner/lock, bar, strip, title. */
  function mountRun(run, opts) {
    clearDone();
    state.templateGen += 1;
    var templateGen = state.templateGen;
    state.hydrated = run.state === 'open' ? null : hydrationKey(run);
    state.active = run;
    state.activeId = run.run_id;
    state.result = null;
    state.listeners = [];
    state.status = null;
    state.submitLabel = null;
    state.touched = draftGet(run.run_id) !== null;
    var nextUrl = new URL(location.href);
    nextUrl.searchParams.set('run', run.run_id);
    history.replaceState(history.state, '', nextUrl.pathname + nextUrl.search + nextUrl.hash);
    query.set('run', run.run_id);
    state.alternative = null;
    el.moreExtra.textContent = '';
    closeMore();

    el.title.textContent = run.title;
    renderBot(run);
    el.meta.textContent = '';
    var bot = document.createElement('span');
    var created = document.createElement('span');
    bot.className = 'rs-more__bot';
    bot.appendChild(avatarBox(identityOf(run)));
    bot.appendChild(document.createTextNode(t('from_bot', { bot: run.bot_display })));
    created.textContent = createdText(run);
    el.meta.appendChild(bot);
    el.meta.appendChild(created);

    el.mount.textContent = '';
    el.mount.scrollTop = 0;
    var root = document.createElement('div');
    root.className = 'rs-tpl';
    root.setAttribute('data-rs-template', run.template);
    var tpl = document.getElementById('rs-tpl-' + run.template);
    if (tpl) root.appendChild(tpl.content.cloneNode(true));
    fillStrings(root);
    el.mount.appendChild(root);
    var def = definitions[run.template];
    if (def) {
      try { def(scopedApi(run, templateGen), root); } catch (e) { console.error(e); toast(t('template_error')); }
    }
    if (run.state === 'open') renderPendingOperation(run.run_id, root);
    if (run.state === 'open') restoreReloadFocus(run.run_id, root);
    if (run.state !== 'open') { setBanner(run.state); lockTemplate(); }
    /* a restored draft that is ready to send: focus the primary (the
       template already focused its own target when work is left) */
    else if (state.touched && document.activeElement === document.body && !el.submit.disabled) el.submit.focus();
    renderBar();
    renderStrip();
    updateTitle();
    maybeMarkRead();
    // the window may get focus a moment after the run renders
    setTimeout(maybeMarkRead, 300);
    if (opts.focusStrip) focusStrip(run.run_id);
    else if (opts.focusTitle) el.title.focus();
    else if (opts.focusResult) focusResult();
    watchFold(root);
    setReady(true);
  }

  function activate(runId, opts) {
    opts = opts || {};
    if (!runId) return Promise.resolve();
    state.requestGen += 1;
    var requestGen = state.requestGen;
    /* an accepted arrival or switch ends the done state at once, not only
       once its detail has loaded (the close must not fire meanwhile) */
    var wasDone = !!state.done;
    clearDone();
    state.pending = runId;
    setReady(false);
    function keepShown() {
      if (wasDone && state.active && state.active.state !== 'open') setBanner(state.active.state);
    }
    return request('GET', '/api/run/' + encodeURIComponent(runId)).then(function (r) {
      if (requestGen !== state.requestGen) return;
      state.pending = null;
      if (!r.ok) {
        if (opts.fallback && opts.fallback !== runId) { activate(opts.fallback); return; }
        keepShown();
        if (state.active) setReady(true); else showEmpty();
        toast(t('run_load_failed'));
        return;
      }
      var run = r.body;
      mountRun(run, opts);
    }, function () {
      if (requestGen === state.requestGen) {
        state.pending = null;
        keepShown();
        setReady(true);
        toast(t('run_load_failed'));
      }
    });
  }

  function showEmpty() {
    clearDone();
    state.requestGen += 1;
    state.templateGen += 1;
    state.hydrated = null;
    state.pending = null;
    state.active = null;
    state.activeId = null;
    state.result = null;
    state.touched = false;
    state.listeners = [];
    el.title.textContent = '';
    renderBot(null);
    el.meta.textContent = '';
    el.mount.textContent = '';
    var p = document.createElement('p');
    p.className = 'rs-empty';
    p.textContent = t('no_runs');
    el.mount.appendChild(p);
    watchFold(null);
    renderBar();
    renderStrip();
    updateTitle();
    setReady(true);
  }

  // ----------------------------------------------------- run list ----
  function applyRuns(runs) {
    var first = state.known === null;
    var known = state.known || {};
    var fresh = runs.filter(function (r) { return !known[r.run_id]; });
    state.runs = runs;
    state.known = {};
    runs.forEach(function (r) { state.known[r.run_id] = true; });
    Object.keys(known).forEach(function (id) { state.known[id] = true; });

    var a = state.active;
    if (a && a.state === 'open' && !findRun(a.run_id)) {
      // decided elsewhere (CLI cancel, expiry): fetch its state
      refreshActiveState();
    }
    if (first) {
      // ?run=<id> selects that run (also a decided one); else the newest open run
      var wanted = query.get('run');
      var newestId = runs[0] ? runs[0].run_id : null;
      if (wanted || newestId) {
        renderStrip();
        updateTitle();
        activate(wanted || newestId, { fallback: wanted ? newestId : null });
        return;
      }
      showEmpty();
      return;
    }
    // switching rule (spec 2.8): a new run becomes active only when no run is
    // active (or the active one is decided) or the active run is untouched.
    var newest = fresh[0];
    if (newest) {
      // an open Verwerfen confirmation pins the active run
      var idle = !a || a.state !== 'open' || (!state.touched && !state.discardTarget);
      if (idle) { activate(newest.run_id); return; }
      toast(t('new_run_arrived', { title: newest.title }));
    }
    if (!a && !state.pending && !runs.length) { showEmpty(); return; }
    if (a && a.state !== 'open') setBanner(a.state);
    renderStrip();
    updateTitle();
  }

  function refreshActiveState() {
    var a = state.active;
    if (!a) return;
    var id = a.run_id;
    request('GET', '/api/run/' + encodeURIComponent(id)).then(function (r) {
      if (!r.ok || !state.active || state.active.run_id !== id || r.body.state === 'open') return;
      if (state.pending && state.pending !== id) return;
      if (r.body.state === 'submitted' && !state.operations[id]) {
        /* one decision is announced twice (SSE runs + run), so a second
           identical answer arrives while the user already reads the sent
           result: keep their view (open item, tab, focus) */
        if (hydrationKey(r.body) === state.hydrated) return;
        /* our own accepted send is the authoritative result: the view (and
           a done state after it) stays */
        if (state.gone[id]) return;
        /* decided by another client: show the authoritative result, not the
           local (possibly different) draft */
        closeDiscardFor(id);
        mountRun(r.body, { focusResult: true });
      } else if (state.active.state !== r.body.state) {
        showDecided(r.body.state);
      }
    });
  }

  function loadRuns() {
    return request('GET', '/api/runs').then(function (r) {
      if (r.ok) applyRuns(r.body.runs || []);
    });
  }

  // ------------------------------------------------- submit/discard --
  function submit(ownedRunId) {
    var a = state.active;
    if (!a || a.state !== 'open' || (ownedRunId && a.run_id !== ownedRunId)) return Promise.resolve(false);
    var id = a.run_id;
    if (state.operations[id]) return Promise.resolve(false);
    if (state.result === null) { toast(t('submit_not_ready')); return Promise.resolve(false); }
    var data = state.result;
    var successors = successorsOf(id);
    var token = beginOperation(id, 'submit');
    return post('/submit', { run_id: id, data: data }).then(function (r) {
      var operation = finishOperation(id, token);
      if (r.ok) {
        if (operation) clearDraftIfUnchanged(id, operation.draft);
        if (state.active && state.active.run_id === id) showDecided('submitted');
        if (state.activeId === id) toast(t('sent'));
        afterDecision(id, successors);
        return true;
      }
      if (r.status === 409) {
        if (state.activeId === id) refreshActiveState();
        return false;
      }
      if (state.activeId === id) toast(t('submit_failed'));
      if (r.body && r.body.pointer) console.warn('submit rejected at ' + r.body.pointer + ': ' + r.body.error);
      return false;
    }, function () {
      finishOperation(id, token);
      if (state.activeId === id) toast(t('submit_failed'));
      return false;
    });
  }

  function discard() {
    var a = state.active;
    if (!a || a.state !== 'open' || activeBusy()) return;
    closeMore();
    var dlg = el.discardDialog;
    state.discardTarget = a.run_id;
    dlg.returnValue = '';
    dlg.showModal();
    dlg.querySelector('button[value="cancel"]').focus();
  }

  /** The confirmation's target was decided elsewhere or expired: dismiss it. */
  function closeDiscardFor(runId) {
    if (state.discardTarget !== runId) return;
    state.discardTarget = null;
    if (el.discardDialog.open) el.discardDialog.close('');
  }

  function onDiscardClose() {
    if (el.discardDialog.open) return;
    var id = state.discardTarget;
    state.discardTarget = null;
    var a = state.active;
    if (el.discardDialog.returnValue !== 'discard' || !id || !a || a.run_id !== id || a.state !== 'open') {
      var focused = document.activeElement;
      if (!el.discard.disabled && (!focused || focused === document.body || el.discardDialog.contains(focused))) {
        el.discard.focus();
      }
      return;
    }
    var successors = successorsOf(id);
    var token = beginOperation(id, 'cancel');
    post('/cancel', { run_id: id }).then(function (r) {
      finishOperation(id, token);
      if (r.ok) {
        draftSet(id, null);
        if (state.active && state.active.run_id === id) showDecided('cancelled');
        if (state.activeId === id) toast(t('discarded'));
        afterDecision(id, successors);
      } else if (r.status === 409) {
        if (state.activeId === id) refreshActiveState();
      } else {
        if (state.activeId === id) toast(t('discard_failed'));
      }
    }, function () {
      finishOperation(id, token);
      if (state.activeId === id) toast(t('discard_failed'));
    });
  }

  // -------------------------------------------------------- events ----
  function connectEvents() {
    var url = '/events?sid=' + sid + (query.get('client') === 'test' ? '&client=test' : '')
      + (appToken ? '&app=' + appToken : '') + (appPrevious ? '&prev=' + appPrevious : '');
    var es = new EventSource(url);
    var lost = false;
    es.addEventListener('window', function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || msg.app !== true) return;
      appWindow = true;
      document.documentElement.dataset.rsAppWindow = '1';
      window.name = 'rs-app:' + appToken + ':' + sid;
    });
    es.addEventListener('runs', function (ev) {
      try { applyRuns(JSON.parse(ev.data).runs || []); } catch (e) { console.error(e); }
    });
    es.addEventListener('run', function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.state !== 'open') closeDiscardFor(msg.run_id);
      if (state.active && msg.run_id === state.active.run_id && msg.state !== 'open' && state.active.state === 'open') {
        showDecided(msg.state);
        /* not our own pending submit: hydrate what was actually sent */
        if (msg.state === 'submitted' && !state.operations[msg.run_id]) refreshActiveState();
      }
    });
    es.addEventListener('open', function () {
      if (lost) { lost = false; toast(t('connection_back')); loadRuns(); }
    });
    es.addEventListener('error', function () {
      if (!lost && es.readyState !== EventSource.CLOSED) { lost = true; toast(t('connection_lost')); }
    });
    return es;
  }

  function onKey(e) {
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape' && !el.morePanel.hidden) {
      closeMore();
      el.moreBtn.focus();
      return;
    }
    /* Ctrl+Enter on Windows, Cmd+Enter on macOS */
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === 'Enter') {
      e.preventDefault();
      submit();
      return;
    }
    /* Ctrl+1..9 (Cmd on macOS) picks the n-th open report from anywhere:
       no text field types with Ctrl held, so no typing is lost */
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && !e.isComposing) {
      var m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code || '');
      if (!m) return;
      var run = stripRuns()[Number(m[1]) - 1];
      if (!run) return;
      e.preventDefault();
      if (run.run_id !== state.activeId) activate(run.run_id, { focusTitle: true });
    }
  }

  // ------------------------------------------------- overflow panel --
  function closeMore() {
    if (!el.morePanel || el.morePanel.hidden) return;
    el.morePanel.hidden = true;
    el.moreBtn.setAttribute('aria-expanded', 'false');
  }
  function toggleMore() {
    var open = el.morePanel.hidden;
    el.morePanel.hidden = !open;
    el.moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function start() {
    el = {
      app: document.getElementById('rs-app'),
      stripNav: document.getElementById('rs-strip-nav'),
      strip: document.getElementById('rs-strip'),
      stripCount: document.getElementById('rs-strip-count'),
      moreBtn: document.getElementById('rs-more-btn'),
      morePanel: document.getElementById('rs-more-panel'),
      moreExtra: document.getElementById('rs-more-extra'),
      alt: document.getElementById('rs-alt'),
      title: document.getElementById('rs-title'),
      meta: document.getElementById('rs-meta'),
      bot: document.getElementById('rs-bot'),
      botAvatar: document.getElementById('rs-bot-avatar'),
      botName: document.getElementById('rs-bot-name'),
      theme: document.getElementById('rs-theme'),
      mount: document.getElementById('rs-mount'),
      bar: document.getElementById('rs-submitbar'),
      status: document.getElementById('rs-status'),
      submit: document.getElementById('rs-submit'),
      submitLabel: document.getElementById('rs-submit-label'),
      discard: document.getElementById('rs-discard'),
      toasts: document.getElementById('rs-toasts'),
      discardDialog: document.getElementById('rs-discard-dialog')
    };
    if (boot.lang) document.documentElement.lang = boot.lang;
    fillStrings(document.body);
    pruneDrafts();

    el.moreBtn.addEventListener('click', toggleMore);
    document.addEventListener('pointerdown', function (e) {
      if (!el.morePanel.hidden && !e.target.closest('#rs-more')) closeMore();
    });
    el.alt.addEventListener('click', function () {
      if (state.alternative && typeof state.alternative.run === 'function') state.alternative.run();
    });

    el.theme.setAttribute('aria-pressed', effectiveTheme() === 'dark' ? 'true' : 'false');
    el.theme.addEventListener('click', function () {
      var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
      el.theme.setAttribute('aria-pressed', next === 'dark' ? 'true' : 'false');
    });

    el.submit.addEventListener('click', function () { submit(); });
    el.discard.addEventListener('click', discard);
    el.discardDialog.addEventListener('close', onDiscardClose);

    // touched tracking + choice log + onChange listeners
    el.mount.addEventListener('input', notifyChange);
    ['focusin', 'input', 'select', 'keyup', 'mouseup'].forEach(function (name) {
      el.mount.addEventListener(name, function (ev) { rememberTemplateFocus(ev.target); });
    });
    el.mount.addEventListener('change', function (ev) {
      notifyChange(ev);
      var row = ev.target;
      if (row && row.tagName === 'RS-ACTION-ROW' && state.activeId) {
        var item = row.getAttribute('data-item') || row.id || null;
        post('/log', { run_id: state.activeId, event: 'choice', detail: { item: item, choice: row.value } }).catch(function () {});
      }
    });
    el.mount.addEventListener('rs-copy', notifyChange);
    el.mount.addEventListener('scroll', updateFold, { passive: true });
    if (typeof ResizeObserver === 'function') {
      fold.observer = new ResizeObserver(onFoldResize);
      fold.observer.observe(el.mount);
    }

    document.addEventListener('keydown', onKey);
    el.strip.addEventListener('keydown', onStripKey);
    window.addEventListener('focus', maybeMarkRead);
    document.addEventListener('pointerdown', maybeMarkRead, true);
    document.addEventListener('keydown', maybeMarkRead, true);
    document.addEventListener('visibilitychange', maybeMarkRead);

    renderBar();
    loadRuns().then(connectEvents, connectEvents);
  }

  window.RS = {
    _define: function (id, fn) { definitions[id] = fn; },
    t: t,
    time: time,
    date: date,
    number: number,
    count: count,
    copy: copy,
    toast: toast,
    media: media,
    reveal: reveal,
    submit: function () { return submit(); },
    get data() { return state.active ? state.active.data : null; },
    get activeRun() { return state.activeId; },
    get touched() { return state.touched; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
