# report-shell: best-practice guide (v1) <!-- rename -->

For bots that show reports to a person in the report-shell window, and for bots that write templates. This guide defines how to use report-shell well: sections 1-10 cover operating practices, and the reference part (A-D) has the worked example, every command and every exit code.

Platform: Windows is the supported platform today; macOS support is planned.

Entry point, run from the repository root (`<repo>`):

```
py -3 report_shell.py <command>
```

From any other directory use the wrapper `<repo>\report-shell.cmd <command>` (it calls `py -3 report_shell.py` next to itself). <!-- rename -->

Quick start: write a payload file, then `show`, then `wait` in a loop, then read the result file. Section A has the full example.

Placeholders used below: `<repo>` = the repository folder, `<host>` = the Windows machine that shows the window, `example-bot` = your bot id, `<data dir>` = the data directory on `<host>`: `%LOCALAPPDATA%\grokbot-desk` (or `RS_DATA_DIR` if set; real output shows the selected absolute path).

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

- One window (Edge or Chrome in `--app` mode, own profile, no tabs, no address bar), 1500x1000 at 0,0 of the primary monitor.
- If the window is already open, a new report arrives quietly: the title gets the prefix `● ` and the taskbar button flashes. The window does not jump to the front. `show --focus` brings it to the front; use it only when the person asked for the report right now.
- A run rail on the left lists up to 12 open reports (Alt+1..9 switches). A new report replaces the active one only if the person has not touched the active one yet; otherwise it waits in the rail with the badge `neu`.
- If the person closes the window, open reports stay open. The next `show`, or `report_shell.py open`, opens the window again.

## 2. Action design

- Every item ends in an explicit choice. The person picks; nothing is decided by default.
- Choice labels are German verbs of at most 2 words (`Erledigt`, `Später`, `Ignorieren`, `Ja`, `Nein`, `Freigeben`, `Änderungen anfordern`).
- At most 3 choices per item. Use `rs-action-row` (radio-group semantics, arrow keys).
- No pre-selected choice. "Do nothing" is the default: a report that is discarded (`Verwerfen`) or expires gives the bot a `cancelled` or `expired` result, and the bot then does nothing.
- Keep `An Bot senden` disabled until the input is complete: the template calls `RS.setResult(null)` until every required choice is made, and `RS.setStatus(...)` says what is missing (e.g. `Noch 2 von 5 offen`).
- The window never executes destructive work in v1. It records decisions; the bot executes them after reading the result file.

## 3. Copy-first

- Anything the person would otherwise retype gets an `rs-copy`: IBAN, amount, reference, reply draft, post text, hashtags, paths.
- The copied string is shown **in full** next to its button. Use the `mono` attribute for IBANs, amounts and paths. The `no-value` attribute is only for text that is already visible right beside the button (the post text inside a preview).
- No hidden transformations: the clipboard receives exactly the string in the payload (server-side `CF_UNICODETEXT`, no line-ending conversion). If the template composes a string (e.g. post text plus hashtags), the composed string is what is shown, counted and copied.
- Limits: one copy is at most 100 000 UTF-16 code units (server limit); `_starter` caps copy text at 5000 characters.
- Text only. Copying images is not in v1.
- Every `rs-copy` gets a stable `data-copy-id` (e.g. `warn-1-copy-0`), so the copy tests in `fixtures\expect\` can find it.

## 4. Density

- At most 5 actionable items per screen (the presort cap of 5 ⚠️ items). If there are more, the bot prioritises; it does not scroll the person through 20 decisions.
- Golden fixtures fit above the fold at 1500x1000 with no scrolling (usability item U1).
- Summarize noisy source material before it reaches the window; keep each template focused on decisions.
- Empty sections are not rendered.

## 5. German strings and Vienna time

German and Europe/Vienna are the current built-in defaults; both become configurable later. <!-- rename -->

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
- Images go through the media roots:
  - The payload holds an absolute Windows path in a field the template's `schema.json` marks with `"x-rs-media": true`.
  - At `show` the path must resolve (after realpath) under one of the configured media roots or the selected data directory's `media` folder.
  - Allowed: `.png .jpg .jpeg .webp .gif`, at most 20 MB, the file must exist. Relative paths, `..`, UNC paths and paths outside the roots are rejected with exit code 2.
  - The page never sees the path, only a random media id: `RS.media(id)` for `img.src`, `RS.reveal(id)` for `Im Explorer zeigen`.
  - A bot on another machine copies the image to `<host>` first (section A, step 1: drop folder) and puts the `<host>` path into the payload. Never a path that exists only on the bot's machine.

## 7. Accessibility

Checklist (spec 5.2). The core already gives `lang="de"`, visible focus, token contrast and the keyboard map; templates must not break them.

- [ ] Every control has an accessible name: a `<label for>` filled by `data-rs-t`, or `data-rs-t-aria-label`; `rs-action-row` gets a `label` (e.g. `RS.t('choice_group_label', {what: ...})` = `Entscheidung: ...`).
- [ ] Every image has alt text (payload `alt`, or `data-rs-t-alt`).
- [ ] Focus stays visible: do not override `outline` (the core draws at least 2 px with contrast at least 3:1).
- [ ] Colours only from `--rs-*` tokens (the token pairs for text meet WCAG AA, at least 4.5:1, in light and dark). No colour literals.
- [ ] No positive `tabindex`.
- [ ] Choices use `rs-action-row` (`role=radiogroup`, arrow keys), not home-made radio buttons.
- [ ] The whole flow works with the keyboard only: `Tab`/`Shift+Tab`, `Enter`/`Space`, arrow keys in a choice row, `Ctrl+Enter` sends, `Esc` closes a dialog, `Alt+1..9` switches reports. `fixtures\expect\golden.json` `keyboard` proves it.
- [ ] Status changes are announced through the core toast (`RS.toast`, `aria-live`), not by custom alerts.
- [ ] Animations respect `prefers-reduced-motion`.

## 8. Results

- Design `result.schema.json` **first**, then the UI. Keep it small: use enums for choices and give free-text fields a `maxLength`. Example (`_starter`): `{"choice":"erledigt","note":""}`.
- Bots read **only** the result file identified by `result_path` in the `show` or `wait` output. Never scrape the page, the run store or the action log.
- A result file is written once, atomically, and never changes. Its `data` was validated against `result.schema.json` before it was written.
- Wait in short slices: agent runtimes often cap a single shell call (e.g. at a few minutes). Call `wait --timeout <s>` with a timeout below that cap and repeat it while it exits 5 (each repeat may be a new shell call); never one long blocking call (section A, step 3).
- Act on `status`:

| `status` | Meaning | Bot does |
|---|---|---|
| `submitted` | the person sent it (`An Bot senden` or Ctrl+Enter) | executes `data` |
| `cancelled` | the person discarded it (`Verwerfen`), or the bot ran `cancel` | nothing; at most one chat line if the topic is still open |
| `expired` | `expires_minutes` ran out (default 240, max 10080) | nothing; re-show later only if it still matters |

- Payload hygiene: never put secrets (passwords, tokens, full card numbers) or full email bodies into a payload. Use snippets of at most 600 characters. At server startup, direct files in `runs`, `results`, and `log` older than 30 days by modification time are removed. Media, browser profiles, configuration, and nested files are retained.
- One open report per topic: when a newer report replaces an open one, `cancel` the old run first.

## 9. Adding a template

1. Branch: in `<repo>`, create the branch `tpl/<name>` from `main`.
2. Copy the starter (from the repository root):

   ```
   py -3 report_shell.py new <namespace>/<name>
   ```

   `<namespace>` is your bot id (e.g. `example-bot`). This copies `templates\global\_starter` to `templates\<namespace>\<name>` and sets `id`, `namespace` and `title_de` in `template.json`. Exit 7 if the name exists or is invalid. Template ids are unique across all namespaces.
3. Edit, following `templates\global\_starter\README.md`:

| File | Rules |
|---|---|
| `template.json` | exactly the fields `id` (= folder name), `namespace` (= parent folder), `version` (integer, payloads must send the same), `title_de`, `description`, `components` (only `rs-card`, `rs-action-row`, `rs-copy`, `rs-badge`, `rs-counter`, `rs-post-frame`, `rs-confirm`), `strings` (every `de.json` key used) |
| `template.html` | a partial: no `<html>`, `<head>`, `<body>`, `<script>`, `<link>`, `<style>`; no literal text; no `on*=` handlers; custom elements only from the list above |
| `template.css` | `var(--rs-*)` tokens only; no `#hex`, `rgb(`, `hsl(`; no URLs |
| `template.js` | the body of `function (RS, root)`; RS API only (`RS.data`, `RS.run`, `RS.t`, `RS.time`, `RS.count`, `RS.copy`, `RS.toast`, `RS.media`, `RS.reveal`, `RS.setResult`, `RS.setStatus`, `RS.setSubmitLabel`, `RS.onChange`, `RS.draft`, `RS.submit`); never `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `eval`, `new Function`, `import()`, `navigator.clipboard`; no literal UI strings; block comments only |
| `schema.json`, `result.schema.json` | only `type, properties, required, additionalProperties, items, minItems, maxItems, uniqueItems, enum, const, minLength, maxLength, pattern, minimum, maximum, oneOf, default, description, x-rs-*` |
| `fixtures\` | `golden.json`, at least 2 `edge-*.json`, at least 2 `invalid-*.json` (each must be rejected) |
| `fixtures\expect\golden.json` | `copies` (by `data-copy-id`), `counters` (by `data-counter-id`), `flow` (mouse steps), `keyboard` (keys only), `result` (the exact result `data`) |
| `README.md` | purpose, payload example, result example, German strings used |

4. New German strings: a template branch never edits `core\` (that includes `core\i18n\de.json`). Ask the maintainer of the installation to add the shared key (English key, German value) to `de.json`; `check` fails until the key exists there, then list it in `template.json` `strings`.
5. Test until it passes:

   ```
   py -3 report_shell.py check <name>
   py -3 report_shell.py check <name> --visual
   ```

   Exit 0 = pass, 7 = fail (the findings are on stderr). `--visual` compares screenshots of the golden and every edge fixture, light and dark, at 1500x1000, with `golden\<fixture>.light.png` / `.dark.png` (at most 1% differing pixels).
6. **Golden approval rule:** golden images are recorded with `node tools\visual.mjs --update <name>` **only after the person or the maintainer has approved the screenshots**. Never re-record goldens to make a failing `--visual` pass.
7. Commit on `tpl/<name>` and ask the maintainer to merge. The maintainer merges only with a passing `check --all --visual`. A broken template (duplicate id, missing file, namespace not matching the folder) stops the server from starting for every bot, so never merge one.

## 10. Anti-patterns

- Opening report HTML via `file://`, `Invoke-Item`, `Start-Process <url>`, `start <url>`, `os.startfile` or `webbrowser.open` (that opens a tab in the default browser). Only `report_shell.py show` / `open` open the window.
- Starting `msedge.exe` or `chrome.exe` yourself, or a second window per update. One window; new runs arrive over SSE.
- Editing the core (`core\`, `tokens.css`, components, `rs.js`) from a template, or copying core CSS into a template.
- Colour literals in template CSS. Literal German text in `template.html` or `template.js`.
- `//` comments in `template.js` (the URL lint fails).
- Preselected choices, more than 3 choices per item, more than 5 items per screen.
- Full email bodies or secrets in the payload.
- Building the result path by hand instead of using `result_path`; reading the action log; parsing the page.
- `wait` without `--timeout` in a bot shell, or a timeout above the runtime's shell-call cap; polling the result file in a tight loop.
- A payload or image path that exists only on the bot's machine, not on `<host>`.
- `--data -` from Windows PowerShell 5.1: the pipe re-encodes the JSON and umlauts arrive as `?` (verified). Use a file.
- Parsing the page or the action log instead of the result file (`result` stdout is fine: it is ASCII-only JSON, non-ASCII characters are `\u` escapes).
- Reusing a `run_id`. Leave `run_id` out and let the core generate it.
- Using `--focus` by default, or `--port 18742` and the real data dir in tests (tests use `RS_DATA_DIR` and another port).

---

## A. Worked example with `_starter`

`_starter` (`templates\global\_starter`) shows one message, an optional value to copy, one required choice, and an optional note. Result `data` is `{"choice":"erledigt","note":""}` or the same shape with choice `spaeter`.

### Step 1: the payload file

Write it as UTF-8 (without BOM preferred; one leading BOM, as written by `Set-Content -Encoding UTF8`, is accepted and stripped). On `<host>` in PowerShell: `[IO.File]::WriteAllText($path, $json, (New-Object Text.UTF8Encoding $false))`.

**Drop folder (bot on another machine):** `show --data` reads a path on `<host>`, and media paths must exist on `<host>`. A bot that runs on a different machine than the window first copies the payload file and any images to a drop folder on `<host>` (e.g. `%USERPROFILE%\Downloads`, a media root), with whatever file-transfer tool its runtime offers, puts the `<host>` image paths into the payload, then runs `show --data <host path>` on `<host>`.

```json
{
  "schema": "report-shell/payload@1",
  "template": "_starter",
  "version": 1,
  "bot": "example-bot",
  "title": "Sicherung prüfen",
  "created": "2026-10-08T10:39:00+02:00",
  "expires_minutes": 240,
  "data": {
    "message": "Die Sicherung ist abgeschlossen. Bitte die Kontrolle bestätigen oder auf später schieben.",
    "copy": {
      "label": "Pfad kopieren",
      "text": "\\\\files.example.invalid\\backup\\nightly.log"
    }
  }
}
```

`run_id` is left out on purpose: the core generates one (`<YYYYMMDD>-<HHMMSS>-<bot slug>-<4 hex>`, e.g. `20261008-103901-example-a1b2`; the slug drops a trailing `-bot`).

### Step 2: show

Every `report_shell.py` command runs **on `<host>`**: the window, the server and the result file all live there. A bot on another machine runs the commands through its runtime's remote shell on `<host>` (addressed by `<machine-id>` or however the runtime names it), not in its own shell. The window and server survive the end of the shell call.

```powershell
py -3 report_shell.py show _starter --data "$env:USERPROFILE\Downloads\starter-20261008-1039.json"
```

stdout (one JSON line; returns at once):

```json
{"run_id":"20261008-103901-example-a1b2","url":"http://127.0.0.1:18742/?run=20261008-103901-example-a1b2","result_path":"<data dir>\\results\\20261008-103901-example-a1b2.json"}
```

Keep `run_id` and `result_path`. If exit is not 0, read stderr (English, one line that identifies the invalid field), fix the payload, and do not retry blindly. The core keeps its own copy of the payload, so the bot may delete the payload file after a successful `show`.

Then one chat line: `Im Fenster: Sicherung prüfen`.

### Step 3: wait

`wait` blocks the shell call until the result exists. Agent runtimes often cap a single shell call (e.g. at a few minutes), so always give a timeout below that cap and call `wait` again after exit 5:

```powershell
py -3 report_shell.py wait 20261008-103901-example-a1b2 --timeout 120
```

- Exit 0, stdout: `{"status":"submitted","result_path":"<data dir>\\results\\20261008-103901-example-a1b2.json"}`.
- Exit 5 (stderr `report-shell: timeout waiting for run: ...`): the person has not decided yet. Do other work and call `wait` again later.
- Any other non-zero exit (6 = unknown run, 1 = crash): stop; do not read or guess a result file.
- Non-blocking check instead: `result <run_id>` returns exit 0 with the envelope, or exit 6 while there is no result yet.

The run cannot stay open forever: after `expires_minutes` (here 240) the running server writes an `expired` result (after a reboot of `<host>`, at the next server start).

### Step 4: read the result file

```powershell
$result = Get-Content -Raw -Encoding UTF8 '<data dir>\results\20261008-103901-example-a1b2.json' | ConvertFrom-Json
$result.status
$result.data.choice
$result.data.note
```

The file (pretty-printed here; on disk it is one line):

```json
{
  "schema": "report-shell/result@1",
  "run_id": "20261008-103901-example-a1b2",
  "template": "_starter",
  "template_version": 1,
  "bot": "example-bot",
  "status": "submitted",
  "created": "2026-10-08T10:39:00+02:00",
  "decided": "2026-10-08T10:44:12+02:00",
  "duration_s": 312,
  "log": "<data dir>\\log\\2026-10-08.jsonl",
  "data": {
    "choice": "erledigt",
    "note": "Kontrolle abgeschlossen"
  }
}
```

### Step 5: act

The bot executes the selected choice itself (`erledigt`: continue after the completed review; `spaeter`: defer it). For `cancelled` or `expired` it does nothing.

The same flow as one PowerShell block, for a bot running directly on `<host>`, from `<repo>`, whose runtime allows one long shell call:

```powershell
$show = py -3 report_shell.py show _starter --data $payloadPath | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "show failed: $LASTEXITCODE" }
do {
    $waitOut = py -3 report_shell.py wait $show.run_id --timeout 120
    $code = $LASTEXITCODE
} while ($code -eq 5)
if ($code -ne 0) { throw "wait failed: $code" }
$result = Get-Content -Raw -Encoding UTF8 -ErrorAction Stop $show.result_path | ConvertFrom-Json -ErrorAction Stop
```

(If the runtime caps a single shell call, do not loop inside one call: call `wait --timeout` again in a new shell call after each exit 5.)

---

## B. Commands

`--port N` works before or after the command (default: `config.json` `port`, else 18742). Normal output is one JSON line on stdout; errors are one English line on stderr.

| Command | Output | Exit codes |
|---|---|---|
| `show <template> --data <path\|-> [--focus] [--no-window]` | `{"run_id","url","result_path"}`. Validates, starts the server if needed, registers the run, opens the window if none is open (`--no-window`: never). `--data` may also hold only the `data` object; the core then wraps it (title = template `title_de`, `created` = now, `bot` = the template's namespace, or a built-in default bot id for `global` templates <!-- rename -->). | 0, 2, 3, 4 |
| `wait <run_id> [--timeout <s>]` | `{"status","result_path"}` once the result file exists (checked every 200 ms; timeout 0 = no limit, never use 0 from a bot) | 0, 5, 6 |
| `result <run_id>` | the result envelope | 0, 6 (also while no result exists yet) |
| `status` | `{"up","port","pid","open_runs","window_alive"}` | 0 |
| `open` | `{"ok":true,"opened":true\|false}`; opens or focuses the window when runs are open | 0, 3, 4 |
| `cancel <run_id>` | `{"status":"cancelled","result_path"}`; bot-side withdrawal | 0, 6 (unknown or already decided) |
| `list` | `[{"id","namespace","version"}, ...]` | 0, 7 (broken registry) |
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
| 5 | `wait` timed out | call `wait` again later |
| 6 | unknown run (`wait`, `result`, `cancel`), no result yet (`result`), or already decided (`cancel`) | check the `run_id`; for `result`, try again later |
| 7 | `check` failed, `new` name exists or invalid, broken template registry | fix the template |

## D. Envelopes

Payload `report-shell/payload@1` (max 2 MB; unknown top-level fields are rejected):

| Field | Rule |
|---|---|
| `schema` | `report-shell/payload@1` |
| `template` | a registered template id (`list`) |
| `version` | integer, equal to the template's `version` |
| `run_id` | optional; `^[0-9]{8}-[0-9]{6}-[a-z0-9-]{1,20}-[0-9a-f]{4}$`, unused. Best left out. |
| `bot` | your bot id, `^[a-z0-9-]{1,40}$` (e.g. `example-bot`) |
| `title` | 1-80 characters; becomes the window title (`<title> · <bot name>`; the display name comes from `core\bots.json`, which moves to user config later) <!-- rename --> |
| `created` | ISO 8601 with an offset |
| `expires_minutes` | optional, 5-10080, default 240 |
| `notify` | optional `{"webhook_url"}`; the webhook is **off in v1**, bots use `wait` |
| `data` | validated against the template's `schema.json` |

Result `report-shell/result@1`: `schema`, `run_id`, `template`, `template_version`, `bot`, `status` (`submitted` \| `cancelled` \| `expired`), `created`, `decided`, `duration_s`, `log`, and `data` (only for `submitted`). Example in section A, step 4.

---

## Deviations from the spec

- All CLI output (stdout and stderr) is pure ASCII: JSON escapes non-ASCII characters (`\u00e4`), so it survives any console code page. `ConvertFrom-Json` restores them.
- `result` returns exit 6 both for an unknown run and for a known run without a result yet (spec 3.1 lists only 0 and 6).
- `show --data` also accepts a bare `data` object and wraps it in an envelope (not in spec 3.1).
- `list` exits 7, and `open` / `stop` can exit 4, which spec 3.1 does not list.
- A payload file or stdin may start with one UTF-8 BOM, which is stripped; JSON nesting is limited to 64 levels (exit 2 beyond).
- The template lint treats any `//` in `template.html`, `template.css` or `template.js` as a URL, so `//` comments fail (spec 4.4 names only URLs).
- Localised attributes use `data-rs-t-<attribute>`; the template lint rejects literal UI strings in `template.js`.
- `check` also needs `node tools\visual.mjs` for `--visual` (exit 7 if missing) and runs `node tools\e2e.mjs expect <id>` when `fixtures\expect\` exists.
- The `● ` prefix stays while any open run is unread, not only the active one (spec 2.4).
- The clipboard writer uses a message-only owner window (`CreateWindowExW`) while the clipboard is open.
