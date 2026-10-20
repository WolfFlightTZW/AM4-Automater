// Runs in the already-connected Steam document. No HTTP endpoints are invented or called.
// Navigation and maintenance planning reuse the click sequence in the archived single-action scripts.
export function createDom(doc = document) {
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = e => Boolean(e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
  const enabled = e => visible(e) && !e.disabled && e.getAttribute('aria-disabled') !== 'true';
  const number = s => { const text = clean(s).replace(/,/g, ''); return /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : null; };
  const registrations = s => [...new Set(clean(s).match(/\bN-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?![A-Za-z0-9-])/g) || [])];
  function handler(e) {
    const text = e?.getAttribute('onclick') || '';
    const match = text.match(/['"](maint_plan_do\.php\?[^'"<>]+)['"]/);
    if (!match) return null;
    const url = new URL(match[1].replace(/&amp;/g, '&'), 'http://am4.invalid/');
    const values = name => url.searchParams.getAll(name);
    if (values('id').length !== 1 || !/^\d+$/.test(values('id')[0]) || values('type').length !== 1 || !['repair', 'check'].includes(values('type')[0])) return null;
    if (values('mode').length > 1 || (values('mode').length && values('mode')[0] !== 'do')) return null;
    return { id: values('id')[0], kind: values('type')[0], commit: values('mode')[0] === 'do' };
  }
  function maintenance() {
    const records = [...doc.querySelectorAll('#maintAction .maint-list-sort')].map(row => {
      const control = row.querySelector('[id^="controls"]');
      const id = control?.id?.match(/^controls(\d+)$/)?.[1] || null;
      const buttons = [...row.querySelectorAll('button,a')].filter(enabled).map(handler).filter(x => x && x.id === id && !x.commit);
      return { id, registration: String(row.dataset.reg || ''), wear: number(row.dataset.wear), hoursToCheck: number(row.dataset.hours), atBase: row.dataset.base === '1', availableActions: buttons.map(b => b.kind) };
    });
    return { ok: records.length > 0, records, evidence: { selector: '#maintAction .maint-list-sort', rows: records.length } };
  }
  function schedule() {
    const root = doc.querySelector('#maintAction');
    if (!root || !visible(root)) return { complete: false, entries: [], reason: 'SCHEDULE_NOT_VISIBLE' };
    const text = clean(root.innerText);
    // A plan list is not a schedule, even if the surrounding popup contains that word.
    const headings = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6,.xl-text,.l-text,b,strong')].filter(e => /^MAINTENANCE SCHEDULE$/i.test(clean(e.innerText)));
    // Live Steam schedule (2026-10-18) has #maintCal and #maintDetail, with
    // the schedule heading outside #maintAction. Do not require a fictitious inner heading.
    const calendarView = Boolean(root.querySelector('#maintCal') && root.querySelector('#maintDetail'));
    const heading = calendarView || /^MAINTENANCE SCHEDULE\b/i.test(text) || headings.length === 1;
    if (!heading || root.querySelector('.maint-list-sort')) return { complete: false, entries: [], reason: 'SCHEDULE_VIEW_UNRECOGNIZED', evidence: { heading, planRowsPresent: Boolean(root.querySelector('.maint-list-sort')) } };
    const tables = [...root.querySelectorAll('table')].filter(visible);
    const candidates = tables.filter(t => /(?:registration|aircraft|a\/c)/i.test(clean(t.querySelector('thead')?.innerText || t.querySelector('tr')?.innerText)) && /repair|check|type|action|maintenance/i.test(clean(t.querySelector('thead')?.innerText || t.querySelector('tr')?.innerText)));
    const entries = []; let unknownRows = 0;
    if (calendarView) {
      const labels = [...root.querySelectorAll('#maintCal .maintRegBox')];
      const rows = [...root.querySelectorAll('#calContainer .maintBox')];
      if (labels.length !== rows.length) unknownRows++;
      for (let i = 0; i < rows.length; i++) {
        const registration=clean(labels[i]?.innerText);
        const regs=registration?[registration]:[];
        const aircraftId = (labels[i]?.getAttribute('onclick') || '').match(/routes_main\.php\?mode=details&id=(\d+)/)?.[1];
        const bars = [...rows[i].querySelectorAll('[onclick]')];
        if (regs.length !== 1 || !aircraftId || !bars.length) { unknownRows++; continue; }
        for (const bar of bars) {
          const label = clean(bar.innerText), scheduleId = (bar.getAttribute('onclick') || '').match(/^maintDetails\((\d+)\);?$/)?.[1];
          const kind = /^A[- ]?Check$/i.test(label) ? 'check' : /^Repair$/i.test(label) ? 'repair' : null;
          if (!scheduleId || !kind) { unknownRows++; continue; }
          entries.push({registration:regs[0],aircraftId,kind,scheduleId,evidence:label});
        }
      }
    }
    if (candidates.length === 1) for (const row of candidates[0].querySelectorAll('tr')) {
      if (row.querySelector('th')) continue;
      const content = clean(row.innerText); if (!content) continue;
      const cells=[...row.querySelectorAll('td')];
      const linked=cells.flatMap(c=>[...c.querySelectorAll('[onclick]')]).map(e=>({registration:clean(e.innerText),aircraftId:(e.getAttribute('onclick')||'').match(/routes_main\.php\?mode=details&id=(\d+)/)?.[1]})).filter(e=>e.registration&&e.aircraftId);
      const regs=linked.length===1?[linked[0].registration]:registrations(content);
      if (!regs.length && /no (?:scheduled |pending |planned )?(?:maintenance|repairs?|checks?)|nothing scheduled/i.test(content)) continue;
      const kinds = [(/\brepair\b/i.test(content) ? 'repair' : null), (/\bA[- ]?check\b/i.test(content) ? 'check' : null)].filter(Boolean);
      if (regs.length !== 1 || kinds.length !== 1) { unknownRows++; continue; }
      entries.push({ registration: regs[0], aircraftId:linked.length===1?linked[0].aircraftId:null, kind: kinds[0], evidence: content.slice(0, 600) });
    }
    const pagination = [...root.querySelectorAll('a,button,select')].some(e => visible(e) && /next|page\s+\d|show more|load more/i.test(clean(e.innerText)));
    const explicitEmpty = !registrations(text).length && /no (?:scheduled |pending |planned )?(?:maintenance|repairs?|checks?)|nothing scheduled/i.test(text);
    const complete = !pagination && unknownRows === 0 && (explicitEmpty || (calendarView || candidates.length === 1) && entries.length > 0);
    return { complete, entries, reason: complete ? 'RECOGNIZED_SCHEDULE' : 'SCHEDULE_LAYOUT_OR_COMPLETENESS_UNKNOWN', evidence: { selector: '#maintAction', heading, calendarView, tableCount: candidates.length, unknownRows, pagination, text: text.slice(0, 6000) } };
  }
  function controls() {
    return [...doc.querySelectorAll('#popup button,#popup a')].filter(visible).map(e => {
      const raw = e.getAttribute('onclick') || '', route = raw.match(/['"]((?:maintenance_main|maint_[a-z_]+)\.php)(?:\?|['"])/)?.[1] || null;
      return { label: clean(e.innerText).slice(0, 60), route, action: handler(e), enabled: enabled(e) };
    }).filter(c => c.route);
  }
  function browserAutomation() {
    return ['autoDepartCheckbox', 'autoBuyerCheckbox', 'autoRepairCheckbox', 'autoCheckCheckbox'].filter(id => doc.getElementById(id)?.checked);
  }
  async function waitFor(find, ms = 7000) {
    const deadline = Date.now() + ms;
    do { const found = find(); if (found) return found; await new Promise(r => setTimeout(r, 150)); } while (Date.now() < deadline);
    throw new Error('UI_READINESS_TIMEOUT');
  }
  async function navigate(view) {
    const menu = [...doc.querySelectorAll('#smallMainMenu [onclick],.menu-btn-new[onclick],[id="nav_maintenance"]')].filter(enabled).filter(e => /['"]maintenance_main\.php['"]/.test(e.getAttribute('onclick') || ''));
    if (menu.length !== 1) return { ok: false, reason: 'MAINTENANCE_MENU_AMBIGUOUS', controls: controls() };
    const oldRoot=doc.querySelector('#maintAction');
    menu[0].click();
    await waitFor(() => doc.querySelector('#maintAction')!==oldRoot && visible(doc.querySelector('#popup.show #maintAction')));
    if (view === 'schedule' && schedule().reason !== 'SCHEDULE_VIEW_UNRECOGNIZED') return { ok: true };
    const route = view === 'plan' ? /['"]maint_plan\.php['"]/ : /['"](?:maint_schedule|maint_main|maintenance_schedule)\.php['"]/;
    const nav = [...doc.querySelectorAll('#popup button,#popup a')].filter(enabled).filter(e => route.test(e.getAttribute('onclick') || ''));
    if (nav.length !== 1) return { ok: false, reason: 'VIEW_NAVIGATION_UNRECOGNIZED', controls: controls() };
    const previousContent=rootContent();
    nav[0].click();
    await waitFor(() => rootContent()!==previousContent && (view === 'plan' ? maintenance().records.length > 0 : schedule().reason !== 'SCHEDULE_VIEW_UNRECOGNIZED'));
    // Expand only the actual Show all control with a known read-only plan handler.
    if (view === 'plan') {
      const all = [...doc.querySelectorAll('#popup a')].filter(enabled).filter(e => /^show all/i.test(clean(e.innerText)) && /['"]maint_plan\.php(?:\?[^'"<>]*)?['"]/.test(e.getAttribute('onclick') || ''));
      if (all.length === 1) { all[0].click(); await new Promise(r => setTimeout(r, 350)); }
    }
    return { ok: true };
  }
  async function showFleet(){
    const tabs=()=>[...doc.querySelectorAll('button[onclick]')].filter(e=>enabled(e)&&/^Fleet(?:\s|\()/i.test(clean(e.innerText))&&/Ajax\(['"]fleet\.php['"],\s*['"]routesContainer['"]/.test(e.getAttribute('onclick')||''));
    const covered=()=>{const popup=doc.querySelector('#popup.show');return visible(popup)&&!popup.contains(doc.querySelector('#routesContainer'));};
    const ready=()=>{const root=doc.querySelector('#routesContainer'),t=tabs();return visible(root)&&t.length===1&&/\bbtn-primary\b/.test(t[0].className||'')&&/Number of aircraft:/i.test(clean(root.innerText))&&!covered();};
    if(ready())return {ok:true,screen:'FLEET'};
    if(!tabs().length||covered()){
      const menu=[...doc.querySelectorAll('#mapRoutes[onclick]')].filter(e=>enabled(e)&&/menuFleet\(['"]Routes['"]\)/.test(e.getAttribute('onclick')||''));
      if(menu.length!==1)return {ok:false,reason:'FLEET_MENU_UNAVAILABLE_OR_AMBIGUOUS'};
      menu[0].click();await waitFor(()=>tabs().length>0);
    }
    if(ready())return {ok:true,screen:'FLEET'};
    const t=tabs();if(t.length!==1)return {ok:false,reason:'FLEET_TAB_UNAVAILABLE_OR_AMBIGUOUS'};
    t[0].click();await waitFor(ready);
    return {ok:true,screen:'FLEET'};
  }
  function rootContent(){return doc.querySelector('#maintAction')?.innerHTML;}
  function inspectPlanner(registration, kind, id) {
    const section = doc.querySelector(kind === 'repair' ? '#typeRepair' : '#typeCheck');
    if (!visible(section)) return { ok: false, reason: 'PLANNER_SECTION_MISSING' };
    const text = clean(section.innerText), costMatch = text.match(/Total cost\s*\$\s*([\d,]+)/i);
    const buttons = [...section.querySelectorAll('button,a,input[type="submit"]')].filter(enabled).filter(e => {
      const h = handler(e); return h && h.commit && h.kind === kind && h.id === id;
    });
    const rows = maintenance().records.filter(r => r.id === id && r.registration.toUpperCase() === registration.toUpperCase());
    const startNow = /(?:Repair start|Maintenance start)\s+Now\b/i.test(text);
    const cost = costMatch ? number(costMatch[1]) : null;
    const time = text.match(/(?:Repair|Check) time\s+(\d{2,3}:\d{2}:\d{2})/i)?.[1] || null;
    const ok = rows.length === 1 && buttons.length === 1 && startNow && Number.isSafeInteger(cost) && cost >= 0;
    return { ok, reason: ok ? 'EXACT_ID_TYPE_QUOTE_AND_CONTROL' : 'PLANNER_AMBIGUOUS_OR_NOT_AVAILABLE', registration, kind, id, cost, time, startNow, row: rows[0] || null, finalControls: buttons.length, evidence: text.slice(0, 2000) };
  }
  async function openPlanner({ registration, kind, id }) {
    const rows = [...doc.querySelectorAll('#maintAction .maint-list-sort')].filter(r => r.querySelector('[id^="controls"]')?.id === 'controls' + id && String(r.dataset.reg||'').toUpperCase() === registration.toUpperCase());
    if (rows.length !== 1) return { ok: false, reason: 'EXACT_MAINTENANCE_ROW_NOT_FOUND' };
    const controls = [...rows[0].querySelectorAll('button,a')].filter(enabled).filter(e => { const h = handler(e); return h && !h.commit && h.id === id && h.kind === kind; });
    if (controls.length !== 1) return { ok: false, reason: 'INDIVIDUAL_ACTION_NOT_AVAILABLE' };
    controls[0].click();
    await waitFor(() => visible(doc.querySelector(kind === 'repair' ? '#typeRepair' : '#typeCheck')));
    return inspectPlanner(registration, kind, id);
  }
  function cash() { const m = clean(doc.body?.innerText).match(/\bACCOUNT\s*\$\s*([\d,]+)/i); return m ? number(m[1]) : null; }
  function commit({ registration, kind, id, quote, actionId, excludedAircraftIds=[] }) {
    const fresh = inspectPlanner(registration, kind, id);
    if (!fresh.ok || fresh.cost !== quote.cost || fresh.time !== quote.time || fresh.row.wear !== quote.row.wear || fresh.row.hoursToCheck !== quote.row.hoursToCheck)
      return { ok: false, clicked: false, reason: 'PRECOMMIT_PLANNER_CHANGED', fresh };
    const balance = cash();
    if (!Number.isSafeInteger(balance) || balance - fresh.cost < 100000000 || browserAutomation().length) return { ok: false, clicked: false, reason: 'CASH_OR_BROWSER_AUTOMATION_GATE' };
    const fleet = [...doc.querySelectorAll('#landedList .flight-list[data-reg]')].filter(r => r.id === 'flightStatus'+id && r.dataset.reg === registration && r.dataset.grounded === '0' && clean(r.querySelector('[id^="flightStatusCounter"]')?.textContent).toLowerCase() === 'landed');
    if (fleet.length !== 1 || registration === 'N-145' || excludedAircraftIds.includes(id) || (kind === 'repair' ? !(fresh.row.wear > 9) : !(fresh.row.hoursToCheck <= 20))) return { ok: false, clicked: false, reason: 'PRECOMMIT_ELIGIBILITY_CHANGED' };
    const key = id + ':' + kind;
    globalThis.__am4HarnessAttempts ||= {};
    if (globalThis.__am4HarnessAttempts[key]) return { ok: false, clicked: false, reason: 'PAGE_ATTEMPT_ALREADY_RECORDED' };
    const section = doc.querySelector(kind === 'repair' ? '#typeRepair' : '#typeCheck');
    const button = [...section.querySelectorAll('button,a,input[type="submit"]')].find(e => { const h = handler(e); return enabled(e) && h && h.commit && h.id === id && h.kind === kind; });
    // Same final Plan repair / Plan check click as archived scripts, with a durable host intent first.
    globalThis.__am4HarnessAttempts[key] = actionId;
    button.click(); return { ok: true, clicked: true, cashBefore: balance, at: new Date().toISOString() };
  }
  function response() { return { text: clean(doc.querySelector('#maintPlanActionDo')?.innerText).slice(0, 2500), controls: controls() }; }
  function inventory(){
    const n=id=>number(doc.getElementById(id)?.innerText),pct=String(doc.getElementById('headerCo2Indicator')?.style?.height||'').match(/^([0-9]+(?:\.[0-9]+)?)%$/);
    return {fuel:n('headerFuel'),cash:n('headerAccount'),co2Percent:pct?Number(pct[1]):null};
  }
  function receipt(){
    const root=doc.getElementById('routesDepartScreenContent');
    let monitor=globalThis.__am4BatchReceipt;
    if(root&&(!monitor||monitor.root!==root)){
      monitor?.observer.disconnect();if(monitor?.timer)clearTimeout(monitor.timer);
      const versions={fuel:0,co2:0},observer=new MutationObserver(ms=>{for(const m of ms)for(const [id,key] of [['fd_fuel','fuel'],['fd_quotas','co2']]){const e=doc.getElementById(id);if(e&&(m.target===e||e.contains(m.target)||[...m.addedNodes].some(n=>n===e||n.contains?.(e))))versions[key]++;}});
      observer.observe(root,{subtree:true,childList:true,characterData:true});
      monitor=globalThis.__am4BatchReceipt={root,observer,versions,epoch:Date.now()};
    }
    if(monitor){clearTimeout(monitor.timer);monitor.timer=setTimeout(()=>{monitor.observer.disconnect();if(globalThis.__am4BatchReceipt===monitor)delete globalThis.__am4BatchReceipt;},120000);}
    return {epoch:monitor?.epoch,versions:monitor?{...monitor.versions}:null,receipt:{fuel:number(doc.getElementById('fd_fuel')?.innerText),co2:number(doc.getElementById('fd_quotas')?.innerText),routes:number(doc.getElementById('fd_routes')?.innerText)},header:inventory()};
  }
  function departureObservation(id){
    const rows=[...doc.querySelectorAll('[id="flightStatus'+id+'"]')].map(r=>({aircraftId:id,registration:r.dataset.reg,wear:number(r.querySelector('[id^="flightStatusWear"]')?.textContent),status:clean(r.querySelector('[id^="flightStatusCounter"]')?.textContent).toLowerCase(),grounded:r.dataset.grounded,location:r.parentElement?.id||null}));
    return {rows,...receipt()};
  }
  function flight() {
    const panel = doc.querySelector('#flightInfo');
    if (!visible(panel)) return { hours: null, reason: 'FLIGHT_PANEL_NOT_RECOGNIZED' };
    const m = clean(panel.innerText).match(/Flight time\s+(\d{1,3}):(\d{2}):(\d{2})\b/i);
    const buttons=[...doc.querySelectorAll('#flightInfo button,#flightInfo a')].filter(e=>enabled(e)&&/^flightInfoDepart[0-9]+$/.test(e.id)&&clean(e.innerText)==='Depart');
    const details=[...doc.querySelectorAll('#flightInfo button,#flightInfo a')].filter(e=>enabled(e)&&clean(e.innerText)==='Details').map(e=>(e.getAttribute('onclick')||'').match(/routes_main\.php\?mode=details&id=([0-9]+)/)?.[1]).filter(Boolean);
    const aircraftId=buttons.length===1&&details.length===1?details[0]:null;
    const routeId=buttons.length===1?buttons[0].id.slice('flightInfoDepart'.length):null;
    const rows=aircraftId?[...doc.querySelectorAll('.flight-list[data-reg]')].filter(r=>r.id==='flightStatus'+aircraftId):[];
    const regs=rows.length===1?[String(rows[0].dataset.reg||'')]:[];
    return { aircraftId, routeId, fuelRequired:number(clean(panel.innerText).match(/Fuel usage\s+([\d,]+)\s*Lbs/i)?.[1]),header:inventory(), hours: m && Number(m[2]) < 60 && Number(m[3]) < 60 ? Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600 : null, registrations:regs, evidence: clean(panel.innerText).slice(0, 1500) };
  }
  return { maintenance, schedule, controls, browserAutomation, navigate, showFleet, openPlanner, inspectPlanner, commit, response, flight, inventory, receipt, departureObservation, number, handler, registrations };
}
export function domExpression(method, args = []) {
  if (!['maintenance', 'schedule', 'controls', 'browserAutomation', 'navigate', 'showFleet', 'openPlanner', 'inspectPlanner', 'commit', 'response', 'flight', 'inventory', 'receipt', 'departureObservation'].includes(method)) throw new Error('DOM_METHOD_NOT_ALLOWED');
  return `(async()=>JSON.stringify(await (${createDom.toString()})(document)[${JSON.stringify(method)}](...${JSON.stringify(args)})))()`;
}

