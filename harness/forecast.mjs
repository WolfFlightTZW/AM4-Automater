// Public forecast observations only. No game connection, action API or policy authority.
export const SLOT_MS=1800000;
export const SOURCE='https://www.am4info.com/prices-api';
export const slotStart=ms=>Math.floor(ms/SLOT_MS)*SLOT_MS;
export function forecastUrl(now){const d=new Date(slotStart(now));return `${SOURCE}?day=${d.getUTCDate()}&time=${d.toISOString().slice(11,16)}&slots=49`;}
export function normalizeForecast(payload,{requestedAt,retrievedAt=requestedAt}={}){
  if(!Number.isFinite(requestedAt)||!Number.isFinite(retrievedAt)||retrievedAt<requestedAt||retrievedAt-requestedAt>60000||slotStart(requestedAt)!==slotStart(retrievedAt))throw Error('FORECAST_CLOCK_OR_SLOT_CHANGED');
  if(!Array.isArray(payload?.slots)||!payload.slots.length||payload.slots.length>49||payload.error)throw Error('FORECAST_SCHEMA_CHANGED');
  const windows=payload.slots.map((row,i)=>{
    const start=slotStart(requestedAt)+i*SLOT_MS,d=new Date(start);
    if(row.day!==d.getUTCDate()||row.time!==d.toISOString().slice(11,16)||row.is_current!==(i===0))throw Error('FORECAST_SLOT_CONTRADICTION');
    const prices={};for(const k of ['fuel','co2']){const v=row[k];if(v!=null&&(!Number.isSafeInteger(v)||v<=0))throw Error('FORECAST_PRICE_INVALID');prices[k]=v??null;}
    return {start:new Date(start).toISOString(),end:new Date(start+SLOT_MS).toISOString(),...prices};
  });
  return {source:SOURCE,retrievedAt:new Date(retrievedAt).toISOString(),sourceIssuedAt:null,windows};
}
export async function retrieveForecast({now=Date.now,fetcher=fetch,timeoutMs=5000}={}){
  const requestedAt=now(),response=await fetcher(forecastUrl(requestedAt),{signal:AbortSignal.timeout(timeoutMs),redirect:'error',headers:{Accept:'application/json'}});
  if(!response.ok)throw Error('FORECAST_HTTP_UNAVAILABLE');
  if(!/application\/json/i.test(response.headers.get('content-type')||''))throw Error('FORECAST_CONTENT_TYPE_CHANGED');
  // Bound response memory even if the public endpoint changes unexpectedly.
  let raw='';for await(const chunk of response.body){raw+=new TextDecoder().decode(chunk);if(raw.length>65536)throw Error('FORECAST_RESPONSE_TOO_LARGE');}
  return normalizeForecast(JSON.parse(raw),{requestedAt,retrievedAt:now()});
}
export function accuracySummary(records,kind){
  const rows=records.filter(r=>r.kind===kind),counts={exact:0,error:0,missed:0,missing:0,pending:0};
  for(const r of rows)if(r.status in counts)counts[r.status]++;
  const n=counts.exact+counts.error,ratio=n?counts.exact/n:null;
  const revised=rows.filter(r=>r.revisions>0).length,degraded=counts.error>0||revised>0||counts.missed>counts.exact||counts.missing>counts.exact;
  return {...counts,revised,compared:n,exactRate:ratio,level:degraded?'LOW':n>=6&&ratio>=0.95?'PROVISIONAL':'UNPROVEN',reason:degraded?'PREDICTION_ERRORS_OR_MISSING_TRANSITIONS':n<6?'INSUFFICIENT_PRETRANSITION_COMPARISONS':'RECENT_MATCHES_ONLY_NOT_A_GUARANTEE'};
}
export function addForecast(state,forecast,now){
  state.forecast=forecast;
  for(const w of forecast.windows)for(const kind of ['fuel','co2']){
    if(Date.parse(w.start)<=Date.parse(forecast.retrievedAt)+5000)continue; // no retrospective validation
    const old=state.records.find(r=>r.start===w.start&&r.kind===kind);
    if(!old)state.records.push({start:w.start,end:w.end,kind,predicted:w[kind],retrievedAt:forecast.retrievedAt,status:w[kind]===null?'missing':'pending'});
    else if((old.latestPredicted===undefined?old.predicted:old.latestPredicted)!==w[kind]){old.revisions=(old.revisions||0)+1;old.latestPredicted=w[kind];}
  }
  pruneAccuracy(state,now);
}
export function pruneAccuracy(state,now){
  for(const r of state.records)if(r.status==='pending'&&Date.parse(r.end)+300000<now)r.status='missed';
  state.records=state.records.filter(r=>Date.parse(r.end)>now-7*86400000).slice(-800);
}
export function observeActual(state,kind,market,at){
  if(!market?.ok||!Number.isSafeInteger(market.pricePer1000)||market.pricePer1000<=0)return;
  const start=slotStart(at),offset=at-start;if(offset<5000||offset>SLOT_MS-5000)return;
  const r=state.records.find(r=>r.kind===kind&&Date.parse(r.start)===start);
  if(!r||r.predicted===null||Date.parse(r.retrievedAt)>=start)return;
  if(r.actual!==undefined&&r.actual!==market.pricePer1000){r.status='error';r.contradictoryActual=true;return;}
  if(r.actual===undefined){r.actual=market.pricePer1000;r.observedAt=new Date(at).toISOString();r.error=r.actual-r.predicted;r.status=r.error===0?'exact':'error';}
}
