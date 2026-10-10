/* approve-one (built-in, calm UI). Body of function (RS, root): RS API only,
   block comments only (the template lint reads a double slash as a URL).
   Every visible string comes from RS.t or from the payload.

   One decision: a segmented choice (Approve, Reject, and Request changes
   when the payload allows it) right under the summary, nothing preselected.
   The core primary names what will be sent (the payload's approve label,
   "Send rejection", "Send request"). A note is optional behind "Add note";
   "Request changes" opens the same field as a required comment. What is
   visible is what is sent: a hidden note is never part of the result. */
var data = RS.data;
var LABELS = { approve: 'choice_approve', reject: 'choice_reject', request_changes: 'request_changes' };
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
part('summary').textContent = data.summary;

var facts = data.facts || [];
if (facts.length) {
  facts.forEach(function (f) {
    part('facts').appendChild(make('dt', null, f.label));
    part('facts').appendChild(make('dd', f.mono ? 'ao__mono' : null, f.value));
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
  points.forEach(function (p) { part('points').appendChild(make('li', null, p)); });
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
var choice = part('choice');
var comment = root.querySelector('#ao-comment');
var box = part('comment-box');
var noteOpen = part('note-open');
var noteShown = false;
var values = ['approve', 'reject'];
if (data.allow_changes === true) values.push('request_changes');
choice.setAttribute('label', RS.t('decision_label'));
choice.options = values.map(function (v) { return { value: v, label: RS.t(LABELS[v]) }; });

function render() {
  var changes = choice.value === 'request_changes';
  box.hidden = !(noteShown || changes);
  noteOpen.hidden = !box.hidden;
  part('label-note').hidden = changes;
  part('label-changes').hidden = !changes;
}

function update(save) {
  var decision = choice.value || null;
  if (save && RS.run.state === 'open') RS.draft.set({ decision: decision, comment: comment.value, note: noteShown });
  if (!decision) {
    RS.setSubmitLabel(null);
    RS.setResult(null);
    RS.setStatus(RS.t('decision_pick'));
    return;
  }
  if (decision === 'request_changes') {
    var has = /\S/.test(comment.value);
    RS.setSubmitLabel(RS.t('send_request'));
    RS.setResult(has ? { decision: decision, comment: comment.value } : null);
    RS.setStatus(has ? null : RS.t('comment_required'));
    return;
  }
  RS.setSubmitLabel(decision === 'approve' ? (data.approve_label || RS.t('choice_approve')) : RS.t('send_rejection'));
  RS.setResult({ decision: decision, comment: box.hidden ? '' : comment.value });
  RS.setStatus(null);
}

noteOpen.addEventListener('click', function () {
  noteShown = true;
  render();
  update(true);
  comment.focus();
});

/* Click, Enter or Space on "Request changes": straight to the comment.
   Arrow keys only change the choice. */
root.addEventListener('click', function (e) {
  var btn = e.target.closest ? e.target.closest('[data-ao="choice"] > button') : null;
  if (btn && choice.value === 'request_changes' && !box.hidden && !comment.disabled) comment.focus();
});

/* Restore a draft (window closed or reloaded), or show what a submitted
   report sent: the decision and, when there was one, its comment. */
var sent = RS.run.state === 'submitted' ? RS.run.result : null;
var draft = sent
  ? { decision: sent.decision, comment: sent.comment || '', note: !!sent.comment }
  : (RS.run.state === 'open' ? RS.draft.get() : null);
if (draft && typeof draft === 'object') {
  if (values.indexOf(draft.decision) !== -1) choice.value = draft.decision;
  if (typeof draft.comment === 'string') comment.value = draft.comment.slice(0, 2000);
  noteShown = draft.note === true;
}
render();
update(false);
if (draft && !sent) {
  if (choice.value === 'request_changes' || (noteShown && !choice.value)) comment.focus();
  else {
    var checked = choice.buttons.filter(function (b) { return b.getAttribute('aria-checked') === 'true'; })[0];
    if (checked) checked.focus();
  }
}

choice.addEventListener('change', function () { render(); update(true); });
comment.addEventListener('input', function () { update(true); });
