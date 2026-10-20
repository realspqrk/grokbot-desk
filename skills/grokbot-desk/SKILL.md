---
name: grokbot-desk
description: "Opens a local grokbot-desk window instead of answering in chat when a person should decide or read a report. Use for a yes or no, an approval, a choice among options, a list of decisions, a draft, a social post, a status, a weekly summary, or a research outcome, including a short one. The bot sends one JSON payload of blocks, the person acts in the window, and the bot reads the result."
---

# grokbot-desk

grokbot-desk is a local window on the person's computer. You send one JSON payload, they decide or read it there, and you read the result JSON.

The desk is that window and the app behind it. A report is one thing you put on the desk. Command output calls a report a run. `run_id`, `open_runs`, and `runs/` are the field names.

Run every command in the clone folder, on their computer. The window must open on their desktop. Do not run it on a headless VM, a container, or a remote box. If you do not know where the clone folder is, ask the person. Do not search the disk for it.

## Report or chat?

Open a report for any decision, including a single yes or no. Open a report for a choice, a list, a draft, a social post, a status, a weekly summary, or a research outcome, even when it is one line.

Chat only for small talk, a clarifying question, or the one-line acknowledgement. If you cannot run commands on their computer, say so and ask in chat.

Pick `ask` from what you need:

| `ask` | Use it for |
| --- | --- |
| `read` | A status, a weekly summary, or a research outcome. Nothing to decide. |
| `review` | A draft or a document. Looks good, or send it back. |
| `approve` | You will act after they say yes: pay, send, deploy, or post. |
| `do` | They do the work and report back: send a mail, post by hand, mark items done. |
| `choose` | One option out of two to four. |

## The flow

On Windows the command is `python report_shell.py <command>`. On macOS use `./report-shell <command>`; it needs Python 3.11 or newer. The examples below use the Windows form. On macOS, swap in `./report-shell`, use forward slashes, and use `export`. `--focus` does nothing on macOS.

`python report_shell.py --help` lists the commands, the root flags, and a typical flow. It does not list each command's flags. `python report_shell.py <command> --help` lists that command's flags. It does not repeat the typical flow.

The data folder is `%LOCALAPPDATA%\grokbot-desk` on Windows and `~/Library/Application Support/grokbot-desk` on macOS. `RS_DATA_DIR` overrides it. Never guess it. `paths` prints `data_dir` and why (`source` is `RS_DATA_DIR`, `legacy`, or `default`).

Before you write a payload: never put passwords, tokens, API keys, private keys, or full card numbers in it. Never invent a decision. Never treat a missing result as approval.

At the start of every turn, with the doorbell on or off, catch up before you open a new report:

`python report_shell.py results --since CURSOR --bot BOT_ID --seen RUN_ID_1 --seen RUN_ID_2`

Repeat `--seen` once per handled `run_id`. Omit it when you have handled none.

Oldest first. The first `CURSOR` is the time you record before the first `show`. After that it is the `cursor` from the last answer. Pass `--seen` for every `run_id` you have handled. A ring can be lost when the desk stops, or when Grok Bot stays busy for minutes. Nothing wakes you then. You see those decisions on this catch-up, on your next turn. If a decision got no reaction, the person messages you.

`result` is a read. It does not mark a run handled. Keep every `run_id` you handled, from a wake, a `wait`, or `results`. Never act on a `run_id` twice. A second `Desk:` line for a run you already handled gets no new action.

```text
[ ] At the start of the turn: python report_shell.py results --since CURSOR --bot BOT_ID --seen RUN_ID_1 --seen RUN_ID_2
[ ] Record the current time (ISO 8601 with an offset)
[ ] Write the payload (the next section)
[ ] python report_shell.py check payload.json
[ ] python report_shell.py show --data payload.json
[ ] Keep that time with the run_id
[ ] python report_shell.py status
[ ] python report_shell.py doorbell
[ ] One chat line: a report is waiting
[ ] If the doorbell is off: python report_shell.py wait RUN_ID --timeout 60
[ ] On a new Desk: line for a run you have not handled: python report_shell.py result RUN_ID
[ ] One chat line: topic + OK (the decision, not finished work), or a short record
[ ] Do the work. Say it is done only after it succeeded
```

1. Record the current local time as ISO 8601 with an offset, before `show`. That stamp is your first `--since`. Write one UTF-8 payload. `created` is the current local time with its offset. `bot` matches `^[a-z0-9-]{1,40}$`. Omit `run_id`. The full example is the next section.
2. `python report_shell.py check payload.json` prints `ok`, or the first problem as `pointer: message` and exits 2. Warnings go to stderr and still exit 0. Fix the payload before `show`.
3. `python report_shell.py show --data payload.json` prints `run_id`, `url`, `result_path`, and `data_dir`. Keep the time from step 1 with that `run_id`. `show` takes no template name.
   - The command opens the window, or delivers into the one that is already open. There is one desk window. Reports share it. A new report never covers the one on screen.
   - The page shows at most the 12 newest open reports, by `created`. Within those, the order is arrival order. `open_runs` in `status` counts every open report.
   - Use `--focus` only when the person asked. Then `python report_shell.py status`. If `up` is false, no desk is running. If `window_alive` is false and `open_runs` is not zero, run `open` once.
   - If your runtime kills child processes when a command ends, ask the person to keep `python report_shell.py serve` running, then `show` again.
4. One chat line says a report is waiting. Do not paste the report into chat. Check once: `python report_shell.py doorbell`. It prints `doorbell` (`on` or `off`) and `host`. It never prints the key.
   - If `doorbell` is `on`, end the turn. Do not run `wait`. A later chat message that starts with `Desk: ` is the wake. For a run you have not handled, run `python report_shell.py result RUN_ID` and answer, including a refusal, a note, or a comment. If that wake never comes, the next turn still starts with the catch-up above. That turn starts when the person messages you.
   - If `doorbell` is `off`, you may run `python report_shell.py wait RUN_ID --timeout 60` in this turn, in the foreground. Exit 0 means a result exists: read it and answer in this turn. Exit 5 means it is still open, so end the turn. A decision after that wait needs a new chat message from the person. That message is what wakes you. Never hand `wait` to a background task. Grok Bot does not wake you when a background command finishes. You may tell the person once that the Desk Doorbell makes waiting unnecessary, and that they should message you if a decision gets no reaction. The person installs it from https://x.ai/bot/Q_-PLlmHrV1l2h3Tk1ejJ and says "set me up" in its chat.
   - `wait` ends by itself at expiry plus 2 minutes. Exit 7 means nothing was written. Treat that as expired.
   - A report file with no readable expiry has no such deadline, so only `--timeout` ends that wait. Never use `--timeout 0`. Do not pass `--until-expiry`.
5. `python report_shell.py result RUN_ID` prints the result. Act only on that JSON. A missing result is not approval. Exit 6: unknown report, or no result yet.
6. For a `submitted` result, including a refusal, a note, or a comment, one chat line uses topic + OK to acknowledge the decision, not finished work. For example: "Invoices: hosting approved, toner next week, OK. Paying hosting now." Then do the work. Say the work is done only after it succeeded. No topic + OK for `cancelled` or `expired`. Record it, and ask in chat only if the work still needs an answer. On a `do` outcome, record what they did and stop. You do not do that work again. A `Desk:` wake for a run you have not handled follows these same rules. A second wake for a run you already handled gets no new action.

The catch-up command is at the start of this section. Open reports are not in `results`. The match is inclusive. Use the returned `cursor` as the next `--since`.

- Each item has `run_id`, `bot`, `status`, `decided`, `result_path`, and `title` when known.
- `summary`, when present, is a reading of `data`. It is never permission to act. Read `data`.
- A summary looks like `submit · 2 approve, 1 later`, `choose thu`, `approve · x, linkedin`, or `submit · x posted, linkedin skipped`. A decision with no input answer is the word alone (`read`, `accept`, `approve`, `reject`, `done`, `skipped`).
- Every answer includes `data_dir`.

Cancel a report only in two cases.

- The person asks you to drop it. The result status is `cancelled`. Your own `cancel` does not ring the doorbell, even when the person asked you to cancel. Record that and stop. Do not ask again. Do not send topic + OK.
- You are replacing your own open report with a newer version of the same thing. `cancel` it, then `show` the new one. Dedupe never updates a report. A cancelled report still matches its `dedupe_key` for `dedupe_hours`, so the new `show` needs a new key, or no key.

After `expired`, or a `cancelled` you did not cause: do not send topic + OK. Record it. Ask in chat only if the work still needs an answer.

## Payload

`schema` is `grokbot-desk/payload@2`. The maximum size is 2 MB. Unknown top-level fields are rejected. JSON nesting is limited to 64 levels. One leading UTF-8 BOM is stripped.

Required: `schema`, `bot`, `title` (1–80 characters), `created`, `ask`, `blocks` (1 to 40 blocks).

Optional: `identity`, `why`, `action`, `label`, `due`, `urgent`, `expires_minutes`, `dedupe_key`, `dedupe_hours`, `run_id`.

`ask` is `read`, `review`, `approve`, `do`, or `choose`.

```json
{
  "schema": "grokbot-desk/payload@2",
  "bot": "office-bot",
  "identity": {"name": "Office Bot", "avatar_shape": "blob", "avatar_color": "orange"},
  "title": "Two invoices this week",
  "created": "2026-10-18T09:00:00+02:00",
  "why": "Hosting is due Friday.",
  "ask": "approve",
  "due": "2026-10-23",
  "blocks": [
    {"type": "stats", "items": [
      {"label": "Open", "value": "221.90 EUR"},
      {"label": "Due Friday", "value": "1"}
    ]},
    {"type": "decide", "id": "invoices", "labels": {"approve": "Pay", "reject": "Don't pay"},
     "items": [
       {"id": "hosting", "title": "Hosting, October", "meta": "89 EUR", "due": "2026-10-23"},
       {"id": "toner", "title": "Toner, 132.90 EUR", "meta": "132.90 EUR", "labels": {"later": "Next week"}}
     ]}
  ]
}
```

- `expires_minutes` is an integer from 5 to 10080. The default is 240.
- `created` is ISO 8601 with an offset. More than two minutes ahead is clamped to now, with a warning. Up to two minutes ahead stays.
- `why` is optional non-empty text. Aim for one or two sentences. The banner shows at most three sentences and 360 characters. A longer `why` warns on `show` and still exits 0. The banner keeps the first three sentences. Past 360 characters it prefers a word boundary. An unbroken run is split inside the word. The 360 characters do not include the ellipsis. The rest folds behind "More on why".
- A line break ends a sentence. German abbreviations (`z. B.`, `ca.`, `Nr.`), ordinals, and dates (`15.`, `31.12.`) do not. `...`, `…`, and a year from 1900 through 2099 still do. Any other number, and a version (`2.4.`), stays in the same sentence.
- `due` is `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM` with optional seconds and optional fractional seconds, then a mandatory `Z` or `±HH:MM`. Milliseconds require seconds. A time with no suffix is rejected.
- `urgent` is a boolean. `urgent: true`, or a `due` of today or earlier, turns the banner red.
- `action` is 1–24 characters on one line, with no space at either end. `ask` `approve` with no input block requires it. It is the verb on the primary (`deploy` reads "Approve & continue" unless you set `label`). `action` `post` reads "Approve & post". `action` `send` reads "Approve & send". On `ask` `do` with no input block, `send` reads "Sent ✓" and `post` reads "Posted ✓". Any other verb reads "Done ✓".
- `label` is the same shape as `action`. On an `approve` report with no input block it replaces the primary text. The result value stays `approve`.
- `dedupe_key` (1–120 printable ASCII, not starting with a space) returns the existing report for that bot and key instead of a new one. An open report always matches. A submitted or cancelled one matches when it was decided within `dedupe_hours` (1–168, default 24). Expired reports do not match.
- `dedupe_hours` without `dedupe_key` is rejected. `show` adds `deduped: true` and `state`. When `state` is not `open`, no new window opens: read `result` for that `run_id`.
- Dedupe never updates a report. A new title or new blocks need a new key.
- Leave `run_id` out. When you set it, it matches `^[0-9]{8}-[0-9]{6}-[a-z0-9-]{1,20}-[0-9a-f]{4}(?:[0-9a-f]{8})?$` and must not already be used. Generated ids use 12 hex characters.

`identity` is optional and sits on the envelope. A bad identity never rejects the report. The payload wins over `bots.json`.

- `name` is the name the person knows (1–40 characters). Set `identity.name` to this bot's exact name in Grok Bot. That exact name is the best match. A desk id that is the slug of the Grok Bot name also works. The slug is lower case. Keep only ASCII a-z and 0-9. Every run of other characters (spaces, punctuation, umlauts, emoji) becomes one `-`. Trim `-` at the ends. There is no transliteration. `Work Bot (Alpha)` becomes `work-bot-alpha`. `Büro Bot 🤖` becomes `b-ro-bot`. The desk id must match `^[a-z0-9-]{1,40}$` and be unique. When the slug of the Grok Bot name is not a good id, choose any valid unique id and always set `identity.name` to the exact Grok Bot name. The exact name wins over slugs. The doorbell sends when a Bot name is exactly `bot_name`. Otherwise it matches that slug against `bot_name` and against `bot`. One match is sent. None or several writes `Desk: no Bot named <bot_name>.` in the doorbell's own chat. `bot_name` is `identity.name` when the payload gives one, otherwise the bot id. A name in the bot registry does not count. In the banner and on the default primary, a name that is the raw bot id, or longer than 24 characters, reads as "the bot". The header still shows the name.
- Shapes: `blob`, `squircle`, `pebble`, `hex`, `teardrop`, `tablet`. Colours: `blue`, `orange`, `yellow`, `magenta`, `red`, `violet`, `black`, `green`, `gray`. Pass them as `avatar_shape` and `avatar_color`. Omit an empty value.
- Optional `avatar` is PNG, JPEG, WebP, or GIF, max 256 KB, never SVG. Use a `data:image/<type>;base64,...` URL, or an absolute path inside the data folder. A relative path on the payload is not used.
- Optional `accent` is `#RRGGBB`. A value that fails the contrast check in a theme falls back to the theme accent. The result can list that theme under `identity.accent_fallback`.
- The avatar fields come as one set from the first source that sets any of them. An unknown shape or colour counts as set. An unknown shape draws initials. An unknown colour keeps a known shape and draws it in the default colour.

## Asks and buttons

One report has one `ask` and at most one input block (`decide`, `pick`, or `post`). Content blocks mix freely. `read` and `review` take no input block. `choose` requires a `pick` block. `approve` and `do` may take a `decide` block or a `post` block, or neither. `approve` with no input block needs `action`.

The footer is one status line, the reply chips, one composer, up to two quiet buttons, and one primary. There is one note. It covers every reply chip. `read` has no Discard. Discard is in the `…` menu and asks first.

Request changes focuses the composer and requires a note. The primary becomes "Send request". Cancel returns to the decision. None of these works the same way. Its primary becomes "Ask for new options". Ctrl+Enter or Cmd+Enter sends the current primary. It cannot send an approval while a request is being written.

A note is optional on every decision except `revise`. `revise` needs a note that says what should change. Reject and Skip send at once. A note already typed rides along. It is not required.

The primary stays off until the input block is complete: every row answered, one option picked, every manual platform marked posted or skipped, or at least one auto platform still included and valid. The status says what is missing. When every auto platform is left out or cannot be posted, the status points at Request changes or Reject.

Quoted labels below are the English ones. The window shows German unless `RS_LANG=en` was set before the desk started. Result values do not change with the language.

| `ask` | Input block | Primary | Other buttons | `decision` | Note |
| --- | --- | --- | --- | --- | --- |
| `read` | none | Got it | none | `read` | Optional. |
| `review` | none | Looks good | Request changes | `accept` or `revise` | `revise` needs a note. |
| `approve` | none, and `action` is set | Approve & post, Approve & send, or Approve & continue. `label` replaces that text. | Reject, Request changes | `approve`, `reject`, or `revise` | `revise` needs a note. Reject does not. |
| `approve` | `decide` | Send decisions | Request changes | `submit` or `revise` | `revise` needs a note. `submit` needs every row. |
| `approve` | `post`, every platform auto | Approve & post to the included platforms | Reject, Request changes | `approve`, `reject`, or `revise` | `revise` needs a note. `approve` lists each platform's `included` flag. At least one must be true, or send `reject`. |
| `do` | none | Done ✓. Sent ✓ when `action` is `send`. Posted ✓ when `action` is `post`. | Skip, Request changes | `done`, `skipped`, or `revise` | `revise` needs a note. Skip does not. |
| `do` | `decide` | Done | Request changes | `submit` or `revise` | `revise` needs a note. `submit` needs every row. |
| `do` | `post`, every platform manual | Posted ✓ | Request changes | `submit` or `revise` | `revise` needs a note. `submit` needs every platform `posted` or `skipped`. |
| `choose` | `pick` (required) | Choose, then the option name | None of these, unless `allow_none` is false | `choose`, or `revise` when None of these is offered | `revise` needs a note. With `allow_none` false the only decision is `choose`. |

With an input block, the report-level decision does not approve a row or a platform by itself.

- On `approve` plus `decide`, act only on a row whose `choice` is `approve`. `reject` means no. `later` means not now. You may ask again later. `submit` only means they finished the list.
- On `do` plus `decide`, they already did the work. Record `done`, `skipped`, and `later`. Do not do the work again.
- On `approve` plus `post`, post only platforms whose `included` is true. `reject` means post nothing. `revise` means change the draft and ask again.
- On `do` plus `post`, they posted the platforms whose `choice` is `posted` and skipped the others. Do not post those yourself.
- On `choose`, use the option id in `choice`. `revise` means none of the options. Offer new ones or ask. No option id is sent.

`reject` and `later` are never approval. `later` closes that row without execution.

A plain platform id, or a platform object with no `mode`, follows the ask. Under `approve` it is auto: you post after they approve. Under `do` it is manual: they post it and mark it. An explicit `mode` that disagrees with the ask is rejected. Do not mix auto and manual in one report.

## What the person sees

The title is the strongest line. Above it: avatar, name, and the `…` menu. Under the title: one line for the ask, then `why`. A due date and "Urgent" stay quiet. `urgent` or a due date of today or earlier is red.

With two or more open reports, a side inbox lists each one: avatar, title, bot name, a hint (urgent, due, or the kind of ask), and a dot while it is unread. The list is on the left when the window is at least 720 pixels wide, and a horizontal row of tabs under the header when it is narrower. One open report has no inbox. An arrival never replaces the report on screen. Ctrl+1 through Ctrl+9 (Cmd on macOS) opens the nth report. Alt+Up and Alt+Down move to the previous and next report.

Blocks sit in payload order. Prose stays in a narrow column. Tables and charts may use the width. A long report scrolls inside the page. The header and the footer stay.

One composer sits in the footer. It grows from one line to six. Reply chips sit in that same footer. Each chip quotes one anchor. The note applies to all of them together. Chips do not stack separate notes.

Reply anchors are a `decide` item, a `pick` option, a `post` platform, and each `##` or `###` heading in a `text` block. The reply button is visible. The R key does the same on a focused anchor. A second reply to the same anchor does nothing.

On a focused `decide` row, A, X, and L set approve, reject, and later. Under `do` those keys set done, skipped, and later. Focus then moves to the next unanswered row.

After a decision the next open report comes forward. The last one shows a short done state and the window may close itself.

## Blocks

Every block may set `id` (`^[a-z0-9-]{1,40}$`, unique in the report) and `title` (1–80 characters). Without `id` the block is `b1`, `b2`, and so on, from the top. `b1` is the first block. A reply uses that id. Give an input block an id you will recognise in the result.

### Content blocks

`text`. Required `md` (1–60000 characters). Optional `collapsed` (start folded behind the title) and `images` (at most 8). Markdown renders headings, lists, tables, callouts, code, and links. Raw HTML is shown as text. Callouts are `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, and `> [!CAUTION]`. An image in the markdown uses a key from `images`: `{key, path, alt}`. `key` matches `^[a-z0-9][a-z0-9_-]{0,31}$`. `path` is an absolute image path under a media root. `##` and `###` headings can be replied to. The first such heading is `section:0`, the next is `section:1`, in document order. A heading inside a code fence, a quote, a list, or a markdown table does not count. `#` and `####` do not count.

`stats`. One to four items: `{label, value, delta?, good?, note?, spark?}`. `label` is 1–32 characters. `value` is the number as shown, 1–40 characters, including the unit. `delta` is a number or a short signed text such as `+6.1 %`. `good` is `up` or `down` and says which direction is good. `spark` is 2 to 60 recent numbers, oldest first.

`table`. `columns` (1–12) and `rows` (1–200). A column is `{key, label, type?, align?, good?}`. `key` matches `^[a-z0-9_-]{1,32}$` and is unique. `type` is `text` (default), `number`, `money`, `percent`, `delta`, `status`, or `date`. Put the unit in `label`. `align` is `left`, `right`, or `center`. `good` (`up` or `down`) applies only to a `delta` column. A row is cells by column key. A missing cell or `null` is empty. A `text` cell is text or a number, at most 500 characters. A `number`, `money`, `percent`, or `delta` cell is a finite number or `null`. A `status` cell is `ok`, `warn`, `fail`, `open`, or `null`. A `date` cell is a real `YYYY-MM-DD` day or `null`. Optional `total` is one last bold row with the same cells. The page shows row lines, right-aligned numbers, a sticky header on a long table, and folds more than 10 rows behind "Show all". Status cells show an icon and a word. A delta is signed and coloured from `good`.

`chart`. `kind` is `bar` or `line`. `labels` is 1 to 60 strings. `series` is 1 to 4 of `{name, values}`. `values` has one finite number per label. Optional `unit` (1–12 characters) and `target` (a number, drawn as a line). `orientation` is `horizontal` or `vertical` and applies only to a bar chart. The page always adds a "Show data" table next to the chart.

`facts`. One to eight `{label, value}` pairs. `label` is 1–32 characters. `value` is 1–120.

`checks`. One to twenty `{label, state, detail?}`. `state` is `ok`, `warn`, `fail`, or `open`. `detail` is 1–120 characters. The page shows an icon and the word, not a bare box.

`media`. Required `path` and `alt`. `path` is an absolute image or video path under a media root. Images are png, jpg, jpeg, webp, or gif, at most 20 MB. Video is `.mp4` or `.webm`, at most 200 MB. `poster` is an image and is allowed only on a video.

`copy`. One to eight `{label, text}`. `label` is the button, 1–24 characters. `text` is the exact clipboard string, 1–5000 characters.

### Input blocks

`decide`. One to twelve items. Use it under `approve` (the bot's rows) or `do` (the person's rows). An item is `{id, title, meta?, md?, labels?, choices?, due?, url?, copy?}`. `id` matches `^[a-z0-9-]{1,40}$` and is unique in the block. `title` is 1–140 characters. `meta` is a short quiet line, 1–80. `md` is short markdown, 1–600. `due` is a real `YYYY-MM-DD` day. `url` is an http or https address the page can open. `copy` is up to four `{label, text}` pairs, same limits as a `copy` block.

Under `approve` the choices are `approve`, `reject`, and `later`. Under `do` they are `done`, `skipped`, and `later`. `choices` lists a subset, in that order. A choice from the other ask is rejected.

Under `approve` you may set `labels` on the block or on an item: `{approve?, reject?, later?}`. Each is 1–24 characters on one line. An item's label wins over the block's. The result value stays `approve`, `reject`, or `later`. The shown words must differ. A custom label that reads like another choice's default, in English or German, is rejected. Those defaults include Approve, Reject, Later, Defer, Freigeben, Ablehnen, Später, and Zurückstellen. Under `do`, `labels` are rejected. The person sees Done, Skip, and Later.

Nothing is preselected. The result lists every item, in payload order.

`pick`. Required under `choose`. Two to four options: `{id, name, md?, facts?}`. `id` matches `^[a-z0-9][a-z0-9_-]{0,31}$` and is unique. `name` is 1–48 characters. `md` is 1–600. `facts` is up to six `{label, value}` pairs (`label` 1–32, `value` 1–80). Repeat the same fact labels in the same order. `suggested` is an option id. It is only a mark, never preselected. `allow_none` defaults to true and offers "None of these". `false` hides it, and the result then cannot be `revise`.

`post`. A preview of one post. Required: `author` `{name, handle}` (`handle` has no `@` and no space), `text`, `hashtags` (stored without `#`; `[]` is allowed), and `platforms` (1 to 4).

Platforms are `x`, `linkedin`, `instagram`, and `facebook`. Use one form for the whole list: plain ids, or objects `{platform, mode?}`. Mixing the two forms is rejected. A duplicate platform is rejected. A plain id takes the ask's mode, as the table above says.

Optional: `persona`, `post_id`, `hashtag_mode` (`append` by default, or `none`), `first_comment`, `link` `{url, title, domain}` (https, shown only when there is no image; nothing is fetched), `notes` (your note above the previews), `flag` (words to avoid; a match is one quiet line and never blocks approval), `target` (`quote` or `reply`, with an https `url`, optional `excerpt` and `author`). `target.url` is not part of the composed text.

`image` and `video` cannot both be set. Each needs `path`, `alt`, and `ratio`. `video` also needs `poster`. Ratios: `1:1`, `4:5`, `3:4`, `9:16`, `1.91:1`, `16:9`. Paths are absolute and sit under a media root.

`variants.<platform>` is `{text?, hashtags?}` with at least one of the two. It replaces the shared text or hashtags for that platform only.

Limits, counted on the composed text:

- X: 25,000 weighted characters. The preview folds at 280 and adds "Long post (X Premium)". A URL that X recognizes weighs 23. A recognized emoji weighs 2. `target.url` is not counted.
- LinkedIn 3,000. Instagram 2,200. Facebook 63,206.
- A limit never blocks a manual platform. An over-limit auto platform cannot be included. The page leaves it out and says why.
- Auto Instagram allows five hashtags and needs an image or a video. Without them it cannot be included.
- A listed tag counts toward those five even when `hashtag_mode` is `none`, unless the text already contains that hashtag.
- A tag needs a letter or an underscore, so `#1` does not count.

Auto platforms start included. The person can leave one out. Manual platforms start unset. Each is Posted or Skip. Limits on a manual platform are advice.

## More payloads

A weekly read. No decision, no input block.

```json
{
  "schema": "grokbot-desk/payload@2",
  "bot": "ops-bot",
  "identity": {"name": "Ops Bot", "avatar_shape": "blob", "avatar_color": "blue"},
  "title": "Weekly operations: all systems normal",
  "created": "2026-10-18T08:00:00+02:00",
  "why": "Nothing needs a decision this week.",
  "ask": "read",
  "blocks": [
    {"type": "stats", "items": [
      {"label": "Uptime", "value": "99.98 %", "delta": "+0.02", "good": "up", "spark": [99.91, 99.95, 99.97, 99.98]},
      {"label": "Open tickets", "value": "7", "delta": -3, "good": "down"}
    ]},
    {"type": "chart", "title": "Tickets by week", "kind": "bar", "orientation": "vertical",
     "labels": ["W40", "W41", "W42", "W43"],
     "series": [{"name": "Open", "values": [12, 10, 10, 7]}]},
    {"type": "checks", "title": "Nightly checks", "items": [
      {"label": "Backups", "state": "ok", "detail": "7 of 7 nights"},
      {"label": "TLS certificates", "state": "warn", "detail": "one expires in 21 days"}
    ]},
    {"type": "table", "title": "Sites", "columns": [
      {"key": "site", "label": "Site"},
      {"key": "status", "label": "Status", "type": "status"}
    ], "rows": [
      {"site": "Shop", "status": "ok"},
      {"site": "Mail", "status": "warn"}
    ]}
  ]
}
```

A draft to review. The two `##` headings are `section:0` and `section:1` on block `guide`.

```json
{
  "schema": "grokbot-desk/payload@2",
  "bot": "writer-bot",
  "title": "Draft: onboarding guide for new staff",
  "created": "2026-10-18T10:15:00+02:00",
  "why": "Please read the draft before it goes to the team wiki.",
  "ask": "review",
  "blocks": [
    {"type": "text", "id": "guide", "md": "## First day\n\nYou get a laptop and a badge.\n\n## First week\n\n> [!NOTE]\n> Book a desk in the room planner."},
    {"type": "copy", "items": [{"label": "Wiki page", "text": "Handbook / Onboarding / Guide"}]}
  ]
}
```

One approval, no input block. `action` is required. `label` is the button text.

```json
{
  "schema": "grokbot-desk/payload@2",
  "bot": "deploy-bot",
  "title": "Deploy version 4.2.0 to production",
  "created": "2026-10-18T14:00:00+02:00",
  "why": "All tests passed on staging.",
  "ask": "approve",
  "action": "deploy",
  "label": "Deploy 4.2.0",
  "urgent": true,
  "blocks": [
    {"type": "facts", "items": [
      {"label": "Version", "value": "4.2.0"},
      {"label": "Window", "value": "today 17:00 to 18:00"}
    ]},
    {"type": "checks", "items": [
      {"label": "Unit tests", "state": "ok"},
      {"label": "Change ticket", "state": "open", "detail": "closes after the deploy"}
    ]}
  ]
}
```

They post it themselves. Plain platform ids under `do` are manual.

```json
{
  "schema": "grokbot-desk/payload@2",
  "bot": "social-bot",
  "title": "Post the autumn hours yourself",
  "created": "2026-10-18T11:00:00+02:00",
  "why": "The new hours start on Monday. Post this from the shop account.",
  "ask": "do",
  "blocks": [
    {"type": "post", "id": "hours",
     "author": {"name": "Example Bakery", "handle": "examplebakery"},
     "text": "From Monday we open at 6:30.",
     "hashtags": ["bakery"],
     "platforms": ["x", "linkedin"]}
  ]
}
```

You post after they approve. The same plain ids under `approve` are auto.

```json
{
  "schema": "grokbot-desk/payload@2",
  "bot": "social-bot",
  "title": "Post: autumn opening hours",
  "created": "2026-10-18T11:05:00+02:00",
  "why": "The new hours start on Monday.",
  "ask": "approve",
  "blocks": [
    {"type": "post", "id": "hours",
     "author": {"name": "Example Bakery", "handle": "examplebakery", "headline": "Bread since 1990"},
     "text": "From Monday we open at 6:30. Fresh rolls from the first minute.",
     "hashtags": ["bakery", "autumn"],
     "platforms": ["x", "linkedin"],
     "variants": {"linkedin": {"text": "From Monday our shop opens at 6:30. Thank you to the early team."}}}
  ]
}
```

One choice. `suggested` is a mark, not a selection.

```json
{
  "schema": "grokbot-desk/payload@2",
  "bot": "office-bot",
  "title": "Pick a date for the team lunch",
  "created": "2026-10-18T09:30:00+02:00",
  "why": "The restaurant holds the table until Wednesday.",
  "ask": "choose",
  "blocks": [
    {"type": "pick", "id": "date", "suggested": "thu", "options": [
      {"id": "thu", "name": "Thursday", "facts": [{"label": "People", "value": "9"}]},
      {"id": "fri", "name": "Friday", "facts": [{"label": "People", "value": "7"}]}
    ]}
  ]
}
```

Rows the person handles. No `labels`. Choices are `done`, `skipped`, and `later`.

```json
{
  "schema": "grokbot-desk/payload@2",
  "bot": "community-bot",
  "title": "Two replies to post yourself",
  "created": "2026-10-18T16:00:00+02:00",
  "ask": "do",
  "blocks": [
    {"type": "decide", "id": "replies", "items": [
      {"id": "hours", "title": "Question about opening hours", "url": "https://forum.example.org/t/4711",
       "copy": [{"label": "Copy reply", "text": "We open at 7 on weekdays."}]},
      {"id": "thanks", "title": "Thanks for the new feature", "choices": ["done", "skipped"]}
    ]}
  ]
}
```

## Result

`schema` is `grokbot-desk/result@2`. The file is written when the person submits, when the report is discarded, or when it expires. Open reports are not in this file.

| Field | Rule |
| --- | --- |
| `schema` | `grokbot-desk/result@2`. |
| `run_id` | The report id. |
| `bot` | The payload `bot`. |
| `status` | `submitted`, `cancelled`, or `expired`. |
| `created` | Local ISO 8601 with an offset, from the payload. |
| `decided` | Local ISO 8601 with an offset, to the second. |
| `duration_s` | Whole seconds from `created` to `decided`, at least 0. |
| `log` | Path of the action log for that day. |
| `data` | Present only when `status` is `submitted`. |
| `identity` | Present when the page could not use the accent, or when identity warnings were recorded. `name`, `accent_fallback`, and `warnings`. |

`python report_shell.py result` adds `data_dir` on stdout. The file does not contain `data_dir`.

`data` is `{decision, note, refs, blocks?}`.

- `decision` is one of the values in the table above.
- `note` is the composer text. It is `""` when they typed nothing. On `revise` it is required and non-blank. It is one note for the whole report, including every reply chip.
- `refs` is the chips at send time. Each is `{block, item, label}`. `block` is the block id. `item` is a `decide` item id, a `pick` option id, a `post` platform id, or `section:<n>` for the n-th `##` or `###` heading in that text block (`section:0` is the first). `label` is the quoted text, 1–120 characters. At most 20 refs. No duplicates. A target that is not in the payload is rejected.
- `blocks` is present only on the decision that answers the input block, and then it holds exactly that block's id.

Which decision carries `blocks`:

| Input | `ask` | Decision that carries `blocks` | Shape |
| --- | --- | --- | --- |
| `decide` | `approve` or `do` | `submit` | `{items: [{id, choice}, ...]}` in payload order, every row once |
| `pick` | `choose` | `choose` | `{choice: "<option id>"}` |
| `post` | `approve` | `approve` | `{platforms: [{platform, included}, ...]}` in payload order. `included` is true or false. At least one true. |
| `post` | `do` | `submit` | `{platforms: [{platform, choice}, ...]}`. `choice` is `posted` or `skipped`. Every platform once. |

`reject`, `revise`, `read`, `accept`, `done`, and `skipped` carry no `blocks`. A `revise` from None of these also carries no `blocks`.

Invoices, two rows, one chip on the toner row:

```json
{
  "schema": "grokbot-desk/result@2",
  "run_id": "20261018-090001-office-bot-ab12cd34ef56",
  "bot": "office-bot",
  "status": "submitted",
  "created": "2026-10-18T09:00:00+02:00",
  "decided": "2026-10-18T09:04:12+02:00",
  "duration_s": 252,
  "log": "log/2026-10-18.jsonl",
  "data": {
    "decision": "submit",
    "note": "Toner: ask for a cheaper vendor first.",
    "refs": [{"block": "invoices", "item": "toner", "label": "Toner, 132.90 EUR"}],
    "blocks": {
      "invoices": {"items": [
        {"id": "hosting", "choice": "approve"},
        {"id": "toner", "choice": "later"}
      ]}
    }
  }
}
```

Act on `hosting` / `approve` only. Do not pay the toner. The note applies to the toner chip.

An auto post they approved for X and left LinkedIn out:

```json
{
  "decision": "approve",
  "note": "",
  "refs": [],
  "blocks": {
    "hours": {"platforms": [
      {"platform": "x", "included": true},
      {"platform": "linkedin", "included": false}
    ]}
  }
}
```

Post to X only.

A manual post they marked themselves:

```json
{
  "decision": "submit",
  "note": "",
  "refs": [],
  "blocks": {
    "hours": {"platforms": [
      {"platform": "x", "choice": "posted"},
      {"platform": "linkedin", "choice": "skipped"}
    ]}
  }
}
```

They posted X. Do not post either platform yourself.

A pick:

```json
{"decision": "choose", "note": "", "refs": [], "blocks": {"date": {"choice": "thu"}}}
```

None of these:

```json
{"decision": "revise", "note": "Neither day works. Offer Wednesday.", "refs": []}
```

A section reply on a review. `section:1` is the second `##` or `###` heading:

```json
{
  "decision": "revise",
  "note": "Say who issues the badge.",
  "refs": [{"block": "guide", "item": "section:0", "label": "First day"}]
}
```

## Older reports on upgrade

When this version of the desk starts, every open report from before payload@2 expires once. The result `status` is `expired`. There is no `data`. The result's `log` field is the path of the action log. That log has an `expire` line whose detail is `{"reason": "upgrade"}`. Do not treat it as a decision. Ask again if the work still needs an answer. A second start does not write a second result.

A report that simply reaches `expires_minutes` is also `expired`, with no `reason` of `upgrade`. Same rule: record it, and ask again only if it still matters.

## Write a good report

- Title: the decision or the report, about 60 characters. The field allows 1–80.
- Why: one or two sentences, why this and why now. Do not restate the title, who acts, or which button to press.
- Labels: words the person would say ("Pay", "Don't pay"). They stay on the row. They never become the banner line.
- Write in the person's language. The window does not translate your text.
- For a `read` report: a few numbers, one chart or table, checks, then a short note. No wall of prose.
- One input block. If you need both a list and a post, send two reports.
- Show only what the decision needs.

## Errors and exit codes

On macOS, `./report-shell` skips `/usr/bin/python3`. It tries `python3`, then `python3.14` down to `python3.11`, also under `/opt/homebrew/bin` and `/usr/local/bin`. `REPORT_SHELL_PYTHON` replaces that search. It is the only executable tried. A bad value exits 1 even when a suitable interpreter is installed.

A command failure prints `report-shell: …` on stderr. A usage error prints a usage line and `grokbot-desk: error: …` for a root flag, or `grokbot-desk <command>: error: …` for a command such as `wait`. A crash prints a Python traceback.

JSON on stdout is ASCII-escaped. Error lines are UTF-8 when the stream encoding is UTF-8 (macOS, a Windows console, or Python started in UTF-8 mode). A stream that is not UTF-8, including a usual Windows pipe, stays ASCII.

| Exit | Meaning |
| --- | --- |
| 0 | The command worked. `wait` found a result. `check` printed `ok`. |
| 1 | Python is older than 3.11, or the command crashed. On macOS use `./report-shell`. |
| 2 | Invalid payload, arguments, or config. `check` found a problem and printed `pointer: message`. A non-numeric `port` in `config.json` exits 2 when the command uses that port. `--port` overrides it. A config file that is not valid JSON still exits 2. The message names the field when there is one. Fix that and send once. |
| 3 | The browser could not be started. On Windows that is usually no Edge or Chrome. On macOS a missing Edge or Chrome falls back to the default browser instead, so this exit means that launch failed. Tell the person. Do not open another browser. Do not send the report again. |
| 4 | The port is taken, or the desk did not start. `migrate` also uses 4 while a desk runs, a report is open, or another migrate runs. Run `status`. If the desk is up, do not send the report again. If it is down, try the command once more, then tell the person. Never pick another port yourself. |
| 5 | `wait` timed out. The report is still open. |
| 6 | Unknown report, or no result yet. `cancel` of a report that is already decided also uses 6. |
| 7 | `wait` reached expiry plus 2 minutes and nothing was written. `update` refused, the pull failed, git is missing, or a git step did not answer within 120 seconds. `migrate` refused because the new folder already holds files, or the move failed and nothing was moved. `doorbell setup` could not write its file. |

Do not loop on 3 or 4.

## Update and migrate

Update only when the person or a maintainer asks. Never pull on your own. You would run code nobody reviewed.

Releases are tags on `main` (`v1.0.0-beta.6`). `main` moves only on a release. `develop` is the branch for testing builds. `update` fast-forwards the clone on its current branch (`git pull --ff-only`). It prints `updated`, `from`, `to`, `branch`, and `next`.

- Check `branch` in that output. Do not claim "latest release" unless `branch` is `main`.
- `develop` is right only when the person asked for testing builds.
- If `branch` is anything else, tell the person. Never switch branches on your own.
- `updated` is true only when `HEAD` moved. Do not report an install when it is false.
- It exits 7, before the pull and without changing the checkout, when the folder is not a git clone, the checkout is a fixed tag, or there are local changes. Tell the person. Do not check out `main` yourself.
- Git missing, or a git step that does not answer within 120 seconds, also exits 7. A pull that fails or times out exits 7 too. That pull can already have fetched objects, and HEAD may already have moved.

`next` lists what is left. Today that is only: stop and migrate when the older data folder is in use. Do what `next` says and nothing else. That `stop` is the one exception under Safety.

The next `show` or `open` restarts an idle desk whose `version` is not this clone's, including a missing version. An equal version string keeps running, even when the files on disk changed. A desk with open reports keeps running until they are decided. `status` prints `version` (the running desk's version, or `null` when it is down).

On Windows the older folder `%LOCALAPPDATA%\spqrk-report-shell` stays in use until `migrate`. `paths` then includes `warning`. `show` can add `data_dir_warning`.

- Order: the person decides or discards every open report, you run `stop`, then `migrate`.
- `migrate` moves that folder to `%LOCALAPPDATA%\grokbot-desk`. It refuses, and changes nothing, while a desk runs or is starting, while a report is still open, while another migrate runs, or when the new folder already holds files.
- It rewrites `media_roots` in `config.json`, and media and identity paths in decided reports, and puts those files back if the move fails. A moved folder is never created again. A desk started with `RS_DATA_DIR` pointed at that folder after the move refuses to start.
- macOS has nothing to migrate. `RS_DATA_DIR` is never moved. `migrate` prints `migrated: false` and exits 0 when there is nothing to move.

## Safety

- Files stay on the machine. The desk listens only on `127.0.0.1`.
- The doorbell key lives in `doorbell.json` in the data folder. Never put it in a payload. Never write it in chat. The desk does not print it.
- Show only what the decision needs. A payload over 2 MB is rejected.
- Images (max 20 MB) and video (`.mp4` or `.webm`, max 200 MB) must sit under `media_roots`. The default roots are the person's Downloads folder and `<data folder>/media`.
- Do not stop the desk or close its window on your own. Run `stop` only when the person asks, or before `migrate` when they asked you to update.
- After the last decision the window may close itself. The desk stops itself after 30 minutes with no open report and no window connected.
- When the desk starts, it drops `runs`, `results`, and `log` files older than 30 days. An open report from before this version is kept until it is expired on that start, as above.
