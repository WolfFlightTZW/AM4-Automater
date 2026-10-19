// All market quantities, balances and prices below are invented offline fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {purchaseDecision,reconcilePurchase} from '../purchasing.mjs';
import {verifyPurchase} from '../policy.mjs';
for(const [kind,price] of [['fuel',500],['co2',125]]){
  for(const free of [1,2,999,1000,3211])test(`${kind}: buy all ${free} synthetic free whole units without a minimum`,()=>{
    const m={[kind]:{ok:true,pricePer1000:price,capacityMax:10000,holding:10000-free,cash:250000000}};
    const d=purchaseDecision(m,kind);assert.equal(d.decision,'BUY');assert.equal(d.maximumUnits,free);
  });
  test(`${kind}: log an explicit hold even when price/capacity/cash qualify`,()=>{
    const m={[kind]:{ok:true,pricePer1000:price,capacityMax:4001,holding:1,cash:250000000}};
    const d=purchaseDecision(m,kind,[{id:'synthetic-intent',state:'UNKNOWN'}]);assert.equal(d.qualifying,true);assert.equal(d.reason,'UNRESOLVED_TRANSACTION_HOLD');assert.equal(d.maximumUnits,4000);
  });
}
test('A synthetic non-thousand-unit capacity is filled exactly',()=>{
  const d=purchaseDecision({co2:{ok:true,pricePer1000:125,capacityMax:10000,holding:6789,cash:250000000}},'co2');assert.equal(d.maximumUnits,3211);assert.equal(d.decision,'BUY');
});
test('Synthetic whole-dollar UI accepts only the possible cash interval',()=>{
  const r={clickAttempted:true,requested:3211,holdingIncrease:3211,estimatedCost:401,quotedCost:401,exactCost:401.375,cashPrecision:'WHOLE_DOLLAR_UI'};
  for(const cashDecrease of [401,402])assert.equal(verifyPurchase({...r,cashDecrease}).result,'PASS');
  for(const cashDecrease of [1,400,403])assert.equal(verifyPurchase({...r,cashDecrease}).result,'INCONCLUSIVE');
  assert.equal(verifyPurchase({...r,cashDecrease:402,holdingIncrease:3210}).result,'INCONCLUSIVE');
});
test('Synthetic recovery reconciles an exact quantity and rounded cash without resubmission',()=>{
  const a={kind:'purchase',registration:'co2',state:'UNKNOWN',quote:{requested:3211,cost:401},before:{co2:{ok:true,pricePer1000:125,holding:6789,cash:250000000}}};
  assert.equal(reconcilePurchase(a,{co2:{ok:true,holding:10000,cash:249999598}})?.cashDecrease,402);
  assert.equal(reconcilePurchase(a,{co2:{ok:true,holding:10000,cash:249999597}}),null);
});
