# Linker import verification and lazy construction

Authority: installed GOTY `Core.dll`, SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`.
The contract below was traced from its instructions before translation. Original
disassembly and reference captures stay in ignored `.cache/research`.

| Routine | Thunk | Body |
| --- | --- | --- |
| `IndexToObject` | `0x10102c11` | `0x1012e550` |
| `CreateImport` | `0x101029ff` | `0x1012e6c0` |
| `Verify` | `0x10102bd5` | `0x10160d80` |
| `VerifyImport` | `0x1010209f` | `0x10160fd0` |

`FObjectImport` is 28 bytes: ClassPackage, ClassName, PackageIndex, ObjectName,
Object, SourceLinker, SourceIndex at offsets 0, 4, 8, 12, 16, 20, 24.
SourceIndex starts at -1. The import array is at linker +0x78 (count +0x7c),
exports at +0x84 (count +0x88, stride 36), LinkerRoot at +0x28, load flags at
+0xd0, verified at +0xd4, and 256 hash heads at +0xd8.

## Recovered contract

* `IndexToObject(0)` returns null. Positive references call `CreateExport(ref-1)`;
  negative references call `CreateImport(-1-ref)`. The native bounds diagnostics
  precede these calls and do not themselves return. Even cached exports enter
  `CreateExport`; the cache check belongs to that body.
* `CreateImport` returns a nonnull Object immediately. Otherwise, only a
  nonnegative SourceIndex causes a call to `SourceLinker->CreateExport`. It
  asserts SourceLinker, stores the result (including null), and increments
  Core global +`0x102a2658`. A subsequent null result retries; it is not a
  permanent negative cache. This routine does **not** verify or find imports.
* `Verify` clears bit 8 of a package root's +0x30, calls `VerifyImport` in index
  order up to the summary ImportCount at linker +0x48, and sets +0xd4 to 1.
  An already nonzero verified flag skips the loop but is still written to 1.
  It does **not** eagerly construct every export. Its exception path removes
  the failed linker from GObjLoaders before rethrowing; that path is outside
  the successful-load translation.
* `VerifyImport` returns immediately if SourceIndex != -1 or any of
  ClassPackage/ClassName/ObjectName is NAME_None. A root import asserts
  Core.Package, calls `CreatePackage(NULL,ObjectName)`, then
  `GetPackageLinker(root,NULL,8,NULL,NULL)` and stores SourceLinker. It does not
  put the package root in Object. A nested import first recursively verifies
  its negative PackageIndex, copies that import's SourceLinker, walks to the
  outermost import, and calls `CreatePackage` for that package.
* Export lookup uses `(ObjectName + ClassPackage*31 + ClassName*7) & 255`,
  normalizing ClassPackage 0x18 to 0x17 **for the hash**. The constructor's
  original hash fragment `0x10160786–0x1016086b` initializes all heads to -1,
  walks exports ascending, and prepends each record, writing HashNext +0x20.
  A zero ClassIndex means Core.Class (names 0x14, 0x29b). A positive one reads
  the named class export and root's name; a negative one reads the class import
  and that import's package name. Match requires object name, class name and
  class package; an import of class package 0x17 can also match 0x18.
  Core's hardcoded name registrations identify these as **UnrealI** and
  **UnrealShare**, not Engine (strings 0x101abfd8 and 0x101abfe8).
* For a verified outer import, candidate PackageIndex must be zero when its
  SourceIndex is -1; otherwise it may equal SourceIndex+1 **or zero**. A public
  match (flag 4) stores SourceIndex. Private matches enter diagnostics, not a
  different public-candidate search.
* After lookup, class-name text `Mesh` is changed to interned `LodMesh` (find
  mode 1), then lookup repeats, including when Mesh initially matched.
* An unresolved nested import tries three exact `StaticFindObject` calls:
  UPackage/NULL/ClassPackage, UClass/classPackage/ClassName, then
  class/outermostPackage/ObjectName. The found object is admitted only if
  all flags `0x04004004` are present. Admission writes Object and increments
  `0x102a2658`; an existing Object does not skip VerifyImport's earlier work.
  If the class has +0x484 bit 0x40, a missing object is allowed; the editor
  additionally logs it. Root package imports need no such object fallback.

## Explicit boundaries

Package file selection, CreatePackage, StaticFindObject, process-wide FName
interning, CreateExport and native diagnostic formatting are separate services.
They must not silently invent a resolved object. Private/missing import error
and forgiving-load diagnostics, editor missing-transient logging, the UnrealI
failure fallback that appends a synthetic UnrealShare import, and structured
exception unwinding remain unsupported until separately exercised. Hash alias
matching itself is covered independently of that fallback.

The preload validator previously claimed native `CreateImports`
eagerly resolves objects and `Verify` eagerly creates exports. Those comments
described host preparation, not the recovered native routines. Its seven
field-for-field class comparisons remain useful serialization evidence, but
neither its total constructed count nor path lookup establishes native import
resolution or live Play loading.

## Validation and integration

`node scripts/validate-linker-imports.mjs --original-only` records 30 cases
before loading the translation. The Python oracle executes the original hash
fragment and four bodies, with explicit CreatePackage/GetPackageLinker,
StaticFindObject, CreateExport and FName/string boundaries. It compares every
hash head/chain, import Object/SourceLinker/SourceIndex/ClassName write, ordered
external call, return, counter and root package flag. Private/missing cases
stop at the original diagnostic call, not at a simulated successful return.
The normal validator also rejects six in-memory mutations (counter, source
index zero, nested outer wildcard, static flags, class match and hash alias).

`scripts/validate-linker-preload.mjs` uses this translation for real package
imports and removes eager export preparation. All seven class/serialized-default
comparisons still pass. Before the first load, every linker is verified, every
export Object is null and GObjLoaded is empty. Engine.Inventory's import has
the correct SourceLinker/SourceIndex but no Object, then constructs through the
owning export and retains canonical registered identity. The current closure
is 9,316 serializations, 10,111 constructions plus 53 static re-initializations,
and 412 class exports. Only the seven named classes are individually compared;
these counts are not a fidelity percentage. The graph has since been extracted
into a shared runtime module and connected to Play's class/default loading; see
[`script-load-graph.md`](script-load-graph.md). Native resource payloads and
post-load/heap ownership remain open.
