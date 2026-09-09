import {moverBlockedBy} from './check-encroachment.mjs';
const f=Math.fround;

/** Bounded translation/encroachment orchestration. Callbacks must supply original
 * ordered hash queries, full pawn moveSmooth and synchronous script effects.
 * This ends at pose/hash commit; the caller handles later MoveActor effects. */
export function moveTranslatingMover(mover,delta,{encroachmentCheck,moveSmooth,dispatch,removeActor,addActor}){
 if(!mover.movingBrush || mover.collideWorld || mover.standingCount)throw Error('Unsupported mover class/world collision/based passengers');
 if(mover.static || !mover.movable)return false;
 delta=delta.map(f);
 if(delta.every(v=>Math.abs(v)<.0001))return true;
 const proposed=mover.position.map((v,i)=>f(f(v)+delta[i]));
 const hits=encroachmentCheck(mover,proposed,mover.rotation,0);
 const blocking=actor=>{
  if(actor===mover || actor.world)return false;
  return moverBlockedBy(mover,actor);
 };
 for(const actor of hits){
  if(!blocking(actor))continue;
  if(!actor.isPawn)throw Error('Unsupported blocking non-Pawn mover push');
  const pushedDelta=proposed.map((v,i)=>f(v-f(mover.position[i])));
  moveSmooth(actor,pushedDelta);
  if(!encroachmentCheck(mover,proposed,mover.rotation,0).includes(actor))continue;
  const saved=[...mover.position];mover.position=[...proposed];
  try{moveSmooth(actor,pushedDelta.map(v=>f(-v)));}finally{mover.position=saved;}
  if(dispatch(mover,'EncroachingOn',[actor]))return false;
 }
 for(const actor of hits)if(blocking(actor))dispatch(actor,'EncroachedBy',[mover]);
 // The original branches on current bCollideActors at each hash operation.
 if(mover.collideActors)removeActor(mover);
 mover.position=mover.position.map((v,i)=>f(f(v)+delta[i]));
 if(mover.collideActors)addActor(mover);
 return true;
}
