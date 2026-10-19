import { wholeQuantity,verifyPurchase } from './policy.mjs';
// One common policy for fuel and CO2. There is deliberately no lot/minimum size.
export function purchaseDecision(markets,kind,holds=[]) {
  const m=markets?.[kind],ceiling=kind==='fuel'?1000:150;
  const d={kind,price:m?.pricePer1000,ceiling,cash:m?.cash,holding:m?.holding,capacity:m?.capacityMax,freeUnits:null,maximumUnits:0,qualifying:false,decision:'SKIP',reason:null};
  if(!m?.ok){d.reason='MARKET_VALUES_UNAVAILABLE';return d;}
  try{d.maximumUnits=wholeQuantity({kind,price:m.pricePer1000,capacity:m.capacityMax,holding:m.holding,cash:m.cash});}catch{d.reason='MARKET_VALUES_INVALID';return d;}
  d.freeUnits=m.capacityMax-m.holding;
  d.qualifying=d.maximumUnits>0;
  if(m.pricePer1000>=ceiling)d.reason='PRICE_AT_OR_ABOVE_CEILING';
  else if(d.freeUnits<1)d.reason='NO_WHOLE_UNIT_FREE_CAPACITY';
  else if(!d.maximumUnits)d.reason='CASH_RESERVE_PREVENTS_ANY_WHOLE_UNIT';
  else if(holds.length){d.reason='UNRESOLVED_TRANSACTION_HOLD';d.holds=holds.map(h=>({id:h.id||h.key,state:h.state}));}
  else{d.decision='BUY';d.reason='QUALIFIED_BUY_MAXIMUM_EXACT_WHOLE_UNITS';}
  return d;
}
export function reconcilePurchase(action,markets){
  if(action.kind!=='purchase'||!['PENDING','UNKNOWN'].includes(action.state))return null;
  const before=action.before?.[action.registration],after=markets?.[action.registration],requested=action.quote?.requested;
  if(!before?.ok||!after?.ok||!Number.isSafeInteger(requested)||requested<1||after.cash<100000000)return null;
  const exactCost=requested*before.pricePer1000/1000,quotedCost=action.quote.cost;
  const result={ok:true,status:'VERIFIED',clickAttempted:true,requested,exactCost,estimatedCost:quotedCost,quotedCost,cashPrecision:'WHOLE_DOLLAR_UI',before:{price:before.pricePer1000,holding:before.holding,cash:before.cash},after:{holding:after.holding,cash:after.cash},holdingIncrease:after.holding-before.holding,cashDecrease:before.cash-after.cash};
  return verifyPurchase(result).result==='PASS'?result:null;
}
