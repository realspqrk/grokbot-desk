# Preview post

A social post to read as it will look, then approve for the bot to post, or post by hand. Platforms are X, LinkedIn, Instagram, and Facebook, at most four.

The shell draws the header, the task banner, and the footer. The template fills the page. German is the default UI (`core/i18n/de.json`). `RS_LANG=en` selects the English strings below.

## What the person sees

One tab per platform, in payload order. The preview shows the author, the text, hashtags, an optional first comment, and an image, a video, or a link card. Nothing is fetched for the link card. A quote or a reply shows the target beside the draft. A long preview scrolls inside the report. The header and the footer stay.

`mode` `auto` (the default): the bot posts after approval. `mode` `manual`: the person posts it and marks it Posted ✓. The bot never posts a manual platform.

An auto platform that is over its limit, or Instagram auto without an image or a video, cannot be approved. Manual over the limit is advice only. The bot posts only platforms that are `auto` and `approved`.

X counts weighted characters up to 25,000. A recognized emoji weighs 2. A URL the X counter recognizes weighs 23. Other web addresses are counted as written. The preview folds at 280 weighted characters and shows "Long post (X Premium)". On X the fold prefers a word boundary; an unbroken word longer than the fold is split. It never splits a URL or a recognized emoji. The visible text ends with an ellipsis, and Show more stands on its own line. The counter reads against 280 until the post is longer than that, then against 25,000.

LinkedIn allows 3,000 characters and folds at 210. A LinkedIn first comment allows 1,250. Instagram allows 2,200 characters and folds at 125. An auto Instagram post allows at most 5 hashtags and needs an image or a video. Facebook allows 63,206 characters. A fold is a visual hint. It does not block approval.

A hashtag counts when it has a letter or an underscore, so `#1` does not count. A `#` inside a URL, or after a slash, does not count.

When every platform is manual, the banner says Post it yourself once. The panels and the tabs do not repeat that. On a mixed report, a manual tab keeps the suffix ` · manual`. Request changes stays available on an all-manual report.

The footer reads Send response while both sides are ticked, Approve & post when only auto platforms are ticked, and Posted ✓ when only manual ones are. When nothing can be approved, the status reads Nothing can be approved: request changes.

On a manual platform the copy controls sit above Posted. Show in folder is in the overflow menu.

`flag` lists up to 8 words the draft should avoid. Matches are one quiet style-note line. They never block approval.

## Payload data

`platforms` is either a list of ids (every platform auto) or a list of objects. An object needs `platform`. `mode` is optional and defaults to `auto`. One form per list. Mixing strings and objects is rejected. `image` and `video` exclude each other.

```json
{
  "author": {
    "name": "Linden Street Bakery",
    "handle": "lindenstreet"
  },
  "text": "Our autumn menu starts Monday: pumpkin sourdough and a soup of the week.",
  "hashtags": ["AutumnMenu", "Sourdough"],
  "platforms": [
    {"platform": "linkedin", "mode": "auto"}
  ],
  "notes": "Please check the opening line."
}
```

| Field | Rule |
|---|---|
| `author` | Required. `name` (1 to 60) and `handle` (1 to 30, no spaces, no `@`). Optional `headline` (1 to 120) and `avatar` (an image path). |
| `text` | Required. 1 to 63206 characters. Used for every platform without a variant. |
| `hashtags` | Required array, at most 30. Stored without `#`. Each item matches `^[^\s#]{1,100}$`. Appended when `hashtag_mode` is `append` (the default). `none` leaves them off the text. |
| `platforms` | Required. 1 to 4 of `x`, `linkedin`, `instagram`, `facebook`. |
| `hashtag_mode` | `append` (default) or `none`. |
| `first_comment` | Optional. 1 to 1250. |
| `link` | Optional card: `url` (https, max 2000), `title` (1 to 120), `domain` (1 to 60). Shown when there is no image. |
| `image` | Optional. `path`, `alt` (1 to 300), `ratio` one of `1:1`, `4:5`, `3:4`, `9:16`, `1.91:1`, `16:9`. |
| `video` | Optional, instead of `image`. `path` (`.mp4` or `.webm`, at most 200 MB), `poster`, `alt`, `ratio`. Instagram treats a video as the required media. |
| `target` | Optional `quote` or `reply`. `url` is https, at most 2048 characters, and must be openable. Optional `excerpt` (1 to 600) and `author` (`name`, `handle`). The URL is not part of the counted text. |
| `variants` | Optional per platform. `text` replaces `text` and `hashtags` replaces `hashtags` for that platform. Give one or both. |
| `notes` | Optional. 1 to 600. The note to the person. |
| `persona` | Optional. 1 to 40. A quiet line in the overflow menu. |
| `post_id` | Optional. 1 to 60. A quiet line in the overflow menu. |
| `flag` | Optional. At most 8 unique strings, each 1 to 20. |

An ordinary media path is an absolute path on the person's computer and must resolve under a media root. A `%RS_TEMPLATE%` path is read from this template's folder and does not have to sit under a media root. The page receives a media id, not the path.

## Result data

`approve` lists, in `platforms`, only the auto platforms the person released. Manual platforms are never in that list. `per_platform` has one entry per payload platform: `mode`, and `decision` (`approved` or `not_approved` for auto, `done` or `skipped` for manual). An unticked manual platform is `skipped`. `comment` may be empty.

`request_changes` needs a comment, `platforms` is empty, and every platform is `changes_requested`.

Post only where `mode` is `auto` and `decision` is `approved`.

Approving the LinkedIn post above:

```json
{
  "decision": "approve",
  "platforms": ["linkedin"],
  "comment": "",
  "per_platform": {
    "linkedin": {"mode": "auto", "decision": "approved"}
  }
}
```

Asking for a shorter opening line on that same post:

```json
{
  "decision": "request_changes",
  "platforms": [],
  "comment": "Shorten the opening line.",
  "per_platform": {
    "linkedin": {"mode": "auto", "decision": "changes_requested"}
  }
}
```

## Keyboard path

Tab reaches the platform tabs. Left and Right move between platforms. On a platform, Tab reaches the approval checkbox, or Posted ✓ when the platform is manual. Space toggles it. Request changes is a footer alternative and needs a comment. Ctrl+Enter or Cmd+Enter sends. The exact golden key sequence is in `fixtures/expect/golden.json`.

## Files

`template.json`, `template.html`, `template.css`, `template.js`, `schema.json`, `result.schema.json`, `fixtures/golden.json`, `fixtures/edge-*.json`, `fixtures/invalid-*.json`, `fixtures/expect/golden.json`, `fixtures/expect/counter-cases.json`, `fixtures/media/`, and this README. Limits in prose match `core/static/platforms.json`. The result envelope is in [docs/GUIDE.md](../../../docs/GUIDE.md).

## For maintainers

### Strings used

| Key | English |
|---|---|
| `reveal` | Show in folder |
| `request_changes` | Request changes |
| `request_changes_label` | What should change? |
| `send_request` | Send request |
| `cancel` | Cancel |
| `approve` | Approve |
| `approve_for` | Approve for {platform} |
| `approved` | approved |
| `not_approved` | not approved |
| `platforms_label` | Platforms |
| `platform_x` | X |
| `platform_linkedin` | LinkedIn |
| `platform_instagram` | Instagram |
| `platform_facebook` | Facebook |
| `copy_text` | Copy text |
| `copy_hashtags` | Copy hashtags |
| `copy_comment` | Copy comment |
| `hashtags` | Hashtags |
| `pf_handle` | @{handle} |
| `lint_ig_needs_image` | Instagram needs an image or a video |
| `select_platform` | Approve at least one platform |
| `comment_required` | Please write a comment to request changes |
| `approve_count` | {n} of {total} platforms approved |
| `approval_waits_image` | The {platform} image is still loading |
| `approval_image_failed` | The {platform} image did not load: reload it or remove the approval |
| `meta_persona` | Persona: {persona} |
| `meta_post_id` | Post ID: {id} |
| `blocked` | blocked |
| `copy` | Copy |
| `approve_post` | Approve & post |
| `footer_done` | Done |
| `posted` | Posted ✓ |
| `mark_posted` | Posted ✓ |
| `mark_posted_on` | Posted ✓ |
| `confirm_decision` | Confirm |
| `mode_manual` | manual |
| `copy_image` | Copy image |
| `copy_path` | Copy file path |
| `copy_link` | Copy link |
| `replying_to` | Replying to @{handle} |
| `replying_to_name` | Replying to {name} |
| `replying_to_post` | Replying to this post |
| `approval_waits_video` | The {platform} video is still loading |
| `approval_video_failed` | The {platform} video did not load: reload it or remove the approval |
| `decided_count` | {n} of {total} platforms done |
| `select_platform_manual` | Approve a platform or mark it as posted |
| `submit_mixed` | Send response |
| `mixed_approved_count` | {n} approved |
| `mixed_posted_count` | {n} posted |
| `sep` | · |
| `select_posted` | After posting, mark it as posted |
| `not_posted` | not posted |
| `x_long_post` | Long post (X Premium) |
| `shorten_to_approve` | Shorten by {n} characters to approve |
| `hashtags_to_approve` | Cut to {limit} hashtags to approve |
| `manual_over_limit` | Longer than {limit} characters: check the length in {platform} |
| `manual_over_hashtags` | More than {limit} hashtags: check in {platform} |
| `nothing_approvable` | Nothing can be approved: request changes |
| `steps_nothing_approvable` | No platform can be approved. Press {button} and say what should change |
| `task_steps_changes` | Write what should change, then press {button} |
| `style_notes` | Style note: contains {items} |
| `quoted` | “{text}” |

### Test hooks

Copy controls are `<platform>-text`, `<platform>-hashtags`, `<platform>-comment`, `<platform>-image`, `<platform>-video`, and `<platform>-link`, for `x`, `linkedin`, `instagram`, and `facebook`.

Counters: `x`, `linkedin`, `instagram`, `facebook`, `instagram-hashtags`, `linkedin-comment`. Each expect counter is `{count, limit, over}`. `fixtures/expect/counter-cases.json` holds the weighted-count cases (at least 30).

### Golden result

The golden fixture approves three auto platforms and marks manual X as posted:

```json
{
  "decision": "approve",
  "platforms": ["linkedin", "instagram", "facebook"],
  "comment": "",
  "per_platform": {
    "x": {"mode": "manual", "decision": "done"},
    "linkedin": {"mode": "auto", "decision": "approved"},
    "instagram": {"mode": "auto", "decision": "approved"},
    "facebook": {"mode": "auto", "decision": "approved"}
  }
}
```
