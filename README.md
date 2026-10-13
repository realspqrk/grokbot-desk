<div align="center">

<img src="core/static/icons/icon-192.png" alt="grokbot-desk icon: a white blob with two eyes" width="112" height="112">

<h1>grokbot-desk</h1>

<p><strong>The CEO dashboard for decisions and reports from your bots.</strong></p>

<p>You manage your bots like employees. Make decisions like a CEO.<br>
Optimized for Grok Bot. Works with any agent that can run a command.</p>

[![CI](https://github.com/realspqrk/grokbot-desk/actions/workflows/ci.yml/badge.svg)](https://github.com/realspqrk/grokbot-desk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue.svg)](https://www.python.org/downloads/)
[![Platforms: Windows | macOS](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS-blue.svg)](#platforms)
[![Version: 1.0.0-beta.2](https://img.shields.io/badge/version-1.0.0--beta.2-blue.svg)](CHANGELOG.md)

</div>

> [!WARNING]
> ⚠️ This is not an official Grok Bot plugin. SpaceXAI, please don't sue me. But please steal it. Add it to Grok Bot natively 🙏

<div align="center">

<p>
  <a href="#quick-start">Quick start</a> &middot;
  <a href="#templates">Templates</a> &middot;
  <a href="#use-with-grok-bot">Use with Grok Bot</a> &middot;
  <a href="CHANGELOG.md">Changelog</a>
</p>

<img src="docs/img/hero-strip-dark.png" alt="Three open reports with a slim avatar strip along the top, dark theme" width="760">

</div>

Chat is awful for discussing serious work. When a bot needs your decision, a calm window pops up instead: the bot sends JSON, you decide, the bot reads your decision as JSON. Everything stays on your computer.

**Status:** 1.0.0-beta.2. Windows and macOS are supported.

## What you see

| One open report | After the decision |
| :---: | :---: |
| <img src="docs/img/hero-popup-dark.png" alt="One open report in a compact pop-up, dark theme" width="400"> | <img src="docs/img/hero-done.png" alt="A report after the decision has been sent" width="400"> |

One open report is a compact pop-up. The report title leads, under a quiet line with the bot's name. A tinted banner under the title says in one line what to do and who acts next (for example `Approve and the bot posts`, or `Post it yourself`), with a short why; the buttons match it. Discard report sits in the `…` menu. Several open reports share one window with an avatar strip on top; after each decision the next one comes forward. The window is German by default; `RS_LANG=en` switches to English. Times use the machine's time zone.

## Use with Grok Bot

First complete [Quick start](#quick-start): verify Python 3.11 or newer and have Microsoft Edge or Google Chrome available (on macOS, see [macOS setup](#macos-setup)). Your bot must be able to run commands on this computer, in the clone folder.

1. Clone grokbot-desk on your own computer (the one whose screen you look at), not on a server or VM:
   `git clone https://github.com/realspqrk/grokbot-desk.git`
2. Add the skill: give your bot `skills/grokbot-desk/SKILL.md` from the clone (add it as a skill, or paste it into the bot's instructions) and tell it where the clone is.
3. Ask your bot: "When you need a decision from me, use grokbot-desk." The next time it needs your yes, a window pops up instead of a chat message.

### Do I need a skill?

No. Any bot that can run commands on your computer can use grokbot-desk from this README. The skill makes it reliable: it tells the bot when a pop-up beats chat, which built-in template to pick, how to wait for your answer, and what never belongs in a payload.

## How it works

1. The agent writes a JSON payload for a template.
2. `show` checks the payload and opens one Edge or Chrome app window on this machine.
3. You decide there. The window keeps one primary action on screen and tucks notes and extra detail away.
4. `wait` blocks until a result file exists, then prints the status and its path. `result` prints the decision JSON.

The window records the decision. The bot reads the result file and does the work.

## Quick start

Use Python 3.11 or newer and Microsoft Edge or Google Chrome. The runtime uses only Python's standard library. Template checks need additional development tools; see Templates below. On macOS, do [macOS setup](#macos-setup) first.

```bash
git clone https://github.com/realspqrk/grokbot-desk.git
cd grokbot-desk
python report_shell.py --help
```

On macOS, run `./report-shell --help` instead (or `python3.12 report_shell.py --help`); the examples below use `python`, so substitute your command.

On Windows, `report-shell.cmd` requires a working `py -3` launcher. Verify `py -3 --version` first. If it cannot find Python but `python --version` works, run `python report_shell.py <command>` from the clone folder instead.

If `status` still shows `window_alive: false` a few seconds after `show` (the first browser start can take a moment), your agent runtime may end child processes when a command finishes. Start `python report_shell.py serve` in a terminal that stays open, then run `show` again.

The shipped skill is `skills/grokbot-desk/SKILL.md`.

### macOS setup

macOS ships Python 3.9 as `/usr/bin/python3`, which is too old: `python3 report_shell.py` stops with "Python 3.11 or later is required". There is no `python` command either. Install a newer Python and a browser, for example with [Homebrew](https://brew.sh):

```bash
brew install python@3.12
brew install --cask google-chrome
python3.12 --version
```

Homebrew's `python@3.12` adds `python3.12`, not `python3`; the python.org installer adds a `python3` that is 3.11 or newer. Microsoft Edge works too. Without Edge or Chrome in `/Applications` or `~/Applications`, the report opens as a normal tab in the default browser.

From the clone folder, `./report-shell <command>` picks a Python 3.11 or newer by itself (`python3`, then `python3.14` down to `python3.11`, also in `/opt/homebrew/bin` and `/usr/local/bin`); set `REPORT_SHELL_PYTHON` to choose one. Or call it directly, for example `python3.12 report_shell.py show ...`.

## Example

This example uses the built-in `decide-list` template. Save it as `make_payload.py`. It writes `payload.json` with a fresh timestamp.

```python
import json
from datetime import datetime, timezone
from pathlib import Path

payload = {
    "schema": "report-shell/payload@1",
    "template": "decide-list",
    "version": 1,
    "bot": "inbox-agent",
    "identity": {
        "name": "Inbox Agent",
        "avatar_shape": "squircle",
        "avatar_color": "blue",
    },
    "title": "Two requests need a decision",
    "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    "data": {
        "intro": "Approve these two requests? Approve = go ahead, Reject = I say no, Defer = ask me again next week.",
        "items": [
            {
                "id": "travel",
                "title": "Workshop travel",
                "source": "Events team",
            },
            {
                "id": "laptop",
                "title": "Replace a developer laptop",
            },
        ],
    },
}
Path("payload.json").write_text(json.dumps(payload), encoding="utf-8")
```

Create the payload and open the window (on macOS: `python3.12 make_payload.py` and `./report-shell show decide-list --data payload.json`):

```bash
python make_payload.py
python report_shell.py show decide-list --data payload.json
```

The command returns at once with one JSON line: `run_id`, `url` (on `127.0.0.1`, port from `config.json`, otherwise `18742`), and `result_path`. Optional flags are `--focus` and `--no-window`.

After you choose and send, read the outcome:

```bash
python report_shell.py wait RUN_ID --timeout 60
python report_shell.py result RUN_ID
```

Replace `RUN_ID` with the id printed by `show`. `wait` prints `{"status":"submitted","result_path":"..."}` when you submit. Other terminal statuses are `cancelled` and `expired`. `--timeout` is in seconds. `wait` returns as soon as a result exists and at the latest at the report's expiry plus 2 minutes: exit 7 means no result was written by then. `--until-expiry` waits up to that point. (A run record from before 1.0.0-beta.2, or one that cannot be read, has no expiry, so only `--timeout` ends that wait.) `result` prints the full envelope. A bot starts with `wait --timeout 60` and never uses `--timeout 0`. Exit 5 means the report is still waiting: if the bot's runtime wakes it when a background subagent or task finishes, it hands `wait RUN_ID --until-expiry` to one (background shells may not wake it); otherwise it catches up on its next turn with `results --since`, passing back the `cursor` and `seen` it got last time. After a result, the bot acknowledges in its own chat with topic + OK and starts any work the result asks for. Bots learn the data directory from the CLI (`paths`, and `data_dir` on `show`, `wait`, `result` and `results`) and never guess it. `results --since` items include `title` (and `summary` when the decision is compact) so that one line can name the topic. Example result (ids and timestamps are illustrative):

```json
{
  "schema": "report-shell/result@1",
  "run_id": "RUN_ID",
  "template": "decide-list",
  "template_version": 1,
  "bot": "inbox-agent",
  "status": "submitted",
  "created": "2026-10-08T10:39:00+02:00",
  "decided": "2026-10-08T10:44:12+02:00",
  "duration_s": 312,
  "log": "<data-dir>/log/2026-10-08.jsonl",
  "data": {
    "items": [
      {"id": "travel", "choice": "approve", "note": ""},
      {"id": "laptop", "choice": "defer", "note": ""}
    ],
    "note": ""
  }
}
```

`created` and `decided` use the machine's time zone, with its offset. `duration_s` is the time since the payload was created. `log` points at the local action log.

The result may also carry `identity` diagnostics (for example a theme accent fallback); they never change the decision.

## Templates

Five built-in templates:

| id | What it is for |
| --- | --- |
| `review-doc` | Read a draft or report and approve it, or request changes with comments. |
| `pick-option` | Compare 2 to 4 options side by side and pick one. A note is optional. |
| `decide-list` | Approve, reject, or defer up to 5 items, one at a time. |
| `approve-one` | One yes/no decision, with an optional request for changes. |
| `preview-post` | Preview one social post (X, LinkedIn, Instagram, Facebook) and approve it per platform, or request changes. Per platform `auto` (the bot posts after your approval) or `manual` (you post it yourself from copy buttons for text, hashtags, image or video, and a quote/reply link, then Posted ✓). |

Run `python report_shell.py templates` to list what is installed. If none of these fits, `python report_shell.py new example/my-template` writes a template into your data directory, and `python report_shell.py check my-template` checks it. See the [template guide](docs/GUIDE.md).

`show`, `wait`, `result`, `templates`, and `new` need only Python at runtime. `check` is a development check: it also needs Node.js, an existing playwright-core installation (set `RS_PLAYWRIGHT_CORE` to its entry point), and a supported browser. The check uses `py -3` unless `RS_PYTHON` names a working Python executable; for example, in PowerShell: `$env:RS_PYTHON = (Get-Command python).Source`, on macOS: `export RS_PYTHON=python3.12`.

## Bot identity

Each bot has a name, a shape avatar, and a colour. Set `identity` on the payload, or the same fields in `bots.json`: `name`, `avatar_shape` (`blob`, `squircle`, `pebble`, `hex`, `teardrop`, `tablet`), `avatar_color` (`blue`, `orange`, `yellow`, `magenta`, `red`, `violet`, `black`, `green`, `gray`), optional `avatar` (PNG, JPEG, WebP, or GIF), and optional `accent` (`#RRGGBB`).

```json
{"name": "Inbox Agent", "avatar_shape": "squircle", "avatar_color": "blue"}
```

Payload `identity` wins over `bots.json`, then the shipped registry, then the defaults. `name` and `accent` are picked per field; the avatar fields come as one set from the first source that states any of them, in the order image, shape and colour, initials. An unknown shape shows initials, an unknown colour uses the default colour, and a bad value is skipped for the next source without rejecting the report.

Optional `avatar`: PNG, JPEG, WebP or GIF only, at most 256 KB. For payload avatars, use a path relative to the template folder (or `%RS_TEMPLATE%/...`); registry paths are relative to the registry folder. Absolute avatar paths are allowed only inside the data directory. `media_roots` applies to report media, not to avatar paths. Optional `accent` is `#RRGGBB`. Never use SVG.

## Platforms

Windows and macOS are supported; CI runs on both, and every release passes the full suite on a real Windows machine and a Mac. Edge or Chrome opens an app window. On macOS (tested on macOS 26 on Apple silicon with Google Chrome), `show` opens the app window, and deciding, `wait`, `result`, the copy buttons (through `pbcopy`) and `stop` work.

On macOS, follow [macOS setup](#macos-setup) and replace every `python` command with `./report-shell` or your Python 3.11+ (`python3.12`, for example). Use forward-slash paths and shell `export` syntax for environment variables. The default data directory is `~/Library/Application Support/grokbot-desk`; `RS_DATA_DIR` overrides it.

The macOS launcher searches Edge, then Chrome, in `~/Applications` and `/Applications`. Without either it opens the system default browser, which may show a normal tab instead of an app window. Automatic focus and attention are not implemented on macOS (`--focus` does nothing there). macOS security or Gatekeeper prompts may require you to open and approve a trusted Python/browser installation manually; a successful CLI return does not prove that an asynchronous browser launch reached a visible window.

## Privacy and security

The server listens only on `127.0.0.1`. The page loads no remote images, fonts, or sites. Payloads, results, and action logs stay on this machine. On Windows the default folder is `%LOCALAPPDATA%\grokbot-desk`. `RS_DATA_DIR` overrides it. An older Windows data folder (`spqrk-report-shell`) stays in use until you decide or discard its open reports, close the desk and run `python report_shell.py migrate`; `paths` says so. The optional webhook is off unless you enable it, set a key, and allow-list an HTTPS URL. At server startup, files in `runs`, `results`, and `log` older than 30 days are removed. Media and browser profiles are kept.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE).

If you like this project, support me by checking out [PhraseVault](https://phrasevault.app) or [BackupOnShutdown](https://backuponshutdown.app).

## Closing note

Dear Grok Bot team: please steal this repo and build it in natively. The MIT license makes that easy.
