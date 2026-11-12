// Session-only observations and receipt-accounted working inventory. Nothing is persisted.
export class ResourceCache {
  constructor({maxAgeMs=10000,unreliableTimerRetryMs=60000,now=Date.now}={}){this.unreliableTimerRetryMs=unreliableTimerRetryMs;this.maxAgeMs=maxAgeMs;this.now=now;this.batch=false;this.dispatchRemaining=null;this.usage={fuel:0,co2:0};this.decisions={};this.logKeys={};this.invalidate();this.metrics={reads:0,hits:0,invalidations:0,receiptDebits:0,uncertainDebits:0,headerMismatches:0};}
  invalidate(kind){if(kind&&this.value){delete this.value[kind];this.value.ok=false;}else{this.value=null;this.at=0;}if(this.metrics)this.metrics.invalidations++;}
  priceDue(kind){return kind?this.marketDue(kind):['fuel','co2'].some(k=>this.marketDue(k));}
  marketDue(kind){const m=this.value?.[kind];return !m||(!(m.ok&&m.holding>=m.capacityMax)&&this.now()>=(m.priceValidUntil??0));}
  beginDispatch(count){this.dispatchRemaining=count;}
  endDispatch(){this.dispatchRemaining=null;}
  resourceBudget(kind,required=0){
    const count=Math.min(10,this.dispatchRemaining??0);
    // Planning margin only: actual enabled controls, headers and route needs still govern each click.
    const margin=Math.min(Math.ceil(this.usage[kind]*1.25)*count,Math.floor((this.value?.[kind]?.capacityMax||0)/4));
    return 75000+Math.max(required,margin);
  }
  dispatchPurchaseDue(kind,required=0){
    if(this.marketDue(kind))return true;
    const m=this.value?.[kind];if(!m?.ok)return true;
    if(m.holding>=m.capacityMax)return false;
    if(m.pricePer1000>=(kind==='fuel'?1000:150))return this.decisions[kind]?.price!==m.pricePer1000;
    if(this.decisions[kind]?.price!==m.pricePer1000||this.decisions[kind]?.window!==Math.round(m.priceValidUntil/60000))return true;
    return m.holding<this.resourceBudget(kind,required);
  }
  purchaseKey(kind){const m=this.value?.[kind];return m?JSON.stringify([m.pricePer1000,m.holding,m.capacityMax,m.cash]):null;}
  purchaseDue(kind){
    if(this.dispatchRemaining!==null)return this.dispatchPurchaseDue(kind);
    if(this.marketDue(kind))return true;
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
  observeHeader(header){
    if(!this.value)return false;
    if(!this.value.fuel?.ok||!this.value.co2?.ok){this.invalidate();return false;}
    const co2=this.value.co2,percent=co2.holding/co2.capacityMax*100;
    if(!Number.isSafeInteger(header?.fuel)||header.fuel!==this.value.fuel.holding||!Number.isFinite(header.co2Percent)||Math.abs(header.co2Percent-percent)>0.00011){this.lastIssue=header?.fuel!==this.value.fuel.holding?'FUEL_HEADER_CHANGED':'CO2_HEADER_CHANGED';this.metrics.headerMismatches++;this.invalidate();return false;}
    if(Number.isSafeInteger(header.cash))for(const k of ['fuel','co2'])this.value[k].cash=header.cash;
    return true;
  }
  debitReady(before,after){
    const v=this.value,r=after?.receipt;return Boolean(v&&before&&after&&Number.isSafeInteger(before.epoch)&&before.epoch===after.epoch&&after.versions?.fuel>before.versions?.fuel&&after.versions?.co2>before.versions?.co2&&r?.routes===1&&[r.fuel,r.co2].every(n=>Number.isSafeInteger(n)&&n>=0)&&r.fuel<=v.fuel.holding&&r.co2<=v.co2.holding&&before.header?.fuel===v.fuel.holding&&after.header?.fuel===v.fuel.holding-r.fuel&&Number.isFinite(after.header?.co2Percent)&&Math.abs(after.header.co2Percent-(v.co2.holding-r.co2)/v.co2.capacityMax*100)<=0.00011);
  }
  debit(before,after){
    const v=this.value,r=after?.receipt;
    const valid=v&&before&&after&&Number.isSafeInteger(before.epoch)&&before.epoch===after.epoch&&after.versions?.fuel>before.versions?.fuel&&after.versions?.co2>before.versions?.co2&&r?.routes===1&&[r.fuel,r.co2].every(n=>Number.isSafeInteger(n)&&n>=0)&&r.fuel<=v.fuel.holding&&r.co2<=v.co2.holding&&before.header?.fuel===v.fuel.holding&&after.header?.fuel===v.fuel.holding-r.fuel;
    if(!valid){this.lastIssue=!v?'NO_WORKING_INVENTORY':!before||!after||before.epoch!==after.epoch?'RECEIPT_MONITOR_CHANGED':!(after.versions?.fuel>before.versions?.fuel&&after.versions?.co2>before.versions?.co2)?'RECEIPT_NOT_UPDATED':r?.routes!==1?'RECEIPT_NOT_SINGLE_FLIGHT':after.header?.fuel!==v.fuel.holding-r.fuel?'FUEL_RECEIPT_DELTA_MISMATCH':'RECEIPT_INVALID';this.metrics.uncertainDebits++;this.invalidate();return false;}
    v.fuel.holding-=r.fuel;v.co2.holding-=r.co2;
    for(const k of ['fuel','co2'])v[k].capacityUsed=v[k].capacityMax-v[k].holding;
    if(!this.observeHeader(after.header)){this.metrics.uncertainDebits++;return false;}
    for(const k of ['fuel','co2'])this.usage[k]=Math.max(this.usage[k],r[k]);
    if(this.dispatchRemaining!==null)this.dispatchRemaining=Math.max(0,this.dispatchRemaining-1);
    this.lastIssue=null;this.metrics.receiptDebits++;return true;
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
  setDeadline(kind){const m=this.value[kind],seconds=m.nextRefreshSeconds;m.priceValidUntil=this.now()+(m.ok&&Number.isInteger(seconds)&&seconds>0?seconds*1000:this.unreliableTimerRetryMs);if(m.ok&&m.holding>=m.capacityMax)this.decisions[kind]={key:this.purchaseKey(kind),price:m.pricePer1000,window:Math.round(m.priceValidUntil/60000)};}
}
