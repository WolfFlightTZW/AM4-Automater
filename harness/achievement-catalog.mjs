// Curated factual index, independently summarized. Local IDs are NOT AM4 achievement IDs.
export const achievementSources={
  guide:{url:'https://www.am4info.com/am4-achievements-guide',quality:'COMMUNITY_REQUIREMENTS_NOT_GAME_VERIFIED'},
  rewards:{url:'https://www.muleioleblogi.net/am4/',quality:'COMMUNITY_REWARDS_NOT_GAME_VERIFIED'},
  steam:{url:'https://steamcommunity.com/achievements/1641650',quality:'OFFICIAL_GLOBAL_LIST_NOT_PERSONAL_BP_EVIDENCE'},
  support:{url:'https://airlinemanager.zendesk.com/hc/en-us/articles/21732307647890-How-do-I-earn-points',quality:'OFFICIAL_POINTS_GUIDANCE_NOT_REWARD_TABLE'}
};
// No account observations or claims of completion. Check costs and prerequisites in AM4.
const rows=[
 ['airbus','Airbus','MAP',50,'Toulouse: Airbus factory map discovery.','Free map search; location may require zoom.'],
 ['map-operator','Map operator','INTERFACE',10,'Switch the map layer.','Free interface action.'],
 ['enlightened','Enlightened','INTERFACE',10,'Open the FAQ.','Free help navigation.'],
 ['just-a-click','Just a click','INTERFACE',25,'Find the small mail-window square.','Free search; placement may vary.'],
 ['ms-world-discoverer','MS World Discoverer','MAP',5,'Solomon Islands wreck discovery.','Free map search.'],
 ['no-4','No 4','MAP',5,'Chernobyl map discovery.','Free map search.'],
 ['titanic','Titanic','MAP',5,'Titanic wreck map discovery.','Free map search.'],
 ['california-tour','California tour','ROUTE',10,'KLAX / KSFO.','Route setup, suitable aircraft, operating costs.'],
 ['palm-domestic','Palm Domestic','ROUTE',10,'PHTO / PHNL.','Route setup, suitable aircraft, operating costs.'],
 ['rain-to-sun','Rain to Sun','ROUTE',10,'EGLL / LIRF.','Route setup, suitable aircraft, operating costs.'],
 ['top-route-1','Top route 1','ROUTE',10,'RKSS / RKPC.','Confirm direction, aircraft and route prerequisites.'],
 ['top-route-2','Top route 2','ROUTE',10,'YSSY / YMML.','Confirm direction, aircraft and route prerequisites.'],
 ['aircraft-expert','Aircraft expert','AIRCRAFT_PURCHASE',10,'Acquire an aircraft.','Costs funds; no automatic purchase.'],
 ['a380','A380','AIRCRAFT_PURCHASE',10,'Acquire an A380.','Large purchase; do not buy solely for uncertain BP.'],
 ['b747','B747','AIRCRAFT_PURCHASE',10,'Acquire a B747-8.','Large purchase; verify exact variant.'],
 ['dc-3','DC-3','AIRCRAFT_PURCHASE',10,'Operate a DC-3.','Aircraft acquisition and flight may be required.'],
 ['small','Small','MILESTONE',10,'100 flights.','Natural operations; read current progress.'],
 ['medium','Medium','MILESTONE',10,'1,000 flights.','Natural operations; read current progress.'],
 ['large','Large','MILESTONE',10,'10,000 flights.','Natural operations; read current progress.'],
 ['huge','Huge','MILESTONE',null,'100,000 flights.','Reward not established.'],
 ['cargo','Cargo','UNLOCK',null,'Unlock cargo.','Target unlock, not a source of guaranteed BP; verify cost in game.']
];
export const achievementCatalog=Object.freeze(rows.map(([catalogId,name,category,communityBP,requirement,effort])=>Object.freeze({catalogId,name,category,communityBP,requirement,effort,gameId:null,verifiedBP:null,completed:null,sources:communityBP===null?['guide']:['guide','rewards'],researchedAt:'2026-11-12',uncertainty:'Personal completion, reward and prerequisites require current AM4 evidence.'})));
