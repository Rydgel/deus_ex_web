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
   lists (`LeafLights`) feed mesh and volumetric lighting and the corona
   pass; their order and the candidates' ViewPlanes test are in
   [coronas](coronas.md#leaf-lights).
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
has changes: a light changed, appeared or left, or a brush light map was
placed again (its mover's cache header changed: lighting.mjs `takeReposed`,
[static lighting](static-lighting.md#mover-surfaces-in-setupforsurf-2026-10-17)).
Brush light maps take the facet and grid their static texels were built on
(`geometryFor`); until 2026-10-28 they took the authored facet plus the mover's
offset, read once from the live group matrix, which counted the offset twice
for a light map first reached after its mover moved and kept a turned mover's
authored orientation. The recomposition re-adds every contribution of
that light map in the same light order, so its float operations are the full
mode's. Each contribution also caches its per-texel addends, so an unchanged
light's addends are re-added without evaluating the spatial function again;
a light that leaves and comes back unchanged (the flicker) gets its cached
contribution back, unless a brush light map was placed again meanwhile. If the remaining lights
change their relative order, every light map is recomputed, as before.

`scripts/validate-moving-lights-incremental.mjs` runs both modes on two worlds
of one map with the same lights and mover states every frame (syncMovers and
relightMovers place the brush light maps), and requires
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

### Recovered contract

SetupForSurf's per-frame map (`0x10b08479`–`0x10b08923`) walks the frame's
light infos; a class 2 light (`0x10b0850f`) gets, every frame and for every
drawn surface it reaches:
1. **ComputeFromActor** (`0x10b0100f` → `0x10b05fa0`): brightness
   `LightBrightness·(1/255)` (`0x10b060b1`), the effect row copied from
   `0x10b2a0f0` (an effect of 20 or more takes row 0), then **GlobalLighting**
   through the renderer's vtable (`[0x10b5a718]` +0x88 at `0x10b0611c`,
   `0x10b05e90`) with the
   viewport actor's SHOW_PlayerCtrl as `animate`; the colour, colour table,
   incidence and rectangle as for steady lights.
2. **Illumination** `0x10b02650` with a null shadow pointer: the whole map
   `0x7f` (`0x10b08570`–`0x10b08577`).
3. The row's **spatial function** (`call [info+0x60]`, `0x10b088d5`): the
   normal body for None, the wavers, Warp and Unused; the spot body for
   StaticSpot and Spotlight, whose axis is the X axis of `GMath.UnitCoords /
   Rotation`, or of the ViewRotation when `IsA(APawn)` (`0x10b04f89`–
   `0x10b04fda`); NonIncidence; Shell.
4. The **merge** `0x10b03040` with the actor's LightEffect (`+0x1e1`) and the
   start index `[ebp−0xbc]`, which SetupForSurf zeroes at `0x10b06d91` and
   never changes: each light's modulation index starts at 0.

The LightType functions (table `0x10b2a284`, [static lighting](static-lighting.md)
"Light animation") read Level.TimeSeconds, LightPeriod and LightPhase; Flicker
(`0x10b05af0`) takes table A at the low byte of its first argument, the
actor's address; Strobe (`0x10b05b30`) flips the global flag at `0x10b49ea8`
whenever TimeSeconds differs from the time at `0x10b49ea4`, so only frames
in which some Strobe light is set up flip it. Light maps, mesh lighting and
Galaxy share that state; Play keeps it in `light-globals.mjs` and the
simulation decides each frame's flip (`lightMapStrobe`, [mesh
lighting](mesh-lighting.md) "LightType functions, Strobe and the noise").

**The noise and its random stream.** URender::PreRender (`0x10b14560`) calls
the light manager's noise (`0x10b13080`, through `0x10b30a08`, at
`0x10b146ae`) unconditionally, every Draw, with the viewport level's
`Actors(0).TimeSeconds`, after `appEnableFastMath(1)`. Its draws are Core
`appFrand` (`rand()·(1/32767)`, [the original stream](rng.md)): msvcrt's
per-thread `rand`, which the game thread shares with UnrealScript's FRand,
physics and the render iterators. In UGameEngine::Draw that call follows
PlayerCalcView and Audio->Update and precedes the PreRender event and
DrawWorld (SetupDynamics' iterator draws). Play advances the noise in the
simulation at that point of its frame (sim-session.mjs `begin`, after the
view and before the render viewport) from the game's shared stream
(`runtime.rng`), and the page's light frame takes its tables
(`frame.light`, static-lighting.mjs `lightNoiseSnapshot`). Before this
change the page drew the noise from a host stream of its own; the class 1
light animation now uses the simulation's noise too. The tables and `last`
are process-global in the original and survive a LoadMap; Play's start a
fresh session with `last = 0`, which takes the same reset branch the
original takes when TimeSeconds steps back.

### Translation

`src/viewer/moving-lights.mjs` dispatches every class 2 light by the effect
row (`NORMAL_BODY`, `SPOT_BODY`, NonIncidence, Shell) and has no float
fallback left. Per frame it applies `lightTypeBrightness` with the frame's
TimeSeconds, noise and the strobe state it shares with the class 1 animation,
then ComputeFromActor's colour steps; the wavers' spatial bytes go through
the merge's modulation from index 0 (each (noise entry, byte) entry computed
when first asked in its noise input's frame, with `createLightFrame`
`modulation`'s rounding). A contribution caches its rectangle's spatial
bytes while its light's location and fields are unchanged; a steady
contribution also keeps its addends, a time-varying one is added directly.
The light maps a changing light reaches recompose only when drawn
(OccludeBsp's drawn surfaces, listed, else the frustum test, as the class 1
animation does): the original rebuilds the per-frame map of drawn surfaces
only, and a map's texels depend only on that frame's inputs. A time-varying
light does not mark its maps dirty: one pass over the drawn maps recomposes
those whose colour or noise tokens changed since they were composed.
`game.movingLights()` reads LightPeriod and LightPhase for the types that
use them, a Pawn's ViewRotation for a spot, and gives each light its
Level.Actors slot (low byte) as the Flicker key, the host's stand-in for the
actor's address.

### Validation

`native-dynamic-light-oracle.py` `movingFrames` runs the class 2 chain above
unchanged at `0x007f`: per frame Level.TimeSeconds and tables A and W, per
light GlobalLighting with the chained strobe state (the actor allocated at
the light's flicker key), the brightness, colour and colour table, and per
contribution the radius constants, incidence, rectangle, 0x7f illumination,
the row's spatial function and the merge from index 0.

`scripts/validate-moving-light-effects.mjs` (headless, UNATCO Island, full
mode): Island's three BarrelFires plus a lit Flare, a BarrelAmbrosia, a
turning AlarmLight, 99_Endgame4's Strobe AlarmLight and 14_Vandenberg_Sub's
Flicker LaserTrigger, over eight frames (advancing, repeated and jumping
TimeSeconds; one seeded noise stream). 168 light-frames, 2,448
contributions, 218,232 texels (88,077 lit) and 1,592 composed light maps
match the original: rectangles, constants, incidence, spatial bytes and
every composed texel. Pairs: Steady None, FireWaver, TorchWaver,
WateryShimmer and Spotlight, Strobe Spotlight, Flicker None. Against
`0x037f` (`ORACLE_CW`) 2,120 of 11,390 checks differ.

`scripts/validate-moving-light-effects-play.mjs` runs Island in the browser
(default worker mode; `--query sim=inline` too) looking at BarrelFire3: over
three captured frames, the 15 light maps composed with a BarrelFire (27
contributions, 6,726 lit texels) equal the oracle's for each frame's own
inputs, the page's noise is the simulation's, and the fire's light maps
change every frame. `validate-moving-lights-incremental` now gives both
worlds a light frame each frame, with probes for Strobe WateryShimmer,
Flicker FireWaver and a turning spotlight, and still finds the incremental
mode equal to the full one.

`validate-moving-lights-incremental` also runs a third world, incremental
and gated as Play gates it (a seeded drawn set of level surfaces on odd
frames, a seeded stand-in for the frustum test on even ones): every drawn
light map equals the full mode's (25,133, 89,774 and 113,739 map-frames on
Training, Island and the Airfield).

### Rust composition and the atlas conversion (2026-11-07)

The per-texel work of the incremental mode runs in the Rust core (`native/script-vm/src/moving.rs`, driven by
`src/runtime/moving-compose-kernel.mjs`; measured in [Firefox 60 fps plan](firefox-60fps-plan.md#moving-lights-2026-11-07)):
`addDirect`'s saturating add onto the float texels and `light-atlas.mjs update`'s float to byte conversion, with the atlas rectangle's
one-texel padding, for every light map recomposed in a frame in one call. Both JavaScript bodies stay as the references
(`?movingCompose=js`, `MOVING_COMPOSE=js`); `?movingCompose=verify` runs both and compares every float (as bits), every count of texels
written and every atlas byte (`deusExViewer.movingLights().stats.verify`, `hitch-run.mjs --eval`).

* A texel channel is a float32 that the reference reads as a double, adds the colour's amount to (`Math.min(127, (b·step) >> 16) / 255`, a
  double) and stores as `Math.min(127/255, sum)` rounded to float32. Rust: `((p as f64) + amount).min(MAX) as f32`; the amounts are made
  in Rust from the int32 steps (`(b·step) as i64 as i32 >> 16`, the product being an exact double and `>>` an int32 shift), a colour with
  a step outside int32 composes in JavaScript.
* A modulated light (TorchWaver, FireWaver, WateryShimmer) maps each nonzero spatial byte through the frame's table at
  `(index & 255) << 8 | byte` (`index` counting every texel of the contribution's rectangle from 0). The entries are filled when a texel
  first asks, by light.rs `modulation_entry`, the function the class 1 kernel's `light_modulation` fills its table with; the table of an
  effect is cleared when its noise input (frame index, or the noise version for WateryShimmer) changes, as the reference's `modulator` does.
* The atlas byte of a float32 sample `s` is `Math.round(Math.max(0, Math.min(1, s)) * 255)` stored through a Uint8Array. Rust computes
  `floor(v * 255 + 0.5)` on the clamped double (a float32 times 255 has at most 32 significant bits, so the sum with 0.5 is exact), four
  texels at a time on wasm simd128 with the same operations. `scripts/validate-moving-convert.mjs` compares the core with the reference
  for **all 2^32 float32 bit patterns** (16,777,214 NaNs, stored as 0, included).
* What the bytes are: a static texel is `fround(k / 255)` for a byte `k`, a contribution adds `e / 255` with an integer `e` in 0..127, and
  the sum is held at `127 / 255`. Each step moves the float by about 1e-7 against the 2e-3 that separates two bytes, so the atlas byte of
  any chain of contributions is the integer chain `min(127, k + e1 + e2 ...)`; `validate-moving-convert` checks every static byte against
  every amount the colour tables produce (14.6 million steps, chains up to four contributions deep). This is the reason the light maps' own
  floats are still produced by the float arithmetic above (they are what `lighting.mjs` and the validators read): the integer reading is
  evidence for the bytes, not a substitute for the floats.
* Contributions whose spatial bytes are all 0 ("dead": a light behind the surface, a rectangle the light cannot reach) write no texel in any
  frame, since the loop skips a 0 byte before and after the modulation; they are left out of the job, and a light map with nothing else
  to recompose is not recomposed (the reference recomposes it unchanged every frame).
* A turning spotlight (`LE_StaticSpot`, `LE_Spotlight`: only the Rotation of the light's fields changes) keeps the surfaces it reaches,
  their rectangles, incidence and grids (none depends on the axis) and makes its spatial bytes again. `?movingCompose=verify` makes the
  reach in full beside it and compares.

### Cost

Browser, default worker mode, Linux host (Ryzen 9 8945HS), 1920×1080,
Player start, 240 frames, 3 interleaved pairs against master `d4cb676`
(each tree served from a snapshot; medians of the per-run medians; the
moving-light sync now counts in the `lightAnimation` phase, before in
`tick`):

| Map | Page total | lightAnimation + lightUpload | Worker |
| --- | --- | --- | --- |
| 01_NYC_UNATCOIsland (3 BarrelFires) | 3.03 → 3.55 ms | 0.06 → 0.58 ms | 16.05 → 16.08 ms |
| 10_Paris_Catacombs_Tunnels (76 BarrelFires) | 2.78 → 3.96 ms | 0.03 → 1.16 ms | 15.89 → 15.88 ms |

The difference is the fires' per-frame flicker, which the old path did not
draw (their light maps stayed static after the first frame). The
bookkeeping changes took the headless frustum-gated Catacombs update from
4.4 to 3.5 ms (dc8a8b9), and the browser light phase from 1.06 ms (436f49c)
to 0.99 ms (88aca28, the modulated bytes on demand).
In the browser profile of Catacombs Tunnels the per-texel composition
(`addDirect`) is 0.18 ms a frame; the rest is per-light and per-map host
bookkeeping (the light loop, colours, inputs, recomposition restores) and
the light atlas's tile updates. The measurement does not name the
per-texel lighting work, so the composition stays in JavaScript; moving it
to the Rust core would mean keeping the light maps' samples in the core's
memory.

## Not reproduced / open

* The frustum test in SetupDynamics and OccludeBsp's visibility-driven filter:
  the browser filters the whole BSP. Only surfaces the original does not draw
  can differ, except where a surface split across nodes has a visited node the
  light cannot reach and an unvisited one it can.
* The 2048-surface `NumDynLightSurfs` cap and its traversal order.
* The light-map grid (start and steps) comes from `lightmapBasis`, not from
  `FCoords::Inverse`; the oracle compares the spatial body on identical grids.
* Mover polygons: the brush tracker is recovered ([brush tracker](brush-tracker.md)),
  but FDynamicLight::Filter does not walk its fragment nodes yet: mover light
  maps take Filter's straddle test on their own plane. Their facet is the one
  their static texels were built on, the tracker's when drawn
  ([static lighting](static-lighting.md#mover-surfaces-in-setupforsurf-2026-10-17)).
* What effects the shipped content reaches, on which kind of light, and which are not
  reached: [light effects](light-effects.md).
* Class 2 lights use the original bodies for every effect the shipped content
  reaches ("Time-varying moving lights"). Cylinder and the spatially dynamic
  effects stay unlit with a note for class 2 (no class 2 light has them); the
  texture-palette LightTypes stay steady.
* Flicker's key is the light's export index (map actors) or Level.Actors
  slot, low byte, not the actor's address (unreproducible: it depends on the
  allocator's history).
* Strobe's single flag (since 2026-10-07): the simulation flips it, once per
  new TimeSeconds, on frames where a drawn surface lists a live Strobe light,
  a moving Strobe light reaches a drawn surface, a drawn mesh sets one up or
  Galaxy asks for one, and hands it to the page's light maps
  ([mesh lighting](mesh-lighting.md) "LightType functions, Strobe and the
  noise"). Since 2026-10-14 the drawn surfaces of every frame count, the main
  frame's and each mirror and sky child frame's, as DrawFrame (`0x10b1a2d0`) sets
  them up: children first, then SetupForSurf (`0x10b1aa99`) for each frame's own
  surfaces; measured in the original as SetupForSurf calls with Frame->Recursion 1
  at a mirror view ([visual acceptance](visual-acceptance.md#strobe-in-child-frames-2026-10-14)).
  A moving Strobe light reaches a frame when SetupDynamics' ViewPlanes test takes it
  for that frame's four planes and Filter puts it on one of that frame's surfaces.
  The movers' own polygons are not searched for Strobe lights.
* Mesh and volumetric lighting (`LeafLights`, SetupForActor, LeafVolumetricLighting)
  are in [mesh lighting](mesh-lighting.md) and [volumetric fog](volumetric-fog.md);
  which effects they read is in [light effects](light-effects.md#who-reads-lighteffect).
* Class 2 lights that also sit in a surface's static `LightActors` list would
  be added twice and unshadowed by the original, and the static path does not
  model it. None of the 15,707 lights the 83 maps' surfaces list is of class 2
  ([light effects](light-effects.md#census-which-effects-on-which-kind-of-light)).
