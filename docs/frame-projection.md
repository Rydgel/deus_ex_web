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
  same, and X = `(XB - 0.5) + x` (`0x10005c41–0x10005c95`). Not ported.

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
overlay (`0x10004a00`, back to 0 at `0x10004d01`); decals draw with no depth
bias ([decals](decals.md#drawing)). The fog pass (`0x100048b9–0x10004aaf`)
clips each polygon at view depth 380.0 (`0x43be0000`, `0x10004880`) before
building its vertices.

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
  sprites, particles, coronas, lasers and decals, which keep the camera's
  projection, land within 0.004 pixel and 2 depth ulps of the world.
* `src/viewer/frame-projection.mjs`: the shared uniforms and `patch(shader)`,
  which replaces three.js's `project_vertex` with `fpClip(fpView(world))` (or,
  for GPU-path actor meshes, `fpClip` of the camera-space point). Applied to
  world surfaces (`applyLightAtlas`: static, mover, mirror and batched
  materials), the fake-backdrop depth mesh, the fog overlay and every actor mesh
  material. `uFpOn` selects the chain per pass: the main frame, each mirror and
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

## Unverified and open

* **Movers.** A mover's vertices are float32 products of its group matrix with
  the rest positions, then the chain: the original's are `Model->Points` the
  brush tracker writes (FPoly::Transform at precision 24). The tracker's points
  could be uploaded per move.
* **Clipped polygons.** The original draws the Sutherland-Hodgman clipped
  polygon (20% of the saved points in these frames); the GPU clips the unclipped
  polygon homogeneously. The pixels inside the frustum agree; the vertices on its
  edges are the rasterizer's.
* **Decals, sprites, particles, coronas, lasers, the fog overlay's clip at view
  depth 380:** the camera's projection (decals' camera-space points and DrawTile's
  `1/Z` vertex are original facts, not wired). ViewportWindow camera frames keep
  the camera's projection (their camera is posed from Coords as well).
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
