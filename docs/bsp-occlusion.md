# Original BSP occlusion (URender::OccludeBsp)

The original decides what a frame draws with a front-to-back walk of the
world BSP against per-zone span buffers of free screen scanlines. This page
records the recovered contract, the reference that checks it, and the Rust
port (`native/script-vm/src/occlude.rs`, host module
`src/runtime/bsp-occlusion.mjs`). It replaces the frustum-only host culling
that [render visibility](render-visibility.md) warns about, one piece at a
time; what is not yet ported is listed at the end.

## Authority

Render.dll SHA-256
`607f1077c5cd3e25f8a4cde1ffacf4cf9260aebc92a72be40721cd6955bd75d1`, with
Engine.dll and Core.dll at the hashes in `native-collision-oracle.py`. The
SDK 1112f headers (`RenderPrivate.h`, `UnSpan.h`, `UnRender.h`, `UnObj.h`)
name the structures; every behaviour below comes from the DLL instructions.
Local working notes (instruction-level pseudocode, kept out of Git with the
disassembly): `.work/occlude/occludebsp.md`, `span-buffer.md`,
`frame-and-clip.md`, `dynamics-and-drawframe.md`.

## Precision: the render pass runs at 24 bits

`UGameEngine::Draw` (Engine `0x1038f110`) calls, in order,
CreateMasterFrame (vslot `0x64`), `URender::PreRender` (`0x5c`), DrawWorld
(`0x70`), the script PreRender/RenderOverlays/PostRender events and console
draws, `URender::PostRender` (`0x60`) and FinishMasterFrame. PreRender calls
Core `appEnableFastMath(1)` at `0x10b14629`; its body (`0x1016e050`) is
`_controlfp(Enable ? _PC_24 : 0, _MCW_PC)`. PostRender calls it with 0 at
`0x10b1472c`. So:

* The master frame (ComputeRenderCoords/ComputeRenderSize) is built at the
  game thread's precision, as [the scene frame](script-window-scene-frame.md)
  assumes. Its sizes are then recomputed at 24 bits on the render rectangle
  by XRootWindow::PreRender before DrawWorld ([the 3D frame's
  projection](render-pass-precision.md#the-3d-frames-projection-2026-10-08)):
  OccludeBsp sees CreateMasterFrame's coordinates, zone and screen span (the
  viewport's size) with the 24-bit FX..PrjYP, ViewSides and ViewPlanes.
* Everything inside DrawWorld, including OccludeBsp, ClipBspSurf,
  BoundVisible, SetupDynamics and child frames' ComputeRenderSize, runs with
  precision control 24: each x87 add, subtract, multiply, divide and square
  root rounds to a 24-bit significand (transcendentals are not affected).

For the finite, normal-range values of world geometry that is IEEE binary32
arithmetic, so the port computes in f32 in the original's operation order.
The x87's wider exponent range differs only for results beyond binary32's
range or below its normal range; the port does not model those. Unicorn
2.1.4 honours precision control (a probe gave `0xaaaaab0000000000` for 1/3
at 0x007f), so the reference runs OccludeBsp at control word 0x007f.

The existing 0x037f translations of code inside DrawWorld (render visibility
admission and mesh bounds, dynamic lighting, mesh lighting) model the wrong
precision for in-game rendering; this is recorded for them separately.

## Call order

`URender::DrawWorld` (`0x10b1cb90`) increments the frame counter at
`0x10b5a700` (`0x10b1cbed`) and calls `OccludeFrame` (`0x10b19fc0`), then
`DrawFrame` (`0x10b1a2d0`). OccludeFrame runs SetupDynamics (`0x10b22d90`),
then OccludeBsp (`0x10b173d0`), assigns dynamic lights, and recurses into
the child frames OccludeBsp created, newest first. DrawFrame draws children
first, then the frame's lists. `URender::GetVisibleSurfs` (`0x10b160a0`)
shows the minimal original sequence: CreateMasterFrame, then OccludeBsp,
then the draw lists' surfaces.

CreateMasterFrame (`0x10b15690`) allocates the frame from GSceneMem, sets
Mirror 1, Recursion 0, iSurf −1, a zero NearClip, gives the screen one
full-width span per line (`AllocIndexForScreen`) and takes ZoneNumber from
Engine `UModel::PointRegion` at the camera origin. Its Bounds argument is not
read.

## OccludeBsp

Inputs: the frame (Coords, X, Y, FX15, FY15, FX2, FY2, Proj.Z, PrjXM..PrjYP,
ViewSides, NearClip, Mirror, ZoneNumber, Recursion), the model (FBspNode,
FVert, points, FBspSurf, render bounds, zones), the viewport (ExtraPolyFlags
`+0x98`, its actor's ShowFlags `+0x5fc` and RendMap `+0x600`), the render
device (SpanBased `+0x48`, VolumetricLighting `+0x58`, ShinySurfaces `+0x5c`),
`URender::Toggle` (`+0x34`) and Level.TimeSeconds.

**Setup** (`0x10b173d0..0x10b17a9f`). Stamp (`0x10b56a0c`) is incremented: the
point cache (`0x10b56a10`, 128,000 entries of FTransform pointer and stamp,
allocated in `URender::Init`) is valid per call. `Zones[ZoneNumber].LastRenderTime`
gets TimeSeconds. Each of 64 zone span buffers starts empty; the view zone's
is the frame's screen span. The active-zone list starts with ZoneNumber and
the active mask with its bit. A zone actor that is a WarpZoneInfo with both
links set takes a separate path; no single-player map has one (census of
all 83), so it is unsupported.

**Walk.** An explicit stack of 0x18-byte GMem entries (iNode, far child, far
side's Outside, Outside, state, previous) gives a front-to-back recursion:

1. *First visit.* A node whose ZoneMask misses every active zone is skipped
   with its subtree. A node with a render bound tests it, unless the moving
   brush tracker reports its surface dynamic, or unless the node was not
   box-occluded last time (`NodeFlags & 0x10` clear) and
   `(frameCounter ^ iNode) & 15` is nonzero: unoccluded nodes are re-tested
   once every 16 frames, staggered by node index. The test clears 0x10, calls
   `BoundVisible` (with the zone-0 span only when ZoneNumber is 0), and in a
   zoned view needs `BoxIsVisible` on some active zone in the node's mask;
   failing sets 0x10 and skips the subtree. Then the node's
   `Dynamics[0]` items are filtered, and the side of the camera picks the near
   child (`dist > 0`, `dist = ((O.z·N.z + O.y·N.y) + O.x·N.x) − W`), which is
   pushed. `ChildOutside` carries "outside" down.
2. *After the near subtree.* The zone mask is checked again. The near side's
   final chunks are pre-rendered (dynamics). If all four ViewSides point to
   the camera's side of the plane, the node's polygons and its far subtree
   cannot be seen and are skipped.
3. *Each polygon of the coplanar chain* (`iPlane`): PolyFlags is the
   surface's ORed with ExtraPolyFlags. A back face more than one unit away is
   skipped unless TwoSided or a portal; portals are skipped in an unzoned
   view; a polygon whose zone has no free spans is skipped. ClipBspSurf
   clips and projects it; the points are reversed for a two-sided or portal
   back face, and again in a mirrored frame. The rasterizer (`0x10b19cc0`)
   builds 16.16 edge spans, first testing the polygon's box when it was
   occluded last time (`NodeFlags & 8`). The texture's PolyFlags are ORed in.
   The polygon's spans are copied from its zone's buffer: occluding surfaces
   (no Invisible, Masked, Translucent, Modulated, Portal or 0x10000) and
   invisible portals and mirrors remove them (`CopyFromRasterUpdate`);
   others only read them (`CopyFromRaster`). No spans sets
   `NodeFlags |= 8` (NF_PolyOccluded) and skips the polygon. Then:
   * PF_FakeBackdrop in a zone with a SkyZone (and Recursion < 3, ShowFlags
     0x800) creates the sky child frame and draws nothing here.
   * PF_Mirrored (Recursion < 3, ShowFlags 0x800) creates the mirror child
     frame, puts the surface in `Draw[0]` with PF_Occlude, and also
     PF_Invisible when it is not composited. A translucent mirror on a device
     without ShinySurfaces instead becomes opaque. See
     [mirror surfaces](mirror-surfaces.md).
   * A portal adds its far zone to the active zones, merges its spans into
     that zone's buffer and stamps that zone's LastRenderTime; an invisible
     portal draws nothing.
   * PF_Invisible surfaces draw nothing.
   * Otherwise the polygon joins a draw list: an occluding surface joins the
     list already made for the same surface and zone actor, if any; others
     start a new list in `Draw[1]` (occluding) or `Draw[2]`. On D3D
     (not span-based) each list keeps the clipped polygons (FSavedPoly) and
     releases its spans. NodeFlags loses 8. A zone whose spans run out leaves
     the active list; with none left the walk ends.
4. *After the chain*: the far side's final chunks are pre-rendered, then the
   far child is walked in the same stack entry.

**ClipBspSurf** (`0x10b14cb0`). On CPUs without 3DNow! (Core's `GIs3DNow`,
every Intel and every AMD since family 15h) the x87 body runs;
AMD3DClipBspSurf is unsupported. Each vertex is transformed once per stamp
into view space and given four outcodes from the sign bits of
`Z·PrjXM + X`, `Z·PrjYM + Y`, `Z·PrjXP − X` and `Z·PrjYP − Y` (−0 counts as
outside) and, inside, ScreenX/ScreenY/IntY. A polygon wholly outside one
side is dropped. Sutherland–Hodgman passes clip against the left, right,
top and bottom planes in that order, interpolating new vertices from GDynMem,
and a near-clip pass runs for a nonzero NearClip.W (child frames).

**Span buffers** (`0x10b21730..0x10b22459`). Per line, sorted half-open free
spans. `BoxIsVisible`, `CopyFromRaster(Update)` and `MergeWith` (touching
spans merge) are integer-only, signed comparisons. Under emulation, a Python
translation matched the original's whole 8 MB heap after each of about
18,000 randomized calls, with every non-exception instruction covered.

## Dynamics: which actors are drawn

SetupDynamics (`0x10b22d90`) builds, for each admitted actor in Level.Actors
order, an FDynamicSprite (`0x10b233c0`): after Setup gives its integer screen
rectangle and depth Z, the rectangle's corners are deprojected at Z
(`(X − FX2)·RProj.Z·Z`) and taken to world space through Uncoords (the four
proxy points), an FRasterPoly holds `[X1, X2)` on each line of `[Y1, Y2)`,
and an FDynamicChunk for it goes to the head of node 0's list.
`FDynamicChunk::Filter` (`0x10b23e30`), run by OccludeBsp at each visited
node, classifies the proxies against the node plane at ±0.01, splits the
raster along the plane's screen line in 16.16 fixed point when the proxies
straddle it with at least two crossings, and sends each piece to the child
on its side, or, at a missing child on an outside side, makes an
FDynamicFinalChunk on that node side, kept in ascending Z. When OccludeBsp
reaches a node side's leaf (the two PreRender sites),
`FDynamicFinalChunk::PreRender` (`0x10b24740`) copies the piece's spans
still free in that zone (read-only): the first success prepends the sprite to
`Frame->Sprite`, later ones merge into its span buffer. A subtree OccludeBsp
skips never filters its chunks. `Frame->Sprite` is the set of actors the
frame draws (DrawActorSprite stamps LastRenderTime).

The port (`setup_sprites`, `filter_chunks`, `pre_render`) takes each
sprite's rectangle and Z from `occ_setup` (the next section) or, for
validation, straight from the host. The reference calls the original
FDynamicSprite constructor with Setup supplying the same values, or running
on actor fixtures, then OccludeBsp, and reads `Frame->Sprite` with each
sprite's span buffer.
Uncertain items with no observable effect, from the dynamics notes: chunk
depth fields are uninitialised in the original (proved not to change the
final chunks' relative order); FDynamicLight items (moving lights) are not
filtered here, as they do not affect visibility.

## The master frame

`occ_master_frame` builds the frame from the camera as CreateMasterFrame
does, on the 80-bit x87 model (`x87.rs`) because it runs before PreRender:
ComputeRenderCoords' view coordinates (the rotation passes of
[the scene frame](script-window-scene-frame.md), sine table and all),
the transposed axes as Uncoords, all of ComputeRenderSize (FX..FY15, Proj,
RProj, Zoom, PrjXM..PrjYP; four ViewSides as the normalized corner rays
`(±FX2, ±FY2, Proj.Z)` through Uncoords, with Core appSqrt's qword argument
and result; four ViewPlanes, their W from Coords.Origin in the instructions'
two different sum orders), and the zone from UModel::PointRegion (`dist =
((z·Pz + y·Py) + x·Px) − W`, the back side when below zero or unordered).
Core appTan's result comes from `sceneFrameTangent`, measured for FOV 75 and
90 among others.

With a render rectangle (`master({..., render})`, Play's main and camera
frames) the sizes are computed once, by `render_size` at P24 on the
rectangle with the tangent of the 24-bit argument, as XRootWindow::PreRender's
second ComputeRenderSize leaves them; the frame's X and Y are the
rectangle's and the screen span (`AllocIndexForScreen`) keeps the viewport's
size (frame words 61 and 62), which OccludeBsp's results depend on in clipped
views. Without one (no render pass), the 64-bit sizes of CreateMasterFrame.

## Child frames

OccludeBsp makes a child frame for each mirror and sky polygon it keeps,
and URender::OccludeFrame (`0x10b19fc0`) then runs each child: its own
SetupDynamics and OccludeBsp, then its children. The Rust core runs the
whole recursion in one `occ_run` (`occlude.rs` `create_child_frame`,
`occlude_children`), on the same arenas as the original's DrawWorld.

- **Precision.** Everything here runs inside DrawWorld, at 24 bits. The
  mirror and sky coordinates are binary32 arithmetic in the instructions'
  order. The child's ComputeRenderSize is `render_size` at P24, the
  master's at the 64-bit model. Three of its operands are doubles rounded
  once: the FX15/FY15 constant, the FOV argument and the appTan quotient
  (tracker.rs `P24`, with `div24` for a double divisor).
- **CreateChildFrame** (`0x10b15a40`):
  - A request merges into an existing child of the same parent when iSurf,
    Parent and ZoneNumber match and each NearClip component compares equal
    (unordered counts as equal). The merge widens the span and, with
    bounds, only widens the Prj clip numbers.
  - Otherwise a new child is copied from the parent and prepended. Only X,
    Y, XB and YB survive the copy. It gets the given Coords, their
    transposed Uncoords, Recursion + 1, Mirror and NearClip, then
    ComputeRenderSize. The raster's bounds narrow PrjXM..PrjYP, and its span
    is the request's, merged into a fresh one.
- **Mirror request** (`0x10b188ce..0x10b18b55`):
  - Coords reflected: Z and Y through `A − N·(2(A|N))` (Core's FVector |,
    \* and −), X through MirrorByVector, the origin through MirrorByPlane.
  - NearClip is the node's plane in the parent's view, negated:
    `(Coords axes · N, W − Origin·Coords | that)`. Mirror is negated.
- **Sky request** (`0x10b184b1..0x10b187d1`):
  - The parent's Coords with the origin set to `O − O`, multiplied
    (FCoords \*=) by the SkyZone's roll, pitch and yaw matrices from
    GMath's table, then the SkyZone's Location added.
  - Mirror and NearClip are the parent's. The zone is the SkyZone's
    Region.ZoneNumber, which the request also carries.
- **Recursion** (`0x10b1a267..0x10b1a27c`): each child of a frame, newest
  first, depth first. Before each OccludeBsp, Setup runs again on the frame's
  candidates. OccludeFrame passes no excluded actor for a child, and
  SetupDynamics' ViewTarget rule applies only at Recursion 0. A candidate
  flagged `SETUP.FLAGS` = 1 (the player in first person) is therefore
  constructed only in child frames.
- **Output.** `occ_run` writes the root frame's output first (the decal
  block reads only that), then one record per child: its fields, its span
  as OccludeBsp receives it, and its OccludeBsp output.
  `bsp-occlusion.mjs` `run(..., { children: { fov } })` decodes these as
  `frames`. The child tangent is `childFrameTangent`'s x87-tan.mjs model
  for the 24-bit argument, refused when FPTAN's last bit could change
  Proj.Z.

**Verification.** `scripts/validate-child-frames.mjs` drives the unchanged
CreateChildFrame (with Engine's ComputeRenderSize) and OccludeFrame's
recursion under Unicorn (`native-occlusion-oracle.py` with `children`,
SkyZone fixtures, per-frame sprite constructors and Setup). Cameras aim at
mirrored and fake-backdrop polygons and at movers, using
validate-mirrors-play's views and the club tunnel. Sprite actors stand
around the view, one at the eye that only child frames construct.

Every child frame matches bit for bit: fields, Uncoords, NearClip, Mirror,
zone, recursion, span, draw lists with every saved point, Frame->Sprite
with span buffers and its own requests, plus NodeFlags, zone times and
counters over the recursion.

| Map | Cases | Child frames | Mirror / sky | Deepest recursion |
| --- | ---: | ---: | --- | ---: |
| 00_Training | 24 | 55 | 52 / 3 | 2 |
| 01_NYC_UNATCOIsland | 20 | 17 | 1 / 16 | 1 |
| 10_Paris_Club | 20 | 29 | 29 / 0 | 2 |
| 10_Paris_Club, tracked movers | 18 | 2 | 2 / 0 | 1 |
| 02_NYC_Bar | 19 | 18 | 18 / 0 | 1 |
| 02_NYC_Hotel | 19 | 11 | 11 / 0 | 1 |
| 02_NYC_Smug, tracked movers | 19 | 17 | 6 / 11 | 2 |
| 11_Paris_Everett, tracked movers | 19 | 23 | 9 / 14 | 3 |

The checks include mover mirrors, sky frames inside mirror frames and
merged requests. validate-bsp-occlusion's master-only sequences are
unchanged.

**Play.** With child frames on (the default; `?childFrames=off`, Node
`CHILD_FRAMES=off`, keeps the frustum-planned passes):

- **Frames.** `sim-session.mjs` `visibility` runs the recursion. Each child
  frame carries its visible nodes, its tracked movers' polygons, its
  Frame->Sprite and the group a mirror frame looks through: a static group
  by its node, a mover's by its tracked polygon.
- **Pass plan.** `mirror-passes.mjs` `planFramePasses` plans the mirror
  passes from these frames on both sides. A pass is a mirror frame whose
  group the page supports. Its scissor is the frame span's bounds, and its
  children are its own mirror frames, up to Recursion 3. A sky frame made
  inside a mirror frame is drawn into that mirror's target first, with the
  SkyZone view turned like the mirror camera.
- **Drawing.** Each mirror and sky pass draws the world through its own
  frame's nodes and mover polygons (`world-visibility.mjs`) and only the
  sprite records its Frame->Sprite holds (`sprite-scene.mjs` `framePass`).
  The root sky frame does the same.
- **Actors and stamps.** Actor meshes in each pass are decided by the
  pass's Frame->Sprite (`actor-mesh-sim.mjs` `framePasses`), and `stamps()`
  writes LastRenderTime for every actor in any frame's Frame->Sprite, as
  DrawActorSprite does. The player, flagged root-excluded, appears in mirror
  frames. Each such actor is also lit once per frame that draws it, with that
  frame's Coords, Mirror and LeafLights, in DrawFrame's order ([mesh
  lighting](mesh-lighting.md#one-call-per-frame-child-frames-lighting-2026-10-08);
  frames carry `mirror` and `planes` beside `coords`).
- **simVerify.** It compares the actors three.js draws. A Frame->Sprite
  actor whose groups all lie outside a pass's view is stamped, not drawn.

**Cost.** See "Child frames: cost" below.

**Pixels against `?childFrames=off`** (worker mode, 1280×720, 30 frames):

- The Island start and the Paris Club spawn are identical.
- Facing Training's entrance floor mirror, 5,096 pixels differ. The floor
  reflects the sky through the ceiling opening (a sky frame inside the
  mirror frame), and there are single pixels along the mirror's far edge.
- Facing 02_NYC_Smug's mover mirror, 9,757 pixels differ: the window in
  the reflection shows the sky.

**Other checks.** `validate-sim-split` is deterministic on Training and
Island (240 frames walking, same pixels). `validate-mirrors-play` passes,
with the player in the Hotel mirror, and so does its `?simVerify=1` run
(one of two runs lost its browser before finishing). `validate-decals-play`
and `validate-gpu-mesh` pass too.

**Open.**

- Fog maps in mirror and sky passes are the main frame's: SetupForSurf per
  child frame is not run, so a fog surface seen only in a child pass has no
  fog map.
- Actor meshes are not drawn in a sky frame made inside a mirror frame;
  that frame's sprites and world are drawn.
- A sky frame inside a mirror frame uses the root frame's SkyZone view.
- Iterator items are the root frame's in every child frame. The original
  runs the iterator again for each frame.
- The child tangent comes from the x87-tan.mjs model, which is checked
  against hardware FPTAN, not from a measurement of these arguments.

## Reference and verification

`scripts/native-occlusion-oracle.py` runs the unchanged CreateMasterFrame
(with Engine's ComputeRenderCoords, ComputeRenderSize and PointRegion) and
OccludeBsp under Unicorn on a decoded map. Fixtures supply only fields the
instructions read: the model arrays, LevelInfo (TimeSeconds), zone actors,
texture PolyFlags, the viewport, viewer (ShowFlags 0x480c, RendMap 5) and
render device (ShinySurfaces 1, VolumetricLighting 0, no SpanBased), and the
caches URender::Init allocates. Unresolved imports, unexpected virtual calls
and reads below 0x10000 trap. CreateChildFrame is replaced by a recorder.
Core appTan returns the measured tangents.

`node scripts/validate-bsp-occlusion.mjs` drives one seeded camera sequence
per map through both, carrying NodeFlags and the frame counter between
frames: Paris Club (the spawn tunnel views plus 35 more), Training, UNATCO
Island and Vandenberg Command, 144 frames. Cameras stand at actors and
anywhere in the model's bounds (solid space, outside the level, zone 0) at
random rotations, six frame sizes and FOV 75 and 90. Every draw list entry,
every saved polygon's clipped points (X, Y, Z, ScreenX, ScreenY, IntY, RZ
bits), the NodeFlags, the zones' LastRenderTime, NodesDraw/PolysDraw and the
child-frame requests with their spans match bit for bit. The port builds
each frame from the camera itself, and its 57 FSceneNode words, Uncoords
and zone number match the original CreateMasterFrame's bit for bit as well.
Three frames in four then go through the render pass's ComputeRenderSize
(rectangle edit and Engine's ComputeRenderSize at control word 0x007f in the
oracle, `render` cases; one in four with the master built at 0x007f), the
same comparison bit for bit.
Each frame also carries up to 23 random sprites (1,598 in all, 418 drawn):
`Frame->Sprite`'s order and every sprite's merged span buffer match. During development
the same comparison also passed 360 more frames on Paris Club, Training,
Island, Wan Chai Market, Area 51 Page and Hotel, and 360 arbitrary-position
frames on six maps including AirfieldHeliBase, Endgame4 and DXOnly, with 122
zone-0 views and 203 mirror requests.

The same validator then runs four sequences over models the moving brush
tracker built: Training with its doors closed, Training with a door raised,
the Paris Club with its mirror movers turned, and Island (129 frames). The
oracle's Level holds a tracker whose SurfIsDynamic is Engine's own
([brush tracker](brush-tracker.md#verification)), and fragments' draw
lists, coplanar chains and skipped bound tests match as well.

The Paris tunnel at spawn, looking down the tunnel (yaw 32768), draws 6
surfaces, creates no child frame and stamps no other zone. The frustum-only
browser path drew the club behind the walls there: five mirror passes and
1,105 fog surfaces.

The port takes 0.2–0.8 ms per frame in Node (Wasm), against 30–200 ms for the
emulated original.

## Setup: each actor's screen rectangle

`FDynamicSprite::Setup` (`0x10b23910..0x10b23d9c`) gives the constructor
its integer rectangle `[X1, X2) × [Y1, Y2)` and depth Z. It runs inside
DrawWorld, so at 24 bits, and so do its callees. The port is
`native/script-vm/src/setup.rs` (`occ_setup`), binary32 in the
instructions' order. First it copies ScaleGlow, DrawScale, Location and
Rotation into the sprite (DrawActorSprite draws from those copies).

* **Mesh path** (DrawType 2 with a Mesh; any other DrawType but 1 and 7
  rejects). Z = `((L.z−O.z)·Zz + (L.y−O.y)·Zy) + (L.x−O.x)·Zx` (Location,
  Coords origin and ZAxis), stored to the sprite; below −0 or unordered
  rejects unless RendMap is 13–15. Then `Mesh->GetRenderBoundingBox(Actor,
  0)` (vslot 0x5c; ULodMesh inherits UMesh's `0x103a6850`), then
  `BoundVisible(Frame, box, NULL)` (vslot 0x80, `occlude.rs`
  `bound_visible_box`), then `X1 = _ftol(MinX)`, `X2 = _ftol(MaxX)`,
  `Y1 = _ftol(MinY)`, `Y2 = _ftol(MaxY)` of the clamped bounds; Setup
  returns `Y1 < Y2` (X1 < X2 is not required: the raster rows are then
  empty).
* **GetRenderBoundingBox** (Engine `0x103a6850..0x103a6b9b`). GetAnimSeq
  (`0x1031c000`) takes the first sequence with the actor's own AnimSequence
  FName. With one and AnimFrame ≥ 0 (double 0.0, unordered skips), the
  phase is `(AnimFrame + 1.0) · NumFrames` stored as a float, `fistp(phase
  − 0.5f)` the frame, `i % NumFrames + StartFrame` and `(i + 1) % NumFrames
  + StartFrame` the two BoundingBoxes entries (no bounds check), combined
  by Core `FBox::operator+=` (`0x101196a0`): with both valid, Min =
  `this <= other ? this : other`, Max = `this < other ? other : this`
  (unordered keeps this for Min, takes other for Max); otherwise the
  second box is copied, IsValid included. Without, the mesh's
  BoundingBox. The factor is 1.5 (double) for bParticles (`+0x194 & 4`),
  else DrawScale; Max = `(factor·Scale)·(Max − Origin) + 1`, Min likewise
  `− 1` (FVector operators), and the box is valid whatever its source was.
  The coords are GMath.UnitCoords `/=` RotOrigin, then `/=` the actor's
  Rotation (Core `0x1011b690`: roll, pitch and yaw passes, each axis
  `((v.x·r.x + v.y·r.y) + v.z·r.z)` per row), with origin Location +
  PrePivot; Core `Transpose` (`0x1011a140`: columns, origin −(O·X, O·Y,
  O·Z)); `FBox::TransformBy` (`0x101198f0`): the eight corners X-major, each
  `(P − origin)` through the rows; Min takes a corner only when strictly
  smaller, Max when larger or unordered.
* **Sprite path** (DrawType 1 or 7, `0x10b23ada..0x10b23d94`). A null
  Texture rejects. Z as above. `URender::Project` (`0x10b20750`, vslot
  0x78): T = (V − Origin) stored, then through Coords; Z' = T.z, but
  `T.z + 0.02` (double, rounded once) when |T.z| < 0.01 (double; NaN takes
  this branch); RZ = Proj.Z / Z'; ScreenX = T.x·RZ + FX2, ScreenY =
  T.y·RZ + FY2, Persp = RZ, all stored; it fails unless Z' > 1.0. Half
  width `hw = ((USize·DrawScale)·Persp)·0.5f` stored; `X1 =
  appCeil(ScreenX − hw)`, `X2 = appCeil(hw + ScreenX)`: Core `0x10123300`
  passes the float as a double to msvcrt `ceil` and `_ftol`s the result;
  Setup then does `fild; fstp dword; fld; fistp`. Swap if X1 > X2; X1 < 0
  sets X1 = 0 and then X2 < 0 sets X2 = 0; X2 > Frame.X sets X2 = X and
  then X1 > X sets X1 = X; reject when X2 ≤ 0 or X1 ≥ X − 1. Y likewise
  with VSize, clamped to Frame.Y; reject when Y2 ≤ 0, Y1 ≥ Y or Y1 ≥ Y2.
* **Host inputs** (`bsp-occlusion.mjs`): a mesh record once per mesh
  (`meshRecord`: BoundingBox, the BoundingBoxes bytes, Scale, Origin,
  RotOrigin), and per candidate (`packSetupCandidate`, SETUP words)
  DrawType, the mesh record, the texture's USize/VSize, Location, Rotation,
  DrawScale, PrePivot, bParticles, GetAnimSeq's sequence (`setupSequence`:
  FNames compare case-folded) and AnimFrame. `occ_setup` writes each
  result (status, rectangle, Z, and the sprite path's ScreenX, ScreenY,
  Persp) and appends the accepted ones, in order, to occ_run's sprite list.
  A candidate whose mesh has no record or whose texture size the host does
  not know yet reports UNKNOWN and is not handed on; a frame box index the
  original would read outside the array reports UNSUPPORTED.

Unsupported: the orthographic RendMaps 13–15 and SHOW_ActorIcons (`0x20`:
DrawScale 1 and AActor's default texture); Play's viewer has RendMap 5 and
ShowFlags 0x480c.

**Reference.** `native-occlusion-oracle.py` builds actor, mesh (a vtable
with GetRenderBoundingBox and GetAnimSeq) and texture fixtures with only
the fields these bodies read. A case sprite with an `actor` runs the real
Setup inside the constructor, and `setupOnly` cases call Setup directly
after CreateMasterFrame, at control word 0x007f. Setup's one import outside
the loaded images, msvcrt `ceil`, is bridged by an x87 stub that rounds the
double with FRNDINT under rounding control "up". FRNDINT is exact and
precision control does not apply to it, so this assumes only that msvcrt's
`ceil` returns the exact ceiling; msvcrt.dll itself is not part of the
reference.

`node scripts/validate-sprite-setup.mjs` boots 00_Training and
01_NYC_UNATCOIsland through Play's createGame, ticks 30 frames and packs
every Level.Actors entry with a preparable mesh or any texture
(hidden ones too: Setup does not read bHidden), plus synthetic meshes
(random boxes, frame boxes, sequences, negative scales, RotOrigin) and
actors of every DrawType, sprites near the view plane included. 48 cameras
per map (the player's view at two sizes, cameras looking at random actors,
and synthetic scenes) give **111,060 Setup calls** (Training 16,812,
Island 94,248; 85,336 sprite and 20,835 mesh calls, 26,107 accepted;
2,074 through the frame-box pair; 759 with Persp above 8000, the
near-plane step among them) whose return value, X1..Y2, Z and ScreenX,
ScreenY, Persp match bit for bit. 12 more frames per map run the real
actors through the original constructor, Setup and OccludeBsp against
occ_setup and occ_run: Frame->Sprite and every sprite's span buffer match
(1,672 of 9,725 set-up sprites drawn).

## Play

The simulation side runs OccludeBsp for the main frame every Play frame
(`sim-session.mjs` `visibility`, in the worker by default), with
SetupDynamics' sprites (below): the master frame
from PlayerCalcView's location, rotation and FOV at the render viewport's
size, each zone's SkyZone presence (the zone's actor, else the LevelInfo,
read from the running scripts), DrawWorld's frame counter (one per drawn
frame) and TimeSeconds, with ShowFlags 0x800 and ShinySurfaces set. The map's
model and each surface texture's PolyFlags are uploaded once
(`sim-host.mjs`). The frame's `visibility` carries the nodes whose polygons
the draw lists keep, the mirror requests' nodes and whether a sky frame was
made. Then:

* **World.** Each world triangle carries its BSP node
  (`buildSurfaceGeometry`, world batches). The main pass draws each world
  mesh through an index of its visible triangles in their own order
  (`world-visibility.mjs`). Each mirror and sky pass does the same with its
  own child frame's nodes ("Child frames"); with `?childFrames=off` they
  draw whole meshes.
* **Movers.** The moving brush tracker ([brush tracker](brush-tracker.md#play))
  filters every mover's polygons into the model: Update for each mover the
  level-actor pass admits runs before OccludeBsp, the main pass draws a
  mover's polygons the draw lists hold (so closed doors occlude), and
  nothing stamps a tracked mover. `?moverTracker=off` keeps them out of the
  BSP, drawn whole and frustum-stamped.
* **Mirrors.** The mirror passes are OccludeFrame's mirror child frames, at
  every depth (`planFramePasses`, "Child frames"). With
  `?childFrames=off`, the main frame's children are the groups OccludeBsp
  requested (`requestedGroup`, mover mirrors by their tracked polygon), and
  deeper levels keep the frustum test.
* **Sky.** The sky frame is drawn only when OccludeBsp made one. It draws
  its own child frame's world, sprites and actors, and so does a sky frame
  inside a mirror frame.
* **Fog.** Only drawn surfaces get a fog map, as SetupForSurf does.
* **Actors.** The run waits for SetupDynamics' candidates (`occludeMain`):
  after the sprite scan (`sprite-scan.mjs`: DT_Sprite actors and
  render-iterator items, each with its Level.Actors order) and the actor
  layer's reads (`actor-mesh-sim.mjs` `update`: `mesh_reads`, then the
  `occlude` callback before any binding is posed).
  `dynamics-candidates.mjs` merges, in Level.Actors order, the bindings the
  root frame admits (the iterating actors left out), the iterator items'
  bindings (their snapshot's Location, Rotation and DrawScale) and the
  sprite records, packs each as Setup's candidate (`packSetup`: the
  binding's block words, else its accessors; a mesh record once per mesh)
  and OccludeBsp gives `Frame->Sprite`'s keys (option 0x200: no span
  buffers in the output). The main frame then draws and stamps exactly
  those actors: a binding outside it is not posed or lit (or, when mirrors
  may draw, it is posed for their passes only), a sprite record carries
  `main` for the page's main pass (`sprite-scene.mjs` `mainPass`), and
  `stamps()` writes LastRenderTime for every `Frame->Sprite` actor, as
  DrawActorSprite does, the items' proxies included. The mirror and sky
  passes draw and stamp their own frames' Frame->Sprite ("Child frames";
  the frustum-tested set with `?childFrames=off`). A drawn binding's
  mesh groups outside the frustum are still left out of the draw (no pixels
  either way). `?actorOcclusion=frustum` (Node: `ACTOR_OCCLUSION=frustum`)
  restores the frustum-tested drawn set for the main frame and runs
  OccludeBsp in `begin()` as before.

Measurements on the Linux host (1920×1080, interleaved runs):

| View | Before | After |
| --- | --- | --- |
| Paris Club spawn, down the tunnel (yaw 32768) | 15 fps, 65.6 ms; 5,632 mirror and 1,386 main calls; fog 11.8 ms | 59 fps, 15.8 ms; 224 mirror and 264 main calls; fog 0 |
| Paris Club spawn, yaw 40960 | 18 fps, 55.5 ms | 50 fps, 19.6 ms |
| UNATCO Island start, worker mode, page frame | 13.4–13.9 ms; 1,068 mirror calls | 8.4–8.8 ms; 268 mirror calls |

The tunnel's remaining mirror passes were DeusExMover8 and DeusExMover11,
mover mirrors, which the brush tracker now puts in the BSP (OccludeBsp asks
for them only when they are visible); the remaining main calls were actors,
which the dynamics now occlude (below).

With the dynamics (`profile-play-browser.mjs --no-profile --angle gl`,
UNATCO Island at Player start, worker mode, 1920×1080, 600 frames; three
interleaved rounds of each mode, medians; the simulation frame is the
worker's steps per snapshot):

| Island start | `?actorOcclusion=frustum` | Frame->Sprite |
| --- | --- | --- |
| Standing: simulation frame | 24.5 ms (tick 13.2, actors 6.3, sprites 1.5, stamps 0.8) | 14.2 ms (tick 7.8, actors 3.4 with Setup and OccludeBsp, sprites 0.4, stamps 0.1) |
| Standing: drawn frame interval; main draw calls | 25.6 ms; 411 | 16.7 ms (vsync); 82 |
| Walking: simulation frame | 27.9 ms (tick 15.0, actors 6.5) | 16.0 ms (tick 8.4, actors 3.3) |
| Walking: drawn frame interval; main draw calls | 29.0 ms; 397 | 17.1 ms; 63 |

The start view draws 10–11 mesh actors instead of about 300 (with the page's
simulation inline, about 29 → 18–21 ms per frame). The tick and the sprite
scan get shorter too, which fits the actors the main frame no longer draws
keeping an old LastRenderTime (stasis, LastRendered), the original's rule;
that part is not broken down further. The drawn set's own cost (pose
planning, lighting, stamps) shrinks with the set. (The frustum column's tick
includes OccludeBsp, which `begin()` runs there; with the dynamics it runs
inside the actors step.)

Pixels: deterministic runs (`validate-sim-split.mjs`, base build against
this) give identical state digests; the last frames differ in 169 of about
920,000 pixels on Island and 30 on Training, single pixels along polygon
edges where the span rasterizer and the GPU disagree and the original's
verdict now applies. Worker and inline modes give the same digests and
pixels. Training's entrance floor mirror still reflects.

With the dynamics: `?actorOcclusion=frustum` against the previous commit
gives identical digests and the same last frame on Island and Training (240
frames walking, inline), so the switch restores the old behavior exactly.
Frame->Sprite against the frustum set draws identical pixels at the start of
Island (frame 2, and frame 60 walking), Training and the Paris Club spawn;
Training's 240-frame walk gives the same digests as before, while Island's
differ from frame 60 on (other LastRenderTime stamps, then stasis). Worker
and inline modes give the same digests and pixels standing on Island (240
frames). Walking on Training they matched in two of five runs; in the other
three the last checkpoint (frame 240) differed, once between two inline runs
as well, and a per-actor comparison of such a case found only the player's
state different (the previous commit matched in its one run there). Walking
on Island they differ at one checkpoint in both this build and the previous
commit (frame 180 there), a host divergence that predates the dynamics.
These run-to-run differences are not resolved. validate-gpu-mesh,
validate-mirrors-play (also with `?simVerify=1`), validate-lasers-play and
validate-particles-play pass.

## Child frames: cost

Child frames against `?childFrames=off` (the frustum passes). The A/B runs
`profile-play-browser.mjs --no-profile --angle gl` in worker mode at
1920×1080 for 600 frames, with 3 interleaved rounds and the mode order
alternating by round. Values are medians, on the Linux host, measured on
2026-10-07. Other agents were running throughout, with a load average of
3 to 16.

**Views.**
- **Island:** the start, where the sky child frame is drawn.
- **Club spawn:** 10_Paris_Club's start turned to yaw 32768 (rotation
  only). No child frame is requested at any spawn yaw, checked every 4,096.
- **Club mirrors:** the bar's two mirrors (surfaces 231 and 232) from
  `[-122,-1008,60]`, yaw 0.
- **Smug:** facing DeusExMover7's mirror.
- **Training:** facing the entrance floor mirror.

Draw calls are per drawn frame.

| View | Worker frame | Page total | Page mirror passes | Mirror draw calls | Sky draw calls |
| --- | --- | --- | --- | --- | --- |
| Club mirrors | 9.9 against 16.8 ms | 6.2 against 18.6 ms | 2.1 against 12.0 ms | 29 against 605 | — |
| Smug | 8.8 against 14.0 ms | 3.0 against 5.6 ms | 1.1 against 3.2 ms | 29 against 191 | — |
| Training | 8.7 against 13.4 ms | 3.5 against 10.8 ms | 1.3 against 4.4 ms | 17 against 268 | — |
| Island | 19.5 against 20.0 ms | 3.5 against 3.1 ms | — | — | 5 against 8 |
| Club spawn | 8.3 against 8.6 ms | 3.2 against 3.0 ms | — | — | — |

- **Mirror views.** A mirror pass draws only its frame's visible polygons,
  mover fragments and Frame->Sprite, which cuts its draw calls by 7 to 21
  times.
- **Worker.** Only the original's Frame->Sprite actors are stamped now,
  instead of everything in the mirror frustums, so fewer actors count as
  rendered. The actor and tick phases shrink with them. That the cause is
  work gated by LastRenderTime is inferred; the work was not traced.
  - Club mirrors (medians): actors 2.1 against 4.0 ms, tick 5.2 against 8.6 ms, the
    mirror planning 0.15 against 0.96 ms.
  - Training (medians): actors 2.2 against 3.8 ms, tick 3.9 against 6.2 ms.

  That is the original's behaviour (only DrawActorSprite stamps), not a
  host saving.
- **Island.** The earlier 18.1 against 14.5 ms (two partial rounds, with
  child frames always run first) was host load.
  - In those runs every worker phase scaled by the same 1.3 to 1.7 times,
    including tick, HUD and audio, which child frames do not touch. The
    third run of the same mode measured 13.9 ms.
  - With the mode order alternating, the medians are 19.5 against 20.0
    ms, and the phase ratios match, for example actors to tick at 0.49 to 0.52
    in both modes.
  - The worker's own `visibility()` timing (`moverProbe`, 120 samples per
    load, 3 interleaved loads per mode) puts OccludeBsp with its decode
    and the sky child frame at 2.1, 2.1 and 2.8 ms, against 2.2, 2.3 and
    2.3 ms without the child. The worker clock has a 0.1 ms step, so the
    sky child frame's OccludeBsp, SetupDynamics and decode cost less than
    that resolution.
  - The mirror planning phase reads 0.20 to 0.24 against 0.14 to 0.19 ms:
    the frame passes plan the sky pass from its frame, about 0.04 ms of
    host work.
- **Club spawn.** No child frame is in view, so the modes match within
  noise.

## What is left

In recommended order. Each step keeps the rule above: recover from the
DLL, port to Rust, match the original under `native-occlusion-oracle.py`,
then wire into Play.

### 1. Child frames (done)

Ported and in Play on 2026-10-07 ("Child frames" above). Each child frame's
own fog maps followed the same day ([volumetric fog](volumetric-fog.md),
"Play"). What remains: actor meshes in a sky frame inside a mirror frame,
each frame's own iterator items, and a measured FPTAN for the 24-bit
argument.

### 2. The moving brush tracker (done)

Ported and in Play on 2026-10-06: [brush tracker](brush-tracker.md). The
tracker is bit-equal to Engine's over 239 oracle steps, and OccludeBsp over
the models it builds matches the original with Engine's SurfIsDynamic on
four maps. Decals and fog on movers followed on 2026-10-07; its own open
items are collision (Stage 5) and SaveGame (Stage 6).

### 3. Smaller items

* LeafVolumetricLighting and the draw lists' Volumetrics (fog light lists).
* Restricting texture and light-map animation to drawn surfaces, as the
  original does (`world.updateTextureAnimation` notes it).
* The 24-bit render precision also applies to earlier translations of code
  inside DrawWorld that were validated at 0x037f: render admission and mesh
  bounds, dynamic and mesh lighting.
* The main frame's actors: SetupDynamics' bHighDetail rule and the render
  iterators other than ParticleIterator and LaserIterator (the sprite
  scan's limits); an actor the page has no mesh binding or decoded sprite
  texture for is not a candidate, so it is neither drawn nor stamped (as
  before); the sprites' LeafLights and Volumetrics (fog on actors) are not
  read from the dynamics yet. (A frame's own moving-light LeafLights for
  mesh lighting are: main and child frames each filter SetupDynamics'
  candidates by their ViewPlanes, mesh-lighting-view.mjs `childFrame`; a
  child frame's DrawLodMesh detail choice, pose and Volumetrics are the
  main frame's, as before.)

Explicitly unsupported: WarpZoneInfo portals (none in the single-player
maps), span-based render devices, AMD3DClipBspSurf, frames taller than the
2880 raster lines (`0x10b50c08..0x10b56608`), and values outside binary32's
normal range.
