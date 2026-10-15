# Frame projection: the vertices the render device receives

Started 2026-10-14. Play used to draw world polygons and meshes with three.js's
own matrices. The original projects every vertex in Render.dll (the frame's
Coords and FX/FY/Proj terms at the render pass's precision control 24) and
hands screen-space vertices to D3DDrv.dll, which adds the frame's offset and a
depth. This page records that chain with addresses, the oracle that runs it
unchanged, the port, and what Play now does.

Authority: Render.dll `607f1077…d75d1`, D3DDrv.dll `9e0f8a42…d8ac9f`,
Engine.dll `0c3a8b18…c20b4` (SetRes and the frame's layout from the SDK
headers, `scripts/sdk-layouts.mjs`, checked against the DLLs). Addresses are
virtual addresses at each DLL's preferred base. The Unreal Tournament public
D3DDrv source (`Reference/`) was read for names only; every constant here is
from the retail DLL.

## The original's chain

`FSceneNode` (Engine, SDK `UnRender.h`): Coords `+0x34` (Origin, XAxis, YAxis,
ZAxis), X `+0xa8`, Y `+0xac`, XB `+0xb0`, YB `+0xb4`, FX15 `+0xc0`, FY15
`+0xc4` ((SXR + 1.0001) / 2), Proj `+0xd4` (Proj.Z `+0xdc`), RProj `+0xe0`
(RProj.Z `+0xe8`). `FTransform` (Render): X, Y, Z `+0x0`, Flags `+0xc`,
ScreenX `+0x10`, ScreenY `+0x14`, IntY `+0x18`, RZ `+0x1c`. Child frames copy
X, Y, XB and YB from their parent (`CreateChildFrame` `0x10b15cba–0x10b15cf0`)
and run ComputeRenderSize again.

**1. View space (Render.dll).**

| What | Addresses | Operations (each rounded at precision 24) |
| --- | --- | --- |
| BSP vertex, ClipBspSurf `0x10b14cb0` | `0x10b14de2–0x10b14e42` | `d = P - Origin` (three `fsub` of `[Frame+0x34..0x3c]`), then per axis `(d.x*a.x + d.y*a.y) + d.z*a.z`; X, Y, Z stored at `0x10b14e3d`, `0x10b14e3f`, `0x10b14e42` |
| Outcodes | `0x10b14e45–0x10b14eeb` | the sign bits of `Z*PrjXM + X`, `Z*PrjYM + Y`, `Z*PrjXP - X`, `Z*PrjYP - Y` |
| Mesh vertex, DrawLodMesh `0x10b0ea80` | none: GetFrame's buffer is already in the drawing frame's camera space (`0x10b0edd8–0x10b0ee0f`, [LOD](script-lodmesh-lod.md#camera-space-the-coords-getframe-is-called-with-0x10b0ed530x10b0ee0f)) | the outcodes of one vertex `0x10b0efd3–0x10b0f073` |

**2. Projection (Render.dll).** `RZ = Proj.Z / Z` (`fdiv [esi+0xdc]` by Z,
stored at `[pt+0x1c]`), `ScreenX = X*RZ + FX15`, `ScreenY = Y*RZ + FY15`, IntY
the fistp of `ScreenY - 0.5`. ClipBspSurf (`0x10b14ea3–0x10b14f20`; clipped
points `project_clip`, the same operations), DrawLodMesh for a vertex whose
flags are zero (`0x10b10a53–0x10b10a96`; the earlier loop `0x10b0f8e8–0x10b0f929`
projects the points with Z > 0), DrawTriangle's clipped points (`0x10b0c432`),
ClipDecal (`0x10b1c768`). The rasterizer `0x10b19cc0` rewrites a polygon's
ScreenY and IntY to the clamped integer row only when a point's IntY is below 0
or past the frame (`0x10b19dd1–0x10b19e10`).

**3. The vertex (D3DDrv.dll).** `DrawComplexSurface` `0x10003900` (thunk
`0x10001181`), `DrawGouraudPolygon` `0x100056b0` (thunk `0x10001113`):

* X = `(XB + ScreenX) - 0.5` (`fild [Frame+0xb0]`, `fadd [pt+0x10]`, `fsub`
  the 0.5 at `0x1001864c`: Direct3D's integer pixel centres), Y likewise from
  `+0xb4`, `+0x14` (`0x10003c05–0x10003c1d`, `0x10004042–0x10004064`,
  `0x10005833–0x10005855`).
* RHW = `RZ * RProj.Z` (`fld [pt+0x1c]`, `fmul [Frame+0xe8]`; DrawGouraudPolygon
  multiplies once more by 1.0, or 0.25 when `GUglyHackFlags & 1` on a 16-bit
  viewport, `0x100057ea–0x10005806`).
* Depth = `RHW * _43 + _33` (`fmul [dev+0xa40]`, `fadd [dev+0xa30]`:
  `0x10003c32–0x10003c41`, `0x10004073–0x1000407f`, `0x10005857–0x10005869`).
* The vertex is `{X, Y, depth, RHW, colour, specular, u, v}` for
  `DrawPrimitiveVB(D3DPT_TRIANGLEFAN)`: 0x24 bytes for DrawComplexSurface's
  single-texture path, 0x20 for DrawGouraudPolygon. Pre-transformed vertices:
  the device's own transform and clipping are not applied (`CLIPPING` false).
* DrawTile (`0x10005ba0`, sprites and tiles) uses RHW = `1.0 / Z`, depth the
  same, and X = `(XB - 0.5) + x` (`0x10005c41–0x10005c95`). Sprites reach it through
  the canvas; ported 2026-10-15, see [Sprites](#sprites-the-tile-the-render-device-receives).

**4. The device's depth.** `UD3DRenderDevice::SetRes` (`0x1000a4d0`), block
`0x1000c40f–0x1000c45b`: `far = 32767` (`0x10018d00`), or 8192 (`0x10018cfc`)
when `ViewportColorBits` (`[dev+0xe0]`) is 16; `_33 = far / (far - 1)`
(`fdivr` `0x1000c439`, stored `[dev+0xa30]` at `0x1000c43b`), `_34 = 1.0`,
`_43 = -_33` (`fchs` `0x1000c453`, stored `[dev+0xa40]`), `_44 = 0`, then
`SetTransform(PROJECTION)` (device vtable `+0x2c`, `0x1000c46a`). Measured
under Unicorn: `_33` = `0x3f800100` (32767/32766 as binary32), `_43` =
`0xbf800100`. The viewport (`0x1000bb8b–0x1000bbd3`, `SetViewport` vtable `+0x34`) is
`{.., .., ViewportX `[+0xd4]`, ViewportY `[+0xd8]`, MinZ 0.0 `0x1000bbb7`, MaxZ 1.0
`0x1000bbc1`}`, so a vertex's depth is the depth-buffer value. The vertex depth is
therefore `_33 * (1 - 1/Z)`: a perspective projection with near plane 1 and
far plane 32767 over the device's [0, 1] depth range. Z-function LESSEQUAL;
masked surfaces' later passes use EQUAL (`0x10003e09`, `0x10004203`), and
the light-map and fog passes set `D3DRENDERSTATE_ZBIAS` 15 around their
overlay; decals draw with no depth bias ([decals](decals.md#drawing)). The pass
that clips each polygon at view depth 380.0 (`0x43be0000`, `0x10004880`) before
building its vertices (`0x100048b9–0x10004cda`, ZBIAS 15 at `0x10004a00`, back to 0
at `0x10004d01`) is the **detail-texture** pass (`FSurfaceInfo.DetailTexture`, `+0x18`),
not the fog map's (`+0x1c`, `0x10004d39`), which has no depth clip; this was
mislabelled until 2026-10-15. Play does not draw detail textures:
[Detail textures](#detail-textures-the-pass-play-does-not-draw-2026-10-15).

## The oracle

`scripts/native-frame-projection-oracle.py` loads the occlusion oracle
([BSP occlusion](bsp-occlusion.md)) and D3DDrv.dll into one Unicorn
emulation at the render pass's control word `0x007f`:

* **BSP.** CreateMasterFrame, the render pass's ComputeRenderSize and
  OccludeBsp (ClipBspSurf, Sutherland-Hodgman, the rasterizer) on a map; then
  the unchanged `DrawComplexSurface` over each draw list's saved polygons (its
  Engine `FSurfaceFacet`), once per frame, main and every child frame. Only
  `SetTexture` (`0x100010a5`), `SetBlending` (`0x1000103c`) and the Direct3D COM
  objects are stubs: `Lock` returns a vertex buffer, `Unlock` and
  `DrawPrimitiveVB` return success. The vertex buffer is read back. Each point
  also reports the model point it was transformed from (the point cache entry),
  or -1 for a clipper-made point.
* **Meshes.** DrawLodMesh's outcode block and vertex projection on camera-space
  points (`0x10b0efd3–0x10b0f076`, `0x10b10a53–0x10b10a96`), then the
  unchanged `DrawGouraudPolygon`.
* **Depth.** SetRes' block `0x1000c40f–0x1000c45b` at 32 and 16 bits.

`scripts/validate-frame-projection.mjs` replays seeded cameras on the Island
and the Paris club (cameras aimed at its mirror polygons, so child frames
occur; render rectangles on two cases in three) against
`src/runtime/frame-projection.mjs` (binary32 per operation):

| | |
| --- | --- |
| Frames | 53 (31 main, 22 mirror and sky child frames), 989 draw lists, 1,839 polygons |
| FTransform points | 8,963: 7,129 model vertices, 1,834 clipper-made |
| Model vertices | view point, RZ, ScreenX, ScreenY and the vertex buffer's X, Y, depth and RHW equal the reference **bit for bit in all 7,129** |
| Clipper-made points | D3DDrv's conversion of their FTransform equals the reference (1,834); the clip itself is OccludeBsp's, validated by [validate-bsp-occlusion](bsp-occlusion.md) |
| Rasterizer Y clamp | did not rewrite a ScreenY in any of the 8,963 points (1,834 of them on the clip planes): IntY of the clipped points stays in [0, Y], consistent with the 1.0001 margin of FX15 = (SXR + 1.0001)/2; it is not ported |
| Meshes | 2,560 camera-space points, 673 inside the frustum (flags 0): projection and vertex bit-equal |
| Depth | `_33`, `_43`, `_34` of the 32-bit and 16-bit SetRes equal `depthConstants` |

The same validator evaluates the page's former path (three.js camera
posed from the rotator's angles, near 1, far 65536, `projectionMatrix *
modelViewMatrix` in binary32 without fused operations) on the 4,528 model
vertices of its 31 main frames and must **fail** on it:

| Against the device's vertex | previous camera | camera posed from the frame's Coords, far 32767 |
| --- | ---: | ---: |
| X differs in at least one bit | 4,070 of 4,528 | 2,687 |
| Y or X, pixel error p50 / p99 / max | 0.164 / 0.448 / 0.624 | 0.00006 / 0.0005 / 0.0035 |
| depth differs | 4,528 of 4,528 | 1,323 (max 1.2e-7 = 2 ulp; was 1.8e-5) |
| adjacent vertices in the original's depth order (24-bit quantized) whose order or tie differs | 57 of 4,500 | 59 of 4,500 |

The last row counts depth-test outcomes between vertices: neighbours the
device's 24-bit depths order or tie one way and the host's the other. They are
a depth unit apart (the host's float32 evaluation of the same plane), which a
LESSEQUAL test with overlapping coplanar polygons turns into stripes; the chain
reproduces the device's depth, so none differ on its path.

The dominant error was not rounding: the original's orientation comes from
ComputeRenderCoords' sine tables, not the rotator's exact angles, and the
frame's Coords differ from the exact rotation by up to 0.3 pixel at 1440 wide.

## The port

* `src/runtime/frame-projection.mjs`: the CPU reference (`viewPoint`,
  `projectView`, `d3dVertex`, `depthConstants`, `frameOfWords`,
  `frameOfFields`). One `Math.fround` per x87 operation; correct for binary32
  operands because the double intermediate is wide enough (53 >= 2 * 24 + 2).
  `test/frame-projection.test.mjs` checks it against an independent BigInt
  round-to-nearest-even implementation.
* `src/viewer/frame-projection-glsl.mjs`: `fpView`, `fpVertex`, `fpClip`. Every
  rounded result goes through the barrier `B()` (gpu-mesh-glsl.mjs: the ANGLE
  backends fuse `a*b+c` and reassociate, GLSL ES 3.00 has no `precise`) and the
  one division is `divRN`, correctly rounded. `fpClip` returns the exact vertex
  as clip coordinates with `w` = view depth, so the rasterizer's divide and
  clipping act on it; a point nearer than view depth 1 takes the same mapping
  in its linear form. The mapping to normalized coordinates, the rasterizer's
  fixed-point snap and the depth buffer's format are the host's.
  `scripts/validate-frame-projection-gpu.mjs` runs the oracle's data through
  headless Chromium (ANGLE GL on this host's AMD Radeon 780M): **3,953
  vertices of 69 frames equal the device's vertex bit for bit**, the clip form
  divides back to the window within 1.5e-4 pixel and 3e-8 depth, and without the
  barrier 2,593 of the 3,953 differ.
* `src/viewer/play-camera.mjs`: the camera is posed from the pass frame's
  Coords (`setCameraCoords`, called by `setFrameProjection`) and its depth range
  is the device's (`PLAY_NEAR` 1, `PLAY_FAR` 32767) in every camera, so the
  coronas, which keep the camera's projection (decals since 2026-10-14 and sprites
  and particles since 2026-10-15 project through the chain; lasers are meshes),
  and the camera billboards of a pass without a frame, land within 0.004 pixel
  and 2 depth ulps of the world.
* `src/viewer/frame-projection.mjs`: the shared uniforms and `patch(shader)`,
  which replaces three.js's `project_vertex` with `fpClip(fpView(world))` (or,
  for GPU-path actor meshes, `fpClip` of the camera-space point). Applied to
  world surfaces (`applyLightAtlas`: static, mover, mirror and batched
  materials), the fake-backdrop depth mesh, the fog overlay and every actor mesh
  material, and (`patchSprite`, [Sprites](#sprites-the-tile-the-render-device-receives))
  sprite materials. `uFpOn` selects the chain per pass: the main frame, each mirror and
  sky child frame (its own Coords, projection and Frame->Mirror: a mirror child
  at odd depth flips X, as the page's sampling right to left expects), and the
  first-person weapon (the master frame). A pass without a frame (a
  ViewportWindow's, Inspect) projects with the camera.
  `?vertexProjection=off` and `deusExViewer.vertexProjection(false)` switch it.
* The simulation side hands the page each child frame's projection
  (`projectionOfFields`, `visibility().frames[].projection`) next to its Coords.

**Meshes (the LOD caveat).** A GPU-path mesh draws each corner's point from
`cameraFinal`, GetFrame's buffer in the frame that lights the actor, after the
LOD morph ([GPU mesh](gpu-mesh.md#camera-space-2026-10-14)), when its slot's
lighting stamp is this frame's or a later run's (`deusLitFrame`,
`deusLitRuns`): the invariant the corner colours already rely on. The
original's draw loop reads the same buffer. A corner without a valid buffer
(the CPU path, an unlit slot) projects its world pose through `fpView`.
The environment mapping and the culling spheres still read the world pose.

**The CPU mesh path** (`?gpuMesh=0`, or a binding that left the GPU path) draws
the same points. Its lighting already computes the buffer in every frame that
lights an actor (`cameraDrawn`: the cache poses published through that frame's
GetFrame matrix and the frame's LOD morph, [GPU mesh](gpu-mesh.md#camera-space-2026-10-14)),
so `relight` hands that buffer to the page next to the corner colours (the
record's and each child frame decision's `cameraPoints`). The page writes the
shown state's corners into a `deusCameraPoint` attribute whenever it applies a
frame's colours (`applyCamera`), and the vertex stage projects it with
`fpClip` exactly as the GPU path projects `cameraFinal`. The same invariant
holds: a frame that did not light the actor, or a state other than the one the
points were written for, draws the world pose through `fpView`. Before this the
CPU path projected the world pose in every frame, which rounds differently from
the buffer the original projects (a mirror child frame's meshes, 44 pixels of
the Bar mirror view in `validate-mesh-path-frames`); that validator again finds
the two paths' pixels identical.

**Overlays.** An overlay drawn over the same plane with LESSEQUAL (the fog
map; D3DDrv draws it with `ZBIAS 15`) must project with its surface's chain: with
the camera's matrices its depth differed by a depth unit and z-fought against a
surface on the chain (diagonal hatching in the Bar's mirror wall). The fog
mesh uses `patch` too, with its surface's vertices, so the depths are equal.

**Movers (2026-10-14).** The original draws a mover's polygons as nodes of the
level model, `Model->Points` as the moving brush tracker wrote them
([brush tracker](brush-tracker.md)): `FPoly::Transform` (Engine `0x10387360`,
`ret 0x10` at `0x10387754`; called by Update at precision 24 from
URender::SetupDynamics) turns each brush polygon's Base and Vertex[] by
`((V - PrePivot) through PointXform) + Location`, each operation stored as
binary32 (and reverses the vertices when the orientation is negative), and
AddNode (`0x1037bb00`, AllocPoint `0x1037cff0`) copies a fragment's vertices
unchanged into new `Model->Points` entries. ClipBspSurf then transforms those
points exactly as it does a level vertex (`0x10b14de2` on). Play used to pose a
mover mesh with the float32 product of its group matrix (`brushMatrix`, double
precision, then the GPU's `modelMatrix * position`) and the rest positions.
Now:

* `tracker.rs` keeps a host copy of each rebuilt mover's transformed polygon
  vertices (`M_XVERTS`: 3 words a vertex, polygons in order, in Transform's
  order, plus a revision and whether Transform reversed them; the original
  leaves them in the FMemStack until Update returns).
  `scripts/native-brush-tracker-oracle.py` hooks Transform's return and reports
  every polygon it ran on; `validate-brush-tracker` compares the copy with it
  bit for bit: **15,333 polygon outputs** over the 20 cases (Training, the club,
  Island, the Intro and the Ship, whose scaled -1 mover reverses its vertices,
  both control words), and a flipped bit is found.
* `sim-session.mjs` sends the vertices of the movers whose revision changed
  (`visibility().moverPoints`, all of them in the first frame and after
  Player start's rebuild) and `world.setMoverPoints` writes them, rest order,
  into each mover mesh's `deusTracked` attribute (Unreal's axes). Every mesh
  vertex knows its place among the brush polygons' vertices (`mesh.userData.tracked`,
  from `moverModelFromPolys` through `buildSurfaceGeometry`'s `sources`). A mover
  material (`applyLightAtlas(..., tracked)`) projects `fpClip(fpView(deusTracked))`.
  Without a tracker (`?moverTracker=off`, Inspect) or until the first points
  arrive the attribute holds the group matrix's product, as before; the matrix
  still poses everything else (culling, lights, mirror planes).
  `deusExViewer.moverVertices(false)` goes back to the matrix for a comparison.
* A polygon the BSP split draws whole with its own vertices: the fragments'
  vertices on the cuts are the tracker's (`SplitWithPlaneFast`) and interior to
  the polygon; see "Clipped polygons" below.

`scripts/validate-frame-projection-movers.mjs` runs the unchanged Render.dll and
D3DDrv.dll (the frame-projection oracle) over a level whose BSP holds the Rust
tracker's fragments (Training closed and its first double door raised, the club
with its mirror movers turned, Island), 54 cameras aimed at movers, main and
child frames:

| | |
| --- | --- |
| Mover fragments drawn | 299, of 124 polygons; 1,203 points |
| Model vertices through the chain | 1,063 equal D3DDrv's vertex bit for bit; 140 are the clipper's; none on the rasterizer's Y clamp |
| Drawn fragments of polygons the BSP left whole | 162; the 144 not cut by the frustum have exactly Transform's vertices (576 vertices; the polygon's own order in 141, reversed in 3: a polygon seen from its back) |
| Every fragmented polygon, the chains of all movers | 617 unsplit (the one fragment is Transform's vertices in order), 119 split or partly dropped (468 fragment vertices are Transform's, 800 are the tracker's cuts, none a hair from one of Transform's) |
| The page's earlier vertices (matrix times rest position) through the same chain, 757 polygon vertices | X differs from the device's in 30, depth in none; error p50 0, p99 1.2e-4, max 1.3e-3 pixel |
| Mutation | one flipped bit in each exported polygon is found |

So the earlier path was already within a thousandth of a pixel (doors are
translations, whose matrix products mostly round the same way); the change is
that the vertex is the original's, bit for bit, for turned movers too.

**Decals (2026-10-14).** ClipDecal (Render.dll `0x10b1bda0`) clips a decal's
lifted quad in world space against the saved polygon's edge planes, and its tail
turns each surviving point into an FTransform exactly as ClipBspSurf does a
level vertex: the clipped world point `P` (the array at `0x10b504b8`, stride
12) less Frame->Coords' origin and three axis dot products stored as X, Y, Z
(`0x10b1c5fd..0x10b1c65d`, the same `(dx*a.x + dy*a.y) + dz*a.z` as `fpView`);
the four outcode terms `Z*PrjXM + X`, `Z*PrjYM + Y`, `Z*PrjXP - X`,
`Z*PrjYP - Y` (Frame `+0xec..+0xf8`), each stored as binary32, whose sign
bits index the tables at `0x10b2aeb4..0x10b2aec0` (flags 4, 8, 0x10, 0x20;
nonzero when any is negative, -0.0 included) (`0x10b1c660..0x10b1c701`);
`RZ = Proj.Z / Z` (`0x10b1c6b8`); and for an unflagged point ScreenX and
ScreenY as everywhere (`0x10b1c70b..0x10b1c73b`). A **flagged** point takes a
second pass (`0x10b1c74c..0x10b1c825`) that recomputes RZ, ScreenX and ScreenY
the same way and **clamps** them to `[0.0, X - 1]` and `[0.0, Y - 1]`
(`fild Frame->X - 1`, the constant 0.0 at `0x10b2a5c4`; a point below zero
takes 0, one at or above the limit takes the limit); RZ keeps its unclamped
value. DrawFrame then hands the fragment to DrawGouraudPolygon (`0x10b1b286`,
flags `0x40`), whose vertex is the mesh vertex above (RHW = RZ * RProj.Z,
depth `RHW * _43 + _33`). The clamp moves only points on or past the frame's
edge (in the oracle's frames 119 of 1,192 fragment points are flagged and 64 of
those move, by up to 1.5 pixels).

* `src/viewer/frame-projection-glsl.mjs` `fpVertexDecal` and `fpClipDecal`
  (the outcode terms in `B()` barriers, the sign bits by `floatBitsToUint`);
  the page's frame carries PrjXM..PrjYP (`projection.prj`, ComputeRenderSize's
  fields 25..28; the uniform `uFpPrj`, which a frame without them sets so no
  point is flagged).
* `decal-scene.mjs` patches its modulated material with `patch(shader, { decal:
  true })`: the fragments' world points (decal-draw.mjs) project with the main
  frame's chain. Mirror and sky child frames draw no decals, as the original's
  ClipDecal returns nothing there; a ViewportWindow's decals keep the camera.
* `validate-decal-render` (the decal oracle, ClipDecal and the unchanged
  DrawGouraudPolygon, 762 cases, 1,192 fragment points in Training, Island and the
  club's mirror frames) now also compares the vertex buffer: the reference chain
  with the clamp equals D3DDrv's vertex bit for bit at all 1,192 points (**119
  flagged, 64 of them moved by the clamp, the largest 1.5 pixels**), and the
  GLSL `fpVertexDecal` on the GPU (headless Chromium through
  `scripts/frame-projection-gpu-run.mjs`, shared with the mesh and surface
  validator) equals it bit for bit too, its clip form within 1.5e-4 pixel.
* `scripts/validate-decal-vertices-play.mjs` (Training, worker mode): a frozen
  frame drawn with the chain and with the camera, decal layer on and off, at
  Jaime Reyes' shadow (1,563 decal pixels with the chain, 1,558 with the camera,
  7 differ), the same shadow at the frame's edge, and a BulletHole on a mover's
  fragment (29 pixels, identical coverage); the page's uniforms hold the master
  frame's PrjXM..PrjYP.

## Play

`scripts/validate-frame-projection-play.mjs` (worker mode, headless Chromium,
1024 x 640): a frozen frame drawn with the vertex stage on, off, on again, and
on with the frame's origin moved 8 units; PNG pixels compared.

| Map (views) | changed pixels, vertex stage vs camera | drawn twice | origin moved |
| --- | ---: | ---: | ---: |
| Island (5) | 1,262 of 2.7 M (0.05%, largest channel 18) | 0 | 1.87 M |
| Paris club (6; 4 mirror child frames) | 243 (0.007%) | 0 | 2.2 M |
| Hotel, Smugglers, Everett (10; 17 mirror child frames) | 600 (0.01%) | 0 | 3.7 M |
| Training (5; 24 mirror child frames, NPCs, the crowbar) | 551 (0.03%) | 0 | 1.2 M |
| Bar, conversation letterbox (5; 11 mirror child frames) | 260,671 (9.6%) | 0 | 1.4 M |

At 2 device pixels per CSS pixel (Island 5 views, Hotel 5 views, 2.18 M pixels
a view) the stage changes 3,180 and 1,643 pixels (0.03%, 0.015%; largest channel
164 on a single edge pixel); a frozen frame at that ratio has a noise of its own
(100 to 300 pixels in some views, the same with the stage off), so the
validator asserts the zero only at 1 pixel per CSS pixel.

`scripts/validate-mover-vertices-play.mjs` (worker mode, 1024 x 640, one device
pixel per CSS pixel) reads the tracker's vertices from the simulation side's
memory (`moverProbe({points: true})`) and the page's mesh attributes
(`moverVertexProbe`): every mover mesh vertex holds the tracker's point as float
bits (Training 1,800 of 1,800 vertices over 25 movers, Island 2,292 over 19, the
club 2,244 over 13, the Ship 17,538 over 85), each within 2.4e-4 units of the
group matrix's pose (which bounds the vertex order, reversals included); after
the probe moves one mover up and turns another the tracker rebuilds both (their
revisions grow) and the page's vertices follow, bit for bit; and in 11 frozen
views of movers (3 + 3 + 2 + 3, a view with an animated texture such as the Training
monitor's static is not a measurement and is skipped) drawing the meshes with
the group matrix's pose instead changes 0 pixels.

[Visual acceptance](visual-acceptance.md) (`scripts/visual-acceptance.mjs play`
then `compare` against the stored original frames, 1280 x 720, Training, Island,
Paris club, Battery Park, 20 views) with the stage on, off and before this work
(the 2026-10-07 report): mean absolute difference 1.916, 1.916, 1.915; edge recall
0.9705, 0.9705, 0.9701; edge precision 0.9162, 0.9162, 0.9157; no view moves by more
than 0.001 in recall or precision. Those metrics are pixel-level and do not resolve
the 0.16-pixel shift the Coords pose removed, the 0.01% of pixels the chain
moves, or a depth tie.

The Bar's mirror views are letterboxed (the conversation camera); the camera
path mapped the mirror child targets over the whole target instead of the
render rectangle, the chain maps the frame's rectangle into the target (viewport
= whole target, offset XB, YB), which is where the composite samples. The
unlettered views agree to 0.01%.

## Frame cost

(interleaved A/B on the Linux host, AMD Radeon 780M, worker mode, GPU path,
1440 x 960, 400 frames a run, medians, `profile-play-browser.mjs --gpu
--no-profile`, `?vertexProjection=off` against the default)

| Island's start, idle, 5 pairs | camera | chain |
| --- | ---: | ---: |
| page frame work | 3.43 ms | 3.42 ms |
| page render phase | 1.53 ms | 1.55 ms |
| page actors phase | 0.43 ms | 0.42 ms |
| GPU per frame | 1.87 ms | 1.86 ms |
| worker frame work | 15.82 ms | 15.87 ms |
| draw calls | 111 | 111 |
| frame interval | 16.7 ms (vsync) | 16.7 ms (vsync) |

| Training's start (mirror floor: 24 child frames, 18 NPCs), 4 pairs | camera | chain |
| --- | ---: | ---: |
| page frame work | 2.39 ms | 2.46 ms |
| page mirrors phase | 0.665 ms | 0.695 ms |
| GPU per frame | 1.805 ms | 1.880 ms |
| worker frame work | 7.37 ms | 7.54 ms |
| draw calls | 73 | 73 |

The vertex stage costs nothing measurable on the Island and 0.07 ms of GPU per
frame (4%) in the mirror-heavy scene, whose child passes each draw the world
again; the frame stays on vsync in both. Per vertex the chain is about
twenty barriered operations and one correctly rounded division (`divRN`).

**The CPU mesh path** (`?gpuMesh=0`; interleaved A/B against the commit before
the camera-space points, 5 pairs, worker mode, 1440 x 960, 300 frames a run, medians,
`ab-run`-style `framePhases` plus `meshLod()`, headless Chromium ANGLE GL on the same
host; the frame stays on vsync, 16.7 ms, in both):

| | Island's start | | Bar mirror view (Paris club, ghost at (78, -1008, 27)) | |
| --- | ---: | ---: | ---: | ---: |
| | before | camera-space points | before | camera-space points |
| page frame work | 3.32 ms | 3.42 ms | 4.64 ms | 4.75 ms |
| page actors phase | 0.40 ms | 0.47 ms | 0.23 ms | 0.22 ms |
| page mirrors phase | 0.02 ms | 0.02 ms | 2.00 ms | 2.09 ms |
| GPU per frame | 1.38 ms | 1.36 ms | 1.23 ms | 1.23 ms |
| worker frame work | 15.9 ms | 15.9 ms | 7.24 ms | 7.51 ms |
| worker actors phase | 4.50 ms | 4.55 ms | 2.10 ms | 2.07 ms |

About 0.1 ms of page work a frame on the reference path (one corner copy per
lit actor and frame, and the points in the worker's record).

## Sprites: the tile the render device receives

(2026-10-15.) A sprite is a screen-aligned textured rectangle, drawn after
Render.dll's projection of one point: the chain below is the original's, read
from the retail DLLs and run unchanged under Unicorn
(`scripts/native-sprite-draw-oracle.py`, `scripts/validate-sprite-tiles.mjs`).
It corrects the 2026-10-14 hand-off: the call at `0x10b254bd` goes through the
**canvas**, not straight to the render device.

1. **DrawFrame** (`0x10b1a2d0`) walks the frame's Frame->Sprite (`+0xa4`, the
   RenderNext chain, `0x10b1b3f6..0x10b1b44b`) once in its pass 1 and once in
   pass 2: a sprite whose actor Style is STY_Translucent (3) draws in pass 2,
   the others in pass 1 (a span-based device, `[RenDev+0x48]`, draws every
   sprite in pass 2), each through DrawActorSprite (thunk `0x10b011c2`, thiscall `(Frame,
   Sprite)`, `ret 8`) with the frame being drawn.
2. **FDynamicSprite::Setup** gave the sprite its camera-space depth Z (`+0x8`),
   projected centre ScreenX, ScreenY (`+0xa8`, `+0xac`) and scale Persp = RZ
   (`+0xb0`), plus the copies SetupSprite made of ScaleGlow (`+0xbc`) and
   DrawScale (`+0xc0`) ([BSP occlusion](bsp-occlusion.md#setup-each-actors-screen-rectangle)).
   They are now kept: the Rust sprite list is 9 words (key, rectangle, Z,
   ScreenX, ScreenY, Persp), the Frame->Sprite output carries Z and the three
   words after each key, `bsp-occlusion.mjs` returns them as `spriteScreens` for
   the root and each child frame, and `sim-session.mjs` hands every sprite
   record the values of each frame it draws in (`record.screens[frame] = [Z,
   ScreenX, ScreenY, Persp]`, frame 0 the root's). Each frame's Setup differs:
   a mirror or sky child frame constructs its own FDynamicSprite from its own
   Coords. `validate-sprite-setup` and `validate-child-frames` compare the Z and
   the three words of every drawn sprite with the original constructor, Setup
   and OccludeBsp (1,206 sprites of the root frames, the child frames of
   Training and Island), bit for bit.
3. **URender::DrawActorSprite** (`0x10b25080`), sprite path (DrawType 1, 7, or
   an actor-icon when the viewer's ShowFlags has 0x20, which Play never sets):
   stamps `LastRenderTime` with Level.TimeSeconds (`0x10b25150..0x10b25161`),
   takes Color = FPlane(1, 1, 1, -0) (an editor build tints a selected actor), and
   for ScaleGlow ≠ 1 multiplies the three channels by it and caps each at 1
   (`0x10b2524e..0x10b252a5`); the texture is `Texture->Get(CurrentTime)`
   (`0x10b2547b`, Engine `0x10301136`: Update, then AnimCur); the tile is
   `XL = (USize * Persp) * DrawScale`, `YL = (VSize * Persp) * DrawScale` (each
   product rounded at precision 24, `0x10b253c6..0x10b253e3`: not Setup's
   `(USize * DrawScale) * Persp`), `X = ScreenX - XL * 0.5`, `Y = ScreenY - YL *
   0.5` (`0x10b25481..0x10b254b9`, the 0.5 at `0x10b2a5c8`); PolyFlags =
   Texture.PolyFlags | the actor's style flags (`0x10b26230`: Style 2 -> 2, 3 ->
   4, 4 -> 0x40, bits of `+0x194`, `+0x15c` and the zone) | 0x100. It calls the
   canvas, `Viewport+0x5c`, vtable `+0x60` = **UCanvas::DrawIcon**(Texture, X,
   Y, XL, YL, Span = the sprite's span buffer `+0xc`, Z = `+0x8`, Color, Fog =
   FPlane(0, 0, 0, 0), PolyFlags).
   The viewer's `Sprite` field (`+0x168`, when the viewer IsA APlayerPawn)
   would replace the texture (`0x10b253e8..0x10b25418`); a Deus Ex player has
   none, so Play does not model it (the decal path's `Sprite` override is the
   same).
4. **UCanvas::DrawIcon** (Engine `0x10376640`, export thunk `0x10303f35`)
   calls vtable `+0x5c` = UCanvas::DrawTile(Texture, X, Y, XL, YL, 0, 0,
   (float)Texture.USize, (float)Texture.VSize, Span, Z, Color, Fog, PolyFlags).
5. **UCanvas::DrawTile** (Engine `0x10376160`, thunk `0x103019fb`): returns
   unless XL > 0, YL > 0, X + XL > 0, Y + YL > 0, X < FX and Y < FY (Frame =
   `Canvas+0x7c`, the frame the canvas was last updated with; FX, FY `+0xb8`,
   `+0xbc`). It clips the rectangle to [0, FX] x [0, FY], moving the source
   rectangle with it: for X < 0, `t = (X * UL) / XL`, X = 0, XL = X + XL, U = U -
   t, UL = UL + t; at the right, `d = FX - X`, and if XL > d, `UL = (((d - XL) *
   UL) / XL) + UL`, XL = d; the same for Y with V and FY (`0x10376236..0x103762f6`).
   Then Update(CurrentTime) and AnimCur (outside the editor), `Texture->Lock(Info,
   CurrentTime, LOD -1, RenDev)` (vtable `+0x54`; LOD -1 is
   `Client.TextureLODSet[LODSet]`, 0 with the installed High detail, raised to
   the render device's `+0x30` if that is larger: assumed 0, not measured),
   `f = (Info.USize * Info.UScale) / Texture.USize` (fild, fmul, fidiv at
   precision 24) multiplies U and UL, `g = (Info.VSize * Info.VScale) /
   Texture.VSize` V and VL (`0x10376357..0x103763a0`), PolyFlags |= Texture.PolyFlags
   & 2, and `RenDev->DrawTile(Frame, Info, X, Y, XL, YL, U, V, UL, VL, Span, Z,
   Color, Fog, PolyFlags)` (RenDev = `Viewport+0x64`, vtable `+0x7c`), then Unlock.
   At LOD 0 Info.USize is mip 0's, `Info.UScale = Info.VScale = Texture.Scale`
   (the packages' `DrawScale` property; `UTexture::Lock` `0x103ecc90..0x103ecd93`).
6. **UD3DRenderDevice::DrawTile** (D3DDrv `0x10005ba0`; the frame argument is
   the canvas' frame): SetBlending, SetTexture, then `RHW = 1.0 / Z`
   (`0x10005c41..0x10005c47`), `depth = RHW * _43 + _33` (`0x10005c65..0x10005c71`,
   the SetRes constants above), `X = (XB - 0.5) + x`, `Y = (YB - 0.5) + y`
   (`fild [Frame+0xb0]`, `fsub 0.5` at `0x1001864c`, `fadd`:
   `0x10005c74..0x10005c95`), and four 0x20-byte vertices `{X, Y, depth, RHW,
   colour, 0, tc0, tc1}` (`0x10005e46..0x10005f57`): (X0, Y0), (X0, Y0 + YL),
   (X0 + XL, Y0 + YL), (X0 + XL, Y0) with (U, V), (U, V + VL), (U + UL, V + VL), (U +
   UL, V) each scaled by the stage's UMult and VMult (`SetTexture`'s `1.0 /
   ((Size << mip) * Scale)`, `0x10008e63..0x10008e94`; stored at the stage's UIndex
   and VIndex slots, which swap when the texture is taller than wide:
   `0x10008e24..0x10008e49`: the D3D texture is transposed, the logical (u, v)
   are the same), `DrawPrimitiveVB(D3DPT_TRIANGLEFAN, VB, start, 4, 0)`.
   The same depth constants and Z buffer as the polygons: a sprite's Z is the
   exact camera-space depth, so its RHW is `1/Z` rather than `RZ * RProj.Z`.

**The oracle** runs 2 and 3..6 as written (the canvas is an object with
Engine's own UCanvas vtable; the D3D device, textures and SetTexture
bookkeeping are the decal oracle's) after the unchanged constructor, Setup and
OccludeBsp, in every frame including mirror and sky children.
`validate-sprite-tiles` on 00_Training, 01_NYC_UNATCOIsland and 10_Paris_Club
(27 cameras, 55 frames of which 27 children, 18 cameras on a render
rectangle): **864 sprites** through DrawActorSprite, DrawIcon and
UCanvas::DrawTile, all reaching D3DDrv's DrawTile (3,456 vertices); DrawActorSprite's
X, Y, XL, YL follow from Setup's floats as in 3 (bit for bit), DrawIcon's source
rectangle is the texture's size, `LastRenderTime` is stamped; 307 tiles lie
inside the frame, 333 are clipped at the left, 406 at the top, 360 at the
right, 385 at the bottom, 213 at all four, 132 are within 4 units of the camera,
338 are translucent. The map's own DT_Sprite actors are bHidden editor
icons, so the visible sprites are the runtime particle items (a ParticleProxy
per particle: two on Island's start) and effect sprites; the synthetic ones use those
textures and others (`scripts/sprite-tile-cases.mjs`).

**The port (2026-10-15).**

* `src/runtime/sprite-tile.mjs`: the CPU reference, one `Math.fround` per x87
  operation: `spriteIcon` (3), `canvasTile` (4 and 5: the clip and the U/V
  scale), `stageScale` and `deviceVertices` (6), `spriteVertices` for the chain.
  `test/sprite-tile.test.mjs` pins two sprites the original produced (one
  inside the frame, one larger than it and clipped).
* `src/viewer/sprite-tile-glsl.mjs`: `fpSpriteTile` and `fpSpriteVertex` with
  the barrier `B()` and the correctly rounded `divRN` (the divisions are `t =
  (X * UL) / XL`, `(((d - XL) * UL) / XL)`, the texture ratio, `1 / Z` and
  `1 / (Size * Scale)`).
* `validate-sprite-tiles` compares, for each of the 864 sprites, the port with the
  oracle stage by stage: UCanvas::DrawTile's clipped rectangle and scaled source
  rectangle, SetTexture's UMult, VMult and slots, and the four vertices' X, Y,
  depth, RHW and both texture coordinates (placed by the oracle's slots),
  **3,456 vertices equal bit for bit**; a bit flipped in the port is found
  (`--mutate`). The same sprites through the GLSL on the GPU (headless Chromium,
  ANGLE GL on this host's AMD Radeon 780M, `runGpuSprites` in
  `scripts/frame-projection-gpu-run.mjs`) give the same vertices, clipped
  rectangle and source rectangle **bit for bit for all 864**; without the barrier
  (`--no-barrier`) 342 of the 864 differ.
* **Play.** `sprite-scene.mjs` keeps three.js's `THREE.Sprite` per record; its
  material's vertex shader (`frameProjection.patchSprite`) builds the tile when the
  pass has a frame and the record carries the Setup floats of that frame
  (`record.screens[frame]`, set by `setFrame` in `mainPass`, `framePass` and
  `numberedPass`: the root's frame 0 for the main pass, the child frame's own for
  each mirror and sky pass, none for a ViewportWindow's or Inspect's) and feeds the
  vertex to `fpClipOf` like a world vertex (depth `RHW * _43 + _33`, the frame's
  offset and the mirror flip). A quad the clip rejects goes outside the clip volume.
  `?spriteTiles=off` and `deusExViewer.spriteTiles(false)` keep the billboards.
  Brightness and the display ramp are untouched (the colour is still the
  record's ScaleGlow).
* **Orientation (found by this work).** A texture's first row is its top (`S_Player`'s
  head is row 0; D3DDrv draws V = 0 at the top of a tile), and the page's textures are
  `DataTexture`s with `flipY = false` (row 0 at V = 0), but three.js's sprite quad has V
  = 1 at its top, so the billboards drew every sprite **upside down** against the
  original. The tile uses D3D's V; the billboard fallback now flips V too.
  `validate-sprite-tiles-play` (below) measures both with a probe texture.
* `scripts/validate-sprite-tiles-play.mjs` (worker mode, headless Chromium, 1024 x
  640, one device pixel per CSS pixel, 02_NYC_Street at ParticleGenerator3's vent and
  rotated 2,400 units either way so the smoke straddles the frame's edges; the
  frame frozen, the sprite scene no longer taking snapshots, one sprite at a time on
  the camera's layer): every sprite the main frame draws carries Setup's floats
  (9 of 9 in each view, 27 sprites), each drawn alone lies inside the reference tile
  and mostly fills it (7 of 9 fill over 30% of it; a nearer wall hides the rest: the
  tile's depth is the sprite's Z); with a probe texture (red first rows, green last
  rows) the first row is on top in the tile (red 134,400 pixels above the sprite's
  centre, 0 green; green 14,094 below, 0 red; the other two views alike) and in the
  billboard; the tile and the billboard of the same sprite differ in 1,102 of 148,494
  pixels (0.7%; 0.9% and 0.9% in the other views, the quad's edges); with the probe
  on all nine sprites the whole frame differs between tiles and billboards in 7,406 of
  288,710 sprite pixels (2.6%; 5,449 of 274,245 and 6,736 of 300,345). **Before** the
  V flip (`SPRITE_OLD_ORIENTATION=1` drops it, the billboards as they drew before
  2026-10-15, as at cd49899) the same probe shows green on top
  (164,638 pixels, red 50,960 below: inverted) and the tile and the billboard of the
  first sprite differ in 216,119 of 216,636 pixels (99.8%), the whole frame in 297,143
  of 296,700 sprite pixels (the other two views alike). The real smoke
  textures are fire textures that animate between screenshots, so the probe is the
  stable measure; with them the page's tiles and billboards differ in nearly every
  sprite pixel (150,760 of 158,597 in the first view, 190,287 of 161,661 before the
  flip).
* Particles are sprites: `ParticleIterator` items are `DT_Sprite` records (viaIterator)
  with their own Setup per frame, and take the path above in the root and the child
  frames (`validate-particles-play` passes: 7 live particles, 16 sprites). Lasers are not
  sprites: a `LaserIterator`'s items are `DT_Mesh` LaserProxy snapshots, drawn by
  DrawActorSprite's mesh branch (`0x10b2556a..0x10b25655`, DrawMesh) through the
  actor mesh layer's materials, which project the camera-space buffer on the
  chain since 2026-10-14 ([GPU mesh](gpu-mesh.md#camera-space-2026-10-14)): nothing
  to port, but not measured separately.
* **Coronas** are the same call (`Canvas.DrawIcon(Skin, X - size/2, Y - size/2, size,
  size, Span 0, Z 1.0, colour, fog 0, PolyFlags 0x104)`, [coronas](coronas.md#the-pass-urenderdrawframe-0x10b1b46a0x10b1bb06))
  with the rectangle already in screen pixels: steps 4 to 6 above with Z 1.0 (RHW 1,
  depth `_33 - _33 = 0`). They draw through `iconVertices` / `fpCanvasTile` (the sprite
  chain's second half, split out of `fpSpriteTile`) in the master frame since 2026-10-15:
  [coronas "On the tile chain"](coronas.md#on-the-tile-chain-2026-10-15),
  `validate-corona-tiles` (694 tiles, 2,776 vertices bit-equal to DrawFrame's loop under
  Unicorn, on the CPU and the GPU) and `validate-corona-tiles-play`. The flat overlay
  they drew before was upside down, like the billboards.
* **The canvas' frame.** UCanvas::DrawTile clips to, and D3DDrv's DrawTile offsets by,
  `Canvas+0x7c`. Neither DrawFrame nor DrawActorSprite calls the canvas' virtual `+0x58`
  (Update); the canvas is put on the master frame once, in the Engine function containing
  `0x1038f68e` (`Viewport->Canvas->Update(Frame)` with CreateMasterFrame's result), so the
  sprites of a mirror or sky child frame are clipped to and offset by the **master frame's**
  FX, FY, XB and YB, not the child's. The oracle gives the canvas the frame it is drawing
  (the child's); the two agree because every child frame has the master's size and offset:
  `validate-sprite-tiles` asserts X, Y, XB, YB, FX and FY of all 55 frames of its cameras
  (27 child frames, 252 child-frame sprites) equal the root's.

Not covered, noted: DT_SpriteAnimOnce's frame choice (`0x10b252ac..0x10b25392`:
Play draws the first frame; the shipped game assigns it nowhere, [particles](particles.md#dt_spriteanimonce-0x10b252ac0x10b25392-restored-at-0x10b254d3)), the editor and
hit-test paths (PushHit, the selected tint), the viewer's `Sprite` override, texture
LOD other than 0 (and the render device's `+0x30` minimum LOD, not measured), the
colour D3DDrv packs from Color (Play keeps its ScaleGlow colour), a sky child
frame's sprites in a browser (a mirror's are measured, below), and a ViewportWindow's
sprites (they keep the camera's billboards, as its world does).

**A mirror frame's sprites in a browser (2026-10-15).** The oracle covers 27 child
frames bit for bit; `scripts/validate-sprite-tiles-mirror-play.mjs` measures the page.
The shipped maps' sprites are runtime items far from their mirrors (a census of 16 maps with
mirror polygons and particle sources against the sprite scan found only two sprites in front of
a mirror, Hotel's smoke puff and Cathedral's gen_white, and 27 cameras aimed at their
reflections drew neither in a child frame), so the validator shows sprites where it needs
them: the map's `Light` actors are DT_Sprite editor icons with `bHidden` set (Engine.Light's
defaults), and `placeProbe({set})` clears it on the six nearest to a mirror polygon, which the
simulation side's scan then offers like any sprite. 10_Paris_Club, the wall mirrors at BSP
nodes 16 and 38, the player 450 and 300 units out along the polygon's normal and 0, -200
and 200 aside, looking at it (worker mode, headless Chromium, 1024 x 640, one device pixel
per CSS pixel, the frame frozen): 8 of the 12 views have a sprite in the mirror's child
frame (OccludeBsp's `frames`, `screens[frame]` Setup floats, 11 sprite-frame pairs). Each is
drawn alone in that child frame (hidden in the main frame and the other passes) against the
frame with no sprite: the 18,370 pixels it adds all lie inside the reference tile
(`spriteVertices` from the child frame's Setup floats, with the master frame's rectangle as
the canvas' frame) and reach 3 or 4 of the tile's sides in all 11 (the mirror's polygon clips
the others), none only in the horizontally mirrored tile; with the probe texture (red first
rows, green last rows) the first row is on top in the reflection in all 8 probed (a mirror
flips left and right only). Moving the reference tile 8 pixels (`--mutate`) fails the
comparison.

## Detail textures: the pass Play does not draw (2026-10-15)

The "fog overlay's clip at view depth 380" of the earlier hand-off is not the fog's. Reading D3DDrv's
`DrawComplexSurface` (`0x10003900`) from the instructions: the block with the 380.0 constant (`0x10004880`)
starts at `0x10004860` with `mov eax, [Surface + 0x18]` and `je 0x10004d39`; FSurfaceInfo is PolyFlags,
FlatColor, Level, Texture (`+0xc`), LightMap, MacroTexture, **DetailTexture (`+0x18`)**, FogMap (`+0x1c`)
(`UnRender.h`), so that block is the **detail-texture pass** and `0x10004d39` is the fog map's, which draws
its polygons whole (it compares no depth). The fog overlay Play draws cannot differ from the original's for
this reason. What can differ is that **Play draws no detail textures at all** (no `DetailTexture` in
`src/viewer`). Traced, not run: this section is the hand-off for the pass; nothing of it is implemented or
validated yet.

**Whether the original draws it.**
* Render.dll DrawFrame (`0x10b1a8df..0x10b1a92f`) builds `Surface.DetailTexture` (`[ebp - 0x8c]`, the struct at
  `[ebp - 0xa4]`) when the surface texture's `+0x58` (UTexture.DetailTexture) is set, `PolyFlags & 0x04000000` is
  clear, and `UBitmap::__Client->TextureLODSet[0]` (`[Client + 0x78]` by the `UClient` layout of `UnCamera.h`)
  is 0 (`TextureDetail=High`, as the shipped DeusEx.ini and the Wine install's); it then
  `Lock`s the detail texture (vtable `+0x54`, LOD -1) into `[ebp - 0x394]` and `Unlock`s it after the draw
  (`0x10b1b38b..0x10b1b3a1`). The `D3DRenderDevice` section of both ini files has `DetailTextures=True`.
* The `esi` of that gate is the base texture's LOD (the `Lock` at `0x10b1a889` takes it): a surface drawn at LOD 2 or
  coarser gets no detail texture (`cmp esi, 2; jge`, `0x10b1a8f2`).
* **D3DDrv reads the field first thing** (measured below): `DrawComplexSurface` starts (`0x1000395f..0x10003973`) with
  `if (Surface.DetailTexture && (Surface.FogMap || !this->DetailTextures)) Surface.DetailTexture = NULL`, where
  `this+0x78` is `URenderDevice.DetailTextures` (Engine.dll's `URenderDevice::StaticConstructor` registers it,
  `0x103715ec`: `push 0x78`, next to `Coronas` at `+0x60`, `HighDetailActors` `+0x64`). So a surface with a fog map
  never gets a detail texture, and the pass at `0x10004860` runs only when the device's field is set.
* **`SetRes` clears the field** (`0x1000c4f1..0x1000c515`): when `this+0x358`, the `dwTextureOpCaps` of the D3D7
  device description (`D3DDEVICEDESC7 +0xc4` from `+0x294`), has no `D3DTEXOPCAPS_BLENDDIFFUSEALPHA` (`0x800`,
  `test ah, 8`), `this->DetailTextures = 0` whatever the ini says. The pass sets stage 0's `COLOROP` to exactly that
  operation, so the device is asked about it first.
* 846 of the 2,287 texture exports of `Textures/*.utx` carry a `DetailTexture` reference (37%).

**Measured in the running original (2026-10-15, Wine, `01_NYC_UNATCOIsland`, the pier deck at the `down` view
`-4761,10431,-256:62536,0,0`, 1280 x 720, level time held at 52.32):**
* `wine ad/build/dump-actor-win.exe D3DRenderDevice DetailTextures:0x78:u32 TexOpCaps:0x358:u32` reads
  `DetailTextures=0x0` and `TexOpCaps=0xfef7ff` (bit `0x800` clear) with `DetailTextures=True` in the ini copy: **Wine's
  ddraw does not report `BLENDDIFFUSEALPHA`, so on this host the original's `SetRes` turns the pass off.**
* Breakpoint counters (`visual-acceptance.mjs original --cw-probe --cw-only --cw-spec ...`, 18 frames): 1,860
  `DrawComplexSurface` calls, every one through the clearing store at `0x10003970`, 0 entries at `0x1000486e`, 0
  layers (`0x100048b9`), 0 fan draws (`0x10004c92`); the fog pass (`0x10004d39`) 1,859.
* With the field written to 1 after the window is placed (`--poke D3DRenderDevice0:0x78:1`,
  `tools/poke-object-win.c`; the same frame, 15 frames counted): 1,701 calls, 0 through the clearing store, **1,330
  detail passes, 3,989 layers (three per pass), 93 fan draws** (most surfaces of this open scene are beyond 380
  units; the fans are the deck and the rails near the camera), fog pass 371. Wine draws the pass (its
  `BLENDDIFFUSEALPHA` is implemented, only not advertised).
* The two matched original frames (field 0 against field 1; the same camera, `TimeSeconds` 52.3189 against 52.3221):
  mean absolute difference 0.33 of 255, maximum 8, 291,011 of 921,600 pixels differ in some channel, all on the deck
  (the difference image is a floor texture); the frame mean falls 9.42 to 9.21, the deck's rows 9.07 to 8.58 (a detail
  texture whose mean is below grey darkens what it covers).

**What this settles.** The original draws detail textures: on a device that reports `BLENDDIFFUSEALPHA` (every D3D7
class driver on Windows is expected to; **not measured here**, the only original that runs on this host is under
Wine) with the shipped `DetailTextures=True` and `TextureDetail=High`. **Every earlier acceptance capture of the
original was taken without it**, whatever the ini says; an original frame that contains the pass needs the field
poked, as above. Play therefore draws the pass as the original does on a device with the cap, and a comparison with a
Wine frame needs the poked capture.

**The pass** (`0x10004860..0x10004d0b`, D3DDrv):
* Three layers. Layer k uses fade distance `D = 380 * 0.2367985^k` (`0x10018640`: 380, 89.98, 21.31) and a texture
  scale `4.223^k` (`0x10018644`: 1, 4.223, 17.83), both multiplied in place at the end of each layer
  (`0x10004cb7..0x10004cd5`). `RHW_D = 1 / D` and the clip depth `RHW_D * _43 + _33` are computed once per layer
  (`0x100048b9..0x100048db`).
* Per polygon (the facet's saved polygons): a vertex is inside when its view depth `FTransform + 8` is below D
  (`fcomp`, `0x100048f6`); a polygon with none inside is skipped (`0x1000491f`), otherwise the vertex buffer is
  locked (32-vertex chunks, wrap at `0x1f40`) and a triangle fan is drawn (`0x10004c92`).
* State, once per surface (`0x100049dc..0x10004a1e`): `SetBlending(0x40)` (PF_Modulated, destination times source),
  texture stage 0 `COLOROP` = 12 (`D3DTOP_BLENDDIFFUSEALPHA`), `ZBIAS` 15, `SetTexture(0, DetailTexture)`; restored at
  `0x10004cda..0x10004d0b`.
* Vertices (0x24 bytes): an inside vertex repeats the base pass's X, Y, depth and RHW (the device's per-vertex
  scratch at `+0xbfc..+0xc08`), with colour `0x808080 | min(255, round((D / Z - 1) * 100)) << 24`
  (`0x10018648` = 100.0) and texture coordinates `(U_base - DetailTexture.Pan) * UScale * layerScale`
  (`0x10004bd4..0x10004c2a`). An edge whose ends fall on different sides of D adds a Sutherland-Hodgman vertex:
  `t = (Z_a - D) / (Z_a - Z_b)`, `s = 1 - t`, X = `(t * ScreenX_b * Z_b + s * ScreenX_a * Z_a) / D + XB - 0.5`
  (Y alike with ScreenY and YB; `0x10004a72..0x10004aaf`), depth the layer's clip depth, RHW `1 / D`, colour
  `0x808080` (alpha 0), and the texture coordinates mixed by t and s the same way.
* So a layer fades the detail texture in from nothing at D to full strength by about `D / 3.55` (alpha
  `100 * (D / Z - 1)` reaches 255), over a surface neutral grey (`0x808080` blended to the texture by that
  alpha), modulated into the frame with ZBIAS 15.

**The pass under Unicorn (2026-10-15).** `scripts/native-frame-projection-oracle.py` runs the unchanged `DrawComplexSurface`
with `Surface + 0x18` set to a detail FTextureInfo (`case.detail`; each model surface's `detail` in the request:
`occlusion-request.mjs surfaceDetails`: the first mip's size, UScale = VScale = the texture's `DrawScale` as
[decals](decals.md) measured `UTexture::Lock` leaves it, Pan 0) over each draw list's saved polygons. What it feeds the
pass comes from the original too:
* the facet's MapCoords in view space: Render.dll DrawFrame's own origin block (`0x10b1aab7..0x10b1ab23`: the world
  origin less the frame's origin, rotated by its axes) and Core's `FVector::TransformVectorBy` (`0x10119e40`) over the
  frame's Coords for the texture axes (the x87 sequences are the original's, the oracle only supplies registers);
* the stage values `SetTexture(0, DetailTexture)` leaves (`UIndex`, `VIndex`, `UScale`, `VScale`): its bin and stage
  instructions (`0x10008e15..0x10008e97`, `0x10009405..0x100094b0`) over the info on a scratch device. They are
  `UIndex = (USize < VSize)`, `VIndex = 1 - UIndex` (the longer side is always the first coordinate), and
  `UScale = 1 / ((USize << shift) * Info.UScale)` (Play's detail textures are 128 x 128 or 256 x 256 with DrawScale
  0.25 .. 0.5: 1/32 .. 1/128 per world unit; the layers then scale it by 1, 4.223, 17.83);
* `SetBlending` (`0x10008270`) is the original's (not stubbed any more); the COM calls and `SetTexture` record their
  arguments in order, `DrawPrimitiveVB` with the fan's vertices, the layer (`2 - [ebp-0x40]`) and the polygon's first
  vertex (`[ebp-0x14]`).

The recorded calls of a surface whose fans are drawn: `SetRenderState(ALPHABLENDENABLE=27, 1)`, `SRCBLEND=19 <- 9
(DESTCOLOR)`, `DESTBLEND=20 <- 3 (SRCCOLOR)`, `ZWRITEENABLE=14 <- 0` (PF_Modulated: SetBlending(0x40)),
`SetTextureStageState(0, COLOROP=1, 12 = BLENDDIFFUSEALPHA)`, `SetRenderState(ZBIAS=47, 15)`, `SetTexture(0, detail)`, the fans
(layer by layer, polygon by polygon), then `COLOROP` back to the device's saved value (`+0xa00`) and `ZBIAS 0`. The
pass does not restore `ZWRITEENABLE`: the next `SetBlending` does.

`src/runtime/detail-pass.mjs` is the CPU reference, `scripts/validate-detail-pass.mjs` compares it with the oracle bit
for bit: 84 cameras on Training's wall and Island's deck (8 to 400 units away), 462 draw-list entries with a detail
texture, 658 polygons, 465 fans, 2,068 vertices of which 284 are the clip's; per layer, polygons wholly inside D,
straddling it and outside all occur (layer 0: 287 / 79 / 292, layer 1: 29 / 46 / 583, layer 2: 10 / 14 / 634); the alpha ramp
runs 1 to 255. Two details the instructions fixed that the hand-off had not: the clip vertex' Y multiplies as
`(ScreenY * Z) * t` where X is `(t * ScreenX) * Z` (the stack order differs; found by the oracle at 2 ulps), and the
raw texture coordinate sums `(dz*Uz + dy*Uy) + dx*Ux` (z first).

**The Rust port (2026-10-15).** `native/script-vm/src/detail.rs` (`detail_run`, exposed as `kernel.occlusion.detailRun`)
turns one frame's occlusion stream (OccludeBsp with saved points, option 0x100, as the decals read it), the frame's
ComputeRenderSize fields, its rectangle offset, SetRes' `_33`/`_43` and a per-surface table (`detailTable` in
`src/runtime/detail-pass.mjs`: a flag, the base point and the two texture axes in world coordinates, UIndex/VIndex, the
UScale/VScale words and the Pan, 16 words a surface) into the fans: `[list, iNode, iSurf, fans]` per draw-list record that
has any, then `[layer, first vertex, count, count x 7 words]`, the words D3DDrv's vertices carry (X, Y, depth, RHW, colour and
the two at vertex + 0x14 / + 0x18). The facet's view-space coordinates and the stage values are computed from the table in
the same operations as the oracle's (`facetOf`, `detailStage`; `validate-detail-pass` checks both on all 462 entries).
`scripts/validate-detail-pass-rust.mjs` runs the Rust core's OccludeBsp and `detail_run` on the same 84 cameras and compares
with the original under Unicorn: 265 draw-list records, 465 fans, 2,068 vertices, bit for bit, no fan more or less. The
polygon scratch holds records of up to 256 polygons of up to 64 points (the shipped maps' largest are far below; a larger
record is skipped, not truncated).

**Play's draw (in progress, 2026-10-15).** Item 1 is built: `src/runtime/detail-draw.mjs` (the simulation side), OccludeBsp's option
`0x400` (`OCCLUSION_DETAIL`, `occlude.rs` `detail_wanted` / `detail_near`: the saved points only of the polygons of a surface whose
table record (model words 19 and 20) has a detail texture, whose draw flags lack `0x04000000` and that have a vertex of view depth
below 380; the filtered stream is 53% of the all-points stream on the validator's close-up cameras and carries no points at all
when no surface qualifies), `detail_run` over the main frame's and each child frame's stream (`decodeFrames` hands every child
its stream address), and the pack in `snapshot.begin.visibility.detail` (transferred). `scripts/validate-detail-play-sim.mjs` runs
Play's session headless and compares the pack with the CPU reference `detail-pass.mjs` over the same frame run again with all the
points, mirror frames included; `scripts/validate-detail-pass-rust.mjs` also runs the filtered stream against the original's fans
(465 fans, vertex for vertex; `first` counts the kept polygons only). The page's draw, ZBIAS and the pixel checks are items 2-4.
What the item list asked for, from what the oracle recorded:
1. *Sim side.* A per-surface table from the map's textures at load (`detailTable`; `surfaceDetails` in
   `scripts/occlusion-request.mjs` is the Node version: the texture's `DetailTexture`, its first mip's size and its `DrawScale`
   or `Scale`, and the browser needs the same from its TextureStore). OccludeBsp keeps the saved points only when option 0x100
   is set; Play does not set it (the decals do when they have fragments). Emit points for the polygons of a surface whose
   table flag is set, whose draw-list flags lack `0x04000000` and that have a vertex of view depth below 380 (`occlude.rs`'s
   output loop, `options & 0x100` at the emit), run `detailRun` for the main frame and each mirror/sky child (their `fields`,
   rectangle offset and the frame's `stamps.plan` pass id: [sim worker](sim-worker.md)), and ship the fans in the snapshot as
   typed arrays reused between frames. The tracker's mover surfaces are not in the table (a mover with a detail texture draws
   none: say so in the open list).
2. *Page.* One draw per pass after the world's surfaces and before the actors (the original draws each surface's fans right
   after the surface), vertices as D3D's (`fpClipOf(vec4(X, Y, depth, rhw), 1/rhw)` as the base surface; a clip vertex has
   `rhw = 1/D`), in the **recorded states**: blend `ALPHABLENDENABLE`, `SRCBLEND = DESTCOLOR`, `DESTBLEND = SRCCOLOR` (so the
   framebuffer becomes `2 * src * dst`), `ZWRITEENABLE` off, depth test less-or-equal, `ZBIAS 15`, stage 0 `COLOROP =
   BLENDDIFFUSEALPHA`: the stage's colour is `mix(diffuse.rgb, texel.rgb, diffuse.a)` with the diffuse `0x808080` (so alpha 0 is
   the identity: `2 * 0.5 * dst`) and the vertex alpha interpolated; the texture sampled as the base textures are
   ([texture sampling](texture-sampling.md): the same stage state, LOD bias -0.5, wrap, `NoColorSpace`). Brightness and the
   display ramp stay untouched: Play draws raw colours and ramps the finished frame, as D3D does.
3. *ZBIAS.* Play has no depth bias. The original's `ZBIAS 15` is a 0..16 step the driver interprets; under Wine's ddraw it
   becomes a constant depth bias (believed `-15 / 16000` in the 0..1 depth range, **not measured**), about 9 world units at 100
   units from the camera, about 0.4 at 20: wide enough to pull a fan in front of anything within a few units of the surface
   (a sign on a wall gets the wall's detail texture). Measure it against the poked Wine capture (`--poke D3DRenderDevice0:0x78:1`,
   the same camera) with `polygonOffset` units tried around `-15 / 16000 * 2^24`, and say which value matches.
4. *The switch.* `?detailTextures=0` models a device without the cap (no `detailRun`, as `SetRes` zeroing `+0x78` makes
   `DrawComplexSurface` skip the pass); every Wine capture of the original lacks the pass, so every comparison with a stored
   capture needs it, as it needs `?antialias=0`. List in [visual acceptance](visual-acceptance.md) which rows were taken without
   detail (all), and check which validators compare Play pixels with stored captures.

**Unverified (inputs the oracle takes, not derives):**
the detail texture's `Lock` (Pan 0, UScale = DrawScale, first mip) and the cache's size choice (the first mip within the
device's maximum, shift 0); Render.dll's `esi < 2` LOD gate (`0x10b1a8f2`) is taken as always met for BSP surfaces; the facet
Z axis and the light-map coordinates are not used by the pass and are zeros; the multitexture path (`UseMultitexture`,
`this+0x9b4`) computes the same scratch values in its own loop (`0x10003d25..0x10003d4f`) but is not run.

## Unverified and open

* **Clipped polygons.** The original draws the Sutherland-Hodgman clipped
  polygon (20% of the saved points in these frames); the GPU clips the unclipped
  polygon homogeneously. The pixels inside the frustum agree; the vertices on its
  edges are the rasterizer's.
* **Sprites** (and the particles, which are sprites) take the chain's vertices
  ([Sprites](#sprites-the-tile-the-render-device-receives); the light coronas' tile is on
  the same chain since 2026-10-15, [coronas](coronas.md#on-the-tile-chain-2026-10-15)).
  A mirror frame's sprites are measured in a browser since 2026-10-15 (above). Open there:
  DT_SpriteAnimOnce's frame, texture LOD other than 0, the colour D3DDrv packs, a sky frame's
  sprites in a browser, a ViewportWindow's sprites (camera billboards). **Lasers** are meshes on the chain's
  mesh path, not separately measured. **The fog map has no clip at view depth 380**
  (the fog pass, `0x10004d39`, compares no depth); the clip at 380 is the
  **detail-texture** pass's, which Play does not draw at all:
  [Detail textures](#detail-textures-the-pass-play-does-not-draw-2026-10-15).
  ViewportWindow camera frames keep
  the camera's projection (their camera is posed from Coords as well): measured
  against the original's own security-camera frames, drawing a window through the
  vertex chain (`fpClip` with the window's master frame) changes 0 to 2 of
  30,000 pixels per window and not their mean absolute difference
  ([visual acceptance](visual-acceptance.md#security-cameras-2026-10-14)), so it
  is not needed there.
* **Environment mapping** and the **culling spheres** read the world pose
  (both mesh paths).
* **Depth buffer.** The depth buffer's format and rounding (Direct3D's z
  buffer or the host's 24-bit one), the hardware's interpolation, the ZBIAS
  steps and the multi-pass ZFUNC EQUAL of the light-map, fog and detail passes
  are not reproduced; Play draws one pass per surface and the overlays tie by
  sharing vertices. Coplanar polygons that are not the same triangles still
  tie at the host's depth precision.
* **16-bit viewports** (far 8192, GUglyHackFlags' 0.25): constants measured,
  not wired (Play has one 32-bit viewport).
* Hardware validation: the GPU result is measured on ANGLE's GL backend on
  Linux (AMD); Metal (macOS) is the target of the same barrier technique
  ([GPU mesh](gpu-mesh.md#gpu-arithmetic-on-the-target-measured)) but this
  validator was not run there.
