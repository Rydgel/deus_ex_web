/**
 * Animation host: builds the linked state view for the original animation
 * control and latent natives. Mesh payloads are decoded by the runtime
 * itself (ScriptRuntime.meshPayload) so every host shares one cache.
 *
 * Evidence: docs/script-animation-controls.md (original exec comparisons),
 * docs/script-mesh-payload.md (serialized AnimSeq layout),
 * docs/script-play-anim.md (execPlayAnim contract and actor field offsets),
 * docs/script-light-switch.md (the LightSwitch.Frob route and remaining
 * sound/conversation boundaries).
 *
 * All offsets map to linked Actor.uc declarations: +0x54 AnimSequence,
 * +0x58 AnimFrame, +0x5c AnimRate, +0x60 TweenRate, +0x144 Velocity (bound by
 * docs/camera.md and the animation-tick body 0x103a1c98), +0x220 AnimLast,
 * +0x224 AnimMinRate (velocity-scaled clamp read by 0x103a1cd2), +0x228
 * OldAnimRate (SimAnim tail bits-copy of +0x5c), +0x22c..+0x238 SimAnim.
 * Bits 08/10/20 map to the original linked Actor booleans. SimAnim's Plane
 * extends Core.Object.Vector (X/Y/Z) with W; its typed value uses member keys.
 * No separate flag/replication state is hidden from UnrealScript.
 */

import {arrayReference} from './script-values.mjs';

const animationFlags = [['bAnimFinished', 0x08], ['bAnimLoop', 0x10], ['bAnimNotify', 0x20]];
const simMembers = {frame:'core.object.vector.x', rate:'core.object.vector.y',
  tween:'core.object.vector.z', last:'core.object.plane.w'};

function readSim(reference) {
  const value=reference.get();
  return Object.fromEntries(Object.entries(simMembers).map(([key,member])=>{
    if(!Object.hasOwn(value,member))throw new Error(`Animation Plane member is not linked: ${member}`);
    return [key,value[member]];
  }));
}

function writeSim(reference,value) {
  const plane=reference.get();
  for(const [key,member] of Object.entries(simMembers)) {
    if(!Object.hasOwn(plane,member))throw new Error(`Animation Plane member is not linked: ${member}`);
    plane[member]=value[key];
  }
  reference.set(plane);
}

/** Animation field view for execPlayAnim over the linked Actor fields. */
export function animationView(runtime, actor) {
  const field = key => runtime.namedReference(actor, key);
  return {
    get AnimSequence() { return field('AnimSequence').get() ?? 'None'; },
    set AnimSequence(value) { field('AnimSequence').set(value); },
    get AnimFrame() { return field('AnimFrame').get() ?? 0; },
    set AnimFrame(value) { field('AnimFrame').set(value); },
    get AnimRate() { return field('AnimRate').get() ?? 0; },
    set AnimRate(value) { field('AnimRate').set(value); },
    get TweenRate() { return field('TweenRate').get() ?? 0; },
    set TweenRate(value) { field('TweenRate').set(value); },
    get AnimLast() { return field('AnimLast').get() ?? 0; },
    set AnimLast(value) { field('AnimLast').set(value); },
    get AnimMinRate() { return field('AnimMinRate').get() ?? 0; },
    set AnimMinRate(value) { field('AnimMinRate').set(value); },
    get OldAnimRate() { return field('OldAnimRate').get() ?? 0; },
    set OldAnimRate(value) { field('OldAnimRate').set(value); },
    get Velocity() { return field('Velocity').get() ?? [0, 0, 0]; },
    get animFlags() { return animationFlags.reduce((bits,[key,mask])=>bits|(field(key).get()?mask:0),0); },
    set animFlags(value) { for(const [key,mask] of animationFlags)field(key).set(Boolean(value&mask)); },
    get simAnim() { return readSim(field('SimAnim')); },
    set simAnim(value) { writeSim(field('SimAnim'),value); },
  };
}

/** Same original fields plus the Tick phase's class/state and blend slots. */
export function animationTickView(runtime,actor) {
  const view=animationView(runtime,actor),instance=runtime.instance(actor);
  const field=name=>runtime.namedReference(actor,name);
  const isA=key=>{
    for(let cls=instance.cls;cls;cls=cls.base)if(cls.record.key===key)return true;
    return false;
  };
  Object.defineProperties(view,{
    latentAction:{get:()=>instance.state.latent},
    RemoteRole:{get:()=>field('RemoteRole').get()},
    isWeapon:{get:()=>isA('engine.weapon')},
    simulatedPawn:{get:()=>Boolean(field('bIsPawn').get())&&isA('engine.pawn')&&field('Role').get()===2},
  });
  view.blends=Array.from({length:4},(_,index)=>{
    const element=name=>arrayReference(index,field(name),runtime.warning);
    const blend={get simAnim(){return readSim(element('SimBlendAnim'));},
      set simAnim(value){writeSim(element('SimBlendAnim'),value);}};
    for(const [key,name] of Object.entries({AnimSequence:'BlendAnimSequence',AnimFrame:'BlendAnimFrame',
      AnimRate:'BlendAnimRate',TweenRate:'BlendTweenRate',AnimLast:'BlendAnimLast',AnimMinRate:'BlendAnimMinRate'}))
      Object.defineProperty(blend,key,{get:()=>element(name).get(),set:value=>element(name).set(value)});
    return blend;
  });
  return view;
}
