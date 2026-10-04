# Original dynamic actor visibility

This is a bounded recovery of the original renderer's actor admission path.
It does **not** recover BSP occlusion ([BSP occlusion](bsp-occlusion.md) does) or authorize distance/line-of-sight
culling. The browser's broad mesh-frustum sphere is host culling, not the
original visibility contract. Full original visibility remains incomplete.

## Authority and call order

The installed `System/Render.dll` is the authority, SHA-256
`607f1077c5cd3e25f8a4cde1ffacf4cf9260aebc92a72be40721cd6955bd75d1`.
The locally extracted SDK headers `UnRender.h`, `UnMesh.h`, `UnRenDev.h`,
`EngineClasses.h` and their measured 32-bit layouts identify fields and
virtual slots; the DLL instructions establish branch order. Original files
and disassembly stay outside Git.

`URender::SetupDynamics` (`0x10b22d90`) scans `Level.Actors` in array order.
The entire pass requires at least one model BSP node (`Model+0x5c`) and
`SHOW_Actors` (`0x8`) on the viewport actor. For each actor:

1. Null entries are skipped. `bHighDetail` (`Actor+0x28`, mask `0x100000`)
   is skipped when `Viewport.RenDev.HighDetailActors` is zero. This skips
   the actor's moving-light processing too.
2. In a root frame (`Frame.Recursion == 0`), a first-person viewport skips
   its `ViewTarget` (`+0x60c`); child frames and behind-view frames do not
   perform that rejection. This also skips moving-light processing.
3. The explicit excluded actor argument skips sprite processing only.
4. `GIsEditor` selects `bHiddenEd` (`+0x15c`, mask `1`) or `bHidden`
   (`+0x28`, mask `2`). Hidden actors still reach moving-light processing.
5. `bOnlyOwnerSee` (`+0x1a0`, mask `4`) requires the actor's Owner chain,
   starting at the actor itself, to contain `Viewport.Actor`, and requires
   first-person view. `bOwnerNoSee` (mask `2`) rejects an owned actor only
   in first person. There is no unconditional exclusion of the viewport
   actor in this instruction range; the caller's excluded actor is separate.
6. An actor with a Brush, whose class derives from ABrush, and which is not
   `bStatic`, goes through the moving-brush tracker instead of this sprite
   path. Otherwise sprite setup requires `GIsRunning` (import
   `0x10b5d5ec`), **not** `GIsClient`.
7. RenderIteratorClass/RenderInterface can replace the actor with an
   iterator's actor sequence. That protocol has not been translated here.
   With no interface, construction of `FDynamicSprite` follows.

Steps 1–6 are at `0x10b22e1f–0x10b22f42`; rejection targets distinguish
skipping the complete actor (`0x10b232f4`), proceeding to lights
(`0x10b230e8`), and the moving-brush route (`0x10b230d5`). `bDeleteMe`,
`Style`, collision radius, distance from the camera and zone membership are
not tested in this admission segment. This does not imply they are absent
from every renderer or level-lifecycle path.

## Mesh setup before bounds

`FDynamicSprite::Setup` (`0x10b23910`) copies the actor's Location,
Rotation, DrawScale and ScaleGlow to the sprite. DrawType `DT_Sprite=1` and
`DT_SpriteAnimOnce=7` take a separate sprite path. `SHOW_ActorIcons=0x20`
also selects that path. Otherwise the mesh path requires `DT_Mesh=2` and
a non-null Mesh (`+0x174`); merely possessing a Mesh does not select it.

For a mesh, `0x10b239b9–0x10b23a4c` computes camera-space center depth:

```
depth = ((Location.Z-Origin.Z)*ZAxis.Z
       + (Location.Y-Origin.Y)*ZAxis.Y)
       + (Location.X-Origin.X)*ZAxis.X
```

These are x87 intermediates, with a float store to sprite depth at `+8`
before comparison, but the comparison uses the unrounded stack value.
The comparison constant at `0x10b2b83c` is **negative zero**, not a near
plane distance. Negative or unordered depth rejects the mesh unless RendMap
is orthographic (`13`, `14`, or `15`). Exact zero is admitted. Consequently
the original can reject a mesh whose center lies behind the camera even if
its bounds intersect the view. This is an original renderer rule, not a
general geometric claim.

Only after that gate does the renderer call
`Mesh.GetRenderBoundingBox(Actor, Exact=0)` (virtual slot `0x5c`), followed
by `URender::BoundVisible(Frame, box, SpanBuffer=null, screenBounds)`
(slot `0x80`). False rejects the sprite. Successful screen bounds are
converted to integers, and `Y1 < Y2` is required. Those bounds routines are translated separately from the admission gate
below; they are not yet wired into Play.

## Mesh bounds and perspective screen rectangle

`src/runtime/render-mesh-bounds.mjs` translates the complete Engine
`UMesh.GetRenderBoundingBox` body at `0x103a6850–0x103a6b9b` and the
perspective, null-SpanBuffer branch of Render `URender.BoundVisible` at
`0x10b162e0–0x10b170d0`. Engine and Core hashes are the pinned originals
already enforced by `native-collision-oracle.py`; Render's hash is above.

The mesh body calls the original virtual `GetAnimSeq` with **this actor's**
AnimSequence. Native names are interned FName identifiers; the string adapter
uses the already recovered ASCII C-locale name folding and zero terminator
from [script-names.md](script-names.md). If the sequence exists and AnimFrame
is nonnegative, the body unions two stored frame boxes: the float32 phase
is `(AnimFrame + 1) * NumFrames`, converted by x87 nearest-even after
subtracting `0.5`, then wrapped modulo NumFrames and offset by StartFrame.
The second index uses that integer plus one. At integer phase this is not
universally equivalent to floor. Negative tween frames and unknown sequences
use the mesh's all-animation UPrimitive box. The Exact argument is not read;
neither the owner-animation flag nor blend slots are read during selection.

The selected box has Mesh.Origin subtracted and Mesh.Scale times DrawScale
applied; bParticles uses the native constant `1.5` instead of DrawScale.
Minimum components and maximum X/Y have float32 subtraction/scale stores;
maximum Z retains both intermediates in x87 through their product. The body
expands each side by one unit. UnitCoords is inverse-rotated by mesh RotOrigin,
then actor Rotation; its origin becomes the float32 Location + PrePivot.
Core `FCoords.Transpose` (`0x1011a140`) and `FBox.TransformBy`
(`0x101198f0`) then transform all eight corners. The helper preserves those
x87 operation and float-store boundaries rather than substituting a Three
bounding box or the mesh's all-animation sphere.

The perspective BoundVisible contract is:

1. A camera origin inside the world box returns the full viewport and depth
   zero. Otherwise, an initial six-product depth test can reject the box.
2. Eight camera-space corners produce four-plane outcodes. A nonzero AND
   rejects the box; the OR selects which screen edges need clipping. Corner
   arithmetic retains some products and stores others, including partial
   stores for the final two corners; the translation records these explicitly.
3. Each projected X uses retained `ProjZ/Z`; projected Y uses its float32
   store. Screen floats are converted with nearest-even after subtracting
   `0.5`. After initializing from corner zero, the original loop repeats
   corner zero and processes through corner six. Corner seven affects
   outcodes/minimum depth but **is not projected by that loop**.
4. X/Y bounds are clamped to the viewport. Minimum depth compares the
   retained x87 value before storing the winning float32 value; a negative
   final minimum becomes zero. Ordered comparison preserves signed-zero
   behavior, including tiny negative retained depths that store as `-0`.
5. Setup subsequently requires `Y1 < Y2`. BoundVisible returning true is
   therefore insufficient to admit a zero-height screen rectangle.

`buildBoundsSceneFrame` reuses the already native-verified scene frame in
[script-window-scene-frame.md](script-window-scene-frame.md), adding
ComputeRenderSize's four float32 outcode coefficients from frame offsets
`0xec–0xf8`. It does not derive the original camera matrix from Three.
The supported inputs remain finite original map boxes, the existing measured
perspective FOVs, and the established x87 control word `0x037f`.
Orthographic projection, non-null span buffers, RenderIterator, mirror frame
production and BSP/span visibility are not implemented by this helper.

## BSP and visible actor order: unresolved integration

`FDynamicSprite` construction at `0x10b233c0` does not make an actor
visible. Successful setup inserts a sprite plus a raster rectangle chunk
into the root dynamics list. The chunk precedes the sprite and the old
list. The rectangle is later filtered through BSP nodes and visible spans
in `OccludeBsp` (`0x10b173d0`). The traversal, splitting, portal/zone span
merging and visible actor ordering must be recovered together before
wall-occluded actors can be excluded or zone timestamps can be updated.

`DrawActorSprite` writes Actor.LastRenderTime at
`0x10b25150–0x10b25161`. `OccludeBsp`'s zone timestamp write at
`0x10b1766d–0x10b1768d` targets model zone state, not ZoneInfo actors;
see [script-loadmap-startup.md](script-loadmap-startup.md). Admission alone
must never stamp an actor as drawn.

## Verification status

`scripts/native-render-visibility-oracle.py` loads the pinned Render.dll
through the existing native-light probe and executes the original admission
segment and mesh-setup body. Fixtures supply actual actor/frame memory and
imported global values. Execution stops at the declared branch boundaries;
no bounds, sprite, iterator or lighting result is substituted. Unexpected
imports or memory accesses trap.

`node scripts/validate-render-visibility.mjs` compares the standalone
`src/runtime/render-visibility.mjs` translation with the original: **24
actor-admission cases and 18 mesh-setup cases pass**, including owner chains,
first-person/child/behind views, hidden editor/runtime flags, moving brushes,
all three orthographic modes, DrawType alternatives and missing meshes.
Two numeric cases establish why rounded depth is not enough: extended
cancellation leaves a negative depth that binary64 addition would lose,
and a tiny negative depth stores as negative zero but still rejects.

The oracle uses control word `0x037f`, like the existing mesh translations;
the precise running-game FPU control word is still the limitation recorded
in [dynamic-lighting.md](dynamic-lighting.md#precision-boundary-fpu-control-word).
The standalone depth helper uses the exact existing x87 model and is not
optimized for a per-actor hot loop.

There is deliberately **no Play integration or performance claim** for this
slice. A local Island-start census at baseline `96d0203` contained 416 mesh
actors, 291 prepared previews, and 220 previews visible in the main frame.
All 416 had DrawType 2, no bHighDetail, and no RenderIteratorClass/Interface.
All 220 visible actors had positive center depth. The three negative-center
actors (TrashCan1, Buoy3 and NYPoliceBoat0) were already invisible. These
new gates would therefore remove zero visible actors in that capture.
The local capture `.work/render-admission-island.json` stays outside Git.

Future integration must evaluate child frames too: an actor excluded by
the main frame may be visible in a mirror. The admission helper does not
replace Play's actor lifecycle checks, claim to implement RenderIterator,
or claim that passing admission means an actor was drawn.

## Bounds verification and measured integration limit

The native oracle also executes the complete original mesh-box and
perspective BoundVisible bodies, including original GetAnimSeq, Core
rotations and box transforms. Unknown imports trap. Its scene-frame cases
execute the original producer with the existing real-x87 tangent captures.
`node scripts/validate-render-mesh-bounds.mjs` compares **17 mesh boxes,
24 perspective bounds and three frame producers** against those bodies;
every returned float32 bit matches. Cases cover frame wrapping, negative
tween selection, odd frame-count rounding, particles, mesh/actor rotations,
negative scale, near/view-plane intersections, tiny projected boxes, and
signed-zero/retained-underflow minimum depth. Two raw string name spellings
also match the same original numeric FName lookup.

An Island capture contains 291 prepared meshes (220 visible under the host
sphere), using the native main-frame camera and actual 1440×839 canvas.
All 291 translated world boxes, screen rectangles and decisions match the
original native calls bit for bit. Original setup admits 203 of the 220
host-visible actors. The 17 additional rejections all have zero integer
screen height: two crowbars, three flares, a medkit, candy bar, multitool,
button, two laser triggers, LAM, lockpick, two data cubes, pepper gun and
hide-a-gun. No wall occlusion or distance heuristic is involved. Captures
`.work/render-bounds-island.json` and `.work/render-bounds-native-island.json`
stay outside Git.

This does **not** justify adding the helper to each Play frame yet. An
isolated warm Node workload using the captured fields measured the complete
291-box transform plus projection at **9.32 ms median** (30 samples;
p10–p90 8.77–10.45 ms), or **7.20 ms** for the 220 host-visible actors.
Projection of already cached boxes cost **0.47 ms** for all 291, or
**0.41 ms** for the visible 220 (100 samples each). These are helper timings,
not a browser FPS measurement, and do not include property reads or cache
invalidation. The exact x87 box transform currently dominates. Avoided work
for 17 tiny static items has not been shown to exceed even the cached path.

Future integration therefore needs a native-equivalent cheaper transform or
bounds reuse with complete frame-selection/transform invalidation, evidence
of a net workload reduction, and native child-frame handling so mirrors can
admit actors rejected by the main frame. The standalone recovery supplies
that original boundary; it deliberately adds no per-frame Play work.
