// Invented dates, prices, resource quantities and fleet context. No AM4 or network access.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {forecastUrl,normalizeForecast,retrieveForecast,addForecast,observeActual,pruneAccuracy,accuracySummary,SLOT_MS,slotStart} from '../forecast.mjs';
import {planResources} from '../forecast-planner.mjs';import {ForecastMonitor,notifyForecast} from '../forecast-monitor.mjs';
import {purchaseDecision} from '../purchasing.mjs';
import {Runner} from '../runner.mjs';import {readSource} from '../source.mjs';import {fileURLToPath} from 'node:url';
const now=Date.parse('2028-01-31T23:10:00Z');
function payload(at=now){return {slots:Array.from({length:49},(_,i)=>{const d=new Date(slotStart(at)+i*SLOT_MS);return {day:d.getUTCDate(),time:d.toISOString().slice(11,16),fuel:i?400:1200,co2:i?110:170,is_current:i===0};})};}
const normalized=(at=now)=>normalizeForecast(payload(at),{requestedAt:at});
const state=()=>({version:1,records:[],forecast:null});
const markets=()=>({ok:true,fuel:{ok:true,holding:60000,capacityMax:500000,cash:101000000,pricePer1000:1200},co2:{ok:true,holding:65000,capacityMax:500000,cash:101000000,pricePer1000:170}});
const base=()=>({forecast:normalized(),now,markets:markets(),observedAt:{fuel:now,co2:now},context:{candidateCount:5,resourceBlockedCandidates:3},consumption:{fuel:{unitsPerHour:50000},co2:{unitsPerHour:40000}}});
const matches=kind=>Array.from({length:6},()=>({kind,status:'exact'}));
test('endpoint uses UTC day number and half-hour; calendar rollover and Alaska local day are explicit',()=>{
 assert.match(forecastUrl(now),/day=31&time=23:00&slots=49$/);const f=normalized();assert.equal(f.windows[2].start,'2028-02-01T00:00:00.000Z');
 assert.equal(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Anchorage',hour:'2-digit',hourCycle:'h23'}).format(new Date(f.windows[2].start)),'15');
 const year=normalized(Date.parse('2027-12-31T23:50Z'));assert.equal(year.windows[1].start,'2028-01-01T00:00:00.000Z');
});
test('DST does not change UTC windows; missing prices remain null',()=>{const at=Date.parse('2028-11-05T09:50Z'),p=payload(at);delete p.slots[1].fuel;p.slots[2].co2=null;const f=normalizeForecast(p,{requestedAt:at});assert.equal(f.windows[1].fuel,null);assert.equal(f.windows[2].co2,null);assert.equal(Date.parse(f.windows[2].start)-Date.parse(f.windows[1].start),SLOT_MS);});
test('schema changes, contradictions, invalid values and fetch crossing a transition are rejected',()=>{
 for(const mutate of [p=>p.slots.reverse(),p=>p.slots[2].day=4,p=>p.slots[1].time='01:17',p=>p.slots[1].fuel=-1,p=>p.slots[1].co2='110',p=>p.slots[1].is_current=true,p=>p.slots=[]]){const p=payload();mutate(p);assert.throws(()=>normalizeForecast(p,{requestedAt:now}));}
 assert.throws(()=>normalizeForecast(payload(),{requestedAt:slotStart(now)+SLOT_MS-1,retrievedAt:slotStart(now)+SLOT_MS+1}));
});
test('bounded HTTP retrieval validates status, content type, JSON and never follows a redirect',async()=>{
 let url,opts;const f=await retrieveForecast({now:()=>now,fetcher:async(u,o)=>{url=u;opts=o;return new Response(JSON.stringify(payload()),{headers:{'content-type':'application/json'}});}});assert.equal(f.windows.length,49);assert.equal(opts.redirect,'error');assert.ok(opts.signal);assert.match(url,/prices-api/);
 for(const response of [new Response('bad',{status:503}),new Response('<html>',{headers:{'content-type':'text/html'}}),new Response('x'.repeat(70000),{headers:{'content-type':'application/json'}})])await assert.rejects(retrieveForecast({now:()=>now,fetcher:async()=>response}));
});
test('only predictions retrieved before transition count; current quotes cannot validate themselves',()=>{
 const s=state();addForecast(s,normalized(),now);observeActual(s,'fuel',{ok:true,pricePer1000:1200},now);assert.equal(s.records.some(r=>r.actual!==undefined),false);
 const at=slotStart(now)+SLOT_MS+6000;observeActual(s,'fuel',{ok:true,pricePer1000:400},at);assert.equal(accuracySummary(s.records,'fuel').exact,1);
 addForecast(s,normalized(at),at);assert.equal(s.records.find(r=>r.kind==='fuel'&&Date.parse(r.start)===slotStart(at)).predicted,400);
 observeActual(s,'co2',{ok:true,pricePer1000:125},at);assert.equal(accuracySummary(s.records,'co2').error,1);
});
test('transition jitter ignored, missed/missing transitions and incorrect predictions lower confidence',()=>{
 const s=state(),p=payload();p.slots[2].fuel=null;addForecast(s,normalizeForecast(p,{requestedAt:now}),now);observeActual(s,'fuel',{ok:true,pricePer1000:400},slotStart(now)+SLOT_MS+1000);assert.equal(accuracySummary(s.records,'fuel').exact,0);
 pruneAccuracy(s,now+4*SLOT_MS);const a=accuracySummary(s.records,'fuel');assert.ok(a.missed>0);assert.ok(a.missing>0);assert.equal(a.level,'LOW');assert.equal(accuracySummary([...matches('fuel'),{kind:'fuel',status:'error'}],'fuel').level,'LOW');
 pruneAccuracy(s,now+9*86400000);assert.equal(s.records.length,0);
});
test('shortfall is minimal whole units to resource gate, not invented flight requirements',()=>{
 const p=planResources(base());assert.equal(p.resources.fuel.operationalShortfall,15000);assert.equal(p.resources.co2.operationalShortfall,10000);assert.equal(p.resources.fuel.requiresPolicyChange,true);assert.equal(p.resources.fuel.recommendedOperationalQuantity,15000);assert.equal(p.resources.fuel.premiumJustified,null);assert.equal(p.context.confirmedEnabledDepartures,null);
 const a=base();a.context.routeNeeds=[{fuel:90000,co2:80000}];const q=planResources(a);assert.equal(q.resources.fuel.operationalShortfall,30000);assert.equal(q.resources.co2.operationalShortfall,15000);
});
test('waiting saves money but blocks flight; operational recommendation has priority and priced delay uses explicit assumption',()=>{
 const b=base();b.records=[...matches('fuel'),...matches('co2')];b.opportunityCostPerAircraftHour=10000;const p=planResources(b);assert.equal(p.resources.fuel.recommendation,'MINIMUM_OPERATIONAL_PURCHASE_REVIEW');assert.equal(p.resources.fuel.premiumJustified,false);assert.equal(planResources({...b,opportunityCostPerAircraftHour:20000}).resources.fuel.premiumJustified,true);assert.ok(p.resources.fuel.estimatedSavings>0);assert.equal(p.mode,'ADVISORY_ONLY');
});
test('sufficient projected inventory supports strategic wait, stale/unavailable/error forecasts fall back',()=>{
 const b=base();b.records=matches('fuel');b.markets.fuel.holding=400000;b.context.resourceBlockedCandidates=0;
 assert.equal(planResources(b).resources.fuel.recommendation,'WAIT_FOR_FAVORABLE_WINDOW_ADVISORY');
 for(const update of [{sourceStatus:'UNAVAILABLE'},{now:now+3*SLOT_MS},{records:[{kind:'fuel',status:'error'}]}])assert.notEqual(planResources({...b,...update}).resources.fuel.recommendation,'WAIT_FOR_FAVORABLE_WINDOW_ADVISORY');
 assert.equal(planResources({...b,observedAt:{}}).resources.fuel.operationalShortfall,null);
});
test('cash reserve, shared recommendation budget, capacity and policy boundaries remain intact',()=>{
 const b=base();for(const k of ['fuel','co2'])b.markets[k].cash=100000001;const p=planResources(b);let cost=0;
 for(const r of Object.values(p.resources)){cost+=r.recommendedOperationalQuantity*r.currentGamePrice/1000+(r.nextFavorable?r.recommendedBulkQuantity*r.nextFavorable.price/1000:0);assert.ok(r.recommendedBulkQuantity<=r.capacity);}
 assert.ok(cost<=1);for(const k of ['fuel','co2'])b.markets[k].cash=99999999;assert.equal(planResources(b).resources.fuel.recommendedOperationalQuantity,0);
 const c=base();c.markets.fuel.holding=c.markets.fuel.capacityMax;assert.equal(planResources(c).resources.fuel.recommendedOperationalQuantity,0);
 for(const kind of ['fuel','co2']){const m=markets();m[kind].pricePer1000=kind==='fuel'?1000:150;assert.equal(purchaseDecision(m,kind).decision,'SKIP');m[kind].pricePer1000--;assert.equal(purchaseDecision(m,kind).decision,'BUY');}
});
test('unknown consumption/economics remain unknown; report does not claim aircraft departure readiness',()=>{const b=base();delete b.consumption;b.context={};const p=planResources(b);assert.equal(p.resources.fuel.projectedConsumption,null);assert.equal(p.resources.fuel.operationalShortfall,null);assert.equal(p.resources.fuel.estimatedDelayCost,null);});
test('monitor never blocks caller on HTTP; cadence, failure retry and observers are isolated',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'am4-forecast-'));let at=now,calls=0,release;
 const m=new ForecastMonitor({directory,now:()=>at,fetcher:async()=>{calls++;await new Promise(r=>release=r);return new Response(JSON.stringify(payload(at)),{headers:{'content-type':'application/json'}});}});
 try{m.tick();m.tick();assert.equal(calls,1);m.observeMarkets(markets());assert.equal(calls,1);release();await m.flush();at+=60000;m.tick();assert.equal(calls,1);
 at=slotStart(now)+SLOT_MS+6000;m.fetcher=async()=>{calls++;throw Error('synthetic');};m.tick();await m.flush();assert.equal(m.status,'UNAVAILABLE');assert.equal(m.state.unavailableRetrievals,1);m.tick();assert.equal(calls,2);at+=300001;m.tick();await m.flush();assert.equal(calls,3);
 notifyForecast({update(){throw Error('synthetic');}},'update');assert.equal(JSON.parse(await readFile(join(directory,'resource-advisory-latest.json'),'utf8')).mode,'ADVISORY_ONLY');
 }finally{await m.flush();await rm(directory,{recursive:true,force:true});}
});
test('restart keeps original pre-transition predictions, never invents restored session inventory',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'am4-forecast-'));try{const a=new ForecastMonitor({directory,now:()=>now});addForecast(a.state,normalized(),now);await a.persist();const b=new ForecastMonitor({directory,now:()=>now+SLOT_MS});await b.initialize();assert.equal(b.state.records.length,a.state.records.length);assert.deepEqual(b.markets,{});assert.equal(b.plan().resources.fuel.gameDataFresh,false);}finally{await rm(directory,{recursive:true,force:true});}
});
test('consumption comes only from verified receipt hook, no permanent aircraft histories',async()=>{let at=now;const m=new ForecastMonitor({now:()=>at,enabled:true});m.recordConsumption({fuel:1000,co2:2000});m.recordConsumption({fuel:1000,co2:2000});assert.equal(m.consumption().fuel.unitsPerHour,null);at+=120000;m.recordConsumption({fuel:1000,co2:2000});assert.equal(m.consumption().fuel.unitsPerHour,90000);at+=7200000;assert.equal(m.consumption().fuel.unitsPerHour,null);});
test('real Runner market hook cannot alter observations, cache schedule or purchase policy even when observer throws',async()=>{
 const root=process.env.AM4_SOURCE_ROOT||fileURLToPath(new URL('../../',import.meta.url)),r=new Runner({maxSeconds:30,productionRoot:root},readSource(root),{});r.resources.batch=true;let reads=0;
 const m=markets();for(const k of ['fuel','co2'])m[k].nextRefreshSeconds=1000;
 r.evaluate=async()=>{reads++;return structuredClone(m);};r.forecast={observeMarkets(){throw Error('synthetic advisory fault');}};
 const first=await r.markets(),before=purchaseDecision(first,'fuel');await r.markets();assert.equal(reads,1);assert.equal(r.resources.priceDue('fuel'),false);assert.deepEqual(purchaseDecision(r.resources.value,'fuel'),before);
 const b=base(),copy=structuredClone(b);planResources(b);assert.deepEqual(b,copy);
});
test('cheap current price favors immediate bulk; both operational needs are budgeted before strategic filling',()=>{
 const b=base();b.markets.fuel.pricePer1000=300;const p=planResources(b);assert.equal(p.resources.fuel.bulkWindow,new Date(now).toISOString());assert.equal(p.resources.fuel.estimatedSavings,0);assert.ok(p.resources.co2.recommendedOperationalQuantity>0);
 const d=base();d.markets.fuel.cash=d.markets.co2.cash=100020000;const q=planResources(d);assert.equal(q.resources.fuel.recommendedOperationalQuantity,15000);assert.equal(q.resources.co2.recommendedOperationalQuantity,10000);
});
test('only resource-blocked selected flight requirements inform shortfall; ambiguous or maintenance-blocked panels do not',()=>{
 const m=new ForecastMonitor();m.observeDeparture({flight:{aircraftId:'123',registrations:['N-TEST001'],fuelRequired:90000},eligible:{reasons:['INSUFFICIENT_ROUTE_FUEL']}});assert.deepEqual(m.routeNeeds,[{fuel:90000}]);
 for(const change of [{flight:{registrations:[],fuelRequired:999999},eligible:{reasons:['DISPATCH_RESOURCE_GATE']}},{flight:{aircraftId:'124',registrations:['N-TEST002'],fuelRequired:999999},eligible:{reasons:['INSUFFICIENT_CHECK_HOURS']}}])m.observeDeparture(change);
 assert.equal(m.routeNeeds.length,1);assert.equal(JSON.stringify(m.routeNeeds).includes('N-TEST'),false);
});
test('disabled monitor makes no requests or observations; async advisory failures never become unhandled controller errors',async()=>{
 const off=new ForecastMonitor({enabled:false,fetcher:()=>{throw Error('must not fetch');}});off.tick();off.observeMarkets(markets());off.recordConsumption({fuel:1,co2:1});assert.deepEqual(off.markets,{});assert.equal(off.pending,undefined);
 const m=new ForecastMonitor({now:()=>now});m.refresh=async()=>{throw Error('synthetic unexpected failure');};m.tick();await m.pending;assert.equal(m.status,'ADVISORY_UNAVAILABLE');assert.equal(m.nextFetch,now+300000);
});
test('revised contradictory forecasts retain the original prediction and lower confidence',()=>{const s=state();addForecast(s,normalized(),now);const p=payload();p.slots[1].fuel=450;addForecast(s,normalizeForecast(p,{requestedAt:now+1000}),now+1000);const r=s.records.find(r=>r.kind==='fuel');assert.equal(r.predicted,400);assert.equal(r.latestPredicted,450);assert.equal(accuracySummary(s.records,'fuel').level,'LOW');});
