# Deferred actor cleanup and stale references

The authority is the installed GOTY Core.dll and Engine.dll, whose hashes are
recorded in script-object-lifecycle.md and script-destroy.md. This note covers
ULevel cleanup separately from Core garbage collection.

## Class reference cleanup

UStruct.CleanupDestroyed thunk 101022f7 enters 10127170. Core global GIsEditor
is 101e5544. In play, the routine first traverses the object-property list at
UStruct+58, following property+60 (101272d5–10127337). Each property's ArrayDim
slots are visited in ascending order. Each non-null object is validated, then
its IsPendingKill virtual +2c is called; a true result clears that reference
slot. No script event, property destructor or Modify call occurs in this path.

After all direct object references, the struct-property list at UStruct+5c is
visited, again following property+60 (10127339–101273ad). Each fixed-array
struct element recursively calls its linked struct's CleanupDestroyed +78.
Dynamic-array/map properties are not in either list and are not traversed by
this native routine. This is distinct from GC archive serialization.

UStruct.Link10126060 builds both lists by appending, preserving child Next order
through the derived struct/class then its bases (10126129–10126223). Iterator
helpers 1012b260 and 1012b2e0 filter UProperty ancestry for UObjectProperty
(class identity102a61f0) and UStructProperty (102a3ef0), respectively; they follow
Next+2c and GetSuperStruct virtual+68. The first includes ClassProperty through
its ObjectProperty base, independently confirmed by the native class registration
at101671f4; see [native class identities](script-native-class-registration.md).
This supports using the existing linked property order
filtered into two lists, rather than interleaving nested structs with objects.

In the editor branch, native child/super iteration visits properties in their
original interleaved order. Object references still call IsValid and
IsPendingKill, but a true result calls the referenced object's Modify +1c before
clearing its slot (10127249–1012725e). Struct properties recurse immediately
when encountered. Editor undo storage remains a required external binding.

UObject.IsPendingKill (101028a1 →1010ab80) always returns zero. AActor's override
(10302167 →1030df80) reads bDeleteMe (Actor+28 bit7). The verified CameraPoint
vtable10427178 uses that Actor override. UClass101758f4, UPackage101753a0,
UTexture1042672c, USound10429580 and UMesh104290b8 all use the Core zero-return
method; the Engine classes dispatch via import thunk1040c722. Other native
subclass overrides require their own binding.

## Level actor array and pending chain

CompactActors (10302248 →103963e0) preserves the prefix before raw Level+110.
Starting at that explicit index, it stably packs non-null actors whose bDeleteMe
is false, warns and skips any pending-delete actor still in the array, then
removes the unused suffix (1039640a–103964f7). Array undo recording is reached
only if GUndo is non-null. The prefix is not filtered and indices can change
for actors in the packed suffix.

CleanupDestroyed (10301811 →103965a0) first calls CompactActors when GIsEditor
is false and force is zero, even if no actors await finalization. It then counts
Level+100's Deleted chain through Actor+f8. With fewer than128 entries and no
force, it returns. At or above128, or when forced, it scans the live level actor
array in ascending order and runs each non-null actor class's CleanupDestroyed
virtual+78 (10396618–10396633), clearing stale typed references before release.
The array length and slot are read live for each iteration.

After reference cleanup the editor path returns without final deletion. In
play, each pending head is checked for bDeleteMe, removed from the head before
external cleanup, and passed to the LevelInfo event manager at+550 when present
(10396680–1039679a). The manager's DestroyActor clears queued event records and
references; it remains a mandatory native service when non-null. Finally the
actor's deleting destructor virtual+0c receives1 (103967a7–103967ad). The next
iteration rereads the live pending head. Core final deletion/unhash/free-index
behavior is documented separately in script-object-release.md.

Malformed linked lists, invalid object identities, unsupported native overrides,
editor transactions and non-null unbound event managers fail explicitly in the
host. Ordinary cleanup does not infer an early tick call site, claim full GC,
or drop a pending actor before its original reference cleanup and release order.

## Play wiring

Level.Tick ends with `CleanupDestroyed(0)`, so Play reaches the reference
pass as soon as 128 destroyed actors wait on the Deleted chain (09_NYC_Dockyard's
conversations did). The level collection (`script-level-collection.mjs`)
supplies its services:

- `isValid`: a record in the host registry must hold its slot and not be
  released. A pre-placed export carries `null` for its unmeasured slot and is
  registered with its level. Host-owned natives the registry does not track
  (the root window and its windows, the client viewport behind Player) and
  package resources (textures, sounds, meshes, classes; a host object with
  its export key) stay registered for the host's life, as the persistent
  packages are never unloaded. Anything else is invalid and keeps the
  explicit error.
- `isPendingKill`: bDeleteMe on an actor, false otherwise (UObject's zero
  return; AActor's override is the only one in the SDK headers).
- `release(actor, flags)`: the deleting destructor. A runtime-created actor
  goes through the collection's final delete (~UObject unhash, slot free to the
  LIFO free list, operator delete). A pre-placed export is outside the host
  registry, which models only runtime-created objects. Its ConditionalDestroy
  is a no-op after DestroyActor's. Its GObjObjects slot and FName hash have no
  host counterpart. Its storage stays with the level reload, which replaces
  every map export in place; the reference pass has already cleared every
  reference to it. Not modelling the original's push of that slot onto the
  free list only affects runtime spawn indices, which Play does not take
  from the original's index space (its registry starts at the host's own
  objects).

`scripts/validate-cleanup-destroyed-live.mjs` destroys 130 spawned Tracers and
a pre-placed crate on a booted Island, with a crate's Target pointing at one
Tracer, and checks one tick: the chain is released, Target is None, every
Tracer is released with its slot freed onto the free list, and the crate left
the actor array while keeping its export for the reload.

## Host reference pass over object images

The reference pass is host work over a faithful routine: in the original it is
a short C++ loop, but Play ran it as one property reference per visited
pointer. On 00_Intro the Liberty Island firefight (muzzle flashes, tracers,
blood drops, shell casings, sparks) puts 128 actors on the Deleted chain every
1.5–3 seconds, and each pass over the level's 1,200–1,700 actors took
230–290 ms in the simulation worker: a visible stall every couple of seconds
(October 6, headless Chromium, Linux host, `.work/tools/hitch-trace.mjs` and
`.work/tools/worker-spikes.mjs`). Two host costs made it slow:

- The level collection's `attached` asked `ScriptRuntime.instance`, which
  throws for an identity that is not an attached script object, inside a
  try/catch. Every texture, mesh and sound pointer threw and caught one
  Error: 14,000–18,000 per pass, about 160 ms.
  `ScriptRuntime.attachedInstance` answers null without throwing.
- Each visited field built a property reference, each fixed-array element a
  fresh scalar field copy (which misses the descriptor cache), and each struct
  member a copy of its whole struct.

In play, `ScriptRuntime.cleanupReferences` now reads the pointers from the
object's image. `cleanupSites` flattens cleanupScriptReferences' play order
(direct object properties, then struct properties recursively, fixed-array
slots ascending) into a per-class list of pointer sites, and
`pointerOffset` gives each its image offset. `cleanupImageSites` reads each
handle, and reads a site under a host-bound top-level field (Outer, Class,
Level, a bound Region) through its binding, as the reference traversal does.
Each referenced object is asked IsValid and IsPendingKill once per level pass:
neither answer can change while the pass only clears references, and the
release loop runs after it. A pending target's site is cleared through the
same reference chain cleanupScriptReferences would build. An object with a
poisoned cell, a visited field without a cell, or an unlinked struct, and the
editor branch, keep the reference traversal, which remains the reference.

`scripts/validate-cleanup-image.mjs` checks the translation on Play's state:
two processes boot 00_Intro (seed 1, 300 frames with the HUD), plant 51 stale
pointers to one actor in Target, Touching[1], Touching[3] and Region.Zone
(imaged and bound), mark it bDeleteMe, and run the pass over all 1,101 actors
with the reference traversal or the image pass. Digests before and after are
equal across the modes, every planted pointer is cleared, all 1,101 actors
take the image path, and IsValid runs 1,283 times instead of 8,377.

Measured on the Linux host:

| Workload | before | after |
|---|---:|---|
| Reference pass alone, 00_Intro headless, 1,102 actors, warm median | ~81 ms (~110 ms with the throwing lookup) | 2.9 ms |
| One sweep in Play (inline), 1,200–1,700 actors | 230–290 ms | 75–100 ms with only the lookup fixed; the full pass is the row above |
| 00_Intro in Play (worker), 45 s, 3 interleaved pairs: draw gaps ≥ 100 ms | 27, 22, 23 | 2, 1, 0 |
| Same runs: p99 draw gap | 283, 233, 250 ms | 33, 50, 33 ms |

Island's headless tick (`bench-sim --render-feedback`, 3 interleaved pairs)
is unchanged within noise (median 11.08–12.44 ms before, 11.80–12.05 ms
after), with the same digest. The remaining loop is about a third of the
pass; the rest is the bound reads and the registry-backed IsValid answers,
which stay with the JavaScript level collection, so the walk stays in
JavaScript for now. The per-class sites and offsets are what a Rust walk over
the arena would take.
