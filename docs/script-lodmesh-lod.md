# Original character mesh LOD selection and morphing

Authority: hash-pinned Render.dll `607f1077…d75d1`, Engine.dll `0c3a8b18…c20b4`
and Core.dll `8bf3039e…7e4` (see [surface/skin selection](script-lodmesh-materials.md)).
This is the distance LOD of `URender::DrawLodMesh` (`0x10b0ea80`, reached only
through `URender::DrawMesh` `0x10b0d1a0`). Re-derived from the disassembly on
2026-10-07; the earlier draft of this page assumed 64-bit precision and
mis-stated the morph gate and appTan's store.

## Precision

DrawLodMesh runs inside the render pass, at x87 precision control 24
(control word `0x007f`, [render-pass precision](render-pass-precision.md)):
every FADD, FSUB, FMUL, FDIV and FIMUL rounds to a 24-bit significand with the
x87's wide exponent; loads, FILD, FST/FSTP to a float, FISTP and FPTAN are not
affected. Below, "rounded" means that 24-bit rounding, "stored" a float store.
For operations on floats and small integers this is one binary32 operation;
the two operations with a double constant (the FOV argument and the screen
factor) round the exact product or sum once. Comparisons see the unstored
value.

The precision is not cosmetic: the same 228 reference cases run with the
oracle at `0x037f` differ from the translation in the appTan argument of every
gated case (216), the stored detail of 104, the morphed buffer of 141 and the
transformed Location of 6 (`ORACLE_CW=0x037f node scripts/validate-lodmesh-lod.mjs
--js-only`).

## Renderer settings

`URender::Init` (`0x10b134d7..0x10b134ef`) sets `+3c` = 3.0 (texture LOD,
console `TLOD`), `+40` = 0.25 (shape LOD distance, `MLOD`), `+44` = 1.0, `+48`
= 1 (shape LOD mode, `MLMODE`) and `+4c` = 1.0 (fixed scale, `MLFIX`).
`URender::Exec` (`0x10b147b0`) changes `+40` only to a positive value, `+48`
and `+4c` only to a non-negative one. `+44` has no writer besides the copy
constructor and assignment. `URender::StaticConstructor` (`0x10b13450`) is a
bare `ret`, so no config property loads them; the INI files have no
`[Render.Render]` section. The shipped game therefore always runs with
0.25 / 1.0 / 1 / 1.0 unless a player types those console commands.
`RENDER_LOD_SETTINGS` in `src/runtime/lodmesh-lod.mjs` holds them.

## Selection `0x10b0eb52..0x10b0ed53`

Mesh fields (SDK layouts, confirmed by the reads): ModelVerts `+180` (N),
SpecialVerts `+184`, MeshScaleMax `+188`, LODStrength `+18c`, LODMinVerts
`+190`, LODMorph `+194`, LODZDisplace `+198`, CollapsePointThus `+12c`,
FaceLevel `+138`, Faces `+144`, CollapseWedgeThus `+150`, Wedges `+15c`,
Materials `+168`. Actor: Location `+114`, DrawScale `+17c`, LODBias `+64`.
The viewport actor's FovAngle `+410`; the frame's float width FX `+b8`.

1. Requested count = N, detail = float(N). The LOD flag (`[ebp-28]`) and the
   morph flag (`[ebp-b4]`) start clear.
2. The LOD runs only when LODStrength's **raw bits** are nonzero (-0.0
   counts) and CollapsePointThus.Num is nonzero. Then the LOD flag is set,
   and the morph flag when byte `+48` has bit 0 set and LODMorph > 0
   (ordered).
3. appTan: FLD FovAngle, FMUL m64 PI/360 (`0x10b2ac48`), rounded, FSTP m64.
   Core's appTan (`0x10123260`) is `FLD m64; FPTAN; FSTP st(0); RET`: the
   extended tangent stays in ST0, and DrawLodMesh stores it as a double
   (dead) and as the float it uses (`0x10b0ebe2`), one rounding from the
   extended value. Mode `+48` >= 3 (signed) replaces the float with 1.
4. complexity = stored((N·0.003f) + 0.25f); screen = stored((FX·0.0010937499999999999)
   + 0.3), both double constants exact then rounded once.
5. Location by the caller's FCoords (Frame->Coords, `Frame+34`, from
   DrawActorSprite): `d = L − Origin`, each axis `(d.x·A.x + d.y·A.y) + d.z·A.z`,
   all three stored. depth = Z − LODZDisplace, replaced by 1 unless
   `1 < depth` or it is NaN.
6. ratio = (((MeshScaleMax·DrawScale)·LODBias)·screen)·430 /
   (((((+44·+40)·LODStrength)·depth)·complexity)·tan), each rounded.
   Mode 0 replaces it with `+4c`, or 1 when `+4c` is ±0 or NaN.
7. ratio·N (FIMUL), rounded and not stored, against the exact LODMinVerts:
   detail = stored(ratio·N) when LODMinVerts is below it (or it is NaN), else
   float(LODMinVerts). Requested count = min(N, FISTP(detail)) (nearest-even,
   signed compare).

Before GetFrame, a viewport actor whose RendMap (`+600`) is 1 or 13..15
(wire and orthographic views) makes GetFrame use GMath.UnitCoords instead of
the caller's coords (`0x10b0ed53..0x10b0edf3`).

## GetFrame and the post-frame morph `0x10b0ee34..0x10b0ef6e`

GetFrame ([GetFrame](script-lodmesh-frame.md)) receives the requested count
and can return fewer (its tween clamp to the cache's valid count); the rest of
DrawLodMesh uses the returned count C. Its output buffer is fresh GMem, 88
bytes per vertex (FTransTexture: Point `+0`, outcode `+c`, Normal `+20`,
Light `+30`, U `+50`, V `+54`).

1. Morph flag set: start = FISTP(stored((1 − LODMorph)·detail)). start >= C
   clears the morph flag.
2. Otherwise inverse = 1/(detail·LODMorph), rounded, kept on the stack. For
   ordinary vertex i from C−1 down to start+1: alpha = (i − start)·inverse,
   rounded, replaced by 1 unless `1 > alpha`. The CollapsePointThus word t of
   i (ordinary indices; every shipped target is below its vertex or zero):
   t = 0 stores alpha 0 at `+50` and leaves the position; otherwise each axis
   moves toward t's position (not yet morphed, the loop runs downward): X
   keeps its difference and product on the stack, Y and Z store both, then
   each sum is stored; alpha is stored at `+50`. Nothing else is written.
3. With the morph flag clear and C >= N, the LOD flag is cleared.

The morph happens before the outcodes (`0x10b0ef6e..`), normals and lighting,
so they all see morphed positions.

## Faces `0x10b0fc6f..0x10b0fe60` (LOD flag) or `0x10b10123..0x10b101e8`

A zero-filled dword per wedge (an FArray, `[ebp-34]`) memoizes the packed
corner by **original** wedge index. With the LOD flag:

* a face with FaceLevel > C is skipped (`0x10b10117`);
* each corner's wedge follows CollapseWedgeThus while its vertex word is at or
  above C;
* while morphing, a selected vertex above start whose stored alpha bits are
  nonzero, and whose next wedge differs from it, moves U and V toward the next
  wedge's bytes when either differs: `stored((next − cur)·alpha + cur)`, FISTP,
  low byte. The vertex stays the selected wedge's;
* the packed dword (vertex word, U, V) is cached and the corner addresses the
  ordinary vertex.

Without the LOD flag every face's three wedges are copied unchanged. Faces keep
their order and materials (`[ebp-58]`/`[ebp-54]` update on admitted faces).

What follows runs over that face list exactly as at full resolution (the
reduced copy `0x10b0fe60..0x10b0ffcf` and the full one `0x10b101d3..0x10b10351`
are the same 95 x87 operations on other registers and temporaries; only the
back-face dot adds its first two products in the other order, which one
rounded addition does not distinguish): the
face normal is accumulated into its three (collapsed) vertices for every
admitted face, before the outcode and back-face tests; a drawn face marks its
vertices (`+30` = −1); the lighting loop (`0x10b10834`) lights the marked
ordinary vertices below C; the draw loop (`0x10b10ae9`) takes each corner's
vertex and U/V bytes from the cached dwords (overwriting `+50`/`+54`).

Not ported here: the particle branch (Actor `+194` bit 2, `0x10b0f7ad..`),
which uses the same count; the wire/orthographic branch (`0x10b0f45c..`),
which collapses wedges below the count without testing the LOD flag.

## Translation and reference cases

* `src/runtime/lodmesh-lod.mjs` (the reference): `selectLodMesh`,
  `morphLodMesh`, `lodMeshCorners`, `lodMeshTopology`, `lodMeshTanArgument`,
  `lodMeshTanFactor`, `RENDER_LOD_SETTINGS`.
* `native/lodmesh-kernel/src/lod.rs` (the port): `lod_select`, `lod_morph`,
  `lod_corners`, `upload_lod_mesh`; `kernel.lod` in `src/runtime/lodmesh-wasm.mjs`.
* The tangent: `x87TanFloatCandidates` in `src/runtime/x87-tan.mjs` computes
  tan(x) to 256 bits and rounds it to a float; when the true value lies within
  8 extended units of a float rounding midpoint it returns both neighbours and
  `lodMeshTanFactor` refuses the FOV. Unicorn computes FPTAN in double
  precision, so the oracle replaces its float at `0x10b0ebe5` by the model's
  for the argument it recorded (and keeps Unicorn's for comparison).

`scripts/native-lodmesh-lod-oracle.py` executes the three original ranges at
`0x007f` over real mesh arrays and an original GetFrame buffer;
`scripts/lodmesh-lod-cases.mjs` generates the cases;
`scripts/validate-lodmesh-lod.mjs` compares the JS reference and the kernel.

| Check | Result |
| --- | --- |
| `node scripts/validate-lodmesh-lod.mjs` (GM_Trench, GFM_Trench, GM_Jumpsuit, Chair1, Barrel1, SoyFood; 228 cases) | detail bits, requested count, both flags, transformed Location, morph start, all 88-byte buffer bytes (positions, alphas, untouched pattern), each face's admission, material, flags and vertices, every scratch dword: equal for JS and the kernel |
| coverage of those cases | 183 with reduced topology, 152 morphing (4,174 morphed vertices), 162 below ModelVerts; 48,578 of 77,140 faces admitted; 4,531 wedges with interpolated UVs; distances from full detail to the LODMinVerts floor and behind the camera; FOV 60/75/90/120/74.99874; FX 640–1920; LODBias, DrawScale, LODZDisplace; no collapse table, LODStrength 0 and −0, LODMorph 0, LODMinVerts above N; modes 0 (fixed 0.37 and 0), 2, 3, MLOD 0.5; rotated coords; GetFrame returning 7 fewer and fewer than the morph start |
| `node scripts/validate-x87-tan-hardware.mjs` (AMD Ryzen 9 8945HS, Wine, `0x007f`) | 208,181 FOVs: every argument equals `lodMeshTanArgument`, every stored float equals the single candidate (no ambiguous pair); `Math.fround(Math.tan(x))` happened to agree in all of them too |
| `ORACLE_CW=0x037f` audit | 665 of 226,265 checks differ (above): the precision matters |

The captured oracle output (`--reference-only`, `.cache/research/`) stays
outside Git; `--captured` reuses it when its inputs match.

Not covered: Intel x87 (a disagreement would be a finding), FOVs outside
(0°, 180°), a NaN detail (FISTP's integer indefinite makes the count
negative; the translation throws), a count the wedge collapse never reaches
(the original loops forever; the translation throws), subnormal or
overflowing intermediates (the translation keeps the x87's wide exponent in
doubles, untested).

## Play

Both mesh paths draw the LOD; `?meshLod=off` draws every mesh at full detail
(main.mjs → sim-host `meshLod` → actor-mesh-sim `lod`).

**Selection.** Per drawn binding, after Render.dll's admission and the
OccludeBsp main set, `src/viewer/actor-mesh-lod.mjs` runs `selectLodMesh`
with the master frame's Frame->Coords and FX (the same FSceneNode words
OccludeBsp runs on, `sim-session.mjs` visibility), the player's FovAngle and
its measured tangent float, the actor's Location and DrawScale (the
mesh_reads block when it has them) and LODBias, and URender's shipped
settings (`setLodSettings` changes them as MLOD/MLMODE/MLFIX would; only
validation calls it). The requested count joins the pose in deciding a new
GetFrame; GetFrame returns the count the rest uses.

**CPU path** (`?gpuMesh=0`, and any binding off the GPU path): GetFrame's
output stays unmorphed (a later frame's GetFrame or LOD reads it again); the
morph runs on a copy, the kernel's `lod` facade resolves the corners and the
lighting runs over the reduced faces (a dropped face becomes a zero-area
`PF_Invisible` face, which adds nothing to the normals and is never drawn).
The frame record's `lod` carries the resolved corners and wedge dwords; the
page draws each corner at its resolved vertex with its U/V bytes
(actor-mesh-draw.mjs). A dropped face collapses onto its group's first
admitted corner (zero area, bounds unchanged); a group with no admitted face
is hidden on both sides.

**GPU path** (the default): the plan carries each channel's count and fill
start, the record's `lodParams` the post-frame scalars (`lodMorphScalars`:
count, start, flags, the 24-bit inverse), and the GPU passes do the rest
(the morph, the corners, the normals, lighting and draw over the resolved
corners; [GPU mesh](gpu-mesh.md#distance-lod)).

**Child frames (2026-10-08).** The original runs the whole of DrawLodMesh
for every sprite of every frame. DrawFrame (`0x10b1a2d0`) recurses into each
child (`0x10b1a336-0x10b1a348`) and then walks its own Frame->Sprite list,
calling DrawActorSprite (`0x10b25080`), which passes that Frame and
`Coords = Frame+0x34` to DrawMesh (`0x10b0d1a0`) at `0x10b25624`
([mesh lighting](mesh-lighting.md#one-call-per-frame-child-frames-lighting-2026-10-08)
has the addresses). DrawLodMesh reads Frame->Coords and FX (`+0xb8`) for its
selection, calls GetFrame with the count it chose (`0x10b0ee0f`), morphs,
lights and draws. An actor drawn in k frames therefore has k selections and k
GetFrame calls per tick, in DrawFrame's order (children before their parent,
the main frame last), each drawn in its own pass.

What a second GetFrame call does in the same tick (`lodmesh-frame.mjs`,
`decide`): a keyframe call recomputes the same poses for its count (the call
with the larger count covers the other); a tween call after the first finds
the cached frame already written (alpha 0) and the valid count already
expanded (nothing to fill), so it only publishes the cache, and its count is
clamped to the valid count the earlier call set: in the tween case the main
frame's returned count can be lower than its request when a child frame drew
first with fewer vertices. Every vertex a call publishes holds the value the
other calls publish for it, so one output buffer serves all of them.

Play (`actor-mesh-sim.mjs update`, `sim-session.mjs lodFramesOf`):

* each child frame carries its Coords, FX and Frame->Sprite ids; a binding
  selects once per frame that draws it (`meshLod.select` with that frame),
  main frame last; consecutive frames asking for the same count make one
  GetFrame call. The record's base state is the last frame's (the main
  frame's, or the last child's for an actor only child frames draw).
* **CPU path:** the calls run in order through `getLodMeshFrame` into the
  binding's one output buffer; each frame's state is `meshLod.after` of its
  selection and its call's returned count over that buffer.
* **GPU path:** the calls are planned in order (`planLodMeshFrame`, which
  leaves the cache scalars as the calls would) and merged
  (`mergeLodMeshPlans`) into the plan the pose pass runs: per channel the
  operation that changes the pose, or else the one publishing most, with the
  largest count, replacing the tick's operations in the cache entry's log
  (test/lodmesh-calls.test.mjs: the merged cache, output and scalars equal
  the calls in order over 17 ticks of keyframes, tweens, blend slots and
  count changes, JS and Wasm). Calls that cannot merge (a cache entry made
  in this tick while tweening with a fill after a keyframe operation) are
  replaced by the base call alone for that tick (`planDegraded`).
* a frame whose state differs from the base's (`frameVariants`: returned
  count, flags, start, and the detail while morphing) is drawn with its own.
  The decision for its pass carries the GPU `lodParams` or the CPU
  `cpuState` (positions with the morph, resolved corners and wedge dwords),
  its emptied groups, and (the lighting being per frame already) its colours;
  the CPU lighting runs over that frame's reduced faces.
* page (`gpu-mesh.mjs`): `setLod` inside a lighting run (`beginLightRun`)
  stamps the slot, and `lightRun` first runs the morph and corner passes
  for the stamped slots from the pose the last run published, then the
  lighting passes (with the environment normals), so the child's pass draws
  its own pose, corners and colours; the main frame's pass (or the next
  record) puts the main state back the same way. The CPU path swaps the
  geometry's positions, U/V bytes and colours (`cpuPositions(state)`).

**What stays different from the original:**

* *Space of the morph.* Play's GetFrame runs with identity coords (world
  space) and the lighting transforms to camera space as a separate stage at
  24 bits (render-pass-precision.md "lighting camera transform"); the
  original's GetFrame composes Frame->Coords into its matrix, so its morph
  and lighting see camera-space floats. Counts, flags, start, alphas,
  admitted faces, resolved corners and U/V bytes are the original's; the
  morphed coordinates round in world space. Doing it in camera space would
  need GetFrame's publication with the camera matrix for every drawn actor
  whenever the view moves (on the CPU shadow too) and a draw path that takes
  camera-space positions, per mirror frame as well; this is the existing
  host-stage item, left open.
* A child frame whose state differs draws the base state's bounding sphere
  for transparent sorting on the GPU path; its groups' visibility uses its own.
* The vertices of a blend channel past its own count are published by the
  call that covers them last; the original gives each call a fresh buffer.
  They agree whenever a blend channel's count is its main count (keyframes)
  or its valid count is unchanged between the calls (tweens), which the test
  checks; a blend slot with a lower valid count than the main channel
  between differing child and main counts is not covered.
* ViewportWindow frames (security camera views, `viewportPass`) select no LOD
  of their own yet: they draw the base state.
* Actor Volumetrics (fog on meshes, `[sprite+0xb4]`, passed by DrawActorSprite
  with the frame's sprite) are not computed in any frame, the main one
  included, so there is no per-frame difference to reproduce
  ([mesh lighting](mesh-lighting.md#not-reproduced--open)).
* The first-person weapon is not selected: its overlay frame has no LOD
  inputs in Play; at its depth the original's ratio keeps it at full detail
  (not measured).
* GetFrame runs when the pose or the requested count changes, not every
  frame (an existing Play rule); the morph and corners follow the detail
  every frame it changes.
* The particle and wire/orthographic branches are not ported.

**Checks.** `node scripts/validate-lodmesh-lod-play.mjs [--map M] [--query
gpuMesh=0] [--mirrors] [--mlod 0.25,3]` (worker mode): from the start, four
directions and twelve far actors, lod-probe.mjs reports each drawn binding's
inputs and results; the same inputs through the original ranges must give the
same detail bits, count, flags, start, admitted faces and vertices, and the
page must draw them (the CPU geometry's corners, or the GPU corner pass's
dwords). Each child frame's selection and final state (with the count its
GetFrame call returned) go through the oracle too, and the page's pass for
that frame (`meshPassProbe`: what the slot or the geometry holds once the
pass's lighting run is done) must hold that state, also when it differs from
the main frame's. `--mirrors` views the map's mirror polygons from in front
instead of the far actors, each at URender's MLOD 0.25, 1, 3 and 10 (the
shipped 0.25 alone rarely changes a reflection's detail; `lodProbe` sets the
renderer settings on the simulation side). The GPU passes are compared with
the CPU path by `validate-gpu-mesh` (below and
[GPU mesh](gpu-mesh.md#distance-lod)), also in a child frame's own LOD state;
the merge of several GetFrame calls by `test/lodmesh-calls.test.mjs`.

| Run (worker mode, Linux host) | Result |
| --- | --- |
| Island, GPU path | PASS: 105 drawn rows over 17 views, 13 meshes; 56 with the LOD flag and morphing, 5 below ModelVerts (down to 11); 99 GPU corner-pass comparisons |
| Island, `gpuMesh=0` | PASS: the same 105 rows; 99 comparisons of the page's CPU geometry |
| BatteryPark, GPU path | PASS: 99 drawn rows over 17 views, 8 meshes, all at full detail. The view writes did not change the drawn set (the boat, Anna, JC and near props in every view), which suggests the start's arrival camera holds the view; not investigated |
| Training, `--mirrors` (16 views x 4 MLODs; the player in the mirrors) | PASS: 70 child-frame states equal the original's, 20 different from the main frame's (the player: 336/330/142 counts, with and without a morph); the GPU page passes drew them (140 compared, 12 of a differing frame), the CPU geometry too (180 compared, 36 of a differing frame) |
| Paris Club, `--mirrors` (10 views x 4 MLODs; the player, Female1, Faucet7, TrashCan1) | PASS: 84 drawn rows, 47 morphing, 44 below ModelVerts; 39 child-frame states equal the original's, 12 different from the main frame's; the GPU passes drew them (143 compared, 38 of a differing frame), the CPU geometry too (144 compared, 44) |
| `validate-gpu-mesh` (Training, Island, `?sim=inline`) | PASS: on Island 298,758 final-pose components and 564,747 corner dwords equal the CPU path, colours 0 bytes off, visibility 0 mismatches; 201 LOD captures, all morphing, 96 with dropped faces; and in a child frame's own LOD state (5,448 variants of the compared actors, 1,816 morphing, then the main state back): 896,274 pose components, 1,694,241 corner dwords and 542,991 corner bytes equal, 0 drawn disagreements, the restore exact |
| `test/lodmesh-calls.test.mjs` | 17 ticks of 1 to 3 GetFrame calls (keyframes, tweens, blend slots, count changes), JavaScript and Wasm: the merged plan's cache scalars, cache poses and published output equal the calls in order; a call that cannot merge restores the cache |

**Cost** (interleaved A/B on the Linux host, AMD Radeon 780M, Island's
start idle at 1440×960, worker mode, GPU path, `?meshLod=off` against the
default, medians; `.cache/ab-lod.mjs` over `profile-play-browser.mjs`):

| | LOD off | LOD on |
| --- | ---: | ---: |
| page actors phase (4 pairs) | 0.43 ms | 0.46 ms |
| worker actors phase (4 pairs) | 3.92 ms | 3.97 ms |
| GPU per frame (3 pairs, `--gpu`) | 2.02 ms | 2.05 ms |
| frame interval | 16.7 ms | 16.7 ms (vsync) |

**Cost of the child frames** (interleaved A/B, 5 pairs of 400 frames, medians,
Linux host, worker mode, GPU path, 1440×960, Paris Club;
`.cache/ab-mirror.mjs` over `profile-play-browser.mjs`):

| | before | after |
| --- | ---: | ---: |
| bar mirror (58, −1008, 27), master 0df0107 → this change; one child frame, nothing differs: page mirrors phase | 2.93 ms | 3.06 ms |
| the same: worker actors phase | 1.81 ms | 1.88 ms |
| the same: page frame work | 7.65 ms | 7.52 ms |
| restroom mirror (−1424, −1064, −100, yaw 32768) at MLOD 10 (`--lod-settings`), the previous commit's main-state draw → per-frame states; TrashCan1 and others differ per frame: page mirrors phase | 2.65 ms | 2.63 ms |
| the same: worker actors phase | 1.66 ms | 1.73 ms |
| the same: page frame work | 5.67 ms | 5.63 ms |
| frame interval, all runs | 16.7 ms (vsync) | 16.7 ms (vsync) |

The runs spread over 2.4–3.2 ms (mirrors) and 1.5–1.9 ms (worker actors), so
the differences are inside the noise; the engaged case adds the morph and
corner passes to a child pass's lighting run for the slots that differ.

The first GPU version walked the per-vertex LOD lists whenever the LOD flag
held and cost 2.00 → 2.86 ms per frame; the vertex and corner passes now
take the exact lists unless the count is below ModelVerts (a morph alone
keeps every corner's own vertex).

