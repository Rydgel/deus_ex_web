/**
 * Animation host: builds the animation-state view the native PlayAnim (259)
 * implementation reads and writes. Mesh payloads are decoded by the runtime
 * itself (ScriptRuntime.meshPayload) so every host shares one cache.
 *
 * Evidence: docs/lodmesh-serialization.md (serialized AnimSeq layout),
 * docs/script-play-anim.md (execPlayAnim contract and actor field offsets),
 * docs/script-light-switch.md (the LightSwitch.Frob route and remaining
 * sound/conversation boundaries).
 *
 * All offsets map to linked Actor.uc declarations: +0x54 AnimSequence,
 * +0x58 AnimFrame, +0x5c AnimRate, +0x60 TweenRate, +0x144 Velocity (bound by
 * docs/camera.md and the animation-tick body 0x103a1c98), +0x220 AnimLast,
 * +0x224 AnimMinRate (velocity-scaled clamp read by 0x103a1cd2), +0x228
 * OldAnimRate (SimAnim tail bits-copy of +0x5c), +0x22c..+0x238 SimAnim.
 * The flags word (bits 0x39/0x20) is the only unbound field and stays on the
 * instance as `animationState.flags`.
 */

/** Animation field view for execPlayAnim over the linked Actor fields. */
export function animationView(runtime, actor) {
  const state = actor.animationState ??= {flags: 0, simAnim: null};
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
    get animFlags() { return state.flags; },
    set animFlags(value) { state.flags = value; },
    get simAnim() { return state.simAnim; },
    set simAnim(value) { state.simAnim = value; },
  };
}