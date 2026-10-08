/* Body of function (RS, root). Use only the RS API (no network or clipboard
   APIs of the browser) and block comments only: the template lint treats a
   double slash as a URL. */
var data = RS.data;
var message = root.querySelector('[data-starter="message"]');
var copy = root.querySelector('rs-copy');
var row = root.querySelector('rs-action-row');
var note = root.querySelector('#starter-note');

message.textContent = data.message;
if (data.copy) {
  copy.setAttribute('label', data.copy.label);
  copy.text = data.copy.text;
} else {
  copy.remove();
}
row.setAttribute('label', RS.t('choice_group_label', { what: RS.t('starter_heading') }));

/* Restore an open draft or the immutable result of a submitted run. */
var sent = RS.run.state === 'submitted' ? RS.run.result : null;
var draft = sent || (RS.run.state === 'open' ? RS.draft.get() : null);
if (draft) {
  if (draft.choice) row.value = draft.choice;
  if (typeof draft.note === 'string') note.value = draft.note;
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
