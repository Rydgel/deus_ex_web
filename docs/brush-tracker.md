# The moving brush tracker (FMovingBrushTracker)

Engine's moving brush tracker (`UnDynBsp.cpp`) inserts every mover's brush
polygons into the level's BSP, so the renderer draws and occludes doors and
lifts as level surfaces, mirrors and fog maps apply to them, and the level
model holds them where they were last rendered. This page records the
recovered contract, its reference, the Rust port and how Play uses it
([BSP occlusion](bsp-occlusion.md)).

## Authority

Engine.dll `0c3a8b18…20b4`, Core.dll and Render.dll at the hashes the native
oracles pin; the SDK 1112f headers (`UnDynBsp.h`, `UnObj.h`) for names.
Instruction-level notes (local, untracked): `.work/tracker/notes.md`.

## Lifetime

- **Object.** 0x68 bytes, vtable `0x1042c578`: destructor `0x1037b070`,
  Update `0x1037a400`, Flush `0x1037a290`, SurfIsDynamic `0x1037ac10`
  (`iSurf >= Surfs.Num` at construction), CountBytes. Level `+0xfc` holds
  it.
- **Creation.** `GNewBrushTracker` (`0x1037c860`) runs in UGameEngine::LoadMap
  (`0x1038dfb5`) after the whole actor start-up, except for the `Entry` level.
- **SaveGame** (`0x10391be0`) deletes it (restoring the model), saves, resets
  every mover's SavedPos to (−1,−1,−1) and builds a new one: every save
  rebuilds every mover's fragments.
- **Browse** (travel) and the next LoadMap delete it. Flush is editor-only.

## Construction (`0x1037ac40`)

Every actor with a Brush that IsA ABrush and is not bStatic, in Level.Actors
order, goes through AddBrush (`0x1037b5c0`): on the shipped maps these are
the 2,234 movers of 88 maps (40,316 polygons). Per polygon it adds one
FBspSurf (the brush polygon's Texture, `PolyFlags & 0x3cffffff`, a base
point, three vectors, `iLightMap = FPoly.iBrushPoly`, `iBrushPoly` its
ordinal, PanU/PanV, `Actor` = the mover) and sets `FPoly.iLink` to it.
Then the node pool grows once to `min(2N + 512, 65536)` nodes and the vertex
pool to `2V + 512` (zero-filled), and `Update(NULL)` builds every mover,
at the game thread's precision.

## Update (`0x1037a400`)

- **Callers.** URender::SetupDynamics (`0x10b230e5`) calls Update(Actor) for
  each admitted actor with a non-static Brush, in Level.Actors order, instead
  of making it a sprite; it runs before OccludeBsp, inside DrawWorld, at
  24-bit precision. Hidden movers and movers never admitted are never
  updated: the BSP shows them where they were last rendered (or loaded or
  saved).
- **Moved test.** Update returns unless SavedPos differs from Location (an
  unordered compare counts as equal) or SavedRot from Rotation.
- **Rebuild.** The moved mover's node chain (`Brush->MoverLink` →
  `iRenderBound` → …) is marked; movers whose nodes hang below it are pulled
  into the list (MarkForUpdate `0x1037c4f0`); every listed mover's nodes are
  unlinked (RemoveActorNodes `0x1037c6d0`: parent links cleared, points onto
  a LIFO free list, fields left in place); then each listed mover, newest
  first (so Update(NULL) filters in reverse Level.Actors order), is
  transformed (ABrush::BuildCoords `0x1032f9e0`, FPoly::Transform
  `0x10387360` with a vertex reversal when the orientation is negative,
  SafeNormal), a bounding sphere marks front/back nodes
  (PrecomputeSphereFilter `0x103f6460`), its surfaces' base point and
  vectors are rewritten in place, and each polygon is filtered from node 0
  with Outside set.
- **FilterPoly** (`0x1037c0c0`). SplitWithPlaneFast (`0x10386ad0`) at ±0.25;
  a polygon of 14 or more vertices is first split in half (SplitInHalf
  `0x10386f70`); a coplanar polygon facing the node's way makes it the
  coplanar parent, and the fragments that reach a leaf are linked at the end
  of that node's iPlane chain; fragments reaching solid are dropped (a door
  sliding into its wall, the +20,000 of a destroyed mover).
- **AddNode** (`0x1037bb00`). Next-fit in the node pool (a full pool drops
  the fragment silently): plane from the fragment's base and normal (W stored
  as a float), iFront/iBack/iPlane/iCollisionBound −1, iRenderBound the
  mover's chain link, ZoneMask from the link parent (and the zone bits OR'd
  into the parent), NodeFlags `0x20` (NF_IsNew, cleared at the end of
  Update) plus NotCsg for NotSolid, NotVisBlocking for Portal or Invisible
  and ShootThrough for Masked, iZone/iLeaf from the parent's side (from the
  chain end, by facing, at a coplanar leaf), and a next-fit vertex run with
  points from the free list.

Static nodes change only in one child link, ZoneMask (an OR) and the sphere
filter's front/back bits.

## Precision

Update from SetupDynamics is binary32 throughout. Construction and SaveGame's
rebuild run at the game thread's control word, which is not measured: at
`0x037f` and `0x007f` the topology is the same, but SafeNormal's 1-ulp
differences reach the vectors, node planes and W on Island, the Intro and
the Ship, and a mover that never moves keeps its load-time bits for the
whole level.

## Reference

`scripts/native-brush-tracker-oracle.py` runs the unchanged tracker and every
Core helper it calls under Unicorn on a real level model and its movers'
polygons (stubs only for allocation, log text and memmove): `construct`,
`update` (one actor or NULL), `frame` (every visible mover, as
SetupDynamics does), `flush`, `surfIsDynamic` and `destroy`, each step at
its own control word. Each step reports every added, changed and removed
node, surface, point, vector and vert as bit patterns, the tracker's own
state, each mover's chain, and the basic blocks first run. Twenty cases
(239 steps) on Training (doors closed, half open, open, re-filtered
dependents, a vertical door, 37 fragments, the +20,000 drop, a hidden
mover, flush, destruction), the Paris club and Island (rotating doors), the
Intro (a mover appended to the floor's coplanar chains) and the Ship (a
111-polygon mover scaled −1, SplitInHalf) reach every block a shipped map
can reach but one (a coplanar leaf whose chain end faces against the
fragment).

## The port

`native/script-vm/src/tracker.rs` runs the whole tracker on the occlusion
model's memory (`trk_construct`, `trk_update`, `trk_flush`,
`trk_surf_is_dynamic`, `trk_destroy`; the header layout is at the top of
the file):

- Core's FCoords `*=`/`/=` by FScale (the shear slots X.y, X.z, Y.x, Y.z,
  Z.x and Z.y; `/=` negates the snapped rate, so a zero rate is −0) and by
  FRotator, and the `*=FCoords` compose of TransformPointBy and
  TransformVectorBy.
- BuildCoords: the transpose and `sgn(MainScale) × PostScale.Orientation()`.
- FPoly::Transform: TextureU/V by VectorXform; the base and vertices as
  `((V − PrePivot) stored) by PointXform stored + Location stored`; the
  reversal when Orientation < 0.
- SafeNormal, FBox and FSphere, and PrecomputeSphereFilter.
- SplitWithPlaneFast, SplitInHalf, FilterPoly and AddNode, with next-fit
  node and vertex pools.
- AllocPoint: FArray growth of `Num + 3·Num/8 + 32`.
- Destruction, with FArray::Remove's shrink rule (Core `0x101454f0`).

The arithmetic is generic over the precision:

- `Ext` is the x87 64-bit model, for construction at the assumed game-thread
  word.
- `P24` is binary32 with exactly one rounding per operation, also with
  double constants. Its square root is the 64-bit root rounded once. That
  root never lies within 2⁻⁶⁴ of a 24-bit tie unless it is exact.

`src/runtime/brush-tracker.mjs` is the host:

- `trackerCapacities` gives the sizes the tracker can grow the model to:
  nodes `min(2N + 512, 65536)`, verts `2V + 512`, the points, vectors and
  surfaces per polygon, NodeMaps, VertOwners and PointHelper.
- `createTrackerHost` writes the header, the 40-word mover records and the
  68-word FPoly records, and reads the model back. It provides `surfOwner`
  (a tracker surface's mover and polygon) and `chain` (a mover's fragment
  nodes).
- `collectTrackerMovers`, `trackerTextureFlags` and `trackerMoverSpec` build
  the constructor's movers from a map.

`bsp-occlusion.mjs` sizes its blocks for the tracker when it is given
movers. The header counts follow the tracker's arrays, and `dispose`
deletes the tracker before freeing the model, as the original does on
travel and LoadMap.

OccludeBsp skips a node's bound test when `Level+0xfc` holds a tracker
whose vslot 3 (SurfIsDynamic) reports the node's surface dynamic
(`0x10b17ae5..0x10b17b00`). The bound test would otherwise read the
fragment's iRenderBound, which holds the mover's chain link and is not a
bound. `occlude.rs` makes the same test through `tracker::surf_is_dynamic`:
`iSurf ≥ iOriginalSurfs` while the tracker lives, which is Engine's body
at `0x1037ac10` (`+0x20`).

## The scratch arena (2026-11-06)

FilterPoly's fragments and Update's polygon copies come from Engine's `GMem` (an FMemStack mark and release around each mover's
rebuild). The port's arena is `SCRATCH_TOP` in `tracker.rs`, a bump pointer over the 8 MiB block the host allocates
(`createTrackerHost` `scratch`, header word `SCRATCH`). The pointer was never set to that block: it kept its static initial 0, so the
arena was the bottom of the module's memory, below the statics (the shadow stack's region). Of the 88 maps scanned (84 have movers) only
`06_HongKong_Storage` ran the arena up into the statics; the oracle cases never did. Its construction rebuilds `BreakableGlass0`, whose ten
polygons fragment many times in that map's BSP, and the allocations ran on past the stack and over the module's statics.

What it left (found 2026-11-06 from the slow-spot census, where a player placed at (535, 0, -103) or (-7, 555, -103) in the Storage
stopped Play with `Nonfinite FastLineCheck plane distance is unsupported` in Firefox inline and in Chromium's worker alike; a headless
Node run has no tracker, so it never showed):

* 2,138 entries of the rotation sine table (`SINE`, found at 0x1497d8 in the kernel's memory; the first changed entry is 86)
  overwritten with polygon data (-192.0, 399.99, -3840.0, 1.0 ...). A rotated mover built after it gets a wrong matrix: with the mover's own placement
  (yaw 3072, PrePivot (-10.87, 11.44, 13.92), identity scales) polygon 0 vertex 0 came out at (-10667.7, -434.4, 1153.9) where the
  original's FPoly::Transform returns (80.76, -642.69, 1153.85); with a unit vertex and no pivot the rows of the matrix were (0.957,
  -3840, 0) and (3840, 0.957, 0) at yaw 3072, (-3840, 0.383, 0) at 4096 and (-126, 1, 0) at 16384, while yaw 0, 1024, 2048, 3000 and 8192 were
  right.
* Three fragment nodes (10829, 10830, 10836, all `iSurf` 4847, zone 7) whose plane words were 0xFFFFFFFF, garbage and 0xFFFFFFFF
  (NaN, NaN), reached by the line checks of the pawns and Galaxy that cross the pane. `fastLineCheck` refuses a non-finite plane
  distance; it was the only place that noticed.

**Evidence.** The case `storage-nonfinite-fragments` (one full `construct` step at control word 0x037f over `06_HongKong_Storage`'s 47
movers) was added to `scripts/brush-tracker-cases.json`. Before the fix `validate-brush-tracker` failed on it in the first FPoly::Transform
check, `BreakableGlass0 polygon 0 vertex 0`, port (3324423868, 3285790324, 1150303052) against the original's (1117881703, 3290475628,
1150303052). So the original builds no NaN planes there: it is the port. After the fix the whole file is equal: 21 cases, 240 steps (59 full
reports, 181 digests), the 16,575 FPoly::Transform outputs and the mutation check, and `scripts/validate-brush-tracker-scratch.mjs` finds no
corruption in any of the 84 maps with movers (before: only the Storage; 2,138 table entries, 3 nodes).

**Fix.** `trk_construct` sets `SCRATCH_TOP` to `h(H_SCRATCH)` (`scratch_reset`), and every rebuild's mark and release keep it there. The
8 MiB is enough for the Storage (the OOM path, `H_STATUS` 2, did not trigger). No other map's tracker bits change: the arena only moved,
and the polygons it holds are written before they are read (`new_poly` does not zero them, as the original's GMem does not).

## Verification

**The tracker.** `scripts/validate-brush-tracker.mjs` runs all 20 cases of
`scripts/brush-tracker-cases.json` step by step through the oracle and the
port, and rebuilds the oracle's report from Rust memory.

- All 239 steps are equal: 58 full reports field for field and 181 brief
  steps by SHA-256 digest.
- The oracle reached 477 tracker blocks.
- A mutation check flips the lowest bit of one rotating mover's Location in
  one step, and the report differs.

The oracle takes about 50 s and the port about 10 s.

**OccludeBsp over the tracker's model.** `validate-bsp-occlusion.mjs` now
also builds the tracker for four maps and then gives the oracle the result:

- The construction runs at PC64, then the moved movers' Update at PC24.
- The oracle gets every node, vert, point and surface of the resulting
  model. Its `Level+0xfc` holds a tracker object whose vslot 3 is Engine's
  own SurfIsDynamic.
- One camera per mover stands at a spot 150 to 700 units away, aimed at it,
  and random cameras are added. Every draw list, saved polygon, NodeFlags
  byte, Frame->Sprite entry and child request matches bit for bit:

| Map | Fragment nodes | Frames | Mover polygons drawn | Child requests |
| --- | --- | --- | --- | --- |
| 00_Training, doors closed | 150 | 41 | 57 | 128 |
| 00_Training, first double door raised 96 units | 148 | 33 | 54 | 165 |
| 10_Paris_Club, mirror movers DeusExMover8 and DeusExMover11 turned | 330 | 25 | 129 | 8 |
| 01_NYC_UNATCOIsland | 306 | 30 | 79 | 10 |

**Who stamps a mover.** In Render.dll, the only store to
`AActor::LastRenderTime` (`+0x34`) from `TimeSeconds` (`+0x478`) is
DrawActorSprite's (`0x10b25161`). Engine, DeusEx and Extension have none.
SetupDynamics sends a non-static brush to the tracker and never makes it a
sprite (`0x10b22f29` → `0x10b230d5`). A tracked mover's LastRenderTime
therefore keeps the start-up value of −10 (`0x1038da26`).

## Play

**Construction and lifetime.** `sim-host.mjs` collects the map's movers,
with each polygon's texture PolyFlags, in Level.Actors order.

- Each spec takes the running actor's bHidden, Location, Rotation and
  PrePivot, and the merged defaults' MainScale, PostScale and bSpecialLit.
- The model is uploaded with the tracker, and the constructor's
  Update(NULL) runs at PC64. That control word is an assumption (see
  [Precision](#precision)).
- Player start's reset is a LoadMap. It disposes of the tracker and model
  and builds both again from the reset level, as the original deletes the
  tracker and creates it after the actor start-up (`0x1038dfb5`).

Moving the doors and then choosing Player start brings back the original
fragments.

**Update each frame.** `sim-session.mjs` `updateMovers` runs before the main
frame's OccludeBsp, in Level.Actors order. It updates every mover that the
level-actor pass routes to the tracker (`render-visibility.mjs`
`dynamicActorRoute`, `0x10b22e1f..0x10b22f2d`), with the Location bits and
Rotation the frame renders, at PC24. The pass skips:

- a hidden mover;
- the first-person view target;
- DrawWorld's excluded actor;
- the owner-see rules.

A mover that is no longer in Level.Actors is not updated either. A skipped
mover stays where it was last rendered.

Only the main frame runs Update. A mirror's child frame would find every
mover where the main frame left it, because no tick runs in between.
HighDetailActors is taken as set, as the sprite scan does.

**Drawing.** The frame's `visibility.movers` lists, for each mover, the
polygon ordinals the draw lists hold. Each mover triangle carries its
polygon in `userData.faces`, since the mover mesh's surfaces are its
polygons (`moverModelFromPolys`).

- `world-visibility.mjs` draws a mover's meshes in the main pass through an
  index of those polygons' triangles, and hides a mesh with none.
- A polygon with any fragment drawn draws whole; the depth test hides the
  rest.
- The mirror and sky passes still draw movers whole, because child frames'
  occlusion is not ported.
- A mover mesh's vertices are the tracker's: `moverPoints` (brush-tracker.mjs) is
  a host copy of what `FPoly::Transform` left in each rebuilt polygon (the
  original keeps those in Update's FMemStack), sent to the page with each
  rebuild and projected by the frame's vertex chain
  ([frame projection](frame-projection.md), "Movers"). The oracle hooks
  Transform's return, and `validate-brush-tracker` checks the copy against 15,333
  polygon outputs.

**Stamping.** Tracked movers are no longer stamped from the frustum-tested
drawn set, and `verifyStamps` leaves the movers kind out.

**Mirrors.** A mirror request on a tracker surface names its mover and
polygon. The node's iSurf leads to `surfOwner`, because a child request
names its node. With the tracker the requests also carry
`TRACKED_MOVER_MIRRORS`, so `mirror-passes.mjs` `requestedGroup` gives a
moving mirror group its child frame only when OccludeBsp asked for it, as
it already did for static groups.

**Decals and fog (2026-10-07).** AttachDecal traces the level model as the
tracker holds it, so decals attach to movers through the Mover branch. Each
Update bumps a generation word (header 51), and the decal model then
follows the tracker's arrays ([decals](decals.md), "Movers"). Each mover
draw item in a bFogZone zone gets its own fog map over its tracker
surface's lattice (`surfaceFacet`), drawn over that item's fragments
(`nodePolygon`; [volumetric fog](volumetric-fog.md), "Play").

**Light maps (2026-10-28).** SetupForSurf's static cache header (Region.iLeaf,
Location, Rotation) is compared for every brush-tracker surface it draws; on a
miss, the light map is built again on the facet DrawFrame takes from the
tracker. `world.relightMovers` does this for each mover draw item of every
pass, on `surfaceFacet`
([static lighting](static-lighting.md#mover-surfaces-in-setupforsurf-2026-10-17), "Every mover").

**Line checks (2026-10-16).** Every `UModel::FastLineCheck` of the game reads `XLevel->Model`, so the fragments block
those lines as they block the renderer's: CheckHearSound's sound obstruction, MakeNoise, FastTrace, the pawn natives and
Galaxy's occlusion in Update. sim-host.mjs gives the level's model `trackedLineNodes()` while the tracker lives (the node
block as `bsp-occlusion.mjs` `lineNodes` reads it in place), and `fast-line-check.mjs` traverses it
([FastLineCheck](fast-line-check.md) "Over the tracked model"; checked against Engine.dll by
`validate-fast-line-check-tracked.mjs`). A destroyed mover's fragments stay where they were until its next rendered
Update: the Underworld's broken BreakableGlass0 still blocks the line to its own fragments' sound in the same frame, as
in the original (row 4.3.6's capture `sndm`).

**Collision (2026-10-20).** ULevel::MultiLineCheck's world check is Level->Model's LineCheck (vtable slot 22) with the
trace's extent, and ULevel::MultiPointCheck's is its PointCheck (slot 21), so MoveActor, SingleLineCheck, Trace and
TraceTexture, the AI's and the decals' line checks, FindSpot (SpawnActor, FarMoveActor) and the walking surface scans all
meet the movers' fragments where the movers were last rendered. sim-host.mjs gives the level model `trackedCollision()`
while the tracker lives, which returns bsp-occlusion.mjs `collisionModel()`: one object for the tracker's life whose
`nodes` read the node block in place (lineModel's fields plus iCollisionBound and iSurf, fresh objects per tracker
generation), with the static LeafHulls (AddNode gives a fragment iCollisionBound −1, so no hull is added) and `surfaces`
that continue the level's with each tracker FBspSurf's PolyFlags. level-queries.mjs `worldModel()` returns it, or the
static BSP before construction and without a tracker, for the JavaScript world checks (`worldLineCheck`, level-points.mjs
`multiPointCheck`) and the kernel's (collision-kernel.mjs `createKernelLineChecks`). The Rust trace kernel keeps one range
per tracked model at the tracker's node capacity: when the tracker's generation (header 51, bumped by an Update that rebuilt
a mover) or node count changed since the last import, trace-kernel.mjs copies the node block raw from the occlusion
kernel's memory and trace.rs `trace_import_bsp` converts it in place to the trace layout, with traceModelLayout's rules. A
world hit's Item is a node of that model: WalkTexture (script-pawn-physics.mjs `textureForHit`), the kernel's walking
scan table (rebuilt per generation from the iSurf words) and TraceTexture resolve it there, and the tracker's surfaces
take their mover polygons' texture records (sim-host.mjs `surfaceTexture`, as walkingSurfaceTextures makes the level's).
`?trackedCollision=off` (Node: `TRACKED_COLLISION=off`) keeps the collision queries on the static BSP, for comparisons.

Evidence: `validate-tracked-collision.mjs` runs Engine's unchanged UModel::LineCheck (box branch included, with the
model's LeafHulls) and UModel::PointCheck under Unicorn on the tracker oracle's level model at the game thread's 0x037f,
on the static BSP, after GNewBrushTracker and after a frame that moves every mover half way to KeyPos[1] (Update at 24
bits), against ray.mjs traceRayFast, extent-trace.mjs traceExtentJs and point-check.mjs modelPointCheck over lineModel():
Island 1,140 lines and 3,420 points per state, Training 1,500 and 4,500, all bit-exact (Time, Location, Normal, Item)
but one static PointCheck recovery tie that predates the tracker ([point check](point-check.md), "Recovery tie between a
hull plane and its bevel"). The fragments change 27 and 35 of Island's lines and 145 and 218 of its points (113, 103,
205, 184 on Training). The same run checks the Rust kernel over `collisionModel()` against the JavaScript bodies (2,280
and 3,000 answers, one import per generation).

**Switch.** `?moverTracker=off` (Node: `MOVER_TRACKER=off`) keeps the
earlier behaviour: movers stay out of the BSP, draw whole and are stamped
from the frustum set.

**Probe.** `deusExViewer.moverProbe(args)` (`mover-probe.mjs`, a worker call)
reports, for validation:

- each tracked mover's fragment count and drawn polygons;
- the drawn node count, the mover mirror requests, the host timings and the
  number of admitted movers;
- with `renderTimes`, every actor's LastRenderTime.

It can also place movers through the collision model (`set`).

**Checks, worker mode, against `?moverTracker=off`** (Linux host,
1280×720). The pixels are the same in every view:

- Training's start, 30 frames still and 150 walking.
- Training with the first double door (DeusExMover16/17) raised 96 units.
- Island's start, still and walking.
- Island facing the UNATCO HQ doors (DeusExMover6, 12, 22 and 23 drawn).
- The Paris Club start, still and walking, and facing the mirror mover
  DeusExMover8 (10 of its 32 polygons drawn).

What the closed doors hide:

| View | Drawn nodes with the tracker | Drawn nodes with `?moverTracker=off` |
| --- | --- | --- |
| Training's start (double door closed) | 145 to 150 | 169 |
| Training's start, double door raised 96 units | 160 to 165 | 169 |
| Training, after walking 150 frames | 35 | 76 |
| Island, facing the UNATCO HQ doors | 24 | 149 |

The tracker counts include the movers' own fragments.

The state digests differ from `?moverTracker=off`. At frame 60 of
Training's walk, the only difference in any actor's LastRenderTime is the
25 tracked movers, which keep −10 instead of being stamped. That is the
original's rule (above).

`validate-sim-split.mjs`, comparing the page with itself over 240 frames of
walking, passes most of the time, with the same pixels:

| Map | Tracker | `?moverTracker=off` |
| --- | --- | --- |
| Island | 4 of 6 runs | 2 of 3 runs |
| Training | 3 of 5 runs | 2 of 4 runs |

A failing run differs at one checkpoint (frame 180 or 240), either between
two loads of the same page or against the third. The switch-off build fails
the same way, so the divergence predates the tracker
([BSP occlusion](bsp-occlusion.md#play) reports it for the previous
commits too).

`validate-mirrors-play` passes, including the translucent mover mirror on
02_NYC_Smug's DeusExMover7, which is now requested through its polygon 6.
`validate-decals-play`, `validate-gpu-mesh`, `validate-sprite-setup` and
`npm test` (598) pass too.

## Cost

Measured on the Linux host while other agents were running (load average
about 8), so whole-frame times are noisy.

**The tracker alone** (Node, Wasm):

| Map | Movers | Polygons | Construction | Frame with movers standing (every Update's moved test) | One moving mover's Update, median |
| --- | --- | --- | --- | --- | --- |
| 00_Training | 25 | 150 | 5.1 ms | 1–2 µs | 18 µs (a door; worst 0.55 ms) |
| 01_NYC_UNATCOIsland | 19 | 197 | 2.5 ms | 1–2 µs | 8 µs (a door) |
| 10_Paris_Club | 13 | 241 | 1.8 ms | 1–2 µs | 68 µs (the 32-polygon mirror mover turning) |

**Host work per Play frame** at Island's start, in worker mode: 120
samples of `visibility().ms` (reported by `moverProbe`) in each of two
rounds. The worker's clock has 0.1 ms resolution, so these are means.

- `updateMovers`, with 19 admission routes, the field reads and the Updates,
  takes 0.09 to 0.11 ms.
- OccludeBsp with its decode takes 1.9 ms with the tracker, against 1.8 and
  2.5 ms without it.

**Whole frame.** `profile-play-browser.mjs --no-profile --angle gl` at
Island's start, worker mode, 1920×1080 and 600 frames, three interleaved
rounds of each mode. The values are medians, and the simulation frame is
the worker's steps per snapshot.

| Island start | `?moverTracker=off` | Tracker |
| --- | --- | --- |
| Standing: simulation frame | 22.2 ms (actors 5.5) | 22.9 ms (actors 5.8) |
| Standing: main draw calls | 84.8 | 56.6 |
| Walking: simulation frame | 24.1 ms (tick 12.6, actors 5.1) | 26.6 ms (tick 14.1, actors 5.6) |
| Walking: main draw calls | 63.7 | 38.0 |

The tracker's work runs inside the actors step, about 0.1 ms of host work
plus microseconds of Wasm. The rounds spread wider than the differences
between modes: standing ran 20.0 to 23.1 ms without the tracker and 20.0 to
24.5 ms with it. The walking tick does not run tracker code. The main pass
submits fewer draw calls, because a mover mesh with no polygon in the draw
lists is not drawn.

## Open

- **Precision.** The game thread's control word at LoadMap and SaveGame is
  not measured. Construction assumes PC64.
- **Collision.** Done 2026-10-20 ([above](#play), "Collision"). Not
  measured: whether a script trace run from RenderOverlays (inside the render
  pass's PC24) rounds differently; the evidence is at 0x037f.
- **SaveGame** (Stage 6). SaveGame deletes the tracker, saves, resets every
  mover's SavedPos to (−1, −1, −1) and builds a new tracker. Play has no
  SaveGame yet; `buildOcclusion` in `sim-host.mjs` is the rebuild to call.
  Travel uses the same rebuild once maps travel (Stage 6).
- **Child frames.** Mirror and sky passes draw movers whole until child
  frames have their own occlusion.
- **Whole polygons.** A polygon split into fragments draws whole, and the
  mover depth offset of [mirror surfaces](mirror-surfaces.md) stays. The
  coplanar chain order of partly drawn polygons is not reproduced.
- **Script state.** SavedPos, SavedRot and bAssimilated live in the
  tracker's mover records and are not written back to the script actor.
- **Runtime movers.** Only the map's movers are tracked. A mover spawned at
  run time is not added.
- **Unreachable content.** Full pools, PF_SpecialLit movers and a
  three-mover dependency that leaves the third mover's nodes unlinked do not
  occur in the shipped maps.
