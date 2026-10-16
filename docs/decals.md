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
Not in a frame: bullet holes, scorch marks and blood, which need combat. Weak: two views of one gallery, and the two walkers are held, not matched.

```bash
scripts/original-views.sh 00_Training --view shadow2:211,1266,-33:62500,61567,0 --view shadow3:61,1326,-23:61166,59067,0 --view shadow2-base:211,1266,-33:62500,61567,0 --view shadow3-base:61,1326,-23:61166,59067,0 --brightness 0.666667 --cmd 'set MIB Orders Standing' --cmd 'set ScientistMale Orders Standing' --unfreeze --base-cmd 'set WinDrv.WindowsClient Decals False' --pre-shot-cmd 'set ScriptedPawn bHidden True' --pre-shot-cmd 'set LevelInfo bPlayersOnly True' --decal-state
node scripts/validate-stage4-acceptance.mjs --only '^4\.2\.15$'
```

## Open

- Bullet holes, scorch marks and blood in a frame against the original (they need combat).
- Decals in sky child frames.
- The game-thread control word (above).
