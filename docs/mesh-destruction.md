# Mesh destruction at the LoadMap collection

The question (2026-11-05, Stage 7 row 7.4.1): LoadMap's collection purges the meshes the next level does not reach
(script-process-collection.mjs), and the next visit loads them again from the same held package (DeusExCharacters, DeusExItems,
DeusExDeco). Play detached a purged mesh's record from its linker's export table but nothing else: its four lazy arrays stayed in the
linker archive's lazy-loader array (`ULinkerLoad` +0x4d8, archive +0x434), with their loaded bytes, and every generation stayed with
them (worker heap snapshots on ten Island and Training round trips: 1,630 to 2,046 ArrayBuffers there, 12.9 to 35.6 MB; [memory
across many maps](map-memory.md)). This note records what the original does with a purged mesh and how Play now runs it.

The authority is the hash-verified GOTY Engine.dll (`0c3a8b18…c20b4`) and Core.dll (`8bf3039e…ba7e4`), read with
`tools/disasm-annotated.py`, and runs of the original bodies in Unicorn (`native-mesh-load-oracle.py`, `native-mesh-graph-oracle.py`,
`native-linker-lazy-loader-oracle.py`).

## The collection's two passes

PurgeGarbage (`0x101581f0`, [Core garbage collection](script-gc.md)) walks GObjObjects twice. The first pass calls
`ConditionalDestroy` on every unreachable object, which sets the `0x00800000` flag and calls the object's `Destroy` virtual
(`+0x24`). The second pass calls the scalar deleting destructor (`+0x0c`) with 1 on each. So every object, linkers included, is
destroyed before any destructor runs.

* **The mesh classes do not override Destroy.** Slot `+0x24` of UMesh's vtable (`0x104290b8`), ULodMesh's (`0x1042942c`) and
  UPrimitive's (`0x1042655c`) is the import thunk to `UObject::Destroy`: ExitProperties and `SetLinker(NULL)`, which nulls the
  export map's object (Play's `graph.detachExport`).
* **A linker the collection unloads detaches all its lazy loaders first.** `ULinkerLoad::Destroy` (`0x10162730`) calls
  `DetachAllLazyLoaders(0)` (`0x10162f80`) before detaching its exports: every loader still attached loses its archive and saved
  position ([the linker archive](script-linker-lazy-loader.md#detach-all-the-linkers-destruction)).
* **The scalar deleting destructors** (UMesh `0x1031c120`, ULodMesh `0x1031c930`): with bit 2 clear they call the complete
  destructor (`0x1030280b` → `0x10319ed0`, `0x10303922` → `0x1031c1f0`) and, with bit 1, `UObject::operator delete(this, 0x12c or
  0x1b0)`.

## The destructors

Each member is destroyed in reverse declaration order. Every TArray member goes the same way: `TArray<T>::Remove(0, Num)` (a thunk to
an Engine helper that asserts the range and calls Core `FArray::Remove(0, Num, sizeof(T))`, body `0x101454f0`), then, if Data is
non-null, `GMalloc->Free(Data)`, then Data, Max and Num zeroed in that order (inline, or Core `FArray::~FArray` `0x10107200`, which
is the same). `FArray::Remove` returns at once for a zero count; otherwise it shifts the tail, lowers Num and, when
`3·Num < 2·Max` or the slack is 16 KB or more, and the slack is over 64 elements or Num is 0, sets Max to Num and Reallocs. Removing
every element always takes the last branch, so the Realloc to zero frees Data and the destructor's own Free finds it null.

**`~ULodMesh` (`0x1031c1f0`)**: the ULodMesh vtable, `ConditionalDestroy`, then its own arrays +0x1a0 (2-byte elements, helper
`0x1030a0a0`), +0x174 (8, `0x1031c750`), +0x168 (8, `0x1031c890`), +0x15c (4, `0x1031c7f0`), +0x150 (2), +0x144 (8), +0x138 (2),
+0x12c (2, through `~FArray`), then `~UMesh`.

**`~UMesh` (`0x10319ed0`)**: the UMesh vtable, `ConditionalDestroy`, then

| Member | Kind | Destruction |
| --- | --- | --- |
| +0xe4 | TArray, 4-byte | helper `0x1031be70` |
| +0xd8 Textures | TArray, 4-byte | helper `0x1031bdd0` |
| +0xc0 | TLazyArray, 4-byte | `0x1031af90` |
| +0xb4 | TArray, 16-byte | inline Remove, `~FArray` |
| +0xa8 | TArray, 28-byte | helper `0x1030b8a0` |
| +0x90 | TLazyArray, 8-byte | `0x1031aab0` |
| +0x84 AnimSeqs | TArray, 32-byte | helper `0x1031bb40`: `~FMeshAnimSeq` (`0x1031bf10`) on each removed sequence in index order (its Notifys TArray at +0x14, 8-byte elements), then `FArray::Remove(…, 0x20)` |
| +0x6c | TLazyArray, 20-byte | `0x1031a550` |
| +0x54 | TLazyArray, 8-byte | `0x1031a150` |

then `~UPrimitive` inlined (the UPrimitive vtable and `ConditionalDestroy`) and `~UObject` (Core, IAT `0x10599b04`).

**`~TLazyArray`**: the four bodies are byte-identical but for their vtable and element size. Each stores its vtable (`0x10429188`,
`0x10429228`, `0x104292c8`, `0x10429368`), then, when `SavedAr` (+4) is non-null, calls `SavedAr->vtable[+0x3c](this)`: the linker
archive's `DetachLazyLoader` (`0x10162dd0`), which removes the loader from the archive's array by identity and zeroes its `SavedAr`
and `SavedPos`. Then its TArray (at +0xc) goes as above.

Every `ConditionalDestroy` in the destructors returns at once: the first pass set the flag.

So a purged mesh in a package the collection keeps leaves that linker's lazy-loader array, its arrays are freed, and nothing else
holds its loaded bytes. A purged mesh in a package the collection unloads has no archive left by the time its destructor runs, and
the linker goes.

## In Play

`script-mesh-load.mjs` translates the destructors (`destroyLodMesh`, `destroyMesh`, with `removeMeshArray` for FArray::Remove over a
mesh array's byte storage), `script-linker-lazy-loader.mjs` DetachAllLazyLoaders (`detachAllLinkerLazyLoaders`). The load graph
binds them:

* `graph.destroyLinker(name)` is ULinkerLoad::Destroy for a linker the collection unloads (ScriptClassLoader.unloadPackages):
  `DetachAllLazyLoaders(0)`, then the graph forgets the linker. Its exports are already detached (Play does not unload a package
  with a loaded export); the "Unloading" log, GObjLoaders and the reader deletion are host lifetime.
* `graph.destroyPurged(record)` is the second pass for a purged record: the complete destructor of a constructed mesh, its lazy
  arrays detached through the linker archive's DetachLazyLoader. `ConditionalDestroy` requires the record to be detached (the first
  pass); `~UObject`'s unhash and slot release are `detachExport`'s, and operator delete is the host's garbage collector. Play's
  projections of the freed arrays (the sequences, their names and notifies, the texture references) are emptied with them.
* The process collection runs it for every purged record after the packages are unloaded, as the second pass follows the first.
  Play walks its purged set in the tracker's order, not GObjObjects order. The end state does not depend on it: DetachLazyLoader
  removes by identity, keeping the other loaders in their order, and FArray::Remove's shrink depends on Num and Max only.

A mesh's payload view (`meshPayloadView`) reads the same arrays, so a destroyed generation reads empty; the next request loads a new
generation from the package (the registry forgot the purged record), as the original's does.

## Verification

* `validate-mesh-load-graph.mjs` runs the original `~ULodMesh` after its loads, PostLoad and deferred array loads, on two meshes, and
  compares Play's translation with it:
  * DeusExCharacters.GM_Trench_Carcass in a linker the collection keeps, beside three other objects' loaders (Max 40 after the original
    Attach growth): the 127 calls in order (each Remove with its array, index, count and size, each Realloc with Num and Max, the
    four Detaches with the archive's Remove at indices 6, 5, 4, 3, the three ConditionalDestroys with the vtable then in place,
    `~UObject`) and the end state (the object's vtable UPrimitive's, each lazy array's vtable, null archive and zero position, every
    array empty, the archive holding the three others, Num 3, Max 40);
  * DeusExDeco.Lamp1 in a linker the collection unloads, through Play's binding (`destroyLinker`, `destroyPurged`): no Detach,
    the archive empty with Max 0, the same end state.
* `validate-script-linker-lazy-loader.mjs` compares DetachAllLazyLoaders(0) with the original body.
* The round trips in Node (DX, then Training and the Island twice): before, the held linkers' lazy-loader arrays went 768, 1,032,
  1,092, 1,300, 1,360 loaders (+268 a round trip: 60 and 208 loaders of purged LodMeshes in DeusExCharacters, DeusExItems and
  DeusExDeco); now 752, 956, 808, 956, 808, every one a live mesh's.
* In the page, row 7.4.1's ten round trips ([memory across many maps](map-memory.md#purged-meshes-lazy-arrays-fixed-2026-11-05)):
  the actors' backing stores in the worker hold 1,530 ArrayBuffers at the second and the tenth Training arrival (1,630 and 2,046
  before), and the total's rise is 6.9 MB a round trip in Chromium and 5.2 in Firefox (9.6 and 8.1 before).
* The collection's and the travel paths' validators pass: validate-loadmap-gc, validate-process-collection (gc2),
  validate-process-memory, the travel, restore, new-game, ending and save/load validators, and all 41 internet save slots load.

## Other purged resources

The collection also purges textures, sounds, music and fonts. None of them leaves a loader: Play's graph creates their records
without preloading them (the original-loaded walk keeps their RF_NeedLoad, `setDeferPreload` in original-loaded.mjs; Play reads
their bytes outside the graph), so their lazy arrays are never attached. Measured on the same round trips: every loader on a held
linker has one of the four mesh lazy-array vtables, and the purged sounds' FSoundData have no archive. Their destructors are not run
(`destroyPurged` returns false for them); a change that preloads one of these kinds through the graph would need its destructor
traced first (USound's is: [sound lifecycle](script-sound-lifecycle.md)).
