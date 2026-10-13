/* decide-list (built-in, calm UI). Body of function (RS, root): RS API only,
   block comments only (the template lint reads a double slash as a URL).
   Every visible string comes from RS.t or from the payload.

   One thing at a time: exactly one item is "current" (a card with its
   choices); the others are quiet rows: the request in ink (up to two
   lines), the source and category as a muted line below; open rows carry a
   ring, the due date and a chevron, decided rows a check, muted text and the
   chosen outcome. Picking a choice by click, Enter or Space moves on to the
   first undecided item; arrow keys only change the choice. The card's copy icons are visible;
   "Add note" shows on hover and keyboard focus. Only the current card is in
   the document, so every copy control on screen is reachable by Tab. */
var data = RS.data;
var source = data.items || [];
var USER_CHOICES = ['done', 'skipped', 'later'];
var DEFAULT_CHOICES = ['approve', 'reject', 'defer'];
var LABELS = data.labels || {};
function isUser(w) { return w.actor === 'user'; }
function choiceValues(w) { return w.choices || (isUser(w) ? USER_CHOICES : DEFAULT_CHOICES); }
/* Item labels: a bot item's own labels, then the payload's labels, then
   the shared table (approve/reject/defer); a user item's Posted for a post
   or reply, otherwise Done, Skip and Later. */
function choiceLabel(w, value) {
  if (!isUser(w)) {
    var own = w.labels || {};
    if (own[value]) return own[value];
    if (LABELS[value]) return LABELS[value];
  }
  return RS.cta(value, { item: true, actor: isUser(w) ? 'user' : 'bot', content: w.content || null });
}
/* A copy value wider than this, or with a line break, gets its own quoted line. */
var SHORT_COPY = 40;
/* Above this many (estimated) lines the quoted value is clamped (rs-copy max-lines). */
var MAX_LINES = 8;
var LINE_CHARS = 80;

function part(name) { return root.querySelector('[data-dl="' + name + '"]'); }

function make(tag, cls, text) {
  var node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function lineCount(text) {
  return text.split(/\r\n|\r|\n/).reduce(function (sum, line) {
    return sum + Math.max(1, Math.ceil(line.length / LINE_CHARS));
  }, 0);
}

function buildCopy(entry, id) {
  var copy = make('rs-copy', 'dl-copy');
  copy.setAttribute('data-copy-id', id);
  copy.setAttribute('label', entry.label);
  copy.setAttribute('caption', '');
  if (entry.text.length > SHORT_COPY || /[\r\n]/.test(entry.text)) {
    copy.setAttribute('block', '');
    if (lineCount(entry.text) > MAX_LINES) copy.setAttribute('max-lines', String(MAX_LINES));
  } else {
    copy.setAttribute('mono', '');
  }
  copy.text = entry.text;
  return copy;
}

/* The quiet line under a request: who asks and what kind of thing it is. */
function metaText(w) {
  return [w.source, w.kind].filter(Boolean).join(RS.t('sep_list'));
}

function dueBadge(w) {
  var due = make('rs-badge', null, RS.t('due', { date: RS.date(w.due) }));
  due.setAttribute('variant', 'warn');
  return due;
}

/* The payload url is the one link for that address. The same address in the
   title or detail stays plain text, so it is not a second control. */
function dropDuplicate(prose, url) {
  if (!url) return;
  Array.prototype.forEach.call(prose.querySelectorAll('a.rs-ext'), function (anchor) {
    if (anchor.closest('.dl-url') || anchor.getAttribute('href') !== url) return;
    anchor.parentNode.replaceChild(document.createTextNode(anchor.textContent), anchor);
  });
}

/* Two or more links in one item are one roving toolbar, so they count as
   one control. A single link stays an ordinary tab stop. */
function bindLinkToolbar(prose) {
  var links = prose.querySelectorAll('a.rs-ext');
  if (links.length < 2) return;
  prose.setAttribute('role', 'toolbar');
  prose.setAttribute('aria-label', RS.t('links_label'));
  Array.prototype.forEach.call(links, function (anchor, index) {
    anchor.tabIndex = index === 0 ? 0 : -1;
  });
  prose.addEventListener('keydown', function (event) {
    var step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    var home = event.key === 'Home';
    var end = event.key === 'End';
    if (!step && !home && !end) return;
    var list = Array.prototype.filter.call(prose.querySelectorAll('a.rs-ext'), function (anchor) {
      return anchor.getClientRects().length > 0;
    });
    var index = list.indexOf(document.activeElement);
    if (index < 0 || list.length < 2) return;
    event.preventDefault();
    event.stopPropagation();
    var next = home ? 0 : end ? list.length - 1 : (index + step + list.length) % list.length;
    Array.prototype.forEach.call(list, function (anchor, i) {
      anchor.tabIndex = i === next ? 0 : -1;
    });
    list[next].focus();
  });
}

/* ---------------------------------------------------------------- intro -- */
if (data.intro && RS.task.why_from !== 'intro') RS.fillText(part('intro'), data.intro);
else part('intro').remove();

/* ---------------------------------------------------------------- items -- */
var items = [];
var list = part('list');
source.forEach(function (w, i) {
  var n = i + 1;
  var li = make('div', 'dl-item');
  li.setAttribute('role', 'listitem');
  li.setAttribute('data-rs-item', '');
  li.setAttribute('data-item-id', w.id);
  var bodyId = 'dl-item-' + n;

  /* collapsed: one quiet row, the whole row opens the item */
  var row = make('button', 'dl-row');
  row.type = 'button';
  row.setAttribute('aria-expanded', 'false');
  var mark = make('span', 'dl-row__mark');
  row.appendChild(mark);
  var text = make('span', 'dl-row__text');
  text.appendChild(make('span', 'dl-row__title', w.title));
  if (metaText(w)) text.appendChild(make('span', 'dl-row__meta', metaText(w)));
  row.appendChild(text);
  var rowState = make('span', 'dl-row__state');
  row.appendChild(rowState);
  li.appendChild(row);

  /* current: the card */
  var card = make('rs-card', 'dl-card');
  card.id = bodyId;
  card.setAttribute('role', 'group');
  card.tabIndex = -1;
  var eyebrow = make('p', 'dl-card__eyebrow');
  if (metaText(w)) eyebrow.appendChild(make('span', 'dl-card__meta', metaText(w)));
  if (w.due) {
    var due = dueBadge(w);
    due.classList.add('dl-card__due');
    eyebrow.appendChild(due);
  }
  card.appendChild(eyebrow);
  var prose = make('div', 'dl-prose');
  var title = make('p', 'dl-card__title');
  title.id = bodyId + '-title';
  card.setAttribute('aria-labelledby', title.id);
  RS.fillText(title, w.title);
  prose.appendChild(title);
  if (w.detail) {
    var detail = make('p', 'dl-card__detail');
    RS.fillText(detail, w.detail);
    prose.appendChild(detail);
  }
  if (w.url) {
    var urlLine = make('p', 'dl-url');
    var urlLink = RS.externalLink(w.url, w.url);
    if (urlLink) urlLine.appendChild(urlLink);
    else urlLine.textContent = w.url;
    prose.appendChild(urlLine);
  }
  dropDuplicate(prose, w.url);
  bindLinkToolbar(prose);
  card.appendChild(prose);

  if (w.copy && w.copy.length) {
    var copies = make('div', 'dl-copies');
    w.copy.forEach(function (entry, j) {
      copies.appendChild(buildCopy(entry, 'item-' + n + '-copy-' + (j + 1)));
    });
    card.appendChild(copies);
  }

  var decide = make('div', 'dl-decide');
  var choice = make('rs-action-row', 'dl-choice');
  choice.setAttribute('data-item', w.id);
  choice.setAttribute('label', RS.t('choice_group_label', { what: w.title }));
  choice.options = choiceValues(w).map(function (c) {
    return { value: c, label: choiceLabel(w, c) };
  });
  var addNote = make('button', 'rs-link rs-on-hover dl-add-note');
  addNote.type = 'button';
  addNote.appendChild(RS.icon('plus'));
  addNote.appendChild(make('span', null, RS.t('add_note')));
  decide.appendChild(choice);
  decide.appendChild(addNote);
  card.appendChild(decide);

  var noteBox = make('div', 'dl-note');
  noteBox.hidden = true;
  var note = make('input', 'rs-input dl-item__note');
  note.type = 'text';
  note.id = 'dl-note-' + n;
  note.maxLength = 500;
  note.autocomplete = 'off';
  note.setAttribute('aria-label', RS.t('note_for', { what: w.title }));
  noteBox.appendChild(note);
  card.appendChild(noteBox);

  list.appendChild(li);
  var item = { id: w.id, name: w.source || w.title, w: w, li: li, card: card, row: row, mark: mark, rowState: rowState, choice: choice, note: note, noteBox: noteBox, addNote: addNote };
  items.push(item);

  row.addEventListener('click', function () { setCurrent(items.indexOf(item), true); });
  addNote.addEventListener('click', function () { showNote(item, true); });
});

function showNote(item, focus) {
  item.noteBox.hidden = false;
  item.addNote.hidden = true;
  if (focus) item.note.focus();
}

function labelOf(item) {
  var v = item.choice.value;
  var opt = item.choice.options.filter(function (o) { return o.value === v; })[0];
  return opt ? opt.label : '';
}

function renderRow(item) {
  item.rowState.textContent = '';
  item.mark.textContent = '';
  if (item.choice.value) {
    /* decided: check mark, muted text, the chosen outcome as a quiet label */
    item.li.setAttribute('data-decided', item.choice.value);
    item.mark.appendChild(RS.icon('done'));
    item.rowState.appendChild(make('span', 'dl-row__outcome', labelOf(item)));
  } else {
    /* open: an empty ring, ink text, due date and a chevron to open it */
    item.li.removeAttribute('data-decided');
    item.mark.appendChild(RS.icon('ring'));
    if (item.w.due) item.rowState.appendChild(dueBadge(item.w));
    item.rowState.appendChild(RS.icon('chevron'));
  }
}

var current = -1;
function setCurrent(i, focus) {
  current = i;
  items.forEach(function (it, j) {
    var on = j === i;
    if (on) it.li.setAttribute('data-current', ''); else it.li.removeAttribute('data-current');
    /* the card (and its controls) exists in the document only while current */
    if (on && !it.card.isConnected) it.li.appendChild(it.card);
    if (!on && it.card.isConnected) it.card.remove();
    it.row.setAttribute('aria-expanded', on ? 'true' : 'false');
    renderRow(it);
  });
  if (!focus || i < 0) return;
  /* a decided (or sending) report keeps its choices disabled, and the row
     hides while its card shows: focus goes to the card itself */
  var locked = RS.run.state !== 'open' || root.hasAttribute('data-rs-locked') || root.hasAttribute('data-rs-pending');
  var btns = items[i].choice.buttons;
  var target = locked ? null : btns.filter(function (b) { return b.tabIndex === 0; })[0] || btns[0];
  (target || items[i].card).focus();
}

function firstOpen(skip) {
  for (var j = 0; j < items.length; j++) {
    if (j !== skip && !items[j].choice.value) return j;
  }
  return -1;
}

/* Click, Enter or Space on a choice: decided, move on. */
root.addEventListener('click', function (e) {
  var btn = e.target.closest ? e.target.closest('.dl-choice > button') : null;
  if (!btn) return;
  var i = items.map(function (it) { return it.choice; }).indexOf(btn.parentNode);
  if (i < 0 || i !== current || !items[i].choice.value) return;
  var next = firstOpen(i);
  setCurrent(next, next >= 0);
  if (next < 0) items[i].row.focus();
});

/* ------------------------------------------------------ handled (closed) -- */
var done = data.done || [];
if (done.length) {
  done.forEach(function (d) {
    var item = document.createElement('li');
    RS.fillText(item, d.text);
    part('done-list').appendChild(item);
  });
  part('handled-summary').textContent = RS.t('handled_summary', { parts: RS.t('handled_done', { n: RS.number(done.length) }) });
} else {
  part('handled').remove();
  /* the one group left needs no visible heading; it still names the list */
  root.querySelector('#dl-todo-h').classList.add('rs-vh');
}

/* -------------------------------------------------------- overall note -- */
var overall = root.querySelector('#dl-note');
var overallOpen = part('overall-open');
function showOverall(focus) {
  part('overall-field').hidden = false;
  overallOpen.hidden = true;
  if (focus) overall.focus();
}
overallOpen.addEventListener('click', function () { showOverall(true); });

/* -------------------------------------------------------------- result -- */
function collect() {
  return {
    items: items.map(function (it) {
      return { id: it.id, choice: it.choice.value, note: it.note.value };
    }),
    note: overall.value
  };
}

/* Restore a half-done draft (window closed or reloaded), or show what a
   submitted report sent. Choices are only restored when the item at that
   position still has the same id and offers the saved choice. */
var sent = RS.run.state === 'submitted' ? RS.run.result : null;
var draft = sent || (RS.run.state === 'open' ? RS.draft.get() : null);
if (draft && typeof draft === 'object') {
  (Array.isArray(draft.items) ? draft.items : []).forEach(function (saved, i) {
    var it = items[i];
    if (!it || !saved || saved.id !== it.id) return;
    var allowed = it.choice.options.map(function (o) { return o.value; });
    if (saved.choice && allowed.indexOf(saved.choice) !== -1) it.choice.value = saved.choice;
    if (typeof saved.note === 'string' && saved.note) {
      it.note.value = saved.note.slice(0, 500);
      showNote(it, false);
    }
  });
  if (typeof draft.note === 'string' && draft.note) {
    overall.value = draft.note.slice(0, 2000);
    showOverall(false);
  }
}
/* a restored draft puts focus back on the item being decided */
setCurrent(firstOpen(-1), !!(draft && !sent));

/* A mixed list (your items and the bot's) gets one banner line per actor,
   counted: an undecided item is still planned, a skipped, deferred or
   rejected one is out. The steps name the footer as it reads now. */
var ON = { done: true, approve: true };
function refreshBanner(label) {
  if (!RS.task.parties || typeof RS.setTaskLive !== 'function') return;
  RS.setTaskLive({
    stepsKey: 'task_steps_mixed_items',
    stepsButton: label,
    parties: items.map(function (it) {
      var posts = it.w.content === 'post' || it.w.content === 'reply';
      var party = { role: isUser(it.w) ? (posts ? 'user_post' : 'user') : 'bot', noun: posts ? it.w.content : 'item' };
      if (it.choice.value) party.on = ON[it.choice.value] === true;
      return party;
    })
  });
}

/* The footer sends every decision at once, so it says so; it never reads
   as a blanket approval. A list of only your own items reports back (Done). */
function footerLabel() {
  if (items.every(function (it) { return isUser(it.w); })) return RS.t('footer_done');
  return items.length === 1 ? RS.t('send_decision_one') : RS.t('send_decisions');
}

/* "2 Approve · 1 Reject · 2 open": the picks counted by their labels (a
   custom label counts on its own), in choice order, then what is open. */
var ORDER = ['approve', 'reject', 'defer', 'done', 'skipped', 'later'];
function counts(openItems) {
  var groups = [];
  var byLabel = Object.create(null);
  ORDER.forEach(function (value) {
    items.forEach(function (it) {
      if (it.choice.value !== value) return;
      var label = labelOf(it).replace(/\s*\u2713$/, '');
      if (!byLabel[label]) {
        byLabel[label] = { label: label, n: 0 };
        groups.push(byLabel[label]);
      }
      byLabel[label].n += 1;
    });
  });
  var parts = groups.map(function (g) { return RS.t('dl_count', { n: RS.number(g.n), label: g.label }); });
  if (openItems.length) parts.push(RS.t('items_open_short', { n: RS.number(openItems.length) }));
  return parts.join(RS.t('sep_list'));
}

function update(save) {
  var value = collect();
  if (save) RS.draft.set(value);
  var openItems = items.filter(function (it) { return !it.choice.value; });
  var label = footerLabel();
  RS.setSubmitLabel(label);
  refreshBanner(label);
  var status = counts(openItems);
  if (openItems.length) {
    RS.setResult(null);
    var fullStatus = RS.t('items_open_named', {
      n: RS.number(openItems.length), total: RS.number(items.length),
      names: openItems.map(function (it) { return it.name; }).join(RS.t('sep_names'))
    });
    /* The visible line is the count. The accessible name starts with that
       same text and then the names, so the full list is not painted. */
    RS.setStatus(status, null, status + RS.t('sep_list') + fullStatus);
  } else {
    RS.setResult(value);
    RS.setStatus(status);
  }
}

root.addEventListener('change', function (e) {
  if (e.target && e.target.tagName === 'RS-ACTION-ROW') {
    var i = items.map(function (it) { return it.choice; }).indexOf(e.target);
    if (i >= 0) renderRow(items[i]);
    update(true);
  }
});
root.addEventListener('input', function () { update(true); });
update(false);
