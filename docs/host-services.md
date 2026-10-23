# Host services the original menus ask for

Three things the options menus do are not script natives: they are engine commands the scripts send through `ConsoleCommand`, and a
tick the window system runs. The browser is the host, so each becomes a request to the page or a service of the window host. This page
records the original code behind each, what Play does, and how each is checked (`scripts/validate-host-services-play.mjs`, headless
Chromium on the default start with the real mouse; `scripts/validate-native-config.mjs` for the Exec chain; the mouse/focus oracle for
the tick). Found by the menu sweep ([native census](native-census.md), "The menu sweep").

## Button auto-repeat (Customize Keys' scroll arrows)

`ButtonWindow.EnableAutoRepeat` (1595) sets bit 2 of the button flags (`+0x174`), the initial delay (`+0x17c`) and the repeat rate (`+0x180`).
A mouse press (bit 1 of the flags) stores the delay in the countdown (`+0x19c`). **XButtonWindow::Tick** (Extension.dll `0x10008190`,
the Button and Toggle families' tick) is the rest:

1. Nothing happens unless the button is pressed (bit 1) and auto-repeating (bit 2).
2. `countdown = countdown - deltaTime` (fld, fsub on the x87 stack), stored as a float32 (`fst`); the extended value stays on the stack. A
   countdown that is not below zero (`fcom` against the double 0.0 at `0x1005a450`: equal or greater) ends the tick; below zero or NaN
   continues.
3. `countdown += repeatRate` (fadd, `fst`); if that is still below zero or NaN, the countdown is the repeat rate itself.
4. The pointer is read with `XWindow::GetCursorPos` (`0x1004cbf0`): the root's mouse position (`+0x590/+0x594`) less the window's clip
   origin (`+0xd4/+0xd8`), each result a float32. A window with no root leaves the outputs unwritten (a boundary here).
5. Only when the pointer lies inside the window (`XWindow::IsPointInWindow` `0x1004f830`): the click sound (`+0x194`) plays at volume -1.0
   and pitch 1.0 (`0x1004ffb0`), and the button activates for the key byte `+0x1a0` (`XButtonWindow::ActivateButton` `0x100077e0`: the
   `ButtonActivated` (or, for key 2, `ButtonActivatedRight`) virtual on the window and each ancestor until one handles it).

Play: `buttonTick` in `src/runtime/script-window-input.mjs`, with `getCursorPos` in `script-window-mouse.mjs`; the window host's tick
dispatch (`script-window-host.mjs`) calls it for Button and Toggle windows. Check: `validate-window-mouse-focus-diff.mjs` runs `0x10008190`
unchanged (with the real `GetCursorPos`, `IsPointInWindow`, `ActivateButton` and the virtuals) in Unicorn against the translation over 24
cases and 142 steps, floats as bits: idle and non-repeating buttons, a running countdown, expiry inside and outside the window, the right
key, the countdown reloaded by a long frame, NaN and signed-zero countdowns and deltas, tiny countdowns, a clip origin that rounds, and
`-1 - 1e-8 + 1` (the extended value across the compare; a rounded `-1 + 1` differs). The mutations that matter are killed (the NaN branch,
the sum's pointer test, the sound, the activation, the flag test); the one survivor rounds the second sum to float32 early and is
equivalent (a sum of float32 values never changes sign by rounding). In Chromium holding the down arrow scrolls the key list 17 steps in
two seconds (0.5 s delay, 0.1 s rate) against one step for a click; releasing stops it.

## Toggle Full-Screen Mode

`MenuChoice_FullScreen` sends `ConsoleCommand("TOGGLEFULLSCREEN")`. The Exec chain reaches `UWindowsViewport::Exec` (WinDrv `0x11106d90`),
which tests `EndFullscreen` and then `ToggleFullscreen` (`0x11106e07`: `UWindowsViewport::ToggleFullscreen` `0x1110105a` -> `0x1110d500`
on the viewport, then returns 1). It is the same call the viewport's `WM_KEYDOWN` handler makes for Alt+Enter (`0x1110a29b`).

Play: `script-console-command.mjs` `viewportExec` calls `services.toggleFullscreen()`; the window host counts the request in its `display`
state (`fullscreenToggles`), `sim-session.mjs` carries it in the frame snapshot with the other display settings, and `main.mjs`
`applyDisplaySettings` performs it once with the function Alt+Enter uses (`toggleFullscreen`: leave fullscreen and release the pointer, or
take fullscreen and the pointer). A browser grants fullscreen on a user activation (about five seconds); the menu click that sent the
command is that activation. `EndFullscreen` and the other `UWindowsViewport::Exec` keywords stay unsupported
(`UnsupportedConsoleCommandError`).

Check: the Display screen's choice in `validate-native-config.mjs` (one request per press, the screen stays open, the keyword is
case-insensitive and logs nothing) and, in Chromium, `validate-host-services-play.mjs`: the default start is windowed (its first click takes only the
pointer), the choice takes fullscreen and the next press leaves it (pointer released too).

## RELAUNCH -changevideo

The Render Device choice (`MenuChoice_RenderDevice`) raises a prompt; its Yes saves the menu's settings and sends
`ConsoleCommand("RELAUNCH -changevideo")`. `USystem::Exec` (Core `0x1016b878-0x1016bb6b`) logs `Relaunch: %s` with the text after the
keyword, flushes the log, builds the path of `deusex.exe` from `GetModuleFileName`, starts a new instance with that text as its arguments
(`ShellExecute "open"`) and calls `appRequestExit(0)`: the running game ends and a new one starts (`-changevideo` makes the launcher show
its video setup).

Play: `script-console-command.mjs` `engineExec` hands the argument text to `services.relaunch()`; the window host records it (`relaunches`,
`relaunchArguments`), the snapshot carries it, and the page dispatches a cancelable `deusex-relaunch` event on `window` (detail
`{arguments}`) and then reloads the page, which is the browser's restart. A listener that cancels the event keeps the page (the menu sweep
and the validator do). The browser has no video driver to choose, so the restart re-runs the boot; because the ini files are not written back
yet (Stage 6), the settings changed before the restart are lost, which the original would have kept.

Check: `validate-native-config.mjs` (the prompt alone relaunches nothing; its Yes records `-changevideo`; spacing after the keyword is
dropped) and `validate-host-services-play.mjs` (the event, cancelled once, then the reload with the event left alone).

## Exit

MenuMain's last button (`buttonDefaults[9]`, action `MA_Quit`) raises `MenuUIWindow`'s message box in mode `MB_Exit`; Escape or No closes it
(`MenuUIMessageBoxWindow.VirtualKeyPressed`: Escape posts result 1), Enter, Space, Y or Yes posts 0 and `BoxOptionSelected` calls
`DeusExRootWindow.ExitGame`: `ClearWindowStack()`, then `ConsoleCommand("Exit")`. The Exec chain reaches `USystem::Exec` (Core), which tests
`EXIT` (`0x1016b849`) and `QUIT` (`0x1016b862`) and for either jumps to `0x1016bb43`: `Ar.Log("Closing by request")` (the line goes to the caller's
output device, here the string `ConsoleCommand` returns, not the log), `appRequestExit(0)` and `return 1`. `appRequestExit` (`0x1016b2f0`) logs
`appRequestExit(%i)`; with 0 it posts `PostQuitMessage(0)` and sets `GIsRequestingExit` (a nonzero argument would call `ExitProcess(1)`). The main
loop ends after the tick and the engine shuts down.

Measured under CrossOver (2026-10-23, capture `mm1` of `scripts/validate-menu-main.mjs --capture`): the box, its Escape back to MenuMain, then in a
running game Exit and Enter: the log's last level lines are followed by `Log: appRequestExit(0)`, `Exit: Preparing to exit.`, the unbinding and
unloading lines, `Exit: Exiting.` and the memory report, and the process is gone. Neither `DeusEx-ad.ini` nor `User-ad.ini` was rewritten by the
exit (their times are those of the launch's copies): the settings are written by each screen's OK ([config persistence](config-persistence.md)),
not at the exit.

Play: `script-console-command.mjs` `engineExec` claims `EXIT` and `QUIT` before `RELAUNCH`, writes `Closing by request` to the caller's output and
calls `services.requestExit()`; the window host logs `Log: appRequestExit(0)` into the engine log and counts the request (`display.exitRequests`),
the snapshot carries it, and the page dispatches a cancelable `deusex-exit` event on `window`. A page cannot close itself, so when the event is
left alone the page ends the game in its place: the simulation worker is terminated, the sound stops, the view is hidden and the page says that
the game has exited and that a reload starts it again (`main.mjs` `endGame`): that presentation is the page's choice, not a measurement. The
engine's shutdown lines after `appRequestExit(0)` are the original's own teardown and are not modeled. `exit` typed at the console takes the same
route (its line is run with a string output device). A key bound to `Exit` does not: the input path hands the Exec chain the console's output
device, which Play has not linked, so `Closing by request` stops by name (`UnsupportedConsoleCommandError`), as any command that writes to the
console does from a binding (read from the code, not run; the default bindings bind no key to it).

Check: `scripts/validate-menu-main.mjs` (row 6.1.6: every MenuMain entry's window stack against the original's, and Exit's Yes: the engine log takes
`appRequestExit(0)`, one exit request, the window stack cleared).
