# `preview-post`: social post preview and approval

Built-in template. The agent shows one post draft as realistic **X, LinkedIn, Instagram and Facebook** previews from one payload, one platform tab at a time. The reviewer sees the composed text per platform with the image, the platform's own fold label, a counter, the lints and copy icons, then approves some platforms or requests changes with a comment. Nothing is published and nothing is fetched: the window only previews, copies and reports the decision back.

Each platform has a **mode**: `auto` (the default: the bot posts it after `Approve & post`) or `manual` (the reviewer posts it by hand: the panel is built for copying, and the reviewer ticks `Posted ✓`). The bot decides the mode per platform from its own instructions and experience (who actually posts where) and never posts a platform marked manual.

```
py -3 report_shell.py show preview-post --data payload.json
py -3 report_shell.py wait <run_id> --timeout 120
```

## What the reviewer sees

- **Top line:** the agent's `notes`, muted. The `…` overflow menu shows `persona` and `post_id` (when given) as quiet metadata lines and holds `Show in folder` (only with an image or a video).
- **Tabs** (payload order; arrow keys, Home and End move): each tab names its platform and carries its state (tick when approved or marked as posted, dot when blocked, spoken state for screen readers). A manual platform names its mode quietly in the tab (`X · manual`); auto is the unnamed default. Only the selected tab's panel is in the document; the draft remembers the selected tab.
- **The panel:**
  - the preview with avatar (or initials), name and handle (X shows `@handle`, Instagram the bare handle, LinkedIn the headline), the composed text, the image or video in its ratio, or a link card when there is neither; a video shows its poster on its own and plays inline (native controls, `preload="metadata"`, no muted autoplay). If the clip cannot be decoded, or makes no progress for 8 seconds, the poster stays and the page says the preview is unavailable in this browser; the path can still be copied or the file shown in its folder;
  - an optional `target`: on X a quote is a bordered card under the post body (author, excerpt, domain); a reply is `Replying to @handle` (or the author name, or `Replying to this post` when there is no handle) above the text and the parent card above the post; LinkedIn and Facebook show a reshare card and, for a reply, the same reply line. Instagram does not show it. The card's link opens with `RS.openUrl` when that exists;
  - LinkedIn and Instagram show where the feed folds the text, as the platform's own muted inline label (`…more` after 210 code points on LinkedIn, `… more` after 125 on Instagram) with a hint below; the rest stays readable and copyable;
  - auto: the checkbox `Approve for X` (LinkedIn, Instagram, Facebook) with the blocking reason under it;
  - manual: first the note `You post this yourself.` and the copies (`Copy text`, `Copy hashtags`, `Copy comment`, then `Copy image` and `Show in folder` for an image, or `Copy file path` and `Show in folder` for a video, plus `Copy link` when there is a `target`), then the checkbox `Posted ✓`, so Tab reaches the copies before the decision;
  - the counter (`245 / 280`; Instagram also `Hashtags 3 / 30`; LinkedIn also the first-comment counter) and the lint badges;
  - the copy icons `Copy text`, `Copy hashtags`, `Copy comment`.
- **Footer:** `Discard`, the quiet alternative `Request changes` and the one primary (Ctrl+Enter works too). The primary names what happens: `Done` (nothing ticked, and the report has a manual platform: submitting reports every manual platform as skipped and does not release an auto platform), `Approve & post` (only auto platforms ticked, or nothing yet when every platform is auto), `Posted ✓` (only manual ones ticked) or `Confirm` (both). An all-auto report stays disabled until a platform is ticked. `Posted ✓` is never the label for a report that only skips. The status reads `Unticked platforms are reported as skipped` while nothing is ticked and a manual platform is present, otherwise `Approve at least one platform` or `2 of 4 platforms approved`; with a manual platform ticked, `2 of 4 platforms done`. An unticked manual platform is `skipped`.
- **Request changes** opens the comment field (`What should change?`, up to 2000 characters) above the tabs; the primary becomes `Send request` and stays disabled until the comment has text. `Cancel` returns to approving. The mode is part of the draft, so a reload never turns a change request into an approval.

## Composed text, copy and counters

- **Composed text per platform:** `variants[p].text` if given, else `text`. With `hashtag_mode` `append` (the default) and at least one hashtag: that text, a blank line and `#a #b #c`. NFC-normalised once, so **shown = copied = counted**.
- `Copy text` copies the composed text (its value is the preview right above, so it is not repeated). `Copy hashtags` copies `#a #b #c` (shown next to the button with `hashtag_mode: none`; missing without hashtags). `Copy comment` copies `first_comment` and shows it in full (missing without one).
- `Copy image` (manual only) puts the post image on the clipboard as a picture, through the server like every copy (`POST /copy-image` with the media id; the page never sees the path): macOS reads it with AppKit (PNG, JPEG, GIF, WebP), Windows with GDI+ (PNG, JPEG, GIF; a WebP image fails with `Copy failed`, use `Show in folder`). `Show in folder` opens Finder or Explorer at the file.
- **Counters** count exactly the composed text (limits in `core/static/platforms.json`): X weighted 280 (URL 23, emoji 2, CJK 2), LinkedIn 3000 code points (first comment 1250), Instagram 2200 code points and at most 30 hashtags, Facebook 63206 code points. X does not count a quote or reply `target.url`: that address is not appended to the text. A URL written inside `text` still weighs 23.
- **Link card:** rendered from `link.domain` and `link.title` only when the post has neither an image nor a video; Instagram never shows link cards.
- **Video:** the poster is the still, and the file plays in the same frame (controls, `preload="metadata"` or `none`, muted autoplay off). Loading and error match the image, including a reload that stays available on a locked report. `Copy file path` uses `RS.copyPath` and `Show in folder` uses `RS.reveal`; both stay usable on a locked report.
- **Target:** `Copy link` (manual platforms) copies `target.url` in full, because the card shows the domain rather than the whole address.

## Lints and blocking

| Lint | Shown as | Blocks `Approve for …` |
|---|---|---|
| over the platform limit | red counter with `n too many`; `Over the limit: approval blocked` under the checkbox | yes, that platform |
| Instagram with more than 30 hashtags | badge `n hashtags too many` | yes, Instagram |
| Instagram without an image or a video | badge `Instagram needs an image or a video`; the preview shows `No image` | yes, Instagram |
| a `flag` entry found in the composed text or the first comment | badge `“—” found` | no |

`flag` is the agent's house style (characters or words to avoid); the template has no built-in style rules. A blocked checkbox is disabled, and `aria-describedby` points to the reason. An approved Instagram whose image or video is still loading or failed holds `Approve` with a status line (`The Instagram image is still loading` / `The Instagram video is still loading`, or the matching “did not load” line) instead of sending fewer platforms.

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
  "platforms": [
    {"platform": "x", "mode": "manual"},
    {"platform": "linkedin", "mode": "auto"},
    {"platform": "instagram"},
    {"platform": "facebook"}
  ],
  "notes": "Autumn menu post for all four channels. You post X yourself; I post the rest after your approval."
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
| `image` | optional `{path, alt 1–300, ratio "1:1"\|"4:5"\|"1.91:1"\|"16:9"}`. Mutually exclusive with `video` (`x-rs-exclusive`; `show` rejects both at `/video`) |
| `video` | optional, instead of `image`: `{path, poster, alt 1–300, ratio}` same ratio enum. `path` is `.mp4` or `.webm` (`x-rs-media` `"video"`, at most 200 MB). `poster` is an image (`x-rs-media` true, at most 20 MB) and is required. Instagram counts a video as media |
| `target` | optional `{type: "quote"\|"reply", url https up to 2048 (`x-rs-url`), excerpt? 1–600, author?: {name? 1–60, handle? 1–30 without @}}`. The URL must be one the opener accepts (hostname or IPv6, valid port, no credentials); an uppercase scheme and a zero-padded port are accepted; `http://` is not. Not part of the composed text, so X does not count `url`. A reply does not need a handle |
| `platforms` | 1–4 platforms in tab order, either plain ids `"x"` (each one auto) or objects `{"platform": "x", "mode": "manual"}`; one form per list, no platform twice. Platform ids: `x`, `linkedin`, `instagram`, `facebook` |
| `platforms[].mode` | `auto` (default, also for every plain id, so payloads from before modes work unchanged): the bot posts after the approval. `manual`: the reviewer posts by hand and marks it as posted; the bot never posts it |
| `variants` | optional `{<platform>: {text}}` |
| `notes` | optional, 1–600 |
| `flag` | optional, at most 8 unique strings of 1–20 |
| `persona`, `post_id` | optional, 1–40 and 1–60; quiet lines in the overflow menu |

Media paths (`image.path`, `video.path`, `video.poster`, `author.avatar`) are absolute paths under a media root (`config.json` `media_roots`). Images are at most 20 MB; video (`.mp4`, `.webm`) is at most 200 MB and is served in HTTP ranges. A bot on another machine copies the files to the window's machine first. The core replaces paths with media ids, so the page never sees a path. Fixtures use `%RS_TEMPLATE%\fixtures\media\…`, which the core expands to this template's folder and allows for this template only.

## Result `data` (`result.schema.json`, oneOf)

```json
{
  "decision": "approve",
  "platforms": ["linkedin", "instagram"],
  "comment": "",
  "per_platform": {
    "x": { "mode": "manual", "decision": "done" },
    "linkedin": { "mode": "auto", "decision": "approved" },
    "instagram": { "mode": "auto", "decision": "approved" },
    "facebook": { "mode": "auto", "decision": "not_approved" }
  }
}
```

```json
{
  "decision": "request_changes",
  "platforms": [],
  "comment": "Please use the photo of the shop front instead.",
  "per_platform": {
    "x": { "mode": "manual", "decision": "changes_requested", "note": "Please use the photo of the shop front instead." },
    "linkedin": { "mode": "auto", "decision": "changes_requested", "note": "Please use the photo of the shop front instead." }
  }
}
```

- **What the bot posts:** exactly `platforms`, the auto platforms the reviewer approved. Post only auto + approved; a manual platform is never in `platforms`, even when it was marked as posted.
- `per_platform` names every payload platform with its `mode` and `decision`: `approved` (auto, the bot posts it), `done` (manual, the reviewer posted it: record it, do not post), `skipped` (manual, not posted), `not_approved` (auto, not ticked: do nothing) or `changes_requested` (with the comment as `note`).
- `approve`: 0–4 unique auto platforms in `platforms`, in payload order (empty when everything ticked was posted by hand); at least one platform is ticked. Only approvable platforms can be ticked (within the limit; Instagram with an image that loaded). The page sends `""` as the comment.
- `request_changes`: `comment` 1–2000 with at least one non-whitespace character; `platforms` is always `[]`; every platform is `changes_requested`.
- The server validates the shape only; that each approved platform was approvable is enforced by the page. A discarded or expired report gives `cancelled` / `expired`: do nothing.

## Strings used (`core/i18n/en.json`, `de.json`)

`reveal`, `request_changes`, `request_changes_label`, `send_request`, `cancel`, `approve`, `approve_post` (Approve & post), `posted` (Posted ✓), `skip` (Skip), `mark_posted` (Posted ✓), `mark_posted_on` (Posted ✓), `confirm_decision` (Confirm), `manual_note` (You post this yourself.), `mode_manual` (manual), `copy_image`, `decided_count`, `select_platform_manual`, `approve_for` (Approve for {platform}), `approve_count`, `approved`, `not_approved`, `blocked`, `platforms_label`, `platform_x|linkedin|instagram|facebook`, `copy_text`, `copy_hashtags`, `copy_comment`, `copy`, `hashtags`, `pf_handle` (@{handle}), `lint_found` (**new**: “{text}” found / „{text}“ gefunden), `lint_ig_needs_image`, `lint_over_hashtags`, `over_limit_blocks`, `select_platform`, `comment_required`, `approval_waits_image`, `approval_image_failed`, `approval_waits_video`, `approval_video_failed`, `copy_path` (Copy file path), `copy_link` (Copy link), `replying_to` (Replying to @{handle}), `replying_to_name` (Replying to {name}), `replying_to_post` (Replying to this post), `meta_persona`, `meta_post_id`. The components add their own (`Copied ✓`, counter texts, `now`, `No image`, the fold labels and hint, video load errors). Avatars have an empty `alt`: they sit next to the name.

## Test hooks

- `data-copy-id`: `<platform>-text`, `<platform>-hashtags`, `<platform>-comment`; a manual panel with an image also `<platform>-image`, with a video `<platform>-video` (`media-copy="path"`), and with a target `<platform>-link`. The `media` attribute is the media id.
- `data-counter-id`: `x`, `linkedin`, `instagram`, `facebook`, `instagram-hashtags`, `linkedin-comment`.
- Ids: `#tab-<platform>`, `#panel-<platform>` (`data-mode` auto or manual), `#approve-<platform>`, `#blocked-<platform>`, `#reveal-<platform>` (manual), `#pp-comment`; `[data-pp="manual-note"]`, `.pp__mode` (the tab's mode); `[data-pp="request"]` (change-request box), `[data-pp="request-cancel"]`; the alternative is the core `#rs-alt`.

## Keyboard path (golden, one open report)

Tab ×2 passes the `…` menu and reaches the selected tab (X, manual): Tab ×5 passes its copies (text, hashtags, comment, image, folder), Tab reaches `Posted ✓` and Space ticks it; Shift+Tab ×6 returns to the tab and ArrowRight selects the next one. For each auto platform: Tab, Space approves; Tab ×3 passes its three copy icons; Shift+Tab ×4 returns to the tab and ArrowRight selects the next one. On the last tab: Tab, Space, then Tab ×6 passes the copies, `Discard` and `Request changes` and reaches the primary (`Confirm`, as both modes are ticked); Enter submits.

## Files

| File | Notes |
|---|---|
| `template.json` | manifest (namespace `global`) |
| `template.html` | the note, the change-request box, the tablist and four static platform panels (ordered and mounted one at a time by `template.js`); no literal text |
| `template.css` | tokens only; one large preview with a side column |
| `template.js` | composes the texts, fills the preview slots, counters, copies, lints, tabs, approval and change-request logic, drafts |
| `schema.json`, `result.schema.json` | payload and result (oneOf) |
| `fixtures/golden.json` | all 4 platforms (X manual, LinkedIn auto, Instagram and Facebook auto by default), image 1.91:1, avatar, 3 hashtags, first comment; LinkedIn and Instagram fold |
| `fixtures/quote-video.json` | short X quote with a video (X manual, LinkedIn auto); the quoted URL is not in the text |
| `fixtures/edge-no-image.json` | no image (Instagram blocked), link card, `hashtag_mode: none`, two `flag` hits, no avatar (initials) |
| `fixtures/edge-x-limit.json` | X and LinkedIn, image 16:9; the X variant weighs 281 (blocked), LinkedIn shows the base text |
| `fixtures/edge-max.json` | every channel, 30 hashtags, longest texts, 8 flags, image 4:5; X over its limit |
| `fixtures/invalid-hash-in-tag.json` | rejected at `/hashtags/1` |
| `fixtures/invalid-no-platform.json` | rejected at `/platforms` |
| `fixtures/invalid-image-and-video.json` | rejected at `/video` (image and video together) |
| `fixtures/media/*.jpg` | fictional bakery illustrations, drawn by `tools/dev/make-builtin-media.mjs` |
| `fixtures/expect/*.json` | written by `tools/dev/gen-preview-post-expect.py`: golden copies, counters, `flow`, `keyboard`, `result`; every copy of each edge; counters of `edge-x-limit` |
