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

## Play integration: the native window host (2026-09-23)

The native HUD host (`src/runtime/script-window-host.mjs`) now binds this module
for its own windows as `lifecycle.destroy`, so `Window.Destroy` (1409) and
`Window.DestroyAllChildren` (1459, exec `0x10052f00`: `P_FINISH`, then
`KillAllChildren`) run in Play. The InfoLink shell keeps its own services for the
windows it owns; the merged lifecycle routes each call by owner. Each window
family supplies its own virtuals, read from the Extension vtables:

| Family | CleanUp (`+0x58`) | deleting destructor (`+0x0c`) |
| --- | --- | --- |
| Window | `XWindow::CleanUp` `0x1004bec0` | `0x10004860` → `~XWindow` |
| TextWindow | `0x10045c30`: empty the text FString `+0x168`, then XWindow's | `0x10009120` → `~XTextWindow` `0x10008d40` |
| TileWindow | `0x10048430`: empty the 12-byte-element FArray `+0x168`, then XWindow's | `0x100155d0` → `~XTileWindow` `0x10014ee0` |
| RootWindow | `0x10039240`: unlink from the root-window list (global `0x100aa8f8`, next `+0x58c`; the removed root keeps its own next), clear `pawn+0x894` when it still names this root, `RemoveFromRoot`, then `XModalWindow::CleanUp` | `0x100067b0` (size `0x744`) → `~XRootWindow` `0x100059c0`: no root-only members, then `~XModalWindow`'s `+0x17c` table and the tab-group tables |

* `ChildRemoved` (`+0x6c`) is `XWindow::ChildRemoved` `0x100034e0` for every
  family: `ProcessScript(ChildRemoved, &child, 0)`. `DescendantRemoved` (`+0x74`) is
  `XWindow::DescendantRemoved` `0x10003520`, except XModalWindow `0x10037400`
  (the script event, then clearing `+0x178` if it is the child) and XRootWindow
  `0x1003b5c0`. The root first clears `+0x624` (the last button window) with the
  GLog line `Tried to remove lastbuttonwindow descendant. %s`, then runs the modal
  body. XRadioBoxWindow's `0x10038cb0` is not recovered and stays an explicit
  boundary.
* Each deleting destructor runs ConditionalDestroy under its own vtable, then under
  the XWindow and XExtensionObject vtables, then `~UObject`. The first run
  reaches the window's Destroy virtual, `XWindow::Destroy` `0x1004c010`: PreDestroy
  (a no-op, since `bBeingDestroyed` is set), the zero-lock assertion, then
  `UObject::Destroy` (`RF` flag `0x80000000` and ExitProperties). The flags live at
  UObject `+0x1c`. Host windows have no registry slot. Operator delete returns
  the window's image to the host heap, as it does the GC images, GC free-list
  nodes, timer nodes and FArray blocks that `FArray::Realloc` replaces. A
  destroyed window loses its family, so any later native on it is an explicit
  boundary, and its freed address no longer resolves.
* XRootWindow's own Destroy (`0x10039320`) is `XWindow::Destroy`. The root is
  SafeDestroyed by `APlayerPawnExt::Destroy` when a Player start retires the
  old player; KillAllChildren then tears down the whole HUD tree
  ([Player start collection](script-loadmap-gc.md)). The host models
  `AddToRoot`/`RemoveFromRoot` as no-ops, because host windows are not
  GObjObjects records.
* A window's GC contexts go through the XGC deleting destructor: `~XGC`
  `0x10002c70` → `XGC::Destroy` `0x10026d40`. For a window's own GC that is
  PopGC(0), then unlinking and deleting every free-list node (`+0xb0` through each
  node's `+0xac`), with a GLog warning past 16 nodes. Destroying a pushed node
  (owner `+0xb4` set), the GC allocation lists at `+0x128`/`+0x12c`, and the
  CleanUp/destructors of other families are explicit boundaries.

`scripts/validate-datacube-read.mjs` exercises this when a DataCube's paragraph
TextWindows are cleared.
