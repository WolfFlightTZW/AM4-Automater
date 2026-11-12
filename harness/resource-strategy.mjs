// Session-only purchasing schedule. Forecasts never authorize a click or set a transaction price.
import {accuracySummary,SLOT_MS} from './forecast.mjs';
export const resourceStrategyDefaults=Object.freeze({enabled:true,absenceMinutes:30,uncertaintyFactor:1.5,minimumSavings:5000,minimumSavingsFraction:0.1,topUpCapacityFraction:0.1,maxDeferredMinutes:30});
export function strategySettings(options={}){
  const c={...resourceStrategyDefaults,...options};
  if(typeof c.enabled!=='boolean'||!['absenceMinutes','uncertaintyFactor','minimumSavings','minimumSavingsFraction','topUpCapacityFraction','maxDeferredMinutes'].every(k=>Number.isFinite(c[k]))||c.absenceMinutes<0||c.absenceMinutes>1440||c.uncertaintyFactor<1||c.uncertaintyFactor>10||c.minimumSavings<0||c.minimumSavingsFraction<0||c.minimumSavingsFraction>1||c.topUpCapacityFraction<=0||c.topUpCapacityFraction>1||c.maxDeferredMinutes<1||c.maxDeferredMinutes>60)throw Error('INVALID_RESOURCE_STRATEGY_SETTINGS');
  return c;
}
export function consumptionRate(samples,kind,started,now){
  const rates=[900000,3600000].map(span=>{
    const rows=(Array.isArray(samples)?samples:[]).filter(s=>s&&s.at>=Math.max(started,now-span)&&s.at<=now&&Number.isSafeInteger(s[kind])&&s[kind]>=0);
    const elapsed=now-Math.max(started,now-span);
    return rows.length>=3&&elapsed>=60000?rows.reduce((sum,r)=>sum+r[kind],0)*3600000/elapsed:null;
  }).filter(Number.isFinite);
  return rates.length?Math.max(...rates):null;
}
export function resourceStrategy({kind,market:m,forecast,records=[],sourceStatus,now=Date.now(),samples=[],started=now,usage=0,remaining=0,budget=75000,legacyObserve=true,legacyEvaluate=true,config={}}){
  const c=strategySettings(config),ceiling=kind==='fuel'?1000:150;
  const base={kind,reason:'FORECAST_UNAVAILABLE',observe:legacyObserve,evaluate:legacyEvaluate,buy:true,nextAt:m?.priceValidUntil??now,forecastTrusted:false};
  if(!c.enabled)return {...base,reason:'EXISTING_GAME_POLICY'};
  if(!m?.ok||!Number.isSafeInteger(m.holding)||!Number.isSafeInteger(m.capacityMax)||m.holding<0||m.capacityMax<m.holding)return {...base,reason:'INVENTORY_RECONCILIATION',observe:true,evaluate:true};
  const free=m.capacityMax-m.holding;
  if(free<1)return {...base,reason:'INSUFFICIENT_CAPACITY',observe:false,evaluate:false,buy:false,nextAt:null};
  const windows=Array.isArray(forecast?.windows)?forecast.windows:[],current=windows.find(w=>Date.parse(w.start)<=now&&Date.parse(w.end)>now);
  const fresh=Number.isFinite(Date.parse(forecast?.retrievedAt))&&now>=Date.parse(forecast.retrievedAt)&&now-Date.parse(forecast.retrievedAt)<=2*SLOT_MS;
  const trusted=fresh&&sourceStatus==='OK'&&Array.isArray(records)&&accuracySummary(records.filter(r=>r&&typeof r==='object'),kind).level==='PROVISIONAL'&&Number.isSafeInteger(current?.[kind])&&current[kind]>0;
  // Unproven forecasts or demand never change the established game-driven purchase policy.
  const rate=consumptionRate(samples,kind,started,now);
  if(!trusted||rate===null)return {...base,consumptionPerHour:rate,forecastTrusted:Boolean(trusted)};
  const buffer=Math.ceil(Math.max(budget,rate*c.absenceMinutes/60*c.uncertaintyFactor,Math.max(0,remaining)*Math.max(0,usage)*1.25));
  const future=windows.filter(w=>Date.parse(w.start)>now&&Number.isSafeInteger(w[kind])&&w[kind]>0).sort((a,b)=>Date.parse(a.start)-Date.parse(b.start));
  const quoteFresh=now<(m.priceValidUntil??0),low=m.holding<=buffer;
  const result={...base,forecastTrusted:true,consumptionPerHour:rate,operatingBuffer:buffer,holding:m.holding,freeCapacity:free};
  const defer=(reason,at)=>({...result,reason,observe:false,evaluate:false,buy:false,nextAt:Math.min(at,now+c.maxDeferredMinutes*60000,now+Math.max(60000,(m.holding-buffer)/rate*3600000/c.uncertaintyFactor))});
  if(low)return {...result,reason:'RESERVE_PROTECTION',observe:!quoteFresh,evaluate:!quoteFresh||m.pricePer1000<ceiling,buy:true};
  // While a known expensive quote is valid, no forecast can make it purchasable.
  if((quoteFresh?m.pricePer1000:current[kind])>=ceiling){
    const favorable=future.find(w=>w[kind]<ceiling);
    return defer('HIGH_PRICE_HOLD',favorable?Date.parse(favorable.start):now+c.maxDeferredMinutes*60000);
  }
  if(!quoteFresh)return {...result,reason:'FAVORABLE_WINDOW_REQUIRES_ACTUAL_QUOTE',observe:true,evaluate:true,buy:true,nextAt:now};
  const cheaper=future.find(w=>w[kind]<m.pricePer1000&&w[kind]<ceiling&&((m.pricePer1000-w[kind])/m.pricePer1000>=c.minimumSavingsFraction)&&(m.pricePer1000-w[kind])*free/1000>=c.minimumSavings);
  if(cheaper){
    const projected=Math.ceil(rate*(Date.parse(cheaper.start)-now)/3600000*c.uncertaintyFactor);
    if(m.holding-projected>buffer)return {...defer('WAIT_FOR_BETTER_WINDOW',Date.parse(cheaper.start)),projectedConsumption:projected,nextFavorable:cheaper.start,estimatedSavings:(m.pricePer1000-cheaper[kind])*free/1000};
  }
  const next=future[0],spike=next&&Date.parse(next.start)-now<=5*60000&&next[kind]>m.pricePer1000*(1+c.minimumSavingsFraction)&&(next[kind]-m.pricePer1000)*free/1000>=c.minimumSavings;
  if(spike||free>=m.capacityMax*c.topUpCapacityFraction)return {...result,reason:spike?'BUY_BEFORE_PRICE_INCREASE':'BUY_NOW',observe:false,evaluate:true,buy:true,nextAt:now};
  return defer('CAPACITY_ACCUMULATING',m.priceValidUntil);
}
export function attachResourceStrategy(cache,monitor,config={}){
  const options=strategySettings(config);
  cache.purchasePlan=kind=>resourceStrategy({kind,market:cache.value?.[kind],forecast:monitor.state.forecast,records:monitor.state.records,sourceStatus:monitor.status,now:cache.now(),samples:monitor.samples,started:monitor.started,usage:cache.usage[kind],remaining:cache.dispatchRemaining??0,budget:cache.resourceBudget(kind),legacyObserve:cache.legacyMarketDue(kind),legacyEvaluate:cache.legacyPurchaseDue(kind),config:options});
}
