# Original moving-brush collision bounds

Evidence-first trace (Engine.dll SHA256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`):

* `UModel.GetCollisionBoundingBox` at `0x103f0e70` reads the primitive FBox
  at `this+0x28`: minimum XYZ, maximum XYZ, validity byte (`+0x40`).
* Null owner returns that box verbatim (`0x103f10c7`). With an owner,
  `0x103f0ea5` calls virtual slot `+0x88`, which the original ABrush layout
  resolves to **ToWorld**, `0x1030f310`. ToLocal is not called by this path.
* `0x103f0ee5–0x103f1085` visits eight corners in X/Y/Z nested order,
  minimum before maximum. Each corner subtracts the coordinate origin,
  dots each axis, and stores float32 components (`0x103f0f36–0x103f0f9f`).
  The first corner initializes a valid box, subsequent corners expand it with
  strict comparisons. The source validity byte is ignored for owned models.
* There is no padding, sphere, vertex traversal, or hull traversal here.
* `UPrimitive.GetCollisionBoundingBox` at `0x103d8460` uses actor cylinder
  radius/height fields at `+0x1d4/+0x1d8` plus the float at `0x10429c50`,
  centered on actor Location. Null owner copies the same primitive FBox.

Before implementing the translation, `scripts/native-bounds-oracle.py`
executes these original instructions on authored boxes and decoded map boxes.
It inherits the hash-gated Core GMath constructor and real ABrush.ToWorld
oracle. Native captures and original map data remain in ignored `reports/`.
The exact corpus and comparison results will be recorded after capture.

Unsupported scope: nonfinite and zero brush scales remain explicitly rejected
by the existing ToWorld helper; this research does not claim ToLocal support.

## Captured reference and translation

Capture-only run preceded the JavaScript implementation. The subsequent exact
comparison passes **377/377 cases** against the original functions:

* 8 combinations of model/primitive, owned/unowned, valid/invalid source box.
* 189 asymmetric-box cases: all six shear axes plus none, nine signed shear
  rates around the snap thresholds, identity/quarter-turn/non-cardinal rotation,
  nonuniform MainScale/PostScale and a reflected scale.
* 48 generic primitive cases covering zero, fractional and large locations and
  zero/fractional cylinder sizes. The original padding constant is **1.0**.
* 132 map cases: every one of the **25 Training** and **19 Liberty Island**
  movers, at authored key-zero, halfway to key-one, and key-one transforms.
  Inputs apply KeyPos/KeyRot offsets to each actor's resolved Location/Rotation.
  These are controlled native geometry calls, not a claim that the complete
  original mover interpolation/state machine has been reproduced.

Map SHA256 identities:

* `00_Training`: `bb66d95aafc6aae4179f8444e98661f3d5d27dab06d13d7dde7f4b5f4e24068d`
* `01_NYC_UNATCOIsland`: `1297fbbf0e7fc970337b2b58fffa500e429dd6f3a677bd8eec9b900f6c9ae04c`

The first translation exposed 35 one-float-ULP differences in the constructed
quarter-turn/scale cases. At a float32 midpoint, the tiny nonzero original sine
component survives native x87 arithmetic but disappears after JavaScript double
rounding. The final corner calculation represents binary significands directly,
rounds each native arithmetic operation to the oracle's 64-bit x87 significand,
then rounds the float store to 24 bits. This matches all captured extrema exactly;
it does not replace the existing independently verified ToWorld helper.

The UPrimitive path also keeps radius+1 unrounded for the Y coordinates because
`0x103d847b` stores without popping that x87 intermediate; X and Z reload their
stored float extents. This distinction is retained in the implementation.

Runtime entry points in `src/runtime/brush-bounds.mjs`:

* `brushCollisionBounds(model, owner = null)` returns `{min, max, valid}`.
* `primitiveCollisionBounds(model, owner = null)` returns the same shape.

`model.bounds` is the existing decoded primitive FBox. `owner` is the actor's
resolved property-value object. No renderer transform or reconstructed hull
bounds participate. Null-owner calls copy the source validity. Owned calls return
valid true, as the original does even for an invalid source box.

Reproduce locally:

```sh
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-bounds.mjs --capture-only
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-bounds.mjs
node --test test/brush-bounds.test.mjs
```

The five regression tests pass. Raw captures, cases, map hashes and comparisons
are in ignored `reports/movement/native-bounds/`. The comparison is exact,
including signed zeros emitted by the captured native outputs. Artificial
nonfinite/overflow/subnormal-bound inputs and all possible x87 control-word
settings are outside this corpus; the oracle uses the existing harness control
word `0x037f`. No ToLocal implementation or claim was needed for these bounds.

Update 2026-10-22: with the trace kernel loaded (Play, and any host that calls `loadTraceKernel`), an owned brush's box is computed by the Rust twin
`native/script-vm/src/bounds.rs`; `brushCollisionBounds` falls back to this JavaScript body (`brushCollisionBoundsReference`) for the cases the twin hands back.
The native comparison above runs with either answering (`validate-native-bounds`: 377 cases, 0 mismatches each way); [rotating-brushes](rotating-brushes.md) "Cost" has the corpus and the A/B.

