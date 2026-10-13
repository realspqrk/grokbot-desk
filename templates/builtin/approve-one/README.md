# `approve-one`: one yes/no decision with details

Built-in template. Use it for **one** decision that needs a recorded yes or no: a production deploy, a purchase, an access request, a contract renewal. Set `allow_changes` when "not like this" is a useful third answer. For several items use `decide-list`.

```
py -3 report_shell.py show approve-one --data payload.json
py -3 report_shell.py wait <run_id> --timeout 120
```

## What the person sees

- The `summary` first (as the why of the task banner above the title, unless the payload brings its own `task.why` or the summary has a link). With `checks`, one line sums them up before the facts: `3 ok · 1 warning: Bundle size`. Warnings and failures are named there, so nothing that needs a look waits below the fold. Then the key `facts` as label/value pairs and the `copy` values next to copy icons.
- The footer is the decision, one click each. The primary approves: `Approve & post`, `Approve & send` or `Approve & continue` (from `action`; `approve_label` overrides that phrase). There is no plain `Approve` default. The quiet alternatives are `Reject` and, with `allow_changes`, `Request changes`. Ctrl+Enter presses the primary.
- `Reject` sends at once and needs no reason.
- `Request changes` opens the comment field (`What should change?`) and moves the focus there. The primary becomes `Send request`; `Cancel` goes back. While the comment is empty the primary is disabled and the status reads `Please write a comment to request changes`.
- A user action (`actor: user`): the primary is the mark (`Posted ✓`, `Sent ✓` or `Done ✓`), the alternative `Skip`, plus `Request changes` with `allow_changes`. Information only (`actor: none`): just `Got it`.
- `Add note` (shown on hover and keyboard focus, below the report) opens an optional note. It travels with whichever button is pressed while it is shown. What is visible is what is sent: a note that is not shown is never part of the result.
- The report: `points` as a quiet list (heading `points_title`, default `Details`), `checks` with status dots (ok, needs a look, failed; never behind a disclosure) and the `reference` text behind a closed disclosure with its own copy icon.
- A started change request, its comment and a shown note are kept as a draft and come back after a reload, including the information-only note (its disclosure may stay closed). A sent report shows the sent comment or note, read-only.

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
| `summary` | required, 1–600, plain text (newlines kept). An http(s) address in the text becomes a link |
| `actor` | optional `bot` (default), `user` or `none`. `user`: the mark names what the person did. Posted ✓ for a post (`task.kind` `post_yourself`), Sent ✓ when `action` is `send`, Done ✓ only when there is no specific content or action. Results stay `done` / `skipped`. `allow_changes` adds Request changes. `none`: only Got it, sent at once (`acknowledged`), plus one collapsed note. The bot never acts on `user` or `none`. A payload `task.kind` sets the actor when left out (`post_yourself` = `user`, `fyi` = `none`) |
| `action` | optional verb, `^[a-z][a-z0-9-]{0,23}$`. For a bot decision, `post` labels the primary Approve & post, `send` labels it Approve & send, any other verb labels it Approve & continue. For a user decision, `send` labels the choice Sent ✓ |
| `approve_label` | optional, 1–24; the label of the approving primary for the bot, instead of the action phrase (Approve & continue, or Approve & post / send). There is no plain Approve default |
| `allow_changes` | optional boolean, default `false`; offers `Request changes` as a second quiet alternative |
| `facts[]` | optional, at most 6 of `{label 1–32, value 1–120, mono?}` |
| `copy[]` | optional, at most 3 of `{label 1–24, text 1–2000}`; each value is shown in full next to its button |
| `points_title` | optional, 1–40 |
| `points[]` | optional, at most 8 strings of 1–160 |
| `checks[]` | optional, at most 8 of `{label 1–80, detail? 1–120, state ok\|warn\|fail}`; summed up in one line before the facts |
| `reference` | optional `{title 1–40, label 1–24, text 1–2000, mono?}`; behind a closed disclosure |

Empty sections are not rendered. Payload text keeps its language: the window does not translate it, so write it in the person's language (see `fixtures/edge-de.json`).

## Result `data` (`result.schema.json`, oneOf)

```json
{ "decision": "approve", "comment": "" }
```

```json
{ "decision": "request_changes", "comment": "Please deploy after the Friday sale ends." }
```

- `approve` or `reject` (actor `bot`): `comment` 0–2000 (the optional note; `""` when no note was shown). Reject needs no reason.
- `done` or `skipped` (actor `user`), and `acknowledged` (actor `none`): `comment` 0–2000.
- `request_changes` (bot or user, only with `allow_changes`; not offered for information only): `comment` 1–2000 with at least one non-whitespace character. Information only may include the optional note as `comment`, sent only while the note is open.
- A discarded or expired report gives `cancelled` / `expired` and no `data`: do nothing.

## Strings used (`core/i18n/en.json`, `de.json`)

| Key | English | German |
|---|---|---|
| `approve_post`, `approve_send`, `approve_continue` | Approve & post, Approve & send, Approve & continue | Freigeben & posten, Freigeben & senden, Freigeben & weiter |
| `choice_reject`, `request_changes` | Reject, Request changes | Ablehnen, Änderungen anfordern |
| `posted`, `sent_mark`, `done_mark`, `skip`, `got_it` | Posted ✓, Sent ✓, Done ✓, Skip, Got it | Gepostet ✓, Gesendet ✓, Erledigt ✓, Überspringen, Verstanden |
| `request_send`, `cancel` | Send request, Cancel | Anfrage senden, Abbrechen |
| `add_note`, `add_a_note`, `note` | Add note, Add a note, Note | Notiz hinzufügen, Notiz hinzufügen, Notiz |
| `request_changes_label`, `comment_required` | What should change?; Please write a comment to request changes | Was soll sich ändern?; Für Änderungen bitte einen Kommentar schreiben |
| `ao_checks_ok`, `ao_checks_warn_one`, `ao_checks_warn`, `ao_checks_fail_one`, `ao_checks_fail` | {n} ok; 1 warning: {names}; {n} warnings: {names}; 1 failed: {names}; {n} failed: {names} | {n} ok; 1 Warnung: {names}; {n} Warnungen: {names}; 1 fehlgeschlagen: {names}; {n} fehlgeschlagen: {names} |
| `section_details`, `section_checks` | Details, Checks | Details, Prüfungen |
| `check_ok`, `check_warn`, `check_fail` | passed, needs a look, failed (spoken names of the dots) | bestanden, bitte ansehen, fehlgeschlagen |

Copy labels, fact labels, `points_title`, `reference.title` and `approve_label` come from the payload.

## Test hooks

- Copies: `data-copy-id="copy-<n>"` (1-based) and `data-copy-id="reference"` (inside the disclosure).
- The checks line `[data-ao="checksum"]`; the note/comment `#ao-comment` behind `[data-ao="note-open"]`.
- The footer alternatives in order: `#rs-alt` (Reject or Skip), `#rs-alt-2` (Request changes, with `allow_changes`); in a change request `#rs-alt` is Cancel.

## Keyboard path (golden, one open report)

Tab ×5 passes the `…` menu, the `Rollback` disclosure, `Add note` and `Reject`, and reaches `Request changes`. Space opens the comment field and moves the focus into it; type the comment; Ctrl+Enter sends the request. For an approval: Ctrl+Enter alone.

## Files

| File | Notes |
|---|---|
| `template.json` | manifest (namespace `global`) |
| `template.html`, `template.css`, `template.js` | calm kit only: tokens, `rs-action-row`, `rs-copy` |
| `schema.json`, `result.schema.json` | payload and result (oneOf) |
| `fixtures/golden.json` | a production deploy with changes allowed: facts, points, checks, rollback reference |
| `fixtures/edge-access.json` | an access request (yes/no only): copies, points, checks with a warning |
| `fixtures/edge-de.json` | the golden deploy written in German (`Deployment freigeben`) |
| `fixtures/edge-minimal.json` | the summary only |
| `fixtures/edge-max.json` | every field at its maximum |
| `fixtures/invalid-no-summary.json` | rejected (missing `summary`) |
| `fixtures/invalid-check-state.json` | rejected at `/checks/1/state` |
| `fixtures/expect/golden.json` | copy, `flow`, `keyboard`, `result` |
| `fixtures/expect/edge-access.json`, `edge-de.json`, `edge-max.json` | every copy string |
