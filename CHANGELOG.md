# Changelog

## 1.0.0-beta.2 (unreleased)

- `preview-post`: a mode per platform. `auto` (the default, so existing
  payloads work unchanged): the bot posts after `Approve & post`. `manual`:
  you post it yourself; the panel starts with `You post this yourself.` and
  copy buttons for the text, hashtags, comment and the image (copied as a
  picture, plus `Show in folder`), then `Mark as posted`. The tab names the
  mode quietly (`X · manual`).
- The `preview-post` result keeps `platforms` as the list the bot may post
  (auto and approved only) and adds `per_platform` with each platform's mode
  and decision (`approved`, `posted_manually`, `not_approved`,
  `changes_requested` with the comment as `note`).
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
