import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {win32} from 'node:path';
const exec=promisify(execFile);
export const validProcessInstance=p=>Number.isSafeInteger(p?.pid)&&p.pid>0&&typeof p.created==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{1,7}Z$/.test(p.created)&&Number.isFinite(Date.parse(p.created));
export function isControllerCommand(command) {
  const paths = [];
  const file = command.match(/(?:^|\s)-F(?:ile)?\s+(?:"([^"]+)"|'([^']+)'|([^\s;]+))/i);
  if (file) paths.push(file[1] || file[2] || file[3]);
  for (const match of command.matchAll(/(?:^|[;\s"'])&\s*(?:"([^"]+)"|'([^']+)'|([^\s;]+))/g)) paths.push(match[1] || match[2] || match[3]);
  const direct = command.match(/(?:^|\s)-(?:Command|c)\s+(?:"|')?([^\s"';]+\.ps1)(?:\s|["']|$)/i);
  if (direct) paths.push(direct[1]);
  return paths.some(path => /^(?:Start-AM4|AM4-(?:Operations|Master-.*|Continuous-.*|Departure-Recovery.*|Single-Repair.*|N\d+-Single.*|Repair-Walkthrough.*))\.ps1$/i.test(win32.basename(path)));
}
function commandArguments(command){return [...String(command||'').matchAll(/"([^"]*)"|'([^']*)'|([^\s"']+)/g)].map(m=>m[1]??m[2]??m[3]);}
export function isNodeControllerCommand(command){
  const args=commandArguments(command);let index=1;
  while(index<args.length&&args[index].startsWith('-')){
    if(['-e','--eval','-p','--print','--test','--check','-c','--import','--require','-r'].includes(args[index].split('=')[0]))return false;
    index++;
  }
  const entry=(args[index]||'').replaceAll('\\','/');
  if(/(?:^|\/)harness\/production\.mjs$/i.test(entry))return true;
  if(!/(?:^|\/)harness\/main\.mjs$/i.test(entry))return false;
  const options=args.slice(index+1),scenario=options.indexOf('--scenario');
  return options.includes('--live')||(scenario>=0&&!['Offline','SelfTest','Inventory'].includes(options[scenario+1]));
}
const inactiveStates=new Set(['Listen','Bound','Closed','TimeWait']);
const loopback=address=>/^(?:127(?:\.\d{1,3}){3}|::1|::ffff:127(?:\.\d{1,3}){3})$/i.test(address||'');
export const VISIBILITY_LIMIT='Unreadable command lines do not prove a process is unrelated. Hidden idle legacy scripts and clients connecting after an observation cannot be completely excluded without privileged monitoring. Keep unsupported automation stopped.';
export function concurrencyError(code,report){return Object.assign(new Error(code),{processDiagnostics:report});}
// One bounded Windows inventory; never connect to CDP or persist command lines.
export async function inspectProcesses(){
  if(process.platform!=='win32')throw new Error('LIVE_REQUIRES_WINDOWS');
  const command=`$ErrorActionPreference='Stop'
try { $clients=@(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.RemotePort -eq 9222 -and $_.RemoteAddress -match '^(127\\.|::1$|::ffff:127\\.)' -and $_.State.ToString() -notin @('Listen','Bound','Closed','TimeWait') } | ForEach-Object { [pscustomobject]@{pid=$_.OwningProcess;remoteAddress=$_.RemoteAddress;remotePort=$_.RemotePort;state=$_.State.ToString()} }) } catch { [pscustomobject]@{error='CDP_CLIENT_INSPECTION_UNAVAILABLE'} | ConvertTo-Json -Compress; exit 2 }
try { $ownerIds=@($clients | ForEach-Object { $_.pid }); $items=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -match '^(powershell|pwsh|node)(\\.exe)?$' -or $_.ProcessId -in $ownerIds } | ForEach-Object { $created=$null; try { $created=$_.CreationDate.ToUniversalTime().ToString('o') } catch {}; [pscustomobject]@{pid=$_.ProcessId;parentPid=$_.ParentProcessId;name=$_.Name;sessionId=$_.SessionId;created=$created;commandLine=$_.CommandLine;executablePath=$_.ExecutablePath} }) } catch { [pscustomobject]@{error='PROCESS_INSPECTION_UNAVAILABLE'} | ConvertTo-Json -Compress; exit 2 }
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
[pscustomobject]@{elevated=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);processes=$items;connections=$clients;tcpInspectionComplete=$true} | ConvertTo-Json -Depth 5 -Compress`;
  let stdout;
  try{({stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:10000,maxBuffer:4*1024*1024}));}
  catch(error){let code='CONCURRENCY_INSPECTION_UNAVAILABLE';try{const returned=JSON.parse(error.stdout);if(['PROCESS_INSPECTION_UNAVAILABLE','CDP_CLIENT_INSPECTION_UNAVAILABLE'].includes(returned.error))code=returned.error;}catch{}throw concurrencyError(code,{processes:[],warnings:[],inspectionErrors:[code],limitation:VISIBILITY_LIMIT});}
  let snapshot;try{snapshot=JSON.parse(stdout);}catch{throw concurrencyError('PROCESS_INSPECTION_RESPONSE_INVALID',{processes:[],inspectionErrors:['INVALID_JSON']});}
  if(!Array.isArray(snapshot.processes)||!snapshot.processes.some(p=>p.pid===process.pid))throw concurrencyError('PROCESS_INSPECTION_RESPONSE_INVALID',{processes:[],inspectionErrors:['INSPECTING_PROCESS_MISSING']});
  return snapshot;
}
export function classifyConcurrency(snapshot,{ignoreControllerPids=[],selfPid=process.pid}={}){
  if(typeof snapshot?.elevated!=='boolean'||!Array.isArray(snapshot.processes)||!Array.isArray(snapshot.connections)||snapshot.tcpInspectionComplete!==true)throw concurrencyError('CONCURRENCY_INSPECTION_UNAVAILABLE',{processes:[],warnings:[],inspectionErrors:['INCOMPLETE_PROCESS_OR_TCP_INVENTORY'],limitation:VISIBILITY_LIMIT});
  if(snapshot.processes.some(p=>!Number.isSafeInteger(p.pid)||p.pid<0||typeof p.name!=='string')||snapshot.connections.some(c=>!Number.isSafeInteger(c.pid)||c.pid<0||!Number.isInteger(c.remotePort)||typeof c.remoteAddress!=='string'||typeof c.state!=='string'))throw concurrencyError('CONCURRENCY_INSPECTION_UNAVAILABLE',{processes:[],warnings:[],inspectionErrors:['INVALID_PROCESS_OR_TCP_IDENTITY'],limitation:VISIBILITY_LIMIT});
  const processes=[],warnings=[],byPid=new Map(snapshot.processes.map(p=>[p.pid,p]));
  const identity=p=>({pid:p.pid,created:p.created||null,name:p.name||null,parentPid:p.parentPid??null,inspectionErrors:[...(!p.commandLine?['CIM_COMMAND_LINE_UNAVAILABLE']:[]),...(!p.created?['CIM_CREATION_TIME_UNAVAILABLE']:[])]});
  for(const p of snapshot.processes){
    if(p.pid===selfPid||ignoreControllerPids.includes(p.pid))continue;
    if((/^(powershell|pwsh)(\.exe)?$/i.test(p.name)&&isControllerCommand(p.commandLine||''))||(/^node(\.exe)?$/i.test(p.name)&&isNodeControllerCommand(p.commandLine||'')))processes.push({...identity(p),reason:'AM4_AUTOMATION_PROCESS'});
    else if(!p.commandLine&&/^(powershell|pwsh|node)(\.exe)?$/i.test(p.name))warnings.push({...identity(p),reason:'OPAQUE_PROCESS_NO_AM4_EVIDENCE',blocking:false});
  }
  for(const c of snapshot.connections){
    if(c.remotePort!==9222||!loopback(c.remoteAddress)||inactiveStates.has(c.state)||c.pid===selfPid)continue;
    const resolved=c.pid>0&&byPid.has(c.pid),p=byPid.get(c.pid)||{pid:c.pid};
    processes.push({...identity(p),reason:resolved?'FOREIGN_CDP_CLIENT':'CDP_CLIENT_OWNER_UNRESOLVED',state:c.state,inspectionErrors:[...identity(p).inspectionErrors,...(!resolved?['CDP_OWNER_NOT_IN_PROCESS_SNAPSHOT']:[])]});
  }
  return {elevated:snapshot.elevated,processes,warnings,inspectionErrors:[],limitation:VISIBILITY_LIMIT};
}
export function assertNoConflicts(snapshot,options){
  const report=classifyConcurrency(snapshot,options);
  if(report.processes.length)throw concurrencyError(report.processes.some(p=>p.reason==='AM4_AUTOMATION_PROCESS')?'CONTROLLER_OR_LEGACY_SCRIPT_RUNNING':'FOREIGN_CDP_CLIENT_CONNECTED',report);
  return report;
}
export async function controllerProcesses(){return classifyConcurrency(await inspectProcesses()).processes;}
