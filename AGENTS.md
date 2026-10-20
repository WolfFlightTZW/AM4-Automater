# AM4 Automater permanent project instructions

Canonical project and Git worktree: `H:\AM4 automate`.
Private GitHub repository: `https://github.com/WolfFlightTZW/AM4-Automater`.
The OneDrive development staging directory is not the production worktree; reviewed changes must be installed and committed from the canonical worktree.

## Required Git workflow for every future development task

1. Inspect `git status` and identify operator/unrelated edits before changing anything. Preserve them; never include them accidentally.
2. Implement the requested source or documentation change, run relevant tests, and review the actual diff and dependencies.
3. Check staged content for credentials, session data, private keys, tokens and generated/runtime files. Test placeholders are allowed only when clearly synthetic.
4. Stage explicit paths belonging to the validated change. Do not use blanket `git add .` or `git add -A`.
5. Create a descriptive Git commit. Push to `origin/main` after every completed, validated source or documentation change. Git synchronization is mandatory for future Codex tasks, not a one-time upload.
6. Verify the push and report the commit hash and push status. If authentication/network/GitHub is unavailable, retain local commits, report the blocker, and retry synchronization safely when available. Never expose credentials in output or store them in project files.
7. Never force-push, rewrite published history, silently discard operator edits, or overwrite a nonempty remote history.
8. Never interrupt AM4 operations solely to synchronize Git. Git work must not request pause/resume or game ownership. Source installation/recovery maintenance follows the existing operator-control procedure independently.

Keep the repository PRIVATE. Verify the authenticated owner and repository privacy before first upload. Use existing authentication; do not place tokens in Git remotes, scripts, commit messages or reports.

## Never track or upload

`references/` (retain locally), runtime SQLite databases/WAL/SHM, recovery/control state, `Reports/`, logs, backups, `archive/`, session evidence, credentials, generated test output, temporary files, compiled operator binaries, or unrelated operator files. `.gitignore` enforces these categories; explicit staging and a staged-file review are still required. Preserve local references, recovery evidence and verified rollback archives during cleanup.

Track maintained production source, launchers, operator source/build tools, tests, synthetic fixtures and current documentation. Restore/build ignored dependencies as documented; do not fabricate a clean recovery ledger on a production installation.

Treat the project as reusable software, not an airline archive. Never embed live aircraft membership, maintenance observations, balances, routes, purchase amounts or account reports in source, examples or tests. Use invented N-TEST* or TEST-* identities and synthetic values. Preserve explicit policies/exclusions such as N-145. Persist only duplicate-action recovery evidence, an explicitly requested local report, or a named bounded diagnostic. Existing runtime/recovery data must never be reset by sanitization or new-installation setup.

## Operational invariants

Read `DESIGN.md`, root `README.md` and `harness/ARCHITECTURE.md`. Keep the existing Node.js/CDP architecture. AM4 is authoritative for operational state. Use background Steam CefSharp CDP only. Do not use desktop input or popups. Do not overlap controllers/tests or silently override PAUSED/MANUAL. Existing price ceilings, exact maximum whole-unit purchasing, $100 million reserve, maintenance thresholds, exclusions and departure safeguards must remain unchanged unless explicitly authorized.

Uncertain submissions are never blindly retried. Do not delete recovery evidence to bypass a hold. During maintenance, resume AUTOMATIC only if it was AUTOMATIC before the maintenance pause and no later operator request superseded it. Otherwise leave manual mode in effect.

## Validation

From the canonical project in PowerShell:

```powershell
$env:AM4_SOURCE_ROOT = 'H:\AM4 automate'
node --test harness/tests/offline.test.mjs harness/tests/purchasing.test.mjs harness/tests/fleet-report.test.mjs harness/tests/recovery.test.mjs harness/tests/layout.test.mjs harness/tests/privacy.test.mjs harness/tests/production.test.mjs harness/tests/fleet-heartbeat.test.mjs harness/tests/batch.test.mjs operator/control.test.mjs operator/process-diagnostics.test.mjs
```

Use meaningful targeted tests for small changes, and broader regression checks for transaction, policy, ownership or launcher changes. Do not submit unnecessary game transactions just to prove known behavior. Report live verification separately from offline tests and code changes.
