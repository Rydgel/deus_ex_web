# Original UModel extent sweeps

Extent translation delivered for integration. Authority is local hash-verified GOTY
Engine.dll/Core.dll execution, with authored compiled node/LeafHulls data.

Before translation: `UModel.LineCheck103f3f6e` initializes time2 and constructs
FBoxLineCheck via103f18e0. Full start/end copies at+590/+584 are never clipped
while traversing103f42f0. Branches use1.1 extent padding (X retains x87 product,
Y/Z float stores), normal signed support, movement ordering, and CSG mask0x21.
ExtraNodeFlags is stored but extent traversal's IsCsg calls pass zero.

Solid leaf collisionBound references up to64 planes; bit30 reverses a plane.
Owner planes use Core.TransformPlaneByOrtho1011a000, then reversal. Initial
entry=-1, exit=current hit.time. PlaneDot and support have float32 stores before
clipping. Shallow overlap entering toward a plane clamps numerator to zero;
entry/exit use denominator thresholds+/-1e-5 (double constants).

World supplemental bounds are Z-/Z+/X-/X+/Y-/Y+ with offsets+0.1 for negative
normals and positiveZ, -0.1 for positiveX/Y; owner path skips these.
Plane pair bevels use opposite signed-axis masks, projected cross products dot
strictly greater than0.001, original two-plane intersection103f6600, axis-cross
intersection direction UnsafeNormal, plane through intersection point, then
clip helper103f5b80. These are not the prototype's arbitrary plane combinations.

Successful leaf entry must exceed-1, be below exit, and exit exceed0. Time and
normal replace prior hit; final LineCheck backs off max(float32(.1),float32(.1)
/float32(traceLength)), clamps0..1, stores time then float32 delta*time followed
by float32 start+offset. Point recovery is a distinct routine and out of scope.

## API and verified scope

`traceExtent(model,start,end,extent,ownerCoords=null)` returns null for clear,
otherwise `{time,normal,location,node,penetrating}`. Inputs use Unreal coordinates
and float32 endpoint/extent values; passing original ABrush.ToWorld coordinates
selects the owner branch. `node` identifies the winning solid leaf's parent BSP
node, captured through diagnostic instrumentation; it is not the original
FCheckResult.Item (the native extent path does not write an item index).
`penetrating` reports raw entry<=0 for caller convenience.

Once Play has loaded the Rust trace kernel ([Rust core](rust-core.md) step
R3-a), `traceExtent` runs its transcription in `native/script-vm/src/trace.rs`.
The JavaScript body (`traceExtentJs`) stays the reference and answers every case
the kernel hands back. `validate-native-extents` loads the kernel.

World and owner traversal use full endpoints and visit the near branch first.
No normalized-plane substitution is made. Supplemental bounds keep their double
0.1 constants before the float store, while final backoff uses float32(.1).
Plane clipping retains unrounded numerator/time comparisons and stores accepted
entry/exit times to float32. Earlier nonpositive entry prevents later leaf updates
through exit=current hit time. Pair bevels retain original pair/axis order and
separate intersection point, normalized direction and cross/UnsafeNormal stages.

The direct corpus has3,420 cases and2,812 hits, all exactly matching original
hit/miss, time, normal and location, including signed zero. It covers444 world
cases (standing/crouched, .9/1/1.1 extents, floor/overlap/short/diagonal traces,
authored oblique planes),2,376 cases across44 real Training/Liberty movers at
closed/mid/open, and600 controlled oblique/scaled transforms of an original mover
model. The latter are controlled routine inputs, not claims about authored keys.
Original helper diagnostics on a controlled rotated box record four bevels and
the winning normal[1,-0,0], time0.558578610420227. Five regression tests use a
synthetic compiled box whose reference outputs were captured before the tests.

```sh
node --test test/extent-trace.test.mjs
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-extents.mjs
# Recompare already captured local inputs without rerunning original code:
node scripts/validate-native-extents.mjs --reuse
```

Inputs, native results, comparison reports and original model data remain in
ignored `reports/movement/native-extents/`. The oracle executes original code with
original owner transforms, without replacing collision responses. Optional
`diagnostics:true` captures native hull/bevel planes. DLLs must match the base
harness's SHA256 hashes. The native harness's x87 control word is0x037f.

Zero extent uses the separately verified traceRay branch and is rejected here.
Negative extents, malformed/cyclic BSP data, >64-plane hulls and empty solid
models without hit geometry are explicitly unsupported. Original point fitting
and recovery are separate work. The sampled exact comparisons do not establish
every arbitrary mod-map plane/transform, alternate x87 control word or every
possible64-bit x87 rounding edge; JavaScript double intermediates remain where
these samples establish the required float32 outputs. Whole-level actor/query
composition and original walking integration require their separate comparisons.

### Support midpoint correction

The composed Training extent ray200 exposed a support rounding edge, isolated
by executing original UModel.LineCheck directly. Helper `103f6590`–`103f65db`
multiplies the float inputs, takes absolute values, adds Z+Y at x87 precision,
then adds X. Its caller stores the result at `103f4846` before plane clipping.
For the winning plane, Y=`1.0189341149092733e-16` changes the stored support
from the JS double midpoint's `25.51620864868164` to native
`25.516210556030273`. PlaneDot and the stored denominator already matched.

`storedSupport` preserves the two native 64-bit-significand additions when the
ordinary double lands exactly on a float32 midpoint. Products of two float32
inputs are exact in double; away from such a midpoint the discarded low bits
cannot alter the float32 store. The focused authored oblique half-space test was
captured against the original before translation, and returns time
`0.5038346648216248`, location `[7120,-1160,222.47549438476562]`. Capture inputs
and original result are ignored `.cache/primitive/support-{model,cases,original}.json`.
The existing 3,420-case native extent corpus still compares exactly. The actual
Training world query now matches time `0.4293614327907562` and location Z
`215.50384521484375`; the MultiLine and primitive implementations need no change.
