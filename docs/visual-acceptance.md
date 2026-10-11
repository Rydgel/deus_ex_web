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

## Live scenes (WIP handoff, 2026-10-08: design only, nothing run yet)

Status: the `live-acceptance` branch holds this note and nothing else. No
capture, no Wine run, no code change; the original game was never started.
The worktree `.work/live` is set up (symlinks for node_modules, game data,
Reference, `.cache/*` except `wasm`, `ad/build/dump-actor-win.exe`,
`ad/tools/dxinput.exe`; `npm run build:wasm` done).

Method decided from the sources read so far (to be confirmed by the pilots):

- **Same start.** The frozen start of the sections above (bPlayersOnly from the
  first tick, `ghost`, `ShowHud False`, same console inputs), then release with
  `set LevelInfo bPlayersOnly False` on both sides. Frozen NPCs never ran
  StartUp, so InitializePawn and the first orders run after the release on both.
- **Actor-time clock instead of wall time.** `AActor::Tick` decrements LifeSpan
  by the actor delta. Set LifeSpan (e.g. 60) on one non-ticking-while-frozen
  actor before the release (check that Play's Actor.Tick does the same, and the
  point at which it runs relative to the players-only return): its decrement
  counts exactly the actor time elapsed since the release (tau), whatever each
  side's frame times. Samples on both sides are keyed by tau, not by
  TimeSeconds (which also runs while frozen). Fallback: TimeSeconds minus its
  value at the release.
- **Two modes.** A, stepped: TimeDilation tiny (0.0001) so every tick's actor
  delta clamps to exactly 0.005 (docs/script-level-tick.md; ULevel::Tick
  103a54c8..103a54df), the same step on both sides, so ticks can be compared one
  for one (TimeSeconds then barely moves, so lights that follow it are not
  exercised). B, free-running at TimeDilation 1: Play at its fixed 1/60 s step
  (visual-acceptance.mjs's `dt = 1/60` patch), the original at its own frame
  time; compare state as a function of tau within tolerances (one tick of
  motion, rate x dt of animation), and TimeSeconds for the light phases.
- **Original-side reads.** Extend `tools/dump-actor-win.c` with a watch mode:
  resolve the named actors once through the global object array, then loop,
  reading each actor's struct in one ReadProcessMemory (Location, Rotation,
  Velocity, Physics, AnimSequence/Frame/Rate, LifeSpan, state name) plus
  LevelInfo.TimeSeconds, output JSONL with QueryPerformanceCounter stamps.
  Consistent snapshots: ULevel.InTick (+0x108) 0 before and after the reads and
  an unchanged clock actor (seqlock), else retry. Actor field offsets from
  `sdk-layouts.mjs` / `slotOf(field.loadRecord, 0x48)`.
- **Play-side reads.** A per-tick recorder on the simulation side (a
  `viewProbe`-style call registering actors/fields, appended at the end of each
  processLevelTick), so worker-mode frame merging cannot skip a tick; the page
  drives fixed 1/60 steps. A probe to set the next dt would let Play land on a
  given tau exactly for frame captures.
- **Frames at synced times.** Freeze the original at a requested tau (console
  latency overshoots by some ticks; the frozen clock actor then gives the exact
  tau reached), run Play to that tau (mode A: the same tick count), freeze,
  and compare frames with the existing metrics, reporting actors whose
  measured state differs beyond tolerance so their blocks can be excluded.
- **Randomness (open).** The original seeds MSVCRT rand with time(NULL) at
  startup and every consumer shares the stream (docs/rng.md), Play seeds its
  own from the current time. Random branches (FRand in NPC scripts, e.g.
  docs/script-npc-startup-animation.md) can diverge for that reason alone.
  To measure: whether the original's rand state moves while frozen (render
  consumers), and the FRand call sites on the pilot NPCs' paths; the CRT
  per-thread state could be read from the process to seed Play's stream.
- **Known hazards.** Walking in the original after `set Location` crashes
  ("moved without proper hashing"); under ghost use `--region`. Close the game
  by the PID `original-game.mjs launch` prints.

Next steps: (1) watch mode in dump-actor-win.c and a sanity sample of Island
NPCs (names, orders, positions) on the original; (2) Play-side per-tick
recorder; (3) `scripts/live-acceptance.mjs` (`play`, `original`, `compare`)
with the LifeSpan clock; (4) pilots on 01_NYC_UNATCOIsland (patrols) and
10_Paris_Club (dancers); (5) rewrite this section as "Live scenes" with the
measured divergences and their evidence.

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

## Live scenes: handoff (2026-10-11, paused at the usage limit)

- Built: `tools/dx-live-win.c` (debugger Tick tracer), `src/viewer/live-probe.mjs`, `scripts/live-acceptance.mjs`, `scripts/live-original.sh` (runs under the Wine lock); Island pilot done (25/59 NPCs match 600 ticks, 41/59 after ee041b8); the Paris Club pilot and the "Live scenes" write-up are not.
- Open: Cause 2 (PathNode vs PatrolPoint MoveTarget for 18 Island NPCs, e.g. SecurityBot0 tick 6, Terrorist34 tick 14); ghost flight by key input did not move the player (W/Up, Phys 4), so the Club needs another way to reach the dancers without `set Location`; WaterRing draws at tick 24.
- WIP uncommitted-verified: physWalking class reads (step cut 0x103ca876, ZoneVelocity 0x103ca697): JS oracle 395 cases bit-exact (90 fail without it); Rust walk_loop.rs port builds but validate-walk-loop-kernel/-branches (incl. the new --dt 0.12 runs) were not rerun.
