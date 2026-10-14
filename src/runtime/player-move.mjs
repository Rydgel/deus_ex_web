import {moveQuery} from './move-query.mjs';
import {identityOf} from './actor-touch.mjs';
const f=Math.fround;
// IsBasedOn over AActor pointers: a pawn physics view compares as its host.
// Exported for the Rust pawn MoveActor's imports (move-pawn-kernel.mjs).
export function basedOn(actor,base){const seen=new Set();base=identityOf(base);for(let a=identityOf(actor);a;a=a.base){if(a===base)return true;if(seen.has(a))throw Error('Cyclic actor Base chain');seen.add(a);}return false;}

/** Original cylinder MoveActor with the recovered based-rider pass.
 * `newRotation` is the ULevel::MoveActor absolute rotation argument; callers
 * that move without rotating pass null and keep the source rotation. The
 * original's nearly-zero-delta path still applies the new rotation before
 * returning, without hash/touch/zone bookkeeping.
 * Geometry, hash, script, touching and zone callbacks are explicit boundaries. */
export function playerMove(source,delta,{worldActor,multiLineCheck,removeActor,addActor,dispatch,isBlockedBy,isOverlapping,beginTouch,endTouch,setActorZone,moveRiders,noFail,checkEncroachment,ignoreBases=false},newRotation=null){
 const requested=delta.map(f),rotation=newRotation?[...newRotation]:[...source.rotation];let hits=[];
 const query=moveQuery({source,worldActor,start:source.position,delta:requested,extent:[source.radius,source.radius,source.height],multiLineCheck:q=>(hits=multiLineCheck(q)),ignoreBases});
 // Both early returns leave the caller's Hit unwritten (0x10399145, 0x10399228): moveSmooth's second call keeps the first hit.
 if(source.static || source.movable===false)return {...query,hitUntouched:true};
 const tiny=requested.every(v=>Math.abs(v)<.0001);
 const sameRotation=rotation.every((v,i)=>v===source.rotation[i]);
 // 0x103991c8..0x10399240: tiny Delta only takes the short path when the
 // rotation is unchanged, or there are no riders/nonstatic brush. SetRotation
 // on a player carrying inventory has Delta=0 but must run the rider/commit
 // tail. Two original DLL cases are in docs/script-set-rotation.md.
 if(tiny&&(sameRotation||!source.standingCount)){source.rotation=rotation;return {...query,hitUntouched:true};}
 if(tiny&&requested.some(v=>v!==0))
  throw Error('MoveActor changed rotation with riders and nonzero sub-threshold Delta is not linked');
 const eligibleScanned=!!(source.flags&14)&&hits.some(h=>!basedOn(h.actor,source));
 // 0x103998a0-0x10399bb0: nonzero StandingCount walks Level.Actors and
 // recursively moves every based rider before this actor commits. bTest
 // moves never reach here (testMoveActor is a separate translation).
 if(source.standingCount){
  if(typeof moveRiders!=='function')throw Error('MoveActor based passengers require the recovered rider service');
  moveRiders(source,query.delta,rotation);
 }
 // 0x10399bb5-0x10399c8e: non-pawn, non-bNoFail movers must pass
 // CheckEncroachment(Location+FinalDelta, NewRotation, 0) before the commit.
 // The service is optional because decoration callers do not yet supply it;
 // spawned-actor moves (moveSpawnedActor) always do.
 if(!source.pawn&&!noFail&&typeof checkEncroachment==='function'&&
   checkEncroachment(source,source.position.map((v,i)=>f(f(v)+query.delta[i])),rotation,0))
  return {...query,success:false,position:[...source.position]};
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
