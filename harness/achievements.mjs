// Pure read-only import/report functions. No game, CDP, control, purchase or claim dependency.
import {achievementCatalog,achievementSources} from './achievement-catalog.mjs';
const normalized=s=>s.trim().toLowerCase().replace(/[.#]/g,'').replace(/\s+/g,' ');
const text=(v,max=2000)=>typeof v==='string'&&v.length<=max?v.trim():null;
export function parseAchievementCapture(data){
  if(!data||data.version!==1||data.source!=='AM4_UI'||!Number.isFinite(Date.parse(data.collectedAt))||typeof data.complete!=='boolean'||!Array.isArray(data.achievements)||data.achievements.length>500)throw Error('INVALID_ACHIEVEMENT_CAPTURE');
  const names=new Map(),ids=new Set();
  return {collectedAt:data.collectedAt,complete:data.complete,source:'AM4_UI',achievements:data.achievements.map(raw=>{
    const name=text(raw.name,120),gameId=raw.gameId===null||raw.gameId===undefined?null:text(raw.gameId,120);
    const previous=name?names.get(normalized(name)):undefined;
    if(!name||(previous!==undefined&&(!previous||!gameId))||(gameId&&ids.has(gameId)))throw Error('AMBIGUOUS_ACHIEVEMENT_IDENTITY');names.set(normalized(name),gameId);if(gameId)ids.add(gameId);
    const fields=Object.fromEntries(['completionText','rewardText','requirementText','progressText','evidence'].map(k=>[k,text(raw[k])||'']));
    if(!fields.evidence)throw Error('ACHIEVEMENT_EVIDENCE_REQUIRED');
    const state=normalized(fields.completionText),completed=state==='completed'?true:['not completed','incomplete'].includes(state)?false:null;
    const match=fields.rewardText.match(/^([\d,]+)\s*(?:BP|bonus points?)$/i),reward=match?Number(match[1].replace(/,/g,'')):null;
    const verifiedBP=Number.isSafeInteger(reward)&&reward>=0?reward:null;
    return {name,gameId,completed,verifiedBP,requirement:fields.requirementText,progress:fields.progressText,raw:{name,gameId,...fields},source:'AM4_UI',collectedAt:data.collectedAt};
  })};
}
export function achievementInventory(capture=null){
  const actualRows=capture?.achievements||[],used=new Set(),inventory=[];
  for(const c of achievementCatalog){const matches=actualRows.filter(r=>normalized(r.name)===normalized(c.name));if(matches.length>1)continue;const actual=matches[0];if(actual)used.add(actual);inventory.push({...c,...actual,observed:Boolean(actual),source:actual?'AM4_UI':'COMMUNITY_CATALOG_ONLY',collectedAt:actual?.collectedAt??null});}
  for(const actual of actualRows.filter(r=>!used.has(r)))inventory.push({catalogId:null,category:'UNCLASSIFIED',communityBP:null,effort:'Needs review.',...actual,observed:true});
  return inventory;
}
export function achievementReport({capture=null,balance=null,target=null,now=Date.now()}={}){
  for(const value of [balance,target])if(value!==null&&(!Number.isSafeInteger(value)||value<0))throw Error('INVALID_BP_BALANCE_OR_TARGET');
  const inventory=achievementInventory(capture),gap=balance!==null&&target!==null?Math.max(0,target-balance):null;
  const priority={INTERFACE:1,MAP:1,ROUTE:2,AIRCRAFT_PURCHASE:3,MILESTONE:4,UNLOCK:5,UNCLASSIFIED:6};
  const ranked=inventory.filter(a=>a.completed!==true&&a.category!=='UNLOCK').map(a=>({...a,expectedBP:a.verifiedBP??a.communityBP,rewardBasis:a.verifiedBP!==null?'OBSERVED_AM4_REWARD':a.communityBP!==null?'UNVERIFIED_COMMUNITY_ESTIMATE':'UNKNOWN',eligibility:a.completed===false?'OBSERVED_UNCOMPLETED':'COMPLETION_UNKNOWN_CHECK_FIRST'})).sort((a,b)=>(priority[a.category]-priority[b.category])||((b.expectedBP??0)-(a.expectedBP??0))||a.name.localeCompare(b.name));
  let estimate=0;const provisionalPath=[];
  for(const a of ranked){if(gap!==null&&estimate>=gap)break;if(a.expectedBP===null||a.category==='AIRCRAFT_PURCHASE'||a.category==='MILESTONE')continue;estimate+=a.expectedBP;provisionalPath.push(a.catalogId);}
  return {at:new Date(now).toISOString(),mode:'READ_ONLY_NO_GAME_CONNECTION',personalInventory:capture?'CAPTURE_IMPORTED_NOT_LIVE_VERIFIED':'PENDING_OPERATOR_COLLECTION',captureComplete:capture?.complete??false,coverage:{curatedCatalog:achievementCatalog.length,observed:capture?.achievements.length??0,exhaustive:false},balanceReported:balance,targetReported:target,gap,inventory,ranked,provisionalPath:{catalogIds:provisionalPath,estimatedBP:estimate,sufficientEstimate:gap===null?null:estimate>=gap,observedUncompletedBP:ranked.filter(a=>a.completed===false&&a.verifiedBP!==null).reduce((n,a)=>n+a.verifiedBP,0),note:'Even observed rewards are opportunities, not guaranteed earnings. Unknown completion and community BP cannot establish a personal path; no action is executed.'},sources:achievementSources};
}
const safe=v=>String(v??'').replace(/[|\r\n]/g,' ');
export function renderAchievementReport(report){return [
 '# Read-only achievement / BP advisor',`Generated: ${report.at}`,`Personal inventory: ${report.personalInventory}; observed ${report.coverage.observed}; curated catalog ${report.coverage.curatedCatalog} (not exhaustive).`,
 `Reported balance: ${report.balanceReported??'unknown'}; target: ${report.targetReported??'unknown'}; gap: ${report.gap??'unknown'}.`,
 'No game connection or actions. Completion remains unknown unless explicitly imported from AM4. Community estimates are not verified rewards.',
 '','| Rank | Achievement | Category | Expected BP | Reward evidence | Completion | Effort / prerequisites |','|---|---|---|---|---|---|---|',
 ...report.ranked.map((a,i)=>`| ${i+1} | ${safe(a.name)} | ${a.category} | ${a.expectedBP??'unknown'} | ${a.rewardBasis} | ${a.completed===false?'Observed incomplete':'Unknown'} | ${safe(a.effort)} |`),
 '',`Provisional no-purchase / non-milestone candidates total ${report.provisionalPath.estimatedBP} BP if all are available and community values are correct. This is not a guaranteed path to the target.`,
 'Check free interface and map discoveries first, including Airbus near Toulouse. Then inspect current route opportunities. Do not acquire aircraft solely on these unverified estimates. Natural flight milestones may already be complete.',
 '','## Evidence inventory','```json',JSON.stringify(report.inventory,null,2),'```','','## Sources',...Object.values(report.sources).map(s=>`- [${s.quality}](${s.url})`),''].join('\n');}
