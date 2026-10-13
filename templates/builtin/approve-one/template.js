/* approve-one (built-in, calm UI). Body of function (RS, root): RS API only,
   block comments only (the template lint reads a double slash as a URL).
   Every visible string comes from RS.t or from the payload.

   One decision, made in the footer with one click: the primary approves
   (the payload's approve label, or Approve & post / send / continue from
   the action), the quiet alternatives reject and, when the payload allows
   it, request changes. Request changes opens the comment field; the
   primary then sends the request and Cancel goes back. A note is optional
   behind "Add note" and travels with whichever button is pressed while it
   is shown. What is visible is what is sent: a hidden note is never part
   of the result.

   The task kind says who acts next and so which buttons exist (RS.cta,
   the shell's table): the bot acts once approved (Approve & verb, Reject,
   optional Request changes), the user acts and reports back (Done, or
   Sent, or Posted when it is a post; Skip; Request changes when allowed),
   or it is information only (just Got it, plus one collapsed note). */
var data = RS.data;
var actor = RS.task.base === 'post_yourself' ? 'user' : RS.task.base === 'fyi' ? 'none' : 'bot';
function label(value) {
  return value === 'approve' && actor === 'bot' && data.approve_label ? data.approve_label : RS.cta(value);
}
var STATES = { ok: 'ok', warn: 'warn', fail: 'danger' };
var CHECK_TEXT = { ok: 'check_ok', warn: 'check_warn', fail: 'check_fail' };
/* A copy value wider than this, or with a line break, gets its own quoted line. */
var SHORT_COPY = 40;
/* Above this many (estimated) lines the quoted value is clamped (rs-copy max-lines). */
var MAX_LINES = 6;
var LINE_CHARS = 80;

function part(name) { return root.querySelector('[data-ao="' + name + '"]'); }
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

/* ---- what it is about: summary, facts, copies ---- */
if (RS.task.why_from === 'summary') part('summary').remove();
else RS.fillText(part('summary'), data.summary);

var facts = data.facts || [];
if (facts.length) {
  facts.forEach(function (f) {
    part('facts').appendChild(make('dt', null, f.label));
    var value = make('dd', f.mono ? 'ao__mono' : null);
    RS.fillText(value, f.value);
    part('facts').appendChild(value);
  });
} else {
  part('facts').remove();
}

var copies = data.copy || [];
if (copies.length) {
  copies.forEach(function (entry, i) {
    var copy = make('rs-copy', 'ao__copy');
    copy.setAttribute('data-copy-id', 'copy-' + (i + 1));
    copy.setAttribute('label', entry.label);
    copy.setAttribute('caption', '');
    if (entry.text.length > SHORT_COPY || /[\r\n]/.test(entry.text)) {
      copy.setAttribute('block', '');
      if (lineCount(entry.text) > MAX_LINES) copy.setAttribute('max-lines', String(MAX_LINES));
    } else {
      copy.setAttribute('mono', '');
    }
    copy.text = entry.text;
    part('copies').appendChild(copy);
  });
} else {
  part('copies').remove();
}

/* ---- the evidence: points, checks, reference ---- */
var points = data.points || [];
if (points.length) {
  if (data.points_title) part('points-title').textContent = data.points_title;
  points.forEach(function (p) {
    var item = document.createElement('li');
    RS.fillText(item, p);
    part('points').appendChild(item);
  });
} else {
  part('points-box').remove();
}

var checks = data.checks || [];
if (checks.length) {
  checks.forEach(function (c) {
    var li = make('li');
    var dot = make('span', 'rs-dot');
    dot.setAttribute('data-rs-status', STATES[c.state]);
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', RS.t(CHECK_TEXT[c.state]));
    li.appendChild(dot);
    li.appendChild(make('span', null, c.label));
    li.appendChild(make('span', 'ao__check-detail', c.detail || ''));
    part('checks').appendChild(li);
  });
} else {
  part('checks-box').remove();
}

/* One line before the facts: how many passed, then every warning and
   failure by name, so nothing that needs a look waits below the fold. */
function named(state) {
  return checks.filter(function (c) { return c.state === state; }).map(function (c) { return c.label; });
}
if (checks.length) {
  var sum = part('checksum');
  var parts = [];
  var ok = named('ok').length;
  if (ok) parts.push(['ok', RS.t('ao_checks_ok', { n: RS.number(ok) })]);
  ['warn', 'fail'].forEach(function (state) {
    var names = named(state);
    if (!names.length) return;
    var key = 'ao_checks_' + state + (names.length === 1 ? '_one' : '');
    parts.push([state, RS.t(key, { n: RS.number(names.length), names: names.join(', ') })]);
  });
  parts.forEach(function (entry, i) {
    if (i) sum.appendChild(make('span', 'ao__sep', ' · '));
    var piece = make('span', 'ao__sum');
    var dot = make('span', 'rs-dot');
    dot.setAttribute('data-rs-status', STATES[entry[0]]);
    dot.setAttribute('aria-hidden', 'true');
    piece.appendChild(dot);
    piece.appendChild(make('span', null, entry[1]));
    sum.appendChild(piece);
  });
} else {
  part('checksum').remove();
}

if (data.reference) {
  part('reference-title').textContent = data.reference.title;
  var ref = part('reference');
  ref.setAttribute('label', data.reference.label);
  if (data.reference.mono) ref.setAttribute('mono', '');
  ref.text = data.reference.text;
} else {
  part('reference-box').remove();
}

/* ---- the decision ---- */
var comment = root.querySelector('#ao-comment');
var box = part('comment-box');
var noteOpen = part('note-open');
var noteShown = false;
var changes = false;
var allowChanges = actor !== 'none' && data.allow_changes === true;
var primary = actor === 'user' ? 'done' : actor === 'none' ? 'acknowledged' : 'approve';
var quiet = actor === 'user' ? 'skipped' : actor === 'none' ? null : 'reject';

if (actor === 'none') {
  noteOpen.remove();
  var note = document.createElement('details');
  note.className = 'rs-disclosure';
  var summary = document.createElement('summary');
  summary.textContent = RS.t('add_a_note');
  var body = document.createElement('div');
  body.className = 'rs-disclosure__body';
  var noteLabel = document.createElement('label');
  noteLabel.className = 'rs-label';
  noteLabel.setAttribute('for', 'ao-comment');
  noteLabel.textContent = RS.t('note');
  body.appendChild(noteLabel);
  body.appendChild(comment);
  note.appendChild(summary);
  note.appendChild(body);
  box.replaceWith(note);
  /* a closed note keeps its field out of the layout, not just out of view */
  body.hidden = true;
  /* a closed note keeps its text but is not sent */
  note.addEventListener('toggle', function () {
    body.hidden = !note.open;
    noteShown = note.open;
    update(true);
  });
}

function noted() {
  if (actor === 'none') return note.open ? comment.value : '';
  return !box.hidden ? comment.value : '';
}

function render() {
  if (actor === 'none') return;
  box.hidden = !(noteShown || changes);
  noteOpen.hidden = !box.hidden;
  part('label-note').hidden = changes;
  part('label-changes').hidden = !changes;
}

/* A quiet alternative sends at once (Reject, Skip). Should the send not
   go through, the footer goes back to the primary's own result. */
function sendNow(decision) {
  RS.setResult({ decision: decision, comment: noted() });
  RS.submit().then(function (ok) { if (!ok) update(false); });
}

function setChanges(on) {
  changes = on;
  render();
  update(true);
  if (on) comment.focus();
  else RS.focusAlternative(RS.cta('request_changes'));
}

function update(save) {
  if (save && RS.run.state === 'open') {
    RS.draft.set({ decision: changes ? 'request_changes' : null, comment: comment.value, note: noteShown });
  }
  if (actor === 'none') {
    RS.setSubmitLabel(label('acknowledged'));
    RS.setAlternatives([]);
    RS.setResult({ decision: 'acknowledged', comment: /\S/.test(noted()) ? noted() : '' });
    RS.setStatus(null);
    return;
  }
  if (changes) {
    var has = /\S/.test(comment.value);
    RS.setSubmitLabel(RS.t('request_send'));
    RS.setAlternatives([{ label: RS.t('cancel'), run: function () { setChanges(false); } }]);
    RS.setResult(has ? { decision: 'request_changes', comment: comment.value } : null);
    RS.setStatus(has ? null : RS.t('comment_required'));
    return;
  }
  var alternatives = [{ label: label(quiet), run: function () { sendNow(quiet); } }];
  if (allowChanges) alternatives.push({ label: RS.cta('request_changes'), run: function () { setChanges(true); } });
  RS.setSubmitLabel(label(primary));
  RS.setAlternatives(alternatives);
  RS.setResult({ decision: primary, comment: noted() });
  RS.setStatus(null);
}

noteOpen.addEventListener('click', function () {
  noteShown = true;
  render();
  update(true);
  comment.focus();
});

/* Restore a draft (window closed or reloaded), or show what a submitted
   report sent: a change request with its comment, or the note. */
var sent = RS.run.state === 'submitted' ? RS.run.result : null;
var draft = sent
  ? { decision: sent.decision, comment: sent.comment || '', note: !!sent.comment }
  : (RS.run.state === 'open' ? RS.draft.get() : null);
if (draft && typeof draft === 'object') {
  changes = allowChanges && draft.decision === 'request_changes';
  if (typeof draft.comment === 'string') comment.value = draft.comment.slice(0, 2000);
  noteShown = draft.note === true;
}
if (actor === 'none' && noteShown) {
  note.open = true;
  body.hidden = false;
}
render();
update(false);

comment.addEventListener('input', function () { update(true); });
