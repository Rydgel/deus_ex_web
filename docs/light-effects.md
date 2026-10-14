# Light effects: reach, coverage and what the original reads

Stage 4, 2026-10-14. LightEffect (`AActor +0x1e1`) picks a light's spatial function and its
merge modulation. This page answers, from the shipped content and from Render.dll's code, which
effects exist on which kind of light, which are implemented and validated against the original,
and which no shipped map or script reaches. The detail of each body is in
[static lighting](static-lighting.md), [moving lights](dynamic-lighting.md) and
[ordinary moving lights](moving-normal-lighting.md); the x87 word each runs at is in
[render-pass precision](render-pass-precision.md#measured-in-the-running-original-2026-10-14).

Authority: Render.dll `607f1077…d75d1`, Engine.dll `0c3a8b18…c20b4`; the census is
`scripts/census-moving-lights.mjs --text` (original data only: every actor of the 83
single-player maps over its class defaults, the packages' class defaults, and their ScriptText).

## Who reads LightEffect

Every read of byte `+0x1e1` in the install, by disassembly (`objdump -d`, grep `+0x1e1]`):

| Module | Address | Reader |
| --- | --- | --- |
| Render.dll | `0x10b060b9` | ComputeFromActor: copies the effect row `0x10b2a0f0 + 12·effect` (an effect of 20 or more takes row 0) to the light info (`+0x60` spatial function, `+0x64` spatially dynamic, `+0x68` merge dynamic) |
| Render.dll | `0x10b081e5` | SetupForSurf, static cache: the merge `0x10b03040` takes the effect |
| Render.dll | `0x10b088ed` | SetupForSurf, per-frame map: the same merge |
| Render.dll | `0x10b08b7a` | AddLight: the class decision (`LE_OmniBumpMap` is class 3; an effect row with a dynamic flag makes a `bStatic` light class 1) |
| Render.dll | `0x10b0911f`, `0x10b092cc`, `0x10b09443` | SetupForActor's three candidate loops (cached entries, leaf lights, permeating lights): `LE_Cylinder` (17) scales both brightness and radius by 0.75 |
| Engine.dll | `0x10324435`, `0x10325773`, `0x1032776a`, `0x10329846` | field copies of the lighting block (assignment of an actor's light properties) |
| Engine.dll | `0x10362b7b` | a compare of the lighting block (the `bLightChanged` test) |
| D3DDrv, Galaxy, Core, Extension | none | |

So the effect matters to light maps (three sites reached through the effect row and the merge)
and to mesh lighting only through Cylinder's 0.75 (the per-vertex `Light` `0x10b027f0` never
calls the effect row's function: no spot cone, no waver, no spatial variation), and not to
volumetric fog (LeafVolumetricLighting), coronas, or any other module.

## Census: which effects, on which kind of light

Every lit map light (LightType not None, LightBrightness not 0) by effect and AddLight class
([static lighting](static-lighting.md#the-static-light-map-setupforsurf): class 0 is cached in the
static map, 1 is recomputed each frame onto a copy of it, 2 is a moving light, unshadowed).
`script` is a class that has no light until a script sets LightType (a flare, an alarm unit).

| Effect | Class | Lights | Maps | LightTypes | Sources |
| --- | --- | ---: | ---: | --- | --- |
| None | 0 | 13,056 | 82 | Steady | Light 13,001, Spotlight 55 |
| None | 1 | 352 | 54 | Flicker, Steady, Pulse, SubtlePulse, Strobe | Light 223, TriggerLight 129 |
| None | 2 | 396 | 56 | Steady, Flicker | SecurityCamera 217, CageLight 155, Gray 11, Lamp3 9, HKMarketLight 2, GrayCarcass 1, LaserTrigger 1 |
| None | script | 823 | 57 | script | Barrel1 489, ElectricityEmitter 178, AlarmUnit 107, CageLight 49 |
| Spotlight | 0 | 1,665 | 58 | Steady | Spotlight 1,020, Light 645 |
| Spotlight | 1 | 14 | 8 | Steady, SubtlePulse, Pulse, Flicker | TriggerLight 5, Spotlight 6, Light 3 |
| Spotlight | 2 | 27 | 9 | Steady, Strobe | AlarmLight 27 |
| Cylinder | 0 | 423 | 15 | Steady | Light |
| Cylinder | 1 | 2 | 1 | Flicker | Light |
| NonIncidence | 0 | 12 | 3 | Steady | Spotlight |
| TorchWaver | 1 | 77 | 11 | Steady | Light 75, TriggerLight 2 |
| TorchWaver | script | 107 | 23 | script | Flare |
| FireWaver | 1 | 14 | 5 | Steady | Light 12, BarrelFire 1, TriggerLight 1 |
| FireWaver | 2 | 240 | 19 | Steady | BarrelFire |
| WateryShimmer | 1 | 130 | 20 | Steady | Light 122, Spotlight 8 |
| WateryShimmer | 2 | 31 | 12 | Steady | BarrelAmbrosia 23, BarrelVirus 7, WeaponNanoSword 1 |
| Searchlight | 1 | 8 | 6 | Steady | TriggerLight 6, Light 2 |
| Rotor | 1 | 8 | 3 | Steady | Light |
| Disco | 1 | 5 | 3 | BackdropLight, Steady | Light |
| SlowWave | 1 | 5 | 2 | Steady, Pulse | TriggerLight 1, Light 4 |
| FastWave | 1 | 1 | 1 | Steady | TriggerLight |

Effects with no map light: **CloudCast, StaticSpot, Shock, Warp, Shell, OmniBumpMap,
Interference, Unused**. The packages' scripts assign LightEffect once, to Shell (the EMP and
nano-virus grenades' ExplosionLight, a class 2 light the player spawns); no script assigns a
LightType other than None or Steady
([moving lights](dynamic-lighting.md#time-varying-moving-lights-2026-10-06), census "Script writers").

The lights the level's surfaces list (`UModel.Lights`, the static light lists SetupForSurf adds
through AddLight): 15,707 distinct in the 83 maps, of which class 0: 14,927, class 1: 606, none
of class 2 or 3, and 174 with no brightness at load. A class 2 light in a static list would be
merged twice by the original (once from that list, once from SetupDynamics') and Play's static
path omits it with a note; no shipped map has one.

## Coverage

Every (effect, class) pair above has its Render.dll body translated and checked against the
original executed under Unicorn, and runs in Play:

| Pair | Body | Play | Original comparison |
| --- | --- | --- | --- |
| None (all classes), Warp, Unused | normal `0x10b03360` | light maps: JavaScript, light.rs merge; GPU atlas upload | `validate-static-lighting` (Training, Island, NYC Street, Intro, Free Clinic: 36.3 M texels), `validate-normal-moving-lighting` (class 2: 37,763 texels) |
| Spotlight (0, 1, 2), StaticSpot | spot `0x10b04f80` | the same | `validate-static-lighting` (NYC Street, 332 spot steps), `validate-moving-light-effects` (AlarmLight class 2, Steady and Strobe) |
| Cylinder (0, 1) | `0x10b04a80` | the same | `validate-static-lighting` (NYC Street, 483 steps) |
| NonIncidence (0, and class 2: AugLight, muzzle flashes, explosions) | `0x10b054e0` | the same | `validate-dynamic-lighting` (438 surfaces, 72,255 texels), `validate-static-lighting` |
| TorchWaver, FireWaver, WateryShimmer (1, 2) | normal body plus the merge's modulation `0x10b030f2–0x10b03244` | light.rs `light_modulation`, per-frame noise from the shared appFrand stream | `validate-light-animation` (3,556 merged texels), `validate-moving-light-effects` (BarrelFire, Flare, BarrelAmbrosia over 8 frames) |
| Searchlight, SlowWave, FastWave, Disco, Rotor (1) | `0x10b03770`, `0x10b03de0`, `0x10b040b0`, `0x10b046f0`, `0x10b03ae0` | spatial.rs, rerun inside the merge for each new Level.TimeSeconds | `validate-light-spatial` (3,082 cases, 377,732 texels, 286,158 measured FPATAN products), `validate-light-spatial-play` |
| Shell (2, script) | `0x10b05740` | spatial.rs | `validate-light-spatial` (the grenades' ExplosionLight on Training) |
| LightType functions of every class | `0x10b05a10–0x10b05b90` | `lightTypeBrightness` | `validate-light-animation` (2,560 frames), `validate-mesh-light-types` (416 frames), `validate-moving-light-effects` |

`scripts/census-light-notes.mjs` builds the static light map of every level surface of the 83 maps
through Play's own lighting (the Rust core loaded): 328,809 surfaces, 12,938 of them with an animated light, no
surface refused, and no "not translated" note (the only note is that `bNoDelete` lights take script
brightness changes through explicit invalidation, 30 maps). Without the core the spatially dynamic
effects raise that note (Searchlight, Disco, SlowWave, Rotor, FastWave: 12 maps), as designed.

Mesh lighting needs no effect body: [mesh lighting](mesh-lighting.md) has the Cylinder
0.75 (0 diffuse bytes differ from the native oracle on every checked actor).

Ranked by use (lights): None 13,804 (and 823 script-lit), Spotlight 1,706, Cylinder 425, FireWaver 254, WateryShimmer 161,
TorchWaver 77 (and 107 flares), NonIncidence 12, Searchlight 8, Rotor 8, Disco 5, SlowWave 5, FastWave 1;
class 2 (moving) lights: None 396, FireWaver 240, WateryShimmer 31, Spotlight 27.

## Not reached, so not implemented

Each is unreachable by the census above and by the packages' scripts, and stays explicitly
unsupported (the code names it in a note instead of drawing something else):

- **CloudCast `0x10b04380`, Shock `0x10b043a0`, Interference `0x10b04c80`**: no map light.
  spatial.rs has the bodies and the oracle checks them, as part of the spatially dynamic set.
- **StaticSpot, Warp, Unused, OmniBumpMap**: no map light. StaticSpot takes the spot body, Warp
  and Unused the normal body (both translated); OmniBumpMap is class 3, which the light maps
  skip as the original does (a note says so).
- **The spatially dynamic effects and Cylinder on class 2 (moving) lights**: no class 2 light
  has one (`classTwoPairs` in the census); `moving-lights.mjs` notes them and leaves such a
  light unlit.
- **Class 0 lights with a spatially dynamic effect** (`UClient.NoDynamicLights`, which Play
  never sets).
- **LightType 8 and 9 (texture palette)**: no light has them; they stay steady with a note.
- **A class 2 light in a surface's static light list**: none of 15,707 listed lights.

## Matched captures

[Visual acceptance](visual-acceptance.md#light-effects-against-the-original-2026-10-14) compares raw frames of the
original and of Play at held level time and cameras aimed at one effect's surfaces: Searchlight (garage), Rotor (ship fan), Disco
(Paris club), a lamp's Spotlight pool and a Cylinder light (NYC street), SlowWave (ship's hold). The bodies that change every frame
(Searchlight, Rotor, Disco, SlowWave) match at the held phase. The wavers (TorchWaver, FireWaver, WateryShimmer) draw their
modulation from the light noise's appFrand stream, a host input the two sides do not share, so their frames cannot be compared
pixel for pixel; they are checked by the oracle with the noise tables supplied (`validate-light-animation`,
`validate-moving-light-effects`). FastWave's only light (Endgame 2) and the Searchlights of Helibase, Area 51 Page and Endgames 1 to 3
are TriggerLights with `bInitiallyOn` false: off until a trigger fires, so a frozen frame of the level shows nothing from them.
