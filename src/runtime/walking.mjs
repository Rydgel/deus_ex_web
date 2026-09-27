import {groundVelocity} from './velocity.mjs';
import {safeNormal,stepUp} from './steps.mjs';
const f=Math.fround,add=(a,b)=>a.map((v,i)=>f(v+b[i])),sub=(a,b)=>a.map((v,i)=>f(v-b[i])),scale=(a,s)=>a.map(v=>f(v*s)),dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const sloped=h=>h.time<1&&h.normal[2]>.01&&h.normal[2]<.7;
/** Original APawn.physWalking ordinary dry Player path. See docs/walking.md. */
export function walking(pawn,seconds,iterations=0){
 const dt=f(seconds);if(!(dt>0)||dt>f(.4))throw Error('Walking requires timestep in (0,0.4]');
 if(pawn.walkingPrelude(dt,iterations))return;
 pawn.velocity=pawn.velocity.map(f);pawn.acceleration=pawn.acceleration.map(f);pawn.position=pawn.position.map(f);
 // Script-backed FVector reads are values. Commit native component stores
 // through the setter instead of changing only a temporary returned array.
 pawn.acceleration=[pawn.acceleration[0],pawn.acceleration[1],0];
 pawn.velocity=[pawn.velocity[0],pawn.velocity[1],0];
 Object.assign(pawn,groundVelocity({velocity:pawn.velocity,acceleration:pawn.acceleration,direction:safeNormal(pawn.acceleration),dt,maxSpeed:pawn.groundSpeed,accelRate:pawn.accelRate,friction:pawn.friction,walking:pawn.isWalking}));
 const desired=add(pawn.velocity,scale(scale(pawn.zoneVelocity,25),dt));desired[2]=0;
 const gravity=[0,0,pawn.gravity[2]>0?1:-1],floorDelta=scale(gravity,f(f(pawn.maxStepHeight)+2)),extent=[f(pawn.radius),f(pawn.radius),f(pawn.height)];
 const old=[...pawn.position];pawn.oldLocation=[...old];pawn.justTeleported=false;
 let remaining=dt,mayFallCalled=false;
 const query=(s,e,ext,flags)=>pawn.lineCheck(s,e,ext,flags,0);
 while(remaining>0&&iterations<8){
  iterations++;const step=remaining>.05?f(Math.min(remaining*.5,f(.05))):remaining;remaining=f(remaining-step);
  let delta=scale(desired,step);const originalDelta=[...delta],origin=[...pawn.position];
  const stopped=delta.every(v=>Math.abs(v)<.0001);
  if(stopped){remaining=0;pawn.hitSlopedWall=false;}
  else {
   const usedSlope=pawn.hitSlopedWall;
   if(usedSlope){
    const size=Math.sqrt(dot(delta,delta)),direction=scale(delta,1/size);
    let h=query(pawn.position,add(pawn.position,scale(direction,Math.max(size+4,30))),extent,6);
    pawn.hitSlopedWall=sloped(h);
    if(pawn.hitSlopedWall){const n=safeNormal([h.normal[0],h.normal[1],0]);delta=sub(delta,scale(n,dot(n,delta)));}
    else {
     const start=[pawn.position[0],pawn.position[1],f(pawn.position[2]-extent[2]+f(pawn.maxStepHeight)+4)];
     const dirs=[direction,safeNormal([f(direction[0]+direction[1]),f(direction[1]-direction[0]),direction[2]]),safeNormal([f(direction[0]-direction[1]),f(direction[0]+direction[1]),direction[2]])];
     for(const dir of dirs){h=query(start,add(start,scale(dir,100)),[0,0,0],6);pawn.hitSlopedWall=sloped(h);if(pawn.hitSlopedWall)break;}
    }
   }
   let hit=pawn.move(delta);
   if(!usedSlope)pawn.hitSlopedWall=sloped(hit);
   if(hit.time<1){
    hit=stepUp(pawn,gravity,safeNormal(delta),scale(delta,f(1-hit.time)));
    if(pawn.physics===2){
     remaining=f(remaining+step*(1-Math.min(1,Math.hypot(pawn.position[0]-origin[0],pawn.position[1]-origin[1])/f(Math.sqrt(dot(originalDelta,originalDelta))))));
     pawn.fallingEvent();if(pawn.physics===2&&remaining>.01)pawn.falling(remaining,iterations);return;
    }
   }
   if(pawn.physics!==1)throw Error('Walking entered unsupported non-dry physics');
  }
  if(stopped){
   const start=[pawn.position[0],pawn.position[1],f(pawn.position[2]-extent[2])];
   const h=query(start,[start[0],start[1],f(pawn.position[2]-extent[2]-20)],[0,0,0],6),distance=h.time*20;
   if(h.actor===pawn.base&&distance>=4.1&&distance<=4.6)continue;
  }
  let hit=query(pawn.position,add(pawn.position,floorDelta),extent,0x17);
  const distance=f((f(pawn.maxStepHeight)+2)*hit.time);
  if(hit.time<1&&(hit.actor!==pawn.base||distance>2.4)){
   hit=pawn.move(floorDelta);if(hit.actor!==pawn.base)pawn.setSupportBase(hit.actor);
  }else if(distance<1.9){const normal=[...hit.normal];hit=pawn.move([0,0,f(2.1-distance)]);hit={...hit,time:0,normal};}
  if(hit.time<1&&hit.normal[2]>=.7){
   if(hit.normal[2]<1&&hit.normal[2]*f(pawn.friction)<3.3){
    const g=scale(scale(scale(pawn.gravity,dt),1/(2*Math.max(f(pawn.friction),.5))),dt),into=dot(g,hit.normal);
    const slide=sub(g,scale(hit.normal,into));if(dot(slide,g)>=0)pawn.move(slide);
   }
   continue;
  }
  if(pawn.canJump&&!mayFallCalled){mayFallCalled=true;pawn.mayFall();}
  if(!pawn.canJump){pawn.velocity=[0,0,0];pawn.acceleration=[0,0,0];pawn.farMove(old,0,0);pawn.moveTimer=-1;return;}
  if(hit.time<1)pawn.hitSlopedWall=true;
  const size=f(Math.sqrt(dot(originalDelta,originalDelta)));
  remaining=size===0?0:f(remaining+(1-Math.min(1,Math.hypot(pawn.position[0]-origin[0],pawn.position[1]-origin[1])/size))*step);
  pawn.velocity=[pawn.velocity[0],pawn.velocity[1],0];pawn.fallingEvent();if(pawn.physics===1)pawn.setPhysics(2);
  if(pawn.physics===2){
   const vz=pawn.velocity[2];if(!pawn.justTeleported&&dt>remaining){const inv=f(1/(dt-remaining));pawn.velocity=scale(sub(pawn.position,old),inv);}pawn.velocity=[pawn.velocity[0],pawn.velocity[1],vz];
   if(remaining>.01)pawn.falling(remaining,iterations);return;
  }
  pawn.move(scale(desired,remaining));remaining=0;
 }
 if(!pawn.justTeleported){const inv=1/dt;pawn.velocity=[f((pawn.position[0]-old[0])*inv),f(f(pawn.position[1]-old[1])*f(inv)),f(f(pawn.position[2]-old[2])*f(inv))];}
 pawn.velocity=[pawn.velocity[0],pawn.velocity[1],0];
}
