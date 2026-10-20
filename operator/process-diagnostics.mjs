// Read-only diagnostics/preflight. No approval files, ownership or game calls.
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectProcesses,classifyConcurrency,assertNoConflicts} from '../harness/processes.mjs';
export async function preflight({inspect=inspectProcesses,...options}={}){return assertNoConflicts(await inspect(),options);}
export async function diagnostics({inspect=inspectProcesses,...options}={}){return classifyConcurrency(await inspect(),options);}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const command=process.argv[2]||'diagnose';if(!['diagnose','preflight'].includes(command))throw new Error('UNKNOWN_PROCESS_DIAGNOSTIC_COMMAND');const report=await(command==='preflight'?preflight():diagnostics());console.log(JSON.stringify({ok:true,...report},null,2));}
  catch(error){console.error(JSON.stringify({ok:false,error:/^[A-Z0-9_]+$/.test(error.message)?error.message:'CONCURRENCY_INSPECTION_UNAVAILABLE',processDiagnostics:error.processDiagnostics},null,2));process.exitCode=2;}
}
