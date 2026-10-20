# grokbot-desk reference

Commands, exit codes, the data folder, configuration, the doorbell, update, migrate, bot identity, and the payload and result envelopes.

How a bot waits, catches up, and acknowledges a decision is in the [skill](../skills/grokbot-desk/SKILL.md). The blocks and the button table are there too.

## Envelopes

### Payload

`schema` is `grokbot-desk/payload@2`. The maximum size is 2 MB. Unknown top-level fields are rejected. JSON nesting is limited to 64 levels. One leading UTF-8 BOM is stripped.

| Field | Rule |
| --- | --- |
| `schema` | `grokbot-desk/payload@2`. |
| `bot` | `^[a-z0-9-]{1,40}$`, for example `inbox-agent`. |
| `title` | 1 to 80 characters. |
| `created` | ISO 8601 with an offset. More than 2 minutes ahead is clamped to now, and `show` warns. |
| `ask` | `read`, `review`, `approve`, `do`, or `choose`. |
| `blocks` | 1 to 40 blocks. Content blocks mix. At most one input block (`decide`, `pick`, or `post`). Which input block is allowed follows `ask`. See the [skill](../skills/grokbot-desk/SKILL.md). |
| `run_id` | Optional. Pattern `^[0-9]{8}-[0-9]{6}-[a-z0-9-]{1,20}-[0-9a-f]{4}(?:[0-9a-f]{8})?$`. Generated ids use 12 hex characters. Leave it out. |
| `why` | Optional non-empty text. The banner under the title shows at most 3 sentences and 360 characters. Past either limit, `show` warns and still accepts the report. A line break ends a sentence. Abbreviations (`z. B.`, `ca.`, `Nr.`), ordinals, and dates (`15.`, `31.12.`) do not. `...`, `…`, and a year from 1900 through 2099 still do. Any other number, and a version (`2.4.`), stays in the same sentence. |
| `action` | Optional. 1 to 24 characters on one line, no space at either end. Required when `ask` is `approve` and there is no input block. |
| `label` | Optional. Same shape as `action`. On an `approve` report with no input block, it replaces the primary text. The result value stays `approve`. |
| `due` | Optional `YYYY-MM-DD`, or an extended timestamp `YYYY-MM-DDTHH:MM[:SS[.fff]]Z` or with a `±HH:MM` offset. Seconds are optional. Fractional seconds need seconds. `Z` or `±HH:MM` is required on a timestamp. |
| `urgent` | Optional boolean. `true`, or a `due` of today or earlier, turns the banner red. |
| `expires_minutes` | Optional integer 5 to 10080. Default 240. |
| `identity` | Optional. See [Bot identity](#bot-identity). Never rejects the report. |
| `dedupe_key` | Optional. 1 to 120 printable ASCII characters, not starting with a space. The same bot and key returns the existing report. It does not change that report. |
| `dedupe_hours` | Optional integer 1 to 168. Default 24. Only together with `dedupe_key`. |

The same bot and `dedupe_key` returns the open report, or the submitted or cancelled report from the last `dedupe_hours`. An expired report never matches. `show` then adds `deduped` and `state`.

A block without `id` is `b1`, `b2`, from the top. `b1` is the first block. Ids match `^[a-z0-9-]{1,40}$` and are unique in the report.

`python report_shell.py check payload.json` validates a payload the way `show` does, without opening a desk. Stdout is `ok`, or the first problem as `pointer: message` (exit 2). Warnings go to stderr and do not change the exit code. `check` does not read `config.json` and does not check that a media file exists. `show` does check media before it opens the window.

```json
{
  "schema": "grokbot-desk/payload@2",
  "bot": "ops-bot",
  "title": "Weekly operations: all systems normal",
  "created": "2026-10-18T08:00:00+02:00",
  "why": "Nothing needs a decision this week.",
  "ask": "read",
  "blocks": [
    {"type": "text", "md": "Backups ran every night. One certificate expires in 21 days."}
  ]
}
```

### Result

`schema` is `grokbot-desk/result@2`. The file is written when the person submits, when the report is discarded, or when it expires. Open reports are not in this file and are not listed by `results`.

| Field | Rule |
| --- | --- |
| `schema` | `grokbot-desk/result@2`. |
| `run_id` | The report id. |
| `bot` | The payload `bot`. |
| `status` | `submitted`, `cancelled`, or `expired`. |
| `created` | Local ISO 8601 with an offset. |
| `decided` | Local ISO 8601 with an offset, to the second. |
| `duration_s` | Whole seconds from `created` to `decided`, at least 0. |
| `log` | Path of the action log. |
| `data` | Present only when `status` is `submitted`. `{decision, note, refs, blocks?}`. |
| `identity` | Present when the page could not use the accent, or when identity warnings were recorded. `name`, `accent_fallback` (themes that fell back), and `warnings`. |

`data.decision` is legal for that ask and its input block. `data.note` is the composer text, `""` when empty, and at most 4,000 characters. `revise` needs a non-blank note. `data.refs` are the reply chips: `{block, item, label}`. `item` is a decide item id, a pick option id, a post platform id, or `section:<n>` for the n-th level-2 or level-3 heading in that text block. An ATX `##` or `###` counts, and so does a level-2 Setext heading (a paragraph line with a line of dashes directly under it). They share one zero-based sequence. A line of equals, a `#` or `####` heading, and a line of three or more dashes after a blank line do not count. One note covers every chip. `data.blocks` is present only on the decision that answers the input block, and then it holds exactly that block. The shapes are in the [skill](../skills/grokbot-desk/SKILL.md).

`python report_shell.py result` adds `data_dir` to this object on stdout. The file does not contain `data_dir`.

What the bot does with `status`:

| `status` | What happened | What the bot does |
| --- | --- | --- |
| `submitted` | the person sent it | reads `data` and does the work the answers allow. Acknowledges the decision in chat with topic + OK, including a refusal, a note, or a comment. For example: "Invoices: hosting approved, toner next week, OK. Paying hosting now." Says the work is finished only after it succeeded. With an input block, acts on the row or platform answers, not on the report decision alone. |
| `cancelled` | the person discarded it, or `cancel` was run | does nothing with the decision. Records it in chat. No topic + OK. If the person asked for the cancel, stops and does not ask again. If the bot did not cause the cancel, asks in chat only when the work still needs an answer. The bot's own `cancel` never rings the doorbell, even when the person asked the bot to cancel. |
| `expired` | `expires_minutes` ran out, or an older open report expired on upgrade | does nothing with the decision. Records it in chat. No topic + OK. Asks in chat only when the work still needs an answer. |

On upgrade, every open report from before this payload expires once, with reason `upgrade`. The result `status` is `expired` and there is no `data`. The result's `log` field is the action-log path. That file is JSON lines. The matching line has `"event": "expire"` and `"detail": {"reason": "upgrade"}`. Ask again if the work still needs an answer.

## Input limits

These bounds are hard. A payload or a result outside them is rejected. Platform character counts in the [skill](../skills/grokbot-desk/SKILL.md) are advice from the page and are not in this table. Lengths count characters. Every number in a block must be finite.

| Field | Bound |
| --- | --- |
| Report `blocks` | 1 to 40. At most one input block. |
| Block `id` | `^[a-z0-9-]{1,40}$`, unique. Missing id is `b1`, `b2`, from the top. |
| Block `title` | 1–80. |
| `text.md` | 1–60,000. |
| `text.images` | At most 8, unique `key`. `key` matches `^[a-z0-9][a-z0-9_-]{0,31}$`. `path` 1–1,000. `alt` 1–200. |
| `stats.items` | 1 to 4. `label` 1–32. `value` 1–40. `delta` text 1–24, or a finite number. `note` 1–80. `spark` 2 to 60 finite numbers. |
| `table.columns` | 1 to 12, unique `key` matching `^[a-z0-9_-]{1,32}$`. `label` 1–40. |
| `table.rows` | 1 to 200. A text cell is at most 500 characters. A number, money, percent, or delta cell is a finite number or null. |
| `chart.labels` | 1 to 60 strings, each 1–40. |
| `chart.series` | 1 to 4. `name` 1–40. `values` 1 to 60 finite numbers, one per label. `unit` 1–12. `target` is a finite number. `orientation` only on a bar chart. |
| `facts.items` | 1 to 8. `label` 1–32. `value` 1–120. |
| `checks.items` | 1 to 20. `label` 1–80. `detail` 1–120. |
| `media.path` | 1–1,000. `alt` 1–300. `poster` 1–1,000, and only on a `.mp4` or `.webm` path. |
| `copy.items` | 1 to 8. `label` 1–24. `text` 1–5,000. |
| `decide` labels | 1–24, one line, no space at either end. |
| `decide.items` | 1 to 12. `id` matches `^[a-z0-9-]{1,40}$`, unique in the block. `title` 1–140. `meta` 1–80. `md` 1–600. `choices` 1 to 3. `due` is a real `YYYY-MM-DD` day. `url` 8–2,048. `copy` at most 4, `label` 1–24, `text` 1–5,000. |
| `pick.options` | 2 to 4. `id` matches `^[a-z0-9][a-z0-9_-]{0,31}$`. `name` 1–48. `md` 1–600. `facts` at most 6, `label` 1–32, `value` 1–80. `suggested` must be an option id. |
| `post.text`, and `variants.<platform>.text` | 1–63,206. |
| `post.hashtags`, and a variant's `hashtags` | At most 30. Each tag matches `^[^\s#]{1,100}$` (1–100 characters, no space, no `#`). |
| `post.author.name` | 1–60. `handle` matches `^[^\s@]{1,30}$`. `headline` 1–120. `avatar` 1–400. |
| `post.persona` | 1–40. `post_id` 1–60. |
| `post.first_comment` | 1–1,250. `notes` 1–600. |
| `post.flag` | At most 8 unique strings, each 1–20. |
| `post.link` | `url` is `https://` and at most 2,000. `title` 1–120. `domain` 1–60. |
| `post.target` | `type` is `quote` or `reply`. `url` is https and at most 2,048. `excerpt` 1–600. `author.name` 1–60. `author.handle` matches `^[^\s@]{1,30}$`. Both author fields are optional. |
| `post.image` and `post.video` | `path` 1–400. `alt` 1–300. Video `poster` 1–400. Not both image and video. |
| `post.platforms` | 1 to 4, no duplicate platform. |
| Result `note` | At most 4,000. `revise` needs a non-blank note. |
| Result `refs` | At most 20. `label` 1–120. |

## Bot identity

Each bot can show a name, an avatar, and an accent. The header shows the avatar and the name of the report on screen. With two or more open reports the side inbox shows one row per report, with that bot's avatar. The accent replaces the default accent for the report on screen. Inbox rows do not paint another report's accent.

Sources, first match wins: the payload `identity`, then `<data dir>/bots.json`, then the shipped `core/bots.json`, then the defaults (the name is the bot id, the avatar is initials, the accent is the theme accent). `name` and `accent` resolve per field. An invalid name or accent is skipped, and the next source is used for that field. The report is still accepted.

`avatar`, `avatar_shape`, and `avatar_color` come together from the first source that states any of them. Inside that source the order is image, then shape plus colour, then initials.

- An unknown shape or colour counts as stated. The search stops, and a later source is not used.
- An unknown shape draws initials, unless this source also has a usable image.
- An unknown colour keeps a known shape from this source and draws it in the default colour. With no shape and no usable image, the page draws initials.
- A missing image file is an error on that field and does not by itself mark the source as stated. If that broken image is the only avatar field, a later source can still supply an image.
- An empty `avatar` string (`"avatar": ""`) does mark the source as stated and clears the image, so a later source is not used.

The shipped registry holds names only.

A registry entry is `"inbox-agent": "Inbox Agent"` or an object `{"name", "avatar", "accent", "avatar_shape", "avatar_color"}`. The string form means a name only.

| Field | Rule |
| --- | --- |
| `name` | Plain text, trimmed, 1 to 40 characters, no control characters and no bidi controls. Always rendered as text. On a payload, set it to the bot's exact name in Grok Bot. The doorbell's `bot_name` is that payload `identity.name` when the report gives one, otherwise the bot id. A name in the bot registry does not count. |
| `avatar` | PNG, JPEG, WebP, or GIF. No SVG. At most 256 KB. Shown at 32 pixels, and at 24 pixels in the overflow menu. A payload value is a `data:image/<type>;base64,...` URL, or an absolute path inside the data folder. A registry path is relative to the registry file's folder, or an absolute path inside the data folder. No `..`, no UNC. The bytes must match the type. |
| `avatar_shape` | `blob`, `squircle`, `pebble`, `hex`, `teardrop`, or `tablet`. |
| `avatar_color` | `blue`, `orange`, `yellow`, `magenta`, `red`, `violet`, `black`, `green`, or `gray`. The page draws the shape from `core/static/avatar-shapes.json`. `black` is drawn white in dark mode. |
| `accent` | `#RRGGBB`. Checked per theme against `contrast-pairs.json`: accent and its hover fill versus the page and the card, the label versus the accent, and the focus ring. A theme that fails uses the default accent and is listed in `accent_fallback`. For example, `#0891b2` falls back in the light theme because its hover fill is too close to white. Without `accent`, `avatar_color` seeds the accent through the same checks. A seeded theme that fails is listed in `accent_fallback` and does not add a warning. |

`doctor` lists registry problems in `identity_warnings`. The same warnings can appear on the result under `identity.warnings`, and as `warning` events in the action log.

## Data folder

`RS_DATA_DIR`, when set, is the data folder, and it is never migrated. Otherwise:

| System | Folder |
| --- | --- |
| Windows | `%LOCALAPPDATA%\grokbot-desk` |
| macOS | `~/Library/Application Support/grokbot-desk` |

On Windows the older folder `%LOCALAPPDATA%\spqrk-report-shell` stays in use while it still has a `runs` directory, the new folder does not yet hold a run or a result file, and either the new folder does not exist or the old folder holds a run or a result file. An empty new folder does not hide reports that are still in the old folder. After `migrate`, the old folder is not created again for normal use. A desk started with `RS_DATA_DIR` pointed at the old folder after the move refuses to start.

The folder holds `runs/`, `results/`, `log/`, `media/`, `config.json`, `bots.json` when you set registry identities, and `doorbell.json` when the doorbell is on. `doorbell.json` holds the webhook URL and the key. The desk never prints the key. The action log is one JSONL file per day in `log/`.

When the desk starts, it deletes files in `runs`, `results`, and `log` that are older than 30 days. An open report from before this payload is kept until that start expires it. Media and browser profiles are kept.

## Configuration

`<data dir>/config.json` is optional. Missing keys use the defaults. `window` is merged onto the defaults, so a partial object keeps the other default fields. Other top-level keys are kept in memory and are not read. An old `webhook` object is ignored.

A command that reads the config for its settings (`show`, `wait`, `result`, `results`, `paths`, `status`, `open`, `cancel`, `doorbell`, `stop`, `serve`) exits 2 when `config.json` cannot be read or is not an object. The stderr line is `report-shell: invalid config: ...`. A `port` that cannot be read as an integer, or a port outside 1 to 65535, exits 2 when that config port is the one selected. `--port` on the command uses the flag instead, so a bad config port is not read. A file that cannot be parsed still exits 2 with `--port`. `doctor`, `check`, and `update` do not read `config.json`. `migrate` does not load it for a port or a window. On Windows, before the move, it reads the file and rewrites `media_roots` when those paths sit under the old folder. A file it cannot parse is left as it is.

| Field | Default | Meaning |
| --- | --- | --- |
| `port` | `18742` | Desk port, 1 to 65535. `--port` overrides it for one command. |
| `window` | `{"x": 0, "y": 0, "width": 880, "height": 920}` | Window position and size. A non-positive width or height falls back to the default size. |
| `media_roots` | The person's Downloads folder, and `<data dir>/media` | Absolute directories an ordinary media path must resolve under. |

Environment variables the desk reads:

| Variable | Effect |
| --- | --- |
| `RS_DATA_DIR` | Data folder. Never migrated. |
| `RS_LANG` | `en` selects English. Anything else, including unset, is German. |
| `RS_TZ` | An IANA time zone for display and screenshots. Used when time-zone data is available. Without that data, a Central European name in the desk's built-in set (for example `Europe/Vienna`) uses the EU daylight-saving rule, and `UTC`, `Etc/UTC`, `Etc/GMT`, and `GMT` stay UTC. Any other name falls back to the machine's zone, and the page is told there is no pin. |
| `RS_PYTHON` | Python for the Node test tools. Set it so those tools and pytest use the same interpreter. |
| `RS_SERVER_START_TIMEOUT_MS` | How long the CLI waits for a new desk. Default 10 seconds. Bounded to 1 through 120 seconds. |
| `RS_CLI_HTTP_TIMEOUT` | Timeout for CLI requests to the desk, other than the short hello. Default 3 seconds. Capped at 60. |
| `RS_PLAYWRIGHT_CORE` | Where the screenshot tools find Playwright. Set it when the package is not installed next to the tools. |
| `REPORT_SHELL_PYTHON` | Replaces the `./report-shell` search. The only executable tried. A bad value exits 1 even when a suitable interpreter is installed. |

The CLI waits up to 10 seconds for a new desk to answer. If this checkout's process is listening but not answering yet, it gets one more period of the same length. A port that opens as that wait ends is given 2 seconds to write `state.json` before it counts as another program.

## Doorbell

Grok Bot does not wake a bot when a background command finishes. The doorbell is one Desk Doorbell bot on this computer. Install it from the [Desk Doorbell template](https://x.ai/bot/Q_-PLlmHrV1l2h3Tk1ejJ). The texts and the install steps are in [doorbell/README.md](../doorbell/README.md).

The doorbell is off until a URL and a key are saved. The file is `<data dir>/doorbell.json`. The key is never put in a payload, never written in chat, and never printed.

The desk rings when a report is submitted, cancelled by the person (discarded on the page), or expired. A bot's own `cancel` never rings, even when the person asked the bot to cancel. The desk POSTs JSON to that webhook with `Authorization: Bearer` and the key. The body is `bot`, `bot_name`, `run_id`, `status`, and `title`. `status` is `submitted`, `cancelled`, or `expired`. `bot_name` is the payload `identity.name` when that report gives one, otherwise the bot id. A name in the bot registry does not count.

The Desk Doorbell bot picks one Bot. A Bot whose name is exactly `bot_name` gets the message. Otherwise it slugs each Bot name. The slug is lower case. It keeps only ASCII a-z and 0-9. Every run of other characters (spaces, punctuation, umlauts, emoji) becomes one `-`, then `-` at the ends is removed. There is no transliteration. `Work Bot (Alpha)` becomes `work-bot-alpha`. `Büro Bot 🤖` becomes `b-ro-bot`. It matches that slug against `bot_name` and against `bot`. Exactly one match is sent this line. None or several: it writes `Desk: no Bot named <bot_name>.` in its own chat.

```text
Desk: <title> is <status>. Read the result with report_shell.py result <run_id>.
```

Set `identity.name` to the bot's exact name in Grok Bot. The desk id must match `^[a-z0-9-]{1,40}$` and be unique. A desk id that is the slug of that name also matches. When the slug of the Grok Bot name is not a good id, choose any valid unique id and always set `identity.name` to the exact Grok Bot name. The exact name wins over slugs. That bot reads the result and answers. A plain test (`{"status": "test"}`) writes `Desk: doorbell test received.` in the doorbell's own chat. That line can arrive minutes late. `doorbell test --to "<name>"` sends `Desk: doorbell test.` to that bot, seen within a minute.

The desk retries for about 4 minutes on rate limits, server errors, and a failed connection. It does not follow a redirect, so the key is not sent to another address. A ring can be lost when the desk stops, or when Grok Bot stays busy for minutes. Nothing wakes the bot then. At the start of every turn, doorbell on or off, the bot catches up with `results --since`. If a decision got no reaction, message the bot.

`status` and `doctor` print `doorbell` as `on` or `off`. The commands are under [doorbell command](#doorbell-command).

## Commands

JSON on stdout is one compact line. Non-ASCII characters are `\u` escapes, so JSON is ASCII on every stream. Error lines follow the stream encoding. A UTF-8 stream (macOS, a Windows console, or a Windows pipe whose encoding is UTF-8) prints text as UTF-8. A stream that is not UTF-8, including a default Windows pipe, stays ASCII, and characters that do not fit are backslash escapes.

Errors returned by a command are one line on stderr: `report-shell: <message>`. A usage error from the argument parser prints a usage block and a line beginning `grokbot-desk:` or `grokbot-desk <command>:`, and exits 2. A crash leaves a Python traceback and exits 1.

On the next `show` or `open`, an idle desk whose `version` is not this checkout's version is stopped and started again. That includes a missing version and a newer one. An equal version string is left as it is. A desk with open reports keeps running until those reports are decided. `status` field `version` is the version of the desk that answered, or `null` when the desk is down.

The desk stops itself after 30 minutes with no open report and no page connected.

```text
check payload.json
show --data payload.json
doorbell
wait RUN_ID --timeout 60
result RUN_ID
```

`--port N` (1 to 65535) works before or after the command. The default is `config.json` `port`, else 18742. `--version` prints `grokbot-desk` and the version.

### show

Open a report from a payload.

```text
python report_shell.py show --data <path|-> [--focus] [--no-window]
```

| Flag | Meaning |
| --- | --- |
| `--data` | Payload JSON file, or `-` for stdin. Required. |
| `--focus` | Bring the window to the front on Windows, at most once per burst. |
| `--no-window` | Register the report and do not open a window. |

A positional template name is rejected. The payload's `ask` and blocks say what the report is. The maximum size is 2 MB. Nesting deeper than 64 fails. One leading UTF-8 BOM is stripped. Media paths are checked against `media_roots` before the desk starts.

Stdout:

| Field | When |
| --- | --- |
| `run_id` | Always. |
| `url` | Always. |
| `result_path` | Always. |
| `data_dir` | Always. |
| `deduped` | A duplicate `dedupe_key` was returned. The existing report is unchanged. |
| `state` | With `deduped`: `open`, `submitted`, or `cancelled`. |
| `warnings` | A clamped `created`, or a `why` past the fold limit. |
| `data_dir_warning` | The older Windows data folder is in use. The text names `migrate`. |

A duplicate that is already decided does not open a second report and does not focus the window. If the window fails to launch after the report was registered, the command exits 3 and prints no JSON. The report may already be on the desk.

Exit 0, 2, 3, or 4.

### wait

Wait until a report has a result. How a bot waits, catches up, and acknowledges is in the [skill](../skills/grokbot-desk/SKILL.md).

```text
python report_shell.py wait <run_id> [--timeout <seconds>]
python report_shell.py wait <run_id> --until-expiry
```

A short wait is `wait RUN_ID --timeout 60`, in the foreground, while this turn lasts. Never use `--timeout 0`. Do not hand `wait` to a background task. Grok Bot does not wake a bot when a background command finishes. Exit 5 means the report is still open. With the doorbell on, end the turn instead of waiting. A chat line that starts with `Desk: ` is the wake. With the doorbell off, a decision after that wait needs a new chat message from the person. That message wakes the bot. At the start of every turn, doorbell on or off, the bot catches up with `results --since`. If a decision got no reaction, message the bot. How a bot acknowledges is in the [skill](../skills/grokbot-desk/SKILL.md).

| Flag | Meaning |
| --- | --- |
| `--timeout` | Seconds to wait. Default 0, which means no time limit. Exit 5 when the report is still open. |
| `--until-expiry` | Wait until the report's expiry plus 2 minutes. Excludes `--timeout`. |

The result file is checked every 200 ms. Stdout is `{"status", "result_path", "data_dir"}`.

With a readable `expires`, the wait also ends at expiry plus 2 minutes (exit 7) when no result was written. If both a timeout and that expiry exist, the earlier one wins: exit 5 when the timeout is first, exit 7 when the expiry is first. A record without a readable `expires` has no expiry deadline, so only `--timeout` ends that wait.

Exit 0, 2, 5, 6, or 7. Exit 2 covers a bad combination of the two flags and other usage errors. Exit 6 is an unknown `run_id`.

### result

Print the result of a decided report.

```text
python report_shell.py result <run_id>
```

Stdout is the result envelope plus `data_dir`. The file on disk is not modified. Exit 0, or 6 when the `run_id` is unknown or the result is not written yet. An open report has no result file yet.

### results

List results decided since a time, oldest first. Open reports are not included.

```text
python report_shell.py results --since <iso> [--bot <id>] [--wait <seconds>] [--seen <run_id>]
```

Before the first `show`, record the current time (ISO 8601 with an offset). Keep that time with the `run_id` that `show` returns. That time is the first `--since`. After that, pass the returned `cursor` as the next `--since`. Pass every `run_id` already handled as `--seen`, including the `seen` list from the last answer. At the start of every turn, doorbell on or off, run this catch-up. A ring can be lost when the desk stops, or when Grok Bot stays busy for minutes. Nothing wakes the bot then. If a decision got no reaction, message the bot.

| Flag | Meaning |
| --- | --- |
| `--since` | Required. ISO 8601 with an offset, or the `cursor` from last time. The comparison is inclusive on `decided`. Fractional seconds are ignored, so a cursor with milliseconds still includes a result decided earlier in that same second. |
| `--bot` | Only this bot id. |
| `--wait` | Seconds to wait for a first new result. Default 0. Capped at 3600. The command polls every 0.5 seconds. |
| `--seen` | A `run_id` already handled. Repeat the flag. |

Stdout is `{"data_dir", "results", "cursor", "seen"}`. Each item has `run_id`, `bot`, `status`, `decided`, `result_path`, `title` when a title is still known, and `summary` when the decision is compact.

`summary` is a one-line reading, for example `submit · 2 approve, 1 later`, `choose thu`, `approve · x, linkedin`, or `read`. It is not permission to post or to pay. Read `data`. Post only an auto platform whose `included` is true. Pay only a decide row whose `choice` is `approve`.

When any result matches `--since` before the `--seen` filter, `cursor` is that set's newest `decided`, and `seen` is every `run_id` decided in that same second. If every match was already listed in `--seen`, `results` is empty and `cursor` and `seen` still move to that newest match. `cursor` stays the `--since` you passed, and `seen` keeps the previous values, only when nothing matched before the filter.

Exit 0, or 2 when `--since` is not ISO 8601 with an offset.

### paths

Print the data folder in use.

```text
python report_shell.py paths
```

Stdout: `data_dir`, `source` (`RS_DATA_DIR`, `legacy`, or `default`), `runs`, `results`, `log`, `config`. `unused_data_dirs` lists another candidate that still has a `results/` directory. `warning` is present while the older Windows folder is in use by default:

```text
this is the older data folder; run `python report_shell.py migrate` while the desk is closed to move it to the new name
```

A caller learns the directory from `paths`, `show`, `wait`, `result`, or `results`. It does not guess. Exit 0.

### status

Print whether the desk is running.

```text
python report_shell.py status
```

Stdout: `up`, `port`, `version`, `pid`, `open_runs`, `window_alive`, `data_dir`, `doorbell`. `doorbell` is `on` or `off`. `open_runs` is how many reports are open. When the desk is down, `up` is false, `version` and `pid` are null, `open_runs` is 0, and `window_alive` is false. `version` is the version of the desk that answered. Exit 0.

### open

Open the window for the reports that are open.

```text
python report_shell.py open
```

No open reports: `{"ok": true, "opened": false}`. The window is already up: the same object, and on Windows the window is brought to the front. On macOS that call does nothing. Otherwise the command launches the window: `opened` is true when this call launched it, and `pending` is true when a launch is already in progress. Exit 0, 3, or 4.

### cancel

Discard an open report. The result is `cancelled`. Cancel only when the person asks, or to replace your own open report with a newer version of the same thing.

```text
python report_shell.py cancel <run_id>
```

Stdout: `{"status": "cancelled", "result_path"}`. Exit 0, or 6 when the `run_id` is unknown, already decided, or the request fails. This cancel is the bot's own, so the doorbell does not ring, even when the person asked the bot to cancel.

### doorbell command

Show whether the doorbell is on, set it up, ring once, or switch it off. The key is never printed.

```text
python report_shell.py doorbell
python report_shell.py doorbell setup
python report_shell.py doorbell setup --url URL --key-stdin
python report_shell.py doorbell test [--to NAME]
python report_shell.py doorbell off
```

| Action | Meaning |
| --- | --- |
| (none) | Print `{"doorbell": "on" or "off", "host"}`. `host` is the webhook host, or null when the doorbell is off. `on` means the address and key are saved. It does not prove a test reached Grok Bot. |
| `setup` | Open the setup page in the desk window (`http://127.0.0.1:<port>/?page=doorbell`). The person pastes "POST to" and "key" from Grok Bot, Desk Doorbell, Routines, the webhook routine. Save writes `doorbell.json` and sends a test ring. When the save worked and the test failed, the page says `Saved. The test did not reach Grok Bot: …`. |
| `setup --url URL --key-stdin` | Headless. `URL` is the webhook address, https only, with a host and no user or password. The key is one line on stdin. This writes the file and does not ring. |
| `test` | One ring now, no retries. The body is `{"status": "test"}`. `--to NAME` is the exact Grok Bot name. The body is then `{"status": "test", "bot_name": NAME}`. A plain test writes `Desk: doorbell test received.` in the doorbell's own chat. An addressed test sends `Desk: doorbell test.` to that bot. |
| `off` | Delete `doorbell.json`. |

`doorbell` and `doorbell off` print `doorbell` and `host`. A window `setup` prints `ok`, `opened`, `pending`, `url`, `doorbell`, and `host`. `opened` and `pending` mean the same as on `open`. A headless `setup` prints `doorbell` and `host`. `test` prints `ok`, `http_status`, and `host`. A failed ring also prints `category` and `error`. `category` is `unreachable`, `refused` (check the address and the key), `busy` (a rate limit or a server error; try again in a minute), or `other`.

Exit 0 when the command worked. `test` exits 0 when the ring was accepted, 4 when the ring failed, and 2 when the doorbell is off (`the doorbell is off; set it up with: doorbell setup`). A bad URL, a bad key, `--url` without `--key-stdin`, `--key-stdin` without `--url`, or a stdin that is not one key line exits 2. A browser that cannot start on `setup` exits 3. A desk that cannot start on `setup` exits 4. A file that cannot be written exits 7.

### doctor

Check bot identities and the data folder.

```text
python report_shell.py doctor
```

Stdout: `ok` (true), `identity_warnings` (a list of strings), `doorbell` (`on` or `off`). `data_dir_warning` is added while the older Windows folder is in use. Warnings do not fail the command. Exit 0.

### check

Validate a payload file. This does not open a desk.

```text
python report_shell.py check <file>
python report_shell.py check -
```

`<file>` is a payload JSON file. `-` reads stdin. On success, stdout is `ok` and the exit code is 0. Warnings, such as a `why` past the fold limit, go to stderr. On failure, exit 2 and stdout is `pointer: message`. There is no JSON object.

### serve

Run the desk in this terminal. Use the `serve` command when a runtime ends child processes. It stays in the foreground until the desk stops. A clean idle stop exits 0. Exit 4 when the port cannot be bound or the data folder is busy.

### stop

Stop the desk.

```text
python report_shell.py stop
```

Run `stop` before `migrate`, and when the person asks you to update and the older data folder is in use. Stdout: `{"ok": true, "stopped": true}` when a desk was stopped, or `stopped: false` when none was running (still exit 0). Exit 4 when the stop request fails.

### migrate

Move the older Windows data folder to the current name. Run `stop` first, while no report is open. macOS has nothing to migrate. `RS_DATA_DIR` is never moved.

```text
python report_shell.py stop
python report_shell.py migrate
```

On Windows the command moves `%LOCALAPPDATA%\spqrk-report-shell` to `%LOCALAPPDATA%\grokbot-desk`. Before the move it rewrites media paths and identity paths in decided reports, and `media_roots` in `config.json`, so they point at the new folder. If the move fails, those files are put back.

| Result | Stdout or error | Exit |
| --- | --- | --- |
| `RS_DATA_DIR` is set | `{"migrated": false, "reason": "RS_DATA_DIR is set; it is never migrated"}` | 0 |
| Not Windows, or no `LOCALAPPDATA` | `{"migrated": false, "reason": "nothing to migrate on this system"}` | 0 |
| The old folder is absent | `{"migrated": false, "reason": "nothing to migrate", "from", "to"}` | 0 |
| Moved | `{"migrated": true, "from", "to", "config_rewritten", "runs_rewritten"}` | 0 |
| The new folder already holds files | nothing was changed | 7 |
| A desk is running or starting in either folder, including a window still opening, another migrate is running, or a report in the old folder is still open | nothing was changed | 4 |
| The move itself fails | the old folder stays in use | 7 |

Housekeeping files alone (`server.lock`, `state.json`, `migrate.pending`) do not count as "holds files". A pending marker older than 2 minutes is stale. After a successful move the old folder is not created again for normal use. `wait` and `results` follow a migration that happens while they run.

### update

Fast-forward this git clone on its current branch (`git pull --ff-only`). It does not switch branches. Releases are on `main`. A checkout for testing builds may be on `develop`. Read `branch` in the output. If it is not `main`, and it is not `develop` when the person asked for testing builds, tell the person. Do not claim a latest release unless `branch` is `main`. Then follow `next`.

A bot runs `update` only when the person or the maintainer asks. The install notes are in the [README](../README.md).

```text
python report_shell.py update
```

Stdout: `updated` (true when `HEAD` moved), `from` (the version before the pull, or null), `to` (the version after), `branch`, and `next`. `next` is a list of what is left to do. Today it has one entry when the older data folder is in use: decide or discard open reports, run `stop`, then `migrate`. When `next` is empty, the next `show` or `open` restarts an idle desk whose version differs from this checkout.

Exit 7, before the pull and without changing the checkout, when the folder is not a git clone, the clone is on a fixed tag (detached `HEAD`), or it has local changes (untracked files are ignored). Git missing, or a git step that does not answer within 120 seconds, also exits 7. A pull that fails or times out exits 7 too. That pull can already have fetched objects and updated remote-tracking refs, and HEAD may already have moved. Exit 0 when the pull succeeds, including when it was already up to date.

## Exit codes

| Code | Meaning | What you do |
| --- | --- | --- |
| 0 | Success. | Continue. |
| 1 | Python is older than 3.11, or the process crashed. A crash leaves a Python traceback on stderr. | On macOS use `./report-shell`. Otherwise install Python 3.11 or newer ([README](../README.md)). After a crash, tell the person. The result file can still be read. |
| 2 | Invalid payload, arguments, or config. Bad media on `show`. `--since` is not ISO 8601 with an offset. `--until-expiry` combined with `--timeout`. Port outside 1 to 65535 when that port is selected. A non-numeric `port` in `config.json` exits 2 only when the command uses that port. `--port` overrides it. A config file that cannot be parsed still exits 2. `check` prints `pointer: message`. `doorbell test` while the doorbell is off. A bad doorbell URL or key, or a bad `doorbell setup` flag combination. Unknown command or other usage error. Stderr names a JSON pointer when there is one. | Fix the input. Do not retry it unchanged. |
| 3 | The browser could not be started (`show`, `open`). On Windows that is usually no Edge or Chrome. On macOS a missing Edge or Chrome falls back to the default browser, so their absence alone is not exit 3. Exit 3 there means the launch itself failed. A launch can also fail after a browser was found. | Tell the person in chat. Do not open another browser yourself. |
| 4 | The port is taken, or the desk did not start. Also: `show` got a network or HTTP error other than 400. `open` failed while starting. `doorbell setup` could not start the desk. `doorbell test` ring failed. `stop` could not deliver the request. `serve` could not bind or the data folder is busy. `migrate` refused because a desk is running, another migrate is running, or a report is still open. | Run `status`, try once more, then tell the person. Never pick another port yourself. For `migrate`, stop the desk and decide or discard open reports, then run it again. For a failed test ring, read `category`. `unreachable` means no connection. `refused` means check the address and the key. `busy` means a rate limit or a server error; try again in a minute. `other` means try again later. |
| 5 | `wait` reached `--timeout` while the report was still open. | End the turn. With the doorbell on, a chat line that starts with `Desk: ` is the wake. With it off, a decision after that wait needs a new chat message from the person. Either way, the next turn starts with `results --since`. |
| 6 | Unknown `run_id` (`wait`, `cancel`). `result` is unknown or not written yet. `cancel` of a report that is already decided, or a cancel request that failed. | Check the `run_id`. For `result`, try again later. |
| 7 | `wait` passed expiry plus 2 minutes with no result. `update` refused, the pull failed, git is missing, or a git step did not answer within 120 seconds. `migrate` found files in the new folder, or the move failed. `doorbell setup` could not write `doorbell.json`. | For `wait`, treat the report as expired. Otherwise fix the clone or the folders. A refused `update` that never started the pull changes nothing. A failed or timed-out pull may already have fetched objects. A refused `migrate` changes nothing. If the folder move itself fails, the error says the old folder stays in use. |
