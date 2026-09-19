# Original function binding and metadata finalization

Authority: GOTY Core.dll SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`.
The following instructions were recovered before implementation.

## UFunction::Bind

Thunk `0x10101d57` reaches body `0x10129320`. FunctionFlags are a dword at
`+0x6c`, iNative is an unsigned word at `+0x70`, and the function-pointer
slot is a dword at `+0x7c`.

* Without flag `0x400`, assert iNative is zero (source line `0x57a`), then
  store script-handler thunk `0x10101acd` (body `0x1013f690`) in `+0x7c`.
* With flag `0x400` and nonzero iNative, assert iNative is less than `0x1000`
  (line `0x580`). Read `GNatives[iNative]` from table `0x101f41b8`, assert
  nonnull (line `0x581`), then copy that pointer to `+0x7c`.
* With flag `0x400` and iNative zero, call virtual GetOwnerClass (`+0x60`),
  then that class's virtual GetNameCPP (`+0x80`). Read this function's FName
  text and format `int%sexec%s` (`0x101aa0d0`). Call GetOwnerClass a second
  time, read its Outer (`+0x18`), and call that package's GetDllExport
  (`0x10101168` -> `0x1015a5a0`) with the formatted name and checked=1.
  A nonnull export is a **pointer to a function-pointer cell**: copy its first
  dword into `+0x7c`. A null export leaves the existing slot unchanged. A
  nonnull cell containing zero writes zero; Bind adds no assertion here.

Both GetOwnerClass calls matter; no cached owner or early return for a
previously assigned `+0x7c` is present. SEH reporting/unwinding and package DLL
loading/error formatting remain separate boundaries.

## Existing native services used by the graph

UField::GetOwnerClass (`0x10125bc0`) follows Outer until the object's Class
is exactly Core.Class (`0x101f1c18`). UField::Bind (`0x10125be0`) is empty.

UClass::GetNameCPP (`0x101115a0`) walks SuperField looking for a class named
Actor, using `appStricmp` (`0x1010239c`). It prefixes the original class's
name with A when that ancestor is found, otherwise U. It formats `%s%s`
into a rotating temporary string (`0x10102518`); the host string representation
must preserve the text used immediately by function Bind. This is not a claim
of full native temporary-buffer ownership.

Original exported vtables establish metadata PostLoad/Bind dispatch:

| Kinds | PostLoad thunk | Bind thunk |
| --- | --- | --- |
| Class | `0x10101307` | `0x10102afe` |
| Function | `0x10102711` | `0x10101d57` |
| Struct, State | `0x1010231a` | `0x1010210d` |
| Field, Property and its scalar/container/reference subclasses, Const, Enum | `0x10102e5a` | `0x1010210d` |
| Object, Package, TextBuffer (UObject subobject) | `0x10101262` | not called |

UField's exported vtable is `0x1017561c`. The graph previously recorded
`0x10175ee4`, an incorrect address; post-load dispatch must use the original
vtable values. Resource classes cannot be admitted through an assumed UObject
fallback simply because they derive from Object.

## Native registration inputs

GRegisterNative (`0x10102563` -> `0x1013f480`) initially fills all 4096
GNatives cells with thunk `0x10101e60` and sets `0x101f81c4=1`. Index -1
does not publish a table entry. Other registrations copy the provided cell's
dword into GNatives[index]; invalid/duplicate index reporting writes
`0x101f81b8`. Binding to the default undefined-native handler is allowed by
Bind's nonnull check; it does not establish that the browser implements that
native. DLL export cells named `int<ClassCPP>exec<Function>` provide the named
route. Native table initialization and DLL export lookup are supplied services,
not guessed mappings from function names to indices.

## Package wrapper reached by class references

UPackage::Serialize thunk `0x10102ce3` reaches `0x1015a470`. Its normal
path forwards the same this/archive pointers to UObject::Serialize through
`0x1010178f`, then returns with stack cleanup of four bytes at `0x1015a4b1`.
It adds no package payload read or write. An original-instruction forwarding
case establishes this wrapper separately, so Core.Package can use the already
recovered UObject serializer in the graph. This does not admit Texture, Mesh
or other native resources through an unverified base fallback.

## Implemented integration and verification

`script-function-bind.mjs` translates all three Bind branches, owner traversal
and CPP name selection. `native-function-bind-oracle.py` executes the original
Bind, GetOwnerClass and GetNameCPP bodies for 12 cases. Formatting, string
comparison, scratch storage and GetDllExport are explicit fixture services.
Cases include both table limits, assertion paths, the undefined-native handler,
an Actor ancestor through a nested state, a missing export, a zero export cell,
and a changed owner between the two virtual calls. The package-forwarding case
executes the original UPackage wrapper with an explicit UObject base service.

The shared graph now exposes explicit BeginLoad/EndLoad scopes and metadata
PostLoad/Bind dispatch. `nativeFunctions` supplies the numbered-native table,
DLL-export lookup and cell reads; `lifecycle` supplies output/allocation edges.
These services are required when reached. Loading a class does not silently
invent a completed outer load scope or default native table.

`validate-function-bind.mjs` loads the original Core.Object closure and ends
the **entire 652-object queue** through this graph. It verifies cleared load
and postload flags, every UObject base call, stable repeat postload, queue
release, and all **164 function-pointer slots**: 4 script handlers, 150 numbered
natives and 10 named natives. Its table inputs come from executing Core's real
static initializers (250 nondefault numbered entries, no initializer failures)
and reading the original PE export cells. This integration composes the
separately proven bodies; it is not a claim of a complete original process or
all native exec implementations.

The graph refuses unknown Serialize and PostLoad dispatch before clearing an
unsupported resource's corresponding load flag. A real queued Engine.Texture
checks this admission boundary; a real Core.Package group checks the newly
admitted wrapper and exact payload consumption. Original native constructor
defaults, native heap ownership, config/localization, other DLL registration
inputs and the broader resource serializers/overrides remain incomplete.
