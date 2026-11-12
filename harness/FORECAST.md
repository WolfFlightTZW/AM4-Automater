# AM4Info resource planning

For an independent continuously updated console while operating AM4 manually, use `Start-AM4-Forecast.cmd`. See [FORECAST-CONSOLE.md](FORECAST-CONSOLE.md) for commands, quantity configuration, local history and shutdown. It starts no controller or CDP connection.

Production purchasing now includes the approved forecast-aware schedule described below. The standalone console and advisory arithmetic remain read-only. Forecasts never override actual quotes, ceilings, reserve or transaction safeguards, and add no holds. AM4 remains authoritative. The running worker must be restarted through the normal controlled operator procedure to load newly installed source; implementation/testing alone does not deploy it.

## Retrieval

The public monitor at https://www.am4info.com/ calls `https://www.am4info.com/prices-api?day=<UTC day of month>&time=<UTC HH:00 or HH:30>&slots=49`. This is the site's own JSON endpoint, discovered in its public page script, not a documented/versioned API. No authentication, browser, copied site JavaScript, dependencies, or access bypass is used. The implementation independently parses `slots[].day/time/fuel/co2/is_current`.

There are 49 half-hour windows: current plus 24 hours. UTC anchors each window; matching sequential UTC day/time prevents ambiguous month/year rollover. Reports use ISO UTC; display in Alaska with `America/Anchorage` (including DST), never a fixed offset. Missing prices remain null; contradictory ordering, dates, values, content type or schema reject that retrieval. A request crossing a slot boundary is discarded. The endpoint supplies no source issue timestamp: `sourceIssuedAt` is null. Retrieval time does not prove freshness of the publisher's underlying model.

One asynchronous HTTP request is started when due at existing worker observation/pass boundaries, initially and after each UTC :00/:30 plus five seconds. It has a five-second timeout, 64 KiB response bound, no redirect following, and a five-minute retry after failure. Work already in progress coalesces requests. No awaited HTTP, new game navigation, independent controller, or timer is added to the action loop. If a long action/pass delays a boundary, retrieval occurs at the next existing opportunity. Report failures and rejected HTTP promises are isolated from dispatch.

## Outputs and confidence

`Reports/resource-advisory-latest.json` is an overwritten compact planning report; `Reports/forecast-accuracy.json` contains the current public forecast and at most 800 compact prediction/actual comparison rows over seven days. Both are ignored local reports, not a fleet database or recovery ledger. Only price, window, retrieval/observation timestamps and comparison status are retained for accuracy; no aircraft identities or snapshots. Verified consumption samples stay in memory for at most one hour/1,000 departures. No account data goes into Git.

Only prices returned by already-required fresh market reads are sampled. Cached price reuse never counts as another observation. A prediction must have been retrieved at least five seconds before its window starts; predictions for the already-current window cannot validate themselves. Original predictions survive forecast refresh/restart rather than being overwritten with revised predictions. Five seconds at either transition edge are excluded. Unobserved windows become missed five minutes after their end; there is no extra UI inspection to fill gaps. Missing values, misses, exact matches, errors and contradictory actual prices are recorded. Failed retrieval count and latest failure time are retained without raw error text. No historical user-reported matches are seeded.

Confidence is UNPROVEN before six independent transition comparisons per resource, LOW after any retained error, contradictory forecast revision, or when missing/missed windows outnumber exact matches, and otherwise PROVISIONAL after six exact comparisons. Revisions retain the original price and a compact latest-price/revision count. It is never a promise of future accuracy. Stale (>one hour or no current window), failed, missing or untrusted data falls back to `EXISTING_GAME_POLICY_ONLY`. Advisory trust never changes production behavior, even when PROVISIONAL.

The concise `RESOURCE_FORECAST_ADVISORY` log event emits on recommendation/source/confidence/window transitions, not every pass. The compact report refreshes at most once per minute when existing observations/pass boundaries provide an opportunity. Counts represent the examined batch, not an asserted fleet-wide census.

## Planning limitations and configuration

Central defaults live in `harness/settings.mjs`, optionally overridden in `harness/production-settings.json`:

```json
"forecastAdvisory": { "enabled": true, "opportunityCostPerAircraftHour": null }
```

No economic assumption is enabled by default. Setting a nonnegative dollar value allows an explicit scenario estimate of aircraft delay cost; no ticket revenue is inferred. Recommendations above a price ceiling are labeled `requiresPolicyChange` and never executed. All quantity arithmetic preserves whole units, available/projected capacity and the shared $100M cash reserve; both operational resource needs receive budget before strategic allocation.

Operational shortfall uses the existing 75,000-unit gates and route requirements only when supplied from an already-available observation. Production reports resource-only blocked candidates after its normal checks; list candidates do not prove an enabled Depart button or a known route requirement. `confirmedEnabledDepartures` and route-specific consumption remain unknown when existing observations cannot establish them. Gate-restoring quantities are not claimed to guarantee a departure. Existing controls, exclusions, maintenance, duration and transaction checks remain in force.

Strategic output compares the next future below-ceiling window to the current observed price. If current qualified price is no worse, the bulk window is now; otherwise it shows the future window, projected consumption/capacity, quantity and savings. It does not claim the globally optimal 24-hour schedule. A wait recommendation requires credible forecasts and sufficient projected stock through that window. Rates use only verified receipt samples (at least three over at least one minute); before that, projections and delay economics are blank. Current game-price data must belong to the current UTC window; old saved reports are labeled stale and never presented as fresh.

## Standalone check

`node harness/forecast-command.mjs` retrieves the public forecast once and reads only the existing local `Reports/operations-latest.json`. It opens no CDP connection, changes no operator/recovery state, and makes no game actions. It writes the two local forecast reports and prints the advisory. Saved reports may lack prices; absent values stay unknown. A clean clone can run it without runtime initialization or credentials.

The worker observes prices and verified receipts through optional, exception-isolated Runner hooks and publishes advisory reports at normal batch completion. The console and `forecast-command.mjs` cannot submit actions. Production alone attaches the scheduling strategy below; submission/verification and departure safeguards are unchanged.

## Approved production scheduling

`resource-strategy.mjs` independently schedules fuel and CO2 observations and purchase decisions. This is implemented source, not evidence of deployment into an already-running worker. A normal controlled deployment remains required.

Central `resourcePurchasing` defaults can be overridden in `production-settings.json`:

```json
"resourcePurchasing": {
  "enabled": true,
  "absenceMinutes": 30,
  "uncertaintyFactor": 1.5,
  "minimumSavings": 5000,
  "minimumSavingsFraction": 0.1,
  "topUpCapacityFraction": 0.1,
  "maxDeferredMinutes": 30
}
```

These are scheduling preferences, not new price ceilings or transaction quantities. Whenever a purchase is admitted, existing exact maximum whole-unit arithmetic, fresh actual quote binding, enabled-control validation, cash reserve, intent and verification remain intact. A final strategy check occurs against Runner's newly read actual quote before durable intent. No forecast price becomes a transaction quote. Disable `resourcePurchasing.enabled` to retain the previous game-driven scheduling.

Forecast scheduling requires a fresh current window, retrieval status OK and the existing PROVISIONAL accuracy grade (at least six qualifying comparisons; errors, revisions or excessive missed/missing observations lower confidence). It also requires at least three verified receipt samples over one minute. Otherwise it falls back to the existing policy with `FORECAST_UNAVAILABLE`. This deliberately may leave scheduling unchanged on installations lacking sufficient accuracy evidence; no extra game navigation is introduced to manufacture comparisons.

Consumption is the greater of the trailing 15-minute and 60-minute rates, calculated from actual verified aggregate or individual receipts, not an assumed flight count. The session buffer is the maximum of the existing batch resource margin, observed demand for the configured absence interval with uncertainty allowance, and the currently observed batch size times known conservative per-aircraft consumption. It grows when observed demand/composition changes. It is not a guarantee against unlimited absence or a future fleet change. No inventory or fleet registry is persisted.

- Expensive prices and comfortable receipt-accounted reserves: `HIGH_PRICE_HOLD`, with no market opening just because an expensive window starts. The next favorable forecast or reserve risk prompts reassessment.
- A materially cheaper future window: `WAIT_FOR_BETTER_WINDOW` only when projected burn plus the dynamic buffer fits current reserves. Both configured absolute and fractional savings must be met.
- Favorable actual price: `BUY_NOW` once meaningful batch capacity accumulates. Small gaps wait; no per-departure top-ups. Within five minutes of a material predicted increase, `BUY_BEFORE_PRICE_INCREASE` may replenish below the normal capacity trigger when projected savings also meet the absolute material-savings setting.
- Low reserves: `RESERVE_PROTECTION` overrides economic waiting, within actual hard spending limits. A valid expensive quote is not reopened repeatedly before its deadline and cannot authorize a purchase.
- Full storage: `INSUFFICIENT_CAPACITY` until verified consumption or reconciliation changes it. Missing/uncertain inventory: `INVENTORY_RECONCILIATION`.

Reconsideration is bounded by the configured deferral interval and estimated coverage; it runs at existing production opportunities, never delaying dispatch or adding a timer/controller. Current headers and exact receipts remain the authority for cached quantity reconciliation. Manual inventory changes invalidate it immediately. A restart restores no trusted session inventory or demand rate.

`RESOURCE_PURCHASE_PLAN` logs reason/confidence/target-window transitions and stores two compact current plans in `operations-latest.json`. It does not print a new plan for each quantity decrement or archive an operational state history. The older `RESOURCE_FORECAST_ADVISORY` report remains independently advisory, so it may describe options rather than the production decision.
