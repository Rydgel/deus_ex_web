import {safeNormal,twoWallAdjust} from './steps.mjs';
const f=Math.fround;

/** Original AActor.moveSmooth103c9020. moveActor commits full movement and
 * returns {result,time,normal,actor}; dispatch is direct script event dispatch. */
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
 hit=move(slide);
 if(f(hit.time)<1){
  const nextNormal=hit.normal.map(f),time=f(hit.time);
  dispatch(actor,'HitWall',[[...nextNormal],hit.actor]);
  slide=twoWallAdjust({desired,delta:slide,normal:nextNormal,oldNormal:normal,time});
  move(slide);
 }
 return result;
}
