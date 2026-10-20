// Session-local departure counter only: no airline snapshots or UI history are persisted.
export class FleetHeartbeat {
  constructor(){this.verifiedSinceDisplay=0;}
  async afterDeparture(action,{active,display,begin=()=>{},end=()=>{},now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
    if(action?.result!=='PASS'||action.state!=='DEPARTED_VERIFIED'||action.submitted!==true)return null;
    this.verifiedSinceDisplay++;
    if(this.verifiedSinceDisplay<16)return null;
    this.verifiedSinceDisplay-=16;
    active();begin();
    try{
      const shown=await display();active();
      if(!shown?.ok)return {result:'INCONCLUSIVE',reason:shown?.reason||'FLEET_DISPLAY_UNAVAILABLE',displayed:false};
      const start=now();
      while(now()-start<3000){active();await sleep(Math.min(100,3000-(now()-start)));}
      active();return {result:'PASS',displayed:true,displayMs:now()-start};
    }catch(error){
      // Ownership loss/disconnect must propagate through the normal safe-stop path.
      active();
      return {result:'INCONCLUSIVE',displayed:false,reason:/^[A-Z0-9_]+$/.test(error.message)?error.message:'FLEET_DISPLAY_FAILED'};
    }finally{try{end();}catch(error){active();throw error;}}
  }
}
