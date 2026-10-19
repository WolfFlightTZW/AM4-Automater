import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const MODES = ['AUTOMATIC', 'PAUSED/MANUAL', 'TESTING'];
const STEP_MS = 20000, STALE_MS = 30000;
export function guardedExpression(expression, token, until) {
  // Only harness/engine-issued programmatic clicks are guarded. Real mouse clicks
  // and the game's native click method remain unchanged during manual operation.
  const method = '__am4OperatorCheckedClick';
  const body = expression.replace(/\.click\(\)/g, `.${method}(${JSON.stringify(token)},${until})`);
  return `(()=>{globalThis.__am4OperatorCommand=${JSON.stringify(token)};if(!HTMLElement.prototype.${method})Object.defineProperty(HTMLElement.prototype,'${method}',{configurable:true,value:function(t,u){if(globalThis.__am4OperatorCommand!==t||Date.now()>u)throw new Error('OPERATOR_COMMAND_EXPIRED');return this.click();}});return (${body});})()`;
}
export class OperatorControl {
  constructor(root, { now = Date.now, alive = pid => { try { process.kill(pid, 0); return true; } catch(e) { return e.code === 'EPERM'; } } } = {}) {
    mkdirSync(root, { recursive: true }); this.now=now;this.alive=alive;
    this.db=new DatabaseSync(join(root,'operator.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS control(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,event TEXT NOT NULL,data TEXT NOT NULL);');
    this.db.prepare('INSERT OR IGNORE INTO control VALUES(1,?)').run(JSON.stringify({mode:'PAUSED/MANUAL',revision:0,owner:null,action:null,lastCompleted:null,uncertainty:null,quarantineUntil:0}));
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state=JSON.parse(this.db.prepare('SELECT data FROM control WHERE id=1').get().data);
      const stale=state.owner && (!this.alive(state.owner.pid)||this.now()-state.owner.heartbeat>STALE_MS);
      if(stale){
        state.uncertainty={reason:'OWNER_LOST_OR_HEARTBEAT_STALE',action:state.action?.name||null,at:this.now()};
        state.quarantineUntil=Math.max(state.quarantineUntil,state.owner.commandUntil||0);
        state.owner=null;state.action=null;state.mode='PAUSED/MANUAL';state.revision++;
        this.record('STALE_OWNER_REVOKED',state.uncertainty);
      }
      const result=fn(state);
      this.db.prepare('UPDATE control SET data=? WHERE id=1').run(JSON.stringify(state));
      this.db.exec('COMMIT');return result;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  // The control row already holds mode, ownership, uncertainty and last completion.
  // Do not duplicate those values into a permanent event archive; retain old rows untouched.
  record(event,data) {}
  view(s){
    const waiting=s.quarantineUntil>this.now();
    const safe=s.mode==='PAUSED/MANUAL'&&!s.owner&&!waiting;
    return {...s,activeAction:s.action?.name||null,safeToUseGame:safe,
      display:safe?'SAFE TO USE GAME':waiting?'UNCERTAIN — WAIT FOR OLD COMMAND TO EXPIRE':s.owner&&s.mode==='PAUSED/MANUAL'?'PAUSE REQUESTED — FINISHING CURRENT ACTION':s.owner?'AUTOMATION ACTIVE':s.mode==='TESTING'?'TESTING RESERVED — NOT RELEASED FOR MANUAL USE':'AUTOMATIC ARMED — AUTOMATION MAY START',
      lastCompletedAction:s.lastCompleted?.name||null};
  }
  status(){return this.transaction(s=>this.view(s));}
  request(mode,{expectedRevision}={}){
    if(!MODES.includes(mode))throw new Error('INVALID_OPERATOR_MODE');
    return this.transaction(s=>{
      if(expectedRevision!==undefined&&(!Number.isSafeInteger(expectedRevision)||s.revision!==expectedRevision))throw new Error('OPERATOR_MODE_CHANGED_DURING_PREFLIGHT');
      if(mode!=='PAUSED/MANUAL'&&s.quarantineUntil>this.now())throw new Error('OLD_COMMAND_MAY_STILL_BE_RUNNING');
      s.mode=mode;s.revision++;this.settle(s);this.record('OPERATOR_MODE_REQUESTED',{mode,revision:s.revision});return this.view(s);
    });
  }
  acquire(role,pid=process.pid){
    return this.transaction(s=>{
      if(s.mode!==role||role==='PAUSED/MANUAL')throw new Error('OPERATOR_MODE_REQUIRES_EXPLICIT_'+role);
      if(s.owner||s.quarantineUntil>this.now())throw new Error('INTERFACE_ALREADY_OWNED_OR_UNCERTAIN');
      const token=randomUUID();s.owner={token,role,pid,heartbeat:this.now(),commandUntil:0};
      this.record('INTERFACE_ACQUIRED',{role,pid});return {token,role};
    });
  }
  owned(s,token){if(!s.owner||s.owner.token!==token)throw new Error('OPERATOR_OWNERSHIP_LOST');s.owner.heartbeat=this.now();}
  settle(s){
    if(s.owner&&s.mode!==s.owner.role&&!s.owner.commandUntil&&(!s.action||!s.action.irreversible)){
      if(s.action)s.lastCompleted={...s.action,finished:this.now(),outcome:'CANCELLED_BEFORE_SUBMISSION'};
      s.owner=null;s.action=null;this.record('PAUSE_ACKNOWLEDGED',{});
    }
  }
  heartbeat(token){return this.transaction(s=>{this.owned(s,token);return true;});}
  begin(token,name){return this.transaction(s=>{
    this.owned(s,token);
    if(s.mode!==s.owner.role)throw new Error('OPERATOR_PAUSE_REQUESTED');
    if(s.action)throw new Error('ACTION_ALREADY_RUNNING');
    s.action={id:randomUUID(),name,started:this.now(),irreversible:false};return s.action.id;
  });}
  step(token,name,expression,{irreversible=false,browserOffsetMs=0}={}){
    return this.transaction(s=>{
      this.owned(s,token);
      // A pause can finish verification of an already submitted action, never start another.
      if(s.mode!==s.owner.role&&!s.action?.irreversible)throw new Error('OPERATOR_PAUSE_REQUESTED');
      if(irreversible){if(s.mode!==s.owner.role)throw new Error('OPERATOR_PAUSE_REQUESTED');if(s.action)s.action.irreversible=true;}
      const implicit=!s.action;
      if(implicit)s.action={id:randomUUID(),name,started:this.now(),irreversible};
      const commandToken=randomUUID(),until=this.now()+STEP_MS;
      s.owner.commandUntil=until;s.owner.commandToken=commandToken;
      if(!Number.isFinite(browserOffsetMs))throw new Error('INVALID_BROWSER_CLOCK_OFFSET');
      return {expression:guardedExpression(expression,commandToken,until+browserOffsetMs-1000),implicit,until,actionId:s.action.id};
    });
  }
  endStep(token,{implicit=false,outcome='RETURNED'}={}){return this.transaction(s=>{
    this.owned(s,token);
    if(outcome==='UNKNOWN'){s.uncertainty={reason:'COMMAND_OUTCOME_UNKNOWN',action:s.action?.name||null,at:this.now()};s.quarantineUntil=Math.max(s.quarantineUntil,s.owner.commandUntil||0);s.mode='PAUSED/MANUAL';}
    else s.owner.commandUntil=0;
    if(implicit&&s.action){s.lastCompleted={...s.action,finished:this.now(),outcome};s.action=null;} this.settle(s);
    return this.view(s);
  });}
  end(token,outcome='RETURNED'){return this.transaction(s=>{
    this.owned(s,token);
    if(s.action){s.lastCompleted={...s.action,finished:this.now(),outcome};this.record('ACTION_FINISHED',s.lastCompleted);s.action=null;}
    if(outcome==='UNKNOWN'){s.mode='PAUSED/MANUAL';s.uncertainty={reason:'ACTION_OUTCOME_UNKNOWN',at:this.now()};s.quarantineUntil=Math.max(s.quarantineUntil,s.owner.commandUntil||0);} this.settle(s);
    return this.view(s);
  });}
  release(token){return this.transaction(s=>{
    if(!s.owner||s.owner.token!==token)return this.view(s);
    if(s.action||s.owner.commandUntil>this.now()){
      s.uncertainty={reason:'OWNER_RELEASED_WITH_UNFINISHED_ACTION',action:s.action?.name||null,at:this.now()};
      s.quarantineUntil=Math.max(s.quarantineUntil,s.owner.commandUntil||0);s.mode='PAUSED/MANUAL';
    }
    s.owner=null;s.action=null;this.record('INTERFACE_RELEASED',{});return this.view(s);
  });}
  close(){this.db.close();}
}
export class OperatorSession {
  constructor(root,role){this.control=new OperatorControl(root);let owner;try{owner=this.control.acquire(role);}catch(error){this.control.close();throw error;}this.token=owner.token;this.role=role;
    this.timer=setInterval(()=>{try{this.control.heartbeat(this.token);}catch{clearInterval(this.timer);}},2000);this.timer.unref();}
  begin(name){return this.control.begin(this.token,name);}
  end(outcome){return this.control.end(this.token,outcome);}
  step(name,expression,options){return this.control.step(this.token,name,expression,{...options,browserOffsetMs:this.browserClockOffset||0});}
  endStep(options){return this.control.endStep(this.token,options);}
  assertCanCommit(){const s=this.control.status();if(s.mode!==this.role||s.owner?.token!==this.token)throw new Error('OPERATOR_PAUSE_REQUESTED');}
  close(){if(this.closed)return;this.closed=true;clearInterval(this.timer);try{this.control.release(this.token);}finally{this.control.close();}}
}

