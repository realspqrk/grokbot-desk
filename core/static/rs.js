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
  }

  // ------------------------------------------------------------- time --
  var WEEKDAYS = { Mon: 'Mo', Tue: 'Di', Wed: 'Mi', Thu: 'Do', Fri: 'Fr', Sat: 'Sa', Sun: 'So' };
  var timeFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Vienna', weekday: 'short', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  function viennaParts(iso) {
    var d = iso instanceof Date ? iso : new Date(iso);
    if (isNaN(d.getTime())) return null;
    var p = {};
    timeFmt.formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
    return p;
  }
  /** "Do 08.10.2026 · 10:39" in Europe/Vienna. */
  function time(iso) {
    var p = viennaParts(iso);
    if (!p) return '';
    return WEEKDAYS[p.weekday] + ' ' + p.day + '.' + p.month + '.' + p.year + ' ' + t('sep') + ' ' + p.hour + ':' + p.minute;
  }
  /** Rail: "10:39" for today (Vienna), else "Mi 07.10.". */
  function shortTime(iso) {
    var p = viennaParts(iso);
    var now = viennaParts(new Date());
    if (!p) return '';
    if (now && p.year === now.year && p.month === now.month && p.day === now.day) return p.hour + ':' + p.minute;
    return WEEKDAYS[p.weekday] + ' ' + p.day + '.' + p.month + '.';
  }

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
    pending: null,     // run id being loaded
    discardTarget: null, // run id the open Verwerfen confirmation is about
    reading: {},       // run id -> true while POST /read is in flight
    requestGen: 0,     // activation request order; stale responses are ignored
    templateGen: 0     // rendered-template lifetime; stale template calls are ignored
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
      renderRail();
      updateTitle();
    }, function () { delete state.reading[id]; });
  }

  function findRun(id) {
    for (var i = 0; i < state.runs.length; i++) if (state.runs[i].run_id === id) return state.runs[i];
    return null;
  }

  // ------------------------------------------------------------- rail --
  function railEntries() {
    var list = state.runs.slice(0, 12);
    var a = state.active;
    if (a && a.state !== 'open' && !findRun(a.run_id)) {
      list = [{ run_id: a.run_id, title: a.title, bot_display: a.bot_display, created: a.created, state: a.state, unread: false }].concat(list).slice(0, 12);
    }
    return list;
  }

  function renderRail() {
    var list = railEntries();
    el.rail.textContent = '';
    var n = 0;
    list.forEach(function (run) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'rs-rail__run';
      b.setAttribute('data-run-id', run.run_id);
      b.setAttribute('data-state', run.state);
      if (run.run_id === state.activeId) b.setAttribute('aria-current', 'true');
      var title = document.createElement('span');
      title.className = 'rs-rail__title';
      title.textContent = run.title;
      var meta = document.createElement('span');
      meta.className = 'rs-rail__meta';
      meta.textContent = run.bot_display + ' ' + t('sep') + ' ' + shortTime(run.created);
      var aside = document.createElement('span');
      aside.className = 'rs-rail__aside';
      if (run.state !== 'open') {
        var sb = document.createElement('rs-badge');
        sb.setAttribute('variant', run.state === 'submitted' ? 'ok' : 'neutral');
        sb.textContent = t('run_state_' + run.state);
        aside.appendChild(sb);
      } else {
        n += 1;
        if (run.unread && run.run_id !== state.activeId) {
          var nb = document.createElement('rs-badge');
          nb.setAttribute('variant', 'warn');
          nb.textContent = t('new');
          aside.appendChild(nb);
        }
        if (n <= 9) {
          var key = document.createElement('span');
          key.className = 'rs-rail__key';
          key.textContent = t('rail_shortcut', { n: n });
          aside.appendChild(key);
          b.setAttribute('aria-keyshortcuts', 'Alt+' + n);
          b.setAttribute('data-rail-index', String(n));
        }
      }
      b.appendChild(title);
      b.appendChild(meta);
      b.appendChild(aside);
      b.addEventListener('click', function () { activate(run.run_id); });
      li.appendChild(b);
      el.rail.appendChild(li);
    });
    el.railEmpty.hidden = list.length > 0;
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
      if (!button.closest('rs-copy') && !navigation) button.disabled = true;
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
    var s = state.status;
    el.status.textContent = s ? s.text : '';
    if (s && s.tone) el.status.setAttribute('data-tone', s.tone); else el.status.removeAttribute('data-tone');
    el.bar.hidden = !a;
  }

  function setBanner(kind) {
    var mount = el.mount;
    var old = mount.querySelector(':scope > .rs-banner');
    if (old) old.remove();
    if (!kind) return;
    var b = document.createElement('p');
    b.className = 'rs-banner';
    b.setAttribute('data-banner', kind);
    if (kind === 'submitted') { b.setAttribute('data-tone', 'ok'); b.textContent = t('sent'); }
    else if (kind === 'expired') { b.setAttribute('data-tone', 'warn'); b.textContent = t('run_expired_msg'); }
    else if (kind === 'cancelled') { b.textContent = t('run_cancelled_msg'); }
    mount.insertBefore(b, mount.firstChild);
  }

  function applyLock(root) {
    lockDecisionControls(root, true);
  }

  function lockTemplate() {
    var root = el.mount.querySelector('.rs-tpl');
    if (!root || root.hasAttribute('data-rs-locked')) return;
    root.setAttribute('data-rs-locked', '');
    applyLock(root);
    new MutationObserver(function () { applyLock(root); }).observe(root, { childList: true, subtree: true });
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
    renderRail();
    updateTitle();
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
        result: run.result === undefined ? null : run.result
      },
      t: t,
      time: time,
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
      submit: function () { return live() ? submit(run.run_id) : Promise.resolve(false); }
    };
  }

  function activate(runId, opts) {
    opts = opts || {};
    if (!runId) return Promise.resolve();
    state.requestGen += 1;
    var requestGen = state.requestGen;
    state.pending = runId;
    setReady(false);
    return request('GET', '/api/run/' + encodeURIComponent(runId)).then(function (r) {
      if (requestGen !== state.requestGen) return;
      state.pending = null;
      if (!r.ok) {
        if (opts.fallback && opts.fallback !== runId) { activate(opts.fallback); return; }
        if (state.active) setReady(true); else showEmpty();
        toast(t('run_load_failed'));
        return;
      }
      var run = r.body;
      state.templateGen += 1;
      var templateGen = state.templateGen;
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

      el.title.textContent = run.title;
      el.meta.textContent = '';
      var bot = document.createElement('span');
      bot.textContent = run.bot_display;
      var sep = document.createElement('span');
      sep.setAttribute('aria-hidden', 'true');
      sep.textContent = t('sep');
      var created = document.createElement('span');
      created.textContent = t('created_at', { time: run.created_display || time(run.created) });
      el.meta.appendChild(bot);
      el.meta.appendChild(sep);
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
      renderBar();
      renderRail();
      updateTitle();
      maybeMarkRead();
      // the window may get focus a moment after the run renders
      setTimeout(maybeMarkRead, 300);
      if (opts.focusTitle) el.title.focus();
      setReady(true);
    }, function () {
      if (requestGen === state.requestGen) {
        state.pending = null;
        setReady(true);
        toast(t('run_load_failed'));
      }
    });
  }

  function showEmpty() {
    state.requestGen += 1;
    state.templateGen += 1;
    state.pending = null;
    state.active = null;
    state.activeId = null;
    state.result = null;
    state.touched = false;
    state.listeners = [];
    el.title.textContent = '';
    el.meta.textContent = '';
    el.mount.textContent = '';
    var p = document.createElement('p');
    p.className = 'rs-empty';
    p.textContent = t('no_runs');
    el.mount.appendChild(p);
    renderBar();
    renderRail();
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
        renderRail();
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
    renderRail();
    updateTitle();
  }

  function refreshActiveState() {
    var a = state.active;
    if (!a) return;
    var id = a.run_id;
    request('GET', '/api/run/' + encodeURIComponent(id)).then(function (r) {
      if (r.ok && state.active && state.active.run_id === id && r.body.state !== 'open') showDecided(r.body.state);
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
    var token = beginOperation(id, 'submit');
    return post('/submit', { run_id: id, data: data }).then(function (r) {
      var operation = finishOperation(id, token);
      if (r.ok) {
        if (operation) clearDraftIfUnchanged(id, operation.draft);
        if (state.active && state.active.run_id === id) showDecided('submitted');
        if (state.activeId === id) toast(t('sent'));
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
    var token = beginOperation(id, 'cancel');
    post('/cancel', { run_id: id }).then(function (r) {
      finishOperation(id, token);
      if (r.ok) {
        draftSet(id, null);
        if (state.active && state.active.run_id === id) showDecided('cancelled');
        if (state.activeId === id) toast(t('discarded'));
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
    var url = '/events?sid=' + sid + (query.get('client') === 'test' ? '&client=test' : '');
    var es = new EventSource(url);
    var lost = false;
    es.addEventListener('runs', function (ev) {
      try { applyRuns(JSON.parse(ev.data).runs || []); } catch (e) { console.error(e); }
    });
    es.addEventListener('run', function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.state !== 'open') closeDiscardFor(msg.run_id);
      if (state.active && msg.run_id === state.active.run_id && msg.state !== 'open' && state.active.state === 'open') {
        showDecided(msg.state);
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
    if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key === 'Enter') {
      e.preventDefault();
      submit();
      return;
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      var m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code || '');
      if (!m) return;
      var btn = el.rail.querySelector('[data-rail-index="' + m[1] + '"]');
      if (!btn) return;
      e.preventDefault();
      var id = btn.getAttribute('data-run-id');
      if (id !== state.activeId) activate(id, { focusTitle: true });
    }
  }

  function start() {
    el = {
      title: document.getElementById('rs-title'),
      meta: document.getElementById('rs-meta'),
      theme: document.getElementById('rs-theme'),
      rail: document.getElementById('rs-rail'),
      railEmpty: document.getElementById('rs-rail-empty'),
      mount: document.getElementById('rs-mount'),
      bar: document.getElementById('rs-submitbar'),
      status: document.getElementById('rs-status'),
      submit: document.getElementById('rs-submit'),
      submitLabel: document.getElementById('rs-submit-label'),
      discard: document.getElementById('rs-discard'),
      toasts: document.getElementById('rs-toasts'),
      discardDialog: document.getElementById('rs-discard-dialog')
    };
    fillStrings(document.body);
    pruneDrafts();

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

    document.addEventListener('keydown', onKey);
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
