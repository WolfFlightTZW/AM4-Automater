// Synthetic offline observations only; no AM4 connection or runtime state.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {settings} from '../settings.mjs';
import {maintenanceEligibility,requiredMaintenance,departureEligibility,reconcile,reconcileRecovery} from '../policy.mjs';
import {createDom,domExpression} from '../dom.mjs';import {plannerDom} from './fake-dom.mjs';
const fixture=JSON.parse(readFileSync(new URL('../fixtures/states.json',import.meta.url)));
const state=wear=>{const s=structuredClone(fixture.ready);s.fleet[0].wear=wear;Object.assign(s.maintenance.records[0],{wear,hoursToCheck:200});return s;};
globalThis.getComputedStyle=()=>({visibility:'visible'});
test('effective repair setting is 20 and eligibility is inclusive at exactly 20%',()=>{
 assert.equal(settings.repairWearThreshold,20);
 for(const wear of [0,9,12.5,19.99,20,20.01,25]){
  const s=state(wear),due=wear>=20;assert.equal(maintenanceEligibility(s,'N-TEST001','repair').eligible,due);
  assert.equal(requiredMaintenance(s,'N-TEST001'),due?'repair':null);
 }
});
test('final browser commit enforces the same inclusive boundary',()=>{
 for(const wear of [19.99,20,20.01]){
  delete globalThis.__am4HarnessAttempts;
  const p=plannerDom();p.row.dataset.wear=String(wear);const dom=createDom(p.doc),quote=dom.inspectPlanner('N-TEST001','repair','123');
  const result=dom.commit({registration:'N-TEST001',kind:'repair',id:'123',quote,actionId:'synthetic-threshold'});
  assert.equal(result.clicked,wear>=20);assert.equal(p.final.clicks,wear>=20?1:0);
 }
 delete globalThis.__am4HarnessAttempts;
 assert.match(domExpression('maintenance'),/\)\(document,20\)/);
});
test('20% does not count as restored condition for uncertain repair recovery',()=>{
 const before=state(25),a={aircraftId:'123',registration:'N-TEST001',kind:'repair',state:'UNKNOWN',before,scheduleSeen:true};
 for(const wear of [19.99,20,21,25]){
  const s=state(wear);assert.equal(reconcileRecovery(a,s).state,wear<20?'RESOLVED_CURRENT_UI':'UNKNOWN');
  assert.equal(reconcile(a,s).state,wear<20?'COMPLETED_VERIFIED':'UNKNOWN');
 }
 const ambiguous=state(19.99);ambiguous.schedule.complete=false;assert.equal(reconcileRecovery(a,ambiguous).state,'UNKNOWN');
});
test('A-check priority, disabled repair, exclusion and departure limits remain unchanged',()=>{
 const s=state(20);s.maintenance.records[0].hoursToCheck=20;assert.equal(requiredMaintenance(s,'N-TEST001'),'check');
 s.maintenance.records[0].hoursToCheck=21;assert.equal(requiredMaintenance(s,'N-TEST001'),'repair');
 s.maintenance.records[0].availableActions=[];assert.equal(maintenanceEligibility(s,'N-TEST001','repair').eligible,false);
 assert.equal(departureEligibility(s,'N-TEST001',[],2).eligible,true);assert.equal(departureEligibility(s,'N-TEST001',[],21).eligible,false);
 assert.equal(departureEligibility(s,'N-TEST001',[{state:'UNKNOWN'}],2).eligible,false);
 s.fleet[0].registration='N-145';s.maintenance.records[0].registration='N-145';assert.equal(maintenanceEligibility(s,'N-145','repair').eligible,false);
});
