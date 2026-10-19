# AM4 operator controls

Open root `AM4 Operator.cmd`. The existing window offers AUTOMATIC, PAUSE / MANUAL and TESTING, and shows active action, last completed action and interface ownership.

**Wait for SAFE TO USE GAME before interacting manually.** A pause stops new work and lets an already submitted action finish bounded verification. A command in flight may delay acknowledgement. Closing the window leaves the selected mode unchanged. A paused worker cannot silently resume.

Resume explicitly arms and starts the Node.js production controller through `Start-AM4.ps1`. TESTING reserves the same interface for the named harness. One owner and the production mutex exclude concurrent workers. Historical scripts must remain stopped.

The separate `operator/state/operator.sqlite` stores automation coordination, not airline state. The executable is `AM4-Operator.exe`; its source is `OperatorWindow.cs`. `control.mjs` manages ownership, heartbeat, command leases and uncertainty quarantine. PowerShell uses `Operator-Library.ps1` and `cli.mjs` against that same record.

A crash or stale heartbeat forces manual mode. Outstanding leases must expire before SAFE is shown. Expired or superseded tokens cannot click. SAFE indicates released interface ownership; an earlier uncertain transaction can still require recovery inspection in `harness/state/recovery.sqlite`.

```powershell
& 'H:\AM4 automate\operator\AM4-Operator.ps1' -Action Pause
& 'H:\AM4 automate\operator\AM4-Operator.ps1' -Action Resume
& 'H:\AM4 automate\operator\AM4-Operator.ps1' -Action Testing
& 'H:\AM4 automate\operator\AM4-Operator.ps1' -Action Status
```

Normal instructions: [README.md](../README.md). Policy and lifecycle details: [DESIGN.md](../DESIGN.md). The control system is unchanged by the compact-ledger migration.
