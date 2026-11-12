// Offline, deterministic replay. Counts real cache decisions and the production purchase coordinator.
// Timing values supplied by the caller are a model, never live-game verification.
import vm from 'node:vm';import {readFileSync} from 'node:fs';import {ResourceCache} from './resource-cache.mjs';import {purchaseDecision} from './purchasing.mjs';
class PreviousCadence extends ResourceCache{
  beginDispatch(){}
  purchaseDue(kind){if(this.marketDue(kind))return true;const m=this.value?.[kind];if(!m?.ok||m.holding>=m.capacityMax)return false;if(m.pricePer1000>=(kind==='fuel'?1000:150))return this.decisions[kind]?.price!==m.pricePer1000;return this.decisions[kind]?.key!==this.purchaseKey(kind);}
}
export async function resourceReplay({previous=false,departures=20,inspectionMs=1600,departureMs=6500,maintenanceMs=4000}={}){
  const production=readFileSync(new URL('./production.mjs',import.meta.url),'utf8');let fn=production.slice(production.indexOf('async function purchaseMarkets('),production.indexOf('\ntry{\n',production.indexOf('async function purchaseMarkets(')));
  if(previous)fn=fn.replace('runner.markets({kinds:[kind]})','runner.markets({fresh:true,kinds:[kind]})');
  let now=0,cash=300000000,reads=0,visits=0,purchases=0;const stock={fuel:4000000,co2:4000000},capacity=4000000,cache=new (previous?PreviousCadence:ResourceCache)({now:()=>now});cache.batch=true;
  const report={purchases:[]},r={resources:cache,deadline:0,markets:options=>cache.read(async kinds=>{reads++;visits+=1+Number((kinds||['fuel','co2']).includes('co2'));return Object.fromEntries([['ok',true],...(kinds||['fuel','co2']).map(k=>[k,{ok:true,kind:k,pricePer1000:k==='fuel'?500:120,holding:stock[k],capacityMax:capacity,capacityUsed:capacity-stock[k],cash,nextRefreshSeconds:1200}])]);},options)};
  const action=async scenario=>{const k=scenario==='PurchaseFuel'?'fuel':'co2';await r.markets({fresh:true,kinds:[k]});await r.markets({fresh:true,kinds:[k]});cash-=Math.round((capacity-stock[k])*(k==='fuel'?500:120)/1000);stock[k]=capacity;cache.invalidate(k);await r.markets({fresh:true,kinds:[k]});purchases++;return {result:'PASS',id:'SYNTHETIC',checkpoint:'SYNTHETIC'};};
  const context={runner:r,report,active(){},purchaseDecision,action,store:{event(){}},appendFileSync(){},join(){return 'SYNTHETIC';},root:'SYNTHETIC',console:{log(){}},save(){},Date};vm.createContext(context);const purchase=vm.runInContext(fn+';purchaseMarkets',context);
  await r.markets();await purchase('BATCH_RESOURCE_READINESS');cache.beginDispatch(departures);
  const header=()=>({fuel:stock.fuel,co2Percent:stock.co2/capacity*100,cash});
  for(let i=0;i<departures;i++){
    if(['fuel','co2'].some(k=>cache.purchaseDue(k)))await purchase('BATCH_RESOURCE_MARGIN_OR_PRICE_CHANGE');
    const before={epoch:1,versions:{fuel:i,co2:i},header:header()};stock.fuel-=1000;stock.co2-=2000;
    cache.debit(before,{epoch:1,versions:{fuel:i+1,co2:i+1},receipt:{routes:1,fuel:1000,co2:2000},header:header()});now+=1000;
    if(previous)await purchase('PREVIOUS_AFTER_EACH_DEPARTURE');
  }
  const modeledDurationMs=maintenanceMs+departures*departureMs+reads*inspectionMs;
  return {kind:previous?'PREVIOUS_CADENCE_REPLAY':'BATCH_CADENCE_REPLAY',departures,resourceObservations:reads,resourceScreenVisits:visits,purchases,maintenanceAssessments:1,modeledNavigationMs:reads*inspectionMs,modeledDurationMs,modeledDeparturesPerMinute:departures*60000/modeledDurationMs,modeledBacklogReduction:departures,note:'Synthetic replay, not measured live dispatch performance. Purchase-template navigation is not included in screen-visit counts.'};
}
