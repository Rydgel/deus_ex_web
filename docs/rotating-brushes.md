# Rotating brushes: a mover with a RotationRate (2026-10-22)

Found by a real desktop save: retromaggedon `Save0021` (`09_NYC_ShipFan`) stopped by name at
`SetRotation MoveActor for a pawn, brush or non-colliding map actor is not linked (DeusExMover1)`
([travel](travel.md), "Play, step 4"). `DeusExMover1`, the Naval Assembly Building's AC fan, was saved spinning.

**The premise needs one correction.** The fan is not in `PHYS_Rotating`. Its Physics is 9 (`PHYS_MovingBrush`, `Mover`'s class default), and
the spin is `RotationRate` (yaw -20000) with `bFixedRotationDir`, authored in the map. In the original that is the same thing: the
rotation is not a physics mode at all. `AActor::performPhysics` runs its tail for **every** Physics value, so a brush in
`PHYS_Rotating` (5), `PHYS_MovingBrush` (9) or `PHYS_None` turns by the same code. Nothing in the installed game puts a brush in
`PHYS_Rotating`; the oracle runs Physics 5 and 9.

## What the original does (Engine.dll, SHA256 `0c3a8b18...c20b4`, image base `0x10300000`)

1. **Dispatch.** `AMover`'s vftable slot `+0x8c` is `AActor::performPhysics` (`node scripts/sdk-layouts.mjs --vtable AMover`: the mover
   overrides neither it nor `Tick`). Physics 9 -> `OldLocation = Location`, `AMover::physMovingBrush` `0x103de690`, then
   `Velocity = (Location - OldLocation) / dt` ([actor-physics](actor-physics.md)). `physMovingBrush` returns at `0x103dea2e` when
   `bInterpolating` (`+0x1ec` bit `0x80`) is clear: a fan is never interpolating.
2. **Tail** `0x103c98ed` ([actor-physics](actor-physics.md#aactorperformphysics-0x103c9770-dispatch-and-tail)): any RotationRate component with a
   nonzero low word -> `AActor::physicsRotation` `0x103ca1e0` -> `fixedTurn` `0x103c9dc0` per axis (Yaw, Pitch, Roll; an axis with a zero
   `_ftol(rate * dt)` keeps its unnormalized int32, so the fan's Pitch 32768 and Roll -32768 stay) -> `XLevel->MoveActor(this, 0, NewRotation, Hit, 0, 0, 0, 0)`
   through level vtable `+0x88` (`0x103ca3d7`).
3. **`ULevel::MoveActor` `0x103990e0` with a brush source.**
   * `0x10399130..0x10399145`: bStatic or !bMovable returns 0. `0x10399178..0x10399228`: unchanged rotation and every |Delta| < 0.0001 returns 1.
   * `0x103991ef..0x10399218`: a changed rotation with a zero Delta takes the rotation-only store only for an actor with no Brush, a non-`ABrush`, or a
     static one (`StandingCount` 0); **a non-static Brush goes on to the full path `0x10399240`**.
   * `0x1039940e`: `testb $3, +0x1dc` (bCollideActors|bCollideWorld) clear -> `0x10399795`; `0x1039941b..0x1039943a`: a non-static Brush jumps there as well, past
     the cylinder `MultiLineCheck` and the touch list (their locals stay 0). So the brush source never meets the world or builds a hit list, and a source with
     **no collision bits** takes the same route.
   * `0x103998a0`: `StandingCount != 0` runs the rider pass (a slave mover or a pawn on the blade), before the encroachment check.
   * `0x10399bb5`: non-Pawn, Test 0, NoFail 0 -> `XLevel->CheckEncroachment(this, Location + Delta, NewRotation, 0)` (level vtable `+0xb8` =
     `0x1039a350`); true returns 0 with nothing committed.
     **`0x1039a39a`: a source without bits `0x0d` goes on only as a non-static Brush** ([check-encroachment](check-encroachment.md)), so a
     destroyed (non-colliding) fan still pushes whatever its blades meet.
   * Commit `0x10399c9a`: `hash->RemoveActor` (vtable `+0xc`) **only if bCollideActors** and the level has a hash; `Location.{X,Y,Z} += Delta` (three float32
     stores); `Rotation = NewRotation`; `hash->AddActor` (`+0x8`) only if bCollideActors.
   * **Tail `0x10399d17`..`0x10399f5f`** (Test 0; Hit.Actor is NULL, the hit list is NULL): the `EndTouch` pass over the four Touching slots (each re-read at its
     turn; `IsOverlapping` is false for a Brush, so **every held touch ends**), then `XLevel->SetActorZone(this, 0, 0)` (level vtable `+0xac`), then
     returns `Hit.Time > 0`. This runs for a rotation-only move as well.
4. Every pushed actor is moved by its own `moveSmooth` with the vector `proposed - Location`, which is **zero for a pure rotation**: a blade pushes
   nothing, and what happens to a pawn it overlaps is `Mover.EncroachingOn`'s script (`ME_CrushWhenEncroach` for the fans: the pawn is crushed), then
   `EncroachedBy` ([mover-push](mover-push.md)).

Unresolved branches (not reached by the installed content, left as the existing explicit boundaries): a Brush *hit* that is static (the original
pushes it), a rotating mover with based riders carrying a pawn (the rider pass is covered by [mover-move](mover-move.md)'s cases, not by a fan), `bRotateToDesired`
on a brush (`EndedRotation` through `IsProbing`), and the editor branches (`GIsEditor`).

## Census (what can spin)

`node scripts/census-rotating-brushes.mjs` (the 83 single-player maps with every serialized property over the class defaults, and every `ScriptText` of the
installed packages):

* 2076 movers, all Physics 9; **3 with a RotationRate: `09_NYC_ShipFan` `DeusExMover1` (yaw -20000), `DeusExMover2` (pitch -30000), `DeusExMover3` (pitch +30000)**, all
  `bFixedRotationDir`, `MoverEncroachType` 2 (`ME_CrushWhenEncroach`: `Mover.EncroachingOn` ends in `Other.KilledBy`), colliding, `OddsOfAppearing` 1 in every difficulty.
  They spin from the first tick.
* **No brush has Physics 5** in any map, and none of the 71 script lines that write `RotationRate`, `bFixedRotationDir` or `PHYS_Rotating` is in a Mover or Brush class (the
  writers are fragments, projectiles, thrown items, vending-machine products, `Trash`, `Poolball`, `AlarmLight`, carcass chunks; `Inventory.BecomeItem` is the one `SetPhysics(PHYS_Rotating)`).
  A save or a console `set` is the only other way in.
* Every other `PHYS_Rotating` actor of the maps (222 `SecurityCamera`, 186 `HangingShopLight`, 112 `HKMarketLight`, 73 `HKHangingLantern2`, 39 `CeilingFan`, ...)
  has no Brush: the non-brush short path of `MoveActor` ([actor-physics](actor-physics.md)), long in Play.
* A fan becomes **non-colliding** in play: `DeusExMover.BlowItUp` (`SetLocation(Location + 20000)`, `SetCollision(False,False,False)`, `bDestroyed`) when the
  player destroys it, and it keeps spinning (RotationRate is untouched). That is `Save0021`: `DeusExMover1` at Location z 19696, bCollideActors/bBlockActors/
  bBlockPlayers clear, Rotation `[32768, 19190, -32768]`; `DeusExMover2` and `3` stock.

## What Play had, and what changed

Before: a colliding fan already ran the whole chain (`runActorRotation` -> `setScriptRotation` -> `level.moveActor` -> `moveTranslatingMover`), the stock map
booted and ticked. Two defects, both found by the oracle or the save:

1. **A saved non-colliding mover was dropped at load.** `game.mjs` skipped every mover whose `bCollideActors` was clear before giving it a lineage, brush
   model, collider or move host, so its first `physicsRotation` reached `mapMoveLevel`'s boundary. Now such a mover is a normal moving brush (`collision.movers`,
   the scene's `nonColliding` list, `movingBrush`, model, collider) that is simply not registered in the hash. In the installed maps no mover loads like this (census);
   it happens only for a restored level.
2. **The MoveActor tail was skipped for a rotation-only move.** `player-scene.mjs` `moveMover` ran the EndTouch pass and SetActorZone only when a
   Delta component was >= 0.0001 (a gate written for the doors' translation). The original runs them after every commit. `moveTranslatingMover` takes an
   `afterCommit` and `mover-move.mjs` `moverMoveTail` is the tail above; `moveMover` passes it and the gate is gone.

Nothing else changed: the same bodies run for any mover with a RotationRate and for any Physics value.

## Validation

* **Unicorn oracle, the whole chain** (`scripts/native-rotating-brush-oracle.py`, `scripts/validate-native-rotating-brush.mjs`): the unchanged
  `AActor::performPhysics` (`0x103c9770`) runs on the real `09_NYC_ShipFan` brushes (`DeusExMover1..3`, their models and authored poses) in the original level
  (real hash, `CheckEncroachment`, `IsBlockedBy`, `BeginTouch`/`EndTouch`/`IsOverlapping`, `moveSmooth` of a pushed actor, level vtable `+0x88`), `run_tail`
  past `0x10399d17` (the mover oracle stopped there before). 72 cases, **714 ticks**, one Unicorn process per case so the actor, the hash and the touch slots
  carry from tick to tick: the stock fans (Physics 9 and 5, 24 steady ticks of 1/60 and tick lengths from 0.001 to 0.1), pawn/decoration/pickup cylinders in the blades'
  sweep (accepted and rejected by `EncroachingOn`), held touches (collision word null, 2, 15), the fan as the save holds it (collision clear or only bCollideWorld, Location + 20000,
  yaw 19190, with cylinders near), and other rates (65536 crossing the 16-bit wrap, 3, -1, ...). The replay is Play's own code (`performActorPhysics`,
  `physicsRotation`/`fixedTurn`, `setScriptRotation`, `moveTranslatingMover` + `moverMoveTail`, `checkMoverEncroachment`, `createLevelQueries`, `moveSmoothActor`/`moveSmoothPawn`,
  `beginTouch`/`endTouch`/`isOverlapping`) over the same models; only the script events and `SetActorZone` are recorded boundaries, as in the other mover oracles.
  **0 mismatches** in Rotation, Location, OldLocation, Velocity, every actor's pose and touch slots, and the ordered trace (660 MoveActor entries, 608 commits, 52 refusals,
  958 hash queries with 931 hits in order, 596 pushes, 298 `EncroachingOn`, 246 `EncroachedBy`, 48 `UnTouch`, 608 zone refreshes). Mutation check:
  `RB_MUTATE=notail` (the old behaviour) fails **59 of the 72 cases**. Capture 2 min with 4 workers (`NATIVE_ORACLE_JOBS=1` is byte-identical serial);
  `--reuse` replays in seconds.
  The first replay differed in one case's hit order; that was the validator (a pawn view built after the placements re-registered the pawn, `HASH_KERNEL=js` and the Rust
  hash agreed), not Play, and the scene builds the views first now, as Play does at load.
* `node --test test/mover-move.test.mjs` (3 new tests for the tail), the existing mover oracles unchanged: `validate-native-mover-move` 37/37 (its harness
  gained only the `run_tail` switch, off by default), `validate-mover-frob`, `validate-island-blowitup`, `validate-mover-push-play` (Paris grill part A, Training door part B),
  `validate-npc-door-encroach` (5494 ticks).
* **Save0021 in Play** (`node scripts/validate-load-saves.mjs --slot <copy of Save0021>`): loads, ticks two seconds and travels to `09_NYC_Dockyard`. Over ten
  seconds the fan turns -333 per 1/60 tick (`_ftol(-20000 * dt)`), Pitch and Roll stay 32768/-32768, Location stays; `DeusExMover2/3` turn their pitch.
* **The same round trip with Play's own files** (`scripts/validate-rotating-brush-save.mjs`, no third-party data): `DeusExMover1` of the stock level is destroyed through its
  original `TakeDamage` -> `BlowItUp`, keeps spinning, `SaveGame 4` writes it, `LoadGame 4` restores it. The restored fan is non-colliding at z + 20000 and a tracked
  mover; over 300 ticks it turns exactly -333 in Yaw (Pitch and Roll untouched, Location fixed) and the stock fans turn their pitch -+500 per tick. Mutation check: with the old `game.mjs`
  the restored fan is not a tracked moving brush and the check fails (Save0021 showed the stop at its first tick).
* **Rendering** (`scripts/validate-rotating-brush-play.mjs`, Playwright new headless, worker mode, stock `09_NYC_ShipFan`): the brush tracker rebuilds all three fans
  every frame (revision 28 -> 74 over the probes), the page's mover meshes hold the tracker's transformed vertices bit for bit (906 vertices on 3 fans, on a frozen frame),
  and the yaw fan's polygon centroid keeps its circle and its atan2 falls (-84 degrees between the probes). The page needs no change: the tracker reads each mover's
  Location and Rotation fields every frame ([brush-tracker](brush-tracker.md)).

## The fan under the original (Wine, `scripts/save-probe.sh`, 2026-10-22)

The original (`DeusEx.exe`, GOTY 1112fm under Wine) loads `Save0021` through `LoadGame 21` (`Browse: Index.dx?loadgame=21`, `LoadMap: ..\Save\Current\09_NYC_ShipFan.dxs?load?loadonly?loadgame`,
`Possessed PlayerPawn: JCDentonMale 09_NYC_ShipFan.JCDentonMale2`, `Initialized moving brush tracker`), the first time a third-party save was loaded by it.
Six samples of `Rotation`, `Location`, the collision word and `Level.TimeSeconds` (`dump-actor-win`, one Wine call per sample, 12.6 to 13.7 s apart,
`.work/travel/fan4`):

| | Location | collision word | Rotation at T = 201.03 / 214.68 / 227.33 / 240.24 / 252.98 / 265.86 |
| --- | --- | --- | --- |
| `DeusExMover1` | (32, 48, 19696) | 0x0 | yaw 65121, 55048, 64961, 4226, 12399, 17655 (Pitch 32768, Roll -32768 throughout) |
| `DeusExMover2` | (96, 896, -448) | 0xd | pitch 52828, 37107, 51748, 58559, 4866, 12335 |
| `DeusExMover3` | (88, 1728, -448) | 0xd | pitch 12708, 28429, 13788, 6977, 60670, 53201 |

The state the save holds (Mover1 non-colliding at +20000, Mover2/3 colliding) is the state the original runs, and:

* each interval's turn is `rate * dT` less a shortfall toward zero of 48 to 76 units per second (yaw 62.1, 62.5, 59.2, 62.8, 63.0; the two pitch fans 48 to 76, mean 62):
  the signature of `_ftol` truncation at a tick rate near 120 per second (a rounding to nearest would show none, a floor on the negative rate a surplus);
* `DeusExMover2` and `3` (rates -30000 and +30000) are exact mirrors: the sum of their per-interval turns is 0 mod 65536 in all five intervals, which is
  the sign-symmetric truncation, whatever the unrepeatable tick lengths were;
* the yaw fan keeps Pitch 32768 and Roll -32768 unnormalized, as `physicsRotation` leaves an axis whose delta is 0.

**Not equal tick for tick.** The original's `DeltaTime` sequence is wall-clock and cannot be replayed, so no Wine sample can be compared with Play's N-th tick; the exact
per-tick equality is the oracle's (the original binary on Play's inputs and any tick lengths). The first sample is also 2993 units (0.15 s of spin) behind
what the saved yaw 19190 and TimeSeconds 186.75 predict, unexplained (the load's first frames are not sampled). The timings of the six samples are real; the per-second shortfall is
the only fitted number.

Measured next to it, outside this task: the original **stands the loaded player up** (Z -464.1, `Health` 82 unchanged; the save holds Z -491.1, crouched in the duct,
`bDuck` 1, CollisionHeight 16), Play keeps it crouched for as long as it ticks (`bDuck` 1 is a saved input flag nothing clears). That is the player's input/duck handling
after a load, not this subsystem; see the report.

## Encroachment

The oracle covers the native side exhaustively for the fans (above). In Play the original scripts run on top: the player placed in the sweep of
`DeusExMover3` (`farMoveActor`) is killed (Health 100 -> 0 within 90 ticks), with `DeusExMover3.EncroachingOn` and `JCDentonMale0.EncroachedBy` once per tick
and two `Bump`s, no stop, no unsupported boundary (`.work/fan-encroach.mjs`). **Unverified against the running original**: the original is not moved with `set Location`
in a ticking level ([visual-acceptance](visual-acceptance.md), "Placement constraint"), the loaded `Save0021` player stands 450+ units out of every blade, so the crush of a
pawn by a fan was not observed there. The native part (hit list, push vector 0, `EncroachingOn` before `EncroachedBy`, the commit after) is the oracle's, the script part is the VM's
(`Mover.EncroachingOn`, recovered earlier, [mover-push](mover-push.md)).

## Cost

Measured in the harness (`game.tick` only, 09_NYC_ShipFan, 4 rounds of 600 ticks, fans on against `RotationRate` zeroed): **0.97 to 1.36 ms per tick for the three fans**, about 0.35 ms each
(of the 8.3 ms budget at 120 fps), all in JavaScript. A CPU profile of 1500 ticks puts it in `moveTranslatingMover`: `checkMoverEncroachment` 66%, of which
`brushCollisionBounds` (a BigInt x87 emulation of the eight transformed corners, once per fan per tick) is 41% of the whole and the hash query itself 26%; `moverMoveTail` is 3%.
Only this map pays it. The Rust port that this measurement names is the mover's brush bounds (`brushToWorld` + the eight-corner box) and the encroachment query; it is
not done here, the JavaScript body stays the reference ([rust-core](rust-core.md)).

## Open

* The Rust twin above (measured, not started).
* The crush of a pawn by a stock fan against the running original (needs a placement the original does not allow); the first 0.15 s offset of the Wine samples.
* A static Brush hit, `bRotateToDesired` on a brush, and the Test-1 (`Move` with Test) branches of the brush route are not reached by any content and stay explicit boundaries.
* The loaded player's crouch (above).
