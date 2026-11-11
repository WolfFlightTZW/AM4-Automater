# Independent AM4Info monitor

Double-click `Start-AM4-Forecast.cmd` in the project root. Leave Steam AM4 open and operate it manually. This launcher starts only the public-data console, not Automater, Runner, a log monitor or CDP. It never changes operator/recovery state. Node.js 24+ is required; PATH or the existing bundled runtime is used. No build or package installation is required.

The dashboard updates countdowns every second in an interactive console. It shows current **predicted** fuel/CO2 prices, next windows below the established ceilings, lowest prices in the next 24 hours (including the current window), Alaska-local times, savings, retrieval freshness/status and accuracy statistics. The publisher provides no source issue timestamp; recent retrieval alone is not proof of prediction accuracy.

Commands (press Enter):

- `refresh`: retrieve now; requests in progress are coalesced and manual requests limited to once per 15 seconds.
- `actual fuel 800` or `actual co2 140`: enter the price currently visible in AM4 in whole dollars per 1,000 units. These are synthetic examples. Manual entries receive timestamps and persist separately from predictions. Identical entries in one window are deduplicated. Without an eligible prediction saved before the transition, the observation is retained but not scored. Five-second transition edges remain excluded.
- `qty fuel 2000000` or `qty co2 500000`: change illustrative savings quantities for the session. Defaults are 1,000,000 individual lbs/quotas. Quantities are not purchases and are not checked against your unobserved inventory/cash. Savings exclude flight delay costs, storage and cash constraints; the baseline is a manual actual price from this window when available, otherwise the current forecast.
- `help`: entry guidance.
- `quit` or **Ctrl+C**: save and stop only this monitor. The game and any separately running controller are untouched.

Launch-time quantities:

```powershell
.\Start-AM4-Forecast.cmd --fuel-quantity 2000000 --co2-quantity 500000
```

Public retrieval reuses the existing monitor's UTC :00/:30 plus five-second deadlines and five-minute failure retry. The one-second display tick does not poll the endpoint every second. Redirected/noninteractive output prints at most once per minute unless a command requests a display. Shutdown waits for any bounded request and local writes to finish.

Files are local and Git-ignored under `Reports/forecast-standalone/`:

- `forecast-accuracy.json`: shared accuracy format plus timestamped manual observations. Comparisons and manual observations are bounded to 800 records each; seven-day pruning applies when new observations are stored.
- `resource-advisory-latest.json`: reused inventory-aware planner output. Game inventory and operational recommendations remain unestablished when no game observations were supplied.
- `snapshots/`: one complete public forecast per half-hour window, retained for seven days. Original snapshot and pre-transition prediction are preserved rather than overwritten by a later refresh.

No aircraft data, credentials or recovery journal is collected. These files are separate from production forecast reports. Keep one standalone window per project to avoid concurrent report writes.

The existing `node harness/forecast-command.mjs` one-shot command remains unchanged. See [FORECAST.md](FORECAST.md) for retrieval, confidence scoring and advisory planner limitations. The standalone console imports the same monitor, normalization, accuracy and planner modules; it adds only console presentation, manual entry and snapshot archiving.
