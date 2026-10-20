// All account values and aircraft identities in this file are synthetic; N-145 is an intentional policy exclusion.
// Minimal selector-addressed DOM double. No runtime dependency or claim to reproduce Chromium layout.
export class Element {
  constructor({ text = '', id = '', data = {}, attrs = {}, visible = true, disabled = false, queries = {} } = {}) {
    this.innerText = text; this.textContent = text; this.id = id; this.dataset = data; this.attrs = attrs;
    this.shown = visible; this.disabled = disabled; this.queries = queries; this.clicks = 0;
  }
  getClientRects() { return this.shown ? [{}] : []; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  querySelectorAll(query) { return this.queries[query] || []; }
  querySelector(query) { return this.querySelectorAll(query)[0] || null; }
  getElementById(id) { return this.querySelector('#' + id); }
  click() { this.clicks++; this.onClick?.(); }
}
export function plannerDom({ cost = 2400, id = '123', kind = 'repair', reg = 'N-TEST001', rowReg = reg, disabled = false } = {}) {
  const final = new Element({ text: kind === 'repair' ? 'Plan repair' : 'Plan check', disabled, attrs: { onclick: `Ajax('maint_plan_do.php?mode=do&type=${kind}&id=${id}','maintPlanActionDo')` } });
  const section = new Element({ text: `Aircraft wear 12.5% Repair start Now Maintenance start Now Repair time 00:05:00 Check time 00:05:00 Total cost $ ${cost}`, queries: { 'button,a,input[type="submit"]': [final] } });
  const row = new Element({ data: { reg: rowReg, wear: '12.5', hours: '19', base: '1' }, queries: { '[id^="controls"]': [new Element({ id: 'controls' + id })], 'button,a': [] } });
  const fleet = new Element({ id:'flightStatus'+id, data: { reg, grounded: '0' }, queries: { '[id^="flightStatusCounter"]': [new Element({ text: 'landed' })] } });
  const doc = new Element({ queries: { ['#' + (kind === 'repair' ? 'typeRepair' : 'typeCheck')]: [section], '#maintAction .maint-list-sort': [row], '#landedList .flight-list[data-reg]': [fleet] } });
  doc.body = new Element({ text: 'ACCOUNT $ 250000000' });
  return { doc, section, final, row, fleet };
}
