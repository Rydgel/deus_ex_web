# Moving lights on light maps

Training's dark room is meant to be crossed with AugLight (F12). Before this
work the original script already ran: `ActivateAugmentation 9` put AugLight in
state `Active`, `BeginState` spawned two `Beam` lights and `Tick` moved them
every frame. Nothing drew them, because the renderer only knew the baked static
light maps. This note records how the original Render.dll applies such moving
lights to BSP surfaces, what the browser translation reproduces and how it was
checked.

Sources of truth are the hash-pinned GOTY binaries (Render.dll
`607f1077…d75d1`, Engine.dll `0c3a8b18…c20b4`), `00_Training.dx` and the
installed `DeusEx.u` bytecode. Addresses are virtual addresses at the DLLs'
preferred bases.

## The lights

`Beam` (DeusEx.u) extends `Light` with `bStatic=False`, `bNoDelete=False`,
`bMovable=True`, `LightType=LT_Steady`, `LightEffect=LE_NonIncidence` (13),
`LightBrightness=250`, `LightHue=32`, `LightSaturation=142`, `LightRadius=7`.
`BeginPlay` sets `DrawType=DT_None` and a one-second `MakeNoise` timer.
AugLight's `BeginState` sets `b1` to hue 32, saturation 140, brightness 192,
radius 4 and calls `SetBeamLocation`; `b2` gets brightness 220 and radius 4.
`SetBeamLocation` traces along the view, puts `b1` 64 units short of the hit
and sets `LightRadius=byte(size*5.12+4)` (4–9) and `LightType=LT_Steady`;
`SetGlowLocation` keeps `b2` at eye height beside the player. A live F12 probe
in Play reads exactly these values from the spawned `Beam0`/`Beam1`.

`AActor::WorldLightRadius` (Engine `0x1030d6a0`, AActor vtable `+0x60`) is
`25*(LightRadius+1)`, so the beams reach 125–250 units.

## Recovered call order

1. **SetupDynamics** (`0x10b22d90`) walks the level actor array each frame. At
   `0x10b230e8`–`0x10b2311c` a light becomes a candidate when `LightType≠0`,
   `bStatic|bNoDelete` is clear or `bDynamicLight` is set, and
   `LightBrightness` and `LightRadius` are nonzero. The radius is
   `max(WorldLightRadius, 25*(VolumeRadius+1))`; a light whose sphere lies
   wholly outside one of the four `FSceneNode::ViewPlanes` is skipped. The
   candidate becomes an `FDynamicLight` (0x18 bytes, vtable `0x10b2b80c`) on
   BSP node 0's list in `DynamicsCache`.
2. **FDynamicLight::Filter** (`0x10b24a10`), called for each node OccludeBsp
   visits, computes `Dist = float((Z·Lz + Y·Ly) + X·Lx − W)`. When `−R < Dist`
   the item moves to the front child; when `Dist < R` to the back child; when
   both hold, the light is prepended to `URender::SurfLights[iSurf]` for the
   node and each coplanar node (`iPlane` chain) whose surface has a light map
   (`UModel::GetLightMapIndex`, Engine `0x1031e610`) and whose
   `PF_SpecialLit` matches the actor's `bSpecialLit` (`+0x1ec` bit 0). A
   surface is listed once per light; `NumDynLightSurfs` stops at 2048. Leaf
   lists (`LeafLights`) feed mesh and volumetric lighting.
3. **FLightManager::SetupForSurf** (`0x10b06c90`) adds the static list
   (`LightActors`, with shadow bits) and then `Draw->SurfLights` through
   **AddLight** (`0x10b08b30`). AddLight classifies each light: `LE_OmniBumpMap`
   is class 3; a `bStatic` steady light with a non-animated effect is class 0
   (static cache); other `bStatic`/`bNoDelete` lights are class 1; everything
   else, including `bDynamicLight`, is class 2 unless `UClient::NoDynamicLights`
   (`Viewport->Outer +0x50`) rejects it. Class 0 lights build the cached static
   map (key suffix `0x18`). When any class 1 or 2 light exists, a per-frame map
   (suffix `0x31`) starts as a copy of the static one and receives them.
4. For a class 2 light the illumination map comes from `0x10b02650` with a null
   shadow pointer: `memset(…, 0x7f, …)`. A fully lit static texel has 255
   (the shadow kernel table at `0x10b3cae0` scales to `255/total`), so an
   unshadowed moving light contributes half of what a fully visible static
   light would.
5. **FLightInfo::ComputeFromActor** (`0x10b05fa0`) sets the per-light
   constants: `R=float(WorldLightRadius)` (clamped to ≥1), `1/R` and
   `float((1/R)²·4093)`; brightness `float(LightBrightness·float(1/255))`;
   `GlobalLighting` (`0x10b05e90`) takes `FGetHSV(hue, saturation, 255)` and,
   for `LT_Steady`, a no-op type function (`0x10b05a00`); colour is
   `float(Level.Brightness·brightness·hsv)`. The colour table (`0x10b064ff`)
   uses `step = FISTP(float(colour·65536) − 0.5)` and entry
   `i = min(127, (i·step)>>16)`, packed BGRA. The surface part
   (`0x10b0660e`–`0x10b06865`) computes the texel rectangle from the light's
   plane distance: disk `√max(0, 1.05R² − d²)` through the table square root,
   the projected centre in texture units, and `FISTP`-rounded bounds clamped to
   the light map.
6. The spatial function comes from the effect table at `0x10b2a0f0`.
   **NonIncidence** (`0x10b054e0`) walks the rectangle with float texel
   positions accumulated from the start point `0x10b38a90` and steps
   `0x10b49e10`/`0x10b3d378`. Per texel with nonzero illumination:
   `t = FISTP(float(dist²·table))`; if `t < 4096` the byte is
   `FISTP(float((1.02 − √dist²·(1/R))·illum) − 0.5)`, otherwise 0. The root
   is the 2048-entry table built at light-manager init (`0x10b0225b`–`0x10b022d0`).
7. The merge (`0x10b03040`) adds the colour table entry for each spatial byte to
   the copied static texel with per-channel saturation at 127.

Two constants differ from the earlier static reconstruction: NonIncidence uses
**1.02**, not 1, and keeps texels up to `FISTP(d²·4093) < 4096`
(`d < 1.0003`). `lightAttenuation` in `src/unreal/lighting.mjs` now uses both.
Training's six static NonIncidence lights therefore gain 0.02 of their full
contribution inside their radius.

## Browser translation

* `src/runtime/dynamic-lighting.mjs` holds the recovered pieces: the candidate
  gate, AddLight's class, `WorldLightRadius`, the BSP filter, `fgetHsv` (Engine
  FGetHSV `0x103ec8d0` on the project's 80-bit x87 model), the per-light
  constants, the rectangle, the square-root table, NonIncidence and the colour
  table entry.
* `game.movingLights()` scans the live level actor array in order, reading the
  light fields SetupDynamics reads.
* `src/viewer/moving-lights.mjs` filters each light through the level BSP,
  computes its rectangle on every reached light map record, and adds the texels
  onto a copy of the static texels (`lighting.setMoving`). Only the union of the
  previous and current rectangles is restored and re-applied.
* `world.syncMovingLights` runs after each Play tick; `LightAtlas` uploads the
  changed tile rectangles through `copyTextureToTexture` from a never-rendered
  staging texture that shares the page's pixels.
* The static texels stay in the existing float reconstruction; a moving texel
  is `min(127/255, static + entry/255)`.

## Validation

`scripts/validate-dynamic-lighting.mjs` runs
`scripts/native-dynamic-light-oracle.py`, which executes the original Render.dll
and Engine.dll bodies under Unicorn with Core's `appSqrt` body
(`fld; fsqrt; ret`) and a bump allocator standing in for `FMemStack::PushBytes`.
Every other import traps. Cases use Training's real BSP and light maps.

| Check | Cases | Mismatches (control word `0x037f`) |
| --- | ---: | ---: |
| Square-root table | 2048 entries | 0 |
| Radius, `1/R`, `4093/R²` | all 256 `LightRadius` bytes | 0 |
| FGetHSV | 2049 hue/saturation/value triples | 0 |
| Brightness, colour, colour table | 16 | 0 |
| FDynamicLight::Filter surfaces | 16 lights, 438 surfaces | 0 |
| Texel rectangles | 438 | 0 |
| NonIncidence bytes and merged texels | 72,255 texels, 20,035 lit | 0 |

The per-texel loop evaluates extended-precision intermediates in JavaScript
doubles with float stores at the recovered store points. The 72,255-texel
comparison shows no difference, but this is a measurement, not a proof.
Per-light values (`fgetHsv`, colour) use the x87 model.

`scripts/validate-auglight-lighting.mjs` drives Play: F12 spawns the two Beams,
they pass the gate, 113 light maps gain texels, an unchanged frame recomposes
nothing, and a second F12 destroys the Beams and restores those maps exactly.
Training's four SecurityCamera lights (`LightType=1`, radius 1, not static)
are moving lights too; they light the maps next to each camera before and after
F12.

In the browser, the Training dark room goes from black to lit around the Beam
and back when AugLight toggles; the light follows the view while walking the
maze. The moving-light sync costs about 2 ms median and 3 ms mean per frame
while the Beam moves (headless measurement over 120 frames).

## Precision boundary: FPU control word

Deus Ex's D3DDrv.dll calls `IDirectDraw7::SetCooperativeLevel` with
`DDSCL_FPUSETUP` (`or ah, 8` at `0x1000b18e`). Under Direct3D 7 that leaves the
x87 control word in single precision, which would round every intermediate to
24 bits. The oracle and this translation assume the extended control word
`0x037f` used by the project's other native comparisons. Under `0x007f`, the
same oracle builds a different square-root table (248 of 2048 entries) and
different `4093/R²` values (121 of 256), while the spatial and merge bodies
still match on the supplied inputs. The control word in the running game
(D3D, OpenGL or software renderer) has not been measured.

## Not reproduced / open

* The frustum test in SetupDynamics and OccludeBsp's visibility-driven filter:
  the browser filters the whole BSP. Only surfaces the original does not draw
  can differ, except where a surface split across nodes has a visited node the
  light cannot reach and an unvisited one it can.
* The 2048-surface `NumDynLightSurfs` cap and its traversal order.
* The light-map grid (start and steps) comes from `lightmapBasis`, not from
  `FCoords::Inverse`; the oracle compares the spatial body on identical grids.
* Mover polygons: the brush tracker's insertion into the level BSP is not
  recovered. Mover light maps take Filter's straddle test on their own plane,
  follow translation offsets only, and use a float facet.
* Moving normal and spot lights (effects 0, 8, 12 and the waver effects 1–3,
  11, 19) use the static float reconstruction with the `0x7f` illumination;
  their integer spatial bodies and the waver/shimmer random modulation are not
  translated. Other effects are skipped with a diagnostics note.
* Non-steady `LightType` functions (`0x10b2a284` table) are not applied.
* Mesh and volumetric lighting (`LeafLights`, SetupForActor) remain part of the
  unsupported mesh lighting.
* Class 2 lights that also sit in a surface's static `LightActors` list would
  be added twice and unshadowed by the original. Training, Liberty Island,
  Battery Park and the Mission 5 lab have no such light, and the static path
  does not model it.
