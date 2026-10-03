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

## Translation and verification

`src/runtime/coronas.mjs` contains `createCoronaCache`, `coronaDecay`
(clock and fade), `coronaFade`, `coronaSeen`, `coronaColor` and
`coronaIcon`, all on the x87 model.

`validate-coronas.mjs` runs the unchanged code (`native-coronas-oracle.py`):
- **Setup.** The fade loop, the helper with scripted SingleLineCheck answers
  and Engine's own GetActorIndex, and the draw loop with a recording
  DrawIcon.
- **Coverage.** 200 random frames with one to four lights (in front of and
  behind the eye), prefilled caches (stale indices and full caches included)
  and helper calls over every answer and gate.
- **Result.** All fades, cache updates (87 new entries) and 352 DrawIcon
  calls (every argument) match.
- **Stub.** The oracle answers 1 for `UObject::IsValid`, the entries'
  assertion.

## Play

`src/viewer/corona-pass.mjs` runs the pass after the main world draw, before
the first-person weapon and the HUD, matching DrawFrame ahead of PostRender.

- **Gates and fade.** It checks the player's Region, then fades the cache
  with the host clock.
- **Visibility.** It visits the lights permeating the player's leaf. Model
  references resolve to live actors by export name, and the two line checks
  are Play's translated SingleLineCheck (`level.hash.lineCheck`), from the
  view location.
- **Draw.** Each live entry's `coronaIcon` is computed with the view's
  exact frame coords: getAxes' Y, −Z and X, as for fog. The tile is drawn in
  an orthographic overlay with the canvas's translucent blend (ONE,
  INVSRCCOLOR); the display ramp maps the finished frame.
- **Check.** `validate-coronas-play.mjs` looks up at a corona light from a
  start. On 02_NYC_BatteryPark, Light410 is among 5 leaf lights, 3 are
  visible and 1 is drawn. On 03_NYC_Airfield, Light348 is among 13 leaf
  lights, 7 are visible and 4 are drawn. In both, the frame changes with the
  pass and the street lamp shows its glow.

Host choices, noted:
- the clock is the host's;
- the frame precomputes (FX2, FY2, `Proj.Z = FX2/tan(FOV/2)`, Frame.X) come
  from Play's canvas and the view FOV, not the original's resolution;
- the leaf's dynamic lights (LeafLights) are not visited;
- the display ramp applies to the finished frame, after the tile blends
  ([lighting](lighting.md), "Display ramp").
