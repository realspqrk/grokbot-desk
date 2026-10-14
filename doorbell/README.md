# Desk Doorbell

Grok Bot does not wake a bot when a background command finishes. Each bot has one conversation. A bot wakes when one of its routines runs, or when another bot sends it a message.

Desk Doorbell is one bot for [grokbot-desk](https://github.com/realspqrk/grokbot-desk) on one computer. It sets up the desk, relays each ring to the named bot, and keeps the clone current once a week.

The desk sends the webhook routine a JSON object. A decision has `status`, `bot`, `bot_name`, `run_id`, and `title`. A plain test is only `{"status": "test"}`. An addressed test adds `bot_name`.

`status` is `submitted`, `cancelled`, `expired`, or `test`. On a decision, `bot_name` is the payload `identity.name` when the report gives one, otherwise the bot id. A name in the bot registry does not count. A bot's own `cancel` never rings, even when the person asked the bot to cancel.

The doorbell picks the Bot with three steps.

1. A Bot whose name is exactly `bot_name` gets the message.
2. Otherwise it slugs each Bot name. The slug is lower case. It keeps only ASCII a-z and 0-9. Every run of other characters (spaces, punctuation, umlauts, emoji) becomes one `-`, then `-` at the ends is removed. There is no transliteration. `Work Bot (Alpha)` becomes `work-bot-alpha`. `Büro Bot 🤖` becomes `b-ro-bot`. It matches that slug against `bot_name` and against `bot`.
3. Exactly one match gets the message. None or several: Desk Doorbell writes in its own chat exactly `Desk: no Bot named <bot_name>.`

A plain test has no `bot_name`. Desk Doorbell writes this line in its own chat and nothing else. The line can arrive minutes late.

`Desk: doorbell test received.`

A decision sends the chosen Bot one line:

`Desk: <title> is <status>. Read the result with report_shell.py result <run_id>.`

That bot reads the result and continues. Desk Doorbell does not decide.

An addressed test sends the chosen Bot only:

`Desk: doorbell test.`

That bot sees the line within a minute.

The desk runs from a clone of https://github.com/realspqrk/grokbot-desk on the computer you look at. On Windows the command is the Python call from setup plus `report_shell.py`. That call is `python` when it reports 3.11 or newer, otherwise `py -3`. `report-shell.cmd` runs `py -3`. On macOS the command is `./report-shell`. After the clone exists, `doorbell/` in the clone is the source of truth. Once a week the bot compares those files with its own description, skills, and routine texts. It updates its routine instructions with its routine tool, and it updates its skills and description when its tools allow it. It keeps each routine's trigger, webhook address, key, and schedule. It never creates a second webhook routine. It never re-imports the template and never installs a second Desk Doorbell. Anything it cannot change itself, it names in one line and says which file. The webhook routine text is refreshed from the clone on that check, and the bot follows that text exactly.

Only you see "POST to" and "key", under Desk Doorbell, then Routines, then the webhook routine. Paste them on the page that `doorbell setup` opens. Leave them out of chat.

A command on your computer shows an approval card. Approve it, or set Always allow if you want these commands to run without a card.

## Install

1. Open the template: [Desk Doorbell](https://x.ai/bot/Q_-PLlmHrV1l2h3Tk1ejJ).
2. Choose Add to Grok Bot.
3. The first chat starts setup. Approve the commands. Say yes when the bot asks to turn on its two routines.

The bot checks Windows or macOS, Python 3.11 or newer, git, and Edge or Chrome by command. On Windows it runs `python --version` and `py -3 --version`, remembers the call that reports 3.11 or newer (`python` first, otherwise `py -3`), and uses that call afterwards. After a winget install, if `python` or `git` still cannot be found, it asks you to restart Grok Bot, because the app keeps the old PATH, and it does not install a second time. On macOS, after `brew install python@3.12`, it checks `python3.12 --version`, and also `/opt/homebrew/bin/python3.12` and `/usr/local/bin/python3.12`. It accepts any 3.11 or newer.

It clones https://github.com/realspqrk/grokbot-desk into the path you give. When that path is already a clone, it runs `--help`. If the help lists `update`, it runs `update` and does not run `git pull`. If the help has no `update` (a beta before 1.0.0-beta.3), it bootstraps that clone once. `git status --porcelain` must be empty, and the branch must not be detached. It then runs `git pull --ff-only`. It never re-clones, never discards work, and never switches branch. On macOS it then confirms `./report-shell --help`. The launcher finds `python3.12` itself. It then opens the desk setup page.

You read "POST to" and "key" in the desktop app: Desk Doorbell, then Routines, then the webhook routine. The bot cannot read them.

Confirm with one work bot. `doorbell test --to "<name>"` sends `Desk: doorbell test.` to that bot, within a minute. A plain test line in the doorbell chat can arrive minutes late.

The bot then tells each work bot the clone folder, the Windows Python call it remembered (`python report_shell.py` or `py -3 report_shell.py`), and to read `skills/grokbot-desk/SKILL.md` from that clone (not a pasted copy). It tells the bot to set `identity.name` to its exact Grok Bot name. The desk id must match `^[a-z0-9-]{1,40}$` and be unique. When the slug of that name is not a good id, choose any valid unique id and still set `identity.name` to the exact name. The exact name wins over slugs.

## Publish

Use this when you change the template. Keep the same public link.

1. Open the Desk Doorbell bot that owns https://x.ai/bot/Q_-PLlmHrV1l2h3Tk1ejJ.
2. Set the profile description to the whole text of `description.md`. That description is the bot's instructions.
3. Add or replace three skills from `skills/`. `getting-started`, `desk-setup`, and `desk-update`. The `name` and `description` at the top of each file are the skill fields. The rest is the skill text. `getting-started` is the first conversation after install.
4. Set the two routines in `routines.md`. Copy the name, slug, description, and content as written. Do not add a second webhook routine.
5. Open Share, then the template action. If Grok Bot offers a new version of this template, publish that version and keep the link https://x.ai/bot/Q_-PLlmHrV1l2h3Tk1ejJ.

On install, Grok Bot creates the routines again. They are paused, and they get new ids. The person turns them on by saying yes.
