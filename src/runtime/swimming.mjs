/** Original PHYS_Swimming: APawn::startSwimming (Engine.dll 0x103d2b70),
 * APawn::physSwimming (0x103d3cd0), APawn::Swim (0x103d3850) and
 * APawn::findWaterLine (0x103d3b10). calcVelocity (bFluid=1, bBuoyant=1) is
 * the shared flying.mjs translation.
 *
 * Every expression follows the native's x87 store pattern through the 80-bit
 * model: values the native keeps on the FPU stack stay extended, and every
 * FSTP/float argument rounds once. Size() and Size2D() are Core's
 * `fsqrt(double(dot))` (0x10117b30, 0x10117ba0, appSqrt 0x10123290); the
 * inlined copies in these bodies have the same shape but their own summation
 * orders, which are kept per site.
 *
 * World and event services are the pawn's: move(delta) is ULevel::MoveActor
 * (vtable +0x88) returning {time, normal, actor}; waterAt(position) is
 * UModel::PointRegion(...).Zone->bWaterZone; regionWater/headWater are
 * Region.Zone/HeadRegion.Zone->bWaterZone as MoveActor's SetActorZone left
 * them; walkingPrelude, hitWall (processHitWall), setPhysics, falling and
 * flying are the linked original bodies; stepUp/twoWallAdjust come from
 * steps.mjs with the pawn's move/hitWall.
 *
 * Evidence, constants and branch map: docs/swimming.md. The comparison
 * against the original is scripts/validate-native-swimming.mjs. */
import { calcVelocity } from './flying.mjs';
import { stepUp, twoWallAdjust } from './steps.mjs';
import {
  x87add, x87cmp, x87div, x87double, x87load as L, x87mul, x87neg, x87quiet,
  x87safeNormal, x87sqrt, x87store as S, x87storeDouble,
} from './script-vm.mjs';

const f = Math.fround;
const sub = (a, b) => x87add(a, x87neg(b));
// FCOM condition codes as the native tests them: C0 (below or unordered).
const below = (a, b) => { const c = x87cmp(a, b); return c === 'lt' || c === 'un'; };
const above = (a, b) => x87cmp(a, b) === 'gt';
// `fcomp 0.0; test ah,0x40` (C3): equal, or unordered, reads as zero.
const zeroComponent = c => { const r = x87cmp(L(f(c)), ZERO); return r === 'eq' || r === 'un'; };
// `fld a; fcomp b; test ah,0x40; je differ` on each component: a vector is
// "unchanged" when every component compares equal or unordered.
const sameVector = (a, b) => a.every((c, i) => { const r = x87cmp(L(f(c)), L(f(b[i]))); return r === 'eq' || r === 'un'; });
// appSqrt(double) = `fld qword; fsqrt; ret`: the extended root of the double.
const sqrtDouble = v => v.nan !== undefined ? x87quiet(v) : x87sqrt(x87storeDouble(v));
// Inlined (a.x*a.x + a.y*a.y) + a.z*a.z over extended components.
const squares = ([x, y, z]) => x87add(x87add(x87mul(x, x), x87mul(y, y)), x87mul(z, z));
const differences = (a, b) => a.map((c, i) => sub(L(f(c)), L(f(b[i]))));

const ZERO = L(0), ONE = x87double(1), ONE_F = L(1), HALF_F = L(.5), K25 = L(25), K100 = L(100);
const K160 = L(160), KM160 = L(-160), K4000 = L(4000), ZONE_SPEED_SQUARED = L(90000);
const D001 = x87double(.01), D02 = x87double(.2), D05 = x87double(.5), DM02 = x87double(-.2);
const D04 = x87double(.4), D40 = x87double(40), D07 = x87double(.7), DM80 = x87double(-80);
const D16M = x87double(16000000);
const PHYS_FALLING = 2, PHYS_SWIMMING = 3, PHYS_FLYING = 4;
const boundary = message => { throw new Error(`Original swimming physics boundary: ${message}`); };

/** ULevel::MoveActor's early return (0x1039915a..0x10399240): each |Delta|
 * component below the double 1e-4 (unordered counts as below) with an
 * unchanged rotation returns before `Hit = FCheckResult(1)`, so the caller's
 * Hit keeps its previous contents. The pawn moves with its own Rotation. */
const X_SMALL = x87double(.0001);
const nearlyZero = delta => delta.every(c => below(L(f(Math.abs(c))), X_SMALL));
function moveInto(pawn, delta, hit) {
  const result = pawn.move(delta.map(f));
  return nearlyZero(delta) ? hit : { time: f(result.time), normal: result.normal.map(f), actor: result.actor ?? null };
}

/** APawn::findWaterLine(FVector Start, FVector& End) (0x103d3b10): bisect
 * Start..End until |End-Start|^2 < 1, keeping End on the side of the pawn's
 * current Region.Zone->bWaterZone. The native recursion is a tail call; this
 * loop re-reads Region.Zone each step as the native does. Returns End. */
export function findWaterLine(pawn, start, end) {
  start = start.map(f); end = end.map(f);
  for (;;) {
    // 0x103d3b37: extended (End-Start) squares against the double 1.0; C0
    // (below or unordered) returns.
    if (below(squares(differences(end, start)), ONE)) return end;
    // 0x103d3b76: MidPoint = 0.5*(Start+End). The Z sum stays extended; the
    // X/Y sums are stored before the float 0.5 multiply.
    const sumZ = x87add(L(start[2]), L(end[2]));
    const sumY = S(x87add(L(start[1]), L(end[1]))), sumX = S(x87add(L(start[0]), L(end[0])));
    const mid = [S(x87mul(L(sumX), HALF_F)), S(x87mul(L(sumY), HALF_F)), S(x87mul(sumZ, HALF_F))];
    // 0x103d3bde: PointRegion(Level, MidPoint).Zone->bWaterZone xor
    // Region.Zone->bWaterZone (bit 0 of ZoneInfo+0x388).
    // A midpoint that rounds onto the endpoint it replaces repeats the same
    // call forever (float spacing above 1 unit); the native recursion would
    // exhaust the stack there, which is not modeled.
    const toStart = Boolean(pawn.waterAt(mid)) !== Boolean(pawn.regionWater);
    if (mid.every((c, i) => c === (toStart ? start : end)[i]))
      boundary('findWaterLine does not converge: the midpoint rounds onto an endpoint');
    if (toStart) start = mid;                            // findWaterLine(MidPoint, End)
    else end = mid;                                      // End = MidPoint; findWaterLine(Start, End)
  }
}

/** APawn::Swim(FVector Delta, FCheckResult& Hit) (0x103d3850): move, and when
 * the move left the water, pull back to the water line and return the
 * fraction of Delta spent out of the water. Returns {airTime, hit}. */
export function swim(pawn, delta, hit) {
  const start = pawn.position.map(f);
  let airTime = 0;
  hit = moveInto(pawn, delta, hit);
  // 0x103d3905: Region.Zone->bWaterZone after MoveActor's zone update.
  if (!pawn.regionWater) {
    const location = pawn.position.map(f);
    const end = findWaterLine(pawn, start, location);
    if (!sameVector(end, location)) {
      // 0x103d395f: (End-Location).Size(), float-stored.
      const outside = S(sqrtDouble(squares(differences(end, location))));
      // 0x103d3998: Delta.Size() summed (Y*Y + Z*Z) + X*X, kept extended.
      const [dx, dy, dz] = delta.map(c => L(f(c)));
      const length = sqrtDouble(x87add(x87add(x87mul(dy, dy), x87mul(dz, dz)), x87mul(dx, dx)));
      airTime = S(x87div(L(outside), length));
      // 0x103d39e9: MoveActor(End - Location) into the same Hit.
      hit = moveInto(pawn, differences(end, location).map(S), hit);
    }
  }
  return { airTime, hit };
}

/** APawn::startSwimming(FVector OldVelocity, FLOAT timeTick, FLOAT
 * remainingTime, INT Iterations) (0x103d2b70), reached from physWalking and
 * physFalling when a MoveActor left Physics == PHYS_Swimming. */
export function startSwimming(pawn, oldVelocity, timeTick, remainingTime, iterations = 0) {
  const tick = f(timeTick);
  let remaining = f(remainingTime), waterTime = 0;
  const location = pawn.position.map(f);
  // 0x103d2bd6: End = Location; findWaterLine(OldLocation, End).
  const end = findWaterLine(pawn, pawn.oldLocation.map(f), location);
  if (!sameVector(end, location)) {
    // 0x103d2c0c: waterTime = timeTick*(End-Location).Size()/(Location-OldLocation).Size():
    // the first size is float-stored, the second stays extended as the divisor.
    const toEnd = S(sqrtDouble(squares(differences(end, location))));
    const travelled = sqrtDouble(squares(differences(location, pawn.oldLocation)));
    waterTime = S(x87div(x87mul(L(toEnd), L(tick)), travelled));
    remaining = S(x87add(L(waterTime), L(remaining)));
    // 0x103d2c88: a fresh Hit(1); MoveActor(End - Location); the Hit is unused.
    moveInto(pawn, differences(end, location).map(S), { time: 1, normal: [0, 0, 0], actor: null });
  }
  // 0x103d2d3b: neither bBounce (+0x1ec bit 0x10) nor bJustTeleported (0x100).
  if (!pawn.bounce && !pawn.justTeleported) {
    // Velocity = (Location-OldLocation)/(timeTick-waterTime): the differences
    // are stored, the reciprocal stays extended.
    const moved = differences(pawn.position, pawn.oldLocation).map(S);
    const reciprocal = x87div(ONE, sub(L(tick), L(waterTime)));
    let velocity = moved.map(c => S(x87mul(L(c), reciprocal)));
    // 0x103d2dcd: Velocity = 2*Velocity - OldVelocity, one store per operator.
    velocity = velocity.map(c => S(x87add(L(c), L(c))));
    velocity = velocity.map((c, i) => S(sub(L(c), L(f(oldVelocity[i])))));
    pawn.velocity = velocity;
    // 0x103d2e29: SizeSquared > 16000000 (double) -> SafeNormal * 4000.0f.
    if (above(squares(velocity.map(L)), D16M))
      pawn.velocity = x87safeNormal(velocity).map(c => S(x87mul(L(c), K4000)));
  }
  // 0x103d2e94: -160 < Velocity.Z < 0 -> Velocity.Z = -80 - Size2D()*0.7.
  const velocity = pawn.velocity.map(f);
  if (above(L(velocity[2]), KM160) && below(L(velocity[2]), ZERO)) {
    const size2d = sqrtDouble(x87add(x87mul(L(velocity[0]), L(velocity[0])), x87mul(L(velocity[1]), L(velocity[1]))));
    velocity[2] = S(sub(DM80, x87mul(size2d, D07)));
    pawn.velocity = velocity;
  }
  // 0x103d2edb: remainingTime > 0.01 (double) continues in the water.
  if (above(L(remaining), D001)) physSwimming(pawn, remaining, iterations);
}

/** The slide of a blocked move, physSwimming 0x103d40e5..0x103d4183 (the same
 * instruction pattern as physFlying 0x103d3465): Delta' =
 * (Delta - N*(Delta.N))*(1-Hit.Time) and the extended forward-progress dot. */
function slideAlong(delta, normal, time) {
  const into = x87add(x87add(x87mul(L(normal[1]), L(delta[1])), x87mul(L(normal[0]), L(delta[0]))),
    x87mul(L(delta[2]), L(normal[2])));
  const z = S(sub(L(delta[2]), L(S(x87mul(into, L(normal[2]))))));
  const y = S(sub(L(delta[1]), L(S(x87mul(L(normal[1]), into)))));
  const x = sub(L(delta[0]), x87mul(into, L(normal[0])));
  const remaining = sub(ONE, L(f(time)));
  const slideX = x87mul(x, remaining);
  const slide = [S(slideX), S(x87mul(L(y), remaining)), S(x87mul(L(z), remaining))];
  const progress = x87add(x87add(x87mul(L(delta[2]), L(slide[2])), x87mul(L(delta[1]), L(slide[1]))),
    x87mul(slideX, L(delta[0])));
  return { slide, forward: !below(progress, ZERO) };
}

/** APawn::physSwimming(FLOAT deltaTime, INT Iterations) (0x103d3cd0). */
export function physSwimming(pawn, seconds, iterations = 0) {
  const dt = f(seconds);
  if (!(dt > 0)) boundary(`physSwimming requires a positive timestep, got ${seconds}`);
  // 0x103d3cfc: the walking surface prelude with the caller's Iterations
  // (WalkTexture every tick; a Ladder hands over to physFlying).
  if (pawn.walkingPrelude(dt, iterations)) return;
  // 0x103d3d16: out of the water at the head, damp an upward Velocity.Z > 100.
  if (!pawn.headWater) {
    const velocity = pawn.velocity.map(f);
    if (above(L(velocity[2]), K100)) {
      velocity[2] = S(x87mul(sub(ONE_F, L(dt)), L(velocity[2])));
      pawn.velocity = velocity;
    }
  }
  iterations++;
  pawn.oldLocation = pawn.position.map(f);
  pawn.justTeleported = false;
  // 0x103d3d85: AccelDir is Acceleration when every component compares zero.
  const acceleration = pawn.acceleration.map(f);
  const direction = acceleration.every(zeroComponent) ? acceleration : x87safeNormal(acceleration);
  calcVelocity(pawn, { direction, dt, maxSpeed: pawn.waterSpeed, friction: pawn.fluidFriction, fluid: 1, brake: 0, buoyant: 1 });
  let velZ = f(pawn.velocity[2]);
  // 0x103d3e02: PlayerPawn, or |ZoneVelocity|^2 > 90000, adds
  // ZoneVelocity*25*deltaTime (X/Y products stored first; Z*25 extended).
  const zoneVelocity = pawn.zoneVelocity.map(f);
  let zone = [0, 0, 0];
  if (pawn.isPlayerPawn || above(squares(zoneVelocity.map(L)), ZONE_SPEED_SQUARED)) {
    zone = [S(x87mul(L(S(x87mul(L(zoneVelocity[0]), K25))), L(dt))),
      S(x87mul(L(S(x87mul(L(zoneVelocity[1]), K25))), L(dt))),
      S(x87mul(x87mul(L(zoneVelocity[2]), K25), L(dt)))];
  }
  // 0x103d3ee0: Delta = (Velocity + ZoneVel)*deltaTime; the Z sum stays extended.
  const velocity = pawn.velocity.map(f);
  const sumX = S(x87add(L(zone[0]), L(velocity[0]))), sumY = S(x87add(L(zone[1]), L(velocity[1])));
  const sumZ = x87add(L(zone[2]), L(velocity[2]));
  const delta = [S(x87mul(L(sumX), L(dt))), S(x87mul(L(sumY), L(dt))), S(x87mul(sumZ, L(dt)))];
  let hit = { time: 1, normal: [0, 0, 0], actor: null };
  let air;
  ({ airTime: air, hit } = swim(pawn, delta, hit));
  let remaining = S(x87mul(L(air), L(dt)));
  if (below(L(hit.time), ONE)) {
    // 0x103d3f8b: GravDir.Z is +1 only when Region.Zone->ZoneGravity.Z > 0.
    const gravityZ = above(L(f(pawn.zoneGravityZ)), ZERO) ? 1 : -1;
    const desired = x87safeNormal(delta);
    const velocityDirection = x87safeNormal(pawn.velocity.map(f));
    const upDown = x87mul(L(velocityDirection[2]), L(gravityZ));
    let normalZ = L(f(hit.normal[2]));
    if (below(normalZ, ZERO)) normalZ = x87neg(normalZ);
    if (below(normalZ, D02) && below(upDown, D05) && above(upDown, DM02)) {
      // 0x103d402b: stepUp(GravDir, DesiredDir, Delta*(1-Hit.Time), Hit).
      const factor = S(sub(ONE, L(f(hit.time))));
      const stepDelta = delta.map(c => S(x87mul(L(c), L(factor))));
      const stepZ = f(pawn.position[2]);
      stepUp(pawn, [0, 0, gravityZ], desired, stepDelta);
      const old = pawn.oldLocation.map(f);
      old[2] = S(x87add(sub(L(old[2]), L(stepZ)), L(f(pawn.position[2]))));
      pawn.oldLocation = old;
    } else {
      pawn.hitWall(hit);
      const oldNormal = hit.normal.map(f);
      const { slide, forward } = slideAlong(delta, oldNormal, hit.time);
      if (forward) {
        // 0x103d41b0: the post-Swim Hit.Time scales the remaining time.
        ({ airTime: air, hit } = swim(pawn, slide, hit));
        remaining = S(x87mul(x87mul(sub(ONE, L(f(hit.time))), L(air)), L(remaining)));
        if (below(L(f(hit.time)), ONE)) {
          pawn.hitWall(hit);
          const adjusted = twoWallAdjust({ desired, delta: slide, normal: hit.normal, oldNormal, time: hit.time });
          ({ airTime: air, hit } = swim(pawn, adjusted, hit));
          remaining = S(x87mul(x87mul(sub(ONE, L(f(hit.time))), L(air)), L(remaining)));
        }
      }
    }
  }
  // 0x103d424f: unless bJustTeleported, and when remainingTime < deltaTime,
  // Velocity = (Location-OldLocation)/(deltaTime-remainingTime), keeping a
  // Velocity.Z that changed since calcVelocity.
  if (!pawn.justTeleported && below(L(remaining), L(dt))) {
    const currentZ = f(pawn.velocity[2]), order = x87cmp(L(velZ), L(currentZ));
    const keepZ = order === 'lt' || order === 'gt';
    if (keepZ) velZ = currentZ;
    const position = pawn.position.map(f), old = pawn.oldLocation.map(f);
    const dz = sub(L(position[2]), L(old[2]));
    const dy = S(sub(L(position[1]), L(old[1]))), dx = S(sub(L(position[0]), L(old[0])));
    const reciprocal = x87div(ONE, sub(L(dt), L(remaining))), stored = S(reciprocal);
    const next = [S(x87mul(L(stored), L(dx))), S(x87mul(L(stored), L(dy))), S(x87mul(dz, reciprocal))];
    if (keepZ) next[2] = velZ;
    pawn.velocity = next;
  }
  // 0x103d4301: out of the water, Swimming becomes Falling; a slow rise
  // becomes Velocity.Z = 40 + Size2D*0.4 (inlined, (X*X + Y*Y)).
  if (!pawn.regionWater) {
    if (pawn.physics === PHYS_SWIMMING) pawn.setPhysics(PHYS_FALLING);
    const next = pawn.velocity.map(f);
    if (below(L(next[2]), K160) && above(L(next[2]), ZERO)) {
      const size2d = sqrtDouble(x87add(x87mul(L(next[0]), L(next[0])), x87mul(L(next[1]), L(next[1]))));
      next[2] = S(x87add(x87mul(size2d, D04), D40));
      pawn.velocity = next;
    }
  }
  // 0x103d437e: remainingTime > 0.01 continues in the new mode.
  if (above(L(remaining), D001)) {
    if (pawn.physics === PHYS_FALLING) pawn.falling(remaining, iterations);
    else if (pawn.physics === PHYS_FLYING) pawn.flying(remaining, iterations);
  }
  return iterations;
}
