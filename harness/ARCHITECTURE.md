# Harness implementation

This is the technical companion to [DESIGN.md](../DESIGN.md). Operating instructions are in the root [README.md](../README.md); policy values are defined in DESIGN.md rather than repeated here.

## Runtime and modules

Node.js 24+ supplies WebSocket, SQLite and node:test. No npm dependencies or additional browser are required. `production.mjs` is the only supported production worker; `Start-AM4.ps1` is its thin Windows launcher.

| Module | Responsibility |
|---|---|
| `cdp.mjs` | Existing localhost Steam AM4 page; bounded commands, response ID matching, disconnect handling |
| `guard.mjs`, `Lock-Session.ps1` | One controller/test via the Windows mutex; legacy-process exclusion |
| `dom.mjs` | Structural schedule, maintenance/planner, response and flight readers; identity-bound individual commit |
| `source.mjs` | Extract proven JS blocks from root `AM4-Operations.ps1`; source fingerprint |
| `policy.mjs`, `purchasing.mjs` | Eligibility, integer quantities, cost verification and conservative reconciliation |
| `runner.mjs` | Shared actions, fresh checks, intent-before-send and bounded verification |
| `store.mjs` | Compact durable recovery journal; indexed uncertainty queries; bounded summaries |
| `identity.mjs` | Current-DOM numeric IDs, full display names and session-scoped exclusion identity |
| `performance.mjs` | Bounded in-memory per-pass timings, counters and recovery-backoff classification |
| `resource-cache.mjs` | Countdown-bound prices and receipt-accounted session inventory; invalidation, no durable balance ledger |
| `settings.mjs`, `production-settings.json` | Validated central cadence/cache/backoff settings |
| `cadence.mjs` | Awaited inter-pass wait with frequent ownership checks and recovery backoff |
| `fleet-heartbeat.mjs` | Session-only verified-departure counter and interruptible Fleet display between actions |
| `fleet-report.mjs` | Incremental informational CSV and coverage sidecar |
| `main.mjs`, `Run-AM4Tests.ps1` | Offline/read-only defaults; named TESTING scenarios |
| `../operator/` | Existing mode/ownership database, command leases, UI and PowerShell bridge |
| `processes.mjs`, `../operator/process-diagnostics.mjs` | Read-only process/TCP inventory, evidence-based conflicts and visibility warnings |

## Data ownership

AM4 owns airline state. The worker's operational snapshots and resource cache are in memory. The fleet checkpoint is a disposable/rebuildable reporting cache, preserved across passes solely to finish reporting work.

`state/recovery.sqlite` uses schema version 2. `actions` stores minimal transaction recovery evidence and compact acknowledged/terminal summaries. `events` is disabled for routine operation; a named diagnostic can opt into a capped event set, never raw CDP responses. `cases` contains compact case summaries; no full-state JSON is duplicated to per-case files. `metadata` identifies the schema, migration validation and rollback archive.

Queries for unresolved actions use the state index; target holds use `(target,state)`. Only PENDING and UNKNOWN are recovery holds. Target queries include a numeric aircraft ID expression index, so a display-name change cannot bypass an uncertain submission. Acknowledged scheduling is recorded as SCHEDULED_VERIFIED but AM4 determines subsequent maintenance/flight availability. Production stops observing a maintenance transaction once scheduling is acknowledged; it never manages completion. Only an explicitly requested bounded test chain retains pre-action completion evidence. Older checkpoints remain readable and are not cleared by deployment.

Current production/harness entrypoints require an existing migration-validated ledger. They must not silently initialize a replacement when recovery data is missing. Offline fixtures create isolated databases. SQLite WAL and synchronous FULL protect intent-before-send; state changes and optional diagnostic transition events commit atomically. The pre-migration `harness.sqlite` is only in the rollback archive.

## Recovery boundaries

A failed UI read grants no eligibility. An uncertain send retains its intent and funds reservation. Schedule absence alone never means a submission failed. Complete current schedule, stable aircraft ID and restored target condition can establish RESOLVED_CURRENT_UI, distinct from proving the historical transaction completed.

Fresh quotes and actual controls are bound immediately before irreversible work. The operator lease covers CDP execution; stale/expired workers cannot click. A disconnect or ownership loss invalidates resource observations and stops production. A remaining per-aircraft uncertainty blocks that target while unrelated operations remain eligible; inter-pass cadence backs off.

## Observation reuse

Standalone tests retain the short observation TTL. Production keeps session-local working inventory from version-bound single-flight receipts, with fuel-header and CO2-gauge consistency checks. Prices expire at the observed countdown deadline; missing countdowns use the short TTL. Low stock, inconsistent headers, unknown outcomes, disconnect and close invalidate inventory and force real UI reads. Purchases still force fresh quotes and verification. One shared fleet observation serves a rotating twenty-candidate batch; departure completion reads only its target. See DESIGN.md for exact cache and purchase-check cadence.

The ten-dispatch-only strategy is deliberately not active: route consumption is not yet proven sufficiently to retain that observation safely. Early invalidation after every dispatch is currently required.

## Validation and archive boundaries

Migration and live evidence are linked from `Reports/database-migration.json`. Regression coverage includes actual process exit with an open WAL, restart duplicate prevention, illegal transitions, unknown-outcome isolation, CDP timeouts/disconnects, operator handoff, stale ownership, purchase boundaries, current UI reconciliation and serialized cadence.

Historical scripts and task-scoped development sessions under `archive/` are not supported production entrypoints. Reference projects are examples only; they are never imported into the worker. Do not run an archived controller alongside production.

## Persistent data inventory

| Collection | Reason to retain | Bound / default |
|---|---|---|
| Pending/uncertain target intent and recovery evidence | Prevent duplicate irreversible actions and reserve uncertain spending | Never prune unresolved evidence |
| Acknowledged/completed action summaries | Requested local action-outcome report | 10,000 non-uncertain records |
| Compact case summaries | Bounded test/action-result diagnostics | 500 records; no full snapshots |
| SQLite event stream | Specific diagnostic only | Off unless diagnosticReason is supplied; 2,000 events, 2 KiB each |
| Operator control row | Ownership, pause, stale-command quarantine and last completion | Current coordination only; duplicate history collection disabled, old rows untouched |
| Legacy transaction file / attempt evidence | Prevent duplicate actions from older implementations | Read-only compatibility input |
| Latest pass, purchase/skip decisions and controller output | Explicit local operating-status reports | No duplicate balance payload in routine console output |
| Pass history | Optional user report | retainPassHistory defaults false; existing files untouched |
| High-cycle CSV, coverage sidecar and fleet-detail checkpoint | Explicit requested fleet report across bounded scans | Current membership output; checkpoint only for report progress |

New installations initialize their own empty recovery/control state using `init-runtime.mjs`. Existing installations cannot use that command to reset state. No AM4-managed state is seeded from committed fixtures. Collection-default changes are loaded at normal startup; do not restart a running controller solely to install documentation/privacy changes.

Known adapter constraint: maintenance schedule text parsing currently recognizes N-prefixed registrations. Synthetic schedule fixtures therefore use N-TEST identities. Other naming conventions need a separate adapter validation; unrecognized schedule rows remain inconclusive. N-145 remains an intentional configured exclusion, not a remembered fleet observation.

Concurrency uses current process and TCP-owner evidence rather than counts of unreadable shells. The existing ownership and mutex are unchanged. Known AM4 PowerShell/Node entrypoints and foreign active loopback CDP clients block; opaque sessions without AM4 evidence are diagnostic warnings. Incomplete process or network inspection fails closed. The initial inventory is repeated after acquiring the mutex and before submissions. No attestation files are read or written; previously collected approvals remain local and untouched. Command lines stay in memory; safe identities and limitations appear in the requested latest status/diagnostic report only.

Windows cannot prove that every hidden idle elevated script is unrelated, and external clients can connect after an observation. This limitation and the proportionate layered protection are documented in operator/README.md. Stronger guarantees would require privileged monitoring/access enforcement; they are not claimed by this implementation.

Performance data is a single overwritten pass report, not a retained event stream. Timings are inclusive and overlap. See DESIGN.md for cadence classification, identity binding and immediate-observation reuse.
