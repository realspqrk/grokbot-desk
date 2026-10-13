# `preview-post`: social post preview and approval

Built-in template. The agent shows one post draft as realistic **X, LinkedIn, Instagram and Facebook** previews from one payload, one platform tab at a time. The reviewer sees the composed text per platform with the image, the platform's own fold label, a counter, the lints and copy icons, then approves some platforms, marks the ones they posted themselves, or requests changes with a comment. Nothing is published and nothing is fetched: the window only previews, copies and reports the decision back.

Each platform has a **mode**: `auto` (the default: the bot posts it after `Approve & post`) or `manual` (the reviewer posts it by hand: the panel is built for copying, and the reviewer ticks `Posted ✓`). The bot decides the mode per platform from its own instructions and experience (who actually posts where) and never posts a platform marked manual.

```
py -3 report_shell.py show preview-post --data payload.json
py -3 report_shell.py wait <run_id> --timeout 120
```

## What the reviewer sees

- **Top line:** the agent's `notes`, as the why of the task banner above the title (muted in the report instead when the payload brings its own `task.why` or the notes have a link). The `…` overflow menu shows `persona` and `post_id` (when given) as quiet metadata lines and holds `Show in folder` (only with an image or a video).
- **Tabs** (payload order; arrow keys, Home and End move): each tab names its platform and carries its state (tick when approved or marked as posted, dot when blocked, spoken state for screen readers). When the list mixes auto and manual, a manual platform names its mode quietly in the tab (`X · manual`); auto is the unnamed default. When the person posts every platform themselves, the banner says so once and the tab does not. Only the selected tab's panel is in the document; the draft remembers the selected tab.
- **The panel:**
  - the preview with avatar (or initials), name and handle (X shows `@handle`, Instagram the bare handle, LinkedIn the headline), the composed text, the image or video in its ratio, or a link card when there is neither; a video shows its poster on its own and plays inline (native controls, `preload="metadata"`, no muted autoplay). If the clip cannot be decoded, or makes no progress for 8 seconds, the poster stays and the page says the preview is unavailable in this browser; the path can still be copied or the file shown in its folder;
  - an optional `target`: on X a quote is a bordered card under the post body (author, excerpt, domain); a reply is `Replying to @handle` (or the author name, or `Replying to this post` when there is no handle) above the text and the parent card above the post; LinkedIn and Facebook show a reshare card and, for a reply, the same reply line. Instagram does not show it. The card's link opens with `RS.openUrl` when that exists;
  - X, LinkedIn and Instagram show where the feed folds the text, as the platform shows it, with a hint below (`Cut after 280 characters; the rest is behind “Show more”`): X cuts at the last word boundary within 280 weighted characters (never inside a URL), ends the visible text with `…` and puts `Show more` on its own line in its link colour; LinkedIn shows a muted inline `…more` after 210 code points, Instagram `… more` after 125; the rest stays readable and copyable. An X post past 280 also gets the quiet note `Long post (X Premium)` under the counter;
  - auto: the checkbox `Approve for X` (LinkedIn, Instagram, Facebook), then one reason line when it is blocked, the counter and the quiet notes, then the copies `Copy text`, `Copy hashtags`, `Copy comment`;
  - manual: first the copies (`Copy text`, `Copy hashtags`, `Copy comment`, then `Copy image` for an image or `Copy file path` for a video, plus `Copy link` when there is a `target`), then the checkbox `Posted ✓`, so Tab reaches the copies before the decision. The copies sit close together; the checkbox stands apart. The banner and the tab (`X · manual`) already say who posts, so the panel adds no note of its own. `Copy comment` starts like the other copies (icon, then label) with the comment quoted below. `Show in folder` is in the `…` menu only;
  - the counter (X reads `245 / 280` for a standard post and `487 / 25,000` past 280, grouped as the language does: `25.000` in German; Instagram also `Hashtags 3 / 5`; LinkedIn also the first-comment counter). It stays neutral; only the amount over the limit (`12 too many`) stands out;
  - one reason line under the checkbox (see Lints and blocking) and, when the payload's `flag` words occur, one quiet `Style note: contains “—”, “best ever”`.
- **Banner:** a mix of auto and manual gives each actor one line, the person first, the bot by its display name: `You post: X` / `Inbox Agent posts after approval: LinkedIn`. Until something is ticked, every approvable platform is the plan. An auto platform that cannot be approved (over its limit, Instagram over 5 hashtags or without an image or a video) is left out of that plan from the start, and it is not described as unticked. Once something is ticked, an unticked approvable platform is out (`Inbox Agent posts nothing: LinkedIn not ticked`). The steps say per actor what is still open, in tab order, then the footer as it reads now: `LinkedIn: tick Approve · X: copy, post, Posted ✓ · then Submit`; with LinkedIn ticked `X: copy, post, Posted ✓ · or Approve & post`; with both `Now Submit`. The two-platform line fits the 72-character measure; a longer list wraps. A supplied `task.steps` stays as written. A change request reads `You ask for changes` / `Inbox Agent posts nothing`. The decided banner says what each side did (`You posted: X` / `Inbox Agent posts now: LinkedIn`). Nothing ticked keeps the primary disabled. The actor lines, the steps and the footer use the same approvable set.
- **Footer:** the quiet alternative `Request changes` and the one primary (Ctrl+Enter works too; `Discard report` is in the `…` menu); the labels follow the task kind. Any auto platform (`approve_bot_acts`): the primary reads `Approve & post`. In a mix it names neither actor while both act: `Submit` when an auto platform is approved and a manual one marked (and, disabled, before anything is ticked), `Approve & post` when only auto platforms are ticked, `Posted ✓` when only manual ones are. Every platform manual (`post_yourself`): the primary reads `Posted ✓`. There is no Skip: the primary stays disabled until a platform is ticked, so an approval always has one, and an unticked manual platform is reported `skipped`. The status reads `Approve at least one platform` (all auto), `Approve a platform or mark it as posted` (a mix) or `After posting, mark it as posted` (all manual) while nothing is ticked, then `2 of 4 platforms approved` (all auto), `1 approved · 1 posted` (a mix) or `1 of 2 platforms done` (all manual). When no platform can be approved (every platform auto and blocked), the status reads `Nothing can be approved: request changes` and the banner steps say the same instead of asking to approve. The label never changes the result: `platforms` lists the auto approvals and `per_platform` each platform's mode and decision.
- **Request changes** opens the comment field (`What should change?`, up to 2000 characters) above the tabs; the primary becomes `Send request` and stays disabled until the comment has text. `Cancel` returns to approving. The mode is part of the draft, so a reload never turns a change request into an approval.

## Composed text, copy and counters

- **Composed text per platform:** `variants[p].text` if given, else `text`. The platform's hashtags are `variants[p].hashtags` if given (also `[]`), else `hashtags`. With `hashtag_mode` `append` (the default) and at least one hashtag: that text, a blank line and `#a #b #c`. NFC-normalised once, so **shown = copied = counted**.
- `Copy text` copies the composed text (its value is the preview right above, so it is not repeated). `Copy hashtags` copies the platform's `#a #b #c` (shown next to the button with `hashtag_mode: none`; missing without hashtags). `Copy comment` copies `first_comment` and shows it in full (missing without one).
- `Copy image` (manual only) puts the post image on the clipboard as a picture, through the server like every copy (`POST /copy-image` with the media id; the page never sees the path): macOS reads it with AppKit (PNG, JPEG, GIF, WebP), Windows with GDI+ (PNG, JPEG, GIF; a WebP image fails with `Copy failed`, use `Show in folder`). `Show in folder` opens Finder or Explorer at the file.
- **Counters** count exactly the composed text (limits in `core/static/platforms.json`): X weighted 25,000 (X Premium long posts; URL 23, emoji 2, CJK 2; a standard post ends at 280, where the preview folds), LinkedIn 3000 code points (first comment 1250), Instagram 2200 code points and at most 5 hashtags (Instagram's limit since December 2025), Facebook 63206 code points. X does not count a quote or reply `target.url`: that address is not appended to the text. A URL written inside `text` still weighs 23.
- **Link card:** rendered from `link.domain` and `link.title` only when the post has neither an image nor a video; Instagram never shows link cards.
- **Video:** the poster is the still, and the file plays in the same frame (controls, `preload="metadata"` or `none`, muted autoplay off). With `preload="none"` an untouched clip stays on the poster and is not a failure. Once playback starts, a clip that cannot be decoded, or that makes no progress, keeps the poster and says the preview is unavailable; the frame has no retry button. `Copy file path` uses `RS.copyPath` and `Show in folder` uses `RS.reveal`; both stay usable on a locked report.
- **Target:** `Copy link` (manual platforms) copies `target.url` in full, because the card shows the domain rather than the whole address.

## Lints and blocking

| Case | Auto platform | Manual platform |
|---|---|---|
| over the platform limit | blocked; `Shorten by 12 characters to approve` | advice: `Longer than 25,000 characters: check the length in X`; `Posted ✓` stays enabled |
| Instagram with more than 5 hashtags | blocked; `Cut to 5 hashtags to approve` | advice: `More than 5 hashtags: check in Instagram` |
| Instagram without an image or a video | blocked; `Instagram needs an image or a video`; the preview shows `No image` | advice, the same words |
| a `flag` entry found in the composed text or the first comment | quiet `Style note: contains “—”` | the same |

A blocked platform shows one line under its checkbox: a red dot and how to recover; two reasons share the line, joined by `·`. Its tab keeps the blocked dot. A manual platform is never blocked: `Posted ✓` reports what the person did, so a limit is advice there (muted, no dot).

`flag` is the agent's house style (characters or words to avoid); the template has no built-in style rules, and a style note never blocks. A blocked checkbox is disabled, and `aria-describedby` points to the reason. An approved Instagram whose image or video is still loading or failed holds `Approve` with a status line (`The Instagram image is still loading` / `The Instagram video is still loading`, or the matching “did not load” line) instead of sending fewer platforms.

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
  "notes": "Autumn menu launch. The menu link is in the first comment, so the post itself stays short and warm."
}
```

| Field | Rule |
|---|---|
| `author` | required: `name` 1–60, `handle` 1–30 without `@` or whitespace, `headline?` 1–120 (LinkedIn), `avatar?` image path |
| `text` | required, 1–63206 |
| `hashtags` | required array (may be empty), at most 30, each `^[^\s#]{1,100}$` (stored without `#`). Instagram blocks auto approval above 5; give Instagram (or X) its own list in `variants` |
| `hashtag_mode` | `append` (default) or `none` |
| `first_comment` | optional, 1–1250 |
| `link` | optional `{url ^https://, title 1–120, domain 1–60}`; nothing is fetched |
| `image` | optional `{path, alt 1–300, ratio "1:1"\|"4:5"\|"3:4"\|"9:16"\|"1.91:1"\|"16:9"}`. Mutually exclusive with `video` (`x-rs-exclusive`; `show` rejects both at `/video`) |
| `video` | optional, instead of `image`: `{path, poster, alt 1–300, ratio}` same ratio enum. `path` is `.mp4` or `.webm` (`x-rs-media` `"video"`, at most 200 MB). `poster` is an image (`x-rs-media` true, at most 20 MB) and is required. Instagram counts a video as media |
| `target` | optional `{type: "quote"\|"reply", url https up to 2048 (`x-rs-url`), excerpt? 1–600, author?: {name? 1–60, handle? 1–30 without @}}`. The URL must be one the opener accepts (hostname or IPv6, valid port, no credentials); an uppercase scheme and a zero-padded port are accepted; `http://` is not. Not part of the composed text, so X does not count `url`. A reply does not need a handle |
| `platforms` | 1–4 platforms in tab order, either plain ids `"x"` (each one auto) or objects `{"platform": "x", "mode": "manual"}`; one form per list, no platform twice. Platform ids: `x`, `linkedin`, `instagram`, `facebook` |
| `platforms[].mode` | `auto` (default, also for every plain id, so payloads from before modes work unchanged): the bot posts after the approval. `manual`: the reviewer posts by hand and marks it as posted; the bot never posts it |
| `variants` | optional `{<platform>: {text?, hashtags?}}`, at least one of the two. `text` 1–63206 replaces `text`, `hashtags` (same item rules, at most 30) replaces `hashtags` for that platform |
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
- `approve`: 0–4 unique auto platforms in `platforms`, in payload order (empty when everything ticked was posted by hand); at least one platform is ticked. Only approvable platforms can be ticked: an auto platform within its limits (Instagram with at most 5 hashtags and an image that loaded); a manual platform always. The page sends `""` as the comment.
- `request_changes`: `comment` 1–2000 with at least one non-whitespace character; `platforms` is always `[]`; every platform is `changes_requested`.
- The server validates the shape only; that each approved platform was approvable is enforced by the page. A discarded or expired report gives `cancelled` / `expired`: do nothing.

## Strings used (`core/i18n/en.json`, `de.json`)

`reveal`, `request_changes`, `request_changes_label`, `send_request`, `cancel`, `approve`, `approve_post` (Approve & post), `posted` (Posted ✓), `not_posted` (not posted, spoken tab state), `mark_posted` (Posted ✓), `mark_posted_on` (Posted ✓), `confirm_decision` (Confirm), `mode_manual` (manual), `copy_image`, `decided_count`, `select_platform`, `select_platform_manual` (Approve a platform or mark it as posted), `select_posted` (After posting, mark it as posted), `nothing_approvable` (Nothing can be approved: request changes), `steps_nothing_approvable`, `task_steps_changes`, `submit_mixed` (Submit), `mixed_approved_count` ({n} approved), `mixed_posted_count` ({n} posted), `sep` (·), `approve_for` (Approve for {platform}), `approve_count`, `approved`, `not_approved`, `blocked`, `platforms_label`, `platform_x|linkedin|instagram|facebook`, `copy_text`, `copy_hashtags`, `copy_comment`, `copy`, `hashtags`, `pf_handle` (@{handle}), `lint_ig_needs_image`, `shorten_to_approve` (Shorten by {n} characters to approve), `hashtags_to_approve` (Cut to {limit} hashtags to approve), `manual_over_limit`, `manual_over_hashtags`, `x_long_post` (Long post (X Premium)), `style_notes` (Style note: contains {items}), `quoted` (“{text}”), `comment_required`, `approval_waits_image`, `approval_image_failed`, `approval_waits_video`, `approval_video_failed`, `copy_path` (Copy file path), `copy_link` (Copy link), `replying_to` (Replying to @{handle}), `replying_to_name` (Replying to {name}), `replying_to_post` (Replying to this post), `meta_persona`, `meta_post_id`, `footer_done`. The components add their own (`Copied ✓`, counter texts, `now`, `No image`, the fold labels `fold_more_x|linkedin|instagram` and hint, video load errors). Avatars have an empty `alt`: they sit next to the name.

## Test hooks

- `data-copy-id`: `<platform>-text`, `<platform>-hashtags`, `<platform>-comment`; a manual panel with an image also `<platform>-image`, with a video `<platform>-video` (`media-copy="path"`), and with a target `<platform>-link`. The `media` attribute is the media id.
- `data-counter-id`: `x`, `linkedin`, `instagram`, `facebook`, `instagram-hashtags`, `linkedin-comment`.
- Ids: `#tab-<platform>`, `#panel-<platform>` (`data-mode` auto or manual), `#approve-<platform>`, `#blocked-<platform>` (the reason line; `data-advice` on a manual platform), `#lint-image-instagram` (auto Instagram while its media loads), `#pp-comment`; `.pp__mode` (the tab's mode, a mix only), `[data-pp="long-note"]`, `[data-pp="style-note"]`; `Show in folder` is `#rs-more-extra .rs-more__item`; `[data-pp="request"]` (change-request box), `[data-pp="request-cancel"]`; the alternative is the core `#rs-alt`.

## Keyboard path (golden, one open report)

Tab ×2 passes the `…` menu and reaches the selected tab (X, manual): Tab ×4 passes its copies (text, hashtags, comment, image), Tab reaches `Posted ✓` and Space ticks it; Shift+Tab ×5 returns to the tab and ArrowRight selects the next one. For each auto platform: Tab, Space approves; Tab ×3 passes its three copy icons; Shift+Tab ×4 returns to the tab and ArrowRight selects the next one. On the last tab: Tab, Space, then Tab ×5 passes the copies and `Request changes` and reaches the primary (`Approve & post`, as an auto platform is ticked); Enter submits.

## Files

| File | Notes |
|---|---|
| `template.json` | manifest (namespace `global`) |
| `template.html` | the note, the change-request box, the tablist and four static platform panels (decision group and copies group, ordered and mounted one at a time by `template.js`); no literal text |
| `template.css` | tokens only; one large preview with a side column |
| `template.js` | composes the texts, fills the preview slots, counters, copies, the reason line and notes, tabs, approval and change-request logic, drafts |
| `schema.json`, `result.schema.json` | payload and result (oneOf) |
| `fixtures/golden.json` | all 4 platforms (X manual, LinkedIn auto, Instagram and Facebook auto by default), image 1.91:1, avatar, 3 hashtags, first comment; LinkedIn and Instagram fold; `notes` say why the post looks as it does, not who posts where |
| `fixtures/quote-video.json` | short X quote with a video (X manual, LinkedIn auto); the quoted URL is not in the text |
| `fixtures/mixed-image.json` | LinkedIn auto, X manual, image and 2 hashtags: the X tab copies text, hashtags and the image and ticks Posted ✓ |
| `fixtures/edge-no-image.json` | no image (Instagram blocked), link card, `hashtag_mode: none`, one of two `flag` entries occurs (style note), no avatar (initials) |
| `fixtures/edge-x-limit.json` | X and LinkedIn (auto), image 9:16; the X variant weighs 25,012 (blocked: `Shorten by 12 characters to approve`), LinkedIn shows the base text |
| `fixtures/edge-x-long.json` | one X long post you post yourself (`post_yourself`), about 490 weighted: X folds after 280 with `Show more`, `Long post (X Premium)`, image 3:4 |
| `fixtures/edge-max.json` | every channel, 30 hashtags (X has its own two in `variants.x.hashtags`; Instagram blocked over 5), longest texts, 8 flags, image 4:5 |
| `fixtures/invalid-hash-in-tag.json` | rejected at `/hashtags/1` |
| `fixtures/invalid-no-platform.json` | rejected at `/platforms` |
| `fixtures/invalid-image-and-video.json` | rejected at `/video` (image and video together) |
| `fixtures/media/*.jpg` | fictional bakery illustrations, drawn by `tools/dev/make-builtin-media.mjs` |
| `fixtures/expect/*.json` | written by `tools/dev/gen-preview-post-expect.py`: golden copies, counters, `flow`, `keyboard`, `result`; every copy of each edge; counters of `edge-x-limit` and `edge-x-long` |
