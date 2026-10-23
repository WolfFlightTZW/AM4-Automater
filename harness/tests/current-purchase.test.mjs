// Synthetic current AM4 views only. No network, production state or game connection.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';import vm from 'node:vm';
import {Store} from '../store.mjs';import {Runner,bindPurchase} from '../runner.mjs';import {readSource} from '../source.mjs';import {purchaseDecision} from '../purchasing.mjs';import {requiresRecoveryBackoff} from '../performance.mjs';import {OperatorControl} from '../../operator/control.mjs';
const source=readSource(fileURLToPath(new URL('../../',import.meta.url)));
function market(kind,overrides={}){return {ok:true,kind,pricePer1000:kind==='fuel'?500:125,capacityMax:10000,holding:6000,capacityUsed:4000,cash:250000000,nextRefreshSeconds:600,...overrides};}
function game(kind,{ambiguous=false,holdVerification=false,disabled=false}={}){
 const state={market:market(kind),clicks:0,disabled,holdVerification,waiting:[],firstClick:null};let active='fuel';
 class Input{constructor(){this.amount='';this.disabled=false;this.placeholder='Amount to purchase';}get value(){return this.amount;}set value(v){this.amount=v;}getClientRects(){return [1];}dispatchEvent(){}}
 const input=new Input(),button={innerText:'PURCHASE',get disabled(){return state.disabled;},getClientRects:()=>[1],click(){state.clicks++;state.firstClick?.();if(!ambiguous){state.market.holding+=Number(input.value);state.market.capacityUsed=state.market.capacityMax-state.market.holding;state.market.cash-=Math.round(Number(input.value)*state.market.pricePer1000/1000);}else state.disabled=true;}};
 const dialogs=['fuel','co2'].map(k=>({get innerText(){const m=state.market;return `${k==='fuel'?'CURRENT PRICE':'QUOTA COST'} $ ${m.pricePer1000} CAPACITY ${m.capacityMax-m.holding} / ${m.capacityMax} HOLDING ${m.holding}`;},getClientRects:()=>active===k?[1]:[],querySelectorAll:q=>q==='input'?[input]:[button]}));
 const menu={innerText:'FUEL',getClientRects:()=>[1],click:()=>{active='fuel';}},tab={innerText:'CO2',getClientRects:()=>[1],click:()=>{active='co2';}};
 const doc={body:{get innerText(){return 'ACCOUNT $ '+state.market.cash;}},querySelectorAll:q=>q.includes('smallMainMenu')?[menu]:dialogs,querySelector:q=>q==='#popBtn2'?tab:q==='#sumCost'?{innerText:String(Math.round(Number(input.value)*state.market.pricePer1000/1000))}:null};
 const context=vm.createContext({document:doc,HTMLInputElement:Input,Event:class{},getComputedStyle:()=>({visibility:'visible'}),setTimeout:(callback,ms)=>{if(ms===650&&state.holdVerification)state.waiting.push(callback);else queueMicrotask(callback);}});
 state.run=async expression=>JSON.parse(await vm.runInContext(expression,context));return state;
}
for(const kind of ['fuel','co2']){
 test(`${kind}: real Runner/template buys from fresh UI despite retained UNKNOWN and PENDING records`,async()=>{
  const root=mkdtempSync(join(tmpdir(),'am4-current-purchase-')),store=new Store(root),g=game(kind);
  try{
   const old=store.intent({registration:kind,kind:'purchase',before:{[kind]:market(kind)},quote:{requested:12,cost:2}});old.state='UNKNOWN';store.saveAction(old);
   const pending=store.intent({registration:kind,kind:'purchase',before:{[kind]:market(kind)},quote:{requested:7,cost:1}});
   const runner=new Runner({live:true,maxSeconds:60,maxActions:1,productionRoot:root},source,store);let fresh=0;
   runner.markets=async options=>{assert.equal(options?.fresh,true);fresh++;return {ok:true,[kind]:structuredClone(g.market)};};runner.guard={check:async()=>{}};runner.confirm=async()=>{};runner.verifySource=()=>{};runner.evaluate=async expression=>g.run(expression);
   // Purchase must not consult either the old SQLite hold or an old legacy resource hold.
   runner.holds=()=>{throw Error('HISTORICAL_RESOURCE_HOLD_CONSULTED');};
   const report=store.newCase('Purchase','OFFLINE');await runner.purchase(report,kind);
   assert.equal(report.result,'PASS');assert.equal(g.clicks,1);assert.equal(g.market.holding,10000);assert(fresh>=3);
   assert.equal(store.get(old.id).state,'UNKNOWN');assert.equal(store.get(pending.id).state,'PENDING');assert.equal(store.get(report.checkpoint).state,'PURCHASE_VERIFIED');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
 });
 test(`${kind}: disabled active Purchase control cannot be clicked a second time`,async()=>{
  const g=game(kind,{ambiguous:true,holdVerification:true}),m=g.market,requested=4000,cost=Math.round(requested*m.pricePer1000/1000);
  const expression=bindPurchase(source.blocks.purchaseJsTemplate,kind,{kind,price:m.pricePer1000,capacity:m.capacityMax,holding:m.holding,cash:m.cash,requested,cost});
  const clicked=new Promise(resolve=>{g.firstClick=resolve;}),first=g.run(expression);await clicked;
  const second=await g.run(expression);assert.equal(second.clickAttempted,false);assert.equal(g.clicks,1);
  g.holdVerification=false;for(const callback of g.waiting.splice(0))callback();const result=await first;assert.equal(result.status,'UNVERIFIED_AFTER_CLICK');assert.equal(g.clicks,1);
 });
 test(`${kind}: current price, full capacity, reserve and unavailable control still prevent spending`,async()=>{
  const ceiling=kind==='fuel'?1000:150;
  for(const overrides of [{pricePer1000:ceiling},{pricePer1000:ceiling+1},{holding:10000},{cash:100000000}])assert.equal(purchaseDecision({[kind]:market(kind,overrides)},kind).decision,'SKIP');
  assert.equal(purchaseDecision({[kind]:market(kind,{holding:9999})},kind).maximumUnits,1);
  const g=game(kind,{disabled:true}),m=g.market;const result=await g.run(bindPurchase(source.blocks.purchaseJsTemplate,kind,{price:m.pricePer1000,capacity:m.capacityMax,holding:m.holding,cash:m.cash,requested:4000,cost:Math.round(4000*m.pricePer1000/1000)}));assert.equal(result.clickAttempted,false);assert.equal(g.clicks,0);
 });
 test(`${kind}: ambiguous current response is recorded once, then a new decision uses current AM4 inventory`,async()=>{
  const root=mkdtempSync(join(tmpdir(),'am4-ambiguous-purchase-')),store=new Store(root),g=game(kind,{ambiguous:true});
  try{const runner=new Runner({live:true,maxSeconds:60,maxActions:1},source,store);runner.markets=async()=>({ok:true,[kind]:structuredClone(g.market)});runner.guard={check:async()=>{}};runner.confirm=async()=>{};runner.verifySource=()=>{};runner.evaluate=async expression=>g.run(expression);
   const first=store.newCase('Purchase','OFFLINE');await runner.purchase(first,kind);assert.equal(first.result,'INCONCLUSIVE');assert.equal(first.reason,'PURCHASE_NOT_PROVEN_NO_RETRY');assert.equal(g.clicks,1);assert.equal(store.get(first.checkpoint).state,'UNKNOWN');
   // A later authoritative UI view is full: never replay the old quantity or infer its outcome.
   g.market.holding=g.market.capacityMax;g.market.capacityUsed=0;g.disabled=false;
   const next=store.newCase('Purchase','OFFLINE');await runner.purchase(next,kind);assert.equal(g.clicks,1);assert.equal(next.reason,'NO_NATURALLY_QUALIFYING_MARKET');assert.equal(store.get(first.checkpoint).state,'UNKNOWN');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
 });
}
test('existing operator action ownership serializes active purchases, without a new purchase lock',()=>{const root=mkdtempSync(join(tmpdir(),'am4-purchase-owner-'));const c=new OperatorControl(root);try{c.request('TESTING');const a=c.acquire('TESTING');c.begin(a.token,'PurchaseFuel');assert.throws(()=>c.begin(a.token,'PurchaseCO2'),/ACTION_ALREADY_RUNNING/);assert.throws(()=>c.acquire('TESTING'),/INTERFACE_ALREADY_OWNED/);c.end(a.token);c.release(a.token);}finally{c.close();rmSync(root,{recursive:true,force:true});}});
test('historical purchase diagnostics do not impose backoff; aircraft uncertainty remains protected',()=>{assert.equal(requiresRecoveryBackoff([{kind:'purchase',state:'UNKNOWN'}]),false);assert.equal(requiresRecoveryBackoff([{kind:'purchase',state:'PENDING'}],{scheduleComplete:false}),false);assert.equal(requiresRecoveryBackoff([{kind:'departure',state:'UNKNOWN'}]),true);});
