import { safeNormal } from './steps.mjs';
import { x87add, x87double, x87load, x87mul, x87neg, x87store } from './script-vm.mjs';

const f = Math.fround;

/** Original AActor.processLanded dry Pawn path (Engine.dll 0x103cef60).
 * World fitting, relocation, script events, physics changes, random values and
 * subsequent walking are explicit callbacks, not substitutes for those systems.
 * The zone-velocity bounce and non-Pawn branches are outside this entry point.
 */
export function processLanded(pawn, hit, remainingTime, iterations) {
  const extent = [f(pawn.radius), f(pawn.radius), f(pawn.height)];
  const start = pawn.position.map(f);
  const depth = f(extent[0] * .2 + 8);
  const end = [f(start[0] - 0), f(start[1] - 0), f(start[2] - depth)];
  const support = pawn.lineCheck(start, end, extent.map(value => f(value * f(.9))), 0x37, 0);
  if (f(support.time) === 1) {
    const fitted = pawn.findSpot([...start], extent.map(value => f(value * f(1.1))), 0, 0);
    if (fitted && fitted.some((value, axis) => f(value) !== start[axis])) {
      // The original ignores FarMoveActor's return value and keeps falling.
      pawn.farMove(fitted.map(f), 0, 0);
      const x = f(pawn.random() * 60 - 30 + pawn.velocity[0]);
      pawn.velocity = [x, pawn.velocity[1], pawn.velocity[2]];
      const y = f(pawn.random() * 60 - 30 + pawn.velocity[1]);
      pawn.velocity = [pawn.velocity[0], y, pawn.velocity[2]];
      return;
    }
  }
  pawn.landedEvent(hit.normal);
  if (pawn.physics === 2) pawn.setPhysics(1, hit.actor);
  if (pawn.physics === 1) {
    pawn.acceleration = safeNormal(pawn.acceleration);
    // This comparison is with the original double constant, not 0.01f.
    if (f(remainingTime) > .01) pawn.walking(f(remainingTime), iterations);
  }
}

/** Original AActor.processLanded non-Pawn (decoration) path (Engine.dll
 * 0x103cef60 -> IsA(Pawn) false -> 0x103cf597). After the bBounceVelocity zone
 * branch (zoneBounceLanding, when `{zone}` is passed), a decoration (IsA the
 * decoration class 0x10578d48) whose landing counter numLandings (+0x324) is
 * below 5 (signed) runs the footprint block (0x103cf5f7-0x103d0284,
 * decorationFootprint): it can push the decoration off an edge, or slide a
 * bSlidingCarcass down a slope, and then returns without Landed or
 * setPhysics. Otherwise the counter is reset (0x103d0289 or, at 5 or more,
 * 0x103d029b), the script Landed(HitNormal) event is dispatched and — only
 * while still PHYS_Falling after that event — setPhysics(PHYS_None) rebases
 * the decoration onto the floor actor and zeroes its velocity and acceleration
 * (0x103c95f0). The host supplies `lineCheck(start, end, extent, flags, extra)`
 * (ULevel::SingleLineCheck with the decoration as SourceActor, `.outside` its
 * return value), `radius`, `height`, `isCarcass`, `slidingCarcass` and
 * `random()` (appFrand). Evidence: docs/landing.md "The decoration footprint
 * block". */
export function decorationLanded(pawn, hit, { zone } = {}) {
  if (zoneBounceLanding(pawn, zone)) return;
  if ((pawn.landingCounter | 0) < 5 && decorationFootprint(pawn, hit)) return;
  pawn.landingCounter = 0;
  pawn.landedEvent(hit.normal);
  if (pawn.physics === 2) pawn.setPhysics(0, hit.actor);
}

// One x87 operation on two float32 operands, stored as float32 (fld; fadd/fmul; fstp).
const add32 = (a, b) => x87store(x87add(x87load(a), x87load(b)));
const sub32 = (a, b) => x87store(x87add(x87load(a), x87neg(x87load(b))));
const mul32 = (a, b) => x87store(x87mul(x87load(a), x87load(b)));
// fmul m64: a float32 by a double constant, stored as float32.
const mul64 = (a, constant) => x87store(x87mul(x87load(a), x87double(constant)));
// fcomp; fnstsw; test ah,1: C0 is set when below or unordered.
const below = (a, b) => !(a >= b);

/** processLanded's footprint block (0x103cf5f7-0x103d0284) for a decoration
 * whose numLandings is below 5. Returns true when it stored Velocity and
 * processLanded returned (0x103d04cf) without Landed or setPhysics.
 *
 * 1. A centre probe (0x103cf60a-0x103cf803): SingleLineCheck with flags 0x37
 *    and a zero extent from Location - (0, 0, CollisionHeight·0.8) down to
 *    Location - (0, 0, CollisionHeight + CollisionRadius + 8). A hit (Hit.Actor
 *    set) skips to the carcass test.
 * 2. Four corner probes (0x103cf809-0x103cffb4), flags 0x17, the box extent
 *    (0.5·R, 0.5·R, H) swept from Location + (±0.5·R, ±0.5·R, 0) down 8 units,
 *    in the order (+,+) (−,+) (−,−) (+,−); each keeps SingleLineCheck's return
 *    (1: clear, the corner unsupported) as a, b, c, d.
 * 3. With a+b+c+d > 1, a+c ≠ 0 and b+d ≠ 0 (0x103cffba-0x103cffeb):
 *    numLandings += 1 and Velocity = (a+d−b−c, a+b−c−d, 0.5)·2·s, s the fall
 *    speed −Velocity.Z clamped to [30, 30 + CollisionRadius] (30 also when it is
 *    unordered) (0x103cfff1-0x103d0154).
 * 4. Otherwise (0x103d0159-0x103d0284) a Carcass (static class 0x10573db8) with
 *    HitNormal.Z below 0.9 (double) and bSlidingCarcass (+0x348 bit 2) draws
 *    appFrand, adds 1 to numLandings when it is below 0.2, and gets
 *    Velocity = HitNormal·120 with Velocity.Z = 70. */
function decorationFootprint(host, hit) {
  if (typeof host.lineCheck !== 'function')
    throw new Error('Decoration landing requires SingleLineCheck (processLanded footprint block 0x103cf5f7)');
  const [x, y, z] = host.position.map(f), radius = f(host.radius), height = f(host.height);
  const drop = mul64(height, 0.8), reach = x87store(x87add(x87add(x87load(height), x87load(radius)), x87load(8)));
  const centre = host.lineCheck([sub32(x, 0), sub32(y, 0), sub32(z, drop)], [sub32(x, 0), sub32(y, 0), sub32(z, reach)], [0, 0, 0], 0x37, 0);
  if (!centre.outside) return carcassSlide(host, hit);
  const halfR = mul32(radius, 0.5), extent = [halfR, halfR, (h => add32(h, h))(mul32(height, 0.5))];
  const corner = (sx, sy) => {
    const ox = mul64(radius, sx * 0.5), oy = mul64(radius, sy * 0.5);
    const start = [add32(ox, x), add32(oy, y), add32(0, z)], end = [add32(ox, x), add32(oy, y), add32(-8, z)];
    return host.lineCheck(start, end, extent, 0x17, 0).outside ? 1 : 0;
  };
  const a = corner(1, 1), b = corner(-1, 1), c = corner(-1, -1), d = corner(1, -1);
  if (a + b + c + d <= 1 || a + c === 0 || b + d === 0) return carcassSlide(host, hit);
  host.landingCounter = (host.landingCounter + 1) | 0;
  const fall = mul32(-1, f(host.velocity[2])), limit = add32(30, radius);
  const speed = mul32(2, below(fall, 30) ? 30 : below(fall, limit) ? fall : limit);
  host.velocity = [mul32(a + d - b - c, speed), mul32(a + b - c - d, speed), mul32(0.5, speed)];
  return true;
}

/** physFalling's blocked-move count (0x103d1d1c-0x103d1d7b): a Decoration whose
 * Hit.Actor IsA PlayerPawn (static class 0x1058c160) gets numLandings − 1, or 0
 * when that is not positive (`dec; test; setle; dec; and`, signed). */
export function playerContactLanding(host) {
  const lowered = ((host.landingCounter | 0) - 1) | 0;
  host.landingCounter = lowered <= 0 ? 0 : lowered;
}

function carcassSlide(host, hit) {
  if (!host.isCarcass || !below(f(hit.normal[2]), 0.9) || !host.slidingCarcass) return false;
  if (typeof host.random !== 'function') throw new Error('A sliding carcass landing requires appFrand (0x103d01e7)');
  if (below(host.random(), 0.2)) host.landingCounter = (host.landingCounter + 1) | 0;
  const normal = hit.normal.map(f);
  host.velocity = [mul32(normal[0], 120), mul32(normal[1], 120), 70];
  return true;
}

/** Original AActor.processLanded for a non-Pawn source that is not a Decoration
 * (e.g. an Inventory such as a dropped Lockpick, or a Projectile/Fragment):
 * 0x103cef60 -> IsA(Pawn) false -> 0x103cf597 -> IsA(ADecoration) false ->
 * 0x103d02ab. After the bBounceVelocity zone branch (zoneBounceLanding, applied
 * when `zone` is passed) it dispatches the script Landed(HitNormal) event
 * (ProcessEvent, NAME_Landed) and — only while still PHYS_Falling afterwards —
 * calls setPhysics(PHYS_None, HitActor) (0x103d03a9). There is no landing counter
 * (actor+0x324 belongs to the subclass and is untouched), no footprint probe and,
 * for a non-Pawn, no walking continuation even if Landed selected PHYS_Walking. */
export function actorLanded(host, hit, { zone } = {}) {
  if (zoneBounceLanding(host, zone)) return;
  host.landedEvent(hit.normal);
  if (host.physics === 2) host.setPhysics(0, hit.actor);
}

/** processLanded's first test (0x103cef92-0x103cf11f), reached by every source
 * whose bIsPawn (actor+0x28 bit 0x800000) is clear: in a zone with bBounceVelocity
 * (ZoneInfo+0x388 bit 9) and a nonzero ZoneVelocity, store
 * Velocity = (0 + ZV.X, 0 + ZV.Y, 80 + ZV.Z) and return — no Landed event, no
 * physics change, no landing-counter reset. Each ZoneVelocity component is
 * fcomp'ed against 0.0, so -0 and NaN count as zero. `zone` is
 * {bBounceVelocity, ZoneVelocity}. */
export function zoneBounceLanding(host, zone) {
  if (!zone?.bBounceVelocity) return false;
  const velocity = (zone.ZoneVelocity ?? [0, 0, 0]).map(f);
  if (!velocity.some(value => value < 0 || value > 0)) return false;
  host.velocity = [f(0 + velocity[0]), f(0 + velocity[1]), f(80 + velocity[2])];
  return true;
}
