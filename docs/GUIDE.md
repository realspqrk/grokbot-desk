# grokbot-desk template guide

This guide is for you if you design a template, or if you call the desk from your own program. A bot that sends reports should read [skills/grokbot-desk/SKILL.md](../skills/grokbot-desk/SKILL.md). Install, update, and the first desk are in the [README](../README.md).

The desk is the window and the local app behind it. A report is one thing a bot puts on the desk. In command output that same report is a run: the fields are `run_id`, `open_runs`, and the folder `runs/`.

From the repository root:

```text
python report_shell.py <command>
./report-shell <command>
```

The rest of this guide uses `python report_shell.py`. On macOS, use `./report-shell` in its place. `./report-shell` looks for an executable Python 3.11 or newer named `python3`, then `python3.14` down through `python3.11`, including the copies under `/opt/homebrew/bin` and `/usr/local/bin`. It skips `/usr/bin/python3`. `REPORT_SHELL_PYTHON`, when set, replaces that search. It is the only executable tried. A bad value exits 1 even when a suitable interpreter is installed. On Windows, `report-shell.cmd` uses the `py` launcher. If `python` works and `py` does not, keep the form above.

`python report_shell.py --help` lists the commands and the flags that apply before a command (`--port`, `--version`), and it prints a typical flow. It does not list each command's own flags. `python report_shell.py <command> --help` lists that command's flags. It does not repeat the typical flow, `--port`, or `--version`. `templates --paths` is omitted from help.

## Contents

- [How a desk works](#how-a-desk-works)
- [Design rules](#design-rules)
- [Build a template](#build-a-template)
- [Anti-patterns](#anti-patterns)
- [Envelopes](#envelopes)
- [Task banner](#task-banner)
- [Bot identity](#bot-identity)
- [Data folder and template resolution](#data-folder-and-template-resolution)
- [Configuration](#configuration)
- [Doorbell](#doorbell)
- [Commands](#commands)
- [Exit codes](#exit-codes)

## How a desk works

A bot runs `show` with a JSON payload for a template. The desk opens one Edge or Chrome app window on the person's computer. The person decides. The bot reads the result JSON with `result`, after a [doorbell](#doorbell) message, a foreground `wait`, or `results --since`. At the start of every turn, doorbell on or off, the bot catches up with `results --since`. The desk is local. At runtime it needs Python 3.11 or newer and the standard library only. It runs on Windows and on macOS.

The shell draws the header, the task banner, and the footer. Your template fills the page. Prefer a built-in when it already fits. The five built-ins are linked from the [README](../README.md). The sixth folder, `_starter`, is the copy source for new templates.

What the person sees:

- One Edge or Chrome app window, with its own profile. No tabs and no address bar. The default size is 880 by 920 pixels at position 0, 0. That is an 864 by 836 page plus the window frame. `config.json` `window` overrides it. Long lists and documents scroll inside the report. The header and the footer stay put.
- If the desk is already open, a new report arrives quietly. The title gets the prefix `● ` while any open report is unread. On Windows the taskbar button flashes at most once per burst. Pushes less than 30 seconds apart are one burst. A window opened for the first report of a burst counts as that burst's one bring-forward. The page uses the same 30-second quiet gap for its one announcement. The desk does not jump to the front. `show --focus` brings the window to the front on Windows, also at most once per burst. Use `--focus` only when the person asked for the report right now. On macOS the focus call has no effect.
- Under the title, a tinted task banner says what to do and who acts next. See [Task banner](#task-banner).
- With exactly one open report there is no strip. The header shows the bot's avatar, its name, and the report title. With two or more open reports a slim avatar strip sits above the header: one avatar per bot, with a count when that bot has more than one. The open count sits in the header byline, beside the overflow menu. In English it reads "{n} of {m} open", or "{m} open" when the report on screen is not one of those rows.
- The page receives at most 12 open reports, the 12 newest by `created`. Within those, arrival order is kept: bots stay in the order they first appeared, and each bot's reports stay in registration order. A `created` stamp does not reorder that set. When more than 12 reports are open, an older one can be left off the page.
- `Ctrl+1` through `Ctrl+9` switches reports, and so does `Cmd+1` through `Cmd+9`. On the strip, Left, Right, Home, and End move along it. The strip is one Tab stop.

When several bots send at once, the desk stays one window. Concurrent `show` calls with no window open launch one window. A window that is still starting is waited for. The report on screen stays. A new report becomes the one on screen only when nothing open is shown. Then the oldest arrival in the set the page received comes first.

One announcement per burst, for screen readers. English examples: "3 new reports from 2 bots", "2 new reports from Inbox Agent", or "New report: <title>". A single report that is shown at once needs none. The page collects a burst for up to 10 seconds, announces it once, and stays quiet until 30 seconds have passed with no new report.

Activating the current bot's avatar again steps to that bot's next report. After a decision the desk moves on to the same bot's next open report before it moves to the next bot.

After the last decision, the page that owns the launch token may close. The desk passes that token (`?app=`) to every window it opens, including the macOS default-browser fallback. The first page that presents a valid token owns it. That page shows "All done. This window closes in a moment." with Keep open, and it may close after 4 seconds. A new report in that moment, Keep open, or a close the browser refuses leaves the window open. A page that does not own the token shows "All done." and stays open. Open reports never close the window by themselves. If the person closes the window, open reports stay open. The next `show`, or `open`, opens the window again.

When no report is on screen while some wait, the desk lists them under "Waiting for you". A row opens its report.

## Design rules

A decision, including a single yes or no, is a report (`approve-one`). A status, a weekly summary, or a research outcome is a `review-doc` report with `task.kind` `fyi`, even when it is short. Chat is for small talk, a clarifying question, or the one-line acknowledgement. The bot's rules for when to open a report are in the [skill](../skills/grokbot-desk/SKILL.md).

### Action design

Every item ends in an explicit choice. The person picks. Nothing is decided by default. Discard and expiry are the do-nothing outcomes: the result is `cancelled` or `expired`, and the bot does nothing.

Set `task.kind` and write a short `task.why`. Aim for three sentences. Labels say who acts next. The actor-model built-ins take their buttons from one table. See [Task banner](#task-banner).

At most three choices per item. Use `rs-action-row`. No choice is preselected. Keep the primary disabled until the input is complete: call `RS.setResult(null)` until every required choice is made, and `RS.setStatus(text, tone, label)` says what is missing. `label` is the accessible name when the visible line is shorter.

The desk records the decision. The bot does the work after it reads the result.

### Copy first

Anything the person would otherwise retype gets an `rs-copy`: an amount, a reference, a reply, a post, hashtags, a path. The copied string is shown in full next to its button. Use `mono` for amounts, ids, and paths. Use `no-value` only when that text is already visible beside the button.

The clipboard receives the exact string. There is no line-ending conversion. If the template composes a string, the composed string is what is shown, counted, and copied. One copy is at most 100,000 UTF-16 code units. Templates usually cap their own texts lower.

`RS.copyImage(id)`, or `<rs-copy media="id">`, puts an image on the clipboard as a picture. On macOS that is PNG, JPEG, GIF, or WebP, written as PNG and TIFF. On Windows that is PNG, JPEG, or GIF, written as a bitmap. WebP is not pasted as a picture on Windows. `RS.copyPath(id)`, or `<rs-copy media="id" media-copy="path">`, copies the file path. That is how a video is handed to a manual post.

Every `rs-copy` gets a stable `data-copy-id`, so `fixtures/expect/` can find it.

### Density

A `decide-list` holds 1 to 12 items. The current item is a card. The others are quiet rows. One card is open at a time. More than 12 items is another report. The bot chooses what belongs on this screen.

What the bot already handled, with no decision left, goes in `done` (at most 12). The page shows that list under one closed disclosure.

A short report keeps the footer directly under its content. A long list or document scrolls inside the report, and the footer stays at the bottom of the window. The header stays either way. When the report scrolls, the shell fades the last 24 pixels above the submit bar into the paper, and only while more follows. In a sent, read-only view the fade sits above the window edge. Keyboard focus scrolls clear of the fade. Templates add no fade and no bottom spacing of their own.

Empty sections are not rendered.

### Strings and local time

German is the default UI, from `core/i18n/de.json`. Set `RS_LANG=en` before the desk starts to select English (`core/i18n/en.json`). An unknown `RS_LANG` stays on German. The English strings in this guide are the `en.json` values. Times use the machine's time zone. `RS_TZ` can pin an IANA zone for tests and screenshots. See [Configuration](#configuration) for when that pin falls back.

Every visible UI string comes from the string table. Templates contain no literal UI text. Declare a string in one of these ways:

- Static text in `template.html`: `<span data-rs-t="key"></span>`.
- Localised attributes (`placeholder`, `title`, `aria-label`, `alt`): `data-rs-t-<attribute>="key"`.
- Dynamic text in `template.js`: `RS.t("key", {name: value})`. `{name}` placeholders in the value are filled from the params.
- Payload text is set with `textContent`. Never `innerHTML`.

Every key a template uses is listed in `template.json` `strings` and exists in `de.json`. `check` fails until the key is there. Add the English value to `en.json` in the same change when you own both files. A template in the data folder does not edit `core/`. Ask the maintainer to add the shared key.

`RS.time(iso)` shows local time. German: `Do 08.10.2026 · 10:39`. English: `Thu, Oct 8, 2026 · 10:39`. `RS.date(isoDate)` shows a calendar date. German: `15.10.`. English: `Oct 15`. `RS.number(n)` groups digits from the selected table. German: `99.999`. English: `99,999`.

Every timestamp in a payload carries an offset (`+02:00` or `Z`). The desk converts it to local time. Timestamps in a result are local ISO 8601 with their offset.

To produce `created`:

- PowerShell: `(Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')`.
- Python: `datetime.now().astimezone().isoformat(timespec="seconds")`.

### No external requests

No CDN, web fonts, remote images, link unfurling, or any network call from the page. The Content-Security-Policy blocks it. The template lint rejects `http:`, `https:`, and `//` anywhere in `template.html`, `template.css`, and `template.js`. That includes `//` line comments. Write `/* ... */` comments only. System fonts only. The core sets them.

A link card in a post preview is rendered from the payload (`url`, `title`, `domain`). Nothing is fetched.

http(s) addresses in item text, review-doc Markdown, pick-option text, and a payload `url` field are real links. The page does not let those links navigate this window. Anchors are not draggable, a drag is cancelled, and dropping a URL on the page is cancelled. A primary click, a middle click, Enter, and a modified click call `RS.openUrl(url)`, which posts `{run_id, url}` to `/open-url`. Modified Enter does the same, except Ctrl+Enter and Cmd+Enter, which stay the submit shortcut.

The desk opens the system browser only when all of these are true:

- That exact address occurs in this report's payload.
- It is http or https.
- It is at most 2048 characters.
- It has a hostname or an IPv6 address (no zone id).
- It has a port from 0 to 65535.
- It has no credentials.

One malformed string does not discard the other URLs in the same text. A right-click on these links is cancelled so the menu cannot open the address in the app profile.

Images and video go through the media roots, except a `%RS_TEMPLATE%` path:

- The payload holds a path in a field marked `"x-rs-media"`. `true` is an image. `"video"` is a video. `%RS_TEMPLATE%` is template-relative and is not followed as a link. Those paths are read from the template folder. They do not have to sit under `media_roots`.
- Any other path is absolute. At `show` it must resolve, after realpath, under one of `config.json` `media_roots`. Defaults are the person's Downloads folder and `<data dir>/media`.
- Images: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, at most 20 MB. Video: `.mp4`, `.webm`, at most 200 MB. The file must exist. Relative paths, `..`, UNC paths, and ordinary paths outside the roots fail with exit 2.
- The page sees a media id, not the path. `RS.media(id)` is the URL for an image, a video, or a poster. `/media/<id>` is served in HTTP ranges, so a video can start without reading the whole file. A range with no bound (`bytes=-`) is ignored and the whole file is returned. `RS.reveal(id)` is Show in folder, and only for a media file of that same report.
- If a clip cannot be decoded, or makes no progress for 8 seconds, the loading indicator stops and the page says the preview is unavailable and that the path can still be copied or the file shown in its folder. `preload="none"` leaves an untouched clip on its poster and is not a failure.

A bot on another machine copies the file onto the person's computer first and puts that path in the payload.

### Accessibility

The core already sets `lang`, visible focus, token contrast, and the keyboard map. A template must not break them.

- Every control has an accessible name: a `<label for>` filled by `data-rs-t`, or `data-rs-t-aria-label`. `rs-action-row` gets a `label`. `RS.t('choice_group_label', {what: ...})` is `Decision: ...`.
- Every image has alt text.
- Focus stays visible. Do not override `outline`. The core draws at least 2 pixels at a contrast of at least 3:1.
- Colours only from `--rs-*` tokens. Text pairs meet WCAG AA, at least 4.5:1, in light and dark. No colour literals. No positive `tabindex`.
- Choices use `rs-action-row` (`role=radiogroup`, arrow keys).
- The whole flow works from the keyboard: Tab and Shift+Tab, Enter and Space, arrows in a choice row, Ctrl+Enter or Cmd+Enter to send, Esc to close a dialog, Ctrl+1 through Ctrl+9 or Cmd+1 through Cmd+9 to switch reports. `fixtures/expect/golden.json` `keyboard` proves the golden path.
- Status changes go through `RS.toast` (`aria-live`).
- Animations respect `prefers-reduced-motion`.

The calm checker has a few known limits. They are listed in [calm-checker-limits.md](calm-checker-limits.md).

### What a result means

Design `result.schema.json` first, then the UI. Keep it small. Echo the payload's item ids. Use enums for choices. Give free text a `maxLength`.

`actor` is `bot` (the default), `user`, or, on `approve-one` and `review-doc`, `none`. Bot results stay `approve`, `reject`, `request_changes`, and, on a list, `defer`. User results are `done`, `skipped`, and, on a list, `later`. Info only is `acknowledged`. The bot never acts on `user` or `none`.

Bots read the result file. Take the path from `result_path` in the `show` or `wait` output. `result` prints that same JSON, plus `data_dir` on stdout only. The file itself is unchanged. Never scrape the page, the run store, or the action log. A result file is written once, atomically, and never changes. Its `data` was validated against `result.schema.json` before it was written.

Bots wait as described in the [skill](../skills/grokbot-desk/SKILL.md). The command and its exits are under [wait](#wait). With the doorbell on, a chat line that starts with `Desk: ` is the wake. The bot runs `result` and answers every time.

| `status` | Meaning | The bot does |
|---|---|---|
| `submitted` | the person sent it | reads `data` and does the work. Acknowledges the decision in chat with topic + OK, including a refusal, a note, or a comment. For example: "Invoices: hosting approved, toner next week, OK. Paying hosting now." Says the work is finished only after it succeeded. |
| `cancelled` | the person discarded it, or `cancel` was run | does nothing with the decision. Records it in chat. No topic + OK. If the person asked for the cancel, stops and does not ask again. If the bot did not cause the cancel, asks in chat only when the task still needs an answer. The bot's own `cancel` never rings the doorbell, even when the person asked the bot to cancel. |
| `expired` | `expires_minutes` ran out (default 240, max 10080) | does nothing with the decision. Records it in chat. No topic + OK. Asks in chat only when the task still needs an answer. Shows it again later only if it still matters. |

Cancel a report only when the person asks, or to replace your own open report with a newer version of the same thing. Cancel, then `show` the new one. A `dedupe_key` never updates a report.

Never put secrets or full message bodies into a payload. Use short snippets. Files in `runs/`, `results/`, and `log/` older than 30 days are deleted when the desk starts. Media is kept.

`created` is ISO 8601 with an offset. A stamp more than 2 minutes ahead of the clock is clamped to now, and `show` adds a warning. Up to 2 minutes ahead is left as clock skew.

## Build a template

Use a built-in when it fits.

| Need | Built-in |
|---|---|
| Several items to approve, reject, or defer, or items the person does | `decide-list` |
| One approval, including a single yes or no, with an optional request for changes | `approve-one` |
| A social post to preview and approve | `preview-post` |
| A document, a status, a weekly summary, or a research outcome | `review-doc` |
| Two to four options, side by side | `pick-option` |

`python report_shell.py templates` lists what is installed. Use `new` only when no built-in fits.

1. Create the folder in the data directory. No repository branch is required for a template that stays on this computer.

   ```text
   python report_shell.py new <namespace>/<name>
   ```

   `<namespace>` is the bot id, for example `inbox-agent`. The command copies `templates/builtin/_starter` to `<data dir>/templates/<name>/` and sets `id`, `namespace`, and `title_de` (`title_de` is the name with hyphens turned into a title). The folder is `<name>`, not `<namespace>/<name>`. Exit 7 if the target exists, the name is invalid, or the destination would leave the data directory. Each part matches `^(?:_[a-z0-9][a-z0-9_-]{0,62}|[a-z0-9][a-z0-9_-]{0,63})$`: 1 to 64 characters from `a-z`, `0-9`, `_`, and `-`. It does not start with `-`. A leading `_` needs another character after it.

2. Edit the files. The starter's own notes are in [templates/builtin/_starter/README.md](../templates/builtin/_starter/README.md).

   | File | Rules |
   |---|---|
   | `template.json` | `id` (the folder name), `namespace`, `version` (integer; payloads send the same integer), `title_de`, `description`, `components`, `strings`. Optional `extends`. |
   | `template.html` | A partial. No `html`, `head`, `body`, `script`, `link`, or `style`. No literal UI text. No `on*` handlers. Custom elements only from the component list below. |
   | `template.css` | `var(--rs-*)` and `var(--space-*)` only. Spacing values are `0`, `1px`, or `var(--space-*)`. No `#hex`, `rgb(`, or `hsl(`. No URLs. |
   | `template.js` | The body of `function (RS, root)`. The RS API below. No literal UI strings. Block comments only. |
   | `schema.json`, `result.schema.json` | The keywords below. |
   | `fixtures/` | `golden.json`, at least two `edge-*.json`, at least two `invalid-*.json`. |
   | `fixtures/expect/` | One object per file. `golden.json` proves the keyboard path. |
   | `README.md` | The section order in [Template READMEs](#template-readmes). |

   Components, and the only custom elements allowed: `rs-card`, `rs-action-row`, `rs-copy`, `rs-badge`, `rs-counter`, `rs-post-frame`, `rs-confirm`.

   `template.js` may use: `RS.data`, `RS.task`, `RS.cta`, `RS.setTaskLive`, `RS.run`, `RS.t`, `RS.time`, `RS.date`, `RS.number`, `RS.count`, `RS.copy`, `RS.copyImage`, `RS.copyPath`, `RS.toast`, `RS.media`, `RS.reveal`, `RS.openUrl`, `RS.fillText`, `RS.appendLinks`, `RS.externalLink`, `RS.setResult`, `RS.onChange`, `RS.draft`, `RS.setStatus`, `RS.setSubmitLabel`, `RS.setAlternatives`, `RS.setAlternative`, `RS.focusAlternative`, `RS.addMenuMeta`, `RS.addMenuItem`, `RS.icon`, `RS.submit`.

   It must not call `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `eval`, `importScripts`, `new Function`, `Function(`, `import()`, `navigator.clipboard`, or `navigator.sendBeacon`. The lint also rejects those names inside a regular expression, and `window`, `globalThis`, or `self` used to reach a string name.

   Schema keywords: `type`, `properties`, `required`, `additionalProperties`, `items`, `minItems`, `maxItems`, `uniqueItems`, `enum`, `const`, `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `oneOf`, `default`, `description`, plus `x-rs-*`.

   - `"x-rs-unique-key": "<property>"` on an array of objects rejects a repeated property. The pointer looks like `/data/options/1/id`.
   - `"x-rs-exclusive": ["image", "video"]` on an object rejects a value that sets more than one of those properties. Every name must be a non-empty string.
   - `"x-rs-url": true` (or `"http"`) requires an openable http(s) URL. `"x-rs-url": "https"` also requires https. Openable means a hostname or an IPv6 literal, a port from 0 to 65535, no credentials, no spaces, backslashes, or control characters, at most 2048 characters. An uppercase scheme and a zero-padded port are accepted. `preview-post` `target.url` uses `"https"` and `maxLength` 2048. `decide-list` `items[].url` also keeps a hostname pattern, so an IPv6 literal is rejected there.
   - `"x-rs-media": true` marks an image path. `"x-rs-media": "video"` marks a video path.

   `RS.task` is `{kind, base, verb, why_from, mark, parties, steps_for}`. `RS.cta(value, opts)` is the label for a decision value. `opts.item` with `opts.actor` and `opts.content` is the per-item path. `RS.setTaskLive({parties, changes, stepsFor, stepsKey, stepsButton, tone})` keeps a mixed report's banner lines true. An explicit `task.steps` stays as written: the call still updates the actor lines, the footer, and the tone.

   `RS.setAlternatives([{label, run}, ...])` sets up to two quiet footer alternatives, in that order, before the primary. `[]` removes them. `RS.setAlternative(label, onClick)` is the one-item form. `RS.focusAlternative(which)` moves focus to the first alternative, or to an index or a label. It returns `false` when there is none. They reset on every report switch. Discard lives in the header menu, behind its confirmation.

   `RS.addMenuItem(label, onClick)` and `RS.addMenuMeta(text)` add a menu entry and a quiet metadata line. Both clear on every report switch. `RS.icon(name)` returns a decorative inline SVG.

   `RS.openUrl(url)` asks the desk to open that address. `RS.fillText(el, text)` replaces an element's contents with the text and turns addresses in it into links. `RS.appendLinks(el, text)` appends only the extracted http(s) links. `RS.externalLink(url, text)` returns one link, or null when `url` cannot be opened.

   `RS.run.result` is the result `data` of a submitted report, otherwise `null`. Show it read-only. The shell locks decisions and text and keeps tabs, disclosures, item rows, copies, and buttons marked `data-rs-view-action` working.

   `RS.draft.get()`, `.set(value)`, and `.clear()` keep a draft for this report.

   To reuse a shipped UI, add `"extends": "<builtin id>"`. Inheritance is one level. `template.html`, `template.css`, and `template.js` come from that built-in. The user template owns its manifest, `schema.json`, `result.schema.json`, `fixtures/`, `README.md`, and template-relative media. The base must be a built-in that does not itself extend. Unknown bases, traversal, and a deeper chain fail in `check`.

   The shell reserves `data-rs-strip`, `data-rs-rail`, and the ids `rs-strip`, `rs-strip-nav`, `rs-strip-count`, `rs-rail`, and `rs-rail-nav`. A template must not use them.

3. Add fixtures. `golden.json` is the realistic payload `data`. Add at least two `edge-*.json` files that are still valid, and at least two `invalid-*.json` files that `schema.json` must reject. `check` requires those counts. A missing `golden.json` fails as well.

4. Add `fixtures/expect/golden.json`. The object may contain only `copies`, `counters`, `flow`, `keyboard`, and `result`.

   - `copies` maps each `data-copy-id` to the exact clipboard string.
   - `counters` maps each `data-counter-id` to `{count, limit, over}`.
   - `flow` is the mouse path (`click`, `fill`, `press`, `type`, `repeat`).
   - `keyboard` is the keys-only path (`press`, `type`, `repeat`).
   - `result` is the exact result `data`.

   `preview-post` may also ship `fixtures/expect/counter-cases.json`: an array of at least 30 cases, each `{name, platform, text, count, over}`.

5. Run check.

   ```text
   python report_shell.py check <name>
   python report_shell.py check <name> --visual
   ```

   Exit 0 passes. Exit 7 fails, and the findings are one line on stderr. There is no JSON on failure. `check` runs the contract, the template lint, and, when `fixtures/expect/` exists, `node tools/e2e.mjs expect <id>`. `--visual` then compares screenshots, and only after the contract passed. Screenshots are light and dark, at 1500 by 1000, stored as `golden/<fixture>.light.png` and `golden/<fixture>.dark.png`. A pixel counts when a channel differs by more than 16. At most 1% of pixels may differ.

   `check` starts those Node tools with `RS_PYTHON` set to the Python that is running `check`, unless `RS_PYTHON` is already set. The tools that start the desk use that value, and so does the screenshot compare in `tools/visual.mjs` (`tools/pngdiff.py`). When a tool looks Python up with `RS_PYTHON` unset, it tries `py -3` on Windows. Elsewhere it tries `python3.14` down through `python3.11`, then `python3`, including the copies under `/opt/homebrew/bin` and `/usr/local/bin`. It keeps the first one that is Python 3.11 or newer.

6. Approve goldens before you record them. Record with `node tools/visual.mjs --update <name>` only after you, or the maintainer, have looked at the screenshots and accepted them. A failing `--visual` is a reason to look, not a reason to overwrite the files.

7. To share a template that lives in the data folder, send the whole `<data dir>/templates/<name>` folder. To add one to the repository, follow [CONTRIBUTING.md](../CONTRIBUTING.md).

New string keys in a data-folder template: ask the maintainer to add the English key and the German value to `core/i18n/de.json`. `check` fails until the key exists. Then list it in `template.json` `strings`.

### Template READMEs

Every built-in README uses the same order: what it is for, what the person sees, the payload `data`, the result `data`, how a person uses the keyboard, and the files. Strings, test hooks, and a golden result that is not the example on the page go under a final For maintainers heading. The first JSON block is payload `data` and validates against `schema.json`. Every later JSON block is result `data` and validates against `result.schema.json`.

## Anti-patterns

- Opening report HTML with `file://`, `Invoke-Item`, `Start-Process`, `start`, `os.startfile`, or `webbrowser.open`. That opens a tab. Only `show` and `open` open the window. A link inside a report is `RS.openUrl`.
- Starting `msedge.exe` or `chrome.exe` yourself, or a second window per update. One window. New reports arrive in it.
- Editing `core/`, `tokens.css`, the components, or `rs.js` from a template, or copying core CSS into a template.
- Colour literals in template CSS. Literal UI text in `template.html` or `template.js`.
- `//` comments in template files. The URL lint fails.
- A preselected choice, more than three choices on one item, or more than 12 items on one `decide-list`.
- Secrets or full message bodies in the payload.
- Building the result path by hand. Use `result_path`. Reading the action log. Parsing the page.
- `--timeout 0` from a bot, a timeout above the runtime's shell-call cap, or a background shell that is expected to wake the bot. Polling the result file in a tight loop.
- A payload path or an image path that exists only on the bot's machine.
- `--data -` from Windows PowerShell 5.1 when the payload is not ASCII. The pipe re-encodes the JSON. Write a file and pass that path. The desk reads the file as UTF-8 and strips one leading BOM.
- Reusing a `run_id`. Leave it out and let the desk generate it.
- `--focus` on every `show`. Using the person's real data folder and the default port in a test. Tests set `RS_DATA_DIR` and another port.

## Envelopes

### Payload

`schema` is `report-shell/payload@1`. The maximum size is 2 MB. Unknown top-level fields are rejected. JSON nesting is limited to 64 levels.

| Field | Rule |
|---|---|
| `schema` | `report-shell/payload@1`. |
| `template` | A registered template id. |
| `version` | Integer, equal to the template's `version`. |
| `run_id` | Optional. Pattern `^[0-9]{8}-[0-9]{6}-[a-z0-9-]{1,20}-[0-9a-f]{4}(?:[0-9a-f]{8})?$`. Generated ids use 12 hex characters. Leave it out. |
| `bot` | `^[a-z0-9-]{1,40}$`, for example `inbox-agent`. |
| `title` | 1 to 80 characters. The window title is the title and the bot's display name. |
| `created` | ISO 8601 with an offset. More than 2 minutes ahead is clamped to now, and `show` warns. |
| `expires_minutes` | Optional integer 5 to 10080. Default 240. |
| `notify` | Optional `{"webhook_url"}`. Accepted and ignored. `show` warns: `/notify: ignored; the desk rings the doorbell, set up once per device (report_shell.py doorbell setup)`. Leave it out. |
| `data` | Validated against the template's `schema.json`, then against the template's extra rules. |
| `identity` | Optional. See [Bot identity](#bot-identity). Never rejects the report. |
| `dedupe_key` | Optional. 1 to 120 printable ASCII characters, not starting with a space. The same bot and key returns the existing report. It does not change that report. |
| `dedupe_hours` | Optional integer 1 to 168. Default 24. Only together with `dedupe_key`. |
| `task` | Optional. See [Task banner](#task-banner). |

The same bot and `dedupe_key` returns the open report, or the submitted or cancelled report from the last `dedupe_hours`. An expired report never matches. `show` then adds `deduped` and `state`.

### Result

`schema` is `report-shell/result@1`. The file is written when the person submits, when the report is discarded, or when it expires. Open reports are not in this file and are not listed by `results`.

| Field | Rule |
|---|---|
| `schema` | `report-shell/result@1`. |
| `run_id` | The report id. |
| `template` | Template id. |
| `template_version` | The payload `version`. |
| `bot` | The payload `bot`. |
| `status` | `submitted`, `cancelled`, or `expired`. |
| `created` | Local ISO 8601 with an offset. |
| `decided` | Local ISO 8601 with an offset, to the second. |
| `duration_s` | Whole seconds from `created` to `decided`, at least 0. |
| `log` | Path of the action log. |
| `data` | Present only when `status` is `submitted`. Validated against `result.schema.json`. |
| `identity` | Present when the page could not use the accent, or when identity warnings were recorded. `name`, `accent_fallback` (themes that fell back), and `warnings`. |

`python report_shell.py result` adds `data_dir` to this object on stdout. The file does not contain `data_dir`.

## Task banner

The banner sits under the title. It has one task line, one steps line, at most three sentences of why, and the effort and the due date as quiet meta. English examples: "Approve and {bot} posts", "~{n} min", "due today {time}", "overdue since {when}", "More on why". A decided report keeps the banner, quiet. English: "Read: nothing more to do", "Discarded: the bot does nothing".

`task` fields:

| Field | Rule |
|---|---|
| `kind` | Required when `task` is set. `post_yourself`, `approve_bot_acts`, `pick`, `fyi`, `review`, or `blocking`. |
| `steps` | Optional. 1 to 140 characters, no control characters. When set, this is the steps line for the whole open report. Live updates do not replace it. |
| `eta_min` | Optional integer 1 to 120. |
| `due` | Optional `YYYY-MM-DD`, or an extended timestamp `YYYY-MM-DDTHH:MM[:SS[.fff]]Z` or with a `±HH:MM` offset. Seconds are optional. Fractional seconds need seconds. `Z` or `±HH:MM` is required on a timestamp. Other shapes are rejected, so a deadline cannot vanish in the browser. |
| `why` | Optional non-empty text. Aim for 3 sentences and 360 characters. Past either limit, `show` warns and still accepts the report. The banner shows the first three sentences. A shown part longer than 360 characters is cut. The cut prefers a space or a newline. When the shown part has neither, it is cut at 360 characters, inside the word. An ellipsis is then added, so that visible line can be 361 characters. The rest is folded behind "More on why". That disclosure is the only control the banner may hold. |

Line breaks in the why are kept. A line break ends a sentence. Abbreviations (`z. B.`, `ca.`, `Nr.`), ordinals, and dates (`15.`, `31.12.`) do not. `...`, `…`, and a year from 1900 through 2099 still do. Any other number, and a version (`2.4.`), stays in the same sentence. Without `why`, the banner uses the template's lead when that lead fits whole: `approve-one` `summary`, `review-doc` `summary`, `decide-list` `intro`, `pick-option` `context`, `preview-post` `notes`. A lead that contains a URL stays in the template. The template leaves out a lead that moved into the banner (`RS.task.why_from`).

Steps also show, without `task.steps`, for a list of the bot's items, an all-user list, a list of replies, a mixed list, or a mixed preview. The line names the footer's current label. An all-user list says to do or skip each item. Replies say to post or skip each reply. A bot list or a mixed list says to decide each item. A mixed preview says to review the platforms, and names no platform. A single bot item has no steps line unless `task.steps` is set.

Without `task`, the kind is derived:

| Template | Derived kind |
|---|---|
| `preview-post` | Every platform `manual`: `post_yourself`. Any `auto`: `approve_bot_acts`. |
| `decide-list` | Every item `actor` `user`: `post_yourself`. Otherwise `approve_bot_acts`. |
| `pick-option` | `pick`. |
| `review-doc` | `review`. With `action`: `approve_bot_acts`. `actor` `user`: `post_yourself`. `actor` `none`: `fyi`. |
| `approve-one` | `approve_bot_acts`. `actor` `user`: `post_yourself`. `actor` `none`: `fyi`. |
| Any other template | `review`. |

A derived `post_yourself` is the kind. It does not by itself choose the Posted label. See the button rules below.

A given kind sets the matching actor when `data` leaves it out. It is rejected, with a pointer, when `data` already says otherwise (`/data/actor`, `/data/platforms/N/mode`). Each built-in accepts only the kinds it can show. `pick-option` accepts `pick` and `blocking`. `blocking` keeps the derived kind's buttons and emphasises its primary. A template without an actor model (`_starter`, or a user template that does not extend a built-in) may set `review` or `blocking` only. Any other kind is rejected at `/task/kind`. With no `task`, those templates still show the generic review banner and keep their own buttons.

Buttons, in English. German is what the person sees unless `RS_LANG=en`.

| Kind | Who acts next | Primary | Other buttons |
|---|---|---|---|
| `post_yourself` | The person, then reports back | Posted ✓, Sent ✓, or Done ✓. The mark rules below choose which. | Skip. On a list item, also Later. |
| `approve_bot_acts` | The bot, after approval | Approve & post, Approve & send, or Approve & continue, or the payload's `approve_label` | Request changes, or Reject. |
| `pick` | The bot, with the chosen option | Choose {name} once picked | An optional note. None of these asks for new options. |
| `fyi` | Nobody | Got it, enabled at once | No other decision. One collapsed note, closed by default. |
| `review` | The bot, with the verdict | Looks good | Request changes. |
| `blocking` | As the derived kind | The derived primary, emphasised | As the derived kind. |

On `approve-one`, `approve_label` leads that banner (`{label}, then {bot} posts`, `sends`, or `continues`) and is the bot primary. A name that is the raw bot id, or longer than 24 characters, reads as "the bot" in the banner and on the default primary. The header still shows the name.

A bot list's banner says make your decisions, then the bot continues. `action` `post` says posts. `action` `send` says sends. One item says decision.

The mark names what the person did, and an explicit kind wins over a derived one:

- An explicit `task.kind` of `post_yourself` reads Posted ✓. That includes `approve-one` and `review-doc` when `action` is `send`.
- When the kind is only derived, a user actor on `approve-one` or `review-doc` reads Sent ✓ when `action` is `send`, and Done ✓ otherwise.
- On `decide-list`, an item with `content` `post` or `reply` reads Posted ✓. Other user items read Done ✓, unless `task.kind` was set explicitly to `post_yourself`, in which case they read Posted ✓ too.

Result values stay `done`, `skipped`, and, on a list, `later`. `approve-one` also offers Request changes when `allow_changes` is set, including for a user actor. It does not offer that when `actor` is `none`.

A decide-list footer reads Done when every item is `actor` `user`. Otherwise it reads Send decisions, or Send decision for one item. It sends every choice at once. A mixed report gives each actor one banner line, the person first. English: "You post: {names}", "{bot} posts after approval: {names}". Platform names stop at three, then `{names} +{n}`. List items are counted as replies, posts, or items. A side with nothing left says so, for example "{bot} posts nothing". A platform that cannot be approved is left out of the plan from the start.

A mixed preview's steps name no platform: "Review the platforms, then {button}". The footer reads Send response while both actors still have work, Approve & post when only auto platforms are ticked, and Posted ✓ when only manual ones are. The status splits the count, for example "{n} approved" and "{n} posted".

Colours: one tint per kind, with a 4 pixel edge. Amber for `post_yourself`, green for `approve_bot_acts`, violet for `pick`, grey for `fyi`, teal for `review`. Red when the kind is `blocking`, or when `due` is today or past. The tint is a status colour. It is not the bot's accent. The banner holds no buttons, and at most the details toggle of a long why. Contrast pairs live in `contrast-pairs.json`.

## Bot identity

Each bot can show a name, an avatar, and an accent. The header shows the avatar and the name of the report on screen. With two or more open reports the strip shows one avatar per bot, with a count when that bot has more than one. The accent replaces the default accent for the report on screen. The strip does not paint another report's accent.

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
|---|---|
| `name` | Plain text, trimmed, 1 to 40 characters, no control characters and no bidi controls. Always rendered as text. On a payload, set it to the bot's exact name in Grok Bot. The doorbell's `bot_name` is that payload `identity.name` when the report gives one, otherwise the bot id. A name in the bot registry does not count. |
| `avatar` | PNG, JPEG, WebP, or GIF. No SVG. At most 256 KB. Shown at 32 pixels, and at 24 pixels in the overflow menu. A `data:image/<type>;base64,...` URL, or a path relative to the template folder (payload; `%RS_TEMPLATE%/...` works) or to the registry's folder. No `..`, no UNC. Absolute paths only inside the data directory. The bytes must match the type. |
| `avatar_shape` | `blob`, `squircle`, `pebble`, `hex`, `teardrop`, or `tablet`. |
| `avatar_color` | `blue`, `orange`, `yellow`, `magenta`, `red`, `violet`, `black`, `green`, or `gray`. The page draws the shape from `core/static/avatar-shapes.json`. `black` is drawn white in dark mode. |
| `accent` | `#RRGGBB`. Checked per theme against `contrast-pairs.json`: accent and its hover fill versus the page and the card, the label versus the accent, and the focus ring. A theme that fails uses the default accent and is listed in `accent_fallback`. For example, `#0891b2` falls back in the light theme because its hover fill is too close to white. Without `accent`, `avatar_color` seeds the accent through the same checks. A seeded theme that fails is listed in `accent_fallback` and does not add a warning. |

`doctor` lists registry problems in `identity_warnings`. The same warnings can appear on the result under `identity.warnings`, and as `warning` events in the action log.

## Data folder and template resolution

`RS_DATA_DIR`, when set, is the data folder, and it is never migrated. Otherwise:

| System | Folder |
|---|---|
| Windows | `%LOCALAPPDATA%\grokbot-desk` |
| macOS | `~/Library/Application Support/grokbot-desk` |

On Windows the older folder `%LOCALAPPDATA%\spqrk-report-shell` stays in use while it still has a `runs` directory, the new folder does not yet hold a run or a result file, and either the new folder does not exist or the old folder holds a run or a result file. An empty new folder does not hide reports that are still in the old folder. After `migrate`, the old folder is not created again for normal use. A desk started with `RS_DATA_DIR` pointed at the old folder after the move refuses to start.

The folder holds `runs/`, `results/`, `log/`, `media/`, `config.json`, `doorbell.json` when the doorbell is on, and `templates/` for templates you add with `new`. `doorbell.json` holds the webhook URL and the key. The desk never prints the key.

Template ids resolve in this order everywhere. The first match wins.

1. User templates: `<data dir>/templates/<id>/`.
2. Shipped built-ins: `templates/builtin/<id>/`.
3. Legacy namespace templates: `templates/<namespace>/<id>/`.

A user template may shadow a built-in id. `check` and `doctor` report that as a warning. New templates go in the user directory, not in the install tree.

Every file read from a template is checked by canonical path. A symlink or junction that leaves the template root fails closed, including the manifest, schemas, fixtures, HTML, CSS, JS, and `%RS_TEMPLATE%` media. The registry records the directory's identity when it scans. Serving a template file checks that identity again. The only files read from another root are `template.html`, `template.css`, and `template.js` inherited from a built-in.

## Configuration

`<data dir>/config.json` is optional. Missing keys use the defaults. `window` is merged onto the defaults, so a partial object keeps the other default fields. Other top-level keys are kept in memory and are not read. An old `webhook` object is ignored.

A command that reads the config for its settings (`show`, `wait`, `result`, `results`, `paths`, `status`, `open`, `cancel`, `doorbell`, `stop`, `serve`) exits 2 when `config.json` cannot be read or is not an object. The stderr line is `report-shell: invalid config: ...`. A `port` that cannot be read as an integer, or a port outside 1 to 65535, exits 2 when that config port is the one selected. `--port` on the command uses the flag instead, so a bad config port is not read. A file that cannot be parsed still exits 2 with `--port`. `list`, `templates`, `doctor`, `check`, `new`, and `update` do not read `config.json`. `migrate` does not load it for a port or a window. On Windows, before the move, it reads the file and rewrites `media_roots` when those paths sit under the old folder. A file it cannot parse is left as it is.

| Field | Default | Meaning |
|---|---|---|
| `port` | `18742` | Desk port, 1 to 65535. `--port` overrides it for one command. |
| `window` | `{"x": 0, "y": 0, "width": 880, "height": 920}` | Window position and size. A non-positive width or height falls back to the default size. |
| `media_roots` | The person's Downloads folder, and `<data dir>/media` | Absolute directories an ordinary media path must resolve under. A `%RS_TEMPLATE%` path is not checked against this list. |

Environment variables the desk reads:

| Variable | Effect |
|---|---|
| `RS_DATA_DIR` | Data folder. Never migrated. |
| `RS_LANG` | `en` selects English. Anything else, including unset, is German. |
| `RS_TZ` | An IANA time zone for display and screenshots. Used when time-zone data is available. Without that data, a Central European name in the desk's built-in set (for example `Europe/Vienna`) uses the EU daylight-saving rule, and `UTC`, `Etc/UTC`, `Etc/GMT`, and `GMT` stay UTC. Any other name falls back to the machine's zone, and the page is told there is no pin. |
| `RS_PYTHON` | Python for the Node tools that `check` starts, including the screenshot compare. `check` sets it to its own interpreter when it is unset. |
| `RS_SERVER_START_TIMEOUT_MS` | How long the CLI waits for a new desk. Default 10 seconds. Bounded to 1 through 120 seconds. |
| `RS_CLI_HTTP_TIMEOUT` | Timeout for CLI requests to the desk, other than the short hello. Default 3 seconds. Capped at 60. |
| `RS_PLAYWRIGHT_CORE` | Where `check --visual` and the screenshot tools find Playwright. Set it when the package is not installed next to the tools. |
| `REPORT_SHELL_PYTHON` | Replaces the `./report-shell` search. The only executable tried. A bad value exits 1 even when a suitable interpreter is installed. |

The CLI waits up to 10 seconds for a new desk to answer. If this checkout's process is listening but not answering yet, it gets one more period of the same length. A port that opens as that wait ends is given 2 seconds to write `state.json` before it counts as another program.

## Doorbell

Grok Bot does not wake a bot when a background command finishes. The doorbell is one Desk Doorbell bot on this computer. Install it from the [Desk Doorbell template](https://x.ai/bot/Q_-PLlmHrV1l2h3Tk1ejJ). The texts and the install steps are in [doorbell/README.md](../doorbell/README.md).

The doorbell is off until a URL and a key are saved. The file is `<data dir>/doorbell.json`. The key is never put in a payload, never written in chat, and never printed.

The desk rings when a report is submitted, cancelled by the person (discarded on the page), or expired. A bot's own `cancel` never rings, even when the person asked the bot to cancel. The desk POSTs JSON to that webhook with `Authorization: Bearer` and the key. The body is `bot`, `bot_name`, `run_id`, `status`, and `title`. `status` is `submitted`, `cancelled`, or `expired`. `bot_name` is the payload `identity.name` when that report gives one, otherwise the bot id. A name in the bot registry does not count. The Desk Doorbell bot then messages the bot named `bot_name`:

```text
Desk: <title> is <status>. Read the result with report_shell.py result <run_id>.
```

That bot reads the result and answers.

The desk retries for about 4 minutes on rate limits, server errors, and a failed connection. It does not follow a redirect, so the key is not sent to another address. A ring can be lost when the desk stops, or when Grok Bot stays busy for minutes. Nothing wakes the bot then. At the start of every turn, doorbell on or off, the bot catches up with `results --since`. If a decision got no reaction, message the bot.

`status` and `doctor` print `doorbell` as `on` or `off`. The commands are under [doorbell](#doorbell-command).

## Commands

JSON on stdout is one compact line. Non-ASCII characters are `\u` escapes, so JSON is ASCII on every stream. Text, such as the `templates` table and error lines, follows the stream encoding. A UTF-8 stream (macOS, a Windows console, or a Windows pipe whose encoding is UTF-8) prints text as UTF-8. A stream that is not UTF-8, including a default Windows pipe, stays ASCII, and characters that do not fit are backslash escapes.

Errors returned by a command are one line on stderr: `report-shell: <message>`. A usage error from the argument parser prints a usage block and a line beginning `grokbot-desk:` or `grokbot-desk <command>:`, and exits 2. A crash leaves a Python traceback and exits 1.

On the next `show` or `open`, an idle desk whose `version` is not this checkout's version is stopped and started again. That includes a missing version and a newer one. An equal version string is left as it is. A desk with open reports keeps running until those reports are decided. `status` field `version` is the version of the desk that answered, or `null` when the desk is down.

The desk stops itself after 30 minutes with no open report and no page connected.

```text
show decide-list --data payload.json
doorbell
wait RUN_ID --timeout 60
result RUN_ID
```

`--port N` (1 to 65535) works before or after the command. The default is `config.json` `port`, else 18742. `--version` prints `grokbot-desk` and the version.

### show

Open a report from a payload.

```text
python report_shell.py show <template> --data <path|-> [--focus] [--no-window]
```

| Flag | Meaning |
|---|---|
| `template` | Template id, for example `decide-list`. |
| `--data` | Payload JSON file, or `-` for stdin. Required. |
| `--focus` | Bring the window to the front on Windows, at most once per burst. |
| `--no-window` | Register the report and do not open a window. |

The file or stdin may be a full payload, or only the `data` object. A bare object is wrapped: `schema` is `report-shell/payload@1`, `template` is the id you named, `version` is the template's version, `bot` is the template's namespace (or `operations-agent` when the namespace is `global`), `title` is the template's `title_de`, and `created` is now. A value that already has `schema` is treated as a payload. The payload's `template` must equal the id on the command line. The maximum size is 2 MB. Nesting deeper than 64 fails. One leading UTF-8 BOM is stripped.

Stdout:

| Field | When |
|---|---|
| `run_id` | Always. |
| `url` | Always. |
| `result_path` | Always. |
| `data_dir` | Always. |
| `deduped` | A duplicate `dedupe_key` was returned. The existing report is unchanged. |
| `state` | With `deduped`: `open`, `submitted`, or `cancelled`. |
| `warnings` | A clamped `created`, a `task.why` past the fold limit, or an ignored `notify`. |
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
|---|---|
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
|---|---|
| `--since` | Required. ISO 8601 with an offset, or the `cursor` from last time. The comparison is inclusive on `decided`. Fractional seconds are ignored, so a cursor with milliseconds still includes a result decided earlier in that same second. |
| `--bot` | Only this bot id. |
| `--wait` | Seconds to wait for a first new result. Default 0. Capped at 3600. The command polls every 0.5 seconds. |
| `--seen` | A `run_id` already handled. Repeat the flag. |

Stdout is `{"data_dir", "results", "cursor", "seen"}`. Each item has `run_id`, `bot`, `template`, `status`, `decided`, `result_path`, `title` when a title is still known, and `summary` when the decision is compact.

`summary` is decide-list counts (`2 approve, 1 defer`), a preview-post reading, the approve-one or review-doc decision word, or the pick-option id. A preview-post summary is present only when it is consistent. Manual is `posted by you` or `skipped`. Auto and approved is `approved`. The summary is not permission to post. Read `per_platform` and post only `auto` plus `approved`. A preview-post result whose mode and decision disagree is rejected when the person submits it.

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

Discard an open report. The result is `cancelled`. Cancel only when the person asks, or to replace your own open report with a newer version of the same thing. See [What a result means](#what-a-result-means).

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
|---|---|
| (none) | Print `{"doorbell": "on" or "off", "host"}`. `host` is the webhook host, or null when the doorbell is off. `on` means the address and key are saved. It does not prove a test reached Grok Bot. |
| `setup` | Open the setup page in the desk window (`http://127.0.0.1:<port>/?page=doorbell`). The person pastes "POST to" and "key" from Grok Bot, Desk Doorbell, Routines, the webhook routine. Save writes `doorbell.json` and sends a test ring. When the save worked and the test failed, the page says `Saved. The test did not reach Grok Bot: …`. |
| `setup --url URL --key-stdin` | Headless. `URL` is the webhook address, https only, with a host and no user or password. The key is one line on stdin. This writes the file and does not ring. |
| `test` | One ring now, no retries. The body is `{"status": "test"}`. `--to NAME` is the exact Grok Bot name. The body is then `{"status": "test", "bot_name": NAME}`. A plain test writes `Desk: doorbell test received.` in the doorbell's own chat. An addressed test sends `Desk: doorbell test.` to that bot. |
| `off` | Delete `doorbell.json`. |

`doorbell` and `doorbell off` print `doorbell` and `host`. A window `setup` prints `ok`, `opened`, `pending`, `url`, `doorbell`, and `host`. `opened` and `pending` mean the same as on `open`. A headless `setup` prints `doorbell` and `host`. `test` prints `ok`, `http_status`, and `host`. A failed ring also prints `category` and `error`. `category` is `unreachable`, `refused` (check the address and the key), `busy` (a rate limit or a server error; try again in a minute), or `other`.

Exit 0 when the command worked. `test` exits 0 when the ring was accepted, 4 when the ring failed, and 2 when the doorbell is off (`the doorbell is off; set it up with: doorbell setup`). A bad URL, a bad key, `--url` without `--key-stdin`, `--key-stdin` without `--url`, or a stdin that is not one key line exits 2. A browser that cannot start on `setup` exits 3. A desk that cannot start on `setup` exits 4. A file that cannot be written exits 7.

### list

List templates as JSON.

```text
python report_shell.py list
```

Stdout: `[{"id", "namespace", "version"}, ...]`. Exit 0, or 7 when the registry is broken.

### templates

List installed templates as a table.

```text
python report_shell.py templates [--json] [--paths]
```

The table header is `ID`, `SOURCE`, `EXTENDS`, `TITLE`, separated by tabs. `EXTENDS` is `-` when the template does not extend. `--json` prints `[{"id", "source", "extends", "title"}, ...]`. `--paths` is a hidden flag: it forces JSON and adds `path`. Exit 0, or 7 when the registry is broken.

### doctor

Check installed templates, bot identities, and the data folder.

```text
python report_shell.py doctor
```

Stdout: `ok` (true), `templates` (the count), `warnings` (registry warnings, including a user template that shadows a built-in), `identity_warnings` (a list of strings), `doorbell` (`on` or `off`). `data_dir_warning` is added while the older Windows folder is in use. Warnings do not fail the command. Exit 0, or 7 when the registry is broken.

### check

Check a template and its fixtures. This is a development command.

```text
python report_shell.py check <template>
python report_shell.py check --all [--visual]
```

`<template>` and `--all` exclude each other. One of them is required. `--visual` also compares golden screenshots.

On success, stdout is `ok`, `visual`, `warnings`, and either `template` (the id you named) or `templates` (the ids `--all` checked). On failure, exit 7, the findings are joined on stderr, and there is no JSON. An unknown id fails the same way. See [Build a template](#build-a-template) for what is checked and how Python is chosen.

### new

Create a template from the starter in the data folder.

```text
python report_shell.py new <namespace>/<name>
```

Stdout: `{"ok": true, "id", "path"}`. `id` is `<name>`. Exit 0, or 7 when the name is invalid, the target exists, or the destination would leave the data directory. See [Build a template](#build-a-template).

### serve

Run the desk in this terminal. Use the `serve` command when a runtime ends child processes. It stays in the foreground until the desk stops. A clean idle stop exits 0. Exit 4 when the port cannot be bound or the data folder is busy. Exit 7 when the registry is broken.

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
|---|---|---|
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
|---|---|---|
| 0 | Success. | Continue. |
| 1 | Python is older than 3.11, or the process crashed. A crash leaves a Python traceback on stderr. | On macOS use `./report-shell`. Otherwise install Python 3.11 or newer ([README](../README.md)). After a crash, tell the person. The result file can still be read. |
| 2 | Invalid payload, arguments, or config. Unknown template. Bad media. `--since` is not ISO 8601 with an offset. `--until-expiry` combined with `--timeout`. Port outside 1 to 65535 when that port is selected. A non-numeric `port` in `config.json` exits 2 only when the command uses that port. `--port` overrides it. A config file that cannot be parsed still exits 2. `doorbell test` while the doorbell is off. A bad doorbell URL or key, or a bad `doorbell setup` flag combination. Unknown command or other usage error. Stderr names a JSON pointer when there is one, for example `/data/message`. | Fix the input. Do not retry it unchanged. |
| 3 | The browser could not be started (`show`, `open`). On Windows that is usually no Edge or Chrome. On macOS a missing Edge or Chrome falls back to the default browser, so their absence alone is not exit 3. Exit 3 there means the launch itself failed. A launch can also fail after a browser was found. | Tell the person in chat. Do not open another browser yourself. |
| 4 | The port is taken, or the desk did not start. Also: `show` got a network or HTTP error other than 400. `open` failed while starting. `doorbell setup` could not start the desk. `doorbell test` ring failed. `stop` could not deliver the request. `serve` could not bind or the data folder is busy. `migrate` refused because a desk is running, another migrate is running, or a report is still open. | Run `status`, try once more, then tell the person. Never pick another port yourself. For `migrate`, stop the desk and decide or discard open reports, then run it again. For a failed test ring, read `category`. `unreachable` means no connection. `refused` means check the address and the key. `busy` means a rate limit or a server error; try again in a minute. `other` means try again later. |
| 5 | `wait` reached `--timeout` while the report was still open. | End the turn. With the doorbell on, a chat line that starts with `Desk: ` is the wake. With it off, a decision after that wait needs a new chat message from the person. Either way, the next turn starts with `results --since`. |
| 6 | Unknown `run_id` (`wait`, `cancel`). `result` is unknown or not written yet. `cancel` of a report that is already decided, or a cancel request that failed. | Check the `run_id`. For `result`, try again later. |
| 7 | `wait` passed expiry plus 2 minutes with no result. `check` found problems. `new` refused the name or the path. The registry is broken (`list`, `templates`, `doctor`, `serve`). `update` refused, the pull failed, git is missing, or a git step did not answer within 120 seconds. `migrate` found files in the new folder, or the move failed. `doorbell setup` could not write `doorbell.json`. | For `wait`, treat the report as expired. Otherwise fix the template, the clone, or the folders. A refused `update` that never started the pull changes nothing. A failed or timed-out pull may already have fetched objects. A refused `migrate` changes nothing. If the folder move itself fails, the error says the old folder stays in use. |
