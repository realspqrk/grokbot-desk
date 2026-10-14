# Routines

Create these two routines on the Desk Doorbell bot. Copy the name, slug, description, and content as written.

A template stores this text. On install, Grok Bot creates both routines again. They start paused and get new ids on the new account. The person says yes before either one is turned on. The webhook routine gets its own address and key there. Only the person sees "POST to" and "key". They stay out of chat.

## Desk doorbell

Name: Desk doorbell

Slug: `desk-doorbell-webhook`

Description: When the desk sends a webhook, send one line to the named bot.

Trigger: webhook

Content:

This routine runs on a webhook trigger. The desk sends JSON in one of three shapes. A decision has `status`, `bot`, `bot_name`, `run_id`, and `title`. A plain test is only `{"status": "test"}`. An addressed test is `{"status": "test"}` plus `bot_name`. A test has no run id. Do not read a result for it. `status` is `submitted`, `cancelled`, `expired`, or `test`. `bot` is the desk id. `bot_name` is the name to match. On a decision it is the payload `identity.name` when the report gives one, otherwise the bot id. A name in the bot registry does not count.

When `status` is `test` and there is no `bot_name`, write exactly this line in your own chat and nothing else:

`Desk: doorbell test received.`

That line can arrive minutes late. Do not treat a missing line as a failed setup.

When `bot_name` is present, pick the Bot as follows.

1. A Bot whose name is exactly `bot_name` gets the message.
2. Otherwise slug each Bot name. Use lower case. Keep only ASCII a-z and 0-9. Every run of other characters (spaces, punctuation, umlauts, emoji) becomes one `-`. Trim `-` at the ends. Do not transliterate. `Work Bot (Alpha)` becomes `work-bot-alpha`. `Büro Bot 🤖` becomes `b-ro-bot`. Match that slug against `bot_name` and against `bot`.
3. Exactly one match: send to that Bot. None or several: write in your own chat exactly `Desk: no Bot named <bot_name>.` and nothing else.

When `status` is `test` and a Bot was chosen, send that Bot exactly `Desk: doorbell test.` and nothing else. The person sees that line within a minute.

Otherwise send that Bot exactly this line, with the title, status, and run id from the JSON:

`Desk: <title> is <status>. Read the result with report_shell.py result <run_id>.`

Do not read the result. Do not decide. Do not add a second line. Do nothing else.

## Desk update

Name: Desk update

Slug: `desk-update`

Description: Once a week, fast-forward the grokbot-desk clone and report what changed or what is left.

Trigger: weekly schedule. The person picks the day and time when they turn this routine on.

Content:

This routine runs on a weekly schedule that the person picks. Follow the desk-update skill. Run the update in the clone folder from setup. On Windows use the Python call from setup. On macOS use ./report-shell. Report in one line. After update, compare the clone's doorbell/ texts with your own routine texts, skills, and description. Update your routine instructions with your routine tool. Keep each routine's trigger, webhook address, key, and schedule. Never create a second webhook routine. Update your skills and description when your tools allow it. Anything you cannot change yourself, name in that line so the person can paste it. Say which file. Never re-import the template. Never install a second Desk Doorbell. Do not force the update.
