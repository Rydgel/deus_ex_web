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

**Detail textures are not in any stored original frame but row 4.2.22's, and Play now draws them.** The original's `SetRes` clears
`URenderDevice.DetailTextures` when the D3D7 device lacks `D3DTEXOPCAPS_BLENDDIFFUSEALPHA`, and Wine's ddraw lacks it
([frame projection](frame-projection.md#detail-textures-2026-10-15)): every row of every table in this document was compared
against a frame the original drew without the pass, whatever the ini says, and **was taken with Play drawing no detail textures
either** (before 2026-10-15 Play drew none at all). Since then Play draws the pass by default, as the original does on a device
with the cap, so **a comparison with a stored or newly captured Wine frame needs `?detailTextures=0`**, like `?antialias=0`:
`visual-acceptance.mjs play`, `camera-acceptance.mjs` and `live-acceptance.mjs` (the scripts that read stored original frames) add it
unless `--detail on`, and `play --query detailTextures=1` also keeps it. The pass changes a frame by 0.3 of 255 on average over
the Island deck's frame (a dark scene); the original with the pass is captured with `--poke D3DRenderDevice0:0x78:1` (the unpoked
frame is the reference of the pass's own contribution: `play --detail on --detail-bias f:u[:d],...` also writes Play's frame without
the pass and at each depth offset, `<view>-play-off.png`, `<view>-play-bias<f>_<u>_<d>.png`). The ZBIAS measurement against such
captures is in [frame projection](frame-projection.md#detail-textures-2026-10-15): the contribution's changed pixels match with
Jaccard 0.94 to 0.98 on five of six views.

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

**Probing the original at a camera.** `--cw-probe` attaches `tools/dx-fpu-win.c` for 6 seconds; `--cw-only` drops its
default breakpoints and `--cw-spec label=Module.dll:0xADDR[:n=N][:ret]` (repeatable) adds yours, so the hits at any address of
the running original are counted (D3DDrv's detail pass: [frame projection](frame-projection.md#detail-textures-2026-10-15)).
`--poke Object:offset:value` (repeatable) writes a 32-bit field of a live object before each camera
(`tools/poke-object-win.c`, build as `dump-actor-win`); `DX_INI_SET='Section.Key=Value;...'` changes keys of the launch
copy `DeusEx-ad.ini` (never the installed ini); `scripts/original-run.sh <map> <command...>` runs any command against the
game under the Wine lock.

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
2. *The darkest pixels (2026-10-15: not a rounding difference).* The first reading was a shadowed pipe in Ocean Lab y2
   (`SubBase.Metal.SB_PipeSec_B`) at raw (1,1,1) over a 200×200 patch in the original and 0 or 1 in Play, and, over five views, original
   raw 1 against Play 0 for 6,939 pixels (and 0 against 1 or more for 18,738). Traced, those counts are the Shot ramp of the 0.6 captures and
   animated lights' states; where neither applies the two programs round alike at the bottom of the range:
   [The darkest pixels](#the-darkest-pixels-2026-10-15-not-a-rounding-difference).

### The darkest pixels (2026-10-15, not a rounding difference)

What the first reading never isolated is where the original's and Play's values at 0 and 1 come from. D3DDrv's own path to a pixel is traced in
[texture sampling](texture-sampling.md#texture-formats-uploads-and-stage-operations-d3ddrvdll-2026-10-15): 8888 textures (measured in the running
original), the light map's RGBA7 bytes stored as `2b` by the upload's shift, stages 0 and 1 both `MODULATE`, and no rounding between the stored byte
and the framebuffer's one conversion. Play multiplies `texel x lightmap(b/255) x 2`: the same product. What is left to compare is the frames, with
the two things that moved the old counts taken out.

**1. The 0.6 captures are not the framebuffer.** The counts compared Play's raw frame with Shots at Brightness 0.6. A Shot is a fixed monotone
function of the framebuffer. Against the Brightness 2/3 capture (where Shot is the framebuffer, [Security cameras](#security-cameras-2026-10-14)
item 6), on the five Ocean Lab views' pixels that stay the same in six Play runs and agree with it (4.4 million samples of framebuffer 0 to 11), the 0.6
Shot of framebuffer 0, 1, 2, ... 11 is 0, 1, 1, 2, 3, 3, 4, 5, 5, 6, 7, 8, which is `round(255 (fb/255)^1.11)` with 1.11 = 1/(1.5 x 0.6). Two framebuffer
values share the Shot value 1, so a raw 1 in a 0.6 frame is not a framebuffer 1, and counting it against Play's raw 0 or 1 does not compare roundings.
(This ramp is also the "uniform 1.13 to 1.41 raw gap" of the 0.6 frames on dark scenes; Play's ramp is untouched.)

**2. Animated lights.** The pipe patch sits under an animated light. Seven Shots of Ocean Lab y2 from one running original at one held level time
(Brightness 2/3, level time 54.6626) show the patch at 1 (85 to 89% of its samples) in three captures and at 0 (89%) in four: mean 2.13, 2.10, 2.15
against 1.22 (the stored capture, at 55.268, shows the same 1.22). Play shows the same two states, a frame count apart: patch mean 2.104 with 85.0%
ones against the original's 2.103 with 85.0%, and 1.218 with 89.1% zeros in both. In the matching state the whole frame is identical: Play at the
original's own time (offset -0.6056) against the original's four 'off' captures, **99.986% of all 2.76 million samples equal**; against the three 'on'
captures 91 to 98% (other noise lights are in other states). The moving pixels coincide: 331,873 pixels change between the original's seven captures,
325,866 between Play's four states, 325,862 in both (all but four of Play's). The animation is the one the lighting notes describe: the noise tables take
256 fresh draws every frame, and Pulse, the wavers and Flicker follow the level time ([static lighting](static-lighting.md#light-animation)); how many
frames ran before a shot decides the state, in both programs, and Flicker's table entry is a host key in Play (the actor's address in the original). Ocean Lab
y0's mean, for one, takes 7.09 in eight of 12 Play states and 9.2 to 9.7 in the other four; the original's 8.88 is another state of that family.

**The comparison.** `visual-acceptance.mjs play` takes `--settle-frames n` (frames drawn after the camera is placed: another count, another noise
state) and `--time-offset s` (hold the level at the original's time plus s: another phase). `scripts/dark-pixels.mjs` calls a pixel *steady* when six states
(frame counts 45, 52, 61 at the original's time; offsets +0.37, +0.93, +1.61 s) agree in all three channels, and compares only those with the original's
Brightness 2/3 frame: the 20 stored main views (4 maps x 5), `--query antialias=0`, no detail textures. A seventh state changed Ocean Lab's steady share
by less than 0.001 percentage points.

| Map | steady share | steady, identical | steady mean abs. diff. | mismatches, flat / edge pixels |
| --- | ---: | ---: | ---: | ---: |
| 10_Paris_Club | 100% | 99.995% | 0.00005 | 645 / 2 |
| 01_NYC_UNATCOIsland | 77.6% | 99.611% | 0.0052 | 31,683 / 10,070 |
| 02_NYC_BatteryPark | 96.1% | 99.229% | 0.0115 | 78,161 / 24,243 |
| 14_OceanLab_Lab | 42.6% | 98.718% | 0.0259 | 71,023 / 4,421 |
| all 20 views | 79.1% | **99.496%** | 0.0083 | 181,512 / 38,736 |

Over the 43.7 million steady samples, the original's value (rows) against Play's (columns), for 0 to 5:

| original \ Play | 0 | 1 | 2 | 3 | 4 | 5 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 9,818,495 | 7,494 | 526 | 165 | 148 | 51 |
| 1 | 4,618 | 4,363,773 | 2,800 | 32 | 12 | 4 |
| 2 | 26 | 3,108 | 3,276,980 | 2,450 | 32 | 26 |
| 3 | 30 | 11 | 3,134 | 3,589,012 | 2,326 | 24 |
| 4 | 26 | 7 | 17 | 2,918 | 3,223,734 | 2,431 |
| 5 | 21 | 14 | 14 | 27 | 2,812 | 2,833,623 |

The bottom of the range is not special: 0 against 1 or 1 against 0 is 0.085% of the samples at those two values, the same as 1 against 2 (0.077%) and
4 against 5 (0.086%), in both directions. Paris Club, a dark scene with no animated light, is identical to 99.995% over 13.8 million samples.

**Inputs, and which combinations round differently.** With `?lightDebug=base`, `light32` and `world` (Play's frames of the same views: the base texel b,
the light-map sample l times 32, and white wherever the light-map shader drew; `src/viewer/light-atlas.mjs`, which generates its shader text as before
when the switch is unset) each steady sample has its inputs and the ideal product `x = b x 2 x l / 255`. Over the 15.2 million samples with a light map
under 8 bytes and `x` below 4, 19,559 (0.129%) differ. By `x`, the share that differs:

| x, the tenth of its fraction | .0 | .1 | .2 | .3 | .4 | .5 | .6 | .7 | .8 | .9 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| output 0 (`x` in [0, 1)) | 0.004% | 0.17% | 0.26% | 0.31% | 0.65% | 0.85% | 0.22% | 0.10% | 0.09% | 0.13% |
| output 1 (`x` in [1, 2)) | 0.26% | 0.40% | 0.52% | 0.45% | 0.34% | 0.25% | 0.15% | 0.12% | 0.14% | 0.12% |

The rate peaks next to the rounding boundary (x.5) and falls away from it, and its direction is the one a hair flips it: below x.5 the original is the
brighter of the two in 59% of the mismatches (tenth .4), above it in 25% (tenth .5); it is 0.004% where the product is under 0.1. **Where both inputs are
constant over the pixel's 3 x 3 neighbourhood, so that neither filter blends anything, 1 sample of 4,058,127 differs** (3,984,344 of them at output 0,
16,204 at 1, 34,716 at 2, 22,863 at 3: zero, zero, one, zero). So the conversion of a given texel and light-map byte to a framebuffer value is the same in
the two programs, at the bottom of the range and above. The remaining +-1 sits where the texel or the light map is filtered: bilinear weights are
fixed-point in a GPU's sampler, the interpolated coordinates differ by a hair between wined3d's and the browser's shader, and a hair flips a value at a
rounding boundary. (World-shader samples as a whole, unlit surfaces included: Paris Club 74 of 3.44 million, Ocean Lab 1,458 of 5.59 million, BatteryPark
17,412 of 11.62 million, Island 29,055 of 10.51 million; the Island's are mostly its sky and water.)

**What else differs in steady pixels**, outside the light-map product (172,250 of 12.5 million samples; not rounding):
- *Surfaces the light-map shader did not draw*: actor meshes, and the sky, water and other unlit surfaces. Ocean Lab y1's lower left is one smooth,
  reflective-looking surface (not identified; the actor meshes are another task's) where Play is brighter by 0.93 on average (19.0 against 18.1 over
  131,559 steady samples; 47% of them higher by 1 or more, 0.5% lower, 8,797 by 4 or more): an open difference of that surface, not of the light-map
  product. The Island's skyline and water and a mesh patch in BatteryPark y2 are the others.
- *Polygon edges*: 38,736 samples with a step of 8 or more in the 3 x 3 neighbourhood.
- The animated-light pixels themselves (20.9% of the samples): a different state in each program, compared in no table above.

**Decision.** Nothing to port: neither D3DDrv nor Render.dll rounds in a way Play lacks, and the display ramp and brightness are untouched. The item closes
as (1) the 0.6 Shot ramp and (2) animated lights' states, plus a residual +-1 at filtered texels that is the host GPU's sampler and interpolation
arithmetic (Play's WebGL against wined3d's GL), which the original's code cannot decide. The table of main views at Brightness 2/3 below is one noise
state per view: its mean absolute differences belong to those states (Ocean Lab's frames of the present runs come out at y0 1.8, y1 0.74, y2 0.001 to 0.31,
y3 0.0003 to 0.73 and down 0.45 in different states, against the table's 0.25, 0.32, 0.001, 0.000 and 0.31).

Reproduce (the original's Brightness 2/3 frames: `scripts/original-views-b.sh <maps> --brightness 0.666667`; each Play state copied to
`<view>-<tag>.png` in `.work/acceptance/<map>/`, the `lightDebug` captures likewise):

```bash
node scripts/visual-acceptance.mjs play --maps M --query antialias=0 --settle-frames 52 --time-offset 0.37    # one state; add lightDebug=base|light32|world
node scripts/dark-pixels.mjs --maps M --states r45,r52,r61,t037,t093,t161 --base-tag lbase --light-tag llight --world-tag lworld
```

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

### Light effects against the original (2026-10-14)

The 26-map table aimed at the map's own start poses, which seldom look at an effect-lit surface. These views are aimed at one
effect's surfaces ([light effects](light-effects.md)): the camera sits 150 to 450 units from the light and looks at it (chosen by
Play's reach, the main frame drawing the most surfaces whose light list holds the light), or straight down from beside it. Both clocks
are held at the same TimeSeconds (the original's, to 1 ms), the level is frozen, the frames are raw 1280x720 at Brightness 0.4, and the original's debugger
probe (`--cw-probe`, [render-pass precision](render-pass-precision.md#measured-in-the-running-original-2026-10-14)) reads which
spatial body ran at each camera and its control word.

| Map, light | View | Play / original | Mean abs. diff. | Edge recall / precision | Outlier blocks | Original body, hits (`0x007f` all) |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| WanChai Garage, Searchlight Light6, Light10 (periods 1 and 2) | garage1 | 1.205 | 2.65 | .986 / .995 | 0 | Searchlight 143 |
| | garage2 | 1.208 | 3.88 | .974 / .953 | 2 | Searchlight 159 |
| | garage3 (from beside the light, down) | 1.353 | 2.35 | .975 / .989 | 0 | Searchlight 477 |
| Ship fan, Rotor Light10 | fan1 | 1.287 | 3.58 | .966 / .978 | 0 | normal 97 |
| | fan2 | 1.28 | 3.74 | .959 / .966 | 0 (10 before the tracked corona trace) | Rotor 159 |
| | fan3 (down) | 1.285 | 3.56 | .985 / .993 | 0 | normal 141 |
| Paris Club, Disco Light3 | club1 | 1.337 | 3.26 | .963 / .977 | 0 | Disco 96 |
| | club2 | 1.366 | 2.83 | .966 / .979 | 0 | Disco 138 |
| | club3 (down) | 1.319 | 3.21 | .985 / .980 | 0 | Disco 274 |
| | club4 | 1.347 | 2.76 | .982 / .979 | 0 | Disco 233 |
| Ship's hold, SlowWave Light16, Light17 (Pulse, period 100) | below1 | 1.333 | 3.22 | .981 / .988 | 0 | SlowWave 209 |
| | below2 (down) | 1.362 | 3.84 | .991 / .988 | 0 | SlowWave 276 |
| NYC Street, Spotlight Light26 (a lamp's pool) | street1 | 1.330 | 1.63 | .984 / .988 | 0 | spot 5, normal 5 (built once, see below) |
| NYC Street, Cylinder Light137 | street2 | 1.341 | 2.81 | .962 / .971 | 0 | Cylinder 6, spot 3, normal 6 |

The ratio is the uniform brightness gap (1.2 to 1.46 here, higher on the darkest scenes), which stays outside this
work. Every view's geometry, light pools, sweeping sectors and gradients line up; the Searchlight, Rotor, Disco and SlowWave bodies, which
change every frame, match at the held phase.

- *Ship fan fan2: the coronas, closed 2026-10-14.* The 10 outlier blocks were three coronas Play drew and the original hides,
  Light34, Light35 and Light36. The original's helper finds those three blocked by the moving brush tracker's fragments of
  DeusExMover1, which sit in Level->Model; it was not the Lightbulbs' cylinders. Play's corona scan now traces the tracked model,
  and the matched capture gives 0 outlier blocks, mean absolute difference 3.74 (6.17 before), edge recall .959 and precision .966
  ([coronas](coronas.md) "Lights behind a mover's fragments", `validate-coronas-tracked`, `validate-coronas-mover-play`).
  After the coronas moved to the original's tile chain (2026-10-15, [coronas](coronas.md#on-the-tile-chain-2026-10-15)) the same
  capture reads: mean absolute difference 3.71, edge recall .980 and precision .975, 0 outlier blocks (the flat overlay, upside
  down, on the same code: 3.72, .970 / .968, 0).
- *Garage garage2.* The 2 outlier blocks are on the ceiling's bright white strip lights; the red and blue ceiling panels differ by the
  0.6 Shot ramp and a noise state, not by rounding (raw 1.9 against 2.9 on the red panel, a crop at ratio 1.38;
  [The darkest pixels](#the-darkest-pixels-2026-10-15-not-a-rounding-difference)).
- *Class 0 spot, Cylinder and NonIncidence bodies.* A static light's body runs once, into the cached static map, when a surface is first
  drawn, so a probe that attaches after the camera moved sees no call; `--cw-probe-early` attaches before it moves. Then the street's
  spot (8 calls) and Cylinder (6) bodies and Training's corridor views (trainA, trainB: `-100,840,30` and `1200,840,30` looking down +x, the six NonIncidence
  lights) spot, NonIncidence and normal bodies run at `0x007f`. Their frames match too: the table's street rows, and Training's trainA (Play / original 1.423,
  mean abs. diff. 1.70, edge .954 / .957, 0 outlier blocks) and trainB (1.272, 3.77, .978 / .992, 0).

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
   original's did at the release (pose, Region, animation), the actors the original's load kept are the ones Play keeps (below), and a
   held frame takes the original's Strobe state (Strobe, below). The
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
  holds. The match is by name, and a chance FlyGenerator's name is a per-process counter, not its decoration: a matched name can stand elsewhere
  (2026-10-16, [the Street's steam](#04_nyc_streets-steam-vents-row-4213-fail-on-the-steams-per-pixel-agreement-only)). Both populations now carry
  locations and the driver reports such a generator (`generatorsElsewhere` in `watch<tag>.json`).
- The stream advances while the level is frozen and between ticks: exactly 256 draws between two consecutive Ticks in 600 of 600 inter-tick
  gaps of a Club trace and 23 of 23 of an Island one (URender::PreRender's light noise, [dynamic lighting](dynamic-lighting.md)), about
  100,000 to 200,000 draws per second for Island and Club frozen or live. A tick's own draws are the scripts' and natives': 317 in Island's
  first unfrozen tick (the 59 pawns' and the generators' startup), 54 in the Club's, then mostly under 25. Setting Play's state from the original's at each tick's entry therefore keeps a difference in
  how many draws one actor makes from spreading, and the counts are compared as a result of their own.
- With the population matched the first unfrozen tick's totals are equal (317 and 317 on Island, 54 and 54 on the Club) and so are the
  per-actor counts (`AActor::Tick` attribution) for every NPC and generator; before the match the only difference was one generator
  (`FlyGenerator1`) that the original's load had kept and Play's had not.

### Strobe, a host input, and a TriggerLight the page lit wrongly

Render.dll keeps one Strobe state (`0x10b49ea8` the flag, `0x10b49ea4` the TimeSeconds it last saw). The Strobe light-type function
flips the flag whenever it is called with a new TimeSeconds, and it is called once per drawn frame in which a Strobe light is set up
([mesh lighting](mesh-lighting.md) "LightType functions, Strobe and the noise"). So the flag a frame shows is a function of how many frames
the host drew at distinct times, **a host input like the rand state**: it differs run to run in either program. The tracer
(`tools/dx-live-win.c` trace) now writes it into every row (`strobeIn` and `strobeOut`: flag, time) and, while the level is held, at every
skipped Tick to `<trace>.strobe`; the driver keeps the held value in `hold<tag>.json` and Play's `--shot` sets it (`liveProbe({strobe})`)
unless `--own-strobe`. `compare` reports the flips of both sides.

What the Underworld showed. Original: the flag flipped at ticks 2 and 3 (frozen, TimeSeconds advancing) and **never in the 600 unfrozen
ticks**; the TimeSeconds it last saw stayed at the release (87.54). The reason is a light, not the renderer: the map's only Strobe light is
`TriggerLight1` (engine.triggerlight, state TriggerToggle, LightType 5, map brightness 200, bInitiallyOn false). The tracer's trace of its
live fields (offsets from `liveProbe({offsets})`):

| tick | LightBrightness | LightType | InitialBrightness | Alpha | Direction |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 (frozen) | 200 | 5 | 200 | 0 | -1 |
| 3 (the first unfrozen Tick) | 0 | 5 | 200 | 0 | -1 |
| 22 | 0 | 5 | 200 | 0 | -1 |

TriggerLight.Tick sets `LightBrightness = Alpha * InitialBrightness`, so from the first Tick the light is at 0: SetupForSurf's class test
reads the live actor (`surfaceLightClass`: no LightBrightness is no light), no Strobe light is set up any more, the flag stops
flipping, and the floor it lit is dark in every frame after. Play's sim side agreed (its strobe flips stop at the same moment, which
is how the stuck flag was found) but the page's light maps kept the light at the map's 200, because the Play host forwards a
TriggerLight's `LightBrightness` to the light maps only for Steady lights (`script-lights.mjs lightingChange`: "animated light types remain
unsupported by that callback"). The floor therefore lit yellow-green whenever the flag, set in the frames before the release, happened to be 0:
the run-dependent patch of Pilot 3's frame. **Fixed** (`lightingChange` forwards animated types too; the light map is refilled from the live
brightness, as for steady lights): `validate-triggerlight-animated` (headless; Underworld TriggerLight1 off and in no animated light map after
its first Tick, OceanLab_UC's TriggerLight0 off, Airfield's TriggerLight0, which starts on, stays in 530 entries; fails without the change),
validate-script-lights, validate-script-light-cache (with its original brightness/colour-cache oracle), validate-moving-lights-incremental,
validate-moving-light-effects, validate-light-animation and validate-auglight-lighting pass. Census of the shipped maps: 145 TriggerLights,
28 of them with a type other than Steady in 9 maps (Warehouse 2, Airfield 3, Helibase 1, Storage 8, Underworld 1, Graveyard 2, OceanLab_UC 8,
OceanLab_Silo 2, Area51_Entrance 1), most off until triggered; all showed at the map's brightness before.

The matched-camera views (`visual-acceptance.mjs`) hold the state the same way: a view named `<name>_s0` or `<name>_s1` is taken with the flag at 0 (the strobe
light lit) or 1 (dark), the original through `dx-live-win.exe strobe hold` (the Strobe function's flip, `0x10b05b4b`, patched to a jump while it is held) and Play with
`TimeDilation 0` and `liveProbe({strobe: {flag, time}})`. A free-running capture's phase is a coin flip on each side; Divergence 19 is the case it misread as a mirror
defect.

### Strobe in child frames (2026-10-14)

Render.dll's DrawFrame (`0x10b1a2d0`) calls itself on `Frame->Child` and the siblings first (the loop at `0x10b1a339`,
through `0x10b0102d`) and then sets up its own surfaces: SetupForSurf (`[0x10b3059c]` slot +0xc, `0x10b1aa99`) for each
surface of the frame. The Strobe function runs inside, for every surface whose light list holds a live Strobe light, so the flag
flips when a mirror's child frame draws a strobe-lit surface the main frame does not. `lightMapStrobe` (sim-session.mjs) scanned
the main frame's drawn nodes; it now scans every frame's (and a moving Strobe light must pass SetupDynamics' ViewPlanes test of
that frame).

**The scene.** An aimed view of the Underworld club, camera (-1081, -2010, -336) at yaw 54769 (230 units from TriggerLight1,
looking at the floor mirrors). Play's reach (`strobeProbe`): the main frame draws no surface whose light list holds TriggerLight1,
the mirror's child frame draws 24 (101 nodes). The club's dancers are lit by the same light and call the Strobe function
from SetupForActor, which would flip the flag first, so the views hide them on both sides
(`--cmd 'set ScriptedPawn bHidden True'`; `visual-acceptance.mjs` takes `--cmd` for the original's console and Play's viewProbe).
A search found 60 of 148 sampled cameras around it (x -1300 to -1050, y -2150 to -1900, yaw 53500 to 57500) with a child frame
and no strobe-lit surface in the main frame.

**The original** (`scripts/original-views.sh ... --strobe-poll --cw-probe`; `tools/dx-fpu-win.c` attached for 6 seconds at each camera):

| Camera | SetupForSurf calls by Frame->Recursion | Kept TimeSeconds over 120 polls |
| --- | --- | --- |
| aimed (c0, flag held 0) | recursion 1: 3,932, recursion 0: 51, over 51 frames (DrawFrame: 51 and 51) | 117 distinct values, 116 steps: the Strobe function runs every frame; the flag changed at 76 of them (a poll can span two frames) |
| aimed (c0, flag held 1) | recursion 1: 4,208, recursion 0: 54, over 54 frames | |
| a direct view (d) | recursion 1: 2,351, recursion 0: 936, over 79 frames | 117 distinct values |
| a wall view (p2) | recursion 0 only: 534, over 534 frames | 1 value: no call |

So the original sets up the child frame's 77 surfaces a frame through SetupForSurf (Recursion 1) while the main frame
sets up one, and calls the Strobe function every frame there with no mesh lit by it.

**Play.** `scripts/validate-strobe-child-frames-play.mjs` (worker mode, pawns hidden): at the aimed camera the scan finds
0 strobe-lit nodes in the main frame and 101 in the child frame, and the flag flips at all 23 new TimeSeconds; at a direct view
(d) it flips at all 23 (6 main-frame nodes); at the wall view (p2) at none. With the first version's scan (`strobeProbe({mainOnly:
true})`) the aimed camera flips at none of 23, so the scene discriminates the change. Cost (interleaved medians of
2,000 calls, 3 rounds): 4.0 µs a frame at the aimed camera (0.35 µs before), 2.5 µs at a direct view (2.6), 0.35 µs where no
frame draws a strobe-lit surface; the scan runs only in maps with a Strobe light (Underworld, Ship fan, Endgame 4).

**Matched frames** (flag held 0 and 1, both clocks at TimeSeconds 54.179, pawns hidden): the reflected dance floor, lit and
dark, equals the original's.

| View | Play / original | Mean abs. diff. | Edge recall / precision | Outlier blocks |
| --- | ---: | ---: | ---: | ---: |
| c0_s0 (lit) | 1.212 | 4.65 | .986 / .988 | 0 |
| c0_s1 (dark) | 1.197 | 2.92 | .992 / .989 | 0 |

(The ratio is the uniform brightness gap. The unsuffixed views d and p2 are free-running in the flag, so they are polled and not
compared.)

The gate's frames of this camera and of view d (row 4.2.30, 2026-10-16, the Mac at the identity ramp, each frame at its own clock):
[the mirrored panes at a held Strobe](#06_hongkong_wanchai_underworlds-mirrored-panes-at-a-held-strobe-row-4230).

**Not covered.** The movers' own polygons are still not searched for Strobe lights. The Strobe lists come from the lights that are
Strobe at load. A Strobe light seen only in a sky child frame has no case in the shipped maps (the sky zones hold no lights).

### Placement constraint

The original is never moved with `set Location` or `set Region` in a level that then ticks. The known hash corruption ("moved without
proper hashing", [placement](#placing-the-players-region)) is the reason, and one run crashed that way: `set Location` and `Region` on the
ghost at (-250, -320, -70) in 10_Paris_Club, the tracer released and detached, and the game ended with a General protection fault in
`TickLevel` (`DeusEx.log`: TickLevel, UGameEngine::Tick, XGameEngineExt::Tick, UpdateWorld, MainLoop; address not captured: the capture
was built afterwards). It was not deliberately reproduced; every later run (more than ten), without the placement and with the crash capture armed, did not crash.
Live runs start from the map's own start pose (only `ViewRotation` may be set). Reaching other places by the original's own movement did not
work here: posted `W` and `Up` key events (`down`/`up`, held 2.5 s) did not move a ghost (Location unchanged, Physics 4; unexplained, a
guess is that the game drops held keys while its window is unfocused), and after `set DeusEx.JCDentonMale Velocity (X=-300,Y=-135,Z=0)` the
first read, seconds later, showed Velocity 0 and Location unchanged. Nothing had to move: the camera can
follow another actor without touching any actor, and that is how the Club's dancers, 2,300 units away behind walls, came
into view ([Pilot 4](#pilot-4-10_paris_club-dancers-in-view-2026-10-15)).

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
| master bcff6b0 (AlterDestination, AScriptedPawn::Tick) | 59 / 59 | 36 | Terrorist18, the one left before |

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
**17 of 20 equal for 600 ticks** at ee041b8 (19 of 20 after physicsRotation, 20 of 20 at bcff6b0: MichaelHamner0, a Sitting guest, differed from tick 521): the player and 16 NPCs, among them the dancers (Hooker0, Nurse0, Female3, Businessman5), the bartender, the
wanderers and the patrolling Businessman0. `LastRenderTime` equal for every NPC and tick (`DistanceFromPlayer` too, until the three below diverge). What it shows about
being viewed:

- No NPC is rendered from the start pose (`LastRenderTime` stays -10 for all 19 over the 600 ticks, nearest at 1,804 units, none in view),
  and by tick 300 18 of the 19 have `bStasis` set (cleared at load; `bForceStasis` is set for all 19), so `AActor::InStasis` (time since
  `LastRenderTime` over 5 s, distance over 1,200 or the zone unseen) returns true and their animation is not advanced: the dancers' `Dance`
  stays at AnimFrame -0.0833 (Female3 -0.1) on both sides to tick 600, `Tween` 0.28. The two agree, but this is the stasis gate, not the dance: **the
  dancing animation was not compared in this pilot** (it is in [Pilot 4](#pilot-4-10_paris_club-dancers-in-view-2026-10-15): a camera that follows another
  actor renders the dancers without moving anything; a rotation of the view alone cannot see through the walls). Island is no different at the start pose: 45 of its 58 NPCs are in stasis at tick 600 (3 are rendered, 13 never enter it);
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
| master bcff6b0 (AlterDestination, AScriptedPawn::Tick) | 50 / 50 | Businessman1 and Female5 `LastRenderTime`, TriadRedArrow0 `MoveTimer` |

All 50 equal at bcff6b0, in two replays of two different loads of the original. The six dancers' animation (sequence, frame, rate,
tween, finished/loop/notify flags, blend channel) is **equal for all 600 ticks on both sides**, as are Female7, SarahMead0,
LowerClassMale1 (Walk, wandering), Secretary0, Businessman3 (seated), the three MJ12Commandos that wander, Businessman1 (patrolling, at
the view's edge) and every other watched NPC: position, rotation, timers, state, and the stasis gate's inputs (`LastRenderTime`,
`bStasis`, `Dist`). It is an animation comparison under the original's stasis gate, since the NPCs are rendered. Before bcff6b0
three differed: Businessman1 and Female5 in `LastRenderTime` (one tick, at the view's edge; traced to the frame size, Divergence 12) and
TriadRedArrow0 in `MoveTimer` (a seated guest, 4.0 lower in the original from the tick after SitBegin starts; the family of Divergence 4).

**Frame at tick 600** (both levels held at the last replayed tick, the view from the start pose: three BreakableGlass panes and the
dance floor in view; the Hyprland placement works since the dispatches are spaced; the tracer's trace and `--shot` are kept apart with
`--tag`). Compared against the original's frame (`visual-acceptance.mjs compare --view name:0,0,0:0,0,0`):

| Play | ratio | mean abs. diff. | edge recall / precision | outlier blocks (block ratio min to max) |
| --- | ---: | ---: | --- | --- |
| no glass panes on the page (507daec's world; another load) | 1.171 | 3.64 | .989 / .994 | 1 (0.62 to 1.37) |
| panes, TriggerLight1 lit (Divergence 11 only) | 1.215 | 4.37 | .987 / .991 | 4 (1.01 to 4.68) |
| panes and TriggerLight1 off (Divergence 13) | 1.180 | 3.69 | .988 / .993 | 0 (1.01 to 1.37) |

Without the panes the three ahead are a black hole onto the dance floor. With them but not Divergence 13 a yellow-green patch lit the dance
floor in the panes' region (a 370 x 90 pixel area of the floor, ratio up to 4.7, the original's floor there is dark red), in some runs and
not in others. It was first read as the panes' reflection lit differently (a mirror pass defect, an opaque mirror shows the reflected child
alone) and is not: the patch is the floor's own light map, present in frames without panes, and each toggle of the page's mirror, mover, fog,
corona and actor passes left it. See [Strobe](#strobe-a-host-input-and-a-triggerlight-the-page-lit-wrongly).

**The panes' reflection from other views (2026-10-14).** The three panes reflect together in the original; Play reflected one of them, the first request in
the BSP's order, and drew the others as their own texture (OccludeBsp's mirror requests pass iSurf 0, so CreateChildFrame merges the three coplanar
requests into one frame; Play planned the pass through the first request's group alone). Fixed: [merged mirror
requests](mirror-surfaces.md#merged-mirror-requests-2026-10-14); at four matched views the whole-frame mean abs. difference fell from 13.21, 9.01, 5.45 to
2.46, 2.72, 4.08 (a fourth view's difference is the reflected scene's light, not the panes).

The random stream: the first tick whose draw count differs is tick 1, 2 or 3 depending on the load (original 248, Play 247 on tick 1 of
one load, the numbers of the Businessman1 case fixed in eb22793; not checked whether it is the same cause). Not traced.

### Perception pilot (2026-10-13)

**Question.** Do NPCs perceive and react to a normal, visible player as the original's do? Until now every pilot ran the cheat-flying ghost
(invisible to the AI), and the user reported NPCs that did not hear the player. This pilot compares NPC perception and reaction tick by tick
with the original, with a visible player and known inputs.

**Setup.** `live-acceptance.mjs` gained: `--no-ghost` (the player is a normal `DeusExPlayer`, detectable, not cheat-flying), `--perception`
(each NPC's perception and reaction fields: SightCounter, Stimulus, the Cycle* target picker, FearLevel/FearTimer, AgitationTimer, the
`bLookingFor*` reaction flags, the AlliancesEx table, EnemyReadiness, ReactionLevel...), `--player-alliance mj12` (the player's `Alliance`;
the Underworld's civilians hold a hostile entry for it, so they see an enemy and flee: `AlliancesEx` is filled after the first unfrozen
tick, so the replay writes the alliance to Play at the same moment), `--cmds "tick:console command|..."` (commands typed into the original
between two ticks and run by Play through the same console chain at the same point), `--tag` (separate captures), `--script-trace`,
`--nav-trace` and `--can-see` (Play's script calls, path-native leaf calls and an `Enemy.AICanSee` probe), and the tracer's `call`
breakpoints (`--extra-config`) for the original's own calls. The player stands still at the map's start pose.

**Findings, in the order they were found.**

1. **The AI event manager did not exist.** Natives 713-716 (`AISendEvent`, `AIStartEvent`, `AIEndEvent`, `AIClearEvent`) were recorded no-ops
   (`script-doors.mjs`), 710/711 only filled a map: no pawn ever heard a noise, saw a drawn weapon, heard a distress call or an alarm. `UEventManager`
   (Engine.dll) is now translated in Rust and validated against the unchanged DLL ([AI event manager](ai-event-manager.md)).
2. **`APawn::AICanSee` placed its x87 roundings wrongly** (a 2-ulp `CycleCumulative` difference at tick 4 that hand-written scenes with round
   numbers could not show): [AICanSee's x87 placement](script-pawn-perception.md#aicansees-x87-placement-found-live-2026-10-13).
3. **A Player start (reset) re-ran the startup on the same `LevelInfo`**, and the manager of the old generation named released actors: a new manager
   at every `InitEventManager`.
4. **Four faults in `FindPathToward` / `pointReachable`** (a fleeing NPC picks its route with the path worker): `scoutE` and the second hop
   did not run `pointWorker` after a failed line check (its test walk Bumps pawns: the 4.0 `MoveTimer`), the target-side scans passed `FastLineCheck`
   its endpoints in the other order, and the walks aimed at the requested point instead of the Location the test `FarMoveActor` left
   ([pawn navigation](script-pawn-nav.md#live-divergence-scoute-the-second-hop-and-the-walks-destination-2026-10-13)). Found by comparing the
   original's leaf calls with Play's, 211 path-worker calls of 21 pawns.

**Results** (every watched field of every watched actor, float32 per tick; the replay carries the original's delta, stream state and clock):

| Map and scene | ticks | actors equal | stream draws |
| --- | ---: | ---: | --- |
| 01_NYC_UNATCOIsland, ghost | 600 | all | equal |
| 10_Paris_Club, ghost (fresh original, no flags) | 600 | 22 of 22 | equal |
| 06_HongKong_WanChai_Underworld, ghost (fresh original) | 600 | 50 of 50 | equal |
| Underworld, visible player allied to mj12 | 400 | 50 of 50 | equal |
| Underworld, visible player allied to mj12 (path fixes) | 1,200 | 50 of 50 | equal |
| Underworld, visible player allied to mj12, three more fresh captures (1,500, 1,500 and 1,000 ticks) with the probe gate below | 1,500 / 1,500 / 1,000 | 50 of 50 / 52 of 52 / 52 of 52 | equal |
| Underworld, 940 ticks with the `Touching` slots of the pawns, triggers and doors watched | 940 | 61 of 61 | equal; 581 `AddTouch`/`EndTouch` calls identical in order, result and slots |

Before the path fixes the same 1,200-tick run diverged at tick 560 (Female5), and the first 1,500-tick run at tick 567 (Female3) for civilians fleeing through
the dance floor. Three longer fresh captures then ended with two club doors (DeusExMover4 and 21, Tag `club_doors`) swinging on a curve of their own
from tick 890 to 920 and a pawn meeting them closed (tick 935 to 965), found and fixed as follows.

**The club doors.** A pawn (Businessman3) walks through five overlapping trigger cylinders (Trigger0, FlagTrigger3/15/16, SkillAwardTrigger12) and has four
`Touching` slots, so its slots churn: a Touch/UnTouch of Trigger0 every tick. Each Touch makes the Trigger actor call `A.Trigger(...)` on the door,
which is in `TriggerOpenTimed`'s `Open` sequence with `Disable('Trigger')` in force. In Play that call ran `TriggerOpenTimed.Trigger`, whose
`GotoState('TriggerOpenTimed', 'Open')` restarted `InterpolateTo` from the current angle on every tick (a slow start each time): the door finished
45 ticks late. Three suspects were checked against the original: (1) a same-state `GotoState` recomputing the ProbeMask: no, the script native calls
`GotoLabel` only for the state it is in, an oracle of Core's GotoState/execGotoState/GotoLabel says so and Play already did the same
([door state](door-state.md#gotostate-from-script-the-same-state-runs-gotolabel-only-2026-10-13)); (2) the `Touching` machinery or the overlap
order: no, breakpoints in the real `AddTouch`, `EndTouch` and `BeginTouch` bodies logged 581 calls over ticks 840 to 940 and Play's were identical in
order, result and slot contents, with the slots of the pawn, the triggers and the doors watched per tick; (3) the call itself: yes. The original's
log of the door's script calls (breakpoints at `UObject::ProcessInternal`, gated on DeusExMover4) shows `Trigger` entering and returning at once, with
no `GotoState` anywhere: `ProcessInternal` (Core `0x1013f690`) tests the probe bit of the function's name before it runs *any* script function, a
call from script included, so `Disable('Trigger')` silences `A.Trigger()`. Play applied that test to engine events (`ProcessEvent`) only
([script events](script-events.md#a-script-call-runs-the-same-probe-gate-uobjectprocessinternal-2026-10-13)). Fixed in `ScriptRuntime.callFunction`
and the Rust CALL (`interp.rs`; the callee's probe index travels with the call cache and CALL_BLOCK), with a Unicorn oracle of ProcessInternal
(12 cases) that fails without the gate, a validator of the Rust CALL that fails with the gate disabled, and no change to the Island's digest or
tick time (4 interleaved rounds, 17.91 ms against 17.97 ms).

**Not covered.** The player never fires, throws or makes a noise (`MakeNoise`): the manager's weapon, gunshot and loud-noise paths are exercised only by what the NPCs
send each other (distress, footsteps, the fleeing pawn's `Distress`). A weapon in the player's hand in a live capture is the next scene. `AICanSmell` is the original's
constant 0.0.

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
4. **Guests in state Sitting walking between seat positions (fixed, 0e84704 and b75babd).** Same state in, different steering direction out at the
   first poll after the new MoveTo; the speed equal. Two missing pieces: the move polls fire AlterDestination (not SpawnNotification,
   [pawn locomotion](script-pawn-locomotion.md)), and DeusEx.dll's native AScriptedPawn::Tick (`0x100195a0`), which Play did not run,
   undoes Bump's `MoveTimer += 4` when the avoidance clears ([scripted pawn tick](script-scripted-pawn-tick.md)). With both, a fresh
   600-tick Club run is equal for all 19 NPCs, and Island's Terrorist18 and UNATCOTroop6 are equal over a fresh 262-tick run.
5. **Draws at tick 24 on Island (explained: a load-time input).** Original 10, Play 18: SeagullGenerator1 and 3 draw 4 each when
   their TryTimer runs out. `PawnGenerator.PostBeginPlay` draws TryTimer and PoolCount from the load's own stream, which the two sides
   do not share, so the generators spawn on other ticks. `live-acceptance.mjs` now reads those fields from the original and writes them
   into Play before the first tick; with them the draw counts are equal over the 260 ticks compared ([random stream](rng.md)).
   Left after that: Terrorist18 and UNATCOTroop6 (item 4) and one draw-count difference at tick 276 in a 600-tick run (item 6).
6. **The ghost player's own draw timing (explained: a load-time input, 2026-10-13).** Club: the player drew at ticks 1, 2, 26 and 49 in the
   original and at 1, 11 and 49 in Play (Underworld: tick 2 or 3; Island: 264 and 276 in 600-tick runs). The draws are not the ghost's:
   they are `appFrand` at `0x103bf111` in the LOS worker's far path (the NPC decay gate), run for the player's `ShowSelf` against each
   listener whose `SightCounter` has run out, and a different tick in each original run. `Pawn.PostBeginPlay` draws `SightCounter`
   (`0.2 * FRand()`) from the load's stream, which the two sides do not share. `live-acceptance.mjs` now watches `SightCounter` and
   writes the original's value into Play's pawns (and the load-time timer phase of every actor whose Timer runs from the load: Island's
   trees, `SetTimer(4 + 2 * FRand())`, were the 264/276 draws: their Timer fired on other ticks); with them the stream draws per tick
   are equal for 600 ticks on Island, the Club and (120 ticks) the Underworld, and every actor too ([random stream](rng.md)).
7. **A divergence the tool made visible but did not cause:** the original's `physWalking` for a non-PlayerPawn reads the `ZoneVelocity` only
   above 300 and cuts steps only when travelling over 20 units; both are in 586aa15 and were not reachable at 60 fps.
8. **Child frames the page cannot draw did not stamp their sprites (fixed, eb22793).** `DrawFrame` draws every child frame and
   `DrawActorSprite` (Render.dll `0x10b25150`) stamps `LastRenderTime` (`0x10b25161`) with the level clock for what it draws. Play stamped only
   the frames the page has a pass for; the Rust `OccludeBsp` made the Underworld's mirror child frame (a BreakableGlass pane's mirrored polygon: its
   `Frame->Sprite` listed Businessman1 and Female3) but the page had no mirror group for it (BreakableGlass was not built, Divergence 11), so those sprites were not stamped.
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
11. **The page did not build BreakableGlass and BreakableWall (fixed).** `world.mjs` built a mover group for each actor whose class name
    matched `/Mover$/`; the two classes extend DeusExMover, the simulation tracks them as movers and the page never held their meshes
    or their mirror groups: the Underworld's start view showed the three panes ahead (Mirrored|Unlit|Semisolid) as a black hole, and the
    simulation held 29 movers against the page's 14 (15 glass). The groups are now picked by the class chain (`engine.mover` in
    the lineage `ClassDefaults.lineage` gives, as IsA follows it): 29 and 29 on the Underworld, 90 and 90 on 05_NYC_UNATCOMJ12lab, 41 and 41 on
    00_TrainingCombat, no render errors. Census of the shipped maps: 247 such brush actors in 34 maps (BreakableGlass and BreakableWall), 10
    with a mirrored polygon (the Underworld 9, 06_HongKong_Storage 1), against 13 DeusExMover brushes with one in 12 maps that were built
    all along. A broken pane (BlowItUp leaves the mover 20,000 units up: collider offset (0, 0, 20000), validate-island-blowitup) takes the same
    route as any mover: out of the mirror pass and the frame. `validate-page-movers-play` (worker mode; fails without the change);
    validate-mirrors-play, validate-mirrors, validate-bsp-occlusion, validate-brush-tracker, validate-child-frames,
    validate-sky-in-mirror-play and validate-live-visibility-play pass. The frame at tick 600 (Pilot 3) shows the pane, and its reflection
    agrees with the original's once Divergence 13 is fixed.
12. **The frame size of a live comparison (fixed, 2026-10-13).** The original renders into its window (here 632x1030, UViewport
   SizeX/SizeY, which the tracer now records in every trace row as `viewport`), Play's page into a 1280x720 viewport whose canvas
   gave a 1280x611 render rectangle. Every sprite rectangle and span edge is in pixels, so at the edge of the view they differ by one:
   Businessman1's reflection in the Underworld's mirror child frame (the mirror frame's free spans at its rows 525-538 are [441,455); the
   sprite's raster [X1,X2) is [424,442) at ticks 19-20, where DrawActorSprite stamps it, and [425,441) from tick 21, where it does not).
   Traced with `call` on `FDynamicSprite::Setup`'s caller (the constructor `0x10b233c0`: the frame, the sprite's rectangle and Z) and on
   `DrawActorSprite` (`0x10b25150`), `call-frames` (the renders between ticks), the child frame's span buffer dump: Z and the actor's
   fields were already equal; at the original's frame size Play's child-frame Setup rectangles equal the original's at every tick (424,
   512, 442, 538 ... 425, 512, 440, 538) and the mirror frame's membership matches. `live-acceptance.mjs play` now gives the replay's
   frames the trace's `viewport` (`--own-viewport` keeps the page's); with it the Underworld's 50 actors are equal for 600 ticks. The
   OccludeBsp/Setup translation was not at fault (bit-exact on the same frame, docs/bsp-occlusion.md).
13. **TriggerLights of an animated type kept the map's brightness in the light maps (fixed).** The Play host forwarded a TriggerLight's live
    `LightBrightness` to the light maps only for LightType Steady; a Strobe, Pulse or Flicker TriggerLight that is off until triggered
    stayed lit at the map's brightness, where SetupForSurf's class test reads the live actor and a light at 0 is no light. Found in the
    Underworld frame (a lit patch on the dance floor, first taken for a pane reflection), traced through the Strobe flag, and
    measured in the original: [Strobe](#strobe-a-host-input-and-a-triggerlight-the-page-lit-wrongly). 28 TriggerLights in 9 maps.
14. **The population step destroyed a live pawn whose name the original spells in other case (fixed, 2026-10-14; the sweep's StartUp group).**
    The sweep's group 1 ([Sweep](#sweep-28-maps-1200-ticks-each-2026-10-13)): the pawns of four maps leave StartUp on other ticks than the
    original's, first at ticks 13 to 70, and the original draws more on tick 1. **Method.** A StartUp pawn's first tick draws `FRand()` once for
    `Sleep(FRand() + 0.2)`; the trace now watches `LatentFloat` (Actor +0xe0, the Sleep's remaining seconds), so the draw is known, and the
    stream the tick starts from (`rngIn`, the same on both sides) is the CRT's congruential sequence, so the value names the draw's index in the
    tick, per pawn and per side (`scripts/live-draw-shift.mjs`). **Evidence.** 05_NYC_UNATCOMJ12lab, two loads (original 165 draws on tick 1, Play 161, 33
    of 53 pawns diverging in 100 ticks): the first 20 pawns of the actor order (SecurityBot0 ... Doberman3) drew the same index on both sides,
    and every pawn from Terrorist1 on drew **4 indices later in the original**: four draws that Play does not make sit between Doberman3's
    and Terrorist1's ticks, and every Sleep after them read another value, so the pawns woke on other ticks. The population step had logged
    what it did: `population: 2 actors only Play had destroyed (light1 MIB1); 2 only the original has (Light1 mib1)`. They are the same actors
    under other spelling: the name table keeps the first spelling registered and FNames compare without case, so the original's `mib1` and
    `Light1` are Play's `MIB1` and `light1` (also in 06_HongKong_MJ12lab and 14_Oceanlab_Silo). The step compared the spellings exactly, destroyed Play's `MIB1`,
    a live pawn that the original ticks (StartUp: Sleep and three more draws = the four), and reported `mib1` absent, which also took it out of the
    watch list. Per actor and call site, on a fresh load with `--actor-trace 1:1` and the CRT call breakpoints: `mib1` is entry 84 of 659 AActor::Tick
    entries, between Doberman3 (63) and Terrorist1 (85), and draws 4 times from script `FRand` (`0x101362ac`); Play, with the fix, 4 as well (165 draws on tick 1
    on both sides). It was not load-dependent in these maps (two of two loads), nor a missing per-load input, nor a tracing effect: the sweep's
    "good in one load, bad in the next" was the random FlyGenerators below. **Fix.** The population step in Play and in the driver compares names without case;
    `byName` finds an actor by either spelling (the replay's rows are keyed by the original's); the timed actors Play reports are watched in the original's
    spelling; the driver also counts the spawned class-name families (an extra ParticleGenerator or Medkit the original's load made) and treats a
    difference like a missing actor. **Check.** `validate-live-population-case` (worker mode; fails without the change: `removed` holds `light1` and `MIB1`);
    the first bad load's trace replayed with the fix: tick 1 draws 165 and 165, every one of the 53 StartUp pawns on the same index, 0 of 53 actors
    differing in 100 ticks (33 before); the three maps over 1,200 ticks: see the table in the Sweep section.
15. **A FlyGenerator only the original holds draws on tick 1 and moves no pawn (explained; the sweep's BatteryPark load is not).** `DeusExDecoration.PreBeginPlay`
    spawns a FlyGenerator for 10% of the decorations that make flies, from the load's stream, so the original's load holds some that Play's seeded load does not.
    Attributed per actor and call site (`--actor-trace 1:1` and call breakpoints on the CRT's `rand` `0x101232d0` and `appFrand` `0x101232e0`, whose
    return address names the caller; `scripts/live-draw-attr.mjs`) on a BatteryPark load whose only difference to Play was `FlyGenerator0`: the original drew 198
    on tick 1 against Play's 196, and the two extra draws are `FlyGenerator0`'s own tick, script `FRand` (`0x101362ac`) twice, at entry 414 of 659 AActor::Tick
    entries. A spawned actor takes its place after the map's own actors (the 41 pawns are entries 50 to 259), so the generator's draws come after every
    map-placed pawn's: 0 of 41 pawns differ in 150 ticks (Silo: FlyGenerator0 and 1 absent, 133 draws against 129, 0 of 33 differ). The tick-1 draw count differs by
    two per generator and nothing else; the earlier reading that an absent generator "shifts the pawns after it" is not supported (it can shift only actors spawned
    after it). Play cannot hold the generator, so the driver reloads the original until its population is exact (`live-original.sh` tries 8 loads, 14 in the final
    runs below); `--allow-missing` keeps its meaning (the actor leaves the watch list).
16. **checkMove's Hit buffer and MoveActor's early return (fixed, 2026-10-14; the sweep's group 2, MedicalBot0).** The pick's test moves of a pawn with
    MaxStepHeight 0 (the robots) went one stride too far: checkMove's FCheckResult is the caller's `Hit(1.f)`, shared by its five MoveActor calls, and ULevel::MoveActor
    returns without writing it for a nearly-zero Delta, which the step-up and step-down deltas are when MaxStepHeight is 0; the port made a fresh hit per move
    and so missed the wall branch (FarMoveActor back to the stride's start). Found from the first differing test move of the original's call trace against Play's
    (`call` breakpoints at the pick worker `0x103c7fc0`, MoveActor `0x103990e0` and FarMoveActor `0x10398ba0`; `play --nav-trace`, which now logs
    AIPickRandomDestination): [pawn navigation](script-pawn-nav.md#live-divergence-checkmoves-hit-buffer-and-moveactors-early-return-2026-10-14), oracle scenes (four fail
    before the fix), 237 of 237 bit-exact. The three 1,200-tick 05_NYC_UNATCOMJ12lab traces replay equal for all 59 actors with it.

17. **Pickups block a pawn's moves; MoveActor's block test was the controlled player's (fixed, 2026-10-14; the sweep's group 2, the wander destination's Z).**
    Doberman0 and Doberman1 (Warehouse: Z 28.4 in the original, 28.3 in Play), Terrorist5 (BatteryPark: 380.23 against 363.90, the same X and Y), SecurityBot4
    (Dockyard: the pick's calls differ, its destination does not). **Method.** `call` breakpoints at the pick worker, MoveActor and FarMoveActor for every pawn,
    the Hit's actor named at MoveActor's return (`namearg 7 4`), `scripts/live-pick-compare.mjs` (the original's calls against Play's `--nav-trace`, pick by
    pick), and the tracer's new `rng-file` (a fresh load draws another capture's recorded stream, so the BatteryPark divergence, which loading again does not
    repeat, was reproduced with the original's calls: Terrorist5's tick-13 pick, 77 calls, Z 380.2277). **Evidence.** The first differing call is always a
    MoveActor whose Hit names an item in the original (`Liquor40oz20`, `Liquor40oz48`, `HazMatSuit0`) and passes through it in Play; the bottles are where Play
    has them with the same collision word (`0x7`: no bBlockPlayers). Engine.dll `0x103996aa..0x1039978a`: the candidate's bit is picked by the source's
    category (bBlockPlayers for a controlled player or a Projectile, bBlockActors otherwise), not always bBlockPlayers; an item that blocks actors and not
    players stops a pawn. **Fix and oracle.** `moveQuery` and the Rust `move_pawn.rs`; `validate-native-move-query` +280 cases (pawn and Projectile sources over every
    candidate kind and flag word): 54 mismatches before, 0 of 760 after; the `collision-bits` scenario in `validate-pawn-move-kernel` (Rust and JS equal). **Result.**
    Warehouse 18 of 18 picks and every watched field equal for 150 ticks (Doberman0 from tick 56 and Doberman1 from tick 42 differed), Dockyard 31 of 31,
    Terrorist5's 77 calls equal ([pawn navigation](script-pawn-nav.md#live-divergence-pickups-block-a-pawns-moves-2026-10-14), [move query](move-query.md)).
    **The sweep's own traces.** Fresh loads did not repeat the sweep's cases (a pickup lies in a pick's path in some loads), so the sweep's traces (their sidecar
    files rebuilt from the trace: pawns, generators and timed actors from its first rows) were replayed with the rule before and after the fix: before,
    **every reported case reappears with the reported values**: Hooker0 tick 8 (Dest Z -1140.60 against -1141.03) and BumMale1 tick 54 (-1136.10 against -1136.20) in
    02_NYC_Street, Doberman0 tick 33 and Doberman1 tick 47 (28.4 against 28.3) in 02_NYC_Warehouse, SecurityBot0 tick 28 ((2523.25, 4365.28) against (2572.08, 4376.01)) in
    09_NYC_Dockyard, Terrorist23 tick 393 in 03_NYC_MolePeople (below); after the fix none of the five differs (60 to 410 ticks, every watched actor). The Dockyard
    waypoint is the same cause as the Z cases: the pick's test moves stop at a HazMatSuit (or a bottle) and the last in-band position is another one. The original's SecurityBot0
    pick of that tick was also reproduced in a fresh original (`--rng-from` the sweep's trace): 4 picks, the 4th found, destination (2523.248, 4365.276); Play's 4 picks equal.
    **Terrorist23 (group 4, Mole People tick 393).** The pawn's first walking step, with the original's MoveActor calls captured (physWalking for Terrorist23 under a gate: a
    single real move of (0.031, 0.135, 0) and its riders, no vertical move, Z stays 47.80): Play's first step ended 3.81 higher in PHYS_Falling because the walk trace
    (`--page-params 'pawnPhysics=js&walkLoopKernel=js&movePawnKernel=js' --nav-trace Terrorist23`, the JavaScript twins) shows the move **blocked by `Rat1`** (Hit.Time 0), then
    the step-up (25), the move, the step down (landing on the Rat's top, 3.81 up). A Rat has bBlockPlayers and no bBlockActors (the class values in Play's linked defaults; CollisionHeight 1.75, radius 16), so the old rule stopped a Terrorist at it and the original's rule does not: the same fault.
    With the rule fixed the sweep trace replays equal (the draws too: they differed from tick 393, original 0 and Play 2); two fresh loads of the map (m1: Terrorist23 starts to
    walk at tick 398 with the same step, equal; m2: it does not walk in 600 ticks) never had a rat there, which is why loading again did not show it. The step-down and floor-check
    capture the task asked for needed no new comparison: the original makes no such calls on that step.
18. **A directly opened map has an empty FlagBase; Play's login supplies PlayerTraveling (a harness input, fixed in the replay, 2026-10-14; the sweep's group 3).**
    Play created two flags in the Underworld at tick 61 (`M06_HONGKONG_WANCHAI_UNDERWORLD_StartupText`, `M6MissionStart`), brought `JaimeReyes1` into the Paris
    Metro at tick 61 and relocated `Female8` in the Wan Chai Market; the original did none of it. **Method.** `tools/dump-flags-win.c` walks the player's
    FlagBase in the running original (the player's `+0x890`; 64 bucket heads at `+0x28`, each XFlag `+0x28` name, `+0x34` next, `+0x38` type, `+0x3c`
    expiration, `+0x40` value, `+0x128` default expiration) and `original --dump-flags` writes it at the frozen start and at the end hold
    (`flags-start<tag>.txt`, `flags-end<tag>.txt`); Play's side is `liveProbe({flags})`. **Evidence.** Underworld, Metro and Market: **0 flags at the frozen start**
    (default expiration 0) and **0 flags after 130 unfrozen ticks** with the default expiration at mission + 1 (7, 11, 7): the mission script's first Timer ran
    `InitStateMachine` and found no `PlayerTraveling`, so no `FirstFrame` (which would have created `M#MissionStart` at least). The original's `open` carries no
    travel marker. Play's `loginPlayer` supplies it unconditionally (`beginFreshMission`, [training mission entry](script-training-mission-entry.md): a fresh
    mission entry, not general travel), so its first Timer ran `FirstFrame`: Underworld 2 flags, Metro 2 (`M10_PARIS_METRO_StartupText`, `M10MissionStart`) and
    `Mission10.FirstFrame`'s `Jaime.EnterWorld()` (`JaimeRecruited` unset: Jaime stands in the Metro in a fresh game), Market 5 (those two and `GothAtButcher`,
    `GothAtFlower`, `GothAtVase`) and `Mission06.FirstFrame`'s relocation. **Decision: a harness input, not Play logic.** The viewer's Player start is a mission
    entry and keeps its marker; the replay starts where the original's directly opened map does: `liveProbe({flags: {delete: ['PlayerTraveling']}})` before the first
    tick (the original's DeleteFlag native), `--keep-traveling` keeps Play's own. **Result.** The three maps equal for 130 ticks, the draws per tick equal at tick 61 (they
    differed there: Metro original 0, Play 3; Market 3 and 4), the FlagBase at the end equal (default expiration 7, 11, 7; 0 flags).

19. **The Underworld's reflected floor lit in the original, dark in Play: the Strobe phase of a frozen capture (a host input; no mirror or lighting defect in Play, 2026-10-14).**
    The 2026-10-14 mirror fix left one of four matched views (d, eye (-1120, -1900, -296), yaw 55000) at 4.76 mean abs. difference with edge recall .646: both panes
    reflect in both programs, but the original's reflected floor and dancers are lit (olive) and Play's dark red. The direct view and the walls of the same frames agree.
    **Original.** The Strobe light-type function (Render.dll `0x10b05b30`) compares the kept time `[0x10b49ea4]` with the light actor's `Level.TimeSeconds`
    (`[[actor+0xa8]+0x478]`); when they differ (the `jne` at `0x10b05b4b` skips the update when they are equal) it stores the new time and flips the flag `[0x10b49ea8]` (`0x10b05b58..0x10b05b61`), and a set flag
    writes 0 to the brightness out (`0x10b05b6d..0x10b05b73`). TriggerLight1 (Strobe, brightness 200, `LightRadius` 16 so 425 units from (-1027, -1860, -226)) lights the dance floor
    and the dancers, and a frozen level (`bPlayersOnly`, the acceptance's) never ticks it to 0 ([Strobe](#strobe-a-host-input-and-a-triggerlight-the-page-lit-wrongly)). Every frame
    drawn at a new TimeSeconds that sets a Strobe light up flips the flag: a capture is lit or dark by the parity of the frames drawn, in either program.
    **Measured in the original** (`tools/dx-live-win.c strobe poll`: flag and kept time, 120 samples 5 ms apart per camera, free-running, the clock held at dilation 0.001, 52 fps):
    view d 32 distinct TimeSeconds (steps of 1.9e-5, frame 19 ms), 31 transitions, **the flag changed at all 31**; a 12 of 12, b 13 of 13, c 10 of 10. The three wall views the
    Rust core reports as a mirror request without a child frame, (-1300, -2000, -336) yaw 43000 and (-700, -2000, -336) yaw 49152 and 55000, kept **one TimeSeconds for 120
    samples**: no Strobe call, no flip. Play (a headless page, per frame light state): the flag flips at every new TimeSeconds at a, b, c, d (23 of 23) and does not at those three.
    **The paired capture.** `tools/dx-live-win.c strobe hold <flag>` turns the `jne` at `0x10b05b4b` into a `jmp` and writes the flag, so the original draws in a state of
    our choosing; Play takes the same state with the clock held (`TimeDilation 0`: no new TimeSeconds) and the flag written (`liveProbe({strobe})`). `visual-acceptance.mjs`
    takes `--view <name>_s0` (lit) and `<name>_s1` (dark) for it. Original at TimeSeconds 52.30 (the Play run held at 52.298), Play over original:

    | View | free-running capture (the mirror table's, one side lit or dark by chance) | flag 0 (lit) | flag 1 (dark) |
    | --- | --- | --- | --- |
    | a | 2.46, .995 / .992 | 4.15, .986 / .982 (ratio 1.215) | 2.40, .982 / .973 (1.221) |
    | b | 2.72, .998 / .994 | 3.62, .985 / .990 (1.192) | 2.51, .995 / .984 (1.179) |
    | c | 4.08, .981 / .990 | 3.93, .982 / .990 (1.210) | 3.20, .997 / .988 (1.208) |
    | d | **4.76, .646 / .800** | **2.67, .979 / .987** (1.215) | **1.73, .990 / .985** (1.202) |
    | r: the direct view from d's reflected camera (-1120, -2208, -296), yaw 10536, no mirror, TimeSeconds 53.13 | | 3.27, .982 / .970 (1.236) | 2.82, .978 / .968 (1.247) |

    Mean abs. difference, edge recall / precision; no outlier block in any pair (block ratios 0.98 to 1.74 around the uniform 1.2 gap, which stays outside this change). The earlier
    free-running a and b equal the dark pair and c the lit pair, so both programs happened to be in the same phase there and in opposite phases at d. In d the mirror area alone
    (490 x 520 at 340, 170): ratio 1.215 (lit) and 1.203 (dark), the frame's own, with the left wall at 1.27. The original's dark frame (d_s1) is Play's dark frame: red floor,
    dim dancers, and the lit/dark ratios of the mirror area (R, G, B) are the original's 1.79 / 2.68 / 1.97 against Play's 1.73 / 2.74 / 2.08, those of the reflected camera's
    direct opening 1.43 / 1.69 / 1.36 against 1.40 / 1.66 / 1.35.
    **Live, not frozen.** TriggerLight1 ticks to 0 on the first unfrozen Tick (the original: `LightBrightness` 3.8e-29 read from the running game, the flag one value for 40
    polls, the floor dark red in d); Play after `--unfreeze` (`viewProbe({playersOnly: false})`, which was ignored and now clears the flag as `set LevelInfo bPlayersOnly False` does):
    TriggerLight1 0 within 10 frames and the flag stops, d at 2.10 mean abs. difference (edge .926 / .939, 4 outlier blocks: the dancers have moved on the original's side), a at 3.48. A normal
    game never shows this floor lit before the club's trigger fires; the lit frame is a frozen-capture state.
    **Decision.** Not a Play defect: mirror and direct views follow the flag alike, the reflected scene's lights, light maps, zone and the dancers' lighting are the same set the
    direct view uses, and the cadence equals the original's at all seven cameras. The change is in the harness: paired states, the Hyprland window selection (the largest client of
    the class, as `live-acceptance.mjs` does; the first client was a hidden log window), `--unfreeze`, `--strobe-poll`. **Check.** `scripts/validate-strobe-mirror-play.mjs` (worker mode; the cadence
    at seven cameras, the held lit/dark ratios within 10% of the original's, the unfrozen light; fails without the `viewProbe` change).
    **Not reached, then closed.** `DrawFrame` (`0x10b1a2d0`) calls SetupForSurf through the light manager (`[0x10b3059c]`, slot +0xc, at `0x10b1aa99`) for each frame's surfaces, children first, so a
    strobe-lit surface drawn only in a child frame flips the flag; Play's `lightMapStrobe` read the main frame's drawn nodes only. A sweep of 200 random views of the club did not separate the two (62 had a child frame,
    60 flipped at every step; each also drew a dancer lit by the same light, whose SetupForActor flips the flag first, or a strobe-lit surface in the main frame). With the dancers hidden and the camera aimed
    at the floor mirrors, 230 units from the light, the scene exists: [Strobe in child frames](#strobe-in-child-frames-2026-10-14).

20. **Console parameters of type `class<...>` were not parsed (fixed, 2026-10-15; found by the Pilot 4 camera command).** `PlayerPawn.CheatView(class<actor> aClass)` and `ViewClass` stopped at
    `ScriptConsoleExec ImportText is not linked for class`. The original path is `UClassProperty::ImportText` (vtable `0x10175ec4` slot `+0x84`, thunk `0x10101190`, body `0x10167110`) over `UObjectProperty::ImportText`
    (`0x10166e20`: `ReadToken(.., 0x400, DottedNames 1)`, `None`, spaces skipped and one character consumed whatever it is, `StaticFindObject(PropertyClass, ANY_PACKAGE, token, 0)`, a quote starting
    `Class'Package.Object'`), then the metaclass check (the value must be exactly a `UClass` and reach `[property+0x64]` through SuperField `+0x28`, else it is cleared to None). Translated in
    `src/runtime/script-class-import-text.mjs`; `scripts/native-class-import-oracle.py` runs the unchanged DLL body through the real vtable slot over a fixture of named objects, and
    `scripts/validate-class-import-text.mjs` compares 28 texts (pointer returned, value stored, every `StaticFindObject` argument): equal, 12 found, 3 cleared by the metaclass check, 10 NULL; the same validator
    runs `CheatView` in Play (00_Training: first actor of the class, cycling, back to None, bBehindView). Evidence and the explicit boundaries (the quoted spelling, a class Play has not linked,
    a parameter after one that ends the text: the original's pointer lies one character past the terminator): [console exec](script-console-exec.md#class-parameters-2026-10-15).
21. **A pawn's third-person weapon is not drawn (found 2026-10-15 in the Island close view; fixed in the main frame the same day, mirror frames open).**
    **Result** ([weapon attachment](weapon-attachment.md)): the mechanism was confirmed by a debugger on the running original (`dx-live-win.exe weapon`: breakpoints at `0x10b256a3`,
    `0x10b0f212`, `0x10b0f44d`, `0x10b257da`; 1,558 draws of `Terrorist22`'s Glock, `ThugMale3`'s mini crossbow and `Terrorist1`'s sniper rifle), the hand frame DrawLodMesh builds from the pawn mesh's special triangle and the
    weapon's Coords run under Unicorn and match the original on every word, and Play now draws the weapon (`actor-weapon-sim.mjs`). *The "carried decoration" below was a misreading*: `Pawn+0x558` is
    `PlayerReplicationInfo` and the block draws a Capture-the-Flag flag (multiplayer). *Frames*: the Island view (`--tag wpn3`, `?antialias=0`, a fresh original and the replay of its 40 ticks, the
    level held): whole frame ratio 1.316, mean abs. diff. 2.92 (2.94 without the weapon), edge recall .999 / precision .990 (.981 / .988), sub-pixel (0, 0), 0 outlier blocks; over the pistol's
    region (50x90 px) the mean abs. diff. 7.94 -> 3.77, edge recall .475 / precision .662 -> .991 / .991 and 34 -> 0 outlier blocks (block ratios up to 9.0 -> 1.4: the known 1.3 brightness gap
    only). Later the same day: JC's reflection holding a pistol (both frames, with `BehindView`) and a held MedKit (`SelectedItem`, no Weapon) in a mirror's child frame matched the original (debugger log, oracle, pixels: [weapon attachment](weapon-attachment.md#mirrors-2026-10-15)); not covered: a camera window, an armed NPC in a mirror. Original evidence follows. *The frame*: the only difference between the original's and Play's
    frames of the Island view is a metal object with two screwed lugs at the pawn's right hand (diff image, cropped and brightened). *The weapon actor is hidden in both programs*: the
    original (`DX_POST` in `live-original.sh`, `dump-actor-win.exe` on the running game) reads `Terrorist22.Weapon = WeaponPistol13` with `Mesh = Glock` (the first-person mesh), `bHidden 1`, `bOnlyOwnerSee 1`,
    `Owner`/`Base`/`Instigator` the pawn and `Location` the pawn's (Play: the same name and values; `Inventory.BecomeItem`). So the drawn object is not the hidden actor being drawn as an actor. *Render.dll draws it from the pawn's own
    draw*: the mesh branch after the pawn's `FDynamicSprite` (`0x10b25675..0x10b25cab`) tests `[0x10b4eb10]`, walks the actor's class chain to `[0x10b5d698]` (APawn), reads `Pawn.Weapon` (`+0x3d0`, `0x10b256a3`)
    and, regardless of `bHidden`, **swaps `Weapon.Mesh` (`+0x174`) with `ThirdPersonMesh` (`+0x36c`), `DrawScale` (`+0x17c`) with `ThirdPersonScale` (`+0x370`), the byte `+0x165` with `+0x3a2`, `+0x16c` with `+0x3ac`**, zeroes the
    weapon's Rotation (`+0x120`), builds FCoords from `[0x10b4ea08]` (unit coords) and the weapon's Location, takes the poly flags from `0x10b26230`, draws it with `0x10b01221` (the mesh draw) and swaps everything back; a second block (`0x10b25a74`,
    `Pawn+0x558`, the carried decoration) does the same for a carried decoration. Read from the disassembly; no breakpoint at `0x10b256a3` in the running original was made, and the weapon mesh `Glock3rd` (`ThirdPersonMesh`)
    was not identified in the frame by pixel. *Play*: nothing reads `ThirdPersonMesh` except preparing the meshes (`script-doors.mjs`), so no armed pawn's weapon is drawn and no carried decoration is drawn at the hand.
    Hand-off: a weapon binding in `actor-mesh-sim.mjs` (`createMeshBinding` reads the actor's Mesh once; render.rs `mesh_reads` reads `+0x174`) that takes the swapped fields while the pawn is drawn, in the original's order
    (after the pawn, inside its draw, so SetupForActor's cache order follows), then a frame comparison of this view (`--tag cvisl`, 12 `CheatView DeusEx.Terrorist`, `--render-history`) and of any armed pawn close in view.

### Weapon noise (2026-10-14)

**Question.** The perception pilot compared a visible player that never fired or made a noise. Do NPCs hear the player's gunshots as the
original's do: the event manager's traffic, the callbacks they get and what they do with them?

**Scene.** 06_HongKong_WanChai_Underworld, a normal player (`--no-ghost`, no alliance) with 46 NPCs within 100 to 1,500 units. Typed
into the original after N unfrozen ticks with the level held (`--cmds`), run by Play at the same point of its replay: `summon DeusEx.WeaponPistol`
(tick 20); `set JCDentonMale ViewRotation (Pitch=-10130,...)` (50, the pistol rests 0.25 high at 57 units, so a horizontal line misses it
and a 55.7 degree look down hits its disc); `ParseRightClick` (90, the pickup: the item is the FrobTarget, `Ammo10mm` is created and
given); `ActivateBelt 1` (130, the weapon is drawn: `AIStartEvent('WeaponDrawn')`, auto reload); the view levelled (170); then three shots
as the `Enter` binding's key edges (`@down Enter`, `@up Enter` at 210, 270 and 330: `ParseLeftClick|Fire`). A second weapon follows in the
long capture: `summon DeusEx.WeaponAssaultShotgun`, the same pickup with a 49.7 degree look, `ActivateBelt 2`, three shots (600, 660, 720).

What the harness could not do, and why:

* **A typed `Fire` does nothing, in either game.** The alias `Fire` is `Button bFire | Fire`; typed, `UInput::Exec` runs the alias with the
  state's Action None, so `ExecInputCommands` hands every line to `UInput::Exec` (not `UViewport::Exec`) and the exec function never
  runs ([aliases](script-console-command.md#aliases)). Weapon.Fire runs from the key binding's press (`@down Enter`).
* **A held key is impossible through posted messages.** WinDrv's `UpdateInput(0)` releases every key whose `GetKeyState` is up and
  `PostMessage` does not change that state, so `down W`, `down PGDN` left the player standing (tested focused and unfocused). The scene has no
  walking, no turning by key and no automatic fire; the player's footsteps are unverified (below).
* **`set JCDentonMale ViewRotation` was an unsupported command in Play** ("SET of class JCDentonMale is not implemented": the earlier
  gun runs' aim never happened in Play). `UObject::GlobalSetProperty` now runs for script classes ([SET](script-console-command.md#set-of-a-script-class)).

**What the replay measures for the commands.** The original draws frames while a command is typed (256 stream draws each), so the CRT state a command
runs on is not derivable from the ticks. The tracer's `call` breakpoint at `UEngine::InputEvent` (`0x103814e0`) records the state at each key
edge (the `rng` field of its record, `inTick` 0), and Play seeds its stream with it before the matching `@down`/`@up`. The event manager's calls
(`AISendEvent` `0x10382c60`, `AIStartEvent` `0x10382fe0`, `AIEndEvent` `0x103831e0`, `AIClearEvent` `0x103832c0` and the callback delivery
`AIEvent` `0x10384980` with its XAIParams) are logged by breakpoints (`events.cfg`), with the FName arguments decoded (`fname`) and the CRT state
at each call. Play logs the same through `AiEventHost.trace` (`--event-trace`), and `scripts/live-events-compare.mjs` compares the
two per tick: the same sequence, sender or receiver, event, type, value and radius (float32), the callback, state, best sender, score,
visibility, volume and smell, and the **stream state at every call**, so a draw one side makes between two calls shows at once.
The measured state covers key edges only: a console line (`Tantalus`, `ParseRightClick`) runs on the stream state Play has when it types it, so a draw
made by the command itself (the event's `rng` at tick 140 of the `Tantalus` capture) differs while the events and states they lead to are equal.
After a typed command Play lets three frames pass before the next tick, as the original's frames do (a view change stamps the
`LastRenderTime` of what it now shows).

**Results** (every watched field of every watched actor per tick, the manager's calls and the stream state at each of them):

| Capture | ticks | manager calls compared | NPC fields | stream draws per tick |
| --- | ---: | ---: | --- | --- |
| Pistol: pickup, draw, 3 shots (the first and third hit the same NPC and killed him, the second a glass pane) | 600 | 1,069 of 1,069 | 46 of 46 NPCs equal, but the dead one's settling (below) | equal |
| Pistol, then assault shotgun: 6 shots | 860 | 1,586 of 1,586 | 46 of 46 equal (one `LastRenderTime` one tick apart on one NPC for 2 ticks) | equal |
| `Tantalus` aimed at a standing NPC (`Female7`: killed with its 4,000-unit momentum, the others flee) | 400 | 648 of 648 (the stream state at the command's own calls differs: below) | 46 of 46 equal, the dying body's z included | equal |

In those ticks: `WeaponFire` and `LoudNoise` from the player (value 1.0, radius 800), `Projectile` from the `Tracer`, `Futz` when the bullet
hits an owned decoration, the glass's and fragments' `LoudNoise`, then in the next tick `HandleShot` for the 9 to 12 NPCs that hear it
(the hearing score and volume of each, bit for bit), their `Distress` starts and the `HandleDistress` callbacks of the NPCs those reach, and
the NPCs' states (a dancer starts fleeing, the reactions flags, the stimulus pickers) all equal for every tick. 46 NPCs, the hearing
function `AICanHear` and the score callbacks are exercised with the shots at 300 to 900 units.

**Findings**

1. **A shot NPC's carcass paused Play** ("Unsupported original door native 2108 in scriptedpawn.getcarcassdata"). `HaveSeenCarcass` (2108) and
   `AddCarcass` (2109) were missing; translated and checked under Unicorn against the DLL ([carcass memory](script-pawn-carcass.md)).
2. **`set <script class> <property> <value>` was unsupported in Play** (above); implemented from `GlobalSetProperty`.
3. Two tool findings, not game defects: a typed `Fire` is not the binding, and held keys cannot be posted.

**Open**

* **A killed pawn settling into the floor, one tick late.** In the first capture the NPC the shots killed (`LowerClassMale1`, state
  Dying, Physics walking after his fall) stands 3.72 units below the floor at tick 336 in both programs, velocity and horizontal position equal;
  the original lifts him by 2.10 at tick 337 and 1.62 at 338 (to the floor at -336.2), Play at 338 and 339. One tick, three ticks of z. Not traced
  to a body: a capture with `MoveActor` breakpoints on that pawn is needed (the victim differs per capture: a second shot capture hit nobody, a `Tantalus`
  kill of a standing NPC settles equal, so the case is a pawn killed while running, near a floor step at (-1176, -1419)).
* **Footsteps and every held-key behaviour** (walking noise, `PlayFootStep`'s `LoudNoise`, automatic fire) are not compared: the harness cannot hold a
  key. Play does send the player's footstep `LoudNoise` when it runs (15 sends in 280 ticks, volume 0.35, radius 76 to 519 with the speed), from the
  original `PlayFootStep` bytecode; its inputs (`Velocity`, `FloorMaterial`) are unverified against a walking original.
* The player's `TakeDamage` `Distress` and NPC-versus-player combat: no scene. A summoned `MJ12Troop` stood beside the player for 400 ticks without attacking
  (not compared with the original).
* Other weapons: the silenced pistol (no events by `bHasSilencer`), the rifle's scope, the GEP gun's `ProjectileFire`, thrown grenades.
* The player's own `AnimFrame` differs by a constant 0.0125 for the first 50 ticks of every run (the `BreatheLight` loop; not an AI input).

### What this shows and does not

It shows, per tick and with the original's own inputs, that Play's live NPC code agrees with the original for 59 of 59 Island actors, 20
of 20 Club actors and 50 of 50 Underworld actors over ten seconds (master bcff6b0, each replay of the original's trace of the load it was
taken from; re-run 2026-10-15 on master 9fb73f2 with fresh originals: 88, 22 and 50, [above](#re-run-on-master-9fb73f2-2026-10-15)), including animation (the Underworld's six dancers and its walkers, the Island's
walkers), timers, state changes and the stream's use. It found defects the frozen acceptance and the unit oracles missed because they ran
the player or looked at one frame: calcVelocity (1), physWalking (2), the first path choice (3), the render feedback that sets
`LastRenderTime` and the zone times (8, 9), the pawn rotation step (10), the page's missing glass (11) and animated TriggerLights (12). It does not show:
patrols past the first path choice, any NPC beyond 600 to 1,200 ticks, combat, conversations, anything
that needs the player to move or act; lights and particles (the frame at tick 600 has none in view that move); a pawn's carried weapon in a frame
(Divergence 21) and the BatteryPark load of the sweep (above). Pawns close in view, and the Club's dancers animating in view, are compared since Pilot 4. The comparison is replay-synchronised: it cannot say that two free-running games would
look alike, only that, given the same inputs, Play's tick computes the original's result. Everything above runs on one Wine/D3D host.

### Sweep: 28 maps, 1200 ticks each (2026-10-13)

How far the three pilots generalise. `scripts/live-sweep.mjs run` takes a list of maps; per map it runs Play's population probe, the original
through `live-original.sh` (the Wine lock, one game at a time, a per-map trace `--tag`), Play's replay on that trace and `compare`, and keeps
per actor the first differing tick, field, class and the original's state at that tick; `report` prints the table and the groups, `--json` the
compact copy (`.work/live-acceptance/sweep-2026-10-13.json`, with the traces in `.work/live-acceptance/<map>/`: machine output derived from captures, kept out of Git). Every run is the
map's start pose with no placement, 1200 ticks at 1/60 s (no map needed the `--max-seconds 300` cut: the original's whole run was 163 to 506 s,
the load and any reloads included), the harness at master 441f432: delta, rand state per tick, the original's viewport size, strobe, generator,
pawn SightCounter and timer inputs, population match. Maps: UNATCO HQ visits (01 and 03), Battery Park, Hell's Kitchen streets, the Hotel,
Warehouse, Mole People, Airfield, NSFHQ, the MJ12 labs (05 NYC, 06 Hong Kong), VersaLife, the Canal, Market and Street of Wan Chai, Lebedev's
ship and the dockyard, the Chateau, the Metro, the Catacombs, the Cathedral, Vandenberg (Cmd, Gas), Ocean Lab (Lab, Silo), Area 51 (Bunker,
Entrance). **None was skipped in the end.** 11 failed the original's population match at the first attempt (4 reloads of the map, then the
driver's exit code 3), for two reasons the driver cannot fix by reloading: the original *spawns* FlyGenerators and ProjectileGenerators at
load by chance (each reload continues the numbering, FlyGenerator0-5, then 6-7, ...), and Play's seed-1 load holds another subset; and it holds
actors Play does not have at all after its load (`Light1` in eight maps, `mib1` in three, `InterpolateTrigger0/3`, `WaterRing0`, `SoyFood7`,
`MedKit9`, `TechGoggles0`). Those maps were run with `--allow-missing all`: the absent actors leave the watch list and the record (column
"absent in Play"). A generator only the original holds draws from the stream at its tick (1 to 2 draws on tick 1 each), so the stream's draw
count differs from tick 1 in 13 of the 19 maps with absent actors; in 4 of those 13 it is followed by many divergences (group 1), in the other
9 (or a few) not.

| map | watched | equal | ticks | absent in Play | diverging (first tick, class: field) |
| --- | ---: | ---: | ---: | --- | --- |
| 01_NYC_UNATCOHQ | 22 | 22 | 1200 |  | none |
| 02_NYC_BatteryPark | 64 | 32 | 1200 | FlyGenerator0 | 32: UNATCOTroop2 13 UNATCOTroop: State; UNATCOTroop3 14 UNATCOTroop: Rot; Terrorist5 14 Terrorist: Loc; ... |
| 02_NYC_Hotel | 13 | 13 | 1200 |  | none |
| 02_NYC_Street | 45 | 43 | 1200 | FlyGenerator5 FlyGenerator4 FlyGenerator3 +3 | 2: Hooker0 8 Hooker1: Acc; BumMale1 54 BumMale3: Acc |
| 02_NYC_Warehouse | 32 | 30 | 1200 | FlyGenerator0 FlyGenerator1 FlyGenerator2 +1 | 2: Doberman0 33 Doberman: Dest; Doberman1 47 Doberman: Dest |
| 03_NYC_Airfield | 30 | 30 | 1200 | Light1 | none |
| 03_NYC_MolePeople | 31 | 30 | 1200 | FlyGenerator0 | 1: Terrorist23 393 Terrorist: Loc |
| 03_NYC_UNATCOHQ | 24 | 24 | 1200 | Light1 | none |
| 04_NYC_NSFHQ | 20 | 20 | 1200 | FlyGenerator2 FlyGenerator1 FlyGenerator0 +4 | none |
| 04_NYC_Street | 22 | 22 | 1200 | FlyGenerator4 FlyGenerator3 FlyGenerator2 +2 | none |
| 05_NYC_UNATCOMJ12lab | 58 | 25 | 1200 | Light1 mib1 | 33: Mechanic2 14 Mechanic: Loc; MJ12Troop11 14 MJ12Troop: Loc; Greasel2 14 Greasel: Loc; ... |
| 06_HongKong_MJ12lab | 54 | 41 | 1200 | mib1 | 13: Greasel2 14 Greasel: Loc; MIB3 15 MIB: Loc; Greasel0 17 Greasel: Loc; ... |
| 06_HongKong_VersaLife | 25 | 25 | 1200 |  | none |
| 06_HongKong_WanChai_Canal | 26 | 26 | 1200 |  | none |
| 06_HongKong_WanChai_Market | 46 | 45 | 1200 |  | 1: Female8 61 Female4: Loc |
| 06_HongKong_WanChai_Street | 24 | 24 | 1200 |  | none |
| 09_NYC_Dockyard | 34 | 33 | 1200 | ProjectileGenerator3 ProjectileGenerator2 ProjectileGenerator1 +2 | 1: SecurityBot0 28 SecurityBot2: Dest |
| 09_NYC_Ship | 21 | 21 | 1200 |  | none |
| 10_Paris_Catacombs | 51 | 51 | 1200 | FlyGenerator0 InterpolateTrigger0 | none |
| 10_Paris_Chateau | 22 | 22 | 1200 |  | none |
| 10_Paris_Metro | 61 | 60 | 1200 | FlyGenerator0 | 1: JaimeReyes1 61 JaimeReyes: Loc |
| 11_Paris_Cathedral | 56 | 56 | 1200 | FlyGenerator0 SoyFood7 WaterRing0 | none |
| 12_Vandenberg_Cmd | 48 | 48 | 1200 | TechGoggles0 MedKit9 Light1 +1 | none |
| 12_Vandenberg_Gas | 16 | 16 | 1200 | Light1 | none |
| 14_OceanLab_Lab | 42 | 42 | 1200 |  | none |
| 14_Oceanlab_Silo | 32 | 21 | 1200 | FlyGenerator1 FlyGenerator0 Light1 +1 | 11: ScientistMale0 15 ScientistMale: State; MJ12Commando2 16 MJ12Commando: Loc; HowardStrong0 23 HowardStrong: State; ... |
| 15_Area51_Bunker | 44 | 42 | 1200 | InterpolateTrigger0 Light1 | 2: MJ12Troop0 811 MJ12Troop: Enemy; @player 901 Player: VRot |
| 15_Area51_Entrance | 26 | 26 | 1200 | Light1 | none |

**28 maps compared, 890 of 989 watched actors equal (90%), 99 diverging in 11 maps; 17 maps are equal for all their actors over 1200 ticks.**
(Watched: the NPCs, the player, the generators and the timed actors of the load-time inputs.)

**Ranked groups, by actors and the likely cause** (the first two are the ones to schedule; counts are actors, not ticks):

1. **StartUp phases that leave the state a few ticks earlier or later, every class, first tick 13 to 70: 89 actors in 4 maps** (**cause found 2026-10-14 for
   three of the four maps: a harness fault, [Divergence 14](#divergences-found); BatteryPark's two loads are not reproduced, see "Group 1 after the fix" below**; BatteryPark 32,
   05_NYC_UNATCOMJ12lab 33, 06_HongKong_MJ12lab 13, 14_Oceanlab_Silo 11), 90% of all divergences. First fields State (StartUp against
   Standing/Wandering and back), Loc (the first steps), Rot; classes Terrorist 23, MJ12Troop 9, Greasel 8, MIB 6, UNATCOTroop 5, MedicalBot 5,
   ScientistMale 5, RepairBot 4, ... (the same family in every NPC class: a pawn's StartUp `Sleep`/first MoveTo draw). The stream's draw count
   differs on tick 1 in all four (the original draws more: BatteryPark 201 against 199 and, in a second load, 229 against 219; the MJ12 labs 166
   against 162 and 173 against 169; the Silo 133 against 125) and at many ticks from 13 on. **Load-dependent**: BatteryPark's old run (before the
   harness took pawns' SightCounter and timers) was equal for its 43 pawns; seven later loads with the same harness were equal over 30 to
   389 ticks with equal draws tick for tick (Rat0 and Rat4 swap one draw at tick 1 in two of them: harmless); two loads diverge from tick 13 and 14,
   the sweep's and an exact-population rerun (so not the absent generator). Replays of the clean-population trace without the pawn or the timer
   inputs are worse (23 of 64 against 31). So a per-load input the original's load draws and the harness does not copy yet. **A caution on the
   evidence**: the seven good loads all ran with `--actor-trace` on ticks 1 to 3 (the per-actor draw attribution), the two bad ones did not; the
   breakpoints may change which loads show it, so the cause is not yet attributed per actor. The extra tick-1 draws in the bad loads (2 and 10)
   say which actor to look at. Not Play's tick logic as far as measured.
2. **Wandering: the first destination differs, 5 actors in 3 maps** (**cause found 2026-10-14: [Divergence 17](#divergences-found), pickups block a pawn's moves; the four loads of this paragraph's cases reproduce with the old rule from the sweep's traces and are equal after the fix**). Doberman0 and Doberman1 (Warehouse): `Destination` and `Focus` Z 28.4 in the
   original, 28.3 in Play (the pawn's own Z), first Wandering tick 33 and 47; Hooker0 and BumMale1 (02_NYC_Street): Z lower in Play by 0.43 (-1140.60
   against -1141.03) and 0.10 (-1136.10 against -1136.20), ticks 8 and 54, which makes the acceleration differ by one float ulp and, 270 ticks
   later (some 300 ticks), `Rot` or `MoveTimer`; SecurityBot0 (Dockyard): another waypoint altogether at tick 28 (2523, 4365 against 2572, 4376). The Z cases
   are a deterministic offset (not stream noise): the wander destination's ground height. The maps that hold them also have absent generators
   (tick-1 draws differ), the Z values do not depend on that. Next: the Wandering destination body (`ScriptedPawn.PickDestination`/`GoToLocation`'s
   Z) against the original's call trace of the first pick.
3. **MissionScript.Timer's first call, 1.0 s: tick 61, 2 actors in 2 maps, both in maps with no other difference** (**cause found 2026-10-14: [Divergence 18](#divergences-found), the original's directly opened map has no PlayerTraveling; a harness input, fixed in the replay**). JaimeReyes1 (Paris Metro):
   Play moves it from Z +20000 (out of the world) to 333 and seats it, state Idle to Sitting, `bInWorld` 0 to 1; reproduced with an exact
   population (the clean rerun) and identical in the first sweep. Female8 (Wan Chai Market): the original ends its StartUp at tick 63 and patrols from where it stands (972, -1256, 43); Play, at tick 61,
   moves it to (450, -973, 25) and sets it Standing instead of Patrolling. MissionScript.Timer is `if flags is null: InitStateMachine;
   if Player != null and flags.GetBool('PlayerTraveling'): FirstFrame()` and Mission10.FirstFrame calls `Jaime.EnterWorld()` only when the flag
   `JaimeRecruited` is set: Play runs a FirstFrame, or reads flags, that the original's directly opened map does not. The start state of the
   flag base (PlayerTraveling, the mission flags; [mission timer](script-mission-timer.md), [training mission entry](script-training-mission-entry.md))
   is the input to measure from the original and compare with Play's; not traced further.
4. **Walking down a step: Terrorist23, Mole People, tick 393** (**cause found 2026-10-14: not a step-down; a Rat blocked Play's pawn, [Divergence 17](#divergences-found)**). The original stays PHYS_Walking (Z 47.80), Play is PHYS_Falling at Z 51.61 (3.8
   higher) with MoveTimer 12.51 against 8.51 and falls afterwards. A floor-following (step-down) difference in physWalking for a pawn walking a
   slope or stairs; 1 actor in 1 map in 28.
5. **A pawn attacking the ghost player (Area 51 Bunker), 2 entries.** `MJ12Troop0.Enemy` is JCDentonMale2 in the original and JCDentonMale1 in Play from
   tick 811: the player pawn's name (numbered by the load count, the original having opened the map twice), a harness naming artifact, not a
   behaviour; and the ghost's `ViewRotation.Roll` is -170 in Play, 0 in the original, at tick 901: a damage view shake applied to Play's ghost.

Everything else, 17 maps with 520 NPCs, the player and the generators, is equal tick for tick: UNATCO HQ (01, 03), the Hotel, Airfield, NSFHQ,
the 04 street, VersaLife, the Canal, Wan Chai Street, the ship, the Chateau, Catacombs, Cathedral, Vandenberg Cmd and Gas, Ocean Lab, Area 51
Entrance. What the automatic grouping (`report`) adds: by first field Loc 56 actors / 7 maps, State 24 / 4, Rot 12 / 3, Dest 3 / 2; by class
Terrorist 23 / 3 maps, MJ12Troop 9 / 2, Greasel 8 / 2, MIB 6 / 2; by state at the first difference StartUp 44 / 5 maps, Wandering 25 / 7,
Standing 14 / 3, Patrolling 10 / 4.

Controls run during the sweep: BatteryPark and Metro with an exact population (no actor absent): 31 of 64 and 60 of 61 equal (the same
divergences: the group 1 load and JaimeReyes1); Mole People never matched in four loads (a FlyGenerator) and was not repeated; short runs of
BatteryPark with per-actor draw attribution: seven loads equal. One load per map: group 1 shows a map can be equal in one load and not in the next.

#### Groups 2 to 4 after the fixes (2026-10-14)

Divergences [17](#divergences-found) (MoveActor's block test) and [18](#divergences-found) (the directly opened map's empty FlagBase) explain groups 2, 3 and 4. Each sweep case
was replayed from the sweep's own original trace (sidecar files rebuilt from the trace) with the rule before and after the fix: Street (Hooker0, BumMale1), Warehouse (Doberman0,
Doberman1), Dockyard (SecurityBot0) and Mole People (Terrorist23) reappear with their reported values before and are equal after. Fresh loads, original at 1/60 s with the
pick/MoveActor call breakpoints, then Play on each (150 ticks, every watched actor and every pick call compared): Warehouse 4 loads, Street 3, Dockyard 3, BatteryPark 3 and
the start-up agent's 14 BatteryPark traces (b1-b5, h3-h8, a1, f1-f3): all picks and fields equal after the fix; before it Warehouse z2, Dockyard z1/z2 and BatteryPark f3 differed (the pickup
cases above). Underworld, Metro and Market equal for 130 ticks with the FlagBase empty at the start as the original's. Pilots re-run with the fix (600 ticks, fresh originals,
population exact): Island 74 watched actors and the Club 22 equal in every field; the Underworld's 50 equal in every field. The stream-draw counts of two of those runs differ and were
not attributed (Open below).

#### Group 1 after the fix (2026-10-14)

The cause of group 1 in 05_NYC_UNATCOMJ12lab, 06_HongKong_MJ12lab and 14_Oceanlab_Silo is [Divergence 14](#divergences-found): the harness's population
step destroyed Play's `MIB1` because the original spells the same actor `mib1` (and `light1`/`Light1`), a pawn the original ticks, whose four draws
sit in the middle of the actor order. It was a fault of every load of those maps, not a per-load input; "good in one load and bad in the next" was
the loads' random FlyGenerators, which come after the pawns ([Divergence 15](#divergences-found)). **Tracing was not the cause** (the confound
above): 14 BatteryPark loads of this session, 10 without `--actor-trace` and 4 with the per-actor trace and the CRT call breakpoints on tick 1, all
stream-equal on every tick and none with a StartUp or State difference; the two-draw excess of a load with an absent generator is the same with the breakpoints armed.
The sweep's BatteryPark loads (32 pawns diverging from tick 13 and 14, 201 against 199 and 229 against 219 draws on tick 1) are **not reproduced and not
explained**: the 14 loads include none with that behaviour, an absent FlyGenerator draws after every map-placed pawn ([Divergence 15](#divergences-found)), and no
case-spelling difference exists in this map. Tick 1's draws are Trashbag1's `Containers.Destroyed` (21 to 71 draws, rejection of random spawns: trash paper,
contents) and the pawns'; the next place to look if a bad BatteryPark load shows again is `live-draw-attr.mjs` on that load.

Re-run on the tree with the group 1 fix, exact population (the original reloaded until it holds nothing Play lacks), 1,200 ticks at 1/60 s,
`--max-seconds 300`, three loads per map; the clock and every tick's stream draws equal in all twelve runs. The first column set is that run; "after
checkMove" is the same three traces replayed again after [Divergence 16](#divergences-found) (Play only, the original's traces unchanged):

| map | watched | load 1 | load 2 | load 3 |
| --- | ---: | --- | --- | --- |
| 02_NYC_BatteryPark | 64 | 64 equal | 64 equal | 63 equal; Terrorist5 Dest.Z at tick 13 |
| 05_NYC_UNATCOMJ12lab | 59 | 58 equal; MedicalBot0 Dest at tick 31 | 58 equal; MedicalBot0 Dest at tick 14 | 58 equal; MedicalBot0 Dest at tick 52 |
| 06_HongKong_MJ12lab | 55 | 55 equal | 55 equal | 55 equal |
| 14_Oceanlab_Silo | 33 | 33 equal | 33 equal | 33 equal |
| after checkMove (replays) | | 05_NYC 59 equal, BatteryPark 64 equal, HK 55 equal, Silo 33 equal | 05_NYC 59 equal, BatteryPark 64 equal | 05_NYC 59 equal; BatteryPark Terrorist5 as before |

No StartUp, State or Rot difference remains in these maps (the sweep had 89 actors). The differences left after the group 1 fix were in **group 2** (the
wander destination): MedicalBot0's first `Wandering` pick was exactly one 25-unit stride farther in Play than in the original in every load (from the
pawn's start, original/Play: 225/250 units in a 100-tick load, 250/275, 325/350 and 275/300 in the three above; the same direction, the same draws, Z
unchanged), and Terrorist5's pick (BatteryPark load 3: the same XY, Z 380.23 in the original and 363.90 in Play) differs in height only. The stream stays
equal for both (the pick makes the same draws), so the difference was in the band search's test moves in the world (`MoveActor` with `bTest`), not in
the draws. MedicalBot0's is fixed (Divergence 16); Terrorist5's is not (BatteryPark load 3, and Terrorist7 in a 150-tick load at tick 49 with Z 363.9 against 363.8).

### Re-run on master 9fb73f2 (2026-10-15)

**Pilots**, fresh originals (`live-original.sh`, the Wine lock, population exact: the Club's first load held `FlyGenerator0`, which Play's seeded load lacks, and
was reloaded once), 600 ticks at 1/60 s, seed 1, every watched field per tick, the level clock and the stream draws of every tick:

| map | watched | equal for 600 ticks | clock | stream draws per tick |
| --- | ---: | ---: | --- | --- |
| 01_NYC_UNATCOIsland | 88 (58 pawns, the player, generators, carcasses and the timed actors of the load-time inputs) | 88 | equal | equal |
| 10_Paris_Club | 22 (19 NPCs, the player, 2 RatGenerators) | 22 | equal | equal |
| 06_HongKong_WanChai_Underworld | 50 (47 pawns, the player, 2 fish generators) | 50 | equal | equal |

(The draw-count differences of two of the 2026-10-14 re-runs, unattributed then, did not recur in these three fresh originals: still unexplained, not seen.)

**The sweep's stored traces, replayed in Play only** (`node scripts/live-sweep.mjs replay --from <the earlier tree's .work/live-acceptance>`; the 28 originals of the
2026-10-13 sweep are linked, their watch and population lists taken tagged when the earlier tree kept them tagged; the replay is the same inputs on the current code): **957 of 989
watched actors equal over 1,200 ticks, 27 of 28 maps equal for every actor.** Per sweep group: group 1's maps 05_NYC_UNATCOMJ12lab 58/58, 06_HongKong_MJ12lab 54/54,
14_Oceanlab_Silo 32/32; group 2's 02_NYC_Street 45/45, 02_NYC_Warehouse 32/32, 09_NYC_Dockyard 34/34; group 3's Market 46/46 and Metro 61/61; group 4's Mole People
31/31; group 5's 15_Area51_Bunker 44/44 (its `@player` ViewRotation roll difference at tick 901 is gone too); the other 17 maps as before. **02_NYC_BatteryPark, the sweep's
first bad load, is the one that does not: 32 of 64 equal** (32 pawns differ from tick 13 to 70, UNATCOTroop2 `State`, Terrorist5 `Loc`, ...; tick 1 draws original 201,
Play 199; `FlyGenerator4` only the original holds). It is now a replay, not a story about loads that do not repeat.

*What was found about it.* Play's per-actor draws of that replay (`--draw-trace`) put 24 of tick 1's 199 on `Trashbag1`, which
ticks before every pawn the replay diverges on (Rats, ChildMale0, JunkieMale2, then `Trashbag1`, then the pawns; the equal actors are the ones before it), and a script trace of it
(`--script-trace Trashbag1`) shows `Tick`, `FellOutOfWorld`, `Destroyed` (Containers.Destroyed, bytecode dumped with `dump-script-function.mjs`: `for i<4: if FRand() < 0.75 { three FRand
for the offset; Trash = Spawn(TrashPaper, Loc); if Trash != None { SetPhysics, RotRand, VRand } }`, then `if FRand() < 0.5 { Spawn(Rat) }`): in Play the first `Spawn` returned None and the second
succeeded (11 FRand, one RotRand, one VRand). A pawn after it that reads two draws more or fewer wakes on another tick, which is the sweep's pattern, so **the working
hypothesis is that Spawn(TrashPaper) (or the Rat) succeeds or fails at a location in the original's bad load where Play's does not (another spawn collision answer), 2 draws
apart**. Not verified: the original's own `SpawnActor` results for that load do not exist (the load is not repeatable) and no original `call` log of it was kept.
Two fresh BatteryPark loads with the per-actor attribution armed (`--actor-trace 1:1`, call breakpoints on the CRT draws and on `ULevel::SpawnActor` `0x10394f60`, Play replayed on each):
both **equal** (bp1: 194 and 194 draws on tick 1, 64 of 64 pawns equal over 80 ticks, `Rat0`/`Rat4` swap one draw as before: Play 2/0, original 1/1; bp2: 207 and 207, `Trashbag1` 31
and 31, 64 of 64 equal); 16 good loads against 2 bad overall. The next step is a `SpawnActor` call log (`call 0x10394f60`) of a bad load when one shows, compared with Play's spawn results at
`Trashbag1`'s location, or a spawn-collision oracle at that location.

### The live replay's start state, Battery Park's two loads and the Underworld's flaky draw (2026-10-16)

Three findings from the Stage 4 gate's red and flaky live rows ([Stage 4 exit criteria](stage-4-exit-criteria.md), 4.1.7 and 4.1.8). Two are defects of the
replay harness (`live-acceptance.mjs play`, `viewProbe`), not of the simulation; the third is a property of the stored original trace.

**1. The Underworld's draw count at tick 45 (4.1.7, flaky): the player's animation flags at the start of the replay.** It was not "first replay against repeat": it
differed on 1 of 4, 2 of 3, 4 of 5, 1 of 6, 1 of 8 and 2 of 5 runs in six batches before the change (other agents' jobs were running; the rate was not measured against the load), and on none of 10 runs after it. `--draw-trace` (per-actor draws of every tick) puts the difference on the player: tick 45 draws original 3 = `MJ12Troop0` 1 + `JCDentonMale1` 2, Play 2 on a
failing run (`JCDentonMale1` 1). JS stacks of the player's draws (a temporary hook, not kept) name the missing one: a script `FRand` called by the player's
`PlayFootStep` event, the animation notify of its `Tread` loop (`selectAnimNotify`); the other is the LOS worker's far-path draw in `ShowSelf`. A watch of the player's animation
fields at the start of the replay separates good runs from bad ones exactly:

| run | bAnimNotify | bAnimLoop | AnimLast | OldAnimRate | draws at tick 45 |
| --- | ---: | ---: | ---: | ---: | --- |
| good (w-1, w-2, w-5) | 1 | 1 | 0.9167 (Tread, 12 frames) | 1.25 | equal |
| bad (w-3, w-4) | 0 | 1 | 0.8 (BreatheLight, 5 frames) | 0.5 | one short |

The harness arms the replay with the original's pose and writes only `AnimSequence`, `AnimFrame`, `AnimRate` and `TweenRate` of the player (`live-acceptance.mjs`
request). Everything else the animation keeps (`AnimLast`, `OldAnimRate`, `bAnimLoop`, `bAnimNotify`, from `play-anim.mjs` `startAnimation`) is whatever the animation
running when the write happened set. The ghost starts in its idle `BreatheLight` (no notifies, so `bAnimNotify` 0) and its own script switches to the `Tread` loop in
its first player ticks after `ghost`; the page's frames before the write are not necessarily ticks (the worker merges the page's posts, [sim-worker](sim-worker.md); how many player ticks ran before the write is not
recorded), so on some runs the write came first, `Tread` ran with the idle sequence's flags and its footstep notifies never fired: one `FRand` short, from the tick the first notify falls on. **Fix:** the
harness waits until the player's own animation is the pose's sequence before it writes the pose (`play()`), so the flags are the ones the original's script gives
that animation. After the fix: 10 of 10
Underworld replays with equal draws and `flaky: false` in the gate, and Battery Park's `sweep2` replays (below) are equal for the draws too (3 of 3; before, tick 10 differed:
the same `PlayFootStep` draw). The gate's one-repeat allowance for stream draws is no longer needed for this map; it is left in place (the user's call to remove it).
The fields the original does not record for the player (`AnimLast`, `OldAnimRate`, `bAnimNotify`, `bAnimLoop`) are not compared: the stored traces predate them, and
`--extra-props bAnimNotify,AnimLast,...` watches them on Play's side.

**2. Battery Park (4.1.8): which load is "bad", and the ghost's hash entry.** The doc's hypothesis (`Trashbag1`'s `Containers.Destroyed` spawn) is not what
the stored trace shows. Facts, in the order they were established:

- The stored sweep trace's load is the unusual one: its `population-result` is `{"removed": [], "missing": ["FlyGenerator4"]}`, a `FlyGenerator` the original's load
  spawned by chance (10% per fly-making decoration, [Divergence 15](#divergences-found)) and Play's seeded load lacks. The 2026-10-13 sweep ran with
  `--allow-missing generators`, which takes such an actor off the watch list and replays anyway; every other stored load of the map (`bp1`, `bp2` and the fresh one below) has
  `missing: []`. That is the original's own evidence (its GObjects dump of that load against Play's seed-1 population), and the tick-1 draw count of the trace
  (original 201, Play 199) is that generator's two draws. Which `Level.Actors` slot the generator took (it can tick before the pawns it shifts, which Divergence 15's
  load did not show) is not measured: no `SpawnActor` log of a load with a chance generator exists, and none was captured here.
- A **fresh original load with an exact population** (`live-original.sh`, the Wine lock, `--tag sweep2`, 1,200 ticks: "1305 actors in the original's level, 0 with
  OddsOfAppearing < 1; population: the original holds nothing Play lacks", first attempt) replays **64 of 64 actors equal for 1,200 ticks, clock and stream draws equal**,
  including `Trashbag1` and the pawns the old trace diverged on (tick-1 draws 207 and 207; Play's `Trashbag1` 30 of them). The old trace replayed on today's code is unchanged (32 of 64, UNATCOTroop2
  from tick 13): the load, not Play. It stays in the store under `-sweep`; the gate reads `-sweep2` for Battery Park (`tags` of the `SWEEP` check).
- The fresh trace first replayed 63 of 64: `AnnaNavarre0` stopped at tick 161 (original 163), one draw more in Play. She runs to the player (`RunningTo`, `OrderActor`
  = JC); `RunningTo.Touch` goes to `Done` when she touches him, and Play's `Touch(JCDentonMale1)` fired at tick 160 (touch trace: `AddTouch`, `BeginTouch`), while the
  original's state change shows at 163 (Anna: radius 22, JC: 20, his `bCollideActors` 0 after `ghost`). Cause: `viewProbe`'s placement of the player (commit 6619d4c,
  2026-10-15) moves it with `changeActor`, which removes and **re-adds it to the collision hash whatever its `bCollideActors`**: `ghost`'s `SetCollision(false, ...)` had
  taken it out, so every live replay of a ghost has had a touchable player since then. Fix: re-register only a player that collides (`view-probe.mjs`;
  `--ghost-in-hash` restores the old behaviour for A/B). With it **Anna matches for 1,200 ticks** (the original's JC is out of the hash: her stop at 163 is the state
  code's `IsOverlapping`, as Play's now).
- Result for the five maps of 4.1.8: `validate-stage4-acceptance.mjs --only '^4\.1\.8$'`, 356 s, PASS: 5 maps, every actor equal over 1,200 ticks.

**3. The gate itself.** A second run of the gate in one checkout failed its live rows with ENOENT: this checkout's `.work` is the first store root and also where the
staging goes, so the second run unlinked its own staged files before copying them from themselves. `stageLive` now leaves a file in place that is already at its target and
passes over a root that holds only some of the required lists.

### Pilot 4: 10_Paris_Club, dancers in view (2026-10-15)

**How the view was reached without moving anything.** `PlayerPawn.CheatView(class<actor>)` (exec, needs `bCheatsEnabled`) makes the first actor of the class the player's `ViewTarget` and sets
`bBehindView`; `DeusExPlayer.PlayerCalcView` then takes `Super.PlayerCalcView`, and `PlayerPawn.CalcBehindView(Dist 180)` puts the camera 150 units behind the target along the player's own
`ViewRotation` (a `Trace` shortens it). `set ...ViewRotation` is the only other command. No actor is moved, `set Location`/`Region` is not used, and the player stays where the
map put it (`live-acceptance.mjs --early-cmds "CheatView DeusEx.Female4|set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=49152,Roll=0)"`: typed into the original in the frozen phase,
run in Play after its placement). The view renders three dancers from the first frame, so `LastRenderTime` stays current, `bStasis` is set and `AActor::InStasis` is false.
Play stopped at `ScriptConsoleExec ImportText is not linked for class` before any of it: [Divergence 20](#divergences-found).

| View | ticks | actors equal | the dancers | stream draws | frame at the last tick (`--shot`, `?detailTextures=0`, held level) |
| --- | ---: | ---: | --- | --- | --- |
| A: behind Female3 (`Female4`), looking along -y: Female3 150 units ahead, Nurse0 and Businessman5 in line beyond | 600 | 22 of 22 | Female3, Nurse0, Businessman5: rendered at 600 of 600 ticks, 600 distinct AnimFrames each (`BreatheLight`, then `Dance`), the frame advancing at 599 of 599 steps, Rotation 11, 79 and 64 distinct values (they turn); Hooker0, out of view: 2 distinct frames, in stasis | equal | ratio 1.308, mean abs. diff. 2.93, edge recall .988, precision .990, sub-pixel (0, 0), 0 outlier blocks (block ratio 1.131 to 1.409) |
| B: behind Businessman5 (`Businessman1`), looking along +y, pitch -1500 | 300 | 22 of 22 | the same three, 300 of 300 ticks rendered, 300 distinct frames each | equal | 1.309, 2.92, .988 / .986, (0, 0), 0 outlier blocks (1.126 to 1.426) |

The same trace of the Club's earlier pilot (start view): the dancers were rendered at **0** of 600 ticks and held 2 distinct AnimFrames. **Every watched field of every NPC, the dancers'
`AnimSequence`, `AnimFrame`, `AnimRate`, `TweenRate`, flags, blend channel and Rotation among them, is equal per tick while they dance in view**, and the frames agree outside the known
uniform gap (the ratio): the dancers' meshes close in the frame (Female3 fills a fifth of its width) have the original's pose, skin and lighting.

**An Island scene (third view), and what it found.** `CheatView DeusEx.Terrorist` twelve times (the 12th Terrorist of the actor array is `Terrorist22`, standing in a room at (2954, -271, 1088)) with yaw 40000, pitch -1000:
Play and the original show the same pawn from behind at 150 units, a barrel and brick walls; 300 ticks, **88 of 88 actors equal and the stream draws equal** once the original's render history is
a measured input (`--render-history`: the frames the original drew while the twelve commands were typed, and the start view's, stamped other pawns' `LastRenderTime`, which Play, replaying one
view, cannot repeat: 19 actors differed in `LastRenderTime` from tick 1, and the stream at tick 21, without it; the stasis gate reads that field for 5 s). The frame: ratio 1.311, mean abs. diff. 3.30, edge recall
.958 / precision .986, sub-pixel (0, 0.125), 0 outlier blocks, and **one difference the diff image isolates: the original draws a small metal object (the pawn's pistol, below) at the
pawn's right hand and Play draws nothing** ([Divergence 21](#divergences-found)).

**Not covered.** A moving camera (the held tick's pose is compared; a view that follows a walking pawn is the same code but was not run), pawns that fight or are shot while close, and the
Underworld's dancers from close (its start view renders them at a distance).

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
DX_HYPRLAND=1 scripts/live-original.sh <map> --ticks 600 --delta 0.0166666675 --shot name --tag name     # a frame, its trace and the held Strobe state apart
node scripts/live-acceptance.mjs play --map <map> --seed 1 --tag name --shot name                       # Play's frame takes that Strobe state (--own-strobe: its own)
node scripts/live-acceptance.mjs compare --map <map> --tag name                                         # clock, stream, Strobe flips, every field
node scripts/live-sweep.mjs run --maps a,b,c --ticks 1200 --max-seconds 300 [--allow-missing all]   # a sweep over maps (one original at a time)
node scripts/live-sweep.mjs report [--json .work/live-acceptance/sweep-2026-10-13.json]        # the table and the ranked groups
node scripts/live-sweep.mjs replay --from <tree>/.work/live-acceptance [--maps a,b] [--force]    # Play only: the stored originals of an earlier sweep replayed on the current code
# a camera that follows another actor, no actor moved (the same --early-cmds and --render-history on `original` and `play`; --shot for the frame):
DX_HYPRLAND=1 scripts/live-original.sh 10_Paris_Club --ticks 600 --delta 0.0166666675 --monitor 20 --shot cv --tag cv --early-cmds "CheatView DeusEx.Female4|set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=49152,Roll=0)"
node scripts/live-acceptance.mjs play --map 10_Paris_Club --seed 1 --tag cv --shot cv --early-cmds "<the same>" [--render-history]
node scripts/live-acceptance.mjs snap --map <map> --exec "CheatView ...|set ..." --run-frames 120 --name v.png        # a Play frame of such a view (to choose it)
node scripts/live-acceptance.mjs read --map <map> --names A,B --props P,Q [--run-frames N] [--offsets]            # what Play holds (or the linked offsets for dump-actor-win.exe)
node scripts/live-acceptance.mjs script --map <map> --expr-file probe.js        # an async expression the page evaluates after 30 frames (window.deusExViewer.lodProbe({list: 'weapons'}) lists the pawns' weapons)
node scripts/live-acceptance.mjs snap --map <map> --exec "..." --brightness 1.0 [--after-file probe.js]   # snap's brightness and a probe run before the shot
# the original's third-person weapon draw, event by event (DX_POST runs it with the level up; docs/weapon-attachment.md), then the cases the validator compares:
wine ad/build/dx-live-win.exe weapon 8 > .work/weapon/log.jsonl && node scripts/weapon-original-cases.mjs .work/weapon/log.jsonl --cases .work/weapon/original-cases.json
DX_POST=script.sh scripts/live-original.sh <map> ...                                                              # a script run with the original still up (dump-actor-win.exe on its actors)
node scripts/live-draw-shift.mjs --map <map> --tag <tag>        # the first pawn whose StartUp Sleep draw has another stream index in Play (needs LatF in the trace)
node scripts/live-draw-attr.mjs --map <map> --tag <tag> [--actor mib1]   # tick 1's draws per actor and call site (original --actor-trace 1:1 and the CRT call breakpoints)
# a pick-by-pick comparison (the pick calls config: docs/script-pawn-nav.md): the original with --extra-config pick.cfg, Play with --nav-trace A,B --nav-ticks 1:150, then
node scripts/live-pick-compare.mjs --map <map> --tag <tag> [--pawn A] [--verbose]        # each MoveActor/FarMoveActor of each pick, the destination
scripts/live-original.sh <map> ... --rng-from .work/live-acceptance/<map>/original-trace-<tag>.jsonl --tag T   # the original draws that capture's stream (its rngIn): the same decisions in a fresh load, to trace them
scripts/live-original.sh <map> ... --dump-flags          # the player's FlagBase at the frozen start and the end hold (flags-start<tag>.txt, flags-end<tag>.txt)
node scripts/live-acceptance.mjs play ... [--keep-traveling] [--page-params 'pawnPhysics=js&walkLoopKernel=js&movePawnKernel=js'] # Play keeps its PlayerTraveling marker / runs the JavaScript twins (the walk trace of --nav-trace pawns)
```

```bash
# matched-camera views with the Strobe flag held (Divergence 19); the original under the Wine lock (scripts/original-views.sh), then Play with the same --view options
scripts/original-views.sh 06_HongKong_WanChai_Underworld --view d_s0:-1120,-1900,-336:0,55000,0 --view d_s1:-1120,-1900,-336:0,55000,0 [--strobe-poll] [--unfreeze]
node scripts/visual-acceptance.mjs play --maps 06_HongKong_WanChai_Underworld --view d_s0:-1120,-1900,-336:0,55000,0 --view d_s1:-1120,-1900,-336:0,55000,0 [--unfreeze]
node scripts/visual-acceptance.mjs compare --maps 06_HongKong_WanChai_Underworld --view d_s0:-1120,-1900,-336:0,55000,0 [--crop 490x520+340+170]
wine ad/build/dx-live-win.exe strobe poll 120 5 | strobe hold 0 | strobe release      # the running original's Strobe flag (free-running, held at a value, released)
wine ad/build/dx-live-win.exe strobe poll 1 0 <LevelInfo hex>                          # the same and the level's TimeSeconds, read through the LevelInfo's address
# gate row 4.2.30: both states at two cameras, each frame with its own clock and hold record (#06_hongkong_wanchai_underworlds-mirrored-panes-at-a-held-strobe-row-4230)
scripts/original-views.sh 06_HongKong_WanChai_Underworld --brightness 0.666667 --view uw_s0:-1081,-2010,-336:0,54769,0 --view uw_s1:-1081,-2010,-336:0,54769,0 --view uwd_s0:-1120,-1900,-336:0,55000,0 --view uwd_s1:-1120,-1900,-336:0,55000,0 --cmd 'set ScriptedPawn bHidden True' --cmd-check 'Hooker0 bHidden:0x28:bit:0x2 1' --strobe-poll
```

```bash
# the club's floor in the mirror with no pawn mesh lit by the strobe, on both sides; the polls and a debugger probe of the original at each camera
scripts/original-views.sh 06_HongKong_WanChai_Underworld --view c0_s0:-1081,-2010,-336:0,54769,0 --view c0_s1:-1081,-2010,-336:0,54769,0 --cmd 'set ScriptedPawn bHidden True' --strobe-poll --cw-probe
node scripts/visual-acceptance.mjs play --maps 06_HongKong_WanChai_Underworld --view c0_s0:-1081,-2010,-336:0,54769,0 --view c0_s1:-1081,-2010,-336:0,54769,0 --cmd 'set ScriptedPawn bHidden True'
node scripts/validate-strobe-child-frames-play.mjs                                 # Play's side: the reach, the cadence, the failing baseline
scripts/original-fpu.sh 01_NYC_UNATCOIsland 170                                    # the original's control word at start-up and the pass's entry points (start-up scene), and its light-manager tables (.work/fpu)
scripts/original-views.sh 04_NYC_Street --view street1:-264,-256,-452:-343,32616,0 --cw-probe --cw-probe-early   # the loaded map's pass functions and static light bodies at a camera
node scripts/validate-original-light-tables.mjs                                    # those tables against Play's builders
```

`live-original.sh` takes the Wine lock (`.work/wine-deusex.lock`), refuses to start with another DeusEx.exe running and quits the game by
its PID; Play runs headless Chromium in worker mode.

## Security cameras (2026-10-14)

The security computers' camera views ([ViewportWindow](script-window-viewport.md)) matched against the original's
own frames: the same map, camera actors, camera rotations, level time and player pose, in the same 1280 x 720 screen.
Five computers on five maps, thirteen camera windows of 200 x 150 pixels.

### Method

`scripts/camera-original.sh <map> --computer C --user U --password P --cameras A,B,C --name n` (under the Wine lock) drives
the original through the terminal's real path and `scripts/camera-acceptance.mjs play ...` does the same in Play; `compare`
measures each window.

1. **The route.** The map is opened from the console; `ghost` lets JC fly through the walls in a straight line to the point
   56 units in front of the computer (aim with `ViewRotation`, hold W, measure, repeat); `walk` puts him on the floor with his
   collision; `ViewRotation` aims at the computer; the right click frobs it (`Computers.Frob`, state On: Activate,
   `FinishAnim`, `TryInvoke`, `InvokeComputerScreen`); the login is typed (`type`, Tab, Enter). No `set Location`: the level
   ticks ([Placement constraint](#placement-constraint)). `set DeusEx.JCDentonMale ReducedDamageType All` stops the
   turrets and guards of an enemy's rooms (Island's holding cell) from killing him; Play's run sets the same.
2. **Held keys.** `dxinput`'s posted `WM_KEYDOWN` does not hold a key in this game (the note under
   [Placement constraint](#placement-constraint): W and Up did not move a ghost), though the window had the Wine focus; WinDrv
   imports `GetKeyState`, which a posted message does not update, and a key sent through the input queue does. `shold <key> <ms>` sends it through the Wine input queue (`keybd_event`), and the ghost
   flies at about 800 units/s. The window must be floating, 1280 x 720 and the one Wine gives the input (`focus`).
3. **The screenshot under a modal screen.** `XModalWindow::VisibilityChanged` grabs every keyboard key and mouse button
   (`XRootWindow::Process` returns 1 for them), so no binding (`*`, a mouse button) reaches `Shot`. The root window's own
   `DeusExRootWindow.VirtualKeyPressed` calls `ConsoleCommand("SHOT")` for Print Screen (key 44) and Ctrl+F9, and that key does
   get through (`key PRINT`).
4. **Holding the level.** The tracer (`tools/dx-live-win.c`, `release 1`, `max-seconds 8`) returns from `ULevel::Tick` eight
   seconds after the frob, with the terminal's screen open and the camera views drawing: the camera actors, the clock and the
   lights stand, the UI goes on. Its last row and `dump-actor-win` give the state: `LevelInfo.TimeSeconds`, each camera actor's
   Location and Rotation, JC's Location, Rotation, ViewRotation and animation fields (sequence, frame, blend arrays).
5. **Play.** The same route (`terminalProbe` puts JC in front of the computer; the page's right click frobs it; the login is
   typed), `viewProbe`'s dilation steps run the level to the original's TimeSeconds (a few milliseconds of difference: Play's
   frames run ahead of its reads, so each speed stops short of the target), and the level is held (bPlayersOnly, TimeDilation
   0.001). The cameras and JC then stand where the original's were (`terminalProbe` `placeCamera` and `playerPose`; his
   animation frame is written with a rate of 0, because his own ticks follow the page's frames, not the level's dilation).
   Play's canvas multisampling is off (`?antialias=0`, below).
6. **Brightness.** The ini's default, 0.6, is not the framebuffer: Shot bakes a ramp of its own into the bitmap. Against the
   compositor's capture of the window (`grim`, with the window made opaque), a Shot at Brightness b is the framebuffer to the
   power 1/k with k = 0.77, 0.88, 1.02, 1.18 at b = 0.5, 0.6, 0.7, 0.8 (about 1.5 b), and at b = 2/3 it is the framebuffer
   (0.08% of the pixels differ, the moving ones; in a bright outdoor view every Shot value from 0 to 255 maps to itself). So a Shot at 0.6 is the framebuffer to the 1.11, darker than Play's raw
   colours by the "uniform gap" listed under Open, and a Shot at 0.8 brighter. The capture sets
   `set WinDrv.WindowsClient Brightness 0.666667` in the original (Play's ramp is untouched, and the page is captured at its
   identity ramp as before): the windows' mean values then agree to 1% (the ratio column below), where the earlier frames at
   0.6 were 1.13 to 1.41 apart.

### Result

Mean absolute difference over 0..255 (MAD), and the share of the original's Sobel edges Play has within 2 pixels (recall) and
the converse (precision), per window; `ratio` is Play's mean over the original's. Captures and montages in
`.work/acceptance/<map>/<name>-*` (outside Git): `-original.png`, `-<variant>.png` (Play), `-w<k>-<variant>-montage.png`
(original, Play, difference x6, enlarged 3x), `-state.json` (the original's measured state), `-<variant>.json`.

| Map, computer (cameras; level time original / Play) | step | MAD, windows 1 / 2 / 3 | edge recall | edge precision |
| --- | --- | ---: | ---: | ---: |
| 14_OceanLab_Lab ComputerSecurity1 (SecurityCamera0, 4, 3: URV Bay, Crew Module, Greasel Lab; 135.612 / 135.617) | master | 0.26 / 1.58 / 0.62 | .966 / 1 / .997 | .962 / 1 / .999 |
| | no multisampling | 0.11 / 0.86 / 0.46 | .968 / 1 / .998 | .968 / 1 / .999 |
| | sampling state | 0.19 / 1.13 / 0.32 | .987 / 1 / .999 | .999 / 1 / .995 |
| | sampling state and no multisampling | 0.04 / 0.31 / 0.15 | .987 / 1 / 1 | .995 / 1 / 1 |
| | + display-space filtering | **0.00 / 0.15 / 0.02** | .989 / 1 / .999 | .994 / 1 / .998 |
| 02_NYC_BatteryPark ComputerSecurity2 (SecurityCamera1, 2, 0: Storage Warehouse, Tunnel Bridge, Boathouse Approach; 229.006 / 229.011) | master | 0.62 / 0.21 / 0.85 | .981 / .990 / .955 | .981 / .992 / .988 |
| | no multisampling | 0.52 / 0.16 / 0.65 | .978 / .986 / .954 | .981 / .991 / .984 |
| | sampling state | 0.26 / 0.14 / 0.41 | .998 / .997 / .999 | .991 / .988 / .999 |
| | sampling state and no multisampling | 0.15 / 0.08 / 0.19 | .999 / .999 / 1 | .995 / .992 / 1 |
| | + display-space filtering | **0.00 / 0.09 / 0.01** | 1 / .997 / 1 | 1 / .997 / 1 |
| 01_NYC_UNATCOIsland ComputerSecurity1 (SecurityCamera5, JC in view; 252.714 / 252.717), the terrorists' region masked (x 2 to 69, y 50 to 93 of the window) | master | 0.35 | .946 | .959 |
| | no multisampling | 0.45 | .939 | .936 |
| | sampling state | 0.12 | .992 | .985 |
| | sampling state and no multisampling | 0.07 | .992 | .994 |
| | + display-space filtering | **0.01** | .998 | 1 |
| 06_HongKong_WanChai_Market ComputerSecurity0 (SecurityCamera2, 0, 1: Market lane 1, 2, 3; 175.209 / 175.223) | master | 1.54 / 1.86 / 0.63 | .989 / .990 / .984 | .997 / 1 / .991 |
| | no multisampling | 1.07 / 1.54 / 0.37 | .993 / .990 / .984 | .988 / .999 / .987 |
| | sampling state | 0.95 / 1.09 / 0.42 | .995 / .996 / .991 | .998 / 1 / .997 |
| | sampling state and no multisampling | 0.37 / 0.66 / 0.14 | .997 / .997 / .999 | .997 / .999 / .997 |
| | + display-space filtering | **0.04 / 0.20 / 0.01** | 1 / .997 / 1 | 1 / 1 / .999 |
| 09_NYC_Ship ComputerSecurity3 (SecurityCamera1, 19, 18: Entry Area, Locker Room, Break Room; 231.290 / 231.304) | master | 0.70 / 4.71 / 0.37 | .956 / .692 / .955 | .993 / .517 / .914 |
| | no multisampling | 0.53 / 5.11 / 0.23 | .951 / .615 / .966 | .995 / .514 / .976 |
| | sampling state | 0.36 / 4.51 / 0.15 | .999 / .732 / .999 | .995 / .537 / .971 |
| | sampling state and no multisampling | 0.17 / 4.39 / 0.03 | .997 / .711 / .999 | .996 / .525 / 1 |
| | + display-space filtering | **0.05** / 4.35 / 0.11 | .999 / .710 / .984 | 1 / .527 / .950 |

With the sampling state and no multisampling 91 to 93% of the OceanLab windows' pixels are identical to the original's (Battery Park: 75 to
83%) and 98 to 99.9% of the pixels of both maps differ by at most 2 of 255; with the display-space filtering as well 98.9 to 99.8% of
OceanLab's are identical and 89.5 to 99.3% of Battery Park's (the rest of window 2 is two walking actors). Of each OceanLab window's 30,000
pixels 3, 287 and 116 differ by more than 10 without it (3, 171 and 15 with it); Battery Park's largest differences are 12, 7 and 23 (48, 42 and 17). The windows' mean values agree to 0.2 to 1.3%. The Island window with
three NSF terrorists in it (Terrorist2, 18 and 30: they walk and animate differently in the two programs, [live scenes](#live-scenes-2026-10-13)) is 0.64 to 0.74 MAD and
edge recall .77 to .81 unmasked; JC himself (mesh, lighting from the camera's frame, his shadow decal) agrees in the 24 x 32 pixels
around him (MAD 0.14, recall .949, precision 1.0). The level times agree to 5 ms.

The same variants on the stored main-frame views (`visual-acceptance.mjs play`, 4 maps x 5 views, the original's frames at the
ini's default brightness, so MAD carries the Shot ramp above): master MAD 2.098, edge recall .9726, precision .9197; sampling
state 1.913, .9803, .9206; sampling state and no multisampling 1.922, .9837, .9186 (OceanLab_Lab 3.07 to 2.33, Island's recall
.978 to .992, Battery Park's .974 to .987; the Club's precision .75 is as before).

Ship's window 2 (the locker room) differs by a door: a `DeusExMover` stands half open in the original and not in Play (a mover's state
in a live level, like the actors' positions; it is the 4.4 in the table, and the other two windows are the renderer). Hong Kong's
three windows hold the market's signs and neon, Ship's window 1 the entry's potted plants (actor meshes with masked skins).

**Ship window 2, recaptured 2026-10-16 (tag `sh3b`, level time 132.264 s).** The door is not a Play mover defect: `camera-acceptance.mjs original` now reads the level's
pre-placed movers at the hold (Mover's linked offsets: Location 0x114, Rotation 0x120, Physics 0x30, bInterpolating 0x1ec bit 0x80, PhysAlpha 0x214, PhysRate 0x218, KeyNum
0x377, PrevKeyNum 0x378, NumKeys 0x379; `dump-actor-win.exe DeusExMover ...`, 69 movers into `sh3b-state.json`). Three stand open and at rest (`DeusExMover39`, `40` and `65`: `KeyNum`
1, `PrevKeyNum` 1, `bInterpolating` 0, `PhysAlpha` 0), the other 66 are at 0; in Play at the same level time all 69 are closed (Play's own NPCs did not open them). The three are
`TriggerToggle` doors without a designer Tag, so no trigger of the map moves them; `RunningTo.HitWall` calls `CheckOpenDoor`, the way a pawn on its route frobs a door (the first
capture, at 231.289 s, showed a door standing open in this window). Who opened them in the original was not measured. Play now writes the original's Rotation and
Location of the movers that differ (`moverProbe set`, an input of the held state like the cameras' and the player's poses; `--movers off` skips it):

| window 2 | mean abs. diff. | edge recall | edge precision |
| --- | ---: | ---: | ---: |
| `sh3b`, Play's own movers | 4.23 | .788 | .695 |
| `sh3b`, the original's mover poses written | 1.13 | .918 | .794 |

(The other two windows: 0.05 and 0.28 mean abs. difference.) What stays in window 2, and keeps 4.2.28 red: a red-uniformed NPC in the doorway in Play and not in the original (the
moving actors are not matched, as before), and the back wall's locker doors drawn lighter in Play (the five movers in front of it, `DeusExMover8`, `19`, `21`, `23` and `37`, are at key 0
in both). Neither was examined further.

### Main views at Brightness 2/3

The 20 stored main views (4 maps x 5) were retaken in the original at Brightness 2/3 (`scripts/original-views-b.sh ...
--brightness 0.666667`, Shot == framebuffer) and compared with Play at the same held times, canvas multisampling off
(`play --query antialias=0`, with the sampling variants below), per view and over the 20:

| Play | mean luminance, Play / original | per view | mean absolute difference |
| --- | ---: | --- | ---: |
| master (`?sampling=legacy`) | 0.9974 | 0.80 to 1.05 | 0.347 |
| mip state (`?sampling=srgb`) | 1.0119 | 0.80 to 1.08 | 0.285 |
| mip state and display-space filtering (the default) | 1.0026 | 0.975 to 1.032, 17 of 20 at 1.000 | 0.065 |

Per view (mean of the three channels over 0..255, Play's mean over the original's in brackets, and the mean absolute difference from the
original's frame; each row is one noise state of the view's animated lights, and a view with such lights reads differently in another state:
[The darkest pixels](#the-darkest-pixels-2026-10-15-not-a-rounding-difference)):

| map, view | original mean | master: mean (ratio) MAD | mip state: mean (ratio) MAD | mip state and display-space filtering: mean (ratio) MAD |
| --- | ---: | ---: | ---: | ---: |
| 14_OceanLab_Lab down | 9.138 | 8.565 (0.937) 0.667 | 9.558 (1.046) 0.450 | 9.431 (1.032) 0.311 |
| 14_OceanLab_Lab y0 | 8.882 | 7.135 (0.803) 1.791 | 7.137 (0.804) 1.770 | 8.663 (0.975) 0.253 |
| 14_OceanLab_Lab y1 | 13.526 | 12.994 (0.961) 0.922 | 13.735 (1.015) 0.240 | 13.842 (1.023) 0.323 |
| 14_OceanLab_Lab y2 | 4.747 | 4.766 (1.004) 0.026 | 4.767 (1.004) 0.021 | 4.747 (1.000) 0.001 |
| 14_OceanLab_Lab y3 | 14.042 | 14.682 (1.046) 0.640 | 15.091 (1.075) 1.049 | 14.042 (1.000) 0.000 |
| 01_NYC_UNATCOIsland down | 12.316 | 12.669 (1.029) 0.484 | 12.680 (1.030) 0.371 | 12.316 (1.000) 0.008 |
| 01_NYC_UNATCOIsland y0 | 9.109 | 9.412 (1.033) 0.466 | 9.423 (1.034) 0.358 | 9.109 (1.000) 0.077 |
| 01_NYC_UNATCOIsland y1 | 5.089 | 5.153 (1.013) 0.140 | 5.159 (1.014) 0.118 | 5.089 (1.000) 0.054 |
| 01_NYC_UNATCOIsland y2 | 5.457 | 5.636 (1.033) 0.233 | 5.633 (1.032) 0.202 | 5.461 (1.001) 0.033 |
| 01_NYC_UNATCOIsland y3 | 5.564 | 5.651 (1.016) 0.202 | 5.661 (1.017) 0.137 | 5.564 (1.000) 0.043 |
| 10_Paris_Club down | 5.540 | 5.550 (1.002) 0.013 | 5.550 (1.002) 0.012 | 5.540 (1.000) 0.000 |
| 10_Paris_Club y0 | 5.917 | 5.960 (1.007) 0.063 | 5.962 (1.008) 0.047 | 5.917 (1.000) 0.000 |
| 10_Paris_Club y1 | 3.003 | 3.014 (1.004) 0.012 | 3.014 (1.004) 0.012 | 3.003 (1.000) 0.000 |
| 10_Paris_Club y2 | 3.857 | 3.865 (1.002) 0.012 | 3.866 (1.002) 0.009 | 3.857 (1.000) 0.000 |
| 10_Paris_Club y3 | 3.416 | 3.429 (1.004) 0.013 | 3.429 (1.004) 0.013 | 3.416 (1.000) 0.000 |
| 02_NYC_BatteryPark down | 16.774 | 16.951 (1.011) 0.472 | 16.959 (1.011) 0.291 | 16.773 (1.000) 0.121 |
| 02_NYC_BatteryPark y0 | 7.884 | 7.981 (1.012) 0.307 | 7.983 (1.012) 0.139 | 7.881 (1.000) 0.046 |
| 02_NYC_BatteryPark y1 | 10.212 | 10.506 (1.029) 0.312 | 10.505 (1.029) 0.302 | 10.214 (1.000) 0.014 |
| 02_NYC_BatteryPark y2 | 4.126 | 4.246 (1.029) 0.124 | 4.246 (1.029) 0.124 | 4.126 (1.000) 0.007 |
| 02_NYC_BatteryPark y3 | 1.964 | 2.000 (1.018) 0.038 | 2.000 (1.018) 0.037 | 1.964 (1.000) 0.005 |

Master's overall brightness is right on average because its per-view errors cancel (OceanLab's y0 is 20% dark, y3 5% bright; the
per-view brightness error averages 3.0% and falls to 0.4% with the colour-space change; Paris Club's five views have a mean absolute difference of 0.000
with it). The mip state alone brightens Play by about 1% (a finer level than trilinear gave, filtered in linear light); the display-space
change (cause 3) removes that and the per-view errors.

### Causes

1. **Texture sampling.** The window's pixels are minified several times more than the main view's, so the mip choice shows.
   Play sampled world, actor and decal textures trilinear with no bias; D3DDrv's stage setup (`0x10009e20`) is LINEAR magnification
   and minification, MIPFILTER POINT (`UseTrilinear=False`) and a LOD bias of -0.5, and POINT filters for PF_NoSmooth. A bias scan
   of the three OceanLab windows (-1, -0.5, -0.25, 0 on the batched world shader) has its minimum at -0.5 (MAD 0.04 / 0.31 / 0.16
   against 0.21 / 0.88 / 0.37, 0.07 / 0.60 / 0.31 and 0.10 / 0.92 / 0.44). Fixed in `src/viewer/original-sampling.mjs`;
   evidence, addresses and validator in [texture sampling](texture-sampling.md).
2. **Multisampling.** `main.mjs` makes the canvas multisampled (`antialias: true`); the original's Direct3D 7 device has none. In
   a camera window every polygon edge and every sub-4-pixel mesh took partial coverage: the OceanLab window's four small bright
   dots (the camera frame has no sprites, decals or coronas there; its actors are a crate and four fish at that distance) are
   3 x 3 pixels of one value in the original (220, 219, 214 / 225, 216, 215 / 220, 220, 213) and came out as 25%-step coverage
   patterns in Play (61, 166, 112 / 114, 218, 112 / 63, 114, 61); with multisampling off they are 218, 218, 215 / 219, 218, 215
   / 222, 220, 215. `?antialias=0` turns it off (the comparison uses it; the default is unchanged). The main frames' metrics
   move little (above) because their edges are a smaller share of the pixels.
3. **Filtering space.** Play uploads base textures as sRGB, so the GPU filters them in linear light and the shaders
   re-encode; Direct3D 7 blends the 8-bit display-space values (a mix of black and white is 127, where Play gave 188). With the mip state
   it removes most of the residual below (Hong Kong 0.37 / 0.66 / 0.14 to 0.04 / 0.20 / 0.01; OceanLab to 0.00 / 0.15 / 0.02, 99% of its
   pixels identical; Battery Park 0.00 / 0.09 / 0.01; Island 0.01 with the moving actors masked; Ship window 3 gets worse, 0.03 to 0.11) and
   brings the main views' mean luminance to the original's (table above). It is Play's default now (`?sampling=srgb` keeps the sRGB
   upload and re-encode for A/B, `?sampling=legacy` is the earlier sampling entirely); it moved Play's mean luminance by 2.9% on the 20 views,
   toward the original's, and the user approved it.
4. **Not causes.** The window frames' projection (Coords-posed camera, the device's depth range) already matches: drawing them
   through the exact vertex chain of [frame projection](frame-projection.md) (`fpClip` with the window's frame) changed 0 to 2 pixels
   of 30,000 per window and the same MAD, with multisampling on and off. A sub-pixel shift of Play's frame: the best shift over
   ±1.5 pixels is (0, 0) in every window but one (0.125 pixel, 2.6% of its error).

### What stays

- Blended texels' colour (Hong Kong's signs, OceanLab window 2's light strips, window 3's ceiling panel): a strip's leading edge pixel is
  62 / 133 in the original and 32 / 168 in Play, mid-tone pixels up to 5% brighter. The vertex positions and the mip level are not the
  cause (the chain and the bias scan); the filtering space is (cause 3: with it the same pixels are equal
  except one per strip edge, a polygon-edge tie).
- Moving actors: the Island view's terrorists (positions, animation) differ as in every live scene; static props, JC, the
  turret and the decals agree.
- Cameras with mirrors, a sky frame, fog or coronas in their view were not among the seven windows (the three maps' cameras
  look into rooms; but see the [camera view census](camera-view-census.md), 2026-10-16: by Play's fog rule the Ship's windows 1 and 2, captured later, hold volumetric fog, not judged for it): those parts of the camera frame stay checked against the original's code and oracles only
  ([viewport window](script-window-viewport.md)), not against captured frames.
- A modal screen leaves no key for bindings and the held level needs the tracer; maps whose computer cannot be reached by the
  flight (a stalled game) fail with a message, not silently.

### Running it

```bash
DX_HYPRLAND=1 scripts/camera-original.sh 14_OceanLab_Lab --computer ComputerSecurity1 --user Oceanguard --password Kraken \
  --cameras SecurityCamera0,SecurityCamera4,SecurityCamera3 --name cs1                 # the original: frame and state
node scripts/camera-acceptance.mjs play --map 14_OceanLab_Lab --computer ComputerSecurity1 --user Oceanguard --password Kraken \
  --camera-actor SecurityCamera0 --name cs1 --suffix aaoff                              # Play at that state (--antialias on, --query sampling=trilinear for A/B)
node scripts/camera-acceptance.mjs compare --map 14_OceanLab_Lab --name cs1 --suffix aaoff    # the windows' metrics and montages
```

## Interface frames (2026-10-15)

The HUD, the persona screens, the main menu and three Settings screens, a datacube's information display and the keypad of 00_Training, 18 views taken in
the original under Wine and in Play with the same inputs (a console line, a key, a click, a wait) at one held level time, Brightness 2/3 in the original and
Play's matched ramp, compared pixel for pixel: every frame is within 2 of 255 of the original's except one scanline of the world (57 pixels, up to 27 levels) and 90
scattered pixels of at most 13 levels in the datacube frame. Two divergences were found and fixed (the GC's authored underline texture, so the accelerator letters
of the buttons are underlined; the window system's real-time tick, so the HUD log's timeout runs while the level is held); one difference of the pointer input is open
(a stationary cursor over a screen that replaced another). The four security terminals' screens above (outside their camera windows) are pixel-equal too:
0 of 831,600 pixels differ in each of the stored frames. The recipe, the scenario, the numbers before and after each fix and the causes with their evidence are in
[interface frames](interface-frames.md); the Stage 4 gate's rows 4.4.11 to 4.4.14 run them (`validate-stage4-acceptance.mjs --only '^4\.4\.1[1-4]$'`).

```bash
scripts/original-run.sh 00_Training node scripts/interface-acceptance.mjs original     # the original's frames and their level times (Wine lock)
node scripts/interface-acceptance.mjs play && node scripts/interface-acceptance.mjs compare
```

## Conversation frames (2026-10-16)

Third-person conversation frames of the original against Play's: `01_NYC_UNATCOIsland`'s MeetPaul at four held ticks (the first shot, a speaker change on the same camera, and two
cuts), the level frozen at the load and released by the tracer at the original's own per-tick delta and stream state ([Live scenes](#live-scenes-2026-10-13)), the player
placed 100 units in front of Paul, 1280x720, Brightness 2/3 in the original and Play's matched ramp, `?antialias=0&detailTextures=0`. The scene, why the frame is taken with Ctrl+F9,
the timeline of the speeches and the causes with their evidence are in [conversation camera](conversation-camera.md#frames-against-the-original-2026-10-16).

Each row is one frame, 921,600 pixels: the share identical (all channels), the pixels off by more than 2 and by more than 10 of 255 in any channel, the mean absolute difference over the band
the 3D view draws in (rows 73 to 569; the frame's is 0.02 to 0.05) and the edge recall and precision of `compare`. **The two letterbox bars (73 rows above, 150 below) and the subtitle line are
identical to the pixel in every frame** (0 of 93,440 / about 185,000 / 4,245 to 10,848 pixels differ, maximum difference 0).

| Frame | tick, speech | before the harness fix: identical, >2, >10, band MAD, recall/precision | after the fix, no mouth feed: identical, >2, >10, recall/precision | after the fix and the measured mouths (the second capture, `cvA`): identical, >2, >10, band MAD, recall/precision |
| --- | --- | --- | --- | --- |
| 1 | 100, JC, camera 2 | not taken in that capture | .98698, 1,968, 478, 1/1 | .98698, 1,968, 478, .031, 1/1 |
| 2 | 250, Paul, camera 2 | .33302, 349,313, 48,197, 4.41, .581/.617 | .98695, 1,993, 494, .999/1 | .98695, 1,991, 497, .032, .999/1 |
| 3 | 600, JC, camera 4 (cut) | .42830, 327,108, 78,450, 5.34, .559/.606 | .97000, 4,073, 976, .997/.999 | .97076, 3,362, 698, .058, .997/.999 |
| 4 | 750, Paul, camera 5 (cut) | not taken before the fix | .96725, 4,283, 1,283, 1/1 | .96789, 3,769, 1,053, .072, 1/1 |

The columns "before" and "after the fix, no feed" are the first capture (`cv`, one original load); the last column is a second original load (`cvA`) with the player's mouth channel in the trace, so it is also a
repeat of the original: frames 1 and 2 agree with the first capture's to within 3 pixels (the original's frames are reproducible from load to load). Remaining differences, zoomed ten times: one-pixel
lines along silhouettes and mesh triangle edges (the polygon edge tie of two rasterizers) and the glint of the glasses, nothing in the shading or the textures. What was measured, besides the frames:
the camera object read from the running original equals Play's `conversationProbe` bit for bit (location, rotation, position, actors, heights); the live comparison of the 750 ticks (`live-acceptance.mjs
compare --tag cvA`) reads clock equal, stream draws per tick equal, and every watched actor but three equal in every watched field for the 750 ticks (88 actors: the pawns, the generators and the timed actors; Paul's blend channel included);
the three are two guards' `LastRenderTime` at tick 1 (the render history) and the player's `AnimFrame` at the first ticks.

**The intro (`00_Intro`, 2026-10-16, gate row 4.5.7).** The same comparison for the intro's three held frames (the original's Ctrl+F9 frames, tag `in2`, the whole frame is the 3D view at 1280x720: no bars, no subtitle), after the `FindBase` fix
([conversation camera](conversation-camera.md#the-intro-against-the-original-2026-10-16-gate-row-457)), with the measured mouth letters and the player standing as the original's:

| Frame | tick | identical, >2, >10 (band = whole frame), over 10 off the edges, recall/precision |
| --- | --- | --- |
| in1 | 170 | .98333, 4,925, 2,933; 21; .999/1 |
| in3 | 1,000 | .95588, 6,346, 3,775; 31; .999/1 |
| in4 | 2,250 | .95128, 5,037, 1,001; 63; .999/.999 |

"Off the edges" is `conversation-acceptance.mjs compare`'s `awayFromEdges`: the pixels off by more than 10 of 255 that are farther than 1 px from every hard step (a step of more than 24 of 255 to a right, lower or diagonal neighbour, in either frame). Of the 2,933 and 3,775 pixels over 10,
99% lie on an edge (silhouettes, mesh triangle edges, brush edges: the count follows the edges' length, so the gate judges the pixels away from them); the rest are at most 63 per frame, off by at most 23 (MeetPaul's four: 15 to 37, at most 23). The live comparison
of the replay (`live-acceptance.mjs compare --tag in2`) reads all 82 watched actors, the clock and the stream draws equal for 2,250 ticks.

**MeetManderley (`01_NYC_UNATCOHQ`, 2026-10-16, gate row 4.5.8).** Four held frames of two loads of the original (tags `mmA`, `mmB`) against Play's replays, as MeetPaul: the two bars and the subtitle identical to the pixel in all four, no outlier block
([conversation camera](conversation-camera.md#meetmanderley-against-the-original-2026-10-16-gate-row-458)).

| Frame | load, tick, speech | identical, >2, >10 (band), over 10 off the edges, recall/precision |
| --- | --- | --- |
| mm2 | mmA, 450, 234 Manderley (the fallback camera) | .95527, 7,239, 1,926; 94; .999/.999 |
| mm3 | mmA, 700, 238 Manderley (camera 4) | .96407, 5,131, 1,893; 81; .999/1 |
| mmB2 | mmB, 300, 234 Manderley (the fallback camera) | .95542, 7,158, 1,848; 90; .999/1 |
| mmB3 | mmB, 580, 235 JC (the fallback camera) | .95202, 8,216, 2,375; 91; .999/1 |

The live comparison reads all 22 watched actors, the clock and the stream draws equal for the replayed ticks (700 and 580; 1,100 in an earlier full replay of `mmA`), apart from the player's `AnimFrame` at tick 1.

```bash
# the original (Wine lock): all frames of one run, one trace; each frame is a held tick (--cmds N:@ctrlshot name, the last --shot name --shot-ctrl), Brightness 2/3 in the early commands
DX_HYPRLAND=1 scripts/live-original.sh 01_NYC_UNATCOIsland --ticks 750 --delta 0.0166666675 --monitor 20 --tag cvA --player-blend --shot cvA4 --shot-ctrl \
  --cmds "100:@ctrlshot cvA1|250:@ctrlshot cvA2|600:@ctrlshot cvA3" --early-cmds "set WinDrv.WindowsClient Brightness 0.666667|set DeusEx.JCDentonMale Location (X=-2385,Y=8393,Z=-256.2)|set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=51120,Roll=0)|walk"
node scripts/live-acceptance.mjs population --map 01_NYC_UNATCOIsland --seed 1               # Play's population, once
node scripts/conversation-acceptance.mjs phonemes --tag cvA                                  # the original's mouth letters from the trace
node scripts/live-acceptance.mjs play --map 01_NYC_UNATCOIsland --seed 1 --tag cvA --ticks 250 --shot cvA2 --player-blend --phonemes .work/live-acceptance/01_NYC_UNATCOIsland/phonemes-cvA.json \
  --early-cmds "<the same>"                                                                   # Play's frame at that tick (one replay per frame)
node scripts/conversation-acceptance.mjs compare --frames cvA1,cvA2,cvA3,cvA4                # per region and whole frame
node scripts/conversation-acceptance.mjs timeline [--scene meetpaul|intro|manderley]         # Play's own timeline: every state, event and camera change, with its tick
```

## Effect frames (2026-10-16)

Effects whose translation was compared with the DLLs but whose frame was not ([Stage 4 gate](stage-4-exit-criteria.md) rows 4.2.13 to 4.2.30,
`MISSING` at the first run), each one original capture session and a gate row. All are matched-camera frames of the [Method](#method) above: the original
under Wine at Brightness 0.4, level frozen and held at its own clock, Play at `?antialias=0&detailTextures=0` and that clock, raw 1280x720. What the
captures added to the tooling:

* **A frame keeps its own clock.** `visual-acceptance.mjs original` writes `<map>/<view>-time.txt` (the level time the clock was held at) beside each
  frame, and `play` runs to the time of the views it takes (`times.json`, one time per map overwritten by each capture, is only the fallback). The gate
  stages the `-time.txt` files with the frames and needs `times.json` only for frames that have none.
* **An effect's contribution.** A view named `<name>-base` is the original's frame without the effect: `original --base-cmd '<console command>'`
  takes the named views first, runs the command once in the same live level and held clock, then the `-base` views. `play --base fog|detail` writes
  Play's own frame without the effect (`<name>-play-base.png`: the fog pass hidden, or the detail pass). `compare --contribution` compares the two
  differences (frame less frame without it), the original's against Play's: the sum of Play's over the original's (to be read against the frame's
  own brightness ratio, the Wine gap this document does not judge), the Pearson correlation of the two luma differences, the mean absolute residual
  after the best scale and the share of the original's effect pixels (difference of at least one level) where Play's is at least a quarter of its
  scaled value.
* **The player's pose.** A mirror shows JC's mesh. Under `ghost` the player stays in the CheatFlying state and his `Tread` animation loops in real
  time even at a held level, so a mirror frame holds a frame of it nobody chose: `original --freeze-player` writes `AnimRate 0` before the shot,
  `--player-state` reads his animation fields into `<view>-state.json`, and `play --player-pose` writes them back (`AnimRate` 0, as the
  security-camera captures do). The phase of that loop at a shot is whatever the clock of each program gave it, so the pose is an input of the held state.
* **Stores.** The captures are in the main checkout's `.work/acceptance/<map>/` under new names; the gate reads them from there. (A checkout that
  holds its own captures is its own source: the gate used to unlink and relink a stored frame onto itself, deleting it; it skips a frame that is
  already in place.)

### 02_NYC_Bar's smoke haze (row 4.2.17)

Light90 (-1200, -57, 129; `VolumeRadius` 128, `VolumeBrightness` 32) and the bar's fog zones. Three cameras around it (`bar` in the gate),
original at level time 52.355 s. The original without the haze is the same level after `set ZoneInfo bFogZone False` (the zones' flag SetupForSurf
reads, the `+0x388 & 2` of [volumetric fog](volumetric-fog.md)). The haze is a few levels of 255 over most of a wall
(mean absolute difference of the two original frames 1.0 to 2.4 levels), so the frames alone say little: the contribution is what is compared.

| View | Play / original | Mean abs. diff. | Edge recall / precision | Outlier blocks | Haze: Play over original (sum) | correlation | residual | pixels with haze, Play's too |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| fog3 (-1200,-357,90 looking +y at the light) | 1.347 | 3.07 | .999 / .994 | 0 | 1.361 | .930 | .18 | 910,834 of 910,834 |
| fog5 (-1518,261,90 toward the doorway) | 1.340 | 2.74 | .997 / .990 | 0 | 1.394 | .928 | .22 | 895,773 of 895,773 |
| fog0 (-900,-57,90 looking -x) | 1.350 | 2.32 | .992 / .988 | 0 | 1.344 | .991 | .18 | 300,239 of 300,239 |

Play's haze is the original's times the frame's own gap (1.361, 1.394 and 1.344 against ratios 1.347, 1.340 and 1.350: within 1.0%, 4.0% and 0.4%), and
it correlates with the original's .93, .93 and .99. A control: the original's haze of one view against Play's haze of each of the three views
reads .93, .93 and .99 on the diagonal and -0.04 to .37 off it. The residual (.18 to .22 of the original's haze) has the surfaces' texture in it
(the original's two frames are two captures: the animated light maps' noise state is in their difference, and the 8-bit rounding of `dst * (1 - alpha)`);
Play's haze is smooth where the original's is not, and no region of the original's haze is missing from Play's. The gate row's thresholds
(correlation .90, gap within 8% of the frame's ratio, agreement .98) are set from these three views and are weak. Stored: `.work/acceptance/02_NYC_Bar/
{fog3,fog5,fog0}{,-base}-original.png` and their `-time.txt`.

### 02_NYC_Hotel's bathroom mirror (row 4.2.19)

The opaque unlit mirror over the sink, with JC in the reflection (`hotel` in the gate): `hotel1` at (1880, -1158, 148) level, `hotel2` the same place
looking 2,500 units down so the mirror fills the middle of the frame; original at level time 52.370 s, JC's `Tread` frozen at frame 0.2488.

| View | Play / original | Mean abs. diff. | Edge recall / precision | Outlier blocks |
| --- | ---: | ---: | ---: | ---: |
| hotel1 | 1.282 | 4.45 | .984 / .994 | 0 |
| hotel2 | 1.273 | 4.58 | .982 / .983 | 0 |

With the pose of Play's own `Tread` loop in place of the original's, the frame reads recall .970 and precision .974 in `hotel2` (his arms lower in the
original's first capture than in Play, a frame of the loop); with the pose measured and written they are the same frame. The mirror's tile floor, the
shelves, the door in the reflection and the sink agree to within the uniform gap (no outlier block). Stored: `.work/acceptance/02_NYC_Hotel/
{hotel1,hotel2}-original.png`, `-time.txt`, `-state.json`.

### 01_NYC_UNATCOIsland's doorway beams (row 4.2.24)

The five `LaserTrigger` beams across the doorway (`laser` in the gate), cameras (1920, -1069, -60) and (1850, -1000, -60) looking at the beams
(`laser1`, `laser2`), the level unfrozen at TimeDilation 0.001 (`--unfreeze`: a `LaserEmitter` adds its beams in `Tick`, so a frozen level has none)
and held at level time 52.363 s.

* **The random stream of a frame.** A `LaserIterator`'s last item sits at a random place along its beam: `CurrentItem` draws from the shared CRT stream
  while it runs inside `URender::SetupDynamics`, and the original's frames draw whatever the stream holds, so it is a host input of the frame like the
  Strobe flag. `tools/dx-live-win.c rngpin <seconds> <hex state>` breaks at SetupDynamics' entry (Render.dll `0x10b22d90`) and writes the CRT rand state
  (+0x14 of the game thread's msvcrt thread data) before each run (9,276 runs in a 94 s capture; the polled state reads the pinned value 38 of 40 times
  while it runs); `visual-acceptance.mjs original --rng-pin 0x2f6e2b1b` keeps it attached for the views. Play's side is the same state written at the start
  of each of its SetupDynamics runs (`viewProbe({rngPin})`, `sprite-scan.mjs` `pin`; `play --rng-pin`). The pin is arbitrary: both programs start
  from one state, so the items' own draws are the same.
* **What stays unmatched: the beam's texture.** `LaserBeam1` is a FireTexture. Its sparks come from a stream seeded by the process (the original) or by
  the host (Play, `procedural-textures.mjs`), and it ticks every frame, so the bright dashes of a beam differ from frame to frame **in the original
  itself**, pinned or not: `laser1` and a second capture of it (`laser1b`, the same run, a frame later) agree in where the beam is (coverage 1.0 of 120
  blocks, y-offset of the centroids .31 px rms, energy ratio .99, block-energy correlation .994) but not in the dashes. The comparison is therefore of
  the geometry, in 64 x 64 blocks of red excess (`R - max(G, B)`, Play's at the frame's own brightness ratio): where there is beam, how much, and where
  in the block (`visual-acceptance.mjs compare --beams`, `beamMetrics`; `beamsFloor` is the original against its own second frame).

| View | Play / original | Mean abs. diff. | Edge recall / precision | Outlier blocks | Beam blocks in both, of either | Beam energy Play / original | y-offset of the centroids (rms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| laser1 (four beams) | 1.283 | 4.83 | .944 / .931 | 0 | .942 (120 blocks) | .873 (1.007 in an earlier run) | 1.27 px (original against itself .31) |
| laser2 (one beam to the wall plate) | 1.294 | 4.17 | .981 / .965 | 0 | .877 (73 blocks) | .995 (.884 in an earlier run) | 1.63 px |

The beam's pixel overlap is not a usable measure: the same frames' red masks overlap at recall .62 and precision .51 (original against Play) and .77 (the
original's two frames against each other, Jaccard of the 5x5-blurred excess); the occupancy of the original against Play at a level of 3 reads .778
against .769 for the original against itself. A beam's vertical centroid per column (rows 236 to 254 of laser1, 497 columns) differs by -0.11 px on
average (rms .56 px) from Play's, and the original's two frames differ by .04 / .60 px and .01 / .73 px: Play's beam is where the original's is, to
what the original repeats of itself. The energy of Play's beams varies from run to run by the fire texture (laser1 .87 to 1.01, laser2 .88 to 1.0).

* **A third view shows what the frame cannot hold.** `laser3` (2000, -1150, -40) has an NPC standing in the doorway in the original at the held clock
  (the NPCs of an unfrozen level walk their own routes, each program's own) and Play does not: the beams end at his body, the block-energy ratio is
  1.86 and the y-offset 4.4 px. It is not in the gate; Play's beams there are the same beams without the actor in them.

The thresholds of the gate row (coverage at least .85, energy .75 to 1.33, y-offset at most 2.5 px) are set from these two views and are weak. Stored:
`.work/acceptance/01_NYC_UNATCOIsland/{laser1,laser2}-original.png`, `-time.txt` and `laser1b-original.png`.

### 04_NYC_Street's steam vents (row 4.2.13, `FAIL` on the steam's per-pixel agreement only)

The vent of `ParticleGenerator2` (614, 67, -507) in the alley, the camera 160 units back and 40 above it looking along +x and slightly up. The scene is a live one: the
original runs 600 ticks, the tracer recording each tick's delta and CRT rand state, and holds the level; Play replays the same ticks with the same delta and stream
state per tick (the generators' load-time draws are the measured host input, as in the other live pilots), then both draw the held frame. `--base-shot` takes the
frozen start's frame at the same camera before the first tick (`<name>-base-original.png`, Play's `<name>-play-base.png`): the steam is the held frame less that one.
A ghost placed with `set Location` in the frozen phase and released into a ticking level did not crash the original here (five runs; the earlier note was for
`set Location` plus `set Region`).

The recipe since 2026-10-16 (the Mac, CrossOver; after `node scripts/live-acceptance.mjs population --map 04_NYC_Street --seed 1`):
`scripts/live-original.sh 04_NYC_Street --ticks 600 --delta 0.0166666675 --shot vents4 --base-shot --extra-shots 3 --tag vents4 --render-history --actor-trace 1:60
--original-brightness 0.666667 --early-cmds 'KillAll FlyGenerator|set DeusEx.JCDentonMale Location (X=454,Y=67,Z=-467)|set DeusEx.JCDentonMale ViewRotation (Pitch=1800,Yaw=0,Roll=0)'`,
then `live-acceptance.mjs play --map 04_NYC_Street --seed 1 --tag vents4 --shot vents4 --base-shot --render-history --early-cmds '<the same lines>'` (with
`--extra-shots 3` for the floor below), `compare --tag vents4` and `visual-acceptance.mjs compare --maps 04_NYC_Street --contribution --view vents4:0,0,0:0,0,0`.
Brightness 2/3 makes the original's Shot the framebuffer (Play at 0.4, its identity, as in the other Mac rows): the frames' ratio reads .993 and 1.005 where
vents2 (the Linux host, its default ramp) read 1.275.

| | vents3 | vents4 |
| --- | --- | --- |
| 600 ticks, every watched actor (16 pawns, 5 timed actors, the player, `PigeonGenerator2`'s generator fields) | equal, clock equal | equal, clock equal (two replays) |
| stream draws per tick | equal at all 600 ticks (two replays) | equal at all 600 ticks (two replays) |
| the held frame | Play / original .993, mean abs. diff. .97, edge recall .973, precision .976, 0 outlier blocks | 1.005, .76, .980, .981, 0 |
| the steam (frame less the frozen start's) | correlation .991, Play's sum over the original's .985, residual .116, **agreement .89** (a second replay .941) | .9945, 1.010, .096, **agreement .910** (a second replay .884) |

**The draw difference of vents2 (8 more in Play at tick 45) was the population, not the tick gate.**

* **The stasis suspicion is refuted on both sides.** `AActor::InStasis` (Engine.dll `0x1036bfe0`) returns 0 unless TimeSeconds less `LastRenderTime` is above 5
  *and* `bStasis` (+0x28 bit 0x200000) is set (`fcomp [0x1042ada8]`, then `test eax,0x200000; je` to the `xor eax,eax` return), before it reads Physics, the zone
  table or `DistanceFromPlayer` ([script actor tick](script-actor-tick.md)). Every PawnGenerator of the map has `bStasis` clear: Play's class defaults
  (`live-acceptance.mjs read`) and the original's load records (`generators-load-vents3/-vents4.json`, the `flies3` trace: `Stasis` 0, `LastRenderTime` -10,
  Physics 0). In the original's `flies3` trace (120 ticks, the FlyGenerators kept) every generator ticks from the first unfrozen tick: each spawns its
  `GeneratorScout` there. `--render-history` writes the generators' `LastRenderTime` too now; it changes nothing for them.
* **The 8 draws are `GeneratePawn`'s.** `PawnGenerator.Tick` counts `TryTimer` down; when it runs out, `IsActorUnnecessary` (`DistanceFromPlayer >= ActiveArea`,
  700 for a FlyGenerator) either generates a fly (`TryTimer` 0.25) or sets `TryTimer` 0. The original's `TryTimer` reading 0 from that tick on is the second branch;
  `flies3` shows the same for all five of its FlyGenerators (998 to 7,231 units from the camera). Play's `FlyGenerator14` is `Trashbag4`'s, at (541, 101, -485),
  95 units from the camera: it generates when the original's `TryTimer` (written into Play) runs out. So vents2's `FlyGenerator14` was another decoration's, at least
  700 units away. Read from the branch, not measured: vents2's generator locations were not recorded and its store is on the Linux host.
* **Why the names matched.** `DeusExDecoration.PreBeginPlay` spawns a FlyGenerator for a decoration with `bGenerateFlies` when `FRand() < 0.1` (76 of the
  Street's 189 decorations; Play's seed-1 load picks 10). The names are a per-process counter that continues across loads (the sweep's note above): a fresh
  original process names them from `FlyGenerator0` (`flies3` 0 to 4, vents3 0 to 5, vents4 0 to 3), Play's seed-1 load `FlyGenerator10` to 19. vents2's matching
  population at the third load was the reload loop's counter reaching Play's range, whatever decorations made them. Nor were the generators compared: Play did not
  watch them and the comparison's field list held neither `TryTimer` nor `PoolCount`, so "equal for 600 ticks" was not a comparison for them.
* **Fix, in the harness** (208ce98; Play's tick code is unchanged). The generators are watched on both sides (`Location`, `DistanceFromPlayer`, `LastRenderTime`,
  `bStasis`, Physics, `PawnCount`, `bScoutInit`, `Scout` besides `TryTimer` and `PoolCount`) and compared. Both populations carry locations and the driver reports a
  same-named FlyGenerator that stands elsewhere. This row's recipe removes the chance FlyGenerators in both programs with the original's own `KillAll FlyGenerator`
  (`PlayerPawn.KillAll`, a cheat exec of the script, which Play runs through its console chain), typed in the frozen phase before the population is listed. The
  original's generators are recorded first (`generators-load<tag>.json`); the driver checks that none is left (exit 4: the Mac's console drops characters under
  load), and `dx-live-win list` leaves out destroyed actors (`bDeleteMe`), which keep their objects until `ULevel::CleanupDestroyed` purges them. vents3 and vents4
  matched the population at the first load (978 actors on both sides) and replay equal. vents4's load had one near the camera: `FlyGenerator2` on `Trashbag3`
  (882, 279, -485), the decoration of Play's `FlyGenerator13`, 478 units away.

**The steam's agreement is the puff texture's phase.** Agreement (of the pixels the original's steam raises by at least 1 level, the share where Play's adds at
least a quarter of the scaled value) fails in the plume's faint part: in vents3 .50 to .85 for the pixels the original raises by 1 to 10 levels, .976 at 10 to 20,
1.000 above 20. `SmokePuff1` is a FireTexture: Fire.dll draws its sparks from a 512-byte table of the process's rand ([fire texture](fire-texture.md)) and the
texture ticks with every drawn frame, so at a held tick the puffs' pattern changes from frame to frame in either program (Play's base frames of two replays are
byte-equal, the held frames are not). vents4 holds four frames of the original (`--extra-shots 3`, about two seconds apart) and a second replay four of Play
(`--extra-shots 3`, 90 page frames apart); `node scripts/contribution-floor.mjs --map 04_NYC_Street --shot vents4`:

| pairs (the first frame the reference) | agreement | correlation | Play's sum over the reference's | residual |
| --- | --- | --- | --- | --- |
| the original against itself (12) | .867 to .934 (median .913) | .984 to .992 | .92 to 1.08 | .110 to .164 |
| Play against the original (16) | .846 to .944 (median .898) | .985 to .993 | .92 to 1.10 | .110 to .160 |
| Play against itself (12) | .845 to .979 (median .906) | .987 to .994 | .91 to 1.10 | .099 to .146 |

The gate's .98 (set from the Bar's haze, which has no FireTexture) is above every pair of the original against itself. Play against the original lies in the
original's own range; its median is .015 below the original's, and Play's frames vary more (pixels the steam raises by at least a level: Play 301k to 338k, the
original 322k to 337k). With four frames a side that is not separable from the phase: recorded, not attributed. The steam's level histograms overlap bin by bin
(the frames' sums 7.12 to 7.84 M in Play, 7.13 to 7.72 M in the original). What would match the pixels is the puff texture's state at the shot (its pixels, sparks
and random table read from the original's UFireTexture, Play's procedural textures held at it): not done.

The row stays `FAIL` on that one measure. A floor from the original's own frames, as the beams' `beamsFloor`, would be: the gate's run takes Play's frames with
`--extra-shots 3` against the stored four, and Play's median agreement must reach the original's own minimum (here .898 against .867). The gate is not changed here.

Stored: `.work/live-acceptance/04_NYC_Street/{original-trace-vents4.jsonl (+ .strobe, .actors.jsonl), watch-, population-, commands-, hold-, generators-load-vents4.json}`
(vents3 and the 120-tick `flies3` likewise) and `.work/acceptance/04_NYC_Street/vents4-original.png`, `vents4-original-{2,3,4}.png`, `vents4-base-original.png`
(vents3's too), main checkout on the Mac. vents2 stays on the Linux host.

### 00_Training's held viewport flash (row 4.2.26)

Taken on the Mac under CrossOver at Brightness 2/3 (the Shot is the framebuffer), Training's corridor camera `-100,840,30:0,0,0`, three captures each with its own
clock: `flash0` without the flash and two states held through `ConstantGlowScale`/`ConstantGlowFog` (`--pre-shot-cmd`, `--pre-shot-wait 5000`, `--player-state` for
the read-back). `compare --flash-base flash0` reads each program's flash as a map of levels from its own frame without it; the maps are equal at all 369 (channel,
level) pairs in both states. The recipe and the fog cutoff that keeps the first state's fog at 0 in both programs are in
[screen flash](screen-flash.md#against-the-original-2026-10-16-gate-row-4226). `flash0` also found that Play showed its page colour where nothing is drawn,
where the original clears every frame to black; that is fixed ([the screen clear](screen-flash.md#the-screen-clear-fixed-2026-10-16)), and `flash0` now
reads mean abs. difference 0.00 against the original at the identity ramp.

```bash
scripts/original-views.sh 00_Training --view flash0:-100,840,30:0,0,0 --brightness 0.666667 --player-state
scripts/original-views.sh 00_Training --view flashA:-100,840,30:0,0,0 --brightness 0.666667 --player-state --pre-shot-cmd 'set DeusEx.JCDentonMale ConstantGlowScale -0.5' --pre-shot-cmd 'set DeusEx.JCDentonMale ConstantGlowFog (X=0.3,Y=0.1,Z=0)' --pre-shot-wait 5000
scripts/original-views.sh 00_Training --view flashB:-100,840,30:0,0,0 --brightness 0.666667 --player-state --pre-shot-cmd 'set DeusEx.JCDentonMale ConstantGlowScale 0' --pre-shot-cmd 'set DeusEx.JCDentonMale ConstantGlowFog (X=0.6,Y=0.45,Z=0.4)' --pre-shot-wait 5000
node scripts/validate-stage4-acceptance.mjs --only '^4\.2\.26$'
```

`original` needs the map in the plan, which `play` writes: on a checkout without one, run `play --maps 00_Training --view flash0:...` first.

### 00_Training's pawns' shadows (row 4.2.15)

Taken on the Mac under CrossOver at Brightness 2/3, the level unfrozen so `Shadow.Tick` attaches the shadows: `shadow2` (211,1266,-33) and `shadow3` (61,1326,-23)
over the gallery, in that order and in one run (one clock, 54.507 s), each with its frame after `set WinDrv.WindowsClient Decals False` (`<view>-base`, Play's
`--base decal`) and the state of every Shadow actor read after the shot (`--decal-state`: `<view>-decals.json`, Play's `<view>-play-decals.json`). Four
inputs are held: the walkers stand (`--cmd 'set MIB Orders Standing'`, `--cmd 'set ScientistMale Orders Standing'`, typed while the level is still frozen),
the meshes are hidden and the level frozen again before each shot (`--pre-shot-cmd`), and Play moves its camera as the original's console does (`play
--camera-transit`: Location, frames, then ViewRotation). `compare --contribution` now reads an effect that darkens by its own sign; `compare --decal-state`
matches the shadows by owner and compares them as float32. Both frames, the contributions and the 19 shadows' state equal the original's; what each
hold is for, the five captures that found them and the numbers are in [decals](decals.md#against-the-original-2026-10-16-gate-row-4215).

```bash
scripts/original-views.sh 00_Training --view shadow2:211,1266,-33:62500,61567,0 --view shadow3:61,1326,-23:61166,59067,0 --view shadow2-base:211,1266,-33:62500,61567,0 --view shadow3-base:61,1326,-23:61166,59067,0 --brightness 0.666667 --cmd 'set MIB Orders Standing' --cmd 'set ScientistMale Orders Standing' --unfreeze --base-cmd 'set WinDrv.WindowsClient Decals False' --pre-shot-cmd 'set ScriptedPawn bHidden True' --pre-shot-cmd 'set LevelInfo bPlayersOnly True' --decal-state
node scripts/validate-stage4-acceptance.mjs --only '^4\.2\.15$'
```

### 00_Training's and Island's detail pass (row 4.2.22)

Taken on the Mac under CrossOver at Brightness 2/3, one capture per map, the level frozen: two of Training's walls (`detailT1` at 30 units, `detailT2` at 120, 50.629 s)
and two views of Island's pier deck (`detailI1`, `detailI2`, 50.734 s), each with the render device's `DetailTextures` poked to 1 before the camera (`--poke`; CrossOver's
ddraw, like Linux Wine's, reports no `BLENDDIFFUSEALPHA`, so `SetRes` leaves the field 0) and again with it poked to 0 (`--base-poke`, `<view>-base`), and each base view a
second time (`<view>b-base`, the original's own variation, unread by the gate). Play keeps its pass (`--detail on`) and hides it for its frame without (`--base detail`);
`compare --contribution` reads the pass as an effect that darkens. Both frames and the pass's contribution equal the original's within the gate's thresholds (correlation
.993 to 1.0, Jaccard of the changed pixels .97 to .9998). The comparison found that Play's fans missed the frame's top row, whose pixel centres their clipped
edge lies on; fixed the same day ([edges on pixel centres](frame-projection.md#edges-on-pixel-centres-2026-10-16)). The numbers, the device read and what is left are in
[frame projection](frame-projection.md#against-the-original-in-a-frame-2026-10-16-gate-row-4222).

```bash
scripts/original-views.sh 00_Training --view detailT1:-736,1314,560:0,16384,0 --view detailT2:-1100,1224,560:0,21384,0 --view detailT1-base:-736,1314,560:0,16384,0 --view detailT2-base:-1100,1224,560:0,21384,0 --view detailT1b-base:-736,1314,560:0,16384,0 --view detailT2b-base:-1100,1224,560:0,21384,0 --brightness 0.666667 --poke D3DRenderDevice0:0x78:1 --base-poke D3DRenderDevice0:0x78:0
scripts/original-views.sh 01_NYC_UNATCOIsland --view detailI1:-4761,10431,-234:56536,20000,0 --view detailI2:-4761,10431,-256:62536,0,0 --view detailI1-base:-4761,10431,-234:56536,20000,0 --view detailI2-base:-4761,10431,-256:62536,0,0 --view detailI1b-base:-4761,10431,-234:56536,20000,0 --view detailI2b-base:-4761,10431,-256:62536,0,0 --brightness 0.666667 --poke D3DRenderDevice0:0x78:1 --base-poke D3DRenderDevice0:0x78:0
node scripts/validate-stage4-acceptance.mjs --only '^4\.2\.22$'
```

### 06_HongKong_WanChai_Underworld's mirrored panes at a held Strobe (row 4.2.30)

Taken on the Mac under CrossOver at Brightness 2/3, one capture with the level frozen and the dancers hidden (`--cmd 'set ScriptedPawn bHidden True'`), Render.dll's Strobe
flag held through `dx-live-win.exe strobe hold` for each frame, both states at two cameras: `uw` (-1081, -2010, -336) at yaw 54769, the aimed camera of
[Strobe in child frames](#strobe-in-child-frames-2026-10-14) (its main frame draws no strobe-lit surface: the floor is lit in the panes only), and `uwd`
(-1120, -1900, -336) at yaw 55000, two panes beside the direct floor (Divergence 19's view d). `_s0` is the flag at 0 (TriggerLight1 lit), `_s1` at 1 (dark).
Play holds its clock (`TimeDilation 0`) and writes the same flag (`liveProbe({strobe})`). Free-running, the flag changed at every new kept time at both
cameras (`uw-strobe.txt`: 20 of 20 steps over 120 polls; `uwd-strobe.txt`: 26 of 26), so an unheld frame is a coin flip.

* **Each frame has its own clock.** The original's clock runs on at the held dilation 0.001 while the views are taken (the free-running poll, the hold
  and the reads take tens of seconds of wall time), and two Disco lights in view follow it: `Light2` (-1026, -1630, -48) and `Light21` (-1027, -1453, -48),
  `LightEffect` 10 (`LE_Disco`), 378 and 520 units from the camera, whose spatial pattern moves with `Level.TimeSeconds` over the walls behind the panes, direct
  and in the reflection (Play's own frames 0.16 s apart differ there and nowhere else). A first capture held Play at the clock read after the load (52.506 s)
  while its shots were 0.13 to 0.22 s later: 3, 8, 6 and 6 outlier blocks on those walls; `uw_s1` played at its shot's level time read 0 (mean abs.
  difference 0.15, edges 1/.998). `original` now keeps as a held-Strobe view's `-time.txt` the level time read just before its shot
  (`dx-live-win.exe strobe poll 1 0 <LevelInfo>`: the `TimeSeconds` at +0x478 of the live player's LevelInfo, read through its address, without the walk
  over the object array that takes a minute on a loaded host), and the gate plays each frame in a run of its own (`play` holds one clock per run).
* **The hold beside each frame.** `<view>-strobe-held.txt` holds the hold (byte `0xeb` at `0x10b05b4b`, the flag written, the kept time), a poll after the shot
  (the same flag and kept time: no flip was drawn), and the level time and camera just before and just after the shot (0.003 s apart in the stored
  capture). The gate's `strobeHeld` refuses a record whose flag is not the name's, whose flag or kept time moved, whose camera is not the view's, or whose
  level time ran 0.01 s or more over the shot. It refuses the records of two discarded captures: one whose dilation line was dropped (52 s over
  the shot), and one whose slow reads bracketed the shot over 0.09 s.
* **Dropped console input on a loaded host.** The Mac was running other sessions' oracles (load average 13 to 24), and the original's console dropped typed
  characters. One capture's `TimeDilation` line failed, so its level ran at dilation 1 from 98 s; another's `bHidden` line failed, so the dancers are in its frames.
  `original` now reads the held dilation back and types its line again (the stored capture needed one retry). It refuses a level that was not frozen before
  the load (LevelInfo `bPlayersOnly`, `+0x4f0 & 4`): its TriggerLight would have ticked to its own brightness. `--cmd-check '<object> <field:offset:type[:mask]> <value>'`
  reads back a field the `--cmd` lines set and types them again (`Hooker0 bHidden:0x28:bit:0x2 1`). **Unexplained, seen five times:** after none to four
  shots the game ignored every posted key (console lines, Escape, the Shot key) while it went on ticking and drawing, and the run ended with `NO SHOT`.
  It was not the hold: holds, releases, polls and reads in the menu map did not cause it. It was not a covered window: it happened with the game window in
  front (raised through System Events; the user allowed it). It was not time: shots kept working for five minutes in the menu map. The game's thread
  key state read no modifier held, and its focus and active window were the viewport. Each time the game was restarted; the stored capture shows none of it.

| View | Shot's level time | Play / original | Mean abs. diff. | Edge recall / precision | Outlier blocks |
| --- | ---: | ---: | ---: | ---: | ---: |
| uw_s0 (lit) | 52.418 | 1.000 | 0.02 | 1 / 1 | 0 |
| uw_s1 (dark) | 52.456 | 1.000 | 0.02 | 1 / 1 | 0 |
| uwd_s0 (lit) | 52.497 | 1.000 | 0.01 | 1 / 1 | 0 |
| uwd_s1 (dark) | 52.536 | 1.000 | 0.00 | 1 / 1 | 0 |

Block ratios .986 to 1.019, the same numbers in two gate runs. The Strobe state is what the frames hold: each original against Play's frame of the other
state reads 53 (`uw`) and 30 (`uwd`) outlier blocks, mean abs. difference 8.9 and 4.4, edge recall .79 and .67 against the lit originals. The 2026-10-14 pair
of the same camera (`c0_s0`, `c0_s1`, Linux Wine at the default ramp) read ratio 1.21 and 1.20, mean abs. difference 4.65 and 2.92 (the uniform gap); at the
identity ramp under CrossOver the frames are equal to within 0.02 levels. Stored (Mac main): `.work/acceptance/06_HongKong_WanChai_Underworld/
{uw_s0,uw_s1,uwd_s0,uwd_s1}-original.{png,bmp}`, `-time.txt`, `-strobe-held.txt` and the polls `uw-strobe.txt`, `uwd-strobe.txt`; the discarded captures are in
`.work/uw30/capture{1..7}/`, unread by the gate.

```bash
i686-w64-mingw32-gcc -O2 -o ad/build/dx-live-win.exe tools/dx-live-win.c -lpsapi   # an older build has no `level=` read: the frame then keeps the load's clock and the gate's hold check fails
node scripts/visual-acceptance.mjs play --maps 06_HongKong_WanChai_Underworld --view uw_s0:-1081,-2010,-336:0,54769,0   # the plan, on a checkout without the map in it
scripts/original-views.sh 06_HongKong_WanChai_Underworld --brightness 0.666667 --view uw_s0:-1081,-2010,-336:0,54769,0 --view uw_s1:-1081,-2010,-336:0,54769,0 --view uwd_s0:-1120,-1900,-336:0,55000,0 --view uwd_s1:-1120,-1900,-336:0,55000,0 --cmd 'set ScriptedPawn bHidden True' --cmd-check 'Hooker0 bHidden:0x28:bit:0x2 1' --strobe-poll
node scripts/validate-stage4-acceptance.mjs --only '^4\.2\.30$'
```

## Open

- **Not attributed, seen in the 2026-10-14 pilot re-runs with Divergences 17 and 18 in** (every watched actor equal in all three): the Island run's stream draws differ at tick 264
  (original 6, Play 7); the Underworld's at tick 31 (original 1, Play 0). Whether the rule change moved either was not tested (the draws of the Island at 264/276 were the load-time Tree
  timers and the ghost's SightCounter before, [Divergence 6](#divergences-found)). The Club is equal for the draws too. **Explained 2026-10-16** for the Underworld (a draw short at tick 45, and tick 31 in the earlier runs: the player's animation flags at the start of the replay,
  [the live replay's start state](#the-live-replays-start-state-battery-parks-two-loads-and-the-underworlds-flaky-draw-2026-10-16)); the Island's tick 264 was not looked at again.
- **The Dockyard SecurityBot0 waypoint at tick 28 (group 2)** is Divergence 17 (a HazMatSuit or bottle stops the pick's test moves; the sweep's trace reproduces the original's destination
  under the old rule and is equal after the fix, and the original's four picks of that tick, reproduced in a fresh original with `--rng-from`, equal Play's). Not examined beyond that.
- **Pawns that tick after an absent generator.** The Dockyard load z1 (MilitaryBot3 and RepairBot0 draw their StartUp Sleep at another stream index from tick 1, 4 extra draws in the
  original, six generators only it holds) and the sweep's BatteryPark load (32 pawns from tick 13, 201 draws against 199 on tick 1; its trace replays in today's Play with the same
  divergence once the sidecar files are rebuilt) look like [Divergence 15](#divergences-found)'s case with the generator **before** the pawns in tick order (a spawned actor takes a
  free `Level.Actors` slot, not always the end); not checked with `--actor-trace` (the tick position of the original's generators). **BatteryPark settled 2026-10-16:** that trace's load
  held a chance `FlyGenerator4` Play's load lacks (its own population dump), and a fresh exact-population load replays 64 of 64 over 1,200 ticks
  ([the live replay's start state](#the-live-replays-start-state-battery-parks-two-loads-and-the-underworlds-flaky-draw-2026-10-16)); the generator's slot is still unmeasured, and the
  Dockyard z1 load was not re-examined.
- **Population mismatches of pickups.** The population step exempts the spawned pickup families (Liquor, Medkit, ...) from the name match; an item placed by the load's chance in the
  original and not in Play blocks a pawn now that pawns collide with items as the original's do. No case seen (the bottles and the HazMatSuit were in both programs).

- **Camera views not yet captured against the original** ([Security cameras](#security-cameras-2026-10-14)): a camera whose view holds a mirror, a sky
  frame, fog or coronas (eleven of the thirteen windows look into rooms; the Ship's windows 1 and 2 hold volumetric fog by Play's rule, faint and heavy, unjudged:
  [camera view census](camera-view-census.md), which also ranks the cameras that see a mirror, sky, fog or corona; Island ComputerSecurity0's exterior cameras were tried, and after the ghost's `walk`
  JC left the map at the SATCOM compound, probably through a transition volume), the other computers of the census, a window zoomed or panned
  (`Equals`, the arrows), and the three windows' door/turret choices. The camera window's moving actors and movers (Island's terrorists, Ship's
  locker door) are not matched.
- The player's weapon noise is compared ([Weapon noise](#weapon-noise-2026-10-14): a pistol and an assault shotgun, 1,069 and 1,586 manager calls
  equal); footsteps (held keys), the player's `TakeDamage` `Distress`, combat and the other weapons are not.
- The uniform 1.13–1.41× raw brightness gap under Wine; a CrossOver
  capture on the Mac matched more closely. The user does not want it
  chased: it is a known gamma issue of the game on Windows. Measured since
  ([Security cameras](#security-cameras-2026-10-14), item 6): Shot bakes a ramp
  of the Brightness setting into its bitmap; at Brightness 2/3 it is the framebuffer
  and Play's identity-ramp frames agree to 1% in the camera windows. Play's ramp was not touched.
- The darkest values are closed as a finding, not a rounding rule ([The darkest pixels](#the-darkest-pixels-2026-10-15-not-a-rounding-difference)):
  the residual is +-1 at filtered texels (0.129% of the light-map samples), the host GPU's. Open there: the steady differences of the surfaces the
  light-map shader does not draw (Ocean Lab y1's reflective-looking surface at +0.93, the Island's skyline and water, a mesh patch in BatteryPark y2), and
  the animated-light pixels, whose states the two programs do not share.
- The frozen captures stand at the map's frame-0 pose; live behaviour is
  compared per tick in [Live scenes](#live-scenes-2026-10-13), where the
  Club's dancers in view (stasis) and a frame with pawns close in view are still open.
- **Held frames carry the host's Strobe phase.** The Strobe flag is a host input ([Strobe](#strobe-a-host-input-and-a-triggerlight-the-page-lit-wrongly)):
  a frame compared at a held tick takes the original's measured flag, not its own. A light-map region lit by a Strobe light that is on
  differs between two frames of the same program unless the flag is matched. The Underworld's only Strobe light is TriggerLight1, off.
- The stream's draw count per tick was a difference in every early pilot (the Underworld on tick 1 to 3, depending on the load); with the load-time
  inputs copied from the original (divergences 5 and 6) it is equal in every run listed above, 600 to 1,500 ticks.
- Captures come from one Wine/D3D host. D3D behaviour that depends on the
  driver is not separated from the original's own.

