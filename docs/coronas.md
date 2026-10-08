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
   - **Level and movers.** `SingleLineCheck(Location → frame origin,
     TRACE_Level|TRACE_Movers)` must be clear.
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
| Coords.Origin, the line checks' end | `+0x34` | helper `0x10b1bc43` (`lea edi, [esi + 0x34]`, pushed before each `SingleLineCheck` call at `0x10b1bc5b` and `0x10b1bcac`) |

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
- **Visibility.** It visits the lights permeating the player's leaf. Model
  references resolve to live actors by export name, and the two line checks
  are Play's translated SingleLineCheck (`level.hash.lineCheck`), ending at
  the frame's origin.
- **Draw.** Each live entry's `coronaIcon` is computed with the frame the
  pass reads (above): the master frame's words, `visibility().master` of
  the same main frame, so the line checks end at its Coords.Origin and the
  icons are in the drawing buffer's pixels (X is the render rectangle's
  width in device pixels; before 2026-10-08 the scan used CSS pixels and
  `fx2 / Math.tan(fov * pi / 360)`). A session without OccludeBsp builds
  the fields with `coronaFrameFromCamera`. The tile is drawn in an
  orthographic overlay over the render rectangle with the canvas's
  translucent blend (ONE, INVSRCCOLOR); the display ramp maps the finished
  frame.
- **Check.** `validate-coronas-play.mjs` looks up at a corona light from a
  start, in the default mode with the simulation in the worker
  (`placeProbe({lookAt})`; `--query sim=inline` runs it on the page). On 02_NYC_BatteryPark, Light410 is among 5 leaf lights, 3 are
  visible and 1 is drawn. On 03_NYC_Airfield, Light348 is among 13 leaf
  lights, 7 are visible and 4 are drawn. In both, the frame changes with the
  pass and the street lamp shows its glow. In worker mode it also reads the
  scan's icons with the inputs of their placement and the master frame's
  words (`deusExViewer.coronas()`), recomputes each icon's x, y and size
  with `coronaFrame` and `coronaIcon`, and requires the bits to match (1
  placement on BatteryPark, 4 on Airfield; `--dpr 2` too: X 2048).

What the frame change moves (`census-master-frame-pass.mjs`, 100 seeded views
per map, 1440x960, eight probe lights in front of each camera, the old frame
at the same size): at FOV 75, Play's default, Coords and Proj.Z are bit-equal
to the old ones and no icon moves; at FOV 90 appTan of the 24-bit argument
changes Proj.Z in every view and 280 of 800 probe icons on the Island (262 of
800 on Paris Club) move or resize by an ulp or more. Beyond that the scan now
reads the frame itself, in the pixels of the drawing buffer.

Host choices, noted:
- the clock is the host's;
- the leaf's dynamic lights (LeafLights) are not visited;
- the display ramp applies to the finished frame, after the tile blends
  ([lighting](lighting.md), "Display ramp").
