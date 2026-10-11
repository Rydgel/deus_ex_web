# Vendored CRT shaders

The `.mjs` files wrap **unmodified upstream shader text** in JavaScript
strings. WebGL compatibility changes live in the adapters one directory up.
No third-party shader code is fetched from an external service at runtime.

| Shader | Author / upstream | License |
| --- | --- | --- |
| CRT-Aperture | EasyMode, libretro/glsl-shaders | GPL (version unspecified in the source notice) |
| CRT-EasyMode | EasyMode, libretro/glsl-shaders | GPL (version unspecified in the source notice) |
| CRT-Lottes | Timothy Lottes, libretro/glsl-shaders | Public domain, per source header |
| SatPixie | Conkwer/satpixie-crt-shader, based on NewPixie and Mattias Gustavsson | MIT or Unlicense, per upstream LICENSE |
| CRT-Royale | TroggleMonkey, libretro/glsl-shaders | GPL-2.0-or-later |

GPL text is included in `COPYING` and `royale/LICENSE.TXT`; SatPixie's
license is in `satpixie/LICENSE`. Keep the source copyright notices.

## Revisions and integrity

- [libretro/glsl-shaders](https://github.com/libretro/glsl-shaders/tree/435612fe4f1023117b3aae48c88603fb413404a3),
  revision `435612fe4f1023117b3aae48c88603fb413404a3`.
  Single-pass sources are `crt/shaders/crt-{aperture,easymode,lottes}.glsl`.
  Royale is the normal **12-pass** `crt/crt-royale.glslp` preset, its
  `crt/shaders/crt-royale/src/` shaders and mask PNGs, plus the two
  `blurs/shaders/royale/blur9fast-{vertical,horizontal}.glsl` passes.
- [Conkwer/satpixie-crt-shader](https://github.com/Conkwer/satpixie-crt-shader/tree/8c08dd137b77a0e00e27f1a57b8a4d4bd6ac8889),
  revision `8c08dd137b77a0e00e27f1a57b8a4d4bd6ac8889`.
  All four passes and the original `.slangp` preset are included.
- `upstream.json` records SHA-256 checksums of every shader body and Royale
  mask. Hash the imported string, not its JavaScript wrapper. Original
  presets remain in the corresponding folders for auditing pass order,
  scaling, filtering, aliases and frame history.

## Host adapters

`crt-shader.mjs` prepares the same gamma-ramped image for every preset.
Aperture, EasyMode and Lottes use a fullscreen vertex shader, RetroArch
size uniforms and upstream parameter uniforms. Their aesthetic settings
are explicit in `CRT_PRESETS`; Lottes curvature is zero.

`crt-satpixie.mjs` translates Vulkan stage/layout and push-constant syntax
into WebGL2 uniforms, changes one integer `mod` to an explicit float cast,
and evaluates a uniform-dependent global blur expression as a macro.
It implements all four passes, including the prior frame's horizontal
blur as `PassFeedback1`. Switching away, disabling or resizing clears that
history. The natural-vision defaults remain, with overscan disabled and
vignette aspect set to the full image to preserve the HUD and coordinates.

`crt-royale.mjs` runs all twelve upstream vertex/fragment passes and loads
the six supplied mask textures on demand. It matches the preset's sRGB
framebuffers and linear mask buffers, sizes and input filters. Numbered
`PassPrevN` uniforms bind prior pass outputs, including the GLSL export's
macro-renamed declarations. WebGL adaptations preserve global constants,
remove runtime local `const` qualifiers (including loop macros), add
explicit int-to-float conversions, and move the uniform-dependent global
bloom scale into a macro. High-precision ES uniforms/varyings preserve
the desktop shaders' range. Frames are progressive, geometry mode is flat,
overscan is 1, and border size is the upstream UI minimum `1e-7` to avoid
its divide-by-zero at 0. Other parameters follow the upstream GUI
settings. This is a WebGL port of the actual pipeline; byte-exact output
against RetroArch has not been established.
