// Independent public-HTTP console. No controller, Runner, operator state or CDP imports.
import {createInterface,cursorTo,clearScreenDown} from 'node:readline';
import {mkdir,writeFile,readdir,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {ForecastMonitor} from './forecast-monitor.mjs';
import {accuracySummary,observeActual,slotStart,SLOT_MS} from './forecast.mjs';

export function consoleOptions(args){
  const options={fuelQuantity:1000000,co2Quantity:1000000};
  for(let i=0;i<args.length;i++){
    if(args[i]==='--watch')continue;
    const key={'--fuel-quantity':'fuelQuantity','--co2-quantity':'co2Quantity'}[args[i]];
    if(!key||!/^\d+$/.test(args[i+1]||'')||!Number.isSafeInteger(Number(args[i+1])))throw Error('Use --watch [--fuel-quantity N] [--co2-quantity N]');
    options[key]=Number(args[++i]);
  }return options;
}
export function manualActual(monitor,kind,price,at=monitor.now()){
  if(!['fuel','co2'].includes(kind)||!Number.isSafeInteger(price)||price<=0)throw Error('Use actual fuel PRICE or actual co2 PRICE (positive whole dollars per 1,000).');
  const observations=monitor.state.manualActuals||=[];
  const previous=observations.findLast(o=>o.kind===kind&&slotStart(Date.parse(o.at))===slotStart(at));
  if(previous?.price===price)return 'Already recorded for this market window.';
  observations.push({kind,price,at:new Date(at).toISOString(),source:'MANUAL_OPERATOR_ENTRY'});
  monitor.state.manualActuals=observations.filter(o=>Date.parse(o.at)>at-7*86400000).slice(-800);
  observeActual(monitor.state,kind,{ok:true,pricePer1000:price},at);
  const comparison=monitor.state.records.find(r=>r.kind===kind&&Date.parse(r.start)===slotStart(at));
  return `Recorded actual ${kind} $${price}/1,000. ${comparison?.actual!==undefined?'Compared with saved pre-transition prediction.':'No eligible pre-transition prediction/comparison yet (transition edges are excluded).'}`;
}
const money=n=>n==null?'unavailable':'$'+n.toLocaleString('en-US',{maximumFractionDigits:2});
const duration=ms=>{if(!Number.isFinite(ms))return 'unknown';if(ms<=0)return 'now/due';const s=Math.ceil(ms/1000);return `${Math.floor(s/3600)}h ${Math.floor(s%3600/60)}m ${s%60}s`;};
function stamp(ms){return new Intl.DateTimeFormat('en-US',{timeZone:'America/Anchorage',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(ms));}
export function renderDashboard(monitor,options,message=''){
  const now=monitor.now(),forecast=monitor.state.forecast,plan=monitor.plan(),age=forecast?now-Date.parse(forecast.retrievedAt):null;
  const lines=['AM4Info Forecast Monitor | READ-ONLY / NO GAME CONNECTION',stamp(now),`Retrieval: ${monitor.status}${monitor.pending?' (fetching)':''} | age: ${age===null?'unavailable':duration(age)} | next retrieval: ${duration(monitor.nextFetch-now)}`,`Data: ${age===null?'UNAVAILABLE':age<0||age>SLOT_MS*2?'STALE':'recent retrieval; publisher issue time unavailable'}`,'Prices per 1,000 lbs / CO2 quotas. Forecasts are NOT observed game prices.',''];
  for(const kind of ['fuel','co2']){
    const windows=(forecast?.windows||[]).filter(w=>Date.parse(w.end)>now&&Date.parse(w.start)<=now+24*3600000&&Number.isSafeInteger(w[kind]));
    const lowest=windows.reduce((best,w)=>!best||w[kind]<best[kind]?w:best,null),next=plan.resources[kind].nextFavorable;
    const actual=monitor.state.manualActuals?.findLast(o=>o.kind===kind&&slotStart(Date.parse(o.at))===slotStart(now));
    const current=plan.resources[kind].currentForecastPrice,baseline=actual?.price??current,quantity=options[kind+'Quantity'];
    const savings=lowest&&baseline!=null?(baseline-lowest[kind])*quantity/1000:null,a=accuracySummary(monitor.state.records,kind);
    lines.push(`${kind==='fuel'?'FUEL':'CO2'} forecast now: ${money(current)} | manual actual this window: ${money(actual?.price)}`,
      `  Next below existing ceiling: ${next?`${money(next.price)} at ${stamp(Date.parse(next.at))} (in ${duration(Date.parse(next.at)-now)})`:'none available'}`,
      `  Lowest next 24h (includes current): ${lowest?`${money(lowest[kind])} at ${stamp(Date.parse(lowest.start))} (in ${duration(Date.parse(lowest.start)-now)})`:'unavailable'}`,
      `  Quantity ${quantity.toLocaleString('en-US')} units: estimated savings ${money(savings)} versus ${actual?'manually observed actual':'current forecast'} price; excludes delay costs/cash/storage.`,
      `  Accuracy: ${a.exact} exact / ${a.error} errors / ${a.missed} missed / ${a.missing} missing / ${a.revised} revised | ${a.level}`,'');
  }
  lines.push('Commands: refresh | actual fuel PRICE | actual co2 PRICE | qty fuel UNITS | qty co2 UNITS | help | quit', 'Ctrl+C stops only this monitor. Game/controller state is never changed.',message);
  return lines.join('\n');
}
export async function archiveSnapshot(monitor,directory){
  const f=monitor.state.forecast;if(!f)return;
  const folder=join(directory,'snapshots');await mkdir(folder,{recursive:true});
  // One full public snapshot per market window, keeping disk use bounded over multiple days.
  const file=join(folder,new Date(slotStart(Date.parse(f.retrievedAt))).toISOString().replace(/[:.]/g,'-')+'.json');
  await writeFile(file,JSON.stringify(f,null,2),{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});
  for(const name of await readdir(folder)){if(!/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.json$/.test(name))continue;const time=Date.parse(name.slice(0,13)+':'+name.slice(14,16)+':'+name.slice(17,19)+'.'+name.slice(20,24));if(time<monitor.now()-7*86400000)await unlink(join(folder,name));}
}
export async function runForecastConsole({directory,args=[],input=process.stdin,output=process.stdout,now=Date.now,fetcher=fetch,signals=process,intervalMs=1000}={}){
  const options=consoleOptions(args),monitor=new ForecastMonitor({directory,now,fetcher});await monitor.initialize();
  const rl=createInterface({input,output,terminal:Boolean(output.isTTY)});let message='Public forecast only. No manual actual observations entered automatically.',closed=false,lastSnapshot,lastDraw=0,refreshAfter=0,archive=Promise.resolve();
  const draw=()=>{if(closed)return;if(!output.isTTY&&now()-lastDraw<60000&&lastDraw)return;lastDraw=now();if(output.isTTY){cursorTo(output,0,0);clearScreenDown(output);}output.write(renderDashboard(monitor,options,message)+'\n> '+(rl.line||''));};
  const tick=()=>{if(closed)return;monitor.tick();const f=monitor.state.forecast;if(f&&f.retrievedAt!==lastSnapshot){lastSnapshot=f.retrievedAt;archive=archive.then(()=>archiveSnapshot(monitor,directory)).catch(()=>{message='Snapshot archive write failed; forecast display remains available.';});}draw();};
  let finish;const stopped=new Promise(r=>finish=r);
  const stop=()=>{if(closed)return;closed=true;clearInterval(timer);rl.close();finish();};
  const timer=setInterval(tick,intervalMs);signals.on('SIGINT',stop);rl.on('SIGINT',stop);rl.on('close',stop);
  let commands=Promise.resolve();rl.on('line',line=>{commands=commands.then(async()=>{
    if(closed)return;
    const [command,kind,value,...extra]=line.trim().toLowerCase().split(/\s+/);try{
      if(command==='quit'||command==='exit'){stop();return;}
      if(command==='refresh'&&!kind){if(now()<refreshAfter)message='Manual refresh limited to once per 15 seconds.';else{refreshAfter=now()+15000;monitor.nextFetch=0;monitor.tick();message='Refresh requested (coalesced with any request already in progress).';}}
      else if(command==='actual'&&!extra.length&&/^\d+$/.test(value||'')){message=manualActual(monitor,kind,Number(value));await monitor.persist();}
      else if(command==='qty'&&!extra.length&&['fuel','co2'].includes(kind)&&/^\d+$/.test(value||'')&&Number.isSafeInteger(Number(value))){options[kind+'Quantity']=Number(value);message='Illustrative purchase quantity updated; no purchase performed.';}
      else if(command==='help'||!command)message='Enter prices as whole dollars per 1,000; quantities as whole individual units. Only manually entered prices are actual observations.';
      else message='Unknown command. Type help.';
    }catch(e){message=e.message;}lastDraw=0;draw();
  }).catch(()=>{message='Command could not be saved; retry manually.';});});
  tick();await stopped;await commands;await monitor.flush();if(monitor.state.forecast)await archiveSnapshot(monitor,directory).catch(()=>{});await archive;signals.removeListener('SIGINT',stop);output.write('\nForecast monitor stopped. AM4 was not controlled.\n');
}
