# AM4 tests and development

Normal airline operation starts with root `Start-AM4.cmd`; see [README.md](../README.md). The harness shares its action adapters and recovery ledger with production, but requires exclusive TESTING ownership for game access. It defaults to offline checks and does not start production.

## Offline checks

From `H:\AM4 automate`:

```powershell
# Core harness and production-source contract suite, no game connection.
powershell -NoProfile -ExecutionPolicy Bypass -File .\harness\Run-AM4Tests.ps1

# All maintained regression suites, including recovery, reporting and operator controls.
$env:AM4_SOURCE_ROOT = 'H:\AM4 automate'
node --test harness/tests/offline.test.mjs harness/tests/purchasing.test.mjs harness/tests/fleet-report.test.mjs harness/tests/recovery.test.mjs harness/tests/layout.test.mjs harness/tests/privacy.test.mjs harness/tests/production.test.mjs harness/tests/fleet-heartbeat.test.mjs operator/control.test.mjs operator/process-diagnostics.test.mjs
```

`-Scenario SelfTest` omits the named production-contract checks. `-Scenario Inventory` lists source adapter inventory. Offline fixtures are synthetic/saved data, not current AM4. Test output databases are isolated; do not point offline output at the active recovery directory.

## Read-only game inspection

Pause production and wait for SAFE TO USE GAME. Explicitly select ENTER TESTING in `AM4 Operator.cmd`, then choose a named scenario:

```powershell
& .\harness\Run-AM4Tests.ps1 -Scenario InspectMarkets
& .\harness\Run-AM4Tests.ps1 -Scenario InspectAircraft
& .\harness\Run-AM4Tests.ps1 -Scenario InspectSchedule
& .\harness\Run-AM4Tests.ps1 -Scenario InspectEligibility
```

The named mutex and operator ownership exclude production. Legacy scripts/browser bots must also be stopped. Unreadable unrelated shells produce visibility warnings; identifiable AM4 controllers, foreign CDP clients and incomplete process/TCP inspection block connection. Return to PAUSE / MANUAL and wait for release when finished.

## Explicit action scenarios

Repair, ACheck, RepairChain and ACheckChain default to planner inspection. `-Live -Registration <eligible-registration>` enables the individual action only after the harness's exact confirmation phrase. They do not run bulk work. ResumeChain takes an explicit chain checkpoint via `-Checkpoint <UUID>` and only observes recovery; it never resubmits. Normal production submissions do not retain a maintenance-completion checkpoint. Completion waiting is bounded and can be resumed later.

Departure, PurchaseFuel and PurchaseCO2 live regressions require `-Reason` and explicit confirmation. Do not repeat proven irreversible operations merely to demonstrate them. Production uses the existing operating authorization and its policy guards, rather than interactive harness prompts.

## Reports and recovery

Case objects capture observations while running, but persistent case storage is now compact: identity, scenario, times, attempted action, outcome, reason and checkpoint. Routine CDP values/full fleet snapshots are not archived on every call. The shared `harness/state/recovery.sqlite` holds only target-level recovery evidence and bounded summaries. Changing test output does not change that live ledger.

Exit codes: 0 = success, 1 = test assertion failure, 2 = inconclusive/blocked/invalid input. Production refuses missing or unvalidated recovery storage. Never erase a ledger, legacy attempt or UNKNOWN record to force a test to pass.

Current implementation details: [ARCHITECTURE.md](ARCHITECTURE.md). Policies: [DESIGN.md](../DESIGN.md). Historical task sessions, one-off status writers, old test results and raw live evidence have been archived with relocation manifests; they are not alternate controller entrypoints.
