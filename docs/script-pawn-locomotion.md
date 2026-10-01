# Pawn latent locomotion natives — MoveTo/MoveToward/TurnTo/TurnToward/WaitForLanding

This document records the original implementation behind the five `APawn`
latent movement natives and their per-tick polls, the recovered field layout
they operate on, and the oracle evidence each behavior is validated against.
The translation lives in `src/runtime/script-pawn-locomotion.mjs`; the runtime
wiring is `pawnLocomotion`/`pollPawnLocomotion` in
`src/runtime/script-runtime.mjs`.

## Original evidence

The primary binary is `Deus Ex GOTY Edition/System/Engine.dll`, SHA-256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`, image base
`0x10300000`. Supporting binaries: `Core.dll`
(`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`, base
`0x10100000`) and `MSVCRT.dll`
(`e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210`). The
declarations are `.cache/reference/Pawn.uc`; the per-body disassemblies are
`.cache/pawn-loco/*.asm`.

`Pawn.uc` declares:

```uc
native(500) final latent function MoveTo( vector NewDestination, optional float speed );
native(502) final latent function MoveToward( actor NewTarget, optional float speed );
native(508) final latent function TurnTo( vector NewFocus );
native(510) final latent function TurnToward( actor NewTarget );
native(527) final latent function WaitForLanding();
```

## Latent codes

Each setup body installs its poll through `Pawn->StateFrame+0x24` (the
`LatentAction` dword); each poll clears the same slot to resume script
execution. Setup bodies run under `GNatives[index]`; poll bodies run under the
same table at the poll index — `ProcessState` calls
`GNatives[latent](pawn, StateFrame*, &DeltaSeconds)`.

| native | setup index | poll index | setup body | poll body |
| --- | ---: | ---: | ---: | ---: |
| MoveTo | 500 | 501 (`0x1f5`) | `0x103bceb0` | `0x103bd060` |
| MoveToward | 502 | 503 (`0x1f7`) | `0x103bd150` | `0x103bd370` |
| StrafeTo | 504 | 505 (`0x1f9`) | `0x103bd5f0` | `0x103bd7d0` |
| StrafeFacing | 506 | 507 (`0x1fb`) | `0x103bd8c0` | `0x103bdad0` |
| TurnTo | 508 | 509 (`0x1fd`) | `0x103bdec0` | `0x103be020` |
| TurnToward | 510 | 511 (`0x1ff`) | `0x103bdbf0` | `0x103bdd60` |
| WaitForLanding | 527 | 528 (`0x210`) | `0x103bb6f0` | `0x103bb730` |

Shared helpers reached from the bodies:

| helper | body | thunk | role |
| --- | ---: | ---: | --- |
| move-timer setter | `0x103be160` | `0x10301226` | `MoveTimer = dist*1.3/(base*DesiredSpeed) + 1`, `0.5` on zero/unordered |
| steer/arrive | `0x103be200` | `0x103024fa` | Touch gate, arrive radii, normalize, accel, melee/decel/brake, fall path |
| facing | `0x103be980` | `0x10303aa3` | `DesiredRotation = (Focus−Location).Rotation()`, completion cone |
| `FVector::Rotation` | `0x10144390` | — | FPATAN × embedded scale `10430.219195527361` (`0x10178050`) |
| `FCoords::FCoords(FRotator)` | `0x1011b690` | — | GMath sine-table axes, roll→pitch→yaw in-place passes |
| `_ftol` | MSVCRT `0x1016eec0` | — | FISTTP-style truncate, low dword |

## Pawn field layout

Offsets recovered from the APawn/AActor `ECppProperty` registration sites and
confirmed by every body's direct loads/stores:

| field | offset | type |
| --- | ---: | --- |
| `StateFrame` | `+0x0c` | pointer (latent at `+0x24`) |
| `Physics` | `+0x30` | byte (`EPhysics`: walking 1, falling 2, swimming 3, flying 4, spider `0xa`) |
| `LatentFloat` | `+0xe0` | float32 |
| `Location` | `+0x114` | vector f32 |
| `Rotation` | `+0x120` | rotator i32 |
| `Velocity` | `+0x144` | vector f32 |
| `Acceleration` | `+0x150` | vector f32 |
| `CollisionRadius` | `+0x1d4` | float32 |
| `CollisionHeight` | `+0x1d8` | float32 |
| `RotationRate` | `+0x1fc` | rotator i32 |
| `DesiredRotation` | `+0x208` | rotator i32 |
| flags word A | `+0x318` | `bCanStrafe` `0x200` · `bReducedSpeed` `0x800` · `bCanSwim` `0x4000` (read via `test ah,0x40`) · `bAdvancedTactics` `0x80000000` |
| flags word B | `+0x31c` | `bCanGlide` `0x02` |
| `AvgPhysicsTime` | `+0x32c` | float32 |
| `MoveTimer` | `+0x348` | float32 |
| `MoveTarget` | `+0x34c` | object ptr |
| `FaceTarget` | `+0x350` | object ptr |
| `Destination` | `+0x354` | vector f32 |
| `Focus` | `+0x360` | vector f32 |
| `DesiredSpeed` | `+0x36c` | float32 |
| `MaxDesiredSpeed` | `+0x370` | float32 |
| `MeleeRange` | `+0x374` | float32 |
| `GroundSpeed` | `+0x378` | float32 |
| `WaterSpeed` | `+0x37c` | float32 |
| `AirSpeed` | `+0x380` | float32 |
| `AccelRate` | `+0x384` | float32 |
| `Floor` | `+0x3fc` | vector f32 |
| `Region.Zone` | `+0xc8` | object ptr (ZoneInfo: class `+0x24`, `ZoneGravity.z` `+0x324`, `bWaterZone` bit0 `+0x388`) |

## Setup bodies — mutation order

All setup bodies evaluate **every** argument expression before the first field
write. Omitted optionals leave the pre-seeded `1.0f` slot (`EX_Nothing`
consumes no operand). `MoveTo`/`MoveToward` clamp `DesiredSpeed` to
`min(MaxDesiredSpeed, speed)` floored at `0` and clear `bReducedSpeed`.

- **MoveTo**: deltas `d = dest − Location` on the 80-bit stack → `MoveTarget=0`
  → `bReducedSpeed=0` → `DesiredSpeed` clamp → `dist = sqrt(dz²+dy²+dx²)` →
  move-timer helper → `latent=501` → `Destination=dest` → `Focus=dest` →
  facing helper → steer/arrive helper (return value discarded).
- **MoveToward**: null target returns after both arg evals, before any write →
  f32-rounded deltas → `bReducedSpeed=0` → `DesiredSpeed` clamp → pawn target
  pins `MoveTimer=f32(1.2)`, others take the distance formula →
  `MoveTarget=target` → `Destination=Focus=target.Location` → `latent=503` →
  facing → steer/arrive.
- **TurnTo**: `MoveTarget=0` → `latent=509` → `Focus=arg` → glide acceleration
  when gliding → facing helper.
- **TurnToward**: null target returns before any write → `FaceTarget=target` →
  `latent=511` → glide acceleration when gliding → `Focus=target.Location`
  (snapshot) → facing helper.
- **WaitForLanding**: `Code++` → `LatentFloat=2.5` → `latent=528` only while
  `Physics==PHYS_Falling`.

## Poll bodies — resume conditions

- **WaitForLanding (528)**: `Physics != 2` → `latent=0`, resume. While
  falling: `LatentFloat -= dt`; the compare uses the **retained 80-bit value**
  (`fst` store then `fcomp`), and `LongFall` fires via `FindFunctionChecked` +
  `ProcessEvent` every tick once negative — the latent is **not** cleared.
- **TurnTo (509)**: glide acceleration when gliding, then the facing helper on
  `Focus`; `latent=0` when facing reports complete.
- **TurnToward (511)**: `FaceTarget==0` → `latent=0`. Otherwise glide
  acceleration, `Focus` re-snapshots the **live** target location each tick,
  facing helper, `latent=0` on completion.
- **MoveTo (501)**: `Destination` is snapshotted before and restored after the
  event+helpers (immune to event side effects). `bAdvancedTactics` + walking
  runs `pawn.FindFunctionChecked(SpawnNotification)` → `ProcessEvent` — on
  shipped pawn classes the lookup misses (only `SpawnNotify` declares the
  function), the miss path is a nonfatal `Logf` returning NULL, and
  `AActor::ProcessEvent`'s `XLevel+0x4f0` bit-0x2 gate drops the NULL before
  Core `ProcessEvent` dereferences it: an effective no-op. The runtime
  therefore dispatches the event only when the receiver's class chain
  actually resolves it — observable contract unchanged. Facing helper then
  steer/arrive; `latent=0` when the helper reports done.
- **MoveToward (503)**: `MoveTarget==0` → `latent=0`. Destination is rebuilt
  each tick from the live target location — flying pawn targets offset
  `z += CollisionHeight*0.7`, Spider physics offsets by
  `CollisionRadius*Floor` — then `Focus=Destination`, `DesiredSpeed` is saved,
  the same tactics `SpawnNotification` lookup fires (NULL-resolution no-op as
  above), helpers run, `latent=0` on done, `Destination`
  re-snapshots the live location, and pawn targets unconditionally restore
  `DesiredSpeed` plus force `MoveTimer=-1` when the target's
  `Region.Zone+0x388&1` water flag is set and the pawn lacks `bCanSwim`
  (null zone reads `*0x388==0`, i.e. not water).

## StrafeTo and StrafeFacing (added 2026-10-01)

Deus Ex declares both with a trailing `optional float speed` (Pawn.uc,
"DEUS_EX STM - added new param"); the execs read it with a default of 1.0.
UNATCO Island's terrorists reach StrafeFacing from ScriptedPawn's Attacking
state within twenty seconds when Play draws them (render feedback), so it
was the first boundary of a player who stands near the dock.

* **StrafeTo setup** (`0x103bd5f0`): NewDestination, NewFocus, Speed; P_FINISH;
  `Dest − Location` on the 80-bit stack; bReducedSpeed (`+0x318` bit 11)
  clears and MoveTarget is cleared; a **bIsPlayer** pawn (bit 1, tested on the
  dword read before the clear) copies MaxDesiredSpeed into DesiredSpeed, any
  other pawn clamps like MoveTo (`min(Max, Speed)` by FCOM, then `max(0, ·)`);
  the move timer from `appSqrt((dz²+dy²)+dx²)`; latent 505; Destination and
  Focus; then the facing helper on Focus and steer/arrive on Destination.
  MoveTo has no bIsPlayer branch.
* **StrafeFacing setup** (`0x103bd8c0`): NewDestination, NewTarget, Speed;
  P_FINISH; a None target returns with no write. Otherwise as StrafeTo except
  that MoveTarget is untouched, FaceTarget takes the target, Focus copies its
  Location, and the latent is 507.
* **StrafeTo poll** (`0x103bd7d0`): Destination saved; the bAdvancedTactics
  walking SpawnNotification event; facing on Focus; steer/arrive on
  Destination (arrival clears the latent); Destination restored.
* **StrafeFacing poll** (`0x103bdad0`): FaceTarget None clears the latent;
  Focus re-copies the target's Location; Destination saved; facing **before**
  the tactics event (MoveTo's poll has the event first); steer/arrive;
  Destination restored. Both polls pass the helpers live `&Focus` and
  `&Destination` pointers.

`validate-pawn-locomotion` runs the four bodies in the same Unicorn probe:
34 new scenes (speed default, clamps, bIsPlayer with and without
bReducedSpeed, flying, swimming, spider, falling, arrival, the None target,
MoveTarget kept, tactics, Touch, braking), 142/142 bit-exact with 6 new
mutants among 28/28 detected. The two polls also run in the Rust tick
(`loco.rs`), checked against these bodies by `validate-locomotion-kernel`.

## Steer/arrive helper (`0x103be200`) — return conditions

Returns 1 (poll clears latent) on: horizontal `dx²+dy² < 256` **and**
`|dz| < max(CollisionHeight, 48)` (walking physics zeroes `d.z` first, so the
vertical bound is unreachable there); `MoveTimer < 0` (compared against a
qword zero); pawn `MoveTarget` within
`CollisionRadius_target + CollisionRadius + MeleeRange*0.8` (the `0.8` is the
embedded double `0.8000000000000000444`, so equality is not exact); brake
radius `AvgPhysicsTime*speed*1.4 < dist` while gliding (gliders then cap
`DesiredSpeed` at `200/speed` and halve it once via `bReducedSpeed`).

Returns 0 on: falling without low gravity; falling with `Velocity.Z >= 0`;
`Location.Z + 100 >= dest.Z` in the falling path; brake radius
`>= dist` (keep polling).

The falling path steers only when `ZoneGravity.z > ClassDefault.ZoneGravity.z *
0.9` (the `fcompp` direction — `-100` low-gravity qualifies, `-950` does not),
zeroes `d.z` before `SafeNormal`, writes `Acceleration = dir*AccelRate`, and
reaches the resume compare through a `jmp` that lands **on** the `jne` at
`0x103be7a9` — skipping a `test esi,esi` glide reload, so the surviving flags
are the `Location.Z+100 < dest.Z` compare.

The Inventory-target `Touch` gate fires before distance math when
`|Location.z − target.z| < CollisionHeight` and `CollisionRadius² > dx²+dy²`
(strictly greater, unordered-inclusive via `fcompp` flags); `ProcessEvent`
receives the pawn as `parms[0]`.

Deceleration steering (`speed > 100`, non-glide): `Acceleration -= (v̂ − d̂) *
(1 − v̂·d̂) * speed * 0.2`, with `v̂z` kept in 80-bit while `v̂x/v̂y` use the
f32-stored reciprocal — the same asymmetry the normalize path keeps for `d.z`.

## Facing helper (`0x103be980`) — completion cone

`DesiredRotation = (dest − Location).Rotation()`; yaw masked `& 0xffff`.
Walking zeroes pitch unless `MoveTarget` is a Pawn (the `IsA` chain walk
against `APawn PrivateStaticClass` `0x1058c660`). PHYS_Spider returns 1
immediately. Completion: `|Δyaw| < 0x7d0` or `|Δyaw| > 0xf82f` — the wrapped
clause makes a yaw of `63536` (i.e. `-2000` masked) complete while `+2000`
does not; the tolerance is asymmetric.

## Oracle provenance

`scripts/native-pawn-latent-probe.py` runs every setup/poll body byte-for-byte
under Unicorn on the hash-verified image, with fabricated pawn/target/zone/
class memory, `GNatives` expression stubs, a recording `ProcessEvent` stub
(`{this, fn, parms, extra, *parms}`), a `FindFunctionChecked` patch returning
sentinel function pointers, and the `FVector::Rotation` body intercepted.

`FVector::Rotation` is the single FPATAN path; Unicorn is not authoritative
for transcendental state, so the probe answers it from a hardware table
generated by `tools/pawn-rotation-probe.exe` (compiled mingw-w64, run under
CrossOver/Wine) which executes the identical x87 sequence — `fpatan(y,x)` yaw,
`fpatan(z, sqrt(x²+y²))` pitch, `fmul` by the embedded double
`10430.219195527361`, and the shipped `_ftol` truncation — on real silicon.
Inputs with no table row raise `RotationOracleMiss` rather than approximating.

`scripts/validate-pawn-locomotion.mjs` compares per scene: the latent code,
bytecode cursor advance, every mutated field at float32 **bit-pattern**
precision (`-0`/NaN payloads included), object references, and the ordered
event list including the Touch `parms[0]` payload. 108/108 scenes are
bit-exact; 22/22 targeted mutants (physics gates, tolerance boundaries, flag
bits, store order, timer formula, FCOM zero ordering) are detected.

`vectorToRotator` (the runtime's `FVector::Rotation` model) was itself swept
against 3080 hardware rows bit-exactly — `Math.atan2` + f64 multiply + trunc
reproduces the probe over the supported finite inputs. Non-finite rotation
inputs remain unsupported (the hardware row is generated per finite input).

## x87 precision requirements

The bodies keep intermediates on the 80-bit stack and store float32 per
component; the module uses the shared `x87load/add/neg/mul/div/recip/sqrt/
store/storeDouble/safeNormal/width` model. Sites where the retained/rounded
distinction matters:

- `WaitForLanding` poll compares the retained 80-bit `LatentFloat − dt`
  (`fst`, not `fstp`). Observable only through unordered inputs — f32−f32
  differences are always f32-exact — so the store/keep split is documented
  rather than mutation-covered.
- `steerArrive200` keeps `d.z`/`v̂z` in 80-bit while x/y round through f32.
- The move-timer helper compares the product `base*DesiredSpeed` against zero
  with `test ah,0x40` — unordered (NaN) takes the `0.5` fallback.
- FCOM orders an exact 80-bit zero below every positive and above every
  negative operand. Four `steerArrive200` compares can meet a computed zero
  (exponent field 0) against a nonzero operand: the falling air-control gate
  (`DefaultGravityZ*0.9`), the falling resume (`Location.Z+100`), and the
  Inventory Touch height (`dz`) and radius (`CollisionRadius²` vs `d2`, either
  side zero). `pmt-touch-same-z-thin`, `pmt-touch-same-xy-thin`,
  `pmt-touch-zero-radius`, `pmt-fall-resume-zero-sum` and
  `pmt-fall-zero-default-grav` pin them; mutant `fcom-one-sided-zero` flips
  all five.
- All embedded doubles (`1.3`, `0.8`, `1.4`, `0.2`, `0.5`, `0.7`, `0.9`, `1`)
  load through the exact qword-widening path, not float literals.

## Physics-integration boundary

The natives reproduce exactly the original's script-visible footprint: they
read `Physics/Location/Velocity/Floor/Region.Zone` and write
`Acceleration/Desired*/Destination/Focus/MoveTarget/FaceTarget/
DesiredRotation/MoveTimer/LatentFloat` plus the latent slot. Actually moving
the pawn — collision, stepping, zone transitions — is the host physics
engine's job, identical to the original split where `be200` only sets
`Acceleration` for the physics tick to consume. `pawnLocomotion` wires
`script-runtime.mjs`'s reflected fields; `locomotionZone` projects
`Region.Zone` + the ZoneInfo class default's `ZoneGravity.z` (the
`zone->Class->ClassDefaultObject+0x324` assert read) +
`bWaterZone`.

Explicitly unverified/unsupported:

- `StrafeTo`/`StrafeFacing` (natives 504/506) are separate bodies not covered
  here.
- The dead `test ah,1` + unconditional `jmp` at `0x103be35d` is reproduced as
  documented above (the glider-steer branch is unreachable on the falling
  path).
- NaN `dt`/destination inputs are handled through the unordered-compare model
  but have no oracle coverage — the probe serializes non-finite floats as
  `f32:0xXXXXXXXX` tokens only in outputs, not scene inputs.
- `vectorToRotator` non-finite inputs are unsupported.

## Live patrol verification — 00_Training Secretary0

`ScriptedPawn.Patrolling` (extracted `ScriptedPawn.uc`): `WaitForLanding` →
`PickDestination` (`destPoint = PatrolPoint(destPoint).NextPatrolPoint`, else
`PickStartPoint`; `None` → `GotoState('Standing')`) → `Moving` loop
(`FindPathToward` → `MoveToward` → `CheckDestLoc` until
`MoveTarget==destPoint`) → `Pausing` (`pausetime>0` or no next point:
`TurnTo(Location+lookDir)` → `Sleep(pausetime*(1-0.9*restlessness))`) →
`Goto('Patrol')`. `HitWall` calls `CheckOpenDoor`; `SetFall` resumes at
`ContinuePatrol`.

`PatrolPoint.PreBeginPlay` (Engine.u export 4305, one-based, decoded bytecode;
also checked against the class's embedded ScriptText):

```uc
lookDir = 200 * vector(Rotation);            // @0: native 213
NextPatrolPoint = None;                      // @17
if (Nextpatrol != 'None')                    // @24: native 255 name!=
    foreach AllActors(class'PatrolPoint', CurPoint, Nextpatrol)  // @39: native 304
        if (CurPoint != self)                // @60: native 119, EX_Self @69
        {
            NextPatrolPoint = CurPoint;      // @71
            break;                          // @82: jump to IteratorPop @86
        }
Super.PreBeginPlay();                        // @87: final functionIndex=207
```

The loop selects the first matching actor other than itself. The source's
empty name literal is encoded as name-table index 0 (`None`).

The original `UGameEngine::LoadMap` dispatches `PreBeginPlay` to **every** actor in
a dedicated pass (`0x1038d99a`–`0x1038d9cc`, docs/pawn-list.md), so each
serialized `Nextpatrol` name resolves at load: `PatrolPoint4 → PatrolPoint5`
(sec1→sec2), `PatrolPoint5 → PatrolPoint4`, `PatrolPoint0 ↔ PatrolPoint1`
(comp1↔comp2). The demonstrated runtime gap was that only pawn-ancestry actors
ran the chain, so `NextPatrolPoint` stayed `None` and the patrol terminated in
`Standing` after the first leg. `script-doors.mjs` now admits
`engine.patrolpoint`-ancestry actors to the same load/reset chain and runs the
recovered shared pass structure — `InitExecution`, startup flags,
`PreBeginPlay`, `BeginPlay`, `SetActorZone`, `LastRenderTime=-10`,
`PostBeginPlay`, `SetInitialState`, base fixup, `bStartup` clear,
`PostPostBeginPlay` and the static/dynamic actor partition — as separate
passes over the live actor array ([LoadMap scheduler](script-loadmap-startup.md)).
Other non-pawn classes stay unadmitted, so this patrol check does not
establish general LoadMap ordering fidelity.

Observed deterministic trace (`randomSeed=1`, `1/60` s; t is the zero-based
tick index): land t≈4;
`FindPathToward`→`MoveToward(PatrolPoint4)` t=5 (`MoveTimer≈2.11`); arrival
t≈12 at ~15.2u horizontal with `MoveTimer≈2.0` remaining — the recovered
arrival rule, **not** timeout; `TurnTo`+`Sleep` pause; t=146
`PickDestination`→`PatrolPoint5`, `MoveToward` with `MoveTimer≈31.23`; walk
~880u; arrival t≈1615 at ~15u horizontal; pause; t=1780 → `PatrolPoint4`
(`MoveTimer≈30.25`). The route loops sec1↔sec2 indefinitely — `Standing` is
unreachable because `NextPatrolPoint` is never `None`. `ScientistMale0`
patrols comp1↔comp2 identically (175u legs, pausetime 10/6).

The ~28u vertical offset between the pawn's stopped `Location` and each point
is consistent with arrival: both points sit at z≈−4.9 while the secretary's
floor is z≈23.3, and the walking arrival test zeroes `d.z` before the `<256`
compare — arrival
is horizontal-only for `PHYS_Walking`, so stopping ~15u horizontal (~32u 3D)
is exactly the original rule.

`scripts/validate-secretary-patrol.mjs` instruments `pollPawnLocomotion` index
503 to capture each completion at the instant `state.latent` clears (target
still bound) and asserts every leg is arrival-terminated (`PHYS_Walking`,
horizontal `<16`, `MoveTimer>0`, live `MoveTarget`), the
`destPoint` sequence is `[PatrolPoint4, PatrolPoint5, PatrolPoint4]`, the
state never reaches `Standing`, and public `game.reset()` re-resolves the
links and repeats both legs. Arrival geometry/timers and all 1900 samples of
Location, Physics, state, latent action, target, destination and MoveTimer
must match the fresh-load run exactly.

Review correction: the earlier z≈18.8 versus z≈23.3 comparison called only
`doors.reset()`, bypassing the public reset's random reseed, collision rebuild
and clock reset. A direct 20-tick comparison reproduced the discrepancy for
that partial reset and matched fresh load exactly through `game.reset()`.
It therefore does not establish a floor-selection defect in the public reset.
