import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {retrieveForecast,addForecast,observeActual,pruneAccuracy,SLOT_MS,slotStart} from './forecast.mjs';
import {planResources} from './forecast-planner.mjs';
export class ForecastMonitor{
  constructor({directory,enabled=true,now=Date.now,fetcher=fetch,log=()=>{},opportunityCostPerAircraftHour=null}={}){
    Object.assign(this,{directory,enabled,now,fetcher,log,opportunityCostPerAircraftHour});this.state={version:1,forecast:null,records:[]};this.markets={};this.observedAt={};this.samples=[];this.started=now();this.nextFetch=0;this.nextPublish=0;this.status='NOT_LOADED';this.context={};
  }
  async initialize(){
    try{const raw=await readFile(join(this.directory,'forecast-accuracy.json'),'utf8');if(raw.length>1000000)throw Error();const data=JSON.parse(raw);if(data.version!==1||!Array.isArray(data.records)||data.records.length>800)throw Error();this.state=data;pruneAccuracy(this.state,this.now());}catch{this.status='NO_TRUSTED_SAVED_OBSERVATIONS';}
  }
  observeMarkets(value){if(!this.enabled)return;const at=this.now();for(const kind of ['fuel','co2'])if(value?.[kind]){this.markets[kind]=structuredClone(value[kind]);this.observedAt[kind]=at;observeActual(this.state,kind,value[kind],at);}this.tick();}
  recordConsumption(receipt){if(!this.enabled||!['fuel','co2'].every(k=>Number.isSafeInteger(receipt?.[k])&&receipt[k]>=0))return;this.samples.push({at:this.now(),fuel:receipt.fuel,co2:receipt.co2});this.samples=this.samples.filter(s=>s.at>=this.now()-3600000).slice(-1000);}
  observeDeparture({flight,eligible}={}){
    if(!flight?.aircraftId||flight.registrations?.length!==1||!eligible?.reasons?.length||!eligible.reasons.every(r=>['DISPATCH_RESOURCE_GATE','INSUFFICIENT_ROUTE_FUEL'].includes(r)))return;
    // Anonymous requirements from a selected enabled flight panel, not an aircraft registry.
    this.routeNeeds||=[];this.routeNeeds.push({fuel:Number.isSafeInteger(flight.fuelRequired)?flight.fuelRequired:null});this.routeNeeds=this.routeNeeds.slice(-20);
  }
  consumption(){const at=this.now(),samples=this.samples.filter(s=>s.at>=at-3600000),hours=(at-Math.max(this.started,at-3600000))/3600000;return Object.fromEntries(['fuel','co2'].map(k=>[k,{unitsPerHour:samples.length>=3&&hours>=1/60?samples.reduce((sum,s)=>sum+s[k],0)/hours:null,basis:'SESSION_VERIFIED_RECEIPTS_TRAILING_MAX_ONE_HOUR',samples:samples.length}]));}
  update({markets,context}={}){if(!this.enabled)return; if(markets)for(const k of ['fuel','co2']){
    // Working receipt-accounted inventories may change; never turn cached prices into new accuracy samples.
    if(markets[k]&&this.observedAt[k])this.markets[k]=structuredClone(markets[k]);
  }if(context){this.context={...structuredClone(context),confirmedEnabledDepartures:this.routeNeeds?.length||null,routeNeeds:this.routeNeeds||[]};this.routeNeeds=[];}this.tick();this.publish();}
  tick(){if(!this.enabled||this.pending||this.now()<this.nextFetch)return;this.pending=this.refresh().catch(()=>{this.status='ADVISORY_UNAVAILABLE';this.nextFetch=this.now()+300000;}).finally(()=>{this.pending=null;});}
  async refresh(){
    try{const f=await retrieveForecast({now:this.now,fetcher:this.fetcher});addForecast(this.state,f,this.now());this.status='OK';this.nextFetch=slotStart(this.now())+SLOT_MS+5000;}
    catch{this.status='UNAVAILABLE';this.state.unavailableRetrievals=(this.state.unavailableRetrievals||0)+1;this.state.lastUnavailableAt=new Date(this.now()).toISOString();this.nextFetch=this.now()+300000;}
    // Failure is advisory; raw errors, HTTP bodies and game transport data are not persisted.
    await this.persist();this.nextPublish=0;this.publish();
  }
  plan(){return planResources({forecast:this.state.forecast,records:this.state.records,markets:this.markets,observedAt:this.observedAt,now:this.now(),consumption:this.consumption(),context:this.context,opportunityCostPerAircraftHour:this.opportunityCostPerAircraftHour,sourceStatus:this.status});}
  async atomic(name,value){await mkdir(this.directory,{recursive:true});const file=join(this.directory,name);await writeFile(file+'.tmp',JSON.stringify(value,null,2));await rename(file+'.tmp',file);}
  persist(){pruneAccuracy(this.state,this.now());const snapshot=structuredClone(this.state);this.persisting=(this.persisting||Promise.resolve()).then(()=>this.atomic('forecast-accuracy.json',snapshot)).catch(()=>{this.status='LOCAL_REPORT_WRITE_FAILED';});return this.persisting;}
  publish(){if(!this.enabled||this.writing||this.now()<this.nextPublish)return;this.nextPublish=this.now()+60000;this.writing=(async()=>{try{
    const plan=this.plan();await this.atomic('resource-advisory-latest.json',plan);await this.persist();
    const brief=Object.fromEntries(Object.entries(plan.resources).map(([k,r])=>[k,{recommendation:r.recommendation,nextFavorable:r.nextFavorable?.at,confidence:r.confidence.level,policyChange:r.requiresPolicyChange}]));const key=JSON.stringify({sourceStatus:this.status,...brief});if(key!==this.logKey){this.logKey=key;this.log({event:'RESOURCE_FORECAST_ADVISORY',sourceStatus:this.status,mode:'ADVISORY_ONLY',resources:brief});}
  }catch{this.status='LOCAL_REPORT_WRITE_FAILED';}finally{this.writing=null;}})();}
  async flush(){await this.pending;await this.writing;await this.persist();}
}
// Every integration call is observational and isolated, including an accidentally throwing observer.
export function notifyForecast(monitor,method,...args){try{monitor?.[method](...args);}catch{}}
