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
  assumes.
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
sprite's rectangle and Z from the host. The reference calls the original
FDynamicSprite constructor with Setup supplying the same values, then
OccludeBsp, and reads `Frame->Sprite` with each sprite's span buffer.
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
Each frame also carries up to 23 random sprites (1,598 in all, 418 drawn):
`Frame->Sprite`'s order and every sprite's merged span buffer match. During development
the same comparison also passed 360 more frames on Paris Club, Training,
Island, Wan Chai Market, Area 51 Page and Hotel, and 360 arbitrary-position
frames on six maps including AirfieldHeliBase, Endgame4 and DXOnly, with 122
zone-0 views and 203 mirror requests.

The Paris tunnel at spawn, looking down the tunnel (yaw 32768), draws 6
surfaces, creates no child frame and stamps no other zone. The frustum-only
browser path drew the club behind the walls there: five mirror passes and
1,105 fog surfaces.

The port takes 0.2–0.8 ms per frame in Node (Wasm), against 30–200 ms for the
emulated original.

## Play

The simulation side runs OccludeBsp for the main frame every Play frame
(`sim-session.mjs` `visibility`, in the worker by default): the master frame
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
  (`world-visibility.mjs`); the mirror and sky passes draw whole meshes,
  since child frames' own occlusion is not ported. Mover meshes always draw.
* **Mirrors.** The main frame's mirror children are the static mirror groups
  OccludeBsp requested (`mirror-passes.mjs` `requestedGroup`), on the page
  and in the drawn set alike; deeper levels and mover mirrors keep the
  frustum test.
* **Sky.** The sky frame is drawn only when OccludeBsp made one.
* **Fog.** Only drawn surfaces get a fog map, as SetupForSurf does.

Measurements on the Linux host (1920×1080, interleaved runs):

| View | Before | After |
| --- | --- | --- |
| Paris Club spawn, down the tunnel (yaw 32768) | 15 fps, 65.6 ms; 5,632 mirror and 1,386 main calls; fog 11.8 ms | 59 fps, 15.8 ms; 224 mirror and 264 main calls; fog 0 |
| Paris Club spawn, yaw 40960 | 18 fps, 55.5 ms | 50 fps, 19.6 ms |
| UNATCO Island start, worker mode, page frame | 13.4–13.9 ms; 1,068 mirror calls | 8.4–8.8 ms; 268 mirror calls |

The tunnel's remaining mirror passes are DeusExMover8 and DeusExMover11, mover
mirrors waiting for the brush tracker; the remaining main calls are actors,
whose occlusion waits for the dynamics.

Pixels: deterministic runs (`validate-sim-split.mjs`, base build against
this) give identical state digests; the last frames differ in 169 of about
920,000 pixels on Island and 30 on Training, single pixels along polygon
edges where the span rasterizer and the GPU disagree and the original's
verdict now applies. Worker and inline modes give the same digests and
pixels. Training's entrance floor mirror still reflects.

## What is left

In recommended order. Each step keeps the rule above: recover from the
DLL, port to Rust, match the original under `native-occlusion-oracle.py`,
then wire into Play.

### 1. Setup: each actor's screen rectangle (next)

The dynamics port takes `(rectangle, Z)` per sprite; Play needs Setup
(`FDynamicSprite::Setup`, `0x10b23910`) to produce them, at 24-bit
precision. Recovered so far:

* **Mesh path** (DrawType 2 with a Mesh). Z = `((L.z−O.z)·Zz + (L.y−O.y)·Zy)
  + (L.x−O.x)·Zx` (Location, Coords origin and ZAxis), stored to the sprite;
  below −0 or unordered rejects unless RendMap is 13–15. Then
  `Mesh->GetRenderBoundingBox(Actor, 0)` (vslot 0x5c; ULodMesh inherits
  UMesh's `0x103a6850`), then `BoundVisible(Frame, box, NULL)` (vslot
  0x80, already ported in `occlude.rs`), then `X1 = _ftol(MinX)`,
  `X2 = _ftol(MaxX)`, `Y1 = _ftol(MinY)`, `Y2 = _ftol(MaxY)` of the clamped
  bounds; Setup returns `Y1 < Y2`.
* **GetRenderBoundingBox** (`0x103a6850..0x103a6b9b`). `src/runtime/
  render-mesh-bounds.mjs` has its operation order at 64-bit precision; at
  24 bits every intermediate is a binary32 operation in that order. One
  difference from that JavaScript: the two frame boxes are combined with
  Core `FBox::operator+=` (`0x101196a0`), which copies the second box
  whenever **either** box is invalid (the JavaScript keeps the first when
  only the second is invalid). Min takes `this <= other ? this : other`,
  max `this < other ? other : this`.
* **Sprite path** (DrawType 1 or 7, `0x10b23ada..0x10b23d94`). Texture null
  rejects. Z as above. `URender::Project` (`0x10b20750`, vslot 0x78):
  T = (V − Origin) through Coords, Z' = T.z, plus 0.02 when |T.z| < 0.01;
  RZ = Proj.Z / Z'; ScreenX = T.x·RZ + FX2, ScreenY = T.y·RZ + FY2;
  Persp = RZ; it fails when Z' ≤ 1. Half width
  `hw = ((float)USize·DrawScale)·Persp·0.5f`; `X1 = appCeil(ScreenX − hw)`,
  `X2 = appCeil(hw + ScreenX)` (Core `0x10123300`: msvcrt `ceil` on the
  double, then an int → float → int round trip); swap if X1 > X2; X1 < 0
  sets X1 = 0 and then X2 < 0 sets X2 = 0; X2 > Frame.X sets X2 = X and then
  X1 > X sets X1 = X; reject when X2 ≤ 0 or X1 ≥ X − 1. Y likewise with
  VSize, clamped to Frame.Y; reject when Y2 ≤ 0, Y1 ≥ Y or Y1 ≥ Y2.
* **Inputs** for the Rust side: per mesh (once), its box, per-frame boxes
  (`runtime.prepareMesh(actor)`, array at UMesh `+0xa8`), Scale, Origin,
  RotOrigin; per actor and frame, Location, Rotation, DrawScale, PrePivot,
  bParticles (`+0x194 & 4`, factor 1.5), the resolved animation sequence
  (start frame, frame count) and AnimFrame; per sprite, its texture's
  USize/VSize and DrawScale.
* **Reference**: run the real Setup in the oracle with actor and mesh
  fixtures (the BoundsOracle in `native-render-visibility-oracle.py` already
  drives GetRenderBoundingBox that way), at control word 0x007f, with a stub
  for msvcrt `ceil`.

### 2. SetupDynamics' scan and Play's actors

SetupDynamics (`0x10b22d90`) admits actors in Level.Actors order
([render visibility](render-visibility.md) has the admission rules); the
excluded actor is the view target in a first-person master frame
(OccludeFrame). The simulation side already scans in that order with the
render iterators expanded (`sprite-scan.mjs`, the actor mesh layer); it
should hand the candidates to `occ_run` in that order. Then Play draws, and
stamps LastRenderTime for, the actors in `Frame->Sprite` instead of the
frustum-tested drawn set (`drawn-set.mjs`) for the main frame.

### 3. Child frames

CreateChildFrame (`0x10b15a40`, notes in `.work/occlude/frame-and-clip.md`:
reuse of an equal child, merged spans, ComputeRenderSize again at 24 bits)
and OccludeFrame's recursion into the children, newest first, so mirror
and sky views get their own visible polygons and sprites. The mirror
child's coords and near-clip plane are already verified
([mirror surfaces](mirror-surfaces.md)); the sky child's are in
`.work/occlude/occludebsp.md` (step 14). Play then draws mirror and sky
passes from their own results instead of whole meshes and the frustum.

### 4. The moving brush tracker

Engine's FMovingBrushTracker (Level `+0xfc`) inserts mover polygons into
the world BSP; OccludeBsp asks its vslot 3 (SurfIsDynamic) to skip bound
tests. Without it closed doors do not occlude, and mover mirrors (the two
still drawn in the Paris tunnel, DeusExMover8 and DeusExMover11) keep the
frustum test. Known entry points ([lighting](lighting.md),
[mirror surfaces](mirror-surfaces.md) "Coplanar mover polygons"):
construction `0x1037ac40`/`0x1037b5c0`, Update `0x1037a400`, filter
`0x1037c0c0`, node add `0x1037bb00`, `FPoly::SplitWithPlane` `0x10386ad0`
(±0.25). Still open: when Update runs (tick or render pass, hence its
precision), how it removes the previous fragments, and the new nodes' field
values.

### 5. Smaller items

* LeafVolumetricLighting and the draw lists' Volumetrics (fog light lists).
* Restricting texture and light-map animation to drawn surfaces, as the
  original does (`world.updateTextureAnimation` notes it).
* The 24-bit render precision also applies to earlier translations of code
  inside DrawWorld that were validated at 0x037f: render admission and mesh
  bounds, dynamic and mesh lighting.

Explicitly unsupported: WarpZoneInfo portals (none in the single-player
maps), span-based render devices, AMD3DClipBspSurf, frames taller than the
2880 raster lines (`0x10b50c08..0x10b56608`), and values outside binary32's
normal range.
