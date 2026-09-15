# Original startup log — the authoritative class-bind reference

This note records what the **shipped game itself** logs during a full package
load, measured from a real run. It exists to settle one recurring question:
*does the original emit `Can't bind to native class X` warnings, and for which
classes?* The answer, measured, is **none** — a clean retail startup binds
every class without a single such warning.

Use this as the ground truth whenever a reimplemented load path produces
`Can't bind to native class` (or any other class-bind) warnings: the original
does not, so those warnings are a defect in our model, never expected original
behavior.

## The capture

A complete startup-to-exit run of the installed GOTY `DeusEx.exe` under the
CrossOver `DeusEx` bottle, `Version: 1100`, `Compiled: Jan 29 2001 16:45:52`.
The run opened at `09/13/26 10:52:24` and closed cleanly at `10:53:09`.

* **Bottle:** `/Users/gcc/Library/Application Support/CrossOver/Bottles/DeusEx`
* **Game install inside the bottle:**
  `…/CrossOver/Bottles/DeusEx/drive_c/Deus Ex GOTY Edition/System/`
* **Wine binary:**
  `/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine`
  (launch with `CX_BOTTLE=DeusEx`; the same route used for
  [live GObjObjects capture](../.cache) and the
  [x87 transcendental probe](script-string-transcendental.md))
* **Original log:**
  `…/drive_c/Deus Ex GOTY Edition/System/DeusEx.log`
  (the game rewrites it every run). A copy of the exact run described here is
  kept at `.cache/original-startup-deusex.log` (gitignored — it is a local
  capture, kept out of Git per AGENTS.md), SHA-256
  `18a67c73cf4187fc8657bd52307892450130b7eaed5236424f918d9bd576a350`.

To regenerate: launch the game in the bottle to the main menu and quit; the
class-bind pass runs during package loading, well before the menu, so even a
short run captures it. Read the warnings with
`grep "Can't bind to native class" "$SYS/DeusEx.log"`.

## What the clean run establishes

The startup binds every native DLL and loads all **46** shipped packages:

```
Bound to: Engine Core Window DeusEx Extension ConSys Fire IpDrv DeusExText
          WinDrv Render D3DDrv Galaxy   (.dll)
Loading:  DeusEx Core Engine Extension DeusExCharacters DeusExUI DeusExItems
          Effects Fire ConSys DeusExSounds DeusExDeco UBrowser UWindow IpDrv
          DeusExText Ambient MoverSFX IpServer MPCharacters …   (46 packages)
```

Counts over the whole run:

| measure | value |
| --- | --- |
| `Loading: Package` lines | 46 |
| `Can't bind to native class` lines | **0** |
| any `warning`/`can't`/`failed`/`error` lines | 1 (`Best-match display mode … (Error=320)` — a resolution score, not a bind error) |

`DeusEx.u` is among the loaded packages, so classes like `DeusEx.Augmentation`
are processed in this run and still produce no bind warning.

## Why there are no warnings — the recovered `UClass::Bind`

The `Can't bind to native class %s` string is at `0x101a9cf4` (Core.dll,
UTF-16). It is pushed once, at `0x10127b34` inside `UClass::Bind`:

```
0x10127b2d  mov  ecx, [0x101a7c38]     ; GWarn (the warning device)
0x10127b33  push eax                    ; the class name
0x10127b34  push 0x101a9cf4             ; "Can't bind to native class %s"
0x10127b39  push ecx                    ; GWarn
0x10127b3a  call 0x1010280b             ; GWarn->Logf  (varargs warn)
0x10127b3f  add  esp, 0xc               ; cdecl cleanup — NON-FATAL
0x10127b42  mov  eax, [esi+0x4e0]       ; ClassConstructor (still 0 here)
0x10127b48  test eax, eax ; jne 0x10127b66
0x10127b4c  mov  edi, [esi+0x28]        ; SuperField
0x10127b57  call [edx+0x5c]             ; Super->Bind()  (vtable +0x5c)
0x10127b5a  mov  eax, [edi+0x4e0]       ; copy Super's ClassConstructor
0x10127b60  mov  [esi+0x4e0], eax       ; …into this class
```

Two facts follow directly from the bytes:

1. The warning is a non-fatal `GWarn` call (`0x101a7c38` is GWarn, the same
   device `StaticConstructObject` receives in
   [`script-create-export.md`](script-create-export.md)), **not** an
   `appErrorf`. Execution continues.
2. It fires **only** when the class's `ClassConstructor` (`+0x4e0`) is still
   null after the registration lookup. In the real game those slots are
   non-null: binding `Extension.dll`, `ConSys.dll`, `Fire.dll`, `IpDrv.dll`,
   `DeusExText.dll`, `Window.dll`, … runs each DLL's `IMPLEMENT_CLASS`, which
   installs the constructor. So the branch is never taken, and a script-side
   `native` class inherits its constructor silently through the fall-through.

## Consequence for our reimplementation

* A load/preload path that emits `Can't bind to native class X` has an
  **incomplete native-class registry** — the class *is* registered, in one of
  the DLLs the original binds. Complete
  [`script-native-class-registry.mjs`](../src/runtime/script-native-class-registry.mjs)
  so the constructor resolves. Do **not** reclassify the warning as expected.
* A validator asserting **zero** class-bind warnings is correct: it matches this
  measured clean run. Weakening it to accept warnings would make the
  reimplementation diverge from the original, which is the opposite of the goal.
