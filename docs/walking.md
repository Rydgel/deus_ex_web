# Native dry player walking contract

Original GOTY APawn.physWalking103ca540–103cbdd3 is authority. Traced before
translation. Zero velocity/acceleration Z; calcVelocity once for whole dt;
Player desired motion adds ZoneVelocity*25*dt, zeroes Z. Save OldLocation,
clear bJustTeleported. Substep while remaining>0, iterations<8: if remaining>.05
use min(remaining*.5,.05f), otherwise remainder. Near-zero displacement
(all abs components<.0001) ends time and clears bHitSlopedWall.

MoveActor then stepUp with remaining displacement. Persistent bHitSlopedWall
(mask20 in Pawn318) probes ahead max(distance+4,30), flags6/full extent.
If normal.z in(.01,.7), horizontal normal projection alters delta. Otherwise
Player performs three zero-extent rays at foot+MaxStepHeight+4, forward100
and two diagonal directions, updating bHitSlopedWall only.

Floor: stationary foot ray from Position.z-Height down20 flags6/zero extent;
if actor==Base and time*20 in[4.1,4.6], skip floor adjustment. Else full extent
ray MaxStepHeight+2 in gravity Z sign with flags17. If hit actor differs from
Base or distance>2.4, move full floor delta and SetSupportBase. Otherwise if
distance<1.9, move up2.1-distance, preserve previous normal, force hit.time0.
Walkable floor normal.z>=.7; low friction normal.z*friction<3.3 additionally
slides by projected gravity (full dt twice, friction clamped>=.5). Floor absent
or too steep invokes Falling event then setPhysics2 if still walking, computes
remaining time from actual horizontal progress, reconstructs XY velocity from
OldLocation/(dt-remaining), preserves Z and invokes physFalling if remaining>.01.
End reconstructs velocity from total displacement/dt unless justTeleported,
then zeroes Z. X retains intermediate x87 subtraction/reciprocal precision.

Callbacks isolate original world movement, queries, support changes, script
wall/falling events and subsequent falling. Water/flying physics are outside this dry-player entry. CanJump/MayFall ledge
veto rolls back OldLocation with FarMoveActor and sets MoveTimer=-1.


## Integration API

`walking(pawn, seconds, iterations=0)` uses original Unreal axes and mutates
pawn fields, matching the existing falling/stepUp callback convention.
The timestep is float32 in (0,.4], with the caller's current shared physics
iteration count. Required numeric/vector state: position, velocity, acceleration,
groundSpeed, accelRate, friction (Zone.GroundFriction), zoneVelocity, gravity,
maxStepHeight, radius, height, mass. Required flags/references: physics,
isWalking (Pawn.bIsWalking), isPlayer, canJump, hitSlopedWall, base.
It writes oldLocation, justTeleported, hitSlopedWall, velocity, acceleration,
and moveTimer on rejected ledges. Support identity uses reference equality.

Callbacks, invoked with pawn as receiver:

| Callback | Contract |
|---|---|
| walkingPrelude(dt,iterations) | Original surface prelude; true means it handled movement and caller returns. Must be supplied explicitly. |
| move(delta) | MoveActor, updates pawn.position and returns {time,normal,actor}; may change physics/justTeleported. |
| lineCheck(start,end,extent,flags,extra=0) | Read-only SingleLineCheck, returns {time,normal,actor}. Preserve null actor on misses. |
| hitWall(hit) | processHitWall dispatch used by verified stepUp; may change physics and velocity. |
| setSupportBase(actor) | Original support-base change including updating pawn.base. |
| mayFall() | Original MayFall event; may change pawn.canJump. Empty inherited Pawn event is verified in embedded source. |
| fallingEvent() | Falling script dispatch; may change physics/velocity. |
| setPhysics(2) | Original setPhysics transition; updates pawn.physics and applies its separately implemented side effects. |
| falling(dt,iterations) | Continue remaining time in verified falling caller. |
| farMove(position,0,0) | Original rollback relocation; updates pawn.position. Its return is ignored here. |

PlayerPawn.Falling calls PlayInAir in original embedded source; its visual/script
work is external to this math caller. A callback that leaves PHYS_Swimming
hands off to startSwimming at the original checks ([swimming](swimming.md)).
Entry requires a valid dry PlayerPawn world region.

## Physics changed by a script event during the body (2026-10-02)

The loop test (`0x103ca853`) reads only the remaining time (`> 0`) and the
iteration count (`< 8`); nothing in the body requires Physics to stay
Walking.  After the forward MoveActor (and stepUp when it hit), the only
exit is `0x103cb3fd`: `IsA(APawn)` and Physics == PHYS_Swimming →
startSwimming, return.  Every other Physics — PHYS_None, Flying, Rotating,
a Falling set by an event of a move that did not hit — reaches `0x103cb466`
`xor eax,eax; test eax,eax; je 0x103cb562`, which always jumps to the floor
probe: the iteration and the following ones run the ordinary walking body
(floor probe, floor move and SetSupportBase, the two later Swimming exits,
the friction slide, the ledge).  At a ledge the Falling event is followed by
`setPhysics(PHYS_Falling)` only for a pawn still Walking, physFalling only
for one Falling, and otherwise `MoveActor(desired*remaining)` with the
remaining time zeroed (`0x103cbc99`).  The end still rebuilds Velocity from
OldLocation unless bJustTeleported and zeroes Velocity.Z.  (The guarded
block at `0x103cb470` is the stationary foot ray, entered only from the
near-zero-delta path at `0x103ca9ee`.)

The stepUp branch (Physics == PHYS_Falling after stepUp, `0x103cb241`)
dispatches Falling and reads Physics once (`0x103cb30a`): Falling →
physFalling(remaining) when remaining > 0.01; **Flying** (`0x103cb343`) →
Velocity = (0,0,AirSpeed `+0x380`), Acceleration = (0,0,AccelRate `+0x384`),
then physFlying (`0x103d3040`) when remaining > 0.01 (`walking.mjs`
`flyFrom`); anything else → return.

`walking.mjs` and the Rust loop (`walk_loop.rs`, import `js_walk_fly`) had
thrown "Walking entered unsupported non-dry physics" after the move and
returned without the Flying sub-branch; both now follow the original.
`validate-native-walking.mjs` adds 26 cases (69 in all, zero mismatches)
with a Physics byte set inside MoveActor, stepUp's HitWall or the Falling
event (None, Falling, Flying, Rotating; one and several substeps, clear
moves, wall hits, ledges with and without physFalling, the Flying
sub-branch with and without the physFlying call).  The oracle's
`wallPhysics` option now also applies 0.  The Rust loop is held to the
same behaviour by `validate-walk-loop-branches.mjs`'s second Training pair
(`scripts/scenarios/walk-physics-events.mjs`: Bump/HitWall/Touch/Falling
events that set Physics None, Falling or Flying): equal digests on both
paths, no boundary, and the physFlying tail reached; the same scenario
stopped 300 times at the old "non-dry" throw.

Reproduction: the 00_Intro frontier (`.work/intro/frontier-walk.mjs`, a
copy of `frontier.mjs` with seeded dt) with `ASPECT=1.5 DT=wide SEED=4`
(dt in [1/120, 1/120+0.05)) stopped at tick 1692 when MJ12Troop0
(Attacking, Health 31 after damage) went from PHYS_Walking to
PHYS_Falling during its walking move, without a stepUp; fixed dt 1/60 at
1.5/1.6 and 1/60+[0,0.02) jitter at 1.3333/1.5/1.6 did not reach it.
Native MoveActor/query/event internals are supplied callbacks, not proven by this
harness. MayFall probing/state-machine suppression is likewise the adapter's
responsibility; for ordinary PlayerPawn the inherited event is empty.

## Script pawns: calcVelocity's class tests (2026-10-11)

`walking.mjs` was recovered and validated for the player ("ordinary dry Player path"), and script pawns (ScriptedPawn)
walked through the same body. Original `APawn::calcVelocity` (Engine.dll `0x103cd7a0`, physWalking's call at
`0x103ca674`) tests the pawn's class chain against APlayerPawn (`0x1058c160`) twice:

- `0x103cd7e2..0x103cd815`: `bIsWalking` (`+0x318` bit `0x10`) counts only for a PlayerPawn. For any other pawn walking is
  false, so the acceleration limit is `AccelRate`, not `0.3 AccelRate`, and the speed clamp is the plain one.
- `0x103cdf05..0x103cdf30`: any other pawn's MaxSpeed is multiplied by `DesiredSpeed` (`+0x36c`).

`flying.mjs` `calcVelocity` (physFlying, physSwimming) has both; the walking path (`velocity.mjs` `groundVelocity` and the Rust
`walk.rs` `ground_velocity`) took bIsWalking and GroundSpeed as they stood. Script pawns that walk have bIsWalking set (1 on
every walking NPC of the original's live trace), so they accelerated at 0.3 x AccelRate and capped at 0.3 x GroundSpeed instead of
AccelRate and GroundSpeed x DesiredSpeed: 0.3 GroundSpeed is within 1.4% of GroundSpeed x 0.296 for the human NPCs (60.0 against
59.2 units/s, so the error hid), but a pawn with DesiredSpeed 1 (SecurityBot0, GroundSpeed 95) walked at 28.5 instead of 95. Found by the live-scene acceptance
([visual acceptance](visual-acceptance.md#live-scenes)): Island, 01_NYC_UNATCOIsland, at the first walking tick of every NPC.

`groundVelocity` now takes `playerPawn` (IsA(PlayerPawn), default true: the player and the oracles' pawn) and `desiredSpeed`;
the JavaScript walking body passes `pawn.isPlayerPawn !== false` and `pawn.desiredSpeed`, and the Rust walk loop (which runs
script pawns only; the host declines a PlayerPawn) the non-PlayerPawn side with `W_DESIRED_SPEED`, an appended row of the walk
field table. `validate-native-velocity` now holds script-pawn cases (class chain without APlayerPawn, DesiredSpeed 0.2 to 1.7, with
and without bIsWalking) and PlayerPawn controls with the same DesiredSpeed, 2,420 cases bit-exact for the JavaScript body and
for `WALK_KERNEL=rust` (without the gate 623 of them differ by up to 434 units/s). `validate-native-walking` adds
script-pawn and control cases to the physWalking oracle (123 cases).

**physWalking's own two class reads (same day, translated).** The oracle showed physWalking reads the class twice more, which
the body did not translate for a script pawn:

- `0x103ca873..0x103ca8fa`: a remaining time over 0.05 s is cut into steps of at most 0.05 s for a PlayerPawn; for any other
  pawn only when `(|desired|^2 * remaining) * remaining > 400` (x87, `0x10431bd0`), i.e. when it travels over 20 units in the
  remaining time. At 60 fps (0.0167 s) the cut never applies, so only frames over 50 ms differ (Play clamps the actor delta
  at 0.4 s, so a long frame does happen).
- `0x103ca697..0x103ca6f1`: a non-PlayerPawn adds `ZoneVelocity * 25 * dt` to the desired move only when
  `|ZoneVelocity|^2 > 90000` (`0x10431bd4`, x87 SizeSquared), as physFlying already did.

`walking.mjs` and the Rust walk loop (`walk_loop.rs`, with the x87 helpers of `fly.rs` made `pub(crate)`) take the
non-PlayerPawn side. `validate-native-walking` asserts them: 395 physWalking oracle cases (script pawn and PlayerPawn controls,
frames of 5 ms to 0.4 s, zone currents at 290, 299, 301, 400; a 240-case sweep), bit-exact; 90 of them fail with the tests
disabled. `validate-walk-loop-branches` runs both maps at `--dt 0.12` with the walk-branches scenario's zone current (305 and 290
units, around the gate) on the JavaScript and Rust paths, digests equal at every checkpoint; mutating the Rust cut to "always"
changes the digest (`27005fe196048f0b` against `b18f4d13205dbe18`, Training, 300 ticks).

## APawn::physicsRotation keeps a raw rotation that already equals its desired one (2026-10-13)

`APawn::performPhysics` (`0x103c9a70`) runs `physicsRotation` (`0x103c9f30`) when Rotation differs from DesiredRotation or
`RotationRate.Roll` is positive (gate `0x103c9bd0..0x103c9bfd`, unchanged). The body compares the raw int32 rotators:

- a PlayerPawn takes neither step (`0x103c9f75..0x103c9f96`) but still zeroes a nonzero Roll with a MoveActor;
- any other pawn sets bRotateToDesired and clears bFixedRotationDir (`0x103c9faa`), steps Yaw through `fixedTurn`
  (`0x10303b34`, the mode with `0x40` set) **only while DesiredRotation.Yaw differs from Rotation.Yaw** (`0x103c9fc2`), and
  Pitch **only while DesiredRotation.Pitch differs from Rotation.Pitch** (`0x103c9fd5`): toward 0 for a Walking or a
  Falling Pawn, else toward the desired pitch, by `trunc(dt * 32768)`, clamped to +-RotationRate.Pitch; it then calls
  MoveActor when the new Pitch, Yaw or a nonzero Roll differs from the stored ones.

Play stepped both axes every time, with a masked `fixToward`: a pawn whose map rotation was not canonical lost it on its
first tick (06_HongKong_WanChai_Underworld's Hooker0, Rotation = DesiredRotation = (-4, -32404, 0): the original keeps it
until a script changes it, six ticks; Play stored (0, 33132, 0) on tick 1), and a walking or falling pawn whose Rotation
equals its DesiredRotation with a nonzero Pitch was pulled to 0. The shorter-arc rule also differed at the exact half turn
(the original goes the positive way; 48 of 1,271 cases). `pawnRotationStep` (script-pawn-physics.mjs) now follows the body
with `fixedTurn` (actor-rotation.mjs, validated against `0x103c9dc0`), and `pawn_phys.rs` `tail` the same.

Evidence: the original's call trace at ticks 1 to 8 shows performPhysics and physicsRotation entered for Hooker0 with the
rotation unchanged; `scripts/native-pawn-rotation-oracle.py` executes the unchanged body (class chains, both `_ftol`
conversions, `fixedTurn`, the clamp, a stubbed MoveActor recording its NewRotation); `validate-native-pawn-rotation` compares
**1,271 cases bit-exact** (raw and equal rotations, one equal axis, every Physics mode, Pawn / ScriptedPawn-like / PlayerPawn
/ non-Pawn chains, wrap and half-turn boundaries, clamp, a 700-case sweep; 286 fail with the equality tests removed).
`scripts/scenarios/rotation-branches.mjs` drives raw, equal, half-turn and Roll rotations through
`validate-pawn-physics-kernel`: JS and Rust digests equal at every checkpoint on Training and Island (a Rust build with the
tests removed differs: `7dbeae2a71482d86` against `240a4dc3d502f71c`).

## Region.ZoneNumber 0: FellOutOfWorld (2026-10-19)

Right after the surface prelude (`0x103ca574`, handled: return at `0x103cb330`), physWalking tests `Region.ZoneNumber`
(`+0xd0`, `0x103ca584`). When it is 0 the body stops there, as physFalling's does (`0x103d0aca`, falling.mjs):

- at ROLE_Authority (`+0x31 == 4`, `0x103ca58e`) it logs `"%s fell out of the world!"` (`0x10481a34`, the same string)
  through `GLog->Logf` with the actor's name (FName::Names), a side channel Play does not model;
- at any Role it dispatches the `FellOutOfWorld` event (`0x103ca5bd`: FindFunctionChecked of FName `0x10583608`, then
  ProcessEvent through vtable +0x10 at `0x103ca5d4`) and returns (`ret 8`, `0x103ca5e7`). Velocity, Acceleration,
  Location and Physics are not touched: `Pawn.FellOutOfWorld` sets Health -1 and `PHYS_None` and calls `Died('Fell')`.

The FName's references in Engine.dll are this branch, physFalling's (`0x103d0b6f`), its registration (`0x103805a5`) and the
exported `AActor::eventFellOutOfWorld` (`0x10322ab0`, through the link thunk `0x1030302b`), which nothing in Engine.dll
calls (no call, jump or pointer to either address); no other System DLL or exe names the event, and no script calls it. walking.mjs had skipped it, so a pawn in zone 0 kept walking. Stage 5 `kB`
([stage 5](stage-5-exit-criteria.md)) showed it: a console `set Location` inside solid leaves Region at the old zone, the
first physFalling move from there stays put while MoveActor's SetZone writes zone 0, and `processLanded` runs physWalking
for the remaining time, which in the original takes this branch (the oracle below); Play's rehearsal walked on (the
capture itself died through physFalling's branch, see the Stage 5 note). walking.mjs now has the branch; the Rust
entries hand such a pawn to it before anything runs (`pawn_phys.rs` `perform` before `walk_loop`, `WalkLoopHost.walk`'s
`zone 0` decline), since the event dispatch is the JavaScript body's.

Evidence: `scripts/native-walking-oracle.py` now sets Region.ZoneNumber and Role per case and records the Logf call (Core
`0x1010280b`, intercepted: its formatting needs msvcrt) with a one-entry name table; `validate-native-walking` adds four
zone-0 cases (Role 4 and 2, PlayerPawn and script pawn): the original returns after the prelude with the single
`FellOutOfWorld` event and every field unchanged, and logs exactly in the two Role 4 cases (399 cases, 0 failures). A
headless Island check (Class P) writes Terrorist0's ZoneNumber 0 while it stands: the Rust path hands the tick back once
and both paths leave it Dying, Health -1, `PHYS_None`, unmoved.

**God mode does not save a player here (2026-11-06).** `Pawn.FellOutOfWorld` (bytecode `Engine.Pawn`, source `.cache/reference/Pawn.uc`:
`Health = -1; SetPhysics(PHYS_None); Weapon = None; Died(None, 'Fell', Location)`) is not overridden by DeusExPlayer, and
`DeusExPlayer.Died` (@0..@142) has no god-mode test: the `ReducedDamageType == 'All'` test lives in TakeDamage (`DeusExPlayer.uc` "//God mode").
The slow-spot census put its god-mode player on navigation points that lie inside the level's solid and lost the sessions of
`03_NYC_Airfield` (698, -4255, 24), `03_NYC_UNATCOHQ` (-36, 1, 264) and `12_Vandenberg_Computer` (782, 2657, -2249): after the placement the
player's Region has ZoneNumber 0 (`iLeaf` -1), and the next walking tick leaves it Dying, Health -1, `PHYS_None`, `ReducedDamageType` still
`All` (`scripts/validate-census-solid-spots.mjs`; `UModel::PointRegion` is `zone.mjs` pointRegion, `validate-native-zone`). The death screen lasts about
twelve seconds before `Dying`'s `PlayerCalcView` starts the splash, which is the `DXOnly` level whose player DeusExPlayer sends to `Paralyzed`
(`MissionNumber == -1`): that was the `Paralyzed` the census saw at the last spots of those sessions, and why "the session goes to DXOnly".
The census no longer offers such points (`map-nav-points.mjs`, tested where the player is placed, 8 units above the point): 22 of the shipped
maps' navigation points, on 10 maps.

## Surface-prelude boundary

The original caller ALWAYS first invokes103cc450. It scans prospective wall
textures via103ccc40. A returned UTexture's Outer pointer+18 is checked for a name equal
(case-insensitive) to UTF16 `Ladder` at10481a74 (103cc4e7–103cc513). A matching
texture enables ladder behavior, which is outside Stage2 dry walking scope.
Otherwise103cc6cb–103cc78d trace downward by Height+2*Radius and retrieve a floor
texture. WalkTexture is dispatched (103cc81d) even for the ordinary branch.
If physics remains Walking, a texture exists, and its float at+70 is less than1,
103cc846–103cc9e0 additionally projects gravity along the surface. The +70 field is Texture.Friction: mapping is now established below. The
ordinary surface adapter performs the scanner/query explicitly and rejects
unsupported Ladder or Friction<1, so callers need no unconditional no-op.

### The surface prelude in Rust up to the scan (2026-11-07)

`walk_loop.rs` `scan_fast` (`ImagePawn::prelude`, for the walking loop and physSwimming) makes `walking-surface.mjs` `fillScanInputs`'s inputs over the
pawn's image (the scan segments turn from `Rotation.Yaw` by the sine table, `f` where the reference has `Math.fround`) and asks the host
(`js_walk_scan`, walk-loop-kernel.mjs `scanFast`) for the kernel scan and the outcome in one import. The host answers 1 when `walkingSurfacePrelude`
would return false having changed nothing: no Ladder texture on the last scan hit, a floor hit the walk may stand on (`Texture.Friction >= 1` or
not walking), and a WalkTexture event whose function has nothing to run. Pawn.WalkTexture is `event WalkTexture(...);` in Engine.u, bytecode
`return _` (`scripts/dump-script-function.mjs Engine Pawn.WalkTexture`), and no Engine, Extension or DeusEx class or state declares another
(`'*WalkTexture*'` over the three packages), so ProcessEvent of it builds a frame, copies three parameters and returns: nothing outlives it
(script-empty-body.mjs `bareReturn`; the answer is cached per class and state node). Every other case answers 0 and the JavaScript prelude
runs the whole call as before (the scan is a query: running it twice changes nothing). `?walkPrelude=js` keeps every prelude in JavaScript;
`=verify` compares the Rust inputs with `fillScanInputs`'s bit for bit and runs the JavaScript prelude after each fast answer, which must return false.


## Original comparison

Run `node scripts/validate-native-walking.mjs` to generate 43 deterministic branch
cases, execute original Engine/Core with controlled prelude/world/event
callbacks, and compare state plus the complete ordered callback arguments.
The result is **43 cases, zero mismatches**, including float32 position,
velocity, acceleration, physics, persistent slope flag and ordered callback
arguments. Covers timestep splitting/iteration cap, braking/acceleration/walking,
zone velocity, stationary footray[4.1,4.6], floor1.9/2.4 boundaries, base changes,
stepping/slopes, low-friction slope gravity, ledge falling and remaining-time
continuation, MayFall veto rollback, step wall→falling, and justTeleported.
Raw inputs/results/comparison stay ignored under `.cache/walking`.
`node --test test/walking.test.mjs` passes native-derived state/event regressions.
The harness executes native calcVelocity and stepUp instructions; only its
explicit prelude, MoveActor, line query, support/physics dispatch, wall/script
events, FarMove and falling-continuation boundaries are controlled callbacks.
Engine/Core hashes are enforced by the shared native-collision loader.
Override `DEUS_EX_ROOT` and `NATIVE_PROBE_PYTHON` when reproducing elsewhere.
This proves the ordinary dry caller contract on these meaningful branches;
it does not verify all possible numerical inputs, surface-prelude behavior,
full movement collision/event dispatch, or visual/in-game fidelity.


## Surface dependency resolved

Original `Engine.u` class exports Bitmap and Texture, their embedded ScriptText,
and tagged Texture class defaults establish Friction=1. Texture.Friction is
FloatProperty export5100. Field order derives the native layout from UObject's
0x28-byte base: Bitmap.Format28, Palette2c, UBits30/VBits31, USize34/VSize38,
UClamp3c/VClamp40, MipZero44/MaxColor48, InternalTime[2]4c/50; Texture starts54:
BumpMap54, DetailTexture58, MacroTexture5c, Diffuse60, Specular64, Alpha68,
DrawScale6c, **Friction70**, MipMult74. These original native/script layouts match
the prelude's native float70 read. The source explicitly defines Friction1 as
no surface effect and .95 as some effect. No public engine implementation is
used as authority for this identification.

The name checked for Ladder is **the texture Outer object's name**, typically
its serialized package group. It is not a MaterialType property. Scanner
103ccc40 uses case-sensitive appStrcmp; the caller103cc450 uses appStricmp.
Starting from Position minus(0,0,Height*.95f), it scans four directions in order:
yaw, yaw-16384, yaw+16384, yaw+32768. Pitch is cleared; XAxis is independent of
roll. Each direction has distance 2*Radius and 9 rays with endpoint Z offsets
0,4,...,32; the ray START remains constant. Every query is zero extent, flags6.
A selected world texture with null Outer or exact `Ladder` ends scanning.
Only LevelInfo hits retrieve BSP Nodes[hit.item].iSurf → surface texture;
mesh/brush actor hits do not substitute their visual texture. The caller then
case-insensitively tests the final selected texture Outer for Ladder.
The supported adapter fails explicitly there. Original ladder branch dispatches
WalkTexture, derives movement from ViewRotation (pitch shifted by±6144), sets
bIsWalking, calls physFlying103cc64e, zeroes velocity when acceleration is zero,
and returns handled=true. That ladder movement remains outside Stage2 scope.

For ordinary surfaces the next ray goes from Position down Height+2*Radius,
zero extent flags6. It retrieves the world texture and dispatches WalkTexture
with hit location/normal. Original Pawn.WalkTexture is an empty event declaration
(embedded Pawn source1612); PlayerPawn and DeusExPlayer embedded sources contain
no override. An empty callback is therefore source-backed for this lineage.
Texture.Friction<1 enables the original extra-slide branch, which the adapter
rejects explicitly until implemented. This is separate from ZoneGroundFriction.

`walkingSurfaceTextures(assets,mapAsset,model)` asynchronously decodes original
class defaults and stored overrides into a table indexed by BSP surface:
`{key,outerName,friction}`. `walkingSurfacePrelude(pawn)` uses pawn.position,
rotation,radius,height,physics plus lineCheck; caller supplies
`textureForHit(hit)` (world LevelInfo/BSP item mapping only) and
`walkTexture(texture,location,normal)` (empty for original PlayerPawn lineage).
Assign it as walking's explicit prelude. It returns false after supported
ordinary handling and throws for selected Ladder or sliding texture.

`node scripts/audit-walking-surfaces.mjs` resolves actual referenced texture
packages and inherited defaults, retaining the local report in
`.cache/walking/texture-audit.json`. Training: 5,333 BSP surfaces,71 unique textures,
1,028 surfaces with normal.z>=.7. Liberty: 6,821 surfaces,107 textures,1,382 with
normal.z>=.7. **Every referenced texture has effective Friction1**, including
all candidate walkable floors; neither map uses a below1 override. Both maps
DO contain Ladder groups, so the spatial scanner remains necessary. This audit
covers static world surface texture references, not future changing surfaces.

`node scripts/validate-native-walking-surface.mjs` executes original103cc450
including its original scanner, name comparisons and floor retrieval with
controlled line-query/empty-event callbacks. 17 focused cases have zero
mismatches in every ordered ray and WalkTexture argument: misses, concrete
textures, yaw/pitch/roll/crouch height, each scan direction, final floor query,
and Ladder selection. Positive Ladder cases stop native execution at103cc519,
the unsupported movement branch; ladder motion is not claimed. Original
MSVCRT hash is enforced in addition to Engine/Core. The unit surface tests pass.
