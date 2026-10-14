---
name: desk-update
description: "Fast-forwards the grokbot-desk clone once a week, refreshes this bot from doorbell/ in the clone, and reports what changed or what is left. Use for the weekly desk update."
---

# Desk update

Run this once a week, in the clone folder from setup. Keep the report to one line. The refresh below is part of this run. Do nothing else.

On Windows run the Python call remembered at setup, then `report_shell.py update`. That call is `python` when `python --version` reported 3.11 or newer, otherwise `py -3`. On macOS run `./report-shell update`.

The command fast-forwards the clone. It names what is left. Read its output.

- When the clone moved forward, say what changed. Include the branch.
- When nothing moved, say the clone is already current. Include the branch.
- When the output names something left to do, say that in the same line.

Call it the latest release only when the branch is `main`.

After the command returns, read `doorbell/description.md`, `doorbell/skills/getting-started.md`, `doorbell/skills/desk-setup.md`, `doorbell/skills/desk-update.md`, and `doorbell/routines.md` in the clone. Compare those files with your own current routine texts, skills, and description.

Update your routine instructions with your routine tool. Keep each routine's trigger, webhook address, key, and schedule. Never create a second webhook routine. Update your skills and your description too when your tools allow it. Anything you cannot change yourself, name in the same line so the person can paste it. Say which file. Never re-import the template. Never install a second Desk Doorbell.

The routine text is refreshed from the clone on this check. Follow that routine's text exactly on the next ring.

Never force the update. Do not discard local work. Do not switch branches. Do not stop the desk. Do not migrate files. If the command refuses, repeat the reason in that one line and stop. Reasons include a folder that is not a clone, a fixed tag, local changes, missing git, or a git step that did not finish.

A command on this computer shows an approval card unless the person set Always allow.
