# Static lights on BSP light maps

Stage 4, 2026-10-02. The static light maps in Play are still the Stage 1.5
float reconstruction (`src/unreal/lighting.mjs`, [lighting](lighting.md)).
It approximates the shadow blur, falloff and colour in floats. It also
refuses every light whose LightEffect it does not model, and the whole
surface then fails to draw. A census of the 83 single-player maps finds such
lights on BSP surfaces in 34 maps: LE_Cylinder (421 lights, mostly the NYC
streets), LE_TorchWaver (76), LE_FireWaver (14), LE_Rotor and LE_Searchlight
(8 each), LE_Disco and LE_SlowWave (5 each) and LE_FastWave (1). This note
records the original Render.dll path for static lights, which the moving
lights ([dynamic lighting](dynamic-lighting.md)) already partly use, as it
is recovered and moved into Play.

Authority: Render.dll `607f1077…d75d1` (preferred base `0x10b00000`).

## The static light map (SetupForSurf)

FLightManager::SetupForSurf (`0x10b06c90`) lists a surface's lights through
AddLight (`0x10b08b30`), whose class decides when a light is computed:

| Class | Lights | Computed |
| --- | --- | --- |
| 0 | `bStatic`, `LT_Steady`, an effect row with neither dynamic flag; any `bStatic`/`bNoDelete` light when `UClient::NoDynamicLights` | once, into the cached static map |
| 1 | other `bStatic`/`bNoDelete` lights | every frame, onto a copy of the static map |
| 2 | the rest (moving lights) | every frame, unshadowed |
| 3 | LE_OmniBumpMap | not on the light map |

The effect table at `0x10b2a0f0` has 12-byte rows {spatial function,
IsSpatialDynamic, IsMergeDynamic}:

| Effects | Spatial function | Spatial dynamic | Merge dynamic |
| --- | --- | --- | --- |
| None, Warp, OmniBumpMap, Unused | normal `0x10b03360` | | |
| TorchWaver, FireWaver, WateryShimmer | normal `0x10b03360` | | yes |
| StaticSpot, Spotlight | spot `0x10b04f80` | | |
| NonIncidence | `0x10b054e0` | | |
| Cylinder | `0x10b04a80` | | |
| Shell | `0x10b05740` | | |
| Searchlight, SlowWave, FastWave, CloudCast, Shock, Disco, Interference, Rotor | `0x10b03770`, `0x10b03de0`, `0x10b040b0`, `0x10b04380`, `0x10b043a0`, `0x10b046f0`, `0x10b04c80`, `0x10b03ae0` | yes | |

On a cache miss, SetupForSurf builds the static map like this:

1. Fill every texel with the zone's ambient: FGetHSV of AmbientHue,
   AmbientSaturation and AmbientBrightness (zone `+0x38d`, `+0x38e`,
   `+0x38c`), scaled and converted to BGRA bytes with alpha `0x7f`.
2. For each class-0 light, run ComputeFromActor (`0x10b05fa0`). Then build
   the illumination bytes from the light's shadow bits (`0x10b02650`), run
   the effect's spatial function into a byte per texel, and merge
   (`0x10b03040`): add the light's colour-table entry for that byte, each
   channel saturating at 127.

The merge is a saturating add of non-negative bytes, so the lights' order
does not change the result.

## Illumination (`0x10b02650`)

The light-manager init (`0x10b02112`) builds a local 8×8 weight matrix whose
rows are `[0,24,40,24]`, `[0,40,64,40]` and `[0,24,40,24]` (total 320). From
it, `0x10b02352` builds a 128-entry table at `0x10b3cae0`. For each 7-bit run
of shadow bits and each matrix row, an entry holds four packed bytes:
`trunc(Σ weights of set bits · 255 / 320)`, with byte b reading bits
`b+1..b+3`.

The illumination function reads one shadow byte (8 texels) at a time
through a sliding window. The first texel is repeated twice to the left and
the row's last bit twice to the right; that bit is a padding bit when the
width is not a multiple of 8. Each shadow row scatters its three weight
rows into the rows above, at and below it. The first and last rows take
their own outer contribution, and a single-row map's lower contribution
falls past the map. Rows are padded to whole bytes, a stride of
`ceil(width/8)·8`. A fully lit texel is `70+114+70 = 254`. With no shadow
bits the buffer is `0x7f`, exactly half of that, which is what moving
lights get.

`shadowTable` and `shadowIllumination` (`src/runtime/static-lighting.mjs`)
translate it. `scripts/validate-static-lighting.mjs` runs the original
(`native-dynamic-light-oracle.py`, with appMemset as `rep stosb`) and
compares the table and every shadow mask. Training's 15,754 masks
(8,892,842 texels) and every third light map on UNATCO Island (5,070
masks) match, as do eight fabricated widths and heights and the no-shadow
fill.

## Ambient, spot and cylinder

**Ambient** (`0x10b07fcc`-`0x10b080cf`). Each channel of the zone's FGetHSV
becomes `clamp(FISTP(float(float(c·0.25)·256) − 0.5), 0, 255)`; the
products are exact powers of two. The texel is BGRA with alpha `0x7f`
(`ambientTexel`).

**Spot** (`0x10b04f80`, LE_StaticSpot and LE_Spotlight).
- *Direction.* The X axis of `GMath.UnitCoords / Rotation`, using
  ViewRotation for a Pawn. That is Core's operator `0x1011b690`, which
  `fcoordsAxes` already translates.
- *Cone.* `c = 1 − LightCone/256`, with `1/(1−c)`, `c/(1−c)` and `c²` stored
  as floats.
- *Per texel with illumination.* The falloff index is
  `FISTP(float(d²)·rr2)`, zero at 4096 or more. The byte is zero unless the
  axis dot is positive and `dot² > d²·c²`. Otherwise
  `s = rsqrt(d²)·dot/(1−c) − c/(1−c)` and the byte is the low byte of
  `FISTP(float(s²·normal[index]·illumination·incidence) − 0.5)`.
- *rsqrt.* It reads the light manager's x^-0.5 tables (init `0x10b022d0`,
  builder `0x10b024b0`: `float(appPow(|x|, −0.5))` over 512 exponent and
  1024 mantissa patterns). appPow is the CRT's x87 pow, taken as the JS
  double. The nearest float rounding midpoint is 6.4·10⁻¹¹ (relative) away,
  so no table entry depends on that choice.
- *Code.* `spotLightSpatial` keeps the displacement and sum arithmetic in
  doubles at the recovered float stores, and runs the `s` chain on the x87
  model.

**Cylinder** (`0x10b04a80`, LE_Cylinder). The byte is
`max(0, FISTP(float((1 − (dx²+dy²)/R²)·illumination) − 0.5))`, using
horizontal distance only and no cut beyond the texel rectangle
(`cylinderSpatial`).

## Static light validation

`validate-static-lighting.mjs` phase 2 runs the zone ambients and 64
fabricated triples. On every `--surfaces`-th world surface, it then chains
each class 0 and 1 light, starting from an ambient fill, through the
original rectangle, incidence, colour table, illumination, spatial body and
merge. The oracle runs the original spot and cylinder bodies with Core's
operator, using GMath filled with `coords.mjs`'s sine table and IsA stubbed
to "not a Pawn"; appPow is Python's double pow.

| Map | Light steps | Of which | Texels | Mismatches |
| --- | ---: | --- | ---: | ---: |
| 00_Training, every surface | 15,745 | 7,737 spot | 8,891,470 | 0 |
| 01_NYC_UNATCOIsland, every 4th surface | 3,425 | | 7,753,474 | 0 |
| 04_NYC_Street, every 3rd surface | 4,538 | 332 spot, 483 cylinder | 4,210,782 | 0 |

The rsqrt tables match bit for bit. Like the moving-light bodies, the
per-texel arithmetic outside the x87-model chains is a measured match, not
a proof for all inputs.

## Play

`createLighting` (`src/unreal/lighting.mjs`) now fills every BSP and brush
light map through `staticLightMap` (`src/runtime/static-lighting.mjs`):
- the zone's ambient bytes;
- then each listed light in list order, with its own shadow mask (selected
  by list index);
- the original rectangle, incidence, illumination, spatial body and colour
  merge;
- texel bytes divided by 255 for the atlas.

The surface's facet and texel grid are those SetupForSurf sees: a level
surface keeps its serialized float vectors, and a brush surface takes its
mover transform, as the moving lights do. Moving lights still add onto a
copy of these texels.

What changed in the browser:
- **Missing surfaces drawn.** Surfaces lit by LE_Cylinder, LE_TorchWaver or
  LE_FireWaver lights are no longer refused. On Battery Park, NYC Street,
  Wan Chai Market and Area 51 Bunker, every "Unsupported light effect"
  surface now draws; the remaining errors there are the older mover
  correspondence ones.
- **Closer to the original game.** Training's entrance view (the saved
  `reports/lighting` camera, 926×603, brightness 0.40) moved closer in all
  six regions of the original-game comparison. The worst region went from
  2.78 to 1.26 mean RGB levels: ceiling 1.90 → 0.85, beam 0.97 → 0.68,
  pillar 0.83 → 0.70, door 2.03 → 0.98, warm wall 2.78 → 0.61, cyan strip
  2.47 → 1.26. The old numbers were measured on the Mac and the new ones
  headless on Linux. HUD, meshes and the mirror floor stay excluded, and
  this remains a regional comparison.

Diagnostics, still open:
- Time-varying effects (Searchlight, SlowWave, FastWave, CloudCast, Shock,
  Disco, Interference, Rotor) and Shell leave their lights out of the light
  map, with a note naming the effect.
- Class 1 lights are steady snapshots (LightType variation and the
  torch/fire/watery merge modulation are not active), with notes.
- A class 2 light in a static list is skipped, with a note; none has been
  seen.

## Not yet moved

Still to do: the time-varying spatial functions, the merge-dynamic
modulation, the LightType functions (pulse, flicker, strobe…), class 1's
per-frame recomputation, and volumetric (fog map) lighting.

Two facts recovered from SetupForSurf's listing matter for that wiring:
- A level surface's static list goes through AddLight with each light's
  shadow mask; the mask pointer advances for every list entry, including
  rejected lights. There is no bSpecialLit test there. On Training, Island,
  Battery Park and NYC Street no listed light mismatches its surface.
- A class 2 light from a static list is merged unshadowed every frame, even
  though it has a mask. None of those four maps has one.
