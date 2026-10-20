/* grokbot-desk: the input block of a report (decide, pick, post), where the
 * control is the decision.
 *
 * window.RSInputs.create(block, run, ctx) -> handle {el, answer() ->
 * object|null, progress() -> {done, total}, primaryLabel() -> string|null,
 * hint() -> {key, vars}|null, snapshot(), restore(s), lock()}. rs.js mounts
 * handle.el and hands the handle to the footer (ctx.input); every change
 * calls ctx.changed(). The footer only sends: answer() is null until the
 * block is complete.
 *
 * decide: one row per item with a labelled segmented control (rs-segmented:
 *   radiogroup, unset by default, never a checkbox). Keys on a focused row:
 *   A / X / L answer approve / reject / later (done / skipped / later under
 *   ask do) and move focus to the next undecided row; R quotes the row in
 *   the composer. A row keeps its url and copy values.
 * pick: 2-4 option cards as one radiogroup; the suggestion is marked, never
 *   preselected; the primary names the picked option.
 * post: one preview per platform tab (rs-post-frame, count.js limits).
 *   The tabs only navigate: an unsent draft shows no tick (ticks are for
 *   done work, a manual platform marked Posted). Auto (ask approve): one
 *   labelled switch per platform, "Post to X", on by default; an
 *   over-limit or unpostable platform (Instagram without media) is left
 *   out with its reason. Manual (ask do): an unset Posted | Skip per
 *   platform; limits are advice and never block.
 *
 * A decided report shows what was sent (run.result.blocks), read-only. No
 * literal UI strings: every word is ctx.t or payload.
 */
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var REF_LABEL_MAX = 120;
  var CHOICES = { approve: ['approve', 'reject', 'later'], 'do': ['done', 'skipped', 'later'] };
  var KEYS = { approve: { a: 'approve', x: 'reject', l: 'later' }, 'do': { a: 'done', x: 'skipped', l: 'later' } };
  /* the default labels are the strings the server's label-clash check reads */
  var LABEL_KEYS = {
    approve: 'choice_approve', reject: 'choice_reject', later: 'choice_spaeter',
    done: 'choice_erledigt', skipped: 'inp_choice_skip', posted: 'inp_choice_posted'
  };
  var TONES = { approve: 'ok', done: 'ok', posted: 'ok', reject: 'danger', skipped: 'neutral', later: 'neutral' };
  var ICONS = {
    check: 'M5 12.5l4.5 4.5L19 7.5',
    cross: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
    later: 'M12 7v5l3.2 2M12 3.8a8.2 8.2 0 1 0 0 16.4 8.2 8.2 0 0 0 0-16.4z',
    skip: 'M4.5 12h11M12 7.5l4.5 4.5-4.5 4.5M19.5 6v12',
    ring: 'M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z',
    quote: 'M4.9 10.5a2.6 2.6 0 0 1 5.2 0c0 3.2-1.7 5.6-4.4 6.6l-.5-1.1c1.2-.6 2-1.5 2.4-2.9a2.6 2.6 0 0 1-2.7-2.6zM13.9 10.5a2.6 2.6 0 0 1 5.2 0c0 3.2-1.7 5.6-4.4 6.6l-.5-1.1c1.2-.6 2-1.5 2.4-2.9a2.6 2.6 0 0 1-2.7-2.6z',
    folder: 'M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z'
  };
  var FILLED = { quote: true };
  /* the quote marks as an opening pair, filling the icon box */
  var QUOTE_TRANSFORM = 'translate(12 12) scale(1.4) rotate(180) translate(-12 -13)';
  var CHOICE_ICON = { approve: 'check', done: 'check', posted: 'check', reject: 'cross', skipped: 'skip', later: 'later' };
  var PLATFORMS = ['x', 'linkedin', 'instagram', 'facebook'];

  function make(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function svg(name, cls) {
    var s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    s.setAttribute('class', 'rs-ico' + (cls ? ' ' + cls : ''));
    var p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', ICONS[name]);
    if (FILLED[name]) {
      p.setAttribute('class', 'rs-ico-fill');
      p.setAttribute('transform', QUOTE_TRANSFORM);
    }
    s.appendChild(p);
    return s;
  }
  function has(table, key) { return Object.prototype.hasOwnProperty.call(table, key); }
  /* by characters (code points), so a cut never splits an emoji in two */
  function clip(text) { return Array.from(String(text).replace(/\s+/g, ' ').trim()).slice(0, REF_LABEL_MAX).join(''); }
  function idPart(text) { return String(text).replace(/[^a-z0-9_-]/gi, '-'); }

  function section(block) {
    var el = make('section', 'rs-blk rs-blk--' + block.type);
    el.setAttribute('data-rs-block-type', block.type);
    el.setAttribute('data-rs-block', block.id);
    if (block.title) el.appendChild(make('h2', 'rs-blk__title', block.title));
    return el;
  }

  /* the visible reply action: quotes its target in the composer */
  function replyButton(ctx, ref, what) {
    var b = make('button', 'rs-reply');
    b.type = 'button';
    b.setAttribute('data-rs-reply-item', ref.item);
    b.setAttribute('aria-label', ctx.t('blk_reply_to', { what: what }));
    b.title = ctx.t('blk_reply');
    b.appendChild(svg('quote'));
    b.addEventListener('click', function () { ctx.addRef(ref); });
    return b;
  }

  /* one segment: an icon that shows only once chosen, and its label */
  function segment(value, label, id) {
    var b = make('button', 'rs-seg');
    b.type = 'button';
    b.setAttribute('value', value);
    b.setAttribute('data-tone', TONES[value] || 'neutral');
    if (id) b.id = id;
    var mark = make('span', 'rs-seg__icon');
    mark.setAttribute('aria-hidden', 'true');
    mark.appendChild(svg(CHOICE_ICON[value] || 'check'));
    b.appendChild(mark);
    var text = make('span', 'rs-seg__label', label);
    text.setAttribute('data-text', label);
    b.appendChild(text);
    return b;
  }

  function isTyping(target) {
    return !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  }
  function plainKey(e) { return !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing; }

  /* what was sent for this block on a decided report */
  function sentAnswer(block, run) {
    var result = run && run.state !== 'open' && run.result && typeof run.result === 'object' ? run.result : null;
    var blocks = result && result.blocks && typeof result.blocks === 'object' ? result.blocks : null;
    return blocks && has(blocks, block.id) ? blocks[block.id] : null;
  }

  // ------------------------------------------------------------- decide --
  function decide(block, run, ctx) {
    var ask = run.ask === 'do' ? 'do' : 'approve';
    var el = section(block);
    var list = make('ul', 'rs-decide');
    var rows = [];
    var locked = !!ctx.locked;

    function labelOf(item, value) {
      if (ask === 'approve') {
        if (item.labels && item.labels[value]) return item.labels[value];
        if (block.labels && block.labels[value]) return block.labels[value];
      }
      return ctx.t(LABEL_KEYS[value]);
    }

    block.items.forEach(function (item, index) {
      /* ids by position with fixed suffixes: item ids cannot collide */
      var key = 'inp-' + idPart(block.id) + '-r' + index;
      var li = make('li', 'rs-drow');
      /* one decision item: the calm checker counts its controls (K2) and
         the gaps between items (K7) */
      li.setAttribute('data-rs-item', '');
      li.setAttribute('data-item-id', item.id);
      li.setAttribute('data-state', 'open');
      var main = make('div', 'rs-drow__main');
      var title = make('p', 'rs-drow__title', item.title);
      title.id = key + '-title';
      main.appendChild(title);
      var meta = [];
      if (item.meta) meta.push(item.meta);
      if (item.due && window.RS && typeof window.RS.date === 'function') meta.push(ctx.t('due', { date: window.RS.date(item.due) }));
      if (meta.length) main.appendChild(make('p', 'rs-drow__meta', meta.join(' · ')));
      if (item.md && window.RSMd) {
        var md = window.RSMd.render(item.md, { t: ctx.t, link: ctx.link, image: function () { return null; } });
        md.classList.add('rs-drow__md');
        main.appendChild(md);
      }
      if (item.url || (item.copy && item.copy.length)) {
        var extra = make('div', 'rs-drow__extra');
        if (item.url) {
          var link = ctx.link(item.url);
          if (link) { link.classList.add('rs-drow__url'); extra.appendChild(link); }
        }
        (item.copy || []).forEach(function (entry, j) {
          var copy = document.createElement('rs-copy');
          copy.setAttribute('data-copy-id', block.id + '-' + item.id + '-' + (j + 1));
          copy.setAttribute('label', entry.label);
          copy.setAttribute('caption', '');
          if (entry.text.length > 40 || /[\r\n]/.test(entry.text)) {
            copy.setAttribute('block', '');
            if (entry.text.length > 320) copy.setAttribute('max-lines', '4');
          } else {
            copy.setAttribute('mono', '');
          }
          copy.text = entry.text;
          extra.appendChild(copy);
        });
        main.appendChild(extra);
      }
      li.appendChild(main);

      var act = make('div', 'rs-drow__act');
      var group = document.createElement('rs-segmented');
      group.setAttribute('data-item', item.id);
      group.setAttribute('label', ctx.t('choice_group_label', { what: item.title }));
      var offered = CHOICES[ask].filter(function (c) { return !item.choices || item.choices.indexOf(c) >= 0; });
      group.setAttribute('data-count', String(offered.length));
      offered.forEach(function (value) {
        group.appendChild(segment(value, labelOf(item, value), key + '-' + value));
      });
      act.appendChild(group);
      var reply = null;
      if (!locked) {
        reply = replyButton(ctx, { block: block.id, item: item.id, label: clip(item.title) }, clip(item.title));
        act.appendChild(reply);
      }
      li.appendChild(act);
      list.appendChild(li);
      var row = { id: item.id, item: item, li: li, group: group, offered: offered, reply: reply };
      rows.push(row);
      group.addEventListener('change', function (e) {
        var before = rows.filter(function (r) { return r !== row && !r.group.value; }).length;
        render(row);
        ctx.changed();
        /* keyboard completion goes on to the primary: Enter or Space like
           A / X / L (nothing left undecided), an arrow only when it answers
           the last undecided row (so arrows can still walk a row) */
        var via = e.detail && e.detail.via;
        if (!before && (via === 'activate' || (via === 'arrow' && !row.wasSet))) ctx.focusPrimary();
        row.wasSet = true;
      });
    });
    el.appendChild(list);

    function render(row) {
      row.li.setAttribute('data-state', row.group.value || 'open');
      row.group.querySelectorAll('.rs-seg').forEach(function (b) {
        if (b.getAttribute('aria-checked') === 'true' && b.getAttribute('data-tone') !== 'neutral') {
          b.setAttribute('data-rs-status', b.getAttribute('data-tone'));
        } else {
          b.removeAttribute('data-rs-status');
        }
      });
    }

    function set(row, value) {
      if (row.offered.indexOf(value) < 0) return false;
      row.group.value = value;
      row.wasSet = true;
      render(row);
      return true;
    }

    /* triage: A / X / L on a focused row, then on to the next undecided */
    list.addEventListener('keydown', function (e) {
      if (locked || !plainKey(e) || isTyping(e.target)) return;
      var li = e.target.closest ? e.target.closest('.rs-drow') : null;
      var row = rows.filter(function (r) { return r.li === li; })[0];
      if (!row || row.group.disabled) return;
      var key = String(e.key || '').toLowerCase();
      if (key === 'r') {
        e.preventDefault();
        ctx.addRef({ block: block.id, item: row.id, label: clip(row.item.title) });
        return;
      }
      if (!has(KEYS[ask], key)) return;
      e.preventDefault();
      if (!set(row, KEYS[ask][key])) return;
      row.wasSet = true;
      ctx.changed();
      var at = rows.indexOf(row);
      var next = null;
      for (var k = 1; k < rows.length && !next; k++) {
        var candidate = rows[(at + k) % rows.length];
        if (!candidate.group.value) next = candidate;
      }
      /* nothing left to decide: the primary sends */
      if (!next && ctx.focusPrimary()) return;
      var target = (next || row).group.current;
      if (target) target.focus();
    });

    function answered() { return rows.filter(function (r) { return !!r.group.value; }); }

    function restore(saved) {
      if (!saved || typeof saved !== 'object') return;
      var items = Array.isArray(saved.items) ? saved.items : [];
      items.forEach(function (entry) {
        if (!entry || typeof entry.id !== 'string' || typeof entry.choice !== 'string') return;
        var row = rows.filter(function (r) { return r.id === entry.id; })[0];
        if (row) set(row, entry.choice);
      });
    }

    var sent = sentAnswer(block, run);
    if (sent) restore(sent);

    return {
      el: el,
      answer: function () {
        if (answered().length !== rows.length) return null;
        return { items: rows.map(function (r) { return { id: r.id, choice: r.group.value }; }) };
      },
      progress: function () { return { done: answered().length, total: rows.length }; },
      primaryLabel: function () { return null; },
      hint: function () { return null; },
      snapshot: function () {
        var items = answered().map(function (r) { return { id: r.id, choice: r.group.value }; });
        return items.length ? { items: items } : null;
      },
      restore: restore,
      /* decided: show exactly what was sent (nothing for reject or revise) */
      lock: function () {
        locked = true;
        rows.forEach(function (r) {
          if (r.reply) { r.reply.remove(); r.reply = null; }
          r.group.value = '';
          render(r);
        });
        restore(sentAnswer(block, run));
        rows.forEach(function (r) { r.group.disabled = true; });
      }
    };
  }

  // --------------------------------------------------------------- pick --
  function pick(block, run, ctx) {
    var el = section(block);
    var locked = !!ctx.locked;
    var group = document.createElement('rs-segmented');
    group.className = 'rs-pick';
    group.setAttribute('data-rs-pick', '');
    group.setAttribute('data-count', String(block.options.length));
    group.setAttribute('label', block.title || ctx.t('ask_line_choose'));
    var byId = {};
    var replies = [];
    block.options.forEach(function (option, i) {
      byId[option.id] = option;
      var key = 'inp-' + idPart(block.id) + '-o' + i;
      var card = make('button', 'rs-pick__card');
      card.type = 'button';
      card.id = key;
      card.setAttribute('value', option.id);
      card.setAttribute('data-i', String(i));
      var head = make('span', 'rs-pick__head');
      var mark = make('span', 'rs-pick__mark');
      mark.setAttribute('aria-hidden', 'true');
      mark.appendChild(svg('ring', 'rs-pick__off'));
      mark.appendChild(svg('check', 'rs-pick__on'));
      head.appendChild(mark);
      var name = make('span', 'rs-pick__name', option.name);
      name.id = key + '-name';
      head.appendChild(name);
      var labelled = [name.id];
      if (block.suggested === option.id) {
        var tag = make('span', 'rs-pick__suggested', ctx.t('inp_suggested'));
        tag.id = key + '-suggested';
        head.appendChild(tag);
        labelled.push(tag.id);
      }
      card.appendChild(head);
      var described = [];
      if (option.md && window.RSMd) {
        /* links stay text inside a card: the card itself is the control */
        var md = window.RSMd.render(option.md, { t: ctx.t, link: function () { return null; }, image: function () { return null; } });
        md.classList.add('rs-pick__md');
        md.id = key + '-md';
        described.push(md.id);
        card.appendChild(md);
      }
      if (option.facts && option.facts.length) {
        var facts = make('span', 'rs-pick__facts');
        option.facts.forEach(function (fact, f) {
          var cell = make('span', 'rs-pick__fact');
          cell.id = key + '-fact-' + f;
          cell.appendChild(make('span', 'rs-pick__label', fact.label));
          cell.appendChild(make('span', 'rs-pick__value', fact.value));
          described.push(cell.id);
          facts.appendChild(cell);
        });
        card.appendChild(facts);
      }
      card.setAttribute('aria-labelledby', labelled.join(' '));
      if (described.length) card.setAttribute('aria-describedby', described.join(' '));
      group.appendChild(card);
      if (!locked) {
        var reply = replyButton(ctx, { block: block.id, item: option.id, label: clip(option.name) }, clip(option.name));
        reply.setAttribute('data-i', String(i));
        reply.classList.add('rs-pick__reply');
        group.appendChild(reply);
        replies.push(reply);
      }
    });
    el.appendChild(group);
    group.addEventListener('change', function () { ctx.changed(); });
    group.addEventListener('keydown', function (e) {
      if (locked || !plainKey(e) || String(e.key).toLowerCase() !== 'r') return;
      var card = e.target.closest ? e.target.closest('.rs-pick__card') : null;
      if (!card || !has(byId, card.value)) return;
      e.preventDefault();
      ctx.addRef({ block: block.id, item: card.value, label: clip(byId[card.value].name) });
    });

    function restore(saved) {
      if (saved && typeof saved.choice === 'string' && has(byId, saved.choice)) group.value = saved.choice;
    }
    var sent = sentAnswer(block, run);
    if (sent) restore(sent);

    return {
      el: el,
      answer: function () { return group.value ? { choice: group.value } : null; },
      progress: function () { return { done: group.value ? 1 : 0, total: 1 }; },
      primaryLabel: function () {
        return group.value && has(byId, group.value) ? ctx.t('inp_choose_named', { name: byId[group.value].name }) : null;
      },
      hint: function () { return null; },
      snapshot: function () { return group.value ? { choice: group.value } : null; },
      restore: restore,
      /* decided: show exactly what was sent (nothing for None of these) */
      lock: function () {
        locked = true;
        replies.forEach(function (r) { r.remove(); });
        replies = [];
        group.value = '';
        restore(sentAnswer(block, run));
        group.disabled = true;
      }
    };
  }

  // --------------------------------------------------------------- post --
  function post(block, run, ctx) {
    var t = ctx.t;
    var RS = window.RS;
    var count = function (text, p) { return window.RS_COUNT.count(text, p); };
    var num = function (n) { return RS && typeof RS.number === 'function' ? RS.number(n) : String(n); };
    var auto = run.ask === 'approve';
    var el = section(block);
    var locked = !!ctx.locked;
    var platforms = block.platforms.map(function (entry) { return typeof entry === 'string' ? entry : entry.platform; })
      .filter(function (p) { return PLATFORMS.indexOf(p) >= 0; });
    var names = {};
    platforms.forEach(function (p) { names[p] = t('platform_' + p); });
    var image = block.image || null;
    var video = block.video || null;
    var visual = video || image;
    var target = block.target || null;
    var author = block.author;
    var appendMode = (block.hashtag_mode || 'append') === 'append';
    var flags = block.flag || [];

    /* per platform: variants[p].text ?? text, variants[p].hashtags ?? hashtags */
    function variantOf(p) { return (block.variants && block.variants[p]) || {}; }
    function tagsOf(p) { return variantOf(p).hashtags || block.hashtags || []; }
    function tagLineOf(p) { return tagsOf(p).map(function (h) { return '#' + h; }).join(' '); }
    function appends(p) { return appendMode && tagsOf(p).length > 0; }
    /* shown = copied = counted: the composed text, NFC once */
    function composed(p) {
      var text = variantOf(p).text || block.text;
      if (appends(p)) text += '\n\n' + tagLineOf(p);
      return text.normalize('NFC');
    }
    /* the hashtags a limit counts: listed tags that are not appended still go out */
    function tagCounted(p, text) {
      if (appends(p)) return text;
      var carried = count(text, p).tags || [];
      var extra = tagsOf(p).filter(function (h) { return carried.indexOf(String(h).normalize('NFC').toLowerCase()) < 0; });
      return extra.length ? text + '\n\n' + extra.map(function (h) { return '#' + h; }).join(' ') : text;
    }
    function quoteDomain(url) {
      try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
    }
    function slot(tag, name, text) {
      var n = document.createElement(tag);
      n.setAttribute('slot', name);
      if (text !== undefined) n.textContent = text;
      return n;
    }

    if (block.notes) el.appendChild(make('p', 'rs-post__note', block.notes));
    var meta = [];
    if (block.persona) meta.push(t('meta_persona', { persona: block.persona }));
    if (block.post_id) meta.push(t('meta_post_id', { id: block.post_id }));
    if (meta.length) el.appendChild(make('p', 'rs-post__meta', meta.join(' · ')));

    var tablist = make('div', 'rs-post__tabs');
    tablist.setAttribute('role', 'tablist');
    tablist.setAttribute('aria-label', t('platforms_label'));
    el.appendChild(tablist);
    var holder = make('div', 'rs-post__holder');
    el.appendChild(holder);

    var state = {};      /* auto: included true/false; manual: '', posted, skipped */
    var blocked = {};    /* auto: the reason a platform cannot be posted */
    var tabs = {};
    var panels = {};
    var controls = {};
    var selected = platforms[0];
    var base = 'inp-' + idPart(block.id);

    platforms.forEach(function (p) {
      var text = composed(p);
      var name = names[p];
      /* the reasons: over a limit, Instagram over its hashtags or without media */
      var res = count(text, p);
      if (res.hashtagLimit !== undefined) res.hashtags = count(tagCounted(p, text), p).hashtags;
      var reasons = [];
      if (res.count > res.limit) {
        reasons.push(auto ? t('shorten_to_approve', { n: num(res.count - res.limit) })
          : t('manual_over_limit', { limit: num(res.limit), platform: name }));
      }
      if (res.hashtagLimit !== undefined && res.hashtags > res.hashtagLimit) {
        reasons.push(auto ? t('hashtags_to_approve', { limit: res.hashtagLimit })
          : t('manual_over_hashtags', { limit: res.hashtagLimit, platform: name }));
      }
      if (p === 'instagram' && !visual) reasons.push(t('lint_ig_needs_image'));
      if (auto && reasons.length) blocked[p] = reasons.join(' ' + t('sep') + ' ');
      state[p] = auto ? !blocked[p] : '';

      /* the tab: name, then a glyph and spoken words for its state */
      var tab = make('button', 'rs-post__tab');
      tab.type = 'button';
      tab.id = base + '-tab-' + p;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('data-platform', p);
      tab.appendChild(make('span', 'rs-post__tabname', name));
      var mark = make('span', 'rs-post__mark');
      mark.setAttribute('aria-hidden', 'true');
      tab.appendChild(mark);
      var spoken = make('span', 'rs-vh');
      tab.appendChild(spoken);
      tab.addEventListener('click', function () { select(p, false); });
      tablist.appendChild(tab);
      tabs[p] = { el: tab, mark: mark, spoken: spoken };

      var panel = make('div', 'rs-post__panel');
      panel.id = base + '-panel-' + p;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      panel.setAttribute('data-platform', p);
      panel.setAttribute('data-mode', auto ? 'auto' : 'manual');

      /* the preview: slots complete before the frame renders */
      var frame = document.createElement('rs-post-frame');
      frame.setAttribute('skin', p);
      frame.setAttribute('no-chrome', '');
      if (visual) frame.setAttribute('ratio', visual.ratio);
      var slots = document.createDocumentFragment();
      if (author.avatar) {
        var avatar = slot('img', 'avatar');
        avatar.src = ctx.media(author.avatar);
        avatar.alt = '';
        slots.appendChild(avatar);
      }
      slots.appendChild(slot('span', 'name', author.name));
      if (p === 'x') slots.appendChild(slot('span', 'handle', t('pf_handle', { handle: author.handle })));
      if (p === 'instagram') slots.appendChild(slot('span', 'handle', author.handle));
      if (p === 'linkedin' && author.headline) slots.appendChild(slot('span', 'headline', author.headline));
      slots.appendChild(slot('div', 'text', text));
      if (video) {
        var vid = slot('video', 'video');
        vid.controls = true;
        vid.preload = 'metadata';
        vid.poster = ctx.media(video.poster);
        vid.src = ctx.media(video.path);
        vid.setAttribute('aria-label', video.alt);
        slots.appendChild(vid);
      } else if (image) {
        var img = slot('img', 'image');
        img.src = ctx.media(image.path);
        img.alt = image.alt;
        slots.appendChild(img);
      } else if (block.link && p !== 'instagram') {
        slots.appendChild(slot('span', 'link-domain', block.link.domain));
        slots.appendChild(slot('span', 'link-title', block.link.title));
      }
      /* a quote under the body; on a reply the parent card above the post */
      if (target && p !== 'instagram') {
        slots.appendChild(slot('span', 'target-type', target.type));
        if (target.type === 'reply') {
          var ra = target.author || {};
          slots.appendChild(slot('span', 'reply', ra.handle ? t('replying_to', { handle: ra.handle })
            : (ra.name ? t('replying_to_name', { name: ra.name }) : t('replying_to_post'))));
        }
        if (target.author && target.author.name) slots.appendChild(slot('span', 'quote-name', target.author.name));
        if (target.author && target.author.handle) slots.appendChild(slot('span', 'quote-handle', t('pf_handle', { handle: target.author.handle })));
        if (target.excerpt) slots.appendChild(slot('div', 'quote-excerpt', target.excerpt));
        slots.appendChild(slot('span', 'quote-domain', quoteDomain(target.url)));
        slots.appendChild(slot('span', 'quote-url', target.url));
      }
      frame.appendChild(slots);
      panel.appendChild(frame);

      var side = make('div', 'rs-post__side');
      var decideBox = make('div', 'rs-post__decide');
      var stateLine = null;
      var toggle = null;
      var group = null;
      if (auto && blocked[p]) {
        stateLine = make('p', 'rs-post__state');
        decideBox.appendChild(stateLine);
        var reason = make('p', 'rs-post__reason');
        reason.id = base + '-reason-' + p;
        var dot = make('span', 'rs-dot');
        dot.setAttribute('data-rs-status', 'danger');
        dot.setAttribute('aria-hidden', 'true');
        reason.appendChild(dot);
        reason.appendChild(document.createTextNode(blocked[p]));
        decideBox.appendChild(reason);
      } else if (auto) {
        /* the one inclusion control: a labelled switch, on = goes out */
        toggle = make('button', 'rs-switch rs-post__toggle');
        toggle.type = 'button';
        toggle.id = base + '-toggle-' + p;
        toggle.setAttribute('role', 'switch');
        toggle.setAttribute('data-rs-leave-out', p);
        var track = make('span', 'rs-switch__track');
        track.setAttribute('aria-hidden', 'true');
        toggle.appendChild(track);
        toggle.appendChild(make('span', 'rs-switch__label', t('inp_post_switch', { platform: name })));
        toggle.addEventListener('click', function () {
          if (locked) return;
          state[p] = !state[p];
          renderPlatform(p);
          ctx.changed();
        });
        decideBox.appendChild(toggle);
      } else {
        group = document.createElement('rs-segmented');
        group.setAttribute('data-item', p);
        group.setAttribute('label', t('choice_group_label', { what: name }));
        ['posted', 'skipped'].forEach(function (value) {
          group.appendChild(segment(value, t(LABEL_KEYS[value]), base + '-' + p + '-' + value));
        });
        group.addEventListener('change', function () {
          state[p] = group.value;
          renderPlatform(p);
          ctx.changed();
        });
        decideBox.appendChild(group);
        if (reasons.length) {
          var advice = make('p', 'rs-post__reason', reasons.join(' ' + t('sep') + ' '));
          advice.setAttribute('data-advice', '');
          decideBox.appendChild(advice);
        }
      }
      side.appendChild(decideBox);

      /* counters count exactly the composed text */
      var counts = make('div', 'rs-post__counts');
      var counter = document.createElement('rs-counter');
      counter.setAttribute('platform', p);
      counter.text = text;
      counts.appendChild(counter);
      if (p === 'instagram') {
        var tagCount = make('span', 'rs-post__tagcount', t('hashtags') + ' ');
        var tagCounter = document.createElement('rs-counter');
        tagCounter.setAttribute('platform', p);
        tagCounter.setAttribute('kind', 'hashtags');
        tagCounter.text = tagCounted(p, text);
        tagCount.appendChild(tagCounter);
        counts.appendChild(tagCount);
      }
      side.appendChild(counts);
      if (p === 'x' && res.fold && res.count > res.fold && res.count <= res.limit) {
        side.appendChild(make('p', 'rs-post__quiet', t('x_long_post')));
      }
      var checked = text + '\n' + (block.first_comment || '').normalize('NFC');
      var found = flags.filter(function (f) { return checked.indexOf(f.normalize('NFC')) >= 0; });
      if (found.length) {
        side.appendChild(make('p', 'rs-post__quiet', t('style_notes', {
          items: found.map(function (f) { return t('quoted', { text: f }); }).join(', ')
        })));
      }

      /* copies: manual first the media and the link (the person posts) */
      var copies = make('div', 'rs-post__copies');
      function addCopy(id, label, value, attrs) {
        var c = document.createElement('rs-copy');
        c.setAttribute('data-copy-id', base + '-' + p + '-' + id);
        c.setAttribute('label', label);
        c.setAttribute('caption', '');
        Object.keys(attrs || {}).forEach(function (k) { c.setAttribute(k, attrs[k]); });
        if (value !== null) c.text = value;
        copies.appendChild(c);
        return c;
      }
      addCopy('text', t('copy_text'), text, { 'no-value': '' });
      if (tagsOf(p).length) addCopy('hashtags', t('copy_hashtags'), tagLineOf(p), appends(p) ? { icon: 'hash', 'no-value': '' } : { icon: 'hash' });
      if (block.first_comment) {
        var comment = addCopy('comment', t('copy_comment'), block.first_comment, { block: '' });
        comment.classList.add('rs-post__comment');
      }
      if (!auto) {
        if (video) addCopy('video', t('copy_path'), null, { media: video.path, 'media-copy': 'path', 'no-value': '' });
        else if (image) addCopy('image', t('copy_image'), null, { media: image.path, icon: 'image', 'no-value': '' });
        if (target) addCopy('link', t('copy_link'), target.url, {});
      }
      side.appendChild(copies);

      var tools = make('div', 'rs-post__tools');
      if (visual) {
        var reveal = make('button', 'rs-link rs-post__reveal');
        reveal.type = 'button';
        reveal.setAttribute('data-rs-reveal', '');
        reveal.setAttribute('data-rs-view-action', '');
        reveal.appendChild(svg('folder'));
        reveal.appendChild(make('span', null, t('reveal')));
        reveal.addEventListener('click', function () { ctx.reveal(visual.path); });
        tools.appendChild(reveal);
      }
      if (!locked) {
        var refLabel = t('inp_post_ref', { platform: name });
        tools.appendChild(replyButton(ctx, { block: block.id, item: p, label: refLabel }, refLabel));
      }
      if (tools.childNodes.length) side.appendChild(tools);
      panel.appendChild(side);
      panels[p] = panel;
      controls[p] = { stateLine: stateLine, toggle: toggle, group: group };
    });

    /* the state a tab and its panel show */
    function stateOf(p) {
      if (auto) {
        if (blocked[p]) return 'blocked';
        if (state[p] === null) return 'none';
        return state[p] ? 'included' : 'left-out';
      }
      return state[p] || 'open';
    }
    /* no tick while nothing is sent: only a platform posted by hand has one */
    var GLYPH = { included: '', posted: '✓', blocked: '!', 'left-out': '–', skipped: '–', open: '', none: '' };
    var SPOKEN = {
      included: 'inp_post_included', 'left-out': 'inp_post_left_out', blocked: 'inp_post_blocked',
      posted: 'inp_post_posted', skipped: 'inp_post_skipped', open: 'inp_post_open', none: null
    };
    function renderPlatform(p) {
      var s = stateOf(p);
      var tab = tabs[p];
      tab.el.setAttribute('data-state', s);
      tab.mark.textContent = GLYPH[s];
      /* a status colour on a small mark only (calm K6) */
      if (s === 'blocked') tab.mark.setAttribute('data-rs-status', 'danger');
      else if (s === 'posted') tab.mark.setAttribute('data-rs-status', 'ok');
      else tab.mark.removeAttribute('data-rs-status');
      tab.spoken.textContent = SPOKEN[s] ? ', ' + t(SPOKEN[s]) : '';
      panels[p].setAttribute('data-state', s);
      var c = controls[p];
      /* a platform that cannot go out says so; the others have their switch */
      if (c.stateLine) {
        c.stateLine.textContent = '';
        var glyph = make('span', 'rs-post__glyph', GLYPH['left-out']);
        glyph.setAttribute('aria-hidden', 'true');
        c.stateLine.appendChild(glyph);
        c.stateLine.appendChild(document.createTextNode(t('inp_post_left_out_line', { platform: names[p] })));
      }
      if (c.toggle) {
        c.toggle.setAttribute('aria-checked', state[p] === true ? 'true' : 'false');
        c.toggle.hidden = s === 'none';
      }
      if (c.group && c.group.value !== (state[p] || '')) c.group.value = state[p] || '';
    }

    /* tabs: one selected, roving tabindex, arrows / Home / End; only the
       selected panel is in the document */
    function select(p, focus) {
      selected = p;
      platforms.forEach(function (q) {
        var on = q === p;
        tabs[q].el.setAttribute('aria-selected', on ? 'true' : 'false');
        tabs[q].el.tabIndex = on ? 0 : -1;
        if (on) {
          tabs[q].el.setAttribute('aria-controls', panels[q].id);
          if (!panels[q].isConnected) holder.appendChild(panels[q]);
        } else {
          tabs[q].el.removeAttribute('aria-controls');
          if (panels[q].isConnected) panels[q].remove();
        }
      });
      if (focus) tabs[p].el.focus();
    }
    tablist.addEventListener('keydown', function (e) {
      if (!plainKey(e)) return;
      var i = platforms.indexOf(selected);
      var n = platforms.length;
      var j = -1;
      if (e.key === 'ArrowRight') j = (i + 1) % n;
      else if (e.key === 'ArrowLeft') j = (i - 1 + n) % n;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = n - 1;
      else if (!locked && String(e.key).toLowerCase() === 'r') {
        e.preventDefault();
        var label = t('inp_post_ref', { platform: names[selected] });
        ctx.addRef({ block: block.id, item: selected, label: label });
        return;
      }
      if (j < 0) return;
      e.preventDefault();
      select(platforms[j], true);
    });

    function postable() { return platforms.filter(function (p) { return auto && !blocked[p]; }); }
    function included() { return platforms.filter(function (p) { return auto && !blocked[p] && state[p] === true; }); }
    function listOf(items) {
      try {
        return new Intl.ListFormat(ctx.lang === 'en' ? 'en' : 'de', { style: 'long', type: 'conjunction' }).format(items);
      } catch (e) {
        return items.join(', ');
      }
    }

    function restore(saved) {
      if (!saved || typeof saved !== 'object') return;
      var entries = Array.isArray(saved.platforms) ? saved.platforms : [];
      entries.forEach(function (entry) {
        if (!entry || platforms.indexOf(entry.platform) < 0) return;
        var p = entry.platform;
        if (auto && typeof entry.included === 'boolean') state[p] = blocked[p] ? false : entry.included;
        if (!auto && (entry.choice === 'posted' || entry.choice === 'skipped')) state[p] = entry.choice;
        renderPlatform(p);
      });
      if (typeof saved.tab === 'string' && platforms.indexOf(saved.tab) >= 0) select(saved.tab, false);
    }

    /* a decided report shows exactly what was sent; without an answer
       (rejected, changes requested) nothing reads as chosen */
    function reconcile() {
      platforms.forEach(function (p) { if (!blocked[p]) state[p] = auto ? null : ''; });
      restore(sentAnswer(block, run));
      platforms.forEach(renderPlatform);
    }
    /* decided: the switch shows what was sent and no longer changes; with
       nothing sent (rejected, changes requested) it goes */
    function lockControls() {
      platforms.forEach(function (p) {
        var c = controls[p];
        if (c.toggle && stateOf(p) === 'none') { c.toggle.remove(); c.toggle = null; }
        if (c.toggle) c.toggle.disabled = true;
        if (c.group) c.group.disabled = true;
        var reply = panels[p].querySelector('.rs-reply');
        if (reply) reply.remove();
      });
    }
    platforms.forEach(renderPlatform);
    select(selected, false);
    if (locked) { reconcile(); lockControls(); }

    function answer() {
      if (auto) {
        if (!included().length) return null;
        return { platforms: platforms.map(function (p) { return { platform: p, included: !blocked[p] && state[p] === true }; }) };
      }
      if (platforms.some(function (p) { return !state[p]; })) return null;
      return { platforms: platforms.map(function (p) { return { platform: p, choice: state[p] }; }) };
    }

    return {
      el: el,
      answer: answer,
      progress: function () {
        if (auto) return { done: included().length, total: platforms.length };
        return { done: platforms.filter(function (p) { return !!state[p]; }).length, total: platforms.length };
      },
      primaryLabel: function () {
        if (!auto) return null;
        var list = included();
        return list.length ? t('inp_approve_post_to', { platforms: listOf(list.map(function (p) { return names[p]; })) }) : null;
      },
      hint: function () {
        if (!auto || included().length) return null;
        return { key: postable().length ? 'ask_hint_all_left_out' : 'ask_hint_none_postable', vars: {} };
      },
      snapshot: function () {
        var changed = platforms.filter(function (p) { return auto ? (!blocked[p] && state[p] === false) : !!state[p]; });
        if (!changed.length) return null;
        return {
          tab: selected,
          platforms: platforms.map(function (p) {
            return auto ? { platform: p, included: !blocked[p] && state[p] === true } : { platform: p, choice: state[p] || null };
          })
        };
      },
      restore: restore,
      lock: function () {
        locked = true;
        reconcile();
        lockControls();
      }
    };
  }

  var CREATE = { decide: decide, pick: pick, post: post };

  /** The handle of an input block, or null for any other block type. */
  function create(block, run, ctx) {
    if (!block || !has(CREATE, block.type)) return null;
    return CREATE[block.type](block, run, ctx);
  }

  window.RSInputs = { create: create, types: Object.keys(CREATE) };
})();
