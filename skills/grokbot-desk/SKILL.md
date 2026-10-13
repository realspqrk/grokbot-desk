---
name: grokbot-desk
description: Open a desk instead of answering in chat whenever the user should decide or should read a report. Use for a yes or no, a choice, a list of items, a draft or post to approve, and any status, results, weekly summary or research outcome. grokbot-desk is a local window on their computer. You send JSON, they act there, and you read the result.
---

# grokbot-desk

You send JSON. The user decides or reads it in a local window (a desk). You read the result JSON.

## Desk or chat?

Open a desk for any decision, approval, choice, list of items to decide, draft or post to approve, and any report (status, results, weekly summary, research outcome) longer than about five lines.

Chat only for small talk, a quick clarifying question, or a one-line acknowledgement. If you cannot run commands on their computer, say so and ask in chat.

## Write a good desk

- Title: the decision or the report, about 60 characters (the field allows 80).
- Why: one or two sentences, why this and why now. The banner holds at most three sentences and 360 characters.
- Pick the template whose buttons match the task. Use labels the user would say ("Pay", "Don't pay").
- Never restate who acts or which button to press. Never repeat the title.
- Write in the user's language. The window does not translate your text. Its own buttons are German unless `RS_LANG=en` was set before the server started.

`summary`, `intro`, `context` and `notes` become the why only when the whole text fits (three sentences, 360 characters) and has no link. The body then omits it. Longer text, or text with an `http` link, stays in the body. Label a link as information ("Open PDF").

The title leads. Above it, a quiet line has the bot avatar and name, the open count, and the `…` menu. Under the title, the banner is one task line (effort and due stay quiet) plus the why. Steps show only for your `task.steps`, a mixed list or preview, or a list's "decide each, then <button>". Discard is in the `…` menu, and missing on an information-only desk. The footer is a status, up to two quiet alternatives, and one primary.

Times use the machine's time zone. A due date of today or earlier, or `blocking`, turns the banner red.

## Templates

Use a built-in first (`python report_shell.py templates`). Read `templates/builtin/<id>/schema.json`, `result.schema.json` and `fixtures/golden.json`. See `docs/GUIDE.md`. `new <namespace>/<id>` only when none fits. A template that does not extend a built-in accepts only `review` and `blocking`.

| Template | Use for | Task kinds |
| --- | --- | --- |
| `approve-one` | One yes or no, or a short note with a few facts | `approve_bot_acts`, `post_yourself`, `fyi`, `blocking` |
| `pick-option` | One choice among 2 to 4 options | `pick`, `blocking` |
| `decide-list` | Decisions on 1 to 12 items | `approve_bot_acts`, `post_yourself`, `blocking` |
| `review-doc` | A draft to approve, or a report to read | `review`, `approve_bot_acts`, `post_yourself`, `fyi`, `blocking` |
| `preview-post` | One social post, approved per platform | `approve_bot_acts`, `post_yourself`, `blocking` |

Set `task.kind` from that row. A mismatch, or a kind that contradicts `data` (`fyi` with `"actor": "bot"`), is rejected. `blocking` keeps the buttons and turns the banner red. With no `task`: a pick is `pick`; bot work on a list or post is `approve_bot_acts`; work the user does entirely is `post_yourself`; a document is `review` unless `actor` or `action` says otherwise.

`show`, `wait`, `result`, `templates` and `new` need only Python. `check` also needs Node.js, playwright-core (`RS_PLAYWRIGHT_CORE`) and a supported browser. It uses `py -3` unless `RS_PYTHON` names Python. PowerShell: `$env:RS_PYTHON = (Get-Command python).Source`.

Shared buttons for `approve-one` and `review-doc`. The bot primary is "Approve & post", "Approve & send" or "Approve & continue" from `action` (`post`, `send`, or any other verb). There is no plain "Approve". The user primary is "Posted ✓" for `post_yourself`, "Sent ✓" when `action` is `send`, and "Done ✓" otherwise, plus "Skip". Results stay `done` or `skipped`. `fyi` or `actor` `none`: only "Got it", an optional collapsed note, no Request changes, no Discard. "Request changes" opens a comment and the primary becomes "Send request".

### approve-one

One footer click. `Reject`, `Request changes` (only with `allow_changes`) and the approve button are separate buttons. Not a segmented control. Reject sends at once. `approve_label` (1–24 characters) replaces the bot primary. At most six facts; a label may be 32 characters. With `checks`, a summary line is shown before the facts. Result `{decision, comment}`. `request_changes` needs a comment.

### pick-option

Two to four cards, nothing preselected. `suggested` is only a mark. The primary names the option and stays off until one is picked. `question` is omitted when it repeats the title. Repeat the same fact labels in the same order (label up to 32 characters).

`allow_none` defaults to true and offers "None of these". `false` hides it. That path requires a note and returns `{"decision":"request_changes","note":"..."}` with no `choice`. Offer new options or ask. A pick is `{"choice":"<id>","note":""}`.

### decide-list

1–12 items, one at a time, nothing preselected. Top-level and per-item `labels` are `{approve, reject, defer}`, 1–24 characters, no line break or extra space. An item's labels win. Results stay `approve`, `reject`, `defer`. User items take no `labels`. Their `choices` are `done`, `skipped`, `later`. Bot `choices` are `approve`, `reject`, `defer`.

`action` (`post`, `send`, `continue`) names only the bot's banner line. Any bot item: footer "Send decisions" ("Send decision" if there is one item). Every item the user's: footer "Done". The button sends the choices and approves nothing by itself. `content` `post` or `reply`, or kind `post_yourself`, shows "Posted ✓" instead of "Done ✓". Add `url` and `copy` when they reply. Do not act on a user item. A mix gives each side one banner line, the user first. Result: `items` of `{id, choice, note}` in order, plus `note`.

### review-doc

"Looks good" and "Request changes". With `action`, the primary follows the shared bot rule. Section comments may ride on `approve`. `request_changes` needs the overall comment or one section comment. `fyi` has no section comments. `doc` is markdown unless `format` is `text` (max 60,000 characters). Callouts: `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]`. Raw HTML stays text. Images need `images` keys. Result `{decision, comment, comments}`. `comment` is `""` on approve. A section comment is `{section, heading, comment}`.

### preview-post

Tabs `x`, `linkedin`, `instagram`, `facebook`. A plain id is `auto` (you post after approval). `{"platform":"x","mode":"manual"}` means the user posts it. Use `manual` where you cannot post. `variants.<platform>` is `{text?, hashtags?}` with at least one field. Hashtags omit `#`. Auto Instagram allows at most five hashtags and needs an image or a video. Ratios include `3:4` and `9:16` (`1:1`, `4:5`, `1.91:1`, `16:9` too). `video` replaces `image`. Optional `target` is a quote or reply. X ignores `target.url`. URLs in `text` weigh 23.

Limits: X 25,000 weighted (Premium long posts; the preview folds at 280, "Long post (X Premium)"), LinkedIn 3,000, Instagram 2,200, Facebook 63,206. A limit never blocks a manual platform. An over-limit `auto` platform cannot be approved. There is no "skip all". The primary stays off until one platform is ticked. An all-manual desk still offers "Request changes"; its primary reads "Posted ✓" once one is ticked. A mix reads "Submit", "Approve & post" or "Posted ✓" from what is ticked. On approval, an unticked manual platform is `skipped`.

Post only `platforms` whose `per_platform` decision is `approved`. Never post `manual`. `done` means the user posted it. `not_approved` and `skipped` mean stop. `changes_requested` carries the note. Read `per_platform`. A `results` summary is not permission to post.

## Report style

A status, weekly summary or research outcome is `review-doc` with `task.kind` `fyi`. In `data.doc`: a bold one-line TL;DR, a facts table, checks as `- [x]` and `- [ ]`, at most one callout, details last, about 400 words, no wall of prose.

```json
{"task":{"kind":"fyi","why":"Packaging is late. Stock lasts until Friday."},"data":{"doc":"**Sites ran normally; one delivery is late.**\n\n## Key figures\n\n| Measure | This week |\n|---|--:|\n| Orders shipped | 1,284 |\n\n## Checks\n\n- [x] Nightly backups finished\n- [ ] Supplier confirms the new date\n\n> [!WARNING]\n> Wednesday's packaging has not arrived.\n\n## Details\n\nThe autumn promotion ends Sunday."}}
```

On `fyi`, an omitted `actor` becomes `none`. A verdict uses `review` in this same shape.

## The flow

Run every command on the user's computer, in the clone folder. The window must open on their desktop. Do not run it on a headless VM, a container or a remote box.

On macOS, `/usr/bin/python3` is 3.9. Use `./report-shell` (Python 3.11+) or `python3.12`, forward slashes, and `export`. Default data directory: `~/Library/Application Support/grokbot-desk` (`RS_DATA_DIR` overrides it). `--focus` does nothing there. Without Edge or Chrome the page may open as a normal tab.

1. Write UTF-8 JSON. `created` is the current local time with its offset. `bot` is `^[a-z0-9-]{1,40}$`. `version` matches the template. Omit `run_id`. `expires_minutes` is 5–10080, default 240. Other `task` fields: `why`, `steps` (one line, max 140 characters, kept for the whole open desk), `eta_min` (1–120), `due` (`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` with optional seconds, milliseconds, and `Z` or `±HH:MM`). Other date forms are rejected. A long `task.why` warns on `show` (exit 0): the banner keeps the first three sentences, cuts at a word past 360 characters, and folds the rest.

```json
{"schema":"report-shell/payload@1","template":"decide-list","version":1,"bot":"office-bot","title":"Two invoices this week","created":"2026-10-10T09:00:00+02:00","task":{"kind":"approve_bot_acts","why":"Hosting is due Friday."},"data":{"labels":{"approve":"Pay","reject":"Don't pay","defer":"Next week"},"items":[{"id":"hosting","title":"Hosting, October, 89 EUR"},{"id":"toner","title":"Toner, 132.90 EUR","choices":["approve","defer"]}]}}
```

2. `python report_shell.py show <id> --data payload.json` returns `run_id`, `url`, `result_path` and `data_dir`. It opens the window, or delivers quietly if one is open. `--focus` only when the user asked. Desks share one window and an avatar strip. A new desk never covers the one on screen. A burst is announced once. Then `status`. If `window_alive` or `up` is false, no window is waiting. If your runtime kills child processes at the end of a command, ask the user to keep `python report_shell.py serve` running, then `show` again.

3. One chat line says a desk is waiting. Do not repeat the desk. Then:
   - `python report_shell.py wait RUN_ID --timeout 60`. Exit 0 is `submitted`, `cancelled` or `expired`.
   - Exit 5: still open. If a finished background task wakes you, hand it `python report_shell.py wait RUN_ID --until-expiry`. Background shells may not wake you, so do not rely on one. Otherwise use `results --since` next turn.
   - `wait` ends by itself at expiry plus 2 minutes. Exit 7 means nothing was written. Treat it as expired. A run from before 1.0.0-beta.2, or one with no readable expiry, has no such deadline, so only `--timeout` ends that wait.
   - Never use `--timeout 0` from a bot. `--until-expiry` together with `--timeout` is an error.

4. `python report_shell.py result RUN_ID`. Act only on it. `cancelled` or `expired`: do nothing, and ask in chat if it still matters. Exit 6: unknown run, or no result yet.

5. One chat line: topic + OK (for example "Invoices: hosting paid, toner next week, OK"). Start work the result asks for. Otherwise stop.

Catch up with `python report_shell.py results --since CURSOR [--bot BOT_ID] [--seen RUN_ID ...]`, oldest first. Pass `cursor` and `seen` back unchanged. `CURSOR` is ISO 8601 with an offset. Items have `run_id`, `bot`, `template`, `status`, `decided`, `result_path`, and `title` when known. `summary`, when present: decide-list counts (`2 approve, 1 defer`), a preview line (`x posted by you, linkedin approved`), an approve-one or review-doc word, or a pick id. "None of these" has no summary. Every answer includes `data_dir`. So does `paths`. Never guess the directory.

Exit 2: the payload is invalid. Fix the field the error names, then send it once more. Exit 3: no Edge or Chrome. Tell the user. Do not open another browser. Exit 4: port taken or the server did not start. `doctor` lists setup warnings. Retry once. Do not loop.

## Data directory, dedupe, time

`paths` prints the directory and why (`RS_DATA_DIR`, `legacy`, `default`), plus any unused older directory. On Windows, `spqrk-report-shell` moves once to `%LOCALAPPDATA%\grokbot-desk` at server start or `paths`, when the new folder is missing or empty and no server is using the old one (`reason`: `migrated`). A live server or a failed move leaves the old folder (`reason` and `warning`). `RS_DATA_DIR` is never moved.

The webhook stays off unless enabled with `GROKBOT_DESK_WEBHOOK_KEY` and an allow-listed `https` URL. Bots use `wait`. Startup drops `runs`, `results` and `log` files older than 30 days.

`dedupe_key` (1–120 printable ASCII) returns the open, submitted or cancelled run for that bot and key within `dedupe_hours` (1–168, default 24). `show` adds `deduped: true` and `state`. Expired runs do not match. `created` more than two minutes ahead is clamped to now, with a warning. Up to two minutes ahead stays.

## Identity

`name` is the name the user knows. Pass `avatarShape` and `avatarColor` as `avatar_shape` and `avatar_color`, and omit an empty value. Shapes: blob, squircle, pebble, teardrop, hex, tablet. Colours: blue, orange, yellow, magenta, red, violet, black, green, gray. Optional `avatar` is PNG, JPEG, WebP or GIF, max 256 KB, never SVG. Payload paths are relative to the template (`%RS_TEMPLATE%/...`). Registry paths are relative to the registry folder. Absolute paths must be inside the data directory. `media_roots` does not cover avatars. Optional `accent` is `#RRGGBB`. A bad value falls back and does not reject the desk. The payload wins over `bots.json`.

## Safety

No passwords, tokens, API keys, private keys or full card numbers. Files stay on the machine. The server listens only on `127.0.0.1`. Show only what the decision needs. A payload over 2 MB is rejected. Images (max 20 MB) and video (`.mp4` or `.webm`, max 200 MB) must be in the template folder or `media_roots`. Never invent a decision or treat a missing result as approval. On a `user` or `none` outcome, record it and stop. Do not stop the server or its window. It closes itself when idle.
