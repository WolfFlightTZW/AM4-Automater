import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inspectProcesses,assertNoConflicts,concurrencyError} from './processes.mjs';
export {isControllerCommand,controllerProcesses} from './processes.mjs';
export async function acquireGuard(onLost = () => {}, {ignoreControllerPids=[]} = {}) {
  const inspect=async()=>assertNoConflicts(await inspectProcesses(),{ignoreControllerPids});
  const initial=await inspect();
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
  const guard={
    exclusionEvidence: {productionMutex:true,processAndCdpClientInspection:true,visibilityWarnings:initial.warnings,limitation:initial.limitation},
    async check() {
      try {
        const report=await inspect();
        if(host.exitCode!==null)throw concurrencyError('CONTROLLER_LOCK_HOST_EXITED',report);
        return report;
      } catch(error) {
        throw concurrencyError('CONTROLLER_EXCLUSION_LOST',error.processDiagnostics||{processes:[],inspectionErrors:[/^[A-Z0-9_]+$/.test(error.message)?error.message:'PROCESS_REVALIDATION_FAILED']});
      }
    },
    release() { if (!released) { released = true; host.stdin.end(); } }
  };
  // Re-enumerate after mutex acquisition; a competing client may have appeared while waiting.
  try{await guard.check();return guard;}catch(error){guard.release();throw error;}
}
