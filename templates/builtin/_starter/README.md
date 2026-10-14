# Starter template

This is the copy `new` writes when no built-in fits. It shows one short message, an optional value to copy, and two choices.

The shell draws the header, the task banner, and the footer. The template fills the page. German is the default UI (`core/i18n/de.json`). `RS_LANG=en` selects the English strings below.

## What the person sees

A heading, the message, and a copy control when `copy` is set. Two choices sit in one row: Done and Later. A note stays closed until the person opens it. Nothing is preselected. Ctrl+Enter or Cmd+Enter sends the choice.

## Payload data

`message` is required (1 to 600 characters, plain text, newlines allowed). `copy` is optional: `label` (1 to 24) and `text` (1 to 5000). The clipboard receives `text` exactly.

```json
{
  "message": "Last night's server backup finished. Please confirm that the check is done, or move it to later.",
  "copy": {
    "label": "Copy path",
    "text": "\\\\files.example.invalid\\backup\\2026-10-08\\nightly.log"
  }
}
```

## Result data

The choice values `erledigt` (Done) and `spaeter` (Later) are German on purpose, and so is the sample note `Passt so`, because result values belong to the template; rename the choice values in `schema.json`, `result.schema.json`, and `template.js` together if you change them. `note` is required and may be empty, at most 500 characters.

Choosing Done on the message above:

```json
{
  "choice": "erledigt",
  "note": "Passt so"
}
```

## Keyboard path

Tab reaches the two choices. Space or Enter selects the focused one. Left and Right move between Done and Later and select the one you land on. Tab reaches Add note. Space or Enter opens it. Ctrl+Enter or Cmd+Enter sends. The exact golden key sequence is in `fixtures/expect/golden.json`.

## Files

`new` writes this folder to `<data dir>/templates/<name>/`. It does not write into the install tree.

```text
python report_shell.py new <namespace>/<name>
```

`<namespace>` is the bot id, for example `inbox-agent`. The folder name is `<name>`.

`template.json`, `template.html`, `template.css`, `template.js`, `schema.json`, `result.schema.json`, `fixtures/golden.json`, `fixtures/edge-*.json`, `fixtures/invalid-*.json`, `fixtures/expect/golden.json`, and this README. Design rules, `check`, and the RS API are in [docs/GUIDE.md](../../../docs/GUIDE.md).

## For maintainers

### Strings used

| Key | English |
|---|---|
| `starter_heading` | Example report |
| `choice_erledigt` | Done |
| `choice_spaeter` | Later |
| `choice_group_label` | Decision: {what} |
| `add_note` | Add note |
| `note` | Note |
| `starter_note_placeholder` | Optional |
| `starter_pick_choice` | Please pick an option |

### Test hooks

The copy control is `data-copy-id="starter-copy"` in `template.html`. The golden expect maps that id to the path in the payload above. There is no counter.

### Files in the copy

| File | Role |
|---|---|
| `template.json` | Manifest. `new` sets `id`, `namespace`, and `title_de`. |
| `template.html` | The partial. Components: `rs-copy`, `rs-action-row`. |
| `template.css` | Layout for this card only. |
| `template.js` | Reads `RS.data`, sets the result. |
| `schema.json` | Payload `data`. |
| `result.schema.json` | Result `data`. |
| `fixtures/golden.json` | The payload above. |
| `fixtures/edge-*.json` | Two valid edge payloads. |
| `fixtures/invalid-*.json` | Two payloads `check` must reject. |
| `fixtures/expect/golden.json` | Copies, flow, keyboard, and the result above. |
