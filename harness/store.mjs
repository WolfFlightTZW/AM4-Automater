import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
export function sanitize(value) {
  if (typeof value === 'string') return value.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[URL REDACTED]')
    .replace(/\b(?:steam(?:id|ticket)?|(?:access[_-]?)?token|session(?:id)?|cookie|authorization|password|secret)\s*[:=]\s*[^\s,;]+/gi, '[SECRET REDACTED]')
    .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g, '[EMAIL REDACTED]')
    .replace(/\b7656119\d{10}\b/g, '[STEAM ID REDACTED]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[OPAQUE VALUE REDACTED]')
    .replace(/\bACCOUNT\b[^$\r\n]{0,100}(?=\$|$)/gi, 'ACCOUNT [REDACTED] ');
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'sourceHash' && /^[a-f0-9]{64}$/.test(v) ? v : /cookie|token|session|authorization|password|secret|url|ticket|email|steamid/i.test(k) ? '[REDACTED]' : sanitize(v)]));
  return value;
}
export class Store {
  constructor(root, { ledgerRoot = root, migration = false, requireExisting = false, diagnosticReason = null } = {}) {
    mkdirSync(root, { recursive: true }); this.root = root;
    mkdirSync(ledgerRoot, { recursive: true });
    if(diagnosticReason!==null&&(typeof diagnosticReason!=='string'||!diagnosticReason.trim()||diagnosticReason.length>120))throw new Error('BOUNDED_DIAGNOSTIC_REASON_REQUIRED');
    this.diagnosticReason=diagnosticReason;
    if(requireExisting&&!existsSync(join(ledgerRoot,'recovery.sqlite')))throw new Error('RECOVERY_LEDGER_MISSING');
    if (!migration && existsSync(join(ledgerRoot,'harness.sqlite')) && !existsSync(join(ledgerRoot,'recovery.sqlite'))) throw new Error('LEGACY_LEDGER_REQUIRES_MIGRATION');
    this.db = new DatabaseSync(join(ledgerRoot, 'recovery.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY, target TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY, at TEXT NOT NULL, event TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cases(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS actions_target_state ON actions(target,state);
      CREATE INDEX IF NOT EXISTS actions_state ON actions(state);
      CREATE INDEX IF NOT EXISTS actions_aircraft_state ON actions(json_extract(data,'$.aircraftId'),state);
      PRAGMA busy_timeout=5000;`);
    this.db.prepare('INSERT OR IGNORE INTO metadata VALUES(?,?)').run('schema','2');
    if(requireExisting&&this.db.prepare("SELECT value FROM metadata WHERE key='migrationValidated'").get()?.value!=='true'){this.db.close();throw new Error('RECOVERY_MIGRATION_NOT_VALIDATED');}
  }
  event(event, data) {
    // No routine event archive. A named opt-in diagnostic is bounded below.
    if(!this.diagnosticReason||event==='CDP_VALUE')return;
    const value=event.startsWith('ACTION_')?actionSummary(data):sanitize(data);
    const serialized=JSON.stringify(value);
    // Large diagnostics never enter the transaction ledger. Keep bounded compact observations.
    this.db.prepare('INSERT INTO events(at,event,data) VALUES(?,?,?)').run(new Date().toISOString(),event,serialized.length<=2048?serialized:JSON.stringify({reason:'DETAILS_OMITTED',id:data?.id}));
    this.db.prepare('DELETE FROM events WHERE sequence <= (SELECT max(sequence)-2000 FROM events)').run();
  }
  actions() { return this.db.prepare('SELECT data FROM actions').all().map(r => JSON.parse(r.data)); }
  unresolved() { return this.db.prepare("SELECT data FROM actions WHERE state IN ('PENDING','UNKNOWN')").all().map(r=>JSON.parse(r.data)); }
  holds(target, exceptId, aircraftId=null) { const byName=this.db.prepare("SELECT data FROM actions WHERE target=? AND state IN ('PENDING','UNKNOWN') AND id<>?").all(target,exceptId||''); const byId=aircraftId?this.db.prepare("SELECT data FROM actions WHERE json_extract(data,'$.aircraftId')=? AND state IN ('PENDING','UNKNOWN') AND id<>?").all(aircraftId,exceptId||''):[]; return [...new Map([...byName,...byId].map(r=>{const a=JSON.parse(r.data);return [a.id,a];})).values()]; }
  get(id) { const row = this.db.prepare('SELECT data FROM actions WHERE id=?').get(id); if (!row) throw new Error('CHECKPOINT_NOT_FOUND'); return JSON.parse(row.data); }
  saveAction(action) {
    const legal = {
      PENDING: ['PENDING','UNKNOWN','NOT_SUBMITTED','SCHEDULED_VERIFIED','RESOLVED_CURRENT_UI'],
      UNKNOWN: ['UNKNOWN','SCHEDULED_VERIFIED','DEPARTED_VERIFIED','PURCHASE_VERIFIED','RESOLVED_CURRENT_UI'],
      SCHEDULED_VERIFIED: ['SCHEDULED_VERIFIED','COMPLETED_VERIFIED','RESOLVED_CURRENT_UI'],
      RESOLVED_CURRENT_UI: ['RESOLVED_CURRENT_UI'],
      COMPLETED_VERIFIED: ['COMPLETED_VERIFIED'], NOT_SUBMITTED: ['NOT_SUBMITTED'],
      DEPARTED_VERIFIED: ['DEPARTED_VERIFIED'], PURCHASE_VERIFIED: ['PURCHASE_VERIFIED']
    };
    if (!legal[action.state]) throw new Error('INVALID_ACTION_STATE');
    const previous = this.db.prepare('SELECT data FROM actions WHERE id=?').get(action.id);
    if (previous) {
      const old = JSON.parse(previous.data);
      if (!legal[old.state]?.includes(action.state) || old.registration !== action.registration || old.kind !== action.kind || old.aircraftId !== action.aircraftId) throw new Error('ILLEGAL_ACTION_TRANSITION');
    } else if (action.state !== 'PENDING') throw new Error('ACTION_MUST_START_PENDING');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const compact=compactAction(action);
      this.db.prepare('INSERT INTO actions VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data').run(action.id, action.registration, action.kind, action.state, JSON.stringify(compact));
      if(!previous||JSON.parse(previous.data).state!==action.state)this.event('ACTION_' + action.state, compact);
      this.db.exec("DELETE FROM actions WHERE rowid IN (SELECT rowid FROM actions WHERE state NOT IN ('PENDING','UNKNOWN') ORDER BY rowid DESC LIMIT -1 OFFSET 10000)");
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  intent({ registration, kind, aircraftId, before, quote,completionObservation=false }) {
    if (this.holds(registration,null,aircraftId).length) throw new Error('UNRESOLVED_HARNESS_ACTION');
    const action = { id: randomUUID(), registration, kind, aircraftId, before, quote,completionObservation, state: 'PENDING', scheduleSeen: false, created: new Date().toISOString() };
    this.saveAction(action); return action;
  }
  saveCase(report) {
    const safe = sanitize({id:report.id,scenario:report.scenario,mode:report.mode,started:report.started,finished:report.finished,result:report.result,reason:report.reason,checkpoint:report.checkpoint,actionAttempted:report.actionAttempted});
    this.db.prepare('INSERT INTO cases VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(report.id, JSON.stringify(safe));
    this.db.prepare('DELETE FROM cases WHERE rowid IN (SELECT rowid FROM cases ORDER BY rowid DESC LIMIT -1 OFFSET 500)').run();
  }
  newCase(scenario, mode) {
    const report = { id: randomUUID(), scenario, mode, started: new Date().toISOString(), startingState: { unavailable: true, reason: 'NOT_CAPTURED_YET' }, actionAttempted: { submitted: false }, gameResponse: null, endingState: null, result: 'INCONCLUSIVE', reason: 'RUNNING', finished: null };
    this.saveCase(report); return report;
  }
  finish(report) { report.finished = new Date().toISOString(); this.saveCase(report); return report; }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
}
export function actionSummary(a) {
  const out=Object.fromEntries(['id','registration','kind','aircraftId','state','created','scheduleSeen','lastObservation','reconciliation','completionObservation'].filter(k=>a[k]!==undefined).map(k=>[k,a[k]]));
  if(a.quote)out.quote=Object.fromEntries(['requested','cost','maximumDebit','time'].filter(k=>a.quote[k]!==undefined).map(k=>[k,a.quote[k]]));
  return sanitize(out);
}
export function compactAction(a) {
  const out=actionSummary(a);
  if(['PENDING','UNKNOWN'].includes(a.state)||(a.state==='SCHEDULED_VERIFIED'&&a.completionObservation===true)) {
    if(a.kind==='purchase')out.before={[a.registration]:a.before?.[a.registration]};
    else if(['repair','check'].includes(a.kind))out.before={maintenance:{records:(a.before?.maintenance?.records||[]).filter(r=>a.aircraftId?r.id===a.aircraftId:r.registration===a.registration)}};
    // Only the target's pre-action values are needed to resolve a possibly committed submission.
  }
  return out;
}
export function readProductionHolds(root, target) {
  // A missing/unreadable journal is not permission to invent a clean production state.
  const state = JSON.parse(readFileSync(join(root, 'state', 'operations-state.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (state.schema !== 1 || !state.transactions || typeof state.transactions !== 'object' || Array.isArray(state.transactions)) throw new Error('PRODUCTION_STATE_INVALID');
  const holds = [];
  for (const [key, value] of Object.entries(state.transactions)) {
    if (!['PENDING', 'UNKNOWN', 'VERIFIED', 'NOT_SUBMITTED'].includes(value?.status)) throw new Error('PRODUCTION_TRANSACTION_STATUS_INVALID');
    if ((key.startsWith('maintenance:' + target + ':') || key === 'purchase:' + target) && ['PENDING', 'UNKNOWN'].includes(value.status)) holds.push({ key, state: value.status });
  }
  // Historical attempt locks are evidence, not something to delete to resume a test.
  for (const dir of ['state', 'locks']) {
    let names; try { names = readdirSync(join(root, dir)); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    for (const name of names) if (name.includes(target) && /lock|attempt/i.test(name)) holds.push({ key: name, state: 'LEGACY_LOCK' });
  }
  return holds;
}
