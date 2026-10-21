// Synthetic data only. No CDP connection, operator controls or live state.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDom} from '../dom.mjs';
import {Runner} from '../runner.mjs';
import {Store} from '../store.mjs';
import {readSource} from '../source.mjs';
import {maintenanceChoice,departureEligibility,applyMaintenanceUnavailable} from '../policy.mjs';
import {plannerDom} from './fake-dom.mjs';
globalThis.getComputedStyle=()=>({visibility:'visible'});
const root=new URL('../../',import.meta.url);
const source=readSource(fileURLToPath(root));
function snapshot(kind='check'){
 return {captured:new Date().toISOString(),fleet:[{aircraftId:'123',registration:'N-TEST001',location:'landedList',status:'landed',grounded:'0',wear:kind==='repair'?12:2}],
 maintenance:{ok:true,records:[{id:'123',registration:'N-TEST001',wear:kind==='repair'?12:2,hoursToCheck:kind==='check'?14:200,availableActions:[kind]}]},schedule:{complete:true,entries:[]},
 markets:{ok:true,fuel:{holding:2000000,capacityMax:4000000},co2:{holding:2000000,capacityMax:4000000}}};
}
function unavailable(s,kind='check'){
 return {reason:'MAINTENANCE_UNAVAILABLE',actionAttempted:{submitted:false},gameResponse:{quote:{ok:false,reason:'MAINTENANCE_CONTROL_DISABLED',unavailable:true,id:'123',registration:'N-TEST001',kind,matchingRows:1,matchingControls:1,disabledControls:1,enabledControls:0,row:structuredClone(s.maintenance.records[0])}}};
}
const production=readFileSync(new URL('../production.mjs',import.meta.url),'utf8');
async function productionBranch(s,result){
 let calls=0;
 const code=production.slice(production.indexOf('      let maintenanceBlocked=false;'),production.indexOf('      if(maintenanceBlocked)continue;'));
 const context={snapshot:s,a:s.fleet[0],maintenanceChoice,applyMaintenanceUnavailable,maintenanceCount:0,maxMaintenance:20,report:{held:[],maintenanceActions:[]},
 runner:{holds:()=>[],performance:{counts:{skipped:0}},resources:{observeHeader(){},priceDue:()=>false,low:()=>false},dom:async()=>({})},
 action:async()=>{calls++;return result;},purchaseMarkets:async()=>{throw Error('UNEXPECTED_MARKET');}};
 const held=await vm.runInNewContext('(async()=>{'+code+';return maintenanceBlocked;})()',context);
 return {held,calls};
}
for(const kind of ['check','repair'])test(kind+' explicitly unavailable -> stale list reconciled -> eligible departure',async()=>{
 const s=snapshot(kind);assert.equal(maintenanceChoice(s,'N-TEST001'),kind);
 const b=await productionBranch(s,unavailable(s,kind));assert.equal(b.held,false);assert.equal(b.calls,1);
 assert.equal(maintenanceChoice(s,'N-TEST001'),null);assert.equal(departureEligibility(s,'N-TEST001',[],2).eligible,true);
 assert.equal(maintenanceChoice(snapshot(kind),'N-TEST001'),kind,'fresh batch restores authoritative list');
});
test('submitted or uncertain maintenance never falls through or retries',async()=>{
 for(const result of [{reason:'SUBMISSION_ACKNOWLEDGED_BY_CURRENT_SCHEDULE',result:'PASS',checkpoint:'synthetic',actionAttempted:{submitted:true}},
 {reason:'CDP_DISCONNECTED',checkpoint:'synthetic',actionAttempted:{submitted:'POSSIBLE'}},
 {reason:'PLANNER_NOT_ELIGIBLE',actionAttempted:{submitted:false}}]){
  const b=await productionBranch(snapshot(),result);assert.equal(b.held,true);assert.equal(b.calls,1);
 }
});
test('forged, mismatched, missing or ambiguous disabled evidence never suppresses maintenance',()=>{
 for(const change of [r=>r.checkpoint='synthetic',r=>r.actionAttempted.submitted=true,r=>r.actionAttempted.submitted='POSSIBLE',r=>delete r.actionAttempted,
 r=>r.gameResponse.quote.id='124',r=>r.gameResponse.quote.kind='repair',r=>r.gameResponse.quote.registration='N-TEST002',r=>r.gameResponse.quote.matchingControls=2,
 r=>r.gameResponse.quote.enabledControls=1,r=>delete r.gameResponse.quote.row]){
  const s=snapshot(),r=unavailable(s);change(r);assert.equal(applyMaintenanceUnavailable(s,'N-TEST001','check',r),false);assert.equal(maintenanceChoice(s,'N-TEST001'),'check');
 }
});
test('other due maintenance remains required after A-check unavailable',()=>{
 const s=snapshot();s.fleet[0].wear=12;Object.assign(s.maintenance.records[0],{wear:12,availableActions:['check','repair']});
 assert.equal(applyMaintenanceUnavailable(s,'N-TEST001','check',unavailable(s)),true);
 assert.equal(maintenanceChoice(s,'N-TEST001'),'repair');assert.ok(departureEligibility(s,'N-TEST001',[],2).reasons.includes('MAINTENANCE_ACTION_AVAILABLE'));
});
test('detailed DOM only classifies exact visible disabled final controls as unavailable',()=>{
 for(const kind of ['check','repair']){
  let p=plannerDom({kind,disabled:true});const q=createDom(p.doc).inspectPlanner('N-TEST001',kind,'123');assert.equal(q.reason,'MAINTENANCE_CONTROL_DISABLED');assert.equal(q.unavailable,true);
  assert.equal(createDom(p.doc).inspectPlanner('N-TEST001',kind,'124').unavailable,undefined);
  p=plannerDom({kind,disabled:true,rowReg:'N-TEST002'});assert.equal(createDom(p.doc).inspectPlanner('N-TEST001',kind,'123').unavailable,undefined);
  p=plannerDom({kind,disabled:true});p.final.shown=false;assert.equal(createDom(p.doc).inspectPlanner('N-TEST001',kind,'123').unavailable,undefined);
  p=plannerDom({kind});p.section.innerText='Unrecognized quote';assert.equal(createDom(p.doc).inspectPlanner('N-TEST001',kind,'123').unavailable,undefined);
 }
});
test('runner labels disabled planner before confirmation or intent; ambiguity remains held',async()=>{
 for(const kind of ['check','repair']){
  const dir=mkdtempSync(join(tmpdir(),'am4-fallthrough-')),store=new Store(dir);try{
   const s=snapshot(kind),r=new Runner({productionRoot:dir,registration:'N-TEST001',maxActions:1,maxSeconds:60,live:true},source,store);
   r.batchSnapshot=s;r.holds=()=>[];r.nav=async()=>{};r.confirm=async()=>{throw Error('CONFIRM_MUST_NOT_RUN');};
   r.dom=async method=>method==='maintenance'?s.maintenance:unavailable(s,kind).gameResponse.quote;
   const report=store.newCase('Maintenance','OFFLINE');await r.maintenance(report,kind,false);assert.equal(report.reason,'MAINTENANCE_UNAVAILABLE');assert.equal(report.actionAttempted.submitted,false);assert.equal(report.checkpoint,undefined);
   r.dom=async method=>method==='maintenance'?s.maintenance:{ok:false,reason:'PLANNER_SECTION_MISSING'};
   await assert.rejects(()=>r.maintenance(store.newCase('Maintenance','OFFLINE'),kind,false),/PLANNER_NOT_ELIGIBLE/);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
 }
});
test('departure after fallthrough still rejects disabled Depart, excessive duration and uncertainty hold',async()=>{
 for(const variant of ['enabled','disabled','duration','hold','fuel','excluded']){
  const dir=mkdtempSync(join(tmpdir(),'am4-depart-gate-')),store=new Store(dir);try{
   const s=snapshot();applyMaintenanceUnavailable(s,'N-TEST001','check',unavailable(s));
   const r=new Runner({productionRoot:dir,registration:'N-TEST001',maxActions:1,maxSeconds:60,live:true},source,store);r.batchSnapshot=s;r.resources.value=structuredClone(s.markets);r.resources.observeHeader=()=>true;r.resources.low=()=>false;
   r.holds=()=>variant==='hold'?[{state:'UNKNOWN'}]:[];r.pause=async()=>{};r.confirm=async()=>{throw Error('PASSED_DEPARTURE_GATES');};
   r.evaluate=async()=>({ok:true});
   if(variant==='excluded')s.excludedAircraftIds=['123'];
   r.dom=async method=>{assert.equal(method,'flight');return {aircraftId:variant==='disabled'?null:'123',registrations:variant==='disabled'?[]:['N-TEST001'],hours:variant==='duration'?15:2,fuelRequired:variant==='fuel'?3000000:1000,header:{}};};
   if(variant==='fuel')r.markets=async()=>s.markets;
   const report=store.newCase('Departure','OFFLINE');
   if(variant==='enabled')await assert.rejects(()=>r.departure(report),/PASSED_DEPARTURE_GATES/);
   else{await r.departure(report);assert.equal(report.reason,'DEPARTURE_NOT_ELIGIBLE');assert.equal(report.checkpoint,undefined);}
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
 }
});
for(const kind of ['check','repair'])test(kind+' unavailable completes a simulated verified departure through the real runner',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'am4-verified-fallthrough-')),store=new Store(dir);try{
  const s=snapshot(kind);assert.equal((await productionBranch(s,unavailable(s,kind))).held,false);
  const r=new Runner({productionRoot:dir,registration:'N-TEST001',maxActions:1,maxSeconds:60,live:true},source,store);
  r.batchSnapshot=s;r.resources.value=structuredClone(s.markets);r.resources.observeHeader=()=>true;r.resources.low=()=>false;r.resources.debitReady=()=>true;r.resources.debit=()=>true;
  let submissions=0;r.holds=()=>[];r.pause=async()=>{};r.confirm=async()=>{};r.guard={check:async()=>{}};r.verifySource=()=>{};
  r.evaluate=async(expression,label)=>{if(label==='source.departJs')submissions++;return {ok:true};};
  r.dom=async method=>{
   if(method==='flight')return {aircraftId:'123',registrations:['N-TEST001'],hours:2,fuelRequired:1000,header:{}};
   if(method==='receipt')return {};
   if(method==='departureObservation')return {rows:[{...s.fleet[0],status:'inflight',location:'inflightList'}]};
   throw Error('UNEXPECTED_DOM_'+method);
  };
  const report=store.newCase('Departure','OFFLINE');await r.departure(report);
  assert.equal(submissions,1);assert.equal(report.result,'PASS');assert.equal(store.get(report.checkpoint).state,'DEPARTED_VERIFIED');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
