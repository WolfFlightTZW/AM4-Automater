# Dispatch batches and native operations

Implemented source; live acceptance remains distinct from offline tests. Installing source or running tests does not authorize taking PAUSED/MANUAL ownership or resuming production.

## Pass sequence

1. Read Fleet, schedule and maintenance once. Reconcile existing aircraft uncertainty through the existing recovery rules.
2. Consider landed due aircraft fleet-wide: A-checks first, ordered by remaining hours, then repairs. Existing per-pass maintenance limit remains twenty. Cache current eligibility/hours in the batch snapshot; do not reopen maintenance for healthy aircraft during dispatch. Actual planners, costs and schedule verification remain authoritative for servicing. Reuse an already-visible validated maintenance view instead of reloading it.
3. Reconcile working resource values against the lightweight header. Read only due/unknown resources, coalescing Fuel/CO2 when both are needed. Execute qualifying maximum whole-unit purchases through the unchanged template/transaction verification and reserve guard.
4. Dispatch at most twenty candidates using a supported native group, otherwise the existing serial action path. Cache working inventory from exact game receipts. Revisit resources only for an actual price deadline, a low resource margin, changed/uncertain inventory or a route shortfall. A verified debit does not itself trigger a purchase-screen visit.
5. Reconcile the header at the boundary, update reports and return to Fleet. New arrivals/serviced aircraft are assessed from new game data next pass. No persistent maintenance lifecycle is created.

## Native actions

The operator's latest explicit clarification supersedes the earlier inclusive threshold wording: **A-check <20 hours; repair >20% wear**. Exactly twenty is not selected. The Node policy and final individual guard use these strict boundaries as well, so fallback does not accidentally undo the native filters.

Bulk A-check discovers the visible `Bulk A-Check` control. After its panel loads, `.opa-check[data-id]` cards bind current aircraft IDs; the actual remaining-hour field must be below twenty. Cards at twenty or above are never selected. Existing exclusion, schedule, identity and uncertainty checks still apply. The visible `bulk-check-btn` and `dataCost` quote are rechecked before the native submit.

Bulk Repair discovers `Bulk Repair`, selects the actual twenty-percent dropdown option and dispatches its normal change event. It waits for the result and binds the filtered preview to current IDs using Details links or attribute-addressed rows. A summary-only preview that cannot identify affected aircraft is not treated as proof of selection. Additional/excluded aircraft, changed dropdown/target set, ambiguous cost or disabled controls cause a no-submission fallback. A verified preview uses the native Plan Repair button once.

Every target receives an intent in the existing journal before a group click. The total maintenance cost is reserved once across those intents. Every resulting schedule entry is verified by ID; acknowledgement is not maintenance completion. If submission may have occurred, no individual fallback or second group click is allowed. No new recovery database or transaction state machine is added.

Native Depart All uses the actual Routes #departAll control, labeled Depart N and bound by the game through jQuery. Its explicit route IDs and displayed count define the group. No hardcoded twenty-aircraft cap is imposed on a larger, fully verified native group; the individual fallback retains its configured pass limit. All targets still pass current exclusion, maintenance, duration, resource and enabled-control checks. The individual flight panel supplies actual duration/fuel needs. CO2 uses displayed needs or a labeled 25% margin over a previously verified receipt burn; without either, use serial actions to obtain genuine evidence. Estimates schedule readiness, not fabricate observed consumption. Exact current inventory/header and AM4's enabled actions remain required. Changed route bindings or a displayed count that cannot be reconciled with the handler select the serial fallback; no request URL is constructed.

The observed native button is clicked; no endpoint is called directly and no response script is injected. Verification reads every target row. Only unique inflight rows count as departures. A count/version/header-matching game receipt updates aggregate inventory; missing/inconsistent receipt evidence invalidates inventory. Partial results retain uncertainty only for targets not verified. Guards, exclusive ownership, pause handoff, cash reserve and purchase ceilings are unchanged. Forecasting remains advisory-only.

## Metrics and verification

Per-pass metrics retain bounded observation/read counts, resource screen visits, maintenance and bulk inspection time, navigation time, verified departures/minute and observed backlog reduction. A CO2-only observation still enters through Fuel in the existing adapter; therefore tab/menu visits differ from price-value reads. Purchase-template internal navigation is included in purchase action time but not counted by the resource-inspection counter. Timing categories overlap.

`node --test harness/tests/throughput.test.mjs` covers the real production coordinator, sufficient/low/uncertain stock, price transitions, strict threshold/dropdown/card behavior, bulk acknowledgement, refusal, partial/uncertain results and safe fallback. The twenty-aircraft production-phase test uses one combined market observation, one maintenance assessment and zero per-aircraft resource-screen observations with sufficient supplies. It is a mock, not live backlog clearance.

`resourceReplay()` in `benchmark-throughput.mjs` compares the previous key-change cadence to the current production purchase coordinator against the same synthetic receipts. It reports inspection/menu counts and explicitly modeled duration. Live profile measurements belong in local ignored reports, not fixtures or source. Obtain real post-deployment throughput only during an explicitly authorized normal production session; do not resume a manual pause to manufacture performance evidence.
