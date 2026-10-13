# grokbot-desk: best-practice guide (v1)

For bots that show reports to a person in the grokbot-desk window, and for bots that write templates. Sections 1-10 explain the design rules; the reference part (A-D) has the worked example, every command and every exit code.

Windows and macOS are supported. On macOS, use Python 3.11 or newer through `./report-shell` or a versioned `python3.12` (macOS's own `/usr/bin/python3` is 3.9 and too old), not `py -3` or `report-shell.cmd`. See the README sections macOS setup and Platforms.

Run commands from the repository root with `python report_shell.py <command>` using Python 3.11 or newer. On Windows, `py -3` is an alternative only when `py -3 --version` succeeds. The Windows wrapper `<repo>\report-shell.cmd <command>` requires that launcher. From another directory, pass the full path to `report_shell.py`. On macOS, use `<repo>/report-shell <command>` (it finds a Python 3.11 or newer) or `python3.12`, and forward-slash paths; the .cmd wrapper is Windows-only.

Quick start: write a payload file, then `show`, then `wait` in a loop, then read the result file. Section A has the full example.

Placeholders used below: `<repo>` = the repository folder, `<host>` = the Windows machine that shows the window, `<user>` = the Windows user on `<host>`, `example-bot` = your bot id, `<data dir>` = `%LOCALAPPDATA%\grokbot-desk` on Windows, or `RS_DATA_DIR` if set. A legacy `%LOCALAPPDATA%\spqrk-report-shell` stays in use until the new folder holds runs of its own, or until `migrate` moves it; an empty `grokbot-desk` folder does not hide it. Bots always use the CLI (`result`, `wait`, `results --since`, `paths`) and never guess the data directory. `paths` prints which directory is in use and why.

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
- If the window is already open, a new report arrives quietly: the title gets the prefix `● ` and the taskbar button flashes, at most once per burst of reports (pushes less than 30 seconds apart are one burst; a window opened for the first report of a burst counts as its one bring-forward). The page uses that same 30-second quiet gap for its one announcement. The window does not jump to the front. `show --focus` brings it to the front, also at most once per burst; use it only when the person asked for the report right now.
- Above the title of every report a tinted task banner says what to do and who acts next: one task line (`Freigeben, dann postet der Bot` / `Approve and the bot posts`), one line of steps, at most three sentences of why, and the effort and due date as quiet meta (`~3 Min.`, `fällig heute 15:00`). A decided report keeps it, neutral, saying what happened. See *Task banner* in section D.
- With exactly one open report there is no list at all: the header shows the bot's avatar, its name in bold and the report title as one quiet line below. With 2 or more open reports a slim avatar strip sits above the header with one avatar per bot (see "Several bots" below), the active one underlined, and `n von m offen` / `n of m open` at the end (counting reports, up to 12). `Ctrl+1..9` switches from anywhere; on the strip `Left`/`Right`/`Home`/`End` move along it (one Tab stop). A new report never replaces the report on screen; it waits in the strip with a filled dot and the window title gets `● `.

### Several bots

When several bots post at once (a burst), the window stays one calm window:

- Exactly one window. Concurrent `show` calls with no window open launch one window; the others return at once. A window still starting up (a first browser start can take several seconds) is waited for, not launched again.
- The report on screen stays, touched or not. A new report becomes the active one only when nothing open is shown (no report, or the shown one was decided or is gone); then the oldest arrival comes first.
- One announcement per burst, polite for screen readers: `3 neue Berichte von 2 Bots` / `3 new reports from 2 bots` (one bot: `2 new reports from Inbox Agent`; a single waiting report: `New report: <title>`). A single report that is shown at once needs none. Reports less than 30 seconds apart are one burst, the same rule as bringing the window forward. The page collects that burst for up to 10 seconds, announces it once, and stays quiet until 30 seconds have passed with no new report.
- The strip groups open reports by bot: one avatar per bot, with a small count when that bot has more than one (named `Inbox Agent, 3 Berichte` / `Inbox Agent, 3 reports` for screen readers). The current bot's avatar also says to activate it again for the next report. Bots keep the order in which they were registered, and each bot's reports that same order, so nothing jumps during a burst. Each run summary carries `seq`, assigned when the report was registered and stored on the run. A run saved before `seq` existed is given one when the store loads it, in `created` order, and that run stays ahead of any report registered afterwards. A bot's `created` stamp cannot move an entry. A bot's avatar goes to its oldest open report; activating the current bot's avatar again steps to that bot's next report. After a decision the window moves on to the same bot's next open report, wrapping to that bot's earlier open reports before it moves on to the next bot.
- After the person sends or discards a report, the window moves on to the next open one. After the last one it shows a calm done state (`Alles erledigt. Das Fenster schließt sich gleich.` with `Offen lassen`) and closes itself after about 4 seconds; open reports never close it, and a new report arriving in that moment cancels the close.
- If the person closes the window, open reports stay open. The next `show`, or `report_shell.py open`, opens the window again.

## 2. Action design

- Every item ends in an explicit choice. The person picks; nothing is decided by default.
- Set `task.kind` and write a short `task.why` (aim for 3 sentences). Labels say who acts next: `Erledigt ✓` when the person does it, `Gepostet ✓` when they post it, `Freigeben & posten` when the bot will, `Verstanden` when there is nothing to decide. The actor-model built-ins take their buttons from one table (*Task banner*).
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

## 5. German strings and local time

German is the default; set `RS_LANG=en` before starting the server to select English. Times use the machine's time zone; `RS_TZ` (an IANA name such as `Europe/Vienna`) pins one zone, for tests and screenshots.

- Every visible UI string is German and comes from `core\i18n\de.json` (keys in English, values in German). Templates never contain literal text:
  - static text in `template.html`: `<span data-rs-t="key"></span>`;
  - localised attributes (`placeholder`, `title`, `aria-label`, `alt`): `data-rs-t-<attribute>="key"`, e.g. `data-rs-t-placeholder="note"`;
  - dynamic text in `template.js`: `RS.t("key", {name: value})` (`{name}` placeholders in the value are filled from the params);
  - payload text (names, subjects, snippets): set with `textContent`, never `innerHTML`.
- Every key a template uses is listed in `template.json` `strings` and exists in `de.json`. A new key goes into `de.json` first (see section 9, step 4).
- Times: only `RS.time(iso)`, which shows local time in the format `Do 08.10.2026 · 10:39`.
- Every timestamp in a payload must carry an offset (`+02:00`, `+01:00` or `Z`); the core converts it to local time. Timestamps in result envelopes are local ISO 8601 with their offset, e.g. `2026-10-08T10:44:12+02:00`.
- Producing `created`:
  - PowerShell on `<host>`: `(Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')` gives e.g. `2026-10-08T12:41:33+02:00`.
  - Python: `datetime.now().astimezone().isoformat(timespec="seconds")`.

## 6. No external requests

- No CDN, web fonts, remote images, link unfurling or any network call from the page. The Content-Security-Policy blocks it, and the template lint rejects `http:`, `https:` and `//` anywhere in `template.html`, `template.css` and `template.js`. That includes `//` line comments: write `/* ... */` comments only.
- System fonts only (the core sets them).
- A link in a post preview is rendered from the payload (`url`, `title`, `domain`); nothing is fetched.
- http(s) addresses in item text, review-doc Markdown, pick-option text and a payload `url` field are real links. The page does not let those links navigate this window: the anchors are not draggable, a drag is cancelled, and dropping a URL on the page is cancelled. A primary click, a middle click, Enter, and a modified click (Shift, Ctrl, Alt) call `RS.openUrl(url)`, which posts `{run_id, url}` to `/open-url`. Modified Enter does the same, except Ctrl+Enter or Cmd+Enter, which stays the submit shortcut and does not navigate. The server opens the host's default browser only when that exact address occurs in the run's payload, is http or https, is at most 2048 characters, has a hostname and a valid port, and has no credentials in the authority. `rel="noopener noreferrer"` and the server allowlist do not by themselves stop the window from navigating; the page handlers do. A right-click on these links is cancelled so the menu cannot open the address in the app profile. A browser that still offers Open from a menu the page cannot see is outside this guarantee.
- Images and video go through the media roots:
  - The payload holds an absolute path on `<host>` in a field the template's `schema.json` marks with `"x-rs-media"`. `true` is an image. `"video"` is a video.
  - At `show` the path must resolve (after realpath) under one of the media roots in `config.json` `media_roots` (in `<data dir>`). Defaults are the user's Downloads folder and `<data dir>/media`; add any shared-drive folder explicitly to `config.json` `media_roots`.
  - Images: `.png .jpg .jpeg .webp .gif`, at most 20 MB. Video: `.mp4 .webm`, at most 200 MB. The file must exist. Relative paths, `..`, UNC paths and paths outside the roots are rejected with exit code 2.
  - The page never sees the path, only a random media id. `RS.media(id)` is the URL for `img.src`, a video `src`, or a poster. `/media/<id>` is served in HTTP ranges, so a video can start without reading the whole file. A range with no bound (`bytes=-`) is ignored and the whole file is returned. `RS.reveal(id)` is `Im Ordner zeigen` / `Show in folder`, and only for a media file of that same report. `RS.copyImage(id)` (or `<rs-copy media="<id>">`) puts an image on the clipboard as a picture (macOS: PNG, JPEG, GIF, WebP; Windows: PNG, JPEG, GIF). `RS.copyPath(id)` (or `<rs-copy media="<id>" media-copy="path">`) copies the file path, which is how a video is handed to a manual post. The poster image stays visible on its own. If the clip cannot be decoded, or makes no progress for 8 seconds, the loading indicator stops and the page says the preview is unavailable in this browser and that the path can still be copied or the file shown in its folder. Choosing not to preload (`preload="none"`) leaves an untouched clip on its poster and is not a failure; once playback starts, a clip that cannot be decoded keeps the poster and the same unavailable line, with no retry button.
  - A bot on another machine copies the file to `<host>` first (section A, step 1: drop folder) and puts the `<host>` path into the payload. Never a path that exists only on the bot's machine.

## 7. Accessibility

Checklist. The core already gives `lang="de"`, visible focus, token contrast and the keyboard map; templates must not break them.

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
- One open report per topic: when a newer report replaces an open one, `cancel` the old run first. Or set `dedupe_key` (1–120 printable ASCII characters, not starting with a space) so the same bot and key does not open a second report. `dedupe_hours` (integer 1–168, default 24) is only valid together with a key. An open run with that key is returned as-is. A run submitted or cancelled within the last N hours is returned too (`show` prints `deduped: true` and `state`: `open`, `submitted` or `cancelled`) and does not open another window. An expired run was never answered, so it never dedupes.
- `created` is ISO 8601 with an offset. A stamp more than 2 minutes ahead of the clock is clamped to now, and `show` includes a warning: a wrong UTC offset would otherwise make `duration_s` read 0. Up to 2 minutes ahead is left as clock skew.

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
| `template.js` | the body of `function (RS, root)`; RS API only (`RS.data`, `RS.run`, `RS.t`, `RS.time`, `RS.date`, `RS.number`, `RS.count`, `RS.copy`, `RS.copyImage`, `RS.copyPath`, `RS.toast`, `RS.media`, `RS.reveal`, `RS.openUrl`, `RS.fillText`, `RS.appendLinks`, `RS.externalLink`, `RS.icon`, `RS.setResult`, `RS.setStatus`, `RS.setSubmitLabel`, `RS.setAlternative`, `RS.focusAlternative`, `RS.addMenuItem`, `RS.addMenuMeta`, `RS.onChange`, `RS.draft`, `RS.submit`; see the helper notes below the table); never `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `eval`, `new Function`, `import()`, `navigator.clipboard`; no literal UI strings; block comments only |
| `schema.json`, `result.schema.json` | only `type, properties, required, additionalProperties, items, minItems, maxItems, uniqueItems, enum, const, minLength, maxLength, pattern, minimum, maximum, oneOf, default, description, x-rs-*`. `"x-rs-unique-key": "<property>"` on an array of objects rejects an item whose `<property>` repeats an earlier item's (e.g. option ids; finding `/data/options/1/id`); `"x-rs-exclusive": ["image", "video"]` on an object rejects a value that sets more than one of those properties (finding `/video`); every name must be a non-empty string, or the finding is `/x-rs-exclusive`. `"x-rs-url": true` (or `"http"`) requires an openable http(s) URL; `"x-rs-url": "https"` additionally requires https. Openable means what the opener accepts: a hostname or an IPv6 literal, a port from 0 to 65535, no credentials, no spaces, backslashes or control characters, at most 2048 characters. An uppercase scheme (`HTTPS://`) and a zero-padded port are accepted. `preview-post` `target.url` uses `"https"` and `maxLength` 2048, so those opener forms are accepted and `http://` is not. `decide-list` `items[].url` keeps its hostname pattern as well, so an IPv6 literal stays rejected there. `"x-rs-media": true` marks an image path and `"x-rs-media": "video"` a video path (section 6) |
| `fixtures\` | `golden.json`, at least 2 `edge-*.json`, at least 2 `invalid-*.json` (each must be rejected) |
| `fixtures\expect\golden.json` | `copies` (by `data-copy-id`), `counters` (by `data-counter-id`), `flow` (mouse steps), `keyboard` (keys only), `result` (the exact result `data`) |
| `README.md` | purpose, payload example, result example, German strings used |

To reuse a shipped UI, add `"extends": "<builtin id>"` to the user manifest. Inheritance is deliberately one level: `template.html`, `template.css` and `template.js` come from that shipped built-in; the user template owns its manifest strings/components, `schema.json`, `result.schema.json`, `fixtures\`, `README.md` and template-relative media. The base must be a valid built-in id; unknown bases, traversal, cycles and a base that itself extends another base fail closed in `check`.

Calm-UI helpers (template API, all scoped to the active report):

- `RS.time(iso)`: a timestamp in the machine's time zone (or the one `RS_TZ` pins). German `Do 08.10.2026 · 10:39`, English `Thu, Oct 8, 2026 · 10:39`. Accepts `Z` and any offset.
- `RS.date(isoDate)`: a calendar date (`2026-10-15`, the same day everywhere). German `15.10.`, English `Oct 15`.
- `RS.number(n)`: grouped by the selected string table: German `99.999`, English `99,999`. The table is German by default; `RS_LANG=en` selects English.
- `RS.setAlternatives([{label, run}, ...])`: up to two quiet footer alternatives, shown in the given order before the primary (e.g. *Skip*, *Request changes*). `[]` removes them. `RS.setAlternative(label, onClick)` / `RS.setAlternative(null)` is the one-item form. They are reset on every report switch. The footer holds the status, these alternatives and the one primary; *Discard report* lives in the header's `…` menu, behind its confirmation.
- `RS.focusAlternative()`: moves focus to that alternative (e.g. after *Cancel* in a sub-mode). Returns `false` if there is none.
- `RS.addMenuItem(label, onClick)`: an entry in the header `…` panel (e.g. *Show in folder*). Cleared on every report switch.
- `RS.addMenuMeta(text)`: a quiet metadata line (not an action) in the header `…` panel, below the agent and time (e.g. *Persona: …*). Cleared on every report switch.
- `RS.icon(name)`: a decorative inline SVG (`copy`, `check`, `plus`, `hash`, `ring`, `done`, `chevron`, `dot`, `more`, …).
- `RS.openUrl(url)`: ask the server to open that http(s) address in the system browser (`POST /open-url`). `RS.fillText(el, text)` replaces an element's contents with the text and turns addresses in it into those links. `RS.appendLinks(el, text)` appends only the extracted http(s) links, not the surrounding words. `RS.externalLink(url, text)` returns one link, or null when `url` cannot be opened (not http(s), no hostname, a bad port, credentials in the authority, a control character, or a backslash).
- Reports meant to be read (`review-doc`) stay short and scannable: a one-line TL;DR first, then a table, bold verdicts, check states (`- [x]` / `- [ ]`), at most one callout (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]` alone on the first quoted line), and the long detail last. `review-doc/fixtures/edge-report.json` is the model.
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
- Preselected choices, more than 3 choices per item, more than 12 items per screen.
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
| `show <template> --data <path\|-> [--focus] [--no-window]` | `{"run_id","url","result_path","data_dir"}`. Validates, starts the server if needed, registers the run, opens the window if none is open (`--no-window`: never). A duplicate `dedupe_key` adds `deduped: true` and `state` and does not open a second report. A clamped `created` adds `warnings`. While the older Windows data folder is in use, `data_dir_warning` names `migrate`. `--data` may also hold only the `data` object; the core then wraps it (title = template `title_de`, `created` = now, `bot` = the template's namespace, or a built-in default bot id for `global` templates <!-- rename -->). | 0, 2, 3, 4 |
| `wait <run_id> [--timeout <s> \| --until-expiry]` | `{"status","result_path","data_dir"}` once the result file exists (checked every 200 ms). Returns on the result, at the latest at the run's expiry plus 2 minutes (exit 7: no result by then); `--until-expiry` waits up to that point and excludes `--timeout`. A run record without a readable `expires` (pre-beta.2) has no such limit. Never use `--timeout 0` from a bot | 0, 2, 5, 6, 7 |
| `result <run_id>` | the result envelope plus `data_dir` | 0, 6 (also while no result exists yet) |
| `results --since <iso> [--bot <id>] [--seen <run_id>]... [--wait <s>]` | `{"data_dir","results":[{"run_id","bot","template","title","status","decided","result_path","summary?"}],"cursor","seen"}`: results decided at or after `--since`, oldest first, minus `--seen`. `title` is included when the run record still has a payload title (or the result file itself carries one). `summary`, when the decision is compact, is decide-list counts per choice (`2 approve, 1 defer`), a consistent preview-post reading (`x posted by you, linkedin approved`; manual is `posted by you` or `skipped`, auto+approved is `approved`), the approve-one or review-doc decision word, or the pick-option id. A preview-post summary is omitted when mode and decision disagree, the decision is unknown, `platforms` is not exactly the auto approvals, or the result has no `per_platform` (older results). The summary is not permission to post: read `per_platform` and post only `auto` + `approved`. An inconsistent preview-post result is rejected on submit. `cursor` is the newest `decided` so far (keep it) and `seen` every run id decided in that second (also on an empty answer); pass both back as they came. `--wait` blocks up to that many seconds (max 3600) for the first one | 0, 2 |
| `paths` | `{"data_dir","source","runs","results","log","config"}` and `unused_data_dirs` when another candidate still holds results. `source` is `RS_DATA_DIR`, `legacy` or `default`. `warning` appears while the older Windows folder is in use and names `migrate`. This is how a bot learns the directory; it never guesses | 0 |
| `migrate` | Windows: moves `%LOCALAPPDATA%\spqrk-report-shell` to `%LOCALAPPDATA%\grokbot-desk` (only when the new folder is missing or holds no files) and points `config.json` `media_roots` under the old folder to the new one. Prints `{"migrated","from","to","config_rewritten"}`. Refuses while a desk runs or starts in either folder, or while a report in the old folder is still open (exit 4: decide or discard open reports first), or when the new folder holds files (exit 7); nothing changes then. The old folder is never created again afterwards. `RS_DATA_DIR` and macOS: nothing to do | 0, 4, 7 |
| `status` | `{"up","port","pid","open_runs","window_alive"}` | 0 |
| `open` | `{"ok":true,"opened":true\|false}`; opens or focuses the window when runs are open | 0, 3, 4 |
| `cancel <run_id>` | `{"status":"cancelled","result_path"}`; bot-side withdrawal | 0, 6 (unknown or already decided) |
| `templates [--json]` | table, or `[{"id","source","extends","title"}, ...]`; uses the shared lookup order | 0, 7 (broken registry) |
| `list` | compatibility JSON: `[{"id","namespace","version"}, ...]` | 0, 7 (broken registry) |
| `doctor` | `{"ok","templates","warnings"}` including user/built-in shadow warnings, plus `data_dir_warning` while the older Windows folder is in use | 0, 7 |
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
| `created` | ISO 8601 with an offset. More than 2 minutes ahead of the clock is clamped to now and `show` warns (see section 8) |
| `dedupe_key` | optional, 1–120 printable ASCII characters. Same bot + key returns the existing open run, or the submitted/cancelled run from the last `dedupe_hours` (default 24). Expired never matches. See section 8 |
| `dedupe_hours` | optional integer 1–168, only together with `dedupe_key` |
| `expires_minutes` | optional, 5-10080, default 240 |
| `notify` | optional `{"webhook_url"}`; the webhook is **off in v1**, bots use `wait` |
| `data` | validated against the template's `schema.json` |
| `identity` | optional `{"name", "avatar", "accent", "avatar_shape", "avatar_color"}`, each key optional; see *Bot identity* below. Never rejects the report |
| `task` | optional `{"kind", "steps", "eta_min", "due", "why"}`: what the person does and who acts next; see *Task banner* below. Without it the kind is derived. An unknown field or kind, or a kind that contradicts `data`, is rejected with a pointer (exit 2) |

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

### Task banner

A busy person who was interrupted should know within 10 seconds what to do. Every report therefore opens with a quiet byline (the bot's avatar and name, the open count while several wait, the `…` menu), the report title as the strongest line, and right under it a banner: one line with the task of its kind and `eta_min` / `due` as quiet meta (`~3 min`, `due today 15:00`, `overdue since 09:00`; local time), then at most three sentences of why. Steps show only where they add what the line and the buttons do not say: `task.steps` when the payload sets them, a mixed report's plan per actor, a list's `decide each, then <button>` (naming the footer as it reads now). A template's `summary`, `intro`, `context` or `notes` moves into the banner as the why only when it fits there whole (three sentences, 360 characters); otherwise it stays in the report. Line breaks in the why are kept; German abbreviations (`z. B.`, `ca.`, `Nr.`) and ordinals (`1. Schritt`) do not end a sentence; a cut falls at a word boundary and ends with `…`. A supplied `task.steps` stays as written: ticks, choices and a change request refresh the actor lines and the footer, and they do not replace that line. A longer payload why is folded behind `Mehr dazu` / `More on why`, the only control the banner may hold. A decided report keeps the banner, neutral and muted (`Gelesen: nichts weiter zu tun`, `Verworfen: der Bot macht nichts`).

`task` fields:

| Field | Rule |
|---|---|
| `kind` | required: `post_yourself`, `approve_bot_acts`, `pick`, `fyi`, `review` or `blocking` |
| `steps` | optional, one line, 1-140 characters. When set, this is the steps line for the whole open report; live updates do not replace it |
| `eta_min` | optional integer 1-120 (minutes of the person's effort) |
| `due` | optional calendar date `YYYY-MM-DD`, or an extended timestamp `YYYY-MM-DDTHH:MM[:SS[.fff]]Z` or with a `±HH:MM` offset. Basic ISO, week dates and other separators are rejected, so a deadline cannot vanish in the browser |
| `why` | optional non-empty text. Aim for 3 sentences and 360 characters: past either limit, `show` warns and still accepts the report (exit 0). The banner shows the first three sentences, or the first 360 characters, and folds the rest. Without `why` the banner uses the template's lead (`summary`, `intro`, `context` or `notes`) the same way, and the template leaves that text out. A lead with a link stays in the template |

Without `task` the kind is derived:

| Template | Derived kind |
|---|---|
| `preview-post` | every platform `manual`: `post_yourself`; any `auto`: `approve_bot_acts` |
| `decide-list` | every item `actor: "user"`: `post_yourself`; else `approve_bot_acts` |
| `pick-option` | `pick` |
| `review-doc` | `review`; with `action`: `approve_bot_acts`; `actor: "user"`: `post_yourself`; `actor: "none"`: `fyi` |
| `approve-one` | `approve_bot_acts`; `actor: "user"`: `post_yourself`; `actor: "none"`: `fyi` |
| other templates | `review` |

A given kind sets the matching actor when `data` leaves it out (for example `fyi` on `approve-one` means `actor: "none"`, `post_yourself` on `preview-post` makes every platform manual) and is rejected with a pointer when `data` says otherwise (`/data/actor`, `/data/platforms/1/mode`). Each built-in accepts only the kinds it can show (`pick-option`: `pick`, `blocking`). `blocking` keeps the derived kind's buttons and emphasises its primary. A template without an actor model (`_starter`, or a user template that does not extend a built-in) may set `review` or `blocking` only. An explicit `fyi` or any other kind is rejected at `/task/kind`: the banner would promise a button the template does not have. With no `task`, those templates still show the generic review banner and keep their own buttons.

Buttons per kind (one table, `core\static\tasks.js`, used by the actor-model built-ins' footers and per-item controls; `RS.cta(value, {item, actor, content})` is the per-item path):

| Kind | Who acts next | Primary | Other buttons |
|---|---|---|---|
| `post_yourself` | the person posts, then reports back | `Gepostet ✓` | `Überspringen`; per decide-list item also `Später` |
| user, not a post | the person does it, then reports back | `Erledigt ✓`, or `Gesendet ✓` when `action` is `send` | `Überspringen`. `approve-one` also offers `Änderungen anfordern` when `allow_changes` is set. The hint names the real choices (`Wähle Gesendet oder Überspringen` for a send) |
| `approve_bot_acts` | the bot, after approval | `Freigeben & posten` / `& senden` / `& weiter` (or the payload's `approve_label`) | `Änderungen anfordern` or `Ablehnen` |
| `pick` | the bot, with the chosen option | `Auswählen` (`<Option> wählen` once picked) | an optional note; `Keine davon` asks for new options (the decided banner says `Neue Optionen angefragt`) |
| `fyi` | nobody | `Verstanden`, enabled at once | no other decision, and no `Verwerfen`. One collapsed note (`Notiz hinzufügen`), closed by default |
| `review` | the bot, with the verdict | `Passt` | `Änderungen anfordern` |
| `blocking` | as the derived kind | the derived kind's primary, emphasised | as the derived kind |

The mark names what the person did. Post content — a manual `preview-post` platform, a decide-list item with `content` `post` or `reply`, or an explicit `task.kind` of `post_yourself` — reads `Gepostet ✓` / `Posted ✓`. A user task on `approve-one` or `review-doc` with `action` `send` reads `Gesendet ✓` / `Sent ✓` (`mark` stays `sent`). `Erledigt ✓` / `Done ✓` is only when there is no specific content or action. Result values stay `done` / `skipped` (and `later` on a list). A decide-list footer reads `Fertig` when every item is `actor: "user"`, otherwise `Entscheidungen senden` (`Entscheidung senden` for one item): it sends every choice at once and approves nothing by itself. A mixed report (a preview with `auto` and `manual` platforms, a list with `user` and `bot` items) gives each actor one banner line, the person first, the bot by its display name (from `identity` or the registry):

| State | Deutsch | English |
|---|---|---|
| open | `Du postest: X` / `Inbox Agent postet nach Freigabe: LinkedIn` | `You post: X` / `Inbox Agent posts after approval: LinkedIn` |
| a list | `Du postest: 2 Antworten` / `Inbox Agent sendet nach Freigabe: 3 Einträge` | `You post: 2 replies` / `Inbox Agent sends after approval: 3 items` |
| only X ticked | `Du postest: X` / `Inbox Agent postet nichts: LinkedIn nicht angehakt` | `You post: X` / `Inbox Agent posts nothing: LinkedIn not ticked` |
| decided | `Du hast gepostet: X` / `Inbox Agent postet jetzt: LinkedIn` | `You posted: X` / `Inbox Agent posts now: LinkedIn` |
| changes asked | `Du hast Änderungen angefordert` / `Inbox Agent postet nichts` | `You asked for changes` / `Inbox Agent posts nothing` |

Platforms are named by their labels (up to three, then `LinkedIn, Instagram +2`); list items are counted (`Antworten` for `content: "reply"`, `Beiträge` for `post`, else `Einträge`). The person's verb is `postest` when every item of theirs is a post or reply, else `erledigst`. The bot's verb is the payload `action` (`post`, `send`, `continue`; `preview-post` always posts). The lines follow the ticks and choices: until something is ticked every approvable platform is planned; a platform that cannot be approved is left out of that plan from the start. After a tick, an unticked approvable platform, a skipped or deferred item and a rejected bot item are out, and a side with nothing left says so (`postet nichts`). A blocked platform is not described as merely unticked. A mixed preview's steps are one line that names no platform: `Plattformen prüfen, dann Rückmeldung senden` / `Review the platforms, then Send response`, ending with the footer as it reads now (`Freigeben & posten` when only auto platforms are ticked, `Gepostet ✓` when only manual ones are).

A platform that cannot be approved (over its limit, Instagram without an image or a video) is not named in the actor's planned line. The actor lines, the steps and the footer use that same approvable set, including before any tick. The footer of a mixed preview names neither actor while both act: `Rückmeldung senden` / `Send response` (also, disabled, before anything is ticked), `Freigeben & posten` when only auto platforms are ticked, `Gepostet ✓` when only manual ones are. Its status splits the count: `1 freigegeben · 1 gepostet` / `1 approved · 1 posted`. A list's steps name the footer as it reads now (`Jeden Eintrag entscheiden, dann Entscheidungen senden`). A list of only the bot's actions asks for decisions, never for one choice: `Entscheidungen treffen, dann macht Inbox Agent weiter` / `Make your decisions, then Inbox Agent continues` (`Entscheidung treffen` for one item; `labels.approve` names only the item buttons and the status). A decided report words the same lines in the past tense.

Colours: one calm tint per kind with a 4 px edge (`--rs-task-<kind>-bg` / `-edge` in `tokens.css`): amber for `post_yourself`, green for `approve_bot_acts`, violet for `pick`, grey for `fyi`, teal for `review`. Red only for `blocking` or when `due` is today or past. Text on every tint is at least 4.5:1 and the edge at least 3:1 in light and dark (`contrast-pairs.json`).

The C16 exception: a report shows one accent and otherwise only neutral greys and small status dots (calm rule K6). The banner tint is a status colour, not the accent, and it is the only other colour allowed: exactly one banner, under the title, with no buttons in it and at most one details summary. The calm checker exempts that banner's background and edge, and neutral text on it; any other chromatic colour still fails, including inside the banner. One primary action and at most 3 buttons per item still hold. The information-only note is a closed disclosure, not a second action.

Templates read the kind as `RS.task` (`{kind, base, verb, why_from, mark, parties, steps_for}`) and a label as `RS.cta(value)` (`RS.cta('approve')` is `Freigeben & posten` for a post the bot makes, `Passt` for a review). `mark` is `posted`, `sent` or `done` when the person reports a completion: `posted` for post content, `sent` when a user task's `action` is `send`, `done` only when there is no specific content or action. `parties` lists a mixed report's platforms (`{id, role}`) or items (`{role, noun}`). A template keeps the per-actor lines true with `RS.setTaskLive({parties, changes, stepsFor, stepsKey, stepsButton, tone})`, each party with `on` (`true` ticked or approved, `false` left out, absent while undecided) and, for a platform that cannot be approved, `blocked: true` (left out of the planned names, not called unticked). `stepsFor: 'mixed_platforms'` words the platform steps line; `stepsKey` is any other steps key; both end with `stepsButton`. An explicit `task.steps` is authoritative: the call still updates the actor lines, the footer and the tone, and it does not replace that line.

When no report is on screen while some wait (for example, a report failed to load), the window lists them under `Wartet auf dich` / `Waiting for you`: avatar, bot, title and the kind of task. A row opens its report.

---

## Deviations from the spec

- All CLI output (stdout and stderr) is pure ASCII: JSON escapes non-ASCII characters (`\u00e4`), so it survives any console code page. `ConvertFrom-Json` restores them.
- `result` returns exit 6 both for an unknown run and for a known run without a result yet.
- `show --data` also accepts a bare `data` object and wraps it in an envelope.
- `list` exits 7, and `open` / `stop` can exit 4.
- A payload file or stdin may start with one UTF-8 BOM, which is stripped; JSON nesting is limited to 64 levels (exit 2 beyond).
- The template lint treats any `//` in `template.html`, `template.css` or `template.js` as a URL, so `//` comments fail.
- Localised attributes use `data-rs-t-<attribute>` and literal UI strings in `template.js` fail the lint.
- `check` also needs `node tools\visual.mjs` for `--visual` (exit 7 if missing) and runs `node tools\e2e.mjs expect <id>` when `fixtures\expect\` exists.
- The `● ` prefix stays while any open run is unread, not only the active one.
- The clipboard writer opens the clipboard with a message-only window (`CreateWindowExW`) so it does not depend on a visible UI window.
