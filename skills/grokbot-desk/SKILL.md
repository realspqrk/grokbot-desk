---
name: grokbot-desk
description: "Opens a local grokbot-desk window instead of answering in chat when a person should decide or read a report. Use for a yes or no, an approval, a choice among options, a list of decisions, a draft, a social post, a status, a weekly summary, or a research outcome, including a short one. The bot sends a JSON payload, the person acts in the window, and the bot reads the result."
---

# grokbot-desk

grokbot-desk is a local window on the person's computer. You send a JSON payload, they decide or read it there, and you read the result JSON.

The desk is that window and the app behind it. A report is one thing you put on the desk. Command output calls a report a run. `run_id`, `open_runs`, and `runs/` are the field names.

Run every command in the clone folder, on their computer. The window must open on their desktop. Do not run it on a headless VM, a container, or a remote box. If you do not know where the clone folder is, ask the person. Do not search the disk for it.

## Report or chat?

Open a report for any decision, including a single yes or no (`approve-one`). Open a report for a choice, a list, a draft, or a social post.

A status, a weekly summary, or a research outcome is always a `review-doc` report with `task.kind` `fyi`, even when it is one line.

Chat only for small talk, a clarifying question, or the one-line acknowledgement. If you cannot run commands on their computer, say so and ask in chat.

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
[ ] Write the envelope (the next section) with data for one template
[ ] python report_shell.py show TEMPLATE --data payload.json
[ ] Keep that time with the run_id
[ ] python report_shell.py status
[ ] python report_shell.py doorbell
[ ] One chat line: a report is waiting
[ ] If the doorbell is off: python report_shell.py wait RUN_ID --timeout 60
[ ] On a new Desk: line for a run you have not handled: python report_shell.py result RUN_ID
[ ] One chat line: topic + OK (the decision, not finished work), or a short record
[ ] Do the work. Say it is done only after it succeeded
```

1. Record the current local time as ISO 8601 with an offset, before `show`. That stamp is your first `--since`. Write one UTF-8 envelope. `created` is the current local time with its offset. `bot` matches `^[a-z0-9-]{1,40}$`. `version` matches the template (every built-in is `1`). Omit `run_id`. The full example is the next section. Each template section shows the smallest `data` object.
2. `python report_shell.py show <template> --data payload.json` prints `run_id`, `url`, `result_path`, and `data_dir`. Keep the time from step 1 with that `run_id`.
   - The command opens the window, or delivers into the one that is already open. There is one desk window. Reports share it. A new report never covers the one on screen.
   - The page shows at most the 12 newest open reports, by `created`. Within those, the order is arrival order. `open_runs` in `status` counts every open report.
   - Use `--focus` only when the person asked. Then `python report_shell.py status`. If `up` is false, no desk is running. If `window_alive` is false and `open_runs` is not zero, run `open` once.
   - If your runtime kills child processes when a command ends, ask the person to keep `python report_shell.py serve` running, then `show` again.
3. One chat line says a report is waiting. Do not paste the report into chat. Check once: `python report_shell.py doorbell`. It prints `doorbell` (`on` or `off`) and `host`. It never prints the key.
   - If `doorbell` is `on`, end the turn. Do not run `wait`. A later chat message that starts with `Desk: ` is the wake. For a run you have not handled, run `python report_shell.py result RUN_ID` and answer, including a refusal, a note, or a comment. If that wake never comes, the next turn still starts with the catch-up above. That turn starts when the person messages you.
   - If `doorbell` is `off`, you may run `python report_shell.py wait RUN_ID --timeout 60` in this turn, in the foreground. Exit 0 means a result exists: read it and answer in this turn. Exit 5 means it is still open, so end the turn. A decision after that wait needs a new chat message from the person. That message is what wakes you. Never hand `wait` to a background task. Grok Bot does not wake you when a background command finishes. You may tell the person once that the Desk Doorbell makes waiting unnecessary, and that they should message you if a decision gets no reaction. The person installs it from https://x.ai/bot/Q_-PLlmHrV1l2h3Tk1ejJ and says "set me up" in its chat.
   - `wait` ends by itself at expiry plus 2 minutes. Exit 7 means nothing was written. Treat that as expired.
   - A report file with no readable expiry has no such deadline, so only `--timeout` ends that wait. Never use `--timeout 0`. Do not pass `--until-expiry`.
4. `python report_shell.py result RUN_ID` prints the result. Act only on that JSON. A missing result is not approval. Exit 6: unknown report, or no result yet.
5. For a `submitted` result, including a refusal, a note, or a comment, one chat line uses topic + OK to acknowledge the decision, not finished work. For example: "Invoices: hosting approved, toner next week, OK. Paying hosting now." Then do the work. Say the work is done only after it succeeded. No topic + OK for `cancelled` or `expired`. Record it, and ask in chat only if the task still needs an answer. On a `user` or `none` outcome, record it and stop. A `Desk:` wake for a run you have not handled follows these same rules. A second wake for a run you already handled gets no new action.

The catch-up command is at the start of this section. Open reports are not in `results`. The match is inclusive. Use the returned `cursor` as the next `--since`.

- Each item has `run_id`, `bot`, `template`, `status`, `decided`, `result_path`, and `title` when known.
- `summary`, when present, is decide-list counts (`2 approve, 1 defer`), a preview line (`x posted by you, linkedin approved`), an approve-one or review-doc word, or a pick id. "None of these" has no summary.
- A preview line is not permission to post. Read the result. Every answer includes `data_dir`.

Cancel a report only in two cases.

- The person asks you to drop it. The result status is `cancelled`. Your own `cancel` does not ring the doorbell, even when the person asked you to cancel. Record that and stop. Do not ask again. Do not send topic + OK.
- You are replacing your own open report with a newer version of the same thing. `cancel` it, then `show` the new one. Dedupe never updates a report. A cancelled report still matches its `dedupe_key` for `dedupe_hours`, so the new `show` needs a new key, or no key.

After `expired`, or a `cancelled` you did not cause: do not send topic + OK. Record it. Ask in chat only if the task still needs an answer.

## Payload rules

`show --data` takes a full envelope, or only the `data` object. For a built-in, data alone fills the envelope with that template's German title and the bot id `operations-agent`. Send the full envelope.

```json
{
  "schema": "report-shell/payload@1",
  "template": "decide-list",
  "version": 1,
  "bot": "office-bot",
  "identity": {"name": "Office Bot", "avatar_shape": "blob", "avatar_color": "orange"},
  "title": "Two invoices this week",
  "created": "2026-10-10T09:00:00+02:00",
  "task": {"kind": "approve_bot_acts", "why": "Hosting is due Friday."},
  "data": {
    "labels": {"approve": "Pay", "reject": "Don't pay", "defer": "Next week"},
    "items": [
      {"id": "hosting", "title": "Hosting, October, 89 EUR"},
      {"id": "toner", "title": "Toner, 132.90 EUR", "choices": ["approve", "defer"]}
    ]
  }
}
```

Required: `schema` (`report-shell/payload@1`), `template`, `version` (must equal the template), `bot`, `title` (1–80), `created`, `data`.

Optional: `expires_minutes`, `task`, `identity`, `dedupe_key`, `dedupe_hours`, `run_id`, `notify`. Any other top-level field is rejected.

- `expires_minutes` is an integer from 5 to 10080. The default is 240.
- Leave `notify` out. It is still accepted and ignored. `show` warns. The desk rings the Desk Doorbell, set up once per computer.
- `created` is ISO 8601 with an offset. More than two minutes ahead is clamped to now, with a warning. Up to two minutes ahead stays.
- `task`, when present, is `{kind, steps?, eta_min?, due?, why?}`. `kind` is required inside it. `steps` is one line of 1–140 characters and stays for the whole open report. `eta_min` is an integer from 1 to 120. `why` is a non-empty string.
- `task.due` is `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM` with optional seconds and optional fractional seconds, then a mandatory `Z` or `±HH:MM`. Milliseconds require seconds. A time with no suffix is rejected. Other date forms are rejected.
- `dedupe_key` (1–120 printable ASCII) returns the existing report for that bot and key instead of a new one. An open report always matches. A submitted or cancelled one matches when it was decided within `dedupe_hours` (1–168, default 24). Expired reports do not match.
- `dedupe_hours` without `dedupe_key` is rejected. `show` adds `deduped: true` and `state`. When `state` is not `open`, no new window opens: read `result` for that `run_id`.
- Dedupe never updates a report. A new title or new data needs a new key.

`identity` is optional and sits on the envelope, never as loose top-level fields.

- `name` is the name the person knows (1–40 characters). Set it to this bot's exact name in Grok Bot. The doorbell messages `bot_name`, which is `identity.name` when the payload gives one, otherwise the bot id. A name in the bot registry does not count. In the banner and on the default primary, a name that is the raw bot id, or longer than 24 characters, reads as "the bot". The header still shows the name.
- Pass `avatarShape` and `avatarColor` as `avatar_shape` and `avatar_color`. Omit an empty value.
- Shapes: `blob`, `squircle`, `pebble`, `hex`, `teardrop`, `tablet`. Colours: `blue`, `orange`, `yellow`, `magenta`, `red`, `violet`, `black`, `green`, `gray`.
- Optional `avatar` is PNG, JPEG, WebP, or GIF, max 256 KB, never SVG. A payload path is relative to the template (`%RS_TEMPLATE%/...`). A registry path is relative to the registry folder. An absolute path must sit inside the data directory. `media_roots` does not cover avatars.
- Optional `accent` is `#RRGGBB`. A bad value does not reject the report.
- The payload wins over `bots.json`. `name` and `accent` resolve per field. A bad `name` or `accent` is skipped and the next source is used.
- The avatar fields come as one set from the first source that sets any of them. An unknown shape or colour counts as set, and a later source is not used. An unknown shape draws initials, unless this source also has a usable image. An unknown colour keeps a known shape and draws it in the default colour. With no shape and no usable image, the page draws initials. An avatar file that cannot be read does not count as set, so a registry image can still apply. Inside a set, an image wins over a shape and colour, which win over initials.

## Choose a template

Use a built-in first (`python report_shell.py templates`). The template sections below are enough for the built-ins. `new <namespace>/<id>` only when none of these fits. Building that template is `docs/GUIDE.md` in the clone. A template that does not extend a built-in accepts only `review` and `blocking` and keeps its own buttons.

| Template | Use for | `task.kind` |
| --- | --- | --- |
| `approve-one` | One yes or no, or a short note with a few facts | `approve_bot_acts`, `post_yourself`, `fyi`, `blocking` |
| `pick-option` | One choice among 2 to 4 options | `pick`, `blocking` |
| `decide-list` | Decisions on 1 to 12 items | `approve_bot_acts`, `post_yourself`, `blocking` |
| `review-doc` | A draft to approve, or a report to read | `review`, `approve_bot_acts`, `post_yourself`, `fyi`, `blocking` |
| `preview-post` | One social post, approved per platform | `approve_bot_acts`, `post_yourself`, `blocking` |

Set `task.kind` from that row. A kind the template cannot show, or a kind that contradicts `data` (`fyi` with `"actor": "bot"`), is rejected. `blocking` keeps the buttons and turns the banner red.

With no `task`: a pick is `pick`. A list or post that is entirely the person's is `post_yourself`, otherwise `approve_bot_acts`. A document is `review` unless `actor` or `action` says otherwise (`none` is `fyi`, `user` is `post_yourself`, an `action` on a document is `approve_bot_acts`).

## Write a good report

- Title: the decision or the report, about 60 characters. The field allows 1–80.
- Why: one or two sentences, why this and why now.
- The banner holds at most three sentences and 360 characters. A longer `task.why` warns on `show` and still exits 0. The banner keeps the first three sentences and folds the rest. Past 360 characters it prefers a word boundary. An unbroken run is split inside the word. The 360 characters do not include the ellipsis.
- A line break ends a sentence. German abbreviations (`z. B.`, `ca.`, `Nr.`), ordinals, and dates (`15.`, `31.12.`) do not. `...`, `…`, and a year from 1900 through 2099 still do. Any other number, and a version (`2.4.`), stays in the same sentence.
- Labels: words the person would say ("Pay", "Don't pay"). They stay on the buttons. They never become the banner line.
- Do not restate the title, who acts, or which button to press.
- Write in the person's language. The window does not translate your text.
- Quoted labels in this file are the English ones. The window shows German unless `RS_LANG=en` was set before the desk started. Result values (`approve`, `done`, and the rest) do not change with the language.

`summary`, `intro`, `context`, and `notes` become the why only when the whole text fits the why limits above and has no `http` link. The body then omits that text. Longer text, or text with a link, stays in the body. Label a link as information.

What the person sees:

- The title is the strongest line. Above it: avatar, name, the open count while several reports wait, and the `…` menu.
- Under the title: one task line (effort and due stay quiet) plus the why.
- Steps show for your `task.steps`, a list of two or more bot items, an all-user list, a list of replies, a mixed list, or a mixed preview. The line names the footer's current label. An all-user list says to do or skip each item. Replies say to post or skip each reply. A bot list or a mixed list says to decide each item. A mixed preview says to review the platforms.
- Discard is in `…`, behind a confirmation, and missing on an information-only report.
- The footer is a status, up to two quiet alternatives, and one primary.
- A short report keeps the footer directly under its content. A long list or document scrolls inside the report. The header and the footer stay.

Times use the machine's time zone. `RS_TZ` pins an IANA zone when this Python has that zone's data. Without that data, a Central European name such as `Europe/Vienna`, and a UTC name, still work. Any other name falls back to the machine's zone, and the page is not pinned. A due date of today or earlier, or `blocking`, turns the banner red.

## Templates

`approve-one` and `review-doc` share the actor buttons. There is no plain "Approve".

- For the bot, the primary is "Approve & post", "Approve & send", or "Approve & continue" from `action` (`post`, `send`, or any other verb).
- For the person, an explicit `task.kind` of `post_yourself` uses "Posted ✓", including when `action` is `send`.
- Without that explicit kind, `action` `send` uses "Sent ✓". Any other action by the person uses "Done ✓". A kind the desk inferred from `actor` `user` follows this rule, so it can say "Sent ✓" or "Done ✓".
- The other button is "Skip". Those results stay `done` or `skipped`.
- Information only (`fyi` or `actor` `none`): only "Got it" and an optional collapsed note. No Request changes. No Discard. The result is `acknowledged`. `comment` is that note only when the note was open. A closed note sends `""`.
- Request changes opens a comment and the primary becomes "Send request". Cancel returns to the decision. On `approve-one` the comment is included only while that field is open. On `review-doc`, section comments can carry the request. An empty overall comment stays collapsed while section comments remain, unless the person opens it; an overall comment that already has text is shown. On `approve-one` it is offered for a bot or the person, and only with `allow_changes`. Never on an information-only report. An information-only `review-doc` sends only `acknowledged`.

### approve-one

- `summary` is optional. A blank one is rejected. Without it, put the question in `task.why`.
- One footer click. Reject, Request changes, and the approve button are separate buttons.
- Reject sends at once and needs no reason.
- `approve_label` (1–24 characters) leads the approval banner and replaces the bot primary.
- At most six facts. A fact label may be 32 characters.
- Each check is `{label, state, detail?}`. `state` is `ok`, `warn`, or `fail`.
- With `checks`, a line before the facts names warnings and failures.
- Result `{decision, comment}`. `request_changes` needs a comment.
- `decision` is `approve`, `reject`, `request_changes`, `done`, `skipped`, or `acknowledged`.

```json
{"checks": [{"label": "Tests", "state": "ok", "detail": "214 passed"}]}
```

### pick-option

- `question` is required. It is the heading. It is left out of the body when it only repeats the title.
- Two to four cards, nothing preselected.
- Each option is `{id, name}`. `name` is the card title (1–48 characters). `id` matches `^[a-z0-9][a-z0-9_-]{0,31}$`. Every `id` is different.
- `suggested` is an option id. It is only a mark, never preselected.
- The primary names the option and stays off until one is picked.
- Repeat the same fact labels in the same order. A label may be 32 characters.
- Optional `summary`, `copy` (one string), and up to six `facts`.
- `allow_none` defaults to true and offers "None of these". `false` hides it.
- "None of these" requires a note and returns `{"decision": "request_changes", "note": "..."}` with no `choice`. The decided banner says new options were requested, including when that report is opened again. Offer new options or ask.
- A pick is `{"choice": "<id>", "note": ""}`.

```json
{"question": "Which delivery slot?", "suggested": "thu", "options": [{"id": "tue", "name": "Tuesday morning"}, {"id": "thu", "name": "Thursday afternoon"}]}
```

### decide-list

- 1–12 items, one at a time, nothing preselected.
- Every `id` matches `^[a-z0-9-]{1,40}$` and is unique.
- Top-level and per-item `labels` are `{approve, reject, defer}`, 1–24 characters, no line break and no extra space at the ends. An item's labels win.
- Results for a bot item stay `approve`, `reject`, `defer`.
- A user item takes no `labels`. Its `choices` are `done`, `skipped`, `later`. A choice from the other side is rejected.
- A label that repeats another choice of the same item is rejected at `show`. That includes another of its labels, the top-level label, or a default in either language (`Approve`, `Reject`, `Defer`, `Freigeben`, `Ablehnen`, `Zurückstellen`). The error points at that `labels` entry.
- An item `due` is `YYYY-MM-DD` and must be a real calendar day. `2026-02-31` is rejected.
- A bot list's banner is "Make your decisions, then <bot> continues" (`action` `post` says "posts", `send` says "sends"; one item says "decision").
- Any bot item: footer "Send decisions" ("Send decision" for one item). The button sends the choices and approves nothing by itself.
- Every item the person's: the footer reads "Done". On an item, `content` `post` or `reply`, or an explicit kind `post_yourself`, shows "Posted ✓" on that item's done choice instead of "Done ✓". The footer stays "Done".
- Add `url` and `copy` when they reply. Do not act on a user item.
- A mix gives each side one banner line, the person first, and the footer stays "Send decisions".
- Result: `items` of `{id, choice, note}` in payload order, plus `note`.
- `copy` is a list of `{label, text}`. `label` names the copy button. `labels` is only for bot choices.

```json
{"items": [{"id": "hosting", "title": "Hosting, October, 89 EUR", "due": "2026-10-16"}]}
```

One item inside `items`, a reply the person posts:

```json
{"id": "r1", "title": "Reply to a question about opening hours", "actor": "user", "content": "reply", "url": "https://example.com/post/1", "copy": [{"label": "Reply", "text": "We open at 7 on weekdays."}]}
```

### review-doc

- Without `action`, the buttons are "Looks good" and "Request changes". With `action`, the primary follows the shared bot rule.
- Section comments may ride on `approve`. `request_changes` needs the overall comment or at least one section comment. When section comments already give a reason, the overall comment stays collapsed.
- `fyi` has no section comments.
- `doc` is markdown unless `format` is `text` (1–60,000 characters).
- Callouts: `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]`. Raw HTML stays text.
- An image needs an `images` key (`{key, path, alt}`). Anything else is a placeholder.
- Result `{decision, comment, comments}`. On `approve`, `comment` is `""` and `comments` may still be present.
- A section comment is `{section, heading, comment}` with a non-blank `comment`.
- `decision` is `approve`, `request_changes`, `done`, `skipped`, or `acknowledged`.
- A status, weekly summary, or research outcome uses this template with `task.kind` `fyi`. In `data.doc`: a bold one-line summary, a facts table, checks as `- [x]` and `- [ ]`, at most one callout, details last, about 400 words, no wall of prose. Only a bold paragraph in the lead moves ahead of `copy` texts. A bold word later stays put. On `fyi`, an omitted `actor` becomes `none`. That report is "Got it" only. A closed note sends `comment` `""`. A verdict uses `review` in this same shape.

```json
{"doc": "**Sites ran normally.** One delivery is late."}
```

### preview-post

Required: `author` `{name, handle}` (no `@`), `text`, `hashtags` (omit `#`; `[]` is allowed), and `platforms`.

- Tabs: `x`, `linkedin`, `instagram`, `facebook`.
- A list of plain ids is all `auto` (you post after approval).
- A list of objects uses `{platform, mode}` on every platform. `mode` is optional and defaults to `auto`. Mixing plain ids and objects is rejected.
- `manual` means the person posts it.
- `variants.<platform>` is `{text?, hashtags?}` with at least one field.
- `image` and `video` cannot both be set. `video` (`.mp4` or `.webm`, poster required) replaces `image`.
- Ratios: `1:1`, `4:5`, `3:4`, `9:16`, `1.91:1`, `16:9`.
- Optional `target` is `quote` or `reply` (`url` is `https`, at most 2048 characters). X ignores `target.url`.

Limits:

- X: 25,000 weighted characters. The preview folds at 280 (at a word when it can) and adds "Long post (X Premium)". A URL that X recognizes weighs 23. Any other address counts as written.
- LinkedIn 3,000. Instagram 2,200. Facebook 63,206.
- A limit never blocks a manual platform. An over-limit `auto` platform cannot be approved.
- Auto Instagram allows five hashtags and needs an image or a video. Without them it cannot be approved.
- A listed tag counts toward those five even when `hashtag_mode` is `none` (the default is `append`), unless the text already contains that hashtag.
- A tag needs a letter or an underscore, so `#1` does not count. A `#` inside a URL, or after a slash, does not count.
- A `flag` match is one quiet style-note line. It never blocks approval.
- On X the fold prefers a word boundary (an unbroken word longer than the fold is split) and never splits a URL or a recognized emoji. The counter reads against 280 until the post is longer, then against 25,000.
- When every platform is manual, the banner says "Post it yourself" once. Panels and tabs do not repeat it. On a mix, a manual tab keeps ` · manual`.
- When nothing can be approved, the status says to request changes. The primary stays off.

Footer and result:

- There is no "skip all". The primary stays off until one platform is ticked.
- An all-manual report still offers "Request changes". Its primary reads "Posted ✓" once one is ticked.
- A mixed footer's label is "Send response" while both sides can still be ticked (before anything is ticked, or when both are), "Approve & post" when only auto platforms are ticked, and "Posted ✓" when only manual ones are.
- An unticked manual platform is `skipped`.
- Post only platforms whose `per_platform` decision is `approved` and whose mode is `auto`. Never post `manual`.
- `done` means the person posted it. `not_approved` and `skipped` mean stop. `changes_requested` carries the note.
- `platforms` on an approval lists only the auto approvals. On `request_changes` that list is empty and `comment` is required.
- Read `per_platform`. A `results` summary is not permission to post.

```json
{"author": {"name": "Linden Bakery", "handle": "linden"}, "text": "Autumn loaves are out at 7.", "hashtags": [], "platforms": [{"platform": "x", "mode": "manual"}, {"platform": "linkedin", "mode": "auto"}]}
```

## Errors and exit codes

On macOS, `./report-shell` skips `/usr/bin/python3`. It tries `python3`, then `python3.14` down to `python3.11`, also under `/opt/homebrew/bin` and `/usr/local/bin`. `REPORT_SHELL_PYTHON` replaces that search. It is the only executable tried. A bad value exits 1 even when a suitable interpreter is installed.

A command failure prints `report-shell: …` on stderr. A usage error prints a usage line and `grokbot-desk: error: …` for a root flag, or `grokbot-desk <command>: error: …` for a command such as `wait`. A crash prints a Python traceback.

JSON on stdout is ASCII-escaped. Text such as `templates` and error messages is UTF-8 when the stream encoding is UTF-8 (macOS, a Windows console, or Python started in UTF-8 mode). A stream that is not UTF-8, including a usual Windows pipe, stays ASCII.

| Exit | Meaning |
| --- | --- |
| 0 | The command worked. `wait` found a result. |
| 1 | Python is older than 3.11, or the command crashed. On macOS use `./report-shell`. |
| 2 | Invalid payload, arguments, or config. A non-numeric `port` in `config.json` exits 2 when the command uses that port. `--port` overrides it. A config file that is not valid JSON still exits 2. The message names the field when there is one. Fix that and send once. |
| 3 | The browser could not be started. On Windows that is usually no Edge or Chrome. On macOS a missing Edge or Chrome falls back to the default browser instead, so this exit means that launch failed. Tell the person. Do not open another browser. Do not send the report again. |
| 4 | The port is taken, or the desk did not start. `migrate` also uses 4 while a desk runs, a report is open, or another migrate runs. Run `status`. If the desk is up, do not send the report again. If it is down, try the command once more, then tell the person. Never pick another port yourself. |
| 5 | `wait` timed out. The report is still open. |
| 6 | Unknown report, or no result yet. `cancel` of a report that is already decided also uses 6. |
| 7 | `wait` reached expiry plus 2 minutes and nothing was written. `update` refused, the pull failed, git is missing, or a git step did not answer within 120 seconds. `migrate` refused because the new folder already holds files, or the move failed and nothing was moved. `check` or `new` failed, or the template registry is broken. |

Do not loop on 3 or 4.

## Update and migrate

Update only when the person or a maintainer asks. Never pull on your own. You would run code nobody reviewed.

Releases are tags on `main` (`v1.0.0-beta.4`). `main` moves only on a release. `develop` is the branch for testing builds. `update` fast-forwards the clone on its current branch (`git pull --ff-only`). It prints `updated`, `from`, `to`, `branch`, and `next`.

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
- Images (max 20 MB) and video (`.mp4` or `.webm`, max 200 MB) must sit in the template folder or in `media_roots`.
- Do not stop the desk or close its window on your own. Run `stop` only when the person asks, or before `migrate` when they asked you to update.
- After the last decision the window may close itself. The desk stops itself after 30 minutes with no open report and no window connected.
- When the desk starts, it drops `runs`, `results`, and `log` files older than 30 days.
