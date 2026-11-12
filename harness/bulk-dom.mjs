// Native controls discovered from maintained reference examples. Runtime evidence is mandatory.
// Never call an inferred endpoint or synthesize an Ajax request.
export function bulkDom(doc,method,args={}){
  const text=e=>String(e?.innerText||'').replace(/\s+/g,' ').trim();
  const visible=e=>Boolean(e?.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');
  const enabled=e=>visible(e)&&!e.disabled&&e.getAttribute('aria-disabled')!=='true';
  const ids=items=>items.map(String).sort(),same=(a,b)=>JSON.stringify(ids(a))===JSON.stringify(ids(b));
  const number=e=>{const s=text(e).replace(/[$,\s]/g,'');return /^\d+(?:\.\d+)?$/.test(s)?Number(s):null;};
  const buttons=scope=>[...(scope||doc).querySelectorAll('button,a,input[type="submit"]')];
  const checkHours=c=>{const s=text(c.querySelector('b:nth-child(8)')||c.querySelector('b.text-success, b.text-danger, b')),m=s.replace(/,/g,'').match(/^(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?)?$/i);return m?Number(m[1]):null;};
  function nativeDeparture(){
    const button=doc.getElementById('departAll');
    if(!enabled(button)||!/^Depart\s+\d+$/i.test(text(button)))return null;
    const events=(globalThis.jQuery||globalThis.$)?._data?.(button,'events');
    const sources=[button.getAttribute('onclick')||'',...(events?.click||[]).map(e=>String(e.handler))];
    const bindings=sources.filter(s=>/route_depart\.php\?mode=all/.test(s)).map(s=>s.match(/\bids=([0-9,]+)(?=['"&]|$)/)?.[1]).filter(Boolean);
    if(bindings.length!==1)return null;const routeIds=bindings[0].split(',');
    const count=Number(text(button).match(/\d+/)?.[0]);
    if(new Set(routeIds).size!==routeIds.length||routeIds.length!==count)return null;
    return {button,routeIds,count};
  }
  const previewButtons=kind=>doc.querySelector('#maintAction')?buttons(doc.querySelector('#maintAction')).filter(e=>enabled(e)&&new RegExp('^Bulk '+(kind==='check'?'(?:A[- ]?)?Check':'Repair')+'$','i').test(text(e))&&!/mode=do/.test(e.getAttribute('onclick')||'')):[];
  const finalButtons=kind=>buttons(doc.querySelector(kind==='repair'?'#repairRes':'#maintPlanAction')).filter(e=>enabled(e)&&(kind==='check'?e.id==='bulk-check-btn':/maint_plan_do\.php[^'"<>]*bulkRepair[^'"<>]*mode=do|maint_plan_repair_bulk\.php\?mode=do/.test(e.getAttribute('onclick')||'')));
  const landed=()=>[...doc.querySelectorAll('#landedList .flight-list[data-reg]')].filter(e=>e.dataset.grounded==='0').map(e=>({id:e.id.match(/^flightStatus(\d+)$/)?.[1],registration:String(e.dataset.reg||'')}));
  function quote(kind){
    const panel=doc.querySelector('#maintPlanAction');if(!visible(panel))return {ok:false,reason:'BULK_PANEL_NOT_VISIBLE'};
    const cards=[...panel.querySelectorAll('.opa-check[data-id]')];
    const selected=kind==='check'?cards.filter(c=>c.classList.contains('selected')).map(c=>String(c.dataset.id||'')):
      [...(doc.querySelector('#repairRes')?.querySelectorAll('[onclick]')||[])].map(e=>(e.getAttribute('onclick')||'').match(/routes_main\.php\?mode=details&id=(\d+)/)?.[1]).filter(Boolean);
    // Attribute-addressed preview rows can bind a registration to its current fleet ID.
    // Never ignore an unknown filtered row or infer targets from a total cost alone.
    if(kind==='repair'&&!selected.length)for(const row of doc.querySelector('#repairRes')?.querySelectorAll('[data-reg]')||[]){const matches=(args.rows||[]).filter(r=>r.registration===row.dataset.reg);selected.push(/^\d+$/.test(row.dataset.id||'')?row.dataset.id:matches.length===1?matches[0].aircraftId:'UNBOUND');}
    const cost=number(doc.querySelector(kind==='check'?'#dataCost':'#repairRes td.text-danger.font-weight-bold'));
    const targets=[...new Set(selected)],controls=finalButtons(kind);
    const select=doc.querySelector('#repairPct'),chosen=[...(select?.options||[])].find(o=>o.value===select.value),wearThreshold=args.repairWearThreshold??args.wearThreshold??20;
    const conditions=kind==='check'?cards.filter(c=>c.classList.contains('selected')).every(c=>Number.isFinite(checkHours(c))&&checkHours(c)>=0&&checkHours(c)<20):Number(String(chosen?.text).match(/\d+/)?.[0])===wearThreshold;
    return {ok:conditions&&targets.length>0&&targets.every(id=>/^\d+$/.test(id))&&selected.length===targets.length&&controls.length===1&&Number.isSafeInteger(cost)&&cost>=0,kind,ids:targets,cost,wearThreshold,reason:targets.length?'BULK_QUOTE_TARGETS_OR_COST_UNPROVEN':'BULK_TARGETS_UNBOUND'};
  }
  if(method==='inspect'){const native=nativeDeparture();return {departureControls:native?1:0,departureRouteIds:native?.routeIds,departureCount:native?.count,repairControls:previewButtons('repair').length,checkControls:previewButtons('check').length};}
  if(method==='maintenanceQuote')return quote(args.kind);
  if(method==='maintenancePreview')return (async()=>{
    const controls=previewButtons(args.kind);if(controls.length!==1)return {ok:false,reason:'BULK_CONTROL_MISSING_OR_AMBIGUOUS'};
    controls[0].click();await new Promise(r=>setTimeout(r,750));
    if(args.kind==='repair'){
      const select=doc.querySelector('#repairPct'),option=[...(select?.options||[])].find(o=>Number(String(o.text).match(/\d+/)?.[0])===args.repairWearThreshold);
      if(!option)return {ok:false,reason:'BULK_REPAIR_THRESHOLD_UNAVAILABLE'};
      select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(r=>setTimeout(r,750));
    }else{
      const cards=[...doc.querySelectorAll('#maintPlanAction .opa-check[data-id]')];
      if(!args.ids.every(id=>cards.filter(c=>c.dataset.id===id&&enabled(c)&&Number.isFinite(checkHours(c))&&checkHours(c)>=0&&checkHours(c)<20).length===1))return {ok:false,reason:'BULK_TARGETS_UNBOUND'};
      for(const c of cards)if(c.classList.contains('selected')!==args.ids.includes(c.dataset.id))c.click();
      await new Promise(r=>setTimeout(r,150));
    }
    const q=quote(args.kind);return q.ok&&!same(q.ids,args.ids)?{ok:false,reason:'BULK_TARGET_SET_DIFFERS'}:q;
  })();
  if(method==='maintenanceCommit'){
    const q=quote(args.kind);if(!q.ok||q.cost!==args.cost||!same(q.ids,args.ids))return {clicked:false,reason:'BULK_QUOTE_CHANGED'};
    const control=finalButtons(args.kind);if(control.length!==1)return {clicked:false,reason:'BULK_CONTROL_CHANGED'};
    control[0].click();return {clicked:true};
  }
  if(method==='departureCommit'){
    const rows=landed().filter(r=>args.ids?.includes(r.id)),native=nativeDeparture();
    if(!args.ids?.length||!native||!same(native.routeIds,args.routeIds||[])||native.count!==args.ids.length||!same(rows.map(r=>r.id),args.ids)||rows.some(r=>!r.id||r.registration==='N-145'||args.excludedAircraftIds?.includes(r.id)))return {clicked:false,reason:'BULK_TARGET_SET_CHANGED'};
    native.button.click();return {clicked:true};
  }
  if(method==='departureState')return args.ids.map(id=>({id,rows:[...doc.querySelectorAll('[id="flightStatus'+id+'"]')].map(e=>({location:e.parentElement?.id,registration:String(e.dataset.reg||'')}))}));
  throw Error('BULK_METHOD_NOT_ALLOWED');
}
export function bulkExpression(method,args={}){
  if(!['inspect','maintenancePreview','maintenanceQuote','maintenanceCommit','departureCommit','departureState'].includes(method))throw Error('BULK_METHOD_NOT_ALLOWED');
  return `(async()=>JSON.stringify(await (${bulkDom.toString()})(document,${JSON.stringify(method)},${JSON.stringify(args)})))()`;
}
