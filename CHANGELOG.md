# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Desk Doorbell. One bot per computer, installed from the template in [doorbell/README.md](doorbell/README.md). The desk rings when a report is submitted, cancelled by the person (discarded on the page), or expired. It POSTs `{bot, bot_name, run_id, status, title}` to that bot's webhook. `bot_name` is the payload `identity.name` when the report gives one, otherwise the bot id. A name in the bot registry does not count. The doorbell messages that bot: `Desk: <title> is <status>. Read the result with report_shell.py result <run_id>.` A bot's own `cancel` never rings, even when the person asked the bot to cancel. Retries run for about 4 minutes on rate limits, server errors, and a failed connection. A ring can be lost when the desk stops, or when Grok Bot stays busy for minutes. Nothing wakes the bot then. At the start of every turn, doorbell on or off, the bot catches up with `results --since`. If a decision got no reaction, message the bot. The key is in `doorbell.json` in the data folder and is never printed.
- `doorbell` prints `doorbell` (`on` or `off`) and `host`. `on` means the address and key are saved. `doorbell setup` opens the setup page. Save writes the file and sends a test ring. When the save worked and the test failed, the page says `Saved. The test did not reach Grok Bot: …`. `doorbell setup --url URL --key-stdin` writes the file from stdin and does not ring. `doorbell test` rings once. `doorbell test --to NAME` sends that exact Grok Bot name (`{"status": "test", "bot_name": NAME}`). Without `--to` the body is `{"status": "test"}`. A plain test writes `Desk: doorbell test received.` in the doorbell's own chat. An addressed test sends `Desk: doorbell test.` to that bot. Exit 0 means accepted, 4 means failed, 2 means the doorbell is off. A failure includes `category`: `unreachable`, `refused` (check the address and the key), `busy` (a rate limit or a server error; try again in a minute), or `other`. `doorbell off` deletes the file. `status` and `doctor` print `doorbell` as `on` or `off`. Details: [guide](docs/GUIDE.md#doorbell).

### Changed

- **Breaking:** payload `notify` is still accepted and ignored. `show` warns and exits 0. Leave it out.
- Grok Bot does not wake a bot when a background command finishes. `wait RUN_ID --timeout 60` stays a foreground command for the current turn. Exit 5 means the report is still open. With the doorbell on, the bot ends the turn after one chat line. A chat message that starts with `Desk: ` is the wake. With the doorbell off, a decision after that wait needs a new chat message from the person. At the start of every turn the bot catches up with `results --since`.

### Removed

- The allow-listed result webhook. `config.json` no longer uses `webhook.enabled` or `webhook.allow_prefixes`. `GROKBOT_DESK_WEBHOOK_KEY` is not read. A leftover `webhook` object in `config.json` is ignored.

### Fixed

- `results --since` ignores fractional seconds. A cursor with milliseconds no longer misses a result decided earlier in that same second.

## [1.0.0-beta.3] - 2026-10-14

The last planned beta before 1.0. The desk is calmer, and you decide in one click.

### Added

- `update` fast-forwards this clone on its current branch and prints `updated`, `from`, `to`, `branch`, and `next`. It exits 7 when the folder is not a git clone, the checkout is a fixed tag, there are local changes, git is missing, or a git step does not answer within 120 seconds. A pull that fails or times out can still have fetched objects. Details: [guide](docs/GUIDE.md#update).
- `--help` lists every command, the root flags, and a typical flow. `<command> --help` lists that command's flags and does not repeat the flow.
- `status` prints `version`: the version of the desk that is running, or `null` when it is down.
- `migrate` (Windows) moves the older data folder to `%LOCALAPPDATA%\grokbot-desk`. Run `stop` first, with no report open. macOS has nothing to migrate. `RS_DATA_DIR` is never moved. Details: [guide](docs/GUIDE.md#migrate).
- `variants.<platform>` may set `text`, `hashtags`, or both. Image and video ratios add `3:4` and `9:16`.

### Changed

- After an update, the next `show` or `open` restarts an idle desk whose `version` is not this clone's, including a missing version. An equal version string keeps running. A desk with open reports keeps running until they are decided.
- Text such as `templates` and error messages is printed as written when the stream encoding is UTF-8 (macOS, a Windows console, or Python in UTF-8 mode). A stream that is not UTF-8, including a usual Windows pipe, stays ASCII. JSON output stays ASCII-escaped.
- **Breaking:** `check --all` prints `"templates"` (the ids it checked). It used to print `"template": "--all"`. A single check prints `"template"`.
- The report title is the strongest line. Above it: the bot's name, a small avatar, the open count while several reports wait, and the `…` menu. The task banner sits under the title. Long lists and documents scroll inside the report. The header and footer stay. Details: [task banner](docs/GUIDE.md#task-banner).
- The banner is one task line plus the why. Steps show only when they add a step of their own. Choice labels such as `Pay` stay on the buttons. Details: [task banner](docs/GUIDE.md#task-banner).
- A template `summary`, `intro`, `context`, or `notes` becomes the why only when the whole text fits and has no link. The cut prefers a word boundary. An unbroken run is split, and the ellipsis is not part of the 360 characters. Details: [task banner](docs/GUIDE.md#task-banner).
- Discard is in the `…` menu, behind a confirmation. An information-only report has no Discard. The footer is a status, up to two quiet alternatives, and one primary.
- German uses one approval verb, `Freigeben`. The default primary names the bot when the display name is at most 24 characters and is not the raw id.
- Times, due dates, and "today" use the machine's time zone. `RS_TZ` pins an IANA zone when zone data is available. Without it, Central European names and UTC names still work. Any other name falls back to the machine's zone, and the page is not pinned.
- **Breaking:** `approve-one` has no segmented choice. The footer is the decision, one click each. `Reject` sends at once and needs no reason. Details: [approve-one](templates/builtin/approve-one/README.md).
- `summary` is optional. A blank `summary` is still rejected. With `checks`, one line before the facts names warnings and failures.
- A person who acts sees `Posted ✓`, `Sent ✓`, or `Done ✓`, plus `Skip`. An explicit `post_yourself` says `Posted ✓` even when `action` is `send`. Without that explicit kind, `send` says `Sent ✓`. Information only is `Got it`.
- `pick-option` shows the question as the heading and leaves it out when it repeats the title. Nothing is preselected. The primary names the option and stays off until one is picked.
- `None of these` is on unless `allow_none` is false. It requires a note and sends `request_changes` with no `choice`. A pick is still `choice` and `note`.
- **Breaking:** a `decide-list` with any bot item uses `Send decisions` (`Send decision` for one item). The button sends the choices and approves nothing by itself. When every item is the person's, the footer is `Done`. Details: [decide-list](templates/builtin/decide-list/README.md).
- A list holds 1 to 12 items. Results stay `approve`, `reject`, and `defer`, or `done`, `skipped`, and `later` on a user item.
- **Breaking:** `show` rejects a label that repeats another choice of the same item, including a default such as `Reject` or `Ablehnen`. A user item cannot carry `labels`. `due` is `YYYY-MM-DD` and must be a real calendar day.
- The list heading reads `Items` (`Einträge`). When nothing was already handled, the list has no visible heading.
- `review-doc` can send `Request changes` from the section comments alone. Details: [review-doc](templates/builtin/review-doc/README.md).
- **Breaking:** the `review-doc` result is stricter. `approve` keeps `comment` empty and may still carry section comments. `request_changes` needs a non-blank overall comment, or at least one section comment.
- **Breaking:** an auto Instagram post allows 5 hashtags (the limit was 30). A manual post only advises. A listed tag still counts when `hashtag_mode` is `none`, unless the text already contains that hashtag.
- X allows 25,000 weighted characters and folds after 280, with a `Long post (X Premium)` note. A recognized emoji weighs 2. A URL that X recognizes weighs 23. `target.url` is not part of the text.
- **Breaking:** when every platform is manual there is no `Skip`. The primary stays off until one platform is marked posted, then reads `Posted ✓`. Post only auto platforms whose `per_platform` decision is `approved`. Details: [preview-post](templates/builtin/preview-post/README.md).
- A manual post is never blocked by a length limit. The line is advice. A blocked auto platform shows one recovery line.
- `review-doc` renders `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, and `[!CAUTION]` as a quiet note with a title. A callout copies nothing.
- **Breaking:** on Windows the older data folder stays in use until you run `migrate`. `paths` and `show` say so.
- `python report_shell.py --version` prints `grokbot-desk 1.0.0-beta.3`.

### Removed

- **Breaking:** the webhook variable `SPQRK_REPORT_SHELL_WEBHOOK_KEY`. Use `GROKBOT_DESK_WEBHOOK_KEY`.

### Fixed

- `check` on macOS no longer needs the Windows `py` launcher. `check`, including `check --visual`, runs its tools with the same Python. `RS_PYTHON` overrides that. On their own, without `RS_PYTHON`, the tools look for Python 3.11 or later (`py -3` on Windows; elsewhere `python3.14` down through `python3.11`, then `python3`, also under `/opt/homebrew/bin` and `/usr/local/bin`).
- Cancelling a change request returns focus to the button that opened it. On `preview-post`, Cancel returns to `Request changes`. A restored draft does not move focus into an unchosen choice or a comment just because the draft exists. When that draft is ready to send and focus is still on the page, the primary is focused. `pick-option` keeps the pick set aside by `None of these` in the draft, so Cancel after a reload brings it back.
- A failed Skip on `review-doc` puts the primary's result back, as `approve-one` does. A closed information-only note is left out of the layout and out of the result.

## [1.0.0-beta.2] - 2026-10-12

### Added

- macOS is supported. Its CI jobs are blocking, like the Windows ones. Tested on a real Mac (macOS 26, Apple silicon, Google Chrome). The README has a macOS setup section. `./report-shell` finds a versioned Python such as Homebrew's `python3.12`. Python 3.9 gets a clear message instead of a traceback.
- Every report opens with a tinted task banner above its title. It says what to do and who acts next, one line of steps, at most three sentences of why (the rest folded), and the effort and due date (`~3 min`, `due today 15:00`). A decided report keeps it, neutral, saying what happened. One calm colour per kind. Red only for `blocking` or a due date that is today or past. The banner holds no buttons. The calm checker allows its tint as the one status colour besides the accent.
- Optional payload field `task`: `{kind, steps, eta_min, due, why}`. `kind` is one of `post_yourself`, `approve_bot_acts`, `pick`, `fyi`, `review`, `blocking`. Without it the kind is derived from the template and its `actor`, so existing payloads work unchanged. A kind sets the matching actor when `data` leaves it out, and is rejected with a pointer when `data` contradicts it.
- With no report on screen while some wait, the window lists them (`Waiting for you`): bot, title, and the kind of task. A row opens its report.
- `wait` ends at the report's expiry plus 2 minutes at the latest and exits 7 when no result was written by then. `--until-expiry` waits up to that point (for a background waiter) and excludes `--timeout`. A report record without a readable expiry (from before 1.0.0-beta.2) keeps the old behaviour: only `--timeout` ends the wait.
- `preview-post` takes a mode per platform. `auto` is the default, so existing payloads work unchanged: the bot posts after `Approve & post`. `manual`: you post it yourself. The panel starts with `You post this yourself.` and copy buttons for the text, hashtags, comment, and the image (copied as a picture, plus `Show in folder`), then `Posted ✓`. The tab names the mode quietly (`X · manual`). A manual decision is `done` (posted) or `skipped` (not posted). `posted_manually` is not a result value.
- The `preview-post` result keeps `platforms` as the list the bot may post (auto and approved only) and adds `per_platform` with each platform's mode and decision (`approved`, `done`, `skipped`, `not_approved`, `changes_requested` with the comment as `note`).
- `decide-list` items take an optional `actor` (`bot` or `user`, default `bot`), an optional `content` (`post` or `reply`), and an optional `url`. User items use Done ✓ / Skip / Later, or Posted ✓ when `content` is a post or reply (`done` / `skipped` / `later`). `approve-one` and `review-doc` take an optional `actor` (`bot`, `user`, or `none`, default `bot`) and an optional `action` verb. Existing payloads keep their results. `decide-list` takes an optional `action` (`post`, `send`, `continue`) for the bot's verb and footer.
- Links in item text, review-doc Markdown, pick-option text, and `url` fields open in the system browser via `POST /open-url` (`RS.openUrl`). The server accepts only an http(s) address that appears in that report's payload.
- `review-doc` copies each code block and blockquote, and an optional `copy` list near the top. `pick-option` options take an optional `copy` string. Default review styling makes tables, bold, lists, and check states scannable.
- Copy an image as a picture: `POST /copy-image`, `RS.copyImage(id)`, and `<rs-copy media="…">` (macOS via AppKit; Windows via GDI+, no WebP).
- `preview-post` takes an optional `video` (`path` `.mp4` or `.webm` up to 200 MB, required `poster` image, `alt`, `ratio`) instead of `image`. The mockup shows the poster and plays the file inline. A manual platform copies the file path and can show the file in its folder. Instagram counts a video as media. Images stay at most 20 MB. Video is served in HTTP ranges.
- `preview-post` takes an optional `target` (`quote` or `reply`, with `url`, optional `excerpt` and `author`). X shows a quote card under the post, or a reply line and the parent card above the post. LinkedIn and Facebook show a reshare card. The quoted URL is not part of the text, so X does not count it. A manual platform can copy the link.
- `paths` prints the data directory in use and why. A legacy data directory stays in use until the new folder holds runs. Bots use the CLI (`result`, `wait`, `results --since`, `paths`) and never guess the directory.
- Optional `dedupe_key` and `dedupe_hours`. The same bot and key returns the open report, or a report submitted or cancelled within that many hours (`deduped: true` and `state`). An expired report never dedupes. `show` twice with the same key does not open a second report.
- `results --since` items include `title` and, when the decision is compact, `summary` (decide-list counts per choice, preview-post decisions per platform).
- `preview-post` `target.url` uses the `x-rs-url` keyword (`"https"`) with the same openable check as the link opener, and still a 2048-character limit. `decide-list` item URLs use `x-rs-url` as well and keep their hostname pattern. An `x-rs-exclusive` list must be non-empty strings. A nested value is a schema error at `/x-rs-exclusive`.
- Report summaries include `seq`, the order the report was registered. The strip uses it, including when several reports are already waiting at the first page load. A report saved without `seq` is given one when the store loads it, in `created` order, ahead of later registrations.

### Changed

- CI is split. pytest, the source lint, the Node unit files, and a browser smoke set block. The full browser suite (timing budgets, burst, pop-up timing) runs as an advisory step. The release gate is the full suite and screenshots on a real Windows machine and a Mac (CONTRIBUTING.md).
- Buttons follow the kind, from one table for the built-ins that have an actor: `Posted ✓` / `Skip` when you post it yourself, `Done ✓` / `Skip` when you do something else (`Sent ✓` when `action` is `send`; Done only when there is no specific content or action), `Approve & post` / `send` / `continue` when the bot acts, `Choose`, `Got it` alone for information (one collapsed note, no Request changes, no Discard), `Looks good` / `Changes` for a review. `Posted ✓` is for a manual platform, a decide-list item with `content` `post` or `reply`, or an explicit `task.kind` of `post_yourself`. A decide-list footer reads `Done` when every item is yours, and `Approve & continue` only when the bot acts next.
- A mixed report (a preview with auto and manual platforms, a list with your items and the bot's) gives each actor one banner line, you first, the bot by its display name: `You post: X` / `Inbox Agent posts after approval: LinkedIn`, or counted for a list (`You post: 2 replies` / `Inbox Agent sends after approval: 3 items`). The lines follow the ticks and choices (`Inbox Agent posts nothing: LinkedIn not ticked`). A platform that cannot be approved is left out of the plan from the start. The decided banner says what each side did (`You posted: X` / `Inbox Agent posts now: LinkedIn`). A supplied `task.steps` stays. Live updates do not replace it. A mixed preview's steps say, per actor, what is still open, then the footer as it reads now (`LinkedIn: tick Approve · X: copy, post, Posted ✓ · then Submit`). That two-platform line fits the 72-character measure. A longer list wraps. Its primary reads `Submit` while both act (`Approve & post` with only auto platforms ticked, `Posted ✓` with only manual ones), and the status splits the count (`1 approved · 1 posted`). The result is unchanged.
- Templates without an actor model keep their own buttons and may only set `review` or `blocking`. Templates get `RS.task` and `RS.cta(value)`. A `why` past 3 sentences or 360 characters warns on `show` and is folded. `due` is a calendar date or a browser-safe extended timestamp.
- `results --since` is inclusive (`>=`). A decision in the cursor's own second is no longer lost. Every answer prints `cursor` and `seen`. Pass them back as they came (`--since`, `--seen RUN_ID`) and nothing is listed twice.
- Several reports at once: the report on screen is never replaced by an arrival, touched or not. A new report becomes active only when nothing open is shown. One polite announcement per burst (`3 new reports from 2 bots`) instead of one toast per report. The same 30-second quiet gap covers bringing the window forward. The page collects for up to 10 seconds and announces once.
- The page receives at most the 12 newest open reports, by `created`. Within those, the avatar strip shows one avatar per bot with a count badge (`Inbox Agent, 3 reports`), in arrival order. Arrivals append and nothing jumps. A `created` stamp does not reorder that strip. A bot's avatar goes to its oldest open report. Again on the current one steps to its next. `Ctrl+1..9` and `Left`/`Right` work per bot. `n of m open` counts reports. After a decision the window goes to the same bot's next open report, wrapping inside that bot before the next bot.
- The window comes forward at most once per burst. A push that launches the window counts as the burst's bring-forward, and `show --focus` follows the server's `attention` answer instead of raising the window per report.
- Exactly one window. A launch stays pending for up to 20 seconds until its page connects (was 5), so a report arriving during a slow first browser start no longer opens a second window.
- A `created` stamp more than 2 minutes ahead is clamped to now, and `show` warns.
- A preview-post summary only names allowed outcomes: `x posted by you` or `x skipped` for a manual platform, and `linkedin approved` for an auto platform that was approved. A manual platform is never called approved. The summary is omitted when mode and decision disagree, the decision is unknown, `platforms` is not exactly the auto approvals, or an older result has no `per_platform`. Submit rejects an inconsistent preview-post result. Post only `auto` + `approved`. Do not treat the summary as permission to post.
- A reply without an author handle stays a reply. On X the parent card sits above the post, labelled with the handle, the author name, or "Replying to this post".
- A video keeps its poster image if the clip cannot be decoded or makes no progress for 8 seconds. The page then says the preview is unavailable and that the path can still be copied or the file shown in its folder. `preload="none"` leaves an untouched clip on its poster. Starting playback still reports a clip that cannot be decoded, and the frame has no retry button.
- `Range: bytes=-` is ignored. The media response is the whole file. `POST /reveal` only opens a media file that belongs to that report.
- `python report_shell.py --version` prints `grokbot-desk 1.0.0-beta.2`.

### Fixed

- An already read report is no longer rewritten on every window focus.
- The "sent" toast no longer lingers over the next report after a decision.
- A slow server start is no longer reported as "port is held by a foreign process".
- Browser-test timing on macOS. A local `.venv` is ignored by the source lint.
- A bot id such as `constructor` still shows its report.

## [1.0.0-beta.1] - 2026-10-10

First public beta of grokbot-desk.

### Added

- A small pop-up decision window. A bot sends a report, you read it, and you decide right there.
- An avatar strip at the top shows every open report. Switch between them with one click.
- Five built-in templates: approve one thing, decide a list, pick an option, review a document, preview a social post.
- Per-bot identity. Each bot has its own name, avatar shape, and colour.
- An app icon for the window, title bar, and taskbar.
- `python report_shell.py --version` prints the version (`grokbot-desk 1.0.0-beta.1`).
- Windows is supported. macOS is in beta.

[Unreleased]: https://github.com/realspqrk/grokbot-desk/compare/v1.0.0-beta.3...HEAD
[1.0.0-beta.3]: https://github.com/realspqrk/grokbot-desk/compare/v1.0.0-beta.2...v1.0.0-beta.3
[1.0.0-beta.2]: https://github.com/realspqrk/grokbot-desk/compare/v1.0.0-beta.1...v1.0.0-beta.2
[1.0.0-beta.1]: https://github.com/realspqrk/grokbot-desk/releases/tag/v1.0.0-beta.1
