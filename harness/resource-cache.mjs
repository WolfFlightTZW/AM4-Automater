// Observations only: no predicted balances and no persistence. Mutation/uncertainty invalidates them.
export class ResourceCache {
  constructor({maxAgeMs=10000,now=Date.now}={}){this.maxAgeMs=maxAgeMs;this.now=now;this.invalidate();this.metrics={reads:0,hits:0,invalidations:0};}
  invalidate(){this.value=null;this.at=0;if(this.metrics)this.metrics.invalidations++;}
  async read(load,{fresh=false}={}){
    if(!fresh&&this.value&&this.now()-this.at<this.maxAgeMs){this.metrics.hits++;return structuredClone(this.value);}
    this.invalidate();this.metrics.reads++;
    const value=await load();
    if(value?.ok){this.value=structuredClone(value);this.at=this.now();}
    return value;
  }
}
