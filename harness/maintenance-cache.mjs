// Session-only negative observations. Never stores submission lifecycle or grants eligibility.
import {identityRows} from './identity.mjs';import {applyMaintenanceUnavailable} from './policy.mjs';
export class MaintenanceCache{
 constructor({now=Date.now,retryMs=300000}={}){this.now=now;this.retryMs=retryMs;this.entries=new Map();this.suppressed=0;}
 key(snapshot,a,kind){const {row}=identityRows(snapshot,a.registration,a.aircraftId);return JSON.stringify([a.aircraftId,kind,a.status,a.location,a.grounded,row?.wear,row?.hoursToCheck,row?.atBase,row?.availableActions,[...(snapshot.schedule?.entries||[])].filter(e=>e.aircraftId===a.aircraftId)]);}
 remember(snapshot,a,kind,report){if(report.checkpoint||report.actionAttempted?.submitted!==false||!['MAINTENANCE_UNAVAILABLE','PLANNER_NOT_ELIGIBLE'].includes(report.reason))return;
 const definitive=report.reason==='MAINTENANCE_UNAVAILABLE';const evidence={reason:report.reason,actionAttempted:{submitted:false},gameResponse:{quote:structuredClone(report.gameResponse?.quote)}};this.entries.set(a.aircraftId+':'+kind,{key:this.key(snapshot,a,kind),report:evidence,until:definitive?Infinity:this.now()+this.retryMs,definitive});}
 apply(snapshot){const held=new Set();for(const a of snapshot.fleet||[])for(const kind of ['check','repair']){const id=a.aircraftId+':'+kind,e=this.entries.get(id);if(!e)continue;if(e.key!==this.key(snapshot,a,kind)||this.now()>=e.until){this.entries.delete(id);continue;}
 if(e.definitive){if(!applyMaintenanceUnavailable(snapshot,a.registration,kind,e.report)){this.entries.delete(id);continue;}}else held.add(a.aircraftId);this.suppressed++;}return held;}
}
