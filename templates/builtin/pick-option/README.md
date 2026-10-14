# Pick option

A question with two, three, or four options side by side. The person picks one. "None of these" asks what is missing and returns no choice.

The shell draws the header, the task banner, and the footer. The template fills the page. German is the default UI (`core/i18n/de.json`). `RS_LANG=en` selects the English strings below.

## What the person sees

The question as the heading, unless it only repeats the report title. An optional context line sits under it. Options stay in payload order. The same fact labels, in the same order, line the rows up. A suggested option is marked and is never preselected. Add note is a quiet link under the cards. The primary reads Choose until an option is picked, then Choose {name}.

`allow_none` defaults to true and offers None of these. That path asks for a note and returns `request_changes` with no `choice`. The decided banner says new options were requested, including when that report is opened again. Set `allow_none` to false to hide it.

## Payload data

```json
{
  "question": "Where should the spring team day be?",
  "context": "About twenty people, and one person uses a wheelchair.",
  "suggested": "old-mill",
  "options": [
    {
      "id": "old-mill",
      "name": "Old Mill",
      "summary": "A garden room outside town."
    },
    {
      "id": "river-hall",
      "name": "River Hall",
      "summary": "A room by the station."
    }
  ]
}
```

| Field | Rule |
|---|---|
| `question` | Required. 1 to 200 characters. http(s) addresses become links. |
| `context` | Optional. 1 to 600 characters. http(s) addresses become links. |
| `options` | Required. 2 to 4. Unique `id`. |
| `allow_none` | Optional. Default true. |
| `suggested` | Optional. An option `id`. Marked, never preselected. |

Each option has `id` (`^[a-z0-9][a-z0-9_-]{0,31}$`) and `name` (1 to 48). Optional: `summary` (1 to 240), `copy` (1 to 4000), and `facts` (at most 6, each `label` 1 to 32 and `value` 1 to 80). An http(s) address in `summary` is also shown as a link under the card.

## Result data

A pick is `choice` (the option id) and `note` (max 1000, may be empty). None of these is `decision` `request_changes` and a `note` that contains a non-space character, with no `choice`.

Picking Old Mill on the payload above:

```json
{
  "choice": "old-mill",
  "note": "Please ask whether the garden has step-free access."
}
```

Asking for different options:

```json
{
  "decision": "request_changes",
  "note": "None of these has step-free access."
}
```

## Keyboard path

Tab reaches the options. Left and Right move between them and select the one you land on. A suggested option is marked, and nothing starts selected. Tab reaches Add note. None of these is a footer alternative: it clears the pick and asks for a note. Ctrl+Enter or Cmd+Enter sends. The exact golden key sequence is in `fixtures/expect/golden.json`.

## Files

`template.json`, `template.html`, `template.css`, `template.js`, `schema.json`, `result.schema.json`, `fixtures/golden.json`, `fixtures/edge-*.json`, `fixtures/invalid-*.json`, `fixtures/expect/golden.json`, and this README. The task banner is in [docs/GUIDE.md](../../../docs/GUIDE.md).

## For maintainers

### Strings used

| Key | English |
|---|---|
| `choice_group_label` | Decision: {what} |
| `po_suggested` | Suggested |
| `po_choose` | Choose {name} |
| `po_choose_idle` | Choose |
| `po_note_placeholder` | Optional |
| `add_note` | Add note |
| `note` | Note |
| `copy` | Copy |
| `copy_named` | Copy: {name} |
| `po_none` | None of these |
| `po_none_label` | What is missing from these options? |
| `po_none_required` | Say briefly what is missing |
| `request_send` | Send request |
| `cancel` | Cancel |

### Test hooks

Option copy number `n` (1-based index in `options`) is `data-copy-id="option-<n>"`. The first option is `option-1`.
