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
| 708 | `final function bool AIDirectionReachable(vector focus, int yaw, int pitch, float minDist, float maxDist, out vector bestDest)` | thunk `0x103022cf` | `0x103c8560` → band search `0x103c78a0` |

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

Swimming reach (`swimReachable`/`swimMove`) has its own 360-case
original-DLL comparison; see the swimming contract below.

Jumping (`FindBestJump`/`SuggestJumpVelocity`/`jumpLanding`) has its own
363-case original-DLL comparison; see the jumping contract below.

`AIDirectionReachable` (708: exec `0x103c8560` over the band search
`0x103c78a0`) has its own 285-case original-DLL comparison through the
translated exec and Play's VM binding, and is dispatched live.

Not yet oracle-verified: the
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
jumps to `APawn::FindBestJump` `0x103c2f50` (see the jumping contract). The earlier notes calling
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

Still unresolved (at the time): the jump translation, since done; actual level collision/
zone service composition, and VM navigation dispatch. Accepted swimming
handoffs, non-finite inputs and dynamically changing zones are not covered by
this flying corpus; the swimming corpus below covers flyReachable's water
hand-off and swimReachable's hand-back to flight. Passing scripted-boundary comparisons does not establish
original whole-scene flight.

## Swimming contract recovered 2026-09-29 — `swimReachable` / `swimMove`

Read from the hash-verified Engine.dll before translation. Thunk `0x10301406`
jumps to `0x103c15a0` and thunk `0x10303f53` to `0x103c3ca0`; their SEH
unwind strings (`0x10431064`, `0x104311d4`) name them `APawn::swimReachable`
and `APawn::swimMove`. Local disassemblies: `.cache/nav-disasm/w_waterReach.txt`
and `w_swimMove.txt`. A rel32 scan of the whole image finds exactly these
callers:

| Callee | Call site | Caller | Arguments |
| --- | --- | --- | --- |
| swimReachable | `0x103c1059` | dispatcher `0x103c1000` | `(point, radius, 0, target)` when `Region.Zone` is water (before the Physics byte is read) |
| swimReachable | `0x103c13cd` | flyReachable | `(point, radius, reachFlags, target)` after a flyMove that left the pawn in water with bCanSwim and no mismatched pain zone; the result replaces reachFlags and success |
| swimReachable | `0x103c1fb8` | walkReach `0x103c1b70` | `(point, radius, arg18, target)` from the same water/bCanSwim/pain gate; the result replaces arg18 and reached |
| swimMove | `0x103c177a` | swimReachable | `(step, target, 8.0f or 4.1f, 0)` |
| swimMove | `0x103c7c13` | aiPickSearch mode 3 | `(dirVec*stride, 0, 4.1f, 0)` |

Nothing else in Engine.dll calls either body; pointReachable/actorReachable
reach swimReachable only through the dispatcher and the two reach loops.

### `APawn::swimMove(FVector Delta, AActor* GoalActor, FLOAT threshold, INT bAdjust)` `0x103c3ca0`

`thiscall`, `ret 0x18`. The prologue and the in-water tail are
instruction-for-instruction the flyMove body (a normalized diff of the two
listings differs only in the inserted dry branch and jump targets):

1. `Start = Location` (`[ebp-0x30..-0x28]`). `Down = (0.0f, 0.0f, M*-1)` with
   `M = MaxStepHeight` (`+0x38c`) and `-1.0f` at `0x104298f0`; `Up` is each
   component times `-1.0f`, stored: `(-0.0, -0.0, f32(M))`. A local
   `FCheckResult Hit(1.f)` (`Time=1`, `Item=-1`, Actor 0).
2. `MoveActor(Delta, Rotation, Hit, bTest=1, bIgnorePawns=1, 0, 0)`.
   `GoalActor && Hit.Actor == GoalActor` returns **5** (`0x103c3dac`).
3. **Dry branch** (`0x103c3dc4`): if `Region.Zone->bWaterZone` (`+0x388` bit 0,
   read after the move) is clear, `End = Location`, `findWaterLine(Start, End)`
   (thunk `0x1030227a`, body `0x103d3b10`, see [swimming](swimming.md)). If any
   component differs (`fcomp; test ah,0x40`: equal or unordered counts as the
   same), `MoveActor(f32(End - Location), Rotation, Hit, 1, 1, 0, 0)` — the
   differences are extended, each stored once. Returns **0** in all cases,
   without a restore and regardless of `bAdjust`.
4. **Water** (`0x103c3eac`): when `Hit.Time < 1.0` (double; C0, unordered
   included) `rem = f32(1.0 - Time)`, `Delta = f32(Delta_i * rem)`,
   `MoveActor(Up)`, `MoveActor(Delta)`; only the second move's hit is tested
   for GoalActor (**5**).
5. `threshold² <= (dx²+dy²)+dz²` (`Location - Start`, all extended; `fcompp;
   test ah,0x41`, unordered included) returns **1** (`[ebp-0x1c]`). Otherwise
   `bAdjust` restores `FarMoveActor(Start, bTest=1, bNoCheck=1)` and it
   returns **0**. Velocity is not touched; Rotation is re-read for every move.

The one Hit buffer is shared by every MoveActor. `ULevel::MoveActor` returns
before writing Hit when every Delta component is below `1e-4` and the rotation
is unchanged ([swimming](swimming.md#moveactors-nearly-zero-return)); swimMove
always passes the pawn's own Rotation, so for such a Delta the previous Hit —
including a GoalActor hit by the up-step — is what the target test reads.

### `APawn::swimReachable(FVector Dest, FLOAT intRadius, INT reachFlags, AActor* GoalActor)` `0x103c15a0`

`thiscall`, `ret 0x18`; the loop shape is flyReachable's:

1. `reachFlags |= 4` (R_SWIM). `closeSq = f32(intRadius²)`. A dead
   `Direction = f32(Dest - Location)` store. Save `OriginalPos = Location`,
   `realVel = Velocity`, `success = 0`. `stepsize = CollisionRadius` when
   `200.0f < CR` or unordered (`0x10431444`), else `200.0f`;
   `stepSq = f32(stepsize²)`. `ticks = 100`, `stillmoving = 1`.
2. Each iteration: extended `d = Dest - Location`, `Direction = f32(d)`,
   `distSq = (dx²+dy²)+dz²` kept extended and also stored.
   - Arrival: retained `distSq <= closeSq` **and** `|dz| <= CollisionHeight`
     (both `test ah,0x41`, unordered included) sets `success = 1` and stops.
   - Otherwise stored `distSq < stepSq` (C0, unordered included) calls
     `swimMove(Direction, GoalActor, 8.0f, 0)`; else
     `swimMove(f32(SafeNormal(Direction)_i * stepsize), GoalActor, 4.1f, 0)`.
     A return of 5 sets `success = 1, stillmoving = 0`.
   - Then, for every result, `Region.Zone` is read again:
     - **Not water** (`0x103c17a4`): `stillmoving = 0`. With bCanFly
       (`+0x318 & 0x8000`): `success = reachFlags = flyReachable(Dest,
       intRadius, reachFlags, GoalActor)`. Else with bCanWalk (`0x2000`) and
       `(MaxStepHeight + Location.Z) + 50.0f > Dest.Z` (extended sum, float
       `50.0` at `0x104314b4`, strictly greater and ordered): a fresh
       `FCheckResult(1)` and `MoveActor((+0, +0, f32(max)), Rotation, Hit, 1,
       1, 0, 0)` where `max` is `CollisionHeight + MaxStepHeight` (extended)
       unless it is below the stored `f32(Dest.Z - Location.Z)` or unordered.
       If `Hit.Time == 1.0` (C3, unordered included) `success =
       flyReachable(Dest, intRadius, reachFlags, GoalActor)` and **reachFlags
       becomes the constant 1** (R_WALK). Otherwise, and without either
       capability, success is kept (a 5 from swimMove survives).
     - **Water, pain zone** (`+0x388 & 0x20`) whose `DamageType` (`+0x350`)
       differs from `ReducedDamageType` (`+0x444`): `stillmoving = 0`,
       `success = 0` — also after a 5.
   - `if (--ticks < 0) stillmoving = 0` (at most 101 swimMove calls).
3. When `success == 0` and GoalActor is a WarpZoneMarker (class chain `+0x24`/
   `+0x28` walk for `0x10575198`), `success = (Region.Zone ==
   GoalActor->markedWarpZone +0x44c)`.
4. `FarMoveActor(OriginalPos, 1, 1)`; `Velocity = realVel`; return
   `success ? reachFlags : 0` (`neg; sbb; and`).

Constants: `200.0f` `0x10431444`, `50.0f` `0x104314b4`, `4.1f` and `8.0f` as
immediates, `1.0` double `0x104298a0`, `-1.0f` `0x104298f0`, `0.0f`
`0x10426d54`. No transcendental is used; SafeNormal and the FVector
constructor are Core imports (`0x10599b80`, `0x10599b28`).

State writes: Location through MoveActor/FarMoveActor only, Velocity restored
at exit, the `[ebp+0x18]` reachFlags slot, and nothing else on the pawn.

Unresolved or unmodeled branches:

- flyReachable and swimReachable can call each other (fly into water, swim
  out of it); the native recursion has no depth limit beyond the geometry.
  The translation recurses the same way and a runaway would end in a JS stack
  error, not an original result.
- findWaterLine's non-convergent midpoint remains the explicit boundary
  recorded in [swimming](swimming.md#translation).
- checkMove and flyMove share the Hit-retention rule above but their
  translations do not model it; only swimMove does.
- flyReachable and walkReach compare `Region.Zone` with a WarpZoneMarker's
  `markedWarpZone` through the `WarpDestZone` service read; swimReachable does
  the same. Play's pawnNavServices has no such field, so that fallback is only
  established by the oracle's fabricated marker.

### Verification (2026-09-29)

The original cases were captured with
`node scripts/validate-pawn-swimming-reach.mjs --original-only` before the
translation existed; every hand-written expectation above matched the DLL on
the first capture. `native-pawn-nav-probe.py` gained three controlled-world
scene options, identical on both sides of the comparison: `waterPlane` (the
PointRegion double answers the wet zone strictly below a plane, and after every
MoveActor/FarMoveActor commit Region.Zone follows it — a SetActorZone
stand-in), `moveNearlyZero` (MoveActor's early return: no move, no zone update,
Hit untouched) and `coverage`.

`scripts/validate-pawn-swimming-reach.mjs`: **360/360 original-DLL cases, 0
mismatches** — 60 targeted and 300 seeded generated cases over swimMove,
swimReachable, the dispatcher, pointReachable's worker, walkReach and
flyReachable water hand-offs, aiPickSearch mode 3 and aiPickWorker in water —
comparing 2622 ordered MoveActor/FarMoveActor/PointRegion/FastLineCheck calls
with raw argument bits (signed zeros included), the return code, final
Location/Velocity bits, final Region zone and the out vector. **Every
instruction of both bodies executes** (swimMove 311/311, swimReachable
355/355; the SEH unwind funclets from `0x103c402e` and `0x103c1a0d` are
excluded). 9/9 targeted mutants are detected. Water-line crossings, partial
exits, the End == Location skip, blocked moves, zero-size and nearly-zero
steps, target hits before and after a pain zone or a water exit, the flight
and walk exits, the 101-move budget and the WarpZoneMarker fallback are among
the targeted cases.

The generated corpus exposed a defect shared with the flying and walking
translations: this module's FCOM model compared an arithmetic zero (the x87
model leaves `sig 0, exp 0`) by magnitude exponent, so `+0` compared above a
positive value below 2 (a pawn exactly on its destination with a small
radius failed arrival). The compare now orders a zero significand as ±0. The
existing 140-scene and 30-case corpora and the Training bench digest are
unchanged. `script-pawn-locomotion.mjs` and `script-pawn-perception.mjs` keep
their own copies of the same compare, not yet corrected.

Play: `aiPickSearch` mode 3, the dispatcher, flyReachable and walkReach call
the recovered bodies directly (no service seam; findWaterLine reads the nav
services' `pointRegion` and `regionZone`). On UNATCO Island with bench-sim's
forward-key workload and **no bypass**, GeneratorScout4 and GeneratorScout5
run 10 AIPickRandomDestination calls each in 20 s and every one finds a water
destination; Fish2Generator0 and FishGenerator0 then spawn their 10 fish each
(the player is ~1100 units away, below ActiveArea 1200, and cannot see the
spot), which swim through physSwimming. The first runtime boundary is now tick
1221 (20.35 s): PaulDenton0, state `RunningTo`, `GetNextWaypoint` →
`ActorReachable` (520) → actorWorker → dispatcher → walkReach, whose checkMove
returns -1 for a bCanJump pawn → jumpArc `0x103c2f50`, reported as `walkReach
requires the original jumpArc service (0x103c2f50)`
(`scripts/validate-island-swimming.mjs`). The jumping contract below
replaces that boundary.

## Jumping contract recovered 2026-09-29 — `FindBestJump` / `SuggestJumpVelocity` / `jumpLanding`

Read from the hash-verified Engine.dll before translation (listings:
`.cache/nav-disasm/w_jumpArc.txt`, `w_suggestJumpVelocity.txt`, `w_jumpLanding.txt`,
`w_jumpReachable.txt`, `w_findJumpUp.txt`). Thunk
`0x10303422` jumps to `0x103c2f50`, the export
`?FindBestJump@APawn@@QAEHVFVector@@0AAV2@H@Z`; its SEH unwind string
`0x1043116c` reads `APawn::FindBestJump`. Its two callees are
`?SuggestJumpVelocity@APawn@@QAEXVFVector@@AAV2@@Z` (thunk `0x103035a8` →
`0x103c2c80`, unwind name `0x10431134`) and
`?jumpLanding@APawn@@QAEXVFVector@@AAV2@H@Z` (thunk `0x103016ae` →
`0x103c2530`, unwind name `0x104310e8`). The DX SDK 1112f `APawn.h` declares
the same three signatures (`FindBestJump(FVector Dest, FVector vel, FVector
&Landing, int moveActor)`, `jumpLanding(FVector testvel, FVector &Landing, int
moveActor)`, `SuggestJumpVelocity(FVector Dest, FVector &Vel)`); `Reference/`
has no `UnReach.cpp`, so every behavior below comes from the DLL. Earlier
notes called `0x103c2f50` "jumpArc" and `0x103c2530` "landPredict".

Callers: a rel32 scan of the whole image, a scan for the six addresses as
data, and the import tables of every `System/*.dll`/`*.exe` (none imports
them):

| Callee | Call site | Caller | Arguments |
| --- | --- | --- | --- |
| FindBestJump | `0x103c1f0a` | walkReachable `0x103c1b70` | `(Dest, f32(GroundSpeed * SafeNormal(Direction)_i), &Landing, 1)` after checkMove returned −1 for a pawn with bCanJump and without bCanFly (Region.ZoneNumber nonzero); the result replaces the loop's `stillmoving`; Landing (`[ebp-0xcc]`) is never read |
| SuggestJumpVelocity | `0x103c2fb8` | FindBestJump | `(Dest, &vel)` |
| SuggestJumpVelocity | `0x103bc14e` | `execEAdjustJump` (native 523) `0x103bc110` | `(Destination +0x354, &v)` with `v = Velocity`; returns `v` |
| jumpLanding | `0x103c2fdb` | FindBestJump | `(vel, Landing, 1)` |
| jumpLanding | `0x103c23ed` | `jumpReachable` `0x103c2380` | `(Velocity, &Landing, 1)` |
| jumpLanding | `0x103db526` | findPathToward worker `0x103db3f0` | `this` = a PHYS_Falling Pawn *target*: `(target.Velocity, Landing = target.Location, 0)`, then the findPathTo worker (thunk `0x10303972` → `0x103dc1d0`) toward Landing |
| TwoWallAdjust `0x10323770` | `0x103c287c` | jumpLanding | `(DesiredDir, Delta, Hit.Normal, OldHitNormal, Hit.Time)` |

`jumpReachable` (`0x103c2380`, thunk `0x103030f8`) and `FindJumpUp`
(`0x103c2b20`, thunk `0x10303797`) are exported but never referenced; they are
dead in this build and are not translated. (`jumpReachable` ORs R_JUMP, lands
from Velocity with moveActor 1, returns 0 when Landing equals the start and
otherwise walkReachable(Landing) plus a FarMoveActor(1,1) restore;
`FindJumpUp` sets MaxStepHeight to 48 around one checkMove.)

### `APawn::SuggestJumpVelocity(FVector Dest, FVector &Vel)` `0x103c2c80`

`thiscall`, `ret 0x10`. No engine calls; Core `appSqrt` and
`FVector::SafeNormal` only.

1. `G = Region.Zone->ZoneGravity.Z` (`+0x324`); unless `G < 0.0f` (C0,
   unordered included) `G = -100.0f`. `deltaZ = f32(Dest.Z - Location.Z)`,
   `flightTime = 0.0f`, `jumpZ = Vel.Z` (raw bits), `currentZ = 0` held on the
   x87 stack for the whole loop — never stored.
2. While `currentZ > deltaZ` **or** `Vel.Z > 0.0` (both strictly greater and
   ordered): `Vel.Z = f32(Vel.Z + G * 0.05)` (the extended sum stays on the
   stack), `flightTime = f32(flightTime + 0.05)`, `currentZ += sum * 0.05`
   using the unstored sum. `0.05` is the double at `0x10426d58`. There is no
   iteration bound.
3. When `|Vel.Z| > 1.0` (double, ordered): `flightTime = f32(flightTime -
   (currentZ - deltaZ) / Vel.Z)` (overshoot correction; Vel.Z the stored f32).
4. `Vel = f32(Dest - Location)` per component, then `Vel.Z = 0`.
5. `flightTime > 0.0` (ordered): `XY = appSqrt(double(Vy² + Vx²))`; when
   `XY > 0` (ordered) `inv = 1.0 / XY` stays extended and
   `Vel_i = f32(inv * Vel_i)`. `ratio = XY / flightTime` (extended);
   `speed = GroundSpeed > ratio` (ordered) `? ratio : GroundSpeed`.
   Otherwise `Vel = SafeNormal(Vel)` and `speed = GroundSpeed` (`+0x378`).
6. `Vel_i = f32(speed * Vel_i)`, then `Vel.Z = jumpZ` (the entry bits).

So the incoming `Vel.X/Y` are ignored and `Vel.Z` is both the launch speed
and the returned Z.

### `APawn::jumpLanding(FVector testvel, FVector &Landing, int moveActor)` `0x103c2530`

`thiscall`, `ret 0x14`. `OriginalPos = Location`, `landed = 0`, `ticks = 0`,
`tickTime = 0.1f` (`0x3dcccccd`). While `!landed`:

1. Read `Region.Zone` once: `g = ZoneGravity` (`+0x31c`), `zv = ZoneVelocity`
   (`+0x328`), `f = ZoneFluidFriction` (`+0x338`). `k = 1.0f - t*f`
   (extended). New velocity: `vx = f32(f32(vx*k) + f32(t*gx))`, `vy`
   likewise, `vz = f32(f32(vz*k) + t*gz)` with `t*gz` **not** stored.
   `Adjusted = (f32(f32(vx+zvx)*t), f32(f32(vy+zvy)*t), f32((vz+zvz)*t))`
   — Z's sum again unstored.
2. A fresh `FCheckResult Hit(1.f)`; `MoveActor(Adjusted, Rotation, Hit,
   bTest=1, bIgnorePawns=1, 0, 0)`.
3. Region.Zone water → `landed = 1`. Else, when `Hit.Time < 1.0` (C0,
   unordered included): `Hit.Normal.Z > 0.7` (ordered) → `landed = 1`;
   otherwise slide: `dot = (Ny*Ay + Nx*Ax) + Az*Nz`,
   `Delta = (f32(dxE*rem), f32(f32(Ay - f32(Ny*dot))*rem),
   f32(f32(Az - f32(dot*Nz))*rem))` with `dxE = Ax - dot*Nx` and
   `rem = 1.0 - Hit.Time` extended; `OldHitNormal = Hit.Normal`. If
   `(Az*Dz + Ay*Dy) + dxE*rem*Ax >= 0` (C0 clear; X uses the unstored
   product) `MoveActor(Delta)`, and if that `Hit.Time < 1.0`:
   `Normal.Z > 0.7` sets landed, then — landed or not —
   `TwoWallAdjust(SafeNormal(Adjusted), Delta, Hit.Normal, OldHitNormal,
   Hit.Time)`, `MoveActor(Delta)`, and `Normal.Z > 0.7` sets landed.
   One Hit buffer serves the three moves (MoveActor's nearly-zero early
   return leaves it unwritten, as in swimMove).
4. `++ticks`; if `Region.ZoneNumber` (byte `+0xd0`) is 0, **or**
   `ticks > 35`, **or** `(vx² + vy²) + vz² > 2500000.0f` (ordered; stored
   components): `FarMoveActor(OriginalPos, 1, 1)` and `landed = 1` — even
   when this tick had landed.
5. After the loop `Landing = Location`; `moveActor == 0` adds
   `FarMoveActor(OriginalPos, 1, 1)`. Velocity is never written.

### `APawn::FindBestJump(FVector Dest, FVector vel, FVector &Landing, int moveActor)` `0x103c2f50`

`thiscall`, `ret 0x20`:

1. `realLocation = Location`; `vel.Z = JumpZ` (`+0x388`);
   `SuggestJumpVelocity(Dest, vel)`; `jumpLanding(vel, Landing, 1)` — the
   pawn stays at the landing spot.
2. `olddist = f32(Dest - realLocation)`, `dist = f32(Dest - Location)`.
3. `FootRegion.Zone` pain (`+0x388 & 0x20`) with `DamageType` (`+0x350`) ≠
   `ReducedDamageType` (`+0x444`) → 0. Else no bCanSwim (`+0x318 & 0x4000`)
   and `Region.Zone` water → 0.
4. Else `odS = f32(appSqrt((ox²+oy²)+oz²))`, `dS = appSqrt((dx²+dy²)+dz²)`
   (double), `netchange = f32(odS - dS)`. When `realLocation.Z - Location.Z
   < 350.0f` (C0, unordered included) success is `netchange > 8.0` (double,
   ordered). Otherwise success is 0 and `GLog->Logf("FAILING FBJ: nc %f from
   odS %f and dS %f and dz %f success %d", netchange, appSqrt(old²),
   f32(appSqrt(dist²)), Location.Z - realLocation.Z, 0)`.
5. `moveActor == 0` restores `FarMoveActor(realLocation, 1, 1)`. Return
   success (0/1).

Constants: `0.1f` immediate, `1.0f` `0x10429c50`, `1.0` `0x104298a0`, `0.7`
`0x1042adc0`, `0.0f` `0x10426d54`, `2500000.0f` `0x1042adb4`, `35`
immediate; `-100.0f` immediate, `0.0` `0x10429838`, `0.05` `0x10426d58`;
`350.0f` `0x104314cc`, `8.0` `0x104314c0`; format string `0x10481960`
(UTF-16). No transcendental; `appSqrt`, SafeNormal, the FVector constructor
and TwoWallAdjust run as original bodies in the oracle.

State writes: Location only through MoveActor/FarMoveActor; the caller's
`vel`/`Landing` buffers; no Velocity, Region or flag writes.

Unresolved or unmodeled branches:

- SuggestJumpVelocity's loop has no bound: a negative `G` whose `0.05` step
  no longer changes the stored Vel.Z hangs the original. The translation
  stops after 100000 iterations with an explicit error instead.
- The `FAILING FBJ` line is a GLog side channel. Its arguments are compared
  bit-exact; Play hands the event to the runtime log device, whose `%f` text
  is JS `toFixed(6)`, not MSVCRT's printf (rounding ties unverified).
- jumpLanding's TwoWallAdjust is the shared `steps.mjs` port, verified by
  `validate-native-steps` and here only through the jump corpus.
- The oracle's `+0xd0` ZoneNumber byte and FootRegion are static per scene;
  Region.Zone follows the water plane. Non-finite inputs are not covered.
- Native 523 `execEAdjustJump` (`0x103bc110`) is wired (2026-10-02):
  `v = Velocity`, `SuggestJumpVelocity(Destination +0x354, &v)`, `P_FINISH`,
  `*Result = v`; Velocity itself is untouched (ScriptedPawn
  `FallingState.AdjustJump` assigns the result). Every SuggestJumpVelocity
  case runs again through the original exec with Destination/Velocity in the
  pawn (74 `eaj-*` cases, the exec's 35/35 instructions), and through
  `ScriptRuntime.invokeNative`. The findPathToward falling-target branch is
  wired too; see the findPathTo worker.

### Verification (2026-09-29)

The original cases were captured with
`node scripts/validate-pawn-jump-reach.mjs --original-only` before the
translation existed. `native-pawn-nav-probe.py` gained the three bodies, the
ZoneInfo fields `ZoneGravity`/`ZoneVelocity`/`ZoneFluidFriction`, a
`vecbufInit` in/out vector, and a capture of Core `FOutputDevice::Logf`
(format string plus raw argument dwords, in the ordered call log). The
probe's `jumpZ` scene key wrote `+0x408`; Pawn's `JumpZ` is `+0x388`
(SDK `EngineClasses.h` order GroundSpeed, WaterSpeed, AirSpeed, AccelRate,
JumpZ, MaxStepHeight at `+0x378..+0x38c`, and FindBestJump's read). No
earlier scene used the key.

`scripts/validate-pawn-jump-reach.mjs`: **363/363 original-DLL cases, 0
mismatches** — 63 targeted and 300 seeded generated cases over
SuggestJumpVelocity, jumpLanding, FindBestJump and their live callers
(walkReach's −1 path, the dispatcher, pointReachable's and actorReachable's
workers) — comparing 3729 ordered MoveActor/FarMoveActor/PointRegion/
FastLineCheck/SingleLineCheck/Logf calls with raw argument bits, the return
code, the out vector (Vel or Landing), final Location/Velocity bits and
Region zone. **Every instruction of the three bodies executes**
(FindBestJump 195/195, jumpLanding 359/359, SuggestJumpVelocity 163/163; the
SEH funclets `0x103c31a4`, `0x103c29b7` and `0x103c2e5d..0x103c2e8d` are
excluded). 23/23 targeted mutants are detected, among them the unstored
`t*gz` and `currentZ` intermediates, the overshoot correction, the
GroundSpeed/ratio choice, the 36th-tick restore, the speed² cap, the
ZoneNumber gate, the slide gate, landing-without-stopping before
TwoWallAdjust, Hit retention across a nearly-zero slide, JumpZ replacing
vel.Z, the 350 drop limit, the 8.0 gain, both zone gates, both restores and
the Logf argument bits. The translation, written from the contract above,
matched all 359 cases of its first comparison.

Play (`scripts/validate-island-jump-reach.mjs`, original Play, no bypass,
bench-sim's forward-key workload): at tick 1221 PaulDenton0 (`RunningTo`,
label `Follow`) asks `GetNextWaypoint(orderActor = the player)` →
`ActorReachable` (520) → actorWorker → dispatcher → walkReach. Two
128-unit checkMove steps succeed, the third runs off a ledge (−1), and
FindBestJump launches toward the player at `[-4054, 10052, -256]`: six
jumpLanding ticks fall from Z −256 to −373 into the bay's water zone, where
jumpLanding stops (landed). FindBestJump returns 1 (a 117-unit gain toward
the player, a 117-unit drop, water with bCanSwim); walkReach's water gate
hands off to swimReachable, whose first swimMove (partial hit, up-step,
blocked retry) leaves the water at Z −339; the walking exit fails its
`(MaxStepHeight + Z) + 50 > Dest.Z` margin, so the verdict is **false**.
`GetNextWaypoint` then calls FindPathToward (517) in the same tick →
`PatrolPoint17`, Paul runs there, and at tick 1375 `ActorReachable(player)`
is true without a jump. Island's next boundary is native 708 below.
`pawnNavServices` reads the Region zone's `ZoneGravity`, `ZoneVelocity` and
`ZoneFluidFriction` by name (missing fields throw rather than default) and
hands the `FAILING FBJ` line to the runtime log device as `{text, tag: 'Log',
tagIndex: 0x2f8}` — Core's `FOutputDevice::Logf` (`0x101453e0`) serializes
with name 0x2f8, which Core registers as `Log` (`0x1014cd9d`). This run logs
none. The findPathToward falling-target branch still throws, now naming only
the unported findPathTo worker; once that worker exists, the branch lands the
target through jumpLanding first, as the original does.

The next boundary was tick 1375 (22.92 s): PaulDenton0, `RunningTo`/`Follow`
→ `ScriptedPawn.GetNextVector(orderActor, useLoc)` →
`AIDirectionReachable(Location, rot.Yaw, rot.Pitch, 0, 64, outVect)`, native
708. It is translated and verified since (section "AIDirectionReachable native
708" below); the run now continues to tick 1872.

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
    `−1`, invokes `SafeNormal` + FindBestJump through `0x10303422`. Without either
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
  walk helper then retries via the step-height/FindBestJump alternate path.
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
   (`Physics==2`, the pawn itself not `PHYS_Flying`) lands the target through
   `target->jumpLanding(target.Velocity, Landing = target.Location, 0)` — a
   member call on the target, so its zone, collision and test moves are the
   target's (`services.forActor(target)` in Play) — and returns the
   `findPathTo` worker `0x103dc1d0` toward Landing with this worker's
   bSinglePath, found and bClearPaths (see the findPathTo worker below).
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

Remaining explicit boundaries: falling-target delegation (the `findPathTo`
worker after jumpLanding; a non-receiver test move in Play) stays
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
  (`swimMove`, since 2026-09-29), Physics 1|3 → 1 (walk), 4 → 2 (fly), else
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

Remaining explicit boundaries: the ReachSpec BFS path workers stay unported; bark speech and
audible playback are Stage 4.

## `AIDirectionReachable` native 708 — `execAIDirectionReachable` `0x103c8560`

Recovered 2026-09-29 from the hash-verified Engine.dll before translation
(capstone listing of `0x103c8560..0x103c869e`; the static initializer and
exports below). Declaration, Engine.u `Pawn.uc`:

```text
native(708) final function bool AIDirectionReachable(vector focus, int yaw, int pitch,
                                                     float minDist, float maxDist, out vector bestDest);
```

Binding: the static initializer `0x1037e650` calls Core
`GRegisterNative(0x2c4, &intAPawnexecAIDirectionReachable)`; that member
pointer (`0x1047cad0`) holds thunk `0x103022cf`, the export
`?execAIDirectionReachable@APawn@@QAEXAAUFFrame@@QAX@Z`, which jumps to
`0x103c8560`. The callee is `?AIDirectionReachable@APawn@@QAEHVFVector@@HHMMMPAV2@@Z`
(thunk `0x103011d6` → `0x103c78a0`) — the body this document calls
`aiPickSearch` (band search, 709 section above). So the "band search" is
`int APawn::AIDirectionReachable(FVector focus, INT yaw, INT pitch, FLOAT
minDist, FLOAT maxDist, FLOAT, FVector* bestDest)`, and 709's worker
(`?AIPickRandomDestination@APawn@@…` thunk `0x1030181b` → `0x103c7fc0`) calls
it too. (709's exec thunk is `0x103029b9`,
`?execAIPickRandomDestination@APawn@@…`; `PAWN_NAV_CONTRACT` listed the
worker's thunk `0x1030181b` for it until this recovery.)

The exec (111 instructions, `ret 8`), `thiscall`: `ecx` = the context object
the call is made on, kept in `edi`; stack `(FFrame& Stack, RESULT_DECL)`:

1. Six `P_GET` steps in declaration order. Each reads one byte
   `B = *Stack.Code++` (`+0xc`) and calls `(Stack.Object->*GNatives[B])(Stack,
   &slot)` with `ecx = Stack.Object` (`+8`); `GNatives` is Core's array via
   IAT `0x10599a38`:
   - `focus` → a 12-byte local (`P_GET_VECTOR`, not pre-initialized);
   - `yaw`, `pitch` → int locals zeroed first (`P_GET_INT`);
   - `minDist` → float local zeroed first; `maxDist` → float zeroed first,
     kept in the incoming `Stack` argument slot (`esi` already holds Stack);
   - `bestDest` (`P_GET_VECTOR_REF`): `*GPropAddr = 0` (Core `GPropAddr`, IAT
     `0x10599aa0`), evaluate into a 12-byte temp, then `out = GPropAddr ?
     GPropAddr : &temp`. An lvalue argument (local, out parameter, instance or
     struct member) leaves its storage address in `GPropAddr`, so the body
     writes the caller's variable; any other expression writes the dead temp.
2. `P_FINISH`: `Stack.Code++` without reading the byte (EX_EndFunctionParms).
3. `eax = this->AIDirectionReachable(focus, yaw, pitch, minDist, maxDist,
   15.0f, out)` — `push 0x41700000` is the literal `15.0f`; the callee pops
   `0x24` bytes.
4. `*(DWORD*)Result = eax` (the whole dword, 0 or 1), `ret 8`.

The exec has no receiver class check, null check, GIsEditor gate or float
conversion of its own; `out` is never null. A `final function` on Pawn is
only bound on Pawn contexts by the script compiler, and a None context never
reaches an exec (the VM's context-expression skip). All 17 call sites in the
extracted Core/Engine/Extension/ConSys/DeusEx sources (`ScriptedPawn` 12
including GetNextVector, `CleanerBot` 4, `Animal` 1) call it on `Self`.

The body's arguments are `[ebp+8..0x10]` focus, `+0x14` yaw, `+0x18` pitch,
`+0x1c` minDist, `+0x20` maxDist, `+0x24` the 15.0, `+0x28` bestDest; it ends
with `ret 0x24` on both exits (`0x103c7b83`, `0x103c7de5`). No instruction of
`0x103c78a0..0x103c7de8` addresses `[ebp+0x24]`: the 15.0 is never read, so
its value is unobservable. Its contract (709 section, "Band search") applies
unchanged, with `focus` as the scoring origin: both squared-distance sites
(`0x103c79bf` initial, `0x103c7cc3` in-loop) subtract `focus`, not Location,
so a caller can search the band around another actor (ScriptedPawn's
backpedal passes `orderActor.Location`). On every exit except the mode-0 early
return (Region not water and Physics not 1/3/4: `0x103c7b71`, `eax = 0`, no
restore, no out write) `*bestDest` receives the candidate — the start Location
when none was found — so GetNextVector's `outVect` becomes Location on a
failed search, and keeps its previous value on the mode-0 return.

State reads (body): Location, Velocity, CollisionRadius (`+0x1d4`, stride
clamp 5..25), Region.Zone bWaterZone, Physics, MaxStepHeight, FootRegion.Zone
pain bit/DamageType, ReducedDamageType (`+0x444`), Region.ZoneNumber (the
`+0xd0` byte), GIsEditor, the GMath sine table; the step bodies checkMove/
flyMove/swimMove as documented. State writes: Location only through the test
MoveActor steps and the closing `FarMoveActor(start, test=1, noCheck=1)`;
Velocity restored from its entry value; `*bestDest`; the result dword.

Unresolved or unmodeled: the exec's GNatives evaluation is the VM's (the
oracle scripts it with evaluator stubs that copy constants and, for an lvalue,
set `GPropAddr`); argument expressions with side effects are evaluated in
declaration order by both, which the oracle does not exercise.

### Verification (2026-09-29)

The original cases were captured with `node
scripts/validate-pawn-direction-reach.mjs --original-only` before the
translation existed. `native-pawn-nav-probe.py` runs the real exec
(`aiDirectionReachableExec` `0x103c8560`) from a token stream: its six P_GET
steps call GNatives evaluator stubs (a constant copies its operand; an lvalue
also sets Core GPropAddr, as EX_LocalVariable does), and P_FINISH, the band
search, the result store and `ret 8` run as original machine code. New probe
scene keys preset the result dword (`resultInit`) and a stale GPropAddr
(`gPropAddr`); exec scenes report `codeConsumed`. The collision boundary is the
swimming/jumping corpora's controlled world: scripted MoveActor/FarMoveActor
results, a water plane that Region.Zone follows after each committed move and
that PointRegion answers, and MoveActor's nearly-zero early return.

`scripts/validate-pawn-direction-reach.mjs`: **285/285 original-DLL cases, 0
mismatches** — 45 targeted and 240 seeded generated cases over walking
(Physics 1, and 3 in a dry zone), flying and swimming (Region water with
Physics 1/2/3/4) searches, the mode-0 early return (Physics 0/2/5/6/7),
focus away from Location (approach, backpedal, far side), inverted, negative
and one-point bands, stride clamps, yaw/pitch wrap, ledge retry/stop, the
ZoneNumber, foot-pain, water-entry and iteration-cap stops, the three out
kinds (lvalue, vector constant, EX_Nothing) and a stale GPropAddr. Each case
compares 6459 ordered MoveActor/FarMoveActor/PointRegion calls in all with raw
argument bits, the result dword (preset to `0xa5a5a5a5`), the out vector
(preset to a sentinel), final Location/Velocity bits and Region zone — **both
through `execAiDirectionReachable` and through Play's binding**
(`ScriptRuntime.invokeNative` reached from compiled bytecode `return
AIDirectionReachable(<constants>, BestDest)` with a local out variable). On the
original, every case steps over exactly its six expressions plus the P_FINISH
byte, stores 0 or 1 as the whole result dword, and never writes a stale
GPropAddr target; the editor case fails its `!GIsEditor` assert and the
translation and binding refuse it too. **Instruction coverage: exec 111/111,
band search 405/405, range score 16/16**, excluding the editor-only assert
block `0x103c7977..0x103c798c` (5) and `0x103c7c5c`, the step switch's
default arm, which is unreachable (mode is 1, 2 or 3 inside the loop). 8/8
targeted mutants are detected: yaw/pitch swapped, min/max swapped, Location
instead of focus (exec), an out write on the mode-0 return, the initial score's
origin, the fell-back-into-band stop, and in the binding the out argument
passed by value and a min/max argument shift. The translation matched all 285
cases on its first comparison.

Play: `invokeNative` index 708 evaluates the six arguments in order, passes
`bestDest`'s reference and returns a boolean; there is no receiver check
because the exec has none. In unbypassed Island Play
(`scripts/validate-island-jump-reach.mjs`, bench-sim's forward-key workload)
PaulDenton0's tick-1375 `GetNextVector` (after `ActorReachable(player)` is
true) now finds a step (8 test moves, verdict true), and every one of its
eight GetNextVector calls through tick 1810 returns true. Each writes
GetNextVector's `outVect` through its reference: a point 60.00 units from
Location toward the player (three strides; the fourth leaves the 64 band),
which `MoveTo(useLoc)` follows. Paul follows the player until the next
boundary at tick 1872.

Next boundary (not navigation, not implemented): tick 1872 (31.20 s). With
Paul at `[-3899, 10143, -256]`, about 180 units from the player (held at
`[-4054, 10052, -256]` by the forward-walk workload), the conversation
`MeetPaul` (`Conversation115`, owner `PaulDenton`, invoke actor PaulDenton0,
`bFirstPerson=False`) starts through `ConPlay0.StartConversation`: ConPlayBase's
`BindEvents` (2052) runs, then the third-person branch calls
`con.CreateConCamera()`, ConSys native 2051, reported by `script-doors.mjs` as
`Unsupported original door native 2051 in conplay.startconversation`. The
invoking frames above ConPlay were not captured; by source the pawn-side radius
invoker is `ScriptedPawn.Tick` → `DeusExPlayer.StartConversation(Self,
IM_Radius)`. See [roadmap](roadmap.md) for the research note.

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
  Swimming `0x103c15a0` is covered by the swimming corpus. Jump arc
  `0x103c2f50` (FindBestJump) is covered by the jumping corpus, including
  walkReach's −1 path.
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
  (jumpLanding on the target, then `findPathTo`) remains an explicit
  unported service.
- `swimMove` `0x103c3ca0` and `swimReachable` `0x103c15a0` — **ported to
  JS**, called by aiPickSearch mode 3, the dispatcher, flyReachable and
  walkReach, with **360/360 original-DLL cases, 9/9 mutants and every
  instruction of both bodies executed** in
  `scripts/validate-pawn-swimming-reach.mjs` (see the swimming contract).
- `FindBestJump` `0x103c2f50`, `SuggestJumpVelocity` `0x103c2c80` and
  `jumpLanding` `0x103c2530` — **ported to JS**, called by walkReach's −1
  path in Play, with **363/363 original-DLL cases, 23/23 mutants and every
  instruction of the three bodies executed** in
  `scripts/validate-pawn-jump-reach.mjs` (see the jumping contract).
- `AIDirectionReachable` exec `0x103c8560` (native 708) over the band search
  `0x103c78a0` — **ported to JS and dispatched live**, with **285/285
  original-DLL cases through both the translated exec and the VM binding,
  8/8 mutants, and every reachable instruction of the exec (111/111), the
  band search (405/405) and the range score (16/16) executed** in
  `scripts/validate-pawn-direction-reach.mjs`.
- The findPathTo worker `0x103dc1d0` (FindPathTo 518's worker and the
  findPathToward falling-target delegation) — **ported to JS** as
  `pathToWorker` and live through 517's delegation, with 16 original-DLL
  scenes (13 direct, the delegation through `pathTowardWorker` with a
  PHYS_Falling Pawn target, a LevelInfo-subclass Actors(0)), 4 mutants, and
  every instruction of the body but the two inlined `check()` failure paths
  (347/363) plus the toward worker's delegation block executed. The 518
  exec (`0x103bc800`) and `FindRandomDest` (`0x103da050`/`0x103dc700`) are
  not wired.
- `FindRandomDest` shares the ReachSpec BFS machinery
  (`0x103da050`/`0x103dc700`) recovered at the field level — see the graph
  layout above.
- `FindStairRotation` (524) is inline fp using the `GMath` sine table
  (`0x103fxxxx` via Core's `FVector::Rotation`) — integer math, no
  transcendentals; the Unicorn oracle is authoritative for it.

### findPathTo worker `0x103dc1d0` (2026-10-02)

`thiscall(pawn; FVector point, int bSinglePath, ANavigationPoint** found,
int bClearPaths)`, `ret 0x18`. It is the toward worker's first pass with a
point for the target and nothing pre-seeded:

1. `*found = 0`; `check(XLevel->Actors(0))` and `check(Actors(0)->IsA(
   ALevelInfo))` (inlined Super-chain walk, `appFailAssert` on failure);
   no `LevelInfo+0x548` nav list or an empty ReachSpec table → 0.
2. Save `Location`; `scoutA(listP, pawn, point, listT, bClearPaths, &anchor
   [ebp-0x14], &seeded [ebp-0x18])` with both flags 0; an empty pawn-side
   or point-side list → 0 (no restore).
3. Without the MoveTarget anchor, `scoutB(listP)`; its failure restores
   (`FarMoveActor(Location, 1, 1)`) and returns 0, and it may set the anchor.
4. With the anchor, `scoutC(listP, point)` → `*found = listP.items[0]`,
   restore, 1; otherwise `scoutD(listP)` marks the head's outbound ends.
5. Point-anchor scan over listT: `FastLineCheck(item.Location, point)`,
   `FarMoveActor(pawn, item.Location, 1, 0)`, `pointReachable` worker with
   arg 1; the first success makes it `listT.items[0]` with
   `keys[0] = ftol(sqrt(double(keys[i])))` (msvcrt `sqrt`, as the toward
   worker). No success → restore, 0: unlike the toward worker there is no
   bHunting fallback and no second pass (mutant `fto-hunting-fallback`).
6. `items[0].visitedWeight = keys[0]`; `BFS(items[0], &out, bSinglePath,
   reachMask)`; failure → restore, 0. Success → `*found = out`, restore,
   and `scoutE(listP, found)` when neither the anchor nor bSinglePath is set;
   return 1.

The FastLineCheck operand order is the toward worker's (same push order at
`0x103dc3e6` and `0x103db749`).

Oracle fixes found on the way (`native-pawn-nav-probe.py`): the PointRegion,
FastLineCheck and SpecialCost record stubs were written in place over their
incremental-link thunks and ran over the following thunks (PointRegion's
reached PickWallAdjust `0x10303968` and this worker's `0x10303972`); they now
live in the probe heap behind a 5-byte `jmp`. The Core `UObject::IsA` stub had
wrong relative jumps (only an immediate class match worked; a Super-chain step
or a mismatch landed mid-instruction) and also overwrote the next six Core
thunks; it is re-encoded and deployed the same way. `validate-pawn-nav.mjs`
compared the probe's `flags318` through a field the probe never emitted (so
the original side was always 0); it now reads `pawn.flags318`. All five
validators that use the probe pass unchanged after the fixes.

Focused checkpoint (2026-10-02): `validate-pawn-nav.mjs` 156/156 scenes,
39/39 mutants, findPathTo coverage 347/363 (16 `check()` failure-path
instructions excluded); `validate-pawn-jump-reach.mjs` 437/437 cases (74
EAdjustJump execs, also through the runtime binding), 23/23 mutants, full
coverage including `eAdjustJump` 35/35; direction, swimming and flying
reach unchanged; `npm test` 595/595; bench-sim digests unchanged (Training
`7de779f65538b9f3`, Island `d8c40ff82e415ca6`).

Focused checkpoint (2026-09-29, supersedes the earlier notes):
`validate-pawn-nav.mjs` passes 140/140 cases and 35/35 mutants, including
15 original comparisons through VM/runtime dispatch;
`validate-pawn-flying-reach.mjs` passes 30/30 cases and 6/6 mutants;
`validate-pawn-swimming-reach.mjs` passes 360/360 cases, 9/9 mutants and full
instruction coverage of swimMove/swimReachable;
`validate-pawn-jump-reach.mjs` passes 363/363 cases, 23/23 mutants and full
instruction coverage of FindBestJump/SuggestJumpVelocity/jumpLanding;
`validate-pawn-direction-reach.mjs` passes 285/285 cases (exec and VM
binding), 8/8 mutants and full reachable coverage of the 708 exec and band
search; `npm test` passes 552/552. Natives 708, 709 and 517 are live — the
Training MIB wanders, `Secretary0` follows the PatrolPoint4↔PatrolPoint5 route
(`validate-mib-startup-boundary.mjs`, `validate-secretary-patrol.mjs`), and
Island's PaulDenton0 follows the player through GetNextVector
(`validate-island-jump-reach.mjs`). Stage 3 remains unfinished. Remaining
navigation implementation includes the ReachSpec path workers
`FindRandomDest`/`FindPathTo`.
