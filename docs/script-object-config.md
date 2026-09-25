# UObject config and localized defaults

This note records the two calls made by the installed Deus Ex GOTY
`Core.dll` during `UClass::Register`. The binary is the authority; the focused
disassembly is `.cache/research/Core.asm` (the same image is present in
`.cache/reference/Core-rng.asm`).

```text
Core.dll SHA-256              8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4
UObject::LoadConfig thunk     0x101023dd -> body 0x10150d60
UObject::LoadLocalized thunk  0x1010306c -> body 0x10151390
Localize thunk                0x101015b4 -> body 0x10148430
```

Play's LoadConfig is the complete translation in
[script-config.md](script-config.md). That page corrects two points below:
- the per-object class flag is `0x400`, not `0x00040000`;
- the no-filename branch's class tests are UArrayProperty/UMapProperty
  (dynamic-array config), and `+0x60` is `GetOwnerClass` for globalconfig.

This module still supplies `UClass::Register`'s LoadLocalized adapter.

The translation is [`src/runtime/script-object-config.mjs`](../src/runtime/script-object-config.mjs). It keeps the native call order and makes resource-manager and property-virtual calls explicit host services. It does not turn an absent config or localization manager into an invented value.

## LoadConfig

The native signature reached by `UClass::Register` is
`LoadConfig(INT first, UClass* classArgument, const TCHAR* filename)`. The
JavaScript entry point is:

```js
loadScriptConfig(defaultObject, first = 0, classArgument = 0, filename = 0, services)
```

The body performs these operations in order:

1. A zero `classArgument` is replaced with `defaultObject+0x24` (the object
   Class). If the selected class's `ClassFlags` at `+0x484` does not contain
   `0x00000004`, the body returns immediately. This gate is before superclass,
   field, name-table, or resource access.
2. If `first` is nonzero and the selected class has a non-null Super at `+0x28`,
   the same receiver is recursively called with `(first, Super, filename)`.
   The recursive call completes before the selected class's own Children walk.
3. The body derives a local per-object condition from the receiver's Class
   flags and Index: it is true when `ClassFlags & 0x400` is set **and**
   `defaultObject+0x04 != -1`. With a null filename, that condition selects the
   receiver's Outer name (unless it is the transient package at `0x102a2660`);
   otherwise the selected class's `ClassConfigName` at `+0x4a0` supplies the
   name. A non-null filename is copied into the first string slot and bypasses
   this selection. The name-table strings are the `+0x0c` text members reached
   through `GNames` at `0x102961f0`.
4. The UField chain starts at Class `+0x38` (`Children`) and follows UField
   `+0x2c` (`Next`). The adapter requires those live slots (or an explicit
   `walkProperties` service); it does not substitute a different metadata
   chain when `Children` is absent. Each reached field must be identified as a
   UProperty by an original class-ancestry service or an explicit boolean
   predicate before its `PropertyFlags` at `+0x3c` are read. Only properties
   whose flags contain `0x00004000` continue into this routine. A bound empty
   Children chain or a chain with no matching property returns without
   touching a config manager. For a raw linked chain, the adapter yields one
   field at a time and reads that field's `Next` only after its resource and
   import work returns, matching the native loop; an explicit walker retains
   its own result contract.
5. For a reached property, Core uses either the config manager at global
   `0x101e3314`, vtable slot `+0x1c`, or the internal config-array helper
   `0x101023e2`/`0x1010a2d0`. The manager call's native pushes are, in C order:

   ```text
   [sectionOrPath, 0, 1, filename]
   ```

   The no-filename branch also contains a property-class ancestry test and the
   property virtual `+0x60`; that branch is not inferred from a JavaScript
   property type. A host supplies `services.resolveConfigBranch` (or a
   property `configBranch`) when that test is reached. An explicit filename
   selects the source-visible manager branch; the `0x00040000` property marker
   also calls the property virtual at `+0x60` first, but does not by itself
   identify the manager branch. The adapter requires
   `readPropertyConfigName`/`getPropertyConfigName` (or a serialized property
   config-name value) for this reached call.
6. The resource result is matched with the original case-insensitive
   `appStricmp` path. For every value that is found, Core calls the property
   virtual at `+0x84` with `[text, destination, 0]`; `destination` is
   `defaultObject + property+0x48 + arrayIndex*property+0x38`. The adapter
   requires a mutable destination service when a value is found and retains
   the property/array order.

`services.readConfigProperty(detail)` is called once per matching property,
after the field walk and name resolution. Its descriptor includes the exact
manager arguments or helper boundary, `arrayDim`, `arrayIndices`, property
flags/name, section, filename, and the source addresses. The service owns the
actual config file lookup and returns `{found: true, value}` for a scalar,
`{values: [...]}` or an array for fixed-array properties, `{found: false}` for
no matching value, or `undefined` for the native no-result case. A found value
requires `services.importConfigProperty(detail)` (or the shared
`importProperty`) and `services.propertyDestination(...)`; missing reached
services throw `UnsupportedScriptObjectConfigError`.

The module does not parse INI files or emulate the manager's temporary FArray.
Those are resource boundaries. It also does not silently call a callback for a
class that fails the `0x4` gate or for a class with an empty/non-config Children
chain.

## LoadLocalized

The native signature is `LoadLocalized(INT first, UClass* classArgument)`. The
entry point is:

```js
loadScriptLocalized(defaultObject, first = 0, classArgument = 0, services)
```

The body performs this order:

1. A zero class argument is replaced with `defaultObject+0x24`. If the class
   `ClassFlags` word does not contain `0x00000020`, it returns immediately.
2. It reads global DWORD `[0x101e5544]`. Any nonzero value returns immediately;
   this is the same live link gate used by `UClass::Link` and is read before
   recursion and field walking.
3. A nonzero `first` recursively calls the same receiver with the class Super
   at `+0x28`, before local fields. The call uses the same `first` and has no
   filename argument.
4. The package/outer and section strings come from `GNames` at `0x102961f0`.
   For a CDO (`Index == -1`) they are the class argument's Outer `+0x18` and
   Name `+0x20`; for an indexed object they are the receiver's Outer and Name.
   This is an actual name-table read, so raw records need
   `services.resolveNameText` (or `resolveLocalizedNames`) when they do not
   already expose text.
5. The Class Children chain (`+0x38`, then UField `Next` `+0x2c`) is walked;
   the adapter requires each reached `Next` binding and the original
   UProperty ancestry predicate. Only properties with `PropertyFlags &
   0x00008000` continue. For each
   `ArrayDim` element, Core forms the key directly for dimension one or with
   the data string at `0x101ae028`, `"%s[%i]"`, for arrays.
   As in `LoadConfig`, the raw linked walk reads `Next` after the current
   property's Localize/import work, while an explicit walker owns its result
   timing.
6. Core calls `Localize` (`0x10148430`) with the exact C-order arguments:

   ```text
   [sectionName, key, packageName, 0, 1]
   ```

   An empty returned string (the native first UTF-16 code unit is zero) skips
   import. A nonempty result is passed to the property virtual `+0x84` with
   `[text, destination, 0]` and the same offset calculation as config import.

`Localize` itself allocates a static 1024-character result buffer. Its body
checks `[0x101e5554]` and the manager pointer `[0x101e3314]`; when either is
absent it follows its own fallback path. The adapter keeps this behavior behind
the required `services.localize(detail)` (or `localizeResource`) boundary,
which receives the exact `Localize` descriptor and can represent null manager,
language fallback, and resource lookup without fabricating a string.

## Runtime boundary and unsupported cases

The module accepts logical records (`classFlags`, an explicit `superClass` or
`Super`, `children`, each field's `next`/`Next`, property ancestry,
`propertyFlags`, `arrayDim`, and names) and explicit raw-layout services
(`readClassFlags`, `readObjectIndex`, `readPropertyFlags`, `walkProperties`,
`isProperty`/`isA`, and `resolveNameText`). It can read a native little-endian
Index from a byte buffer at `+0x04`, which covers the CDO header produced by the
registration adapter. Missing recursive `Super` or Children/Next slots fail at
their native offsets; all other raw pointer and FName conversions remain
explicit services.

The supported no-I/O cases are the source gates and empty/nonmatching field
chains. Resource loading, property destination storage, the manager's config
   FArray matching, property `+0x60` class-name behavior, and `Localize`'s manager
   fallback require concrete caller adapters. Unknown config ancestry is rejected
   at the reached `0x10150ee7` branch rather than being guessed. A config class
   without an explicit section/path binding is also rejected when that native
   name/path branch is reached; a short logical `record.name` is not treated as
   the result of the original `GetPathName` call.
