# Measured mesh kernel boundary

The September 20 Training profile (seed 1, 14 meshes, 30 warmup and 120
measured frames at 1/60 second) attributes 13.55 ms/frame to mesh posing and
7.42 ms to simulation. The browser CPU profile also puts GetFrame's BigInt
x87 arithmetic at the top. This is a measured reason for one Rust/Wasm
kernel; it is not evidence for porting the script VM or changing tick rates.
Raw profiles remain in `.cache/perf/wasm-baseline.cpuprofile` and
`.cache/perf/browser-wasm-baseline.cpuprofile`, outside Git.

## Original contract, before the port

The authority and complete contract are in [GetFrame](script-lodmesh-frame.md).
The hash-checked original Engine.dll body `10355360..103568e5`, with Core
coordinate helpers, already has 46 complete captured reference calls. Reuse
those exact input specs and compare every output/cache byte, padding, cache
event, lock, count and archive position before enabling the kernel in Play.

Only the repeated vertex loops cross into Wasm. JavaScript retains lazy Load,
sequence lookup, owner selection, matrix construction, cache identity/leases,
negative-frame tween decisions/completion and the four-slot call order.

* Source vertices are three signed i16 components in an eight-byte record.
* Normal interpolation stores local pose in the existing f32 cache. X keeps
  its subtraction and product on the stack, Y/Z store each to f32 first; at
  the render pass's 24-bit precision both are the same binary32 operations
  (see "Precision control 24" below).
* Tween interpolation uses the existing cached pose and the target frame.
  Zero alpha keeps the cache unchanged. Completion/count expansion stays in JS.
* Main publication subtracts mesh origin with f32 stores, then coordinate
  origin without an intermediate store, and computes `(x*a + y*b) + z*c`.
* Each blend subtracts absolute frame zero with f32 stores, transforms without
  coordinate origin, adds to existing output and stores f32 in slot order.
* The caller's stride/padding and untouched vertices must survive. Actor state
  remains read-only. No mesh detail or animation cadence changes.

Wasm exposes f32/f64 rather than the original x87 format
([WebAssembly numeric types](https://webassembly.org/docs/portability/)). The
kernel was first written for 64-bit registers, which needed integer software
arithmetic retaining a 64-bit significand. GetFrame runs inside the render
pass, under precision control 24 (since 2026-10-06, "Precision control 24"
below), where one binary32 operation per x87 operation is exact. Integer ABI arguments and
linear-memory buffers avoid per-operation JS/Wasm calls and NaN conversion.

Existing unsupported GetFrame branches and native heap/exception services
remain as documented in the original contract. Arithmetic differential tests
check the new language boundary; only the original captures establish native
agreement for their covered behavior.

## September 28 mesh-lighting extension

Stage 4 made the same actor layer expensive for a different measured reason.
On `01_NYC_UNATCOIsland`, with simulation held to avoid the map's existing
unsupported `waterMove`/door-native boundaries, 291 admitted actor meshes
contained 47,063 faces and the 220 actors in the view submitted about 33,238
faces to mesh lighting. Disabling only mesh lighting changed the mean frame
interval from 36.08 ms to 16.63 ms and reduced the actor update from 21.58 ms
to 2.42 ms. This is the evidence for extending the kernel; the sky comparison
changed only ten draw calls and did not improve the frame.

The added bulk operation translates the already recovered DrawLodMesh contract
in [mesh lighting](mesh-lighting.md). It performs the camera transform (skipped with
`cameraSpace`, for the camera-space buffer GetFrame fills when called with the
frame's Coords; 2026-10-14), ordered
face-normal accumulation, original face culling, marked-vertex `Light`, ordered
`PF_Unlit` overwrites and D3D nearest-even diffuse quantization. JavaScript
retains `SetupForActor`: live object reads, leaf candidates, line traces, fade
cache mutation and call order remain with the shared runtime. Immutable face
indices/flags are uploaded once per admitted preview and released with it;
posed points and the selected lights cross as bulk typed buffers. Scratch views
are reused after memory growth, and colour upload does not allocate one typed
view per face corner.

This boundary preserves the original numeric path rather than introducing a
new lighting approximation. The kernel consumes the same validated 2,048-word
square-root table and 512/1,024-word reciprocal-root tables as the JavaScript
reference. The focused unit case includes two-sided, invisible, degenerate,
unlit and modulated faces. The live validator runs 24 passes over 12 Training
actors (2,512 vertices total) and compares every Wasm diffuse float bit with
the JavaScript translation; it reports zero differences. That JavaScript path
is separately checked against the recovered native contract and its recorded
reference cases in `docs/mesh-lighting.md`.

In the same Island render isolation, the first bulk port reduced the mean to
25.81 ms with 12.92 MB/frame allocation. Removing per-corner views and
retaining static topology then produced a 20.97 ms representative
run, 16.7 ms median, with 4.03 MB/frame allocation and a 9.25 ms actor update.
Host scheduling varied substantially: a later identical clean build measured
25.87 ms while browser-native `(program)` time doubled. The stable conclusions
are the feature ablation and the large reduction in actor-update allocation;
no single run establishes 120 fps. The capture display is 60 Hz, so intervals
also cannot show a rate above 60 fps. Raw profiles are
`.cache/perf/unatco-{render,no-lighting,wasm-lighting-v2,wasm-final}.cpuprofile`,
outside Git.

## Precision control 24 (2026-10-06)

GetFrame's only caller is DrawLodMesh (Render `0x10b0ee0f`), inside the
render pass, which URender::PreRender runs with x87 precision control 24
([render-pass precision](render-pass-precision.md)). Every add, subtract and
multiply of the loops, and every operation of the matrix setup (Core's
FCoords operators included), rounds to a 24-bit significand. Every operand is
a float or an int16 vertex word, so each is one binary32 operation.

* `lodmesh-frame.mjs` computes the matrix, the cache scalars (tween alpha,
  completion against `.97f`, phase, fraction) and the vertex loops in
  binary32 (`Math.fround` per operation).
* The kernel's `pose_single` runs a vertex in Rust f32. A non-finite operand,
  or a product at or below 2^-126 (where the x87 keeps a normal 24-bit value
  that binary32 would denormalize) or overflowing, hands the vertex to
  `pose_ext24`: the `Ext` model with `round24` after each operation, which
  also follows the x87's NaN rules. `poseCounts()` reports both.
* The GPU pose pass (`gpu-mesh-glsl.mjs`) is the same binary32 operations,
  each through the barrier B() ([GPU meshes](gpu-mesh.md)).

Evidence: `node scripts/validate-lodmesh-frame.mjs` and `--wasm` match all 46
original GetFrame calls at control word `0x007f`, the oracle's default now
(the 64-bit translation differed in 20 of them: 7,562 of 29,823 output words,
up to 1,257 ulps, and 182 cache words). The Rust test
`single_pose_matches_ext24` compares every cache and output word of both
paths over 6,000 random calls (193,690 vertices, 190,616 on binary32) with
zeros, −0, NaN, tiny words and negative alpha. `validate-gpu-mesh` (Training
and Island, 101 captures): 227,862 of 227,862 GPU pose components equal the
CPU kernel's bits.

Cost: the `pose_speed` bench (800 vertices, native, five alternating runs)
went from 69.9 ns per vertex (the f64 certain-rounding path below) to 19.1.
The sections below describe the 64-bit kernel this replaced.

## Exact integer posing (64-bit registers, superseded)

The x87 model rounds to a 64-bit significand only when a result needs more
bits. `pose_exact` (in `native/lodmesh-kernel/src/lib.rs`) runs each vertex of
the main, tween and blend passes as exact dyadic integers (`m·2^e`, with at
most 62 significant bits held in an `i64`). It follows the `Ext` loop's
operation order and store points exactly. Every add, subtraction and multiply
below that bound is exact in x87 as well, so the only roundings are the f32
stores, and those round the same exact values to nearest-even. Signed zeros
follow the same round-to-nearest rules as `Ext`. If an intermediate would
exceed the bound or leave the normal f32 range, or an operand is not finite,
that vertex runs through `Ext`.

Evidence:

* The Rust differential test `exact_pose_matches_ext` compares every cache
  and output word of both paths. It covers 6,000 random calls (198k vertices)
  over main, tween and blend passes with zeros, −0, NaN, tiny and negative
  alpha; about half of those vertices take the exact path.
* `node scripts/validate-lodmesh-frame.mjs --wasm` matches all 46 original
  GetFrame captures, including tweens and four additive blends.
* On a running Island, 92% of posed vertices took the exact path (the
  `poseCounts()` diagnostic). Kernel time went from 6.5 to 4.1 ms per frame.

Natively the exact path costs 154 ns per vertex against 270 ns for `Ext`. It
performs about 54 exact operations per vertex, each 20–30 integer
instructions, so integer emulation has little headroom left. A further step
would compute in f64 and accept the f32 store only when its rounding is
unambiguous under a rigorous error bound, falling back to this path.

## Certain-rounding f64 posing and lighting cleanup (September 29)

`pose_double` evaluates each vertex in f64 before `pose_exact`. A store of
two f32 operands whose TwoSum shows an exact double result is that result;
the x87 result is the same exact value, zeros and signs included. Any other
store is accepted only when `certain_f32` proves that every real within the
error bound rounds to the same f32. The bound is 32·2^-53 per unit of term
magnitude, several times the worst accumulated f64 plus x87 error of each
store's expression. f32×f32 products are exact in both representations.
Stores that are ties (as in the synthetic benchmark's round numbers), zero or
subnormal fall through to `pose_exact`, then `Ext`. On running Island in the
browser the paths took 91% (f64), 8% (exact integer) and 1% (Ext) of
vertices, and pose time fell to about 1.5 ms per frame. The differential test
now requires all three paths to be exercised and compares every output and
cache word with `Ext`. The 46 original captures pass with `--wasm`.

The light kernel reads each light's seven words once per mesh and skips a
light whose attenuation factor is not positive: `total` is non-negative,
infinite or NaN, so `amount > 0` cannot hold. Diffuse bytes are converted
once per vertex and reused by each corner, with the cache cleared when a
`PF_Unlit` face overwrites that vertex. `validate-mesh-lighting-play` still
reports zero Wasm diffuse bytes differing from the JavaScript translation.

A kernel call that allocates can grow Wasm memory and detach the
`ArrayBuffer` behind the JavaScript views. The wrapper therefore re-derives
its views after every call (`current()`), and the kernel keeps per-call
scratch in reusable thread-local buffers. Headless validators did not catch
this; the Island browser run did.

## Results

Unprofiled Training CPU runs with the same seed, data, 14 displayed meshes,
30 warmup frames and 120 measured 1/60-second frames:

| CPU time per frame | JavaScript | Rust/Wasm |
| --- | ---: | ---: |
| Simulation mean | 6.85 ms | 6.69 ms |
| Mesh posing mean | 12.99 ms | 2.33 ms |
| Combined mean | 19.84 ms | 9.02 ms |
| Combined p95 | 21.29 ms | 10.76 ms |

The measured posing speedup is 5.6×, and combined CPU time drops 55%. These
measurements exclude GPU rendering and do not predict larger, unsupported NPC
populations. Both runs report the same ten existing NPC startup/AI failures.

Chromium on the Apple M2 Pro Metal backend, 1440×960/DPR 1, with 60 warmup and
300 measured frames, gives 18.33 ms mean / 33.3 ms p95 for JavaScript and
16.67 ms mean / 16.7 ms p95 for Wasm (roughly 55 to 60 fps). Both retain all
14 meshes, 409 draw calls, active Play, and no page/runtime errors. The 60 Hz
display cadence limits the visible FPS gain; the CPU reduction provides more
headroom. This does not reproduce the user's particular browser/session.

Raw timing reports: `.cache/perf/wasm-{js,rust}.json` and
`.cache/perf/wasm-browser-{js,rust}.json`, outside Git. The existing 46 original
GetFrame captures match **both** backends byte for byte. The 14-mesh runtime
validator and all 490 unit tests pass; the production build includes the kernel.
Four focused Chromium/Metal browser tests pass: Training movement/doors/stairs/
reset, Liberty Island movement and mode switching, loading the production build
from local files with the Wasm asset, and moving in Play after the Wasm request
is blocked. Rust formatting and Clippy with warnings denied also pass.

## Build and reproduce

Install a Rust toolchain and `rustup target add wasm32-unknown-unknown` once.
The dependency-free crate uses the [Rust Wasm target](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html)
and integer/buffer exports, with no wasm-bindgen or host imports. Tested with
Rust 1.95. `npm run dev`, `npm run build` and `npm test` compile it via
`npm run build:wasm`. The generated 44 KiB `.wasm` stays out of Git and Vite
ships it as a hashed static asset. No original assets enter the module.

Play loads the kernel once and reuses scratch memory across meshes/channels.
The adapter refreshes views after memory growth and copies only the requested
vertices. The original JavaScript implementation remains the fallback if
loading fails. `deusExViewer.status().npcPreview` reports `poseBackend` and
`kernelError`; `?meshBackend=javascript` forces the comparison path.

## Developing across the boundary

New gameplay, NPC scripts, inventory and mission behavior continue in
JavaScript. Actors using the existing mesh path benefit from the kernel without
a second implementation of their gameplay behavior. Rust owns only the bulk
vertex interpolation and publication operations described above.

Changes to those accelerated operations must update both the Rust kernel and
the retained JavaScript fallback. Rebuild with `npm run build:wasm`, run the
focused ABI tests and compare both backends against the matching original
GetFrame references. JavaScript/Rust agreement alone is not original-game
evidence. If behavior expands, establish its original contract and reference
cases before admitting it into either backend.

Keep the interface bulk-oriented: pass vertex buffers and channel parameters,
with no per-arithmetic-operation JS/Wasm calls. Preserve cache ownership and
control flow in the shared JavaScript caller. Port other subsystems only when
profiling identifies a specific bottleneck that warrants the added maintenance.

```
npm run build:wasm
node scripts/validate-lodmesh-frame.mjs --captured --wasm
node scripts/validate-npc-mesh-preview.mjs
node --test test/lodmesh-wasm.test.mjs
node scripts/benchmark-play.mjs --javascript
node scripts/benchmark-play.mjs
# With npm run dev running; --metal selects real GPU rendering on this Mac:
node scripts/benchmark-browser.mjs --metal --javascript
node scripts/benchmark-browser.mjs --metal
```

Browser benchmarking reports the actual WebGL device and samples 300 frames
after 60 warmup frames at 1440×960, DPR 1. `--profile PATH` optionally saves a
Chromium CPU profile (use a path outside Git); profiling adds overhead. The
default headless backend may be software rendering, so compare like backends.

Nonfinite cache experiments exposed NaN canonicalization in the existing JS
array/presentation path. The Rust integer ABI preserves payloads according to
the scalar x87 model; its focused nonfinite test compares to that model. The
46 original complete GetFrame fixtures do not establish full nonfinite mesh
behavior. This remains outside the native coverage claim, rather than treating
agreement with JS canonicalization as original-game evidence.
