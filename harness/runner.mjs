import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Cdp } from './cdp.mjs';
import { acquireGuard } from './guard.mjs';
import { domExpression } from './dom.mjs';
import { renderBlock, readSource } from './source.mjs';
import { maintenanceEligibility, departureEligibility, reconcile, reconcileRecovery, wholeQuantity, verifyPurchase } from './policy.mjs';
import { readProductionHolds } from './store.mjs';
import { OperatorSession } from '../operator/control.mjs';
import { ResourceCache } from './resource-cache.mjs';
import { settings } from './settings.mjs';
import {samePurchaseQuote} from './purchasing.mjs';
import {validAircraftId,identityRows,excludedAircraft} from './identity.mjs';

export class Runner {
  constructor(options, source, store) {
    this.options = options; this.source = source; this.store = store; this.deadline = Date.now() + options.maxSeconds * 1000;
    this.aircraftIds=new Map();this.excludedIds=new Set();
    this.budget = options.maxActions; this.sequence = 0;
    this.resources=new ResourceCache({maxAgeMs:settings.resourceObservationMaxAgeMs});
  }
  async connect() {
    this.operator=new OperatorSession(join(this.options.productionRoot,'operator','state'),'TESTING');
    try{
    const passiveProbe = this.options.scenario === 'InspectAircraft' && !this.options.live;
    this.guard = await acquireGuard(() => this.cdp?.close());
    try {
      this.cdp = await Cdp.connect(Math.min(10000, this.remaining()),this.operator);
      if (!passiveProbe && (await this.dom('browserAutomation')).length) throw new Error('BROWSER_AUTOMATION_ACTIVE');
      this.store.event('SESSION_EXCLUSION_EVIDENCE', this.guard.exclusionEvidence);
    } catch (e) { this.close(); throw e; }
    }catch(e){this.close();throw e;}
  }
  remaining() { const ms = this.deadline - Date.now(); if (ms <= 0) throw new Error('SCENARIO_TIME_BUDGET_EXHAUSTED'); return ms; }
  async evaluate(expression, label) {
    if(/source\.purchase/.test(label)||/DOM\.commit|source\.departJs/.test(label)&&!this.batchSnapshot)this.resources.invalidate();
    this.cdp.timeoutMs = Math.min(String(label).startsWith('source.purchaseJsTemplate')?17000:12000, this.remaining());
    let value;
    try{value=await this.cdp.evaluate(expression,label);}catch(error){this.resources.invalidate();throw error;}
    // Value-only CDP evidence: never store transport envelopes, target URLs, exceptions, or page HTML.
    this.sequence++;
    return value;
  }
  dom(method,args=[]){const read=()=>this.evaluate(domExpression(method,args),'DOM.'+method);const category={openPlanner:'navigation',flight:'flightInspection',receipt:'receiptInspection',departureObservation:'targetInspection',inventory:'headerInspection'}[method];return category?this.measure(category,read):read();}
  async nav(view) { const result = await this.measure('navigation',()=>this.dom('navigate',[view])); if (!result.ok) throw new Error(result.reason); }
  measure(name,operation){if(!this.performance)return operation();return name==='navigation'&&this.actionInProgress?this.performance.measure('actionNavigation',()=>this.performance.measure(name,operation)):this.performance.measure(name,operation);}
  async markets({fresh=false}={}) {
    try{this.operator?.assertCanCommit();}catch(error){this.resources.invalidate();throw error;}
    return this.resources.read(()=>this.measure('resourceInspection',async()=>{const value=await this.measure('navigation',()=>this.evaluate(this.source.blocks.marketJs,'source.marketJs'));for(const kind of ['fuel','co2'])if(Number.isFinite(value.inspectionMs?.[kind]))this.performance?.record(kind+'Inspection',value.inspectionMs[kind]);return value;}),{fresh});
  }
  async fleet() { const rows=await this.measure('fleetScan',()=>this.evaluate(this.source.blocks.fleetJs,'source.fleetJs'));this.aircraftIds.clear();for(const a of rows){if(validAircraftId(a.aircraftId)&&rows.filter(r=>r.registration===a.registration).length===1)this.aircraftIds.set(a.registration,a.aircraftId);if(a.registration==='N-145'&&validAircraftId(a.aircraftId))this.excludedIds.add(a.aircraftId);}return rows; }
  async snapshot({ markets = false } = {}) {
    const result = { captured: new Date().toISOString(), fleet: await this.fleet() };
    if (markets) result.markets = await this.markets();
    await this.measure('maintenanceCheck',async()=>{await this.nav('schedule'); result.schedule = await this.dom('schedule');
    await this.nav('plan'); result.maintenance = await this.dom('maintenance');});
    for(const row of result.maintenance.records||[])if(row.registration==='N-145'&&validAircraftId(row.id))this.excludedIds.add(row.id);
    result.excludedAircraftIds=[...this.excludedIds];
    return result;
  }
  holds(target, exceptId) { return [...this.store.holds(target, exceptId,this.aircraftIds.get(target)), ...readProductionHolds(this.options.productionRoot, target)]; }
  verifySource() { if (readSource(this.options.productionRoot).hash !== this.source.hash) throw new Error('PRODUCTION_SOURCE_CHANGED_DURING_TEST'); }
  async confirm(kind, target, cost) {
    if (!this.options.live) throw new Error('LIVE_MODE_REQUIRED');
    if (this.budget < 1) throw new Error('ACTION_BUDGET_EXHAUSTED');
    this.operator?.assertCanCommit();
    await this.guard.check();
    this.verifySource();
    if ((await this.dom('browserAutomation')).length) throw new Error('BROWSER_AUTOMATION_ACTIVE');
    const phrase = `CONFIRM ${kind} ${target}${cost == null ? '' : ' $' + cost}`;
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try { answer = await prompt.question(`Irreversible action: ${phrase}. Type that exact phrase, or Enter to cancel: `, { signal: AbortSignal.timeout(Math.min(60000, this.remaining())) }); }
    finally { prompt.close(); }
    if (answer !== phrase) throw new Error('CANCELLED_NO_SUBMISSION');
    this.budget--;
    return true;
  }
  async execute(scenario) {
    const report = this.store.newCase(scenario, this.options.live ? 'LIVE_EXPLICIT' : 'READ_ONLY');
    report.sourceHash = this.source.hash;
    try {
      this.operator?.begin(scenario+(this.options.registration?' '+this.options.registration:''));
      if (scenario === 'InspectMarkets') {
        report.startingState = { fleet: await this.fleet() };
        report.actionAttempted = { name: 'InspectMarkets', submitted: false };
        report.gameResponse = await this.markets(); report.endingState = { markets: report.gameResponse, fleet: await this.fleet() };
        report.result = report.gameResponse.ok ? 'PASS' : 'INCONCLUSIVE';
      } else if (scenario === 'InspectAircraft') {
        report.startingState = { fleet: await this.fleet() };
        report.actionAttempted = { name: 'InspectAircraft', submitted: false };
        report.gameResponse = await this.fleet(); report.endingState = { fleet: report.gameResponse };
        report.result = Array.isArray(report.gameResponse) && report.gameResponse.length ? 'PASS' : 'INCONCLUSIVE';
      } else if (scenario === 'InspectSchedule') {
        report.startingState = { fleet: await this.fleet(), controls: await this.dom('controls') };
        report.actionAttempted = { name: 'InspectSchedule', submitted: false };
        await this.nav('schedule'); report.gameResponse = await this.dom('schedule'); report.endingState = { schedule: report.gameResponse };
        report.result = report.gameResponse.complete ? 'PASS' : 'INCONCLUSIVE';
      } else if (scenario === 'InspectEligibility') {
        report.startingState = await this.snapshot();
        const regs = this.options.registration ? [this.options.registration] : report.startingState.fleet.filter(a => ['landedList','parkedList'].includes(a.location)).map(a => a.registration);
        report.actionAttempted = { name: 'AssessIndividualMaintenance', submitted: false };
        report.gameResponse = regs.map(registration => ({ registration, repair: maintenanceEligibility(report.startingState, registration, 'repair', this.holds(registration)), check: maintenanceEligibility(report.startingState, registration, 'check', this.holds(registration)) }));
        report.endingState = report.startingState; report.result = report.startingState.schedule.complete && report.startingState.maintenance.ok ? 'PASS' : 'INCONCLUSIVE';
      } else if (['Repair', 'ACheck', 'RepairChain', 'ACheckChain'].includes(scenario)) {
        await this.maintenance(report, scenario.startsWith('Repair') ? 'repair' : 'check', scenario.endsWith('Chain'));
      } else if (scenario === 'ResumeChain') {
        const action = this.store.get(this.options.checkpoint);
        if (!['repair', 'check'].includes(action.kind)) throw new Error('NOT_MAINTENANCE_CHECKPOINT');
        report.checkpoint = action.id; report.startingState = { checkpoint: action, current: await this.snapshot() };
        report.actionAttempted = { name: 'ResumeObservationOnly', submitted: false };
        await this.observeAction(report, action, report.startingState.current, true);
      } else if (scenario === 'Departure') await this.departure(report);
      else if (scenario === 'PurchaseFuel' || scenario === 'PurchaseCO2') await this.purchase(report, scenario === 'PurchaseFuel' ? 'fuel' : 'co2');
      else throw new Error('UNKNOWN_SCENARIO');
      if (report.reason === 'RUNNING') report.reason = report.result === 'PASS' ? 'EXPECTED_OBSERVATION_VERIFIED' : 'REQUIRED_OBSERVATION_NOT_PROVEN';
    } catch (error) {
      report.result = 'INCONCLUSIVE'; report.reason = /^[A-Z0-9_.]+$/.test(error.message) ? error.message : 'OPERATION_FAILED_DETAILS_EXCLUDED';
      if(error.processDiagnostics)report.processDiagnostics=error.processDiagnostics;
      if (report.checkpoint) {
        const action = this.store.get(report.checkpoint);
        if (action.state === 'PENDING') { action.state = 'UNKNOWN'; this.store.saveAction(action); }
      }
      // A disconnected browser is an unknown ending state, never a synthetic success.
      report.endingState ||= { unavailable: true, reason: report.reason };
      report.gameResponse ||= { unavailable: true, reason: report.reason };
    }
    // An action outcome belongs to its journal hold. A finished CDP command does
    // not retain global ownership merely because this aircraft needs reconciliation.
    // Transport uncertainty already fails closed in Cdp.evaluate/endStep.
    try{this.operator?.end('RETURNED');}catch{}
    this.store.finish(report);
    console.log(`${report.result}: ${scenario}: ${report.reason}; report ${report.id}${report.checkpoint ? '; checkpoint ' + report.checkpoint : ''}`);
    return report;
  }
  async maintenance(report, kind, chain) {
    const reg = this.options.registration;
    if (!reg) throw new Error('EXPLICIT_REGISTRATION_REQUIRED');
    report.startingState = this.batchSnapshot||await this.snapshot();
    if(this.batchSnapshot){await this.nav('plan');report.startingState={...this.batchSnapshot,maintenance:await this.dom('maintenance')};}
    const eligibility = maintenanceEligibility(report.startingState, reg, kind, this.holds(reg),{requireAction:false});
    report.gameResponse = { eligibility };
    if (!eligibility.eligible) { report.reason = 'NO_ELIGIBLE_AIRCRAFT'; report.endingState = report.startingState; return; }
    let quote = await this.dom('openPlanner', [{ registration: reg, kind, id: eligibility.row.id }]);
    report.gameResponse.quote = quote;
    if(quote.ok===false&&['MAINTENANCE_CONTROL_DISABLED','MAINTENANCE_BASE_UNAVAILABLE'].includes(quote.reason)&&quote.unavailable===true){
      report.reason='MAINTENANCE_UNAVAILABLE';report.endingState={quote};return;
    }
    if (!quote.ok || !eligibility.row.availableActions.includes(kind)) throw new Error('PLANNER_NOT_ELIGIBLE');
    if (!this.options.live) { report.actionAttempted = { name: 'PlannerInspectionOnly', submitted: false }; report.endingState = { quote }; report.result = 'PASS'; report.reason = 'NO_IRREVERSIBLE_ACTION_READ_ONLY_MODE'; return; }
    await this.confirm(kind, reg, quote.cost);
    // Confirmation may take time. Refresh the actual schedule and the quote before persisting intent.
    const fresh = this.batchSnapshot?report.startingState:await this.snapshot();
    const e = maintenanceEligibility(fresh, reg, kind, this.holds(reg));
    if (!e.eligible || e.row.id !== eligibility.row.id) throw new Error('ELIGIBILITY_CHANGED_AFTER_CONFIRMATION');
    const current = await this.dom(this.batchSnapshot?'inspectPlanner':'openPlanner',this.batchSnapshot?[reg,kind,e.row.id]:[{registration:reg,kind,id:e.row.id}]);
    if (!current.ok || current.cost !== quote.cost || current.time !== quote.time || current.row.wear !== quote.row.wear || current.row.hoursToCheck !== quote.row.hoursToCheck) throw new Error('QUOTE_CHANGED_AFTER_CONFIRMATION');
    quote = current;
    await this.guard.check();
    this.verifySource();
    const action = this.store.intent({ registration: reg, kind, aircraftId: e.row.id, before: fresh, quote,completionObservation:Boolean(chain) });
    report.checkpoint = action.id; report.actionAttempted = { name: kind, submitted: 'POSSIBLE', actionId: action.id };
    this.store.saveCase(report); // Crash after this point is resumable without repeating a click.
    const commit = await this.dom('commit', [{ registration: reg, kind, id: e.row.id, quote, actionId: action.id,excludedAircraftIds:[...this.excludedIds] }]);
    report.actionAttempted.submitted = commit.clicked;
    report.gameResponse = { eligibility: e, quote, commit };
    if (!commit.clicked) { action.state = 'NOT_SUBMITTED'; this.store.saveAction(action); report.reason = commit.reason; report.endingState = { commit }; return; }
    action.state = 'UNKNOWN'; this.store.saveAction(action);
    await this.pause(750);
    report.gameResponse.response = await this.dom('response');
    let observed;
    if(this.batchSnapshot){await this.nav('schedule');observed={...fresh,schedule:await this.dom('schedule')};this.batchSnapshot.schedule=observed.schedule;}else observed=await this.snapshot();
    // Scheduling verification belongs to the current action. Waiting for a maintenance
    // timer does not keep the interface occupied across a manual-pause request.
    const first=this.options.scenario==='Production'?reconcileRecovery(action,observed):reconcile(action,observed);action.state=first.state;action.scheduleSeen ||= first.scheduleSeen;this.store.saveAction(action);
    this.operator?.end(first.state==='SCHEDULED_VERIFIED'?'SCHEDULED':'RETURNED');
    if(this.options.scenario==='Production'){report.endingState=observed;report.gameResponse.reconciliation=first;report.result=first.result;report.reason=first.reason;return;}
    await this.observeAction(report, action, observed, chain);
  }
  async pause(ms) { await new Promise(resolve => setTimeout(resolve, Math.min(ms, this.remaining()))); }
  async observeAction(report, action, first, chain) {
    let snapshot = first, outcome;
    const deadline = Math.min(this.deadline - 1000, Date.now() + this.options.waitSeconds * 1000);
    do {
      outcome = reconcile(action, snapshot);
      // Completion evidence is monotonic. Never resubmit an already completed checkpoint.
      if (action.state === 'COMPLETED_VERIFIED' && outcome.state !== 'COMPLETED_VERIFIED') {
        outcome = { ...outcome, state: action.state, result: 'INCONCLUSIVE', reason: 'COMPLETED_CHECKPOINT_CURRENT_STATE_CHANGED' };
      }
      action.state = outcome.state; action.scheduleSeen ||= outcome.scheduleSeen; action.lastObservation = outcome; action.after = snapshot;
      this.store.saveAction(action);
      if (action.state === 'COMPLETED_VERIFIED' || !chain || Date.now() >= deadline) break;
      await this.pause(Math.min(5000, deadline - Date.now())); snapshot = await this.snapshot();
    } while (Date.now() < this.deadline);
    report.endingState = snapshot; report.gameResponse = { ...(report.gameResponse || {}), reconciliation: outcome };
    if (action.state === 'COMPLETED_VERIFIED') {
      snapshot.markets = await this.markets();
      // Eligibility only. A chain never silently launches a previously proven departure.
      const selected = await this.evaluate(renderBlock(this.source.blocks.selectJs, action.registration,null,action.aircraftId), 'source.selectJs');
      let flight = { hours: null };
      if (selected.ok) { await this.pause(650); flight = await this.dom('flight'); }
      const hours = flight.aircraftId===action.aircraftId&&flight.registrations?.length === 1 && flight.registrations[0] === action.registration ? flight.hours : null;
      report.gameResponse.departureEligibility = departureEligibility(snapshot, action.registration, this.holds(action.registration, action.id), hours);
      report.gameResponse.flight = flight;
      report.result = !chain || report.gameResponse.departureEligibility.eligible ? 'PASS' : 'INCONCLUSIVE';
      report.reason = report.result === 'PASS' ? 'COMPLETED_AND_DEPARTURE_ELIGIBLE' : 'COMPLETED_BUT_DEPARTURE_ELIGIBILITY_NOT_PROVEN';
    } else if (!chain && action.state === 'SCHEDULED_VERIFIED') { report.result = 'PASS'; report.reason = 'SCHEDULING_VERIFIED_COMPLETION_CHECKPOINT_SAVED'; }
    else { report.result = 'INCONCLUSIVE'; report.reason = action.state === 'SCHEDULED_VERIFIED' ? 'PENDING_CHECKPOINT_SAVED_RESUME_LATER' : 'AMBIGUOUS_CHECKPOINT_SAVED_DO_NOT_RESUBMIT'; }
  }
  async departure(report) {
    const reg = this.options.registration; if (!reg) throw new Error('EXPLICIT_REGISTRATION_REQUIRED');
    const offered=this.dispatchSnapshot;this.dispatchSnapshot=null;
    report.startingState=this.batchSnapshot||(offered&&offered.sequence===this.sequence&&Date.now()-(offered.finished??Date.parse(offered.value.captured))<=2000?offered.value:await this.snapshot({markets:true}));
    const initial=identityRows(report.startingState,reg);
    const aircraftId=initial.id;if(!validAircraftId(aircraftId))throw new Error('AIRCRAFT_ID_REQUIRED');
    const selected = await this.evaluate(renderBlock(this.source.blocks.selectJs, reg,null,aircraftId), 'source.selectJs');
    if (!selected.ok) throw new Error('DEPARTURE_SELECTION_FAILED');
    await this.pause(650); let flight = await this.dom('flight');
    if(this.batchSnapshot){
      if(!this.resources.observeHeader(flight.header)||this.resources.low()||Number.isSafeInteger(flight.fuelRequired)&&flight.fuelRequired>this.resources.value?.fuel?.holding){await this.markets({fresh:true});await this.evaluate(renderBlock(this.source.blocks.selectJs,reg,null,aircraftId),'source.selectJs');await this.pause(650);flight=await this.dom('flight');if(!this.resources.observeHeader(flight.header))throw new Error('RESOURCE_OBSERVATION_UNCERTAIN');}
      report.startingState.markets=structuredClone(this.resources.value);
    }
    const hours = flight.aircraftId===aircraftId&&flight.registrations?.length === 1 && flight.registrations[0] === reg ? flight.hours : null;
    const eligible = departureEligibility(report.startingState, reg, this.holds(reg), hours);
    if(Number.isSafeInteger(flight.fuelRequired)&&flight.fuelRequired>report.startingState.markets?.fuel?.holding){eligible.eligible=false;eligible.reasons.push('INSUFFICIENT_ROUTE_FUEL');}
    report.gameResponse = { selected, flight, eligible };
    if (!eligible.eligible) { report.endingState = report.startingState; report.reason = 'DEPARTURE_NOT_ELIGIBLE'; return; }
    if (!this.options.live) { report.result = 'PASS'; report.reason = 'DEPARTURE_ELIGIBILITY_ONLY'; report.endingState = report.startingState; return; }
    await this.confirm('departure', reg, null);
    const fresh = this.batchSnapshot||await this.snapshot({ markets: true });
    if(!this.batchSnapshot){await this.evaluate(renderBlock(this.source.blocks.selectJs,reg,null,aircraftId),'source.selectJs');await this.pause(650);}
    flight=await this.dom('flight');
    if(this.batchSnapshot&&!this.resources.observeHeader(flight.header))throw new Error('RESOURCE_OBSERVATION_UNCERTAIN');
    if (identityRows(fresh,reg).id!==aircraftId||excludedAircraft(fresh,identityRows(fresh,reg).aircraft)||flight.aircraftId!==aircraftId||flight.registrations?.length !== 1 || flight.registrations[0] !== reg || !departureEligibility(fresh, reg, this.holds(reg), flight.hours).eligible) throw new Error('DEPARTURE_PRECOMMIT_CHANGED');
    await this.guard.check();
    this.verifySource();
    const beforeReceipt=this.batchSnapshot?await this.dom('receipt'):null;
    const action = this.store.intent({ registration: reg, kind: 'departure', aircraftId, before: fresh });
    report.checkpoint = action.id; report.actionAttempted = { name: 'departure', submitted: 'POSSIBLE', actionId: action.id }; this.store.saveCase(report);
    const result = await this.evaluate(renderBlock(this.source.blocks.departJs, reg,null,aircraftId), 'source.departJs');
    report.actionAttempted.submitted = Boolean(result.ok);
    action.state = result.ok ? 'UNKNOWN' : 'NOT_SUBMITTED'; this.store.saveAction(action); report.gameResponse.commit = result;
    for(let count=0;result.ok&&count<8;count++){
      await this.pause(750);
      if(this.batchSnapshot){
        const observed=await this.dom('departureObservation',[aircraftId]);report.endingState={target:observed.rows};
        if(observed.rows.length===1&&observed.rows[0].location==='inflightList'){
          action.state='DEPARTED_VERIFIED';this.store.saveAction(action);report.result='PASS';report.reason='EXISTING_DEPARTURE_ACTION_VERIFIED';
          Object.assign(this.batchSnapshot.fleet.find(a=>a.aircraftId===aircraftId),observed.rows[0]);
          let proof=observed;
          for(let followup=0;followup<3&&!this.resources.debitReady(beforeReceipt,proof);followup++){await this.pause(150);proof=await this.dom('receipt');}
          report.gameResponse.inventoryAccounted=this.resources.debit(beforeReceipt,proof);break;
        }
      }else{
        const fleet=await this.fleet();report.endingState={fleet};const rows=fleet.filter(r=>r.aircraftId===aircraftId);
        if(rows.length===1&&rows[0].location==='inflightList'){action.state='DEPARTED_VERIFIED';this.store.saveAction(action);report.result='PASS';report.reason='EXISTING_DEPARTURE_ACTION_VERIFIED';break;}
      }
    }
    if(this.batchSnapshot&&report.result!=='PASS'){this.resources.invalidate();report.endingState||={targetUnavailable:true};}
    else report.endingState||={fleet:await this.fleet()};
  }

  async purchase(report, kind) {
    report.startingState = { markets: await this.markets({fresh:true}) };
    const market = report.startingState.markets[kind];
    if (!market?.ok) throw new Error('MARKET_INCOMPLETE');
    const input = { kind, price: market.pricePer1000, capacity: market.capacityMax, holding: market.holding, cash: market.cash };
    const requested = wholeQuantity(input);
    if (!requested) { report.reason = 'NO_NATURALLY_QUALIFYING_MARKET'; report.endingState = report.startingState; return; }
    const cost = Math.round(requested * input.price / 1000);
    report.gameResponse = { requested, cost };
    if (!this.options.live) { report.result = 'PASS'; report.reason = 'QUALIFICATION_INSPECTED_NO_PURCHASE'; report.endingState = report.startingState; return; }
    await this.confirm('purchase', kind, Math.ceil(requested * input.price / 1000));
    await this.guard.check();
    this.verifySource();
    // Existing template re-reads values, calculates amount, and verifies. Bind confirmation to the same quote.
    const before = await this.markets({fresh:true});
    if (!samePurchaseQuote(before[kind],market)) throw new Error('MARKET_CHANGED_AFTER_CONFIRMATION');
    const action = this.store.intent({ registration: kind, kind: 'purchase', before, quote: { requested, cost, maximumDebit:Math.ceil(requested*input.price/1000) } });
    report.checkpoint = action.id; report.actionAttempted = { name: 'purchase:' + kind, submitted: 'POSSIBLE', actionId: action.id }; this.store.saveCase(report);
    // Guard wrapper binds the template's internally re-read quote/amount. The purchase body stays unchanged.
    const template = bindPurchase(this.source.blocks.purchaseJsTemplate, kind, { ...input, requested, cost });
    const result = await this.evaluate(template, 'source.purchaseJsTemplate.confirmationBound');
    report.actionAttempted.submitted = result.clickAttempted;
    const verification = verifyPurchase(result);
    // Even an exact delta must match the confirmed quote and quantity.
    const pass = verification.result === 'PASS' && result.requested === requested && result.estimatedCost === cost;
    action.state = !result.clickAttempted ? 'NOT_SUBMITTED' : 'UNKNOWN'; action.response = result; this.store.saveAction(action);
    if (pass) { action.state = 'PURCHASE_VERIFIED'; this.store.saveAction(action); }
    report.gameResponse = { result, verification }; report.endingState = { markets: await this.markets({fresh:true}) }; report.result = pass ? 'PASS' : 'INCONCLUSIVE';
    report.reason = pass ? 'SEPARATELY_AUTHORIZED_PURCHASE_VERIFIED' : 'PURCHASE_NOT_PROVEN_NO_RETRY';
  }
  close() { this.resources.invalidate();this.cdp?.close(); this.guard?.release();this.operator?.close(); }
}

export function bindPurchase(template, kind, quote) {
  const marker = "const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;";
  if (template.split(marker).length !== 2) throw new Error('PURCHASE_ADAPTER_SOURCE_CHANGED');
  // Add an outer safety gate at the existing precommit boundary; preserve all production purchase calculations and clicks.
  const guard = `if(before.price!==${quote.price}||before.capacity!==${quote.capacity}||before.holding!==${quote.holding}||before.cash!==${quote.cash}||amount!==${quote.requested}||cost!==${quote.cost})return JSON.stringify({ok:false,clickAttempted:false,reason:'Confirmed quote changed'});`;
  return template.replace('__KIND__', JSON.stringify(kind)).replace(marker, guard + '\n ' + marker);
}

