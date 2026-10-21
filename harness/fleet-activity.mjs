import {maintenanceChoice,departureEligibility} from './policy.mjs';
// Logging only. Unknown eligibility cannot prove that the fleet is caught up.
export function assessFleetActivity(snapshot,holds=()=>[]){
 const fleet=snapshot?.fleet;
 const complete=Array.isArray(fleet)&&fleet.length>0&&snapshot.schedule?.complete===true&&snapshot.maintenance?.ok===true&&new Set(fleet.map(a=>a.aircraftId)).size===fleet.length&&fleet.every(a=>/^\d+$/.test(a.aircraftId||'')&&a.registration);
 const assessment={complete,fleetAircraftCount:fleet?.length??0,readyDepartures:0,actionableAircraft:0,blockedOrExcluded:0,unknown:0,assessedAt:snapshot?.captured};
 if(!complete)return assessment;
 for(const a of fleet){
  if(['inflightList','pendingList'].includes(a.location))continue;
  if(!['landedList','parkedList'].includes(a.location)){assessment.unknown++;continue;}
  const held=holds(a.registration);
  if(maintenanceChoice(snapshot,a.registration,held)){assessment.actionableAircraft++;continue;}
  const reasons=departureEligibility(snapshot,a.registration,held,null).reasons;
  // These are established policy blocks, not missing observations or failed adapters.
  if(reasons.some(r=>['EXCLUDED_AIRCRAFT','DURABLE_ACTION_HOLD','EXISTING_SCHEDULE','DISPATCH_RESOURCE_GATE'].includes(r))){
   if(!reasons.some(r=>['EXCLUDED_AIRCRAFT','DURABLE_ACTION_HOLD','EXISTING_SCHEDULE'].includes(r))&&reasons.includes('DISPATCH_RESOURCE_GATE')&&(!snapshot.markets?.ok||![snapshot.markets.fuel?.holding,snapshot.markets.co2?.holding].every(Number.isSafeInteger))){assessment.unknown++;continue;}
   assessment.blockedOrExcluded++;continue;
  }
  assessment.unknown++; // Enabled Depart and actual duration need the existing selected-aircraft check.
 }
 return assessment;
}
export class FleetActivity {
 constructor(){this.waiting=false;}
 observe(assessment,{now=Date.now(),nextFleetCheckAt}={}){
  if(assessment.actionableAircraft>0){
   if(!this.waiting)return null;
   this.waiting=false;return {event:'FLEET_ACTIVITY_RESUMED',timestamp:new Date(now).toISOString(),actionableAircraft:assessment.actionableAircraft,countIsLowerBound:assessment.unknown>0};
  }
  if(!assessment.complete||assessment.unknown>0||this.waiting)return null;
  this.waiting=true;
  return {event:'FLEET_CAUGHT_UP_WAITING',timestamp:new Date(now).toISOString(),assessedAt:assessment.assessedAt,fleetAircraftCount:assessment.fleetAircraftCount,readyDepartures:0,actionableAircraft:0,blockedOrExcluded:assessment.blockedOrExcluded,...(nextFleetCheckAt?{nextFleetCheckAt,nextFleetCheckIsEstimate:true}:{} )};
 }
}
