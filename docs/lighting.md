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
special-lit flags. `polys.mjs` connects static mover surfaces to their original
brush polygons. The native mover assigns each polygon its ordinal; its compiled
BSP surfaces can have lightmap indices of -1 despite valid polygon lightmaps.
We validate the correspondence using texture, base, normal, axes and pan.

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

Lightmaps use floating-point reconstruction and padded GPU atlases. The original's
fixed-point intermediate rounding, lookup-table discretization and filtering are
not reproduced bit for bit. Remaining small differences are recorded rather than
hidden by an exposure adjustment. Gamma is currently applied per material;
matching gamma after transparency/reflection compositing belongs with Stage 4.

Switchable lights use stored initial illumination; script-driven changes require
Stage 3. Time-varying light effects, moving-actor lighting, reflected geometry,
animated water, meshes, fog and other presentation effects require Stage 4.
The polished training floor currently shows its lit base texture without its mirror
reflection. Diagnostics explicitly report these limits. Other maps remain outside
visual acceptance, even when they decode successfully.

## Research references

SurrealEngine revision `7bc5a89cbc22254f89d18b040b94ef0c37d44cf2` was used to
investigate serialized layouts and lightmap conventions, including
[UPolys](https://github.com/dpjudas/SurrealEngine/blob/7bc5a89cbc22254f89d18b040b94ef0c37d44cf2/SurrealEngine/Packages/Engine/Resources/Level/UPolys.cpp)
and [VisibleBrush](https://github.com/dpjudas/SurrealEngine/blob/7bc5a89cbc22254f89d18b040b94ef0c37d44cf2/SurrealEngine/Render/VisibleBrush.cpp).
The native findings above and original-game captures supersede reference behavior
where they disagree. Research downloads, binaries and screenshots stay outside Git.
