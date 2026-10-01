# AActor::physProjectile (PHYS_Projectile)

Recovered from the hash-pinned GOTY `Engine.dll`
(`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`, image base
`0x10300000`) for `DeusEx.Tracer` (the rounds terrorists and bots fire on
Liberty Island; `Tracer` → `DeusExProjectile` → native `Engine.Projectile`),
which stopped Play with `Non-Pawn performPhysics physProjectile (0x103d4600)
is not linked`. Non-Pawn `performPhysics` (0x103c9770, actor-physics.mjs)
calls it for `Physics == 6` as `physProjectile(DeltaTime, 0)`.

Translation: `src/runtime/projectile.mjs` `projectile(actor, seconds,
iterations, services)`; live adapter `runActorProjectile` in
`src/runtime/script-actor-physics.mjs`, linked as `physProjectile` in
`script-doors.mjs`.

## Body (0x103d4600–0x103d4a1e)

Offsets as in [actor-physics](actor-physics.md); `+0xac` XLevel, `+0x31c`
`Projectile.MaxSpeed` (`node scripts/sdk-layouts.mjs --at AProjectile 0x31c`),
ZoneInfo `+0x338` ZoneFluidFriction, `+0x388` bit 0 bWaterZone. Constants:
`0x10429838` double 0.0, `0x104298a0` 1.0, `0x1042b8e8` 0.2. Imports:
`FVector::FVector(float,float,float)`, `FVector::SafeNormal`,
`UObject::FindFunctionChecked`.

1. `0x103d462a`: `Region.ZoneNumber == 0` → `XLevel->DestroyActor(this, 0)`
   (ULevel vtable `+0x94`) and return.
2. `OldLocation = Location`; bJustTeleported (`+0x1ec` bit `0x100`) cleared;
   `FCheckResult Hit(1.0)`; `remaining = DeltaTime`; `numBounces = 0`.
3. Loop while `remaining > 0.0` (`fcomp` against the double 0.0; below, equal or
   unordered exits) and `Iterations < 8`; `Iterations++`. There is no
   `Physics == PHYS_Projectile` test: after a bounce hands the actor to
   physFalling, the loop keeps running projectile iterations while time remains.
   - `0x103d46f0`: Region.Zone bWaterZone → `factor = 1.0 - (ZoneFluidFriction
     * remaining) * 0.2` in 80-bit, `fst` to a float32 temporary; Velocity.Z
     multiplies the register, X and Y the float32 temporary; three `fstp`.
   - `0x103d4749`: `Velocity += Acceleration * remaining`: the X and Y products
     are stored to float32 temporaries, the Z product stays in its register,
     then three `fadd`/`fstp`.
   - `timeTick = remaining; remaining = 0`.
   - `0x103d47b6`: inlined `IsA(AProjectile)` (class chain against the DLL's
     `0x10578850`). For a Projectile, `MaxSpeed² < (X² + Y²) + Z²` in 80-bit
     (`fcompp`, C0: below or unordered) sets `Velocity = Velocity.SafeNormal()
     * MaxSpeed`, one `fstp` per component.
   - `0x103d4853`: `Adjusted = Velocity * DeltaTime`, the call's argument, not
     `timeTick`; one `fstp` per component.
   - `XLevel->MoveActor(this, Adjusted, Rotation, Hit)` (vtable `+0x88`, the
     four trailing flags 0), with `Hit.Time` reset to 1.0 first.
   - `Hit.Time < 1.0` (double compare; unordered counts as below), not
     bDeleteMe (`+0x28` bit `0x80`), not bJustTeleported:
     - `Adjusted.SafeNormal()` into a temporary nothing reads;
     - `ProcessEvent(FindFunctionChecked(NAME_HitWall), {HitNormal =
       Hit.Normal, Wall = Hit.Actor})`, the direct script event;
     - bBounce (`+0x1ec` bit `0x10`, read after the event): for the first two
       bounces `remaining = (1.0 - Hit.Time) * timeTick` (one `fstp`);
       `numBounces++`; `Physics == PHYS_Falling` →
       `physFalling(remaining, Iterations)` (thunk `0x10302fef`).
4. Exit `0x103d4994`: bBounce or bJustTeleported → return. Otherwise
   `Velocity = (Location - OldLocation) * (1 / DeltaTime)`: the Y and Z
   differences and the reciprocal are stored to float32, X multiplies the two
   registers. A zero DeltaTime gives `0 * inf`, the indefinite `0xFFC00000`.

## Validation

`scripts/native-projectile-oracle.py` executes the unchanged body in Unicorn
(the falling harness: `native-falling-oracle.py`), with Core's `SafeNormal`
and `FindFunctionChecked` and `Engine.dll`'s `IsA` chain real; MoveActor moves
through a controlled floor plane and axis walls, DestroyActor and physFalling
are recorded, and the HitWall event runs a named script double per case
(`none`, `reflect`, `stop`, `clearBounce`, `falling`, `destroy`, `teleport`).
`scripts/validate-native-projectile.mjs` builds 244 cases (free flight at six
time steps, the MaxSpeed clamp and a non-Projectile class, acceleration, water
friction, walls with and without bBounce, every script double, moves that
destroy or teleport, the zone-0 destroy, the iteration cap, zero and negative
time, NaN and infinite velocities) and compares every float32 as its bit
pattern with the translation driven through the same world: all 244 equal, and
the oracle executes every instruction of the body.

## Not covered

- The oracle's MoveActor and script bodies are doubles: MoveActor itself is
  the recovered original elsewhere (docs/script-map-actor-move.md), and the
  Tracer's script events run in the VM.
- The SafeNormal of `Adjusted` after a hit is computed and discarded; it is
  pure, so the translation skips it.
