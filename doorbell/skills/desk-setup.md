---
name: desk-setup
description: "Sets up grokbot-desk and the Desk Doorbell webhook on this computer. Use on the first chat after install, and when the person says set me up."
---

# Desk setup

Follow these steps in order. Keep each message to one line. A command on this computer shows an approval card unless the person set Always allow. Wait for that approval. Run every desk command in the clone folder.

On macOS every desk command is `./report-shell <arguments>`. On Windows, step 2 chooses one Python call. Prefer `python` when `python --version` reports 3.11 or newer. Otherwise use `py -3` when `py -3 --version` reports 3.11 or newer. Every later Windows command is that same call plus `report_shell.py <arguments>`. Where this skill writes `python report_shell.py`, replace `python` with the call you remembered. Name that same call when you introduce work bots. `report-shell.cmd` runs `py -3`. Do not use that launcher here.

1. Check the system by command. Do not ask. Run `cmd /c ver`. When that prints a Windows version, this computer is Windows. When that command fails, run `uname`. When that prints `Darwin`, this computer is macOS. Otherwise say that the desk supports Windows and macOS, and stop.

2. Check the prerequisites by command. Do not ask the person to look.

   Python must be 3.11 or newer. On Windows run `python --version` and `py -3 --version`. Remember the call that reports 3.11 or newer. Prefer `python`. Use `py -3` only when `python` is missing or older than 3.11. Use that call for every later Windows command, and name it when you introduce work bots. On macOS run `python3 --version`. Accept it when it reports 3.11 or newer. `./report-shell` skips `/usr/bin/python3` when that copy is older than 3.11.

   If no Python 3.11 or newer was found, offer one install and wait for approval. Windows: `winget install Python.Python.3.12`. macOS: `brew install python@3.12`. Offer that install only once. On macOS, after that install, check `python3.12 --version`, then `/opt/homebrew/bin/python3.12 --version`, then `/usr/local/bin/python3.12 --version`. Accept any one that reports 3.11 or newer. On Windows, run `python --version` and `py -3 --version` again. If neither reports 3.11 or newer, tell the person to restart Grok Bot. The app keeps the old PATH. Then check again. If there is still no Python 3.11 or newer, stop. Do not install Python a second time.

   Run `git --version`. If git is missing, offer one install and wait for approval. Windows: `winget install Git.Git`. macOS: `brew install git`. If `brew` is missing, point at the clone README once the clone exists, or at https://github.com/realspqrk/grokbot-desk before it does. Offer that install only once. Then run `git --version` again. On Windows, if `git` still cannot be found, tell the person to restart Grok Bot. The app keeps the old PATH. Then check again. If `git` still cannot be found, stop. Do not install git a second time.

   A browser must be Microsoft Edge or Google Chrome. On Windows run this and read the three lines. `True` means the file is there. Line 1 and line 2 are Edge. Line 3 is Chrome.

   `powershell -NoProfile -Command "Test-Path -LiteralPath 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'; Test-Path -LiteralPath 'C:\Program Files\Microsoft\Edge\Application\msedge.exe'; Test-Path -LiteralPath 'C:\Program Files\Google\Chrome\Application\chrome.exe'"`

   On macOS run this. A printed name means that browser is there.

   `test -x "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" && echo edge; test -x "$HOME/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" && echo edge; test -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" && echo chrome; test -x "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" && echo chrome`

   One browser is enough. If none is there, point the person at the README at https://github.com/realspqrk/grokbot-desk. On macOS you may instead offer `brew install --cask google-chrome` and wait for approval. Do not continue while Python, git, or a browser is missing.

3. Ask once for the full path of the grokbot-desk clone, or the full path to create. Do not search the disk.

   If that path is already a clone, run its help. On Windows that is the remembered call with `report_shell.py --help`. On macOS it is `./report-shell --help`. If the help lists `update`, run `update` in that clone. Do not run `git pull` on a clone that has `update`. If `update` exits 7, repeat its reason in one line and stop.

   If the help does not list `update`, this is a beta from before 1.0.0-beta.3. Bootstrap once in that same clone. Run `git -C "<path>" status --porcelain`. The output must be empty. Run `git -C "<path>" symbolic-ref -q HEAD`. It must print a branch. A failure or empty output means the branch is detached. When the status is empty and a branch was printed, run `git -C "<path>" pull --ff-only`. If the status is not empty, or the branch is detached, stop and tell the person in one line. Never re-clone. Never discard work. Never switch branch.

   If the path is not a clone yet, run `git clone https://github.com/realspqrk/grokbot-desk.git "<path>"`. The path in quotes is the destination.

   Then run every later command from that folder. On macOS, confirm `./report-shell --help` works. The launcher finds `python3.12` itself. Do not discard local work. Do not switch branches.

4. Read these files in the clone: `doorbell/description.md`, `doorbell/skills/getting-started.md`, `doorbell/skills/desk-setup.md`, `doorbell/skills/desk-update.md`, and `doorbell/routines.md`. When any of them differs from the text you were installed with, follow the clone's text for the steps that are left. Do not repeat a step that already succeeded. That folder is the source of truth.

5. Ask the person to say yes, then turn on both routines: `desk-doorbell` (webhook) and `desk-update` (weekly). Install created them paused, with new ids. The person picks the day and time for the weekly routine when they turn it on. Do not create a second webhook routine. Two live webhook routines send two messages. If `desk-doorbell` is missing, create that one routine from `doorbell/routines.md` in the clone. For each routine that already exists, first replace its instruction text with the clone's text from `doorbell/routines.md`, using your routine tool. Keep its trigger, webhook address, key, and schedule. Then turn it on. Update your skills and description from the clone the same way when your tools allow it. Name any file you cannot change, in one line, so the person can paste it before setup counts as done.

6. Tell the person where to read the two fields. In the desktop app: Desk Doorbell, then Routines, then the webhook routine. The fields are "POST to" and "key". Only the person can see them. Do not ask for either value in chat. Do not print them. Then run `python report_shell.py doorbell setup`. This opens the setup page in the desk window. The person pastes both fields there. Save writes `doorbell.json` and sends a test ring. When the save worked and the test failed, the page says `Saved. The test did not reach Grok Bot: …`. `python report_shell.py doorbell` prints `on` when the file is saved. `on` means saved. It does not prove the test reached Grok Bot. `busy` means a rate limit or a server error: wait a minute and retry. `refused` means the person checks the address and the key on the page. `unreachable` means no connection.

7. Ask for one work bot's exact name in Grok Bot. Run `python report_shell.py doorbell test --to "<name>"` with that name. That bot should see `Desk: doorbell test.` within a minute. Confirm only from that. A plain test writes `Desk: doorbell test received.` in this chat and can arrive minutes late. Do not wait on that line.

8. Ask which bots use the desk, if you do not already know. For each one, send one line. Name the clone folder. Tell that bot to read `skills/grokbot-desk/SKILL.md` from the clone, and not to keep a pasted copy, so a later update arrives. Tell it to set `identity.name` to its exact Grok Bot name. The desk id must match `^[a-z0-9-]{1,40}$` and be unique. When the slug of that name is not a good id, it chooses any valid unique id, and `identity.name` stays the exact name. On Windows, tell it the Python call you remembered, and to run that call with `report_shell.py` for every command. On macOS, tell it to run `./report-shell`. Then run `python report_shell.py doorbell test --to "<name>"` with that same name. The wake line always says `report_shell.py`. That skill tells a macOS bot to run `./report-shell` with the same arguments.

If a command fails, report that in one line. Use `status` to see whether the desk is running. Use `paths` when you need the data folder. Use `doctor` when the question is the template registry. Do not invent a fix.

`python report_shell.py doorbell off` turns the doorbell off. Run it only when the person asks.
