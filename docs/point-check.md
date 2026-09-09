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
