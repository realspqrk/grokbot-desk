/* grokbot-desk core components (spec 4.3, 5.2).
 *
 * Light DOM only (no shadow DOM), so tokens, shell.css, axe and the text
 * checks reach every node. Styles live in shell.css. Components talk to the
 * core only through window.RS: RS.t, RS.copy, RS.toast, RS.count.
 * Elements: rs-card, rs-action-row, rs-copy, rs-badge, rs-counter,
 * rs-post-frame, rs-confirm. API reference: see docs/GUIDE.md.
 */
(function () {
  'use strict';

  // The only URL-like string in the core UI: the SVG namespace, needed by
  // createElementNS. It is never fetched.
  var SVG_NS = 'http://www.w3.org/2000/svg';

  var uidN = 0;
  function uid(prefix) { uidN += 1; return prefix + '-' + uidN; }

  function t(key, params) {
    var R = window.RS;
    return R && typeof R.t === 'function' ? R.t(key, params) : key;
  }

  function h(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    el.setAttribute('data-rs-part', '');
    return el;
  }

  function s(tag, attrs) {
    var el = document.createElementNS(SVG_NS, tag);
    if (attrs) for (var k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  // A property set before the element was upgraded shadows the class
  // accessor; re-apply it through the setter.
  function upgradeProps(el, names) {
    names.forEach(function (n) {
      if (Object.prototype.hasOwnProperty.call(el, n)) {
        var v = el[n];
        delete el[n];
        el[n] = v;
      }
    });
  }

  function nf(n) {
    return new Intl.NumberFormat('de-DE').format(n);
  }

  // ---------------------------------------------------------------- icons --
  var ICONS = {
    reply: [['path', { d: 'M4.5 12a7.5 7.5 0 1 1 3.4 6.3L4 19.5l1.3-3.6A7.5 7.5 0 0 1 4.5 12z' }]],
    repost: [['path', { d: 'M7 4 4 7l3 3M4 7h11a3 3 0 0 1 3 3v1M17 20l3-3-3-3M20 17H9a3 3 0 0 1-3-3v-1' }]],
    heart: [['path', { d: 'M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2z' }]],
    views: [['path', { d: 'M5 20v-6M10 20V9M15 20v-8M20 20V5' }]],
    bookmark: [['path', { d: 'M6.5 3.5h11v17l-5.5-4-5.5 4z' }]],
    upload: [['path', { d: 'M12 3v12M7.5 7.5 12 3l4.5 4.5M5 14v5.5h14V14' }]],
    send: [['path', { d: 'M21 3 3 10.5l7 3 3 7.5zM10 13.5 21 3' }]],
    thumb: [['path', { d: 'M7 10.5v9.5H3.5v-9.5zM7 10.5l3.6-6.8c1.5 0 2.4 1.1 2.1 2.6l-.5 3.2h6.3a2 2 0 0 1 2 2.3l-1.1 6.4a2 2 0 0 1-2 1.8H7' }]],
    bubble: [['path', { d: 'M4 5h16v11H9l-5 4z' }]],
    share: [['path', { d: 'M14 5l7 6.5-7 6.5v-4c-5 0-8.5 1.5-11 5 1-5 4-9.5 11-10z' }]],
    globe: [['circle', { cx: '12', cy: '12', r: '8.5' }], ['path', { d: 'M3.5 12h17M12 3.5c2.4 2.6 2.4 14.4 0 17M12 3.5c-2.4 2.6-2.4 14.4 0 17' }]],
    image: [['rect', { x: '3.5', y: '4.5', width: '17', height: '15', rx: '2' }], ['circle', { cx: '9', cy: '10', r: '1.8' }], ['path', { d: 'M3.5 17l5-4.5 4 3.5 3-2.5 5 4' }]],
    more: [['circle', { cx: '5', cy: '12', r: '1.6', 'class': 'rs-ico-fill' }], ['circle', { cx: '12', cy: '12', r: '1.6', 'class': 'rs-ico-fill' }], ['circle', { cx: '19', cy: '12', r: '1.6', 'class': 'rs-ico-fill' }]]
  };

  function icon(name, cls) {
    var svg = s('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false', 'class': 'rs-ico' + (cls ? ' ' + cls : '') });
    ICONS[name].forEach(function (d) { svg.appendChild(s(d[0], d[1])); });
    return svg;
  }

  function logo(skin) {
    var svg = s('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false', 'class': 'rs-pf-logo rs-pf-logo--' + skin });
    if (skin === 'x') {
      svg.appendChild(s('path', { 'class': 'rs-pf-logo__fg', d: 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z' }));
    } else if (skin === 'linkedin') {
      svg.appendChild(s('rect', { 'class': 'rs-pf-logo__bg', x: '2', y: '2', width: '20', height: '20', rx: '3' }));
      svg.appendChild(s('circle', { 'class': 'rs-pf-logo__fg', cx: '7.3', cy: '7.2', r: '1.75' }));
      svg.appendChild(s('rect', { 'class': 'rs-pf-logo__fg', x: '5.8', y: '9.6', width: '3', height: '8.6' }));
      svg.appendChild(s('path', { 'class': 'rs-pf-logo__fg', d: 'M10.9 9.6h2.85v1.25c.45-.8 1.55-1.5 3.05-1.5 3 0 3.5 1.9 3.5 4.4v4.45h-2.95v-3.95c0-1.05-.05-2.35-1.45-2.35-1.45 0-1.7 1.1-1.7 2.25v4.05H10.9z' }));
    } else if (skin === 'instagram') {
      var gid = uid('rs-ig-grad');
      var defs = s('defs');
      var g = s('linearGradient', { id: gid, x1: '0', y1: '1', x2: '1', y2: '0' });
      [0, 25, 50, 75, 100].forEach(function (off, i) {
        g.appendChild(s('stop', { offset: off + '%', 'class': 'rs-ig-stop-' + (i + 1) }));
      });
      defs.appendChild(g);
      svg.appendChild(defs);
      var paint = 'url(#' + gid + ')';
      svg.appendChild(s('rect', { x: '3', y: '3', width: '18', height: '18', rx: '5.2', fill: 'none', stroke: paint, 'stroke-width': '2' }));
      svg.appendChild(s('circle', { cx: '12', cy: '12', r: '4.1', fill: 'none', stroke: paint, 'stroke-width': '2' }));
      svg.appendChild(s('circle', { cx: '17.1', cy: '6.9', r: '1.25', fill: paint }));
    } else if (skin === 'facebook') {
      svg.appendChild(s('circle', { 'class': 'rs-pf-logo__bg', cx: '12', cy: '12', r: '10' }));
      svg.appendChild(s('path', { 'class': 'rs-pf-logo__fg', d: 'M15.6 12.9l.45-2.9h-2.8V8.15c0-.8.4-1.6 1.65-1.6h1.25V4.1s-1.15-.2-2.25-.2c-2.3 0-3.8 1.4-3.8 3.9V10H7.55v2.9h2.55V22h3.15v-9.1z' }));
    }
    return svg;
  }

  // ----------------------------------------------------------------- base --
  function define(name, cls) {
    if (!customElements.get(name)) customElements.define(name, cls);
  }

  // ============================================================== rs-card ==
  // Attributes: heading (text), level (2-4, default 3), variant (plain|warn|ok|quiet).
  class RsCard extends HTMLElement {
    static get observedAttributes() { return ['heading', 'level']; }
    connectedCallback() { this._render(); }
    attributeChangedCallback() { if (this.isConnected) this._render(); }
    _render() {
      var text = this.getAttribute('heading');
      var level = Math.min(4, Math.max(2, parseInt(this.getAttribute('level') || '3', 10) || 3));
      var head = this.querySelector(':scope > .rs-card__heading[data-rs-part]');
      if (!text) {
        if (head) head.remove();
        if (this.getAttribute('role') === 'group' && this._ownRole) {
          this.removeAttribute('role');
          this.removeAttribute('aria-labelledby');
        }
        return;
      }
      if (!head || head.tagName !== 'H' + level) {
        if (head) head.remove();
        head = h('h' + level, 'rs-card__heading');
        head.id = uid('rs-card-h');
        this.insertBefore(head, this.firstChild);
      }
      head.textContent = text;
      if (!this.hasAttribute('role') || this._ownRole) {
        this._ownRole = true;
        this.setAttribute('role', 'group');
        this.setAttribute('aria-labelledby', head.id);
      }
    }
  }

  // ======================================================== rs-action-row ==
  // Children: <button value="…">label</button> (or the `options` property).
  // Attributes: label (accessible name), value (selected value), disabled.
  // Property: value, options = [{value, label}]. Event: change {detail:{value}}.
  class RsActionRow extends HTMLElement {
    static get observedAttributes() { return ['label', 'value', 'disabled']; }
    constructor() {
      super();
      this._value = '';
      this._onKey = this._onKey.bind(this);
      this._onClick = this._onClick.bind(this);
    }
    connectedCallback() {
      upgradeProps(this, ['value', 'options']);
      if (!this._init) {
        this._init = true;
        this.setAttribute('role', 'radiogroup');
        this.addEventListener('keydown', this._onKey);
        this.addEventListener('click', this._onClick);
        var self = this;
        this._mo = new MutationObserver(function () { self._sync(); });
      }
      this._mo.observe(this, { childList: true });
      if (this.hasAttribute('value')) this._value = this.getAttribute('value');
      this._sync();
    }
    disconnectedCallback() { if (this._mo) this._mo.disconnect(); }
    attributeChangedCallback(name, oldV, newV) {
      if (name === 'value') this._value = newV || '';
      if (this._init) this._sync();
    }
    get buttons() {
      return Array.prototype.filter.call(this.children, function (c) { return c.tagName === 'BUTTON'; });
    }
    get value() { return this._value; }
    set value(v) { this._set(v === null || v === undefined ? '' : String(v), false); }
    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
    set options(list) {
      this.buttons.forEach(function (b) { b.remove(); });
      var self = this;
      (list || []).forEach(function (o) {
        var b = document.createElement('button');
        b.value = o.value;
        b.textContent = o.label;
        self.appendChild(b);
      });
      this._sync();
    }
    get options() {
      return this.buttons.map(function (b) { return { value: b.value, label: b.textContent }; });
    }
    _set(v, emit) {
      if (v === this._value) return;
      this._value = v;
      if (v) this.setAttribute('value', v); else this.removeAttribute('value');
      this._sync();
      if (emit) this.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: { value: v } }));
    }
    _sync() {
      var label = this.getAttribute('label');
      if (label) this.setAttribute('aria-label', label);
      var dis = this.disabled;
      if (dis) this.setAttribute('aria-disabled', 'true'); else this.removeAttribute('aria-disabled');
      var btns = this.buttons;
      var v = this._value;
      var hasSel = btns.some(function (b) { return b.value === v && v !== ''; });
      btns.forEach(function (b, i) {
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.classList.add('rs-choice');
        var on = hasSel && b.value === v;
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = (on || (!hasSel && i === 0)) ? 0 : -1;
        b.disabled = dis;
      });
    }
    _onClick(e) {
      var b = e.target.closest('button');
      if (!b || b.parentNode !== this || this.disabled) return;
      this._set(b.value, true);
      b.focus();
    }
    _onKey(e) {
      var b = e.target.closest('button');
      if (!b || b.parentNode !== this || this.disabled) return;
      var btns = this.buttons;
      var i = btns.indexOf(b);
      var n = btns.length;
      var j = -1;
      switch (e.key) {
        case 'ArrowRight': case 'ArrowDown': j = (i + 1) % n; break;
        case 'ArrowLeft': case 'ArrowUp': j = (i - 1 + n) % n; break;
        case 'Home': j = 0; break;
        case 'End': j = n - 1; break;
        default: return;
      }
      e.preventDefault();
      this._set(btns[j].value, true);
      btns[j].focus();
    }
  }

  // ============================================================== rs-copy ==
  // Attributes: label (button text, default "Kopieren"), text (string to copy),
  // mono (monospace value), max-lines (N: value box scrolls after N lines),
  // no-value (hide the value; ONLY when the exact string is visible right
  // next to the button anyway, e.g. the post text in rs-post-frame).
  // Property: text. Event: rs-copy {detail:{ok, busy}}. data-state: idle|working|copied|busy|error.
  class RsCopy extends HTMLElement {
    static get observedAttributes() { return ['label', 'text', 'no-value', 'max-lines', 'mono']; }
    constructor() {
      super();
      this._text = null;
      this._timer = 0;
    }
    connectedCallback() {
      upgradeProps(this, ['text']);
      if (!this._built) this._build();
      this._render();
    }
    attributeChangedCallback() { if (this._built) this._render(); }
    get text() { return this._text !== null ? this._text : (this.getAttribute('text') || ''); }
    set text(v) { this._text = v === null || v === undefined ? '' : String(v); if (this._built) this._render(); }
    get state() { return this.getAttribute('data-state') || 'idle'; }
    _build() {
      this._built = true;
      this.setAttribute('data-state', 'idle');
      var btn = h('button', 'rs-copy__btn');
      btn.type = 'button';
      this._label = h('span', 'rs-copy__label');
      this._done = h('span', 'rs-copy__done', t('copied'));
      btn.appendChild(this._label);
      btn.appendChild(this._done);
      this._btn = btn;
      this._val = h('span', 'rs-copy__value');
      this._val.id = uid('rs-copy-v');
      this._msg = h('span', 'rs-copy__msg');
      this._msg.hidden = true;
      this.appendChild(btn);
      this.appendChild(this._val);
      this.appendChild(this._msg);
      var self = this;
      btn.addEventListener('click', function () { self._copy(); });
    }
    _render() {
      this._label.textContent = this.getAttribute('label') || t('copy');
      var noValue = this.hasAttribute('no-value');
      this._val.hidden = noValue;
      this._val.textContent = this.text;
      this._val.classList.toggle('rs-copy__value--mono', this.hasAttribute('mono'));
      var lines = parseInt(this.getAttribute('max-lines') || '0', 10);
      if (lines > 0 && !noValue) {
        this._val.style.setProperty('--rs-copy-lines', String(lines));
        this._val.classList.add('rs-copy__value--clamp');
        this._val.tabIndex = 0;
        this._val.setAttribute('role', 'region');
        this._val.setAttribute('aria-label', this._label.textContent);
      } else {
        this._val.style.removeProperty('--rs-copy-lines');
        this._val.classList.remove('rs-copy__value--clamp');
        this._val.removeAttribute('tabindex');
        this._val.removeAttribute('role');
        this._val.removeAttribute('aria-label');
      }
      if (noValue) this._btn.removeAttribute('aria-describedby');
      else this._btn.setAttribute('aria-describedby', this._val.id);
    }
    _state(st) {
      this.setAttribute('data-state', st);
    }
    _copy() {
      var R = window.RS;
      if (this.state === 'working' || !R || typeof R.copy !== 'function') return;
      clearTimeout(this._timer);
      this._msg.hidden = true;
      this._msg.textContent = '';
      this._state('working');
      var self = this;
      var done = function (res) {
        res = res || { ok: false };
        if (res.ok) {
          self._state('copied');
          if (R.toast) R.toast(t('copied'));
          self._timer = setTimeout(function () { self._state('idle'); }, 1500);
        } else if (res.busy) {
          self._state('busy');
          self._msg.textContent = t('clipboard_busy');
          self._msg.hidden = false;
          if (R.toast) R.toast(t('clipboard_busy'));
        } else {
          self._state('error');
          self._msg.textContent = t('copy_failed');
          self._msg.hidden = false;
          if (R.toast) R.toast(t('copy_failed'));
        }
        self.dispatchEvent(new CustomEvent('rs-copy', { bubbles: true, detail: { ok: !!res.ok, busy: !!res.busy } }));
      };
      Promise.resolve().then(function () { return R.copy(self.text); }).then(done, function () { done({ ok: false }); });
    }
  }

  // ============================================================= rs-badge ==
  // Attribute: variant (neutral|warn|danger|ok). Content: its text.
  class RsBadge extends HTMLElement {
    connectedCallback() {
      if (!this.hasAttribute('variant')) this.setAttribute('variant', 'neutral');
    }
  }

  // =========================================================== rs-counter ==
  // Attributes: value, limit (numbers) or platform + property text (uses
  // RS.count); kind (chars|hashtags). Reflects `over` (boolean attribute).
  class RsCounter extends HTMLElement {
    static get observedAttributes() { return ['value', 'limit', 'platform', 'kind']; }
    constructor() { super(); this._text = null; }
    connectedCallback() {
      upgradeProps(this, ['text']);
      if (!this._built) {
        this._built = true;
        this._num = h('span', 'rs-counter__num');
        this._num.setAttribute('aria-hidden', 'true');
        this._over = h('span', 'rs-counter__over');
        this._over.setAttribute('aria-hidden', 'true');
        this._sr = h('span', 'rs-vh');
        this.appendChild(this._num);
        this.appendChild(this._over);
        this.appendChild(this._sr);
      }
      this._render();
    }
    attributeChangedCallback() { if (this._built) this._render(); }
    get text() { return this._text; }
    set text(v) { this._text = v === null || v === undefined ? null : String(v); if (this._built) this._render(); }
    get over() { return this.hasAttribute('over'); }
    get result() { return this._result || null; }
    _render() {
      var kind = this.getAttribute('kind') === 'hashtags' ? 'hashtags' : 'chars';
      var value, limit;
      var platform = this.getAttribute('platform');
      if (platform && this._text !== null && window.RS && RS.count) {
        var r = RS.count(this._text, platform);
        this._result = r;
        value = kind === 'hashtags' ? r.hashtags : r.count;
        limit = kind === 'hashtags' ? r.hashtagLimit : r.limit;
      } else {
        value = parseInt(this.getAttribute('value') || '0', 10) || 0;
        limit = parseInt(this.getAttribute('limit') || '0', 10) || 0;
      }
      var over = limit > 0 && value > limit;
      var n = over ? value - limit : 0;
      this._num.textContent = t('counter_value', { value: nf(value), limit: nf(limit) });
      this._over.textContent = over ? t('counter_over', { n: nf(n) }) : '';
      this._over.hidden = !over;
      var base = kind === 'hashtags' ? 'counter_hashtags_label' : 'counter_label';
      this._sr.textContent = t(over ? base + '_over' : base, { value: nf(value), limit: nf(limit), n: nf(n) });
      if (over) this.setAttribute('over', ''); else this.removeAttribute('over');
    }
  }

  // ======================================================== rs-post-frame ==
  // Attributes: skin (x|linkedin|instagram|facebook), ratio (1:1|4:5|1.91:1|16:9).
  // Child slots (any element with slot="…"): avatar (img), name, handle,
  // headline, text, image (img), link-title, link-domain. Method refresh().
  var SKIN_ABBR = { x: 'x', linkedin: 'li', instagram: 'ig', facebook: 'fb' };
  var RATIOS = { '1:1': '1 / 1', '4:5': '4 / 5', '1.91:1': '1.91 / 1', '16:9': '16 / 9' };
  var TAG_RE = /(^|[^\p{L}\p{M}\p{N}_&#])(#+[\p{L}\p{M}\p{N}_]+)|(https?:\/\/\S+[^\s.,;:!?'")\]}>])/gu;
  var HL = {};

  function highlight(name) {
    if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return null;
    if (!HL[name]) { HL[name] = new Highlight(); CSS.highlights.set(name, HL[name]); }
    return HL[name];
  }

  function initials(text) {
    var parts = (text || '').trim().replace(/^@/, '').split(/\s+/).filter(Boolean);
    var out = parts.slice(0, 2).map(function (p) { return Array.from(p)[0] || ''; }).join('');
    return out.toUpperCase();
  }

  class RsPostFrame extends HTMLElement {
    static get observedAttributes() { return ['skin', 'ratio']; }
    constructor() {
      super();
      this._slots = {};
      this._ranges = [];
      this._rendering = false;
      this._retryN = 0;
    }
    connectedCallback() {
      var self = this;
      if (!this._mo) {
        this._mo = new MutationObserver(function () { if (!self._rendering) self._render(); });
        this._textMo = new MutationObserver(function () { self._decorate(); });
        this._ro = new ResizeObserver(function () { self._placeMarker(); });
      }
      this._render();
      this._mo.observe(this, { childList: true });
    }
    disconnectedCallback() {
      this._mo.disconnect();
      this._textMo.disconnect();
      this._ro.disconnect();
      this._clearRanges();
    }
    attributeChangedCallback() { if (this.isConnected && this._mo) this._render(); }
    get skin() {
      var v = this.getAttribute('skin');
      return SKIN_ABBR[v] ? v : 'x';
    }
    refresh() { this._decorate(); }

    _collect() {
      var self = this;
      Array.prototype.slice.call(this.children).forEach(function (c) {
        if (c.hasAttribute('slot') && !c.hasAttribute('data-rs-part')) self._slots[c.getAttribute('slot')] = c;
      });
      // forget slotted nodes the template removed
      Object.keys(this._slots).forEach(function (k) {
        if (!self.contains(self._slots[k])) delete self._slots[k];
      });
    }

    _render() {
      this._rendering = true;
      try {
        this._collect();
        var slots = this._slots;
        Object.keys(slots).forEach(function (k) { if (slots[k].parentNode) slots[k].parentNode.removeChild(slots[k]); });
        Array.prototype.slice.call(this.children).forEach(function (c) {
          if (c.hasAttribute('data-rs-part')) c.remove();
        });
        this._textMo.disconnect();
        this._ro.disconnect();
        this._clearRanges();

        var skin = this.skin;
        this.setAttribute('role', 'group');
        var chrome = h('div', 'rs-pf__chrome');
        chrome.appendChild(logo(skin));
        var pname = h('span', 'rs-pf__platform', t('platform_' + skin));
        pname.id = uid('rs-pf-name');
        chrome.appendChild(pname);
        this.setAttribute('aria-label', t('preview_label', { platform: t('platform_' + skin) }));
        this.appendChild(chrome);

        var post = h('div', 'rs-pf__post');
        this.appendChild(post);
        var bin = h('div', 'rs-pf__bin');
        bin.hidden = true;
        this.appendChild(bin);

        var parts = this['_build_' + skin](post);
        this._parts = parts;
        this._textBox = parts.text;
        var used = {};
        Object.keys(parts.targets).forEach(function (name) {
          var el = slots[name];
          if (el) { parts.targets[name].appendChild(el); used[name] = true; }
        });
        Object.keys(slots).forEach(function (k) { if (!used[k]) bin.appendChild(slots[k]); });

        // avatar fallback: initials
        var nameEl = slots.name || slots.handle;
        if (parts.avatar) this._prepareAvatar(slots.avatar, nameEl);
        // media: ratio + empty state
        if (parts.media) {
          var ratio = RATIOS[this.getAttribute('ratio')] || (skin === 'instagram' ? '1 / 1' : '16 / 9');
          parts.media.style.setProperty('--rs-pf-ratio', ratio);
          if (slots.image) {
            this._prepareImage(slots.image);
          } else {
            this.removeAttribute('data-image-state');
            if (skin === 'instagram') {
              parts.media.classList.add('rs-pf__media--empty');
              parts.media.appendChild(icon('image', 'rs-pf__empty-ico'));
              parts.media.appendChild(h('span', 'rs-pf__empty-text', t('pf_no_image')));
            } else {
              parts.media.hidden = true;
            }
          }
        }
        if (parts.link && !slots['link-title'] && !slots['link-domain']) parts.link.hidden = true;
        if (parts.captionName) {
          var capEl = slots.handle || slots.name;
          parts.captionName.textContent = capEl ? capEl.textContent : '';
        }

        if (slots.text) this._textMo.observe(slots.text, { childList: true, subtree: true, characterData: true });
        if (this._textBox) this._ro.observe(this._textBox);
      } finally {
        this._mo.takeRecords();
        this._rendering = false;
      }
      this._decorate();
    }

    get imageAvailable() { return this.getAttribute('data-image-state') === 'loaded'; }

    _avatarFallback() {
      var parts = this._parts;
      if (!parts || !parts.avatar) return;
      var old = parts.avatar.querySelector('.rs-pf__initials');
      if (old) old.remove();
      var nameEl = this._slots.name || this._slots.handle;
      var ini = h('span', 'rs-pf__initials', initials(nameEl ? nameEl.textContent : ''));
      ini.setAttribute('aria-hidden', 'true');
      parts.avatar.appendChild(ini);
    }

    _prepareAvatar(avatar) {
      var self = this;
      this._avatar = avatar || null;
      if (!avatar) {
        this._avatarFallback();
        return;
      }
      if (!avatar._rsFallbackBound) {
        avatar._rsFallbackBound = true;
        avatar.addEventListener('load', function () {
          if (self._avatar !== avatar) return;
          avatar.hidden = false;
          var fallback = self._parts.avatar.querySelector('.rs-pf__initials');
          if (fallback) fallback.remove();
        });
        avatar.addEventListener('error', function () {
          if (self._avatar !== avatar) return;
          avatar.hidden = true;
          self._avatarFallback();
        });
      }
      if (avatar.complete) {
        if (avatar.naturalWidth > 0) avatar.dispatchEvent(new Event('load'));
        else avatar.dispatchEvent(new Event('error'));
      }
    }

    _prepareImage(image) {
      var self = this;
      this._image = image;
      if (!image._rsAvailabilityBound) {
        image._rsAvailabilityBound = true;
        image.addEventListener('load', function () {
          if (self._image === image) self._setImageState('loaded');
        });
        image.addEventListener('error', function () {
          if (self._image === image) self._setImageState('error');
        });
      }
      if (image.complete) this._setImageState(image.naturalWidth > 0 ? 'loaded' : 'error');
      else this._setImageState('loading');
    }

    _setImageState(state) {
      var media = this._parts && this._parts.media;
      var image = this._image;
      if (!media || !image) return;
      var old = media.querySelector('.rs-pf__media-error-wrap');
      if (old) old.remove();
      media.classList.remove('rs-pf__media--empty', 'rs-pf__media--error');
      image.hidden = state === 'error';
      if (state === 'error') {
        media.classList.add('rs-pf__media--empty', 'rs-pf__media--error');
        var box = h('div', 'rs-pf__media-error-wrap');
        box.appendChild(icon('image', 'rs-pf__empty-ico'));
        box.appendChild(h('span', 'rs-pf__media-error', t('pf_image_error')));
        var retry = h('button', 'rs-btn rs-btn--quiet rs-pf__image-retry', t('pf_image_retry'));
        retry.type = 'button';
        var self = this;
        retry.addEventListener('click', function () { self._retryImage(); });
        box.appendChild(retry);
        media.appendChild(box);
      }
      this.setAttribute('data-image-state', state);
      this.dispatchEvent(new CustomEvent('rs-image-state', {
        bubbles: true,
        detail: { state: state, available: state === 'loaded' }
      }));
    }

    _retryImage() {
      if (!this._image) return;
      this._setImageState('loading');
      var url = new URL(this._image.src, document.baseURI);
      this._retryN += 1;
      url.searchParams.set('rs_retry', String(Date.now()) + '-' + this._retryN);
      this._image.src = url.href;
    }

    _head(post) {
      var head = h('div', 'rs-pf__head');
      var avatar = h('div', 'rs-pf__avatar');
      head.appendChild(avatar);
      var who = h('div', 'rs-pf__who');
      head.appendChild(who);
      post.appendChild(head);
      return { head: head, avatar: avatar, who: who };
    }

    _meta(globe) {
      var meta = h('span', 'rs-pf__meta');
      meta.appendChild(h('span', '', t('pf_now')));
      if (globe) {
        meta.appendChild(h('span', 'rs-pf__dot', t('sep')));
        meta.appendChild(icon('globe', 'rs-ico--sm'));
      }
      return meta;
    }

    _textBlock(post) {
      var box = h('div', 'rs-pf__text');
      var marker = h('span', 'rs-pf__fold');
      marker.setAttribute('aria-hidden', 'true');
      marker.hidden = true;
      box.appendChild(marker);
      this._marker = marker;
      post.appendChild(box);
      var note = h('p', 'rs-pf__foldnote');
      note.hidden = true;
      post.appendChild(note);
      this._foldNote = note;
      return box;
    }

    _actions(post, list, withLabels) {
      var bar = h('div', 'rs-pf__actions' + (withLabels ? ' rs-pf__actions--labels' : ''));
      bar.setAttribute('aria-hidden', 'true');
      list.forEach(function (a) {
        var item = h('span', 'rs-pf__action' + (a.end ? ' rs-pf__action--end' : ''));
        item.appendChild(icon(a.icon));
        if (withLabels && a.label) item.appendChild(h('span', '', t(a.label)));
        bar.appendChild(item);
      });
      post.appendChild(bar);
      return bar;
    }

    _linkCard(post, cls) {
      var link = h('div', 'rs-pf__link ' + (cls || ''));
      var dom = h('div', 'rs-pf__link-domain');
      var title = h('div', 'rs-pf__link-title');
      link.appendChild(dom);
      link.appendChild(title);
      post.appendChild(link);
      return { link: link, domain: dom, title: title };
    }

    _build_x(post) {
      post.classList.add('rs-pf__post--x');
      var avatar = h('div', 'rs-pf__avatar');
      post.appendChild(avatar);
      var main = h('div', 'rs-pf__main');
      post.appendChild(main);
      var line = h('div', 'rs-pf__line');
      var name = h('span', 'rs-pf__name');
      var handle = h('span', 'rs-pf__handle');
      line.appendChild(name);
      line.appendChild(handle);
      line.appendChild(h('span', 'rs-pf__dot', t('sep')));
      line.appendChild(this._meta(false));
      line.appendChild(icon('more', 'rs-pf__more'));
      main.appendChild(line);
      var text = this._textBlock(main);
      var media = h('div', 'rs-pf__media');
      main.appendChild(media);
      var lc = this._linkCard(main, 'rs-pf__link--x');
      this._actions(main, [{ icon: 'reply' }, { icon: 'repost' }, { icon: 'heart' }, { icon: 'views' }, { icon: 'bookmark', end: true }, { icon: 'upload' }], false);
      return {
        text: text, avatar: avatar, media: media, link: lc.link,
        targets: { avatar: avatar, name: name, handle: handle, text: text, image: media, 'link-title': lc.title, 'link-domain': lc.domain }
      };
    }

    _build_linkedin(post) {
      post.classList.add('rs-pf__post--li');
      var hd = this._head(post);
      var name = h('div', 'rs-pf__name');
      var headline = h('div', 'rs-pf__headline');
      hd.who.appendChild(name);
      hd.who.appendChild(headline);
      hd.who.appendChild(this._meta(true));
      hd.head.appendChild(icon('more', 'rs-pf__more'));
      var text = this._textBlock(post);
      var media = h('div', 'rs-pf__media');
      post.appendChild(media);
      var lc = this._linkCard(post, 'rs-pf__link--li');
      this._actions(post, [
        { icon: 'thumb', label: 'pf_like' }, { icon: 'bubble', label: 'pf_comment' },
        { icon: 'repost', label: 'pf_repost' }, { icon: 'send', label: 'pf_send' }], true);
      return {
        text: text, avatar: hd.avatar, media: media, link: lc.link,
        targets: { avatar: hd.avatar, name: name, headline: headline, text: text, image: media, 'link-title': lc.title, 'link-domain': lc.domain }
      };
    }

    _build_instagram(post) {
      post.classList.add('rs-pf__post--ig');
      var hd = this._head(post);
      var ring = h('div', 'rs-pf__ring');
      hd.head.replaceChild(ring, hd.avatar);
      ring.appendChild(hd.avatar);
      var who = h('div', 'rs-pf__name');
      hd.who.appendChild(who);
      hd.head.appendChild(icon('more', 'rs-pf__more'));
      var media = h('div', 'rs-pf__media');
      post.appendChild(media);
      this._actions(post, [{ icon: 'heart' }, { icon: 'reply' }, { icon: 'send' }, { icon: 'bookmark', end: true }], false);
      var cap = h('div', 'rs-pf__caption');
      var capName = h('span', 'rs-pf__caption-name');
      capName.setAttribute('aria-hidden', 'true');
      cap.appendChild(capName);
      post.appendChild(cap);
      var text = this._textBlock(cap);
      var hasHandle = !!this._slots.handle;
      var targets = { avatar: hd.avatar, text: text, image: media };
      targets[hasHandle ? 'handle' : 'name'] = who;
      return { text: text, avatar: hd.avatar, media: media, captionName: capName, targets: targets };
    }

    _build_facebook(post) {
      post.classList.add('rs-pf__post--fb');
      var hd = this._head(post);
      var name = h('div', 'rs-pf__name');
      hd.who.appendChild(name);
      hd.who.appendChild(this._meta(true));
      hd.head.appendChild(icon('more', 'rs-pf__more'));
      var text = this._textBlock(post);
      var media = h('div', 'rs-pf__media');
      post.appendChild(media);
      var lc = this._linkCard(post, 'rs-pf__link--fb');
      this._actions(post, [
        { icon: 'thumb', label: 'pf_like' }, { icon: 'bubble', label: 'pf_comment' }, { icon: 'share', label: 'pf_share' }], true);
      return {
        text: text, avatar: hd.avatar, media: media, link: lc.link,
        targets: { avatar: hd.avatar, name: name, text: text, image: media, 'link-title': lc.title, 'link-domain': lc.domain }
      };
    }

    _clearRanges() {
      this._ranges.forEach(function (e) { if (HL[e[0]]) HL[e[0]].delete(e[1]); });
      this._ranges = [];
    }

    _addRange(name, range) {
      var hl = highlight(name);
      if (!hl) return;
      hl.add(range);
      this._ranges.push([name, range]);
    }

    _decorate() {
      this._clearRanges();
      this._fold = null;
      var textEl = this._slots.text;
      if (!this._marker) return;
      this._marker.hidden = true;
      this._foldNote.hidden = true;
      if (!textEl || !textEl.isConnected) return;
      var abbr = SKIN_ABBR[this.skin];
      var nodes = [];
      var walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT);
      var n;
      this._textMo.disconnect();
      while ((n = walker.nextNode())) {
        var nfc = n.data.normalize('NFC');
        if (nfc !== n.data) n.data = nfc;
        nodes.push(n);
      }
      this._textMo.takeRecords();
      this._textMo.observe(textEl, { childList: true, subtree: true, characterData: true });

      var self = this;
      nodes.forEach(function (node) {
        TAG_RE.lastIndex = 0;
        var m;
        while ((m = TAG_RE.exec(node.data))) {
          var start = m.index + (m[2] ? m[1].length : 0);
          var len = m[2] ? m[2].length : m[3].length;
          var r = document.createRange();
          r.setStart(node, start);
          r.setEnd(node, start + len);
          self._addRange('rs-pf-tag-' + abbr, r);
        }
      });

      var full = nodes.map(function (x) { return x.data; }).join('');
      var R = window.RS;
      var res = R && R.count ? R.count(full, this.skin) : null;
      if (!res || !res.fold || res.count <= res.fold) return;
      // find (node, offset) after `fold` code points
      var left = res.fold;
      var pos = null;
      for (var i = 0; i < nodes.length && !pos; i++) {
        var d = nodes[i].data;
        for (var j = 0; j < d.length; j++) {
          if (left === 0) { pos = [nodes[i], j]; break; }
          var c = d.charCodeAt(j);
          if (c >= 0xD800 && c <= 0xDBFF && j + 1 < d.length) j++;
          left--;
        }
      }
      if (!pos) return;
      var after = document.createRange();
      after.setStart(pos[0], pos[1]);
      var last = nodes[nodes.length - 1];
      after.setEnd(last, last.data.length);
      this._addRange('rs-pf-after-' + abbr, after);
      this._fold = pos;
      var more = t('fold_more_' + this.skin);
      this._foldNote.textContent = '';
      var sw = h('span', 'rs-pf__foldnote-bar');
      sw.setAttribute('aria-hidden', 'true');
      this._foldNote.appendChild(sw);
      this._foldNote.appendChild(document.createTextNode(t('fold_hint', { n: res.fold, more: more })));
      this._foldNote.hidden = false;
      this._placeMarker();
    }

    _placeMarker() {
      if (!this._fold || !this._marker || !this._textBox) return;
      var node = this._fold[0];
      var off = this._fold[1];
      if (!node.isConnected) return;
      var r = document.createRange();
      r.setStart(node, off);
      r.setEnd(node, Math.min(node.data.length, off + 1));
      var rects = r.getClientRects();
      var rect = rects.length ? rects[0] : r.getBoundingClientRect();
      var box = this._textBox.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) { this._marker.hidden = true; return; }
      this._marker.hidden = false;
      this._marker.style.left = (rect.left - box.left - 1) + 'px';
      this._marker.style.top = (rect.top - box.top) + 'px';
      this._marker.style.height = rect.height + 'px';
    }
  }

  // ========================================================== rs-confirm ==
  // Typed confirm. Attributes: word, heading, message, confirm-label.
  // Method open({word, heading, message, confirmLabel}) -> Promise<boolean>.
  // Esc / Abbrechen -> false; confirm (enabled only when input === word) -> true.
  // Event: rs-confirm {detail:{confirmed}}. If not in the document, open()
  // appends it to <body> and removes it again afterwards.
  class RsConfirm extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      var dlg = h('dialog', 'rs-confirm__dialog');
      var hid = uid('rs-confirm-h');
      var mid = uid('rs-confirm-m');
      var iid = uid('rs-confirm-i');
      dlg.setAttribute('aria-labelledby', hid);
      dlg.setAttribute('aria-describedby', mid);
      var form = h('form', 'rs-confirm__form');
      form.method = 'dialog';
      var head = h('h2', 'rs-confirm__heading');
      head.id = hid;
      var msg = h('p', 'rs-confirm__message');
      msg.id = mid;
      var lab = h('label', 'rs-confirm__label');
      lab.htmlFor = iid;
      var input = h('input', 'rs-confirm__input');
      input.id = iid;
      input.type = 'text';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('autocapitalize', 'off');
      var row = h('div', 'rs-confirm__buttons');
      var cancel = h('button', 'rs-btn rs-btn--secondary', t('cancel'));
      cancel.type = 'button';
      var ok = h('button', 'rs-btn rs-btn--danger');
      ok.type = 'submit';
      ok.value = 'confirm';
      row.appendChild(cancel);
      row.appendChild(ok);
      form.appendChild(head);
      form.appendChild(msg);
      form.appendChild(lab);
      form.appendChild(input);
      form.appendChild(row);
      dlg.appendChild(form);
      this.appendChild(dlg);
      this._dlg = dlg; this._head = head; this._msg = msg; this._lab = lab;
      this._input = input; this._ok = ok; this._cancel = cancel;

      var self = this;
      input.addEventListener('input', function () { self._check(); });
      cancel.addEventListener('click', function () { self._finish(false); });
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (self._matches()) self._finish(true);
      });
      dlg.addEventListener('cancel', function (e) { e.preventDefault(); self._finish(false); });
    }
    get word() { return this._word !== undefined ? this._word : (this.getAttribute('word') || ''); }
    get isOpen() { return !!(this._dlg && this._dlg.open); }
    _matches() { var w = this.word; return w !== '' && this._input.value === w; }
    _check() { this._ok.disabled = !this._matches(); }
    open(opts) {
      opts = opts || {};
      var added = false;
      if (!this.isConnected) { document.body.appendChild(this); added = true; }
      if (!this._built) this.connectedCallback();
      if (this._resolve) this._finish(false);
      this._word = opts.word !== undefined ? String(opts.word) : undefined;
      this._head.textContent = opts.heading || this.getAttribute('heading') || t('confirm_title');
      var message = opts.message || this.getAttribute('message') || '';
      this._msg.textContent = message;
      this._msg.hidden = !message;
      this._lab.textContent = t('confirm_type', { word: this.word });
      this._ok.textContent = opts.confirmLabel || this.getAttribute('confirm-label') || t('confirm');
      this._input.value = '';
      this._check();
      this._added = added;
      this._returnFocus = document.activeElement;
      var self = this;
      var p = new Promise(function (resolve) { self._resolve = resolve; });
      this._dlg.showModal();
      this._input.focus();
      return p;
    }
    _finish(result) {
      var resolve = this._resolve;
      if (!resolve) return;
      this._resolve = null;
      if (this._dlg.open) this._dlg.close();
      var back = this._returnFocus;
      this._returnFocus = null;
      if (back && back.focus && back.isConnected) back.focus();
      this.dispatchEvent(new CustomEvent('rs-confirm', { bubbles: true, detail: { confirmed: result } }));
      if (this._added) { this._added = false; this.remove(); }
      resolve(result);
    }
  }

  define('rs-card', RsCard);
  define('rs-action-row', RsActionRow);
  define('rs-copy', RsCopy);
  define('rs-badge', RsBadge);
  define('rs-counter', RsCounter);
  define('rs-post-frame', RsPostFrame);
  define('rs-confirm', RsConfirm);
})();
