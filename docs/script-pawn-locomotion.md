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
  fires `SpawnNotification` on the pawn. Facing helper then steer/arrive;
  `latent=0` when the helper reports done.
- **MoveToward (503)**: `MoveTarget==0` → `latent=0`. Destination is rebuilt
  each tick from the live target location — flying pawn targets offset
  `z += CollisionHeight*0.7`, Spider physics offsets by
  `CollisionRadius*Floor` — then `Focus=Destination`, `DesiredSpeed` is saved,
  tactics event fires, helpers run, `latent=0` on done, `Destination`
  re-snapshots the live location, and pawn targets unconditionally restore
  `DesiredSpeed` plus force `MoveTimer=-1` when the target's
  `Region.Zone+0x388&1` water flag is set and the pawn lacks `bCanSwim`
  (null zone reads `*0x388==0`, i.e. not water).

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
event list including the Touch `parms[0]` payload. 103/103 scenes are
bit-exact; 21/21 targeted mutants (physics gates, tolerance boundaries, flag
bits, store order, timer formula) are detected.

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
