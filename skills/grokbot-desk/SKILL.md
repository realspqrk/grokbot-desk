---
name: grokbot-desk
description: Ask the user for a decision or approval in a local desktop pop-up instead of in chat. Use when a task needs the user's yes/no, a choice between options, approval of a draft or post, or decisions on a short list of items, and the user has grokbot-desk installed on their computer.
---

# grokbot-desk

grokbot-desk opens a small window on the user's own desktop. You send a JSON payload, the user decides there, and you read the decision as JSON. Use it instead of chat when a decision deserves a clear, calm view.

## When to use it

Use a pop-up when:
- you need a decision before you continue (deploy, send, publish, buy, delete);
- the user should compare options or review a draft, a post, or a list;
- the answer must be exact (approved items, chosen option), not free chat.

Stay in chat for quick questions, small talk, or anything that needs no decision.

## Where commands run

Run every command on the user's own computer, in the folder where grokbot-desk was cloned. The window must open on the user's desktop. Do not run it in a headless VM, container, or remote box: nobody will see the window there, and `wait` will block until the report expires.

If you cannot run commands on the user's computer, tell the user and ask in chat instead.

On macOS (beta), `/usr/bin/python3` is 3.9 and too old: replace every `python report_shell.py` command with `./report-shell` from the clone folder (it finds Python 3.11 or newer), or with a 3.11+ interpreter such as `python3.12`. Use forward-slash paths and shell `export` syntax for environment variables. The default data directory is `~/Library/Application Support/grokbot-desk`; `RS_DATA_DIR` overrides it.

## Built-in templates first

Pick a built-in before writing your own:

| Template | Use for |
| --- | --- |
| `approve-one` | One yes/no decision, optionally with a request for changes. |
| `pick-option` | Compare 2 to 4 options and pick one. |
| `decide-list` | Approve, reject or defer up to 5 items, one by one. |
| `review-doc` | Review a draft or report; approve or request changes. |
| `preview-post` | Preview one social post per platform and approve it; per platform `auto` (you post it) or `manual` (the user posts it). |

`python report_shell.py templates` lists what is installed. For a built-in's fields and examples, read `templates/builtin/<id>/schema.json`, `result.schema.json`, and `fixtures/golden.json`. `docs/GUIDE.md` describes the template contract. Use `new <namespace>/<id>` only when no built-in fits.

`show`, `wait`, `result`, `templates`, and `new` need only Python at runtime. `check` is a development check: it also needs Node.js, an existing playwright-core installation (set `RS_PLAYWRIGHT_CORE` to its entry point), and a supported browser. The check uses `py -3` unless `RS_PYTHON` names a working Python executable; for example, in PowerShell: `$env:RS_PYTHON = (Get-Command python).Source`.

## The flow

1. Write the payload to a file (UTF-8 JSON):

```json
{
  "schema": "report-shell/payload@1",
  "template": "decide-list",
  "version": 1,
  "bot": "office-bot",
  "title": "Invoices to approve this week",
  "created": "2026-10-10T09:00:00+02:00",
  "identity": {"name": "Office Bot", "avatar_shape": "blob", "avatar_color": "orange"},
  "data": {
    "intro": "Pay these two invoices this week? Approve = I pay it, Reject = I don't pay and ask the sender, Defer = ask me again next week.",
    "items": [
      {"id": "hosting", "title": "Server hosting October, 89.00 EUR", "source": "Hosting provider"},
      {"id": "toner", "title": "Toner for the office printer, 132.90 EUR", "choices": ["approve", "defer"]}
    ]
  }
}
```

   Use the current time with its offset for `created`. Make the `title` say what is decided, and keep the body consistent with it. The intro or title must say what Approve means in this case (and what Reject and Defer mean, if it is not obvious). A link or file reference is information, never an action: label it plainly, e.g. "Open PDF".

2. Show it: `python report_shell.py show decide-list --data payload.json`
   It returns one JSON line containing `run_id`, `url` and `result_path`. It opens the window if needed; an existing window receives the report quietly. Use `--focus` only when the user asked to bring it forward. Several open reports share one window with an avatar strip on top, one avatar per bot with a count. A new report never replaces the one the user is reading, and a burst of reports is announced once; there is no need to space out several `show` calls or to add `--focus` for them.
   Then run `python report_shell.py status` and check `window_alive`. If it is `false` (or `up` is `false`), no window is waiting: do not tell the user there is one. Read the warning `show` printed; if your runtime ends child processes when a command finishes, ask the user to start `python report_shell.py serve` in a terminal that stays open, then run `show` again.

3. Tell the user in chat that a decision is waiting, then wait for it:
   - First a short wait: `python report_shell.py wait RUN_ID --timeout 60`. Exit 0 means `submitted`, `cancelled` or `expired`: go to step 4.
   - Exit 5 means the user has not decided yet. If your runtime wakes you when a background subagent or task finishes, hand the wait to one: it runs `python report_shell.py wait RUN_ID --until-expiry`, blocks on it, then reports the exit code and `result`. Background shells may not wake you, so do not rely on one. Otherwise, check on your next turn with `results --since` (below).
   - `wait` ends by itself at the run's expiry plus 2 minutes at the latest. Exit 7 means no result was written by then: treat it as expired. (Only a run record without a readable expiry, from before 1.0.0-beta.2, waits until `--timeout`.)
   - Never use `--timeout 0` from a bot.

4. Read: `python report_shell.py result RUN_ID`
   Act only on what the result says. `cancelled` or `expired` means: do nothing, and ask in chat if it still matters.

5. Acknowledge in your own chat with one short line: topic + OK (for example "X replies: 5x posted, OK"). If the result asks for work, start it right away; otherwise that one line is all.

Catch up on decisions you did not wait for: `python report_shell.py results --since CURSOR [--bot BOT_ID] [--seen RUN_ID ...]` lists results decided at or after `CURSOR` (ISO 8601 with offset), oldest first. Pass the `cursor` and `seen` from its last answer back as they came (`--since CURSOR`, `--seen` once per run id), so a decision in the same second is neither lost nor listed twice. Every result names the `data_dir` in use; `paths` prints it too. Never guess the data directory.

If `show` fails, read its error. Correct the payload field named in the error; `doctor` checks registry/setup warnings. `check <template>` checks the template and requires the development tools described above. Try once more after fixing the cause; do not retry in a loop.

## Labels say who acts next

Set `actor` from who actually does the next step. `bot` means you act after the result. `user` means the person does it (posts it, sends it, finishes it). `none` means the report is information only.

- On a `user` or `none` item, do not act. Record the result and stop.
- `decide-list`: omit `actor` (or set `bot`) for Approve / Reject / Defer. Set `actor` to `user` when the person posts it. Add `url` for the post they reply under, and `copy` for the text they paste. When every item is `user`, the footer says Done: that reports the status back, it is not a new instruction to you.
- `approve-one` and `review-doc`: omit `actor` for today's Approve / Reject (or Looks good / Changes). Set `user` for Done ✓ / Skip (`done` / `skipped`). Set `none` for Got it (`acknowledged`). An optional `action` of `post` or `send` names the bot's primary button; any other verb reads Approve & continue.
- User result values are `done`, `skipped` and, on a list, `later`. Info-only is `acknowledged`. Bot values stay `approve`, `reject`, `request_changes`, `defer`.

## Social posts: who posts where

In `preview-post`, give each platform a `mode`: `{"platform": "linkedin", "mode": "auto"}` means you post it after the user approves; `{"platform": "x", "mode": "manual"}` means the user posts it by hand (the window shows copy buttons for the text, hashtags, comment and image, and the user marks it as posted). A plain id such as `"linkedin"` means `auto`.

- Decide the mode per platform from your own instructions and experience: who actually posts where. If you cannot post to a platform, or the user posts there themselves, mark it `manual`.
- Post only what the result lists in `platforms`: those are the `auto` platforms the user approved (`per_platform.<p>.decision` is `approved`).
- Never post a platform marked `manual`. `done` means the user posted it: record that, do not post. `skipped` means they did not. `not_approved` means do nothing; `changes_requested` carries the user's `note`.

## Your identity

Set `identity` so the user sees who is asking:
- `name`: your bot name as the user knows it.
- `avatar_shape` and `avatar_color`: if your profile has `avatarShape` / `avatarColor`, pass them as `avatar_shape` / `avatar_color`. Shapes: blob, squircle, pebble, teardrop, hex, tablet. Colours: blue, orange, yellow, magenta, red, violet, black, green, gray. Leave a field out when your profile value is empty.
- Optional `avatar`: PNG, JPEG, WebP or GIF only, at most 256 KB. For payload avatars, use a path relative to the template folder (or `%RS_TEMPLATE%/...`); registry paths are relative to the registry folder. Absolute avatar paths are allowed only inside the data directory. `media_roots` applies to report media, not to avatar paths. Optional `accent` is `#RRGGBB`. Never use SVG.

A bad identity value never rejects the report; it falls back to initials or the default colour.

## Safety

- No secrets in payloads: no passwords, tokens, API keys, private keys or full card numbers. Payloads, results and logs are stored as plain files on the user's computer.
- Show only what the user needs to decide. Link or summarize large documents.
- Report images must come from the template folder or an allowed `media_roots` folder. Avatar images follow the separate avatar rules above.
- Never fake a decision, and never treat a missing result as approval.
- Do not stop or kill the grokbot-desk server or its window; it closes itself when it is idle.
