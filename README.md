# AM4 Automater

One background Node.js controller operates the existing Steam AM4 session through CefSharp CDP. It does not use desktop input, steal focus, open a browser, or log in again.

## Start and stop

- **Start:** double-click `Start-AM4.cmd`. This explicitly requests AUTOMATIC and starts the serialized controller.
- **Stop/manual:** double-click `Stop-AM4.cmd`, or choose PAUSE / MANUAL in `AM4 Operator.cmd`. Wait for **SAFE TO USE GAME** before interacting manually.
- A manual pause survives restarts. Closing the operator window does not change the selected mode.
- Ordinary elevated PowerShell sessions do not require approval. For an actual startup conflict, open **AM4 Process Review.cmd** for read-only process/CDP-client diagnostics; see [operator/README.md](operator/README.md#duplicate-controller-protection).
- Leave Steam AM4 open with its existing CDP endpoint on `127.0.0.1:9222`. Node.js 24+ is required; PowerShell launchers locate PATH or the existing bundled runtime.

The normal delay **after a completed pass is 10 seconds**. Change `cycleSeconds` in **`harness/production-settings.json`**; no script editing is needed. `-CycleSeconds` remains an explicit per-run diagnostic override. Passes never overlap. Broader recovery uncertainty increases the inter-pass wait to at least 30 seconds. An isolated, identity-bound maintenance submission uncertainty holds only that aircraft and reserves its funds; it does not slow the fleet. Disconnect, lost ownership, or competing automation stops the controller safely; resolve the issue and explicitly start again.

A normal pass buys qualifying resources, reconciles uncertain submissions from AM4, performs up to two eligible individual maintenance actions, dispatches up to sixteen eligible aircraft, and updates the high-cycle CSV. Every 16 verified departures, including across pass boundaries, the controller briefly displays Fleet for three seconds. Pause interrupts that display promptly. Unavailable A-check or Repair controls never independently prohibit departure, including return flights above 9% wear. Enabled due A-checks take priority over enabled due repairs, then departure is evaluated. Repairs require wear >9% and an available individual Repair action. Production acknowledges the submission and moves on; AM4 manages maintenance completion. Departure requires an enabled Depart control and all established policy checks.

The exact purchasing, maintenance, reserve, exclusion, and departure rules are defined once in [DESIGN.md](DESIGN.md). Nothing sells or buys aircraft.

## Reports and state

| Path | Purpose |
|---|---|
| `Reports/operations-latest.json` | Current/last pass, action/inspection timings, dispatch counts, duration and measured idle |
| `Reports/operations-history.jsonl` | Optional local pass history; disabled by default |
| `Reports/purchase-decisions.jsonl` | Purchase decisions and explicit skip reasons |
| `Reports/high-hour-aircraft.csv` | One row per current qualifying aircraft, >500 completed cycles |
| `Reports/high-hour-aircraft-status.json` | Exclusions, incomplete/stale details and coverage |
| `harness/state/recovery.sqlite` | Minimal transaction intents, uncertainty, bounded compact summaries |
| `operator/state/operator.sqlite` | Persistent operator mode, exclusive ownership and command leases |
| `logs/production-*.log` | Worker/launcher output |

AM4 is authoritative for operational state. CSV/checkpoint files are rebuildable reports and never determine dispatch or purchasing eligibility. Do not delete a recovery ledger or legacy attempt lock to bypass a hold.

## Recovery and verification evidence

Live maintenance observations, transaction amounts, balances and controller mode belong in ignored local reports and the minimal recovery ledger, not in this source documentation. Consult current AM4 state for operational status; a source checkout must never imply that a particular aircraft is available or that maintenance completed.

See [harness/README.md](harness/README.md) for tests, [harness/ARCHITECTURE.md](harness/ARCHITECTURE.md) for implementation, and [operator/README.md](operator/README.md) for manual handoff. `archive/` contains historical material, not alternate supported launchers. `references/` is preserved unchanged.
## Source control and a new checkout

The private GitHub repository is `WolfFlightTZW/AM4-Automater`. Permanent development/commit/push rules are in [AGENTS.md](AGENTS.md). References, archives, reports, logs, credentials and recovery databases stay local and must never be uploaded.

A source checkout is not a ready-to-run copy of this airline. Build the ignored operator executable from `operator/OperatorWindow.cs` with Windows PowerShell 5.1:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\operator\Build-Operator.ps1
```

For a genuinely new installation with no previous automation/recovery data, initialize empty automation state explicitly:

```powershell
node .\harness\init-runtime.mjs --new-installation --confirm-no-existing-recovery
```

This is offline setup: it starts in PAUSED/MANUAL, performs no game actions, and invents no fleet, inventory or financial state. It refuses existing runtime directories, recovery files, reports, logs or backups. If moving/recovering an existing installation, restore its reviewed recovery/configuration backup instead; never use initialization to bypass missing recovery evidence.

Start explicitly only after reviewing the documented policies and confirming other automation is stopped. Reports are then generated locally from that user's own AM4 UI. The high-cycle CSV generator remains enabled; existing reports and recovery data are never deleted by setup.

Routine SQLite event collection and pass-history accumulation are disabled by default. A specific diagnostic can set `diagnosticReason` in `harness/production-settings.json`; its events remain capped. `retainPassHistory` is an explicit local report opt-in. Existing files are retained, not purged. Purchasing skip reports and the high-cycle CSV remain local outputs.
