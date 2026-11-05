# `ULinkerLoad` lazy-loader archive

This note records the concrete `FArchive` implementation reached by the
installed Deus Ex GOTY linker when a package resource, including `USound`,
attaches an `FLazyLoader`. The authority is the hash-verified Core.dll
(`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`) and
Engine.dll (`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`),
with disassembly in `.cache/reference/Core-rng.asm` and
`.cache/reference/Engine.asm`. The note is evidence for a future host binding;
it does not substitute a browser archive or file-reader implementation.

## Concrete archive selection

Core's `ULinkerLoad` constructor thunk `0x10101f91` enters body
`0x10160000`. The object has an embedded `FArchive` beginning at
`ULinkerLoad+0xa4`. The constructor first writes the normal base archive vtable
`0x101751f8` and the base archive words, then replaces that pointer with
`0x1017a430` at `0x1016018b`:

```text
ULinkerLoad +a4 = 0x101751f8       ; 0x1016015b, temporary base archive
ULinkerLoad +a8 = 0x44
ULinkerLoad +ac = 0x44c
ULinkerLoad +b0/+b4/+b8/+bc = 0
ULinkerLoad +c0/+c4/+c8 = 1
ULinkerLoad +cc = 0
ULinkerLoad +a4 = 0x1017a430       ; 0x1016018b, concrete linker archive
```

The same constructor calls `GFileManager` through `0x101a7c48`, invokes its
vtable slot zero with the filename at `0x101a7c38`, and stores the returned
reader at `ULinkerLoad+0x4e4` (`0x101601b9`–`0x101601cf`). Every concrete
archive forwarding body below loads that reader through the equivalent
embedded-archive offset `+0x440` (`0xa4 + 0x440 = 0x4e4`). Thus `+0x440` is a
pointer field in the embedded archive's enclosing object, not a second reader
allocation.

The `ULinkerLoad` class registration at `0x10159e00` names the class
`LinkerLoad` (UTF-16 string at `0x101b004e`), uses class record
`0x1029ccd0` (the autoclass pointer at `0x1029cccc`), and passes a properties
size of `0x4e8`. This agrees with the constructor's highest observed reader
field at `+0x4e4`; it is class-layout evidence, not a claim that all bytes in
the object have been typed.

The concrete archive vtable at `0x1017a430` contains these relevant entries:

| Archive slot | Vtable target | Body and observed behavior |
| ---: | ---: | --- |
| `+0x04` | `0x101022e8` | `0x10163310`: forwards raw `Serialize(buffer,length)` to reader slot `+0x04` |
| `+0x10` | `0x10102f3b` | `0x10162000`: `FArchive::Preload(UObject*)` (outside this lazy-loader contract) |
| `+0x18` | `0x1010150a` | `0x10163470`: linker object-reference operator |
| `+0x1c` | `0x1010141f` | `0x10163580`: linker name operator |
| `+0x28` | `0x10101cee` | `0x10163110`: forwards `Tell()` to reader slot `+0x28` |
| `+0x2c` | `0x10102478` | `0x101631b0`: forwards `TotalSize()` to reader slot `+0x2c` |
| `+0x34` | `0x10101569` | `0x10163070`: forwards `Seek(position)` to reader slot `+0x34` |
| `+0x38` | `0x101017d0` | `0x10162bf0`: concrete `AttachLazyLoader(FLazyLoader*)` |
| `+0x3c` | `0x10101a5a` | `0x10162dd0`: concrete `DetachLazyLoader(FLazyLoader*)` |

The other entries are outside the lazy-loader contract here. In particular,
the base vtable's Attach and Detach entries (`0x101751f8` slots `+0x38`/`+0x3c`) point to
`0x10101325 -> 0x10106a40` and `0x101022d4 -> 0x10106a60`; both are the
three-byte `ret 4` no-op bodies. The `ULinkerLoad` archive is the recovered
override used during package reads.

## Attach mutation and `FSoundData` fields

`0x10162bf0` receives the embedded archive pointer in `ECX` and an
`FLazyLoader*` in `[EBP+8]`. The `FArray` is embedded at archive-relative
`+0x434`; because the archive begins at `ULinkerLoad+0xa4`, the enclosing
linker fields are:

```text
ULinkerLoad +0x4d8   Data   (archive +0x434)
ULinkerLoad +0x4dc   Num    (archive +0x438)
ULinkerLoad +0x4e0   Max    (archive +0x43c)
```

The body reads the old `Num`, increments and stores `Num`, grows with
`FArray::Realloc` (element size 4) when the new count exceeds `Max`, and writes
the loader pointer to `Data[oldNum]`. It does not search for or deduplicate an
existing pointer.

The growth arithmetic is visible inline at `0x10162c36`–`0x10162c4d`. For a
positive new count `n`, the body stores `Num = n`, computes and stores
`Max = n + trunc(3*n/8) + 0x20`, then calls `FArray::Realloc` with element size
`4`. This ordering is part of the contract: `Num` and `Max` are already
updated when the allocator service is entered. The initial `Data`, `Num`, and
`Max` values are supplied by the native object allocation/initialization path;
this body does not initialize them.

After appending, the body derives the enclosing linker as
`archive - 0xa4`. The two stores at `0x10162c6a` and `0x10162c73` are:

```text
FLazyLoader +0x04 = embedded archive pointer (ULinkerLoad +0xa4)
FLazyLoader +0x08 = archive->Tell()
```

The Tell call is the concrete body `0x10163110`, which reads the file reader
from `archive+0x440` (`ULinkerLoad+0x4e4`) and dispatches reader vtable slot
`+0x28`. Therefore the two fields used by `FSoundData` are established by the
original Attach call: `FSoundData+0x04` retains the embedded archive pointer,
and `FSoundData+0x08` records the reader position **before** the Sound helper
seeks to the lazy data range. Attach does not call an underlying reader Attach
method.

The call order for a package-version-68 `USound` follows Engine helper body
`0x10371140`: raw-read the four-byte absolute lazy end through archive slot
`+0x04`, call archive slot `+0x38` (the body above), then call archive slot
`+0x34` with that end. The saved position in `FSoundData+0x08` is consequently
the Tell result at the Attach point, not the absolute end passed to Seek.

## Detach membership and clearing

`0x10162dd0` receives the same embedded archive pointer and loader pointer. It
walks the current `Data[0..Num)` array at archive-relative `+0x434` (the
enclosing linker `+0x4d8`), comparing each
entry with the argument. On a match it decrements the loop index and calls
`FArray::Remove` (`0x10101573`) with:

```text
index = matching element index
count = 1
element size = 4
```

The index adjustment causes the loop to continue at the shifted element, so
all duplicate occurrences are removed. After the walk it compares the number
removed with one. If the result is not exactly one (including no match or
duplicates), it logs the native `Detachment inconsistency: %i (%s)` message
from `0x101b0f44`; it still performs the final field clearing:

```text
FLazyLoader +0x04 = 0
FLazyLoader +0x08 = 0
```

Detach does not call the reader's Detach slot and does not free the loader
object. The original base Detach no-op is therefore not a valid model for a
`ULinkerLoad`-backed Sound resource.

`FArray::Remove` itself receives `(index, 1, 4)` at `0x10162e82`–`0x10162e89`.
Its visible helper body (`0x101454f0`) shifts the tail, publishes
`Num -= 1`, and shrinks only when `3*newNum < 2*oldMax` and either
`oldMax-newNum > 0x40` or `newNum == 0`; a shrink publishes `Max = newNum`
before calling `Realloc(4)`. The linker binding leaves those data movement and
allocator calls as explicit services, so a host cannot silently replace them
with an array splice or an implicit allocation.

## Detach all: the linker's destruction

`ULinkerLoad::Destroy` (the UObject vtable `0x1017a490`, slot `+0x24`: body
`0x10162730`) runs in PurgeGarbage's first pass for a linker the collection
unloads. Unless `ULinkerLoad+0xd0` has `0x2000` it logs `Unloading: %s` with
the root's full name, then calls `DetachAllLazyLoaders(0)` (thunk `0x101012df`,
body `0x10162f80`), then `DetachExport(i)` (`0x101022b6`) for every export whose
object is non-null, removes itself from `GObjLoaders`, deletes its reader and
calls `UObject::Destroy`.

`0x10162f80` takes `this` = the linker and one argument, `Load`:

```text
for (i = 0; i < LazyLoaders.Num; i++)          ; Num (+0x4dc) reread each pass
    loader = LazyLoaders(i)
    if (Load) loader->vtable[0]()              ; FLazyLoader::Load
    loader +0x04 = 0                           ; SavedAr
    loader +0x08 = 0                           ; SavedPos
LazyLoaders: an empty element loop, Num = 0, Max = 0, Realloc(4)
```

No `Remove` and no log happen. With `Load` 0 (the destroy path) every loader
still attached to the linker keeps its storage but loses its archive, so when
PurgeGarbage's second pass destroys that loader's owner its destructor finds a
null `SavedAr` and does not call `DetachLazyLoader` ([mesh
destruction](mesh-destruction.md)). `detachAllLinkerLazyLoaders(archive, load)`
translates the body; a nonzero `load` needs the loaders' Load virtual as an
explicit `loadLazyLoader` service. `native-linker-lazy-loader-oracle.py`'s
`detach-all` case runs the original body over `[A, B, A]` (Max 5): both loaders
end with zero fields, the array with Num 0, Max 0 and one `Realloc(4)`.

## Reader forwarding and load/seek behavior

The custom archive's raw and position methods all use the reader pointer at
`archive+0x440`:

* `0x10163310` loads the reader, pushes the caller's buffer and length, and
  dispatches reader slot `+0x04`; it returns with `ret 8`.
* `0x10163110` dispatches reader slot `+0x28` and returns its position.
* `0x10163070` pushes the requested position and dispatches reader slot
  `+0x34`.
* `0x101631b0` dispatches reader slot `+0x2c` for total size.

The vtable slot at `+0x10` is `FArchive::Preload(UObject*)`, whose body is
`0x10162000`. Its parameter is a `UObject*`: the observed accesses at
`+0x10`, `+0x14`, `+0x1c`, and `+0x28` are UObject layout fields. It is not a
lazy-loader `Load` callback. This note does not model that call or any of its
branches; earlier interpretations of those accesses as `FLazyLoader` fields,
including a clear-flag branch, are withdrawn.

The linker teardown body at `0x10162730` closes the reader after its linker
work: it reads `ULinkerLoad+0x4e4`, if non-null calls the reader vtable slot
zero with argument `1`, writes `ULinkerLoad+0x4e4 = 0`, and then calls the
UObject destroy path. This confirms the reader pointer's owning lifetime. The
reader class and the body behind `GFileManager`'s slot zero are not exported
by this Core image, so their concrete vtable and file/async error behavior are
not claimed here.

## Boundaries for a browser host

The recovered evidence authorizes a host binding with one canonical embedded
linker archive identity, an explicit reader service for raw bytes/Tell/Seek/
TotalSize, and a per-linker lazy-loader array with the exact append,
remove-all, field-write, and mismatch-log behavior above. It does not authorize
using the base `FArchive` no-op vtable, a generic archive object, or a guessed
reader implementation.

The bounded implementation in `src/runtime/script-linker-lazy-loader.mjs`
exposes `createLinkerLoadArchive({linker, reader, array, logName, services})`.
The returned object is branded as the concrete embedded archive and carries
vtable `0x1017a430`; only that identity is accepted by
`attachLinkerLazyLoader(archive, loader)` and
`detachLinkerLazyLoader(archive, loader)`. Growth requires
`services.arrayRealloc(array, 4, details)`, removal requires
`services.arrayRemove(array, index, 1, 4, details)`, Tell requires
`services.readerTell(reader, details)` (or the explicitly named `tell`
fallback), and a mismatch requires `services.log(archive, details)`. The
services own storage allocation and data movement, while the module enforces
the native field-write order and validates the resulting `Num` values.

The native mismatch path passes the linker's stored filename data to Logf (or
the static fallback at `0x101ef654`); it does not call `UObject::GetFullName`.
An optional host `getFullName` service is therefore diagnostic metadata only
and is never invoked by Attach or Detach. The focused oracle and validator
exercise an empty growth, an in-capacity append, duplicate removal, and
missing membership.

The following remain outside this note: the reader's concrete class and
constructor flags, the linker name/object mapping operators, the complete
`FLazyLoader` virtual interface, audio-device playback, and any save-side
archive mode. A browser implementation should report those reached branches
as unsupported until their original bodies or a reproducible original
measurement is available.
