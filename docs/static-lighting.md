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

## Not yet moved

Play still draws the float reconstruction. The ambient fill, the spot,
Cylinder and time-varying spatial functions, the merge-dynamic modulation,
the LightType functions (pulse, flicker, strobe…) and class 1's per-frame
recomputation come next, in that order.
