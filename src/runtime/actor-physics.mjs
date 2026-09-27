import {x87add, x87div, x87load, x87mul, x87neg, x87store} from './script-vm.mjs';

/** Original non-Pawn AActor::performPhysics (Engine.dll 0x103c9770, vtable
 * slot +0x8c through thunk 0x10303242; APawn overrides it with 0x103c9a70).
 * Actor.Tick calls it when Physics is nonzero and Role is not autonomous
 * proxy (actor-tick.mjs). Evidence and scope: docs/actor-physics.md.
 *
 * 0x103c9799-0x103c97ab: `Physics - 2` indexes the ten-entry jump table at
 * 0x103c99a4 (Physics 2..11); 0 and 1 fall through to the tail.
 *   2 Falling       0x103c97c4 -> physFalling(dt, 0)      (0x103d0a50)
 *   6 Projectile    0x103c97b2 -> physProjectile(dt, 0)   (0x103d4600)
 *   7 Rolling       0x103c98e0 -> physRolling(dt, 0)      (0x103d4b80)
 *   8 Interpolating 0x103c97d6 -> OldLocation = Location, 0x103dd8a0, Velocity
 *   9 MovingBrush   0x103c9856 -> OldLocation = Location, 0x103de690, Velocity
 *  11 Trailer       0x103c98d3 -> physTrailer(dt)         (0x103d7850)
 *   3, 4, 5, 10     no movement
 * Tail 0x103c98ed: physicsRotation(dt) (0x103ca1e0) whenever any RotationRate
 * component (+0x1fc/+0x200/+0x204) is nonzero in its low 16 bits, then one
 * PendingTouch (+0x21c): ProcessEvent(PendingTouch, PostTouch, {Self}), after
 * which the CURRENT PendingTouch is re-read and unlinked (0x103c9943-0x103c9955).
 *
 * Services: read/write script fields, the per-mode movement routines
 * (physFalling/physProjectile/physRolling/physPathing/physMovingBrush/physTrailer),
 * physicsRotation, processEvent and `unsupported`
 * for the modes this host has not linked.
 */
export function performActorPhysics(actor, seconds, services) {
  const {read, write} = services;
  const physics = Number(read(actor, 'Physics')) & 0xff;
  const move = (name, boundary) => typeof services[name] === 'function'
    ? services[name](actor, seconds) : services.unsupported(actor, boundary);
  const interpolated = (name, boundary) => {
    write(actor, 'OldLocation', [...read(actor, 'Location')]);
    move(name, boundary);
    // 0x103c9881..0x103c98ce (same bracket for physPathing at 0x103c9801):
    // X/Y differences and the reciprocal are fst'd float32; Z keeps both
    // extended intermediates. Re-read OldLocation after the body/event.
    const location = read(actor, 'Location'), old = read(actor, 'OldLocation');
    const differences = location.map((value, axis) => x87add(x87load(value), x87neg(x87load(old[axis]))));
    const reciprocal = x87div(x87load(1), x87load(seconds));
    const storedReciprocal = x87load(x87store(reciprocal));
    write(actor, 'Velocity', differences.map((difference, axis) => x87store(x87mul(
      axis === 2 ? difference : x87load(x87store(difference)),
      axis === 2 ? reciprocal : storedReciprocal))));
  };
  switch (physics) {
    case 2: services.physFalling(actor, seconds); break;
    case 6: move('physProjectile', 'physProjectile (0x103d4600)'); break;
    case 7: services.physRolling(actor, seconds); break;
    case 8: interpolated('physPathing', 'PHYS_Interpolating (0x103dd8a0)'); break;
    case 9: interpolated('physMovingBrush', 'PHYS_MovingBrush (0x103de690)'); break;
    case 11: move('physTrailer', 'physTrailer (0x103d7850)'); break;
    default: break;
  }
  const rate = read(actor, 'RotationRate');
  if ((rate[0] & 0xffff) || (rate[1] & 0xffff) || (rate[2] & 0xffff)) services.physicsRotation(actor, seconds);
  const pending = read(actor, 'PendingTouch');
  if (pending) {
    services.processEvent(pending, 'PostTouch', [actor]);
    const current = read(actor, 'PendingTouch');
    // The native dereferences the re-read pointer without a null test.
    if (!current) throw new Error('AActor::performPhysics PendingTouch was cleared by PostTouch (native null dereference)');
    write(actor, 'PendingTouch', read(current, 'PendingTouch'));
    write(current, 'PendingTouch', null);
  }
  return physics;
}
