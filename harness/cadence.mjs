import {settings} from './settings.mjs';
export async function waitBetweenPasses({active,recovery=false,seconds=settings.cycleSeconds,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}) {
  const start=now(),delay=(recovery?Math.max(seconds,settings.recoveryBackoffSeconds):seconds)*1000;
  while(now()-start<delay){active();await sleep(Math.min(100,delay-(now()-start)));}
  active();
  return {idleMs:now()-start,idleReason:recovery?'TRANSACTION_RECOVERY_BACKOFF':'NORMAL_PASS_DELAY'};
}
