# Decals (FBspSurf.Decals)

Decals are the Shadow blobs under pawns and the blood pools, scorch marks and
bullet holes that combat leaves. A decal actor attaches itself to BSP
surfaces with the native `AttachDecal`, which adds FDecal entries to
`FBspSurf.Decals`; the renderer draws those entries after each surface. This
page records the recovered contract, the reference that checks it, and the
port. Startup, the constructor and the gates before the surface path are in
[decal startup](script-decal-startup.md).

## Authority

Engine.dll `0c3a8b18…20b4`, Core.dll `8bf3039e…a7e4`, Render.dll
`607f1077…d75d1` and D3DDrv.dll, as hash-pinned by the native oracles; the
SDK 1112f headers (`UnObj.h`: FBspSurf, FDecal; `RenderPrivate.h`: ClipDecal)
name the structures. Instruction-level notes (local, untracked):
`.work/decals/attach.md`, `.work/decals/render.md`.

Layouts: FBspSurf (stride 0x40) PolyFlags `+4`, pBase `+8`, vNormal `+0xc`,
Actor `+0x24`, Decals TArray `+0x28`, Nodes TArray `+0x34`. FDecal (stride
0x4c) Vertices[4] `+0` (offsets from the surface base point), Actor `+0x30`,
Nodes TArray `+0x34`, MoverRotation `+0x40` (a Deus Ex addition). ADecal
MultiDecalLevel `+0x318`, LastRenderedTime `+0x31c`, SurfList `+0x320`.

## AttachDecal (`0x103e7250`)

After the gates (Client.Decals, Texture, the MultiDecalLevel clamp to at
most 4; [decal startup](script-decal-startup.md)):

1. **Trace.** `V = normalize(-XAxis) · TraceDistance`, XAxis from
   `GMath.UnitCoords / Rotation`; the inline normalize sums
   `(z² + y²) + x²` and applies only when that is at least 1e-8.
   `UModel::LineCheck(End = Location + V, Start = Location)` with a zero
   extent and ExtraNodeFlags 6; a miss or `Item == -1` returns false.
2. **Random direction.** When every DecalDir component compares equal to 0
   (or unordered), the code draws `R.c = f(2·appFrand() − 1)` for x, y, z
   until `SizeSquared(R) <= 1` and takes `UnsafeNormal(R)`; three rand()
   calls per try.
3. **Surface.** P1 is where the trace segment meets the hit node surface's
   plane; FindSurface (`0x103e9090`) walks the hit node's coplanar chain and
   returns the first polygon containing P1 (edge sides from `N × e`, a zero
   side resetting the sign memory), or -1 → false. P2, the decal centre, is
   recomputed on the selected surface's plane.
4. **Gates.** False when `XAxis · N` compares equal to 0, when
   `|(Base − P2) · N| > 0.001f`, or when the surface has PF_AutoUPan or
   PF_AutoVPan (`0x600`).
5. **Entry.** InsertDecal puts a zeroed FDecal before the first entry whose
   Actor's Texture equals this decal's Texture, else at the end: entries
   group by texture, newest first within a group. SurfList gains the
   surface. If the surface's Actor is a Mover, MoverRotation is copied from
   it and `SetBase(Owner, 1)` is called; every level-BSP surface Actor in the
   83 shipped maps is a Brush (368,255 surfaces), so this branch is
   unreachable in the shipped game.
6. **Quad.** Radius `f(sqrt(double(DS·DS·USize·USize·0.5)))` (VSize is not
   read). With an explicit DecalDir, its projection P on the plane and
   `W = P × N` give the diagonals `normalize(P̂ + Ŵ)` and `normalize(P̂ − Ŵ)`;
   a random direction, or a projection below 1e-4 on every axis (then
   `DecalDir = Base − P2`), gives `U0 = D` projected and `U1 = U0 × N`.
   `V0 = P2 + R·Û0`, `V1 = P2 + R·Û1`, `V2 = P2 − R·Û0`, `V3 = P2 − R·Û1`.
7. **Nodes** (GatherNodes `0x103e9340`): the quad is clipped against each
   node polygon of the surface in `Surf.Nodes` order (UModel::PostLoad
   builds it, every node ascending), keeping distances >= 0; a node that
   keeps a point joins FDecal.Nodes. A fixed 24-point buffer asserts beyond.
8. **Grid.** For `i, j < L` (L the clamped MultiDecalLevel), the sample
   `V0 + E1·(i+1)/L + E2·(j+1)/L` (E1 = V1 − V0, E2 = V3 − V0) is traced 16
   units either side along the unit normal. A hit surface not yet in
   SurfList, without the pan flags, whose normal is within `|cos| > 0.7` of
   the first surface's (so non-coplanar neighbours too) gets its own FDecal:
   each vertex is projected onto the neighbour plane by a two-projection
   formula, then it gets its own Nodes, and its vertices are made relative
   to its base point at once.
9. **Finish.** The first FDecal's vertices become relative to its surface
   base, and the result is true.

Every arithmetic step is the listing's: per-site sum orders, f32 stores,
unrounded x87 intermediates, `appSqrt` as FSQRT of a double, and the double
stores some sites make before dividing.

**DetachDecal** (`0x103e9a30`) takes SurfList from its last entry; for each,
it removes the first FDecal on that surface whose Actor is this decal, and
pops the entry. A surface listed twice loses two entries.

**Other code touching decals.** FBspSurf serialization handles Decals only
for reference-collecting archives, so a loaded level starts with none.
UModel::EmptyModel, the UModel and UBspSurfs copies and assignments
(editor and duplication paths) and Render.dll's DrawFrame are the other
users. Nothing moves or re-projects an FDecal when a mover moves, and
DeusEx.dll never touches them.

## Precision

AttachDecal runs on the game thread. The oracle runs at control word
`0x037f` as the other game-thread oracles do; all scenarios give the same
results at `0x027f`, and 7 of 49 differ at `0x007f`. The live game-thread
control word stays the open question recorded in the x87 notes.

## The port

`native/script-vm/src/decal.rs` translates AttachDecal, FindSurface,
GatherNodes and DetachDecal on the x87 model. It runs in the script-VM
kernel instance, next to the BSP occlusion that will draw the decals, with
its own model block (nodes, verts, points, vectors, surfaces with Surf.Nodes,
and a trace model for `trace.rs`'s LineCheck) and one store per loaded level:
each surface's FDecal list as a linked list of records in TArray order.
`src/runtime/decal-kernel.mjs` uploads the model and owns the store; the
Engine.Decal natives in `script-runtime.mjs` call it through
`script-decal.mjs`, which passes the shared stream's rand() and each decal
actor's live Texture. A Player-start reload drops the store (LoadMap loads
the model fresh) and a dropped level frees its blocks. The Mover branch is a
labelled boundary (fault 6).

The JavaScript surface path this replaced was not the original: it probed
along DecalDir instead of the trace, kept one record per texture, attached
only coplanar neighbours and built no vertices or Nodes.

## Verification

`node scripts/validate-decal-attach.mjs [--map M] [--compare]` exports the
map's model (`decal-model-export.mjs`), lets `native-decal-cases.py` build
the scenarios on the real BSP with the original LineCheck and run them
through the unchanged AttachDecal and DetachDecal under Unicorn
(`native-decal-oracle.py` attach mode), then runs each scenario through the
port with the oracle's rand() values. After every operation the result, the
exit, SurfList, the rand() count and every surface's FDecal list (actor,
Vertices bits, Nodes, MoverRotation) must be equal.

| Map | Scenarios | AttachDecal calls | Exits | Neighbour FDecals |
| --- | ---: | ---: | --- | ---: |
| 00_Training | 49 | 87 | 82 attached, 3 trace misses, 1 pan flags; the Mover boundary | 10 |
| 01_NYC_UNATCOIsland | 49 | 87 | 83 attached, 2 trace misses, 2 pan flags | 13 |

All bit-equal. Scenarios: Shadows under pawns and the player start (both
Shadow rotators), blood pools growing through ReattachDecal, scorch marks
and bullet holes near polygon edges, curved walls and ramps, six decals on
one spot (texture order and removal), a double attach, degenerate
directions, every gate and synthetic PolyFlags and Mover surfaces. A one-ulp
error injected into the radius fails the comparison. Not reached by any
case: the noItem, noSurface, rotationParallel and offPlane gates and the
24-point assert.

## Drawing (recovered, not yet in Play)

URender::DrawFrame (`0x10b1b0ca–0x10b1b34d`) draws a surface's decals
immediately after its DrawComplexSurface when `!RenDev->SpanBased &&
Client->Decals`. For each FDecal in array order and each saved polygon of
the draw item whose node is in the decal's Nodes (all when Nodes is empty),
ClipDecal (`0x10b1bda0`) yields a convex fragment; a nonempty one stamps
`LastRenderedTime = Level.TimeSeconds` (script-visible: DeusExDecal.Timer
destroys decals not drawn for a second) and draws with PolyFlags exactly
`0x40` (PF_Modulated).

- **ClipDecal.** The quad `Base + Vertices[k]` (rotated by the mover's
  rotation delta on movers) is lifted 0.75 units along the unit normal,
  clipped in world space against the planes through the eye and each edge
  of the saved polygon (kept side >= 0), projected, and given
  `U = ((W − Base − V0) · unit(V1 − V0)) / DrawScale` and V likewise along
  V3 − V0. Binary32 throughout, in a fixed order (the render pass runs at
  24-bit precision).
- **Mirrors.** In mirror child frames the saved polygon's winding is
  reversed and ClipDecal always returns nothing: decals do not appear in
  reflections.
- **D3D.** A triangle fan; blend DESTCOLOR/SRCCOLOR (`2·tex·dst`), no depth
  write, LESSEQUAL, no depth bias, no culling, no fog; diffuse white; WRAP,
  bilinear, point mip selection with LOD bias −0.5; palette index 0 is not
  transparent. `tu = U / (USize · UScale)`.
- **Texture.** `Actor->Texture->Get(time)`, None → the level's
  DefaultTexture; consecutive decals with one texture share a Lock.

`scripts/native-decal-render-oracle.py` runs the unchanged ClipDecal, the
D3D DrawGouraudPolygon against a recording device and the whole decal block
on frames built by the original CreateMasterFrame and OccludeBsp (935
ClipDecal cases on Training, Island and the Paris club tunnel; a float32
re-derivation matched all of them and 12,000 more).

## Open

- The decal pass in Play: ClipDecal in the Rust occlusion run, the stamp,
  the page's modulated fan pass.
- Movers: what the brush tracker writes into a mover surface's base and
  normal (with the tracker itself, [BSP occlusion](bsp-occlusion.md)).
- The game-thread control word (above); sky child frames were not
  exercised for decals.
