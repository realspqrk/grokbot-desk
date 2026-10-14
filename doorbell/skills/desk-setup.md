---
name: desk-setup
description: "Sets up grokbot-desk and the Desk Doorbell webhook on this computer. Use when the person says set me up."
---

# Desk setup

Follow these steps in order when the person says "set me up". Keep each message to one line. A command on this computer shows an approval card unless the person set Always allow. Wait for that approval. Run every desk command in the clone folder.

On Windows the command is `python report_shell.py <arguments>`. On macOS it is `./report-shell <arguments>`. The steps below use the Windows form. On macOS, use `./report-shell` and the same arguments.

1. Ask which system this computer is. Continue only for Windows or macOS. The desk supports those two.

2. Ask where the grokbot-desk clone is. Do not search the disk. If there is no clone, ask for the full path to clone into. Run this, with that path in the quotes:

   `git clone https://github.com/realspqrk/grokbot-desk "<path>"`

   Then run every later command from that folder. If Python 3.11 or newer, or Edge or Chrome, is missing, point the person at the clone's README. That file is the install guide.

3. Ask the person to say yes, then turn on both routines: `desk-doorbell` (webhook) and `desk-update` (weekly). The template created them paused on this account. Do not create a second webhook routine. Two live webhook routines send two messages. If `desk-doorbell` is missing, create it with the text in `doorbell/routines.md` in the clone.

4. Tell the person where to read the address and the key. In the desktop app: Desk Doorbell, then Routines, then the webhook routine. The fields are "POST to" and "key". Only the person can see them. Do not ask for either value in chat. Do not print them.

5. Run `python report_shell.py doorbell setup`. On macOS run `./report-shell doorbell setup`. This opens a setup page in the desk window. The person pastes the address and the key there. The desk saves them and sends a test webhook.

6. The setup page saves the address and the key, then sends a test. `python report_shell.py doorbell` prints `on` when that file is saved. `on` means saved. It does not prove the test reached Grok Bot. Confirm the setup only after `Desk: doorbell test received.` appears in this chat. If it does not, ask the person to check that the routine is on and to check the address and the key, then press Ring a test on the setup page. When the failure is `busy` (a rate limit or a server error), wait a minute and retry. Do not assume a wrong key. When the save worked and the test failed, the page says `Saved. The test did not reach Grok Bot: …`.

7. Ask which bots use the desk. For each one, send one line. Name the clone folder. Tell them the desk skill is `skills/grokbot-desk/SKILL.md` in that clone. Tell them to set `identity.name` to exactly their Grok Bot name. Then run `python report_shell.py doorbell test --to "<exact name>"` with that same name. That bot should receive `Desk: doorbell test.` The wake line always says `report_shell.py`. That skill tells a macOS bot to run `./report-shell` with the same arguments.

If a command fails, report that in one line. Use `status` to see whether the desk is running. Use `paths` when you need the data folder. Use `doctor` when the question is the template registry. Do not invent a fix.

`python report_shell.py doorbell off` turns the doorbell off. Run it only when the person asks.
