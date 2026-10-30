# Input bindings in the page (2026-10-21)

Every binding of the original's `[Engine.Input]` (`System/User.ini`, equal to `DefUser.ini`) reaches the game from the browser page: the
keys, the three mouse buttons, the pointer's motion and, since this step, the mouse wheel, which never reached it before. This page
records what the original's WinDrv.dll delivers for each Windows input message (the authority), the rules the page applies to browser
events to produce the same deliveries (the platform layer, which is not the original's), the table of all bindings with what each
does in Play, the keys no browser lets a page take, and what stays unsupported.

Code: [`wheel-input.mjs`](../src/viewer/wheel-input.mjs) (the wheel), [`input-key-names.mjs`](../src/viewer/input-key-names.mjs) (key codes),
[`main.mjs`](../src/viewer/main.mjs) (the listeners, `gameTakesKey`, `lockGameKeys`), `inputWheel` in
[`game.mjs`](../src/viewer/game.mjs), the `wheel` command of [`sim-worker.mjs`](../src/viewer/sim-worker.mjs), and the validation-only
[`input-probe.mjs`](../src/viewer/input-probe.mjs).

## What WinDrv delivers

Authority: `WinDrv.dll` `9cf2861c…1f94e1f`, `Window.dll` `3d40db1d…2e59d`, `Engine.dll` `0c3a8b18…c20b4`, `Extension.dll`
`93c35502…9d916d9c`, base addresses as installed (WinDrv `0x11100000`). The window procedure is `UWindowsViewport::ViewportWndProc`
(`0x11109b30`, `thiscall`, `ret 0xc`). After the checks every message passes (the viewport is in `Client`'s list, `+0x2c`/`+0x30`, and
has an Actor, `+0x30`) the input messages are:

**The wheel.** The procedure first compares the message with `*WindowMessageMouseWheel` (`0x11109b97`), Window.dll's export
`0x11050ab0`, which Window.dll fills at start with `RegisterWindowMessageW(L"MSWHEEL_ROLLMSG")` (string `0x11050224`, call
`0x11029595`, store `0x110295dd`): the message the Win95-era mouse driver sent. That message becomes `WM_MOUSEWHEEL` (`mov edi, 0x20a`)
with `wParam = (wParam & 0xffff) << 16` and jumps into the `WM_MOUSEWHEEL` case. A native `WM_MOUSEWHEEL` (`0x20a`) arrives there through
`0x1110acb0` → `0x1110b26b` → `0x1110b280` (the case range is `0x207`, `0x208`, `0x20a`; `0x209` and `0x20b`… fall to
`DefWindowProc`). The case at `0x1110b29e`:

```
delta = (signed 16-bit) HIWORD(wParam)            shr eax, 16 ; movsx edx, di
if delta == 0: return 0                           cmp di, dx (edx = 0)
CauseInputEvent(IK_MouseW 0xe7,        IST_Axis 4,    (FLOAT) delta)     the raw delta: not divided by WHEEL_DELTA
if delta > 0:  CauseInputEvent(IK_MouseWheelUp   0xec, IST_Press 1, 0); CauseInputEvent(0xec, IST_Release 3, 0)
if delta < 0:  CauseInputEvent(IK_MouseWheelDown 0xed, IST_Press 1, 0); CauseInputEvent(0xed, IST_Release 3, 0)
```

* One message is one press and release, whatever its magnitude: a delta of 360 (three notches) is the axis event with 360 and one
  `MouseWheelUp` press and release. There is no loop and no accumulation: a high-resolution wheel sending 30 units at a time makes one
  press per message.
* The low word of `wParam` (the Ctrl, Shift and mouse-button flags) is ignored; the sign is the direction (positive is away from the
  user, up). The press is followed at once by the release, before the engine's next tick.
* `CauseInputEvent` (`0x111011f4` jumps to `0x11108d60`): with `0 <= iKey < 0xff` it calls `Client->Engine->InputEvent(this, iKey,
  Action, Delta)` (Engine vtable `+0x74`, `UEngine::InputEvent` `0x103814e0`), else returns 0.
* `IK_MouseZ` is never sent. User.ini binds nothing to `MouseW=` and `MouseZ=`; the wheel's work is the two key bindings
  `MouseWheelUp=PrevBeltItem` and `MouseWheelDown=NextBeltItem`.

**Keys.** `WM_KEYDOWN`/`WM_SYSKEYDOWN` (table at `0x1110a263`, case `0x1110a280`): wParam is the Windows virtual-key code; with `VK_RETURN`
and `GetKeyState(VK_MENU) & 0x8000` the case calls `ToggleFullscreen` (`0x1110105a`) and delivers nothing; otherwise
`CauseInputEvent(vk, IST_Press, 0)`, for every message including the auto-repeats (the lParam repeat bit is not read). `WM_KEYUP`/
`WM_SYSKEYUP` (`0x1110a348`): `CauseInputEvent(vk, IST_Release, 0)`. The EInputKey value is the virtual-key code itself (Engine.u's
table is indexed by VK: `IK_A` `0x41`, `IK_F1` `0x70`, `IK_NumPad0` `0x60`), so the keys WinDrv sends for a modifier are the generic
`IK_Shift`, `IK_Ctrl`, `IK_Alt` (`0x10`–`0x12`), never `IK_LShift`/`IK_RShift`/`IK_LControl`/`IK_RControl`. `WM_CHAR`/`WM_SYSCHAR` are
the typed characters ([typed keys](script-window-typed-keys.md)).

**Mouse buttons.** `WM_LBUTTONDOWN`/`WM_RBUTTONDOWN`/`WM_MBUTTONDOWN` (`0x1110b54f`, `0x1110b552`) press `IK_LeftMouse` (1), `IK_RightMouse` (2),
`IK_MiddleMouse` (4) and call `SetMouseCapture(1)` (vtable `+0x58`); the matching `…UP` messages (`0x1110b34e`, `0x1110b351`) release the same
keys, release the capture and report the position to `Engine->MousePosition`. The double-click messages deliver no press (the left one
only reports the position), and the registered window class has no `CS_DBLCLKS` in the game anyway: `0x11101d6b`–`0x11101d88` register it
with style `0x20` (`CS_OWNDC`) plus `8` only when `GIsEditor`. The XBUTTON messages (`0x20b`–`0x20d`) take `DefWindowProc`: **the back and forward
buttons deliver nothing.** The pointer's motion is the `IK_MouseX`/`IK_MouseY` axes sampled each tick (`UpdateInput`, already
implemented).

**Measured with the original code.** [`native-viewport-input-oracle.py`](../scripts/native-viewport-input-oracle.py) runs the unchanged
`ViewportWndProc` and `CauseInputEvent` in Unicorn (the engine's `InputEvent`, `Key`, `MouseDelta`, `MousePosition` and the viewport's
`SetMouseCapture` and `Repaint` are recorded events; the user32 calls return the case's values) and
[`validate-viewport-input-diff.mjs`](../scripts/validate-viewport-input-diff.mjs) compares its events with the page's translations for 333
messages: wheel deltas of 1, 60, 120, 240, 360, 32767, -32768, 0 and their negatives with four flag words, native and registered, all
113 key codes the page maps (down, up, the system variants), Alt+Enter, keys 0, 0xfe, 0xff and 0x100, the three buttons down and up, and the
double-click and XBUTTON messages. It passes. A Wine run of the whole game was not made: the oracle runs the same instructions.

## From the event to the binding

`UEngine::InputEvent` → `Console.KeyEvent` → `XInputExt::Process` ([console command chain](script-console-command.md)). A modal window
that holds the mouse grab (the menus, the inventory and the other screens) takes the wheel keys first: `XRootWindow::Process`
(`IsMouseButton` is true for keys 1, 2, 4, `0xe4`–`0xe7`, `0xec`, `0xed`) offers them to the window under the cursor, and an
`XScrollAreaWindow` answers the press of `IK_MouseWheelUp`/`Down` with `MoveThumb` ([scroll movement](script-window-scroll-movement.md)).
Otherwise the key runs its binding. The page's side is one queue, `simInput.wheel(delta)` → `{op: 'wheel', delta}` → `game.inputWheel` →
`wheelMessage(delta)`: the sequence above, each through `InputEvent`.

## The page's rules (platform layer, not the original's)

**The wheel.** A browser reports pixels, lines or pages, and Chromium coalesces the notches of a frame into one event (its documented
behaviour, not measured here); Windows sends one message of 120 per notch. `wheelUnits` converts an event to Windows' units (120 per notch, positive away from the user): a page is
one notch, a line is 40 (three lines to a notch, `SPI_GETWHEELSCROLLLINES` 3), and pixels use the browser's own tick count
(`wheelDeltaY`, the legacy attribute Chromium and Safari fill with 120 per platform notch; **measured**: Chromium's wheel events from
Playwright carry ±120 whatever the pixel delta, 40, 53, 100 or 200) or else 1.2 each (100 pixels to a notch, Chromium on Windows).
`createWheelAccumulator` cuts the units into messages of one notch (±120) and carries the remainder: a touchpad's small deltas add up to a
notch, a reversal of direction or a pause of 500 ms drops the remainder, one event is at most 8 notches. So a notch of any wheel is one
`WM_MOUSEWHEEL` of 120, as on Windows. Firefox fills `wheelDeltaY` from ticks too, but only when its widget reported them (GTK's
discrete and smooth wheel events and Windows' set them); an event without ticks gets -round(3 × deltaY) (`dom/events/WheelEvent.cpp`
`WheelDeltaY`, `kTrustedDeltaToWheelDelta` = 3, read at Firefox 161), a pixel count. Taken as ticks, Playwright's 100-pixel notch
(-300, **measured**) counted 2.5 notches and moved the belt two items (Stage 7's browser suite, 2026-10-28), so in Firefox that exact
value takes the pixel rule (`wheelUnits(event, {gecko})`). A real wheel in Firefox is not measured; neither is a macOS trackpad, and
the conversion constants are a rule of this page. A sideways scroll is no notch. Unit tests: `test/wheel-input.test.mjs`. The listener is on `document`, non-passive (so that
Ctrl+wheel does not zoom the page), and only takes events that target the canvas or the locked pointer.

**Keys.** WinDrv's window procedure answers every key message itself, so the page takes every key the original can bind
(`GAME_KEY_CODES`: 113 codes, the keys of a standard keyboard that have a virtual-key code) from the browser with `preventDefault`,
whether or not User.ini binds it (`gameTakesKey`): Tab's focus move, F1's help, F3's find, F5's reload, F6, F7's caret browsing,
F12's devtools, the quick find of `/` and `'`, Space and the arrows scrolling, an Alt release focusing the menu bar. Before this step a key
was taken only when the simulation's last answer for it was "handled" (the answer comes a frame or more late; the first press of any key
is taken by default), so a later press of an unbound key (`/`, `-`, `\`, Home, Page Up…) ran the browser's action; `browser-tests/
input-bindings.spec.mjs` fails with the rule off. The auto-repeats of a held key were answered "not handled" too (the held-key rule of
`XInputExt::Process`, [console command chain](script-console-command.md)). The browser's chords with Ctrl or Meta (reload, devtools, find, save, new
tab…) stay the browser's outside fullscreen, so a developer can still reload; in fullscreen Keyboard Lock delivers them. Out of Play
(loading, a runtime error, a form control focused) nothing is taken, so F5 reloads after a runtime stop.

**Keyboard Lock.** On the original start, in the page's fullscreen, `navigator.keyboard.lock(GAME_KEY_CODES)` (Chromium only; the list
includes Escape, whose hold-to-exit stays) hands the page the keys the browser reserves. A runtime error relocks only Escape, so F5 reloads;
a reset or a new map locks the list again. Alt+Enter stays the fullscreen toggle (`0x1110a280`).

**Mouse.** The left, middle and right buttons are `pointerButtonKey` (1, 4, 2). A middle press does not start the browser's autoscroll, and
the back and forward buttons do not navigate (`preventDefault` on `mousedown`, `mouseup` and `auxclick`); WinDrv delivers none of them.

## Browser-reserved keys

What the page can and cannot take. "Prevented" is **measured**: the keydown and keyup of each key arrive with `defaultPrevented` set
(`browser-tests/input-bindings.spec.mjs`, Chromium's new headless mode, F3 to F12, Tab, Pause, CapsLock and six unbound keys, each
pressed three times). That mode sends key events straight to the page, so **the browser's own reaction to a key the page did not
prevent is not exercised**, and the rows below about what a browser does are its documented behaviour, not a measurement here.

| Keys | Outside fullscreen | In fullscreen with Keyboard Lock (Chromium) | Notes |
| --- | --- | --- | --- |
| F1, F3, F5, F6, F7, F10, F12, Tab, Backspace, Space, arrows, `/`, `'` | taken (`preventDefault`) | taken | Page-first browser accelerators: the page sees the key and cancels the action. |
| F11 | taken (expected: not a reserved accelerator outside fullscreen; unmeasured) | locked, delivered as `ActivateAugmentation 8` | Without the lock F11 leaves the page's fullscreen. |
| Escape | under the pointer lock the browser takes the press to release the lock, and the page never sees it (Chrome on Linux and macOS: the user needed two presses until 2026-10-30); the page hands the game that Escape (`main.mjs` `handEscape`), so one press opens the menu and frees the mouse; with the mouse already free the key is delivered | locked: the page keeps the lock; a held Escape (about two seconds) still leaves fullscreen | `ShowMainMenu` runs either way. A synthetic Escape (the specs') does not go through the browser's rule; the specs play the rule as its call, `exitPointerLock()` with no key. |
| Ctrl/Meta chords with a bound key (Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Tab…) | **not takeable**: the browser reserves new/close tab and window and tab switching | locked keys are delivered (the list includes the letters and Tab); the OS-level chords below still are not | Ctrl is unbound in User.ini; a player who binds it (`Ctrl=Duck`) and presses W loses the tab outside fullscreen. |
| Other Ctrl/Meta chords (Ctrl+R, Ctrl+F, Ctrl+S, F12 with Ctrl+Shift+I) | the browser's, on purpose (a developer keeps reload and devtools) | delivered to the game | `gameTakesKey` skips chords with Ctrl or Meta outside fullscreen. |
| Alt+F4, Alt+Tab, Win/Cmd keys, Cmd+Q/Cmd+W/Cmd+Tab, Ctrl+Alt+Del | **no browser lets a page take them** | same | Operating-system chords; Keyboard Lock does not reach them. |
| Firefox and Safari | taken where the browser lets `preventDefault` stop the action | no `navigator.keyboard.lock`: the reserved chords and F11 stay the browser's | The pointer lock, fullscreen and wheel rules are the same. |

## The table

All 163 lines of User.ini's `[Engine.Input]` section: 76 are bound (the Joy* lines have no browser device), the others are listed after. Each
row was **pressed through the page** by `browser-tests/input-bindings-table.spec.mjs` in Chromium's new headless mode, the simulation in its
worker, and checked in Play in `00_Training`: the binding line appears in the engine's command log (the exec function or alias was
reached) and the effect was observed through `input-probe.mjs` (the player, the hand, the belt, the weapon, the augmentations, the
windows). The same cases run without the page in `scripts/validate-input-bindings.mjs`. "Window" and "Fullscreen" say whether the page
takes the key (the preceding section): `locked` means it needs Keyboard Lock in fullscreen; (1) Escape, (2) F11 are the rows above; (3) the
key is bound by `DeusExRootWindow` itself when none of T, Y, B, K and `=` is bound ([typed keys](script-window-typed-keys.md)): the
multiplayer commands, which do nothing in single player.

`R` is `LookUp` and reload is `;`: User.ini and DefUser.ini both have `R=LookUp` (line 162) and `Semicolon=ReloadWeapon` (line 205), and those are the
original's defaults, kept. Both rows below are checked in Play: `R` pitches the view up (`Delete` too), `;` reloads the pistol (`ClipCount` 3 to 0).

<!-- TABLE -->
| Key | Binding | Browser input | Window | Fullscreen | In Play |
| --- | --- | --- | --- | --- | --- |
| LeftMouse | `ParseLeftClick\|Fire` | left button | yes | yes | bFire while held (no weapon in hand); with the pistol: ClipCount 0 -> 1 |
| RightMouse | `ParseRightClick` | right button | yes | yes | ParseRightClick picks up the highlighted Multitool3 (belt slot 1); with nothing highlighted: the hand is put away: the weapon plays Down in state DownWeapon, then inHand and Weapon are None |
| MiddleMouse | `DropItem` | middle button | yes | yes | DropItem drops Flare0 from the hand to the floor |
| Tab | `DropItem` | `Tab` | yes | yes, locked | DropItem drops Candybar1 from the hand to the floor |
| Enter | `ParseLeftClick\|Fire` | `Enter`, `NumpadEnter` | yes | yes | bFire while held (no weapon in hand); with the pistol: ClipCount 1 -> 2 |
| Shift | `Walking` = `Button bRun` | `ShiftLeft`, `ShiftRight` | yes | yes | bRun while held; the player walks (bIsWalking: bAlwaysRun is on) |
| Alt | `Strafe` = `Button bStrafe` | `AltLeft`, `AltRight` | yes | yes | bStrafe while held |
| Pause | `Pause` | `Pause` | yes | yes | the level pauses; a second press resumes |
| CapsLock | `ToggleWalk` | `CapsLock` | yes | yes | ToggleWalk flips bToggleWalk (0 -> 1) and bIsWalking (0 -> 1) |
| Escape | `ShowMainMenu` | `Escape` | yes (1) | yes, locked (1) | the main menu opens (deusex.menumain) |
| Space | `Jump` = `Jump \| Axis aUp Speed=+300.0` | `Space` | yes | yes | the player jumps (46 units up) |
| PageDown | `LookDown` = `Axis aLookUp Speed=-100.0` | `PageDown` | yes | yes | the view looks down (pitch -5966 units) |
| End | `CenterView` = `Button bSnapLevel` | `End` | yes | yes | bSnapLevel while held; the view pitch 8951 -> 0 |
| Left | `StrafeLeft` = `Axis aStrafe Speed=-300.0` | `ArrowLeft` | yes | yes | the player moves left (215 units in 0.6 s) |
| Up | `MoveForward` = `Axis aBaseY  Speed=+300.0` | `ArrowUp` | yes | yes | the player moves forward (206 units in 0.6 s) |
| Right | `StrafeRight` = `Axis aStrafe Speed=+300.0` | `ArrowRight` | yes | yes | the player moves right (216 units in 0.6 s) |
| Down | `MoveBackward` = `Axis aBaseY  Speed=-300.0` | `ArrowDown` | yes | yes | the player moves backward (140 units in 0.6 s) |
| Insert | `Jump` = `Jump \| Axis aUp Speed=+300.0` | `Insert` | yes | yes | the player jumps (46 units up) |
| Delete | `LookUp` = `Axis aLookUp Speed=+100.0` | `Delete` | yes | yes | the view looks up (pitch +5967 units) |
| 0 | `ActivateBelt 0` | `Digit0` | yes | yes | ActivateBelt 0 puts NanoKeyRing1 in hand |
| 1 | `ActivateBelt 1` | `Digit1` | yes | yes | ActivateBelt 1 puts Multitool3 in hand |
| 2 | `ActivateBelt 2` | `Digit2` | yes | yes | ActivateBelt 2 puts MedKit0 in hand |
| 3 | `ActivateBelt 3` | `Digit3` | yes | yes | ActivateBelt 3 puts Lockpick0 in hand |
| 4 | `ActivateBelt 4` | `Digit4` | yes | yes | ActivateBelt 4 puts BioelectricCell0 in hand |
| 5 | `ActivateBelt 5` | `Digit5` | yes | yes | ActivateBelt 5 puts Flare0 in hand |
| 6 | `ActivateBelt 6` | `Digit6` | yes | yes | ActivateBelt 6 puts Candybar1 in hand |
| 7 | `ActivateBelt 7` | `Digit7` | yes | yes | ActivateBelt 7 puts WeaponPistol1 in hand |
| 8 | `ActivateBelt 8` | `Digit8` | yes | yes | ActivateBelt 8 puts WeaponSawedOffShotgun0 in hand |
| 9 | `ActivateBelt 9` | `Digit9` | yes | yes | ActivateBelt 9 puts WeaponCrowbar0 in hand |
| F1 | `ShowInventoryWindow` | `F1` | yes | yes, locked | the inventory screen opens (deusex.personascreeninventory) |
| F2 | `ShowGoalsWindow` | `F2` | yes | yes | the goals screen opens (deusex.personascreengoals) |
| F3 | `ActivateAugmentation 0` | `F3` | yes | yes, locked | ActivateAugmentation 0 toggles deusex.augballistic (active false -> true) |
| F4 | `ActivateAugmentation 1` | `F4` | yes | yes | ActivateAugmentation 1: no augmentation in that slot; the HUD log gets its message (1.3 s since the last -> 0.7 s), nothing toggles |
| F5 | `ActivateAugmentation 2` | `F5` | yes | yes, locked | ActivateAugmentation 2: no augmentation in that slot; the HUD log gets its message (1.3 s since the last -> 0.7 s), nothing toggles |
| F6 | `ActivateAugmentation 3` | `F6` | yes | yes, locked | ActivateAugmentation 3: no augmentation in that slot; the HUD log gets its message (1.3 s since the last -> 0.7 s), nothing toggles |
| F7 | `ActivateAugmentation 4` | `F7` | yes | yes, locked | ActivateAugmentation 4 toggles deusex.augspeed (active false -> true) |
| F8 | `ActivateAugmentation 5` | `F8` | yes | yes | ActivateAugmentation 5: no augmentation in that slot; the HUD log gets its message (1.3 s since the last -> 0.7 s), nothing toggles |
| F9 | `ActivateAugmentation 6` | `F9` | yes | yes | ActivateAugmentation 6: no augmentation in that slot; the HUD log gets its message (1.3 s since the last -> 0.7 s), nothing toggles |
| F10 | `ActivateAugmentation 7` | `F10` | yes | yes, locked | ActivateAugmentation 7: no augmentation in that slot; the HUD log gets its message (1.3 s since the last -> 0.7 s), nothing toggles |
| F11 | `ActivateAugmentation 8` | `F11` | yes (2) | yes, locked (2) | ActivateAugmentation 8: no augmentation in that slot; the HUD log gets its message (1.2 s since the last -> 0.7 s), nothing toggles |
| F12 | `ActivateAugmentation 9` | `F12` | yes | yes, locked | ActivateAugmentation 9 toggles deusex.auglight (active false -> true) |
| Equals | `ShowScores` (3) | `Equal` | yes | yes | ShowScores ran; a multiplayer command, nothing opens in single player |
| Comma | `StrafeLeft` = `Axis aStrafe Speed=-300.0` | `Comma` | yes | yes | the player moves left (210 units in 0.6 s) |
| Period | `StrafeRight` = `Axis aStrafe Speed=+300.0` | `Period` | yes | yes | the player moves right (216 units in 0.6 s) |
| LeftBracket | `ToggleScope` | `BracketLeft` | yes | yes | ToggleScope turns the scope on (zoomed) |
| RightBracket | `ToggleLaser` | `BracketRight` | yes | yes | ToggleLaser turns the laser sight on (lasing) |
| MouseX | `Axis aMouseX Speed=6.0` | pointer motion (relative, locked) | yes | yes | relative pointer motion turns the view (yaw +1427) |
| MouseY | `Axis aMouseY Speed=6.0` | pointer motion (relative, locked) | yes | yes | relative pointer motion pitches the view (pitch -955) |
| Backspace | `PutInHand` | `Backspace` | yes | yes | PutInHand: the hand is put away: the weapon plays Down in state DownWeapon, then inHand and Weapon are None |
| A | `StrafeLeft` = `Axis aStrafe Speed=-300.0` | `KeyA` | yes | yes | the player moves left (215 units in 0.6 s) |
| B | `BuySkills` (3) | `KeyB` | yes | yes | BuySkills ran; a multiplayer command, nothing opens in single player |
| C | `TurnRight` = `Axis aBaseX  Speed=+150.0` | `KeyC` | yes | yes | the view turns right (yaw +8313 units) |
| D | `StrafeRight` = `Axis aStrafe Speed=+300.0` | `KeyD` | yes | yes | the player moves right (200 units in 0.6 s) |
| E | `LeanRight` = `Axis aExtra0 Speed=+0.05` | `KeyE` | yes | yes | the player leans right (curLeanDist 40.0, view roll 800) |
| F | `CenterView` = `Button bSnapLevel` | `KeyF` | yes | yes | bSnapLevel while held; the view pitch 9380 -> 0 |
| G | `ShowGoalsWindow` | `KeyG` | yes | yes | the goals screen opens (deusex.personascreengoals). In a window: rebound in MenuScreenCustomizeKeys to ParseRightClick: the key then picks up the highlighted Multitool4 and opens no goals screen |
| I | `ShowInventoryWindow` | `KeyI` | yes | yes | the inventory screen opens (deusex.personascreeninventory) |
| K | `KillerProfile` (3) | `KeyK` | yes | yes | KillerProfile ran; a multiplayer command, nothing opens in single player |
| M | `Look` = `Button bLook` | `KeyM` | yes | yes | bLook while held |
| Q | `LeanLeft` = `Axis aExtra0 Speed=-0.05` | `KeyQ` | yes | yes | the player leans left (curLeanDist -40.0, view roll -800) |
| R | `LookUp` = `Axis aLookUp Speed=+100.0` | `KeyR` | yes | yes | the view looks up (pitch +9380 units) |
| S | `MoveBackward` = `Axis aBaseY  Speed=-300.0` | `KeyS` | yes | yes | the player moves backward (150 units in 0.6 s) |
| T | `Talk` (3) | `KeyT` | yes | yes | the console enters its Typing state (Talk) |
| V | `LookDown` = `Axis aLookUp Speed=-100.0` | `KeyV` | yes | yes | the view looks down (pitch -6179 units) |
| W | `MoveForward` = `Axis aBaseY  Speed=+300.0` | `KeyW` | yes | yes | the player moves forward (200 units in 0.6 s) |
| X | `Duck` = `Button bDuck \| Axis aUp Speed=-300.0` | `KeyX` | yes | yes | bDuck while held; the player crouches (eye 13.2) |
| Y | `TeamTalk` (3) | `KeyY` | yes | yes | TeamTalk ran; a multiplayer command, nothing opens in single player |
| Z | `TurnLeft` = `Axis aBaseX Speed=-150.0` | `KeyZ` | yes | yes | the view turns left (yaw -7993 units) |
| GreyStar | `Shot` | `NumpadMultiply` | yes | yes | delivered; stops at the screenshot command (UViewport::Exec SHOT is not implemented). the binding line Shot ran; the viewport command is refused with a toast and Play goes on |
| GreyPlus | `QuickSave` | `NumpadAdd` | yes | yes | the binding line QuickSave ran; DeusExPlayer.QuickSave runs with no runtime error and Play goes on (the slot it writes: save-game.spec.mjs) |
| NumPadPeriod | `Duck` = `Button bDuck \| Axis aUp Speed=-300.0` | `NumpadDecimal` | yes | yes | bDuck while held; the player crouches (eye 13.0) |
| GreySlash | `QuickLoad` | `NumpadDivide` | yes | yes | delivered; stops at loading a save (Stage 6's save system; only the confirmation is implemented). the original's confirmation opens (deusex.menuuimessageboxwindow); answering it would read a save |
| Semicolon | `ReloadWeapon` | `Semicolon` | yes | yes | ReloadWeapon reloads the pistol: ClipCount 3 -> 0 (9 rounds left) |
| SingleQuote | `SwitchAmmo` | `Quote` | yes | yes | SwitchAmmo cycles the shotgun's ammunition: deusex.ammoshell -> deusex.ammosabot |
| MouseWheelDown | `NextBeltItem` | wheel down | yes | yes | NextBeltItem puts MedKit0 in hand. In a window: while a screen holds the mouse the root consumes the wheel keys and NextBeltItem does not run; over a scroll area (the Customize Keys list) it scrolls the list down |
| MouseWheelUp | `PrevBeltItem` | wheel up | yes | yes | PrevBeltItem puts Multitool3 in hand. In a window: while a screen holds the mouse the root consumes the wheel keys and PrevBeltItem does not run; over a scroll area it scrolls the list up; rebound in MenuScreenCustomizeKeys (the wheel is taken as a key) to ParseRightClick, a notch up then runs it |

76 bound lines (74 with an observed effect, 2 delivered and stopping at a later stage's system). Unbound lines of [Engine.Input]:

| Key | Browser input | In Play |
| --- | --- | --- |
| Ctrl | `ControlLeft`, `ControlRight` | no binding: the press runs no command |
| Minus | `Minus` | no binding: the press runs no command |
| Slash | `Slash` | no binding: the press runs no command |
| Backslash | `Backslash` | no binding: the press runs no command |
| MouseW | none | no browser key or button |
| None | none | no browser key or button |
| Cancel | none | no browser key or button |
| PageUp | `PageUp` | no binding: the press runs no command |
| home | `Home` | no binding: the press runs no command |
| Select | none | no browser key or button |
| Print | none | no browser key or button |
| Execute | none | no browser key or button |
| PrintScrn | `PrintScreen` | no binding: the press runs no command |
| Help | none | no browser key or button |
| H | `KeyH` | no binding: the press runs no command |
| J | `KeyJ` | no binding: the press runs no command |
| L | `KeyL` | no binding: the press runs no command |
| O | `KeyO` | no binding: the press runs no command |
| P | `KeyP` | no binding: the press runs no command |
| U | `KeyU` | no binding: the press runs no command |
| NumPad0 | `Numpad0` | no binding: the press runs no command |
| NumPad1 | `Numpad1` | no binding: the press runs no command |
| NumPad2 | `Numpad2` | no binding: the press runs no command |
| NumPad3 | `Numpad3` | no binding: the press runs no command |
| NumPad4 | `Numpad4` | no binding: the press runs no command |
| NumPad5 | `Numpad5` | no binding: the press runs no command |
| NumPad6 | `Numpad6` | no binding: the press runs no command |
| NumPad7 | `Numpad7` | no binding: the press runs no command |
| NumPad8 | `Numpad8` | no binding: the press runs no command |
| NumPad9 | `Numpad9` | no binding: the press runs no command |
| Separator | none | no browser key or button |
| GreyMinus | `NumpadSubtract` | no binding: the press runs no command |
| F13 | `F13` | not pressed here: keyboard.down: Unknown key: "F13" |
| F14 | `F14` | not pressed here: keyboard.down: Unknown key: "F14" |
| F15 | `F15` | not pressed here: keyboard.down: Unknown key: "F15" |
| F16 | `F16` | not pressed here: keyboard.down: Unknown key: "F16" |
| F17 | `F17` | not pressed here: keyboard.down: Unknown key: "F17" |
| F18 | `F18` | not pressed here: keyboard.down: Unknown key: "F18" |
| F19 | `F19` | not pressed here: keyboard.down: Unknown key: "F19" |
| F20 | `F20` | not pressed here: keyboard.down: Unknown key: "F20" |
| F21 | `F21` | not pressed here: keyboard.down: Unknown key: "F21" |
| F22 | `F22` | not pressed here: keyboard.down: Unknown key: "F22" |
| F23 | `F23` | not pressed here: keyboard.down: Unknown key: "F23" |
| F24 | `F24` | not pressed here: keyboard.down: Unknown key: "F24" |
| NumLock | `NumLock` | no binding: the press runs no command |
| ScrollLock | `ScrollLock` | no binding: the press runs no command |
| LShift | none | no browser key or button |
| RShift | none | no browser key or button |
| LControl | none | no browser key or button |
| RControl | none | no browser key or button |
| Tilde | `Backquote` | no binding: the press runs no command |
| Attn | none | no browser key or button |
| CrSel | none | no browser key or button |
| ExSel | none | no browser key or button |
| ErEof | none | no browser key or button |
| Play | none | no browser key or button |
| Zoom | none | no browser key or button |
| NoName | none | no browser key or button |
| PA1 | none | no browser key or button |
| OemClear | none | no browser key or button |
| MouseZ | none | no browser key or button |

26 Joy* lines (Joy1=Fire, Joy2=Jump, Joy4=Duck, JoyX=Axis astrafe speed=2, JoyY=Axis aBaseY speed=2, JoyU=Axis aturn speed=5.9, JoyV=Axis aLookUp speed=-3) have no browser device in this page: a gamepad is not read.
<!-- /TABLE -->

## Customize Keys

The original's `MenuScreenCustomizeKeys` (Options → Controls → Customize Keys) rebinds in Play and the new binding runs. Through the page's
real keys: Down and Enter on the second row make it wait for a key; `G` is taken as that key; OK (`SET InputExt G ParseRightClick`) replaces
`ShowGoalsWindow`; then `G` with an item highlighted picks it up and opens no goals screen. The wheel is a key the screen takes too (the row
waits for any key, mouse keys included): a notch up rebinds `MouseWheelUp`, and the next notch up then runs the new binding. The key list is a
scroll area: with the cursor over it a notch down moves the thumb one step, a notch up back, and in the inventory screen the wheel is consumed by
the root (the belt does not move). The changed bindings are written to `[Extension.InputExt]` of User.ini at OK (measured under Wine) and kept across a page reload on the default start
([configuration persistence](config-persistence.md)).

## Putting the hand away

With a weapon in hand and nothing highlighted, both paths run in Play. Right click: `ParseRightClick`'s last branch (`DeusExPlayer.uc`: no
`FrobTarget`, a `POVCorpse` is dropped, else `PutInHand(None)`). Backspace: `PutInHand` without an argument (`SetInHandPending(None)`, after
dropping a carried decoration). In both the crowbar goes to state `DownWeapon` playing `Down` (animation frame -0.17 after the first tick, 0.11 after six, 0.67 after sixteen),
and `inHand` and `Weapon` are `None` before thirty-six ticks (0.6 s) have passed.

## Checks

* `node scripts/validate-viewport-input-diff.mjs` (needs `NATIVE_PROBE_PYTHON`): the original WinDrv procedure against the page's translations.
* `node --test test/wheel-input.test.mjs`: the delta conversion, the accumulator and the key list.
* `node scripts/validate-input-bindings.mjs [--table out.json]`: every row on a headless game (about 80 seconds), plus the wheel in windows and the rebinding.
* `DX_BASE_URL=… npx playwright test -c .work/playwright.dev.config.mjs browser-tests/input-bindings.spec.mjs` (the wheel, the F keys, Tab and the Keyboard Lock call) and
  `browser-tests/input-bindings-table.spec.mjs` (the table, through the page). `node scripts/input-bindings-table.mjs table.json` writes the markdown above.

## Unsupported or not measured

* **Gamepad** (`Joy1`–`Joy16`, `JoyX`…): no browser device is read.
* **Shot** (`NumpadMultiply`) stops on `UViewport::Exec SHOT` with a toast; **QuickLoad** (`NumpadDivide`) asks, and the table does
  not answer it. **QuickSave** (`NumpadAdd`) runs in Play since Stage 6 (DeusExPlayer.QuickSave saves unless a DataLink plays or the
  player is dead; `save-game.spec.mjs` checks the slot); the headless validator's game, built without a travelling session, still
  stops at SaveGame (native 3011).
* **Numpad with NumLock off**: Windows then sends `VK_HOME`, `VK_UP`… for the numpad keys; the page always sends the NumLock-on key
  (`NumPad0`–`9`, `NumPadPeriod`), as a Mac keyboard has no NumLock to ask.
* Keys with no virtual-key code in a browser (`IntlBackslash`, the Windows/Menu keys), and `PrintScreen`, which Windows browsers report only on keyup.
* CapsLock on macOS reports keydown only when it turns on and keyup when it turns off, so `ToggleWalk` toggles twice per press-pair there.
* Wheel feel on macOS trackpads and a real wheel in Firefox (the conversion constants; Firefox's tickless `wheelDeltaY` is handled, above), the browser-reserved chords and the real Escape under Keyboard Lock (above).
* A Wine run of the original: the original code is run in the oracle instead.
