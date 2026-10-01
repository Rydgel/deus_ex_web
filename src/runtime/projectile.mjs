import {x87add, x87cmp, x87div, x87double, x87load, x87mul, x87neg, x87safeNormal, x87store} from './script-vm.mjs';

const PHYS_FALLING = 2;
const ZERO = x87load(0), ONE = x87load(1);
// The embedded double 0.2 at 0x1042b8e8 (the fluid friction factor).
const FIFTH = x87double(0.2);
const sub = (a, b) => x87add(a, x87neg(b));

/** Original AActor::physProjectile (Engine.dll 0x103d4600, reached from
 * AActor::performPhysics for PHYS_Projectile; docs/projectile.md).
 *
 * `actor` is a live view: position (Location +0x114), oldPosition
 * (OldLocation +0x12c), velocity (+0x144), acceleration (+0x150), physics
 * (+0x30), bBounce (+0x1ec bit 0x10), justTeleported (+0x1ec bit 0x100),
 * bDeleteMe (+0x28 bit 0x80), zoneNumber (Region.ZoneNumber +0xd0),
 * regionWater (Region.Zone+0x388 bit 0, read per iteration), fluidFriction
 * (Region.Zone ZoneFluidFriction +0x338) and, for an actor whose class IsA
 * Engine.Projectile (the inlined IsA against 0x10578850), maxSpeed
 * (Projectile.MaxSpeed +0x31c); null otherwise.
 *
 * Services are the reached boundaries: `destroy()` is XLevel->DestroyActor
 * (this, 0) (vtable +0x94); `move(delta)` is XLevel->MoveActor(this, delta,
 * Rotation, Hit) (vtable +0x88) and returns {time, normal, actor};
 * `hitWall(normal, actor)` is ProcessEvent(FindFunctionChecked(HitWall),
 * {HitNormal, Wall}); `physFalling(remaining, iterations)` is the call through
 * thunk 0x10302fef.
 *
 * All floating-point work is the x87's: products and sums stay in 80-bit
 * registers until the FST/FSTP the body executes, which round to float32. */
export function projectile(actor, seconds, iterations, services) {
  if (!actor.zoneNumber) {
    services.destroy();
    return;
  }
  actor.oldPosition = [...actor.position];
  actor.justTeleported = false;
  const dt = x87load(seconds);
  let remaining = x87store(dt), bounces = 0;
  while (x87cmp(x87load(remaining), ZERO) === 'gt' && iterations < 8) {
    iterations++;
    if (actor.regionWater) {
      // 0x103d46f5: 1 - (ZoneFluidFriction * remaining) * 0.2, FST to a
      // float32 temporary; Z multiplies the register, X and Y the temporary.
      const factor = sub(ONE, x87mul(x87mul(x87load(actor.fluidFriction), x87load(remaining)), FIFTH));
      const stored = x87load(x87store(factor));
      const [vx, vy, vz] = actor.velocity.map(x87load);
      actor.velocity = [x87store(x87mul(stored, vx)), x87store(x87mul(stored, vy)), x87store(x87mul(factor, vz))];
    }
    // 0x103d4749: Velocity += Acceleration * remaining, the X and Y products
    // stored to float32 temporaries, the Z product kept in its register.
    {
      const t = x87load(remaining), [ax, ay, az] = actor.acceleration.map(x87load);
      const pz = x87mul(t, az), py = x87load(x87store(x87mul(t, ay))), px = x87load(x87store(x87mul(t, ax)));
      const [vx, vy, vz] = actor.velocity.map(x87load);
      actor.velocity = [x87store(x87add(px, vx)), x87store(x87add(py, vy)), x87store(x87add(pz, vz))];
    }
    const timeTick = remaining;
    remaining = 0;
    const maxSpeed = actor.maxSpeed;
    if (maxSpeed !== null && maxSpeed !== undefined) {
      // 0x103d47d5: MaxSpeed^2 < (X*X + Y*Y) + Z*Z in 80-bit (C0: below or
      // unordered) clamps to SafeNormal * MaxSpeed, one FSTP per component.
      const [vx, vy, vz] = actor.velocity.map(x87load), m = x87load(maxSpeed);
      const sum = x87add(x87add(x87mul(vx, vx), x87mul(vy, vy)), x87mul(vz, vz));
      const order = x87cmp(x87mul(m, m), sum);
      if (order === 'lt' || order === 'un')
        actor.velocity = x87safeNormal(actor.velocity).map(n => x87store(x87mul(x87load(n), m)));
    }
    // 0x103d4853: the move is Velocity * DeltaTime (the call's argument, not
    // this iteration's remaining time), one float32 store per component.
    const delta = actor.velocity.map(v => x87store(x87mul(dt, x87load(v))));
    const hit = services.move(delta);
    const time = x87load(hit.time);
    const blocked = x87cmp(time, ONE);
    if (!(blocked === 'lt' || blocked === 'un') || actor.bDeleteMe || actor.justTeleported) continue;
    // 0x103d48f7 computes Adjusted.SafeNormal() into an unused temporary.
    services.hitWall(hit.normal, hit.actor);
    if (!actor.bBounce) continue;
    if (bounces < 2) remaining = x87store(x87mul(sub(ONE, time), x87load(timeTick)));
    bounces++;
    if (actor.physics === PHYS_FALLING) services.physFalling(remaining, iterations);
  }
  if (actor.bBounce || actor.justTeleported) return;
  // 0x103d49ab: Velocity = (Location - OldLocation) * (1 / DeltaTime). The Y
  // and Z differences and the reciprocal are stored to float32; X multiplies
  // both registers.
  const position = actor.position.map(x87load), old = actor.oldPosition.map(x87load);
  const dx = sub(position[0], old[0]);
  const dy = x87load(x87store(sub(position[1], old[1])));
  const dz = x87load(x87store(sub(position[2], old[2])));
  const reciprocal = x87div(ONE, dt), stored = x87load(x87store(reciprocal));
  actor.velocity = [x87store(x87mul(reciprocal, dx)), x87store(x87mul(dy, stored)), x87store(x87mul(dz, stored))];
}
