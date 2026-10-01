/** AActor::Tick's original main/blend animation phases.
 * Contract and unchanged-DLL references: docs/script-animation-tick.md.
 * Caller owns outer Tick eligibility/order and prepares event/mesh resources.
 */
import {findAnimSeq} from './play-anim.mjs';
import {x87add,x87div,x87mul,x87sub} from './x87-nan.mjs';

const f=Math.fround;
const less=(a,b)=>a<b||Number.isNaN(a)||Number.isNaN(b); // x87 C0
// NaN results take the x87's bits (x87-nan.mjs), as tick.rs does.
const nonzero=value=>value!==0&&!Number.isNaN(value); // !x87 C3 against zero
// 'None' (the unset FName) is answered without building a lowercase copy.
export const named=value=>value!=='None'&&value!=null&&String(value).toLowerCase()!=='none'&&value!=='';
const active=actor=>named(actor.AnimSequence)&&nonzero(less(actor.AnimFrame,0)?actor.TweenRate:actor.AnimRate);

function scaledRate(actor,rate,minimum,blend=false) {
  if(!less(rate,0))return rate;
  const [x,y,z]=actor.Velocity;
  const s=x87add(x87add(x87mul(x,x),x87mul(y,y)),x87mul(z,z));
  const product=x87mul(-(s!==s?s:Math.sqrt(s)),rate),scaled=blend?f(product):product;
  return less(minimum,scaled)?scaled:minimum;
}

/** The notify of the main sequence that AnimFrame crossed since oldFrame
 * (the nearest ahead of oldFrame), or null. Also the Rust tick kernel's
 * selection (docs/rust-core.md R3-d). */
export function selectAnimNotify(actor,oldFrame,mesh) {
  const sequence=findAnimSeq(mesh(),actor.AnimSequence);
  let notify=null,distance=100000;
  for(const candidate of sequence?.notifies??[]) {
    if(!less(oldFrame,candidate.time)||less(actor.AnimFrame,candidate.time))continue;
    const delta=candidate.time-oldFrame;
    if(notify&&!less(delta,distance))continue;
    notify=candidate;distance=f(delta);
  }
  return notify;
}

function replicateCompletion(actor,animation) {
  if(actor.RemoteRole>=2||actor.isWeapon)return;
  const rate=x87mul(animation.AnimRate,5000);
  animation.simAnim={...animation.simAnim,frame:f(x87mul(animation.AnimFrame,10000)),rate:rate>32767?32767:f(rate)};
}

/** Services represent original FindFunction/ProcessEvent and loaded Mesh.
 * Mutations by ProcessEvent are observed by the rest of this same tick. */
export function tickActorAnimation(actor,seconds,{mesh,simulatedPawn,findFunction,processEvent}) {
  let remainingSeconds=f(seconds),iterations=0;
  const remainder=(end,start,stop)=>f(x87div(x87mul(x87sub(end,stop),remainingSeconds),x87sub(end,start)));
  const endEvent=()=>{
    if(!simulatedPawn)processEvent(findFunction('AnimEnd',true));
  };
  const admit=()=>active(actor)&&remainingSeconds>0&&++iterations<=4;
  while(admit()) {
    const oldFrame=actor.AnimFrame;
    if(less(oldFrame,0)) {
      const advanced=x87add(oldFrame,x87mul(remainingSeconds,actor.TweenRate));
      actor.AnimFrame=f(advanced);
      if(less(advanced,0))break;
      remainingSeconds=remainder(advanced,oldFrame,0);
      actor.AnimFrame=0;
      if(!nonzero(actor.AnimRate)) {
        actor.animFlags|=0x08;
        endEvent();
      }
      continue;
    }
    actor.AnimFrame=f(x87add(oldFrame,x87mul(remainingSeconds,scaledRate(actor,actor.AnimRate,actor.AnimMinRate))));
    if(actor.animFlags&0x20) {
      const notify=selectAnimNotify(actor,oldFrame,mesh);
      if(notify) {
        remainingSeconds=remainder(actor.AnimFrame,oldFrame,notify.time);
        actor.AnimFrame=notify.time;
        const record=findFunction(notify.name,false);
        if(record)processEvent(record);
        continue;
      }
    }
    if(less(actor.AnimFrame,actor.AnimLast))break;
    if(actor.animFlags&0x10) {
      if(less(actor.AnimFrame,1))remainingSeconds=0;
      else {
        remainingSeconds=remainder(actor.AnimFrame,oldFrame,1);
        actor.AnimFrame=0;
      }
      if(less(oldFrame,actor.AnimLast)) {
        if(actor.latentAction===0x181)actor.animFlags|=0x08;
        endEvent();
      }
    } else {
      remainingSeconds=remainder(actor.AnimFrame,oldFrame,actor.AnimLast);
      actor.AnimFrame=actor.AnimLast;
      actor.AnimRate=0;
      actor.animFlags|=0x08;
      endEvent();
      replicateCompletion(actor,actor);
    }
  }
  // Original 103a1fa1 -> 103a21f4 -> 103a1fa1: same gate and budget;
  // do not reset remaining time or turn this into one pass over the slots.
  while(admit())for(const blend of actor.blends) {
    if(!named(blend.AnimSequence)||!less(blend.AnimFrame,blend.AnimLast))continue;
    const oldFrame=blend.AnimFrame;
    if(less(oldFrame,0)) {
      const advanced=x87add(oldFrame,x87mul(remainingSeconds,blend.TweenRate));
      blend.AnimFrame=f(advanced);
      if(!less(advanced,0)) {
        remainingSeconds=remainder(advanced,oldFrame,0);
        blend.AnimFrame=0;
      }
    } else {
      blend.AnimFrame=f(x87add(oldFrame,x87mul(remainingSeconds,scaledRate(actor,blend.AnimRate,blend.AnimMinRate,true))));
      if(!less(blend.AnimFrame,blend.AnimLast)) {
        remainingSeconds=remainder(blend.AnimFrame,oldFrame,blend.AnimLast);
        blend.AnimFrame=blend.AnimLast;
        blend.AnimRate=0;
        replicateCompletion(actor,blend);
      }
    }
  }
  return {remainingSeconds,iterations};
}
