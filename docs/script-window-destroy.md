# Window destruction contract

This note records the bounded `Extension.Window.Destroy` native path used by
an `InfoLink` window tree.  `src/runtime/script-window-destroy.mjs` owns the
frame guard increment and the recovered `XWindow::SafeDestroy`,
`PreDestroy`, `KillAllChildren`, and `CleanUp` order.  Native pointers and
Core/class lifecycle operations stay explicit synchronous host boundaries.

## Original evidence

The installed GOTY package is version 68.  `Extension.u` export **2129** is
`Window.Destroy`; its UFunction tail reports native index **1409**, flags
`0x401` (`Native | Final`), serial size **27**, and no parameters or script
bytecode.  `Extension.dll` has SHA-256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c` and
preferred image base `0x10000000`.

The body ranges below are hash-checked by the focused validator.  The oracle
rebases the Extension image to `0x12000000` so its calls cannot overlap the
Core and Engine images.

| Native body | Preferred range | Body SHA-256 |
| --- | ---: | --- |
| `execDestroy` thunk | `0x10051830..0x1005183d` | `6b0ef2d88d1e5045d8b7c3ed301cb552f68840fc5aadaf522f296bf28f7b440c` |
| `SafeDestroy` | `0x1004c0b0..0x1004c10c` | `91fb19753e085b7b0646e3c025db32da43ba0bfa35464dd46136d0c2b452380e` |
| `PreDestroy` | `0x10050500..0x1005059f` | `1170ff85f97d821a3adceb41a0db14d6174cb0c8fccf08dd984db7f46176ccf3` |
| `KillAllChildren` | `0x100505d0..0x10050652` | `5c253430609c420c7632510279ed6d12f96c38dc0b44dc55fd177d2a7a7da560` |
| `CleanUp` | `0x1004bec0..0x1004bfda` | `f3d2f014843b27f47b5c47b868b2da6577b8f389a0bb0c63206780bb812d95af` |
| scalar deleting destructor | `0x10004860..0x100048a0` | `3746497d10af00c8ab990bcfc137ef413268088a01731dbeca67af65d5b9c94e` |

The separate complete `XWindow::Destroy` body is at `0x1004c010` and is not
the native1409 wrapper.  It is retained in the metadata as a reference for
the class lifecycle boundary.  The XWindow complete destructor is
`0x100030b0..0x10003117`; the native scalar deleting destructor passes flag
`1` and frees the `0x14c` byte allocation only after that destructor returns.

## Recovered order

The native1409 thunk receives `this` in `ECX` and an `FFrame*` at stack
argument zero.  It increments `FFrame +0x0c`, then calls `SafeDestroy(this)`.
The adapter exposes this as:

```text
frame[+0x0c] = frame[+0x0c] + 1 (uint32)
SafeDestroy(window)
```

`SafeDestroy` always calls `PreDestroy`, then reads the signed lock count at
`window +0x34`.  A positive count returns false and defers the deleting
destructor.  Otherwise it dispatches the scalar deleting destructor at
vtable slot `+0x0c` with flag `1` and returns true.

`PreDestroy` reads the window flags at `+0x30`.  If bit `0x10`
(`bBeingDestroyed`) is already set, it returns immediately.  Otherwise it
walks the bit-`0x01` visible chain through parent `+0x138`; reaching a null
parent calls `SetVisibility(window, 0)`.  It then performs this exact order:

```text
SetSelectability(window, 0)
KillAllChildren(window)
ProcessScript(window, EXTENSION_DestroyWindow, NULL, 1)
virtual CleanUp(window)                 // vtable +0x58
window[+0x30] |= 0x10
```

`KillAllChildren` captures each child's `nextSibling +0x148` before calling
`SafeDestroy(child)`, so a child's `CleanUp` may unlink it without changing
the traversal order.

`CleanUp` first obtains `GetRootWindow(window)` (the root's type byte at
`+0x28` must be at least `3`).  If a parent exists it dispatches
`ChildRemoved` through vtable `+0x6c`, rereads the parent, then dispatches
`DescendantRemoved` through `+0x74` for each reread ancestor.  It clears root
focus `+0x5a0` and root grab `+0x5c4` when either points at the window.  It
then frees the linked GC allocations at `+0x128`, followed by `+0x12c`,
reading each node's next pointer at `+0x1c` before the free.  GC contexts at
`+0x130` and `+0x134` are destroyed with deleting flag `1` and cleared.  The
parent is reread one final time; when non-null, `RemoveChild(parent,window)`
unlinks previous `+0x144`, next `+0x148`, parent `+0x138`, first-child
`+0x13c`, and last-child `+0x140` fields in the native order.

## Adapter boundary

`execDestroyWindowNative({object, frame}, services)` is the VM-facing entry;
`safeDestroyWindowNative`, `preDestroyWindowNative`,
`killAllChildrenNative`, `cleanUpWindowNative`, and
`releaseWindowNative` are exported for lifecycle composition.  `read` and
`write` are synchronous raw storage services with `(object, offset, kind,
details)` and `(object, offset, kind, value, details)` signatures.  Pointer
zero is represented as `null`; unresolved fields, cycles, non-canonical
pointers, and Promise-returning services fail at the boundary.

The following operations remain host leaves because the bounded adapter does
not own their Core or subclass implementation:

* `setVisibility`, `setSelectability`, and `processScript` receive the exact
  native address and arguments above.
* `childRemoved` and `descendantRemoved` receive the virtual slot and object
  identities.  `removeChild` may be supplied as a service; otherwise the
  adapter performs the recovered link writes itself.
* `freeGc` and `destroyGc` own allocator and GC object invalidation.  The
  adapter only advances the two linked slots and clears the two contexts
  after each successful service call.
* `deleteWindow` may own a complete class-specific scalar destructor.  Without
  it, `subclassDestructor` must synchronously call the supplied
  `baseDestructor`; that callback performs the XWindow and XExtensionObject
  vtable/`ConditionalDestroy` sequence, then `uobjectDestructor` and
  `invalidateObject`.  The adapter finally calls `freeObject` with size
  `0x14c` and flag `1`.

The focused oracle and validator are run with:

```text
node scripts/validate-window-destroy.mjs
```

The oracle executes the original body bytes for normal, visible, locked,
pre-flagged, two-child, and GC-list/context cases.  The validator compares
the translated method order and final link/storage state against those
captures, in addition to package metadata, DLL hash, and each body hash.

## Limitations

This slice does not implement class-specific InfoLink destructor fields,
Core's UObject registry/hash/state-frame teardown, allocator internals, or
the full `SetVisibility`, selection, script-event, callback, and GC object
implementations.  The array deleting-destructor flag (`2`), the native
diagnostic/logging branch after the normal child loop, and invalid native
memory are outside the bounded contract.  The adapter rejects cyclic
hierarchies to avoid hanging a browser host; the original native loop has no
equivalent browser-side guard.  No claim is made here that a complete live
DataLink or InfoLink lifecycle is integrated until those explicit services
are wired by the owning runtime slice.
