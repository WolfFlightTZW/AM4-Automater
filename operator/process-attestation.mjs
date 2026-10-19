// Local operator evidence only. No CDP, operator ownership, recovery ledger or game calls.
import {readFileSync,writeFileSync,renameSync,existsSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {inspectProcesses,processBlockers,isControllerCommand,validProcessInstance} from '../harness/processes.mjs';

export const REVIEW_MS=10*60*1000, APPROVAL_MS=24*60*60*1000;
const read=path=>JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));
const validInstance=validProcessInstance;
const same=(a,b)=>a.pid===b.pid&&a.created===b.created;
const fingerprint=p=>createHash('sha256').update(JSON.stringify([p.name,p.executablePath,p.commandLine])).digest('hex');
function fault(code,processes=[],inspectionErrors=[]){return Object.assign(new Error(code),{processDiagnostics:{processes,inspectionErrors,guidance:'Run AM4 Process Review.cmd. Inspect in an administrator terminal; never approve unidentified processes.'}});}
function atomic(path,value){const temp=path+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});try{renameSync(temp,path);}finally{if(existsSync(temp))unlinkSync(temp);}}
export function loadApprovals(root){try{const document=read(join(root,'legacy-exclusion.json'));if(!document||!Array.isArray(document.processes))throw new Error('INVALID');return document;}catch(e){if(e.code==='ENOENT')return {schema:2,processes:[]};throw fault('PROCESS_APPROVAL_FILE_INVALID');}}
export function approvalsValid(document,unknown,now=Date.now()) {
  if(!unknown.length)return true;
  if(document?.schema!==2||!Array.isArray(document.processes))return false;
  if(document.processes.some((p,i,all)=>!validInstance(p)||p.verification!=='ELEVATED_OPERATOR_REVIEW'||!/^[a-f0-9]{64}$/.test(p.identityHash||'')||!Number.isFinite(Date.parse(p.reviewedAt))||!Number.isFinite(Date.parse(p.expiresAt))||Date.parse(p.reviewedAt)>now||Date.parse(p.expiresAt)<=now||Date.parse(p.expiresAt)-Date.parse(p.reviewedAt)>APPROVAL_MS||Date.parse(p.expiresAt)<=Date.parse(p.reviewedAt)||all.some((a,j)=>j!==i&&a.pid===p.pid)))return false;
  return unknown.every(p=>validInstance(p)&&document.processes.some(a=>same(a,p)));
}
export function assertApproved(snapshot,document,{ignoreControllerPids=[],now=Date.now()}={}) {
  const blockers=processBlockers(snapshot,{ignoreControllerPids});
  if(blockers.some(p=>p.reason==='AM4_SCRIPT_RUNNING'))throw fault('CONTROLLER_OR_LEGACY_SCRIPT_RUNNING',blockers);
  if(!approvalsValid(document,blockers,now))throw fault('UNREADABLE_PROCESSES_REQUIRE_OPERATOR_ATTESTATION',blockers);
  // When the provider can read a reviewed instance, changed command/executable identity revokes its approval.
  for(const p of snapshot.processes){const approved=document?.processes?.find(a=>same(a,p));if(approved&&p.commandLine&&p.executablePath&&approved.identityHash!==fingerprint(p))throw fault('PROCESS_REVIEW_IDENTITY_CHANGED',[{pid:p.pid,created:p.created,inspectionErrors:['REVIEWED_COMMAND_OR_EXECUTABLE_CHANGED']}]);}
  return blockers;
}
export async function preflight(root,{inspect=inspectProcesses,ignoreControllerPids=[]}={}){const snapshot=await inspect();let document;try{document=loadApprovals(root);}catch(error){if(error.processDiagnostics)error.processDiagnostics.processes=processBlockers(snapshot,{ignoreControllerPids});throw error;}return assertApproved(snapshot,document,{ignoreControllerPids});}
export async function prepareReview(root,{inspect=inspectProcesses,now=Date.now()}={}) {
  const snapshot=await inspect(),blockers=processBlockers(snapshot);
  if(snapshot.elevated)throw fault('PREPARE_REVIEW_FROM_NORMAL_NONADMIN_SESSION');
  if(blockers.some(p=>p.reason==='AM4_SCRIPT_RUNNING'))throw fault('CONTROLLER_OR_LEGACY_SCRIPT_RUNNING',blockers);
  if(!blockers.length)return {result:'NO_UNREADABLE_PROCESSES',processes:[]};
  if(blockers.some(p=>!validInstance(p)))throw fault('PROCESS_INSTANCE_IDENTITY_UNAVAILABLE',blockers);
  const request={schema:1,id:randomUUID(),createdAt:new Date(now).toISOString(),expiresAt:new Date(now+REVIEW_MS).toISOString(),processes:blockers};
  atomic(join(root,'process-review-request.json'),request);
  return {result:'ELEVATED_REVIEW_REQUIRED',...request};
}
function verifyRequest(request,now){if(request?.schema!==1||!/^[a-f0-9-]{36}$/.test(request.id||'')||!Array.isArray(request.processes)||!request.processes.length||request.processes.some((p,i,all)=>!validInstance(p)||all.some((a,j)=>j!==i&&a.pid===p.pid))||!Number.isFinite(Date.parse(request.createdAt))||Date.parse(request.createdAt)>now||!Number.isFinite(Date.parse(request.expiresAt))||Date.parse(request.expiresAt)<=now||Date.parse(request.expiresAt)<=Date.parse(request.createdAt)||Date.parse(request.expiresAt)-Date.parse(request.createdAt)>REVIEW_MS)throw fault('PROCESS_REVIEW_REQUEST_STALE_OR_INVALID');}
function reviewedInstances(snapshot,request){
  if(!snapshot.elevated)throw fault('ELEVATED_PROCESS_INSPECTION_REQUIRED');
  if(processBlockers(snapshot).some(p=>p.reason==='AM4_SCRIPT_RUNNING'))throw fault('CONTROLLER_OR_LEGACY_SCRIPT_RUNNING',processBlockers(snapshot));
  return request.processes.map(expected=>{
    const current=snapshot.processes.find(p=>same(p,expected));
    if(!current)throw fault('PROCESS_TERMINATED_OR_INSTANCE_CHANGED',[expected]);
    if(!current.commandLine||!current.executablePath)throw fault('ELEVATED_PROCESS_IDENTITY_UNREADABLE',[{pid:current.pid,created:current.created,inspectionErrors:['CIM_COMMAND_OR_EXECUTABLE_UNAVAILABLE_EVEN_WHEN_ELEVATED']}]);
    const encoded=[...current.commandLine.matchAll(/(?:^|\s)-([a-z]+)(?=\s|$)/gi)].some(m=>'encodedcommand'.startsWith(m[1].toLowerCase())||m[1].toLowerCase()==='ec');
    if(isControllerCommand(current.commandLine)||encoded)throw fault('PROCESS_IDENTITY_REQUIRES_MANUAL_INVESTIGATION',[expected]);
    return {...current,identityHash:fingerprint(current)};
  });
}
export async function reviewProcesses(root,{inspect=inspectProcesses,confirm,clock=Date.now}={}) {
  const request=read(join(root,'process-review-request.json'));verifyRequest(request,clock());
  const initial=reviewedInstances(await inspect(),request);
  for(const p of initial)if(await confirm?.(p)!==`UNRELATED ${p.pid}`)throw fault('PROCESS_REVIEW_CANCELLED');
  verifyRequest(request,clock());
  const fresh=reviewedInstances(await inspect(),request);
  if(fresh.some((p,i)=>p.identityHash!==initial[i].identityHash))throw fault('PROCESS_REVIEW_IDENTITY_CHANGED');
  // Reject a concurrent replacement of the pending review, including cross-console races.
  if(read(join(root,'process-review-request.json')).id!==request.id)throw fault('PROCESS_REVIEW_REQUEST_CHANGED');
  verifyRequest(request,clock());
  const now=clock(),approval={schema:2,processes:fresh.map(p=>({pid:p.pid,created:p.created,identityHash:p.identityHash,verification:'ELEVATED_OPERATOR_REVIEW',reviewedAt:new Date(now).toISOString(),expiresAt:new Date(now+APPROVAL_MS).toISOString()}))};
  atomic(join(root,'legacy-exclusion.json'),approval);
  return {result:'APPROVED_NOT_RESUMED',processes:approval.processes};
}
export async function diagnostics(root,{inspect=inspectProcesses}={}) {
  const snapshot=await inspect(),processes=processBlockers(snapshot),errors=[];let document;
  try{document=loadApprovals(root);}catch{document={schema:2,processes:[]};errors.push('PROCESS_APPROVAL_FILE_INVALID');}
  return {elevated:snapshot.elevated,processes:processes.map(p=>({...p,approved:p.reason!=='AM4_SCRIPT_RUNNING'&&approvalsValid(document,[p])})),approvalValid:!errors.length&&!processes.some(p=>p.reason==='AM4_SCRIPT_RUNNING')&&approvalsValid(document,processes),inspectionErrors:[...errors,...(processes.length?['CIM may hide elevated-process command lines from a standard-user inspection.']:[])]};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=fileURLToPath(new URL('./state/',import.meta.url));
  try{
    const command=process.argv[2]||'diagnose';let result;
    if(command==='diagnose')result=await diagnostics(root);
    else if(command==='prepare')result=await prepareReview(root);
    else if(command==='preflight')result={result:'PROCESS_PREFLIGHT_PASSED',processes:await preflight(root)};
    else if(command==='review'){
      const prompt=createInterface({input:process.stdin,output:process.stdout});
      try{result=await reviewProcesses(root,{confirm:async p=>{console.log(`\nPID: ${p.pid}\nCreated (exact UTC identity): ${p.created}\nExecutable: ${p.executablePath}\nCommand: ${p.commandLine}\nVerify the actual purpose of this process. Do not approve AM4 automation or anything you cannot identify.`);return prompt.question(`Type UNRELATED ${p.pid} to approve this exact instance, or Enter to cancel: `,{signal:AbortSignal.timeout(REVIEW_MS)});}});}finally{prompt.close();}
    }else throw new Error('UNKNOWN_PROCESS_REVIEW_COMMAND');
    console.log(JSON.stringify({ok:true,...result},null,2));
  }catch(error){console.error(JSON.stringify({ok:false,error:/^[A-Z0-9_]+$/.test(error.message)?error.message:'PROCESS_REVIEW_FAILED',processDiagnostics:error.processDiagnostics},null,2));process.exitCode=2;}
}
