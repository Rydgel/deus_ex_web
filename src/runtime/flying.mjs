/** Original APawn::physFlying (Engine.dll 0x103d3040) and the accelerating,
 * single-player path of APawn::calcVelocity (0x103cd7a0) that it calls.
 *
 * Every expression follows the native's x87 store pattern through the 80-bit
 * model: values the native keeps on the FPU stack stay extended, and every
 * FSTP/float argument rounds once. Core FVector helpers are modeled from their
 * bodies: SizeSquared 0x10117b70 returns the extended dot product; Size
 * 0x10117b30 is fsqrt of that dot stored as a double; operator/ 0x10117800
 * multiplies by an extended 1/s; operator*, operator*= and operator+ store one
 * float per component.
 *
 * Evidence, constants and branch map: docs/ladder-flying.md. The comparison
 * against the original is scripts/validate-native-flying.mjs. */
import { stepUp, twoWallAdjust } from './steps.mjs';
import {
  x87add, x87cmp, x87div, x87double, x87int32, x87load as L, x87mul, x87neg,
  x87safeNormal, x87sqrt, x87store as S, x87storeDouble,
} from './script-vm.mjs';

const f = Math.fround;
const sub = (a, b) => x87add(a, x87neg(b));
const dot = (a, b) => x87add(x87add(x87mul(a[0], b[0]), x87mul(a[1], b[1])), x87mul(a[2], b[2]));
const loads = v => v.map(c => L(f(c)));
// FCOM condition codes as the native tests them: C0 (below or unordered).
const below = (a, b) => { const c = x87cmp(a, b); return c === 'lt' || c === 'un'; };
// `fcomp 0.0; test ah,0x40` (C3): equal, or unordered, reads as zero.
const zeroComponent = c => { const r = x87cmp(L(f(c)), ZERO); return r === 'eq' || r === 'un'; };
const ZERO = L(0), ONE = x87double(1), ONE_F = L(1), POINT3_F = L(f(.3));
const D009 = x87double(.09), D02 = x87double(.2), D05 = x87double(.5), DM02 = x87double(-.2);
const ZONE_SPEED_SQUARED = L(90000);
const boundary = message => { throw new Error(`Original flying physics boundary: ${message}`); };

/** APawn::calcVelocity accelerating path (bBrake=0, or nonzero Acceleration)
 * with the NetMode==0 speed clamp (0x103ce0cb). Reads/writes pawn.velocity and
 * pawn.acceleration. `pawn.isPlayerPawn` is IsA(PlayerPawn) (class chain
 * 0x1058c160), not bIsPlayer. */
export function calcVelocity(pawn, { direction, dt, maxSpeed, friction, fluid, brake = 0, buoyant = 0 }) {
  if (pawn.netMode) boundary('calcVelocity network speed clamp (NetMode != 0, 0x103cdfb7)');
  const d = direction.map(f), step = f(dt), rawFriction = f(friction);
  let max = f(maxSpeed);
  // 0x103cd7bb: FILD bFluid; FCOM Friction -> the larger (Friction on C0).
  const frictionUsed = below(x87int32(fluid), L(rawFriction)) ? rawFriction : f(fluid | 0);
  const walking = Boolean(pawn.isPlayerPawn && pawn.isWalking);
  if (brake && pawn.acceleration.every(zeroComponent))
    boundary('calcVelocity braking substeps (bBrake with zero Acceleration; walking.mjs owns that caller)');

  let velocity = pawn.velocity.map(f), acceleration = pawn.acceleration.map(f);
  // 0x103cdc1f: speed = f(appSqrt(double(V.V))).
  const speed = S(x87sqrt(x87storeDouble(dot(loads(velocity), loads(velocity)))));
  const rate = L(f(pawn.accelRate)), accelSquared = dot(loads(acceleration), loads(acceleration));
  if (walking) {
    if (below(x87mul(x87mul(rate, rate), D009), accelSquared))
      acceleration = d.map(c => S(x87mul(L(S(x87mul(L(c), rate))), POINT3_F)));
  } else if (below(x87mul(rate, rate), accelSquared)) {
    acceleration = d.map(c => S(x87mul(L(c), rate)));
  }
  pawn.acceleration = acceleration;
  // 0x103cdd99..0x103cde6a: V = V - ((V - d*speed)*dt)*F, one store per operator.
  const toward = d.map(c => S(x87mul(L(c), L(speed))));
  const scaled = velocity.map((v, i) => S(x87mul(L(S(x87mul(L(S(sub(L(v), L(toward[i])))), L(step)))), L(frictionUsed))));
  velocity = velocity.map((v, i) => S(sub(L(v), L(scaled[i]))));
  // 0x103cde6d..0x103cdf02: V = f(V * (1 - bFluid*dt*Friction)) + f(A*dt).
  const accelStep = acceleration.map(c => S(x87mul(L(step), L(c))));
  const decay = sub(ONE_F, x87mul(x87mul(x87int32(fluid), L(step)), L(rawFriction)));
  velocity = velocity.map((v, i) => S(x87add(L(accelStep[i]), L(S(x87mul(decay, L(v)))))));
  // 0x103cdf05: non-PlayerPawn MaxSpeed *= DesiredSpeed.
  if (!pawn.isPlayerPawn) max = S(x87mul(L(max), L(f(pawn.desiredSpeed))));
  if (buoyant) {
    // 0x103cdf33: V += (ZoneGravity*dt) * f(1 - Buoyancy/Mass).
    const gravityStep = pawn.gravity.map(g => S(x87mul(L(step), L(f(g)))));
    const lift = S(sub(ONE, x87div(L(f(pawn.buoyancy)), L(f(pawn.mass)))));
    velocity = velocity.map((v, i) => S(x87add(L(S(x87mul(L(lift), L(gravityStep[i])))), L(v))));
  }
  // 0x103ce0cb: single-player clamp.
  let clamped = false;
  if (walking) {
    const sizeSquared = S(dot(loads(velocity), loads(velocity)));
    if (below(x87mul(x87mul(L(max), L(max)), D009), L(sizeSquared))) {
      const size = S(x87sqrt(x87storeDouble(dot(loads(velocity), loads(velocity)))));
      const reciprocal = x87div(ONE, L(size));
      velocity = velocity.map(v => S(x87mul(reciprocal, L(v))));
      const twiceFriction = x87mul(L(frictionUsed), L(step));
      const limited = x87mul(sub(ONE_F, x87add(twiceFriction, twiceFriction)), L(size));
      const floor = x87mul(L(max), POINT3_F);
      const scale = below(floor, limited) ? S(limited) : S(floor);
      velocity = velocity.map(v => S(x87mul(L(scale), L(v))));
      clamped = true;
    }
  }
  if (!clamped) {
    const sizeSquared = S(dot(loads(velocity), loads(velocity)));
    if (below(x87mul(L(max), L(max)), L(sizeSquared)))
      velocity = x87safeNormal(velocity).map(v => S(x87mul(L(max), L(v))));
  }
  pawn.velocity = velocity;
  return { velocity, acceleration };
}

/** APawn::physFlying(DeltaTime, Iterations). The pawn supplies move(delta)
 * -> {time, normal, actor}, hitWall(hit) (processHitWall), and the stepUp
 * interface of steps.mjs. `zoneGravityZ`, `zoneVelocity`, `fluidFriction`
 * are Region.Zone fields; `airSpeed`, `accelRate`, `desiredSpeed` Pawn
 * fields. */
export function physFlying(pawn, seconds, iterations = 0) {
  const dt = f(seconds);
  if (!(dt > 0)) boundary(`physFlying requires a positive timestep, got ${seconds}`);
  // 0x103d306c: bCollideWorld && Region.ZoneNumber == 0 logs and destroys
  // non-players. Not translated.
  if (pawn.collideWorld && pawn.zoneNumber === 0) boundary('"%s flew out of the world!" (Region.ZoneNumber 0, 0x103d3083)');
  const acceleration = pawn.acceleration.map(f);
  const direction = acceleration.every(zeroComponent) ? acceleration : x87safeNormal(acceleration);
  calcVelocity(pawn, { direction, dt, maxSpeed: pawn.airSpeed, friction: pawn.fluidFriction, fluid: 1, brake: 0, buoyant: 0 });
  pawn.oldLocation = pawn.position.map(f);
  pawn.justTeleported = false;
  // 0x103d318f: PlayerPawn, or |ZoneVelocity|^2 > 90000, adds ZoneVelocity.
  const zoneVelocity = pawn.zoneVelocity.map(f);
  const zone = pawn.isPlayerPawn || x87cmp(dot(loads(zoneVelocity), loads(zoneVelocity)), ZONE_SPEED_SQUARED) === 'gt'
    ? zoneVelocity : [0, 0, 0];
  const velocity = pawn.velocity.map(f);
  // 0x103d3229: X/Y sums are stored before *dt; the Z sum stays extended.
  const sumX = S(x87add(L(zone[0]), L(velocity[0]))), sumY = S(x87add(L(zone[1]), L(velocity[1])));
  const sumZ = x87add(L(zone[2]), L(velocity[2]));
  const delta = [S(x87mul(L(sumX), L(dt))), S(x87mul(L(sumY), L(dt))), S(x87mul(sumZ, L(dt)))];
  let hit = pawn.move(delta);
  if (below(L(f(hit.time)), ONE)) {
    // 0x103d3306: GravDir.Z is +1 only when ZoneGravity.Z > 0.
    const gravityZ = x87cmp(L(f(pawn.zoneGravityZ)), ZERO) === 'gt' ? 1 : -1;
    const desired = x87safeNormal(delta);
    const velocityDirection = x87safeNormal(pawn.velocity.map(f));
    const upDown = x87mul(L(velocityDirection[2]), L(gravityZ));
    let normalZ = L(f(hit.normal[2]));
    if (below(normalZ, ZERO)) normalZ = x87neg(normalZ);
    const ascending = x87cmp(upDown, DM02);
    if (below(normalZ, D02) && below(upDown, D05) && ascending === 'gt') {
      const remaining = S(sub(ONE, L(f(hit.time))));
      const stepDelta = delta.map(c => S(x87mul(L(c), L(remaining))));
      const stepZ = f(pawn.position[2]);
      stepUp(pawn, [0, 0, gravityZ], desired, stepDelta);
      const old = pawn.oldLocation.map(f);
      old[2] = S(x87add(sub(L(old[2]), L(stepZ)), L(f(pawn.position[2]))));
      pawn.oldLocation = old;
    } else {
      pawn.hitWall(hit);
      const normal = hit.normal.map(f), oldNormal = [...normal];
      const into = dot(loads(normal), loads(delta));
      const z = S(sub(L(delta[2]), L(S(x87mul(into, L(normal[2]))))));
      const y = S(sub(L(delta[1]), L(S(x87mul(L(normal[1]), into)))));
      const x = sub(L(delta[0]), x87mul(into, L(normal[0])));
      const remaining = sub(ONE, L(f(hit.time)));
      const slideX = x87mul(x, remaining);
      const slide = [S(slideX), S(x87mul(L(y), remaining)), S(x87mul(L(z), remaining))];
      const progress = x87add(x87add(x87mul(L(delta[2]), L(slide[2])), x87mul(L(delta[1]), L(slide[1]))),
        x87mul(slideX, L(delta[0])));
      if (!below(progress, ZERO)) {
        hit = pawn.move(slide);
        if (below(L(f(hit.time)), ONE)) {
          pawn.hitWall(hit);
          pawn.move(twoWallAdjust({ desired, delta: slide, normal: hit.normal, oldNormal, time: hit.time }));
        }
      }
    }
  }
  if (!pawn.justTeleported) {
    // 0x103d360a: X stays extended into the reciprocal product; Y/Z are
    // stored first and multiply the float-stored reciprocal.
    const position = pawn.position.map(f), old = pawn.oldLocation.map(f);
    const dx = sub(L(position[0]), L(old[0]));
    const dy = S(sub(L(position[1]), L(old[1]))), dz = S(sub(L(position[2]), L(old[2])));
    const reciprocal = x87div(ONE, L(dt)), stored = S(reciprocal);
    pawn.velocity = [S(x87mul(reciprocal, dx)), S(x87mul(L(dy), L(stored))), S(x87mul(L(dz), L(stored)))];
  }
  return iterations;
}
