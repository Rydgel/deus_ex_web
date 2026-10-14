# Render-pass precision (x87 precision control 24)

Started 2026-10-06. Everything the original runs between `URender::PreRender`
and `URender::PostRender` executes with x87 precision control 24 (control
word `0x007f` under the game's rounding), while most translations of that
code were validated with their oracles at `0x037f` (64-bit precision). This
page is the audit: which translated routines run inside the pass, how their
oracles and validators are configured, what the render-pass control word
changes, and what has been moved. [BSP occlusion](bsp-occlusion.md)
("Precision") records the first part of the evidence.

Authority: Render.dll `607f1077…d75d1`, Engine.dll `0c3a8b18…c20b4`,
Core.dll `8bf3039e…7e4`, Extension.dll and Galaxy.dll of the GOTY install,
and the installed `.u` bytecode. Addresses are virtual addresses at each
DLL's preferred base.

## Where the pass begins and ends

`UGameEngine::Draw` (Engine `0x1038f110`), in order:

| Address | Call | Precision |
| --- | --- | --- |
| `0x1038f1ac` | `PlayerCalcView` event on the viewport actor (camera, ConCamera script) | game thread |
| `0x1038f5dc` | `Render->CreateMasterFrame` (vslot `0x64`: ComputeRenderCoords/Size) | game thread |
| `0x1038f638` | `Audio->Update(Region, Coords)` (vslot `0x60`: Galaxy Update, music, lip sync) | game thread |
| `0x1038f66c` | **`Render->PreRender`** (vslot `0x5c`, `0x10b14560`) | sets PC 24 |
| `0x1038f685` | `Console->PreRender(Frame)` (native, vslot `0x58`) | 24 |
| `0x1038f68e` | `Canvas->Update(Frame)` | 24 |
| `0x1038f6b5` | `PreRender` event; PlayerPawnExt.PreRender calls native 1050 PreRenderWindows → XRootWindow::PreRender `0x1003a760` (from `0x10038336`): the frame edit, then **`FSceneNode::ComputeRenderSize` again** (`0x1003a8cd`) | 24 |
| `0x1038f6e5` | `Render->DrawWorld` (vslot `0x70`, `0x10b1cb90`): OccludeFrame `0x10b1ce3b` (SetupDynamics, OccludeBsp, child frames), DrawFrame `0x10b1ce44`, RenDev ClearZ (`0x10b1ce91`) and the `RenderOverlays` event `0x10b1cebd` | 24 |
| `0x1038f70c` | `PostRenderFlash` event (FName `0x105835b8`, built from the string at `0x1047cf6c` at `0x10380726`); PlayerPawnExt.PostRenderFlash calls native 1051 PostRenderWindows → XRootWindow::PostRender `0x1003a960` (from `0x100383b6`) → PaintWindows → DrawWindow scripts → GC natives | 24 |
| `0x1038f714` | RenDev vslot `0xa4` | 24 |
| `0x1038f73e` | `PostRender` event on the viewport actor | 24 |
| `0x1038f74b`, `0x1038f772` | `Console->PostRender(Frame)` (native vslot `0x5c`) and the console's `PostRender` event | 24 |
| `0x1038f782` | `Audio->PostRender(Frame)` (Galaxy `0x10608570`: AudioStats drawing only) | 24 |
| `0x1038f79b` | **`Render->PostRender`** (vslot `0x60`, `0x10b14700`) | restores PC 64 |

`URender::PreRender` calls Core `appEnableFastMath(1)` at `0x10b14629`.
Its body (Core `0x1016e050`) is `_controlfp(Enable ? 0x20000 : 0, 0x30000)`:
`_PC_24` under `_MCW_PC`, rounding and exception masks untouched. Right
after it, at `0x10b146ae`, PreRender calls the light noise update
(`0x10b13080`, through the second light-manager object `0x10b30a08`), so
the noise runs at 24 bits too. `URender::PostRender` calls
`appEnableFastMath(0)` at `0x10b1472c`, which sets PC 64 explicitly, every
frame, whatever the word was before the first frame.

### Outside the pass

* **Light-manager tables.** `URender::Init` (`0x10b13460`) calls
  `GLightManager->Init` (vslot 0, `0x10b02080`) at `0x10b1358d`, once, on
  the game thread before any frame. Measured with the oracle's builders
  (`native-dynamic-light-oracle.py`): the square-root (`0x10b3e1b8`),
  normal-falloff (`0x10b34a6c`), shadow-blur (`0x10b3cae0`) and x^-0.5
  tables are identical at `0x037f` and `0x027f` (real Windows' default); at
  `0x007f` the square-root table differs in 248 of 2048 entries and the
  normal table in 3,249 of 4,096. The oracles therefore build them at an
  init word (`0x037f`) separate from the per-frame word. Open: whether D3D's
  `DDSCL_FPUSETUP` (`0x1000b18e`) ran before URender::Init.
* Galaxy Update's ambient-sound volume, which calls URender::GlobalLighting
  from Audio->Update (`script-audio-live.mjs`): before PreRender, so it runs
  the shared `lightTypeBrightness` with `precision: 'pc64'` (validated against
  the oracle at `0x037f`, validate-light-animation's 2,560 game-thread
  frames) and the previous frame's noise table A.
* PlayerCalcView, CreateMasterFrame, Galaxy Update (lip sync, music), the
  level tick (physics, script Tick, ParticleGenerator.Tick → native 3017
  UpdateParticles, animation tick, TweenBlendAnim), AttachDecal/DetachDecal,
  mesh loading and Fire.dll's module tables (first construction).
* After the first frame the game thread starts each tick at PC 64 (the
  PostRender reset above). Nothing between PostRender and the next tick
  has been traced for further control-word changes, so the game thread's
  word stays the open item recorded in [dynamic lighting](dynamic-lighting.md).

## What precision control 24 changes

* FADD, FSUB, FMUL, FDIV and FSQRT (and their reversed, popping and memory
  forms) round their result to a 24-bit significand. The register keeps its
  15-bit exponent, so results beyond binary32's range or below its normal
  range are not overflowed or denormalized until an FST to memory.
* Loads are exact (FLD m32/m64/m80, FILD, FLD1/FLDZ); FIST/FISTP round by
  the rounding control; transcendentals (FSIN, FCOS, FPTAN, FPATAN, F2XM1,
  FYL2X), FPREM, FRNDINT and FSCALE are not affected.
* An operation on binary32 operands whose result is stored straight to
  binary32 gives the same bits at either precision (64 ≥ 2·24 + 2), except
  for subnormal and overflowing results. Differences therefore come from
  unstored chains, operands that are not 24-bit values (double constants,
  integers above 2^24), and compares of unstored values.
* Port rule: binary32 arithmetic in the original's operation order for
  values in binary32's normal range (`f32` in Rust, `Math.fround` per
  operation in JavaScript); a double constant or a wide integer operand
  needs a correctly rounded 24-bit result of the exact operation, not of a
  double intermediate. GPU kernels that mirror a CPU kernel follow the CPU
  contract ([GPU meshes](gpu-mesh.md)).

## The audit switch

`ORACLE_CW=0x007f node scripts/validate-<name>.mjs` runs a supported
validator's oracle with its render-pass segments at that word and counts
mismatches instead of failing (`scripts/precision-audit.mjs`: `auditAssert`,
`tally`, `report`). Python oracles read the variable through
`render_control_word()` in `native-collision-oracle.py` or take it as their
control-word argument; `NativeCollision` calls use `self.control_word`.
Light-manager tables stay at the init word (`init_control_word`, `init_run`
in `native-dynamic-light-oracle.py`). Without the variable every validator
is unchanged and passes.

## Inventory

"Oracle CW today" is the word the default run uses. "At 0x007f" is the
audit's measurement of the current translation against the original at the
render-pass word (tables at `0x037f`), on the validator's own cases.

### Light maps and lights

| Routine | Placement | Doc | Oracle (CW today) | Validator | Ports | Port precision | At 0x007f |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Light-manager tables (sqrt `0x10b0225b`, normal `0x10b022fe`, shadow `0x10b02112`/`0x10b02352`, x^-0.5 `0x10b022d0`/`0x10b024b0`, fog attenuation `0x10b020cf`) | init (URender::Init `0x10b1358d`) | [dynamic lighting](dynamic-lighting.md), [static lighting](static-lighting.md) | dyn, mesh-light, fog oracles; now always `init_control_word` 0x037f | dynamic-, static-, mesh-lighting | `dynamic-lighting.mjs` `squareRootTable`/`normalLightTable`, `static-lighting.mjs` `shadowTable`/`rsqrtTables`; copies in fog.rs, meshlight.rs, lodmesh kernel, GLSL `TABLES` | f64/x87 model, exact | keep 0x037f (0x027f identical) |
| Engine FGetHSV `0x103ec8d0` (called at `0x10b05ee8` GlobalLighting, `0x10b07fcc` SetupForSurf ambient, `0x10b08dee` SetupForActor) | pass | dynamic lighting | dyn `fgethsv`, **0x007f** | validate-dynamic-lighting | `dynamic-lighting.mjs` `fgetHsv` **PC 24** (mesh lighting too) | was: 1,789 of 2,049; **now 0** |
| ComputeFromActor `0x10b05fa0`: R, 1/R, rr2 `0x10b05fc3–0x10b0602c` | pass | dynamic lighting | dyn `radius_constants`, **0x007f** | validate-dynamic-lighting | `movingLightConstants` **PC 24** | was: rr2 121 of 256; **now 0** |
| ComputeFromActor brightness/colour/table `0x10b060b1`, `0x10b06122`, `0x10b064ff` | pass | dynamic lighting | dyn `color_table`, **0x007f** | validate-dynamic-lighting, static | `movingLightConstants`, `colorTableEntry` **PC 24** | 0 |
| ComputeFromActor incidence `0x10b06325–0x10b0639e` | pass | moving normal lighting | dyn `incidence`, **0x007f** | validate-static-lighting | `normalLightIncidence` (= `renderPassConstants`) **PC 24** | was: 415 of 1,947; **now 0** (15,745 Training steps) |
| ComputeFromActor rectangle `0x10b0660e–0x10b06868` | pass | dynamic lighting | dyn `rect`, **0x007f** | dynamic, static | `movingLightRect` **PC 24** | 0 (34,405 static steps on 5 maps) |
| Ambient fill `0x10b07fd2–0x10b080cf` | pass | static lighting | dyn `ambient`, **0x007f** | validate-static-lighting | `ambientTexel` (exact at either precision) | 0 |
| Illumination `0x10b02650` | pass | static lighting | dyn `illumination` | validate-static-lighting | `shadowIllumination` | integer | 0 of 15,754 masks |
| Normal `0x10b03360`, NonIncidence `0x10b054e0`, spot `0x10b04f80`, cylinder `0x10b04a80` | pass | static, moving normal lighting | dyn `spatial_merge`, `spot_merge`, **0x007f** | static, dynamic, normal-moving | `normalLightSpatial`, `nonIncidenceSpatial`, `spotLightSpatial`, `cylinderSpatial` **PC 24** | was: 11 of 1.28 M texels; **now 0** (36.3 M texels on 5 maps) |
| Merge `0x10b03040`, merge modulation `0x10b030f2–0x10b03244` | pass | static lighting | dyn `spatial_merge`, `merge_mod`, **0x007f** | static, light-animation | inline merge, `mergeModulation`, `mergeFactor`, light.rs `light_merge`/`light_modulation` **PC 24** factors | 0 |
| Light noise `0x10b13080` (from PreRender `0x10b146ae`) | pass | static lighting "Light animation" | dyn `noise`, **0x007f** | validate-light-animation | `createLightNoise` **PC 24** | 0 of 320 frames (an hour-long clock included) |
| GlobalLighting `0x10b05e90`, LightType table `0x10b2a284` (`0x10b05a10` Pulse, `0x10b05a90` Blink, `0x10b05af0` Flicker, `0x10b05b30` Strobe, `0x10b05b90` SubtlePulse) | pass | static lighting | dyn `light_type`, **0x007f** | validate-light-animation | `lightTypeBrightness` **PC 24** | was: 259 of 2,560 frames; **now 0** |
| Spatially dynamic effects (Searchlight … Shell) | pass | static lighting (spatial branch) | dyn `spatial_dynamic`, **0x007f** | validate-light-spatial | spatial.rs | binary32 | other branch, at 0x007f already |
| FDynamicLight::Filter `0x10b24a10` | pass (OccludeBsp) | dynamic lighting | dyn `filter`, **0x007f** | dynamic, mesh-lighting | `filterMovingLight`, `movingLightLeaves` **PC 24** | 0 |
| Light colour cache decision `0x10b06427–0x10b06600` | pass | [light cache](script-light-cache.md) | light-color-cache (Unicorn default 0x037f) | validate-script-light-cache | host invalidation | labels only | not measured (branch labels) |

### Volumetric fog

| Routine | Placement | Oracle (CW today) | Validator | Ports | Port precision | At 0x007f |
| --- | --- | --- | --- | --- | --- | --- |
| ComputeFromActor volumetric tail `0x10b06873–0x10b068dd`, `0x10b06a35–0x10b06c1c` | pass | volumetric-fog oracle, **0x007f** since the move | validate-volumetric-fog | `volumetric-fog.mjs` `volumetricLight` | **PC 24** (x87-pc24.mjs) | was: invRadiusSq 92, distanceSq 71 of ~240 lights; **now 0** |
| Fog loop `0x10b073bb–0x10b07c44`, the grid and light transforms | pass | same | validate-volumetric-fog, validate-volumetric-fog-fast | JS `fogMap`, `coordsTransform`; fog.rs `texel_index` over `Single`/`Wide`/`Exact` | **PC 24** | was: 0 of 11,533 oracle texels, 498 of 41 M captured Play texels; **now 0** |
| FLightManager::Fog `0x10b02c00` | pass (DrawLodMesh `0x10b10a2f`) | fog oracle **0x007f**; mesh-fog oracle (default 0x007f, no validator) | validate-volumetric-fog | `fogVertex` (not in Play) | **PC 24** | was: 528 of 960 vertex planes; **now 0** |
| Fog map draw (D3D, GLSL `fog-pass.mjs`) | pass | — | validate-volumetric-fog-play | fog-pass.mjs | channel doubling only | — |

### Meshes

| Routine | Placement | Oracle (CW today) | Validator | Ports | Port precision | At 0x007f |
| --- | --- | --- | --- | --- | --- | --- |
| ULodMesh::GetFrame `0x10355360–0x103568e5` (Render's only call through its import is DrawLodMesh `0x10b0ee0f`; no other DLL imports it; virtual-call sites of UMesh::GetFrame `0x103a7780` not traced) | pass | lodmesh-frame oracle, **0x007f** | validate-lodmesh-frame (and `--wasm`), validate-gpu-mesh | `lodmesh-frame.mjs`; lodmesh-kernel `pose_single`/`pose_ext24`; GLSL `POSE_FRAGMENT` | **PC 24** (binary32; Ext24 fallback) | was: 20 of 46 calls (7,562 of 29,823 output words, max 1,257 ulps); **now 0**; GPU 227,862 of 227,862 components equal the CPU; 2026-10-14: 61 calls including 15 with camera Frame->Coords, and the camera-space GPU passes equal the CPU twin |
| DrawLodMesh normals `0x10b0fe60–0x10b0ff85`, `0x10b10863–0x10b10912`, back-face dot `0x10b0ffa3` | pass | mesh-light oracle, **0x007f** | validate-mesh-lighting, validate-gpu-mesh | `accumulateFaceNormal`, `faceDot`, `vertexNormalPlane`; kernel `light_mesh_job`; GLSL `FACE_FRAGMENT` | **PC 24** | was: face 278 of 400, vertex plane 208 of 400; **now 0** |
| SetupForActor `0x10b08c70` (ambient, candidates, AddLight, sort, ComputeFromActor) | pass | mesh-light oracle, **0x007f** | validate-mesh-lighting(-play) | `mesh-lighting.mjs` `setupForActor`; meshlight.rs `ml_select` | **PC 24** | was: camera-space light and colour words 1–8 ulps off; **now 0** (52 calls, 220 infos) |
| FLightManager::Light `0x10b027f0` | pass | mesh-light oracle, **0x007f** | validate-mesh-lighting, validate-gpu-mesh | `lightVertexX87` (BigInt PC 24 reference), `lightVertex`; kernel `light_vertex`; GLSL `VERTEX_FRAGMENT` (`divRN`) | **PC 24** | was: 1,545 of 3,744 channels; **now 0**; GPU 701,505 colour channels equal the CPU |
| D3D diffuse `0x10005942–0x100059ac` | pass | mesh-light oracle | validate-mesh-lighting | `d3dDiffuse`; kernel `diffuse_channel`; GLSL `CORNER_FRAGMENT` | exact | 0 |
| Environment mapping `0x10b101d3–0x10b10314`, `0x10b0bae9–0x10b0bbbc` | pass | mesh-environment oracle (tables at init, slices ORACLE_CW) | validate-mesh-environment (tolerance 0.00005 texel) | `mesh-environment.mjs`; GLSL `ENVIRONMENT_UV` | f64, not bit-exact | within tolerance |
| GetRenderBoundingBox `0x103a6850`, BoundVisible `0x10b162e0`, FDynamicSprite::Setup `0x10b23910` | pass | render-visibility oracle (0x037f, BoundsOracle rejects other words) | validate-render-mesh-bounds, validate-render-visibility | JS reference (not in Play); Rust occlude.rs and the Setup branch in binary32 | x87 model (JS) | superseded by the binary32 Rust ports (other worktree); JS references not re-measured |
| DrawLodMesh LOD selection `0x10b0eb52–0x10b0ed53`, morph `0x10b0ee34–0x10b0ef6e`, reduced corners `0x10b0fc6f–0x10b0fe60` ([LOD](script-lodmesh-lod.md)) | pass | lodmesh-lod oracle, **0x007f** (appTan's float from the real-x87 model) | validate-lodmesh-lod, validate-x87-tan-hardware ("lod" mode), validate-lodmesh-lod-play (worker), validate-gpu-mesh | `lodmesh-lod.mjs`; lodmesh-kernel `lod.rs`; GLSL `MORPH_FRAGMENT`, `RESOLVE_FRAGMENT` | **PC 24** (written at 24 bits from the start; Play's morph rounds world-space positions) | 0 of 228 cases; at 0x037f the oracle differs in 665 of 226,265 checks; GPU equal to the CPU path |

### Other render-pass routines

(The vertex chain from view space to D3DDrv's vertex buffer, `0x10b14de2–0x10b14f20`,
`0x10b10a53–0x10b10a96`, `0x10003c05–0x10003c41`, `0x10005822–0x10005869`, is in
[frame projection](frame-projection.md): oracle `native-frame-projection-oracle.py`
at **0x007f**, `validate-frame-projection`, binary32 per operation in
`frame-projection.mjs`, the GLSL chain bit-equal on the GPU.)

| Routine | Placement | Oracle (CW today) | Validator | Ports | At 0x007f |
| --- | --- | --- | --- | --- | --- |
| OccludeBsp `0x10b173d0`, ClipBspSurf, BoundVisible, span buffers | pass | occlusion oracle **0x007f** | validate-bsp-occlusion | occlude.rs (binary32) | done |
| ClipDecal `0x10b1bda0` and DrawFrame's decal block | pass | decal-render oracle **0x007f** | validate-decal-render | decal.rs (binary32) | done |
| Corona pass `0x10b1b46a–0x10b1bb06` (fade, helper `0x10b1bc00`, draw loop) | pass (DrawFrame) | coronas oracle, **0x007f** since the move | validate-coronas, validate-coronas-play (worker) | `coronas.mjs` **PC 24** | was: 92 of 200 frames' DrawIcon calls (299 of 305 icons); **now 0** |
| Mirror segment `0x10b1886d–0x10b18b93` | pass (OccludeBsp) | mirror oracle (0x037f; ORACLE_CW) | validate-mirrors (4-ulp tolerance) | `mirrors.mjs` (doubles) | within tolerance |
| Surface pan `0x10b1a59a–0x10b1a72a` | pass (DrawFrame) | surface-pan oracle, **0x007f** | validate-native-surface-pan, validate-texture-animation-play (worker) | `surfacePan` **PC 24** | was: 240 of 400 fabricated cases; **now 0** |
| UTexture Get/Update/Tick/ConstantTimeTick (`0x103212e0`, `0x103ecb70`, `0x103ed0d0`, `0x103ed330`) | pass: DrawFrame's `Texture->Update` (vtable `+0x78`), DrawActorSprite `0x10b2547b`; also UTexture::Lock (caller's word not traced) | texture-animation oracle (0x037f; ORACLE_CW) | validate-native-texture-animation | `texture-animation.mjs` (64-bit model, kept) | 0 of 3,988 Get calls; `now − last` of two doubles can still differ at 24 bits (open) |
| Fire.dll ConstantTimeTick (fire, water, wet) | pass (through Update) | fire oracle (0x037f; ticks ORACLE_CW) | validate-native-fire-texture | fire.rs (integer) | 0 of 1,178 cases |
| ULaserIterator::CurrentItem `0x1001a1a0` (with Core UnsafeNormal and FVector::Rotation `0x10144390`) | pass (SetupDynamics) | laser oracle, **0x007f** | validate-native-laser, validate-lasers-play (worker) | `script-laser.mjs` **PC 24** (`vectorToRotator24`) | was: 8,021 of 42,785 checks (prevRand, prevLoc, proxy moves, savedLoc/Rot); **now 0** |
| ParticleIterator::CurrentItem `0x1001ab20` → FarMoveActor | pass (SetupDynamics) | none | validate-particles-play | `particleIteratorItems`, render.rs `far_move` | not measured |
| XRootWindow::PreRender frame edit `0x1003a7dd–0x1003a8cb` | pass (PreRender event) | root-render-viewport oracle, **0x007f** | validate-root-render-viewport, validate-island-conversation | `script-root-render-viewport.mjs` **PC 24** | was: 443 of 1,783 cases (multipliers past 2^24 included); **now 0** |
| Raw background clip list: subtraction `0x1003c1d0`, GetRawBackgroundClipList `0x1003c5f0` (DrawRawBackground `0x1003c720` from PaintWindows) | pass (PostRenderFlash) | root-raw-background oracle, **0x007f** (was the harness's 0x037f; not in the first inventory) | validate-root-raw-background (audit switch added), validate-island-conversation | `script-root-raw-background.mjs` **PC 24** | was: 225 of 2,131 cases; **now 0** |
| GC tile path: clip helper `0x1002a4f0`, sink conversions `trunc(v + 0.1)` `0x1002a929–0x1002a9f5` (DrawTexture, DrawPattern, DrawIcon, DrawStretchedTexture, DrawBox, DrawBorders; DrawText's conversions) | pass (PaintWindows from PostRenderFlash) | GC probes, **0x007f** | validate-gc-* (49) | `script-gc-draw-model.mjs` `gcClipTile`/`ftolBiased`, gc.rs `clip`/`ftol` **PC 24** | was: DrawTexture 1 of 29 cases (frac-edge); **now 0** |
| Other GC natives (DrawText's glyph clip and alignment, DrawBorders' band scaling, GetTextExtent, Intersect, Set*Color) | pass (PaintWindows); GetTextExtent possibly also from layout | GC probes, **0x007f** | validate-gc-* | `script-gc-*.mjs` (f64 + f32 stores) | 0 at 0x007f and 0x037f; not re-derived per operation (open) |
| BoundsUpdate `0x10051160`, SortWindowLists `0x10045140` | ambiguous (ConfigureChild: tick or PaintWindows) | bounds-update oracle (0x037f; ORACLE_CW) | validate-window-bounds-update | `script-window-bounds-update.mjs` | 0 of 138 |
| ConvertVectorToCoordinates (native 1489, root `0x10039f10`) | pass (DrawWindow) | none in scripts/ | none | `script-window-projection.mjs` (x87 model) | not measured |
| Coronas' SingleLineCheck, ParticleIterator FarMoveActor | pass | collision oracles at 0x037f | — | trace.rs, render.rs | not measured |
| UnrealScript run from the render events (RenderOverlays → Weapon/CalcDrawOffset, PreRender/PostRenderFlash → DrawWindow, iterator `Init(Camera)`) | pass | the Core operator oracles, `ORACLE_CW` (all eight) | the operator validators at both words, validate-script-vm-x87, validate-render-pass-script-play (worker) | script VM (Rust interp + JS) on the x87 model at the precision control, `inRenderPass` **PC 24** | 13 natives differ at 0x007f (census-render-pass-operators); **now 0** ("UnrealScript in the render pass") |
| ComputeRenderSize again from XRootWindow::PreRender (`0x1003a8cd`) | pass (PreRender event) | window-scene-frame oracle, the second call at **0x007f** | validate-window-scene-frame (Wine real-x87 tangents) | `script-window-scene-frame.mjs` (coords at 64, size at the caller's precision) | was: 8 of 15 projections; **now 0** (HUD frame); the occlusion master frame: "The 3D frame's projection" below |

## Status and plan

Moved to the render-pass word, each with its oracle default at `0x007f`,
its validators green there, and (where Play has one) its Play validator run
in the default worker mode:
- BSP occlusion, ClipDecal and the spatially dynamic light effects (other
  worktrees), mesh fog's oracle default;
- on this audit's branch (2026-10-06): volumetric fog, coronas, the static
  and moving light-map path with its light animation (FGetHSV,
  ComputeFromActor, the rectangle, incidence, the spatial bodies, the
  LightType functions, the noise), GetFrame, mesh lighting (JS, the lodmesh
  kernel and the GPU shaders, bit-equal), lasers, surface pan, the root
  viewport, the raw background clip list and the GC tile path.

Costs (interleaved medians, Linux host; family docs give the setups):

| Family | Before | After |
| --- | --- | --- |
| Volumetric fog loop (fog.rs, headless, Bar) | 1.06 ms | 0.89 ms |
| Light maps: Training world build / light animation per frame | 2,200 ms / 2.92 ms | 1,093 ms / 2.70 ms |
| GetFrame (kernel `pose_speed`, native) | 69.9 ns per vertex | 19.1 ns |
| Mesh lighting (kernel `light_speed`, native) | 14.98 ns per vertex-light | 10.51 ns |
| Lasers (`laserCurrentItem`, Node) | 8.98 µs per item | 7.87 µs |
| Surface pan (`surfacePan`, Node) | 1.73 µs per surface | 1.49 µs |
| Root viewport (`rootRenderViewport`, Node) | 0.48 µs per call | 0.69 µs (once a frame) |
| GC clip + 8 conversions (JS reference) | 0.11 µs per tile | 0.27 µs |
| HUD paint, headless Island, gc.rs in Play's path (238 commands a frame, three alternating processes) | 5.65 ms per frame | 5.72 ms (within the 0.9 ms run-to-run spread) |

Open items:
- **UnrealScript inside the render events**: done ("UnrealScript in the
  render pass" below); its open parts are listed there.
- **Environment mapping** (`mesh-environment.mjs`, GLSL `ENVIRONMENT_UV`):
  f64 within a 0.00005-texel tolerance, not bit-exact at either word.
- **Mirror segment** (`mirrors.mjs`): doubles within a 4-ulp tolerance.
- **The lighting camera transform**: closed 2026-10-14. The original calls
  GetFrame with the drawing frame's Coords, so its buffer, the morph and the
  lighting are in that frame's camera space; Play now publishes the cache poses
  through each lit frame's own matrix and lights those (the `camera_component`
  / `toCamera` stage remains only for callers that pass world-space points; the
  validators of the mesh-lighting composition use it). The draw, the environment
  mapping and the culling bounds keep the world-space pose
  ([LOD](script-lodmesh-lod.md)).
- **FPATAN**: hosts use `Math.atan2` (Unicorn's FPATAN is double); exact
  only away from integer boundaries (lasers' `vectorToRotator24`).
- **Texture ticks** (Update, Tick, ConstantTimeTick) keep the 64-bit model:
  0 of 3,988 Get calls differ, but `now − last` of two doubles can round
  differently at 24 bits, and UTexture::Lock's caller word is not traced.
- **Other GC natives** (row above), **ConvertVectorToCoordinates** (native
  1489), **ParticleIterator FarMoveActor** (render.rs) and **coronas'
  SingleLineCheck**: in the pass, not measured or not re-derived at 24 bits.
- **BoundsUpdate / SortWindowLists**: ambiguous placement (tick or
  PaintWindows); 0 of 138 differ.
- **The game thread's control word** after PostRender's reset (above) and
  D3D's `DDSCL_FPUSETUP` before URender::Init.
- `validate-gpu-mesh` runs its page with `?sim=inline` (the GPU kernels
  read the page's mesh state); the Play checks of the moved families run in
  worker mode.

## UnrealScript in the render pass (2026-10-07)

Everything UGameEngine::Draw runs between PreRender and PostRender runs at
precision control 24, the UnrealScript it calls included, and that script
writes persisted state (Weapon.RenderOverlays' SetLocation and SetRotation,
window layout fields, iterator state). Play now runs those calls at 24 bits.

**Entry points** (the table above):
- The **PreRender** event: PlayerPawnExt.PreRender → Super (PlayerPawn's:
  `myHUD.PreRender`, an empty HUD event, or the HUD's spawn) →
  PreRenderWindows (1050) → XRootWindow::PreRender: the frame edit, then
  **ComputeRenderSize again** on the edited frame (`0x1003a8cd`), then the
  window configuration.
- DrawWorld's **RenderOverlays** event (`0x10b1cebd`): DeusExPlayer's →
  PlayerPawnExt's → PlayerPawn's (`Weapon.RenderOverlays`: DeusExWeapon's
  CalcDrawOffset, `(0.9/Default.FOVAngle · PlayerViewOffset) >>
  ViewRotation` plus EyeHeight and WalkBob, SetLocation, SetRotation,
  Canvas.DrawActor; `myHUD.RenderOverlays`), then a non-Weapon inHand's
  Inventory.RenderOverlays.
- SetupDynamics' render iterators: **Init(Camera)** (LaserIterator,
  ParticleIterator), before CurrentItem.
- The **PostRenderFlash** event: PostRenderWindows (1051) →
  XRootWindow::PostRender → PaintWindows → DrawWindow scripts and the GC
  natives.
- The **PostRender** event (PlayerPawn's `myHUD.PostRender`, empty in
  HUD.uc and not overridden in DeusEx) and the console's PostRender: Play
  does not run them (no console drawing); no DeusEx float math there.

**Host sites.** The simulation's frame (sim-session.mjs) runs them in its
`sprites` step (script-laser.mjs / script-particles.mjs `Init`), its
`weapon` step (weapon-overlay-sim.mjs, `RenderOverlays`) and its `hud` step
(script-play-hud.mjs `commands` → the window host's draw: resize,
reconfigure, initialize and paint). Script bodies run in the Rust
interpreter (interp.rs, its operator nodes calling lib.rs's x87 bodies) or,
with `SCRIPT_VM=js`, in the JavaScript VM (its operators through the Rust
operator kernel or the BigInt `x87Operators`).

**Which natives depend on the precision.** `census-render-pass-operators.mjs`
runs every Core operator oracle at 0x037f and at 0x007f. A native that is
one x87 operation between float loads and a float store gives the same bits
at both words (64 ≥ 2·24 + 2): no case differs for 171–175, 182–185, 193,
194, 210, 212, 213, 215–218, 221, 223, 224, 296, 297, the rotator integer
operators, RotRand, Sin/Cos/Tan/Atan and the vector-to-rotator cast. The
compound ones differ:

| Native | Cases differing at 0x007f |
| --- | --- |
| Dot (219) | 1 of 19 |
| `*=`/`/=` vector by float (221/222) | 0 / 1 of 15 |
| vector / float (214) | 2 of 8 |
| VSize (225) | 2 of 14 |
| Normal (226) | 3 of 26 |
| Smerp (248) | 1 of 24 |
| GetAxes (229) | 2 of 15 |
| MirrorVectorByNormal (300) | 3 of 19 |
| `>>` (276) | 5 of 22 |
| `<<` (275, new oracle cases) | 7 of 22 |
| rotator × float (287/288) | 3 of 21, 2 of 9 |
| int `/=` float (160) | 2 of 20 |
| VRand (252) | 60 of 64 |

**Translation.** The x87 models take a precision control:
`x87-precision.mjs` (a leaf module, read by script-vm.mjs's
x87mul/add/div/sqrt/recip) and `x87.rs` `PRECISION` (`set_x87_precision`,
per wasm instance: Ext add/mul/div/sqrt round the exact or sticky-jammed
result once to 24 bits). `render-precision.mjs` `inRenderPass` sets 24 in
the JavaScript model, the operator kernel instance and the interpreter
instance around the three host sites and restores 64. The model-based
bodies follow by construction; the ones that had their own 64-bit form now
branch: VSize (lib.rs `vector_size` for the interpreter, mover-finish.mjs
with r24), GetAxes and `<<` (camera.mjs `coordsDot`/`coordsDotX87`; `<<` now
also follows the x87's NaN rules at 64 bits, which its first oracle cases
showed it did not), VRand (script-vrand.mjs `execVRand24`) and the cast
(script-decoration-primitives.mjs `vectorToRotator24`, shared with the
lasers). The HUD scene frame keeps CreateMasterFrame's coordinates (64
bits) and computes ComputeRenderSize at the caller's precision: at 24 bits
appTan's argument `FOV·π/360` rounds before its qword store, so the measured
64-bit tangents do not apply and x87-tan.mjs's FPTAN model takes the 24-bit
argument. The game thread (ticks, physics, PlayerCalcView, Galaxy's Update)
stays at 64.

**Evidence.**
- The eight Core operator validators (float/vector operators with the cast,
  normal/axes, rotator/modulo with `<<`, string/transcendental, VRand,
  RotRand, float-approx, damage primitives) pass at 0x037f and, with
  `ORACLE_CW=0x007f`, against the original at 0x007f with the VM at 24 bits.
- `validate-script-vm-x87`: the Rust kernel equals the BigInt model at 64
  and 24 bits on 620,000 operand sets (VSize at 24 included).
- `validate-window-scene-frame`: each case also runs Engine's
  ComputeRenderSize again at 0x007f on the same frame, as XRootWindow's
  PreRender does, with real-x87 tangents of the 24-bit arguments (Wine on
  Linux, `X87_PROBE_WINE`): 19 cases bit-exact; 8 of the 15 same-size
  projections differ from the 64-bit ones.
- `validate-render-pass-script-play` (worker mode, new `renderPassProbe`):
  Training with the crowbar picked up and selected through Use and its belt
  slot, the view turned over 60 frames: every frame's crowbar Location is
  Owner.Location plus CalcDrawOffset at 24 bits. The 64-bit CalcDrawOffset
  differs in 41 of the 60 frames and would have placed the crowbar
  differently in 6.
  The HUD scene frame carries the 24-bit projection.

**Status (2026-10-08): verified.** The sweep (master merged at eb93aa2)
passes except `field-player-sequence-adapter`, which fails the same way on
master (its `reports/movement/player-sequence/*/scene.json` capture reports
are absent from this checkout). Passed: the eight operator validators at both
control words, validate-script-vm-x87 (merged with master's word-level
references), validate-window-scene-frame (Wine), validate-native-laser,
validate-render-pass-script-play (worker), all 88 window validators, weapon,
training, trigger, volumetric, world, render, scene-matrices, sim-split,
light-atlas-upload, fire-texture-play, galaxy-effects, galaxy-music-sequencer
(fresh oracle cache) and npm test (603). The x87 hardware validators skip on
this host without their probe.

**Cost (Linux, worker mode; interleaved, toggling `renderPassControl`).**
HUD paint on 01_NYC_UNATCOIsland, headless, alternating frames, median of 300
each, three rounds: 24-bit 1.997 / 2.008 / 2.016 ms against 64-bit
1.945 / 1.982 / 1.981 ms, +0.03 to +0.05 ms (about 2%) per paint, which is
the extra rounding in the Rust kernel's and the BigInt model's Ext forms.
RenderOverlays' script math (Weapon.CalcDrawOffset with the crowbar, in the
Training worker, 200 batches of 100 calls alternating): about 4 microseconds
per call at both precisions, below the timer's resolution. Neither shows in
frame time.

Open:
- Window natives on the x87 model that the paint reaches (layout, scroll,
  edit, list, ConvertVectorToCoordinates) now run at 24 bits there; only
  the scene frame has original evidence at 0x007f.
- The GC natives (f64 with float stores) and the traces (trace.rs) keep
  their forms; FPATAN is the host's atan2.

## The 3D frame's projection (2026-10-08)

**Original call order** (disassembly of Engine `UGameEngine::Draw`, Render
`CreateMasterFrame` `0x10b15690`, Extension `XRootWindow::PreRender`
`0x1003a760`; the import at Extension `0x10059324` is
`Engine.dll ?ComputeRenderSize@FSceneNode@@QAEXXZ`):

1. `CreateMasterFrame` (game thread, 64 bits) allocates the frame, sets X
   and Y from the viewport's `SizeX`/`SizeY` (`+0x78/+0x7c`, `0x10b15780`),
   gives the screen span `AllocIndexForScreen(SizeX, SizeY)` (`0x10b15827`),
   runs `ComputeRenderCoords` (Coords, Uncoords, then a first
   ComputeRenderSize) and takes the zone from `PointRegion`.
2. `URender::PreRender` sets precision control 24. `Canvas->Update(Frame)`
   points the canvas at that same frame (`Canvas+0x7c`).
3. The `PreRender` event reaches `XRootWindow::PreRender`: the render
   rectangle edit of [the conversation camera](conversation-camera.md) on
   the frame's X/Y/XB/YB, then, unconditionally (a root without
   `bClipRender` too), `FSceneNode::ComputeRenderSize` on the frame at
   `0x1003a8cd`, at 24 bits.
4. `DrawWorld` (OccludeFrame: SetupDynamics, OccludeBsp, child frames; then
   DrawFrame) reads that frame.

ComputeRenderSize reads X, Y, Actor.FOVAngle (`+0x410`), OrthoZoom, the
frame's Origin and Uncoords, and writes FX, FY, FX2, FY2, FX15, FY15, Zoom,
Proj, RProj, PrjXM..PrjYP, ViewSides and ViewPlanes, every one of them; it
leaves Coords, Uncoords, ZoneNumber and the span alone. So the frame
OccludeBsp sees has CreateMasterFrame's coordinates, zone and a screen span
of the **viewport's** size, with the sizes, projection, ViewSides and
ViewPlanes of the **render rectangle** computed at 24 bits, and the first
call's size fields are dead. At 24 bits appTan's argument `FOV * pi/360`
rounds before its qword store (so the measured 64-bit tangents do not apply,
x87-tan.mjs takes the 24-bit argument, as for child frames) and FX15, the
Proj.Z quotient, the corner rays and the planes round once per operation.
A ViewportWindow's Draw (`0x1004a770`, in the HUD paint) does the same:
CreateMasterFrame at 24 bits on the canvas viewport, the window's XB/YB/X/Y,
then ComputeRenderSize at 24 bits.

**Port.** `occ_master_frame` (occlude.rs) takes the render rectangle and
appTan's result for the pass's argument and builds the sizes with
`render_size::<P24>` (the child frames' routine) on the rectangle; the frame
words 61 and 62 carry the viewport's size for `AllocIndexForScreen`.
`bsp-occlusion.mjs master({..., render: {width, height}})` supplies the
tangent through `childFrameTangent`; Play passes the canvas size as the
viewport and the root's render viewport (`game.renderViewport`) as the
rectangle for the main frame, and the window's size for a camera frame
(whose coordinates round at the ambient 24 bits).

**Evidence.**
- `native-occlusion-oracle.py` cases with `render` edit the frame's X, Y,
  XB and YB after the unchanged CreateMasterFrame and run Engine's
  ComputeRenderSize at control word `0x007f`; `masterControlWord` `0x007f`
  builds the master frame inside the pass too. validate-bsp-occlusion (3
  cases in 4 through the pass, 2 in 4 on a clipped rectangle at an offset,
  1 in 4 with the master at 24 bits; Paris Club, Training, Island,
  Vandenberg and the tracker sequences), validate-child-frames (2 cases in 3
  with a rectangle, the children inheriting it) and validate-sprite-setup
  (Setup on the pass frame): every master frame word, Uncoords, zone, draw
  list with its saved points, child request, span, sprite, NodeFlag and
  zone time bit-exact. Core appTan's results for the 24-bit arguments of
  FOV 75 and 90 are measured on real x87 (`scripts/x87-hardware-tangents.mjs`,
  Wine) and are among the FPTAN model's candidates.
- `validate-master-frame-play` (worker mode, `deusExViewer.visibility().master`
  from sim-session.mjs): three Island frames' master words equal the Rust
  core's pass frame built from the view, viewport and render rectangle the
  frame reports, X/Y are the rectangle, words 61/62 the viewport, and none
  equals the one-call 64-bit frame.
- Mutations: the pass sizes at the 64-bit model fail the first pass case;
  an `AllocIndexForScreen` at the frame's X/Y instead of the viewport's
  fails node flags on the second clipped case (the original's span is
  larger than the clipped frame, and OccludeBsp's results see it).
- `census-master-frame-pass.mjs` (200 seeded views per map, FOV 75 and 90,
  1440x960; a fresh occlusion state per view so both variants start equal)
  against the master frame Play built before (one ComputeRenderSize at 64
  bits on the rectangle):

  | View | Frame words changed | Surfaces, child requests or node state changed | Saved points' projection changed |
  | --- | --- | --- | --- |
  | Island, viewport, FOV 75 | 200 of 200 | 0 | 0 |
  | Island, viewport, FOV 90 | 200 of 200 | 9 | 200 |
  | Island, letterbox 1440x720, FOV 75 | 200 of 200 | 145 | 0 |
  | Island, letterbox, FOV 90 | 200 of 200 | 146 | 200 |
  | Paris Club, viewport, FOV 75 | 200 of 200 | 0 | 0 |
  | Paris Club, viewport, FOV 90 | 200 of 200 | 0 | 200 |
  | Paris Club, letterbox, FOV 75 | 200 of 200 | 83 | 0 |
  | Paris Club, letterbox, FOV 90 | 200 of 200 | 81 | 200 |

  The frame changes everywhere (17 to 30 of its 45 size words); the visible
  set changes rarely in normal play and often with letterbox bars, where the
  viewport-sized screen span and the rectangle's own frustum both differ from
  what Play built. At FOV 90 (appTan of a 24-bit pi/4 is above 1) Proj.Z
  moves by an ulp and every saved polygon point's projection with it.

**Unverified or still open.**
- The scene's three.js projection reads this frame since 2026-10-08 (next
  section), as does the corona scan ([coronas](coronas.md#the-frame)); the
  GPU's matrix arithmetic is not the original's x87 vertex transform.
- The camera frame's hardware evidence is the oracle's, with the model
  tangent (a ViewportWindow's Draw itself was not run); XB/YB are not read
  by OccludeBsp (oracle cases with random offsets match without them).
- Play applies the pass to every main frame. A frame drawn while the
  player's root window does not exist (the original then never reaches
  XRootWindow::PreRender and keeps the 64-bit sizes) is not distinguished;
  none was observed in single-player after Login.

## The scene's projection (2026-10-08)

The page's three.js camera used the horizontal FOV over the render
rectangle's aspect and a constant half-pixel view offset
(`play-camera.mjs`, [visual acceptance](visual-acceptance.md)). It now takes
the pass frame's own numbers.

**Original.** Every projection Render.dll makes for what D3D draws is
`RZ = Proj.Z / Z; ScreenX = X * RZ + FX15; ScreenY = Y * RZ + FY15` from the
frame's `+0xdc`, `+0xc0` and `+0xc4`: `0x10b0c432-0x10b0c44e` (in
`0x10b0bab0`), the BSP clipper `ClipBspSurf` (`0x10b14f04`, `0x10b15070`,
`0x10b151a5`), `DrawMesh` (`0x10b0d804`, `0x10b0e2c3`), `DrawLodMesh`
(`0x10b0f8f8`, `0x10b10a66`) and `ClipDecal` (`0x10b1c768`). D3DDrv submits
the pre-projected vertex at `XB + ScreenX - 0.5`, `YB + ScreenY - 0.5`
(`DrawGouraudPolygon 0x10005822-0x10005855`: `fild [Frame + 0xb0]`, `fadd
[point + 0x10]`, `fsub [0x1001864c]`, and the same for +0xb4/+0x14; the 0.5 of
D3D's integer pixel centres). In the rectangle's GL window coordinates (from
the left and top) a point therefore lands at `FX15 + X * Proj.Z / Z` and
`FY15 + Y * Proj.Z / Z`: one focal length, Proj.Z, for both axes, and the
centre FX15, FY15, which are `(X + 1.0001) * 0.5` and `(Y + 1.0001) * 0.5`
rounded to float32 at 24 bits.

**Port.** `setFrameProjection` (play-camera.mjs) makes that a symmetric
three.js projection over the rectangle: vertical FOV `2 atan(Y / (2 Proj.Z))`,
aspect `X / Y` and a view offset of `(FX15 - X/2, FY15 - Y/2)` pixels
(0.500061 in both axes at 1440 x 960, 0.500046 vertically at 462 rows, where
the constant was 0.50005).
The simulation's frame carries it (`frame.projection` from the master frame's
words, `projectionOf`); the page's camera, the simulation's own copy (culling,
mirror and sky passes, which copy it) and a ViewportWindow's camera (from its
own pass frame, `pass.projection`) all take it; without OccludeBsp, in Inspect
and after a resize the FOV and the constant remain. `test/play-camera.test.mjs`
checks that points land at `FX15 + X * Proj.Z / Z` and
`FY15 + Y * Proj.Z / Z` (to 1e-6 relative) at five sizes and FOVs, and that the
FOV's projection is within 0.01 pixel of it at FOV 75.

**What changes** (`scripts/census-frame-projection.mjs`, worker mode, 1024 by
about 465 pixels, the page's three draws of one frozen frame: frame
projection, FOV projection, frame projection again; the last two against the
first, the noise floor, was 0 in every view except one DPR 2 view; views
whose frozen frame keeps changing because of animated textures are left out):

| Map and setting | Settled views | Pixels that differ (of 476,625 a view) | Views with any | Largest channel difference |
| --- | --- | --- | --- | --- |
| Island, FOV 75 | 7 | 45 (0.0014%) | 3 | 4 |
| Paris club, FOV 75 | 7 | 64 (0.0019%) | 7 | 10 |
| Training, FOV 75 | 5 | 697 (0.029%; one view 578) | 4 | 8 |
| Island, FOV 90 | 3 | 46 (0.0032%) | 3 | 8 |
| Paris club, FOV 90 | 5 | 72 (0.0030%) | 5 | 25 |
| Island, FOV 75, 2 device pixels per CSS pixel (1,906,500 pixels) | 3 | 161 (0.0028%) | 3 | 2 |

The change is a few dozen edge pixels a view: the focal length differs by one
float32 rounding (at FOV 90 appTan of the 24-bit argument moves Proj.Z by an
ulp) and the centre by up to 1.2e-5 pixel. The world is drawn with the same
vertices and the same GPU arithmetic, so nothing moves visibly; what changes
is that the projection is the frame's.

**Not covered (superseded 2026-10-14).** The GPU did the perspective divide and
the viewport transform in float32, where the original projects each vertex on
the x87 at 24 bits, and the near and far planes (1, 65,536) were the host's,
not the device's depth. [Frame projection](frame-projection.md) recovers
D3DDrv's vertex (X, Y, depth `_33 * (1 - 1/Z)` over near 1, far 32767, RHW)
and runs Render.dll's view transform and projection bit-exact in the vertex
shader; the camera is posed from the frame's Coords (the rotator's exact angles
differed from them by up to 0.3 pixel) and uses the device's depth range.
