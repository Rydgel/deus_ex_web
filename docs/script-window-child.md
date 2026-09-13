# Window child construction contract

This document records the bounded `Extension.Window.NewChild` native boundary
used by the normal `DataLinkPlay.StartConversation` display path.  The host
translation in `src/runtime/script-window-child.mjs` owns only the recovered
`XWindow::CreateNewWindow` call order and the small Lock/Unlock bodies.  Core
object construction, class-selected constructors, `XWindow::Init`, script
event dispatch, visibility, and reconfiguration stay explicit synchronous
services.

## Original evidence

The installed GOTY `Extension.u` is package version 68.  Its `Window.NewChild`
export is **2126**.  The UFunction tail reports native index **1410**, flags
`0x401` (`Native | Final`), and the parameters:

    native final function Window NewChild(class<Window> NewClass,
                                          optional bool bShow);

The return property is an `ObjectProperty` of `Window`; `NewClass` is a
`ClassProperty` whose meta-class is `Window`; `bShow` has `OptionalParm`.
The function has no script implementation to translate.  The global object
listing also places `Function.NewChild` at inspection slot 8980; that slot is
separate from package export 2126 and native index 1410.

`Extension.dll` (SHA-256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`, preferred
image base `0x10000000`) exports the native registration cell
`intXWindowexecNewChild` at `0x10098f5c`.  The cell contains the thunk pointer
`0x10051860`, whose decorated symbol is
`?execNewChild@XWindow@@QAEXAAUFFrame@@QAX@Z`.  The thunk parses the two
operands through the Core `GNatives` table, supplies `bShow = true` when the
optional operand is absent, calls the helper below, and writes its result to
the VM return slot.

The helper is the exported decorated symbol
`?CreateNewWindow@XWindow@@SAPAV1@PAVUClass@@PAV1@H@Z` at
`0x1004df70`.  The following body and call addresses are all preferred-base
addresses from the hash-checked binary:

| Operation | Address |
| --- | ---: |
| Core `FName(EName)` IAT | `0x10059124` |
| Core `StaticConstructObject` IAT | `0x10059150` |
| `XWindow::Init` vtable slot | `+0x54` |
| `XWindow::LockWindow` | `0x1004c140` |
| `XWindow::UnlockWindow` | `0x1004c150` |
| `XWindow::SafeDestroy` | `0x1004c0b0` |
| `XWindow::ProcessScript` | `0x1004ded0` |
| `XWindow::SetVisibility` | `0x1004c7d0` |
| `XWindow::AskParentForReconfigure` | `0x1004e060` |
| `EXTENSION_InitWindow` FName global | `0x1009b3a4` |

## Recovered body

The native body first checks `NewClass`.  A null class returns `NULL` without
touching any construction or lifecycle service.  Otherwise it constructs
`NAME_None` and calls the Core import with the stack arguments:

    StaticConstructObject(NewClass, Parent, NAME_None, 0, NULL, *GError)

A null result returns `NULL` immediately.  On success the body calls the
child's vtable slot `+0x54` with `Parent`; the recovered `XWindow::Init` body
is deliberately a host service at this boundary.  The helper then executes
this exact sequence:

    child->LockWindow();
    child->ProcessScript(EXTENSION_InitWindow, NULL, 1);
    if (bShow)
        child->SetVisibility(1);
    child->AskParentForReconfigure();
    beingDestroyed = ((child->Flags & 0x10) != 0);
    child->UnlockWindow();
    return beingDestroyed ? NULL : child;

The `Flags` read is at `child + 0x30`, and it occurs **before** UnlockWindow.
The bit is `bBeingDestroyed`.  `LockWindow` increments `child + 0x34`
(`lockCount`).  `UnlockWindow` reads the count once; when it is positive it
decrements it, rereads `child + 0x30`, and calls `SafeDestroy` if bit `0x10`
is set.  With a nonpositive count it performs no decrement and no flag read.
The translation keeps these small bodies, while the SafeDestroy operation is
an explicit service because its destructor/parent graph is outside this
bounded helper.

The `Init` body itself initializes the packed flags/count and, for a non-null
parent, links the child through `AddChild(child, 1)`, `ChildAdded(child)`, and
each ancestor's `DescendantAdded(child)`.  Those calls are evidence for the
separate Init-vtable boundary; this task does not reproduce them.

## Host boundary

`createNewWindowNative({newClass, parent, bShow, errorDevice}, services)`
requires synchronous callbacks for `StaticConstructObject`, Init-vtable,
ProcessScript, SetVisibility, and AskParentForReconfigure, plus `read` and
`write` callbacks for the two Lock/Unlock fields.  A deletion path additionally
requires `safeDestroy`.  A callback returning a Promise is rejected.  The
static-construction callback receives the exact class, parent/Outer,
`NAME_None`, zero flags, null template, and error-device arguments above.

`ProcessScript` receives the `EXTENSION_InitWindow` event name and literal
third argument `1`; the resolved FName spelling is `InitWindow` (the DLL
initializer interns the UTF-16 literal at `10098388`, then stores the FName at
`1009b3a4`). Its callback may synchronously set `windowFlags` bit
`0x10`.  The helper then samples that bit before UnlockWindow, allowing the
normal and deletion cases to remain distinguishable without fabricating a
full window object.

Shared ScriptRuntime native1410 now routes the prepared original declaration
through this helper. Its `windowLifecycle` option provides the explicit
services and GError device. The wrapper preserves canonical class, receiver
and return identities, defaults an omitted bShow to true as at `10051892`,
and skips visibility for false. In the DataLink fixture the original HUD
body now reaches StaticConstructObject with the canonical
HUDInfoLinkDisplay class, HUD Outer, NAME_None, flags0 and null template.
The unbound construction service throws before infolink is published.

The focused oracle `scripts/native-window-child-oracle.py` maps only the
hash-checked Extension.dll at `0x12000000` in addition to the Engine/Core
images supplied by `native-collision-oracle.py`.  It executes the original
`CreateNewWindow` bytes and intercepts only the construction, Init-vtable,
ProcessScript, visibility, reconfiguration, FName, GError, and SafeDestroy
leaves.  Its null-class, normal-child, and InitWindow-deletion cases are
consumed by `scripts/validate-window-child.mjs`.

Unresolved behavior is intentionally outside this contract: Core's full
`StaticConstructObject` implementation and object registry/GC, the native
class constructor selected for every `UClass`, the live parent/control graph,
and the full SafeDestroy/destructor graph. The separately recovered
[base constructors](script-window-construction.md), [Init](script-window-init.md),
[child links](script-window-hierarchy.md) and [script event bridge](script-window-script.md)
now compose in `scripts/validate-window-lifecycle-integration.mjs` with explicit
allocation, SetFonts, visibility and reconfiguration services. Native bootstrap
and a complete InfoLink display remain unfinished.
