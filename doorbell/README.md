# Desk Doorbell

Grok Bot does not wake a bot when a background command finishes. Each bot has one conversation. A bot wakes when one of its routines runs, or when another bot sends it a message.

Desk Doorbell is one bot on one computer. It owns a routine with a webhook trigger. The desk rings when a report is submitted, cancelled by the person (discarded on the page), or expired. A bot's own `cancel` never rings, even when the person asked the bot to cancel.

The desk sends that routine a JSON object:

One of three shapes: a decision ring has `status`, `bot`, `bot_name`, `run_id`, and `title`; a plain test has only `"status": "test"`; an addressed test has `"status": "test"` and `bot_name`.

`status` is `submitted`, `cancelled`, `expired`, or `test`. `bot_name` is the payload `identity.name` when the report gives one, otherwise the bot id. A name in the bot registry does not count.

A plain test has no `bot_name`. Desk Doorbell writes this line in its own chat and nothing else:

`Desk: doorbell test received.`

If no Bot has the name `bot_name`, Desk Doorbell writes in its own chat exactly `Desk: no Bot named <bot_name>.` and nothing else.

Otherwise, for a submitted, cancelled, or expired ring, Desk Doorbell sends the bot named `bot_name` one line:

`Desk: <title> is <status>. Read the result with report_shell.py result <run_id>.`

That bot reads the result and continues. Desk Doorbell does not decide.

An addressed test includes `bot_name`. Desk Doorbell sends that bot only:

`Desk: doorbell test.`

The desk runs from a clone of https://github.com/realspqrk/grokbot-desk on the computer you look at. On Windows the command is `python report_shell.py`. On macOS it is `./report-shell`.

## Publish

1. Create a bot. Name it Desk Doorbell.
2. Paste `instructions.md` into the bot's description.
3. Add the two skills in `skills/`. The `name` and `description` at the top of each file are the skill fields. The rest is the skill text.
4. Ask the bot to create the two routines in `routines.md`.
5. Open Share, then Create template, then Public link.

A template stores the profile, the skills, and the routine text. When someone installs it, Grok Bot creates the routines again. They are paused, and they get new ids. The person turns them on by saying yes.

## Install

1. Open the template: [Desk Doorbell](https://x.ai/bot/Q_-PLlmHrV1l2h3Tk1ejJ).
2. Choose Add to Grok Bot.
3. Say "set me up".

The bot asks where the clone is. If there is none, it asks for the full path and clones into that path. It turns on its two routines after you say yes, and opens the desk setup page. You paste the webhook address and the key on that page.

You read both values in the desktop app: Desk Doorbell, then Routines, then the webhook routine. The fields are "POST to" and "key". The bot cannot read them. Leave them out of chat.

A command on your computer shows an approval card. Approve it, or set Always allow if you want these commands to run without a card.
