# Interface frames against the original

Until 2026-10-15 no frame of the original's HUD, menus or screens had been compared with Play's: the window system, the GC and its text were
compared with Extension.dll natives one by one ([GC drawing](script-gc-draw-model.md), [window host](script-window-host.md)), and the HUD, a
datacube, the keypad and the DataLink ran the original bytecode through the real input paths ([Play HUD](script-play-hud.md)), but what the player
sees was compared with nothing (Stage 4 gate rows 4.4.11 to 4.4.14, [exit criteria](stage-4-exit-criteria.md)). This note is the capture recipe and
its results: eighteen interface views of 00_Training, taken in the running original under Wine and in Play with the same inputs, compared pixel
for pixel.

## The recipe

`scripts/interface-acceptance.mjs` takes the frames and compares them; the scenario (the views, their steps and their order) is
`scripts/interface-views.mjs`, shared with the gate. Each view is a list of steps a player has the means for: a console line, a key, a click, a
mouse move, a wait, and the shot.

| | the original (DeusEx.exe under Wine, `scripts/original-run.sh 00_Training node scripts/interface-acceptance.mjs original`) | Play (`interface-acceptance.mjs play`, the default worker mode, `?antialias=0&detailTextures=0`) |
| --- | --- | --- |
| Console line | `ad/tools/dxinput.exe`'s `cmd` (Talk, the "Say " prefix cleared, the text, Enter) | `viewProbe({exec})`: `PlayerPawn.ConsoleCommand` through the original console command chain |
| Keys, clicks | `dxinput` posts `WM_KEYDOWN`, `WM_MOUSEMOVE` and the button messages to the viewport window | Playwright's keyboard and mouse on the page: the page's own key and pointer handlers |
| The frame | Print Screen (`key PRINT`), the root window's own `Shot` (`DeusExRootWindow.VirtualKeyPressed` calls `ConsoleCommand("SHOT")`): a modal screen takes every key but that one ([security cameras](visual-acceptance.md#method-2), item 3). With the HUD up Print reaches no binding, so those views use the numpad `*` (`GreyStar=Shot`) | the page's canvas, pinned to 1280x720 at the page origin, the page UI hidden |
| Brightness | `set WinDrv.WindowsClient Brightness 0.666667`: at 2/3 `Shot` is the framebuffer (same section, item 6) | `set WinDrv.WindowsClient Brightness 0.4` through the same console: its display ramp is the identity there. A menu's `FLUSH` (`ShowMainMenu` runs it) re-reads Brightness from the config on both sides (D3DDrv Flush), so the config value must be the matched one, not only the page's slider |
| World | `set LevelInfo bPlayersOnly True` before `open`, `ghost`, TimeDilation 0.001 at the level time the original measured ([Method](visual-acceptance.md#method)); the camera is 00_Training's start view | `?hold=1`, `bPlayersOnly`, `ghost`, then the level is run (a fixed 1/60 s per page frame, so the hold lands on the same time) to the original's level time less what the settle adds, and held at 0.001 |
| Timing | one dxinput script per view (so the interface's real-time timers see the spacing the scenario states) | wall-clock waits; after the hold the page's frame time is real (`window.__fixedDt` cleared) |

**Stored with each frame.** `.work/acceptance/<map>/<view>-original.png` and `<view>-time.txt`, the level time the frame was taken at (a
frame must keep its own clock beside it: the gate's [stored originals](stage-4-exit-criteria.md#stored-originals)). Play runs to the first view's time.
In the stored capture (2026-10-15) the first frame is at 49.9107 s and each later view is 10 to 25 ms on: the real seconds its steps take, at
TimeDilation 0.001 (the player's own ticks and the window system run on real time).

**What each side does not share.** The original's launch copy of the ini (`DeusEx-ad.ini`, `User-ad.ini`) silences the three volumes and binds two
extra keys, and the installed `User.ini` of the Wine prefix differs from the supplied one in a few keys (`bHelpMessages`, the aug preferences). A
screen that shows such a value would differ for that reason, not Play's: the scenario avoids the Controls, Sound and Display screens of the Settings
menu (key bindings, volumes, brightness) and compares Game Options and Colors, whose choices read the same values on both sides.

## The scenario

Eighteen views, in this order (the order is part of the scenario: the log's lines and the notes accumulate, the crowbar stays in the belt, the
frobbed screens leave the player walking at their pose). The gate rows list the views each judges.

| Gate row | View | Steps |
| --- | --- | --- |
| 4.4.11 | `ui-hud` | `say Interface frame`, shot 1.4 s on: the health display, compass, key ring belt, the log line |
| | `ui-hud-late` | `say Late frame`, shot six seconds on: the log's three-second timeout has passed |
| | `ui-belt` | `ghost`, placed at the crowbar, `walk`, a right click (WeaponCrowbar1 into belt slot 1), the HUD |
| 4.4.12 | `ui-inv`, `ui-health`, `ui-skills`, `ui-logs`, `ui-images`, `ui-conversations` | the exec function (`ShowInventoryWindow` ...), shot, Esc |
| | `ui-goals`, `ui-augs` | `NoteAdd` / `AugAdd AugHealing` first, then `ShowGoalsWindow` / `ShowAugmentationsWindow` |
| | `ui-inv2` | the inventory screen with the crowbar |
| 4.4.13 | `ui-menu` | Esc: the main menu |
| | `ui-settings`, `ui-options`, `ui-colors` | Esc, a click on Settings, then on Game Options or Colors: the Settings menu, Game Options and Adjust Colors |
| 4.4.14 | `ui-datacube` | `ghost`, placed 48 units from DataCube0, `walk`, a right click: the information display with the text and its DataVault log line |
| | `ui-keypad` | the same in front of Keypad0: the keypad window |

The poses of the last three were found by the original's own FrobTarget: a ghost has none (PlayerFlying, PlayerWalking and PlayerSwimming run
`HighlightCenterObject` in their `PlayerTick`; the engine's CheatFlying does not), so each view puts the ghost where the object is in range, `walk`s
(`SetCollision(true)` registers the player at the new Location; a bare `set Location` of a walking player asserts, but the ghost has no hash entry, see
`view-probe.mjs`), and the right click frobs what the walking player highlights. Both programs selected the same object at every pose.

## Running it

```bash
node scripts/interface-acceptance.mjs play   [--map 00_Training] [--views a,b]        # Play's frames: .work/acceptance/<map>/<view>-play.png
scripts/original-run.sh 00_Training node scripts/interface-acceptance.mjs original    # the original's (Wine lock, one DeusEx.exe): -original.png and -time.txt
node scripts/interface-acceptance.mjs compare [--map 00_Training] [--views a,b] [--crop WxH+X+Y]
```

`compare` prints, per view, the share of identical pixels, the pixels off by more than 2 and by more than 10 (any channel, of 255), the mean
absolute difference and the edge metrics of `visual-acceptance.mjs compare`, and writes `interface-play-report.json`. `--adhoc file.json`
replaces the scenario by an experiment's views (`{name: {modal, steps}}`), run in order on both sides; `--settle ms` is the wait after the camera
is placed (12 s, so the start text and the load's log lines are gone).
