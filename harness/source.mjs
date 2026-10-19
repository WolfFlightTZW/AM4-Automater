import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
export function extractBlock(source, name) {
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp('\\$' + safe + '=(@[\'\"])\\r?\\n([\\s\\S]*?)\\r?\\n[\'\"]@'));
  if (!match) throw new Error('SOURCE_BLOCK_MISSING_' + name);
  return match[2];
}
export function readSource(root) {
  const source = readFileSync(join(root, 'AM4-Operations.ps1'), 'utf8');
  const blocks = Object.fromEntries(['marketJs', 'fleetJs', 'maintJs', 'purchaseJsTemplate', 'selectJs', 'departJs', 'plannerJs'].map(name => [name, extractBlock(source, name)]));
  return { hash: createHash('sha256').update(source).digest('hex'), blocks, source };
}
export function renderBlock(block, registration, kind) {
  if (registration && !/^[A-Z0-9]+(?:-[A-Z0-9]+)+$/.test(registration)) throw new Error('INVALID_REGISTRATION');
  return block.replaceAll('$regJson', JSON.stringify(registration)).replaceAll('$kindJson', JSON.stringify(kind));
}
// Declarative capabilities only. Never embed airline observations or use this metadata for eligibility.
export function inventory(source) {
  return {
    sourceHash: source.hash,
    note: 'Adapter inventory only; current operational state comes from AM4. Live evidence belongs in ignored local reports.',
    actions: [
      { action:'MarketInspection',implementation:'$marketJs',verification:'Current UI prices, capacity, holdings and cash',enabled:'read-only adapter' },
      { action:'AircraftInspection',implementation:'$fleetJs',verification:'Current fleet rows and status',enabled:'read-only adapter' },
      { action:'MaintenanceEligibility',implementation:'structural maintenance and schedule readers',verification:'Current identity, location, condition, schedule and available controls',enabled:'current UI and recovery guards' },
      { action:'Repair',implementation:'individual planner and commit adapters',verification:'Exact target and quote, scheduling response and current condition',enabled:'eligible individual maintenance only' },
      { action:'ACheck',implementation:'individual planner and commit adapters',verification:'Exact target and quote, scheduling response and current condition',enabled:'eligible individual maintenance; absence never gates other work' },
      { action:'MaintenanceSchedule',implementation:'structural calendar adapter',verification:'Current aircraft identity, action type and schedule entry',enabled:'unknown layouts are INCONCLUSIVE' },
      { action:'Departure',implementation:'$selectJs + $departJs + inflightList confirmation',verification:'Current eligibility, exact target and observed inflight state',enabled:'authorized production or explicitly selected test' },
      { action:'PurchaseFuel',implementation:'$purchaseJsTemplate',verification:'Fresh bound quote, exact whole-unit quantity and observed inventory/cash deltas',enabled:'naturally qualifying market under operating policy' },
      { action:'PurchaseCO2',implementation:'$purchaseJsTemplate',verification:'Fresh bound quote, exact whole-unit quantity and observed inventory/cash deltas',enabled:'naturally qualifying market under operating policy' }
    ]
  };
}
