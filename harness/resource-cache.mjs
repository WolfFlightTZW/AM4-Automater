// Session-only observations and receipt-accounted working inventory. Nothing is persisted.
export class ResourceCache {
  constructor({maxAgeMs=10000,now=Date.now}={}){this.maxAgeMs=maxAgeMs;this.now=now;this.batch=false;this.invalidate();this.metrics={reads:0,hits:0,invalidations:0,receiptDebits:0,uncertainDebits:0,headerMismatches:0};}
  invalidate(){this.value=null;this.at=0;if(this.metrics)this.metrics.invalidations++;}
  priceDue(){return !this.value||['fuel','co2'].some(k=>this.now()>=(this.value[k]?.priceValidUntil??this.at+this.maxAgeMs));}
  low(){return !this.value||['fuel','co2'].some(k=>!Number.isSafeInteger(this.value[k]?.holding)||this.value[k].holding<250000);}
  observeHeader(header){
    if(!this.value)return false;
    const co2=this.value.co2,percent=co2.holding/co2.capacityMax*100;
    if(!Number.isSafeInteger(header?.fuel)||header.fuel!==this.value.fuel.holding||!Number.isFinite(header.co2Percent)||Math.abs(header.co2Percent-percent)>0.00011){this.lastIssue=header?.fuel!==this.value.fuel.holding?'FUEL_HEADER_CHANGED':'CO2_HEADER_CHANGED';this.metrics.headerMismatches++;this.invalidate();return false;}
    if(Number.isSafeInteger(header.cash))for(const k of ['fuel','co2'])this.value[k].cash=header.cash;
    return true;
  }
  debit(before,after){
    const v=this.value,r=after?.receipt;
    const valid=v&&before&&after&&Number.isSafeInteger(before.epoch)&&before.epoch===after.epoch&&after.versions?.fuel>before.versions?.fuel&&after.versions?.co2>before.versions?.co2&&r?.routes===1&&[r.fuel,r.co2].every(n=>Number.isSafeInteger(n)&&n>=0)&&r.fuel<=v.fuel.holding&&r.co2<=v.co2.holding&&before.header?.fuel===v.fuel.holding&&after.header?.fuel===v.fuel.holding-r.fuel;
    if(!valid){this.lastIssue=!v?'NO_WORKING_INVENTORY':!before||!after||before.epoch!==after.epoch?'RECEIPT_MONITOR_CHANGED':!(after.versions?.fuel>before.versions?.fuel&&after.versions?.co2>before.versions?.co2)?'RECEIPT_NOT_UPDATED':r?.routes!==1?'RECEIPT_NOT_SINGLE_FLIGHT':after.header?.fuel!==v.fuel.holding-r.fuel?'FUEL_RECEIPT_DELTA_MISMATCH':'RECEIPT_INVALID';this.metrics.uncertainDebits++;this.invalidate();return false;}
    v.fuel.holding-=r.fuel;v.co2.holding-=r.co2;
    for(const k of ['fuel','co2'])v[k].capacityUsed=v[k].capacityMax-v[k].holding;
    if(!this.observeHeader(after.header)){this.metrics.uncertainDebits++;return false;}
    this.lastIssue=null;this.metrics.receiptDebits++;return true;
  }
  async read(load,{fresh=false}={}){
    if(!fresh&&this.value&&(this.batch?!this.priceDue():this.now()-this.at<this.maxAgeMs)){this.metrics.hits++;return structuredClone(this.value);}
    this.invalidate();this.metrics.reads++;const value=await load();
    if(value?.ok){this.at=this.now();this.value=structuredClone(value);for(const k of ['fuel','co2'])if(Number.isInteger(value[k]?.nextRefreshSeconds)&&value[k].nextRefreshSeconds>=0)this.value[k].priceValidUntil=this.at+Math.max(0,value[k].nextRefreshSeconds*1000-2000);}
    return value;
  }
}
