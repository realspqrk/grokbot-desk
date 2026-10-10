# `pick-option`: pick one of 2–4 options

Built-in template for one choice between 2 to 4 alternatives that the person should compare side by side: a venue, a laptop, a delivery slot, a plan. The question sits on top, then one card per option in one row (2, 3 or 4 columns; 3 or 4 options wrap to two columns when the window is narrow). The rows line up across the cards: name, short summary, then the facts in the same order.

- The cards are the radios of one radio group. Nothing is preselected; the agent's `suggested` option is only marked *Suggested*.
- The primary names the pick (*Choose Old Mill Studio*); until then it is disabled and the status says *Pick one of 3 options*.
- *Add note* (shown on hover or keyboard focus) opens an optional note.

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
| `question` | required, 1–200 characters, plain text |
| `context` | optional, 1–600 characters: constraints, what the agent already checked |
| `options` | required, 2–4 items, shown in this order |
| `options[].id` | `^[a-z0-9][a-z0-9_-]{0,31}$`, unique: `show` rejects a repeated id (`x-rs-unique-key`) with exit 2 and a pointer such as `/data/options/1/id` |
| `options[].name` | 1–48 characters; also used in the primary label |
| `options[].summary` | optional, 1–240 characters |
| `options[].facts` | optional, at most 6 `{ "label" (1–32), "value" (1–80) }`. Use the same labels in the same order in every option so the rows line up; a missing fact leaves its row empty |
| `suggested` | optional option id; marked, never preselected; ignored when it names no option |

## Result `data` (`result.schema.json`)

```json
{ "choice": "old-mill", "note": "Please ask whether the garden has step-free access." }
```

| Field | Rule |
|---|---|
| `choice` | the `id` of the picked option |
| `note` | string, at most 1000 characters, may be empty |

## Strings

English and German tables (`core/i18n/en.json`, `core/i18n/de.json`): `po_suggested` (Suggested / Empfohlen), `po_pick` (Pick one of {n} options / Eine von {n} Optionen wählen), `po_choose` (Choose {name} / {name} wählen), `po_choose_idle` (Choose / Auswählen), `po_note_placeholder` (Optional); shared: `choice_group_label` (accessible name of the group: Decision: {what}), `add_note`, `note`.

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
