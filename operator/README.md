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

## Blocked by unreadable elevated PowerShell processes

`UNREADABLE_PROCESSES_REQUIRE_OPERATOR_ATTESTATION` means Windows could not expose a PowerShell process's command line, or the exact instance has no valid approval. Codex `node.exe` processes are outside this inventory. The guard does not infer that an unreadable process is harmless.

1. Double-click root **AM4 Process Review.cmd** from your normal, non-administrator session. It lists exact PIDs, UTC creation identities, inspection errors and approval status. It then prepares a local review request, valid for ten minutes. It does not change the operator mode or start a controller. For diagnostics without creating a request, run `operator/Review-Processes.ps1 -Diagnostics` or `operator/AM4-Operator.ps1 -Action Diagnostics`.
2. Open Windows PowerShell **as administrator**, under the same Windows account. Run the exact `Review-Processes.ps1 -ElevatedReview` command printed by step 1. This elevates only the inspection workflow; do not run the controller from this administrator terminal.
3. Read each full executable path and command line. Verify its actual purpose. Only for a verified unrelated process, type the exact displayed **UNRELATED <PID>** phrase. Enter cancels. Never approve another AM4 controller, a legacy AM4 script, a browser bot or an unidentified process. Known AM4 scripts and encoded commands are rejected; investigate them separately rather than editing the approval file.
4. The workflow enumerates again and requires the same PID, exact creation timestamp, executable and command fingerprint before atomically saving approval. Missing/inaccessible/terminated/reused/changed instances cancel approval without replacing prior evidence. Insufficient elevation fails closed. If the request expires, return to step 1.
5. Successful review prints **APPROVED_NOT_RESUMED**. Close the administrator terminal. Return to the normal operator panel and select **RESUME AUTOMATIC once**, or explicitly run the normal Start-AM4.cmd. Resume enumerates again before arming AUTOMATIC; production checks again before CDP connection and before submissions. A new or changed blocker requires a new review.

Approvals live only in ignored `operator/state/legacy-exclusion.json`, use schema 2, and bind PID + exact UTC creation timestamp + an elevated-review fingerprint. Approval expires after 24 hours, including while operating: the guard rechecks it before new submissions and stops safely when renewal is required. Old unversioned approvals are not silently upgraded. The bounded request is `operator/state/process-review-request.json`; preparing a new request replaces the previous one. Neither file is transaction-recovery evidence. Do not edit them manually or commit them.

Full commands/executable paths are displayed only in the elevated console, never saved to approvals or routine diagnostics. Diagnostics include provider errors such as `CIM_COMMAND_LINE_UNAVAILABLE`; when Windows returns null, the workflow does not invent a specific access-denied error number. New startup failures include safe process identities/errors in the latest operations report. Existing ownership, mutex, live browser-automation, source and transaction guards still apply; attestation never overrides them.

Resume captures the existing operator-mode revision before process inspection and checks it atomically when arming AUTOMATIC. A later pause or TESTING request wins; `OPERATOR_MODE_CHANGED_DURING_PREFLIGHT` requires a fresh, explicit operator decision rather than an automatic retry.

The current operator executable can use the new central resume check without replacement. Updated window error guidance/timeouts are included in C# source for the next normal rebuild; never overwrite a running panel executable.

The test harness uses these same reviewed approvals; its former blanket `NO OTHER AM4 AUTOMATION` prompt no longer grants a process exception. Explicit per-action maintenance/purchase/departure confirmations are unchanged. The existing no-click passive aircraft probe retains its read-only exception and cannot submit actions.
