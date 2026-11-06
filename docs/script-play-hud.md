# Original Play HUD

Play constructs the installed `DeusExRootWindow` and `DeusExHUD` through their
original `InitWindow` bytecode. The shared native window host supplies the
recovered Extension family constructors, initialization, preferred sizes,
configuration, tree tick and GC drawing. The runtime uses one canonical
`player.rootWindow` and HUD for inventory, messages, InfoLink and ConPlay.

The authority is the installed `DeusEx.u` / `Extension.u` embedded source and
bytecode, plus `Extension.dll` and `Engine.dll` instructions. Extracted source,
binaries and captures remain local and ignored. See [host evidence](script-window-host.md),
[GC drawing](script-gc-draw-model.md), [root tick](script-window-root-tick.md),
[projection](script-window-scene-frame.md), and [input queries](script-input-console.md).

## Original behavior

- `DeusExHUD.InitWindow` creates ammo, hit, crosshair, object belt, active items,
  damage, compass, multiplayer skills, information, log, frob, augmentation,
  mission text, bark and received-item windows. `ConfigurationChanged` places
  these windows; the browser does not reproduce that layout with constants.
- `HUDObjectBelt` creates its ten slots with the original RadioBox/Tile families,
  including `ORDER_LeftThenUp`. `CreateNanoKeySlot` uses slot zero. Subsequent
  pickups enter through `DeusExPlayer.AddInventory` → root `AddInventory` →
  `AddObjectToBelt`. Digit keys run `DeusExPlayer.ActivateBelt N`, matching
  User.ini. The original root passes the slot item directly to PutInHand:
  repeating a populated slot retains that item; selecting an empty slot
  requests None and puts the held item away. The
  existing player scheduler now calls `UpdateInHand` before movement: original
  `PlayerWalking.PlayerTick` calls it through `MultiplayerTick` (which also
  serves single player) before `Super.PlayerTick`. This resumes the hand
  transition without manually advancing the weapon state machine. Other
  unrecovered PlayerTick effects remain separate boundaries.
- Original hit/compass/ammo ticks read the live player and weapon. The original
  health flash, energy and breath bars, compass wrapping, ammo labels and belt
  selection draw through their own windows. `AugmentationManager.RefreshAugDisplay`
  resumes the original post-root initialization step, including the possessed
  AugLight icon under the installed `bHUDShowAllAugs` preference.
- Frob brackets use original `FrobDisplayWindow.DrawWindow`, original window
  world-to-screen conversion and an Engine scene frame populated with the
  same camera origin, rotator and horizontal FOV as Play. The renderer currently
  uses 75 degrees; the scene-frame module records its admitted FOVs.
- HUD visibility, theme, border/background translucency, ammo format and log
  settings read the supplied User.ini/DefUser.ini scalar values. A missing
  scalar retains the compiled class default. Original theme-manager functions
  select the colors and textures.
- The native root chooses integer horizontal/vertical multipliers from the
  physical drawing-buffer size using the original 640×480 threshold math.
  Native GC clipping, glyphs, texture extents, colors and command order feed
  the Three.js compositor. No separate in-hand icon is drawn.

## Explicit remaining boundaries

Multiplayer is deferred by user request. `ConditionalBindMultiplayerKeys`,
called by root initialization even in single player, is an explicit recorded
boundary; it does not modify bindings or block the Training HUD.

InfoLink and ConPlay keep their existing specialized presentation and lifecycle
owners. Their frame adapter reads requested SetSize dimensions at +0x9c/+0xa0;
their partial layout does not populate the configured +0x80/+0x84 dimensions.
General HUD windows read configured dimensions through native field bindings.
They share the real root, HUD and byte heap; their delegated subtrees
are excluded from general tree layout/tick/draw/readiness to avoid applying two
owners to them. Native ComputerWindow cursor, fade and static interference are
not completed by this change. Received-item presentation retains its previously
recorded boundary. General window destruction, active focus navigation,
window timers, menus, cursor rendering and debug overlays remain unsupported
when reached. These are explicit errors, not silent substitute behavior.

The final WebGL tile compositor is a browser adapter. Whole-renderer pixel
identity against the original rasterizer is not established in general; for
the interface it is measured since 2026-10-15 ([interface frames](interface-frames.md)):
18 views of 00_Training (the HUD with its belt, log and the log's timeout, eight
persona screens, the main menu and three Settings screens, a datacube's
information display and the keypad) are within 2 of 255 of the original's frames
at every pixel but one scanline of the world, after two fixes the frames found
(GC's authored underline texture, and window ticks on real time rather than the
level's dilated delta). Original 3D mesh lighting also remains separate from
this HUD work. Window audio requests are recorded at their native call boundary
until a playback backend is connected.

## Actor draws in the HUD

The vision augmentation and the developer ActorDisplayWindow draw meshes from
`DrawWindow` through `GC.DrawActor` (1288) and clear depth with `GC.ClearZ`
(1295). The host queues `actor` and `clearZ` commands among the tile commands,
in window order; the page draws the actor between the tile batches in the
master frame. Evidence, the oracle and what is unsupported (bConstrain,
non-mesh DrawTypes, no original-frame comparison):
[gc-draw-actor.md](gc-draw-actor.md).

## Compositor batching boundary

The recovered native GC and Window traversal determine the ordered tile/glyph
command stream; the compositor must retain its texture, draw style, clipping,
source extents, tint and triangle order. A consecutive run of commands using
the same GPU material can share one vertex buffer and submission: depth tests
and writes are disabled for every HUD material, and the ordered triangles use
the same blend factors. A material change ends the run, including a return to
an earlier texture after an intervening command. No window script or GC command
is skipped or cached. This is a host submission change, not a change to native
window behavior or evidence of original rasterizer pixel identity.

`node --test test/hud-compositor.test.mjs` compares the emitted Float32
positions, UVs and tints and ordered styles against the previous individual
tile adapter, including clipping, texture changes, overlapping blend styles,
buffer growth and reuse. The original-window integration validator below
continues to cover the command source.

An isolated Chromium/Metal render comparison against the individual-tile
adapter at `1a17e36` found no differences across 1,536,000 RGBA channels in five
320×240 frames. The frames cover masked, opaque, translucent and modulated
styles, overlapping tiles, clipping, interleaved materials, empty output and
buffer reuse/growth. A 151-command fixture became three submissions and a
257-command glyph run became one; a 90-command interleaved-material fixture
retained all 90 submissions. Local check sources are `.work/hud-pixels.mjs`
and `.work/hud-reference.mjs`, outside Git. This is adapter equivalence,
not an additional claim about the original rasterizer.

## Modulated tiles (2026-10-30)

A DSTY_Modulated tile ignores the GC's tile color and is masked. Deus Ex's `D3DDrv.dll` `UD3DRenderDevice::DrawTile` (body
`0x10005ba0`, vtable `0x10018004` slot `0x7c`, thunk `0x10001172`) replaces the PolyFlags of a `PF_Modulated` tile with `0x42`
(PF_Modulated|PF_Masked, at `0x10005c27`) before `SetBlending` (`0x10008270`: DESTCOLOR/SRCCOLOR blending, and ALPHATESTENABLE
from the PF_Masked bit), and writes the vertex color `0xffffffff` for it (`0x10005c5c` to `0x10005c9d`); only the other styles take
`Color * MaxColor | 0xff000000`. `hud.mjs` does the same: a style 4 tile draws with a white tint and discards the index-zero texels
(the masked style's shader).

The page multiplied modulated tiles by the tile color. `DeusExScopeView.DrawWindow` sets the tile color to 0,0,0 for its black
borders and then draws `HUDScopeView` (or the binoculars' `HUDBinocularView_1`/`_2`) modulated, so every scope view (the rifle, any
weapon with a scope mod: the pistol, stealth pistol, mini-crossbow, plasma rifle and GEP gun, ScopeFOV 10 to 25) and the binoculars
were black: a 2·src·dst tile with a black source. It was so before the live-heap work (`89bd1edd` too). Other modulated draws drawn
after a non-white tile color change with it: the vision augmentation's tints (`DrawVisionAugmentation` sets no tile color of its
own), the frob display's backgrounds (`colBackground`, `colText`) and the credits' background (`colBlack`).

`node scripts/validate-scope-view-play.mjs` (worker mode, 00_Training, `?loadout=1`): belt 5 draws the rifle, `[` (ToggleScope) zooms
it, and the lens centre shows the world while the screen outside it is black (it fails on the old tiles, lens mean 0).
`test/hud-compositor.test.mjs` checks the white tint and the masked shader of a style 4 tile after a black tile color. Not
compared with the original's pixels: the binoculars, the scope mods and the other windows above.

## Focused validation

`node scripts/validate-play-hud.mjs` exercises the live original HUD tree,
canonical root/HUD/key-ring identities, ten slots, AugLight, six live health
fields, damage flash, energy, compass, frob corners, original pickup-to-belt,
ActivateBelt/equip/put-away, ammo, log rows, reset, legacy InfoLink frame crops and
original bitmap-font glyph output. Native family layout, root tick, scene frame,
actor-reference and GC validators cover their translation boundaries against
the shipped DLL. Browser checks additionally cover native layout, pickup/belt
selection, frob brackets, ammo, log placement and shared dialogue behavior.

## The draw tree, the window events and DrawText in Rust (2026-11-06)

The paint's cost (below) was a flat spread over the host JavaScript around about 95 script events, the window tree's native-heap access
and `gcDrawText`. The bundle moves those three into the Rust core. The behaviors are unchanged and still have their evidence in the
JavaScript bodies, which stay as the reference (`WINDOW_DRAW=js`): the Rust code is a step-for-step transcription of each one, the same
heap reads and stores in the same order, the same roundings, and is held to it by the checks below. Nothing here is a new claim about
the original.

* **`XWindow::DrawTree`** (`script-window-tree-natives.mjs` `drawTree`, native 0x10051490; `window.rs`, `script-vm-window.mjs`). One
  window: skip a subtree the host delegates (InfoLink, ConPlay: `externalSubtree`); LockWindow; nothing more unless the GC (+0x130) is set,
  the visible flag (+0x30 & 1) is on and the clip width and height (+0xe4, +0xe8) are above zero; PushGC; the GC's canvas and
  multipliers; the background icon pattern when the window has a style and a texture; DrawWindow; the children in sibling order;
  PostDrawWindow; PopGC to the depth PushGC returned; UnlockWindow (SafeDestroy for a window flagged destroying). `paintWindows` asks the
  host's `rustDrawTree` hook first, which declines (and the JavaScript body draws) for a debug-frame texture, `GC_NATIVE=js`,
  `WINDOW_DRAW=js` or an allocation log. The window host describes each window and GC to the Rust walk once (`js_window_info`: its VM
  handle and what its draw is), into a table keyed by native address; the host advances the table's epoch whenever a native heap
  object is freed or forgotten (an address can be reused) and when a subtree is delegated. A window it cannot describe is drawn by the
  JavaScript body. The JavaScript global `granularityDepth`, raised and lowered around the events, has no reader but `drawTree` itself
  (the reconfigure diagnostics read `global100aeb08`, another entry), so the Rust walk does not keep it.
* **The window events** (`script-window-host.mjs` `processScript`, `script-vm-events.mjs` `decideWindow`, `dispatch.rs`
  `dispatch_window_event`). `processScript(win, 'DrawWindow' | 'PostDrawWindow', [gc])` runs `processEvent`'s steps from the event cache
  that already serves the tick events, keyed by the receiver's class row and state row and filled by `js_event_resolve` with
  processEvent's decision: no event, or a native function, is no call; a plain script function of one object parameter, lowered by
  the Rust VM, is a Rust run with the GC's handle in its frame; everything else (a singular function, a result, an out parameter,
  locals that need destruction, an Actor receiver) is the JavaScript path. A window has no bDeleteMe and no Level (an Actor would),
  its event names are no probe names (IsProbing is true for them whatever the state's mask), GIsScriptable is the window host's constant
  `true`, and nothing sets a window's pendingKill, so processEvent's other gates pass for it; the host turns the Rust dispatch on only
  while processEvent, executeScript, eventLevelGate, lookup and `ScriptState.isProbing` are the runtime's own (the census scripts wrap
  `processEvent`, which keeps the events in JavaScript, and `--time-only` wraps nothing). The four HUD events whose functions have
  string locals (`ActorDisplayWindow`, `DamageHUDDisplay`, `HUDMultiSkills`, `FrobDisplayWindow`) stay in JavaScript: their frames need
  `destroyFunctionLocals`.
* **The Text, Button and Toggle draws** (`script-window-family-draw.mjs` `textDraw` and `buttonDraw`, XTextWindow::Draw 0x10046930,
  XButtonWindow::Draw 0x100082c0): the tile and text colours, the pattern over the window, the alignments and word wrap on the GC, the
  window's DrawWindow event, then the text in the margins, made in `window.rs` over the GC natives of `gc.rs` (`run_native`, the same
  bodies and verification as the script-called ones) and `text.rs`; the FString is read from the heap, not converted to a JavaScript
  string. Checkbox, TextLog, Computer, LargeText, Edit, List, Viewport and Scale draws stay in JavaScript.
* **`UGC::DrawText`** (native 1282, method 0x10028180; `text.rs`, `script-gc-draw-text.mjs` is the reference). The gates, the emit
  state's colour, PushGC, Intersect, the vertical-alignment measure, the line scanner with GetNextChar's escapes (`|b`, `|c`, `|p`, `|!`,
  `|&`), UFont's glyph lookup, drawGlyph with the five-record texture realize cache and the underline, and PopGC(-1), in `text.rs`.
  Every `gcDrawText` call goes there while the window host paints (script `DrawText` calls, the layout and computer-window draws too),
  through a hook in `gcDrawText`; the DrawTile of each glyph and the texture Lock and Unlock of the cache go back to the host's
  `callVirtual`. The scanner's two process globals (a stale last character and the `|!` flag) are locals: the reference notes that every
  path assigns them before it reads them. The realize cache's head and count live in Rust and the host's `texCache` reads them there.
  `gcDrawText`'s PushGC and PopGC take the Rust stack bodies of `gc.rs` even when the JavaScript text body runs.

**Switches.** `WINDOW_DRAW=js` (`?windowDraw=js`) keeps all of the above in JavaScript, the reference; `WINDOW_DRAW=verify` also checks
that the windows and phases the Rust walk visited are those the reference's tests plan for the same tree (compared after each paint);
`GC_NATIVE=verify` runs each Rust DrawText, then the JavaScript one on the heap from before it, and throws on any difference in the GC
image, the GC stack's nodes, the realize cache or the DrawTile commands (a call whose PushGC had to allocate is not compared);
`DISPATCH_VERIFY=1` resolves every event again and compares the cache slot.

**Checked.**
* `scripts/hud-stream-digest.mjs` (the plain and the `--stream` form): the per-frame HUD command stream of a 600-frame roam is bit-identical to
  the unchanged tree's on the Island, the Area 51 bunker, 00_Training and Wan Chai (digests df48c15010687dd1, 4cd8392aff85151c,
  702be5968d3bcafb and fc4dd730f1ccf3f3). The digest runs the simulation worker's session; the page's inline mode runs the same code.
* `GC_NATIVE=verify` over 200 to 300 frames of those four maps, and `WINDOW_DRAW=verify DISPATCH_VERIFY=1` over 150 frames of the
  Island, pass; `GC_NATIVE=verify` gives the same digest as `GC_NATIVE=js`.
* `scripts/validate-gc-draw-text-rust.mjs`: 1,500 random DrawText calls (alignments, wrap, every escape in good and truncated forms,
  both fonts or none, clips, origins, multipliers, an underline texture, newlines, long words) on the live host's heap and fonts in
  verify mode: the GC image, the GC stack, the realize cache and about 22,000 DrawTile commands are identical.
* The state digests of `bench-sim.mjs --warm 60 --ticks 300 --render-feedback` on the five baseline maps are unchanged.
* The validators the runner selects by `hud`, `window`, `gc-`, `console`, `computer`, `infolink`, `keypad`, `scope`, `datacube`
  (161 validator runs, with `validate-gc-draw-text-rust` and the native-oracle `validate-gc-draw-text` among them) pass, with the menu capture's validator
  skipped as before; `test/hud-compositor.test.mjs` and the GC unit tests pass.
* Chromium in worker mode (25 s on the Island and the bunker, the default switches and `?windowDraw=js`, which reaches the worker):
  no page error, and the worker's `w.hud` is 0.78 against 1.14 ms (Island) and 1.04 against 1.65 ms (bunker).

**Not established.** Equivalence to the original is that of the JavaScript references (their own validators run against the DLL bodies);
these checks show the Rust bodies equal the references on the paths above, not on every input: the random test covers DrawText, the
digests cover the windows the roams draw, and a family or an event the cache sends to JavaScript runs the reference.

## What a paint costs (2026-11-05)

One HUD paint runs about 95 original script events a frame over about 46 windows (70 of them `Extension.Window`'s empty DrawWindow
and PostDrawWindow), then the console's PostRender. In Node the events take about 0.65 ms on the Island; the paint is 1.7 to 2.3 ms in
Firefox (`w.hud`), against Chrome's 1.0 to 1.3. The cost is a flat spread over the Rust VM's JavaScript callbacks (`DrawText`, the
`DrawTargetAugmentation` call, window field reads), the JavaScript around each event, and the window tree's native-heap access; no
part is 0.5 ms. The split, the profiles and the parts a port could take are in
[Firefox at 60 fps](firefox-60fps-plan.md#the-hud-phase-2026-11-05); `scripts/hud-census.mjs` prints a paint's events and
fallbacks (with the window events in JavaScript, its counts are the reference path's; `--time-only` times the shipped path). The events
themselves are unchanged: none is skipped, reordered or cached. The 2026-11-06 bundle above took the tree, the plain events, the
Text and Button draws and DrawText into Rust, and its measurements are in
[the plan](firefox-60fps-plan.md#the-hud-bundle-2026-11-06).
