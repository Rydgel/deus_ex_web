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
 * (0x103c95f0). The moving-zone landing-velocity branch (nonzero ZoneVelocity) and
 * the read-only footprint probes are outside this dry entry point. */
export function decorationLanded(pawn, hit) {
  pawn.landingCounter = 0;
  pawn.landedEvent(hit.normal);
  if (pawn.physics === 2) pawn.setPhysics(0, hit.actor);
}
