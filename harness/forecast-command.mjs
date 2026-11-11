// Standalone public HTTP retrieval + existing local report only. Never connects to CDP.
import {readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ForecastMonitor} from './forecast-monitor.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url))),directory=join(root,'Reports');
if(process.argv.includes('--watch')){
  const {runForecastConsole}=await import('./forecast-console.mjs');
  await runForecastConsole({directory:join(directory,'forecast-standalone'),args:process.argv.slice(2)});
}else{
const monitor=new ForecastMonitor({directory});await monitor.initialize();
let report;try{report=JSON.parse(await readFile(join(directory,'operations-latest.json'),'utf8'));}catch{}
// Existing pass observations are labeled with their age; never count them as newly observed prices.
const markets=report?.endingMarkets||report?.markets,stamp=Date.parse(report?.finished||report?.started);
if(markets)for(const kind of ['fuel','co2'])if(markets[kind]){monitor.markets[kind]=markets[kind];monitor.observedAt[kind]=stamp;}
const resourceBlockedCandidates=report?.held?.filter(h=>h.reasons?.includes('DISPATCH_RESOURCE_GATE')&&h.reasons.every(r=>['DISPATCH_RESOURCE_GATE','FLIGHT_DURATION_UNKNOWN'].includes(r))).length;
monitor.context={candidateCount:report?.batch?.candidateCount??null,resourceBlockedCandidates:resourceBlockedCandidates??null};
monitor.tick();await monitor.flush();console.log(JSON.stringify(monitor.plan(),null,2));

}
