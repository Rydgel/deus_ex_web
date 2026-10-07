# Typed characters (WM_CHAR) into the window system — 2026-10-07

Key presses reached the original input path, but typed characters did not.
Nothing could be typed into an EditWindow, list hot keys could not be
reached, and Alt+letter accelerators did not work. This page records the
original route from WinDrv's window procedure to each window's `KeyPressed`,
and what Play now runs.

Translation: [`src/runtime/script-window-typed-keys.mjs`](../src/runtime/script-window-typed-keys.mjs)
(window and engine bodies), `key` in
[`script-console-command.mjs`](../src/runtime/script-console-command.mjs),
and the browser adapter
[`src/viewer/typed-characters.mjs`](../src/viewer/typed-characters.mjs).
Checks:
* `scripts/validate-window-typed-key-diff.mjs` (needs `NATIVE_PROBE_PYTHON`);
* `scripts/validate-window-typed-key-play.mjs` (headless Play);
* `scripts/validate-window-typed-key-browser.mjs` (Chromium, worker mode);
* `test/typed-characters.test.mjs`.

## Authority

Installed GOTY binaries, SHA-256:

| Image | Hash |
| --- | --- |
| WinDrv.dll | `9cf2861ca66dabf21db97e44e328aa0a42d85289a35dbad090271c0611f94e1f` |
| Window.dll | `3d40db1dd7467d94c17bf4ef0fa4cafd1a9d699ac7df7a5526b3961b4642e59d` |
| Core.dll | `8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4` |
| Engine.dll | `0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4` |
| Extension.dll | `93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c` |
| DeusEx.dll | `b91002f3e7658c0562d28bccc887cf9db79a47a19f5e09e8be460c9d0c0bee04` |

Scripts: Engine.u `Console` (`KeyType`, state `Typing`), Extension.u
`Window` (`KeyPressed`, `AcceleratorKeyPressed`), `ButtonWindow`
(`AcceleratorKeyPressed`) and `EditWindow`, DeusEx.u `DeusExRootWindow`,
`CreditsWindow`, `MenuUIEditWindow`, `PersonaNotesEditWindow`,
`PersonaScreenGoals` and `MenuScreenNewGame`. The SDK header `ExtRoot.h`
supplies member names (`HandleKeyboard(TCHAR key)`,
`IsKeyboardGrabbed() { return handleKeyboardRef ? TRUE : FALSE; }`).

## The character's form

* Core sets `GUnicodeOS` from `GetVersionEx`: 1 for
  `VER_PLATFORM_WIN32_NT` (`0x1016d5d5`, before the "Detected" log line).
* Window.dll `WWindow::RegisterWindowClass` (`0x11003650`) uses
  `RegisterClassExW` when `GUnicodeOS` is set. On every NT system the
  viewport window is therefore a Unicode window. Its `WM_CHAR` wParam is a
  UTF-16 code unit, not an ANSI/Latin-1 byte. No codepage conversion happens
  on the way in.
* Later stages narrow it:
  * `UEngine::Key` hands the Console a BYTE (`mov cl, byte ptr [ebp+0xc]`),
    so `€` (0x20ac) reaches `Console.KeyType` as 0xac;
  * the window route keeps the full unit. Every reached `KeyPressed` reads the
    low word, and the script receives a one-character string.

## Route

1. **WinDrv `UWindowsViewport::ViewportWndProc`** (`0x11109b30`). The
   message jump table `0x1110b7ec`/`0x1110b7c0` sends both `WM_CHAR` (0x102)
   and `WM_SYSCHAR` (0x106) to case `0x1110a447`.
   * The procedure first requires the viewport to be in the client's list
     with an Actor (`+0x30`), as for every message.
   * The case calls `Client->Engine->Key(this, wParam)` (vtable `+0x70`)
     unless wParam is 0x0d. Enter is the only filtered unit; it arrives as
     the `IK_Enter` key press instead.
   * A true result repaints when the viewport is not realtime
     (`Actor.ShowFlags & 0x4800`, vtable `+0x8c`). The editor path is ignored
     (`GIsEditor`).
   * An unhandled or filtered `WM_SYSCHAR` goes to `DefWindowProcW`. Every
     other case returns 0.
2. **`DDeusExGameEngine` vtable `+0x70`** is DeusEx.dll's import thunk
   `0x1001b0c4` to **`XGameEngineExt::Key`** (Extension `0x10026650`):
   * it calls `UEngine::Key` first and returns its nonzero result;
   * otherwise it tests whether the viewport's Input (`+0x60`) IsA
     `XInputExt` (class chain `+0x24`/`+0x28` against
     `PrivateStaticClass` `0x100a2e00`). If so it returns
     `XInputExt::Key(key)`, else 0.
3. **`UEngine::Key`** (Engine `0x103813d0`): with a Console (`+0x34`) it
   calls `ProcessEvent(FindFunctionChecked(NAME_KeyType = 820, 0), {BYTE Key,
   UBOOL ReturnValue = 0})`. It returns 1 when the result is nonzero, else 0.
4. **`XInputExt::Key`** (`0x1002d2b0`): the Actor of its own viewport
   (`+0xea0`, then `+0x30`) must be an `APlayerPawnExt` (`0x100a7d70`) with a
   root window (`+0x894`). It returns 1 when `XRootWindow::Key` returns
   nonzero, else 0.
5. **`XRootWindow::Key`** (`0x1003b520`): with a nonzero keyboard grab count
   (`+0x5d0`) it calls `HandleKeyboard` (vtable `+0x128`) and returns 1,
   whatever the windows did. Otherwise it returns 0.
6. **`XRootWindow::HandleKeyboard`** (`0x1003b720`):
   * The target is the focus window (`+0x5c8`). Without one it is the topmost
     visible child of type ≥ 2 (`GetTopChild(1)`, then `GetLowerSibling(1)`),
     else the root.
   * From the target up the parent chain each window's `KeyPressed` (vtable
     `+0xc8`) runs. While the root holds `IK_Alt` (`XWindow::IsKeyDown(0x12)`)
     a window of type < 2 is skipped.
   * The first nonzero result ends the walk. A window being destroyed after
     an unhandled call is `appFailAssert` line 0x648.
   * The full dword is pushed, but each `KeyPressed` reads only its low word.

## KeyPressed bodies

Family table, read from every Extension window vftable (the validator
re-reads it from the DLL each run):

| Slot | Body | Families |
| --- | --- | --- |
| `+0xc8` | `XWindow::KeyPressed` `0x10003830` | Window, Text, Button, Toggle, Checkbox, Tile, TabGroup, RadioBox, TextLog, Computer, LargeText (and Border, Clip, Scale, ScaleManager, ScrollArea, Viewport) |
| `+0xc8` | `XModalWindow::KeyPressed` `0x10037510` | Modal, Root |
| `+0xc8` | `XEditWindow::KeyPressed` `0x10021290` | Edit |
| `+0xc8` | `XListWindow::KeyPressed` `0x10033ae0` | List |
| `+0xd0` | `XWindow::AcceleratorKeyPressed` `0x10003a80` | all |
| `+0x128` | `XRootWindow::HandleKeyboard` `0x1003b720` | Root |

* **`XWindow::KeyPressed`** builds the FString `{key, 0}` (appStrlen + 1 = 2
  units, or an empty FString for 0). It runs
  `ProcessScript(EXTENSION_KeyPressed 0x1009b370, &{FString, UBOOL = 0}, 0)`
  and returns the bool. The default `Window.KeyPressed(string key)` returns
  false. The only shipped override is `CreditsWindow`'s cheat-phrase reader,
  which ignores Alt and keeps alphanumerics while cheats are enabled.
* **`XModalWindow::KeyPressed`** runs the same script event inline. An
  unhandled key goes on only when the modal `IsCurrentModal` (`0x10036e20`)
  and `IK_Alt` is down:
  * `IsCurrentModal`: the root's topmost visible child of type ≥ 2, or the
    root when it has none, is this window;
  * `GetAcceleratorWindow` (`0x100372a0`): only for 0 < key < 0xff (word
    compares). It runs `BuildAcceleratorTable`, which rebuilds the table only
    when the dirty bit `+0x584` is set, and returns the entry at
    `+0x188 + 4·key`. Both cases of a letter are entered;
  * the result is that window's `AcceleratorKeyPressed` (`+0xd0`).
* **`XWindow::AcceleratorKeyPressed`** is the same bridge for
  `EXTENSION_AcceleratorKeyPressed` (`0x1009b354`). `ButtonWindow.uc`
  presses the button when its parent class does not handle it. Persona and
  menu buttons get their accelerators from their labels through
  `SetAcceleratorText` ("Add |&Note", "|&Logs", "|&Yes"…).
* **`XEditWindow::KeyPressed`** and **`XListWindow::KeyPressed`** are already
  translated:
  * Edit runs the script event, then inserts the character through
    `InsertText` (`+0x124`, which applies `FilterChar`) unless editing is off
    or the key is `` ` ``, `~` or below 0x20;
  * List runs the script event, then searches for a hot key
    (`FindRowByKey`).

## Script side

* `Console.KeyType` has no body in the default state (false). State
  `Typing` appends 0x20 ≤ key < 0x80 except `` ` `` and `~`. It swallows the
  first character after `Talk`/`TeamTalk` (`bNoStuff`) unless a key event
  cleared it first.
* `Typing`'s `KeyEvent` returns true for every key, and it handles
  `IK_Escape` without testing the action. The press clears the line and the
  release leaves the state.
* `DeusExRootWindow` binds T=Talk, Y=TeamTalk, B=BuySkills, K=KillerProfile
  and Equals=ShowScores ("SET InputExt …") when none of them is bound yet. In
  the original, T therefore opens the Say line.
* Root key routing runs first. A bound letter therefore runs its binding
  before its character arrives: G (ShowGoalsWindow) leaves the Logs screen
  before its 'g' could reach the list. With Alt, Shift or Ctrl down,
  `DeusExRootWindow.VirtualKeyPressed` runs no binding.

## Play

* **Browser adapter** (`typedCharacters`), a stand-in for
  `TranslateMessage`:
  * the browser's `key` carries the layout, Shift, Caps Lock, AltGr and
    dead-key composition;
  * Backspace, Tab, Enter and Escape give 0x08/0x09/0x0d/0x1b;
  * Ctrl with a letter or `[ \ ] ^ _ @` gives the C0 control character;
    Ctrl+Backspace gives 0x7f and Ctrl+Enter 0x0a;
  * Alt with a character is WM_SYSCHAR with that character;
  * a dead key, an IME composition, Command/Windows and non-character keys
    give nothing.

  This is platform behaviour. It follows the documented Win32/US-layout
  rules and has not been measured against TranslateMessage. Two known
  differences: macOS Option produces the layout's alternate character where
  Windows would send the plain one, and IME input is not delivered.
* `main.mjs` sends a keydown's characters after the key press
  (`simInput.char`). In the default worker mode that is a `{op: 'char'}`
  input entry, which the worker hands to `game.inputChar`, and from there to
  the host's `typedKey`. The host drops 0x0d and runs `consoleCommands.key`,
  which calls the `gameEngineKey` translation over the runtime's Console,
  Actor and root. The page's existing key handling is unchanged.
* Order matches WinDrv's queue: the key press (`WM_KEYDOWN`), then its
  characters, then the release.
* Also added for these screens: `TextWindow.GetText` (1552) and
  `GetTextLength` (1553) now run their validated translations
  (`script-text-get-text*.mjs`; `MenuScreenNewGame.EnableButtons` and
  `PersonaScreenGoals.SaveNote` call them). They were previously "unsupported
  native".

What Play can now type into, through the public input route
(`validate-window-typed-key-play.mjs`):
* on 00_Training:
  * the Say line (T → Talk);
  * the Goals screen notes: Alt+N presses "Add |&Note" through the
    accelerator table; `PersonaNotesEditWindow.FilterChar` drops `\`; 0xe9
    and 0x20ac are kept; a focus change saves the note;
  * Logs list hot keys;
  * the New Game name field;
* on 01_NYC_UNATCOIsland, ComputerPersonal0's login screen: the user name
  and password fields, Tab between them, and Enter through
  `ComputerScreenLogin.EditActivated`. A wrong password clears both fields;
  GUEST/guest logs in (a Caps compare) and the e-mail screen opens.

Every `MenuUIEditWindow` and `PersonaEditWindow` takes the same route.

## Verification

`validate-window-typed-key-diff.mjs` with
`native-window-typed-key-oracle.py` runs, in Unicorn:
* XGameEngineExt::Key → Engine.dll UEngine::Key → XInputExt::Key →
  XRootWindow::Key → HandleKeyboard → the KeyPressed bodies, unchanged;
* the real Core, MSVCRT and accelerator-table code;
* real vtables for Window, Text, Button, Toggle, Modal, Root, Edit and List.

Host leaves:
* ProcessScript, decoding the FString;
* the Edit/List KeyPressed entries;
* FindFunctionChecked and the Console's ProcessEvent;
* GMalloc.

The same cases run through the translation. Results, the event stream and
the window state are compared exactly: accelerator tables and dirty flags,
root focus, grab count and key bytes.

**15 cases, 81 steps identical** (one is the line 0x648 assertion), the
15-class vtable table matches, and **12/12 mutations** are detected. The
cases cover:
* the Console taking the BYTE, including 0x20ac → 0xac;
* every engine-side gate: no console, no input, not an InputExt, no actor,
  not a PlayerPawnExt, no root, a zero or negative grab count;
* the focus and modal walk, bubbling, a script stop;
* Alt skipping type < 2 windows, accelerators (case pairs, invisible or
  insensitive buttons, a non-current modal, the root as the current modal,
  the dirty bit, keys 0/0xff/0x100+);
* the FString shape for 0, 0xe9, 0x20ac and 0x10061.

The Edit and List KeyPressed bodies gained non-ASCII and control keys in
their own diffs:
* `validate-text-layout-diff` 151/151 (0xe9, 0x20ac, 0x08, 0);
* `validate-window-list-family` 283/283, 19/19 mutations (0xe9, 0x20ac,
  0x08).

In the browser, `validate-window-typed-key-browser.mjs` drives Play in
headless Chromium in the default worker mode with real keyboard events:
* F2 opens the Goals screen;
* Alt+N adds a note;
* Shift+H, i, `\`, Space, then a French-layout `é` (Digit2) and AltGr `€`
  (Ctrl+Alt+E) give "Hi é€";
* Backspace gives "Hi é", and Tab saves it.

The worker-side `windowProbe` (`src/viewer/window-probe.mjs`) reads the
note, as `decalProbe` does for decals. The '€' is in the text but nothing
is drawn for it in the screenshot. The font's coverage of 0x20ac (its
character pages and the glyph-miss path) was not checked here.

## Unresolved

* `XComputerWindow::VirtualKeyPressed` (`0x1000f530`) is still a boundary.
  Only `HUDInfoLinkDisplay`'s text window is an `XComputerWindow`; the
  computer and ATM screens are plain `Window`s (`ComputerUIWindow`) and do
  not reach it.
* The ATM and security computers were not driven; ComputerPersonal0 was.
* The TranslateMessage adapter is not measured. Known differences: macOS
  Option characters, IME (`WM_IME_CHAR`), and the system's own Alt
  handling (`DefWindowProcW` for unhandled `WM_SYSCHAR`: system menu and
  Alt+Space are not modelled).
* The non-realtime `Repaint(1)` after a handled character is not modelled.
  Play renders every frame.
