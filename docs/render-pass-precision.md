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
| `0x1038f6b5` | `PreRender` event; PlayerPawnExt.PreRender calls native 1050 PreRenderWindows → XRootWindow::PreRender `0x1003a760` (from `0x10038336`) | 24 |
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
| Engine FGetHSV `0x103ec8d0` (called at `0x10b05ee8` GlobalLighting, `0x10b07fcc` SetupForSurf ambient, `0x10b08dee` SetupForActor) | pass | dynamic lighting | dyn `fgethsv`, argv[2] (0x037f) | validate-dynamic-lighting (reports 0x007f, asserts 0x037f) | `dynamic-lighting.mjs` `fgetHsv` | x87 64-bit model | **1,789 of 2,049** triples differ |
| ComputeFromActor `0x10b05fa0`: R, 1/R, rr2 `0x10b05fc3–0x10b0602c` | pass | dynamic lighting | dyn `radius_constants`, argv | validate-dynamic-lighting | `movingLightConstants` | f64 | **rr2 121 of 256** radii |
| ComputeFromActor brightness/colour/table `0x10b060b1`, `0x10b06122`, `0x10b064ff` | pass | dynamic lighting | dyn `color_table` | validate-dynamic-lighting, static | `movingLightConstants`, `colorTableEntry` | x87 model | 0 of 16 (inputs from the 64-bit FGetHSV) |
| ComputeFromActor incidence `0x10b06325–0x10b0639e` | pass | moving normal lighting | dyn `incidence` | validate-static-lighting | `normalLightIncidence`; spatial branch `renderPassConstants` | x87 model | **415 of 1,947** Training steps (every 8th surface) |
| ComputeFromActor rectangle `0x10b0660e–0x10b06868` | pass | dynamic lighting | dyn `rect` | dynamic, static | `movingLightRect` | f64 + fround | 0 of 438 / 0 of 1,947 |
| Ambient fill `0x10b07fd2–0x10b080cf` | pass | static lighting | dyn `ambient` (FGetHSV + fill) | validate-static-lighting | `ambientTexel` | exact products | 0 of 72 zone triples |
| Illumination `0x10b02650` | pass | static lighting | dyn `illumination` | validate-static-lighting | `shadowIllumination` | integer | 0 of 15,754 masks |
| Normal `0x10b03360`, NonIncidence `0x10b054e0`, spot `0x10b04f80`, cylinder `0x10b04a80` | pass | static, moving normal lighting | dyn `spatial_merge`, `spot_merge` | static, dynamic, normal-moving | `normalLightSpatial`, `nonIncidenceSpatial`, `spotLightSpatial`, `cylinderSpatial` | f64 + fround, x87-model chains | 7 Training steps (11 of 1,277,341 texels); NonIncidence 0 of 72,255; normal 0 of 37,763 (64-bit constants as inputs) |
| Merge `0x10b03040`, merge modulation `0x10b030f2–0x10b03244` | pass | static lighting | dyn `spatial_merge`, `merge_mod` | static, light-animation | inline merge, `mergeModulation`, light.rs `light_merge`/`light_modulation` | integer / f64 factors | 1 merged texel (Training); modulation 0 of 3,600 |
| Light noise `0x10b13080` (from PreRender `0x10b146ae`) | pass | static lighting "Light animation" | dyn `noise` | validate-light-animation | `createLightNoise` | x87 ftol + f32 stores | 0 of 240 frames |
| GlobalLighting `0x10b05e90`, LightType table `0x10b2a284` | pass | static lighting | dyn `light_type` | validate-light-animation | `lightTypeBrightness` | x87 model | **58 of 1,280** frames |
| Spatially dynamic effects (Searchlight … Shell) | pass | static lighting (spatial branch) | dyn `spatial_dynamic`, **0x007f** | validate-light-spatial | spatial.rs | binary32 | other branch, at 0x007f already |
| FDynamicLight::Filter `0x10b24a10` | pass (OccludeBsp) | dynamic lighting | dyn `filter` | dynamic, mesh-lighting | `filterMovingLight`, `movingLightLeaves` | f64 + fround | 0 of 438 surfaces |
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
| ULodMesh::GetFrame `0x10355360–0x103568e5` (Render's only call through its import is DrawLodMesh `0x10b0ee0f`; no other DLL imports it; virtual-call sites of UMesh::GetFrame `0x103a7780` not traced) | pass | lodmesh-frame oracle (NativeCollision 0x037f; now argv[2]) | validate-lodmesh-frame | `lodmesh-frame.mjs`; lodmesh-kernel `pose`/`pose_double`/`pose_exact`; GLSL `POSE_FRAGMENT` | x87 64-bit + f64 fast path; GLSL float-float | **20 of 46** calls: 7,562 of 29,823 output words (max 1,257 ulps); cache words 182 of 15,472 in 17 calls |
| DrawLodMesh normals `0x10b0fe60–0x10b0ff85`, `0x10b10863–0x10b10912` | pass | mesh-light oracle, argv[2] (tables now at init) | validate-mesh-lighting | `accumulateFaceNormal`, `vertexNormalPlane`; kernel `light_mesh_job`; GLSL `FACE_FRAGMENT` | f64 + f32 stores | **face 278 of 400, vertex plane 208 of 400** |
| SetupForActor `0x10b08c70` (ambient, candidates, AddLight, sort, ComputeFromActor) | pass | mesh-light oracle | validate-mesh-lighting(-play) | `mesh-lighting.mjs` `setupForActor`; meshlight.rs `ml_select` | f64 + fround | camera-space light and colour words differ by 1–8 ulps for most actors |
| FLightManager::Light `0x10b027f0` | pass | mesh-light oracle | validate-mesh-lighting | `lightVertexX87` (reference), `lightVertex` (Play); kernel `light_vertex`; GLSL `VERTEX_FRAGMENT` | x87 / f64 | **1,545 of 3,744** channels (max 522 ulps); **0 of 1,248 D3D diffuse bytes** |
| D3D diffuse `0x10005942–0x100059ac` | pass | mesh-light oracle | validate-mesh-lighting | `d3dDiffuse`; kernel `diffuse_channel`; GLSL `CORNER_FRAGMENT` | exact | 0 |
| Environment mapping `0x10b101d3–0x10b10314`, `0x10b0bae9–0x10b0bbbc` | pass | mesh-environment oracle (tables at init, slices ORACLE_CW) | validate-mesh-environment (tolerance 0.00005 texel) | `mesh-environment.mjs`; GLSL `ENVIRONMENT_UV` | f64, not bit-exact | within tolerance |
| GetRenderBoundingBox `0x103a6850`, BoundVisible `0x10b162e0`, FDynamicSprite::Setup `0x10b23910` | pass | render-visibility oracle (0x037f, BoundsOracle rejects other words) | validate-render-mesh-bounds, validate-render-visibility | JS reference (not in Play); Rust occlude.rs and the Setup branch in binary32 | x87 model (JS) | superseded by the binary32 Rust ports (other worktree); JS references not re-measured |
| DrawLodMesh LOD selection/morph | pass | lodmesh-lod oracle (0x037f) | none | not translated | — | — |

### Other render-pass routines

| Routine | Placement | Oracle (CW today) | Validator | Ports | At 0x007f |
| --- | --- | --- | --- | --- | --- |
| OccludeBsp `0x10b173d0`, ClipBspSurf, BoundVisible, span buffers | pass | occlusion oracle **0x007f** | validate-bsp-occlusion | occlude.rs (binary32) | done |
| ClipDecal `0x10b1bda0` and DrawFrame's decal block | pass | decal-render oracle **0x007f** | validate-decal-render | decal.rs (binary32) | done |
| Corona pass `0x10b1b46a–0x10b1bb06` (fade, helper `0x10b1bc00`, draw loop) | pass (DrawFrame) | coronas oracle (0x037f; ORACLE_CW) | validate-coronas | `coronas.mjs` (x87 model) | **92 of 200** frames' DrawIcon calls (299 of 305 icons) |
| Mirror segment `0x10b1886d–0x10b18b93` | pass (OccludeBsp) | mirror oracle (0x037f; ORACLE_CW) | validate-mirrors (4-ulp tolerance) | `mirrors.mjs` (doubles) | within tolerance |
| Surface pan `0x10b1a59a–0x10b1a72a` | pass (DrawFrame) | surface-pan oracle (0x037f; ORACLE_CW) | validate-native-surface-pan | `surfacePan` (x87 model) | **240 of 400** fabricated cases |
| UTexture Get/Update/Tick/ConstantTimeTick (`0x103212e0`, `0x103ecb70`, `0x103ed0d0`, `0x103ed330`) | pass: DrawFrame's `Texture->Update` (vtable `+0x78`), DrawActorSprite `0x10b2547b`; also UTexture::Lock | texture-animation oracle (0x037f; ORACLE_CW) | validate-native-texture-animation | `texture-animation.mjs` | 0 of 3,988 Get calls |
| Fire.dll ConstantTimeTick (fire, water, wet) | pass (through Update) | fire oracle (0x037f; ticks ORACLE_CW) | validate-native-fire-texture | fire.rs (integer) | 0 of 1,178 cases |
| ULaserIterator::CurrentItem `0x1001a1a0` | pass (SetupDynamics) | laser oracle (0x037f; ORACLE_CW) | validate-native-laser | `script-laser.mjs` (x87 model) | **8,021 of 42,785** checks (prevRand, prevLoc, proxy moves, savedLoc/Rot) |
| ParticleIterator::CurrentItem `0x1001ab20` → FarMoveActor | pass (SetupDynamics) | none | validate-particles-play | `particleIteratorItems`, render.rs `far_move` | not measured |
| XRootWindow::PreRender frame edit `0x1003a7dd–0x1003a8cb` | pass (PreRender event) | root-render-viewport oracle (0x037f; ORACLE_CW) | validate-root-render-viewport | `script-root-render-viewport.mjs` (x87 model) | **443 of 1,783** cases (multipliers past 2^24 included) |
| GC draw natives (DrawTexture, DrawStretchedTexture, DrawText, DrawPattern, DrawIcon, DrawBox, DrawBorders), GetTextExtent, Intersect, Set*Color | pass (PaintWindows from PostRenderFlash) | GC probes (NativeCollision; ORACLE_CW) | validate-gc-* | `script-gc-*.mjs`, gc.rs (f64 + f32 stores) | DrawTexture **1 of 29** cases (frac-edge); all others 0 |
| BoundsUpdate `0x10051160`, SortWindowLists `0x10045140` | ambiguous (ConfigureChild: tick or PaintWindows) | bounds-update oracle (0x037f; ORACLE_CW) | validate-window-bounds-update | `script-window-bounds-update.mjs` | 0 of 138 |
| ConvertVectorToCoordinates (native 1489, root `0x10039f10`) | pass (DrawWindow) | none in scripts/ | none | `script-window-projection.mjs` (x87 model) | not measured |
| Coronas' SingleLineCheck, ParticleIterator FarMoveActor | pass | collision oracles at 0x037f | — | trace.rs, render.rs | not measured |
| UnrealScript run from the render events (RenderOverlays → Weapon/CalcDrawOffset, PreRender/PostRenderFlash → DrawWindow, iterator `Init(Camera)`, Console PostRender, DeusExPlayer.RenderOverlays) | pass | none | none | script VM (Rust interp + JS): Core float operators on the 64-bit model | not measured; needs a design decision |

## Status and plan

Moved to the render-pass word: BSP occlusion, ClipDecal, the spatially
dynamic light effects (other worktree), mesh fog's oracle default, and on
this audit's branch volumetric fog (2026-10-06). The
families are moved one at a time, starting with what Play computes every
frame; each keeps the JS reference, the Rust kernel and the GPU shader in
agreement and switches its oracle default to `0x007f` when its validator
passes there.
