import test from 'node:test';import assert from 'node:assert/strict';
import {resourceStrategy,attachResourceStrategy,consumptionRate,strategySettings} from '../resource-strategy.mjs';
import {ResourceCache} from '../resource-cache.mjs';import {purchaseDecision} from '../purchasing.mjs';
import {Runner} from '../runner.mjs';
const now=Date.UTC(2030,0,1,12,10),iso=t=>new Date(t).toISOString();
const records=Array.from({length:6},()=>({kind:'fuel',status:'exact'}));
const market={ok:true,holding:3000000,capacityMax:5000000,pricePer1000:800,cash:300000000,priceValidUntil:now+1200000,nextRefreshSeconds:1200};
const forecast=(prices=[800,400,1200])=>({retrievedAt:iso(now-60000),windows:prices.map((fuel,i)=>({start:iso(now-600000+i*1800000),end:iso(now+1200000+i*1800000),fuel,co2:120}))});
const samples=[10,20,30].map(minutes=>({at:now-minutes*60000,fuel:100000,co2:50000}));
const base=()=>({kind:'fuel',market:{...market},forecast:forecast(),records:structuredClone(records),sourceStatus:'OK',now,samples:[...samples],started:now-3600000,budget:75000,legacyObserve:false,legacyEvaluate:true});
test('ample inventory waits for a substantial cheaper window using observed burn and absence buffer',()=>{const r=resourceStrategy(base());assert.equal(r.reason,'WAIT_FOR_BETTER_WINDOW');assert.equal(r.buy,false);assert.equal(r.observe,false);assert.equal(r.projectedConsumption,150000);assert.ok(r.operatingBuffer>=225000);});
test('expensive windows with ample stock do not cause resource navigation',()=>{const b=base();b.market.pricePer1000=1300;b.market.priceValidUntil=now-1;b.forecast=forecast([1300,1400,500]);const r=resourceStrategy(b);assert.equal(r.reason,'HIGH_PRICE_HOLD');assert.equal(r.observe,false);assert.equal(r.evaluate,false);assert.ok(r.nextAt>now);});
test('low stock protects continuity; marginal savings do not delay buying; material spike savings can top up before the normal capacity trigger',()=>{
 const low=base();low.market.holding=100000;assert.equal(resourceStrategy(low).reason,'RESERVE_PROTECTION');assert.equal(resourceStrategy(low).buy,true);
 const marginal=base();marginal.forecast=forecast([800,799,850]);assert.equal(resourceStrategy(marginal).reason,'BUY_NOW');
 const spike=base();spike.market.holding=4900000;spike.forecast.windows[1].start=iso(now+60000);spike.forecast.windows[1].fuel=1400;spike.forecast.windows[2].fuel=1400;const r=resourceStrategy(spike);assert.equal(r.reason,'BUY_BEFORE_PRICE_INCREASE');assert.equal(r.buy,true);spike.market.holding=4999999;assert.equal(resourceStrategy(spike).buy,false,'one tiny gap must not reopen a market on each departure');
});
test('full storage and small favorable-window capacity accumulate without per-aircraft topups',()=>{const b=base();b.market.holding=5000000;assert.equal(resourceStrategy(b).reason,'INSUFFICIENT_CAPACITY');b.market.holding=4900000;b.forecast=forecast([700,800,850]);assert.equal(resourceStrategy(b).reason,'CAPACITY_ACCUMULATING');});
test('stale, missing, failed, inaccurate or unproven forecasts fall back to actual game policy',()=>{
 for(const mutate of [b=>b.forecast=null,b=>b.forecast.retrievedAt=iso(now-7200000),b=>b.sourceStatus='UNAVAILABLE',b=>b.records.push({kind:'fuel',status:'error'}),b=>b.records=[]]){const b=base();mutate(b);const r=resourceStrategy(b);assert.equal(r.reason,'FORECAST_UNAVAILABLE');assert.equal(r.evaluate,b.legacyEvaluate);assert.equal(r.observe,b.legacyObserve);assert.equal(r.buy,true);}
});
test('observed fleet activity changes rate and buffer; unknown consumption cannot authorize forecast waiting',()=>{
 const b=base(),before=resourceStrategy(b);b.samples.push(...[1,2,3].map(minutes=>({at:now-minutes*60000,fuel:700000,co2:50000})));const after=resourceStrategy(b);assert.ok(after.consumptionPerHour>before.consumptionPerHour);assert.ok(after.operatingBuffer>before.operatingBuffer);assert.equal(after.reason,'RESERVE_PROTECTION');b.samples=[];assert.equal(resourceStrategy(b).reason,'FORECAST_UNAVAILABLE');assert.equal(consumptionRate([], 'fuel',now,now),null);
});
test('manual inventory change invalidates working quantities and forces authoritative reconciliation',()=>{const c=new ResourceCache({now:()=>now});c.value={ok:true,fuel:{...market},co2:{...market}};attachResourceStrategy(c,{state:{forecast:forecast(),records},status:'OK',samples,started:now-3600000});assert.equal(c.purchaseDue('fuel'),false);assert.equal(c.observeHeader({fuel:1000000,co2Percent:60,cash:300000000}),false);assert.equal(c.purchasePlan('fuel').reason,'INVENTORY_RECONCILIATION');assert.equal(c.marketDue('fuel'),true);});
test('many receipt-accounted departures and expensive transitions reuse stock without opening markets',async()=>{
 let t=now,reads=0;const c=new ResourceCache({now:()=>t});c.batch=true;const markets={ok:true,fuel:{...market,holding:5000000,pricePer1000:1300},co2:{...market,holding:5000000,pricePer1000:170}};
 await c.read(async()=>{reads++;return markets;});const f=forecast([1300,1400,500]);for(const w of f.windows)w.co2=170;
 attachResourceStrategy(c,{state:{forecast:f,records:[...records,...records.map(r=>({...r,kind:'co2'}))]},status:'OK',samples,started:now-3600000});c.beginDispatch(20);
 for(let i=0;i<20;i++){const before={epoch:1,versions:{fuel:i,co2:i},header:{fuel:5000000-i*1000}};assert.equal(c.debit(before,{epoch:1,versions:{fuel:i+1,co2:i+1},receipt:{routes:1,fuel:1000,co2:1000},header:{fuel:4999000-i*1000,co2Percent:(4999000-i*1000)/5000000*100}}),true);t+=60000;await c.read(async()=>{reads++;return markets;});}
 assert.equal(reads,1);assert.equal(c.metrics.receiptDebits,20);
});
test('actual price ceilings, reserve and exact maximum quantities remain authoritative',()=>{for(const [kind,ceiling] of [['fuel',1000],['co2',150]]){const m={ok:true,[kind]:{...market,pricePer1000:ceiling}};assert.equal(purchaseDecision(m,kind).decision,'SKIP');m[kind].pricePer1000=ceiling-1;m[kind].cash=100000000;assert.equal(purchaseDecision(m,kind).decision,'SKIP');m[kind].cash=100000001;assert.equal(purchaseDecision(m,kind).maximumUnits,Math.floor(1000/(ceiling-1)));}});
test('fresh purchase quote is subject to strategy before durable intent or click',async()=>{let intents=0,clicks=0;const r={markets:async()=>({fuel:market}),resources:{purchasePlan:()=>({buy:false,reason:'WAIT_FOR_BETTER_WINDOW'})},store:{intent(){intents++;}},evaluate(){clicks++;},options:{live:true}};const report={};await Runner.prototype.purchase.call(r,report,'fuel');assert.equal(report.reason,'WAIT_FOR_BETTER_WINDOW');assert.equal(intents,0);assert.equal(clicks,0);});
test('settings are bounded and disabling the strategy preserves the established policy',()=>{assert.throws(()=>strategySettings({uncertaintyFactor:0}));const b=base();b.config={enabled:false};assert.equal(resourceStrategy(b).reason,'EXISTING_GAME_POLICY');});
test('fuel and CO2 are scheduled independently, with fresh actual quotes required when a favorable window arrives',()=>{
 const b=base();b.forecast=forecast([1300,1400,500]);b.market.pricePer1000=1300;
 assert.equal(resourceStrategy(b).evaluate,false);
 const co2={...b,kind:'co2',market:{...b.market,pricePer1000:120},records:records.map(r=>({...r,kind:'co2'}))};assert.equal(resourceStrategy(co2).reason,'BUY_NOW');
 co2.market.priceValidUntil=now-1;assert.equal(resourceStrategy(co2).reason,'FAVORABLE_WINDOW_REQUIRES_ACTUAL_QUOTE');assert.equal(resourceStrategy(co2).observe,true);
});
test('restart never restores trusted inventory or demand from forecast history',()=>{const c=new ResourceCache({now:()=>now});attachResourceStrategy(c,{state:{forecast:forecast(),records},status:'OK',samples:[],started:now});assert.equal(c.purchasePlan('fuel').reason,'INVENTORY_RECONCILIATION');c.value={fuel:{...market}};assert.equal(c.purchasePlan('fuel').reason,'FORECAST_UNAVAILABLE');});

