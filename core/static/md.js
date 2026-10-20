/* grokbot-desk: the markdown of a `text` block (a safe subset).
 *
 * Headings, paragraphs, emphasis, code, links, images by key, lists, task
 * lists, quotes, callouts (> [!NOTE] ...), tables and rules. The page is
 * built from DOM nodes with textContent only: raw HTML stays text, a link
 * becomes an anchor only through opts.link (the page's link rules), an
 * image loads only through opts.image (a key of the block's images).
 *
 * Reply anchors: section:<n> is the n-th top-level ## or ### heading (ATX
 * or Setext) in document order. core/payload.py _top_headings counts the
 * same headings; tests/fixtures/section_vectors.json keeps both in step.
 *
 * Task list items (- [x], - [ ]) are status, not input: a check glyph or a
 * ring with a word, never a box and never a checkbox role.
 *
 * UMD: window.RSMd in the browser, module.exports in Node (parse/sections
 * need no DOM).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.RSMd = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* Links and emphasis nested deeper than this stay literal text, so no
     payload can exhaust the stack while parsing or rendering. */
  var INLINE_DEPTH = 16;

  // ------------------------------------------------------------ inline --
  var PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
  function isSpace(ch) { return !ch || /\s/.test(ch); }
  function isWord(ch) { return !!ch && /[0-9A-Za-zÀ-￿]/.test(ch); }

  /* index of the ] that closes the [ at `open`, or -1 */
  function closeBracket(s, open) {
    var depth = 0;
    for (var k = open; k < s.length; k++) {
      var ch = s.charAt(k);
      if (ch === '\\') { k++; continue; }
      if (ch === '[') depth++;
      else if (ch === ']') { depth--; if (depth === 0) return k; }
    }
    return -1;
  }
  /* index of the ) that closes the ( at `open`, or -1 */
  function closeParen(s, open) {
    var depth = 0;
    for (var k = open; k < s.length; k++) {
      var ch = s.charAt(k);
      if (ch === '\\') { k++; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) return k; }
      else if (ch === '\n') return -1;
    }
    return -1;
  }
  /* closing emphasis delimiter run of exactly `size` characters */
  function closeDelim(s, from, ch, size) {
    for (var k = from; k < s.length; k++) {
      var c = s.charAt(k);
      if (c === '\\') { k++; continue; }
      if (c === '`') {
        var run = 1;
        while (s.charAt(k + run) === '`') run++;
        var end = s.indexOf(s.substr(k, run), k + run);
        if (end > 0) { k = end + run - 1; continue; }
      }
      if (c !== ch) continue;
      var r = 1;
      while (s.charAt(k + r) === ch) r++;
      if (r >= size && k > from && !isSpace(s.charAt(k - 1))
          && !(ch === '_' && isWord(s.charAt(k + r)))) {
        return k + r - size;
      }
      k += r - 1;
    }
    return -1;
  }

  function parseInline(s, depth) {
    depth = depth || 0;
    var out = [];
    var buf = '';
    function flush() { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } }
    var i = 0;
    while (i < s.length) {
      var c = s.charAt(i);
      var next = s.charAt(i + 1);
      if (c === '\\') {
        if (next === '\n') { buf = buf.replace(/ +$/, ''); flush(); out.push({ t: 'br' }); i += 2; continue; }
        if (next && PUNCT.indexOf(next) >= 0) { buf += next; i += 2; continue; }
      }
      if (c === '\n') {
        if (/ {2,}$/.test(buf)) { buf = buf.replace(/ +$/, ''); flush(); out.push({ t: 'br' }); }
        else buf = buf.replace(/ +$/, '') + ' ';
        i++;
        while (s.charAt(i) === ' ') i++;
        continue;
      }
      if (c === '`') {
        var run = 1;
        while (s.charAt(i + run) === '`') run++;
        var ticks = s.substr(i, run);
        var end = -1;
        for (var k = s.indexOf(ticks, i + run); k >= 0; k = s.indexOf(ticks, k + 1)) {
          if (s.charAt(k + run) !== '`' && s.charAt(k - 1) !== '`') { end = k; break; }
        }
        if (end > 0) {
          var code = s.slice(i + run, end).replace(/\n/g, ' ');
          if (code.length > 2 && code.charAt(0) === ' ' && code.charAt(code.length - 1) === ' ') code = code.slice(1, -1);
          flush();
          out.push({ t: 'code', v: code });
          i = end + run;
          continue;
        }
        buf += ticks;
        i += run;
        continue;
      }
      if (c === '[' || (c === '!' && next === '[')) {
        var image = c === '!';
        var open = image ? i + 1 : i;
        var close = closeBracket(s, open);
        if (close > 0 && s.charAt(close + 1) === '(') {
          var pe = closeParen(s, close + 1);
          if (pe > 0) {
            var label = s.slice(open + 1, close);
            var dest = s.slice(close + 2, pe).trim();
            if (dest.charAt(0) === '<') {
              var gt = dest.indexOf('>');
              dest = gt > 0 ? dest.slice(1, gt) : dest.slice(1);
            } else {
              var sp = dest.search(/\s/);
              if (sp >= 0) dest = dest.slice(0, sp);
            }
            if (!image && depth >= INLINE_DEPTH) { buf += s.slice(i, pe + 1); i = pe + 1; continue; }
            flush();
            if (image) out.push({ t: 'img', alt: label, src: dest });
            else out.push({ t: 'link', kids: parseInline(label, depth + 1), href: dest });
            i = pe + 1;
            continue;
          }
        }
      }
      if (c === '<') {
        var auto = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]+|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/.exec(s.slice(i));
        if (auto) { flush(); out.push({ t: 'url', v: auto[1] }); i += auto[0].length; continue; }
      }
      if (c === '*' || c === '_' || c === '~') {
        var r = 1;
        while (s.charAt(i + r) === c) r++;
        var after = s.charAt(i + r);
        var before = i > 0 ? s.charAt(i - 1) : '';
        var canOpen = !isSpace(after) && !(c === '_' && isWord(before));
        var size = c === '~' ? (r === 2 ? 2 : 0) : Math.min(r, 3);
        if (canOpen && size) {
          var j = closeDelim(s, i + size, c, size);
          if (j > 0 && depth >= INLINE_DEPTH) { buf += s.slice(i, j + size); i = j + size; continue; }
          if (j > 0) {
            var inner = parseInline(s.slice(i + size, j), depth + 1);
            flush();
            if (c === '~') out.push({ t: 's', kids: inner });
            else if (size === 3) out.push({ t: 'strong', kids: [{ t: 'em', kids: inner }] });
            else out.push({ t: size === 2 ? 'strong' : 'em', kids: inner });
            buf = s.substr(i, r - size);
            i = j + size;
            continue;
          }
        }
        buf += s.substr(i, r);
        i += r;
        continue;
      }
      buf += c;
      i++;
    }
    flush();
    return out;
  }

  /* text of parsed inline nodes; iterative, so any nesting depth is safe */
  function plain(nodes) {
    var text = '';
    var stack = nodes.slice().reverse();
    while (stack.length) {
      var n = stack.pop();
      if (n.t === 'text' || n.t === 'code' || n.t === 'url') text += n.v;
      else if (n.t === 'br') text += ' ';
      else if (n.t === 'img') text += n.alt;
      else for (var k = n.kids.length - 1; k >= 0; k--) stack.push(n.kids[k]);
    }
    return text;
  }

  // ------------------------------------------------------------ blocks --
  var LIST_ITEM = /^( {0,12})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
  var FENCE = /^ {0,3}(`{3,}|~{3,})/;
  var HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
  var RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  var QUOTE = /^ {0,3}> ?(.*)$/;
  var DELIM_ROW = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
  var TASK = /^\[([ xX])\](?:[ \t]+([\s\S]*))?$/;
  /* > [!NOTE] alone on the first quoted line makes the quote a callout */
  var CALLOUT = /^\[!(note|tip|important|warning|caution)\][ \t]*$/i;

  function closesFence(line, fence) {
    var t = line.replace(/^ {0,3}/, '').replace(/\s+$/, '');
    if (t.length < fence.length) return false;
    for (var k = 0; k < t.length; k++) if (t.charAt(k) !== fence.charAt(0)) return false;
    return true;
  }
  function splitRow(line) {
    var t = line.trim();
    if (t.charAt(0) === '|') t = t.slice(1);
    if (t.charAt(t.length - 1) === '|' && t.charAt(t.length - 2) !== '\\') t = t.slice(0, -1);
    var cells = [];
    var cell = '';
    for (var k = 0; k < t.length; k++) {
      var ch = t.charAt(k);
      if (ch === '\\' && t.charAt(k + 1) === '|') { cell += '|'; k++; continue; }
      if (ch === '|') { cells.push(cell.trim()); cell = ''; continue; }
      cell += ch;
    }
    cells.push(cell.trim());
    return cells;
  }
  function startsBlock(line) {
    return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line);
  }

  /* nested: inside a callout, where a quote stays a plain quote */
  function parse(src, nested) {
    var lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    var blocks = [];
    var para = [];
    function flush() {
      if (para.length) blocks.push({ type: 'p', text: para.join('\n') });
      para = [];
    }
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      var m;
      if (!line.trim()) { flush(); i++; continue; }
      if (para.length && /^ {0,3}(?:=+|-+)[ \t]*$/.test(line)) {
        blocks.push({ type: 'h', level: line.indexOf('=') >= 0 ? 1 : 2, text: para.join('\n') });
        para = [];
        i++;
        continue;
      }
      if ((m = FENCE.exec(line))) {
        flush();
        var fence = m[1];
        var body = [];
        i++;
        while (i < lines.length && !closesFence(lines[i], fence)) { body.push(lines[i]); i++; }
        i++;
        blocks.push({ type: 'code', text: body.join('\n') });
        continue;
      }
      if ((m = HEADING.exec(line))) {
        flush();
        blocks.push({ type: 'h', level: m[1].length, text: m[2] || '' });
        i++;
        continue;
      }
      if (RULE.test(line)) { flush(); blocks.push({ type: 'hr' }); i++; continue; }
      if (QUOTE.test(line)) {
        flush();
        var quoted = [];
        while (i < lines.length && (m = QUOTE.exec(lines[i]))) { quoted.push(m[1]); i++; }
        var callout = nested ? null : CALLOUT.exec(quoted[0].trim());
        if (callout) {
          blocks.push({ type: 'callout', kind: callout[1].toLowerCase(), blocks: parse(quoted.slice(1).join('\n'), true) });
          continue;
        }
        blocks.push({ type: 'quote', paras: quoted.join('\n').split(/\n\s*\n/) });
        continue;
      }
      if (LIST_ITEM.test(line)) {
        flush();
        var items = [];
        var outer = Infinity;
        while (i < lines.length) {
          var l = lines[i];
          var it = LIST_ITEM.exec(l);
          if (it && !RULE.test(l)) {
            var ordered = /\d/.test(it[2].charAt(0));
            /* another marker type at the outer level starts a new list */
            if (items.length && it[1].length <= outer && ordered !== items[0].ordered) break;
            outer = Math.min(outer, it[1].length);
            items.push({ indent: it[1].length, ordered: ordered, start: ordered ? parseInt(it[2], 10) : 1, text: it[3] || '' });
            i++;
            continue;
          }
          /* an indented line, or a plain line right after an item (lazy continuation), continues it */
          if (l.trim() && items.length && (/^\s{2,}/.test(l) || (lines[i - 1].trim() && !startsBlock(l)))) {
            items[items.length - 1].text += '\n' + l.trim();
            i++;
            continue;
          }
          if (!l.trim()) {
            var n = i + 1;
            while (n < lines.length && !lines[n].trim()) n++;
            if (n < lines.length && (LIST_ITEM.test(lines[n]) || /^\s{2,}\S/.test(lines[n])) && !RULE.test(lines[n])) { i = n; continue; }
          }
          break;
        }
        blocks.push({ type: 'list', items: items });
        continue;
      }
      if (line.indexOf('|') >= 0 && i + 1 < lines.length && DELIM_ROW.test(lines[i + 1]) && lines[i + 1].indexOf('-') >= 0) {
        var head = splitRow(line);
        var aligns = splitRow(lines[i + 1]).map(function (d) {
          var left = d.charAt(0) === ':';
          var right = d.charAt(d.length - 1) === ':';
          return left && right ? 'center' : (right ? 'right' : '');
        });
        if (aligns.length === head.length) {
          flush();
          var rows = [];
          i += 2;
          while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0 && !startsBlock(lines[i])) {
            rows.push(splitRow(lines[i]));
            i++;
          }
          blocks.push({ type: 'table', head: head, aligns: aligns, rows: rows });
          continue;
        }
      }
      para.push(line.replace(/^ {0,3}/, ''));
      i++;
    }
    flush();
    return blocks;
  }

  function isSection(b) { return b.type === 'h' && (b.level === 2 || b.level === 3); }

  /** The text of each reply section (top-level ## or ###), in order. */
  function sections(src) {
    return parse(src).filter(isSection).map(function (b) { return b.text.trim(); });
  }

  /** {done, text} for a task list item ("[x] text"), else null. */
  function taskOf(text) {
    var m = TASK.exec(text);
    return m ? { done: m[1] !== ' ', text: m[2] || '' } : null;
  }

  // ------------------------------------------------------------ render --
  function make(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  var CALLOUT_KEYS = {
    note: 'blk_callout_note', tip: 'blk_callout_tip', important: 'blk_callout_important',
    warning: 'blk_callout_warning', caution: 'blk_callout_caution'
  };

  /** Renders markdown into a new element.
      opts: t(key, vars); image(key) -> {src, alt} | null; link(href) ->
      an anchor or null (not openable: the label stays text);
      section(heading element, n, text) -> the node to place for the n-th
      reply section (default: the heading itself). */
  function render(src, opts) {
    var t = opts.t;
    var root = make('div', 'rs-md');

    function renderImage(n) {
      var found = opts.image ? opts.image(n.src) : null;
      var alt = n.alt.trim() || (found ? found.alt : n.src);
      if (!found) return make('span', 'rs-md__img-missing', t('blk_image_missing', { alt: alt }));
      var img = document.createElement('img');
      img.className = 'rs-md__img';
      img.alt = alt;
      img.decoding = 'async';
      img.addEventListener('error', function () {
        if (img.parentNode) img.parentNode.replaceChild(make('span', 'rs-md__img-missing', t('blk_image_missing', { alt: alt })), img);
      });
      img.src = found.src;
      return img;
    }

    function inline(nodes, parent, depth) {
      depth = depth || 0;
      /* ***x*** nests two elements per parsed level; anything deeper is text */
      if (depth > 2 * INLINE_DEPTH + 2) { parent.appendChild(document.createTextNode(plain(nodes))); return; }
      nodes.forEach(function (n) {
        if (n.t === 'text') parent.appendChild(document.createTextNode(n.v));
        else if (n.t === 'br') parent.appendChild(document.createElement('br'));
        else if (n.t === 'code') parent.appendChild(make('code', 'rs-md__code', n.v));
        else if (n.t === 'url') {
          var auto = opts.link ? opts.link(n.v) : null;
          if (auto) { auto.textContent = n.v; parent.appendChild(auto); }
          else parent.appendChild(make('span', 'rs-md__address', n.v));
        } else if (n.t === 'img') parent.appendChild(renderImage(n));
        else if (n.t === 'link') {
          var anchor = opts.link ? opts.link(n.href) : null;
          var host = anchor || make('span', 'rs-md__link');
          if (anchor) { anchor.classList.add('rs-md__link'); anchor.textContent = ''; }
          inline(n.kids, host, depth + 1);
          parent.appendChild(host);
          /* where a link goes stays visible next to its words */
          if (n.href && n.href !== plain(n.kids)) parent.appendChild(make('span', 'rs-md__url', n.href));
        } else {
          var el = document.createElement(n.t);
          inline(n.kids, el, depth + 1);
          parent.appendChild(el);
        }
      });
    }

    function list(items, from, base) {
      /* items[from] opens a list whose items sit at indent `base` or deeper;
         2+ more spaces open a nested list. Returns { el, next }. */
      var first = items[from];
      var el = make(first.ordered ? 'ol' : 'ul', 'rs-md__list');
      if (first.ordered && first.start !== 1) el.start = first.start;
      var k = from;
      var li = null;
      while (k < items.length && items[k].indent >= base) {
        var it = items[k];
        if (it.indent > base + 1 && li) {
          var nested = list(items, k, it.indent);
          li.appendChild(nested.el);
          k = nested.next;
          continue;
        }
        li = document.createElement('li');
        var task = taskOf(it.text);
        var host = li;
        if (task) {
          /* status, not input: a glyph and a word, no box, no checkbox role */
          li.className = 'rs-md__task';
          li.setAttribute('data-state', task.done ? 'done' : 'open');
          var mark = make('span', 'rs-md__mark', task.done ? '✓' : '○');
          mark.setAttribute('aria-hidden', 'true');
          /* a status colour on a small mark only (calm K6) */
          if (task.done) mark.setAttribute('data-rs-status', 'ok');
          li.appendChild(mark);
          li.appendChild(make('span', 'rs-vh', t(task.done ? 'blk_task_done' : 'blk_task_open') + ': '));
          host = make('span', 'rs-md__task-text');
          li.appendChild(host);
          el.classList.add('rs-md__list--tasks');
        }
        inline(parseInline(task ? task.text : it.text), host);
        el.appendChild(li);
        k++;
      }
      return { el: el, next: k };
    }

    var section = 0;
    /* top: only top-level ## / ### are reply sections (core/payload.py) */
    function block(b, top) {
      if (b.type === 'p') {
        var nodes = parseInline(b.text);
        if (nodes.length === 1 && nodes[0].t === 'img') {
          var fig = make('div', 'rs-md__figure');
          fig.appendChild(renderImage(nodes[0]));
          return fig;
        }
        var p = make('p', 'rs-md__p');
        inline(nodes, p);
        return p;
      }
      if (b.type === 'h') {
        var h = make('h' + Math.min(6, b.level + 1), 'rs-md__h rs-md__h--' + Math.min(4, b.level));
        inline(parseInline(b.text), h);
        if (top && isSection(b)) {
          var n = section++;
          h.setAttribute('data-rs-section', String(n));
          return opts.section ? opts.section(h, n, b.text.trim()) : h;
        }
        return h;
      }
      if (b.type === 'code') {
        var pre = make('pre', 'rs-md__pre');
        pre.appendChild(make('code', null, b.text));
        return pre;
      }
      if (b.type === 'hr') return make('hr', 'rs-md__hr');
      if (b.type === 'quote') {
        var q = make('blockquote', 'rs-md__quote');
        b.paras.forEach(function (text) {
          if (!text.trim()) return;
          var qp = make('p', 'rs-md__p');
          inline(parseInline(text), qp);
          q.appendChild(qp);
        });
        return q;
      }
      if (b.type === 'callout') {
        var note = make('div', 'rs-md__callout');
        note.setAttribute('data-kind', b.kind);
        note.setAttribute('role', 'note');
        note.appendChild(make('p', 'rs-md__callout-title', t(CALLOUT_KEYS[b.kind])));
        b.blocks.forEach(function (inner) { note.appendChild(block(inner, false)); });
        return note;
      }
      if (b.type === 'list') {
        var base = Math.min.apply(null, b.items.map(function (it) { return it.indent; }));
        return list(b.items, 0, base).el;
      }
      if (b.type === 'table') {
        var wrap = make('div', 'rs-md__scroll');
        var table = make('table', 'rs-table rs-md__table');
        var thead = document.createElement('thead');
        var tr = document.createElement('tr');
        b.head.forEach(function (cell, c) {
          var th = make('th');
          th.scope = 'col';
          if (b.aligns[c]) th.setAttribute('data-align', b.aligns[c]);
          inline(parseInline(cell), th);
          tr.appendChild(th);
        });
        thead.appendChild(tr);
        table.appendChild(thead);
        var tbody = document.createElement('tbody');
        b.rows.forEach(function (row) {
          var r = document.createElement('tr');
          b.head.forEach(function (unused, c) {
            var td = make('td');
            if (b.aligns[c]) td.setAttribute('data-align', b.aligns[c]);
            inline(parseInline(row[c] || ''), td);
            r.appendChild(td);
          });
          tbody.appendChild(r);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
        return wrap;
      }
      return make('span');
    }

    parse(src).forEach(function (b) { root.appendChild(block(b, true)); });
    return root;
  }

  return { parse: parse, parseInline: parseInline, plain: plain, sections: sections, taskOf: taskOf, render: render };
});
