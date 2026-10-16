# Security-camera view census (gate row 4.2.29)

Stage 4, 2026-10-16. Gate row 4.2.29 needs a security-camera window that
shows a mirror, sky, fog or a corona, compared against the original. The
thirteen windows captured for 4.2.28 were chosen without checking for any of
these. This census reads the shipped maps' data only and answers three
questions: which cameras a ComputerSecurity terminal can show, what each one
sees, and which views would test one effect cleanly.

`scripts/census-camera-views.mjs` produced every number below (one Node
process, about 22 s for the 83 single-player maps on the Mac). It never
starts the game or a browser.

## Result

- **Reach.** 40 of the 83 single-player maps have a ComputerSecurity. Those
  maps hold 89 terminals with 267 camera views. 188 of the views have a
  camera, and they cover 155 distinct SecurityCameras. Of the 79 views
  without a camera, 68 have an empty `cameraTag` and draw the static default
  texture. In the other 11, no SecurityCamera on the map carries the tag (see
  [Views that find no camera](#views-that-find-no-camera)).
- **Effects in view**, counted per distinct camera:

  | Effect | Cameras |
  | --- | --- |
  | Mirror | 6, two of them the same camera in two Island missions |
  | Sky | 25 |
  | Volumetric fog | 5 |
  | Corona that would draw | 4 |

  Eleven cameras have corona lights in view with a clear line that the
  corona pass does not list for JC's leaf, so it draws none of those; eight
  of the eleven have no corona that would draw. All four cameras whose corona
  would draw swing, and they show the corona over only part of the swing.
- **Two of the thirteen 4.2.28 windows already show fog.** By Play's rule,
  the Ship terminal's window 1 (Entry Area, SecurityCamera1) has faint fog:
  1,411 pixels at 2/255 or more, peaking at 0.05 of full. Window 2 (Locker
  Room, SecurityCamera19) has heavy fog over the whole window, peaking at
  0.69. That camera sits 494 units from Light0, whose fog sphere has a radius
  of 525. Window 2 is the door-and-pawn window that keeps 4.2.28 at `FAIL`.
  The other eleven windows show no mirror, sky, fog or corona.
- **Recommended captures** (commands in
  [Recommended captures](#recommended-captures)):
  - Mirror and sky: Island's SATCOM terminal, `01_NYC_UNATCOIsland
    ComputerSecurity0`. Window 3 shows the HQ lobby's floor mirror
    (2,997–6,081 px over the whole swing). Windows 1 and 2 show sky.
  - Fog: Area 51's radiation camera, `15_Area51_Final ComputerSecurity0`,
    window 2. The camera is still and sits inside a fog sphere, so fog covers
    every pixel. The census found nothing else moving in view; the capture
    showed two wandering Grays and a carcass the census missed (below).
  - Sky, still cameras: Dockyard, `09_NYC_Dockyard ComputerSecurity1`. Two
    still cameras show sky, with only doors and gates in view.
  - Corona: no candidate is clean. The best one needs the camera held at a
    chosen yaw.

## How a terminal finds its cameras (original evidence)

The UnrealScript below was read from the installed packages' ScriptText
(DeusEx.u, Extension.u, Engine.u). The census decodes the map data the same
way.

- **The views.** `ComputerSecurity` declares
  `var() localized sViewInfo Views[3]`, where
  `struct sViewInfo { string titleString; name cameraTag, turretTag, doorTag; }`.
  In the map, each element is a tagged StructProperty whose bytes are the
  struct's SerializeBin form: an FString (compact length including the
  terminator, then Latin-1 bytes), followed by three compact name indices.
  Example: OceanLab's ComputerSecurity1 `Views[0]` is
  `08 "URV Bay\0" 63 03 00 7a 03`.
- **The login.** `Computers.userList[8]` is
  `sUserInfo { string userName, password; EAccessLevel accessLevel; }`. The
  capture command uses the first entry. Twelve terminals have no entry, and
  their screens must be hacked: Airfield's five, the Ship bridge's
  ComputerSecurity0, Catacombs' ComputerSecurity1, and five in Area 51
  (Bunker, Entrance, Page).
- **The camera for a view.** `ComputerScreenSecurity.InitCameras` runs
  `foreach player.AllActors(class'SecurityCamera', camera, Views[i].cameraTag)`.
  Every match is assigned in turn, so the last SecurityCamera in Level.Actors
  order with that Tag wins. The loop also sets `camera.bStasis = False`. No
  shipped view matches more than one camera. An empty tag leaves the window
  with no camera.
- **bActive does not stop the drawing.**
  `ComputerSecurityCameraWindow.UpdateCameraStatus` disables the viewport
  only when `camera == None`. `bActive` changes only the status label.
- **The window.** `CreateViewportWindow` calls `SetSize(200, 150)` and
  `SetPos(1, 17)`. ViewportWindow Init sets the fov to 90
  ([viewport window](script-window-viewport.md)). The only SetFOVAngle call
  is `ComputerScreenSecurity.PanCamera`, the screen's zoom keys and buttons,
  which clamp the fov to 5–90.
  `SetViewportActor(camera)` passes no eye-level flag, and the camera is not
  a Pawn, so Draw takes the camera's Location and Rotation.
- **The swing.** `SecurityCamera.Tick` sets
  `DesiredRotation.Yaw = origRot.Yaw + Sin(2π·swingTimer/swingPeriod)·swingAngle`
  when `bSwing` is set and the camera is not tracking. `origRot` is the
  placed Rotation (BeginPlay). The camera turns to DesiredRotation through
  `bRotateToDesired` with RotationRate 65535. The class defaults are
  swingAngle 8192, swingPeriod 8, cameraFOV 4096, cameraRange 1024 and bSwing
  False. 72 of the 155 cameras are still.
- **Tracking.** `CheckPlayerVisibility` runs every 0.1 s unless `bNoAlarm` is
  set. The player must be within cameraRange, the trace must hit him, and his
  direction must lie within cameraFOV of the camera's Rotation in yaw and in
  pitch. When all of that holds, the camera sets `bTrackPlayer` and turns to
  him. Eight reached cameras can see JC at the terminal this way; the table
  marks them `tracks JC`. Island's SecurityCamera5 is one of them, and its
  4.2.28 window has JC in view.
- **Holding a swinging camera through the real UI** (read from the script,
  not tried). The screen's camera choice calls
  `DeusExPlayer.ToggleCameraState`. For an active camera that is
  `UnTrigger`, which sets `bActive = False` and `DesiredRotation = origRot`.
  An inactive camera's Tick returns before the swing. `PanCamera` (arrow keys
  or the pan buttons) then sets `DesiredRotation` through
  `UpdateCameraRotation`, by `panMod·256·fov/90` per press, from the window's
  `ReplicatedRotation`. So the original can turn a camera off on its own
  terminal to hold it at origRot, then pan it by hand. The window keeps
  drawing.

**Checked against the 4.2.28 captures.** The decoding reproduces the five
captured terminals' camera lists:

- OceanLab ComputerSecurity1: SecurityCamera0, 4 and 3
- Battery Park ComputerSecurity2: SecurityCamera1, 2 and 0
- Market ComputerSecurity0: SecurityCamera2, 0 and 1
- Ship ComputerSecurity3: SecurityCamera1, 19 and 18
- Island ComputerSecurity1: SecurityCamera5 only

It also reproduces the logins that were typed by hand: Oceanguard/Kraken,
NSF/righteous, TAM/DRAGON, SECURITY/Brooklyn and NSF001/smashthestate.

## What each view holds, and how it is measured

Every camera is analysed at 9 yaws. These are the swing's 16 equal phase
steps; a sine repeats values, so 16 steps give 9 distinct yaws, each weighted
by the time the camera spends there. A still camera gets one sample. A table
cell reads `centre (least–most, share of the swing in view)`. The share is
omitted when it is 100%.

| Effect | Rule | Machinery | Exact or approximate |
| --- | --- | --- | --- |
| Mirror, sky | the child frames OccludeBsp makes from the camera's master frame | `createBspOcclusion` (the Rust OccludeBsp), called as Play's camera pass calls it: CreateMasterFrame on a 1280×720 viewport, ComputeRenderSize on the 200×150 rectangle, options SHOW_PLAYER_CTRL\|SHINY_SURFACES, child frames at fov 90. A child frame's span gives the pixels it covers. | Play's own rule. The census does not set the render pass's x87 precision control around CreateMasterFrame, so the frame fields may differ from Play's in their last bits. The movers sit at their map placement in the brush tracker, not where they stand at the hold. Every zone's SkyZone follows LinkToSkybox (the last SkyZoneInfo, then the last whose bHighDetail equals Level.bHighDetailMode, taken as True as Play's startup reads it). |
| Volumetric fog | a light-mapped surface drawn in a bFogZone zone; every VolumeRadius > 0 light is linked to it (Play's host choice, fog-pass.mjs). The texel's value is the fog loop's density integral over the eye segment's chord through the sphere R = (VolumeRadius+1)·25, times VolumeBrightness·(LightBrightness/255)/64 ([volumetric fog](volumetric-fog.md) "Fog loop") | a ray every 4th pixel (50×37 rays), `traceRay` over the tracked model; the hit zone is read 2 units in front of the hit | Approximate. Doubles stand in for the 24-bit loop, and the 7-bit colour table is skipped. The light's `brightness` factor is taken as LightBrightness/255; volumetric-fog.md writes `VolumeBrightness·brightness·(1/64)` without defining it, so the fog values' scale is an assumption, not their shape. Rays pass through non-solid surfaces. A pixel is its ray's hit. The `fog` column counts pixels at 2/255 or more; the doc also gives counts at 0.1 or more and the peak value. |
| Corona | DrawFrame's corona pass in a camera frame. The lights come from the *player's* leaf (the viewport actor's `Region.iLeaf`: `FLeaf.iPermeating` into `Model.Lights`, then the leaf's moving lights). From the camera frame's origin, TRACE_Level\|TRACE_Movers must be clear, then TRACE_Pawns\|TRACE_Others must be clear or hit the player. A light needs bCorona and a Skin, and is drawn at z > 1 with size `200·DrawScale·0.2` ([coronas](coronas.md), [viewport window](script-window-viewport.md#camera-pass)) | JC stands where `terminalProbe front` puts him: 56 units along the computer's yaw, on the floor found by a trace down, raised by JCDentonMale's CollisionHeight. `traceRay` handles the level and the tracked movers; `primitiveLineCheck` handles each bCollideActors actor at its placement | Approximate in JC's spot and in the actors' placement. LeafLights is not built here, but no corona light on a map with a terminal is a moving-light candidate, so the static run is the whole list. |
| Moving or unshared content | pawns (with their `Orders`), movers, swinging cameras, turrets, rotating actors (PHYS_Rotating), generators, lasers | in view: the Location (radius added) is inside the frustum and the line from the camera is clear. In a mirror: the reflection across a root mirror frame's plane is in the frustum, and both legs of the line through the plane are clear | Approximate (a frustum test, not the drawn set) |
| Light the programs do not share | Flicker, TorchWaver, FireWaver, WateryShimmer: the appFrand noise ([light effects](light-effects.md#matched-captures)) | on every 2nd grid ray: a light reaches the hit when it is within the world radius, in front of the surface, with a clear line | Approximate, and a weak confounder. Battery Park's window 1 has 714 px under BarrelAmbrosia0 and still matched at MAD 0.00. |
| Animated textures | FireTexture, WaterTexture and its subclasses, ScriptedTexture, `AnimNext` sequences, on drawn surfaces or grid hits | — | Exact for the drawn set |

**Checks of the pipeline.** `--probe` reruns the three Island fixtures of
[viewport window](script-window-viewport.md#camera-pass). The results agree
with what those fixtures draw in Play:

- Camera `-4650,2150,-150` at pitch -5461 sees the floor mirror: one mirror
  child frame on surface 785, 16,441 px.
- `-4760,10430,-200` at pitch 2000, yaw -7040 sees the skyline: a sky frame
  of 16,961 px.
- `-2561,-2200,340` at yaw 49152, with the player at `-2561,-2682,320`, sees
  the street lamp's corona: one icon, Light176. The player's leaf lists it.

The ray grid and OccludeBsp agree on mirror and sky pixels to within 1,779 px.
The largest gap is the Island floor mirror under the swing. VersaLife's mirror
panes are non-solid, so only OccludeBsp sees them. The mirror and sky columns
use OccludeBsp's spans.

## Per-camera results

These are all 37 cameras whose window holds a mirror, sky, fog or a corona at
some point of its swing. Terminals are abbreviated `CSn[view]`. A camera that
appears on several terminals is listed once.

| Map | Terminal [view] "title" | Camera | Swing | Mirror px | Sky px | Fog px (≥2/255) | Coronas | Moving or unshared content in view |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| 01_NYC_UNATCOIsland | CS2[0] "Statue Ruin Mag Locks" | SecurityCamera3 | ±8192, 8 s | – | 4 (0–4115, 56%) | – | 0 (0–1, 44%) Light175 | pawns Terrorist31(Patrolling), SecurityBot1(Patrolling), Terrorist13(Patrolling); moving AutoTurret0, SecurityCamera2 |
| 01_NYC_UNATCOIsland | CS0[0] "SATCOM Compound" | SecurityCamera4 | ±8192, 8 s | – | 3301 (1097–5279) | – | – | moving SatelliteDish0 (rotating), DeusExMover7, DeusExMover21 |
| 01_NYC_UNATCOIsland | CS0[1] "Exterior UNATCO HQ" | SecurityCamera2 | ±8192, 8 s | – | 6681 (4913–6801) | – | – | pawns Terrorist32(Patrolling), UNATCOTroop4(Patrolling), UNATCOTroop0(Patrolling); animated WetTexture drtywater_a |
| 01_NYC_UNATCOIsland | CS0[2] "Interior UNATCO HQ" | SecurityCamera1 | ±8192, 8 s | 6012 (2997–6081) | – | – | – | pawns UNATCOTroop6(Sitting) |
| 02_NYC_Underground | CS1[2], CS0[2] "Pipe Access Tunnel" | SecurityCamera3 | ±14000, 24 s | – | – | 0 (0–6195, 88%); ≥0.1: 0 (0–2384, 63%); max 0.474 | – | moving ParticleGenerator0, 1, WaterDrips8, 9, AutoTurretSmall2; animated WetTexture drtywater_a |
| 03_NYC_Airfield | CS0[0] "Right Turret" | SecurityCamera0 | ±4096, 8 s | – | 382 (329–382) | – | – | pawns SecurityBot0, GuntherHermann0 (Patrolling), UNATCOTroop0, 1 (Wandering); moving AutoTurret2, 5, 6, SecurityCamera3, 4, DeusExMover25; noise light 65 px; no login (hack) |
| 03_NYC_Airfield | CS0[1] "Left Turret" | SecurityCamera1 | ±4096, 8 s | – | 50 (0–337, 56%) | – | – | pawns SecurityBot0, GuntherHermann0 (Patrolling), UNATCOTroop0, 1 (Wandering); moving AutoTurret1, DeusExMover17; no login (hack) |
| 03_NYC_Airfield | CS2[0] "Right Turret" | SecurityCamera3 | ±4096, 8 s | – | 38 (25–682) | – | – | pawns SecurityBot0(Patrolling), UNATCOTroop0, 1 (Wandering); moving AutoTurret1, 6, DeusExMover17; noise light 130 px; no login (hack) |
| 03_NYC_Airfield | CS2[1] "Left Turret" | SecurityCamera4 | ±4096, 8 s | – | 564 (516–615) | – | 0 (0–1, 6%) Light37 | pawns SecurityBot0(Patrolling), UNATCOTroop0, 1 (Wandering); moving AutoTurret1, 2, 5, SecurityCamera0, 1, DeusExMover25; noise light 130 px; no login (hack) |
| 03_NYC_Airfield | CS3[0] "Right Turret" | SecurityCamera5 | ±4096, 8 s | – | 48 (14–48) | – | 0 (0–3, 44%) Light37, Light41, Light50 | pawns Terrorist12, SecurityBot7 (Patrolling); moving AutoTurret16, DeusExMover19, 20, 65, 67; noise light 65 px; no login (hack) |
| 03_NYC_Airfield | CS3[1] "Left Turret" | SecurityCamera10 | ±4096, 8 s | – | 194 (2–204) | – | – | pawns GuntherHermann0, SecurityBot7 (Patrolling); moving AutoTurret7, DeusExMover26; noise light 65 px; no login (hack) |
| 03_NYC_Airfield | CS8[0] "Right Turret" | SecurityCamera11 | ±4096, 8 s | – | 58 (33–68) | – | 0 (0–2, 44%) Light65, Light68 | pawns Terrorist12, SecurityBot2 (Patrolling), UNATCOTroop10(Wandering); moving AutoTurret18; no login (hack) |
| 03_NYC_Airfield | CS8[1] "Left Turret" | SecurityCamera12 | ±4096, 8 s | – | 74 (72–80) | – | – | pawns SecurityBot2(Patrolling); moving AutoTurret17, DeusExMover27; no login (hack) |
| 03_NYC_Airfield | CS9[0] "Right Turret" | SecurityCamera13 | ±4096, 8 s | – | 0 (0–4, 6%) | – | – | pawns Terrorist16, 17 (Standing); moving AutoTurret20; no login (hack) |
| 03_NYC_Airfield | CS9[1] "Left Turret" | SecurityCamera14 | ±4096, 8 s | – | 137 (0–158, 81%) | – | – | pawns Terrorist16, 17 (Standing); moving AutoTurret19, DeusExMover28; no login (hack) |
| 04_NYC_UNATCOIsland | CS0[0] "SATCOM Compound" | SecurityCamera4 | ±8192, 8 s | – | 4975 (2548–6289) | – | – | moving SatelliteDish0 (rotating), DeusExMover1, DeusExMover2 |
| 04_NYC_UNATCOIsland | CS0[1] "Exterior UNATCO HQ" | SecurityCamera2 | ±8192, 8 s | – | 6685 (4834–6792) | – | – | pawns UNATCOTroop14, 15 (Standing); animated WetTexture drtywater_a |
| 04_NYC_UNATCOIsland | CS0[2] "Interior UNATCO HQ" | SecurityCamera1 | ±8192, 8 s | 6090 (3048–6118) | – | – | – | pawns UNATCOTroop13(Sitting) |
| 06_HongKong_Helibase | CS0[1], CS1[1] "Barracks" | SecurityCamera0 | ±4000, 8 s | – | 100 (61–124) | – | – | pawns MJ12Troop0(Patrolling), MJ12Troop2(Standing), MJ12Troop1, 3, 4, 7 (Sitting); moving DeusExMover38, ProjectileGenerator2, 3, 5, 7 |
| 06_HongKong_Helibase | CS0[2], CS1[2] "Roof" | SecurityCamera2 | ±16000, 16 s | – | 8753 (4754–8796) | – | – | pawns MJ12Troop5, 6 (Standing); moving DeusExMover22, AutoTurret1, SatelliteDish0, 1 (rotating) |
| 06_HongKong_MJ12lab | CS0[2], CS1[2], CS2[2], CS3[2] "Grand Hall" | SecurityCamera2 | still | 4333 | – | – | – | pawns SpiderBot0(Standing); in the mirror MJ12Troop10(Patrolling); moving Earth1 (rotating), DeusExMover14, 38, 44, 48 |
| 06_HongKong_VersaLife | CS1[2] "Lobby Overview" | SecurityCamera8 | still | 132 | 424 | – | – | pawns Secretary0(Sitting), Cop1, MJ12Commando0, 1 (Standing); in the mirror Cop0(Standing); moving SecurityCamera1 |
| 06_HongKong_VersaLife | CS2[2] "Reception" | SecurityCamera1 | still | 733 | – | – | – | pawns Secretary0(Sitting), Cop0, Cop1 (Standing); moving SecurityCamera0 |
| 06_HongKong_WanChai_Street | CS3[2] "Building Lobby" | SecurityCamera4 | ±8192, 8 s | – | 0 (0–108, 13%) | – | – | pawns Businessman1(Standing); moving DeusExMover31, 32; animated FireTexture BP_FX_03 |
| 06_HongKong_WanChai_Underworld | CS0[0] "Club Monitor" | SecurityCamera3 | ±8192, 8 s | 83 (0–83, 56%), a BreakableGlass17 pane | – | – | – | 14 pawns (one Dancing); in the mirror Female5(Dancing), MJ12Commando1(Wandering); animated Stoc_B01 |
| 09_NYC_Dockyard | CS1[0] "Rear Perimeter Gate" | SecurityCamera7 | still | – | 2057 | – | – | moving DeusExMover129, 133 |
| 09_NYC_Dockyard | CS1[1] "Ammo Storage Facility" | SecurityCamera0 | still | – | 2717 | – | – | moving DeusExMover129 |
| 09_NYC_Ship | CS3[0] "Entry Area" (4.2.28 `sh3` window 1) | SecurityCamera1 | still | – | – | 1411; ≥0.1: –; max 0.049 | – | none |
| 09_NYC_Ship | CS3[1] "Locker Room" (4.2.28 `sh3` window 2) | SecurityCamera19 | ±8192, 8 s | – | – | 30000 (19395–30000); ≥0.1: 18195 (9989–18195); max 0.692 | – | pawns Mechanic5(Wandering); moving DeusExMover8, 19, 21, 23, 37 |
| 11_Paris_Everett | CS0[1], CS3[1] "Rooftop Helipad" | SecurityCamera3 | ±8192, 8 s | – | 1400 (382–1421) | – | – | pawns Mechanic0(Wandering); moving DeusExMover5 |
| 12_Vandenberg_Cmd | CS1[1], CS2[1] "" | SecurityCamera0 | ±8192, 12 s | – | 665 (0–1022, 63%) | – | – | moving DeusExMover8, 20, AutoTurret1, 2, SecurityCamera3 |
| 12_Vandenberg_Cmd | CS1[2], CS2[2] "" | SecurityCamera3 | ±4096, 12 s | – | 1 (0–342, 44%) | – | – | moving AutoTurret2, Earth0 (rotating), BreakableGlass0, SecurityCamera0 |
| 15_Area51_Bunker | CS3[0] "" | SecurityCamera3 | ±8192, 8 s | – | 0 (0–413, 50%) | – | – | moving AutoTurret2; noise light 2530 px |
| 15_Area51_Final | CS0[1] "" (`radiation_camera`) | SecurityCamera1 | still | – | – | 30000; ≥0.1: 30000; max 1 | – | none |
| 15_Area51_Page | CS1[0] "Environmental containment" | SecurityCamera1 | ±4096, 8 s | – | – | 20676 (18632–21697); ≥0.1: 13995 (8595–14384); max 0.939 | – | pawns Gray0(Wandering); moving DeusExMover32; animated WetTexture bluewater_a |

Some views see corona lights with a clear line, inside the window, that JC's
leaf does not list. The original draws none of those, so a capture there
checks the player-leaf rule by the corona's absence. Island CS0[1] (Exterior
UNATCO HQ) has 2–7 such lights per sample: Light5, Light7, Light42, Light168,
Light169 and Light171–173. Island CS2[0] has Light84 and Light172–174, and
eight Airfield cameras have similar lights.

## Ranking

The best view for one effect keeps that effect in view over the whole swing,
or comes from a still camera. It covers many pixels, and has nothing else in
view that the two programs do not share or that moves: pawns, noise-driven
light, procedural textures, movers or devices. It also shows no other effect.
`node scripts/census-camera-views.mjs --text` prints the ranking with the
penalties written out.

**Mirror.**

1. Island CS0[2] "Interior UNATCO HQ", SecurityCamera1, in mission 01 and in
   mission 04. The HQ lobby's floor mirror (surfaces 785 and 1218 in mission
   01) covers 2,997–6,081 px, 10–20% of the window, at every point of the
   swing. One
   sitting trooper is in view and in the reflection (UNATCOTroop6, or
   UNATCOTroop13 in mission 04). No mover, device or animated texture is in
   view.
2. MJ12 lab "Grand Hall", SecurityCamera2: still, 4,333 px. The view also
   holds the rotating Earth1 globe, four movers and a standing SpiderBot, and
   MJ12Troop10 (Patrolling) may appear in the reflection.
3. VersaLife "Reception", 733 px, and "Lobby Overview", 132 px plus sky.
   Both have three to five pawns in view.

**Sky.**

1. Dockyard CS1[1] "Ammo Storage Facility" (SecurityCamera0, 2,717 px) and
   CS1[0] "Rear Perimeter Gate" (SecurityCamera7, 2,057 px). Both cameras are
   still, and only gates or doors are in view: DeusExMover129 and 133, whose
   measured poses `camera-acceptance.mjs` writes. The same terminal's window
   3, "Commander's Office" (SecurityCamera1), tracks JC and has two ceiling
   fans in view, so it is judged apart or masked.
2. Island CS0[1] "Exterior UNATCO HQ" (4,913–6,801 px over the whole swing,
   with three patrolling pawns) and CS0[0] "SATCOM Compound" (1,097–5,279 px,
   with the rotating SatelliteDish0 and two movers).
3. Helibase "Roof": 4,754–8,796 px, but two pawns, two rotating satellite
   dishes and a turret are in view. Paris Everett "Rooftop Helipad":
   382–1,421 px, with one pawn.

**Fog.**

1. Area 51 Final CS0[1], SecurityCamera1 (Tag `radiation_camera`, an empty
   title). The camera is still and sits inside Light98's sphere (306 of 375
   units). Light97, Light98, Light99 and Light100 are all Steady, with
   VolumeRadius 14, VolumeBrightness 64 and LightBrightness 55, in bFogZone
   zone 2 (ZoneInfo1). Fog covers every pixel at 0.1 or more, reaching
   saturation (0.99 or more) on about 1,360 px. The census found nothing else
   in view: no pawn, mover, device, animated texture or noise light. The
   capture (2026-10-17) showed that wrong: Gray0 and Gray3 (Wandering) stand
   in the original's view, and ScientistMaleCarcass2 lies 130 units from the
   camera in Play's. The census's line test from the camera to each pawn's
   Location missed the Grays.
2. Ship CS3[1] "Locker Room" and CS3[0] "Entry Area" are already stored as
   `sh3` and `sh3b`. Window 2 has heavy fog but also the door and the
   wandering Mechanic5. Window 1's fog is faint (at most 0.05, about 12/255),
   and that window matched under 4.2.28 within the MAD 0.03–0.17 that the
   Ship's room windows read. It is weak fog evidence that already exists.
3. Area 51 Page "Environmental containment": 18,632–21,697 px of fog up to
   0.94, but the wandering Gray0 and an animated water texture are in view.
4. Underground "Pipe Access Tunnel": fog only over 88% of the swing, from
   TriggerLights 23–26, with particle generators and water drips in view.

**Corona.** No view is clean. In all four views whose corona would draw:

- the camera swings, and the corona shows over 6–44% of the swing;
- the icon sits at the window's top edge (its centre at y -19 to 16, while
  the icon is 40 px);
- pawns and sky are in view.

The four:

- Island CS2[0] "Statue Ruin Mag Locks" (SecurityCamera3, login
  NSF001/smashthestate): Light175 over the positive half of the swing, at
  x 125–197, y 7–16.
- Airfield CS3[0] (SecurityCamera5): Light37, Light41 and Light50 over the
  negative 44%.
- Airfield CS8[0] (SecurityCamera11): Light65 and Light68.
- Airfield CS2[1] (SecurityCamera4): Light37 at one end of the swing.

The Airfield terminals have no userList, so the capture route cannot log in
to them. Coronas are this rare because the pass lists the lights of JC's
leaf, and JC stands at the terminal.

## Recommended captures

These follow the shape of the 4.2.28 rows: `camera-original.sh` (the
original's frame and state), `camera-acceptance.mjs play` and `compare`, and
a `CAMERA({...})` row in `validate-stage4-acceptance.mjs`. `--cameras` lists
the cameras in window order. As written, `camera-original.sh` and
`camera-acceptance.mjs original` run on the Linux host (its Wine lock path,
`hyprctl`). This census ran neither.

* **4.2.29 mirror and sky, Island's SATCOM terminal** (`cs0`, three windows):
  window 3 has the floor mirror at every point of the swing; windows 1 and 2
  have sky. Window 2 also checks the corona pass's player-leaf rule by
  absence. Mask the pawns as `cs1` masked the terrorists.
  `DX_HYPRLAND=1 scripts/camera-original.sh 01_NYC_UNATCOIsland --computer ComputerSecurity0 --user SATCOM --password UNATCO_001 --cameras SecurityCamera4,SecurityCamera2,SecurityCamera1 --name cs0`,
  then `node scripts/camera-acceptance.mjs play --map 01_NYC_UNATCOIsland --computer ComputerSecurity0 --user SATCOM --password UNATCO_001 --camera-actor SecurityCamera4 --name cs0`
  and `node scripts/camera-acceptance.mjs compare --map 01_NYC_UNATCOIsland --name cs0`;
  a `CAMERA({map: '01_NYC_UNATCOIsland', computer: 'ComputerSecurity0', user: 'SATCOM', password: 'UNATCO_001', cameraActor: 'SecurityCamera4', name: 'cs0', windows: 3})` row.
  Mission 04's copy (`04_NYC_UNATCOIsland`, the same terminal and cameras)
  has standing troopers in window 2 instead of patrolling ones.
* **4.2.29 fog, Area 51's radiation camera** (`a51f`; window 1 swings, with
  SpiderBot2 and a mover, window 2 is the fog view, window 3 has no camera):
  `DX_HYPRLAND=1 scripts/camera-original.sh 15_Area51_Final --computer ComputerSecurity0 --user Area51 --password bravo13 --cameras SecurityCamera0,SecurityCamera1 --name a51f`,
  then `node scripts/camera-acceptance.mjs play --map 15_Area51_Final --computer ComputerSecurity0 --user Area51 --password bravo13 --camera-actor SecurityCamera1 --name a51f`
  and `compare --map 15_Area51_Final --name a51f`; judge window 2.
* **4.2.29 sky with still cameras, Dockyard** (`dk1`; windows 1 and 2;
  window 3 tracks JC):
  `DX_HYPRLAND=1 scripts/camera-original.sh 09_NYC_Dockyard --computer ComputerSecurity1 --user USFEMA --password SECURITY --cameras SecurityCamera7,SecurityCamera0,SecurityCamera1 --name dk1`,
  then `node scripts/camera-acceptance.mjs play --map 09_NYC_Dockyard --computer ComputerSecurity1 --user USFEMA --password SECURITY --camera-actor SecurityCamera7 --name dk1`
  and `compare --map 09_NYC_Dockyard --name dk1`.
* **4.2.29 corona** (not ready): Island CS2[0], SecurityCamera3, needs the
  camera at a yaw offset between +3134 and +8192 at the hold. The swing's
  phase at the hold is not controlled, so this needs repeated captures until
  one lands in that range, or tooling that turns the camera off on its
  terminal and pans it (the UI path above). In the meantime, `cs0` window 2
  covers the corona rule by absence.
  `DX_HYPRLAND=1 scripts/camera-original.sh 01_NYC_UNATCOIsland --computer ComputerSecurity2 --user NSF001 --password smashthestate --cameras SecurityCamera3,SecurityCamera7 --name cs2`.

## Captured against the original (2026-10-17)

The recommended views were captured on the Mac under CrossOver and compared
with Play at the same held level time, with the original's pawns, carcasses
and movers written into Play. Details and the route's Mac changes are in
[visual acceptance](visual-acceptance.md#on-the-mac-and-windows-with-a-mirror-sky-or-fog-2026-10-17-rows-4228-and-4229).

| Store | View | MAD per window | edge recall | edge precision | Verdict at the gate's thresholds |
| --- | --- | ---: | ---: | ---: | --- |
| `cs0` | Island ComputerSecurity0: sky, sky, floor mirror | 0.06 / 0.02 / 0.04 | .997 / 1 / 1 | .999 / .999 / 1 | pass |
| `dk1` | Dockyard ComputerSecurity1: sky, sky, office | 0.02 / 0.02 / 0.08 | 1 / 1 / .996 | 1 / 1 / .972 | pass |
| `a51f` | Area 51 Final ComputerSecurity0: corridor, fog | 0.90 / 0.69 | .696 / .920 | .930 / .867 | window 2 fails precision: two Grays and a carcass placed differently, not the fog |
| `sh3b` | Ship ComputerSecurity3: faint fog, heavy fog, break room | 0.06 / 0.89 / 0.03 | .999 / .950 / .998 | .999 / .758 / .997 | window 2 fails precision: five locker doors lit differently |

Play's plan confirms the effect in each window: sky child frames in `cs0`
windows 1 and 2, a mirror child frame in window 3, and fog maps on 176
surfaces in `a51f` window 2.

## Views that find no camera

| Map | Terminal | Tags with no SecurityCamera |
| --- | --- | --- |
| 03_NYC_UNATCOIsland, 05_NYC_UNATCOIsland | ComputerSecurity0 | UN_CamSystem01, 02, 03 |
| 04_NYC_Underground | ComputerSecurity0 | Camera1, 2, 3 |
| 05_NYC_UNATCOMJ12lab | ComputerSecurity2 | armorycam |
| 09_NYC_ShipFan | ComputerSecurity6 | Main |

Six maps have terminals but no reachable camera at all: the four above,
08_NYC_Underground and 12_Vandenberg_Computer.

## Not covered

- The yaw at the hold. The census gives a swing's range and the share of time
  each effect is in view. A capture measures the actual rotation.
- Movers, pawns and the corona line's blocking actors at their map placement,
  not where they stand at the hold. `camera-acceptance.mjs` writes the
  measured mover poses into Play.
- What the mirror frames reflect, beyond the moving-actor check above. No
  view has sky inside a mirror frame or a mirror nested in another; only
  VersaLife's Lobby Overview has mirror and sky in one view, side by side.
- Fog values from the 24-bit loop and the colour table, and whether the
  original's LeafVolumetricLighting culls change them. The culls drop only
  lights that add nothing ([volumetric fog](volumetric-fog.md)).
- JC's exact spot. The original's route ghost-flies him to the same point
  and walks him onto the floor. The corona list depends on his leaf. The
  census also prints the leaf at the computer's own height, as
  `playerFrontLeaf` in the JSON. The two leaves differ at 15 of the 79
  terminals with a camera. Among the terminals named above, they differ only
  at Island's ComputerSecurity2 (leaves 5548 and 5559), and both leaves list
  Light175.

## Reproduce

```bash
node scripts/census-camera-views.mjs --text
```

```bash
node scripts/census-camera-views.mjs --maps 01_NYC_UNATCOIsland --probe -4650,2150,-150:-5461,0,0
```

Without `--text` the script prints the full JSON on stdout: per view, every
sample's mirror frames, sky pixels, ray-grid counts, fog lights, coronas and
actors in view. Pipe it to a file outside the repository.
