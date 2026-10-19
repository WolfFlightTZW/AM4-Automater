import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {controllerProcesses,validProcessInstance} from './processes.mjs';
export {isControllerCommand,controllerProcesses} from './processes.mjs';
export async function acquireGuard(onLost = () => {}, { passiveProbe = false, admitUnreadable,revalidateUnreadable,ignoreControllerPids=[] } = {}) {
  const blocking = (await controllerProcesses()).filter(p=>!ignoreControllerPids.includes(p.pid));
  // The no-click connectivity probe may read while holding the production mutex.
  // Unreadable processes still prohibit every action-capable harness session.
  const blocked=code=>Object.assign(new Error(code),{processDiagnostics:{processes:blocking,inspectionErrors:[],guidance:'Run AM4 Process Review.cmd; inspect in an administrator terminal before approving unrelated instances.'}});
  if (blocking.some(p => p.reason === 'AM4_SCRIPT_RUNNING')) throw blocked('CONTROLLER_OR_LEGACY_SCRIPT_RUNNING');
  const unknown = blocking.filter(p => p.reason === 'PROCESS_COMMAND_UNREADABLE');
  if(!passiveProbe&&unknown.some(p=>!validProcessInstance(p)))throw blocked('PROCESS_INSTANCE_IDENTITY_UNAVAILABLE');
  const attested = unknown.length && !passiveProbe ? Boolean(await admitUnreadable?.(unknown)) : false;
  if (unknown.length && !passiveProbe && !attested) throw blocked('UNREADABLE_PROCESSES_REQUIRE_OPERATOR_ATTESTATION');
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
      let current=[];
      try {
      current = (await controllerProcesses()).filter(p=>!ignoreControllerPids.includes(p.pid));
      const currentUnknown=current.filter(p=>p.reason==='PROCESS_COMMAND_UNREADABLE');
      const stillApproved=!currentUnknown.length||(revalidateUnreadable?await revalidateUnreadable(currentUnknown):attested);
      if (host.exitCode !== null || !stillApproved || current.some(p => p.reason === 'AM4_SCRIPT_RUNNING' || p.reason === 'PROCESS_COMMAND_UNREADABLE' && (!attested || !unknown.some(old => old.pid === p.pid&&old.created===p.created)))) throw Object.assign(new Error('CONTROLLER_EXCLUSION_LOST'),{processDiagnostics:{processes:current,inspectionErrors:[],guidance:'Repeat explicit process review. No new instance is automatically approved.'}});
      } catch(error) {
        if(error.message==='CONTROLLER_EXCLUSION_LOST')throw error;
        throw Object.assign(new Error('CONTROLLER_EXCLUSION_LOST'),{processDiagnostics:error.processDiagnostics||{processes:current,inspectionErrors:[/^[A-Z0-9_]+$/.test(error.message)?error.message:'PROCESS_REVALIDATION_FAILED']}});
      }
    },
    release() { if (!released) { released = true; host.stdin.end(); } }
  };
}
