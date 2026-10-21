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
`SetupForActor` and the translated `DrawMesh` with `lightVertex` as its `Light`, and sends the page
`posed`, `cameraPoints`, per-corner `colors` (D3D's diffuse bytes, white for a modulated face) and, for
environment faces, `envUv`: the original's reflection UVs, which `actor-mesh-draw.mjs` applies in place
of the camera-relative environment mapping it computes for a LodMesh. Materials, skins, sampling, the
vertex projection and render feedback are the LodMesh CPU path's. The mesh lighting frame carries the
master frame's `PrjXM..PrjYP` for the outcodes.

* **Path.** CPU only. The GPU mesh path (`gpu-mesh.md`) is built around ULodMesh's wedges and
  LOD morph; the five meshes pose and light in a few milliseconds (the three logos together light about
  7,000 triangles a frame, only during the boot flight) and the Fly has seven vertices, so a GPU path was
  not made. It is open, not refused.
* **Frames.** The main frame lights with its own `Coords`, `Mirror` and outcode planes. A mirror
  child frame draws a classic mesh with the main frame's colours and camera points (the LodMesh path
  lights it again with that frame's); a classic mesh in a mirror is not verified.
* **Skins.** As for every mesh, the group skins are resolved when the binding is made.
  `UScale`/`VScale` of the texture info is the texture's `Scale` property and `USize`/`VSize` its first
  mip; the page divides the environment U/V by `USize·UScale` (D3D's normalization is not retraced).

`validate-umesh-play` runs DX.dx and the Island headlessly through the actor mesh layer: the five
classic actors of DX.dx are bound, lit and shown through the flight with finite records, and a Fly a
FlyGenerator spawned on the Island (seed 2; the generator spawns where the player cannot see, within its
`ActiveArea` of 700) is bound, lit and drawn.

## Open

* The original's frame of DX.dx's end pose against Play's: see [boot](boot.md).
* A classic mesh in a mirror's child frame, `Fog` on a classic mesh, a Fatness other than the default,
  `bMeshEnviroMap` on the actor (PF_Environment for every face) and the Player's Sprite override are
  translated and compared with the oracle, but none occurs in a shipped scene that was run.
