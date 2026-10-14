# Contributing

Repository: <https://github.com/realspqrk/grokbot-desk>

This file is for a person changing the repository. The hard rules for the code are in [AGENTS.md](AGENTS.md). How to design and build a template is in the [guide](docs/GUIDE.md).

Open an [issue](https://github.com/realspqrk/grokbot-desk/issues) first for anything larger than a fix. Branch from `develop` and target `develop`. Commits follow [Conventional Commits](https://www.conventionalcommits.org/) with a lower-case subject that states the outcome.

## Set up

Use Python 3.11 or newer, Node.js 22, and Microsoft Edge or Google Chrome. CI runs Python 3.11 and 3.12. The application uses only the Python standard library. Tests need pytest and playwright-core 1.58.1. There is no `package.json`. `.venv` and `node_modules` are gitignored, and the source lint skips them.

`RS_BROWSER_CHANNEL` is optional. It defaults to `msedge` on Windows and `chrome` elsewhere.

`check`, including `check --visual`, starts its Node tools with the Python that is running `check`. `RS_PYTHON` overrides that. When `RS_PYTHON` is unset, the tools find Python 3.11+ themselves: `py -3` on Windows; elsewhere `python3.14` down through `python3.11`, then `python3`, also under `/opt/homebrew/bin` and `/usr/local/bin`. Point `RS_PYTHON` at the virtual environment below so pytest and the Node tools use the same interpreter. What `check` prints is in the [guide](docs/GUIDE.md#check).

### Windows

From PowerShell, in the clone:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install pytest
npm install --no-save playwright-core@1.58.1
$env:RS_PLAYWRIGHT_CORE = (Resolve-Path node_modules/playwright-core/index.mjs).Path
$env:RS_PYTHON = (Resolve-Path .\.venv\Scripts\python.exe).Path
```

If activation is blocked, call `.\.venv\Scripts\python.exe` by path and set `RS_PYTHON` to that path. `report-shell.cmd` is the product launcher and needs a working `py -3`. The tests use the virtual environment, not that launcher.

### macOS

Install Python 3.12 and a browser first ([README, macOS setup](README.md#macos-setup)). Python 3.11 or newer works. CI on macOS uses Chrome. Then:

```bash
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install pytest
npm install --no-save playwright-core@1.58.1
export RS_PLAYWRIGHT_CORE="$PWD/node_modules/playwright-core/index.mjs"
export RS_PYTHON="$PWD/.venv/bin/python"
export RS_BROWSER_CHANNEL=chrome
```

## Run the tests

Run the narrowest test that covers your change, and this set before you call the work done.

Windows, from PowerShell:

```powershell
python -m pytest -q
$env:RS_E2E_PORT=18921; node tools/node-tests.mjs gate
$env:RS_E2E_PORT=18921; node tools/node-tests.mjs all
python tools/lint_src.py
```

macOS:

```bash
python -m pytest -q
RS_E2E_PORT=18921 node tools/node-tests.mjs gate
RS_E2E_PORT=18921 node tools/node-tests.mjs all
python tools/lint_src.py
```

| Command | What it runs |
| --- | --- |
| `python -m pytest -q` | The Python suite. |
| `node tools/node-tests.mjs gate` | What CI blocks on: every Node unit test except its timing budgets, then a browser smoke set. The smoke set checks that a template renders, that mouse and keyboard decide flows write a result, that discard writes a cancel, that the empty state shows, and that the pop-up opens and auto-advances. |
| `node tools/node-tests.mjs all` | The local release gate: every unit test and every browser file. |
| `python tools/lint_src.py` | Source policy lint. No findings means pass. |

Browser files run at most two at a time. `--browser-concurrency N` changes that. `node tools/node-tests.mjs browser` is the advisory CI step: the unit timing budgets plus every browser file.

`python report_shell.py check <template>` checks one template. `check --all` checks every installed template. A passing single check prints `"template"`. A passing `--all` prints `"templates"` with the ids. Exit 7 means the check failed. The findings are on stderr.

Use a temporary `RS_DATA_DIR` and ports in `18920`–`18939` when you start a desk from a test. Never use the product port `18742`, and never point a test at a real data folder.

Scripts in `tools/dev/` are local helpers. CI does not run them.

## What CI checks

CI (`.github/workflows/ci.yml`) runs on Windows and macOS, on Python 3.11 and 3.12, with Node.js 22.

Blocking, on both systems:

- `python -m pytest -q`
- `python tools/lint_src.py`
- `node tools/node-tests.mjs gate`

Advisory (`continue-on-error`, so a red step does not block a merge): `node tools/node-tests.mjs browser`. Timing budgets, burst, and pop-up timing are flaky on shared runners, and several browsers on one Windows runner can hit `WSAENOBUFS`. Read a red advisory step and fix what is real. The release checklist below runs `all` on real machines.

## Rules

Follow the hard rules and the working conventions in [AGENTS.md](AGENTS.md). They cover the standard-library runtime, publishable data, test ports, the calm UI, UI strings, golden screenshots, fixtures, and where the version lives. This file does not repeat them. The commit subject rule is above.

For a behavior change, add a failing test first.

## Add a template

The design rules, the file contract, and the `check` details are in the [guide](docs/GUIDE.md). Prefer a built-in. Add a template only when none fits.

1. From the clone, `python report_shell.py new example/my-template`. That copies `_starter` to `<data folder>/templates/my-template`. It does not write into the repository tree.
2. Edit that copy: manifest, schemas, page, and synthetic fixtures. No personal data.
3. `python report_shell.py check my-template`, then the [test set](#run-the-tests).
4. Document the template in its own `README.md`: what the person sees, the payload, the result, the keyboard path, and the files, with strings and test hooks under a final For maintainers heading. Match the section order of the built-in template pages (guide, Template READMEs).
5. A built-in in this repository also has a German review fixture (`edge-de.json`), and its German and English strings use the same placeholders.
6. To contribute it to this repository, agree the destination with the maintainer and copy the files into the tree. A template you only want locally can stay in the data folder.

## Pull request checklist

- [ ] The hard rules in [AGENTS.md](AGENTS.md) are met.
- [ ] A behavior change has a test, and the narrowest tests passed locally.
- [ ] Templates, fixtures, screenshots, and logs contain only synthetic, publishable data.
- [ ] No secrets, personal paths, generated output, or local data are included.
- [ ] User-facing behavior is documented in the README, the skill, the guide, or the template page that already covers that topic.
- [ ] The change is small enough to review.

## Release checklist (maintainers)

A release is cut only after the full suite passes on real machines, on the commit to be tagged. Use one Windows machine and one Mac (Apple silicon, Google Chrome).

- [ ] `python -m pytest -q` passes.
- [ ] `node tools/node-tests.mjs all` passes.
- [ ] `python tools/lint_src.py` reports no findings.
- [ ] The built-in templates are rendered to screenshots (light and dark, German and English) and a person has reviewed them on both machines.
- [ ] The blocking CI jobs are green on that commit.
- [ ] The version matches in `core/__init__.py` (`__version__`), `pyproject.toml` (`project.version`), the README badge, and the README Status line `**Status:** <version>.`
- [ ] The badge doubles the hyphen inside the version (`version-1.0.0--beta.3-blue`). The Status line uses the real version (`1.0.0-beta.3`).
- [ ] `CHANGELOG.md` has a section for that version.
- [ ] The release is a tag on `main`, named `v<version>` (for example `v1.0.0-beta.3`). `main` moves only for a release. `develop` is the integration branch for testing, not the tag target.
