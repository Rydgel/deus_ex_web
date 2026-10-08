# Stage 1.5 lighting evidence

Training's static lighting is reconstructed in our JavaScript runtime. The original
game is the reference: two matching camera views were captured from Deus Ex running
through CrossOver on 2026-09-09. No external engine runs inside the browser.

## Data and native behavior

`classes.mjs` reads version 68–69 class headers, traverses serialized bytecode to
locate defaults, resolves inheritance, then applies actor overrides. This traversal
does not execute script instructions. Resource references retain their original
package ownership and are not merged into map indices.

`lighting.mjs` combines the original surface light lists, row-aligned LSB-first
shadow masks, lightmap pans/scales, light positions/radii, colour, zone ambient and
special-lit flags. Movers are drawn from their brush polygons, as Engine's
brush tracker draws them (2026-10-02). AMover::PostLoad (`0x103af7e0`)
numbers the polygons (`iLink = i`). Building the level's tracker
(`0x1037ac40`) then calls `0x1037b5c0` for every non-static brush. That
call appends one level surface per polygon, copying the polygon's texture,
pan, base, normal and texture vectors and `PolyFlags & 0x3cffffff` (plus
PF_SpecialLit for a bSpecialLit mover). It sets the surface's **iLightMap
to the polygon's iBrushPoly**, an index into the brush model's light maps
(−1 on invisible polygons), and points `iLink` at the new surface.
Tracker::Update (`0x1037a400`) transforms the polygons into those surfaces
each move; SetupForSurf takes a dynamic surface's light maps from its
actor's brush model. The brush model's own compiled surfaces (all
iLightMap and iBrushPoly −1) are not drawn.

`moverModelFromPolys` (`polys.mjs`) builds that surface set. The earlier
reconstruction matched compiled surfaces to polygons by texture, base,
normal, axes and pan, and took the polygon ordinal as the light map. It
refused 74 of 159 movers on UNATCO HQ, Battery Park, the Ship and Training,
because coplanar polygons are ambiguous. Where invisible polygons come
first, the ordinal is the wrong light map. The polygon path draws every
mover on the maps checked. A light list may also name a light deleted in
the editor but still exported, such as the Ship's Light388 (bDeleteMe,
lighting DeusExMover39): the reference loads it and AddLight does not test
bDeleteMe, so `createLighting` reads such an export directly.

The following findings came from disassembling the supplied binaries; addresses
are RVAs, relative to each DLL's image base:

| Original code | Finding used here |
| --- | --- |
| Engine.dll `FGetHSV`, `0xec8d0` | Three hue sectors, inverse saturation; ambient brightness uses `b=1.4*brightness/255`, then `0.7*b/(0.01+sqrt(b))`, clamped to one. The last blue sector divides by 84, as in the binary. |
| Render.dll `GlobalLighting`, `0x5e90`; light setup `0x60b1` | Actor light colour calls FGetHSV at brightness 255, then multiplies by `LightBrightness/255` and LevelInfo.Brightness. It does not use a square-root response to each actor's brightness. |
| Render.dll initialization `0x2112`, `0x2300`; normal effect `0x3360` | Shadow blur uses weights `[24,40,24;40,64,40;24,40,24]`, total 320. The distance table and plane-distance factor combine to incidence times `1+2*d³-3*d²`. |
| Render.dll ambient setup `0x7fcc` | Zone FGetHSV contribution is scaled by 0.25. |
| Render.dll light-colour table `0x64ff` | Individual channels are limited to 127 in the legacy lightmap representation. |
| Engine.dll AMover.PostLoad `0xaf7e0` | Assigns polygon ordinals used for mover lighting. |
| D3DDrv.dll gamma ramp `0x2e3e` | Display exponent is `1/(2.5*Brightness)`, separately from scene lights. |

The initial public-reference formulas overlit the entrance. Checking the native
code corrected the colour response, attenuation and shadow-kernel normalization.
This is a concrete example of extending our implementation beyond another engine's
current behavior.

Native input hashes (SHA-256):

```text
00_Training.dx bb66d95aafc6aae4179f8444e98661f3d5d27dab06d13d7dde7f4b5f4e24068d
Engine.dll     0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4
Render.dll     607f1077c5cd3e25f8a4cde1ffacf4cf9260aebc92a72be40721cd6955bd75d1
D3DDrv.dll     9e0f8a4293de6edb4f88b1ba9972fe98b4e80a1115f9667e57f8ef3d51d8ac9f
```

## Camera and image comparisons

Both views use position `[-1149.2435302734375, 825.8439331054688,
-40.19999694824219]`, horizontal FOV 75°, and a 926×603 viewport. Position was read
from the saved JCDentonMale1.Location plus EyeHeight, not inferred from PlayerStart.
The original pawn settles below the map's spawn marker.

| View | Original ViewRotation (pitch, yaw, roll) |
| --- | --- |
| Entrance facing doorway | `[65524,31,0]` |
| Entrance facing side pillars | `[65501,2496,0]` |

The browser regression uses those same coordinates. Comparison confirms the dark
pillar faces and beam bands, cyan ceiling illumination, warm doorway wall and dark
doors. Six fixed entrance regions (ceiling, beam, pillar, door, warm wall, cyan
strip) have a maximum difference of **2.782 mean RGB levels per channel**, on the
0–255 scale. This is a regional comparison, not a whole-image pixel-equivalence claim.
HUD, actor meshes and the mirror floor were excluded; the second view was also
inspected visually.

Local evidence is under ignored `reports/lighting/{start,side}/`: original save
state, camera JSON, native window/frame capture, game screenshot, and browser
captures with lighting, without lighting and with display correction.
`reports/lighting/comparison.json` records the sampled rectangles and measurements.
Original Shot bitmaps at this window width use tightly packed BGR rows, despite
the BMP format normally requiring row padding. Their decoding must account for
that; native window screenshots provide an independent capture.

The native window matched the browser's uncorrected framebuffer closely. This
does **not** establish correct legacy hardware gamma under CrossOver or modern
Windows. Browser brightness 0.40 gives the identity curve for comparisons; the
default 0.60 reproduces the original D3D gamma exponent of 2/3. Brightness can be
adjusted without changing authored light intensities.

## Display ramp

D3DDrv applies the Brightness setting as a gamma ramp on the primary
surface (`0x2e3e`; UT432's Direct3D7.cpp has the same loop:
`appRound(appPow(x/255, 1/(2.5·Brightness))·65535)` per entry, then
`SetGammaRamp`). The ramp maps the finished 8-bit framebuffer at scanout,
so every pass, blended ones and the HUD included, is composed before it.

Play does the same since 2026-10-03 (`src/viewer/display-ramp.mjs`; the original Display > Adjust Brightness screen drives it since 2026-10-08, see [native config](script-native-config.md#display)). Shaders
draw raw colours into the canvas, and after the HUD one pass copies the
drawing buffer to a texture and draws it back through `pow(x, g)`, one
fragment per pixel. The UI clear colour is drawn raw as `c^(1/g)`, so it
looks unchanged.
- **Why.** The ramp used to be applied per fragment, before blending
  (`displayRampGlsl`). That is exact for opaque output and for PF_Modulated
  (see mesh lighting), but not for additive passes: over a dark wall, faint
  volumetric fog of 2/255 showed as about 10/255. On 10_Paris_Club, matched
  shots against the original under Wine (D3D, VolumetricLighting on, fog
  toggled with `set D3DRenderDevice VolumetricLighting False`) put Play's fog
  at 2.3–3.6× the original's contribution (in linear units). With the
  frame ramp it is 1.3–1.7×, the same ratio as the raw framebuffers.
  Translucent surfaces, sprites, coronas and the HUD now compose the same
  way. The HUD was not ramped at all before; the original's is.
- **Switch.** `?gamma=material` keeps the per-fragment ramp (no ramp pass).
- **Host choice.** The ramp's 16-bit entries reach an 8-bit canvas as
  `round(255·pow(x/255, g))`; how a display reduced them is not modelled.
- **Not explained yet.** On 10_Paris_Club, Play's unfogged walls are also
  1.25–1.5× brighter than the original's raw framebuffer under Wine, and the
  fog's remaining 1.3–1.7× may share that cause. Training's start shows the
  same direction (lit floor 1.25–1.3×). It is not the ramp, not light
  animation (the club's 95 lights are steady) and not the missing detail
  textures (D3D draws them only within 380 units). The September Mac
  comparison under CrossOver matched more closely, so the Wine D3D path is a
  suspect. The user reports a known gamma bug of Deus Ex on Windows, so the
  Wine reference may carry it (unverified). Both sides of this comparison
  are before the ramp (the Shot bitmap and Play at the identity ramp), so a
  ramp that never reaches the screen would not by itself explain the gap.

## Validation and limits

Training prepares 5,212 lightmap tiles (including mover faces and separate zones),
16,088 shadow masks, 149 contributing light actors including light-emitting props,
and six 1024×1024 atlas pages. There are zero missing lightmaps or render errors.
Geometry remains 24,427 triangles, 70 textures and 25 static movers.

The 34 unit tests cover class/default boundaries, bytecode traversal, original
colour/falloff rules, shadow packing, lightmap basis inversion, mover correspondence
and atlas isolation, alongside earlier format tests. Browser checks exercise both
reference cameras, lighting/brightness toggles, unchanged pixels on an authored
unlit surface, and shader errors, alongside the existing viewer checks.

Static light maps now go through the original Render.dll integer path
([static lighting](static-lighting.md), 2026-10-02): shadow blur table,
ambient fill, spatial bodies and colour merge match the original byte for
byte on every Training light map. The paragraph below describes the earlier
float reconstruction, which this replaced.

Lightmaps used floating-point reconstruction and padded GPU atlases. The original's
fixed-point intermediate rounding, lookup-table discretization and filtering were
not reproduced bit for bit. Remaining small differences are recorded rather than
hidden by an exposure adjustment. The display ramp is described below.

Moving lights (AugLight's Beams, cameras and other non-static light actors) now
add their unshadowed texels per frame; see [moving lights](dynamic-lighting.md).
The same native evidence corrected NonIncidence to `1.02 − d` with its
`FISTP(d²·4093) < 4096` cutoff for static lights as well.

Switchable lights use stored initial illumination; script-driven changes require
Stage 3. Time-varying light effects, moving-actor lighting,
animated water, meshes, fog and other presentation effects require Stage 4.
The polished Training floor now reflects world geometry and actors using the
recovered native mirror path; see [mirror surfaces](mirror-surfaces.md).
Diagnostics explicitly report the remaining limits. Other maps remain outside
visual acceptance, even when they decode successfully.

## Ordered world submission boundary

The source lightmap texels, conversion, padded page placement, clamped sample
coordinates, base-texture mip/filter state and display-colour multiplication
remain the contracts above and in [moving lights](dynamic-lighting.md).
Submitting several original opaque meshes together is a browser representation
change; it must not change their order. Equal depth is observable, including
different surfaces that quantize to the same depth, so opaque meshes cannot be
freely regrouped by texture or lightmap page.

Three.js r186 `WebGLRenderLists.painterSortStable` orders opaque objects by
group order, render order, material ID, material variant, camera depth and object
ID. World static meshes use group/render order zero and ordinary Mesh variant
zero. Only consecutive static meshes with materials used nowhere else in the
world can merge; a mover, shared material or mirror is a barrier. A merged run
retains the first material ID and concatenates the exact old triangle sequence.
Other actor materials are created after the world. Thus neither shader program
creation nor changing a run's bounds can move it across another submission.
Transparent, modulated and mirror submissions keep their existing boundaries.

Within a run, at most eight original base textures remain separate samplers,
with a constant per-triangle selector. The original implicit texture lookup runs
for every sampler before selection, keeping derivatives in uniform control
flow. Explicit `textureGrad` was rejected: its mip choice differed at masked
edges on Metal. Sampling only the selected texture inside the branch matched
there, but GLSL ES 3.00 does not guarantee implicit derivatives in nonuniform
control flow ([sections 3.10.2 and 8.8](https://registry.khronos.org/OpenGL/specs/es/3.0/GLSL_ES_Specification_3.00.pdf)).
Identical fixed state (side and alpha test included) is required.
Lightmap pages become equally sized texture-array layers, retaining every byte,
UV, clamp bound and filter; moving-light rectangles update the same layer and
coordinates. Per-face material metadata preserves surface inspection.

The layer and texture selector share the existing `lightUV.z`: with stride
`pageCount + 1`, the integer is `selector * stride + (lit ? layer + 1 : 0)`.
The fragment shader rounds to a high-precision integer, then uses integer
division and remainder; floating division near multiples of the stride can
round across an integer boundary. Zero in the layer field still means unlit.
The maximum is 2,055 with eight textures and 256 pages; worlds above the
WebGL2 minimum of 256 array layers retain the old submissions. Position, base
UV, light UV xy and bounds remain unchanged, and the vertex shader retains its
original varying layout. This matters numerically: on Island's turned start
view, introducing either one flat layer varying or one flat selector varying
changed 258 lit channels by at most two, even without merging geometry. The
same array sampler with a uniform layer matched exactly, as did sealed CPU
storage with the original shader. Packing both indices in the existing varying
removed every difference, including raw unlit output. The evidence isolates
the drift to the extra vertex varying layout rather than atlas filtering,
texture selection, triangle order or light multiplication.

This optimization does not implement original BSP/portal visibility, reorder
the existing opaque stream, or establish whole-renderer pixel identity with the
original rasterizer. Translation and GPU equivalence checks for this boundary
are recorded alongside the implementation.

`node scripts/validate-world-batches.mjs` hashes every ordered triangle's
position, normal, base UV, decoded light UV/bounds/layer, fixed material state and
inspection identity from the original maps with batching on and off. Training's
24,427 triangles match; its opaque world/mover submissions fall from 269 to 104.
Island's 33,147 triangles match; its submissions fall from 422 to 85. Training
retains zero renderer errors, and Island retains the same six existing errors.
These are complete geometry-stream checks, not camera-dependent pixel samples.

`node scripts/validate-world-batch-gpu.mjs` starts an isolated local Vite server
and Chromium, using generated textures without original assets. Its coplanar
overlaps, masked cutoffs, nearest/linear mip filters, repeated UVs, atlas edge
clamps, clipping, a large-coordinate oblique camera, full/partial light updates
and forced context restore compare
the original individual submissions with the batched shader. On Chromium/Metal
all 3,538,944 RGBA channels matched in nine 384×256 frames; submissions fell from
32 to five. The focused `test/world-batches.test.mjs` also checks order barriers,
the eight-sampler limit, inspection metadata and update rectangles.
The additional GPU frames exercise strides 41 and 257 with all eight sampler
choices visibly separated, an unlit code exactly equal to the stride, and code
2,055 selecting the distinct last layer of a 256-layer atlas.

The final packed shader also matched all 17,868,096 channels in eight native-map
926×603 frames on Chromium/Metal. Training used location
`(-1149.24353, 825.84393, -40.199997)` with rotations `(65524,31,0)` and
`(65501,2496,0)`, including four reflected mirror planes; draw counts fell
1,348→576 and 1,143→511. Island used its start plus 40 eye-height units at
`(-4760.569824,10430.811523,-240.674988)`, then yaw +16,384. Start and turned
view fell 367→92 and 23→18 draws. The turned view additionally matched with sky
disabled, lighting disabled, display gamma one, and both lighting disabled and
gamma one. These are comparisons against the pre-batch browser representation;
they do not expand original-game visual acceptance beyond the evidence above.

This exchanges CPU submissions for extra GPU texture fetches, which must be
judged by live frame measurements. CPU atlas bytes are shared, but any layers
also used by unbatched surfaces retain separate GPU page textures. Full light
updates upload the whole array; moving-light rectangles keep their sub-image
path. Selective full-layer uploads are deliberately avoided because WebGL
context restoration can allocate fresh storage while host upload flags remain
set, leaving untouched layers empty if only queued layers were uploaded.

## Research references

SurrealEngine revision `7bc5a89cbc22254f89d18b040b94ef0c37d44cf2` was used to
investigate serialized layouts and lightmap conventions, including
[UPolys](https://github.com/dpjudas/SurrealEngine/blob/7bc5a89cbc22254f89d18b040b94ef0c37d44cf2/SurrealEngine/Packages/Engine/Resources/Level/UPolys.cpp)
and [VisibleBrush](https://github.com/dpjudas/SurrealEngine/blob/7bc5a89cbc22254f89d18b040b94ef0c37d44cf2/SurrealEngine/Render/VisibleBrush.cpp).
The native findings above and original-game captures supersede reference behavior
where they disagree. Research downloads, binaries and screenshots stay outside Git.
