# AM4 Automater: implemented design

Implemented architecture. Workspace paths in examples are illustrative.

## Authority and scope

AM4 is authoritative for aircraft, maintenance schedules, flight status, inventory, prices and cash. Operational observations live in memory. Persistent recovery records answer whether this automation may already have submitted a transaction; they do not reconstruct the airline. Reports are informational and never grant eligibility.

One Node.js 24+ worker owns the existing Steam CefSharp CDP session at `127.0.0.1:9222`. PowerShell 5.1 provides launchers and the named-mutex host. There are no npm packages, Selenium, new browser sessions, desktop mouse/keyboard input, focus changes or account operations.

## Operational policies

| Area | Implemented rule |
|---|---|
| Fuel | Strictly below $1,000 per 1,000 lbs; maximum affordable exact whole-unit quantity, including one unit |
| CO2 | Strictly below $150 per 1,000 quotas; same maximum whole-unit rule |
| Reserve | Preserve $100,000,000, including conservative reservations for unresolved spending |
| Purchasing | No minimum lot, required departure count or storage-empty threshold; fresh quote/quantity binding before commit |
| Verification | Exact requested inventory increase; cash debit within floor/ceiling of the exact cost when AM4 displays whole dollars |
| Repair | Individual eligible landed/parked, ungrounded aircraft at base; wear >9%; actual available planner control |
| A-check | Individual eligible aircraft with <=20 hours remaining; prioritize when eligible; never wait for eligibility before doing other work |
| Departure | Unique landed/parked ungrounded identity; wear <=9%; no schedule conflict or uncertain target transaction; A-check hours strictly exceed actual flight duration; both resources >=75,000; verify inflight state |
| Exclusion | Never operate sold N-145; do not treat absent fleet aircraft as available |
| Forbidden | No bulk maintenance, aircraft purchases/sales, instant delivery, trading or account changes |

An individual planner and final commit revalidate identity, quote, current controls, location and cash. Actual AM4 restrictions take precedence over assumed combinations of actions. A failed or uncertain submission is never blindly repeated.

## Controller lifecycle

`Start-AM4.cmd` explicitly requests AUTOMATIC and invokes `Start-AM4.ps1`, which runs `harness/production.mjs`. One awaited loop serializes actions and passes. Default limits remain eight departures, two maintenance submissions and ten fleet-detail inspections per pass, with a 600-second operational budget.

After a completed pass the central setting `harness/production-settings.json: cycleSeconds` defaults to 10 seconds. This is idle time, not a start-to-start period. Unresolved transactions impose at least `recoveryBackoffSeconds` (30 seconds). CDP disconnect, lost ownership, competing controllers, or global recovery failure stops safely. Existing UI stabilization and verification waits are unchanged. Reports record pass duration and measured idle separately.

The existing operator controls provide AUTOMATIC, PAUSED/MANUAL and TESTING. Pause prevents new work and permits verification of a submitted action. SAFE TO USE GAME requires released ownership and expired command quarantine. Stale ownership forces manual mode; expired command tokens cannot click. A pause never resumes itself. A maintenance task may resume production only if it originally interrupted AUTOMATIC and no later operator request superseded that authorization.

Unreadable elevated PowerShell processes require explicit operator inspection, not a blanket exemption. The guided local review binds PID, exact creation time and elevated-inspected identity; it rechecks before approval and resume. Review requests expire after ten minutes; approvals expire after 24 hours and are revalidated before submissions. Review does not arm or start production. Procedure and failure handling are maintained in operator/README.md.

## Transaction journal

`harness/state/recovery.sqlite` uses SQLite WAL, synchronous FULL and indexed target/state queries. Intent is durable before the potentially irreversible CDP send. It contains target identity, action kind, compact quote, target-only pre-action recovery values, submission state, and compact resolution evidence.

PENDING/UNKNOWN records block duplicate target submissions and reserve uncertain spending. Missing or unvalidated production journals fail closed. Records are not expired while uncertain. Proven no-submission, verified purchase/departure, acknowledged scheduling and resolved-current-UI records become bounded summaries. Routine CDP values and full fleet/maintenance snapshots are not persisted. Routine SQLite event collection is off; an explicit diagnosticReason enables at most 2,000 small diagnostic records. Pass history is a local opt-in, disabled by default. Summary caps: 10,000 non-uncertain action records, 2,000 small events and 500 case summaries. Unresolved records are excluded from pruning.

SCHEDULED_VERIFIED means the scheduling transaction was acknowledged, not that maintenance completed. There is no persistent operational maintenance-hold registry: current complete schedule, fleet, condition, and controls govern availability. PENDING/UNKNOWN remain genuine recovery holds. An empty schedule alone never proves submission failure. Identity-matched restored condition can safely retire uncertainty as RESOLVED_CURRENT_UI without claiming historical completion proof. Explicit test chains can still observe completion from minimal checkpoints.

Legacy `state/operations-state.json` and historical attempt locks remain read-only recovery inputs. They are preserved, not erased to force a pass. The pre-migration ledger is retired from active use and retained in a verified rollback archive. Rollback must merge current recovery records before restoring old code; restoring the old ledger alone is unsafe.

## Observation cache and reporting

The in-memory resource cache lasts at most 10 seconds. Repeated valid reads share one observed result. Purchases require forced fresh reads before quote binding and after submission. Irreversible attempts, departure, maintenance submission, disconnect, lost/pause ownership and session close invalidate cached observations. Cash is read again at the production funds guard.

A blanket refresh every ten dispatches was evaluated but is not enabled: the current adapter does not provide a proven bound for every flight's resource debit. Every departure therefore triggers an early invalidation. This avoids predicting game balances or weakening the 75,000 resource gate. Reuse reduces duplicate window navigation between unchanged checks.

Fleet details are a rebuildable report cache across passes. Membership reconciliation removes absent aircraft from CSV output while retaining prior observations for reporting. Pending deliveries without statistics are explicit exclusions, not completion blockers. CSV rows are replaced by identity, filtered to >500 actual completed cycles and sorted descending. A sidecar lists missing, excluded and stale records. Neither file is a transaction journal or eligibility source.

## Evidence and account independence

Current UI observations determine availability, maintenance, dispatch resources and finances. Source metadata describes adapter capabilities only. It never supplies fleet membership, completed-maintenance observations, account balances or purchase history to production decisions.

The intentional N-145 exclusion and explicit operator policies remain in effect. Recovery records retain only the target-specific pre-action values needed to resolve a possibly submitted transaction; their age never proves success or failure. Unknown records must not be deleted as part of documentation or fixture cleanup.

All committed examples and test account data are synthetic. Tests exercise quantity/reserve boundaries, cash-display rounding, exact identity, schedule ambiguity, fleet membership changes and recovery using invented values. Live evidence and unresolved transaction details remain private in ignored local storage and must not be copied into source, public issues or fixtures.

Public-release preparation must audit every historical Git version as well as the current tree. Sanitizing a later commit does not erase older operational information. Keep the existing repository private until a separate publication decision and any required history work are explicitly approved.

## First-installation setup and persistence budget

`harness/init-runtime.mjs` is an explicit offline command for a new installation only. It requires confirmation of no prior recovery, refuses any existing state or evidence of a previous installation, creates validated empty automation journals and manual operator controls, and never connects to AM4. Existing installations must restore recovery rather than initialize over it. Each user's current UI supplies their fleet and report contents.

Persist only (1) minimal duplicate-action recovery evidence, (2) an explicitly requested local report, or (3) a named, bounded diagnostic. Current status, purchase decisions/skip reasons, completed-action summaries and the high-cycle CSV are local operator reports. The fleet-detail checkpoint is limited to the incremental report's needs and never grants operational eligibility. No report, journal or diagnostic belongs in Git.
