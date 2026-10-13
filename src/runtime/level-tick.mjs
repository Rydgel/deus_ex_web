/** Standalone ULevel.Tick simulation scheduling. Original instruction contract,
 * reference cases and service boundaries: docs/script-level-tick.md. */
import {x87load, x87add, x87mul, x87neg, x87store, x87storeDouble, x87sqrt} from './script-vm.mjs';
import {unambiguousF32, ulps53} from './x87-fast.mjs';

const f=Math.fround;
const scratch=new DataView(new ArrayBuffer(8));
function loadDouble(value) {
  scratch.setFloat64(0,value,true);
  const bits=scratch.getBigUint64(0,true),exponent=Number((bits>>52n)&0x7ffn);
  return {neg:Number(bits>>63n),sig:(bits&0xfffffffffffffn)|(exponent?0x10000000000000n:0n),
    exp:exponent?exponent-1075:-1074};
}
function storeDouble(value) {
  const rounded=x87storeDouble(value);
  return (rounded.neg?-1:1)*Number(rounded.sig)*2**rounded.exp;
}

/** ULevel.Tick 103a5468..103a5487 and 103a54c8..103a54df. One input
 * frame advances the double clock before clamping the actor delta. Shared by
 * the full scheduler and the Play host's currently admitted actor subset. */
export function levelTickTime(timeSeconds,seconds,timeDilation) {
  const input=f(seconds),dilation=f(timeDilation);
  if(!Number.isFinite(input)||!Number.isFinite(dilation)||!Number.isFinite(timeSeconds))
    throw new Error('Level.Tick nonfinite clock inputs are not implemented');
  const product=x87mul(x87load(input),x87load(dilation));
  let delta=x87store(product);
  const time=x87add(product,loadDouble(timeSeconds));
  if(delta<f(0.005)||Number.isNaN(delta))delta=f(0.005);
  else if(!(delta<f(0.4)))delta=f(0.4);
  return {timeSeconds:storeDouble(time),infoTimeSeconds:x87store(time),delta};
}
// Fast path for playerDistance (x87-fast.mjs). The double differences of the
// f32 loads carry relative error <= 2^-53 each, the squares and the sum of
// nonnegative terms <= 5*2^-53, and the square root halves it and adds 2^-53
// (3.5*2^-53). The x87 sequence (64-bit adds/products, the 53-bit FSTL and a
// 64-bit FSQRT) stays within about 0.6*2^-53 of the exact root. A 16*2^-53
// bound covers both with margin.
function playerDistanceFast(location,origin) {
  const dx=f(location[0])-f(origin[0]),dy=f(location[1])-f(origin[1]),dz=f(location[2])-f(origin[2]);
  if(dx===0&&dy===0&&dz===0)return undefined;
  const root=Math.sqrt(dx*dx+dy*dy+dz*dz);
  return unambiguousF32(root,root*ulps53(16));
}
export function playerDistance(location,origin) {
  if(!location.every(Number.isFinite)||!origin.every(Number.isFinite))
    throw new Error('Level.Tick nonfinite distance coordinates are not implemented');
  const fast=playerDistanceFast(location,origin);
  if(fast!==undefined)return fast;
  const [x,y,z]=location.map((v,i)=>x87add(x87load(v),x87neg(x87load(origin[i]))));
  const square=x87add(x87add(x87mul(y,y),x87mul(z,z)),x87mul(x,x));
  return x87store(x87sqrt(x87storeDouble(square)));
}

/** The host supplies original entry/exit memory/counter services, calendar,
 * viewport input and event manager. No actor list is synthesized here. The
 * runtime bridge composes actual Actor.Tick and CleanupDestroyed separately. */
export function tickStandaloneLevel(level,seconds,tickType,services) {
  const {read,write,isA,tickActor}=services;
  if(level.netMode!==0||level.netDriver!==null||level.demoRecDriver!==null)
    throw new Error('Level.Tick network/demo scheduling is not implemented');
  if(level.serviceAtF8!==null)throw new Error('Level.Tick +0xf8 service is not supplied by this standalone route');
  if(!Array.isArray(level.actors)||!Number.isInteger(level.firstDynamicActor)||
    level.firstDynamicActor<0||level.firstDynamicActor>level.actors.length)
    throw new Error('Level.Tick requires the original actor array and FirstDynamicActor');
  if(level.tickTag!==0&&level.tickTag!==1)throw new Error('Level.Tick requires the original TickTag');
  const levelInfo=()=>{
    const info=level.actors[0];
    if(!info||!isA(info,'engine.levelinfo'))throw new Error('Level.Tick requires LevelInfo in actor slot zero');
    return info;
  };
  const info=levelInfo(),input=f(seconds),dilation=read(info,'TimeDilation');
  if(!Number.isFinite(input)||!Number.isFinite(dilation)||!Number.isFinite(level.timeSeconds))
    throw new Error('Level.Tick nonfinite clock inputs are not implemented');
  const mark=services.beginTick(level,input);
  level.inTick=1;
  const frame=levelTickTime(level.timeSeconds,input,dilation),delta=frame.delta;
  level.timeSeconds=frame.timeSeconds;
  write(info,'TimeSeconds',frame.infoTimeSeconds);
  services.updateTime(info);
  if(read(info,'bPlayersOnly'))tickType=1;

  // appStricmp compares to an empty UTF-16 C string, independently of the
  // FString allocation count later tested for EventManager admission.
  const paused=()=>{const value=read(info,'Pauser');return value.length>0&&value.charCodeAt(0)!==0;};
  if(tickType!==0&&!paused()) {
    levelInfo();
    if(!level.firstViewport)throw new Error('Standalone Level.Tick requires the first original viewport');
    const player=level.firstViewport.actor;
    if(player&&isA(player,'engine.playerpawn')&&read(player,'Player')) {
      const origin=[...read(player,'Location')];
      const distance=actor=>playerDistance(read(actor,'Location'),origin);
      // Host work: `playerDistances` (level.rs) writes the image actors'
      // distances and returns the indices left to this loop, in order.
      const handed=services.playerDistances?.(level.actors,level.firstDynamicActor,origin,distance)??null;
      if(handed)for(const i of handed){const actor=level.actors[i];if(actor)write(actor,'DistanceFromPlayer',distance(actor));}
      else for(let i=level.firstDynamicActor;i<level.actors.length;i++) {
        const actor=level.actors[i];
        if(actor)write(actor,'DistanceFromPlayer',distance(actor));
      }
    }
    let progress=0;
    level.deferredHead=null;
    for(let i=level.firstDynamicActor;i<level.actors.length;i++) {
      const actor=level.actors[i];
      if(actor)progress=(progress+tickActor(actor,delta,tickType))|0;
    }
    while(level.deferredHead&&progress!==0) {
      let node=level.deferredHead;
      level.deferredHead=null;progress=0;
      while(node) {
        if(Number(Boolean(read(node.actor,'bTicked')))!==level.tickTag)
          progress=(progress+tickActor(node.actor,delta,tickType))|0;
        node=node.next;
      }
    }
  } else if(paused()) {
    for(let i=level.firstDynamicActor;i<level.actors.length;i++) {
      const actor=level.actors[i];
      if(!actor)continue;
      if(isA(actor,'engine.playerpawn')&&read(actor,'Player')) {
        services.readInput(read(actor,'Player'),delta);
        services.processEvent(actor,'PlayerInput',[delta]);
        services.resetInputProperties(actor);
      } else if(read(actor,'bAlwaysTick'))tickActor(actor,delta,tickType);
    }
  }

  // The host's manager (the Rust AI event manager) stands for the LevelInfo.EventManager object it does not materialize.
  const manager=read(levelInfo(),'EventManager')||services.eventManager?.(levelInfo())||null;
  if(manager&&services.pauserArrayCount(info)===0&&tickType===2)
    services.tickEventManager(manager,delta);
  if(level.netDriver!==null||level.demoRecDriver!==null)
    throw new Error('Level.Tick callback installed an unsupported network/demo driver');
  level.tickTag=Number(level.tickTag===0);
  level.inTick=0;
  services.endTick(level,mark);
  services.cleanupDestroyed(level,0);
  return delta;
}
