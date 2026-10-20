import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Store } from './store.mjs';
import { readSource, inventory } from './source.mjs';
import { Runner } from './runner.mjs';
import {validRegistration} from './identity.mjs';

export const scenarios = ['Offline', 'SelfTest', 'Inventory', 'InspectMarkets', 'InspectAircraft', 'InspectSchedule', 'InspectEligibility', 'Repair', 'ACheck', 'RepairChain', 'ACheckChain', 'ResumeChain', 'Departure', 'PurchaseFuel', 'PurchaseCO2', 'IntegratedPass'];
export function parseArgs(args) {
  const result = { scenario: 'Offline', productionRoot: fileURLToPath(new URL('../',import.meta.url)), output: fileURLToPath(new URL('./results/', import.meta.url)), maxSeconds: 90, waitSeconds: 0, maxActions: 1, steps: ['InspectMarkets', 'InspectAircraft', 'InspectSchedule', 'InspectEligibility'], live: false };
  const names = { '--scenario': 'scenario', '--production-root': 'productionRoot', '--output': 'output', '--registration': 'registration', '--checkpoint': 'checkpoint', '--max-seconds': 'maxSeconds', '--wait-seconds': 'waitSeconds', '--max-actions': 'maxActions', '--steps': 'steps', '--reason': 'reason' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--live') { result.live = true; continue; }
    const name = names[args[i]]; if (!name || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('INVALID_ARGUMENT');
    result[name] = args[++i];
  }
  for (const key of ['maxSeconds', 'waitSeconds', 'maxActions']) { result[key] = Number(result[key]); if (!Number.isInteger(result[key])) throw new Error('INTEGER_LIMIT_REQUIRED'); }
  if (result.maxSeconds < 10 || result.maxSeconds > 300 || result.waitSeconds < 0 || result.waitSeconds > 120 || result.maxActions < 1 || result.maxActions > 3) throw new Error('BOUNDS_INVALID');
  if (!scenarios.includes(result.scenario)) throw new Error('UNKNOWN_SCENARIO');
  if (result.registration && !validRegistration(result.registration)) throw new Error('INVALID_REGISTRATION');
  if (result.checkpoint && !/^[a-f0-9-]{36}$/.test(result.checkpoint)) throw new Error('INVALID_CHECKPOINT');
  if (typeof result.steps === 'string') result.steps = result.steps.split(',');
  if (!result.steps.length || result.steps.length > 6 || result.steps.some(s => !scenarios.includes(s) || ['Offline', 'SelfTest', 'Inventory', 'IntegratedPass', 'ResumeChain', 'PurchaseFuel', 'PurchaseCO2', 'Departure'].includes(s))) throw new Error('INVALID_INTEGRATED_STEPS');
  // Re-proving known actions must be deliberate and traceable, never part of default integrated passes.
  if (['Departure', 'PurchaseFuel', 'PurchaseCO2'].includes(result.scenario) && result.live && !result.reason) throw new Error('REGRESSION_REASON_REQUIRED');
  if (['Offline', 'SelfTest', 'Inventory'].includes(result.scenario) && result.live) throw new Error('OFFLINE_SCENARIO_CANNOT_BE_LIVE');
  return result;
}
export async function main(args) {
  const options = parseArgs(args);
  const offline = ['Offline','SelfTest','Inventory'].includes(options.scenario);
  if (options.live && realpathSync(fileURLToPath(new URL('.', import.meta.url))).toLowerCase() !== realpathSync(join(options.productionRoot, 'harness')).toLowerCase()) throw new Error('LIVE_REQUIRES_CANONICAL_INSTALLED_HARNESS');
  const store = new Store(options.output, { ledgerRoot: offline ? options.output : fileURLToPath(new URL('./state/', import.meta.url)),requireExisting:!offline });
  let runner;
  try {
    const initialization = store.newCase('SourceInventory', 'OFFLINE');
    initialization.startingState = { productionRoot: options.productionRoot }; initialization.actionAttempted = { name: 'ReadSourceAndInventoryOnly', submitted: false };
    let source;
    try {
      source = readSource(options.productionRoot);
      initialization.sourceHash = source.hash; initialization.gameResponse = inventory(source); initialization.endingState = { sourceRead: true }; initialization.result = 'PASS'; initialization.reason = 'SOURCE_BLOCKS_AVAILABLE';
    } catch { initialization.gameResponse = { reason: 'SOURCE_UNAVAILABLE_OR_ADAPTER_CHANGED' }; initialization.endingState = { sourceRead: false }; initialization.reason = 'SOURCE_UNAVAILABLE_OR_ADAPTER_CHANGED'; store.finish(initialization); return 2; }
    store.finish(initialization);
    writeFileSync(join(options.output, 'action-inventory.json'), JSON.stringify(inventory(source), null, 2));
    if (options.scenario === 'Inventory') { console.log(JSON.stringify(inventory(source), null, 2)); return 0; }
    if (['Offline','SelfTest'].includes(options.scenario)) {
      const suiteStarted = new Date().toISOString();
      store.close();
      const flags = options.scenario === 'SelfTest' ? ['--test-skip-pattern=^PRODUCTION CONTRACT'] : [];
      const child = spawnSync(process.execPath, ['--test', ...flags, fileURLToPath(new URL('./tests/offline.test.mjs', import.meta.url))], { stdio: 'inherit', env: { ...process.env, AM4_SOURCE_ROOT: options.productionRoot, AM4_RESULTS: resolve(options.output) } });
      const summaryStore = new Store(options.output);
      try {
        const cases = summaryStore.db.prepare('SELECT data FROM cases').all().map(r => JSON.parse(r.data)).filter(r => r.started >= suiteStarted);
        const summary = summaryStore.newCase(options.scenario + 'Summary', 'OFFLINE');
        summary.sourceHash = source.hash; summary.startingState = { fixtureSource: 'saved PowerShell and synthetic DOM/state fixtures', liveGame: false };
        summary.actionAttempted = { name: 'RunOfflineTests', submitted: false };
        summary.gameResponse = { exitCode: child.status, pass: cases.filter(c => c.result === 'PASS').length, fail: cases.filter(c => c.result === 'FAIL').length, cases: cases.map(c => ({ id: c.id, scenario: c.scenario, result: c.result })) };
        summary.endingState = { productionActionsAttempted: 0 }; summary.result = child.status === 0 ? 'PASS' : 'FAIL'; summary.reason = 'OFFLINE_SUITE_FINISHED'; summaryStore.finish(summary);
      } finally { summaryStore.close(); }
      return child.status ?? 2;
    }
    runner = new Runner(options, source, store);
    const connection = store.newCase('SessionAdmission', 'READ_ONLY');
    connection.startingState = { connected: false }; connection.actionAttempted = { name: 'AcquireControllerMutexAndConnect', submitted: false };
    try { await runner.connect(); connection.result = 'PASS'; connection.gameResponse = { connected: true, exclusion: runner.guard.exclusionEvidence }; connection.endingState = { connected: true }; connection.reason = 'EXCLUSIVE_SESSION_CONNECTED'; }
    catch (error) { connection.reason = /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'CONNECTION_UNAVAILABLE'; connection.gameResponse = { reason: connection.reason }; connection.endingState = { connected: false }; store.finish(connection); console.log(`INCONCLUSIVE: ${connection.reason}`); return 2; }
    store.finish(connection);
    const steps = options.scenario === 'IntegratedPass' ? options.steps : [options.scenario];
    const reports = [];
    for (const step of steps) { const report = await runner.execute(step); reports.push(report); if (report.result !== 'PASS') break; }
    const integrated = store.newCase(options.scenario === 'IntegratedPass' ? 'IntegratedPassSummary' : 'ScenarioSummary', options.live ? 'LIVE_EXPLICIT' : 'READ_ONLY');
    integrated.startingState = reports[0]?.startingState || null; integrated.actionAttempted = { steps, count: reports.length };
    integrated.gameResponse = reports.map(r => ({ id: r.id, scenario: r.scenario, result: r.result, reason: r.reason }));
    integrated.endingState = reports.at(-1)?.endingState || null;
    integrated.result = reports.length === steps.length && reports.every(r => r.result === 'PASS') ? 'PASS' : reports.some(r => r.result === 'FAIL') ? 'FAIL' : 'INCONCLUSIVE';
    integrated.reason = 'BOUNDED_PASS_FINISHED'; store.finish(integrated);
    return integrated.result === 'PASS' ? 0 : 2;
  } finally { runner?.close(); store.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(/^[A-Z0-9_]+$/.test(error.message) ? error.message : 'HARNESS_INITIALIZATION_FAILED'); process.exitCode = 2; });
}
