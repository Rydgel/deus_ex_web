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
returns). The Pawn entry (`script-pawn-physics.mjs` `moveActorHit`, over the
Rust pawn move kernel) does not report it yet: see Unverified.

## Implementation

- `move-smooth.mjs` `moveSmoothActor(actor, delta, services)`: `moveSmooth`
  over the pushed actor's own `playerMove` (the recovered MoveActor, with the
  scene services of `ScriptRuntime.spawnedMoveServices`).
- `ScriptRuntime.moveSmoothActor(actor, delta)`: a serialized map actor goes
  through `mapMoveLevel` (collision view, `linkLiveCollision`), a spawned
  collision-view actor through `levelFor`; Pawns keep `moveSmoothPawn`.
- `player-scene.mjs` `pushedMoveSmooth` routes every non-Pawn, non-Brush hit
  to the `moveSmoothActor` hook (`script-doors.mjs`); `mover-move.mjs` no
  longer throws for it. A pushed *Brush* (a static one is pushed in the
  original) stays an explicit unsupported branch.
- No Rust twin: the rider pass in Rust (`vm.moveActor.rider`) is a different
  call, and nothing here is on a hot path.

## Evidence

`scripts/validate-native-mover-push.mjs` runs the original `MoveActor` and
`FarMoveActor` in Unicorn (`native-mover-move-oracle.py`, the Training
`DeusExMover16` harness) with plain `Actor` cylinders as the pushed class and
replays each case through the JavaScript composition Play uses, comparing
every query and its hits, `moveSmooth` entry, hash remove/add, event, zone
boundary, position, rotation and touch slot in order. 108 cases, 144 pushes,
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
  (`scripts/mover-push-play-door.mjs`).

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
- The Pawn entry's `moveSmooth` (`moveSmoothPawn`) does not yet keep the first
  hit when its second `MoveActor` returns early (see above), so a pawn pushed
  into a wall with a zero slide misses `HitWall`.
- A pushed *spawned* actor runs the same `playerMove` body (exercised by the
  fragment in Part B) but has no oracle scene of its own; a rotating mover
  with a changing Location (a door that swings and slides) is covered only by
  the `[4,0,0]` + yaw case.
- A static Brush hit, which the original pushes, is still unsupported.
