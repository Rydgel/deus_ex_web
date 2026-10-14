# A moving brush pushing a non-Pawn actor

Report: in 10_Paris_Club, opening the grill at the bottom of the toilet wall
paused Play with "Unsupported blocking non-Pawn mover push"
(`mover-move.mjs`). The grill is `DeusExMover4` (Location -1712,-1476,-160,
`MoverEncroachType` 3 = `ME_IgnoreWhenEncroach`, `KeyRot[1]` roll -16384,
`KeyPos[1]` = base position: a pure roll about the panel's top edge). Its
swing meets `Toilet0` (class `Toilet2`, a `DeusExDecoration`, flags 15,
radius 18, height 30.25, `bInvincible`) in the last third of the turn.

## Original source of truth

`ULevel::CheckEncroachment` (Engine.dll `0x1039a350`), moving-brush source
(`docs/check-encroachment.md`, "Moving-brush source"). For each hit of the
`ActorEncroachmentCheck` query (virtual +0x1c) that `IsBlockedBy` accepts:

- `0x1039a4e5`-`0x1039a50c`: the source must be a non-static Brush
  (`+0x178` Brush primitive, `IsA(Brush)`, `+0x28 & 1` clear);
- `0x1039a512`-`0x1039a534`: only a *Brush* hit is exempt, and only when it is
  not static. **There is no Pawn test.** Every other hit reaches the push;
- `0x1039a53a`-`0x1039a577`: `call AActor::moveSmooth` (`0x10301532`, a thunk
  to `0x103c9020`) on the hit with `float(proposed - Location)`, whatever its
  class; `0x1039a6f6`-`0x1039a773` is the reverse push, with the mover's
  Location temporarily at the proposed pose (not re-hashed), the offset times
  float -1;
- between them: re-query at the proposed pose and NewRotation, and a hit that
  is no longer in the list is skipped (`0x1039a5c0`-`0x1039a5db`);
- then `source.EncroachingOn(other)`; true returns at once, before any pose or
  hash commit. After the loop, with `notify`, the `EndTouch` pass; the second
  pass dispatches `other.EncroachedBy(source)` on blocking hits
  (`0x1039a81f`).

So the Pawn restriction was only the scope of Play's evidence, never a
property of the original. The push vector of a mover that only rotates is
`proposed - Location = 0`: nothing is displaced. The consequence at the grill
(and for JC standing in the swing) is entirely `Mover.EncroachingOn`'s
script: a `Decoration` or `Carcass` takes `TakeDamage(10000, ..., 'Crushed')`
and the call returns false; a `Fragment` is destroyed; otherwise
`MoverEncroachType` decides (`Mover.uc:584-651`). The toilet is invincible, so
it stays where it is and the grill opens through it. The expectation that JC
or the toilet is "pushed back a bit" holds for translating movers (below),
not for this grill.

`AActor::moveSmooth` (`0x103c9020`, `docs/move-smooth.md`) calls
`ULevel::MoveActor` on the pushed actor. That body is source-type independent
(`docs/move-query.md`, `docs/script-map-actor-move.md`): hash remove/add,
`Bump`/`BumpWall` of its own hits, `BeginTouch`, `SetActorZone`, and, for a
non-Pawn source, its own `CheckEncroachment` (`0x10399bb5`-`0x10399c8e`)
before the commit.

### One FCheckResult for both MoveActor calls

`moveSmooth` passes the same `FCheckResult` to its first and second
`MoveActor`. A `MoveActor` that returns before writing it leaves the first
hit in place: a static/immovable actor (`0x10399145`) and a sub-threshold
Delta with an unchanged rotation (`0x10399228`; the other `MoveActor` paths
copy a fresh `Time = 1` hit into the argument at `0x10399294`). A pickup
pushed straight down into the floor therefore has a zero slide, a second
`MoveActor` that returns early, and `Hit.Time < 1` still holds: `HitWall`
and `TwoWallAdjust` run with the first call's normal and actor. The oracle
caught this (6 of the first 79 cases); `moveSmooth` now keeps the first hit
when the callback reports `hitUntouched` (set by `playerMove` on both early
returns). The Pawn entry reports it too: `script-pawn-physics.mjs`
`moveActorHit` passes it on from `playerMove` or from the Rust pawn body
(`move_pawn.rs` writes it as `MP_IO[13]` on the same two returns), and the
controlled player's own push (`player-scene.mjs` `pushedMoveSmooth`) passes
it on from its `playerMove`. A Pawn pushed straight down into the floor
therefore gets `BumpWall` from its first call, then `HitWall` with the floor
normal and `LevelInfo` (the `pawn-floor` scene below).

## Implementation

- `move-smooth.mjs` `moveSmoothActor(actor, delta, services)`: `moveSmooth`
  over the pushed actor's own `playerMove` (the recovered MoveActor, with the
  scene services of `ScriptRuntime.spawnedMoveServices`).
- `ScriptRuntime.moveSmoothActor(actor, delta)`: a serialized map actor goes
  through `mapMoveLevel` (collision view, `linkLiveCollision`), a spawned
  collision-view actor through `levelFor`; Pawns keep `moveSmoothPawn`.
- `move-smooth.mjs` `moveSmoothPawn(view, delta)`: `moveSmooth` over a pawn
  physics view's `moveActorHit` and event dispatch. `ScriptRuntime.moveSmoothPawn`
  calls it, and so does the `pawn-floor` replay.
- `player-scene.mjs` `pushedMoveSmooth` routes every non-Pawn, non-Brush hit
  to the `moveSmoothActor` hook (`script-doors.mjs`); `mover-move.mjs` no
  longer throws for it. A pushed *Brush* (a static one is pushed in the
  original) stays an explicit unsupported branch.
- No Rust twin of `moveSmooth`: the rider pass in Rust (`vm.moveActor.rider`)
  is a different call, and nothing here is on a hot path. The Pawn's
  MoveActor itself runs in Rust when the pawn is admitted; its `hitUntouched`
  word is checked against the reference's two early-return conditions on
  every completed call under `MOVE_PAWN_DIFFERENTIAL=1`. The maps' own moves
  never take either return in the Rust host, so `validate-pawn-move-kernel.mjs`
  runs `scripts/scenarios/pawn-push-floor.mjs` on Island: every walking pawn
  pushed straight down through `moveSmoothPawn`, and moved once with
  `bMovable` cleared (649 of 1399 Rust moves with the Hit unwritten, the same
  digests as the JavaScript path). The digests alone would not show it: they
  are the same with `hitUntouched` forced off, since Island's walking pawns'
  `HitWall` leaves the digested state as it was.

## Evidence

`scripts/validate-native-mover-push.mjs` runs the original `MoveActor` and
`FarMoveActor` in Unicorn (`native-mover-move-oracle.py`, the Training
`DeusExMover16` harness) with plain `Actor` cylinders as the pushed class and
replays each case through the JavaScript composition Play uses, comparing
every query and its hits, `moveSmooth` entry, hash remove/add, event, zone
boundary, position, rotation and touch slot in order. 130 cases, 181 pushes,
0 mismatches:

- 79 `training` cases: translations in three axes and magnitudes, accepted
  and rejected by `EncroachingOn`; rotation only (the grill: zero push
  vector); rotation with translation; collision words 1, 3, 5, 7, 15 (only
  `bCollideWorld` on the pushed actor makes the mover push it) and a
  pickup-sized item; the pushed actor meeting a second one (`Bump`,
  `BumpWall`, slide, `HitWall`, `TwoWallAdjust`) or the BSP; the mover with
  `bCollideWorld`; `FarMoveActor` (notify 1) into it, with a held touch, and
  onto non-blocking cylinders;
- 23 `paris-grill` cases: `DeusExMover4`'s real brush at its real pose and
  `Toilet0`'s real cylinder, one `MoveActor` per roll from -1000 to -16384,
  accepted and rejected. The original finds no contact up to roll -9213 and
  contact from -10000 on (push vector `[0,0,0]` twice, `EncroachingOn`
  then `EncroachedBy`); a toilet 60 units away is never reached;
- 6 `play-door` cases: pushes recorded from the Play run below, on
  Training's leaf and an `Ammo10mm2` squeezed against the frame. The original
  ends the pickup exactly where Play does, in all six
  (`scripts/mover-push-play-door.mjs`);
- 22 `pawn-floor` cases: a Pawn (kind `Pawn`, `Engine.Pawn`'s class
  `0x1058c660` in `native-level-oracle.py`; radius 17, height 42, flags 15) on
  Training's floor at (-360, 800), with `DeusExMover16`'s leaf placed 0.5
  above it and moved down 1, 4 and 16 units, the pawn's center from -84.5
  (touching the Z -128 floor) to -56 (clear of the push), two rejected by
  `EncroachingOn`, and two pushes with a slide along the floor. The replay
  runs `moveSmoothPawn` over a real `pawnPhysicsView` (JavaScript
  `playerMove` body). In 14 cases the original's trace is `BumpWall`, then
  `HitWall` from the kept floor hit, then the reverse push into the leaf
  (`Bump` pair, `HitWall` again). With `moveActorHit`'s `hitUntouched` forced
  false the replay misses those `HitWall`s in the same 14 cases; the two
  slide cases have no `HitWall` in the original either.

`scripts/validate-mover-push-play.mjs` (live Play, fails before the change
with the reported pause):

- Part A, 10_Paris_Club: JC aims at the grill with the input fixture and
  frobs it (`game.use()` -> `ParseRightClick` -> `DeusExMover.Frob`); the
  grill reaches roll -16384 with no pause; `EncroachingOn(Toilet0)` runs for
  110 steps from committed roll -9213 (the original's contact interval),
  each with `EncroachedBy`, every push vector is zero, and the toilet's
  position and HitPoints are unchanged (`bInvincible`);
- Part B, 00_Training: `DeusExMover16` closes on an `Ammo10mm2` (480 pushes,
  one `PlasticFragment` spawned by the same run is pushed as a spawned
  actor); the six recorded groups match the `play-door` originals.

`node --test test/mover-move.test.mjs test/move-smooth.test.mjs` hold the
non-Pawn push order and the shared-Hit rule.

## Unverified

- The grill in the *running original*. Reaching the toilet needs the player
  placed there; the original is never moved with `set Location` in a ticking
  level (`docs/visual-acceptance.md`, "Placement constraint") and held keys do
  not move it. The contact interval and the zero push come from the original
  `CheckEncroachment` over the club's real brush and cylinder in Unicorn.
  Play's `TakeDamage(10000, 'Crushed')` and the invincible refusal are the
  script VM's (`DeusExDecoration.TakeDamage`), not compared with the original
  process.
- The Rust pawn MoveActor's `hitUntouched` is not compared with the original
  directly: the `pawn-floor` replay runs the JavaScript body (no script VM
  image there), and the Rust word is held to that body's conditions by the
  differential above.
- The controlled player pushed by a mover passes `hitUntouched` on through
  the same `playerMove`, but has no oracle case of its own: the oracle's
  pushed Pawn has no `Player`, so `GetPlayerPawn`'s player branches of the
  candidate test are not exercised there.
- A pushed *spawned* actor runs the same `playerMove` body (exercised by the
  fragment in Part B) but has no oracle scene of its own; a rotating mover
  with a changing Location (a door that swings and slides) is covered only by
  the `[4,0,0]` + yaw case.
- A static Brush hit, which the original pushes, is still unsupported.
