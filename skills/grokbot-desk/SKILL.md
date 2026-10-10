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

On experimental macOS, verify `python3 --version` is 3.11 or newer and replace every `python` command with `python3`. Use forward-slash paths and shell `export` syntax for environment variables. The default data directory is `~/Library/Application Support/grokbot-desk`; `RS_DATA_DIR` overrides it.

## Built-in templates first

Pick a built-in before writing your own:

| Template | Use for |
| --- | --- |
| `approve-one` | One yes/no decision, optionally with a request for changes. |
| `pick-option` | Compare 2 to 4 options and pick one. |
| `decide-list` | Approve, reject or defer up to 5 items, one by one. |
| `review-doc` | Review a draft or report; approve or request changes. |
| `preview-post` | Preview one social post per platform and approve it. |

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
   It returns one JSON line containing `run_id`, `url` and `result_path`. It opens the window if needed; an existing window receives the report quietly. Use `--focus` only when the user asked to bring it forward. Several open reports share one window with an avatar strip on top.
   Then run `python report_shell.py status` and check `window_alive`. If it is `false` (or `up` is `false`), no window is waiting: do not tell the user there is one. Read the warning `show` printed; if your runtime ends child processes when a command finishes, ask the user to start `python report_shell.py serve` in a terminal that stays open, then run `show` again.

3. Tell the user in chat that a decision is waiting. Run `python report_shell.py wait RUN_ID --timeout 120`, using a timeout below your runtime's shell-call limit. Exit 5 means it is still waiting: call `wait` again later in a new shell call. Exit 0 means `submitted`, `cancelled` or `expired`; then read `result`. Use `--timeout 0` only in an interactive terminal without a shell-call limit.

4. Read: `python report_shell.py result RUN_ID`
   Act only on what the result says. `cancelled` or `expired` means: do nothing, and ask in chat if it still matters.

If `show` fails, read its error. Correct the payload field named in the error; `doctor` checks registry/setup warnings. `check <template>` checks the template and requires the development tools described above. Try once more after fixing the cause; do not retry in a loop.

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
