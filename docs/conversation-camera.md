# Third-person conversations: camera, letterbox and speech channels

UNATCO Island's `MeetPaul` is the first third-person conversation the player
reaches (Liberty Island blocker 6 in the [roadmap](roadmap.md)). This note
records the original evidence for what Play now runs on that path, and what
stays open. `scripts/validate-island-conversation.mjs` follows it from Player
start to the first choice; `scripts/validate-root-raw-background.mjs` checks
the raw background clip list against Extension.dll.

## How Paul reaches the player (original data)

Paul starts on the dock with `Orders=Standing` (`HomeTag=Start`). Entering
`DataLinkTrigger0` (radius 300) plays `DL_StartGame`: Alex's line, then a
`ConEventTrigger` with `triggerTag=PaulRunningToPlayer`, which is
`OrdersTrigger2` (`Event=PaulDenton`, `Orders=RunningTo`, no `ordersTag`, so
toward the player). `MeetPaul` has `bInvokeRadius=True` and
`bFirstPerson=False`; it starts when Paul arrives, offers the rifle/GEP
gun/crossbow choice, transfers the chosen weapon and ends with
`ConEventTrigger PaulWandering`. In the forward-walk workload the InfoLink
plays at tick 37, the orders trigger fires at tick 802, MeetPaul starts at
tick 1872 and the choice appears at tick 4720.

## Conversation.CreateConCamera (native 2051)

ConSys.dll (SHA-256 `f20c4d89…`) registers 2051 to `execCreateConCamera`
`0x100106f0`:

1. `Stack.Code++` (P_FINISH).
2. `UObject::CreatePackage(NULL, L"DeusEx")` (`0x1001d360`).
3. `FName(NAME_None)`, then `DConCamera::operator new` `0x10003d10`(size
   `0x84`, package, name, `RF_Public`), which is
   `StaticAllocateObject(DConCamera::StaticClass 0x1001e1d8, package,
   NAME_None, 4, NULL, *GError, NULL)`.
4. A null allocation stores 0 in `*Result`; otherwise the constructor
   `0x10003ce0`: `UObject::UObject()`, vtable `0x10013610`, `+0x28`
   (`cameraActor`) = 0. Vtable slot `+0x24` is thunk `0x100110c2`, Core
   `UObject::Destroy`.

`script-conplay-live.mjs` performs exactly this. CreatePackage's find branch
needs DeusEx.u (loaded since boot) as a registered Core.Package object, so the
live registry gets the same package record the DeusExConText package already
has (`script-conversation-startup.mjs`). The camera is `ConCamera0` in the
DeusEx package. Its script (`ConCamera.uc`: `InitializeCameraValues`,
`CreateHighlights`' two `ConLight` spawns, `CalculateCameraPosition`,
`ActorObstructed`) is ordinary bytecode on the interpreter; `game.view()`
already calls the original `DeusExPlayer.PlayerCalcView`, which hands the view
to it during a third-person conversation.

## GetCurrentRes

`ConPlay.GetCurrentResolutionWidth` picks the speech and name fonts from
`player.ConsoleCommand("GetCurrentRes")`. WinDrv.dll's
`UWindowsViewport::Exec` (`0x11106d90`, `this` = the viewport's FExec at
`+0x2c`) runs `UViewport::Exec`, then tests `EndFullscreen`,
`ToggleFullscreen` and `GetCurrentRes`; the last is
`Ar.Logf(L"%ix%i", SizeX, SizeY, bits)` (`0x11106e23`–`0x11106e63`) with
`SizeX`/`SizeY` at viewport `+0x78`/`+0x7c` (SDK layout) and a third argument
(`ColorBytes`, 2 when 0, times 8) that the format does not consume. The
browser's viewport size is the drawing buffer each HUD frame paints at (the
same width and height the root canvas gets); before the first frame it is
unknown and the command is a boundary. A headless run therefore paints the HUD
every frame, as Play does.

## Raw background (the letterbox)

`ConWindowActive.CalculateWindowSizes` calls `root.SetRenderViewport` with
the area between its upper and lower bars. Each frame
`XRootWindow::PaintWindows` calls `DrawRawBackground(gc, rawBackground,
rawColor)` (`0x1003c720`) before the window tree. The root's
`rawBackground` is Extension's `Solid` texture and `rawColor` is black, so the
original fills the unrendered bars black.

* `DrawRawBackground`: PushGC, EnableDrawing(1), SetStyle(1),
  SetTileColor(color), `GetRawBackgroundClipList(NULL, list)` into a static
  TArray, then per rect at `(clipX+originX, clipY+originY)`
  DrawStretchedTexture from `(0,0)` over `rawBackgroundWidth/Height`
  (`+0x5f0/+0x5f4`) when `bStretchRawBackground` (`+0x5d8` bit 2), else
  DrawPattern anchored there; PopGC.
* `GetRawBackgroundClipList` (`0x1003c5f0`): for `win == NULL` the list
  restarts as the root's clip rect (`0x1003c0c0`) less the rendered area: all
  of it when `bRender` (bit 0) alone, the `renderX/Y/Width/Height` rect
  (`+0x5dc..+0x5e8`) in the root's origin when `bClipRender` (bit 1) too. A
  window with `bDrawRawBackground` (`XWindow +0x38` bit 0) passes the list to
  its visible children bottom to top (`0x1004c740`, `0x1004c680`); any other
  window removes its own clip rect.
* The subtraction `0x1003c1d0` cuts each rect present on entry into up to four
  strips (top, bottom, left, right). The first nonempty strip replaces the
  rect, the rest are appended, and rects with a non-positive width or height
  are compacted out in order. Several sums stay on the x87 stack (the
  clipped bottom and the right and bottom edges used for the strips), so
  the translation follows each `fld`/`fadd`/`fsub`/`fstp` on the x87 model.
  PaintWindows runs inside the render pass (PostRenderFlash), under x87
  precision control 24 ([render-pass precision](render-pass-precision.md)):
  since 2026-10-06 each FADD and FSUB rounds to 24 bits (`x87-pc24.mjs`
  `p24add`), so those stack values are 24-bit.

`validate-root-raw-background` runs `0x1003c1d0` and `0x1003c5f0` unchanged in
Unicorn at control word `0x007f` (`ORACLE_CW` overrides it; the 64-bit
translation differed in 225 of the 2,131 cases there) (Core's FArray::Add/Remove through the probe FMalloc) on 2,131 cases
(random and edge rects including infinities, NaN, signed zeros and huge
values; the conversation letterbox; window trees mixing visibility,
`bDrawRawBackground` and nesting): every rect matches bit for bit, in order.
Eight of nine planted mutations fail it; the survivor (rounding the cut's right
edge before the comparison) is equivalent, because rounding is monotone.
In Play, `validate-island-conversation` checks every clipped frame (2,849 in
its run): the frame's first tiles are one `Solid` tile per clip rect at its
pixels, and the held bars equal `CalculateWindowSizes`' full size from the
class's own `upperFinalHeightPercent`/`lowerFinalHeightPercent` (98 and
200 px at 1440×960; the choice keeps that layout).

Before this, `drawRawBackground` returned early for an unclipped render, which
is equivalent there (the list empties) but skipped the GC calls; it now runs
the whole body. The clip list costs about 5–9 µs per frame.

## Speech channels on Island

`execPlaySound` builds a sound's channel id as `(Index << 4) + (Slot << 1) +
bNoOverride` from the emitter's `GObjObjects` index. Training's conversation
speakers have a captured table (`training-npc-identities.mjs`); Island had
none, so Paul's first line stopped at "PlaySound requires the registered
global UObject index". The original game was run in the CrossOver bottle
(`ad/scripts/original-game.mjs launch`, then `open 01_NYC_UNATCOIsland` from
the boot map's console, the convention of the Training capture) and
`tools/dump-gobjects-win.exe` read its registry: 48,327 objects,
`Package.01_NYC_UNATCOIsland` at 33504, `PaulDenton.PaulDenton0` at **35713**
(`.cache/original-gobjects-20261001-island-open.txt`, local evidence).
`island-npc-identities.mjs` holds all 58 pre-placed Island pawns by name; the
validator checks each against the capture by class and name.

A pre-placed object's index depends on what the process loaded before the
map. Both captures follow one convention (the map opened from the boot map's
console); an index after the intro's travel to Island was not measured.

## Conversation object graphs

`prepareConversationGraph` attached the flag refs, events, speeches and event
flag refs. MeetPaul's `ConEventChoice.ChoiceList` (ConChoice objects with
`nextChoice` and `flagRef` chains) was not attached, so the first choice
stopped at "Object is not attached to script runtime". The walk now also
follows every ObjectProperty of each attached object into the same conversation
package, which covers choices and any other event-owned object.

## Omitted button colours (ButtonWindow natives 1593, 1594)

`ConWindowActive` calls `SetTextColors` with four of six colours and
`SetButtonColors` with the first omitted. The execs (`0x100087b0`,
`0x10008940`) preset an omitted Color to R=G=B=0xff (SetButtonColors) or
R=0, G=0xff, B=0 (SetTextColors) and never write its alpha. The first
parameter's temporary is a stale local byte; the others reuse the exec's
FFrame* argument slot, so their alpha is that pointer's top byte. Neither is
recoverable, and neither is observable: the colours reach only the style
table, `curTileColor`/`curTextColor` (no shipped script reads them), and the
GC colour dwords, whose planes take bytes 0–2. No shipped script reads `.A` or
compares those colours (`AugmentationDisplayWindow` saves and restores a tile
colour with GetTileColor). Alpha 0 is used.

## The player in behind view

DeusExPlayer's Conversation state sets `bBehindView` for a third-person
conversation (and clears it in EndState). Render.dll's caller of the
level-actor pass excludes no actor in behind view (`0x10b1a161`–`0x10b1a18e`),
so JC's own mesh is drawn in the conversation shots. The actor layer used to
skip the player unconditionally; it now admits the player and applies the
original exclusion each frame ([actor layer](npc-mesh-preview.md)), so the
mesh appears with the first behind-view frame and is hidden again in first
person.

## The 3D view clip (render viewport)

`XRootWindow` PreRender (`0x1003a760`, from `0x10038336`) receives the Canvas;
its Frame is `Canvas+0x7c`. At `0x1003a7dd..0x1003a8c5` it edits the frame
before `FSceneNode::ComputeRenderSize`:

* without `bRender` (`+0x5d8` bit 0) the frame size becomes 0 x 0;
* with `bClipRender` (bit 1) too, the root's float `renderX/Y/Width/Height`
  (`+0x5dc..+0x5e8`) scale by the integer `hMultiplier/vMultiplier`
  (`+0x730/+0x734`; vMultiplier passes through a float32 store) and truncate
  through MSVCRT `_ftol`: `x0 = ftol(hm*renderX + XB)`,
  `x1 = ftol(hm*renderWidth + x0)`, the same for y, each product and sum on
  the x87 stack. x0/y0 are raised to XB/YB and x1/y1 lowered to
  X+XB/Y+YB; the frame becomes XB = x0, YB = y0, X = x1 - x0, Y = y1 - y0.
  PreRender runs from the PreRender event, after URender::PreRender set
  precision control 24: the FILDs are exact and each FMUL and FIADD rounds
  to 24 bits before `_ftol` truncates.

ComputeRenderSize then projects with that X (horizontal FOV across the rect's
width), the Canvas gets `ClipX/ClipY` and `SetClip(XB, YB, X, Y)`, and the
root's scene frame (`+0x740`, read by ConvertVectorToCoordinates, which adds
`renderX/Y` back) is this frame. `SetRenderViewport` (1514) sets bClipRender
and the four floats; `EnableRendering` (1512) is turned off only by
DeusExRootWindow.ShowSnapshot when `UIBackground` is 1 or 2 (default 0).

`rootRenderViewport` (script-root-render-viewport.mjs) is the translation, on
the x87 model at 24 bits (`x87-pc24.mjs`, since 2026-10-06). The window host writes the scene frame at the clipped size and
exposes `renderViewport`; Play's viewer draws the sky, scene and weapon passes
inside that rect (viewport and scissor, camera aspect from the rect, the
horizontal FOV kept) and the HUD over the whole canvas. With rendering off it
draws no 3D. In MeetPaul the band is the area between the bars.

`validate-root-render-viewport` runs `0x1003a7dd..0x1003a8cb` unchanged in
Unicorn (Extension rebased, x87 control word 0x007f; `ORACLE_CW` overrides
it, and the 64-bit translation differed in 443 of the cases there, the
multipliers past 2^24 among them) on 1,783 cases: flag
combinations, multipliers up to INT_MIN/INT_MAX and above 2^24, float
specials, signed zeros, denormals, NaN, infinities, clamps on both sides and
odd frames. All four frame ints match. Three of four planted mutations fail
it (no float32 store of vMultiplier, x1 from the clamped x0, double instead of
x87 arithmetic); the survivor (`>=` in the clamp) is equivalent.
`validate-island-conversation` checks on every clipped frame that the render
rect is exactly the band between the two raw-background bars (2,849 clipped
frames with the 24-bit translations, 2026-10-06). Cost: MeetPaul's clipped
letterbox at multiplier 1 (seven interleaved Node rounds) went from 0.48 to
0.69 µs per call, once per frame.

## The intro (00_Intro, forced play)

`MissionIntro.FirstFrame` starts `Intro` on BobPage through
`StartConversationByName('Intro', bob, False, True)`: bForcePlay. Its
`ConWindowActive.CalculateWindowSizes` does not use the height percentages:
`cinHeight = root.height * 0.5625 * root.width / root.height` (16:9 of the
width), both bars `int(0.5 * (root.height - cinHeight))`, the render viewport
the band between them, and `ResetRenderViewport` when that is negative. The
speech text is the lower bar's (`ConPlay` shows it when `player.bSubtitles`
or there is no audio; User.ini has `bSubtitles=True`). Measured in Play at the
first speech (root units, GUI scale): 1440×824, the canvas left by the page
bars, scale 1, bars 7: the text is clipped; 1440×960 scale 2, bars 37 (74
px); 1024×768 bars 96; 1512×856 bars 2; 1920×1080 scale 2, bars 0 (no
subtitle area at 16:9 or wider, by the original's own formula). The viewer's
"Hide UI" button (remembered per browser) removes the page bars so the root
takes the window's aspect.

With render feedback (the camera's shots stamp LastRenderTime) the intro's
NSF and MJ12 pawns fight. That reached the findPathToward falling-target
delegation (the findPathTo worker, [pawn navigation](script-pawn-nav.md))
and native 523 `EAdjustJump`; both are translated and verified against
Engine.dll. Headless with render feedback stamped from `game.view()`, and in
Chromium, the conversation then plays all 21 speeches without a pause until
`MissionIntro.Timer` sees `Intro_Played` and `PostIntro` runs
`Level.Game.SendPlayer(Self, "dxonly")` → `ClientTravel` (native 0): map
travel, a Stage 6 boundary. Play stops there with a labeled
`TravelBoundary` (`travel-boundary.mjs`: URL, travel type, bItems) and the
viewer says the map ended by travelling, instead of an unknown-native pause.

### Intro shots: CameraPoint, not ConCamera

The Intro conversation has no ConEventMoveCamera; it plays in first-person
display mode, so `DeusExPlayer.PlayerCalcView` returns the player's own
Location + EyeHeight and ViewRotation, and `ConPlay.cameraInfo` stays None.
The shots come from the map's 49 `Engine.CameraPoint` actors (sequence 0 to
1015): `CameraPoint.Idle` at sequence 0 puts the player in Paralyzed
(Letterbox), hides it, clears `bCollideWorld`, `SetCollision(False, False,
False)` and BaseEyeHeight, then `Running.Tick` executes the commands (MOVE
cuts or smooth moves, PUSH, FOV, TILT, PAN, WAIT, TRIGGER, some `bRandom`)
through `Player.SetLocation`, `ViewRotation` and `SetFOVAngle`.

Sequence 74 cuts from Page's close-up (sequence 71, 23 units from his face)
to the clone's tank at (-11054,-8558,-5085), and 76 cranes up 81 units over
7.25 s. Until 2026-10-02 that `SetLocation` failed: the movement port's
collision word was a host copy that missed the script write to
`bCollideWorld`, so `FarMoveActor` ran FindSpot (relocation.mjs, the
`flags & 2` gate) and refused the destination. The camera stayed at Page's
position with the new rotation, a red wall, for 7.25 s, and the crane then
landed 22-28 units off its target where FindSpot fitted the cylinder. The
player's collision word is now its image ([Rust core](rust-core.md), "Not
moved, and why"); headless the cut lands on (-11054,-8558,-5085) at tick
7105 and the crane ends on (-11054,-8560,-5004).

The last point, sequence 1015 at (31,-38,57), lies away from all level
geometry, so the frame under "Or better than kings. Gods." is black. The
original shows the same black frame (observed in the running original game,
2026-10-02).

## Frames against the original (2026-10-16)

Until now the camera, the letterbox and the subtitles were compared with the DLLs and run end to end, but no frame of the original's conversation had
been compared with Play's. Four held frames of MeetPaul, taken in the running original under Wine and in Play from the same inputs, now are
(`scripts/conversation-acceptance.mjs`, `scripts/live-acceptance.mjs`; the numbers are in [visual acceptance](visual-acceptance.md#conversation-frames-2026-10-16)).

**The scene.** `01_NYC_UNATCOIsland`, frozen at the load (`bPlayersOnly`, the live scenes' frozen start); the console puts the player where a conversation can start
(a ghost: `set Location (X=-2385,Y=8393,Z=-256.2)` 100 units in front of Paul, `set ViewRotation` toward him, then `walk`, which registers the collision there: the
rest height is Z -256.2, the value Play's physics gives and the original's held player reads). The tracer releases the level at its third tick with the delta forced to
1/60 s and records the CRT stream state of every tick ([live scenes](visual-acceptance.md#live-scenes-2026-10-13)). MeetPaul is radius-invoked (radius 180, and it is
also `bInvokeFrob`): `ScriptedPawn.Tick`'s low-priority branch calls `StartConversation(Self, IM_Radius)`, and the original's conversation starts at unfrozen tick 6, its
letterbox bars finish their slide about 0.7 s later, and its speeches follow the timeline of the table below. Every camera shot of MeetPaul is authored (`randomCamera` is
false and each speech is preceded by a `ConEventMoveCamera`), so the stream does not choose a camera.

| Unfrozen tick | Speech (sound id) | Camera position (ConCamera.SetCameraValues) | What the frame shows |
| --- | --- | --- | --- |
| 100 | 287 JC: "Paul! I thought you were in Hong Kong." | 2 `CP_SideAbove` | the first shot: both speakers from above, the bars settled, JC's subtitle |
| 250 | 288 Paul: "Welcome to the Coalition, JC..." | 2 | the same camera on the other speaker: his name and line in cyan |
| 600 | 289 JC: "Didn't think you'd have a choice..." | 4 `CP_ShoulderLeft` | the cut: over JC's shoulder to Paul, the skyline |
| 750 | 290 Paul: "The NSF -- they hit one of our shipments..." | 5 `CP_ShoulderRight` | the cut to the other shoulder |

**Holding and taking the frame.** The tracer holds the level at a tick (it returns from `ULevel::Tick`; the game keeps drawing) and the frame is the original's own `Shot` at
Brightness 2/3, where it is the framebuffer (Play's ramp is the identity at its 0.4; [method](visual-acceptance.md#method)). A conversation window swallows every key:
`ConWindowActive.VirtualKeyPressed` returns True for all of them but Up and Down, so Print Screen (which the interface frames use under a modal screen) and the numpad `*`
never reach `Shot`, and the typed console is not reachable either (Enter and Space would skip the speech). The window answers one key itself, the hard-coded Ctrl+F9
(`ConsoleCommand("SHOT")`), and it reads Ctrl through `IsKeyDown`, so the harness holds Ctrl through the Wine input queue (`sdown CTRL`) and sends F9
(`live-acceptance.mjs --cmds "N:@ctrlshot name"`, `--shot-ctrl`). A force-played conversation (the intro's) passes every key but Escape to the root window, which answers Ctrl+F9 and Print Screen itself (`DeusExRootWindow.VirtualKeyPressed`), so the same
`@ctrlshot` takes the intro's frames; the numpad `*` binding did not fire there (four tries, no bitmap). The first Ctrl+F9 of a run was once lost, so the harness repeats it while the level stays held. Play replays the trace's ticks and takes the
page's frame at the last one (`live-acceptance.mjs play --ticks N --shot name`), the page's canvas pinned to 1280x720 as in the interface frames, `?antialias=0&detailTextures=0`.

**What the frames said, and the causes.**

1. **The replay harness drew the 3D view without the letterbox (a harness defect, fixed).** The first comparison put the whole 3D view 38.5 pixels lower in Play (the best
   vertical alignment of the two frames' band is 38.5 rows; mean absolute difference 3.0, edge recall .58). `sim-session.mjs begin()` took the render rectangle of a live replay as the
   whole frame (`forced ? {x: 0, y: 0, width, height}`): the replay forces the frame size to the original's window, and that branch skipped the root window's own
   render viewport. The projection then centred on the full frame (360) instead of the band between the bars (321.5), a difference of exactly 38.5 rows. The page's
   own path was right: a free-running Play frame of the same shot (`live-acceptance.mjs snap`, 600 page frames after the release, the camera of the 600-tick frame) aligns with the
   original's frame at 0 rows and 0 columns (mean absolute luminance difference 0.45 over the band at that alignment; the animation and speech phase of a free run are not matched). The replay now takes `game.renderViewport(width, height)` at the forced size.
   The letterbox bars and the subtitle were pixel-equal from the first comparison.
2. **The mouth is a host input (measured and fed, not a divergence).** Paul's and JC's mouth shapes follow `Pawn.nextPhoneme`, which only Galaxy's audio update writes, from
   the audio the host plays in real time ([lip sync](lip-sync.md): "Inputs that only the host can supply"). A replay has no such audio, so the original's mouths moved and Play's
   did not (Paul's `BlendAnimSequence[0]`: `MouthClosed` against `None` from tick 145; 356 pixels over 10 in the face of the 600-tick frame). The original's letters are
   read back from the trace (the tick each `MouthA`...`MouthClosed` blend started, for Paul and, with `--player-blend`, for JC: 46 letters), fed to `nextPhoneme` at the
   tick they took effect (`live-acceptance.mjs play --phonemes`, `conversation-acceptance.mjs phonemes`; `live-probe.mjs` `phonemes`), and the replay does not run Galaxy's
   own analysis of the page's audio then. `Pawn.LipSynch` (script) maps the letters as in Play. With the feed every watched field of every watched actor, Paul's and JC's blend
   channels included, is equal for all 750 ticks except the player's `AnimFrame` at the first ticks (0.0985 against 0.0860 at tick 1, a tween phase; equal later) and two
   guards' `LastRenderTime` (the render history before the release, a measured input of [live scenes](visual-acceptance.md#live-scenes-2026-10-13)).
3. **What remains is the polygon edge.** All four frames are within 2 of 255 everywhere except 0.07 to 0.11% of the pixels, one-pixel lines on the silhouettes and mesh
   triangle edges and the glints of the glasses (zoomed ten times: [visual acceptance](visual-acceptance.md#conversation-frames-2026-10-16)); the shading of the faces (the two `ConLight`s of
   `CreateHighlights`), the hair, the jackets, the floor, the skyline and the subtitle text equal the original's.

**The camera itself, read from the running original.** With the level held at tick 250 the camera object `ConCamera0` and the actors it places itself by were read out of the
original (`dump-actor-win.exe`, the offsets Play's `conversationProbe({offsets})` gives): `LastLocation` (-2455.69531, 8316.91895, -164.018921), `LastRotation` (59636, 3394, 0),
`cameraPosition` 2, `cameraMode` 1, `firstActor` JC, `secondActor` PaulDenton0, `heightModifier` 10.5, `centerModifier` 0, `distanceMultiplier` 1, `rotation` (59636, 17824, 0),
`setActorCount` 1, `firstActorRotation` 51105, `bUsingFallback` 0; JC and Paul have `BaseEyeHeight` 40, `CollisionHeight` 43, `CollisionRadius` 20 and the `BreatheLight` frame
0.774999082. Play's `conversationProbe` at the same tick reads the same values, the camera's location and rotation bit for bit.

Not covered by these frames, by name: the camera's transition frames (`cameraTransition` is 255, a cut, in all of MeetPaul), the choice screen (the buttons, the focus; only
its layout is compared with Extension.dll, `validate-island-conversation`), the later speeches and cameras (positions 0 and 7), the interactive camera, the speech audio
(Galaxy's MPEG decoder is not translated), and any conversation off Island and the intro (below).

## The intro against the original (2026-10-16, gate row 4.5.7)

The intro (`00_Intro`, `--no-ghost --keep-traveling`, tag `in2`, 2,250 ticks, frames at ticks 170, 1,000 and 2,250) replays equal to the original in every watched field of
all 82 watched actors, the clock and the stream draws for all 2,250 ticks, and its three frames match within the polygon edge ([visual acceptance](visual-acceptance.md#conversation-frames-2026-10-16)).
At 1280x720 the force-played conversation's window is 16:9 of the width, the whole frame: no bars and no subtitle, the 3D view fills it. Before the fix below the replay diverged from tick 1
(the player's Z and Physics, a stream draw at tick 38, `Fighter` against `BreatheLight` on Bob Page and Walton Simons at tick 16 to 18, JC `Dying` at tick 1,200). All of that was one cause in Play and one in the harness.

**The cause in Play: `AActor::FindBase` traced a box with the wrong extent.** The original's player stands in `PlayerWalking` (Physics 1, Z -80.2) through the frozen phase; at unfrozen tick 1 `CameraPoint.Idle` sends it to
`Paralyzed, Letterbox` and the label's `SetPhysics(PHYS_None)` leaves Physics 0 and Z -80.2. Play ended tick 1 in Physics 2 (falling), Velocity -15.8 and Z -80.33. A script trace of the player's tick 1
(`live-acceptance.mjs play --script-trace 'JCDentonMale*' --script-ticks 1:1`) read: `gotoState Paralyzed Letterbox`, `SetCollision` (native 262), the label's `SetPhysics` (native 3970), and inside it the `BaseChange` event whose own
`SetPhysics(PHYS_Falling)` (`Pawn.BaseChange`: `Base == None && Physics == PHYS_None`). `SetPhysics(PHYS_None)` runs `FindBase`, which traces 8 units straight down from `Location` for the actor's cylinder; with no hit it
clears `Base` through `SetSupportBase(null)`/`SetBase`, whose notification is `BaseChange`. The standing player's trace did not hit: `findActorBase` passed the extent as `{CollisionRadius, CollisionHeight, CollisionRadius}`, so the box's half height was 20
(the radius) where the player's is 43: its lowest position, 8 units down, reached 28 below the center and the floor it rests on is 43 below. The body of `AActor::FindBase` (Engine.dll `0x103c9470`) loads `+0x1d8` (height) then `+0x1d4` (radius), stores the radius, radius and height to
the three stack slots it passes by value (`0x103c94a8` to `0x103c9511`): the extent is `(CollisionRadius, CollisionRadius, CollisionHeight)`, X, Y, Z. `findActorBase` now builds it so
(`src/runtime/script-actor-collision.mjs`), and `scripts/validate-native-find-base.mjs` (original body under Unicorn, `native-find-base-oracle.py`; the level's `SingleLineCheck` is the only stub) compares 144 cases (4 cylinder sizes,
3 locations including the intro player's, 3 bases, 4 answers) for the call's start, end, flags (`0x17`), extent and extra node flags and for the resulting Base, Physics, standing counts and `Detach`/`Attach`/`BaseChange` events: equal, and with the
old order the same validator reports the extent. The function runs for every actor whose `SetPhysics(PHYS_None/Walking/...)` has no explicit floor, at every map's start too: the replays of rows 4.1.5 to 4.1.8 (Island, Club, Underworld, five campaign maps at 1,200 ticks)
and `npm test` (652 tests) pass unchanged.

**The harness: a standing player.** `live-acceptance.mjs play --no-ghost` placed the player at the original's pose but left it in the Physics its login gave it (falling); the original's had landed in a frozen phase of tens of seconds.
The replay now ticks the frozen level (`bPlayersOnly`) until the player is in the pose's Physics, at the pose's Location and without velocity (`the player after N frames` in the log; 4 to 6 page frames), because the first tick in Physics 1 can still be 0.4 units off its rest height.

**The mouth, a second look.** With the measured letters fed, one actor differed: Bob Page's blend channel at tick 773 (`BlendAnimFrame` -1 against 0, `BlendTweenRate` 10 against 0). `Pawn.LipSynch` ends a speech with `TweenBlendAnim('MouthClosed', tweentime)` where `tweentime` is a local that
only the speaking branch assigns (0): the channel jumps to MouthClosed with frame 0 and rate 0, and no letter was written (Galaxy analyses only while `bIsSpeaking`). The letter extraction (`conversation-acceptance.mjs phonemes`) took that jump for a letter 'X',
which stayed in `nextPhoneme` and made the first `LipSynch` of Bob's next speech tween one tick before the original's. It now leaves those jumps out (three in the intro, none in MeetPaul) and takes a restart of the blended sequence (BlendAnimFrame -1, rate 10, the sequence unchanged) as a letter
(one in the intro, at 773: the letter before it blended nothing). MeetPaul's feed is unchanged (the same 46 letters), and the intro then replays equal to tick 2,250.

## MeetManderley against the original (2026-10-16, gate row 4.5.8)

The campaign's next third-person conversation, `01_NYC_UNATCOHQ`'s MeetManderley (radius 160 and frob, JC and `JosephManderley0`, audio package Mission01, speeches 233 to 243), was captured in the running original twice
(tags `mmA`, 1,100 ticks, and `mmB`, 580 ticks; two loads: the original's frames and traces are reproducible) and replayed in Play from the same inputs as MeetPaul: the level frozen at the load, the ghost put at (310, -164, 287.6299)
facing Manderley (yaw 63442) and set walking (`set ... Location`, `set ... ViewRotation`, `walk`; the player is a ghost when it is moved, so the collision hash is not stale), released by the tracer at the original's per-tick delta and stream state, the measured mouth letters fed
(`conversation-acceptance.mjs phonemes --scene manderley`, 61 and 31 letters), Brightness 2/3, `?antialias=0&detailTextures=0`. `live-original.sh` found the original's population equal to Play's seeded load on the first try (885 actors, none missing).

**The original's timeline** (read from the trace: the speakers' state and mouth channels): the conversation starts at unfrozen tick 14 (both are in `Conversation`); JC speaks from 14 to about 76 (speech 233, "Reporting for duty, sir."), Manderley from about 114 to 451 (234), JC from 530 (235,
"A refreshing change from the academy, sir."), Manderley again from about 652 (238, "Don't despise training, my boy..."). Ctrl+F9 took no frame at tick 100 and at tick 1,100 (neither mouth moved at either tick), and one at ticks 40, 300, 450, 580 and 700.

**What the replay said.** Over the replayed ticks every watched actor (the player, Manderley and the 20 pawns of the level, JC's and Manderley's blend channels included), the clock and the stream draws equal the original's, in both loads, with the one exception MeetPaul has: the player's `AnimFrame` at tick 1
(0.3139 against 0.3014 here, 0.0985 against 0.0860 on Island: the same 0.0125, a tween phase; equal from the next ticks on). The frames:

| Frame | Load, tick | Speech, camera | band identical, >2, >10; over 10 off the edges; recall/precision |
| --- | --- | --- | --- |
| mm2 | mmA, 450 | 234 Manderley, the fallback camera | .95527, 7,239, 1,926; 94; .999/.999 |
| mm3 | mmA, 700 | 238 Manderley, camera 4, over JC's shoulder | .96407, 5,131, 1,893; 81; .999/1 |
| mmB2 | mmB, 300 | 234 Manderley, the fallback camera | .95542, 7,158, 1,848; 90; .999/1 |
| mmB3 | mmB, 580 | 235 JC, the fallback camera | .95202, 8,216, 2,375; 91; .999/1 |

The two letterbox bars and the subtitle line are identical to the pixel in all four (maximum difference 0), no outlier block. **The fallback camera:** the first thing to read was whether the original also takes the fallback camera for the speeches whose authored position 3 the room obstructs.
Play's camera at tick 450 (`conversationProbe`: position 0, `bUsingFallback` true, location (344.37, -263.31, 326.61), rotation (-19, 14668, 0), the level time 120.2646 equal to the capture's 120.26458) gives mm2's frame to the polygon edge, so the original takes it too (the camera object itself was not read from the original this time).

**The frame at tick 40 (mmB1), stored and not compared.** The letterbox was settled in the original's frame (bars 74 rows above, the subtitle to row 587) and still sliding in Play's (the first non-black row 56, the subtitle to row 624); Play's frame at tick 60 is settled (74, 587). The bars' slide
is a window animation: the original, held at the tick while the game keeps drawing, finished it in real time; Play's is driven by the level's ticks and stops with the hold. Both agree whenever the held tick is more than about 42 ticks past the conversation's start (every other frame here and in MeetPaul).
Not examined beyond these measurements (which of the two clocks the original's window uses is read from the held frame, not from its code).

**A harness defect found on the way: the player was not standing when the replay began.** One gate run of mmA failed at tick 1 (the player's Z 287.61 against 287.8, so every pawn's DistanceFromPlayer differed): `walk` puts the ghost on its feet with Physics falling, and the player takes a few ticks to settle (this one, 0.17 below its rest height,
fell 2 units, landed and was lifted to 287.799988, the original's rest height). The replay began before that in a slow run. `live-acceptance.mjs play` now ticks the frozen level until the player is in the pose's Physics, at its Location and at rest, for every pose in Physics 1 (it did so for the intro's no-ghost player first).
MeetPaul's gate row passes unchanged with it.

## Stored originals, the gate rows and how to repeat them (2026-10-16)

The gate rows 4.5.5, 4.5.7 and 4.5.8 are `conversation` checks in `scripts/validate-stage4-acceptance.mjs` (`--only '^4\.5\.[578]$'`; about 5, 4 and 6.5 minutes): the check stages the tag's trace, lists and frames from the stores, regenerates the mouth letters from the trace
(`conversation-acceptance.mjs phonemes`, a derived file), replays one frame at a time (`live-acceptance.mjs play --ticks N --shot name`), compares the traced actors over the longest replay (`live-acceptance.mjs compare`, the measured exceptions allowed by name), and compares each frame by region
(`conversation-acceptance.mjs compare`: letterbox bars, subtitle, the 3D band, and the pixels off by more than 10 away from every hard edge). The thresholds are mine ([judgement chosen in the gate](stage-4-exit-criteria.md#how-the-gate-judges)).

**Stored originals** (main checkout `.work`, new names, nothing overwritten; the gate reads them from there):
`acceptance/01_NYC_UNATCOIsland/cvA{1..4}-original.png` with `cvA{n}-time.txt` and `live-acceptance/01_NYC_UNATCOIsland/{original-trace,watch,population,commands,hold,phonemes}-cvA.*` (MeetPaul, ticks 100/250/600/750, `--player-blend`);
`acceptance/00_Intro/in2-in{1,3,4}-original.png` with `-time.txt` (ticks 170, 1000, 2250: the Earth globe, a shot in the VersaLife room, a clinic shot) and `live-acceptance/00_Intro/*-in2.*` (the 2,250-tick trace; the frame at tick 530 was not taken, Ctrl+F9 lost three times at that hold);
`acceptance/01_NYC_UNATCOHQ/{mm2,mm3,mmB1,mmB2,mmB3}-original.png` (and `.bmp`, `-time.txt`) and `live-acceptance/01_NYC_UNATCOHQ/{original-trace,watch,population,commands,hold}-{mmA,mmB}.*` (MeetManderley, `--player-blend`; mm1 at tick 100 and mm4 at tick 1,100 gave no bitmap). Ctrl+F9 was also lost once at the first hold of the first MeetPaul run.
The tag's mouth letters are not stored: the gate and `conversation-acceptance.mjs phonemes --scene S --tag T` rebuild them.

**Repeating a capture.** `scripts/live-original.sh <map> --ticks N --delta 0.0166666675 --monitor 20 --tag T --player-blend --shot LAST --shot-ctrl --cmds "N1:@ctrlshot A|N2:@ctrlshot B" --early-cmds "set WinDrv.WindowsClient Brightness 0.666667|set ... Location|set ... ViewRotation|walk"`
(`DX_HYPRLAND=1`; Wine lock; first run `live-acceptance.mjs population --map <map> --seed 1`). A fresh worktree needs the ignored Wine tools (`ad/build/{dump-actor-win,dump-flags-win,dx-live-win}.exe`, `ad/tools/dxinput.exe`), copied from another worktree. `scripts/live-original.sh` with `--hold` never reaches `DX_POST`
(node stays alive on the tracer); read the held original by running the script by hand and `touch <trace>.resume` after.

## Open

* With the browser's render feedback the terrorists near the dock can fight
  the security bots before MeetPaul. The `DeusEx.Tracer` they fire paused Play
  at "Non-Pawn performPhysics physProjectile (0x103d4600) is not linked" until
  October 1, when physProjectile was translated ([projectile](projectile.md),
  bit-exact against the original body; `validate-island-tracer` flies real
  Tracers on Island).
* Lip sync is implemented ([lip sync](lip-sync.md)); every map's object-index capture exists ([captures](object-index-captures.md)); MeetManderley is compared with the original ([above](#meetmanderley-against-the-original-2026-10-16-gate-row-458)).
* **The letterbox slide in a held frame.** The original's bars finish sliding in real time while the level is held; Play's, driven by the level's ticks, stop mid-slide at the hold (MeetManderley tick 40: rows 56/624 against the original's 74/587; Play settles by tick 60). Frames taken within about 42 ticks of a
  conversation's start (and so the first speech of the intro) cannot be matched by tick; not examined in the original's or Play's code.
* **A pawn placed inside the floor.** The ghost put 0.17 below its rest height by `set Location` and set walking falls 2 units, lands and is lifted to the original's rest height (287.799988) in Play; the original's own sequence for that placement was not traced (its end state is the same).
* **The player's `AnimFrame` at the replay's first ticks** is 0.0125 behind the original's in every conversation capture (Island 0.0985/0.0860, Manderley 0.3139/0.3014 and 0.3008/0.2883) and equal after a few ticks; allowed by name in the gate, not explained (a tween phase of the written pose).
* The choice is made through the original input path (2026-10-01): Down
  reaches `RootWindow.VirtualKeyPressed`, whose `MoveFocusDown` (native 1445,
  `XWindow::MoveFocus`; the 1442–1447 family is bound,
  [window input](script-window-input.md)) moves the focus from the first
  ConChoiceWindow to the second, and Enter activates it.
  `ConWindowActive.ButtonActivated` plays the GEP gun choice; Paul answers,
  `ConEventTransferObject` gives the GEP gun, rockets and the Liberty Island
  DataVault image, the PaulWandering trigger sets Paul's orders and MeetPaul
  ends at tick 7137 (`validate-island-conversation` phase 7). The other two
  choices were run the same way once (Enter on the first; Down, Down, Enter):
  the sniper rifle and its ammunition, ending at tick 7203, and the mini
  crossbow and poison darts, ending at tick 7253, both without a runtime
  error; the validator keeps only the GEP gun branch.
* ConLight light on actor meshes is compared on the four MeetPaul frames ([frames](#frames-against-the-original-2026-10-16)) and four MeetManderley frames; `ConEventMoveCamera`'s camera positions 2, 4, 5 and the fallback camera are compared with the original's frames;
  positions 3 and 7, the camera transitions (`cameraTransition` other than a cut) and the interactive camera are reached by the original script but not compared with the original renderer.
* `GetCurrentColorDepth`, `GetRes`, `SetRes` and the other viewport commands
  remain boundaries.
