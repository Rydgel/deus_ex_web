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

**Oracle verification status.**  The Unicorn probe executes the *real* native
machine code; only the five collision/zone boundaries are scripted.  Verified
end-to-end so far:

- `pointReachable` worker + dispatcher + `walkReach` + `checkMove` run a real
  ~100-step loop; a clear flat-ground scene returns a genuine **1** after ~3
  iterations (phase-A forward move + `maxStep+2` down-probe each step), with
  `Location`/`Velocity` correctly restored.  All four are now **ported to JS and
  bit-exact vs the oracle** (42 scenes, 11 mutants).
- `checkMove` return codes `5`/`1`/`−1` confirmed against scripted hits;
  `reachMask` (`0x10326d10`) returns the predicted 7-bit capability gather.
- Boundary order for `pointReachable`: `PointRegion → FastLineCheck →
  FarMoveActor(test) → FarMoveActor(restore) → dispatch → checkMove loop →
  FarMoveActor(restore)`.

Not yet oracle-verified: flying/swimming reach helpers, `jumpArc`, the
proximity-landing `appSqrt` arc, `actorReachable`, `FindRandomDest`,
`FindPathTo`/`FindPathToward`, `PickWallAdjust`, `FindStairRotation`.

## Reachability — the call graph

`pointReachable` worker `0x103c0d30` (`thiscall ecx=pawn; stack [ret][point vec3][arg14]`):

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
4. If `arg14==0` (the exec passes a literal 0): `FastLineCheck(model, end=point,
   start=eye)` where `eye = Location + BaseEyeHeight` (`+0x3f4`); blocked →
   return 0.
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
  - `−1` → retry: if the needed step `≤ maxStepHeight` → `edi=1` (continue);
    else `flags+0x318` bit `0x1000` set → `SafeNormal` + alternate-move helper
    `0x10303422`; bit `0x8000` → `jumpArc` `0x10303c9c`.
  - `0`/other → `pawn+0xd0` clear → fail (`reached=0`); else the alternate
    `jumpArc`/helper result sets `reached`.
- **Pain-zone gate** — `FootRegion.Zone` (`+0x330`) `+0x388` bit `0x20` set and
  `zone+0x350 != pawn+0x444` → `reached=0`, bail.
- **Water gate** — `Region.Zone` water (`+0x388` bit `0x01`): needs `flags
  0x4000` (can swim) else bail; pain-in-water re-checks `0x20`/`+0x350`; then
  calls the water helper `0x103c15a0` (`thunk 0x10301406`).
- **Arrival test** — when `dx²+dy² ≤ innerRadius²` (`[ebp-0x5c]` = `radius²` =
  `15.0²` = `225`, oracle-confirmed) the loop jumps to the landing evaluation
  `0x103c1fc8`: `|dz| ≤ [ebp-0x28]` (within step height) → `reached=1`; else a
  landing-arc check `sqrt(1/x²−1)` via `appSqrt` (`[0x10599ca4]`) scaled by
  `CollisionRadius`/`CollisionHeight` (`+0x1d4`/`+0x1d8`) and the target's
  radius (default `46.0`) decides `reached=1`.  Two step sizes feed the loop:
  a far `SafeNormal·step` (`0x103c1d95`) and a near `8.0`-scaled step
  (`0x103c1d74`) chosen by the `distSq` bands at `0x103c1d5c`.
- **WarpZoneMarker fallback** — after the loop, if the target (`ebx`) is a
  `WarpZoneMarker` (`class [0x10575198]`) whose `+0x44c` marked zone equals the
  pawn `Region.Zone` → `reached=1`.

## `checkMove` `0x103c3290`

The per-step `MoveActor` probe (`thiscall ecx=pawn; stack [ret][delta vec3]
[hit*][target][scale][flag]`).  Reads `zone+0x324` gravityZ for the sign
(`±1.0` at `[ebp-0x48]`), scales `maxStepHeight` (`+0x38c`), and runs a
multi-phase `MoveActor` (vtable `+0x88`) sequence.  Oracle-verified return
codes:

- **5** — the probe's `hit.Actor (+0x04) == target` (reached the target actor;
  checked after phase A and each retry).
- **1** — progressed.  Reached when the down-probe hits a non-floor surface
  (`hit.Normal.z < 0.7`) **or** the pawn's actual displacement
  `|loc−origLoc|²` reaches `scale²`; the caller keeps stepping.
- **−1** — stepped/landed: the down-probe (`[0,0,−(maxStep+2)]`) came to rest
  on a floor (`hit.Normal.z ≥ 0.7`) or completed with the `flag` clear; the
  walk helper then retries via the step-height/`jumpArc` alternate path.
- **0** — blocked and restored (`FarMoveActor` restore before return).

`hit.Time == 1.0` (`qword [0x104298a0]`) selects the phase: a partial hit
(`Time<1`) rescales the remaining `1−Time` and re-probes (up to 3 `MoveActor`
calls per `checkMove`); a full move drops to the `maxStep+2` down-probe.
`hit.Normal (+0x14..0x1f)` slope thresholds `0.7`/`0.95`
(`qword [0x1042adc0]`/`[0x1042f5e8]`).

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

The direct-spec worker `0x103dad20` (`thiscall pawn; source, target`) scans a
nav point's `Paths[]`, skips `-1`, and for each spec checks `End==target`
(`+0x08`), `collisionRadius >= __ftol(pawn.CR)` (`+0x0c`),
`collisionHeight >= __ftol(pawn.CH)` (`+0x10`), and
`(reachFlags & reachMask) == reachFlags` (`+0x14`).  A qualifying spec is
confirmed by `SingleLineCheck(source.loc -> target.loc, flags=6, zero extent,
extra=0)`: a clear trace, a non-`Mover` hit, or a `Mover` the pawn can open
returns 1.  The `Mover` (`class 0x1058bb58`) rule: skip the spec unless pawn
`+0x318 & 0x10000` (bCanOpenDoors); if `+0x318 & 0x2` is clear the mover is
openable only when its `+0x4ec & 0x8` is clear.  Both `Paths` (`+0x360`) and
`upstreamPaths` (`+0x3a0`) are scanned in turn.

## `actorReachable` worker `0x103c0630`

`int actorWorker(this=pawn; AActor* target; int argC)` — the actor analogue of
`pointWorker`: a gate sequence, then a collision-fit `FarMoveActor`, then the
shared physics-reach dispatcher `0x103c1000`.  `arg8`=target (null → 0),
`argC` is repurposed as the reach-radius local after the LOS gate.

1. `dx/dy/dz` and `distSq` (`[ebp-0x34/-0x30/-0x2c/-0x14]`, all f32-stored).
2. First `IsA(APawn 0x1058c660)` class-chain walk of `target`:
   - pawn → `target.FootZone+0x330` pain flag (`+0x388&0x20`) vs
     `damageType`/`+0x350` == pawn `+0x444`; mismatch → 0.
   - non-pawn → unless `[[0x10599c94]]!=0` (editor): `distSq>640000` (800²) → 0,
     then `target.RegionZone+0xc8` pain flag → 0 on resist mismatch.
3. Shared: `target.RegionZone` water (`+0x388&1`) requires pawn `+0x318&0x4000`
   (canSwim) else 0.
4. `argC==0` → `SingleLineCheck(pawn, eye=loc.z+BaseEyeHeight, target.loc,
   flags=6)`: proceed iff `hit.time==1.0` or `hit.actor==target`.
5. Second `IsA(APawn)` walk → the radius/`physicsReach` path:
   - pawn → `R = min(CR*1.5, meleeRange) + targetCR + pawnCR` (f32).  Within
     `distSq<=R²` → 1.  Else `distSq>640000` widens `R=max(R, appSqrt(dsq)-800)`.
     `FarMoveActor` fit test then `physicsReach(pawn, target.loc, R, target)`.
   - non-pawn → `R=15.0`, or `targetCR+pawnCR-2.0` for `IsA(Inventory 0x10576f70)`
     /`IsA(Trigger 0x10576088)`; `FarMoveActor` fit test then
     `physicsReach(pawn, target.loc, R, arg4)` where `arg4 = target` iff
     `target+0x1dc & 4` or `IsA(WarpZoneMarker 0x10575198)`, else 0.

## `actorReachable` exec `0x103bc1a0`

`void actorReachable(this=pawn; FFrame; int* result)` — the GNatives exec
wrapper.  It evaluates one actor arg through `GNatives[opcode]` (a null object
writes `*result=0`), then runs a NavigationPoint fast path before delegating to
the `0x103c0630` worker.  The verdict goes to `*result`, not eax.  The
`[0x10599dac]`/`Level+0x1128` rdtsc block is a native-call timer, not behavior.

1. `target==null` → `*result=0` (`0x103bc1dc`).
2. `IsA(Inventory 0x10576f70)` and `target+0x398` holder present → redirect
   `t=holder` for the fast path only; the original Inventory is restored
   (`0x103bc583`) before the worker call.
3. `IsA(NavigationPoint)` fast path, gated on `level+0x90!=0` (nav-list head)
   and `pawn.CollisionRadius <= 115.0` (`0x10431434`):
   - horizontal radius `R=max(pawn.CR, 48.0)` (`0x10430a68`), `R²` cached.
   - a nav point is *within* iff `|nav.z−pawn.z| < pawn.CollisionHeight`
     **and** `dx²+dy² < R²`.
   - the pawn's `Anchor` (`+0x34c`) is checked first if it is a NavigationPoint
     within bounds; then the list `level+0x90 → +0x42c (nextNav)` is walked.
   - a candidate returns `1` when it `== target` or `directReach(pawn, nav,
     target)` succeeds.
   - candidate(s) found but none reached → `0`, unless `pawn.Physics==4`
     (PHYS_Flying) which falls through.
4. Everything else → `actorWorker(pawn, originalTarget, 0)` (thunk
   `0x103024be`), with the Inventory restored first.

## Verification status

- `reachMask` `0x10326d10` 7-bit gather — **ported to JS, bit-exact vs oracle**
  across 10 flag scenes (`0x70026 → 0x70` plus each single bit) plus 1 mutant.
- `directReach` `0x103dad20` — **ported to JS, bit-exact vs oracle** across 10
  scenes (clear trace, under-radius/height/capability pre-checks, upstream
  array, wrong-end, Mover blocked/open/`+0x4ec` branches, non-mover hit) plus
  2 mutants.
- `actorReachable` worker `0x103c0630` — **ported to JS, bit-exact vs oracle**
  across 20 scenes (pawn within-radius early-accept, near/far walk reach,
  >800 radius widen, non-pawn distance limit, `R=15`/`Inventory`/`Trigger`
  radii, `WarpZoneMarker`/`flags1dc` target arg, LOS blocked/on-target/argC
  skip, foot+region pain and resist, water swim/no-swim, editor skip, null
  target) plus 6 mutants.
- `actorReachable` exec `0x103bc1a0` — **ported to JS, bit-exact vs oracle**
  across 14 scenes (null arg, non-NavigationPoint worker fallback, nav-list
  hit, `directReach` reach, Anchor hit/reach, found-but-unreachable non-flying
  0 vs PHYS_Flying fallback, none-near fallback, Inventory holder redirect,
  no-holder fallback, `CR>115` gate, overhead-nav `|dz|<CH` gate, Inventory
  restore to the worker) plus 8 mutants.  The verdict is `*result`-normalized;
  unspecified actor fields are 0 (the probe zeroes fabricated memory).
- `checkMove` `0x103c3290` — **ported to JS, bit-exact vs oracle** across 16
  scenes (flat/step-up/target-hit/ledge/steep/under-moved/low-grav) plus 4
  mutants detected (commit `26a2f08`).
- `walkReach` `0x103c1b70` — **ported to JS, bit-exact vs oracle** across 11
  flag-free walking scenes (flat near+far steps, inside-radius arrival,
  below-step landing, blocked, ledge no-retry vs `CR>maxStep` clamp-retry,
  diagonal, pain gate, water-no-swim gate, velocity restore) plus 2 mutants.
  The `+0x318`-flag helper branches — jump `0x103c1190`, arc `0x103c2f50`,
  swim `0x103c15a0` — and the swim-enabled water gate delegate to services
  seams that are **not yet ported** (a flag-free walker never reaches them);
  validating those needs the helper workers recovered separately.
- `pointReachable` worker `0x103c0d30` — **ported to JS, bit-exact vs oracle**
  across 11 scenes (dry-to-dry reach, 1e6 distance gate, editor-skip, water
  gate, water+canSwim, pain gate, pain-immune, blocked LOS, arg14 LOS skip,
  farMove-test-fail, blocked walk) plus 5 mutants.  The worker returns the
  physics-dispatch result; the exec `0x103bc710` only reads the vector arg,
  passes `arg14=0`, and stores the result — it is wired at dispatch time, not
  in this worker.
- The remaining helpers (`0x103c1190` jump, `0x103c15a0` water, `0x103c3900`
  fly, `0x103c2f50` jumpArc) share the same save→100-step→restore template and
  are mapped; `FindRandomDest`/`FindPathTo`/`FindPathToward` share the
  ReachSpec BFS machinery (`0x103da050`/`0x103dc700`/`0x103dc1d0`/`0x103db3f0`)
  recovered at the field level — see the graph layout above.
- `FindStairRotation` (524) is inline fp using the `GMath` sine table
  (`0x103fxxxx` via Core's `FVector::Rotation`) — integer math, no
  transcendentals; the Unicorn oracle is authoritative for it.
