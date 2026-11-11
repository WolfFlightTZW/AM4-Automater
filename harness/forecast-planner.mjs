// Advisory arithmetic. Never invokes actions, changes cache deadlines or overrides policy.
import {SLOT_MS,slotStart,accuracySummary} from './forecast.mjs';
const ceilings={fuel:1000,co2:150},reserve=100000000;
const integer=n=>Number.isSafeInteger(n)&&n>=0;
export function planResources({forecast,records=[],markets={},observedAt={},now=Date.now(),consumption={},context={},opportunityCostPerAircraftHour=null,sourceStatus='OK'}){
  const fresh=forecast&&now>=Date.parse(forecast.retrievedAt)&&now-Date.parse(forecast.retrievedAt)<=2*SLOT_MS&&forecast.windows.some(w=>Date.parse(w.start)<=now&&Date.parse(w.end)>now);
  const cashValues=['fuel','co2'].map(k=>markets[k]?.cash).filter(integer);let spendable=cashValues.length?Math.max(0,Math.min(...cashValues)-reserve):0;
  // Reserve both minimal operational quantities before allocating any strategic quantity.
  const operationalBudgets={};let operationalCash=spendable;
  for(const k of ['fuel','co2']){
    const m=markets[k],valid=m?.ok&&integer(m.holding)&&integer(m.capacityMax)&&m.capacityMax>=m.holding&&integer(m.cash)&&Number.isSafeInteger(m.pricePer1000)&&m.pricePer1000>0&&Number.isFinite(observedAt[k])&&slotStart(observedAt[k])===slotStart(now)&&observedAt[k]<=now;
    const needs=(context.routeNeeds||[]).map(n=>n[k]).filter(integer),shortfall=valid&&context.resourceBlockedCandidates>0?Math.max(0,Math.max(75000,needs.length?Math.min(...needs):0)-m.holding):0;
    operationalBudgets[k]=valid?Math.min(shortfall,m.capacityMax-m.holding,Number(BigInt(Math.floor(operationalCash))*1000n/BigInt(m.pricePer1000))):0;
    if(valid)operationalCash=Math.max(0,operationalCash-operationalBudgets[k]*m.pricePer1000/1000);
  }
  spendable=operationalCash;
  const resources={};
  for(const kind of ['fuel','co2']){
    const m=markets[kind],accuracy=accuracySummary(records,kind),gameFresh=m?.ok&&integer(m.holding)&&integer(m.capacityMax)&&m.capacityMax>=m.holding&&integer(m.cash)&&Number.isSafeInteger(m.pricePer1000)&&m.pricePer1000>0&&Number.isFinite(observedAt[kind])&&now-observedAt[kind]>=0&&slotStart(observedAt[kind])===slotStart(now);
    const usable=fresh&&sourceStatus==='OK'&&accuracy.level==='PROVISIONAL';
    const future=fresh?forecast.windows.filter(w=>Date.parse(w.start)>now&&Number.isSafeInteger(w[kind])&&w[kind]<ceilings[kind]):[];
    const next=future[0]||null,wait=next?(Date.parse(next.start)-now)/60000:null;
    const free=gameFresh?m.capacityMax-m.holding:null;
    const knownNeeds=(context.routeNeeds||[]).map(n=>n[kind]).filter(integer);
    const minimum= Math.max(75000,knownNeeds.length?Math.min(...knownNeeds):0);
    const shortfall=gameFresh&&context.resourceBlockedCandidates>0?Math.max(0,minimum-m.holding):gameFresh&&context.resourceBlockedCandidates===0?0:null;
    const operational=operationalBudgets[kind];
    const rate=Number.isFinite(consumption[kind]?.unitsPerHour)&&consumption[kind].unitsPerHour>=0?consumption[kind].unitsPerHour:null;
    const projected=rate!==null&&wait!==null?Math.ceil(rate*wait/60):null;
    const delayCost=wait!==null&&Number.isFinite(opportunityCostPerAircraftHour)&&opportunityCostPerAircraftHour>=0&&Number.isInteger(context.resourceBlockedCandidates)?wait/60*context.resourceBlockedCandidates*opportunityCostPerAircraftHour:null;
    const premium=gameFresh&&next?Math.max(0,m.pricePer1000-next[kind])*operational/1000:null;
    const bulkNow=gameFresh&&m.pricePer1000<ceilings[kind]&&(!next||next[kind]>=m.pricePer1000);
    const bulkPrice=bulkNow?m.pricePer1000:next?.[kind],bulkAt=bulkNow?new Date(now).toISOString():next?.start;
    const capacityAtWindow=gameFresh?Math.max(0,(bulkNow?free:projected!==null?Math.min(m.capacityMax,free+Math.min(m.holding,projected)):free)-operational):0;
    const bulk=bulkPrice&&gameFresh?Math.min(capacityAtWindow,Number(BigInt(Math.floor(spendable))*1000n/BigInt(bulkPrice))):0;
    const requiresPolicyChange=gameFresh&&m.pricePer1000>=ceilings[kind]&&operational>0;
    const recommendation=!gameFresh?'INSUFFICIENT_CURRENT_GAME_DATA':!usable?'EXISTING_GAME_POLICY_ONLY':shortfall>0?'MINIMUM_OPERATIONAL_PURCHASE_REVIEW':next&&next[kind]<m.pricePer1000&&projected!==null&&m.holding-projected>=minimum?'WAIT_FOR_FAVORABLE_WINDOW_ADVISORY':'EXISTING_GAME_POLICY_ONLY';
    resources[kind]={currentGamePrice:m?.pricePer1000??null,currentForecastPrice:forecast?.windows?.find(w=>Date.parse(w.start)<=now&&Date.parse(w.end)>now)?.[kind]??null,gameObservedAt:Number.isFinite(observedAt[kind])?new Date(observedAt[kind]).toISOString():null,gameDataFresh:Boolean(gameFresh),inventory:m?.holding??null,capacity:m?.capacityMax??null,cashReserve:reserve,purchaseCeiling:ceilings[kind],nextFavorable:next?{at:next.start,price:next[kind],minutesRemaining:wait}:null,projectedConsumption:projected,consumptionUnitsPerHour:rate,consumptionBasis:consumption[kind]?.basis??'UNAVAILABLE',operationalShortfall:shortfall,recommendedOperationalQuantity:operational,operationalQuantitySufficient:shortfall!==null?operational>=shortfall:null,operationalBasis:'RESTORES_EXISTING_RESOURCE_GATE; ROUTE_NEEDS_ONLY_WHEN_ALREADY_OBSERVED; DEPART_CONTROL_NOT_INFERRED',recommendedBulkQuantity:bulk,bulkWindow:bulkAt??null,recommendedBulkPrice:bulkPrice??null,bulkQuantityBasis:bulkNow?'CURRENT_FREE_CAPACITY':projected===null?'CURRENT_FREE_CAPACITY_ONLY_CONSUMPTION_UNKNOWN':'PROJECTED_CAPACITY_AT_WINDOW',estimatedSavings:gameFresh&&bulkPrice?Math.round((m.pricePer1000-bulkPrice)*bulk/1000*100)/100:null,premiumForImmediateOperationalPurchase:premium,estimatedDelayCost:delayCost,premiumJustified:delayCost===null||premium===null?null:delayCost>premium,delayCostReason:delayCost===null?'NO_OPERATOR_OPPORTUNITY_COST_ASSUMPTION': 'CONFIGURED_AIRCRAFT_HOUR_OPPORTUNITY_COST',requiresPolicyChange,confidence:{...accuracy,forecastFresh:Boolean(fresh),sourceStatus},forecastRecommendationTrusted:Boolean(usable),recommendation};
    // Recommendations share one conservative cash budget; no double-spending in the plan.
    if(gameFresh)spendable=Math.max(0,spendable-(bulkPrice?bulk*bulkPrice/1000:0));
  }
  return {mode:'ADVISORY_ONLY',at:new Date(now).toISOString(),source:forecast?.source??null,retrievedAt:forecast?.retrievedAt??null,sourceStatus,context:{candidateCount:context.candidateCount??null,resourceBlockedCandidates:context.resourceBlockedCandidates??null,confirmedEnabledDepartures:context.confirmedEnabledDepartures??null},resources,policyEffect:'NONE: existing game-driven purchasing and dispatch remain unchanged'};
}
