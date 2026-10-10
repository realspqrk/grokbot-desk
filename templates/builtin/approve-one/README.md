# `approve-one`: one yes/no decision with details

Built-in template. Use it for **one** decision that needs a recorded yes or no: a production deploy, a purchase, an access request, a contract renewal. Set `allow_changes` when "not like this" is a useful third answer. For several items use `decide-list`.

```
py -3 report_shell.py show approve-one --data payload.json
py -3 report_shell.py wait <run_id> --timeout 120
```

## What the person sees

- The `summary` first, then the key `facts` as label/value pairs and the `copy` values next to copy icons.
- Right below: one segmented choice, `Approve` / `Reject` (plus `Request changes` with `allow_changes`). Nothing is preselected; the primary stays disabled with `Please approve or reject` until a choice is made.
- The primary names what will be sent: the payload's `approve_label` (default `Approve`), `Send rejection` or `Send request`. Ctrl+Enter sends too.
- `Add note` (shown on hover and keyboard focus) opens an optional note for Approve or Reject. Picking `Request changes` opens the same field as a required comment (`What should change?`); click, Enter or Space on it moves the focus there, the arrow keys only change the choice. While the comment is empty the primary is disabled and the status reads `Please write a comment to request changes`.
- What is visible is what is sent: a note that is not shown is never part of the result.
- Below the decision: `points` as a quiet list (heading `points_title`, default `Details`), `checks` with status dots (ok, needs a look, failed) and the `reference` text behind a closed disclosure with its own copy icon.
- The decision and the comment are kept as a draft and come back after a reload. A sent report shows the sent decision and comment, read-only.

## Payload `data` (`schema.json`)

```json
{
  "summary": "Release v2.4.0 of the web shop passed staging. Deploy it to production tonight?",
  "approve_label": "Approve deploy",
  "allow_changes": true,
  "facts": [
    {"label": "Version", "value": "v2.3.7 → v2.4.0", "mono": true},
    {"label": "Window", "value": "Today 18:00 to 18:20, low traffic"}
  ],
  "points_title": "What changes",
  "points": ["New checkout flow with saved addresses"],
  "checks": [{"label": "Staging smoke test", "detail": "All 18 user flows OK", "state": "ok"}],
  "reference": {"title": "Rollback", "label": "Copy rollback command", "text": "deploy rollback --to v2.3.7", "mono": true}
}
```

| Field | Rule |
|---|---|
| `summary` | required, 1–600, plain text (newlines kept) |
| `approve_label` | optional, 1–24; the primary's label once `Approve` is picked |
| `allow_changes` | optional boolean, default `false`; offers `Request changes` |
| `facts[]` | optional, at most 6 of `{label 1–24, value 1–120, mono?}` |
| `copy[]` | optional, at most 3 of `{label 1–24, text 1–2000}`; each value is shown in full next to its button |
| `points_title` | optional, 1–40 |
| `points[]` | optional, at most 8 strings of 1–160 |
| `checks[]` | optional, at most 8 of `{label 1–80, detail? 1–120, state ok\|warn\|fail}` |
| `reference` | optional `{title 1–40, label 1–24, text 1–2000, mono?}`; behind a closed disclosure |

Empty sections are not rendered.

## Result `data` (`result.schema.json`, oneOf)

```json
{ "decision": "approve", "comment": "" }
```

```json
{ "decision": "request_changes", "comment": "Please deploy after the Friday sale ends." }
```

- `approve` or `reject`: `comment` 0–2000 (the optional note; `""` when no note was shown).
- `request_changes` (only with `allow_changes`): `comment` 1–2000 with at least one non-whitespace character.
- A discarded or expired report gives `cancelled` / `expired` and no `data`: do nothing.

## Strings used (`core/i18n/en.json`, `de.json`)

| Key | English | German |
|---|---|---|
| `choice_approve`, `choice_reject`, `request_changes` | Approve, Reject, Request changes | Genehmigen, Ablehnen, Änderungen anfordern |
| `decision_label` | Decision (name of the choice row) | Entscheidung |
| `decision_pick` | Please approve or reject | Bitte genehmigen oder ablehnen |
| `add_note`, `note` | Add note, Note | Notiz hinzufügen, Notiz |
| `request_changes_label`, `comment_required` | What should change?; Please write a comment to request changes | Was soll sich ändern?; Für Änderungen bitte einen Kommentar schreiben |
| `send_rejection`, `send_request` | Send rejection, Send request | Ablehnung senden, Änderungen senden |
| `section_details`, `section_checks` | Details, Checks | Details, Prüfungen |
| `check_ok`, `check_warn`, `check_fail` | passed, needs a look, failed (spoken names of the dots) | bestanden, bitte ansehen, fehlgeschlagen |

Copy labels, fact labels, `points_title`, `reference.title` and `approve_label` come from the payload.

## Test hooks

- Copies: `data-copy-id="copy-<n>"` (1-based) and `data-copy-id="reference"` (inside the disclosure).
- Choice row `rs-action-row[data-item="decision"]` with `button[value="approve|reject|request_changes"]`; the note/comment `#ao-comment` behind `[data-ao="note-open"]`.

## Keyboard path (golden, one open report)

Tab ×2 passes the `…` menu and reaches the choice row (on `Approve`). ArrowRight ×2 moves to `Request changes` and opens the comment field; Space confirms and moves the focus into it; type the comment; Ctrl+Enter sends. For an approval: Tab ×2, Space, Ctrl+Enter.

## Files

| File | Notes |
|---|---|
| `template.json` | manifest (namespace `global`) |
| `template.html`, `template.css`, `template.js` | calm kit only: tokens, `rs-action-row`, `rs-copy` |
| `schema.json`, `result.schema.json` | payload and result (oneOf) |
| `fixtures/golden.json` | a production deploy with changes allowed: facts, points, checks, rollback reference |
| `fixtures/edge-access.json` | an access request (yes/no only): copies, points, checks with a warning |
| `fixtures/edge-minimal.json` | the summary only |
| `fixtures/edge-max.json` | every field at its maximum |
| `fixtures/invalid-no-summary.json` | rejected (missing `summary`) |
| `fixtures/invalid-check-state.json` | rejected at `/checks/1/state` |
| `fixtures/expect/golden.json` | copy, `flow`, `keyboard`, `result` |
| `fixtures/expect/edge-access.json`, `edge-max.json` | every copy string |
