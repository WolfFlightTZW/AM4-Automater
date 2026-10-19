import { writeFileSync,renameSync,existsSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
export async function highCycleReport(runner,{limit=300}={}) {
  const path=join(runner.options.productionRoot,'reports','fleet-detail-checkpoint.json');
  let saved=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{aircraft:[],errors:[]};
  saved.excluded ||= [];
  const fleet=[...new Map((await runner.fleet()).map(a=>[a.registration,a])).values()]; let inspected=0;
  saved.aircraft=[...new Map(saved.aircraft.map(a=>[a.registration,a])).values()];
  saved.excluded=[...new Map(saved.excluded.map(a=>[a.registration,a])).values()];
  const current=new Set(fleet.map(a=>a.registration)),age=a=>Date.parse(a?.captured||'')||0;
  const prior=reg=>saved.aircraft.find(a=>a.registration===reg)||saved.excluded.find(a=>a.registration===reg);
  const candidates=[...fleet].sort((a,b)=>age(prior(a.registration))-age(prior(b.registration)));
  for(const aircraft of candidates){
    if(inspected>=limit||(prior(aircraft.registration)&&Date.now()-age(prior(aircraft.registration))<3600000))continue;
    runner.deadline=Date.now()+30000;
    const value=await runner.evaluate(`(async()=>{
      const registration=${JSON.stringify(aircraft.registration)},pause=ms=>new Promise(r=>setTimeout(r,ms));
      const rows=[...document.querySelectorAll('.flight-list[data-reg]')].filter(e=>e.dataset.reg===registration);
      if(rows.length!==1)return JSON.stringify({ok:false,reason:'ROW_NOT_UNIQUE',registration});
      rows[0].click();await pause(350);
      if(/Pending delivery/i.test(document.querySelector('#flightInfo')?.innerText||''))return JSON.stringify({excluded:true,registration,reason:'PENDING_DELIVERY',captured:new Date().toISOString(),evidence:'Actual flight panel: Pending delivery; no flight hours/cycles detail available'});
      const details=[...document.querySelectorAll('button')].filter(e=>e.getClientRects().length&&e.textContent.trim()==='Details');
      if(details.length!==1)return JSON.stringify({ok:false,reason:'DETAILS_NOT_UNIQUE',registration});
      const old=document.querySelector('#detailsAction');details[0].click();
      let text='',matched=false;
      for(let i=0;i<30;i++){await pause(100);const p=document.querySelector('#popup');text=p?.innerText||'';const reg=p?.querySelector('#fleet-name')?.innerText?.trim();if(reg===registration&&/Flight hours\\/Cycles/.test(text)){matched=true;break;}}
      if(!matched)return JSON.stringify({ok:false,reason:'DETAIL_IDENTITY_NOT_READY',registration,excerpt:text.slice(0,350)});
      const clean=text.replace(/\\s+/g,' ').trim(),num=s=>s==null?null:Number(s.replace(/,/g,''));
      const hc=clean.match(/Flight hours\\/Cycles\\s+([\\d,]+)\\s*\\/\\s*([\\d,]+)/i);
      const maintenance=[...document.querySelectorAll('#popup button')].find(e=>e.textContent.trim()==='Maintenance');
      return JSON.stringify({ok:!!hc,registration,aircraftId:rows[0].id.match(/^flightStatus(\\d+)$/)?.[1]||maintenance?.getAttribute('onclick')?.match(/maintenance_main\\.php\\?action=(\\d+)/)?.[1]||null,
        model:clean.match(/Aircraft\\s+(.+?)\\s+Delivered/)?.[1]||'',hours:num(hc?.[1]),cycles:num(hc?.[2]),
        wear:num(clean.match(/Wear\\s+([\\d,.]+)%/)?.[1]),hoursUntilACheck:num(clean.match(/Hours to check\\s+([\\d,]+)/)?.[1]),
        route:clean.split('Aircraft')[0].replace(/^DETAILS\\s+FLEET\\s+ORDER\\s+RESEARCH\\s*/,'').slice(0,450),
        rangeKm:num(clean.match(/Range\\s+([\\d,]+)km/)?.[1]),minRunwayFt:num(clean.match(/Min runway\\s+([\\d,]+)ft/)?.[1]),captured:new Date().toISOString()});
    })()`,'High-cycle fleet detail '+aircraft.registration);
    inspected++;
    saved.errors=saved.errors.filter(e=>e.registration!==aircraft.registration);
    if(value.excluded||value.ok){
      saved.aircraft=saved.aircraft.filter(a=>a.registration!==aircraft.registration);
      saved.excluded=saved.excluded.filter(a=>a.registration!==aircraft.registration);
    }
    if(value.excluded)saved.excluded.push(value);
    else if(value.ok)saved.aircraft.push({...value,status:aircraft.status,location:aircraft.location,grounded:aircraft.grounded});
    else saved.errors.push(value);
    saved.updated=new Date().toISOString();saved.fleetCount=fleet.length;
    writeFileSync(path+'.tmp',JSON.stringify(saved,null,2));renameSync(path+'.tmp',path);
    if(inspected%20===0)console.log(JSON.stringify({fleetReportProgress:saved.aircraft.length,total:fleet.length}));
  }
  const rows=saved.aircraft.filter(a=>current.has(a.registration)&&a.cycles>500).sort((a,b)=>b.cycles-a.cycles);
  const fields=['registration','aircraftId','model','hours','cycles','wear','hoursUntilACheck','status','location','grounded','route','rangeKm','minRunwayFt','captured'];
  const csv=[fields.join(','),...rows.map(row=>fields.map(k=>'"'+String(row[k]??'').replaceAll('"','""')+'"').join(','))].join('\r\n')+'\r\n';
  const csvPath=join(runner.options.productionRoot,'reports','high-hour-aircraft.csv');
  const available=saved.aircraft.filter(a=>current.has(a.registration)),excluded=saved.excluded.filter(a=>current.has(a.registration));
  const covered=new Set([...available,...excluded].map(a=>a.registration));
  const incomplete=fleet.filter(a=>!covered.has(a.registration)).map(a=>({registration:a.registration,reason:saved.errors.find(e=>e.registration===a.registration)?.reason||'NOT_YET_INSPECTED'}));
  const stale=available.filter(a=>Date.now()-age(a)>=3600000).map(a=>a.registration);
  const complete=incomplete.length===0,csvUpdated=complete||available.length>0;
  const result={inspected:available.length,retainedRecords:saved.aircraft.length,excluded,fleetCount:fleet.length,highCycleAircraft:rows.length,errors:saved.errors.filter(e=>current.has(e.registration)).length,complete,csvUpdated,incomplete,stale,detailErrors:saved.errors.filter(e=>current.has(e.registration)),inactiveRecords:saved.aircraft.filter(a=>!current.has(a.registration)).map(a=>a.registration),path:csvPath};
  // Publish useful current-member data; sidecar explicitly records missing and stale details.
  if(csvUpdated){writeFileSync(csvPath+'.tmp',csv);renameSync(csvPath+'.tmp',csvPath);}
  saved.updated=new Date().toISOString();saved.fleetCount=fleet.length;
  writeFileSync(path+'.tmp',JSON.stringify(saved,null,2));renameSync(path+'.tmp',path);
  const statusPath=join(runner.options.productionRoot,'reports','high-hour-aircraft-status.json');
  writeFileSync(statusPath+'.tmp',JSON.stringify({updated:saved.updated,...result},null,2));renameSync(statusPath+'.tmp',statusPath);
  return result;
}
