# Original level point queries: contract before translation

Original ULevel.MultiPointCheck1039acc0 queries ActorPointCheck103585b0 first
when checkActors is nonzero and a hash exists; it then queries the world model
if WorldActor is nonnull and prepends any world hit. Both actor and world model
PointCheck calls use extra flags zero. There is no line-query class/blocking
filter at this layer. ActorPointCheck checks cell tag and actor dedup tag,
selects Brush/Mesh/fallback primitive, and prepends each overlapping result.

SinglePointCheck1039aac0 returns true without touching caller result on an empty
list. Otherwise copy all44bytes of first hit and scan remaining list, replacing
with a strictly shorter recovery-distance result; equal distances keep the
first list result. Closest-distance arithmetic stores current best Z difference
as float32 while retaining other differences/products in x87.

UModel.PointCheck103f1570 initializes Primitive to model, Actor to owner, Time0,
Normal0 and Location to input, preserving initial Item. Nonzero extents traverse
as documented for point-check.md. Recovery considers positive plane distances
strictly smaller than the stored nearest distance (initial100000), and only
inside support. It updates result even in leaves later rejected by another
plane. Therefore boolean short-circuit and per-leaf-only recovery cannot recover
original output. Full traversal and ordered face/bounds/bevel writes are needed.
Hull face Item is the referenced hull-plane node index (bit30 cleared), supplemental/bevel Item=-1. Owner
planes use original ToWorld and skip supplemental world bounds, as extent sweeps.

Native captures use scripts/native-level-points-oracle.py extending the original
full-level harness. It records direct owned/world model outputs, ordered complete
MultiPoint lists, and SinglePoint chosen result before any translation changes.
Initial capture and translation comparison pass1,650 model outputs and3,660 level queries; final transformed-pose corpus is recorded below.

## API

`modelPointCheck(model,position,extent,ownerCoords=null,extraNodeFlags=0)` returns
`{outside,location,normal,time,item}`. Owner coordinates are original
`brushToWorld(owner)`. It initializes Item to -1; caller-specific preserved
sentinel fields are not an input contract. Primitive identity and actor identity
are supplied by the level wrapper. It preserves writes on clear model queries.
Ordinary `pointCheck` remains the world boolean API and retains its original
1,386-case comparison; it need not execute recovery writes.

`createLevelPoints(model,hash,levelInfo)` requires the **same live hash** used by
line queries, so Remove/Add ordering is shared. It returns:

- `multiPointCheck(position,extent,flags=0,worldActor=levelInfo,checkActors=1)`:
  ordered array of overlap hits, each with actor and primitive object identity.
- `singlePointCheck(...)`: `{outside,hit}`; hit is null on a miss. Unlike native
  caller-memory semantics, this functional API does not mutate an existing
  result object when clear. Callers preserving a result buffer must do so.

`hash.actorPointCheck({position,extent}, primitivePointCheck)` shares the exact
cell expansion and query order of a stationary hash line query. Original
ActorPoint103585cb–1035871c matches that X-retained/YZ-stored expansion; both
narrowphase extra flags and the PointCheck argument are zero at10358809. Flags
are accepted by the level API for signature parity but do not enable filtering.
All actor collisions are returned, including nonblocking actors; a caller that
needs blocking/ownership policy must apply its separately evidenced policy.

Face recovery uses original float32(1.02) normal multiplication, float32
(support-distance), then vector multiply/store and addition/store at
103f1e65–103f1ebd, Core101177c0/10117740 and Engine103d7cb0. Bevel helper103f3120
retains its X product through the position addition but stores Y/Z intermediate
products. Recovery nearest distance is shared across traversal, including
rejected leaves. The direct captures compare clear-query writes as well as hits.

## Bounded native validation

`node scripts/validate-native-level-points.mjs --capture-only` captures original
results before comparing. `--reuse` checks saved scene/case SHA256 and compares
all fields, including signed zero, exact hit-list order and SinglePoint choice.
The validator restores original planeBits to its runtime scene after JSON
parsing, matching the oracle's original binary plane input. This is necessary
for negative-zero normals. Native binaries and reports stay ignored.

`node --test test/level-points.test.mjs` retains controlled original recovery and
ordering examples. An X=29.9 point against a +/-10 compiled box with extent
[20,20,43] is clear but still returns recovery X=30.00200080871582, normal[1,0,0]
and Item1. Two cylinders equidistant from a point return registration order;
SinglePoint keeps the first on the distance tie. Re-registration changes that
choice through the shared hash ordering.

Owned zero extents are explicitly unsupported pending the separate original
zero-extent transformed-plane path. World zero-extent classification is supported;
its initialized zero normal/time and input-location behavior follows the original entry.
The required upright pawn extents and owner transforms are the verified scope,
not arbitrary x87 edge inputs, malformed hulls, dynamic recursive queries or
complete actor lifecycle/event parity.

Final expanded capture: **2,178 direct model checks and3,756 level queries,
zero mismatches**. Training contributes1,174/768 and Liberty1,004/2,988.
The792 owned-model checks cover all44 original movers at closed,halfway,open
poses with standing[20,20,43],crouched[20,20,16] and1.1-sized fitting extents.
The remaining1,386 direct models are the earlier original world-point corpus.
Level cases query actor-boundary positions plus actor-only/world-only flag
variations, comparing complete lists and the closest chosen recovery. Actual
half/open poses come from the previously captured native-bounds corpus rather
than extrapolated missing keys in the reduced level scene. The existing hash
native validator and12 point/hash unit tests also pass after adding PointCheck.
