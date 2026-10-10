# `decide-list`: approve, reject or defer several items

Built-in template. Use it when the person has to decide on **2 to 5 items** (expense and travel requests, purchases, access requests, contract renewals, sorted mail that needs an answer). For a single yes/no decision use `approve-one`.

```
py -3 report_shell.py show decide-list --data payload.json
py -3 report_shell.py wait <run_id> --timeout 120
```

## What the person sees

- An optional `intro` line (muted), then **one item at a time**: the current item is a card with its kind and due date, the source and title, an optional detail, the values the person would otherwise retype next to copy icons, one segmented choice (`Approve`, `Reject`, `Defer`) and an optional note (`Add note`, shown on hover and keyboard focus).
- The other items are one-line rows (kind, source, title). Open rows carry a ring, the due date and a chevron; decided rows a check, muted text and the chosen outcome. A row opens its card.
- Picking a choice by click, Enter or Space moves on to the first open item; the arrow keys only change the choice.
- What the agent already handled (`done`) sits under one closed disclosure (`Sorted by your agent: 3 done`). The overall note sits behind `Add a note for your agent`.
- The primary `Send to agent` (or Ctrl+Enter) is enabled only when every item has a choice. Until then the status line names what is still open (`2 of 5 still open: IT desk, People team`; an item without `source` is named by its title), afterwards it reads `All decided`.
- Nothing is preselected. Choices and notes are kept as a draft and come back after a reload; the first open item is current again. A sent report shows what was sent, read-only; rows still open their cards and copies still work.

## Payload `data` (`schema.json`)

```json
{
  "intro": "Approve these five requests? Approve = go ahead, Reject = I say no and tell the requester, Defer = ask me again next week.",
  "items": [
    {
      "id": "travel-workshop",
      "kind": "Travel",
      "source": "Sam Okafor",
      "title": "Train and hotel for the client workshop in Lisbon, 412.80 EUR",
      "due": "2026-10-14",
      "copy": [
        {"label": "Copy booking ref", "text": "NW-TRV-20418"},
        {"label": "Copy amount", "text": "412.80"}
      ]
    },
    {
      "id": "billing-repo-access",
      "kind": "Access",
      "source": "Priya Natarajan",
      "title": "Write access to the billing-service repository",
      "choices": ["approve", "reject"]
    }
  ],
  "done": [{"text": "Filed three receipts under October expenses"}]
}
```

| Field | Rule |
|---|---|
| `intro` | optional, 1–300 characters, plain text |
| `items[]` | required, 1–5 items, shown in this order |
| `items[].id` | `^[a-z0-9-]{1,40}$`, unique: `show` rejects a repeated id (`x-rs-unique-key`) with exit 2 and a pointer such as `/data/items/1/id`; echoed in the result |
| `items[].kind` | optional, 1–24 (a short category above the title, e.g. `Expense`) |
| `items[].source` | optional, 1–60 (requester, sender or counterparty) |
| `items[].title` | required, 1–140 (one line) |
| `items[].detail` | optional, 1–600 (a snippet, never a full document) |
| `items[].due` | optional `YYYY-MM-DD` (shown as `due Oct 14` / `fällig 14.10.`) |
| `items[].copy[]` | optional, at most 4 of `{label 1–24, text 1–5000}`; each value is shown in full next to its button (long or multi-line values on their own line, clamped with *Show all*) |
| `items[].choices` | optional, 1–3 unique of `approve`, `reject`, `defer`, in this order; default all three |
| `done[]` | optional, at most 12 of `{text 1–140}`; not rendered when empty |

No links: put a reference number into a copy value instead.

## Result `data` (`result.schema.json`)

```json
{
  "items": [
    {"id": "travel-workshop", "choice": "approve", "note": "Booked on the cheaper fare"},
    {"id": "billing-repo-access", "choice": "reject", "note": ""}
  ],
  "note": ""
}
```

`items` has one entry per payload item, in payload order; `choice` is always one of that item's choices, `note` ≤500 (may be empty). `note` is the overall note (≤2000, may be empty). A discarded or expired report gives `cancelled` / `expired` and no `data`: do nothing.

## Strings used (`core/i18n/en.json`, `de.json`)

| Key | English | German |
|---|---|---|
| `section_todo` | Needs you | Wartet auf dich |
| `choice_approve`, `choice_reject`, `choice_defer` | Approve, Reject, Defer | Genehmigen, Ablehnen, Zurückstellen |
| `choice_group_label` | Decision: {what} (name of each choice row) | Entscheidung: {what} |
| `due` | due {date} | fällig {date} |
| `add_note`, `note_for` | Add note; Note on: {what} | Notiz hinzufügen; Notiz zu: {what} |
| `add_note_overall`, `note_overall` | Add a note for your agent; Note to your agent | Notiz an den Bot hinzufügen; Notiz an den Bot |
| `handled_summary`, `handled_done`, `section_done` | Sorted by your agent: {parts}; {n} done; Taken care of | Vom Bot sortiert: {parts}; {n} erledigt; Erledigt |
| `items_open_named`, `sep_names`, `items_all_decided` | {n} of {total} still open: {names}; `, `; All decided | {n} von {total} noch offen: {names}; `, `; Alles entschieden |

Copy button labels come from the payload (`copy[].label`).

## Test hooks

- Copy buttons: `data-copy-id="item-<n>-copy-<m>"` (both 1-based).
- Items `.dl-item[data-item-id="<id>"]` (`data-current`, `data-decided`), rows `.dl-row`, cards `.dl-card` (only the current card is in the document). Choice rows `rs-action-row[data-item="<id>"]`. Item notes `#dl-note-<n>` behind `.dl-add-note`; overall note `#dl-note` behind `[data-dl="overall-open"]`.

## Keyboard path (golden, one open report)

Tab ×5 passes the `…` menu and the two copy icons of the first card and reaches `Add note`; Space opens the note, type it; Shift+Tab returns to the choice row and Space approves (focus moves to the next item). ArrowRight ×2 then Space defers item 2; Space approves item 3; ArrowRight picks `Reject` on item 4, Tab and Space open its note, type, Shift+Tab and Space confirm; Space approves item 5. Tab ×2 passes the handled disclosure and reaches `Add a note for your agent`; Space, type, Ctrl+Enter sends.

## Files

| File | Notes |
|---|---|
| `template.json` | manifest (namespace `global`) |
| `template.html`, `template.css`, `template.js` | calm kit only: tokens, `rs-card`, `rs-action-row`, `rs-copy`, `rs-badge` |
| `schema.json`, `result.schema.json` | payload and result |
| `fixtures/golden.json` | 5 items, every choice set, copies, due dates, a detail, done list |
| `fixtures/edge-single.json` | one item, no kind, intro or done |
| `fixtures/edge-unicode.json` | emoji (ZWJ, flags, skin tone), CJK, Hangul, tabs, CRLF, decomposed umlauts |
| `fixtures/edge-max.json` | every field at its maximum (5 items, 4 copies each, one 5000-character copy, 12 done) |
| `fixtures/invalid-six-items.json` | rejected at `/items` |
| `fixtures/invalid-bad-choice.json` | rejected at `/items/1/choices/0` |
| `fixtures/invalid-duplicate-ids.json` | rejected at `/items/1/id` (two different items share the id `travel-workshop`) |
| `fixtures/expect/golden.json` | copies, `flow`, `keyboard`, `result` |
| `fixtures/expect/edge-unicode.json`, `edge-max.json` | every copy string |
