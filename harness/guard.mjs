import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { win32 } from 'node:path';
const exec = promisify(execFile);
export function isControllerCommand(command) {
  const paths = [];
  const file = command.match(/(?:^|\s)-File\s+(?:"([^"]+)"|'([^']+)'|([^\s;]+))/i);
  if (file) paths.push(file[1] || file[2] || file[3]);
  for (const match of command.matchAll(/(?:^|[;\s"'])&\s*(?:"([^"]+)"|'([^']+)'|([^\s;]+))/g)) paths.push(match[1] || match[2] || match[3]);
  const direct = command.match(/(?:^|\s)-(?:Command|c)\s+(?:"|')?([^\s"';]+\.ps1)(?:\s|["']|$)/i);
  if (direct) paths.push(direct[1]);
  return paths.some(path => /^(?:Start-AM4|AM4-(?:Operations|Master-.*|Continuous-.*|Departure-Recovery.*|Single-Repair.*|N\d+-Single.*|Repair-Walkthrough.*))\.ps1$/i.test(win32.basename(path)));
}
export async function controllerProcesses() {
  if (process.platform !== 'win32') throw new Error('LIVE_REQUIRES_WINDOWS');
  const command = "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(powershell|pwsh)(\\.exe)?$' } | Select-Object ProcessId,CommandLine,@{n='Created';e={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress";
  let stdout;
  try { ({ stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 10000 })); }
  catch { throw new Error('PROCESS_INSPECTION_UNAVAILABLE'); }
  const entries = JSON.parse(stdout || '[]');
  return (Array.isArray(entries) ? entries : [entries]).filter(p => !p.CommandLine || isControllerCommand(p.CommandLine))
    .map(p => ({ pid: p.ProcessId, created:p.Created, reason: p.CommandLine ? 'AM4_SCRIPT_RUNNING' : 'PROCESS_COMMAND_UNREADABLE' }));
}
export async function acquireGuard(onLost = () => {}, { passiveProbe = false, admitUnreadable,ignoreControllerPids=[] } = {}) {
  const blocking = (await controllerProcesses()).filter(p=>!ignoreControllerPids.includes(p.pid));
  // The no-click connectivity probe may read while holding the production mutex.
  // Unreadable processes still prohibit every action-capable harness session.
  if (blocking.some(p => p.reason === 'AM4_SCRIPT_RUNNING')) throw new Error('CONTROLLER_OR_LEGACY_SCRIPT_RUNNING');
  const unknown = blocking.filter(p => p.reason === 'PROCESS_COMMAND_UNREADABLE');
  const attested = unknown.length && !passiveProbe ? Boolean(await admitUnreadable?.(unknown)) : false;
  if (unknown.length && !passiveProbe && !attested) throw new Error('UNREADABLE_PROCESSES_REQUIRE_OPERATOR_ATTESTATION');
  const host = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./Lock-Session.ps1', import.meta.url))], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let released = false;
  host.stdin.on('error', () => { if (!released) onLost(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { host.kill(); reject(new Error('LOCK_TIMEOUT')); }, 10000);
    host.stdout.once('data', bytes => { clearTimeout(timer); if (String(bytes).trim() === 'READY') resolve(); else { host.stdin.end(); reject(new Error('CONTROLLER_LOCK_BUSY')); } });
    host.once('error', () => { clearTimeout(timer); reject(new Error('LOCK_HOST_FAILED')); });
    host.once('exit', () => { clearTimeout(timer); reject(new Error('LOCK_HOST_EXITED')); });
  });
  host.on('exit', () => { if (!released) onLost(); });
  return {
    unreadableProcesses: blocking.filter(p => p.reason === 'PROCESS_COMMAND_UNREADABLE').length,
    exclusionEvidence: { productionMutex: true, unreadableProcessIds: unknown.map(p => p.pid), operatorAttested: attested, passiveProbe },
    async check() {
      const current = (await controllerProcesses()).filter(p=>!ignoreControllerPids.includes(p.pid));
      if (host.exitCode !== null || current.some(p => p.reason === 'AM4_SCRIPT_RUNNING' || p.reason === 'PROCESS_COMMAND_UNREADABLE' && (!attested || !unknown.some(old => old.pid === p.pid&&old.created===p.created)))) throw new Error('CONTROLLER_EXCLUSION_LOST');
    },
    release() { if (!released) { released = true; host.stdin.end(); } }
  };
}
