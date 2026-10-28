# Core `CreatePackage` and the selected `UPackage` constructor

This bounded adapter follows the installed GOTY `Core.dll` (SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`) and its
local disassembly at `.cache/reference/Core-rng.asm`.  Public engine sources
are terminology references only.  Other engine versions are unsupported.

`UObject::CreatePackage` is exported by the thunk at `0x10101ccb`; its body is
`0x101549f0`.  The body receives an Outer pointer and a UTF-16 package name.
Its normal path is:

1. At `0x10154a14–0x10154a24`, call
   `ResolveName(&Outer, &Name, Create=1, Exact=0)`.  `ResolveName` may create
   each dotted package component through the same CreatePackage callback.  The
   native caller does not test the returned boolean; it continues with the
   mutable Outer and Name values even after a false result.
2. At `0x10154a32–0x10154a45`, call
   `StaticFindObject(Class=Core.Package, Outer, Name, ExactClass=0)`, where
   Core.Package is the static class identity at `0x1029b8e0`.  An existing
   object is returned immediately, so no FName allocation or constructor call
   follows that branch.
3. On a miss, at `0x10154a47–0x10154a60`, construct
   `FName(Name, EFindName=1)`.  In this image FName is the one-word name-index
   value used by the object header.  Then call the UPackage placement
   `operator new` with the literal size `0x34`, the resolved Outer, that FName,
   and flags `4`.
4. The operator-new thunk `0x10102e82` enters body `0x1010cb20`.  It ignores
   the raw size argument and forwards the class's allocation size through
   `StaticAllocateObject` (`0x10102ec3` -> `0x101579c0`) as:

   ```text
   StaticAllocateObject(
       Class         = Core.Package (0x1029b8e0),
       Outer         = resolved Outer,
       Name          = FName(Name, 1),
       SetFlags      = 4,
       Error         = GWarn (global 0x101a7c38),
       SubobjectRoot = NULL
   )
   ```

   The Core.Package class's virtual allocation-size path returns `0x34` (the
   static registration body at `0x1015a710` supplies that instance size).
   A null allocator result is returned unchanged by CreatePackage.
5. For a non-null result, the call at `0x10154a6c–0x10154a6e` enters the
   UPackage constructor thunk `0x10101a9b`, whose body is `0x1015a3e0`.
   The constructor writes the UPackage vtable `0x101753a0` to object `+0`, then
   calls static `BindPackage` (`0x101017e9` -> body `0x10152ff0`) with the
   object.  It returns the same object.  The constructor itself has no other
   object-field writes in the traced body.

The operator-new argument order is visible in `0x1010cb20`: it reads the
incoming FName scalar and flags, loads the global GWarn pointer at
`0x101a7c38`, then pushes Core.Package, Outer, FName, flags, GWarn, and a null
subobject root before calling StaticAllocateObject.  The size literal at the
CreatePackage call site is still part of the recovered C++ operator-new ABI;
allocation size is selected by the class virtual slot inside
StaticAllocateObject.

## Host contract

`src/runtime/script-package-construction.mjs` exposes
`createScriptPackage` and `createScriptPackageFactory`, plus
`constructScriptPackage` for the selected native constructor.  The helper
composes an existing `createScriptObjectLookup` result:

```js
const createPackage = createScriptPackageFactory({
  lookup, packageClass, internName, staticAllocateObject,
  errorDevice, bindPackage,
});
```

The lookup must be configured with the same `createPackage` callback when it
resolves dotted names, so recursive components use the recovered path:

```js
let createPackage;
const lookup = createScriptObjectLookup({
  registry, names, coreObjectClass, corePackageClass: packageClass,
  createPackage: args => createPackage(args),
});
createPackage = createScriptPackageFactory({
  lookup, packageClass, internName: names.intern,
  staticAllocateObject, errorDevice, bindPackage,
});
```

`createScriptPackage` calls `lookup.resolveName` with mutable holders and
`{create: 1, throwOnConfigMissing: 0}`, deliberately ignores its boolean as
the native caller does, then calls `lookup.staticFindObject` with the
canonical package class.  It calls `internName(resolvedName, 1)` only after a
find miss. Interning, allocation and an explicit `errorDevice` value are required
only on that miss branch; an existing package needs none of them. `undefined`
is not a bound GWarn pointer, while explicit `null` is preserved. The
`staticAllocateObject` callback receives the
source-shaped record below and must return an object or `null`:

```js
{
  classRef: packageClass,
  outer: resolvedOuter,
  name: fName,
  nameText: fName.name ?? resolvedName,
  nameIndex: fName.index,
  size: 0x34,
  flags: 4,
  errorDevice,
  subobjectRoot: null,
}
```

An undefined result from StaticFindObject or StaticAllocateObject is rejected
as an unbound adapter.  A null allocator result remains the native null
return.  `constructScriptPackage` requires a `bindPackage` callback; it writes
the vtable first and invokes that callback second.  If a host exposes a
`nativeSlots`, the helper keeps its live four-byte `+0` slot synchronized
with `nativeVtable`.

The shared native-registration check composes the real `CreatePackage` existing
package path with `ResolveName`, the FName table and object hash lookup. It then
registers queued objects in that package through the same registry. This checks
the integration without treating a fixture allocator or DLL binding callback as
an implementation of those native bodies.

## Scope boundary

The adapter covers CreatePackage's existing-object lookup, mutable name/path
resolution, FName interning, exact operator-new/StaticAllocateObject inputs,
null allocation, and the selected UPackage constructor order.  The allocator
must still implement the shared UObject header/default/registry work traced in
the object-construction module.  BindPackage is a required boundary because
its original body performs package DLL lookup and registration work; this
module does not invent module loading, package loading, config/localization,
linker setup, or a native package catalog.  No non-GOTY image or alternative
UPackage constructor has been validated.
