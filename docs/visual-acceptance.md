# Visual acceptance against the original

Stage 4 is accepted against the original game's own frames, not against our
expectations. `scripts/visual-acceptance.mjs` takes matched-camera frames of
the original DeusEx.exe and of Play and compares them.

## Method

**Same inputs on both sides.** Each map is loaded normally, then both sides
take the same console inputs:

- `set DeusEx.JCDentonMale bCheatsEnabled True`, `ghost` and `ShowHud False`;
- then, for each view, Location, a zero Velocity and ViewRotation.

The original types these into its console (`ad/tools/dxinput.exe`'s `cmd`
lines through Talk). Play runs them on the simulation side, in the default
worker mode, with `src/viewer/view-probe.mjs`:

- `ghost` and `ShowHud False` go through the original console command chain
  (APlayerPawn::execConsoleCommand, so PlayerPawn.Ghost and
  DeusExPlayer.ShowHud run);
- bCheatsEnabled, Location, Velocity and ViewRotation are written directly,
  as the console's SET does (UObject::GlobalSetProperty imports the text into
  the field; a non-brush actor gets nothing more).

Two original paths were missing in Play and are now translated: the bool
parameter import of ScriptConsoleExec ([console exec](script-console-exec.md))
and CheatFlying's AutonomousPhysics ([ladders and flying](ladder-flying.md#autonomousphysics-native-3971-0x103c8f30)).
In both, the camera eye is Location + 40 (EyeHeight), the player is in
state CheatFlying with Physics PHYS_Flying, and the HUD is hidden.

**Views.** From the player's start Location, rounded to integers so both
consoles get the same floats: the four axis yaws (from the start yaw rounded
to a quarter turn) level, and one 3,000 units (16.5°) below the start yaw.

**Frames.** Both are raw framebuffers at 1280×720.

- The original's are its own `Shot` bitmaps (numpad `*`), the framebuffer
  before the gamma ramp. Under Hyprland the game window is tiled, so it is
  floated and sized to a 1280×720 client area first.
- Play's are captured at Brightness 0.4, whose display ramp
  (`pow(x, 1/(2.5·0.4))`) is the identity. The scene canvas is pinned to
  1280×720 at the page origin, and the page UI is hidden.

**Metrics** (`compare`, per view):

- mean channel values and their ratio, Play over original;
- mean absolute difference;
- edge agreement: the share of the original's Sobel edges with a Play edge
  within 2 pixels (recall), and the converse (precision). This checks that
  geometry lines up;
- a 16×9 grid of mean-luminance ratios, flagging blocks more than 1.6×
  away from the median: missing or extra content;
- side-by-side and difference images per view.

Captures and reports stay in `.work/acceptance/` (outside Git).

## Running it

```bash
node scripts/visual-acceptance.mjs play --maps 00_Training
```

```bash
WINEPREFIX=$HOME/.wine-deusex DX_WINE=/usr/bin/wine DX_GAME="$HOME/.wine-deusex/drive_c/Deus Ex GOTY Edition" node ad/scripts/original-game.mjs launch 00_Training.dx
```

On Hyprland, float and size the window, then take the original's frames
and compare:

```bash
hyprctl dispatch 'hl.dsp.window.float({ action = "set", window = "class:deusex.exe" })'
```

```bash
hyprctl dispatch 'hl.dsp.window.resize({ x = 1280, y = 720, relative = false, window = "class:deusex.exe" })'
```

```bash
WINEPREFIX=$HOME/.wine-deusex DX_WINE=/usr/bin/wine DX_GAME="$HOME/.wine-deusex/drive_c/Deus Ex GOTY Edition" node scripts/visual-acceptance.mjs original --maps 00_Training
```

```bash
node scripts/visual-acceptance.mjs compare --maps 00_Training
```

The `play` step writes `.work/acceptance/plan.json`; `original` reads it.

## Results

### 00_Training (2026-10-06)

Five views from the start (-1149, 826, -80):

| View | Play / original | Mean abs. diff. | Edge recall | Edge precision | Outlier blocks |
| --- | ---: | ---: | ---: | ---: | ---: |
| y0 | 1.28 | 2.99 | 0.882 | 0.901 | 0 |
| y1 | 1.32 | 1.41 | 0.927 | 0.900 | 0 |
| y2 | 1.40 | 1.97 | 1.000 | 1.000 | 0 |
| y3 | 1.31 | 1.28 | 0.979 | 0.981 | 0 |
| down | 1.26 | 4.33 | 0.881 | 0.904 | 0 |

Geometry, the mirror floor's reflections, the plants, lights and the
emblem line up; no block is missing or extra. Play's raw frame is 1.26–1.40×
brighter, uniformly (block ratios 0.89–1.49). This is the gap already
recorded under Wine ([lighting](lighting.md), "Display ramp"); it is not
chased here.

## Open

- The uniform 1.25–1.4× raw brightness gap under Wine (a CrossOver capture
  on the Mac matched more closely).
- NPC poses and animation time differ between the two runs; actor regions
  are compared loosely.
