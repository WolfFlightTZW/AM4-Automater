// Read-only extractor for the observed native Company -> Show all achievement panel.
// The caller owns navigation/exclusive access; this function never clicks or connects.
export function readAchievementDom(doc=document){
  const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
  const root=doc.querySelector('#popContent'),summary=clean(root?.innerText).match(/^(\d+) achievements earned, out of (\d+)/i);
  if(!summary)return {ok:false,reason:'ACHIEVEMENT_PANEL_NOT_RECOGNIZED'};
  const achievements=[...root.querySelectorAll('img[src*="assets/img/achieve/"]')].map(img=>{
    const card=img.parentElement,detail=card.querySelector('.ach-list'),checked=Boolean(card.querySelector('.glyphicons-ok'));
    const name=clean(card.querySelector('b')?.textContent||[...card.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join(' '));
    const gameId=img.getAttribute('src').match(/\/(\d+)\.png$/)?.[1]||null;
    return {name,gameId,completionText:checked?'Completed':detail?'Not completed':'',rewardText:'',requirementText:clean(detail?.textContent),progressText:'',evidence:checked?'Native achievement completion checkmark; identifier from achievement icon asset':'Native achievement requirement panel; no completion checkmark; identifier from achievement icon asset'};
  });
  const identities=achievements.map(a=>a.gameId),completed=achievements.filter(a=>a.completionText==='Completed').length;
  const complete=achievements.length===Number(summary[2])&&completed===Number(summary[1])&&new Set(identities).size===identities.length&&achievements.every(a=>a.name&&a.gameId&&a.completionText);
  return {ok:true,version:1,source:'AM4_UI',collectedAt:new Date().toISOString(),complete,summary:{completed:Number(summary[1]),total:Number(summary[2]),extractedCompleted:completed},achievements};
}
