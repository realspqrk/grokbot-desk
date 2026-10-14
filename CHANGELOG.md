# Changelog

## Unreleased

- **Updates take effect on the next `show`.** A desk still running the
  older version is restarted when no report is open. With open reports it
  keeps running until they are decided.
- **Umlauts in text output.** `templates` and error messages print text as
  is on macOS and in a Windows console. Output piped on Windows stays ASCII;
  JSON output is unchanged.
- **`check` on macOS.** It no longer needs the Windows `py` launcher. The
  browser tools use the same Python as `check`; on their own they look for
  Python 3.11 or later like `report-shell` does.
- **`check --all`** names the checked templates (`"templates": [...]`)
  instead of `"template": "--all"`.

## 1.0.0-beta.3 (2026-10-13)

This is the release candidate for 1.0. The desk is calmer, and you decide in one click.

- **Desk layout and wording.** The report title is the strongest line. Above
  it, a quiet line holds the bot's name, a small avatar and, while several
  reports wait, the open count (`1 von 2 offen`, or `1 of 2 open`), next to
  the `…` menu. The task banner sits under the title.
- The banner is one line (what to do, the effort, the due date) and the why.
  Steps show only when they add something: your own `task.steps`, a mixed
  preview (`Review the platforms, then Send response`), several items the
  bot will act on (`Decide each item, then Send decisions`), or a list that
  is entirely yours (`Do or skip each item, then press Done`; replies say
  `Post or skip each reply`). The button in that line is the footer's
  current label.
- An `approve_label` leads the line for one approval (`Approve deploy, then
  Release Bot continues`). A list the bot will act on says `Make your
  decisions, then Release Bot continues` (one item: `Make your decision`).
  `action` `post` says "posts" and `send` says "sends". A choice label such
  as `Pay` stays on the buttons.
- A template `summary`, `intro`, `context` or `notes` becomes the why only
  when the whole text fits (three sentences, 360 characters) and has no
  link. Otherwise it stays in the report. Line breaks are kept. German
  abbreviations (`z. B.`, `ca.`, `Nr.`), ordinals and dates (`15.`,
  `31.12.`) do not end a sentence. `...`, `…` and a year from 1900 through
  2099 (`2026.`) still do. A cut falls between words. Any other number, and
  a version (`2.4.`), stays in the same sentence.
- Discard report is in the `…` menu, behind the same confirmation. An
  information-only report has no Discard. The footer holds the status, up
  to two quiet alternatives and the one primary. A short report keeps the
  footer under the content. A long one keeps it at the window bottom.
- German uses one approval verb, `Freigeben`. English says bot (`Approve
  and the bot continues`). The default primary names the bot when the
  display name is at most 24 characters and is not the raw id (`An Release
  Bot senden`). Otherwise it stays `An Bot senden`.
- Times, due dates and "today" use the machine's time zone. `RS_TZ` pins a
  zone. When the server falls back to that zone, the page uses it too.

- **Decisions.** Breaking: `approve-one` has no segmented choice. The footer
  is the decision, one click each. The primary approves (`Approve & post`,
  `Approve & send` or `Approve & continue`, or your `approve_label`).
  `Reject` sends at once and needs no reason. With `allow_changes`,
  `Request changes` opens `What should change?` and the primary becomes
  `Send request` until `Cancel`.
- `summary` is optional. Without it, put the question in `task.why`. The
  facts carry the request. A blank `summary` is still rejected. With
  `checks`, one line before the facts names warnings and failures (`3 ok ·
  1 warning: Bundle size`). A fact label may be 32 characters. A note is
  part of the result only while its field is open.
- A user action uses `Posted ✓`, `Sent ✓` or `Done ✓`, plus `Skip`.
  Information only is `Got it`. That note is sent only while it is open.
- `pick-option` shows the question as the heading, and leaves it out when
  it only repeats the title. Nothing is preselected. The primary names the
  option (`Choose Old Mill Studio`) and stays off until one is picked.
  `Add note` is a quiet button under the cards.
- `None of these` is on unless `allow_none` is false. It asks what is
  missing, requires the note, and sends a change request (`decision`
  `request_changes`, no `choice`). The decided banner says `New options
  requested: the bot keeps looking`, including when the report is reopened.
  A pick is still `choice` and `note`.
- Breaking: a `decide-list` with any bot item uses `Send decisions`
  (`Send decision` for one item). The button sends the choices and approves
  nothing by itself. When every item is the person's, the footer is `Done`.
  The banner asks for the decisions and then names the bot. It does not use
  the choice labels. A mix still gives each side one line, you first, and
  the footer stays `Send decisions`.
- A list holds 1 to 12 items. The status counts by the labels on the
  buttons (`2 Pay · 1 Reject · 2 open`). Results stay `approve`, `reject`
  and `defer`, or `done`, `skipped` and `later` on a user item. `content`
  `post` or `reply` shows `Posted ✓` for that item.
- Breaking: `show` rejects a label that repeats another choice of the same
  item, including a top-level label or a default such as `Reject` or
  `Ablehnen`. The error points at that `labels` entry. A user item cannot
  carry `labels`, and a choice from the other side is rejected. `due` is
  `YYYY-MM-DD` and must be a real calendar day (`2026-02-31` is rejected).
- The list heading reads `Items` (`Einträge`), so a sent list does not say
  it needs you. When nothing was already handled, the list has no visible
  heading. `Add note` on an item is a quiet link.
- `review-doc` uses `Request changes`. With section comments, that button
  does not open an empty overall comment. The comment waits behind `Add a
  note`, and the request can be sent from the section comments alone. An
  empty section field closes when it loses focus, or with Esc.
- Breaking: the `review-doc` result is stricter. `approve` keeps
  `comment` empty and may still carry section comments. `request_changes`
  needs a non-blank overall comment, or a blank one plus at least one
  section comment. A section comment that is blank or only whitespace is
  rejected. Each section comment is `{section, heading, comment}`.

- **Social posts.** Breaking: an auto Instagram post allows 5 hashtags (the
  limit was 30). More than 5 blocks approval (`Cut to 5 hashtags to
  approve`). A manual post only advises (`More than 5 hashtags: check in
  Instagram`).
- A listed tag counts toward those 5 even when `hashtag_mode` is `none`,
  unless the text already contains that hashtag. A tag needs a letter or an
  underscore, so `#1` does not count. A `#` inside a URL, or after a slash,
  does not count.
- X allows 25,000 weighted characters and folds after 280. The
  fold cuts at the last word boundary, never inside a URL, ends the visible
  text with `…`, and puts `Show more` on its own line. The counter reads
  `245 / 280` up to the fold and `487 / 25,000` past it (`25.000` in
  German). Past the fold, a quiet line says `Long post (X Premium)`. An
  auto post over 25,000 is blocked. A whole emoji counts as one unit at the
  fold. A URL in the text still weighs 23. `target.url` is still not part
  of the text.
- Breaking: when every platform is manual there is no `Skip`. The primary
  stays off until one platform is marked `Posted ✓`, and it then reads
  `Posted ✓`. An unticked manual platform is still `skipped`. `Request
  changes` remains. The banner says `Post it yourself` once, and the panel
  does not say `You post this yourself.` The tabs do not repeat `manual`.
  In a mix, a manual tab still says `X · manual`. The footer reads
  `Send response` before anything is ticked and while both sides are
  ticked, `Approve & post` when only auto platforms are ticked, and
  `Posted ✓` when only manual ones are.
- A manual post is never blocked. Over a limit, `Posted ✓` stays on and the
  line is advice. A blocked auto platform shows one recovery line
  (`Shorten by 12 characters to approve`). When nothing can be approved,
  the status says `Nothing can be approved: request changes`.
- `variants.<platform>` may set `text`, `hashtags`, or both. Image and
  video ratios add `3:4` and `9:16`. On a manual platform the copies sit
  above `Posted ✓`, and `Show in folder` is in the `…` menu. Flag words are
  one quiet line (`Style note: contains “—”`). Post only auto platforms
  whose `per_platform` decision is `approved`.

- **Reports.** `review-doc` renders `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`,
  `[!WARNING]` and `[!CAUTION]` as a quiet, neutral note with a title. A
  callout copies nothing, including a code block or quote inside it. With
  `copy` texts, only a bold paragraph in the lead (before the first
  heading) moves above them.
- A status, weekly summary or research outcome uses `review-doc` with
  `task.kind` `fyi`: a bold one-line summary, a facts table, checks as
  `- [x]` and `- [ ]`, at most one callout, details last, about 400 words.
  That desk is `Got it` only. A closed note sends an empty `comment`.

- **Bots.** Open a desk for a decision, and for a report longer than about
  five lines. Keep chat for a short question or a one-line acknowledgement.
  The title is the decision or the report, about 60 characters. Say why in
  one or two sentences. Do not restate the title, who acts, or which button
  to press.
- The window does not translate your text. Its buttons are German unless
  `RS_LANG=en` was set before the server started. Read
  `templates/builtin/<id>/README.md` for the payload and the result. On a
  `user` or `none` result, record it and stop.

- **Data folder and setup.** Breaking: on Windows the older data folder
  stays in use until you run `python report_shell.py migrate`. `paths`,
  `doctor` and `show` say so. The command moves
  `%LOCALAPPDATA%\spqrk-report-shell` to `%LOCALAPPDATA%\grokbot-desk`
  while the desk is closed and no report in the old folder is still open.
- `migrate` also refuses while a desk runs or is starting, while another
  migrate runs, or when the new folder already holds files. It rewrites
  `config.json` media folders under the old path and also updates paths in
  decided reports, and puts those files back if the move fails. A moved folder is never created again. Starting the
  desk on the old folder after the move is refused. macOS has nothing to
  migrate. `RS_DATA_DIR` is never moved.
- Breaking: the webhook variable `SPQRK_REPORT_SHELL_WEBHOOK_KEY` is gone.
  Use `GROKBOT_DESK_WEBHOOK_KEY`.
- `python report_shell.py --version` prints `grokbot-desk 1.0.0-beta.3`.

- **Fixes.** Cancelling a change request returns focus to the button that
  opened it. On `preview-post`, Cancel returns to `Request changes`. A
  restored draft does not move focus into the decision. `pick-option` keeps
  the pick set aside by `None of these` in the draft, so Cancel after a
  reload brings it back.
- A failed Skip on `review-doc` puts the primary's result back, as
  `approve-one` does. A closed information-only note is left out of the
  layout and out of the result.
- For contributors: every built-in has a German review payload, `_starter`
  has an English golden fixture, and the German and English string tables
  must use the same placeholders. The source lint skips worktrees under
  `.claude`. A built-in screenshot resets and logs any scroll offset before
  the capture.

## 1.0.0-beta.2 (2026-10-12)

- macOS is supported: its CI jobs are blocking like the Windows ones.
- CI is split: pytest, the source lint, the Node unit files and a browser
  smoke set block; the full browser suite (timing budgets, burst, pop-up
  timing) runs as an advisory step. The release gate is the full suite and
  screenshots on a real Windows machine and a Mac (CONTRIBUTING.md).
- An already read report is no longer rewritten on every window focus.
- Task banner: every report opens with a tinted banner above its title that
  says what to do and who acts next, one line of steps, at most three
  sentences of why (the rest folded) and the effort and due date (`~3 min`,
  `due today 15:00`). A decided report keeps it, neutral, saying what
  happened. One calm colour per kind; red only for `blocking` or a due date
  that is today or past. The banner holds no buttons. The calm checker
  allows its tint as the one status colour besides the accent.
- New optional payload field `task`: `{kind, steps, eta_min, due, why}`
  with `kind` one of `post_yourself`, `approve_bot_acts`, `pick`, `fyi`,
  `review`, `blocking`. Without it the kind is derived from the template and
  its `actor`, so existing payloads work unchanged. A kind sets the matching
  actor when `data` leaves it out and is rejected with a pointer when `data`
  contradicts it.
- Buttons follow the kind, from one table for the actor-model built-ins:
  `Posted ✓` / `Skip` when you post it yourself, `Done ✓` / `Skip` when you
  do something else (`Sent ✓` when `action` is `send`; Done only when there
  is no specific content or action), `Approve & post` /
  `send` / `continue` when the bot acts, `Choose`, `Got it` alone for
  information (one collapsed note, no Request changes, no Discard),
  `Looks good` / `Changes` for a review. `Posted ✓` is for a manual
  platform, a decide-list item with `content` `post` or `reply`, or an
  explicit `task.kind` of `post_yourself`. A decide-list footer reads
  `Done` when every item is yours, and `Approve & continue` only when the
  bot acts next. A mixed report (a preview with auto and manual platforms,
  a list with your items and the bot's) gives each actor one banner line,
  you first, the bot by its display name: `You post: X` /
  `Inbox Agent posts after approval: LinkedIn`, or counted for a list
  (`You post: 2 replies` / `Inbox Agent sends after approval: 3 items`).
  The lines follow the ticks and choices (`Inbox Agent posts nothing:
  LinkedIn not ticked`). A platform that cannot be approved is left out of
  the plan from the start. The decided banner says what each side did
  (`You posted: X` / `Inbox Agent posts now: LinkedIn`). A supplied
  `task.steps` stays; live updates do not replace it. A mixed preview's
  steps say per actor what is still open, then the footer as it reads now
  (`LinkedIn: tick Approve · X: copy, post, Posted ✓ · then Submit`).
  That two-platform line fits the 72-character measure; a longer list wraps.
  Its primary reads `Submit`
  while both act (`Approve & post` with only auto platforms ticked,
  `Posted ✓` with only manual ones), and the status splits the count
  (`1 approved · 1 posted`). The result is unchanged. `decide-list`
  takes an optional `action` (`post`, `send`, `continue`) for the bot's
  verb and footer. Templates without an
  actor model keep their own buttons and may only set `review` or
  `blocking`. Templates get `RS.task` and `RS.cta(value)`. A `why` past
  3 sentences or 360 characters warns on `show` and is folded. `due` is a
  calendar date or a browser-safe extended timestamp.
- With no report on screen while some wait, the window lists them (`Waiting
  for you`): bot, title and the kind of task; a row opens its report.
- `wait` ends at the run's expiry plus 2 minutes at the latest and exits
  7 when no result was written by then. `--until-expiry` waits up to that
  point (for a background waiter) and excludes `--timeout`. A run record
  without a readable expiry (from before beta.2) keeps the old behaviour.
- `results --since` is inclusive (`>=`): a decision in the cursor's own
  second is no longer lost. Every answer prints `cursor` and `seen`; pass
  them back as they came (`--since`, `--seen RUN_ID`) and nothing is listed
  twice.
- `preview-post`: a mode per platform. `auto` (the default, so existing
  payloads work unchanged): the bot posts after `Approve & post`. `manual`:
  you post it yourself; the panel starts with `You post this yourself.` and
  copy buttons for the text, hashtags, comment and the image (copied as a
  picture, plus `Show in folder`), then `Posted ✓`. The tab names the
  mode quietly (`X · manual`). A manual decision is `done` (posted) or
  `skipped` (not posted). `posted_manually` is not a result value.
- The `preview-post` result keeps `platforms` as the list the bot may post
  (auto and approved only) and adds `per_platform` with each platform's mode
  and decision (`approved`, `done`, `skipped`, `not_approved`,
  `changes_requested` with the comment as `note`).
- Labels say who acts next. `decide-list` items take an optional `actor`
  (`bot` or `user`, default `bot`), an optional `content` (`post` or `reply`)
  and an optional `url`. User items use Done ✓ / Skip / Later, or Posted ✓
  when `content` is a post or reply (`done` / `skipped` / `later`). When
  every item is a user item the footer reads Done. `approve-one` and `review-doc` take
  an optional `actor` (`bot`, `user` or `none`, default `bot`) and an
  optional `action` verb. Existing payloads keep today's results.
- Links in item text, review-doc Markdown, pick-option text and `url`
  fields open in the system browser via `POST /open-url` (`RS.openUrl`).
  The server accepts only an http(s) address that appears in that run's
  payload.
- `review-doc` copies each code block and blockquote, and an optional
  `copy` list near the top. `pick-option` options take an optional `copy`
  string. Default review styling makes tables, bold, lists and check
  states scannable.
- Copy an image as a picture: `POST /copy-image`, `RS.copyImage(id)` and
  `<rs-copy media="…">` (macOS via AppKit; Windows via GDI+, no WebP).
- macOS: tested on a real Mac (macOS 26, Apple silicon, Google Chrome). The
  README has a macOS setup section; `./report-shell` also finds a versioned
  Python such as Homebrew's `python3.12`, and Python 3.9 gets a clear message
  instead of a traceback.
- The "sent" toast no longer lingers over the next report after a decision.
- A slow server start is no longer reported as "port is held by a foreign
  process".
- Test and lint fixes for macOS: timing in browser tests, a local `.venv` is
  ignored by the source lint.
- Several bots at once (a burst): the report on screen is never replaced
  by an arrival, touched or not; a new report becomes active only when
  nothing open is shown. One polite announcement per burst (`3 new reports
  from 2 bots`) instead of one toast per report.
- The avatar strip shows one avatar per bot with a count badge
  (`Inbox Agent, 3 reports`), in arrival order: arrivals append and nothing
  jumps, also when a bot's `created` stamp is off. A bot's avatar goes to
  its oldest open report; again on the current one steps to its next.
  `Ctrl+1..9` and `Left`/`Right` work per bot; `n of m open` counts reports.
- The window comes forward at most once per burst: a push that launches the
  window counts as the burst's bring-forward, and `show --focus` follows the
  server's new `attention` answer instead of raising the window per report.
- Exactly one window: a launch now stays pending for up to 20 seconds until
  its page connects (was 5), so a report arriving during a slow first
  browser start no longer opens a second window.
- `python report_shell.py --version` prints `grokbot-desk 1.0.0-beta.2`.
- `preview-post` takes an optional `video` (`path` `.mp4`/`.webm` up to 200 MB, required `poster` image, `alt`, `ratio`) instead of `image`. The mockup shows the poster and plays the file inline. A manual platform copies the file path and can show the file in its folder. Instagram counts a video as media. Images stay at most 20 MB; video is served in HTTP ranges.
- `preview-post` takes an optional `target` (`quote` or `reply`, with `url`, optional `excerpt` and `author`). X shows a quote card under the post, or a reply line and the parent card above the post. LinkedIn and Facebook show a reshare card. The quoted URL is not part of the text, so X does not count it. A manual platform can copy the link.
- `paths` prints the data directory in use and why. A legacy data directory stays in use until the new folder holds runs. Bots use the CLI (`result`, `wait`, `results --since`, `paths`) and never guess the directory.
- Optional `dedupe_key` and `dedupe_hours`: the same bot and key returns the open run, or a run submitted or cancelled within that many hours (`deduped: true` and `state`). An expired run never dedupes. `show` twice with the same key does not open a second report.
- A `created` stamp more than 2 minutes ahead is clamped to now, and `show` warns.
- `results --since` items include `title` and, when the decision is compact, `summary` (decide-list counts per choice, preview-post decisions per platform).
- A preview-post summary only names allowed outcomes: `x posted by you` or `x skipped` for a manual platform, and `linkedin approved` for an auto platform that was approved. A manual platform is never called approved. The summary is omitted when mode and decision disagree, the decision is unknown, `platforms` is not exactly the auto approvals, or an older result has no `per_platform`. Submit rejects an inconsistent preview-post result. Post only `auto` + `approved`; do not treat the summary as permission to post.
- `preview-post` `target.url` uses the `x-rs-url` keyword (`"https"`) with the same openable check as the link opener, and still a 2048-character limit. `decide-list` item URLs use `x-rs-url` as well and keep their hostname pattern. An `x-rs-exclusive` list must be non-empty strings; a nested value is a schema error at `/x-rs-exclusive`.
- A reply without an author handle stays a reply. On X the parent card sits above the post, labelled with the handle, the author name, or "Replying to this post".
- A video keeps its poster image if the clip cannot be decoded or makes no progress for 8 seconds. The page then says the preview is unavailable and that the path can still be copied or the file shown in its folder. `preload="none"` leaves an untouched clip on its poster; starting playback still reports a clip that cannot be decoded, and the frame has no retry button.
- Run summaries include `seq`, the order the report was registered. The strip uses it, including when several reports are already waiting at the first page load. A run saved without `seq` is given one when the store loads it, in `created` order, ahead of later registrations. A bot id such as `constructor` still shows its report.
- One announcement per burst uses the same 30-second quiet gap as bringing the window forward. The page collects for up to 10 seconds and announces once.
- After a decision the window goes to the same bot's next open report, wrapping inside that bot before the next bot.
- `Range: bytes=-` is ignored; the media response is the whole file. `POST /reveal` only opens a media file that belongs to that report.

## 1.0.0-beta.1 (2026-10-10)

First public beta of grokbot-desk.

- A small pop-up decision window: a bot sends a report, you read it and decide
  right there.
- An avatar strip at the top shows every open report; switch between them with
  one click.
- Five built-in templates: approve one thing, decide a list, pick an option,
  review a document, preview a social post.
- Per-bot identity: each bot has its own name, avatar shape and colour.
- An app icon for the window, title bar and taskbar.
- `python report_shell.py --version` prints the version (`grokbot-desk 1.0.0-beta.1`).
- Windows is supported. macOS is in beta.
