# Computer terminals in Play — 2026-10-07

This page covers the ATMs, the public, personal and security computers, and
their NetworkTerminal screens in Play. Every check below drives the original
frob path: the view trace, `ParseRightClick`, then `Frob`. The text-window
natives these screens use are documented in
[ComputerWindow](script-window-computer.md),
[typed characters](script-window-typed-keys.md) and the
[ListWindow family](script-window-list-family.md).

Check: `scripts/validate-terminals-play.mjs`. Census:
`.work/census-terminals.mjs` (local; it reads each map's export classes).

## Where they are

Map exports, counted by class: `ATM`, `ComputerPublic`, `ComputerPersonal`,
`ComputerSecurity`, `SecurityCamera` and `AutoTurret`.
* 01_NYC_UNATCOIsland has:
  * ATM0;
  * ComputerPersonal0;
  * ComputerSecurity0–2;
  * 7 cameras;
  * 3 turrets.
* 01_NYC_UNATCOHQ has:
  * ComputerPublic0;
  * an ATM;
  * 7 personal computers.
* Public terminals also stand in 02_NYC_Street, the Bars, the Hotels,
  Paris and Hong Kong.
* Security computers are in most later maps; 06_HongKong_VersaLife has 73
  personal computers.

## Frobbing a terminal

* **Approach from the front.** ATM0 is mounted in a wall, facing along its
  Rotation yaw (−16400, that is −Y). The test fixture's default `aim`
  stands 48 units from the target, along the line from wherever the player
  happens to be.
  * For ATM0 that line comes from behind the wall, so the eye
    (Location.Z + BaseEyeHeight) is inside the BSP.
  * `HighlightCenterObject`'s `TraceActors` (MultiLineCheck) then hits the
    world at t = 0 before reaching the ATM, and FrobTarget stays None.
  * From the front, the same trace selects ATM0 on the first frob tick.

  So this was a test-placement issue, not a frob-path bug. The check stands
  56 units in front of each terminal.
* **Wait for the startup animation.** `Computers` are `bStasis` actors, so
  they tick only once seen or near the player. An authored-on computer
  (`bOn = True`, for example ComputerSecurity1) then runs `auto state Off`:
  `PlayAnim('Deactivate')`, `FinishAnim`.
  * `Computers.Frob` ignores the player while `bAnimating`.
  * The check therefore aims, lets the animation finish, aims again, and
    uses.
  * `state On` then plays `Activate` before `TryInvoke` opens the terminal.
* **Headless runs can freeze a computer.** Headless runs draw no world, so
  nothing stamps the zones' or the actors' `LastRenderTime`. After 5 s of
  level time, `AActor::Tick`'s stasis rule (`actor-tick.mjs actorInStasis`)
  freezes a Physics-None computer mid-animation. Play stamps both from its
  drawn set (`sim-session.mjs`), so this happens only in headless runs. The
  check runs each terminal on a fresh game, in its own child process.

## Reach

| Terminal | Map | Result |
| --- | --- | --- |
| ATM0 (`ATMWindow`) | Island | A wrong PIN is refused. 230023/4558 opens the withdraw screen with balance 200. Withdrawing 50 adds 50 to the player's `Credits` (500 → 550), leaves 150 and shows "50 CREDITS WITHDRAWN". Escape logs out to the login screen; a second Escape closes the ATM. |
| ComputerPersonal0 (`NetworkTerminalPersonal`) | Island | KLloyd/squishy opens the e-mail screen (`01_EmailMenu_klloyd`, 2 messages, the first shown). GUEST logs in to "No Email Today!", because DeusExText has no `01_EmailMenu_GUEST`. Escape logs out; Escape on the login screen closes the terminal. |
| ComputerPublic0 (`NetworkTerminalPublic`) | UNATCO HQ | Six bulletins with the first shown. Down shows the second. Escape closes the terminal and the computer turns off (`state Off`, `bOn = False`). |
| ComputerSecurity1 (`NetworkTerminalSecurity`) | Island | NSF001/smashthestate logs in. `ComputerScreenSecurity` builds its choices, camera buttons and three camera windows, whose `ViewportWindow`s the host now admits ([script-window-viewport.md](script-window-viewport.md)). It then stops in the pan slider's `MenuUISliderButtonWindow.InitWindow` at ScaleManagerWindow native 1667 (SetMarginSpacing), which is not translated yet: **explicitly unsupported**. |

Not driven yet:
* the ATM disabled screen, hacking and the special-options screens;
* every security computer's camera, door and turret choices (they sit
  behind the pan slider's ScaleManager/Scale natives);
* the camera image itself: Draw queues a `viewport` command, but the page's
  second camera pass is not implemented;
* the other maps' terminals.

`XComputerWindow::VirtualKeyPressed` (`0x1000f530`) is reached by none of
these screens. Only `HUDInfoLinkDisplay`'s text is an `XComputerWindow`; the
terminal screens derive from `ComputerUIWindow`, which extends `Window`.
