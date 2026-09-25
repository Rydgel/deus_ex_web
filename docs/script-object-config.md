# UObject localized defaults

This note records `UObject::LoadLocalized`, called by the installed Deus Ex GOTY
`Core.dll` during `UClass::Register`. The binary is the authority; the focused
disassembly is `.cache/research/Core.asm` (also `.cache/reference/Core-rng.asm`).

```text
Core.dll SHA-256              8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4
UObject::LoadLocalized thunk  0x1010306c -> body 0x10151390
Localize thunk                0x101015b4 -> body 0x10148430
```

The translation is [`src/runtime/script-object-config.mjs`](../src/runtime/script-object-config.mjs).
It keeps native call order and exposes localization and property virtuals as
explicit host services. `registerScriptClass` uses it by default with
`services.objectConfig` and the current class record.

For LoadConfig, see the sole translation in [script-config.md](script-config.md).
Registration requires an explicit `services.loadConfig` binding; the host owns
conversion from its raw Defaults.Data buffer to the graph/GConfig storage view.

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
   The raw linked walk reads `Next` after the current
   property's Localize/import work, while an explicit walker owns its result
   timing.
6. Core calls `Localize` (`0x10148430`) with the exact C-order arguments:

   ```text
   [sectionName, key, packageName, 0, 1]
   ```

   An empty returned string (the native first UTF-16 code unit is zero) skips
   import. A nonempty result is passed to the property virtual `+0x84` with
   `[text, destination, 0]` where `destination = defaultObject + property+0x48 + arrayIndex*property+0x38`.

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
chains. Resource lookup, property destination storage, property import, and
`Localize`'s manager fallback require concrete caller adapters.
