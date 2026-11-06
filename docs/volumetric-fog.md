# Volumetric fog (fog maps)

Stage 4, 2026-10-02 (24-bit render-pass precision since 2026-10-06).
Volumetric lights fill fog zones with lit haze. The
single-player maps have 104 lights with `VolumeRadius > 0` and 67 `bFogZone`
zones, each in 29 maps. This note records the original path. The fog-map
computation is translated and oracle-exact, and Play draws it (see "Play").

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
   - **Attachment.** OccludeBsp (`0x10b19612–0x10b196d6`) gives each new
     draw item an empty `Volumetrics` (+0x40). It then prepends every frame
     link whose sphere is not wholly outside one of the item's eye planes
     (`0x10b56608`, one per clipped-polygon edge): `N·L ≤ R` for each.
   - **Conservative culls.** This and the leaf admission only drop lights
     whose sphere no eye ray to a texel of the surface can meet. Such a
     light adds nothing (later lights skip a zero; a first light writes
     `table[0]`, which is all zero). The culls change results only through
     the early-out flag's carried state.
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

Everything below runs inside the render pass, so it executes under x87
precision control 24 ([render-pass precision](render-pass-precision.md)):
every add, subtract, multiply and divide rounds to a 24-bit significand,
with the x87's exponent range. The translation follows that since
2026-10-06; until then it modelled 64-bit registers, which the original
does not use here.

`src/runtime/volumetric-fog.mjs` contains `coordsTransform`,
`volumetricLight`, `sortVolumetricLights`, `fogMap`, `fogVertex` and
`FOG_ATTENUATION`. The reference bodies run on the BigInt x87 model with
each result rounded to 24 bits (`x87-pc24.mjs`, `p24add` and the others);
every operand is a loaded float, the double constants 25.0 and 65536.0 or
a small integer, all 24-bit values, so that is the PC 24 result.
`coordsTransform` computes finite inputs in doubles rounded with `r24`
(the 24-bit rounding with the wide exponent) and others on the BigInt
model. ComputeFromActor's volumetric tail at 24 bits
(`0x10b06baa–0x10b06c03`): `1/R` is rounded before it is squared
(`fdivr` then `fld st0; fmul st1`), `|L|²` is a 24-bit sum when `fcomp`
compares it with the stored R², and the colour-table step's `fsub 0.5f`
rounds too.

`validate-volumetric-fog.mjs` runs the unchanged Render.dll segments
(`native-volumetric-fog-oracle.py`, control word `0x007f`; the light-manager
tables at the init word `0x037f`). ComputeFromActor runs from `0x10b06873`
and from `0x10b06a35` with a table buffer, skipping the GCache lookup. The
fog loop runs over the same lights in depth order, then FLightManager::Fog
over twelve mesh vertices per case.
- **Coverage.** 120 random frames, light-map grids and 1–3 lights, with the
  early-out flag starting in either state.
- **Result.** Every light field and colour-table byte, all 11,533 fog
  texels (8,240 fogged, 80 surfaces with merged lights, 69 inside-volume
  lights), the 1,440 vertex fog planes and the final flags match.
- **The 64-bit model, measured.** Against the original at `0x007f`, the
  previous translation differed in `1/R²` for 92 and `|L|²` for 71 of the
  light infos and in 528 of the 960 vertex planes; its fog texels matched
  on these cases. On the captured Play inputs below it differs in 41 (Bar),
  78 (WanChai Market), 44 (Ship) and 335 (BatteryPark) of 41 million
  texels, and in two final early-out flags.
- **Transforms.** 20,000 transforms with magnitudes from 2⁻¹⁴⁰ to 2¹²⁰
  give the same bits through the doubles and the BigInt model.

**Rust core.** `native/script-vm/src/fog.rs` runs the same per-texel loop,
generic over three register models (`Reg`):
- **`Single`**: native f32 arithmetic, which is the PC 24 result as long as
  no product or quotient leaves binary32's normal range. A sum of floats
  whose exact value is subnormal is exact, so only products and quotients
  are tested: one at or below 2⁻¹²⁶ in magnitude (an exact zero included)
  sets `bad`, and the texel reruns on `Wide` from the same incoming flag.
  Overflow is excluded by bounds checked once per light (|L| ≤ 2³⁰, R² and
  |L|² ≤ 2⁶², 1/R and 1/R² ≤ 1, brightness ≤ 2⁸) and per texel
  (|P| ≤ 2³⁰): the largest intermediate is then below 2¹²⁶.
- **`Wide`**: f64 values rounded by `p24.rs`'s `r24` after each operation,
  exact for finite operands (the f64 rounding is innocuous before the
  24-bit one, 53 ≥ 2·24 + 2; f64 subnormals are unreachable from floats in
  these few operations).
- **`Exact`**: the 80-bit `Ext` model with `Ext::round24` after each
  operation, which also follows the x87's NaN and infinity rules. A light
  with a non-finite word or a non-finite texel position runs on it.
- **Interface.** `kernel.fog` in script-vm-kernel.mjs, wrapped by
  `fogMapKernel`. The JavaScript keeps the per-light constants, colour
  tables and the three grid transforms; the early-out flag persists in the
  module like the original global. `fog.setExact` / `fog_set_exact` runs
  every texel on `Exact` (FOG_EXACT=1 from Node), `fog.fallbacks` counts
  non-finite texels, `fog.reruns` the texels `Single` handed to `Wide`.
  `fog.check` (validation only) runs the loop on `Exact` with `Wide` and
  `Single` compared on every texel from the same incoming flag.
- **Memory.** Its statics (a 64K-texel output buffer) raise the kernel's
  `__heap_base` to `0x1931d0`, within the 2 MB object-arena reserve.
- **Check.** Two validators cover it.
  - `validate-volumetric-fog.mjs` runs the Rust loop on the 120 oracle
    cases and on 1,500 more surfaces against the JavaScript (137,442
    texels), and `fog.check` on all 1,620: 0 differences.
  - `validate-volumetric-fog-fast.mjs` replays real Play inputs.
    `volumetric-fog-capture.mjs` builds a world headless, swaps
    `fog-pass.mjs`'s kernel for a recording wrapper through a resolve hook,
    and drives `world.fog.update` over 240 deterministic views per map
    (cached in `.cache/volumetric-fog-inputs/<map>.<key>.json`, the key being a
    hash of the fog pass, fog model, precision helpers, lighting and Rust loop
    sources, so editing them recaptures; `--capture` refreshes them anyway). The
    captured `missIn` flag chain is Play's own: the Oct 3 captures went stale
    when the render pass moved to 24 bits (90d8092) and failed
    02_NYC_BatteryPark frame 75 surface 345 against the Exact replay.
    The maps are 02_NYC_Bar, 06_HongKong_WanChai_Market, 09_NYC_Ship and
    02_NYC_BatteryPark. Views sit inside and around the volumes and facing
    fog surfaces, plus the PlayerStarts and validate-volumetric-fog-play's
    view. One frame in eight sends every fog surface.
  - Each frame replays in Play's surface order with the flag carried. Over
    45,050,740 texel-lights (447,910 surface maps, recaptured with the
    24-bit Play), `fog.check` finds 0 differences in index or flag. The
    fast and `Exact`-only maps and final flags are equal, and the replayed
    flag chain equals Play's. No texel has a non-finite input; `Single`
    reran 10 (Bar), 36 (WanChai Market), 21 (Ship) and 9 (BatteryPark)
    texels on `Wide` (zero products).
  - Many lights, by hand with `--maps`: 02_NYC_Underground (20
    volumetric lights, 242,620,360 texel-lights) and 03_NYC_AirfieldHeliBase
    (10, 116,158,220) show 0 differences and no non-finite input.
- **Speed.** `validate-volumetric-fog-fast.mjs --bench` times the kernel
  loop with its uploads over the 211 frustum-culled view frames, `Exact`
  only against the fast registers (headless, Linux host, interleaved,
  medians of 7): Bar 26.9 against 0.81 ms, WanChai Market 21.7 against
  0.73, Ship 9.8 against 0.40, BatteryPark 26.1 against 0.96. Against the
  previous 64-bit loop's certified f64 fast path, interleaved in one
  process over the same inputs (medians of 15): Bar 1.06 → 0.89 ms,
  WanChai Market 0.85 → 0.76, Ship 0.49 → 0.45, BatteryPark 1.06 → 1.06.
  `coordsTransform`'s grid transforms, three per surface, moved from the
  BigInt model to doubles. Browser timings are not measured here.

## Play

`src/viewer/fog-pass.mjs` (`world.fog`) draws the fog maps.

- **Surfaces.** At world build it collects every light-mapped level surface
  in a `bFogZone` zone, with its light-map record, atlas tile, triangles,
  light UVs and bounds. It also collects every actor with `VolumeRadius > 0`,
  with its colour from `movingLightConstants` and its steady
  LightBrightness/255.
- **Camera frames.** A ViewportWindow's frame is a root frame of its own:
  `viewportWorldPass` (main.mjs) calls `update` again with the window's eye and
  rotation, its OccludeBsp surfaces and its child frames
  (docs/script-window-viewport.md "Camera pass"), before it draws the
  mirror frames and the frame itself. `validate-terminals-camera-browser.mjs
  --map 02_NYC_BatteryPark --computer ComputerSecurity2 --user NSF --password righteous
  --camera-actor SecurityCamera1 --camera=-619,-3679,290,0,29856 --expect fog`
  computes the maps of 59 surfaces for the camera.
- **Frame coords.** Each frame, main.mjs passes the view's eye and rotation.
  The frame coords are ViewCoords under the view rotation: `getAxes`' Y, −Z
  and X. getAxes computes `UnitCoords / Rotation`, and ViewCoords permutes
  and negates that basis, so the axes are exact.
- **Per frame.** For each fog surface in the view frustum, every volumetric
  light's constants are rebuilt (`volumetricLight`) and the Rust loop
  (`fogMapKernel`) fills the fog map. Its BGRA texels go into a fog atlas
  whose pages mirror the light atlas tiles, padding included.
- **Pass.** The pass draws each surface again with blending `ONE` /
  `ONE_MINUS_SRC_ALPHA`, Z writes and `LessEqual`. It samples the fog atlas
  at the light UVs, doubling the seven-bit channels as the light-map shader
  does.
- **Order** (2026-10-28). The maps draw where DrawComplexSurface draws them,
  after the surface's detail fans and before its decals and every
  translucent or modulated item. A masked surface's map draws in the
  non-occluding list's band, since D3D's fog pass over it is not
  alpha-tested. Until then the pass drew after every other world item, which
  painted the 02_NYC_Underground waterfall's fog glow over the modulated
  sheets in front of it. The change was compared with the original under
  Wine: [DrawFrame's draw order](bsp-occlusion.md#drawframes-draw-order).
- **Movers** (with the [brush tracker](brush-tracker.md), 2026-10-07). A
  mover polygon is an FBspSurf of the level model, so SetupForSurf gives
  each of its draw items a fog map under the same gate: the item's zone is
  bFogZone and the surface has a light map. For a dynamic surface the
  light-map index comes from `Surf.Actor->Brush` (`0x10b06e2c..0x10b06e4a`);
  the lattice uses the surface's own pBase and vectors, which each Update
  rewrites in world space.
  - On maps with a fog zone, world.mjs records every lit mover polygon's
    light-map record (`addMoverPolygon`).
  - For each frame the simulation sends the mover draw items in draw-list
    order (`moverItems`). Each item carries its polygon, its iZone, its
    tracker surface's pBase, vTextureU, vTextureV and vNormal
    (`brush-tracker.mjs surfaceFacet`) and its fragments' points
    (`bsp-occlusion.mjs nodePolygon`, where the last Update left them).
  - Each item in a bFogZone zone gets its own map. The pass builds the
    lattice as for level surfaces (`lightmapBasis`, p00, p10 and p01) from
    those vectors and the Brush's light-map index, then runs the same loop.
  - Each map is drawn over that item's fragments only, from a padded
    texture of its own. The light UVs are `lightmapBasis.uv` of the fragment
    points, with texel centres at +0.5, the light atlas's convention. A
    polygon split across zones therefore fogs only its pieces in fog zones,
    each with its own map, as the original does. Each fan triangle is wound
    to face the eye as the level's are (`buildSurfaceGeometry` reverses one
    whose Unreal winding runs along the normal; `itemMesh` does the same
    with the facet's normal). Until 2026-10-17 (52741bb) the fans kept the
    polygon's order, and an item wound along its normal was culled by the
    front-side material: the Ship locker room's five closed lockers drew
    no fog, 12 to 15 levels darker than the original
    ([visual acceptance](visual-acceptance.md), the Ship's window 2).
- **Child frames** (2026-10-07, with `?childFrames` on). SetupForSurf
  takes the frame DrawFrame is drawing as its first argument and stores it
  at `0x10b38a7c` (`0x10b06d3d`). The fog loop and ComputeFromActor read
  that frame's Coords, so a mirror or sky frame gets fog maps of its own,
  from its reflected or sky camera.
  - DrawFrame draws a frame's children first (`Frame->Child`, then each
    `Sibling`, `0x10b1a336..0x10b1a348`) and then its own lists. The pass
    therefore computes every child frame's maps in that order, the root
    frame's last, carrying the early-out flag through.
  - The surfaces are the ones each frame's OccludeBsp drew (its nodes and
    mover polygons, with their items' zones and facets). The Coords are the
    frame record's own (`visibility.frames[].coords`, from occlude.rs).
  - The child maps wait until their pass. `framePass(frame, renderer)`
    copies each one into the atlas tile it shares with the root frame
    (`copyTextureToTexture`, one padded tile at a time) and shows only that
    frame's fog meshes. At the end of the pass the root frame's tiles and
    meshes are restored.
  - `?childFog=off` keeps the earlier behaviour: child passes reuse the root
    frame's maps.
- **Check.** `validate-volumetric-fog-play.mjs` stands in 02_NYC_Bar's
  Light90 volume, in the default mode with the simulation in the worker
  (`placeProbe` moves the player there; `--query sim=inline` runs it on the
  page).
  - 919 fog-zone level surfaces and 30 lit mover polygons are collected.
  - The 7 that OccludeBsp draws in that view get fog maps (8,704 texels)
    through the Rust loop, and the frame changes with the pass (2026-10-06;
    before occlusion, 264 surfaces in the frustum did).
  - The haze takes the light's blue and thickens with distance.
  - **Mover phase.** The player then faces DeusExMover9, a door in the
    bar's fog zone about 1,900 units from Light90. The draw item of its
    polygon 4 (one fragment) gets a 4×8 fog map. Its inputs (lattice, frame
    coords, light, early-out flag) go through the unchanged Render.dll loop
    (`native-volumetric-fog-oracle.py`), and the texels are equal. The
    fragment's light-map coordinates run from texel centre to texel
    centre: 0.50 to 3.50 by 0.50 to 7.50.
  - **Mirror phase.** On 10_Paris_Club the player faces the bar's two
    mirrors (surfaces 231 and 232) from `[-122,-1008,60]`, inside Light15's
    volume in fog zone 7. The two mirror frames get 53 child maps.
    - The most fogged map comes from mirror frame 1's Coords (determinant
      +1, where the root frame's ViewCoords give −1): surface 10, 80×50.
    - Its inputs go through the same oracle, and the texels and flag are
      equal.
    - The Bar's own mirror is not used, because the Bartender's greeting
      takes the view within about a second of standing there.
- **Cost of the child maps** (interleaved A/B against `?childFog=off`, the
  club mirror view, worker mode, 1920×1080, 600 frames, 3 rounds,
  load 9–12 from other agents):
  - The page's fog phase is 2.0–2.3 ms against 0.4–0.9 ms. It computes the
    53 child maps and the root frame's.
  - The mirror passes are 3.8–4.3 ms against 2.3–4.5 ms.
  - Mirror draw calls are 77 against 29: each fogged child surface draws its
    fog mesh, as the original draws a fog pass over each such surface.
  - The child maps run on the page. Moving them next to OccludeBsp in the
    worker is a possible saving that has not been tried.

Unverified or host choices, noted:
- **Upload scale.** The seven-bit upload scale (×2) follows the light maps.
  Render's vertex fog uses the same 2v (see "Mesh fog"). UT432's D3DDrv
  source uploads RGBA7 textures to 8888 as `*Dest = *Src * 2` (every
  channel, alpha included); DX's own D3DDrv.dll filler is not yet traced.
- **Light linking.** Every volumetric light is linked to every fog surface.
  The original's culls drop only lights that add nothing, but the early-out
  flag then sees a different sequence.
- **Brightness and colour.** Volumetric lights use their steady brightness
  and colour; GlobalLighting's LightType animation is not applied to them.
- **Not fogged.** Meshes draw unfogged as D3D does ("Mesh fog").
- **Mover lattice.** The lattice's derivation (`lightmapBasis`, in doubles
  rounded to floats) is the one used for level surfaces. One case is
  checked against the running original (2026-10-17): the Ship's five
  locker faces, where SetupForSurf's grid (base 0x10b38a90, steps
  0x10b49e10 and 0x10b3d378) and the fog map it fills (*0x10b38aa0) equal
  Play's. No checked view yet shows one polygon split into several fogged
  items.
- **Gamma.** The display ramp maps the finished frame after the pass
  blends ([lighting](lighting.md), "Display ramp"), as the original's
  SetGammaRamp does. Until 2026-10-03 it applied per fragment, before
  blending, which showed faint fog over dark surfaces 2–3× too strongly.
- **Early-out and index rounding.** The quick early-out test and the later
  lights' float-stored index scale are translated from the listing. Over
  these cases they give the same results as their alternatives, so the
  comparison does not separate them.
- **Ties.** Equal light depths keep the host sort's order. MSVCRT's `qsort`
  decides the original order, and the comparator never returns 0.
- **Draw order.** The early-out flag persists across surfaces in the
  original draw order. Play follows DrawFrame's order across frames
  (children first), but within a frame its surface order differs, which can
  change boundary texels.

### Uploads (2026-11-05)

A level surface's fog map is written into its padded tile of an atlas page (`writeTile`). Until this change every page with a written
tile was then re-uploaded whole (`texture.needsUpdate`). On Battery Park that was 18 page uploads a frame, 8.3 MB and 4.4 ms of
Firefox's frame (`.work/perf/upload-sources.mjs`, WebGL uploads by call site), while the frame's fog maps hold about 45,000 texels.

A page's texels change only in `writeTile`. So once a page's texture is on the GPU and current, `update` now sends only the padded
tiles it wrote, each as a tightly packed view through three's state cache, as the light atlas does. Firefox copies a call's whole
source view whatever the unpack state selects (light-atlas.mjs `flush`), so `copyTextureToTexture` from the page's pixels would
have copied the page once per tile.

A page whose texture has never been uploaded, or whose full upload three still owes, is still uploaded whole, and that upload reads
the same pixels. The whole-page path also covers a caller without a renderer and `?fogUpload=page` (`FOG_UPLOAD=page`). A child
frame's maps still go through `framePass`'s copies, which its pass's end undoes from the page pixels.

* **Checks:** `deusExViewer.fogPages()` (fog-pass.mjs `pagesMatch`) reads each page back from the GPU and compares it with its pixels.
  It found 0 differing texels on Battery Park in both modes, after turns of the view. validate-volumetric-fog-play now asserts the
  same on the Bar and after the Paris Club's mirror frames, and passes in worker and inline mode, with the Bar's fog surfaces, the
  mover map and the mirror frame's maps equal to Render.dll's loop.
* **Cost:** Battery Park's uploads went from 8.3 MB and 4.36 ms a frame to about 0.14 MB and 0.15 ms for the fog tiles (Firefox,
  headless). Firefox inline on the census route, three interleaved pairs (`hitch-ab.mjs`, `?fogUpload=page` against the default):
  * Battery Park: the page frame p50 24 → 20 ms, p95 28 → 24 ms;
  * the Bar: p50 12 → 9 ms, p95 14 → 11 ms.

**The fogged-surface test (2026-11-05).** `update` asks each fog map whether it has a nonzero texel, for the frame's fogged-surface
sets that the detail pass reads. `texels.some(Boolean)` called back once per byte in Firefox, 1.26 ms of Battery Park's 2.38 ms fog
phase. `anyFog` loops over 32-bit words instead, with the same answer. Battery Park in Firefox, three sessions after the change
against the three tiles sessions above: the fog phase 2.44 to 2.54 → 1.24 to 1.34 ms, the page frame p50 20 to 21 → 17 to 18 ms and
p95 23 to 24 → 21 to 22 ms. validate-volumetric-fog-play passes.

**The child frames' restore (2026-11-06).** After each child frame's pass, `framePass(null)` puts the root frame's tiles back. It
copied them with `copyTextureToTexture` from `mainSource`, a texture over the whole page, so Firefox copied the page's
size × size × 4 bytes for every tile restored, after every child pass. Beside the Paris Club's two large mirrors, which meet at a
corner and reflect each other to recursion 3, that was 165 MB and 36 ms a frame. The user reported the drop as about 30 fps on the
Mac. The restore now copies the tile's padded rectangle of the page pixels into the surface's tile-sized `scratch`, the source the
child maps already use, and copies from that. The GPU receives the same texels; `?fogUpload=page` keeps the page source.
* **Cost:** headless Firefox inline, 10_Paris_Club, `hitch-run.mjs --mode idle --god --seconds 30 --place
  '{"location":[-100,-1250,40],"rotation":[0,52436,0]}'` (looking at the corner of surfaces 231 and 232): page frame p50 59 → 17 ms,
  16 → 57 fps, `p.mirrors` 44.9 → 4.0 ms, uploads 165 → 0.85 MB a frame (the same 292 calls).

## Mesh fog

Recovered 2026-10-06 from Render.dll, D3DDrv.dll (`9e0f8a42…d8ac9f`) and
GlideDrv.dll; reference: `scripts/native-mesh-fog-oracle.py GAME_ROOT
[cw]` (vertex fog, D3D DrawGouraudPolygon, and DrawLodMesh's projection and
face helper into the real D3D vtable, at the render pass's 0x007f).

- **Render.** DrawLodMesh computes `Fog = FLightManager::Fog(vertex,
  PolyFlags)` (vtable `+0x1c`, `0x10b10a2f`) once per marked vertex, after
  Light, and stores it raw at FTransSample `+0x40`. Only frustum and
  near-plane clipping touch it afterwards (interpolated like Light, each
  step stored as a float); the face helper's averaging subdivision is dead
  code, as DrawMesh always sets PF_Flat (`0x10b0d1c9`). Nothing reads Fog.W
  and no `(1 − Fog.W)` dims the lit colour.
- **D3D** (`UD3DRenderDevice::DrawGouraudPolygon`, `0x100056b0`). Fog is
  used when `UseVertexSpecular` (`+0x9d0`) is set and `(PolyFlags &
  0x40000044) == 0x40000000`: the vertex specular is `0xFF000000 |
  fistp(st(Fog.c · 255))` (K = 255.0f at `0x100186a8`), the diffuse alpha
  becomes `0x78`, and SetBlending (`0x10008270`) enables SPECULARENABLE for
  those faces, so the pixel is `tex·diffuse + fog` (clamped). D3D's own fog
  (FOGENABLE) is never turned on.
- **The gate is off in the shipped configuration.** `+0x9d0` starts at 1
  (`0x10001d1f`), and SetRes clears it for a 3dfx device (`0x1000c248`),
  without specular Gouraud support (`0x1000c4eb`), or when the config
  property **UseVertexFog** (`+0x9e4`) is False (`0x1000c72a`). Nothing gives
  UseVertexFog a default and no shipped INI (DeusEx.ini, Default.ini,
  User.ini, DefUser.ini) sets it, so **D3D draws no mesh fog**: specular 0,
  diffuse alpha 0xFF.
- **Glide** (GlideDrv `0x10707070`) has no gate: it redraws a fogged face
  with the vertex colour `Fog·255` and `(ONE, ONE_MINUS_SRC_COLOR)`, so
  `dst = fog + dst·(1 − fog)`. The installed DeusEx.ini selects Glide.
- **Never fogged** whatever the device: the weapon view model and
  Canvas.DrawActor (no Volumetrics), bParticles meshes (Fog 0), and actors
  SetupForActor gates out (bUnlit, RendMap ≠ 5, NoLighting).
- **Movers** are BSP surfaces (the brush tracker), so their fog is the
  fog-map pass above, with the same gate (zone bFogZone, the draw item's
  Volumetrics, not translucent) for mover surfaces with a light map.

**Play** follows the D3D renderer, as the rest of the presentation does
(mesh lighting, decals, the display ramp): meshes draw unfogged, which is
what the shipped configuration shows. UseVertexFog = True (specular fog,
and masked fogged meshes failing the alpha test at `0x78`) and the Glide
pass are explicitly unsupported options. Mover surfaces are fogged by the
fog-map pass ("Play", Movers).

Precision: FLightManager::Fog runs in the render pass (24-bit). At
`0x007f` its FPlanes differ from the `0x037f` results in 328 of 480
components (cancellation, up to 1,219 ulps). `fogVertex`, the fog-map loop
and ComputeFromActor's volumetric constants now follow precision control
24 and match the original at `0x007f` (see "Translation and
verification"); `fogVertex` is not used in Play.
