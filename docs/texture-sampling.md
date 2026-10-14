# Texture sampling state

How the original's Direct3D device samples a base texture, and how Play's world surfaces, actor
skins and decals do it. Found by matching the security cameras' views against the original's own
frames ([security cameras](visual-acceptance.md#security-cameras-2026-10-14)): a camera window is
200 x 150 pixels, so its textures are minified far more than the 1280 x 720 main view's, and the mip
choice shows.

## The device state (D3DDrv.dll)

`UD3DRenderDevice`'s stage setup, `0x10009e20` (thiscall, `ecx` the device; reached through the jump
thunk `0x10001087`), runs `IDirect3DDevice7::SetTextureStageState` (vtable `+0x94`) for the stages it
uses: stage 0 the base texture, stage 1 the light map, stage 2 the third pass. The same states for each:

| State | Value | Where |
| --- | --- | --- |
| `D3DTSS_MIPMAPLODBIAS` (0x13) | -0.5 (`0xbf000000`) | `0x10009e3f` (stage 0 at `0x10009e62`), `0x10009fac` (stage 1 `0x10009fbe`, stage 2 `0x1000a0d7`) |
| `D3DTSS_ADDRESS` (0x0c) | `D3DTADDRESS_WRAP` (1) | `0x10009e77`, `0x10009fd3`, `0x1000a0ec` |
| `D3DTSS_MAGFILTER` (0x10) | `D3DTFG_LINEAR` (2) | `0x10009ef9`, `0x1000a064`, `0x1000a17c` |
| `D3DTSS_MINFILTER` (0x11) | `D3DTFN_LINEAR` (2) | `0x10009f0e`, `0x1000a079`, `0x1000a191` |
| `D3DTSS_MIPFILTER` (0x12) | `UseMipmapping ? (UseTrilinear ? LINEAR (3) : POINT (2)) : NONE (1)` | `0x10009f1a..0x10009f43` (stage 0), `0x1000a0ae`, `0x1000a1c6` |

`UseMipmapping` and `UseTrilinear` are the device's members `+0x9ac` and `+0x9b0`, registered as
config properties at `0x100018e9` and `0x10001942` (`UseMultitexture` is `+0x9b4`). The shipped
`DeusEx.ini` has `UseMipmapping=True` and `UseTrilinear=False`, so the **mip level is picked, not
blended**. The device's `LODBIAS` console command (`0x1000636e`, "Texture LodBias") changes the bias of
stages 0 and 1 at run time.

A polygon with `PF_NoSmooth` (0x800) switches stage 0's MAG and MIN filters to POINT before drawing:
`0x1000845f..0x10008490` computes `edi = (flags & 0x800 ? 1 : 2)` for both states.

In GL terms (what wined3d and a host both end up with) that is `LINEAR_MIPMAP_NEAREST` with a level of
detail bias of -0.5, and `NEAREST_MIPMAP_NEAREST` with `NEAREST` magnification for `PF_NoSmooth`. The
level drawn is GL's nearest rule, `d = ceil(lambda + 1/2) - 1`, `lambda = log2(texels per pixel) - 0.5`.

## What Play did before

World textures and actor skins were `LinearMipmapLinear` (trilinear) with no bias, which blends two
levels and reads one level coarser than the device's pick; decals had `LinearMipmapNearest`, and a
`-0.5` bias that never reached the shader (decal-scene.mjs replaced `texture2D( map, vMapUv )` in the
material's unresolved fragment shader, where three.js has only `#include <map_fragment>`).

## The port

`src/viewer/original-sampling.mjs`: `configureSampler(texture, noSmooth)` sets the filters; the world
(`world.mjs`), actor skins (`actor-mesh-textures.mjs`) and decals (`decal-scene.mjs`) use it. The
module also replaces three's `map_fragment` chunk once, so that every `MeshBasicMaterial` map lookup
carries `-0.5` (a texture without mip levels ignores a bias). The batched world shader
(`world-batches.mjs`) samples through its own `deusSample` and takes the same constant. A three.js whose
chunk no longer reads like the expected one throws instead of drawing unbiased. `?sampling=trilinear`
restores the previous sampling for A/B captures.

## Evidence

* **Device state.** The disassembly above (objdump of D3DDrv.dll, addresses given).
* **Pixel evidence.** The original's camera screen (14_OceanLab_Lab, ComputerSecurity1, three
  cameras, [method](visual-acceptance.md#security-cameras-2026-10-14)) against Play at the same level
  time, camera poses and player pose, canvas multisampling off; mean absolute difference of the three
  200 x 150 windows by the LOD bias of the batched world shader and the sampler's
  `LinearMipmapNearest` (the other columns keep the same everything else):

  | bias | window 1 | window 2 | window 3 |
  | ---: | ---: | ---: | ---: |
  | -1 | 0.21 | 0.88 | 0.37 |
  | -0.5 | 0.04 | 0.31 | 0.16 |
  | -0.25 | 0.07 | 0.60 | 0.31 |
  | 0 | 0.10 | 0.92 | 0.44 |

  The minimum is at -0.5, the device's value. The previous sampling (trilinear, no bias) with multisampling
  off: 0.11 / 0.86 / 0.46; the three windows of Battery Park (0.52 / 0.16 / 0.65 before, 0.15 / 0.08 / 0.19
  after) and Island's (0.45 before, 0.07 after, the moving actors masked) move the same way
  ([visual acceptance](visual-acceptance.md#result)). Over the stored main-frame views (4 maps, 20
  views) the mean absolute difference falls 2.098 to 1.913 and the edge recall rises .9726 to .9803.
* **Validator.** `node scripts/validate-texture-sampling.mjs` (headless Chromium, no game data): a 512 x 512
  texture whose mip level k is a solid colour is drawn on a pixel-aligned quad at 126 minifications a
  quarter level from the nearest-level ties (lambda 0.25 .. 6.75), through the plain `MeshBasicMaterial`
  (actor skins, decals), the world's light-atlas material and the batched world shader; each pixel must be
  a palette colour (no blended levels) and the level the device state selects. A 2 x 2 texture magnified on
  a 64-pixel quad must show texels with `PF_NoSmooth` and a blend without. It fails on the previous sampling.

## Filtering space (display space)

Direct3D 7 has no sRGB sampling: the device's 8-bit texels are blended as they are, in display space
(MAG, MIN and MIP filters, and the vertex diffuse that modulates them, all on the display-encoded
values). Play uploaded every base texture as sRGB, so the GPU decoded the texels before filtering and a
shader re-encoded the result (`sRGBTransferOETF`): the same for an unfiltered texel, but a blend of
black and white is 188 in linear light where the device has 127, and every blended texel at a sharp
texture edge, a sign's text or a minified bright strip is brighter than the original's. Found in the
security-camera windows ([visual acceptance](visual-acceptance.md#security-cameras-2026-10-14)): after
the mip state the residual was the colour of blended texels (Play's mid-tone pixels up to +5% in Hong
Kong's signs; a strip's edge pixel 168 against 133).

`configureSampler` uploads the textures as `NoColorSpace`; the light-atlas hook (world), the actor
mesh materials, decals, sprites and coronas no longer re-encode (`REENCODE_GLSL` is empty), the fire
and wet textures are `NoColorSpace`, and the sprite, corona and glow tints now multiply the display-space
texel (the device's vertex diffuse does) instead of a linear-light one. `?sampling=srgb` restores the
sRGB upload and the re-encode, `?sampling=trilinear` the earlier mip choice, `?sampling=legacy` both, for
A/B captures. Measurement (mean absolute difference per 200 x 150 window, canvas multisampling off,
same level time and poses): Hong Kong 0.37 / 0.66 / 0.14 with the mip state alone, 0.04 / 0.20 / 0.01
with the colour space as well; OceanLab 0.04 / 0.31 / 0.15 to 0.00 / 0.15 / 0.02 (99% of its pixels
identical); Battery Park 0.15 / 0.08 / 0.19 to 0.00 / 0.09 / 0.01; the windows' mean values
go from 1.01 to 1.000 of the original's. The overall brightness of the main views does not move:
[main views at Brightness 2/3](visual-acceptance.md#main-views-at-brightness-23).

The validator checks the filtering space as well: a 2 x 1 texture of 0 and 255, magnified, shows 124
next to the boundary through the plain material and the world's shader (183 if re-encoded).

## Multisampling

The same comparison found that Play's canvas is multisampled (`antialias: true` in `main.mjs`) and the
original's device is not: Direct3D 7 with no AA setting in `DeusEx.ini`. Edge and sub-4-pixel pixels
take partial coverage in Play (25% steps of a 4-sample canvas); the original's are whole. `?antialias=0`
creates the canvas without multisampling; the acceptance captures use it, the default is unchanged (a
presentation choice). Numbers: [visual acceptance](visual-acceptance.md#causes).

## Open

* The mip chains are the packages' own; the procedural Fire and Wet textures keep their own sampler.
* Sprites, HUD tiles and light maps are unmipped in Play (a bias does not apply); whether the original
  uploads mip levels for the textures `DrawTile` draws was not traced.
* GL's per-pixel level choice is hardware derivative arithmetic; Play and wined3d run on the same GPU
  here, a different GPU or driver may pick differently at the ties.
