# Decide list

A list of 1 to 12 items. Each item is a bot action (approve, reject, defer) or something the person does (done, skipped, later). One card is open at a time. The other items are quiet rows.

The shell draws the header, the task banner, and the footer. The template fills the page. German is the default UI (`core/i18n/de.json`). `RS_LANG=en` selects the English strings below.

## What the person sees

An optional intro, then the items in payload order. The open item is a card: title, optional detail, a due date, copy values, and its choices. Add note is a quiet link on that card. A row opens that item. Choices are not preselected.

The footer sends every choice at once. It reads Send decisions, Send decision when there is one item, or Done when every item is `actor` `user`. The footer stays Done on an all-user list. Posted ✓ is the item's done choice, not the footer. The status counts choices by the labels on screen, including a custom label, then what is still open.

A long list scrolls inside the report. The header and the footer stay.

Items the bot already handled, with nothing left to decide, go in `done` (at most 12) under one closed disclosure, "Taken care of".

## Payload data

`items` is required. Ids are unique and match `^[a-z0-9-]{1,40}$`. A bot item needs `id` and `title` (`actor` defaults to `bot`). A user item needs `id`, `title`, and `"actor": "user"`.

```json
{
  "intro": "Two items from this morning.",
  "items": [
    {
      "id": "travel-workshop",
      "title": "Book the workshop travel",
      "source": "People team"
    },
    {
      "id": "laptop-refresh",
      "title": "Refresh the loan laptops",
      "actor": "user",
      "content": "post"
    }
  ]
}
```

| Field | Rule |
|---|---|
| `intro` | Optional. 1 to 300 characters. |
| `action` | Optional. `post`, `send`, or `continue` (default). Names the bot in the task banner. The result values do not change. |
| `labels` | Optional shared button labels for bot items, 1 to 24 characters each: `approve`, `reject`, `defer`. The result value stays `approve`, `reject`, or `defer`. An item's own `labels` win. A label that repeats another choice of that item, including a default label such as Reject, is rejected at `show`. The error points at that `labels` entry. A user item cannot carry `labels`. A choice from the other actor is rejected. |
| `items` | 1 to 12. Shown one at a time in this order. |
| `done` | Optional. At most 12. Each entry is `{text}` of 1 to 140 characters. |

| Field | Bot item | User item |
|---|---|---|
| `id` | Required. Unique. `^[a-z0-9-]{1,40}$`. | Same. |
| `title` | Required. 1 to 140. | Same. |
| `actor` | `bot`, the default. | Required `user`. |
| `choices` | 1 to 3 of `approve`, `reject`, `defer`. Default is all three. | 1 to 3 of `done`, `skipped`, `later`. Default is all three. |
| `labels` | Optional. 1 to 24 characters. Keys `approve`, `reject`, `defer`. Result values stay the choice ids. A repeated label is rejected at `show`. | No `labels` object. |
| `kind` | Optional. 1 to 24. | Same. |
| `source` | Optional. 1 to 60. | Same. |
| `detail` | Optional. 1 to 600. | Same. |
| `content` | Optional `post` or `reply`. | Same. `post` or `reply` makes the done choice read Posted ✓. An explicit `task.kind` of `post_yourself` does the same for the other user items. The result value stays `done`. |
| `url` | http or https, 8 to 2048 characters, hostname of letters, digits, hyphens, and dots. An IPv6 literal is rejected. | Same. |
| `due` | `YYYY-MM-DD`, a real calendar day. | Same. |
| `copy` | At most 4. `label` 1 to 24, `text` 1 to 5000. | Same. |

http(s) addresses in `title` and `detail` become links. The same address is not linked again when it is already the `url`.

## Result data

One entry per payload item, in payload order. `note` on an item may be empty (max 500). The overall `note` may be empty (max 2000). Bot choices are `approve`, `reject`, or `defer`, and only from that item's `choices`. User choices are `done`, `skipped`, or `later`.

Approving the workshop and marking the laptop refresh done, which is the payload above:

```json
{
  "items": [
    {"id": "travel-workshop", "choice": "approve", "note": ""},
    {"id": "laptop-refresh", "choice": "done", "note": ""}
  ],
  "note": ""
}
```

## Keyboard path

The open item's choices are one row. Left and Right move along that row and select the choice you land on. They stay on this item. Space, Enter, or a click selects the focused choice and opens the next item that still needs a choice. Tab reaches Add note and the footer. The footer sends every choice at once. Ctrl+Enter or Cmd+Enter sends. The exact golden key sequence is in `fixtures/expect/golden.json`.

## Files

`template.json`, `template.html`, `template.css`, `template.js`, `schema.json`, `result.schema.json`, `fixtures/golden.json`, `fixtures/edge-*.json`, `fixtures/invalid-*.json`, `fixtures/expect/golden.json`, and this README. Banner kinds and the result envelope are in [docs/GUIDE.md](../../../docs/GUIDE.md).

## For maintainers

### Strings used

| Key | English |
|---|---|
| `section_items` | Items |
| `section_done` | Taken care of |
| `handled_summary` | Sorted by your bot: {parts} |
| `handled_done` | {n} done |
| `choice_approve` | Approve |
| `choice_reject` | Reject |
| `choice_defer` | Defer |
| `posted` | Posted ✓ |
| `skip` | Skip |
| `later` | Later |
| `done_mark` | Done ✓ |
| `footer_done` | Done |
| `send_decisions` | Send decisions |
| `send_decision_one` | Send decision |
| `dl_count` | {n} {label} |
| `choice_group_label` | Decision: {what} |
| `due` | due {date} |
| `add_note` | Add note |
| `add_note_overall` | Add a note for your bot |
| `note_for` | Note on: {what} |
| `note_overall` | Note to your bot |
| `items_open_named` | {n} of {total} still open: {names} |
| `items_open_short` | {n} open |
| `links_label` | Links |
| `sep_list` | ` · ` |
| `sep_names` | `, ` |
| `copy` | Copy |

### Test hooks

A copy on item number `n` (1-based index in `items`) and copy number `m` (1-based) is `data-copy-id="item-<n>-copy-<m>"`. Example: the first copy of the first item is `item-1-copy-1`.

### Golden result

The golden fixture in `fixtures/golden.json` decides five items. Its result:

```json
{
  "items": [
    {"id": "travel-workshop", "choice": "approve", "note": "Booked on the cheaper fare"},
    {"id": "laptop-refresh", "choice": "defer", "note": ""},
    {"id": "billing-repo-access", "choice": "approve", "note": ""},
    {"id": "cleaning-renewal", "choice": "reject", "note": "Ask for a six-month option"},
    {"id": "offsite-date", "choice": "approve", "note": ""}
  ],
  "note": "Thanks, all set."
}
```
