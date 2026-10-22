// Explicit, bounded local report. No operational fleet database or transaction writes.
import {writeFileSync,renameSync,existsSync} from 'node:fs';
import {join} from 'node:path';

export function alaskaStamp(date=new Date()) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Anchorage',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date).map(p=>[p.type,p.value]));
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
}
export function validateFleet(fleet){
  if(!Array.isArray(fleet)||!fleet.length)throw Error('EMPTY_FLEET');
  const ids=new Set(),names=new Set();
  for(const a of fleet){if(!/^\d+$/.test(a.aircraftId||'')||!a.registration)throw Error('FLEET_IDENTITY_MISSING');if(ids.has(a.aircraftId)||names.has(a.registration))throw Error('DUPLICATE_FLEET_IDENTITY');ids.add(a.aircraftId);names.add(a.registration);}
  return fleet;
}
export function displayedFields(raw){
  const fields={};const add=(key,value)=>{key=String(key).trim();value=String(value??'').trim();if(!key||!value)return;const values=fields[key]||=[];if(!values.includes(value))values.push(value);};
  for(const pair of raw.pairs||[])add(pair.label,pair.value);
  const lines=raw.text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const labels=['Aircraft','Manufacturer','Delivered','Purchase date','Acquisition date','Age','Aircraft age','Ownership duration','Hours to check','Flight hours/Cycles','Flight hours','Flight cycles','Min runway','Wear','Type','Range','Speed','Cruise speed','Purchase price','Current valuation','Resale value','Configuration','Capacity','Engine','Engines','Fuel consumption','Fuel usage','CO2','Co2 emission','Condition','Status','Location','Base','SEAT LAYOUT','TODAYS DEMAND','FLIGHT HISTORY'];
  for(let i=0;i<lines.length;i++)if(labels.includes(lines[i])){
    const stop=lines.findIndex((l,j)=>j>i&&(labels.includes(l)||['Maintenance','Reroute','Sell','Ground','Depart','Ground Depart'].includes(l)));
    const section=['SEAT LAYOUT','TODAYS DEMAND','FLIGHT HISTORY'].includes(lines[i]);
    const values=lines.slice(i+1,section?(stop<0?lines.length:stop):Math.min(i+2,stop<0?lines.length:stop));
    // Never infer a missing value from the next label.
    if(values.length)add(lines[i],values.join('\n'));
  }
  return fields;
}
const expected=['Aircraft','Manufacturer','Delivered','Purchase date','Acquisition date','Age','Ownership duration','Flight hours/Cycles','Wear','Hours to check','Condition','Purchase price','Current valuation','Resale value','Configuration','Capacity','Engine','Fuel consumption','Co2 emission','Range','Speed'];
export function snapshotTable(fleet,records,timestamp){
  validateFleet(fleet);if(records.length!==fleet.length)throw Error('SNAPSHOT_COUNT_MISMATCH');
  const ids=new Set(),names=new Set(),byId=new Map(fleet.map(a=>[a.aircraftId,a]));
  const rows=records.map(r=>{
    const a=byId.get(r.aircraftId);if(!r.ok||!a||a.registration!==r.registration||ids.has(r.aircraftId)||names.has(r.registration)||!r.raw?.text?.trim())throw Error('DETAILS_INCOMPLETE_OR_DUPLICATE');
    ids.add(r.aircraftId);names.add(r.registration);const fields=displayedFields(r.raw);
    return {snapshotTimestamp:timestamp,detailsCaptured:r.captured,registration:r.registration,aircraftId:r.aircraftId,status:r.fleet.status,location:r.fleet.location,grounded:r.fleet.grounded,flightPanel:r.flightPanel||'',...Object.fromEntries(Object.entries(fields).map(([k,v])=>['detail.'+k,v.join('\n')])),rawDetailsText:r.raw.text,displayedControls:JSON.stringify(r.raw.controls||[])};
  });
  const base=['snapshotTimestamp','detailsCaptured','registration','aircraftId','status','location','grounded','flightPanel'];
  const fields=[...new Set([...expected.map(k=>'detail.'+k),...rows.flatMap(r=>Object.keys(r).filter(k=>k.startsWith('detail.')))])].sort();
  const columns=[...base,...fields,'rawDetailsText','displayedControls'];
  return {rows,columns,unavailableFields:expected.filter(k=>rows.every(r=>!r['detail.'+k])),fieldCoverage:Object.fromEntries(fields.map(k=>[k,rows.filter(r=>Boolean(r[k])).length]))};
}
export function csvEncode(columns,rows){const cell=v=>'"'+String(v??'').replaceAll('"','""')+'"';return '\uFEFF'+[columns.map(cell).join(','),...rows.map(r=>columns.map(k=>cell(r[k])).join(','))].join('\r\n')+'\r\n';}
export function csvDecode(csv){
  csv=csv.replace(/^\uFEFF/,'');const rows=[];let row=[],value='',quoted=false;
  for(let i=0;i<csv.length;i++){const c=csv[i];if(c==='"'){if(quoted&&csv[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(value);value='';}else if((c==='\r'||c==='\n')&&!quoted){if(c==='\r'&&csv[i+1]==='\n')i++;row.push(value);rows.push(row);row=[];value='';}else value+=c;}
  if(quoted)throw Error('INVALID_CSV_QUOTING');if(row.length||value){row.push(value);rows.push(row);}return rows;
}
export function publishSnapshot(directory,stem,report){
  const table=snapshotTable(report.fleet,report.records,report.started);
  if(report.errors?.length||report.membershipChanged)throw Error('SNAPSHOT_INCOMPLETE');
  const csv=csvEncode(table.columns,table.rows),decoded=csvDecode(csv);
  if(decoded.length!==table.rows.length+1||decoded.some(r=>r.length!==table.columns.length)||decoded.slice(1).some((row,i)=>row.some((v,j)=>v!==String(table.rows[i][table.columns[j]]??''))))throw Error('CSV_INTEGRITY_FAILURE');
  const destination=join(directory,stem+'.csv'),rawPath=join(directory,stem+'.raw.json');
  if(existsSync(destination)||existsSync(rawPath))throw Error('SNAPSHOT_ALREADY_EXISTS');
  writeFileSync(rawPath+'.tmp',JSON.stringify({...report,complete:true,columns:table.columns,fieldCoverage:table.fieldCoverage,unavailableFields:table.unavailableFields},null,2),{flag:'wx'});renameSync(rawPath+'.tmp',rawPath);
  writeFileSync(destination+'.tmp',csv,{flag:'wx'});renameSync(destination+'.tmp',destination);
  return {path:destination,rawPath,count:table.rows.length,columns:table.columns,unavailableFields:table.unavailableFields,fieldCoverage:table.fieldCoverage};
}

// Serialized into the existing Steam document. Only aircraft selection and Details are clicked.
export async function inspectDetails(doc,aircraft){
  const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
  const visible=e=>Boolean(e&&e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const rows=[...doc.querySelectorAll('.flight-list[data-reg]')].filter(e=>e.id==='flightStatus'+aircraft.aircraftId&&e.dataset.reg===aircraft.registration);
  if(rows.length!==1)return {ok:false,reason:'FLEET_IDENTITY_NOT_UNIQUE',...aircraft};
  rows[0].click();
  let details;
  const panelDeadline=Date.now()+3500;
  while(Date.now()<panelDeadline){
    await sleep(100);
    const buttons=[...doc.querySelectorAll('#flightInfo button,#flightInfo a')].filter(e=>visible(e)&&clean(e.textContent)==='Details'&&!e.disabled&&e.getAttribute('aria-disabled')!=='true');
    if(buttons.length===1&&buttons[0].getAttribute('onclick')?.match(/routes_main\.php\?mode=details&id=(\d+)/)?.[1]===aircraft.aircraftId){details=buttons[0];break;}
  }
  if(!details)return {ok:false,reason:'DETAILS_CONTROL_UNAVAILABLE',...aircraft};
  const flightPanel=doc.querySelector('#flightInfo')?.innerText||'';
  details.click();let pop;
  const detailDeadline=Date.now()+5500;
  while(Date.now()<detailDeadline){
    await sleep(100);pop=doc.querySelector('#popup');
    if(visible(pop)&&clean(pop.querySelector('#fleet-name')?.textContent)===aircraft.registration){
      // Inflight Details omit Maintenance. The existing Rename control still binds the aircraft ID.
      const ids=[...pop.querySelectorAll('button,a')].map(e=>{const handler=e.getAttribute('onclick')||'';return handler.match(/maintenance_main\.php\?action=(\d+)/)?.[1]||handler.match(/fleet_details\.php\?id=(\d+)&mode=reg(?:&|'|")/)?.[1];}).filter(Boolean);
      if(ids.length&&ids.every(id=>id===aircraft.aircraftId)){await sleep(200);break;}
    }
    pop=null;
  }
  if(!pop)return {ok:false,reason:'DETAILS_IDENTITY_UNVERIFIED',...aircraft};
  const pairs=[];
  for(const e of pop.querySelectorAll('tr')){const cells=[...e.children].filter(visible);if(cells.length>=2)pairs.push({label:clean(cells[0].innerText),value:cells.slice(1).map(c=>c.innerText).join('\n')});}
  for(const e of pop.querySelectorAll('dt'))if(visible(e)&&e.nextElementSibling?.tagName==='DD')pairs.push({label:clean(e.innerText),value:e.nextElementSibling.innerText});
  for(const e of pop.querySelectorAll('div,li')){
    if(!visible(e))continue;const children=[...e.children].filter(visible);
    if(children.length===2&&children[0].children.length===0&&children[1].children.length===0){const label=clean(children[0].innerText),value=children[1].innerText||'';if(label&&label.length<=80&&value.trim())pairs.push({label,value});}
  }
  const leaves=[...pop.querySelectorAll('*')].filter(e=>visible(e)&&!['SCRIPT','STYLE','INPUT','BUTTON'].includes(e.tagName)&&![...e.children].some(visible)).map(e=>({tag:e.tagName,id:e.id||'',text:e.innerText||'',title:e.getAttribute('title')||'',alt:e.getAttribute('alt')||''})).filter(e=>e.text.trim()||e.title||e.alt);
  const controls=[...pop.querySelectorAll('button,a,input[type="submit"]')].filter(visible).map(e=>({text:clean(e.innerText||e.value),enabled:!e.disabled&&e.getAttribute('aria-disabled')!=='true'}));
  const text=pop.innerText||'';
  return {ok:Boolean(text.trim()),registration:aircraft.registration,aircraftId:aircraft.aircraftId,captured:new Date().toISOString(),fleet:aircraft,flightPanel,raw:{text,pairs,leaves,controls}};
}
export const detailsExpression=aircraft=>`(async()=>JSON.stringify(await (${inspectDetails.toString()})(document,${JSON.stringify(aircraft)})))()`;
