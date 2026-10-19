AM4 Automater

START: Double-click Start-AM4.cmd. This explicitly selects AUTOMATIC.
STOP: Double-click Stop-AM4.cmd, or PAUSE / MANUAL in AM4 Operator.cmd.
Wait for SAFE TO USE GAME before operating AM4 manually.

Current operating instructions: README.md
Policies and verified design: DESIGN.md
Tests and developer entrypoints: harness/README.md

Normal post-pass delay: 10 seconds, configured once in
harness/production-settings.json (cycleSeconds).
Pending/uncertain transactions use at least 30 seconds backoff.
A disconnect or lost interface ownership stops safely; no automatic resume.
