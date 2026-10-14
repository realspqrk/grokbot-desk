# Review doc

A document to read and answer. The bot can send it on, the person can do it, or it can be information only. A status, a weekly summary, or a research outcome uses this template with `task.kind` `fyi`, even when the document is short.

The shell draws the header, the task banner, and the footer. The template fills the page. German is the default UI (`core/i18n/de.json`). `RS_LANG=en` selects the English strings below.

## What the person sees

An optional summary, up to four copy values, then the document. Markdown is the default. Plain `text` keeps line breaks. Only a bold paragraph in the document's lead moves ahead of the copy texts. A bold word later in the document stays where it is. The person can comment on a section and write an overall comment. A long document scrolls inside the report. The header and the footer stay.

Who acts next comes from `actor` (default `bot`):

- `bot`: Looks good, or Approve & post / Approve & send / Approve & continue when `action` is set. Request changes is the other decision. Results are `approve` or `request_changes`.
- `user`: the person does it and reports back. With no explicit `task.kind`, the primary reads Sent ✓ when `action` is `send`, and Done ✓ otherwise. An explicit `task.kind` of `post_yourself` reads Posted ✓, including when `action` is `send`. Results stay `done` or `skipped`.
- `none`: Got it, plus one optional note. No section comments. The result is `acknowledged`.

`action` `post` and `send` name the bot primary. Any other verb becomes Approve & continue. Without `action` the primary is Looks good.

Write a document that can be scanned: a one-line summary first, then a table, bold verdicts, check states, at most one callout, and the long detail last. `fixtures/edge-report.json` is the model.

## Payload data

```json
{
  "summary": "Please review the garden note before Friday.",
  "doc": "## Plot fees\n\nFees are listed per year.\n"
}
```

| Field | Rule |
|---|---|
| `doc` | Required. 1 to 60000 characters. Raw HTML is shown as text. |
| `summary` | Optional. 1 to 600. http(s) addresses become links. |
| `actor` | `bot` (default), `user`, or `none`. |
| `action` | Optional. `^[a-z][a-z0-9-]{0,23}$`. |
| `copy` | Optional. At most 4. Each has `label` (1 to 24) and `text` (1 to 5000). |
| `format` | `markdown` (default) or `text`. |
| `images` | Optional. At most 8, unique `key`. Markdown shows them with `![alt](key)`. Any other image target, including a web address, is a quiet placeholder. |

Each image has `key` (`^[a-z0-9][a-z0-9_-]{0,31}$`), `path` (an image under a media root, `x-rs-media`), and `alt` (1 to 200). `alt` is used when the Markdown gives none. A `%RS_TEMPLATE%` image path is read from this template's folder and does not have to sit under a media root.

Markdown covers headings, paragraphs, emphasis, inline code, code blocks, lists, quotes, tables, rules, links as text, and images by media key. A callout is a quote whose first line is one of `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`. http(s) links open in the system browser. Other link targets stay text.

## Result data

`approve` requires an empty overall `comment`. Section comments are allowed. `request_changes` needs a non-blank overall comment, or a blank comment plus at least one section comment. `done`, `skipped`, and `acknowledged` allow an optional comment. Section comments are `{section, heading, comment}` in document order. `section` is the 1-based index among the document's sections (1 to 200). `heading` is at most 200 characters. `comment` is 1 to 2000 and must contain a non-space character.

Approving the short document above, which has one section and no comments:

```json
{
  "decision": "approve",
  "comment": "",
  "comments": []
}
```

Asking for a change to that same document, with no section comment:

```json
{
  "decision": "request_changes",
  "comment": "Please name the fee year.",
  "comments": []
}
```

## Keyboard path

Tab moves through the document. Comment on a section opens a note for that section. An empty section note closes on blur or Esc and is left out. A blank section comment is rejected. Request changes opens the overall comment only when no section comment already gives a reason. Otherwise the overall note stays collapsed, and focus stays on the request. Looks good sends an approval, and the overall comment stays empty. Ctrl+Enter or Cmd+Enter sends. The exact golden key sequence is in `fixtures/expect/golden.json`.

## Files

`template.json`, `template.html`, `template.css`, `template.js`, `schema.json`, `result.schema.json`, `fixtures/golden.json`, `fixtures/edge-*.json`, `fixtures/invalid-*.json`, `fixtures/expect/golden.json`, and this README. Media roots and the result envelope are in [docs/GUIDE.md](../../../docs/GUIDE.md).

## For maintainers

### Strings used

| Key | English |
|---|---|
| `rd_doc_label` | Document |
| `rd_words` | {n} words |
| `rd_words_one` | 1 word |
| `rd_minutes` | {n} min read |
| `rd_sections` | {n} sections |
| `rd_sections_one` | 1 section |
| `rd_comment` | Comment |
| `rd_comment_for` | Comment on “{what}” |
| `rd_comment_label` | Comment on “{what}” |
| `rd_with_comments` | {n} comments go with your approval |
| `rd_with_comments_one` | 1 comment goes with your approval |
| `rd_copy_markdown` | Copy Markdown |
| `rd_image_missing` | Image not shown: {alt} |
| `rd_callout_note` | Note |
| `rd_callout_tip` | Tip |
| `rd_callout_important` | Important |
| `rd_callout_warning` | Warning |
| `rd_callout_caution` | Caution |
| `sep_list` | ` · ` |
| `copy_text` | Copy text |
| `copied` | Copied ✓ |
| `copy_failed` | Copy failed |
| `clipboard_busy` | Clipboard busy, please click again |
| `approve` | Approve |
| `request_changes` | Request changes |
| `request_changes_ask` | Request changes |
| `looks_good` | Looks good |
| `done_check` | Done ✓ |
| `skip` | Skip |
| `got_it` | Got it |
| `add_a_note` | Add a note |
| `note` | Note |
| `approve_post` | Approve & post |
| `approve_send` | Approve & send |
| `approve_continue` | Approve & continue |
| `task_done` | Done |
| `task_open` | Open |
| `copy` | Copy |
| `request_changes_label` | What should change? |
| `send_request` | Send request |
| `cancel` | Cancel |
| `comment_required` | Please write a comment to request changes |

### Test hooks

Payload `copy` entries use `data-copy-id="copy-1"` and so on, 1-based. A code block copies as `code-<n>`. A quote copies as `quote-<n>`. The golden expect records no copies (`copies` is `{}`).

### Golden result

The golden fixture's document has more than one section. Its result asks for changes on section 4:

```json
{
  "decision": "request_changes",
  "comment": "Looks good. Please fix the fee note, then send it on Friday.",
  "comments": [
    {
      "section": 4,
      "heading": "Plot fees",
      "comment": "Say that the fees are per season, not per year."
    }
  ]
}
```
