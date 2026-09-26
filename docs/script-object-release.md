# Core UObject final release

This note covers the final C++ object release after `ConditionalDestroy` and
`UObject::Destroy`. The authority is the hash-verified GOTY `Core.dll` and
`Engine.dll` in `.cache/research/Core.asm` and `.cache/reference/Engine.asm`.
The ULevel pending-deletion driver and the reflected-reference cleanup before
this phase are documented in [Actor.Destroy](script-destroy.md); this note does
not redefine those drivers.

`ConditionalDestroy` and `UObject::Destroy` are lifecycle hooks, not memory
reclamation. `ConditionalDestroy` (Core thunk `0x10102270`, body
`0x1014fdb0`) marks `UObject+0x1c` with `0x00800000`, guards re-entry, and
calls virtual `+0x24`. `UObject::Destroy` (thunk `0x101025f4`, body
`0x1014fa50`) sets `0x80000000`, calls `ExitProperties`, detaches the old
linker, and stores the Outer object index in `UObject+0x14` (or zero for a
null Outer). Neither body clears the state-frame pointer at `+0x0c`, the hash
link at `+0x08`, or the object registry slot.

## Final UObject destructor

The final base destructor is `??1UObject` (Core thunk `0x101028c4`, body
`0x10150040`). Its observed order is:

1. It saves the object index from `+0x04`, then immediately writes the base
   UObject vtable `0x10179dfc` to `+0x00`.
2. If the saved index is `-1`, it skips registry and state-frame release. It
   also skips that release block when the global at `0x102a2644` is null, or
   when the global at `0x101e5550` is non-null. The binary does not give these
   two raw globals stable semantic names in this trace; a host must preserve
   these gates rather than assuming they are always open.
3. It calls `UObject::IsValid` (Core export thunk `0x10101c1c`). A false result emits
   the original assertion, but execution continues into the release block.
4. It calls `ConditionalDestroy(this)` again. This is deliberately
   re-entrant: the `0x00800000` guard normally makes this second call a no-op.
5. It reads `+0x14` and calls `UnhashObject(outerIndex)` (Core thunk
   `0x101032d3`, body `0x10157760`). This read occurs after
   `UObject::Destroy` has detached the linker and replaced `+0x14` with the
   Outer index, so that value must be retained until this call.
6. It clears `GObjObjects[objectIndex]` to null.
7. It appends the saved object index to `GObjAvailable`: increment the
   available count, grow its FArray with `FArray::Realloc` when the new count
   exceeds capacity, then write at the old count position.
8. It reads `FStateFrame*` from `+0x0c`. If non-null, it calls the global
   `GMalloc` at `0x101a7c44`, through allocator virtual slot `+0x08`, with
   that pointer. No instruction writes `+0x0c` to null; after this call the
   field is only a dangling value until the object memory is freed.

The destructor does not call `??3UObject` itself. Core `??3UObject` (thunk
`0x101010cd`, body `0x1010aae0`) receives the object pointer and size, ignores
the size in the observed body, and calls `GMalloc` virtual `+0x08` with the
object pointer. A scalar deleting destructor calls `??1UObject` first and
then this delete thunk, so the state frame and registry are released before
the object allocation is freed.

The global arrays used by the body are fixed in the original binary:

| Original global | Meaning observed in the instructions |
| --- | --- |
| `0x1029e628` | `GObjObjects` data pointer |
| `0x1029e62c` | `GObjObjects` count; it is not decremented by the destructor |
| `0x1029e630` | `GObjObjects` capacity |
| `0x1029e618` | `GObjAvailable` data pointer |
| `0x1029e61c` | `GObjAvailable` count |
| `0x1029e620` | `GObjAvailable` capacity |

A freed index is therefore made reusable without compacting `GObjObjects`.
The available list is LIFO: `UObject::AddObject` (Core body `0x10157830`)
reads the last entry, calls `FArray::Remove(last, 1, 4)`, and uses that index
before growing `GObjObjects`. When no available entry exists, AddObject grows
the object array and uses its old count. It writes the selected object to the
slot, stores the index at `+0x04`, and calls `HashObject`.

## Hash removal and retained Outer index

`HashObject` (Core thunk `0x101012e9`, body `0x10157730`) hashes an object with

```
(NameIndex at +0x20 XOR (Outer ? Outer+0x04 : 0)) & 0xfff
```

and prepends it to the bucket table at `0x1029e644`; the next pointer is
`UObject+0x08`. `UnhashObject` recomputes the bucket using the NameIndex and
the explicit `outerIndex` argument, walks that singly linked chain, patches
the head or prior `+0x08` link for each match, and asserts that it found
exactly one object. It does not explicitly clear the removed object's `+0x08`.

This explains the order dependency: `UObject::Destroy` first calls
`SetLinker(NULL, -1)` while `+0x14` still contains the old linker export index,
then writes `Outer+0x04` (or zero) to `+0x14`; only the later C++ destructor
passes that retained Outer index to `UnhashObject`. Clearing `+0x14` earlier or
passing the linker index would select the wrong bucket.

## Engine class deleting destructors

`ULevel::CleanupDestroyed` (Engine export thunk `0x10301811`, body
`0x103965a0`) advances the pending chain and calls each actor's class vtable
`+0x0c` with argument `1` (`0x103967a7–0x103967ad`). This is the class scalar
deleting-destructor entry, not a direct call to Core `UObject::~UObject`.

For the actual `CameraPoint` fixture, `.rdata` gives vtable
`0x10427178`, whose `+0x0c` entry is `0x10302450`; that thunk jumps to body
`0x10310780`. With the native argument `1`, the body takes its scalar path:

1. It calls complete `??1ACameraPoint` (Engine thunk `0x10301cf8`, body
   `0x103105b0`).
2. It pushes the CameraPoint allocation size `0x390` and `this`, then calls
   the Engine IAT `0x10599ab4`, which is Core `??3UObject`.

The alternate flag bit `0x2` path is an array-destruction helper at
`0x104134d6`; it is not selected by CleanupDestroyed's argument `1`. The
scalar path frees only after the complete destructor returns.

The complete CameraPoint destructor shows the inherited vtable sequence in
Engine instructions: it writes `0x10427178` (CameraPoint), calls imported
Core `ConditionalDestroy` (`0x10599b08`), writes `0x10427020` (AKeypoint),
calls the same Core hook, writes `0x104268dc` (AActor), calls it again, then
finishes the reflected/native field cleanup and calls imported Core
`??1UObject` (`0x10599b04`) at `0x103106fc`. The direct AActor destructor is
Engine thunk `0x10301c21`, body `0x1030d4c0`; its own scalar deleting entry is
AActor vtable `0x104268dc + 0x0c = 0x10301479`, which jumps to body
`0x1030dfa0` and uses allocation size `0x318`.

Thus the minimum final-release boundary for this class is the original
vtable `+0x0c` call with argument `1`, followed by the class destructor chain,
Core registry/hash/state-frame release, and Core allocator delete in that
order. Calling the base Core destructor alone would omit CameraPoint/AKeypoint/
AActor cleanup; freeing the object before the base destructor would leave the
registry, hash chain, and state frame live.

## Verified native member teardown

The native bodies expose four contiguous 12-byte, FArray-shaped members in
the AActor portion of these objects. Their names are not present in the
destructor instructions. The AActor constructor at `0x10326bd5–0x10326c0e`
calls Core `FStringNoInit` (`0x10599b88`) on `+0x2ac`, `+0x2b8`, `+0x2c4`,
and `+0x2d0` in internal indices 0, 1, 2, and 3. These are therefore four
native FString records, not arbitrary arrays; their final cleanup still
follows the FArray-shaped storage operations below. The constructor trace
does not carry reflected property names, so a host should identify them by
offset and preserve this order:

| member offset | words used by the native code |
| --- | --- |
| `+0x2ac` | data pointer `+0`, count `+4`, capacity `+8` |
| `+0x2b8` | data pointer `+0`, count `+4`, capacity `+8` |
| `+0x2c4` | data pointer `+0`, count `+4`, capacity `+8` |
| `+0x2d0` | data pointer `+0`, count `+4`, capacity `+8` |

`Actor.uc` declares the corresponding script strings as `BindName`,
`BarkBindName`, `FamiliarName`, and `UnfamiliarName`, but this native trace
does not prove which declaration name maps to which internal index. Keep the
offset mapping above as the authoritative release contract and leave that
per-name association unresolved.

The Engine IAT entries used by the destructors are Core `FArray::Empty`
(`0x10599a28`), `FArray::Realloc` (`0x10599a20`), `FArray::~FArray`
(`0x10599a14`), and `FArray::Remove` (`0x10599a18`). The `Empty` calls push
`0` then `2`; Core therefore receives `(elementSize=2, newCapacity=0)`.
The `Realloc` calls push `2`, after the destructor has written count and
capacity zero. Core `FArray::~FArray` (body `0x10107200`) frees a non-null
data pointer with `GMalloc` virtual slot `+0x08`, then writes all three words
to zero.

Two Engine helper thunks are part of this contract. `0x10303a4e` jumps to
`0x1030a0a0`; callers pass `ECX=member`, `index=0`, and the member's current
count. The body asserts `index >= 0` and `index + count <= member[+4]`, then
calls Core `FArray::Remove(index, count, 2)`. It does not free the data or
clear the member. `0x10302158` jumps to `0x10309e10` and takes no explicit
arguments. It reads the current count, calls `FArray::Remove(0,count,2)`,
frees a non-null data pointer through `GMalloc` virtual `+0x08`, and clears
data, count, and capacity. The assertion paths in both helpers are the
original `appUnwindf` checks; they are not alternate cleanup behavior.

The complete CameraPoint destructor (`0x103105b0` through `0x10310714`)
performs this exact sequence:

1. It writes the CameraPoint vtable `0x10427178`, calls Core
   `ConditionalDestroy`, writes the AKeypoint vtable `0x10427020`, calls the
   same hook, writes the AActor vtable `0x104268dc`, and calls it once more.
2. At `+0x2d0`, it calls Core `Empty(2,0)`, then the
   `0x10303a4e` remove helper, then `FArray::~FArray`.
3. It repeats that `Empty(2,0)`, remove-helper, FArray-destructor sequence at
   `+0x2c4`.
4. At `+0x2b8`, it writes count and capacity zero, calls `Realloc(2)`, calls
   the remove helper, and calls `FArray::~FArray`.
5. It repeats that zeroed `Realloc(2)`, remove-helper, FArray-destructor
   sequence at `+0x2ac`.
6. It calls Core `UObject::~UObject` through the Engine IAT at
   `0x103106fc`. There is no direct `GMalloc` free for any of these four
   members in this complete destructor beyond the FArray destructor calls.

The direct AActor destructor (`0x1030d4c0` through `0x1030d617`) first writes
the AActor vtable and calls `ConditionalDestroy`. It then zeroes count and
capacity, calls `Realloc(2)`, and calls the `0x10303a4e` remove helper for
each member in descending source order `+0x2d0`, `+0x2c4`, `+0x2b8`,
`+0x2ac`. The first three members then call `FArray::~FArray`. The last one
(`+0x2ac`) instead tests its data pointer, calls `GMalloc` virtual `+0x08`
when non-null, and explicitly clears data, capacity, and count. It does not
call `FArray::~FArray` for `+0x2ac`. It finally calls Core
`UObject::~UObject` through `0x10599b04`.

The distinct AKeypoint complete destructor (`0x10310040` through
`0x10310182`) writes the AKeypoint then AActor vtables and calls
`ConditionalDestroy` at each level. Its `+0x2c4`, `+0x2b8`, and `+0x2ac`
members use the AActor zeroed-`Realloc(2)`, remove-helper,
`FArray::~FArray` path. Its `+0x2d0` member uses the distinct
`0x10302158` clear-and-free helper after zeroed `Realloc(2)` and therefore
does not make a separate `FArray::~FArray` call. It then reaches Core
`UObject::~UObject`.

The scalar deleting wrappers are separate from those complete bodies. The
AActor vtable `+0x0c` entry reaches `0x1030dfa0`; its complete path calls
`0x1030d4c0`, its allocation size is `0x318`, and flag bit `0x1` then calls
Core `??3UObject`. Flag bit `0x2` selects the Engine array-destruction helper
`0x104134d6`. AKeypoint's `+0x0c` wrapper is `0x10310000`; it calls
`0x10310040`, uses size `0x318`, and has no bit-`0x2` array branch.
CameraPoint's `+0x0c` wrapper is `0x10310780`; it calls `0x103105b0`, uses
size `0x390`, and has the same bit-`0x2` helper branch as AActor. The
`CleanupDestroyed` argument `1` selects the complete path in all three
wrappers; the Core delete occurs only after that path returns.

For the CameraPoint path, Core `FArray::Empty10107190` writes count zero and
the requested capacity, then calls `Realloc10145440`. Realloc calls allocator
virtual `+0x04` with the existing data pointer, capacity times element size,
and the allocation tag pointer `101ab50c`, and stores the returned pointer.
It does this even when the pointer is null and the requested size is zero.
The subsequent `Remove101454f0` returns immediately for a zero removal count.
`FArray::~FArray10107200` then frees a non-null returned pointer through
allocator `+0x08`, and zeroes data, capacity, then count.

`script-object-release.mjs` implements this CameraPoint member sequence through
`destroyCameraPointString`, with explicit raw member storage and allocator
services. `releaseScriptCameraPoint` changes the inherited vtables and invokes
ConditionalDestroy in source order, destroys the four bound FString members,
calls `destructScriptObject`, and finally calls `freeScriptObject` when scalar
flag bit1 is set. Array destruction and other native classes remain unsupported.
The registry's `unhash` preserves removed hash-next pointers, and base destruction
retains the saved object index and state-frame pointer while releasing their
registry/allocation ownership. The host marks freed records separately.

`node scripts/validate-script-cleanup.mjs` exercises original CameraPoint
Destroy and reflected metadata through pending cleanup, mutable reference
serialization, final release and index reuse. After original ExitProperties
has cleared all four script strings, the fixture supplies matching empty native
FString records by offset. This explicitly checks the post-Destroy final-release
boundary; it does not establish a general reflected-name/native-offset binding
or native CDO loader. Process gates, the allocator and loaded native resource
identities are explicit fixture inputs. A released record is rejected by the
script runtime instead of remaining usable through a stale host identity.

## Host boundary and unresolved conditions

The host final-release helper must receive an explicit object identity, its
retained `+0x14` Outer index, registry/hash services, an allocator/state-frame
release service, and the class deleting-destructor callback. It must preserve
re-entrant `ConditionalDestroy`, the two raw Core global gates, the
`IsValid` assertion behavior, the exact `UnhashObject → GObjObjects null →
GObjAvailable append → FStateFrame free` order, and the later `??3UObject`
free. It must not introduce an early pending-kill or pending-chain removal.

The two final-destructor globals at `0x102a2644` and `0x101e5550` are still
unnamed, and the complete destructor's reflected field cleanup is class
specific. `UStruct::CleanupDestroyed` and reflected reference serialization
remain separate contracts. A host that cannot prove those gates and class
cleanup hooks should stop before mutating the registry or freeing memory
instead of silently emulating a partial release.

## Release on a Player start

LoadMap's `CollectGarbage(RF_Native)` releases the retired level's objects
through this destructor ([Player start collection](script-loadmap-gc.md)).
It uses the live-game gate values (`0x102a2644` = 1, `0x101e5550` = 0).
ConListItem (`0x10002ed0`) and DeusExTextParser (`0x10004820`) run their
recovered deleting destructors. For every other class the purge runs the
observable tail: `ConditionalDestroy` (a no-op after the purge's first pass),
`destructScriptObject` and `freeScriptObject`. The class's native member
teardown between them frees allocator storage the host does not model and
touches no other UObject in the classes checked (`~XFlagBase` `0x1001b530`,
`~APlayerPawnExt` `0x1001c150`, `~XRootWindow` `0x100059c0`).
`ScriptRuntime.deleteObject` exposes the same tail for a Destroy override
that deletes other objects, as `DConHistory::Destroy` does for its events. The
freed slots reach GObjAvailable in purge order, and the next AddObject reuses
the last one.
