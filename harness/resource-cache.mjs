// Session-only observations and receipt-accounted working inventory. Nothing is persisted.
export class ResourceCache {
  constructor({maxAgeMs=10000,unreliableTimerRetryMs=60000,now=Date.now}={}){this.unreliableTimerRetryMs=unreliableTimerRetryMs;this.maxAgeMs=maxAgeMs;this.now=now;this.batch=false;this.dispatchRemaining=null;this.usage={fuel:0,co2:0};this.decisions={};this.logKeys={};this.invalidate();this.metrics={reads:0,hits:0,invalidations:0,receiptDebits:0,uncertainDebits:0,headerMismatches:0};}
  invalidate(kind){this.headerAnchor=null;if(kind&&this.value){delete this.value[kind];this.value.ok=false;}else{this.value=null;this.at=0;}if(this.metrics)this.metrics.invalidations++;}
  priceDue(kind){return kind?this.marketDue(kind):['fuel','co2'].some(k=>this.marketDue(k));}
  marketDue(kind){const m=this.value?.[kind];if(m&&!m.ok&&this.now()<m.priceValidUntil)return false;if(m?.ok&&this.now()-(m.observedAt??this.now())>=1800000)return true;return this.purchasePlan?this.purchasePlan(kind).observe:this.legacyMarketDue(kind);}
  legacyMarketDue(kind){const m=this.value?.[kind];return !m||(!(m.ok&&m.holding>=m.capacityMax)&&this.now()>=(m.priceValidUntil??0));}
  beginDispatch(count){this.dispatchRemaining=count;}
  endDispatch(){this.dispatchRemaining=null;}
  resourceBudget(kind,required=0){
    const count=Math.min(10,this.dispatchRemaining??0);
    // Planning margin only: actual enabled controls, headers and route needs still govern each click.
    const margin=Math.min(Math.ceil(this.usage[kind]*1.25)*count,Math.floor((this.value?.[kind]?.capacityMax||0)/4));
    return 75000+Math.max(required,margin);
  }
  dispatchPurchaseDue(kind,required=0){
    if(this.legacyMarketDue(kind))return true;
    const m=this.value?.[kind];if(!m?.ok)return true;
    if(m.holding>=m.capacityMax)return false;
    if(m.pricePer1000>=(kind==='fuel'?1000:150))return this.decisions[kind]?.price!==m.pricePer1000;
    if(this.decisions[kind]?.price!==m.pricePer1000||this.decisions[kind]?.window!==Math.round(m.priceValidUntil/60000))return true;
    return m.holding<this.resourceBudget(kind,required);
  }
  purchaseKey(kind){const m=this.value?.[kind];return m?JSON.stringify([m.pricePer1000,m.holding,m.capacityMax,m.cash]):null;}
  purchaseDue(kind){const m=this.value?.[kind];if(m&&!m.ok&&this.now()<m.priceValidUntil)return false;return this.purchasePlan?this.purchasePlan(kind).evaluate:this.legacyPurchaseDue(kind);}
  legacyPurchaseDue(kind){
    if(this.dispatchRemaining!==null)return this.dispatchPurchaseDue(kind);
    if(this.legacyMarketDue(kind))return true;
    const m=this.value?.[kind];if(!m?.ok||m.holding>=m.capacityMax)return false;
    if(m.pricePer1000>=(kind==='fuel'?1000:150))return this.decisions[kind]?.price!==m.pricePer1000;
    return this.decisions[kind]?.key!==this.purchaseKey(kind);
  }
  recordPurchaseDecision(kind,d){
    this.decisions[kind]={key:this.purchaseKey(kind),price:this.value?.[kind]?.pricePer1000,window:Math.round(this.value?.[kind]?.priceValidUntil/60000)};
    const key=JSON.stringify([d.decision,d.reason,d.price,d.holding,d.capacity,...(d.reason==='CASH_RESERVE_PREVENTS_ANY_WHOLE_UNIT'?[d.cash]:[])]);
    const changed=d.decision!=='SKIP'||this.logKeys[kind]!==key;this.logKeys[kind]=key;return changed;
  }
  low(){return !this.value||['fuel','co2'].some(k=>!Number.isSafeInteger(this.value[k]?.holding)||this.value[k].holding<250000);}
  anchorHeader(header){
    // A fresh market observation is authoritative. The cosmetic header can be stale.
    if(this.value?.ok&&Number.isSafeInteger(header?.fuel)&&Number.isFinite(header.co2Percent)){this.headerAnchor={fuel:header.fuel,co2Percent:header.co2Percent};if(header.fuel!==this.value.fuel.holding)this.lastReconciliation={source:'CURRENT_MARKET_HOLDING',fuel:this.value.fuel.holding,staleHeaderFuel:header.fuel,gap:header.fuel-this.value.fuel.holding};}
  }
  headerMatches(header,holding=this.value,alternatives=[]){
    if(!holding?.fuel?.ok||!holding.co2?.ok||!Number.isSafeInteger(header?.fuel)||!Number.isFinite(header.co2Percent))return false;
    const candidates=[{fuel:holding.fuel.holding,co2Percent:holding.co2.holding/holding.co2.capacityMax*100},...alternatives.filter(Boolean)];
    return candidates.some(h=>h.fuel===header.fuel)&&candidates.some(h=>Number.isFinite(h.co2Percent)&&Math.abs(h.co2Percent-header.co2Percent)<=0.00011);
  }
  observeHeader(header){
    if(!this.value?.ok)return false;
    if(!this.headerMatches(header,this.value,[this.headerAnchor])){this.lastIssue='AUTHORITATIVE_HEADER_CHANGED';this.metrics.headerMismatches++;this.invalidate();return false;}
    if(Number.isSafeInteger(header.cash))for(const k of ['fuel','co2'])this.value[k].cash=header.cash;return true;
  }
  receiptProof(before,after){
    const v=this.value,r=after?.receipt;
    if(!v?.ok||!before||!after||!Number.isSafeInteger(before.epoch)||before.epoch!==after.epoch||!(after.versions?.fuel>before.versions?.fuel&&after.versions?.co2>before.versions?.co2)||r?.routes!==1||![r.fuel,r.co2].every(n=>Number.isSafeInteger(n)&&n>=0)||r.fuel>v.fuel.holding||r.co2>v.co2.holding||!(this.headerAnchor?this.headerMatches(before.header,v,[this.headerAnchor]):before.header?.fuel===v.fuel.holding))return false;
    const expected={fuel:{...v.fuel,holding:v.fuel.holding-r.fuel},co2:{...v.co2,holding:v.co2.holding-r.co2}};
    const relative={fuel:before.header.fuel-r.fuel,co2Percent:before.header.co2Percent-r.co2/v.co2.capacityMax*100};
    return this.headerMatches(after.header,expected,this.headerAnchor?[before.header,relative]:[]);
  }
  debitReady(before,after){return this.receiptProof(before,after);}
  debit(before,after){
    if(!this.receiptProof(before,after)){this.lastIssue='RECEIPT_OR_HEADER_UNCERTAIN';this.metrics.uncertainDebits++;this.invalidate();return false;}
    const v=this.value,r=after.receipt;for(const k of ['fuel','co2']){v[k].holding-=r[k];v[k].capacityUsed=v[k].capacityMax-v[k].holding;this.usage[k]=Math.max(this.usage[k],r[k]);}
    this.anchorHeader(after.header);if(Number.isSafeInteger(after.header.cash))for(const k of ['fuel','co2'])v[k].cash=after.header.cash;
    if(this.dispatchRemaining!==null)this.dispatchRemaining=Math.max(0,this.dispatchRemaining-1);this.lastIssue=null;this.metrics.receiptDebits++;return true;
  }
  observeBurn(receipt){
    if(!Number.isInteger(receipt?.routes)||receipt.routes<1)return;
    for(const k of ['fuel','co2'])if(Number.isSafeInteger(receipt[k])&&receipt[k]>0)this.usage[k]=Math.max(this.usage[k],Math.ceil(receipt[k]/receipt.routes));
  }
  debitBulk(before,after,count){
    if(!Number.isInteger(count)||count<1||after?.receipt?.routes!==count){this.invalidate();return false;}
    const usage={...this.usage};
    const ok=this.debit(before,{...after,receipt:{...after.receipt,routes:1}});
    if(ok){for(const k of ['fuel','co2'])this.usage[k]=Math.max(usage[k],Math.ceil(after.receipt[k]/count));if(this.dispatchRemaining!==null)this.dispatchRemaining=Math.max(0,this.dispatchRemaining-count+1);}
    return ok;
  }
  async read(load,{fresh=false,kinds}={}){
    // Standalone consumers retain their short TTL. Production merges only the due resources.
    if(!this.batch&&!kinds){
      if(!fresh&&this.value&&this.now()-this.at<this.maxAgeMs){this.metrics.hits++;return structuredClone(this.value);}
      this.invalidate();this.metrics.reads++;const value=await load();
      if(value?.ok){this.at=this.now();this.value=structuredClone(value);for(const k of ['fuel','co2'])if(this.value[k])this.setDeadline(k);}
      return value;
    }
    const due=(kinds||['fuel','co2']).filter(k=>fresh||this.marketDue(k));
    if(!due.length){this.metrics.hits++;return structuredClone(this.value);}
    this.metrics.reads++;const observed=await load(due);this.at=this.now();this.value||={ok:false};
    for(const k of due){this.value[k]=structuredClone(observed?.[k]||{ok:false,kind:k,reason:observed?.reason||'MARKET_VALUES_UNAVAILABLE'});this.setDeadline(k);}
    const cash=due.map(k=>this.value[k]).find(m=>m.ok&&Number.isSafeInteger(m.cash))?.cash;
    if(cash!==undefined)for(const k of ['fuel','co2'])if(this.value[k])this.value[k].cash=cash;
    this.value.ok=['fuel','co2'].every(k=>this.value[k]?.ok);
    return structuredClone(this.value);
  }
  setDeadline(kind){const m=this.value[kind],seconds=m.nextRefreshSeconds;m.observedAt=this.now();m.priceValidUntil=this.now()+(m.ok&&Number.isInteger(seconds)&&seconds>0?seconds*1000:this.unreliableTimerRetryMs);if(m.ok&&m.holding>=m.capacityMax)this.decisions[kind]={key:this.purchaseKey(kind),price:m.pricePer1000,window:Math.round(m.priceValidUntil/60000)};}
}
