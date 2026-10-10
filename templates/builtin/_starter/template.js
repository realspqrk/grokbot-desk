/* Body of function (RS, root). Use only the RS API (no network or clipboard
   APIs of the browser) and block comments only: the template lint treats a
   double slash as a URL. Calm UI: mark the item container data-rs-item, keep
   secondary inputs behind a text button, and let the shell's one primary
   button submit (RS.setResult). */
var data = RS.data;
var message = root.querySelector('[data-starter="message"]');
var copy = root.querySelector('rs-copy');
var row = root.querySelector('rs-action-row');
var note = root.querySelector('#starter-note');
var noteOpen = root.querySelector('[data-starter="note-open"]');
var noteBox = root.querySelector('[data-starter="note-box"]');

message.textContent = data.message;
if (data.copy) {
  copy.setAttribute('label', data.copy.label);
  copy.text = data.copy.text;
} else {
  copy.remove();
}
row.setAttribute('label', RS.t('choice_group_label', { what: RS.t('starter_heading') }));

function showNote(focus) {
  noteBox.hidden = false;
  noteOpen.hidden = true;
  if (focus) note.focus();
}
noteOpen.addEventListener('click', function () { showNote(true); });

/* Restore a half-done draft (window closed or reloaded), or show what was
   sent when a submitted report is reopened. A restored draft gets focus back. */
var sent = RS.run.state === 'submitted' ? RS.run.result : null;
var draft = sent || (RS.run.state === 'open' ? RS.draft.get() : null);
if (draft) {
  if (draft.choice) row.value = draft.choice;
  if (typeof draft.note === 'string' && draft.note) {
    note.value = draft.note;
    showNote(false);
  }
  if (!sent) {
    var checked = row.buttons.filter(function (b) { return b.getAttribute('aria-checked') === 'true'; })[0];
    if (checked) checked.focus();
    else if (draft.note) note.focus();
  }
}

function update(save) {
  var value = { choice: row.value, note: note.value };
  if (RS.run.state !== 'open') {
    RS.setResult(null);
    RS.setStatus(null);
    return;
  }
  if (save) RS.draft.set(value);
  RS.setResult(value.choice ? value : null);
  RS.setStatus(value.choice ? null : RS.t('starter_pick_choice'));
}

row.addEventListener('change', function () { update(true); });
note.addEventListener('input', function () { update(true); });
update(false);
