import {bulkExpression} from './bulk-dom.mjs';
import {maintenanceEligibility,departureEligibility,reconcileRecovery} from './policy.mjs';
import {identityRows,excludedAircraft} from './identity.mjs';
import {renderBlock} from './source.mjs';
import {settings} from './settings.mjs';
import {notifyForecast} from './forecast-monitor.mjs';
const read=(r,method,args)=>r.measure('bulkInspection',()=>method==='maintenancePreview'?r.measure('navigation',()=>r.evaluate(bulkExpression(method,args),'DOM.bulk.'+method)):r.evaluate(bulkExpression(method,args),'DOM.bulk.'+method));
const commit=(r,method,args)=>r.evaluate(bulkExpression(method,args),'DOM.commitBulk.'+method);
const fallback=(reason,evidence)=>({result:'SKIP',reason,evidence,fallback:true,verified:[],checkpoints:[],actionAttempted:{submitted:false}});
async function intentGroup(r,snapshot,targets,kind,cost=0){
  const actions=[];
  try{for(const [i,a] of targets.entries())actions.push(r.store.intent({registration:a.registration,aircraftId:a.aircraftId,kind,before:snapshot,quote:{cost:i===0?cost:0}}));}
  catch(error){for(const a of actions){a.state='NOT_SUBMITTED';r.store.saveAction(a);}throw error;}
  return actions;
}
function noSubmission(r,actions){for(const a of actions){a.state='NOT_SUBMITTED';r.store.saveAction(a);}}
function reportGroup(actions,reason,result,verified,submitted){return {result,reason,fallback:submitted===false,verified,checkpoints:actions.map(a=>a.id),checkpoint:actions[0]?.id,actionAttempted:{submitted}};}
export async function bulkMaintenance(r,snapshot,targets,kind){
  if(!targets.length)return fallback('BULK_GROUP_SIZE');
  if(targets.some(a=>!maintenanceEligibility(snapshot,a.registration,kind,r.holds(a.registration),{requireAction:false}).eligible||a.status!=='landed'))return fallback('BULK_MAINTENANCE_POLICY');
  const ids=targets.map(a=>a.aircraftId);let actions=[];
  try{
    await r.nav('plan');r.maintenanceView=null;
    const quote=await read(r,'maintenancePreview',{kind,ids,repairWearThreshold:settings.repairWearThreshold,rows:targets.map(a=>({...identityRows(snapshot,a.registration).row,aircraftId:a.aircraftId}))});
    if(!quote.ok)return fallback(quote.reason);
    if(quote.ids.length!==ids.length||!ids.every(id=>quote.ids.includes(id)))return fallback('BULK_TARGET_SET_DIFFERS');
    if(!r.options.live)return fallback('BULK_INSPECTION_ONLY');
    await r.confirm(kind,'Bulk '+kind,quote.cost);await r.guard.check();r.verifySource();
    actions=await intentGroup(r,snapshot,targets,kind,quote.cost);
    const sent=await commit(r,'maintenanceCommit',{...quote,rows:targets.map(a=>({...identityRows(snapshot,a.registration).row,aircraftId:a.aircraftId}))});
    if(!sent.clicked){noSubmission(r,actions);return {...reportGroup(actions,sent.reason,'SKIP',[],false),evidence:sent.evidence};}
    for(const a of actions){a.state='UNKNOWN';r.store.saveAction(a);}
    await r.pause(750);await r.nav('schedule');snapshot.schedule=await r.dom('schedule');
    const verified=[];for(const a of actions){const outcome=reconcileRecovery(a,snapshot);a.state=outcome.state;a.lastObservation=outcome;r.store.saveAction(a);if(a.state==='SCHEDULED_VERIFIED')verified.push(a.aircraftId);}
    return reportGroup(actions,verified.length===ids.length?'BULK_SCHEDULE_VERIFIED':'BULK_SCHEDULE_UNCERTAIN',verified.length===ids.length?'PASS':'INCONCLUSIVE',verified,true);
  }catch(error){
    if(!actions.length){if(/^(?:CDP_|OPERATOR_|CONTROLLER_|BROWSER_)/.test(error.message))throw error;return fallback('BULK_PREVIEW_UNAVAILABLE');}
    return reportGroup(actions,error.message,'INCONCLUSIVE',[],'POSSIBLE');
  }
}
export async function bulkDeparture(r,snapshot,targets){
  const routes=await r.dom('showRoutes',[{refresh:true}]);if(!routes.ok)return fallback(routes.reason);
  let capability=await read(r,'inspect');if(capability.departureControls!==1)return fallback('BULK_DEPARTURE_CONTROL_UNAVAILABLE');
  // Arrivals can change the native group while the initial maintenance/resource preparation runs.
  // Refresh only at this meaningful change, once; never chase a moving group indefinitely.
  const originalLanded=snapshot.fleet.filter(a=>a.location==='landedList'&&a.grounded==='0');
  if(capability.departureCount>originalLanded.length){
    snapshot.fleet=await r.fleet();await r.nav('plan');snapshot.maintenance=await r.dom('maintenance');r.maintenanceCache?.apply(snapshot);
    await r.dom('showRoutes',[{refresh:true}]);capability=await read(r,'inspect');
    if(capability.departureControls!==1)return fallback('BULK_DEPARTURE_CONTROL_UNAVAILABLE');
  }
  const routeIds=capability.departureRouteIds,landed=snapshot.fleet.filter(a=>a.location==='landedList'&&a.grounded==='0');
  if(!routeIds?.length||routeIds.length!==capability.departureCount)return fallback('BULK_DEPARTURE_SCOPE_NOT_BOUND');
  if(landed.length===routeIds.length)targets=landed;
  else if(targets.length<routeIds.length)return fallback('BULK_DEPARTURE_SCOPE_NOT_BOUND',{landed:landed.length,targets:targets.length,native:routeIds.length});
  targets=targets.filter(a=>!excludedAircraft(snapshot,a)&&!departureEligibility({...snapshot,markets:r.resources.value},a.registration,r.holds(a.registration),null).reasons.some(s=>s!=='FLIGHT_DURATION_UNKNOWN'));if(targets.length<routeIds.length)return fallback('BULK_DEPARTURE_POLICY');
  r.resources.observeBurn((await r.dom('receipt')).receipt);
  let flights=[];let actions=[];r.dispatchFlights||=new Map();
  try{
    for(const a of targets){
      if(r.productionPassDeadline)r.deadline=Math.min(r.productionPassDeadline,Date.now()+120000);
      let f=r.dispatchFlights.get(a.aircraftId);const cached=Boolean(f);
      if(!f){const selected=await r.evaluate(renderBlock(r.source.blocks.selectJs,a.registration,null,a.aircraftId),'source.selectJs');
        if(!selected.ok)return fallback('BULK_SELECTION_FAILED');await r.pause(650);f=await r.dom('flight');}
      if(cached&&!routeIds.includes(f.routeId))continue;
      // An unrelated aircraft with no usable flight must not veto a different explicit native cohort.
      if(!routeIds.includes(f.routeId)){r.dispatchFlights.set(a.aircraftId,{aircraftId:f.aircraftId,registrations:f.registrations,routeId:f.routeId,hours:f.hours,fuelRequired:f.fuelRequired,co2Required:f.co2Required});continue;}
      if(f.aircraftId!==a.aircraftId||f.registrations?.length!==1||f.registrations[0]!==a.registration||!departureEligibility({...snapshot,markets:r.resources.value},a.registration,r.holds(a.registration),f.hours).eligible||!cached&&!r.resources.observeHeader(f.header))return fallback('BULK_FLIGHT_POLICY',{aircraftId:a.aircraftId,routeId:f.routeId,hours:f.hours,inventoryIssue:r.resources.lastIssue});
      // Exact current fuel needs; optional CO2 burn margin is planning evidence, never an observed requirement.
      if(!Number.isSafeInteger(f.fuelRequired)||f.fuelRequired<0)return fallback('BULK_ROUTE_RESOURCE_REQUIREMENTS_UNKNOWN');
      const co2Budget=Number.isSafeInteger(f.co2Required)&&f.co2Required>=0?f.co2Required:r.resources.usage.co2>0?Math.ceil(r.resources.usage.co2*1.25):null;
      if(co2Budget===null)return fallback('BULK_ROUTE_RESOURCE_REQUIREMENTS_UNKNOWN');
      r.dispatchFlights.set(a.aircraftId,{aircraftId:f.aircraftId,registrations:f.registrations,routeId:f.routeId,hours:f.hours,fuelRequired:f.fuelRequired,co2Required:f.co2Required});
      if(routeIds.includes(f.routeId))flights.push({...f,co2Budget});
      if(flights.length===routeIds.length)break;
    }
    if(new Set(flights.map(f=>f.routeId)).size!==routeIds.length||!flights.every(f=>routeIds.includes(f.routeId)))return fallback('BULK_ROUTE_SCOPE_CHANGED');
    targets=targets.filter(a=>flights.some(f=>f.aircraftId===a.aircraftId));
    if(flights.reduce((sum,f)=>sum+f.fuelRequired,0)+75000>r.resources.value.fuel.holding||flights.reduce((sum,f)=>sum+f.co2Budget,0)+75000>r.resources.value.co2.holding)return fallback('BULK_RESOURCE_BUDGET_INSUFFICIENT');
    if(!r.options.live)return fallback('BULK_INSPECTION_ONLY');
    await r.confirm('departure','Bulk departure',null);await r.guard.check();r.verifySource();
    const before=await r.dom('receipt');if(!r.resources.observeHeader(before.header))return fallback('BULK_RESOURCE_OBSERVATION_CHANGED');await r.dom('showRoutes');actions=await intentGroup(r,snapshot,targets,'departure');
    const sent=await commit(r,'departureCommit',{ids:targets.map(a=>a.aircraftId),routeIds:flights.map(f=>f.routeId),excludedAircraftIds:[...r.excludedIds]});
    if(!sent.clicked){noSubmission(r,actions);return {...reportGroup(actions,sent.reason,'SKIP',[],false),evidence:sent.evidence};}
    for(const a of actions){a.state='UNKNOWN';r.store.saveAction(a);}
    let verified=[];
    for(let i=0;i<8;i++){
      await r.pause(750);const rows=await read(r,'departureState',{ids:targets.map(a=>a.aircraftId)});
      verified=rows.filter(a=>a.rows.length===1&&a.rows[0].location==='inflightList').map(a=>a.id);
      if(verified.length===targets.length)break;
    }
    for(const a of actions)if(verified.includes(a.aircraftId)){a.state='DEPARTED_VERIFIED';r.store.saveAction(a);const row=snapshot.fleet.find(f=>f.aircraftId===a.aircraftId);row.location='inflightList';row.status='inflight';}
    const after=await r.dom('receipt');
    const inventoryAccounted=verified.length>0&&r.resources.debitBulk(before,after,verified.length);
    if(!inventoryAccounted)r.resources.invalidate();
    else notifyForecast(r.forecast,'recordConsumption',after.receipt);
    return {...reportGroup(actions,verified.length===targets.length?'BULK_DEPARTURES_VERIFIED':'BULK_DEPARTURE_UNCERTAIN',verified.length===targets.length?'PASS':'INCONCLUSIVE',verified,true),targetCount:targets.length,gameResponse:{inventoryAccounted}};
  }catch(error){
    if(!actions.length){if(/^(?:CDP_|OPERATOR_|CONTROLLER_|BROWSER_)/.test(error.message))throw error;return fallback('BULK_DEPARTURE_PREPARATION_FAILED');}
    r.resources.invalidate();return reportGroup(actions,error.message,'INCONCLUSIVE',[],'POSSIBLE');
  }
}
