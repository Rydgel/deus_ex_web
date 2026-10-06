# The moving brush tracker (FMovingBrushTracker)

Engine's moving brush tracker (`UnDynBsp.cpp`) inserts every mover's brush
polygons into the level's BSP, so the renderer draws and occludes doors and
lifts as level surfaces, mirrors and fog maps apply to them, and the level
model holds them where they were last rendered. This page records the
recovered contract and its reference; the port into Play is still to come
([BSP occlusion](bsp-occlusion.md) "4. The moving brush tracker").

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

## Open

- The port: the tracker on the Rust occlusion's node memory (pools sized as
  the tracker grows them), Update for admitted movers in Level.Actors order
  before `occ_run`, SurfIsDynamic in the render-bound test, and Play's mover
  drawing from the draw lists (closed doors occlude; coplanar chain order
  replaces the depth offset of [mirror surfaces](mirror-surfaces.md)).
- The game thread's control word at LoadMap and SaveGame.
- Collision: once NF_IsNew clears, fragments are ordinary solid nodes of
  Level->Model, and nothing in the level traces excludes them, so the
  original's level traces probably see movers where they were last
  rendered. Play's collision uses the static model; this needs a live check
  (Stage 5).
- Not reachable in the shipped content: full pools, PF_SpecialLit movers, a
  three-mover dependency that leaves the third mover's nodes unlinked.
