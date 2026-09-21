/** Original PlayAnim (259), LoopAnim (260), TweenAnim (294) and sequence lookup.
 * Authority and original-execution corrections: docs/script-animation-controls.md.
 * These control calls update animation state; they do not advance animation time.
 */
const f = Math.fround;
const nameKey = value => String(value ?? 'None').toLowerCase();
const hasSequence = value => value != null && value !== 0 && nameKey(value) !== 'none';
const unordered = (a, b) => Number.isNaN(a) || Number.isNaN(b);
const equalOrUnordered = (a, b) => a === b || unordered(a, b);
const lessOrUnordered = (a, b) => a < b || unordered(a, b);
const nonzeroOrdered = value => value !== 0 && !Number.isNaN(value);

/** UMesh vtable +68: original FName identity comparison in the 32-byte table. */
export function findAnimSeq(mesh, sequenceName) {
  return mesh?.sequences.find(sequence => nameKey(sequence.name) === nameKey(sequenceName)) ?? null;
}

function sequenceOrLog(mesh, name, kind, log) {
  if (!mesh) { log(`${kind}NoMesh`, {sequence: name}); return null; }
  const sequence = findAnimSeq(mesh, name);
  if (!sequence) log(`${kind}UnknownSequence`, {sequence: name, mesh: mesh.entry.name});
  return sequence;
}

/** Shared new-sequence path; the distinct original SimAnim tails stay separate.
 * Blend slots run the same field writes minus animFlags (execPlayBlendAnim
 * never touches them) and read the shared actor Velocity. */
function startAnimation(actor, sequence, rate, tweenTime, looping, minRate = 0, {flags = true, velocity} = {}) {
  const n = sequence.numFrames, tween = hasSequence(actor.AnimSequence) ? f(tweenTime) : 0;
  actor.AnimSequence = sequence.name;
  actor.AnimRate = f(f(rate) * f(sequence.rate) / n);
  actor.AnimLast = f(1 - 1 / n);
  if (looping) actor.AnimMinRate = minimumRate(sequence, minRate);
  if (flags) actor.animFlags = ((Number(actor.animFlags ?? 0) & ~0x38) |
    (sequence.notifyCount ? 0x20 : 0) | (looping ? 0x10 : 0)) >>> 0;
  if (equalOrUnordered(actor.AnimLast, 0)) {
    actor.animFlags = (actor.animFlags & ~0x20) >>> 0;
    actor.AnimMinRate = 0;
    actor.OldAnimRate = 0;
    actor.TweenRate = tween > 0 ? f(1 / tween) : 10;
    actor.AnimRate = 0;
    actor.AnimFrame = f(-1 / n);
  } else if (tween > 0) {
    actor.TweenRate = f(1 / (n * tween));
    actor.AnimFrame = f(-1 / n);
  } else if (equalOrUnordered(tween, -1)) {
    actor.AnimFrame = f(-1 / n);
    const old = f(actor.OldAnimRate ?? 0);
    if (old > 0) actor.TweenRate = old;
    else if (lessOrUnordered(old, 0)) {
      const [x, y, z] = (velocity ?? actor.Velocity ?? [0, 0, 0]).map(f);
      // CRT sqrt returns double; the original does not store a float norm.
      const velocityRate = -Math.sqrt((x*x + y*y) + z*z) * old;
      const halfRate = actor.AnimRate * 0.5;
      actor.TweenRate = f(lessOrUnordered(halfRate, velocityRate) ? velocityRate : f(halfRate));
    } else actor.TweenRate = f(1 / (n * 0.025));
  } else {
    actor.TweenRate = 0;
    actor.AnimFrame = f(looping ? 0.0001 : 0.001);
  }
}

function minimumRate(sequence, rate) {
  rate = f(rate);
  return equalOrUnordered(rate, 0) ? 0 : f(f(sequence.rate) / sequence.numFrames * rate);
}

function simState(actor, lastScale) {
  const rate = actor.AnimRate * 5000;
  return {frame: f(actor.AnimFrame * 10000), rate: rate > 32767 ? 32767 : f(rate),
    tween: f(actor.TweenRate * 1000), last: f(actor.AnimLast * lastScale)};
}

/** AActor::execPlayAnim, 0x103e0160. */
export function execPlayAnim(actor, mesh, sequenceName, rate, tweenTime, log = () => {}) {
  const sequence = sequenceOrLog(mesh, sequenceName, 'playAnim', log);
  if (!sequence) return;
  startAnimation(actor, sequence, rate, tweenTime, false);
  const old = actor.simAnim ?? {frame: 0, rate: 0, tween: 0, last: 0};
  const next = simState(actor, 10000);
  // TEST C3; JE skips the increment on an ordered unequal component.
  if (Object.keys(next).every(key => equalOrUnordered(old[key], next[key]))) next.last = f(next.last + 1);
  actor.simAnim = next;
  actor.OldAnimRate = actor.AnimRate;
}

/** AActor::execLoopAnim, 0x103e05e0. */
export function execLoopAnim(actor, mesh, sequenceName, rate, tweenTime, minRate, log = () => {}) {
  const sequence = sequenceOrLog(mesh, sequenceName, 'loopAnim', log);
  if (!sequence) return;
  const flags = Number(actor.animFlags ?? 0) >>> 0;
  const continuing = nameKey(actor.AnimSequence) === nameKey(sequenceName) && (flags & 0x10) &&
    hasSequence(actor.AnimSequence) && nonzeroOrdered(lessOrUnordered(f(actor.AnimFrame), 0)
      ? f(actor.TweenRate) : f(actor.AnimRate));
  if (continuing) {
    actor.animFlags = (flags & ~0x08) >>> 0;
    actor.AnimRate = f(f(rate) * f(sequence.rate) / sequence.numFrames);
    actor.AnimMinRate = minimumRate(sequence, minRate);
    const old = actor.simAnim ?? {frame: 0, rate: 0, tween: 0, last: 0};
    const next = {...old, rate: f(actor.AnimRate * 5000),
      last: f((1 - 1 / sequence.numFrames) * -10000)};
    actor.OldAnimRate = actor.AnimRate;
    // Like PlayAnim, bump the replicated last component only when unchanged.
    if (Object.keys(next).every(key => equalOrUnordered(old[key], next[key]))) next.last = f(next.last + 1);
    actor.simAnim = next;
  } else {
    startAnimation(actor, sequence, rate, tweenTime, true, minRate);
    actor.OldAnimRate = actor.AnimRate;
    actor.simAnim = simState(actor, -10000);
  }
}

/** AActor::execPlayBlendAnim, 0x103e0d80. The same recovered new-sequence
 * path as PlayAnim over the per-slot Blend* arrays: no animFlags write, and
 * SimBlendAnim quantizes rate at *10000 without the 16-bit clamp. */
export function execPlayBlendAnim(view, mesh, sequenceName, rate, tweenTime, slot, log = () => {}) {
  slot = Number(slot) | 0;
  if (slot < 0 || slot > 3) { log('blendSlotRange', {slot}); return; }
  const sequence = sequenceOrLog(mesh, sequenceName, 'playBlendAnim', log);
  if (!sequence) return;
  const blend = view.blends[slot];
  startAnimation(blend, sequence, rate, tweenTime, false, 0, {flags: false, velocity: view.Velocity});
  const old = blend.simAnim ?? {frame: 0, rate: 0, tween: 0, last: 0};
  const next = {frame: f(blend.AnimFrame * 10000), rate: f(blend.AnimRate * 10000),
    tween: f(blend.TweenRate * 1000), last: f(blend.AnimLast * 10000)};
  if (Object.keys(next).every(key => equalOrUnordered(old[key], next[key]))) next.last = f(next.last + 1);
  blend.simAnim = next;
  blend.OldAnimRate = blend.AnimRate;
}

/** AActor::execTweenAnim, 0x103e0bd0. */
export function execTweenAnim(actor, mesh, sequenceName, time, log = () => {}) {
  const sequence = sequenceOrLog(mesh, sequenceName, 'tweenAnim', log);
  if (!sequence) return;
  actor.AnimSequence = sequence.name;
  actor.animFlags = (Number(actor.animFlags ?? 0) & ~0x38) >>> 0;
  actor.AnimLast = actor.AnimMinRate = actor.AnimRate = actor.OldAnimRate = 0;
  time = f(time);
  actor.TweenRate = time > 0 ? f(1 / (sequence.numFrames * time)) : 0;
  actor.AnimFrame = time > 0 ? f(-1 / sequence.numFrames) : 0;
  actor.simAnim = {frame: f(actor.AnimFrame * 10000), rate: 0, tween: f(actor.TweenRate * 1000), last: 0};
}

/** Engine execTweenBlendAnim 0x103e1300; original LipSynch mouth-close tail. */
export function execTweenBlendAnim(view,mesh,sequenceName,time,slot=0,log=()=>{}) {
  slot=Number(slot)|0;
  if(slot<0||slot>3){log('blendSlotRange',{slot});return;}
  const sequence=sequenceOrLog(mesh,sequenceName,'tweenBlendAnim',log);
  if(!sequence)return;
  const blend=view.blends[slot];
  blend.AnimSequence=sequence.name;
  blend.AnimLast=blend.AnimMinRate=blend.AnimRate=blend.OldAnimRate=0;
  time=f(time);
  blend.TweenRate=time>0?f(1/(sequence.numFrames*time)):0;
  blend.AnimFrame=time>0?f(-1/sequence.numFrames):0;
  blend.simAnim={frame:f(blend.AnimFrame*10000),rate:0,tween:f(blend.TweenRate*1000),last:0};
}
