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

**Frozen levels.** By default both sides freeze the level from its first
tick, so actor positions and animation don't depend on how long each side
took to load:
- The original types `set LevelInfo bPlayersOnly True` before `open`. SET
  also changes the class default, so the new level's LevelInfo starts with it.
- Play loads with `?hold=1`, and its frame loop holds until view-probe.mjs has
  written bPlayersOnly. Level.Tick then runs only the player (tickType 1,
  `level-tick.mjs`) on both sides.

In a frozen level, NPCs never run their StartUp state, so InitializePawn
doesn't run. They keep their map location and mesh, in the reference pose
of frame 0, on both sides. Unfrozen captures (`--live`) differed through
timing alone: in Battery Park, Anna Navarre walks up to the player within
seconds.

**Held level time.** Pulsing lights, panning surfaces, texture animation
and spatial light effects follow Level.TimeSeconds, which the two sides
reach at different moments (load times differ).
- The original types `set LevelInfo TimeDilation 0.001` after ghosting,
  which nearly stops its clock, and the driver reads the held TimeSeconds
  through the live player's Level (`dump-actor-win`, `Level +0xa8`,
  `TimeSeconds +0x478`) into `.work/acceptance/times.json`.
- Play then runs its frozen level to that time (dilation 20, then 1 for
  the last 1.5 s) and holds it at 0.001. Helibase matched to 14 ms
  (46.797 against 46.783).
- Before each `open` the original sets TimeDilation back to 1, because SET
  also changed the class default.
- Flicker draws random numbers and is not matched.

**Fresh maps.** The original loads a map visited before in the same mission
from its travel state (`LoadMap: ..\Save\Current\<map>.dxs`), not from the
map file. A second Battery Park capture showed the first visit's crates and
Anna's walk. Before opening a map again, the driver opens another map and
moves that `.dxs` aside to `.work/acceptance/save-current/`, so each capture
starts from the map file, as Play does.

**The original's own state.** `tools/dump-actor-win.c` reads named objects'
fields from the running DeusEx.exe, at the linked property offsets
(UProperty `+0x48`, bool masks `+0x5c`). It is how the travel-state load
showed up: in that run Anna had bInitialized=1 and stood at (1079, 1807,
367). Build it with
`i686-w64-mingw32-gcc -O2 -o dump-actor-win.exe tools/dump-actor-win.c -lpsapi`.

**Views.** From the player's start Location, rounded to integers so both
consoles get the same floats: the four axis yaws (from the start yaw rounded
to a quarter turn) level, and one 3,000 units (16.5°) below the start yaw.

**Frames.** Both are raw framebuffers at 1280×720.

- The original's are its own `Shot` bitmaps (numpad `*`), the framebuffer
  before the gamma ramp. Under Hyprland, which tiles the window again on
  every map load, `DX_HYPRLAND=1` checks before each shot that the window is
  floating, 1280×720 and inside the screen. Shot locks the primary surface
  for the window rectangle, and a rectangle past the screen edge fails
  (`DDERR_INVALIDPARAMS`) with a black frame. After it places the window, it
  takes one throwaway shot, because the first frame after a resize is
  stale.
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

Then take the original's frames (`DX_HYPRLAND=1` keeps the window placed
under Hyprland) and compare:

```bash
WINEPREFIX=$HOME/.wine-deusex DX_WINE=/usr/bin/wine DX_GAME="$HOME/.wine-deusex/drive_c/Deus Ex GOTY Edition" DX_HYPRLAND=1 node scripts/visual-acceptance.mjs original --maps 00_Training --load-wait 40000
```

```bash
node scripts/visual-acceptance.mjs compare
```

`--views y3 --reuse` retakes one view on the map already loaded, and
`--current <map>` names the map the running game has loaded, so it is
left first. The `play` step writes `.work/acceptance/plan.json`; `original` reads it.

## Results

### Twenty-six maps, frozen at held level time (2026-10-07)

Each map has five views. All 130 frames are 1280×720, taken on the Linux
host under Wine 11.17 (D3D). Play's frames include the pixel-centre fix
below. Both sides' level clocks were held at the same TimeSeconds, matched
to within 16 ms (46.77–46.82 s). The columns are ranges or minima over each
map's five views. The sub-pixel offset is listed for views with enough
strong gradients (—: none); over those 36 views the median is (0, 0).

| Map | Play / original | Mean abs. diff. | Edge recall (min) | Edge precision (min) | Outlier blocks | Sub-pixel offset |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 00_Training | 1.27–1.40 | 1.21–4.23 | 0.92 | 0.94 | 0 | (0, 0), (0.125, 0) |
| 01_NYC_UNATCOHQ | 1.22–1.32 | 3.26–4.58 | 0.94 | 0.95 | 0 | (0, 0), (0.125, 0) |
| 01_NYC_UNATCOIsland | 1.29–1.33 | 1.43–3.27 | 0.94 | 0.95 | 0 | (0, 0) |
| 02_NYC_BatteryPark | 1.13–1.35 | 0.35–3.80 | 0.96 | 0.96 | 0 | (0, 0) |
| 02_NYC_Smug | 1.30–1.37 | 0.81–1.31 | 0.97 | 0.58 | 0 | — |
| 03_NYC_747 | 1.34–1.45 | 1.89–2.84 | 0.93 | 0.89 | 11 | (0, 0), (0, 0.25) |
| 03_NYC_AirfieldHeliBase | 1.34–1.38 | 2.22–3.66 | 0.92 | 0.66 | 0 | — |
| 03_NYC_BrooklynBridgeStation | 1.28–1.40 | 0.80–2.25 | 0.96 | 0.67 | 0 | — |
| 04_NYC_Street | 1.36–1.39 | 1.47–2.27 | 0.91 | 0.93 | 7 | — |
| 05_NYC_UNATCOMJ12lab | 1.33–1.41 | 1.46–4.12 | 0.94 | 0.74 | 0 | — |
| 06_HongKong_Helibase | 1.21–1.35 | 2.90–5.87 | 0.96 | 0.93 | 25 | (0, 0) |
| 06_HongKong_VersaLife | 1.24–1.34 | 3.31–5.52 | 0.96 | 0.97 | 0 | (0, -0.25) |
| 06_HongKong_WanChai_Market | 1.27–1.35 | 1.35–2.30 | 0.94 | 0.97 | 0 | (0, -0.375), (0, 0), (0.125, 0) |
| 08_NYC_Bar | 1.34–1.40 | 1.64–3.18 | 0.92 | 0.96 | 0 | (0, 0) |
| 09_NYC_Dockyard | 1.30–1.40 | 1.46–3.96 | 0.90 | 0.90 | 0 | (0, 0) |
| 09_NYC_Ship | 1.26–1.39 | 1.58–3.46 | 0.86 | 0.30 | 0 | (0, -0.25) |
| 10_Paris_Chateau | 1.32–1.37 | 1.51–2.41 | 0.89 | 0.88 | 13 | (0, 0) |
| 10_Paris_Club | 1.33–1.37 | 1.00–1.83 | 0.95 | 0.57 | 0 | — |
| 11_Paris_Cathedral | 1.15–1.29 | 0.26–1.04 | 0.65 | 0.21 | 0 | — |
| 11_Paris_Everett | 1.33–1.37 | 1.29–2.57 | 0.91 | 0.90 | 0 | (0, 0) |
| 12_Vandenberg_Cmd | 1.22–1.37 | 0.49–1.71 | 0.83 | 0.79 | 1 | — |
| 12_Vandenberg_Gas | 1.30–1.36 | 0.93–1.31 | 0.89 | 0.94 | 0 | — |
| 14_OceanLab_Lab | 1.16–1.42 | 1.41–3.82 | 0.94 | 0.95 | 0 | (0, 0) |
| 14_Oceanlab_Silo | 1.25–1.40 | 0.86–2.42 | 0.91 | 0.97 | 0 | (0, -0.125), (0, 0) |
| 15_Area51_Bunker | 1.29–1.37 | 0.85–1.45 | 0.82 | 0.71 | 8 | — |
| 15_Area51_Entrance | 1.29–1.30 | 0.86–2.52 | 0.91 | 0.89 | 0 | (0, 0) |

Every view was also inspected side by side.

**Matching.** Geometry, BSP lighting (pulsing lights included, now that
time is held), coronas, mirrors, fog, the skies and decorations line up in
122 of 130 views. Play's raw frame is uniformly 1.13–1.45× brighter; see
Open. Before time was held, Helibase y1 and Dockyard y1/y2 differed through
LT_Pulse phase alone.

**Flags explained by the metric or by timing.**

- *Low edge scores, no visible difference.* The low precision minima (Ship
  y2, Paris Club y1/y3, MJ12 lab y1, Airfield y1) and the Cathedral's low
  recall and precision (y1/y3) are flat, nearly black walls. There the
  strongest 5% of gradients are texture noise.
- *Outlier blocks from time-dependent content.*
  - Island y2, Street y3 and Area 51 y1: the skies' panning clouds, which
    follow Level.TimeSeconds.
  - Area 51 y0: the helicopter's rotor blur. Rendered actors still animate
    in a frozen level: AActor::Tick advances animation before its
    players-only return, in the original (live read: BlackHelicopter0 at
    AnimFrame 0.686 in a level frozen from load) as in Play
    (`actor-tick.mjs`). The rotor's phase therefore depends on elapsed time.

**Differences.**

0. *Mesh lighting of single actors (open, with the lighting work).* With
   time held, Helibase's BlackHelicopter0 is deep red in the original (lit
   by TriggerLight4, a static Searchlight, hue 0, saturation 0, brightness
   200, 370 units away) and gold in Play. 747 y2's yellow robotic arm is 2–3×
   brighter in Play than the frame's ratio. The BSP around both matches, so
   the suspects are the inputs of the per-actor light gather
   ([mesh lighting](mesh-lighting.md) "Candidates"): the leaf's permeating
   list, the line checks, the fade schedule, or a light's initial state.

1. *Pixel centres (fixed).* In the 19 views with at least 1,500
   strong-gradient pixels, the original's image sat a median (−0.5, −0.5)
   pixel from Play's: best fit by bilinear resampling, in 1/8-pixel steps.
   The original's projection explains it:
   - Render.dll projects to `ScreenX = X·RZ + FX15`, with
     `FX15 = (SizeX + 1.0001)·0.5` (ComputeRenderSize, bit-exact in
     `occlude.rs`), and FY15 likewise;
   - D3DDrv submits screen-space vertices at `ScreenX − 0.5` and
     `ScreenY − 0.5` (DrawGouraudPolygon `0x1000583c`/`0x1000584f`,
     DrawComplexSurface `0x10003c0e`/`0x10003c1d`; the 0.5 at `0x1001864c`);
   - D3D rasterizes such vertices with pixel centres on integer
     coordinates, half a pixel from WebGL's.

   The original's 3D image therefore sits 0.50005 px right of and below a
   symmetric projection. Play's camera now carries that view offset
   (`play-camera.mjs` `setPixelCentre`), and so does the simulation side's
   copy, so both plan the same mirror passes. Sky passes copy it. Odd-depth
   mirror children reverse its horizontal part, because their target is
   sampled right to left. Before that, Training's floor reflection measured
   (−1, 0); after it, (0, 0).
   DrawTile subtracts the same 0.5 (`0x10005c7a`/`0x10005c8c`), so 2D tiles
   at integer coordinates land on whole pixels, as Play's HUD draws them.
   After the change, the measured offset is (0, 0) in all those views
   (once 0.125), mean differences fall in 18 of 20 recaptured views, and:
   - *Island y0's skyline line is gone.* It sat on the wrap-seam edges of
     skyline polygon 2244 (Model189, `BatteryPark.Sky.NYskybox2Mbs`, masked,
     unlit, two-sided, in the sky zone): a vertical edge at U ≈ −255 texels,
     a horizontal one at V = −2944 = −23×128. Half a pixel decided whether an
     edge pixel sampled the texture's first columns (opaque from row 8) or its
     last (from row 24): a tall or a short "antenna".
   - *Ocean Lab y2's 36 outlier blocks drop to 2.*

   `compare` reports this offset per view (`subpixel`).
2. *The darkest pixels.* A shadowed pipe in Ocean Lab y2
   (`SubBase.Metal.SB_PipeSec_B`) is raw (1,1,1) over a 200×200 patch in
   the original.
   - Before the pixel-centre fix, Play's capture was (0,0,0) there. After
     it, Play gives 1 over most of the patch, and 0 only on the texture's
     darkest texels, a few hundred pixels.
   - Over five views, original raw 1 maps to Play 0 for 6,939 pixels and
     to 1 or more for 733,665. Original 0 maps to Play 1 or more for
     18,738 pixels and to 0 for 334,999.
   - Rounding at the bottom of the range, in both directions; not traced.

## Open

- The uniform 1.13–1.41× raw brightness gap under Wine; a CrossOver
  capture on the Mac matched more closely. The user does not want it
  chased: it is a known gamma issue of the game on Windows.
- Rounding of the darkest values, at the level of single raw steps
  (item 2 above).
- Captures are frozen. NPCs stand at their map locations in the frame-0
  reference pose, and their startup (InitializePawn) and patrols are not
  compared. A live comparison needs matched level time (`--live` alone
  differs through timing).
- Captures come from one Wine/D3D host. D3D behaviour that depends on the
  driver is not separated from the original's own.
