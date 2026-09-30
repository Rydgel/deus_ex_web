# Original dynamic actor visibility

This is a bounded recovery of the original renderer's actor admission path.
It does **not** recover BSP occlusion or authorize distance/line-of-sight
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
converted to integers, and `Y1 < Y2` is required. Translation of those
bounds routines is not part of the admission gate.

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
