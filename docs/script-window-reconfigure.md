# XWindow parent reconfiguration

This document records the bounded `XWindow::AskParentForReconfigure()` native
body.  The authority is the installed GOTY `Extension.dll`, whose SHA-256 is
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`.

## Original declaration and native body

`Extension.u` is package version 68.  `Window.AskParentForReconfigure` is
export **1958**, a native-final function with native index **1460**, flags
`0x401`, serial size `27`, and no parameters.  The native registration cell
`intXWindowexecAskParentForReconfigure` is at preferred address `0x1009902c`.

The exec wrapper at `0x10052f30..0x10052f3f` increments FFrame.Code at
`+0x0c` once to consume EndFunctionParms, then calls the body without reading
arguments or writing a result. Shared native1460 delegates to this recovered
body with `windowLifecycle.reconfiguration` services. NewChild uses the same
body by default for its final request, while an explicit host callback can
still supply the service boundary. The lifecycle integration checks the
hidden-window path, including the two low reconfiguration bits.

The decorated native symbol is
`?AskParentForReconfigure@XWindow@@QAEXXZ` at `0x1004e060`.  Its ordinary body
occupies preferred RVA `0x4e060` through `0x4e1f2` inclusive (exclusive end
`0x4e1f3`), a 403-byte range with SHA-256
`7791f4adbeeea7faba7bc42c8e13755d249a21b12edcec30d47f66f85d379191`.
The `ret` at `0x1004e1ba` is the early return for an already-hidden chain; the
root and parent paths continue through `0x1004e1f2`.  The exception landing
pad beginning at `0x1004e1f3` is outside the normal body comparison.

The adjacent decorated symbol `?ResizeChild@XWindow@@QAEXXZ` is at
`0x1004eab0`.  The translator leaves its body outside this task.  The base
`XWindow` vtable identifies slot `+0x88` as
`ChildRequestedReconfiguration(XWindow*)` and slot `+0x90` as
`ConfigurationChanged()`; the body calls these slots through the receiver's
vtable and does not substitute their callback bodies.

## Recovered instruction contract

The native body first reads three signed global counters, in this order:

| global | preferred address | normal meaning in this body |
| --- | ---: | --- |
| reconfiguration depth | `0x100aeb00` | recursion/diagnostic counter around root configuration |
| preferred-size depth | `0x100aeb04` | diagnostic-only guard observed before the work |
| granularity depth | `0x100aeb08` | diagnostic-only guard observed before the work |

When any counter is positive, the original code emits a diagnostic through
its `FName`/error logging path and then continues.  That logging graph remains
an explicit host boundary.  A translation must report a positive counter to
an injected diagnostic service or fail explicitly; it must not silently omit
the diagnostic.  The context pointer global at `0x100aeafc` is saved and
restored around each callback and around the recursive call.

The normal body then performs these raw operations in instruction order:

1. Read the dword at `this + 0xb8` and write the same dword with low flags
   ORed by `3`.
2. Walk from `this` while the byte at `current + 0x30` has bit `1` set.  Each
   step rereads the pointer at `current + 0x138`.
3. If that walk stops at a non-null object whose byte bit is clear, return
   without a callback.  This is the ordinary hidden-chain path.
4. If the walk reaches null and `this + 0x138` is null, clear bit `1` in
   `this + 0xb8`, save `global100aeafc`, set it to `this`, increment
   `global100aeb00`, call `this`'s virtual `+0x90`, decrement the counter using
   its fresh current value, and restore the saved context.
5. If the walk reaches null and `this + 0x138` is non-null, reread the parent,
   save/set the context to that parent, and call the parent's virtual `+0x88`
   with `this` as its argument.  Restore the prior context.  A zero callback
   result recursively calls `AskParentForReconfigure` on a fresh
   `this + 0x138`; a nonzero result skips that recursion.
6. After either parent callback result, reread `this + 0x138`, save/set the
   context to that fresh parent, test the byte at `this + 0xb8`, and call the
   explicit `ResizeChild` leaf when bit `1` is set.  Restore the saved context.

The native body does not return a value.  Pointer reads are deliberately raw
native parent links; `UObject.Outer` and script property names are not
substitutes for `+0x138` or `+0xb8`.

## Translation boundary and verification

`src/runtime/script-window-reconfigure.mjs` keeps the field reads/writes and
global reads/writes explicit.  Its callbacks are synchronous leaves:
`parentRequestedReconfiguration`/`childRequestedReconfiguration` for virtual
`+0x88`, `configurationChanged` for virtual `+0x90`, and `resizeChild` for
`ResizeChild`.  The optional `diagnostic` callback owns the three unresolved
error logging bodies.

The focused oracle `scripts/native-window-reconfigure-oracle.py` maps the
hash-checked `Extension.dll` at `0x12000000`, using the existing
`NativeCollision` PE relocation path.  It executes the unchanged body and
intercepts only the virtual callbacks and `ResizeChild` leaf.  The three
reference cases consumed by `scripts/validate-window-reconfigure.mjs` are:

* `normalhidden`: low visibility bit clear, so only the `+0xb8|3` write occurs;
* `rootvisible`: a visible root reaches `ConfigurationChanged(+0x90)` and
  clears the reconfigure bit;
* `parentcallback`: a visible child and parent exercise virtual `+0x88`, the
  zero-result recursive parent call, root configuration, and child resize.

The validator compares the original and translated callback order, fresh raw
reads, exact field/global writes, and final flags.  It also asserts that a
positive diagnostic counter is surfaced as an explicit boundary when no
diagnostic service is supplied.  Callback bodies and `ResizeChild` remain
unverified leaves; no larger window graph is inferred here.
