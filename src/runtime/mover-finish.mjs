import{brushCollisionBounds}from'./brush-bounds.mjs';
import{x87add,x87mul}from'./x87-nan.mjs';
const f=Math.fround;
// Core execVSize10138d10: (z*z+y*y)+x*x, double argument to appSqrt. The
// products and sums are x87 FMUL/FADDP, so a NaN component follows the x87
// NaN rules (x87-nan.mjs); the CRT sqrt thunk 0x101032ba (Sqrt's) returns a
// NaN operand quieted.
export const finishVectorSize=v=>{
 const s=x87add(x87add(x87mul(v[2],v[2]),x87mul(v[1],v[1])),x87mul(v[0],v[0]));
 return f(s!==s?s:Math.sqrt(s));
};
/** GetBoundingBox(false, explicit pose), UModel only. No actor/hash mutation. */
export function moverFinishBounds(model,owner,position,rotation){return brushCollisionBounds(model,{...owner,Location:position,Rotation:rotation});}
export function moverFinishContains(bounds,mover,pawn){
 const center=bounds.min.map((v,i)=>f(f(v+bounds.max[i])*.5)),area=bounds.max.map((v,i)=>f(v-center[i]));
 const maxDist=f(finishVectorSize(area)+200);
 if(!(finishVectorSize(pawn.position.map((v,i)=>f(v-mover.position[i])))<f(maxDist+pawn.radius)))return false;
 const d=center.map((v,i)=>Math.abs(f(v-pawn.position[i])));
 if(!(d[2]<f(area[2]+pawn.height)&&d[0]<f(area[0]+pawn.radius)&&d[1]<f(area[1]+pawn.radius)))return false;
 return !(d[0]>=area[0]&&d[1]>=area[1])||finishVectorSize([f(d[0]-area[0]),f(d[1]-area[1]),0])<mover.radius;
}
/** Level is a live linked PawnList; dispatch must run script bodies synchronously. */
export function finishMoverNotify(mover,level,{dispatch,getBoundingBox}){
 const clearGoal=p=>{if(p.specialGoal===mover||p.specialGoal===mover.marker)p.specialGoal=null;};
 if(mover.standingCount>0)for(let p=level.pawnList;p;p=p.nextPawn)if(p.base===mover){dispatch(p,'StopWaiting',[]);clearGoal(p);if(p===mover.waitingPawn)mover.waitingPawn=null;}
 if(mover.waitingPawn){dispatch(mover.waitingPawn,'StopWaiting',[]);if(!mover.waitingPawn)throw Error('StopWaiting changed WaitingPawn to None: unsupported script context');clearGoal(mover.waitingPawn);mover.waitingPawn=null;}
 if(mover.numKeys>0&&mover.encroachType===3){
  const position=mover.basePosition.map((v,i)=>f(v+mover.keyPositions[mover.key][i]));
  const rotation=mover.baseRotation.map((v,i)=>(v+mover.keyRotations[mover.key][i])|0);
  const bounds=getBoundingBox(mover,false,position,rotation);
  for(let p=level.pawnList;p;p=p.nextPawn)if(moverFinishContains(bounds,mover,p))dispatch(p,'EncroachedByMover',[mover]);
 }
}
