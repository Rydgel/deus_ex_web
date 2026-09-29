# Ladders and PHYS_Flying

Research record for the first Stage 5 movement slice: Deus Ex ladders, which
run through the walking surface prelude into `APawn::physFlying`. Authority is
the retail GOTY Engine.dll/Core.dll (hashes enforced by
`scripts/native-collision-oracle.py`); field names come from the SDK 1112f
layouts (`node scripts/sdk-layouts.mjs --at APawn 0x…`). The UT432 public
headers are a naming reference only.

## Entry: the walking surface prelude (0x103cc450)

[Walking](walking.md) records the scan. It starts from Location minus
`(0,0,Height*.95)`, casts four directions × nine rays, and case-insensitively
compares the selected BSP texture's Outer name with `Ladder`. Both physWalking
and physFalling call this prelude first, so a pawn can catch a ladder while
airborne. The ladder branch at `0x103cc519–0x103cc6ca`:

1. Dispatch `WalkTexture(Texture, HitLocation, HitNormal)` through
   ProcessEvent (vtable+0x10, event name `0x105835f4`). The parameters come
   from the selecting scan hit: the texture comes from EDI, and HitLocation
   and HitNormal come from the FCheckResult on the stack
   (`0x40..0x54(%esp)`). DeusExPlayer has no override, so this is Pawn's
   empty event.
2. If Acceleration (`+0x150`) is not exactly zero in every component:
   - copy ViewRotation (`+0x3dc`) and add `0x1800` (6144) to the pitch when
     `Pitch >= 0`, or subtract it otherwise. The signed int pitch is
     not normalized first;
   - set bIsWalking (`+0x318` bit `0x10`);
   - take `(GMath.UnitCoords / Rotation).XAxis` through Core import
     `0x1059a0b4` (the returned FCoords + 0xc);
   - set `Velocity.Z = f(GroundSpeed(+0x378) * XAxis.Z * 0.5)`: `flds`,
     `fmuls`, `fmull` of the double `0.5` at `0x1042ac10`, then `fstps`.
     The float×float product is exact in a double and the ×0.5 is exact,
     so a single float round reproduces it.
3. Call `physFlying(DeltaTime, Iterations)` with the caller's own arguments.
4. If Acceleration is zero in every component, set Velocity to `(0,0,0)`.
5. Return true (handled), so the caller skips its own movement.

Velocity.X/Y are left for physFlying's calcVelocity; only Z is overridden.
Because bIsWalking is set before calcVelocity, a climbing player gets the
walking acceleration limit (`AccelRate * 0.3`) and the walking speed clamp.

## APawn::physFlying (0x103d3040–0x103d367c)

Arguments: `(FLOAT DeltaTime, INT Iterations)`; `retl $8`. The function body
is a single pass with no substep loop.

1. **Out of world** (`0x103d306c–0x103d30d7`): if `+0x1dc & 2` (bCollideWorld)
   and `Region.ZoneNumber (+0xd0) == 0`, it logs `"%s flew out of the world!"`
   (`0x10481a84`). Unless bIsPlayer (`+0x318 & 2`), it then calls
   `XLevel->DestroyActor(this, 0)` (vtable+0x94). It returns in either case.
   **Unsupported** in the translation: it throws.
2. **AccelDir** (`0x103d30da–0x103d312f`): Acceleration itself when every
   component compares equal to 0.0, otherwise `Acceleration.SafeNormal()`
   (Core `0x10599b80`).
3. **calcVelocity(AccelDir, DeltaTime, AirSpeed(+0x380),
   Region.Zone->ZoneFluidFriction(+0x338), bFluid=1, bBrake=0, bBuoyant=0)**.
4. `OldLocation(+0x12c) = Location(+0x114)`; clear bJustTeleported
   (`+0x1ec` bit `0x100`).
5. **Zone velocity** (`0x103d318f–0x103d3226`): use `Region.Zone->ZoneVelocity`
   (`+0x328`) when the class chain reaches PlayerPawn (`0x1058c160`), or when
   `ZoneVelocity·ZoneVelocity` (extended) is greater than the float 90000
   (`0x10431bd4`). Otherwise use zero.
6. **Delta** (`0x103d3229–0x103d3279`): the X and Y sums
   `ZoneVel + Velocity` are stored as floats before `*DeltaTime`. The Z sum
   stays in extended precision and is multiplied by DeltaTime directly. Each
   product is then stored as a float.
7. `XLevel->MoveActor(this, Delta, Rotation, Hit, 0,0,0,0)` (vtable+0x88)
   with `Hit.Time` initialized to 1.
8. If `Hit.Time < 1.0` (double `0x104298a0`):
   - `GravDir = (0,0,-1)`, or `(0,0,1)` when `Zone.ZoneGravity.Z (+0x324) > 0`;
   - `DesiredDir = Delta.SafeNormal()`, `VelDir = Velocity.SafeNormal()`;
   - `UpDown = VelDir.Z * GravDir.Z` (extended; only Z is nonzero);
   - **step** when `|Hit.Normal.Z| < 0.2` (double `0x1042b8e8`),
     `UpDown < 0.5` and `UpDown > -0.2` (doubles `0x1042ac10`,
     `0x10431c78`). Save `stepZ = Location.Z` and call
     `stepUp(GravDir, DesiredDir, Delta * (1 - Hit.Time), Hit)`. The factor
     `1 - Hit.Time` is stored as a float, and each product is stored as a
     float. Then set `OldLocation.Z = f(f(OldLocation.Z - stepZ) + Location.Z)`
     (`0x103d3425–0x103d3434`);
   - **otherwise** call `processHitWall(Hit.Normal, Hit.Actor)`, then compute
     `Delta' = (Delta - Normal * (Delta·Normal)) * (1 - Hit.Time)` with the
     native's exact store pattern (`0x103d3465–0x103d34f8`). If
     `Delta'·Delta >= 0`, move again. If that move is blocked
     (`Hit.Time < 1`), call processHitWall, then
     `TwoWallAdjust(DesiredDir, Delta', Hit.Normal, OldHitNormal, Hit.Time)`,
     and move a third time.
9. Unless bJustTeleported, set
   `Velocity = (Location - OldLocation) * (1/DeltaTime)`. The reciprocal is
   an extended `fdivrl 1.0`, then `fsts` rounds it to a float. The
   differences are stored as floats.

## calcVelocity paths used here (0x103cd7a0)

Arguments: `(FVector AccelDir, FLOAT DeltaTime, FLOAT MaxSpeed, FLOAT Friction,
INT bFluid, INT bBrake, INT bBuoyant)`, `retl $0x24`.

- `F = (FLOAT)bFluid < Friction ? Friction : (FLOAT)bFluid`, stored at
  `-0x14`. It is used by the friction step and the walking clamp. The fluid
  decay below uses the raw Friction argument.
- `walking = IsA(PlayerPawn) && bIsWalking`.
- The braking path runs only when `bBrake` is set and Acceleration is zero.
  physFlying never takes it.
- Accelerating path (`0x103cdc1f`):
  `speed = f(appSqrt(double(V·V)))`. The Acceleration clamp is
  `AccelRate² * 0.09 < A·A` for walking, where the clamped value is
  `f(f(AccelDir*AccelRate) * 0.3f)`, or `AccelRate² < A·A` otherwise, where
  it is `f(AccelDir*AccelRate)`. The result is stored to Acceleration.
  Then `V = V - ((V - AccelDir*speed)*dt)*F`, with every vector operator
  storing floats. Then `V = f(V * (1 - bFluid*dt*Friction)) + f(A*dt)`, where
  the factor stays in extended precision.
- Non-player: `MaxSpeed *= DesiredSpeed (+0x36c)`.
- bBuoyant: `V += (Zone.ZoneGravity*dt) * f(1 - Buoyancy(+0x1f8)/Mass(+0x1f4))`.
  Not used by physFlying; swimming is its caller.
- The single-player speed clamp is at `0x103ce0cb`, because LevelInfo
  `NetMode (+0x518) == 0`:
  - walking and `MaxSpeed²*0.09 < V.SizeSquared()`: set
    `V = V/V.Size() * max(f((1-2*F*dt)*Size), f(MaxSpeed*0.3f))`;
  - else if `MaxSpeed² < SizeSquared`: set `V = V.SafeNormal() * MaxSpeed`.
  The network tail at `0x103cdfb7` is multiplayer and not translated.

## Translation

- `src/runtime/flying.mjs` contains `calcVelocity` (accelerating path,
  single-player clamp, buoyancy) and `physFlying`. Every expression uses the
  80-bit model in `script-vm.mjs` (`x87load`/`x87mul`/`x87add`/`x87store`, …)
  wherever the native keeps extended intermediates. The Core FVector helpers
  are modeled from their bodies:
  - SizeSquared (`0x10117b70`) returns the extended dot product;
  - Size (`0x10117b30`) is fsqrt of the dot stored as a double;
  - `operator/` (`0x10117800`) multiplies by an extended `1/s`;
  - `operator*`, `operator*=` and `operator+` store floats per component.
- `src/runtime/walking-surface.mjs` `climbLadder` holds the Ladder branch. The
  prelude now takes `(pawn, dt, iterations)` from walking and falling. A pawn
  without the physFlying service stops at the branch entry, before
  WalkTexture, which matches the surface oracle's cut at `0x103cc519`.
- `src/runtime/script-pawn-physics.mjs` wires Play's APawn::performPhysics:
  `pawn.flying`, `case 4` (PHYS_Flying) and the view fields AirSpeed,
  DesiredSpeed, ViewRotation, Buoyancy and bCollideWorld, plus a writable
  bIsWalking. It also adds IsA(PlayerPawn), NetMode, Region.ZoneNumber and
  the zone's ZoneFluidFriction. The Engine.u ZoneInfo default for
  ZoneFluidFriction is 1.2f.

## Validation

- `scripts/validate-native-flying.mjs` runs `scripts/native-flying-oracle.py`.
  Original calcVelocity, SafeNormal, stepUp and TwoWallAdjust run in Unicorn;
  MoveActor and processHitWall are the falling oracle's controlled doubles.
  **746 cases, 0 mismatches, maxError 0**: 63 step cases, 299 cases with
  wall contact, player and non-player ancestry, the friction and zone
  thresholds, bJustTeleported, and 300 seeded cases.
- `scripts/validate-native-ladder.mjs` runs `scripts/native-ladder-oracle.py`,
  which is the original prelude through the Ladder branch and native
  physFlying, with unobstructed MoveActor. **184 cases, 0 mismatches.** They
  cover signed and unnormalized pitches, zero and denormal acceleration,
  GroundSpeed, prior bIsWalking, the selecting ray, lowercase or uppercase
  group names (a scan non-break) and 120 seeded cases. The ladder WalkTexture
  parameters are the selecting scan hit's Location and Normal.
- `scripts/validate-training-ladder.mjs` is Play integration on Training's
  45-surface `CoreTexMetal.Ladder` stack. From the pit floor (Z -144) at
  public-input forward with a 0.6 rad look, JC climbs with bIsWalking set and
  steps onto the upper floor (Z 16). On the rungs with no input he hangs:
  zero Velocity and constant Z. A 40° down-look descends at -17.05 u/s. The
  stored ViewRotation.Pitch is unsigned (58235), so it takes the `+6144`
  branch, and `sin(64379)` is small. Running off the top edge at full speed
  leaves the 40-unit scan range and falls. That follows from the scan
  distance; no original-game measurement of it is claimed.

Not covered: the out-of-world branch (it throws), the calcVelocity braking
path with bFluid, and the network clamp. Swimming, which uses bBuoyant and
startSwimming, is in [swimming](swimming.md).
