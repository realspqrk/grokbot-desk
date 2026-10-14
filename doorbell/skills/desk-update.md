---
name: desk-update
description: "Fast-forwards the grokbot-desk clone once a week and reports what changed or what is left. Use for the weekly desk update."
---

# Desk update

Run this once a week, in the clone folder from setup. Keep the report to one line. Do nothing else.

On Windows run `python report_shell.py update`. On macOS run `./report-shell update`.

The command fast-forwards the clone. It names what is left. Read its output.

- When the clone moved forward, say what changed. Include the branch.
- When nothing moved, say the clone is already current. Include the branch.
- When the output names something left to do, say that in the same line.

Call it the latest release only when the branch is `main`.

Never force the update. Do not discard local work. Do not switch branches. Do not stop the desk. Do not migrate files. If the command refuses, repeat the reason in that one line and stop. Reasons include a folder that is not a clone, a fixed tag, local changes, missing git, or a git step that did not finish.

A command on this computer shows an approval card unless the person set Always allow.
