# `preview-post`: social post preview and approval

Built-in template. The agent shows one post draft as realistic **X, LinkedIn, Instagram and Facebook** previews from one payload, one platform tab at a time. The reviewer sees the composed text per platform with the image, the platform's own fold label, a counter, the lints and copy icons, then approves some platforms or requests changes with a comment. Nothing is published and nothing is fetched: the window only previews, copies and reports the decision back.

```
py -3 report_shell.py show preview-post --data payload.json
py -3 report_shell.py wait <run_id> --timeout 120
```

## What the reviewer sees

- **Top line:** the agent's `notes`, muted. The `…` overflow menu shows `persona` and `post_id` (when given) as quiet metadata lines and holds `Show in folder` (only with an image).
- **Tabs** (payload order; arrow keys, Home and End move): each tab names its platform and carries its state (tick when approved, dot when blocked, spoken state for screen readers). Only the selected tab's panel is in the document; the draft remembers the selected tab.
- **The panel:**
  - the preview with avatar (or initials), name and handle (X shows `@handle`, Instagram the bare handle, LinkedIn the headline), the composed text, the image in its ratio, or a link card when there is no image;
  - LinkedIn and Instagram show where the feed folds the text, as the platform's own muted inline label (`…more` after 210 code points on LinkedIn, `… more` after 125 on Instagram) with a hint below; the rest stays readable and copyable;
  - the checkbox `Approve for X` (LinkedIn, Instagram, Facebook) with the blocking reason under it;
  - the counter (`245 / 280`; Instagram also `Hashtags 3 / 30`; LinkedIn also the first-comment counter) and the lint badges;
  - the copy icons `Copy text`, `Copy hashtags`, `Copy comment`.
- **Footer:** `Discard`, the quiet alternative `Request changes` and the primary `Approve` (Ctrl+Enter works too). The status reads `Approve at least one platform` or `2 of 4 platforms approved`.
- **Request changes** opens the comment field (`What should change?`, up to 2000 characters) above the tabs; the primary becomes `Send request` and stays disabled until the comment has text. `Cancel` returns to approving. The mode is part of the draft, so a reload never turns a change request into an approval.

## Composed text, copy and counters

- **Composed text per platform:** `variants[p].text` if given, else `text`. With `hashtag_mode` `append` (the default) and at least one hashtag: that text, a blank line and `#a #b #c`. NFC-normalised once, so **shown = copied = counted**.
- `Copy text` copies the composed text (its value is the preview right above, so it is not repeated). `Copy hashtags` copies `#a #b #c` (shown next to the button with `hashtag_mode: none`; missing without hashtags). `Copy comment` copies `first_comment` and shows it in full (missing without one).
- **Counters** count exactly the composed text (limits in `core/static/platforms.json`): X weighted 280 (URL 23, emoji 2, CJK 2), LinkedIn 3000 code points (first comment 1250), Instagram 2200 code points and at most 30 hashtags, Facebook 63206 code points.
- **Link card:** rendered from `link.domain` and `link.title` only when the post has no image; Instagram never shows link cards.

## Lints and blocking

| Lint | Shown as | Blocks `Approve for …` |
|---|---|---|
| over the platform limit | red counter with `n too many`; `Over the limit: approval blocked` under the checkbox | yes, that platform |
| Instagram with more than 30 hashtags | badge `n hashtags too many` | yes, Instagram |
| Instagram without an image | badge `Instagram needs an image`; the preview shows `No image` | yes, Instagram |
| a `flag` entry found in the composed text or the first comment | badge `“—” found` | no |

`flag` is the agent's house style (characters or words to avoid); the template has no built-in style rules. A blocked checkbox is disabled, and `aria-describedby` points to the reason. An approved Instagram whose image is still loading or failed holds `Approve` with a status line (`The Instagram image is still loading`, `… did not load: reload it or remove the approval`) instead of sending fewer platforms.

## Payload `data` (`schema.json`)

```json
{
  "author": {
    "name": "Linden Street Bakery",
    "handle": "lindenstreetbakery",
    "headline": "Neighbourhood bakery · Sourdough, cakes and coffee since 1998",
    "avatar": "C:\\Users\\<user>\\Downloads\\avatar.jpg"
  },
  "text": "Our autumn menu starts Monday: pumpkin sourdough, apple crumb cake and a soup of the week. …",
  "hashtags": ["AutumnMenu", "Sourdough", "LocalBakery"],
  "first_comment": "Opening hours and the full menu: lindenstreet.example/menu",
  "image": { "path": "C:\\Users\\<user>\\Downloads\\loaves.jpg", "alt": "Round sourdough loaves and rolls on wooden shelves …", "ratio": "1.91:1" },
  "platforms": ["x", "linkedin", "instagram", "facebook"],
  "notes": "Autumn menu post for all four channels. The menu link is in the first comment."
}
```

| Field | Rule |
|---|---|
| `author` | required: `name` 1–60, `handle` 1–30 without `@` or whitespace, `headline?` 1–120 (LinkedIn), `avatar?` image path |
| `text` | required, 1–63206 |
| `hashtags` | required array (may be empty), at most 30, each `^[^\s#]{1,100}$` (stored without `#`) |
| `hashtag_mode` | `append` (default) or `none` |
| `first_comment` | optional, 1–1250 |
| `link` | optional `{url ^https://, title 1–120, domain 1–60}`; nothing is fetched |
| `image` | optional `{path, alt 1–300, ratio "1:1"\|"4:5"\|"1.91:1"\|"16:9"}` |
| `platforms` | 1–4 unique of `x`, `linkedin`, `instagram`, `facebook`, in tab order |
| `variants` | optional `{<platform>: {text}}` |
| `notes` | optional, 1–600 |
| `flag` | optional, at most 8 unique strings of 1–20 |
| `persona`, `post_id` | optional, 1–40 and 1–60; quiet lines in the overflow menu |

Image paths (`image.path`, `author.avatar`) are absolute paths under a media root (`config.json` `media_roots`). A bot on another machine copies the images to the window's machine first. The core replaces paths with media ids, so the page never sees a path. Fixtures use `%RS_TEMPLATE%\fixtures\media\…`, which the core expands to this template's folder and allows for this template only.

## Result `data` (`result.schema.json`, oneOf)

```json
{ "decision": "approve", "platforms": ["x", "linkedin", "instagram", "facebook"], "comment": "" }
```

```json
{ "decision": "request_changes", "platforms": [], "comment": "Please use the photo of the shop front instead." }
```

- `approve`: 1–4 unique platforms, in payload order; only approvable platforms can be ticked (within the limit; Instagram with an image that loaded). The page sends `""` as the comment.
- `request_changes`: `comment` 1–2000 with at least one non-whitespace character; `platforms` is always `[]`.
- The server validates the shape only; that each approved platform was approvable is enforced by the page. A discarded or expired report gives `cancelled` / `expired`: do nothing.

## Strings used (`core/i18n/en.json`, `de.json`)

`reveal`, `request_changes`, `request_changes_label`, `send_request`, `cancel`, `approve`, `approve_for` (Approve for {platform}), `approve_count`, `approved`, `not_approved`, `blocked`, `platforms_label`, `platform_x|linkedin|instagram|facebook`, `copy_text`, `copy_hashtags`, `copy_comment`, `copy`, `hashtags`, `pf_handle` (@{handle}), `lint_found` (**new**: “{text}” found / „{text}“ gefunden), `lint_ig_needs_image`, `lint_over_hashtags`, `over_limit_blocks`, `select_platform`, `comment_required`, `approval_waits_image`, `approval_image_failed`, `meta_persona`, `meta_post_id`. The components add their own (`Copied ✓`, counter texts, `now`, `No image`, the fold labels and hint). Avatars have an empty `alt`: they sit next to the name.

## Test hooks

- `data-copy-id`: `<platform>-text`, `<platform>-hashtags`, `<platform>-comment`.
- `data-counter-id`: `x`, `linkedin`, `instagram`, `facebook`, `instagram-hashtags`, `linkedin-comment`.
- Ids: `#tab-<platform>`, `#panel-<platform>`, `#approve-<platform>`, `#blocked-<platform>`, `#pp-comment`; `[data-pp="request"]` (change-request box), `[data-pp="request-cancel"]`; the alternative is the core `#rs-alt`.

## Keyboard path (golden, one open report)

Tab ×2 passes the `…` menu and reaches the selected tab. For each platform: Tab, Space approves; Tab ×3 passes its three copy icons; Shift+Tab ×4 returns to the tab and ArrowRight selects the next one. On the last tab: Tab, Space, then Tab ×6 passes the copies, `Discard` and `Request changes` and reaches `Approve`; Enter submits.

## Files

| File | Notes |
|---|---|
| `template.json` | manifest (namespace `global`) |
| `template.html` | the note, the change-request box, the tablist and four static platform panels (ordered and mounted one at a time by `template.js`); no literal text |
| `template.css` | tokens only; one large preview with a side column |
| `template.js` | composes the texts, fills the preview slots, counters, copies, lints, tabs, approval and change-request logic, drafts |
| `schema.json`, `result.schema.json` | payload and result (oneOf) |
| `fixtures/golden.json` | all 4 platforms, image 1.91:1, avatar, 3 hashtags, first comment; LinkedIn and Instagram fold |
| `fixtures/edge-no-image.json` | no image (Instagram blocked), link card, `hashtag_mode: none`, two `flag` hits, no avatar (initials) |
| `fixtures/edge-x-limit.json` | X and LinkedIn, image 16:9; the X variant weighs 281 (blocked), LinkedIn shows the base text |
| `fixtures/edge-max.json` | every channel, 30 hashtags, longest texts, 8 flags, image 4:5; X over its limit |
| `fixtures/invalid-hash-in-tag.json` | rejected at `/hashtags/1` |
| `fixtures/invalid-no-platform.json` | rejected at `/platforms` |
| `fixtures/media/*.jpg` | fictional bakery illustrations, drawn by `tools/dev/make-builtin-media.mjs` |
| `fixtures/expect/*.json` | written by `tools/dev/gen-preview-post-expect.py`: golden copies, counters, `flow`, `keyboard`, `result`; every copy of each edge; counters of `edge-x-limit` |
