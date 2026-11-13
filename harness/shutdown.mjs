// Reporting only. Does not grant ownership, retry transactions or resume a worker.
export function classifyShutdown(error,state={}){
 const cause=error?.message||'NORMAL_SHUTDOWN',request=state.lastModeRequest;
 if(!error)return {category:'NORMAL_SHUTDOWN',cause,source:'CONTROLLER'};
 const ownership=/^OPERATOR_(?:OWNERSHIP_LOST|PAUSE_REQUESTED)$/.test(cause);
 if(ownership&&state.mode==='PAUSED/MANUAL'&&request?.kind==='REQUEST'&&request.mode==='PAUSED/MANUAL'){
   const category=request.source==='HUMAN_OPERATOR'?'HUMAN_OPERATOR_PAUSE':['DEPLOYMENT','AUTOMATION'].includes(request.source)?'AUTOMATION_OR_DEPLOYMENT_PAUSE':'OWNERSHIP_LOST';
   return {category,cause,source:request.source||'UNSPECIFIED',request};
 }
 return {category:ownership?'OWNERSHIP_LOST':'CONTROLLER_ERROR',cause,source:'CONTROLLER',ownershipLoss:state.lastOwnershipLoss||null};
}
