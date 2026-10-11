# grokbot-desk: best-practice guide (v1)

For bots that show reports to a person in the grokbot-desk window, and for bots that write templates. Sections 1-10 explain the design rules; the reference part (A-D) has the worked example, every command and every exit code.

Windows is supported. macOS is a beta; use Python 3.11 or newer through `./report-shell` or a versioned `python3.12` (macOS's own `/usr/bin/python3` is 3.9 and too old), not `py -3` or `report-shell.cmd`. See the README sections macOS setup and Platforms.

Run commands from the repository root with `python report_shell.py <command>` using Python 3.11 or newer. On Windows, `py -3` is an alternative only when `py -3 --version` succeeds. The Windows wrapper `<repo>\report-shell.cmd <command>` requires that launcher. From another directory, pass the full path to `report_shell.py`. On macOS, use `<repo>/report-shell <command>` (it finds a Python 3.11 or newer) or `python3.12`, and forward-slash paths; the .cmd wrapper is Windows-only.

Quick start: write a payload file, then `show`, then `wait` in a loop, then read the result file. Section A has the full example.

Placeholders used below: `<repo>` = the repository folder, `<host>` = the Windows machine that shows the window, `<user>` = the Windows user on `<host>`, `example-bot` = your bot id, `<data dir>` = `%LOCALAPPDATA%\grokbot-desk` on Windows, or `RS_DATA_DIR` if set. When the new directory is absent, an existing `%LOCALAPPDATA%\spqrk-report-shell` is reused.

Template ids resolve in one order everywhere (CLI, server, checks and score tools):

1. user templates: `<data dir>\templates\<id>\`;
2. shipped built-ins: `<repo>\templates\builtin\<id>\`;
3. legacy namespace templates: `<repo>\templates\<namespace>\<id>\`.

The first match wins. A user template may shadow a built-in id; `check` and `doctor` report that as a warning. Legacy namespace templates remain supported; new templates are stored in the user template directory, never in the install tree.

Template directories and every file read from them are checked by canonical path. A symlink or junction that leaves its template root fails closed, including manifests, schemas, fixtures, HTML/CSS/JS and `%RS_TEMPLATE%` media. The registry records the template directory's identity when it is scanned. `%RS_TEMPLATE%` media is opened from that directory without following links, and serving it checks the same identity again, so replacing the folder after the scan cannot authorize a file outside it. The only cross-root reads are the explicitly inherited HTML/CSS/JS files from a trusted built-in.

---

## 1. Window or chat?

Use the window when the person has to:

- decide on 2 or more items,
- copy text (IBAN, amount, reply draft, post text, hashtags),
- see a visual preview (a social post), or
- read more than about 5 chat lines.

Stay in chat for a one-line acknowledgement or a single yes/no question.

After `show`, the chat message is **one pointer line**, for example `Im Fenster: Mail-Vorsortierung 08.10. (3 Punkte zu entscheiden)`. Do not repeat the report in chat.

What the person sees:

- One window (Edge or Chrome in `--app` mode, own profile, no tabs, no address bar): a compact pop-up for one decision, 880x920 at 0,0 of the primary monitor by default (an 864x836 page: every built-in golden but the long `review-doc` fits without scrolling; `config.json` `window` overrides it).
- If the window is already open, a new report arrives quietly: the title gets the prefix `● ` and the taskbar button flashes, at most once per burst of reports (pushes less than 30 seconds apart are one burst; a window opened for the first report of a burst counts as its one bring-forward). The window does not jump to the front. `show --focus` brings it to the front, also at most once per burst; use it only when the person asked for the report right now.
- With exactly one open report there is no list at all: the header shows the bot's avatar, its name in bold and the report title as one quiet line below. With 2 or more open reports a slim avatar strip sits above the header with one avatar per bot (see "Several bots" below), the active one underlined, and `n von m offen` / `n of m open` at the end (counting reports, up to 12). `Ctrl+1..9` switches from anywhere; on the strip `Left`/`Right`/`Home`/`End` move along it (one Tab stop). A new report never replaces the report on screen; it waits in the strip with a filled dot and the window title gets `● `.

### Several bots

When several bots post at once (a burst), the window stays one calm window:

- Exactly one window. Concurrent `show` calls with no window open launch one window; the others return at once. A window still starting up (a first browser start can take several seconds) is waited for, not launched again.
- The report on screen stays, touched or not. A new report becomes the active one only when nothing open is shown (no report, or the shown one was decided or is gone); then the oldest arrival comes first.
- One announcement per burst, polite for screen readers: `3 neue Berichte von 2 Bots` / `3 new reports from 2 bots` (one bot: `2 new reports from Inbox Agent`; a single waiting report: `New report: <title>`). A single report that is shown at once needs none.
- The strip groups open reports by bot: one avatar per bot, with a small count when that bot has more than one (named `Inbox Agent, 3 Berichte` / `Inbox Agent, 3 reports` for screen readers). Bots keep the order in which they arrived and each bot's reports their arrival order (not the bot's `created` stamp), so nothing jumps during a burst. A bot's avatar goes to its oldest open report; activating the current bot's avatar again steps to that bot's next report. After a decision the window moves on to the same bot's next report first.
- After the person sends or discards a report, the window moves on to the next open one. After the last one it shows a calm done state (`Alles erledigt. Das Fenster schließt sich gleich.` with `Offen lassen`) and closes itself after about 4 seconds; open reports never close it, and a new report arriving in that moment cancels the close.
- If the person closes the window, open reports stay open. The next `show`, or `report_shell.py open`, opens the window again.

## 2. Action design

- Every item ends in an explicit choice. The person picks; nothing is decided by default.
- Choice labels are German verbs of at most 2 words (`Erledigt`, `Später`, `Ignorieren`, `Ja`, `Nein`, `Freigeben`, `Änderungen anfordern`).
- At most 3 choices per item. Use `rs-action-row` (radio-group semantics, arrow keys).
- No pre-selected choice. "Do nothing" is the default: a report that is discarded (`Verwerfen`) or expires gives the bot a `cancelled` or `expired` result, and the bot then does nothing.
- Keep `An Bot senden` disabled until the input is complete: the template calls `RS.setResult(null)` until every required choice is made, and `RS.setStatus(...)` says what is missing. A long list stays in the accessible name; the visible line can be short (e.g. `4 open` / `4 offen`).
- The window never executes destructive work in v1. It records decisions; the bot executes them after reading the result file.

## 3. Copy-first

- Anything the person would otherwise retype gets an `rs-copy`: IBAN, amount, reference, reply draft, post text, hashtags, paths.
- The copied string is shown **in full** next to its button. Use the `mono` attribute for IBANs, amounts and paths. The `no-value` attribute is only for text that is already visible right beside the button (the post text inside a preview).
- No hidden transformations: the clipboard receives exactly the string in the payload (server-side `CF_UNICODETEXT`, no line-ending conversion). If the template composes a string (e.g. post text plus hashtags), the composed string is what is shown, counted and copied.
- Limits: one copy is at most 100 000 UTF-16 code units (server limit); templates usually cap copy texts lower (`_starter` and `decide-list`: 5000 characters).
- Text only. Copying images is not in v1.
- Every `rs-copy` gets a stable `data-copy-id` (e.g. `warn-1-copy-0`), so the copy tests in `fixtures\expect\` can find it.

## 4. Density

- At most 5 actionable items per screen (the presort cap of 5 ⚠️ items). If there are more, the bot prioritises; it does not scroll the person through 20 decisions.
- Golden fixtures fit above the fold at 1500x1000 with no scrolling (usability item U1).
- When content does run past the fold, the shell fades its last 24 px above the submit bar (in a sent, read-only view: above the window edge) into the paper (only while more follows, gone at the end), so a half-visible line never looks cut; keyboard focus scrolls clear of the fade, including focus already held when an opened disclosure or a resize turns the fade on. Templates add no fade or bottom spacing of their own.
- Noise collapses to a count plus themes (`feed: {count, themes}` in `decide-list`); items kept without action become chips.
- Empty sections are not rendered.

## 5. German strings and Vienna time

German is the default; set `RS_LANG=en` before starting the server to select English. Result timestamps use Europe/Vienna.

- Every visible UI string is German and comes from `core\i18n\de.json` (keys in English, values in German). Templates never contain literal text:
  - static text in `template.html`: `<span data-rs-t="key"></span>`;
  - localised attributes (`placeholder`, `title`, `aria-label`, `alt`): `data-rs-t-<attribute>="key"`, e.g. `data-rs-t-placeholder="note"`;
  - dynamic text in `template.js`: `RS.t("key", {name: value})` (`{name}` placeholders in the value are filled from the params);
  - payload text (names, subjects, snippets): set with `textContent`, never `innerHTML`.
- Every key a template uses is listed in `template.json` `strings` and exists in `de.json`. A new key goes into `de.json` first (see section 9, step 4).
- Times: only `RS.time(iso)`, which shows Europe/Vienna in the format `Do 08.10.2026 · 10:39`.
- Every timestamp in a payload must carry an offset (`+02:00`, `+01:00` or `Z`); the core converts it to Vienna time. Timestamps in result envelopes are always Vienna ISO 8601, e.g. `2026-10-08T10:44:12+02:00`.
- Producing `created`:
  - PowerShell on `<host>`: `(Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')` gives e.g. `2026-10-08T12:41:33+02:00`.
  - Python: `datetime.now(ZoneInfo("Europe/Vienna")).isoformat(timespec="seconds")`.

## 6. No external requests

- No CDN, web fonts, remote images, link unfurling or any network call from the page. The Content-Security-Policy blocks it, and the template lint rejects `http:`, `https:` and `//` anywhere in `template.html`, `template.css` and `template.js`. That includes `//` line comments: write `/* ... */` comments only.
- System fonts only (the core sets them).
- A link in a post preview is rendered from the payload (`url`, `title`, `domain`); nothing is fetched.
- http(s) addresses in item text, review-doc Markdown, pick-option text and a payload `url` field are real links. The page does not let those links navigate this window: the anchors are not draggable, a drag is cancelled, and dropping a URL on the page is cancelled. A primary click, a middle click, Enter, and a modified click (Shift, Ctrl, Alt) call `RS.openUrl(url)`, which posts `{run_id, url}` to `/open-url`. Modified Enter does the same, except Ctrl+Enter or Cmd+Enter, which stays the submit shortcut and does not navigate. The server opens the host's default browser only when that exact address occurs in the run's payload, is http or https, is at most 2048 characters, has a hostname and a valid port, and has no credentials in the authority. `rel="noopener noreferrer"` and the server allowlist do not by themselves stop the window from navigating; the page handlers do. A right-click on these links is cancelled so the menu cannot open the address in the app profile. A browser that still offers Open from a menu the page cannot see is outside this guarantee.
- Images go through the media roots:
  - The payload holds an absolute Windows path on `<host>` in a field the template's `schema.json` marks with `"x-rs-media": true`.
  - At `show` the path must resolve (after realpath) under one of the media roots in `config.json` `media_roots` (in `<data dir>`). Defaults are the user's Downloads folder and `<data dir>/media`; add any shared-drive folder explicitly to `config.json` `media_roots`.
  - Allowed: `.png .jpg .jpeg .webp .gif`, at most 20 MB, the file must exist. Relative paths, `..`, UNC paths and paths outside the roots are rejected with exit code 2.
  - The page never sees the path, only a random media id: `RS.media(id)` for `img.src`, `RS.reveal(id)` for `Im Ordner zeigen`, `RS.copyImage(id)` (or `<rs-copy media="<id>">`) to put the image on the clipboard as a picture (macOS: PNG, JPEG, GIF, WebP; Windows: PNG, JPEG, GIF).
  - A bot on another machine copies the image to `<host>` first (section A, step 1: drop folder) and puts the `<host>` path into the payload. Never a path that exists only on the bot's machine.

## 7. Accessibility

Checklist (spec 5.2). The core already gives `lang="de"`, visible focus, token contrast and the keyboard map; templates must not break them.

- [ ] Every control has an accessible name: a `<label for>` filled by `data-rs-t`, or `data-rs-t-aria-label`; `rs-action-row` gets a `label` (e.g. `RS.t('choice_group_label', {what: ...})` = `Entscheidung: ...`).
- [ ] Every image has alt text (payload `alt`, or `data-rs-t-alt`).
- [ ] Focus stays visible: do not override `outline` (the core draws at least 2 px with contrast at least 3:1).
- [ ] Colours only from `--rs-*` tokens (the token pairs for text meet WCAG AA, at least 4.5:1, in light and dark). No colour literals.
- [ ] No positive `tabindex`.
- [ ] Choices use `rs-action-row` (`role=radiogroup`, arrow keys), not home-made radio buttons.
- [ ] The whole flow works with the keyboard only: `Tab`/`Shift+Tab`, `Enter`/`Space`, arrow keys in a choice row, `Ctrl+Enter` sends, `Esc` closes a dialog, `Ctrl+1..9` switches reports. `fixtures\expect\golden.json` `keyboard` proves it.
- [ ] Status changes are announced through the core toast (`RS.toast`, `aria-live`), not by custom alerts.
- [ ] Animations respect `prefers-reduced-motion`.

## 8. Results

- Design `result.schema.json` **first**, then the UI. Keep it small: echo the payload's item ids, use enums for choices, give free-text fields a `maxLength`. Example (`decide-list`): `{"items":[{"id","choice","note"}], "note"}`.
- Labels say who acts next. `actor` is `bot` (default), `user` or, on approve-one and review-doc, `none`. Bot results stay `approve`, `reject`, `request_changes`, `defer`. User results are `done`, `skipped` and, on a list, `later`. Info-only is `acknowledged`. A missing `actor` keeps today's values. The bot never acts on `user` or `none`.
- Bots read **only** the result file `<data dir>\results\<run_id>.json` on `<host>` (take the exact path from `result_path` in the `show` or `wait` output). Never scrape the page, the run store or the action log.
- A result file is written once, atomically, and never changes. Its `data` was validated against `result.schema.json` before it was written.
- Waiting: start with `wait --timeout 60` (below the runtime's shell-call cap). On exit 5, if your runtime wakes you when a background subagent or task finishes, hand the wait to one that runs `wait <run_id> --until-expiry` and blocks on it; background shells may not wake you. Otherwise catch up on the next turn with `results --since`. `wait` ends at the run's expiry plus 2 minutes at the latest (exit 7: no result by then; a pre-beta.2 or unreadable run record has no expiry, so only `--timeout` ends it). Never use `--timeout 0` from a bot.
- After a result: acknowledge in your own chat with topic + OK (e.g. "X replies: 5x posted, OK"); act right away if the result asks for action.
- Act on `status`:

| `status` | Meaning | Bot does |
|---|---|---|
| `submitted` | the person sent it (`An Bot senden` or Ctrl+Enter) | executes `data` |
| `cancelled` | the person discarded it (`Verwerfen`), or the bot ran `cancel` | nothing; at most one chat line if the topic is still open |
| `expired` | `expires_minutes` ran out (default 240, max 10080) | nothing; re-show later only if it still matters |

- Payload hygiene: never put secrets (passwords, tokens, full card numbers) or full email bodies into a payload. Use snippets of at most 600 characters. Payloads, results and logs stay 30 days in `<data dir>\`, then the core deletes them.
- One open report per topic: when a newer report replaces an open one, `cancel` the old run first.

## 9. Adding a template

Pick a built-in before writing one:

| Need | Built-in |
|---|---|
| approve, reject or defer several items, or mark items the person posts (`actor: user`) | `decide-list` |
| one yes/no decision, optionally request changes; `actor` can be `user` or `none` | `approve-one` |
| preview and approve a social post (per platform `auto`: the bot posts it, or `manual`: the user posts it, result `done` / `skipped`) | `preview-post` |
| review a short, scannable document (TL;DR, a table, bold verdicts, check states, copy buttons) | `review-doc` |
| compare 2–4 options and pick one, with optional copy text per option | `pick-option` |

Run `py -3 report_shell.py templates` (or `templates --json`) to see what is installed. Use `new` only when no built-in fits.

1. For a local user template, no repository branch is needed: `new` writes into your data directory.
2. Copy the starter (from the repository root):

   ```
   py -3 report_shell.py new <namespace>/<name>
   ```

   `<namespace>` is your bot id (e.g. `example-bot`). This copies the shipped `templates\builtin\_starter` into `<data dir>\templates\<name>\` and sets `id`, `namespace` and `title_de` in `template.json`. The writable template survives installation updates. Exit 7 if the user target exists, the name is invalid, or a symlink/junction would place the templates root or destination outside the canonical data directory.
3. Edit, following `templates\builtin\_starter\README.md`:

| File | Rules |
|---|---|
| `template.json` | exactly the fields `id` (= folder name), `namespace` (= the namespace argument passed to `new`, stored as metadata; the folder remains `<data dir>/templates/<name>`), `version` (integer, payloads must send the same), `title_de`, `description`, `components` (only `rs-card`, `rs-action-row`, `rs-copy`, `rs-badge`, `rs-counter`, `rs-post-frame`, `rs-confirm`), `strings` (every `de.json` key used) |
| `template.html` | a partial: no `<html>`, `<head>`, `<body>`, `<script>`, `<link>`, `<style>`; no literal text; no `on*=` handlers; custom elements only from the list above |
| `template.css` | `var(--rs-*)` tokens only, spacing only `var(--space-*)`, `0` or `1px`; no `#hex`, `rgb(`, `hsl(`; no URLs |
| `template.js` | the body of `function (RS, root)`; RS API only (`RS.data`, `RS.run`, `RS.t`, `RS.time`, `RS.date`, `RS.number`, `RS.count`, `RS.copy`, `RS.copyImage`, `RS.toast`, `RS.media`, `RS.reveal`, `RS.openUrl`, `RS.fillText`, `RS.appendLinks`, `RS.externalLink`, `RS.icon`, `RS.setResult`, `RS.setStatus`, `RS.setSubmitLabel`, `RS.setAlternative`, `RS.focusAlternative`, `RS.addMenuItem`, `RS.addMenuMeta`, `RS.onChange`, `RS.draft`, `RS.submit`; see the helper notes below the table); never `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `eval`, `new Function`, `import()`, `navigator.clipboard`; no literal UI strings; block comments only |
| `schema.json`, `result.schema.json` | only `type, properties, required, additionalProperties, items, minItems, maxItems, uniqueItems, enum, const, minLength, maxLength, pattern, minimum, maximum, oneOf, default, description, x-rs-*`. `"x-rs-unique-key": "<property>"` on an array of objects rejects an item whose `<property>` repeats an earlier item's (e.g. option ids; finding `/data/options/1/id`); `"x-rs-media": true` marks an image path (section 6) |
| `fixtures\` | `golden.json`, at least 2 `edge-*.json`, at least 2 `invalid-*.json` (each must be rejected) |
| `fixtures\expect\golden.json` | `copies` (by `data-copy-id`), `counters` (by `data-counter-id`), `flow` (mouse steps), `keyboard` (keys only), `result` (the exact result `data`) |
| `README.md` | purpose, payload example, result example, German strings used |

To reuse a shipped UI, add `"extends": "<builtin id>"` to the user manifest. Inheritance is deliberately one level: `template.html`, `template.css` and `template.js` come from that shipped built-in; the user template owns its manifest strings/components, `schema.json`, `result.schema.json`, `fixtures\`, `README.md` and template-relative media. The base must be a valid built-in id; unknown bases, traversal, cycles and a base that itself extends another base fail closed in `check`.

Calm-UI helpers (template API, all scoped to the active report):

- `RS.time(iso)`: a timestamp in **Europe/Vienna**, whatever the machine's time zone. German `Do 08.10.2026 · 10:39` (spec 2.9), English `Thu, Oct 8, 2026 · 10:39`. Accepts `Z` and any offset.
- `RS.date(isoDate)`: a calendar date (`2026-10-15`, the same day everywhere). German `15.10.`, English `Oct 15`.
- `RS.number(n)`: grouped by the selected string table: German `99.999`, English `99,999`. The table is German by default; `RS_LANG=en` selects English.
- `RS.setAlternative(label, onClick)` / `RS.setAlternative(null)`: the one quiet footer alternative next to the primary (e.g. *Request changes*). It is reset on every report switch.
- `RS.focusAlternative()`: moves focus to that alternative (e.g. after *Cancel* in a sub-mode). Returns `false` if there is none.
- `RS.addMenuItem(label, onClick)`: an entry in the header `…` panel (e.g. *Show in folder*). Cleared on every report switch.
- `RS.addMenuMeta(text)`: a quiet metadata line (not an action) in the header `…` panel, below the agent and time (e.g. *Persona: …*). Cleared on every report switch.
- `RS.icon(name)`: a decorative inline SVG (`copy`, `check`, `plus`, `hash`, `ring`, `done`, `chevron`, `dot`, `more`, …).
- `RS.openUrl(url)`: ask the server to open that http(s) address in the system browser (`POST /open-url`). `RS.fillText(el, text)` replaces an element's contents with the text and turns addresses in it into those links. `RS.appendLinks(el, text)` appends only the extracted http(s) links, not the surrounding words. `RS.externalLink(url, text)` returns one link, or null when `url` cannot be opened (not http(s), no hostname, a bad port, credentials in the authority, a control character, or a backslash).
- Reports meant to be read (`review-doc`) stay short and scannable: TL;DR first, then a table, bold verdicts, check states (`- [x]` / `- [ ]`), and the long detail last.
- `RS.run.result`: for a **submitted** report, the immutable result `data` (otherwise `null`). Show it read-only instead of the draft; the shell locks decisions and text but keeps tabs, disclosures and item rows (`aria-expanded`) working, and copies and buttons marked `data-rs-view-action` (view-only, e.g. `rs-post-frame`'s *Reload image*).

4. New German strings: a template branch never edits `core\` (that includes `core\i18n\de.json`). Ask the maintainer of the installation to add the shared key (English key, German value) to `de.json`; `check` fails until the key exists there, then list it in `template.json` `strings`.
5. Test until it passes:

   ```
   py -3 report_shell.py check <name>
   py -3 report_shell.py check <name> --visual
   ```

   Exit 0 = pass, 7 = fail (the findings are on stderr). `--visual` compares screenshots of the golden and every edge fixture, light and dark, at 1500x1000, with `golden\<fixture>.light.png` / `.dark.png` (at most 1% differing pixels).
6. **Golden approval rule:** golden images are recorded with `node tools\visual.mjs --update <name>` **only after the person or the maintainer has approved the screenshots**. Never re-record goldens to make a failing `--visual` pass.
7. To share a user template, send its complete `<data dir>/templates/<name>` folder to the maintainer. For a contribution to the shipped repository, agree the destination with the maintainer, copy the files there, and follow the repository contribution process.

## 10. Anti-patterns

- Opening report HTML via `file://`, `Invoke-Item`, `Start-Process <url>`, `start <url>`, `os.startfile` or `webbrowser.open` (that opens a tab in the default browser). Only `report_shell.py show` / `open` open the window. A link inside a report is `RS.openUrl`: the server opens the system browser; a template does not.
- Starting `msedge.exe` or `chrome.exe` yourself, or a second window per update. One window; new runs arrive over SSE.
- Editing the core (`core\`, `tokens.css`, components, `rs.js`) from a template, or copying core CSS into a template.
- Colour literals in template CSS. Literal German text in `template.html` or `template.js`.
- `//` comments in `template.js` (the URL lint fails).
- Preselected choices, more than 3 choices per item, more than 5 items per screen.
- Full email bodies or secrets in the payload.
- Building the result path by hand instead of using `result_path`; reading the action log; parsing the page.
- `wait --timeout 0` from a bot, a timeout above the runtime's shell-call cap, or a background shell that is expected to wake the bot; polling the result file in a tight loop.
- A payload or image path that exists only on the bot's machine, not on `<host>`.
- `--data -` from Windows PowerShell 5.1: the pipe re-encodes the JSON and umlauts arrive as `?` (verified). Use a file.
- Parsing the page or the action log instead of the result file (`result` stdout is fine: it is ASCII-only JSON, non-ASCII characters are `\u` escapes).
- Reusing a `run_id`. Leave `run_id` out and let the core generate it.
- Using `--focus` by default, or `--port 18742` and the real data dir in tests (tests use `RS_DATA_DIR` and another port).

---

## A. Worked example: decide-list

Use the public `decide-list` example in [README.md](../README.md). Save its Python block as `make_payload.py` in the repository root, then run:

```text
python make_payload.py
python report_shell.py show decide-list --data payload.json
python report_shell.py wait RUN_ID --timeout 60
python report_shell.py result RUN_ID
```

Replace `RUN_ID` with the value printed by `show`. Choose and send in the window before reading the result. Exit 5 from `wait` means it is still waiting: hand `wait RUN_ID --until-expiry` to a background subagent if your runtime wakes you when one finishes, or check later with `results --since`. On macOS use `./report-shell` (or `python3.12`) in place of `python report_shell.py`, and `python3.12` for `make_payload.py`.

## B. Commands

`--port N` works before or after the command (default: `config.json` `port`, else 18742). Normal output is one JSON line on stdout; errors are one English line on stderr.

| Command | Output | Exit codes |
|---|---|---|
| `show <template> --data <path\|-> [--focus] [--no-window]` | `{"run_id","url","result_path"}`. Validates, starts the server if needed, registers the run, opens the window if none is open (`--no-window`: never). `--data` may also hold only the `data` object; the core then wraps it (title = template `title_de`, `created` = now, `bot` = the template's namespace, or a built-in default bot id for `global` templates <!-- rename -->). | 0, 2, 3, 4 |
| `wait <run_id> [--timeout <s> \| --until-expiry]` | `{"status","result_path","data_dir"}` once the result file exists (checked every 200 ms). Returns on the result, at the latest at the run's expiry plus 2 minutes (exit 7: no result by then); `--until-expiry` waits up to that point and excludes `--timeout`. A run record without a readable `expires` (pre-beta.2) has no such limit. Never use `--timeout 0` from a bot | 0, 2, 5, 6, 7 |
| `result <run_id>` | the result envelope plus `data_dir` | 0, 6 (also while no result exists yet) |
| `results --since <iso> [--bot <id>] [--seen <run_id>]... [--wait <s>]` | `{"data_dir","results":[{"run_id","bot","template","status","decided","result_path"}],"cursor","seen"}`: results decided at or after `--since`, oldest first, minus `--seen`. `cursor` is the newest `decided` so far and `seen` every run id decided in that second (also on an empty answer); pass both back as they came. `--wait` blocks up to that many seconds (max 3600) for the first one | 0, 2 |
| `paths` | the data directory in use and why, plus unused legacy directories | 0 |
| `status` | `{"up","port","pid","open_runs","window_alive"}` | 0 |
| `open` | `{"ok":true,"opened":true\|false}`; opens or focuses the window when runs are open | 0, 3, 4 |
| `cancel <run_id>` | `{"status":"cancelled","result_path"}`; bot-side withdrawal | 0, 6 (unknown or already decided) |
| `templates [--json]` | table, or `[{"id","source","extends","title"}, ...]`; uses the shared lookup order | 0, 7 (broken registry) |
| `list` | compatibility JSON: `[{"id","namespace","version"}, ...]` | 0, 7 (broken registry) |
| `doctor` | `{"ok","templates","warnings"}` including user/built-in shadow warnings | 0, 7 |
| `check <id> \| --all [--visual]` | `{"ok":true,"template","visual"}` | 0, 7 |
| `new <namespace>/<name>` | `{"ok":true,"id","path"}` | 0, 7 |
| `stop` | `{"ok":true,"stopped":true\|false}` | 0, 4 |
| `serve` | internal (the server in the foreground) | 4 (port), 7 (registry) |

The server stops by itself after 30 minutes with no open run and no window.

## C. Exit codes

| Code | Meaning | Bot does |
|---|---|---|
| 0 | ok | continue |
| 1 | unexpected crash (Python traceback on stderr) | report to the maintainer; read the result file directly |
| 2 | invalid payload (stderr names the JSON pointer, e.g. `/data/message`), unknown template, wrong `version`, `run_id` already used, media outside the roots, payload over 2 MB, invalid JSON (incl. nesting deeper than 64); also command-line usage errors | fix the payload; never retry unchanged |
| 3 | neither Edge nor Chrome found (`refusing to open a browser tab`) | tell the person in chat; never fall back to another browser |
| 4 | port held by a foreign process, or the server did not start within 3 s | tell the maintainer; never pick another port on your own |
| 5 | `wait` timed out | hand the wait to a background subagent, or catch up later with `results --since` |
| 6 | unknown run (`wait`, `result`, `cancel`), no result yet (`result`), or already decided (`cancel`) | check the `run_id`; for `result`, try again later |
| 7 | `wait`: no result by the run's expiry plus 2 minutes. Otherwise: `check` failed, `new` name exists or invalid, broken template registry | `wait`: treat as expired. Otherwise: fix the template |

## D. Envelopes

Payload `report-shell/payload@1` (max 2 MB; unknown top-level fields are rejected):

| Field | Rule |
|---|---|
| `schema` | `report-shell/payload@1` |
| `template` | a registered template id (`list`) |
| `version` | integer, equal to the template's `version` |
| `run_id` | optional; `^[0-9]{8}-[0-9]{6}-[a-z0-9-]{1,20}-[0-9a-f]{4}(?:[0-9a-f]{8})?$`, unused. Best left out; generated ids use 12 hex characters and legacy explicit ids may use 4. |
| `bot` | your bot id, `^[a-z0-9-]{1,40}$` (e.g. `example-bot`) |
| `title` | 1-80 characters; becomes the window title (`<title> · <bot name>`; the name comes from `identity` or the bot registry, see below) |
| `created` | ISO 8601 with an offset |
| `expires_minutes` | optional, 5-10080, default 240 |
| `notify` | optional `{"webhook_url"}`; the webhook is **off in v1**, bots use `wait` |
| `data` | validated against the template's `schema.json` |
| `identity` | optional `{"name", "avatar", "accent", "avatar_shape", "avatar_color"}`, each key optional; see *Bot identity* below. Never rejects the report |

Result `report-shell/result@1`: `schema`, `run_id`, `template`, `template_version`, `bot`, `status` (`submitted` \| `cancelled` \| `expired`), `created`, `decided`, `duration_s`, `log`, and `data` (only for `submitted`). Example in section A, step 4. When the page could not use part of the bot's identity, the result also carries `identity`: `{"name", "accent_fallback": ["light"|"dark"...], "warnings": [{"source", "field", "reason"}...]}` (the same warnings are in the action log `log` as `warning` events).

### Bot identity

Each bot can show its own **name**, **avatar** (an image or a built-in shape) and **accent colour**: the header shows the avatar, the bot's name in bold and the report title as one quiet line below it (times stay in the "…" menu, which repeats a small avatar next to "From <bot>"); with 2+ open reports the strip shows each report's avatar, named for screen readers and in its tooltip by the bot's name and the report title; the accent replaces the default accent for that report only (one accent is visible at a time; the strip never shows another report's accent).

- Sources: payload `identity` > user registry `<data dir>\bots.json` > shipped registry `core\bots.json` > defaults (name = bot id, initials avatar, theme accent). `name` and `accent` resolve per field. The avatar (`avatar`, `avatar_shape`, `avatar_color`) comes whole from the first source that states any of them: a payload with only `avatar_shape` beats a registry image, and a payload `"avatar": ""` clears it (shape or initials). Within that source: image > shape + colour > initials. The shipped registry holds names only (no images, shapes or accents).
- Registry entries: `"example-bot": "Inbox Agent"` (legacy, means `{"name": ...}`) or `"example-bot": {"name": "Inbox Agent", "avatar": "avatars/inbox.png", "accent": "#0891b2", "avatar_shape": "blob", "avatar_color": "orange"}`.
- `name`: plain text, trimmed, 1-40 characters, no control characters; always rendered as text.
- `avatar`: PNG, JPEG, WebP or GIF only (no SVG), at most 256 KB, shown as a 32 px circle (strip and header; 24 px in the "…" menu). Either a `data:image/<type>;base64,...` URL, or a path relative to the template folder (payload; `%RS_TEMPLATE%/...` also works) or to the registry's folder (`<data dir>` for the user registry); no `..`, no UNC, absolute paths only inside `<data dir>`. The content must match the type. Missing or broken avatar: the shape avatar if one is set, else neutral initials (first letters of up to two words).
- `avatar_shape`: one of `blob`, `squircle`, `pebble`, `hex`, `teardrop`, `tablet`; `avatar_color`: one of `blue`, `orange`, `yellow`, `magenta`, `red`, `violet`, `black`, `green`, `gray` (case-insensitive). The page draws the shape itself from the fixed set in `core\static\avatar-shapes.json` (a solid shape with two eye holes, no letter; never SVG from a bot) in the colour's fill for the theme (`--rs-avatar-<colour>` in `tokens.css`; `black` is drawn white in dark mode). Precedence on the page: image > shape > initials. Empty string = no value at that source (no warning; the source still decides the avatar, so initials if it states nothing else); a non-string value is skipped with a warning (if all avatar fields of a source are invalid, the next source decides); an unknown name is a warning and means no shape (initials circle) or no colour (the default accent colour fills the shape).
- `accent`: `#RRGGBB`. Checked per theme: accent and its derived hover fill vs page and card >= 3:1, the label (black or white, whichever is higher) vs accent and hover >= 4.5:1, the focus ring (= accent) >= 3:1 on every focus background in `contrast-pairs.json`. A theme that fails uses the default accent and is listed in `accent_fallback`. For example, `#0891b2` falls back in light mode because its derived hover fill is below 3:1 against white, while `#a855f7` passes both themes. Without `accent`, `avatar_color` seeds the accent through the same checks (e.g. `blue` is used in light mode and falls back in dark mode, `orange` the other way round); a seeded theme that fails is listed in `accent_fallback` without a warning.
- Problems never reject the report: an invalid value is skipped (the next source is used) and logged as a warning. `doctor` lists the problems of both registries under `identity_warnings`.
- Grok Bot: a bot reads its own `profile.json` and passes `avatarShape` / `avatarColor` as `avatar_shape` / `avatar_color` (camelCase to snake_case); an empty profile value stays omitted.

---

## Deviations from the spec

- All CLI output (stdout and stderr) is pure ASCII: JSON escapes non-ASCII characters (`\u00e4`), so it survives any console code page. `ConvertFrom-Json` restores them.
- `result` returns exit 6 both for an unknown run and for a known run without a result yet (spec 3.1 lists only 0 and 6).
- `show --data` also accepts a bare `data` object and wraps it in an envelope (not in spec 3.1).
- `list` exits 7, and `open` / `stop` can exit 4, which spec 3.1 does not list.
- A payload file or stdin may start with one UTF-8 BOM, which is stripped; JSON nesting is limited to 64 levels (exit 2 beyond).
- The template lint treats any `//` in `template.html`, `template.css` or `template.js` as a URL, so `//` comments fail (spec 4.4 names only URLs).
- Localised attributes use `data-rs-t-<attribute>` and literal UI strings in `template.js` fail the lint (plan 2.4; not in spec 4.4).
- `check` also needs `node tools\visual.mjs` for `--visual` (exit 7 if missing) and runs `node tools\e2e.mjs expect <id>` when `fixtures\expect\` exists.
- The `● ` prefix stays while any open run is unread, not only the active one (spec 2.4).
- The clipboard writer opens the clipboard with a message-only window (`CreateWindowExW`) so it does not depend on a visible UI window.
