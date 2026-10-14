# Original character mesh LOD selection and morphing

Authority: hash-pinned Render.dll `607f1077…d75d1`, Engine.dll `0c3a8b18…c20b4`
and Core.dll `8bf3039e…7e4` (see [surface/skin selection](script-lodmesh-materials.md)).
This is the distance LOD of `URender::DrawLodMesh` (`0x10b0ea80`, reached only
through `URender::DrawMesh` `0x10b0d1a0`). Re-derived from the disassembly on
2026-10-07; the earlier draft of this page assumed 64-bit precision and
mis-stated the morph gate and appTan's store. Added 2026-10-14: GetFrame's
buffer is in the drawing frame's camera space ("Camera space" below), the
first-person weapon selects like any actor, and the particle and wire
branches are unreachable in the shipped game.

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

## Camera space: the Coords GetFrame is called with `0x10b0ed53..0x10b0ee0f`

Added 2026-10-14. DrawLodMesh calls GetFrame with the FCoords of the frame
that is drawing the actor, so the buffer it fills, and everything after it,
is in that frame's camera space:

* `0x10b0ed53..0x10b0ed83`: the viewport actor (`[Frame]+0x30`)'s RendMap
  (`+0x600`) equal to 13, 14, 15 or 1 sets the wire flag `[ebp-0x38]`;
* `0x10b0ed8a..0x10b0edbc`: the output block, 88 bytes (`push 8`, alignment)
  for each of N + SpecialVerts vertices from the frame's GMem;
* `0x10b0edd8..0x10b0edf3`: `esi` = GMath.UnitCoords (`[0x10b5d4d4]+0x18`)
  when the wire flag is set, else the caller's Coords (`[ebp+0x1c]`,
  `Frame+0x34` from DrawActorSprite);
* `0x10b0edf3..0x10b0ee0f`: `rep movs` of those 12 dwords onto the stack (the
  FCoords by value), the stride `0x58`, the block and the in/out count, then
  the call through the Engine import `0x10b5d6b4` (ULodMesh::GetFrame).

The morph (`0x10b0ee34..`), the outcode and projection loop (`0x10b0ef6e..`),
the face normals and back-face tests (`0x10b0fe60..`), the vertex lighting
(`0x10b10834`) and the draw loop (`0x10b10ae9`) all read the points GetFrame
wrote at `+0x00`. Nothing in the loop turns them back into world space.

GetFrame composes the Coords into its matrix, so a vertex rounds once on its
way from the mesh's int16 frame to camera space. Every float store of
`ULodMesh::GetFrame` (`0x10355360..0x103568e5`), with the order of the work
between them (render pass, precision control 24):

| Addresses | Stores | What |
| --- | --- | --- |
| `0x10355520..0x10355584` | `fst [ebp-0x44]` `0x1035553d`; `fstp [ebp-0x2c], [ebp-0x28], [ebp-0x24]` `0x10355572`, `0x10355578`, `0x10355584` | scale = DrawScale (the double 1.0 at `0x104298a0` when the animation actor's bParticles, `+0x194` bit 2, is set), stored; mesh Scale x, y, z (computed z, y, x) times it, each stored |
| `0x10355587..0x10355606` | `fstp [ebp-0x198], [ebp-0x194], [ebp-0x190]` `0x103555c3`, `0x103555d3`, `0x10355600` | the caller's Origin less (Location + PrePivot): the sums (`0x1035558d..0x103555a5`) stay on the x87 stack, the three differences are stored |
| `0x10355610..0x1035566b` | Core calls `0x10599b48` (twice: `*=` the actor's Rotation, then the mesh RotOrigin `+0x118`) and `0x10599b4c` (`*=` FScale) | the Core FCoords operators; their stores are Core's (`0x1011ac80` rotation, `0x1011c0a0` scale, the pinned sine table) |
| keyframe, whole frame `0x10355b50..0x10355c4f` | `0x10355b7f`, `0x10355b94`, `0x10355ba0` the int16 words as floats (the cached pose); `0x10355bb9`, `0x10355bc5`, `0x10355be0` the pose less the mesh Origin (`+0x10c..0x114`); `0x10355c4a`, `0x10355c4c`, `0x10355c4f` the output | TransformPointBy is inline (`0x10355bef..0x10355c13`): the Origin subtraction of the matrix and the three dot products stay on the stack, only the three results are stored |
| keyframe, interpolated `0x10355c76..0x10355df6` | the words `0x10355cb4`, `0x10355cc5`, `0x10355ce4`, `0x10355cf3`; differences Y, Z `0x10355d04`, `0x10355d0d` (X stays on the stack); products Y, Z `0x10355d19`, `0x10355d25` (X stays); sums `0x10355d2a`, `0x10355d3d`, `0x10355d4c` into the cache pose; less Origin `0x10355d5d`, `0x10355d69`, `0x10355d87`; output `0x10355df1`, `0x10355df3`, `0x10355df6` | `(b - a)·alpha + a`, alpha the fraction stored at `0x10355b1e` (`0x10355afb`: the phase `frame·NumFrames`; `0x10355b09`: FISTP of phase less the float .5 at `0x1047a158`) |
| tween scalars `0x103556b7..0x10355763` | `fstp [ebp+0x40]` `0x103556fe` (alpha = 1 − AnimFrame/cachedFrame, the double 1.0 `fsubr`); `fstp [edi+4]` `0x10355730` (the reset frame); `fst [edi+0x10]` `0x10355753` (the completion `(1 − completion)·alpha + completion`, compared with .97f after the store) | the cache entry's scalars, in this order |
| tween fill `0x10355788..0x103557d4` | `0x103557a3`, `0x103557b8`, `0x103557c8` | the words of the target frame as floats, into the cache pose for newly requested vertices |
| tween, alpha 0 `0x10355807..0x103558bb` | less Origin `0x1035582b`, `0x10355837`, `0x1035584c`; output `0x103558b6`, `0x103558b8`, `0x103558bb` | the cache pose published |
| tween, alpha > 0 `0x103558e5..0x10355a1c` | words `0x10355923`, `0x10355932`; differences Y, Z `0x1035594d`, `0x10355956`; products Y, Z `0x10355962`, `0x1035596e`; sums into the cache `0x10355973`, `0x1035597e`, `0x10355987`; less Origin `0x10355992`, `0x1035599e`, `0x103559b0`; output `0x10355a17`, `0x10355a19`, `0x10355a1c` | the same interpolation from the cache pose |
| blend slots `0x10356020..0x10356879` | the same arithmetic per slot (fill, tween, keyframe, interpolated) with the slot's frame-0 vertex in place of the Origin; each vertex's TransformVectorBy result `0x10356239..0x1035623e`, `0x103563ec..0x103563f1`, `0x10356641..0x10356646`, `0x10356858..0x1035685d`, then the sum with the output `0x10356249..0x1035625a`, `0x103563ff..0x10356416`, `0x10356654..0x1035666b`, `0x10356868..0x10356879` | the additive blend, slots in ascending order |

`lodMeshFrameMatrix`, `createPublisher`'s `publishVertex` and `interpolate` in
`src/runtime/lodmesh-frame.mjs` are these rounds in this order; the oracle
cases below execute the function itself.

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
which collapses wedges below the count without testing the LOD flag. Neither
is reachable in the shipped game ("Branches not ported" below).

## Branches not ported: no shipped data reaches them

Measured 2026-10-14 with `node scripts/census-lodmesh-branches.mjs` (the
installed game; nothing is written). Each branch has one gate in
DrawLodMesh, and one way to be set in a shipped game.

**Particle branch** (`test [actor+0x194], 4` at `0x10b0f7a0`, then
`0x10b0f7ad..`: the actor's Texture is drawn as a sprite at each vertex,
using the same count). The bit is Actor.bParticles. In the shipped data:

* 0 of 1,502 classes in the 38 script packages set bParticles in their
  defaults (own or inherited);
* 0 of 131,514 map actors in the 88 maps carry a bParticles tag;
* 0 of 8,469 decoded script functions and states store it (no Let to an
  InstanceVariable or through a Context), and no string constant names it
  (a `set` console string);
* the native stores to `+0x194` in Engine.dll and DeusEx.dll are the
  bit-by-bit copies of the Actor assignment (`and ecx, 2 / 4 / 8 / 0x10 / 0x20`
  clusters at Engine.dll `0x10324212`, `0x10325529`, `0x10327512`,
  `0x103295ee`), which take the source actor's bits (the class defaults and
  map tags above), and `GC.DrawActor` (Extension.dll `0x1002aa60`), which
  sets and restores bit 0 (bUnlit) only. The other `+0x194` sites in
  Extension.dll (word stores and float loads at unrelated offsets) were not
  traced, so a native store of the bit there is unexcluded by this census.

Island's earlier census agrees ("No actor has bParticles",
[GPU mesh](gpu-mesh.md#why)). Play draws such an actor as an ordinary mesh;
the branch stays unported and explicitly unsupported.

**Wire / orthographic branch** (the wire flag `[ebp-0x38]`, set when the
viewport actor's RendMap, `+0x600`, is 1, 13, 14 or 15, `0x10b0ed5b..0x10b0ed83`;
GetFrame then gets GMath.UnitCoords). RendMap is set by:

* `SpawnPlayActor` / Login to 5 (`0x103971a7`), and by no script (0 stores
  in 8,469 functions);
* `UCanvas::execDrawActor` (`0x10377f6f`: `bWireframe` sets RendMap 1 for
  the call). Its only script callers are `Engine.Inventory.RenderOverlays`
  and `Engine.Weapon.RenderOverlays`, both with the literal `false`; the other
  native caller of the renderer's DrawActor, `GC.DrawActor` (Extension.dll
  `0x1002aa60`), writes neither RendMap nor bParticles;
* the console command `RMODE n`, 0 < n < 20 (UViewport::Exec `0x1037420f`).
  The shipped scripts issue only `RMODE 6` and `RMODE 5`
  (`DeusExPlayer.Matrix`), neither a wire value; Play's console
  (script-console-command.mjs) raises `UnsupportedConsoleCommandError` for
  RMODE as a claimed UViewport::Exec keyword;
* class defaults: no class sets RendMap; the 122 RendMap tags in the maps
  (values 1, 2, 5, 6, 13, 14, 15) all sit on the editor's `Camera` actors,
  which no game viewport attaches to.

So the branch is reachable only by a player typing `RMODE 1` or
`RMODE 13..15` at the console. Play has no such command; the branch stays
unported and explicitly unsupported (a viewer with RendMap 5, as
[bsp-occlusion.md](bsp-occlusion.md) records for the orthographic maps).

## The first-person weapon

Added 2026-10-14. `Weapon.RenderOverlays` (and `Inventory.RenderOverlays`)
call `Canvas.DrawActor(self, false)`; `UCanvas::execDrawActor` (Engine.dll
`0x10377ed0`) clears the actor's bHidden bit (`+0x28` bit 1) for the call,
and calls the renderer's DrawActor (vtable `+0x74`, at `0x10377fae`) with the
canvas's Frame (`Canvas+0x7c`, the Frame `UGameEngine::Draw` gave
`Canvas->Update` at `0x1038f68e`: the master frame). Render.dll `0x10b262c0`
builds an FDynamicSprite on that Frame and calls DrawActorSprite, which hands
`Frame->Coords` to DrawMesh like any sprite's. DrawLodMesh therefore selects
the weapon's detail exactly as it does for a world actor: from the master
frame's Coords and FX (`+0xb8`), the viewport actor's FovAngle, the settings
of URender, and the weapon's own Location (set by `SetLocation` in
RenderOverlays just before), DrawScale and LODBias. There is no term of its
own for the weapon's render pass. (RenderOverlays itself returns for a
DesiredFOV other than DefaultFOV, so the FOV is the default one.)

Play: `weapon-overlay-sim.mjs` gives the weapon's binding the master frame's
inputs (`sim-session.mjs weapon()`: the visibility pass's Coords and FX, the
player's FovAngle, URender's settings), so it selects, morphs and lights in
camera space like the world's actors; `?meshLod=off` turns it off with the
rest. The crowbar in Training, shipped settings: detail 14,240 for 138
vertices, requested 138; the selection sets the morph flag (the ratio is
below 1.43) and the morph start, `(1 − 0.3)·14,240`, is not below the count, so
GetFrame's return clears it and the weapon is drawn at full detail with no
morphed vertex: the original keeps the first-person weapon unreduced at its
distance, as the earlier note assumed. `validate-weapon-lod` runs the overlay
simulation on the crowbar with six URender settings (shipped and MLOD 1 to
4,096) on the JavaScript and Wasm paths: six of the twelve selections reduce
the weapon below ModelVerts, and the detail bits, counts, flags, start,
admitted faces and vertices equal the original ranges' in all twelve. In
worker mode `validate-lodmesh-lod-play --map 00_Training --weapon` (the
crowbar taken and equipped through the probe) has the 17 views' weapon rows
through the same oracle.

Not measured: other weapons (every `DeusExItems` LodMesh, 158 of 158, has LOD
data; at a hand's distance each is expected at full detail as the crowbar
is, but only the crowbar is run), and the GPU view-model instance's
camera-space passes against the original (they are the world actors' passes
on the weapon's own GPU mesh instance).

## Translation and reference cases

* `src/runtime/lodmesh-lod.mjs` (the reference): `selectLodMesh`,
  `morphLodMesh`, `lodMeshCorners`, `lodMeshTopology`, `lodMeshTanArgument`,
  `lodMeshTanFactor`, `RENDER_LOD_SETTINGS`.
* `src/runtime/lodmesh-frame.mjs`: `lodMeshCameraMatrix` (a frame's GetFrame
  matrix from its Coords) and `publishLodMeshOps` (the cache poses of earlier
  operations published through it).
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
| `node scripts/validate-lodmesh-lod.mjs --camera-chain` (2026-10-14; the six meshes, 6 poses for each character and 4 for each prop: keyframes, tweens, additive blends; three cameras: a map position, a pitched one, a mirror frame's reflected Coords) | the original GetFrame (`native-lodmesh-frame-oracle.py`, `0x007f`) is run on every pose with the camera's Frame->Coords over a pattern; the translation's GetFrame (JavaScript and Wasm) produces its 88-byte buffer byte for byte; the original morph and face ranges then run on that buffer for 7 cases per pose (the morph regimes, the floor, rotated Coords, a short GetFrame return): 210 cases, 180 reduced, 172 morphing (4,956 vertices), every buffer byte, face, material, flag and wedge dword equal for JS and the kernel |
| `node scripts/validate-lodmesh-frame.mjs [--wasm]` | 61 complete GetFrame calls, 15 of them in camera space (large origins, pitch, reflected Coords; keyframes, reduced counts, tweens, four additive blends): every output byte, cache byte and scalar equal |
| `test/lodmesh-camera.test.mjs` | the cache poses published again through a frame's matrix (`publishLodMeshOps`) equal GetFrame called with that frame's Coords on 4 cameras and 7 ticks (keyframes, tweens, blends, count changes), JavaScript and Wasm |

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

**Two spaces (2026-10-14).** The cache poses are published twice: through the
identity matrix into world space, which the draw, the environment mapping and
the culling bounds use, and, for each frame that lights the actor, through
that frame's own matrix (`lodMeshCameraMatrix`: `lodMeshFrameMatrix` with the
frame's Coords, 12 floats the lighting frame already holds), which is what the
original's GetFrame call for that frame fills. The morph runs on both; the
lighting reads the camera-space one (see "Camera space" above for the
original). Since 2026-10-14 the GPU draw projects it too: a corner's point is
`cameraFinal`'s, through the original's projection
([frame projection](frame-projection.md)), as DrawLodMesh's draw loop does. The
environment mapping's world-space inputs are an existing tolerance item
([GPU mesh](gpu-mesh.md#tolerances)), and the CPU path and unlit slots project
the world pose.

**CPU path** (`?gpuMesh=0`, and any binding off the GPU path): GetFrame's
world-space output stays unmorphed (a later frame's GetFrame or LOD reads it
again); the morph runs on a copy, the kernel's `lod` facade resolves the
corners. For the lighting, `publishLodMeshOps` publishes the operations of the
frame's GetFrame call (`getLodMeshFrame`'s `ops`; the merged plan's channels
after a fallback) from the cache poses through that frame's matrix into a
fresh buffer, `meshLod.after` morphs it with the frame's own selection and
returned count, and the kernel lights it with `cameraSpace` set (the points
are used as they are) over the reduced faces (a dropped face becomes a
zero-area `PF_Invisible` face, which adds nothing to the normals and is never
drawn). The frame record's `lod` carries the resolved corners and wedge
dwords; the page draws each corner at its resolved vertex with its U/V bytes
(actor-mesh-draw.mjs). A dropped face collapses onto its group's first
admitted corner (zero area, bounds unchanged); a group with no admitted face
is hidden on both sides.

**GPU path** (the default): the plan carries each channel's count and fill
start, the record's `lodParams` the post-frame scalars (`lodMorphScalars`:
count, start, flags, the 24-bit inverse), each frame's lighting its GetFrame
matrix (slot parameters F12..F15), and the GPU passes do the rest (the world
pose and morph for the draw, then for the lit frames the camera pose and
camera morph passes, the corners, the normals and the lighting over the
resolved corners; [GPU mesh](gpu-mesh.md#distance-lod)).

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

* *Space of the drawn positions.* The morph, the lighting and, on the GPU
  path, the drawn positions are in the original's camera space since
  2026-10-14 ("Two spaces" above, [frame projection](frame-projection.md)).
  The environment mapping, the culling bounds and the CPU path's positions
  read the world-space publication and morph, which round in another
  space than the original's buffer. The lighting-side effect of the old host stage was
  large: of 10,188 camera-space components (six LOD meshes, three cameras)
  the world pose transformed to camera space (`toCamera`, 24 bits) differed
  from the original's buffer in 6,244, by up to 4,096 ulps of the small
  camera-space value.
* A child frame whose state differs draws the base state's bounding sphere
  for transparent sorting on the GPU path; its groups' visibility uses its own.
* The vertices of a blend channel past its own count are published by the
  call that covers them last; the original gives each call a fresh buffer.
  They agree whenever a blend channel's count is its main count (keyframes)
  or its valid count is unchanged between the calls (tweens), which the test
  checks; a blend slot with a lower valid count than the main channel
  between differing child and main counts is not covered.
* ViewportWindow frames (security camera views) select their own LOD, since
  2026-10-11: the actors a camera frame draws are updated again in the HUD
  paint, after the main frame's, with the camera frame's Coords and FX, the
  window's fov (the viewport actor's FovAngle while Draw holds it) and each
  child frame's own, the GetFrame calls following the main frame's
  (`actorScene.updateFrame`; [camera pass](script-window-viewport.md#camera-pass)).
* Actor Volumetrics (fog on meshes, `[sprite+0xb4]`, passed by DrawActorSprite
  with the frame's sprite) are not computed in any frame, the main one
  included, so there is no per-frame difference to reproduce
  ([mesh lighting](mesh-lighting.md#not-reproduced--open)).
* The first-person weapon selects since 2026-10-14 ("The first-person weapon"
  below); its camera-space lighting uses the main frame's Coords like the
  world's.
* GetFrame runs when the pose or the requested count changes, not every
  frame (an existing Play rule); the morph and corners follow the detail
  every frame it changes.
* The particle and wire/orthographic branches are not ported; no shipped data
  or script reaches them ("Branches not ported" below).

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
| `validate-mesh-path-frames` (inline simulation, paused clock, 90 frames; the bar mirror with the player's reflection and the restroom mirror at MLOD 3 and 10) | PASS: the CPU path's 1280x720 frame equals the GPU path's byte for byte in each (0 of 3,686,400 bytes), a child frame drawing another LOD state than the main frame's in the two MLOD views ([visual acceptance](visual-acceptance.md#cpu-and-gpu-mesh-paths-jcs-reflection-2026-10-08-a-capture-artifact-fixed-in-the-tool)); a CPU path that ignores the child frame's own state fails it (1,359 bytes) |
| `validate-gpu-mesh`, camera space (2026-10-14; Training, Island, `?sim=inline`) | the GPU camera final pose (the publication through the frame's matrix and the morph) equals its CPU twin (`publishLodMeshOps` + the LOD morph on the exact cache poses) in every published vertex: Island main frame 319,464 components, a reflected child frame (Mirror -1) 319,464, the child LOD states 958,392 (5,634 variants, 1,878 morphing), 0 ulp; the lighting reads these: colour bytes 0 off over 1.2 million corners, 0 drawn disagreements, restores exact; the lighting frame's Coords equal the LOD frame's on 939 compared actors |
| `node scripts/validate-weapon-lod.mjs` | the crowbar through the overlay simulation, JavaScript and Wasm, at the shipped settings and MLOD 1, 8, 64, 512, 4096: 12 selections, 6 below ModelVerts, equal to the original ranges |
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

**Cost of camera space (2026-10-14)** (interleaved A/B on the Linux host, AMD
Radeon 780M, worker mode, GPU path, 1440×960, 400 frames a run, medians;
the previous commit `fc0e745` served from an export of the tree against
this change, `profile-play-browser.mjs --gpu --no-profile`):

| Island's start, idle, 5 pairs | before | after |
| --- | ---: | ---: |
| page actors phase | 0.44 ms | 0.43 ms |
| worker actors phase | 4.17 ms | 4.29 ms |
| GPU per frame | 1.70 ms | 1.64 ms |
| page frame work | 3.39 ms | 3.41 ms |
| worker frame work | 15.92 ms | 15.99 ms |
| frame interval | 16.7 ms (vsync) | 16.7 ms (vsync) |

| Paris Club bar mirror (78, −1008, 27), 4 pairs | before | after |
| --- | ---: | ---: |
| page actors phase | 0.315 ms | 0.310 ms |
| worker actors phase | 2.04 ms | 1.92 ms |
| page mirrors phase | 3.09 ms | 2.85 ms |
| GPU per frame | 1.51 ms | 1.52 ms |

The only difference outside the run-to-run spread is Island's worker actors
phase, +0.12 ms: each lit actor's GetFrame matrix (`lodMeshFrameMatrix`, 1.3
to 1.7 µs a call in JavaScript, about 70 lit actors in view). A Rust port of
that function (`frame_matrix`, bit-equal to the JavaScript on 20,000 random
inputs) measured 1.6 µs a call, no faster, since the call's marshalling costs
as much as the arithmetic, and was not kept. The two extra GPU passes are
not visible in the GPU time.

The first GPU version walked the per-vertex LOD lists whenever the LOD flag
held and cost 2.00 → 2.86 ms per frame; the vertex and corner passes now
take the exact lists unless the count is below ModelVerts (a morph alone
keeps every corner's own vertex).

