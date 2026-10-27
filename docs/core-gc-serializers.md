# GC branch of the remaining Core Serialize bodies

Collector branch of `UFunction`, `UEnum`, `UConst`, `UTextBuffer`, `UPackage`,
`ULinker`, `ULinkerLoad` (and `ULinkerSave`) `Serialize(FArchive&)` in the
GOTY `Core.dll`. Method and conventions follow
`docs/script-class-serialization.md` (UField/UStruct/UState/UClass).

```
Core.dll SHA-256  8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4  (re-hashed 2026-10-26)
sources           .cache/reference/Core-annotated.asm (Intel), Core-rng.asm (AT&T);
                  vtable words read straight from the DLL's .rdata
collector ctor    0x1015eac0, vtable 0x1017a2f0
collector words   +0x04 = 0x44 (version), +0x08 = 0x44c,
                  +0x0c/+0x10/+0x14/+0x18 = 0, +0x1c/+0x20/+0x24 = 1
```

## Collector archive slots these bodies use

Read from vtable `0x1017a2f0` in the DLL:

| slot | thunk | body | meaning in the collector |
| --- | --- | --- | --- |
| `+0x04` | `0x1010212b` | `0x10106760` `ret 8` | `FArchive::Serialize(void*,INT)` raw bytes: no-op |
| `+0x10` | `0x101011cc` | `0x101068e0` `ret 4` | `Preload`: no-op |
| `+0x14` | `0x10101186` | `0x10106900` `ret 8` | `CountBytes(Num,Max)`: no-op |
| `+0x18` | `0x101031a7` | `0x1015ec90` | `UObject*&` mark (see `docs/script-gc.md`) |
| `+0x1c` | `0x10102360` | `0x1015ee00` | `FName&` mark: `and [Names[idx]+4], ~2`; returns `this` |

The object operator takes a mutable `UObject**` and writes null back only on
the `0x400` archive exclusion. Every object slot listed below is therefore a
mutable holder, not a read-only value. The name operator never writes the
holder.

The raw and CountBytes slots are `ret` no-ops in this binary, so raw and
CountBytes operations below are reported for trace completeness only. They
cannot mark anything.

### Shared helpers on the GC path

| helper | thunk → body | GC behaviour (collector words) |
| --- | --- | --- |
| `FArray::CountBytes(Ar, ElemSize)` | `0x101016db → 0x10107240` | `Ar+0x14 (Num*ElemSize, Max*ElemSize)`, with Num at array `+4` and Max at `+8` |
| `operator<<(FArchive&, FCompactIndex&)` | `0x10102950 → 0x10159b50` | `Ar+0x0c == 0 && Ar+0x10 == 0` → one raw `Ar+0x04(&I.Value, 4)` and return (no variable-length encoding) |
| `operator<<(FArchive&, FString&)` | `0x10101640 → 0x101459b0` | see below |
| `operator<<(FArchive&, TArray<FName>&)` (not exported; named by behaviour) | `0x10101997 → 0x1011e120` | see below. This is the same helper the UClass doc uses for package imports at `+0x4c8` |

CountBytes argument order: every site in this note pushes `Max*size` first
and `Num*size` second, so the call is `CountBytes(Num*size, Max*size)`. This
matches the existing doc's `CountBytes(count*12, max*12)`.

**FString operator (`0x101459b0`)**, GC path:

1. `FArray::CountBytes(Ar, 2)`, i.e. `Ar+0x14(Num*2, Max*2)` (`0x101459e1`).
2. It computes `SaveNum` by scanning the characters up to the NUL. An empty
   string (Num 0) scans the static `""`. The result is `Num` if every
   character is `<= 0xff`, otherwise `-Num` (`0x101459e6–0x10145a11`).
3. `FCompactIndex` on the stack temporary `SaveNum` (raw 4 in GC, `0x10145a19`).
4. `Ar+0x0c == 0` → save path `0x10145ab4`. If `SaveNum >= 0`, it does one
   raw `Ar+0x04(&tmp, 1)` per character for `i < Num`. Each character is
   copied to a stack byte and becomes `0x7f` if it is `>= 0x100`. If
   `SaveNum < 0`, it does one raw `Ar+0x04(&tmp, 2)` per character. Then it
   returns.

   The load path (`0x10145a2f–0x10145aa1`: Realloc, per-character read, and
   `Empty` when Num == 1) is not reachable with `Ar+0x0c == 0`.

No object or name reference. All raw writes go to stack temporaries.

**TArray<FName> operator (`0x1011e120`)**, GC path:

1. `Ar+0x14(Num*4, Max*4)` (`0x1011e163`).
2. `Ar+0x0c == 0` → `0x1011e1de`. `FCompactIndex` runs on the array's own
   `Num` word (array `+4`); in GC that is a raw 4 on that lvalue.
3. `for (i = 0; i < Num; i++)` it calls the name operator `Ar+0x1c` on
   `&Data[i]` (array `+0`, stride 4). Num is re-read from array `+4` on every
   iteration.

   The load path (`0x1011e16d–0x1011e1dc`, which does Realloc and grows)
   is not reachable.

## Which body the collector reaches (vtable `+0x28`)

The collector's object operator dispatches `vtable+0x28` on the object's
primary vptr. Slot words read from the DLL:

| class | primary vtable | `+0x28` thunk | body |
| --- | --- | --- | --- |
| UFunction | `0x10175738` | `0x10101a7d` (export) | `0x10129010` |
| UEnum | `0x10175878` | `0x101033a5` (export) | `0x10159a20` |
| UConst | `0x101759c8` | `0x101029b9` (export) | `0x10129680` |
| UTextBuffer | `0x10175548` (`??_7UTextBuffer@@6BUObject@@@`) | `0x10103166` (export, FArchive overload) | `0x101598a0` |
| UPackage | `0x101753a0` | `0x10102ce3` (export) | `0x1015a470` |
| ULinker | `0x10176684` | `0x10101c67` (export) | `0x1011df90` |
| ULinkerLoad | `0x1017a490` (no symbol in the listing) | `0x10101c71` (no export) | `0x10162670` |
| ULinkerSave | `0x1017a154` (no symbol in the listing) | `0x10101c67` = ULinker's | `0x1011df90` (no override) |

Where the vtables come from:

- **UTextBuffer.** The secondary `FOutputDevice` vptr `0x10175544` is
  written at object `+0x28` by every site in the listing that writes the
  UTextBuffer vptrs (`0x1010e0c8`, `0x1010e2bc`, `0x1015975b`,
  `0x1015a99a`). That table's
  single slot is `0x10102c02` (the `Serialize(const TCHAR*, EName)`
  overload). The collector never uses it.
- **ULinkerLoad.** The vtable `0x1017a490` is written at `0x10160182`
  (constructor `0x10160000`), `0x1015ff82` and `0x10120748`. The embedded
  archive vptr `0x1017a430` goes to `+0xa4`.
- **ULinkerSave.** The vtable `0x1017a154` is written by its
  InternalConstructor `0x10101ad7 → 0x10163b10` (at `0x10163c04`), by the
  inline construction inside `SavePackage` (thunk `0x101031e8` → body
  `0x10155980`; no other function prologue lies between that body and the
  write at `0x10155d69`), and at `0x10164498`.
  The class registration at `0x10159ee4` uses `PrivateStaticClass`
  `0x1029c7d8` (`autoclassULinkerSave` `0x1029c7d4`), Super `ULinker`, and
  size `0xec`.

## UFunction

Thunk `0x10101a7d` → body `0x10129010`. Its Super chain is a direct call to
`UStruct::Serialize` (`0x10102b5d → 0x10126fe0`), which runs `UField` and then
`UObject`.

Field offsets come from the body. The names match the DX SDK 1112f
`UnClass.h` (a research reference only):

| offset | width | field |
| --- | ---: | --- |
| `+0x6c` | 4 | FunctionFlags |
| `+0x70` | 2 | iNative |
| `+0x72` | 2 | RepOffset |
| `+0x74` | 1 | OperPrecedence |
| `+0x75` | 1 | NumParms |
| `+0x76` | 2 | ParmsSize |
| `+0x78` | 2 | ReturnValueOffset |
| `+0x7c` | 4 | `Func` (native member-function pointer) |

GC operations after UStruct, in order:

1. Version `cmp [Ar+4], 0x3f; jg` (`0x10129046`). The collector version is
   `0x44 > 0x3f`, so this skips raw 2 `+0x76` (ParmsSize).
2. Raw 2 at `+0x70` (iNative), `0x10129062`.
3. A version gate (`0x10129065`) skips raw 1 `+0x75` (NumParms).
4. Raw 1 at `+0x74` (OperPrecedence), `0x10129082`.
5. A version gate (`0x10129085`) skips raw 2 `+0x78` (ReturnValueOffset).
6. Raw 4 at `+0x6c` (FunctionFlags), `0x101290a2`.
7. `test byte [+0x6c], 0x40` (`FUNC_Net`, `0x101290a5`). If set, raw 2 at
   `+0x72` (RepOffset), `0x101290b4`. The test reads the live FunctionFlags,
   because the raw call before it is a no-op.
8. `[Ar+0x0c] == 0` (`0x101290b7`) → epilogue `0x1012918d`. The loading
   block `0x101290c2–0x1012915c` is not reached. That block clears NumParms,
   ParmsSize and ReturnValueOffset, then rebuilds them by walking `Children`
   (`+0x38`) for `CPF_Parm` (`0x80`) / `CPF_ReturnParm` (`0x400`) properties.

| branch | selector | collector side |
| --- | --- | --- |
| three `Ver <= 0x3f` raw reads | archive word `+0x04` (signed `jg`) | skipped, because 0x44 > 0x3f |
| loading recompute | archive word `+0x0c` | skipped (0) |
| RepOffset | object content (`FunctionFlags & 0x40`) | either way; inert, because raw is a no-op |

**Adds beyond UStruct:** raw data only, with no object or name reference.
`Func` at `+0x7c` is never touched. Virtual `+0x7c` (SerializeExpr, used
inside UStruct's bytecode loop) is `0x1010281f` in UFunction's table, the
same slot value as UStruct's (`0x10175698+0x7c`). Bytecode reference visits
for functions are therefore exactly UStruct's.

## UEnum

Thunk `0x101033a5` → body `0x10159a20`. Its Super chain is a direct call to
`UField::Serialize` (`0x10101d8e → 0x10125c70`), which runs `UObject`. Visits
of `+0x28`/`+0x2c` are as documented for UField.

GC operations after UField:

1. `operator<<(Ar, TArray<FName>&)` on `+0x34` (`Names`), at `0x10159a5b`:
   - `Ar+0x14(Num*4, Max*4)`, with Num at `+0x38` and Max at `+0x3c`.
   - Raw 4 on the Num word `+0x38` (FCompactIndex, GC branch).
   - For each `i < Num`: the name operator `Ar+0x1c` on `Data(+0x34)[i]`.

There are no branches of its own; the helper's `Ar+0x0c` branch is taken
as described above.

**Adds beyond UField:** no object references. It adds one name reference per
enum entry. These are FName marks (they clear name-table bit 2), not
reflected properties.

## UConst

Thunk `0x101029b9` → body `0x10129680`. Its Super chain is a direct call to
`UField::Serialize` (`0x10101d8e`).

GC operations after UField:

1. `operator<<(Ar, FString&)` on `+0x34` (`Value`), at `0x101296b8`.

   This does `Ar+0x14(Num*2, Max*2)` with Num at `+0x38` and Max at
   `+0x3c`. It then does one raw 4 on a stack copy of SaveNum, and one
   raw 1 or raw 2 per character from stack temporaries.

There are no branches beyond the FString helper's.

**Adds beyond UField:** plain data only (CountBytes and no-op raw calls), with
no object or name reference.

## UTextBuffer

Thunk `0x10103166` → body `0x101598a0`. Its Super chain is a direct call to
`UObject::Serialize` (`0x1010178f → 0x10150210`).

The layout has the `FOutputDevice` vptr at `+0x28` (from the constructor),
then `Pos +0x2c`, `Top +0x30` and `Text` (FString) `+0x34..+0x3f`.

GC operations after UObject:

1. Raw 4 at `+0x2c` (Pos), `0x101598e0`.
2. Raw 4 at `+0x30` (Top), `0x101598ed`.
3. `operator<<(Ar, FString&)` on `+0x34` (Text), `0x101598f5`. This does
   `Ar+0x14(Num*2, Max*2)` from `+0x38` and `+0x3c`, then raw stack
   temporaries.

There are no branches of its own.

**Adds beyond UObject:** plain data only, with no object or name reference.

## UPackage

Thunk `0x10102ce3` → body `0x1015a470`. The body is only
`UObject::Serialize(Ar)` (`0x1015a49c`) inside guard/unguard.

**Adds beyond UObject:** nothing. The DX SDK fields `DllHandle`,
`AttemptedBind` and `PackageFlags` are not visited, and none of them is an
object. A package does not reference its linker from this body. The edge
runs the other way: `ULinker+0x28` points at the package.

## ULinker

Thunk `0x10101c67` (export) → body `0x1011df90`. Its Super chain is a direct
call to `UObject::Serialize` (`0x1010178f`). That call visits Name, Outer,
Class and Linker, then runs SerializeBin, per
`docs/script-object-serialization.md`.

Layout, from the body plus the DX SDK `UnLinker.h` (sizes checked against
the 28 and 36 multipliers in the body):

| offset | field |
| --- | --- |
| `+0x28` | `LinkerRoot` (`UObject*`) |
| `+0x2c..+0x6b` | `Summary` (FPackageFileSummary, 0x40) |
| `+0x6c/+0x70/+0x74` | `NameMap` Data, Num, Max |
| `+0x78/+0x7c/+0x80` | `ImportMap` Data, Num, Max (FObjectImport, 0x1c bytes) |
| `+0x84/+0x88/+0x8c` | `ExportMap` Data, Num, Max (FObjectExport, 0x24 bytes) |
| `+0x90` | `Success` |
| `+0x94` | `Filename` |
| `+0xa0` | `_ContextFlags` |

The import entry is ClassPackage `+0x00` (FName), ClassName `+0x04` (FName),
PackageIndex `+0x08`, ObjectName `+0x0c` (FName), XObject `+0x10`,
SourceLinker `+0x14`, SourceIndex `+0x18`.

The export entry is ClassIndex `+0x00`, SuperIndex `+0x04`, PackageIndex
`+0x08`, ObjectName `+0x0c` (FName), ObjectFlags `+0x10`, SerialSize
`+0x14`, SerialOffset `+0x18`, `_Object` `+0x1c`, `_iHashNext` `+0x20`.

GC operations after UObject, in this exact order:

1. `Ar+0x14(ImportMap.Num*28, ImportMap.Max*28)` from `+0x7c`/`+0x80`
   (`0x1011dfe8`).
2. `Ar+0x14(ExportMap.Num*36, ExportMap.Max*36)` from `+0x88`/`+0x8c`
   (`0x1011e009`).
3. `operator<<(Ar, TArray<FName>&)` on `NameMap` `+0x6c` (`0x1011e011`):
   - `Ar+0x14(Num*4, Max*4)`.
   - Raw 4 on `+0x70`.
   - The name operator on each `NameMap[i]`.
4. **Object reference `+0x28` (`LinkerRoot`)** through `Ar+0x18`, on the
   archive the helper returned (`0x1011e021`).
5. For `i = 0 .. ExportMap.Num-1`, with Num re-read from `+0x88` every
   iteration: the name operator `Ar+0x1c` on `ExportMap[i]+0x0c`
   (ObjectName), at `0x1011e040`.
6. For `i = 0 .. ImportMap.Num-1`, with Num re-read from `+0x7c` every
   iteration:
   1. **Object reference `ImportMap[i]+0x14` (`SourceLinker`, typed
      `ULinkerLoad*`)** through `Ar+0x18` (`0x1011e067`).
   2. The name operator on `ImportMap[i]+0x00` (ClassPackage), at
      `0x1011e06f`.
   3. The name operator on `ImportMap[i]+0x04` (ClassName). It is called on
      the archive returned by the previous name call, which `0x1015ee00`
      returns as `this` (`0x1011e07a`).

There are no conditional branches, only the two loops.

**Not visited, explicitly:**

- import `+0x0c` ObjectName (a name);
- import `+0x10` **XObject** (an object pointer, not marked);
- export `+0x1c` **`_Object`** (an object pointer, not marked);
- Summary, including `Generations`, not even counted;
- `Filename`, `Success` and `_ContextFlags`.

**Adds beyond UObject:** two kinds of object edge, both native-only pointers.
ULinker is an intrinsic class with no script properties of its own, so a
reflected-property walk would miss both:

- `LinkerRoot +0x28`;
- each import's `SourceLinker +0x14`.

It also adds the name marks above. A live linker keeps its root package and
the linkers it imports from. It does not keep its exports or its resolved
imports.

## ULinkerLoad

Thunk `0x10101c71` (not exported) → body `0x10162670`. Its Super chain is a
direct call to `ULinker::Serialize` (`0x10101c67`).

GC operations after ULinker:

1. `Ar+0x14(LazyLoaders.Num*4, LazyLoaders.Max*4)` from `+0x4dc`/`+0x4e0`
   (`0x101626bb`). The array is Data `+0x4d8`, Num `+0x4dc`, Max `+0x4e0`,
   matching `docs/script-linker-lazy-loader.md`.

**Adds beyond ULinker:** CountBytes only. It never touches the lazy-loader
data at `+0x4d8`, the loader pointer at `+0x4e4` (an `FArchive*`), the
embedded archive at `+0xa4`, or the export hash. None of these is a UObject.

**ULinkerSave** has no override. Its `+0x28` is ULinker's thunk
`0x10101c67`, so its GC visit list is exactly ULinker's.

## Virtual calls and object-dependent dispatch

- Every Super call in these seven bodies is a direct `call` to an exported
  thunk, not a virtual call:
  - UStruct `0x10102b5d`;
  - UField `0x10101d8e`;
  - UObject `0x1010178f`;
  - ULinker `0x10101c67`.
- Every `call [reg+N]` in the bodies and helpers is on the archive's vtable.
  For the collector that is fixed at `0x1017a2f0` (`+0x04`, `+0x14`, `+0x18`,
  `+0x1c` above).
- The only object-dependent dispatch is:
  1. the collector's `vtable+0x28` entry, which selects the body (table
     above);
  2. inside the UStruct base for UFunction, virtual `+0x7c` SerializeExpr
     (`0x1010281f`, same as UStruct);
  3. inside `UObject::Serialize`, the class's `+0x70` SerializeBin
     (already documented).

## References a reflected-property walk would miss

These are native-only edges or name marks:

- **ULinker / ULinkerLoad / ULinkerSave:**
  - object `+0x28` LinkerRoot;
  - object `ImportMap[i]+0x14` SourceLinker;
  - names: NameMap `[i]`, `ExportMap[i]+0x0c`, `ImportMap[i]+0x00`,
    `ImportMap[i]+0x04`.
- **UEnum:** names `Names[i]` (`+0x34` array).
- **Inherited and already documented:**
  - UField `+0x28` / `+0x2c`;
  - UStruct `+0x34` ScriptText, `+0x38` Children, `+0x40` FriendlyName, and
    the bytecode references (UFunction, UEnum and UConst inherit these);
  - UObject Name, Outer, Class and Linker `+0x10`, and StateFrame.
- **Not visited by any body here (no edge):**
  - UField `HashNext +0x30`;
  - UStruct `RefLink`/`StructLink`/`PropertyLink`/`ConfigLink`/
    `ConstructorLink` `+0x58..+0x68`;
  - UFunction `Func +0x7c`;
  - ULinker import `XObject +0x10` and export `_Object +0x1c`.

## Unresolved and out of scope

- **SerializeBin's reflected walk.** `UObject::Serialize` runs SerializeBin
  over the object's class property chain. For the intrinsic classes here
  (Core.Function, Enum, Const, TextBuffer, Package, Linker, LinkerLoad,
  LinkerSave), whether that walk visits anything depends on each UClass's
  linked PropertyLink, mainly the inherited Core.Object properties and their
  SkipSerialization/Transient gates. It is not determined by these bodies
  and was not traced here.
- **Exception paths.** The guard/unwind blocks (`appUnwindf` and the
  `0x1016ee56` rethrow) are not on the normal path and were not analysed.
- **Other Core Serialize overrides.** These appear in the export list but
  were not covered: UFactory, UExporter, UPackageMap, and the UProperty
  family (`UProperty`, `UByteProperty`, `UBoolProperty`, `UClassProperty`,
  `UStructProperty`, `UFixedArrayProperty`, `UMapProperty`, ...), plus any
  USubsystem/UCommandlet/ULanguage bodies.
- **No live check.** Nothing here was checked against a live collector
  trace. It is a static reading of the hash-pinned DLL, with every address
  above taken from it.
