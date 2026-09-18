# Engine Pawn navigation natives

The authority for the seven reach/path natives is the installed GOTY
`System/Engine.u` and hash-pinned `System/Engine.dll`:

```text
Engine.dll SHA-256  0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4
image base          0x10300000
Pawn.uc             the native() declarations quoted below
```

| Index | Declaration | Exec/thunk | Body → worker |
| --- | --- | --- | --- |
| 517 | `final function actor FindPathToward(actor anActor, optional bool bSinglePath, optional bool bClearPaths)` | thunk `0x1030333c` | `0x103bc9c0` → `0x103db3f0` |
| 518 | `final function bool FindPathTo(vector aPoint, optional bool bSinglePath, optional bool bClearPaths)` | thunk `0x10302c6b` | `0x103bc800` → `0x103dc1d0` |
| 520 | `final function bool actorReachable(actor anActor)` | thunk `0x10302969` | `0x103bc1a0` → shared reach `0x103c0630` |
| 521 | `final function bool pointReachable(vector aPoint)` | thunk `0x103033fa` | `0x103bc710` → worker `0x103c0d30` |
| 524 | `final function int FindStairRotation(float DeltaTime)` | thunk `0x10303111` | `0x103bb880` (inline fp) |
| 525 | `final function actor FindRandomDest(optional bool bClearPaths)` | thunk `0x103014f1` | `0x103bcb90` → `0x103da050`+`0x103dc700` |
| 526 | `final function bool PickWallAdjust()` | thunk `0x10303968` | `0x103bb7e0` → `0x103c4150` |

The Unicorn oracle is `scripts/native-pawn-nav-probe.py`.  It loads the real
Engine/Core images, fabricates a pawn + zones + a `ULevel` whose vtable slots
`+0x88`/`+0x8c`/`+0xc0` point at recording stubs, plus `NavigationPoint` objects
wired by `ReachSpec` records, and a `UModel` stub for the point/zone queries.
Every `MoveActor` / `FarMoveActor` / `SingleLineCheck` / `PointRegion` /
`FastLineCheck` call the workers make is captured as a command; scripted
results are fed back per call (padded to `RESULT_DEPTH` so the ~100-step reach
loops cannot exhaust them).

## Reachability — the call graph

`pointReachable` worker `0x103c0d30` (`thiscall ecx=pawn; stack [ret][point vec3][target]`):

1. `GIsEditor` dword gate — outside the editor, squared distance to the point
   must not exceed `1000000.0` (`=1000²`, `qword [0x104314a8]`); beyond → return 0.
2. `PointRegion(model=level+0x98, out=&region, worldActor=level+0xa8, point)` —
   the destination zone lookup (thunk `0x1030391d` → `UModel::PointRegion
   0x103f5db0`).
3. Zone gates:
   - if pawn `Region.Zone` (`+0xc8`) is **not** water (`zone+0x388` bit `0x01`)
     **and** pawn cannot swim (`flags +0x318` bit `0x4000` clear) **and** the
     destination zone **is** water → return 0 (dry pawn can't enter water).
   - if pawn `FootRegion.Zone` (`+0x330`) is **not** a pain zone (`+0x388` bit
     `0x20`) **but** the destination zone is a pain zone **and** its
     `zone+0x350` damage-type dword differs from `pawn+0x444` (the
     reduced-damage-type field) → return 0.
4. If `target==0`: `FastLineCheck(model, end=point, start=eye)` where
   `eye = Location + BaseEyeHeight` (`+0x3f4`); blocked → return 0.
5. `FarMoveActor(level, pawn, point, test=1, noCheck=0)` — a test teleport to
   the destination (vtable `+0x8c`).
6. Dispatch on physics through `0x103c1000` (`thunk 0x1030353f`):
   - `Physics==4` → fly helper `0x103c3900`
   - `Physics==1` or `3` → walk/swim helper `0x103c1b70`
   - water destination → water helper `0x103c15a0`
   - else → 0.  All helpers get `(pawn; point, radius=15.0, 0, target)` —
   the `15.0` literal `float [0x104314b8]`.
7. `FarMoveActor(level, pawn, origLocation, test=1, noCheck=1)` — restore.
   Velocity is restored from saved stack copies before `ret`.

The dispatcher `0x103c1000` re-tests the destination zone (`[ebp-0x30]` result
of the `PointRegion` write) and the pawn `Physics` byte (`+0x30`) to pick the
helper.

## The walk/swim helper `0x103c1b70`

A 100-iteration (`[ebp-0x34] = 0x64`) stepped-move trace.  Saves
`Location`/`Velocity` up front, loops while `edi==1`, restores both on exit,
returns `reached_flag [ebp-0x14] ? arg[+0x18] : 0`.

Per iteration, against `flat = (dx, dy, 0)` and `dz`:

- **Climb gate** — if `dz > [ebp-0x28]` (the step threshold, `maxStepHeight`)
  and `0.8·(dz−step)² > dx²+dy²` (`qword [0x10431418]` = `0.8`) → `edi=0`, bail:
  the ledge is too high/steep to climb.
- **Step down / forward probe** — `checkMove` (`thunk 0x1030254a` →
  `0x103c3290`) moves the pawn by a scaled delta and returns a code:
  - `1` → keep stepping (loop continues);
  - `5` → reached (sets `[ebp-0x14]=1`, `edi=0`);
  - otherwise → blocked: `pawn+0xd0` clear → fail (`reached=0`); else branch on
    `flags+0x318`: bit `0x8000` → jump helper `0x103c1190` (`thunk 0x10303c9c`),
    bit `0x1000` → alternate `jumpArc` `0x103c2f50` (`thunk 0x10303422`).
- **Pain-zone gate** — `FootRegion.Zone` (`+0x330`) `+0x388` bit `0x20` set and
  `zone+0x350 != pawn+0x444` → `reached=0`, bail.
- **Water gate** — `Region.Zone` water (`+0x388` bit `0x01`): needs `flags
  0x4000` (can swim) else bail; pain-in-water re-checks `0x20`/`+0x350`; then
  calls the water helper `0x103c15a0` (`thunk 0x10301406`).
- **Arrival test** — `|dz| <= [ebp-0x28]` (within step height) → `reached=1`;
  else a landing-arc check `sqrt(1/x²−1)` via `appSqrt` (`[0x10599ca4]`) scaled
  by `CollisionRadius`/`CollisionHeight` (`+0x1d4`/`+0x1d8`) and the target's
  radius (default `46.0`) decides `reached=1`.
- **WarpZoneMarker fallback** — after the loop, if the target (`ebx`) is a
  `WarpZoneMarker` (`class [0x10575198]`) whose `+0x44c` marked zone equals the
  pawn `Region.Zone` → `reached=1`.

## `checkMove` `0x103c3290`

The per-step `MoveActor` probe.  Reads `zone+0x324` gravityZ for the sign
(`±1.0` at `[ebp-0x48]`), scales `maxStepHeight` (`+0x38c`), builds the delta,
and calls `MoveActor` (vtable `+0x88`).  On the returned `FCheckResult`:

- `hit.Actor (+0x04) == target` → return **5** (reached the target actor).
- `hit.Time (+0x24) < 1.0` (`qword [0x104298a0]`) → a blocking hit: rescale the
  remaining `1−Time` fraction and re-probe, classifying floor/wall/slope by the
  `hit.Normal (+0x14..0x1f)` against the `0.7`/`0.95` slope thresholds
  (`qword [0x1042adc0]`/`[0x1042f5e8]`).
- `hit.Time == 1.0` → the step completed unobstructed → return **1**.

## Field layout

| Off | Field | Used by |
| --- | --- | --- |
| `+0x30` | `Physics` (byte) | dispatcher branch |
| `+0xa8` | `LevelInfo` (world actor) | PointRegion world arg, `XLevel+0x548` nav list |
| `+0xac` | `XLevel` | vtable `+0x88`/`+0x8c`/`+0xc0` |
| `+0xc8` | `Region.Zone` (FPointRegion) | water/pain gates, warp compare |
| `+0xd0` | collide flag | walk bail path |
| `+0x114` | `Location` | reach math, farMove restore |
| `+0x144` | `Velocity` | saved/restored |
| `+0x1d4` | `CollisionRadius` | arrival/landing scale |
| `+0x1d8` | `CollisionHeight` | arrival/landing scale |
| `+0x318` | pawn flag dword | swim `0x4000`, jump `0x8000`, alt `0x1000`, reach-mask bits |
| `+0x330` | `FootRegion.Zone` | pain-zone gate |
| `+0x33c` | `HeadRegion.Zone` | — |
| `+0x38c` | `MaxStepHeight` | climb gate, checkMove delta |
| `+0x3f4` | `BaseEyeHeight` | eye trace start |
| `+0x444` | reduced-damage-type dword | pain-zone immunity compare |
| `zone+0x324` | `GravityZ` | checkMove sign |
| `zone+0x350` | zone damage-type dword | pain-zone immunity |
| `zone+0x388` | zone flag byte | `0x01` water, `0x20` pain |

`FCheckResult` (44 B): `+0x04` Actor, `+0x08..0x13` Location, `+0x14..0x1f`
Normal, `+0x24` Time, `+0x28` Item.

## NavigationPoint / ReachSpec graph

From `actorReachable`'s direct-spec worker `0x103dad20` and `ULevel.cpp`:

- `ULevel.ReachSpecs` `+0x8c` — `TArray` of 28-byte `ReachSpec`:
  `{+0x00 Start, +0x04 distance, +0x08 End, +0x0c collisionRadius,
   +0x10 collisionHeight, +0x14 reachFlags, +0x18 pruned}`.
- `NavigationPoint.Paths[16]` `+0x360` — ReachSpec indices, `-1` terminator.
- `NavigationPoint.upstreamPaths[16]` `+0x3a0`.
- `ULevel+0x90` — NavigationPoint list head; `LevelInfo+0x548` also holds it.
- `reachMask` `0x10326d10` (`thunk 0x1030321a`) gathers a 7-bit capability mask
  from `flags+0x318` — bits `0x2/0x2000/0x8000/0x4000/0x1000/0x10000/0x20000`
  → compact bits `0..6` (`R_WALK/R_FLY/R_SWIM/R_JUMP/R_DOOR/R_SPECIAL/
  R_PLAYERONLY`).  **Oracle-confirmed:** `flags=0x70026` → `0x70`.

The direct-spec worker scans a nav point's `Paths[]`, skips `-1`, checks the
spec `End` + collision dims + `reachFlags & reachMask`, runs `SingleLineCheck`
(flags `6`, zero extent) to the endpoint, and rejects obstructed/`Mover`
(`class [0x1058bb58]`) specs.

## Verification status

- `reachMask` 7-bit gather — **bit-exact vs oracle** (`0x70026 → 0x70`).
- `pointReachable` worker `0x103c0d30` — **runs end-to-end on the real bytes**
  through the zone gates, `PointRegion`, `FastLineCheck`, test `FarMoveActor`,
  the physics dispatcher and the walk helper; location/velocity restored.
  The full reachable-vs-blocked decision matrix against scripted
  `MoveActor`/`SingleLineCheck` outcomes is recovered structurally (every gate
  and constant above is read from the disassembly); the JS port and its
  bit-exact validator are the in-progress deliverable.
- The remaining helpers (`0x103c1190` jump, `0x103c15a0` water, `0x103c3900`
  fly, `0x103c2f50` jumpArc) share the same save→100-step→restore template and
  are mapped; `FindRandomDest`/`FindPathTo`/`FindPathToward` share the
  ReachSpec BFS machinery (`0x103da050`/`0x103dc700`/`0x103dc1d0`/`0x103db3f0`)
  recovered at the field level — see the graph layout above.
- `FindStairRotation` (524) is inline fp using the `GMath` sine table
  (`0x103fxxxx` via Core's `FVector::Rotation`) — integer math, no
  transcendentals; the Unicorn oracle is authoritative for it.
