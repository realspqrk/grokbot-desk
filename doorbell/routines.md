# Routines

Create these two routines on the Desk Doorbell bot. Copy the name, slug, description, and content as written.

A template stores this text. On install, Grok Bot creates both routines again. They start paused and get new ids on the new account. The person says yes before either one is turned on. The webhook routine gets its own address and key there.

## Desk doorbell

Name: Desk doorbell

Slug: `desk-doorbell`

Description: When the desk sends a webhook, send one line to the named bot.

Trigger: webhook

Content:

The desk sends JSON in one of three shapes: a decision ring has `status`, `bot`, `bot_name`, `run_id`, and `title`; a plain test has only `"status": "test"`; an addressed test has `"status": "test"` and `bot_name`. A test never has a run id. Never read a result for it. `status` is `submitted`, `cancelled`, `expired`, or `test`. `bot` is the desk id. `bot_name` is the bot to message. It is the payload `identity.name` when the report gives one, otherwise the bot id.

When `status` is `test` and there is no `bot_name`, write exactly this line in your own chat and nothing else:

`Desk: doorbell test received.`

If `bot_name` is present and no Bot has that name, write in your own chat exactly `Desk: no Bot named <bot_name>.` and nothing else.

Otherwise, when `status` is `test` and there is a `bot_name`, send that bot exactly `Desk: doorbell test.` and nothing else.

Otherwise, send that bot exactly this line, with the title, status, and run id filled in from the JSON:

`Desk: <title> is <status>. Read the result with report_shell.py result <run_id>.`

Do not read the result. Do not decide. Do not add a second line. Do nothing else.

## Desk update

Name: Desk update

Slug: `desk-update`

Description: Once a week, fast-forward the grokbot-desk clone and report what changed or what is left.

Trigger: weekly schedule. The person picks the day and time when they turn this routine on.

Content:

Follow the desk-update skill. Run the update in the clone folder from setup. Report in one line. Never force anything. Do nothing else.
