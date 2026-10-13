# `pick-option`: pick one of 2–4 options

Built-in template for one choice between 2 to 4 alternatives that the person should compare side by side: a venue, a laptop, a delivery slot, a plan. The question is the decision heading on top (left out when it only repeats the report title), then one card per option in one row (2, 3 or 4 columns; 3 or 4 options wrap to two columns when the window is narrow). The rows line up across the cards: name, short summary, then the facts in the same order.

- The cards are the radios of one radio group. Nothing is preselected; the agent's `suggested` option is only marked *Suggested*.
- The primary names the pick (*Choose Old Mill Studio*); until then it is disabled. The task banner already says *Pick one option*, so the footer adds no status of its own.
- *Add note*, a quiet text button under the cards, opens an optional note.
- *None of these* (a quiet footer alternative; `allow_none: false` hides it) puts the pick aside and asks *What is missing from these options?*. The note is required; the primary becomes *Send request*, *Cancel* brings the pick back, and picking a card also leaves this mode. The result is then a change request with no choice.

Pick this template when the person chooses **one** of a few alternatives. For a yes/no decision, use `approve-one`; for several independent items, `decide-list`.

## Payload `data` (`schema.json`)

```json
{
  "question": "Which venue should we book for the spring team day?",
  "context": "All three are free on Friday 15 May. Prices include room hire and lunch for 24 people.",
  "options": [
    {
      "id": "boathouse",
      "name": "Riverside Boathouse",
      "summary": "Bright room on the water with a terrace. Kayaks for the afternoon if the weather holds.",
      "facts": [
        { "label": "Price", "value": "€1,450" },
        { "label": "Travel", "value": "25 min by tram" },
        { "label": "Rain plan", "value": "Indoor room only" }
      ]
    },
    { "id": "old-mill", "name": "Old Mill Studio", "summary": "…", "facts": [ … ] },
    { "id": "hilltop", "name": "Hilltop Farm", "summary": "…", "facts": [ … ] }
  ],
  "suggested": "old-mill"
}
```

| Field | Rule |
|---|---|
| `question` | required, 1–200 characters, plain text. Shown as the decision heading; left out when it only repeats the report title |
| `context` | optional, 1–600 characters: constraints, what the agent already checked. Shown as the why of the task banner unless the payload brings its own `task.why` or the text has a link |
| `options` | required, 2–4 items, shown in this order |
| `options[].id` | `^[a-z0-9][a-z0-9_-]{0,31}$`, unique: `show` rejects a repeated id (`x-rs-unique-key`) with exit 2 and a pointer such as `/data/options/1/id` |
| `options[].name` | 1–48 characters; also used in the primary label |
| `options[].summary` | optional, 1–240 characters. An http(s) address in the question, context, name, summary or a fact becomes a link under that option's card (the link only, not the surrounding words) |
| `options[].copy` | optional, 1–4000 characters: the full text to copy, with a copy control in the same grid as that option's card, directly under it at every width, outside the selection button. The control is named for the option (`Copy: Offer` / `Kopieren: Offer`) |
| `options[].facts` | optional, at most 6 `{ "label" (1–32), "value" (1–80) }`. Use the same labels in the same order in every option so the rows line up; a missing fact leaves its row empty |
| `suggested` | optional option id; marked, never preselected; ignored when it names no option |
| `allow_none` | optional boolean, default `true`: offer *None of these*. `false` hides it |

## Result `data` (`result.schema.json`, oneOf)

```json
{ "choice": "old-mill", "note": "Please ask whether the garden has step-free access." }
```

```json
{ "decision": "request_changes", "note": "All three are too far for the night shift." }
```

| Field | Rule |
|---|---|
| `choice` | the `id` of the picked option |
| `note` | string, at most 1000 characters, may be empty |
| `decision` | only `request_changes`, for *None of these*: then there is no `choice`, and `note` (1–1000, not only spaces) says what is missing. Offer new options or ask again |

## Strings

English and German tables (`core/i18n/en.json`, `core/i18n/de.json`): `po_suggested` (Suggested / Empfohlen), `po_choose` (Choose {name} / {name} wählen), `po_choose_idle` (Choose / Auswählen), `po_note_placeholder` (Optional), `po_none` (None of these / Keine davon), `po_none_label` (What is missing from these options? / Was fehlt an diesen Optionen?), `po_none_required` (Say briefly what is missing / Schreib kurz, was fehlt); shared: `choice_group_label` (accessible name of the group: Decision: {what}), `add_note`, `note`, `request_send` (Send request / Anfrage senden), `cancel`.

## Fixtures

| File | What it covers |
|---|---|
| `golden.json` | 3 venues, summaries, 3 aligned facts, a suggestion |
| `edge-max.json` | 4 options, longest names and summaries, 6 facts each (4 columns; 2×2 when narrow) |
| `edge-two.json` | 2 options with names only, no context, no suggestion |
| `edge-uneven.json` | German content, a missing summary and an uneven number of facts (rows stay aligned) |
| `invalid-one-option.json`, `invalid-five-options.json`, `invalid-bad-id.json`, `invalid-duplicate-ids.json` | rejected at `/options` (too few, too many), `/options/0/id` and `/options/1/id` (two different options share the id `slot`) |
| `expect/golden.json` | `flow` (mouse) and `keyboard` (keys only) produce the same `result` |

## Keyboard path (golden, one report open)

Tab ×2 enters the option group (after the `…` menu) on the first card. ArrowRight moves to *Old Mill Studio* and picks it (the arrow keys move and pick, wrapping at the ends; Space picks the focused card). Tab reaches *Add note*; Space opens the note and focuses it; type. Ctrl+Enter sends.
