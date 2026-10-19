// All process identities, commands and timestamps below are synthetic; no live processes are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {processBlockers} from '../harness/processes.mjs';
import {prepareReview,reviewProcesses,preflight,diagnostics,approvalsValid,APPROVAL_MS,REVIEW_MS} from './process-attestation.mjs';
const NOW=Date.parse('2030-01-01T12:00:00.000Z');
const hidden={pid:9001,name:'powershell.exe',created:'2030-01-01T10:00:00.0000000Z',commandLine:null,executablePath:null};
const visible={...hidden,commandLine:'powershell.exe -File Synthetic-Local-Task.ps1',executablePath:'C:/SyntheticTools/powershell.exe'};
const snapshot=(p=hidden,elevated=false)=>({elevated,processes:p?[p]:[]});
const file=root=>join(root,'legacy-exclusion.json');
const read=root=>JSON.parse(readFileSync(file(root),'utf8'));
const confirmed=()=>Promise.resolve('UNRELATED 9001');
async function temporary(fn){const root=mkdtempSync(join(tmpdir(),'am4-attestation-test-'));try{return await fn(root);}finally{rmSync(root,{recursive:true,force:true});}}
async function prepared(root){return prepareReview(root,{inspect:async()=>snapshot(),now:NOW});}
async function approved(root){await prepared(root);return reviewProcesses(root,{inspect:async()=>snapshot(visible,true),confirm:confirmed,clock:()=>NOW});}

test('operator diagnostics identify exact blockers/errors without persisting commands',()=>temporary(async root=>{
  const r=await diagnostics(root,{inspect:async()=>snapshot()});assert.equal(r.processes[0].pid,hidden.pid);assert.equal(r.processes[0].created,hidden.created);assert.equal(r.processes[0].approved,false);assert.deepEqual(r.processes[0].inspectionErrors,['CIM_COMMAND_LINE_UNAVAILABLE','CIM_EXECUTABLE_PATH_UNAVAILABLE']);assert.ok(!('commandLine' in r.processes[0]));assert.equal(existsSync(file(root)),false);
}));
test('Node runtimes are outside the PowerShell concurrency inventory',()=>{assert.deepEqual(processBlockers(snapshot({...hidden,name:'node.exe'})),[]);});
test('review preparation creates a bounded request and never an approval',()=>temporary(async root=>{
  const r=await prepared(root);assert.equal(r.result,'ELEVATED_REVIEW_REQUIRED');assert.equal(Date.parse(r.expiresAt)-NOW,REVIEW_MS);assert.equal(existsSync(file(root)),false);
}));
test('preparation cannot mistake an administrator inventory for the normal-user blockers',()=>temporary(async root=>{await assert.rejects(prepareReview(root,{inspect:async()=>snapshot(visible,true),now:NOW}),/PREPARE_REVIEW_FROM_NORMAL_NONADMIN_SESSION/);assert.equal(existsSync(join(root,'process-review-request.json')),false);}));
test('explicit elevated review re-enumerates before saving exact instance-bound approvals',()=>temporary(async root=>{
  await prepared(root);let calls=0,confirmations=0;const result=await reviewProcesses(root,{inspect:async()=>{calls++;return snapshot(visible,true);},confirm:async p=>{confirmations++;assert.equal(p.commandLine,visible.commandLine);return 'UNRELATED 9001';},clock:()=>NOW});assert.equal(calls,2);assert.equal(confirmations,1);assert.equal(result.result,'APPROVED_NOT_RESUMED');const saved=read(root);assert.equal(approvalsValid(saved,[hidden],NOW),true);assert.equal(Date.parse(saved.processes[0].expiresAt)-NOW,APPROVAL_MS);assert.ok(!JSON.stringify(saved).includes(visible.commandLine));assert.ok(!JSON.stringify(saved).includes(visible.executablePath));
}));
test('unapproved, PID-only, wildcard, legacy and expired approvals are rejected',()=>temporary(async root=>{
  assert.equal(approvalsValid({schema:2,processes:[]},[hidden],NOW),false);await approved(root);const original=read(root);
  for(const change of [p=>delete p.created,p=>p.pid='*',p=>p.created='*',p=>p.expiresAt=new Date(NOW).toISOString(),p=>p.reviewedAt=new Date(NOW+1000).toISOString(),p=>p.expiresAt=new Date(NOW+APPROVAL_MS+1).toISOString()]){const value=structuredClone(original);change(value.processes[0]);assert.equal(approvalsValid(value,[hidden],NOW),false);}
  assert.equal(approvalsValid({processes:[{pid:hidden.pid,created:hidden.created}]},[hidden],NOW),false);
}));
for(const [name,change]of [['terminated',()=>null],['PID reused',p=>({...p,created:'2030-01-01T11:00:00.0000000Z'})],['command changed',p=>({...p,commandLine:'powershell.exe -File Different-Synthetic-Task.ps1'})],['executable changed',p=>({...p,executablePath:'C:/DifferentSyntheticTools/powershell.exe'})],['became inaccessible',p=>({...p,commandLine:null})]]){
  test(`review refuses ${name} instance before writing`,()=>temporary(async root=>{
    await prepared(root);writeFileSync(file(root),'UNCHANGED_SYNTHETIC_PRIOR_APPROVAL');let calls=0;
    await assert.rejects(reviewProcesses(root,{inspect:async()=>snapshot(++calls===1?visible:change(visible),true),confirm:confirmed,clock:()=>NOW}),/PROCESS_TERMINATED_OR_INSTANCE_CHANGED|PROCESS_REVIEW_IDENTITY_CHANGED|ELEVATED_PROCESS_IDENTITY_UNREADABLE/);assert.equal(readFileSync(file(root),'utf8'),'UNCHANGED_SYNTHETIC_PRIOR_APPROVAL');
  }));
}
test('insufficient elevation or inaccessible elevated identities cannot be approved',()=>temporary(async root=>{
  await prepared(root);for(const state of [snapshot(visible,false),snapshot(hidden,true)])await assert.rejects(reviewProcesses(root,{inspect:async()=>state,confirm:confirmed,clock:()=>NOW}),/ELEVATED_PROCESS_INSPECTION_REQUIRED|ELEVATED_PROCESS_IDENTITY_UNREADABLE/);assert.equal(existsSync(file(root)),false);
}));
test('no confirmation, Enter and PID-only input never approve',()=>temporary(async root=>{
  await prepared(root);for(const confirm of [undefined,async()=>'',async()=> '9001'])await assert.rejects(reviewProcesses(root,{inspect:async()=>snapshot(visible,true),confirm,clock:()=>NOW}),/PROCESS_REVIEW_CANCELLED/);assert.equal(existsSync(file(root)),false);
}));
test('known AM4 controllers and opaque encoded commands cannot be approved',()=>temporary(async root=>{
  await prepared(root);for(const commandLine of ['powershell.exe -File Start-AM4.ps1','powershell.exe -EncodedCommand SYNTHETIC','powershell.exe -e SYNTHETIC','powershell.exe -enco SYNTHETIC','powershell.exe -ec SYNTHETIC'])await assert.rejects(reviewProcesses(root,{inspect:async()=>snapshot({...visible,commandLine},true),confirm:confirmed,clock:()=>NOW}),/CONTROLLER_OR_LEGACY_SCRIPT_RUNNING|PROCESS_IDENTITY_REQUIRES_MANUAL_INVESTIGATION/);assert.equal(existsSync(file(root)),false);
}));
test('expired request and request replacement during human review are rejected',()=>temporary(async root=>{
  await prepared(root);await assert.rejects(reviewProcesses(root,{inspect:async()=>snapshot(visible,true),confirm:confirmed,clock:()=>NOW+REVIEW_MS}),/PROCESS_REVIEW_REQUEST_STALE_OR_INVALID/);
  await prepared(root);await assert.rejects(reviewProcesses(root,{inspect:async()=>snapshot(visible,true),confirm:async()=>{const p=join(root,'process-review-request.json'),r=JSON.parse(readFileSync(p));r.id='00000000-0000-0000-0000-000000000000';writeFileSync(p,JSON.stringify(r));return 'UNRELATED 9001';},clock:()=>NOW}),/PROCESS_REVIEW_REQUEST_CHANGED/);assert.equal(existsSync(file(root)),false);
}));
test('missing process creation identity fails closed without a review request',()=>temporary(async root=>{
  await assert.rejects(prepareReview(root,{inspect:async()=>snapshot({...hidden,created:null}),now:NOW}),/PROCESS_INSTANCE_IDENTITY_UNAVAILABLE/);assert.equal(existsSync(join(root,'process-review-request.json')),false);
}));
test('resume preflight re-enumerates and refuses reused, new, expired or changed instances',()=>temporary(async root=>{
  // Use current time for the real preflight clock, with otherwise invented process identity.
  await prepareReview(root,{inspect:async()=>snapshot()});await reviewProcesses(root,{inspect:async()=>snapshot(visible,true),confirm:confirmed});
  let reads=0;await preflight(root,{inspect:async()=>{reads++;return snapshot();}});assert.equal(reads,1);
  await assert.rejects(preflight(root,{inspect:async()=>snapshot({...hidden,created:'2031-01-01T10:00:00.0000000Z'})}),/UNREADABLE_PROCESSES/);
  await assert.rejects(preflight(root,{inspect:async()=>snapshot({...hidden,pid:9002})}),/UNREADABLE_PROCESSES/);
  await assert.rejects(preflight(root,{inspect:async()=>snapshot({...visible,commandLine:'powershell.exe -File Changed-Synthetic-Task.ps1'})}),/PROCESS_REVIEW_IDENTITY_CHANGED/);
  await assert.rejects(preflight(root,{inspect:async()=>snapshot({...visible,commandLine:'powershell.exe -File Start-AM4.ps1'})}),/CONTROLLER_OR_LEGACY_SCRIPT_RUNNING/);
  const saved=read(root);saved.processes[0].expiresAt=new Date(Date.now()-1).toISOString();writeFileSync(file(root),JSON.stringify(saved));await assert.rejects(preflight(root,{inspect:async()=>snapshot()}),/UNREADABLE_PROCESSES/);
}));
test('CIM failure remains a hard error rather than a fabricated empty process list',()=>temporary(async root=>{await assert.rejects(preflight(root,{inspect:async()=>{throw new Error('PROCESS_INSPECTION_UNAVAILABLE');}}),/PROCESS_INSPECTION_UNAVAILABLE/);assert.equal(existsSync(file(root)),false);}));
test('invalid approval diagnostics remain inspectable and allow a fresh explicit review',()=>temporary(async root=>{writeFileSync(file(root),'SYNTHETIC_INVALID_APPROVAL');const r=await diagnostics(root,{inspect:async()=>snapshot()});assert.equal(r.approvalValid,false);assert.ok(r.inspectionErrors.includes('PROCESS_APPROVAL_FILE_INVALID'));assert.equal(r.processes[0].pid,hidden.pid);await assert.rejects(preflight(root,{inspect:async()=>snapshot()}),e=>e.message==='PROCESS_APPROVAL_FILE_INVALID'&&e.processDiagnostics.processes[0].pid===hidden.pid);await approved(root);assert.equal(approvalsValid(read(root),[hidden],NOW),true);}));
