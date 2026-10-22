import {checkMoverEncroachment} from './check-encroachment.mjs';
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
 * bCollideWorld leaves the pawn push flow unchanged. `afterCommit(mover)` is
 * the rest of MoveActor after the commit (0x10399d17..0x10399f5f,
 * `moverMoveTail`); the oracle harness stops at 0x10399d17 without it. */
export function moveTranslatingMover(mover,delta,{encroachmentCheck,moveSmooth,dispatch,removeActor,addActor,moveRiders,rotation=null,afterCommit=null}){
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
 // CheckEncroachment(notify 0) for the brush source (check-encroachment.mjs):
 // the push, its re-query at the proposed pose and NewRotation, EncroachingOn
 // and EncroachedBy. Every blocking non-Brush hit is pushed through its own
 // moveSmooth (0x1039a577), Pawn or not; `moveSmooth` supplies that class's move.
 if(checkMoverEncroachment(mover,proposed,newRotation,0,{worldActor:mover.worldActor,encroachmentCheck,dispatch,moveSmooth}))return false;
 // The original branches on current bCollideActors at each hash operation.
 if(mover.collideActors)removeActor(mover);
 mover.position=mover.position.map((v,i)=>f(f(v)+delta[i]));
 mover.rotation=[...newRotation];
 if(mover.collideActors)addActor(mover);
 if(afterCommit)afterCommit(mover);
 return true;
}

/** What ULevel::MoveActor does after the pose and hash commit (0x10399d17..
 * 0x10399f5f) for a moving-brush source with Test 0: Hit.Actor is NULL and the
 * brush bypass at 0x1039943a skipped the touch list, so the only work is the
 * EndTouch pass over the source's four Touching slots (IsOverlapping is false
 * for a Brush, so every held touch ends: 0x10399ed2..0x10399f00, each slot
 * re-read at its turn) and `XLevel->SetActorZone(Actor, Test 0, 0)`
 * (level vtable +0xac, 0x10399f03). It runs for every MoveActor that reaches
 * the commit, a rotation-only one included (docs/rotating-brushes.md). */
export function moverMoveTail(mover,{isOverlapping,endTouch,setActorZone}){
 for(let slot=0;slot<4;slot++){
  const other=mover.touching[slot];
  if(other&&!isOverlapping(mover,other))endTouch(mover,other,false);
 }
 setActorZone(mover,false,false);
}
