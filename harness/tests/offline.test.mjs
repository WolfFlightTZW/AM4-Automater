// All account values and aircraft identities in this file are synthetic; N-145 is an intentional policy exclusion.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { Store, sanitize, readProductionHolds } from '../store.mjs';
import { readSource, extractBlock, renderBlock } from '../source.mjs';
import { wholeQuantity, verifyPurchase, maintenanceEligibility, departureEligibility, reconcile, validateReportIdentity } from '../policy.mjs';
import { createDom, domExpression } from '../dom.mjs';
import { parseArgs } from '../main.mjs';
import { bindPurchase, Runner } from '../runner.mjs';
import { Cdp } from '../cdp.mjs';
import { isControllerCommand } from '../guard.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Element, plannerDom } from './fake-dom.mjs';
import { fileURLToPath } from 'node:url';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/states.json', import.meta.url)));
const baseline = readFileSync(new URL('../fixtures/operations-baseline.ps1.txt', import.meta.url), 'utf8');
const source = process.env.AM4_SOURCE_ROOT ? readSource(process.env.AM4_SOURCE_ROOT) : { source: baseline, blocks: Object.fromEntries(['marketJs','fleetJs','maintJs','purchaseJsTemplate','selectJs','departJs','plannerJs'].map(n => [n, extractBlock(baseline, n)])) };
const temp = mkdtempSync(join(tmpdir(), 'am4-offline-'));
const reports = new Store(process.env.AM4_RESULTS || join(temp, 'reports'));
globalThis.getComputedStyle = () => ({ visibility: 'visible' });
function clone(value) { return structuredClone(value); }
function check(name, startingState, action, fn) {
  test(name, async () => {
    const report = reports.newCase(name, 'OFFLINE'); report.startingState = startingState;
    report.actionAttempted = { name: action, submitted: false }; report.gameResponse = { source: 'SAVED_OR_SYNTHETIC_FIXTURE', liveGame: false };
    try { const value = await fn(); report.endingState = value ?? { assertions: 'passed' }; report.result = 'PASS'; report.reason = 'ASSERTIONS_PASSED'; }
    catch (e) { report.endingState = { assertions: 'failed' }; report.result = 'FAIL'; report.reason = e.message; throw e; }
    finally { reports.finish(report); }
  });
}
after(() => { reports.close(); rmSync(temp, { recursive: true, force: true }); delete globalThis.__am4HarnessAttempts; });

check('CLI defaults are offline with one action maximum', {}, 'ParseArgs', () => {
  const args = parseArgs([]); assert.equal(args.scenario, 'Offline'); assert.equal(args.live, false); assert.equal(args.maxActions, 1);
  assert.deepEqual(args.steps, ['InspectMarkets','InspectAircraft','InspectSchedule','InspectEligibility']);
});
check('Controller detection parses invoked scripts rather than source filenames in arguments',{},'ClassifyControllerProcesses',()=>{
  assert.equal(isControllerCommand('powershell.exe -File "H:\\AM4 automate\\Start-AM4.ps1"'),true);
  assert.equal(isControllerCommand('powershell.exe -File AM4-N999-Single-Repair.ps1'),true);
  assert.equal(isControllerCommand('powershell.exe -Command & "H:\\AM4 automate\\AM4-Operations.ps1"'),true);
  assert.equal(isControllerCommand('powershell.exe -File "H:\\AM4 automate\\harness\\Run-AM4Tests.ps1"; Get-FileHash "H:\\AM4 automate\\AM4-Operations.ps1"'),false);
  assert.equal(isControllerCommand('powershell.exe -Command Get-Content "H:\\AM4 automate\\Start-AM4.ps1"'),false);
});
for (const args of [['--max-seconds','301'],['--wait-seconds','121'],['--max-actions','4'],['--scenario','Offline','--live'],['--scenario','PurchaseFuel','--live'],['--steps','PurchaseCO2'],['--steps','Departure'],['--registration','N-TEST001;exit'],['--scenario','NoSuchTest']])
  check('Reject unsafe arguments ' + args.join(' '), { args }, 'ParseArgs', () => assert.throws(() => parseArgs(args)));
check('Source extraction is data-only; no dot-sourcing', { source: 'saved PowerShell' }, 'ExtractExistingActions', () => {
  for (const block of Object.values(source.blocks)) assert.ok(block.trim());
  assert.throws(() => extractBlock('$wrong=1', 'marketJs'));
  for (const name of ['marketJs','fleetJs','maintJs','purchaseJsTemplate','selectJs','departJs']) {
    const block = renderBlock(source.blocks[name].replace('__KIND__','"co2"'), 'N-TEST001', 'repair'); new vm.Script(block);
  }
});
check('All external browser entry expressions compile', {}, 'CompileDOM', () => {
  for (const method of ['maintenance','schedule','navigate','openPlanner','commit','flight']) new vm.Script(domExpression(method, []));
  assert.throws(() => domExpression('arbitraryCode'));
});
check('Known production planner regex regression is reproduced', { handler: 'maint_plan_do.php?type=repair&id=123' }, 'EvaluateActualEmittedRegex', () => {
  const planner = source.blocks.plannerJs;
  const line = planner.split('\n').find(s => s.includes('const bs='));
  const regex = line.match(/new RegExp\((.*?)\)\.test/)[1];
  const expression = vm.runInNewContext(regex, { kind: 'repair' });
  const matches = new RegExp(expression).test('maint_plan_do.php?type=repair&id=123');
  // A regression detector must notice both the saved defect and a later repaired source.
  return { sourcePlannerHandlerMatches: matches, knownBaselineDefect: !matches, fixRequired: !matches };
});
check('Exact ID/type handler matching accepts quoted current UI handler', {}, 'ParseHandler', () => {
  const dom = createDom(new Element());
  assert.deepEqual(dom.handler(new Element({ attrs: { onclick: "Ajax('maint_plan_do.php?type=repair&id=123','maintPlanAction')" } })), { id:'123',kind:'repair',commit:false });
  for (const query of ['type=bulkRepair&id=123','type=repair&id=123&id=124','type=repair&id=123&mode=do&mode=do']) assert.equal(dom.handler(new Element({ attrs:{ onclick:`Ajax('maint_plan_do.php?${query}','target')` } })), null);
});
check('Planner binds final control to exact aircraft ID and cost', {}, 'InspectPlanner', () => {
  const { doc } = plannerDom(); const quote = createDom(doc).inspectPlanner('N-TEST001','repair','123'); assert.equal(quote.ok,true); assert.equal(quote.cost,2400);
});
check('Planner rejects registration prefix collisions', {}, 'InspectPlanner', () => {
  const { doc } = plannerDom({ rowReg:'N-TEST001-2' }); assert.equal(createDom(doc).inspectPlanner('N-TEST001','repair','123').ok,false);
});
check('Planner rejects wrong aircraft ID and disabled control', {}, 'InspectPlanner', () => {
  assert.equal(createDom(plannerDom().doc).inspectPlanner('N-TEST001','repair','124').ok,false);
  assert.equal(createDom(plannerDom({ disabled:true }).doc).inspectPlanner('N-TEST001','repair','123').ok,false);
});
check('Commit rechecks quote and submits at most once per page', {}, 'CommitAgainstFakeDOM', () => {
  delete globalThis.__am4HarnessAttempts;
  const {doc,final,section}=plannerDom(); const dom=createDom(doc); const quote=dom.inspectPlanner('N-TEST001','repair','123');
  section.innerText=section.innerText.replace('2400','2401'); assert.equal(dom.commit({registration:'N-TEST001',kind:'repair',id:'123',quote,actionId:'test'}).clicked,false); assert.equal(final.clicks,0);
  section.innerText=section.innerText.replace('2401','2400'); assert.equal(dom.commit({registration:'N-TEST001',kind:'repair',id:'123',quote,actionId:'test'}).clicked,true);
  assert.equal(dom.commit({registration:'N-TEST001',kind:'repair',id:'123',quote,actionId:'test'}).clicked,false); assert.equal(final.clicks,1);
});
check('Commit refuses absent cash reserve', {}, 'CommitAgainstFakeDOM', () => {
  const {doc,final}=plannerDom(); doc.body.innerText='ACCOUNT $ 100000000'; const dom=createDom(doc); const quote=dom.inspectPlanner('N-TEST001','repair','123');
  assert.equal(dom.commit({registration:'N-TEST001',kind:'repair',id:'123',quote,actionId:'x'}).clicked,false); assert.equal(final.clicks,0);
});
check('Numeric parser does not turn missing values into zero', {}, 'ParseNumbers', () => {
  const d=createDom(new Element()); assert.equal(d.number(''),null); assert.equal(d.number('bad'),null); assert.equal(d.number('12.5'),12.5); assert.equal(d.number('120,000'),120000);
});
check('A plan list is never treated as a complete schedule', {}, 'ReadSchedule', () => {
  const root=new Element({text:'MAINTENANCE SCHEDULE N-TEST001 Pax',queries:{'.maint-list-sort':[new Element()]}});
  const doc=new Element({queries:{'#maintAction':[root]}}); assert.equal(createDom(doc).schedule().complete,false);
});
check('Explicit empty schedule is recognized without guessing absence', {}, 'ReadSchedule', () => {
  const root=new Element({text:'MAINTENANCE SCHEDULE No scheduled maintenance'}); const doc=new Element({queries:{'#maintAction':[root]}});
  assert.equal(createDom(doc).schedule().complete,true);
  root.innerText='MAINTENANCE SCHEDULE'; assert.equal(createDom(doc).schedule().complete,false);
});
check('Unknown schedule layout remains inconclusive', {}, 'ReadSchedule', () => {
  const root=new Element({text:'Something changed N-TEST001 Repair'}); assert.equal(createDom(new Element({queries:{'#maintAction':[root]}})).schedule().complete,false);
});
function scheduleTable(texts, { next = false } = {}) {
  const header=new Element({text:'Aircraft Type Completion',queries:{'th':[new Element({text:'Aircraft'})]}});
  const table=new Element({queries:{'thead':[new Element({text:'Aircraft Type Completion'})],'tr':[header,...texts.map(text=>new Element({text}))]}});
  const root=new Element({text:'MAINTENANCE SCHEDULE '+texts.join(' '),queries:{'table':[table],'a,button,select':next?[new Element({text:'Next'})]:[]}});
  return new Element({queries:{'#maintAction':[root]}});
}
check('Schedule parser recognizes exact repair and A-check rows',{},'ReadScheduleRows',()=>{
  const result=createDom(scheduleTable(['N-TEST001 Repair 00:05:00','N-TEST002 A-Check 00:25:00'])).schedule();assert.equal(result.complete,true);assert.deepEqual(result.entries.map(e=>[e.registration,e.kind]),[['N-TEST001','repair'],['N-TEST002','check']]);return result;
});
check('Schedule parser preserves registration suffix identity',{},'ReadScheduleRows',()=>{
  const result=createDom(scheduleTable(['N-TEST001-2 Repair 00:05:00'])).schedule();assert.equal(result.complete,true);assert.equal(result.entries[0].registration,'N-TEST001-2');
});
check('Pagination and unreadable rows prevent clean-schedule proof',{},'ReadScheduleRows',()=>{
  assert.equal(createDom(scheduleTable(['N-TEST001 Repair 00:05:00'],{next:true})).schedule().complete,false);
  assert.equal(createDom(scheduleTable(['N-TEST001 Repair 00:05:00','Unknown modification job'])).schedule().complete,false);
  assert.equal(createDom(scheduleTable(['N-TEST001 Repair and A-Check 00:05:00'])).schedule().complete,false);
});
check('Repair and A-check eligibility use explicit UI identity', fixture.ready, 'MaintenanceEligibility', () => {
  for (const kind of ['repair','check']) assert.equal(maintenanceEligibility(fixture.ready,'N-TEST001',kind).eligible,true);
});
for (const [name, mutate] of [
  ['duplicate fleet',s=>s.fleet.push(clone(s.fleet[0]))],['duplicate maintenance',s=>s.maintenance.records.push(clone(s.maintenance.records[0]))],
  ['away from base',s=>s.maintenance.records[0].atBase=false],['missing values',s=>s.maintenance.records[0].wear=null],
  ['grounded',s=>s.fleet[0].grounded='1'],['pending work',s=>s.schedule.entries.push({registration:'N-TEST001',kind:'check'})],['unknown schedule',s=>s.schedule.complete=false]
]) check('Reject maintenance: '+name,fixture.ready,'MaintenanceEligibility',()=>{const s=clone(fixture.ready);mutate(s);assert.equal(maintenanceEligibility(s,'N-TEST001','repair').eligible,false)});
check('Durable holds block either maintenance kind', fixture.ready,'MaintenanceEligibility',()=>{for(const kind of ['repair','check'])assert.equal(maintenanceEligibility(fixture.ready,'N-TEST001',kind,[{state:'UNKNOWN'}]).eligible,false)});
check('Wear and check boundaries follow DESIGN.md',fixture.ready,'MaintenanceEligibility',()=>{
  const s=clone(fixture.ready);s.maintenance.records[0].wear=9;assert.equal(maintenanceEligibility(s,'N-TEST001','repair').eligible,false);
  s.maintenance.records[0].hoursToCheck=20;assert.equal(maintenanceEligibility(s,'N-TEST001','check').eligible,true);s.maintenance.records[0].hoursToCheck=21;assert.equal(maintenanceEligibility(s,'N-TEST001','check').eligible,false);
});
check('N-145 is excluded centrally',fixture.ready,'MaintenanceEligibility',()=>{assert.equal(maintenanceEligibility(fixture.ready,'N-145','repair').eligible,false)});
check('20 hours is a planning threshold, not automatic grounding',fixture.completed,'DepartureEligibility',()=>{
  assert.equal(departureEligibility(fixture.completed,'N-TEST001',[],5).eligible,true);assert.equal(departureEligibility(fixture.completed,'N-TEST001',[],null).eligible,false);assert.equal(departureEligibility(fixture.completed,'N-TEST001',[],19).eligible,false);
});
check('Dispatch rejects pending holds and low resources',fixture.completed,'DepartureEligibility',()=>{
  assert.equal(departureEligibility(fixture.completed,'N-TEST001',[{state:'UNKNOWN'}],5).eligible,false);const s=clone(fixture.completed);s.markets.fuel.holding=74999;assert.equal(departureEligibility(s,'N-TEST001',[],5).eligible,false);
});
check('Pending scheduling is distinct from completion',fixture.pending,'Reconcile',()=>{
  const a={registration:'N-TEST001',kind:'repair',aircraftId:'123',state:'UNKNOWN',before:fixture.ready};const r=reconcile(a,fixture.pending);assert.equal(r.state,'SCHEDULED_VERIFIED');assert.equal(r.scheduleSeen,true);
});
check('Schedule disappearance alone cannot release aircraft',fixture.completed,'Reconcile',()=>{
  const a={registration:'N-TEST001',kind:'repair',aircraftId:'123',state:'UNKNOWN',before:fixture.ready,scheduleSeen:false};assert.equal(reconcile(a,fixture.completed).result,'INCONCLUSIVE');a.scheduleSeen=true;assert.equal(reconcile(a,fixture.completed).state,'COMPLETED_VERIFIED');
});
check('A-check completion requires increased hours and cleared schedule',fixture.completed,'Reconcile',()=>{
  const a={registration:'N-TEST001',kind:'check',aircraftId:'123',state:'SCHEDULED_VERIFIED',before:fixture.ready,scheduleSeen:true};assert.equal(reconcile(a,fixture.completed).result,'INCONCLUSIVE');const s=clone(fixture.completed);s.maintenance.records[0].hoursToCheck=400;assert.equal(reconcile(a,s).state,'COMPLETED_VERIFIED');
});
check('Unknown schedule or wrong action never proves completion',fixture.completed,'Reconcile',()=>{
  const a={registration:'N-TEST001',kind:'repair',aircraftId:'123',state:'UNKNOWN',before:fixture.ready};const s=clone(fixture.pending);s.schedule.entries[0].kind='check';assert.equal(reconcile(a,s).result,'INCONCLUSIVE');s.schedule.entries=[];s.schedule.complete=false;assert.equal(reconcile(a,s).result,'INCONCLUSIVE');
});
check('Checkpoint survives actual database close and reopen',fixture.ready,'PersistRestartReconcile',()=>{
  const root=join(temp,'restart');let store=new Store(root);const a=store.intent({registration:'N-TEST001',kind:'repair',aircraftId:'123',before:fixture.ready});store.close();
  store=new Store(root);assert.equal(store.get(a.id).state,'PENDING');assert.equal(store.holds('N-TEST001').length,1);assert.throws(()=>store.intent({registration:'N-TEST001',kind:'check'}));
  Object.assign(a,reconcile(a,fixture.pending));store.saveAction(a);store.close();store=new Store(root);const restored=store.get(a.id);assert.equal(restored.scheduleSeen,true);Object.assign(restored,reconcile(restored,fixture.completed));store.saveAction(restored);assert.equal(store.holds('N-TEST001').length,0);store.close();
});
check('Production holds are read without changing journal bytes',{},'ReadProductionJournal',()=>{
  const root=join(temp,'production');mkdirSync(join(root,'state'),{recursive:true});const file=join(root,'state','operations-state.json');const bytes=JSON.stringify({schema:1,transactions:{'maintenance:N-TEST001:check':{status:'UNKNOWN'}}});writeFileSync(file,bytes);assert.equal(readProductionHolds(root,'N-TEST001').length,1);assert.equal(readFileSync(file,'utf8'),bytes);
  writeFileSync(file,'{}');assert.throws(()=>readProductionHolds(root,'N-TEST001'));
});
check('Exact whole quantities preserve reserve and capacity',fixture.market,'QuantityCalculation',()=>{
  assert.equal(wholeQuantity(fixture.market),9877);assert.equal(wholeQuantity(fixture.market,1000),9000);
  assert.equal(wholeQuantity({...fixture.market,cash:100000001}),8);assert.equal(wholeQuantity({...fixture.market,price:150}),0);assert.equal(wholeQuantity({...fixture.market,kind:'fuel',price:1000}),0);assert.equal(wholeQuantity({...fixture.market,cash:100000000}),0);assert.throws(()=>wholeQuantity({...fixture.market,holding:null}));
});
check('Exact purchase verification does not accept arbitrary balance changes',fixture.purchase,'VerifyTransaction',()=>{
  assert.equal(verifyPurchase(fixture.purchase).result,'PASS');assert.equal(verifyPurchase({...fixture.purchase,cashDecrease:1}).result,'INCONCLUSIVE');assert.equal(verifyPurchase({...fixture.purchase,holdingIncrease:1}).result,'INCONCLUSIVE');assert.equal(verifyPurchase({clickAttempted:false}).result,'INCONCLUSIVE');
});
check('Report identity rejects stale, running, and incomplete reports',{},'ValidateReport',()=>{
  const r={id:'a',started:'2026-10-18T00:00:00Z',finished:'2026-10-18T00:01:00Z',result:'PASS'};assert.equal(validateReportIdentity(r,'a'),true);assert.equal(validateReportIdentity(r,'b'),false);assert.equal(validateReportIdentity({...r,finished:null},'a'),false);assert.equal(validateReportIdentity({...r,result:'STARTING'},'a'),false);
});
check('Evidence redacts transport URLs, credentials, and emails',{},'SanitizeEvidence',()=>{
  const s=sanitize({url:'ws://127.0.0.1:9222/private',cookie:'secret',text:'token=abc https://game.invalid/?ticket=abc alice@example.com',cash:250000000});assert.equal(s.url,'[REDACTED]');assert.equal(s.cookie,'[REDACTED]');assert.ok(!JSON.stringify(s).includes('abc'));assert.ok(!JSON.stringify(s).includes('alice@'));assert.equal(s.cash,250000000);
});

check('Windows PowerShell 5.1 parses launcher, lock host and production scripts',{},'ParsePowerShellWithoutExecuting',()=>{
  if(process.platform!=='win32')return {result:'INCONCLUSIVE',reason:'WINDOWS_REQUIRED'};
  const paths=[fileURLToPath(new URL('../Run-AM4Tests.ps1',import.meta.url)),fileURLToPath(new URL('../Lock-Session.ps1',import.meta.url))];
  if(process.env.AM4_SOURCE_ROOT)paths.push(join(process.env.AM4_SOURCE_ROOT,'AM4-Operations.ps1'),join(process.env.AM4_SOURCE_ROOT,'Start-AM4.ps1'));
  const list=paths.map(p=>"'"+p.replaceAll("'","''")+"'").join(',');
  const script=`$ErrorActionPreference='Stop'; $results=foreach($p in @(${list})){$t=$null;$e=$null;$null=[System.Management.Automation.Language.Parser]::ParseFile($p,[ref]$t,[ref]$e);[pscustomobject]@{file=[IO.Path]::GetFileName($p);errors=@($e).Count}}; @($results)|ConvertTo-Json -Compress`;
  const rows=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true}));
  assert.ok(rows.every(r=>r.errors===0));return rows;
});
check('Real Windows mutex excludes a second worker and releases on process exit',{},'AcquireIsolatedOfflineMutex',async()=>{
  if(process.platform!=='win32')return {result:'INCONCLUSIVE',reason:'WINDOWS_REQUIRED'};
  const name='Local\\AM4_Harness_Offline_'+randomUUID(),children=[];
  async function start(){
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../Lock-Session.ps1',import.meta.url)),'-MutexName',name],{windowsHide:true,stdio:['pipe','pipe','pipe']});children.push(child);
    child.stdin.on('error',()=>{});
    const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('OFFLINE_MUTEX_TEST_TIMEOUT'))},5000);child.once('error',()=>{clearTimeout(timer);reject(new Error('OFFLINE_LOCK_HOST_FAILED'))});child.stdout.once('data',data=>{clearTimeout(timer);resolve(String(data).trim())})});
    return {child,result};
  }
  try {
    const first=await start();assert.equal(first.result,'READY');const second=await start();assert.equal(second.result,'BUSY');
    await new Promise(resolve=>{first.child.once('exit',resolve);first.child.stdin.end()});
    const third=await start();assert.equal(third.result,'READY');
  } finally {for(const child of children)child.stdin.end()}
});
check('SQLite rejects illegal transitions and never erases an unknown hold',{},'ValidateActionStateMachine',()=>{
  const store=new Store(join(temp,'transitions'));const a=store.intent({registration:'N-TEST001',kind:'repair'});a.state='UNKNOWN';store.saveAction(a);
  a.state='NOT_SUBMITTED';assert.throws(()=>store.saveAction(a));assert.equal(store.get(a.id).state,'UNKNOWN');
  a.state='MADE_UP';assert.throws(()=>store.saveAction(a));assert.equal(store.holds('N-TEST001').length,1);store.close();
});
check('Changing report output does not change the durable action ledger',{},'PersistCanonicalLedger',()=>{
  const ledgerRoot=join(temp,'shared-ledger');let store=new Store(join(temp,'output-a'),{ledgerRoot});const a=store.intent({registration:'N-TEST001',kind:'repair'});store.close();
  store=new Store(join(temp,'output-b'),{ledgerRoot});assert.equal(store.get(a.id).state,'PENDING');assert.throws(()=>store.intent({registration:'N-TEST001',kind:'check'}));store.close();
});
check('CDP matches request IDs and excludes unsolicited events',{},'EvaluateFakeCDP',async()=>{
  const socket=new EventTarget();socket.readyState=WebSocket.OPEN;socket.close=()=>{};
  socket.send=text=>{const req=JSON.parse(text);queueMicrotask(()=>{socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({method:'Network.event',params:{secret:'not logged'}})}));socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:req.id,result:{result:{value:JSON.stringify({ok:true})}}})}));})};
  const cdp=new Cdp(socket,100,{offline:true});assert.deepEqual(await cdp.evaluate('fixture'),{ok:true});cdp.close();
});
check('CDP timeout closes transport without retrying a possible commit',{},'TimeoutFakeCDP',async()=>{
  const socket=new EventTarget();socket.readyState=WebSocket.OPEN;let sends=0,closes=0;socket.send=()=>sends++;socket.close=()=>closes++;
  const cdp=new Cdp(socket,10,{offline:true});await assert.rejects(cdp.evaluate('one commit'),/CDP_COMMAND_TIMEOUT/);assert.equal(sends,1);assert.equal(closes,1);
});
check('CDP exception details never escape into diagnostic evidence',{},'RejectFakeCDPException',async()=>{
  const socket=new EventTarget();socket.readyState=WebSocket.OPEN;socket.close=()=>{};
  socket.send=text=>{const req=JSON.parse(text);queueMicrotask(()=>socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:req.id,result:{exceptionDetails:{text:'secret account/session'},result:{value:'unsafe'}}})})));};
  const cdp=new Cdp(socket,100,{offline:true});await assert.rejects(cdp.evaluate('fixture'),{message:'AM4_JAVASCRIPT_EXCEPTION'});cdp.close();
});
function purchasePage({tinyDeltas=false}={}) {
  let holding=10000,cash=250000000,clicks=0;
  const input={placeholder:'amount to purchase',disabled:false,value:''};
  const buy=new Element({text:'PURCHASE'});buy.onClick=()=>{clicks++;holding+=tinyDeltas?1:Number(input.value);cash-=tinyDeltas?1:Number(input.value)*125/1000;};
  const dialog=new Element({queries:{'input':[input],'button,[role="button"],input[type="submit"]':[buy]}});
  Object.defineProperty(dialog,'innerText',{get:()=>`QUOTA COST $ 125 CAPACITY ${holding} / 18000 HOLDING ${holding}`});
  const menu=new Element({text:'FUEL'}),tab=new Element({text:'CO2'});
  const quoted=new Element();Object.defineProperty(quoted,'innerText',{get:()=>String(Math.round(Number(input.value)*125/1000))});
  const doc=new Element({queries:{'#smallMainMenu [onclick],.menu-btn-new[onclick]':[menu],'#popBtn2':[tab],'.modal,[role="dialog"]':[dialog],'#sumCost':[quoted]}});
  doc.body={get innerText(){return `ACCOUNT $ ${cash}`}};
  class HTMLInputElement {}
  Object.defineProperty(HTMLInputElement.prototype,'value',{set(value){this.value=value}});
  input.dispatchEvent=()=>{};input.getClientRects=()=>[{}];
  return {doc,HTMLInputElement,clicks:()=>clicks};
}
check('Existing purchase template executes unchanged against a synthetic market DOM double',{},'ExecuteExistingPurchaseOffline',async()=>{
  const p=purchasePage();const result=JSON.parse(await vm.runInNewContext(source.blocks.purchaseJsTemplate.replace('__KIND__','"co2"'),{document:p.doc,HTMLInputElement:p.HTMLInputElement,getComputedStyle:()=>({visibility:'visible'}),Event:class{},setTimeout:f=>{f()}}));
  assert.equal(result.status,'VERIFIED');assert.equal(result.requested,8000);assert.equal(p.clicks(),1);assert.equal(verifyPurchase(result).result,'PASS');return result;
});
check('Confirmed purchase quote binding rejects a changed amount before clicking',{},'BoundExistingPurchaseOffline',async()=>{
  const p=purchasePage();const block=bindPurchase(source.blocks.purchaseJsTemplate,'co2',{price:125,capacity:18000,holding:10000,cash:250000000,requested:7000,cost:875});
  const result=JSON.parse(await vm.runInNewContext(block,{document:p.doc,HTMLInputElement:p.HTMLInputElement,getComputedStyle:()=>({visibility:'visible'}),Event:class{},setTimeout:f=>{f()}}));
  assert.equal(result.clickAttempted,false);assert.equal(p.clicks(),0);assert.throws(()=>bindPurchase('unrecognized source','co2',{}));return result;
});
check('Existing departure selection and commit retain exact registration guards',{},'ExecuteExistingDepartureOffline',()=>{
  const row=new Element({data:{reg:'N-TEST001',grounded:'0'},queries:{'[id^="flightStatusWear"]':[new Element({text:'0.00'})],'[id^="flightStatusCounter"]':[new Element({text:'landed'})]}});
  const button=new Element({id:'flightInfoDepart123',text:'Depart'});const doc=new Element({queries:{'#landedList .flight-list[data-reg],#parkedList .flight-list[data-reg]':[row],'button':[button]}});doc.body={innerText:'N-TEST001 0.00% worn'};
  assert.equal(JSON.parse(vm.runInNewContext(renderBlock(source.blocks.selectJs,'N-TEST001'),{document:doc})).ok,true);
  assert.equal(JSON.parse(vm.runInNewContext(renderBlock(source.blocks.departJs,'N-TEST001'),{document:doc})).ok,true);assert.equal(button.clicks,1);
  assert.equal(JSON.parse(vm.runInNewContext(renderBlock(source.blocks.departJs,'N-TEST001-2'),{document:doc})).ok,false);assert.equal(button.clicks,1);
});
check('Runner persists UNKNOWN on disconnect and refuses a second submission',fixture.ready,'FaultInjectMaintenanceCommit',async()=>{
  const store=new Store(join(temp,'fault-runner'));const runner=new Runner({live:true,maxSeconds:90,maxActions:1,registration:'N-TEST001',productionRoot:temp,waitSeconds:0},source,store);
  let commits=0;runner.snapshot=async()=>clone(fixture.ready);runner.holds=reg=>store.holds(reg);runner.guard={check:async()=>{}};runner.confirm=async()=>{};runner.verifySource=()=>{};
  runner.dom=async method=>{if(method==='openPlanner')return {ok:true,cost:2400,time:'00:05:00',row:clone(fixture.ready.maintenance.records[0])};if(method==='commit'){commits++;throw new Error('CDP_DISCONNECTED')}throw new Error('UNEXPECTED_TEST_METHOD')};
  const first=await runner.execute('Repair');assert.equal(first.result,'INCONCLUSIVE');assert.equal(store.get(first.checkpoint).state,'UNKNOWN');
  const second=await runner.execute('Repair');assert.equal(second.reason,'NO_ELIGIBLE_AIRCRAFT');assert.equal(commits,1);store.close();
});
check('Resume is observation-only and checkpoints pending work without indefinite waiting',fixture.pending,'ResumeCheckpointOffline',async()=>{
  const store=new Store(join(temp,'resume-runner'));const a=store.intent({registration:'N-TEST001',kind:'repair',aircraftId:'123',before:fixture.ready});a.state='UNKNOWN';store.saveAction(a);
  const runner=new Runner({live:false,maxSeconds:10,maxActions:1,checkpoint:a.id,waitSeconds:0},source,store);let snapshots=0;runner.snapshot=async()=>{snapshots++;return clone(fixture.pending)};
  const report=await runner.execute('ResumeChain');assert.equal(report.actionAttempted.submitted,false);assert.equal(report.result,'INCONCLUSIVE');assert.equal(store.get(a.id).state,'SCHEDULED_VERIFIED');assert.equal(snapshots,1);store.close();
});

// Production contract checks are intentionally FAIL until production code satisfies DESIGN.md.
// These are separate from harness self-tests; a green harness must not hide known production regressions.
check('PRODUCTION CONTRACT: planner action regex matches real handler',{},'ProductionPlannerMatching',()=>{
  const line=source.blocks.plannerJs.split('\n').find(s=>s.includes('const bs='));const expression=line.match(/new RegExp\((.*?)\)\.test/)[1];
  assert.equal(new RegExp(vm.runInNewContext(expression,{kind:'repair'})).test('maint_plan_do.php?type=repair&id=123'),true,'Production planner handler escaping fails');
});
check('PRODUCTION CONTRACT: purchase fills exact whole units',fixture.market,'ProductionQuantityCalculation',()=>{
  const b=source.blocks.purchaseJsTemplate;const expression=b.match(/const amount=([^;]+);/)[1];
  const amount=vm.runInNewContext(expression,{free:9877,affordable:999999});assert.equal(amount,9877,'Production still rounds to 1000-unit lots');
});
check('PRODUCTION CONTRACT: purchase rejects unrelated tiny deltas',fixture.purchase,'ProductionTransactionVerification',()=>{
  const b=source.blocks.purchaseJsTemplate;const expression=b.match(/if\((after&&[^\n]+)\)\{/)[1];
  const accepted=vm.runInNewContext(expression,{after:{holding:10001,cash:249999999},before:{holding:10000,cash:250000000},amount:9877,cost:1234.625});
  assert.equal(accepted,false,'Production accepts arbitrary positive inventory / negative cash deltas');
});

check('Unknown maintenance holds its aircraft without pausing unrelated work',fixture.ready,'MaintenanceFaultIsolation',async()=>{
  const store=new Store(join(temp,'maintenance-isolation'));
  const runner=new Runner({live:true,maxSeconds:90,maxActions:1,productionRoot:temp},source,store);
  let busy=false;const outcomes=[];
  runner.operator={begin(){assert.equal(busy,false);busy=true;},end(outcome){outcomes.push(outcome);busy=false;}};
  runner.maintenance=async report=>{const a=store.intent({registration:'N-TEST001',kind:'repair',aircraftId:'123',before:fixture.ready});report.checkpoint=a.id;report.actionAttempted={submitted:true};throw new Error('SCHEDULE_UNKNOWN');};
  const first=await runner.execute('Repair');
  assert.equal(first.result,'INCONCLUSIVE');assert.equal(store.holds('N-TEST001').length,1);assert.equal(store.holds('N-TEST003-4').length,0);
  runner.fleet=async()=>[{registration:'N-TEST003-4',status:'landed',location:'landedList'}];
  const next=await runner.execute('InspectAircraft');assert.equal(next.result,'PASS');assert.deepEqual(outcomes,['RETURNED','RETURNED']);store.close();
});

