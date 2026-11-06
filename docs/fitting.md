# Original placement research

This records the original routine before replacing the existing placement
prototype. Engine/Core input hashes and local research prerequisites are in
[movement.md](movement.md). Disassembly and reference corpora stay outside Git.

## FindSpot / AdjustSpot contract

`ULevel.FindSpot` starts at Engine.dll VA `0x10398480`; `AdjustSpot` starts at
`0x10398360`. The two trailing integer options are `checkActors` and `checkFirst`.
Landing supplies `(0, 0)`; SpawnActor supplies `(0, 1)` at `0x103951ae`.

- A zero extent performs one SinglePointCheck and succeeds only if its return is
  exactly 1 (`0x103984c9`–`0x103985c5`).
- For a nonzero extent, a nonzero second option enables an initial point check.
  A return of exactly 1 succeeds without changing the supplied location
  (`0x103985c8`–`0x10398686`). A zero second option skips this check.
- Work on a copy of the supplied location. Probe the negative X, Y, Z directions,
  then positive X, Y, Z. Each endpoint uses the location after the preceding
  adjustment. Probe distance and adjustment size are the corresponding extent
  component (`0x1039868f`–`0x103987d9`).
- AdjustSpot requests a zero-extent SingleLineCheck with trace flags 6, null
  source actor, and final option 0. If Hit.Time < 1 (FCOMP + `test ah, 1`: an
  unordered compare, a NaN Time, satisfies it, [NaN in FindSpot](#nan-in-findspot-work-item-15-2026-10-20)),
  adjust location along the hit
  normal by `(1.05 - Hit.Time) * Size` (`0x10398365`–`0x1039842a`). The original
  float stores differ by component: X/Y round after each multiplication, while Z
  retains the intermediate products until the final addition/store.
- After the six axis probes, a point check returning exactly 1 accepts the
  candidate and writes it back (`0x103987d9`–`0x1039887f`). The first option is
  forwarded to the point check; its trace flags are zero and actor is LevelInfo.
- Otherwise probe all eight corners, with X as the outer loop, then Y, then Z,
  each sign from -1 to +1. Endpoints are the current candidate plus signed extent.
  Adjustment size is float32 `sqrt(Extent.SizeSquared()) + 2`, using the original
  unrounded squared sum for the square root (`0x10398884`–`0x10398928`).
- If float32 squared displacement exceeds 1.5 times float32 squared extent
  (FCOMPP + `test ah, 1` at `0x1039896f`: a NaN displacement fails too),
  fail without changing the caller's location. Otherwise accept and write the
  candidate only if the final point check returns exactly 1
  (`0x10398928`–`0x103989f4`).

The zero-extent case also runs in the Rust core (2026-11-06): FarMoveActor of a ParticleProxy (bCollideWorld, CollisionRadius and
CollisionHeight zero) is this one SinglePointCheck, `trace.rs point_clear` over the world model (the moving brush tracker's while it
lives), compared with `point-check.mjs` by `validate-trace-kernel` and, inside the whole CurrentItem loop, by
`validate-particle-items` ([particles](particles.md#the-loop-in-rust-2026-11-06)).

Engine.dll double constants: `0x1042eab0` = 1.05, `0x1042eac0` = 1.5,
`0x1042ead0` = 2. Core's appSqrt entry (`0x101032ba`) jumps to `0x10123290`.

The independent translation in `src/runtime/fitting.mjs` matches 420 original
controlled-query cases exactly, including query arguments/order and adjusted
positions. The existing browser placement prototype still awaits replacement;
its initial point check, arithmetic and filters differ. The first option controls
the actor collision hash in MultiPointCheck (`0x1039acc0`). AdjustSpot's flags 6
select world geometry and movers in SingleLineCheck (`0x1039aed0`), excluding
Pawn/general actor hits. The old prototype incorrectly uses only world rays and
includes actors in every point check.

## Ray path identified before integration

The original zero-extent `UModel.LineCheck` path (`0x103f3c92`–`0x103f3f59`)
calls a separate BSP traversal at `0x103f3560`. It does not clip the extent hulls.
The initial real-map comparison exposed this difference in the old collider.

- Classify both endpoints using float32 plane distances, summed Z + X + Y.
  Both greater than double -0.001 take the front branch; otherwise both less
  than double +0.001 take the back branch. The front test takes precedence.
- A node contributes solid space when it has vertices and no flag in
  `(ExtraNodeFlags & ~0x10) | 0x21` in the same-side branches. Crossing branches
  call IsCsg (`0x103f68b0`), which uses `ExtraNodeFlags | 0x21` and retains bit 0x10.
  Preserve this original difference. Front is outside if the incoming region is
  outside or the node contributes solid space; back requires incoming outside
  and a non-solid node.
- Crossing segments split at the plane using the original float32 vector stores
  and an unrounded division. Visit the start side first, preserving the preceding
  crossing node; if clear, visit the end side with the current node as that boundary.
- A solid leaf reports the segment's current start and preceding crossing node.
  Before any crossing, the boundary defaults to node zero. Therefore a ray starting
  in solid can report the root plane normal rather than a nearby hull face.
  ExtraNodeFlags bit 0x10 can ignore an initial solid region until outside has
  been reached; landing probes use zero extra flags.
- Project the reported position onto the original segment to obtain time, then
  subtract a half-unit backoff and clamp to [0, 1]. Store time as float32 but
  retain its unrounded value for the location calculation. Orient the reported
  normal against the segment; do not normalize the authored plane normal.
- A zero-length ray in solid reaches a masked invalid division. The x87 clamp
  takes its lower branch on either less-than or unordered (`0x103f3db8`), so the
  result is time zero and the original start location, not NaN. Twenty-seven
  original zero-length probes around the same epsilon boundaries capture this
  rule before translation.

Native references for these rules include `0x103f36b3`–`0x103f37d2`,
`0x103f37d2`–`0x103f39e9`, `0x103f3a03`–`0x103f3ab9`, and
`0x103f3d3d`–`0x103f3f59`. Double constants `0x104335b8` / `0x1042ac20`
contain -0.001 / +0.001. The transformation path for owned brushes has separate
native comparisons described below.

## Original comparison results

Run with the local optional research Python environment described in movement.md:

```sh
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-fitting.mjs
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-rays.mjs
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-world-fitting.mjs
```

The world ray translation matches 1,070 direct original cases: 270 one-plane
epsilon/flag/zero-length cases and 400 seeded cases on each of training and Liberty Island.
Hit/miss, time, normal and location agree exactly, including signed zero. World
rays in BspCollider use this traversal. Owned brushes now use its separately
verified owner path described below; synthetic hull-only fixtures remain separate.

Once Play has loaded the Rust trace kernel (`native/script-vm/src/trace.rs`,
[Rust core](rust-core.md) step R3-a), `traceRay` in `ray.mjs` runs the
traversal there. The JavaScript body (`traceRayFast`) stays the reference. It
is the path in unit tests and under `TRACE_KERNEL=js`, and it answers every
case the kernel hands back (inputs it throws on). The ray, brush-ray and
world-fitting validators load the kernel, so the comparisons here run against
it. `validate-trace-kernel` compares both paths on seeded cases from real
levels.

The full original FindSpot → AdjustSpot → level query → UModel chain matches
1,112 cases on training and Liberty Island. All final positions/successes, query
arguments/order, 6,878 ray results and 1,566 point hit/miss decisions agree exactly.
Of the 911 successful placements, 299 adjust the input position. The native level
has no actor collision hash, so this establishes the sampled world-only path,
not actor/mover filtering or point recovery locations. Original level allocation
executes against a bounded GMem arena; the only additional external bridge is a
checked no-op CRT qsort for zero/one result (larger sorts fail).

Reference inputs, hashes, original outputs and comparisons stay in ignored
`reports/movement/native-{fitting,rays,world-fitting}/`. Authored plane bits are
retained across JSON so negative zero is not lost before executing the DLL.

## Owned-brush ray research before translation

The owner path calls ABrush.ToWorld (`0x1030f310`) through actor vtable offset
0x88. Its field accesses establish Location +0x114, Rotation +0x120, PrePivot
+0x180, MainScale +0x32c and PostScale +0x340. The native brush harness executes
that routine and the original Core FGlobalMath constructor, including its
rotation tables, before querying the original model. Python supplies actor fields,
not transformation or hit responses.

Traversal's owner branch (`0x103f3593`–`0x103f36af`) projects the local plane
normal onto the three ToWorld axes and stores those components as float32. It
transforms the ToWorld origin by those axes, then subtracts its dot product with
the projected normal from the authored plane W. This offset remains in x87 until
the endpoint plane distance is stored. The endpoint sum is Z + Y + X, unlike
the world branch's Z + X + Y. Endpoints remain in world coordinates.

On a hit, LineCheck transforms the authored boundary normal by the ToWorld axes
(`0x103f3e39`–`0x103f3ed9`). It returns directly from that branch, without the
world path's normal-facing correction and without normalization. Initial native
captures include identity, location/pivot shifts, quarter rotation and separate
nonuniform main/post scales. The coordinate and owned-ray comparisons described
below now pass; owned-extent/point checks remain pending.

The original corpus now includes 520 one-plane cases covering main/post scaling,
rotation, all six shear axes and zero-length probes, plus 300 cases each for
training Mover16/17 and Liberty Island Mover7/21. Each real brush is sampled at
closed, halfway-open and open key positions. `validate-native-brush-rays.mjs
--capture-only` records these 1,720 original references before translation.
The initial comparison supplied captured native ToWorld coordinates to isolate
the ray algorithm from coordinate-generation errors.

Core TransformVectorBy (`0x10119e40`) and LineCheck's output normal transform
sum X + Y + Z and store each result as float32. The plane projection uses Core's
dot operator (`0x10117710`), which sums Z + Y + X before its caller stores the
component. Preserve the separate arithmetic order for these two operations.

The initial 1,720 owned-ray comparisons matched exactly (366 hits), including
time, normal, location and signed zero, using coordinates captured from the
original. After verifying coordinate generation independently, the same complete
ToWorld → LineCheck corpus also matches exactly from the original actor fields.
This path is now connected to BspCollider and Play's moving brushes. Extent
collision and point recovery remain separate, unverified owner paths.

## Brush coordinates: contract before translation

ABrush.ToWorld follows these operations in order, preserving float32 stores:

1. Copy UnitCoords and subtract Location from its origin.
2. Apply PostScale through Core `0x1011c0a0`.
3. Apply rotation through Core `0x1011ac80`, in yaw, pitch, roll order, with a
   complete coordinate transform/store after each individual rotation.
4. Apply MainScale (inlined in ABrush.ToWorld, with the same scale operation).
5. Subtract the negated PrePivot from the resulting origin.

Each scale first composes a shear coordinate frame: transform the origin as a
point and the three axes as vectors (X + Y + Z sums, float32 result components).
Multiply each axis component by its scale component, and divide each origin
component by its scale component, storing each result. Shear axes 1–6 write the
XY, XZ, YX, YZ, ZX, ZY matrix entries respectively. A zero/unknown shear-axis byte
leaves the identity shear frame. Zero scale is not part of the verified inputs.

ShearSnap uses a float32 input with double comparison thresholds. Below -0.65
add 0.15; above 0.65 subtract 0.15; otherwise below -0.55 use -0.5, above 0.55 use
0.5, below -0.05 add 0.05, above 0.05 subtract 0.05, and otherwise use zero.
Store the shear as float32 in its selected matrix entry. Core's inline sequence
is `0x1011c0b5`–`0x1011c18f`; Engine's helper is `0x1030f240`.

The rotation matrices, expressed as three rows, are:

- Yaw: `[cy, sy, 0]`, `[-sy, cy, 0]`, `[0, 0, 1]`.
- Pitch: `[cp, 0, sp]`, `[0, 1, 0]`, `[-sp, 0, cp]`.
- Roll: `[1, 0, 0]`, `[0, cr, -sr]`, `[0, sr, cr]`.

Sine lookup uses `(angle >> 2) & 0x3fff`; cosine adds 0x4000 to the signed
32-bit angle before the same lookup. Core's original FGlobalMath constructor
(`0x10144130`, loop `0x1014431e`) fills 16,384 float32 entries from appSin of
double `index * 0.0003834951969714103`. That multiplier is stored at Core
`0x10178040`. Do not substitute continuous Euler rotations or combine the three
matrix products: both lose original quantization/store behavior.

`native-coords-oracle.py` captures the full original sine table and coordinates
without browser math. The reference generator includes angle wrap/truncation
boundaries, every shear threshold on all axes in both scale stages, and seeded
combined transforms. Validation must compare every coordinate component and
every sine-table entry exactly before connecting this path to Play.

All 704 coordinate cases and all 16,384 sine-table entries match exactly,
including signed zero. The full table's little-endian float32 SHA-256 is
`9893d14bd21e5c4194832659571b30363ddfb08d468ed662a4b6d5ae172262dc`.

**Entry 8192 is the real x87's, not the oracle's (2026-10-18).** appSin is a bare
`fsin` (thunk `0x101033a0`), and FSIN reduces its operand with a 66-bit pi. At entry
8192 the angle is the double nearest pi, and FSIN returns pi66 - pi =
1.2246063538223773e-16 (float word `0x250d3000`), where a correctly rounded sine
(Math.sin, Python's math.sin and Unicorn's softfloat FSIN, which goes through a host
double) gives 1.2246467991473532e-16 (`0x250d3132`). Two measurements: the
constructor's own sequence (`fild`, `fmul qword [0x10178040]`, `fstp qword`, `fsin`,
`fstp dword`) for all 16,384 entries on the Mac's x87 through Rosetta 2
(`tools/x87-sintable-probe.c` under CrossOver, at precision control 53 and 64: this is
the only entry that differs), and the original's own play (Stage 5 capture `cmb5`:
`Tantalus`'s momentum, `Vector(ViewRotation)` at yaw 32768, gave the Terrorist a
`Velocity.Y` of -3.06962686e-15 that only this entry reproduces; Play had
-3.0697283e-15). The entry is the sine of yaw 32768..32771 and the cosine of
16384..16387, so every rotator at a right angle reads it. `coords.mjs`
(`HARDWARE_SINE_WORDS`) writes the measured word, and the Unicorn oracles write it
over their tables (`native-collision-oracle.py` `HARDWARE_TRIG`: when the
constructor's sine loop ends, and over the probes' own math.sin tables). The table's
SHA-256 is now `b8d756044134efb1bbedbe2b842138d6b8d8dc970ef1a69edd0d03cb07ece10c`.
Unverified: the Linux host's AMD x87 (its captures predate this entry's change).
Node unit tests retain original coordinate captures and that table hash;
`browser-tests/native-math.spec.mjs` verifies the same hash and a combined
transform capture in each browser project. It still expected the softfloat hash until
2026-10-28; it passes in Chromium and Firefox since.

```sh
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-coords.mjs
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-brush-rays.mjs
```

## Next query dependency identified

FindSpot integration still needs the original level actor/mover query selection.
Actor primitive selection (`0x1034c9a0`) chooses Brush at actor +0x178, then Mesh
at +0x174, then the engine's fallback primitive. FCollisionHash.AddActor starts at
`0x103580b0`, ActorLineCheck at `0x10359160`, and the hash constructor at
`0x10357ab0`. AddActor requires bCollideActors (actor +0x1dc bit 0); the constructor
builds three shuffled 16,384-entry hash tables using original random calls. Its
query order and the level's sorting/filtering need to be preserved, including
equal-time hits. Current world-only fitting comparisons deliberately leave that
hash absent. All 25 training movers and 19 Liberty Island movers have both
bCollideActors and bBlockPlayers set in their resolved original defaults/values.

These findings are research inputs for the next translation, not a claim that
the current CollisionWorld arrays reproduce the native hash/filter behavior.

## SingleLineCheck filter: contract before translation

The native entry at `0x1039aed0` calls MultiLineCheck once, then consumes its
existing linked-list order. The filter performs no sorting and does not compare
hit times. A controlled MultiLineCheck boundary will isolate this algorithm;
it cannot establish the collision hash, primitive queries or upstream sort order.

- Forward end/start/extent and the final option unchanged. Enable actor queries
  when `(TraceFlags & 0x17) != 0`. Supply LevelInfo to the world query only when
  bit 4 is set (`0x1039aef9`–`0x1039afc3`). In particular, ZoneInfo bit 8 alone
  does not enable actor queries.
- Skip a hit if its actor is the source actor or any actor in the source's Owner
  chain (`0x1039afd8`–`0x1039afee`). This traversal does not skip descendants.
  `AActor.SetOwner` at `0x10369b70` confirms the Owner field at actor +0x3c.
- Test inherited class membership in this order: LevelInfo (required flag 4),
  Pawn (1), Mover (2), ZoneInfo (8). A recognized class is either accepted or
  skipped immediately; it never falls through to the general actor rule
  (`0x1039aff0`–`0x1039b0b8`). The exported class identities are respectively
  `0x1057bf00`, `0x1058c660`, `0x1058bb58`, `0x1057b018`. Each membership test
  follows actor +0x24 and the class superclass chain at +0x28.
- General actors require flag 0x10. If flag 0x20 is also present, additionally
  require bProjTarget or both bBlockActors and bBlockPlayers. The actor's bits at
  +0x1dc are respectively 0x10, 4 and 8 (`0x1039b0bd`–`0x1039b0db`). This
  extra restriction does not apply to the recognized classes above.
- Copy all 44 bytes of the first accepted FCheckResult and return zero. With
  no accepted result, write only Hit.Time = 1 and Hit.Actor = null, preserving
  the remaining caller fields, and return one (`0x1039b0e4`–`0x1039b139`).

Original reference cases must cover all six low trace bits, class inheritance,
blocking/target combinations, owner relationships, preserved list order,
equal-time hits, and the miss-field contract before the translation is connected
to any level queries. The existing Play prototype still awaits that integration.

The independent translation in `src/runtime/line-filter.mjs` now matches 2,564
controlled original cases exactly: 1,368 accepted results, every result field,
return value and forwarded query argument. The native harness constructs actor
metadata and linked lists, then executes the original class/owner/filter/copy
instructions. Class membership in the browser translation remains an explicit
dependency on the runtime's inherited `isA` query. This does not prove actor
construction, hash ordering, primitive queries or MultiLineCheck sorting.

The original inputs are SHA-256 checked when reusing captures. Reports remain
under ignored `reports/movement/native-line-filter/`; five unit regressions retain
selected reference facts. Reproduce with:

```sh
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-line-filter.mjs --capture-only
node scripts/validate-native-line-filter.mjs --compare-captured
```

## MultiLineCheck and sorting: contract before translation

`ULevel.MultiLineCheck` at `0x1039b220` joins world and actor results before the
filter above. The extracted installation includes the original `MSVCRT.dll`,
SHA-256 `e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210`.
Its qsort at `0x7802543d` can execute together with the engine's comparator at
`0x1039c060`; an invented tie-breaking rule is unnecessary.

- Query the world first when a world actor is supplied, passing null brush owner
  and only the low byte of the final option to UModel.LineCheck. Retain a world
  hit as the first entry and replace its Actor with the supplied LevelInfo.
- For a world hit, let `d` be the distance from start to its reported location.
  Store `factor = min(1, time * (d + 5) / (d + float32(0.0001)))` as float32.
  Shorten the endpoint to `start + factor * (end - start)`. X/Y store each
  difference and scaled difference as float32; Z retains these intermediates
  until the final store (`0x1039b308`–`0x1039b3d1`).
- When the world hit's time is below double 0.01 and `d < 30`, retain only Mover
  hits from the actor list. Otherwise consider the full list. Actor queries run
  only if enabled and a collision hash exists, receive the shortened endpoint,
  and receive the full final option (`0x1039b3d4`–`0x1039b4ed`).
- If a Mover hit has the same normal as the world hit and its location is less
  than two units from the world hit, move its reported location two units back
  from the world hit along the shortened trace direction. Recompute time from
  that new location and the shortened trace length, preserving the native
  float stores (`0x1039b4ed`–`0x1039b69f`). This changes the supplied actor hit.
- Multiply every retained actor hit's time by the stored shortening factor,
  changing the supplied hit, then copy it into the collection. Stop at 64 total
  retained hits, including the world hit (`0x1039b47c`–`0x1039b6c9`).
- Sort the 44-byte results using the original CRT and the engine's ascending
  time comparator, then copy to a contiguous allocation and relink them in that
  order. Equal-time results are not stable (`0x1039b6fe`–`0x1039b7c1`).

The CRT uses a maximum-selection sort for partitions of at most eight entries
(`0x780255e2`); strict greater-than selects a new maximum, and the selected entry
is swapped to the partition's end. Larger partitions move the middle entry to
the beginning, scan forward over values <= pivot and backward over values >=
pivot, swap the crossing candidates until they cross, then move the pivot to
the backward index. It stacks the larger remaining partition and processes the
smaller one first (`0x780254f5`–`0x780255dd`). A browser stable sort would change
ties even on the small partitions.

The controlled reference corpus now passes all 867 original cases, including
11,701 returned hits and 51 nonfinite hit times. It compares original CRT order,
every retained result field, actor-result mutations and forwarded arguments,
including shortening/recovery boundaries, the 64-result limit and equal/mixed
times across the eight-entry cutoff. Nonfinite results from original degenerate
traces are preserved; no clamp or stable-sort tie rule is invented.

The composed implementation now also connects the separately verified hash,
bounds, world/brush and cylinder queries. All 10,980 rays, 7,320 extent queries
and 402 complete placement chains agree with the original on the two fixture
maps; see [level query evidence](level-queries.md). Controlled MultiLine cases
can be reproduced with:

```sh
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-multiline.mjs
```

A composed Training nonzero-extent ray200 initially differed in final actor time
by one float32 step. Direct original probes isolated it to UModel's hull support
float store (`103f4846`, helper `103f6590`): a tiny plane Y component was lost in
JS double arithmetic at an exact float32 midpoint. The extent correction and
native regression are documented in `docs/extent-trace.md`. With native world
inputs, MultiLine's factor is `0.46968314051628113`, shortened endpoint Z is
`220.5037384033203`, and the primitive local time `0.5999542474746704` produces
final time `0.2817884087562561`. MultiLine itself was unchanged.

## NaN in FindSpot (work item 15, 2026-10-20)

Found by `dor3` (Stage 5, [the exit criteria](stage-5-exit-criteria.md) item 15): `DeusExMover.BlowItUp` makes `NumFragments` (16 for
DeusExMover2) attempts, each `Spawn(FragmentClass,,, spawnLoc + FragmentSpread * VRand())`, and SpawnActor refuses the spawn when FindSpot
fails (`0x103951ae`). Play made 15 MetalFragments, the original 14. The CRT rand state at each original `AddObject` against Play's after
each FindSpot (a fragment's start-up costs 7 draws, a non-last fragment's CalcVelocity another 7 or more, a VRand 3 per try) showed the
original 3 draws ahead at its sixth fragment and 3 behind between it and the seventh (gaps 23 and 17 where Play's are 20 and 20): the
VRand of an attempt that made no object. The sixth attempt, at (7713.687, 708.237, -126.479) with extent (6, 6, 0), starts inside the door.

**The original's FindSpot refuses it.** Engine.dll's unchanged FindSpot (`0x10398480`) under Unicorn
(`scripts/native-tracked-fitting-oracle.py`, below) on Play's inputs of all 16 attempts at tick 320 refuses attempts 5 and 12 and fits
the other 14 where Play fitted 15 (attempt 12 was refused by both; attempts 13 and 15 are adjusted by both). The sixth attempt's chain, in
order, with the oracle's own list of calls (an `A` marks a step a Play query reproduces):

1. SinglePointCheck at the start: blocked (a recovery location 4.4 units in +X). A
2. AdjustSpot, probe -X (flags 6): SingleLineCheck -> MultiLineCheck. The world check, `UModel::LineCheck` over the brush tracker's model
   (the door's fragments are its nodes), hits at time 0 with the +X root-facing normal; the hash walks cell (158, 131, 128) and
   `DeusExMover2`'s own brush also hits at time 0, with the same normal and within 2 units, so MultiLineCheck's mover recovery
   (`0x1039b4ed`) divides by a zero-length segment: `1 / 0 = inf`, `inf * 0 =` the x87 default NaN `0xffc00000`, the mover hit's Time
   and Location. The sort keeps the mover first (the comparator is C0 on an unordered Time, `0x1039c060`) and SingleLineCheck returns it.
   A
3. AdjustSpot reads `Hit.Time < 1` with `fld Time; fcomp 1.0; fnstsw ax; test ah, 1; je skip` (`0x103983b3`-`0x103983c1`). An unordered
   compare sets C3, C2 and C0, so it does not skip: the candidate becomes `Location + (1.05 - NaN) * Normal * Size`, a NaN in all three
   components (a NaN times a zero normal component is still a NaN). Play's `time < 1` is false for a NaN, so it skipped the adjustment:
   the first difference. **Fixed.**
4. The other five axis probes run on a NaN start and end. The world check returns a hit at time 0 (the ray traversal ends in its
   solid-at-start case: Item 0, Time 0, Location the NaN start, the root plane's normal; the facing test `fcomp; test ah, 1` is C0 for
   the unordered value, so the Island's root normal `(-1, 0, 0)` comes out as `(1, -0, -0)`); the hash walks the one cell (0, 0, 0) (every bound is `fistp` of a NaN, the integer indefinite
   `0x80000000`, which the clamps take to 0) and finds no actor. SingleLineCheck returns the world hit at time 0, AdjustSpot adjusts a
   NaN by a NaN again. A
5. SinglePointCheck on the NaN candidate with extent (6, 6, 0): `UModel::PointCheck` is blocked (no recovery written: Item -1). The
   traversal (`0x103f19b0`) enters the front child unless `-PushOut >= Dist` and the back child unless `Dist > PushOut`, so a NaN
   distance enters both, and the hull plane loop goes on while `Dist < PushOut` (C0), so every hull test holds: blocked. A
6. The eight corner probes run on NaN. The displacement test, `fcompp` of 1.5 * float32(SizeSquared(Extent)) against float32(SizeSquared
   (displacement)) then `test ah, 1; je continue` (`0x1039896f`-`0x1039897c`), is C0 for a NaN: FindSpot returns 0 without a final point
   check. The caller's location is unchanged. A

So the original's SpawnActor returns None for that attempt before any object exists: no `AddObject`, no start-up, no CalcVelocity, only the
VRand of the next attempt's location, which is the 3 draws. The fragment is never created with a NaN location, so SpawnActor and the
fragment's start-up are not reached on a NaN (they never run on it). After the refusal the original's stream is one attempt ahead of
Play's old one: its 14 fragments are attempts 0-4, 6-12, 14 and 15 (5 and 13 are refused), the positions Play drew at attempts 6 to 14
before the change are the original's 7 to 15 (the old attempt 12's refusal is the original's 13), and its last fragment is attempt 15,
the one that gets no CalcVelocity (7 draws to the next event).

**Play now.** `fitting.mjs` reads `Hit.Time < 1` and the displacement test as the C0 branches (`x87-nan.mjs` `x87C0`), and keeps a NaN through
the Z product. The queries a NaN reaches carry the native branches (each equal to its old comparison for any ordered pair):

| Step | Native | Play |
| --- | --- | --- |
| hash line cells (`0x10359226`-`0x103592f7`) | fistp of a NaN is `0x80000000`; the clamps give 0; one cell (0,0,0) | `collisionHashLineBounds`/`actorLineCheck` accept an all-NaN Start and End only |
| BSP ray facing test (`0x103f3d3d`-`0x103f3f59`) | `fcomp; test ah,1`: C0 on unordered flips the normal | `ray.mjs` `x87C0` and `trace.rs` (the Rust kernel, `validate-trace-kernel`: 79,090 cases, 0 mismatches) |
| point check front/back tests (`0x103f1b30`-`0x103f1bc6`), hull plane loop (`0x103f1e52`-`0x103f1f00`) | C0 / C0 or C3 / `Dist < PushOut` all hold for a NaN | `point-check.mjs` `x87C0`, `x87C0C3`; a NaN coordinate makes the exact plane distance a NaN |
| displacement test, AdjustSpot's Time test | C0 | `fitting.mjs` |

**Unsupported (still throws).** A hash line query with exactly one NaN vector (the hash builds its bounds with `FBox::operator+=`, whose
Min/Max compare form is not translated; the oracle answers the level query: a world hit at time 0 with a NaN location); a box-extent
LineCheck on a NaN (not examined: an oracle run with it did not finish in two minutes); an infinity in any query; a NaN extent. FindSpot reaches none of them: once
the candidate is NaN its Start and End are both all-NaN.

**Evidence.**
`scripts/native-tracked-fitting-oracle.py` extends `native-level-oracle.py` (the original hash, `SetActorCollision`, every collidable actor
with its brush through `ABrush::ToWorld`, `UModel::LineCheck`/`PointCheck`) with the model's nodes replaced by raw 64-byte records (Play's
tracker after `GNewBrushTracker`; the tick-320 block differs from it in 685 nodes' NF_PolyOccluded / NF_BoxOccluded render bits, which the
0x21 collision mask does not read, and gives the same answers) and a call-by-call list (arguments, results and the hash cells as float
words). `scripts/validate-native-findspot-nan.mjs` compares Play with it: dor3's 16 attempts, seeded positions through the door (half of
them meeting a NaN Time), 26 NaN queries at the level (SingleLineCheck/SinglePointCheck with and without the hash), and 160 NaN rays and
points over the static BSP and the tracked model of both maps (`native-tracked-linecheck-oracle.py`). Every success, position, query,
Time, Location, Normal (with the sign of zero), Item and hash cell is equal. `scripts/validate-x87-compare-hardware.mjs` runs the three
compare forms (`fcompl m64`, `fcomps m32`, `fcompp`) and FISTP on real x87 (this Linux host, Wine): 1,900 rows, 903 of them unordered,
all C3|C2|C0, and the FISTP of a NaN, an infinity or an out-of-range value is `0x80000000`. `validate-stage5-live.mjs --scene dor3` passes.

```sh
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-findspot-nan.mjs
node scripts/validate-x87-compare-hardware.mjs
```
