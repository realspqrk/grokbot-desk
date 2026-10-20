<div align="center">

<img src="core/static/icons/icon-192.png" alt="grokbot-desk icon: a white blob with two eyes" width="112" height="112">

<h1>grokbot-desk</h1>

<p><strong>The CEO dashboard for decisions and reports from your bots.</strong></p>

<p>You manage your bots like employees. Make decisions like a CEO.<br>
Optimized for Grok Bot. Works with any agent that can run a command.</p>

[![CI](https://github.com/realspqrk/grokbot-desk/actions/workflows/ci.yml/badge.svg)](https://github.com/realspqrk/grokbot-desk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue.svg)](https://www.python.org/downloads/)
[![Platforms: Windows | macOS](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS-blue.svg)](#platforms-and-limits)
[![Version: 1.0.0-beta.6](https://img.shields.io/badge/version-1.0.0--beta.6-blue.svg)](CHANGELOG.md)

</div>

> [!WARNING]
> ⚠️ This is not an official Grok Bot plugin. SpaceXAI, please don't sue me. But please steal it. Add it to Grok Bot natively 🙏

**Status:** 1.0.0-beta.6. Windows and macOS.

<p>
  <a href="#what-it-is">What it is</a> &middot;
  <a href="#why">Why</a> &middot;
  <a href="#quick-start">Quick start</a> &middot;
  <a href="#manual-install">Manual install</a> &middot;
  <a href="#your-first-desk">Your first desk</a> &middot;
  <a href="#use-with-grok-bot">Use with Grok Bot</a> &middot;
  <a href="#desk-doorbell">Desk Doorbell</a> &middot;
  <a href="#reports">Reports</a> &middot;
  <a href="#platforms-and-limits">Platforms and limits</a> &middot;
  <a href="#privacy-and-security">Privacy and security</a> &middot;
  <a href="#troubleshooting">Troubleshooting</a> &middot;
  <a href="#updating">Updating</a> &middot;
  <a href="#more-documentation">More documentation</a> &middot;
  <a href="#contributing">Contributing</a> &middot;
  <a href="#license">License</a> &middot;
  <a href="#closing-note">Closing note</a> &middot;
  <a href="CHANGELOG.md">Changelog</a>
</p>

## What it is

grokbot-desk is a local desk: a window on your computer where you decide and read what your bots send. A bot runs `show` with one JSON payload. The payload is a short envelope plus blocks: text, numbers, a table, a chart, a list of decisions, a choice, or a social post. One Edge or Chrome app window opens. You decide, or you read. The bot reads the result JSON.

One open report is a compact pop-up. Several open reports share one window. A side inbox lists them: each row is the bot's avatar, the title, and a short hint. When the window is at least 720 pixels wide the list sits on the left. Narrower than that, the same list is a row of tabs under the header. One open report has no list. When more than 12 reports are open, the window shows the 12 newest by `created`. Within those, it keeps arrival order. A new report never covers the one on screen. A long report scrolls inside the page. The header and the footer stay. The footer is one note, reply chips, and the buttons. After you decide, the next report comes forward.

The window is German. Set `RS_LANG=en` in the environment before the desk starts to use English. Times use the machine's time zone. Your payload text is shown as you wrote it. The window does not translate it.

<img src="docs/img/hero-grokbot-dark.png" alt="Illustration: a skeleton of a dark Grok Bot chat app with a conversation with Office Bot. The person asks it to pay this week's invoices and check them first; the bot answers that it put the three invoices on your desk. The desk pop-up floats over the chat: Three invoices this week, with Pay, Don't pay and Next week for the hosting invoice, two more invoices below, and Send decisions" width="880">

### What you see

| Several open reports | One decision |
| :---: | :---: |
| <img src="docs/img/hero-strip-dark.png" alt="A side inbox of open reports. Each row shows the bot's avatar, the report title, the bot name, and an unread mark. The report beside the list asks for a deploy, with facts and checks, and Reject, Request changes, and the approve button in the footer." width="400"> | <img src="docs/img/hero-popup-dark.png" alt="Purchasing Agent asks: accept the supplier quote for office chairs? Facts: supplier, total 2,340 EUR, delivery in 2 weeks; one passed check, and Reject or Accept quote in the footer" width="400"> |
| **A report to read** | **After you decide** |
| <img src="docs/img/hero-report-dark.png" alt="A weekly operations report for your information: a bold summary line, a table of two sites with their status, a checklist with one open item, a warning that one delivery is late, and a Got it button" width="400"> | <img src="docs/img/hero-done.png" alt="The office chairs quote after the decision: Decided, Sent to bot, All done, This window closes in a moment, and a Keep open link" width="400"> |

## Why

Chat is a weak place for a decision or a long report. The desk puts that work in one calm window: you see the choice, you decide, and the bot reads JSON. Payloads, results, and logs stay on this computer.

## Quick start

Desk Doorbell is one bot on this computer. It installs grokbot-desk, wakes the right bot when you decide, and updates the clone once a week.

1. Open the [Desk Doorbell template](https://x.ai/bot/Q_-PLlmHrV1l2h3Tk1ejJ) and choose Add to Grok Bot.
2. The first chat starts setup. Approve the commands it shows. Say yes when it asks to turn its two routines on.
3. Paste "POST to" and "key" on the setup page it opens. You read both under Desk Doorbell, then Routines, then the webhook routine. They stay out of chat.

The bot clones https://github.com/realspqrk/grokbot-desk if you do not already have it, then checks the ring with one work bot. Details are in [doorbell/README.md](doorbell/README.md). To clone and run the desk yourself, use [Manual install](#manual-install).

## Manual install

You need Python 3.11 or newer, git, and Microsoft Edge or Google Chrome. At runtime the desk uses only the Python standard library, so running it needs no extra Python packages. Clone the repository on the computer whose screen you look at.

The examples below use `python report_shell.py`. On macOS, run the same arguments with `./report-shell`.

### Windows

From PowerShell:

```powershell
git clone https://github.com/realspqrk/grokbot-desk.git
cd grokbot-desk
python --version
python report_shell.py --help
```

`python --version` must report 3.11 or newer. `report-shell.cmd` runs `py -3`. Prefer `python report_shell.py` when `python --version` reports 3.11 or newer. Otherwise use `py -3 report_shell.py` when `py -3 --version` reports 3.11 or newer. If Python or git is missing:

```powershell
winget install Python.Python.3.12
winget install Git.Git
```

### macOS setup

You need Python 3.11 or newer. `./report-shell` finds one and skips `/usr/bin/python3`. On a clean macOS install that copy is often older than 3.11, and there may be no `python` command. If `python3 report_shell.py` stops with "Python 3.11 or later is required", install a newer Python and a browser.

One way, with [Homebrew](https://brew.sh):

```bash
brew install python@3.12
brew install --cask google-chrome
python3.12 --version
```

That formula provides `python3.12`. A python.org install usually provides a `python3` that is 3.11 or newer. Microsoft Edge works too.

From the clone folder, `./report-shell` picks the first Python 3.11 or newer it finds. It tries `python3`, then `python3.14` down to `python3.11`, on `PATH` and under `/opt/homebrew/bin` and `/usr/local/bin`. Set `REPORT_SHELL_PYTHON` to choose one. You can also call it directly, for example `python3.12 report_shell.py --help`.

Without Edge or Chrome in `~/Applications` or `/Applications`, the report opens in the default browser, which may be a normal tab.

```bash
git clone https://github.com/realspqrk/grokbot-desk.git
cd grokbot-desk
./report-shell --help
```

## Your first desk

Save the JSON as `payload.json` in the clone folder. `created` is the current local time, with its numeric offset. The sample below is a shape. Replace `created` before you send it. A report expires 240 minutes after `created` unless the payload sets `expires_minutes`.

PowerShell:

```powershell
(Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
```

macOS:

```bash
date '+%Y-%m-%dT%H:%M:%S%z'
```

The PowerShell line prints an offset with a colon (`+02:00`). The macOS line prints `+0200`. The desk accepts both.

```json
{
  "schema": "grokbot-desk/payload@2",
  "bot": "inbox-agent",
  "identity": {
    "name": "Inbox Agent",
    "avatar_shape": "squircle",
    "avatar_color": "blue"
  },
  "title": "Two requests need a decision",
  "created": "2026-10-18T09:00:00+02:00",
  "why": "Approve means go ahead. Reject means no. Later means ask again next week.",
  "ask": "approve",
  "blocks": [
    {
      "type": "decide",
      "id": "requests",
      "labels": {"approve": "Approve", "reject": "Reject", "later": "Next week"},
      "items": [
        {"id": "travel", "title": "Workshop travel", "meta": "Events team"},
        {"id": "laptop", "title": "Replace a developer laptop"}
      ]
    }
  ]
}
```

Check it, then open the desk:

```bash
python report_shell.py check payload.json
python report_shell.py show --data payload.json
```

`check` prints `ok`, or the first problem as `pointer: message`. `show` returns at once with one JSON line: `run_id`, `url`, `result_path`, and `data_dir`. The URL is on `127.0.0.1`. Flags such as `--focus` and `--no-window` are in the [reference](docs/REFERENCE.md#show).

Decide in the window, then read the result. Replace `RUN_ID` with the id from `show`:

```bash
python report_shell.py wait RUN_ID --timeout 60
python report_shell.py result RUN_ID
```

`wait` prints `status`, `result_path`, and `data_dir`. `result` prints the decision JSON. For this sample, `submit` means they finished the list. Pay a row only when its `choice` is `approve`. That wait is for this turn. A bot that should hear about the result later uses the [Desk Doorbell](#desk-doorbell). How a bot waits, catches up, and replies is in the [skill](skills/grokbot-desk/SKILL.md).

## Use with Grok Bot

The skill is [`skills/grokbot-desk/SKILL.md`](skills/grokbot-desk/SKILL.md) in the clone. Each bot reads that file from the clone path. Do not paste a copy into the bot. The next update then arrives when the bot reads the file again.

1. Finish [Quick start](#quick-start) on the computer whose screen you look at. [Manual install](#manual-install) is the same desk without the doorbell bot. The desk runs on that computer.
2. Tell each bot the clone folder, and to read `skills/grokbot-desk/SKILL.md` there.
3. Tell your bot: "When you need a decision from me, or you have a report for me, use grokbot-desk."

Any bot that can run a command in the clone folder can follow [Your first desk](#your-first-desk). The skill is what makes that reliable: when a report beats chat, which `ask` to use, how to wait, and what never belongs in a payload. Set `identity.name` to the bot's exact name in Grok Bot. The desk id must match `^[a-z0-9-]{1,40}$` and be unique. When the slug of the Grok Bot name is not a good id, choose any valid unique id and always set `identity.name` to the exact Grok Bot name. The exact name wins over slugs. The slug rule is in [Desk Doorbell](#desk-doorbell).

## Desk Doorbell

Grok Bot does not wake a bot when a background command finishes. Desk Doorbell is one bot on this computer. [Quick start](#quick-start) installs it. The texts are in [doorbell/README.md](doorbell/README.md).

When a report is submitted, cancelled by you (discarded on the page), or expired, the desk POSTs `{bot, bot_name, run_id, status, title}` to the doorbell webhook. `bot_name` is the payload `identity.name` when the report gives one, otherwise the bot id. A name in the bot registry does not count. A bot's own `cancel` never rings, even when you asked the bot to cancel.

The doorbell picks one Bot. A Bot whose name is exactly `bot_name` gets the message. Otherwise it slugs each Bot name. The slug is lower case. It keeps only ASCII a-z and 0-9. Every run of other characters (spaces, punctuation, umlauts, emoji) becomes one `-`, then `-` at the ends is removed. There is no transliteration. `Work Bot (Alpha)` becomes `work-bot-alpha`. `Büro Bot 🤖` becomes `b-ro-bot`. It matches that slug against `bot_name` and against `bot`. Exactly one match is sent the line below. None or several: it writes `Desk: no Bot named <bot_name>.` in its own chat.

```text
Desk: <title> is <status>. Read the result with report_shell.py result <run_id>.
```

Set `identity.name` to the bot's exact name in Grok Bot. The desk id must match `^[a-z0-9-]{1,40}$` and be unique. A desk id that is the slug of that name also matches. When the slug of the Grok Bot name is not a good id, choose any valid unique id and always set `identity.name` to the exact Grok Bot name. The exact name wins over slugs. The desk retries for about 4 minutes on rate limits, server errors, and a failed connection. A ring can be lost when the desk stops, or when Grok Bot stays busy for minutes. Nothing wakes the bot then. At the start of every turn, doorbell on or off, the bot catches up with `results --since`. If a decision got no reaction, message the bot.

The key stays in `doorbell.json` in the data folder. It is never printed, and it does not belong in a payload or in chat. Only you see "POST to" and "key".

`doorbell` prints `on` or `off`. `on` means the address and key are saved. `doorbell setup` opens the page where you paste those two fields. `doorbell test` writes `Desk: doorbell test received.` in the doorbell's own chat, and that line can arrive minutes late. `doorbell test --to "<name>"` sends `Desk: doorbell test.` to that bot. `doorbell off` deletes the file. Exits, the setup page, and `category` are in the [reference](docs/REFERENCE.md#doorbell).

## Reports

A report is one payload. `ask` says what you want. Blocks are the body. At most one block asks for answers.

| `ask` | What it is for |
| --- | --- |
| `read` | A status, a weekly summary, or a research outcome. The button is Got it. |
| `review` | A draft. Looks good, or request changes. |
| `approve` | You act after a yes: one action, a list of rows, or a post you will publish. |
| `do` | They do the work and report back. |
| `choose` | One option out of two to four. |

Content blocks are text, stats, a table, a chart, facts, checks, media, and copy. A chart always has a "Show data" table. Input blocks are `decide` (one choice per row), `pick` (one option), and `post` (a preview for X, LinkedIn, Instagram, or Facebook). The footer is one composer, reply chips, and the buttons. The full shapes, the button table, and more examples are in the [skill](skills/grokbot-desk/SKILL.md).

`python report_shell.py check payload.json` checks a payload file. It prints `ok`, or the first problem.

## Platforms and limits

Windows and macOS are supported. On any other system the program stops with `unsupported platform`.

The desk opens an Edge or Chrome app window, with its own browser profile in the data folder (`edge-profile` or `chrome-profile`), separate from your everyday profile. On Windows, if neither browser is installed, `show` exits 3 and does not open a tab. On macOS it looks for Edge in `~/Applications`, then Edge in `/Applications`, then Chrome in those two places. If neither application is there, the page opens in the default browser and may be a normal tab. Exit 3 also means a browser was found and the window still failed to open.

`--focus` brings the window forward on Windows. On macOS `--focus` does nothing, and the desk does not raise the window on its own. macOS can also stop a newly installed Python or browser with a security prompt, including Gatekeeper. You approve that prompt yourself. A command that exits 0 does not mean the window is visible.

Text copy on macOS goes through `pbcopy`.

The desk stops itself after 30 minutes with no open report and no page connected to it.

Error lines are UTF-8 when the stream is UTF-8: macOS, and a Windows console. A stream that is not UTF-8, including a default Windows pipe, stays ASCII, and other characters are written as backslash escapes. A Windows pipe whose encoding is UTF-8, for example under `python -X utf8`, stays UTF-8. JSON output is always ASCII-escaped.

Post length and hashtag limits are in the [skill](skills/grokbot-desk/SKILL.md). A limit never blocks a post the person publishes by hand. It can leave an automatic platform out of an approval.

## Privacy and security

The desk listens only on `127.0.0.1`. The port is `18742` unless `config.json` sets `port`. The page loads no remote images, fonts, or sites. Payloads, results, and the action log stay on this machine.

| System | Default data folder |
| --- | --- |
| Windows | `%LOCALAPPDATA%\grokbot-desk` |
| macOS | `~/Library/Application Support/grokbot-desk` |

`RS_DATA_DIR` overrides that folder. `paths` prints the folder in use. On Windows an older folder, `%LOCALAPPDATA%\spqrk-report-shell`, stays in use until you move it. How to move it is in the [reference](docs/REFERENCE.md#migrate). The rest of the folder rules are in the [reference](docs/REFERENCE.md#data-folder).

The doorbell is off until you save a URL and a key with `doorbell setup`. The key stays in `doorbell.json` in the data folder. The desk sends it only as `Authorization: Bearer` on that one webhook, and never prints it. An old `webhook` block in `config.json` is ignored. When the desk starts, it deletes files in `runs`, `results`, and `log` that are older than 30 days. Media and browser profiles are kept.

## Troubleshooting

### The window does not appear

Run `python report_shell.py status`. The first browser start can take a few seconds. If `up` is true and `window_alive` is false after that, the report is registered and the window is not.

Some runtimes end child processes when a command finishes, so the desk exits with the command. Start a terminal that stays open and run:

```bash
python report_shell.py serve
```

Then run `show` again.

Exit 3 means the browser could not be started. On Windows that is usually no Edge or Chrome, and the desk does not open a tab. On macOS a missing Edge or Chrome opens the default browser instead, and a security prompt can block the launch. See [Platforms and limits](#platforms-and-limits).

Exit 4 means the port is taken or the desk did not start. Run `status`, try the command once more, and keep the same port.

### `py -3` cannot find Python

`report-shell.cmd` calls `py -3`. Prefer `python report_shell.py` when `python --version` reports 3.11 or newer. Otherwise use `py -3 report_shell.py` when `py -3 --version` reports 3.11 or newer. On macOS, exit 1 from an old Python means: use `./report-shell`.

### Exit codes

Exit 1 means Python is older than 3.11, or the command crashed. Exit 2 means the payload, the arguments, or the config is invalid. A `port` in `config.json` that is not a number exits 2 when the command uses that port. `--port` overrides it. A config file that is not valid JSON still exits 2. Exit 3 and exit 4 are above. The full list is in the [reference](docs/REFERENCE.md#exit-codes).

## Updating

Run `update`. Read `next`, and do what it says. The desk restarts itself on the next report when that desk has no open report and its version is not this clone's. The same version leaves it running.

```bash
python report_shell.py update
```

On macOS, use `./report-shell update`. The command fast-forwards this clone on its current branch. Releases are on `main`. Testing builds are on `develop`, when you asked for them. A failed update, the fields, and moving an older Windows data folder are in the [reference](docs/REFERENCE.md#update). Ask your bot to update only when you want it to.

## More documentation

`python report_shell.py --help` lists every command, the `--port` and `--version` flags, and a typical flow. The flags that belong to one command are on `python report_shell.py <command> --help`. That help lists the one command. The flow, `--port`, and `--version` stay on the top-level help.

Commands, flags, output, exit codes, envelopes, and the data folder are in the [reference](docs/REFERENCE.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE).

If you like this project, support me by checking out [PhraseVault](https://phrasevault.app) or [BackupOnShutdown](https://backuponshutdown.app).

## Closing note

Dear Grok Bot team: please steal this repo and build it in natively. The MIT license makes that easy.
