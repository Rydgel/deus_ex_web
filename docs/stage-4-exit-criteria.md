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

First run, 2026-10-15 on master 2386f69 plus this branch (Linux host, AMD, 30 GB, 16 cores, `--jobs 2`): 60 min 36 s wall, peak 5575 MiB across the checks that ran together. **44 of 70 criteria pass; the gate is red.** 75 criteria in all, 5 excluded. The originals came from the stores listed under [Stored originals](#stored-originals).

| Clause | PASS | FAIL | INLINE | NO-ORIGINAL | MISSING | EXCLUDED |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 4.1 Animated actors | 8 | 1 | 0 | 0 | 2 | 0 |
| 4.2 Effects | 17 | 1 | 3 | 0 | 9 | 3 |
| 4.3 Sound | 5 | 0 | 0 | 0 | 2 | 0 |
| 4.4 Text and interfaces | 10 | 0 | 0 | 0 | 4 | 2 |
| 4.5 Speech, lip sync and the conversation camera | 4 | 0 | 0 | 0 | 4 | 0 |
| **Total** | **44** | **2** | **3** | **0** | **21** | **5** |

**Update, interface frames (2026-10-15, [interface frames](interface-frames.md)):** rows 4.4.11 to 4.4.14 are `PASS`, from 18 views of 00_Training compared with
the original's frames (the HUD, eight persona screens, the main menu, three Settings screens, a datacube and the keypad) and from the four stored security-computer screens (outside their camera windows); the clause 4.4 row of the first-run table reads
14 PASS, 0 MISSING and the total 48 of 70 PASS, 17 MISSING. The comparison found two divergences of Play, both fixed (the GC's authored underline texture and the window system's real-time tick).

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
| 4.1.7 | 06_HongKong_WanChai_Underworld live | 50 actors, 600 ticks, six dancers | O1 | `live 06_HongKong_WanChai_Underworld` [worker] (flaky) | PASS |
| 4.1.8 | five campaign maps, 1,200 ticks | BatteryPark, Hotel, Market, Chateau and Area 51 Bunker: every actor equal | O1 | `sweep replay 5 maps` [worker] | FAIL |
| 4.1.9 | 01_NYC_UNATCOIsland armed pawns | a pawn's third-person weapon: hand frame and Coords equal Render.dll, drawn in Play | O2 | `weapon-attach` [oracle], `weapon-play` [worker] | PASS |
| 4.1.10 | Training first-person crowbar | the first-person weapon frame (view model, GPU camera passes) against the original | - | missing: only the selection (validate-weapon-lod) is compared with the original; no matched capture of the held weapon | MISSING |
| 4.1.11 | 05_NYC_UNATCOMJ12lab mirror | the player holding a pistol and a MedKit in a mirror child frame: the frame's planes and the Coords equal the running original's logged draws | O1 | `weapon-attach` [oracle], `weapon-mirror-play` [worker] | not yet run (added after the first run, master 88b6f96) |
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
| 4.2.12 | particles and sprites | ParticleIterator, FDynamicSprite and the tile chain | O2 | `particles-play` [inline], `sprite-setup` [oracle], `sprite-tiles` [worker], `sprite-tiles-play` [worker], `sprite-tiles-mirror-play` [worker], `native-particles` [oracle] | INLINE |
| 4.2.13 | 04_NYC_Street vents | a frame with particles and sprites against the original with the generators' state matched | - | missing: no matched capture holds a particle or sprite whose generator state the original side fixed | MISSING |
| 4.2.14 | decals | AttachDecal, ClipDecal and the vertices of a decal equal Engine.dll and Render.dll | O2 | `decal-vertices-play` [worker], `decals-play` [worker], `decal-attach` [oracle], `decal-render` [worker], `decal-startup` [oracle] | PASS |
| 4.2.15 | Training shadows, bullet holes | a decal frame against the original | - | missing: no matched capture shows a decal; blood and scorch marks need combat | MISSING |
| 4.2.16 | volumetric fog (02_NYC_Bar) | ComputeFromActor and the fog loop equal Render.dll; the pass in Play | O3 | `volumetric-fog-play` [worker], `volumetric-fog` [oracle] | PASS |
| 4.2.17 | 02_NYC_Bar smoke haze | a fog frame against the original | - | missing: the stored frames are 08_NYC_Bar, whose zones hold no fog; 02_NYC_Bar has no original capture | MISSING |
| 4.2.18 | mirrors | frame cases, child frames, nesting, the sky inside a mirror, the strobe | O2 | `mirrors-play` [inline], `mirror-plan-play` [worker], `underworld-panes-play` [worker], `strobe-mirror-play` [worker], `sky-in-mirror-play` [worker], `child-frames` [oracle], `mirrors` [oracle] | INLINE |
| 4.2.19 | 02_NYC_Hotel bathroom mirror | an opaque unlit mirror against the original | - | missing: no stored original frame of 02_NYC_Hotel (only mirrors-play, Play against itself) | MISSING |
| 4.2.20 | Fire.dll textures | fire and water textures, animated and auto-panned surfaces | O2 | `fire-texture-rust` [node], `native-fire-texture` [oracle], `fire-texture-play` [inline], `texture-animation-play` [worker], `native-texture-animation` [oracle], `native-surface-pan` [oracle] | INLINE |
| 4.2.21 | detail textures | the D3DDrv detail pass equals the original body; Play draws it | O2 | `detail-pass` [oracle], `detail-pass-rust` [oracle], `detail-play-sim` [node], `detail-play` [worker] | PASS |
| 4.2.22 | detail pass in a frame | Play's detail pass against a capture of the original with the pass poked in | - | missing: measured once (Jaccard 0.94 to 0.98 on five of six views, docs/frame-projection.md); those captures are not in a store the gate reads | MISSING |
| 4.2.23 | lasers | LaserIterator.CurrentItem equals the original; the Island doorway beams draw | O2 | `lasers-play` [worker], `native-laser` [oracle] | PASS |
| 4.2.24 | 01_NYC_UNATCOIsland doorway | a beam frame against the original | - | missing: no original capture of a beam (docs/lasers.md) | MISSING |
| 4.2.25 | viewport flash | EndFlash equals D3DDrv; the flash pass draws | O2 | `d3d-endflash` [oracle], `flash-play` [worker], `player-alterations-census` [node] | PASS |
| 4.2.26 | underwater or drunk frame | a held flash frame against the original under Wine | - | missing: the pass is checked against Play itself only; GL's 8-bit blend rounding against the device's is unmeasured (roadmap section 4 Open) | MISSING |
| 4.2.27 | vertices and visibility | Render.dll's projection, D3DDrv's vertices and OccludeBsp equal the original | O2 | `frame-projection` [oracle], `frame-projection-movers` [oracle], `frame-projection-play` [worker], `master-frame-play` [worker], `bsp-occlusion` [oracle] | PASS |
| 4.2.28 | security cameras | ViewportWindow windows on four maps match the original's computer screens | O1 | `camera 14_OceanLab_Lab cs1` [worker], `camera 02_NYC_BatteryPark bp2` [worker], `camera 06_HongKong_WanChai_Market hk0` [worker], `camera 09_NYC_Ship sh3` [worker] | FAIL |
| 4.2.29 | camera with a mirror, sky, fog or corona in view | a camera frame against the original | - | missing: the thirteen captured windows look into rooms (visual-acceptance.md "What stays") | MISSING |
| 4.2.30 | 06_HongKong_WanChai_Underworld mirrored panes | the dance floor in the mirrored panes at a held Strobe against the original | - | missing: the stored d_s0 and d_s1 frames cannot be reproduced: the level time each was held at is not stored with it (times.json holds the last capture's, 54.18 s, written after the frames), and with that clock Play differs in 7 blocks | MISSING |
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
| 4.3.6 | a live scene's script sounds | the original's PlaySound calls of a scene against Play's | - | missing: scripts/live-sound-compare.mjs compares one capture (Underworld, tag snd1); its stored original trace is not in a store the gate reads | MISSING |
| 4.3.7 | audible output | the output Galaxy produces for the speakers | - | missing: the music bus delay, the ring heads' spacing, MPEG and ADPCM samples and 3D voices are unmeasured or untranslated (docs/galaxy-music.md, galaxy-audio.md) | MISSING |

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
| 4.5.5 | MeetPaul frame | the third-person conversation frame (letterbox, behind view, camera, subtitles) against the original's | - | missing: no original capture of a conversation; nothing in a store the gate reads | MISSING |
| 4.5.6 | speech audio | the speech samples the player hears against Galaxy's | - | missing: Galaxy's MPEG decoder is not translated; the host's decode and rounding are unverified (docs/lip-sync.md) | MISSING |
| 4.5.7 | 00_Intro camera shots | the intro's CameraPoint shots against the original | - | missing: compared only on the mirror capture of mirror-surfaces.md; no gate-readable stored frame | MISSING |
| 4.5.8 | a second third-person conversation | a conversation on another map, with the third-person camera, lip sync and speech | - | missing: lip sync is wired for MeetPaul only: other maps need their object-index capture first (docs/conversation-camera.md Open, docs/object-index-captures.md) | MISSING |

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
| Matched capture settings | `?antialias=0`, `?detailTextures=0` | Every stored original lacks multisampling and the detail pass (Wine's device has no `BLENDDIFFUSEALPHA`); Play's defaults (both on) stay as they are. |
| Interface frames | at least 99% of the pixels identical, at most 64 pixels off by more than 10 of 255, mean absolute difference at most 0.1, edge recall and precision at least 0.99, no outlier block; a security computer's screen outside its camera windows: at most 20 pixels off by more than 2 and none by more than 10 | The 18 views are within 2 of 255 everywhere but one world scanline of 57 pixels (up to 27 levels) and, in the datacube view, 90 pixels of at most 13 levels. Strong for what it excludes: Play before the two fixes fails every frame they changed (the closest has 105 pixels over 10). Weak for the margins (7 pixels over the worst measured, .9922 against .99). The four terminal screens read 0 pixels over 2 outside the camera windows (the largest difference 0), so the 20-pixel allowance is a margin, not a measurement. |
| Live-scene tolerance | every watched field of every actor, the clock and the stream draws equal; a stream-draw-only difference is repeated once | The Underworld's draw count differed at tick 45 on the first replay in two of two fresh runs and was equal on the repeat (the unattributed intermittent of [visual acceptance](visual-acceptance.md#open)); a repeat that passes is reported as `flaky`. |

**Real-x87 probes.** `window-scene-frame` runs a small probe executable under Wine to measure `appTan` on hardware. The gate points those validators
at `/usr/bin/wine` and the `~/.wine-deusex` prefix when they exist (`X87_PROBE_WINE`, `WINEPREFIX`); it starts no DeusEx.exe.

## The scenes

The list is finite on purpose: a scene is here because a stored original-side result exists for it, or because the campaign needs it and the gate
says `MISSING`. **The choice of these scenes is mine; only the first column's reason is strong where it says so.** If a scene is not representative,
change the row in `scripts/validate-stage4-acceptance.mjs`; nothing else depends on it.

| Scene | Clauses | Why it is here |
| --- | --- | --- |
| `00_Training`: the start views, the entrance floor mirror, the corridor lights, the HUD, a datacube, the keypad, the DataLink, the Esc menu | actors, effects, text and interfaces | Strong: the first mission, the only map every interface probe reaches today, the map Stage 3's gate boots, and the best-compared mirror and light-map surface. |
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
Engine.dll and Render.dll executed unchanged (4.1.2 to 4.1.4). Not covered: the player's own mesh in a mirror, the first-person weapon and an armed
pawn in a child frame (4.1.10, 4.1.11), and anything that needs the player to move or act while an NPC is watched.

**Effects.** Each effect has the same two layers: its translation against the DLL's code (O2, and O3 on Play's inputs), and a matched frame
where the original was captured with the effect in view. Where only the first exists the row says `MISSING` and names the frame that is
absent (particles, decals, fog, lasers, the Hotel mirror, the flash, the detail pass, a camera with a mirror in it).

**Sound.** All of it is O2 and O3: Galaxy.dll's functions (PlaySound, Update, the mixer, the effects voices, the reverb, the IT sequencer) run
unchanged under Unicorn and Play's translations match them bit for bit on large corpora; the Play-side checks show the worker and the worklet
reach those functions with real scene inputs. Nothing compares what the speakers get, and nothing compares a live scene's sound calls (4.3.6, 4.3.7).

**Text and interfaces.** The window system, GC drawing, text, edit, list and scroll windows are compared with Extension.dll natives one by one
(hundreds of cases per family); the HUD, a datacube, a computer, the keypad and the DataLink run the original bytecode through the real frob and input
paths. The first run found that **no frame of the original's HUD, menus or screens had ever been compared with Play's** (4.4.11 to 4.4.14); [interface frames](interface-frames.md)
now compares 18 views of 00_Training pixel for pixel (equal to within 2 of 255 apart from one scanline of the world), which found and fixed two divergences. Still not compared
in a frame: a computer's login screen (the four security terminals' screens after login are, outside their camera windows), the DataLink, InfoLink and conversation windows, a held weapon's ammo display, another map's HUD or another resolution.

**Speech, lip sync and the conversation camera.** Galaxy's lip-sync analysis equals the DLL bit for bit, MeetPaul runs end to end with the camera,
the letterbox and the render clip checked against Extension.dll, and Paul's mouth follows the letters in the browser. There is no frame or sound of
the original's conversation to compare (4.5.5, 4.5.6).

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
  specific capture; only the sound one has a row (4.3.6, `MISSING`: its stored trace is not in a store the gate reads).
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

- **Swimming and drowning visuals** (4.2.33): Stage 5, a gameplay system (ladders and flying are done, swimming is next in
  [Stage 5](roadmap.md#5-implement-the-full-gameplay-systems)).
- **Load Game, Save Game and QuickSave screens** (4.4.15): Stage 6, they stop at the save-game directory (native 3013).
- **Multiplayer screens** (4.4.16): the last priority, allowed to stay unsupported.
- **Animated mesh skins and `DT_SpriteAnimOnce`** (4.2.31): no shipped class, map actor or script reaches them
  ([particles](particles.md#dt_spriteanimonce-0x10b252ac0x10b25392-restored-at-0x10b254d3), [texture animation](texture-animation.md#play)).
- **`UseVertexFog`, Glide's fog pass, `RendMap` wireframe and particle mesh branches** (4.2.32): not used by the shipped D3D configuration or
  reachable from a script (`census-lodmesh-branches.mjs`).

## Stored originals

The gate reads results of the original that earlier sessions captured under Wine; none is in Git. The tooling keeps them under `.work/` in
whichever checkout took them, so today they are scattered. The gate searches the colon-separated directories of `DX_ORIGINALS`, or by default
this checkout's `.work`, the main checkout's `.work` and the main checkout's `.work/live/.work` (the tree the original is driven from), takes
each criterion's inputs from one root (the first that holds them) and links or copies them into its own `.work` (never into a file Play writes).

| What | Where it is today | Used by |
| --- | --- | --- |
| Frozen frames, 26 maps x 5 views, and the held level times | main `.work/acceptance/<map>/{y0..y3,down}-original.png`, `times.json` | 4.1.1, 4.2.1 to 4.2.4, 4.2.8 |
| Effect-aimed frames (Club, Ship's hold, Garage, Street, Training corridor) and their clocks | main `.work/live/.work/acceptance/<map>/<view>-original.png`, `times.json` | 4.2.2, 4.2.5 to 4.2.8 |
| The Ship fan's `fan2` frame and its clock (52.397 s) | worktree `agent-a2ddd75162532fd59` `.work/acceptance/09_NYC_ShipFan/fan2-original.png`, `times.json` | 4.2.6 |
| The Club dancers' frame | worktree `agent-ab57e232707486ccf` `.work/acceptance/10_Paris_Club/cvclub-original.png` | 4.1.6 |
| Pilot traces of 2026-10-15 (Island, Club, Underworld) with their watch and population lists | worktree `agent-ab57e232707486ccf` `.work/live-acceptance/<map>/original-trace*.jsonl` | 4.1.5 to 4.1.7 |
| The 28-map sweep's traces (2026-10-13) | main `.work/live/.work/live-acceptance/<map>/original-trace-sweep.jsonl` | 4.1.8 |
| Security-camera frames and measured state | worktree `agent-a011db8f1b061eb8e` `.work/acceptance/<map>/{cs1,bp2,hk0,sh3}-original.png`, `-state.json` | 4.2.28 |
| The original's third-person weapon draws | main `.work/weapon/original-cases*.json` | 4.1.9 |
| The interface frames of 00_Training (18 views, 2026-10-15) and each frame's level time | main `.work/acceptance/00_Training/ui-<view>-original.png` and `ui-<view>-time.txt` (also `ui-e1` to `ui-e4`, the pointer experiment) | 4.4.11 to 4.4.14 |
| The light manager's tables from the running original | main `.work/live/.work/fpu` | 4.2.9 |

**A clock per frame, not per map, is what a store should keep.** `times.json` holds one level time per map and each capture overwrites it, so
a frame and the clock beside it can come from different captures. Two cases showed up in the first run: the main `.work/live` tree's `fan2-original.png`
is paired with a later clock and Play differs in three blocks, while the capture in the worktree above, with its own 52.397 s clock, matches with
none; and the Underworld's `d_s0` and `d_s1` frames predate the clock stored for their map (54.18 s), so they cannot be reproduced at all and
4.2.30 is `MISSING` rather than failing for the wrong reason. A capture should write `<view>-time.txt` beside its frame.

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

From the first scoreboard: 26 of 70 gating criteria were not `PASS` (2 `FAIL`, 3 `INLINE`, 21 `MISSING`); item 1 is closed since (22 now). Ordered by how much of "Done when" each holds up.
Nothing below was fixed in this task beyond wiring existing checks; each item is sized for one agent.

1. **The interfaces against the original's frames (4.4.11 to 4.4.14): done 2026-10-15** ([interface frames](interface-frames.md): the recipe, 18 views, the two divergences found and
   fixed, the gate rows `PASS`). The terminal screens of four security computers are compared too (the camera frames outside their windows are pixel-equal). What a frame still does not cover: a computer's login screen before the login (it needs a live level held by the tracer, as the security cameras do), the DataLink,
   InfoLink and conversation windows, a held weapon's ammo display (with 4.1.10), another map's HUD and another resolution, and one open difference of the pointer input (a stationary
   cursor over a screen that replaced another: the original focuses the button under it, Play does not; the cause is unmeasured).
2. **Speech and the conversation camera have no original frame or sound (4.5.5 to 4.5.8).** The camera, letterbox and lip-sync code are compared with the
   DLLs, and MeetPaul runs end to end, but there is no original frame of the conversation (letterbox, behind view, subtitles), no original audio of the speech
   (Galaxy's MPEG decoder is not translated; the host's decode and rounding are unverified), the intro's `CameraPoint` shots have no gate-readable frame, and
   lip sync is wired for one conversation. Holds up "synchronized speech and conversation camera behavior".
3. **Two live results are red and one is flaky (4.1.8, 4.2.28, 4.1.7).** *4.1.8:* `02_NYC_BatteryPark` replays 32 of 64 actors equal (UNATCOTroop2 `State` and Terrorist5 `Loc` from tick
   13 to 14); the working hypothesis, not verified, is `Trashbag1`'s `Containers.Destroyed` spawn result ([visual
   acceptance](visual-acceptance.md#re-run-on-master-9fb73f2-2026-10-15)); the next step is a `ULevel::SpawnActor` call log of a bad original load. *4.2.28:* Ship's
   security window 2 (mean abs. difference 4.35, recall .71): a `DeusExMover` stands half open in the original and closed in Play, a mover's state in a live level.
   Both are campaign maps; both are already documented as open. *4.1.7:* the Underworld passes only on its repeat. The first replay of its trace differs in the stream's
   draw count at tick 45 (original 3, Play 2; every actor and the clock equal) in two of two fresh runs, and the repeat is equal; the gate's one-repeat rule
   shows it as `flaky` instead of red. Unattributed (the first run after staging the trace; one of the two was under load); a candidate real nondeterminism in the
   replay, not yet looked at.
4. **Three checks run in the wrong mode (`INLINE`: 4.2.12, 4.2.18, 4.2.20).** `validate-particles-play`, `validate-mirrors-play` and `validate-fire-texture-play` force
   `?sim=inline`. Each passes; each needs a sim-side probe call (the way `decalProbe` does) so it runs in the default worker mode, after which three criteria
   turn green with no new evidence. Small and mechanical.
5. **Effects with a translation but no matched original frame (`MISSING` 4.2.13, .15, .17, .19, .22, .24, .26, .29, .30).** Each is one original capture session
   (the `.work/live` tree, `scripts/original-views.sh`) and one `frames` row: particles and sprites with the generator's state matched; a decal; `02_NYC_Bar`'s
   fog; the Hotel's bathroom mirror; the detail pass with the pass poked in; a laser beam; a held flash frame (underwater or drunk); a camera view with a mirror,
   sky, fog or corona in it; and the Underworld's mirrored panes at a held Strobe (the stored frames lack their clock, see [Stored originals](#stored-originals)).
   Order by campaign reach: fog and the Hotel mirror (the NYC chapter), particles, the laser beam (Liberty Island), then the rest.
6. **Sound has no check against what a live scene or the speakers get (4.3.6, 4.3.7).** `live-sound-compare.mjs` compares the original's `PlaySound` calls of one
   capture with Play's; its stored trace needs consolidating and a row. Not measurable yet: the music bus delay and the ring heads' spacing (a loopback
   recording of the original), MPEG and ADPCM samples, 3D voices.
7. **The first-person weapon and weapons in mirrors (4.1.10, 4.1.11).** In flight with another agent (the third-person weapon's leftovers); the rows stay
   `MISSING` until a matched capture of the held weapon and of an armed pawn in a mirror exists.
8. **Stores and clocks.** Consolidate the originals into the main `.work` ([Stored originals](#stored-originals)) and store each frame's level time with it, so
   the gate runs anywhere without `DX_ORIGINALS`.
9. **Judgement for the user to adopt or change.** The scene list (weak reasons are marked), the thresholds and the three explained-block allowances in [How
   the gate judges](#how-the-gate-judges), the five-map sweep subset, and that `INLINE` counts against a criterion.

**Not covered by this definition:** the 14 other frozen maps (a re-run command is in [What exists](#what-exists-and-the-gate-does-not-run)), pawns that fight or
are shot while close, a moving camera in a live scene, and any NPC beyond 1,200 ticks; Stage 5 and 6 items are under [Excluded](#excluded).

**Run time and memory.** The first full run took 3,636 s (about 61 minutes) at two jobs on the Linux host (AMD, 30 GB), with at most 5.6 GB resident across the
checks running together; the longest single checks are the sweep replay (384 s), `detail-play` (376 s), the music sequencer (361 s) and `player-alterations-census` (273 s). A
subset (`--only`) runs in the time of its checks.
