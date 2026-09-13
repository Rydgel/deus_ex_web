# Core `UObject::execDynamicLoadObject`

This is the source-first contract for the native wrapper used by Training
InfoLink speaker loading. The authority is the installed GOTY
`Deus Ex GOTY Edition/System/Core.dll`, SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`.
The complete disassembly is in `.cache/research/Core.asm`; the original DLL
and native captures remain outside Git.

The installed `Core.u` declaration is `Object.DynamicLoadObject` at export
627 (`.cache/reference/Object.uc:294`):

```unrealscript
native static final function object DynamicLoadObject(
    string ObjectName, class ObjectClass, optional bool MayFail);
```

The serialized function has native index `0`, function flags `0x2401`,
serial size `33`, and script size `15`. Its parameter chain is
`ObjectName` (string), `ObjectClass` (class), `MayFail` (optional bool), and
`ReturnValue` (object).

## Recovered wrapper order

The exported thunk `0x10103201` jumps to the direct body `0x1013eb30`. The
body performs these operations in this order:

1. It evaluates three FFrame expressions through `GNatives` in declaration
   order: `ObjectName`, `ObjectClass`, and `MayFail`. The first expression
   writes a temporary native `FString`; the second writes a class pointer; the
   third writes a bool-sized value.
2. The third expression is unconditional in this body. For an omitted
   optional argument, the compiled stream supplies the original `EX_Nothing`
   token `0x0b` (`execNothing` body `0x1012f660`), which leaves the wrapper's
   zero-initialized `MayFail` local unchanged. The body then advances past
   `EX_EndFunctionParms` (`0x16`).
3. It selects the temporary string's data pointer. A nonempty FString passes
   its allocated data; a zero-count FString passes the Core static empty
   string at `0x101ef654`.
4. It converts `MayFail` to a truth value and derives load flags as
   `2 | (MayFail ? 0x2000 : 0)`. It calls the `StaticLoadObject` thunk
   `0x10102a1d` with cdecl arguments:

   ```text
   Class       = ObjectClass
   InOuter     = null
   Name        = selected FString data
   Filename    = null
   LoadFlags   = 2 or 0x2002
   Sandbox     = null
   ```

5. It copies the callee's EAX directly into the native `Result` slot. A null
   StaticLoadObject return remains null; no fallback value is invented.
6. It destroys the temporary FString after the result store. The original
   `FArray::Realloc` thunk `0x10101753` (body `0x10145440`) runs with element
   size `2`, zeroes the temporary array's count/capacity, and reaches the
   GMalloc `Realloc` virtual with the old data pointer, byte size `0`, and
   tag `0x101ab50c`. When the old data pointer is non-null, the wrapper then
   calls the GMalloc `Free` virtual. Empty FString storage reaches Realloc
   with a null old pointer and does not reach Free.

The wrapper therefore owns the temporary FString lifetime independently of
whether StaticLoadObject returns an object. The browser string adapter may
use immutable host text, but it must retain this explicit cleanup edge when a
native-memory FString is represented.

## Native oracle and validation

[`native-dynamic-load-object-oracle.py`](../scripts/native-dynamic-load-object-oracle.py)
executes the unchanged wrapper body. It supplies only controlled expression
outputs, a synchronous StaticLoadObject return boundary, and the two GMalloc
virtual slots. The original wrapper, FFrame cursor updates, argument pushes,
FArray::Realloc body, and result/cleanup ordering execute from Core.dll.

[`validate-dynamic-load-object.mjs`](../scripts/validate-dynamic-load-object.mjs)
checks the DLL hashes and addresses, Core.u metadata, declaration-order
evaluation, omitted/explicit MayFail cases, flags, exact six StaticLoadObject
arguments, null and non-null return propagation, and temporary storage
cleanup. The six cases include empty text, explicit false, truthy values, and
a null StaticLoadObject return.

Run the focused check with:

```sh
node scripts/validate-dynamic-load-object.mjs
```

## Browser integration

`PreparedDynamicLoadGraph` finishes AssetStore/resource preparation before the
synchronous native frame begins. At execution, it calls the separately
recovered [StaticLoadObject](script-static-load-object.md) implementation over
the prepared package's canonical package identity, serialized export/import
tables, and a rebuilt 256-bucket linker hash. The focused
`InfoPortraits.JaimeReyes` route keeps its package identity and bytes prepared
but defers `ULinkerLoad` construction until `GetPackageLinker`; the constructor
publishes one canonical linker and its archive/reader descriptor before the
same `FName(text,1)`, `FindExportIndex`, and existing `CreateExport` walk.
Direct and grouped exports that are explicitly prepared retain the initialized
linker path and return the same `ScriptObjects` identity already held by the
resource registry.

The browser assigns stable case-insensitive logical FName indices while it
builds this prepared graph. Those indices drive both insertion and lookup with
the recovered hash formula, so identity and collision behavior are preserved
inside the graph. Their numeric values are not claimed to be the original
process's boot-order GNames slots; no full GNames capture is available for that
claim.

The live Training `HUDInfoLinkDisplay.SetSpeaker` call uses this path for
`InfoPortraits.JaimeReyes`; it no longer installs a DataLink-specific load
boundary. `test/script-dynamic-load-object.test.mjs` also exercises the grouped
`DeusExUI.UserInterface.DataLinkIcon` path, exact normal/`MayFail` linker flags,
the deferred first-load constructor/archive identity, missing-linker and
class-mismatch boundaries, and the complete successful event order.

A null export requiring native object construction, native metaclass object
loading, the nonempty post-load array, and nonzero linker cleanup remain
explicit boundaries. The wrapper oracle does not claim those deeper branches;
other first-load package file/error routes remain outside the focused portrait
adapter.
