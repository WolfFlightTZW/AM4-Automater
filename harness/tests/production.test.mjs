import{fileURLToPath}from'node:url';
// Synthetic identities and account values only. These tests never connect to AM4.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectProcesses,inventoryCommand,assertNoConflicts} from '../processes.mjs';
import {PassPerformance,requiresRecoveryBackoff,defaultMaxDepartures} from '../performance.mjs';
import {departureEligibility,maintenanceEligibility,maintenanceChoice,reconcileRecovery} from '../policy.mjs';
import {createDom} from '../dom.mjs';
import {readSource,renderBlock} from '../source.mjs';
import {Runner} from '../runner.mjs';
import {Store,compactAction} from '../store.mjs';
import {parseArgs} from '../main.mjs';
import {Element,plannerDom} from './fake-dom.mjs';
const fixture=JSON.parse(readFileSync(new URL('../fixtures/states.json',import.meta.url)));
const source=readSource(process.env.AM4_SOURCE_ROOT||fileURLToPath(new URL('../../',import.meta.url)));
const snapshot=()=>structuredClone(fixture.completed);
const record=()=>({id:'synthetic-action',registration:'N-TEST001',aircraftId:'123',kind:'repair',state:'UNKNOWN',quote:{cost:2400},before:structuredClone(fixture.ready),scheduleSeen:false});
const inventory=(extra={})=>({elevated:false,processes:[{pid:7001,name:'node.exe',commandLine:'node.exe -e synthetic'}],connections:[],tcpInspectionComplete:true,...extra});
const executeResult=s=>({stdout:JSON.stringify(s)});
globalThis.getComputedStyle=()=>({visibility:'visible'});

test('timeout gets one read-only retry; successful full inventory required',async()=>{
 let n=0;const s=await inspectProcesses({platform:'win32',selfPid:7001,sleep:async()=>{},execute:async()=>{if(++n===1)throw Object.assign(Error('never expose this text'),{killed:true,signal:'SIGTERM',stdout:'{"phase":"TCP"}\n'});return executeResult(inventory());}});
 assert.equal(n,2);assert.equal(s.inspection.attempts,2);assert.equal(s.inspection.recoveredFailures[0].phase,'TCP');assert.equal(s.inspection.recoveredFailures[0].failure,'TIMEOUT');
});
test('persistent timeouts fail closed with exact safe phase evidence',async()=>{
 let n=0;await assert.rejects(inspectProcesses({platform:'win32',selfPid:7001,sleep:async()=>{},execute:async()=>{n++;throw Object.assign(Error('sensitive error text'),{killed:true,stdout:'{"phase":"TCP"}\n{"phase":"PROCESS"}\n'});}}),e=>e.message==='CONCURRENCY_INSPECTION_UNAVAILABLE'&&e.processDiagnostics.attempts.length===2&&e.processDiagnostics.attempts[1].phase==='PROCESS'&&!JSON.stringify(e.processDiagnostics).includes('sensitive'));assert.equal(n,2);
});
for(const error of ['PROCESS_INSPECTION_UNAVAILABLE','CDP_CLIENT_INSPECTION_UNAVAILABLE'])test(error+' never grants permission or gets an automatic retry',async()=>{
 let n=0;await assert.rejects(inspectProcesses({platform:'win32',selfPid:7001,execute:async()=>{n++;throw Object.assign(Error('query failure'),{stdout:JSON.stringify({error}),code:2});}}),e=>e.message===error);assert.equal(n,1);
});
test('malformed or incomplete retry responses cannot pass inspection',async()=>{
 for(const stdout of ['garbage',JSON.stringify(inventory({tcpInspectionComplete:false})),JSON.stringify(inventory({processes:[]}))])await assert.rejects(inspectProcesses({platform:'win32',selfPid:7001,execute:async()=>({stdout})}));
});
test('a competitor discovered after timeout still blocks',async()=>{
 let n=0;const s=await inspectProcesses({platform:'win32',selfPid:7001,sleep:async()=>{},execute:async()=>{if(++n===1)throw Object.assign(Error(),{killed:true});return executeResult(inventory({processes:[...inventory().processes,{pid:7002,name:'node.exe',commandLine:'node.exe harness/production.mjs'}]}));}});assert.throws(()=>assertNoConflicts(s,{selfPid:7001}),/CONTROLLER_OR_LEGACY/);
});
test('provider filters sockets and processes; unknown TCP states remain visible',()=>{assert.match(inventoryCommand,/-Filter 'RemotePort = 9222'/);assert.match(inventoryCommand,/Win32_Process -Filter/);assert.match(inventoryCommand,/@\(1,2,11,100\)/);assert.match(inventoryCommand,/10\{'LastAck'\}/);assert.match(inventoryCommand,/default\{'Unknown'\}/);});

test('only isolated known maintenance uncertainty uses normal cadence; holds are unchanged',()=>{
 const a=record(),before=JSON.stringify(a);assert.equal(requiresRecoveryBackoff([a]),false);assert.equal(JSON.stringify(a),before);
 for(const b of [{...a,kind:'departure'},{...a,kind:'purchase'},{...a,aircraftId:null},{...a,quote:{}},{...a,quote:{cost:-1}}])assert.equal(requiresRecoveryBackoff([b]),true);
 assert.equal(requiresRecoveryBackoff([a],{scheduleComplete:false}),true);assert.equal(requiresRecoveryBackoff([a],{maintenanceComplete:false}),true);assert.equal(requiresRecoveryBackoff([]),false);assert.equal(requiresRecoveryBackoff([a,{...a,kind:'purchase'}]),true);
});
test('normal launcher and worker default to twenty departures, preserving bounds',()=>{assert.equal(defaultMaxDepartures,20);assert.match(readFileSync(new URL('../../Start-AM4.ps1',import.meta.url),'utf8'),/MaxDeparturesPerPass=20/);const worker=readFileSync(new URL('../production.mjs',import.meta.url),'utf8');assert.match(worker,/maxDepartures>30/);assert.match(worker,/Date.now\(\)>passDeadline-15000/);assert.match(worker,/verifiedDepartures.length>=maxDepartures/);});

test('renamed aircraft joins maintenance by current ID rather than name/casing',()=>{
 const s=snapshot();s.fleet[0].registration='RetireSoon';s.maintenance.records[0].registration='RETIRESOON';assert.equal(departureEligibility(s,'RetireSoon',[],1).eligible,true);assert.equal(parseArgs(['--registration','RetireSoon']).registration,'RetireSoon');assert.doesNotThrow(()=>renderBlock(source.blocks.selectJs,'RetireSoon'));
});
test('similar names and reused registrations never substitute a different aircraft ID',()=>{
 const s=snapshot();s.fleet[0].registration='RetireSoon';s.fleet[0].aircraftId='999';assert.equal(departureEligibility(s,'RetireSoon',[],1).eligible,false);
 s.maintenance.records[0].registration='RetireSoon';assert.equal(departureEligibility(s,'RetireSoon',[],1).eligible,false);
 const a=record();assert.equal(reconcileRecovery(a,s).state,'UNKNOWN');
});
test('duplicate or missing current IDs fail closed',()=>{
 const s=snapshot();s.fleet.push({...s.fleet[0],registration:'SimilarName'});assert.equal(departureEligibility(s,'N-TEST001',[],1).eligible,false);s.fleet.pop();delete s.fleet[0].aircraftId;assert.equal(departureEligibility(s,'N-TEST001',[],1).eligible,false);
});
test('N-145 name and freshly verified ID exclusion survive different display labels',()=>{
 const s=snapshot();s.fleet[0].registration='N-145';assert.equal(departureEligibility(s,'N-145',[],1).eligible,false);s.fleet[0].registration='RenamedExcluded';s.maintenance.records[0].registration='N-145';assert.equal(departureEligibility(s,'RenamedExcluded',[],1).eligible,false);s.maintenance.records[0].registration='RENAMED';s.excludedAircraftIds=['123'];assert.equal(departureEligibility(s,'RenamedExcluded',[],1).eligible,false);
});
test('repair requires >9 wear and actual enabled repair control',()=>{
 const s=structuredClone(fixture.ready);assert.equal(maintenanceEligibility(s,'N-TEST001','repair').eligible,true);s.maintenance.records[0].availableActions=[];assert.equal(maintenanceEligibility(s,'N-TEST001','repair').eligible,false);s.maintenance.records[0].availableActions=['repair'];s.maintenance.records[0].wear=9;assert.equal(maintenanceEligibility(s,'N-TEST001','repair').eligible,false);
});
test('non-prefixed schedule calendar labels use the current aircraft ID',()=>{
 const label=new Element({text:'RetireSoon',attrs:{onclick:"Ajax('routes_main.php?mode=details&id=123','x')"}}),bar=new Element({text:'Repair',attrs:{onclick:'maintDetails(999);'}}),row=new Element({queries:{'[onclick]':[bar]}});
 const root=new Element({queries:{'#maintCal':[new Element()],'#maintDetail':[new Element()],'#maintCal .maintRegBox':[label],'#calContainer .maintBox':[row]}}),doc=new Element({queries:{'#maintAction':[root]}});
 const result=createDom(doc).schedule();assert.equal(result.complete,true);assert.equal(result.entries[0].registration,'RetireSoon');assert.equal(result.entries[0].aircraftId,'123');
 const s=snapshot();s.schedule=result;assert.equal(departureEligibility(s,'N-TEST001',[],1).eligible,false);
});
function departurePage(){
 const row=new Element({id:'flightStatus123',data:{reg:'RetireSoon',grounded:'0'},queries:{'[id^="flightStatusWear"]':[new Element({text:'0.00'})],'[id^="flightStatusCounter"]':[new Element({text:'landed'})]}});
 const button=new Element({id:'flightInfoDepart999',text:'Depart'}),details=new Element({text:'Details',attrs:{onclick:"popup('routes_main.php?mode=details&id=123','Details');"}}),panel=new Element({text:'RetireSoon Flight time 02:30:00'});
 const doc=new Element({queries:{'#flightInfo':[panel],'#flightInfo button,#flightInfo a':[details,button],'.flight-list[data-reg]':[row],'#landedList .flight-list[data-reg],#parkedList .flight-list[data-reg]':[row],'button':[button]}});doc.body={innerText:'RetireSoon 0.00% worn'};return {row,button,details,panel,doc};
}
test('flight panel separates aircraft ID from route ID and recognizes renamed aircraft duration',()=>{const p=departurePage(),f=createDom(p.doc).flight();assert.equal(f.aircraftId,'123');assert.equal(f.routeId,'999');assert.deepEqual(f.registrations,['RetireSoon']);assert.equal(f.hours,2.5);});
test('disabled Depart control never grants flight identity or permission',()=>{const p=departurePage();p.button.disabled=true;assert.equal(createDom(p.doc).flight().aircraftId,null);assert.equal(JSON.parse(vm.runInNewContext(renderBlock(source.blocks.departJs,'RetireSoon',null,'123'),{document:p.doc})).ok,false);assert.equal(p.button.clicks,0);});
test('ambiguous current aircraft selection fails without guessing identity',()=>{const p=departurePage();p.doc.queries['.flight-list[data-reg]'].push(p.row);assert.deepEqual(createDom(p.doc).flight().registrations,[]);assert.equal(JSON.parse(vm.runInNewContext(renderBlock(source.blocks.departJs,'RetireSoon',null,'123'),{document:p.doc})).ok,false);assert.equal(p.button.clicks,0);});
test('departure binds Details aircraft ID even when route ID differs',()=>{const p=departurePage();assert.equal(JSON.parse(vm.runInNewContext(renderBlock(source.blocks.departJs,'RetireSoon',null,'123'),{document:p.doc})).ok,true);assert.equal(p.button.clicks,1);});
test('a different Details target or a control outside selected panel cannot depart',()=>{for(const wrong of ['details','outside']){const p=departurePage();if(wrong==='details')p.details.attrs.onclick="popup('routes_main.php?mode=details&id=456','Details');";else p.doc.queries['#flightInfo button,#flightInfo a']=[p.details];assert.equal(JSON.parse(vm.runInNewContext(renderBlock(source.blocks.departJs,'RetireSoon',null,'123'),{document:p.doc})).ok,false);assert.equal(p.button.clicks,0);}});
test('planner identity is independent of maintenance display-name casing',()=>{const p=plannerDom({reg:'RetireSoon',rowReg:'RETIRESOON'});const d=createDom(p.doc);assert.equal(d.inspectPlanner('RetireSoon','repair','123').ok,true);assert.equal(d.inspectPlanner('RetireSoon','repair','999').ok,false);});

test('restored condition away from base resolves submission uncertainty, never claims historical completion',()=>{
 const a=record(),s=snapshot();s.maintenance.records[0].atBase=false;s.maintenance.records[0].wear=0;s.maintenance.records[0].hoursToCheck=180;
 const r=reconcileRecovery(a,s);assert.equal(r.state,'RESOLVED_CURRENT_UI');assert.equal(r.evidence.aircraftId,'123');assert.equal(r.evidence.wear,0);assert.equal(r.scheduleSeen,false);assert.equal(a.state,'UNKNOWN');
 assert.equal(maintenanceEligibility(s,'N-TEST001','repair',[a]).eligible,false);
});
test('reported wear alone, absent ID, changed identity or conflicting schedule cannot release uncertainty',()=>{
 const a=record();for(const mutate of [s=>{s.schedule.complete=false;},s=>{s.fleet=[];},s=>{s.maintenance.records[0].id='999';},s=>{s.schedule.entries=[{aircraftId:'123',registration:'Renamed',kind:'check'}];},s=>{s.maintenance.records[0].wear=20;}]){const s=snapshot();mutate(s);assert.equal(reconcileRecovery(a,s).state,'UNKNOWN');}
});
test('same aircraft renamed after submission can reconcile by durable ID only',()=>{const a=record(),s=snapshot();s.fleet[0].registration='RetireSoon';s.maintenance.records[0].registration='RETIRESOON';assert.equal(reconcileRecovery(a,s).state,'RESOLVED_CURRENT_UI');});
test('schedule acknowledges submission without creating a maintenance completion obligation',()=>{const a=record(),s=snapshot();s.schedule.entries=[{aircraftId:'123',registration:'Renamed',kind:'repair'}];const r=reconcileRecovery(a,s);assert.equal(r.state,'SCHEDULED_VERIFIED');const saved=compactAction({...a,...r});assert.equal(saved.before,undefined);assert.notEqual(r.state,'COMPLETED_VERIFIED');});
test('durable duplicate protection survives rename and restart without lifecycle tracking',()=>{
 const root=mkdtempSync(join(tmpdir(),'am4-id-hold-'));let store;
 try{store=new Store(root);const a=store.intent({registration:'N-TEST001',kind:'repair',aircraftId:'123',before:fixture.ready,quote:{cost:2400}});store.close();store=new Store(root);assert.equal(store.holds('RetireSoon',null,'123').length,1);assert.throws(()=>store.intent({registration:'RetireSoon',kind:'repair',aircraftId:'123'}),/UNRESOLVED/);const saved=store.get(a.id);saved.state='SCHEDULED_VERIFIED';store.saveAction(saved);assert.equal(store.get(a.id).before,undefined);assert.equal(store.unresolved().length,0);}finally{store?.close();rmSync(root,{recursive:true,force:true});}
});
test('bounded performance timings include failures and counters; action categories overlap explicitly',async()=>{let t=0;const p=new PassPerformance(()=>t);await p.measure('fleetScan',async()=>{t+=5;});await assert.rejects(p.measure('departureAction',async()=>{t+=20;throw Error('synthetic');}));p.counts.examined=1;const r=p.report();assert.equal(r.timings.fleetScan.durationMs,5);assert.equal(r.timings.departureAction.durationMs,20);assert.equal(r.counts.examined,1);assert.match(r.note,/overlap/);p.record('fuelInspection',1);assert.equal(r.timings.fuelInspection,undefined);});
test('immediate unchanged outer observation is consumed once; later action keeps a fresh precommit snapshot',async()=>{
 const r=new Runner({registration:'N-TEST001',maxSeconds:90,maxActions:1,live:true},source,{}),s=snapshot();s.captured=new Date().toISOString();r.sequence=42;r.dispatchSnapshot={sequence:42,value:s};r.holds=()=>[];r.pause=async()=>{};r.evaluate=async()=>({ok:true});r.dom=async()=>({aircraftId:'123',registrations:['N-TEST001'],hours:1});let snapshots=0;r.snapshot=async()=>{snapshots++;throw Error('FRESH_PRECOMMIT_REQUIRED');};r.confirm=async()=>{};await assert.rejects(r.departure({}),/FRESH_PRECOMMIT_REQUIRED/);assert.equal(snapshots,1);assert.equal(r.dispatchSnapshot,null);
});
test('stale or intervened outer observations are never reused',async()=>{for(const changed of [true,false]){const r=new Runner({registration:'N-TEST001',maxSeconds:90,maxActions:1,live:true},source,{});const s=snapshot();s.captured=new Date(Date.now()-(changed?0:5000)).toISOString();r.sequence=2;r.dispatchSnapshot={sequence:changed?1:2,value:s};r.snapshot=async()=>{throw Error('INITIAL_FRESH_REQUIRED');};await assert.rejects(r.departure({}),/INITIAL_FRESH_REQUIRED/);}});
test('production repair acknowledges once, returns immediately and never observes maintenance completion',async()=>{
 const root=mkdtempSync(join(tmpdir(),'am4-submission-only-'));const store=new Store(root);
 try{const r=new Runner({scenario:'Production',registration:'N-TEST001',live:true,maxSeconds:90,maxActions:1,waitSeconds:0,productionRoot:root},source,store);let reads=0,commits=0;r.snapshot=async()=>structuredClone(++reads<=2?fixture.ready:fixture.pending);r.holds=()=>[];r.guard={check:async()=>{}};r.confirm=async()=>{};r.verifySource=()=>{};r.pause=async()=>{};r.observeAction=async()=>{throw Error('PRODUCTION_MUST_NOT_TRACK_COMPLETION');};r.dom=async method=>{if(method==='openPlanner')return {ok:true,cost:2400,time:'00:05:00',row:structuredClone(fixture.ready.maintenance.records[0])};if(method==='commit'){commits++;return {clicked:true};}if(method==='response')return {text:'Scheduled'};throw Error('UNEXPECTED_DOM_METHOD');};
 const report=store.newCase('Repair','OFFLINE');await r.maintenance(report,'repair',false);assert.equal(commits,1);assert.equal(report.result,'PASS');assert.equal(store.get(report.checkpoint).state,'SCHEDULED_VERIFIED');assert.equal(store.get(report.checkpoint).before,undefined);assert.equal(store.unresolved().length,0);assert.equal(reads,3);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
test('case-varied maintenance observations retain ID-bound recovery evidence and immutable intent identity',()=>{
 const root=mkdtempSync(join(tmpdir(),'am4-recovery-id-'));const store=new Store(root);
 try{const before=structuredClone(fixture.ready);before.maintenance.records[0].registration='RETIRESOON';const a=store.intent({registration:'RetireSoon',aircraftId:'123',kind:'repair',before,quote:{cost:2400}});assert.equal(store.get(a.id).before.maintenance.records.length,1);assert.throws(()=>store.saveAction({...a,aircraftId:'999'}),/ILLEGAL_ACTION_TRANSITION/);}finally{store.close();rmSync(root,{recursive:true,force:true});}
});
test('unavailable maintenance falls through to departure even above nine percent wear',()=>{const s=snapshot();s.fleet[0].wear=14;s.maintenance.records[0].wear=14;s.maintenance.records[0].atBase=false;s.maintenance.records[0].hoursToCheck=15;s.maintenance.records[0].availableActions=[];assert.equal(maintenanceChoice(s,'N-TEST001'),null);assert.equal(departureEligibility(s,'N-TEST001',[],2).eligible,true);});
test('maintenance priority is enabled due A-check, enabled due Repair, then departure',()=>{const s=structuredClone(fixture.ready);s.maintenance.records[0].atBase=false;assert.equal(maintenanceChoice(s,'N-TEST001'),'check');assert.equal(departureEligibility(s,'N-TEST001',[],2).eligible,false);s.maintenance.records[0].availableActions=['repair'];assert.equal(maintenanceChoice(s,'N-TEST001'),'repair');s.maintenance.records[0].availableActions=[];assert.equal(maintenanceChoice(s,'N-TEST001'),null);assert.equal(departureEligibility(s,'N-TEST001',[],2).eligible,true);});
test('unavailable A-check still requires a known flight strictly within remaining hours',()=>{const s=snapshot();s.maintenance.records[0].hoursToCheck=3;s.maintenance.records[0].availableActions=[];assert.equal(departureEligibility(s,'N-TEST001',[],2).eligible,true);for(const hours of [3,4,null])assert.equal(departureEligibility(s,'N-TEST001',[],hours).eligible,false);});
test('return-flight exception preserves holds, fuel, CO2, unknown values and exclusion',()=>{for(const change of [s=>{s.markets.fuel.holding=74999;},s=>{s.markets.co2.holding=74999;},s=>{s.maintenance.records[0].hoursToCheck=null;},s=>{s.fleet[0].registration='N-145';}]){const s=snapshot();s.fleet[0].wear=14;s.maintenance.records[0].wear=14;s.maintenance.records[0].availableActions=[];change(s);assert.equal(departureEligibility(s,s.fleet[0].registration,[],2).eligible,false);}const s=snapshot();assert.equal(departureEligibility(s,'N-TEST001',[{state:'UNKNOWN'}],2).eligible,false);});
test('proven select and departure adapters permit high wear when Depart is enabled',()=>{const p=departurePage();p.row.queries['[id^="flightStatusWear"]'][0].textContent='14.00';p.doc.body.innerText='RetireSoon 14.00% worn';assert.equal(JSON.parse(vm.runInNewContext(renderBlock(source.blocks.selectJs,'RetireSoon',null,'123'),{document:p.doc})).ok,true);assert.equal(JSON.parse(vm.runInNewContext(renderBlock(source.blocks.departJs,'RetireSoon',null,'123'),{document:p.doc})).ok,true);assert.equal(p.button.clicks,1);});
test('current enabled maintenance planner governs availability rather than at-base observation',()=>{delete globalThis.__am4HarnessAttempts;const p=plannerDom({id:'987654'});p.row.dataset.base='0';const d=createDom(p.doc),quote=d.inspectPlanner('N-TEST001','repair','987654');assert.equal(quote.ok,true);assert.equal(d.commit({registration:'N-TEST001',kind:'repair',id:'987654',quote,actionId:'synthetic-return-repair'}).clicked,true);delete globalThis.__am4HarnessAttempts;});
