# Volumetric fog (fog maps)

Stage 4, 2026-10-02. Volumetric lights fill fog zones with lit haze. The
single-player maps have 104 lights with `VolumeRadius > 0` and 67 `bFogZone`
zones, each in 29 maps. Play does not draw them yet. This note records the
original path as it is recovered. The fog-map computation is translated and
oracle-exact; the wiring into Play is still open.

Authority:
- Render.dll `607f1077…d75d1`;
- D3DDrv.dll `9e0f8a42…d8ac9f`;
- the Deus Ex SDK 1112f headers (Reference/, research only).

## The chain

1. **Leaves.** `URender::LeafVolumetricLighting` (`0x10b170e0`) runs for
   each visible leaf. It walks the model's per-leaf volumetric light list
   (`FLeaf.iVolumetric` into `Model.Lights`, our `model.leaves[].volumetric`)
   and the leaf's dynamic lights.
   - **Admission.** A light not yet stamped this frame is admitted when it is
     within `((VolumeRadius+1)·25)²` scaled by a constant of the eye and
     passes the frame's four side planes (`Frame+0x130`).
   - **Links.** It gets a frame-scoped FVolActorLink: the actor plus its
     camera-space location.
   - **Not yet traced.** The surface draw lists' `Volumetrics` (+0x40) come
     from these links; the exact attachment is still to trace.
2. **SetupForSurf** (`0x10b06c90`) returns a FogMap when the surface's zone
   has `+0x388 & 2` (bFogZone), its draw list has volumetric links (+0x40),
   and the draw flags (+0x10) lack bit 4 (`0x10b07162–0x10b0718f`).
   - **Size and buffer.** The FogMap is the static FTextureInfo at
     `0x10b3d2f8`. It has the light map's texel grid, power-of-two USize and
     VSize (`appCeilLogTwo`), and 7-bit BGRA data at `[0x10b38aa0]` with a
     row stride of USize.
   - **Light setup.** Each linked light gets its info `+0x30` set, and
     ComputeFromActor runs for it. The infos with `+0x30` are collected and
     sorted with `appQsort` (msvcrt `qsort`) using `0x10b06c60`: `a.z < b.z`
     returns 1, else −1, so farther lights come first.
3. **ComputeFromActor** (`0x10b05fa0`) sets the light's camera-space
   position at +0x08 (the inline TransformPointBy of Location by the frame
   coords). For a volumetric light (`0x10b06868–0x10b06c19`) it then sets:
   - **Colour.** The volume colour is the light colour (+0x6c, GlobalLighting's
     colour scaled by `Level.Brightness·brightness`). Its alpha is
     `VolumeFog·(1/255)` (+0x88).
   - **Colour table.** A 256-entry BGRA table (+0x90, GCache-held): per
     channel a 16.16 step `fistp(f(c·65536) − 0.5)`, entries
     `min(127, (i·step) >> 16)`.
   - **Radius.** R = `(VolumeRadius+1)·25` (+0x44); R² (+0x48); `1/R` (+0x54);
     `(1/R)²` from the unrounded reciprocal (+0x58).
   - **Distance and brightness.** `|L|²` (+0x50), and the brightness
     `VolumeBrightness·brightness·(1/64)` (+0x4c).
   - **Inside.** The flag is set when the 80-bit `|L|²` is below the stored
     R² (+0x5c).
4. **Fog loop** (`0x10b073bb–0x10b07c44`). The light-map grid (base
   `0x10b38a90`, U step `0x10b49e10`, V step `0x10b3d378`) goes to camera
   space through the same inline transform. For each texel P (float32 steps)
   and each light:
   - **Projection.** `dot = st((Pz·Lz + Py·Ly) + Px·Lx)`. When the light is
     not inside and `dot` has its sign bit set, the value is 0.
   - **Miss test.** `PP = (Px² + Pz²) + Py²` and `h² = st(|L|² − dot²/PP)`;
     `R² < h²` misses.
     - The global flag `0x10b4ea00` remembers a miss across texels, lights
       and surfaces.
     - While it is set, a quick test runs first: `PP·|L|² − dot² > PP·R²`
       misses.
   - **Chord.** `|P|` and `w = √(R² − h²)` come from the fast square-root
     table (`0x10b3e1b8`); `t = dot/|P|` and `s = t − |P|`.
     - When `t > w`, the far end is `w` and `s` clamps to `−w` (setting the
       clamp flag).
     - Otherwise the far end is `t` and `s` clamps to `−w` without the flag.
     - When `s` is not below the far end, the value is 0.
   - **Integral.** With `c = 3 − 3·h²/R²`, `a = far/R` and `b = s/R`, the
     value is `2·a·(c − a²)·B` when clamped, else
     `(a(c − a²) − b(c − b²))·B`. It is clamped to [0, 1].
   - **First light.** It writes `table[fistp(st(v·255))]`, using the
     extended v; a missed texel gets `table[0]`.
   - **Later lights.** They use the float-stored v and skip zero. For each
     colour channel the result is `min(127, atten[α][old] + new)`, and alpha
     is `min(127, old + α)`. The attenuation table at `0x10b38ac8` is
     `trunc((127 − α)·v/127)`, built at init `0x10b020cf`.
5. **D3D** (`UD3DRenderDevice::DrawComplexSurface`, `0x10003900`).
   - **Layout.** DX's FSurfaceInfo is PolyFlags, FlatColor, Level, Texture,
     LightMap, MacroTexture, DetailTexture, FogMap (+0x1c).
   - **Fog pass.** After the texture, light-map, macro and detail passes,
     the fog map is drawn with `SetBlending(PF_Highlighted)`. The original
     SetBlending executes as states `(27,1),(19,2),(20,6),(14,1)`: blending
     on, SRC = ONE, DEST = INVSRCALPHA, Z writes. So the fog adds its colour
     and attenuates the surface by its alpha.

## Translation and verification

`src/runtime/volumetric-fog.mjs` contains `coordsTransform`,
`volumetricLight`, `sortVolumetricLights`, `fogMap` and `FOG_ATTENUATION`.

`validate-volumetric-fog.mjs` runs the unchanged Render.dll segments
(`native-volumetric-fog-oracle.py`). ComputeFromActor runs from `0x10b06873`
and from `0x10b06a35` with a table buffer, skipping the GCache lookup. The
fog loop runs over the same lights in depth order.
- **Coverage.** 120 random frames, light-map grids and 1–3 lights, with the
  early-out flag starting in either state.
- **Result.** Every light field and colour-table byte, all 10,687 fog
  texels (7,162 fogged, 80 surfaces with merged lights, 65 inside-volume
  lights) and the final flag match.

Unverified or host choices, noted:
- **Early-out and index rounding.** The quick early-out test and the later
  lights' float-stored index scale are translated from the listing. Over
  these cases they give the same results as their alternatives, so the
  comparison does not separate them.
- **Ties.** Equal light depths keep the host sort's order. MSVCRT's `qsort`
  decides the original order, and the comparator never returns 0.
- **Draw order.** The early-out flag persists across surfaces in the
  original draw order. Play's surface order differs, which can change
  boundary texels.
- **Not done yet.**
  - the per-leaf admission and draw-list attachment;
  - the fog pass in Play, with the 7-bit upload scale to confirm;
  - fog on meshes (DrawMesh's Volumetrics argument);
  - a fast path for per-frame use.
