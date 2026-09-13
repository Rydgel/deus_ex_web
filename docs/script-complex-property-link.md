# Complex UProperty::Link bodies

`src/runtime/script-*-property-link.mjs` translate the five remaining *complex*
property `Link` virtuals from the installed Deus Ex GOTY `Core.dll`.  Together
with the [bool body](script-bool-property-link.md) they complete the property
`Link` set: every property class reached by `UStruct::Link` now has a verified
translation, so a mixed class/state/struct layout links through the recovered
native bodies instead of the scalar module's explicit unsupported-kind path.

All addresses are read directly from `.cache/research/Core.asm` (demangled MSVC
symbols); no public engine source is the authority.

## Entry points

| Symbol | Thunk | Body |
| --- | --- | --- |
| `UStrProperty::Link` | `0x101011c2` | `0x10167640` |
| `UArrayProperty::Link` | `0x10101d07` | `0x101683b0` |
| `UFixedArrayProperty::Link` | `0x101026cb` | `0x10167c60` |
| `UMapProperty::Link` | `0x101021d0` | `0x10168ca0` |
| `UStructProperty::Link` | `0x1010223e` | `0x10168ff0` |

Instance vtables (from each class's default constructor, which writes the
vtable at `+0x0`):

| Class | Vtable | Constructor body |
| --- | --- | --- |
| `UStrProperty` | `0x10176044` | `0x10114520` |
| `UArrayProperty` | `0x101761c4` | `0x10114c50` |
| `UFixedArrayProperty` | `0x10176104` | `0x101148b0` |
| `UMapProperty` | `0x10176284` | `0x10114ff0` |
| `UStructProperty` | `0x10176344` | `0x10115390` |

The child `->Link` calls dispatch through the `+0x68` virtual slot, and
`Ar->Preload` through `+0x10` — the same slots the struct linker and the
existing scalar/bool modules use.

## Shared body shape

Every body derives from `UProperty::Link`, whose base body is a native
`ret 8` no-op (`0x10165640`), so `Super::Link(Ar, Prev)` is inlined away in
all five.  Each body then:

1. (array bodies) preloads and links its child property with a **null Prev**;
2. writes `ElementSize` (`+0x38`);
3. reads `Outer->GetPropertiesSize()` (`+0x64`) and writes `Offset` (`+0x48`)
   aligned up;
4. tests `PropertyFlags` (`+0x3c`) bit `0x1000` (`testb $0x10, %ah`) and, when
   clear, sets bit `0x400000`.

`0x400000` is the same "need destruction" bit `UStruct::Link` uses to build the
destroy property chain (`+0x68`); `0x1000` is the "atomic" bit that exempts a
property from that chain.  The four container vtables whose `GetPropertiesSize`
reads the running size from `+0x3c` are the same set the bool module accepts
(`UStruct 0x10175698`, `UState 0x101757d8`, `UClass 0x101758f4`,
`UFunction 0x10175738`).

## UStrProperty::Link — `0x10167640`

```
ElementSize[+0x38] = 0xc                    // sizeof(FString): TCHAR*, INT, INT
Offset[+0x48]      = Align(Outer->GetPropertiesSize()[+0x64], 4)
if (!(PropertyFlags[+0x3c] & 0x1000)) PropertyFlags |= 0x400000
```

No child property.  Native write order: ElementSize, GetPropertiesSize, Offset,
then flags.

## UArrayProperty::Link — `0x101683b0`

```
Ar->Preload(+0x10)[Inner]                   // Inner at +0x5c
Inner->Link(+0x68)[Ar, 0]
ElementSize[+0x38] = 0xc                    // sizeof(TArray): T*, INT, INT
Offset[+0x48]      = Align(Outer->GetPropertiesSize()[+0x64], 4)
if (!(PropertyFlags[+0x3c] & 0x1000)) PropertyFlags |= 0x400000
```

The child link passes a null Prev, exactly as `UStruct::Link` does for direct
children.  The `0xc` element size is the `TArray` header, not the inner type.

## UFixedArrayProperty::Link — `0x10167c60`

```
Ar->Preload(+0x10)[Inner]                   // Inner at +0x5c
Inner->Link(+0x68)[Ar, 0]
ElementSize[+0x38] = Inner->ElementSize[+0x38] * ArrayCount[+0x60]
Offset[+0x48]      = Align(Outer->GetPropertiesSize()[+0x64], 4)
if (!(PropertyFlags[+0x3c] & 0x1000)) {
    PropertyFlags |= (Inner->PropertyFlags[+0x3c] & 0x400000)
}
```

Unlike Str/Array/Map, the flag is **copied** from the inner property instead of
set unconditionally: a fixed array of plain scalars does not need destruction.
The inner `ElementSize`/`PropertyFlags` are read after the child `Link` call.

## UMapProperty::Link — `0x10168ca0`

```
Ar->Preload(+0x10)[Key]                     // Key at +0x5c
Key->Link(+0x68)[Ar, 0]
Ar->Preload(+0x10)[Value]                   // Value at +0x60
Value->Link(+0x68)[Ar, 0]
ElementSize[+0x38] = 0x14                   // sizeof(TMap): TArray<TPair> + hash ptr + hash count
Offset[+0x48]      = Align(Outer->GetPropertiesSize()[+0x64], 4)
if (!(PropertyFlags[+0x3c] & 0x1000)) PropertyFlags |= 0x400000
```

Key and Value are linked in that order, each with a null Prev.

## UStructProperty::Link — `0x10168ff0`

```
Ar->Preload(+0x10)[Struct]                  // inner UStruct at +0x5c
ElementSize[+0x38] = Struct->PropertiesSize[+0x3c]
alignment = struct size == 2 ? 2 : (struct size < 4 ? 1 : 4)
Offset[+0x48]      = Align(Outer->GetPropertiesSize()[+0x64], alignment)
if (Struct->DestroyProperty head[+0x68] != 0 && !(PropertyFlags[+0x3c] & 0x1000)) {
    PropertyFlags |= 0x400000
}
```

The alignment mapping is the disassembled `cmpl $2 / setl / decl / andl $3 /
incl` sequence: sizes `0,1,3` → `1`, size `2` → `2`, sizes `>=4` → `4`.  The
`+0x68` test reads the inner struct's destroy-property chain head (the pointer
`UStruct::Link` writes at record `+0x68`), so a struct property needs
destruction only when its inner struct actually holds destructible fields.

## API and storage

Each module exports `linkScript<Kind>Property(property, {archive,
previousProperty, services})` (options form) and `link<Kind>Property(property,
archiveOrOptions, previousProperty, services)` (callback shape for
`linkScriptStruct(... services.linkProperty)`).  The property must carry the
verified kind and matching native vtable; a wrong kind, wrong vtable, missing
child, or unverified Outer fails explicitly
(`UnsupportedScriptComplexPropertyLinkError` with a per-body code) rather than
guessing.  Layout writes use the same live `nativeSlots` / `readSlot` /
`writeSlot` boundary as the scalar, bool and struct linkers.

The child `->Link(Ar, 0)` virtual call uses `services.linkProperty` when a host
supplies it, otherwise routes back through the dispatcher
(`src/runtime/script-property-link.mjs`), which the shared helper module
registers lazily to avoid an import cycle.  `Ar->Preload` uses
`services.preload` or `archive.preload`.

`src/runtime/script-property-link.mjs` now routes all six complex kinds
(Bool/Str/Array/FixedArray/Map/Struct) to their bodies and keeps the scalar
classes on the scalar bodies; unknown kinds still fall to the scalar linker's
explicit diagnostics.

## Evidence and focused validation

`test/script-complex-property-link.test.mjs` replays the recovered bodies
against the `nativeSlots` boundary:

* Str: `0xc` element size, aligned offset, unconditional need-destruction flag,
  atomic preservation;
* Array: Preload(Inner) before `Inner->Link(Ar, 0)` with a null Prev, `0xc`
  element size, flag; recursion through the dispatcher packs an inner bool;
* FixedArray: `Inner->ElementSize * ArrayCount`, destroy-bit copy from Inner,
  plain-inner no-flag, inner reads after the child link;
* Map: Key then Value preload/link order, `0x14` element size, flag, dispatcher
  recursion;
* Struct: inner `PropertiesSize` element size, the three alignment cases
  (`Align(0x13, 2) = 0x14`, `Align(0x13, 1) = 0x13`, `Align(0x11, 4) = 0x14`),
  and the destroy-chain-head gate (including atomic);
* dispatcher routing for all five kinds, callback-shape parity, kind/vtable/
  archive rejection, and missing-child errors;
* two `UStruct::Link` integration layouts: `str/bool/bool/int` yields offsets
  `0, 0xc, 0xc, 0x10` with the string in the destroy chain, and two array
  fields lay out `0, 0xc` with total `0x18`.

The behavior contract is the recovered Core.dll instructions at the five body
addresses above; as with the other linkers, this nonvisual runtime logic has no
visual-comparison gate.

## Boundary

All property `Link` virtuals are now translated.  The remaining complex
property virtuals (SerializeItem, CopyCompleteValue, DestroyValue, Identical,
etc.) and the full loaded resource graph remain separate Stage 3 work.