/* grokbot-desk page core.
 *
 * Load order (shell.html <head>): count.js, md.js, charts.js, blocks.js,
 * ask.js, composer.js, rs.js, components.js. Everything that touches the
 * DOM starts on DOMContentLoaded.
 *
 * A report is a list of blocks; mountRun renders each through RSBlocks with
 * a ctx bound to that report (blocks.js). Every report ends in the footer:
 * one composer (RSComposer: note and reply chips), the quiet alternatives
 * and one primary, as the report's ask says (RSAsk). window.RS is the
 * page-wide API (components use RS.t / copy / toast / count).
 */
(function () {
  'use strict';

  var boot = JSON.parse(document.getElementById('rs-boot').textContent);
  var strings = boot.strings || {};
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
  /* The window the CLI launched with --app carries that launch's
     one-time token (?app=); the page presents it on /events and only a
     confirmed page (event window) may close itself after its last decision.
     The token leaves the address at once. The confirmed window
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
  /* ?page=doorbell (CLI `doorbell setup`): the setup page stands in for the
     empty state until a report is opened */
  var doorbellPage = query.get('page') === 'doorbell';
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
  // German "15.10." / "99.999", English "Oct 15" / "99,999". Timestamps use
  // the machine's time zone, or the one the server pins (boot.tz, RS_TZ):
  // German "Do 08.10.2026 · 10:39", English "Thu, Oct 8, 2026 · 10:39".
  var LOCALE = boot.lang === 'en' ? 'en-US' : 'de-DE';
  var ZONE = (function () {
    if (typeof boot.tz !== 'string' || !boot.tz) return undefined;
    try { new Intl.DateTimeFormat('en', { timeZone: boot.tz }); return boot.tz; } catch (e) { return undefined; }
  })();
  var numberFmt = new Intl.NumberFormat(LOCALE);
  var dayFmt = new Intl.DateTimeFormat(LOCALE, boot.lang === 'en'
    ? { month: 'short', day: 'numeric', timeZone: 'UTC' }
    : { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
  var timeFmt = new Intl.DateTimeFormat(LOCALE, boot.lang === 'en'
    ? { timeZone: ZONE, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
    : { timeZone: ZONE, weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
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
  /** Local timestamp: "Do 08.10.2026 · 10:39" (de) / "Thu, Oct 8, 2026 · 10:39" (en). */
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
    operations: {},    // run id -> { token, kind }; completions clear only their own token
    footer: null,      // RSAsk.footer as rendered: { status, primary, alts }
    mode: 'decide',    // footer mode: decide, request (Request changes) or none-of-these
    composer: null,    // RSComposer of the shown report
    input: null,       // the input block's handle (blocks.js), or null
    inputDraft: null,  // a saved input snapshot waiting for its handle
    pending: null,     // run id being loaded
    discardTarget: null, // run id the open Verwerfen confirmation is about
    reading: {},       // run id -> true while POST /read is in flight
    hydrated: null,    // key of the decided run the page shows (hydrationKey)
    requestGen: 0,     // activation request order; stale responses are ignored
    gone: {},          // run id -> true once this page decided it (before SSE says so)
    done: null,        // null, 'closing' or 'kept': the calm done state after the last decision
    order: [],         // open run ids in arrival order (arrivals append)
    groups: [],        // bot ids in first-seen order while they have open runs
    burst: null        // { ids, bots, timer, started }: arrivals not announced yet
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

  /* a toast belongs to the report it was raised for: switching reports
     (auto-advance after a decision, a new arrival, the strip) clears it */
  function clearToasts() {
    if (el.toasts) el.toasts.textContent = '';
  }

  // ------------------------------------------------------ core API ----
  function activeRunId() { return state.activeId; }

  /* http(s) links never navigate this window. The address is posted to
     /open-url, which opens it in the OS browser when it occurs in the
     run's payload. Anchors are not draggable, a drag is cancelled, and
     dropping an external URL on the page is cancelled. A primary click,
     a middle click, Enter (including Shift and Alt), and a modified click
     all post the address; Ctrl+Enter and Cmd+Enter stay the submit
     shortcut and do not open the link. rel=noopener and the server
     allowlist do not by themselves stop the window from navigating.
     The context menu is suppressed: a menu "Open" would load the address
     inside the app profile, and a browser that still offers that item
     from a menu the page cannot see is outside this guarantee. */
  var URL_RE = /https?:\/\/[^\s<>"'\\]+/gi;
  var URL_TRAIL = '.,;:!?';
  function trimUrl(url) {
    while (url && URL_TRAIL.indexOf(url.charAt(url.length - 1)) >= 0) url = url.slice(0, -1);
    while (url.charAt(url.length - 1) === ')' && countChar(url, '(') < countChar(url, ')')) url = url.slice(0, -1);
    while (url.charAt(url.length - 1) === ']' && countChar(url, '[') < countChar(url, ']')) url = url.slice(0, -1);
    return url;
  }
  function countChar(text, ch) {
    var n = 0;
    for (var i = 0; i < text.length; i++) if (text.charAt(i) === ch) n++;
    return n;
  }
  function hasControl(url) {
    for (var i = 0; i < url.length; i++) {
      var code = url.charCodeAt(i);
      if (code < 32 || (code >= 127 && code <= 159)) return true;
    }
    return false;
  }
  function openableUrl(url) {
    if (typeof url !== 'string' || !url || url.length > 2048) return false;
    if (hasControl(url) || /\s/.test(url) || url.indexOf('\\') >= 0) return false;
    // the raw authority is checked before URL() normalizes it; the same rule
    // as core/urls.py openable (tests/fixtures/url_vectors.json)
    var scheme = /^https?:\/\//i.exec(url);
    if (!scheme) return false;
    var rest = url.slice(scheme[0].length);
    var cut = rest.search(/[/?#]/);
    var authority = cut < 0 ? rest : rest.slice(0, cut);
    if (authority.indexOf('@') >= 0) return false;
    var host = authority, port = null;
    if (host.charAt(0) === '[') {
      var end = host.indexOf(']');
      if (end < 0 || !/^[0-9A-Fa-f:.]+$/.test(host.slice(1, end))) return false;
      var tail = host.slice(end + 1);
      if (tail) {
        if (tail.charAt(0) !== ':') return false;
        port = tail.slice(1);
      }
    } else {
      var at = host.indexOf(':');
      if (at >= 0) { port = host.slice(at + 1); host = host.slice(0, at); }
      if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.?$/.test(host)) return false;
    }
    if (port !== null && (!/^[0-9]{1,5}$/.test(port) || Number(port) > 65535)) return false;
    var parsed;
    try { parsed = new URL(url); } catch (e) { return false; }
    if (parsed.username || parsed.password || !parsed.hostname) return false;
    return true;
  }
  function externalAnchor(url, text) {
    var a = document.createElement('a');
    a.className = 'rs-ext';
    a.draggable = false;
    a.setAttribute('draggable', 'false');
    a.setAttribute('href', url);
    a.setAttribute('rel', 'noopener noreferrer');
    a.setAttribute('data-rs-view-action', '');
    a.textContent = text == null || text === '' ? url : text;
    return a;
  }
  function appendLinkedText(parent, text) {
    var source = String(text);
    var re = new RegExp(URL_RE.source, 'gi');
    var last = 0;
    var match;
    while ((match = re.exec(source))) {
      var raw = match[0];
      var trimmed = trimUrl(raw);
      var start = match.index;
      if (start > last) parent.appendChild(document.createTextNode(source.slice(last, start)));
      if (openableUrl(trimmed)) {
        parent.appendChild(externalAnchor(trimmed, trimmed));
        last = start + trimmed.length;
        re.lastIndex = last;
      } else {
        parent.appendChild(document.createTextNode(raw));
        last = start + raw.length;
      }
    }
    if (last < source.length) parent.appendChild(document.createTextNode(source.slice(last)));
  }
  function fillText(node, text) {
    if (!node) return;
    node.textContent = '';
    appendLinkedText(node, text == null ? '' : text);
  }
  function appendLinks(node, text) {
    if (!node || text == null || text === '') return;
    var holder = document.createElement('span');
    appendLinkedText(holder, String(text));
    Array.prototype.forEach.call(holder.querySelectorAll('a.rs-ext'), function (anchor) {
      node.appendChild(anchor);
    });
  }
  function externalLink(url, text) {
    return openableUrl(url) ? externalAnchor(url, text) : null;
  }
  function linkFromEvent(event) {
    var target = event.target && event.target.closest ? event.target.closest('a.rs-ext') : null;
    if (!target || !el.mount || !el.mount.contains(target)) return null;
    return target;
  }
  var linkOpenedAt = 0;
  function openLink(url) {
    var now = Date.now();
    if (now - linkOpenedAt < 400) return;
    linkOpenedAt = now;
    openUrlFor(activeRunId(), url);
  }
  function activateLink(event) {
    var anchor = linkFromEvent(event);
    if (!anchor) return;
    if (event.type === 'auxclick' && event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    openLink(anchor.getAttribute('href'));
  }

  function openUrlFor(runId, url) {
    if (!runId) return Promise.resolve({ ok: false });
    return post('/open-url', { run_id: runId, url: String(url) }).then(function (r) {
      if (state.activeId === runId) toast(t(r.ok ? 'open_done' : 'open_failed'));
      return { ok: r.ok };
    }, function () {
      if (state.activeId === runId) toast(t('open_failed'));
      return { ok: false };
    });
  }
  function openUrl(url) { return openUrlFor(activeRunId(), url); }

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
  /* An image as a picture (kind 'image') or a media file's path as text
     (kind 'path', e.g. a video to upload by hand), by media id. */
  function copyMediaFor(runId, mediaId, kind) {
    if (!runId) return Promise.resolve({ ok: false });
    if (state.activeId === runId) markTouched();
    var route = kind === 'path' ? '/copy-path' : '/copy-image';
    return post(route, { run_id: runId, media_id: String(mediaId) }).then(function (r) {
      if (r.ok) return { ok: true };
      if (r.status === 423) return { ok: false, busy: true };
      return { ok: false, status: r.status };
    }, function () { return { ok: false }; });
  }
  function copyImage(mediaId) { return copyMediaFor(activeRunId(), mediaId, 'image'); }
  function copyPath(mediaId) { return copyMediaFor(activeRunId(), mediaId, 'path'); }

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
    /* a report that scrolls keeps the footer at the window bottom over a
       hairline; a short one has it right under the content */
    var scrolls = m.scrollHeight - m.clientHeight > 1;
    if (scrolls !== m.hasAttribute('data-rs-scrolls')) m.toggleAttribute('data-rs-scrolls', scrolls);
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
  // A run may also name a shape and colour. The page draws the shape from
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

  /* "Erstellt Do 08.10.2026 · 10:39": German uses the server's display (same zone) */
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

  /* The avatar, the bot's name in bold and, as the one quiet
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

  // ------------------------------------------------------ task banner --
  /* Above the blocks of every report: what to do and who acts next, so a
     person who was interrupted can act within seconds. One line for the
     task (by ask, RSAsk.banner), urgency and due date as quiet meta, then at
     most three sentences of why (the server splits it: why_shown, the rest
     folded in a details as why_more).
     C16 exception: the banner tint is a status colour per ask (approve, do,
     read), not the accent, and the only large non-accent colour on the
     page; red only for urgent or a due date that is today or past. The
     banner holds no buttons, at most the details toggle, so one primary
     action and at most 3 buttons per item still hold (K1, K2, K6 in
     tools/calm.mjs). A decided report keeps the banner, neutral, saying
     what happened (RSAsk.decidedLine). */
  if (window.RSAsk) window.RSAsk.use({ t: t, date: date, zone: ZONE });

  function textNode(tag, cls, text) {
    var node = document.createElement(tag);
    node.className = cls;
    node.textContent = text;
    return node;
  }

  /* the bot by its display name while it fits; a bare bot id or a long
     name is "the bot" (RSAsk.botName) */
  function botNameOf(run) { return run ? window.RSAsk.botName(run) : ''; }

  function renderTask(run) {
    var box = el.taskInner;
    box.textContent = '';
    if (!run) {
      el.task.hidden = true;
      return;
    }
    var decided = !!run.state && run.state !== 'open';
    var banner = decided ? null : window.RSAsk.banner(run, new Date());
    el.task.setAttribute('data-ask', run.ask || '');
    el.task.setAttribute('data-tone', decided ? 'quiet' : banner.tone);
    el.task.setAttribute('data-state', decided ? 'decided' : 'open');
    var line = document.createElement('p');
    line.className = 'rs-task__line';
    line.appendChild(textNode('span', 'rs-task__what', decided ? window.RSAsk.decidedLine(run, run.result) : banner.lines[0]));
    var meta = decided ? [] : banner.lines.slice(1);
    if (meta.length) line.appendChild(textNode('span', 'rs-task__meta', meta.join(' ' + t('sep') + ' ')));
    box.appendChild(line);
    var why = typeof run.why_shown === 'string' ? run.why_shown : typeof run.why === 'string' ? run.why : '';
    if (why) box.appendChild(textNode('p', 'rs-task__why', why));
    if (typeof run.why_more === 'string' && run.why_more) {
      var more = document.createElement('details');
      more.className = 'rs-task__more';
      more.appendChild(textNode('summary', '', t('task_why_more')));
      more.appendChild(textNode('p', '', run.why_more));
      box.appendChild(more);
    }
    el.task.hidden = false;
  }

  // ------------------------------------------------------------ strip --
  /* The window is a pop-up for one decision at a time. With 2+ open
     reports a slim strip above the header shows each one's avatar with its
     waiting dot (filled while new, a ring once seen), the active one
     underlined, and "n of m open". It is one Tab stop (roving tabindex):
     Left/Right/Home/End switch along it, Ctrl+1..9 from anywhere. Decided
     reports leave the strip; with one open report there is none (K3). */
  /* Open reports in a stable order. The page keeps registration order
     (summary seq, assigned when the run was registered) and groups it by
     bot: the bots in the order they first showed up, each bot's reports in
     that same order. A record saved before seq existed is numbered on load,
     in created order, ahead of later registrations. One that still has no
     seq stays in that created cohort, ahead of sequenced reports.
     Arrivals append; nothing jumps during a burst. Bot ids are dictionary
     keys, so these maps have no prototype (a bot id may be "constructor"). */
  function botKey(run) { return run.bot || run.bot_display || ''; }
  function dict() { return Object.create(null); }

  function registrationRank(run) {
    var parsed = Date.parse(run.created || '');
    var created = isNaN(parsed) ? 0 : parsed;
    if (typeof run.seq === 'number' && isFinite(run.seq)) return [1, run.seq];
    return [0, created];
  }

  function syncOrder(runs) {
    var open = dict();
    runs.forEach(function (r) { open[r.run_id] = r; });
    var order = state.order.filter(function (id) { return open[id]; });
    var have = dict();
    order.forEach(function (id) { have[id] = true; });
    var fresh = runs.filter(function (r) { return !have[r.run_id]; });
    fresh.sort(function (a, b) {
      var ka = registrationRank(a), kb = registrationRank(b);
      return ka[0] - kb[0] || ka[1] - kb[1];
    });
    fresh.forEach(function (r) {
      order.push(r.run_id);
      have[r.run_id] = true;
    });
    state.order = order;
    var bots = dict();
    order.forEach(function (id) { bots[botKey(open[id])] = true; });
    var groups = state.groups.filter(function (k) { return bots[k]; });
    var seen = dict();
    groups.forEach(function (k) { seen[k] = true; });
    order.forEach(function (id) {
      var k = botKey(open[id]);
      if (!seen[k]) { groups.push(k); seen[k] = true; }
    });
    state.groups = groups;
  }

  function openRuns() {
    var open = state.runs.filter(function (r) {
      return (r.state === undefined || r.state === 'open') && !state.gone[r.run_id];
    });
    var rank = dict();
    state.order.forEach(function (id, i) { rank[id] = i; });
    var group = dict();
    state.groups.forEach(function (k, i) { group[k] = i; });
    function at(table, key) { return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : 1e9; }
    return open.map(function (r, i) { return { r: r, i: i }; }).sort(function (x, y) {
      return (at(group, botKey(x.r)) - at(group, botKey(y.r)))
        || (at(rank, x.r.run_id) - at(rank, y.r.run_id))
        || (y.i - x.i);
    }).map(function (x) { return x.r; });
  }

  /* one strip entry per bot: { key, runs } in strip order (max 12) */
  function stripGroups() {
    var groups = [];
    var byKey = dict();
    openRuns().forEach(function (r) {
      var k = botKey(r);
      if (!byKey[k]) { byKey[k] = { key: k, runs: [] }; groups.push(byKey[k]); }
      byKey[k].runs.push(r);
    });
    return groups.slice(0, 12);
  }

  function groupOf(runId) {
    return stripGroups().filter(function (g) {
      return g.runs.some(function (r) { return r.run_id === runId; });
    })[0] || null;
  }

  /* where a group leads: that bot's oldest open report; the current group
     steps on to that bot's next report (wrapping) */
  function groupTarget(g) {
    var ids = g.runs.map(function (r) { return r.run_id; });
    var at = ids.indexOf(state.activeId);
    if (at < 0) return ids[0];
    return ids[(at + 1) % ids.length];
  }

  function stripButtons() {
    return Array.prototype.slice.call(el.strip.querySelectorAll('.rs-strip__run'));
  }

  function focusStrip(runId) {
    var g = groupOf(runId);
    var b = (g && stripButtons().filter(function (x) { return x.getAttribute('data-bot') === g.key; })[0])
      || el.strip.querySelector('.rs-strip__run[tabindex="0"]');
    if (b && !el.stripNav.hidden) b.focus();
  }

  function renderStrip() {
    var groups = stripGroups();
    var all = openRuns();
    var heldEl = el.strip.contains(document.activeElement) ? document.activeElement : null;
    var held = heldEl ? heldEl.getAttribute('data-bot') : null;
    var at = -1;
    groups.forEach(function (g, i) {
      if (g.runs.some(function (r) { return r.run_id === state.activeId; })) at = i;
    });
    var position = -1;
    all.forEach(function (r, i) { if (r.run_id === state.activeId) position = i; });
    el.strip.textContent = '';
    groups.forEach(function (g, i) {
      var current = i === at;
      var lead = g.runs[0];
      var who = identityOf(lead);
      var waiting = g.runs.some(function (r) { return r.unread && r.run_id !== state.activeId; });
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'rs-strip__run';
      b.setAttribute('data-bot', g.key);
      b.setAttribute('data-run-id', current ? state.activeId : lead.run_id);
      /* accessible name and tooltip: the bot and the report title, or the
         bot and how many reports it has waiting. The current bot's avatar
         cycles its reports, so that one also says how to step on. */
      var label = g.runs.length > 1
        ? t(current ? 'strip_cycle' : 'strip_group', { bot: who.name, n: number(g.runs.length) })
        : t('strip_item', { bot: who.name, title: lead.title });
      if (waiting) label += ' ' + t('sep') + ' ' + t('new');
      b.setAttribute('aria-label', label);
      b.title = label;
      if (current) b.setAttribute('aria-current', 'page');
      b.tabIndex = i === Math.max(at, 0) ? 0 : -1;
      if (i < 9) b.setAttribute('aria-keyshortcuts', 'Control+' + (i + 1));
      b.appendChild(avatarBox(who, 'md'));
      var dot = document.createElement('span');
      dot.className = 'rs-strip__dot';
      if (waiting) dot.setAttribute('data-new', '');
      b.appendChild(dot);
      if (g.runs.length > 1) {
        var badge = document.createElement('span');
        badge.className = 'rs-strip__badge';
        badge.setAttribute('aria-hidden', 'true');
        badge.textContent = number(g.runs.length);
        b.appendChild(badge);
      }
      b.addEventListener('click', function () {
        var target = groupTarget(g);
        if (target && target !== state.activeId) activate(target, { focusStrip: true });
      });
      el.strip.appendChild(b);
    });
    var on = all.length >= 2;
    /* the open count sits in the header's byline, only while several wait */
    el.stripCount.textContent = !on ? ''
      : position >= 0 ? t('strip_count', { n: position + 1, m: all.length })
        : t('strip_count_all', { m: all.length });
    el.stripNav.hidden = !on;
    el.app.setAttribute('data-strip', on ? 'on' : 'off');
    if (held) {
      var again = stripButtons().filter(function (x) { return x.getAttribute('data-bot') === held; })[0];
      if (again && !el.stripNav.hidden) again.focus();
    }
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
    /* a step along the strip goes to that bot's oldest open report; its own
       group (a single one: Home/End) stays where it is */
    var g = stripGroups()[j];
    if (!g || g.runs.some(function (r) { return r.run_id === state.activeId; })) return;
    activate(g.runs[0].run_id, { focusStrip: true });
  }

  // ----------------------------------------------------- submit bar --
  function activeBusy() {
    return !!(state.activeId && state.operations[state.activeId]);
  }

  function decisionRoot() {
    return el.mount.querySelector('.rs-report');
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

  /* The footer: the composer, a status line, at most two quiet
     alternatives and exactly one primary, as RSAsk.footer words them for
     the report's ask, its input block and the mode (decide, request,
     none-of-these). In a request mode the note is required and the
     primary sends revise, so Ctrl+Enter can never approve while the person
     writes a request. A decided report keeps only what was sent, read-only.
     Discard lives in the "…" menu behind its confirmation, not on read. */
  function noteWritten() {
    return !!(state.composer && /\S/.test(state.composer.text()));
  }

  function currentFooter() {
    var a = state.active;
    if (!a) return null;
    return window.RSAsk.footer(a, state.input, state.mode, { note: noteWritten() });
  }

  function renderBar() {
    var a = state.active;
    var open = !!(a && a.state === 'open');
    var busy = activeBusy();
    var f = open ? currentFooter() : null;
    state.footer = f;
    el.submit.disabled = !f || !f.primary.enabled || busy;
    el.discard.disabled = !open || busy;
    el.discard.hidden = !open || !window.RSAsk.discard(a);
    el.submit.toggleAttribute('data-rs-emphasis', !!(open && a.urgent));
    el.submitLabel.textContent = f ? f.primary.label : '';
    /* the alternatives exist only while the footer offers them, in the
       given order, before the primary */
    var shown = [];
    el.alts.forEach(function (button, i) {
      var alt = f ? f.alts[i] : null;
      if (alt) {
        button.textContent = alt.label;
        button.hidden = false;
        if (alt.mode) button.setAttribute('data-rs-mode', alt.mode);
        else button.removeAttribute('data-rs-mode');
        shown.push(button);
      } else if (button.isConnected) {
        button.remove();
      }
      button.disabled = busy;
    });
    /* moved only when out of place, so a focused alternative keeps focus */
    var after = el.submit;
    for (var i = shown.length - 1; i >= 0; i--) {
      if (shown[i].nextElementSibling !== after) after.parentNode.insertBefore(shown[i], after);
      after = shown[i];
    }
    el.status.textContent = f ? f.status : '';
    if (state.composer) state.composer.setBusy(busy);
    var keep = !open && !!state.composer && state.composer.isOpen();
    el.actions.hidden = !open;
    el.bar.hidden = !open && !keep;
  }

  /* Request changes / None of these: the note becomes required and takes
     focus; Cancel (or Escape) returns to the decision and its button. */
  var MODE_PLACEHOLDER = { request: 'cmp_placeholder_request', 'none-of-these': 'cmp_placeholder_none' };
  function setMode(mode) {
    var a = state.active;
    if (!a || a.state !== 'open' || !state.composer) return;
    var previous = state.mode;
    state.mode = Object.prototype.hasOwnProperty.call(MODE_PLACEHOLDER, mode) ? mode : 'decide';
    state.composer.setRequired(state.mode !== 'decide', MODE_PLACEHOLDER[state.mode] ? t(MODE_PLACEHOLDER[state.mode]) : null);
    renderBar();
    saveDraft();
    if (state.mode !== 'decide') { state.composer.focus(); return; }
    var back = el.alts.filter(function (b) { return b.isConnected && b.getAttribute('data-rs-mode') === previous; })[0];
    (back || (el.submit.disabled ? null : el.submit) || el.title).focus();
  }

  function onAlt(i) {
    var alt = state.footer && state.footer.alts[i];
    if (!alt || activeBusy()) return;
    if (alt.mode) setMode(alt.mode);
    else if (alt.decision) submit(null, alt.decision);
  }

  // ----------------------------------------------------------- drafts --
  /* What the person prepared survives a reload or a closed window: the
     composer (note, chips, opened), the footer mode and the input block's
     snapshot. Saved on every change while the report is open. */
  function saveDraft() {
    var a = state.active;
    if (!a || a.state !== 'open' || !state.composer || state.operations[a.run_id]) return;
    var note = state.composer.snapshot();
    var input = state.input && typeof state.input.snapshot === 'function' ? state.input.snapshot() : state.inputDraft;
    var empty = !note.text && !note.refs.length && state.mode === 'decide' && !(a.ask === 'read' && note.open) && input == null;
    draftSet(a.run_id, empty ? null : { v: 2, mode: state.mode, composer: note, input: input == null ? null : input });
  }

  function composerChanged() {
    markTouched();
    renderBar();
    saveDraft();
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
  /* After the person's own decision (send or discard) the pop-up moves
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

  /* The strip order after a report, captured when its decision starts:
     the same bot's later reports, then that bot's earlier ones (a wrap),
     then the later bots, then the earlier ones. The server's list drops
     the report before our own answer may arrive, so the order is not
     read again afterwards. */
  function successorsOf(runId) {
    var runs = openRuns();
    var at = -1;
    runs.forEach(function (r, i) { if (r.run_id === runId) at = i; });
    if (at < 0) return runs.map(function (r) { return r.run_id; });
    var mine = botKey(runs[at]);
    var later = [], earlier = [], restLater = [], restEarlier = [];
    runs.forEach(function (r, i) {
      if (i === at) return;
      var same = botKey(r) === mine;
      if (same && i > at) later.push(r.run_id);
      else if (same) earlier.push(r.run_id);
      else if (i > at) restLater.push(r.run_id);
      else restEarlier.push(r.run_id);
    });
    return later.concat(earlier, restLater, restEarlier);
  }

  /* the intended successor if it is still open, else the next of the
     captured order, else any open report (one that arrived meanwhile) */
  function nextOpenAfter(runId, successors) {
    var rest = openRuns().filter(function (r) { return r.run_id !== runId; });
    if (!rest.length) return null;
    var open = dict();
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
      /* Chromium closes a window that no script opened only while its
         history holds one entry (DOMWindow::Close); otherwise it refuses
         and window.closed stays false, so say what really happens */
      if (!window.closed) {
        state.done = 'kept';
        if (state.active) setBanner(state.active.state);
      }
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
    var root = el.mount.querySelector('.rs-report');
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
    state.mode = 'decide';
    if (state.composer) state.composer.lock();
    if (state.input && typeof state.input.lock === 'function') state.input.lock();
    renderTask(state.active);
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

  /* A decided run detail is immutable: the same key means the same view. */
  function hydrationKey(run) {
    return JSON.stringify([run.run_id, run.state, run.result === undefined ? null : run.result]);
  }

  /* The report's blocks see the page through this ctx (blocks.js). Calls
     for a report that is no longer shown do nothing. */
  function blockCtx(run) {
    function live() { return state.active === run; }
    var types = run.media_types && typeof run.media_types === 'object' ? run.media_types : {};
    function stale() { return Promise.resolve({ ok: false, stale: true }); }
    return {
      t: t,
      lang: boot.lang === 'en' ? 'en' : 'de',
      locked: run.state !== 'open',
      media: media,
      mediaKind: function (id) {
        var type = Object.prototype.hasOwnProperty.call(types, id) ? String(types[id]) : '';
        return type.indexOf('video/') === 0 ? 'video' : 'image';
      },
      link: function (url) { return externalLink(url, ''); },
      openUrl: function (url) { return live() ? openUrlFor(run.run_id, url) : stale(); },
      copy: function (text) { return live() ? copyFor(run.run_id, text) : stale(); },
      copyImage: function (id) { return live() ? copyMediaFor(run.run_id, id, 'image') : stale(); },
      copyPath: function (id) { return live() ? copyMediaFor(run.run_id, id, 'path') : stale(); },
      reveal: function (id) { return live() ? revealFor(run.run_id, id) : stale(); },
      /* a reply anchor quotes its target as a chip in the composer */
      addRef: function (ref) { if (live() && state.composer) state.composer.addRef(ref); },
      /* the input block hands over its handle (answer, progress,
         primaryLabel, snapshot, restore, lock) and calls changed() on every
         answer; a saved draft is handed back to it once */
      input: function (handle) {
        if (!live()) return;
        state.input = handle || null;
        if (state.input && state.inputDraft != null && typeof state.input.restore === 'function') state.input.restore(state.inputDraft);
        state.inputDraft = null;
        if (state.input && run.state !== 'open' && typeof state.input.lock === 'function') state.input.lock();
        renderBar();
      },
      changed: function () {
        if (!live()) return;
        markTouched();
        renderBar();
        saveDraft();
      }
    };
  }

  /* The composer of a report: open on every ask but read (a quiet "Add a
     note" there); a decided report shows what was sent, read-only; an open
     one gets its draft back. */
  function mountComposer(run) {
    var composer = window.RSComposer.create({
      t: t,
      bot: botNameOf(run),
      collapsed: run.ask === 'read',
      onChange: function () { if (state.composer === composer) composerChanged(); }
    });
    el.composerSlot.textContent = '';
    el.composerSlot.appendChild(composer.el);
    var oldOpener = el.actions.querySelector('[data-rs-note-open]');
    if (oldOpener) oldOpener.remove();
    el.actions.insertBefore(composer.opener, el.status);
    state.composer = composer;
    state.mode = 'decide';
    state.input = null;
    state.inputDraft = null;
    if (run.state !== 'open') {
      var sent = run.result && typeof run.result === 'object' ? run.result : {};
      composer.restore({ text: typeof sent.note === 'string' ? sent.note : '', refs: Array.isArray(sent.refs) ? sent.refs : [] });
      composer.lock();
      return;
    }
    var draft = draftGet(run.run_id);
    if (!draft || draft.v !== 2) return;
    composer.restore(draft.composer);
    state.inputDraft = draft.input == null ? null : draft.input;
    var mode = draft.mode;
    if (mode !== 'decide' && window.RSAsk.footer(run, null, mode).primary.decision === 'revise') {
      state.mode = mode;
      composer.setRequired(true, t(MODE_PLACEHOLDER[mode]));
    }
  }

  /** Renders a fetched run detail: blocks, banner/lock, bar, strip, title. */
  function mountRun(run, opts) {
    clearDone();
    state.hydrated = run.state === 'open' ? null : hydrationKey(run);
    state.active = run;
    state.activeId = run.run_id;
    state.listeners = [];
    state.touched = draftGet(run.run_id) !== null;
    var nextUrl = new URL(location.href);
    nextUrl.searchParams.set('run', run.run_id);
    history.replaceState(history.state, '', nextUrl.pathname + nextUrl.search + nextUrl.hash);
    query.set('run', run.run_id);
    el.moreExtra.textContent = '';
    closeMore();

    el.title.textContent = run.title;
    renderBot(run);
    renderTask(run);
    el.meta.textContent = '';
    var bot = document.createElement('span');
    var created = document.createElement('span');
    bot.className = 'rs-more__bot';
    bot.appendChild(avatarBox(identityOf(run)));
    bot.appendChild(document.createTextNode(t('from_bot', { bot: run.bot_display })));
    created.textContent = createdText(run);
    el.meta.appendChild(bot);
    el.meta.appendChild(created);

    mountComposer(run);
    el.mount.textContent = '';
    el.mount.scrollTop = 0;
    var root = document.createElement('div');
    root.className = 'rs-report';
    var ctx = blockCtx(run);
    var failed = false;
    (Array.isArray(run.blocks) ? run.blocks : []).forEach(function (block) {
      if (!window.RSBlocks || window.RSBlocks.types.indexOf(block && block.type) < 0) return;
      try { root.appendChild(window.RSBlocks.render(block, ctx)); } catch (e) { console.error(e); failed = true; }
    });
    if (failed) toast(t('blk_error'));
    el.mount.appendChild(root);
    renderBar();
    if (run.state === 'open') renderPendingOperation(run.run_id, root);
    var refocused = run.state === 'open' && restoreReloadFocus(run.run_id, root);
    if (run.state !== 'open') { setBanner(run.state); lockTemplate(); }
    /* a restored request goes back to its note; a restored draft that is
       ready to send focuses the primary */
    else if (!refocused && state.mode !== 'decide') state.composer.focus();
    else if (state.touched && document.activeElement === document.body && !el.submit.disabled) el.submit.focus();
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
    doorbellPage = false;
    state.requestGen += 1;
    var requestGen = state.requestGen;
    /* an accepted arrival or switch ends the done state at once, not only
       once its detail has loaded (the close must not fire meanwhile) */
    var wasDone = !!state.done;
    clearDone();
    clearToasts();
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
    state.hydrated = null;
    state.pending = null;
    state.active = null;
    state.activeId = null;
    state.touched = false;
    state.listeners = [];
    state.composer = null;
    state.input = null;
    state.inputDraft = null;
    state.mode = 'decide';
    el.composerSlot.textContent = '';
    var opener = el.actions.querySelector('[data-rs-note-open]');
    if (opener) opener.remove();
    el.title.textContent = doorbellPage ? t('doorbell_title') : '';
    renderBot(null);
    renderTask(null);
    el.meta.textContent = '';
    var focusedId = document.activeElement && el.mount.contains(document.activeElement)
      ? document.activeElement.getAttribute('data-run-id') : null;
    var waiting = openRuns();
    if (doorbellPage) {
      /* kept across runs updates: what the person typed stays */
      if (!el.mount.querySelector('[data-rs-doorbell]')) {
        el.mount.textContent = '';
        el.mount.appendChild(renderDoorbell());
      }
      renderDoorbellWaiting(waiting);
    } else {
      el.mount.textContent = '';
      if (waiting.length) el.mount.appendChild(renderOverview(waiting, focusedId));
      else el.mount.appendChild(textNode('p', 'rs-empty', t('no_runs')));
    }
    watchFold(null);
    renderBar();
    renderStrip();
    updateTitle();
    setReady(true);
    if (focusedId) {
      var again = el.mount.querySelector('[data-run-id="' + CSS.escape(focusedId) + '"]');
      if (again) again.focus();
    }
  }

  /* the doorbell setup page (?page=doorbell): where to find URL and key,
     Save (writes the file, rings a test) and Test; the server never sends
     the key back, so the key field always starts empty */
  function renderDoorbell() {
    var section = document.createElement('section');
    section.className = 'rs-doorbell';
    section.setAttribute('data-rs-doorbell', '');
    var status = textNode('p', 'rs-doorbell__state', '');
    status.id = 'rs-doorbell-state';
    section.appendChild(status);
    /* reports waiting meanwhile: the strip may be hidden (one report), so
       the page names them and opens the first one */
    var waitingRow = document.createElement('p');
    waitingRow.className = 'rs-doorbell__waiting';
    waitingRow.hidden = true;
    var waitingBtn = document.createElement('button');
    waitingBtn.type = 'button';
    waitingBtn.className = 'rs-doorbell__open';
    waitingBtn.id = 'rs-doorbell-waiting';
    waitingBtn.addEventListener('click', function () {
      var first = openRuns()[0];
      if (first) activate(first.run_id);
    });
    waitingRow.appendChild(waitingBtn);
    section.appendChild(waitingRow);
    section.appendChild(textNode('p', '', t('doorbell_intro')));
    section.appendChild(textNode('p', '', t('doorbell_where')));
    var form = document.createElement('form');
    form.className = 'rs-doorbell__form';
    form.noValidate = true;
    function field(id, key, type) {
      var wrap = document.createElement('div');
      var label = textNode('label', 'rs-label', t(key));
      label.htmlFor = id;
      var input = document.createElement('input');
      input.className = 'rs-input';
      input.id = id;
      input.type = type;
      input.autocomplete = 'off';
      input.spellcheck = false;
      wrap.appendChild(label);
      wrap.appendChild(input);
      form.appendChild(wrap);
      return input;
    }
    var url = field('rs-doorbell-url', 'doorbell_url', 'url');
    var key = field('rs-doorbell-key', 'doorbell_key', 'password');
    var buttons = document.createElement('div');
    buttons.className = 'rs-doorbell__buttons';
    var test = textNode('button', 'rs-btn rs-btn--quiet', t('doorbell_test'));
    test.type = 'button';
    test.id = 'rs-doorbell-test';
    var save = textNode('button', 'rs-btn rs-btn--primary', t('doorbell_save'));
    save.type = 'submit';
    save.id = 'rs-doorbell-save';
    buttons.appendChild(test);
    buttons.appendChild(save);
    form.appendChild(buttons);
    var outcome = textNode('p', 'rs-doorbell__outcome', '');
    outcome.id = 'rs-doorbell-outcome';
    outcome.setAttribute('role', 'status');
    form.appendChild(outcome);
    section.appendChild(form);

    function show(info) {
      status.textContent = info && info.on ? t('doorbell_on', { host: info.host }) : t('doorbell_off');
      status.setAttribute('data-on', info && info.on ? 'true' : 'false');
      test.disabled = !(info && info.on);
    }
    /* a refused field: marked invalid, tied to the visible message, focused;
       typing in it clears the mark */
    var FIELDS = { '/url': url, '/key': key };
    function markInvalid(pointer) {
      [url, key].forEach(function (input) {
        var bad = FIELDS[pointer] === input;
        if (bad) {
          input.setAttribute('aria-invalid', 'true');
          input.setAttribute('aria-describedby', outcome.id);
        } else {
          input.removeAttribute('aria-invalid');
          input.removeAttribute('aria-describedby');
        }
      });
      if (FIELDS[pointer]) FIELDS[pointer].focus();
    }
    [url, key].forEach(function (input) {
      input.addEventListener('input', function () {
        input.removeAttribute('aria-invalid');
        input.removeAttribute('aria-describedby');
      });
    });
    var REASONS = { unreachable: 'doorbell_reason_unreachable', refused: 'doorbell_reason_refused', busy: 'doorbell_reason_busy' };
    var REFUSALS = { invalid_url: 'doorbell_invalid_url', missing_key: 'doorbell_missing_key', invalid_key: 'doorbell_invalid_key' };
    function report(r, saved) {
      if (r.ok) {
        markInvalid(null);
        show(r.body);
        var rang = r.body.test;
        outcome.setAttribute('data-tone', rang.ok ? 'ok' : 'warn');
        if (rang.ok) {
          outcome.textContent = t(saved ? 'doorbell_rang' : 'doorbell_test_rang', { status: rang.http_status });
        } else {
          var reason = t(REASONS[rang.category] || 'doorbell_reason_other');
          outcome.textContent = t(saved ? 'doorbell_saved_test_failed' : 'doorbell_test_failed', { reason: reason });
        }
        if (saved) key.value = '';
      } else {
        outcome.setAttribute('data-tone', 'warn');
        var code = r.body && r.body.error;
        outcome.textContent = t(REFUSALS[code] || 'doorbell_error');
        markInvalid(r.body && r.body.pointer);
      }
    }
    function busy(on) {
      save.disabled = on;
      if (on) { test.disabled = true; outcome.removeAttribute('data-tone'); outcome.textContent = t('doorbell_ringing'); }
    }
    function refresh() {
      return request('GET', '/api/doorbell').then(function (r) { if (r.ok) show(r.body); }, function () {});
    }
    function failed() {
      outcome.setAttribute('data-tone', 'warn');
      outcome.textContent = t('doorbell_error');
      refresh();
    }
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      busy(true);
      post('/doorbell', { url: url.value.trim(), key: key.value }).then(function (r) {
        busy(false);
        report(r, true);
        if (!r.ok) refresh();
      }, function () { busy(false); failed(); });
    });
    test.addEventListener('click', function () {
      busy(true);
      post('/doorbell/test', {}).then(function (r) { busy(false); report(r, false); },
        function () { busy(false); failed(); });
    });
    show(null);
    refresh();
    return section;
  }

  function renderDoorbellWaiting(waiting) {
    var row = el.mount.querySelector('.rs-doorbell__waiting');
    if (!row) return;
    row.hidden = !waiting.length;
    if (!waiting.length) return;
    row.firstChild.textContent = waiting.length === 1
      ? t('doorbell_waiting_one', { title: waiting[0].title })
      : t('doorbell_waiting_many', { count: number(waiting.length) });
  }

  /* no report shown while some wait: what waits, from which bot, and what
     kind of task each one is; a row opens its report */
  function renderOverview(runs, focusedId) {
    var section = document.createElement('section');
    section.className = 'rs-overview';
    section.setAttribute('data-rs-overview', '');
    section.appendChild(textNode('h2', 'rs-overview__heading', t('overview_title')));
    var list = document.createElement('ul');
    list.className = 'rs-overview__list';
    runs.forEach(function (run) {
      var kindOf = window.RSAsk.kindOf(run, new Date());
      var item = document.createElement('li');
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'rs-overview__item';
      button.setAttribute('data-run-id', run.run_id);
      button.setAttribute('data-ask', run.ask || '');
      button.appendChild(avatarBox(identityOf(run)));
      var text = document.createElement('span');
      text.className = 'rs-overview__text';
      text.appendChild(textNode('span', 'rs-overview__bot', identityOf(run).name));
      text.appendChild(textNode('span', 'rs-overview__title', run.title));
      button.appendChild(text);
      var kind = document.createElement('span');
      kind.className = 'rs-overview__kind';
      kind.setAttribute('data-tone', kindOf.tone);
      var dot = document.createElement('span');
      dot.className = 'rs-dot';
      dot.setAttribute('data-rs-status', '');
      dot.setAttribute('aria-hidden', 'true');
      kind.appendChild(dot);
      kind.appendChild(document.createTextNode(kindOf.text));
      button.appendChild(kind);
      button.setAttribute('aria-label', t('overview_item', { bot: identityOf(run).name, title: run.title, kind: kindOf.text }));
      button.addEventListener('click', function () { activate(run.run_id, { focusTitle: true }); });
      item.appendChild(button);
      list.appendChild(item);
    });
    section.appendChild(list);
    return section;
  }

  // ----------------------------------------------------- bursts -----
  /* One announcement per burst. A burst is the same quiet gap as the
     server's attention (ATTENTION_QUIET_S in core/server.py): arrivals
     less than 30 seconds apart belong together. The page collects the
     first 10 seconds, announces once, and does not announce again until
     that quiet gap has passed. A single arrival names its report; a single
     arrival that is shown at once needs none. Never one toast per report.
     A test client may shorten the quiet gap with ?burst_ms=. That shortened
     gap is a debounce: the announcement waits that long after the latest
     arrival, so a handful of pushes still land in one burst. */
  var BURST_QUIET_MS = 30000;
  var BURST_COLLECT_MS = 10000;
  function burstQuietMs() {
    var test = query.get('client') === 'test';
    return test && /^\d{1,5}$/.test(query.get('burst_ms') || '') ? Number(query.get('burst_ms')) : BURST_QUIET_MS;
  }

  function noteArrivals(fresh, shownId) {
    var now = Date.now();
    var b = state.burst;
    if (b && b.announced) {
      if (now - b.last < burstQuietMs()) {
        b.last = now;
        if (b.timer) clearTimeout(b.timer);
        b.timer = setTimeout(endBurst, burstQuietMs());
        return;
      }
      state.burst = null;
      b = null;
    }
    if (!b) {
      b = state.burst = {
        ids: [], runs: dict(), bots: dict(), botCount: 0, shown: null,
        timer: null, started: now, last: now, announced: false
      };
    }
    fresh.slice().reverse().forEach(function (r) {
      if (b.runs[r.run_id]) return;
      b.ids.push(r.run_id);
      b.runs[r.run_id] = r;
      var k = botKey(r);
      if (!b.bots[k]) { b.bots[k] = identityOf(r).name; b.botCount += 1; }
    });
    b.last = now;
    if (shownId) b.shown = shownId;
    if (b.timer) clearTimeout(b.timer);
    var quiet = burstQuietMs();
    var shortened = query.get('client') === 'test' && query.has('burst_ms');
    var collectEnd = b.started + BURST_COLLECT_MS;
    var wait = shortened ? quiet : Math.max(0, Math.min(quiet, collectEnd - now));
    b.timer = setTimeout(flushBurst, wait);
  }

  function endBurst() {
    var b = state.burst;
    if (!b) return;
    var left = b.last + burstQuietMs() - Date.now();
    if (left > 0) { b.timer = setTimeout(endBurst, left); return; }
    state.burst = null;
  }

  function flushBurst() {
    var b = state.burst;
    if (!b || b.announced || !b.ids.length) {
      if (b && !b.ids.length) state.burst = null;
      return;
    }
    b.announced = true;
    b.timer = null;
    var n = b.ids.length;
    if (n === 1) {
      if (b.shown !== b.ids[0]) toast(t('new_run_arrived', { title: b.runs[b.ids[0]].title }));
    } else if (b.botCount === 1) {
      var only = Object.keys(b.bots)[0];
      toast(t('burst_arrived_bot', { n: number(n), bot: b.bots[only] }));
    } else {
      toast(t('burst_arrived', { n: number(n), k: number(b.botCount) }));
    }
    var left = b.last + burstQuietMs() - Date.now();
    if (left > 0) b.timer = setTimeout(endBurst, left);
    else state.burst = null;
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

    syncOrder(runs);
    var a = state.active;
    if (a && a.state === 'open' && !findRun(a.run_id)) {
      // decided elsewhere (CLI cancel, expiry): fetch its state
      refreshActiveState();
    }
    if (first) {
      // ?run=<id> selects that run (also a decided one); else the newest open run
      var wanted = query.get('run');
      var newestId = runs[0] && !doorbellPage ? runs[0].run_id : null;
      if (wanted || newestId) {
        renderStrip();
        updateTitle();
        activate(wanted || newestId, { fallback: wanted ? newestId : null });
        return;
      }
      showEmpty();
      return;
    }
    /* switching rule: an open report on screen always
       stays, touched or not; an arrival becomes active only when nothing
       open is shown (empty, or the shown report is decided or gone) and no
       other report is loading. The oldest arrival goes first; the rest wait
       in the strip and the burst is announced once (noteArrivals). */
    if (fresh.length) {
      var oldest = fresh[fresh.length - 1];
      /* the doorbell setup page stays until the person opens a report */
      var idle = !doorbellPage && !state.pending && (!a || a.state !== 'open');
      noteArrivals(fresh, idle ? oldest.run_id : null);
      if (idle) { activate(oldest.run_id); return; }
    }
    if (!a && !state.pending) { showEmpty(); return; }
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
  /* The primary sends the footer's decision; a quiet alternative passes
     its own (reject, skipped), which never carries the input's answer. The
     note and the chips go with every decision. */
  function submit(ownedRunId, decision) {
    var a = state.active;
    if (!a || a.state !== 'open' || (ownedRunId && a.run_id !== ownedRunId)) return Promise.resolve(false);
    var id = a.run_id;
    if (state.operations[id] || !state.composer) return Promise.resolve(false);
    var answers = false;
    if (!decision) {
      var f = currentFooter();
      if (!f || !f.primary.enabled) {
        /* an empty request: back to the note, nothing is sent */
        if (f && f.primary.needsNote) { renderBar(); state.composer.focus(); }
        else toast(t('submit_not_ready'));
        return Promise.resolve(false);
      }
      decision = f.primary.decision;
      answers = f.primary.answers;
    }
    var data = { decision: decision, note: state.composer.text().trim(), refs: state.composer.refs() };
    if (answers) {
      var kind = window.RSAsk.inputOf(a);
      var answer = state.input ? state.input.answer() : null;
      if (!kind || answer == null) { toast(t('submit_not_ready')); return Promise.resolve(false); }
      data.blocks = {};
      data.blocks[kind.id] = answer;
    }
    var successors = successorsOf(id);
    var token = beginOperation(id, 'submit');
    return post('/submit', { run_id: id, data: data }).then(function (r) {
      var operation = finishOperation(id, token);
      if (r.ok) {
        if (operation) clearDraftIfUnchanged(id, operation.draft);
        /* the decided banner words what was sent (a pick or new options) */
        a.result = data;
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
    /* the menu closes; the confirmation returns focus to its button */
    closeMore();
    el.moreBtn.focus({ preventScroll: true });
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
      /* the menu closed when the confirmation opened: back to its button */
      var focused = document.activeElement;
      if (!focused || focused === document.body || el.discardDialog.contains(focused) || focused === el.discard) {
        el.moreBtn.focus();
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
    /* `doorbell setup` while this window is open: show the setup page here;
       open reports stay in the strip */
    es.addEventListener('page', function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || msg.page !== 'doorbell') return;
      doorbellPage = true;
      showEmpty();
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
    /* Escape leaves a request (as Cancel does) */
    if (e.key === 'Escape' && state.mode !== 'decide' && state.active && state.active.state === 'open' && !activeBusy()) {
      e.preventDefault();
      setMode('decide');
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
      var g = stripGroups()[Number(m[1]) - 1];
      if (!g) return;
      e.preventDefault();
      var target = groupTarget(g);
      if (target && target !== state.activeId) activate(target, { focusTitle: true });
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
      alts: [document.getElementById('rs-alt'), document.getElementById('rs-alt-2')],
      title: document.getElementById('rs-title'),
      meta: document.getElementById('rs-meta'),
      bot: document.getElementById('rs-bot'),
      botAvatar: document.getElementById('rs-bot-avatar'),
      botName: document.getElementById('rs-bot-name'),
      task: document.getElementById('rs-task'),
      taskInner: document.getElementById('rs-task-inner'),
      theme: document.getElementById('rs-theme'),
      mount: document.getElementById('rs-mount'),
      bar: document.getElementById('rs-submitbar'),
      status: document.getElementById('rs-status'),
      submit: document.getElementById('rs-submit'),
      submitLabel: document.getElementById('rs-submit-label'),
      actions: document.getElementById('rs-actions'),
      composerSlot: document.getElementById('rs-composer'),
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
    el.alts.forEach(function (button, i) {
      button.addEventListener('click', function () { onAlt(i); });
    });

    el.theme.setAttribute('aria-pressed', effectiveTheme() === 'dark' ? 'true' : 'false');
    el.theme.addEventListener('click', function () {
      var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
      el.theme.setAttribute('aria-pressed', next === 'dark' ? 'true' : 'false');
    });

    el.mount.addEventListener('click', activateLink);
    el.mount.addEventListener('auxclick', activateLink);
    el.mount.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter') return;
      var anchor = linkFromEvent(event);
      if (!anchor) return;
      event.preventDefault();
      /* Ctrl+Enter and Cmd+Enter stay the submit shortcut. They must not
         navigate and must not open the link. */
      if (event.ctrlKey || event.metaKey) return;
      event.stopPropagation();
      openLink(anchor.getAttribute('href'));
    });
    el.mount.addEventListener('mousedown', function (event) {
      if (event.button === 1 && linkFromEvent(event)) event.preventDefault();
    });
    el.mount.addEventListener('dragstart', function (event) {
      if (linkFromEvent(event)) event.preventDefault();
    });
    el.mount.addEventListener('contextmenu', function (event) {
      if (linkFromEvent(event)) event.preventDefault();
    });
    function externalUrlDrop(event) {
      var transfer = event.dataTransfer;
      if (!transfer || !transfer.types) return false;
      var types = Array.prototype.slice.call(transfer.types);
      if (types.indexOf('text/uri-list') < 0) return false;
      var target = event.target;
      if (target && target.closest && target.closest('input, textarea, [contenteditable="true"]')) return false;
      return true;
    }
    document.addEventListener('dragover', function (event) {
      if (externalUrlDrop(event)) event.preventDefault();
    });
    document.addEventListener('drop', function (event) {
      if (externalUrlDrop(event)) event.preventDefault();
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
    t: t,
    time: time,
    date: date,
    number: number,
    count: count,
    copy: copy,
    copyImage: copyImage,
    copyPath: copyPath,
    toast: toast,
    media: media,
    reveal: reveal,
    openUrl: openUrl,
    fillText: fillText,
    appendLinks: appendLinks,
    externalLink: externalLink,
    submit: function () { return submit(); },
    get activeRun() { return state.activeId; },
    get touched() { return state.touched; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
