# XWindow visibility propagation

This note records the normal bodies of `XWindow::SetVisibility` and
`XWindow::SetChildVisibility` from the installed GOTY `Extension.dll`.
The authority is the unchanged DLL with SHA-256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`.
The focused oracle rebases that image to `0x12000000` while retaining the
original instructions; no public-engine substitute is used.

The InfoLink path also reaches reflected `Window.Show` and
`Window.IsVisible`. Installed export 2123/native 1413 parses an optional
boolean (default true) and passes it to `XWindow::SetVisibility`; its exec
body is `0x10051960..0x100519a6`. Export 2120/native 1415 parses the optional
recursive flag (default true). `XWindow::IsVisible` at
`0x100031c0..0x100031f4` returns bit 0 of `+0x30` locally, or walks the
`+0x138` parent chain and returns false at the first hidden window. The
validator pins these bodies and checks both branches against this recovered
instruction contract.

## Recovered bodies

The normal `SetVisibility(XWindow*,int)` body starts at `0x1004c7d0` and
returns with `ret 4` at `0x1004c85b` (normal byte range
`0x4c7d0..0x4c85e`, body SHA-256
`48adf991456f7b9c81d972c99018c3035a1804c0cb00683a8e75b24983ddbb10`).  It
reads the dword at `this+0x30`, masks bit 0, and
compares that value with the raw integer argument.  An equal value returns
after that one read.  On a change it reads `this+0x138`.  With no parent it
tail-calls `SetChildVisibility(this,newVisibility)` at `0x1004ee20`, so the
child body performs the actual local update.  With a parent it saves the
dword at global `0x100aeafc`, stores the first parent read there, rereads
`this+0x138`, and dispatches the parent's virtual slot `+0x84` with
`(this,newVisibility)`.  The saved global is restored after that synchronous
callback.  The slot is the base `ChildRequestedVisibilityChange` path; its
override body remains a host leaf here.

The normal `SetChildVisibility(XWindow*,int)` body starts at `0x1004ee20`
and returns with `ret 4` at `0x1004eef3` (normal byte range
`0x4ee20..0x4eef6`, body SHA-256
`a9caaeedc0f2aab1dd6c227c5081698217bba304412249f32b73428616fdfb28`).  It
first reads the dword at `this+0x30`, masks bit 0,
and compares it with the raw argument.  An equal value returns.  Otherwise
it computes the effective visibility by reading byte `+0x30` on `this` and
each parent while bit 0 remains set, rereading each `+0x138` link as it
climbs.  It then rereads the full `+0x30` dword and writes the same upper
bits with bit 0 replaced by `argument & 1`:

    newFlags = (oldFlags & ~1) | (argument & 1)

The effective visibility walk is repeated after that write.  If the
effective value did not change because an ancestor remains hidden, the body
returns with no further calls.  When it did change, the callees run in this
exact order:

1. `CheckFocusWindow(this)` at `0x10050b80`;
2. `CheckGrabbedWindow(this)` at `0x10050c90`;
3. read `this+0xb8`, write `this+0xb8 | 1`;
4. `RecomputeInitTree(this,effectiveVisibility)` at `0x10050d70`;
5. `InvokeVisibilityChange(this,effectiveVisibility)` at `0x10050e30`;
6. `ReconfigureTree(this,0)` at `0x1004e520`;
7. `MakeAcceleratorTableDirty(this)` at `0x1004c1d0`.

The first two helpers, tree recomputation, the visibility event dispatch,
tree reconfiguration, and accelerator-table invalidation are explicit
synchronous leaves.  Their native bodies are intentionally not expanded by
this task.  The base `ChildRequestedVisibilityChange` implementation at
`0x10003540` is also a leaf: the translation exposes the parent vtable slot
`+0x84`, callback receiver, child, and bit-0 visibility word without entering
that ProcessScript body.  The `+0x30` writes preserve all unrelated flag bits,
and the `+0xb8` update preserves all unrelated bits as well.  Raw pointers
remain canonical host values; the translation does not replace the native
`+0x138` walk with a JavaScript child array.

## Translation boundary and validation

`src/runtime/script-window-visibility.mjs` exposes both bodies as
`setVisibilityNative` and `setChildVisibilityNative`.  Window fields use
`read(object,offset,kind,details)` and
`write(object,offset,kind,value,details)` with `kind` `u8`, `u32`, or `ptr`.
The global save/restore uses
`readGlobal('global100aeafc','ptr',details)` /
`writeGlobal('global100aeafc','ptr',value,details)`, or the same raw services
against a supplied `globalObject`.  Callbacks are synchronous and receive
canonical object references, the recovered native address, and the exact
virtual slot or raw argument.  Malformed/cyclic parent links and suspended
services are rejected rather than assigned guessed behavior.

`scripts/native-window-visibility-oracle.py` executes the unchanged normal
bodies against the rebased image and intercepts only the leaves listed above.
`scripts/validate-window-visibility.mjs` checks the DLL hash and body bytes,
then compares three focused original executions: a root transition through
the child body including preserved flag bits and leaf order, a hidden-ancestor
transition that updates only the local bit, and a parent transition with two
fresh parent-link reads and global save/restore.  A small local assertion also
checks the no-op guard before the parent link is read.  This validates the
translation boundary; full focus/grab, event, tree, reconfiguration,
accelerator, and subclass override behavior remain outside this bounded task.

The next parent-event bridge is anchored at the original base virtual body
`XWindow::ChildRequestedVisibilityChange`, `0x10003540..0x1000357b`.
It packs the child pointer and bit 0 of the visibility argument into an
eight-byte stack parameter block (preserving the other bits of the local
bool word), reads the event FName from global `0x1009b3e8`, and calls
ProcessScript with third argument zero. The current shared ProcessScript
adapter only accepts a null raw parameter block; this wrapper and its typed
parameter bridge remain explicit follow-up work.
