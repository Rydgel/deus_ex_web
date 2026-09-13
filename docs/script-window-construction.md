# Native window construction contract

This note records the default constructors used by the native `Extension`
window classes.  It is separate from `XWindow::Init` at `0x1004bb30`, which is
the virtual method reached through the window vtable and has its own open
parent/graphics-context graph.  The constructor translation only receives an
already allocated object; Core allocation, object registration, class
selection and `Init` remain caller-owned boundaries.

The authority is the installed GOTY `Extension.dll`, SHA-256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`, at its
preferred image base `0x10000000`, together with the installed v68 package
metadata.  The focused oracle maps this DLL at `0x12000000` after applying its
PE relocations, so the original instructions execute without replacing the
preferred Core or Engine images.

## Metadata and inheritance

The normal HUD display path supplies this source-backed class chain:

```text
DeusEx.HUDInfoLinkDisplay (export 305, flags 0x000f0004, classFlags 0x3a)
  -> DeusEx.HUDBaseWindow (export 301, flags 0x000f0004, classFlags 0x12)
  -> Extension.Window (export 1, flags 0x040f0004, classFlags 0x112)
  -> Extension.ExtensionObject (export 18, flags 0x040f0004, classFlags 0x112)
  -> Core.Object (import -8 from Extension; Core export 3)
```

`HUDInfoLinkDisplay` and `HUDBaseWindow` are script classes with no
independent native constructor.  Core `UClass::Bind` recursively binds their
superclasses and copies the selected constructor pointer down the chain.  The
runtime must use the verified `bindScriptClassConstructor` path for this
selection; this module does not recreate Core's binding, allocator, registry,
or default-property initialization.

`Extension.Window` and `Extension.GC` both expand `ExtensionObject` in the
package.  Their native classes are `noexport`, and their default constructors
are selected by the native class registration.  The relevant package records
are:

| Class | Extension export | Super | native class flags |
| --- | ---: | --- | ---: |
| `ExtensionObject` | 18 | `Core.Object` import `-8` | `0x112` |
| `Window` | 1 | `ExtensionObject` export 18 | `0x112` |
| `GC` | 14 | `ExtensionObject` export 18 | `0x112` |

## Constructor bodies

The decorated symbols and addresses below are from the hash-checked DLL.
Each `InternalConstructor` thunk loads its object argument from
`[esp+4]`, returns immediately for null, and jumps to the corresponding
default body.

| Class | InternalConstructor | default body | native vtable |
| --- | ---: | ---: | ---: |
| `XExtensionObject` | `0x10002770` | `0x10002780` | `0x10059888` |
| `XWindow` | `0x10003120` | `0x10003130` | `0x10059930` |
| `XGC` | `0x10002ce0` | `0x10026ad0` | `0x100598dc` |

`XExtensionObject::XExtensionObject` calls the imported Core
`UObject::UObject` constructor at Extension IAT `0x1005907c`, then stores its
own vtable at object offset `+0`.  It performs no other object writes.

`XWindow::XWindow` calls the same Core constructor, zeroes six consecutive
dwords at offsets `+0xd4`, `+0xd8`, `+0xdc`, `+0xe0`, `+0xe4` and `+0xe8`, then
stores the `XWindow` vtable at `+0`.  These are raw native writes.  The source
declaration identifies this six-dword region with the window clipping record,
but the constructor contract does not initialize the other window fields and
does not enter `XWindow::Init`.

`XGC::XGC` calls the Core constructor first, then executes the following
stores in the original order:

* zero `+0x2c..+0x40` in six dword stores;
* store byte `1` at `+0x44`;
* read the existing dword at `+0x48`, replace only its low byte with
  `(oldLowByte & 0xe2) | 2`, and store the resulting dword;
* store `0x900` at `+0x4c`;
* call `XGC::EnableTranslucentText(0)` at `0x10027610`, which clears the
  translucent-text bit in `+0x48` and stores `0x802` at `+0x50`;
* form and store the default tile/text colors and planes at `+0x54`,
  `+0x58..+0x64`, `+0x68`, and `+0x6c..+0x78`;
* store the default alignment/multiplier/stack values at `+0x7c`,
  `+0x80`, `+0x88`, `+0x8c`, `+0x90`, `+0x94`, `+0x95`, `+0x98`,
  `+0x9c`, `+0xa0`, `+0xa4`, `+0xa8`, `+0xac`, `+0xb0`, and `+0xb4`;
* return `this` after installing the XGC vtable at `+0`.

The color stores are deliberately kept as byte-accurate native behavior.  The
compiler initializes only three bytes of each local color before copying a
dword.  Those locals begin as the `this` pointer, so the fourth byte is the
high byte of the object pointer; it is not a license to substitute an opaque
alpha byte.  Likewise, the constructor's
`+0x48`, `+0x94..+0x95`, and `+0xa4` operations preserve bytes/bits that the
body never writes.  The oracle seeds object storage with a pattern and records
every write, making those preservation cases observable.  A browser adapter
must leave untouched native slots unresolved or preserve them through its raw
storage service.

The exact vtable slot used by `CreateNewWindow` for initialization is the
entry at `XWindowVTable + 0x54` (`0x10059984`), whose contents are
`0x1004bb30`.  That function pointer resolves to `XWindow::Init`; it is
recorded as an address only.  The constructor helper does not call that slot
or translate its body.

## Font assignment used by Init

The same hash-checked DLL's `XGC::SetFonts` at `0x10027640..0x10027654`
loads the normal and bold font pointer arguments, stores normal at `+0x7c`,
then bold at `+0x80`, and returns with eight argument bytes removed. There
are no object reads, callbacks, ownership changes, or null-font branches.
The raw pointer stores preserve the caller's canonical font identity, including
null. `setWindowGcFontsNative` exposes this body through the same raw storage
services as Init. A focused original-body invocation compares both stores and
the surrounding patterned bytes; the lifecycle fixture checks canonical fonts.

## Translation boundary and evidence

The evidence records distinguish each constructor's minimum accessed storage
from the total `nativeObjectSize` passed by original class registration:
ExtensionObject `0x28`, Window `0x14c`, GC `0xb8`. The validator checks the
size-push instructions directly. See [native layout](script-window-layout.md);
the Window constructor's limited writes do not establish its allocation size.

`src/runtime/script-window-construction.mjs` exposes immutable evidence records
and small constructor adapters.  Adapters require a caller-supplied allocated
object, a Core-base-constructor service, and raw read/write services; they do
not allocate, register, copy defaults, bind classes or run `Init`.  Native
slots that are not written by the original body remain untouched.

`scripts/native-window-construction-oracle.py` executes the unchanged original
constructor bytes with patterned storage and records Core-constructor and
`EnableTranslucentText` boundaries.  `scripts/validate-window-construction.mjs`
hash-checks the DLL and package metadata, checks constructor/thunk bytes and
the resolved `+0x54` vtable slot, then compares the oracle's write traces with
the JavaScript adapters.  It also runs the canonical HUD inheritance through
Core's existing `bindScriptClassConstructor` helper.  No test of the local
translation alone is treated as evidence for original behavior.

Unresolved behavior remains explicit: complete Core allocation/registry and
class registration, default/template copying, all subclass constructors,
the full window/control graph, XGC destruction, theme setup and rendering.
The separately recovered Init, child-link helpers and script event bridge
now compose with these constructors in
`scripts/validate-window-lifecycle-integration.mjs`. That fixture retains
explicit allocation/default-initialization and visibility leaves; hidden-window
AskParentForReconfigure now runs through the shared native route. It does not
claim complete UI startup.
