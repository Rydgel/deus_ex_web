# Local viewport, Console and closing a UI screen

## Original contract (2026-09-24, before runtime wiring)

Authority: installed GOTY Engine.dll SHA-256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`,
WinDrv.dll `9cf2861ca66dabf21db97e44e328aa0a42d85289a35dbad090271c0611f94e1f`,
Core.dll `8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`,
and embedded Engine.u / DeusEx.u scripts. Disassembly obtained with
`tools/disasm-body.py`; original files and research dumps stay outside Git.

* `UGameEngine::Init` (0x103891c0), local-client branch at 0x103896a4:
  calls Client.NewViewport (vtable +0x6c), loads the Console subclass with
  StaticLoadClass using UTF-16 `ini:Engine.Engine.Console` at 0x1047e6b4,
  constructs it (0x103896fa), stores it at Viewport+0x34 (0x10389702), then
  calls Console._Init(viewport) (+0x54). The installed DeusEx.ini
  `[Engine.Engine] Console=Engine.Console` selects Engine.Console.
  SpawnPlayActor follows at 0x1038972f, then Input.Init and OpenWindow.
* WinDrv `UWindowsClient::NewViewport` 0x11102e60 allocates WindowsViewport
  (class 0x1111d540) with the client as Outer and the supplied name, then calls
  its constructor 0x11106900. At 0x11106926 that calls UViewport's constructor.
* UViewport constructor 0x103730b0 calls UPlayer's constructor, appends self
  to Outer.Client.Viewports (+0x2c array, store 0x10373139), creates the
  configured Canvas (+0x5c, Init(viewport)) and Input (+0x60). OS window,
  Canvas, Input and renderer construction are not implemented by this change.
  UPlayer's constructor 0x103d7d10–0x103d7d41 calls UObject construction and
  installs the primary/output/exec vtables (+0, +0x28, +0x2c); it does not
  overwrite Actor or Console. Their initial null values come from the loaded
  Player defaults, before the GameEngine/SetPlayer stores above.
* Viewport's native registration 0x10372370–0x103723d8 pushes **Within=Client**
  (0x10581668 at 0x103723a1), **Super=Player** (0x1058cd68 at 0x103723a6),
  size 0xf8. The previous registry's Super=Client was incorrect. Viewport has
  no Engine.u class export; its reflected script prefix is inherited Player.
  WindowsViewport's platform tail is outside the browser's script projection.
* UConsole::_Init 0x10379650 verifies size 0x810, writes Viewport at +0x2c,
  TopLine=63 at +0x110, BorderSize=1 at +0x720, then calls InitExecution
  (vtable +0x38, thunk 0x1040c710). This creates the no-state FStateFrame
  (Core 0x10150750); it does not enter Menuing or call a script Init event.
  Fields are named using linked UProperty +0x48, not source declaration guesses.
* APlayerPawn::SetPlayer 0x10368c90 clears an old viewport actor's Player,
  sets new pawn.Player (+0x5d4) and viewport.Actor (+0x30), then dispatches
  the possession event. This task wires the identity stores only; it retains
  Play's existing player startup instead of repeating possession.

## Script continuation and original reference cases

Engine.Console.Menuing.BeginState and EndState contain only return/nothing
(two bytes each). Console has no auto state. Its real state storage is required
for Core.Object.GotoState; a host-shaped object is insufficient.

DeusExRootWindow.UnPauseGame writes bUIPaused=False, sets DSTY_None, hides the
snapshot, shows the HUD, clears parentPawn.bShowMenu, calls
parentPawn.Player.Console.GotoState(''), then parentPawn.SetPause(False).
Engine.PlayerPawn.SetPause's original 34-byte function delegates to
Level.Game.SetPause(bPause,self). Neither DeusExPlayer nor DeusExGameInfo
supplies an override. Engine.GameInfo.SetPause's 130-byte function tests
bPauseable || P.bAdmin || Level.NetMode==NM_Standalone. If allowed, true writes
P.PlayerReplicationInfo.PlayerName to Level.Pauser; false writes an empty
string; both return true. Otherwise it returns false without changing Pauser.
Embedded source and decoded bytecode establish these cases before integration:

| Case | Expected result |
| --- | --- |
| Fresh local Console | Viewport backlink; TopLine 63; BorderSize 1; no state |
| Menuing then GotoState('') | empty EndState runs; no state afterwards |
| Standalone, bPauseable=false, non-admin, unpause | Pauser cleared; true |
| bPauseable=true, pause | Pauser becomes replication-info PlayerName; true |
| Non-standalone, non-pauseable, non-admin | Pauser unchanged; false |

The existing DataLink world already attaches a DeusExGameInfo with its original
class defaults and binds Game.Level to LevelInfo. This suffices for these script
reads; it is not a complete GameInfo startup. No synthetic SetPause replacement
is needed. True pause requires valid PlayerReplicationInfo; full paused
Level.Tick scheduling, multiplayer admission and complete GameInfo lifecycle
remain unsupported/unverified by this work. Clearing Pauser on keypad close
must not be presented as verification of those systems.

## Implementation and validation

`script-viewport-console.mjs` attaches the canonical native Viewport class's
inherited Player script prefix to the existing client array entry and creates
an attached Engine.Console from its original class defaults. Actor is one
shared slot for host `.actor` and reflected `Actor` reads. The installed INI
selection is checked; missing configuration or other console subclasses are
explicit construction boundaries. No replacement SetPause implementation is
installed: the existing attached GameInfo executes its original bytecode.

`validate-viewport-console.mjs` checks the reference cases above plus the admin
permission branch, with instruction-byte guards pinned to Engine.dll's hash.
These guards are not a full native-constructor oracle. `validate-keypad.mjs`
checks the integrated close, including leaving Menuing, clearing a seeded
Pauser value, releasing grabs, restoring HUD/style, and preserving native 720,
ConsoleCommand and GetDisplayName readers. The browser check also observed
GRANTED followed by automatic close, restored HUD and an open doorway, with
no browser errors. The Keypad preview needed a small downward aim adjustment
before F; its camera placement has not been changed here.

Full sweep: `NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python npm run
validate -- --jobs 4` completed with **370 passed, 0 skipped, 3 failed** (725 s).
The failures are the pre-existing validate-gameplay and
validate-native-player-sequence Mission01 startup boundary, and
validate-npc-mesh-preview. No additional failures. Local full output:
`.cache/viewport-console-sweep.log` (not tracked).
