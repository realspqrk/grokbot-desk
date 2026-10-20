# AGENTS.md

Instructions for coding agents working in this repository. Human contributor
rules live in [CONTRIBUTING.md](CONTRIBUTING.md). Commands and envelopes are
in [docs/REFERENCE.md](docs/REFERENCE.md). Setup, the test commands, and the
hard rules are repeated here on purpose, so an agent can act without opening
those files. Read them when the work touches their area. This file does not
copy the rest.

## What this is

grokbot-desk is a local desk: a window where a person decides and reads what
bots send. A bot runs `show` with a JSON payload of blocks, the person
decides in one Edge or Chrome app window, and the bot reads the result JSON
(`wait`, `result`, `results`). Python 3.11+ standard library only at runtime;
Windows and macOS.

Entry points: `report_shell.py` (Python), `report-shell` (macOS/POSIX
launcher that finds a Python 3.11+), `report-shell.cmd` (Windows, `py -3`).

## Map

| Path | What |
|---|---|
| `core/cli.py` | CLI: `show wait result results paths status open cancel doorbell doctor check serve stop migrate update` |
| `core/server.py` | `ThreadingHTTPServer` on `127.0.0.1` (product port 18742), API + event stream |
| `core/runs.py`, `core/results.py`, `core/envelope.py` | report store (`runs/`), result files, payload@2 and result@2 envelopes |
| `core/payload.py`, `core/blocks.schema.json`, `core/schema.py` | blocks, the ask rules, and restricted JSON Schema |
| `core/static/ask.js` + `core/static/composer.js` | footer buttons, the banner, the decided line, and the one composer (note + reply chips) |
| `core/static/inputs.js` | input blocks (decide, pick, post): the segmented control or card is the answer; the footer reads its handle |
| `core/static/blocks.js`, `core/static/md.js`, `core/static/charts.js` | block renderers, markdown, charts |
| `core/identity.py`, `core/launcher.py`, `core/launch_coordination.py` | bot identity/avatars, browser app-window launch, burst coordination |
| `core/platform_windows.py`, `core/platform_darwin.py` | OS layer |
| `core/paths.py` | data dir (`%LOCALAPPDATA%\grokbot-desk`, `~/Library/Application Support/grokbot-desk`, `RS_DATA_DIR`) |
| `core/migrate.py` | `migrate` (older Windows data folder) and the server lock that keeps it apart from a starting desk |
| `core/static/` | shell UI: `shell.html`, `rs.js`, `components.js`, `tokens.css`, `shell.css`, `blocks.css`, `count.js` (platform char counting) |
| `core/i18n/de.json`, `core/i18n/en.json` | UI strings; German is default, `RS_LANG=en` |
| `skills/grokbot-desk/SKILL.md` | the skill shipped to bots (public contract, keep in sync with CLI behavior) |
| `tests/` | pytest |
| `tests_js/` | Node tests; `*.e2e.test.mjs` start a headless browser |
| `tools/` | test harnesses: `node-tests.mjs` (runner), `e2e.mjs`, `calm.mjs` (calm-UI checker), `visual.mjs`, `lint_src.py`, `score.py` |
| `tools/dev/` | one-off generators and screenshot scripts, not part of CI |
| `vendor/` | vendored axe-core and third-party licenses; do not edit |

## Commands

Setup (dev only): `python -m pip install pytest` and
`npm install --no-save playwright-core@1.58.1` (there is no `package.json` by
design). Env for Node checks: `RS_PLAYWRIGHT_CORE` = absolute path to
`node_modules/playwright-core/index.mjs`, `RS_PYTHON` = the pytest Python,
optional `RS_BROWSER_CHANNEL` (`msedge` default on Windows, `chrome` elsewhere).

Windows (PowerShell):

```powershell
python -m pytest -q
$env:RS_E2E_PORT=18921; node tools/node-tests.mjs gate
$env:RS_E2E_PORT=18921; node tools/node-tests.mjs all
python tools/lint_src.py
python report_shell.py check payload.json
```

macOS:

```bash
python -m pytest -q                                  # Python suite
RS_E2E_PORT=18921 node tools/node-tests.mjs gate     # CI blocking: unit + browser smoke
RS_E2E_PORT=18921 node tools/node-tests.mjs all      # full suite (release gate)
python tools/lint_src.py                             # source policy lint
python report_shell.py check payload.json          # one payload file
```

Run the narrowest test first, and the full set before you call the work done.
What CI blocks on, and what stays advisory, is in [CONTRIBUTING.md](CONTRIBUTING.md).

## Hard rules

- **Runtime is stdlib only.** `lint_src.py` rejects non-stdlib imports
  (C15a), `webbrowser`, `os.startfile` outside `open_url`, and shell
  `start` or URL launches (C3: no second way to open a browser). No new
  dependencies without maintainer approval.
- **Publishable only.** No organization, person, machine, account, drive or
  bot-specific names, no personal paths, no real data in code, fixtures,
  screenshots, logs or commit messages. This file included.
- **Ports.** Tests use a temporary `RS_DATA_DIR` and ports `18920`–`18939`.
  Never use 18742 and never touch a real data directory.
- **Calm UI.** CSS uses `var(--rs-*)` tokens; spacing only `var(--space-*)`,
  `0` or `1px`. C16-K7a is the lint that rejects any other spacing length.
  Checker limits: [docs/calm-checker-limits.md](docs/calm-checker-limits.md).
- **No literal UI strings** in the page; strings go through `core/i18n`.
- **Golden screenshots** are re-recorded (`node tools/visual.mjs --update`)
  only after a person approved the new screenshots. Never to make a test pass.
- **Fixtures** are payload files in `tests/fixtures/payloads/` with the
  expected answer flow in `tests/fixtures/payloads/expect/`. Invalid
  payloads live in `tests/fixtures/payloads/invalid/`.
- **Version** lives in `core/__init__.py`, `pyproject.toml`, the README
  badge and the README Status line; `CHANGELOG.md` names it.

## Working conventions

- Test first for behavior changes. Prefer end-to-end and contract tests that
  will still matter in a year over granular unit tests; delete tests that
  only lock in implementation details.
- Browser test files run at most two at a time (WSAENOBUFS on shared runners).
  New browser test files are picked up automatically by content
  (`loadChromium` / `chromium.launch`). Smoke-set test names in
  `tools/node-tests.mjs` are exact; renaming such a test means updating `SMOKE`.
- Commits, issues, and branches follow [CONTRIBUTING.md](CONTRIBUTING.md).
  The subject is a lower-case outcome (`fix(popup): say so when the browser
  refuses to close the app window`). Merge and push only on the maintainer's go.
- User-facing text (README, CHANGELOG, SKILL.md, UI strings): plain, short
  sentences, concrete behavior, no internal phase labels or jargon.
- Line endings are LF except `*.cmd` (CRLF); see `.gitattributes`.

## Private working files (gitignored, may be absent)

Maintainers keep local, unpublished notes. If they exist, use them:

- `docs/known.md`: traps that already cost time and the decisions taken.
  **Read before debugging test infrastructure, CI, browsers or platforms.**
  Add an entry when something costs real time. Keep it short.
- `docs/followup.md`: out-of-scope follow-ups, one line each. Remove done
  items.
- `docs/playbooks/`: concise step lists for recurring multi-step tasks
  (release, full test run). Follow them; update them when a step changes.
- `docs/specs/`, `docs/plans/`: design notes and plans.

These paths are ignored by git on purpose; never commit them or copy their
contents into tracked files.
