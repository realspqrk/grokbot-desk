[![CI](https://github.com/realspqrk/grokbot-desk/actions/workflows/ci.yml/badge.svg)](https://github.com/realspqrk/grokbot-desk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue.svg)](https://www.python.org/downloads/)
[![Platforms: Windows | macOS (experimental)](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%28experimental%29-lightgrey.svg)](#platforms)

# grokbot-desk

A local approval window for AI agents.

Optimized for Grok Bot. Works with any agent that can run a command.

Chat is awful for discussing serious work. When a bot needs your decision, a human-friendly window pops up instead. grokbot-desk gives AI agents, including a Grok Bot, a local human-in-the-loop desktop UI: send JSON, review it, and read the decision as JSON.

<!-- PLACEHOLDER: final calm approval-window shot (light, synthetic sample data) comes after the redesign -->
![Hero screenshot placeholder: approval window, light, calm UI](docs/assets/hero.png)

## How it works

1. The agent writes a JSON payload for a template.
2. `show` checks the payload and, on Windows, opens one Edge or Chrome app window on this machine.
3. You decide there. The window keeps one primary action on screen and tucks notes and extra detail away.
4. `wait` blocks until a result file exists, then prints the status and its path. `result` prints the decision JSON.

The window UI is currently German (English table planned).

## Quick start

On Windows, use Python 3.11 or newer and Microsoft Edge or Google Chrome. The runtime uses only Python's standard library; no Python runtime packages need to be installed. Development checks have additional requirements; see [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
git clone https://github.com/realspqrk/grokbot-desk.git
cd grokbot-desk
python report_shell.py --help
```

On Windows, `report-shell.cmd` runs that same entry point with `py -3`.

## Example

This example uses the included `_starter` template.

Save this as `make_payload.py`. It creates `payload.json` with a fresh timestamp:

```python
import json
from datetime import datetime, timezone
from pathlib import Path

payload = {
    "schema": "report-shell/payload@1",
    "template": "_starter",
    "version": 1,
    "bot": "agent",
    "title": "Backup to review",
    "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    "data": {
        "message": "The nightly backup completed. Confirm the review or defer it.",
        "copy": {
            "label": "Copy path",
            "text": "\\\\files.example.invalid\\backup\\nightly.log",
        },
    },
}
Path("payload.json").write_text(json.dumps(payload), encoding="utf-8")
```

Create the payload and open the window:

```bash
python make_payload.py
python report_shell.py show _starter --data payload.json
```

The command returns at once with one JSON line: `run_id`, `url` (on `127.0.0.1`, default port `18742`), and `result_path`. Optional flags are `--focus` and `--no-window`.

After you choose and send, read the outcome:

```bash
python report_shell.py wait RUN_ID
python report_shell.py result RUN_ID
```

Replace `RUN_ID` with the id printed by `show`. `wait` prints `{"status":"submitted","result_path":"..."}` when you submit; other terminal statuses are `cancelled` and `expired`. `--timeout` is in seconds, and `0` waits without a limit. `result` prints the complete envelope. This illustration uses example ids, timestamps, and paths:

```json
{
  "schema": "report-shell/result@1",
  "run_id": "RUN_ID",
  "template": "_starter",
  "template_version": 1,
  "bot": "agent",
  "status": "submitted",
  "created": "2026-10-08T10:39:00+02:00",
  "decided": "2026-10-08T10:44:12+02:00",
  "duration_s": 312,
  "log": "<data-dir>/log/2026-10-08.jsonl",
  "data": { "choice": "erledigt", "note": "" }
}
```

`erledigt` means "done" in this template. `created` and `decided` use Europe/Vienna time, `duration_s` measures time since payload creation, and `log` points to the local action log.

## Templates

| id | What it is for |
| --- | --- |
| `_starter` | A small example card (text, one value to copy, one choice) to copy when you write a template. |

### Planned built-ins

These five generic templates are planned for v1 and are not available in this checkout yet:

- `decide-list` — Approve, reject, or defer several items, with a note for each.
- `approve-one` — Make one yes/no decision, with an optional request for changes.
- `preview-post` — Preview a social post, approve each platform, check counters, and copy text.
- `review-doc` — Read a draft or report and approve it or request changes with comments.
- `pick-option` — Compare two to four options, choose one, and optionally add a note.

`_starter` is available as the scaffold for template authors.

Per-bot identity is planned and not built yet. Each bot can pass its own name, avatar, and accent colour in the payload or in `bots.json`. The rail and header show the bot's avatar and name. The colour is used for that report only, with an automatic contrast check and a fallback to the default accent. A missing avatar falls back to initials.

<!-- PLACEHOLDER: final calm post-preview shot (synthetic sample data) comes after the redesign -->
![Post preview placeholder](docs/assets/post-preview.png)

<!-- PLACEHOLDER: final calm dark-mode approval-window shot (synthetic sample data) comes after the redesign -->
![Dark mode placeholder: approval window](docs/assets/hero-dark.png)

## Writing your own template

```bash
python report_shell.py new example/my-template
python report_shell.py check my-template
```

`new` currently creates `templates/example/my-template` in this checkout. Template validation requires the development tools described in [CONTRIBUTING.md](CONTRIBUTING.md), including Node.js and playwright-core with an installed browser. See the [template guide](docs/GUIDE.md).

## Platforms

Windows is supported: Edge or Chrome opens an app window. macOS is experimental. The data folder is implemented; browser launch, clipboard, and platform tests are unfinished. The macOS CI job is advisory.

## Privacy and security

The server listens only on `127.0.0.1`; the page loads no remote images, fonts, or sites. Payloads, results, and action logs are stored locally. On Windows, the default is `%LOCALAPPDATA%\grokbot-desk`; `RS_DATA_DIR` overrides it, and an existing legacy data folder is reused when the new folder is absent. The optional webhook is disabled by default. When enabled and configured with a key, it sends run status metadata, including the local result path, to an allow-listed HTTPS URL. At server startup, files in `runs`, `results`, and `log` with modification times older than 30 days are removed; media and browser profiles are retained.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE).

## Closing note

Dear Grok Bot team: please steal this repo and build it in natively. The MIT license makes that easy.
