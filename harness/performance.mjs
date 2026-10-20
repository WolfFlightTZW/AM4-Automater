export class PassPerformance {
  constructor(now=()=>performance.now()){this.now=now;this.timings={};this.counts={examined:0,eligible:0,skipped:0,dispatched:0,deferred:0,attempted:0};}
  record(name,durationMs){const item=this.timings[name]||={calls:0,durationMs:0};item.calls++;item.durationMs=Math.round((item.durationMs+Math.max(0,durationMs))*1000)/1000;}
  async measure(name,operation){const start=this.now();try{return await operation();}finally{this.record(name,this.now()-start);}}
  report(){return {timings:structuredClone(this.timings),counts:{...this.counts},note:'Inclusive action durations overlap component inspection timings; do not add the categories.'};}
}
export function requiresRecoveryBackoff(actions,{scheduleComplete=true,maintenanceComplete=true}={}){
  if(!actions.length)return false;
  if(!scheduleComplete||!maintenanceComplete)return true;
  // A bounded, known aircraft maintenance uncertainty still blocks that aircraft and reserves funds.
  return actions.some(a=>!['repair','check'].includes(a.kind)||!['PENDING','UNKNOWN'].includes(a.state)||typeof a.registration!=='string'||!a.registration||typeof a.aircraftId!=='string'||!/^[1-9][0-9]*$/.test(a.aircraftId)||!Number.isSafeInteger(a.quote?.cost)||a.quote.cost<0);
}
export const defaultMaxDepartures=16;
