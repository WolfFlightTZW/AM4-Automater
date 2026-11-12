import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';import {resolve,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
import {parseAchievementCapture,achievementReport,renderAchievementReport} from './achievements.mjs';
export async function runAdvisor(args=process.argv.slice(2)){
  const options={};for(let i=0;i<args.length;i+=2){if(!['--capture','--balance','--target','--output'].includes(args[i])||!args[i+1]||options[args[i]]!==undefined)throw Error('INVALID_ADVISOR_ARGUMENT');options[args[i]]=args[i+1];}
  let capture=null;if(options['--capture']){const raw=await readFile(options['--capture'],'utf8');if(raw.length>2000000)throw Error('CAPTURE_TOO_LARGE');capture=parseAchievementCapture(JSON.parse(raw));}
  const report=achievementReport({capture,balance:options['--balance']===undefined?null:Number(options['--balance']),target:options['--target']===undefined?null:Number(options['--target'])});
  const directory=resolve(options['--output']||fileURLToPath(new URL('../Reports/',import.meta.url)));await mkdir(directory,{recursive:true});
  const name='achievement-advisor-'+report.at.replace(/[:.]/g,'-');
  for(const [ext,body] of [['json',JSON.stringify(report,null,2)],['md',renderAchievementReport(report)]]){const file=resolve(directory,name+'.'+ext);await writeFile(file+'.tmp',body);await rename(file+'.tmp',file);}
  console.log(JSON.stringify({report:resolve(directory,name+'.md'),inventory:report.personalInventory,observed:report.coverage.observed,catalog:report.coverage.curatedCatalog}));return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))runAdvisor().catch(e=>{console.error(e.message);process.exitCode=1;});
