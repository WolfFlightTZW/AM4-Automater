// Synthetic process/connection snapshots only. No CDP connections or production mutex acquisition.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {classifyConcurrency,assertNoConflicts,isControllerCommand,isNodeControllerCommand} from '../harness/processes.mjs';
import {preflight,diagnostics} from './process-diagnostics.mjs';
const opaque=(pid=9001)=>({pid,name:'powershell.exe',parentPid:8001,created:'2030-01-01T10:00:00.0000000Z',commandLine:null,executablePath:null});
const snapshot=(processes=[],connections=[])=>({elevated:false,processes,connections,tcpInspectionComplete:true});
const client=(pid=9001,state='Established')=>({pid,remoteAddress:'127.0.0.1',remotePort:9222,state});
const known=(commandLine,pid=9002,name='powershell.exe')=>({...opaque(pid),name,commandLine});
const scan=value=>assertNoConflicts(value,{selfPid:7001});

test('multiple unrelated elevated PowerShell sessions are warnings without mandatory attestation',async()=>{
 const s=snapshot([opaque(),opaque(9002),opaque(9003)]),r=await preflight({inspect:async()=>s,selfPid:7001});assert.equal(r.processes.length,0);assert.equal(r.warnings.length,3);assert.ok(r.warnings.every(w=>w.blocking===false&&w.reason==='OPAQUE_PROCESS_NO_AM4_EVIDENCE'));assert.match(r.limitation,/Hidden idle legacy scripts/);
});
test('missing opaque-shell creation metadata is diagnostic, not proof of an AM4 controller',()=>{const r=scan(snapshot([{...opaque(),created:null}]));assert.equal(r.processes.length,0);assert.ok(r.warnings[0].inspectionErrors.includes('CIM_CREATION_TIME_UNAVAILABLE'));});
for(const script of ['Start-AM4.ps1','AM4-Operations.ps1','AM4-Master-Synthetic.ps1','AM4-Continuous-Synthetic.ps1','AM4-Single-Repair-Synthetic.ps1'])test(`known launcher ${script} blocks even without creation metadata`,()=>{
 const p={...known(`powershell.exe -File "C:/Synthetic AM4/${script}"`),created:null};assert.throws(()=>scan(snapshot([p])),e=>e.message==='CONTROLLER_OR_LEGACY_SCRIPT_RUNNING'&&e.processDiagnostics.processes[0].pid===p.pid);
});
test('PowerShell file abbreviation and invoked command form identify known launchers',()=>{assert.equal(isControllerCommand('powershell -f Start-AM4.ps1'),true);assert.equal(isControllerCommand('powershell -Command & "C:/Synthetic AM4/Start-AM4.ps1"'),true);});
test('source filenames mentioned as data do not identify actual AM4 execution',()=>{
 assert.equal(isControllerCommand('powershell -Command Get-Content "C:/Synthetic AM4/Start-AM4.ps1"'),false);
 assert.equal(isNodeControllerCommand('node.exe -e "console.log(\'C:/Synthetic AM4/harness/production.mjs\')"'),false);
 scan(snapshot([known('powershell -Command Get-Content "C:/Synthetic AM4/Start-AM4.ps1"'),known('node.exe "C:/SyntheticTools/codex-runtime.mjs"',9003,'node.exe')]));
});
test('actual Node production workers and action-capable harnesses are conflicts',()=>{
 for(const command of ['node.exe "C:/Synthetic AM4/harness/production.mjs" --parent-pid 8001','node.exe --experimental-sqlite harness/production.mjs','node.exe harness/main.mjs --scenario InspectSchedule','node.exe harness/main.mjs --live --scenario Repair'])assert.throws(()=>scan(snapshot([known(command,9003,'node.exe')])),/CONTROLLER_OR_LEGACY_SCRIPT_RUNNING/);
});
test('offline harness and Node test commands do not block production',()=>{
 for(const command of ['node.exe harness/main.mjs --scenario Offline','node.exe harness/main.mjs --scenario SelfTest','node.exe harness/main.mjs --scenario Inventory','node.exe harness/main.mjs','node.exe --test harness/tests/offline.test.mjs'])scan(snapshot([known(command,9003,'node.exe')]));
});
test('an unreadable shell with a live CDP connection is a credible conflict',()=>{
 assert.throws(()=>scan(snapshot([opaque()],[client()])),e=>e.message==='FOREIGN_CDP_CLIENT_CONNECTED'&&e.processDiagnostics.processes[0].reason==='FOREIGN_CDP_CLIENT'&&e.processDiagnostics.processes[0].created===opaque().created);
});
test('foreign Codex-like Node and other-language clients are blocked by CDP ownership',()=>{
 for(const name of ['node.exe','python.exe'])assert.throws(()=>scan(snapshot([{...opaque(),name}],[client()])),/FOREIGN_CDP_CLIENT_CONNECTED/);
});
test('only this worker PID is exempt from the client check, never the allowed launcher parent',()=>{
 const s=snapshot([known('node.exe harness/production.mjs',7001,'node.exe')],[client(7001)]);assert.equal(scan(s).processes.length,0);
 assert.throws(()=>assertNoConflicts(snapshot([opaque()],[client()]),{selfPid:7001,ignoreControllerPids:[9001]}),/FOREIGN_CDP_CLIENT_CONNECTED/);
});
test('legitimate launcher parent does not hide a different actual worker',()=>{
 const parent=known('powershell.exe -File Start-AM4.ps1',8001),other=known('node.exe harness/production.mjs',9003,'node.exe');
 assert.throws(()=>assertNoConflicts(snapshot([parent,other]),{selfPid:7001,ignoreControllerPids:[8001]}),/CONTROLLER_OR_LEGACY_SCRIPT_RUNNING/);
});
test('server listener and closed/time-wait sockets are not active competing clients',()=>{
 for(const state of ['Listen','Bound','Closed','TimeWait'])scan(snapshot([opaque()],[client(9001,state)]));
 scan(snapshot([opaque()],[{...client(),remotePort:0,state:'Listen'}]));
});
test('pending, established, closing and unresolved-state foreign CDP connections fail closed',()=>{
 for(const state of ['SynSent','SynReceived','Established','CloseWait','FinWait1','FinWait2','Closing','LastAck','Unknown'])assert.throws(()=>scan(snapshot([opaque()],[client(9001,state)])),/FOREIGN_CDP_CLIENT_CONNECTED/);
});
test('unknown, terminated or zero TCP owner is an unresolved conflict rather than a free port',()=>{
 for(const pid of [9001,0])assert.throws(()=>scan(snapshot([],[client(pid)])),e=>e.processDiagnostics.processes[0].reason==='CDP_CLIENT_OWNER_UNRESOLVED');
});
test('loopback IPv6 and mapped IPv4 clients are checked; unrelated ports are not AM4 evidence',()=>{
 for(const address of ['::1','::ffff:127.0.0.1'])assert.throws(()=>scan(snapshot([opaque()],[{...client(),remoteAddress:address}])),/FOREIGN_CDP_CLIENT_CONNECTED/);
 scan(snapshot([opaque()],[{...client(),remotePort:9229}]));
});
test('partial or inaccessible process/TCP inventory fails closed',async()=>{
 for(const bad of [{...snapshot(),connections:undefined},{...snapshot(),tcpInspectionComplete:false},snapshot([],[{...client(),pid:'*'}])])assert.throws(()=>scan(bad),/CONCURRENCY_INSPECTION_UNAVAILABLE/);
 await assert.rejects(preflight({inspect:async()=>{throw new Error('CDP_CLIENT_INSPECTION_UNAVAILABLE');}}),/CDP_CLIENT_INSPECTION_UNAVAILABLE/);
});
test('fresh resume inspection catches a shell that becomes an AM4 actor or client',async()=>{
 let current=snapshot([opaque()]);const inspect=async()=>current;await preflight({inspect,selfPid:7001});current=snapshot([known('powershell.exe -File Start-AM4.ps1',9001)]);await assert.rejects(preflight({inspect,selfPid:7001}),/CONTROLLER_OR_LEGACY_SCRIPT_RUNNING/);current=snapshot([opaque()],[client()]);await assert.rejects(preflight({inspect,selfPid:7001}),/FOREIGN_CDP_CLIENT_CONNECTED/);
});
test('a reused PID has no approval privilege and is evaluated from current evidence',()=>{
 scan(snapshot([{...opaque(),created:'2030-01-02T10:00:00.0000000Z'}]));assert.throws(()=>scan(snapshot([{...opaque(),created:'2030-01-02T10:00:00.0000000Z'}],[client()])),/FOREIGN_CDP_CLIENT_CONNECTED/);
});
test('observed client disconnect resolves its connection evidence without a permanent PID blacklist',()=>{
 assert.throws(()=>scan(snapshot([opaque()],[client()])),/FOREIGN_CDP_CLIENT_CONNECTED/);assert.equal(scan(snapshot([opaque()])).processes.length,0);
});
test('old, corrupt or expired approval files are neither required nor modified',async()=>{
 const root=mkdtempSync(join(tmpdir(),'am4-legacy-approval-test-'));try{const p=join(root,'legacy-exclusion.json');writeFileSync(p,'SYNTHETIC_OBSOLETE_APPROVAL');await preflight({inspect:async()=>snapshot([opaque()]),selfPid:7001});assert.equal(readFileSync(p,'utf8'),'SYNTHETIC_OBSOLETE_APPROVAL');}finally{rmSync(root,{recursive:true,force:true});}
});
test('diagnostics retain exact identities and warnings without raw private command data',async()=>{
 const p={...known('powershell -File AM4-Master-Synthetic.ps1 -Token SYNTHETIC_PRIVATE_VALUE'),executablePath:'C:/SyntheticPrivate/powershell.exe'},r=await diagnostics({inspect:async()=>snapshot([p]),selfPid:7001});assert.equal(r.processes[0].pid,p.pid);assert.equal(r.processes[0].created,p.created);assert.ok(!JSON.stringify(r).includes('SYNTHETIC_PRIVATE_VALUE'));assert.ok(!JSON.stringify(r).includes(p.executablePath));
});
test('diagnostics distinguish opaque warnings from credible conflicts in the same snapshot',()=>{
 const r=classifyConcurrency(snapshot([opaque(),known('powershell.exe -File Start-AM4.ps1',9002)]),{selfPid:7001});assert.equal(r.warnings.length,1);assert.equal(r.processes.length,1);assert.equal(r.processes[0].pid,9002);
});
