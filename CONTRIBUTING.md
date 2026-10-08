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
RS_E2E_PORT=18921 node --test tests_js/
python tools/lint_src.py
```

On Windows, `py -3` may be used instead of `python` when the Python launcher is
installed. macOS checks are experimental and advisory; browser launch,
clipboard integration, and native platform behavior are not yet supported.

Use a temporary `RS_DATA_DIR` and distinct ports in `18920`–`18939` for local
server checks. Never use port 18742, and never point tests at a
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

## Pull request checklist

- [ ] Tests cover the change and pass locally.
- [ ] Templates and fixtures contain only synthetic, publishable data.
- [ ] No secrets, personal paths, generated output, or local data are included.
- [ ] User-facing behavior and known limitations are documented.
- [ ] The change is small enough to review safely.
