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
| D3DDrv.dll | `9e0f8a42…d8ac9f` |

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
| `UD3DRenderDevice::Exec` (D3DDrv `0x100061b0`; the device Play follows) | `URenderDevice::Exec` (2 keywords), then GetRes, LodBias, ShowPools |
| `UGlideRenderDevice::Exec` (GlideDrv `0x107010cd`; the installed ini's device, not dispatched by Play) | `URenderDevice::Exec`, then TMUDETAIL, GetRes, GetColorDepths; pinned in the validator only |
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

### SET of a script class

`UObject::StaticExec` SET (Core `0x101532da`) finds the class with `StaticFindObject(UClass, ANY_PACKAGE)`, so a script class works too
(`set JCDentonMale ViewRotation (Pitch=-10130,Yaw=49096,Roll=0)`, the live-scene captures' way to aim the player; the original also
accepts `set DeusEx.JCDentonMale ...`). It then runs `UObject::GlobalSetProperty(value, class, property, offset, 1)` (`0x101523a0`):
for every object in GObjObjects that IsA the class, `ImportText` of the value into the property and `PostEditChange` (vtable `+0x40`),
then the same text into the class defaults and `SaveConfig(CPF_Config)`. For an Actor, `PostEditChange` is `AActor::PostEditChange`
(`0x10369140`): `UObject::PostEditChange` and a flag written only when the editor global is set, a no-op in the game.

Play (`scriptClassSet` in `script-console-command.mjs`) imports the value into every live actor of the player's level that IsA the class,
for int (`UIntProperty::ImportText`, appAtoi only when the text starts with `-` or a digit), float, bool, name, and the Rotator and Vector
structs over int/float members (`importNumericStruct`, the member loop of `UStructProperty::ImportText`). Not modelled, and said so: the
import into the class defaults and the `SaveConfig` (a later instance made from the defaults, such as the Player start's second Login,
does not carry the value), objects that are not live actors of that level, and every other property kind (they throw
`UnsupportedConsoleCommandError`). `validate-console-command` covers a rotator, a partial rotator, a bool through a superclass name, an
unknown property and an unlinked kind.

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
* Browser key edges go through `game.inputKey` and the native `InputEvent`
  route. W/A/S/D and the other installed key bindings run their `User.ini`
  aliases through UInput::Exec; `BUTTON`, `PULSE`, `TOGGLE` and `AXIS` update
  linked actor fields. Mouse axes enter through `MouseX`/`MouseY` bindings.
* Other installed bindings include Escape `ShowMainMenu`, F1
  `ShowInventoryWindow`, F2 `ShowGoalsWindow`, Tab `DropItem`, and F3–F12
  `ActivateAugmentation N`.
* WinDrv's focus path calls the complete `UInput::ResetInput` body
  (`0x10394910`), which clears held keys, CPF_Input byte/float properties and
  Action/Delta, then calls `UWindowsViewport::UpdateInput(1)`. The window host
  translates the keyboard portion using its separate physical-key snapshot.
* `ScriptConsoleExec`'s executor rule (`0x10150978–0x101509df`) is now
  translated, because `UPlayer::Exec` passes the Actor. Only the first
  parameter takes the executor, and only when it is an object or class
  property whose `PropertyClass` is null or an ancestor of the executor's
  class.

Explicit boundaries (`UnsupportedConsoleCommandError`):
* Exec keywords outside the implemented input commands, KEYNAME, KEYBINDING
  and FLUSH.
* A binding that fails after an earlier line of it already ran is marked
  `partial` and pauses Play.
* A logging command reached from a key, because the Console output device
  is not linked.
* A net or demo driver on the level.
* The Y/N remap.

Alias expansion of movement keys now runs through the same recovered UInput
command path as other bindings.

### Original input sampling recovered for Stage 3 batch 6

The original Engine.dll bodies are in `.cache/reference/readInput.asm`
(`UInput::ReadInput`, body `0x10394580`) and `.cache/reference/Engine.asm`
(`UInput::ResetInput`, body `0x10394910`). The latter disassembly is included
here because the focused `readInput.asm` capture ends before ResetInput. The
Engine.dll SHA-256 is
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`.

`UInput::ReadInput(float Delta, FOutputDevice&)` recovers this order:

1. It gets the viewport through `UInput+0xea0`, then the Actor through viewport
   `+0x30`. A missing viewport takes an assertion/log path and is unsupported.
2. It counts the Actor's `CPF_Input` properties (flag `0x4`) by walking the
   linked class property chain, allocates a pointer array for that count, and
   fills it with the matching property descriptors in the same order. The
   comparison is against the exact double constant `-1.0` at
   `Engine.dll+0x10429c58` after loading Delta as float32. For a non-sentinel
   Delta, it calls **UInput** `Process(FOutputDevice,key,IST_Hold=2,Delta)`
   through the input object's vtable `+0x60` for each nonzero held byte at
   `UInput+0xeb0+key`, ascending key `0..254`. The comparison's equality flag
   skips replay; unordered NaN takes the zero-scale path. The second ReadInput
   argument is its FOutputDevice.
3. It leaves an x87 extended-precision scale on the FPU stack. For
   `Delta != -1.0f`, x87 `fdivr` computes the double constant `20.0`
   (`+0x1042e4e0`) divided by float32 Delta. For
   `Delta == -1.0f`, it loads the double zero at `+0x10429838`. It walks the
   collected properties in order and selects only `FloatProperty` entries,
   reading the class test via the original property ancestry. Each selected field at property offset
   `+0x48` is multiplied by the scale with x87 `fmuls`, then stored by
   `fstps` (float32). Thus the sentinel path zeros those float values; zero
   Delta takes the non-sentinel path and reaches native divide-by-zero
   behavior. Byte input properties are skipped.
4. It updates the native garbage-collection counter and returns. ReadInput
   does not clear Action/Delta and does not call `ProcessInput`.

The `UInput::Exec` entry has an adjusted `FExec` subobject receiver. The
offsets below are normalized to the complete UInput object; the native body
compensates for that subobject adjustment before reading UInput fields or
calling its virtuals. Array properties use only element zero: the native
address is `Property+0x48` and does not iterate `ArrayDim`.

The wrapper is Engine export `UViewport::ReadInput` (`0x10374990`, thunk
`0x10303733`). It asserts when the viewport's Input at `+0x60` is null. It
compares float32 Delta with the same exact double `-1.0`; unless equality or
unordered, it calls viewport vtable `+0x7c` `UpdateInput(0)`. It then loads
`GLog` through Engine IAT `0x10599bbc` and calls Input vtable `+0x64`
`ReadInput(Delta,*GLog)`. Thus the per-tick call order is platform sampling,
held-key replay, then axis scaling; sentinel `-1` skips only the platform
sampling wrapper and still calls UInput::ReadInput.

`UInput::ResetInput()` is separate. Engine.dll `0x10394910` clears the same
255 held bytes, then gets the viewport through `+0xea0` and Actor through
viewport `+0x30`. It makes two property passes derived-to-base: the first
zeros one byte for each `CPF_Input` `ByteProperty`; the second selects
`FloatProperty` entries that `IsA(FloatProperty)` and zeros the full four-byte
float. Both passes write only the first array element at `Property+0x48`.
It then clears Action and Delta at `UInput+0xea8/+0xeac` and calls the
viewport's vtable `+0x7c` with `1`; this is WinDrv `UWindowsViewport::UpdateInput`
(`0x11109280`), not Actor.ProcessInput. The level-tick CPF_Input
FloatProperty pass (`runtime.resetActorInput`) also writes float-sized zeros
after `PlayerInput`.

`UInput::Exec` (`Engine.dll+0x10393e10`, `.cache/reference/inputExec.asm`)
recovers BUTTON, PULSE, TOGGLE and AXIS. Each command gets its Actor from the
viewport at `UInput+0xea0` and viewport `+0x30`. Button-family lookup uses the
UInput object's virtual `FindButtonName` at `+0x74`; AXIS uses its virtual
`FindAxisName` at `+0x78`.

* BUTTON, PULSE and TOGGLE get the Actor through `UInput+0xea0` → viewport
  `+0x30`, parse the property name using `ParseToken(256, no escapes)`, find it
  through UInput virtual `FindButtonName` at `+0x74`, then address its byte at
  `Property+0x48`. Both virtual lookups use UInput's cached Actor properties
  that carry `CPF_Input` (`0x4`); byte commands require ByteProperty and AXIS
  requires FloatProperty. BUTTON sets it on
  Action 1 and clears it on Action 3 only when it was set. PULSE sets on
  Action 1. TOGGLE xors bit `0x80` on Action 1. These are byte properties
  such as bFire, bDuck, and bRun, not BoolProperty. Other actions do not write.
* AXIS parses its property name with `ParseToken(256, no escapes)`, then
  parses optional `Speed=` text with Core `Parse`. Omitted Speed retains its
  initialized `1.0`. It accumulates into the resolved float field. The body
  then multiplies the input object's `+0xe84`
  float (Delta) by it. Native action/type is read at `+0xe80`: type 4 computes
  `prior + (Delta * Speed * 0.01)` with x87 operations and float32 store; type
  2 omits the `0.01` factor. The state action and delta set around
  `ExecInputCommands` are at `+0xea8/+0xeac` in the Extension Process caller.
  This comes from `0x10394038–0x10394085`; the factor is the original double
  `0x10429858 = 0.01`.
* Missing actor/property, unsupported axis type, parse errors and original
  warning/log output are explicit boundaries until the linked reflection and
  output paths cover them.

`scripts/native-input-console-oracle.py` executes original Engine.dll
instruction slices under Unicorn after verifying their bytes against the
installed image. `scripts/validate-native-input-console.mjs` compares the
translation with the native outputs. The oracle covers BUTTON press/release,
TOGGLE xor, AXIS action 2/4 arithmetic, and ReadInput scaling, sentinel and
zero-delta values. It does not execute full Exec, ReadInput or ResetInput
methods; Pulse release, held-key order and property filters remain
assembly-derived checks.

Instruction-derived original reference cases are: (a) two set held bytes
replay at indexes in ascending order for `Delta=0.05`, while `Delta=-1` skips
replay; (b) a FloatProperty input value of `3` scales to `1200` at
`Delta=0.05` and to zero at `Delta=-1`, while a ByteProperty is skipped;
(c) BUTTON press/release stores `1`/`0`, PULSE release leaves the byte
unchanged, and TOGGLE press xors `0x80`; (d) AXIS action 2 versus 4 applies
the native `0.01` factor difference; and (e) ResetInput separately clears
input bytes and float DWORDs, clears Action/Delta, then calls
UWindowsViewport.UpdateInput(1).

The WinDrv body at `0x11109280` in `.cache/reference/win-update-input.asm`
implements `UpdateInput(mode)`. It polls joystick buttons/axes, then samples
mouse coordinates, stores the current integer coordinates in viewport fields
at `+0x1b0/+0x1b4`, and compares them with the prior sample at
`+0x1a4/+0x1a8`. A changed X sends
`CauseInputEvent(IK_MouseX=0xe4, IST_AXIS=4, DeltaX)`; changed Y sends
`IK_MouseY=0xe5` with the negated integer delta. Keyboard reconciliation
follows the mouse sample. The browser host accumulates
integer relative X/Y deltas and delivers one pair at the next `UpdateInput`;
its event timing and OS cursor/DPI quantization remain platform differences.

For a nonzero mode, it compares
the focused window handle with the viewport's handle and keeps the keyboard
query flag only when they match. It visits key indexes `0..255`, skips indexes
already handled by earlier device paths, and calls the `user32!GetKeyState`
import (`WinDrv IAT 0x1111ecfc`); the high bit reports down. For a key whose
UInput held byte is clear, a down result sends `CauseInputEvent(Press)` only
when the focused-window flag is set. For a held key, an up result sends
`CauseInputEvent(Release)` even when that flag is clear. Mode `0` therefore
only releases stale held keys; mode `1` also presses physically-down keys when
the viewport is focused. The browser host maintains an event-fed 255-key
physical state snapshot. `UpdateInput(0)` reconciles key releases; after
ResetInput, `UpdateInput(1)` replays still-down snapshot entries in key order.
Blur/hidden clears the snapshot before ResetInput. Joystick polling and keys
>=255 remain outside this browser adapter. The installed User.ini binds
`MouseX=Axis aMouseX Speed=6.0` and `MouseY=Axis aMouseY Speed=6.0`; WinDrv
converts vertical motion to the negative axis direction.

Assumed, not traced: that the viewport's `RenDev` is the configured
`GameRenderDevice` (WinDrv's device selection was not traced).

## Play menu and pause integration

The original `UIPauseGame` → `PlayerPawn.ShowMenu` → `SetPause(true)` path
sets `Level.Pauser` from the player's `PlayerReplicationInfo`. Play startup
now runs the original Login/PRI setup, and the pause scheduler is verified at
the level boundary. See [script-player-login.md](script-player-login.md),
[script-level-tick.md](script-level-tick.md), and
`scripts/validate-play-frame.mjs` for those integration checks.

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
  * W reaches its installed User.ini alias;
  * mouse deltas accumulate until UViewport::ReadInput and yield native
    `aMouseX`/`aMouseY` increments with the vertical sign;
  * `ConsoleCommand` answers FLUSH, KEYNAME, KEYBINDING and an unknown
    command, and stops at OPEN, `obj list` and `stat fps`;
  * F1 opens the inventory screen.

`node scripts/validate-native-input-console.mjs` runs the original Engine.dll
instruction-slice oracle and compares BUTTON/PULSE/TOGGLE, AXIS, ReadInput and
ResetInput translation cases, including the AXIS default Speed and array
property element writes.

One difference from Core is not reproduced. A quoted `ParseToken` with
escapes that ends in a backslash makes the original step past the string's
terminator and read the memory after it; the browser string ends instead.
