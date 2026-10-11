# Changelog

## 1.0.0-beta.2 (unreleased)

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
  (`bot` or `user`, default `bot`) and an optional `url`. User items use
  Posted ✓ / Skip / Later (`done` / `skipped` / `later`); when every item
  is a user item the footer reads Done. `approve-one` and `review-doc` take
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
