# UBoolProperty::Link

`src/runtime/script-bool-property-link.mjs` translates the first *complex*
property Link virtual from the installed Deus Ex GOTY `Core.dll`. Unlike the
[scalar bodies](script-scalar-property-link.md) — which derive from the `ret 8`
`UProperty::Link` base and only write ElementSize/Offset — the bool body packs
consecutive bool properties into a single 32-bit DWORD through a shifting
bitmask, and it reads both the PreviousProperty argument and a second Outer
virtual (`MergeBools`, `+0x58`) that the scalar bodies never touch.

All addresses are read directly from `.cache/research/Core.asm` (demangled MSVC
symbols); no public engine source is the authority.

## Entry points

| Symbol | Address |
| --- | --- |
| `UBoolProperty::Link` thunk | `0x10101230` |
| `UBoolProperty::Link` body | `0x10166060` |
| `UProperty::Link` (base) body | `0x10165640` — `ret 8`, a no-op |
| `UBoolProperty` object vtable | `0x10175c84` (from the ctor `0x101132e0`, which also stores `BitMask = 1`) |
| `UBoolProperty` class object (cast target) | `0x102a6bf0` |
| `UStruct::GetPropertiesSize` (`+0x64`) body | `0x1010f7c0` |

Constructor `0x101132e0` writes the vtable `0x10175c84` at `+0x0` and the
default `BitMask = 1` at `+0x5c`, confirming `+0x5c` is `UBoolProperty::BitMask`.

## Property record offsets

| Offset | Field |
| --- | --- |
| `+0x00` | native vtable |
| `+0x18` | Outer |
| `+0x24` | Class (walked by the cast) |
| `+0x28` | SuperStruct (class-chain step) |
| `+0x34` | ArrayDim (owned by UStruct::Link) |
| `+0x38` | ElementSize |
| `+0x3c` | PropertyFlags (owned by UStruct::Link) |
| `+0x48` | Offset |
| `+0x5c` | BitMask |

## Body order

The `__thiscall` body (this = `UBoolProperty`, args `FArchive& Ar`, `UProperty* Prev`)
runs, in order:

1. `Super::Link(Ar, Prev)` — inlined away because the base body is `ret 8`.
2. `prevBool = Cast<UBoolProperty>(Prev)`: if `Prev != null`, walk `Prev->Class`
   (`+0x24`) up the `SuperStruct` (`+0x28`) chain comparing against the
   `UBoolProperty` class object `0x102a6bf0`; the result is `Prev` on a match,
   else `null`.
3. `mergeBools = Outer->MergeBools()` — virtual `+0x58`, called **unconditionally**.
4. If `mergeBools != 0 && prevBool != null && (prevBool->BitMask & 0x7fffffff) != 0`:
   * `BitMask = prevBool->BitMask << 1` (share the previous property's DWORD,
     next bit up);
   * `Offset = Prev->Offset`.
5. Otherwise (fresh DWORD):
   * `size = Outer->GetPropertiesSize()` — virtual `+0x64`;
   * `BitMask = 1`;
   * `Offset = Align(size, 4) = (size + 3) & ~3`.
6. `ElementSize = 4` — written **last**, on both paths.

The masked test `(prevBool->BitMask & 0x7fffffff) != 0` is exactly
`prevBool->BitMask != 0x80000000`: because `BitMask` is always a single set bit,
once bit 31 is occupied the property cannot shift further and starts a fresh
DWORD instead.

## The MergeBools rule

`MergeBools` (`+0x58`) is overridden per container class; every body is verified
in `Core.dll`:

| Container | `MergeBools` body | Returns | Bool packing |
| --- | --- | ---: | --- |
| `UField` (inherited by `UStruct`) | `0x10125d40` | `1` | bools share a DWORD |
| `UState` | `0x101104e0` | `1` | share |
| `UClass` | `0x10111560` | `1` | share |
| `UFunction` | `0x1010fee0` | `0` | **never share** |

`UStruct` has no `MergeBools` override, so it uses `UField`'s `1`. Consequently
class/state/script-struct bools pack, while **function parameters and locals
never pack** — each bool takes its own DWORD. Only `UField` and `UStruct` define
`GetPropertiesSize`; `UState`/`UClass`/`UFunction` inherit `UStruct`'s, reading
`+0x3c`, so a function-owned bool (always on the fresh path) still reads the
running size correctly.

The module maps the four container object vtables to their `MergeBools` result
(`UStruct 0x10175698`, `UState 0x101757d8`, `UClass 0x101758f4` → `1`;
`UFunction 0x10175738` → `0`) for hosts that do not supply a live `mergeBools`
service. `UFunction`'s vtable is read from its constructor `0x10128fa0`.

## API and storage

```js
linkScriptBoolProperty(property, {
  archive,
  previousProperty,
  services: {
    mergeBools(outer, detail) { return /* Outer->MergeBools() */; },
    getPropertiesSize(outer, detail) { return /* Outer->GetPropertiesSize() */; },
    readSlot, writeSlot,
  },
});
```

`linkBoolProperty(property, archive, previousProperty, services)` is the
callback shape for `linkScriptStruct(... services.linkProperty)`. The property
must carry kind `BoolProperty` and the matching native vtable `0x10175c84`; a
kind alone, a wrong vtable, an unverified Outer container, or missing layout
storage all fail explicitly (`UnsupportedScriptBoolPropertyLinkError`) rather
than guessing. Layout writes use the same live `nativeSlots` / `readSlot` /
`writeSlot` boundary as the scalar and struct linkers.

`Cast<UBoolProperty>(Prev)` is translated as a leaf-class kind test
(`Prev`'s kind is `BoolProperty`), which is exact because `UBoolProperty` has no
subclasses; a host may override with `services.isBoolProperty` for a live
class-chain walk.

Selection between this body and the scalar bodies is done by
`src/runtime/script-property-link.mjs`, which `src/runtime/script-struct-link.mjs`
uses as its default child-property linker, so a mixed scalar/bool class lays out
correctly through the recovered UStruct::Link accumulation.

## Evidence and focused validation

`test/script-bool-property-link.test.mjs` replays the recovered body against the
`nativeSlots` boundary:

* consecutive class/struct bools share one DWORD with bitmasks `1, 2, 4, …` and
  a shared Offset; `MergeBools` is consulted every call and `GetPropertiesSize`
  only on the fresh path;
* a bool at bit 31 (`0x80000000`) forces the next bool onto a fresh DWORD, while
  bit 30 (`0x40000000`) packs to bit 31;
* a non-bool previous property does not pack (the cast returns null);
* a `UFunction` Outer (`MergeBools = 0`, resolved by service and by the vtable
  map) never packs;
* the `MergeBools`/`GetPropertiesSize` vtable fallbacks read the four known
  container vtables;
* wrong kind, wrong vtable, and an unverified Outer are rejected;
* through `linkScriptStruct`, a mixed `int/bool/bool/int` class lays out as
  `int@0`, two bools sharing `@4` (bits 1 and 2), `int@8`, total size `0xc`.

The behavior contract is the recovered Core.dll instructions at `0x10166060` and
the four `MergeBools` bodies above; as with the scalar linker, this nonvisual
runtime logic has no visual-comparison gate.

## Boundary

Only `UBoolProperty::Link` is translated here. The remaining complex property
Link bodies — `UStrProperty::Link` (`0x101011c2`), `UArrayProperty::Link`
(`0x10101d07`), `UMapProperty::Link` (`0x101021d0`), `UStructProperty::Link`
(`0x1010223e`), and `UFixedArrayProperty::Link` (`0x101026cb`) — are
translated in [the complex property Link bodies](script-complex-property-link.md).
