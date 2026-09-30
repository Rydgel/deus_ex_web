# Engine Pawn perception natives

The authority for the six sight/target-selection natives is the installed GOTY
`System/Engine.u` and hash-pinned `System/Engine.dll`:

```text
Engine.dll SHA-256  0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4
image base          0x10300000
Pawn.uc             the native() declarations quoted below
```

| Index | Declaration | Exec/thunk | Body |
| --- | --- | --- | --- |
| 514 | `final function bool LineOfSightTo(actor Other, optional int bIgnoreDistance)` | thunk `0x1030187a` | `0x103bce10` → shared worker `0x103beb50` |
| 533 | `final function bool CanSee(actor Other)` | thunk `0x10303256` | `0x103ba5d0` → shared worker `0x103beb50` |
| 532 | `final function bool PlayerCanSeeMe()` | thunk `0x1030339b` | `0x103ba640`; per-viewer test `0x103ba8a0` |
| 531 | `final function pawn PickTarget(out float bestAim, out float bestDist, vector FireDir, vector projStart)` | thunk `0x10303689` | `0x103baca0` → shared worker `0x103beb50` |
| 534 | `final function actor PickAnyTarget(out float bestAim, out float bestDist, vector FireDir, vector projStart)` | thunk `0x10301195` | `0x103bb130` → shared worker `0x103beb50` |
| 705 | `final function float AICanSee(actor Other, optional float visibility, optional bool bCheckVisibility, optional bool bCheckDir, optional bool bCheckCylinder, optional bool bCheckLOS)` | thunk `0x10301357`; exec wrapper `0x103c8270` | worker `0x103c6ab0` |

`LineOfSightTo`, `CanSee`, `PickTarget`, `PickAnyTarget` and the
`PlayerCanSeeMe` per-viewer test all funnel into the **same worker body**
`0x103beb50` — a `thiscall(this=pawn, other, bCheckFOV, bIgnoreDistance)`.
`AICanSee` is independent: its own visibility worker `0x103c6ab0` reached via a
six-argument `GNative` exec wrapper.

The port is `src/runtime/script-pawn-perception.mjs`; the Unicorn oracle is
`scripts/native-pawn-perception-probe.py`; the JS-twin comparator and mutation
corpus live in `scripts/validate-pawn-perception.mjs` (55 scenes + 13
mutations, all bit-exact against the oracle).

## Field layout the bodies dereference

All offsets are the native C++ member offsets read directly by the
disassembled instructions; the port resolves each through the field view by
script name. `+0x318` is the `APawn` flag dword (`bBehindView`=bit0,
`bIsPlayer`=bit1, `bLOSflag`=bit19 `0x80000`); `+0x2c` is the `AActor` flag
dword (`bDetectable`=bit0); `+0x28` holds `bNetTemporary` (bit24) and
`+0x31` is `RemoteRole`.

| Off | Field | Used by |
| --- | --- | --- |
| +0x114 | `Location` | all — viewer/target world position |
| +0x120 | `Rotation` | CanSee stimulus forward, AICanSee viewRot |
| +0x3dc | `ViewRotation` | PlayerCanSeeMe cone, AICanSee player viewRot |
| +0x1d4 | `CollisionRadius` | cylinder side-fan scale, angular size |
| +0x1d8 | `CollisionHeight` | top/bottom traces, angular size |
| +0x1dc | `bProjTarget` (bit) | PickTarget/PickAnyTarget filter |
| +0x318 | flag word | `bBehindView`/`bIsPlayer`/`bLOSflag` |
| +0x398 | `Visibility` (byte) | flat/FOV visScale |
| +0x3a0 | `Stimulus` | written by the FOV path, reseeded to 1.0 |
| +0x3a4 | `SightRadius` | FOV-path cap, flat scaled multiplier |
| +0x3a8 | `PeripheralVision` | stimulus dot threshold |
| +0x3b0 | `LastSeenPos` | enemy-path stamp |
| +0x3bc | `LastSeeingPos` | enemy-path stamp (viewer pos) |
| +0x3cc | `Enemy` | enemy-path trace + stamp |
| +0x3f4 | `BaseEyeHeight` | eye = loc.z + this |
| +0x60c | `ViewTarget` (PlayerPawn) | PlayerCanSeeMe early-out |
| +0x428 | `Health` | PickTarget dead filter |
| +0x458 | `Skill` | FOV-path vertical-scaling divisor `max(Skill+1,1)` |
| +0x498 | `nextPawn` | pawn-list link |
| +0x558 | `PlayerReplicationInfo` | PickTarget team compare (`+0x340 Team`) |
| +0x5ac | `AIHorizontalFOV` | AICanSee yaw halfwidth |
| +0x5b0 | `AspectRatio` | AICanSee `halfFovV = AIHorizontalFOV/AspectRatio` |
| +0x5b8 | `MinAngularSize` | AICanSee angular-size gate |
| +0x5bc | `VisibilityThreshold` | AICanSee acc subtraction |
| +0x5c8 | `AIAddViewRotation` | AICanSee viewRot addend |

## The shared worker `0x103beb50`

`checkFOV` selects one of two distance metrics; an `other == Enemy`
(`+0x3cc`) target forces `checkFOV=0` **before** the flag is touched.  When
`checkFOV` is set the worker toggles `bLOSflag` (`+0x318` bit `0x80000`) at
entry — that per-frame flag is the corner-trace budget described below.

`delta = other.Location - viewer.Location`, `distSq = |delta|²`.

### Flat path (`bCheckFOV=0`) — `0x103bef60`

For a Pawn target the scaled radius is
`visScale = min((Visibility+16)*0.015, 1)` (f32 `0x10431464`),
`s = visScale*(bIsPlayer ? 5000 : 4000)` (`0x1042f548`/`0x1043145c`), and
`cap = min(s², bIsPlayer ? 25e6 : 16e6)` (`0x10431460`/`0x10431478`).  Because
`visScale` clamps to 1 the `s²` term never exceeds the cap constant for a pawn
— the `min()` always resolves to `s²`.  For a non-pawn target `cap` is a fixed
`9e6` (`0x10431458`).  `distSq > cap && !bIgnoreDistance → return 0`;
`scaledOrDist = distSq`.

### FOV path (`bCheckFOV=1`) — `0x103bec11`

For a Pawn target `visScale = min(Visibility*0.0078125, 1)` (`0x10429c48`),
`s = visScale*SightRadius`, `cap = min(s², bIsPlayer ? 16e6 : 12e6)`
(`0x10431478`/`0x10431474`).  For a non-pawn target `cap = SightRadius²` (no
clamp).  The first gate `distSq > cap → return 0` is **unconditional** (no
`bIgnoreDistance`).

`Stimulus` is then computed and written:
`dot = forward(Rotation) · unit(delta)`, `t = dot - PeripheralVision`,
`stimulus = t*(t>0 ? 0.8 : 0.17) + 0.2` (doubles `0x10431418`/`0x10431468`/
`0x1042b8e8`).  `stimulus <= 0 → return 0`.  The distance metric becomes
`scaledOrDist = (distSq + (|dz|/max(Skill+1,1))²) / stimulus²` — the `+0x458`
`Skill` divisor damps the vertical term so a skilled viewer tolerates more
height offset.  `scaledOrDist > cap && !bIgnoreDistance → return 0`, then
`Stimulus` is reseeded to `1.0` (`0x103bee56`).

### Trace section — `0x103bee60`

`eye = viewer.Location.z + BaseEyeHeight`.  An enemy target takes two
dedicated traces (`eye→loc` then `feet→loc`) that both stamp
`LastSeeingPos`/`LastSeenPos` on a clear `FastLineCheck`; a blocked enemy
falls through to the near/far split.

The non-enemy split is `scaledOrDist <= 1e6 || bIgnoreDistance` (f64
`0x10430a64`) → **near path**; otherwise **far path**:

- Near path (`0x103bf191`): a top-center trace (`loc.z + 0.8*CollisionHeight`)
  runs unless `checkFOV && bLOSflag`; then a four-corner fan at
  `loc ± CollisionRadius` is eligible only when `scaledOrDist <= 250000`
  (`0x10431454`) **and** the target is a Pawn.  The `iMin`/`iMax` squared-
  distance corners are skipped, and the remaining corners are metered by the
  post-toggle `bLOSflag` budget — with `checkFOV` set, a set flag spends one
  eligible corner and clears, a clear flag traces one and sets.
- Far path (`0x103bf08c`): pawn targets only — `!bLOSflag &&
  scaledOrDist > cap*0.5` (`0x1042ac10`) returns 0; then the NPC decay gate
  `appFrand() < 0.5 → return 0` (`rand >= 0.5` proceeds), `bIsPlayer`
  short-circuits to the trace, and a non-pawn goes straight to the direct
  `eye→loc` `FastLineCheck`.

## Per-native flag semantics

| Native | `bCheckFOV` | `bIgnoreDistance` | Notes |
| --- | --- | --- | --- |
| `LineOfSightTo(514)` | `0` (flat) | `arg2 == 1` via `sete` — exact `===1`, a non-1 truthy int is false | flat metric only |
| `CanSee(533)` | `1` (FOV) | `0` | stimulus + Skill-scaled metric |
| `PlayerCanSeeMe(532)` | `0` (flat) | `0` | per-viewer `testCanSeeMe` gate first |
| `PickTarget(531)` | `0` (flat) | `0` | worker is the winner's LOS check |
| `PickAnyTarget(534)` | `0` (flat) | `0` | worker is the winner's LOS check |

## `PlayerCanSeeMe` `0x103ba640` / `testCanSeeMe` `0x103ba8a0`

Viewer selection is `NetMode`-driven: `NetMode==0` (standalone) → the net
player list; `NetMode==3` (client) → net player list only when
`bNetTemporary` (`+0x28` bit24) or `RemoteRole==4` (`+0x31`); otherwise the
`PawnList` (`+0x54c` via `nextPawn +0x498`).

Each candidate viewer runs `testCanSeeMe(actor, viewer)`:

- `viewer.ViewTarget == actor` (`+0x60c`, a `PlayerPawn` field) → `1`
  immediately, no distance test.  The port guards the read to `PlayerPawn`
  viewers — an NPC has an unrelated dword at `+0x60c` that never equals the
  target, matching the raw native read.
- `distSq >= (actor.CollisionRadius + 3.6)*100000 → 0` (`0x10430a90`/`360.0`).
- unless `viewer.bBehindView`, a ±60° biconal cone gate:
  `(forward(ViewRotation)·delta)² >= distSq*0.25` (`0x10429878`).  The dot is
  **unnormalized** so `dot² = cos²·distSq` and the test reduces to `cos²≥0.25`.
- then the shared worker (`bCheckFOV=0`).

## `PickTarget` `0x103baca0` / `PickAnyTarget` `0x103bb130`

Both compute `score = (FireDir · delta)/sqrt(distSq)` per candidate and keep
the first candidate whose `score > bestAim` **and** whose shared-worker LOS
check passes; the winner writes `*bestAim = score` and `*bestDist = sqrt(distSq)`
through the out-params (EAX is only the result-slot pointer — the selected
actor is written through `resultOut`).

`PickTarget` walks the `PawnList` and filters in native order: `cand==self` →
`Health <= 0` → `!bProjTarget` → **`Level->GameInfo == null` skips the
candidate outright** → team skip (`GameInfo.bTeamGame && both
PlayerReplicationInfo present && equal Team +0x340`) → `dot <= 0` →
`distSq >= 4e6` (`0x10430a5c`).

`PickAnyTarget` walks `Level->Actors[]` (skipping `Actors[0]`=LevelInfo),
requires `bProjTarget`, and excludes any candidate that `isA(Pawn)` — it
selects non-pawn targets through the same shared worker.

## `AICanSee` `0x103c6ab0`

Optional-argument defaults come from the exec wrapper's declared-param token
stream, **not** the JS signature: `visibility=1`, `bCheckVisibility=1`,
`bCheckDir=1`, **`bCheckCylinder=0`**, `bCheckLOS=1`.  Omitted trailing
arguments are `EX_Nothing` tokens and fall through to these defaults.

Pipeline (early-outs return `0`):

1. `other == null`, `visibility <= 0`, or `!bDetectable` (`+0x2c` bit0) → `0`.
2. `eye = loc.z + BaseEyeHeight`; `delta = other.loc - eye`;
   `distSq = max(|delta|², 1)` (`0x104298a0`).
3. `ratio = (CollisionRadius² + CollisionHeight²)/distSq` — the angular-size
   measure; `ratio <= MinAngularSize` → `0`.
4. `cyl = bCheckCylinder && (ratio >= 0.0003046792916483)` (`0x10431660`
   `aiFillRatio`) — cylinder sampling is forced off unless the target fills
   the view; a small-ratio target degrades to a single point trace.
5. `acc = visibility * ratio * 64` (`0x10431650`).
6. `bCheckDir && acc>0`: `halfFovV = AIHorizontalFOV/AspectRatio`;
   `hExt = atan(sqrt(cr²/distSq))*114.591559`, `vExt` likewise with `ch²`
   (`0x10431640`); `viewRot = (player ? ViewRotation : Rotation) +
   AIAddViewRotation`; `dirView = FCoords(viewRot) · delta`;
   `rot = FVector::Rotation(dirView)`; `yawDeg = rot.yaw*360*1.5259e-5`
   (`0x10431630`), `pitchDeg` likewise.  `yawTrap = trapezoid(yawDeg,
   AIHorizontalFOV, hExt)`, `pitchTrap = trapezoid(pitchDeg, halfFovV, vExt)`,
   then `acc *= yawTrap * pitchTrap`.
7. **Near-target pitch floor** (`0x103c6e38`): `distSq < 22500 &&
   pitchTrap < 0.75 → pitchTrap = 0.75` (`0x10431620`/`0x1042abf8`) — a close
   target directly overhead still reads as at least 75% visible.
8. `bCheckVisibility && acc>0`: call `AIVisibility(other,1)` and multiply its
   retained x87 result by the f32 accumulator, then store f32. This includes
   the target's visibility cache and velocity boost; see [AI lighting](script-ai-visibility.md).
9. `acc = clamp(acc - VisibilityThreshold, 0, 1)` (`+0x5bc`).
10. `bCheckLOS && acc>0`: `SingleLineCheck` traces; a blocked result zeroes
    `acc`.

### The `trapezoid` worker `0x103c7360`

Wraps the angle into `(-180,180]` (`0x10431674/70/6c`), then `plateau =
(halfwidth-extent)/2`, `edge = plateau+extent`: `|d|<=plateau → 1`,
`|d|>edge → 0`, else linear `1 - (|d|-plateau)/extent`.

### `SingleLineCheck` LOS — `0x103c7430` (MultiLineCheck boundary)

`cyl==0` → one `eye→oLoc` point trace.  `cyl && PlayerPawn` → three vertical
traces (`loc.z + BaseEyeHeight`, `+CollisionHeight`, `-CollisionHeight`).
`cyl && non-player` → a top (`+CollisionHeight`), bottom (`-CollisionHeight`),
then two side-fan traces `oLoc ± (perp.y, -perp.x)*CollisionRadius` where
`perp = SafeNormal(delta.x, delta.y, 0)` — the **horizontal** projection of
the world delta is normalized with z dropped *before* `SafeNormal`, so a
dead-ahead target yields `perp=(1,0)` and side offsets of exactly
`±CollisionRadius`.  `SingleLineCheck`'s hit filter blocks on world hits and
`bBlockSight && !bHidden` actors; owner-chain/self hits are ignored.

## Oracle provenance

Two oracles back the validator, split by operation class:

- **Unicorn** (`scripts/native-pawn-perception-probe.py`) is authoritative for
  everything except the two transcendentals: integer/flag logic, all
  float32/double arithmetic, `FastLineCheck`/`SingleLineCheck` call order and
  endpoint vectors, the `appFrand` far-path decay gate, out-parameter
  writeback (`bestAim`/`bestDist`/`resultOut`), and pawn state mutation
  (`Stimulus`, `LastSeenPos`, `LastSeeingPos`, the `bLOSflag` toggle).  The
  probe intercepts `appFrand` at the x87 physical-register level (decrement
  TOP, write `FP[top]`, set the tag) so the scripted random sequence drives
  the real `fst`/`fcomp` gate.
- **CrossOver hardware** (`tools/pawn-rotation-probe.exe`,
  `tools/atan-double-probe.c`) supplies the transcendental values:
  `FVector::Rotation` (`fpatan` on real x87) and `appAtan` (a cdecl
  `double appAtan(double)`).  The validator runs the Unicorn scenes, collects
  any `missed_oracles` input keys, measures them through the hardware probes,
  and re-runs until the table is complete; 64-bit atan results travel as hex
  strings so no u64→double precision is lost.

Inside the JS runtime these surfaces are the `services.atan` and
`services.vectorToRotator` seams — the validator injects the measured table;
production falls back to host `Math.atan`/`atan2` (a documented last-ULP
residual, not part of the bit-exact corpus).

## Command-capture isolation

The probe scripts four independent result streams so one subsystem's stub can
never consume another's queue: `FastLineCheck` trace results (mailbox
`0x1ff00040`, count `0x1ff00000`), `SingleLineCheck` results (mailbox
`0x1ff00440`, count `0x1ff00010`), lighting queries (`0x1ff00840`), and the
`appFrand` sequence.  The validator asserts call order and endpoint vectors
for each stream separately — this is what makes the `aic-los-blocked`
side-fan geometry and the far-path `rand` polarity observable.

## Boundary — what is not implemented

Line tracing is **BSP-only**: the worker calls `UModel::FastLineCheck` on the
level's `Model` (`xLevel+0xac → Model+0x98`), and `AICanSee`'s LOS gate calls
the `SingleLineCheck` wrapper (`0x103c7430`, the `MultiLineCheck` boundary).
Both are injected services in the validator; production resolves them through
the level model.  **Neither body reaches the navigation graph** — pathfinding,
route cost, and `ReachSpec` evaluation are out of scope for this milestone and
remain unimplemented.  `PlayerCanSeeMe`'s net-player list (`NetMode==0`/`3`)
is modeled from the level's player/`netActors` set; the dedicated server
`NetMode` paths are recovered but exercised only through the `netMode`
scenes in the corpus.

The runtime now supplies the recovered AIGetLightLevel/AIVisibility chain.
The isolated perception probe keeps AIGetLightLevel as a recorded query leaf;
its complete body has a separate 41-case DLL comparison and Training map checks.
The 55 perception cases now compare every target's three visibility-cache fields,
including four cache-refresh/interpolation boundaries through native 705. Full
Region/clock synchronization belongs to pending world startup/tick integration.

## Actor.Tick visibility integration

The same LOS worker now serves ShowSelf and CheckEnemyVisible, with 24 complete
original-DLL helper/LOS comparisons and linked Training script/BSP checks.
See [the recovered helper contract](script-pawn-tick-visibility.md). These
helpers do not supply NPC startup; AICanSee's separate lighting subsystem is
documented in [AI lighting](script-ai-visibility.md).

## Rust interpreter

Under `SCRIPT_VM=rust`, AICanSee (705) runs in the interpreter, with the
AIVisibility and AIGetLightLevel it calls ([Rust core](rust-core.md) step
R3-c, `native/script-vm/src/percep.rs`). The Rust body transcribes
`execAICanSee`, `actorVisibilityExtended` and `actorLightLevelExtended`. Its
SingleLineCheck traces stay JavaScript imports into the trace kernel, and
appAtan and FVector::Rotation use `Math.atan` and `Math.atan2`, as the
runtime's JavaScript does (the hardware tables are this validator's seam
only). `scripts/validate-perception-kernel.mjs` and
`PERCEPTION_DIFFERENTIAL=1` compare the two; the JavaScript here remains the
reference, and the oracle validators above test it.
