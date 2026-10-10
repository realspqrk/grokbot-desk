/* pick-option (built-in, calm). Body of function (RS, root). RS API only,
   block comments only, no literal UI strings: every visible word comes from
   RS.t or the payload.
   2 to 4 options side by side as one radio group (rs-action-row): each card
   is a radio, Tab enters the group once, the arrow keys move and pick, Space
   or a click picks. Rows line up across the cards (name, summary, facts).
   Nothing is preselected; the agent's suggestion is only marked. The note
   sits behind "Add note"; the primary names the picked option. */
var data = RS.data;
function part(name) { return root.querySelector('[data-po="' + name + '"]'); }
function make(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

var row = part('options');
var note = root.querySelector('#po-note');
var noteOpen = part('note-open');
var noteBox = part('note-box');

part('question').textContent = data.question;
if (data.context) part('context').textContent = data.context;
else part('context').remove();

/* the schema rejects a repeated id (x-rs-unique-key); should one still
   arrive, the later option is left out so the result names one option */
var seen = {};
var options = data.options.filter(function (o) {
  if (Object.prototype.hasOwnProperty.call(seen, o.id)) return false;
  seen[o.id] = true;
  return true;
});
var byId = {};
options.forEach(function (o) { byId[o.id] = o; });

var hasSummary = options.some(function (o) { return !!o.summary; });
var factRows = Math.max.apply(null, options.map(function (o) { return (o.facts || []).length; }));
row.setAttribute('data-count', String(options.length));
row.style.setProperty('--po-cols', String(options.length));
row.style.setProperty('--po-rows', String(1 + (hasSummary ? 1 : 0) + factRows));
row.setAttribute('label', RS.t('choice_group_label', { what: data.question }));

options.forEach(function (o, i) {
  var key = 'po-' + i;
  var card = make('button', 'po__card');
  card.type = 'button';
  card.value = o.id;
  var head = make('span', 'po__head');
  var mark = make('span', 'po__mark');
  mark.setAttribute('aria-hidden', 'true');
  var off = RS.icon('ring');
  off.classList.add('po__mark-off');
  var on = RS.icon('done');
  on.classList.add('po__mark-on');
  mark.appendChild(off);
  mark.appendChild(on);
  var title = make('span', 'po__title');
  var name = make('span', 'po__name', o.name);
  name.id = key + '-name';
  title.appendChild(name);
  var labelledBy = [name.id];
  if (data.suggested === o.id) {
    var tag = make('span', 'po__suggested', RS.t('po_suggested'));
    tag.id = key + '-suggested';
    title.appendChild(tag);
    labelledBy.push(tag.id);
    card.setAttribute('data-suggested', '');
  }
  head.appendChild(mark);
  head.appendChild(title);
  card.appendChild(head);
  var described = [];
  if (hasSummary) {
    var summary = make('span', 'po__summary', o.summary || '');
    if (o.summary) { summary.id = key + '-summary'; described.push(summary.id); }
    card.appendChild(summary);
  }
  for (var f = 0; f < factRows; f++) {
    var fact = (o.facts || [])[f];
    var cell = make('span', 'po__fact');
    if (fact) {
      cell.id = key + '-fact-' + f;
      cell.appendChild(make('span', 'po__label', fact.label));
      cell.appendChild(make('span', 'po__value', fact.value));
      described.push(cell.id);
    }
    card.appendChild(cell);
  }
  card.setAttribute('aria-labelledby', labelledBy.join(' '));
  if (described.length) card.setAttribute('aria-describedby', described.join(' '));
  row.appendChild(card);
});

function showNote(focus) {
  noteBox.hidden = false;
  noteOpen.hidden = true;
  if (focus) note.focus();
}
noteOpen.addEventListener('click', function () { showNote(true); });

/* Restore a half-done pick (window closed or reloaded), or show what was
   sent when a submitted report is reopened. */
var sent = RS.run.state === 'submitted' ? RS.run.result : null;
var draft = sent || (RS.run.state === 'open' ? RS.draft.get() : null);
if (draft && typeof draft === 'object') {
  if (typeof draft.choice === 'string' && Object.prototype.hasOwnProperty.call(byId, draft.choice)) row.value = draft.choice;
  if (typeof draft.note === 'string' && draft.note) {
    note.value = draft.note;
    showNote(false);
  }
  if (!sent) {
    var checked = row.buttons.filter(function (b) { return b.getAttribute('aria-checked') === 'true'; })[0];
    if (checked) checked.focus();
  }
}

function update(save) {
  if (RS.run.state !== 'open') {
    RS.setResult(null);
    RS.setStatus(null);
    return;
  }
  var picked = Object.prototype.hasOwnProperty.call(byId, row.value) ? byId[row.value] : null;
  var value = { choice: picked ? picked.id : '', note: note.value };
  if (save) RS.draft.set(value);
  RS.setSubmitLabel(picked ? RS.t('po_choose', { name: picked.name }) : RS.t('po_choose_idle'));
  RS.setResult(picked ? value : null);
  RS.setStatus(picked ? null : RS.t('po_pick', { n: RS.number(options.length) }));
}

row.addEventListener('change', function () { update(true); });
note.addEventListener('input', function () { update(true); });
update(false);
