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
import { maintenanceEligibility,departureEligibility,reconcileRecovery } from './policy.mjs';
import { highCycleReport } from './fleet-report.mjs';
import { OperatorSession } from '../operator/control.mjs';
import { purchaseDecision,reconcilePurchase } from './purchasing.mjs';
import { settings } from './settings.mjs';
import { waitBetweenPasses } from './cadence.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url))),args=process.argv.slice(2),config={};
for(let i=0;i<args.length;i+=2){if(!/^--[a-z-]+$/.test(args[i])||args[i+1]===undefined)throw new Error('INVALID_PRODUCTION_ARGUMENT');config[args[i].slice(2)]=Number(args[i+1]);}
const cycle=config['cycle-seconds']??settings.cycleSeconds,maxDepartures=config['max-departures']??8,maxMaintenance=config['max-maintenance']??2,csvBatch=config['csv-batch']??10,maxPasses=config['max-passes']??0,passSeconds=config['pass-seconds']??600;
if(Object.values(config).some(v=>!Number.isInteger(v))||cycle<1||cycle>3600||maxDepartures<0||maxDepartures>30||maxMaintenance<0||maxMaintenance>10||csvBatch<1||csvBatch>30||maxPasses<0||passSeconds<60||passSeconds>900)throw new Error('INVALID_PRODUCTION_BOUNDS');
if(config['parent-pid']!==process.ppid)throw new Error('START_AM4_LAUNCHER_REQUIRED');
mkdirSync(join(root,'reports'),{recursive:true});
const reportPath=join(root,'reports','operations-latest.json');
const save=value=>{writeFileSync(reportPath+'.tmp',JSON.stringify(value,null,2));renameSync(reportPath+'.tmp',reportPath);};
const store=new Store(join(root,'reports','production-actions'),{ledgerRoot:join(root,'harness','state'),requireExisting:true,diagnosticReason:settings.diagnosticReason});
const runner=new Runner({scenario:'Production',live:true,maxSeconds:passSeconds,maxActions:1,waitSeconds:0,productionRoot:root},readSource(root),store);
let report,completedPasses=0;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function active(){runner.operator.assertCanCommit();if(runner.cdp.socket.readyState!==WebSocket.OPEN)throw new Error('CDP_DISCONNECTED');}
function stage(name){active();runner.deadline=Date.now()+120000;report.phase=name;save(report);}
async function action(scenario,registration){
  active();runner.deadline=Date.now()+120000;runner.budget=1;runner.options.registration=registration;runner.options.waitSeconds=0;
  report.activeAction={scenario,registration};save(report);
  const r=await runner.execute(scenario);
  report.actions.push({scenario,registration,id:r.id,checkpoint:r.checkpoint,result:r.result,reason:r.reason,submitted:r.actionAttempted?.submitted});
  if(r.checkpoint){const a=store.get(r.checkpoint);report.actions.at(-1).state=a.state;}
  report.activeAction=null;save(report);active();
  if(/^(?:OPERATOR_|CDP_|CONTROLLER_|BROWSER_AUTOMATION_|PRODUCTION_SOURCE_CHANGED)/.test(r.reason))throw Object.assign(new Error(r.reason),{processDiagnostics:r.processDiagnostics});
  return r;
}
async function purchaseMarkets(trigger){
  active();runner.deadline=Date.now()+120000;
  // A purchase can change cash, so re-read immediately for each resource.
  for(const kind of ['fuel','co2']){
    const m=await runner.markets();report.markets=m;
    // Reconcile BOTH resources before any new spending changes the cash evidence.
    for(const held of store.unresolved().filter(a=>a.kind==='purchase')){
      const response=reconcilePurchase(held,m);
      if(response){held.state='PURCHASE_VERIFIED';held.response=response;held.reconciliation={observed:new Date().toISOString(),reason:'EXACT_QUANTITY_AND_WHOLE_DOLLAR_CASH_INTERVAL'};store.saveAction(held);store.event('PURCHASE_RECONCILED',held.reconciliation);}
    }
    const d={at:new Date().toISOString(),trigger,...purchaseDecision(m,kind,runner.holds(kind))};
    try{if(d.decision==='BUY'){
      const r=await action(kind==='fuel'?'PurchaseFuel':'PurchaseCO2');
      d.result=r.result;d.reportId=r.id;d.checkpoint=r.checkpoint;
      if(r.result!=='PASS'){d.decision='SKIPPED_OR_UNVERIFIED';d.reason=r.reason;d.response=r.gameResponse?.result?.reason;}
      report.purchases.push({kind,result:r.result,reason:r.reason,checkpoint:r.checkpoint});
    }}catch(error){d.decision='UNVERIFIED_OR_INTERRUPTED';d.reason=/^[A-Z0-9_]+$/.test(error.message)?error.message:'PURCHASE_ACTION_FAILED';throw error;}
    finally{
    report.purchaseDecisions ||= [];report.purchaseDecisions.push(d);
    store.event('PURCHASE_DECISION',d);appendFileSync(join(root,'reports','purchase-decisions.jsonl'),JSON.stringify(d)+'\n');console.log(JSON.stringify({event:'PURCHASE_DECISION',kind:d.kind,decision:d.decision,reason:d.reason,result:d.result,reportId:d.reportId}));save(report);
    }
  }
}
try{
  runner.operator=new OperatorSession(join(root,'operator','state'),'AUTOMATIC');
  const guardOptions={ignoreControllerPids:[process.ppid]};
  for(let attempt=0;;attempt++){
    try{runner.guard=await acquireGuard(()=>runner.cdp?.close(),guardOptions);break;}
    catch(error){if(attempt>=4||!['CONTROLLER_OR_LEGACY_SCRIPT_RUNNING','CONTROLLER_LOCK_BUSY'].includes(error.message))throw error;runner.operator.assertCanCommit();await sleep(500);}
  }
  runner.cdp=await Cdp.connect(10000,runner.operator);
  if((await runner.dom('browserAutomation')).length)throw new Error('BROWSER_AUTOMATION_ACTIVE');
  store.event('PRODUCTION_STARTED',{parentPid:process.ppid,pid:process.pid,exclusion:runner.guard.exclusionEvidence,cycle,maxDepartures,maxMaintenance});
  runner.confirm=async(kind,target,cost)=>{
    if(!['repair','check','departure','purchase'].includes(kind)||runner.budget<1)throw new Error('PRODUCTION_ACTION_NOT_AUTHORIZED');
    active();await runner.guard.check();runner.verifySource();
    if((await runner.dom('browserAutomation')).length)throw new Error('BROWSER_AUTOMATION_ACTIVE');
    if(cost!=null){
      const reserved=store.unresolved().filter(a=>['repair','check','purchase'].includes(a.kind));
      const debit=a=>a.kind==='purchase'?(a.quote?.maximumDebit??Math.ceil(a.quote?.requested*a.before?.[a.registration]?.pricePer1000/1000)):a.quote?.cost;
      if(reserved.some(a=>!Number.isSafeInteger(debit(a))))throw new Error('UNRESOLVED_FUNDS_RESERVE');
      const cash=await runner.evaluate("(()=>{const m=document.body.innerText.replace(/\\s+/g,' ').match(/\\bACCOUNT\\s*\\$\\s*([\\d,]+)/i);return JSON.stringify({cash:m?Number(m[1].replace(/,/g,'')):null});})()",'Production cash reserve');
      if(!Number.isSafeInteger(cash.cash)||cash.cash-cost-reserved.reduce((sum,a)=>sum+debit(a),0)<100000000)throw new Error('UNRESOLVED_FUNDS_RESERVE');
    }
    store.event('PRODUCTION_POLICY_AUTHORIZED',{kind,target,cost,cashReserve:100000000});runner.budget--;return true;
  };
  while(!maxPasses||completedPasses<maxPasses){
    active();const passDeadline=Date.now()+passSeconds*1000;
    report={passId:randomUUID(),started:new Date().toISOString(),status:'RUNNING',phase:'STARTING',mode:'AUTOMATIC',actions:[],maintenance:[],held:[],verifiedDepartures:[],purchases:[],maintenanceActions:[]};save(report);
    console.log(JSON.stringify({event:'PASS_STARTED',passId:report.passId,pass:completedPasses+1}));
    stage('MARKETS');
    await purchaseMarkets('PASS_START');
    stage('MAINTENANCE_RECONCILIATION');let snapshot=await runner.snapshot();
    for(const a of store.unresolved()){
      if(['repair','check'].includes(a.kind)){
        const o=reconcileRecovery(a,snapshot);a.scheduleSeen ||= o.scheduleSeen;a.state=o.state;a.lastObservation=o;store.saveAction(a);
        report.maintenance.push({registration:a.registration,kind:a.kind,state:a.state,reason:o.reason});
      }else if(a.kind==='departure'){
        const rows=snapshot.fleet.filter(f=>f.registration===a.registration);
        if(rows.length===1&&rows[0].location==='inflightList'){a.state='DEPARTED_VERIFIED';store.saveAction(a);}
      }
      // Unknown purchase outcomes retain only that resource's durable hold.
    }
    save(report);stage('INDIVIDUAL_MAINTENANCE');let maintenanceCount=0;
    const planned=snapshot.fleet.filter(a=>['landedList','parkedList'].includes(a.location)).map(a=>({aircraft:a,kind:maintenanceEligibility(snapshot,a.registration,'check',runner.holds(a.registration)).eligible?'check':maintenanceEligibility(snapshot,a.registration,'repair',runner.holds(a.registration)).eligible?'repair':null})).filter(a=>a.kind).sort((a,b)=>(a.kind==='check'?0:1)-(b.kind==='check'?0:1));
    for(const {aircraft:a,kind} of planned){
      if(maintenanceCount>=maxMaintenance||Date.now()>passDeadline-30000)break;
      const r=await action(kind==='check'?'ACheck':'Repair',a.registration);maintenanceCount++;
      report.maintenanceActions.push({registration:a.registration,kind,result:r.result,reason:r.reason,checkpoint:r.checkpoint});
      await purchaseMarkets('AFTER_MAINTENANCE');
    }
    report.aCheck=report.maintenanceActions.some(a=>a.kind==='check')?'ATTEMPTED_ELIGIBLE':planned.some(a=>a.kind==='check')?'DEFERRED_PASS_BUDGET':'SKIPPED_NO_ELIGIBLE_AIRCRAFT';
    stage('DISPATCH');snapshot=await runner.snapshot({markets:true});
    for(const a of snapshot.fleet.filter(a=>['landedList','parkedList'].includes(a.location))){
      if(report.verifiedDepartures.length>=maxDepartures||Date.now()>passDeadline-15000)break;
      const e=departureEligibility(snapshot,a.registration,runner.holds(a.registration),null);
      if(e.reasons.some(reason=>reason!=='FLIGHT_DURATION_UNKNOWN')){report.held.push({registration:a.registration,reasons:e.reasons});continue;}
      const r=await action('Departure',a.registration);
      if(r.result==='PASS')report.verifiedDepartures.push(a.registration);
      else report.held.push({registration:a.registration,reason:r.reason,checkpoint:r.checkpoint});
      await purchaseMarkets('AFTER_DEPARTURE');
    }
    stage('FLEET_CSV');
    try{report.fleetCsv=await highCycleReport(runner,{limit:csvBatch});}catch(error){active();report.fleetCsv={result:'INCONCLUSIVE',reason:/^[A-Z0-9_]+$/.test(error.message)?error.message:'REPORT_FAILED'};}
    stage('ENDING_REFRESH');const endingFleet=await runner.fleet();report.endingFleet={count:endingFleet.length,byLocation:endingFleet.reduce((out,a)=>(out[a.location]=(out[a.location]||0)+1,out),{})};await purchaseMarkets('PASS_END');report.endingMarkets=report.markets;
    report.finished=new Date().toISOString();report.durationMs=Date.now()-Date.parse(report.started);report.resourceCache={...runner.resources.metrics};report.status='COMPLETED_OPERATIONS_PASS';report.phase='WAITING';save(report);
    if(settings.retainPassHistory)appendFileSync(join(root,'reports','operations-history.jsonl'),JSON.stringify(report)+'\n');store.event('PRODUCTION_PASS_COMPLETED',{passId:report.passId,departures:report.verifiedDepartures,maintenance:report.maintenanceActions,purchases:report.purchases});
    completedPasses++;console.log(JSON.stringify({event:'PASS_COMPLETED',pass:completedPasses,departures:report.verifiedDepartures,maintenance:report.maintenanceActions,aCheck:report.aCheck}));
    if(maxPasses&&completedPasses>=maxPasses)break;
    // Serialized passes: an unresolved transaction backs off rather than tight-looping.
    const waitingForRecovery=store.unresolved().length>0;
    if(waitingForRecovery)runner.resources.invalidate();
    Object.assign(report,await waitBetweenPasses({active,recovery:waitingForRecovery,seconds:cycle}));save(report);
    store.event('PASS_TIMING',{passId:report.passId,durationMs:report.durationMs,idleMs:report.idleMs,idleReason:report.idleReason});
  }
}catch(error){
  const reason=/^[A-Z0-9_]+$/.test(error.message)?error.message:'PRODUCTION_OPERATION_FAILED';
  if(!runner.operator&&reason==='INTERFACE_ALREADY_OWNED_OR_UNCERTAIN'){
    console.log(JSON.stringify({event:'START_IGNORED',reason:'CONTROLLER_ALREADY_RUNNING_OR_INTERFACE_RESERVED'}));
  }else{
  report ||= {started:new Date().toISOString(),actions:[]};report.status=reason.startsWith('OPERATOR_')?'STOPPED_OPERATOR_PAUSED':'STOPPED_SAFELY';report.reason=reason;if(error.processDiagnostics)report.processDiagnostics=error.processDiagnostics;report.finished=new Date().toISOString();save(report);
  console.log(JSON.stringify({event:'CONTROLLER_STOPPED',reason}));if(!reason.startsWith('OPERATOR_'))process.exitCode=2;
  }
}finally{
  if(runner.operator){try{const s=runner.operator.control.status();if(s.owner?.token===runner.operator.token&&s.mode==='AUTOMATIC')runner.operator.control.request('PAUSED/MANUAL');}catch{}}
  runner.close();store.close();
}
