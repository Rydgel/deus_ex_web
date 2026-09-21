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
  bit-exact vs the oracle** for the documented cases below.
- `checkMove` return codes `5`/`1`/`−1` confirmed against scripted hits;
  `reachMask` (`0x10326d10`) returns the predicted 7-bit capability gather.
- Boundary order for `pointReachable`: `PointRegion → FastLineCheck →
  FarMoveActor(test) → FarMoveActor(restore) → dispatch → checkMove loop →
  FarMoveActor(restore)`.

Flying reach now has its own 30-case original-DLL comparison, including callers;
see the contract and verification below.  `AIPickRandomDestination` (709) and
`FindPathToward` (517) are dispatched live in Play mode.

Not yet oracle-verified: swimming reach helpers, `jumpArc`, the
proximity-landing `appSqrt` arc, `FindRandomDest`, `FindPathTo`,
`PickWallAdjust`, `FindStairRotation`.

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
   the destination (vtable `+0x8c`); on success, restore the original Location
   with `FarMoveActor(test=1, noCheck=1)` before dispatch.
6. Dispatch on physics through `0x103c1000` (`thunk 0x1030353f`):
   - `Physics==4` → `flyReach` `0x103c1190`, which calls `flyMove` `0x103c3900`
   - `Physics==1` or `3` → walk/swim helper `0x103c1b70`
   - water destination → water helper `0x103c15a0`
   - else → 0.  All helpers get `(pawn; point, radius=15.0, 0, target)` —
   the `15.0` literal `float [0x104314b8]`.
7. Each reach helper ends with its own `FarMoveActor(test=1, noCheck=1)` restore
   and Velocity copyback.

The dispatcher `0x103c1000` tests the pawn's current `Region.Zone` water bit
and its `Physics` byte (`+0x30`) to pick the helper. The point worker restores
the test teleport before dispatch; each reach helper restores its own test
moves at exit.

## Flying contract recovered 2026-09-19

Before implementing this slice, the installed, hash-verified Engine.dll was
read again through `NavProbe`: thunk `0x10303c9c` jumps to `0x103c1190`, and
thunk `0x1030326f` jumps to `0x103c3900`. The original unwind strings name
these bodies `APawn::flyReachable` and `APawn::flyMove`. `0x10303422` instead
jumps to the unported jump-arc worker `0x103c2f50`. The earlier notes calling
`0x103c1190` a jump helper were wrong: Pawn.uc's packed flag order identifies
`+0x318 & 0x8000` as `bCanFly`, `0x1000` as `bCanJump`, and `0x4000` as
`bCanSwim`. Walk reach's blocked-flight branch calls the same flying body.
Local disassemblies: `.cache/nav-disasm/w_flyMove.txt` and `w_flyReach.txt`.

`flyMove(pawn, delta, target, scale, restoreOnFailure)` (`0x103c3900`):

1. Save Location, compute the step-up vector `(-0, -0, MaxStepHeight)` from
   two multiplications by the DLL's `-1.0f` at `0x104298f0`, and test-move by
   Delta with the current Rotation and flags `(1,1,0,0)`.
2. A non-null target hit returns 5 immediately. When Hit.Time < 1 (including
   unordered), store `remaining = f32(1.0 - Time)`, round each remaining Delta
   component to f32, move up, then move by the remaining **three-dimensional**
   Delta. Only the forward retry checks the target; an up-step target hit alone
   does not return 5. There is no step-down probe.
3. Compare `scale * scale` against the retained x87 squared displacement
   `(x-oldX)^2 + (y-oldY)^2 + (z-oldZ)^2`. Sufficient displacement (inclusive,
   or unordered) returns 1. Otherwise restore Location via FarMoveActor(1,1)
   only when the final argument is nonzero, and return 0. Rotation is read
   again for each move. Velocity is untouched.

`flyReach(pawn, point, radius, reachFlags, target)` (`0x103c1190`):

1. Save Location/Velocity; accumulate reach bit 2. The step length is
   `max(CollisionRadius, 200.0f)` (`0x10431444`), with native unordered choice
   preserved. Store radius-squared and step-squared to f32.
2. At each iteration compute retained x87 dx/dy/dz and their three-dimensional
   squared distance, also storing the vector and squared distance to f32.
   Arrival needs retained distance <= stored radius-squared **and** retained
   abs(dz) <= CollisionHeight. Both compares include unordered. For a stored
   distance below step-squared, call flyMove with the raw f32 vector and scale
   8.0f; otherwise SafeNormal it, scale by the step and use 4.1f. Its final
   restore-on-failure argument is always 0.
3. flyMove return 5 means success; return 0 stops. Otherwise a current water
   zone stops flight: only bCanSwim and non-pain/matching ReducedDamageType
   allow delegation to waterReach, whose returned mask replaces reachFlags.
   There is no dry-zone pain check in this body. The loop counter starts at
   100 and stops when its decremented value is negative (up to 101 moves).
4. On failure, a WarpZoneMarker whose `+0x44c` equals current Region.Zone can
   still succeed. Always FarMoveActor(1,1) back to saved Location, then restore
   Velocity. Return accumulated reachFlags on success, otherwise 0.

The original reference cases were captured before the JS translation, using
`node scripts/validate-pawn-flying-reach.mjs --original-only`. They confirmed
return codes, move/restore counts and the walking fallback's combined mask 3;
the comparison now checks every ordered boundary call and its raw argument
bits, as well as the return and final Location/Velocity. Captures stay under
`.cache/pawn-nav/flying-reference.json`. The original retained-distance case
`point=(15,0.001,0), radius=15` requires a move even though the stored f32
squared distance equals 225; a mutant using the stored value is rejected.

Two adjacent issues surfaced at the integration boundary: the native checkMove
prologue explicitly zeroes incoming Delta.Z (`0x103c32c0`), and its up-step
multiplies both zero components by -1, producing negative zeros. The translation
now preserves both. The probe's per-operation buffers were already reset, but
its callsite ordering log accumulated earlier scenes; it now resets per scene
as well. Raw argument-bit captures preserve signed zero and integer Rotation.

Still unresolved: waterReach and jumpArc translations, actual level collision/
zone service composition, and VM navigation dispatch. Accepted swimming
handoffs, non-finite inputs and dynamically changing zones are not covered by
this flying corpus. An accepted water handoff requires an explicit service;
none is invented. Passing scripted-boundary comparisons does not establish
original whole-scene flight.

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
  - Other results first test `pawn+0xd0`; a clear byte stops with failure.
    Otherwise `bCanFly` (`0x8000`) delegates to flyReach through `0x10303c9c`.
    Failing that, `bCanJump` (`0x1000`) accumulates reach bit 8 and, for return
    `−1`, invokes `SafeNormal` + jumpArc through `0x10303422`. Without either
    capability, return `−1` retries only if the current step radius exceeds
    MaxStepHeight, clamping that radius to MaxStepHeight.
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
| `+0x318` | pawn flag dword | swim `0x4000`, fly `0x8000`, jump `0x1000`, reach-mask bits |
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
  `{+0x00 distance, +0x04 Start, +0x08 End, +0x0c collisionRadius,
   +0x10 collisionHeight, +0x14 reachFlags, +0x18 pruned}`.
  `ULevel+0x90` is the array's `Num` — the path workers gate on it nonzero.
- `NavigationPoint.Paths[16]` `+0x360` — outbound ReachSpec indices, `-1`
  terminator.  `PrunedPaths[16]` `+0x3a0` is the second outbound array;
  `upstreamPaths[16]` `+0x320` is the inbound array the BFS relaxes.
- `LevelInfo+0x548` — the `NavigationPointList` head (serialized on the map
  actor; the chain itself is serialized `nextNavigationPoint` links `+0x42c`).
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
openable only when its `+0x4ec & 0x8` is clear.  Both outbound arrays are
scanned in turn — `Paths` (`+0x360`) then `PrunedPaths` (`+0x3a0`).

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
   - the pawn's `MoveTarget` (`+0x34c`) is checked first if it is a NavigationPoint
     within bounds; then the list `level+0x90 → +0x42c (nextNav)` is walked.
   - a candidate returns `1` when it `== target` or `directReach(pawn, nav,
     target)` succeeds.
   - candidate(s) found but none reached → `0`, unless `pawn.Physics==4`
     (PHYS_Flying) which falls through.
4. Everything else → `actorWorker(pawn, originalTarget, 0)` (thunk
   `0x103024be`), with the Inventory restored first.

## `FindPathToward` native 517 — exec `0x103bc9c0` → worker `0x103db3f0`

`actor FindPathToward(actor target, optional bool bSinglePath=0, optional
bool bClearPaths=1)` — the ReachSpec path search Training's `Patrolling`
state calls (`MoveTarget = FindPathToward(destPoint)`).  The exec always
evaluates three GNatives slots; omitted optionals compile to `EX_Nothing`
so the pre-stored defaults survive (517's third slot is pre-set to 1).
On a non-null target it runs the worker with `&found` out-param; afterwards
it clears `bShootSpecial` (`+0x318 & ~0x2000000`) and `SpecialPause`
(`+0x460`), runs `navTailSet` when the result probes `SpecialHandling`
(`IsProbing` name `0x15a`), and clears `SpecialGoal` when it equals the
result.  `*result` receives the found node only when the worker succeeds.

Worker `0x103db3f0` (`thiscall pawn; target, bSinglePath, &found, bClearPaths`):

1. Gates: `*found=0`; null target, absent `LevelInfo+0x548` nav list, or
   `ULevel+0x90 == 0` (empty ReachSpec table) → 0.  A falling target
   (`Physics==2`) delegates through `landPredict` → the `findPathTo` worker
   `0x103dc1d0` — an explicit unported service boundary.
2. `navScoutA` collects two sorted 32-slot candidate lists over the serialized
   nav chain: `listA` keyed by pawn-distSq (seeded by `MoveTarget` within
   `|dz|<CH_a+CH_p` and `distSq<CR²`, doubled for `bIsPlayer`+`InventorySpot`),
   `listB` keyed by target-distSq; both cap at `distSq<640000` (800²).  With
   `bClearPaths` each node resets `nextOrdered/prevOrdered=0`,
   `+0x448 &= ~2` (bEndPoint), `visitedWeight=10M` (`+0x420`), and
   `cost = bSpecialCost(bit3 of +0x448) ? SpecialCost(pawn) : ExtraCost`.
3. `flag24==0` → `navScoutB(listB)`: validates the pawn-side head via
   eye-`FastLineCheck` + `pointWorker(nav.loc,1)` (retrying after removal);
   a head within `max(ftol(CR),48)` and `|dz|<CH` sets `flag24` (at-nav),
   else marks `+0x448|=2` and stores `bestPathWeight=sqrt(key)`.
4. `flag24` set (navpoint target or at-nav) → the direct block:
   `directReach(pawn, listB.items[0], target)` for NavigationPoint targets,
   else `navScoutC` — `distSq<640000` + `FLC(items0→targetLoc)` +
   `FarMoveActor(pawn→items0,1,0)` + `pointWorker(target,0)`; success returns
   `*found=target` (or `items0`), the pawn left at items0 for the caller to
   restore.  Only a `pointWorker` failure restores the pawn before
   `count=1` — distSq/FLC/farMove failures collapse the list directly.
5. Otherwise the worker scans `listA` for a reachable anchor:
   `FLC(item→targetLoc)` + `FarMoveActor(pawn→item)` + `actorWorker(pawn,
   target,1)`; a winner is promoted to `items[0]` (`keys[0]=sqrt(key)`) and
   sets `flag14`; `bHunting` (`+0x318 & 0x200000`) forces `flag14`.
6. `items0.visitedWeight = keys0` then `navSearchBFS` — a lazy-sorted
   doubly-linked open list (`nextOrdered`/`prevOrdered` `+0x430/+0x434`) that
   relaxes each popped node's `upstreamPaths` with
   `newCost = cur.vW + spec.dist + cand.cost + (bEndPoint ? cand.bestPathWeight : 0)`;
   strict improvement unlinks and sorted-reinserts.  Endpoint hit records
   `start.prevPath=0; *found=node`.  Caps: `bSinglePath` aborts above 4 pops,
   1000 pops total, 500-node insert scan.
7. When `flag14==0` the BFS-1 result is retried as pass 2: `navScoutA` again,
   `navScoutD(listB)` marks the target-side head's outbound spec ends
   `bEndPoint` with `bestPathWeight=spec.distance` (raw bits; dims/mask/edge
   `SingleLineCheck`/mover gates as `directReach`), `navScoutB(listB)`
   validates it, then BFS-2 runs from `listA.items[0]` → `reverse(*found)` →
   `*found` = chain tail.  `flag24` or `|dz|<120` then runs the second-hop
   `FLC(pawnEye→hop2)` + `pointWorker(hop2)` refinement that may replace
   `*found` with the second hop; a single-node anchored chain fails instead.
8. Success restores the pawn via `FarMoveActor(origLoc,1,1)` and returns 1.

`navTailSet` (`0x103bca4a`) re-probes `SpecialHandling` on the found node,
tracks `SpecialGoal`, and re-paths via the worker when the special goal is
unreachable — dispatched through `pawnNavServices.specialHandling`
(`dispatchSpawnedEvent`) and `specialCost` in the scoutA reset.

**Live dispatch.** `invokeNative` index 517 evaluates the three slots
(defaults 0/1 for the omitted-optional `EX_Nothing` tail) and calls
`execFindPathToward` over `pawnNavServices`: serialized `NavigationPointList`
head (`level.actors[0]`), the `nextNavigationPoint` chain, `Paths`/
`PrunedPaths`/`upstreamPaths` index arrays, the live `level.reachSpecs`
table (`start`/`end` resolved to live actors), `Flags318`/`Flags1dc`/
`Flags4ec` bits bound to the recovered native property offsets/masks, and
`isA('NavPoint')` normalized to the real `NavigationPoint` class.

**2026-09-21 review contracts.** The hash-checked Engine.dll establishes
three cases missed by the initial integration:

* `sortedInsert` (`0x103dd170`) searches for the insertion position before
  the `index < 32` gate (`0x103dd1e7`). It increments the count only below
  32 (`0x103dd204`–`0x103dd210`) and shifts only through that capped count.
  A full list therefore admits a closer candidate, discards the farthest,
  and inserts equal keys before existing equal keys. Executing the original
  helper with keys 100…131 and a new key 1 yields 1,100…130 at count 32.
* `actorWorker` tests `target+0x1dc & 4` at `0x103c0b26`. This is
  `bBlockActors`, as independently recovered by `AActor::SetCollision`
  (`0x10369200`, see [actor collision](script-datavault-image.md)); it is
  not `bNoDelete` in the separate `+0x28` actor word. Navigation needs the
  four verified low collision bits: `bCollideActors=1`, `bCollideWorld=2`,
  `bBlockActors=4`, `bBlockPlayers=8`. No upper-bit behavior is claimed here.
* `execFindPathToward` seeds its third argument to 1 at `0x103bca11`
  before evaluating it through GNatives at `0x103bca2b`. `EX_Nothing`
  leaves that slot unchanged. Both a missing argument and an explicit
  `EX_Nothing` preserve the default; an explicitly supplied zero stays zero.
  Oracle comparisons must include `compileFunction` →
  `ScriptRuntime.invokeNative`, since calling the worker with pre-resolved
  defaults cannot verify this binding.

Training `Secretary0` (`Orders=Patrolling`, `OrderTag=sec1`) reaches 517 in
`Patrolling.Moving` and receives `PatrolPoint4` — the only nav node inside
the native 800-unit candidate radius for its first leg. Running the original
`PatrolPoint.PreBeginPlay` now resolves `NextPatrolPoint`, so the script
continues to PatrolPoint5 and back instead of entering Standing after one
leg. `validate-secretary-patrol.mjs` verifies walking arrival with positive
MoveTimer at both points, then compares the 1900-tick route after public
`game.reset()` with fresh load. The ~28u vertical offset is allowed by the
original walking arrival rule, which zeroes dz before checking horizontal
distance `<16u`. See [patrol evidence](script-pawn-locomotion.md#live-patrol-verification--00_training-secretary0).

**Oracle coverage.**  140/140 scenes bit-exact and 35/35 targeted mutants in
`scripts/validate-pawn-nav.mjs`: direct reach, `MoveTarget` anchor seeding,
BFS relax/order/abort (`bSinglePath` 5th-pop abort, 1000-pop cap),
pass-2 (`scoutD` endpoint marking + reverse + second-hop refinement),
`bClearPaths` clear/no-clear, single-path, the exec tail (`bShootSpecial`/
`SpecialPause` clears, `SpecialHandling` probe, `SpecialGoal` clear), and
the `EX_Nothing` default-arg path. Two full-list scenes pin late closer and
equal-key insertion against the original worker. All 15 FindPathToward exec
scenes also compare the decoded VM → `ScriptRuntime.invokeNative` path to
the same oracle, including node reset fields for `EX_Nothing` and explicit
zero. The live Secretary validator checks `Flags1dc` on Training's Plant2
(blocking/deletable) and LevelInfo (nonblocking/nondeletable), independently
of the oracle's fabricated raw flag words. Each of these regressions failed
before its corresponding correction.

The probe's `IsProbing` hook intercepts
the real `?IsProbing@UObject@@QAEHVFName@@@Z` export (the `VFName` by-value
mangling — the earlier `QBEH` lookup silently missed and let fabricated
objects reach the real function).

Remaining explicit boundaries: falling-target delegation (`landPredict` +
the `findPathTo` worker) and `waterReach`/`waterMove`/`jumpArc` stay
unported service seams — they throw rather than guess.

## `AIPickRandomDestination` native 709 — `execAIPickRandomDestination` `0x103c86f0`

Script signature (all `Wandering.PickDestination` call sites pass an **int**
yaw — the declared `Dir` rotator param arrives as one 4-byte slot):

```text
AIPickRandomDestination(float minDist, float maxDist, int centralYaw,
    float yawDist, int centralPitch, float pitchDist, int tries,
    float multiplier, out vector dest)
```

Four recovered bodies, all ported to `src/runtime/script-pawn-nav.mjs` and
oracle-verified bit-exact (27 scenes across the four bodies plus 7 chain
mutants, inside the validator's shared 123-scene corpus in
`scripts/validate-pawn-nav.mjs`, driven by `scripts/native-pawn-nav-probe.py`
under Unicorn with a scripted `appFrand` queue):

- **Direction helper `0x1036d030`** (`aiDirection`): `yawDist`/`pitchDist`
  clamp to `[0,1]` (NaN→0), fold to `d' = f32((clamp+1)·0.5)`; two draws per
  call map `u=2·frand−1` through the piecewise fold `m=|u|≤d' ? |u|(1−d')/d' :
  ((|u|−d')·d'/(1−d'))+(1−d')` with the sign taken from the **f32 store** of
  `u`.  Scales: yaw `±32767/32768`, pitch `±16383/16384`; the offset truncates
  through MSVCRT `_ftol` and adds the central terms.  `dist=0` ⇒ `d'=0.5` ⇒
  `m=|u|` — a uniform ±full-circle draw.
- **Band search `0x103c78a0`** (`aiPickSearch`): strides the pawn along
  `dirVec = XAxis(FCoords{pitch,yaw,0})` — empirically `f32(cp·cy),
  f32(cp·sy), sp` — with `stride = clamp(CollisionRadius, 5, 25)`, calling
  `checkMove`/`flyMove`/`swimMove` per step.  The init score associates
  `(dx²+dz²)+dy²` (`0x103c79bf`) while the in-loop score associates
  `(dx²+dy²)+dz²` (`0x103c7cc3`) — both preserved.  Mode: region water → 3
  (unported `swimMove` boundary), Physics 1|3 → 1 (walk), 4 → 2 (fly), else
  early return before any restore/out write.  The pawn's Location/Velocity
  are snapshotted and `FarMoveActor(test=1,noCheck=1)`-restored; `*out`
  receives the last candidate.
- **Worker `0x103c7fc0`** (`aiPickWorker`): `tries=max(tries,1)`,
  `mult=clamp(mult, 9.9999997e-5, 1.0)`.  Per attempt: `aiDirection` →
  `aiPickSearch` over band `[f32(minR/mult), f32(maxR/mult)]`; when found and
  `mult<1`, a second search re-verifies the destination pulled to `d·mult`
  along the same direction.  `*out` is written unconditionally (found
  position or the entry location on failure); returns 0/1.
- **Exec `0x103c86f0`**: evaluates the nine script args left to right; the
  `out vector` keeps its reference so the native writes back to the caller's
  `destLoc`.

### Live dispatch (2026-09-20 follow-up)

`ScriptRuntime.invokeNative` index 709 builds `pawnNavServices` over the
existing `pawnPhysicsView` seam: `Location`/`Velocity` bindings (the module
restores Velocity by mutating a **live** host array — the field binding's
get copies, so the nav seam binds `actor.velocity` directly), `Region`/
`FootRegion` zone reads via the reflected point-region struct, the pawn
`+0xd0` byte as `Region.ZoneNumber` and `+0x444` as `ReducedDamageType`.

The `checkMove` steps run the recovered **test-mode `MoveActor`** contract
(hash remove → commit → hash re-add → `SetActorZone(test=1)`, no events) with
`bTest=1, bIgnorePawns=1`: `move-query.mjs` now filters non-static Pawn- and
Decoration-ancestry candidates per the original `0x103995ea` gate.

Training `mib1` live result: reaches 709 in `Wandering.PickDestination`,
executes the recovered searches, and wanders — default seed 1 succeeds on
pick #15 (~tick 559) and continues through four wander legs over 1920 ticks
with zero NPC failures.  Failed episodes follow the original pacing (six
`tries=1` iterations, then `Sleep(0.5)` + ~6 s pause before retry).
`scripts/validate-mib-startup-boundary.mjs` now asserts this live contract
on both load and reset.

Boundaries reached while wandering and their resolution:

- `TraceTexture`/`TraceActors`/`RadiusActors`/`VisibleActors` accepted only
  their full argument count; the UC compiler legitimately emits fewer
  expressions for trailing `optional` params (the execs' OPTX macros keep
  the pre-stored defaults).  Gates now accept the required..max range —
  `GetFloorMaterial`'s 8-arg `foreach TraceTexture` runs.
- `ScriptedPawn` ambient `PlaySound(264)` sites (footsteps, idle/scan/alert
  sounds, discarded returns) are recorded nonfatal boundaries — the pawn
  keeps ticking; AI propagation stays on the separately recorded 713–716
  natives.  `human.playtakehitsound` and other measured stop points still
  throw through `soundBoundary`.
- `pollMoveTo`/`pollMoveToward` fire `SpawnNotification` through
  `FindFunctionChecked`: no shipped pawn class declares it (the function
  lives on `SpawnNotify`), so the original miss logs a nonfatal `Logf` and
  returns NULL, which `AActor::ProcessEvent`'s `XLevel+0x4f0` bit-0x2 gate
  drops before Core `ProcessEvent` can dereference it.  The runtime now
  dispatches only on a real resolution — observable contract unchanged.

Remaining explicit boundaries: `swimMove`/`waterMove`/`waterReach`,
`jumpArc`, and the ReachSpec BFS path workers stay unported; bark speech and
audible playback are Stage 4.

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
  hit, `directReach` reach, MoveTarget hit/reach, found-but-unreachable non-flying
  0 vs PHYS_Flying fallback, none-near fallback, Inventory holder redirect,
  no-holder fallback, `CR>115` gate, overhead-nav `|dz|<CH` gate, Inventory
  restore to the worker) plus 8 mutants.  The verdict is `*result`-normalized;
  unspecified actor fields are 0 (the probe zeroes fabricated memory).
- `checkMove` `0x103c3290` — **ported to JS, bit-exact vs oracle** across 17
  scenes (flat/step-up/target-hit/ledge/steep/under-moved/low-grav) plus 4
  mutants detected. The latest case additionally verifies incoming Delta.Z
  is zeroed, and the flying-fallback comparison checks signed-zero step args.
- `walkReach` `0x103c1b70` — **ported to JS, bit-exact vs oracle** across 11
  flag-free walking scenes (flat near+far steps, inside-radius arrival,
  below-step landing, blocked, ledge no-retry vs `CR>maxStep` clamp-retry,
  diagonal, pain gate, water-no-swim gate, velocity restore) plus 2 mutants.
  The flying corpus additionally checks the `bCanFly` fallback into flyReach.
  Jump arc `0x103c2f50` and swimming `0x103c15a0` still require unported
  services; the existing flag-free walking scenes do not establish them.
- `pointReachable` worker `0x103c0d30` — **ported to JS, bit-exact vs oracle**
  across 11 scenes (dry-to-dry reach, 1e6 distance gate, editor-skip, water
  gate, water+canSwim, pain gate, pain-immune, blocked LOS, arg14 LOS skip,
  farMove-test-fail, blocked walk) plus 5 mutants.  The worker returns the
  physics-dispatch result; the exec `0x103bc710` only reads the vector arg,
  passes `arg14=0`, and stores the result. VM dispatch integration is still
  pending. The flying corpus adds a point-worker → dispatcher → flight case.
- `AIPickRandomDestination` exec chain `0x103c86f0`/`0x103c7fc0`/
  `0x103c78a0`/`0x1036d030` — **ported to JS, bit-exact vs oracle** across
  27 scenes (direction distribution/clamps/sign/NaN, band-search flat/
  blocked/overshoot/fly/physics-gate/maxstep-retry/pain-stop/iter-cap/
  null-out/stride clamps, worker tries/mult clamps, second-stage pull-in,
  retry, pitch masking, exec verdict and out-slot handling) plus 7 chain
  mutants, and **dispatched live** through `invokeNative` →
  `pawnNavServices`; the Training MIB wanders in Play mode (see the section
  above for the service contract and the boundary resolutions).
- `flyMove` `0x103c3900` and `flyReach` `0x103c1190` — **ported to JS**,
  connected to physics dispatch and walkReach's bCanFly fallback, with **30/30
  original-DLL cases and 6/6 targeted mutants** passing in
  `scripts/validate-pawn-flying-reach.mjs`. Checks include ordered movement,
  restore and point/LOS calls, their exact argument bits, return masks and
  final Location/Velocity bits. There is still no live VM navigation binding.
- `FindPathToward` exec `0x103bc9c0` + worker `0x103db3f0` and its helpers
  (`navScoutA`–`navScoutE`, `navSearchBFS`, `reverse`, sorted insert/remove,
  `navTailSet`) — **ported to JS, bit-exact vs oracle** across the shared
  140-scene corpus (35/35 mutants) and **dispatched live** through
  `invokeNative` → `pawnNavServices`; Training `Secretary0` patrols in Play
  mode (see the section above).  Falling-target delegation
  (`landPredict`/`findPathTo`) remains an explicit unported service.
- The remaining helpers (`0x103c15a0` waterReach, `0x103c3ca0` waterMove and
  `0x103c2f50` jumpArc) are mapped but unported;
  `FindRandomDest`/`FindPathTo` share the
  ReachSpec BFS machinery (`0x103da050`/`0x103dc700`/`0x103dc1d0`)
  recovered at the field level — see the graph layout above.
- `FindStairRotation` (524) is inline fp using the `GMath` sine table
  (`0x103fxxxx` via Core's `FVector::Rotation`) — integer math, no
  transcendentals; the Unicorn oracle is authoritative for it.

Focused checkpoint (supersedes the 2026-09-20 note):
`validate-pawn-nav.mjs` passes 140/140 cases and 35/35 mutants, including
15 original comparisons through VM/runtime dispatch;
`validate-pawn-flying-reach.mjs` passes 30/30 cases and 6/6 mutants;
`npm test` passes 499/499. Natives 709 and 517 are live — the Training MIB
wanders and `Secretary0` follows the PatrolPoint4↔PatrolPoint5 route in Play
(`validate-mib-startup-boundary.mjs`, `validate-secretary-patrol.mjs`).
Stage 3 remains unfinished. Remaining navigation implementation includes
waterMove/waterReach, jumpArc and the ReachSpec path workers
`FindRandomDest`/`FindPathTo`.
