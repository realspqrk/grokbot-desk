/* grokbot-desk: the content blocks of a report.
 *
 * window.RSBlocks.render(block, ctx) -> HTMLElement for the content types
 * text stats table chart facts checks media copy (input blocks are
 * inputs.js). Every block is a <section data-rs-block-type data-rs-block>
 * with its optional title as an h2.
 *
 * ctx = {t(key, vars), lang, media(id) -> url, mediaKind(id) -> "image" |
 * "video", link(url) -> anchor | null (the page's link rules), openUrl,
 * copy, copyImage, copyPath, reveal, addRef({block, item, label}),
 * locked}. Reply targets here are the ## and ### headings of a text block
 * (item section:<n>, numbered as core/payload.py does).
 *
 * Read-only never looks like input: checks and markdown task lists are a
 * glyph (✓ ! ✕ ○) and a word, never a box. Status is never colour alone.
 * Numbers are right-aligned with tabular figures; deltas carry ▲ / ▼ and a
 * sign, coloured by `good` (stats tiles; table columns have no `good`). Long tables fold at 10 rows. Every chart has a
 * "Show data" table. No literal UI strings: every word is ctx.t or payload.
 */
(function () {
  'use strict';

  var FOLD_ROWS = 10;
  var REF_LABEL_MAX = 120;
  var GLYPHS = { ok: '✓', warn: '!', fail: '✕', open: '○' };
  var STATE_KEYS = { ok: 'blk_state_ok', warn: 'blk_state_warn', fail: 'blk_state_fail', open: 'blk_state_open' };
  var NUMERIC = { number: true, money: true, percent: true, delta: true };
  var MINUS = '−';
  /* a number column shows the value as written (0.001 stays 0,001) */
  var SOURCE_DIGITS = { maximumFractionDigits: 10 };

  function make(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function locale(ctx) { return ctx.lang === 'en' ? 'en-US' : 'de-DE'; }
  function vh(text) { return make('span', 'rs-vh', text); }

  // ------------------------------------------------------------ numbers --
  function numberText(ctx, v, opts) {
    return new Intl.NumberFormat(locale(ctx), opts || { maximumFractionDigits: 2 }).format(v).replace(/-/g, MINUS);
  }
  /* the direction of a delta: up, down or flat (a number, or text such as "+6.1 %") */
  function direction(delta) {
    if (typeof delta === 'number') return delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat');
    var s = String(delta).trim();
    if (/^\+/.test(s)) return 'up';
    if (/^[-−]/.test(s)) return 'down';
    return 'flat';
  }
  function deltaText(ctx, delta) {
    if (typeof delta !== 'number') return String(delta).replace(/^-/, MINUS);
    if (delta === 0) return '±0';
    return new Intl.NumberFormat(locale(ctx), { maximumFractionDigits: 2, signDisplay: 'always' })
      .format(delta).replace(/-/g, MINUS);
  }
  /* ▲ +6.1 % coloured by good: tone good / bad, or neutral without good */
  function delta(ctx, value, good, cls) {
    var dir = direction(value);
    var span = make('span', cls);
    var tone = dir === 'flat' || !good ? 'neutral' : (dir === good ? 'good' : 'bad');
    span.setAttribute('data-tone', tone);
    var glyph = dir === 'up' ? '▲' : (dir === 'down' ? '▼' : '');
    span.textContent = (glyph ? glyph + ' ' : '') + deltaText(ctx, value);
    if (tone !== 'neutral') span.appendChild(vh(' ' + ctx.t(tone === 'good' ? 'blk_delta_better' : 'blk_delta_worse')));
    return span;
  }
  function status(ctx, state, cls) {
    var span = make('span', cls);
    if (!Object.prototype.hasOwnProperty.call(GLYPHS, state)) {
      span.textContent = state == null ? '' : String(state);
      return span;
    }
    span.setAttribute('data-state', state);
    var mark = make('span', 'rs-glyph', GLYPHS[state]);
    mark.setAttribute('aria-hidden', 'true');
    span.appendChild(mark);
    span.appendChild(document.createTextNode(' ' + ctx.t(STATE_KEYS[state])));
    return span;
  }
  function dateText(ctx, iso) {
    var d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(iso)) ? iso + 'T12:00:00Z' : iso);
    if (isNaN(d.getTime())) return String(iso);
    return new Intl.DateTimeFormat(locale(ctx), { dateStyle: 'medium', timeZone: 'UTC' }).format(d);
  }

  // ------------------------------------------------------------- blocks --
  function text(block, ctx, section) {
    var images = {};
    (block.images || []).forEach(function (m) { images[m.key] = m; });
    return window.RSMd.render(block.md, {
      t: ctx.t,
      link: ctx.link,
      image: function (key) {
        var m = Object.prototype.hasOwnProperty.call(images, key) ? images[key] : null;
        return m ? { src: ctx.media(m.path), alt: m.alt } : null;
      },
      section: function (heading, n, title) {
        if (ctx.locked) return heading;
        var head = make('div', 'rs-md__head');
        head.appendChild(heading);
        var label = (title || ctx.t('blk_section_n', { n: n + 1 })).replace(/\s+/g, ' ').slice(0, REF_LABEL_MAX);
        var reply = make('button', 'rs-reply');
        reply.type = 'button';
        reply.setAttribute('data-rs-reply-section', String(n));
        reply.setAttribute('aria-label', ctx.t('blk_reply_to', { what: label }));
        reply.title = ctx.t('blk_reply');
        reply.appendChild(replyIcon());
        reply.addEventListener('click', function () {
          ctx.addRef({ block: section.id, item: 'section:' + n, label: label });
        });
        head.appendChild(reply);
        return head;
      }
    });
  }

  function replyIcon() {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', 'rs-ico');
    var p = document.createElementNS(NS, 'path');
    p.setAttribute('d', 'M9.5 7 4.5 12l5 5M5 12h9a5.5 5.5 0 0 1 5.5 5.5V19');
    svg.appendChild(p);
    return svg;
  }

  function stats(block, ctx) {
    var grid = make('div', 'rs-stats');
    grid.setAttribute('data-count', String(block.items.length));
    block.items.forEach(function (item) {
      var tile = make('div', 'rs-stat');
      tile.appendChild(make('p', 'rs-stat__label', item.label));
      tile.appendChild(make('p', 'rs-stat__value', item.value));
      var hasDelta = item.delta !== undefined && item.delta !== null;
      var hasSpark = Array.isArray(item.spark) && item.spark.length > 1;
      if (hasDelta || hasSpark) {
        var row = make('div', 'rs-stat__row');
        if (hasDelta) {
          var line = make('p', 'rs-stat__deltaline');
          line.appendChild(delta(ctx, item.delta, item.good, 'rs-stat__delta'));
          row.appendChild(line);
        }
        if (hasSpark) row.appendChild(window.RSCharts.spark(item.spark, ctx));
        tile.appendChild(row);
      }
      if (hasSpark) tile.appendChild(sparkTable(item, ctx));
      if (item.note) tile.appendChild(make('p', 'rs-stat__note', item.note));
      grid.appendChild(tile);
    });
    return grid;
  }

  /* the full series of a sparkline, for assistive technology only (the
     tile shows the current value; the line is its shape) */
  function sparkTable(item, ctx) {
    var box = make('div', 'rs-vh');
    var t = make('table');
    t.appendChild(make('caption', null, item.label));
    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    [ctx.t('blk_chart_label'), ctx.t('blk_spark_value')].forEach(function (text) {
      var th = make('th', null, text);
      th.scope = 'col';
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    t.appendChild(thead);
    var tbody = document.createElement('tbody');
    var fmt = window.RSCharts.format(ctx, item.spark);
    item.spark.forEach(function (v, i) {
      var tr = document.createElement('tr');
      var th = make('th', null, ctx.t('blk_spark_point', { n: i + 1 }));
      th.scope = 'row';
      tr.appendChild(th);
      tr.appendChild(make('td', null, fmt(v).replace(/-/g, MINUS)));
      tbody.appendChild(tr);
    });
    t.appendChild(tbody);
    box.appendChild(t);
    return box;
  }

  function cell(ctx, column, value, tag) {
    var type = column.type || 'text';
    var td = make(tag || 'td');
    td.setAttribute('data-type', type);
    var align = column.align || (NUMERIC[type] ? 'right' : '');
    if (align) td.setAttribute('data-align', align);
    if (value === null || value === undefined || value === '') return td;
    if (type === 'number') td.textContent = typeof value === 'number' ? numberText(ctx, value, SOURCE_DIGITS) : String(value);
    else if (type === 'money') {
      td.textContent = typeof value === 'number'
        ? numberText(ctx, value, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(value);
    } else if (type === 'percent') {
      td.textContent = typeof value === 'number'
        ? numberText(ctx, value / 100, { style: 'percent', maximumFractionDigits: 10 }) : String(value);
    } else if (type === 'delta') {
      /* coloured by the column's good; without it the colour stays neutral */
      td.appendChild(delta(ctx, value, column.good === 'up' || column.good === 'down' ? column.good : null, 'rs-delta'));
    }
    else if (type === 'status') td.appendChild(status(ctx, value, 'rs-status'));
    else if (type === 'date') td.textContent = dateText(ctx, value);
    else td.textContent = typeof value === 'number' ? numberText(ctx, value) : String(value);
    return td;
  }

  function table(block, ctx) {
    var holder = make('div', 'rs-tablewrap');
    var scroll = make('div', 'rs-blk__scroll');
    var t = make('table', 'rs-table');
    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    block.columns.forEach(function (column) {
      var th = cell(ctx, column, null, 'th');
      th.scope = 'col';
      th.textContent = column.label;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    t.appendChild(thead);
    var tbody = document.createElement('tbody');
    var rows = block.rows || [];
    rows.forEach(function (row, i) {
      var tr = document.createElement('tr');
      block.columns.forEach(function (column) { tr.appendChild(cell(ctx, column, row[column.key])); });
      if (rows.length > FOLD_ROWS && i >= FOLD_ROWS) tr.hidden = true;
      tbody.appendChild(tr);
    });
    t.appendChild(tbody);
    if (block.total && typeof block.total === 'object') {
      var tfoot = document.createElement('tfoot');
      var fr = document.createElement('tr');
      block.columns.forEach(function (column) { fr.appendChild(cell(ctx, column, block.total[column.key])); });
      tfoot.appendChild(fr);
      t.appendChild(tfoot);
    }
    scroll.appendChild(t);
    holder.appendChild(scroll);
    if (rows.length > FOLD_ROWS) {
      var more = make('button', 'rs-fold', ctx.t('blk_show_rows', { n: rows.length }));
      more.type = 'button';
      more.setAttribute('data-rs-show-rows', '');
      more.setAttribute('data-rs-view-action', '');
      more.setAttribute('aria-expanded', 'false');
      more.addEventListener('click', function () {
        var open = more.getAttribute('aria-expanded') !== 'true';
        Array.prototype.forEach.call(tbody.rows, function (tr, i) { if (i >= FOLD_ROWS) tr.hidden = !open; });
        scroll.toggleAttribute('data-open', open);
        more.setAttribute('aria-expanded', open ? 'true' : 'false');
        more.textContent = open ? ctx.t('blk_show_fewer_rows') : ctx.t('blk_show_rows', { n: rows.length });
        if (!open) holder.scrollIntoView({ block: 'nearest' });
      });
      holder.appendChild(more);
    }
    return holder;
  }

  function chart(block, ctx) {
    var box = make('div', 'rs-chartbox');
    var draw = block.kind === 'line' ? window.RSCharts.line : window.RSCharts.bar;
    /* drawn at the width it gets, so labels stay 12px: redrawn when the
       column changes width */
    var svg = draw(block, ctx);
    box.appendChild(svg);
    var drawn = 0;
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(function () {
        var width = Math.round(box.clientWidth);
        if (!width || width === drawn) return;
        drawn = width;
        var next = draw(block, Object.assign({}, ctx, { width: width }));
        box.replaceChild(next, svg);
        svg = next;
      }).observe(box);
    }
    var details = make('details', 'rs-disclosure rs-blk__data');
    var summary = make('summary', null, ctx.t('blk_show_data'));
    details.appendChild(summary);
    var scroll = make('div', 'rs-blk__scroll');
    var t = make('table', 'rs-table');
    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    var first = make('th', null, ctx.t('blk_chart_label'));
    first.scope = 'col';
    hr.appendChild(first);
    var series = (block.series || []).slice(0, 4);
    series.forEach(function (s) {
      var th = make('th', null, block.unit ? s.name + ' (' + block.unit + ')' : s.name);
      th.scope = 'col';
      th.setAttribute('data-align', 'right');
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    t.appendChild(thead);
    var tbody = document.createElement('tbody');
    var all = [];
    series.forEach(function (s) { all = all.concat(s.values); });
    var fmt = window.RSCharts.format(ctx, all);
    (block.labels || []).forEach(function (label, i) {
      var tr = document.createElement('tr');
      var th = make('th', null, label);
      th.scope = 'row';
      tr.appendChild(th);
      series.forEach(function (s) {
        var td = make('td', null, typeof s.values[i] === 'number' ? fmt(s.values[i]).replace(/-/g, MINUS) : '');
        td.setAttribute('data-align', 'right');
        td.setAttribute('data-type', 'number');
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    t.appendChild(tbody);
    scroll.appendChild(t);
    details.appendChild(scroll);
    box.appendChild(details);
    return box;
  }

  function facts(block) {
    var dl = make('dl', 'rs-facts');
    block.items.forEach(function (item) {
      var row = make('div', 'rs-facts__row');
      row.appendChild(make('dt', null, item.label));
      row.appendChild(make('dd', null, item.value));
      dl.appendChild(row);
    });
    return dl;
  }

  function checks(block, ctx) {
    var list = make('ul', 'rs-checks');
    block.items.forEach(function (item) {
      var li = make('li', 'rs-check-item');
      li.setAttribute('data-state', item.state);
      var mark = make('span', 'rs-check-item__mark rs-glyph', GLYPHS[item.state]);
      mark.setAttribute('aria-hidden', 'true');
      li.appendChild(mark);
      var body = make('span', 'rs-check-item__body');
      body.appendChild(make('span', 'rs-check-item__label', item.label));
      if (item.detail) body.appendChild(make('span', 'rs-check-item__detail', item.detail));
      li.appendChild(body);
      li.appendChild(make('span', 'rs-check-item__state', ctx.t(STATE_KEYS[item.state])));
      list.appendChild(li);
    });
    return list;
  }

  function media(block, ctx) {
    var fig = make('figure', 'rs-media');
    var video = ctx.mediaKind && ctx.mediaKind(block.path) === 'video';
    var node;
    if (video) {
      node = document.createElement('video');
      node.controls = true;
      node.preload = 'metadata';
      node.setAttribute('aria-label', block.alt);
      if (block.poster) node.poster = ctx.media(block.poster);
    } else {
      node = document.createElement('img');
      node.alt = block.alt;
      node.decoding = 'async';
    }
    node.className = 'rs-media__item';
    var missing = make('p', 'rs-media__missing', ctx.t('blk_media_missing', { alt: block.alt }));
    missing.hidden = true;
    node.addEventListener('error', function () {
      node.hidden = true;
      missing.hidden = false;
    });
    node.src = ctx.media(block.path);
    fig.appendChild(node);
    fig.appendChild(missing);
    return fig;
  }

  function copies(block, ctx) {
    var box = make('div', 'rs-copies');
    block.items.forEach(function (item, i) {
      var copy = document.createElement('rs-copy');
      copy.setAttribute('data-copy-id', (block.id || 'copy') + '-' + (i + 1));
      copy.setAttribute('label', item.label);
      copy.setAttribute('caption', '');
      copy.setAttribute('block', '');
      if (item.text.length > 160) copy.setAttribute('max-lines', '4');
      copy.text = item.text;
      box.appendChild(copy);
    });
    return box;
  }

  var RENDER = { text: text, stats: stats, table: table, chart: chart, facts: facts, checks: checks, media: media, copy: copies };

  function render(block, ctx) {
    var type = block.type;
    var section = make('section', 'rs-blk rs-blk--' + type);
    section.setAttribute('data-rs-block-type', type);
    if (block.id) section.setAttribute('data-rs-block', block.id);
    var body = Object.prototype.hasOwnProperty.call(RENDER, type) ? RENDER[type](block, ctx, block) : make('div');
    if (type === 'text' && block.collapsed) {
      /* folded behind its title; read-only, so it opens even when locked */
      var details = make('details', 'rs-disclosure rs-blk__fold');
      var summary = make('summary', null, block.title || ctx.t('blk_details'));
      details.appendChild(summary);
      details.appendChild(body);
      section.appendChild(details);
      return section;
    }
    if (block.title) {
      var h = make('h2', 'rs-blk__title', block.title);
      section.appendChild(h);
    }
    section.appendChild(body);
    return section;
  }

  window.RSBlocks = { render: render, types: Object.keys(RENDER) };
})();
