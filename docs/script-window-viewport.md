# ViewportWindow (XViewportWindow)

The Extension window that draws the world from an actor or a location into its
rectangle. Security computers use three of them (ComputerSecurityCameraWindow,
one per camera view); the spy drone and the scope/targeting views use the same
class. This note covers the window's own bodies and natives, and the camera
pass that draws the world into the rectangle ("Camera pass" below, with its
unsupported parts).

Authority: installed Extension.dll (SHA-256 `93c35502…8b916d9c`, preferred
base 0x10000000), Engine.dll for APlayerPawn's view list, the DX SDK 1112f
`ExtViewport.h` layout, and Extension.u `ViewportWindow.uc`.

## Storage

Registration size 0x1b4, vtable 0x1005be08.

| Offset | Field |
| --- | --- |
| +0x14c | flags: 1 bEnableViewport, 2 bClearZ, 4 bShowActor, 8 bShowWeapons, 0x10 bUseViewRotation, 0x20 bUseEyeHeight, 0x40 bWatchEyeHeight |
| +0x150 | fov (float) |
| +0x154 | defaultTexture |
| +0x158 | defaultColor (RGBA) |
| +0x15c / +0x160 | originActor / watchActor |
| +0x164 / +0x170 | location / relLocation |
| +0x17c / +0x188 | rotation / relRotation |
| +0x194 | private bOriginActorDestroyed (bit 0) |
| +0x198 / +0x1a4 | lastLocation / lastRotation |
| +0x1b0 | viewportFrame (the FSceneNode that Draw creates and PostDraw finishes) |

## Bodies

`src/runtime/script-window-viewport.mjs` translates each body below.

- Constructor 0x10018af0: UObject, XExtensionObject vtable, XClipRect zeroed, then the viewport vtable.
- Init 0x10049f10: XWindow::Init; clears bDrawRawBackground; sets flags enable,
  clearZ, useViewRotation, useEyeHeight and watchEyeHeight, and clears
  showActor and showWeapons; fov 90; defaultColor black, with an alpha byte
  equal to the high byte of the parent argument slot (a stale stack byte);
  clears every vector, rotator and actor; then
  `SetViewportActor(GetPlayerPawn(), TRUE, TRUE)`.
- CleanUp 0x1004a070: `SetViewportActor(NULL, TRUE, TRUE)`, then XWindow::CleanUp.
- SetViewportActor 0x1004a170: flags enable and useEyeHeight come from the
  arguments. Location and relLocation are cleared. If the origin changes, the
  player's `RemoveAdditionalView(old)` runs (vtable +0xb0), then
  `AddAdditionalView(new)` (vtable +0xac) unless the new origin is the player.
  The window then adds an actor reference to the new origin and removes the
  old one. lastLocation becomes the origin's Location, or the window's
  location when there is no origin.
- SetViewportLocation 0x1004a300: sets the enable flag, location and relLocation (zero); drops the origin reference; lastLocation = location.
- SetWatchActor 0x1004a400: sets the watchEyeHeight flag and clears both
  rotators. It swaps the watch reference. lastRotation is the look-at rotation
  from lastLocation, computed by Core's FVector::Rotation, or the window's
  rotation when there is no watch actor.
- SetRotation 0x1004a570: rotation, relRotation zero, drops the watch reference, lastRotation = rotation.
- SetFOVAngle 0x1004a660: values above 179.0f become 179.0f; values below
  double 0.1, and NaN (C0 set), become 0.1f.
- Natives 1945–1956: exec wrappers checked by the common exec-body harness
  (`validate-window-native-diff.mjs`). They cover EnableViewport,
  SetFOVAngle, ShowViewportActor, ShowWeapons, SetRelativeLocation,
  SetRelativeRotation, SetDefaultTexture and ClearZBuffer.
  - SetDefaultTexture's omitted colour is white (255,255,255). Its alpha is
    the high byte of an FFrame pointer, which is modelled as 0.
- Draw 0x1004a770:
  1. Origin and watch validity go through IsActorValid. A destroyed origin
     leaves the last frame in location/rotation and sets the private flag. A
     destroyed watch actor leaves lastRotation as the rotation.
  2. The frame position is the origin's Location. A Pawn origin with
     bUseEyeHeight adds EyeHeight.
  3. The frame rotation is the origin's Rotation. A PlayerPawn origin with
     bUseViewRotation uses ViewRotation instead.
  4. relLocation is applied as its length along `relLocation.Rotation() +
     rotation`, using the X axis of `GMath.UnitCoords / R`.
  5. A watch actor replaces the rotation with a look-at rotation, using the
     watch actor's eye height when bWatchEyeHeight is set. relRotation is
     then added.
  6. The script event CalcView (vtable +0x11c) runs. Its outputs become the
     frame and are stored as lastLocation/lastRotation.
  7. The renderer is `player.XLevel->Engine->Render`. CreateMasterFrame
     (+0x64) is called with the canvas viewport. The frame's
     XB/YB/X/Y are `ftol((clip + origin) * root multiplier)`, offset by any
     current canvas frame's XB/YB.
  8. The player's bBehindView is set unless bShowWeapons is set and the
     origin is the player. The player's FovAngle becomes the window's fov
     (as raw dwords). The origin's bHidden is set unless bShowActor.
  9. ComputeRenderSize runs. Canvas X/Y/ClipX/ClipY/Frame are switched to
     the frame. ClearZ (RenDev +0x90) runs if bClearZ, then RenderFrame
     calls Render->DrawWorld (+0x70).
  10. Every saved value is restored in reverse order.
  11. With no renderer, no canvas viewport, no frame, an empty size, or a
      disabled viewport, the fallback runs instead: PushGC, SetStyle(1),
      SetTileColor(defaultColor),
      `DrawPattern(0, 0, width, height, 0, 0, defaultTexture)`, PopGC.
      XWindow::Draw always follows.
- PostDraw 0x1004af20: XWindow::PostDraw, then FinishMasterFrame (+0x6c) if a frame exists.
- ConvertVectorToCoordinates 0x1004afc0: projects a point through the frame's
  Coords and FX2/FY2/projection, without the root multipliers. With no frame it
  hits assertion line 0x2cf, which we raise as an error.
- Engine APlayerPawn::AddAdditionalView 0x103ba540 /
  RemoveAdditionalView 0x103ba4c0 work on AdditionalViews[3] at +0x6a8:
  - Add stores the actor in the first empty slot. A null actor counts as
    success.
  - Remove clears the first match and shifts the later slots down. It does
    not clear the last slot.

## Reference cases

`scripts/native-window-viewport-oracle.py` runs the unchanged bodies under
Unicorn, with Extension rebased to 0x12000000 and Core/Engine at their native
bases. The XWindow/XGC leaves, render services and the CalcView event are
recorded host events. GMath is built by its own FGlobalMath constructor.
`scripts/validate-window-viewport-diff.mjs` replays the same steps through the
translation and compares every viewport field, the actor fields Draw saves and
restores, the reference table, AdditionalViews, the canvas, and the ordered
events.

Result: 18 cases and 97 steps are identical, and 10/10 mutations are detected.

- The cases cover Init, origin changes, player and pawn origins (view
  rotation, eye height, weapons), relative location and rotation, watch
  look-at and SetRotation, a destroyed origin and watch, the AdditionalViews
  shift, a CalcView override, the canvas-frame offset, and each fallback
  (disabled, no renderer, no canvas viewport, no frame, zero size).
- They also cover the FOV clamps, CleanUp, and projection both through a
  frame and without one.
- Default-colour alpha is a stale stack byte (the parent pointer's high
  byte), so it is compared as `parentHigh:rgb`.

## Play wiring

The window host admits `extension.viewportwindow` (construct, Init, CleanUp,
Draw, PostDraw, ConvertVectorToCoordinates, natives 1940–1943 and 1945–1956,
and member cleanup on destroy).

The render services are Play's:

- CreateMasterFrame allocates a heap scene node. ComputeRenderSize writes it
  with the recovered scene-frame translation (`writeWindowSceneFrame`), using
  the viewer's FovAngle while Draw holds the window's fov there.
- DrawWorld queues a `viewport` draw command in window order. The command
  holds the rectangle, location, rotation, fov, clearZ, the hidden origin,
  bBehindView and the frame's plan (below).

`AdditionalViews` is replicated. PlayerPawn.uc describes it as other actors
"the pawn can see from the point of view of". Its readers in Engine.dll
(network relevancy) are not traced. Play does not use it for rendering.

## Camera pass

### Original evidence

- **RenderFrame** (`0x1004b260`) calls `Render->DrawWorld(frame)` (vslot
  0x70) when the frame's X and Y are positive. It does nothing else.
- **DrawWorld** (Render.dll `0x10b1cb90`, see
  [bsp-occlusion.md](bsp-occlusion.md) "Call order") is one function for every
  root frame: it pushes the same frame argument for OccludeFrame
  (`0x10b1ce3b`) and for DrawFrame (`0x10b1ce44`), so the window's master
  frame gets everything the player's gets. In order, it:
  1. increments the frame counter (`0x10b5a700`, `0x10b1cbed`);
  2. runs OccludeFrame: SetupDynamics, OccludeBsp, dynamic lights and the
     child frames (mirror and sky), each child with its own SetupDynamics;
  3. runs DrawFrame: the children first, then the frame's surfaces with
     their decals and fog maps, its sprites and actors, and the corona pass;
  4. clears Z and calls the viewing actor's RenderOverlays, but only when it
     has a Target (`0x10b1ce4e..0x10b1cebd`: with bBehindView, `+0x318`
     bit 0, the actor is 0 and the call is skipped;
     [script-weapon-rendering.md](script-weapon-rendering.md)).
- **What each pass reads of the real viewport.** The frame is the window's,
  but `Frame->Viewport` is the player's viewport, so the viewport actor's
  fields are the player's: FovAngle (the window's while Draw holds it),
  bBehindView and Level, and for the corona pass the actor's `Region`
  (`0x10b1b46a`: `iLeaf` +0xcc must not be -1, `Zone` +0xc8 set), the
  render device's Coronas flag and `Frame->Recursion` (+0x1c) equal to 0,
  which a master frame is. The corona pass therefore visits the lights of
  the *player's* leaf and its LeafLights, runs its two line checks to the
  *camera frame's* `Coords.Origin`, projects with the camera frame's
  Coords, X, FX2, FY2 and Proj.Z, and shares the 32-entry GCache item
  (id 0x27) and the appSeconds clock with the main frame's pass. The decal
  block's gate (`0x10b1b0ca`) is `!RenDev->SpanBased && Client->Decals`
  with no frame test beyond ClipDecal's mirror rule (docs/decals.md).
  SetupForSurf's fog (docs/volumetric-fog.md) takes the frame DrawFrame is
  drawing, and DrawLodMesh and SetupForActor (docs/script-lodmesh-lod.md,
  docs/mesh-lighting.md) take the frame DrawActorSprite hands them: each
  frame's own Coords, FX, Mirror and ViewPlanes.
- **Why Draw sets bBehindView.** With bBehindView set, Target is None, so a
  camera view draws no weapon overlay. The flag also stops the level-actor
  pass from excluding the player, so JC is drawn in the view.
- **The origin is not drawn**, because Draw sets its bHidden.
- **Placement.** The view draws inside PostRender's window paint, after
  ClearZ, over whatever the HUD drew before it. The window draws after it
  then cover it. It runs after the main frame's DrawWorld, in the same
  game frame: its GetFrame calls, its lighting and its corona pass follow
  the main frame's.

### Play

The window host calls `viewportPlanner` (sim-session.mjs `planViewportPass`)
inside its DrawWorld service, while Draw holds the flags, and the page draws
the plan between the HUD's draws (main.mjs `viewportWorldPass`). The camera
frame is a root frame of its own: the same machinery as the main frame's runs
for it, in the original's order.

**Planning (simulation side).** In the worker `planViewportPass`:

- increments DrawWorld's frame counter;
- runs the frame's own SetupDynamics: the iterators' items are built again
  (`spriteScan.rescan`, from the shared random stream, with the first-person
  viewer rules off under bBehindView), then the candidates are packed from the
  actor layer's bindings (read live under Draw's flags: the camera hidden, the
  owner-see rules following bBehindView), the sprite records and the items;
- runs OccludeBsp from a master frame at the camera's location, rotation and
  fov, at the window's size, with its mirror and sky child frames. Each child
  frame runs its own SetupDynamics (the same patching of the root's
  candidates as the main frame's, `childDynamics`) and has its Frame->Sprite.
  The moving brush tracker is not updated again: the main frame's update
  stands, as the original updates it on the game thread when a mover moves,
  not in a DrawWorld. The master frame is built at the render pass's x87
  precision control 24 (render-precision.mjs: the HUD paint runs inside it):
  CreateMasterFrame (occlude.rs, the x87.rs model) rounds at 24 bits, where
  the main frame's, built before URender::PreRender, rounds at 64. The frame
  is CreateMasterFrame on the main viewport's size (the screen span) and Draw's
  ComputeRenderSize at 24 bits on the window's rectangle ([the 3D frame's
  projection](render-pass-precision.md#the-3d-frames-projection-2026-10-08));
  validate-bsp-occlusion's `masterControlWord` 0x007f cases run both against
  the unchanged original. Draw itself was not run;
- runs the decal block on the frame's saved polygons (`decalDraw.frame`: ClipDecal
  in decal.rs, binary32 at the pass's precision), which stamps each
  decal's LastRenderedTime;
- runs the corona pass (below), after the actors, as DrawFrame does;
- writes LastRenderTime (DrawActorSprite's render feedback) for exactly the
  Frame->Sprite actors and sprites of the root frame and of every child frame,
  whether three.js then culls them or not.

**Actors: the second DrawWorld's updates.** The original's GetFrame, DrawLodMesh
and SetupForActor calls for the camera frame come after the main frame's, in
the same game frame, from the camera frame's own inputs. Play does the same:
`actorScene.updateFrame` (actor-mesh-sim.mjs) updates each binding in the
Frame->Sprite of the root or of any child frame with the machinery of the main
frame's `update`, from the camera frame's inputs:

- the pose and GetFrame call are made now, so a binding the main frame did
  not pose (outside its view, or admitted only here) is posed in the HUD frame
  that draws it, with no earlier frame needed (the earlier rule posed from the
  previous HUD frame's Frame->Sprite);
- DrawLodMesh selects in every frame that draws the binding with that frame's
  Coords and FX (`seen.lod`, each child frame's `lod`) and the viewport
  actor's FovAngle, which is the window's fov while Draw holds it; the
  GetFrame calls come after the main frame's, the cache scalars left as the
  calls would leave them;
- SetupForActor and Light run per frame with the frame's own Coords, Mirror and
  LeafLights: the root frame's from the camera's master frame (`childFrame` of
  mesh-lighting-view.mjs with its words and ViewPlanes), each child frame's
  from its own (`lightFramesOf`);
- the records (plan, LOD parameters, lighting, colours) are shipped in the
  plan (`late`) and applied by the page before the pass
  (`npcPreview.draw.apply`, which runs the GPU passes again: the layout's frame
  counter and light pools advance on both sides), and each child pass's decision
  carries its frame's lighting and LOD (`framePasses`) as the main frame's mirror
  passes do. The bindings the frame does not draw are hidden in it.

**Sprites.** The sprite scene numbers its records and the plan names those each
frame draws, so the camera frame draws its own Frame->Sprite records, as does each
child frame; the records an iterator's items make for a child frame are appended
to the frame's sprite list.

**Coronas.** `coronaScan.update` takes the camera frame's master words, the
player's leaf and the frame's moving lights; its fade clock runs on from the
main pass's by the host's elapsed time (the original reads appSeconds again),
and it uses the same cache, so a light seen by both frames keeps one entry.

**Drawing (page side).** The page's HUD renderer splits its frame at each
`viewport` command. `viewportWorldPass` (main.mjs):

- applies the actor records and hides the frame's other actors;
- computes the frame's fog maps from its own Coords and each child frame's
  (`fog.update`, as for the main frame), and its decal fragments;
- draws the mirror child frames into their targets over the window's rectangle
  (mirrors.mjs `viewport`: a child's image sits in its target at the
  rectangle, flipped across the buffer's centre for an odd depth, where the
  parent's shader samples it), with the sky frames inside them, the actors'
  decisions for each pass and each pass's own sprites and fog maps
  (`framePassHelpers`, shared with the main frame's passes);
- clears Z, draws the root sky frame, the frame's polygons and sprites and its
  decals, and then the corona icons of the pass;

then the HUD draws continue.

**Light maps.** The light maps of the camera frame's OccludeBsp polygons, and
of its child frames', are animated and relit with the main frame's. When the
main frame lists no polygons, the light maps in the main frustum or a camera's
are.

**Check.** `scripts/validate-terminals-camera-browser.mjs` runs in the
default worker mode. On Island it:

- frobs ComputerSecurity1 with the page's right click;
- types the login on the keyboard;
- reads the plan through the worker-side terminal probe
  (`terminal-probe.mjs`): one frame from SecurityCamera5, OccludeBsp nodes,
  and the camera absent from its actors;
- reads the page's pass: the same rectangle, with draw calls, child frames,
  decal groups, corona icons and fog maps;
- checks the plan's location and rotation equal SecurityCamera5's, and
  its FOV is the window's;
- checks the stamped set is the frame's Frame->Sprite actors: of 82 mesh
  actors inside SecurityCamera5's view cone on Island, 72 (behind walls or
  beyond the room) are not in it and keep their LastRenderTime;
- checks that each binding the camera frame drew took its DrawLodMesh
  inputs from the camera frame (its Coords origin, the window's fov) and that
  the selection (detail bits, requested count, flags, morph, start, admitted
  faces) equals the original's in `native-lodmesh-lod-oracle.py` for the
  frame and for each of its child frames, and, for those whose state differs
  from the camera frame's, that the page's pass drew it (the GPU corner pass
  or the CPU geometry); that SetupForActor lit a watched prop with the
  camera frame's origin (meshLightProbe);
- checks that the decal block darkens its window (the same paused frame without
  it), that the corona icons sit where the validated corona code puts them
  from the master frame the pass read, and that the rectangle's image varies.

Options stand the camera elsewhere (`--camera x,y,z,pitch,yaw`, a fixture:
SecurityCamera5 is moved and stops swinging) and the player (`--player x,y,z`),
for views the map's own cameras do not have:

| Fixture (Island, worker mode) | What the camera frame draws |
| --- | --- |
| default | 56 nodes, 10 actors lit and LOD-chosen from the camera's Coords, JC's shadow decal (8 triangles) |
| `--camera=-4650,2150,-150,-5461,0` (looking down at a floor mirror, the plane z = -240) | a mirror child frame (65 nodes, 4 actors, one only the reflection draws), the reflection in the window |
| `--camera=-4760,10430,-200,2000,-7040` (outdoors) | a sky child frame with the skyline |
| `--player=-2561,-2682,320 --camera=-2561,-2200,340,0,49152` | the street lamp's corona (1 icon of 9 leaf lights) |
| `--camera=2018,-1588,40,-16000,0` (down at JC) | JC's shadow decal darkens 104 pixels, brightens none |
| Battery Park (`--map 02_NYC_BatteryPark --computer ComputerSecurity2 --user NSF --password righteous --camera-actor SecurityCamera1 --camera=-619,-3679,290,0,29856`) | the fog maps of 59 surfaces from the camera's Coords |

Cost, measured on the Linux host (headless SwiftShader, worker mode; three
interleaved pairs of runs of the tree before this change and this one, 240 drawn
frames each, Island's ComputerSecurity1 with its camera window open,
`scripts/measure-camera-cost.mjs`): medians of the per-frame phase times, before
and after. The worker's HUD step, which holds the window's plan, takes 5.78 and 5.92
ms; the plan itself (one sample per run) 1.9 and 3.0 ms; the page's HUD phase, its
camera draw included, 2.47 and 2.06 ms (the runs spread over 2.0-3.1 ms); the worker's
frame 20.1 and 17.6 ms (its tick, 8.7 and 7.6 ms, moves the most between runs). The
medians differ by less than the runs' own spread (the worker's HUD step ran 5.0 to
6.6 ms before), so the window adds between a tenth of a millisecond (the HUD step) and
about a millisecond (the plan's own samples) a frame in the worker; a view of a fogged
area costs what the fog maps cost for its surfaces (59 on the Battery Park fixture),
once per window.

### Unsupported or approximate (explicit)

- Iterator mesh items (a laser's beam, a DT_Mesh item) keep the main frame's
  pose and lighting in the camera frame: their bindings are not updated
  again, so an item the main frame did not draw is not drawn by the camera.
- The sprite records of the camera frame are the main scan's, except the
  iterators' (rebuilt for the frame): a plain DT_Sprite actor whose
  visibility follows the first-person viewer rules (bOnlyOwnerSee) is not read
  again under bBehindView.
- The mirror frames' own decals (none, as in the original), masked, modulated
  and two-sided mirrors, and the sky-through-mirror combinations carry the main
  frame's limits ([mirror-surfaces.md](mirror-surfaces.md)).
- The camera frame's moving brushes are where the main frame left them.
- A view with fog draws fog maps for every surface of every frame: the cost
  follows the fog (docs/volumetric-fog.md), once per frame per window.
- The clock of the camera frame's corona pass advances by the host's elapsed
  time; the original's appSeconds is the CPU clock too.
- No matched capture against the original's own frame of a camera view
  (2026-10-11, not attempted on this host). The window is only reachable
  through the security terminal, which needs a ticking level (the computer's
  activation animation and timers, the login), while visual acceptance
  ([method](visual-acceptance.md#method)) places the camera with `set Location`
  in a frozen level; `set Location` or `set Region` in a level that then ticks
  corrupts the collision hash. Leaving the level live instead gives NPC
  positions and animation that cannot be matched to Play's. The camera frame's
  parts are checked against the original's code and oracles instead (LOD,
  corona placement, decal block and master frame as above); the mirror
  reflection's placement in the window is checked visually only.

Reproduce:

- `NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-window-viewport-diff.mjs`
- `NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-window-native-diff.mjs`
- `node scripts/validate-terminals-play.mjs --map 01_NYC_UNATCOIsland --terminal ComputerSecurity1`
  (the security screen end to end, headless)
- `NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-terminals-camera-browser.mjs [--shot camera.png] [--camera ...] [--expect mirror,sky,decals,coronas,fog]` (the camera pass)
- `node scripts/measure-camera-cost.mjs [--root DIR]` (the camera window's cost per frame)
