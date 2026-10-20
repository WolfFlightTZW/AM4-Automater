// Identity comes only from the current AM4 DOM or a durable transaction intent.
export const validAircraftId=id=>typeof id==='string'&&/^[1-9][0-9]*$/.test(id);
export const validRegistration=name=>typeof name==='string'&&/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,79}$/u.test(name);
export function identityRows(snapshot,registration,aircraftId=null){
  const all=snapshot.fleet||[],fleet=all.filter(r=>aircraftId?r.aircraftId===aircraftId:r.registration===registration);
  let aircraft=fleet.length===1?fleet[0]:null;
  const id=aircraft?.aircraftId;if(validAircraftId(id)&&all.filter(r=>r.aircraftId===id).length!==1)aircraft=null;
  const rows=aircraft&&validAircraftId(id)?(snapshot.maintenance?.records||[]).filter(r=>r.id===id):[];
  return {fleet,aircraft,rows,row:rows.length===1?rows[0]:null,id};
}
export function excludedAircraft(snapshot,aircraft){
  if(!aircraft)return false;
  const ids=new Set([...(snapshot.excludedAircraftIds||[]),...(snapshot.fleet||[]).filter(a=>a.registration==='N-145'&&validAircraftId(a.aircraftId)).map(a=>a.aircraftId),...(snapshot.maintenance?.records||[]).filter(a=>a.registration==='N-145'&&validAircraftId(a.id)).map(a=>a.id)]);
  return aircraft.registration==='N-145'||ids.has(aircraft.aircraftId);
}
export function scheduleMatches(entry,registration,id){return validAircraftId(entry.aircraftId)?entry.aircraftId===id:entry.registration===registration;}
