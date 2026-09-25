# Console commands and key bindings — 2026-09-25

Escape opened nothing in Play. The viewer released the mouse on Escape and
never consulted `User.ini`. `DeusExPlayer.ShowMainMenu` also started with
`ConsoleCommand("FLUSH")`, an unsupported native. Both reach the same
original code: the viewport's `Exec` chain. This document records that
chain, the key path in front of it, and what Play runs.

Translation: [`src/runtime/script-console-command.mjs`](../src/runtime/script-console-command.mjs).
Check: `node scripts/validate-console-command.mjs` (needs `NATIVE_PROBE_PYTHON`).

## Authority

Installed GOTY binaries, SHA-256:

| Image | Hash |
| --- | --- |
| Core.dll | `8bf3039e…eba7e4` |
| Engine.dll | `0c3a8b18…c20b4` |
| Extension.dll | `93c35502…8b916d9c` |
| WinDrv.dll | `9cf2861c…f94e1f` |
| DeusEx.dll | `b91002f3…0bee04` |
| DeusEx.exe | `3e6fdb89…ae00e` |
| Render.dll | `607f1077…bd75d1` |
| Galaxy.dll | `606e71d1…7d06353` |
| GlideDrv.dll | `50b9f142…4cfe4c` |

The full hashes are in `scripts/native-exec-chain-oracle.py`. The installed
`DeusEx.ini` selects `Input=Extension.InputExt`,
`GameEngine=DeusEx.DeusExGameEngine`, `Console=Engine.Console`,
`GameRenderDevice=GlideDrv.GlideRenderDevice`,
`AudioDevice=Galaxy.GalaxyAudioSubsystem` and `Render=Render.Render`.

## A key press

1. `UWindowsViewport::CauseInputEvent` (WinDrv `0x11108d60`): for a key in
   0–0xfe, `Client.Engine->InputEvent(Viewport, Key, Action, Delta)`
   (vtable `+0x74`). The browser keydown/keyup replaces WM_KEYDOWN/KEYUP; the
   window procedure (Alt+Enter and the rest) is platform code, not
   translated.
2. `UEngine::InputEvent` (Engine `0x103814e0`; DeusExGameEngine keeps it):
   * With a Console and an Actor whose `myHUD.MainMenu` (`+0x628`, `+0x334`)
     is an `UnrealQuitMenu`, Y and N are remapped. Deus Ex never sets
     `MainMenu`; a non-null one is an explicit boundary.
   * `ProcessEvent(Console, KeyEvent(Key, Action, Delta))` — Engine.Console's
     default `KeyEvent` returns false (its Tilde branch is commented out);
     `Menuing` needs `myHUD.MainMenu`. A true result ends the event (a
     release first calls `PreProcess`, which does nothing).
   * Otherwise `Input->PreProcess` (XInputExt `0x1001c680`: returns 1), then
     `Input->Process(Console's FOutputDevice, …)`.
3. `XInputExt::Process` (Extension `0x1002d0b0`):
   * A `PlayerPawnExt` actor's root window (`+0x894`) gets the key first
     (`XRootWindow::Process`, [script-window-input.md](script-window-input.md)).
     If it consumes the key, every key held in the input's table (`+0xeb0`)
     is cleared and a held key with a binding runs it as a release; the
     event returns 1.
   * Otherwise a press of a held key, or a release of a key not held,
     returns 0. Other actions update the table; hold and axis do not.
   * An empty binding (FString at `+0x2ac + 12·key`) returns 0. Otherwise
     Action/Delta (`+0xea8`/`+0xeac`) are set around
     `ExecInputCommands(binding)` (vtable `+0x7c`), and the event returns 1.
4. `UInput::ExecInputCommands` (Engine `0x10393bf0`): only while
   `GIsRunning`. Each `ParseLine(&Cmd, Line, 256, 0)` line runs through
   `Viewport->Exec` when Action is Press, or when it is Release and the line
   starts with `OnRelease`; any other line runs through `UInput::Exec`.

## The Exec chain

`Viewport->Exec` is `UWindowsViewport::Exec`. `PlayerPawn.ConsoleCommand`
(`0x103ba200`) calls the same function through `Player`, into a string
output device whose text it returns.

| Body | Order |
| --- | --- |
| `UWindowsViewport::Exec` (WinDrv `0x11106d90`) | `UViewport::Exec`, then 9 viewport keywords |
| `UViewport::Exec` (Engine `0x10373a60`) | `Input->Exec` (`+0x60`), `RenDev->Exec` (`+0x64`), 11 keywords, `Console->ScriptConsoleExec(Cmd, Ar, Actor)`, `UPlayer::Exec` |
| `UInput::Exec` (Engine `0x10393e10`) | BUTTON, PULSE, TOGGLE, AXIS, KEYNAME, KEYBINDING, then the alias lookup |
| `UGlideRenderDevice::Exec` | `URenderDevice::Exec` (2 keywords), then 3 keywords |
| `UPlayer::Exec` (Engine `0x103d7ed0`) | `XLevel->Exec`; `ScriptConsoleExec` with the Actor as executor on `Level.Game`, `myHUD`, the Actor, each item of the `Inventory` chain; `XLevel.Engine->Exec` |
| `ULevel::Exec` (Engine `0x1039dfe0`) | NetDriver (`+0x3c`), DemoRecDriver (`+0x88`), DEMOREC, DEMOPLAY |
| `DDeusExGameEngine::Exec` (DeusEx `0x1000ed70`) | SAVEGAME, DELETEGAME, `UGameEngine::Exec` |
| `UGameEngine::Exec` (Engine `0x1038a030`) | 10 keywords (SAY only on a dedicated server), `GLevel->Exec`, `Game->ScriptConsoleExec(Cmd, Ar, NULL)`, `UEngine::Exec` |
| `UEngine::Exec` (Engine `0x10380ee0`) | `GSys` (6 keywords), `UObject::StaticExec` (6), `GCache` (1), `GExec` = the launcher's `FExecHook` (7), `Client` (`UWindowsClient` → `UClient`, 1), `Render` (6), `Audio` (Galaxy 6, then its `s_*` helper, 13), FLUSH, CRACKURL |

`EXEC_KEYWORDS` lists every keyword in its original order.
`scripts/native-exec-chain-oracle.py` produces that order. It runs each body
unchanged, with every call stubbed to return 0 and every load symbolic. The
result is the path of a command nothing claims: keyword tests, subsystem
calls and object dispatches, each named by an import/export or by its load
path from `this`. The flags a local client knows are pinned: `GIsClient`,
`GIsServer`, `GIsRunning` and `GIsScriptable` are 1, `GIsEditor` and
`GIsUCC` are 0.

Every literal a body pushes that the trace did not test was reviewed:
* `SAY` is guarded by `GIsServer && !GIsClient`.
* Sub-commands of `DEBUG`, `OBJ`, `STAT` and `REND` are tested only after
  their keyword matched.
* The rest are log formats.

### Aliases

`UInput::StaticInitInput` (Engine `0x103930c0`) builds the input
properties natively:
* a struct `Alias` holding an `Alias` name (`+0`) and a `Command` string
  (`+4`);
* `Aliases[40]` at `+0x2c`;
* one string property per EInputKey name without `IK_` (`+0x2ac + 12·key`).

All are `CPF_Config`. It then runs `LoadConfig(1)`, so `Aliases[i]` comes
from GConfig `[Engine.Input]` in `User.ini`.

`UStructProperty::ImportText` (Core `0x101698b0`) parses each value. Its
members import delimited: `ReadToken(0x1000)` for the string, and
`ReadToken(0x400)` then `FName` for the name. Two original quirks are kept:
* Any `[` subscript fails ("Illegal array element"), because the digit
  scan starts on the `[` itself.
* While skipping an unknown member, each `"` is skipped as one character,
  so a quoted `,` still ends the value.

The escape `\"q` decodes to a NUL, and the C string ends there.

The alias step runs only when not already inside an alias (static
`InAlias`). It takes `ParseToken(256, no escapes)` and a find-only FName.
The first of the 40 entries with that name runs its `Command` through
`ExecInputCommands` with the current Action.

### FLUSH

`UEngine::Exec`'s FLUSH calls `Flush(1)` (vtable `+0x6c`, `UEngine::Flush`
`0x10380cf0`) and logs nothing; `ConsoleCommand` returns `""`. `Flush` runs
`GCache.Flush()`, then `Client->Flush(1)`. `UClient::Flush`
(`0x10375ca0`, which `UWindowsClient` keeps) calls each viewport's
`RenDev->Flush(1)`.

The browser keeps no `FMemCache` items; no translated path stores any. The
render device is the browser renderer, which has no Glide texture cache to
evict. The flush request is counted (`state.flushes`) and handed to an
optional host hook. This is a platform boundary, not game state.

## What Play runs

* `PlayerPawn.ConsoleCommand` goes through `consoleCommand` (the window
  host's native handler). KEYNAME and KEYBINDING, the former input-console
  queries, are now the `UInput::Exec` step of this chain.
* A browser key goes through `game.inputKey`, which runs `InputEvent`. The
  viewer keeps its own stand-ins for the keys whose bindings need the
  unimplemented axis/button system: movement, jump, crouch and walk (W A S
  D Q E, the arrows, Shift, Space, Ctrl). F (use), Enter (fire) and 0–9
  (belt) are kept too. For these keys the table update still happens, the
  root still sees them first, and `hostBinding` replaces only their binding
  step.
* Every other key runs its `User.ini` binding: Escape `ShowMainMenu`, F1
  `ShowInventoryWindow`, F2 `ShowGoalsWindow`, Tab `DropItem`, F3–F12
  `ActivateAugmentation N`.
* When the browser window loses focus or the page is hidden,
  `game.resetInput` runs the first half of `UInput::ResetInput`
  (`0x10394910`), which zeroes the key table. WinDrv calls `ResetInput`
  from its focus handlers, next to `Exec("SETPAUSE 1")`/`("SETPAUSE 0")`.
  Without it, a keyup lost to a focus change would leave its key held, so
  the next press would be ignored. The SETPAUSE exec, the actor
  input-property reset and the exact window-message mapping are not
  traced.
* `ScriptConsoleExec`'s executor rule (`0x10150978–0x101509df`) is now
  translated, because `UPlayer::Exec` passes the Actor. Only the first
  parameter takes the executor, and only when it is an object or class
  property whose `PropertyClass` is null or an ancestor of the executor's
  class.

Explicit boundaries (`UnsupportedConsoleCommandError`):
* Every keyword claim other than KEYNAME, KEYBINDING and FLUSH, including
  BUTTON, PULSE, TOGGLE and AXIS. A claim is found before its handler does
  any work, so the viewer shows a notice instead of pausing. Pressing Alt
  (`Strafe` → `Button bStrafe`) shows one.
* A binding that fails after an earlier line of it already ran is marked
  `partial` and pauses Play.
* A logging command reached from a key, because the Console output device
  is not linked.
* A net or demo driver on the level.
* The Y/N remap.

Not driven:
* `UInput::ReadInput`'s per-tick `IST_Hold` replay of held keys.
* Alias expansion of the host-owned movement keys.

Assumed, not traced: that the viewport's `RenDev` is the configured
`GameRenderDevice` (WinDrv's device selection was not traced).

## Known gap: the menu does not pause Training

`UIPauseGame` → `PlayerPawn.ShowMenu` → `SetPause(true)` writes
`PlayerReplicationInfo.PlayerName` to `Level.Pauser`. Play's player startup
(`script-player-startup.mjs`) does not run `GameInfo.Login` or
`Pawn.PreBeginPlay`, so the player has no PlayerReplicationInfo. `Pauser`
stays empty, and the level keeps ticking behind the menu. The console,
root and menu state are original.

## Checks

`scripts/validate-console-command.mjs`:
* 20 traced bodies and 93 keywords, in order and with their dispatch steps;
* 42 struct `ImportText` cases (the 40 installed aliases plus edge cases),
  12 `ParseLine` and 11 `ParseToken` cases against Core
  (`scripts/native-console-text-oracle.py`);
* in Training:
  * Escape runs `ShowMainMenu` and FLUSH, and opens and draws `MenuMain`
    (DXFonts glyphs, button art);
  * the release and the next Escape are consumed and close it;
  * W reaches its stand-in;
  * `ConsoleCommand` answers FLUSH, KEYNAME, KEYBINDING and an unknown
    command, and stops at OPEN, `MoveForward`, `obj list` and `stat fps`;
  * F1 opens the inventory screen.

One difference from Core is not reproduced. A quoted `ParseToken` with
escapes that ends in a backslash makes the original step past the string's
terminator and read the memory after it; the browser string ends instead.
