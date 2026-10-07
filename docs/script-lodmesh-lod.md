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

## Play (WIP, 2026-10-07 handoff)

State of the branch after the verified commit above (paused on request):

* **CPU mesh path (`?gpuMesh=0`) — wired, partly verified.** The simulation
  side (`src/viewer/actor-mesh-sim.mjs`, `src/viewer/actor-mesh-lod.mjs`)
  selects per drawn binding from the main frame's master-frame Coords and FX
  (`sim-session.mjs` visibility) and the player's FovAngle, calls GetFrame
  with the requested count, morphs a copy of its output (GetFrame's own
  output stays unmorphed for later frames), resolves the corners with the
  kernel's `lod` facade, lights the reduced faces (dropped faces become
  zero-area `PF_Invisible` faces) and sends `record.lod` (resolved corners,
  wedge dwords) to the page, which draws the resolved corners and U/V bytes
  (`actor-mesh-draw.mjs`; a dropped face collapses onto its group's first
  admitted corner, a group with none is hidden). `?meshLod=off` (main.mjs →
  sim-host `meshLod`) restores full detail. Mirror frames reuse the main
  frame's selection; the view model is not LOD-selected (its depth makes it
  full detail anyway — unverified).
* **Verified so far:** `node scripts/validate-lodmesh-lod-play.mjs --query
  gpuMesh=0` passed once on 01_NYC_UNATCOIsland in worker mode with the first
  version of its views (9 drawn LOD rows over 3 views, 6 meshes, 3 reduced
  topology, 3 morphing, none below ModelVerts): the probe's inputs through
  the original ranges gave the same detail bits, count, flags, start,
  admitted faces and vertices, and the page drew them. The validator now
  also looks at the 8 farthest actor meshes; that run was stopped, so the
  current version is **unverified**.
* **GPU mesh path (the default) — not done.** It still draws full detail:
  the selection runs only on the CPU path (`mode==='cpu'` in update), so Play
  with the GPU path is unchanged. Design recorded for the next step: per-channel
  GetFrame counts and fill starts in the pose pass (U9/U10), a morph pass into
  a separate final-pose target (alpha in w; inverse and start from
  `lodMorphScalars`-style CPU scalars), a corner-resolve pass writing the
  packed wedge dwords per slot corner (FaceLevel, CollapseWedgeThus chain, U/V
  lerp from the final pose's alpha), face/vertex/corner passes reading the
  resolved corners (vertex and corner passes over a static superset adjacency
  per vertex — every (face, corner) whose wedge chain reaches it — with a
  match test while the LOD is active), the draw shader fetching vertex and
  U/V from the corner dword, certificate boxes over each group's chain/target
  closure, exact spheres from the LOD corners, and validate-gpu-mesh compares
  for LOD-active actors.
* **Not done:** cost measurement (interleaved A/B), gpu-mesh.md, README and
  roadmap entries, a full Play pass on 02_NYC_BatteryPark.
