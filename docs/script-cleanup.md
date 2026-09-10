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
