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

### Draw order

Decals are the one place in a frame where the order of two modulated draws
shows: each `2·tex·dst` is rounded and clamped to the 8-bit target, so two
overlapping fragments of different textures leave a different pixel in each
order (`dst = 200`, texels 190 then 76: 255 then 152; 76 then 190: 119 then
177). Where the draws come from, in Render.dll:

- **Surfaces.** DrawFrame copies the frame's three draw lists
  (`Frame->Draw[0..2]` at `+0x98`, linked through `+0x38`; SDK
  `UnRender.h`: portals, occluding, non-occluding) into arrays
  (`0x10b1a404..0x10b1a434`), reverses the first (`0x10b1a436..0x10b1a45a`),
  sorts the second by `FBspDrawList.Key` (`0x10b1a45f`, thunk `0x10b01028` →
  `0x10b20570`) and walks the three in turn (`0x10b1a4c1..0x10b1b46a`). Each
  item's surface is drawn (the device call at `0x10b1b057`) and its decal
  block follows at once (`0x10b1b0ca`).
- **Decals of one surface.** The block's outer loop is the FDecal TArray
  (`0x10b1b0ed`, `Num` read again each turn), the inner one the item's saved
  polygons in list order (`0x10b1b1c7..0x10b1b2b0`): decal by decal, and for
  each decal polygon by polygon. InsertDecal makes the TArray group by
  texture, the groups in the order their first decal attached, newest first
  within a group: a scorch mark attached before two bullet holes on a wall
  draws first; on a door that took a bullet hole first, after both.

`validate-decal-order.mjs` runs the block unchanged under Unicorn (the
oracle's block mode, below) on 103 draw items of Training and the Island
(333 FDecals, 2 to 5 on a surface, Nodes lists that admit one polygon or
none) and requires the port's fragments in the order and with the point
counts of the original's 282 DrawGouraudPolygon calls. In 18 of the items a
decal draws on two polygons with another decal after it, so a walk polygon
by polygon gives another order; the port walked so until 2026-10-28 and
fails the check that way (Training's item on surface 2038 first).

`scripts/native-decal-render-oracle.py` runs the unchanged ClipDecal, the
D3D DrawGouraudPolygon against a recording device and the whole decal block
on frames built by the original CreateMasterFrame and OccludeBsp.

**Port.** `clip_decal` in decal.rs is ClipDecal in binary32 (the render
pass's precision), operation for operation. `decal_clip_frame` walks the
main frame's OccludeBsp output with its saved points (option `0x100`): for
each draw item whose surface holds FDecals, each decal in TArray order and,
for it, each saved polygon its Nodes admit, it writes the fragment's world
points and the U and V dot products, in the block's order ("Draw order"). `validate-decal-render.mjs` asks the oracle for
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
  likewise, in the decal block's order, as runs of one texture (the actor's
  Texture, the viewer's Sprite when set, else the level's DefaultTexture),
  and travel in the frame's `visibility` record.
- **Page** (`src/viewer/decal-scene.mjs`): one mesh per run, each drawn
  after the one before it (render orders −1 + k·2⁻²⁰), blend
  DST_COLOR/SRC_COLOR, no depth write, LEQUAL, no culling, linear
  filtering with nearest mip selection and a −0.5 LOD bias, drawn before the
  translucent world surfaces. Decals sit on their own three.js layer
  (`render-layers.mjs`), which the mirror and sky cameras leave out. Until
  2026-10-28 the page drew one mesh per texture, in the order the page first
  met the textures, so overlapping decals of two textures blended in that
  order whatever their surface's TArray said (below, "Combat decals").
- **Camera frames.** A ViewportWindow's DrawWorld runs the decal block on its
  own frame (docs/script-window-viewport.md "Camera pass"): its OccludeBsp
  saves the points, the fragments travel in the plan and the page draws them
  in the window's rectangle. `validate-terminals-camera-browser.mjs --camera=2018,-1588,40,-16000,0`
  looks down at JC in ComputerSecurity1's room: the same paused frame without
  the decal block differs in 104 window pixels, all darker with it.
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
- Fragments are drawn from their world points through the main frame's vertex
  chain (2026-10-14, [frame projection](frame-projection.md), "Decals"):
  `fpView`, then ClipDecal's tail, including the screen clamp of a point its
  outcode flags (`0x10b1c660..0x10b1c825`), then D3DDrv's vertex. The oracle
  checks it on 1,192 fragment points bit for bit (`validate-decal-render`).
- The draw items come in the occlusion stream's order, not DrawFrame's
  three lists (portals reversed, occluding sorted by Key, non-occluding as
  linked: "Draw order"); within an item the order is the original's. Two
  items' fragments overlap on screen only where coplanar surfaces overlap,
  and every decal is drawn before the translucent surfaces, where the
  original draws a non-occluding surface's decals among that list. Since
  2026-10-28 the decals also draw after the fog maps, as DrawFrame's decal
  block follows DrawComplexSurface, whose last pass is the fog map
  ([DrawFrame's draw order](bsp-occlusion.md#drawframes-draw-order)); a
  decal on a fogged surface was not compared with an original frame.
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

## Against the original (2026-10-16, gate row 4.2.15)

Training's pawns' Shadow decals in a frame of the original, captured on the Mac under CrossOver at Brightness 2/3 (the Shot is the
framebuffer; Play's ramp at 0.4 is the identity), against Play's frame at the same camera and clock. Two cameras over the gallery where
JaimeReyes0, WaltonSimons0 and mib1 stand in a row: `shadow2` (211,1266,-33 looking along yaw 61567, pitch 62500) and `shadow3`
(61,1326,-23, yaw 59067, pitch 61166), each with its frame without decals (`<view>-base`: the original after `set WinDrv.WindowsClient
Decals False`, which DrawFrame and AttachDecal both read; Play's decal layer hidden) and the state of every Shadow actor at the shot.

**What the frame depends on.** `DeusEx.Shadow.Tick` (embedded source) does nothing while its owner stands still and it holds a decal
(`VSize(Owner.Location - lastLocation) < 0.1`, `bHasDecal`). Otherwise it detaches, and re-attaches only if the shadow or its owner was
drawn within the last second of level time (`LastRendered()`, native 723, reads Actor.LastRenderTime; the player always): a trace 480
units down from the owner, `DrawScale = CollisionRadius/15 - (dist - CollisionHeight)/130` (times ScriptedPawn.ShadowScale, floored at 0),
`SetRotation(Rotator(HitNormal))`, `AttachDecal(32, (0.1,0.1,0))`. A frozen level shows only the spawn's `Decal.BeginPlay` attach
(`AttachDecal(100)` from the feet, DrawScale 1, rotation (16384,0,0)); the first unfrozen Tick (`lastLocation` is still zero) detaches every
shadow and attaches again those whose owner has been drawn. So the shadows in a frame follow the owners' Locations and what each program
drew since the release, and the captures hold or measure each:

- **The level is unfrozen** after the clock is held (`--unfreeze`), so Shadow.Tick runs.
- **The walkers stand.** mib1 (class MIB, Orders Wandering) picks a destination with `FRand` as soon as it lands; ScientistMale0
  (ScientistMale, Patrolling) walks its route. Their walks are each program's own: the original free-runs near 200 ticks a second at the
  actor-delta floor of 0.005 s while Play steps 60, and the destination is a draw from a stream the programs do not share. Measured in a
  capture without the hold: at the freeze, the original's mib1 at (329.91, 1236.84) heading (25.7, 28.6), Play's at (292.61, 1215.74) heading
  (38.3, 2.2). Both consoles type `set MIB Orders Standing` and `set ScientistMale Orders Standing` (`--cmd`) while the pawns are still
  frozen in StartUp, so their first tick enters Standing. An input of the held state, like the hidden meshes below; their walks are not compared.
- **The meshes are hidden at the shot** (`--pre-shot-cmd 'set ScriptedPawn bHidden True'`): the pawns' BreatheLight poses move between a frame
  and its frame without decals (in the original seconds apart), which a contribution would count. A hidden owner that stands keeps its decal
  (Tick's early return), so only the shadows' inputs remain.
- **The level is frozen again before the shot** (`--pre-shot-cmd 'set LevelInfo bPlayersOnly True'`). The original runs on while the
  state is read, about a second after its Shot: a first capture read mib1's shadow 140 units from where its frame had it. Frozen, the read is
  the frame's state. The state at the shot then depends on the order of the views (the first view's shot freezes it), so the store holds the
  row's order.
- **The camera moves as the original's console moves it.** The original types `set Location`, then `set ViewRotation`, and draws frames in
  between at the new Location with the old rotation; Play's probe placed both at once. ScientistMale0 is drawn only in such a frame (from
  `shadow2`'s Location at the start's rotation (0,0,0): its LastRenderTime 54.5185 s, between the hold at 54.5071 s and the shot), so its
  shadow was attached in the original and not in Play until `play --camera-transit` (Location, six frames, then the rotation).
- **No animated surface in view.** The recipe's first camera (`shadow1`, 61,1326,-23 at yaw 61567, pitch 62166) holds a console's
  animated screen and a flickering patch, which change between any two frames of either program: its contribution read correlation .945 and
  .78 in two captures with the same shadows bit-equal. `shadow3` sees the same three shadows without them.

**Result** (original held at 54.507 s, `shadow2` and `shadow3` in that order; the gate's run twice, the same numbers):

| | shadow2 | shadow3 |
| --- | ---: | ---: |
| Frame: mean abs. difference, edge recall / precision, outlier blocks | 0.01, 1 / 1, 0 | 0.01, 1 / 1, 0 |
| Shadows drawn (stamped `LastRenderedTime` at the shot), both programs | JaimeReyes0, WaltonSimons0 | JaimeReyes0, WaltonSimons0, mib1, the player |
| Contribution (frame less frame without decals): correlation, residual, Play's sum over the original's, agreement | 1.0, 0, 1.0, 1.0 | 1.0, 0, 1.0, 1.0 |
| Samples the decals change (either program), of them changed by a different amount | 57,851, 146 (by one level) | 57,571, 128 (by one level) |
| Shadow actors equal (bHasDecal, surfaces; owner Location where attached; Location, DrawScale, Rotation where attached in both) | 19 of 19, 5 attached | 19 of 19, 5 attached |

The state is compared as float32, bit for bit: for example JaimeReyes0's shadow at (361.279, 1206.008, -95.5), DrawScale 1.30025649
(20/15 - (42.6 - 38.3)/130), Rotation (16383, -32767, 0) for a floor normal, in both programs; the 14 pawns never drawn hold a detached shadow at
their spawn place in both. The frames otherwise differ in 21,317 and 16,687 samples (at most 17 and 7 levels), the same in the frames without
decals: the scene's, not the decals'. The one-level differences are the modulated blend's rounding (`2 tex dst` on the 8-bit target against
GL's blend), not measured further, and against CrossOver's D3D on the M2, not a Windows driver.

Tooling: `visual-acceptance.mjs --decal-state` (both sides: `dump-actor-win.exe Shadow` in the original, Shadow.lastLocation +0x32c and
bHasDecal +0x338 mask 1 by the linked properties, `liveProbe` in Play; `compare --decal-state`), `play --camera-transit`, `--cmd` in the gate,
and `compare --contribution` for an effect that darkens (its own pixels are those at least one level darker; the haze reads as before).
Not in a frame: bullet holes, scorch marks and blood, which need combat (bullet holes and scorch marks since: "Combat decals against the
original" below). Weak: two views of one gallery, and the two walkers are held, not matched.

```bash
scripts/original-views.sh 00_Training --view shadow2:211,1266,-33:62500,61567,0 --view shadow3:61,1326,-23:61166,59067,0 --view shadow2-base:211,1266,-33:62500,61567,0 --view shadow3-base:61,1326,-23:61166,59067,0 --brightness 0.666667 --cmd 'set MIB Orders Standing' --cmd 'set ScientistMale Orders Standing' --unfreeze --base-cmd 'set WinDrv.WindowsClient Decals False' --pre-shot-cmd 'set ScriptedPawn bHidden True' --pre-shot-cmd 'set LevelInfo bPlayersOnly True' --decal-state
node scripts/validate-stage4-acceptance.mjs --only '^4\.2\.15$'
```

## Combat decals against the original (2026-10-28)

Bullet holes and scorch marks in frames of the original (Linux host, Wine 11.20, the game in the prefix's 1400×860 virtual desktop,
Brightness 2/3 so the Shot is the framebuffer) and of Play (headless Chromium, ANGLE GL, worker mode, Brightness 0.4) at one camera
and one held level time (101.295 s).

**The scene** (`scripts/combat-decal-views.sh`): 00_Training's start doors, with decals placed by the original's own console
`summon` in both programs, not by combat, whose aim draws from a stream the programs do not share. PlayerPawn.Summon spawns at
`Location + (CollisionRadius + Default.CollisionRadius + 30)·Vector(Rotation) + 15 z`, 50 units ahead for JC and a decal: the ghost
stands 34 units behind the face, facing it from behind (Rotation (0,0,0), set with ViewRotation), so the decal spawns 16 units in
front and its trace back meets the face. BulletHole.BeginPlay attaches with `AttachDecal(32, (0.1,0.1,0))`, which draws nothing.
ScorchMark.BeginPlay draws `FRand() < 0.5` for FlatFXTex39 and Decal.BeginPlay's `AttachDecal(100)` a random direction, so both
programs start that summon from CRT rand state `0x11223344` (`--cmd '@rng 11223344'`: in the original `dx-live-win.exe rngpin`
writes it at the next `ULevel::SpawnActor`, Engine `0x10394f60`, one hit; in Play viewProbe seeds the shared stream before the
line; nothing between the line and the spawn draws). The first draw is 0.970, so FlatFXTex38. On the wall (surface 88, x −1184) a
scorch then two bullet holes over it: TArray `[ScorchMark0, BulletHole1, BulletHole0]`. On DeusExMover49's leaf (the tracker's
surface 5348, x −1188) a bullet hole, the scorch, a bullet hole: `[BulletHole3, BulletHole2, ScorchMark1]`. The two surfaces draw
their textures in opposite orders, so one mesh per texture draws one of them in the wrong order, whichever texture it puts first.
Views `wide` (−1010,800,−80), `wall` (−1134,716,−80) and `door` (−1138,800,−80), all yaw 32768; each `-base` is the original after
`set WinDrv.WindowsClient Decals False` (DrawFrame's gate) and Play with its decal layer hidden.

**State.** `--decal-state` reads every BulletHole and ScorchMark after each shot: in the original `dump-actor-win.exe <class> ...
FDecals:0:decals` (SurfList, then through XLevel → Model → Surfs each surface's FDecal TArray), in Play `decalProbe({state})`. All
six are equal in both programs, compared bit for bit: Location, Rotation, DrawScale, Texture, SurfList, the TArray order of each
surface, and each entry's Vertices, Nodes (`[1081]` on the wall, none on the tracker surface) and MoverRotation ((0,−16384,0), the
door's Rotation, on the mover).

**Result** (the frame less its frame without decals is the contribution; samples are the 2,764,800 channel values of a frame):

| | wide | wall | door |
| --- | ---: | ---: | ---: |
| Frame: mean abs. difference, edge recall / precision | 0.01, 0.999 / 1 | 0, 1 / 1 | 0, 1 / 1 |
| Samples the decals change (either program) | 84,878 | 548,361 | 525,344 |
| Contribution: correlation, residual, Play's sum over the original's | 1.0, 0.001, 1.0 | 1.0, 0, 1.0 | 1.0, 0, 1.0 |
| Samples whose contribution differs | 202 (194 by one level, 8 by two) | 26 (one level) | 29 (one level) |
| Samples the frames differ in, with decals / without | 7,444 / 7,250 | 183 / 201 | 97 / 118 |
| Before the order fix: samples whose contribution differs | 215 | 26 | 650 |
| Samples the order fix changed in Play's frame | 52 | 0 | 621 |

The page used to draw the scorch texture's mesh first: right for the wall, wrong for the door, where the original draws both bullet
holes before the scorch. With the decal block's order (decal.rs, decal-draw.mjs runs, decal-scene.mjs) the door's contribution
differs in 29 samples instead of 650. Play's frames before the fix came from a first run without the held clock; the wall view, which
the fix leaves alone, is the same sample for sample in both runs, so the scene held still. The frames' other differences are the
scene's (the frames without decals differ as much: up to 7 levels in `wide`, along the doorway's outline). The remaining
one-level differences are not measured further: the bilinear weights and the blend's rounding of wined3d's GL against Chromium's
WebGL on the same GPU, as in the Shadow comparison above.

Weak: the start room is dark (no framebuffer value above 32 of 255 in these views), so no `2·tex·dst` reaches the clamp here and
a wrong order shows only as a level's rounding. Blood (BloodSplat, BloodPool) is not in a frame.

```bash
scripts/combat-decal-views.sh play
scripts/combat-decal-views.sh original
scripts/combat-decal-views.sh play
scripts/combat-decal-views.sh compare
node scripts/validate-decal-order.mjs
```

## Fast surface finding (2026-11-06)

**What the attach cost.** `FindSurface` walks the hit node's coplanar chain (`iPlane`: every node of the level in that plane, in node
order) and tests the point against each polygon vertex with about 31 x87 operations; `GatherNodes` clips the quad against every
polygon of the surface. A 1,500-tick run (300 warm-up) of the scan route, counted in the kernel: the Area 51 bunker made 11,083
attaches, 5.0 million chain nodes and 17.9 million vertex tests (451 nodes, 1,616 vertex tests an attach) and 4.0 million
`GatherNodes` distances; the Island 15,822 attaches, 0.45 million chain nodes, 2.4 million vertex tests, 5.0 million distances.
The Gecko profile of the bunker (Firefox inline, 60 s, god mode) puts `attachDecalSurfaces` at 0.16 ms a drawn frame, of which
`find_surface` and the `Ext` operations under it 0.11, `gather_nodes` 0.02, the JavaScript glue 0.02; in the slowest tenth of ticks
the x87 leaves of `find_surface` (`find_surface` itself, `Ext::rounded`, `Ext::add`) are 1.14 ms against 0.03 in the rest.

**What it decides.** Both functions use their floating-point values only for signs. `FindSurface` compares `side = d2 - d1` and
the f32 store of the previous vertex's with zero; `GatherNodes` compares each clipped point's stored distance with zero and the
distance goes nowhere else. Two exact steps replace the arithmetic (`native/script-vm/src/decal/fast.rs`; the reference bodies stay in
`decal.rs` and run for `DECAL_FAST=off`):

1. **The edge plane is a function of nine words.** `cy`, `cz` (stored), `cx`, `d1` (unrounded; `cxf`, `w` stored for `GatherNodes`) come
   from the vertex, the previous vertex and the surface normal alone. They are computed once by the reference's x87 expressions and kept in
   a direct-mapped table keyed on those nine words, slot picked by the vertex's place in the vertex pool: a hit is the same inputs, so the
   same outputs; a mover's polygon that moved simply misses. The table is 16,384 entries of 72 bytes the host allocates in the kernel
   instance (`decal_fast_table`; the 2 MiB of statics have no room), 256 static entries without it.
2. **A sign far from zero is decided in f64.** Products of two f32 values are exact in f64 (48 bits); `cx` and `d1` are rounded to f64
   once, at the table entry. With `Q` the sum of the magnitudes of the terms and `Y` the exact real value of the expression, the f64
   value `X` has `|X - Y| <= 4 * 2^-53 * Q` (six operations, two roundings of constants, 2^-53 of one term each), and the x87 value at
   64-bit precision `|S - Y| <= 3.01 * 2^-64 * Q` (three roundings of 2^-64; a rounding never flips a sign and the model's exponent range
   is unbounded). When `|X| > 2^-44 * Q` (a factor 128 over the bound) and `|X| > 1e-30` (so the f32 store neither underflows nor
   rounds to zero), `sign(S) = sign(X)`. A NaN or infinity anywhere, a value outside the exponent window the entry accepts, or a sign near
   zero falls back to the reference expression, and so does every call at 24-bit precision (the render pass; the table and the filter
   assume 64).

**Evidence.** `scripts/validate-decal-fast.mjs` builds the module with the `selftest` feature (not shipped) and compares the fast sign
with the x87 expression over 12 million generated cases (random edges and points, points exactly on the edge line, a few ulps off it,
at the vertex, degenerate edges, normals along an axis): zero mismatches, the filter deciding 67% of the vertex signs and 85% of the
distances. With the margin shrunk to 2^-55 the same run reports 36,213 mismatches in 2 million cases, so the test sees a wrong bound.
`DECAL_FAST=verify` (`?decalFast=verify`) runs both bodies on every call and compares the surface found, the node list, every table hit
against a fresh computation and every filtered sign against the expression; a difference is `DecalKernelFault` 8.

| Check | Result |
| --- | --- |
| `bench-sim --render-feedback` digests, `DECAL_FAST=on` and `verify` | the five baselines (Island, Training, Airfield, Wan Chai, bunker) and both long routes (bunker `ccd09a24aaaad820`, Island `0b4d06c72afd1c1d`) unchanged, no tick errors |
| Firefox inline `?decalFast=verify`, 40 s scan route | bunker and Island: no page errors |
| `validate-decal-attach` (Unicorn oracle), `on` and `verify` | Training, Training `--tracker`, Island: every FDecal list bit-equal to the original, PASS |
| `validate-decal-startup`, `npm test` | 6 native comparisons; 947 of 951 pass, 4 skipped, 0 fail |
| Edge table, 1,500-tick bunker route (Node) | 16,384 entries: 18.84 million hits, 47,107 misses (99.75%); 1,024 entries 71.6%, 4,096 94.1%, 65,536 99.94% (no faster than 16,384). Island: 98.6% at 16,384 |
| Signs the filter left to the x87 expression | bunker: 0 vertex, 16,035 of 4.0 million distance signs; Island: 318 and 7,530 |
| Node tick, bunker long route, `off` then `on` | mean 4.94 -> 3.77 ms; Island 6.32 -> 5.92 ms (V8, one run each, indicative) |
| Firefox inline A/B, bunker scan route, 4 interleaved pairs | mean tick 6.00 -> 5.51 ms, slowest tenth 11.93 -> 10.58 ms, page p50 13.0 -> 12.3, p95 22.3 -> 21.5 |
| Firefox inline A/B, Island, 2 pairs | mean tick 6.90 -> 6.96 ms, slowest tenth 10.17 -> 10.55 ms: within noise |

Gecko profile of the bunker after the change (Firefox inline, 60 s): `attachDecalSurfaces` 0.16 -> 0.10 ms a drawn frame; in the
slowest tenth of ticks `fast::edge` (the table lookups) 0.18 ms, `fast::find_surface` 0.10, `Ext::add` and `Ext::rounded` of the
footprint grid 0.05 each, the JavaScript `setRotation` 0.07. The Chromium worker-mode `validate-decals-play` and
`validate-decal-vertices-play` pass.

The module's statics grew by 18 KB (`__heap_base` 1.673 to 1.691 MiB of the 2 MiB reserved); the 16,384-entry table (1.2 MB) is
allocated in the kernel instance's memory at the first level store.

## Open

- DrawFrame's order of the draw items: Play draws decals item by item in the occlusion stream's order, DrawFrame in its three lists'
  ("Draw order"); it shows only where coplanar surfaces overlap on screen, and the non-occluding list's decals are drawn with the
  occluding ones. The lists and the Key sort are the subject of DrawFrame's draw order as a whole.
- A combat decal where `2·tex·dst` clamps (a bright wall), and blood, in a frame against the original.
- Decals in sky child frames.
- The game-thread control word (above).
