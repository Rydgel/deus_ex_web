# Classic UMesh meshes: payload, GetFrame, DrawMesh

The game has five classic `UMesh` meshes (every other mesh is a `ULodMesh`): the boot logos DX.dx
flies past, `DeusExDeco`'s `EidosLogo`, `IonStormLogo`, `DXLogo` and `DXText`, and
`DeusExCharacters`' `Fly`, the pawns `FlyGenerator`s spawn. Play bound only `LodMesh` until
2026-10-21 (the actor mesh layer recorded "Classic UMesh surfaces are not bound"), so DX.dx's
flight showed the electricity's glow and nothing else ([boot](boot.md) "The page"), and the flies
never drew on any map. This page is the classic path from the original, the way the
[LodMesh](script-lodmesh-frame.md) one was: payload, `GetFrame`, Render.dll's `DrawMesh`.

| Mesh | Package export | Vertices | Triangles | Frames | Textures | Triangle flags |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `EidosLogo` | DeusExDeco 397 | 1,716 | 1,664 | 1 | 1 | PF_Environment (0x10) |
| `IonStormLogo` | DeusExDeco 407 | 1,640 | 3,256 | 1 | 4 | none |
| `DXText` | DeusExDeco 408 | 4 | 2 | 1 | 1 | none |
| `DXLogo` | DeusExDeco 415 | 806 | 814 | 1 | 1 | PF_Environment |
| `Fly` | DeusExCharacters 723 | 7 | 3 | 1 | 1 | PF_Masked or PF_Translucent, PF_TwoSided |

All have scale 1/256, sequences `All` and `Still`, no notifies and one frame (the Fly's flapping is
not a mesh animation). Engine.dll `0c3a8b18…c20b4`, Render.dll `607f1077…d75d1`, Core.dll
`8bf3039e…7e4`.

## Payload (UMesh::Serialize `0x103a63b0`)

`UMesh::UMesh` (`0x103a6130`) and `UMesh::Serialize` (vtable `0x104290b8` slot `0x28`, thunk
`0x10301717`) are the first half of what [`ULodMesh`](lodmesh-serialization.md) runs: tagged
properties, bounds, the lazy `Verts` (`+0x54`, 8-byte `FMeshVert`s: HIGH_PRECISION_MODELS, three
int16 and a pad), `Tris` (`+0x6c`, 20-byte `FMeshTri`: three `WORD` vertices, three `FMeshUV`, `DWORD`
PolyFlags, `INT` TextureIndex), the animation sequences (`+0x84`), `Connects` (`+0x90`,
`FMeshVertConnect {NumVertTriangles, TriangleListOffset}`), the bounds again, `VertLinks` (`+0xc0`,
`INT`s), the texture references (`+0xd8`), the frame boxes (`+0xa8`) and spheres (`+0xb4`), the scalars
`+0xf0..+0x128` (frame vertex count, frame count, Scale, Origin, RotOrigin) and the `+0xe4` float
array. A classic mesh ends there (`0x12c` bytes); the shared `serializeMesh` in
`script-mesh-load.mjs` is that body, and `decodeLodMeshPayload` takes a `Mesh` export
(`payloadStatus` `decoded-mesh`).

**Verified:** `validate-mesh-payload` runs the original constructor and serializer (the oracle's
`classic` case) on all five meshes, with `GLazyLoad` 0 and 1: every array's bytes, count and
capacity, every scalar's bits, the lazy state, the cursor and the bounds equal (8 of its 16 cases).

## UMesh::GetFrame (`0x103a7780`)

Render's `DrawMesh` calls it through the mesh's vtable (`+0x70`, thunk `0x103037b0`) with the output
buffer, a stride of 0x58, the frame's `Coords` by value and the actor. It runs in the render pass, so
at x87 precision control 24 ([render pass](render-pass-precision.md)). It is the LodMesh body
(`0x10355360`, [GetFrame](script-lodmesh-frame.md)) with five differences, from the instructions:

1. It has no requested count and no special vertices: it always poses `FrameVerts`.
2. Its GCache items are `(FrameVerts + 1)·12` bytes with a 12-byte header: the mesh, the cached
   frame float, the sequence `FName`, zeroed at creation. There is no valid-vertex count and no
   completion float.
3. The tween (AnimFrame below zero, with an existing item) takes the target `StartFrame·FrameVerts`,
   `alpha = f(1 - f(AnimFrame / cachedFrame))` and, when the sequence changed or alpha is outside
   [0, 1], stores `sequence` and the reset frame `-1/NumFrames` and takes alpha 0. There is no
   `0.97` completion gate and no fill of newly requested vertices.
4. The first branch tests `GIs3DNow` (Core `0x101e558c`, written at `0x1016dea7` from CPUID
   `0x80000001` EDX bit 31) and calls `UMesh::AMD3DGetFrame` when set. It is clear on every host
   this game runs on here: the reference machine's log reads "CPU Features: CMov FPU RDTSC MMX KNI"
   ([mixer](galaxy-music/mixer.md)). The 3DNow! path is not translated.
5. A negative `AnimFrame` clamps to the zero float (`0x10426d54`) on the normal path.

The coordinate setup (`Location + PrePivot` summed unstored, `*= Rotation`, `*= RotOrigin`,
`*= FScale(Scale·DrawScale)`), the interpolation `(b - a)·t + a` and the four additive blend slots
(`(blend pose - frame 0)` through `TransformVectorBy`, added to the output) are the LodMesh port's, which
`umesh-frame.mjs` reuses (`lodMeshFrameMatrix`).

**Verified:** `validate-umesh-frame` runs the unchanged original body in the Unicorn oracle for 79
complete calls and compares every output byte (including the strided padding), every cache byte, lock and
Create/Flush request, and the cursor: the real meshes (EidosLogo, DXText, the Fly: keyframe, missing
sequence, tween, owner animation, particles, camera-space `Frame->Coords` with large origins and a
mirror-reflected one) and a synthetic eight-frame mesh built from the Fly's payload
(`scripts/umesh-fixture.mjs`; the original serializer reads it too) that reaches what a one-frame mesh
cannot: sequence wrap and interpolation, tween progress and regression, a mesh change, four additive
blends and their tweens. All 694 checks equal at control word 0x007f; the same cases fail at 0x037f
(the oracle's other default), so the comparison is sensitive to the precision.

## URender::DrawMesh, the classic body (`0x10b0d1a0`)

`DrawMesh` first ORs PF_Flat (`0x4000`) into its flags and sends a `ULodMesh` to `DrawLodMesh`
(`0x10b0d1fc`); for any other mesh its own body runs from `0x10b0d235` to `0x10b0ea00`. Arguments:
`(Frame, Owner, LightSink, Span, Zone, Coords, LeafLights, Volumetrics, PolyFlags)`; the classic body
overwrites its LightSink slot with the vertex buffer, so `SetupForActor` takes the Owner as the light
sink. `umesh-draw.mjs` translates it up to the shared face helper `0x10b0bab0`, in the original's
order; every float operation is binary32 at precision control 24.

| Step | Address | What it does |
| --- | --- | --- |
| Vertex records | `0x10b0d300..0x10b0d47d` | `FrameVerts` records of 0x58 bytes (Point, outcode at `+0xc`, Normal plane `+0x20`, Light `+0x30`, Fog `+0x40`, U/V `+0x50`). `GetFrame` fills the points; each record gets `Light.X = -1.0` (the mark) and its outcode from `PrjXM..PrjYP` (`Frame+0xec..0xf8`: `z·PrjXM + x`, `z·PrjYM + y`, `z·PrjYP - y`, `z·PrjXP - x`, whose sign bits select 4, 0x10, 0x20, 8). A mesh whose vertices all share a bit (the byte starts at `0x3c`) is not drawn. |
| Face normals | `0x10b0db49..0x10b0dc6d` | for every triangle, kept or not: `a = v2 - v0`, `b = v0 - v1`, `n = (by·az - bz·ay, bz·ax - az·bx, ay·bx - by·ax)`, normalized by the table reciprocal root (`0x10b33650`, `0x10b3d384`) of `((nx² + ny²) + nz²) + 0.001`, where 0.001 is the **double** at `0x10b2ac10` (the LodMesh path adds the float `0x10b2ac2c`). |
| Cull | `0x10b0dc81..0x10b0dd8e` | skipped when the three outcodes share a bit; with `(flags & 0x4101) == 0x4000` (flat, one-sided, visible) kept only when `((nz·v0z + ny·v0y) + v0x·nx)·Frame.Mirror < 0`; a smooth, two-sided or invisible triangle is kept. `flags` is the triangle's PolyFlags OR the caller's. The kept triangles keep mesh order: the sort that follows (`0x10b0de59`) runs only when `RenDev->SpanBased` (`+0x48`) is set, which D3DDrv's device never is ([BSP occlusion](bsp-occlusion.md)). |
| Textures | `0x10b0de90..0x10b0dfc0` | `Mesh->GetTexture(i, Owner)` for each of at most 16 textures, then `Tick(CurrentTime)` and `Lock(Info, CurrentTime, -1, RenDev)`; the environment map is `Actor.Texture`, else the zone's, else the level's `EnvironmentMap`, else the last mesh texture (none at all: nothing is drawn). A viewing PlayerPawn whose `Sprite` (`+0x168`) is set replaces every texture. |
| SetupForActor | `0x10b0dff9` | its return (0x40000000 when volumetric lights exist) joins PolyFlags after the cull. |
| Vertex lighting | `0x10b0e029..0x10b0e2ed` | for each vertex of each kept triangle, once (the mark): the normal is the sum of the face normals of its `VertLinks` run (`Connects[v]`), `(z² + y²) + x²` (no epsilon) through the table root, `W = (P.y·n.y + P.z·n.z) + P.x·n.x`; Fatness (`+0x191`, `≠ 0x80`) moves the point by `Fatness/16 - 8` along it and redoes the outcode; then `FLightManager::Light` and `::Fog` (vtable `+0x18`, `+0x1c`) with the final PolyFlags. |
| Polygons | `0x10b0e312..0x10b0e41f` | each kept triangle in order: `Info` is the mesh texture, or the environment map for PF_Environment or a missing texture; its flags gain `Info.Texture.PolyFlags & 2`; `U = f(byte·f(USize·UScale)/256)` and V likewise are written into the shared vertex records; a mirrored frame (`Mirror == -1.0`) swaps Pts[0] and Pts[2]; the face helper `0x10b0bab0` draws it. |
| Face helper | `0x10b0bae9..0x10b0bbbc`, `0x10b0c52c..0x10b0c578` | PF_Environment: per corner `n = UnsafeNormal(Point)`, `r = n - Normal·f(2·(n·Normal))`, `r` through the frame's Uncoords, `U = f(f(f(r.x + 1)·UFactor)·128)`; PF_Unlit overwrites each corner's Light with the unlit colour; the corners' outcodes sharing a bit draw nothing; a two-sided face facing away swaps Pts[0] and Pts[2] (`(A·y0 + B·z0) + C·x0 > 0` keeps it); a polygon crossing a frame plane is clipped into new vertices. |
| End | `0x10b0e95f` | `FinishActor`, then `Unlock` of each texture and the environment map. |

**Verified:** `validate-umesh-draw` runs the unchanged `DrawMesh` and face helper in the Unicorn oracle
(`native-umesh-draw-oracle.py`: Render, Engine and Core, the light manager's tables built by its own
init code) on the five meshes in front of three cameras, with a mirrored frame, PF_Unlit, volumetric
setup flags, Fatness, a texture with another size and scale and a masked flag, a missing texture (the
environment map), a PlayerPawn Sprite, outcode planes on and off. The oracle stubs, as recorders, only
what the translation does not cover: the mesh's `GetFrame` (it writes the case's camera-space
points, as validated above), `GetTexture`, `Lock`/`Unlock`/`Tick`, the light manager's
`SetupForActor`, `Light`, `Fog` and `FinishActor` (colours that are exact functions of the vertex
index) and the device's `DrawGouraudPolygon`. Compared: every `Light` call (vertex, camera-space point,
normal plane, flags) and every polygon the device is handed (texture info, flags, and each corner's
point, outcode, normal plane, Light, Fog, U and V). 22 calls, 5,785 Light calls and 6,445 polygons:
all equal bit for bit at 0x007f (31,442 checks); 63 polygons crossed a frame plane and were clipped by
the helper (their texture and flags are compared; Play's GPU clips them instead); at 0x037f 21,167
checks fail.

**Not translated, explicit:** the editor wire-frame and orthographic modes (`RendMap` 1, 13..15),
the particle branch (`Actor.bParticles`; no classic mesh is one), the attached-weapon triangle (a
PF_Invisible face fills a hand coordinate system; none of the five has one), the software renderer's
sort, the face helper's polygon clipping and the near-plane clip of a mirror frame (the GPU clips), the
non-flat smoothing section (`PF_Flat` is always set), and `Fog` (the Fog plane is computed in the
translation's contract and not drawn, as for LodMesh actors' CPU path).

## In Play

`actor-umesh-sim.mjs` is the LodMesh binding's CPU path for a classic mesh; the actor mesh layer
(`actor-mesh-sim.mjs`) makes it when the prepared payload is `decoded-mesh`. Per update it runs
`UMesh::GetFrame` for the actor's pose (one cache per binding, the key a stable identity as for props),
publishes the cached pose through identity `Coords` (world space, the page's geometry and bounds) and
through the lighting frame's own `Coords` (the camera-space buffer `DrawMesh` receives), runs
`SetupForActor` and the translated `DrawMesh` with `Light` (the Rust kernel's `umesh_draw`; the JavaScript
`drawUMesh` with `lightVertex` is the reference), and sends the page
`posed`, `cameraPoints`, per-corner `colors` (D3D's diffuse bytes, white for a modulated face) and, for
environment faces, `envUv`: the original's reflection UVs, which `actor-mesh-draw.mjs` applies in place
of the camera-relative environment mapping it computes for a LodMesh. Materials, skins, sampling, the
vertex projection and render feedback are the LodMesh CPU path's. The mesh lighting frame carries the
master frame's `PrjXM..PrjYP` for the outcodes.

* **Path.** CPU, the Rust kernel's ([below](#the-rust-kernel-2026-10-21)); the JavaScript translation is the
  reference and the fallback (`?meshBackend=javascript`, or `UMESH=js` in Node). No GPU path: it is possible and
  was not made, with the evidence in ["GPU path"](#gpu-path-decided-2026-10-21) below. The classic path
  cost about 1.3 ms of the sim worker's frame on the boot flight when a logo is in view, and about 0.45 ms
  after the port ([the numbers](#where-the-time-went-and-what-the-port-saved-2026-10-21)).
* **Frames.** The main frame lights with its own `Coords`, `Mirror` and outcode planes. A mirror
  child frame draws a classic mesh with the main frame's colours and camera points (the LodMesh path
  lights it again with that frame's); a classic mesh in a mirror is not verified.
* **Skins.** As for every mesh, the group skins are resolved when the binding is made.
  `UScale`/`VScale` of the texture info is the texture's `Scale` property and `USize`/`VSize` its first
  mip; the page divides the environment U/V by `USize·UScale` (D3D's normalization is not retraced).

`validate-umesh-play` runs DX.dx and the Island headlessly through the actor mesh layer: the five
classic actors of DX.dx are bound, lit and shown through the flight with finite records, and a Fly a
FlyGenerator spawned on the Island (seed 2; the generator spawns where the player cannot see, within its
`ActiveArea` of 700) is bound, lit and drawn. `UMESH=verify` makes every relight run the kernel and the reference and
fail on any differing word.

## Where the time went, and what the port saved (2026-10-21)

The page opens on DX.dx, so this path runs on every load, and the merge reported a median of 9 ms of simulation-side
time for the five logos. That figure is the Node headless one, which lights **all five actors every update** (no
frustum): the page lights only what the frustum shows. Both were measured before any change (the browser rows below are
single seconds of one run each, taken while the host was quieter than during the A/B).

**Before** (JavaScript only, merge fbf4930). Node, the actor mesh layer over DX.dx's flight with `lit: true`, 100 updates
of 15 ticks, per update, median of `scene.sim.update` with per-section timers (this host with other agents' work running,
so the whole is 6.3 to 7.7 ms by run; 4.2 to 4.6 ms in the interleaved A/B below, when the host was quieter):

| Section | ms | Share |
| --- | ---: | ---: |
| `SetupForActor` (`setupMesh`) | 0.42 | 5 % |
| camera-space publication (`publishUMeshOps`) | 0.85 | 11 % |
| `drawUMesh`: outcodes, face normals, cull | 0.10 + 0.20 + 0.21 | 7 % |
| `drawUMesh`: per-vertex normal and `Light` | 1.05 | 14 % |
| `drawUMesh`: the polygon loop (texture info, environment UV, records) | 3.14 | 41 % |
| packing the colours and environment UVs for the record (`d3dDiffuse`, UV divisions) | 1.65 | 22 % |

`GetFrame` is not in the table: the logos have one frame and, in that run, do not move (the pose is recomputed only when it
changes); the CPU profile attributes the 774 ms of 100 updates (profiling overhead included) 86 % to `relight`, 57 % to
`drawUMesh` (of which 8 % to `textureInfo`, a script-runtime read for **every triangle**, 8 % to `environmentUV`, 5 % to
`Light`), 6 % to the publication, 6 % to `SetupForActor`. In the page (headless Chromium, `--use-angle=gl`, 1280x720,
worker mode, the worker's own `framePhases`), per drawn frame, with a logo in view:

| Frame | setup | camera | DrawMesh | packing | pose | classic total | worker `actors` phase |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| the Eidos logo in view (flight, x about 2600) | 0.08 | 0.15 | 0.83 | 0.31 | 0 | 1.36 | 1.4 to 1.7 |
| the Ion Storm logo in view (x about 1300) | 0.04 | 0.14 | 0.93 | 0.20 | 0 | 1.3 | 1.5 to 1.6 |
| the end pose (DXLogo, two DXText) and the menu | 0.06 | 0.08 | 0.38 | 0.10 | 0.12 | 0.75 | 1.4 to 1.7 |

So the realistic cost in the page was 0.75 to 1.4 ms of a frame whose worker side is 3.5 to 4.5 ms, not 9: the frustum keeps all
but one logo out of every frame, and the Ion Storm logo's 3,256 triangles (1,330 of them kept) are the largest. The
time is the per-face work, not `GetFrame` and not the transfer: a lit actor's record (colours, camera points, world
pose, environment UVs; 67 to 153 KB) costs 0.02 to 0.04 ms in `structuredClone` (Node), and the page's total frame
work stays 1.6 to 1.9 ms with or without the logos.

**After** (the Rust kernel below, same host and page, interleaved A/B, 3 pairs of 42-second runs against merge fbf4930
served from a second tree, medians of the per-second samples, ms per drawn frame):

| Segment (samples per arm) | `actors` phase before / after | worker total before / after |
| --- | ---: | ---: |
| flight, Eidos logo in view (21) | 1.56 / 0.68 | 4.34 / 3.27 |
| flight, Ion Storm logo in view (12) | 1.86 / 0.70 | 4.36 / 3.06 |
| end pose and menu (57) | 1.97 / 1.33 | 4.84 / 4.14 |

The classic bindings' own time after the port (the stats probe below, per drawn frame): 0.46 to 0.55 ms with the Eidos
or Ion Storm logo lit, 0.43 ms at the end pose (setup 0.07, camera publication 0.075, DrawMesh 0.155 for three relights,
pose 0.08, the rest the five bindings' per-frame reads). The rest of the end pose's `actors` phase is not this path. Node,
all five lit per update: 4.2 to 4.6 ms before, 1.0 to 1.1 ms after (`UMESH=js` in the same tree, which has the texture
table of the change: 3.1 to 4.3 ms). The reference against the kernel per DrawMesh call, with the marshalling, at 900 to
3,000 units from the camera and six lights (a scratch bench, medians of 300): EidosLogo 0.89 / 0.15 ms, IonStormLogo
0.61 / 0.16, DXLogo 0.38 / 0.07, Fly 0.010 / 0.002.

(`lod-probe.mjs` `list: 'umeshStats'`, with `mode` `'on'`, `'take'` and `'off'`, reads the section timers the classic
binding keeps while on, through `deusExViewer.lodProbe`; off, the cost is one boolean test per section.)

## The Rust kernel (2026-10-21)

Following [the LodMesh kernel](lodmesh-wasm.md): the bulk loops are Rust over a typed scratch, JavaScript keeps the
control flow, and the JavaScript translation stays as the reference and the fallback.

| What | Where | Status |
| --- | --- | --- |
| `GetFrame`'s vertex loops (tween fill, interpolation, publication through a matrix) | the LodMesh kernel's `pose`, reached from `umesh-frame.mjs` (`services.kernel`, `publishUMeshOps`' `kernel`) | the unchanged original in the oracle: `validate-umesh-frame --wasm`, 79 calls, equal |
| `DrawMesh`'s classic body to the face helper's per-corner results, `FLightManager::Light` and the packing of the colours and environment UVs | `native/lodmesh-kernel/src/umesh.rs` (`upload_umesh`, `umesh_draw`, `umesh_layout`), `src/runtime/umesh-wasm.mjs` | the JavaScript reference word for word: `validate-umesh-wasm`, which sits on the oracle through `drawUMesh` |
| `SetupForActor`, the texture and environment-map lookups, the coordinate matrix, the cache control flow (sequence, tween, leases), the record | JavaScript (`actor-umesh-sim.mjs`, `umesh-frame.mjs`) | unchanged; SetupForActor's light choice is already Rust (`meshlight.rs`) |

The kernel does, in the original's order and in binary32 (`f32`; the render pass runs at precision control 24): every
vertex's outcode, every triangle's face normal (the epsilon is the **double** `0.001`: `r24_sum`, the exact sum rounded
once, as `lod.rs` has it), the kept triangles in mesh order, each vertex of a kept triangle once (the normal summed over
its `VertLinks` run, the normal plane, Fatness, `light_vertex`, the LodMesh kernel's), and each kept triangle: the
texture info (mesh texture, or the environment map for PF_Environment and a missing texture; no environment map at all
is `STATUS_NO_ENVIRONMENT`, which the binding raises as the reference's error), the PF_Unlit overwrite of its corners'
records (in draw order: a later face sees an earlier face's overwrite), the helper's outcode skip, the environment
corner's reflection (memoized per vertex: it depends on the vertex alone), D3D's diffuse bytes (memoized per vertex, as
the LodMesh kernel's). It leaves out what no output depends on: the plain U and V of the shared vertex records (the page
takes plain UVs from the triangles' bytes), the mirrored frame's swap of Pts[0] and Pts[2] and the two-sided face's
reordering (they permute the corners the helper hands the device; every output is per vertex or per mesh corner), the
helper's clipping and `Fog` (not translated, above).

**One correction to the reference.** The first relight read each vertex's `Light` at the end of the draw, so a PF_Unlit
face's overwrite of a vertex it shares with a lit face would have recoloured the lit face, which the device (it reads the
record when it is handed the polygon) does not do. `drawUMesh` now keeps each draw's corner lights (`draw.lights`) and
`packUMeshDraw` packs from them; none of the shipped scenes mixes PF_Unlit with lit faces (the oracle compares the
snapshots, which were always right), so no frame changes.

**Also changed.** The reference now looks the mesh's texture infos up once per call (a table by `TextureIndex`) and not
once per triangle: the same values (nothing writes them in a DrawMesh), 8 % of the old profile.

**Evidence.**

* `validate-umesh-wasm`: the 22 oracle cases of `validate-umesh-draw` (shared now in `scripts/umesh-draw-cases.mjs`, the
  numbers there unchanged: 22 calls, 5,785 Light calls, 6,445 polygons, 31,442 checks) at 0, 3 and 8 real lights, and 600
  seeded random calls on the five meshes (cameras, mirror, outcode planes, PF_Unlit, PF_Modulated, PF_Environment,
  two-sided, SetupForActor's flag bits, Fatness, texture sizes, scales and masks, missing textures, no environment map; one
  call in five is tiny so the face normals fall to the size of the epsilon): 666 calls, 11.3 million word comparisons of the
  colours, environment UVs, points, normal planes, Light and the counts, all equal; 554 calls drew 374,120 triangles (215,606
  environment-mapped), 127 had PF_Unlit, 57 PF_Modulated, 141 Fatness, 149 a mirror, 37 the missing-environment error.
  Two deliberate mutations of the kernel were tried: the vertex normal's summed squares reordered fails it (planes, points
  and Light differ); the face normal's epsilon as a float instead of the double did **not** fail it, because `tableRsqrt`
  indexes by the top ten mantissa bits and the two sums differ in the last: the Rust test
  `face_length_adds_the_double_epsilon_once` pins the sum itself on ten squared lengths where the double and the float
  differ (expected words from `r24sum`, which the oracle covers).
* `UMESH=verify validate-umesh-play`: Play's own calls (DX.dx's flight and the Island's flies), the kernel and the reference
  side by side, every colour, environment UV and point equal.
* `test/umesh-wasm.test.mjs` (synthetic grids; ABI, the refused topology, memory growth) and the `umesh.rs` unit tests.

**Unverified or not covered.** The kernel is equal to the reference, and the reference to the oracle on the cases above;
the oracle's `Light` is a stub, so the kernel's real `light_vertex` is the LodMesh kernel's (validated there) and is
compared here against the reference's `lightVertex`. The page's rasteriser residuals ([below](#the-other-three-meshes-cheatview-frames))
are unchanged and unexplained. The Fly has not been compared with an original frame. NaN payloads (a degenerate vertex
whose summed normals cancel to zero gives `0 * inf`) are Rust's, not V8's canonical NaN, and the oracle's x87 NaN is a third:
no shipped mesh reaches one in these cases.

## GPU path (decided 2026-10-21)

[The GPU mesh path](gpu-mesh.md) was read against this path for what it could share. **Not made**, for these reasons, from
the code and the measurements.

* **What shares.** The pose pass: the logos have one frame, one channel, no special vertices and no LOD, which the pose
  and camera-pose passes already handle (the control flow would need a `planUMeshFrame` as `planLodMeshFrame` is). The
  light function is `Light` as the vertex pass has it. `VertLinks` is ascending face order and holds exactly the faces
  of each vertex in all five meshes (checked), so the LodMesh adjacency order is the classic one.
* **What does not, and would need new shader code in the shared passes** (every LodMesh actor on every map runs through
  them): the face pass's epsilon is a double rounded once (`ffAddF` could carry it, but the `0.001` has 53 bits, a pair
  holds 48); the cull is DrawMesh's (`(flags & 0x4101) == 0x4000`, and the three outcodes against the frame's four planes)
  and the vertex pass's sums are in another order (`(z² + y²) + x²`, no epsilon, `W` in another order); Fatness moves a point
  after `W` and redoes the outcode; the environment UV is computed per vertex from `UnsafeNormal`, a **correctly rounded**
  square root and reciprocal in the original, where the GPU path has a correctly rounded quotient (`divRN`) and no correctly
  rounded root (the browser's is up to 2 ulp off, [GPU arithmetic](gpu-mesh.md#gpu-arithmetic-on-the-target-measured));
  the draw materials would need the per-vertex UV with the frame's Uncoords where they now compute the camera-relative
  one; the corner colours need the per-face PolyFlags join and the face helper's outcode skip.
* **It can be done bit-exact in principle** (a float-float Newton root with an exact final check, as `divRN`'s, probed over
  all floats like its division), at the cost of variants of the face, vertex and corner passes and of the draw
  materials, and a third mesh kind in the arena, each compared bit for bit with the CPU kernel the way
  `validate-gpu-mesh` compares the LodMesh passes.
* **What it would save.** After the Rust port the classic path is 0.43 to 0.55 ms of a 3 to 4 ms worker frame, only on the
  boot flight and the menu; SetupForActor (0.07), the pose planning and the record would stay on the CPU. The GPU path could
  remove the kernel's DrawMesh (0.05 to 0.16 ms per relit logo) and the camera publication (0.025), about 0.1 to 0.2 ms
  of a frame that is 3 to 4 ms against the 8.3 ms target; a Fly has seven vertices. That does not pay for changing passes
  every NPC on every map shares.

It stays open, with the Rust CPU path as the implementation; a later reason to move it (a scene with many classic
meshes, which the shipped game does not have) is the trigger.

## Frame against the original: DX.dx's end pose (2026-10-21)

The original's `Shot` (the framebuffer before the gamma ramp, Brightness 0.666667 so that Shot is the framebuffer) of the
logo map at the end of the flight, and Play's frame of the same state:

```sh
scripts/live-original.sh DX --ticks 30 --delta 0.0166666675 --original-brightness 0.666667 --shot dxend2 --tag dxend2 --watch DXLogo3
node scripts/dx-end-shot.mjs --name dxend2          # Play, 1280x720, Brightness 0.4 (identity ramp), no detail textures, no multisampling
node scripts/visual-acceptance.mjs compare --maps DX --view dxend2:0,0,0:0,0,0
```

(No `DX_HYPRLAND` on this host: `live-original.sh` runs the game in the prefix's Wine virtual desktop, so there is no
`deusex.exe` window for Hyprland to place.) The harness's frozen phase lets the player fly the whole path before the
tracer attaches, then ticks the level for 30 frames; the trace at the held tick has the player at (-12.7634, 404.9157,
-123.0662), rotation (1999, 49492, 0) and `DXLogo3` (`PHYS_Rotating`, 8192 units a second) at yaw 36,848, that is 32,768
plus 4,080 in the 30 ticks. Play's frame freezes the level (`bPlayersOnly`) while the player flies the IntroCam path,
which ends at (-12.7634, 404.9158, -123.0662) in 1,700 ticks, and writes that yaw into `DXLogo3`.

| Frame | What it shows |
| --- | --- |
| before (`dxend2-before-play.png`: the five actors hidden, which is what Play drew until now) | the electricity emitter's glow and nothing else |
| the original (`dxend2-original.png`) | the DX logo, its orb and the base spike, chrome-lit, over the emitter's glow, and a random electricity bolt above the orb |
| Play (`dxend2-play.png`) | the same, without the bolt |

`compare`: mean of the original 6.30, 7.05, 7.98 against Play's 6.30, 7.04, 7.93 (ratio 0.997), mean absolute difference
0.02 of 255, edge recall 0.982, precision 0.999, sub-pixel shift (0, 0), no outlier block. 77 of 921,600 pixels differ at all, all of them
the bolt (the emitter draws its bolt from the random stream, which Play's frozen frame does not replay); outside a 50 by 440
pixel box around it **at most one pixel differs, by 1 of 255**. That frame holds the lit, environment-mapped `DXLogo`
through `GetFrame`, `DrawMesh`, `Light`, the face helper's reflection and Play's projection and texturing.

Two observations from getting the frames equal. `DXLogo3`'s `Rotation` never changed in the headless runs: a rotating actor
with `bStasis` is ticked only while its `LastRenderTime` is recent, and a classic mesh drawn by nobody never stamped it, so
before this change the logo could not turn (stamping the field each tick in a headless run turns `DXLogo3` to yaw 36,848 in 30
ticks, the original's value); the page now stamps it (`actorRenderFeedback`) and a live run turns it (the first frame
I took, `dxend-play.png`, shows another yaw). And the original's frame is a held tick: the bolt and the logo's yaw are states of it,
which is why Play's frozen run sets the yaw.

### The other three meshes (CheatView frames)

The same harness aims the camera at each actor with the console command `CheatView DeusEx.<Class>` (PlayerPawn's behind view;
`DeusExDeco.<Class>` is not a linked class name, `DeusEx.` is). The original takes it with `--early-cmds`, Play with
`scripts/dx-end-shot.mjs --exec "CheatView DeusEx.<Class>"`, both at the tick-30 hold (the level frozen, so the actors are at
the same state); the diffs are of the 8-bit frames:

| Frame | Pixels that differ (of 921,600) | Largest | What they are |
| --- | --- | --- | --- |
| `EidosLogo0` | 3 | 1 of 255 | nothing but rounding |
| `IonStormLogo0` | 627 | 60 on one pixel (197 by 1, 174 by 2 to 4, 180 by 5 to 16, 76 above) | one or two pixel columns (x = 584 to 585 and 635) along the right-hand edge of narrow bevel faces, where the shade of the last face pixel differs (63 against 85 at x = 585, y = 62); the green glow, the lit faces and every other pixel are equal |
| `DXText0` (below the logo) | 107 | 1 | the letters, their blue glow and the emitter behind are equal |
| `DXText1`, the glyph cut by the right viewport edge (x >= 1250) | 2,014 | 7 | the viewport-clipped, obliquely seen face (see below) |
| `DXLogo3`, `DXText` frame with the logo yaw set to 36,848 | 533 in the top band | 87 on 13 pixels | the electricity bolt and the logo's edge pixels |

(Without `--logo-yaw` the logo in the `CheatView DeusEx.DXText` frame is at the yaw it has after a live flight, not the held
tick's, and the logo's 141,478 differing pixels are that; `dx-end-shot.mjs` sets the yaw by default for that reason.)

The classic meshes' bodies therefore equal the original's frame: positions, the frame's tween, lighting, environment
mapping and texturing, with edge-pixel residuals. **The residuals are not explained by an experiment.** Both kinds sit on a polygon boundary (the near-edge-on bevel
slivers, the viewport clip). The likely cause, untested: Play hands the GPU the original's camera-space points and per-face
colours and three.js rasterises and interpolates them (perspective-correct varyings, no D3D pretransformed-vertex rules, the GPU's
clip rather than the face helper's), the way the LodMesh actors already draw; a measurement of that rasteriser against
Wine's would settle it and would apply to every mesh, not to this path. Whether the largest, 87, is the bolt alone was not checked pixel by pixel.

**Not frame-compared with the original:** the Fly (checked through the oracles, and a spawned Fly was bound, lit and drawn
in Play). FlyGenerator spawns it only while the player is within 700 units and cannot see the spawn point, which the
original-side harness cannot arrange mid-flight, and the DX frames do not contain one.

## Open

* **A GPU path** for the classic meshes ([decided against for now](#gpu-path-decided-2026-10-21)): possible bit-exact, 0.1 to
  0.2 ms of the sim worker's frame on the boot screens at most.
* The Fly against an original frame (above); the edge-pixel residuals of the Ion Storm and viewport-clipped frames, if they
  are ever to be zero, need the D3D pretransformed-vertex rasteriser rules (interpolation and clip) measured, as a pass
  common to every mesh and not to this path.
* A classic mesh in a mirror's child frame, `Fog` on a classic mesh, a Fatness other than the default and
  `bMeshEnviroMap` on the actor (PF_Environment for every face) are translated and compared with the
  oracle (all but the mirror frame and Fog), but none occurs in a shipped scene that was run.
* The viewing player's `Sprite` override (every mesh texture replaced) is in the translation's contract
  and in the oracle comparison (`textureInfo` returns the Sprite's info), but the binding does not apply it:
  the player's `Sprite` is `None` in DX.dx and Training (checked), where the editor's mesh viewer is the
  only thing that sets it.
