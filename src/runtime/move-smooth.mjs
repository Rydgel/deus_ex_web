import {safeNormal,twoWallAdjust} from './steps.mjs';
import {playerMove} from './player-move.mjs';
const f=Math.fround;

/** Original AActor.moveSmooth103c9020. moveActor commits full movement and
 * returns {result,time,normal,actor}; dispatch is direct script event dispatch.
 * `hitUntouched` marks a MoveActor that returned without writing its Hit
 * argument; moveSmooth then keeps the previous hit (see below). */
export function moveSmooth(actor,delta,{moveActor,dispatch}){
 delta=delta.map(f);
 const move=d=>moveActor(actor,d,[...actor.rotation],[0,0,0,0]);
 let hit=move(delta);const result=hit.result;
 if(f(hit.time)>=1)return result;
 const normal=hit.normal.map(f),dot=delta[2]*normal[2]+delta[1]*normal[1]+normal[0]*delta[0],remaining=1-f(hit.time);
 const x=(delta[0]-normal[0]*dot)*remaining;
 let slide=[f(x),f(f(delta[1]-f(normal[1]*dot))*remaining),f(f(delta[2]-f(normal[2]*dot))*remaining)];
 // X is stored but also retained in x87 for this progress test.
 if(delta[1]*slide[1]+delta[2]*slide[2]+x*delta[0]<0)return result;
 const desired=safeNormal(delta);
 // One FCheckResult serves both MoveActor calls. A MoveActor that returns
 // before it writes Hit (static or sub-threshold Delta: 0x10399145, 0x10399228)
 // leaves the first hit in place, so a zero slide still reports the wall
 // (HitWall, TwoWallAdjust) with the first call's Time, Normal and Actor.
 const second=move(slide);
 if(!second.hitUntouched)hit=second;
 if(f(hit.time)<1){
  const nextNormal=hit.normal.map(f),time=f(hit.time);
  dispatch(actor,'HitWall',[[...nextNormal],hit.actor]);
  slide=twoWallAdjust({desired,delta:slide,normal:nextNormal,oldNormal:normal,time});
  move(slide);
 }
 return result;
}

/** AActor::moveSmooth for a non-Pawn actor over its own recovered MoveActor
 * (player-move.mjs). CheckEncroachment pushes every blocking non-Brush hit
 * with this call (0x1039a577, 0x1039a75d) whatever its class: the native has
 * no Pawn test before it, so a decoration, carcass, pickup or fragment is
 * pushed the way a pawn is. `services` are playerMove's: hash, dispatch,
 * touch, zone and the pushed actor's own CheckEncroachment (a non-Pawn
 * source passes it before its commit). The current rotation is MoveActor's
 * NewRotation, as in moveSmooth. */
export function moveSmoothActor(actor,delta,services){
 return moveSmooth(actor,delta,{dispatch:services.dispatch,moveActor:(target,movement,rotation)=>{
  const r=playerMove(target,movement,services,rotation);
  return {result:r.success,time:r.time,normal:r.hit?.normal??[0,0,0],actor:r.hit?.actor??null,hitUntouched:Boolean(r.hitUntouched)};
 }});
}
