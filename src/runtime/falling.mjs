import { safeNormal, twoWallAdjust } from './steps.mjs';
import { x87add, x87cmp, x87div, x87double, x87load, x87mul, x87neg, x87store } from './script-vm.mjs';
import { scriptVmKernel } from './script-vm-kernel.mjs';

const f = Math.fround;
const L = v => x87load(f(v)), S = x87store;
const sub87 = (a, b) => x87add(a, x87neg(b));
const ONE_F = L(1), HALF_F = L(.5), ZERO_F = L(0), ONE_D = x87double(1), D015 = x87double(.015);
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

const requireNumbers = (what, values) => {
  for (const [name, value] of Object.entries(values))
    if (typeof value !== 'number') throw new Error(`Original physFalling ${what} requires ${name} from the host`);
};

/** Region.Zone->bWaterZone integration, 0x103d125a (the apex copy 0x103d18dc
 * has the same store pattern): V = OldV*(1 - 2*F*dt)
 * + 0.5*((1 - Buoyancy/max(1,Mass))*G + A)*dt. `lift` and `k` stay on the x87
 * stack; every FVector operator stores one float per component. */
function waterVelocity(pawn, old, step, gravity, acceleration) {
  requireNumbers('water-zone integration', { mass: pawn.mass, buoyancy: pawn.buoyancy, fluidFriction: pawn.fluidFriction });
  const mass = L(pawn.mass);
  // fld Mass; fld 1.0f; fcomp st(1); test ah,1: C0 (1.0 < Mass, or a NaN Mass)
  // keeps Mass; Mass <= 1.0 divides by 1.0f.
  const order = x87cmp(ONE_F, mass), divisor = order === 'lt' || order === 'un' ? mass : ONE_F;
  const lift = sub87(ONE_D, x87div(L(pawn.buoyancy), divisor));   // fdivr m32; fsubr m64 1.0
  const term = gravity.map((g, i) =>
    S(x87mul(L(S(x87mul(L(S(x87add(L(S(x87mul(lift, L(g)))), L(acceleration[i])))), HALF_F))), L(step))));
  // 0x103d135c re-reads Region.Zone: fld dt; fmul F; fadd st0,st0; fsubr m32 1.0.
  const friction = x87mul(L(step), L(pawn.fluidFriction));
  const k = sub87(ONE_F, x87add(friction, friction));
  return old.map((v, i) => S(x87add(L(term[i]), L(S(x87mul(k, L(v)))))));
}

/** IsA(ADecoration) && bBobbing integration, 0x103d0f75 (apex 0x103d1558):
 * V = OldV + 0.5*(0.5*G + A)*dt. X/Y store after every operator; the first
 * copy keeps Z on the x87 stack until the final store, the apex copy stores Z
 * once after `*dt` and again after `+OldV.Z`. */
function bobbingVelocity(old, step, gravity, acceleration, apex) {
  const xy = [0, 1].map(i =>
    S(x87add(L(S(x87mul(L(S(x87mul(L(S(x87add(L(S(x87mul(L(gravity[i]), HALF_F))), L(acceleration[i])))), HALF_F))), L(step)))), L(old[i]))));
  const z = x87mul(x87mul(x87add(x87mul(L(gravity[2]), HALF_F), L(acceleration[2])), HALF_F), L(step));
  return [...xy, S(x87add(apex ? L(S(z)) : z, L(old[2])))];
}

/** PlayerPawn with FootRegion.Zone->bWaterZone and OldV.Z < 0, 0x103d1086 (apex
 * 0x103d168d): V = OldV*(1 - F_foot*dt) + 0.5*(G + A)*dt, F_foot read from
 * FootRegion.Zone, G from Region.Zone. The first copy keeps Z's gravity term
 * extended into the final sum; the apex copy stores every operator. */
function footWaterVelocity(pawn, old, step, gravity, acceleration, apex) {
  requireNumbers('PlayerPawn foot-water integration', { footFluidFriction: pawn.footFluidFriction });
  const k = sub87(ONE_F, x87mul(L(step), L(pawn.footFluidFriction)));   // fsubr m32 1.0
  const damped = old.map(v => S(x87mul(k, L(v))));
  const term = gravity.map((g, i) => L(S(x87mul(L(S(x87mul(L(S(x87add(L(g), L(acceleration[i])))), HALF_F))), L(step)))));
  if (!apex) term[2] = x87mul(x87mul(x87add(L(gravity[2]), L(acceleration[2])), HALF_F), L(step));
  return damped.map((d, i) => S(x87add(term[i], L(d))));
}

/** AActor.physFalling (Engine.dll 0x103d0a50): the Pawn (player) path, the
 * non-Pawn path, the bBounce wall-hit branch, and the four integrations (water
 * zone, Decoration bBobbing, PlayerPawn foot water, dry) with their apex
 * copies. World movement/queries and the reached engine/script events are
 * supplied by the caller; this function does not implement surface events or
 * landing fitting. A Pawn that a MoveActor left in PHYS_Swimming hands off to
 * the caller's `startSwimming` service (docs/swimming.md).
 *
 * Host fields read live at each integration (docs/swimming.md "physFalling
 * water paths"): `gravity`, `zoneVelocity`, `terminalVelocity` and
 * `regionWater` of Region.Zone; `mass`, `buoyancy` and Region.Zone's
 * `fluidFriction` when `regionWater`; `bobbing` (IsA(ADecoration) &&
 * bBobbing); `isPlayerPawn`, `footWater` and FootRegion.Zone's
 * `footFluidFriction` for a Pawn. A host without `regionWater` guarantees a
 * dry Region.Zone.
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
 *
 * Before that, a blocked move by a Decoration whose Hit.Actor IsA PlayerPawn
 * (0x103d1d1c-0x103d1d7b) lowers numLandings by one, floored at 0: the host's
 * `blockedBy(actor)` (decoration hosts only), for processLanded's footprint
 * block (landing.mjs decorationFootprint).
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
    // 0x103d0f2f-0x103d1157: the integration, chosen per substep from the live
    // actor and Region.Zone (docs/swimming.md "physFalling water paths"):
    // Region.Zone->bWaterZone first (any actor kind), then IsA(ADecoration) &&
    // bBobbing (hosts expose `bobbing` only for Decoration ancestry), then
    // IsA(PlayerPawn) && FootRegion.Zone->bWaterZone && OldVelocity.Z < 0 (C0:
    // NaN included), else dry. Hosts that never expose `regionWater` promise a
    // dry Region.Zone. Each integration re-reads Acceleration (actor+0x150; the
    // Pawn prelude stored it clamped, a script event may have changed it since)
    // and ZoneGravity (Region.Zone+0x31c).
    const integrate = apex => {
      const acceleration = pawn.acceleration.map(f), gravity = pawn.gravity.map(f);
      if (pawn.regionWater === true) return waterVelocity(pawn, oldVelocity, step, gravity, acceleration);
      if (pawn.bobbing === true) return bobbingVelocity(oldVelocity, step, gravity, acceleration, apex);
      if (!nonPawn && pawn.isPlayerPawn === true && pawn.footWater === true && !(oldVelocity[2] >= 0))
        return footWaterVelocity(pawn, oldVelocity, step, gravity, acceleration, apex);
      return add(oldVelocity, scale(scale(add(acceleration, gravity), .5), step));
    };
    pawn.velocity = integrate(false);
    // 0x103d13f0-0x103d150b: apex subdivision. |OldV.Z| and |V.Z| (fchs on C0),
    // ratio = |OldV.Z| / (|V.Z| + |OldV.Z|), first = ratio*dt and second =
    // (1.0f - ratio)*dt all stay extended and compare against the double 0.015;
    // TimeTick = f(first), RemainingTime = f(second + RemainingTime). The
    // re-integration re-tests the branches (0x103d150e) and runs their apex copies.
    if (!apexSplit && (oldVelocity[2] > 0) !== (pawn.velocity[2] > 0) && Math.abs(oldVelocity[2]) > 5 && Math.abs(pawn.velocity[2]) > 5) {
      apexSplit = true;
      const magnitude = v => { const x = L(v); return x87cmp(x, ZERO_F) === 'lt' ? x87neg(x) : x; };
      const ratio = x87div(magnitude(oldVelocity[2]), x87add(magnitude(pawn.velocity[2]), magnitude(oldVelocity[2])));
      const first = x87mul(ratio, L(step));
      if (x87cmp(first, D015) === 'gt') {
        const second = x87mul(sub87(ONE_F, ratio), L(step));
        if (x87cmp(second, D015) === 'gt') {
          step = S(first); remaining = S(x87add(second, L(remaining)));
          pawn.velocity = integrate(true);
        }
      }
    } else apexSplit = false;
    if (speedLimit && pawn.velocity[0] ** 2 + pawn.velocity[1] ** 2 > speedLimit * speedLimit) {
      const limited = scale(safeNormal([pawn.velocity[0], pawn.velocity[1], 0]), speedLimit);
      pawn.velocity = [limited[0], limited[1], pawn.velocity[2]];
    }
    // 0x103d1bb9: ZoneVelocity is read from Region.Zone each substep (the
    // non-player bIsPawn gate at 0x103d1b39 is not translated) and reused by
    // the end-of-substep velocity recomputation.
    const zoneVelocity = pawn.zoneVelocity.map(f);
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
      pawn.blockedBy?.(hit.actor ?? null);
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
