/* grokbot-desk: the one composer a report ends in.
 *
 * A note to the bot (one textarea that grows from one line to six, then
 * scrolls) with the reply chips above it: each chip quotes what the note
 * refers to ({block, item, label}), de-duplicated and removable; adding one
 * focuses the note. On a report that only informs, the composer starts
 * collapsed behind a quiet "Add a note" (opener); a closed note sends "".
 * A decided report shows what was sent, read-only (lock).
 *
 * RSComposer.create({t, bot, collapsed, onChange}) -> {el, opener, text(),
 * refs(), addRef(ref), removeRef(ref), setRequired(on, placeholder),
 * focus(), snapshot(), restore(s), lock(), setBusy(on), isOpen()}
 */
(function (root) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var MAX_LINES = 6;
  var MAX_REFS = 20;
  var MAX_LABEL = 120;
  var MAX_NOTE = 4000;

  function make(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function svgIcon(d, filled) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', 'rs-ico');
    var p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    if (filled) {
      p.setAttribute('class', 'rs-ico-fill');
      /* an opening pair of quote marks, filling the icon box */
      p.setAttribute('transform', 'translate(12 12) scale(1.4) rotate(180) translate(-12 -13)');
    }
    svg.appendChild(p);
    return svg;
  }
  /* a quote mark, filled: what the note refers to */
  var ICON_QUOTE = 'M4.9 10.5a2.6 2.6 0 0 1 5.2 0c0 3.2-1.7 5.6-4.4 6.6l-.5-1.1c1.2-.6 2-1.5 2.4-2.9a2.6 2.6 0 0 1-2.7-2.6zM13.9 10.5a2.6 2.6 0 0 1 5.2 0c0 3.2-1.7 5.6-4.4 6.6l-.5-1.1c1.2-.6 2-1.5 2.4-2.9a2.6 2.6 0 0 1-2.7-2.6z';
  var ICON_CLOSE = 'M7 7l10 10M17 7 7 17';
  var ICON_PLUS = 'M12 5v14M5 12h14';

  function cleanRef(ref) {
    if (!ref || ref.block == null || ref.item == null) return null;
    var label = String(ref.label == null ? '' : ref.label).replace(/\s+/g, ' ').trim();
    if (!label) label = String(ref.item);
    if (Array.from(label).length > MAX_LABEL) label = Array.from(label).slice(0, MAX_LABEL - 1).join('') + '…';
    /* half an emoji (a lone surrogate from a cut elsewhere) never reaches the bot */
    label = label.replace(/[\uD800-\uDBFF](…?)$/, '$1');
    if (!label) label = String(ref.item);
    return { block: String(ref.block), item: String(ref.item), label: label };
  }

  function create(opts) {
    var t = opts.t;
    var bot = opts.bot || '';
    var onChange = typeof opts.onChange === 'function' ? opts.onChange : function () {};
    var state = { open: !opts.collapsed, refs: [], locked: false };
    var basePlaceholder = bot ? t('cmp_placeholder', { bot: bot }) : t('cmp_placeholder_anon');

    var el = make('div', 'rs-composer');
    el.setAttribute('data-rs-composer', '');
    var refsBox = make('div', 'rs-refs');
    refsBox.id = 'rs-refs';
    refsBox.setAttribute('role', 'group');
    refsBox.setAttribute('aria-label', t('cmp_refs_label'));
    refsBox.hidden = true;
    var input = make('textarea', 'rs-composer__input');
    input.id = 'rs-note';
    input.rows = 1;
    input.maxLength = MAX_NOTE;
    input.spellcheck = true;
    input.placeholder = basePlaceholder;
    input.setAttribute('aria-label', bot ? t('cmp_label', { bot: bot }) : t('cmp_label_anon'));
    el.appendChild(refsBox);
    el.appendChild(input);

    var opener = make('button', 'rs-btn rs-btn--quiet rs-composer__open');
    opener.type = 'button';
    opener.setAttribute('data-rs-note-open', '');
    opener.appendChild(svgIcon(ICON_PLUS));
    opener.appendChild(make('span', '', t('cmp_add_note')));
    opener.addEventListener('click', function () {
      setOpen(true);
      focus();
      onChange();
    });

    /* one line up to six: the box follows the text, then the text scrolls */
    function grow() {
      if (!input.isConnected) return;
      var style = getComputedStyle(input);
      var line = parseFloat(style.lineHeight) || 20;
      var pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      var border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      var max = line * MAX_LINES + pad + border;
      /* a short window caps the note lower (shell.css max-height) */
      var cap = parseFloat(style.maxHeight);
      if (cap > 0 && cap < max) max = cap;
      input.style.height = 'auto';
      var want = input.scrollHeight + border;
      input.style.height = Math.min(want, max) + 'px';
      input.style.overflowY = want > max + 1 ? 'auto' : 'hidden';
    }
    input.addEventListener('input', function () { grow(); onChange(); });
    if (typeof ResizeObserver === 'function') {
      var width = 0;
      new ResizeObserver(function (entries) {
        var w = entries[0] && entries[0].contentRect.width;
        if (w && w !== width) { width = w; grow(); }
      }).observe(input);
    }

    function setOpen(on) {
      state.open = !!on;
      el.hidden = !state.open;
      opener.hidden = state.open || state.locked;
      if (state.open) requestAnimationFrame(grow);
    }

    function renderRefs(focusAfter) {
      refsBox.textContent = '';
      state.refs.forEach(function (ref) {
        var chip = make('span', 'rs-ref');
        chip.setAttribute('data-rs-ref', ref.block + '/' + ref.item);
        chip.title = ref.label;
        var mark = make('span', 'rs-ref__mark');
        mark.setAttribute('aria-hidden', 'true');
        mark.appendChild(svgIcon(ICON_QUOTE, true));
        chip.appendChild(mark);
        chip.appendChild(make('span', 'rs-ref__label', ref.label));
        if (!state.locked) {
          var remove = make('button', 'rs-ref__remove');
          remove.type = 'button';
          remove.setAttribute('aria-label', t('cmp_ref_remove', { what: ref.label }));
          remove.title = t('cmp_ref_remove', { what: ref.label });
          remove.appendChild(svgIcon(ICON_CLOSE));
          remove.addEventListener('click', function () { removeRef(ref); });
          chip.appendChild(remove);
        }
        refsBox.appendChild(chip);
      });
      refsBox.hidden = !state.refs.length;
      if (focusAfter) focusAfter();
    }

    function indexOf(ref) {
      for (var i = 0; i < state.refs.length; i++) {
        if (state.refs[i].block === String(ref.block) && state.refs[i].item === String(ref.item)) return i;
      }
      return -1;
    }

    function addRef(raw) {
      var ref = cleanRef(raw);
      if (state.locked || !ref) return;
      if (!state.open) setOpen(true);
      if (indexOf(ref) < 0 && state.refs.length < MAX_REFS) state.refs.push(ref);
      renderRefs();
      focus();
      onChange();
    }

    function removeRef(raw) {
      var at = raw ? indexOf(raw) : -1;
      if (state.locked || at < 0) return;
      state.refs.splice(at, 1);
      renderRefs(function () {
        var buttons = refsBox.querySelectorAll('.rs-ref__remove');
        var next = buttons[Math.min(at, buttons.length - 1)];
        if (next) next.focus();
        else focus();
      });
      onChange();
    }

    function focus() {
      if (state.locked) return;
      if (!state.open) setOpen(true);
      input.focus({ preventScroll: true });
      var end = input.value.length;
      try { input.setSelectionRange(end, end); } catch (e) { /* not focusable yet */ }
    }

    function setRequired(on, placeholder) {
      if (on) input.setAttribute('aria-required', 'true');
      else input.removeAttribute('aria-required');
      input.placeholder = on && placeholder ? placeholder : basePlaceholder;
    }

    function snapshot() {
      return { text: input.value, refs: state.refs.map(function (r) { return { block: r.block, item: r.item, label: r.label }; }), open: state.open };
    }

    function restore(s) {
      if (!s || typeof s !== 'object') return;
      if (typeof s.text === 'string') input.value = s.text.slice(0, MAX_NOTE);
      if (Array.isArray(s.refs)) {
        state.refs = [];
        s.refs.forEach(function (r) {
          var ref = cleanRef(r);
          if (ref && indexOf(ref) < 0 && state.refs.length < MAX_REFS) state.refs.push(ref);
        });
      }
      if (s.open || (typeof s.text === 'string' && s.text) || state.refs.length) setOpen(true);
      renderRefs();
      requestAnimationFrame(grow);
    }

    /* read-only: what was sent stays visible; nothing to add or remove */
    function lock() {
      state.locked = true;
      input.readOnly = true;
      input.removeAttribute('aria-required');
      input.placeholder = '';
      input.setAttribute('aria-label', t('cmp_sent_note'));
      renderRefs();
      setOpen(!!input.value || state.refs.length > 0);
      opener.hidden = true;
    }

    function setBusy(on) {
      if (state.locked) return;
      input.readOnly = !!on;
      refsBox.querySelectorAll('button').forEach(function (b) { b.disabled = !!on; });
      opener.disabled = !!on;
    }

    setOpen(state.open);
    return {
      el: el,
      opener: opener,
      text: function () { return state.open ? input.value : ''; },
      refs: function () { return state.refs.map(function (r) { return { block: r.block, item: r.item, label: r.label }; }); },
      addRef: addRef,
      removeRef: removeRef,
      setRequired: setRequired,
      focus: focus,
      snapshot: snapshot,
      restore: restore,
      lock: lock,
      setBusy: setBusy,
      isOpen: function () { return state.open; },
      grow: grow
    };
  }

  root.RSComposer = { create: create };
})(typeof self !== 'undefined' ? self : this);
