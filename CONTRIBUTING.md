# Contributing

Repository: <https://github.com/realspqrk/grokbot-desk>

## Setup and tests

Use Python 3.11 or newer, Node.js 22, and an installed Microsoft Edge or
Google Chrome. The application runtime uses only Python's standard library;
development checks additionally require pytest and playwright-core 1.58.1.
From the repository root:

```bash
python -m pip install pytest
npm install --no-save playwright-core@1.58.1
```

Set `RS_PLAYWRIGHT_CORE` to the installed module entry point. For example:

```bash
export RS_PLAYWRIGHT_CORE="$PWD/node_modules/playwright-core/index.mjs"
export RS_PYTHON=python
```

In PowerShell:

```powershell
$env:RS_PLAYWRIGHT_CORE = (Resolve-Path node_modules/playwright-core/index.mjs).Path
$env:RS_PYTHON = (Get-Command python).Source
```

`RS_PYTHON` selects the Python executable used by Node-based checks. Use the same interpreter that has pytest installed; an absolute executable path is also accepted.

`RS_BROWSER_CHANNEL` is optional. It defaults to `msedge` on Windows and
`chrome` elsewhere. Set it to `chrome` or `msedge` to select another installed
browser. Then run:

```bash
python -m pytest -q
RS_E2E_PORT=18921 node tools/node-tests.mjs all
python tools/lint_src.py
```

`node tools/node-tests.mjs all` runs every Node test file: unit files fully
parallel, files that start a browser at most two at a time
(`--browser-concurrency N` changes that). `node --test tests_js/` also works.

On Windows, `py -3` may be used instead of `python` when the Python launcher is
installed. On macOS, run the same commands from a virtualenv with Python 3.11
or newer (`python3.12 -m venv .venv`; `.venv` and `node_modules` are ignored by
git and by the source lint), with Google Chrome installed and
`RS_BROWSER_CHANNEL=chrome`.

### What CI checks

CI runs on Windows and macOS with Python 3.11 and 3.12. Blocking: pytest,
the source lint, every Node unit test except its timing budgets, and a small browser smoke set
(`node tools/node-tests.mjs gate`: a template renders, the mouse and keyboard
decide flows write their result, discard writes a cancel, the empty state, the
pop-up opens and auto-advances). Advisory (`continue-on-error`, labelled so in
the job): the full browser suite and the unit timing budgets; timing budgets,
burst and pop-up timing tests are flaky on shared runners. A red advisory step does not block a merge;
read it, and fix what it finds that is real.

Use a temporary `RS_DATA_DIR` and distinct ports in `18920`–`18939` for local
server checks. Never use the product port 18742, and never point tests at a
production data directory.

Live window measurements are not part of the public distribution.

See [the guide](docs/GUIDE.md) for operating details.

## Contribution rules

Every change must be generalized and publishable. Do not add organization,
person, machine, account, drive, or bot-specific names. Never put personal,
customer, secret, or production data in templates, fixtures, screenshots, or
logs.

For behavior changes, add a failing test first. Keep changes focused and avoid
new dependencies unless the maintainers approve them.

## Add a template

1. Run `python report_shell.py new example/my-template`.
2. Define the manifest, input schema, result schema, and localized UI.
3. Add synthetic golden, edge, and invalid fixtures without personal data.
4. Run `python report_shell.py check my-template` and the full test suite.
5. Document the template's inputs, decisions, and result shape.

## Release checklist

A release is cut only after the full suite passes on real machines, not only
in CI. On one Windows machine and one Mac (Apple silicon, Google Chrome), on
the commit to be tagged:

- [ ] `python -m pytest -q` passes.
- [ ] `node tools/node-tests.mjs all` passes (the full browser suite).
- [ ] `python tools/lint_src.py` reports no findings.
- [ ] The built-in templates are rendered to screenshots (light and dark,
      German and English) and reviewed by a person on both machines.
- [ ] The blocking CI jobs are green on that commit.
- [ ] `CHANGELOG.md` names the version, and the version is the same in
      `pyproject.toml`, `core/__init__.py` and the README badge.

## Pull request checklist

- [ ] Tests cover the change and pass locally.
- [ ] Templates and fixtures contain only synthetic, publishable data.
- [ ] No secrets, personal paths, generated output, or local data are included.
- [ ] User-facing behavior and known limitations are documented.
- [ ] The change is small enough to review safely.
