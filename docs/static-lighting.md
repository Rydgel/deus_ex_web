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

## Singular light-map bases

SetupForSurf inverts the facet's FCoords (Core `FCoords::Inverse`, call at
`0x10b06175`) without a test. For a surface whose texture axes are
collinear with its normal (11 surfaces: 5 in 00_Intro, 5 in
02_NYC_FreeClinic, 1 in 12_Vandenberg_Cmd), the zero determinant makes the
whole texel grid non-finite.
- Every coefficient of the normal body becomes FISTP's integer indefinite.
- The NonIncidence, spot and cylinder bodies write zero bytes.

`lightmapBasis` now yields NaN texel positions there instead of refusing
the surface. The translated bodies treat NaN as the x87 treats those
values, and `validate-static-lighting` covers these surfaces: all 8,505
light steps on every Intro surface and 2,184 on the Free Clinic's match the
original fed the same grid. Their textures still map normally, since
texture mapping does not use the inverse.

## Light animation

Three per-frame inputs drive the class 1 lights. All three are
translated, oracle-checked (`validate-light-animation.mjs`) and wired into
Play (see "In Play" at the end of this section).

**Noise** (`0x10b13080`). It is called once a frame with Level.TimeSeconds
through a second light-manager object (`0x10b30a08`, call at `0x10b146ae`).
- `step = ftol(time·35)`.
- Table A (`0x10b4fa44`) takes 256 fresh appFrand floats every frame.
- Table W (`0x10b4fe44`) eases toward A. When `0 ≤ step − last < 16` and
  there was a previous step, the slopes S (`0x10b4f644`) of the
  `16·(step − last)` entries from `last·16` are re-aimed at `(A − W)/16`,
  and the remaining entries advance by `(step − last)·S`. Otherwise W takes
  256 more draws and every slope is re-aimed.
- W is clamped to [0, 1].

The draws come from the process-wide CRT rand, whose position at each frame
the browser does not reproduce: Play will feed a host stream.

**LightType** (GlobalLighting `0x10b05e90`, table `0x10b2a284`). Each type
function changes the float brightness, which is then clamped to [0, 1].
- Pulse: `0.6 + 0.39·sin`; SubtlePulse: `0.9 + 0.09·sin`. The angle is
  `ftol(TimeSeconds·2293760/max(1, LightPeriod) + LightPhase·256)`, through
  GMath's sine table.
- Blink: dark on an odd `ftol(TimeSeconds·2293760/(LightPeriod+1) +
  LightPhase·256)`.
- Flicker: dark below 0.5 of A at the low byte of the actor's address (a
  host key in Play), scaled by it otherwise.
- Strobe: dark while one shared flag, flipped whenever TimeSeconds changes,
  is set.
- BackdropLight and Steady: unchanged.
- The two texture-palette types: not translated.
- Every type is steady unless the viewport actor's SHOW_PlayerCtrl (0x800)
  is set, which it is in play.

**Merge modulation** (`0x10b030f2`-`0x10b03244`). Before the saturating
add, each spatial byte of a TorchWaver, FireWaver or WateryShimmer light
becomes the low byte of `FISTP(float(spatial·factor) − 0.5)`, where factor
is `0.95 + 0.05·A[i]`, `0.8 + 0.2·A[i]` or `0.6 + 0.4·W[i]`, with `i`
running on from the merge's start index.

The oracle runs the noise function (scripted appFrand, msvcrt `_ftol` as
the truncating x87 sequence) over 240 frames: irregular steps, repeats, a
backward step, jumps, and three starting steps. It runs GlobalLighting for
eight types × four lights over 40 frames each (1,280 frames, including
animation off) and the merge for the three effects on 18 random rectangles
(3,600 texels). Everything matches.

**In Play.**
- *Cached spatial bytes.* `staticLightMap` leaves animated class-1 lights
  (Pulse, Blink, Flicker, Strobe, SubtlePulse, and the three wavers) out of
  the static bytes and keeps their spatial bytes, as SetupForSurf caches
  them.
- *Per frame.* Each drawn frame, `world.updateTextureAnimation` advances
  the noise with Level.TimeSeconds (`createLightFrame`). `lighting.animate`
  then re-merges every animated light map from its static bytes: each
  light's GlobalLighting colour is computed once per frame, the wavers' bytes
  go through their noise tables, and the merge starts at index 0 as at
  `0x10b088de`. Changed regions are uploaded, and moving lights still add on
  top.
- *Exact fast path.* The merge factors are doubles, and the per-(entry,
  byte) modulation table is rebuilt only when its noise input changes. The
  validator checks those doubles against the x87-model modulation for all
  6,291,456 (noise entry, byte) pairs of 32 frames, with no difference.
- *Skipping and culling.* A light map whose lights' colours and noise
  inputs are unchanged is skipped. Without a possible mirror view, level
  light maps outside the camera frustum wait. The merge does not depend on
  which surfaces are drawn, so a skipped map is correct once it is drawn.
- *Host choices, noted in the viewer.* The noise draws come from a host
  appFrand stream, and Flicker's entry is the light's export index
  (low byte) instead of its address.
- *Not in Play yet.* The texture-palette LightTypes (8, 9) and the
  spatially dynamic effects.

## Rust kernel

The per-frame merge (`animateLightMap`) runs in the Rust core
(`native/script-vm/src/light.rs`, driven by
`src/runtime/light-animation-kernel.mjs`) as an exact representation change.
`animateLightMap` stays the reference: `LIGHT_KERNEL=js` in Node or
`?lightKernel=js` in the viewer selects it. Browser profiles on October 2
measured its JavaScript loop at 2.5 ms/frame on Training, 1.7 on Battery
Park and 1.0 on Everett (`play-frame-cost.md`).

- **Where.** light.rs runs in the script-VM kernel instance, with no
  statics, beside fire.rs and fog.rs. A light map's block (a header of u32
  words, the static bytes, a mirror of the texels and each animated light's
  cached spatial bytes) comes from a per-world pool of 1 MiB chunks of
  `kernel.light.alloc`. The fire allocator now also frees: `world.dispose`
  returns the pool and the next world reuses its chunks. `refill` (a script
  brightness change) re-registers the light map after its JavaScript merge,
  reusing the block when the new layout fits.
- **Admission.** Every rectangle must lie inside the map and every spatial
  array must hold its rectangle; otherwise the light map keeps merging in
  JavaScript. All 2,713 animated light maps of the seven validated maps are
  admitted.
- **What stays in JavaScript.**
  - The GlobalLighting constants, through the reference's own
    `animatedLightConstants` and per-frame cache, called for every light of
    each merged map in list order, so Strobe's shared flag flips on the same
    frames. Their colour `tables` are now built at first use; the kernel
    path never asks for them unless it must copy them (below).
  - The memo. The reference compares a string of each light's three colour
    steps and its noise input (`A<frameIndex>`, `W<noise version>` or
    nothing). For numbers `String(a) === String(b)` exactly when `a === b`
    or both are NaN, and a light's input kind is fixed by its effect, so the
    kernel path runs the same test on numbers kept in a Float64Array.
  - The choice of light maps, and the float samples (`lighting.mjs`).
- **What moved.**
  - The colour tables: `Math.min(127, (byte·step) >> 16)` through a
    Uint8Array, built in light.rs when the three steps are int32 integers
    (the double product is then exact and ToInt32 keeps its low 32 bits).
    Other steps (NaN, beyond int32) copy the reference's tables. One slot
    per light actor, rewritten when its constants object changes.
  - The modulation tables, rebuilt by the reference's rule (a new frame
    object, frameIndex for effects 1–2, noise version for effect 3) from the
    frame's factors at that first use: `fistp(f(factor·byte) − 0.5) & 255`.
    Below 2^52 the nearest-even sum with ±2^52 lands on the integer grid, so
    it equals `fistp`'s ties-to-even exactly; larger magnitudes, infinities
    and NaN take the transcribed `fistp` and ToInt32's low byte.
  - The union reset from the static bytes, the merge in light order (the
    modulation index counts every rectangle texel from 0) and the
    comparison with the saved union. When a byte changed, the union's row
    span is copied back to the record's JavaScript texels (the block mirrors
    them, so the columns outside the union are equal); otherwise nothing is
    copied, as nothing changed.
- **Validation.** `validate-light-animation-rust.mjs` builds the light maps
  of 00_Training, 02_NYC_BatteryPark, 11_Paris_Everett,
  06_HongKong_WanChai_Underworld (Pulse, Flicker, Strobe),
  06_HongKong_MJ12lab (Pulse, SubtlePulse), 03_NYC_MolePeople (FireWaver)
  and 15_Area51_Page (TorchWaver, FireWaver, WateryShimmer) headless, as
  `world.mjs` does. Each animated light map has a JavaScript mirror merged
  by `animateLightMap` on a second frame with an identical appFrand stream.
  Over 600 frames per map (steps, repeats, jumps; some frames skip a subset
  of maps), with four script brightness changes per map, every returned
  region (or null) and every texel byte match. The kernel's colour and
  modulation tables also match the reference's whenever they hold the
  current frame's inputs. Synthetic maps cover what the game data does not:
  static bytes above 127, every LightType and effect, Blink, huge, negative
  and NaN steps, factors at ties, 0, negative, huge, infinite and NaN,
  merges without a memo, re-registration and a recreated kernel. Each of
  seven injected bugs failed it: ties rounded up, the rounding's negative
  branch dropped, a wrong low byte between 2^52 and 2^62, a 7-bit
  modulation index, no reset from the static bytes, negative colour entries
  clamped to 0, and the memo ignoring the noise input.
- **Cost.** Headless (`--bench 600`, Node, M2 Pro, interleaved blocks of 50
  frames, medians in ms per frame), the merge alone and `lighting.animate`
  (with the float samples of changed regions, still JavaScript):

  | Map | merge JS | merge Rust | animate JS | animate Rust |
  |---|---:|---:|---:|---:|
  | 00_Training | 2.34 | 0.67 | 2.67 | 0.95 |
  | 02_NYC_BatteryPark | 1.55 | 0.40 | 1.71 | 0.54 |
  | 11_Paris_Everett | 0.77 | 0.20 | 0.84 | 0.27 |

  On Training the kernel path's remaining time is light.rs's merge
  (~0.4 ms for ~200,000 spatial texels a frame), the WateryShimmer table
  (~0.1 ms when the noise steps) and ~0.1 ms of JavaScript (constants,
  memo, copy-back). Browser frames were not measured here.

## Not yet moved

Still to do: the time-varying spatial functions (Searchlight, SlowWave,
FastWave, CloudCast, Shock, Disco, Interference, Rotor), the texture
palette LightTypes and volumetric (fog map) lighting.

Two facts recovered from SetupForSurf's listing matter for that wiring:
- A level surface's static list goes through AddLight with each light's
  shadow mask; the mask pointer advances for every list entry, including
  rejected lights. There is no bSpecialLit test there. On Training, Island,
  Battery Park and NYC Street no listed light mismatches its surface.
- A class 2 light from a static list is merged unshadowed every frame, even
  though it has a mask. None of those four maps has one.
