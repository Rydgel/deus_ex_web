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

## Results (2026-10-15)

Each row is one frame, 921,600 pixels: the share identical (all three channels), the pixels off by more than 2 and by more than 10 of 255 in any
channel, then the edge recall and precision of `visual-acceptance.mjs compare` (the share of the original's strongest 5% Sobel edges that Play has
within 2 pixels, and the converse). "Before" is Play with the two fixes below taken out, against the same stored frames; "after" is Play as committed.
The mean absolute difference reads 0.00 to 0.02 in every row after, and the mean-luminance ratio 1.000.

| View | before: identical, >2, >10, recall/precision | after: identical, >2, >10, recall/precision |
| --- | --- | --- |
| `ui-hud` | .99264, 206, 57, 1/1 | .99264, 206, 57, 1/1 |
| `ui-hud-late` | .92679, 60,873, 60,213, .921/.776 (MAD 2.73, ratio 1.189) | .99264, 206, 57, 1/1 |
| `ui-belt` | .99911, 625, 625, .997/.985 | .99979, 0, 0, 1/1 |
| `ui-inv` | .99606, 142, 140, 1/1 | .99615, 57, 55, 1/1 |
| `ui-health` | .99609, 120, 105, 1/1 | .99616, 57, 42, 1/1 |
| `ui-skills` | .99596, 122, 116, 1/1 | .99603, 57, 51, 1/1 |
| `ui-goals` | .99602, 135, 135, 1/1 | .99611, 57, 57, 1/1 |
| `ui-logs` | .99599, 120, 120, 1/1 | .99605, 57, 57, 1/1 |
| `ui-images` | .99601, 135, 135, 1/1 | .99610, 57, 57, 1/1 |
| `ui-conversations` | .99598, 115, 115, 1/1 | .99605, 57, 57, 1/1 |
| `ui-augs` | .99616, 134, 129, 1/1 | .99625, 57, 52, 1/1 |
| `ui-inv2` | .99979, 85, 85, 1/1 | .99988, 0, 0, 1/1 |
| `ui-menu` | .99623, 57, 0, 1/1 | .99623, 57, 0, 1/1 |
| `ui-settings` | .99604, 57, 35, 1/1 | .99604, 57, 35, 1/1 |
| `ui-options` | .99612, 154, 154, 1/1 | .99623, 53, 53, 1/1 |
| `ui-colors` | .99596, 131, 130, 1/1 | .99604, 57, 56, 1/1 |
| `ui-datacube` | .98966, 2,452, 2,365, .965/.938 (MAD 0.34) | .99222, 90, 3, 1/1 |
| `ui-keypad` | .99992, 0, 0, 1/1 | .99992, 0, 0, 1/1 |

Every frame is within 2 of 255 everywhere except the pixels below. The 57 pixels of 13 of the 18 rows (53 in `ui-options`) are one thing, and it is
not the interface: a single scanline of the world (y 436 to 439, x 648 to 704, up to 27 levels), the same in every view, including those whose
screen covers the world with a modulated mask. It is a polygon-edge tie of the world under the interface (the frozen world frames of the gate's 4.1.1 compare
this view), listed here so the numbers are read correctly; `ui-datacube` has 90 pixels at 13 levels or fewer, scattered over its floor. In
`ui-belt`, `ui-inv2` and `ui-keypad` the world is dark or covered and no such pixel shows.

Before the matched Brightness (the first comparison of the main menu), its mean luminance ratio was 1.70 and 6% of the pixels were identical: see cause 3.

## Causes

**1. The underlined accelerator letters (a divergence of Play, fixed).** Every persona screen differed from the original's in 60 to 140 pixels of
the tab row and the item buttons: the original draws an underline under the accelerator letter ("I̲nventory", "H̲ealth", ...) and Play drew none (up to
173 levels in the 7-pixel runs under the letters). GC.DrawText's second emit draws it (`drawGlyph` 0x10029e40: the emit state's `|&` flag, the GC's underline
texture at +0x84 and its height at +0x88; `script-gc-draw-text.mjs`, already compared with the DLL by `gc-draw-text`), and Play's GC never had a
texture there. Evidence for the original: (a) Extension.u's GC class tags exactly one default, `underlineTexture`, reference 20, Texture `Solid` (read
from the package by the new validator); (b) XGC::operator new (Extension.dll 0x10002c40, disassembled) is `UObject::StaticConstructObject` with
GC's class (0x100a28c8), whose InitProperties copies the class's authored defaults into the object before the constructor; (c) XGC::XGC (0x10026ad0) never
writes +0x84 and `CopyGC` (0x10027760) copies it from the template GC to the working GC; (d) the frame: with the default installed the
underline pixels are equal in all 11 views that had them. [Window layout](script-window-layout.md) and [native property offsets](script-native-property-offsets.md)
had named this "the next dependency" ("authentic raw default allocation"). Fixed in the window host's `allocateGc`
(`src/runtime/script-window-host.mjs`): the authored object-reference defaults of the GC class land in their native slots after allocation, the
slot's offset taken from the linked property (`graph.slotOf(field.loadRecord, 0x48)`), anything but an object reference an explicit boundary.
`scripts/validate-gc-underline-default.mjs` checks the package's defaults, that the root's, the HUD's and the belt's template and working GCs hold the
Solid texture, and that the inventory screen paints nine one-pixel underline tiles in its tab row and four under its item buttons.

**2. Window ticks are real time (a divergence of Play, fixed).** With the level held at TimeDilation 0.001 the original's HUD log line vanished
three seconds after it appeared; Play's stayed (`ui-hud-late`, and the stale "You feel ethereal" and "Note Received" lines in `ui-belt` and
`ui-datacube`). `HUDLogDisplay.Tick` counts `lastLogMsg += deltaSeconds` to `logTimeout`, and Play ticked the root with the level's delta
(`game.mjs`: `hud.tick(lastTickDelta)`: the frame's time times TimeDilation, clamped to 0.005 to 0.4). The original's window tick does not use the level's delta:
`UExtensionEngine::Tick` (Extension.dll 0x100266a0) calls `TickWindows` (0x1003a4a0), which overwrites its argument with
`GetWindowsTickOffset(1)` (0x1003a3b0, `f32(appSeconds() - last)`, the wall-clock time since the previous window tick, [script-window-input.md](script-window-input.md)) and calls `RootTick` (0x1003be90)
for every root, and only then runs the level's tick. A held, slowed or paused level (a menu pauses it) therefore does not slow the log's timeout, the
mission start text, a button's activation delay or an InfoLink's typing. Play now ticks the windows with the frame's own time (`game.tick(seconds)`:
the page's frame time, which the worker's clock models as the wall clock), with no dilation and no clamp. The original's own check is the frame:
six seconds on, no log line, and Play's frame equal.

**3. Brightness (the harness, fixed).** The first comparison of the main menu was 1.70 times brighter in Play, in a ramp that the page's slider did not
explain: `ShowMainMenu` runs `FLUSH`, which re-reads Brightness from the client config (D3DDrv `Flush`, modelled in `script-window-host.mjs`), and Play's
config still said 0.6 while the page's slider had been set to 0.4 (the identity ramp). The scenario sets the config's Brightness through the console on both
sides (2/3 in the original: `Shot` is the framebuffer there; 0.4 in Play: its ramp is the identity).

**4. A ghost's hash entry (the harness, fixed).** `viewProbe`'s `location` moved the player through `changeActor`, which registers the actor in the collision hash
even when it is a ghost (PlayerPawn.Ghost removed it with `SetCollision(false, false, false)`); the later `walk`'s `SetCollision(true)` then failed with "Actor is
already registered". A ghost is now written bare, as the original's `set Location` does, and `walk` registers it (`view-probe.mjs`).

**5. A stationary cursor over a screen that replaced another (open, kept out of the frame).** After the click on Settings, the original showed Game
Options focused when the cursor (still at the click, y 304) lay over that button, and Play kept the first button focused; moving the cursor away (4, 4)
left Game Options focused in the original, and hovering other buttons first (`ui-e3`: Keyboard/Mouse, then away; `ui-e4`: Sound) matched in both programs. Only
`XRootWindow::ProcessMouseMove` (0x1003af50) sends the enter and focus, and its two callers are `SetRootCursorPos` and the root's mouse-position entry
(0x1003b670), reached from the engine's mouse events, so the original received a mouse message after the screen changed. Under Wine the engine may re-assert
the cursor position when the menu state changes (a `SetCursorPos` becomes a `WM_MOUSEMOVE`); whether Windows does the same, or Wine's input is the cause, is
not established, and Play was not changed. The scenario clicks Settings at y 297, in the 4-pixel gap between two buttons of the submenu, so neither program has a
button under the cursor (`ui-settings`, `ui-options` and `ui-colors` are equal). The two experiment frames (`ui-e1`, `ui-e2` and the others) are in the stored originals.

## What this covers and does not

Covered, for 00_Training at 1280x720: the HUD (health display, compass, the key ring and a belt slot with its item, a log line and its timeout), eight
persona screens (inventory twice, health, skills, goals and notes, logs, images, conversations, augmentations with one installed), the main menu and
three Settings screens (the Settings menu, Game Options, Adjust Colors), a datacube's information display and the keypad. The interface is equal to the
original's to within 2 of 255 everywhere (cause 1 and 2 were the only differences), and the interface text is the original's own glyph output.

Not covered, by name: a computer's login screen and the screens behind it (they need a live level held by the tracer, as the security cameras do:
[visual acceptance](visual-acceptance.md#security-cameras-2026-10-14)); the DataLink and InfoLink windows and conversation screens in a frame; a held weapon's
ammo display and the first-person weapon (gate row 4.1.10); the Controls, Sound and Display screens (the two programs' ini differ, above); Load and Save Game
(Stage 6); another map's HUD or another resolution (the root's integer multipliers are the same code, but only 1280x720 was compared); the cause of cause
5; a mouse hover's colour change on a button under the pointer (the scenario parks the cursor).
