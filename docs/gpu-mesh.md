# GPU mesh animation and lighting

Started 2026-09-30. This is a rendering acceleration of behaviour that is
already recovered and validated on the CPU. It adds no new original behaviour.
The authorities stay where they are:

* pose: `ULodMesh::GetFrame` (Engine.dll `10355360..103568e5`), translated in
  `src/runtime/lodmesh-frame.mjs` and the Rust/Wasm kernel `pose`
  ([GetFrame](script-lodmesh-frame.md), [kernel boundary](lodmesh-wasm.md));
* lighting: `URender::DrawLodMesh` normals and culling, `FLightManager::Light`
  and D3DDrv's diffuse bytes (Render.dll `607f1077…`, D3DDrv.dll `9e0f8a42…`),
  translated in `src/runtime/mesh-lighting.mjs` and the kernel `light_mesh`
  ([mesh lighting](mesh-lighting.md));
* environment mapping: `src/runtime/mesh-environment.mjs`
  ([instructor materials](script-instructor-conversation.md)).

The CPU path (the kernels above) remains the reference and the fallback. The
GPU path is a second evaluation of the same operations. It is on by default
only after `scripts/validate-gpu-mesh.mjs` shows it within the tolerances
below on Training and Island, comparing against the CPU kernels run on the
same inputs in the same page.

## Why

Island walk profile (M2 Pro, 1440×960, idle, 300 frames, `--no-profile`):
29.4 ms of host work per frame against an 8.3 ms target. The actors phase is
9.7 ms: kernel lighting 2.35, kernel GetFrame 1.44, JavaScript around them
about 3.5, three.js state and uploads about 2. The GPU is busy 1.46 ms per
frame. See [the frame table](rust-core.md) ("Where the frame stands after
B4b"), option 2.

An Island census after 120 walking ticks (local tool, not in Git) has 304
drawable mesh actors, 86 meshes, 5.97 MB of keyframe records, 27,153 actor
vertices and 47,251 actor faces. Per tick about 49 actors have a named blend
slot and about 24 are tweening (`AnimFrame < 0`); they are the NPCs, the
largest meshes. 61 actors have environment-mapped faces, 23 are `bUnlit`, and
46 meshes mix `PF_Unlit` faces with lit ones. No actor has `bParticles`,
`bAnimByOwner` or `Fatness ≠ 128`. The GPU path must therefore cover tweens,
blends, environment mapping and mixed unlit faces; restricting it to plain
keyframe poses would leave the expensive meshes on the CPU.

## GPU arithmetic on the target (measured)

The browser compiles WebGL2 shaders through ANGLE to Metal. A probe
(`.work/tools/gpu-float-probe.mjs`, 65,536 random f32 operand sets per
expression, M2 Pro) found:

| Expression | Result |
|---|---|
| `a*b`, `a+b`, `(a-b)*c` alone | correctly rounded (0 mismatches) |
| `float p=a*b; p+c` | contracted to a fused multiply-add in 9,385 cases |
| `a*b - c*d` | fused in 10,171 cases |
| `a+(b+c)` | reassociated to `(a+b)+c` in 14,729 cases |
| `a/b`, `sqrt` | up to 2 ulp from correctly rounded |
| `inversesqrt` | up to 1 ulp |

Metal compiles with fast-math, and GLSL ES 3.00 has no `precise`. Every
arithmetic result the shaders depend on therefore passes through an opaque
barrier, `uintBitsToFloat(floatBitsToUint(x) ^ zero)` with `zero` a uniform
the compiler cannot see. With it, Dekker's two-product (Veltkamp split by
4097) and Knuth's two-sum are exact in all 65,536 cases
(`.work/tools/gpu-ff-probe.mjs`; the three apparent two-sum mismatches were
the JavaScript reference's own f64 rounding for operands 33 exponents apart).
Division and square root are never used directly where their result is
stored; they are refined with a float-float Newton step. Subnormal results
may flush to zero on the GPU; none of the compared quantities is subnormal in
practice, and the validator would show it.

The kernels emulate x87 extended intermediates (GetFrame) or use f64
intermediates (lighting). The shaders reproduce each of those intermediates
as a float-float pair (about 48 significant bits) and round to f32 exactly
where the CPU stores to f32. A float-float value differs from the 64-bit x87
or 53-bit f64 intermediate only below its 48th bit, so the f32 store agrees
except when the exact value lies within about 2^-48 relative of an f32
rounding boundary.

## What moves to the GPU, and what stays in JavaScript

JavaScript keeps every decision that reads or writes script-visible state or
selects which work happens:

* admission, reconciliation, `drawnInWorld`, the outer cull sphere, Style,
  ScaleGlow and material state, pose change detection (`pose()`);
* GetFrame's control flow (`planLodMeshFrame` below): owner selection,
  sequence lookup, `frameInteger`, tween alpha, completion and the 0.97 gate,
  the cache scalars (`frame`, `sequence`, `completion`, `valid`) and cache
  identities, and `lodMeshFrameMatrix` (the x87-exact coordinate matrix);
* SetupForActor: candidate lights, sort, traces, fades and the light
  constants (`ComputeFromActor` colour, camera-space location, 1/R);
* which groups are drawn in each pass, the relight gate and render feedback
  (`onAfterRender` → `LastRenderTime`), see "Visibility" below.

The GPU receives numbers and does the per-vertex, per-face and per-corner
loops:

1. **Pose pass** (one point per actor vertex): GetFrame's interpolation and
   publication for the main channel and up to four blend slots, including
   tween channels, into the world-space pose (the CPU `frame.output`), and
   the per-channel cache pose (the CPU `entry.vertices`).
2. **Face pass** (one point per actor face): camera-space face normal and
   the drawn test of DrawLodMesh `0x10b0fe60–0x10b0ffc9`; for actors with
   environment faces also the world-space face normal of `meshFaceNormal`.
3. **Vertex pass** (one point per actor vertex): vertex normal as the sum
   of its faces' normals in ascending face order, the normal plane, and
   `FLightManager::Light` for the actor's selected lights; for environment
   actors also the `meshVertexNormals` normal.
4. **Corner pass** (one point per face corner): D3D diffuse bytes with the
   modulated, unmarked-vertex and ordered `PF_Unlit` rules.
5. **Draw**: the existing per-group three.js meshes. Their vertex shader
   fetches the corner's pose texel (world → view `[y, z, −x]`, the existing
   reflection) and its corner colour, and computes environment UVs from the
   render camera.

## Data

**Static per mesh** (shared by every actor with that mesh, uploaded once):

* keyframes: the original eight-byte vertex records (three i16 and padding)
  as an `RGBA16I` texel each, frame `f` vertex `i` at `f·V + i`, `V` =
  `frameVertexCount` (special vertices included, as GetFrame indexes them);
* faces: `(v0, v1, v2, flags)` as `RGBA32UI`, in the mesh face order that
  `getActorMeshSurfaces` returns (DrawLodMesh draw order);
* vertex adjacency: for each vertex the faces containing it, in ascending
  face order (CSR offsets and a face list), so the vertex pass sums face
  normals in the order the CPU loop adds them;
* per draw group and keyframe, the local i16 bounding box of the group's
  vertices and of their differences from frame 0 (for blend slots). These are
  CPU-only certificate inputs.

**Per actor slot** (allocated at admission, freed at retirement): a vertex
range in the pose/vertex textures, a face range and a corner range. Each
draw group's geometry carries two constant attributes, the absolute pose
texel and the absolute corner texel of every corner, so its material needs
no per-actor uniform.

**Per actor per frame** (a parameter row, uploaded only when it changes):
the 4×3 GetFrame matrix exactly as `lodMeshFrameMatrix` returns it, the mesh
origin, and for each channel (main, blend slots 0–3) its mode (inactive,
keyframe, tween), `first`, `second` (or the tween target), `alpha`, and for a
tween the source of its cache pose. For relit actors a lighting row: ambient,
ScaleGlow, the unlit colour, the actor poly flags, and the selected lights
(camera-space location, 1/R, faded colour), at most 32; the frame's camera
origin and axes are global uniforms.

## Pose pass: GetFrame on the GPU

For each channel the shader evaluates exactly the per-vertex operations of
`getLodMeshFrame` (and the kernel `pose`):

* keyframe mode, `alpha > 0`: X is `st(delta·alpha + a)` with the product and
  sum unrounded (a float-float two-product followed by a two-sum, one final
  rounding); Y and Z store `delta`, then `st(delta·alpha)`, then
  `st(product + a)`. `alpha ≤ 0` takes frame `first` unchanged. `delta = b − a`
  of two i16 values is exact.
* tween mode: the same interpolation from the channel's cache pose toward
  frame `target`; `alpha = 0` leaves the cache unchanged.
* main publication: `component = st(pose − origin)`; then
  `st((v0·r0 + v1·r1) + v2·r2)` with `v = component − m0` unrounded, as a
  float-float dot product rounded once per row.
* blend publication: `component = st(pose − frame0)`, `st(v·r)` without the
  coordinate origin, then `st(result + out)` in slot order.

The cache pose of a channel is `entry.vertices` of the CPU cache. It is
written by every evaluation, and a tween reads the previous one. The GPU
keeps it in state textures that are ping-ponged each frame: the pose pass
draws every allocated vertex, recomputing dirty actors and copying the pose
and the in-flight cache poses of the others, so no state is lost while an
actor is not drawn. `count` is always the full vertex count in Play
(`getLodMeshFrame`'s default `vertexCount`), so the tween's count expansion
branch never runs there; if a plan ever needs it, that actor takes the CPU
path for that frame.

**CPU shadow.** The CPU cache must stay able to produce the exact CPU pose
on demand (visibility fallback and validation). `planLodMeshFrame` records
each channel's operation in a per-entry log instead of running the vertex
loop; a keyframe operation replaces the log. `materializeLodMeshFrame`
replays the log through the same kernel calls in the same order and then
publishes the current operation, which is by construction the output
`getLodMeshFrame` would have produced for the same frame. The existing
`getLodMeshFrame` replays a pending log before it reads `entry.vertices`, so
switching an actor between paths is exact. `script-runtime.mjs`'s own GetFrame
caches never hold a log and are unaffected.

**First pass.** A slot's plan takes effect when the next `run()` evaluates
it (its stamp is `frame + 1`), and a later `setPose` before that run replaces
it. A preview plans its first GetFrame when it is created, which is
asynchronous; if the simulation moves the actor before the next run, the
update's plan overtakes the creation plan, which then never runs on the GPU.
Its cache entries exist only on the CPU, and a tween in the new plan would
read a cache pose the GPU never wrote (zeros): the actor grows from a point
over the tween. This is what the player looked like when MeetPaul admitted him
mid-animation in behind view. The original's GetFrame runs only from
Render.DrawLodMesh (`10b0ea80`, call at `10b0ee0f`;
docs/script-lodmesh-materials.md), so its first one happens when the actor is
first drawn, and until the slot's first run (`gpu.frame <
firstPassFrame`) a new plan flushes the preview's CPU cache first and is
itself the first GetFrame.

## Face, vertex and corner passes: DrawLodMesh lighting on the GPU

These reproduce `light_mesh_job` in `native/lodmesh-kernel/src/lib.rs`:

* camera point: `st(Σ (p − o)·axis)` with the differences and products exact
  (float-float), one rounding, as `camera_component`;
* face normal: `a = p2 − p0` and `bx = p0x − p1x` unrounded, `by`, `bz`
  stored, `n = st(b × a)` per component with its products and difference in
  float-float, `scale = tableRsqrt(st(|n|² + ε))`, `face = n·scale` (f32);
  `ε = 0x3a83126f`;
* drawn: not `PF_Invisible` and (`PF_TwoSided` or `face·p0 < 0`, the dot
  product in float-float);
* vertex normal: f32 sums of the face normals in ascending face order,
  `scale = tableRsqrt(st(|N|² + ε))`, plane `(st(N·scale), st(p·N·scale))`
  with the unrounded scaled components, as the kernel does;
* `Light`: per light `dist2 = st(dxe·dx + dy² + dz²)` (float-float),
  `dist = tableSqrt(dist2)`, `factor = 1 − dist/R`, the diffuse and mirrored
  specular terms and the colour accumulation with the kernel's f32 stores,
  f64 intermediates as float-float; `min(1, sum·ScaleGlow·1.4 + ambient)`;
* diffuse byte: `FISTP(st(L·scale·255))`, nearest-even, `scale =
  st(255·st(1/255))`, as `diffuse_channel`.

`tableSqrt` and `tableRsqrt` are the light manager's tables
(`squareRootTable`, `rsqrtTables`), uploaded as integer textures and indexed
by the float's bits exactly as the kernel does. Because they index by bits,
their inputs are the values that must agree bit for bit; that is why the
sums before them are float-float.

**Corner rules** (the kernel's final loop), per corner `(face i, vertex v)`
with `flags = faceFlags | actorFlags`: `PF_Modulated` gives colour 1; a
vertex no drawn face contains gives 1; if face `i` is drawn and `PF_Unlit`,
or an earlier face `j < i` containing `v` is drawn and `PF_Unlit`, the unlit
colour replaces the vertex light (the kernel's in-order overwrite); otherwise
the vertex light. The face pass's drawn flags make this a gather over `v`'s
ascending adjacency, so mixed-unlit meshes stay on the GPU.

**Environment normals** follow `meshVertexNormalsInto` on the world-space
pose, with its own f64/f32 mix (`u = c − a` unrounded, `v = st(a − b)`,
stored cross terms, `q = st(|c|² + st(0.001))`, the same rsqrt tables). The
draw shader computes `writeMeshEnvironmentUV` per corner from the render
camera (three.js `cameraPosition`, which is the mirror camera in mirror
passes, as `updateView` passes today).

## Visibility and render feedback

Today three.js culls each draw group by `geometry.boundingSphere`, computed
by `setMeshBounds` from the posed positions. That sphere decides three
things: which groups are drawn in each pass (main, each mirror), hence
`onAfterRender` → `LastRenderTime`, which the simulation reads; whether the
actor is relit (`update`'s relight gate, which runs SetupForActor and mutates
its fade caches and stamp); and the sort key of transparent groups. The GPU
path must reproduce the first two exactly without the posed positions.

For each dirty group the CPU keeps a conservative world box: the union of
the group's local boxes for the keyframes the channel reads (`first`,
`second`; for a tween the previous box and the target's), transformed by the
GetFrame matrix (all eight corners, in doubles), plus each blend slot's
difference box rotated by the matrix rows, widened by a rounding margin.
The exact sphere's centre lies in this box and its radius is at most the
box's half-diagonal. For a frustum, the group is **certainly drawn** when
the box lies inside all six planes, and **certainly culled** when for some
plane the box's farthest point plus the half-diagonal is still outside.
Otherwise the actor is **ambiguous**: the CPU shadow produces the exact pose
(`materializeLodMeshFrame`), `setMeshBounds` its exact spheres, and three.js's
own `Frustum.intersectsSphere` decides. Exact spheres are cached until the
pose changes, as today.

GPU groups set `frustumCulled = false` and `mesh.visible` to that decision
for each pass: `update()` for the main frame, the mirror hook for each
mirror camera (its frustum is its `projectionMatrix × matrixWorldInverse`,
which mirrors.mjs sets before rendering), and the final hook call restores
the main-frame decisions. The relight gate uses the main-frame decisions.
The same groups are therefore drawn, stamped and relit as on the CPU path.

**Known presentation difference:** transparent groups are sorted by the
bounding-sphere centre. Where no exact sphere was needed the GPU path sorts
by the box centre, so two translucent or modulated groups at nearly equal
depth can draw in a different order than on the CPU path. This changes no
visibility decision or render feedback.

## Draw batches and two-sided groups

With positions and colours fetched from these textures, a group's draw no
longer needs its own vertex buffers, so opaque and masked groups of
different actors that share one material state (texture, side, alpha test,
environment flag, original lighting on) are drawn by one three.js mesh
(`src/viewer/actor-batches.mjs`). Each member keeps the per-group, per-pass
decision above as a flag in a small texture; a hidden member's vertices are
placed beyond the far plane. After a batch is drawn, every member visible in
that pass stamps its actor's `LastRenderTime`, exactly the groups whose own
meshes three.js would have drawn and whose `onAfterRender` would have run.
Translucent and modulated groups keep their own meshes and their sort.
Opaque draw order between different actors changes; only exactly coplanar
overlapping faces of two actors could resolve their depth tie differently.

three.js draws a transparent double-sided material as a back-face and a
front-face draw, flipping `material.side` and marking the material dirty
twice per draw, which re-derives its program every frame. Two-sided groups
instead keep back-side and front-side materials and a twin mesh sharing the
geometry, created right after the group's mesh (adjacent ids keep the pair
consecutive in the transparent sort): the same two draws, back first.

Evidence (same-frame comparisons, one callback, headless Chromium/Metal):
batches vs the members' own meshes differ in 0 bytes on Training (186
groups in 71 batches) and Island (464 groups in 123 batches); twins vs
three.js's own two-pass differ in 0 bytes at four NPC close-ups. Over 120
walking frames, every GPU-path actor's `LastRenderTime` equals the frame's
`TimeSeconds` exactly when one of its groups was decided visible (26,400
checks on Island, 7,679 on Training).

## Tolerances

Stated before implementation; the validator fails beyond them.

* **Positions** (pose texture vs CPU `frame.output`, every vertex of every
  compared actor): at most 1 ulp of the CPU f32 value per component for
  keyframe channels and blends, at most 2 ulp while a tween channel is active
  (its cache pose feeds back into the next frame). The float-float argument
  above predicts bit agreement for nearly all components; the validator
  reports the bit-exact fraction as well as the maximum.
* **Colours** (corner texture vs the CPU corner colours, FISTP byte / 255):
  at most 1/255 per channel on corners of faces the CPU marks drawn. A face
  whose drawn test differs between GPU and CPU (edge-on to the camera) is
  reported separately with its relative dot product `face·p0 / |p0|`; such a
  disagreement is accepted only below 2^-20, and its corners are then
  excluded from the colour comparison.
* **Environment UVs**: at most 2^-20 absolute.
* **Visibility**: identical `mesh.visible` decisions to the CPU sphere test
  for every group and pass, and identical `LastRenderTime` stamps.

If a tolerance cannot be met for a light type or face flag, that case stays
on the CPU path and the measured error is recorded here; the bound is not
loosened.

## What stays CPU-only, and why

* The CPU path itself (`?gpuMesh=0`, and `?meshBackend=javascript`, which
  also disables the kernel): the reference and the fallback.
* The first-person weapon (`weapon-view-model.mjs`): one actor, drawn by its
  own renderer pass; nothing to gain.
* An actor whose plan needs the tween count expansion, or with more than 32
  selected lights, for that frame (measured counts are recorded below).
* Exact spheres of ambiguous groups (above), computed from the CPU shadow.
* Fatness, fog and volumetric lights, which the CPU path does not implement
  either (see [mesh lighting](mesh-lighting.md)).

## Validation

`scripts/validate-gpu-mesh.mjs` runs headless Chromium through Playwright
against a dev server, as `profile-play-browser.mjs` does, on `00_Training` and
`01_NYC_UNATCOIsland`. For a set of Play frames it reads the GPU pose, face,
vertex and corner float render targets with `readPixels`; the draw shader
fetches from these same textures, so they are what is drawn. In the same
page it runs the CPU kernels on the same inputs: the exact CPU pose from the
shadow, and the kernel `light` with the SetupForActor result the GPU used
(SetupForActor is not run twice). It prints the maximum position error in
ulps, the maximum colour error in bytes, the environment UV error and the
visibility agreement per map, and exits nonzero past the tolerances. The
compared set must include environment-mapped, translucent, modulated and
masked faces, blend slots and tweens, and frames with moving lights.
On Island the walk continues into MeetPaul after the sampled frames: once
the conversation sets bBehindView and the player's mesh is admitted, every
frame for 90 frames is compared, and at least one of them must tween the
player (the first-pass case above).

The simulation digest must be unchanged, since the path is render-only:
`node scripts/bench-sim.mjs --map 01_NYC_UNATCOIsland --bypass --continue
--render-feedback --warm 60 --ticks 300 --digest-every 50` gives
`b767a7e417fe5968`.

## Results

Implemented in `src/viewer/gpu-mesh.mjs` (resources and passes),
`src/viewer/gpu-mesh-glsl.mjs` (shaders), `src/viewer/gpu-mesh-bounds.mjs`
(certificates) and the GPU mode of `src/viewer/npc-mesh-preview.mjs`;
`planLodMeshFrame` and `materializeLodMeshFrame` in
`src/runtime/lodmesh-frame.mjs` (their bit-equality with `getLodMeshFrame`
is `test/lodmesh-plan.test.mjs`). On by default; `?gpuMesh=0` selects the
CPU kernels.

**Validation** (`node scripts/validate-gpu-mesh.mjs`, dev server with the
worktree, headless Chromium/ANGLE Metal on the M2 Pro, ten captures per map
while walking):

| | 00_Training | 01_NYC_UNATCOIsland |
|---|---:|---:|
| position components compared | all bit-exact | all bit-exact |
| drawn corners compared | 169,362 | 538,170 |
| colour-byte differences | 0 | 0 |
| drawn-test disagreements | 0 | 0 |
| environment normal / UV error | 0 / 0 | 0 / 0 |
| visibility mismatches | 0 | 0 |
| certified / exact-fallback group decisions | 381,610 / 11,880 | 179,490 / 1,465 |

Coverage across both maps: translucent, modulated, masked and
environment-mapped faces, mixed `PF_Unlit` meshes, blend slots, tweens and
moving lights. The measured errors are zero, below the stated tolerances
(1 ulp, 2 ulp in tweens, 1/255, 2^-20); the float-float emulation made the
GPU results agree with the kernels' f32 stores in every compared case. With
`--device cpu` the same harness compares the JavaScript lighting path with
the Wasm kernel (0 differences) and checks the certificate logic against
exact spheres.

**Play checks with the GPU path:** Training reaches HUD health 100 with no
runtime error; Island plays to its known StrafeFacing (native 506)
boundary, and Player start resumes with the player moving. The simulation
digest is unchanged (`b767a7e417fe5968`); the path is render-only.

**Cost:** see [play frame cost](play-frame-cost.md) ("September 30, night"):
Island actors phase 9.04 → 3.75 ms and frame 27.21 → 21.48 ms (interleaved
A/B, 4 pairs); GPU time 1.44 → 2.91 ms. The 2 ms actors-phase target is not
met; the remainder is SetupForActor, the admission scan and GetFrame
planning in JavaScript.

**Full sweep** (`npm run validate -- --jobs 4`, branch head `349b875`):
441 of 444 passed. The three failures are the known non-regressions and
pass solo: `validate-native-mover-scene` (report race),
`validate-native-level-points` (it reads a report another validator leaves
in the git-ignored `reports/`, absent in a fresh worktree) and
`validate-player-tick-order` (killed at the runner's 6 GB cap under memory
pressure; exit 0 alone). The Island digest after the sweep is still
`b767a7e417fe5968`. A second sweep after the render-side follow-ups (branch
head `f436336`) passed 443 of 444; the one failure was again
`validate-player-tick-order` at the memory cap, which passes alone. A third
sweep at the final head (`ae49c67`, after the static-matrix and mirrors
change) gave the same 443 of 444.

**Browser specs** (`npx playwright test`, run from the worktree with its own
servers): 10 of 18 pass; the same 8 fail identically on master in this
environment. Playwright's default headless Chromium renders with SwiftShader
(software GL), where Training runs at about 4 fps (median frame 250 ms with
the CPU path, 267 ms with the GPU path), so movement- and timing-bound specs
time out on both. Because the passes are slower than the kernels on a
software implementation, the viewer keeps the CPU path when the WebGL
renderer is SwiftShader, llvmpipe or another software renderer, unless
`?gpuMesh=1` forces the GPU path.

**Render-side follow-ups** (interleaved Island A/B, 3 pairs each, medians):
twins instead of the per-draw side flip cut three.js program re-checks from
138 to 12 per frame, render 3.04 → 2.51 ms; draw batches cut main-pass draw
calls from 642 to 325, render 2.53 → 1.75 ms. Against master (before this
work) the branch head's Island frame is 27.40 → 19.32 ms (4 interleaved
pairs; actors 9.30 → 3.63, render 3.16 → 1.83); see
[play frame cost](play-frame-cost.md).

**Known differences and limits:**

* Transparent groups sort by their box centre when no exact sphere was
  computed (documented above; no visibility or feedback change).
* A GPU-path actor that hits an unsupported case (tween count expansion,
  more than 32 selected lights, capacity) converts to the CPU path exactly
  and stays there; `summary.gpuFallback` records why. None occurred in the
  validated runs.
* The GPU's subnormal handling was not exercised by any compared value.
* Actor meshes, batches and the static world's meshes have
  `matrixAutoUpdate` off (identity local transforms). A mesh added under a
  mover's group relies on the group being flagged (`matrixWorldNeedsUpdate`,
  which `syncMovers` sets every Play frame) to receive its world matrix; code
  that adds such children at run time outside that cycle must flag the group
  itself. Nothing does that today (world meshes are built at load).
* The validator compares only **main-pass** group decisions with the exact
  sphere test. Mirror passes use the same certificate and fallback code
  with a frustum built from the mirror camera's projection and inverse
  world matrices (as three.js builds it), and Training's mirror floors
  exercise that path heavily (most of its certified decisions), but no
  check samples a mirror pass's decisions or its stamps.
* Validation samples frames between two animation frames; an actor admitted
  after the frame's GPU run is posed by the next run before it is drawn
  and is skipped by the sampler (`pending` in the report).
