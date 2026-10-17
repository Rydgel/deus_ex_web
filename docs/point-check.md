# Original world PointCheck boolean

Research before translation: Engine103f1570 initializes hit fields and, for
nonzero extent, calls FPointCheck103f19b0 with fixed position at checker+584,
closest recovery distance100000. Traversal scales all extent components by
float32(1.1) with float32 stores, stores support and distance, visits front when
distance> -support, back when distance<=support. CSG tests use flags|0x21.

Solid leaf planes and sign reversal follow compiled collisionBound/LeafHulls,
with64-plane cap. Float32 PlaneDot and support are compared with strict '<':
distance>=support rejects the hull. World supplemental bounds use the same
Z-/Z+/X-/X+/Y-/Y+ asymmetry as extent sweeps. Bevel construction is the already
traced original two-plane-intersection path, but PointCheck's bevel helper
103f3050 retains support/distance in x87 until comparison (unlike stored hull
face distances). Recovery writes result location and nearest distance; it does
not change fixed checker+584 input position or the all-plane boolean test.
Boolean-only translation can therefore stop after the first intersecting solid
leaf without implementing recovery outputs. Recovery outputs remain unsupported.

Zero extent follows separate BSP classification at103f16c5: strict positive
distance chooses front, otherwise back; CSG mask0x21. Empty models return
rootOutside. This module will initially cover world-owned null-owner checks only.

## Delivered API and verification

`pointCheck(model, position, extent=[0,0,0], extraNodeFlags=0)` from
`src/runtime/point-check.mjs` returns **true for clear/outside**, false for overlap.
The input is the decoded compiled world model (`nodes`, `leafHulls`,
`rootOutside`); vector arguments are stored as float32. Negative extents and
malformed/cyclic hulls fail explicitly. Owned brush coordinates and recovery
location/normal/Item are not part of this API. Zero-extent checks ignore extra
node flags, as the original separate branch does.

Original captures preceded implementation. The checked DLL hashes are recorded
by `native-point-oracle.py` and are the same Engine/Core pair documented for
extent sweeps. It calls original UModel.PointCheck directly with a null owner;
no point responses or hull math are replaced in the oracle.

`node scripts/validate-native-points.mjs` captures and compares 1,386 world
positions: 724 Training (425 overlaps) and 662 Liberty Island (138 overlaps).
All booleans match exactly. This includes 12 unique original point inputs from
11 composed FindSpot divergences, existing original fitting event positions,
and the world extent corpus start positions. The regression cases are retained
in ignored reports when the composed comparison becomes clean. `--capture-only`
records original results without importing the implementation; `--reuse` compares
against the saved cases and original responses. Reports live under
`reports/movement/native-points/`. These commands require the original maps and
the prior native-level, native-world-fitting and native-extents captures.

`node --test test/point-check.test.mjs` passes three tests, including controlled
compiled-box cases separately captured through the original before writing the
assertions. With bounds +/-10 and pawn extent [20,20,43], X=29.9 is clear while
X=29.89999 overlaps; X=-30 is clear while X=-29.999 overlaps; Z=53 is clear while
Z=52.999 overlaps. A zero-extent point at X=10 follows the back branch and is
solid; X=10.00001 is outside. These cases distinguish the original strict plane
comparison and supplemental positive-X shrink from a generic AABB overlap.

This is scoped boolean evidence, not verification of original recovery outputs
or every possible x87 rounding boundary. Face stores and retained bevel
expressions follow the traced native instructions; JavaScript intermediates have
not been proven equivalent to x87 for arbitrary pathological float inputs.

Full nonzero-extent world/owned recovery is now exposed separately as
`modelPointCheck`; its ordered recovery behavior and composed actor point-query
captures are documented in [level-points.md](level-points.md). The original
`pointCheck` signature above remains a world-only boolean API.

## Owned zero-extent descent (2026-10-17)

Found by the Stage 5 census: a Tracer (zero extent) in a mover's bounds while the Liberty Island front doors opened stopped Play with
"Owned zero-extent PointCheck is not yet verified" (`moveTranslatingMover` -> `checkMoverEncroachment` -> `actorEncroachmentCheck` -> `modelPointCheck`
with the mover's coordinates). The owned zero-extent descent was the one `UModel.PointCheck` (Engine.dll 0x103f1570) path never recovered.

Original, 0x103f16c5-0x103f17ee (disassembled with `tools/disasm-body.py`; the imports are Core `FVector::TransformVectorBy` 0x10119e40 and
`FVector::operator|` 0x10117710):

* The branch runs when all three extent components compare equal to 0.0 (`fcomp` against the float 0 at 0x10426d54). With an owner it calls the owner's
  vtable +0x88 (the owner's `ToWorld` coordinates: 12 floats, origin then the X, Y, Z axes); without one it copies `GMath.UnitCoords`. The coordinates are
  copied to the frame (rep movsd of 12 dwords).
* Each node plane is carried before the point is tested: `N'` = (X.n, Y.n, Z.n), each summed `((a.y*n.y + a.x*n.x) + a.z*n.z)` in x87 and stored as float32
  (0x103f16f8-0x103f1752); `T` = `Origin.TransformVectorBy(coords)`, each component `((o.x*a.x + o.y*a.y) + o.z*a.z)` stored as float32 (Core, `fstp dword`);
  `D` = `T | N'` = `((T.z*N'.z + T.y*N'.y) + T.x*N'.x)` which Core returns in st0 (no float store); `W'` = `plane.W - D` stays in x87.
* The point is in front when `((N'.z*p.z + N'.y*p.y) + N'.x*p.x) - W' > 0` (0x103f1783-0x103f178d: `fsub st(1)`, `fcomp` with double 0.0 at 0x10429838,
  `test ah,0x41`), else behind. The inside/outside bit then changes exactly as the world branch (front: `outside ||= solid`, back: `outside &&= !solid`, solid =
  `NumVertices > 0 && !(flags & 0x21)`) and the walk follows `iBack` (node+0x20) or `iFront` (node+0x24).
* The only write is at the end: `Result.Item = side + 2 * lastNode` (side 1 front, 0 back, 0x103f17e5-0x103f17eb). Location stays the input, Normal 0, Time 0;
  an empty model returns `RootOutside` before any write (Item stays -1).

`src/runtime/point-check.mjs` follows it: `ownedZeroExtentPlanes(ownerCoords, position)` does the sums with the exact x87 helpers of the file (`wide`, `sum` at 64-bit
mantissa, `store32` for the three float32 stores), `modelPointCheck` records the Item for the world and owned zero-extent branches. The world branch's double
expression (validated above, 1,386 cases) is unchanged: with the identity coordinates the original's expression reduces to it.

`node scripts/validate-native-owned-point.mjs` (`--capture-only`, `--reuse`, `--cases N`, `--map`) calls the original `UModel.PointCheck` through the level-points
oracle (`native-level-points-oracle.py`, the world model and every mover brush of Training and Liberty Island) and compares `{outside, location, normal, time, item}`
exactly: random points around each mover brush at its base pose, its two authored poses (`reports/movement/native-bounds`) and two rotated and shifted poses,
points on a transformed node plane and 1 and 2 float32 steps either side of it, and world-model points near node planes. The default corpus is 10,688 cases;
the 24-per-actor corpus (32,064 cases: 18,192 Training and 13,872 Island, 11,633 and 9,606 clear) matched with no mismatch. Native binaries and reports stay
ignored. Not covered: a non-float32 coordinate (the engine's coordinates are float32), and the game thread's real x87 precision control (the oracle's x87
rounds the sums to the 64-bit mantissa, as the recovered recovery arithmetic of `planeDistance` does).
