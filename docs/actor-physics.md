# Non-Pawn actor physics: bouncing falls, rotation, RotRand, landing

Recovered from the hash-pinned GOTY `Engine.dll`
(`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`, image base
`0x10300000`) and `Core.dll`
(`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`) before
translation, for crate fragments (`DeusEx.WoodFragment` → `DeusExFragment` →
`Engine.Fragment` → native `Engine.Projectile`; defaults `Physics=PHYS_Falling`,
`bBounce=True`, `bFixedRotationDir=True`, `Elasticity=0.4`) and dropped inventory
(`DeusEx.Lockpick` → … → native `Engine.Inventory`; `Physics=PHYS_Falling`,
`bBounce=False`). These are pure translations; wiring them into the Play host is
separate integration work.

Actor field offsets used below (from the disassembly, consistent with
`Actor.uc` declaration order): `+0x28` first bool word (bit `0x80` bDeleteMe,
`0x80000` bMovable, `0x800000` bIsPawn), `+0x30` Physics, `+0xc8` Region.Zone,
`+0xd0` Region.ZoneNumber, `+0xd8` StandingCount, `+0x114` Location, `+0x120`
Rotation (Pitch/Yaw/Roll int32), `+0x12c` OldLocation, `+0x144` Velocity, `+0x150`
Acceleration, `+0x178` Brush, `+0x1ec` bool word (bit `0x10` bBounce, `0x20`
bFixedRotationDir, `0x40` bRotateToDesired, `0x100` bJustTeleported), `+0x1f4`
Mass, `+0x1f8` Buoyancy, `+0x1fc` RotationRate, `+0x208` DesiredRotation,
`+0x21c` PendingTouch. ZoneInfo `+0x388` bool word: bit 0 bWaterZone, bit 9
bBounceVelocity.

## AActor::physFalling (0x103d0a50): non-Pawn path and bBounce

`src/runtime/falling.mjs` `falling(pawn, seconds, iterations = 0, options)`.

### Non-Pawn prelude

`0x103d0a7d`–`0x103d0aa7` computes `ThisPawn = IsA(APawn) ? this : NULL`. For a
non-Pawn the walking/surface prelude (`0x103cc450`) is not called and
`0x103d0bca` jumps straight to `0x103d0e0c`, skipping the whole air-control /
acceleration-clamp block: Acceleration is used unchanged (its Z is **not**
zeroed). The entry Acceleration is copied first (`0x103d0bb2`) and restored at
the normal loop exit (`0x103d245e`) for every actor. `options.nonPawn` selects
this path. Each integration re-reads the actor's Acceleration (`+0x150`), so the
translation reads `pawn.acceleration` per integration (the Pawn prelude stored
its clamped value there, so the Pawn path is unchanged).

### Wall-hit branch with bBounce

After the substep MoveActor (`call [vtable+0x88]` at `0x103d1c9c`):

1. `0x103d1ca2`: bDeleteMe (actor+0x28 bit `0x80`) → return (no restore). A move
   whose touch/bump destroyed the actor ends physics; `pawn.bDeleteMe` models it.
2. `0x103d1cb6`: Pawn in PHYS_Swimming → refund and startSwimming (Pawn-only;
   translated, [swimming](swimming.md)).
3. `0x103d1d08`: `Hit.Time < 1.0` (double) marks the substep blocked (local
   `-0x18 = 1`). A Decoration whose `Hit.Actor` IsA PlayerPawn then decrements
   `numLandings` (`+0x324`, floor 0; `0x103d1d1c`–`0x103d1d7b`): the host's
   `blockedBy` (`playerContactLanding`, and `js_fall_blocked` in `fall.rs`), for
   processLanded's footprint block ([landing.md](landing.md), "The decoration
   footprint block"); fragments and inventory never take it.
4. `0x103d1d81`: bBounce (`+0x1ec & 0x10`, re-read here) selects the bounce branch:
   - `0x103d1d8c`–`0x103d1dcc`: `ProcessEvent(FindFunctionChecked(NAME_HitWall
     [0x10583714]), {HitNormal = Hit.Normal, Wall = Hit.Actor})` — the **direct
     script event**, not `processHitWall` (no Pawn or wall-class logic; only
     ProcessEvent's own probe gate). Modeled by `options.hitWallEvent(normal, actor)`.
   - `0x103d1dcf`: `Physics == PHYS_None` → return immediately (no Acceleration
     restore). Any other Physics value (even a change to Rolling) keeps falling.
   - `0x103d1dda`: only while the per-call bounce counter (local `-0x40`, zeroed at
     `0x103d0e1a`) is `< 2`: `RemainingTime += (1.0 - Hit.Time) * TimeTick`.
   - counter `++`, then `jmp 0x103d22ce`. No slide move and no Delta adjustment.
   - Floors are not special: a bouncing actor **never** reaches the
     `Normal.Z > 0.7` landing test, `processLanded` or `processHitWall`; the script
     HitWall must handle resting (DeusExFragment's `SetPhysics(PHYS_None)`).
5. `0x103d22ce`–`0x103d22e6` (end of every substep): bBounce and bJustTeleported
   are re-read. `bBounce && blocked` → next substep without the velocity
   recomputation, so Velocity is exactly what HitWall left. Otherwise the ordinary
   `(Location-OldLocation)/TimeTick - ZoneVel`, `2V-OldV` and terminal clamp run.
   A script that clears bBounce without stopping therefore gets the velocity
   update in that substep and the non-bounce paths afterwards; a non-bouncing
   script that *sets* bBounce in processHitWall skips it.
6. Iterations still count every substep; the loop bound (`remaining > 0 &&
   Iterations < 8`, `0x103d0e49`) is unchanged, so at most 8 HitWall events occur
   per call.

The refund `fld Hit.Time; fsubr qword 1.0; fmul dword TimeTick; fadd dword
RemainingTime; fstp dword` is identical at the bounce site (`0x103d1de0`) and
the floor-landing site (`0x103d1e0e`); both now use the exact x87 model
(`x87add/x87mul/x87store` from `script-vm.mjs`, 64-bit significand, control word
`0x037f` as in the oracle) instead of a double expression. All previously
validated cases are unchanged.

### Other physFalling branches

| Site | Behavior | Status |
| --- | --- | --- |
| `0x103d0aca` | `Region.ZoneNumber == 0`: log (Role Authority and IsA Inventory/Decoration/Pawn), `FellOutOfWorld` event, return | `pawn.zoneNumber === 0` throws an explicit boundary |
| `0x103d0f35`→`0x103d125a` (apex `0x103d18dc`) | water zone, any actor kind: `Velocity = OldV*(1 - 2*FluidFriction*dt) + 0.5*((1 - Buoyancy/max(1,Mass))*Gravity + Accel)*dt` (a NaN Mass is kept) | translated 2026-09-30 ([swimming](swimming.md#physfalling-water-paths-aactorphysfalling-0x103d0a50)); the script pawn view and `runSpawnedActorFalling` expose `regionWater` |
| `0x103d0f42`→`0x103d0f75` (apex `0x103d1558`) | `IsA(ADecoration) && bBobbing` (Decoration `byte +0x31c & 0x08`, bit 3): `V = OldV + 0.5*(0.5*Gravity + Accel)*dt` | translated 2026-09-30; `runSpawnedActorFalling` exposes `bobbing` for Decoration ancestry. This is the branch earlier notes called a "bounce class" branch |
| `0x103d1039`→`0x103d1086` (apex `0x103d168d`) | IsA(PlayerPawn), FootRegion.Zone bWaterZone and `OldV.Z < 0`: `V = OldV*(1 - FootFluidFriction*dt) + 0.5*(Gravity + Accel)*dt` | translated 2026-09-30; the script pawn view exposes `footWater` and `footFluidFriction` |
| `0x103d1b39` | bIsPawn and not PlayerPawn: ZoneVelocity ignored when `SizeSquared <= 40000` | not translated (fragments/inventory/player always add ZoneVelocity) |
| `0x103d1cb6` | Pawn swimming transition | translated ([swimming](swimming.md)) |

### Validation

`scripts/native-falling-oracle.py` executes the unchanged physFalling. New case
fields: `bounce` (sets `+0x1ec` bit `0x10`), `ancestry` (`fragment`: fake
WoodFragment/DeusExFragment/Fragment classes chained to the DLL's own
`AProjectile` 0x10578850 → `AActor` 0x1057cdf0; `inventory`: four script classes
chained to `AInventory` 0x10576f70), `hitWallMode`, `elasticity`, `deleteAtMove`.
The direct HitWall `ProcessEvent` (return address `0x103d1dcf`) is intercepted,
its `{HitNormal, Wall}` parameters recorded, and a controlled script body applied:
`none`, `reflect` (`Velocity = Elasticity*((V dot N)*N*(-2) + V)` with a float32
store after every vector op), `stop` (PHYS_None, zero Velocity/Acceleration,
clear bBounce), `clearBounce`, and `fragment` (DeusExFragment.HitWall's stuck
test, reflection and `(speed < 60 && N.Z > 0.7) || speed == 0` rest). These are
test doubles for the script VM, not VM evidence.

```sh
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-falling.mjs
node --test test/falling.test.mjs
```

Result: **1014 cases, maxError 0, 0 mismatches** (476 Pawn, 126 non-bouncing
non-Pawn, 414 bouncing — 412 fragment-ancestry and 2 bouncing Pawns — and 27
inventory-ancestry), comparing every float32 component bit-exactly (signed zero
included), the MoveActor deltas, and the ordered HitWall/processHitWall/
processLanded events. 376 cases dispatch at least one HitWall, up to 7 per call;
49 exceed the two-bounce refund cap; 82 end through PHYS_None. The original 562
cases are unchanged and still exact.

2026-09-30: 884 water, bBobbing and foot-water cases bring the corpus to
**1898 cases, maxError 0, 0 mismatches**; the oracle adds `regionWater`,
`fluidFriction`, `mass`, `buoyancy` (and `*Bits` for NaN/infinity),
`footWater`/`footFriction` (a separate FootRegion zone), `bobbing` (+0x31c
bit 3), `ancestry: 'decoration'` (script classes over the DLL's ADecoration
`0x10578d48`) and `ancestry: 'pawn'` (a script Pawn, IsA(PlayerPawn) false),
reports physFalling instruction coverage (every instruction of the water,
bBobbing and foot-water blocks and apex copies executes) and 14 mutation
checks. Details: [swimming](swimming.md#validation).

Unverified: the script bodies (reflection arithmetic, `SetPhysics`) are doubles;
the real ones run through the VM and native `setPhysics` at integration.
`Hit.Actor` is always the LevelInfo stand-in. The x87 control word is the
harness's `0x037f`; the game's runtime control word is not measured.

## AActor::processLanded (0x103cef60) for Inventory and Projectile sources

See [landing.md](landing.md#non-pawn-sources-and-the-bbouncevelocity-zone):
`actorLanded(host, hit, {zone})` in `src/runtime/landing.mjs` — the bBounceVelocity
zone branch (`0x103cef92`, every non-Pawn), then `Landed(HitNormal)` and, only
while still PHYS_Falling, `setPhysics(PHYS_None, HitActor)` (`0x103d03a9`). The
Decoration footprint/counter block and the Pawn blocks are skipped. The landing
corpus (853 cases with the decoration footprint block, 2026-10-18) has maxError 0.

## AActor::performPhysics (0x103c9770): dispatch and tail

Non-Pawn actors use `AActor::performPhysics(DeltaTime)` (export thunk
`0x10303242`; `APawn` overrides it). `0x103c9799`–`0x103c97ab` switches on
`Physics - 2` (unsigned, `> 9` skips) through the table at `0x103c99a4`:

| Physics | Target | Action |
| --- | --- | --- |
| 0 None, 1 Walking | — | nothing (out of table range) |
| 2 Falling | `0x10302fef` → `0x103d0a50` | `physFalling(DeltaTime, 0)` |
| 3 Swimming, 4 Flying, 5 Rotating, 10 Spider | `0x103c98ed` | nothing (tail only) |
| 6 Projectile | `0x10302261` → `0x103d4600` | `physProjectile(DeltaTime, 0)` |
| 7 Rolling | `0x10301109` → `0x103d4b80` | `physRolling(DeltaTime, 0)` |
| 8 Interpolating | `0x10301a5a` → `0x103dd8a0` (`physPathing`) | `OldLocation = Location`, call, then `Velocity = (Location - OldLocation) * (1/DeltaTime)` |
| 9 MovingBrush | `0x10303238` → `0x103de690` | same bracket around `physMovingBrush` |
| 11 Trailer | `0x103029dc` → `0x103d7850` | `physTrailer(DeltaTime)` |

For 8/9 the velocity store is: X/Y differences stored float32, the reciprocal
`fdivr 1.0` stored float32 (`fst`) and multiplied, but Z keeps the extended
difference and the extended reciprocal (`fmulp`).

Tail (all Physics values), `src/runtime/actor-rotation.mjs` `performPhysicsTail`:

1. `0x103c98ed`–`0x103c990a`: if any of RotationRate Pitch/Yaw/Roll has a nonzero
   **low word** (`test 0xffff`), call `physicsRotation(DeltaTime)`. A rate of
   exactly ±65536·k is skipped (`physicsRotationGate`).
2. `0x103c9917`–`0x103c995f`: if `PendingTouch` (`+0x21c`) is set, dispatch
   `PendingTouch->eventPostTouch(this)` (`FindFunctionChecked(NAME_PostTouch
   [0x105835d0])` + ProcessEvent with `{Other = this}`), then **re-read**
   PendingTouch and unlink one link: `this->PendingTouch = Old->PendingTouch;
   Old->PendingTouch = NULL` (`services.postTouch(target, other)`). A PostTouch
   that clears the field would make the original dereference NULL; the
   translation throws there.

## AActor::physicsRotation (0x103ca1e0) and fixedTurn (0x103c9dc0)

`physicsRotation(actor, deltaTime, {moveActor, isProbing, endedRotation})`:

1. `0x103ca20a`–`0x103ca254`: return unless bRotateToDesired or bFixedRotationDir;
   with bRotateToDesired return when `Rotation == DesiredRotation` (all three full
   int32 components; no event).
2. `0x103ca25a`–`0x103ca29c`: `delta = _ftol(fild(RotationRate.X) * DeltaTime)`
   for Roll, Yaw, Pitch. The int32 × float32 product is exact on the x87 stack;
   `_ftol` truncates and keeps the low DWORD (`rotationDelta`, via
   `x87int32/x87mul/x87ftol`). Binary64 is not enough: 20 corpus products (e.g.
   `671088635 * 0.4f`, exactly `268435457.99999997`) truncate one higher in double,
   and the original agrees with the x87 value.
3. Yaw, then Pitch, then Roll (`0x103ca2a1`/`0x103ca2d5`/`0x103ca305`): an axis
   turns only when its delta is nonzero and not (bRotateToDesired and
   `DesiredRotation.X == NewRotation.X`); then `NewRotation.X =
   fixedTurn(NewRotation.X, DesiredRotation.X, delta)`. Untouched axes keep their
   unnormalized int32 value.
4. `0x103ca32f`–`0x103ca3d7`: if NewRotation differs from Rotation, call
   `XLevel->MoveActor(this, FVector(0,0,0), NewRotation, Hit(Time 1.0), 0, 0, 0, 0)`
   through the level vtable `+0x88` (`services.moveActor(delta, rotation)`; its
   Boolean is ignored). For a movable actor with StandingCount 0 and no brush the
   original MoveActor short path (`0x10399104`–`0x1039923d`) only stores Rotation;
   bStatic or !bMovable returns false without storing; riders/brushes enter the
   full path. `setScriptRotation` (docs/script-set-rotation.md) implements that
   short path and throws for the full one.
5. `0x103ca3dd`–`0x103ca447`: re-read bRotateToDesired, Rotation and
   DesiredRotation; if rotating to desired and now equal, and
   `IsProbing(NAME_EndedRotation)` (hard-coded index 325 = `0x145`: Core
   `0x10115670` returns true without a state frame or when ProbeMask bit 25 is
   set), dispatch `EndedRotation` (no parms).

`fixedTurn(current, desired, deltaRate, flags)` (`& 0xffff` on both angles first;
`deltaRate == 0` returns `current & 0xffff`):

| bFixedRotationDir | bRotateToDesired | Result |
| --- | --- | --- |
| yes | no | `current + deltaRate` |
| yes | yes | Deus Ex branch: move `deltaRate` in its own sign's direction (distance measured that way round, adding 65536 as needed) but stop at desired |
| no | yes | shortest way (`< 0x8000` difference, else the other way, `0x8000` itself goes the other way), by `min(distance, |deltaRate|)`; `neg` keeps INT_MIN negative |
| no | no | `current` |

All results are `& 0xffff`.

### Validation

`scripts/native-actor-rotation-oracle.py` enters the unchanged `performPhysics`
with Physics None or Rotating, so the switch does nothing and the original gate,
physicsRotation, fixedTurn, the **real** ULevel::MoveActor (level vtable `+0x88`
→ `0x103990e0`; entering its full path at `0x10399240` raises), Core IsProbing
and the PendingTouch tail run. EndedRotation/PostTouch are recorded at a
ProcessEvent thunk. The validator passes the recorded MoveActor requests to
`setScriptRotation`.

```sh
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-actor-rotation.mjs
node --test test/actor-rotation.test.mjs
```

Result: **1174 cases, maxError 0, 0 mismatches**. Stats: 1163 reach
physicsRotation (11 stopped by the low-word gate), 934 MoveActor calls (18 refused
by bStatic/!bMovable), 204 EndedRotation events, 4 PostTouch dispatches. Families:
RandSpin-style fixed-direction fragment spins, post-bounce rotate-to-desired with
0.75ⁿ-scaled rates, fixedTurn wrap/half-turn boundaries for both flag
combinations, early returns, probe on/off, unmovable/static actors, the gate,
PendingTouch chains, SecurityCamera-style PHYS_Rotating sweeps (RotationRate
65535,65535,0 with bRotateToDesired), `_ftol` exactness stress and seeded int32
extremes. The oracle also checks the MoveActor call-site constants (zero Delta,
`Hit.Time = 1`, four zero flags) and the DeltaTime reaching physicsRotation.

## Stage 3 batch 5: full actor dispatch and mover velocity bracket

Before wiring the full level scheduler, the 2026-09-27 local Training boot
measurement found 423 live actors: 342 with Physics None, 52 Falling (including
Pawns), four Rotating SecurityCameras and 25 MovingBrush movers.
FirstDynamicActor was 192. The former category tick omitted nine Falling
Inventory actors: NanoKey0, Ammo10mm2, WeaponCombatKnife0, WeaponCrowbar1,
Candybar0, Multitool0/1/2 and HazMatSuit2. No Projectile mode was observed at
boot or in the category scheduler's first ten seconds; that does not establish
that the full scheduler never reaches it. The local report is
`.cache/training-physics-modes.json` (15 seconds, 623 MiB peak under the RSS
watchdog). Falling Inventory must use `actorLanded`, not the Decoration landing
counter/footprint route. Existing Falling, Rolling, rotation and mover bodies
retain their original evidence and scope above.

The `performPhysics` wrapper was re-read directly from Engine.dll before the
translation change. At `0x103c9856..0x103c987c` (MovingBrush) and
`0x103c97d6..0x103c97fc` (Interpolating), it copies all three Location DWORDs to
OldLocation before the body. After the body it re-reads both fields, so a body
or event may alter OldLocation. It stores X/Y differences as float32, keeps the
Z difference extended, computes `1.0 / DeltaTime` extended and `fst`s a float32
copy without popping it. Z multiplies by the extended reciprocal; X and Y
multiply the stored differences by the stored reciprocal. All final Velocity
components are float32. Tail rotation and PendingTouch follow even if the
movement body changed Physics or bDeleteMe. This bracket is implemented with
the existing x87 primitives, without a binary64 reciprocal substitute.

Play links the movement bodies as services: Projectile
([projectile](projectile.md)), Interpolating ([pathing](pathing.md), and
APawn's case 8 in `script-pawn-physics.mjs`) and MovingBrush (the full
`physMovingBrush` in [doors](doors.md#physmovingbrush)). Trailer remains an
explicit unsupported boundary; exposing a callback does not claim a body is
implemented. The 8/9 Velocity bracket is `interpolationVelocity`, shared
with APawn's (`0x103c9b49`).

The dispatcher differential is `scripts/validate-native-actor-physics.mjs` /
`native-actor-physics-oracle.py`: **114 cases, zero mismatches**, comparing the
entire supplied 0x400-byte actor heap and ordered body calls. Every byte Physics
case in the original table, out-of-range dispatch, changed body Physics,
OldLocation changes, post-body rotation-rate gates and float32/extended mover
velocity differences are included. Movement and rotation bodies are explicit
call-boundary doubles in this wrapper test, never claimed as body validation.
The existing original-DLL body validators remain the evidence for their bodies.

`runSpawnedActorFalling` now also admits the already-linked map actor surface
through `runtime.mapMoveLevel`. This preserves the actor identity, native
collision word and VM field bindings, and links only its collision-hash
Location getter. Both representations then enter the same recovered MoveActor
and non-Decoration `actorLanded` adapter. Decorations continue through their
separately recovered Decoration landing route.

The final 12 wrapper cases enter the **unchanged physMovingBrush body** to
verify its early gates: actor class-chain IsA(AMover), then KeyNum byte +0x377
clamped into the local +0..8 range (no actor store), then bInterpolating
(actor+0x1ec bit 0x80, `0x103de707`) and DeltaTime > 0 (`0x103de714`). KeyNum
0/7/8/255, a non-Mover, non-interpolating Movers and zero dt all leave the
mover fields untouched; the outer dispatcher still writes OldLocation and
Velocity. A serialized mover therefore needs no interpolation host storage
while this original body returns early. An active mover without prepared
storage remains explicitly unsupported.

The earlier decoration adapter passed `{nonPawn: true}` to its recovered
falling body, as the original IsA(APawn) gate requires. Batch 6's live crate
route then exposed a more important adapter boundary: its Falling/Rolling
callbacks used detached snapshots, wrote `Base` directly, and could discard
script vector writes or bypass SetBase's Attach/Detach/StandingCount events.
`script-doors.mjs` now routes map Decoration Falling and Rolling through the
field-backed `runSpawnedActorFalling`/`runActorRolling` adapters in
`script-actor-physics.mjs`. These re-read VM fields after synchronous events,
use the recovered MoveActor scene service, dispatch the original callbacks,
and use native SetPhysics/SetSupportBase translations. The Falling adapter
selects `decorationLanded` for ADecoration ancestry (including its live
`numLandings` field) and `actorLanded` for other non-Pawn classes; the latter
must not stand in for the Decoration-specific `+0x324` reset. Rolling's
falling transition recursively enters the same field-backed Falling route,
passing through the loop iteration value unchanged (`0x103d578e`–`0x103d5798`).
The adapter passes the live `bBounce` field to physRolling; its branch is read
at `0x103d4fd3`, after each synchronous HitWall event. The settled-floor path
calls `SetSupportBase` at `0x103d54e2`–`0x103d54f6`, while the transition to
Falling calls `SetPhysics(Falling, null)` at `0x103d56b4`–`0x103d56c0`.

The original body evidence remains the 321-case exact Rolling oracle in
`docs/rolling.md`, the Falling corpus in `scripts/validate-native-falling.mjs`,
the 506-case Landing corpus in `docs/landing.md`, the 102-case callback
corpus in `docs/walking-callbacks.md`, and the native map-actor MoveActor
comparisons in `docs/script-map-actor-move.md`. These oracles control the
world/query and event callbacks; they establish the bodies and callback
contracts, while the live adapter is separately checked by the existing
Training Decoration settle/roll and stacked-crate route fixtures. A captured
route entry with `StandingCount=255` and `Base=LevelInfo` is known to be
malformed host SetBase provenance, not a recovered valid map state; it is kept
as diagnostic evidence and is not normalized by this adapter. General
nonzero-delta rotation with riders and any unlinked collision source remain
their existing explicit MoveActor boundaries.

The bounded `PlayerStart -> DL_part2` route was replayed after this adapter
change. At the captured zero-delta crate rotation request,
`CrateBreakableMedGeneral1` retained `StandingCount=1` and `Base=LevelInfo0`,
with `CrateBreakableMedGeneral2` still based on it; the older host-snapshot
capture reported StandingCount 255 at the same point. The route then stopped
at the separate `MoveActor scene branch is not linked` boundary, so this
result checks the SetBase/field-storage integration only and does not verify
the rider rotation pass.

After the full scheduler was linked, `node scripts/measure-training-physics.mjs`
completed the same 600 idle frames without an exception (54 seconds, 586 MiB
peak RSS). It reached non-Pawn Falling and all 25 MovingBrush actors, including
the nine previously unticked Falling pickups, plus Pawn Falling/Walking. No
Projectile call occurred. The four cameras start at Physics Rotating but do not
reach `performPhysics(5)` in that idle sample; their script/stasis behavior
precedes the physics gate. Reachability for active interactions is recorded by
the batch census separately; this idle measurement is not a claim about every
Training route.
