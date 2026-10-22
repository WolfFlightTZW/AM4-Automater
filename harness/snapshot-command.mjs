import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {existsSync,mkdirSync,writeFileSync,renameSync,readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {OperatorControl,OperatorSession} from '../operator/control.mjs';
import {preflight} from '../operator/process-diagnostics.mjs';
import {acquireGuard} from './guard.mjs';
import {Cdp} from './cdp.mjs';
import {readSource} from './source.mjs';
import {domExpression} from './dom.mjs';
import {alaskaStamp,validateFleet,publishSnapshot,publishIncompleteSnapshot,detailsExpression} from './fleet-snapshot.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function restorationAllowed(initial,current,revision){return initial.mode==='AUTOMATIC'&&current.mode==='TESTING'&&current.revision===revision&&!current.owner&&!current.action&&current.quarantineUntil<=Date.now();}
const safeView=s=>({mode:s.mode,revision:s.revision,owner:s.owner?{pid:s.owner.pid,role:s.owner.role,heartbeat:s.owner.heartbeat}:null,activeAction:s.activeAction,action:s.action,uncertainty:s.uncertainty,safeToUseGame:s.safeToUseGame,display:s.display});
function recoverySummary(root){const p=join(root,'harness/state/recovery.sqlite');if(!existsSync(p))throw Error('RECOVERY_LEDGER_MISSING');const db=new DatabaseSync(p,{readOnly:true});try{return db.prepare("SELECT state,count(*) AS count FROM actions GROUP BY state ORDER BY state").all();}finally{db.close();}}
function writeJson(path,value){writeFileSync(path+'.tmp',JSON.stringify(value,null,2));renameSync(path+'.tmp',path);}
export async function runSnapshot(root=fileURLToPath(new URL('../',import.meta.url))){
  const control=new OperatorControl(join(root,'operator/state')),initial=control.status();
  const report={started:new Date().toISOString(),initialControl:safeView(initial),initialRecovery:recoverySummary(root),fleet:[],records:[],errors:[],complete:false};
  const directory=join(root,'Reports');mkdirSync(directory,{recursive:true});const stem='TodaySnapshot-'+alaskaStamp(new Date(report.started)),diagnostic=join(directory,stem+'.incomplete.json');
  let guard,operator,cdp,testingRevision,pausedRevision,result,failure;
  const oldPid=initial.owner?.pid;const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
  try{
    if(!['AUTOMATIC','PAUSED/MANUAL'].includes(initial.mode))throw Error('EXISTING_TESTING_SESSION');
    console.log(JSON.stringify({event:'SNAPSHOT_PAUSE_REQUEST',initial:report.initialControl}));
    const paused=control.request('PAUSED/MANUAL',{expectedRevision:initial.revision});pausedRevision=paused.revision;
    const until=Date.now()+180000;
    while(true){const s=control.status();if(s.mode!=='PAUSED/MANUAL'||s.revision!==pausedRevision)throw Error('OPERATOR_MODE_CHANGED');if(s.safeToUseGame&&!s.owner&&!s.action&&(!oldPid||!alive(oldPid)))break;if(Date.now()>until)throw Error('SAFE_HANDOFF_TIMEOUT');await sleep(250);}
    report.pausedControl=safeView(control.status());report.pausedRecovery=recoverySummary(root);
    guard=await acquireGuard(()=>cdp?.close());
    testingRevision=control.request('TESTING',{expectedRevision:pausedRevision}).revision;
    operator=new OperatorSession(join(root,'operator/state'),'TESTING');
    cdp=await Cdp.connect(17000,operator);
    const evaluate=async(expression,label)=>{operator.assertCanCommit();return cdp.evaluate(expression,label);};
    if((await evaluate(domExpression('browserAutomation'),'Snapshot browser automation inspection')).length)throw Error('BROWSER_AUTOMATION_ACTIVE');
    const source=readSource(root);
    report.fleet=validateFleet(await evaluate(source.blocks.fleetJs,'Snapshot entire current fleet'));
    report.enumeration=await evaluate(`(()=>{const lists=['landedList','parkedList','inflightList','pendingList'];return JSON.stringify({lists:lists.map(id=>({id,present:!!document.getElementById(id),count:document.querySelectorAll('#'+id+' .flight-list[data-reg]').length})),counters:[...document.querySelectorAll('#flightStatusInflight,#flightStatusLanded,#flightStatusParked,#flightStatusPending')].map(e=>({id:e.id,text:e.innerText}))});})()`,'Snapshot fleet enumeration evidence');
    console.log(JSON.stringify({event:'SNAPSHOT_FLEET_ENUMERATED',aircraft:report.fleet.length,enumeration:report.enumeration}));
    writeJson(diagnostic,report);
    for(const aircraft of report.fleet){
      const value=await evaluate(detailsExpression(aircraft),'Snapshot Details '+aircraft.registration);
      if(value.ok)report.records.push(value);else report.errors.push({aircraftId:aircraft.aircraftId,registration:aircraft.registration,reason:value.reason});
      writeJson(diagnostic,report);
      if((report.records.length+report.errors.length)%10===0)console.log(JSON.stringify({event:'SNAPSHOT_PROGRESS',inspected:report.records.length+report.errors.length,successful:report.records.length,errors:report.errors.length,total:report.fleet.length}));
    }
    const finalFleet=validateFleet(await evaluate(source.blocks.fleetJs,'Snapshot final membership reconciliation'));
    const key=a=>a.aircraftId+':'+a.registration;
    report.membershipChanged=JSON.stringify(report.fleet.map(key).sort())!==JSON.stringify(finalFleet.map(key).sort());
    report.finalFleetCount=finalFleet.length;report.finished=new Date().toISOString();
    if(report.errors.length||report.membershipChanged){report.incompleteExport=publishIncompleteSnapshot(directory,stem,report);throw Error('SNAPSHOT_INCOMPLETE');}
    result=publishSnapshot(directory,stem,report);report.complete=true;report.export=result;
    console.log(JSON.stringify({event:'SNAPSHOT_COMPLETE',...result}));
  }catch(error){failure=error;report.errors.push({reason:/^[A-Z0-9_]+$/.test(error.message)?error.message:'SNAPSHOT_OPERATION_FAILED'});}
  finally{
    cdp?.close();
    if(cdp){const until=Date.now()+6000;while(cdp.socket.readyState!==WebSocket.CLOSED&&Date.now()<until)await sleep(100);if(cdp.socket.readyState!==WebSocket.CLOSED){failure||=Error('CDP_CLOSE_NOT_CONFIRMED');report.errors.push({reason:'CDP_CLOSE_NOT_CONFIRMED'});}}
    operator?.close();guard?.release();
    let state=control.status();
    // A later operator pause/change always wins; an uncertain CDP outcome never auto-resumes.
    if(testingRevision!==undefined&&state.mode==='TESTING'&&state.revision===testingRevision&&!state.owner&&!state.action){
      if(restorationAllowed(initial,state,testingRevision)&&!report.errors.some(e=>e.reason==='CDP_CLOSE_NOT_CONFIRMED')){
        try{await preflight();control.request('AUTOMATIC',{expectedRevision:testingRevision});const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'Start-AM4.ps1')],{windowsHide:true,detached:true,stdio:'ignore'});child.on('error',()=>{});child.unref();
          const until=Date.now()+25000;while(Date.now()<until){state=control.status();if(state.mode!=='AUTOMATIC')throw Error('OPERATOR_MODE_CHANGED_DURING_RESTORE');if(state.owner?.role==='AUTOMATIC')break;await sleep(250);}if(!state.owner)throw Error('CONTROLLER_RESTORE_NOT_CONFIRMED');
        }catch(error){failure||=error;report.errors.push({reason:/^[A-Z0-9_]+$/.test(error.message)?error.message:'CONTROLLER_RESTORE_FAILED'});}
      }else {control.request('PAUSED/MANUAL',{expectedRevision:testingRevision});report.restorationRequestedBySnapshot=true;}
    }
    report.finalControl=safeView(control.status());report.finalRecovery=recoverySummary(root);report.restorationVerified=report.finalControl.mode===initial.mode&&(initial.mode!=='AUTOMATIC'||report.finalControl.owner?.role==='AUTOMATIC');
    if(!report.restorationVerified){failure||=Error('ORIGINAL_MODE_NOT_RESTORED');}
    writeJson(diagnostic,report);control.close();
  }
  if(failure)throw Object.assign(failure,{reportPath:diagnostic});
  return {result,finalControl:report.finalControl,reportPath:diagnostic};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.slice(2).join(' ')!=='--run'){
    console.log('Usage: node harness/snapshot-command.mjs --run\nRead-only fleet Details snapshot; requests a safe pause and restores the previous mode.');
  }else runSnapshot().then(r=>console.log(JSON.stringify({event:'SNAPSHOT_FINISHED',...r}))).catch(e=>{console.error(JSON.stringify({event:'SNAPSHOT_FAILED',reason:e.message,reportPath:e.reportPath}));process.exitCode=2;});
}
