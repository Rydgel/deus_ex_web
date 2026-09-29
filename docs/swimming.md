# PHYS_Swimming

Research record for the Stage 5 swimming slice. Authority is the retail GOTY
Engine.dll/Core.dll (hashes enforced by `scripts/native-collision-oracle.py`);
field names come from the SDK 1112f layouts (`node scripts/sdk-layouts.mjs --at
APawn 0x…`), UnrealScript from the embedded DeusEx.u/Engine.u source. The UT432
public headers name the members only. Bodies (incremental-link thunk → body):

| Member | Thunk | Body |
| --- | --- | --- |
| `APawn::startSwimming(FVector OldVelocity, FLOAT timeTick, FLOAT remainingTime, INT Iterations)` | `0x10302b76` | `0x103d2b70`–`0x103d2f0a` (`ret 0x18`) |
| `APawn::physSwimming(FLOAT deltaTime, INT Iterations)` | `0x10303215` | `0x103d3cd0`–`0x103d43e1` (`ret 8`) |
| `APawn::Swim(FVector Delta, FCheckResult& Hit)` → FLOAT | `0x10302635` | `0x103d3850`–`0x103d3a4a` (`ret 0x10`) |
| `APawn::findWaterLine(FVector Start, FVector& End)` | `0x1030227a` | `0x103d3b10`–`0x103d3c3d` (`ret 0x10`) |

## Who swims on UNATCO Island

`PawnGenerator.GeneratePawn` (DeusEx.u) moves its `GeneratorScout` to the
generator, calls `Scout.SetPhysics(GetClassPhysics(PawnClass))` and then
`Scout.AIPickRandomDestination(...)`. For `FishGenerator0`/`Fish2Generator0`
the class is `Fish`/`Fish2`, whose default Physics is PHYS_Swimming, so
`GeneratorScout5` and `GeneratorScout4` (in `WaterZone1`) become Physics=3. No
other Island actor reaches Physics=3 in the bench workload.

- Idle Play: the fish generators never call GeneratePawn within 30 s
  (1800 ticks), and nothing swims.
- bench-sim's workload (the forward key held from the first tick): the first
  GeneratePawn runs at tick 153 (2.55 s at 60 Hz). It sets GeneratorScout5 to
  PHYS_Swimming and, in the same call, runs aiPickSearch's water mode through
  the recovered `APawn::swimMove` (`0x103c3ca0`,
  [pawn navigation](script-pawn-nav.md#swimming-contract-recovered-2026-09-29--swimreachable--swimmove)).
  Every scout search finds a water destination and the two generators near
  the player spawn their fish, which swim too. Until 2026-09-29 swimMove was
  unported and this call was the first boundary.
- GeneratorScout defaults are Mass 0, Buoyancy 0 and DesiredSpeed 0. In
  calcVelocity, `1 - Buoyancy/Mass` is 0/0 (NaN), and the speed clamp scales by
  `WaterSpeed * DesiredSpeed = 0`. The scouts therefore hold still while
  swimming. The oracle's Mass 0 cases cover this.

## Entry

- `APawn::performPhysics` (`0x103c9a70`) indexes the jump table `0x103c9cdc`
  with `Physics-1`: entry 3 is `0x103c9aff`, `physSwimming(DeltaTime, 0)`. The
  table sends 5, 6, 7 and 9 (and 0 or >10 through `ja`) to the tail only; 8 is
  physPathing, 10 physSpider. `physicsRotation` treats Swimming like any mode
  other than Walking/Falling (pitch toward DesiredRotation.Pitch; only
  `cmp cl,1`/`cmp cl,2` at `0x103c9fee`).
- **physWalking** (`0x103ca540`) calls
  `startSwimming(Velocity, timeTick, remainingTime, Iterations)` and returns at
  three checks. Each is `IsA(Pawn) && Physics == 3`, with timeTick `[ebp-0x30]`
  and remainingTime `[ebp-0x14]`:
  - `0x103cb3fd`/`0x103cb41f`: after the forward MoveActor (reached from
    `0x103cb190` when `Hit.Time >= 1`), or after stepUp when stepUp did not
    leave PHYS_Falling (`0x103cb241`). Call at `0x103cb44e`.
  - `0x103cb6d9`: after the floor MoveActor and SetSupportBase. It jumps to the
    shared call at `0x103cb9b0`.
  - `0x103cb97d`: after the slope slide (Hit.Time < 1, 0.7 <= N.Z < 1,
    `N.Z*ZoneGroundFriction < 3.3`), whether or not the slide moved. It falls
    into `0x103cb9b0`.

  The 2.1-unit up-adjust move (`0x103cb783`) has no check; the loop continues.
- **physFalling** (`0x103d0a50`), after each substep MoveActor and the
  bDeleteMe return: `0x103d1cac` `[ebp-0x90]` (Cast<APawn>) `&& Physics == 3`
  (`0x103d1cb6`). It then sets
  `remainingTime = f(ext((1 - Hit.Time) * timeTick) + remainingTime)` (the same
  instructions as the landing refund) and calls
  `startSwimming(OldVelocity [ebp-0x2c], timeTick [ebp+8], remainingTime,
  Iterations)`. It returns without restoring Acceleration. Every substep begins
  with `OldLocation = Location` and clears bJustTeleported (`0x103d0ee2`–
  `0x103d0f0d`); startSwimming reads that OldLocation.
- A script sets PHYS_Swimming during MoveActor: SetActorZone dispatches
  `ZoneChange`, and `ScriptedPawn.ZoneChange` calls `setPhysics(PHYS_Swimming)`
  when `newZone.bWaterZone && bCanSwim`. Plain `Pawn` has no such handler.

## APawn::startSwimming (0x103d2b70)

1. `End = Location`; `findWaterLine(OldLocation, End)` (`0x103d2bd6`).
2. `waterTime = 0`. If End differs from Location (`fcomp`/`test ah,0x40` per
   component; equal or unordered counts as the same):
   - `(End-Location)` components stay extended. Their squares go through
     `fstp qword` into `appSqrt` (Core `0x10123290`: `fld qword; fsqrt; ret`),
     then `fstp dword` gives `a`.
   - `(Location-OldLocation).Size()` is inlined in the same shape and stays
     extended as `b`.
   - `waterTime = f(ext(a * timeTick) / b)`, then
     `remainingTime = f(waterTime + remainingTime)`.
   - `MoveActor(End - Location)` with a fresh `FCheckResult(1)`. Each component
     is stored as a float first. The Hit is unused.
3. Unless bBounce (`+0x1ec & 0x10`) or bJustTeleported (`& 0x100`)
   (`0x103d2d3b`):
   - `Velocity = (Location-OldLocation) * r`. The differences are stored as
     floats; `r = 1.0/(timeTick - waterTime)` stays extended (`fdivr qword`).
   - `Velocity = f(2V) - OldVelocity`, one float store per operator
     (`fadd st0,st0`, then `fsub`).
   - If the extended `SizeSquared` is above the double 16000000, then
     `Velocity = f(SafeNormal(Velocity)_i * 4000.0f)`.
4. If `-160 < Velocity.Z < 0` (float constants `0x10431c64`, `0x10426d54`),
   then `Velocity.Z = f(-80.0 - Size2D()*0.7)`. Size2D is Core `0x10117ba0`,
   `fsqrt(double(X*X + Y*Y))`, and stays extended.
5. If `remainingTime > 0.01` (double), call
   `physSwimming(remainingTime, Iterations)`.

## APawn::findWaterLine (0x103d3b10)

- If the extended `(End-Start)` squares compare below the double 1.0 (C0;
  unordered also returns), return with End unchanged.
- The midpoint is `0.5*(Start+End)`. The Z sum stays extended; the X/Y sums are
  stored as floats before the float 0.5 multiply.
- `UModel::PointRegion(Level, Mid)` (`0x1030391d`).
- If `MidZone->bWaterZone` differs from `Region.Zone->bWaterZone` (xor of the
  `+0x388` dwords, `test al,1`), recurse `findWaterLine(Mid, End)`. Otherwise
  set `End = Mid` and recurse `findWaterLine(Start, End)`. Region.Zone is
  re-read at every level. End converges to within 1 unit of the water line, on
  the side of the pawn's current region.

## APawn::Swim (0x103d3850)

- `Start = Location`, `airTime = 0`; `MoveActor(Delta, Rotation, Hit)`.
- If `Region.Zone->bWaterZone` is set after the move, return 0.
- Otherwise `End = Location; findWaterLine(Start, End)`. If End differs from
  Location:
  - `airTime = f(a / |Delta|)`. Here `a` is the float-stored `(End-Location)`
    size. `|Delta|` is `fsqrt(double((Y*Y + Z*Z) + X*X))`: this site's
    summation order differs from Size().
  - `MoveActor(End - Location)` into the same Hit.
- Return airTime.

## APawn::physSwimming (0x103d3cd0)

1. `0x103cc450(this, deltaTime, Iterations)`, the walking-surface prelude with
   the caller's Iterations. It dispatches WalkTexture every tick, and its
   Ladder branch hands over to physFlying. A true return ends physSwimming.
2. If `!HeadRegion.Zone->bWaterZone` (`+0x33c`) and `Velocity.Z > 100.0f`,
   then `Velocity.Z = f((1.0f - deltaTime) * Velocity.Z)`.
3. `Iterations++`, `OldLocation = Location`, and bJustTeleported is cleared.
4. AccelDir is Acceleration when every component compares equal to 0 (a
   double compare); otherwise it is `SafeNormal`.
   `calcVelocity(AccelDir, deltaTime, WaterSpeed +0x37c,
   Region.Zone->ZoneFluidFriction +0x338, bFluid=1, bBrake=0, bBuoyant=1)`.
   Then save `velZ = Velocity.Z`.
5. Zone velocity (`0x103d3e02`): for IsA(PlayerPawn), or when the extended
   `ZoneVelocity` squares are above 90000.0f, add
   `ZoneVelocity*25*deltaTime`. The X/Y products `*25` are stored before the
   `*dt`; Z stays extended. Otherwise add zero.
6. `Delta = (ZoneVel + Velocity)*deltaTime`. The X/Y sums are stored; the Z sum
   stays extended. `Hit = FCheckResult(1)`;
   `remainingTime = f(Swim(Delta, Hit) * deltaTime)`.
7. If `Hit.Time < 1` (double):
   - `GravDir = (0,0,±1)`: +1 only when `Region.Zone->ZoneGravity.Z > 0`, read
     after the move. `DesiredDir = SafeNormal(Delta)`,
     `VelDir = SafeNormal(Velocity)`, and `UpDown = VelDir.Z*GravDir.Z` is
     extended.
   - **Step** when `|N.Z| < 0.2`, `UpDown < 0.5` and `UpDown > -0.2` (the
     physFlying window). Call `stepUp(GravDir, DesiredDir,
     Delta*f(1-Hit.Time), Hit)`, then
     `OldLocation.Z = f(ext(OldLocation.Z - stepZ) + Location.Z)`.
   - **Otherwise**, `processHitWall(Hit.Normal, Hit.Actor)` and the physFlying
     slide (`0x103d40e5`, the same instruction pattern as `0x103d3465`). If the
     extended forward dot is not below 0:
     - `a2 = Swim(Delta', Hit)`, then
       `remainingTime = f(ext(ext(1 - Hit.Time) * a2) * remainingTime)`.
       Hit.Time is read after the call: MSVC evaluates Swim first.
     - If still blocked, call processHitWall, then
       `TwoWallAdjust(DesiredDir, Delta', Hit.Normal, OldHitNormal, Hit.Time)`,
       `a3 = Swim(Delta', Hit)`, and the same remainingTime update.
8. Unless bJustTeleported, and when `remainingTime < deltaTime` (C0):
   - `keep = velZ != Velocity.Z` (lt or gt; equal or unordered do not keep).
   - Set `Velocity = (Location-OldLocation) / (deltaTime - remainingTime)`.
     The X/Y differences are stored and multiply the float-stored reciprocal.
     **Z's difference and the reciprocal stay extended** (the mirror of
     physFlying).
   - If keep, restore `Velocity.Z` to the current (post-event) Z.
9. If `!Region.Zone->bWaterZone`:
   - If Physics is still 3, call `setPhysics(PHYS_Falling)`.
     `AActor::setPhysics` (`0x103c95f0`) for Falling only calls
     `SetBase(None)` when Base is set.
   - If `0 < Velocity.Z < 160`, then
     `Velocity.Z = f(ext(sqrt(double(X*X+Y*Y))*0.4) + 40.0)`, with Size2D
     inlined.
10. If `remainingTime > 0.01`, continue with `physFalling(remainingTime,
    Iterations)` when Physics is 2, or `physFlying` when it is 4. Nothing else
    loops: a pawn still swimming ends the call.

## calcVelocity with bBuoyant (0x103cdf33)

With Region.Zone read live:

- `G = FVector(dt*ZoneGravity.i)`, float stores.
- `lift = f(1.0 - ext(Buoyancy/Mass))`, with Mass unclamped (Mass 0 gives inf
  or NaN).
- Core `operator*(float)` (`0x101177c0`, one fmul and a float store per
  component) and `operator+` (`0x10117740`).

The flying.mjs translation was only exercised with bBuoyant=0 before this
slice. The swimming oracle now runs it natively with bBuoyant=1 (Mass 0, 1,
100, 150; Buoyancy 0 to 250).

## MoveActor's nearly-zero return

`ULevel::MoveActor` (`0x1039915a`–`0x103991c6`) returns before
`Hit = FCheckResult(1)` when every `|Delta|` component is below the double
1e-4 and the rotation is unchanged. Unordered compares count as below, so a
NaN component counts as zero. The caller's Hit then keeps its contents.
swimming.mjs keeps the previous Hit for such moves at the Swim and
startSwimming sites. Play's `pawn.move` returns `{time: 1}` there, and that
result is discarded.

## Native versus script

- **Native**: every quantity above (WaterSpeed, Buoyancy, Mass,
  ZoneFluidFriction, ZoneGravity, ZoneVelocity; bWaterZone of Region,
  HeadRegion and the PointRegion midpoint). ZoneTerminalVelocity is not read by
  swimming. The Pawn Actor.Tick tail decrements PainTime and dispatches
  `PainTimer` (actor-tick.mjs, already linked).
- **Script** (original bytecode through Play's dispatch): ZoneChange,
  FootZoneChange (splash sounds, EntryActor/ExitActor spawns),
  HeadZoneChange (`PainTime = UnderWaterTime` on submersion, Gasp and
  ReduceDamage), PainTimer (5 'Drowned' damage every 2 s), ActorEntered and
  ActorLeaving on the zones, and the ScriptedPawn and PlayerPawn swimming
  states.

## Translation

- `src/runtime/swimming.mjs`: `startSwimming`, `physSwimming`, `swim` and
  `findWaterLine` on the 80-bit model (script-vm.mjs). They reuse
  `calcVelocity` from flying.mjs and `stepUp`/`twoWallAdjust` from steps.mjs.
  findWaterLine's tail recursion is a loop. A midpoint that rounds onto the
  endpoint it replaces is an explicit boundary: the native recursion would
  never terminate there (float spacing above 1 unit).
- `src/runtime/script-pawn-physics.mjs`: `case 3` calls `pawn.swimming`. The
  view adds `waterSpeed`, `bounce` (bBounce), `regionWater`, `headWater`,
  `footWater`, `waterAt(position)` (level.pointRegion) and the
  `startSwimming` service. The zone projection gains bWaterZone.
- `src/runtime/walking.mjs`: the three checks call `pawn.startSwimming` and
  return. Other non-Walking physics after a move still throws, as before.
- `src/runtime/falling.mjs`: `OldLocation = Location` at each substep, and
  the `0x103d1cb6` hand-off (Pawns only).

## Validation

- `scripts/validate-native-swimming.mjs` runs
  `scripts/native-swimming-oracle.py`. startSwimming, physSwimming, Swim,
  findWaterLine, calcVelocity, stepUp, TwoWallAdjust and Core helpers run
  natively. MoveActor (with the nearly-zero rule and a SetActorZone stand-in
  for Region/FootRegion/HeadRegion), PointRegion (a planar water rule), the
  prelude, processHitWall, setPhysics and the continuations are the same
  controlled doubles on both sides. The falling and walking hand-offs run
  original physFalling/physWalking in their harnesses, with Physics flipped to
  3 after a named MoveActor.
  **1093 cases, 0 mismatches, maxError 0**, exact float32 including signed zero:
  - 840 physSwimming and 199 startSwimming cases;
  - 34 falling and 20 walking hand-off cases, which reach all four call sites
    (falling `0x103d1cb6` 13, walking `0x103cb3fd` 12, `0x103cb6d9` 2,
    `0x103cb97d` 4);
  - 252 water-line searches, 57 exits to physFalling, 2 to physFlying, and 317
    wall cases.

  The oracle records instruction coverage: every instruction of the four
  bodies (SEH unwind funclets excluded) executes in some case. The cases
  include Mass 0 (inf and NaN lift), huge velocities and zone velocities, the
  4000 clamp near float max, and a 1e6-long water-line search.
- `scripts/validate-island-swimming.mjs` checks Play integration on UNATCO
  Island in three child processes:
  - **unmodified**, no bypass, forward key: GeneratorScout4/5 run physSwimming
    every tick and hold still, all 20 of their AIPickRandomDestination calls
    find a destination through the original swimMove, and 20 spawned fish
    swim. The first boundary is no longer swimming: it was the jump at tick
    1221 (PaulDenton0's ActorReachable), then native 708 at tick 1375, both
    translated since ([pawn navigation](script-pawn-nav.md)); the 1400-tick
    window now reaches no boundary.
  - **exit**, no bypass, fixture setup at tick 20: GeneratorScout4 is given
    Mass 100, Buoyancy 150 and DesiredSpeed 1 in open water. It swims up for
    41 ticks and leaves the water at Z -351.57 against a surface at -353: Swim
    and findWaterLine on the real BSP, then setPhysics(Falling). It falls back
    in, and at tick 69 physFalling stops at the explicit water-zone boundary
    below.
  - **entry**, no bypass: Terrorist0, placed above the water, falls in. The
    original ScriptedPawn.ZoneChange sets PHYS_Swimming inside MoveActor, and
    physFalling hands off to startSwimming. At tick 41 its Standing state asks
    `FindPathTo` (native 518). This follows from the fixture moving it away
    from its HomeLoc and is not claimed as an Island route.

## Unsupported and unresolved

- **physFalling in water**, now an explicit boundary in falling.mjs for hosts
  that expose the flags (the script pawn view):
  - Region.Zone->bWaterZone integration (`0x103d0f35` → `0x103d125a`):
    `V = OldV*(1 - 2*F*dt) + 0.5*((1 - Buoyancy/max(1,Mass))*G + A)*dt`.
  - PlayerPawn with FootRegion in water and `OldV.Z < 0` (`0x103d1039`).

  Both repeat in the apex re-integration (`0x103d1514`) with their own store
  patterns. Before this slice they were silently integrated as dry.
- **physFalling's Decoration bBobbing branch**, now an explicit boundary.
  After the water test, `0x103d0f42`–`0x103d0f6f` walks the class chain for
  ADecoration (`0x10578d48`) and tests `byte [actor+0x31c] & 0x08`. The SDK
  layout puts bBobbing at +0x31c bit 3, the fourth Decoration bool. Taken,
  it integrates with half the zone gravity (`0x103d0f75`–`0x103d1034`):
  `V = OldV + 0.5*(0.5*ZoneGravity + Acceleration)*dt`, where
  `[0x10426d74]` is 0.5. This integration is not translated.
  * `runSpawnedActorFalling` exposes `bobbing` for Decoration ancestry, and
    `falling()` throws there, re-reading it every substep as the native does.
  * DeusEx scripts only ever clear bBobbing (Decoration.uc comments out the
    one `bBobbing = true`), and 300-tick Training and Island bench runs never
    reach it.
  * `decoration-physics.mjs`'s `runDecorationPhysics`, used only by unit
    tests, does not expose `bobbing`.
- **Non-Pawn falling in water is still dry.** `runSpawnedActorFalling`
  (decorations, fragments, inventory) does not expose `regionWater`, so
  physFalling's water-zone integration (`0x103d0f35` → `0x103d125a`) is not
  guarded for them. A bobbing decoration in water would therefore stop at the
  bBobbing boundary, where the native takes the (equally untranslated) water
  branch. The Island bench reaches this: CrateBreakableMedGeneral1, 2, 5 and 8
  and CrateBreakableMedCombat13 run physFalling in a water zone from its
  first tick and integrate dry.
- ~~APawn::swimMove and swimReachable~~ are ported and oracle-verified since
  2026-09-29 ([pawn navigation](script-pawn-nav.md#swimming-contract-recovered-2026-09-29--swimreachable--swimmove)).
- The player (JC) has no swimming path: runPlayerPhysics refuses water
  regions, the dry zone callbacks refuse water zone changes, and
  PlayerSwimming and breath effects are not linked.
- stepUp's inner MoveActor calls use the returned hit. For a nearly-zero step
  delta the original keeps the caller's Hit. The cases avoid such deltas, and
  this applies to walking/flying equally.
- calcVelocity's network clamp (NetMode != 0) remains unsupported.
- The oracle runs x87 control word 0x037f. Whether the game thread runs single
  precision under D3D is open (see the D3D FPUSETUP note). No transcendental
  is used by these bodies.
- `scripts/bench-sim-hooks.mjs`'s `performPhysics` default rewrite was removed
  on 2026-09-29: without it both maps' 360-tick bench runs report `errors {}`
  and the Training digest is unchanged.
