/**
 * Original `AActor::execPlayAnim` (native 259) and the mesh sequence lookup
 * it calls, translated from the GOTY Engine.dll.
 *
 * Evidence: docs/script-play-anim.md (complete execPlayAnim body transcribed
 * from Engine.asm, body 0x103e0160; sequence lookup bodies 0x1031c000 and
 * 0x1031c050) and docs/lodmesh-serialization.md (the serialized AnimSeq
 * layout recovered by executing the original serializer in
 * scripts/native-lodmesh-oracle.py).
 *
 * Actor field mapping (original offset -> runtime field):
 *   +0x54 AnimSequence (name index, 0 == none)  -> actor.AnimSequence
 *   +0x58 AnimFrame (float)                     -> actor.AnimFrame
 *   +0x5c AnimRate (float)                      -> actor.AnimRate
 *   +0x60 TweenRate (float)                     -> actor.TweenRate
 *   +0x144/+0x148/+0x14c Velocity               -> actor.Velocity (bound by
 *     docs/camera.md and the animation-tick body 0x103a1c98, which computes
 *     the same velocity-magnitude pattern for AnimRate < 0)
 *   +0x220 AnimLast (float, 1 - NumFrames)      -> actor.AnimLast
 *   +0x224 AnimMinRate (velocity-scaled clamp; the animation-tick body at
 *     0x103a1cd2 reads it for negative AnimRate exactly as Actor.uc declares)
 *   +0x228 OldAnimRate ("= AnimRate until animation completes"; the SimAnim
 *     tail copies bits(+0x5c) here and the TweenTime==-1 branch reads it)
 *   +0x22c..+0x238 SimAnim region               -> actor.simAnim
 *   flags bits 0x39/0x20                        -> actor.animFlags
 */
import {LodMeshError} from './lodmesh.mjs';

const f = Math.fround;

/** mesh vtable +0x68 (0x1031c000/0x1031c050): linear scan of the 0x20-stride table. */
export function findAnimSeq(mesh, sequenceName) {
  if (!mesh) return null;
  return mesh.sequences.find(sequence => sequence.name === sequenceName) || null;
}

/**
 * AActor::execPlayAnim. `mesh` is the decoded LodMesh payload or null.
 * `rate` and `tweenTime` are the evaluated float arguments in declaration
 * order (Sequence, Rate default 1.0, TweenTime default -1.0; the caller's
 * native parameter loop applies the defaults). `log` receives the original
 * warning paths; both guards return without writing animation state.
 */
export function execPlayAnim(actor, mesh, sequenceName, rate, tweenTime, log = () => {}) {
  if (!mesh) {
    log('playAnimNoMesh', {sequence: sequenceName});
    return;
  }
  const sequence = findAnimSeq(mesh, sequenceName);
  if (!sequence) {
    log('playAnimUnknownSequence', {sequence: sequenceName, mesh: mesh.entry.name});
    return;
  }
  // seq+0x0c NumFrames is consumed as fildl (double) in the rate expression
  // and as a float store below; seq+0x10 is the serialized Rate multiplier
  // and seq+0x18 the notify-array Num feeding the loop flag.
  const numFrames = sequence.numFrames;
  const sequenceRate = sequence.rate;
  const loopFlag = sequence.notifyCount !== 0 ? 1 : 0;

  // +0x54 == 0 (no previous sequence): TweenTime collapses to 0 (0x103e01ff).
  const hadSequence = actor.AnimSequence !== undefined && actor.AnimSequence !== null &&
    actor.AnimSequence !== 'None';
  const tween = hadSequence ? tweenTime : 0;

  actor.AnimSequence = sequenceName;
  // +0x5c = fl32(fl64(Rate) * fl64(seqRate) / fl64(NumFrames)) (0x103e0210).
  const animRate = f(Number(rate) * Number(sequence.rate) / Number(numFrames));
  // +0x220 = fl32(1.0 - fl64(NumFrames)) (0x103e022d).
  const animLast = f(1.0 - Number(numFrames));
  // flags = (flags & ~0x39) | ((seq+0x18 != 0) << 5) (0x103e0244).
  actor.animFlags = (Number(actor.animFlags ?? 0) & ~0x39) | (loopFlag << 5);

  const state = {animRate, animLast, animFrame: 0, TweenRate: 0};
  if (animLast === 0) {
    // NumFrames == 1 (0x103e025e): AnimMinRate and OldAnimRate are zeroed.
    actor.animFlags &= ~0x20;
    actor.AnimMinRate = 0;
    actor.OldAnimRate = 0;
    if (Number(tween) > 0) {
      state.TweenRate = f(Number(tween) / 1.0);
      state.animRate = 0;
      state.animFrame = f(Number(numFrames) / -1.0);
    } else {
      state.TweenRate = 10;
      state.animRate = 0;
      state.animFrame = f(Number(numFrames) / -1.0);
    }
    commitSimAnim(actor, state);
    return;
  }
  if (Number(tween) > 0) {
    // 0x103e0300 branch: TweenRate = NumFrames * TweenTime; frame = -NumFrames.
    state.TweenRate = f(Number(numFrames) * Number(tween) / 1.0);
    state.animFrame = f(Number(numFrames) / -1.0);
    commitSimAnim(actor, state);
    return;
  }
  if (Number(tween) === -1) {
    // 0x103e02ef: TweenTime == -1 branch; OldAnimRate (= the previous
    // AnimRate bits) selects the tween.
    state.animFrame = f(Number(numFrames) / -1.0);
    const oldRate = f(Number(actor.OldAnimRate ?? 0));
    if (oldRate > 0) {
      state.TweenRate = oldRate;
    } else if (oldRate === 0) {
      state.TweenRate = f(Number(numFrames) * 0.025 / 1.0);
    } else {
      tweenNormPath(actor, state);
    }
    commitSimAnim(actor, state);
    return;
  }
  // TweenTime < 0 and != -1 (0x103e03bc).
  state.TweenRate = 0;
  state.animFrame = f(0.001);
  commitSimAnim(actor, state);
}

/** 0x103e0344: TweenRate = max(-OldAnimRate * |Velocity|, AnimRate * 0.5).
 * Only reachable when the previous animation was velocity-scaled (negative
 * OldAnimRate); the tween then comes from the velocity magnitude. */
function tweenNormPath(actor, state) {
  const velocity = actor.Velocity ?? [0, 0, 0];
  const dot = Number(velocity[2]) ** 2 + Number(velocity[1]) ** 2 + Number(velocity[0]) ** 2;
  // A = fl32(fl64(fl32(sqrt(dot))) * fl64(OldAnimRate) * fl64(-1.0)).
  const a = f(Number(f(Math.sqrt(dot))) * Number(actor.OldAnimRate ?? 0) * -1.0);
  // B = fl32(AnimRate * 0.5f).
  const b = f(state.animRate * f(0.5));
  state.TweenRate = b < a ? a : b;
}

/** SimAnim tail (0x103e03c6) and the +0x228 bits mirror. */
function commitSimAnim(actor, state) {
  const old = actor.simAnim ?? {frame: 0, rate: 0, tween: 0, last: 0};
  const next = {
    frame: f(Number(state.animFrame) * 10000.0),
    rate: Math.min(f(Number(state.animRate) * 5000.0), 32767.0),
    tween: f(Number(state.TweenRate) * 1000.0),
    last: f(Number(state.animLast) * 10000.0),
  };
  if (old.frame === next.frame && old.rate === next.rate &&
      old.tween === next.tween && old.last === next.last) {
    next.last = f(Number(next.last) + 1.0);
  }
  actor.simAnim = next;
  // +0x228 = bits(+0x5c) (movl copy): OldAnimRate = the previous AnimRate.
  actor.OldAnimRate = state.animRate;
  actor.AnimFrame = state.animFrame;
  actor.AnimRate = state.animRate;
  actor.TweenRate = state.TweenRate;
  actor.AnimLast = state.animLast;
}
