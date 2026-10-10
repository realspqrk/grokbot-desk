# `review-doc`: review a document

Built-in template for one document the person should read and then approve, or send back with comments: a draft, an announcement, a report, a reply. The agent's short lead sits on top, then quiet reading facts (`640 words · 3 min read · 5 sections`), then the document itself in a 72ch reading column.

- **Approve** is the primary (Ctrl+Enter).
- **Request changes** is the footer's quiet alternative. It opens one overall comment (*What should change?*, with *Cancel*), and the primary becomes *Send request*.
- **Comment on a section:** every section heading carries a *Comment* action that shows on hover or keyboard focus. It opens a comment field under that heading. An empty field closes again when it loses focus (or with Esc). Section comments go with either decision; the status line says how many go with an approval.
- The overflow menu (`…`) has *Copy Markdown* (or *Copy text*) for the whole source.

Pick this template when the person has to **read** something. For one yes/no decision with a few facts, use `approve-one`; for several items, `decide-list`.

## Payload `data` (`schema.json`)

```json
{
  "summary": "Draft of the spring opening announcement for members. I added the plot fees and moved the sign-up deadline to 20 March. Approve it, or tell me what to change before it goes out on Friday.",
  "format": "markdown",
  "doc": "# Spring opening at Larkspur Community Garden\n\nThe gates open again on **Saturday, 4 April**. …\n\n## Plot fees\n\n| Plot | Size | Season fee |\n|---|---:|---:|\n| Small | 10 m² | €35 |\n…"
}
```

| Field | Rule |
|---|---|
| `summary` | optional, 1–600 characters, plain text: what the document is and what to look at |
| `format` | optional, `markdown` (default) or `text` |
| `doc` | required, 1–60 000 characters |
| `images` | optional, at most 8 `{ "key", "path", "alt" }`; `key` matches `^[a-z0-9][a-z0-9_-]{0,31}$` and is unique (`x-rs-unique-key`), `path` is a media path (`x-rs-media`: absolute, under a media root, png/jpg/jpeg/webp/gif, at most 20 MB), `alt` 1–200 characters |

### The Markdown subset

Rendered: ATX headings (`#` to `######`) and setext headings, paragraphs (a single line break is a space; two trailing spaces or `\` make a hard break), `**strong**`, `*em*` / `_em_`, `~~strike~~`, `` `code` ``, fenced code blocks (no highlighting), bullet and numbered lists (nested by indentation), `>` quotes, `---` rules and pipe tables (with `:--`, `:-:`, `--:` alignment).

Safe by construction:

- **No raw HTML.** Tags such as `<b>` or `<script>` are shown as text; the page builds every node itself and uses `textContent` only.
- **No links.** `[label](address)` shows the label, then the address as quiet text in brackets. Nothing is clickable, nothing is fetched.
- **No external images.** `![alt](key)` shows an image only when `key` names an entry in `images`; the page loads it through the media route (`RS.media`). Any other target, including a web address, becomes a quiet *Image not shown: alt*.
- **Bounded nesting.** Links and emphasis nested more than 16 levels deep stay literal text (the Markdown source as written), so every accepted document renders and can be approved.

With `"format": "text"` the document is shown as plain text: blank lines separate paragraphs and every line break is kept (letters, replies).

### Sections

When the document has at least two headings of level 1–2, each of those headings starts a section (otherwise level 1–3; otherwise there are no sections and only the overall comment exists). Text before the first section heading belongs to no section. At most 200 sections take comments; later headings are rendered without the action.

## Result `data` (`result.schema.json`)

```json
{
  "decision": "request_changes",
  "comment": "Looks good. Please fix the fee note, then send it on Friday.",
  "comments": [
    { "section": 4, "heading": "Plot fees", "comment": "Say that the fees are per season, not per year." }
  ]
}
```

| Field | Rule |
|---|---|
| `decision` | `approve` or `request_changes` |
| `comment` | overall comment, at most 4000 characters; `""` for `approve` |
| `comments` | section comments in document order, at most 200: `section` (1-based position among the sections), `heading` (plain text, at most 200 characters), `comment` (1–2000 characters). Empty sections are left out. |

`approve` may carry section comments ("approve, and fix these small things"). `request_changes` needs the overall comment or at least one section comment.

## Strings

English and German tables (`core/i18n/en.json`, `core/i18n/de.json`): `rd_doc_label` (Document / Dokument), `rd_words` ({n} words / {n} Wörter), `rd_words_one` (1 word / 1 Wort), `rd_minutes` ({n} min read / {n} Min. Lesezeit), `rd_sections`, `rd_sections_one`, `rd_comment` (Comment / Kommentieren), `rd_comment_for` (accessible name of the action), `rd_comment_label` (Comment on “{what}” / Kommentar zu „{what}“), `rd_waiting`, `rd_with_comments`, `rd_with_comments_one`, `rd_copy_markdown`, `rd_image_missing`; shared: `approve`, `request_changes`, `request_changes_label`, `send_request`, `cancel`, `comment_required`, `copy_text`, `copied`, `copy_failed`, `clipboard_busy`, `sep_list`.

## Fixtures

| File | What it covers |
|---|---|
| `golden.json` | announcement draft, 5 sections, list, table, link |
| `edge-max.json` | long season report: 8 sections, nested and numbered lists, two tables, a quote, a code block, a rule, strike-through, a media image (`fixtures/media/harvest-chart.png`, via `%RS_TEMPLATE%`) |
| `edge-plain.json` | `format: text`: a reply letter, no sections, line breaks kept |
| `edge-html.json` | pasted HTML (`<p>`, `<b>`, `<script>`, `<a>`), a web image and links: all shown inert as text |
| `invalid-empty-doc.json`, `invalid-format.json`, `invalid-image-key.json` | rejected at `/doc`, `/format`, `/images/0/key` |
| `expect/golden.json` | `flow` (mouse) and `keyboard` (keys only) both produce the same `result` |

## Keyboard path (golden, one report open)

Tab ×5 reaches *Comment* on section 4 (after the `…` menu and the actions of sections 1–3). Space opens the comment and focuses it; type. Tab ×3 passes section 5 and *Discard* and reaches *Request changes*; Space opens the overall comment and focuses it; type. Ctrl+Enter sends. Arrow keys are not needed anywhere.
