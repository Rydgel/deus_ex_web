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
   it and `SetBase(Owner, 1)` is called (`0x103e79d6..0x103e79fe`). Every
   level-BSP surface Actor in the 83 shipped maps is a Brush (368,255
   surfaces); the Movers' surfaces are the ones the moving brush tracker
   adds (see "Movers").
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
the model fresh) and a dropped level frees its blocks. The Mover branch
copies MoverRotation and reports `SetBase(Owner, 1)` to its host (see
"Movers").

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
| 00_Training | 49 | 87 | 83 attached, 3 trace misses, 1 pan flags; 1 Mover branch | 10 |
| 00_Training, tracked model (`--tracker`) | 65 | 111 | 90 attached, 6 trace misses, 13 no surface, 2 pan flags; 11 Mover branches | 28 |
| 01_NYC_UNATCOIsland | 49 | 87 | 83 attached, 2 trace misses, 2 pan flags | 13 |

All bit-equal. Scenarios: Shadows under pawns and the player start (both
Shadow rotators), blood pools growing through ReattachDecal, scorch marks
and bullet holes near polygon edges, curved walls and ramps, six decals on
one spot (texture order and removal), a double attach, degenerate
directions, every gate and synthetic PolyFlags and Mover surfaces. A one-ulp
error injected into the radius fails the comparison. Not reached by any
case: the noItem, noSurface, rotationParallel and offPlane gates and the
24-point assert.

## Drawing

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
on frames built by the original CreateMasterFrame and OccludeBsp.

**Port.** `clip_decal` in decal.rs is ClipDecal in binary32 (the render
pass's precision), operation for operation. `decal_clip_frame` walks the
main frame's OccludeBsp output with its saved points (option `0x100`): for
each draw item whose surface holds FDecals, each decal in TArray order and
each saved polygon its Nodes admit, it writes the fragment's world points and
the U and V dot products. `validate-decal-render.mjs` asks the oracle for
frames (Training at random cameras and its mirror floor, Island, the Paris
club tunnel's mirrors) with synthetic decals and compares every ClipDecal:
762 cases, 286 nonempty, 1,192 points bit-equal in camera-space position, U
and V, mirror child frames included. A 0.01-unit change to the lift fails it.

On a Mover's surface (`0x10b1bfa3..0x10b1c0df`), ClipDecal first turns each
vertex by `GMath.UnitCoords *= FRotator(Actor.Rotation − MoverRotation)`
(Core `0x1011ac80`, the tracker's `mul_rotator`) through an inlined
TransformPointBy, at 24 bits. Of the 762 cases, 107 are on Mover surfaces
and bit-equal; 13 of those are nonempty with a nonzero rotation delta. With
the moving brush tracker, mover surfaces are in the level BSP, so this path
is reachable (see "Movers").

## Play

- **Simulation side** (`src/runtime/decal-draw.mjs`, `sim-session.mjs`
  `visibility`): when the level holds FDecals and Client.Decals is set, the
  main frame's OccludeBsp saves its points and the decal block runs after
  it. Each nonempty fragment stamps its actor's `LastRenderedTime` with
  Level.TimeSeconds. The fragments become view-space triangles (a fan per
  fragment) with `tu = f(f(U / DrawScale) · f(1 / f(USize · Scale)))`, V
  likewise, grouped by texture (the actor's Texture, the viewer's Sprite
  when set, else the level's DefaultTexture), and travel in the frame's
  `visibility` record.
- **Page** (`src/viewer/decal-scene.mjs`): one mesh per texture, blend
  DST_COLOR/SRC_COLOR, no depth write, LEQUAL, no culling, linear
  filtering with nearest mip selection and a −0.5 LOD bias, drawn before the
  translucent world surfaces. Decals sit on their own three.js layer
  (`render-layers.mjs`), which the mirror and sky cameras leave out.
- **Check.** `validate-decals-play.mjs` (worker mode by default, or
  `--query sim=inline`) stands the player a few metres from JaimeReyes0 in
  Training looking at its feet: the drawn pawn's Shadow attaches, the
  Shadow's LastRenderedTime equals TimeSeconds, its FlatFXTex40 fragments
  reach the page, and rendering the same frame with and without the decal
  layer darkens about 3,500 pixels and brightens none. `decalProbe` on the
  viewer API places the player and reads the state on the simulation side.

Cost (Linux host, headless worker-side session on 01_NYC_UNATCOIsland,
1920×1080, interleaved runs, medians over 240 frames): the decal block takes
0.012–0.016 ms a frame; OccludeBsp with points saved takes 0.14–0.18 ms
against 0.15–0.16 ms without (noise). The frame's `visibility.ms` records
both.

Host choices, noted:
- Fragments are drawn from their world points with the page's projection.
  ClipDecal's screen clamp for points flagged outside the view is not
  applied; the fragments lie inside the saved polygons, which OccludeBsp
  already clipped to the view.
- The fragment order is the occlusion stream's, not DrawFrame's pass order
  (the occluding list is key-sorted there); modulated blends commute up to
  the framebuffer's rounding, and every decal is drawn before the
  translucent surfaces.
- Mirror child frames draw no decals, as the original's ClipDecal returns
  nothing there; sky child frames draw none either, where the original
  would (unexercised).
- Texture sampling follows the D3D state as far as WebGL allows; D3D's mip
  choice and texture upload rules are device behaviour.

## Movers

With the moving brush tracker ([brush tracker](brush-tracker.md)) each
mover polygon is an FBspSurf whose Actor is the Mover, and its fragments
are solid nodes of the level model where the mover was last rendered.
AttachDecal's LineCheck and FindSurface run over that model, so a decal can
attach to a door:

- **Mover branch** (`0x103e79d6..0x103e79fe`): FDecal.MoverRotation is the
  Mover's Rotation (`+0x120`) and `this->SetBase(Owner, 1)` follows. The
  grid's neighbour FDecals do not take the branch (their MoverRotation stays
  zero).
- **Nodes.** UModel::PostLoad built Surf.Nodes at load, so a tracker
  surface's list is empty and so is its FDecal.Nodes; the decal block then
  clips the decal against every drawn fragment of the surface.
- **Following the mover.** Update rewrites a tracker surface's base point
  and vectors in place, the FDecal's Vertices stay relative to the base,
  and ClipDecal turns them by `Actor.Rotation − MoverRotation` (above).

**Reference.** `validate-decal-attach.mjs --tracker` builds the model the
tracker filters Training's 25 movers into (two of them raised 96 units by
an Update at 24 bits; `brush-tracker.mjs trackedModel`). The oracle gives
every tracker surface a Mover with its Rotation and runs UModel::PostLoad
over the original nodes only. Scenario 9 of `native-decal-cases.py` adds
16 bullet holes, scorch marks and blood splats on mover fragments, their
Owner the surface's Mover as TraceHitSpawner spawns them. All 65 scenarios
are bit-equal, with 11 Mover branches: MoverRotation, the one SetBase call,
its NewBase (the Owner) and bNotifyActor 1.

**The port.** `decal_attach` writes MoverRotation from the surface record
(the Mover's Rotation, words 6..8) and sets IO word 54. The host
(`script-decal.mjs attachDecalSurfaces`) then runs the recovered
`AActor::SetBase(decal, Owner)` with notification. `decal_clip_frame`
passes `Rotation − MoverRotation` (int subtraction) to ClipDecal on Mover
surfaces.

**Play.** `sim-host.mjs` sets `level.decalSource`
(`brush-tracker.mjs trackerDecalSource`) when it builds the tracker:

- `levelDecals` uploads the decal model and its trace model from the
  tracked model, with room for the tracker's points. A store made before
  the tracker existed grows into the tracker's surfaces (`setModel`,
  decal.rs `decal_store_resize`). GNewBrushTracker also runs after the
  actor start-up in the original.
- After that, `followDecalTracker` keeps the model current. When the
  tracker's generation word (header 51, bumped by every Update that rebuilt
  a mover) has moved, `decal_model_sync` rewrites the nodes, verts, points,
  vectors, tracker surfaces and trace nodes from the tracker's arrays. Every
  Mover surface's Rotation word is also refreshed from its actor. This runs
  before each AttachDecal, and before the decal block when a tracker
  surface holds an FDecal.

Checks of the plumbing (the port against itself):
`validate-decal-attach --tracker` lays each scenario's store out again
after its first operation, and compares a model synced after three more
Updates with a fresh upload (a run without the sync fails).
`validate-decals-play` (worker mode) faces DeusExMover16's largest fragment
in Training and spawns a BulletHole on it as TraceHitSpawner does. Its
SurfList holds the tracker surface, its Base is the Mover, and its 6
fragment points are drawn 0.75 units off the tracked plane. They stay on
the plane when the mover is raised 16 units (their centre moves with it) and
when it is turned 2048 units. With ClipDecal's rotation left out, the
turned check fails.

Host choices, noted:
- SetBase runs when the native returns, not between the FDecal entry and
  the quad. Its events (Detach and Attach on the bases, the decal's
  BaseChange) then see the finished FDecal lists, which no script reads.
- Rotation words are read from the movers' actors at each call. ClipDecal
  and the Mover branch read `Surf.Actor->Rotation` at theirs.

## Open

- Decals in sky child frames.
- The game-thread control word (above).
