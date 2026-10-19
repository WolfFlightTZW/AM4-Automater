import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {win32} from 'node:path';
const exec=promisify(execFile);
export const validProcessInstance=p=>Number.isSafeInteger(p?.pid)&&p.pid>0&&typeof p.created==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{1,7}Z$/.test(p.created)&&Number.isFinite(Date.parse(p.created));
export function isControllerCommand(command) {
  const paths = [];
  const file = command.match(/(?:^|\s)-File\s+(?:"([^"]+)"|'([^']+)'|([^\s;]+))/i);
  if (file) paths.push(file[1] || file[2] || file[3]);
  for (const match of command.matchAll(/(?:^|[;\s"'])&\s*(?:"([^"]+)"|'([^']+)'|([^\s;]+))/g)) paths.push(match[1] || match[2] || match[3]);
  const direct = command.match(/(?:^|\s)-(?:Command|c)\s+(?:"|')?([^\s"';]+\.ps1)(?:\s|["']|$)/i);
  if (direct) paths.push(direct[1]);
  return paths.some(path => /^(?:Start-AM4|AM4-(?:Operations|Master-.*|Continuous-.*|Departure-Recovery.*|Single-Repair.*|N\d+-Single.*|Repair-Walkthrough.*))\.ps1$/i.test(win32.basename(path)));
}
// Values stay in memory. Routine diagnostics expose identity/errors, never command lines.
export async function inspectProcesses() {
  if(process.platform!=='win32')throw new Error('LIVE_REQUIRES_WINDOWS');
  const command="$ErrorActionPreference='Stop'; $identity=[Security.Principal.WindowsIdentity]::GetCurrent(); $principal=New-Object Security.Principal.WindowsPrincipal($identity); $items=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(powershell|pwsh)(\\.exe)?$' } | ForEach-Object { $created=$null; try { $created=$_.CreationDate.ToUniversalTime().ToString('o') } catch {} ; [pscustomobject]@{pid=$_.ProcessId;name=$_.Name;created=$created;commandLine=$_.CommandLine;executablePath=$_.ExecutablePath} }); [pscustomobject]@{elevated=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);processes=$items} | ConvertTo-Json -Depth 5 -Compress";
  let stdout;
  try{({stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:10000,maxBuffer:4*1024*1024}));}
  catch{throw Object.assign(new Error('PROCESS_INSPECTION_UNAVAILABLE'),{processDiagnostics:{inspectionErrors:['CIM_QUERY_FAILED_OR_TIMED_OUT'],processes:[]}});}
  let snapshot;try{snapshot=JSON.parse(stdout);}catch{throw new Error('PROCESS_INSPECTION_RESPONSE_INVALID');}
  if(typeof snapshot.elevated!=='boolean'||!Array.isArray(snapshot.processes))throw new Error('PROCESS_INSPECTION_RESPONSE_INVALID');
  return snapshot;
}
export function processBlockers(snapshot,{ignoreControllerPids=[]}={}) {
  return snapshot.processes.filter(p=>/^(powershell|pwsh)(\.exe)?$/i.test(p.name)&&!ignoreControllerPids.includes(p.pid)&&(!p.commandLine||!p.created||isControllerCommand(p.commandLine))).map(p=>({
    pid:p.pid,created:p.created,name:p.name,reason:p.commandLine&&isControllerCommand(p.commandLine)?'AM4_SCRIPT_RUNNING':'PROCESS_COMMAND_UNREADABLE',
    inspectionErrors:[...(!p.commandLine?['CIM_COMMAND_LINE_UNAVAILABLE']:[]),...(!p.executablePath?['CIM_EXECUTABLE_PATH_UNAVAILABLE']:[]),...(!p.created?['CIM_CREATION_TIME_UNAVAILABLE']:[])]
  }));
}
export async function controllerProcesses(){return processBlockers(await inspectProcesses());}
