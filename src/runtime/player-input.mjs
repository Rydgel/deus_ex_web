import {getAxes} from './camera.mjs';
const f=Math.fround;

/** PlayerPawn.PlayerWalking.PlayerMove: pass body Rotation from before this
 * tick's UpdateRotation, and original post-PlayerInput axes. No normalization. */
export function walkingInput({rotation,aForward,aStrafe,aLookup=0,aTurn=0}){
 const [x,y]=getAxes(rotation);
 aForward=f(f(aForward)*f(.4));aStrafe=f(f(aStrafe)*f(.4));
 const newAccel=x.map((v,i)=>f(f(aForward*v)+f(aStrafe*y[i])));newAccel[2]=0;
 return {aForward,aStrafe,aLookup:f(f(aLookup)*f(.24)),aTurn:f(f(aTurn)*f(.24)),newAccel};
}

/** Healthy standalone ProcessMove only: caller resolves GetCurrentGroundSpeed
 * and excludes injury, carried-object, weapon, drone, and multiplayer branches. */
export function healthyWalkingGroundSpeed(currentGroundSpeed,aForward){
 let speed=Math.trunc(f(currentGroundSpeed));
 if(f(aForward)<0)speed=Math.trunc(speed*f(.65));
 return Math.max(f(speed),100);
}
