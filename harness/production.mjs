// Normal production coordinator. All game actions reuse the live-verified Runner.
import { readFileSync,writeFileSync,renameSync,appendFileSync,mkdirSync } from 'node:fs';
import { join,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Runner } from './runner.mjs';
import { Store } from './store.mjs';
import { readSource } from './source.mjs';
import { acquireGuard } from './guard.mjs';
import { Cdp } from './cdp.mjs';
import { requiredMaintenance,departureEligibility,reconcileRecovery,applyMaintenanceUnavailable } from './policy.mjs';
import { highCycleReport } from './fleet-report.mjs';
import { OperatorSession } from '../operator/control.mjs';
import {bulkMaintenance,bulkDeparture} from './bulk-operations.mjs';
import { purchaseDecision } from './purchasing.mjs';
import {attachResourceStrategy} from './resource-strategy.mjs';
import {ForecastMonitor,notifyForecast} from './forecast-monitor.mjs';
import {MaintenanceCache} from './maintenance-cache.mjs';
import {classifyShutdown} from './shutdown.mjs';
import { settings } from './settings.mjs';
import { waitBetweenPasses } from './cadence.mjs';
import {PassPerformance,requiresRecoveryBackoff,defaultMaxDepartures} from './performance.mjs';
import {identityRows} from './identity.mjs';
import {FleetHeartbeat} from './fleet-heartbeat.mjs';
import {FleetActivity,assessFleetActivity} from './fleet-activity.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url))),args=process.argv.slice(2),config={};
for(let i=0;i<args.length;i+=2){if(!/^--[a-z-]+$/.test(args[i])||args[i+1]===undefined)throw new Error('INVALID_PRODUCTION_ARGUMENT');config[args[i].slice(2)]=Number(args[i+1]);}
const cycle=config['cycle-seconds']??settings.cycleSeconds,maxDepartures=config['max-departures']??defaultMaxDepartures,maxMaintenance=config['max-maintenance']??20,csvBatch=config['csv-batch']??10,maxPasses=config['max-passes']??0,passSeconds=config['pass-seconds']??600;
if(Object.values(config).some(v=>!Number.isInteger(v))||cycle<1||cycle>3600||maxDepartures<0||maxDepartures>1000||maxMaintenance<0||maxMaintenance>20||csvBatch<1||csvBatch>30||maxPasses<0||passSeconds<60||passSeconds>900)throw new Error('INVALID_PRODUCTION_BOUNDS');
if(config['parent-pid']!==process.ppid)throw new Error('START_AM4_LAUNCHER_REQUIRED');
mkdirSync(join(root,'reports'),{recursive:true});
const reportPath=join(root,'reports','operations-latest.json');
const save=value=>{writeFileSync(reportPath+'.tmp',JSON.stringify(value,null,2));renameSync(reportPath+'.tmp',reportPath);};
const store=new Store(join(root,'reports','production-actions'),{ledgerRoot:join(root,'harness','state'),requireExisting:true,diagnosticReason:settings.diagnosticReason});
const runner=new Runner({scenario:'Production',live:true,maxSeconds:passSeconds,maxActions:1,waitSeconds:0,productionRoot:root},readSource(root),store);
let report,completedPasses=0,batchCursor=0;
runner.resources.batch=true;runner.maintenanceCache=new MaintenanceCache();
const fleetHeartbeat=new FleetHeartbeat();
const fleetActivity=new FleetActivity();
function logFleetActivity(assessment,options){const event=fleetActivity.observe(assessment,options);if(event)console.log(JSON.stringify(event));}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function active(){runner.operator.assertCanCommit();if(runner.cdp.socket.readyState!==WebSocket.OPEN)throw new Error('CDP_DISCONNECTED');}
function stage(name){active();runner.deadline=Date.now()+120000;report.phase=name;save(report);}
async function action(scenario,registration,operation){
  active();runner.deadline=Date.now()+120000;runner.budget=1;runner.options.registration=registration;runner.options.waitSeconds=0;
  report.activeAction={scenario,registration};save(report);
  let r;runner.actionInProgress=true;if(operation)runner.operator.begin(scenario);
  try{r=await runner.measure(/Departure$/.test(scenario)?'departureAction':/^Purchase/.test(scenario)?'purchaseAction':'maintenanceAction',()=>operation?operation():runner.execute(scenario));}finally{runner.actionInProgress=false;if(operation)try{runner.operator.end('RETURNED');}catch{}}
  if(scenario==='Departure')notifyForecast(runner.forecast,'observeDeparture',r.gameResponse);
  report.performance=runner.performance.report();
  report.actions.push({scenario,registration,id:r.id,checkpoint:r.checkpoint,result:r.result,reason:r.reason,submitted:r.actionAttempted?.submitted,inventoryAccounted:r.gameResponse?.inventoryAccounted,inventoryIssue:runner.resources.lastIssue});
  if(r.checkpoint){const a=store.get(r.checkpoint);report.actions.at(-1).state=a.state;}
  report.activeAction=null;save(report);
  if((['Departure','Repair','ACheck','BulkDeparture','BulkMaintenance'].includes(scenario))&&r.result==='PASS')logFleetActivity({actionableAircraft:r.verified?.length||1,unknown:1});
  if(/^(?:OPERATOR_|CDP_|CONTROLLER_|BROWSER_AUTOMATION_|PRODUCTION_SOURCE_CHANGED)/.test(r.reason))throw Object.assign(new Error(r.reason),{processDiagnostics:r.processDiagnostics});
  active();return r;
}
async function purchaseMarkets(trigger){
  active();runner.deadline=Date.now()+120000;
  // Only a due resource gets a new observation/decision; actions retain fresh quote binding.
  for(const kind of ['fuel','co2']){
    const plan=runner.resources.purchasePlan?.(kind);
    if(plan){
      report.resourcePlans||={};report.resourcePlans[kind]=plan;
      runner.resourcePlanLogKeys||={};const key=JSON.stringify([plan.reason,plan.forecastTrusted,plan.nextFavorable]);
      if(runner.resourcePlanLogKeys[kind]!==key){runner.resourcePlanLogKeys[kind]=key;console.log(JSON.stringify({event:'RESOURCE_PURCHASE_PLAN',...plan}));}
    }
    if(!runner.resources.purchaseDue(kind))continue;
    const m=await runner.markets({kinds:[kind]});report.markets=m;
    const d={at:new Date().toISOString(),trigger,...purchaseDecision(m,kind)};
    const currentPlan=runner.resources.purchasePlan?.(kind);
    if(d.decision==='BUY'&&currentPlan&&!currentPlan.buy){d.decision='SKIP';d.reason=currentPlan.reason;}
    if(currentPlan)d.strategyReason=currentPlan.reason;
    try{if(d.decision==='BUY'){
      const r=await action(kind==='fuel'?'PurchaseFuel':'PurchaseCO2');
      d.result=r.result;d.reportId=r.id;d.checkpoint=r.checkpoint;
      if(r.result!=='PASS'){d.decision='SKIPPED_OR_UNVERIFIED';d.reason=r.reason;d.response=r.gameResponse?.result?.reason;}
      report.purchases.push({kind,result:r.result,reason:r.reason,checkpoint:r.checkpoint});
    }}catch(error){d.decision='UNVERIFIED_OR_INTERRUPTED';d.reason=/^[A-Z0-9_]+$/.test(error.message)?error.message:'PURCHASE_ACTION_FAILED';throw error;}
    finally{
    report.purchaseDecisions ||= [];report.purchaseDecisions.push(d);
    if(runner.resources.recordPurchaseDecision(kind,d)){store.event('PURCHASE_DECISION',d);appendFileSync(join(root,'reports','purchase-decisions.jsonl'),JSON.stringify(d)+'\n');console.log(JSON.stringify({event:'PURCHASE_DECISION',kind:d.kind,decision:d.decision,reason:d.reason,result:d.result,reportId:d.reportId}));}save(report);
    }
  }
}
try{
  runner.forecast=new ForecastMonitor({directory:join(root,'reports'),...settings.forecastAdvisory,log:event=>console.log(JSON.stringify(event))});
  await runner.forecast.initialize();notifyForecast(runner.forecast,'tick');
  attachResourceStrategy(runner.resources,runner.forecast,settings.resourcePurchasing);
  runner.operator=new OperatorSession(join(root,'operator','state'),'AUTOMATIC');
  const guardOptions={ignoreControllerPids:[process.ppid]};
  for(let attempt=0;;attempt++){
    try{runner.guard=await acquireGuard(()=>runner.cdp?.close(),guardOptions);break;}
    catch(error){if(attempt>=4||!['CONTROLLER_OR_LEGACY_SCRIPT_RUNNING','CONTROLLER_LOCK_BUSY'].includes(error.message))throw error;runner.operator.assertCanCommit();await sleep(500);}
  }
  runner.cdp=await Cdp.connect(10000,runner.operator);
  if((await runner.dom('browserAutomation')).length)throw new Error('BROWSER_AUTOMATION_ACTIVE');
  store.event('PRODUCTION_STARTED',{parentPid:process.ppid,pid:process.pid,exclusion:runner.guard.exclusionEvidence,cycle,maxDepartures,maxMaintenance});
  {const state=runner.operator.control.status();console.log(JSON.stringify({event:'CONTROLLER_STARTED',at:new Date().toISOString(),pid:process.pid,parentPid:process.ppid,mode:state.mode,revision:state.revision,request:state.lastModeRequest}));}
  runner.confirm=async(kind,target,cost)=>{
    if(!['repair','check','departure','purchase'].includes(kind)||runner.budget<1)throw new Error('PRODUCTION_ACTION_NOT_AUTHORIZED');
    active();if(!(runner.batchSnapshot&&kind==='departure'))await runner.guard.check();runner.verifySource();
    if((await runner.dom('browserAutomation')).length)throw new Error('BROWSER_AUTOMATION_ACTIVE');
    if(cost!=null){
      const reserved=store.unresolved().filter(a=>['repair','check'].includes(a.kind));
      const debit=a=>a.quote?.cost;
      if(reserved.some(a=>!Number.isSafeInteger(debit(a))))throw new Error('UNRESOLVED_FUNDS_RESERVE');
      const cash=await runner.evaluate("(()=>{const m=document.body.innerText.replace(/\\s+/g,' ').match(/\\bACCOUNT\\s*\\$\\s*([\\d,]+)/i);return JSON.stringify({cash:m?Number(m[1].replace(/,/g,'')):null});})()",'Production cash reserve');
      if(!Number.isSafeInteger(cash.cash)||cash.cash-cost-reserved.reduce((sum,a)=>sum+debit(a),0)<100000000)throw new Error('UNRESOLVED_FUNDS_RESERVE');
    }
    store.event('PRODUCTION_POLICY_AUTHORIZED',{kind,target,cost,cashReserve:100000000});runner.budget--;return true;
  };
  while(!maxPasses||completedPasses<maxPasses){
    notifyForecast(runner.forecast,'tick');
    active();const passDeadline=Date.now()+passSeconds*1000;runner.performance=new PassPerformance();const cacheAtStart={...runner.resources.metrics};
    report={passId:randomUUID(),started:new Date().toISOString(),status:'RUNNING',phase:'STARTING',mode:'AUTOMATIC',fleetHeartbeat:{verifiedSinceDisplay:fleetHeartbeat.verifiedSinceDisplay},actions:[],maintenance:[],held:[],verifiedDepartures:[],purchases:[],maintenanceActions:[]};save(report);
    console.log(JSON.stringify({event:'PASS_STARTED',passId:report.passId,pass:completedPasses+1}));
    stage('FLEET_ASSESSMENT');
    runner.batchSnapshot=null;runner.dispatchFlights=new Map();runner.productionPassDeadline=passDeadline;
    let snapshot=await runner.snapshot();const suppressedBefore=runner.maintenanceCache.suppressed;const negativeHeld=runner.maintenanceCache.apply(snapshot);runner.batchSnapshot=snapshot;
    for(const a of store.unresolved().filter(a=>a.kind!=='purchase')){
      if(['repair','check'].includes(a.kind)){
        const o=reconcileRecovery(a,snapshot);a.scheduleSeen ||= o.scheduleSeen;a.state=o.state;a.lastObservation=o;store.saveAction(a);
        report.maintenance.push({registration:a.registration,kind:a.kind,state:a.state,reason:o.reason});
      }else if(a.kind==='departure'){
        const rows=a.aircraftId?identityRows(snapshot,a.registration,a.aircraftId).fleet:snapshot.fleet.filter(f=>f.registration===a.registration);
        if(rows.length===1&&rows[0].location==='inflightList'){a.state='DEPARTED_VERIFIED';store.saveAction(a);}
      }
      // Historical purchase outcomes are diagnostic records, not operational vetoes.
    }
    const fleetAssessment=assessFleetActivity(snapshot,reg=>runner.holds(reg));
    if(fleetAssessment.actionableAircraft>0)logFleetActivity(fleetAssessment);
    save(report);stage('FLEET_MAINTENANCE');let maintenanceCount=0;
    const pool=snapshot.fleet.filter(a=>['landedList','parkedList'].includes(a.location));
    runner.maintenanceFallbackLimit=pool.some(f=>!requiredMaintenance(snapshot,f.registration,runner.holds(f.registration)))?1:maxMaintenance;
    const offset=pool.length?batchCursor%pool.length:0;
    const candidates=[...pool.slice(offset),...pool.slice(0,offset)];batchCursor=offset+candidates.length;
    report.batch={candidateCount:candidates.length,actionableAtStart:pool.length,limit:maxDepartures};
    const eligibleCandidates=[],maintained=new Set(negativeHeld);report.bulk={maintenance:[]};
    for(const kind of ['check','repair']){
      const group=pool.filter(a=>{
        const row=identityRows(snapshot,a.registration,a.aircraftId).row;
        if(maintained.has(a.aircraftId)||a.status!=='landed'||!row||(kind==='check'?!(row.hoursToCheck<20):!(row.hoursToCheck>=20&&row.wear>settings.repairWearThreshold)))return false;
        return requiredMaintenance(snapshot,a.registration,runner.holds(a.registration))===kind;
      }).sort((a,b)=>kind==='check'?identityRows(snapshot,a.registration).row.hoursToCheck-identityRows(snapshot,b.registration).row.hoursToCheck:identityRows(snapshot,b.registration).row.wear-identityRows(snapshot,a.registration).row.wear);
      if(!group.length||Date.now()>passDeadline-15000)continue;
      const r=await action('BulkMaintenance',null,()=>bulkMaintenance(runner,snapshot,group,kind));
      report.bulk.maintenance.push({kind,reason:r.reason,result:r.result,fallback:r.fallback});
      if(!r.fallback){maintenanceCount+=group.length;runner.performance.counts.maintenanceAttempted=(runner.performance.counts.maintenanceAttempted||0)+group.length;for(const a of group){maintained.add(a.aircraftId);report.maintenanceActions.push({registration:a.registration,kind,result:r.verified.includes(a.aircraftId)?'PASS':'INCONCLUSIVE',reason:r.reason});}}
      else for(const a of group.slice(0,Math.max(0,Math.min(maxMaintenance-maintenanceCount,runner.maintenanceFallbackLimit??maxMaintenance)))){
        if(Date.now()>passDeadline-15000)break;
        const individual=await action(kind==='check'?'ACheck':'Repair',a.registration);maintenanceCount++;
        report.maintenanceActions.push({registration:a.registration,kind,result:individual.result,reason:individual.reason,checkpoint:individual.checkpoint});
        runner.maintenanceCache?.remember(snapshot,a,kind,individual);if(!applyMaintenanceUnavailable(snapshot,a.registration,kind,individual)){maintained.add(a.aircraftId);}
      }
    }
    for(const a of candidates){
      if(Date.now()>passDeadline-15000)break;
      runner.performance.counts.examined++;
      if(maintained.has(a.aircraftId))continue;
      // Inspect the single priority action once; no completion polling or submission retry.
      const kind=requiredMaintenance(snapshot,a.registration,runner.holds(a.registration));
      if(kind){
        if(maintenanceCount>=Math.min(maxMaintenance,runner.maintenanceFallbackLimit??maxMaintenance)){report.held.push({registration:a.registration,reasons:['MAINTENANCE_DEFERRED_BATCH_BUDGET']});runner.performance.counts.skipped++;continue;}
        const r=await action(kind==='check'?'ACheck':'Repair',a.registration);maintenanceCount++;
        report.maintenanceActions.push({registration:a.registration,kind,result:r.result,reason:r.reason,checkpoint:r.checkpoint});
        runner.resources.observeHeader(await runner.dom('inventory'));
        runner.maintenanceCache?.remember(snapshot,a,kind,r);if(!applyMaintenanceUnavailable(snapshot,a.registration,kind,r))continue;
      }
      eligibleCandidates.push(a);
    }
    report.maintenanceSuppressed=runner.maintenanceCache.suppressed-suppressedBefore;runner.performance.counts.maintenanceSuppressed=report.maintenanceSuppressed;stage('RESOURCE_READINESS');runner.resources.beginDispatch(eligibleCandidates.length);
    if(runner.resources.value)runner.resources.observeHeader(await runner.dom('inventory'));
    snapshot.markets=await runner.markets();await purchaseMarkets('BATCH_RESOURCE_READINESS');snapshot.markets=runner.resources.value;
    runner.resources.beginDispatch(eligibleCandidates.length);
    if(eligibleCandidates.length)await runner.dom('showRoutes');stage('FLEET_DISPATCH');
    let usedBulk=false;
    while(eligibleCandidates.some(a=>!report.verifiedDepartures.includes(a.registration))&&report.verifiedDepartures.length<maxDepartures&&Date.now()<passDeadline-15000){
      const r=await action('BulkDeparture',null,()=>bulkDeparture(runner,snapshot,eligibleCandidates.filter(a=>!report.verifiedDepartures.includes(a.registration))));
      report.bulk.departure={reason:r.reason,result:r.result,fallback:r.fallback,targetCount:r.targetCount,evidence:r.evidence};usedBulk=!r.fallback;report.bulk.departures||=[];report.bulk.departures.push(report.bulk.departure);if(r.fallback)break;
      if(usedBulk){
        for(const id of r.verified){const a=snapshot.fleet.find(a=>a.aircraftId===id);report.verifiedDepartures.push(a.registration);runner.performance.counts.dispatched++;runner.performance.counts.eligible++;
          const shown=await fleetHeartbeat.afterDeparture({result:'PASS',state:'DEPARTED_VERIFIED',submitted:true},{active,display:()=>runner.dom('showFleet'),begin:()=>runner.operator.begin('Fleet visual heartbeat'),end:()=>runner.operator.end('RETURNED')});if(shown)console.log(JSON.stringify({event:'FLEET_HEARTBEAT',...shown}));
        }
        runner.performance.counts.attempted+=r.targetCount||eligibleCandidates.length;
        if(r.result!=='PASS'||!r.verified.length){report.batch.recoveryBreak=true;runner.performance.counts.uncertain=Math.max(0,(r.targetCount||eligibleCandidates.length)-r.verified.length);for(const a of eligibleCandidates.filter(a=>!r.verified.includes(a.aircraftId)))report.held.push({registration:a.registration,reasons:['BULK_DEPARTURE_UNCERTAIN']});break;}
      }
    }
    for(const a of report.batch.recoveryBreak?[]:eligibleCandidates.filter(a=>!report.verifiedDepartures.includes(a.registration))){
      if(report.verifiedDepartures.length>=maxDepartures||Date.now()>passDeadline-15000)break;
      if(['fuel','co2'].some(k=>runner.resources.purchaseDue(k))){await purchaseMarkets('BATCH_RESOURCE_MARGIN_OR_PRICE_CHANGE');await runner.dom('showRoutes');}
      snapshot.markets=runner.resources.value;
      const e=departureEligibility(snapshot,a.registration,runner.holds(a.registration),null);
      if(e.reasons.some(reason=>reason!=='FLIGHT_DURATION_UNKNOWN')){runner.performance.counts.skipped++;report.held.push({registration:a.registration,reasons:e.reasons});continue;}
      runner.performance.counts.attempted++;
      const r=await action('Departure',a.registration);
      if(r.gameResponse?.eligible?.eligible)runner.performance.counts.eligible++;
      if(r.result==='PASS'){report.verifiedDepartures.push(a.registration);runner.performance.counts.dispatched++;}
      else {runner.performance.counts.skipped++;report.held.push({registration:a.registration,reason:r.reason,reasons:r.gameResponse?.eligible?.reasons,checkpoint:r.checkpoint});}
      if(r.checkpoint&&store.get(r.checkpoint).state==='UNKNOWN'){runner.resources.invalidate();report.batch.recoveryBreak=true;break;}
      const heartbeat=await fleetHeartbeat.afterDeparture(report.actions.at(-1),{
        active,display:()=>runner.measure('fleetHeartbeat',()=>runner.measure('navigation',()=>runner.dom('showFleet'))),
        begin:()=>runner.operator.begin('Fleet visual heartbeat'),end:()=>runner.operator.end('RETURNED')
      });
      report.fleetHeartbeat={verifiedSinceDisplay:fleetHeartbeat.verifiedSinceDisplay,...(heartbeat?{lastDisplay:{at:new Date().toISOString(),...heartbeat}}:report.fleetHeartbeat?.lastDisplay?{lastDisplay:report.fleetHeartbeat.lastDisplay}:{})};
      if(heartbeat){console.log(JSON.stringify({event:'FLEET_HEARTBEAT',...heartbeat}));save(report);}
      if(r.gameResponse?.eligible?.reasons?.includes('INSUFFICIENT_ROUTE_FUEL')){runner.resources.endDispatch();await purchaseMarkets('ROUTE_RESOURCE_SHORTFALL');runner.resources.beginDispatch(eligibleCandidates.length-report.verifiedDepartures.length);await runner.dom('showFleet');}
    }
    notifyForecast(runner.forecast,'update',{markets:runner.resources.value,context:{candidateCount:candidates.length,resourceBlockedCandidates:report.held.filter(h=>h.reasons?.some(r=>['DISPATCH_RESOURCE_GATE','INSUFFICIENT_ROUTE_FUEL'].includes(r))&&h.reasons.every(r=>['DISPATCH_RESOURCE_GATE','INSUFFICIENT_ROUTE_FUEL','FLIGHT_DURATION_UNKNOWN'].includes(r))).length,confirmedEnabledDepartures:null}});
    report.aCheck=report.maintenanceActions.some(a=>a.kind==='check')?'ATTEMPTED_ELIGIBLE':'SKIPPED_NO_ELIGIBLE_AIRCRAFT_IN_BATCH';
    runner.performance.counts.deferred=candidates.length-runner.performance.counts.examined;
    stage('FLEET_CSV');
    try{if(eligibleCandidates.some(a=>a.location==='landedList'&&!report.verifiedDepartures.includes(a.registration)&&!report.held.some(h=>h.registration===a.registration)))report.fleetCsv={result:'DEFERRED',reason:'DISPATCH_BACKLOG_PRIORITY'};else report.fleetCsv=await runner.measure('fleetReport',()=>runner.measure('navigation',()=>highCycleReport(runner,{limit:pool.length>20?Math.min(csvBatch,2):csvBatch,fleetObservation:snapshot.fleet})));}catch(error){active();report.fleetCsv={result:'INCONCLUSIVE',reason:/^[A-Z0-9_]+$/.test(error.message)?error.message:'REPORT_FAILED'};}
    stage('ENDING_REFRESH');runner.resources.observeHeader(await runner.dom('inventory'));const endingFleet=snapshot.fleet;report.endingFleet={count:endingFleet.length,byLocation:endingFleet.reduce((out,a)=>(out[a.location]=(out[a.location]||0)+1,out),{})};if(['fuel','co2'].some(k=>runner.resources.purchaseDue(k)))await purchaseMarkets('BATCH_END_REFRESH');report.endingMarkets=runner.resources.value;report.resourceCache={...runner.resources.metrics};report.inventoryReconciliation=runner.resources.lastReconciliation;
    await runner.measure('navigation',()=>runner.dom('showFleet'));
    report.finished=new Date().toISOString();report.durationMs=Date.now()-Date.parse(report.started);report.resourceCache={...runner.resources.metrics};report.batch.backlogAfterObserved=snapshot.fleet.filter(a=>['landedList','parkedList'].includes(a.location)).length;report.batch.verifiedBacklogReduction=report.verifiedDepartures.length;report.performance=runner.performance.report();report.batchInventoryMetrics=Object.fromEntries(Object.entries(runner.resources.metrics).map(([k,v])=>[k,v-(cacheAtStart[k]||0)]));report.departuresPerMinute=report.durationMs?report.verifiedDepartures.length*60000/report.durationMs:0;report.status='COMPLETED_OPERATIONS_PASS';report.phase='WAITING';save(report);
    if(settings.retainPassHistory)appendFileSync(join(root,'reports','operations-history.jsonl'),JSON.stringify(report)+'\n');store.event('PRODUCTION_PASS_COMPLETED',{passId:report.passId,departures:report.verifiedDepartures,maintenance:report.maintenanceActions,purchases:report.purchases});
    completedPasses++;console.log(JSON.stringify({event:'PASS_COMPLETED',pass:completedPasses,durationMs:report.durationMs,performance:report.performance,resourceCache:report.batchInventoryMetrics,batch:report.batch,departuresPerMinute:report.departuresPerMinute,departures:report.verifiedDepartures,maintenance:report.maintenanceActions,aCheck:report.aCheck}));
    if(maxPasses&&completedPasses>=maxPasses)break;
    // Serialized passes: an unresolved transaction backs off rather than tight-looping.
    const waitingForRecovery=requiresRecoveryBackoff(store.unresolved(),{scheduleComplete:snapshot.schedule?.complete===true,maintenanceComplete:snapshot.maintenance?.ok===true});
    if(waitingForRecovery)runner.resources.invalidate();
    if(!waitingForRecovery&&!report.batch.recoveryBreak)logFleetActivity(assessFleetActivity({...snapshot,markets:runner.resources.value},reg=>runner.holds(reg)),{nextFleetCheckAt:new Date(Date.now()+cycle*1000).toISOString()});
    Object.assign(report,await waitBetweenPasses({active,recovery:waitingForRecovery,seconds:cycle}));save(report);
    store.event('PASS_TIMING',{passId:report.passId,durationMs:report.durationMs,idleMs:report.idleMs,idleReason:report.idleReason});
  }
}catch(error){
  const reason=/^[A-Z0-9_]+$/.test(error.message)?error.message:'PRODUCTION_OPERATION_FAILED';
  if(!runner.operator&&reason==='INTERFACE_ALREADY_OWNED_OR_UNCERTAIN'){
    console.log(JSON.stringify({event:'START_IGNORED',reason:'CONTROLLER_ALREADY_RUNNING_OR_INTERFACE_RESERVED'}));
  }else{
  let controlState={};try{controlState=runner.operator?.control.status()||{};}catch{}const shutdown=classifyShutdown(error,controlState);report ||= {started:new Date().toISOString(),actions:[]};report.shutdown=shutdown;report.status=shutdown.category.endsWith('_PAUSE')?'STOPPED_PAUSED':'STOPPED_SAFELY';report.reason=reason;if(error.rendererDescription)report.rendererDescription=error.rendererDescription;if(runner.performance)report.performance=runner.performance.report();if(error.processDiagnostics)report.processDiagnostics=error.processDiagnostics;report.finished=new Date().toISOString();report.durationMs=Date.now()-Date.parse(report.started);save(report);
  console.log(JSON.stringify({event:'CONTROLLER_STOPPED',at:new Date().toISOString(),pid:process.pid,reason:shutdown.category,cause:reason,source:shutdown.source,request:shutdown.request,ownershipLoss:shutdown.ownershipLoss}));if(!shutdown.category.endsWith('_PAUSE'))process.exitCode=2;
  }
}finally{
  if(report?.status==='COMPLETED_OPERATIONS_PASS')console.log(JSON.stringify({event:'CONTROLLER_STOPPED',at:new Date().toISOString(),pid:process.pid,reason:'NORMAL_SHUTDOWN',cause:'BOUNDED_RUN_COMPLETED'}));
  if(runner.operator){try{const s=runner.operator.control.status();if(s.owner?.token===runner.operator.token&&s.mode==='AUTOMATIC')runner.operator.control.request('PAUSED/MANUAL',{source:'AUTOMATION',reason:'CONTROLLER_FINALIZER'});}catch{}}
  runner.close();store.close();
}
