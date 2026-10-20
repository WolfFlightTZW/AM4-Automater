import { OperatorControl } from './control.mjs';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import {preflight,diagnostics} from './process-diagnostics.mjs';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
const args=process.argv.slice(2),action=args.shift()||'status';
const options={};for(let i=0;i<args.length;i+=2)options[args[i].replace(/^--/,'')]=args[i+1];
const root=options.root||fileURLToPath(new URL('./state/',import.meta.url));
let control;
let expectedRevision;
try{
  let result;
  if(action==='resume-preflight')result=await preflight({ignoreControllerPids:[process.ppid]});
  else if(action==='process-diagnostics')result=await diagnostics();
  else {
  // Central hook also protects already-built operator windows using the existing automatic command.
  if(action==='automatic'){
    // Read without changing ownership. A later pause/testing request must win while CIM is running.
    let database;try{database=new DatabaseSync(join(root,'operator.sqlite'),{readOnly:true});expectedRevision=JSON.parse(database.prepare('SELECT data FROM control WHERE id=1').get().data).revision;if(!Number.isSafeInteger(expectedRevision))throw new Error('INVALID_REVISION');}catch{throw new Error('OPERATOR_STATE_UNAVAILABLE');}finally{database?.close();}
    await preflight({ignoreControllerPids:[process.ppid]});
  }
  control=new OperatorControl(root);
  if(action==='status')result=control.status();
  else if(action==='pause')result=control.request('PAUSED/MANUAL');
  else if(action==='automatic')result=control.request('AUTOMATIC',{expectedRevision});
  else if(action==='testing')result=control.request('TESTING');
  else if(action==='acquire')result=control.acquire(options.role,Number(options.pid));
  else if(action==='begin')result={id:control.begin(options.token,options.name)};
  else if(action==='step')result=control.step(options.token,options.name,readFileSync(0,'utf8'),{irreversible:options.irreversible==='true',browserOffsetMs:Number(options.offset||0)});
  else if(action==='end-step')result=control.endStep(options.token,{implicit:options.implicit==='true',outcome:options.outcome||'RETURNED'});
  else if(action==='end')result=control.end(options.token,options.outcome||'RETURNED');
  else if(action==='release')result=control.release(options.token);
  else throw new Error('UNKNOWN_OPERATOR_COMMAND');
  }
  console.log(JSON.stringify({ok:true,...(result&&typeof result==='object'?result:{value:result})}));
}catch(error){console.log(JSON.stringify({ok:false,error:/^[A-Z0-9_]+$/.test(error.message)?error.message:'OPERATOR_CONTROL_FAILED',processDiagnostics:error.processDiagnostics}));process.exitCode=2;}
finally{control?.close();}
