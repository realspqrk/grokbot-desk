# Approve one

One decision: approve, reject, or ask for changes. The actor can be the bot, the person, or nobody (information only). A single yes or no uses this template.

The shell draws the header, the task banner, and the footer. The template fills the page. German is the default UI (`core/i18n/de.json`). `RS_LANG=en` selects the English strings below.

## What the person sees

The summary, then up to six facts, up to three copy values, up to eight points, and up to eight checks. A longer reference sits in a closed disclosure with its own copy button. No field is required, so a report can be facts and a task banner alone.

Who acts next comes from `actor` (default `bot`):

- `bot`: the primary is Approve & post, Approve & send, or Approve & continue, from `action`. `approve_label` leads the approval banner and replaces that label. Reject is a quiet alternative and sends at once. Request changes, when `allow_changes` is true, opens a comment. The primary becomes Send request. Cancel returns to the decision. The comment is included only while that field is open.
- `user`: the person does the work and reports back. With no explicit `task.kind`, the primary reads Sent ✓ when `action` is `send`, and Done ✓ otherwise. An explicit `task.kind` of `post_yourself` reads Posted ✓, including when `action` is `send`. Skip is the other choice. Request changes stays available when `allow_changes` is true, with the same Send request and Cancel path.
- `none`: Got it, plus one optional note. The result is `acknowledged`. A closed note is not sent. The bot does not act.

Without a `summary`, put the question in `task.why`. The facts then carry the request. A fact label may be 32 characters.

`action` is a verb of 1 to 24 characters: `post`, `send`, or another word such as `deploy`. `post` and `send` name the button. Any other verb, including `deploy`, becomes Approve & continue.

## Payload data

```json
{
  "summary": "Deploy the billing service at version 2.4.0 after the Friday sale.",
  "action": "deploy",
  "allow_changes": true,
  "facts": [
    {"label": "Version", "value": "2.4.0", "mono": true}
  ],
  "points": ["Runs the migration before the app starts."],
  "checks": [
    {"label": "Tests", "state": "ok"},
    {"label": "Sale window", "state": "warn", "detail": "Friday is still open."}
  ],
  "reference": {
    "title": "Rollback",
    "label": "Copy command",
    "text": "deploy rollback --to v2.3.7",
    "mono": true
  }
}
```

| Field | Rule |
|---|---|
| `summary` | Optional. 1 to 600 characters. Plain text. http(s) addresses become links. |
| `actor` | `bot` (default), `user`, or `none`. |
| `action` | Optional. `^[a-z][a-z0-9-]{0,23}$`. |
| `approve_label` | Optional. 1 to 24 characters. Wins over `action` for a bot primary. |
| `allow_changes` | Optional. Default false. Ignored when `actor` is `none`. |
| `facts` | Optional. At most 6. Each has `label` (1 to 32), `value` (1 to 120), and optional `mono`. |
| `copy` | Optional. At most 3. Each has `label` (1 to 24) and `text` (1 to 2000). |
| `points_title` | Optional. 1 to 40. Default heading is Details. |
| `points` | Optional. At most 8 strings, each 1 to 160. |
| `checks` | Optional. At most 8. `label` (1 to 80), `state` `ok`, `warn`, or `fail`, optional `detail` (1 to 120). |
| `reference` | Optional. `title` (1 to 40), `label` (1 to 24), `text` (1 to 2000), optional `mono`. |

## Result data

The payload above is a bot decision with `allow_changes` set, so the person can approve it or ask for changes. `approve`, `reject`, `done`, `skipped`, and `acknowledged` take a `comment` of at most 2000 characters, and the comment may be empty. `request_changes` needs a comment that contains a non-space character. The page offers `request_changes` only when `allow_changes` is true, and never for `actor` `none`. `done` and `skipped` are the user actor. `acknowledged` is `actor` `none`.

Asking for changes on the payload above:

```json
{
  "decision": "request_changes",
  "comment": "Please deploy after the Friday sale ends."
}
```

Approving it:

```json
{
  "decision": "approve",
  "comment": ""
}
```

## Keyboard path

Tab moves through the facts, the checks, and the reference, then to the footer. Request changes opens a comment, and that comment is required. The primary becomes Send request. Cancel returns to the decision. Approve is the primary. Reject is a quiet alternative. Ctrl+Enter or Cmd+Enter sends. The exact golden key sequence is in `fixtures/expect/golden.json`.

## Files

`template.json`, `template.html`, `template.css`, `template.js`, `schema.json`, `result.schema.json`, `fixtures/golden.json`, `fixtures/edge-*.json`, `fixtures/invalid-*.json`, `fixtures/expect/golden.json`, and this README. The task banner and the result envelope are in [docs/GUIDE.md](../../../docs/GUIDE.md).

## For maintainers

### Strings used

| Key | English |
|---|---|
| `choice_reject` | Reject |
| `request_changes` | Request changes |
| `skip` | Skip |
| `got_it` | Got it |
| `approve_post` | Approve & post |
| `approve_send` | Approve & send |
| `approve_continue` | Approve & continue |
| `posted` | Posted ✓ |
| `done_mark` | Done ✓ |
| `sent_mark` | Sent ✓ |
| `add_note` | Add note |
| `add_a_note` | Add a note |
| `note` | Note |
| `request_changes_label` | What should change? |
| `comment_required` | Please write a comment to request changes |
| `request_send` | Send request |
| `cancel` | Cancel |
| `section_details` | Details |
| `section_checks` | Checks |
| `check_ok` | passed |
| `check_warn` | needs a look |
| `check_fail` | failed |
| `ao_checks_ok` | {n} ok |
| `ao_checks_warn_one` | 1 warning: {names} |
| `ao_checks_warn` | {n} warnings: {names} |
| `ao_checks_fail_one` | 1 failed: {names} |
| `ao_checks_fail` | {n} failed: {names} |
| `copy` | Copy |

### Test hooks

Copy values from `copy` use `data-copy-id="copy-1"`, `copy-2`, `copy-3`, in payload order starting at 1. The reference copy is `data-copy-id="reference"`. The golden expect records `reference` as `deploy rollback --to v2.3.7`.
