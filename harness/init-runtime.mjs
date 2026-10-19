// Explicit offline bootstrap for a NEW installation, never a missing-ledger repair.
import {existsSync,mkdirSync,mkdtempSync,readdirSync,renameSync,rmdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from './store.mjs';
import {OperatorControl} from '../operator/control.mjs';

export function initializeRuntime(directory,{confirmNoExistingRecovery=false}={}) {
  if(!confirmNoExistingRecovery)throw new Error('EXPLICIT_NEW_INSTALLATION_CONFIRMATION_REQUIRED');
  const root=resolve(directory);
  for(const file of ['AM4-Operations.ps1','harness/production.mjs'])if(!existsSync(join(root,file)))throw new Error('PROJECT_SOURCE_REQUIRED');
  // Even empty existing state directories are not ours to replace. Reports/logs/backups
  // also indicate a previous installation whose missing ledger must be restored.
  for(const p of ['harness/state','operator/state','state','operator/backups'])if(existsSync(join(root,p)))throw new Error('EXISTING_RUNTIME_RESTORE_RECOVERY_INSTEAD');
  for(const p of ['reports','Reports','logs','archive'])if(existsSync(join(root,p))&&readdirSync(join(root,p)).length)throw new Error('EXISTING_INSTALLATION_EVIDENCE_REFUSE_INITIALIZATION');
  const staging=mkdtempSync(join(root,'.am4-init-'));
  const ledger=new Store(join(staging,'ledger'));
  try {
    ledger.db.prepare('INSERT INTO metadata VALUES(?,?)').run('migrationValidated','true');
    ledger.db.prepare('INSERT INTO metadata VALUES(?,?)').run('initialization','EXPLICIT_NEW_INSTALLATION_NO_PRIOR_RECOVERY');
    if(ledger.db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('INITIAL_LEDGER_INTEGRITY_FAILED');
  } finally {ledger.close();}
  const operatorPath=join(staging,'operator'),control=new OperatorControl(operatorPath);
  try{if(control.status().mode!=='PAUSED/MANUAL')throw new Error('INITIAL_MODE_NOT_MANUAL');}finally{control.close();}
  writeFileSync(join(operatorPath,'legacy-exclusion.json'),JSON.stringify({processes:[]},null,2)+'\n');
  const compatibilityPath=join(staging,'compatibility');mkdirSync(compatibilityPath);
  writeFileSync(join(compatibilityPath,'operations-state.json'),JSON.stringify({schema:1,transactions:{}},null,2)+'\n');
  for(const p of ['harness/state','operator/state','state'])if(existsSync(join(root,p)))throw new Error('RUNTIME_APPEARED_DURING_INITIALIZATION');
  renameSync(join(staging,'ledger'),join(root,'harness/state'));
  renameSync(operatorPath,join(root,'operator/state'));
  renameSync(compatibilityPath,join(root,'state'));
  rmdirSync(staging); // Only the now-empty directory created above; never recursive.
  return {initialized:true,mode:'PAUSED/MANUAL',gameConnected:false,transactions:0};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  if(args.length===1&&args[0]==='--help')console.log('NEW installation only: node harness/init-runtime.mjs --new-installation --confirm-no-existing-recovery. Never use this to replace lost runtime data.');
  else {
    try{
      if(args.length!==2||!args.includes('--new-installation')||!args.includes('--confirm-no-existing-recovery'))throw new Error('EXPLICIT_NEW_INSTALLATION_CONFIRMATION_REQUIRED');
      console.log(JSON.stringify(initializeRuntime(fileURLToPath(new URL('../',import.meta.url)),{confirmNoExistingRecovery:true})));
    }catch(error){console.error(/^[A-Z0-9_]+$/.test(error.message)?error.message:'NEW_INSTALLATION_FAILED_REVIEW_PARTIAL_STATE');process.exitCode=2;}
  }
}
