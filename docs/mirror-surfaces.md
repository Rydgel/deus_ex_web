# Mirror surfaces

## Original contract, recovered before implementation

The installed `00_Training.dx` (SHA-256
`bb66d95aafc6aae4179f8444e98661f3d5d27dab06d13d7dde7f4b5f4e24068d`)
has 46 mirrored BSP surfaces. All have flags `0x08840004`, including
`PF_Mirrored=0x08000000` and `PF_Translucent=4`, normal `(0,0,1)`, and
Z in `-128,-144,-160,-176`. The entrance floor is Z=-128. The mirror
comes from the compiled model, not from material gloss or a guessed strength.

Authority is the local original DLLs, not another engine implementation:

| Binary | SHA-256 |
| --- | --- |
| Render.dll | `607f1077c5cd3e25f8a4cde1ffacf4cf9260aebc92a72be40721cd6955bd75d1` |
| Core.dll | `8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4` |
| D3DDrv.dll | `9e0f8a4293de6edb4f88b1ba9972fe98b4e80a1115f9667e57f8ef3d51d8ac9f` |

`URender::OccludeBsp` at `0x10b1886d–0x10b18b93` checks the mirror
flag, limits child-frame depth to below 3, checks viewport actor flags at
`+0x5fc` bit `0x800`, and checks render-device field `+0x5c` for translucent
mirrors. `+0x5c` is `ShinySurfaces` (see "All maps" below); the name of the
actor field is not yet established, and the browser's normal view takes the
enabled path. The disabled-device path clears translucency and sets
`PF_Occlude=0x80000000`.

The enabled path reflects the camera Origin across the node's world plane and
each of its three axes across the plane normal. With unit normal N and plane
equation `dot(N,P)=W`, these are `P'=P-2N(dot(N,P)-W)` and
`A'=A-2N dot(N,A)`. It preserves all three reflected axes, reversing handedness;
rebuilding a right-handed look-at camera loses that reversal. It negates
`FSceneNode.Mirror` (`+0x20`) and supplies the negative plane transformed into
the parent view as NearClip. Geometry on the original viewer's side of the
mirror survives. The child receives the surface span buffer and screen bounds.
`CreateChildFrame` (`0x10b15a40`) merges matching child frames, including exact
clip-plane equality. `DrawFrame` (`0x10b1a336–0x10b1a348`) draws children before
the parent. The translucent mirror face then gets `PF_Occlude` at `0x10b18b87`.

`UD3DRenderDevice::SetBlending` (`0x10008270`) selects, for Translucent:
render states `(27,1),(19,2),(20,4)` at `0x10008349–0x100083e1`: enable
blending, `D3DBLEND_ONE`, `D3DBLEND_INVSRCCOLOR`. `PF_Occlude` enables depth
writes via state `(14,1)` at `0x10008427–0x10008438`. Thus the texture/lightmap
source S composites over reflected destination R as **S+R(1-S)** per channel.
There is no extra reflection opacity, Fresnel term, blur, or roughness factor.
This happens in the original display-encoded framebuffer, before the display
gamma ramp. See [lighting](lighting.md) for that separate ramp.

## Original references

`scripts/native-mirror-oracle.py` executes unchanged Render.dll instructions
`0x10b188ce–0x10b18b55`, with original Core.dll vector/coordinate operations,
and reads the actual CreateChildFrame arguments. It also executes the complete
D3D SetBlending body, recording calls to a COM device stand-in (only the device
call is stubbed). `scripts/validate-mirrors.mjs --reference-only` records 12
frames (three camera orientations, the four actual Training planes) and blend
traces before the browser implementation. Camera inputs are float32 fixtures
derived from the saved positions/orientations, not a claim about native rotator
trigonometry. Original results stay in `.cache/stage4-mirror-original.json`.

The existing original-game capture `reports/lighting/start/native-frame.png`
establishes visible entrance-floor reflections
at the saved player eye `(-1149.24353,825.84393,-40.2)`, HFOV75, 926×603.
The user also supplied a native entrance screenshot with the emblem, door,
pillars and plants reflected in the floor. Assets and captures remain outside Git.
The saved side-view capture has a darkened "Saving" overlay and is **not** a
brightness acceptance reference. The game's Shot bitmap and native window
capture also differ in presentation; comparisons below use the native window
as in the existing lighting work.

## Browser translation and checks

`viewer/mirrors.mjs` groups supported coplanar faces, renders a full-resolution
reflected view, and clips against the original world plane. It preserves the
reflected matrix's negative determinant. For WebGL submission it negates the
child camera's local X axis and samples the target right-to-left; those two
screen-space reflections cancel, preserving the original view without changing
material culling state between child and parent draws. Marker overlays, HUD and first-person weapon draws are outside the
child. Actor geometry/UVs use the reflected eye and restore the parent eye after
the pass. One global clipping-plane shader shape stays active across both child
and parent submissions; the parent uses a zero normal, while each child receives
the original mirror plane. This avoids changing every material's three.js
program variant without changing clipping. Original textures and lightmaps use the same display-encoded colours
in the target as on screen; Three's default linear render-target output cannot
be used for this legacy blend. Gamma is 1 during the child draw. The floor
shader computes S+R(1-S), then applies the configured display gamma once and
writes depth. No opacity or exposure was fitted to the screenshot.

`node scripts/validate-mirrors.mjs` compares the actual adapter with the original
12 frames and clip planes, verifies handedness, the 46-surface census, and both
blend-state traces. Build and 16 existing lighting/render-data tests pass.
`browser-tests/lighting.spec.mjs` passes with both saved camera orientations,
brightness/lighting controls and authored unlit surfaces preserved.

At the saved entrance view, browser identity gamma versus the native window
capture gives mean absolute RGB error **3.328/255** for floor region
`[350,360,610,525]` and **5.281/255** for the reflected emblem region
`[440,462,490,511]`. Rectangles exclude HUD and plant meshes. The reflected
emblem's location, doorway and pillar boundaries align visually. These regional
measurements establish the restored reflection, not pixel-equivalent lighting.
`browser-tests/mirrors.spec.mjs` records the local captures/comparison under
`.cache/mirrors/` and checks clipping with geometry behind the mirror plane,
resizing and render-state restoration. All checks passed, including the native
capture comparison (3.756/255 floor, 5.594/255 emblem in that run). The visual
comparison requires the local native capture; without it the test annotates its
absence and runs only the integration checks. These tolerances accommodate the
existing static/moving-light reconstruction differences, not a reflection-strength
adjustment.

## Scope and unresolved branches

This slice targets static, upward-facing horizontal Translucent mirrored BSP
floors, including Training's four authored heights. Moving mirrors, nonparallel
recursive mirror views, portal/sky combinations and other mirror material modes
are not verified here (wall, mover and nested mirrors: see "All maps" and
"Wall mirrors against the original"). Original BSP span visibility and child merging are not
yet reproduced by the browser's depth-buffer renderer. Existing mesh lighting,
plant texture and lightmap precision differences remain separate fidelity gaps.
Do not treat this slice as complete Stage 4 acceptance.

## All maps (2026-10-02)

The shipped single-player maps have 211 mirrored static BSP surfaces in 49
maps. By orientation and treatment:

| Orientation | Composited (`flags & 0x47`) | Opaque |
| --- | --- | --- |
| Up (floors, Training's 46 among them) | 110 | 1 |
| Vertical (wall mirrors) | 84 | 13 |
| Down | 1 | – |
| Oblique | 2 | – |

Thirteen mover brushes also carry a mirrored polygon. Most are cabinet or
wardrobe doors.

**Plane.** OccludeBsp reflects across `[ebp-0x1c]`, the FBspNode, whose first
16 bytes are its FPlane. `mirrorPlanes()` in `viewer/mirrors.mjs` reads that
plane for each mirrored surface. All 211 surfaces have exactly one node plane,
giving 80 distinct planes across the maps (117 counted per map, because
repeated maps share them). The browser groups surfaces by the exact node
plane. CreateChildFrame also compares the plane exactly, but it requires the
same surface and zone as well (see "Coplanar mover polygons", child
merging). The reflection itself (`MirrorByPlane`/`MirrorByVector`) has no
orientation case.

**After the child frame.** `10b18b58–10b18b93` decides how the parent draws the
mirror surface. `[ebp-0x30]` holds `flags & 0x47`
(Invisible|Masked|Translucent|Modulated, set at `10b182d9–10b182de`) and
`[ebp-0x4c]` holds `Viewport->RenDev` (`Frame->Viewport+0x64`, at
`10b17489–10b174a0`).

- A composited mirror keeps its flags plus `PF_Occlude`.
- Otherwise, if `RenDev+0x48` is set, the code takes `10b19a53`.
- Otherwise the surface also becomes `PF_Invisible`: the parent draws nothing
  there, and the reflected child shows unmodified.

Engine's `URenderDevice::StaticConstructor` (`103713c0`) registers its config
properties at `+0x58` VolumetricLighting, `+0x5c` ShinySurfaces, `+0x60`
Coronas, `+0x64` HighDetailActors, `+0x38` Description, `+0x44` DescFlags and
`+0x78` DetailTextures. Those offsets match the SDK header's whole-DWORD
fields, which places `SpanBased` at `+0x48`. SpanBased is not a config
property, and no instruction in D3DDrv.dll writes `+0x48`, so on D3D it stays 0.
The shipped `Default.ini`/`DeusEx.ini` set `ShinySurfaces=True` for
`D3DDrv.D3DRenderDevice`.

`scripts/native-mirror-oracle.py` now also executes `10b18b58–10b18b93` for
every mirrored flag word in the maps, statics and movers alike.
`mirrorDrawFlags()` matches it, giving `flags|0x80000000` when
`flags & 0x47` is set and `flags|0x80000001` otherwise. The frame cases cover
3 cameras × the 80 map planes as well as Training's 12. The oracle's stack
now starts below the segment's deepest local (`ebp-0xd94`); before, pushes
from `ebp-0x400` could overlap locals. Adapter comparisons allow 4 float32 ulps
of the largest magnitude involved, because the original computes in float32
and the adapter in doubles. The Training frames still match within the old
absolute bounds.

**Browser.**

- **Static surfaces.** Static mirrored surfaces of every orientation
  render their plane's reflected child.
- **Composited mirrors** draw S+R(1−S) as before. **Opaque mirrors** draw R
  alone, with depth written as PF_Occlude.
- **Children first.** Every visible plane's child renders before any mirror
  shows its reflection, and each child hides only its own plane's faces.
  Children nest; see "Wall mirrors against the original".
  `mirrors.enabled = false` is a diagnostics switch that draws every
  mirror without its reflection.
- **Checks.** `scripts/validate-mirrors-play.mjs` faces the 02_NYC_Bar
  translucent wall mirror and the 02_NYC_Hotel opaque unlit bathroom mirror.
  It checks that a child renders, that the frame changes with the reflection
  and that no runtime error occurs. The Training spec still passes against the
  native capture. With the current static lighting it gives 2.04/255 for the
  floor region and 3.87/255 for the emblem.

**Mover mirrors.**

- **Groups.** A mover's polygons join the level BSP through the brush tracker
  (`0x1037b5c0`) whenever the brush moves, so a mirrored mover polygon
  reflects across its own world plane. Each such polygon is its own group
  (thirteen movers carry one).
- **Plane.** The group's plane is the brush-local `[N, N·base]` node plane
  under the mover's current transform, recomputed before every mirror pass.
  The tracker's exact float32 node plane is not reproduced: this plane is
  host-computed in doubles. The reflection itself is the verified one.
- **Check.** `validate-mirrors-play.mjs` faces 02_NYC_Smug's DeusExMover7
  (translucent): both of that map's planes render, and the frame changes
  with the reflection.

**Unsupported, explicitly noted in Play.**

- **Masked, modulated and two-sided mirrors** (none in the shipped maps) are
  likewise drawn as ordinary surfaces.
- **Opaque mirrors on a span-based device.** The `+0x48` SpanBased path is a
  software-renderer branch and is not translated.

## Wall mirrors against the original (2026-10-02)

**Captures.** The original game ran in the CrossOver bottle with the
exact-camera pipeline (`ad/scripts/original-game.mjs`). The level was frozen
before `open` (`set LevelInfo bPlayersOnly True`), so Everett's opening
conversation never starts. The camera was a ghost one at eye = Location + 40,
with the HUD hidden. The Shot bitmaps stay outside Git in
`ad/captures/original/`:

- `mirror-11_Paris_Everett-*.png`: the small wall mirror (surface 388,
  Y=1660) and the standing mirror on DeusExMover2 (Y=1476), facing each
  other. Views are centred, turned 3°, 10° and 20°, and from the side.
- `mirror-03_NYC_747-c1..c3.png`: the galley floor mirror (Z=306), seen
  from the corridor through its doorway.

**Seam (browser bug, fixed).** The child target holds the reflection
right-to-left, so target column `x` is screen column `W−1−x`. The child's
scissor, however, was the mirror's screen rectangle set with
`renderer.setScissor`. That call takes CSS pixels and multiplies by the pixel
ratio, but the bounds are drawing-buffer pixels, so it was wrong twice. It
was not mirrored, and on a pixel-ratio-2 display it was scaled twice.

The child was cleared and drawn only inside that rectangle. The columns the
composite samples outside it kept whatever an earlier frame had left there,
so the mirror showed two viewpoints split by a seam. Off-axis views showed
this at any pixel ratio, and on Retina even centred mirrors did. A view
where the misplaced rectangle happens to cover the sampled columns looks
correct, which is why the check below places the mirror at the screen's
left edge.

The scissor is now the target's own (`target.scissor`, in target pixels),
over columns `[W−x−w, W−x)`. The Everett and 747 views then match the
original captures (one continuous reflection) and no longer depend on
earlier frames.

**The player in reflections.** The original draws the first-person player in
a mirror's child frame. The frame pass `0x10b19fc0` passes SetupDynamics an
excluded actor computed at `0x10b1a161–0x10b1a18e`: none when the viewport
actor's `bBehindView` (`+0x318` bit 0) is set, or when `Frame->Parent`
(`+0x8`, per the SDK's FSceneNode) is non-null; otherwise the ViewTarget, or
the view actor itself. The pass then recurses into `Frame->Child` and each
`Sibling` (`0x10b1a267–0x10b1a27c`). SetupDynamics' own ViewTarget rejection
applies only at Recursion 0 ([render visibility](render-visibility.md)).

The capture agrees. Standing in front of Everett's wall mirror, JC is
visible; with `bHidden True` he is gone. In ghost mode he shows half sunk in
the floor, because `CheatFlying` poses him and the eye height set his
Location.

**Browser.**

- **Admission.** On a map with mirror groups, the actor layer also admits
  actors that only child frames draw (`drawnInWorld(..., child)`).
- **Per pass.** When a mirror may render, such an actor is posed and lit
  with the main frame. It is shown in each child pass and hidden in the
  main pass (`passVisibility`).
- **Lighting.** Like every actor in a mirror pass, it reuses main-frame
  lighting, not a per-frame light setup. This is an approximation.

**Checks.** `scripts/validate-mirrors-play.mjs` now renders at pixel ratio 2.

- **Everett off-axis.** It views Everett's standing mirror at the left of
  the screen after filling every child target with magenta at near depth,
  and requires no magenta pixel in the mirror. Served the previous
  `mirrors.mjs`, the same case fails with 27.7% of the mirror still magenta.
- **Hotel player.** In the Hotel bathroom, hiding the player changes 0.96%
  of the frame with reflections on and 0% with them off.
- **Training.** The Training spec still gives 2.04/255 for the floor and
  3.89/255 for the emblem.

**Nested reflections.** At `0x10b18881` OccludeBsp takes the mirror path
only while `Frame->Recursion` (`+0x1c`) is below 3. CreateChildFrame sets a
child's Recursion to its parent's plus one (`0x10b15e4a–0x10b15e5c`).
Children therefore nest to recursion 3, and a mirror inside a recursion-3
frame is an ordinary surface. In the Everett wall-mirror view, the original
shows the standing mirror inside the reflection with its own reflection: the
far wall, its table, JC, and the wall mirror again, dark at the limit.

The browser now builds the same tree (`MIRROR_RECURSION_LIMIT`):

- **Order.** A frame's visible mirror groups each get a child frame, drawn
  before the frame itself, as DrawFrame does. The child's camera is the
  frame's true camera reflected across the group's plane, and the child
  hides that group's faces and clips at its plane.
- **Handedness.** Each level reverses handedness again, so only odd depths
  negate the submitted X axis. Every child target is then mirrored against
  its parent's pixels, and the composite's right-to-left sample is correct
  at every depth.
- **Region.** A child's region is the group's bounds in its parent frame,
  intersected with the parent's own region, then mirrored. This stands in
  for the original's span buffer: it is a rectangle, so it is never smaller
  than the spans.
- **Targets.** Render targets are pooled by depth and sibling index. A
  frame's children are all sampled by its own draw, and each child's
  descendants are done before that child draws.
- **At the limit.** A recursion-3 frame draws its mirrors without a
  reflection: the surface's S, written opaque. The original blends a
  Translucent surface over whatever its framebuffer holds there. That
  matches only if the region is black, which is unverified.

In the Everett wall-mirror and standing-mirror views, the browser now shows
the same nesting as the original captures; JC differs only because the
inspect camera stands where the ghost capture's player was. The validator's
Everett case renders four child passes to depth 3, all covered by the
magenta check.

**Cost.** At the Everett views the browser now draws 4 child passes, where
it drew 2 at depth 1. Measured headless (Metal ANGLE, 1280×720, inspect
camera, medians of six interleaved 60-frame rounds):

| Nesting | Draw calls per frame | Host mirror phase, reflections on − off |
| --- | --- | --- |
| Depth 1 | 61 | 0.46–0.60 ms |
| Depth 3 | 134–140 | 0.65–0.80 ms |

GPU time was not measured.

**Seen while comparing, outside this work.** Some actors the original draws
are absent from the browser's inspect camera: the 747 galley's liquor
bottles and cup, and an object at the right edge of Everett's 10° view. The
cause was not investigated.

## Coplanar mover polygons (2026-10-02)

**Report.** In 00_Intro's VersaLife room the mirrored floor showed hard
horizontal bands under BobPage0 and WaltonSimons0, alternating between
"mostly reflection" and plain floor. The original shows a smooth floor.

**Cause.** DeusExMover0 (Location `(0,-2896,-128)`, a TriggerToggle panel
with `KeyPos[1]=(0,-304,0)`) is a 96×320×16 box. Its top polygon has the
floor's texture and flags `0x08800004` (Translucent|Mirrored). At the placed
position it lies exactly on the level floor, surface 7 at Z=−128. The
browser drew both, and depth ties between two triangulations of one plane
z-fought. Where the mover won, its composite S+R(1−S) showed the reflection
almost alone: its S is black in the browser, because its light map has no
light list (`LightActors −1`) and the zone the browser picks for it has no
ambient.

These checks located it:

- Hiding DeusExMover0 removes every band.
- With `world.mirrors.render` skipped, the bars stay black. That is the mover
  face's own S, because `active` stays 0 when `render()` never runs. A stale
  child target was never involved.
- The clip plane and the child pass are not involved either. In a child
  frame, both up-facing polygons face away from the reflected eye and are
  culled.

**Original.** Engine.dll (the brush tracker) and Render.dll (OccludeBsp) give
the static polygon priority:

- **Filtering.** Tracker::Update (`0x1037a400`) filters each mover polygon
  into the level BSP. It calls `0x1037c0c0` with (iSurf, iNode 0,
  iCoplanarParent −1, poly, Outside 1).
- **Coplanar test.** `FPoly::SplitWithPlane` (`0x10386ad0`) classifies the
  vertices against ±0.25 (doubles at `0x1042d518`/`0x1042d528`). If every
  vertex is within that band, the polygon is coplanar. When it also faces
  the same way (`dot(normal, node normal) >= 0`, `0x1037c21e`), that node
  becomes iCoplanarParent and filtering continues on the front side.
- **Chain order.** `0x1037bb00` adds each surviving fragment. It walks the
  coplanar parent's iPlane chain (`+0x28`) to its end (`0x1037bb5d`) and
  links the new node there (`0x1037bf66`).
- **Span claim.** OccludeBsp processes a node, then its iPlane chain in
  order (`0x10b19a53`). At `0x10b182d9–0x10b18337`, some surfaces clip their
  raster through `FSpanBuffer::CopyFromRasterUpdate` (`0x10b21a90`, by
  export name), which also fills the zone's screen span buffer. These are
  surfaces with no `flags & 0x47` bit, Invisible|Portal (`0x4000001`)
  surfaces, and mirrored surfaces. Other non-occluding surfaces use
  `CopyFromRaster` (`0x10b21df0`).
- **No spans left.** A polygon with no spans left gets node flag 8 and is
  skipped (`0x10b18376–0x10b1838b`). This happens before the mirror path, so
  it creates no child frame.

So the level polygon, earlier in the chain, claims its spans first, and a
mover fragment appended to that chain gets none of those spans.

An analysis replay of that filter for 00_Intro (doubles, not a translation)
splits DeusExMover0's top face into 8 fragments. Each one is appended to the
chain of a surface 7 floor node that covers it (5135, 5204, 5221 or 5236).
The strip over the stairwell (Y −3056 to −3040) lands in solid and is
dropped. At the placed position, the original therefore draws none of the
mover face.

**Browser.**

- **Offset.** Every mover surface material sets `polygonOffset` (factor 1,
  units 1). This moves its depth away from the eye just enough to lose a
  depth tie, and changes no other winner.
- **No sharing.** Mover materials get their own cache key (`:mover`), so a
  static surface never shares the offset.
- **Why not a stencil.** A stencil mask cannot express "lose only at equal
  depth" without plane-specific IDs that change as movers move.
- **Limits.** Ties between two mover polygons stay unresolved. At a
  mover/static intersection line, the offset can move the line by about one
  depth-slope step.

**Scope.** At their placed positions, 164 mover polygons on the shipped maps
(DXMP included) are filtered into a static coplanar chain whose polygons
overlap them by bounding box. Four of them are mirrored: DeusExMover0 in
00_Intro and in 99_Endgame1–3. They all get the same treatment.

**Checks.**

- **Intro, oblique view.** Eye `(-40,-3000,120)`, rotation
  `(60000,16384,0)`, 1280×720. The bands are gone. With NPC meshes hidden,
  the frame is pixel-identical to one with DeusExMover0 hidden.
- **Intro, against the original capture.** The capture is
  `ad/captures/original/intro-walkway-oblique.png`, with exponent 1/1.5
  applied. Mean absolute RGB error in three floor regions inside the
  mover's rectangle fell from 22.2, 30.9 and 20.4 to 9.9, 11.2 and 10.6 per
  255. A floor region outside it stays at 7.96.
- **Intro, top view.** Eye `(-40,-2740,250)`, rotation `(51536,16384,0)`.
  The red rectangle the mover drew is gone, as in `intro-walkway-top.png`.
- **Training.** The entrance view is pixel-identical before and after. The
  Training spec gives 2.04/255 for the floor and 3.87/255 for the emblem.
- **Validators.** `validate-mirrors.mjs`, `validate-mirrors-play.mjs` and
  `npm test` (595) pass.

**Open.**

- **Mover light-map zone.** The browser lights a mover from
  `pointZone(brush centre)`, zone 0 for DeusExMover0. The tracker gives a
  fragment node its parent's iZone (`0x1037bcf4–0x1037bd32`). Which zone
  SetupForSurf takes the ambient from is not traced. It matters once the
  panel slides over the stairwell, where it draws its own composite.
- **Extra child pass.** The browser still renders a child for the hidden
  mover group. It tests the frustum, not span visibility, so this view takes
  2 child passes where the original creates 1. This is the span-visibility
  gap noted under "Scope and unresolved branches".
- **Child merging.** CreateChildFrame (`0x10b15a40–0x10b15ae9`) reuses a
  child only when all of these equal its arguments: Level (`+4`), Parent
  (`+8`), iSurf (`+0x14`), ZoneNumber (`+0x18`) and the four NearClip
  floats (`+0x24`), per the SDK's FSceneNode. OccludeBsp's mirror request
  passes **iSurf 0** (`push 0x0` at `0x10b18b4a`), whatever the surface, so
  it merges *every* mirror request of one parent in one zone on one plane,
  different surfaces included ([merged requests](#merged-mirror-requests-2026-10-14)).
  The browser's per-plane groups for static surfaces are the same. Across
  zones, the original's separate children may see different portal
  traversals, and it may draw more child frames than the browser (a static
  plane group reflects through whichever of its frames came last).
- **Shadow blobs.** The original shows soft shadow blobs under pawns. These
  are Shadow decals attached through AttachDecal. The runtime attaches them
  (`runtime/script-decal.mjs`), but the viewer has no decal draw pass.

## Merged mirror requests (2026-10-14)

**Report.** In 06_HongKong_WanChai_Underworld's club, three one-way panes beside
the dance floor reflected the room only in one of them; the other two showed
their own flat cloudy texture, and which one reflected changed with the view
(the user's screenshots: the middle pane reflects with the dancers, the two
side panes grey).

**Surfaces.** BreakableGlass0, 5 and 17 are three movers at (-1216, -1024,
-832; -2056, -320), each a 128 x 128 pane brush with 8 polygons. Polygon 1
is the dance-side face: flags `0x08400028` (Mirrored | Unlit | NotSolid |
Semisolid, no Translucent/Masked/Modulated, so an opaque mirror), normal
(0, 1, 0), brush-local y 2, world plane y = -2054, facing the dance floor.
Polygon 3, at brush y -2 (world -2058), is `0x0040012c` (Unlit | TwoSided |
Semisolid | NotSolid | Translucent, normal +Y), presumably the window the office
side looks through (not traced). From the office the mirrored face is a back
face: five views there request no mirror at all. The three mirrored polygons
are three surfaces on one plane.

**Original.** OccludeBsp's mirror request passes iSurf **0** to CreateChildFrame
(`0x10b18b4a`, `push 0x0` before `call [esi+0x68]`; the other arguments are the
parent frame, the span, Level, the zone, `-Frame->Mirror`, the reflected Coords
and the clip plane). CreateChildFrame merges a request into a child of the same
parent with equal iSurf, ZoneNumber and NearClip (`0x10b15a40`). The three
requests have one plane (equal NearClip) and one zone, so they make **one** child
frame: its span is the union of the three polygons', and it is drawn once. Each
polygon's draw-list entry then has `PF_Invisible | PF_Occlude`
(`0x10b18b58`..), so the one reflected image shows through all three. The
mirror requests' nodes are not CreateChildFrame arguments; the frame's
request list is the Rust core's record of which requests the original's calls
merged. `scripts/validate-child-frames.mjs` compares every request's frame with
what the original's CreateChildFrame returns (the Unicorn oracle reads `eax` at
each call's return): 00_Training 279 requests in 55 frames, 02_NYC_Bar 34 in 18,
11_Paris_Everett 84 in 23, all equal.

**Play before.** The simulation side reported one depth-1 mirror frame and the
frame's first request, in the BSP's front-to-back order (the order changes with
the view). `planFramePasses` planned one pass through that request's group, so
only that pane's group got the reflected child; the other two drew their own
texture. Static mirrors do not split this way: a static plane is one group, the
frame's request node picks it, and every polygon of it reflects. A mover
polygon is its own group, so only mover mirrors on one plane can split.
A sweep in worker mode (105 views from 15 dance-floor positions, 7 yaws each,
ghost, the level frozen): 200 pane requests, 103 of them drawn grey; one
child frame in every view with any request.

**Fix.** The frame record keeps every merged request's node (`FR_REQ_HEAD`,
`frames[].requests`); the session names each one's tracked mover polygon;
`frameGroups` (mirror-passes.mjs) gives all the groups the frame looks through
and the pass reflects through the first (the plane is the same) while every
group takes the child's target (`mirrors.mjs` draw) and hides its meshes in the
child pass. The sweep after: 200 of 200 requested panes draw the reflection,
no change in requests or frames.

**Original at the same views.** Frames from the original (Wine, the exact-camera
pipeline, level frozen and held at 46.828 s; `scripts/original-views.sh`) against
Play's at 46.829 s, 1280 x 720, raw framebuffers
(`visual-acceptance.mjs compare`):

| View (eye = Location + 40; yaw) | Play before: mean abs. diff, edge recall / precision | Play after |
| --- | --- | --- |
| a (-1024, -1650, -336; 49152), the report's | 13.21, .831 / .612 | 2.46, .995 / .992 |
| b (-1300, -1650, -336; 52000) | 9.01, .938 / .779 | 2.72, .998 / .994 |
| c (-760, -1400, -336; 46000) | 5.45, .853 / .970 | 4.08, .981 / .990 |
| d (-1120, -1900, -336; 55000) | 5.10, .647 / .803 | 4.76, .646 / .800 |

The original reflects in every pane at all four views. View d does not
improve: both sides reflect in both panes in view, but the original's reflected
floor and dancers are lit (olive floor) where Play's are dark red. **Cause
found 2026-10-14: not the panes and not a mirror-frame lighting defect, the
Strobe phase of a frozen capture**, a host input that alternates every drawn
frame in both programs (Render.dll `0x10b05b30`; the club's TriggerLight1 lights
that floor). With the flag held equal on both sides view d is at 2.67 (flag 0,
lit) and 1.73 (flag 1, dark) mean abs. difference, edge recall .98 / .99, no
outlier block, and the original's own dark frame is Play's dark frame:
[Divergence 19](visual-acceptance.md#divergences-found), `scripts/validate-strobe-mirror-play.mjs`.
Views a to c carry the known uniform brightness gap (Play over original 1.17 to
1.20).

**Persistence.** A report said the grey panes appeared after the player went
into the office and came back. A visit does not change anything: five dance-side
views before and after a visit to three office positions give the same
requests, frames and reflecting panes (and the panes are grey on a fresh start;
`validate-underworld-panes-play.mjs`). What differs by view is which request
comes first.

**Checks.** `scripts/validate-underworld-panes-play.mjs` (worker mode) looks at
nine views (one, two and three panes requested, each pane first in some view):
every requested pane is in the one depth-1 frame and draws the reflected child,
before and after the office visit. It fails without the fix (the first view:
only BreakableGlass5 draws the reflection of the three requested). `test/
mirror-frame-groups.test.mjs` covers `frameGroups` and the plan.

**Not checked.** A zone boundary between two coplanar requests (two frames):
the page maps both frames to the same static group, which takes the last
child's target; read from the code, not seen in a map.

## Firefox spot survey (2026-11-06)

**Why.** The Paris Club's drop to about 30 fps on the Mac (docs/volumetric-fog.md, "The child frames' restore") sat at a spot the
route-based frame-time set never stands at. This survey puts the player in front of the single-player maps' mirrors in headless Firefox
(inline simulation, 1440 x 960, DPR 1, an old AMD Radeon R9 200 on Linux) and reads the page frame and the mirror phase.

**Method.**
* The mirrors: every `POLY.Mirrored` surface of `map.model`, grouped by node plane (`mirrorPlanes()`) with the vertex bounds of its
  nodes: 80 groups (plane and bounds) in the single-player maps, many repeated in the variants of a map (01/03/04/05 Island and HQ,
  02/04/08 Bar and Hotel). A spot for each, 120 to 480 units out on the open side (`pointCheck` with JC's 20 x 20 x 43.5 capsule, the
  floor found by dropping the capsule), the yaw facing the plane; floors from inside their bounds. The scripts are in `.work/` and not
  committed.
* A run: `hitch-run.mjs --browser firefox --mode idle --god --seconds 12 (14) --place ...`, the figures from 5 s after the map (650 to
  900 drawn frames), behind the heavy lock. Firefox rounds `performance.now()` to 1 ms, so the p50 and p95 are whole ms; the phase
  columns are means. The run's JSON now keeps the mirror pass's stats of the last frame (`status.mirrors`: planes drawn, recursion depth,
  scissor pixels), to see whether a placed view shows a mirror.
* 38 views of 20 maps. The pass ran (`p.mirrors` 0.6 ms or more) in 31 of them. Seven drew none (`p.mirrors`
  0.1 or less): the Chateau's walls x=-444 and y=420, UNATCO HQ's y=-383, the Smuggler's y=-1746 from the floor, the 747 floor looked at
  level, the UNATCO MJ12 lab's wall x=-2862 (a conversation camera) and Endgame1 (the credits). The spot or the yaw missed the pane in
  the first five, which is not investigated. Five maps open on a conversation or a cutscene that takes the camera (Bar, Everett,
  Intro, both MJ12 labs), so their rows show what the conversation's camera saw, not the placed view; the Bar and Everett were run again
  from further out.
* Not surveyed (small planes of 1,500 to 14,000 square units, same code path): Airfield, HeliBase, Brooklyn Bridge, MolePeople, the
  WanChai street's panes, Cathedral, Metro, Vandenberg, OceanLab, Area 51, Dockyard, Ship.

**Survey** (Firefox; Chromium where measured, in its worker mode, where the page thread has no simulation: page p50 / worker p50, then
its `p.mirrors`). Sorted by the mirror phase.

| View | Map | Spot (Location; yaw) | FF p50 / p95 | p.mirrors | upload MB | draws | Chromium p50 (page / worker), p.mirrors |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Club, wall x=128 (surface 232, 864 x 256) | 10_Paris_Club | [-72,-1168,32]; 0 | 17.0 / 20.0 | 3.6 | 0.7 | 176 | 7.4 / 4.9, 3.2 |
| Club, slanted wall (surface 231) | 10_Paris_Club | [-128,-1368,32]; 49152 | 17.0 / 21.0 | 3.6 | 0.7 | 158 | 6.5 / 4.5, 2.8 |
| Club, both walls from 400 units | 10_Paris_Club | [-200,-1100,40]; 55200 | 16.0 / 19.0 | 3.4 | 0.7 | 162 |  |
| Bar, wall y=-764 from 480 | 02_NYC_Bar | [-768,-284,48]; 49152 | 16.0 / 19.0 | 2.9 | 0.4 | 253 |  |
| HK VersaLife, wall y=428 (39936) | 06_HongKong_VersaLife | [-944,628,-16]; 49152 | 13.0 / 16.0 | 2.3 | 0.6 | 134 | 2.5 / 6.7, 1.4 |
| WanChai Underworld, three BreakableGlass movers (view a) | 06_HongKong_WanChai_Underworld | [-1024,-1650,-336]; 49152 | 20.0 / 22.0 | 2.3 | 0.6 | 151 | 3.4 / 9.4, 1.1 |
| Club, bathroom mirror (651) | 10_Paris_Club | [-1208,-1436,-160]; 0 | 13.0 / 15.0 | 2.3 | 0.5 | 164 |  |
| Club, bathroom mirror (656) | 10_Paris_Club | [-1384,-1064,-160]; 32768 | 12.0 / 15.0 | 2.2 | 0.4 | 150 |  |
| Bar, wall y=-764 (conversation) | 02_NYC_Bar | [-768,-564,48]; 49152 | 14.0 / 18.0 | 2.2 | 0.3 | 150 | 4.3 / 5.6, 1.4 |
| UNATCO Island, floor z=-240 | 01_NYC_UNATCOIsland | [-4648,1794,-192]; 16384 | 17.0 / 21.0 | 1.9 | 0.5 | 120 | 2.8 / 8.2, 1.0 |
| HK MJ12 lab, wall x=-272 | 06_HongKong_MJ12lab | [-472,2448,-592]; 0 | 16.0 / 19.0 | 1.9 | 0.5 | 122 |  |
| WanChai Underworld, floor z=-384 | 06_HongKong_WanChai_Underworld | [-1616,-3074,-336]; 16384 | 16.0 / 19.0 | 1.9 | 0.4 | 200 |  |
| HK MJ12 lab, floor (conversation) | 06_HongKong_MJ12lab | [0,-104,176]; 16384 | 17.0 / 20.0 | 1.9 | 0.3 | 85 | 3.1 / 7.4, 1.0 |
| UNATCO MJ12 lab, wall y=1042 | 05_NYC_UNATCOMJ12lab | [-2776,842,-148]; 16384 | 14.0 / 17.0 | 1.7 | 0.3 | 107 |  |
| Smuggler, DeusExMover7 | 02_NYC_Smug | [-576,1530,250]; 16384 | 10.0 / 12.0 | 1.6 | 0.3 | 107 |  |
| Chateau, wall y=-260 | 10_Paris_Chateau | [-768,60,416]; 49152 | 11.0 / 13.0 | 1.5 | 0.3 | 117 |  |
| WanChai Canal, floor z=-448 | 06_HongKong_WanChai_Canal | [-1024,2765,-400]; 16384 | 12.0 / 16.0 | 1.4 | 0.4 | 165 |  |
| HK Helibase, wall y=-640 | 06_HongKong_Helibase | [1248,-440,144]; 49152 | 11.0 / 13.0 | 1.4 | 0.3 | 110 |  |
| Training, floors from the start, looking down | 00_Training | [-1149,826,-65]; 0 | 10.0 / 14.0 | 1.4 | 0.3 | 112 |  |
| UNATCO HQ, floor z=408 | 01_NYC_UNATCOHQ | [-999,448,456]; 0 | 11.0 / 13.0 | 1.3 | 0.3 | 118 |  |
| HK VersaLife, wall y=428 and wall x=-712 | 06_HongKong_VersaLife | [-500,600,-16]; 38318 | 13.0 / 17.0 | 1.3 | 0.6 | 110 |  |
| WanChai Underworld, wall x=1600 (49152) | 06_HongKong_WanChai_Underworld | [1400,0,-272]; 0 | 12.0 / 14.0 | 1.2 | 0.2 | 78 |  |
| Free Clinic, wall y=-322 | 02_NYC_FreeClinic | [1136,-522,-272]; 16384 | 9.0 / 11.0 | 1.0 | 0.2 | 93 |  |
| Intro, floor (cutscene) | 00_Intro | [0,-2256,-80]; 16384 | 9.0 / 12.0 | 1.0 | 0.1 | 54 |  |
| Hotel, wall x=1729 (opaque unlit) | 02_NYC_Hotel | [1929,-1158,112]; 32768 | 10.0 / 11.0 | 1.0 | 0.3 | 100 |  |
| Intro, floor and DeusExMover0 (cutscene) | 00_Intro | [0,-2256,-80]; 49152 | 9.0 / 12.0 | 1.0 | 0.1 | 55 |  |
| Everett (conversation) | 11_Paris_Everett | [1024,1640,430]; 53000 | 9.0 / 11.0 | 0.8 | 0.2 | 57 |  |
| Training, floor 1 (dark spot) | 00_Training | [-428,600,-80]; 0 | 9.0 / 14.0 | 0.8 | 0.2 | 80 |  |
| Everett, from 480 | 11_Paris_Everett | [1040,1180,400]; 16384 | 10.0 / 12.0 | 0.8 | 0.3 | 64 |  |
| 747, floor z=306, looking down | 03_NYC_747 | [1256,-600,354]; 0 | 8.0 / 9.0 | 0.7 | 0.1 | 80 |  |
| TrainingFinal, floor | 00_TrainingFinal | [6576,-5691,80]; 16384 | 8.0 / 9.0 | 0.6 | 0.2 | 71 |  |
| UNATCO MJ12 lab, wall x=-2862 (conversation) | 05_NYC_UNATCOMJ12lab | [-3062,1168,-128]; 0 | 15.0 / 18.0 | 0.1 | 0.1 | 86 |  |
| Chateau, wall x=-444 (55744) | 10_Paris_Chateau | [-764,128,416]; 0 | 9.0 / 11.0 | 0.1 | 0.1 | 71 |  |
| Chateau, wall y=420 | 10_Paris_Chateau | [-768,100,416]; 16384 | 9.0 / 11.0 | 0.1 | 0.1 | 65 |  |
| UNATCO HQ, wall y=-383 | 01_NYC_UNATCOHQ | [328,-97,46]; 16384 | 9.0 / 11.0 | 0.1 | 0.1 | 69 |  |
| 747, floor z=306, level gaze | 03_NYC_747 | [1256,-600,354]; 0 | 7.0 / 8.0 | 0.1 | 0.1 | 68 |  |
| Smuggler, wall y=-1746 | 02_NYC_Smug | [-788,1546,-48]; 16384 | 8.0 / 9.0 | 0.1 | 0.1 | 62 |  |
| Endgame1, floor (credits) | 99_Endgame1 | [192,-7048,-48]; 16384 | 11.0 / 15.0 | 0.0 | 0.1 | 23 |  |

**Reading it.**
* **The mirror phase is small everywhere a mirror was in view:** 0.6 to 3.6 ms (the club's two walls the largest: four child passes,
  about 175 draw calls, 0.7 MB in 290 to 340 upload calls a frame). No view comes near the club's earlier 165 MB and 36 ms.
  Chromium's phase is 1.0 to 1.4 ms at the single-plane spots measured against Firefox's 1.9 to 2.3, and 2.8 to 3.2 at the club's walls against
  3.6: the Firefox excess is the JS speed of three.js's per-pass draw work (about twice), not a trap.
* **Five spots are over 16.7 ms (page mean):** the club's wall x=128 (17.4) and slanted wall (17.3), the Underworld panes (19.9), the
  Island floor (17.3) and the HK MJ12 lab's floor (16.7, in a conversation). Phase means:
  * Club wall x=128: tick 5.2, actors 1.9, fog 2.0, mirrors 3.6, HUD 2.0, render 0.3. Without the mirror phase it is 13.8 ms; the
    mirror and its child frames' fog are what take it over the bound. Chromium's page does the same phase in 3.2 ms (the simulation is in
    its worker, 4.9 ms).
  * Underworld panes (three one-way pane movers, view a of "Original at the same views"): tick 9.7 (Chromium's worker needs 9.4 for that
    map), mirrors 2.3. Over budget without any mirror.
  * Island floor: tick 8.4, mirrors 1.9. HK MJ12 lab floor: tick 7.5, mirrors 1.9. The map's tick (script work in Firefox,
    docs/firefox-60fps-plan.md) is the larger part; the mirror phase is what is left over the bound.
* **At DPR 2** (the Mac's Retina) the club corner (`[-100,-1250,40]`, yaw 52436: 4 child passes, depth 2, 7.5 M scissor pixels) takes
  20.8 ms a frame, interval 24 ms, 41 fps: `p.mirrors` 4.25, `p.fog` 2.3, tick 6.9. The frame interval is 3.5 ms longer than the
  page's work (the page waits on the GPU); every phase is a little up, none by a trap's amount.
* **The club's mirror phase by profile** (`gecko-phase.mjs --entry 'src/viewer/mirrors\.mjs'`, wall x=128, 3.5 ms): three.js's child
  `render` calls 1.7 (scene traversal, `updateMatrixWorld` 0.4, program and uniform setup), the fog tile restore 0.94 (`copyTile` 0.5 of it,
  `texSubImage2D` 0.4, the tile-sized sources of the 2026-11-06 fix), the actors' lighting for each pass 0.55, the hitch log's GL
  wrapper 0.57 (measurement, inside the others). A single-plane view takes the same shape: the Bar from 480 units (127 k scissor pixels, one
  pass, 253 draws) is 2.9 ms, 1.56 of it three.js's render. The cost follows the draw calls of the reflected frame, not the pixels.

**Cause found: `from` copies in the fog update.** Profiling the club (`gecko-phase.mjs --entry '^update \(src/viewer/fog-pass'`) showed
`Uint8Array.from(texels)` (the child frame's kept map) and `Array.from(texels)` (`note`, the validation record of the most fogged map, built
again each time a map beat the frame's best) as 0.36 + 0.24 + 0.07 ms of self-hosted `from` and `next`, plus the garbage: SpiderMonkey runs
them through the iterator protocol, a call per byte (the family of `anyFog`'s old `texels.some(Boolean)`, 1.26 ms of Battery Park's frame). Both are
now byte copies: `new Uint8Array(texels)` for the kept map, and in `note` a byte copy that becomes the Array the validators read
(`stats.frameCase.texels`, a getter, read across spreads and clones) on its first read. The texels are the same bytes: the fog update's
output, the GPU tiles and the oracle comparison are unchanged. `?fogCopy=from` (env `FOG_COPY=from`) keeps the old path.
* **Cost:** Firefox inline, 10_Paris_Club, `hitch-ab.mjs --arms old:fogCopy=from,new: --pairs 4` twice (eight pairs, interleaved, 14 s
  each, `--place '{"location":[-100,-1250,40],"rotation":[0,52436,0]}'`): `p.fog` 2.25 → 1.71 ms (all eight pairs between 2.17 and 2.33
  against 1.59 and 1.79), the page's `animate` mean 17.24 → 16.87 ms (medians of the runs' means 17.04 → 16.48). Mirror-phase outliers (4.3 to 4.7
  against 3.8 to 4.0) fell in three of the eight "new" runs and one "old" run, some beside external gaps in the same run, so the saving
  shows in the fog phase more cleanly than in the frame. Chromium (worker mode, one run each, wall x=128): `p.fog` 1.56 → 1.13 ms, the page
  frame 7.5 → 7.0 ms, no regression.
* **Checks:** validate-volumetric-fog-play (the oracle comparison of the club's frame case through the getter), validate-mirrors-play,
  validate-mirror-plan-play, validate-sky-in-mirror-play, validate-weapon-mirror-play, validate-strobe-mirror-play and
  validate-sprite-tiles-mirror-play pass.

**Left as it is.**
* The original's recursion (the corner's four passes to depth 2, 3 at the limit) and every pass's draw calls: original behaviour.
* The restore's 0.94 ms at the club (5% of the frame): by the code it restores the tiles after every child pass although only the root
  frame's draw reads them, and it restores tiles of surfaces the root frame does not draw (`mainVisible` false, whose GPU tiles are
  rewritten before they next draw). A restore once at the end of the mirror pass, or skipping those surfaces, would save about 0.3 to
  0.5 ms each (an estimate from the profile, not tried), under the 5% bar the project sets for speed work, and the second breaks the
  "GPU page equals its pixels" check (`pagesMatch`).
* three.js's `scene.updateMatrixWorld` in every child `render` (0.4 ms at the club).

**Not explained / not covered.** The seven views with no mirror pass (above). The Mac itself (Metal through ANGLE, DPR 2): the DPR 2
run here is the same card, so a Mac-specific copy path like the club's would show up there first; none is known. Chromium was measured at
seven of the spots only.
