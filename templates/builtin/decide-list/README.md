# `decide-list`: approve, reject or defer several items

Built-in template. Use it when the person has to decide on **2 to 12 items** (expense and travel requests, purchases, access requests, contract renewals, sorted mail that needs an answer). For a single yes/no decision use `approve-one`.

```
py -3 report_shell.py show decide-list --data payload.json
py -3 report_shell.py wait <run_id> --timeout 120
```

## What the person sees

- An optional `intro` line (shown as the why of the task banner above the title; it stays in the report, muted, when the payload brings its own `task.why` or the intro has a link), then **one item at a time**: the current item is a card with its source, kind and due date in a quiet line, the request itself, an optional detail, the values the person would otherwise retype next to copy icons, one segmented choice (`Approve`, `Reject`, `Defer`, or the payload's own `labels`) and an optional note (`Add note`, shown on hover and keyboard focus).
- The other items are quiet rows: the request in ink (up to two lines), then the source and kind as a muted line. Open rows carry a ring, the due date and a chevron; decided rows a check, muted text and the chosen outcome. A row opens its card. When nothing was handled by the agent, the list has no visible heading (its accessible name stays).
- Picking a choice by click, Enter or Space moves on to the first open item; the arrow keys only change the choice.
- What the agent already handled (`done`) sits under one closed disclosure (`Sorted by your agent: 3 done`). The overall note sits behind `Add a note for your agent`.
- The primary `Send decisions` / `Entscheidungen senden` (`Send decision` for one item; `Done` / `Fertig` when every item is the person's own) is enabled only when every item has a choice; Ctrl+Enter sends. It sends every choice at once and approves nothing by itself. The status line counts the choices by their labels and what is open (`2 Approve · 1 Reject · 2 open`); its accessible name adds the open items (`2 of 5 still open: IT desk, People team`; an item without `source` is named by its title).
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
| `action` | optional `post`, `send` or `continue` (default): what the bot does with the bot items you approve. Names the bot's banner line (Approve and the bot sends; in a mixed list `Inbox Agent sends after approval: 3 items`). The footer stays Send decisions. The result does not change |
| `labels` | optional `{approve?, reject?, defer?}`, each plain text of 1–24 characters (no line break, no leading or trailing space): the bot items' button labels, e.g. `{"approve": "Pay", "reject": "Dispute"}`. `labels.approve` also leads the banner (`Pay, then the bot continues`); rows and the status use the labels. The result keeps `approve`, `reject`, `defer`. Each choice of an item needs its own label: a label that repeats another choice of that item (its own, top-level or default label such as `Reject` / `Ablehnen`) is rejected at show, at that `labels` entry |
| `items[]` | required, 1–12 items, shown in this order. Each is a bot item (no `actor`, or `bot`) or a user item (`actor: user`) |
| `items[].id` | `^[a-z0-9-]{1,40}$`, unique: `show` rejects a repeated id (`x-rs-unique-key`) with exit 2 and a pointer such as `/data/items/1/id`; echoed in the result |
| `items[].kind` | optional, 1–24 (a short category above the title, e.g. `Expense`) |
| `items[].source` | optional, 1–60 (requester, sender or counterparty) |
| `items[].title` | required, 1–140 (one line). An http(s) address in the title or detail becomes a link |
| `items[].detail` | optional, 1–600 (a snippet, never a full document) |
| `items[].actor` | optional `bot` (default) or `user`. `bot`: Approve, Reject, Defer. `user`: the person does it. The choices are Done ✓, Skip and Later unless `content` is `post` or `reply` (Posted ✓) or `task.kind` is `post_yourself`. Results stay `done`, `skipped`, `later`. The bot never acts on a user item |
| `items[].content` | optional `post` or `reply`. Marks the item as something the person publishes, so the done choice reads Posted ✓. Without it a user item reads Done ✓ |
| `items[].url` | optional http(s) address, 8–2048 characters. A hostname is required. No backslash or control character. Credentials are rejected only in the authority (`user@host`); `@` may appear in the path, query or fragment. Shown as one link on its own line (that link opens the post) when it can be opened. The same address is not linked again in the title or detail. A URL the opener would reject is plain text |
| `items[].due` | optional `YYYY-MM-DD`, a real calendar day (shown as `due Oct 14` / `fällig 14.10.`); `2026-02-31` is rejected at show at `/items/<n>/due` |
| `items[].copy[]` | optional, at most 4 of `{label 1–24, text 1–5000}`; each value is shown in full next to its button (long or multi-line values on their own line, clamped with *Show all*) |
| `items[].labels` | optional, bot items only: `{approve?, reject?, defer?}` as top-level `labels`; wins over them for this item. A user item with `labels` is rejected at `/items/<n>/labels` |
| `items[].choices` | optional, 1–3 unique, in this order. Bot item: of `approve`, `reject`, `defer` (default all three). User item: of `done`, `skipped`, `later` (default all three). A value from the other side is rejected at `/items/<n>/choices/<m>` |
| `done[]` | optional, at most 12 of `{text 1–140}`; not rendered when empty |

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

`items` has one entry per payload item, in payload order. For a `bot` item, `choice` is one of that item's `choices` (`approve`, `reject`, `defer`), whatever the labels say. For a `user` item, `choice` is one of its `choices` (`done`, `skipped`, `later`). `note` ≤500 (may be empty). The overall `note` is ≤2000 (may be empty). When every item is `actor: user`, the footer primary reads Done (Fertig): it reports the status back, and the banner steps say `Do or skip each item, then press Done` (`Post or skip each reply…` for replies). Otherwise it reads Send decisions (Entscheidungen senden). A mix of user and bot items gives each actor one banner line, the person first, counted: `You post: 2 replies` / `Inbox Agent sends after approval: 3 items` (the verb from the optional top-level `action`: `post`, `send` or `continue`; the footer still reads Send decisions). A skipped, deferred or rejected item leaves its line; a side with nothing left says so (`Inbox Agent sends nothing`), and the decided banner says what each side did. A discarded or expired report gives `cancelled` / `expired` and no `data`: do nothing.

## Strings used (`core/i18n/en.json`, `de.json`)

| Key | English | German |
|---|---|---|
| `section_todo` | Needs you (visually hidden when it is the only group) | Wartet auf dich |
| `choice_approve`, `choice_reject`, `choice_defer` | Approve, Reject, Defer | Freigeben, Ablehnen, Zurückstellen |
| `done_mark`, `posted`, `skip`, `later` | Done ✓ or Posted ✓, Skip, Later (user items) | Erledigt ✓ or Gepostet ✓, Überspringen, Später |
| `footer_done` | Done (footer when every item is a user item) | Fertig |
| `send_decisions`, `send_decision_one` | Send decisions; Send decision (the footer otherwise) | Entscheidungen senden; Entscheidung senden |
| `dl_count` | {n} {label} (one count in the status line) | {n} {label} |
| `links_label` | Links (name of a row that holds more than one link) | Links |
| `choice_group_label` | Decision: {what} (name of each choice row) | Entscheidung: {what} |
| `due` | due {date} | fällig {date} |
| `add_note`, `note_for` | Add note; Note on: {what} | Notiz hinzufügen; Notiz zu: {what} |
| `add_note_overall`, `note_overall` | Add a note for your agent; Note to your agent | Notiz an den Bot hinzufügen; Notiz an den Bot |
| `handled_summary`, `handled_done`, `section_done` | Sorted by your agent: {parts}; {n} done; Taken care of | Vom Bot sortiert: {parts}; {n} erledigt; Erledigt |
| `items_open_short`, `items_open_named`, `sep_list`, `sep_names` | the counts, then `{n} open` (the accessible name is that text, then ` · `, then `{n} of {total} still open: {names}`); ` · `; `, ` | die Zählung, dann `{n} offen` (der Name ist dieser Text, dann ` · `, dann `{n} von {total} noch offen: {names}`); ` · `; `, ` |

Copy button labels come from the payload (`copy[].label`).

## Test hooks

- Copy buttons: `data-copy-id="item-<n>-copy-<m>"` (both 1-based).
- Items `.dl-item[data-item-id="<id>"]` (`data-current`, `data-decided`), rows `.dl-row`, cards `.dl-card` (only the current card is in the document). The post address, when it can be opened, is `.dl-url a.rs-ext`. Choice rows `rs-action-row[data-item="<id>"]`. Item notes `#dl-note-<n>` behind `.dl-add-note`; overall note `#dl-note` behind `[data-dl="overall-open"]`.

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
| `fixtures/edge-max.json` | every field at its maximum (12 items, 4 copies each, one 5000-character copy, 24-character labels, 12 done) |
| `fixtures/edge-many.json` | 12 invoices with the payload's own labels (Pay, Dispute, Next week) and one item label |
| `fixtures/edge-replies.json` | four replies the person posts (`actor: user`, `content: reply`) |
| `fixtures/invalid-too-many-items.json` | 13 items, rejected at `/items` |
| `fixtures/invalid-bad-choice.json` | rejected at `/items/1/choices/0` |
| `fixtures/invalid-duplicate-ids.json` | rejected at `/items/1/id` (two different items share the id `travel-workshop`) |
| `fixtures/invalid-duplicate-labels.json` | rejected at `/items/1/labels/reject` (the item's Reject reads Pay, like the top-level approve label) |
| `fixtures/invalid-impossible-due.json` | rejected at `/items/1/due` (`2026-02-31` is no calendar day) |
| `fixtures/expect/golden.json` | copies, `flow`, `keyboard`, `result` |
| `fixtures/expect/edge-unicode.json`, `edge-max.json` | every copy string |
