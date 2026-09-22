import { safeNormal } from './steps.mjs';

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
      pawn.velocity[0] = f(pawn.random() * 60 - 30 + pawn.velocity[0]);
      pawn.velocity[1] = f(pawn.random() * 60 - 30 + pawn.velocity[1]);
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
 * 0x103cef60 -> IsA(Pawn) false -> 0x103cf597). A landed decoration (IsA the
 * decoration class 0x10578d48) runs a read-only landing-footprint probe set
 * (0x103cf5f7, only while its landing counter actor+0x324 < 5) that never
 * relocates it or changes its physics: a footprint-present and a footprint-absent
 * landing reach a byte-identical outcome (scripts/validate-native-landing.mjs).
 * The observable transition is therefore: reset the decoration landing counter,
 * dispatch the script Landed(HitNormal) event, then — only while still
 * PHYS_Falling after that event — call setPhysics(PHYS_None), which rebases the
 * decoration onto the floor actor and zeroes its velocity and acceleration
 * (0x103c95f0). Passing `{zone}` applies the bBounceVelocity branch first (see
 * zoneBounceLanding); without it that branch is outside this entry point. The
 * read-only footprint probes are not reproduced. */
export function decorationLanded(pawn, hit, { zone } = {}) {
  if (zoneBounceLanding(pawn, zone)) return;
  pawn.landingCounter = 0;
  pawn.landedEvent(hit.normal);
  if (pawn.physics === 2) pawn.setPhysics(0, hit.actor);
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
