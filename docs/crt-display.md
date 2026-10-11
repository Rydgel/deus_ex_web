# Optional CRT display

This is a user-requested presentation feature, outside the original-game
compatibility roadmap. It is not a reconstruction or measurement of a
particular physical monitor. CRT starts disabled. The browser remembers
both the enable switch and the selected shader.

The toolbar's **Display** menu offers CRT-Aperture, CRT-EasyMode, CRT-Lottes, SatPixie and
CRT-Royale. **Alt+C** (Option+C on Mac) toggles CRT; **Alt+Shift+C** cycles
shaders and enables the selection. Both work in Play and Inspect, including
with the page bars hidden. The shortcut consumes repeats and its eventual
key release, even if Alt is released first: C must not reach the original
TurnRight binding. Editable fields retain their normal keyboard behavior.
The menu groups screen shape, the CRT switch, shader and comparison. It
stays open while adjusting the shader; Compare closes it and focuses the
game. Escape closes the host menu and restores its button's focus without
reaching the game's Escape binding. A small gold dot on Display indicates
that CRT is enabled. Folder selection, Player start, previews and diagnostics
are in **Tools**, keeping the desktop toolbar on one row.
Royale loads on demand;
newer selections and on/off changes take precedence over an earlier load.

**Compare** shows original on the left and the selected CRT on the right.
It renders the effect over the full image, then redraws the original gamma
pass on the left using the **same pre-effect framebuffer copy**. Both halves
have identical scene, camera, game time and HUD coordinates; comparison
does not tick or draw the game twice. The temporary split is not saved.
All five presets have flat geometry, with no overscan crop.

## Boundary and original-game evidence

The original display contract is already recovered in
[lighting.md, Display ramp](lighting.md#display-ramp): D3DDrv applies
`pow(channel / 255, 1 / (2.5 * Brightness))` to the completed framebuffer,
after world, weapon, and HUD composition. The optional effect belongs at
that boundary. It does not change simulation, scene lighting, game
resolution, HUD coordinates, native settings or input bindings. Disabling
it selects the existing display-ramp shader unchanged. The `?gamma=material`
diagnostic path already has ramped pixels and uses an identity input ramp.

The shared preparation pass reduces the copied image by the integer factor
`clamp(floor(height / 400), 1, 4)`, averaging in linear light after the game's
gamma ramp (2.4 decode/encode). Each shader reconstructs the result at the
full drawing-buffer size. For example, a 1440×960 framebuffer provides a
720×480 input raster. Below 800 pixels high the factor is 1. This is a host
display choice, not SetRes; fixed game resolutions are still scaled by the
browser, including their phosphor masks.

## Upstream behavior and adapter choices

The upstream texts are vendored unchanged inside JavaScript string wrappers.
[Provenance, licenses and port details](../src/viewer/shaders/README.md),
original presets and SHA-256 checksums accompany them. These are existing
shader implementations, not original Deus Ex behavior. A byte-exact
comparison against RetroArch has not been established.

| Preset | Source and pipeline | Host settings |
| --- | --- | --- |
| Aperture | EasyMode's CRT-Aperture: beam reconstruction, Lanczos filtering, Gaussian glow, halation, diffusion and aperture mask | Softened mask and beam; brightness compensation |
| EasyMode | EasyMode's CRT-EasyMode: sharp reconstruction, beam and staggerable mask | Light mask, broad beam, modest brightness boost |
| Lottes | Timothy Lottes' CRT-Lottes: scanline reconstruction, phosphor mask and bloom | Flat geometry; softened mask and scanline settings |
| SatPixie | Conkwer's four-pass preset: accumulation, horizontal blur, vertical blur, final CRT image | Natural Vision defaults; full-image vignette; overscan disabled |
| Royale | TroggleMonkey's full twelve-pass CRT-Royale preset, with six original phosphor-mask textures | Upstream GUI beam/mask/bloom settings; progressive input; flat geometry and effectively zero border |

Aperture, EasyMode and Lottes come from
[libretro/glsl-shaders](https://github.com/libretro/glsl-shaders/tree/435612fe4f1023117b3aae48c88603fb413404a3/crt).
Their exact parameter values are explicit in `CRT_PRESETS`. Aperture uses
beam width 1.5 and brightness 1.5 at 1:1 to avoid dimming the whole image
with unresolved scanlines; at larger scale factors its beam is 1.1–1.5
with brightness 1.9. The other presets retain their own response curves.

[SatPixie](https://github.com/Conkwer/satpixie-crt-shader/tree/8c08dd137b77a0e00e27f1a57b8a4d4bd6ac8889)
uses the previous frame's horizontal-blur result as `PassFeedback1`, not the
previous accumulation output. Its first pass is twice the prepared source
size, as specified by the upstream preset. The three intermediate passes
use linear filtering. History is cleared when disabled, switched away from,
or resized. The original natural-vision, chromatic aberration, vignette,
noise and rolling-scanline calculations remain. Only the Vulkan binding
syntax and two GLSL ES expression restrictions are adapted.

[Royale](https://github.com/libretro/glsl-shaders/blob/435612fe4f1023117b3aae48c88603fb413404a3/crt/crt-royale.glslp)
keeps the twelve-pass order: linearize; vertical scanlines; bloom estimate;
vertical/horizontal halation blur; vertical/horizontal mask resize;
horizontal scanlines and mask; brightpass; vertical/horizontal bloom and
reconstitution; final geometry/AA. Intermediate buffers match the preset:
sRGB8 for light, linear RGBA8 for the mask. Hardware encoding/decoding
preserves linear-light sampling. Pass sizes, filtering and numbered prior
pass bindings follow the vendored GLSL preset. The mask textures and large
shader module load locally only when selected. Geometry is flat; progressive
input disables interlace detection; border size is `1e-7` rather than 0 to
avoid upstream's division by zero. WebGL adaptations are documented beside
the shader sources. Runtime uniforms follow the upstream GUI defaults, including zero RGB
convergence offsets (the embedded static example settings differ here).

Each pipeline allocates resources on first use and reuses them. Disabled
CRT adds no extra copy, target render, or shader draw over the original
ramp. Compare adds one scissored original-ramp draw and restores scissor
state afterwards. SatPixie's persistence is modeled by its upstream frame
history; a calibrated physical phosphor pitch is not modeled.

## Verification (2026-10-11)

- `npm run build` passed. The bundle-size warning remains; Royale is a
  separate lazy chunk (about 505 kB gzip plus its mask images).
- `node --test test/script-native-config.test.mjs`: 7 passed, including the
  original float32 display-ramp exponent.
- `npx playwright test browser-tests/crt.spec.mjs`: 3 passed. The focused
  pipeline test was rerun after adding the history-reset assertion.
  Fixtures check the disabled gamma against its mathematical reference,
  byte-identical off output after every shader, an exact original comparison
  half at odd sizes and DPR 1/2, image orientation, restored scissor state,
  all raster scales, neutral gray and finite zero-brightness output.
  The SatPixie fixture verifies that prior bright frames persist and that
  resetting history returns to the exact fresh output.
- Play/Inspect coverage checks the button and shortcut, repeat suppression,
  Alt released before C, no TurnRight input, editable-field exclusion,
  hidden page bars, all five selections, cycling, comparison labels,
  remembered shader/enable state and a narrow viewport.
- Viewed live Training and menu captures. All five pipelines compile and
  render without WebGL or runtime errors in Chromium, including software
  WebGL and ANGLE Metal. Local captures are under `.cache/crt/` and
  `reports/browser/`, outside Git. The capture comparison shows distinct
  shader responses; it does not establish physical CRT fidelity.
- Verified all vendored shader-body and phosphor-mask checksums against the
  pinned upstream snapshots in `src/viewer/shaders/upstream.json`.

## Performance sample (2026-10-11)

Live Training at 1440×960, DPR 1, page bars hidden, Apple M2 Pro,
Chromium/ANGLE Metal. Four interleaved runs per setting, each with 40 warm-up
frames and 150 measured frames, no CPU profiler or concurrent browser tests.
Order: off/aperture/satpixie/royale/lottes/easymode, then
off/easymode/lottes/royale/satpixie/aperture, repeated once.
Values are medians of the four run means.

| Preset | Host frame work | Display phase, host | Whole-frame GPU |
| --- | ---: | ---: | ---: |
| Off | 1.358 ms | 0.017 ms | 4.656 ms |
| Aperture | 1.357 ms | 0.033 ms | 5.606 ms |
| EasyMode | 1.288 ms | 0.027 ms | 5.334 ms |
| Lottes | 1.355 ms | 0.030 ms | 9.040 ms |
| SatPixie | 1.394 ms | 0.046 ms | 5.855 ms |
| Royale | 1.509 ms | 0.171 ms | 7.037 ms |

All settings had a 16.7 ms median browser frame interval on this 60 Hz run.
There were no disjoint GPU samples, paused runs or runtime errors. These
are measured costs for this scene, not proof of sustained 120 fps. GPU
results vary across runs; the smaller host differences should not be read
as speedups. Lottes is the most expensive GPU option in this sample.
Raw samples and the local measurement script are `.cache/crt/profile-all.json`
and `.cache/crt/profile-all.mjs`, outside Git.
