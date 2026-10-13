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

**One subject.** `--view name:x,y,z:pitch,yaw,roll` (repeatable, integers in
raw rotator units, taken by all three verbs) uses explicit cameras in place
of the planned views, for a mirror or a face at a known spot; the plan keeps
its own views. Frames are `<map>/<name>-original.png` and `-play.png`.
`compare --crop WxH+X+Y` measures one region (the crops are kept as
`<name>-crop-*.png`), and `--play-name <suffix>` compares
`<name>-<suffix>.png` of Play, for an experiment's frame.

**Placing the player's Region.** `set Location` moves the player without
SetActorZone, so its Region (zone, leaf) stays the start's under `ghost`
(measured on both sides: the original's JC read leaf 111, zone 3 after the
teleport), and Region.iLeaf picks the static lights the player's own
mesh gets (SetupForActor, [mesh lighting](mesh-lighting.md)). A reflection of
the player captured after only `set Location` is therefore lit from the
start's leaf (10_Paris_Club: leaf 111, zone 3; the mesh gets no light and is
black in the original). `--region ZoneInfo4:380:7` sets the Region at each
view on both sides (`set DeusEx.JCDentonMale Region (Zone=ZoneInfo'<map>.ZoneInfo4',
iLeaf=380,ZoneNumber=7)` in the original; `viewProbe({region})` in Play), the
leaf and zone `PointRegion` gives at the camera. Walking instead of `ghost`
does not work in the original: a collision-enabled player placed with
`set Location` asserts in the next MoveActor ("moved without proper hashing")
and the game exits.

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
| 03_NYC_747 | 1.33–1.35 | 1.59–2.59 | 0.95 | 0.94 | 0 | (0, 0), (0, 0.125) |
| 03_NYC_AirfieldHeliBase | 1.34–1.38 | 2.22–3.66 | 0.92 | 0.66 | 0 | — |
| 03_NYC_BrooklynBridgeStation | 1.28–1.40 | 0.80–2.25 | 0.96 | 0.67 | 0 | — |
| 04_NYC_Street | 1.36–1.39 | 1.47–2.27 | 0.91 | 0.93 | 7 | — |
| 05_NYC_UNATCOMJ12lab | 1.33–1.41 | 1.46–4.12 | 0.94 | 0.74 | 0 | — |
| 06_HongKong_Helibase | 1.21–1.33 | 2.90–5.87 | 0.95 | 0.94 | 14 | (0, 0) |
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
122 of 130 views before the line-check fix below, and in 124 after it. Play's raw frame is uniformly 1.13–1.45× brighter; see
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

0. *Mesh lighting of single actors (fixed).* With time held, Helibase's
   BlackHelicopter0 was deep red in the original and gold in Play, and 747
   y2's yellow robotic arm was 2–3× too bright. Both came from the light line
   check:
   - The original's `UModel::LineCheck` traces the level BSP that the moving
     brush tracker has filled with mover polygons. Closed hangar doors hide
     three gold ceiling lights from the helicopter, leaving the red
     TriggerLight4 (a static Searchlight). A force field hides the arm's
     brightest light.
   - Play's mesh lighting now traces the tracker's model
     (`validate-tracked-linecheck`, 366 checks against Engine's line check
     under Unicorn). Both views match: 747 y2 has no outlier block left, and
     Helibase's are around the rotor (animation phase).

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
   (`play-camera.mjs` `setPixelCentre`; since 2026-10-08 the offset is the
   pass frame's own, `FX15 - X/2` and `FY15 - Y/2`, with Proj.Z for the focal
   length: [the scene's projection](render-pass-precision.md#the-scenes-projection-2026-10-08)),
   and so does the simulation side's
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

### The player's reflection in a mirror (2026-10-08, fixed: per-frame lighting)

10_Paris_Club's bar mirror (surface 232, the plane x = 128, y from −736 to
−1600, z from −16 to 240), JC at (58, −1008, 27) with Region zone 7, leaf 380
(`--region ZoneInfo4:380:7`), pitch 61736, yaw 0: his reflected face is 140
units from the camera. The report was dark marks around JC's mouth in Play,
gone with the AugLight on. The original (Wine, D3D, frozen level, held clock,
Brightness 0.4 for Play) shows his face evenly lit by the club's two lights;
Play showed the skin at the texture's full brightness over most of the face
and the real, dim light only on patches around the eyes, nose and mouth.

Over the face (110×110 px at 585,350, view f70; the whole frame has a 1.33×
raw ratio, see Open):

| Play | Play / original | Mean abs. diff. | Edge recall / precision | Outlier blocks |
| --- | ---: | ---: | --- | ---: |
| before (master b0d79d5; mean 17.5, 22.4, 13.0 against the original's 4.4, 16.3, 6.4) | 1.86 | 11.73 | 0.64 / 0.91 | 65 |
| after (this change) | 1.34 | 3.38 | 0.99 / 0.99 | 0 |

The whole 1280×720 frame: ratio 1.326 → 1.329, mean abs. diff. 3.83 → 3.68,
edge recall 0.88 → 0.93, outlier blocks 1 → 0. The closer view (f40,
reflected face 100 units away) measures the face at 2.59 → 1.32 over 120×100
px, but there JC's animation frame differs between the two captures (the
original's head sits lower: the player's mesh animates in a frozen level, and
its phase follows elapsed real time), which the edge scores show (0.32 →
0.41); f70 is aligned. The NPC and the chairs seen in the same mirror
(view `far`, 500 units) were at 1.19/1.03/0.69 (NPC) and 1.0/1.05/0.67 (chairs)
of the original's R/G/B when lit from the main frame; they now sit at
1.39/1.34/1.55 and 1.39/1.36/1.53, the frame's own 1.40/1.34/1.57)..

**Cause.** The original lights an actor in every frame that draws it:
DrawLodMesh runs SetupForActor and Light with that frame's Coords and its
back-face test is `dot·Frame.Mirror < 0` ([mesh lighting](mesh-lighting.md#one-call-per-frame-child-frames-lighting-2026-10-08)
has the addresses). JC is not drawn in the main frame (the camera sits in his
head), so in the original only the mirror's child frame lights him. Play lit
each actor once per main frame and the mirror passes reused the colours, with
no Frame.Mirror. For JC that pass ran with the camera inside his head. Of the
339 vertices of his mesh (T-pose, view f40), the main camera's back-face
test marked 233 (255 faces kept); the mirror's child camera marks 295 (378
faces), and 90 of those were not marked by the main pass. A vertex not marked
keeps diffuse 1.0 (`lightMesh`: `!light[v]`), a marked one gets the
computed Light: neighbouring vertices at full texture brightness and at 0.05 to
0.2. The lit patches were the dark marks; with the AugLight the light
saturates and they vanish. Light selection (the club's Light91 and Light77,
steady, brightness 44, radius 34; ambient 0, ScaleGlow 1), vertex normals,
Light's specular term and the material path were not the cause (a one-actor
experiment that only re-ran them in the reflected frame gave this face).

**Fix.** Each child frame lights the actors in its Frame->Sprite with its own
Coords, Mirror and LeafLights; an actor in several frames is lit in each, in
DrawFrame's order. See [mesh lighting](mesh-lighting.md#one-call-per-frame-child-frames-lighting-2026-10-08).
Cost in this view (Paris Club, worker mode, 1440×960, 5 interleaved rounds of
400 frames, medians): mirror phase 2.14 → 2.32 ms (the page's lighting run
before the pass and the main frame's after it), simulation-side actors
1.38 → 1.46 ms, the frame 5.34 → 5.50 ms of page work, 16.63 ms vsync
interval unchanged, draw calls 111 both.

**Placing the player.** The capture hazard that hid this: `set Location`
leaves the player's Region at the last move's leaf, so a reflection captured
that way is lit from the start's leaf (the original's mesh was black). Use
`--region` (above).

### CPU and GPU mesh paths: JC's reflection (2026-10-08, a capture artifact, fixed in the tool)

The matched captures of the bar mirror showed JC's reflected face higher (and
larger in a 440×440 crop) with `?gpuMesh=0` than on the default GPU path. The
two paths do not differ: the player's animation stood at another phase in
each capture.

- **The poses are bit-equal.** `validate-gpu-mesh` compares the GPU pose and
  final pose with the CPU shadow's exact output (the CPU path's positions) to
  0 ulp (Island: 298,758 components of 908 actor captures; Training too). At the
  captured state in the Club (`viewProbe` placement at (78, −1008, 27), 45
  frames, `?sim=inline`) JC's 339 vertices on the GPU equal the CPU shadow's:
  0 mismatches.
- **One simulation state gives one frame.** Without the level-time hold, the
  views f40 (88, −1008, 27), f70 and far (500 units) taken on master 0df0107
  and on this branch, GPU against CPU: mean abs. diff. 0.00–0.02, edge recall
  and precision 1.0.
- **Held captures differ run to run, on each path.** The ghost loops `Tread`
  (AnimRate 1.25). Three runs per path at the same view (g40, (78, −1008, 27),
  pitch 61736) read AnimFrame 0.8004, 0.8358, 0.8212 (GPU) and 0.8149,
  0.8250, 0.8003 (CPU) at the screenshot; the frames differ by that phase:
  mean abs. error (ImageMagick, 16-bit) 34–52 between the three GPU runs,
  28–47 between the three CPU runs and 14–58 between the paths. The hold
  itself overshot the original's TimeSeconds (46.8165) by 0 to 17 ms, a
  frame, in each of them.
- **Cause: a held level still ticks animations once per frame.** The actor
  delta of `ULevel::Tick` is TimeDilation x frame time clamped to at least
  0.005 s, so at the hold's TimeDilation 0.001 every tick advances the ghost's
  loop by 0.005 s x AnimRate (1.25) = 0.00625 of the loop, in the original and
  in Play alike (`validate-anim-dilation-play`, [level
  tick](script-level-tick.md#animation-under-timedilation-in-play-2026-10-08)).
  The phase at a screenshot therefore counts the ticks since the hold (a fixed
  1/60 s step gave 0.3375 = 54 ticks between two views 45 frames apart, the
  rest being frames during the probe and the screenshot; a worker-mode run
  also lags the page by a variable number of frames). Runs of one path under
  another load read 0.3129, 0.3563 and 0.3375 for the same first view. No code
  of either mesh path is involved, and none of the animation's.
- **Fixes (the tool).** The last 0.1 s of the hold steps at TimeDilation 0.05
  (under a millisecond of overshoot), frozen captures step at a fixed 1/60 s
  (`--real-time` keeps the page's clock; the hold is then 46.81667 s in every
  run), and `play.json` records the player's animation (`anim`). A
  worker-mode capture still shows the animation of the frames that happened
  to pass: it is no pixel comparison between paths.
- **A pixel comparison between the paths: `validate-mesh-path-frames.mjs`.**
  The inline simulation under a paused Playwright clock, 90 frames of 16 ms,
  the capture's ghost, Location, ViewRotation and Region: the default GPU
  path twice (the scenario reproduces its own pixels) and `?gpuMesh=0`, the
  drawing buffers compared byte for byte. In 10_Paris_Club the bar mirror
  with the player's reflection (the view of this section), and the restroom
  mirror at URender's MLOD 3 and 10, where a child frame draws another LOD
  state than the main frame's (`lodProbe` counts it, 1 draw each): the
  1280x720 frames are identical on the two paths (0 of 3,686,400 bytes
  differ), the player's animation at the same frame (0.7078). Making the CPU
  path ignore a child frame's own LOD state (a mutation of `applyPass`)
  differs in 1,359 bytes, up to 80, and fails it.

## Live scenes (2026-10-13)

The sections above compare frozen levels. A live level (NPCs walking, animation, particles, generators) cannot be pixel-aligned
run to run, and the two programs do not share a random stream, so this method compares **state per tick** against the original's
own process, with every input that is not the game's logic measured from the original and given to Play. Pilots: 01_NYC_UNATCOIsland
(patrolling troops, terrorists, bots), 10_Paris_Club (dancers, wanderers, seated guests) and 06_HongKong_WanChai_Underworld (six dancers
and eleven more NPCs rendered from the start pose). Frames are a second stage, at a held tick.

### Method

1. **The original is observed as a debugger** (`tools/dx-live-win.c`, build with
   `i686-w64-mingw32-gcc -O2 -o ad/build/dx-live-win.exe tools/dx-live-win.c -lpsapi`). `trace` attaches to the running DeusEx.exe under
   Wine and breaks at `ULevel::Tick`'s entry (Engine.dll `0x103a51a0`, ECX = the player's level) and its `ret 8` (`0x103a5baf`), optionally
   also at `AActor::Tick` (`0x103a1aa0`). With the game thread stopped there, each observation is consistent (a read from outside the process can straddle a Tick; not measured, avoided), and the original's input delta (the stack argument), the double level clock (`ULevel +0xdc`),
   `LevelInfo.TimeSeconds` and the CRT `rand` state are read exactly. Per tick it writes one JSON line with those and the watched actors'
   fields (Location, Rotation, Velocity, Acceleration, Physics, AnimSequence/Frame/Rate, TweenRate, state, Destination, MoveTarget,
   MoveTimer, Orders, speeds, bIsWalking and the sitting/pausing flags, LastRenderTime, DistanceFromPlayer, bStasis, bForceStasis). The
   tracer also does the **release** (clears `LevelInfo.bPlayersOnly` at the third tick entry, the frozen start of the sections above),
   can force the input delta (`delta 0.0166666675`; the original's own free-running delta on this host is mostly 4.8 to 6.6 ms, near the actor-delta
   floor of 0.005 s, with an occasional 25 ms, against Play's 1/60 s frame), **holds** the level after N unfrozen ticks (it returns from `ULevel::Tick` without running it, the game keeps
   drawing), reports a fatal first-chance exception (address, module+RVA, registers, stack; `kill-on-crash`) and detaches with the
   breakpoints removed and the queue drained. `list <Class>` lists a level's actors with `OddsOfAppearing`, `rng` samples the CRT state.
2. **Same start.** `scripts/live-original.sh <map> ...` (under the Wine lock, quitting the game by its PID) opens the map frozen
   (`set LevelInfo bPlayersOnly True` before `open`, as the frozen captures), types `bCheatsEnabled`, `ghost`, `ShowHud False`, then
   `scripts/live-acceptance.mjs original` attaches the tracer, which releases at tick 3 and records 600 ticks (10 s). NPCs that never ran
   StartUp while frozen run it after the release on both sides.
3. **Measured host inputs for Play** (`src/viewer/live-probe.mjs`, `window.deusExViewer.liveProbe`, simulation side in worker mode;
   `scripts/live-acceptance.mjs play`): per replayed tick Play ticks with the original's delta and its stream set to the original's
   `rand` state at that tick's entry (`srand` semantics, `rng.seed`), the clock starts at the trace's, the player stands where and as the
   original's did at the release (pose, Region, animation), and the actors the original's load kept are the ones Play keeps (below). The
   replay is not a free-running comparison: it removes what the two programs cannot share, and each input is measured, not guessed.
4. **Compare** (`scripts/live-acceptance.mjs compare`): for every watched actor and field the first tick where Play's float32 value
   differs, per-tick stream draw counts (original: state before and after each Tick; Play: its draws), and with `--actor-trace a:b` on the
   original and `--draw-trace` on Play the draws of each actor (the stream state at each `AActor::Tick` entry). `.work/live-acceptance/<map>/`
   keeps traces and reports (outside Git).
5. **Frames at a held tick** (`--shot name` on both `original` and `play`): the original's level is held at the last replayed tick, Play's
   replay holds the same way, both draw on; the frames go to `.work/acceptance/<map>/<name>-original.png` / `-play.png` and
   `node scripts/visual-acceptance.mjs compare --maps <map> --view <name>:0,0,0:0,0,0` gives the usual metrics. The window is placed
   (`DX_HYPRLAND=1`) before the tracer attaches.

### What the original does with the random stream

Measured from the CRT state (the `rand` word of the msvcrt thread data, `+0x14`), Island and Club, on this host:

- It is seeded from `time(NULL)` at startup ([RNG](rng.md)), so a load's random decisions differ between runs and between the two programs.
  Of Island's 2,427 actors, `FlyGenerator1` existed in some loads and not in others; the driver reloads the original until it holds no
  actor Play's seeded load lacks (`play-population.json`; exit code 3 asks `live-original.sh` to retry) and Play destroys the ones only it
  holds.
- The stream advances while the level is frozen and between ticks: exactly 256 draws between two consecutive Ticks in 600 of 600 inter-tick
  gaps of a Club trace and 23 of 23 of an Island one (URender::PreRender's light noise, [dynamic lighting](dynamic-lighting.md)), about
  100,000 to 200,000 draws per second for Island and Club frozen or live. A tick's own draws are the scripts' and natives': 317 in Island's
  first unfrozen tick (the 59 pawns' and the generators' startup), 54 in the Club's, then mostly under 25. Setting Play's state from the original's at each tick's entry therefore keeps a difference in
  how many draws one actor makes from spreading, and the counts are compared as a result of their own.
- With the population matched the first unfrozen tick's totals are equal (317 and 317 on Island, 54 and 54 on the Club) and so are the
  per-actor counts (`AActor::Tick` attribution) for every NPC and generator; before the match the only difference was one generator
  (`FlyGenerator1`) that the original's load had kept and Play's had not.

### Placement constraint

The original is never moved with `set Location` or `set Region` in a level that then ticks. The known hash corruption ("moved without
proper hashing", [placement](#placing-the-players-region)) is the reason, and one run crashed that way: `set Location` and `Region` on the
ghost at (-250, -320, -70) in 10_Paris_Club, the tracer released and detached, and the game ended with a General protection fault in
`TickLevel` (`DeusEx.log`: TickLevel, UGameEngine::Tick, XGameEngineExt::Tick, UpdateWorld, MainLoop; address not captured: the capture
was built afterwards). It was not deliberately reproduced; every later run (more than ten), without the placement and with the crash capture armed, did not crash.
Live runs start from the map's own start pose (only `ViewRotation` may be set). Reaching other places by the original's own movement did not
work here: posted `W` and `Up` key events (`down`/`up`, held 2.5 s) did not move a ghost (Location unchanged, Physics 4; unexplained, a
guess is that the game drops held keys while its window is unfocused), and after `set DeusEx.JCDentonMale Velocity (X=-300,Y=-135,Z=0)` the
first read, seconds later, showed Velocity 0 and Location unchanged. So the
Club's dancers, 2,300 units away behind walls, are not in view in any live run yet.

### Pilot 1: 01_NYC_UNATCOIsland (2026-10-11 to 13)

59 actors watched (58 pawns and the player), 600 ticks at 1/60 s, population matched, seed 1 for Play, the player at the map start
(x -4760.6, y 10430.8, yaw -7040). Of the 58 NPCs, 22 do not move (they stand or sit; 45 have `bStasis` set by tick 600, 13 never) and 36 move
more than 20 units in the ten seconds. With Play at master e70fd64 **25 of the 59 actors matched the original for all 600 ticks**: the player,
the 22 that stay put and 2 of the 36 that walk. Every other walking NPC diverged at its first walking tick.

| Play | actors equal for 600 ticks | of the 36 that walk | what changed |
| --- | ---: | ---: | --- |
| e70fd64 (baseline) | 25 / 59 | 2 | |
| + calcVelocity's class tests (ee041b8) | 41 / 59 | 18 | walking script pawns |
| + physWalking's two class reads (586aa15) | 41 / 59 | 18 | long frames and zone currents only (not reached at 1/60) |
| master 507daec (d104c8e first MoveTarget, 0e84704 AlterDestination, the others above) | 57 / 59 | 34 | Divergence 3 |
| + physicsRotation (ca0686d) | 58 / 59 | 35 | Divergence 10; Terrorist18 (tick 235) is the one left |

The 18 walkers that match walk up to 544 units (UNATCOTroop1), 528 (SecurityBot1), 313 (Terrorist36) identically, with equal destinations,
timers, rotations and animation, in ten seconds.

The list below is the state at ee041b8 and 586aa15; the table's last row is the later state.

The 18 walkers that still differed then, by first differing tick: SecurityBot0 6, Terrorist34 14, Terrorist15 20, Terrorist21 20, Terrorist31 20,
Terrorist1 20, Terrorist24 21, SecurityBot3 24, Terrorist14 25, Terrorist7 28, Terrorist10 53, UNATCOTroop0 61, Terrorist13 64,
Terrorist20 67, Terrorist35 69, Terrorist29 70, Terrorist18 164, UNATCOTroop6 244. At the first tick the field is Location,
Velocity, Acceleration, Destination, MoveTarget, Focus, DesiredRotation, MoveTimer for 16 to 18 of them: the pawn walks toward another
destination. The later fields (Frame, Rate, Phys, Sitting from tick 159 and 227) belong to the two or seven that go on to sit or turn.

Frame at tick 600 (`live600`, the level held, view from the start pose; no pawn is large in it: UNATCOTroop1, PaulDenton0 and SecurityBot0 are
rendered at 2,300 to 3,200 units): ratio 1.287 (the known uniform gap, Open below), mean abs. diff. 2.2, edge recall 0.975, precision 0.987,
sub-pixel offset (0, 0), 0 outlier blocks. That the SecurityBot0 of this frame walked another path (below) is not visible in it.

### Pilot 2: 10_Paris_Club (2026-10-13)

20 actors (19 NPCs and the player), 600 ticks, map start pose (2062.9, 273.2, -48.3), yaw 35411 (set through `ViewRotation`), population matched.
**17 of 20 equal for 600 ticks** at ee041b8 (19 of 20 after the later fixes: only MichaelHamner0, a Sitting guest, differs, from tick 521): the player and 16 NPCs, among them the dancers (Hooker0, Nurse0, Female3, Businessman5), the bartender, the
wanderers and the patrolling Businessman0. `LastRenderTime` equal for every NPC and tick (`DistanceFromPlayer` too, until the three below diverge). What it shows about
being viewed:

- No NPC is rendered from the start pose (`LastRenderTime` stays -10 for all 19 over the 600 ticks, nearest at 1,804 units, none in view),
  and by tick 300 18 of the 19 have `bStasis` set (cleared at load; `bForceStasis` is set for all 19), so `AActor::InStasis` (time since
  `LastRenderTime` over 5 s, distance over 1,200 or the zone unseen) returns true and their animation is not advanced: the dancers' `Dance`
  stays at AnimFrame -0.0833 (Female3 -0.1) on both sides to tick 600, `Tween` 0.28. The two agree, but this is the stasis gate, not the dance: **the
  dancing animation is not compared.** It needs a view (or placement) the original can reach without `set Location`; a rotation of the view
  cannot see through the walls. Island is no different at the start pose: 45 of its 58 NPCs are in stasis at tick 600 (3 are rendered, 13 never enter it);
  the pilot's evidence is in the 36 that move.
- A view-dependent field matters here, so it is reported as view-dependent rather than forced: `LastRenderTime`, `bStasis`, and what
  `ScriptedPawn.Tick` gates on `LastRendered()`/`DistanceFromPlayer` (`bCheckPlayer`, `bCheckOther`, low-priority work, ScriptedPawn.uc).

The three that differ are all guests in state Sitting, walking (MoveTarget a Chair at tick 94, none after): NicoletteDuClare0 at tick 96, MargaretWilliams0 at 152, MichaelHamner0 at 277
(Location, Velocity, Acceleration, DesiredRotation). Detail, Nicolette at 95 and 96: Location, Velocity, Rotation, Destination, Focus,
MoveTarget, speeds, flags equal on both sides at 95 and the acceleration there points at the Destination (36 degrees); at 96 the original's
DesiredRotation is 12351 (67.9 degrees) and Acceleration (188.5, 463.1), Play's 6565 (36.1 degrees) and (404.2, 294.4), the speed 22.2 the
same, the direction not: the original steers toward something other than the Destination and Focus it holds. Not traced further.

### Pilot 3: 06_HongKong_WanChai_Underworld (2026-10-13)

**Why this map.** The Club's dancers sit behind walls, and Island's start view has no NPC close by: both gate animation on the stasis check
(`AActor::InStasis` returns true for an NPC that has not been rendered for 5 s). A pilot of animation needs a start view that renders
NPCs. `live-acceptance.mjs screen` finds one: Play's own run of each map from its start pose, the view turned through four yaws
(`ViewRotation` only), and per view the pawns Play rendered within half a second (`LastRenderTime`), their stasis and animation. 47
maps screened (06_HongKong_Storage's page crashed in the screening, not investigated). The Underworld renders 9 pawns at its start view,
six of them in a Dance sequence (next: 02_NYC_FreeClinic, 6, none animating; the Club's dancers are out of view);
the original's own trace then showed 17 NPCs rendered at some tick of the 600 and the six dancers (Female3 to Female6, Secretary0, Hooker0) rendered at every one, all animating (601 distinct AnimFrames).

**Setup.** 50 actors watched (the player, 47 pawns, the two fish generators), 600 ticks at 1/60 s, population matched, seed 1, the player at
the map's start pose (-1171.0, -1124.0, -336.2), yaw 49096, no placement. The animation fields compared are AnimSequence, AnimFrame,
AnimRate, TweenRate, bAnimFinished, bAnimLoop, bAnimNotify and blend channel 0 (sequence, frame, rate, tween), tick by tick.

| Play | actors equal for 600 ticks | what changed |
| --- | ---: | --- |
| master 507daec (baseline) | 26 / 50 | |
| + child frames the page cannot draw stamp their sprites (eb22793) | 34 / 50 | Businessman1 and others seen through a mirror child frame |
| + zone render times reach InStasis (eb22793) | 41 / 50 | Female1 and others in a rendered zone |
| + physicsRotation compares raw rotators (ca0686d) | 47 / 50 | six actors, Hooker0 among them |

What the 47 show: the six dancers' animation (sequence, frame, rate, tween, finished/loop/notify flags, blend channel) is **equal for all
600 ticks on both sides**, as are Female7, SarahMead0, LowerClassMale1 (Walk, wandering), Secretary0, Businessman3 (seated) and the three
MJ12Commandos that wander; every position, rotation, timer and state field of those NPCs too. It is an animation comparison with the
original's stasis gate, because the NPCs are rendered, and the gate's inputs are compared (`LastRenderTime`, `bStasis`, `Dist`).

The three that differ:

- **Businessman1, LastRenderTime from tick 22** (original 77.1033, Play 77.1200 = one tick later) and **Female5 from tick 465** (84.4866
  against 84.5033): a pawn at the edge of the view that Play's frame stamped and the original's did not. Walking patrol in the first case,
  a dancer in the second (her bounds change with the animation). The pawn's position and animation are equal. Unexplained; a candidate
  is the sprite bounds test in `DrawActorSprite`. Not traced; the effect is one tick of `LastRenderTime`, which `bStasis` and
  `ScriptedPawn.Tick` read only at a threshold.
- **TriadRedArrow0, MoveTimer from tick 181** (original -4.045, Play -0.045, then both count down together): a seated guest, the tick after
  the SitBegin animation starts (Physics 4). In the Sitting family, with Club's guests; not traced.

The random stream: the first tick whose draw count differs is tick 3 (original 1, Play 2), then a few more on the same tick lines as the
Club's ghost-player difference (Divergences 6). Not traced.

### Divergences found

1. **Walking script pawns: calcVelocity's class tests (fixed, ee041b8).** Original `calcVelocity` (`0x103cd7a0`) counts `bIsWalking` only for a
   PlayerPawn (`0x103cd7e2..0x103cd815`) and multiplies any other pawn's MaxSpeed by DesiredSpeed (`0x103cdf05..0x103cdf30`);
   Play's walking path did neither: NPCs accelerated at 0.3 x AccelRate and capped at 0.3 x GroundSpeed (SecurityBot0: 28.5 units/s, original 95).
   Proof: [walking](walking.md#script-pawns-calcvelocitys-class-tests-2026-10-11), the oracle (2,420 bit-exact cases, 623 differ without it).
2. **physWalking's own class reads (fixed, 586aa15).** The step cut above 0.05 s and the ZoneVelocity gate for non-PlayerPawns
   (`0x103ca873`, `0x103ca697`), the same page.
3. **First MoveTarget of a walking NPC (fixed, d104c8e).** 16 to 18 Island NPCs picked another next target at their first walk, both ways
   (SecurityBot0 tick 6: original PatrolPoint19, Play PathNode403). FindPathToward's scoutE (`0x103db0e0`) stores the first candidate
   that passes the eye line check and pointWorker and returns (`0x103db2fd..0x103db314`); the translation kept the last one. With the
   fix, no NPC's first MoveTarget differs ([pawn navigation](script-pawn-nav.md), oracle scene `fpt-scoute-first-passing`).
4. **Guests in state Sitting walking between seat positions (open, Club above).** Same state in, different steering direction out at the
   first poll after the new MoveTo; the speed equal.
5. **Draws at tick 24 on Island (explained: a load-time input).** Original 10, Play 18: SeagullGenerator1 and 3 draw 4 each when
   their TryTimer runs out. `PawnGenerator.PostBeginPlay` draws TryTimer and PoolCount from the load's own stream, which the two sides
   do not share, so the generators spawn on other ticks. `live-acceptance.mjs` now reads those fields from the original and writes them
   into Play before the first tick; with them the draw counts are equal over the 260 ticks compared ([random stream](rng.md)).
   Left after that: Terrorist18 (from about tick 140) and UNATCOTroop6 (sits at tick 230 in the original, walks on in Play), and one
   draw-count difference at tick 276 in a 600-tick run.
6. **The ghost player's own draw timing (open, small).** Club: the player draws at ticks 1, 2, 26 and 49 in the original and at 1, 11 and 49
   in Play (the player's position, animation and rotation equal all 600 ticks). Unverified cause: the ghost's `Tread` loop (AnimRate 1.25) and
   its notify.
7. **A divergence the tool made visible but did not cause:** the original's `physWalking` for a non-PlayerPawn reads the `ZoneVelocity` only
   above 300 and cuts steps only when travelling over 20 units; both are in 586aa15 and were not reachable at 60 fps.
8. **Child frames the page cannot draw did not stamp their sprites (fixed, eb22793).** `DrawFrame` draws every child frame and
   `DrawActorSprite` (Render.dll `0x10b25150`) stamps `LastRenderTime` (`0x10b25161`) with the level clock for what it draws. Play stamped only
   the frames the page has a pass for; the Rust `OccludeBsp` made the Underworld's mirror child frame (a mover's translucent glass: its
   `Frame->Sprite` listed Businessman1 and Female3) but the page has no mirror group for it, so those sprites were not stamped.
   Evidence: the tracer's `stamps` command shows Businessman1 stamped only by a recursion-1, Mirror -1 frame at the start view; a
   sweep of `ViewRotation` (24 views, 8 pawns, 192 readings of `LastRenderTime` against the level clock) differed from Play in 2 cells and now in 0.
   `validate-live-visibility-play`.
9. **Zone render times did not reach `AActor::InStasis` (fixed, eb22793).** `Model.Zones[i].LastRenderTime`, which `OccludeBsp` writes for
   every frame's zone and portal view (`0x10b1768d`) and `InStasis` reads (a pawn in a zone seen within 5 s and within 1,200 units of the
   player is not in stasis), stayed zero in Play's level: Female1 (Dist 1,122, `LRT` -10) froze one tick after the script set `bStasis`; the original
   kept ticking her. Same validator.
10. **`APawn::physicsRotation` compared and stepped the wrong things (fixed, ca0686d).** The original (Engine `0x103c9f30`) compares the
   raw int rotators and steps Yaw only while DesiredRotation.Yaw differs from Rotation.Yaw (`0x103c9fc2`), Pitch likewise (`0x103c9fd5`);
   a PlayerPawn takes neither step. Play stepped both axes with a masked comparison on every call, so a pawn with a non-canonical map
   rotation lost it on its first tick (Hooker0: (-4, -32404, 0) kept six ticks by the original, (0, 33132, 0) in Play at tick 1) and a
   walking or falling pawn with Rotation equal to a nonzero-Pitch DesiredRotation was pulled to 0. Found from the first differing field (Hooker0
   Rot, tick 1), the original's call trace (`call 0x103c9f30` breakpoints: the body runs, the rotation does not change) and a
   disassembly; oracle [walking](walking.md#apawnphysicsrotation-keeps-a-raw-rotation-that-already-equals-its-desired-one-2026-10-13), 1,271 bit-exact cases.

### What this shows and does not

It shows, per tick and with the original's own inputs, that Play's live NPC code agrees with the original for 58 of 59 Island actors, 19
of 20 Club actors and 47 of 50 Underworld actors over ten seconds, including animation (the Underworld's six dancers and its walkers, the Island's
walkers), timers, state changes and the stream's use. It found defects the frozen acceptance and the unit oracles missed because they ran
the player or looked at one frame: calcVelocity (1), physWalking (2), the first path choice (3), the render feedback that sets
`LastRenderTime` and the zone times (8, 9) and the pawn rotation step (10). It does not show:
the dancers' animation where no one sees them (the Club: stasis, above); patrols past the first path choice, any NPC beyond 600 ticks, combat, conversations, anything
that needs the player to move or act; lights and particles (the frame at tick 600 has none in view that move); frames with a pawn
in view (Island's start view has none close). The comparison is replay-synchronised: it cannot say that two free-running games would
look alike, only that, given the same inputs, Play's tick computes the original's result. Everything above runs on one Wine/D3D host.

### Running it

```bash
node scripts/live-acceptance.mjs population --map 10_Paris_Club --seed 1      # Play's load: the actors it keeps
DX_HYPRLAND=1 scripts/live-original.sh 10_Paris_Club --ticks 600 --delta 0.0166666675 --monitor 20 [--actor-trace 1:60] [--shot name]
node scripts/live-acceptance.mjs play --map 10_Paris_Club --seed 1 [--draw-trace] [--shot name]
node scripts/live-acceptance.mjs compare --map 10_Paris_Club

node scripts/live-acceptance.mjs screen --maps 06_HongKong_WanChai_Underworld,...   # which maps render NPCs at the start pose (Play's side)
DX_HYPRLAND=1 scripts/live-original.sh <map> --sweep 49096 --sweep-pawns A,B --sweep-step 15   # LastRenderTime per view yaw
node scripts/live-acceptance.mjs sweep --map <map> --yaw-base 49096 --pawns A,B --step 15       # Play's side of the same views
DX_HYPRLAND=1 scripts/live-original.sh <map> --stamps-yaws 49096 --stamp-pawns A,B                # which frame stamps a pawn
node scripts/live-acceptance.mjs eval --map <map> --expr 'window.deusExViewer.status()'         # a look at Play after the frozen start
```

`live-original.sh` takes the Wine lock (`.work/wine-deusex.lock`), refuses to start with another DeusEx.exe running and quits the game by
its PID; Play runs headless Chromium in worker mode.

## Open

- The uniform 1.13–1.41× raw brightness gap under Wine; a CrossOver
  capture on the Mac matched more closely. The user does not want it
  chased: it is a known gamma issue of the game on Windows.
- Rounding of the darkest values, at the level of single raw steps
  (item 2 above).
- The frozen captures stand at the map's frame-0 pose; live behaviour is
  compared per tick in [Live scenes](#live-scenes-2026-10-13), where the
  Sitting guests' steering (4 there) and MoveTimer (TriadRedArrow0, Underworld), Island's Terrorist18, the Underworld's
  view-edge `LastRenderTime` differences (Businessman1 tick 22, Female5 tick 465), the Club's dancers in view (stasis) and a frame
  with pawns in view are still open.
- **Breakable glass and walls are not drawn by the page world.** `world.mjs` builds a mover group for every actor whose class name ends in
  `Mover` and has a Brush (line 317). `BreakableGlass` and `BreakableWall` descend from `DeusExMover` (the runtime attaches them as movers,
  `script-doors.mjs`) but their class names do not match, so the sim holds them (Underworld: 29 movers, 15 of them BreakableGlass) and the page has
  14 groups, none of them glass. Census of the shipped maps (`decodeMap`, Brush > 0 and a class name not ending in `Mover`): **247 brush
  actors in 34 maps** (BreakableGlass and BreakableWall), 10 of which have a polygon with the Mirrored flag (`0x8400008` in the Underworld: 9;
  06_HongKong_Storage: 1). For comparison, DeusExMover brushes with mirrored polygons, which the page does build: 13 movers in 12 maps. The
  visual effect (panes missing, no mirror group, so no reflection of the room in the Underworld's glass) is **not measured**: no
  frame comparison has had a pane in view. Relevant to the stamps fix (8): a mirror child frame for such a pane is made by the sim's
  `OccludeBsp` and not drawn.
- Captures come from one Wine/D3D host. D3D behaviour that depends on the
  driver is not separated from the original's own.

