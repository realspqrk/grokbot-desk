# `_starter`: model template

The template an author copies to start a new template:

```
py -3 report_shell.py new <namespace>/<name>
```

It shows one card with a short text, one copy value (`rs-copy`), one choice with two options (`rs-action-row`) and a note field. The user picks an option, optionally writes a note, and sends the result with `An Bot senden` (or Ctrl+Enter).

## Purpose

- A working example of the template contract (spec section 4) that passes `report-shell check _starter`.
- The patterns to copy: German text only via `data-rs-t` / `RS.t`, payload text via `textContent`, `RS.setResult(null)` until the input is complete, drafts via `RS.draft`, and `data-copy-id` on every `rs-copy`.

## Payload `data` (`schema.json`)

```json
{
  "message": "Die Sicherung vom Server lief heute Nacht durch. Bitte kurz bestätigen, dass die Kontrolle erledigt ist, oder auf später schieben.",
  "copy": { "label": "Pfad kopieren", "text": "\\\\files.example.invalid\\backup\\2026-10-08\\nightly.log" }
}
```

| Field | Rule |
|---|---|
| `message` | required, 1–600 characters, plain text (newlines kept) |
| `copy` | optional; `label` 1–24 characters (button label), `text` 1–5000 characters (exact clipboard string, shown in full next to the button) |

Full envelope for `show`:

```json
{
  "schema": "report-shell/payload@1",
  "template": "_starter",
  "version": 1,
  "bot": "agent",
  "title": "Sicherung prüfen",
  "created": "2026-10-08T10:39:00+02:00",
  "data": { "message": "…", "copy": { "label": "Pfad kopieren", "text": "…" } }
}
```

`show _starter --data <file>` also accepts a bare `data` object; the core then wraps it in an envelope with the template's title.

## Result `data` (`result.schema.json`)

```json
{ "choice": "erledigt", "note": "Passt so" }
```

| Field | Rule |
|---|---|
| `choice` | `erledigt` or `spaeter` |
| `note` | string, at most 500 characters, may be empty |

The agent reads the result from the selected data directory (`RS_DATA_DIR` or the platform default), normally via `python report_shell.py wait` or `result`. Use the exact `result_path` printed by the command.

## German strings used

`starter_heading` (Beispielbericht), `choice_erledigt` (Erledigt), `choice_spaeter` (Später), `choice_group_label` (Entscheidung: {what}), `note` (Notiz), `starter_note_placeholder` (Optional; filled into the note's `placeholder` through `data-rs-t-placeholder`, the pattern for `placeholder`, `title`, `aria-label` and `alt`), `starter_pick_choice` (Bitte eine Option wählen). Every key is listed in `template.json` `strings` and exists in `core\i18n\de.json`. New keys go into `de.json` first.

## Files

| File | Notes |
|---|---|
| `template.json` | manifest; `components` and `strings` must list everything the template uses |
| `template.html` | partial; no literal text, only `<span data-rs-t="key"></span>`; only core custom elements |
| `template.css` | `var(--rs-*)` tokens only; no colour literals, no URLs |
| `template.js` | body of `function (RS, root)`; RS API only; block comments only (`//` fails the URL lint) |
| `schema.json`, `result.schema.json` | supported JSON-Schema keyword subset (spec 4.4) |
| `fixtures/golden.json` | the screenshot fixture |
| `fixtures/edge-max.json`, `fixtures/edge-no-copy.json` | all maxima with emoji/CJK/CRLF/tab; the optional copy left out |
| `fixtures/invalid-empty-message.json`, `fixtures/invalid-long-label.json` | rejected at `/message` and `/copy/label` |
| `fixtures/expect/golden.json` | `copies` (by `data-copy-id`), `flow` (mouse), `keyboard` (keys only), `result` (exact result data). `report-shell check` reports clearly that the `tools/e2e.mjs` backend is required to execute these expectations. |

## Keyboard path (golden, one run open)

Tab ×4 reaches the choice row (after `Hell/Dunkel`, the run in the rail and `Pfad kopieren`). Space picks `Erledigt` (the arrow keys move between options and pick them). Tab moves to the note; type the note; Ctrl+Enter sends.
