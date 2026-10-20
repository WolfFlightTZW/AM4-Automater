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

## Duplicate-controller protection

Use **RESUME AUTOMATIC** in the normal operator window, or root **Start-AM4.cmd**. Multiple ordinary PowerShell sessions, including elevated sessions with unreadable command lines, do not require attestation. Their visibility limits remain warnings; the guard never claims that an opaque process is proven unrelated.

The existing operator ownership, command leases and `Local\AM4_Automater_Operations_Singleton` mutex still exclude cooperating controllers and harness sessions. Fresh Windows inventories also block:

- Identifiable known legacy AM4 PowerShell launchers, integrated Node workers and action-capable harness entrypoints. Offline test/inventory entrypoints and filenames merely mentioned as data do not count as execution.
- Another process's live/pending/closing loopback TCP connection to CDP port 9222, even when its command line is unreadable or it is a Node, Python or debugger process. Only the current worker's PID is exempt from the client check; the allowed launcher parent is not exempt. An unresolved TCP owner blocks rather than being assumed harmless.
- Failed or incomplete process/TCP inspection. There is no approval-file override for unavailable inspection.

The Steam listener itself and closed/TIME_WAIT sockets are not competing clients. An observed disconnect resolves that connection evidence; no permanent PID blacklist is created. Known launchers remain conflicts while their current process evidence is present. Browser-automation, source, operator pause/revision, purchasing and transaction-recovery gates are unchanged.

Resume checks before arming AUTOMATIC. Production checks before mutex acquisition, again after acquisition before connecting, and before irreversible submissions. A later manual pause or TESTING selection still wins over a delayed resume inspection. New evidence or inspection loss during operations triggers the existing safe-stop path; it never auto-resumes.

### Read-only diagnostics

Double-click **AM4 Process Review.cmd** (the existing shortcut name is retained), or run `operator/AM4-Operator.ps1 -Action Diagnostics`. The report separates blocking `processes` from nonblocking `warnings`, with exact PIDs, creation times, parent PIDs, reason codes and inspection errors. Raw command lines and executable paths are not saved or printed. Diagnostic inspection does not connect to CDP, obtain ownership, change mode, or write approvals/recovery data.

For a blocker, identify and resolve the specific competing launcher or attached CDP client, then explicitly resume once. A foreign client may be a debugging tool rather than an airline bot; detach that client instead of closing unrelated shells. For an inspection error, inspect the reported phase (STARTUP, TCP or PROCESS), elapsed milliseconds, timeout/output-limit/launch failure and attempt count. Windows CIM queries filter sockets by the CDP remote port and processes by relevant names/current socket owners. A killed query gets at most one bounded read-only retry; a second failure, provider error, incomplete inventory or malformed response still fails closed. No failed inspection authorizes a game action. Resolve the Windows process/NetTCPIP query failure first. Do not bypass ownership, the mutex or transaction holds.

The old 24-hour approvals and guided attestations are retired: local `legacy-exclusion.json` and pending review requests are preserved untouched but no longer read by startup or the harness. New installations do not create approval files. `Review-Processes.ps1 -ElevatedReview` is a compatibility option for diagnostics only; it never grants an exception or starts anything. No daily approval renewal is needed. The current operator executable uses the corrected backend without replacement; future C# rebuilds include updated diagnostic guidance.

### Windows visibility limitation

A standard-user process cannot reliably read an elevated PowerShell script's command line. Process names, image paths, parent PIDs and session IDs alone cannot prove whether it is an ordinary shell or a hidden, idle legacy script. TCP ownership is observable here without elevation and supplies credible active-client evidence, not proof that every hidden process is harmless.

A noncooperating, completely hidden script may be undetectable until it opens CDP. It could also connect between an observation and a submission. Therefore this is layered duplicate-controller protection, not OS-enforced isolation from arbitrary external automation. Keep unsupported legacy bots stopped. An absolute guarantee would require privileged monitoring and/or enforced access to the CDP endpoint; that is outside this lightweight guard. These limits are reported in diagnostics rather than hidden behind automatic approvals.
