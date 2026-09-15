# Core `UObject::StaticLoadObject` existing and bounded first-load paths

This is the source-first contract for the ordinary preloaded-linker path and
the bounded first-load linker construction used by the portrait wrapper.  The
authority is the installed GOTY
`Core.dll`, SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`.
Disassembly is in `.cache/research/Core.asm`; the original binary remains
outside Git.

## Direct body and call order

The public thunk `0x10102a1d` jumps to
`UObject::StaticLoadObject` at `0x10154d50`.  Its cdecl arguments are, in
order, `Class`, `InOuter`, `Name`, `Filename`, `LoadFlags`, and `Sandbox`.
For a non-null class and name, the body performs this sequence:

1. Call `BeginLoad` through thunk `0x10103328`.
2. Call `ResolveName(&Outer, &Name, Create=1, Throw=1)` through
   `0x10102c34`.
3. Walk `Outer + 0x18` to its package/root object.
4. Unless `LoadFlags & 0x40` is set, call
   `GetPackageLinker(rootOuter, Filename, LoadFlags | 0x28, Sandbox,
   Guid=null)` through `0x10101591`.
5. When a linker is returned, construct `FName(Name, EFindName=1)` through
   `0x10102e96`, then call the linker export resolver through `0x10102a72`.
   A first-load linker is constructed and published before this same step.
6. If that resolver returns null, call
   `StaticFindObject(Class, Outer, Name, ExactClass=0)` through `0x1010326a`.
   If that also fails, the body reaches its error path and still calls
   `EndLoad`.
7. Call `EndLoad` through `0x10102f27` and return the resolver/fallback
   pointer (or null).

The body does not test the boolean returned by `ResolveName`; it uses the
holders after the call.  A host service must therefore preserve the original
holder writes and leave reached failure behavior explicit rather than silently
substituting a different path.

`LoadFlags=2` takes the linker branch because bit `0x40` is clear.  The
observed `GetPackageLinker` flags are consequently `0x2a` (`2 | 0x28`).  The
probe does not generalize the meaning of other load-flag bits; bit `0x40` is
the only predicate needed for this route.

## Nested and empty outermost load lifecycle

The `BeginLoad` thunk `0x10103328` jumps to body `0x10155410`.  The
`EndLoad` thunk `0x10102f27` jumps to body `0x10155510`; these are distinct
bodies.  `BeginLoad` increments Core global `0x102a2650`, and only enters its
outermost checks when the resulting value is `1`.  `EndLoad` decrements the
same counter and only enters its cleanup walk when the resulting value is
`0`.

The nested probe initializes the counter to `1`, so the calls execute the
original counter gates (`1 -> 2 -> 1`) without reaching the outermost graph.
For an outermost call, the original body performs the following recovered
checks and writes:

1. `BeginLoad` checks `GObjLoaded.Num` at `0x1029e63c` and the registration
   queue head at `0x102a265c`; nonzero values reach their native
   `appFailAssert` calls.  It then loops `GObjLoaders` at
   `0x1029e608`/`0x1029e60c` and asserts that each linker has a non-null
   pointer at `linker + 0x90`.  No reader virtual is called by this check.
2. `EndLoad` logs through `FOutputDevice::Logf` thunk `0x10102a95` with
   `GWarn` (`0x101a7c3c`), `EName=0x308`, and format pointer `0x101af3d4`.
3. It walks the `GObjLoaded` array at data/count
   `0x1029e638`/`0x1029e63c`.  Each reached object whose flags at `+0x1c`
   contain the native post-load bit is sent to its `ConditionalPostLoad`
   virtual; an empty array skips that walk.
4. It writes both `GObjLoaded.Num` and `GObjLoaded.Max` (`0x1029e640`) to zero,
   then calls `FArray::Realloc` through `0x10101753` to body `0x10145440`
   with element size `4`.  The empty fixture still reaches the allocator
   boundary with old data `0`, byte count `0`, and tag pointer `0x101ab50c`.
5. If the cleanup state at `0x102a2658` is zero, the linker cleanup loop is
   skipped and the body writes that state back to zero.  A nonzero state
   enters a loader loop reading each linker at `+0x7c` and `+0x78`; that
   mutation graph remains unsupported here.

The native probe now runs both cases.  Its outermost fixture starts with
`GObjLoaded.Num=0`, an empty registration queue, `G_LOAD_STATE=0`, and
`G_LOAD_NEST=0`, while retaining the preloaded `DeusExConText` linker/export.
It observes `BeginLoad` `0 -> 1`, the empty checks above, then `EndLoad`
`1 -> 0`, `Logf`, and the original `FArray::Realloc` body before the final
state write.  The JavaScript helper implements this empty branch only when
the host supplies `loadedObjects`, `loaders` with a readable `reader` field,
`registrationQueueHead: null|0`, `loadedMax`, `loaderCleanupState: 0`, a
`logReceiver` plus synchronous `logEndLoad`, and synchronous `reallocLoaded`
services.  These services are required so omitted output/allocator behavior
cannot become an inferred no-op.  Nonempty `GObjLoaded` post-load dispatch and
nonzero linker cleanup remain explicit boundaries.

## Already-loaded `GetPackageLinker` path

`GetPackageLinker` body `0x10154530` scans the loader array at data/count
`0x1029e608`/`0x1029e60c` before any package-file lookup.  A candidate linker
matches when `candidate + 0x28 == rootOuter`; the body retains that candidate
and proceeds to its normal post-lookup checks.  With `Filename=null`,
`Sandbox=null`, and `Guid=null`, a matching candidate returns without reaching
`appFindPackageFile`, package creation, or file reads.  It still copies the
current package-extension string from `0x102a26dc` into a local buffer through
`appStrcpy` (`0x10102432` -> `0x10123580`).

If no matching linker exists, the body enters the file path below. The null-root
filename route can now reach an existing package/linker through explicit file
and package services. A non-null resolved root may bind the exact synchronous
`ULinkerLoad` constructor described below; optional sandbox virtual dispatch
and localized file/error handling remain unsupported. An existing-linker result
must not be replaced with a name-only cache lookup.

## Bounded first-load `ULinkerLoad` construction

The native constructor thunk `0x10101f91` enters the `ULinkerLoad` body at
`0x10160000`. Its embedded `FArchive` starts with base vtable `0x101751f8`
and is replaced by the concrete linker archive vtable `0x1017a430`; the
constructor initializes archive `Version=0x44`, `LicenseeVersion=0x44c`, and
stores the package reader at linker offset `+0x4e4`. The reader must be live
before the linker is published to `GObjLoaders`, because the reached
`BeginLoad` check reads each loader's native reader field at `+0x90` in the
captured layout.

The browser adapter exposes this as a synchronous
`createLinkerLoad({root,filename,flags,sandbox,guid})` service. It returns one
canonical `ULinkerLoad` whose `outer` is the `ResolveName` package root and
whose reader is non-null; `StaticLoadObject` publishes that exact identity to
the live loader array and then continues `FName` → `FindExportIndex` →
existing `CreateExport` → `EndLoad`. The focused `InfoPortraits.JaimeReyes`
route prepares the package bytes and canonical export/resource identity
asynchronously, but defers linker construction until this native boundary.
The adapter does not infer a null-export constructor, native metaclass
registration, nonempty `GObjLoaded` post-load dispatch, or nonzero linker
cleanup from this first-load result; each remains an explicit unsupported
branch.

## Export identity and existing object return

### Filename with an existing package/linker

The speech-audio caller supplies a simple object name, null Outer, and a
filename. After the initial null-Outer scan is skipped, GetPackageLinker
calls `appFindPackageFile(Filename,Guid,localBuffer)` at `0x101546c1`.
On success it copies the **input Filename**, not the resolved search output,
into a second 256-TCHAR local buffer at `0x101546f8`. The parsing loop tests
backslash, slash, then colon in that order. Each found separator is scanned
again before the cursor advances past it and restarts the loop. Once none
remain, it scans for a dot and, when present, scans again and terminates the
buffer at that first dot (`0x1015478b`). It calls
`CreatePackage(NULL,stem)` at `0x10154793`.

With the caller's root still null and the package return non-null, the body
copies that package into its local Outer and rescans GObjLoaders at
`0x101547c2`. A matching already-loaded linker then reaches the ordinary
sandbox/GUID gates and returns, without linker allocation. The filename route
does not make the package-extension copy used by the initial linker hit.

`native-static-load-filename-oracle.py` executes the unchanged outer
StaticLoadObject, filename parsing, second loader scan, export lookup and
existing-object return. It uses `Mission00` and `..\\System\\DeusExConText.u`
with explicit successful file-search and existing-package services, alongside
the existing name/CRT leaves. The trace establishes the extra calls and
preserves nested BeginLoad/EndLoad. Failed file search/localized errors,
missing package/linker construction, a non-null initial root requiring reset,
sandbox checks and GUID validation remain explicit unsupported branches.
The host rejects a filename exceeding the recovered scratch capacity.

The internal resolver thunk `0x10102a72` jumps to the linker resolver body
`0x10161cc0`, which calls the `FindExportIndex` hash helper at
`0x1010191a`/`0x10161e00` with:

```
(Class.NameIndex, Class.Outer.NameIndex, requestedNameIndex, -1)
```

`FindExportIndex` computes the 256-entry bucket as
`(className * 7 + classOuterName * 31 + requestedName) & 0xff`, with class
outer name `0x18` normalized to `0x17`.  It follows each export record's
`+0x20` hash link, requires record `+0x0c` to match the requested name, accepts
record `+0x08` when it equals the requested outer or the **requested outer**
is `-1`, and then resolves the record's
class identity through either the export table or the import table.  Export
records are 0x24 bytes at `linker + 0x84`. At `0x10161e7e` the original loads
the requested argument into ECX; `0x10161e88` compares that ECX with `-1`.
The wildcard is not a special value in the export record.

On a matching export, `FindExportIndex` returns its index.  The resolver calls
`CreateExport` (`0x101012fd` -> `0x1012e230`) with that index.  `CreateExport`
first reads `exportRecord + 0x1c`; if it is already non-null, it returns that
object immediately.  The constructor, `SetLinker`, `GObjLoaded.Add`, logging,
and post-load work are skipped on this path.  A null export pointer is the
separate construction path and requires the full native object lifecycle.

The null-export branch has now been followed through the original instructions
and wired: the resolver body at `0x10161cc0` forwards a hash-matched index to
`CreateExport` and returns its result directly, so the module routes every
matched export through the `createExport` service and refuses an absent
`_Object` unless that service is the recovered `ULinkerLoad::CreateExport`
body (`0x1012e230`) bound by `linkerCreateExport`.  That body resolves
`ClassIndex` through `IndexToObject`, calls the linker archive's `Preload`
virtual at slot `+0x10`, resolves `Outer`, and calls `StaticConstructObject`
at `0x10157ff0` with `(ExportFlags & 0x067f0025) | 0x01000200`; after
construction it writes the export's object field, calls `SetLinker`, adds the
object to `GObjLoaded`, logs, and invokes the class-chain virtual at slot
`+0x5c`.  Each of those remains a host service the caller must bind — the
module substitutes nothing.  A null `CreateExport` result (the context-flag
or `NAME_Camera` gate) falls back to `StaticFindObject` exactly as a missed
export does.  `Preload` at `0x10162000` is still the boundary that serializes
a constructed export's own bytes; it remains an explicit host service until
that body is separately recovered.

The focused fixture uses a negative class import index to exercise the actual
import-name walk as well as the hash hit.  Its import records are 0x1c bytes at
`linker + 0x78`: for class index `-1`, record 0 `+0x08` supplies outer import
index `-2`, record 1 `+0x0c` supplies the `ConSys` package name, and record 0
`+0x0c` supplies `ConversationList`.  These values are local fixture FName
indices; they prove the native traversal and do not claim particular global
GNames indices for a browser runtime.

## Probe and service boundary

[`native-static-load-object-oracle.py`](../scripts/native-static-load-object-oracle.py)
executes `0x10154d50` from the hash-checked Core image.  It records the direct
entry points and services, and runs the original `GetPackageLinker`,
`FindExportIndex`, existing-object `CreateExport`, empty outermost lifecycle,
and allocator call instructions.  Its successful cases are:

```
StaticLoadObject(ConSys.ConversationList, null,
                 "DeusExConText.Mission00", null, 2, null)
 -> DeusExConText.Mission00

StaticLoadObject(ConSys.ConversationList, null,
                 "DeusExConText.Mission00", null, 2, null)
 [with GObjLoaded.Num=0 and G_LOAD_NEST=0]
 -> DeusExConText.Mission00, G_LOAD_NEST=0
```

The three explicit services have narrow contracts:

- `ResolveName` receives holder pointers and `(Create=1, Throw=1)`, resolves
  the dotted path to the already loaded `DeusExConText` package, and writes the
  tail pointer `Mission00` back to the name holder.
- `FName(const TCHAR*, EFindName)` receives `Mission00` and mode `1`, and
  supplies the fixture's existing name index.  Name-table interning and global
  FName identity belong to the host name service.
- `appStrcpy` copies the package-extension TCHAR buffer used by the existing
  linker path.
- `createLinkerLoad({root,filename,flags,sandbox,guid})` is the optional
  synchronous first-load constructor edge. It must return the canonical
  `ULinkerLoad` with `outer===root` and a non-null reader; the helper publishes
  it before export resolution. Its archive/file allocation follows the
  measured constructor contract above and is not fabricated by this module.

The probe initializes loader data/count and the load nest explicitly, then
lets the original native package lookup, hash walk, export return, and
outermost counter gates run.  It patches only the reached `ResolveName`, FName,
appStrcpy, `Logf`, and FMalloc virtual edges.  `GetPackageLinker`, the export
resolver, `CreateExport`, `BeginLoad`, `EndLoad`, and `FArray::Realloc` bodies
remain original instructions.

The live Training capture in `.cache/stage3-live-training-20260912.txt`
independently reports `nest=0`, `GObjLoaded.Num=0`, and 40 loaded linkers.  Its
`DeusExConText` linker contains the existing `ConList_Mission00` export and
object, matching the already-loaded condition exercised by the probe.  The
capture is local evidence and remains outside Git.

Run it with:

```sh
.cache/native-probe-env/bin/python \
  scripts/native-static-load-object-oracle.py "Deus Ex GOTY Edition"
```

The browser's `DynamicLoadObject` graph now supplies the six original
arguments, name/string leaves, canonical package identities, rebuilt linker
hash/import tables, existing export pointers, and the empty outermost
`GObjLoaded` lifecycle. `InfoPortraits.JaimeReyes` reaches the synchronous
first-load constructor after `ResolveName`; direct and grouped exports that
are explicitly prepared retain the existing-linker path. The graph remains a
focused initialized fixture rather than the captured 40-entry native loader
array. The nonempty `ConditionalPostLoad` graph, nonzero linker cleanup,
first-load file search, `StaticFindObject` fallback, and sandbox/GUID
behavior remain unsupported until each native graph is separately bound.
Null-export construction and native metaclass loading are bound only through
the recovered `CreateExport` body: `scripts/validate-static-load-createexport.mjs`
drives an absent `DeusEx.u` class export from `staticLoadObject` into it.
See [the native wrapper and live integration](script-dynamic-load-object.md).

## Conversation binding integration

[`validate-conversation-binding.mjs`](../scripts/validate-conversation-binding.mjs)
uses the runtime's canonical `ConSys.ConversationList` class/package and
`DeusExConText.ConList_Mission00` export identities. Its initialized linker
fixture derives the target export and negative class-import name reads from the
original package tables, checks the computed hash bucket, and returns the same
prepared list through `staticLoadObject` on every `ConBindEvents` call. The
package table's root `Outer=0` is retained in the linker record; the native
resolver passes `requestedOuter=-1` as the wildcard. Its `ResolveName` leaf
uses the recovered ordinary resolver; the existing-package `CreatePackage`
adapter performs the nested `(Create=1, Throw=0)` call and resolves the explicit
Core.Package registry hit, with no allocation fallback. Each call exercises the empty outermost
`BeginLoad`/`EndLoad` `0 -> 1 -> 0` path, including explicit `Logf` and
`FArray::Realloc` services, before native `ConListItem` construction/purge.
This is an initialized loader fixture and does not claim full live
Play/bootstrap loading.
