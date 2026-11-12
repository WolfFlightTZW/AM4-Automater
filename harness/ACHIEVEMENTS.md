# Read-only achievement and bonus-point advisor

Run `node harness/achievement-advisor.mjs` from the project root. It creates timestamped Markdown and JSON reports under ignored `Reports/`, initializes that directory on a clean installation, and never imports CDP, Runner or operator controls. Optional `--balance 100 --target 400` values are user-reported planning inputs, not game observations. `--output` selects another local directory.

The curated catalog currently covers 21 opportunities across interface actions, map discoveries, routes, aircraft purchases, natural milestones and the cargo unlock. It is not an exhaustive game inventory. Catalog IDs are local stable keys, not invented AM4 IDs. Requirements are independently summarized from AM4Info; community BP estimates are separately labeled. The official Steam global list establishes achievement existence/descriptions where exposed, not personal completion or in-game BP. Official support confirms that achievements and flights can award points, but supplies no reward table. Source URLs and research date accompany the catalog. No third-party implementation or page archive is shipped.

Without an explicit AM4 capture, **every personal completion state is unknown**. The report ranks low-effort interface/map candidates first, then routes, purchases and milestones. An unknown or community reward never becomes verified. Airbus near Toulouse is included; this tool cannot tell whether your discovery is complete without evidence. Existing-aircraft route opportunities may be preferable to purchases, but current aircraft, routes and prerequisites must be checked by the operator. The report does not guarantee a path to the target from unknown completion states.

## Safe collection while operating manually

1. Use the existing operator pause and wait for **SAFE TO USE GAME**. Do not run another CDP client while production owns the interface. This advisor never requests ownership or changes mode.
2. Manually open the game's achievement/progression interface. Read the visible name, ID if exposed, explicit completion label, reward, requirements and progress. Do not click claim, buy, spend or change-route controls for collection.
3. Save only those fields locally in `Reports/achievement-capture.json`. Do not save cookies, full DOM/page HTML, session URLs or account headers. Use an ISO collection timestamp and describe the particular visible row/panel in `evidence`. Keep `complete:false` unless every current achievement was actually inspected. Leave missing fields blank and `gameId:null`; do not infer game IDs from catalog IDs.
4. Import with `node harness/achievement-advisor.mjs --capture Reports/achievement-capture.json`. This parses an explicitly supplied observation, not an independent verification of its truth. No navigation occurs. The operator decides when to resume using normal controls.

Synthetic capture format:

```json
{
  "version": 1,
  "source": "AM4_UI",
  "collectedAt": "2030-01-01T12:00:00Z",
  "complete": false,
  "achievements": [{
    "name": "TEST achievement",
    "gameId": null,
    "completionText": "Not completed",
    "rewardText": "10 BP",
    "requirementText": "Synthetic requirement",
    "progressText": "0 / 1",
    "evidence": "Synthetic visible achievement panel"
  }]
}
```

Only explicit `Completed`, `Not completed` or `Incomplete` labels establish completion; ambiguous/locked states remain unknown. Only a standalone numeric `BP` / `bonus points` reward is parsed as observed BP. Duplicate names or game IDs are rejected rather than merged. Unmapped observations are retained with unknown category. Raw whitelisted field names/values and timestamps remain in the local report. No achievement data enters the recovery ledger, purchasing policy or source configuration.
