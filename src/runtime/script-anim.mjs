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

/** Animation field view for execPlayAnim over the linked Actor fields. A class, so a view is two fields and its accessors are
 * shared: it is made for every IsAnimating poll and PlayAnim, and the object of closures it was cost about 1 KB a call, kept in
 * old space (docs/live-heap.md "Cut: promoted garbage"). */
class AnimationView {
  constructor(runtime, actor) { this.runtime = runtime; this.actor = actor; }
  // Value reads/writes need no lvalue; SimAnim keeps its struct reference.
  get AnimSequence() { return this.runtime.readNamed(this.actor, 'AnimSequence') ?? 'None'; }
  set AnimSequence(value) { this.runtime.writeNamed(this.actor, 'AnimSequence', value); }
  get AnimFrame() { return this.runtime.readNamed(this.actor, 'AnimFrame') ?? 0; }
  set AnimFrame(value) { this.runtime.writeNamed(this.actor, 'AnimFrame', value); }
  get AnimRate() { return this.runtime.readNamed(this.actor, 'AnimRate') ?? 0; }
  set AnimRate(value) { this.runtime.writeNamed(this.actor, 'AnimRate', value); }
  get TweenRate() { return this.runtime.readNamed(this.actor, 'TweenRate') ?? 0; }
  set TweenRate(value) { this.runtime.writeNamed(this.actor, 'TweenRate', value); }
  get AnimLast() { return this.runtime.readNamed(this.actor, 'AnimLast') ?? 0; }
  set AnimLast(value) { this.runtime.writeNamed(this.actor, 'AnimLast', value); }
  get AnimMinRate() { return this.runtime.readNamed(this.actor, 'AnimMinRate') ?? 0; }
  set AnimMinRate(value) { this.runtime.writeNamed(this.actor, 'AnimMinRate', value); }
  get OldAnimRate() { return this.runtime.readNamed(this.actor, 'OldAnimRate') ?? 0; }
  set OldAnimRate(value) { this.runtime.writeNamed(this.actor, 'OldAnimRate', value); }
  get Velocity() { return this.runtime.readNamed(this.actor, 'Velocity') ?? [0, 0, 0]; }
  get animFlags() {
    const runtime = this.runtime, actor = this.actor;
    return animationFlags.reduce((bits,[key,mask])=>bits|(runtime.readNamed(actor, key)?mask:0),0);
  }
  set animFlags(value) { for(const [key,mask] of animationFlags)this.runtime.writeNamed(this.actor, key, Boolean(value&mask)); }
  get simAnim() { return readSim(this.runtime.namedReference(this.actor, 'SimAnim')); }
  set simAnim(value) { writeSim(this.runtime.namedReference(this.actor, 'SimAnim'), value); }
}
export const animationView = (runtime, actor) => new AnimationView(runtime, actor);

/** Same original fields plus the Tick phase's class/state and blend slots. */
export function animationTickView(runtime,actor) {
  const view=animationView(runtime,actor),instance=runtime.instance(actor);
  const field=name=>runtime.namedReference(actor,name);
  const isA=key=>{
    for(let cls=instance.cls;cls;cls=cls.base)if(cls.record.key===key)return true;
    return false;
  };
  const get=name=>runtime.readNamed(actor,name);
  Object.defineProperties(view,{
    latentAction:{get:()=>instance.state.latent},
    RemoteRole:{get:()=>get('RemoteRole')},
    isWeapon:{get:()=>isA('engine.weapon')},
    simulatedPawn:{get:()=>Boolean(get('bIsPawn'))&&isA('engine.pawn')&&get('Role')===2},
  });
  view.blends=Array.from({length:4},(_,index)=>{
    const element=name=>arrayReference(index,field(name),runtime.warning);
    // An in-range element read is that element of the copied whole value;
    // anything else keeps arrayReference's clamp/warning and errors.
    // readNamedElements reads the element's own cell (the value the whole
    // read would hold at this index) or falls back to the whole value.
    const read=name=>{const whole=runtime.readNamedElements(actor,name);
      return whole&&index<whole.length?whole.at(index):element(name).get();};
    const blend={get simAnim(){return readSim(element('SimBlendAnim'));},
      set simAnim(value){writeSim(element('SimBlendAnim'),value);}};
    for(const [key,name] of Object.entries({AnimSequence:'BlendAnimSequence',AnimFrame:'BlendAnimFrame',
      AnimRate:'BlendAnimRate',TweenRate:'BlendTweenRate',AnimLast:'BlendAnimLast',AnimMinRate:'BlendAnimMinRate',
      OldAnimRate:'OldBlendAnimRate'}))
      Object.defineProperty(blend,key,{get:()=>read(name),set:value=>element(name).set(value)});
    return blend;
  });
  return view;
}
