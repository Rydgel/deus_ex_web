import {moverBlockedBy} from './check-encroachment.mjs';
const f=Math.fround;

/** Moving-brush MoveActor orchestration (Engine.dll 0x103990e0 with a brush
 * source). Callbacks must supply original ordered hash queries, full pawn
 * moveSmooth, the recovered based-rider MoveActor pass and synchronous script
 * effects. `rotation` is MoveActor's NewRotation (default: unchanged). This
 * ends at pose/hash commit; the caller handles later MoveActor effects.
 * Native captures (validate-native-mover-move): an unchanged rotation with
 * every |delta| < 0.0001 returns early; a changed rotation still runs
 * CheckEncroachment at the unchanged location; based riders (StandingCount)
 * move first (0x103998a0) before CheckEncroachment; the source's
 * bCollideWorld leaves the pawn push flow unchanged. */
export function moveTranslatingMover(mover,delta,{encroachmentCheck,moveSmooth,dispatch,removeActor,addActor,moveRiders,rotation=null}){
 if(!mover.movingBrush)throw Error('Unsupported moving-brush MoveActor source');
 if(mover.static || !mover.movable)return false;
 delta=delta.map(f);
 const newRotation=(rotation??mover.rotation).map(v=>v|0);
 const rotationChanged=newRotation.some((v,i)=>v!==(mover.rotation[i]|0));
 if(!rotationChanged&&delta.every(v=>Math.abs(v)<.0001))return true;
 if(mover.standingCount){
  if(typeof moveRiders!=='function')throw Error('Moving-brush MoveActor with based passengers requires the rider MoveActor pass');
  moveRiders(delta,newRotation);
 }
 const proposed=mover.position.map((v,i)=>f(f(v)+delta[i]));
 const hits=encroachmentCheck(mover,proposed,newRotation,0);
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
  // 0x1039a6f6-0x1039a773 writes only Location (+0x114) for the reverse push.
  const saved=[...mover.position];mover.position=[...proposed];
  try{moveSmooth(actor,pushedDelta.map(v=>f(-v)));}finally{mover.position=saved;}
  if(dispatch(mover,'EncroachingOn',[actor]))return false;
 }
 for(const actor of hits)if(blocking(actor))dispatch(actor,'EncroachedBy',[mover]);
 // The original branches on current bCollideActors at each hash operation.
 if(mover.collideActors)removeActor(mover);
 mover.position=mover.position.map((v,i)=>f(f(v)+delta[i]));
 mover.rotation=[...newRotation];
 if(mover.collideActors)addActor(mover);
 return true;
}
