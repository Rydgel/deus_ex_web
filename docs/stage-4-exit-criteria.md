# Stage 4 exit criteria: a finite definition of "Done when"

Status: **draft for the user to adopt** (written 2026-10-15 from master 2386f69). Nothing here is a Stage 4 claim; it is the definition the
claims will be judged against. The acceptance test is `scripts/validate-stage4-acceptance.mjs` (see [Running the gate](#running-the-gate));
like the Stage 3 gate ([Stage 3 exit criteria](stage-3-exit-criteria.md)) it exits 1 until every criterion passes.

The roadmap's criterion for section 4 ("Restore the remaining presentation"): *representative scenes reproduce the original animated actors,
effects, sound, text, and interfaces, including synchronized speech and conversation camera behavior where used. A feature being decoded is
not evidence that it renders or plays correctly.* Section 4 had no finite scene list, so "representative" and "reproduce" have meant "whatever the
last agent compared". This note fixes both: a list of scenes, a criterion for each, and the check that proves it against the original, or the word
`MISSING`. Where the choice is mine and the reason is weak, the text says so; the user adopts or changes the list.

## Scoreboard

First run, 2026-10-15 on master 2386f69 plus this branch (Linux host, AMD, 30 GB, 16 cores, `--jobs 2`): 60 min 36 s wall, peak 5575 MiB across the checks that ran together. **44 of 70 criteria pass; the gate is red** (2026-10-16: 4.1.7 no longer flaky and 4.1.8 passes, [visual acceptance](visual-acceptance.md#the-live-replays-start-state-battery-parks-two-loads-and-the-underworlds-flaky-draw-2026-10-16); 45 of 70). 75 criteria in all, 5 excluded. The originals came from the stores listed under [Stored originals](#stored-originals).

| Clause | PASS | FAIL | INLINE | NO-ORIGINAL | MISSING | EXCLUDED |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 4.1 Animated actors | 9 | 0 | 0 | 0 | 2 | 0 |
| 4.2 Effects | 23 | 2 | 0 | 0 | 5 | 3 |
| 4.3 Sound | 5 | 1 | 0 | 0 | 1 | 0 |
| 4.4 Text and interfaces | 10 | 0 | 0 | 0 | 4 | 2 |
| 4.5 Speech, lip sync and the conversation camera | 7 | 0 | 0 | 0 | 0 | 1 |
| **Total** | see the note below | | | | | |

**Update, interface frames (2026-10-15, [interface frames](interface-frames.md)):** rows 4.4.11 to 4.4.14 are `PASS`, from 18 views of 00_Training compared with
the original's frames (the HUD, eight persona screens, the main menu, three Settings screens, a datacube and the keypad) and from the four stored security-computer screens (outside their camera windows); the clause 4.4 row of the first-run table reads
14 PASS, 0 MISSING and the total 48 of 70 PASS, 17 MISSING. The comparison found two divergences of Play, both fixed (the GC's authored underline texture and the window system's real-time tick).

**Update, conversation frames (2026-10-16, [conversation camera](conversation-camera.md)):** rows 4.5.5 (MeetPaul), 4.5.7 (the intro) and 4.5.8 (MeetManderley) are `PASS`, from the new `conversation` check kind: held frames of the original (Ctrl+F9 in the running game) against Play's replay of the same trace at the same tick, judged by
region (letterbox bars and subtitle identical, the 3D band within the polygon edge), plus the per-tick comparison of every traced actor over the longest replay. The clause 4.5 row reads 7 PASS, 1 MISSING (4.5.6, the speech audio) and the totals 48 PASS, 18 MISSING.
The comparison found one divergence of Play, fixed: `AActor::FindBase` traced a box of the wrong extent.

**Update, the player's weapon in a mirror (2026-10-16, the Mac, [weapon attachment](weapon-attachment.md#mirrors-2026-10-15)):** row 4.1.11 is `PASS` (`--only '^4\.1\.(9|11)$'`: 4 checks, 320 s,
4.1.9 passes on the same files). Its stored originals were on the Linux host only, which was unreachable, and a first run here read `NO-ORIGINAL`; they were captured again on the Mac under
CrossOver (`scripts/live-original.sh` now runs there, see [Stored originals](#stored-originals)). The two captures agree: the mirror's child frame logged the same
PrjXM..PrjYP words (`3e36ee45 3e6bb90c 3ec81e6e 3e4958ba`) in all 143 draws, and Play's replay of the Mac trace reproduces them. `weapon-attach` compared 888 draws of the running
original (590 Island main-frame draws, 142 of the pistol and 156 of the MedKit in the mirror): 1,776 comparisons, 0 failures.

**Update, the viewport flash (2026-10-16, the Mac, [screen flash](screen-flash.md#against-the-original-2026-10-16-gate-row-4226)):** row 4.2.26 is `PASS` (`--only '^4\.2\.26$'`: 2 checks, 87 s,
the same result in a second run). The original was captured under CrossOver at Brightness 2/3 (the Shot is the framebuffer; Play's ramp at 0.4 is the identity) at Training's corridor camera
`-100,840,30`, one capture and clock per frame: the frame without the flash (`flash0`) and two states held through `ConstantGlowScale`/`ConstantGlowFog`, their `FlashScale`/`FlashFog` read
back from the running game. *flashA* is the recipe's scale -0.5 and fog (0.3,0.1,0); `ViewFlash` sets a fog component under 0.019 to 0 after each step and a held tick's step is
fog x 10 x 0.005, so that fog never rises, in either program (measured: scale 0.5, fog 0): the multiply branch, alpha 128. *flashB* is fog (0.6,0.45,0.4) and no scale: the additive
branch, alpha 255, fog bytes (153,115,102), saturating. The check judges the flash as a per-channel map of levels (each program's frame with the flash against its own frame without
it): 369 of 369 (channel, level) pairs equal in both states, no sample off its level's map in either program (a Play that draws no flash differs at 363), and the frames
(edges .985/.999 and .998/.999). The blend's rounding is measured against the original under CrossOver on the M2, not against a Windows D3D driver.
The frame without the flash found one divergence of Play, fixed the same day ([the screen clear](screen-flash.md#the-screen-clear-fixed-2026-10-16)). Where nothing is drawn,
Play showed its page colour (`#06101b` in linear light, raw (0,1,3), 242,417 pixels above the corridor, 32 outlier blocks); the original clears every frame to black
(`UGameEngine::Draw` always sets `LOCKR_ClearScreen` with `ScreenClear` (0,0,0,0), and D3DDrv's `Lock` clears the target to it). A Play frame now clears to black:
`flash0` reads mean abs. difference 0.00 and 0 outlier blocks, and the row judges `flash0` as a frame too (rerun: flash0 1/.999/0, flashA .999/.999/0, flashB 1/.999/0).

**Update, Training's pawns' shadows (2026-10-16, the Mac, [decals](decals.md#against-the-original-2026-10-16-gate-row-4215)):** row 4.2.15 is `PASS` (`--only '^4\.2\.15$'`: 1 check, 31 s,
the same numbers in a second run). The original was captured under CrossOver at Brightness 2/3 with the level unfrozen (`Shadow.Tick` attaches the shadows), at two cameras over
the gallery where JaimeReyes0, WaltonSimons0 and mib1 stand, each with its frame after `set WinDrv.WindowsClient Decals False` and the state of all 19 Shadow actors read from the
running game. What the shadows depend on was held or measured, one finding per capture (five captures): the two walkers (mib1 Wandering, ScientistMale0 Patrolling) walk their own
random routes in each program, so both consoles order them to stand while still frozen in StartUp; the pawns' meshes are hidden and the level frozen again before the shot (the
original runs on while its state is read; frozen, the read is the frame's); Play places its camera as the original's console does, Location and then ViewRotation (ScientistMale0
is drawn only in the frames between, and Shadow.Tick attaches the shadow of a pawn drawn); and the recipe's first camera, whose animated console screen moved the contribution, is
replaced by one that sees the same shadows. Both frames then equal the original's (mean abs. difference 0.01, edges 1/1, no outlier block), the shadows' contribution is the
original's (correlation 1.0, residual 0; of the 57,851 and 57,571 samples the decals change, 146 and 128 differ by one level), and the 19 shadows' state is equal as float32
(5 attached, 14 detached, the same shadows drawn).

**Update, the detail pass in a frame (2026-10-16, the Mac, [frame projection](frame-projection.md#against-the-original-in-a-frame-2026-10-16-gate-row-4222)):** row 4.2.22 is `PASS` (`--only '^4\.2\.22$'`:
2 checks, 79 s, the same result in a second run). The original was captured under CrossOver at Brightness 2/3 with the render device's `DetailTextures` (`+0x78`) poked to 1
before each camera and, for the same cameras again, to 0 (`<view>-base`): CrossOver's ddraw reports `TexOpCaps` 0xfef7ff, without `BLENDDIFFUSEALPHA`, so `SetRes` leaves the field 0
there as under Linux Wine (read from the running game before the first poke). Four cameras of the recipe, one capture per map: two of Training's walls (50.629 s) and two of
Island's pier deck (50.734 s). Play draws its pass (`--detail on`) and hides it for its frame without (`--base detail`). The frames: mean abs. difference 0.01 to 0.02, edges .997
to 1, no outlier block. The pass's contribution: correlation .999 (Training) and .993 to .996 (Island), Play's sum within 0.2% of the original's, agreement .998 to .999; the
pixels the pass changes match with Jaccard .9985 and .9986 (Training), .990 and .973 (Island), against .938 to .980 in the 2026-10-15 measurement. A second base frame of each view
measured the original's own variation (Training's equal, Island's at most 77 pixels off by more than 2) and found no animated surface in view. Found and fixed the same day:
Play's fans missed the frame's top row, whose pixel centres their clipped edge lies on (the original fills it: 1,204 and 719 pixels in Training's views). D3D's top-left convention
fills a centre on a top edge, and the host's rasterizer (ANGLE over Metal, `scripts/probe-fill-rule.mjs`) leaves it; a fan with an edge on one of the frame's rows of centres is now
moved up by 1/256 px with its attributes read back ([edges on pixel centres](frame-projection.md#edges-on-pixel-centres-2026-10-16)): row 0 equal, Training's Jaccard .9998,
the row still `PASS` twice. What is left: on Island's far deck, a few thousand pixels changed by one level in one program only, equally in both (attributed to the colour interpolation and
the ZBIAS constant, unverified). The pass blends on CrossOver's wined3d on the M2, not on a Windows D3D7 driver.

**Update, the Underworld's mirrored panes at a held Strobe (2026-10-16, the Mac, [visual acceptance](visual-acceptance.md#06_hongkong_wanchai_underworlds-mirrored-panes-at-a-held-strobe-row-4230)):** row 4.2.30 is `PASS`
(`--only '^4\.2\.30$'`: 4 checks, 182 s, the same numbers in a second run). The stored `d_s0`/`d_s1` frames had no clock of their own; the row is a new capture under CrossOver at
Brightness 2/3, the level frozen and the dancers hidden, Render.dll's Strobe flag held for each frame (`dx-live-win.exe strobe hold`), both states at two cameras: `uw`, the aimed camera whose
main frame draws no strobe-lit surface (the floor lit in the panes only), and `uwd`, two panes beside the direct floor. Each frame keeps the level time read just before its shot as its clock,
because the level's clock runs on at the held dilation between shots and the club's two Disco lights (`LE_Disco`, 378 and 520 units away) follow it: held at the clock read after the load,
a first capture read 3 to 8 outlier blocks on the walls they light; at each shot's own clock, none. Play plays each frame in a run of its own at that clock. The frames: mean abs. difference
0.00 to 0.02, edges 1/1, no outlier block, Play / original 1.000. Each original against Play's frame of the other state reads 53 and 30 outlier blocks, so the frames discriminate the state.
The gate also reads each frame's hold record (`<view>-strobe-held.txt`): the flag the name asks for, held through the shot (the same flag and kept time polled after it), the view's camera, and
a level clock that moved less than 0.01 s over the shot. On the way, under other sessions' load, the original's console dropped typed characters (a capture's dilation line, another's
`bHidden` line); `visual-acceptance.mjs original` now reads the dilation back, refuses a level not frozen before the load and takes `--cmd-check` for a `--cmd` line's field. Unexplained and
labelled: five times the game stopped taking posted keys after none to four shots, which ended those runs with `NO SHOT`.

**Current state, counted from the rows below (2026-10-16, not a gate run):** 76 criteria, 6 excluded (4.5.6 joined the excluded rows and 4.1.11 was added after the first run), 70 gating; **66 PASS, 1 FAIL, 3 MISSING** (4.3.6 and 4.3.7 passed on the Mac late on 2026-10-16, 4.2.13 early on 2026-10-17).
Only the full gate run (`node scripts/validate-stage4-acceptance.mjs`) is the gate; the per-row statuses come from the subset runs named in the updates above.

| Clause | PASS | FAIL | MISSING | EXCLUDED |
| --- | ---: | ---: | ---: | ---: |
| 4.1 Animated actors | 10 | 0 | 2 | 0 |
| 4.2 Effects | 28 | 1 | 1 | 3 |
| 4.3 Sound | 7 | 0 | 0 | 0 |
| 4.4 Text and interfaces | 14 | 0 | 0 | 2 |
| 4.5 Speech, lip sync and the conversation camera | 7 | 0 | 0 | 1 |
| **Total** | **66** | **1** | **3** | **6** |

The table below is the whole gate, one row per criterion (`--markdown` re-renders it from the report). The ids are stable; `4.n.m` is clause n, row m.
A mode in brackets names how the check exercises Play (see [How the gate judges](#how-the-gate-judges)).

### 4.1 Animated actors

| Id | Scene | Criterion | Ev. | Checks (mode) | Status |
| --- | --- | --- | --- | --- | --- |
| 4.1.1 | 00_Training start views | meshes, lighting and the floor mirror in five frames match the original's | O1 | `frames 00_Training` [worker] | PASS |
| 4.1.2 | mesh pipeline | GetFrame, LOD, skins and mesh lighting equal Engine.dll and Render.dll | O2 | `lodmesh-frame` [oracle], `mesh-light-types` [oracle], `lodmesh-lod` [oracle], `mesh-lighting` [oracle], `lodmesh-materials` [oracle], `mesh-environment` [oracle] | PASS |
| 4.1.3 | mesh pipeline in Play | the same code on the inputs Play produced in Training and Island | O3 | `lodmesh-lod-play` [worker], `mesh-light-types-play` [worker], `mesh-lighting-play` [oracle] | PASS |
| 4.1.4 | animation state | animation phase, controls, blend and the dilated delta equal the original | O2 | `anim-dilation-play` [worker], `animation-tick` [oracle], `animation-controls` [oracle], `get-anim-group` [oracle], `tween-blend` [oracle] | PASS |
| 4.1.5 | 01_NYC_UNATCOIsland live | 88 actors, 600 ticks: every watched field, the clock and the stream draws equal | O1 | `live 01_NYC_UNATCOIsland` [worker] | PASS |
| 4.1.6 | 10_Paris_Club live | 22 actors, 600 ticks, then the dancers animating in view and their frame | O1 | `live 10_Paris_Club` [worker], `live 10_Paris_Club (cvclub)` [worker] | PASS |
| 4.1.7 | 06_HongKong_WanChai_Underworld live | 50 actors, 600 ticks, six dancers | O1 | `live 06_HongKong_WanChai_Underworld` [worker] | PASS |
| 4.1.8 | five campaign maps, 1,200 ticks | BatteryPark, Hotel, Market, Chateau and Area 51 Bunker: every actor equal | O1 | `sweep replay 5 maps` [worker] | PASS |
| 4.1.9 | 01_NYC_UNATCOIsland armed pawns | a pawn's third-person weapon: hand frame and Coords equal Render.dll, drawn in Play | O2 | `weapon-attach` [oracle], `weapon-play` [worker] | PASS |
| 4.1.10 | Training first-person crowbar | the first-person weapon frame (view model, GPU camera passes) against the original | - | missing: only the selection (validate-weapon-lod) is compared with the original; no matched capture of the held weapon | MISSING |
| 4.1.11 | 05_NYC_UNATCOMJ12lab mirror | the player holding a pistol and a MedKit in a mirror child frame: the frame's planes and the Coords equal the running original's logged draws | O1 | `weapon-attach` [oracle], `weapon-mirror-play` [worker] | PASS |
| 4.1.12 | an armed NPC in a mirror, a weapon in a camera window | an armed pawn in a mirror child frame and a weapon in a ViewportWindow against the original's frames | - | missing: wired and checked in Play (`terminals-camera-browser --expect weapons`); no original capture of an armed NPC in a mirror or of a camera window with an armed pawn | MISSING |

### 4.2 Effects

| Id | Scene | Criterion | Ev. | Checks (mode) | Status |
| --- | --- | --- | --- | --- | --- |
| 4.2.1 | 01_NYC_UNATCOIsland | sky, water, skyline and decorations, five frozen frames | O1 | `frames 01_NYC_UNATCOIsland` [worker] | PASS |
| 4.2.2 | 04_NYC_Street | steam vents, panning sky, Spotlight and Cylinder pools | O1 | `frames 04_NYC_Street` [worker], `frames 04_NYC_Street [street1,street2]` [worker] | PASS |
| 4.2.3 | 02_NYC_BatteryPark and 03_NYC_AirfieldHeliBase | street-lamp coronas and exterior lighting | O1 | `frames 02_NYC_BatteryPark,03_NYC_AirfieldHeliBase` [worker] | PASS |
| 4.2.4 | 08_NYC_Bar | the bar's translucent mirror and lighting | O1 | `frames 08_NYC_Bar` [worker] | PASS |
| 4.2.5 | 10_Paris_Club | Disco floor, wall mirrors and lights | O1 | `frames 10_Paris_Club` [worker], `frames 10_Paris_Club [club1,club2,club3,club4]` [worker] | PASS |
| 4.2.6 | 09_NYC_Ship | Rotor fan and SlowWave hold, coronas behind a mover, the ship's frames | O1 | `frames 09_NYC_Ship` [worker], `frames 09_NYC_ShipFan [fan2]` [worker], `frames 09_NYC_ShipBelow [below1,below2]` [worker] | PASS |
| 4.2.7 | 06_HongKong_WanChai_Garage | Searchlights, red and blue ceiling panels | O1 | `frames 06_HongKong_WanChai_Garage [garage1,garage2,garage3]` [worker] | PASS |
| 4.2.8 | Training corridor, Everett, Smuggler's, 747, Market | NonIncidence lights, a standing mirror, a window mirror and a mover mirror | O1 | `frames 11_Paris_Everett,02_NYC_Smug,03_NYC_747,06_HongKong_WanChai_Market` [worker], `frames 00_Training [trainA,trainB]` [worker] | PASS |
| 4.2.9 | light maps | static and animated light maps, spatial and moving light effects equal Render.dll | O2 | 8 validators (moving-light-effects, leaf-lights, light-spatial, ...) [oracle] | PASS |
| 4.2.10 | light effects in Play | the Disco floor, a barrel fire and AugLight in Play against the original bodies | O3 | `light-spatial-play` [worker], `moving-light-effects-play` [worker], `auglight-lighting` [oracle] | PASS |
| 4.2.11 | coronas | visibility helper, DrawIcon arguments, tracker trace and the tile chain | O2 | `coronas-play` [worker], `coronas-tracked` [oracle], `corona-tiles` [worker], `corona-tiles-play` [worker], `coronas-mover-play` [worker], `coronas` [oracle] | PASS |
| 4.2.12 | particles and sprites | ParticleIterator, FDynamicSprite and the tile chain | O2 | `particles-play` [worker], `sprite-setup` [oracle], `sprite-tiles` [worker], `sprite-tiles-play` [worker], `sprite-tiles-mirror-play` [worker], `native-particles` [oracle] | PASS |
| 4.2.13 | 04_NYC_Street vents | a frame with particles and sprites against the original with the generators' state matched: the original's 600 ticks replayed in Play (the load's chance FlyGenerators removed in both by the original's `KillAll`), then the held frame and the steam against the original's, the steam's FireTexture held at the original's pixels | O1 | `live 04_NYC_Street (vents5)` [worker] | PASS |
| 4.2.14 | decals | AttachDecal, ClipDecal and the vertices of a decal equal Engine.dll and Render.dll | O2 | `decal-vertices-play` [worker], `decals-play` [worker], `decal-attach` [oracle], `decal-render` [worker], `decal-startup` [oracle] | PASS |
| 4.2.15 | 00_Training pawns' shadows | a decal frame against the original under CrossOver: the frames, the shadows' contribution (the frame less the frame without decals) and every Shadow actor's state at the shot (drawn set, owners, Location, DrawScale, Rotation, surfaces) equal; bullet holes, blood and scorch marks need combat and are not in it | O1 | `frames 00_Training [shadow2,shadow3]` [worker] | PASS |
| 4.2.16 | volumetric fog (02_NYC_Bar) | ComputeFromActor and the fog loop equal Render.dll; the pass in Play | O3 | `volumetric-fog-play` [worker], `volumetric-fog` [oracle] | PASS |
| 4.2.17 | 02_NYC_Bar smoke haze | a fog frame against the original, and the haze (the frame with the fog zones less the frame without) against the original's | O1 | `frames 02_NYC_Bar [fog3,fog5,fog0]` [worker] | PASS |
| 4.2.18 | mirrors | frame cases, child frames, nesting, the sky inside a mirror, the strobe | O2 | `mirrors-play` [worker], `mirror-plan-play` [worker], `underworld-panes-play` [worker], `strobe-mirror-play` [worker], `sky-in-mirror-play` [worker], `child-frames` [oracle], `mirrors` [oracle] | PASS |
| 4.2.19 | 02_NYC_Hotel bathroom mirror | an opaque unlit mirror against the original, the player in the reflection posed as the original had him | O1 | `frames 02_NYC_Hotel [hotel1,hotel2]` [worker] | PASS |
| 4.2.20 | Fire.dll textures | fire and water textures, animated and auto-panned surfaces | O2 | `fire-texture-rust` [node], `native-fire-texture` [oracle], `fire-texture-play` [worker], `texture-animation-play` [worker], `native-texture-animation` [oracle], `native-surface-pan` [oracle] | PASS |
| 4.2.21 | detail textures | the D3DDrv detail pass equals the original body; Play draws it | O2 | `detail-pass` [oracle], `detail-pass-rust` [oracle], `detail-play-sim` [node], `detail-play` [worker] | PASS |
| 4.2.22 | 00_Training and 01_NYC_UNATCOIsland detail pass | a frame with the detail pass against the original's under CrossOver with the pass poked in: the frames, and the pass's contribution (the frame less the frame without the pass) against the original's | O1 | `frames 00_Training [detailT1,detailT2]` [worker], `frames 01_NYC_UNATCOIsland [detailI1,detailI2]` [worker] | PASS |
| 4.2.23 | lasers | LaserIterator.CurrentItem equals the original; the Island doorway beams draw | O2 | `lasers-play` [worker], `native-laser` [oracle] | PASS |
| 4.2.24 | 01_NYC_UNATCOIsland doorway | a beam frame against the original: the beams' geometry (the beam texture is an animated fire: its sparks are not matched) | O1 | `frames 01_NYC_UNATCOIsland [laser1,laser2]` [worker] | PASS |
| 4.2.25 | viewport flash | EndFlash equals D3DDrv; the flash pass draws | O2 | `d3d-endflash` [oracle], `flash-play` [worker], `player-alterations-census` [node] | PASS |
| 4.2.26 | 00_Training held viewport flash | two held flash states (scale 0.5 with the fog cut to 0 by `ViewFlash`; fog (153,115,102) at alpha 255) against the original's frames under CrossOver: the flash as a per-channel map of levels (each program's frame with it from its own frame without it) equal at every level, and the frames | O1 | `frames 00_Training [flashA]` [worker], `frames 00_Training [flashB]` [worker] | PASS |
| 4.2.27 | vertices and visibility | Render.dll's projection, D3DDrv's vertices and OccludeBsp equal the original | O2 | `frame-projection` [oracle], `frame-projection-movers` [oracle], `frame-projection-play` [worker], `master-frame-play` [worker], `bsp-occlusion` [oracle] | PASS |
| 4.2.28 | security cameras | ViewportWindow windows on four maps match the original's computer screens | O1 | `camera 14_OceanLab_Lab cs1` [worker], `camera 02_NYC_BatteryPark bp2` [worker], `camera 06_HongKong_WanChai_Market hk0` [worker], `camera 09_NYC_Ship sh3b` [worker] | FAIL |
| 4.2.29 | camera with a mirror, sky, fog or corona in view | a camera frame against the original | - | missing: no capture yet. The census of the shipped cameras ([camera view census](camera-view-census.md)) found 6 of 155 cameras with a mirror in view, 25 sky, 5 fog, 4 a corona; of the thirteen 4.2.28 windows two already hold fog by Play's rule (Ship 1 faintly, Ship 2 heavily), not judged for it | MISSING |
| 4.2.30 | 06_HongKong_WanChai_Underworld mirrored panes | the dance floor in the mirrored panes at a held Strobe against the original: both states (lit and dark) at two cameras, the floor seen only in the panes and two panes beside the direct floor | O1 | `frames 06_HongKong_WanChai_Underworld [uw_s0]` [worker], `frames 06_HongKong_WanChai_Underworld [uw_s1]` [worker], `frames 06_HongKong_WanChai_Underworld [uwd_s0]` [worker], `frames 06_HongKong_WanChai_Underworld [uwd_s1]` [worker] | PASS |
| 4.2.31 | animated mesh skins and DT_SpriteAnimOnce | frames no shipped class, actor or script reaches | - | excluded: unreachable: documented in particles.md and texture-animation.md | EXCLUDED |
| 4.2.32 | UseVertexFog, Glide fog, wireframe and particle mesh branches | options the shipped D3D configuration does not use | - | excluded: unreachable in the shipped game (roadmap section 4, census-lodmesh-branches.mjs) | EXCLUDED |
| 4.2.33 | swimming and drowning visuals | water entry, underwater movement and the drowning flash | - | excluded: Stage 5 (swimming is a gameplay system) | EXCLUDED |

### 4.3 Sound

| Id | Scene | Criterion | Ev. | Checks (mode) | Status |
| --- | --- | --- | --- | --- | --- |
| 4.3.1 | ambient and script sounds | PlaySound, StopSound, Update, volumes and the ambient scan equal Galaxy.dll | O2 | `native-galaxy-audio` [oracle], `galaxy-volumes` [oracle] | PASS |
| 4.3.2 | sound effects | sample voices and both buses' PCM equal Galaxy.dll's mixer | O2 | `galaxy-effects` [oracle], `galaxy-mixer` [oracle] | PASS |
| 4.3.3 | zone reverb | reverb coefficients and the SSE kernel equal Galaxy.dll | O2 | `galaxy-reverb` [oracle] | PASS |
| 4.3.4 | music | IT loader, sequencer and Update's music section equal Galaxy.dll | O2 | `galaxy-music-sequencer` [oracle], `galaxy-music-update` [oracle], `galaxy-music-loader` [oracle] | PASS |
| 4.3.5 | Island, Training and the intro in Play | ambient voices, music and window sounds reach the mixer in the worker and the worklet | O3 | `galaxy-music-host` [worker], `galaxy-music-play` [node], `galaxy-effects-play` [node], `window-sound-play` [node], `window-sound-browser` [worker] | PASS |
| 4.3.6 | 06_HongKong_WanChai_Underworld, 400 ticks: a pistol picked up, drawn and fired | the original's Galaxy PlaySound calls of the scene against Play's replay: every call's sound, emitter, volume, radius, pitch, channel id and order | O1 | `sounds 06_HongKong_WanChai_Underworld (sndm5)` [worker] | PASS |
| 4.3.7 | 00_Training, captured from the launch: the title map, a console `open 00_Training`, a walk and a jump, `MUSICORDER 2` (4,851 callbacks): Galaxy's output buffer | every byte Galaxy's timer callback copies into the DirectSound buffer, and where it lands, equals the translation's when the original's library calls and cursor positions are replayed (music and PCM effect voices); Play places the music bus D bytes ahead of the effects bus, D = 8,820 measured; speech through Galaxy's ring transport against the original's instructions (criterion adopted 2026-10-16, [audio output scope](audio-output-scope.md) §6) | O1, O2 | `galaxy-output-callback` [oracle], `galaxy-output-poll` [stored], `galaxy-output-replay` [stored], `galaxy-output-play` [node], `galaxy-ring-voice` [oracle] | PASS |

### 4.4 Text and interfaces

| Id | Scene | Criterion | Ev. | Checks (mode) | Status |
| --- | --- | --- | --- | --- | --- |
| 4.4.1 | fonts and text layout | font load, glyph metrics, text layout and the parser equal the original | O2 | `text-parser-diff` [oracle], `text-layout-diff` [oracle], `font-load` [oracle], `font-load-graph` [oracle], `gc-get-text-extent` [oracle], `gc-draw-text` [oracle] | PASS |
| 4.4.2 | GC drawing | every GC native (draw, state, clip) equals Extension.dll | O2 | 50 validators (gc-get-text-extent, gc-draw-text, gc-set-text-color, ...) [oracle] | PASS |
| 4.4.3 | window system | window natives, hierarchy, focus, input, scroll and list equal Extension.dll | O2 | 91 validators (window-baseline-play, window-background-smoothing, window-list-family, ...) [node/oracle/worker] | PASS |
| 4.4.4 | text and edit windows | TextWindow and EditWindow natives equal Extension.dll | O2 | 50 validators (edit-insert-text, text-set-text, text-set-text-timeout, ...) [oracle] | PASS |
| 4.4.5 | 00_Training HUD | the HUD tree, belt, ammo, log and glyph output run on the original bytecode and natives | O3 | `play-hud` [node] | PASS |
| 4.4.6 | player screens and menus | inventory, health, augmentations, skills, goals, conversations, images, logs, quotes, augmentation add and the main menu open, draw and close; Settings screens take input | P | `census-ui-screens` [node], `settings-play` [worker] | PASS |
| 4.4.7 | Training datacube | DeusExText, the parser and the information window read a datacube through the real frob path | O3 | `datacube-read` [node] | PASS |
| 4.4.8 | computers and security | ComputerWindow playback and the terminals reach screens through the real frob path; camera screen in the browser | O3 | `terminals-play` [node], `terminals-camera-browser` [worker], `window-computer-playback` [oracle], `window-computer` [oracle] | PASS |
| 4.4.9 | Training keypad | the keypad window takes input through the original path | O3 | `keypad` [node] | PASS |
| 4.4.10 | InfoLink, DataLink and conversation windows | the DataLink transmission, the InfoLink window and conversation screens run the original bytecode | O3 | `instructor-conversation` [node], `infolink-shell` [node], `infolink-content` [node], `conversation-tile` [oracle] | PASS |
| 4.4.11 | 00_Training HUD | the HUD, belt and log in a frame against the original's: the health display, compass, key ring and a belt slot with its item, a log line and its timeout | O1 | `interface 00_Training (3 views)` [worker] | PASS |
| 4.4.12 | persona screens | inventory (empty and with an item), health, skills, goals and notes, logs, images, conversations and augmentations in a frame against the original's | O1 | `interface 00_Training (9 views)` [worker] | PASS |
| 4.4.13 | main menu and Settings | the main menu, the Settings menu, Game Options and Adjust Colors in a frame against the original's | O1 | `interface 00_Training (4 views)` [worker] | PASS |
| 4.4.14 | datacube, keypad and computer screens | a datacube's information display, the keypad and a security computer's screen (four maps) in a frame against the original's; the screen outside the camera windows | O1 | `interface 00_Training (2 views)` [worker], `terminal 14_OceanLab_Lab cs1` [worker], `terminal 02_NYC_BatteryPark bp2` [worker], `terminal 06_HongKong_WanChai_Market hk0` [worker], `terminal 09_NYC_Ship sh3` [worker] | PASS |
| 4.4.15 | Load Game, Save Game, QuickSave screens | the save-game directory screens | - | excluded: Stage 6 (saved games; native 3013) | EXCLUDED |
| 4.4.16 | multiplayer menus and screens | the multiplayer join, host and in-game screens | - | excluded: multiplayer is the last priority and may stay unsupported (AGENTS.md) | EXCLUDED |

### 4.5 Speech, lip sync and the conversation camera

| Id | Scene | Criterion | Ev. | Checks (mode) | Status |
| --- | --- | --- | --- | --- | --- |
| 4.5.1 | lip sync analysis | Galaxy.dll's window, FFT and letter choice equal the Rust kernel | O2 | `galaxy-lipsync` [oracle] | PASS |
| 4.5.2 | 01_NYC_UNATCOIsland MeetPaul | speech reaches the lip-sync channels and Paul's mouth follows the letters | O3 | `island-lipsync` [node] | PASS |
| 4.5.3 | 01_NYC_UNATCOIsland MeetPaul camera | CreateConCamera, the letterbox raw background, the render viewport clip and the player in behind view | O3 | `island-conversation` [node], `root-raw-background` [oracle], `root-render-viewport` [oracle], `conversation-move-camera` [node] | PASS |
| 4.5.4 | speech timing and audio | speech lookup, sound length and the retained archive equal the original | O2 | `conversation-sound-length` [oracle], `conversation-audio-integration` [node], `conversation-speech-audio` [oracle], `infolink-audio` [node], `conversation-speech` [oracle] | PASS |
| 4.5.5 | MeetPaul frame | the third-person conversation frame (letterbox, behind view, camera, subtitles) against the original's | O1 | `conversation 01_NYC_UNATCOIsland cvA (4 frames)` [worker] | PASS |
| 4.5.6 | speech audio | the speech samples the player hears against Galaxy's | - | excluded: the user's decision (2026-10-16): speech stays decoded by the browser's MP3 decoder, not a port of Galaxy's MPEG decoder; lip sync runs the translated analysis on those samples (docs/lip-sync.md) | EXCLUDED |
| 4.5.7 | 00_Intro camera shots | the intro's CameraPoint shots against the original | O1 | `conversation 00_Intro in2 (3 frames)` [worker], `native-find-base` [oracle] | PASS |
| 4.5.8 | 01_NYC_UNATCOHQ MeetManderley | a conversation on another map, with the third-person camera, lip sync and speech (the lines and their timing; the audio samples are 4.5.6) | O1 | `conversation 01_NYC_UNATCOHQ mmA (2 frames)` [worker], `conversation 01_NYC_UNATCOHQ mmB (2 frames)` [worker] | PASS |

## How the gate judges

**Evidence classes.** Every check is one of four kinds; the criteria tables name the kind next to each criterion (column Ev.).

| Class | Meaning | Enough alone for a rendered or played result? |
| --- | --- | --- |
| O1 | Play compared with the original's own output for the same inputs: its framebuffer (`Shot`), its per-tick state trace, its call log. Read from stored results; the gate never starts DeusEx.exe. | Yes |
| O2 | A translation compared with the original DLL's code executed unchanged (Unicorn, `NATIVE_PROBE_PYTHON`) or on real x87. Inputs are fabricated or captured. | No: it proves a function, not a scene |
| O3 | O2 on the inputs Play itself produced while running the scene (the lights, the camera, the voice list it really had). | Yes for the part it covers, if the scene is the criterion's |
| P | Play against itself or against its own earlier output: reach, integration, "opens and closes". | Never |

**Mode.** Each check also names how it exercises Play: `worker` (a headless Chromium on Play's default page, the simulation in the worker),
`inline` (the check forces `?sim=inline`, which is not the default), `node` (Play's simulation modules driven headless in Node: no page and no
worker transport) and `oracle` (the original's code under Unicorn or a probe, no Play at all). An `inline` check that passes is reported `INLINE`,
not `PASS`: the project's rule is that browser checks run in worker mode with a sim-side probe call instead.

**Status words.** `PASS`; `FAIL` (a check ran and is off); `NO-ORIGINAL` (a stored original it needs is in no store the gate reads); `SKIPPED` (the
validator printed `SKIP`, so it proved nothing); `INLINE` (above); `MISSING` (no check exists for the criterion: the reason is printed); `EXCLUDED`
(out of Stage 4: the stage or the reason is printed). Everything except `PASS` and `EXCLUDED` keeps the gate red.

**Judgement chosen in the gate.** These numbers are not from the original; they are the gate's, set from the first runs of 2026-10-15. Each
says why it has its value and how strong that reason is.

| Choice | Value | Why |
| --- | --- | --- |
| Edge recall of a matched frame | at least 0.90 | The weakest non-flat view in the 12 frozen maps reads 0.919. Weak: the threshold sits just under the weakest passing view. |
| Edge precision | at least 0.85, except the flat views | The weakest non-flat view reads 0.890. Weak, same reason. |
| Outlier blocks | none | The metric flags 16x9 blocks whose luminance ratio is 1.6x off the frame's median; every currently clean view has none. Strong: a missing or extra object shows up as one. |
| Sub-pixel offset | at most 0.25 px where measurable | The pixel-centre defect was 0.5 px; the measured offsets are 0 to 0.125. Strong. |
| Flat views | recall and outlier blocks only | In flat, nearly black views the strongest 5% of gradients are texture noise and the precision reads low with no visible difference ([visual acceptance](visual-acceptance.md#results), "Flags explained by the metric"). Eight views are listed in `FLAT_VIEWS` (Club y1, y2, y3, down; Airfield y1; Smug y0, y1; Ship y2); Smug y0 and y1 are my addition, with the same pattern. Weak: chosen by reading the table. |
| Explained blocks | up to two outlier blocks in Street y2, Street y3 and Garage garage2 | The panning sky follows `Level.TimeSeconds` and the animated light maps' noise state is not shared, both documented as host inputs; the first runs differed by one block in Street and two in the Garage, and by different views between runs. Weak: the allowance was read from the runs. |
| Brightness | not judged | Play's raw frames are 1.1 to 1.45 times the original's under Wine: a known Windows gamma issue, kept out of scope on the user's instruction. Security-camera windows are captured at Brightness 2/3, where the ramp is the identity. |
| Security-camera window | mean abs. difference at most 1.0, edge recall and precision at least 0.90 | The documented values with the sampling state and display-space filtering are 0.00 to 0.15. The precision of a Battery Park window moved between .948 and .99 across runs (two walking actors), hence 0.90. Weak. |
| Matched capture settings | `?antialias=0`, `?detailTextures=0` | Every stored original lacks multisampling, and all but 4.2.22's lack the detail pass (Wine's and CrossOver's devices have no `BLENDDIFFUSEALPHA`; 4.2.22's frames were taken with the pass poked in, and Play keeps its pass for them, `detail: true`); Play's defaults (both on) stay as they are. |
| Interface frames | at least 99% of the pixels identical, at most 64 pixels off by more than 10 of 255, mean absolute difference at most 0.1, edge recall and precision at least 0.99, no outlier block; a security computer's screen outside its camera windows: at most 20 pixels off by more than 2 and none by more than 10 | The 18 views are within 2 of 255 everywhere but one world scanline of 57 pixels (up to 27 levels) and, in the datacube view, 90 pixels of at most 13 levels. Strong for what it excludes: Play before the two fixes fails every frame they changed (the closest has 105 pixels over 10). Weak for the margins (7 pixels over the worst measured, .9922 against .99). The four terminal screens read 0 pixels over 2 outside the camera windows (the largest difference 0), so the 20-pixel allowance is a margin, not a measurement. |
| Conversation frames | the letterbox bars and the subtitle: no pixel off by more than 2 of 255; the 3D band: at least 94% of its pixels identical and at most 1,300 off by more than 10; edge recall and precision at least 0.99; no outlier block; and, over the longest replay, every watched actor, the clock and the stream draws equal except the measured exceptions (the player's `AnimFrame` at ticks 1-5, two guards' `LastRenderTime` at tick 1) | The four MeetPaul frames read: bars and subtitle identical to the pixel (maximum difference 0), the band .954 to .981 identical with at most 1,053 pixels over 10 (polygon edges and the glasses' glints), edges at least .997, no outlier block; the 88 watched actors equal for 750 ticks. **The values are my choice**: 20% to 25% above the measured worst. Strong for a misplaced bar or viewport (the replay harness defect fixed 2026-10-16 read .33 identical, 349,313 pixels over 2), wrong text or colour, a shifted camera; weak for the polygon edge. The mouth is gated by the actor comparison, not the pixels: the face is a few hundred pixels (the frame numbers move by about 700 over 10 without the feed), but without the measured phonemes the player's blend channel differs at tick 8 and Paul's at tick 145 (checked 2026-10-16), which the actor comparison rejects. |
| Effect contribution (the frame with an effect less the frame without it, original against Play) | correlation at least .90, Play's sum within 8% of the frame's brightness ratio times the original's, agreement at least .98; an effect drawn with a FireTexture (a LIVE check's `floorShots`): Play's median agreement over every Play/original frame pair at least the original's minimum against itself | The Bar's haze: .93, .93 and .99, 1% to 4%, 1.0; the other views' differences are .0 to .37. Weak: three views, and the original's two frames are two captures (the animated light maps' noise state is in their difference). The steam (row 4.2.13): its puffs change every drawn frame, and the original's four held frames read .867 to .934 against each other; the floor rule (adopted 2026-10-16) passed 4 of 8 runs, and was superseded on 2026-10-17 by holding the texture at the original's pixels (`fireHold`): correlation 1.000, gap 1.000, agreement 1.000 in 5 of 5 runs at the thresholds of this row. Training's shadows (an effect that darkens: its own pixels are those at least one level darker) read 1.0, 0% and 1.0 in both views; a view with an animated screen in it read .945 and .78 with the shadows bit-equal, so such a view is not used. The detail pass (darkens) reads .993 to 1.0, 0% to 0.2% and .998 to 1.0 in its four views. |
| Shadows' state at the shot (4.2.15) | every Shadow of the original found in Play by its owner; the same shadows drawn; bHasDecal and the surface count equal; owner Location equal where attached in either; Location, DrawScale and Rotation equal where attached in both | No tolerance: compared as float32, bit for bit (the original's values printed with `%.9g`). Measured equal in both views (19 of 19). Strong for the decal's inputs: a walker mid-walk at the shot (37 units apart), a shadow attached in one program only (ScientistMale0 before the camera transit) and a camera order that froze the player's shadow elsewhere each failed it. |
| Laser beams' geometry (64 x 64 blocks of red excess) | blocks with beam in both, of either, at least .85; Play's energy over the original's .75 to 1.33; y-offset of the centroids at most 2.5 px rms | .94 and .88; .87 to 1.01 over runs; 1.3 and 1.6 px, against the original's own two frames 1.0, .99 and .3 px. Weak: two views; the beam texture is an animated fire (an unmatched host input) that moves the energy by 10% to 15% between runs. |
| Live-scene tolerance | every watched field of every actor, the clock and the stream draws equal; a stream-draw-only difference is repeated once | The Underworld's draw count differed at tick 45 on some replays (two of two fresh runs, then 1 of 4 to 4 of 5 in six batches): attributed 2026-10-16 to the player's animation flags at the start of the replay (`bAnimNotify` 0 when the replay began before the ghost's own script had started its `Tread` loop, so its `PlayFootStep` `FRand` was missing) and fixed in the harness; 10 of 10 replays are equal since and the gate reports `flaky: false`, so the repeat is no longer needed for this map. The allowance stays until the user removes it; a repeat that passes is still reported as `flaky`. |

**Real-x87 probes.** `window-scene-frame` runs a small probe executable under Wine to measure `appTan` on hardware. The gate points those validators
at `/usr/bin/wine` and the `~/.wine-deusex` prefix when they exist (`X87_PROBE_WINE`, `WINEPREFIX`); it starts no DeusEx.exe.

## The scenes

The list is finite on purpose: a scene is here because a stored original-side result exists for it, or because the campaign needs it and the gate
says `MISSING`. **The choice of these scenes is mine; only the first column's reason is strong where it says so.** If a scene is not representative,
change the row in `scripts/validate-stage4-acceptance.mjs`; nothing else depends on it.

| Scene | Clauses | Why it is here |
| --- | --- | --- |
| `00_Training`: the start views, the entrance floor mirror, the corridor lights, the gallery's pawns' shadows, the HUD, a datacube, the keypad, the DataLink, the Esc menu | actors, effects, text and interfaces | Strong: the first mission, the only map every interface probe reaches today, the map Stage 3's gate boots, and the best-compared mirror and light-map surface. |
| `01_NYC_UNATCOIsland` (Liberty Island) | actors (88 live), effects (sky, water, skyline, lasers, a barrel fire), sound (six ambient voices, music), conversation (MeetPaul) | Strong: the campaign's first outdoor map and the only third-person conversation with an object-index capture. |
| `02_NYC_BatteryPark`, `03_NYC_AirfieldHeliBase` | effects (street-lamp coronas), actors (Battery Park is the one sweep map that does not replay equal), cameras | Weak: two outdoor maps with coronas; any two would do. |
| `04_NYC_Street` | effects (steam vents, panning sky, Spotlight and Cylinder lights) | Medium: the steam is the only particle effect the stored frames could hold. |
| `08_NYC_Bar` (frames) and `02_NYC_Bar` (fog, translucent mirror, validators only) | effects | Weak: the frames are of `08_NYC_Bar` because that is what was captured; the fog and the mirror the validators exercise are `02_NYC_Bar`'s. This is why fog has no frame. |
| `02_NYC_Hotel` | effects (opaque unlit bathroom mirror), actors (13 live) | Medium: the campaign's hotel; its mirror has no stored frame. |
| `10_Paris_Club` | effects (Disco floor, wall mirrors), actors (22 live, dancers in view) | Strong: the densest stored coverage of one map. |
| `06_HongKong_WanChai_Underworld`, `_Garage`, `_Market` | effects (mirrored panes at a held Strobe, Searchlights), actors (50 live), cameras | Medium: each has a stored original of a different effect. |
| `09_NYC_Ship`, `09_NYC_ShipFan`, `09_NYC_ShipBelow` | effects (Rotor, SlowWave, corona behind a mover), cameras (a door half open) | Medium: the only moving-brush-tracker corona case. |
| `14_OceanLab_Lab` | effects (glass), cameras | Strong for cameras: the best-matched windows (mean abs. difference 0.00 to 0.15 documented). |
| `11_Paris_Everett`, `02_NYC_Smug`, `03_NYC_747` | effects (a standing mirror, a window mirror, a mover mirror) | Weak: three stored mirror maps; Everett's is the standing mirror. |
| Cross-map: Galaxy (ambient, effects, reverb, music), fonts and windows (Extension.dll), conversation timing | sound, text, speech | The code is shared by every map, so the checks run on Training, Island and the intro and on the DLLs' own inputs. |

Not scenes, by decision: the other 60-odd maps (the all-maps census covers their Stage 3 startup, not their presentation), multiplayer, and the
Stage 5 and 6 systems listed under [Excluded](#excluded). A map not in the table is not claimed.

## Evidence by clause

What each clause rests on, in plain words. The criteria tables above give the ids; this is the reading of them.

**Animated actors.** Three things compare Play's actors with the original's. Matched frames show meshes, poses and lighting at the map's frame-0 pose
(4.1.1). The per-tick replay compares every watched field of every NPC with the original's own trace while they walk, dance and animate
(4.1.5 to 4.1.8): this is the strongest actor evidence and covers animation, because `AnimSequence`, `AnimFrame`, `AnimRate`, `TweenRate`, blend
channels and `Rotation` are among the fields. The code path under both (GetFrame, LOD, skins, lighting, the animation phases) is compared with
Engine.dll and Render.dll executed unchanged (4.1.2 to 4.1.4). The player's pistol and MedKit in a mirror's child frame are compared with the running
original's logged draws (4.1.11). Not covered: the first-person weapon (4.1.10), an armed NPC in a child frame or a camera window (4.1.12), and anything that
needs the player to move or act while an NPC is watched.

**Effects.** Each effect has the same two layers: its translation against the DLL's code (O2, and O3 on Play's inputs), and a matched frame
where the original was captured with the effect in view. Where only the first exists the row says `MISSING` and names the frame that is
absent: today a camera window with a mirror, sky, fog or corona in view (4.2.29); the particles, decals, fog,
lasers, the Hotel mirror, the flash, the detail pass and the Underworld's mirrored panes at a held Strobe have their frames since 2026-10-16.

**Sound.** All of it is O2 and O3: Galaxy.dll's functions (PlaySound, Update, the mixer, the effects voices, the reverb, the IT sequencer) run
unchanged under Unicorn and Play's translations match them bit for bit on large corpora; the Play-side checks show the worker and the worklet
reach those functions with real scene inputs. Nothing compares what the speakers get, and nothing compares a live scene's sound calls (4.3.6, 4.3.7).

**Text and interfaces.** The window system, GC drawing, text, edit, list and scroll windows are compared with Extension.dll natives one by one
(hundreds of cases per family); the HUD, a datacube, a computer, the keypad and the DataLink run the original bytecode through the real frob and input
paths. The first run found that **no frame of the original's HUD, menus or screens had ever been compared with Play's** (4.4.11 to 4.4.14); [interface frames](interface-frames.md)
now compares 18 views of 00_Training pixel for pixel (equal to within 2 of 255 apart from one scanline of the world), which found and fixed two divergences. Still not compared
in a frame: a computer's login screen (the four security terminals' screens after login are, outside their camera windows), the DataLink, InfoLink and conversation windows, a held weapon's ammo display, another map's HUD or another resolution.

**Speech, lip sync and the conversation camera.** Galaxy's lip-sync analysis equals the DLL bit for bit, MeetPaul runs end to end with the camera,
the letterbox and the render clip checked against Extension.dll, and Paul's mouth follows the letters in the browser. The conversation frames of MeetPaul (4.5.5),
the intro (4.5.7) and MeetManderley (4.5.8) are compared with the original's own frames (2026-10-16); the speech audio is not (4.5.6).

## What exists and the gate does not run

The inventory behind the criteria (every `scripts/validate-*.mjs`, the three acceptance scripts and the docs they name) turned up evidence the
gate leaves out on purpose. Nothing here is a claim; it is the list a reader should know exists.

- **Hardware probes that fix constants.** `validate-x87-ftol-hardware`, `-nan-hardware`, `-tan-hardware`, `-transcendental-hardware` and
  `validate-msvcrt-text-hardware` run small executables under Wine or CrossOver on real x87 (`tools/*.c`) and compare them with the models the
  O2 checks use. They need Wine and skip loudly without it; of them the gate runs `window-scene-frame` (inside 4.4.3) and none of the others. Their results are cached in `.cache` and the O2 checks
  consume them (the lip-sync twiddles, the reverb coefficients, `appTan`).
- **Diagnosis tools over stored captures.** `live-events-compare.mjs` (the AI event manager's calls of a pistol and an assault shotgun, 1,069 and
  1,586 manager calls equal), `live-pick-compare.mjs` (pick-by-pick path choices), `live-draw-attr.mjs` / `live-draw-shift.mjs` (stream attribution),
  `live-sound-compare.mjs` (the original's PlaySound calls against Play's). They compare against the original's call logs but each wants one
  specific capture; only the sound one has a row (4.3.6, `FAIL`: the strict `--gate` mode runs in the gate from the stored `snd1` capture).
- **Play against itself.** `validate-gpu-mesh` (the GPU passes equal the CPU kernels, the CPU path being the reference), `mesh-path-frames`,
  `world-batch-gpu`, `light-atlas-upload`, `sim-split`, `scene-matrices`, `hitch-log`, `actor-mesh-scene`: host rendering and plumbing, evidence
  class P. They keep the frame cost and the page honest; they say nothing about the original.
- **The armed pawn's frame.** The Island view of the pistol (`wpn1` to `wpn3`, `rif1`; edge recall .99 and no outlier block, [visual
  acceptance](visual-acceptance.md#divergences-found), Divergence 21) is an O1 result whose stored frames sit in an agent worktree and whose
  camera needs `CheatView`; 4.1.9 keeps the Unicorn comparison and the in-situ original draws instead.
- **The 130-frame table of 26 maps.** The gate runs 12 of its maps; the others (UNATCO HQ, the Helibase, VersaLife, the Dockyard, the Chateau, the
  Cathedral, the Vandenberg and Area 51 maps, the Silo and so on) are in `docs/visual-acceptance.md` and the same command re-runs them
  (`visual-acceptance.mjs play --maps ...`, `compare`).
- **The Stage 3 families.** About 130 `script-*`, `native-*`, `pawn-*` and `walk-*` validators (bytecode, natives, physics, AI) are what the rows
  above run on; the Stage 3 gate and the full sweep (`npm run validate -- --jobs 4`) own them.

## Excluded

These keep the gate neither green nor red; each names the stage or the reason.

- **Speech audio decoding** (4.5.6): the user decided on 2026-10-16 to keep the browser's MP3 decoder for speech rather than port Galaxy's
  MPEG decoder. Speech plays and lip sync runs Galaxy's translated analysis on the browser-decoded samples; the samples themselves are not
  claimed equal to the original's.
  **Not covered by that exclusion: speech bypassed Galaxy's voices (found 2026-10-16), fixed the same day** (fa359b3, merged 98b4a4d;
  [galaxy audio](galaxy-audio.md#speech-through-galaxys-voices-2026-10-16), [lip sync](lip-sync.md)). The page had played conversation and DataLink
  lines through their own Web Audio source at a fixed gain, with no distance factor, pan or category ratio, and barks were silent (they reached Galaxy, but
  the translated `glxLoadSample` rejects MP3: fault 0x130). Now the ConPlay and DataLinkPlay PlaySound/StopSound sites take the original chain (`execPlaySound`,
  `CheckHearSound`, `execClientHearSound`, Galaxy's PlaySound on slot 5, StopSoundId), and Update sets the voice's distance factor, pan and speech ratio every
  frame. The radii are the original's: ConPlay.PlaySpeech's 65536 (512 + initialRadius for an interruptible first-person conversation) and BarkManager.StartBark's 1024.
  **Labelled stand-in:** a speech MP3 registers as a host-decoded record shaped like the WAVE loader's 16-bit mono record, with the MPEG header's rate as the
  loader's +0x3c; the page decodes it (OfflineAudioContext, 16-bit) and Galaxy's mixer plays it on bus B with the zone reverb (glxStartSample's non-ring branch).
  The original streams speech through a 0x4024 ring voice fed by a decoder thread, so the record, the decode and the start latency stay unverified with 4.5.6.
  Lip sync is Update's step 12 over Galaxy's channels on the same samples, at the mixer's read head. Checked: `island-bark` sweeps a bark's voice over distance and
  direction against Update's formulas (21503 down to the 0x80 floor at 1,100 units, centred straight on, pan 25940/6827 at ±60°, each within 2 units of
  the recomputed value), `island-lipsync`, `galaxy-effects-play` (hold, attach, mix, end and release in the worklet) and the conversation flows; the oracle
  validators are unchanged and pass. Not run: `browser-tests/instructor-conversation.spec.mjs` (its patch of main.mjs no longer matched before the change), the
  speech-volume slider's test sound, and a frame-time A/B.
- **Swimming and drowning visuals** (4.2.33): Stage 5, a gameplay system (ladders and flying are done, swimming is next in
  [Stage 5](roadmap.md#5-implement-the-full-gameplay-systems)).
- **Load Game, Save Game and QuickSave screens** (4.4.15): Stage 6, they stop at the save-game directory (native 3013).
- **Multiplayer screens** (4.4.16): the last priority, allowed to stay unsupported.
- **Inside row 4.3.7** (the user's decisions of 2026-10-16, [audio output scope](audio-output-scope.md) §6 and §7): unreachable on the reference machine or
  in the shipped data, so not claimed: hardware 3D voices (no A3D or EAX), ADPCM WAVs and the `'AS  '`, `.snd`, `SCRS` and MPEG-in-WAV loaders (none shipped:
  `scripts/census-sound-formats.mjs`), the WinMM fallback and the non-SSE kernels. Host output, not claimed: the callback schedule (Play's fixed 882-frame
  callbacks), D's host part (pinned as a measured input), and everything after the DirectSound buffer (dsound or the browser's ring, resampler, device and latency).
- **Animated mesh skins and `DT_SpriteAnimOnce`** (4.2.31): no shipped class, map actor or script reaches them
  ([particles](particles.md#dt_spriteanimonce-0x10b252ac0x10b25392-restored-at-0x10b254d3), [texture animation](texture-animation.md#play)).
- **`UseVertexFog`, Glide's fog pass, `RendMap` wireframe and particle mesh branches** (4.2.32): not used by the shipped D3D configuration or
  reachable from a script (`census-lodmesh-branches.mjs`).

## Stored originals

The gate reads results of the original that earlier sessions captured under Wine; none is in Git. The tooling keeps them under `.work/` in
whichever checkout took them, so today they are scattered. The gate searches the colon-separated directories of `DX_ORIGINALS`, or by default
this checkout's `.work`, the main checkout's `.work` and the main checkout's `.work/live/.work` (the tree the original is driven from), takes
each criterion's inputs from one root (the first that holds them) and links or copies them into its own `.work` (never into a file Play writes).

**Two machines.** "main" below is the Linux host's main checkout (`~/projects/deus_ex_web`, where the first run was made). On 2026-10-16 the Mac's main checkout
held none of these stores, so a gate run there reads `NO-ORIGINAL` for every row below except the ones marked *Mac*. The Linux host was unreachable that day,
so its stores could not be listed; that they are all there is inferred from where the first run was made. Captures can now be taken on either machine:
`scripts/live-original.sh` and `scripts/original-views.sh` drive the CrossOver bottle `DeusEx` on the Mac (CrossOver's wine, no `flock`, no Hyprland, the game's process found by its Windows path), and
the debugger tools (`ad/build/dx-live-win.exe`, `dump-actor-win.exe`, built with `i686-w64-mingw32-gcc -O2 ... -lpsapi`) break and read the same addresses there.

| What | Where it is today | Used by |
| --- | --- | --- |
| Frozen frames, 26 maps x 5 views, and the held level times | main `.work/acceptance/<map>/{y0..y3,down}-original.png`, `times.json` | 4.1.1, 4.2.1 to 4.2.4, 4.2.8 |
| Effect-aimed frames (Club, Ship's hold, Garage, Street, Training corridor) and their clocks | main `.work/live/.work/acceptance/<map>/<view>-original.png`, `times.json` | 4.2.2, 4.2.5 to 4.2.8 |
| The Ship fan's `fan2` frame and its clock (52.397 s) | worktree `agent-a2ddd75162532fd59` `.work/acceptance/09_NYC_ShipFan/fan2-original.png`, `times.json` | 4.2.6 |
| The Club dancers' frame | worktree `agent-ab57e232707486ccf` `.work/acceptance/10_Paris_Club/cvclub-original.png` | 4.1.6 |
| Pilot traces of 2026-10-15 (Island, Club, Underworld) with their watch and population lists | worktree `agent-ab57e232707486ccf` `.work/live-acceptance/<map>/original-trace*.jsonl` | 4.1.5 to 4.1.7 |
| The 28-map sweep's traces (2026-10-13) | main `.work/live/.work/live-acceptance/<map>/original-trace-sweep.jsonl` | 4.1.8 |
| BatteryPark's fresh exact-population load, 1,200 ticks (2026-10-16, tag `sweep2`; the sweep's own BatteryPark load, tag `sweep`, held a chance FlyGenerator Play's load lacks and is kept, unread by the gate) | main `.work/live-acceptance/02_NYC_BatteryPark/original-trace-sweep2.jsonl` with `watch-`, `population-` and `commands-sweep2.json` | 4.1.8 |
| Security-camera frames and measured state | worktree `agent-a011db8f1b061eb8e` `.work/acceptance/<map>/{cs1,bp2,hk0,sh3}-original.png`, `-state.json` | 4.2.28 |
| The Ship camera recaptured with the level's movers measured (2026-10-16, tag `sh3b`, level time 132.264 s in `sh3b-time.txt`; the first `sh3` capture is kept) | main `.work/acceptance/09_NYC_Ship/sh3b-original.png`, `.bmp`, `-state.json` (with `movers`) | 4.2.28 |
| MeetPaul's four held frames (2026-10-16, tag `cvA`, ticks 100/250/600/750, each with `cvA<n>-time.txt`), the 750-tick trace with the player's blend channel, the watch and population lists, the commands and the measured phonemes | main `.work/acceptance/01_NYC_UNATCOIsland/cvA{1..4}-original.png`, `.work/live-acceptance/01_NYC_UNATCOIsland/{original-trace,watch,population,commands,hold,phonemes}-cvA.*` | 4.5.5 |
| The intro's three held frames (2026-10-16, tag `in2`, ticks 170/1000/2250, each with `in2-in<n>-time.txt`) and its 2,250-tick trace with the watch and population lists and the commands | main `.work/acceptance/00_Intro/in2-in{1,3,4}-original.png`, `.work/live-acceptance/00_Intro/{original-trace,watch,population,commands,hold}-in2.*` | 4.5.7 |
| MeetManderley's frames and traces (2026-10-16, tags `mmA` 1,100 ticks and `mmB` 580 ticks, two loads; frames mm2, mm3, mmB1 (stored, not compared: the letterbox is still sliding at tick 40 in Play), mmB2, mmB3 with `-time.txt`) | main `.work/acceptance/01_NYC_UNATCOHQ/{mm2,mm3,mmB1,mmB2,mmB3}-original.png`, `.work/live-acceptance/01_NYC_UNATCOHQ/{original-trace,watch,population,commands,hold}-{mmA,mmB}.*` | 4.5.8 |
| The original's third-person weapon draws | main `.work/weapon/original-cases*.json` | 4.1.9 |
| *Mac*: the original's third-person weapon draws, captured again under CrossOver (2026-10-16): `original-cases.json` 590 Island main-frame draws with the weapon drawn (591 pawn draws of Terrorist22 with `WeaponPistol13`, 1 of ThugMale3 with `WeaponMiniCrossbow1`; `CheatView DeusEx.Terrorist` twelve times, pitch -500, yaw 46936; `weapon 8` and `weapon 16` with the level running). A narrower corpus than the Linux set: no rifle (the `SniperRifle3rd` capture of Terrorist1 was not retaken) and one crossbow draw against 784, `-2` 142 draws of JC's pistol in the lab mirror (`jcm`), `-3` 156 of his MedKit there (`jci`) | Mac main `.work/weapon/original-cases{,-2,-3}.json`, the logs `island-weapon-mac{,-8,-16}.jsonl`, `jcm-weapon-mac.jsonl`, `jci-weapon-mac.jsonl` | 4.1.9, 4.1.11 |
| *Mac*: the lab mirror scenes (2026-10-16, tags `jcm` and `jci`, 300 ticks: `summon` at 20, `ViewRotation (Pitch=-10130,Yaw=16432)` at 50, `ParseRightClick` at 90, `ActivateBelt 1` at 130, `ViewRotation (0,0,0)` at 170; `--no-ghost`, population equal to Play's seed 1) with their held frames (no `-time.txt`: the plain `--shot` path does not write one; the frames are not compared by the gate) | Mac main `.work/live-acceptance/05_NYC_UNATCOMJ12lab/{original-trace,watch,population,commands,hold}-{jcm,jci}.*`, `.work/acceptance/05_NYC_UNATCOMJ12lab/{jcm,jci}-original.png` | 4.1.11 |
| *Mac*: Training's held viewport flash (2026-10-16, Brightness 2/3, camera `-100,840,30:0,0,0`, three captures under CrossOver, each with its `-time.txt` and `-state.json` (the player's `FlashScale`/`FlashFog` after the shot)): `flash0` without the flash (50.800 s), `flashA` scale -0.5 and fog (0.3,0.1,0) (51.001 s; read back scale 0.5, fog 0), `flashB` fog (0.6,0.45,0.4) (50.427 s; read back scale 1, fog (0.6,0.45,0.4)) | Mac main `.work/acceptance/00_Training/{flash0,flashA,flashB}-original.{png,bmp}`, `-time.txt`, `-state.json` | 4.2.26 |
| *Mac*: Training's pawns' shadows (2026-10-16, Brightness 2/3, level time 54.507 s in each `-time.txt`, one capture under CrossOver in the row's order: `shadow2` then `shadow3`, then both after `set WinDrv.WindowsClient Decals False`; mib1 and ScientistMale0 ordered to stand while frozen, the meshes hidden and the level frozen before each shot), each frame with the 19 Shadow actors' state read after it (`-decals.json`). The four earlier captures that found what to hold are kept beside them, unread by the gate | Mac main `.work/acceptance/00_Training/{shadow2,shadow3}{,-base}-original.{png,bmp}`, `-time.txt`, `-decals.json`; `.work/decal15/capture{1..4}/` | 4.2.15 |
| *Mac*: the detail pass (2026-10-16, Brightness 2/3, one capture per map under CrossOver with the render device's `DetailTextures` (`+0x78`) poked to 1 for the views and to 0 for their `-base` frames; each base view taken twice, the second (`<view>b-base`) unread by the gate): Training's walls `detailT1`, `detailT2` (50.629 s), Island's deck `detailI1`, `detailI2` (50.734 s), each with its `-time.txt` | Mac main `.work/acceptance/00_Training/{detailT1,detailT2}{,-base,b-base}-original.{png,bmp}`, `.work/acceptance/01_NYC_UNATCOIsland/{detailI1,detailI2}{,-base,b-base}-original.{png,bmp}`, `-time.txt` | 4.2.22 |
| *Mac*: the Underworld's mirrored panes at a held Strobe (2026-10-16, Brightness 2/3, one capture under CrossOver, the level frozen and the dancers hidden, Render.dll's Strobe flag held for each frame): `uw_s0`, `uw_s1` at (-1081,-2010,-336) yaw 54769 and `uwd_s0`, `uwd_s1` at (-1120,-1900,-336) yaw 55000, each with its own clock in `-time.txt` (the level time just before its shot: 52.418, 52.456, 52.497, 52.536 s) and its hold record in `-strobe-held.txt` (the hold, a poll after the shot, the level time and camera before and after it), and the free-running polls `uw-strobe.txt`, `uwd-strobe.txt`; seven discarded captures beside them, unread by the gate | Mac main `.work/acceptance/06_HongKong_WanChai_Underworld/{uw_s0,uw_s1,uwd_s0,uwd_s1}-original.{png,bmp}`, `-time.txt`, `-strobe-held.txt`, `{uw,uwd}-strobe.txt`; `.work/uw30/capture{1..7}/` | 4.2.30 |
| The interface frames of 00_Training (18 views, 2026-10-15) and each frame's level time | main `.work/acceptance/00_Training/ui-<view>-original.png` and `ui-<view>-time.txt` (also `ui-e1` to `ui-e4`, the pointer experiment) | 4.4.11 to 4.4.14 |
| The Underworld's sound capture (2026-10-13/14, tag `snd1`: a pistol summoned, picked up, drawn and fired in a normal player, 400 ticks; the tracer's `gplay`, `addobj`, `unhash` and `hear` call records, the registry at the frozen start and end) | main `.work/live-acceptance/06_HongKong_WanChai_Underworld/{original-trace-snd1.jsonl{,.strobe,.calls.jsonl},registry-start-snd1.txt,registry-end-snd1.txt,watch-snd1.json,commands-snd1.json,deferred-snd1.json}` (copied 2026-10-16 from worktree `agent-a011db8f1b061eb8e`, nothing overwritten) | 4.3.6 |
| The light manager's tables from the running original | main `.work/live/.work/fpu` | 4.2.9 |
| 02_NYC_Bar's smoke haze: three views with the fog zones on and off (2026-10-16, level time 52.355 s in each `-time.txt`) | main `.work/acceptance/02_NYC_Bar/{fog3,fog5,fog0}{,-base}-original.png` and `-time.txt` | 4.2.17 |
| 02_NYC_Hotel's bathroom mirror, JC's `Tread` frozen (2026-10-16, 52.370 s) | main `.work/acceptance/02_NYC_Hotel/{hotel1,hotel2}-original.png`, `-time.txt`, `-state.json` | 4.2.19 |
| Island's doorway beams, SetupDynamics pinned to rand state 0x2f6e2b1b, the level unfrozen (2026-10-16, 52.363 s; `laser1b` is a second frame of laser1, the original's own variation) | main `.work/acceptance/01_NYC_UNATCOIsland/{laser1,laser2}-original.png`, `-time.txt`, `laser1b-original.png` | 4.2.24 |
| *Mac*: 04_NYC_Street's steam vent (2026-10-17, tag `vents5`, Brightness 2/3, `KillAll FlyGenerator` before the population is listed, Fire.dll's tick held before the frames): 600 ticks with the stream state per tick, the load's generators before the kill, SmokePuff1's held pixels (`fire-vents5.json`), the held frame, three more frames of the same hold (byte-equal to it) and the frozen start's (vents4, the floor capture, and vents2, the Linux host's, are no longer read) | main `.work/live-acceptance/04_NYC_Street/{original-trace-vents5.jsonl (+ .strobe, .actors.jsonl), watch-, population-, commands-, hold-, generators-load-, fire-vents5.json}`, `.work/acceptance/04_NYC_Street/vents5-original.png`, `vents5-original-{2,3,4}.png`, `vents5-base-original.png` | 4.2.13 |
| *Mac*: the Underworld's sound scene (2026-10-16, tag `sndm5`: the `snd1` commands, with the tracer recording AIProcess's stop point and the windows' wall-clock deltas each tick; `snd1` and `sndm` to `sndm4` lack those inputs and cannot replay equal) | Mac main `.work/live-acceptance/06_HongKong_WanChai_Underworld/{original-trace-sndm5.jsonl{,.strobe,.calls.jsonl},registry-start-sndm5.txt,registry-end-sndm5.txt,watch-sndm5.json,commands-sndm5.json,population-sndm5.json,deferred-sndm5.json}` | 4.3.6 |
| *Mac*: Galaxy's output (2026-10-16, under CrossOver): two read-only polls of 00_Training across a console map load (`scripts/galaxy-output-capture.sh`), and the launch capture `replay-training.bin` (23:05, 4,263,809 bytes, SHA256 abdd181a…1ba4ae) with its `.log`; `earlier/` holds three earlier captures, unread by the gate | Mac main `.work/audio-output/{training-load1,training-load2}.{json,pan.bin,poll.txt}`, `replay-training.{bin,log}` | 4.3.7 |

**A clock per frame, not per map, is what a store should keep.** `times.json` holds one level time per map and each capture overwrites it, so
a frame and the clock beside it can come from different captures. Two cases showed up in the first run: the main `.work/live` tree's `fan2-original.png`
is paired with a later clock and Play differs in three blocks, while the capture in the worktree above, with its own 52.397 s clock, matches with
none; and the Underworld's `d_s0` and `d_s1` frames predate the clock stored for their map (54.18 s), so they cannot be reproduced at all and
4.2.30 was `MISSING` rather than failing for the wrong reason (closed 2026-10-16 by a new capture, the *Mac* row above). A capture should write `<view>-time.txt` beside its frame;
a held-Strobe frame's is the level time at its own shot, since the level's clock runs on between the shots of one capture.

**Consolidated 2026-10-15** into the main checkout's `.work`: the pilot traces and the 28-map sweep's (`.work/live-acceptance`, from
`agent-ab57e…`), the lab mirror capture (`.work/live-acceptance/05_NYC_UNATCOMJ12lab`), the Ship fan's `fan2` frame with its 52.397 s clock
(`.work/acceptance/09_NYC_ShipFan`, the clock added to `.work/acceptance/times.json`), the Club dancers' `cvclub` frame and the four
security-camera frames with their state; copied without overwriting anything already there. The paragraph below is the state before.

**These need consolidating before the gate is anyone's routine.** Four of the stores are inside other agents' worktrees, which are removed
when those agents' branches close, and the pilot traces of 2026-10-15 are the only ones that match the current master (the older pilot traces in
the main `.work/live` tree are from 2026-10-13/14). Copy the listed files into the main checkout's `.work/acceptance`, `.work/live-acceptance`
and `.work/weapon` (same relative paths) and the gate needs no `DX_ORIGINALS`. Original-comparison checks that are not in a store at all are
`MISSING` rows below.

## Running the gate

```bash
# a new checkout under .claude/worktrees needs the setup of the worktree-validator-setup note: symlink node_modules, "Deus Ex GOTY Edition",
# Reference and the .cache entries (including .cache/native-probe-env), and run `npm run build:wasm`; the gate needs nothing else.
DX_ORIGINALS=<dirs> node scripts/validate-stage4-acceptance.mjs --report .work/stage4-gate.json     # all criteria; --report writes the JSON, exits 0
node scripts/validate-stage4-acceptance.mjs                                                           # the gate: exit 1 until every criterion passes
node scripts/validate-stage4-acceptance.mjs --only '^4\.2\.'                                          # a subset (id, clause, scene or criterion text)
node scripts/validate-stage4-acceptance.mjs --list                                                    # criteria, tasks, estimated times, the .work data each reads
node scripts/validate-stage4-acceptance.mjs --markdown .work/stage4-gate.json [--clause 2]            # the scoreboard rows of a report
```

At most two child processes run at once (`--jobs`), each in its own process group; a group over 6 GiB (`--mem-cap`) or past `max(10 min, 4x its
recorded time)` is killed and fails. The matched-frame checks share `.work/acceptance`, so they run one at a time. Native validators get
`NATIVE_PROBE_PYTHON` from `.cache/native-probe-env`. The gate starts no DeusEx.exe; the real-x87 validators start small probe executables under Wine.

## Remaining Stage 4 work, in the order it blocks

From the first scoreboard: 26 of 70 gating criteria were not `PASS` (2 `FAIL`, 3 `INLINE`, 21 `MISSING`); item 1 is closed since (22 now; 10 by the row count of 2026-10-16: 3 `FAIL`, 7 `MISSING`). Ordered by how much of "Done when" each holds up.
Nothing below was fixed in this task beyond wiring existing checks; each item is sized for one agent.

1. **The interfaces against the original's frames (4.4.11 to 4.4.14): done 2026-10-15** ([interface frames](interface-frames.md): the recipe, 18 views, the two divergences found and
   fixed, the gate rows `PASS`). The terminal screens of four security computers are compared too (the camera frames outside their windows are pixel-equal). What a frame still does not cover: a computer's login screen before the login (it needs a live level held by the tracer, as the security cameras do), the DataLink,
   InfoLink and conversation windows, a held weapon's ammo display (with 4.1.10), another map's HUD and another resolution, and one open difference of the pointer input (a stationary
   cursor over a screen that replaced another: the original focuses the button under it, Play does not; the cause is unmeasured).
2. **Speech has no original sound (4.5.6).** The conversation frames are compared with the original's (4.5.5 MeetPaul, 4.5.7 the intro, 4.5.8 MeetManderley, 2026-10-16: letterbox, behind view, camera, subtitles,
   lip sync through the per-tick actor trace), but there is no original audio of the speech (Galaxy's MPEG decoder is not translated; the host's decode and rounding are unverified). The comparison found one divergence of Play,
   fixed ([conversation camera](conversation-camera.md#the-intro-against-the-original-2026-10-16-gate-row-457): `AActor::FindBase`'s trace extent). Holds up "synchronized speech and conversation camera behavior".
   Speech now plays through Galaxy's voices with the original's distance, pan and speech ratio (fixed 2026-10-16, see [Excluded](#excluded)); what stays
   unverified is the decoded audio itself and its stand-in record, under the user's 4.5.6 decision.
3. **One live result is still red (4.2.28's Ship window); 4.1.7 and 4.1.8 were settled 2026-10-16** ([visual
   acceptance](visual-acceptance.md#the-live-replays-start-state-battery-parks-two-loads-and-the-underworlds-flaky-draw-2026-10-16)). *4.1.7* (flaky): the player's animation flags at the start of the
   replay (`bAnimNotify` 0 when the replay began before the ghost's own script started its `Tread` loop, so the loop's `PlayFootStep` `FRand` was missing at tick 45); the harness now
   waits for the pose's sequence: 10 of 10 replays equal, not flaky. *4.1.8* (red): the stored BatteryPark trace was the unusual load (a chance `FlyGenerator4` Play's seeded load
   lacks, from the original's own population dump; the sweep ran with `--allow-missing generators`), not a `Trashbag1` spawn; a fresh exact-population load (tag `sweep2`, stored, read by
   the gate) replays 64 of 64 over 1,200 ticks once `viewProbe` stops re-adding the ghost to the collision hash (it had made JC touchable: Anna stopped two ticks early). The gate now
   passes it. *4.2.28* (red): Ship's window 2 differs by doors an NPC opened: a fresh capture (`sh3b`, with the level's movers read from the original) shows `DeusExMover39`, `40` and
   `65` at `KeyNum` 1 and resting, the other 66 closed; Play's are closed at the same level time (NPC routes are each program's own, who opened them was not measured). The harness now
   writes the original's measured mover poses into Play (an input of the held state, like the cameras' and the player's): window 2 goes from mean abs. difference 4.23, recall .788,
   precision .695 to 1.13, .918, .794 (gate run: precision .757, the only threshold missed). **What is left in that window:** an NPC (red uniform) standing in the doorway in Play and absent in
   the original, and the locker doors on the back wall, drawn lighter in Play than in the original (movers closed in both). The first needs the NPCs' poses and animation as measured inputs
   too (a second original capture reading the pawns), the second a look at mover lighting in a camera frame; neither was done, so the row stays `FAIL`.
4. **Three checks ran in the wrong mode (`INLINE`: 4.2.12, 4.2.18, 4.2.20): done 2026-10-16.** `validate-particles-play`, `validate-mirrors-play` and `validate-fire-texture-play`
   forced `?sim=inline`. They now run in Play's default worker mode with the same assertions: the particles check moves the player to ParticleGenerator3 and reads the
   generator's iterator through a sim-side `particleProbe` (`decal-probe.mjs`, `sim-worker.mjs`, `deusExViewer.particleProbe`), the mirrors check places and hides the
   player through the existing `placeProbe`, and the fire-texture check reads the page's own actor mesh layer and waits for the fires' first tick (in the worker the first
   frame reaches the page after the simulation's first run). `--only '^4\.2\.(12|18|20)$'`: 19 checks, 3 PASS (514 s at 2 jobs).
5. **Effects with a translation but no matched original frame: 2026-10-16/17, nine of nine done, one open** ([effect frames](visual-acceptance.md#effect-frames-2026-10-16)).
   `PASS`: 4.2.17 (the Bar's haze: the frame and the fog's contribution against the original's), 4.2.19 (the Hotel mirror, the player posed as the original had him), 4.2.24
   (Island's doorway beams: geometry; the beam texture is an animated fire whose sparks are an unmatched host input), 4.2.15 (Training's pawns' shadows, the Mac at Brightness 2/3: the
   frames, the shadows' contribution and every Shadow's state at the shot equal, the walkers ordered to stand and the camera moved as the original's console moves it; see the scoreboard's
   update and [decals](decals.md#against-the-original-2026-10-16-gate-row-4215)), 4.2.26 (Training's held viewport flash, the Mac at Brightness 2/3: two states,
   the multiply and the additive branch, the flash's map of levels equal at all 369 (channel, level) pairs; see the scoreboard's update and [screen flash](screen-flash.md#against-the-original-2026-10-16-gate-row-4226);
   the recipe's fog (0.3,0.1,0) never shows at a held tick, in either program, so the "steady red tint" noted before the capture was not that state's), 4.2.22 (the detail pass,
   the Mac at Brightness 2/3 with the device's `DetailTextures` poked: two Training walls and two views of Island's deck, the frames and the pass's contribution against the original's,
   Jaccard .97 to .9998 of the changed pixels; the frame's top row, which Play's fans missed, fixed the same day ([edges on pixel centres](frame-projection.md#edges-on-pixel-centres-2026-10-16)); see the scoreboard's update and [frame projection](frame-projection.md#against-the-original-in-a-frame-2026-10-16-gate-row-4222)), 4.2.30 (the Underworld's mirrored panes at a held
Strobe, the Mac at Brightness 2/3: both states at two cameras, each frame at the level time of its own shot because the club's Disco lights follow the clock that runs on between shots, and its hold
record read by the gate; frames equal to within 0.02 levels, the other state's frame 30 to 53 outlier blocks off; see the scoreboard's update and
[visual acceptance](visual-acceptance.md#06_hongkong_wanchai_underworlds-mirrored-panes-at-a-held-strobe-row-4230)), and 4.2.13 (the Street's steam, the Mac at Brightness 2/3, tag `vents5`,
   `PASS` on 2026-10-17 in 5 of 5 runs). The draw difference of vents2 is found and fixed in the harness: a same-named chance FlyGenerator on another decoration (the names are a
   per-process counter), not the stasis gate; the recipe removes the load's FlyGenerators in both programs with the original's `KillAll`, the population then matches at the
   first load and the 600 ticks replay equal (clock, stream draws, 22 actors). The steam's puffs are a FireTexture that changes with every drawn frame in the original itself
   (four held frames against each other: agreement .867 to .934, so the gate's .98 was out of the original's own reach). Criterion (a), adopted on 2026-10-16 (the steam's
   agreement against the original's own frame-to-frame floor, the LIVE check's `floorShots`), passed 4 of 8 runs: the frame's outlier-block rule meets the same phase. **Superseded
   on 2026-10-17** (the coordinator's call, the user having delegated it): as 4.2.24's `rngpin` turns the beams' stream into a measured input, the tracer's `fire hold` stops
   Fire.dll's UFireTexture::ConstantTimeTick before the original's frames (four held frames byte-equal), `fire read` stores SmokePuff1's P8 pixels, and Play's replay holds its
   fires and writes those pixels into its texture (`fireHold`). The frame is then judged at the normal thresholds: Play / original 1.000, mean abs. difference 0.03, edges
   .998/.999, 0 outlier blocks (block ratios .997 to 1.002), the steam's correlation 1.000, gap 1.000, residual .001, agreement 1.000. See
   [visual acceptance](visual-acceptance.md#04_nyc_streets-steam-vents-row-4213-pass-the-puff-texture-held-at-the-originals-pixels) and
   [fire texture](fire-texture.md#held-against-the-original-2026-10-17).
   **Open, with the tooling already in `visual-acceptance.mjs` (`original` / `play` / `compare`) and the recipe each needs:**
   * **4.2.29 a camera window holding a mirror, sky, fog or corona** (census done 2026-10-16, no capture yet): [camera view census](camera-view-census.md) (`scripts/census-camera-views.mjs`, 4f626fc) reads the
     maps' data and runs Play's visibility code from each camera over its swing: 40 maps, 89 security terminals, 155 distinct cameras; 6 see a mirror, 25 sky, 5 volumetric fog and 4 a corona that would
     draw (a camera window's corona pass takes only the lights that reach JC's leaf at the terminal, so coronas are rare). Fog and corona counts are approximations, labelled in that doc; it reproduces
     the five 4.2.28 terminals' camera lists and logins. By Play's fog rule two of the thirteen 4.2.28 windows already hold fog: Ship window 1 faintly (at most 0.05) and window 2 heavily (up to 0.69, the camera
     inside Light0's fog sphere); nobody has judged those frames for it. Recommended captures (commands in the census's "Recommended captures"): Island ComputerSecurity0 `cs0` for the floor mirror
     (window 3) and sky (windows 1 and 2), noting that an earlier attempt at that terminal's exterior cameras lost JC through a transition at the SATCOM compound (visual-acceptance.md); Area 51 Final
     ComputerSecurity0 `a51f` window 2 for fog (a still camera inside a fog sphere, nothing moving in view); Dockyard ComputerSecurity1 `dk1` for sky from two still cameras. No clean corona view exists
     (the best, Island ComputerSecurity2's SecurityCamera3, shows it during 44% of its swing at the window's top edge with pawns in view; switching it off on its own terminal to hold it still is untried).
     The commands are written for the Linux host; the Mac's bottle runs `camera-original.sh` only if it gets the same Darwin changes as `live-original.sh`.
   Tools added for these and used above: per-frame `-time.txt` and `times` staging, `--base` / `--base-cmd` / `--base-poke` / `--contribution`, `--freeze-player` / `--player-state` / `--player-pose`,
   `--pre-shot-cmd` / `--pre-shot-wait`, `--rng-pin` (and `dx-live-win.exe rngpin`), `compare --beams`, `compare --flash-base`, `--decal-state` and `play --camera-transit`, a held-Strobe view's
   own clock and hold record (`dx-live-win.exe strobe poll ... <LevelInfo>`), `original`'s dilation read-back, frozen-level check and `--cmd-check`, `live-acceptance.mjs --base-shot` / `--draw-stack-actor`, the gate's `base`, `playerPose`, `unfreeze`, `rngPin`, `beams`, `twin`, `baseShot`, `preShot` / `preShotWait`, `flashBase`, `decalState`, `cmds`, `cameraTransit` and `strobeHeld` options.
6. **Sound: 4.3.6 and 4.3.7 done 2026-10-16.** *4.3.6* passes on `sndm5`, a capture of the Underworld scene on the Mac: 68 of 68 ticks with calls, 103 of 103 calls, 557 of 557
   registry takes, the AI manager's 654 calls and 50 actors equal for 400 ticks ([galaxy audio](galaxy-audio.md), "Row 4.3.6"; [object index captures](object-index-captures.md)). Five causes were
   fixed in Play: FastLineCheck reads the level's model as the moving-brush tracker holds it (the movers' fragments block sound obstruction; `validate-fast-line-check-tracked`, 1,493 lines on
   three maps against Engine.dll), XGC::PushGC's new node takes a GObjObjects slot, AIProcess's 2 ms rdtsc budget and the windows' wall-clock deltas are measured inputs of the live replay
   (host timing, recorded by the tracer), windows tick before the level as UExtensionEngine::Tick orders them, and the pre-scene AI sender is freed where the original frees it. The Linux
   `snd1` capture lacks the recorded inputs and is no longer the row's. The live rows whose stores are on the Linux host (4.1.5 to 4.1.8, 4.5.5, 4.5.7, 4.5.8) also go through the line-check
   and window-order changes and were not rerun. *4.3.7* passes on its five checks (the launch capture replays bit-equal: 4,851 callbacks, both resyncs, 34,222,080 copied bytes; the poll measures
   D = 8,820 bytes, write lead 1,764 = Play's `WRITE_LEAD`). Speech is not in the live scene: two breakpoints hit at once on different threads garble the record under CrossOver, so the
   ring transport is checked by the oracle only ([audio output scope](audio-output-scope.md) §5.2). The plan the user adopted (2026-10-16): the user accepted all six
   recommendations. (1) Play reproduces Galaxy's two ring heads, so music sounds about 0.96 s after the effects rendered with it, as in the original. (2) D's host part (the
   write cursor's lead at the first callback, CrossOver's dsound on the reference machine) is measured once and pinned as a labelled host input. (3) The checks are the
   callback under Unicorn, the tracer's read-only poll and a capture replayed through the translation; a loopback recording is optional confirmation only. (4) Speech
   takes Galaxy's ring transport (glxStartSample's ring branch, the refill posts, the decoder thread's ring logic) with the browser's decode as its decoder: the 93 ms head
   start, the end and the four stereo lines on two slots. (5) Excluded: hardware 3D voices, ADPCM and the other unshipped loaders, the WinMM fallback, the non-SSE kernels. (6) Play
   keeps its fixed 882-frame callbacks as host timing; bit-equality is claimed under a replayed schedule only. Work, in order: the poll mode of `dx-live-win.exe` and its capture
   (§5.1), the callback's translation against the oracle, the two heads in the worklet, the ring transport, then the capture mode and replay (§5.2).
7. **The first-person weapon and weapons in mirrors (4.1.10, 4.1.12; 4.1.11 done 2026-10-16).** 4.1.11 (the player's pistol and MedKit in the lab mirror)
   passes on the Mac's captures (see the scoreboard's update). No agent is working on the other two (no branch is left, 2026-10-16). 4.1.10 stays `MISSING` until a matched capture of
   the held first-person weapon exists, 4.1.12 until one of an armed NPC in a mirror or a camera window does (the maps' mirrors miss a standing pawn's hands).
8. **Stores and clocks.** Consolidate the originals into the main `.work` ([Stored originals](#stored-originals)) and store each frame's level time with it, so
   the gate runs anywhere without `DX_ORIGINALS`. As of 2026-10-16 the gate is bound to one machine: the Linux host holds every store but the Mac's
   six (4.1.9, 4.1.11, 4.2.26, 4.2.15, 4.2.22, 4.2.30: the flash, shadow, detail and held-Strobe frames exist only on the Mac), so a full run on the Mac reads `NO-ORIGINAL` for nearly every O1 row and one on the Linux host for 4.2.26, 4.2.15, 4.2.22 and 4.2.30.
   Either copy the Linux stores to the Mac (or the reverse), or run the full gate on the Linux host after copying the Mac's weapon, lab, flash, shadow, detail and Underworld files there. The names collide: the Mac's `original-cases{,-2,-3}.json` would replace the Linux ones, so keep one set per machine or rename one;
   likewise the Mac's `acceptance/times.json` holds its own captures' clocks (Training and Island from the 4.2.22 runs, the Underworld from 4.2.30's), which the gate does not need for frames that carry a `-time.txt`, and must not replace the Linux one.
9. **Judgement for the user to adopt or change.** The scene list (weak reasons are marked), the thresholds and the three explained-block allowances in [How
   the gate judges](#how-the-gate-judges), the five-map sweep subset, and that `INLINE` counts against a criterion.

**A gate flake seen on 2026-10-16** (master 17c4f1a plus the interface branch): `--only '^4\.4\.'` at two jobs failed all four
interface rows once with `compare step:` and a byte array (the `interface-acceptance.mjs compare` child exited non-zero while the other 4.4
checks ran beside it); the same compare run by hand exited 0 with every view within the thresholds, and `--only '^4\.4\.1[1-4]$'` passed
4 of 4. Unattributed: a shared file under `.work/acceptance/00_Training` or ImageMagick under load are the candidates. Run the interface
rows alone before believing such a failure. The same day `--only '^4\.1\.[5-8]$'` failed 4.1.8 in 0 s with `ENOENT` on
`.work/live-acceptance/stage4-gate-sweep-sweep2.json` (the replay child exited without writing it while the pilots' checks ran beside it);
`--only '^4\.1\.8$'` alone passed. Both point at checks sharing `.work` paths when two run at once. **Cause of the 4.1.8 failure, fixed 2026-10-16:**
the staging linked to a link an earlier run had made, so the sweep's trace became a link to itself and the replay found "no stored trace"; both
stagers now link to the real file (`realpathSync`). **Intermittent, unattributed:** 4.5.8's `mmA` frame `mm2` (tick 450) read band identical .43 in one
`--jobs 1` run on 2026-10-16 (a different camera shot) and passed on the next; the fallback camera's choice at that tick is the first suspect.

**Not covered by this definition:** the 14 other frozen maps (a re-run command is in [What exists](#what-exists-and-the-gate-does-not-run)), pawns that fight or
are shot while close, a moving camera in a live scene, and any NPC beyond 1,200 ticks; Stage 5 and 6 items are under [Excluded](#excluded).

**Run time and memory.** The first full run took 3,636 s (about 61 minutes) at two jobs on the Linux host (AMD, 30 GB), with at most 5.6 GB resident across the
checks running together; the longest single checks are the sweep replay (384 s), `detail-play` (376 s), the music sequencer (361 s) and `player-alterations-census` (273 s). A
subset (`--only`) runs in the time of its checks.
