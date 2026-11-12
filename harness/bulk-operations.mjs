import {bulkExpression} from './bulk-dom.mjs';
import {maintenanceEligibility,departureEligibility,reconcileRecovery} from './policy.mjs';
import {identityRows,excludedAircraft} from './identity.mjs';
import {renderBlock} from './source.mjs';
import {settings} from './settings.mjs';
import {notifyForecast} from './forecast-monitor.mjs';
const read=(r,method,args)=>r.measure('bulkInspection',()=>method==='maintenancePreview'?r.measure('navigation',()=>r.evaluate(bulkExpression(method,args),'DOM.bulk.'+method)):r.evaluate(bulkExpression(method,args),'DOM.bulk.'+method));
const commit=(r,method,args)=>r.evaluate(bulkExpression(method,args),'DOM.commitBulk.'+method);
const fallback=reason=>({result:'SKIP',reason,fallback:true,verified:[],checkpoints:[],actionAttempted:{submitted:false}});
async function intentGroup(r,snapshot,targets,kind,cost=0){
  const actions=[];
  try{for(const [i,a] of targets.entries())actions.push(r.store.intent({registration:a.registration,aircraftId:a.aircraftId,kind,before:snapshot,quote:{cost:i===0?cost:0}}));}
  catch(error){for(const a of actions){a.state='NOT_SUBMITTED';r.store.saveAction(a);}throw error;}
  return actions;
}
function noSubmission(r,actions){for(const a of actions){a.state='NOT_SUBMITTED';r.store.saveAction(a);}}
function reportGroup(actions,reason,result,verified,submitted){return {result,reason,fallback:submitted===false,verified,checkpoints:actions.map(a=>a.id),checkpoint:actions[0]?.id,actionAttempted:{submitted}};}
export async function bulkMaintenance(r,snapshot,targets,kind){
  if(targets.length<2||targets.length>20)return fallback('BULK_GROUP_SIZE');
  if(targets.some(a=>!maintenanceEligibility(snapshot,a.registration,kind,r.holds(a.registration),{requireAction:false}).eligible||a.status!=='landed'))return fallback('BULK_MAINTENANCE_POLICY');
  const ids=targets.map(a=>a.aircraftId);let actions=[];
  try{
    await r.nav('plan');
    const quote=await read(r,'maintenancePreview',{kind,ids,repairWearThreshold:settings.repairWearThreshold,rows:targets.map(a=>({...identityRows(snapshot,a.registration).row,aircraftId:a.aircraftId}))});
    if(!quote.ok)return fallback(quote.reason);
    if(quote.ids.length!==ids.length||!ids.every(id=>quote.ids.includes(id)))return fallback('BULK_TARGET_SET_DIFFERS');
    if(!r.options.live)return fallback('BULK_INSPECTION_ONLY');
    await r.confirm(kind,'Bulk '+kind,quote.cost);await r.guard.check();r.verifySource();
    actions=await intentGroup(r,snapshot,targets,kind,quote.cost);
    const sent=await commit(r,'maintenanceCommit',{...quote,rows:targets.map(a=>({...identityRows(snapshot,a.registration).row,aircraftId:a.aircraftId}))});
    if(!sent.clicked){noSubmission(r,actions);return reportGroup(actions,sent.reason,'SKIP',[],false);}
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
  const landed=snapshot.fleet.filter(a=>a.location==='landedList'&&a.grounded==='0');
  // Native mode=all is not an explicit ID selection. Only use it for a fully bounded current set.
  if(targets.length<2||targets.length>20||landed.length!==targets.length||landed.some(a=>!targets.some(t=>t.aircraftId===a.aircraftId)))return fallback('BULK_DEPARTURE_SCOPE_NOT_BOUND');
  if(targets.some(a=>excludedAircraft(snapshot,a)||departureEligibility({...snapshot,markets:r.resources.value},a.registration,r.holds(a.registration),null).reasons.some(s=>s!=='FLIGHT_DURATION_UNKNOWN')))return fallback('BULK_DEPARTURE_POLICY');
  await r.dom('showFleet');const capability=await read(r,'inspect');if(capability.departureControls!==1)return fallback('BULK_DEPARTURE_CONTROL_UNAVAILABLE');
  const flights=[];let actions=[];
  try{
    for(const a of targets){
      const selected=await r.evaluate(renderBlock(r.source.blocks.selectJs,a.registration,null,a.aircraftId),'source.selectJs');
      if(!selected.ok)return fallback('BULK_SELECTION_FAILED');await r.pause(650);
      const f=await r.dom('flight');
      if(f.aircraftId!==a.aircraftId||f.registrations?.length!==1||f.registrations[0]!==a.registration||!departureEligibility({...snapshot,markets:r.resources.value},a.registration,r.holds(a.registration),f.hours).eligible||!r.resources.observeHeader(f.header))return fallback('BULK_FLIGHT_POLICY');
      // Exact current fuel needs; optional CO2 burn margin is planning evidence, never an observed requirement.
      if(!Number.isSafeInteger(f.fuelRequired)||f.fuelRequired<0)return fallback('BULK_ROUTE_RESOURCE_REQUIREMENTS_UNKNOWN');
      const co2Budget=Number.isSafeInteger(f.co2Required)&&f.co2Required>=0?f.co2Required:r.resources.usage.co2>0?Math.ceil(r.resources.usage.co2*1.25):null;
      if(co2Budget===null)return fallback('BULK_ROUTE_RESOURCE_REQUIREMENTS_UNKNOWN');
      flights.push({...f,co2Budget});
    }
    if(flights.reduce((sum,f)=>sum+f.fuelRequired,0)+75000>r.resources.value.fuel.holding||flights.reduce((sum,f)=>sum+f.co2Budget,0)+75000>r.resources.value.co2.holding)return fallback('BULK_RESOURCE_BUDGET_INSUFFICIENT');
    if(!r.options.live)return fallback('BULK_INSPECTION_ONLY');
    await r.confirm('departure','Bulk departure',null);await r.guard.check();r.verifySource();
    const before=await r.dom('receipt');await r.dom('showFleet');actions=await intentGroup(r,snapshot,targets,'departure');
    const sent=await commit(r,'departureCommit',{ids:targets.map(a=>a.aircraftId),excludedAircraftIds:[...r.excludedIds]});
    if(!sent.clicked){noSubmission(r,actions);return reportGroup(actions,sent.reason,'SKIP',[],false);}
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
    return {...reportGroup(actions,verified.length===targets.length?'BULK_DEPARTURES_VERIFIED':'BULK_DEPARTURE_UNCERTAIN',verified.length===targets.length?'PASS':'INCONCLUSIVE',verified,true),gameResponse:{inventoryAccounted}};
  }catch(error){
    if(!actions.length){if(/^(?:CDP_|OPERATOR_|CONTROLLER_|BROWSER_)/.test(error.message))throw error;return fallback('BULK_DEPARTURE_PREPARATION_FAILED');}
    r.resources.invalidate();return reportGroup(actions,error.message,'INCONCLUSIVE',[],'POSSIBLE');
  }
}
