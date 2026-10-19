// All account values and aircraft identities in this file are synthetic; N-145 is an intentional policy exclusion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync,spawn } from 'node:child_process';
import { fileURLToPath,pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { OperatorControl,guardedExpression } from './control.mjs';
const results=[];
function scenario(name,fn){test(name,async()=>{
 const root=mkdtempSync(join(tmpdir(),'am4-operator-'));const record={name,started:new Date().toISOString(),result:'PASS'};
 try{await fn(root);}catch(e){record.result='FAIL';record.reason=e.message;throw e;}finally{record.finished=new Date().toISOString();results.push(record);rmSync(root,{recursive:true,force:true});writeFileSync(new URL('./validation.json',import.meta.url),JSON.stringify(results,null,2));}
});}
scenario('Default is manual, no test or controller can silently acquire',root=>{
 const c=new OperatorControl(root);assert.equal(c.status().safeToUseGame,true);assert.throws(()=>c.acquire('AUTOMATIC'));assert.throws(()=>c.acquire('TESTING'));c.close();
});
scenario('A later manual pause wins over a delayed resume preflight',root=>{
 const c=new OperatorControl(root),d=new OperatorControl(root);try{const revision=c.status().revision;d.request('PAUSED/MANUAL');assert.throws(()=>c.request('AUTOMATIC',{expectedRevision:revision}),/OPERATOR_MODE_CHANGED_DURING_PREFLIGHT/);assert.equal(d.status().mode,'PAUSED/MANUAL');assert.equal(d.status().safeToUseGame,true);}finally{c.close();d.close();}
});
scenario('A later testing reservation wins over a delayed resume preflight',root=>{
 const c=new OperatorControl(root),d=new OperatorControl(root);try{const revision=c.status().revision;d.request('TESTING');assert.throws(()=>c.request('AUTOMATIC',{expectedRevision:revision}),/OPERATOR_MODE_CHANGED_DURING_PREFLIGHT/);assert.equal(d.status().mode,'TESTING');}finally{c.close();d.close();}
});
scenario('Unchanged preflight revision permits explicit resume and exclusive ownership',root=>{
 const c=new OperatorControl(root);try{const revision=c.status().revision;assert.equal(c.request('AUTOMATIC',{expectedRevision:revision}).mode,'AUTOMATIC');const owner=c.acquire('AUTOMATIC');assert.throws(()=>c.acquire('AUTOMATIC'),/INTERFACE_ALREADY_OWNED/);c.release(owner.token);}finally{c.close();}
});
scenario('Idle pause releases immediately and old worker cannot resume',root=>{
 const c=new OperatorControl(root);c.request('TESTING');const a=c.acquire('TESTING');assert.equal(c.request('PAUSED/MANUAL').safeToUseGame,true);assert.throws(()=>c.begin(a.token,'next'));c.close();const reopened=new OperatorControl(root);assert.equal(reopened.status().mode,'PAUSED/MANUAL');reopened.close();
});
scenario('Only one owner across independent database connections',root=>{
 const c=new OperatorControl(root),d=new OperatorControl(root);
 try{c.request('AUTOMATIC');const a=c.acquire('AUTOMATIC');assert.throws(()=>d.acquire('AUTOMATIC'));c.begin(a.token,'active commit');const step=c.step(a.token,'commit','1',{irreversible:true});c.endStep(a.token,{implicit:step.implicit});d.request('TESTING');assert.throws(()=>d.acquire('TESTING'));c.end(a.token);const b=d.acquire('TESTING');d.release(b.token);}finally{c.close();d.close();}
});
scenario('Pause waits for an in-flight read then denies all further UI',root=>{
 const c=new OperatorControl(root);c.request('TESTING');const a=c.acquire('TESTING');c.begin(a.token,'Inspect schedule');const lease=c.step(a.token,'read','(()=>true)()');assert.equal(c.request('PAUSED/MANUAL').safeToUseGame,false);const s=c.endStep(a.token,{implicit:lease.implicit});assert.equal(s.safeToUseGame,true);assert.throws(()=>c.step(a.token,'next','1'));c.close();
});
scenario('Submitted action may verify after pause, but no new commit can start',root=>{
 const c=new OperatorControl(root);c.request('AUTOMATIC');const a=c.acquire('AUTOMATIC');c.begin(a.token,'Repair N-TEST006');let lease=c.step(a.token,'submit','1',{irreversible:true});c.endStep(a.token,{implicit:lease.implicit});assert.equal(c.request('PAUSED/MANUAL').safeToUseGame,false);assert.throws(()=>c.step(a.token,'second submit','1',{irreversible:true}));lease=c.step(a.token,'verify','1');c.endStep(a.token,{implicit:lease.implicit});assert.equal(c.end(a.token,'SCHEDULED').safeToUseGame,true);assert.equal(c.status().lastCompletedAction,'Repair N-TEST006');assert.throws(()=>c.begin(a.token,'next'));c.close();
});
scenario('Paused planner/confirmation can be cancelled without waiting for user input',root=>{
 const c=new OperatorControl(root);c.request('TESTING');const a=c.acquire('TESTING');c.begin(a.token,'Plan repair');assert.equal(c.request('PAUSED/MANUAL').safeToUseGame,true);assert.throws(()=>c.step(a.token,'commit','1',{irreversible:true}));c.close();
});
scenario('Stale heartbeat forces manual mode and quarantines delayed clicks',root=>{
 let now=1000;const c=new OperatorControl(root,{now:()=>now,alive:()=>true});c.request('TESTING');const a=c.acquire('TESTING');c.begin(a.token,'Test');c.step(a.token,'commit','1',{irreversible:true});now+=31000;const state=c.status();assert.equal(state.owner,null);assert.equal(state.mode,'PAUSED/MANUAL');assert.ok(state.uncertainty);assert.equal(state.safeToUseGame,true);assert.throws(()=>c.heartbeat(a.token));c.close();
});
scenario('Unknown command outcome never immediately claims safe release',root=>{
 let now=1000;const c=new OperatorControl(root,{now:()=>now,alive:()=>true});c.request('TESTING');const a=c.acquire('TESTING');const lease=c.step(a.token,'commit','1',{irreversible:true});c.endStep(a.token,{implicit:lease.implicit,outcome:'UNKNOWN'});c.release(a.token);assert.equal(c.status().safeToUseGame,false);assert.throws(()=>c.request('AUTOMATIC'));now+=20001;assert.equal(c.status().safeToUseGame,true);assert.ok(c.status().uncertainty);c.close();
});
scenario('Expired/superseded programmatic clicks are blocked without changing manual clicks',()=>{
 class Element{click(){this.count=(this.count||0)+1;}}const e=new Element();const context={HTMLElement:Element,e,Date:{now:()=>1000}};
 assert.equal(vm.runInNewContext(guardedExpression('(()=>{e.click();return e.count;})()','a',2000),context),1);
 assert.throws(()=>vm.runInNewContext(guardedExpression('(()=>{e.click();return e.count;})()','b',999),context));assert.equal(e.count,1);e.click();assert.equal(e.count,2);
});
scenario('Browser clock skew is compensated without extending the host lease',root=>{
 const now=Date.now(),offset=7200000;const c=new OperatorControl(root,{now:()=>now});c.request('TESTING');const owner=c.acquire('TESTING');const lease=c.step(owner.token,'read','(()=>{e.click();return true;})()',{browserOffsetMs:offset});
 class Element{click(){this.clicked=true;}}const e=new Element();assert.equal(vm.runInNewContext(lease.expression,{HTMLElement:Element,e,Date:{now:()=>now+offset}}),true);assert.equal(e.clicked,true);assert.equal(lease.until,now+20000);c.endStep(owner.token,{implicit:true});c.release(owner.token);c.close();
});
scenario('PowerShell controller bridge shares real pause/verification state with Node',root=>{
 const c=new OperatorControl(root);c.request('AUTOMATIC');
 const lib=fileURLToPath(new URL('./Operator-Library.ps1',import.meta.url)).replaceAll("'","''");
 const script=`$ErrorActionPreference='Stop';. '${lib}';$script:AM4OperatorRoot='${root.replaceAll("'","''")}';Start-AM4Operator;try{Enter-AM4OperatorGroup 'Sample maintenance';$script:AM4OperatorIrreversible=$true;$lease=Start-AM4OperatorStep '(()=>JSON.stringify({ok:true}))()';$null=Invoke-AM4Control 'pause';Stop-AM4OperatorStep $lease;$verification=Start-AM4OperatorStep '(()=>JSON.stringify({ok:true}))()';Stop-AM4OperatorStep $verification;Exit-AM4OperatorGroup 'SCHEDULED';$s=Invoke-AM4Control 'status';if(!$s.safeToUseGame){throw 'Pause did not acknowledge'};Write-Output 'BRIDGE_PASS'}finally{Stop-AM4Operator}`;
 const output=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{encoding:'utf8',windowsHide:true});assert.match(output,/BRIDGE_PASS/);assert.equal(c.status().safeToUseGame,true);c.close();
});
scenario('Real crashed owner is detected and cannot leave a misleading ACTIVE display',async root=>{
 const module=pathToFileURL(fileURLToPath(new URL('./control.mjs',import.meta.url))).href;
 const script=`import{OperatorControl}from ${JSON.stringify(module)};const c=new OperatorControl(${JSON.stringify(root)});c.request('TESTING');const a=c.acquire('TESTING');c.begin(a.token,'Simulated action');c.step(a.token,'commit','1',{irreversible:true});console.log('READY');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('WORKER_TIMEOUT')),5000);child.stdout.once('data',()=>{clearTimeout(timer);resolve()});child.once('error',reject)});await new Promise(resolve=>{child.once('exit',resolve);child.kill()});
 const c=new OperatorControl(root);const s=c.status();assert.equal(s.mode,'PAUSED/MANUAL');assert.equal(s.owner,null);assert.equal(s.safeToUseGame,false);assert.match(s.display,/UNCERTAIN/);assert.ok(s.uncertainty);c.close();}finally{child.kill();}
});
