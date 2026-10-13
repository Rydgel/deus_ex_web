# ScriptedPawn's native Tick

Authority: DeusEx.dll `AScriptedPawn::Tick(FLOAT DeltaTime, ELevelTick TickType)` at `0x100195a0` (`0x100195a0..0x10019df5`), the
Tick virtual of every `AScriptedPawn` (vtable slot 25, the slot at `0x10027688`), with its helpers `0x10019e30` (agitation) and
`0x10019f60` (fear), and the Engine imports it calls: `AActor::Tick` (`0x103a1aa0`, the Super tick at the end), `AActor::InStasis`,
`UObject::FindFunctionChecked`, `FName::FName(TCHAR*, EFindName)` and `appSqrt`. The function was missing from Play until 2026-10-13.
[native vtable overrides](native-vtable-overrides.md) is the census that found nothing else of its kind reached by gameplay.

## How it was found

The live comparison of Island ([visual acceptance](visual-acceptance.md)) left Terrorist18 diverging when it sat down: MoveTimer
dropped by exactly 4 in the original at the tick after the sit started (`-2.445` against Play's `1.555`, in three fresh original runs).
`tools/dx-live-win.c watch-write 0x348` puts a hardware write watch on the pawn's MoveTimer (DR0, works under Wine) and logs the
writing instruction: the only write that is not the physics tail's `MoveTimer -= dt` (`0x103c9c37`) is at `0x10019bf8`, the instruction after
`fld [esi+0x348]; fsub 4.0; fstp [esi+0x348]` at `0x10019be6`: inside `AScriptedPawn::Tick`. Nothing in Play modelled the function: a
headless check set `ObstacleTimer`, `AvoidBumpTimer`, `AvoidWallTimer` and `AlarmTimer` to 1.5 on a pawn and ticked 30 frames; all four
were still 1.5.

## What it does, in the original's order

(`ScriptedPawn.uc` in the SDK is not shipped; the field names are the SDK header's, checked at the offsets by
`scripts/sdk-layouts.mjs --at AScriptedPawn <offset>`.)

1. **Gate.** `RemoteRole == 3`, `Role < 2` or `TickType == LEVELTICK_TimeOnly (1)` return through to the Super tick, with no other
   work, unless `bSimulatedPawn` (`0x30c` bit 6) is set.
2. **Unseen pawns leave.** `age = max(0, Level.TimeSeconds - LastRenderTime)` (the double minus the float, stored as a float32). A pawn
   with `bDisappear` (set by `Fleeing` and `Leaving.BeginState`) that `InStasis()` or whose age is over 5.0 is destroyed
   (`Level->DestroyActor(this, 0)`, ULevel vtable `+0x94`) and the function returns 1 **without** the Super tick. (A dead block of IsA
   tests for `APlayerPawn` between the age and this check has no effect.)
3. **PrePivot easing.** `PrePivotTime > 0`: if `DeltaTime < PrePivotTime`, PrePivot moves by `(Desired - PrePivot) * dt * (1/PrePivotTime)`
   per component (extended arithmetic with float32 stores at the original's `fstp`s) and PrePivotTime drops by dt; else PrePivot is
   DesiredPrePivot and PrePivotTime 0.
4. **Visible-only gate.** `bTickVisibleOnly` (`0x910` bit 10) with `DistanceFromPlayer > 1200` clears the "bleeding" flag used at the end.
5. **Helpers.** `0x10019e30`: `AgitationCheckTimer` counts down; `AgitationTimer` counts down and the amount of the tick it covers
   decays every non-permanent `AlliancesEx[i].AgitationLevel` (i from 15 to 0, only when `bAlliancesChanged`, which is cleared and set
   again while some level is still above 0). `0x10019f60`: `FearTimer` counts down and `FearLevel` decays by the same kind of amount.
6. **Timers.** `AlarmTimer` (unguarded: always subtracts, floors at 0); `WeaponTimer` grows by dt while a Weapon is held and is zeroed
   without one; `FireTimer`, `SpecialTimer`; `ReloadTimer` (counts down with a weapon, zero without or at 0); then `AvoidWallTimer`,
   `AvoidBumpTimer`, `ObstacleTimer`, `CloakEMPTimer`, `TakeHitTimer`, `CarcassCheckTimer` (guarded countdowns), `PotentialEnemyTimer`
   (clears `PotentialEnemyAlliance` when it runs out), `BeamCheckTimer`, `FutzTimer`, `PlayerAgitationTimer`, and `DistressTimer`
   (counts up while it is not negative; past `FearSustainTime` it becomes -1).
7. **Cloak.** `bHasCloak`: every tick `EnableCloak(Health <= CloakThreshold)`.
8. **Avoidance cleanup.** `bAdvancedTactics` and not (Acceleration nonzero and Physics walking and `TurnDirection != 0)`: clear
   `bAdvancedTactics`; if `TurnDirection != 0`, `MoveTimer -= 4.0` (undoing Bump's `+= 4`); `ActorAvoiding = None`, `NextDirection =
   TurnDirection = 0`, `bClearedObstacle = true`, `ObstacleTimer = 0`.
9. **Fire.** `bOnFire`: `burnTimer += dt`; at `BurnPeriod`, `ExtinguishFire()`.
10. **Bleeding** (unless the visible-only gate cleared it). With `BleedRate > 0` and `bCanBleed`: `x = clamp(BleedRate, 0, 1)`,
    `period = (1 - x) + 0.1`, `scaled = clamp(appSqrt(|Velocity|^2) / 512, 0.05, 1)`, `threshold = period / scaled`; `DropCounter += dt`,
    and `SpurtBlood()` fires once for each `threshold` in it; then `BleedRate -= dt / ClotPeriod`. `BleedRate <= 0` zeroes DropCounter
    and BleedRate.
11. The Super tick (`AActor::Tick`, `tickStandaloneActor`).

Events (`EnableCloak`, `ExtinguishFire`, `SpurtBlood`) are `FindFunctionChecked` by name then `ProcessEvent`: a class that does not declare
one gets the original's no-op.

## The check

* **Unicorn oracle.** `scripts/native-scripted-pawn-tick-oracle.py` runs the real DeusEx/Engine/Core/MSVCRT bytes (hash-checked) on a
  fabricated pawn; the leaves are the Super tick, InStasis, the level's DestroyActor, FName/FindFunctionChecked and ProcessEvent, which it
  records. `scripts/validate-scripted-pawn-tick.mjs`: 426 scenes (every timer at its edges, role and tick-type gates, PrePivot, agitation,
  fear, cloak, fire, avoidance, bleeding, bDisappear), every field at float32-bit precision, events with their parameter, calls in order,
  the returned value; 28 mutants all detected.
* **JavaScript body** `src/runtime/scripted-pawn-tick.mjs` (the reference; the 80-bit x87 model of script-vm.mjs, one rounding per
  operation, comparisons on the unrounded stack value as the code does).
* **Rust** `native/script-vm/src/sptick.rs`, called from `tick_body` (tick.rs) before `start`, in the same `tick_actor` crossing:
  `Ext` (x87.rs) arithmetic, the SP field table `SP_FIELDS` (actor-tick-kernel.mjs: offsets and bool masks from the cell registry), a
  per-pawn mask of the SP fields read in the image (a field a callback binds is read and written through js_tick_get / js_tick_set), and
  the events through `js_tick_event` (ids 7..10; the host looks the name up first and logs it). A ScriptedPawn runs the phase in Rust only
  when its class resolves every SP field to the table's cell (the `C_SCRIPTEDPAWN` flag) and no SP field is bound; otherwise the kernel
  hands the tick back and `processActorTick` runs the JavaScript body before `tickStandaloneActor`.
* **Rust against JavaScript.** `ACTOR_TICK_DIFFERENTIAL=1` replays the JavaScript phase on a virtual copy after every Rust tick
  (callbacks, lookups, zone times in order; every compared field including AlliancesEx). `scripts/validate-actor-tick-kernel.mjs` has a
  `scripted` family: 14,299 cases on 181 actors, identical results, errors, callbacks (EnableCloak 128, SpurtBlood 94, ExtinguishFire 8,
  destroy 496), image bytes. `validate-island-bark` under the differential: 540,589 ticks replayed, 0 mismatches.
* **Live.** Island, fresh 262-tick original run (worker mode, Rust path): every watched actor equal for all ticks, UNATCOTroop6 and
  Terrorist18 included, the stream draws equal.
* Also: `npm test` 622, `validate-pawn-physics-kernel` digests equal on every map and scenario, `validate-sim-split` (worker against inline),
  `validate-island-bark`, `validate-secretary-patrol`, `validate-mib-startup-boundary`, `validate-alter-destination`.
* **Cost.** Island, `bench-sim` (300 timed ticks after 60 warm-up, render feedback), five interleaved rounds against master: median of
  medians 17.32 ms (master) and 17.02 ms (here); per-round differences -2.1, +2.1, 0.0, -1.4, +0.6 ms. No measurable change on this host.
* **Population.** A 3,600-tick Island run: no tick error; the generators' births settle (2,425 to 2,597 actors, 59 to 74 pawns, nothing
  lost); five pawns marked `bDisappear` are all destroyed (with their inventory and shadows) after 5 s unseen; the Player start reset
  restores 2,425 actors and 59 pawns and the level ticks on.

## Not covered

* The hardware x87 control word on the game thread is the oracle's 0x037f (64-bit precision), as the other game-thread translations.
* NaN payloads of float32 fields are not reproduced (the JavaScript model's numbers and the image keep a NaN, not its payload).
* The helpers' names (`UpdateAgitation`, `UpdateFear`) are ours; the fields and arithmetic are the original's.
