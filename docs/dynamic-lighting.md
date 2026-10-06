# Moving lights on light maps

Training's dark room is meant to be crossed with AugLight (F12). Before this
work the original script already ran: `ActivateAugmentation 9` put AugLight in
state `Active`, `BeginState` spawned two `Beam` lights and `Tick` moved them
every frame. Nothing drew them, because the renderer only knew the baked static
light maps. This note records how the original Render.dll applies such moving
lights to BSP surfaces, what the browser translation reproduces and how it was
checked.

The next Stage 4 increment also translates the integer spatial body for steady
ordinary moving lights (`LightEffect=0`), including Training's four security
cameras. Its original contract, table/texel comparisons and remaining precision
limits are in [ordinary moving lights](moving-normal-lighting.md).

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
   shadow pointer: `memset(…, 0x7f, …)`. A fully lit static texel has 254
   (the shadow kernel table at `0x10b3cae0` truncates each weight row's
   `sum·255/320`: 70+114+70; [static lighting](static-lighting.md)), so an
   unshadowed moving light contributes exactly half of what a fully visible
   static light would.
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
  table entry. It also implements the normal falloff table, incidence factor
  and integer spatial recurrence for steady effect-0 lights.
* `game.movingLights()` scans the live level actor array in order, reading the
  light fields SetupDynamics reads.
* `src/viewer/moving-lights.mjs` filters each light through the level BSP,
  computes its rectangle on every reached light map record, and adds the texels
  onto a copy of the static texels (`lighting.setMoving`). Only the union of the
  previous and current rectangles is restored and re-applied.
* `world.syncMovingLights` runs after each Play tick; `LightAtlas` uploads the
  changed tile rectangles through `copyTextureToTexture` from a never-rendered
  staging texture that shares the page's pixels.
* Host work (2026-10-03, [Play CPU plan](play-cpu-plan.md) step 1.1): by
  default only the light maps a changed light or moved mover reaches are
  recomposed (see "Incremental recomposition" below). `MOVING_LIGHTS=full` in
  Node or `?movingLights=full` in the viewer keeps the whole-frame recompute
  as the reference.
* The static texels stay in the existing float reconstruction; a moving texel
  is `min(127/255, static + entry/255)`.

## Validation

`scripts/validate-dynamic-lighting.mjs` runs
`scripts/native-dynamic-light-oracle.py`, which executes the original Render.dll
and Engine.dll bodies under Unicorn with Core's `appSqrt` body
(`fld; fsqrt; ret`) and a bump allocator standing in for `FMemStack::PushBytes`.
Every other import traps. Cases use Training's real BSP and light maps.

| Check | Cases | Mismatches (bodies at `0x007f`, tables at `0x037f`) |
| --- | ---: | ---: |
| Square-root table | 2048 entries | 0 |
| Radius, `1/R`, `4093/R²` | all 256 `LightRadius` bytes | 0 |
| FGetHSV | 2049 hue/saturation/value triples | 0 |
| Brightness, colour, colour table | 16 | 0 |
| FDynamicLight::Filter surfaces | 16 lights, 438 surfaces | 0 |
| Texel rectangles | 438 | 0 |
| NonIncidence bytes and merged texels | 72,255 texels, 20,035 lit | 0 |

The per-texel loop is binary32 arithmetic in the original's operation order
(precision control 24; see "Precision" below), the double constant 1.02
rounded exactly; per-light values (`fgetHsv`'s double constants) use the
BigInt x87 model rounded to 24 bits (`x87-pc24.mjs`). The table above was
measured at `0x037f` with the earlier 64-bit translation until 2026-10-06.

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

## Incremental recomposition

This is host bookkeeping, not original behavior: the original recomputes its
dynamic light-map texels per drawn surface every frame. The full mode
recomposed every moving light map whenever any light or mover changed, so on
UNATCO Island the three flickering ElectricityEmitters (their `LightType`
toggles between `LT_None` and `LT_Steady`) recomposed about 185 light maps on
almost every frame.

A light map's moving texels depend only on its static copy and on its
contributions, added in light order with `min(127/255, texel + addend)` into a
float. The incremental mode keeps, per light (by name), the signature of its
location, light fields and level brightness, its contribution and the records
it reaches. A light map is recomposed only when a contribution it had or now
has changes: a light changed, appeared or left, or the mover owning a brush
light map changed its offset. The recomposition re-adds every contribution of
that light map in the same light order, so its float operations are the full
mode's. Each contribution also caches its per-texel addends, so an unchanged
light's addends are re-added without evaluating the spatial function again;
a light that leaves and comes back unchanged (the flicker) gets its cached
contribution back, unless a mover moved meanwhile. If the remaining lights
change their relative order, every light map is recomputed, as before.

`scripts/validate-moving-lights-incremental.mjs` runs both modes on two worlds
of one map with the same lights and mover offsets every frame, and requires
identical moving light maps, float texels, static copies, moving regions and
light-atlas bytes after every frame. Workloads: Training with the original
AugLight path (F12) while turning, and Island and Airfield with their authored
lights plus seeded synthetic perturbations (lights leaving and returning,
changed brightness and locations, swapped and repeated entries, mover
offsets, probe lights beside movers for the brush light maps on the normal,
NonIncidence and float paths). The first version failed this check: a light
leaving in the same frame as a mover moved was parked with contributions at
the old offset. On the default seed, Island recomposes 30,626 light maps
over 300 frames against 178,984, and Airfield 52,511 against 200,800. Island
standing at Player start in the browser (Linux host, 1920×1080): the `tick`
phase, which holds the moving-light sync, drops by about 3.5 ms.

## Precision: the render pass's 24 bits

Everything on this page except the light-manager tables runs inside the
render pass: URender::PreRender sets x87 precision control 24 until
PostRender ([render-pass precision](render-pass-precision.md)). Since
2026-10-06 the translation follows it, and the oracle runs the bodies at
`0x007f` with the tables built at the init word `0x037f`
(FLightManager::Init from URender::Init `0x10b1358d`, on the game thread;
`0x027f` gives the same tables, `0x007f` would change 248 of the 2,048
square roots).

What changed at 24 bits, from the instructions:
- **FGetHSV** (Engine `0x103ec8d0`): `value·(1.4/255)`, the appSqrt
  (`fld qword; fsqrt`), `+ 0.01`, `0.7/…` (all double constants, each
  rounded once from the exact value) and every later product and sum round
  to 24 bits. The 64-bit model differed in 1,789 of 2,049 triples.
- **ComputeFromActor**: `1/R` (`fdivr` of the double 1.0) stays on the stack
  as a 24-bit value, so `rr2 = f(f(1/R)²·4093)` (121 of 256 radii differed);
  the colour's `Level.Brightness·brightness` rounds before the channel
  products; the colour steps' `− 0.5f` rounds.
- **Incidence** (`0x10b06325–0x10b0639b`): `((dz·Nz + dy·Ny) + dx·Nx)·(1/R)`
  in binary32 (the static path's 415 of 1,947 Training steps differed).
- **Rectangle** (`0x10b0660e–0x10b06868`): the plane distance
  `((dy·Ny + dz·Nz) + dx·Nx)` from stored differences; the disk
  `R²·1.05 − d²` with the double 1.05 rounded exactly; the projected centre
  (Z on the stack, X and Y stored); `(u ∓ ru)` rounded before the division
  by the light-map scale.
- **Filter** (`0x10b24a30–0x10b24a66`): `((L.z·P.z + L.y·P.y) + P.x·L.x) − W`
  at 24 bits, for the surface lists and the leaf lists alike.
- **NonIncidence** (`0x10b05509–0x10b056ab`): the row start's Z sums, the
  distance `(dy² + dz²) + dx²`, `1.02 − root·(1/R)` (the double 1.02
  rounded exactly) and the `− 0.5f`.

Checks at `0x007f`: `validate-dynamic-lighting` (above),
`validate-static-lighting` on every Training surface (15,745 light steps,
8,891,470 texels), every 4th Island surface, every 3rd NYC Street surface
(483 cylinder and 332 spot steps) and every Intro and Free Clinic surface
(the singular bases): 0 mismatches. `validate-normal-moving-lighting`,
`validate-light-animation`, `validate-light-spatial`,
`validate-auglight-lighting`, `validate-moving-lights-incremental` and, in
the browser's default worker mode, `validate-light-spatial-play` pass.

Mesh lighting takes the same 24-bit FGetHSV and constants since its own
move ([mesh lighting](mesh-lighting.md) "Precision").

## Time-varying moving lights (2026-10-06)

The moving-light path above covered steady LightEffect 0, NonIncidence and
Shell. This section covers what remains of AddLight's class 2: the LightType
functions, the merge-dynamic wavers and the spotlights, as far as the shipped
content reaches them.

### Reach

`scripts/census-moving-lights.mjs` (original data only: the Actor classes of
every `System/*.u` package with their class defaults, every actor of the 83
single-player maps over its class defaults, and the ScriptText of the
packages for run-time assignments and `Spawn` calls) gives the class 2
sources:

| (LightType, LightEffect) | Sources |
| --- | --- |
| Steady / None | SecurityCamera (217 placed), CageLight (155), Gray (11), Lamp3 (9), HKMarketLight (2), GrayCarcass (1); script-lit Lamp*, CageLight, AlarmUnit, ElectricityEmitter (toggles None/Steady), radioactive Barrel1, WayBeacon (already the original normal body) |
| Steady / NonIncidence | Beam (AugLight), MuzzleFlash, ExplosionLight, HighLight (TAD), AutoTurretGun, ConLight, Fireball, PlasmaBolt, DartFlare, FireballRocket (already translated) |
| Steady / Shell | ExplosionLight of the EMP and nano-virus grenades (already translated) |
| **Steady / FireWaver** | BarrelFire (240 placed in 19 maps: Island 3, Mole People 27, Catacombs Tunnels 76, …); Fire, spawned by burning pawns, decorations and the player (the first of each set keeps its light) |
| **Steady / WateryShimmer** | BarrelAmbrosia (23 placed in 11 maps), BarrelVirus (7 in 3), WeaponNanoSword (1 placed, and the player's when drawn) |
| **Steady / TorchWaver** | Flare, once lit (107 placed unlit; `LightFlare` sets `LT_Steady`) |
| **Steady / Spotlight** | AlarmLight (23 placed in 8 maps, PHYS_Rotating at yaw 98,304 a second), lit by `Trigger` or `bIsOn` |
| **Strobe / Spotlight** | AlarmLight ×4 in 99_Endgame4, `bIsOn` |
| **Flicker / None** | LaserTrigger ×1 in 14_Vandenberg_Sub (map-set light, `bIsOn`) |

No script assigns a LightType other than None or Steady, and the only
LightEffect assignment is Shell. SmokelessFire (FireWaver) is spawned only
in multiplayer. Unreached by class 2, documented and not implemented:
Pulse, Blink, SubtlePulse, BackdropLight and the texture-palette types;
StaticSpot, Warp and Unused (whose rows would take the spot and normal
bodies); Cylinder; and the spatially dynamic effects (Searchlight, SlowWave,
FastWave, CloudCast, Shock, Disco, Interference, Rotor), which spatial.rs
runs for class 1 lights only.

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
* Steady effect-0 moving lights now use the original integer body. Moving spot
  lights (8, 12), the other normal-effect variants (1–3, 11, 19), and non-steady
  effect-0 snapshots still use the static float reconstruction with `0x7f`
  illumination. Their effect/type processing and waver/shimmer random modulation
  remain unrecovered. LE_Shell (the grenades' ExplosionLight) runs the original
  body in the Rust core ([static lighting](static-lighting.md#spatially-dynamic-effects));
  other effects are skipped with a diagnostics note.
* Non-steady `LightType` functions (`0x10b2a284` table) are not applied.
* Mesh and volumetric lighting (`LeafLights`, SetupForActor) remain part of the
  unsupported mesh lighting.
* Class 2 lights that also sit in a surface's static `LightActors` list would
  be added twice and unshadowed by the original. Training, Liberty Island,
  Battery Park and the Mission 5 lab have no such light, and the static path
  does not model it.
