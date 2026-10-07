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
* Galaxy Update's ambient-sound volume, which calls URender::GlobalLighting
  from Audio->Update (`script-audio-live.mjs`): before PreRender, so it keeps
  the double LightType form (`lightTypeBrightness` without `renderPass`).
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
| ULodMesh::GetFrame `0x10355360–0x103568e5` (Render's only call through its import is DrawLodMesh `0x10b0ee0f`; no other DLL imports it; virtual-call sites of UMesh::GetFrame `0x103a7780` not traced) | pass | lodmesh-frame oracle, **0x007f** | validate-lodmesh-frame (and `--wasm`), validate-gpu-mesh | `lodmesh-frame.mjs`; lodmesh-kernel `pose_single`/`pose_ext24`; GLSL `POSE_FRAGMENT` | **PC 24** (binary32; Ext24 fallback) | was: 20 of 46 calls (7,562 of 29,823 output words, max 1,257 ulps); **now 0**; GPU 227,862 of 227,862 components equal the CPU |
| DrawLodMesh normals `0x10b0fe60–0x10b0ff85`, `0x10b10863–0x10b10912`, back-face dot `0x10b0ffa3` | pass | mesh-light oracle, **0x007f** | validate-mesh-lighting, validate-gpu-mesh | `accumulateFaceNormal`, `faceDot`, `vertexNormalPlane`; kernel `light_mesh_job`; GLSL `FACE_FRAGMENT` | **PC 24** | was: face 278 of 400, vertex plane 208 of 400; **now 0** |
| SetupForActor `0x10b08c70` (ambient, candidates, AddLight, sort, ComputeFromActor) | pass | mesh-light oracle, **0x007f** | validate-mesh-lighting(-play) | `mesh-lighting.mjs` `setupForActor`; meshlight.rs `ml_select` | **PC 24** | was: camera-space light and colour words 1–8 ulps off; **now 0** (52 calls, 220 infos) |
| FLightManager::Light `0x10b027f0` | pass | mesh-light oracle, **0x007f** | validate-mesh-lighting, validate-gpu-mesh | `lightVertexX87` (BigInt PC 24 reference), `lightVertex`; kernel `light_vertex`; GLSL `VERTEX_FRAGMENT` (`divRN`) | **PC 24** | was: 1,545 of 3,744 channels; **now 0**; GPU 701,505 colour channels equal the CPU |
| D3D diffuse `0x10005942–0x100059ac` | pass | mesh-light oracle | validate-mesh-lighting | `d3dDiffuse`; kernel `diffuse_channel`; GLSL `CORNER_FRAGMENT` | exact | 0 |
| Environment mapping `0x10b101d3–0x10b10314`, `0x10b0bae9–0x10b0bbbc` | pass | mesh-environment oracle (tables at init, slices ORACLE_CW) | validate-mesh-environment (tolerance 0.00005 texel) | `mesh-environment.mjs`; GLSL `ENVIRONMENT_UV` | f64, not bit-exact | within tolerance |
| GetRenderBoundingBox `0x103a6850`, BoundVisible `0x10b162e0`, FDynamicSprite::Setup `0x10b23910` | pass | render-visibility oracle (0x037f, BoundsOracle rejects other words) | validate-render-mesh-bounds, validate-render-visibility | JS reference (not in Play); Rust occlude.rs and the Setup branch in binary32 | x87 model (JS) | superseded by the binary32 Rust ports (other worktree); JS references not re-measured |
| DrawLodMesh LOD selection `0x10b0eb52–0x10b0ed53`, morph `0x10b0ee34–0x10b0ef6e`, reduced corners `0x10b0fc6f–0x10b0fe60` ([LOD](script-lodmesh-lod.md)) | pass | lodmesh-lod oracle, **0x007f** (appTan's float from the real-x87 model) | validate-lodmesh-lod, validate-x87-tan-hardware ("lod" mode), validate-lodmesh-lod-play (worker), validate-gpu-mesh | `lodmesh-lod.mjs`; lodmesh-kernel `lod.rs`; GLSL `MORPH_FRAGMENT`, `RESOLVE_FRAGMENT` | **PC 24** (written at 24 bits from the start; Play's morph rounds world-space positions) | 0 of 228 cases; at 0x037f the oracle differs in 665 of 226,265 checks; GPU equal to the CPU path |

### Other render-pass routines

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
| UnrealScript run from the render events (RenderOverlays → Weapon/CalcDrawOffset, PreRender/PostRenderFlash → DrawWindow, iterator `Init(Camera)`, Console PostRender, DeusExPlayer.RenderOverlays) | pass | none | none | script VM (Rust interp + JS): Core float operators on the 64-bit model | not measured; needs a design decision |

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
- **UnrealScript inside the render events** (RenderOverlays →
  Weapon/CalcDrawOffset, PreRender/PostRenderFlash → DrawWindow, iterator
  `Init(Camera)`, Console PostRender, DeusExPlayer.RenderOverlays): the
  script VM's float operators run on the 64-bit model. Moving them needs a
  design decision (a per-call precision flag in the Rust interpreter and the
  JS VM); the VM is unchanged.
- **Environment mapping** (`mesh-environment.mjs`, GLSL `ENVIRONMENT_UV`):
  f64 within a 0.00005-texel tolerance, not bit-exact at either word.
- **Mirror segment** (`mirrors.mjs`): doubles within a 4-ulp tolerance.
- **The lighting camera transform** (`camera_component`, `toCamera`): a
  host stage at 24 bits; the original composes the view into GetFrame's
  matrix.
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
