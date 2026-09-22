import { x87ftol, x87int32, x87load, x87mul } from './script-vm.mjs';

/**
 * Original non-Pawn rotation physics (Engine.dll, docs/actor-physics.md):
 * the AActor::performPhysics tail (0x103c98ed-0x103c995f), AActor::physicsRotation
 * (thunk 0x103010c8 -> body 0x103ca1e0) and AActor::fixedTurn (thunk 0x10303b34 ->
 * body 0x103c9dc0).
 *
 * Rotators are int32 [Pitch, Yaw, Roll] arrays (actor +0x120 Rotation, +0x1fc
 * RotationRate, +0x208 DesiredRotation); `bFixedRotationDir` (+0x1ec bit 0x20)
 * and `bRotateToDesired` (bit 0x40) are booleans on the actor object.
 */

const i32 = value => value | 0;
const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const abs32 = value => (value < 0 ? -value | 0 : value); // x86 `neg`: INT_MIN stays INT_MIN

/** performPhysics gate 0x103c98ed-0x103c990a: physicsRotation runs when any
 * RotationRate component has a nonzero low word (`test 0xffff, component`). */
export function physicsRotationGate(rotationRate) {
  return ((rotationRate[0] | rotationRate[1] | rotationRate[2]) & 0xffff) !== 0;
}

/** `(INT)(RotationRate.X * DeltaTime)`: `fild dword` (exact), `fmul dword DeltaTime`
 * on the x87 stack (int32 x float32 fits the 64-bit significand, so the product
 * is exact), then MSVCRT `_ftol` truncation, low DWORD of the int64. */
export function rotationDelta(rate, deltaTime) {
  return x87ftol(x87mul(x87int32(rate), x87load(deltaTime)));
}

/** AActor::fixedTurn(current, desired, deltaRate) 0x103c9dc0, including the
 * Deus Ex bFixedRotationDir && bRotateToDesired branch (turn in the rate's
 * direction but stop at the desired angle). Returns a value in [0, 65535]. */
export function fixedTurn(current, desired, deltaRate, { bFixedRotationDir = false, bRotateToDesired = false } = {}) {
  current = i32(current); desired = i32(desired); deltaRate = i32(deltaRate);
  if (deltaRate === 0) return current & 0xffff;
  const from = current & 0xffff;
  let to = desired & 0xffff;
  if (bFixedRotationDir) {
    if (!bRotateToDesired) return (from + deltaRate) & 0xffff;             // 0x103c9e3c
    if (deltaRate > 0) {                                                    // 0x103c9dfc
      if (from > to) to += 0x10000;
      const distance = to - from;
      return (from + (deltaRate > distance ? distance : deltaRate)) & 0xffff;
    }
    const base = from < to ? from + 0x10000 : from;                         // 0x103c9e1e
    const distance = to - base;
    return (from + (deltaRate < distance ? distance : deltaRate)) & 0xffff;
  }
  if (!bRotateToDesired) return from;                                       // 0x103c9ed5
  const rate = abs32(deltaRate);
  if (from > to) {
    const distance = from - to;
    if (distance < 0x8000) return (from - (distance <= rate ? distance : rate)) & 0xffff;
    const around = to - from + 0x10000;
    return (from + (around <= rate ? around : rate)) & 0xffff;
  }
  const distance = to - from;
  if (distance < 0x8000) return (from + (distance > rate ? rate : distance)) & 0xffff;
  const around = from - to + 0x10000;
  return (from - (around > rate ? rate : around)) & 0xffff;
}

/** AActor::physicsRotation(DeltaTime) 0x103ca1e0.
 *
 * Services (explicit boundaries):
 *  - `moveActor(delta, rotation)`: `XLevel->MoveActor(this, FVector(0,0,0),
 *    NewRotation, Hit, 0, 0, 0, 0)` through the level vtable slot +0x88
 *    (0x103ca3d7). For a movable non-brush actor with StandingCount 0 the
 *    original short path only stores Rotation (0x1039921a); bStatic or !bMovable
 *    returns false without storing; riders/brushes need the full MoveActor.
 *    `setScriptRotation` (script-set-rotation.mjs) implements that short path.
 *    The return value is ignored here; the service must update actor.rotation.
 *  - `isProbing(name)`: UObject::IsProbing(NAME_EndedRotation, index 325).
 *  - `endedRotation()`: the script EndedRotation event (ProcessEvent, no parms).
 */
export function physicsRotation(actor, deltaTime, { moveActor, isProbing, endedRotation } = {}) {
  if (typeof moveActor !== 'function' || typeof isProbing !== 'function' || typeof endedRotation !== 'function')
    throw new Error('physicsRotation requires explicit moveActor/isProbing/endedRotation services');
  const dt = Math.fround(deltaTime);
  if (!Number.isFinite(dt)) throw new Error('physicsRotation requires a finite float32 DeltaTime');
  const rotateToDesired = Boolean(actor.bRotateToDesired);
  if (!rotateToDesired && !actor.bFixedRotationDir) return;                // 0x103ca218
  const rotation = actor.rotation.map(i32), desired = actor.desiredRotation.map(i32);
  if (rotateToDesired && same(rotation, desired)) return;                  // 0x103ca222
  const rate = actor.rotationRate.map(i32);
  const deltas = rate.map(value => rotationDelta(value, dt));              // Roll, Yaw, Pitch _ftol order
  const flags = () => ({ bFixedRotationDir: Boolean(actor.bFixedRotationDir), bRotateToDesired: Boolean(actor.bRotateToDesired) });
  const next = [...rotation];
  // Yaw (0x103ca2a1), Pitch (0x103ca2d5), Roll (0x103ca305): each axis turns only
  // with a nonzero integer delta, and not while rotating to an already reached
  // component. Untouched axes keep their unnormalized int32 value.
  for (const axis of [1, 0, 2]) {
    if (deltas[axis] === 0) continue;
    const toDesired = axis === 1 ? rotateToDesired : Boolean(actor.bRotateToDesired);
    if (toDesired && desired[axis] === next[axis]) continue;
    next[axis] = fixedTurn(next[axis], desired[axis], deltas[axis], flags());
  }
  if (!same(next, actor.rotation.map(i32))) moveActor([0, 0, 0], next);   // 0x103ca32f
  // 0x103ca3dd: flags and rotation are re-read after MoveActor.
  if (actor.bRotateToDesired && same(actor.rotation.map(i32), actor.desiredRotation.map(i32)) && isProbing('EndedRotation'))
    endedRotation();
}

/** AActor::performPhysics tail after the Physics switch (0x103c98ed-0x103c995f):
 * the rotation gate and physicsRotation, then one PendingTouch (+0x21c) PostTouch.
 *
 * `postTouch(target, other)` is `target->eventPostTouch(other)` (ProcessEvent,
 * NAME_PostTouch). PendingTouch is re-read after the event before unlinking:
 * `this->PendingTouch = Old->PendingTouch; Old->PendingTouch = NULL`. */
export function performPhysicsTail(actor, deltaTime, services = {}) {
  if (physicsRotationGate(actor.rotationRate)) physicsRotation(actor, deltaTime, services);
  if (!actor.pendingTouch) return;
  if (typeof services.postTouch !== 'function') throw new Error('performPhysics PendingTouch requires an explicit postTouch service');
  services.postTouch(actor.pendingTouch, actor);
  const touched = actor.pendingTouch;
  if (!touched) throw new Error('PostTouch cleared PendingTouch; the original dereferences it (0x103c9949)');
  actor.pendingTouch = touched.pendingTouch ?? null;
  touched.pendingTouch = null;
}
