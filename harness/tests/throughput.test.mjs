// Synthetic aircraft, prices and receipts; no live game, controller ownership or network.
import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {MaintenanceCache} from '../maintenance-cache.mjs';
import {ResourceCache} from '../resource-cache.mjs';import {Runner} from '../runner.mjs';import {Store} from '../store.mjs';import {readSource} from '../source.mjs';
import {bulkMaintenance,bulkDeparture} from '../bulk-operations.mjs';import {bulkDom} from '../bulk-dom.mjs';import {maintenanceEligibility} from '../policy.mjs';import {Element} from './fake-dom.mjs';
import {resourceReplay} from '../benchmark-throughput.mjs';
import {requiredMaintenance,departureEligibility,reconcileRecovery,applyMaintenanceUnavailable} from '../policy.mjs';import {identityRows} from '../identity.mjs';import {assessFleetActivity} from '../fleet-activity.mjs';import {PassPerformance} from '../performance.mjs';import {purchaseDecision} from '../purchasing.mjs';
import {OperatorControl,OperatorSession} from '../../operator/control.mjs';import {Cdp} from '../cdp.mjs';
const root=process.env.AM4_SOURCE_ROOT||fileURLToPath(new URL('../../',import.meta.url)),source=readSource(root);
const markets=(holding=2000000,capacity=4000000)=>({ok:true,fuel:{ok:true,holding,capacityMax:capacity,pricePer1000:500,cash:300000000,nextRefreshSeconds:1200},co2:{ok:true,holding,capacityMax:capacity,pricePer1000:120,cash:300000000,nextRefreshSeconds:1200}});
const header=(f=2000000,c=2000000,cap=4000000)=>({fuel:f,cash:300000000,co2Percent:c/cap*100});
const proof=(f,c,v=0,routes=1,fuel=1000,co2=2000)=>({epoch:1,versions:{fuel:v,co2:v},receipt:{fuel,co2,routes},header:header(f,c)});
const snapshot=(kind)=>{const fleet=[101,102].map(id=>({aircraftId:String(id),registration:'TEST-'+id,status:'landed',location:'landedList',grounded:'0',wear:kind==='repair'?25:0}));return {fleet,maintenance:{ok:true,records:fleet.map(a=>({id:a.aircraftId,registration:a.registration,wear:a.wear,hoursToCheck:kind==='check'?15:200,availableActions:kind?[kind]:[]}))},schedule:{complete:true,entries:[]},markets:markets()};};
test('twenty exact receipt debits never trigger top-up screens with sufficient inventory, even at qualifying prices',async()=>{
 let now=0,reads=0;const c=new ResourceCache({now:()=>now});c.batch=true;await c.read(async()=>{reads++;return markets(4000000);});c.beginDispatch(20);
 for(let i=0;i<20;i++){assert.equal(c.purchaseDue('fuel'),false);assert.equal(c.purchaseDue('co2'),false);assert.equal(c.debit(proof(4000000-i*1000,4000000-i*2000,i),proof(3999000-i*1000,3998000-i*2000,i+1)),true);await c.read(async()=>{reads++;return markets(4000000);});now+=1000;}
 assert.equal(reads,1);assert.equal(c.metrics.receiptDebits,20);assert.equal(c.value.fuel.holding,3980000);c.endDispatch();assert.equal(c.purchaseDue('fuel'),true,'batch boundary can buy the maximum again');
});
test('low/uncertain inventory, actual price changes and external changes trigger a meaningful refresh',async()=>{
 let now=0;const c=new ResourceCache({now:()=>now});c.batch=true;const m=markets(80000);await c.read(async()=>m);c.usage.fuel=10000;c.beginDispatch(8);assert.equal(c.purchaseDue('fuel'),true);
 c.invalidate();assert.equal(c.purchaseDue('co2'),true);await c.read(async()=>markets());c.beginDispatch(20);now=1200000;assert.equal(c.purchaseDue('co2'),true);
 await c.read(async()=>markets());assert.equal(c.observeHeader(header(1900000)),false);assert.equal(c.purchaseDue('fuel'),true);
});
test('unattainable full-batch budget does not cause one top-up per departure',async()=>{const c=new ResourceCache();c.batch=true;await c.read(async()=>markets(1000000,1000000));c.beginDispatch(20);c.usage={fuel:100000,co2:100000};assert.equal(c.purchaseDue('fuel'),false);c.value.fuel.holding=900000;assert.equal(c.purchaseDue('fuel'),false);c.value.fuel.holding=300000;assert.equal(c.purchaseDue('fuel'),true);});
test('strict native maintenance thresholds exclude exactly 20 but retain due priorities and guards',()=>{for(const [hours,wear,check,repair] of [[19,21,true,true],[20,20,false,false],[21,20.1,false,true]]){const s=snapshot('repair');Object.assign(s.maintenance.records[0],{hoursToCheck:hours,wear,availableActions:['repair','check']});assert.equal(maintenanceEligibility(s,'TEST-101','check').eligible,check);assert.equal(maintenanceEligibility(s,'TEST-101','repair').eligible,repair);}});
function runnerFixture(kind,behavior={}){
 const directory=mkdtempSync(join(tmpdir(),'am4-bulk-')),store=new Store(directory),s=snapshot(kind),r=new Runner({live:true,maxActions:1,maxSeconds:120,productionRoot:directory},source,store);r.batchSnapshot=s;r.resources.batch=true;r.resources.value=markets();for(const k of ['fuel','co2'])r.resources.setDeadline(k);
 r.holds=reg=>store.holds(reg);r.pause=async()=>{};r.nav=async()=>{};r.guard={check:async()=>{}};r.verifySource=()=>{};let clicks=0,flights=0,receipt=0;
 r.confirm=async()=>{};r.dom=async method=>{if(method==='showFleet'||method==='showRoutes')return {ok:true};if(method==='schedule')return {complete:true,entries:s.fleet.map(a=>({registration:a.registration,aircraftId:a.aircraftId,kind}))};if(method==='flight'){const a=s.fleet[flights++];return {aircraftId:a.aircraftId,registrations:[a.registration],routeId:String(501+flights-1),hours:1,fuelRequired:1000,co2Required:2000,header:header()};}if(method==='receipt')return clicks===0?proof(2000000,2000000):proof(1998000,1996000,1,2,2000,4000);throw Error(method);};
 r.evaluate=async(expression,label)=>{if(label==='source.selectJs')return {ok:true};if(label==='DOM.bulk.inspect')return {departureControls:1,departureRouteIds:['501','502'],departureCount:2};if(label==='DOM.bulk.maintenancePreview')return behavior.preview||{ok:true,kind,ids:['101','102'],cost:4000};if(label.startsWith('DOM.commitBulk')){clicks++;if(behavior.disconnect)throw Error('CDP_DISCONNECTED');return behavior.refused?{clicked:false,reason:'BULK_QUOTE_CHANGED'}:{clicked:true};}if(label==='DOM.bulk.departureState')return s.fleet.map((a,i)=>({id:a.aircraftId,rows:[{location:behavior.partial&&i?'landedList':'inflightList'}]}));throw Error(label);};
 return {r,s,store,clicks:()=>clicks,close(){store.close();rmSync(directory,{recursive:true,force:true});}};
}
for(const kind of ['check','repair'])test('native bulk '+kind+' uses one click, verifies every schedule and retains per-target recovery',async()=>{const f=runnerFixture(kind);try{const r=await bulkMaintenance(f.r,f.s,f.s.fleet,kind);assert.equal(r.result,'PASS');assert.equal(f.clicks(),1);assert.equal(r.verified.length,2);assert.ok(f.store.actions().every(a=>a.state==='SCHEDULED_VERIFIED'));assert.equal(f.store.actions().reduce((sum,a)=>sum+a.quote.cost,0),4000);}finally{f.close();}});
test('missing bulk controls/targets fall back only before submission; rejected commit is proven not submitted',async()=>{for(const behavior of [{preview:{ok:false,reason:'BULK_CONTROL_MISSING'}},{refused:true}]){const f=runnerFixture('repair',behavior);try{const r=await bulkMaintenance(f.r,f.s,f.s.fleet,'repair');assert.equal(r.fallback,true);assert.ok(f.store.actions().every(a=>a.state==='NOT_SUBMITTED'));}finally{f.close();}}});
test('ambiguous bulk submission keeps every affected target held and never permits individual retry',async()=>{const f=runnerFixture('check',{disconnect:true});try{const r=await bulkMaintenance(f.r,f.s,f.s.fleet,'check');assert.equal(r.fallback,false);assert.equal(r.actionAttempted.submitted,'POSSIBLE');assert.equal(f.clicks(),1);assert.equal(f.store.unresolved().length,2);}finally{f.close();}});
test('native Depart All verifies every aircraft, budgets real route requirements and debits exact bulk receipt',async()=>{const f=runnerFixture();try{f.r.resources.beginDispatch(2);const r=await bulkDeparture(f.r,f.s,f.s.fleet);assert.equal(r.result,'PASS');assert.equal(f.clicks(),1);assert.equal(r.gameResponse.inventoryAccounted,true);assert.equal(f.r.resources.value.fuel.holding,1998000);assert.equal(f.r.resources.dispatchRemaining,0);assert.equal(f.store.unresolved().length,0);}finally{f.close();}});
test('a native cohort smaller than the full landed backlog dispatches only its verified route IDs',async()=>{const f=runnerFixture();try{
 f.s.fleet.push({...f.s.fleet[0],aircraftId:'103',registration:'TEST-103'});f.s.maintenance.records.push({...f.s.maintenance.records[0],id:'103',registration:'TEST-103'});
 const original=f.r.evaluate;f.r.evaluate=async(e,l)=>{const v=await original(e,l);return l==='DOM.bulk.departureState'?v.slice(0,2):v;};
 const result=await bulkDeparture(f.r,f.s,f.s.fleet);assert.equal(result.result,'PASS');assert.equal(result.targetCount,2);assert.equal(f.clicks(),1);assert.equal(f.r.dispatchFlights.size,2);assert.equal(f.s.fleet[2].location,'landedList');assert.equal(f.store.actions().length,2);
 }finally{f.close();}});
test('partial bulk departure does not count non-departures or issue an individual fallback',async()=>{const f=runnerFixture(undefined,{partial:true});try{const r=await bulkDeparture(f.r,f.s,f.s.fleet);assert.equal(r.fallback,false);assert.equal(r.result,'INCONCLUSIVE');assert.equal(r.verified.length,1);assert.equal(f.store.unresolved().length,1);assert.equal(f.r.resources.value,null);}finally{f.close();}});
test('unknown route requirements, exclusions, insufficient A-check time or unbounded native scope prohibit bulk',async()=>{for(const behavior of ['unknown','exclude','duration','scope']){const f=runnerFixture();try{if(behavior==='unknown'){const dom=f.r.dom;f.r.dom=async(...a)=>{const r=await dom(...a);if(a[0]==='flight')delete r.co2Required;if(a[0]==='receipt')r.receipt.co2=null;return r;};}if(behavior==='exclude')f.s.fleet[0].registration='N-145';if(behavior==='duration')f.s.maintenance.records[0].hoursToCheck=1;if(behavior==='scope'){const evaluate=f.r.evaluate;f.r.evaluate=(e,l)=>l==='DOM.bulk.inspect'?Promise.resolve({departureControls:1,departureRouteIds:['501','599'],departureCount:2}):evaluate(e,l);}const result=await bulkDeparture(f.r,f.s,f.s.fleet.slice(0,2));assert.equal(result.fallback,true);assert.equal(f.clicks(),0);}finally{f.close();}}});
test('observed native jQuery Depart control is bound by explicit route IDs and refuses changed/disabled controls',()=>{
 globalThis.getComputedStyle=()=>({visibility:'visible'});const button=new Element({id:'departAll',text:'Depart 2'}),rows=['101','102'].map(id=>new Element({id:'flightStatus'+id,data:{reg:'TEST-'+id,grounded:'0'}}));
 const doc=new Element({queries:{'#departAll':[button],'#landedList .flight-list[data-reg]':rows}});globalThis.jQuery={_data:()=>({click:[{handler:function(){Ajax('route_depart.php?mode=all&ref=list&ids=501,502','runme',this);}}]})};
 try{assert.equal(bulkDom(doc,'departureCommit',{ids:['101','102'],routeIds:['501','502']}).clicked,true);assert.equal(button.clicks,1);button.disabled=true;assert.equal(bulkDom(doc,'departureCommit',{ids:['101','102'],routeIds:['501','502']}).clicked,false);button.disabled=false;assert.equal(bulkDom(doc,'departureCommit',{ids:['101','102'],routeIds:['501','503']}).clicked,false);assert.equal(button.clicks,1);}finally{delete globalThis.jQuery;}
});
test('native Depart limit label may exceed the exact bound cohort size, never the reverse',()=>{
 globalThis.getComputedStyle=()=>({visibility:'visible'});const button=new Element({id:'departAll',text:'Depart 20'}),doc=new Element({queries:{'#departAll':[button]}});globalThis.jQuery={_data:()=>({click:[{handler:function(){Ajax('route_depart.php?mode=all&ids=501,502','runme',this);}}]})};
 try{const cap=bulkDom(doc,'inspect');assert.equal(cap.departureCount,2);assert.deepEqual(cap.departureRouteIds,['501','502']);button.innerText='Depart 1';assert.equal(bulkDom(doc,'inspect').departureControls,0);}finally{delete globalThis.jQuery;}
});
test('benchmark executes the real production purchase coordinator and eliminates sufficient-stock per-aircraft screens',async()=>{const before=await resourceReplay({previous:true}),after=await resourceReplay();assert.equal(before.departures,20);assert.equal(before.purchases,40);assert.equal(before.resourceObservations,161);assert.equal(after.departures,20);assert.equal(after.purchases,0);assert.equal(after.resourceObservations,1);assert.equal(after.resourceScreenVisits,2);assert.ok(after.modeledDurationMs<before.modeledDurationMs);});
test('real bulk A-check DOM selects 19/0-hour aircraft and never selects 20/21-hour aircraft',async()=>{
 globalThis.getComputedStyle=()=>({visibility:'visible'});
 const card=(id,hours)=>{const c=new Element({data:{id},queries:{'b:nth-child(8)':[new Element({text:String(hours)})]}});let selected=false;c.classList={contains:()=>selected};c.onClick=()=>{selected=!selected;};return c;};
 const cards=[card('101',19),card('102',0),card('103',20),card('104',21)],submit=new Element({id:'bulk-check-btn',text:'Plan bulk check'}),loader=new Element({text:'Bulk A-Check'});
 const panel=new Element({queries:{'.opa-check[data-id]':cards,'button,a,input[type="submit"]':[submit]}}),maint=new Element({queries:{'button,a,input[type="submit"]':[loader]}});
 const doc=new Element({queries:{'#maintAction':[maint],'#maintPlanAction':[panel],'#maintPlanAction .opa-check[data-id]':cards,'#dataCost':[new Element({text:'$4,000'})]}});
 const args={kind:'check',ids:['101','102']},q=await bulkDom(doc,'maintenancePreview',args);assert.equal(q.ok,true);assert.deepEqual(q.ids,['101','102']);assert.equal(cards[2].clicks,0);assert.equal(cards[3].clicks,0);assert.equal(bulkDom(doc,'maintenanceCommit',{...q,...args}).clicked,true);assert.equal(submit.clicks,1);
});
test('real Bulk Repair DOM changes the twenty-percent dropdown and binds the filtered preview before Plan Repair',async()=>{
 globalThis.getComputedStyle=()=>({visibility:'visible'});const submit=new Element({text:'Plan Repair',attrs:{onclick:"Ajax('maint_plan_do.php?type=bulkRepair&mode=do','maintPlanActionDo')"}}),loader=new Element({text:'Bulk Repair'}),panel=new Element(),select={options:[{text:'>10%',value:'10'},{text:'>20%',value:'20'}],dispatchEvent(){this.changed=true;}};
 const rows=['101','102'].map(id=>new Element({attrs:{onclick:"popup('routes_main.php?mode=details&id="+id+"','Details')"}})),result=new Element({queries:{'[onclick]':rows,'button,a,input[type="submit"]':[submit]}}),maint=new Element({queries:{'button,a,input[type="submit"]':[loader]}});
 const doc=new Element({queries:{'#maintAction':[maint],'#maintPlanAction':[panel],'#repairRes':[result],'#repairPct':[select],'#repairRes td.text-danger.font-weight-bold':[new Element({text:'$4,000'})]}});
 const args={kind:'repair',ids:['101','102'],repairWearThreshold:20};const quote=await bulkDom(doc,'maintenancePreview',args);assert.equal(select.value,'20');assert.equal(select.changed,true);assert.equal(quote.ok,true);assert.equal(bulkDom(doc,'maintenanceCommit',{...quote,...args}).clicked,true);assert.equal(submit.clicks,1);
});
test('actual production batch phases dispatch forty-one sufficiently supplied aircraft without per-aircraft resource or maintenance screens',async()=>{
 const code=readFileSync(new URL('../production.mjs',import.meta.url),'utf8').replace(/\r\n/g,'\n'),start=code.indexOf("    stage('FLEET_ASSESSMENT');"),end=code.indexOf("    notifyForecast(runner.forecast,'update'",start);
 let purchase=code.slice(code.indexOf('async function purchaseMarkets('),code.indexOf('\ntry{\n',code.indexOf('async function purchaseMarkets(')));
 let stockFuel=4000000,stockCo2=4000000,version=0,reads=0,assessments=0;
 const fleet=Array.from({length:41},(_,i)=>({aircraftId:String(1000+i),registration:'TEST-'+(1000+i),status:'landed',location:'landedList',grounded:'0',wear:0})),s={fleet,maintenance:{ok:true,records:fleet.map(a=>({id:a.aircraftId,registration:a.registration,wear:0,hoursToCheck:200,availableActions:[]}))},schedule:{complete:true,entries:[]}};
 const cache=new ResourceCache();cache.batch=true;const r={resources:cache,performance:new PassPerformance(),holds:()=>[],snapshot:async()=>{assessments++;return s;},dom:async method=>method==='inventory'?header(stockFuel,stockCo2):{ok:true}};
 r.markets=options=>cache.read(async kinds=>{reads++;const m=markets(4000000);m.fuel.holding=stockFuel;m.co2.holding=stockCo2;return m;},options);
 const report={held:[],maintenance:[],maintenanceActions:[],verifiedDepartures:[],purchases:[],actions:[],fleetHeartbeat:{}};
 const action=async(scenario,reg,operation)=>{if(operation)return operation();assert.equal(scenario,'Departure','no maintenance or purchase action is due');const a=fleet.find(a=>a.registration===reg);assert.equal(departureEligibility({...s,markets:cache.value},reg,[],1).eligible,true);const before=proof(stockFuel,stockCo2,version);stockFuel-=1000;stockCo2-=2000;version++;assert.equal(cache.debit(before,proof(stockFuel,stockCo2,version)),true);a.status='inflight';a.location='inflightList';report.actions.push({result:'PASS',state:'DEPARTED_VERIFIED',submitted:true});return {result:'PASS',gameResponse:{eligible:{eligible:true}}};};
 r.maintenanceCache=new MaintenanceCache();const context={runner:r,report,store:{unresolved:()=>[],event(){}},active(){},stage(){},settings:{repairWearThreshold:20},identityRows,requiredMaintenance,departureEligibility,reconcileRecovery,applyMaintenanceUnavailable,assessFleetActivity,logFleetActivity(){},bulkMaintenance:async()=>{throw Error('UNEXPECTED_MAINTENANCE');},bulkDeparture:async()=>({fallback:true,reason:'SYNTHETIC_NATIVE_CONTROL_ABSENT'}),action,purchaseDecision,appendFileSync(){},save(){},join(){},root:'SYNTHETIC',console:{log(){}},batchCursor:0,passDeadline:Date.now()+600000,maxMaintenance:20,maxDepartures:1000,fleetHeartbeat:{afterDeparture:async()=>null}};
 vm.createContext(context);await vm.runInContext(`(async()=>{${purchase}\n${code.slice(start,end)}})()`,context);
 assert.equal(assessments,1);assert.equal(reads,1);assert.equal(report.verifiedDepartures.length,41);assert.equal(report.purchases.length,0);assert.equal(fleet.filter(a=>a.status==='landed').length,0);
});
test('bulk departure may use a labeled receipt-based CO2 margin, never an invented actual requirement',async()=>{const f=runnerFixture();try{f.r.resources.usage.co2=3000;const dom=f.r.dom;f.r.dom=async(...args)=>{const value=await dom(...args);if(args[0]==='flight')delete value.co2Required;return value;};assert.equal((await bulkDeparture(f.r,f.s,f.s.fleet)).result,'PASS');}finally{f.close();}});
test('visible validated maintenance view is reused; a real game navigation invalidates that reuse',async()=>{
 const r=new Runner({live:false,maxSeconds:30},source,{});r.batchSnapshot=snapshot();r.maintenanceView='plan';let navigations=0;r.dom=async method=>method==='maintenance'?r.batchSnapshot.maintenance:(navigations++,{ok:true});
 await r.nav('plan');await r.nav('plan');assert.equal(navigations,0);r.cdp={evaluate:async()=>({ok:true})};await r.evaluate('SYNTHETIC','source.selectJs');await r.nav('plan');assert.equal(navigations,1);
});
test('bulk commit uses the existing irreversible lease; pause allows verification but forbids another click',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'am4-bulk-lease-'));let control,operator;
 try{control=new OperatorControl(directory);control.request('TESTING');operator=new OperatorSession(directory,'TESTING');operator.begin('Synthetic bulk action');
 const cdp=new Cdp({addEventListener(){},readyState:WebSocket.OPEN,close(){}},1000,{operator});let commands=0;cdp.command=async()=>{commands++;return {result:{value:'{}'}};};
 await cdp.evaluate('JSON.stringify({})','DOM.commitBulk.departureCommit');assert.equal(control.status().action.irreversible,true);control.request('PAUSED/MANUAL');
 await cdp.evaluate('JSON.stringify({})','DOM.bulk.departureState');await assert.rejects(cdp.evaluate('JSON.stringify({})','DOM.commitBulk.departureCommit'),/OPERATOR_PAUSE/);assert.equal(commands,2);operator.end('RETURNED');operator.close();assert.equal(control.status().safeToUseGame,true);
 }finally{operator?.close();control?.close();rmSync(directory,{recursive:true,force:true});}
});
test('new arrivals between assessment and native scope trigger one current maintenance refresh then join the verified group',async()=>{
 const f=runnerFixture();try{const initial=[...f.s.fleet],updated=[...initial,{...initial[0],aircraftId:'103',registration:'TEST-103'}];let refreshed=0;f.r.fleet=async()=>updated;f.r.nav=async view=>{if(view==='plan')refreshed++;};
 const dom=f.r.dom;f.r.dom=async(method,...args)=>method==='maintenance'?{ok:true,records:updated.map(a=>({id:a.aircraftId,registration:a.registration,wear:0,hoursToCheck:200,availableActions:[]}))}:method==='receipt'?(f.clicks()?proof(1997000,1994000,1,3,3000,6000):proof(2000000,2000000)):dom(method,...args);
 const evaluate=f.r.evaluate;f.r.evaluate=(e,label)=>label==='DOM.bulk.inspect'?Promise.resolve({departureControls:1,departureRouteIds:['501','502','503'],departureCount:3}):evaluate(e,label);
 const result=await bulkDeparture(f.r,f.s,initial);assert.equal(result.result,'PASS');assert.equal(result.verified.length,3);assert.equal(refreshed,1);assert.equal(f.clicks(),1);
 }finally{f.close();}
});
test('sufficient inventory stays deferred across small cohorts and idle passes, but a new real price window is actionable',async()=>{
 let now=0;const c=new ResourceCache({now:()=>now});c.batch=true;await c.read(async()=>markets(4000000));c.beginDispatch(2);
 assert.equal(c.debit(proof(4000000,4000000),{...proof(3999000,3998000,1),header:header(3999000,3998000)}),true);
 c.beginDispatch(0);assert.equal(c.purchaseDue('fuel'),false);c.beginDispatch(2);assert.equal(c.purchaseDue('co2'),false);
 now=1200000;await c.read(async()=>{const m=markets();m.fuel.holding=3999000;m.co2.holding=3998000;return m;});assert.equal(c.purchaseDue('fuel'),true);
});
test('idle production phase does not navigate to a nonexistent Depart control',()=>{
 const code=readFileSync(new URL('../production.mjs',import.meta.url),'utf8');assert.match(code,/if\(eligibleCandidates\.length\)await runner\.dom\('showRoutes'\)/);
});

