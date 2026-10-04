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
child-frame requests with their spans match bit for bit. During development
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

## Not yet ported

Explicitly unsupported or pending:

* The master frame is taken from the original in the validator; the Play
  frame producer (ComputeRenderSize's ViewSides and Prj fields) is pending.
* Dynamics: SetupDynamics sprites, FDynamicChunk filtering and
  FDynamicFinalChunk::PreRender, hence `Frame->Sprite` and actor
  LastRenderTime. The model's `Dynamics` lists are empty.
* Child frames: CreateChildFrame and the children's own OccludeBsp (mirror
  and sky). Requests are reported with their spans.
* The moving brush tracker (Level `+0xfc`): movers' polygons in the BSP.
* LeafVolumetricLighting and the draw lists' Volumetrics.
* WarpZoneInfo portals, span-based render devices, AMD3DClipBspSurf, frames
  taller than the 2880 raster lines (`0x10b50c08..0x10b56608`), and values
  outside binary32's normal range.
