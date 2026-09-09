import {moveQuery} from './move-query.mjs';
const f=Math.fround;
function basedOn(actor,base){const seen=new Set();for(let a=actor;a;a=a.base){if(a===base)return true;if(seen.has(a))throw Error('Cyclic actor Base chain');seen.add(a);}return false;}

/** Ordinary original controlled-player MoveActor, unchanged rotation/no riders.
 * Geometry, hash, script, touching and zone callbacks are explicit boundaries. */
export function playerMove(source,delta,{worldActor,multiLineCheck,removeActor,addActor,dispatch,isBlockedBy,isOverlapping,beginTouch,endTouch,setActorZone}){
 if(source.standingCount)throw Error('Player MoveActor based passengers unsupported');
 const requested=delta.map(f),rotation=[...source.rotation];let hits=[];
 const query=moveQuery({source,worldActor,start:source.position,delta:requested,extent:[source.radius,source.radius,source.height],multiLineCheck:q=>(hits=multiLineCheck(q))});
 if(source.static || source.movable===false || requested.every(v=>Math.abs(v)<.0001))return query;
 const eligibleScanned=!!(source.flags&14)&&hits.some(h=>!basedOn(h.actor,source));
 if(source.flags&1)removeActor(source);
 source.position=source.position.map((v,i)=>f(f(v)+query.delta[i]));source.rotation=rotation;
 if(source.flags&1)addActor(source);
 const hit=query.hit;
 if(hit?.actor){
  if(hit.actor===worldActor)dispatch(source,'BumpWall',[[...hit.location],[...hit.normal]]);
  else if(!basedOn(source,hit.actor)){
   dispatch(hit.actor,'Bump',[source]);dispatch(source,'Bump',[hit.actor]);
  }
 }
 if(eligibleScanned || !(source.flags&4) || !(source.flags&8))for(const h of hits){
  if(!(f(h.time)<query.time))break;
  if(!basedOn(h.actor,source) && !isBlockedBy(source,h.actor))beginTouch(source,h.actor);
 }
 for(let i=0;i<4;i++){
  const other=source.touching[i];
  if(other && !isOverlapping(source,other))endTouch(source,other,false);
 }
 setActorZone(source,false,false);
 return {...query,position:[...source.position],success:query.time>0};
}
