import {identityRows,excludedAircraft,scheduleMatches,validAircraftId} from './identity.mjs';
export function wholeQuantity({ kind, price, capacity, holding, cash }, lot = 1) {
  if (![price, capacity, holding, cash, lot].every(Number.isSafeInteger) || price <= 0 || capacity < holding || holding < 0 || lot < 1) throw new Error('INVALID_MARKET_VALUES');
  if (!['fuel', 'co2'].includes(kind)) throw new Error('INVALID_MARKET_KIND');
  if (price >= (kind === 'fuel' ? 1000 : 150) || cash <= 100000000) return 0;
  // Integer arithmetic: never round affordability above the cash reserve.
  const amount = [BigInt(capacity - holding), BigInt(cash - 100000000) * 1000n / BigInt(price)].reduce((a, b) => a < b ? a : b);
  return Number(amount / BigInt(lot) * BigInt(lot));
}
export function verifyPurchase(result) {
  if (!result?.clickAttempted) return { result: 'INCONCLUSIVE', reason: 'NOT_SUBMITTED' };
  if (![result.requested, result.estimatedCost, result.holdingIncrease, result.cashDecrease].every(Number.isSafeInteger)) return { result: 'INCONCLUSIVE', reason: 'MISSING_OR_FRACTIONAL_OBSERVATIONS' };
  const moneyMatches=result.cashPrecision==='WHOLE_DOLLAR_UI'
    ? Number.isFinite(result.exactCost)&&result.quotedCost===result.estimatedCost&&result.quotedCost===Math.round(result.exactCost)&&result.cashDecrease>=Math.floor(result.exactCost)&&result.cashDecrease<=Math.ceil(result.exactCost)
    : result.cashDecrease===result.estimatedCost;
  if (result.holdingIncrease !== result.requested || !moneyMatches)
    return { result: 'INCONCLUSIVE', reason: 'DELTAS_NOT_EXACT_CONCURRENT_ACTIVITY_OR_UNKNOWN_OUTCOME' };
  return { result: 'PASS', reason: result.cashPrecision==='WHOLE_DOLLAR_UI'?'EXACT_QUANTITY_AND_WHOLE_DOLLAR_CASH_INTERVAL':'EXACT_REQUEST_AND_COST_OBSERVED' };
}
export function maintenanceEligibility(snapshot, registration, kind, holds = [], {requireBase=true}={}) {
  const reasons = [];
  const {fleet,aircraft,rows,row,id}=identityRows(snapshot,registration);
  if(!validAircraftId(id))reasons.push('AIRCRAFT_ID_UNKNOWN');
  if (excludedAircraft(snapshot,aircraft)) reasons.push('EXCLUDED_AIRCRAFT');
  if (fleet.length !== 1 || !aircraft || !['landed','parked'].includes(aircraft.status) || !['landedList','parkedList'].includes(aircraft.location) || aircraft.grounded !== '0') reasons.push('NOT_UNIQUELY_LANDED_UNGROUNDED');
  if (rows.length !== 1 || !row || (requireBase && !row.atBase) || !row.id || ![row.wear, row.hoursToCheck].every(v => Number.isFinite(v) && v >= 0)) reasons.push('MAINTENANCE_IDENTITY_LOCATION_OR_VALUES_UNKNOWN');
  if (!snapshot.schedule?.complete) reasons.push('SCHEDULE_INCOMPLETE');
  if ((snapshot.schedule?.entries || []).some(e => scheduleMatches(e,aircraft?.registration||registration,id))) reasons.push('EXISTING_SCHEDULE');
  if (holds.length) reasons.push('DURABLE_ACTION_HOLD');
  if(requireBase&&!row?.availableActions?.includes(kind))reasons.push('ACTION_NOT_AVAILABLE');
  if (row && (kind === 'repair' ? !(row.wear > 9) : !(row.hoursToCheck <= 20))) reasons.push('NOT_DUE');
  return { eligible: reasons.length === 0, reasons, aircraft, row };
}
export function departureEligibility(snapshot, registration, holds = [], flightHours = null) {
  // Base location gates maintenance, not a normal return flight from another airport.
  const e = maintenanceEligibility(snapshot, registration, 'repair', holds, {requireBase:false});
  const reasons = e.reasons.filter(r => r !== 'NOT_DUE');
  if (!e.row || !Number.isFinite(e.row.wear) || e.row.wear > 9 || !Number.isFinite(e.aircraft?.wear) || e.aircraft.wear > 9) reasons.push('WEAR_UNSAFE_OR_UNKNOWN');
  if (!Number.isFinite(flightHours) || flightHours <= 0) reasons.push('FLIGHT_DURATION_UNKNOWN');
  else if (!Number.isFinite(e.row?.hoursToCheck) || e.row.hoursToCheck <= flightHours) reasons.push('INSUFFICIENT_CHECK_HOURS');
  if (!snapshot.markets?.ok || ![snapshot.markets.fuel?.holding, snapshot.markets.co2?.holding].every(v => Number.isSafeInteger(v) && v >= 75000)) reasons.push('DISPATCH_RESOURCE_GATE');
  return { eligible: reasons.length === 0, reasons, flightHours };
}
export function reconcile(action, snapshot) {
  const entries = (snapshot.schedule?.entries || []).filter(e => scheduleMatches(e,action.registration,action.aircraftId));
  const match = entries.filter(e => e.kind === action.kind && (!e.aircraftId || e.aircraftId === action.aircraftId));
  if (match.length === 1) return { state: 'SCHEDULED_VERIFIED', result: 'PASS', reason: 'EXACT_SCHEDULE_ENTRY', scheduleSeen: true };
  if (entries.length || !snapshot.schedule?.complete) return { state: action.state, result: 'INCONCLUSIVE', reason: 'SCHEDULE_AMBIGUOUS_OR_INCOMPLETE', scheduleSeen: action.scheduleSeen };
  const {fleet,rows}=identityRows(snapshot,action.registration,action.aircraftId);
  const after = rows[0], before = action.before?.maintenance?.records?.find(r => r.id === action.aircraftId);
  const landed = fleet.length === 1 && ['landedList','parkedList'].includes(fleet[0].location) && ['landed','parked'].includes(fleet[0].status) && fleet[0].grounded === '0';
  const condition = rows.length === 1 && before && after?.atBase && (action.kind === 'repair' ? after.wear <= 9 && after.wear < before.wear : after.hoursToCheck > before.hoursToCheck && after.hoursToCheck > 20);
  if (action.scheduleSeen && landed && condition) return { state: 'COMPLETED_VERIFIED', result: 'PASS', reason: 'SCHEDULE_CLEARED_AND_CONDITION_RESTORED', scheduleSeen: true };
  return { state: action.state, result: 'INCONCLUSIVE', reason: 'COMPLETION_NOT_PROVEN', scheduleSeen: action.scheduleSeen };
}
export function validateReportIdentity(report, id) {
  return report?.id === id && ['PASS', 'FAIL', 'INCONCLUSIVE'].includes(report.result) && Boolean(report.finished) && report.finished >= report.started;
}
// Recovery resolution is distinct from proving the historical action completed.
// An empty schedule alone is never evidence that an uncertain submission failed.
export function reconcileRecovery(action,snapshot) {
  // Reconcile an irreversible submission, not the maintenance lifecycle.
  const entries=(snapshot.schedule?.entries||[]).filter(e=>scheduleMatches(e,action.registration,action.aircraftId));
  const unresolved=reason=>({state:action.state,result:'INCONCLUSIVE',reason,scheduleSeen:Boolean(action.scheduleSeen)});
  if(!validAircraftId(action.aircraftId)||!snapshot.schedule?.complete)return unresolved('SCHEDULE_OR_IDENTITY_UNCERTAIN');
  const match=entries.filter(e=>e.kind===action.kind&&e.aircraftId===action.aircraftId);
  if(entries.length===1&&match.length===1)return {state:'SCHEDULED_VERIFIED',result:'PASS',reason:'SUBMISSION_ACKNOWLEDGED_BY_CURRENT_SCHEDULE',scheduleSeen:true};
  if(entries.length)return unresolved('SCHEDULE_AMBIGUOUS_OR_CONFLICTING');
  const {fleet,rows}=identityRows(snapshot,action.registration,action.aircraftId);
  const before=action.before?.maintenance?.records?.find(r=>r.id===action.aircraftId),row=rows[0];
  const improved=before&&rows.length===1&&(action.kind==='repair'?Number.isFinite(row.wear)&&row.wear<=9&&row.wear<before.wear:Number.isFinite(row.hoursToCheck)&&row.hoursToCheck>20&&row.hoursToCheck>before.hoursToCheck);
  if(snapshot.maintenance?.ok&&fleet.length===1&&improved)return {state:'RESOLVED_CURRENT_UI',result:'PASS',reason:'CURRENT_IDENTITY_AND_RESTORED_CONDITION_NO_CONFLICTING_SCHEDULE',scheduleSeen:Boolean(action.scheduleSeen),evidence:{aircraftId:action.aircraftId,wear:row.wear,hoursToCheck:row.hoursToCheck,scheduleComplete:true,observed:snapshot.captured||null}};
  return unresolved('CURRENT_UI_NOT_SUFFICIENT_TO_RESOLVE_SUBMISSION');
}
