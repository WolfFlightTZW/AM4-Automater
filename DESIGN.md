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
| Repair | Individual eligible landed/parked, ungrounded aircraft; wear >9%; actual enabled Repair and planner controls |
| A-check | Individual eligible aircraft with <=20 hours remaining; prioritize when eligible; never wait for eligibility before doing other work |
| Departure | Unique landed/parked ungrounded identity and enabled Depart; unavailable maintenance does not prohibit flight, including wear >9%; no schedule conflict or uncertain target transaction; A-check hours strictly exceed actual flight duration; both resources >=75,000; verify inflight state |
| Exclusion | Never operate sold N-145; do not treat absent fleet aircraft as available |
| Forbidden | No bulk maintenance, aircraft purchases/sales, instant delivery, trading or account changes |

An individual planner and final commit revalidate identity, quote, current controls, location and cash. For each aircraft, an enabled due A-check (<=20 hours) takes priority, then an enabled due Repair (>9% wear), otherwise departure is evaluated. Unavailable maintenance or being away from base never independently grounds an aircraft. After a maintenance attempt the controller moves to another aircraft for the rest of that pass. A due enabled maintenance action deferred by the existing pass budget retains priority rather than being bypassed with a departure. Actual AM4 restrictions take precedence over assumed combinations of actions. A failed or uncertain submission is never blindly repeated.

## Controller lifecycle

`Start-AM4.cmd` explicitly requests AUTOMATIC and invokes `Start-AM4.ps1`, which runs `harness/production.mjs`. One awaited loop serializes actions and passes. Each pass is a rotating batch of at most twenty actionable aircraft, with a 600-second operational budget. The normal launcher permits up to twenty verified departures or individual maintenance submissions within that shared batch bound. Fleet reporting uses at most two detail inspections while the actionable backlog exceeds a batch, otherwise the configured report batch.

After a completed pass the central setting `harness/production-settings.json: cycleSeconds` defaults to 10 seconds. This is idle time, not a start-to-start period. Unresolved purchases/departures, malformed recovery identities or funds evidence, and incomplete maintenance/schedule inspection impose at least `recoveryBackoffSeconds` (30 seconds) while recovery remains pending. Isolated ID-bound maintenance submission uncertainty with a known reserved cost retains only its target hold and funds reservation, without fleet-wide backoff. CDP disconnect, lost ownership, competing controllers, or global recovery failure stops safely. Existing UI stabilization and verification waits are unchanged. Reports record pass duration and measured idle separately.

The existing operator controls provide AUTOMATIC, PAUSED/MANUAL and TESTING. Pause prevents new work and permits verification of a submitted action. SAFE TO USE GAME requires released ownership and expired command quarantine. Stale ownership forces manual mode; expired command tokens cannot click. A pause never resumes itself. A maintenance task may resume production only if it originally interrupted AUTOMATIC and no later operator request superseded that authorization.

Process visibility alone does not establish an AM4 conflict. Exclusive ownership and the mutex remain authoritative for cooperating controllers; identifiable AM4 entrypoints and foreign live CDP clients block operation. Unreadable unrelated sessions are warnings, not mandatory attestations. Process/TCP inspection failures fail closed. See operator/README.md for diagnostics and the Windows visibility limitation.

## Transaction journal

`harness/state/recovery.sqlite` uses SQLite WAL, synchronous FULL and indexed target/state queries. Intent is durable before the potentially irreversible CDP send. It contains target identity, action kind, compact quote, target-only pre-action recovery values, submission state, and compact resolution evidence.

PENDING/UNKNOWN records block duplicate target submissions and reserve uncertain spending. Missing or unvalidated production journals fail closed. Records are not expired while uncertain. Proven no-submission, verified purchase/departure, acknowledged scheduling and resolved-current-UI records become bounded summaries. Routine CDP values and full fleet/maintenance snapshots are not persisted. Routine SQLite event collection is off; an explicit diagnosticReason enables at most 2,000 small diagnostic records. Pass history is a local opt-in, disabled by default. Summary caps: 10,000 non-uncertain action records, 2,000 small events and 500 case summaries. Unresolved records are excluded from pruning.

SCHEDULED_VERIFIED means the scheduling transaction was acknowledged, not that maintenance completed. Production does not track or wait for maintenance completion. There is no persistent operational maintenance-hold registry: current complete schedule, fleet, condition, and controls govern availability. PENDING/UNKNOWN remain genuine recovery holds. An empty schedule alone never proves submission failure. Identity-matched restored condition can safely retire uncertainty as RESOLVED_CURRENT_UI without claiming historical completion proof. Acknowledged production submissions retain compact audit summaries without pre-action condition snapshots. Explicit bounded test chains can opt into a completion-observation checkpoint; they are not a production maintenance lifecycle. A current ID match, complete non-conflicting schedule and condition restored below the repair threshold can retire repair uncertainty even away from base, without asserting who performed the repair or proving its historical completion.

Legacy `state/operations-state.json` and historical attempt locks remain read-only recovery inputs. They are preserved, not erased to force a pass. The pre-migration ledger is retired from active use and retained in a verified rollback archive. Rollback must merge current recovery records before restoring old code; restoring the old ledger alone is unsafe.

## Observation cache and reporting

The resource cache holds only session-local working values. One market observation supplies exact holdings, capacity, prices and each PRICE CHANGE countdown. Cached prices expire conservatively two seconds before the observed countdown ends; missing countdowns fall back to a short refresh interval. Prices are not polled per departure. Purchase checks run at batch boundaries, price refreshes and low/uncertain inventory, using the existing strict ceilings, maximum exact whole-unit quantity and cash reserve. Purchase quotes and verification still force fresh UI reads. Cash is read again at the production funds guard.

Every verified departure updates working fuel/CO2 from AM4's fresh single-flight receipt. Receipt fields must both mutate after the attempt; their version/epoch, one-departure count, exact fuel header delta and CO2 gauge consistency must match. Uncertain/missing receipts invalidate the working totals and require real inventory reads; no debit is invented. Header checks bundled with flight reads detect external inventory changes; pause, disconnect, unknown submission and a new worker invalidate caches. Low inventory (<250,000 of either resource) refreshes early; the existing 75,000 departure gate remains unchanged. The passive in-page receipt observer expires after two minutes idle and performs no actions.

One fleet/schedule/maintenance snapshot supplies a batch. Each departure still selects its unique current row, checks the enabled selected-panel control, actual duration, remaining check hours, exclusions, resources, transaction holds and final process/TCP ownership before durable intent and click. Completion verification reads only that target row and the game's receipt. Individual maintenance revalidates its actual planner/quote and current schedule acknowledgement without repeating fleet snapshots or tracking completion. The informational CSV reuses batch membership; it never grants action eligibility. No persistent inventory or parallel airline state is created.

Fleet details are a rebuildable report cache across passes. Membership reconciliation removes absent aircraft from CSV output while retaining prior observations for reporting. Pending deliveries without statistics are explicit exclusions, not completion blockers. CSV rows are replaced by identity, filtered to >500 actual completed cycles and sorted descending. A sidecar lists missing, excluded and stale records. Neither file is a transaction journal or eligibility source.

## Evidence and account independence

Current UI observations determine availability, maintenance, dispatch resources and finances. Source metadata describes adapter capabilities only. It never supplies fleet membership, completed-maintenance observations, account balances or purchase history to production decisions.

The intentional N-145 exclusion and explicit operator policies remain in effect. Current fleet `flightStatus<ID>`, maintenance `controls<ID>`, schedule links and the flight panel Details link (`routes_main.php?mode=details&id=<ID>`) bind aircraft identities. The enabled `flightInfoDepart<routeID>` control identifies the route, not the aircraft; those IDs must not be equated. Display names need no N-prefix; joins prefer IDs and full-name comparisons never use prefixes. Missing or ambiguous IDs fail closed. N-145 remains excluded by name and by IDs established from current UI rows during the session, never by guessing from the report cache. An already-renamed excluded aircraft cannot be assigned its former identity without verified evidence. Recovery records retain only the target-specific pre-action values needed to resolve a possibly submitted transaction; their age never proves success or failure. Unknown records must not be deleted as part of documentation or fixture cleanup.

All committed examples and test account data are synthetic. Tests exercise quantity/reserve boundaries, cash-display rounding, exact identity, schedule ambiguity, fleet membership changes and recovery using invented values. Live evidence and unresolved transaction details remain private in ignored local storage and must not be copied into source, public issues or fixtures.

Public-release preparation must audit every historical Git version as well as the current tree. Sanitizing a later commit does not erase older operational information. Keep the existing repository private until a separate publication decision and any required history work are explicitly approved.

## First-installation setup and persistence budget

`harness/init-runtime.mjs` is an explicit offline command for a new installation only. It requires confirmation of no prior recovery, refuses any existing state or evidence of a previous installation, creates validated empty automation journals and manual operator controls, and never connects to AM4. Existing installations must restore recovery rather than initialize over it. Each user's current UI supplies their fleet and report contents.

Persist only (1) minimal duplicate-action recovery evidence, (2) an explicitly requested local report, or (3) a named, bounded diagnostic. Current status, purchase decisions/skip reasons, completed-action summaries and the high-cycle CSV are local operator reports. The fleet-detail checkpoint is limited to the incremental report's needs and never grants operational eligibility. No report, journal or diagnostic belongs in Git.

## Bounded performance diagnostics

`operations-latest.json` is overwritten with per-pass timings and counts. Timings include fleet reads, maintenance/schedule inspections, combined resource inspections and separate fuel/CO2 UI timings, purchases, departures and fleet reporting. Action timings include their inspections, so these categories overlap and must not be summed. Counts distinguish examined, fully eligible attempted departures, attempted, skipped, dispatched and deferred candidates. Eligibility is not inferred for unexamined aircraft. Existing pass duration and measured idle remain separate. No additional database event archive is enabled.

Full-fleet inspections are not repeated per departure. Target-specific current controls, identity and flight details are rechecked before a commit; stabilization and durable intent/verification remain mandatory. Reports include per-batch inventory-read/debit counts, navigation milliseconds, action milliseconds excluding navigation, and departures per minute. An uncertain departure ends the batch and retains its target hold before recovery backoff.

## Fleet visual heartbeat

After every 16 verified successful departures, counted in memory across passes within the worker session, production displays the actual Fleet tab for approximately three seconds before continuing. Failed, skipped, unverified and read-only attempts do not count. It runs between completed actions, never during a transaction, and never selects Launch 20. The dwell checks ownership/pause every 100 ms. Missing or ambiguous display controls produce a compact latest-report warning; disconnect or ownership loss follows normal safe-stop behavior. No fleet counts, snapshots or historical UI archive are stored. A worker restart begins a new display counter.
