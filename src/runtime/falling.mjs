import { safeNormal, twoWallAdjust } from './steps.mjs';
import { x87add, x87load, x87mul, x87neg, x87store } from './script-vm.mjs';
import { scriptVmKernel } from './script-vm-kernel.mjs';

const f = Math.fround;
const add = (a, b) => a.map((v, i) => f(v + b[i]));
const sub = (a, b) => a.map((v, i) => f(v - b[i]));
const scale = (a, s) => a.map(v => f(v * s));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const PHYS_NONE = 0;
const X87_ONE = Object.freeze({ neg: 0, sig: 1n, exp: 0 });

/** `RemainingTime += TimeTick * (1.0 - Hit.Time)` exactly as both original sites
 * emit it (bounce refund 0x103d1de0, floor refund 0x103d1e0e): `fld Hit.Time;
 * fsubr qword 1.0; fmul dword TimeTick; fadd dword RemainingTime; fstp dword`.
 * The difference, product and sum stay on the x87 stack (64-bit significand,
 * control word 0x037f as in the native oracle) and round once at the store. */
const refundTime = (remaining, time, step) => scriptVmKernel ? scriptVmKernel.refundTime(remaining, time, step) :
  x87store(x87add(x87mul(x87add(X87_ONE, x87neg(x87load(time))), x87load(step)), x87load(remaining)));

/** AActor.physFalling (Engine.dll 0x103d0a50): the dry Pawn (player) path, the
 * non-Pawn path and the bBounce wall-hit branch. World movement/queries and the
 * reached engine/script events are supplied by the caller; this function does
 * not implement surface events or landing fitting. A Pawn that a MoveActor
 * left in PHYS_Swimming hands off to the caller's `startSwimming` service
 * (docs/swimming.md).
 *
 * `options` (all explicit; the defaults are the previously validated player path):
 *  - `nonPawn`: the source is not a Pawn (`IsA(APawn)` false at 0x103d0a7d). The
 *    Pawn walking prelude and the whole air-control/acceleration-clamp block
 *    (0x103d0bca -> 0x103d0e0c) are skipped: Acceleration is used unchanged,
 *    including its Z. Pass it for projectiles/fragments, inventory and
 *    decorations.
 *  - `bounce`: the source's bBounce (actor+0x1ec bit 0x10). A host that exposes a
 *    live boolean `bBounce` is read instead at every place the native re-reads
 *    the flag (0x103d1d81 and 0x103d22ce), so a script that clears it is seen.
 *  - `hitWallEvent(normal, actor)`: required whenever the bounce branch is
 *    reached. It is the original direct script event dispatch
 *    `ProcessEvent(FindFunctionChecked(NAME_HitWall), {HitNormal, Wall})`
 *    (0x103d1d8c-0x103d1dcc) — NOT processHitWall — so it includes
 *    ProcessEvent's own probe gate and every effect of the script body. The
 *    host must reflect those effects (Velocity, Physics, bBounce, ...) on `pawn`
 *    before returning.
 *
 * Bounce semantics recovered from 0x103d1d08-0x103d1dfa and 0x103d22ce-0x103d22e6:
 * every blocked move (Hit.Time < 1, floors included — processLanded and
 * processHitWall are never called while bBounce) dispatches HitWall; Physics ==
 * PHYS_None afterwards returns at once (no Acceleration restore); otherwise the
 * first two bounces of this call refund `(1 - Hit.Time) * TimeTick`, the bounce
 * counter increments, no slide move is made, and the end-of-substep velocity
 * recomputation is skipped, so Velocity is whatever the script left. The loop
 * then continues under the ordinary remaining-time/8-iteration bound.
 */
export function falling(pawn, seconds, iterations = 0, { nonPawn = false, bounce = false, hitWallEvent } = {}) {
  const dt = f(seconds);
  if (!(dt > 0) || dt > f(.4)) throw new Error('Falling requires an original actor timestep in (0, 0.4]');
  const bouncing = () => (typeof pawn.bBounce === 'boolean' ? pawn.bBounce : Boolean(bounce));
  const requireHitWallEvent = () => {
    if (typeof hitWallEvent !== 'function')
      throw new Error('Bouncing physFalling requires an explicit hitWallEvent(normal, actor) script dispatch (0x103d1d8c)');
  };
  if (bouncing()) requireHitWallEvent();
  // Original Pawn branch 103d0a7d–103d0ac2 calls the same surface/ladder
  // prelude as walking, before reading acceleration or the current zone.
  if (!nonPawn && pawn.walkingPrelude?.(dt,iterations)) return;
  // 0x103d0aca-0x103d0b8c: Region.ZoneNumber == 0. At ROLE_Authority an
  // Inventory/Decoration/Pawn source logs "%s fell out of the world!"
  // (0x10481a34, a GLog side channel); every source then dispatches the
  // FellOutOfWorld event (ProcessEvent, FName 0x10583608) and returns.
  if (pawn.zoneNumber === 0) {
    if (typeof pawn.fellOutOfWorld !== 'function')
      throw new Error('physFalling outside the world requires the FellOutOfWorld event dispatch (0x103d0b89)');
    pawn.fellOutOfWorld();
    return;
  }
  const savedAcceleration = pawn.acceleration.map(f);
  const gravity = pawn.gravity.map(f), zoneVelocity = pawn.zoneVelocity.map(f);
  let speedLimit = 0;
  pawn.position = pawn.position.map(f); pawn.velocity = pawn.velocity.map(f);
  if (nonPawn) pawn.acceleration = [...savedAcceleration];
  else {
    let acceleration = [...savedAcceleration], airControl = f(pawn.airControl);
    if (airControl > f(.15)) {
      const direction = safeNormal(acceleration), limit = f(airControl * f(pawn.accelRate));
      const delta = scale(add(pawn.velocity, scale(direction, limit)), dt); delta[2] = 0;
      if (pawn.airControlBlocked(delta)) airControl = f(.05);
    }
    let accelerationLimit = f(airControl * f(pawn.accelRate));
    acceleration[2] = 0;
    const horizontalSpeed = Math.sqrt(pawn.velocity[0] ** 2 + pawn.velocity[1] ** 2);
    if (horizontalSpeed < 10) accelerationLimit = f(accelerationLimit + (10 - horizontalSpeed) / dt);
    else if (horizontalSpeed >= f(pawn.groundSpeed)) {
      if (airControl <= f(.05)) accelerationLimit = 1;
      else speedLimit = f(horizontalSpeed);
    }
    if (dot(acceleration, acceleration) > accelerationLimit * accelerationLimit) acceleration = scale(safeNormal(acceleration), accelerationLimit);
    pawn.acceleration = acceleration;
  }
  let remaining = dt, apexSplit = false, numBounces = 0;
  while (remaining > 0 && iterations < 8) {
    iterations++;
    let step = remaining > .1 ? f(Math.min(remaining * .5, f(.1))) : remaining;
    const origin = [...pawn.position], oldVelocity = [...pawn.velocity];
    // 0x103d0ee2: every substep starts with OldLocation = Location (read by
    // startSwimming's water-line search) and clears bJustTeleported.
    pawn.oldLocation = [...origin];
    pawn.justTeleported = false;
    remaining = f(remaining - step);
    // 0x103d0f2f: the integration branches on Region.Zone->bWaterZone (fluid
    // friction and buoyancy, 0x103d125a) and, for a PlayerPawn falling with its
    // FootRegion in water, on 0x103d1039. Neither is translated; hosts that
    // expose the zone flags (the script pawn view) stop here explicitly.
    if (pawn.regionWater === true)
      throw new Error('Original physFalling water-zone integration (Region.Zone->bWaterZone, 0x103d0f35 -> 0x103d125a) is not translated');
    // 0x103d0f42-0x103d0f6f: otherwise an IsA(ADecoration) source (class walk
    // for 0x10578d48) with bBobbing set (`test byte [actor+0x31c], 8`)
    // integrates half gravity at 0x103d0f75-0x103d1034. Not translated; hosts
    // that expose `bobbing` (runSpawnedActorFalling, Decoration ancestry)
    // stop here, re-read every substep as the native does.
    if (pawn.bobbing === true)
      throw new Error('Original physFalling Decoration bBobbing integration (IsA(ADecoration) && bBobbing, 0x103d0f42 -> 0x103d0f75) is not translated');
    if (!nonPawn && pawn.isPlayerPawn && pawn.footWater === true && !(oldVelocity[2] >= 0))
      throw new Error('Original physFalling PlayerPawn foot-in-water integration (0x103d1039) is not translated');
    // Each integration re-reads the actor's Acceleration (actor+0x150), which the
    // Pawn prelude stored clamped; a script event may have changed it since.
    const integrate = () => add(oldVelocity, scale(scale(add(pawn.acceleration, gravity), .5), step));
    pawn.velocity = integrate();
    if (!apexSplit && (oldVelocity[2] > 0) !== (pawn.velocity[2] > 0) && Math.abs(oldVelocity[2]) > 5 && Math.abs(pawn.velocity[2]) > 5) {
      apexSplit = true;
      const ratio = Math.abs(oldVelocity[2]) / (Math.abs(oldVelocity[2]) + Math.abs(pawn.velocity[2]));
      const first = ratio * step, second = (1 - ratio) * step;
      if (first > .015 && second > .015) {
        remaining = f(remaining + second); step = f(first); pawn.velocity = integrate();
      }
    } else apexSplit = false;
    if (speedLimit && pawn.velocity[0] ** 2 + pawn.velocity[1] ** 2 > speedLimit * speedLimit) {
      const limited = scale(safeNormal([pawn.velocity[0], pawn.velocity[1], 0]), speedLimit);
      pawn.velocity = [limited[0], limited[1], pawn.velocity[2]];
    }
    const delta = scale(add(pawn.velocity, zoneVelocity), step);
    let hit = pawn.move(delta);
    // 0x103d1ca2: a MoveActor whose touch/bump events destroyed the actor
    // (bDeleteMe, actor+0x28 bit 0x80) ends physics without restoring anything.
    if (pawn.bDeleteMe) return;
    // 0x103d1cac-0x103d1cf0: a Pawn whose MoveActor left PHYS_Swimming (a
    // script ZoneChange) refunds (1 - Hit.Time) * TimeTick and hands off to
    // startSwimming(OldVelocity, TimeTick, RemainingTime, Iterations), without
    // restoring Acceleration.
    if (!nonPawn && pawn.physics === 3) {
      remaining = refundTime(remaining, hit.time, step);
      if (typeof pawn.startSwimming !== 'function')
        throw new Error('physFalling entered PHYS_Swimming without the startSwimming service (0x103d1cf0)');
      pawn.startSwimming([...oldVelocity], step, remaining, iterations);
      return;
    }
    const blocked = hit.time < 1;
    if (blocked) {
      if (bouncing()) {
        requireHitWallEvent();
        hitWallEvent([...hit.normal], hit.actor ?? null);
        if (pawn.physics === PHYS_NONE) return;
        if (numBounces < 2) remaining = refundTime(remaining, hit.time, step);
        numBounces++;
      } else if (hit.normal[2] > .7) {
        remaining = refundTime(remaining, hit.time, step);
        if (!pawn.justTeleported && hit.time > .1 && hit.time * step > f(.003)) {
          pawn.velocity = scale(sub(pawn.position, origin), 1 / (hit.time * step));
        }
        pawn.landed(hit, remaining, iterations);
        return;
      } else {
        pawn.hitWall(hit);
        const oldNormal = [...hit.normal];
        let slide = scale(sub(delta, scale(hit.normal, dot(delta, hit.normal))), 1 - hit.time);
        if (dot(slide, delta) >= 0) {
          hit = pawn.move(slide);
          if (hit.time < 1) {
            if (hit.normal[2] > .7) { pawn.landed(hit, 0, iterations); return; }
            pawn.hitWall(hit);
            slide = twoWallAdjust({ desired: safeNormal(delta), delta: slide, normal: hit.normal, oldNormal, time: hit.time });
            const ditch = oldNormal[2] > 0 && hit.normal[2] > 0 && slide[2] === 0 && dot(oldNormal, hit.normal) < 0;
            hit = pawn.move(slide);
            if (ditch || hit.normal[2] > .7) { pawn.landed(hit, 0, iterations); return; }
          }
        }
        const traveledVelocity = scale(sub(pawn.position, origin), 1 / step);
        oldVelocity[0] = traveledVelocity[0]; oldVelocity[1] = traveledVelocity[1];
      }
    }
    // 0x103d22ce: bBounce and bJustTeleported are re-read after the substep's
    // events. A bouncing actor that was blocked keeps the Velocity its HitWall left.
    if (blocked && bouncing()) continue;
    if (!pawn.justTeleported) {
      pawn.velocity = sub(scale(sub(pawn.position, origin), 1 / step), zoneVelocity);
      if (pawn.velocity[2] < oldVelocity[2] || oldVelocity[2] >= 0) pawn.velocity = sub(scale(pawn.velocity, 2), oldVelocity);
      if (f(dot(pawn.velocity, pawn.velocity)) > f(pawn.terminalVelocity) ** 2) pawn.velocity = scale(safeNormal(pawn.velocity), f(pawn.terminalVelocity));
    }
  }
  pawn.acceleration = savedAcceleration;
}
