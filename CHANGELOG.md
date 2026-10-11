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
