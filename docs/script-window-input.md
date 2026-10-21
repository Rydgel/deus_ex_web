# Window input, timers and the Training keypad

Training's `paddoor` opens only through `Keypad0`, whose code (`0012`) is in
DataCube0. The keypad needs several window subsystems: the modal input grab,
cursor placement and hit testing, focus, the root window's key routing, window
timers, button presses and destruction of the Modal and Button families. All of
them are now translated from the bodies below, wired into Play, and compared
with the original DLL. Closing the keypad now completes UnPauseGame through
the attached Viewport/Console graph and original GameInfo.SetPause bytecode.

## Authority

* `Extension.dll`, SHA-256
  `93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`, base
  `0x10000000`. Every function below is an export named by its decorated symbol.
  `Core.dll` `8bf3039e…` for `execGetEnum`.
* `DeusEx.u`: `Keypad`, `HUDKeypadWindow`, `HUDKeypadButton`,
  `DeusExRootWindow` (`InvokeUIScreen`, `PushWindow`, `PopWindow`,
  `UnPauseGame`, `IsKeyAssigned`, `MaskBackground`) and
  `DeusExPlayer.ActivateKeypadWindow`.
* `Extension.u`: `ButtonWindow` (`PressButton` 1598, `ActivateButton` 1590,
  `VirtualKeyPressed`), `Window` (`AddTimer` 1490, `RemoveTimer` 1491,
  `SetCursorPos` 1453, `IsKeyDown` 1470) and `ModalWindow`.
* `Engine.u`: `Actor.EInputKey` names, whose indices are the Windows virtual-key
  codes the original WinDrv delivers.

## Route

`Keypad.Frob` (HackableDevices) → `HackAction` → `DeusExPlayer.ActivateKeypadWindow`
→ `Keypad.ActivateKeypadWindow` → `root.InvokeUIScreen(HUDKeypadWindow, True)`.
This pushes the window without pausing: `PushWindow` → `NewChild(class, True)`.
It is followed by `MaskBackground(True)` (background texture, Modulated style,
`ShowHud(False)`) and `InitData`.

`HUDKeypadWindow.VirtualKeyPressed` maps `IK_0`–`IK_9` and the numpad digits to
`btnKeys[n].PressButton()` (ignored while Alt or Ctrl is down). The script
`PressButton(i)` appends the digit, plays `Touchtone*` through `player.PlaySound`,
and validates once the length matches `validCode`. `ValidateCode` runs
`KeypadToggleLocks` or `KeypadRunEvents` and `KeypadRunUntriggers`, plays the
success or failure sound, sets the text, and calls `AddTimer(1.0, False, 0,
'KeypadDelay')`. `KeypadDelay` pops the window on success, or clears the code.
Other keys fall through to `DeusExRootWindow`, whose `IsKeyAssigned` reads the
key's User.ini binding through `GetEnum(enum'EInputKey', key)` and
`ConsoleCommand("KEYBINDING …")`.

## Modal grab

`XModalWindow::VisibilityChanged` (`0x10037330`) first runs
`ProcessScript(VisibilityChanged, &bVisible)`. Then, if the window has a parent
(`+0x138`) and `GetRootWindow()` returns a root, it grabs keyboard and mouse
when visible and ungrabs both otherwise.

The root keeps two grab counts: keyboard at `+0x5d0` and mouse at `+0x5cc`.
`window-tree-natives` labels `+0x5cc` "handleMouseRef", but it is the mouse grab
count.
* `GrabKeyboardEvents` (`0x1003a110`): if the count is ≤ 0, clears every
  non-mouse `keyDown[k]` byte (`+0x630 + k`, k < 0xff), then increments the count.
  `UngrabKeyboardEvents` (`0x1003a1b0`) decrements only a positive count.
* `GrabMouseEvents` (`0x1003a1d0`) and `UngrabMouseEvents` (`0x1003a270`) do the
  same for `+0x5cc`, clearing only the mouse keys.
* `IsMouseButton` (`0x1003a2c0`) is true for keys 1, 2, 4, 0xe4–0xe7, 0xec and
  0xed.

Translation: `src/runtime/script-window-input.mjs`. The host's modal
`visibilityChanged` virtual uses it; the ComputerWindow override stays a
boundary. `scripts/validate-window-grab-diff.mjs` runs the unchanged bodies
(`scripts/native-window-grab-oracle.py`) and compares 8 cases, 25 steps, all 256
key-down bytes and both counts exactly.

## Cursor, hit testing and focus

* `XWindow::SetCursorPos` (`0x1004cca0`, native 1453, exec `0x10052b90`): with a
  root, `SetRootCursorPos(x + clip.x, y + clip.y)` (`+0xd4`/`+0xd8`, each one
  f32 add).
* `XRootWindow::SetRootCursorPos` (`0x10039d80`): stores mouseX/mouseY
  (`+0x590`/`+0x594`), sets `+0x5a4` bit 0, then `ClampMousePosition` and
  `ProcessMouseMove`.
* `ProcessMouseMove` (`0x1003af50`), when `+0x5a4` bit 0 is set:
  * It finds the top modal (the topmost visible child of type ≥ 2, else the
    root) and asks `GetMouseWindow`.
  * When the window under the mouse changes, the old one gets
    `MouseLeftWindow` (`+0xa4`). If the modal's focus mode (`+0x174` byte) is
    ≥ 3, `SetFocusWindow(None)` follows.
  * The new window gets `MouseEnteredWindow` (`+0xa0`). If the mode is ≥ 2,
    `SetFocusWindow(new)` follows. The result is stored at `+0x5a0`.
  * When the position differs from `+0x598`/`+0x59c` (fcomp C3, so NaN
    counts as equal), the window gets `MouseMoved` (`+0x9c`) in its own
    coordinates, and the last position is copied.
  * Bit 0 is cleared.
* `GetMouseWindow` (`0x1003b0d0`): the grabbed window `+0x5c4` if any, else
  `modal.FindWindowByPoint(mouse − modal origin)`, else the modal.
* `FindWindowByPoint` (`0x1004f740`): requires flags bits 0 and 1 and
  `IsPointInWindow`. It then recurses into children from the top
  (`+0x140`/`+0x144`), skipping type ≥ 2 and passing child-local f32
  coordinates. `IsPointInWindow` (`0x1004f830`) needs 0 ≤ x < width and
  0 ≤ y < height, then asks `QueryPointInWindow` (`+0x60`, XWindow returns 1).
* `SetFocusWindow` (`0x1004f0e0`) is the existing `script-window-focus.mjs`
  translation. Its leaves are now bound to IsTraversable, window PlaySound
  (`0x1004ffb0`), the focus virtuals and `AskParentToShowArea` (`0x1004e230`).
  AskParentToShowArea intersects the requested area with the window's clip
  (`XClipRect::Intersect` `0x10002b10`). If the window's own clip rect does not
  show all of it, it sends `ChildRequestedShowArea` (`+0x8c`) to the parent and
  recurses into the parent through `ConvertCoordinates` (`0x1004fbe0`).
  Intersect and AskParentToShowArea keep right/bottom sums unrounded on the x87
  stack across compares; the translation carries them as 80-bit values.
* `MoveFocus` (`0x1004ef30`) walks the focus's tab-group row (`+0x14c` by
  `+0x11c`) or column (`+0x158` by `+0x120`) table. It wraps when `bWrap`, or
  else when bit 2 of `+0x164` is set; without wrap it reverses at the ends. It
  focuses the first traversable entry, else calls `MoveTabGroup`
  (`0x1004f440`, `script-window-root-tick.mjs`).
* The script natives over them (`script-window-host-natives.mjs`, bound
  2026-10-01): `MoveFocusLeft/Right/Up/Down` (1442–1445, exec `0x10052740`,
  `0x10052780`, `0x100527c0`, `0x10052800`) step the cursor past
  `EX_EndFunctionParms` and return `MoveFocus(0, 0)`, `(1, 0)`, `(2, 0)`,
  `(3, 0)` on the receiver; `MoveTabGroupNext/Prev` (1446/1447, exec
  `0x10052840`/`0x10052880`) return `MoveTabGroup(3)` / `MoveTabGroup(2)`.
  `RootWindow.VirtualKeyPressed` reaches them for the arrow keys: Down moves
  MeetPaul's choice focus from the first ConChoiceWindow to the second
  (`validate-island-conversation`).
* `CheckFocusWindow` (`0x10050b80`) replaces an untraversable focus with the top
  modal's preferred focus (`+0x178`), else `MoveFocus(1, 1)`, else no focus.
  An earlier revision of `window-tree-natives` stopped at this branch.

* Cursor drawing, `PaintWindows` `0x1003ac0a`–`0x1003acb8`:
  * PaintWindows first calls `GetMouseWindow(NULL, &x, &y)` (`0x1003aafd`).
    After the tree it checks for a mouse grab and ShowCursor (`+0x5a4` bit 3).
  * `QueryCursor` (`0x1004f910`) walks from the mouse window up its parents. It
    asks the `CursorRequested` virtual (`+0x64`), else takes the window's
    default cursor (`+0xf0` texture, `+0xf4` shadow, `+0xf8`/`+0xfc` hot spot,
    `+0x100` colour). At each parent it adds the child's position to the point.
  * A hot spot below 0, NaN, or not inside the texture becomes
    `(USize >> 1) - 1` (VSize for y).
  * The cursor is drawn at the mouse position less the hot spot with
    `XGC::DrawIcon`: the shadow in style 4, then the cursor in style 2 with
    SetTileColor.
  * The XWindow `CursorRequested` bridge (`0x10003440`) copies back hotX, hotY
    and newColor. It seeds `shadowTexture` with the caller's pointer value and
    never copies it back, so a script's shadow is discarded.
  * QueryCursor's default colour is white in a stack slot whose alpha byte is
    never written. The draw reads RGB only, so it is modelled as 0.
  * Translation: `queryCursor` and `paintCursor` in `script-window-mouse.mjs`.
    The keypad's paint shows `DeusExCursor1` and its shadow. QueryCursor is
    translated from these instructions, and PaintWindows' own oracle does not
    cover this branch yet.

Family virtuals (vtable slots read from every Extension window vtable):
QueryPointInWindow, MouseEnteredWindow, MouseLeftWindow,
FocusEntered/LeftDescendant and ChildRequestedShowArea are the XWindow bodies in
every admitted family. Button, Toggle and Checkbox override MouseMoved
(`0x10007e30`) and FocusEntered/LeftWindow (`0x10007fc0`/`0x10008050`). While
held, a button sets or clears its pressed bit from `IsPointInWindow`, and the
focus overrides repaint through ChangeButtonAppearance. The XEditWindow
MouseMoved override is an explicit boundary.

Translation: `src/runtime/script-window-mouse.mjs`, with `setFocusWindow`,
`moveFocus` and `moveTabGroup` on the host's `W.native`. Window.SetFocusWindow
(1440) now gets the same services as `lifecycle.focus`, and the root Tick's
SetFocusWindow boundary is gone. `scripts/validate-window-mouse-focus-diff.mjs`
runs the unchanged bodies with their real vtables
(`scripts/native-window-mouse-focus-oracle.py`). It compares 12 cases and 80
steps exactly. They cover:

* focus handoffs across a keypad-shaped tree, clamping, a held button and a
  grabbed window;
* nested show-area requests;
* x87 rounding cases for Intersect and ConvertCoordinates;
* MoveFocus over row and column tables with and without wrap, including
  disabled entries and the MoveTabGroup fallback;
* CheckFocusWindow falling through preferred focus and MoveFocus to no focus,
  which is the path Play takes when a code disables the keypad's buttons.

## Root key routing

* `XInputExt::Process` (`0x1002d0b0`) asserts the key is in 0–0xfe. If the viewport
  actor is a `PlayerPawnExt` with a root window (`+0x894`), it calls
  `XRootWindow::Process` first.
  * If the root consumed the key, every key held in the input's own table
    (`+0xeb0 + k`) is cleared. A held key with a non-empty binding (FString at
    `+0x2ac + 12k`) runs that binding as `IST_Release` with delta 0. Process
    then returns 1.
  * Otherwise a press of a key already held, or a release of a key not held,
    returns 0. Other keys update the table and run the binding with the real
    action and delta.
* `XRootWindow::Process` (`0x1003b3e0`, key, action, delta). Press (1) sets
  `keyDown[key]` and marks a repeat when it was already set. Release (3)
  clears it and skips handling when it was already clear. Hold and Axis
  actions change nothing but are still dispatched.
  * A mouse key returns 0 without a mouse grab. With a grab it clears the
    parent pawn's (`+0x588`) `bFire`/`bAltFire` (`+0x4b6`/`+0x4b7`, the linked
    Pawn properties), calls `HandleButtons` (vtable `+0x12c`) unless skipped,
    and returns 1.
  * Any other key returns 0 without a keyboard grab. With a grab it calls
    `HandleVirtualKeyboard` (vtable `+0x124`, key, action, repeat) unless
    skipped, and returns 1.
* `XRootWindow::Key` (`0x1003b520`, a character) returns 0 without a keyboard
  grab. Otherwise it calls `HandleKeyboard` (vtable `+0x128`) and returns 1.
  The whole typed-character route, from WinDrv's `WM_CHAR` to each family's
  `KeyPressed`, is in [typed characters](script-window-typed-keys.md).
* `HandleVirtualKeyboard` (`0x1003b820`) selects its target in order: the focus
  window (`+0x5c8`); else the topmost visible child (`GetTopChild(1)`, walking
  down with `GetLowerSibling(1)`) whose type byte (`+0x28`) is ≥ 2; else the root.
  From the target up the parent chain:
  * unless repeating, it calls `RawKeyPressed` (vtable `+0xbc`, key, action,
    bRepeat = 0);
  * on a press, if RawKeyPressed did not handle the key, it calls
    `VirtualKeyPressed` (vtable `+0xcc`, key, repeat);
  * it returns the first nonzero result;
  * after each call it asserts the window is not being destroyed (lines 0x680
    and 0x68b).
* `HandleKeyboard` (`0x1003b720`) uses the same target and parent walk with
  vtable `+0xc8` (the character). A window of type < 2 is skipped while `IK_Alt`
  (0x12) is down. The assertion is at line 0x648.
* The XWindow bridges `RawKeyPressed` (`0x10003750`) and `VirtualKeyPressed`
  (`0x10003a40`) are `ProcessScript` calls with a zero-initialized bool result.
  Every admitted family keeps RawKeyPressed. ComputerWindow and EditWindow
  override VirtualKeyPressed.

Translation: `rootProcess` and `handleVirtualKeyboard` in
`script-window-input.mjs`, with the bridges as host virtuals. The ComputerWindow
and EditWindow VirtualKeyPressed overrides remain explicit boundaries. The Play
input layer names the browser key with `src/viewer/input-key-names.mjs`, resolves it in the
original EInputKey table, and runs it through `game.inputKey`:
`UEngine::InputEvent`, then the translated `XInputExt::Process` with its key
table and binding step ([script-console-command.md](script-console-command.md)).
A consumed key clears Play's held keys and goes no further.
`game.windowKey` remains the root-only entry the census uses to close a
screen. `IsKeyDown` (1470)
uses the existing `script-window-is-key-down.mjs`. Core `execGetEnum`
(`0x1013e9a0`) returns NAME_None unless the object is a UEnum and
0 ≤ i < `Names.Num` (`+0x38`), then `Names(i)` (`+0x34`).

## Root mouse-button routing — 2026-09-24

`XRootWindow::HandleButtons` (`0x1003b960`) now supplies the mouse half of the
root input path. Contract recorded from the installed Extension.dll before the
translation:

* root mouse flag bit 2 consumes the input immediately. Otherwise the body
  finds the top modal and current mouse window; press grabs that window and
  focus mode at least 1 focuses it, while release ungrabs it;
* press/release sample `GetTickOffset`, absolute distance from the first click,
  last window and full integer key. A sequence continues only while the
  remaining 0.5-second deadline is positive and both distances are at most 10.
  A reset emits `Assigning Last Button Window to %s` to GLog, then installs the
  new window/key/origin. Press advances the click index only for a continued
  sequence and sets the next deadline;
* each target receives `RawMouseButtonPressed(x,y,key,action)` first. If it does
  not consume the input, press calls `MouseButtonPressed` and release calls
  `MouseButtonReleased` with `(clickIndex % MaxClickCount)+1` when the window's
  signed `MaxClickCount` is positive, otherwise `clickIndex+1`. Coordinates are
  converted afresh for each cached parent. Destruction after either virtual is
  an assertion, not a silent stop;
* `GrabMouse` notifies an old grabbed window through `MouseGrabLost(new)` before
  replacing it; `UngrabMouse` clears only a matching grab.

The reached `XButtonWindow` press/release overrides are included. Their script
events run first. Left-click, and right-click only with flag 3 enabled, set the
pressed/held bits and update appearance. Non-auto-repeat press plays
`pressSound`; release inside plays `clickSound` and activates the button.
Auto-repeat instead sets `repeatAt`, plays/activates immediately, and suppresses
release activation. Key and repeat fields retain their original byte/float32
writes.

`XToggleWindow` keeps its distinct overrides (`0x10049a80`, `0x10049b30`,
`0x10049c30`). Mouse press dispatches the script event but does not enter the
Button held state; left press is consumed. Left release is always consumed and,
only when still inside, plays the enable/disable sound selected from the old
toggle bit before calling `SetToggle(!old)`. Other buttons return the script
result. Programmatic `PressButton` flips through `SetToggle` first and then
plays the sound selected from the new state; its key argument is unused.

The unchanged DLL oracle now compares 18 cases / 94 steps, including mouse
suppression, capture/focus, press/release, continued multi-click counts and
unhandled parent bubbling, Toggle mouse inside/outside and non-left paths, and
programmatic toggle presses, in addition to all earlier cursor/focus cases.
Complete window state, event order, coordinates, float bits and sounds match.
The live Training medical screen routes root press/release through its actual
scrollbar buttons and observes the original manager → scale → clip feedback.

Reproduce with
`NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-window-mouse-focus-diff.mjs`,
`node scripts/validate-window-baseline-play.mjs`, and `npm run build`.

### Play browser adapter

The Play adapter now offers pointer input to the root before world look, fire
or use, preserving the ordering established by `XInputExt::Process` at
`0x1002d0b0`. It returns unconsumed while the root mouse-event grab count at
`+0x5cc` is zero. While grabbed, unlocked pointer positions are converted from
CSS pixels to the WebGL drawing-buffer pixels used by the root canvas;
pointer-lock motion is scaled the same way and accumulated from the root's
current cursor. Both paths call the recovered `SetRootCursorPos`. Browser
left/right/middle edges map to `IK_LeftMouse`/`IK_RightMouse`/`IK_MiddleMouse`
and pass through `XRootWindow::Process`, so a consumed edge cannot also fire a
weapon or frob the world.

This coordinate conversion is an explicit browser platform adapter, not a
claim that WinDrv delivered cursor samples by an identical API. Its observable
window-side contract is covered by the existing original-DLL oracle; the
adapter's CSS/drawing-buffer conversion has focused unit cases, and the live
Training medical screen activates its authored scrollbar through the public
`game.windowPointer` route with absolute and pointer-lock-relative samples.

## Window timers

A window keeps an active timer list at `+0x128` and a free list at `+0x12c`, both
linked through `+0x1c`. `script-window-destroy.mjs` calls these `gcListA`/`gcListB`;
they are the timer lists. Each 0x20-byte node holds:

| Offset | Field |
| --- | --- |
| `+0x00` | timeout |
| `+0x04` | remaining |
| `+0x08` | function FName |
| `+0x0c` | bLoop |
| `+0x10` | clientData |
| `+0x14` | in-use count |
| `+0x18` | removed |

* `AddTimer` (`0x1004fc20`, timeout, bLoop, clientData, name):
  * a timeout below 1e-6 (double `0x10065310`) becomes `0x358637bd` (1e-6f);
  * a window being destroyed (`+0x30 & 0x10`) returns 0;
  * otherwise it takes a free node, or `GMalloc(0x20)`, stores
    `remaining = f32(GetTickOffset() + timeout)` with in-use and removed at 0,
    pushes the node onto the front of the active list, and returns the node
    address as the timer ID;
  * `execAddTimer` (1490) marshals (timeout, bLoop, clientData, name).
* `RemoveTimer` (`0x1004fd20`, id) ignores 0 and windows being destroyed. For a
  listed node it sets removed. When the node is not in use it unlinks the node
  onto the free list. `execRemoveTimer` is 1491.
* `GetTickOffset` (`0x1004fda0`) is `XRootWindow::GetWindowsTickOffset(0)`
  (`0x1003a3b0`). It returns `f32(appSeconds() - last)`: the double difference
  is stored to a dword and reloaded. `TickWindows` (`0x1003a4a0`) resets `last`
  with argument 1. This is wall-clock time, rdtsc when `GTimestamp` is set. The
  host models it as `performance.now()` since the last root tick.
* `InvokeTimers` (`0x10051340`, delta), reached from `TickTree`, returns for a
  window being destroyed. Otherwise it locks the window and walks the active list
  from the front. It skips removed nodes. For each other node:
  * `remaining = f32(remaining - delta)` and the in-use count increments;
  * when the unrounded 80-bit difference is below 0 (float `0x10059884`), the
    timer fires:
    * a looping timer computes `invocations = _ftol(-remaining / timeout) + 1`
      and `remaining = f32(invocations * timeout + remaining)`;
    * a one-shot timer has `invocations = 1` and is marked removed;
    * with a function name it calls `ProcessScript(name, {id, invocations,
      clientData}, 1)`, otherwise the `Timer` virtual (vtable `+0x78`). That is
      `ret 0xc` in XWindow, and `XButtonWindow::Timer` (`0x100080e0`) in the
      Button, Toggle and Checkbox families;
  * it stops once the window is being destroyed, then unlocks (UnlockWindow's
    SafeDestroy only runs while the lock count was positive);
  * it decrements the in-use count and removes a node that is unused and removed.

Translation: `src/runtime/script-window-timers.mjs`, with the loop arithmetic
in the 80-bit model. Timer nodes are registered heap objects, so the destroy
module's pointer walk frees them (`freeGc` is now the timer-node release).
`scripts/validate-window-timer-diff.mjs` runs the unchanged bodies
(`scripts/native-window-timer-oracle.py`, now also recording SafeDestroy). It
compares 10 cases and 64 steps exactly: list order, free-list reuse, removal,
minimum timeouts, destroying windows, a timer function destroying its window,
looping invocation counts up to 12399 in one tick, and the button activate
timer.

## Buttons

* `execPressButton` (1598) evaluates the key (default `0x20`, IK_Space) and calls
  the `PressButton` virtual (vtable `+0x124`).
* `XButtonWindow::PressButton` (`0x10007b20`) runs these steps:
  * `+0x174 |= 1` (pressed);
  * `ChangeButtonAppearance`;
  * `AddActivateTimer`;
  * `XWindow::PlaySound(pressSound +0x194, -1, 1)`;
  * `+0x1a0 = key`;
  * `ActivateButton(key)`, already translated.
* `AddActivateTimer` (`0x10008510`) removes any old timer, then stores
  `AddTimer(activateDelay +0x178, 0, 0, None)` at `+0x198`.
  `RemoveActivateTimer` (`0x10008480`) removes and clears it.
* `XButtonWindow::Timer` (`0x100080e0`) for the stored ID clears the pressed bit,
  calls `ChangeButtonAppearance`, and removes the timer.
* `ActivateButton` (`0x100077e0`) walks up from the button, calling
  `ButtonActivated` (`+0xe8`, or `ButtonActivatedRight` `+0xec` for key 2) until
  one returns true. Both are bool ProcessScript bridges (`0x10003d20`/`0x10003d50`).

Translation: `buttonPressButton` in `script-window-input.mjs` and the existing
`script-window-press-button.mjs` / `script-window-activate-button.mjs` exec
translations, now wired as natives 1598 and 1590. ToggleWindow's distinct
PressButton behavior is recorded with the mouse route above.

## Destruction of the keypad window

`PopWindow` destroys the HUDKeypadWindow (Modal family) with its twelve
`HUDKeypadButton`s (Button family) and its TextWindow.
* `XModalWindow::CleanUp` (`0x10036cf0`) runs `RemoveTabGroupFromTable(self)`, empties
  `+0x17c` (Realloc 4) and runs `ClearAcceleratorTable`. It then runs
  `XTabGroupWindow::CleanUp` (`0x10044ea0`): removal from a different modal's
  table, emptying `+0x14c` and `+0x158`, then `XWindow::CleanUp`.
* `XButtonWindow::CleanUp` (`0x10007770`) only calls `XTextWindow::CleanUp`.
* The deleting destructors are `0x10005910` (`~XModalWindow` `0x10005110`, size
  0x588) and `0x100097a0` (`~XButtonWindow` `0x100091d0`, size 0x1ec). They
  finalize the member arrays and strings; they do not repeat the table removals.
* `XWindow::CleanUp` frees both timer lists (the destroy module's `freeGc`
  service).

Translation: the host's destroy table has Button, TabGroup and Modal entries,
and a family may give its destructor step separately from CleanUp.

## Sounds

The button's own sound goes through the recovered Window PlaySound path
([window sound](script-window-sound.md)). The keypad's `player.PlaySound` calls are
Actor native 264. Play records native 264 per caller path as deferred audio when
the caller discards the channel ID. `HUDKeypadWindow.PressButton` and
`ValidateCode` both discard it, and are admitted as `KeypadSound` with channel ID 0.

## Play reach (2026-09-24)

`scripts/validate-keypad.mjs` checks this in Training with presentation on. It
follows the browser: every frame paints the HUD at 1432×1268, JC faces the
keypad (so FrobDisplayWindow formats its hack strength), and Training's
DataLink is playing when Frob runs.

1. `game.use()` on Keypad0 returns ok and opens `HUDKeypadWindow`. The root's
   keyboard and mouse grab counts become 1. `Tick`'s `SetCursorPos(width,
   height)` puts the cursor on the keypad's bottom-right corner. That corner is
   outside every button, so the mouse window is the keypad itself. The keypad
   is not selectable, so EnterLeave focus stays empty and keys go to it as the
   top modal. The paint contains the mask, the keypad, its buttons and
   `DeusExCursor1` with its shadow.
2. `W` is consumed while the keypad grabs input. It reaches `IsKeyAssigned`,
   which reads its binding through `GetEnum` and `KEYBINDING`.
3. Digits `0`, `0`, `1`, `2` are consumed and build `inputCode` through the
   original PressButton path.
4. `ValidateCode` shows `~~GRANTED~~`, and `KeypadRunEvents` starts both
   `paddoor` movers (DeusExMover18 and DeusExMover26) opening.
5. One second later `InvokeTimers` runs `KeypadDelay`. `PopWindow` destroys the
   window, the owner's `keypadwindow` becomes None, and both grab counts return
   to 0.

The viewer's Previews menu has a Keypad entry that places JC in front of it.

`PopWindow` then completes `DeusExRootWindow.UnPauseGame`: bUIPaused and
bShowMenu are false, the background is DSTY_None, the HUD is visible, the
attached Engine.Console leaves its state, and GameInfo.SetPause(False) clears
Level.Pauser. [Viewport and Console evidence](script-viewport-console.md)
records the native construction/linkage contract and the remaining pause scope.
The browser route (Previews → Keypad, aim at it, F, 0012) was also checked:
GRANTED, closed keypad, restored HUD, open doorway, no browser errors.

## Unresolved

* Full platform Viewport construction and paused Level.Tick scheduling remain
  outside the attached script prefix; see the viewport contract above.
* The browser pointer adapter reproduces the recovered window-side contract,
  but exact WinDrv cursor sampling and platform capture behavior have not been
  measured. The wheel is mapped: WinDrv's `WM_MOUSEWHEEL` case, the page's conversion and the root's consumption of `IK_MouseWheelUp`/`Down`
  in a window are in [input bindings](input-bindings.md).
* Play's input is a JavaScript key-to-action map, not the User.ini bindings that
  `XInputExt::Process` executes. The consumed-key rule maps to clearing Play's
  held keys.
* Browser auto-repeat keydowns are delivered as further presses. The root then
  marks them as repeats, as for a key already down. That WinDrv delivers
  auto-repeat the same way has not been measured.
* Character input (`XRootWindow::Key`/`HandleKeyboard`) is recovered and
  wired: [typed characters](script-window-typed-keys.md).
