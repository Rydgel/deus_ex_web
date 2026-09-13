import { safeNormal, twoWallAdjust } from './steps.mjs';

const f = Math.fround;
const PHYS_NONE = 0, PHYS_FALLING = 2, PHYS_ROLLING = 7;
const add = (a, b) => a.map((v, i) => f(v + b[i]));
const sub = (a, b) => a.map((v, i) => f(v - b[i]));
const scale = (a, s) => a.map(v => f(v * s));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const size = a => Math.sqrt((a[0] * a[0] + a[1] * a[1]) + a[2] * a[2]);
const size2D = a => Math.sqrt(a[0] * a[0] + a[1] * a[1]);

/** Original AActor.physRolling (Engine.dll body 0x103d4b80, thunk 0x10301109).
 *
 * Rolling/sliding physics for a non-Pawn actor resting on a floor: ground/fluid
 * friction, a per-substep horizontal MoveActor with HitWall sliding, a downward
 * floor probe with slope-slide, and a falling transition when no floor is found.
 * This entry point is source-type independent (it performs no Pawn/Decoration
 * ancestry test); the Pawn-only branches live in processHitWall/processLanded.
 *
 * Recovered contract (docs/rolling.md):
 *   - ZoneGroundFriction = ZoneInfo+0x334, ZoneFluidFriction = +0x338,
 *     ZoneVelocity = +0x328, ZoneGravity = +0x31c (same layout as physFalling).
 *   - Initial friction: Velocity -= (Velocity.SafeNormal - Accel.SafeNormal) *
 *     Velocity.Size() * dt * ZoneGroundFriction; then
 *     Velocity = Velocity*(1 - ZoneFluidFriction*dt) + Acceleration*dt.
 *   - Substep 0.1s loop, at most 8 iterations, exactly as the source order.
 *   - Down = (ZoneGravity.Z > 0 ? +1 : -1) * 16; slope slide uses
 *     (dt*ZoneGravity/(2*max(0.5,ZoneGroundFriction)))*dt when Normal.Z < 1 and
 *     Normal.Z*ZoneGroundFriction < 3.3.
 *   - Physics==Rolling after a Falling event defaults to PHYS_Falling; only
 *     PHYS_Falling then recurses into physFalling and returns immediately.
 *
 * Caller-supplied services are explicit boundaries, mirroring falling.mjs:
 * `move(delta)` commits the original MoveActor translation and returns
 * {time, normal, actor}; `eventHitWall`, `eventFalling`, `setPhysics`,
 * `physFalling` and `setBase` are the reached native/script callbacks. The
 * bBounce branch is explicit: pass `bounce` to select it, otherwise the slide
 * response runs. A caller that has not established those services must not
 * invoke this path (the decoration adapter keeps them explicit).
 */
export function rolling(host, seconds, { zone, move, eventHitWall, eventFalling, setPhysics, physFalling, setBase, iterations = 0, bounce = false }) {
  const dt = f(seconds);
  if (!(dt > 0) || dt > f(.4)) throw new Error('Rolling requires an original actor timestep in (0, 0.4]');
  if (!host || !move || !eventHitWall || !eventFalling || !setPhysics || !physFalling || !setBase)
    throw new Error('Rolling requires explicit move/event/physics/setBase services');

  const zoneGravity = (zone.ZoneGravity ?? [0, 0, -950]).map(f);
  const zoneVelocity = (zone.ZoneVelocity ?? [0, 0, 0]).map(f);
  const groundFriction = f(zone.ZoneGroundFriction ?? 8);
  const fluidFriction = f(zone.ZoneFluidFriction ?? .02);

  let velocity = (host.velocity ?? [0, 0, 0]).map(f);
  const acceleration = (host.acceleration ?? [0, 0, 0]).map(f);

  // Original friction prelude 0x103d4bd7-0x103d4d52 (exact x87 model):
  //   d = f(VelDir - AccelDir)
  //   X product = (d*Size)*dt*gf          (full double, rounded at the store)
  //   Y/Z product = f(f(f(d*Size)*dt)*gf) (rounded after each multiply)
  //   Velocity = f(Velocity - f(product))
  //   fac = 1 - ZoneFluidFriction*dt      (extended)
  //   X/Y Velocity = f(f(Velocity*fac) + f(Acceleration*dt))
  //   Z Velocity   = f(dt*Acceleration + f(Velocity*fac))  (its dt*Accel stays extended)
  const velDir = safeNormal(velocity);
  const accelDir = safeNormal(acceleration);
  const velSize = size(velocity);
  const groundProducts = velocity.map((value, axis) => {
    const diff = f(velDir[axis] - accelDir[axis]);
    return axis === 0 ? (diff * velSize) * dt * groundFriction : f(f(f(diff * velSize) * dt) * groundFriction);
  });
  const frictionVelocity = velocity.map((value, axis) => f(value - f(groundProducts[axis])));
  const fluidFactor = 1 - fluidFriction * dt;
  velocity = frictionVelocity.map((value, axis) => axis === 2
    ? f(dt * acceleration[2] + f(value * fluidFactor))
    : f(f(value * fluidFactor) + f(acceleration[axis] * dt)));
  const desiredMove = add(velocity, zoneVelocity);
  const oldLocation = host.position.map(f);
  host.justTeleported = false;

  const down = scale(zoneGravity[2] > 0 ? [0, 0, 1] : [0, 0, -1], 16);
  let remainingTime = dt, numBounces = 0;

  while (remainingTime > 0 && iterations < 8) {
    iterations++;
    const timeTick = remainingTime > .1 ? f(Math.min(.1, f(remainingTime * .5))) : remainingTime;
    remainingTime = f(remainingTime - timeTick);
    let delta = scale(desiredMove, timeTick);
    const subMove = delta.slice();
    const subLoc = host.position.map(f);
    const nearlyZero = Math.abs(delta[0]) < 1e-4 && Math.abs(delta[1]) < 1e-4 && Math.abs(delta[2]) < 1e-4;
    if (!nearlyZero) {
      let hit = move(delta);
      if (hit.time < 1) {
        eventHitWall(hit.normal, hit.actor);
        if (bounce) {
          // Original bBounce branch 0x103d4fdc-0x103d4ff7: eventHitWall (dispatched
          // above, unconditionally), then for the first two bounces refund the
          // unspent time and skip the slide entirely (jmp to the floor drop). The
          // refund `remainingTime + (1-Hit.Time)*timeTick` is formed by `fsubr 1.0`
          // and kept on the x87 stack — (1-Hit.Time), the timeTick product and the
          // accumulation stay extended until a single float32 store at 0x103d4ff1.
          // A stepped f(timeTick*f(1-hit.time)) double-rounds; keep it one add like
          // the falling-time refund at the end of this loop.
          if (numBounces < 2) remainingTime = f(remainingTime + (1 - hit.time) * timeTick);
          numBounces++;
        } else {
          const originalDelta = delta.slice();
          const oldHitNormal = hit.normal.map(f);
          // Original 0x103d50a4-0x103d50d4: (1-Hit.Time) is formed by `fsubr 1.0` and
          // kept on the x87 stack (never stored to float32) for the slide scale. Since
          // Hit.Time is float32, 1-Hit.Time is exact; rounding it to float32 first left
          // a sub-ULP residual on the reflected delta (falling.mjs keeps it extended).
          delta = scale(sub(delta, scale(hit.normal, dot(delta, hit.normal))), 1 - hit.time);
          if (dot(delta, originalDelta) >= 0) {
            hit = move(delta);
            if (hit.time < 1) {
              eventHitWall(hit.normal, hit.actor);
              delta = twoWallAdjust({ desired: safeNormal(desiredMove), delta, normal: hit.normal, oldNormal: oldHitNormal, time: hit.time });
              hit = move(delta);
            }
          }
        }
      }
    }

    // Drop to floor 0x103d525d-0x103d54c2.
    let hit = move(down);
    let dropTime = hit.time, dropHitZ = hit.normal[2];
    if (dropTime < 1 && hit.normal[2] < 1 && f(hit.normal[2] * groundFriction) < 3.3) {
      // Original slide 0x103d530e-0x103d538b: Max(0.5,ZoneGroundFriction) is
      // doubled and reciprocated in x87; each (dt*Gravity) component is stored
      // float32 before the reciprocal multiply and again before the second dt.
      const inverse = 1 / (2 * Math.max(.5, groundFriction));
      const slide = zoneGravity.map(value => f(f(f(dt * value) * inverse) * dt));
      delta = sub(slide, scale(hit.normal, dot(slide, hit.normal)));
      if (dot(delta, slide) >= 0) {
        hit = move(delta);
        dropHitZ = Math.max(dropHitZ, hit.normal[2]);
      }
    }

    if (dropTime === 1 || dropHitZ < .7) {
      // Falling transition 0x103d5500-0x103d57ad.
      move(scale(down, -dropTime));
      // Original 0x103d55fd/0x103d5668: DesiredDist is stored float32 before the
      // divide; ActualDist and the quotient stay on the x87 stack (extended).
      const desiredDist = f(size(subMove));
      const actualDist = size2D(sub(host.position, subLoc));
      // Original Min(1, ActualDist/DesiredDist): a zero-length desired move (0/0)
      // is capped to 1, i.e. no remaining-time refund. The original keeps the
      // ActualDist/DesiredDist quotient on the x87 stack (64-bit mantissa) through
      // (1-Travel)*timeTick before the single float32 store at 0x103d569d; an f64
      // quotient (53-bit) double-rounds and can flip that store by one ULP. Recover
      // the quotient's low word with a fma-free two-product remainder so `1-Travel`
      // carries the original extended precision into the float32 round.
      const travel = desiredDist === 0 ? 1 : Math.min(1, actualDist / desiredDist);
      const oneMinusTravel = 1 - travel;
      remainingTime = f(remainingTime + oneMinusTravel * timeTick);
      eventFalling();
      if (host.physics === PHYS_ROLLING) setPhysics(PHYS_FALLING);
      if (host.physics === PHYS_FALLING) {
        if (!host.justTeleported && dt > remainingTime)
          // Original 0x103d571a-0x103d573d: `fld dt; fsub remainingTime` keeps the
          // divisor extended (the f32 difference is exact), `fdivr 1.0` then `fst`
          // rounds the reciprocal to a float32 temporary that the per-component
          // multiplies reload, and each Location-OldLocation difference is stored
          // float32 first. Rounding the divisor to float32 first tipped the
          // reciprocal by one ULP on boundary cases; only the reciprocal is f32.
          velocity = scale(sub(host.position, oldLocation), f(1 / (dt - remainingTime)));
        velocity = [velocity[0], velocity[1], 0];
        host.velocity = velocity.slice();
        if (remainingTime > .005) physFalling(remainingTime, iterations);
        return;
      }
      move(scale(desiredMove, remainingTime));
    } else {
      const actor = hit.actor ?? null;
      if (actor !== (host.base ?? null)) setBase(actor);
    }
  }
  if (!host.justTeleported) host.velocity = scale(sub(host.position, oldLocation), 1 / dt);
}

export { PHYS_NONE, PHYS_FALLING, PHYS_ROLLING };
