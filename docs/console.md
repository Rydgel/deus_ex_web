# The typed console

The original's console line: **T** (`Talk`) opens `(> Say _` at the bottom left of the picture, the player types, and **Enter**
runs the line through the engine's command chain. This is how cheats are typed in the original (`set DeusEx.JCDentonMale
bCheatsEnabled True`, then `god`, `summon`, ...). Play runs it since 2026-11-02 from the original's bytecode and Engine.dll and
Core.dll bodies. The line and the console's messages are drawn pixel for pixel where the original draws them (below).

Before this, Play entered the console's `Typing` state and collected the characters, but drew nothing, and **Enter paused Play**
with a runtime error (`Console.ConsoleCommand` was not implemented, "Unsupported original door native 0 in
console.typing.keyevent").

## What runs

### Enter: `Console.ConsoleCommand`

`Console.Typing.KeyEvent` on Enter (shipped bytecode, the SDK's `Console.uc`): the line goes into the history, then
`ConsoleCommand(Temp)`; a false result adds `Localize("Errors", "Exec", "Core")` to the console's messages.

* **`UConsole::execConsoleCommand`** (Engine `0x10379900`): `P_GET_STR S`, `P_FINISH`, then
  `Viewport->Exec(S, Ar)` through the viewport's `FExec` (+0x2c, slot 0: `UWindowsViewport::Exec`), with `Ar` the Console's own
  `FOutputDevice` (+0x28). The bool result is Exec's. Play: `consoleConsoleCommand` (`script-input-console.mjs`) runs the existing
  chain (`viewportExec`, [console commands](script-console-command.md)).
* **`UConsole::Serialize`** (`0x10379740`), the Console as an output device: each line is
  `eventMessage(NULL, Line, NULL, Event)` (`0x103797da`). `eventMessage` (`0x1034e2a0`) packs PRI at +0, the FString at +4, its
  third argument at +0x10 and the event name at +0x14, but the shipped `Console.Message` takes PRI, Msg and N (N at +0x10,
  read from the function's parameter chain in Engine.u). So N receives the NULL: NAME_None, and the event name lies past the
  parameters. Play: `consoleOutputDevice` (`script-console-command.mjs`). It is also the device `UEngine::InputEvent` hands
  `Process`, so a logging command reached from a key now writes a console message where it used to stop Play.
* **`Object.Localize`**: `UObject::execLocalize` (Core `0x1013ce00`) and `Localize` (`0x10148430`): GConfig's
  `GetString(Section, Key, "<Package>.<Lang>")`, then `"int"`, else a `No localization` warning and `<?int?Pkg.Section.Key?>`.
  `GetLanguage` (`0x1015aae0`) returns a static buffer built as `int`; the shipped DeusEx.ini and Default.ini both say
  `Language=int`, and another Language is refused (where the launcher calls `SetLanguage` is not traced). GConfig now also
  holds the installed `System/*.int` files, which it reads like the `.ini` files (`script-localize.mjs`; the dev server lists
  them). Core.int `[Errors] Exec=Unrecognized command`.

Commands then behave as the chain already did: `set` of a script class, the player's exec functions (`god`, `ghost`, `fly`,
`walk`, `summon`, ...) with `bCheatsEnabled`, `open`. A keyword the chain claims but does not implement still stops Play by name
([console commands](script-console-command.md), "Explicit boundaries").

`God` itself answers through `ClientMessage`, which `PlayerPawnExt.ClientMessage` gives the root window first: "God Mode on"
appears in the HUD's message log, not in the console's lines. Only what the root window does not take reaches
`Console.Message` (the command chain's own output, such as "Unrecognized command").

### Every frame: the console's part of `UGameEngine::Draw`

`UGameEngine::Draw` (`0x1038f110`) calls, in order: `Render->PreRender`, **`Console->PreRender`** (`0x1038f685`),
`Canvas->Update` (`0x1038f68e`), the actor's PreRender event, `DrawWorld`, the PostRenderFlash event (the HUD's windows),
`RenDev->EndFlash`, **the actor's PostRender event** (`0x1038f73e`), **`Console->PostRender`** and **the console's PostRender
event** (`0x1038f772`).

* **`UConsole::PreRender`** (`0x10379d10`): the console's `Tick` event with
  `Delta = (FLOAT)(Viewport->CurrentTime - Viewport->LastUpdateTime)` (`0x10379d3f..0x10379d62`), then ConsoleLines (+0x724),
  BorderLines (+0x728) and BorderPixels (+0x72c) zeroed and, with ConsolePos (+0x730) above 0,
  `ConsoleLines = _ftol(min(Frame->Y * ConsolePos, Frame->Y))`. `BorderSize` of 2 or more (a smaller view with a border,
  `0x10379dd8`) is not translated and refused; nothing in Deus Ex sets it (`ViewUp`/`ViewDown` are commented out).
  `Console.Tick` ages the messages (`MsgTime` 6 s, then one line a frame) and slides the full console.
  Play: `preRender` in `script-console-level-action.mjs`, from `sim-session.mjs begin` after the light noise (Render's
  PreRender), with the page's frame clock as the mesh lighting uses it.
* **The actor's PostRender**: `PlayerPawnExt.PostRender` calls `PlayerPawn.PostRender`, which spawns `HUDType` when `myHUD` is
  None. Deus Ex's game info leaves `HUDType` None, so it does nothing: `myHUD` stays None. Play runs it every frame. The cast
  `Viewport(Player)` it makes walks the class chain Play attaches to the local viewport (`nativeOnly`, `script-runtime.mjs`
  `castToNativeClass`).
* **`UConsole::PostRender`** (`0x10379f70`) puts back the frame PreRender kept and sets FrameX (+0x738) and FrameY (+0x73c).
  The console's **PostRender event** (shipped bytecode): the border pattern (no world), the time demo, `DrawLevelAction`, the
  full console's background when ConsoleLines is above 0, then `DrawConsoleView` or **`DrawSingleView`**: with `myHUD` None,
  white `MedFont` text, the typing prompt `"(>" @ TypedStr $ "_"` at `(2, FrameY - ConsoleLines - YL - 1)` and up to four
  messages younger than 6 s from `(4, 2)`, 10 rows apart. Canvas text goes through the recovered `StrLen` (464) and `DrawText`
  (465) of the [loading frame](loading-frame.md). `STY_Normal` text is drawn masked: WrappedPrint always sets PF_Masked.
  `Canvas->Update` (the Reset event and the clip) is made just before, after the HUD's paint, which writes none of the canvas's
  script fields.

The page draws the console's tiles after the flash, where it drew the loading frame's (`main.mjs`); only a travel's frame is kept
as the loading frame.

## Checked against the original (2026-11-02, Linux host)

`.work/console/original.sh` (outside Git): the original under Wine (`D3DDrv`, 1280×720 window in the prefix's 1400×860 desktop,
launched on DX.dx's logo flight), **T** and `xyz` posted with `dxinput`, a grab of the X window, then ten Backspaces, `asdfgh` and
Enter, another grab. `.work/console/play-shot.mjs`: Play's original start in headless Chromium (960×720, `?antialias=0`), the same
keys. `compare.py` takes every pixel whose three channels are at least 200:

| line | original | Play | in both |
| --- | ---: | ---: | ---: |
| `(> Say xyz_`, from the frame's bottom-left corner | 95 | 95 | 95 |
| `Unrecognized command`, from the top-left corner | 222 | 222 | 222 |

Both at the same rows and columns (the typing line's box x 2..56, rows 3..11 above the bottom; the message's x 4..101, y 3..11).
In Play, `god` after `set DeusEx.JCDentonMale bCheatsEnabled True` sets `ReducedDamageType` to `All` and the HUD's log says
"God Mode on".

**`scripts/validate-console-play.mjs`** keeps it checked, in worker and inline mode: the two pixel sets above (count, box and the
checksum of the original's set), the console's state and lines (`windowProbe`'s `console.lines` and `cheats`), the cheats, and the
message gone 7 s later. Its cost, measured in inline mode on 00_Training: the console's PreRender under 0.1 ms a frame, its PostRender
0.1 ms (0.2 ms while typing), about 1 % of the 8.3 ms frame budget, in the worker.

## Not done

* **The full console** (Shift+` while typing: `ConsoleDest = 1.0`, the console slides down over a second). Its background is
  `Canvas.DrawTile` (466, `UCanvas::execDrawTile` `0x10377ba0` and `UCanvas::DrawTile` `0x10376160`: the clip against the frame
  with its UV adjustment, the texture's Lock and UV scale), which is not translated: Play stops by name when ConsoleLines
  becomes positive. The border patterns (`bNoDrawWorld`, BorderLines) reach the same native.
* The time demo (`bTimeDemo`) is not reachable from a key in Deus Ex and is not checked.
* `PaintProgress`'s own `UConsole::PreRender` (its Draw's console Tick) is not run on the loading and saving frames.
