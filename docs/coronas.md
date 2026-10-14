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
     TRACE_Level|TRACE_Movers)` must be clear. The light's Location is
     Start and the frame's Coords.Origin End (below, "The frame"): the
     trace runs from the light to the eye, which decides lights inside a
     colliding actor (below, "Lights inside a colliding actor").
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
- **Visibility.** It visits the lights permeating the player's leaf and then
  its LeafLights (above): the moving-light candidates of the frame
  (`game.movingLights()`, with `VolumeRadius`), filtered by the master
  frame's ViewPlanes and through the map's BSP. Model references resolve to
  live actors by export name, and the two line checks are Play's translated
  SingleLineCheck (`level.hash.lineCheck`, through `coronaLineVisible`),
  starting at the light's Location and ending at the frame's origin (before
  2026-10-14 they started at the origin; see "Lights inside a colliding
  actor").
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
- **Camera frames.** A ViewportWindow's DrawWorld runs the pass on its own
  master frame (docs/script-window-viewport.md "Camera pass"): the same scan
  and cache, with the lights of the *player's* leaf, line checks ending at the
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

## Lights inside a colliding actor (2026-10-14)

**Finding.** In 09_NYC_ShipFan's `fan2` view (camera (236,-238,-55), pitch
-1850, yaw 25298), the original draws Light33's corona and only the bulbs
of Light34 and Light35; Play drew all three coronas. Each of Light33..37
(bCorona) sits within 3 units of a DeusEx.Lightbulb (bCollideActors,
bBlockActors, CollisionRadius 1.6, CollisionHeight 2.9). Light34 at
(-272.30,273.81,85.14) is inside Lightbulb12's cylinder at
(-271.79,274.31,87.67): 0.71 from its axis and 0.37 above its bottom cap.

**The original's rule.** Two recorded pieces of evidence decide it:

- The helper's SingleLineCheck runs from the light's Location (Start) to
  the frame's Coords.Origin (End): the table in "The frame" above
  (`lea edi, [esi + 0x34]` at `0x10b1bc43`). It agrees with the helper
  accepting a hit on the viewport actor: the eye lies inside the viewer's
  own cylinder, so a trace ending there hits the viewer whenever nothing
  else is hit first. A trace starting there would skip the viewer (a start
  inside on its axis, not heading inward).
- UPrimitive::LineCheck (`103d8af0`, [primitive
  collision](primitive-collision.md)) with a start inside the cylinder
  (radially `x² + y² - r² < 1`, strictly between the caps) returns a hit at
  time 0 when the horizontal movement dotted with the start's horizontal
  offset from the axis is below -0.1, and clear otherwise; the cylinder is
  then ignored for the rest of the segment. The native captures kept in
  `test/primitive-collision.test.mjs` show both branches (start (5,0,0) in a
  radius-10 cylinder: towards (-100,0,0) hit at 0, towards (100,0,0) clear).
  A segment that starts outside and ends inside hits at its entry.

So a corona light inside a colliding non-pawn actor is hidden by it exactly
when the eye lies horizontally inward of the light, across the actor's
axis. For Light34 the dot is -3.32: hidden. A light that is radially
inside by that test (up to `sqrt(r² + 1)` from the axis, 1.89 for a bulb)
but whose eye direction points outward is not hidden by its own bulb. The
"0.37 above the bottom cap" plays no part: from the light, the bottom cap
only bounds the segment's exit.

**Play's defect.** `corona-scan.mjs` called `level.hash.lineCheck(eye,
location, ...)`. That function takes Start first, so Play traced from the
eye to the light. The comment beside the call even said the checks end at
Coords.Origin. Traced that way, every light inside a bulb ends inside the
cylinder and hits it at the entry (Light34: time 0.997), whichever side the
eye is on. The cylinder test itself (`primitiveLineHit` and hash.rs) was
not wrong: it is the native-checked translation. `coronaLineVisible`
(coronas.mjs) now makes the two calls with the original's arguments, and the
scan uses it.

**Verified in this change.**
- `test/corona-line-checks.test.mjs`: coronaLineVisible's call order,
  arguments and acceptance. Through createLevelQueries (JavaScript and the
  Rust kernel), with Lightbulb12, Light34 and a viewer cylinder holding the
  eye: Light34 is hidden by the bulb at time 0, the same light mirrored
  through the bulb's axis is visible (its trace ends on the viewer), and
  from the eye the bulb would hide both.

**Not yet verified (requires the local DLLs and game data, absent from the
session that made this change):**
- `validate-coronas.mjs` now compares, per helper call, which pointers the
  original passes as End and Start (`frame + 0x34`, `light + 0x114`), their
  bits, TraceFlags, Extent, NodeFlags and Source with coronaLineVisible's
  (`native-coronas-oracle.py` records them). It has not been run. Source
  null, zero extent and NodeFlags 0 are Play's arguments until it runs.
- `validate-native-primitive.mjs` gained 46 directed cases
  (`shipFanBulbCases`): Light34 and Lightbulb12 in both directions; starts
  inside with horizontal dots from -5 to 5 around the -0.1 threshold; far
  starts entering through the bottom cap with the end 0.4 to 0.001 inside,
  on, or just below it; rays grazing the side at 1.59 to 1.61 from the axis
  on 750-unit segments, in both directions; and a viewer cylinder holding
  the eye. They have not been run against the DLL. Play's answers include
  two boundary results to confirm: an end exactly on the bottom cap leaves
  the caps unclipped (the short probe hits at 0.466, below the cylinder),
  and the 1.599 grazing ray is clear one way and hits the other (float32
  cancellation in the discriminant).
- The live Play session. The report from that session says Play's scan and
  a probe in it (`level.hash.lineCheck(start, end, [0,0,0], 0x11, 0, null)`
  from (bx+3,by,bz-15) to (bx,by,bz-2.5)) returned clear for that bulb. With
  the reported Location, radius and height, the same query path here
  (createLevelQueries, JavaScript and Rust) hits it at time 0.967, and eye to
  Light34 hits at 0.997. So the session's registration of Lightbulb12 (its
  `collisionValues ?? values` Location, CollisionRadius, CollisionHeight and
  hash cells) must differ from the map values reported. Read it in the live
  session before relying on the fix there.
- The fan2 comparison against the original (`visual-acceptance.mjs play
  --maps 09_NYC_ShipFan --view fan2:...`) has not been re-run, and Light33
  and Light35's own geometry has not been checked against the rule. The rule
  predicts Light35's eye direction points inward from its bulb's axis.
  Light33 is either not inside its bulb by the `C < 1` test (and its
  segment to the eye misses the cylinder), or its eye direction points
  outward.
