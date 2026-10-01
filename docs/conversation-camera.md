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
  are compacted out in order. Several sums stay unrounded on the x87 stack
  (the clipped bottom and the right and bottom edges used for the strips), so
  the translation follows each `fld`/`fadd`/`fsub`/`fstp` on the x87 model.

`validate-root-raw-background` runs `0x1003c1d0` and `0x1003c5f0` unchanged in
Unicorn (Core's FArray::Add/Remove through the probe FMalloc) on 2,131 cases
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
  `x1 = ftol(hm*renderWidth + x0)`, the same for y, each product and sum
  unrounded on the x87 stack. x0/y0 are raised to XB/YB and x1/y1 lowered to
  X+XB/Y+YB; the frame becomes XB = x0, YB = y0, X = x1 - x0, Y = y1 - y0.

ComputeRenderSize then projects with that X (horizontal FOV across the rect's
width), the Canvas gets `ClipX/ClipY` and `SetClip(XB, YB, X, Y)`, and the
root's scene frame (`+0x740`, read by ConvertVectorToCoordinates, which adds
`renderX/Y` back) is this frame. `SetRenderViewport` (1514) sets bClipRender
and the four floats; `EnableRendering` (1512) is turned off only by
DeusExRootWindow.ShowSnapshot when `UIBackground` is 1 or 2 (default 0).

`rootRenderViewport` (script-root-render-viewport.mjs) is the translation, on
the x87 model. The window host writes the scene frame at the clipped size and
exposes `renderViewport`; Play's viewer draws the sky, scene and weapon passes
inside that rect (viewport and scissor, camera aspect from the rect, the
horizontal FOV kept) and the HUD over the whole canvas. With rendering off it
draws no 3D. In MeetPaul the band is the area between the bars.

`validate-root-render-viewport` runs `0x1003a7dd..0x1003a8cb` unchanged in
Unicorn (Extension rebased, x87 control word 0x037f) on 1,783 cases: flag
combinations, multipliers up to INT_MIN/INT_MAX and above 2^24, float
specials, signed zeros, denormals, NaN, infinities, clamps on both sides and
odd frames. All four frame ints match. Three of four planted mutations fail
it (no float32 store of vMultiplier, x1 from the clamped x0, double instead of
x87 arithmetic); the survivor (`>=` in the clamp) is equivalent.
`validate-island-conversation` checks on every clipped frame that the render
rect is exactly the band between the two raw-background bars.

## Open

* With the browser's render feedback the terrorists near the dock can fight
  the security bots before MeetPaul. The `DeusEx.Tracer` they fire paused Play
  at "Non-Pawn performPhysics physProjectile (0x103d4600) is not linked" until
  October 1, when physProjectile was translated ([projectile](projectile.md),
  bit-exact against the original body; `validate-island-tracer` flies real
  Tracers on Island).
* Lip sync is implemented ([lip sync](lip-sync.md)); other maps need their
  object-index capture first ([captures](object-index-captures.md)).
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
* ConLight light on actor meshes, `ConEventMoveCamera`'s other camera types
  and the interactive camera are reached by the original script but not
  compared with the original renderer.
* `GetCurrentColorDepth`, `GetRes`, `SetRes` and the other viewport commands
  remain boundaries.
