# Window script event dispatch

Original Extension.dll SHA-256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`
exports `XWindow::ProcessScript(FName,void*,int)` at `1004ded0`.
CreateNewWindow calls it with the FName in `1009b3a4`, null parameters and
literal third argument1. The DLL initializer at `10022abb–10022ad3` interns
UTF-16 `InitWindow` at `10098388` in mode2 and writes that global.

The third argument selects checked function lookup; it is not a latent flag.
When nonzero, `1004df07` calls the Core FindFunctionChecked import at
`100591a4`, otherwise `1004df15` calls FindFunction at `100590e0`. Both
receive `(eventName, 0)` with the window as receiver. A non-null function
then goes to the same receiver's vtable slot+10 with `(function, parameters,
NULL result)` at `1004df2a`; null lookup skips event dispatch. The wrapper
has no meaningful return value. Exception unwinding remains unsupported.

Core.dll (SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`)
FindFunctionChecked at `10150bf0` first reads **GIsScriptable** (`101e5540`),
returning null when zero. FindFunction at `10150bb0` does not read that global.
Both use FindObjectField `10150b50` with flag0: active-state lookup precedes
class lookup. Both require the returned field's class chain to reach
UFunction (`101f1718`). Checked missing/invalid lookup logs through GError;
that diagnostic remains unsupported. Existing linked runtime method lookup
supplies canonical UFunction records; raw field hash construction remains
covered by the separate runtime lookup contract.

Core ProcessEvent independently rereads the same GIsScriptable global at
`1013f7eb`, exiting at `1013f804` when zero. Thus unchecked lookup can find a
function while its ProcessEvent body still skips execution. Shared runtime
lookup and event dispatch read the same configured scriptability provider
freshly; the checked lookup result must not cache or override this second gate.

The translation requires explicit scriptability, lookup and ProcessEvent
services, preserving the selected function identity and exact null
parameter/result arguments. It does not replace subclass InitWindow
bytecode or claim that native UI construction is complete.

The original DataLink child event is DeusEx.HUDInfoLinkDisplay.InitWindow
(export18645, 27 expanded bytes). It calls Super.InitWindow, SetSize(431,114),
then CreateControls. Its superclass HUDBaseWindow.InitWindow (export194,
37 bytes) first calls the empty Extension.Window.InitWindow (export80,
2 bytes), then assigns `player = DeusExPlayer(GetRootWindow().parentPawn)`
and invokes StyleChanged. Thus GetRootWindow (Extension export1171,
native1425) is the first native reached inside this script event. The full
CreateControls body creates Window, StaticWindow, TextWindow and
ComputerWindow children. The composed preview constructs and configures
`winPortrait`, `winStatic` and native TextWindow `winName`, then stops at the
following `winQueued` allocation; see [Window text](script-window-text.md).

Focused validation executes unchanged ProcessScript and both Core lookup
bodies against initialized class/function hash fixtures. Four cases compare
checked/unchecked found functions, unchecked missing function and checked
GIsScriptable=false. ProcessEvent is the explicit leaf in that probe; a
separate shared VM check invokes prepared original Window.InitWindow with
the same canonical function identity.

Shared native1410 uses this bridge when no explicit ProcessScript leaf is
provided. GIsScriptable uses the configured windowLifecycle.isScriptable
service, or the runtime's existing eventsEnabled state when no provider is
installed. Lookup and ProcessEvent share this same source. The bridge supports null native parameter blocks and retains
the selected UFunction through ProcessEvent; other raw parameter layouts are
unbound. The DataLink fixture executes the three original InitWindow bodies,
traverses the recovered GetRootWindow1425 parent chain, writes the canonical
player, executes the prepared StyleChanged/theme bodies and native
SetSize1431. Its prepared CreateControls body completes `winPortrait`,
`winStatic` and `winName`, then reaches the explicit `winQueued` allocation
boundary.
