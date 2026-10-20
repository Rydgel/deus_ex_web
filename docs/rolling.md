# Original physRolling

`src/runtime/rolling.mjs` translates `AActor::physRolling` (Engine.dll body
`0x103d4b80`, jump thunk `0x10301109`) for a non-Pawn decoration. The function is
source-type independent: it performs no Pawn/Decoration ancestry test, so the same
translation covers any rolling actor. It was recovered from the original
instructions before translation and compared field-by-field with a Unicorn oracle
that executes those instructions.

## Recovered contract

`ZoneInfo` layout is shared with physFalling: `ZoneGravity` `+0x31c`,
`ZoneVelocity` `+0x328`, `ZoneGroundFriction` `+0x334`, `ZoneFluidFriction`
`+0x338`, `ZoneTerminalVelocity` `+0x33c`.

1. Friction prelude (`0x103d4bd7`–`0x103d4d52`), with the x87 store sequence the
   compiler actually emitted (see below):
   - `Velocity -= (Velocity.SafeNormal - Acceleration.SafeNormal) * Velocity.Size() * dt * ZoneGroundFriction`
   - `Velocity = Velocity*(1 - ZoneFluidFriction*dt) + Acceleration*dt`
   Both computed velocity vectors are stored to `AActor::Velocity` at
   `0x103d4c97`–`0x103d4ca8` and `0x103d4cf5`–`0x103d4d09`; callbacks later in
   the body therefore observe the final friction/fluid result.
2. `DesiredMove = Velocity + ZoneVelocity`; `OldLocation = Location`
   (stored at `0x103d4d34`: the **field**, `AActor+0x12c`, which `rolling.mjs`
   kept only in a local until the O3 replay of Training's pushed crate found it,
   2026-10-20; `validate-native-rolling` compares it now);
   `bJustTeleported = 0`. `Down = (ZoneGravity.Z > 0 ? +1 : -1) * 16`.
3. Substep loop (at most 8 iterations), `timeTick = min(0.1, remaining*0.5)` when
   `remaining > 0.1` (the comparison is against the original double `0.1`, so a
   float32 `0.1` takes the halving branch), else `timeTick = remaining`:
   - horizontal `ULevel.MoveActor(this, timeTick*DesiredMove, Rotation, Hit)`;
     a hit calls the script `HitWall` event and then re-reads `bBounce`
     (`AActor+0x1ec bit 0x10`, test at `0x103d4fd3`), so the synchronous event
     can enable or disable the bounce branch before it slides
     `Delta = (Delta - Normal*(Delta|Normal))*(1-Time)`, re-moving and running
     `TwoWallAdjust`/`eventHitWall` on a second hit. `bBounce` (actor+0x1ec bit
     0x10, tested at `0x103d4fd3`) is a separate branch: after the same
     `eventHitWall`, it refunds `remainingTime += (1-Hit.Time)*timeTick` for the
     first two bounces and skips the slide, dropping straight to the floor probe.
   - downward `MoveActor(this, Down, ...)`: `DropTime`/`DropHitZ` drive a slope
     slide `Slide = (dt*ZoneGravity / (2*Max(0.5, ZoneGroundFriction))) * dt`
     when `Normal.Z < 1` and `Normal.Z*ZoneGroundFriction < 3.3`.
   - when `DropTime == 1 || DropHitZ < 0.7`: move up by `-Down*DropTime`, refund
     `timeTick*(1 - Min(1, ActualDist/DesiredDist))` of remaining time (a
     zero-length desired move is capped to 1), dispatch `Falling`, default
     `Physics==Rolling` to `Falling`, and recurse into `physFalling` for the
     remaining time and the current loop-iteration argument. Otherwise call
     `SetSupportBase(Hit.Actor)` (0x103d54f3–0x103d54f6) when it differs from
     `Base`.
4. `Velocity = (Location - OldLocation) / dt` unless `bJustTeleported`.

The `Max(0.5, ZoneGroundFriction)` comparison and the normal/dot expressions are
in the original instructions, not invented. The oracle records the per-substep
MoveActor sequence, `HitWall`/`Falling` events and the `physFalling` recursion.

## x87 precision (exact)

The friction and fluid arithmetic was fitted exactly to the original stores
(`scripts/native-rolling-products.json` style captures). The compiler rounds some
intermediates and keeps others in extended precision:

- `Velocity.Size()` and the SafeNormal differences use the extended `appSqrt`
  result; `SafeNormal` itself matches Core.dll bit-for-bit.
- Ground product per axis: `X` is `(d*Size)*dt*gf` rounded once at the store,
  while `Y`/`Z` round after each multiply. `Velocity = f(Velocity - f(product))`.
- Fluid step: `fac = 1 - ZoneFluidFriction*dt` stays extended; `X`/`Y` are
  `f(f(Velocity*fac) + f(Acceleration*dt))`; `Z` is
  `f(dt*Acceleration + f(Velocity*fac))` because its `dt*Acceleration` is never
  stored.
- Wall slide (`0x103d50a4`): the reflected delta is scaled by `1 - Hit.Time`, which
  `fsubr 1.0` keeps on the x87 stack (never a float32 store). `Hit.Time` is float32,
  so `1 - Hit.Time` is exact — the JS keeps it in f64 rather than rounding it.
- Falling-time refund (`0x103d55fd`/`0x103d569d`): `DesiredDist` is stored float32
  before the divide, while `ActualDist/DesiredDist` and `RemainingTime +
  (1-Travel)*timeTick` accumulate on the x87 stack and round once at the float32
  `RemainingTime` store.
- Falling-transition velocity (`0x103d571a`): the divisor `dt - RemainingTime` is
  formed by `fld dt; fsub RemainingTime` (extended, exact for two float32 operands);
  only the reciprocal is stored to a float32 temporary that the per-component
  multiplies reload. The JS keeps the subtraction in f64 and rounds only the
  reciprocal.
- Loop-exit velocity: `(Location - OldLocation) / dt` through `FVector::operator/`
  (Core.dll `0x10117800`), whose `1.0/dt` reciprocal stays extended across the three
  component multiplies.

## Validation

```sh
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-rolling.mjs
node --test test/rolling.test.mjs
```

`scripts/native-rolling-oracle.py` executes the original instructions from
`0x103d4b80` with a controlled world (a floor plane plus axis walls), controlled
`ULevel::MoveActor`, recorded script events and a recorded `physFalling` boundary.
`processHitWall`, `setPhysics`, `SetSupportBase` and `twoWallAdjust` are either
original code or controlled boundaries as noted in the oracle. The corpus is 321
cases over flat and sloped floors, walls, free air, friction/fluid ranges,
timesteps and asymmetric acceleration, including 27 `bBounce` wall contacts that
exercise the two-bounce time refund and skipped slide. Every float32 component is **bit-exact**
(`maxError 0`, asserted with `TOLERANCE = 0`): event sequences, physics transitions,
the friction/fluid prelude, the slope and wall slides, the falling-time refund and
both velocity stores all match the original to the last bit. The earlier sub-ULP
residual came from rounding four x87-extended intermediates to float32 (the
wall-slide `1 - Hit.Time`, the falling-transition divisor, `DesiredDist`, and the
refund accumulation); each now retains the original precision (see the list above).
`test/rolling.test.mjs` captures five original expectations.

The same body on the inputs Play produced (Training's crate pushed by the player, 312 calls) is replayed through the original by
`scripts/validate-stage5-o3.mjs --scene crate-stack` ([the O3 proof](stage-5-exit-criteria.md#o3-the-originals-code-on-plays-inputs-2026-10-20)).

## Boundaries

- `bBounce` is re-read from the live actor after each HitWall ProcessEvent; the
  explicit `bounce` option is only a fallback for controlled fixtures without a
  host field. Its branch is now oracle-validated
  bit-exact but not reached by any training decoration (plants do not set bBounce);
  it applies to thrown/bouncing objects. Its velocity is still the end-of-tick
  displacement store — physRolling itself performs no explicit velocity reflection.
- `processHitWall` is not called by physRolling; it belongs to physFalling.
- The oracle controls `ULevel::MoveActor` and does not prove the real BSP/actor
  query composition; that composition has separate MoveActor evidence
  ([move-query.md](move-query.md)).
