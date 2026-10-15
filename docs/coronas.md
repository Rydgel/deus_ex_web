# Light coronas

Stage 4, 2026-10-02. Lights with `bCorona` draw their Skin as a screen-space
flare that fades in while the light is visible and out while it is not. The
single-player maps have 327 such lights in 20 maps.

Authority: Render.dll `607f1077…d75d1`, Engine.dll `0c3a8b18…`, and the
Deus Ex SDK 1112f headers (Reference/, research only, for FSceneNode and
the TRACE_ flags).

## The pass (`URender::DrawFrame`, `0x10b1b46a–0x10b1bb06`)

1. **Gates.**
   - The viewport actor's `Region.iLeaf` (+0xcc) must be valid and its
     `Region.Zone` (+0xc8) set.
   - `RenDev.Coronas` (+0x60, Engine's registration) must be on.
   - The frame must be the top level (`Recursion` +0x1c is 0); mirror
     children draw none.
2. **State.** A GCache item (id `0x27`, created zeroed) holds 32 entries of
   `{Actor, actor index, brightness}`.
3. **Clock.** `Δ = (now − last)·3.0` with appSeconds (first use starts the
   clock), stored to float32.
4. **Fade** (`0x10b1b682`). Every live entry's brightness drops by Δ. FST
   keeps the difference, and below 0 the slot is freed.
5. **Visibility.** The helper `0x10b1bc00` runs for each light of the
   viewport actor's leaf, `FLeaf.iPermeating` into `Model.Lights`, and for
   the leaf's dynamic lights (`LeafLights[iLeaf]`):
   - **Level and movers.** `SingleLineCheck(frame origin → Location,
     TRACE_Level|TRACE_Movers)` must be clear, over Level->Model as the
     moving brush tracker left it ([below](#lights-behind-a-movers-fragments-2026-10-14)).
   - **Other actors.** `SingleLineCheck(…, TRACE_Pawns|TRACE_Others)` must
     be clear or hit the viewport actor.
   - **Light.** It needs `bCorona` (+0x1ec bit 2) and a Skin (+0x170), and
     must not be `bDeleteMe` (+0x28 bit 7).
   - **Update.** An entry already holding the light gains `2Δ`, capped at 1.
     Otherwise the next free slot, from a per-pass index, takes
     `{light, ULevel::GetActorIndex, min(1, 2Δ)}`. A seen light thus
     brightens by Δ per frame and an unseen one fades by Δ, so a full fade
     takes a third of a second.
6. **Draw** (`0x10b1b745`), for each live entry:
   - **Validity.** `Level.Actors[index]` must still be the light (the
     index ≤ Num check is followed by the array compare).
   - **Projection.** The location is transformed by the frame coords
     (inline TransformPointBy) and drawn only when `z > 1.0`.
   - **Colour.** LightHue gives three 85-wide sectors (1/85, the last blue
     term 1/84). Each channel is then blended toward 1 by
     `LightSaturation/255`; Z's `1 − c` stays unrounded, while X's and Y's
     are stored first.
   - **Placement.** `X = (Proj.Z/z)·x + FX2`, `Y = (Proj.Z/z)·y + FY2`, and
     `size = st((Frame.X·DrawScale)·0.2)`.
   - **Skin override.** When the viewport actor is a PlayerPawn with a
     `Sprite` (+0x168), the light's Skin is replaced by
     `Sprite->Get(Viewport.CurrentTime)` before the draw. No class in the
     player's chain sets a Sprite.
   - **Canvas call.** `Canvas.DrawIcon(Skin, X − size/2, Y − size/2, size,
     size, Span 0, Z 1.0, brightness·colour, fog 0, PolyFlags 0x104)`, where
     0x104 is Translucent|TwoSided.

## Leaf lights

Which lights the pass offers the helper (`0x10b1b6b1-0x10b1b743`, with
`iLeaf` the viewport actor's `Region.iLeaf`, `+0xcc`), in order:

1. **Static run.** `Model.Leaves[iLeaf].iPermeating` (FLeaf, 20 bytes, `+4`)
   indexes `Model.Lights` (`+0xe4`), whose run of actors ends at a null
   entry; none when iPermeating is -1.
2. **LeafLights.** `URender::LeafLights` (`0x10b5a6fc`) is an array, one list
   head per leaf; each node holds the light at `+0xc` and the next node at
   `+0x10`. The list is walked from its head, each light going through the
   same helper. A light that is on both lists is offered twice, and the
   helper's two line checks and its `2 * delta` run each time.

LeafLights is what `SetupDynamics` and `OccludeBsp` left, per frame, for the
**moving lights**:

- **Candidates** (SetupDynamics `0x10b230e8-0x10b232ee`, in `Level.Actors`
  order): `LightType` (`+0x1e0`) nonzero; `bStatic | bNoDelete` (`+0x28`
  bits 0 and 2) clear unless `bDynamicLight` (`+0x29` bit 3) is set;
  `LightBrightness` (`+0x1e2`) and `LightRadius` (`+0x1e5`) nonzero; and the
  light's sphere not wholly outside one of the frame's four **ViewPlanes**
  (`+0x12c`, the pass frame above): `R = max(WorldLightRadius,
  25 * (VolumeRadius + 1))`, skipped when `-R > ((z * nz + y * ny) + x * nx) -
  w` for some plane. Each becomes an `FDynamicLight` prepended to node 0's
  list (HitLeaf clear).
- **Filter** (`FDynamicLight::Filter 0x10b24a10`, at each node's first visit,
  items from the list head, radius `WorldLightRadius` only): for the front
  side (`-R < Dist`), then the back side (`Dist < R`), an item that has not
  yet hit a leaf and has a leaf on that side (`FBspNode.iLeaf`, `+0x3c`
  front, `+0x38` back) is prepended to `LeafLights[leaf]` (first hit of a leaf
  also appends it to `DynLightLeaves`, which has room for about 1,080), and
  the copy for that side's child node, prepended to the child's list, carries
  HitLeaf. Every copy is a new item, so the list order flips at each hop: a
  leaf's list is in candidate order below an even number of nodes and in
  reverse candidate order below an odd number.

`movingLightInView` and `movingLightLeafLists` (dynamic-lighting.mjs) are the
translation. `validate-leaf-lights.mjs` runs the unchanged SetupDynamics light
block (the gate and the ViewPlanes test, with the master frame's planes from
the Rust core) and Filter over each level's BSP for 90 cases (Training,
Island, Paris Club; 235 to 284 lights with random gates, volume radii and
positions each): every accepted light and the order of every leaf list (about
14,000 lists with 21,000 to 27,000 entries per map; a quarter to a half hold several
lights, half of those in reverse candidate order) match. Mutations (no ViewPlanes test,
`R` without the volume term, the other list order) fail it.
`validate-coronas.mjs` runs the unchanged leaf loops (60 cases, 155 helper
calls, 61 of them from LeafLights) with the helper recording the light it is
called for: the static run and the list, in order, match.

OccludeBsp visits only the nodes its walk reaches; the translation takes
every node as visited, which holds for the ancestors of the viewer's leaf
(its zone is active and its bounds contain the eye), where this pass reads.

**The moving brush tracker's fragment nodes do not change the lists.** A
fragment is a new node hung off a leaf side of its parent (the parent's
iFront or iBack changes, its iLeaf does not) with iLeaf copied from that
side; Filter hits the leaf at the parent, which sets HitLeaf on the copy for
the fragment, so no deeper node adds the light again, and the parent's hop
parity is the static model's. `validate-leaf-lights.mjs` also runs the
original's Filter over the tracked BSP of Training (25 movers, two raised),
the Paris club (13, two turned) and the Island (19; 19,560, 5,672 and
26,936 nodes against 9,524, 2,580 and 13,212): it matches the translation
and its leaf lists equal the static model's in every case.

**Mesh lighting.** `mesh-lighting-view.beginFrame` builds the same lists
(its `frame.leafLights`, read by SetupForActor), from the master frame built
before the frame's lighting setup (sim-session `frameMaster`; the planes and
Coords depend on the view and the render rectangle alone). Before, it put each
candidate on every leaf it reaches in reverse candidate order with no
ViewPlanes test. On seeded views of the Island (8 views, 370 lit LOD-mesh
actors, `census-mesh-leaf-lights.mjs`) 81 of 128 candidates that reached a
leaf lie outside a ViewPlane (they were lights behind or beside the view),
1,202 of 1,568 leaf lists differ (99 only in order), 21 actors have a
different list for their own leaf and 4 choose different lights; the Paris
club has no moving-light candidates without AugLight (754 actors, none
change). With AugLight on, in 12 views facing the club's mirror movers JC's
chosen lights are unchanged (both Beams are inside the frame's planes; the
leaf list's order differs in 8 of them, which does not reach the selection,
whose sort keys differ). A mirror child frame has its own SetupDynamics,
planes and LeafLights in the original (OccludeFrame per frame); since
2026-10-08 Play lights each actor in every frame that draws it with that
frame's own lists ([mesh lighting](mesh-lighting.md#one-call-per-frame-child-frames-lighting-2026-10-08)).

## The frame

The pass is inside `URender::DrawFrame` (`0x10b1a2d0`), whose argument
(`[ebp + 8]`, `esi`) is the frame `DrawWorld` hands it: `DrawWorld`
(`0x10b1cb90`) pushes the same `ebx` for `OccludeFrame` (`0x10b1ce3b`) and for
`DrawFrame` (`0x10b1ce44`), so the corona pass reads the frame OccludeBsp read:
CreateMasterFrame's frame after XRootWindow::PreRender's `ComputeRenderSize`
at 24 bits on the render rectangle ([the 3D frame's
projection](render-pass-precision.md#the-3d-frames-projection-2026-10-08)).
The fields, by instruction (`ecx` is that frame from `0x10b1b7b4`, not
reloaded before the last read):

| Field | Offset | Reader |
| --- | --- | --- |
| Coords (the inline TransformPointBy) | `+0x34` | `0x10b1b7c0` (`lea eax, [ecx + 0x34]`, then the 12 FSUB/FMUL operands) |
| Proj.Z | `+0xdc` | `0x10b1b9cf` (`fld`, then `fdiv` by the transformed z) |
| FX2 | `+0xc8` | `0x10b1b9fa` (`fadd`) |
| FY2 | `+0xcc` | `0x10b1ba06` (`fadd`) |
| X | `+0xa8` | `0x10b1ba0f` (`fild`, the size's `X * DrawScale * 0.2`) |
| Coords.Origin, the line checks' Start | `+0x34` | helper `0x10b1bc43` (`lea edi, [esi + 0x34]`, pushed before each `SingleLineCheck` call at `0x10b1bc5b` and `0x10b1bcac`) |

Coords is CreateMasterFrame's (game thread, 64 bits); X, FX2, FY2 and Proj.Z
are the pass's: the render rectangle's width in the drawing buffer's pixels,
`X * 0.5`, `Y * 0.5` and `FX2 / tan` at 24 bits with appTan of the 24-bit
argument.

## Translation and verification

`src/runtime/coronas.mjs` contains `createCoronaCache`, `coronaDecay`
(clock and fade), `coronaFade`, `coronaSeen`, `coronaColor` and
`coronaIcon`. The pass runs inside the render pass, under x87 precision
control 24 ([render-pass precision](render-pass-precision.md)), so every
arithmetic result is rounded once to a 24-bit significand (`x87-pc24.mjs`;
exact also for the double operands 1/255, 3.0 and 1.0), and the light's
frame-space location comes from `coordsTransform` at the same precision
(2026-10-06; the 64-bit model before differed in the DrawIcon arguments of
92 of the 200 validator frames, 299 of 305 icons).

`validate-coronas.mjs` runs the unchanged code (`native-coronas-oracle.py`,
control word `0x007f`):
- **Setup.** The fade loop, the helper with scripted SingleLineCheck answers
  and Engine's own GetActorIndex, and the draw loop with a recording
  DrawIcon.
- **Coverage.** 200 random frames with one to four lights (in front of and
  behind the eye), prefilled caches (stale indices and full caches included)
  and helper calls over every answer and gate.
- **Result.** All fades, cache updates (87 new entries) and 352 DrawIcon
  calls (every argument) match.
- **The master frame (2026-10-08).** 80 more frames take their Coords, X, FX2,
  FY2 and Proj.Z words from the frame OccludeBsp reads (the Rust core's
  CreateMasterFrame and render-pass ComputeRenderSize on a viewport and a
  render rectangle, half of them clipped, FOV 75 and 90, `coronaFrame` mapping
  the words as Play's scan does) and give them to the original pass as its
  DrawFrame argument: the DrawIcon calls (455 in all, with the first 200
  frames') match bit for bit. A swapped FX2/FY2 fails them. The fields built
  without an OccludeBsp frame (`coronaFrameFromCamera`, Engine's producers on
  the rectangle) equal those words in every frame.
- **Stub.** The oracle answers 1 for `UObject::IsValid`, the entries'
  assertion.

## Play

The simulation side's `src/viewer/corona-scan.mjs` runs the pass after the
world's drawn set and its stamps, before the first-person weapon and the HUD,
matching DrawFrame ahead of PostRender. It hands the page a list of icons;
`src/viewer/corona-pass.mjs` draws them after the main world draw
([simulation worker](sim-worker.md) step 6).

- **Gates and fade.** It checks the player's Region, then fades the cache
  with the host clock.
- **Visibility.** It visits the lights permeating the player's leaf and then
  its LeafLights (above): the moving-light candidates of the frame
  (`game.movingLights()`, with `VolumeRadius`), filtered by the master
  frame's ViewPlanes and through the map's BSP. Model references resolve to
  live actors by export name, and the two line checks are Play's translated
  SingleLineCheck (`level.hash.lineCheck`), from the frame's origin to the
  light; the first one over the tracked model (`lineModel`, below).
- **Draw.** Each live entry's `coronaIcon` is computed with the frame the
  pass reads (above): the master frame's words, `visibility().master` of
  the same main frame, so the line checks start at its Coords.Origin and the
  icons are in the drawing buffer's pixels (X is the render rectangle's
  width in device pixels; before 2026-10-08 the scan used CSS pixels and
  `fx2 / Math.tan(fov * pi / 360)`). A session without OccludeBsp builds
  the fields with `coronaFrameFromCamera`. The tile is the original's
  ([below](#on-the-tile-chain-2026-10-15)): in the master frame the vertex
  shader builds UCanvas::DrawTile's clip and D3DDrv's four vertices from the
  DrawIcon rectangle, drawn over the world with the canvas's translucent blend
  (ONE, INVSRCCOLOR) and no depth test; the display ramp maps the finished
  frame. A camera window's pass (no frame) keeps a flat orthographic tile.
- **Camera frames.** A ViewportWindow's DrawWorld runs the pass on its own
  master frame (docs/script-window-viewport.md "Camera pass"): the same scan
  and cache, with the lights of the *player's* leaf, line checks starting at the
  camera frame's origin, the camera frame's words for the placement and the
  window's width as X. The pass takes the plan's clock, which runs on from the
  main pass's by the host's elapsed time. The camera validator
  (`validate-terminals-camera-browser.mjs --player=-2561,-2682,320
  --camera=-2561,-2200,340,0,49152`, Island's street lamp seen from 480 units)
  recomputes each placement from the frame words with `coronaFrame` and
  `coronaIcon` and requires the bits to match.
- **Check.** `validate-coronas-play.mjs` looks up at a corona light from a
  start, in the default mode with the simulation in the worker
  (`placeProbe({lookAt})`; `--query sim=inline` runs it on the page). On 02_NYC_BatteryPark, Light410 is among 5 leaf lights, 3 are
  visible and 1 is drawn. On 03_NYC_Airfield, Light348 is among 13 leaf
  lights, 7 are visible and 4 are drawn. In both, the frame changes with the
  pass and the street lamp shows its glow. In worker mode it also reads the
  scan's icons with the inputs of their placement and the master frame's
  words (`deusExViewer.coronas()`), recomputes each icon's x, y and size
  with `coronaFrame` and `coronaIcon`, and requires the bits to match (1
  placement on BatteryPark, 4 on Airfield; `--dpr 2` too: X 2048). It then
  makes Light410 a moving light (`bDynamicLight` and a `LightBrightness`,
  through `placeProbe({set})`: its map LightBrightness is 0, which the gate
  rejects) and requires the scan to offer it to the helper twice a frame,
  once from each list, with the same single icon. The map's conversation
  lights (ConLight0 and ConLight1, non-static) come through LeafLights too.

What the frame change moves (`census-master-frame-pass.mjs`, 100 seeded views
per map, 1440x960, eight probe lights in front of each camera, the old frame
at the same size): at FOV 75, Play's default, Coords and Proj.Z are bit-equal
to the old ones and no icon moves; at FOV 90 appTan of the 24-bit argument
changes Proj.Z in every view and 280 of 800 probe icons on the Island (262 of
800 on Paris Club) move or resize by an ulp or more. Beyond that the scan now
reads the frame itself, in the pixels of the drawing buffer.

Host choices, noted:
- the clock is the host's;
- with no master frame the leaf lists take every candidate (no ViewPlanes
  to test);
- the display ramp applies to the finished frame, after the tile blends
  ([lighting](lighting.md), "Display ramp").

## On the tile chain (2026-10-15)

The pass ends in `Canvas.DrawIcon(Skin, X - size/2, Y - size/2, size, size, Span 0, Z 1.0, colour, fog 0,
0x104)`; the call is the sprites' ([frame projection](frame-projection.md#sprites-the-tile-the-render-device-receives)),
so everything after it is the same chain, with its arguments:

- **The call** (Render.dll `0x10b1ba5e..0x10b1baea`). PolyFlags `push 0x104` (`0x10b1ba5e`), Fog and Color as
  FPlane temporaries (`0x10b1ba63..0x10b1baaf`: Core's constructors through `0x10b5d528`, `0x10b5d530`,
  `0x10b5d5c4`; the colour the oracle shows is brightness times the hue colour with W 0), `push 0x3f800000` = **Z 1.0** (`0x10b1bac7`), `push 0` the span, XL
  and YL = size (`[ebp - 0x70]`, `0x10b1bace`), Y and X less `size * 0.5` (`fld [ebp - 0x70]; fmul [0x10b2a5c8]` at
  `0x10b1bab5`, `fsub st(1)` at `0x10b1bad0` and `0x10b1bae1`, each stored to its argument slot at precision 24), the
  Skin `[ebx + 0x170]`, and `call [edx + 0x60]` (`0x10b1baea`) through the viewport's canvas `[Viewport + 0x5c]`:
  UCanvas::DrawIcon `0x10376640`, which hands UCanvas::DrawTile `0x10376160` the texture's size as the source
  rectangle, which calls D3DDrv's DrawTile `0x10005ba0` (the sprites' steps 4 to 6).
- **Z 1.0.** D3DDrv's `RHW = 1.0 / Z` is exactly 1 and `depth = RHW * _43 + _33 = _33 - _33` is exactly 0 (`_43 = -_33`),
  so the tile passes every depth test and writes nothing the original's translucent tile would not: Play draws it after
  the world with no depth test, as before.
- **The canvas' frame.** DrawTile clips to `[0, FX] x [0, FY]` of `Canvas+0x7c` and D3DDrv offsets by that frame's XB, YB.
  Neither DrawFrame nor DrawActorSprite updates the canvas (no virtual `+0x58` call in `0x10b1a2d0..0x10b1b745` or
  `0x10b25080..0x10b25700`); the canvas is put on a frame once, in the Engine function containing `0x1038f68e` (the
  `frame` probe starts at `0x1038f110`), `Viewport->Canvas->Update(Frame)` (`[edx + 0x58]` on `[edi + 0x5c]`) with
  `CreateMasterFrame`'s result (`call [edx + 0x64]` at `0x1038f5dc`). For the corona pass, which runs in the top-level
  frame only, that is the frame it reads: the master frame (FX, FY the render rectangle's width and height, XB, YB its
  offset).

`scripts/native-sprite-draw-oracle.py` runs the loop `0x10b1b745..0x10b1bafc` unchanged over a prepared cache (a `coronas` list
in a case: texture, Location, DrawScale, hue, saturation, brightness; slot k holds light k at Level.Actors index k + 1) on the
root frame the unchanged CreateMasterFrame, ComputeRenderSize and OccludeBsp left, after the frame's sprites, with the sprite
oracle's canvas, D3D device and texture fixtures; the loop's own Coords transform, Proj.Z, FX2, FY2 and X, DrawIcon, DrawTile and
D3DDrv's DrawTile run as original code.

**Port.** `src/runtime/sprite-tile.mjs iconVertices(icon, 1, texture, frame, depth)` (DrawTile's clip and U/V scale, then
`deviceVertices`; `spriteVertices` is `spriteIcon` followed by it); GLSL `fpCanvasTile` in `src/viewer/sprite-tile-glsl.mjs`
(`fpSpriteTile` is `fpSpriteIcon` and it; the barrier and correctly rounded divisions are the sprites'), used by
`frameProjection.patchCorona`, the vertex stage of the corona pass's material (`corona-pass.mjs`), with `fpSpriteVertex`
at Z 1.0 and the host's clip depth in the middle of the volume. `main.mjs` sets the master frame's projection around the
pass, as for the first-person weapon; a camera window's pass has no frame and keeps the flat orthographic quad,
which since the merge samples the texture the same way up (first row on top, `vMapUv` flipped as for the sprites'
billboards); `?spriteTiles=off` keeps the quad everywhere.

**Check.**
- `validate-corona-tiles.mjs` (00_Training, 01_NYC_UNATCOIsland, 10_Paris_Club; 28 root frames, 18 of them on a render
  rectangle; 784 lights, the maps' corona skins Effects 127 and 129 and other sizes, DrawScale from 0.005 to 25, any hue,
  saturation and brightness; around seeded cameras in the view, across its edges and behind the eye): the loop reaches
  DrawIcon for exactly the 759 lights the port's `coronaIcon` draws (25 are behind the eye), with the port's X, Y, size,
  colour and PolyFlags 0x104 and Z 1.0 bit for bit on the real master frame; UCanvas::DrawTile receives the rectangle and
  the texture's size, reaches D3DDrv's DrawTile for 694 and clips 65 away exactly as the port does; the 694 tiles' **2,776
  vertices** (X, Y, depth, RHW, both texture coordinates, placed by SetTexture's slots) equal `iconVertices` bit for bit,
  every depth is 0 and every RHW 1; 201 are clipped at the left, 204 at the top, 200 at the right, 210 at the bottom, 104 at
  all four; 484 use the maps' skins, 41 are taller than wide. The GLSL on the GPU (headless Chromium, ANGLE GL on this host's
  AMD Radeon 780M) gives the same vertices, clipped rectangle and scaled source for all 694; without the barrier 43 differ,
  and `--mutate` (one bit of the port) fails the comparison.
- `validate-corona-tiles-play.mjs` (worker mode, headless Chromium, 1024 x 640, 02_NYC_BatteryPark's Light410 centred and
  with the view turned 1,900 either way; the frame frozen): the corona alone against the frame without coronas has its lit
  pixels (18,644, 18,471, 18,536) inside the reference tile (`iconVertices` from the icon and the frame's rectangle) and filling
  over 30% of it. With a probe texture (red first rows, green last rows) the first row is on top: red 19,537 pixels above the
  tile's centre and green 21,153 below, none reversed (the other views alike). **The flat overlay the page drew before drew
  every corona upside down** (the same probe: green above, red below), as the billboards drew the sprites: 16,173 of the
  corona's 18,644 lit pixels differ from the new tile (largest channel difference 31 of 255). The skin is not symmetric.
  The flat quad now flips V as well, and the validator asserts its probe is upright too (the Ship fan numbers below
  were measured with the old, upside-down quad).
- Against the original (the Ship fan view fan2, [visual acceptance](visual-acceptance.md#light-effects-against-the-original-2026-10-14),
  the stored capture of the original at TimeSeconds 52.397, Play at 52.398, 1280x720, `?spriteTiles=off` for the flat
  overlay): whole frame mean absolute difference 3.71 (3.72 flat), edge recall .980 and precision .975 (.970 and .968), 0
  outlier blocks in both. The 200 x 200 crop on Light33's corona: mean absolute difference 5.90 (6.11 flat), edge precision
  .999 (.988), the lowest block brightness ratio 1.01 (0.98). The uniform brightness ratio (1.28) stays outside this work.
- `validate-coronas`, `validate-coronas-play` (the placement of 1 icon still equals the master frame's) and the sprite
  validators stay green (`validate-sprite-tiles`: the same 864 sprites and 3,456 vertices on the CPU and the GPU after
  the GLSL split; `validate-sprite-tiles-play`).

**Not covered**, noted: the colour D3DDrv packs from the FPlane (Play keeps brightness times the hue colour, as the icon
carries it), texture LOD other than 0 and the render device's minimum LOD (assumed 0 as for sprites), the blend state D3DDrv's
SetBlending picks for PolyFlags 0x104 (Play keeps the canvas's translucent blend, ONE and INVSRCCOLOR), and a camera window's
coronas, which stay flat tiles in the window's own frame (its world keeps the camera's projection too).

## Lights behind a mover's fragments (2026-10-14)

09_NYC_ShipFan, the view fan2 of the light-effects acceptance
([visual acceptance](visual-acceptance.md)): the player at (236, -238, -55) (the
eye 40 above, at (236, -238, -15)), yaw 25298, the level held. The original
hides the coronas of Light34, Light35 and Light36 and draws Light33's; Play drew
all four (10 outlier blocks). Light34 and Light35 sit 2.6 units from a
DeusEx.Lightbulb, which first suggested the bulb's collision; it is not the
cause.

**What the original does** (`tools/dx-live-win.c trace`, a `call` breakpoint on
`ULevel::SingleLineCheck` 0x1039aed0 with the Hit read at the return; the helper's
two call sites return to 0x10b1bc61 and 0x10b1bcb2; a level held at dilation
0.001 and unfrozen for two ticks, `call-frames` for the renders between them).
Each frame the helper makes 11 first checks (TRACE_Level|TRACE_Movers, from the
eye to the light) and 6 second ones (0x11), the same list as Play's (the start
leaf's permeating lights; Region.iLeaf is not moved by `set Location`). Six
first checks are clear. Five are blocked: Light60 by DeusExMover7, one light
by the static model, and **Light34, Light35 and Light36 by the level model**
(Hit.Actor LevelInfo0, Time 0.356, 0.282 and 0.411, Normal horizontal, Item
292, 1942 and 1959). Items 1942 and 1959 are past the map's 1,478 nodes:
they are the moving brush tracker's fragments ([brush tracker](brush-tracker.md))
of DeusExMover1 (48 polygons, at (32, 48, -304)), which sit in Level->Model as
ordinary solid nodes (in Play's tracker the same two segments hit DeusExMover1's
polygons 9 and 16, nodes 1813 and 1830). Light34's hit names static node 292
as the boundary; the walk ends in solid only through the fragments. The
original's DLL on the map file's static BSP finds all four segments clear
(`native-collision-oracle.py`, the same answer as Play's).

**What it is not.** The bulbs' cylinder is 1.6 by 2.15 in the original
(`dump-actor-win` on Lightbulb11 to 14: Radius 1.6, Height 2.1500001, flags
0xf) and in Play. The class default is 2.9, and `Actor.PreBeginPlay` (Engine,
`Actor.PreBeginPlay`: a Decoration or Inventory with CollisionHeight above 0.75
is `SetCollisionSize(CollisionRadius, CollisionHeight - 0.75)`) shortens it. The
lights are 0.38 below the 2.15 cylinder's bottom, so the segment never enters
it; the earlier reading (a light 0.37 inside a 2.9 cylinder), and the
reversal of the trace's direction it led to, were wrong. The direction
stays as established above (Start the eye, End the light).

**Fix.** The helper's first line check runs over `Level->Model` as the tracker
left it for the frame, which is what mesh lighting's SetupForActor already
reads (`bsp-occlusion.mjs lineModel`, [mesh lighting](mesh-lighting.md)
"LineCheck and the brush tracker"): `createLevelQueries().lineCheck(..., worldModel)`
runs SingleLineCheck's MultiLineCheck with that model for the world part and
the level's hash for the actors, and `createCoronaScan`'s `lineModel` hands
it the tracker's model (sim-host.mjs `occlusionNow`). The scan's first check
goes through the validated `coronaLineVisible`; it reports the lights it passed
(`seen`).

**Check.**
- `validate-coronas-tracked.mjs`: the 11 measured segments through Play's
  tracked model against Engine's unchanged UModel::LineCheck under Unicorn on the
  same level and movers (`native-tracked-linecheck-oracle.py`, now returning the
  FCheckResult): the decisions, nodes, Time, Location and Normal of every
  segment equal the DLL's at the game thread's control word 0x037f, and every
  decision and node at 0x007f (below); Light34's hit is the measured one (node
  292, Time to the bit from the DLL at 0x007f), the five clear ones are clear and
  the blocked ones blocked; the corona scan over the tracked model is offered 11
  lights and passes 6, over the static model it passes 9 (Light34 to 36 too).
- `validate-coronas-mover-play.mjs`: in the browser in worker mode, at that view
  and with the level held as the capture does, `coronas()` shows 11 offered, 6
  passed (Light44, 38, 37, 33, 31, 10), Light34 to 36 and Light60 hidden. It fails
  without the sim-host wiring (9 passed).
- The fan2 matched capture (`scripts/original-views.sh` and `visual-acceptance.mjs
  play`/`compare`, the original under the shared Wine lock, both clocks at
  TimeSeconds 52.397, 1280x720): Play draws Light33's corona and the two small
  bulbs only, as the original does; 0 outlier blocks (10 before), mean absolute
  difference 3.74 (6.17), edge recall 0.959 and precision 0.966 (0.861 and 0.684).
  The uniform brightness ratio (1.28) stays outside this work.

**Open.**
- The corona pass runs at the render pass's 24-bit control word (0x007f); the
  tracked ray (ray.mjs traceRayFast) models the game thread's 0x037f. At 0x007f
  the DLL's Time differs from it by one ulp in 3 of the 5 hits (Light34's measured
  Time is the DLL's at 0x007f). The decisions and nodes agree on all 11
  segments, which is all the helper reads; a 24-bit ray is not done.
- Play's collision, AI and decal traces still use the static model
  ([brush tracker](brush-tracker.md) "Collision"); in the original they see
  the same fragments. Only mesh lighting and the coronas read the tracked one.
- Light33's corona itself differs slightly from the original's at its centre
  (a coloured fringe in the difference image); not examined. Drawing the corona
  the right way up ([above](#on-the-tile-chain-2026-10-15)) lowered the crop's
  mean absolute difference from 6.11 to 5.90; the rest of the fringe is not
  explained (the colour D3DDrv packs, or the display ramp, are the candidates).
