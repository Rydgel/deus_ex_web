# Original `ULinkerLoad::CreateExport`

This note records the complete recovered body of Core's
`ULinkerLoad::CreateExport`, the routine that constructs a package export that
does not exist yet.  It is the path `UObject::StaticLoadObject` reaches when its
linker/export lookup finds an export slot whose `_Object` is still null, and it
is the only original route by which a **class** export becomes a live `UClass`:
a null `ClassIndex` selects the hard-coded `Core.Class` metaclass, so the
constructed object is itself a class.  That branch is what
[the completion audit](stage-3-completion-audit.md) names *native metaclass
class loading*.

## Authority

Installed GOTY `Core.dll`, SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`, image base
`0x10100000`.  Thunk `0x101012fd` jumps to body `0x1012e230`; the body ends at
`0x1012e4af`.  The embedded assert strings name the original translation unit
and its line numbers directly:

| address | string |
| --- | --- |
| `0x101a83d4` | `D:\prj\Clean\Core\Src\UnLinker.h` |
| `0x101aa600` | `Export.ObjectName!=NAME_None \|\| !(Export.ObjectFlags&RF_Public)` (line `0x313` = 787) |
| `0x101aa5f4` | `LoadClass` (line `0x319` = 793) |
| `0x101aa5bc` | `LoadClass->GetClass()==UClass::StaticClass()` (line `0x31a` = 794) |
| `0x101aa5a0` | `Created %s` (log format) |
| `0x101aa58c` | `(%s %i)` (unwind format, `appUnwindf` tail only) |

The `FObjectExport` stride is `0x24`, matching the
`exportRecordStride` already recorded in
[`script-static-load-object.md`](script-static-load-object.md).  Field offsets,
read directly from the `(%esi)` accesses in this body, are
`ClassIndex +0x00`, `SuperIndex +0x04`, `PackageIndex +0x08`,
`ObjectName +0x0c`, `ObjectFlags +0x10`, `SerialSize +0x14`,
`SerialOffset +0x18`, `_Object +0x1c`, `_iHashNext +0x20`.

The UObject header offsets used here are the ones already recovered in
[`script-object-serialization.md`](script-object-serialization.md): Outer
`+0x18`, ObjectFlags `+0x1c`, Name `+0x20`, Class `+0x24`.  `SuperField` is the
UField `+0x28` slot recorded in the same document's UField section.

Linker slots reached from `%ebx`: `LinkerRoot +0x28`, context flags `+0xa0`,
the embedded `FArchive` subobject at `+0xa4`, and the export table pointer at
`+0x84`.

## Recovered body

```
UObject* ULinkerLoad::CreateExport( INT Index )        // 0x1012e230
{
    FObjectExport& Export = ExportMap[Index];                       // +0x84, stride 0x24

    if( Export._Object )                                            // 0x1012e26c
        return Export._Object;                                      // -> 0x1012e425
    if( !(Export.ObjectFlags & this->ContextFlags /*+0xa0*/) )       // 0x1012e278-0x1012e283
        return Export._Object;                                      // still null

    check( Export.ObjectName != NAME_None ||
           !(Export.ObjectFlags & RF_Public /*0x4*/) );             // 0x1012e289-0x1012e2a8

    UClass* LoadClass = (UClass*)IndexToObject( Export.ClassIndex ); // 0x1012e2ab-0x1012e2b5
    if( !LoadClass )
        LoadClass = UClass::StaticClass();                           // 0x101f1c18  <-- metaclass
    check( LoadClass );                                              // 0x1012e2c2-0x1012e2da
    check( LoadClass->Class /*+0x24*/ == UClass::StaticClass() );    // 0x1012e2dd-0x1012e2fa

    if( LoadClass->Name /*+0x20*/ == NAME_Camera /*0xa2*/ )          // 0x1012e2fd
        return NULL;                                                 // 0x1012e306-0x1012e318

    Preload( LoadClass );                                            // (this+0xa4)->vtable[+0x10]

    UObject* ThisOuter = Export.PackageIndex                         // 0x1012e32b-0x1012e33e
        ? IndexToObject( Export.PackageIndex )
        : this->LinkerRoot /*+0x28*/;

    if( Export._Object )                                             // 0x1012e341-0x1012e346
        return Export._Object;                                       // Preload may have created it

    Export._Object = UObject::StaticConstructObject(                 // 0x1012e34c-0x1012e375
        LoadClass, ThisOuter, Export.ObjectName,
        (Export.ObjectFlags & 0x067f0025) | 0x01000200,
        NULL /*Template*/, GWarn /*0x101a7c38*/ );

    Export._Object->SetLinker( this, Index );                        // 0x1012e378-0x1012e37c

    GObjLoaded.Add( 1, 4 );                                          // FArray::Add, 0x1029e638
    GObjLoaded[Num-1] = Export._Object;                              // 0x1012e38f-0x1012e39a

    GLog->Logf( NAME_DevLoad /*0x308*/, TEXT("Created %s"),          // 0x1012e39d-0x1012e3b9
                Export._Object->GetFullName() );

    if( Export._Object->IsA(UStruct::StaticClass() /*0x101f2618*/)   // 0x1012e3be-0x1012e3e8
        && Export.SuperIndex )
        ((UStruct*)Export._Object)->SuperField /*+0x28*/ =
            IndexToObject( Export.SuperIndex );                      // 0x1012e3ea-0x1012e3f5

    if( Export._Object->IsA(UClass::StaticClass() /*0x101f1c18*/) )  // 0x1012e3f8-0x1012e41b
        ((UClass*)Export._Object)->Bind();                           // vtable +0x5c, 0x1012e422

    return Export._Object;
}
```

Both `IsA` tests are inlined as the same loop the compiler emits elsewhere:
start at the object's `Class +0x24` and follow `SuperField +0x28` until the
pointer matches the queried static class or becomes null.  The null exit
computes `(target == 0) ? 1 : 0`, which is always `0` here, so a chain that
runs out is not a match.  This module implements that loop rather than
delegating to a host predicate, because it is part of the recovered body.

### Flag arithmetic

`0x067f0025` is UE1's `RF_Load` set and `0x01000200` is
`RF_NeedLoad | RF_NeedPostLoad`.  Decomposed against the flag bits this
project already uses (`0x04000000` native, `0x00000004` public):

```
0x067f0025 = 0x00000001 Transactional | 0x00000004 Public | 0x00000020 TagExp
           | 0x00010000 LoadForClient | 0x00020000 LoadForServer
           | 0x00040000 LoadForEdit   | 0x00080000 Standalone
           | 0x00100000 NotForClient  | 0x00200000 NotForServer
           | 0x00400000 NotForEdit
           | 0x02000000 HasStack      | 0x04000000 Native
0x01000200 = 0x00000200 NeedLoad | 0x01000000 NeedPostLoad
```

The module keeps the two raw constants as the contract and treats the
decomposition as commentary, so an unexpected authored flag cannot be silently
reinterpreted.

### `NAME_Camera`

Name index `0xa2` is `Camera`.  The hard-coded name table entry is registered at
`0x1014c312`–`0x1014c32c`, pushing index `0xa2` with the wide string at
`0x101ac24c`, read from the installed image as `Camera`.  The neighbouring
entries confirm the indexing (`0xa0` `StackNode`, `0xa1` `Property`).  This is
the legacy gate that refuses to construct exports whose class is named
`Camera`.  It is inert for every class export, because a class export's
`LoadClass` is always the `Core.Class` metaclass, whose name is `Class`; the
module still evaluates it and reports it in the trace rather than dropping it.

## Metaclass route

For a class export, `Export.ClassIndex` is `0`.  `IndexToObject(0)` returns
`NULL`, so `LoadClass` becomes `UClass::PrivateStaticClass` (`0x101f1c18`) —
the same hard-coded metaclass identity
[`script-object-serialization.md`](script-object-serialization.md) already
pins.  `StaticConstructObject` therefore allocates through the `UClass` native
constructor, the `IsA(UStruct)` test passes and installs `SuperField` from
`Export.SuperIndex`, and the `IsA(UClass)` test passes and calls
[`UClass::Bind`](script-class-bind.md), which copies the nearest native
`ClassConstructor` down the chain.

`CreateExport` does **not** serialize the export's own bytes.  It leaves
`RF_NeedLoad` set; the field chain, defaults and `Link` order are produced when
the object is later preloaded through the linker archive.  This module
therefore ends at `Bind` and exposes the constructed, `RF_NeedLoad`-marked
object; the preload/serialize/link stage is the caller's, and
`scripts/validate-create-export.mjs` drives it through the existing
`script-class-serialization.mjs` / `script-class-link.mjs` services.

## Boundaries kept explicit

* `IndexToObject`, `Preload`, `StaticConstructObject`, `SetLinker`,
  `GetFullName` and `Logf` remain host services with the native addresses
  recorded in the contract.  This module owns only the order, the gates, the
  flag arithmetic, the `IsA` loops and the two writes.
* The `appUnwindf` tail (`0x1012e43b`-`0x1012e4a2`) is the structured-exception
  unwind path.  It is not executed on a successful load and is not translated;
  a host that needs it must bind the unwind services itself.
* `GObjLoaded` insertion uses the existing `loadedArrayData` (`0x1029e638`)
  identity from `script-static-load-object.mjs`; the reallocation policy is the
  same `FArray::Add(1, 4)` boundary that module already exposes.

## Validation

```text
node scripts/validate-create-export.mjs
```
