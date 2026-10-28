# Static lights on BSP light maps

Stage 4, 2026-10-02. The static light maps in Play are still the Stage 1.5
float reconstruction (`src/unreal/lighting.mjs`, [lighting](lighting.md)).
It approximates the shadow blur, falloff and colour in floats. It also
refuses every light whose LightEffect it does not model, and the whole
surface then fails to draw. A census of the 83 single-player maps finds such
lights on BSP surfaces in 34 maps: LE_Cylinder (421 lights, mostly the NYC
streets), LE_TorchWaver (76), LE_FireWaver (14), LE_Rotor and LE_Searchlight
(8 each), LE_Disco and LE_SlowWave (5 each) and LE_FastWave (1). This note
records the original Render.dll path for static lights, which the moving
lights ([dynamic lighting](dynamic-lighting.md)) already partly use, as it
is recovered and moved into Play.

Authority: Render.dll `607f1077…d75d1` (preferred base `0x10b00000`).

## The static light map (SetupForSurf)

FLightManager::SetupForSurf (`0x10b06c90`) lists a surface's lights through
AddLight (`0x10b08b30`), whose class decides when a light is computed:

| Class | Lights | Computed |
| --- | --- | --- |
| 0 | `bStatic`, `LT_Steady`, an effect row with neither dynamic flag; any `bStatic`/`bNoDelete` light when `UClient::NoDynamicLights` | once, into the cached static map |
| 1 | other `bStatic`/`bNoDelete` lights | every frame, onto a copy of the static map |
| 2 | the rest (moving lights) | every frame, unshadowed |
| 3 | LE_OmniBumpMap | not on the light map |

The effect table at `0x10b2a0f0` has 12-byte rows {spatial function,
IsSpatialDynamic, IsMergeDynamic}:

| Effects | Spatial function | Spatial dynamic | Merge dynamic |
| --- | --- | --- | --- |
| None, Warp, OmniBumpMap, Unused | normal `0x10b03360` | | |
| TorchWaver, FireWaver, WateryShimmer | normal `0x10b03360` | | yes |
| StaticSpot, Spotlight | spot `0x10b04f80` | | |
| NonIncidence | `0x10b054e0` | | |
| Cylinder | `0x10b04a80` | | |
| Shell | `0x10b05740` | | |
| Searchlight, SlowWave, FastWave, CloudCast, Shock, Disco, Interference, Rotor | `0x10b03770`, `0x10b03de0`, `0x10b040b0`, `0x10b04380`, `0x10b043a0`, `0x10b046f0`, `0x10b04c80`, `0x10b03ae0` | yes | |

On a cache miss, SetupForSurf builds the static map like this:

1. Fill every texel with the zone's ambient: FGetHSV of AmbientHue,
   AmbientSaturation and AmbientBrightness (zone `+0x38d`, `+0x38e`,
   `+0x38c`), scaled and converted to BGRA bytes with alpha `0x7f`.
2. For each class-0 light, run ComputeFromActor (`0x10b05fa0`). Then build
   the illumination bytes from the light's shadow bits (`0x10b02650`), run
   the effect's spatial function into a byte per texel, and merge
   (`0x10b03040`): add the light's colour-table entry for that byte, each
   channel saturating at 127.

The merge is a saturating add of non-negative bytes, so the lights' order
does not change the result.

## Illumination (`0x10b02650`)

The light-manager init (`0x10b02112`) builds a local 8×8 weight matrix whose
rows are `[0,24,40,24]`, `[0,40,64,40]` and `[0,24,40,24]` (total 320). From
it, `0x10b02352` builds a 128-entry table at `0x10b3cae0`. For each 7-bit run
of shadow bits and each matrix row, an entry holds four packed bytes:
`trunc(Σ weights of set bits · 255 / 320)`, with byte b reading bits
`b+1..b+3`.

The illumination function reads one shadow byte (8 texels) at a time
through a sliding window. The first texel is repeated twice to the left and
the row's last bit twice to the right; that bit is a padding bit when the
width is not a multiple of 8. Each shadow row scatters its three weight
rows into the rows above, at and below it. The first and last rows take
their own outer contribution, and a single-row map's lower contribution
falls past the map. Rows are padded to whole bytes, a stride of
`ceil(width/8)·8`. A fully lit texel is `70+114+70 = 254`. With no shadow
bits the buffer is `0x7f`, exactly half of that, which is what moving
lights get.

`shadowTable` and `shadowIllumination` (`src/runtime/static-lighting.mjs`)
translate it. `scripts/validate-static-lighting.mjs` runs the original
(`native-dynamic-light-oracle.py`, with appMemset as `rep stosb`) and
compares the table and every shadow mask. Training's 15,754 masks
(8,892,842 texels) and every third light map on UNATCO Island (5,070
masks) match, as do eight fabricated widths and heights and the no-shadow
fill.

## Ambient, spot and cylinder

**Ambient** (`0x10b07fcc`-`0x10b080cf`). Each channel of the zone's FGetHSV
becomes `clamp(FISTP(float(float(c·0.25)·256) − 0.5), 0, 255)`; the
products are exact powers of two. The texel is BGRA with alpha `0x7f`
(`ambientTexel`).

**Spot** (`0x10b04f80`, LE_StaticSpot and LE_Spotlight).
- *Direction.* The X axis of `GMath.UnitCoords / Rotation`, using
  ViewRotation for a Pawn. That is Core's operator `0x1011b690`, which
  `fcoordsAxes` already translates.
- *Cone.* `c = 1 − LightCone/256`, with `1/(1−c)`, `c/(1−c)` and `c²` stored
  as floats.
- *Per texel with illumination.* The falloff index is
  `FISTP(float(d²)·rr2)`, zero at 4096 or more. The byte is zero unless the
  axis dot is positive and `dot² > d²·c²`. Otherwise
  `s = rsqrt(d²)·dot/(1−c) − c/(1−c)` and the byte is the low byte of
  `FISTP(float(s²·normal[index]·illumination·incidence) − 0.5)`.
- *rsqrt.* It reads the light manager's x^-0.5 tables (init `0x10b022d0`,
  builder `0x10b024b0`: `float(appPow(|x|, −0.5))` over 512 exponent and
  1024 mantissa patterns). appPow is the CRT's x87 pow, taken as the JS
  double. The nearest float rounding midpoint is 6.4·10⁻¹¹ (relative) away,
  so no table entry depends on that choice.
- *Code.* `spotLightSpatial` keeps the displacement and sum arithmetic in
  doubles at the recovered float stores, and runs the `s` chain on the x87
  model.

**Cylinder** (`0x10b04a80`, LE_Cylinder). The byte is
`max(0, FISTP(float((1 − (dx²+dy²)/R²)·illumination) − 0.5))`, using
horizontal distance only and no cut beyond the texel rectangle
(`cylinderSpatial`).

## Static light validation

`validate-static-lighting.mjs` phase 2 runs the zone ambients and 64
fabricated triples. On every `--surfaces`-th world surface, it then chains
each class 0 and 1 light, starting from an ambient fill, through the
original rectangle, incidence, colour table, illumination, spatial body and
merge. The oracle runs the original spot and cylinder bodies with Core's
operator, using GMath filled with `coords.mjs`'s sine table and IsA stubbed
to "not a Pawn"; appPow is Python's double pow.

| Map | Light steps | Of which | Texels | Mismatches |
| --- | ---: | --- | ---: | ---: |
| 00_Training, every surface | 15,745 | 7,737 spot | 8,891,470 | 0 |
| 01_NYC_UNATCOIsland, every 4th surface | 3,425 | | 7,753,474 | 0 |
| 04_NYC_Street, every 3rd surface | 4,538 | 332 spot, 483 cylinder | 4,210,782 | 0 |

The rsqrt tables match bit for bit. Like the moving-light bodies, the
per-texel arithmetic outside the x87-model chains is a measured match, not
a proof for all inputs.

## Play

`createLighting` (`src/unreal/lighting.mjs`) now fills every BSP and brush
light map through `staticLightMap` (`src/runtime/static-lighting.mjs`):
- the zone's ambient bytes;
- then each listed light in list order, with its own shadow mask (selected
  by list index);
- the original rectangle, incidence, illumination, spatial body and colour
  merge;
- texel bytes divided by 255 for the atlas.

The surface's facet and texel grid are those SetupForSurf sees: a level
surface keeps its serialized float vectors, and a brush surface takes its
mover transform, as the moving lights do. Moving lights still add onto a
copy of these texels.

What changed in the browser:
- **Missing surfaces drawn.** Surfaces lit by LE_Cylinder, LE_TorchWaver or
  LE_FireWaver lights are no longer refused. On Battery Park, NYC Street,
  Wan Chai Market and Area 51 Bunker, every "Unsupported light effect"
  surface now draws; the remaining errors there are the older mover
  correspondence ones.
- **Closer to the original game.** Training's entrance view (the saved
  `reports/lighting` camera, 926×603, brightness 0.40) moved closer in all
  six regions of the original-game comparison. The worst region went from
  2.78 to 1.26 mean RGB levels: ceiling 1.90 → 0.85, beam 0.97 → 0.68,
  pillar 0.83 → 0.70, door 2.03 → 0.98, warm wall 2.78 → 0.61, cyan strip
  2.47 → 1.26. The old numbers were measured on the Mac and the new ones
  headless on Linux. HUD, meshes and the mirror floor stay excluded, and
  this remains a regional comparison.

Diagnostics, still open:
- Time-varying effects and Shell need the Rust core (spatial.rs; see
  "Spatially dynamic effects"); without it their lights stay out of the
  light map, with a note naming the effect.
- Class 1 lights are steady snapshots (LightType variation and the
  torch/fire/watery merge modulation are not active), with notes.
- A class 2 light in a static list is skipped, with a note; none has been
  seen.

## Mover surfaces in SetupForSurf (2026-10-17)

Read from Render.dll's listing while chasing the Ship locker doors
([visual acceptance](visual-acceptance.md#on-the-mac-and-windows-with-a-mirror-sky-or-fog-2026-10-17-rows-4228-and-4229)).

**The facet.** DrawFrame fills the facet's MapCoords from the surface as
stored (`0x10b1a977..0x10b1aa38`): origin `Points[Surf.pBase]` (FBspSurf
+0x8), X `Vectors[vTextureU]` (+0x10), Y `Vectors[vTextureV]` (+0x14), Z
`Vectors[vNormal]` (+0xc). There is no pan and no mover branch. For a
brush-tracker surface those are the tracker's world-space values. It calls
the light manager's SetupForSurf (`0x10b1aa99`) before turning the facet into
view space.

**The light map.** SetupForSurf (`0x10b06c90`) proceeds as follows:

- **Model.** It asks the level's brush tracker (Level +0xfc, vtable +0xc)
  whether the surface is dynamic. For one that is, it takes `Surf.Actor`
  (+0x24) and that actor's Brush (+0x178) as the model, and otherwise the
  level's (`0x10b06e29..0x10b06e66`).
- **Index.** The light-map index is the level surface's iLightMap, which
  the tracker set to the polygon's iBrushPoly. It indexes that model's
  LightMap array (stride 40).
- **Light-map record.** The light map's FTextureInfo (`0x10b49e20`) takes
  the index's Pan, UScale, VScale, UClamp and VClamp unchanged
  (`0x10b07c96..0x10b07ce2`).
- **Grid.** ComputeFromActor (`0x10b05fa0`) builds the grid once per surface
  (the flag at `0x10b3cad0`). It runs `FCoords::Inverse` on the facet
  (`0x10b06175`) and takes the inverse's columns X″ and Y″. Then:
  base = Origin + Pan.X·X″ + Pan.Y·Y″ (`0x10b38a90`), U step = UScale·X″
  (`0x10b49e10`), V step = VScale·Y″ (`0x10b3d378`).
- **Play.** `lightmapBasis` is the same formula. Play builds it on the
  brush's own polygon basis and moves it by the brush's matrix, which a
  rigid transform makes equal.
- **Static lights** (`0x10b070a5`). They come from the model's Lights list
  starting at the index's iLightActors, with the shadow mask
  `Model.LightBits + DataOffset` advanced by `ceil(UClamp/8)·VClamp` per
  entry. This is Play's path.
- **`bDynamicLightMover`** (Mover +0x38c bit 0x10; by the SDK's AMover
  layout, KeyNum at +0x377 places the bitfield at +0x38c). For a dynamic
  surface whose actor sets it and has a leaf (Region.iLeaf +0xcc ≠ −1), the
  lights instead come from the **level's** leaf
  (`Leaves[iLeaf].iPermeating` into `Model.Lights`, `0x10b06f0b..0x10b06fd8`).
  - A light passes only if it is in front of the facet:
    `(L − Origin)·Z` against the constant at `0x10b2a5f0`, which is the
    double 0.0. The sum is `(y·Zy + z·Zz) + x·Zx` of the three differences,
    at the render pass's 24-bit precision; FCOMP with `test ah, 0x41`
    rejects "less" and "equal", so only a sum above zero passes
    (`0x10b06f7c..0x10b06fb2`).
  - Its `+0x1ec` bit 0 (bSpecialLit) must equal the actor's.
  - It goes to AddLight with Actor NULL (`push 0`, `0x10b06fc8`), so AddLight
    classes it as it classes a static-list light. No shadow mask is set: the
    static path writes the mask pointer after AddLight (`0x10b070f1`), and this
    branch does not. Its illumination is therefore `0x7f` everywhere.
  - The leaf's dynamic lights follow (`Draw->SurfLights`, `0x10b06fd8..`), but
    go to AddLight with Actor set to the mover (`push esi`, `0x10b06ffb`).
    With a non-null Actor, AddLight (`0x10b08b72`) makes any light class 2.
  - With Region.iLeaf −1, or a level with no leaves (`0x10b06f0b..0x10b06f2b`),
    the branch jumps past every light, dynamic ones included.
- **The cache header** (every brush-tracker surface, not only
  bDynamicLightMover). The static map's cache ID is
  `(Actor index << 32) + (iLightMap << 16 | zone << 8 | 0x18)`
  (`0x10b07d27..0x10b07d66`; Actor is null for a level surface). The item
  starts with the actor's Region.iLeaf, Location and Rotation
  (`0x10b07f4a..0x10b07f86`). On a hit, the item is reused only when all
  seven words match (`0x10b07e39..0x10b07ebe`: Location by FCOMP equality,
  the leaf and Rotation by CMP). Otherwise, and when AddLight saw a light
  with `+0x28` bit 0x400 (bLightChanged, `0x10b08c3c`), the map is built
  again from the actor's current place.

  93 of the 2,075 movers on the single-player maps set it, among them
  Training Combat's BreakableGlass0..3, Island's DeusExMover1 and Battery
  Park's DeusExMover0, 8, 39 and 40.

**Play (2026-10-28).** Play lights a bDynamicLightMover through this branch
(`relightMover` in `src/unreal/lighting.mjs`). The bug that found it:
00_TrainingCombat's shooting-range targets were invisible in Play, in both
Firefox (inline) and Chromium (worker); only their holders drew, pure black.
Each target is a BreakableGlass. Its paper is one PF_Translucent|PF_TwoSided
polygon (Uob_Target_F) whose blend adds `texture × light`. It hangs from a
DeusExMover holder, and all eight range movers set bDynamicLightMover. Their
brushes were built at y −3280, inside solid space (leaf −1). So every brush
light map lists no light (`iLightActors` −1, no shadow bits), and its texels
are the zone ambient: 0 here, since every zone is the LevelInfo's. Play lit
movers from those lists alone and never rebuilt them. The black paper
therefore added nothing to the frame.

The original lights the paper from leaf 1715 at the firing position (y −1216).
That leaf has 17 permeating lights, among them Light55 at (40, −1201, −88).

- **Leaf.** The simulation sends the mover's Region.iLeaf with its state
  (`sim-session.mjs` movers, only for a mover that sets the flag). SetActorZone
  sets that leaf after every MoveActor commit
  ([mover move](mover-move.md)). No script writes bDynamicLightMover:
  Mover.uc only declares it. So the flag is read once, from the actor's
  values.
- **Rebuild.** A light map whose header differs from the mover's leaf,
  Location and Rotation is built again (`world.relightMovers`, below "Every
  mover"). The light list is the leaf's permeating lights that pass the facet
  test and the bSpecialLit test. They are merged with `staticLightMap` with
  no shadow bits, so the illumination is `0x7f`.
- **Before the first frame.** The world build starts each such mover at the
  leaf of `PointRegion(Location)`, which is what SetActorZone gives it at
  begin play. Inspect, which has no simulation, keeps that.

Evidence:
- `validate-dynamic-light-mover` checks BreakableGlass0 and DeusExMover4 on
  the map data:
  - at leaf −1, ambient only;
  - slid in by KeyPos[1], leaf 1715, and each light map lists exactly the
    in-front lights with the same bSpecialLit (10 on the paper, 1 to 16 on
    the holder's polygons), unshadowed and lit;
  - an unchanged header builds nothing again, and a moved Location does.
- The original under Wine on the Linux host: `open 00_TrainingCombat`,
  `ghost`, `causeevent guntarget1` and `rifletarget1`, then 7 s, then two
  cameras ((0, −910, −110) and (992, −910, −110), Pitch 65059, Yaw 49152),
  each taken with the game's Shot.
  - The live actors (`dump-actor-win`) read back BreakableGlass0 at
    (0, −1216, −84) with Region.iLeaf 0x6b3 (1715), the leaf Play computes.
    BreakableGlass2 is at (992, −1216, −84) with leaf 0x779. The untriggered
    BreakableGlass1 and 3 stay at y −3280 with leaf −1. Bit 0x10 of +0x38c
    reads 1 on all four, which confirms the field.
  - Both frames show the paper lit, with the holder's bar dark above it.
- Play at the same cameras, framed as `visual-acceptance.mjs play` frames
  it (1280×720, Brightness 0.4, no detail textures), draws the targets in
  the same place.
  - Firefox inline and worker, and Chromium worker and inline, give
    identical frames, with no runtime error.
  - Mean levels over the paper (120×170 at 580, 272) are 40.0, 42.2, 47.5
    against the original's 33.3, 35.3, 40.1. Over a wall patch they are
    28.4, 30.3, 37.1 against 22.3, 24.0, 30.0. Play is brighter by the same
    factor on both, about 1.2 to 1.27: this is the known uniform brightness
    gap under Wine ([visual acceptance](visual-acceptance.md), 1.13 to 1.46
    elsewhere). The paper is 1.41 times the wall in Play and 1.49 times in
    the original.
  - Before the change, the paper's polygon added nothing in Firefox inline
    and in Chromium worker (the swapped modes were not run then; the light
    maps are the page's in both). Only the holder drew, at texel 0, so pure
    black.

**Every mover (2026-10-28).** The cache header holds for every brush-tracker
surface, so an ordinary mover's light maps are built again too. The rebuild
is the static path above: the brush's own light list from `iLightActors`,
with its shadow masks, at the facet's current world place. The masks stay the
ones the editor computed at the authored place; the original does not
recompute them either.
- **One header per light map.** Each mover light map (a `lighting.mjs` record)
  keeps the header it was built for, as each cache item does. The world build
  builds them at the authored place, under the authored header
  (`markMoverHeader`).
- **Leaf word.** The simulation sends Region.iLeaf only for a
  bDynamicLightMover. For an ordinary mover the word stays −1: its rebuild
  reads no leaf, and SetActorZone takes the leaf from PointRegion(Location),
  so a new leaf never comes without a new Location.
- **Drawn polygons, on the tracker's facets.** SetupForSurf runs only for
  drawn surfaces, and DrawFrame's facet is the brush tracker's: SetupDynamics
  updates a moved mover before OccludeBsp ([brush tracker](brush-tracker.md)).
  - Every frame, `world.relightMovers` takes the mover draw items of every
    pass: the main frame, its child frames (with child frames on) and the
    ViewportWindow passes (`sim-session.mjs` `moverItems`, each with the
    tracker's `surfaceFacet`).
  - A drawn polygon whose mover's state differs from its light map's header
    is built again on that facet (`relightPolygon`). The grid is
    `lightmapBasis` on the facet, as the fog pass builds its lattice (checked
    against the running original on the Ship's lockers,
    [volumetric fog](volumetric-fog.md)).
  - A light map still on its load-time transform is built again on its facet
    when first drawn, as the original builds its first cache item from the
    facet.
- **Without the tracker** (`?moverTracker=off`), every mover whose header
  differs is built again at its brush matrix (`relightMover`). Inspect keeps
  the load-time maps. bDynamicLightMover movers take the same two paths, with
  their lights from the leaf.
- **Moving lights** use the facet and grid the static texels were built on
  (`geometryFor`), and recompose the light maps placed again
  (`takeReposed`). They used to take the authored facet plus the mover's
  offset, read once from the live group matrix: a light map first reached
  after its mover moved counted the offset twice, and a turned mover kept its
  authored orientation.
- `?moverRelight=off` skips the rebuild; it exists only as the A arm of the
  cost measurement.

Evidence:
- `validate-mover-light-maps` (Node: the map data and the Rust tracker) on
  Training Combat's DeusExMover26, a door slid by KeyPos[1] (0, −56, 0), 6
  light maps with 9 listed lights, and Ship Fan's DeusExMover1, a fan turned
  by 5000 yaw units, 48 light maps with 392 listed lights:
  - the authored header builds nothing again;
  - at the new pose every light map is built again, lists the brush's
    lights, and equals a cold build at that pose bit for bit (2 of 6 and 16
    of 48 change with the pose); back at the authored pose they equal the
    authored build;
  - the tracker's facets after Update at PC24 lie within 5.9e−7 (door) and
    3.7e−5 units (fan) of the matrix pose and give the same texels; the same
    header and facet build nothing again, and a new Location does;
  - a probe moving light composes the texels of a cold build at the new pose,
    whether it lit the mover before the move or only after it.
- The moving lights before this change (`git show 5e516ab8:src/viewer/moving-lights.mjs`),
  under `world.mjs`'s live group matrix: for the door slid first and lit after,
  the facet was already at y −56 and the offset was added again; 5 of its 6
  light maps differed from the cold build.
- `validate-mover-light-maps-play` (Chromium, worker mode):
  - The door, seen face on: its drawn light map is built on its tracker facet
    under the authored header. Slid by KeyPos[1], it is built again once, on a
    facet moved by (0, −56, 0), and its texels change. Back at the authored
    Location, it equals the settled texels.
  - The fan spins on its own (RotationRate, bFixedRotationDir): 36 of its 48
    light maps were built on facets; 167 were built again over 70 frames, at
    most 10 in one.
  - 2026-10-29: the fan stage failed in about half of the runs ("header
    Rotation did not change"). Its placement, `moverDecalProbe` 200 units out
    from the fan's largest fragment, depends on the fan's turn when the call
    arrives. From the first tick's turn it picked surface 950, and from there
    the fan was out of view: no fan polygon drawn, nothing built again. From the
    second tick's turn it picked surface 989 and passed. The check now stands
    the player on the floor under the fan (236, −238, −464.2), where the
    acceptance view fan2's place falls to, aimed at the fan. There 18 or 19 fan
    polygons are drawn, 36 to 38 light maps are on facets, and about 1,100 are
    built again over 61 frames, at most 20 in one, the same in each run.
- `validate-dynamic-light-mover`, `validate-moving-lights-incremental`,
  `validate-auglight-lighting`, `validate-moving-light-effects`,
  `validate-light-spatial`, `validate-texel-sphere` and
  `validate-scene-matrices` pass.
- Cost, measured on the Linux host (Chromium, worker mode, 1440×960). The
  view faced Ship Fan's spinning DeusExMover1 from 200 units. Runs were 4
  interleaved pairs of 600 frames, against `?moverRelight=off`.
  - The rebuild's own phase (`lighting` in `framePhases`) is 0.41 ms per frame
    median, against 0.001.
  - The page's total is 7.37 against 7.22 ms median, inside the runs' spread
    (5.3 to 8.3 ms).
  - A rebuilt light map costs about 0.055 ms (the Play check: 167 over 70
    frames, 0.13 ms per frame).
  - A door costs this only on the frames it moves. A spinning fan in view
    costs it every frame, as in the original. The rebuild is JavaScript
    (`staticLightMap`); the Rust core is where it would move if a measured
    view needs it.
- Not compared with the original game for these movers: no Wine capture of a
  moving door's or fan's light map was taken. The contract is the listing
  above.

Open:
- **Zone ambient.** A mover's zone (the ambient and the cache ID's zone byte)
  is still the zone of its brush centre at the authored place, one light map
  per polygon. The draw items carry the tracker node's zone (`moverItems`
  `zone`), which a polygon drawn in two zones would need as two cache items.
- **Child frames.** Without child frames on, the mirror and sky passes have no
  draw items, so a mover polygon drawn only in a mirror waits for the main
  frame or a ViewportWindow to draw it.
- **Class and leaf −1.** A class 2 light in a leaf's list is left out with a
  note, as for static lists. The moving lights (`moving-lights.mjs`) do not
  yet treat a bDynamicLightMover's Actor-set AddLight (every light class 2)
  or the leaf −1 skip.

## Singular light-map bases

SetupForSurf inverts the facet's FCoords (Core `FCoords::Inverse`, call at
`0x10b06175`) without a test. For a surface whose texture axes are
collinear with its normal (11 surfaces: 5 in 00_Intro, 5 in
02_NYC_FreeClinic, 1 in 12_Vandenberg_Cmd), the zero determinant makes the
whole texel grid non-finite.
- Every coefficient of the normal body becomes FISTP's integer indefinite.
- The NonIncidence, spot and cylinder bodies write zero bytes.

`lightmapBasis` now yields NaN texel positions there instead of refusing
the surface. The translated bodies treat NaN as the x87 treats those
values, and `validate-static-lighting` covers these surfaces: all 8,505
light steps on every Intro surface and 2,184 on the Free Clinic's match the
original fed the same grid. Their textures still map normally, since
texture mapping does not use the inverse.

## Light animation

Three per-frame inputs drive the class 1 lights. All three are
translated, oracle-checked (`validate-light-animation.mjs`) and wired into
Play (see "In Play" at the end of this section).

**Noise** (`0x10b13080`). It is called once a frame with Level.TimeSeconds
through a second light-manager object (`0x10b30a08`, call at `0x10b146ae`).
- `step = ftol(time·35)`.
- Table A (`0x10b4fa44`) takes 256 fresh appFrand floats every frame.
- Table W (`0x10b4fe44`) eases toward A. When `0 ≤ step − last < 16` and
  there was a previous step, the slopes S (`0x10b4f644`) of the
  `16·(step − last)` entries from `last·16` are re-aimed at `(A − W)/16`,
  and the remaining entries advance by `(step − last)·S`. Otherwise W takes
  256 more draws and every slope is re-aimed.
- W is clamped to [0, 1].

The draws come from the game thread's CRT rand (Core appFrand). Since
2026-10-06 Play advances the noise in the simulation, at PreRender's place in
the frame, from the game's shared stream, and the page takes its tables
([moving lights](dynamic-lighting.md) "Time-varying moving lights").

**LightType** (GlobalLighting `0x10b05e90`, table `0x10b2a284`). Each type
function changes the float brightness, which is then clamped to [0, 1].
- Pulse: `0.6 + 0.39·sin`; SubtlePulse: `0.9 + 0.09·sin`. The angle is
  `ftol(TimeSeconds·2293760/max(1, LightPeriod) + LightPhase·256)`, through
  GMath's sine table.
- Blink: dark on an odd `ftol(TimeSeconds·2293760/(LightPeriod+1) +
  LightPhase·256)`.
- Flicker: dark below 0.5 of A at the low byte of the actor's address (a
  host key in Play), scaled by it otherwise.
- Strobe: dark while one shared flag, flipped whenever TimeSeconds changes,
  is set.
- BackdropLight and Steady: unchanged.
- The two texture-palette types: not translated.
- Every type is steady unless the viewport actor's SHOW_PlayerCtrl (0x800)
  is set, which it is in play.

**Merge modulation** (`0x10b030f2`-`0x10b03244`). Before the saturating
add, each spatial byte of a TorchWaver, FireWaver or WateryShimmer light
becomes the low byte of `FISTP(float(spatial·factor) − 0.5)`, where factor
is `0.95 + 0.05·A[i]`, `0.8 + 0.2·A[i]` or `0.6 + 0.4·W[i]`, with `i`
running on from the merge's start index.

The oracle runs the noise function (scripted appFrand, msvcrt `_ftol` as
the truncating x87 sequence) over 240 frames: irregular steps, repeats, a
backward step, jumps, and three starting steps. It runs GlobalLighting for
eight types × four lights over 40 frames each (1,280 frames, including
animation off) and the merge for the three effects on 18 random rectangles
(3,600 texels). Everything matches.

**In Play.**
- *Cached spatial bytes.* `staticLightMap` leaves animated class-1 lights
  (Pulse, Blink, Flicker, Strobe, SubtlePulse, and the three wavers) out of
  the static bytes and keeps their spatial bytes, as SetupForSurf caches
  them.
- *Per frame.* Each drawn frame, `world.updateTextureAnimation` advances
  the noise with Level.TimeSeconds (`createLightFrame`). `lighting.animate`
  then re-merges every animated light map from its static bytes: each
  light's GlobalLighting colour is computed once per frame, the wavers' bytes
  go through their noise tables, and the merge starts at index 0 as at
  `0x10b088de`. Changed regions are uploaded, and moving lights still add on
  top.
- *Exact fast path.* The merge factors are doubles, and the per-(entry,
  byte) modulation table is rebuilt only when its noise input changes. The
  validator checks those doubles against the x87-model modulation for all
  6,291,456 (noise entry, byte) pairs of 32 frames, with no difference.
- *Skipping and culling.* A light map whose lights' colours and noise
  inputs are unchanged is skipped. Without a possible mirror view, level
  light maps outside the camera frustum wait. The merge does not depend on
  which surfaces are drawn, so a skipped map is correct once it is drawn.
- *Host choices, noted in the viewer.* Flicker's entry is the light's export
  index (low byte) instead of its address. (The noise draws came from a
  host appFrand stream until 2026-10-06; Play's now come from the game's
  shared stream in the simulation.)
- *Not in Play yet.* The texture-palette LightTypes (8, 9). The spatially
  dynamic effects are in Play since 2026-10-06 ("Spatially dynamic
  effects").

## Rust kernel

The per-frame merge (`animateLightMap`) runs in the Rust core
(`native/script-vm/src/light.rs`, driven by
`src/runtime/light-animation-kernel.mjs`) as an exact representation change.
`animateLightMap` stays the reference: `LIGHT_KERNEL=js` in Node or
`?lightKernel=js` in the viewer selects it. Browser profiles on October 2
measured its JavaScript loop at 2.5 ms/frame on Training, 1.7 on Battery
Park and 1.0 on Everett (`play-frame-cost.md`).

- **Where.** light.rs runs in the script-VM kernel instance, with no
  statics, beside fire.rs and fog.rs. A light map's block (a header of u32
  words, the static bytes, a mirror of the texels and each animated light's
  cached spatial bytes) comes from a per-world pool of 1 MiB chunks of
  `kernel.light.alloc`. The fire allocator now also frees: `world.dispose`
  returns the pool and the next world reuses its chunks. `refill` (a script
  brightness change) re-registers the light map after its JavaScript merge,
  reusing the block when the new layout fits.
- **Admission.** Every rectangle must lie inside the map and every spatial
  array must hold its rectangle; otherwise the light map keeps merging in
  JavaScript. All 2,713 animated light maps of the seven validated maps are
  admitted.
- **What stays in JavaScript.**
  - The GlobalLighting constants, through the reference's own
    `animatedLightConstants` and per-frame cache, called for every light of
    each merged map in list order. Strobe's shared flag arrives from the
    simulation with the frame's light noise (`frame.light.strobe`, set in
    `beginLightFrame` with its time), so these calls read it without
    flipping it ([mesh lighting](mesh-lighting.md) "LightType functions,
    Strobe and the noise"). Their colour `tables` are now built at first use; the kernel
    path never asks for them unless it must copy them (below).
  - The memo. The reference compares a string of each light's three colour
    steps and its noise input (`A<frameIndex>`, `W<noise version>` or
    nothing). For numbers `String(a) === String(b)` exactly when `a === b`
    or both are NaN, and a light's input kind is fixed by its effect, so the
    kernel path runs the same test on numbers kept in a Float64Array.
  - The choice of light maps, and the float samples (`lighting.mjs`).
- **What moved.**
  - The colour tables: `Math.min(127, (byte·step) >> 16)` through a
    Uint8Array, built in light.rs when the three steps are int32 integers
    (the double product is then exact and ToInt32 keeps its low 32 bits).
    Other steps (NaN, beyond int32) copy the reference's tables. One slot
    per light actor, rewritten when its constants object changes.
  - The modulation tables, rebuilt by the reference's rule (a new frame
    object, frameIndex for effects 1–2, noise version for effect 3) from the
    frame's factors at that first use: `fistp(f(factor·byte) − 0.5) & 255`.
    Below 2^52 the nearest-even sum with ±2^52 lands on the integer grid, so
    it equals `fistp`'s ties-to-even exactly; larger magnitudes, infinities
    and NaN take the transcribed `fistp` and ToInt32's low byte.
  - The union reset from the static bytes, the merge in light order (the
    modulation index counts every rectangle texel from 0) and the
    comparison with the saved union. When a byte changed, the union's row
    span is copied back to the record's JavaScript texels (the block mirrors
    them, so the columns outside the union are equal); otherwise nothing is
    copied, as nothing changed.
- **Validation.** `validate-light-animation-rust.mjs` builds the light maps
  of 00_Training, 02_NYC_BatteryPark, 11_Paris_Everett,
  06_HongKong_WanChai_Underworld (Pulse, Flicker, Strobe),
  06_HongKong_MJ12lab (Pulse, SubtlePulse), 03_NYC_MolePeople (FireWaver)
  and 15_Area51_Page (TorchWaver, FireWaver, WateryShimmer) headless, as
  `world.mjs` does. Each animated light map has a JavaScript mirror merged
  by `animateLightMap` on a second frame with an identical appFrand stream.
  Over 600 frames per map (steps, repeats, jumps; some frames skip a subset
  of maps), with four script brightness changes per map, every returned
  region (or null) and every texel byte match. The kernel's colour and
  modulation tables also match the reference's whenever they hold the
  current frame's inputs. Synthetic maps cover what the game data does not:
  static bytes above 127, every LightType and effect, Blink, huge, negative
  and NaN steps, factors at ties, 0, negative, huge, infinite and NaN,
  merges without a memo, re-registration and a recreated kernel. Each of
  seven injected bugs failed it: ties rounded up, the rounding's negative
  branch dropped, a wrong low byte between 2^52 and 2^62, a 7-bit
  modulation index, no reset from the static bytes, negative colour entries
  clamped to 0, and the memo ignoring the noise input.
- **Cost.** Headless (`--bench 600`, Node, M2 Pro, interleaved blocks of 50
  frames, medians in ms per frame), the merge alone and `lighting.animate`
  (with the float samples of changed regions, still JavaScript):

  | Map | merge JS | merge Rust | animate JS | animate Rust |
  |---|---:|---:|---:|---:|
  | 00_Training | 2.34 | 0.67 | 2.67 | 0.95 |
  | 02_NYC_BatteryPark | 1.55 | 0.40 | 1.71 | 0.54 |
  | 11_Paris_Everett | 0.77 | 0.20 | 0.84 | 0.27 |

  On Training the kernel path's remaining time is light.rs's merge
  (~0.4 ms for ~200,000 spatial texels a frame), the WateryShimmer table
  (~0.1 ms when the noise steps) and ~0.1 ms of JavaScript (constants,
  memo, copy-back). Browser frames were not measured here.

## Spatially dynamic effects

Stage 4, 2026-10-06. These are the effect-table rows with
IsSpatialDynamic: Searchlight, SlowWave, FastWave, CloudCast, Shock, Disco,
Interference and Rotor. Their spatial bytes change with Level.TimeSeconds.
Shell (`0x10b05740`) is time independent but was untranslated as well. Its
user in the shipped content is a moving light: the EMP and nano-virus
grenades spawn an ExplosionLight with `LE_Shell`.

**Census** (every light of the 83 maps whose effect is one of these). All
are class 1 lights in BSP light lists:

| Effect | Lights |
| --- | --- |
| Searchlight | Helibase (2 TriggerLights, off until triggered), WanChai Garage (2), Area51 Page, Endgame 1, 2 and 3 |
| Rotor | NYC ShipFan (1), Vandenberg Tunnels (3), Vandenberg Sub (4) |
| Disco | WanChai Canal (2, LightType BackdropLight), WanChai Underworld (2), Paris Club (1) |
| SlowWave | NYC Graveyard (1 TriggerLight), NYC ShipBelow (4, Pulse) |
| FastWave | Endgame 2 (1 TriggerLight) |

No map places CloudCast, Shock, Interference or Shell lights.

### When they run

- **Class.** AddLight (`0x10b08b30`) makes a `bStatic` or `bNoDelete` light
  with one of these effects class 1. The only exception is
  `UClient.NoDynamicLights`, under which every such light is class 0; Play
  never sets it, and that case is noted, not modelled.
- **Effect row.** ComputeFromActor copies the effect row to info `+0x60`
  (function), `+0x64` (IsSpatialDynamic) and `+0x68` (IsMergeDynamic).
- **Per-frame rebuild.** SetupForSurf's per-frame map (GCache suffix
  `0x31`) is rebuilt at most once per `Viewport.CurrentTime`, and only for
  a surface that is being drawn. On each rebuild, a class 1 light with
  `+0x64` set takes its illumination from its shadow bits (cached, suffix
  `0x15`) and runs its spatial function again into GMem.
- **Merge.** The merge (`0x10b03040`) only modulates effects 1–3, so for
  these effects it is a plain saturating add, from start index 0.
- **Other class 1 lights.** They keep their spatial bytes cached (suffix
  `0x16`) unless `bLightChanged` (actor `+0x28` bit 10) is set.
- **Time source.** `[0x10b3df88]` is `Level->Actors(0)`, the LevelInfo,
  set at `0x10b06e0b` and `0x10b08d45`. `+0x478` is TimeSeconds.
- **Precision.** SetupForSurf runs inside DrawWorld, so every body and
  ComputeFromActor run at 24-bit precision ([BSP occlusion](bsp-occlusion.md)).
- **No mesh or fog use.** FLightManager::Light (`0x10b027f0`, mesh
  vertices) and the fog loop never call info `+0x60`. These effects
  therefore change neither mesh lighting nor volumetric lighting.

### The bodies

All bodies share the arguments (LightMap, info, illumination, out). They
read info `+0x1c` rr2 and `+0x24` incidence, and the falloff table
`0x10b34a6c` at `index = FISTP(d²·rr2) < 4096`. All share the grid walk of
the spot body.

- **Searchlight** (`0x10b03770`).
  - `x = f32(Phase·π/32 + TimeSeconds·35/Period + 2π)`, with no time term
    when Period is 0.
  - `m = appFmod(4·atan2(dx, dy) + x, 8π)`. The 8π is pushed at
    `0x10b0395c`.
  - The byte is 0 unless `π ≤ m` and `f32(m) ≤ 3π`.
  - Otherwise the lobe `(cos(ftol(m·65536·(−1/2π))) + 1)·0.5` is taken,
    scaled by `q = (dx²+dy²)·6e-5` when `q < 1`.
- **Rotor** (`0x10b03ae0`). The same lobe at `6·atan2(dx, dy) +
  TimeSeconds·3.5`. When `q = (dx²+dy²)·1e-4 < 1`, it becomes
  `s·q + (1 − q)`.
- **SlowWave and FastWave** (`0x10b03de0`, `0x10b040b0`). The sine of
  `ftol((d − TimeSeconds·35)·1024)`, with `d = ftol(tableSqrt(d²))`.
  FastWave uses `d >> 2` and 2048. The result is `0.3·sin + 0.7`.
- **Shock** (`0x10b043a0`). It uses `d = ftol(√·8)` and
  `T = TimeSeconds·4000`, and multiplies three factors `0.1·x + 0.9`:
  - the cosine at `(d + T)·−16`;
  - the sine at `(2d − T)·16`;
  - the sine at `((d>>1) − T)·16`.
- **Disco** (`0x10b046f0`).
  - Two lobes, at `f32(11·atan2(dx, dy)) + TimeSeconds·5` and at
    `11·atan2(√(dx²+dy²), dz) + TimeSeconds·5`.
  - They combine as `c1 + c2 − c1c2`, times `q = (dx²+dy²)·5e-5` when
    `q < 1`.
  - The byte is then `table·(1 − s)·illumination·incidence`.
- **Interference** (`0x10b04c80`). The second Disco lobe alone.
- **CloudCast** (`0x10b04380`). Forwards to the normal body; time
  independent.
- **Shell** (`0x10b05740`). `R = tableSqrt(d²)·(1/R)`, kept for
  `0.8 < R < 1`. The byte is `(1 − 10·|R − 0.9|)·illumination`, with no
  falloff table and no incidence.

Math calls:
- Core appAtan2 (`0x10123280`) is `fld Y; fld X; fpatan`. FPATAN's
  extended result is multiplied by 4, 6 or 11 at 24 bits. Every call site
  passes `(Y = dx, X = dy)` or `(Y = √(dx²+dy²), X = dz)`.
- appFmod goes to msvcrt `_CIfmod`, whose fprem loop is exact for finite
  operands.
- `_ftol` truncates to 64 bits and keeps the low word.

### Translation (`native/script-vm/src/spatial.rs`)

**Arithmetic.** The bodies use f32 operations wherever both operands are
floats; at 24-bit precision on binary32's normal range these are the same
operations. `mul24` and `add24` round an operation with a double constant,
a large int or an extended value exactly once to 24 bits. When the f64
result lands exactly on a 24-bit midpoint, an error-free transform decides
the rounding.

**FPATAN** (`atan_k`):
- *Model.* The correctly rounded atan2, multiplied by k and rounded to 24
  bits.
- *Fast path.* An f64 atan2 (table of atan(k/64) plus series) is used
  unless the product lies within 2^-39 of a 24-bit midpoint.
- *Slow path.* Inside that band, a double-double atan2 (about 2^-100)
  decides. `AMBIGUOUS` counts double-double values within 2^-60 of a
  midpoint, where FPATAN's own last bit could matter.

**Per-frame cache.** Each body is split at its first time-dependent
operation:
- `prepare` keeps exactly the values the single loop holds (the falloff
  index, FPATAN products, square roots, q, the illumination byte);
- `finish` completes the byte;
- `run` chains the two per texel, as the original loop does;
- `run_frame` prepares a per-texel cache (eight words a texel, for
  rectangles up to 65,536 texels) and then only finishes it.

**Per-light constants.** `renderPassConstants` (static-lighting.mjs)
computes ComputeFromActor's rr2 (`float(float(1/R)²·4093)`) and its
incidence dot in binary32, as the render pass does. The rest of the static
path still uses the 64-bit `movingLightConstants` / `normalLightIncidence`
(see "Not yet moved").

### Evidence

**Oracle.** `scripts/native-dynamic-light-oracle.py` (`spatialDynamic`
cases) runs the eight bodies and CloudCast unchanged under Unicorn:
- control word `0x007f`;
- LevelInfo at `[0x10b3df88]`, LightPeriod and LightPhase at actor
  `+0x1e6`/`+0x1e7`;
- Play's square-root and normal tables, and coords.mjs's sine table in
  GMath;
- appFmod as Python's exact `math.fmod`;
- appAtan2 as `fld tbyte` of FPATAN measured on the x87 hardware.

**Hardware probe.** `tools/x87-fpatan-probe.c` is built with
i686-w64-mingw32-gcc and run under Wine on the AMD Ryzen host. It runs
`fld Y; fld X; fpatan; fstp tbyte` at a given control word.

**`scripts/validate-light-spatial.mjs`** (Linux host, about 15 seconds) uses
Play's own inputs: facet, grid, rectangle, shadow illumination and
24-bit constants.
- *Cases.* Every census light on every surface listing it, at two of six
  TimeSeconds from 0.01 s to 131,072 s. Then 192 fabricated cases: exact
  hits (dx = dy = 0), zero illumination, singular (NaN) grids, period 0,
  times up to 3.5·10⁶ s, and unshadowed (`0x7f`) lights.
- *Spatial bytes.* 3,082 cases (2,890 from the maps), 377,732 texels,
  107,532 lit: 0 mismatches. Every case asks for the same appAtan2 operand
  sequence as the original (262,207 calls, 95,386 distinct pairs).
- *Contrast.* With the original at `0x037f` instead (`--cw 0x037f`), 45 of
  216 Paris Club and fabricated cases differ: the precision matters.
- *FPATAN.* All 95,386 pairs were measured at `0x007f` and `0x037f`, with
  identical results (FPATAN ignores precision control). For k = 4, 6 and 11,
  all 286,158 products of the measured results equal spatial.rs. 1,726
  measured results (1.8 %) are not the correctly rounded extended value,
  yet no 24-bit product changes. The double-double path decided 15 pairs,
  and none was ambiguous.
- *Fast path.* On 1,000,000 random float pairs, the fast path and the
  double-double path agree (36 fallbacks).
- *Constants.* rr2 at 24 bits matches ComputeFromActor (`0x10b05fd9`) for
  all 256 radii; the 64-bit model differs in 121. Incidence
  (`0x10b06325`) matches on all 1,311 census light/surface pairs; the
  64-bit model differs in 164. On these lights, the 64-bit constants would
  change no spatial byte.
- *Cached form.* At three times per case, `run_frame` equals `run`.
- *Moving Shell.* An ExplosionLight-style Shell light through
  moving-lights.mjs on Training reaches 263 light maps. Every one equals the
  static copy plus the original Shell bytes' colour entries (9,522 lit
  texels).

**Merge plumbing.** `validate-light-animation-rust` now includes Paris
Club, NYC ShipFan, WanChai Garage, NYC ShipBelow and Endgame 2, plus
synthetic spatially dynamic lights. On every frame, the kernel's in-merge
recompute (time token, cache) equals the reference merge, which calls
`run` (12 maps, 2,229,768 merges).

### In Play

- *Static map.* `staticLightMap` puts each class 1 light with one of these
  effects into `animated`, with its spatial.rs inputs (rectangle-relative
  illumination, grid, location, constants, Period, Phase). Shell lights in
  a static list run spatial.rs.
- *Per frame.* The memo token of these lights is `T<TimeSeconds>`.
  `light_merge` reruns `run_frame` whenever the time differs from that of
  the bytes it holds.
- *Reference.* `animateLightMap` calls `run` through the kernel. The
  `?lightKernel=js` / `LIGHT_KERNEL=js` reference merge still uses the
  Rust bodies, because no JavaScript copy exists.
- *Drawn surfaces only.* With OccludeBsp's frame (no mirror or sky child
  frame), animated level light maps merge only for the surfaces it draws,
  as the original rebuilds only drawn surfaces. Otherwise the frustum test
  applies. Brush light maps always merge. A map that waits is correct when
  it is next drawn, since its bytes depend only on the frame's inputs.
- *Moving lights.* moving-lights.mjs runs Shell for moving (class 2) lights
  with illumination `0x7f` and the 24-bit rr2. No class 2 light in the
  shipped content has one of the time-varying effects (the census in
  [moving lights](dynamic-lighting.md) "Time-varying moving lights"); they
  stay unlit for class 2 with a note.

`scripts/validate-light-spatial-play.mjs` runs Play headless (`?sim=inline`)
beside Paris Club's Disco light. All 95 Disco light maps are admitted. 12
merge per frame and 9 change, on every one of 240 frames, and the light
atlas changes. No "not translated" note appears. With `--map
06_HongKong_WanChai_Garage --light 3849.45,-988.31,-61.93`, 69 Searchlight
light maps behave the same way.

**Cost** (Linux host, Ryzen 9 8945HS; the 120 fps target is defined on the
M2 Pro). Light animation in Play, headless, median per frame: Paris Club
0.8 ms (12 drawn Disco maps), Garage 0.9 ms. The whole-map merge with
every animated map merged (`validate-light-animation-rust --bench 300`,
Node) costs:

| Map | Without the cache | With the cache |
| --- | ---: | ---: |
| Helibase | 3.6 ms | 1.8 ms |
| Paris Club | 2.5 ms | 1.8 ms |
| Garage | 1.6 ms | 0.9 ms |
| Vandenberg Sub | — | 1.0 ms |
| NYC ShipFan | 0.75 ms | 0.46 ms |

Disco's per-frame part costs about 50 ns a texel (two cosine lobes and a
dozen 24-bit roundings).

### Remaining gaps

- The light-manager tables (square root `0x10b3e1b8`, normal falloff) are
  built at init, outside PreRender. Play uses the 64-bit builds. Under
  `0x007f`, 248 of the 2,048 square-root entries differ. The original builds
  them at `0x027f` on the game thread, measured, and Play's builders equal its
  tables bit for bit ([render-pass precision](render-pass-precision.md#measured-in-the-running-original-2026-10-14)).
- An FPATAN whose double-double value sits within 2^-60 of a 24-bit
  midpoint depends on FPATAN's last bit. None was seen.
- Values outside binary32's normal range, as for the BSP occlusion port:
  for example, squares of displacements below 10⁻¹⁹.
- `UClient.NoDynamicLights` (class 0 spatially dynamic lights).
- Class 2 lights with the spatially dynamic effects (none in the shipped
  content).

## Not yet moved

Still to do: the texture palette LightTypes and volumetric (fog map)
lighting.

**24-bit precision for the rest of the static path (done 2026-10-06).**
SetupForSurf and everything it calls run at 24 bits
([render-pass precision](render-pass-precision.md)), and so does the
translation now; the oracle runs at `0x007f` with the light-manager tables
at the init word. From the instructions:
- **Spot** (`0x10b04f80`): `1/(1−c)` is a 24-bit value on the stack before
  `·c` (k14); the row start's Z sums, `d² = (dz² + dy²) + dx²`, the axis dot,
  the cone test of the two stored products `d²·c²` and `dot²`, and the
  `s` chain `((rsqrt·dot)·k4 − k14)² · table · illumination · incidence`
  are binary32 operations, then `− 0.5f`.
- **Cylinder** (`0x10b04a80`): `1 − ((dy² + dx²)·(1/R))·(1/R)` (the double
  1.0 is exact), times the illumination, `− 0.5f`, each at 24 bits.
- **Normal** (`0x10b03360`): the start differences and sums, the six
  coefficient dots and `illumination·table·incidence + 2^23` at 24 bits.
- **NonIncidence, the constants, incidence and rectangle**: see
  [moving lights](dynamic-lighting.md) "Precision".
- **Light animation**: the noise's `TimeSeconds·35` rounds before `_ftol`
  and `n·S + W` rounds the product; Pulse, Blink and SubtlePulse
  (`0x10b05a10`, `0x10b05a90`, `0x10b05b90`) round `TimeSeconds·2293760.0`
  before the period division and phase sum, and `sin·0.39 + 0.6` (or
  `0.09`, `0.9`) once per operation from the exact value; the merge factors
  `A·0.05 + 0.95` (and the others) likewise (`mergeFactor`; Play's factor
  table and light.rs take those 24-bit factors).

Before, at `0x007f` against the 64-bit translation: incidence differed in
875 of 3,952 Training steps, the spatial bytes in 13 of 1,945,707 texels,
rr2 for 121 of 256 radii, FGetHSV for 1,789 of 2,049 triples, and the
LightType brightness in 259 of 2,560 frames of validate-light-animation's
cases (an hour-long clock included). Now every check matches at `0x007f`
(the maps and counts are in [moving lights](dynamic-lighting.md)
"Precision").

Cost (Linux host, headless, interleaved A/B in one process against the
previous tree, medians): world build (light maps included) Training 2,200
→ 1,093 ms (the spot `s` chain left the BigInt model), Island 1,734 →
1,630 ms; light animation per frame Training 2.92 → 2.70 ms, Island 0.19 →
0.21, Paris Club 2.10 → 2.15 (9 samples; within noise); twelve moving lights
recomputed every frame Training 0.92 → 0.81 ms, Island 2.18 → 2.09, Paris
Club 2.16 → 1.85.

Two facts recovered from SetupForSurf's listing matter for that wiring:
- A level surface's static list goes through AddLight with each light's
  shadow mask; the mask pointer advances for every list entry, including
  rejected lights. There is no bSpecialLit test there. On Training, Island,
  Battery Park and NYC Street no listed light mismatches its surface.
- A class 2 light from a static list is merged unshadowed every frame, even
  though it has a mask. None of those four maps has one.
