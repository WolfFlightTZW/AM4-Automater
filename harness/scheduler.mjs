// Session-local deadlines only. Restart reconstructs them from fresh AM4 observations.
const kinds=['fuel','co2'],ceiling=k=>k==='fuel'?1000:150;
export const schedulerDefaults=Object.freeze({fallbackMs:60000,auditMs:300000,arrivalGraceMs:2000});
export function blockedResources(markets){return kinds.filter(k=>markets?.[k]?.ok&&Number.isSafeInteger(markets[k].holding)&&markets[k].holding<75000);}
export function arrivalDeadline(fleet,observedAt){
 const arrivals=[];let unknown=0;
 for(const a of fleet||[]){if(a.location!=='inflightList')continue;const m=String(a.status||'').trim().match(/^(\d{1,3}):(\d{2}):(\d{2})$/);if(!m||+m[2]>=60||+m[3]>60){unknown++;continue;}const seconds=+m[1]*3600 + +m[2]*60 + +m[3];arrivals.push({aircraftId:a.aircraftId,at:observedAt+seconds*1000});}
 arrivals.sort((a,b)=>a.at-b.at);return {earliest:arrivals[0]||null,unknown};
}
export function nextWork(c){
 const now=c.now,base=c.assessedAt,options={...schedulerDefaults,...c.options},events=[],blocked=blockedResources(c.markets),last=c.resourceChecks||{};
 const add=(kind,reason,at,extra={})=>events.push({kind,reason,at:Math.max(now+1000,at),...extra});
 if(c.inspectionUnavailable){add('operations','UI_INSPECTION_RETRY',base+options.fallbackMs);return events[0];}
 if(c.recovery){add('operations','TRANSACTION_RECOVERY',base+c.recoveryMs);return events[0];}
 if(c.deferredMaintenance)add('operations','MAINTENANCE_PENDING_WORK',base+c.activeDelayMs);
 for(const k of kinds){const m=c.markets?.[k];if(m?.ok&&m.holding>=m.capacityMax)continue;
  let at=m?.priceValidUntil;
  if(!Number.isFinite(at))at=(last[k]??base)+options.fallbackMs;
  // An unchanged/overdue/malformed timer is attempted once, then bounded by retry.
  if(last[k]!==undefined&&at<=last[k]+2000)at=last[k]+options.fallbackMs;
  if(blocked.includes(k)&&m?.ok&&m.pricePer1000<ceiling(k))at=last[k]===undefined?now+1000:Math.min(at,last[k]+options.fallbackMs);
  const planned=c.resourcePlans?.[k];
  if(!blocked.includes(k)&&m?.ok&&m.pricePer1000<ceiling(k)&&Number.isFinite(planned?.nextAt)&&planned.nextAt>now)at=Math.min(at,planned.nextAt);
  add('resource',blocked.includes(k)?'RESOURCE_BLOCKED_PRICE_WINDOW':'RESOURCE_PRICE_WINDOW',at,{resource:k,resourceDeadline:at});
 }
 if(c.markets?.ok&&!blocked.length){
  const held=new Set((c.held||[]).map(a=>a.registration));
  const ready=(c.fleet||[]).some(a=>['landedList','parkedList'].includes(a.location)&&a.grounded==='0'&&a.registration!=='N-145'&&!held.has(a.registration));
  if(ready||c.remainingWork)add('operations','ACTIONABLE_BACKLOG',base+c.activeDelayMs);
  const arrival=arrivalDeadline(c.fleet,base);
  if(arrival.earliest){const at=arrival.earliest.at+options.arrivalGraceMs;add('operations',at<=now?'OVERDUE_ARRIVAL':'AIRCRAFT_ARRIVAL',at<=now?now+options.fallbackMs:at,{arrivalDeadline:arrival.earliest.at});}
  if(arrival.unknown||c.fleetUnavailable)add('operations','UNRELIABLE_FLEET_TIMING',base+options.fallbackMs);
 }
 // Blocked arrivals never trigger departure passes. Safety checks are lightweight;
 // they can request a pass only for a meaningful current-state change or maintenance.
 add('audit','STATE_RECONCILIATION',c.auditAt??base+options.auditMs);
 events.sort((a,b)=>a.at-b.at);return {...events[0],blockedResources:blocked,resourceDeadlines:Object.fromEntries(events.filter(e=>e.kind==='resource').map(e=>[e.resource,e.at]))};
}
export async function waitForWork({context,active,wake,log=()=>{},onPlan=()=>{},now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
 const started=now();
 for(;;){active();const plan=nextWork({...context(),now:now()});onPlan(plan);log({event:'SCHEDULER_WAIT_STARTED',timestamp:new Date(now()).toISOString(),nextWakeAt:new Date(plan.at).toISOString(),...plan});
  while(now()<plan.at){active();await sleep(Math.min(100,plan.at-now()));}active();
  const timestamp=new Date(now()).toISOString();let outcome;
  try{outcome=await wake(plan);}catch(error){log({event:'SCHEDULER_WAKE',timestamp,trigger:plan.reason,kind:plan.kind,resource:plan.resource,result:'ERROR',reason:error.message});throw error;}
  log({event:'SCHEDULER_WAKE',timestamp,trigger:plan.reason,kind:plan.kind,resource:plan.resource,...outcome});
  if(outcome?.operations)return {idleMs:now()-started,idleReason:plan.reason,wakeReason:outcome.reason||plan.reason};
 }
}
