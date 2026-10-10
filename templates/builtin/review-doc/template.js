/* review-doc (built-in, calm). Body of function (RS, root). RS API only,
   block comments only, no literal UI strings: every visible word comes from
   RS.t or the payload.
   The document is parsed here (a safe Markdown subset, or plain text) and
   built from DOM nodes with textContent only: raw HTML stays text, a link
   shows its address as quiet text and is never opened, and an image loads
   only through the template's media field (RS.media).
   Approve = the core primary. "Request changes" = the footer's quiet
   alternative: it opens the overall comment and the primary becomes
   "Send request". Each section heading carries a "Comment" action (shown on
   hover/focus) that opens a comment for that section. */
var data = RS.data;
var MAX_SECTIONS = 200;
var HEADING_MAX = 200;
/* Links and emphasis nested deeper than this stay literal text, so no
   payload can exhaust the stack while parsing or rendering. */
var INLINE_DEPTH = 16;

function part(name) { return root.querySelector('[data-rd="' + name + '"]'); }
function make(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/* ------------------------------------------------------------ inline -- */
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

/* ------------------------------------------------------------- blocks -- */
var LIST_ITEM = /^( {0,12})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
var FENCE = /^ {0,3}(`{3,}|~{3,})/;
var HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
var RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
var QUOTE = /^ {0,3}> ?(.*)$/;
var DELIM_ROW = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

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

function parseBlocks(src) {
  var lines = src.replace(/\r\n?/g, '\n').split('\n');
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
    if (para.length && /^ {0,3}=+[ \t]*$/.test(line)) {
      blocks.push({ type: 'h', level: 1, text: para.join('\n') });
      para = [];
      i++;
      continue;
    }
    if (para.length && /^ {0,3}-+[ \t]*$/.test(line)) {
      blocks.push({ type: 'h', level: 2, text: para.join('\n') });
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

function plainBlocks(src) {
  return src.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)
    .filter(function (p) { return p.trim(); })
    .map(function (p) { return { type: 'plain', text: p }; });
}

/* ------------------------------------------------------------- render -- */
var mediaByKey = {};
(data.images || []).forEach(function (m) { mediaByKey[m.key] = m; });

function missingImage(alt) {
  return make('span', 'rd__img-missing', RS.t('rd_image_missing', { alt: alt }));
}
function renderImage(n) {
  var m = Object.prototype.hasOwnProperty.call(mediaByKey, n.src) ? mediaByKey[n.src] : null;
  var alt = n.alt.trim() || (m ? m.alt : n.src);
  if (!m) return missingImage(alt);
  var img = document.createElement('img');
  img.className = 'rd__img';
  img.alt = alt;
  img.decoding = 'async';
  img.addEventListener('error', function () { if (img.parentNode) img.parentNode.replaceChild(missingImage(alt), img); });
  img.src = RS.media(m.path);
  return img;
}
function renderInline(nodes, parent, depth) {
  depth = depth || 0;
  /* ***x*** nests two elements per parsed level; anything deeper is text */
  if (depth > 2 * INLINE_DEPTH + 2) { parent.appendChild(document.createTextNode(plain(nodes))); return; }
  nodes.forEach(function (n) {
    if (n.t === 'text') parent.appendChild(document.createTextNode(n.v));
    else if (n.t === 'br') parent.appendChild(document.createElement('br'));
    else if (n.t === 'code') parent.appendChild(make('code', 'rd__code', n.v));
    else if (n.t === 'url') parent.appendChild(make('span', 'rd__address', n.v));
    else if (n.t === 'img') parent.appendChild(renderImage(n));
    else if (n.t === 'link') {
      var label = make('span', 'rd__link');
      renderInline(n.kids, label, depth + 1);
      parent.appendChild(label);
      if (n.href && n.href !== plain(n.kids)) parent.appendChild(make('span', 'rd__url', n.href));
    } else {
      var el = document.createElement(n.t);
      renderInline(n.kids, el, depth + 1);
      parent.appendChild(el);
    }
  });
}
function renderList(items, from, base) {
  /* items[from] opens a list whose items sit at indent `base` or deeper;
     2+ more spaces open a nested list. Returns { el, next }. */
  var first = items[from];
  var list = document.createElement(first.ordered ? 'ol' : 'ul');
  list.className = 'rd__list';
  if (first.ordered && first.start !== 1) list.start = first.start;
  var k = from;
  var li = null;
  while (k < items.length && items[k].indent >= base) {
    var it = items[k];
    if (it.indent > base + 1 && li) {
      var nested = renderList(items, k, it.indent);
      li.appendChild(nested.el);
      k = nested.next;
      continue;
    }
    li = document.createElement('li');
    renderInline(parseInline(it.text), li);
    list.appendChild(li);
    k++;
  }
  return { el: list, next: k };
}
function renderBlock(b) {
  if (b.type === 'p') {
    var nodes = parseInline(b.text);
    if (nodes.length === 1 && nodes[0].t === 'img') {
      var fig = make('div', 'rd__figure');
      fig.appendChild(renderImage(nodes[0]));
      return fig;
    }
    var p = make('p', 'rd__p');
    renderInline(nodes, p);
    return p;
  }
  if (b.type === 'plain') return make('p', 'rd__p rd__p--plain', b.text);
  if (b.type === 'h') {
    var h = make('h' + Math.min(6, b.level + 1), 'rd__h rd__h--' + Math.min(4, b.level));
    renderInline(parseInline(b.text), h);
    return h;
  }
  if (b.type === 'code') {
    var pre = make('pre', 'rd__pre');
    pre.appendChild(make('code', null, b.text));
    return pre;
  }
  if (b.type === 'hr') return make('hr', 'rd__hr');
  if (b.type === 'quote') {
    var q = make('blockquote', 'rd__quote');
    b.paras.forEach(function (text) {
      if (!text.trim()) return;
      var qp = make('p', 'rd__p');
      renderInline(parseInline(text), qp);
      q.appendChild(qp);
    });
    return q;
  }
  if (b.type === 'list') {
    var base = Math.min.apply(null, b.items.map(function (it) { return it.indent; }));
    return renderList(b.items, 0, base).el;
  }
  if (b.type === 'table') {
    var table = make('table', 'rd__table');
    var thead = document.createElement('thead');
    var tr = document.createElement('tr');
    b.head.forEach(function (cell, c) {
      var th = make('th', b.aligns[c] ? 'rd__cell--' + b.aligns[c] : null);
      th.scope = 'col';
      renderInline(parseInline(cell), th);
      tr.appendChild(th);
    });
    thead.appendChild(tr);
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    b.rows.forEach(function (row) {
      var r = document.createElement('tr');
      b.head.forEach(function (unused, c) {
        var td = make('td', b.aligns[c] ? 'rd__cell--' + b.aligns[c] : null);
        renderInline(parseInline(row[c] || ''), td);
        r.appendChild(td);
      });
      tbody.appendChild(r);
    });
    table.appendChild(tbody);
    return table;
  }
  return make('span');
}

/* ----------------------------------------------------------- document -- */
var isText = data.format === 'text';
var blocks = isText ? plainBlocks(data.doc) : parseBlocks(data.doc);
var headings = blocks.filter(function (b) { return b.type === 'h'; });
function atMost(level) { return headings.filter(function (h) { return h.level <= level; }).length; }
var sectionLevel = atMost(2) >= 2 ? 2 : (atMost(3) >= 2 ? 3 : 0);

var doc = part('doc');
var sections = [];
var target = null;
function sectionFor(b) {
  var index = sections.length + 1;
  var section = make('section', 'rd__section');
  section.setAttribute('data-rs-item', '');
  section.setAttribute('data-section', String(index));
  var head = make('div', 'rd__head');
  var heading = renderBlock(b);
  heading.id = 'rd-h-' + index;
  var title = plain(parseInline(b.text)).replace(/\s+/g, ' ').trim().slice(0, HEADING_MAX);
  var open = make('button', 'rs-link rs-on-hover rd__comment-open');
  open.type = 'button';
  open.appendChild(RS.icon('bubble'));
  open.appendChild(make('span', null, RS.t('rd_comment')));
  open.setAttribute('aria-label', RS.t('rd_comment_for', { what: title }));
  head.appendChild(heading);
  head.appendChild(open);
  var box = make('div', 'rd__cbox');
  box.hidden = true;
  var input = make('textarea', 'rs-input');
  input.id = 'rd-c-' + index;
  input.rows = 3;
  input.maxLength = 2000;
  var label = make('label', 'rs-label', RS.t('rd_comment_label', { what: title }));
  label.htmlFor = input.id;
  box.appendChild(label);
  box.appendChild(input);
  section.appendChild(head);
  section.appendChild(box);
  var entry = { index: index, heading: title, open: open, box: box, input: input };
  open.addEventListener('click', function () { showBox(entry, true); });
  input.addEventListener('input', function () { update(true); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !input.value.trim()) { e.preventDefault(); hideBox(entry, true); }
  });
  input.addEventListener('blur', function () {
    if (!input.value.trim() && RS.run.state === 'open') hideBox(entry, false);
  });
  sections.push(entry);
  return section;
}
function showBox(entry, focus) {
  entry.box.hidden = false;
  entry.open.hidden = true;
  if (focus) entry.input.focus();
}
function hideBox(entry, focus) {
  if (entry.input.value) { entry.input.value = ''; update(true); }
  entry.box.hidden = true;
  entry.open.hidden = false;
  if (focus) entry.open.focus();
}

blocks.forEach(function (b) {
  if (b.type === 'h' && b.level <= sectionLevel && sections.length < MAX_SECTIONS) {
    target = sectionFor(b);
    doc.appendChild(target);
    return;
  }
  if (!target) {
    target = make('div', 'rd__section rd__section--lead');
    doc.appendChild(target);
  }
  target.appendChild(renderBlock(b));
});

/* lead: the agent's summary, then quiet reading facts */
if (data.summary) part('summary').textContent = data.summary;
else part('summary').remove();
var words = (data.doc.match(/[^\s#>*_`|~-]+/g) || []).length;
var facts = [
  words === 1 ? RS.t('rd_words_one') : RS.t('rd_words', { n: RS.number(words) }),
  RS.t('rd_minutes', { n: RS.number(Math.max(1, Math.round(words / 200))) })
];
if (sections.length) {
  facts.push(sections.length === 1 ? RS.t('rd_sections_one') : RS.t('rd_sections', { n: RS.number(sections.length) }));
}
part('meta').textContent = facts.join(RS.t('sep_list'));

RS.addMenuItem(RS.t(isText ? 'copy_text' : 'rd_copy_markdown'), function () {
  RS.copy(data.doc).then(function (res) {
    RS.toast(RS.t(res && res.ok ? 'copied' : (res && res.busy ? 'clipboard_busy' : 'copy_failed')));
  });
});

/* ------------------------------------------------------------ decision -- */
var overall = root.querySelector('#rd-comment');
var requesting = false;

function sectionComments() {
  return sections.filter(function (s) { return s.input.value.trim(); }).map(function (s) {
    return { section: s.index, heading: s.heading, comment: s.input.value };
  });
}
function update(save) {
  if (RS.run.state !== 'open') {
    RS.setResult(null);
    RS.setStatus(null);
    return;
  }
  var list = sectionComments();
  if (save) {
    var saved = {};
    sections.forEach(function (s) { if (s.input.value) saved[s.index] = s.input.value; });
    RS.draft.set({ requesting: requesting, comment: overall.value, comments: saved });
  }
  if (requesting) {
    var ready = !!overall.value.trim() || list.length > 0;
    RS.setSubmitLabel(RS.t('send_request'));
    RS.setAlternative(null);
    RS.setResult(ready ? { decision: 'request_changes', comment: overall.value, comments: list } : null);
    RS.setStatus(ready ? null : RS.t('comment_required'));
    return;
  }
  RS.setSubmitLabel(RS.t('approve'));
  RS.setAlternative(RS.t('request_changes'), function () { setRequesting(true, true); });
  RS.setResult({ decision: 'approve', comment: '', comments: list });
  if (!list.length) RS.setStatus(RS.t('rd_waiting'));
  else if (list.length === 1) RS.setStatus(RS.t('rd_with_comments_one'));
  else RS.setStatus(RS.t('rd_with_comments', { n: RS.number(list.length) }));
}
function setRequesting(on, focus) {
  requesting = on;
  part('request').hidden = !on;
  update(true);
  if (focus) {
    if (on) overall.focus();
    else RS.focusAlternative();
  }
}
part('request-cancel').addEventListener('click', function () { setRequesting(false, true); });
overall.addEventListener('input', function () { update(true); });

/* A half-done review survives a reload (draft); a reopened submitted report
   shows what was sent. */
var sent = RS.run.state === 'submitted' ? RS.run.result : null;
var restore = null;
if (sent) {
  restore = { requesting: sent.decision === 'request_changes', comment: sent.comment || '', comments: {} };
  (sent.comments || []).forEach(function (c) { restore.comments[c.section] = c.comment; });
} else if (RS.run.state === 'open') {
  restore = RS.draft.get();
}
if (restore && typeof restore === 'object') {
  if (typeof restore.comment === 'string') overall.value = restore.comment;
  if (restore.requesting === true) { requesting = true; part('request').hidden = false; }
  var savedComments = restore.comments && typeof restore.comments === 'object' ? restore.comments : {};
  sections.forEach(function (s) {
    var text = savedComments[s.index];
    if (typeof text === 'string' && text.trim()) {
      s.input.value = text;
      showBox(s, false);
    }
  });
}
update(false);
if (!sent && requesting) overall.focus();
