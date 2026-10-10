# macOS trap status

Platform behavior is implemented and covered by simulated or cross-platform
tests where possible. The following release gates still require a real Mac and
must not be reported as done:

- **M13 — Clipboard contract:** error mapping and exact-byte behavior are
  covered, but native pasteboard type checks for RTF, EPS, empty, and Unicode
  inputs remain unverified.
- **M17 — Restart behavior:** rapid stop/restart and competing-listener behavior
  have POSIX tests, but current macOS `TIME_WAIT` behavior remains a real-runner
  gate.
- **M21 — POSIX paths and open files:** token joins and `F_GETPATH` fail-closed
  behavior are covered; macOS symlink and directory-swap races for GET, reveal,
  and reload remain unresolved.
- **M26 — Real browsers:** all Node tools use `RS_BROWSER_CHANNEL` through the
  shared browser launcher (default `chrome` on macOS and `msedge` on Windows),
  but real Chrome and Edge runs on macOS remain required.
- **M28 — Server signals:** the POSIX stop path waits for child exit before
  deleting temporary state and fails closed otherwise; real macOS `SIGTERM`
  cleanup and recovery evidence remains required.

Other unresolved human-observation gates—focus, geometry, firewall, Gatekeeper,
quarantine, TCC attribution, and same-profile browser handoff—also remain
unverified until a recorded real-Mac acceptance pass.
