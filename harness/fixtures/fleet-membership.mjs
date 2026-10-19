// Invented small fleet; no exported membership, live IDs, balances or routes.
export function membershipFixture(){
  const current=Array.from({length:6},(_,i)=>({registration:'N-TEST'+String(i+1).padStart(3,'0'),status:'landed',location:'landedList',grounded:'0'}));
  const details=current.map((a,i)=>({...a,aircraftId:'fixture-'+i,model:'SYNTHETIC',hours:1000+i,cycles:i<3?610+i*110:300+(i-3)*100,captured:'2020-01-01T00:00:00Z'}));
  const inactive=['OLDN-TEST001','OLDN-TEST002'].map((registration,i)=>({registration,aircraftId:'obsolete-fixture-'+i,cycles:900+i,captured:'2020-01-01T00:00:00Z'}));
  return {saved:{updated:'2020-01-01T00:00:00Z',aircraft:[...details,...inactive],excluded:[{registration:'PENDING-001',reason:'PENDING_DELIVERY',captured:'2020-01-01T00:00:00Z'}],errors:[]},fleet:[...current,{registration:'PENDING-001',status:'pending delivery'}]};
}
