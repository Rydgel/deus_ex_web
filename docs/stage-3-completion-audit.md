# Stage 3 completion audit — 2026-09-20

> **2026-09-25 batch 3 B:** real LoadMap GameInfo/InitGame replaces the
> GameInfo/Mutator stand-ins. Startup and tick pass. C remains incomplete at
> the native Input/config and player-owned destruction boundaries; see the
> [batch 3 handoff](stage-3-batch3-handoff.md).

> **2026-09-25 batch 3 A:** all 312 admitted Training map actors now receive
> LoadMap's shared startup passes; PickupDistributor destroys itself in its
> original final pass. Original SpawnScript owns Mission00, TriggerLights and
> movers enter states through the shared events, and LevelInfo owns its event
> manager startup. Struct-bool defaults use the recovered SerializeBin byte
> representation. GameInfo and player login remain subsequent milestones.


> **Checkpoint update, 2026-09-24 (movement beside spawned crate contents):**
>
> * Player physics no longer rewrites an existing class-derived `isPawn`
>   marker after a collision trace. Spawned actor collision views deliberately
>   expose that marker read-only; the original engine's ancestry checks observe
>   actor type without mutating it.
> * A focused regression reproduces the former `"isPawn" is read-only` pause,
>   and the Training crate integration now walks through public input beside
>   the dropped, uncollected Lockpick while preserving its non-Pawn identity.
>   See [crate evidence](script-crate-destruction.md).

> **Checkpoint update, 2026-09-24 (ToggleWindow button overrides):**
>
> * ToggleWindow's mouse press/release and programmatic PressButton now retain
>   their original event, inside-test, state-change and enable/disable-sound
>   order instead of inheriting ButtonWindow behavior.
> * The unchanged-DLL window oracle now matches 18 cases / 94 steps, adding
>   toggle inside/outside, non-left, repeated mouse, and programmatic press
>   paths with complete event/state comparison.
> * Scale drawing/value formatting and full bot-screen interaction remain open;
>   exact WinDrv capture/wheel delivery remains unverified. Stage 3 is
>   unfinished. See [window input evidence](script-window-input.md).

> **Checkpoint update, 2026-09-24 (Play pointer-to-root adapter):**
>
> * Play now offers absolute and pointer-lock-relative mouse samples to the
>   recovered root route before world look/fire/use whenever a modal owns the
>   root mouse-event grab. CSS coordinates are scaled to the HUD drawing buffer;
>   left/right/middle edges use their original EInputKey values.
> * Focused conversion cases pass, and the live medical screen activates its
>   authored scrollbar through the public `game.windowPointer` boundary while
>   retaining scale/clip feedback. The browser conversion is explicitly a host
>   adapter; exact WinDrv sampling/capture and wheel delivery remain unverified.
> * ToggleWindow overrides, Scale drawing/value formatting, and full bot-screen
>   interaction remain open. Stage 3 is unfinished. See
>   [window input evidence](script-window-input.md).

> **Checkpoint update, 2026-09-24 (root mouse-button routing):**
>
> * Original `HandleButtons`, mouse capture/release, focus-on-press,
>   multi-click timing/counts, coordinate conversion, raw/press/release parent
>   propagation and the reached Button-family overrides are translated.
> * Fifteen unchanged-DLL cases / 85 steps match complete state and event
>   order. The live medical screen now activates both scrollbar buttons through
>   root press/release and retains scale/clip feedback.
> * Browser pointer-to-root coordinate delivery and ToggleWindow's distinct
>   overrides remain open. See [window input evidence](script-window-input.md).
>   Focused original/runtime and bot integration pass; Stage 3 is unfinished.

> **Checkpoint update, 2026-09-24 (Training bot activation):**
>
> * Both Training bot Frobs now complete their original `SetMedicalBot` /
>   `SetRepairBot` path. Embedded source establishes the exact StandStill,
>   `PlayAnim('Start')`, raise-arm PlaySound and following-call order; neither
>   caller observes native 264's return.
> * Play retains each raise-arm call as one named deferred audio effect and
>   continues the original script. Both fresh-host integration routes verify
>   zero acceleration, `Start` animation selection, exact caller identity and
>   return from the setter. Audible `ClientHearSound` remains Stage 4.
> * Scale drawing, full root input routing, value-field formatting, complete
>   bot interaction and visual equivalence remain open. Stage 3 is unfinished.
>   See [bot activation evidence](script-window-bot-activation.md). Focused
>   integration and build pass; no full sweep was needed.

> **Checkpoint update, 2026-09-24 (scroll movement native dispatch):**
>
> * SetTickPosition1640, MoveThumb1650, SetChildPosition1680 and
>   GetChildPosition1681 now reach the verified movement implementation.
>   Twenty original exec comparisons verify argument/lvalue order, byte masking,
>   cursor advancement and void result preservation. Runtime dispatch, both bot
>   integration routes and build pass.
> * This work block adds 87 movement/input/show-area comparisons, ten cleanup
>   cases and twenty exec cases. It enables recursive medical scroll-subtree
>   cleanup and coherent movement through the host and script-native boundaries.
> * Next boundaries: Scale drawing, root mouse-button routing, value-field
>   formatting and bot Actor.PlaySound. Native heap reclamation remains outside
>   this logical host. Full bot screens, visual fidelity and Stage 3 are unfinished.
>   See [movement](script-window-scroll-movement.md),
>   [input](script-window-scroll-input.md), [show-area](script-window-scroll-show-area.md)
>   and [cleanup](script-window-scroll-cleanup.md). No full sweep was needed.

> **Checkpoint update, 2026-09-24 (scroll subtree cleanup):**
>
> * Scale/Manager/Clip/ScrollArea now join the recovered host destruction path.
>   Ten original cases establish owning-member release and inherited lifecycle
>   routes, including nonempty label arrays and format-string lifetime.
> * The Training medical scroll subtree now destroys recursively through
>   SafeDestroy, leaving every descendant destroyed and the area unlinked.
>   Both bot integration routes pass. Native heap release, retained empty
>   label allocations and full bot setup remain bounded. See
>   [cleanup evidence](script-window-scroll-cleanup.md).

> **Checkpoint update, 2026-09-24 (clip show-area):**
>
> * Clip requests now scroll a supplied child rectangle into view through the
>   native unit/rounding and oversized-region rules, then synchronize the scales.
>   Eight original cases bring the movement-family total to 87. Live Training
>   origin restoration, both bot checks and build pass. See
>   [show-area evidence](script-window-scroll-show-area.md).
> * Drawing, full root button routing, cleanup and bot audio remain open.

> **Checkpoint update, 2026-09-24 (scrollbar drag and repeat):**
>
> * Scale press/move/release/Tick now execute the original drag, paging, repeat
>   countdown and final-notification behavior. Pixel conversion and thumb-centered
>   sound calls preserve native arithmetic and the horizontal height-test quirk.
> * 38 new cases raise the movement/input comparison total to 79. Live thumb
>   dragging and both bot integration routes pass, as does build. See
>   [input evidence](script-window-scroll-input.md). Drawing, root mouse-button
>   dispatch, cleanup and bot audio remain open.

> **Checkpoint update, 2026-09-24 (scroll movement chain):**
>
> * Scrollbar buttons and wheel callbacks now run MoveThumb, position/range
>   broadcasts, clip movement and scrollbar feedback. 41 original-DLL cases
>   compare full images, return values and ordered services; live bot integration
>   and build pass. See [movement evidence](script-window-scroll-movement.md).
> * Value-field formatting, drag/repeat, show-area, drawing and complete cleanup
>   remain explicit boundaries; bot audio and Stage 3 remain incomplete.

> **Checkpoint update, 2026-09-24 (scroll-area descendant removal):**
>
> * ScrollArea.DescendantRemoved now clears the first matching one of its nine
>   stored descendant references without dispatching a script event, matching
>   the original native override.
> * Thirteen original-DLL cases cover all slots, alias ordering and null/unrelated
>   arguments; the removal comparison total is 23. Live Training window dispatch
>   verifies reference clearing and absence of script calls. See
>   [removal evidence](script-window-scroll-removal.md).
> * Full recursive family destruction, bot audio and scrolling/input remain
>   incomplete. This closes only the descendant-removal callback.

> **Checkpoint update, 2026-09-24 (scrollbar manager child removal):**
>
> * ScaleManager.ChildRemoved now runs its script event before clearing only
>   the first live matching child slot, preserving original alias/callback order.
> * Ten original-DLL comparisons verify full images and script calls. The live
>   Training manager dispatch check passes; ScrollArea descendant removal remains
>   guarded. See [child-removal evidence](script-window-scroll-removal.md).
> * This closes one cleanup callback. Bot audio, full screen destruction,
>   scrolling/input and Stage 3 remain incomplete.

> **Checkpoint update, 2026-09-24 (scroll-area configuration):**
>
> * ScrollArea, ScaleManager, Scale and Clip now complete the reached native
>   child-placement chain, including clip counts, scrollbar ranges and button
>   sensitivity propagation. MedicalBot proceeds to Actor.PlaySound264 in
>   HUDMedBotHealthScreen.SetMedicalBot; RepairBot's audio boundary is unchanged.
> * 29 original configuration chains compare all images and ordered services;
>   three SetRanges comparisons raise the child-body total to 37. Existing 29
>   preferred-sizing comparisons, both bot integration routes and build pass.
> * The [reached layout/configuration slice](script-window-scroll-configuration.md)
>   is complete. Audio, drawing/tick/input, scrolling movement and cleanup remain
>   guarded. No full bot screen, visual equivalence, full sweep or Stage 3
>   completion is claimed.

> **Checkpoint update, 2026-09-24 (scroll-area preferred sizing):**
>
> * Four preferred-size overrides plus Clip's child/unit/overflow query chain
>   and the reached Tile granularity override now run in Play.
> * 29 original-DLL comparisons match full memory, outputs and service order,
>   including nested families, auto-hide convergence/trial-limit behavior and
>   original margin/hidden-child quirks.
> * MedicalBot now completes QueryPreferredSize and reaches the explicit
>   ScrollArea.ConfigurationChanged boundary. The [preferred-sizing slice](script-window-scroll-layout.md)
>   is complete; placement, callbacks, draw/input and full bot screens remain open.
>   Focused integration and build pass; no full sweep or Stage 3 completion claim.

> **Checkpoint update, 2026-09-24 (scrollbar construction and initialization):**
>
> * ScrollArea/ScaleManager/Scale/Clip now construct in Play through recovered
>   native bodies. Original PersonaScrollAreaWindow.InitWindow and StyleChanged
>   return, and the medical route creates both sets of six health-region controls.
> * 34 new child-family original-body comparisons pass, alongside the ten
>   ScrollArea composition cases. Sixteen Scale execs add 224 comparisons;
>   the common total is 683 cases across 49 natives. Existing button texture/color
>   translations are connected to Play. Focused integration and build pass.
> * This [bounded slice](script-window-scroll-children.md) completes scrollbar
>   construction/initialization. MedicalBot now stops at the explicit scroll-area
>   preferred-size/layout boundary; draw/input/cleanup remain guarded. RepairBot's
>   PlaySound boundary is unchanged. Full bot screens and Stage 3 remain open.

> **Checkpoint update, 2026-09-24 (scroll-area setup prerequisite):**
>
> * ScrollAreaWindow constructor, full nine-child Init sequence and
>   EnableScrolling now have translations with explicit child-family services.
>   Ten original-DLL body comparisons verify complete images and service order.
> * Scrollbar distance, area margins and auto-hide (1701–1703) are dispatched;
>   53 new exec comparisons pass, including x87 NaN/equality branches. The
>   window-native comparison total is 459 across 33 natives. Build passes.
> * This [prerequisite milestone](script-window-scroll-area.md) does not admit
>   the scroll-area family into Play. ScaleManager/Scale/Clip lifecycles and
>   scroll-area virtual overrides remain unrecovered. Both bot interaction
>   boundaries are unchanged; no full screen or Stage 3 completion is claimed.

> **Checkpoint update, 2026-09-24 (bot button accelerators):**
>
> * Native1439 `Window.SetAcceleratorText` now dispatches the original scanner
>   and nearest-modal dirty-table update. Sixteen complete original-exec and
>   parent-memory comparisons pass, including embedded NUL and repeated pipes.
> * Both bot routes return from original SetButtonText with their installed
>   localized labels and accelerator keys. Baseline initialization remains
>   checked. MedicalBot now reaches unsupported ScrollAreaWindow construction;
>   RepairBot reaches RepairBotRaiseArm PlaySound in SetRepairBot.
> * The [bounded milestone](script-window-accelerator-text.md) is complete;
>   bot screen completion and Stage 3 remain open. Focused integration, existing
>   window/text comparisons and build pass. No full sweep is claimed.

> **Checkpoint update, 2026-09-24 (bot button baseline initialization):**
>
> * Native1484 `Window.SetBaselineData` is now recovered and dispatched. Its
>   two optional floats default to 2/1; it updates the existing GC or returns
>   unchanged when that context is null. All 22 full exec/GC cases match the
>   original DLL. The common oracle now supports pointer-linked memory images.
> * Both Training bot Frob routes return from original
>   PersonaBorderButtonWindow.InitWindow, including StyleChanged, with their
>   authored 1/1 values stored in the GC. The next explicit boundary for both
>   screens is native1439 `Window.SetAcceleratorText` in SetButtonText.
> * The [bounded milestone](script-window-baseline.md) is complete. Both bot
>   integration checks, existing 406 window-native comparisons and build pass.
>   Full bot screens and Stage 3 remain incomplete. No full sweep is claimed.

> **Checkpoint update, 2026-09-24 (keypad close):**
>
> * PopWindow now completes UnPauseGame through an attached Engine.Viewport
>   script prefix and Engine.Console. The HUD returns, DSTY_None replaces the
>   mask, bUIPaused/bShowMenu clear, Console leaves Menuing, and the original
>   PlayerPawn/GameInfo.SetPause(False) clears Level.Pauser.
> * [Original construction evidence](script-viewport-console.md) covers
>   GameEngine.Init, WindowsClient.NewViewport, UViewport/UConsole initialization
>   and SetPlayer. Viewport's registry superclass is corrected from Client
>   (actually its Within class) to Player.
> * The keypad validator checks successful close and existing identity readers;
>   validate-viewport-console checks native instruction guards and five original
>   SetPause cases. Browser F → 0012 showed GRANTED, then a restored HUD and open
>   doorway with no errors. The preview required a small downward aim adjustment.
> * Required four-job sweep: 370 passed, 0 skipped; only the three pre-existing
>   failures (gameplay, native-player-sequence/Mission01, npc-mesh-preview).
> * This does not complete GameInfo startup, platform window/input construction,
>   multiplayer or the scheduler's true-paused behavior. The next UI boundaries
>   remain HandleButtons, Toggle PressButton and Medical/RepairBot SetBaselineData.

> **Checkpoint update, 2026-09-24 (keypad input path):**
>
> * **Keypad.** Keypad0 now works in Play through the original window input path
>   ([window input](script-window-input.md)):
>   * `game.use()` opens HUDKeypadWindow. The modal grabs the keyboard and mouse,
>     the cursor is placed, and focus goes to the button under it.
>   * Typing `0012` runs the original digit route through the scripts.
>     ValidateCode then shows `~~GRANTED~~` and opens both `paddoor` movers.
>   * One second later the KeypadDelay timer pops and destroys the window.
>   * `PopWindow` then reaches `UnPauseGame`, which needs the original
>     UPlayer/`Engine.Console` objects. Play's viewport is a host listener, so
>     Play pauses there. This is the next boundary, and every PushWindow screen
>     reaches it when it closes.
> * **Newly translated and wired.** Window timers (1490/1491 and InvokeTimers),
>   the modal grab, SetCursorPos (1453) and ProcessMouseMove with hit testing.
>   Also AskParentToShowArea, MoveFocus and CheckFocusWindow, root key routing,
>   PressButton and ActivateButton (1598/1590), IsKeyDown (1470), Core `GetEnum`,
>   and destruction of the Button, Modal and TabGroup families. Four new
>   validators compare them with the unchanged DLL bodies or check the Play path:
>   `validate-window-timer-diff`, `validate-window-grab-diff`,
>   `validate-window-mouse-focus-diff` and `validate-keypad`.
> * **Found in the browser.** Aiming at the keypad broke the whole HUD paint:
>   `FrobDisplayWindow` formats the hack strength with FloatToString (VM token
>   0x55), which is now `%f` from Core `execFloatToString`. Opening it during the
>   DataLink then failed: `ShowHud(False)` walked into the delegated InfoLink
>   subtree, and a stale init count broke `InitializeWindows`. The visibility,
>   sensitivity and init walks now skip that subtree, as tick and draw already
>   did. The grabbed-mouse cursor is now drawn (PaintWindows' cursor branch and
>   QueryCursor). The viewer's Previews menu has a Keypad entry.
> * **Fixes on the way.** UnlockWindow now skips SafeDestroy when the lock count
>   is already zero (`jle 0x1004c18f`). Before, it ran SafeDestroy for any window
>   being destroyed.
>   SetActorZone's head query uses `EyeHeight` (+0x3f8) rather than
>   `BaseEyeHeight`. The player's and movers' script Region/Foot/HeadRegion are
>   bound to the stored SetActorZone result ([zone](zone.md)).
> * **Next boundaries.** UPlayer/Console construction and `SetPause`; mouse
>   clicks (`XRootWindow::HandleButtons`); the medical and repair bots
>   (`Window.SetBaselineData` 1484); decoration carrying.

> **Checkpoint update, 2026-09-23 (information devices):**
>
> * **DataCube reading.** Frobbing DataCube0 in Play now shows its text, which
>   carries the `paddoor` code `0012`, in the HUD information display. It adds the
>   DataVault note and closes when JC walks away or frobs again. BookOpen0 and
>   DataCube2 read the same way. The DeusExText.dll parser natives (2210–2221) are
>   translated from the DLL and match it across all 492 shipped texts plus 27 edge
>   cases, state compared after every step
>   ([text parser](script-text-parser.md)). The parser alpha bytes are heap
>   addresses, modelled as 0; they do not reach drawing.
> * **General fixes on the way.** The VM's `switch` now follows Core
>   `execSwitch`/`execCase`: stacked case labels and fall-through had silently
>   skipped case bodies ([scene events](scene-events.md)). `game.use()` now takes
>   the original `ParseRightClick → DoFrob` route for every non-mover target, so
>   pickup animation and `Futz` run. A pushable decoration is grabbed, and that
>   stops at the explicit carry boundary. `new` follows Core `execNew`
>   (transient package for a None Outer; script-only Object subclasses admitted by
>   native ancestry). Native 751 `CriticalDelete` dispatches recovered deleting
>   destructors. Native window destruction is bound in the Play host for the
>   Window, TextWindow and TileWindow families, including GC destruction
>   ([window destruction](script-window-destroy.md)). New TextWindow natives
>   1482, 1551, 1555 and 1559–1563 were added; SetText/AppendText now apply the exec
>   pipe conversion.
> * **Text layout fix.** The HUD's `GetTextExtent` adapter now passes the native X/Y
>   extents to the TextWindow and TextLogWindow layout, which had read them as zero or
>   NaN. The DataCube text is visible in the browser, and the validator checks the
>   glyphs drawn inside the display.
> * **Next boundaries.** The keypad (`XModalWindow::VisibilityChanged` grab), the
>   medical and repair bots (`Window.SetBaselineData` 1484), Lamp (PlaySound
>   outside the per-path allowlist) and decoration carrying
>   (`PutCarriedDecorationInHand`). The information display's rendering has not
>   been compared pixel for pixel with the original.
> * **Player zone fields (fixed).** `HUDHitDisplay.Tick` used to log Accessed None
>   at offset 465 on every tick because the player's script `HeadRegion` was never
>   written. That issue predated the changes above. The player's script `Region`,
>   `FootRegion` and `HeadRegion` now bind to the storage that the translated
>   `SetActorZone` writes. Idle Training ticks now log 0 warnings instead of 60.
>   The head query now uses `EyeHeight` (`+0x3f8`) rather than `BaseEyeHeight`,
>   per the original linked property offsets ([zone](zone.md)).

> **Checkpoint update, 2026-09-23 (reach probe, eager preparation, family
> verification):**
>
> * **Reach probe.** A report-only probe booted 00_Training with presentation
>   on, ran 30 s of idle ticks, then sent Frob to one actor of each
>   interactive class, one fresh process per class. Idle ticks and 23 of the
>   29 interactions passed. The failures were the keypad and the medical and
>   repair bots (HUD screens pushed by Frob), DataCube and BookOpen (`new
>   DeusExTextParser`), and Lamp (PlaySound outside the Play host's
>   per-path sound allowlist).
> * **Eager preparation.** The HUD screens first stopped at a host-only
>   "script event is not prepared" gap: the VM links bodies asynchronously and
>   cannot do so during execution. Play now prepares every function and state
>   of Core, Engine, Extension, ConSys and DeusEx before the startup `reset()`,
>   as the original has its packages loaded before BeginPlay. That is 7,221
>   bodies in about 2.7 s. One fails and keeps its failure as a boundary
>   (`Mission10.Timer`, an unverified struct bool default). This also makes
>   `FindFunctionChecked`-style lookups find declared but previously unprepared
>   functions.
> * **Family verification.** Window natives are now checked by one
>   [differential exec-body harness](native-exec-diff.md) instead of one oracle
>   each. Nineteen window-host natives were added and six existing
>   dispatcher cases were checked: 346 cases are identical to Extension.dll. The
>   harness found a divergence in the recovered `SetAcceleratorText` scan
>   (`||&k`), which the wired `TextWindow.SetText` also uses; it is now fixed.
> * **Next boundaries.** The medical and repair bots now pass native 1564 and
>   stop at `Window.SetBaselineData` (1484) in
>   `PersonaBorderButtonWindow.InitWindow`. It writes through the window's GC
>   pointer, so it needs structured receiver memory in the harness. The keypad
>   reaches `XModalWindow::VisibilityChanged`'s keyboard/mouse grab for a child
>   modal, a window-host routine that is not recovered yet. DataCube, BookOpen
>   and Lamp are unchanged.
> * **Validation.** The full sweep passes 362 of 366 validators. The four
>   failures (`gameplay`, `native-player-sequence`, `gm-trench-play-anim`,
>   `npc-mesh-preview`) fail identically on a clean checkout of `9c08f77`, so
>   they predate these changes. `npm test` passes 524/524. Stage 3 remains
>   open.

> **Checkpoint update, 2026-09-23 (crowbar and original HUD):** public fire
> input now advances the weapon through the real tick scheduler and mesh
> notify. Two connecting Training crowbar hits produce 10 → 4 → −2 crate
> health, six original wood fragments, dropped Lockpick contents, bounce,
> fade/expiry and reset. First-person RenderOverlays/CalcDrawOffset now draws
> the original animated mesh. The installed DeusExRootWindow/DeusExHUD
> initialize the ten-slot belt, health, ammo, AugLight, frob brackets and log
> through recovered native family layout and GC drawing. Digit keys invoke
> original ActivateBelt. These supersede the corresponding September 22
> boundaries below. Mesh lighting, deferred sound playback, general window
> lifecycle and the remaining runtime paths are still open; InfoLink/ConPlay
> retain their documented bounded presenters. Multiplayer is last priority
> and may remain incomplete. See [crate evidence](script-crate-destruction.md),
> [HUD scope](script-play-hud.md), and [weapon rendering](script-weapon-rendering.md).

> **Checkpoint update, 2026-09-22 (pick up, carry and equip):** frobbing a
> Training weapon/ammo/tool/food/key takes it into JC's inventory through the
> original `HandleItemPickup`/`DoFrob`/`Pickup.Frob` give
> ([item pickup](script-item-pickup.md)); a carried item is a based rider that
> now follows JC while walking through the recovered rider `MoveActor`
> (`moveMapRider`, [map-actor move](script-map-actor-move.md)), where the
> first step used to pause Play. **Selecting** a
> picked-up weapon draws it in hand through the original `PutInHand` ->
> `UpdateInHand` -> `SwitchWeapon` -> `ChangedWeapon` -> `RaiseUp` -> `BringUp`
> -> `PlaySelect` path: the crowbar reaches `DeusExWeapon.Active` with
> `inHand`/`SelectedItem`/`Weapon` set, its first-person LodMesh is decoded for
> `PlayAnim('Select')`, and the select sound is a recorded audio boundary. The
> HUD shows the in-hand item. No object belt is modeled — number keys resolve
> the weapon by `InventoryGroup` through the engine's `Inventory.WeaponChange`
> walk. The instant-hit trace's native-277 `Trace` optional-argument fix landed
> (`Pawn.TraceShot`'s five-argument call now runs — `validate-trace-shot.mjs`),
> but the full crowbar -> crate chain is traced-and-recorded, not built: it is
> gated on the animation mesh-notify dispatch, the latent fire state machine
> (which must run under the tick scheduler — exercising it in isolation runs
> away in memory), decoration auto-state `Active` admission, and the destruction's
> Fragment/content spawns. First-person view-model rendering and per-frame
> put-away also remain. Stage 3 remains open. See
> [weapon equip](script-weapon-equip.md) for the traced path and boundaries.

> **Checkpoint update, 2026-09-21 (Training opening walk):** held forward
> input from `PlayerStart1` is sustained until `UN_maindoor`, which opens
> through `DeusExMover.Frob`. `CreateKeyRing` spawns the ring; `NanoKey0`
> (`Train`) is picked up by `ParseRightClick` → `GiveKey` → `new NanoKeyInfo`.
> `Enter` with the ring in hand unlocks `keydoor`, and the following use opens
> it. `UNATCOTroop3` / `MunitionsTrooperReady` are not reached: the east
> corridor ends in world geometry, and `paddoor` / `hackdoor` remain locked
> keypad doors. Stage 3 remains open. See
> [script-nanokey.md](script-nanokey.md).
>
> **Checkpoint update, 2026-09-21 (subtitles):** the subtitle window boundary is
> closed. `XWindow::ConfigureChild`'s BoundsUpdate `0x10051160` and
> SortWindowLists `0x10045140` leaves are recovered bit-exact vs Extension.dll
> ([script-window-bounds-update.md](script-window-bounds-update.md)) and wired
> into the conversation window service; enabling the original `bSubtitles`
> globalconfig (a discoverable diagnostics toggle; class default unchanged) runs
> `SetupEventSpeechPost` to completion with the original speaker name and speech
> text, and the off branch hides the panel while speech plays. The local
> viewport listener is bound to `PlayerPawn.Player` so `GetDisplayName` resolves
> the name. `scripts/validate-instructor-conversation.mjs` asserts both states.
> The full native TileWindow render tree remains Stage 4.
>
> **Mission00.Timer inventory enforcement (2026-09-21):**
> `DeusExLevelInfo.SpawnScript` spawns the `Mission00` actor through the
> original bytecode (a prepared `Spawn` route for the Info-derived, script-only
> class); its `PostPostBeginPlay → SetTimer(1.0, True)` runs `Mission00.Timer`
> through the shared `processActorTick` scheduler in `Level.Actors` order, no
> substitute loop. On the first tick `InitStateMachine` sets `flags`/`localURL`
> (with `FlagBase.SetDefaultExpiration` native 1125 newly recovered and the
> GLog device supplied), then the timer removes the player's remaining
> inventory while `MunitionsTrooperReady` is true
> (`RemoveAllInventory → DeleteInventory + Destroy`). Reset destroys and
> re-spawns one fresh mission actor. `scripts/validate-mission-timer.mjs`
> asserts the nonempty-inventory, ownership, destruction, trigger entry/exit and
> reset cases; the instructor validator covers the Take transfer with the
> mission active ([script-mission-timer.md](script-mission-timer.md)).
> General inventory/belt and the whole Training route remain open. Stage 3
> remains open.

Visible checkpoint: Training's **NPC mesh preview** now displays 14 original
character/bot meshes, including the people beside and behind Jaime.
They use a shared actor-mesh draw adapter; the four guards' reflective materials
remain unsupported. The meshes are re-posed live from the runtime's animated
fields in Play and Inspect, including after Player start. Original mesh
lighting, distance LOD and the unresolved startup/tick boundaries remain
incomplete. See [preview evidence and scope](npc-mesh-preview.md).

Latest integration: the Play host runs the original startup chain
(`PreBeginPlay → BeginPlay → PostBeginPlay → SetInitialState →
PostPostBeginPlay`) for every pawn-ancestry map actor the standalone linker
admits, ticks them through the recovered `ULevel::Tick`/`APawn::performPhysics` path, and
the renderer resamples the live pose through GetFrame each frame. Standalone
`ULinkerLoad::CreateExport` admission refuses Training's 992 `Brush` exports
and the four UnrealEd `Camera4`–`7` exports before construction — their
serialized `Level.Actors` slots stay null, they never join
`PawnList`/collision/startup/tick/reset, and no `PlayerReplicationInfo` is
spawned for them ([map actors](script-map-actors.md)). Jaime lands, enters
`Standing` and loops `BreatheLight` under the shared clock; player reset
restores serialized state and re-runs the chain. `FindPathToward` is no
longer a boundary (see the 517 follow-up below); the recorded boundaries are
environment-mapped surfaces — the camera PRI startup and
the root-window conversation check are no longer boundaries
([startup evidence and exact boundary](script-npc-startup-animation.md),
[Decal evidence](script-decal-startup.md)). Stage 3 is **not complete** while
those boundaries and the full Play/reset/visibility verification remain open.

2026-09-20 MIB follow-up: `IsValidEnemy` and both alliance queries are
translated and compared with 31 executions of the original DeusEx.dll, and the
`AIPickRandomDestination` exec chain (`0x103c86f0` → worker `0x103c7fc0` →
band search `0x103c78a0` → direction helper `0x1036d030`) is now ported and
oracle-verified bit-exact (27 scenes + 7 mutants inside the 123-scene
`validate-pawn-nav` corpus). The real Training MIB passes the Tick boundary,
lands, and **wanders**: `validate-mib-startup-boundary.mjs` asserts live picks
and ~98 u of movement on both load and reset. The integration surfaced and
resolved three latent contracts — test-mode `MoveActor` with `bIgnorePawns`,
`FarMoveActor` hash re-registration through the pawn view, and
required..max arity on the four iterator factories (`GetFloorMaterial`'s
8-arg `TraceTexture` call). Ambient `PlaySound` sites are recorded nonfatal
boundaries; the `SpawnNotification` `FindFunctionChecked` miss is now the
original's logged-NULL no-op. See [pawn navigation](script-pawn-nav.md) and
[alliance evidence](script-pawn-alliance.md).

2026-09-20 armed-NPC inventory follow-up: the `InitializeInventory`
`SpawnActor` blocker is removed. `UClass::Bind`'s constructor copy-down is
now generalized — script-only ancestry is admitted down to the recovered
`Engine.Weapon` (`0x10302ef5`, vtable `0x104287a4`) or `Engine.Inventory`
roots — so `UNATCOTroop0`/`1`/`3` spawn `WeaponAssaultGun`/`Ammo762mm`/
`WeaponCombatKnife` and `JosephManderley0` spawns `WeaponPistol`/`Ammo10mm`/
`WeaponCombatKnife` through the shared recovered `ULevel::SpawnActor` order,
attach them via the scripted `GiveTo`/`AddInventory`/`SetBase`, and keep
`Weapon = None` through `SetupWeapon(false)` exactly as the original. The
integration surfaced and resolved three latent contracts: the `MoveActor`
based-rider section (`0x103998a0`–`0x10399bb0`, now ported as
`move-riders.mjs` and exercised by the landing pawns' `StandingCount` 3),
`execClassContext` for `Class.default.Member` reads/writes, and
runtime-spawned actor lifecycle on Player reset — the spawned items and
Shadows are now destroyed through the recovered `ULevel::DestroyActor`
instead of leaking (measured Shadow growth 15→29→52 is gone) and are never
reintroduced by the destroyed-actor ledger. `Actor.Tick`'s weapon
`FarMoveActor` tail is linked to the recovered relocation but stays
unexercised while `Weapon = None`. `validate-npc-weapon-startup.mjs`
asserts the load/reset/300-tick contract per NPC;
`validate-weapon-construction.mjs` pins the Engine.dll registration, thunk
and vtable evidence. See [NPC weapon startup](script-npc-weapon-startup.md).

2026-09-20 performance follow-up: Play now uses a small Rust/Wasm kernel for
GetFrame's per-vertex interpolation and transforms, retaining the original
extended-precision arithmetic and a JavaScript fallback. In the same local
Training CPU workload, posing drops from 13.0 to 2.3 ms/frame and combined
simulation/posing from 19.8 to 9.0 ms. Both backends match the existing 46
original-DLL GetFrame captures byte for byte. All 490 unit tests, the 14-mesh
integration validator, four focused browser tests and the production build
pass. This improves basic playability; it does not close the remaining
object-lifecycle, native-dispatch or conversation gates. See the
[kernel boundary, measurements and development workflow](lodmesh-wasm.md).

FindPathToward follow-up: native 517 (`exec 0x103bc9c0` → worker
`0x103db3f0`) is ported through the shared navigation service — scoutA–E
candidate collection, the lazy-sorted upstreamPaths BFS, route reversal,
pass-2 endpoint marking, and the SpecialCost/SpecialHandling tail — and
dispatched live through `invokeNative` → `pawnNavServices` over the
serialized nav graph and the live ReachSpec table. The shared validator
corpus is now 140/140 scenes bit-exact with 35/35 targeted mutants, and
Training `Secretary0` selects `PatrolPoint4` and begins moving in Play mode
(`validate-secretary-patrol.mjs`). Corrected fabrication evidence this
round: `upstreamPaths` is `+0x320` (the `+0x3a0` array is `PrunedPaths`),
the ReachSpec record opens with `distance` (`+0x00`) then `start` (`+0x04`),
`ULevel+0x90` is `ReachSpecs.Num`, the nav-list head is `LevelInfo+0x548`,
and the pawn's reach anchor is `MoveTarget` (`+0x34c`), not `Anchor`.
`landPredict`/falling-target delegation and the water helpers remain
explicit unported boundaries. See [pawn navigation](script-pawn-nav.md).

2026-09-21 review corrections: full 32-node candidate lists now retain later
closer/equal-key candidates in the original sorted order; navigation's
`Flags1dc` reads the actual collision bits, including `bBlockActors`, rather
than the unrelated `+0x28` actor flags; and native 517 preserves
`bClearPaths=1` for explicit `EX_Nothing` arguments. Two added original-DLL
scenes, 15 comparisons through decoded VM/runtime dispatch, and the live
Plant2/LevelInfo binding checks cover those previously missed boundaries.
The 499 unit tests, Secretary integration and MIB load/reset checks pass.

2026-09-21 patrol verification: the earlier "moved 3.8u, stopped ~28u short"
observation is resolved and was two separate things. The stop itself is the
recovered walking-arrival rule (`steerArrive200` zeroes `d.z`, so arrival is
horizontal `<16u`; both patrol points sit ~28u below the secretary's floor) —
not a bug. The real mismatch was upstream: `UGameEngine::LoadMap` dispatches
`PreBeginPlay` to every actor (`0x1038d99a`–`0x1038d9cc`), and
`PatrolPoint.PreBeginPlay` resolves serialized `Nextpatrol` names into
`NextPatrolPoint` via the `AllActors` tag iterator. Only pawn-ancestry actors
ran the chain, so `NextPatrolPoint` stayed `None` and `PickDestination` drove
the secretary to `Standing` after one leg instead of looping sec1↔sec2
forever. `script-doors.mjs` now admits `engine.patrolpoint`-ancestry actors to
the load/reset startup chain; the live trace shows land → arrive PatrolPoint4
(~15u horizontal, `MoveTimer≈2.0` left) → pause → depart to PatrolPoint5
(`MoveTimer≈31.23`) → arrive → pause → return leg — continuous, no
boundaries. `ScientistMale0` patrols comp1↔comp2 the same way.
`validate-secretary-patrol.mjs` now instruments each `MoveToward` completion
to prove arrival (not timeout/target loss), asserts the `destPoint` cycle,
and covers load+reset link resolution. The reviewed validator uses public
`game.reset()` and compares both arrival records and the complete 1900-tick
patrol trace with fresh load. Evidence:
[script-pawn-locomotion.md](script-pawn-locomotion.md#live-patrol-verification--00_training-secretary0).
The earlier reset floor discrepancy came from calling only `doors.reset()`;
the public reset reproduces the fresh-load floor. The startup host's event
ordering remains incomplete: it runs all five events per pawn, then per
patrol point, while the original uses separate passes over the live actor
array. This patrol fix does not close the general LoadMap lifecycle.

2026-09-22 LoadMap scheduler follow-up: the per-actor startup chain above is
now replaced by the recovered shared pass structure. `script-doors.mjs` runs
`resetNpcs()` as separate passes over the live `Level.Actors` array in the
original order — Touching[0..3] clear, `InitExecution`, `bBegunPlay|bStartup`,
`PreBeginPlay`, `BeginPlay`, `SetActorZone(test=1)`, `LastRenderTime=-10`,
`PostBeginPlay`, `SetInitialState`, AttachTag/FindBase fixup, `bStartup`
clear, `PostPostBeginPlay`, then the static/dynamic tail partition with
`iFirstNetActor` — each pass rereading the array pointer and count per
iteration so appends extend a pass and destroyed actors drop out
([script-loadmap-startup.md](script-loadmap-startup.md)). Admission stays
map pawns + map PatrolPoints for the event chain; native passes cover every
map actor and startup spawn. Two integration consequences surfaced and were
resolved: the `-10` render baseline engages `bStasis` gating (the initial
blanket tick stamp was incorrect and is replaced by the review below), and
the partition invalidated the
serialized-slot trigger lookup in `script-datalink-live.mjs` (resolved by
the authored route name). `Game->InitGame`, non-pawn event admission and all
client/net branches remain open, so Stage 3 is still incomplete.

2026-09-21 scheduler review: executing the original clear loop proves that
all four Touching slots clear, including the previously missed fourth slot.
Public reset now restores the pre-partition authored slot order before the
shared startup passes while preserving persistent host subsystems. Actor
render timestamps now update on actual WebGL draw submission, rather than
on every simulation tick. Model-zone timestamps have separate transient
storage; the old adapter incorrectly read the ZoneInfo actor's timestamp.
Original BSP/portal visibility and its zone timestamp updates remain open.
The focused original-instruction/live-host validator covers these boundaries;
headless patrol fixtures explicitly supply continuous visibility for their
observed NPC. See [startup evidence and remaining gaps](script-loadmap-startup.md).
Review validation: all 10 startup boundary checks pass (the pre-fix scheduler
fails the affected checks), as do Secretary load/reset patrol, MIB wandering,
three armed-NPC inventory runs, NPC mesh preview, actor admission, world
destruction and all 18 Training DataLink routes. All 508 unit tests, the
production build, the Training browser walkthrough and the focused WebGL draw
feedback test pass. These checks do not establish original zone visibility.

2026-09-21 instructor playback continuation: ordinary targeting/use now runs
ConPlay construction, original event/state bytecode, speech lookup and timing,
first-person window/text, history, transfers and termination. Both munitions
instructors retain the correct participant identity. Walking into their authored
FlagTrigger selects Take; its 29 transfer events include moving an existing
player-owned item. Repeat interaction and reset during active speech are covered.
Player start restores Ready and random-label progress. The package FString reader
now preserves raw UTF-16 code units, fixing Liberty Island's load regression.

All 18 Training meshes now render, including the four guards' PF_Environment
materials. Focused original Render and TileWindow instruction probes establish
normal/UV and selected dialogue layout calculations; the existing GetFrame
Rust/Wasm path and JavaScript fallback remain. Browser audio decodes original
speech and follows original channel start/stop; script timers own progression.
See [instructor evidence](script-instructor-conversation.md).

This does **not** close the instructor assignment or Stage 3: Mission00.Timer's
independent inventory enforcement is not scheduled, general inventory/equipment
and belt presentation remain incomplete, and the complete Training course route
from spawn has not been demonstrated. Integration uses explicit approach setup
followed by real movement/targeting/use. Native mixer/phonemes, original mesh
lighting/LOD and complete window reconfiguration remain open. Final object GC
retains its existing deferred boundary. No full original-game visual/audio match
is claimed.

This audit applies the required systems and done criterion in
[`roadmap.md:293-312`](roadmap.md#3-execute-game-behavior). A green focused
validator proves only the named original path that it exercises; it does not
turn an adapter or a package decode into general compatibility.

## Current validation snapshot

The following checks record the earlier checkpoints described below. Later
subsystem extensions have their own focused results; this is not a claim that
the entire historical suite was rerun after every change.

```text
npm test                                                     487/487
node scripts/validate-script-runtime.mjs                     pass
node scripts/validate-player-augmentation-startup.mjs        pass
node scripts/validate-stage3-dark-doors.mjs                  pass
node scripts/validate-gm-trench-play-anim.mjs                pass
node scripts/validate-trigger-actions.mjs                    pass
node scripts/validate-script-lights.mjs                      pass
node scripts/validate-training-datalink-live.mjs             pass
node scripts/validate-conversation-move-camera.mjs           pass
node scripts/validate-conversation-check-object-bind.mjs     pass
node scripts/validate-conversation-transfer-object-bind.mjs  pass
node scripts/validate-script-set-location.mjs                pass
node scripts/validate-native-vrand.mjs                       pass
node scripts/validate-native-finish-anim.mjs                 pass
node scripts/validate-native-int-operators.mjs               pass
node scripts/validate-native-float-vector-operators.mjs      pass
node scripts/validate-native-normal-axes.mjs                 pass
node scripts/validate-native-rotator-modulo.mjs              pass
node scripts/validate-native-string-transcendental.mjs       pass
node scripts/validate-native-script-trace.mjs                pass
node scripts/validate-native-fast-trace.mjs                  pass
node scripts/validate-native-trace-actors.mjs                pass
node scripts/validate-native-trace-texture.mjs               pass
node scripts/validate-native-set-collision-size.mjs          pass
node scripts/validate-native-is-overlapping.mjs              pass
node scripts/validate-native-radius-actors.mjs               pass
node scripts/validate-native-visible-actors.mjs              pass
node scripts/validate-native-set-base.mjs                    pass
node scripts/validate-native-based-actors.mjs                pass
node scripts/validate-x87-transcendental-hardware.mjs        pass
node scripts/validate-window-sensitivity.mjs                 pass
node scripts/validate-script-string-operations.mjs           pass
node scripts/validate-world-destroy.mjs                      pass
node scripts/validate-plant-push.mjs                         pass
node scripts/validate-script-spawn.mjs                       pass
node scripts/validate-inventory-spawn.mjs                    pass
node scripts/validate-datalink-transfer-object.mjs           pass
node scripts/validate-create-export.mjs                      pass
node scripts/validate-linker-preload.mjs                     pass (7 classes)
node scripts/validate-linker-imports.mjs                     pass (30 original cases, 6 mutations)
node scripts/validate-class-loader.mjs                       pass (502 defaults, 4 original bool writes)
node scripts/validate-end-load.mjs                           pass (17 original Core cases)
node scripts/validate-function-bind.mjs                      pass (12 original cases; 652-object Core.Object queue)
node scripts/validate-texture-load.mjs                       pass (9 original cases; 2 real textures/palettes, 9 mips)
node scripts/validate-sound-load-graph.mjs                   pass (original native Sound defaults; WAV/MP3 load scopes)
node scripts/validate-static-load-createexport.mjs           pass
```

The September 19 sweep after native class-loader integration passed **314
validators, zero skips/failures**, using four jobs in 187.9 seconds. `npm test`
passed 486/486 and `npm run build` passed. The build retains its large-chunk
advisory; performance work remains limited to basic playability.
Use `npm run validate -- --jobs 4` for a full sweep; source-backed boundary
checks remain the default during Stage 3 work.

After the EndLoad/PostLoad helper extension, all **8 loader validators** passed
with four jobs (`--filter load`), and the 3 DynamicLoadObject unit tests passed.
The subsequent function-binding integration passes 12 original cases and the
652-object Core.Object scope, all eight loader validators, the live Training
door/DataLink/image-transfer checks and the build. The full 314-validator result
above predates these focused extensions.

Texture/palette constructors, loading serializers, deferred mip reads and
Texture PostLoad now have nine original-DLL comparisons. Two real Engine
textures and their palettes also match through the shared graph over nine mip
levels. This is an opt-in resource boundary with explicit clock/lazy-load/mip-bias
services; the full Play queue still cannot finalize. Procedural texture
subclasses, other resource serializers, native reconstruction and final heap
release remain open. Evidence: [`script-texture-loading.md`](script-texture-loading.md).
The focused loader run passes **9/9 validators**, zero skips/failures, with four
jobs; the function-binding check and build also pass. No new full sweep is
claimed for this resource extension.

The subsequent Sound integration passes original native class-default and
WAV/MP3 constructor/serializer/load comparisons. The two-object and one-object
queues complete EndLoad without filtering; deferred bytes and exact WAV timing
match the original. Registered native sizes and Core.Object's self-Super
normalization are now applied before export loading. **10/10 focused loader
validators pass with four jobs**, as do function binding and the build.
LodMesh and procedural textures still block the larger Play queue; native
resource reconstruction/destruction, heap ownership and audio-backend conversion
remain open. Evidence: [`script-sound-load-graph.md`](script-sound-load-graph.md).

`scripts/validate-script-spawn.mjs` had been red: its `Spawn(class'Actor')`
case reached `SpawnActor engine.actor subclass startup is not implemented`
instead of the original null return. The runtime selected a subclass startup
before running any original gate, while `ULevel::SpawnActor`'s prologue
(`0x10394f81`-`0x103950b0`) rejects a null, abstract, non-Actor or
static/nondeletable class before any class-specific behaviour. Those four gates
are now `spawnActorRejectedByGates` and run ahead of this runtime's own
admission gate, so an abstract class is refused the way the original refuses it;
`scripts/validate-inventory-spawn.mjs` re-pins that gate by spawning the abstract
`DataVaultImage` parent and asserting it takes no actor slot and runs no startup.
That was a gate-ordering defect, not the object-spawning gap, which is unchanged.

These checks cover the current Training subset, including the live
`AugmentationManager1` startup and the explicit `NanoKeyRing.CreateKeyRing`
boundary. They do not establish the remaining rows below.

## Required-system matrix

| Roadmap system | Proven subset in the current runtime | Exact unproven requirement and next boundary |
| --- | --- | --- |
| Class inheritance | Linked class chains, native registration, metaclass construction and property linking are recovered. `ULinkerLoad::Preload` serializes seven selected classes from their original package streams: DataVaultImage, DeusExWeapon, WeaponAssaultGun, DeusExPlayer, Gray, Rocket and MenuScreenCustomizeKeys. Their field chains, flags, linked offsets and serialized default values are compared against the decoded packages, including indexed class/name references and string-owning structs. Evidence: [`script-create-export.md`](script-create-export.md), [`script-linker-preload.md`](script-linker-preload.md). | These seven comparisons establish the named serialization paths, not all classes or native constructor defaults. Play now loads classes, fields and serialized defaults through the shared graph, retaining canonical VM/resource identities. Next boundary: native defaults/config and complete resource/post-load ownership. See [`script-load-graph.md`](script-load-graph.md). |
| Default properties | Struct bool members decode/encode the original SerializeBin bytes; the InitialAllianceInfo preparation boundary is closed. Native CDO header/default allocation and inherited property copying are covered; 364 authored DeusEx struct defaults decode, and the augmentation manager/default list passes the live validator. Evidence: [`script-class-registration.md:102-143`](script-class-registration.md), [`script-struct-values.md`](script-struct-values.md), [`script-player-augmentation-startup.md:37-69`](script-player-augmentation-startup.md). | All classes/resources do not yet receive native CDO initialization, dynamic-container storage, config or localization values. Next boundary: one fresh non-prebound CDO containing an owning string/array property. |
| States | Original `TriggerToggle` Open/Close and `CameraPoint` Auto/Idle state selection run through VM state frames. Evidence and check: [`script-runtime.md:322-337`](script-runtime.md), `scripts/validate-script-runtime.mjs`. | Arbitrary state graphs, inherited state probes and state-frame persistence are not established. Next boundary: one non-door actor with inherited `BeginState`/`EndState` and a second transition. |
| Events | All admitted Training exports now receive shared LoadMap startup (including the self-destroying PickupDistributor); Mission00 comes from original SpawnScript. LoadMap spawns the configured GameInfo and original InitGame spawns its Mutator, with the native cold-level event gate. Spawn callbacks, Touch/UnTouch/Tick/Frob, trigger actions and the direct DataLink event path use original ProcessEvent/bytecode. Using a door is now the original `DeusExMover.Frob` body's decision — its frobbable/destroyed gates, lock branch with the class's localized `ClientMessage`, and the like-tagged `AllActors` fanout replaced a host reimplementation in `doors.mjs`. Evidence: [`script-spawn.md:284-329`](script-spawn.md), [`script-mover-frob.md`](script-mover-frob.md), `scripts/validate-trigger-actions.mjs`, `scripts/validate-mover-frob.mjs`, `scripts/validate-training-datalink-live.mjs`. | Generic ProcessEvent coverage, native event memory, exception/unwind and all subclass event overrides remain open. Next boundary: an authored event with owning struct/array parameters through live frame allocation and cleanup. |
| Timers | TriggerToggle `DelayTime`/`Sleep`, `Actor.SetTimer`, DamageTrigger timer scheduling and the DataLink end timer are compared against original order. Evidence: [`script-runtime.md:326-332`](script-runtime.md), [`script-trigger-actions.md:86-106`](script-trigger-actions.md). | Standalone level ordering and owner retries now have original-DLL comparisons; full-world timer integration, reentrant destruction and every timer flag are not proven. Next boundary: two live actor timers with one callback destroying or rescheduling the other. |
| Latent functions | ProcessState now returns on null Code before reading latent storage, verified against the original DLL. `InterpolateTo`, `FinishInterpolation` suspension/reversal and state Sleep/DelayTime are covered in the selected mover path. Native 261 `FinishAnim` now installs latent action `0x181`, preserves the recovered rate/tween/flag gates, and clears the slot only when `bAnimFinished` is set. Evidence: [`script-runtime.md:322-344`](script-runtime.md), [`script-finish-anim.md`](script-finish-anim.md). | The original main/blend animation phase now drives Jaime's helper animation through completion into the `0x181` poll; see [animation tick](script-animation-tick.md). Full-world actor admission, NPC startup and latent-slot serialization remain unsupported; standalone level scheduling is now compared separately. |
| Garbage collection | Core mark/purge ordering, typed reference holders, FName deletion/index reuse and CameraPoint cleanup have focused source-backed tests. Evidence: [`script-gc.md:170-221`](script-gc.md), [`script-reference-serialization.md:10-78`](script-reference-serialization.md). | Each Player start now runs LoadMap's collection over the modeled registry. It uses the recovered tag, mark projection, purge passes and name pass, and releases the whole retired generation ([`script-loadmap-gc.md`](script-loadmap-gc.md)). Still missing are the complete class/resource graph, native member destructors/allocators, dynamic array/map ownership and raw native event memory. Map exports, classes, resources, windows and XFlag nodes have no registry records. |
| Native function dispatch | Selected Core arithmetic/string/state primitives, including `At_StrStr` 168, `Right` 234, `VRand` 252 and the ten float/vector operator natives (`Dot` 219, `==`/`!=` 217/218, `*` 296, unary `-` 211, `Square` 194, `*=` 221, `/=` 222, `-=` 224, `Min` 249) plus `Sqrt` 193, `Normal` 226, `GetAxes` 229 (whose three `out vector` arguments required per-position `GPropAddr` handling in the VM), `Smerp` 248 and `MirrorVectorByNormal` 300 — all with their recovered x87 rounding placement, the `SafeNormal` `1e-08` boundary and the shared CRT `sqrt` — and the nine rotator/modulo natives (`==`/`!=` 142/203 raw-dword rotator compares, `%` 173 through the shipped-MSVCRT `_CIfmod` path, `>>` 276 vector/rotator composition through the same quantized-sine helpers as `GetAxes` but with its own rounding placement, `*` 287/288 rotator-float products through the real `_ftol`, `-` 317 wrapped dword subtraction, `+=`/`-=` 318/319 out-parameter mutation through `GPropAddr`), and the ten string/transcendental natives (`<`/`<=`/`>=` 115/120/121 through appStrcmp — the shipped-MSVCRT `wcscmp`, case-sensitive unsigned UTF-16 with the `ArrayNum==0` empty-buffer substitution, `Asc` 237 first-UTF-16-unit, `^^` 131 zero-truth XOR, `/=` 160 int-by-float through the 80-bit quotient and real `_ftol` with its C3 zero-or-NaN-divisor fallback storing 0, `*=` 297 componentwise out-vector multiply through `GPropAddr`, `Sin`/`Cos`/`Tan`/`Atan` 187/188/189/190 through the bare x87 `fsin`/`fcos`/`fptan`/`fpatan` thunks, whose NaN, `±inf` and inclusive `2^63` out-of-range edges were measured on **real silicon through CrossOver/Rosetta 2** after the Unicorn oracle was shown to compute these four instructions in host double precision; `Math.sin/cos/tan` reproduce the hardware below `|x|=2^26` and larger finite operands are refused because the x87's 66-bit π argument reduction is not reimplemented, while `Math.atan` matches across the whole float32 range). Engine `FinishAnim` 261 and `SetLocation` 267 plus mover/actor/sound/animation functions, Extension flag/window functions and ConSys/DataLink functions dispatch through the VM. The four tracing natives are bound at their recovered exec contracts: `Trace` 277 (`SingleLineCheck`, `bTraceActors ? 0x37 : 6`, zeroed `FCheckResult` copyback), `FastTrace` 548 (`Level->Model->FastLineCheck`, AL byte mask), `TraceActors` 309 and `TraceTexture` 1000 (one `MultiLineCheck` at iterator start, `checkActors=1`, per-hit out publish, `Item -> node.iSurf -> surf` texture walk on `LevelInfo` ancestry). The four collision-query natives are bound the same way: `SetCollisionSize` 283 (collide-bit-gated hash remove/store/add on collision-view actors), `IsOverlapping` 718 (strict horizontal/vertical cylinders, Primitive+Brush and world-actor exclusions, null `checkActor` short circuit) and the `RadiusActors` 310/`VisibleActors` 311/`BasedActors` 306 level-array iterators (BaseClass ancestry filtering, per-resume out clear; 310/311 add the pre-stored optional `Loc`, 311 adds the hidden-flag skip, the `Radius==0.0` gate bypass and a per-resume `FastLineCheck`, 306 tests `candidate->+0xc4 == receiver`) and `SetBase` 298 (`SetBase(NewBase, 1)` — self-ancestry guard, world exclusion, byte StandingCount, Detach→store→Attach→BaseChange), `Move` 266 (zeroed FCheckResult with Time=1.0f/Item=-1, raw Rotation copy, `Level->MoveActor` vtable +0x88 with four trailing zeros and verbatim dword result through an explicit level `moveActor` boundary) and `MakeNoise` 512 (0xf1/0xf2 LevelInfo warns on both paths, NetMode==3 skip, dual-slot instigator noise memory with strict f64 freshness/loud thresholds and f32(T) stamps, PawnList dispatch that skips PlayerPawn-ancestry listeners for player noises else requires bidirectional IsA, and the recovered hearing gate — 4e6/1.6e7 loudness² ranges, dist²==0 early accept, Stimulus write plus threshold compare, Model FastLineCheck — ending in `ProcessEvent(HearNoise,{L,this})`). `AIPickRandomDestination` 709 is bound through its recovered four-body chain — exec `0x103c86f0` (nine args, reference `out vector`), worker `0x103c7fc0` (tries/multiplier clamps, per-attempt direction+search, `mult<1` second-stage re-verification, unconditional `*out`), band search `0x103c78a0` (stride `clamp(CollisionRadius,5,25)` along `XAxis(FCoords{pitch,yaw,0})`, `checkMove`/`flyMove`/`swimMove` mode split, Location/Velocity snapshot + `FarMoveActor` restore), and direction helper `0x1036d030` (clamped distribution fold, sign from the f32 store, `_ftol` truncation, ±32767/32768 yaw and ±16383/16384 pitch scales) — with the search's test moves running the recovered `MoveActor(bTest=1, bIgnorePawns=1)` contract against the live collision hash. Evidence: [`script-coverage.md:23-37,56-96`](script-coverage.md), [`script-at-string.md`](script-at-string.md), [`script-trace.md`](script-trace.md), [`script-actor-queries.md`](script-actor-queries.md), [`script-string-operations.md`](script-string-operations.md), [`script-vrand.md`](script-vrand.md), [`script-finish-anim.md`](script-finish-anim.md), [`script-set-location.md`](script-set-location.md), [`script-int-operators.md`](script-int-operators.md), [`script-float-vector-operators.md`](script-float-vector-operators.md), [`script-normal-axes.md`](script-normal-axes.md), [`script-rotator-modulo.md`](script-rotator-modulo.md), [`script-string-transcendental.md`](script-string-transcendental.md), [`script-move-noise.md`](script-move-noise.md). | Of 581 decoded direct native indices, 257 (1,305 of 39,280 decoded call sites) have no VM dispatch path in the 2026-09-23 inventory. The other 324 are routed by the VM primitive switch or a runtime dispatch site, and those bindings cover scoped branches only. Nineteen are the window-host natives added and verified together by the [differential exec-body harness](native-exec-diff.md). A further 45 direct indices have translated modules that no dispatch site reaches yet (mostly ListWindow/EditWindow/TextWindow natives), so they are not counted as supported; see [`script-coverage.md`](script-coverage.md). Native-zero declarations, arbitrary iterator calls and many native branches remain unsupported. The 267 wrapper still requires an explicit native actor and FarMoveActor adapter. |
| Imported objects | Training uses canonical resource identities and the recovered StaticLoadObject/CreateExport route. The preload harness now uses original `Verify`, `VerifyImport`, `CreateImport` and `IndexToObject` control flow: class/name/outer export-hash matching, registered-native fallback and lazy construction through the owning linker. Thirty original Core.dll cases compare ordered calls, hashes, import writes, counters and package flags; six mutations are rejected. The real Engine.Inventory import remains unconstructed after verification, then aliases its registered class through its own export. The shared StaticLoadObject helper now implements nonempty EndLoad, metadata PostLoad and import cleanup, compared with 17 original-DLL cases. Evidence: [`script-linker-imports.md`](script-linker-imports.md), [`script-linker-preload.md`](script-linker-preload.md), [`script-end-load.md`](script-end-load.md). | The shared graph now loads Play classes and serialized defaults, and maps native class/package identities onto the existing resource registry. File discovery, forgiving/error diagnostics, legacy missing-package retry and general resource serialization remain explicit boundaries. The prepared DynamicLoadObject resource graph remains separate. Next boundary: supply native resource serialization/PostLoad and the remaining original registration/DLL inputs so the entire Play load queue can use the recovered EndLoad sequence. |
| Native actor/resource types | `Engine.Actor`-based CameraPoint construction is source/native checked; the full v68 LightSwitch/GM_Trench mesh payloads, deferred vertex frames and Texture references are decoded alongside Sound payloads; see `script-mesh-payload.md`. Evidence: [`script-spawn.md:211-302`](script-spawn.md), [`script-resources.md:65-93`](script-resources.md), [`script-play-anim.md:1-19`](script-play-anim.md). | General native actor subclasses, resource constructors/serializers/destructors, general texture payloads and native mesh heap ownership are not live. Next boundary: one non-prebound resource constructor and serializer attached to the canonical registry. |
| Object spawning | One `ULevel::SpawnActor` body (`script-spawn.mjs` `spawnActor`) serves every concrete Actor class in the recovered order: prologue gates, FindSpot placement (`0x103950fb`–`0x103951ae`), append/construct, level/region/tick-parity stores, collision view and `bCollideActors` hash registration, Region and APawn head/foot regions, owner/instigator, InitExecution/Spawned, startup events with the one pending-delete test, SetActorZone, CheckEncroachment with its DestroyActor edge, SetInitialState, the FindBase tail and SpawnNotify. Construction uses each class's bound `UClass::Bind` ClassConstructor, whose row comes from an oracle over all 56 native Actor-class constructors (`scripts/validate-native-actor-constructors.mjs`): 53 write only their vtable, ADecal clears `SurfList`, two player classes are unresolved. The per-class routes (CameraPoint, DataLinkPlay, Inventory/Weapon, Projectile, TraceHitSpawner, Shadow, ConPlay, Mission00, player subsystems) are gone; Mission00 and the DeusEx-native subsystems now receive their original AInfo/DeusEx.dll vtables instead of AActor's. Evidence: [`script-spawn.md`](script-spawn.md), `scripts/validate-stage3-training-conformance.mjs`. | Pawn-ancestry spawns are refused before mutation until Play binds a spawned pawn's collision view and Foot/Head SetActorZone; editor/undo, spawn tracking, remote-owned role swapping and brush/network branches remain explicit errors, as do the two unresolved player constructors. |
| Object destruction | Actor/level destruction order, owner/touch cleanup, pending-kill gates, Window tree destruction and CameraPoint final release have focused translations. The recovered `ULevel::DestroyActor` order now runs in the live Play world: Training's `OrdersTrigger2.Touch` destroys its one-shot trigger through the host eligibility gate, `Destroyed`, `EndTouch(other,1)`, `FCollisionHash::RemoveActor`, the actor-array slot, `bDeleteMe`, both Core object-flag transitions and the deferred chain. Evidence: [`script-destroy.md:96-140`](script-destroy.md), [`script-world-destroy.md`](script-world-destroy.md), [`script-window-destroy.md:82-131`](script-window-destroy.md), `scripts/validate-world-destroy.mjs`. | `CleanupDestroyed`, native subclass destructors, allocator/free-list ownership and resource release are still not wired, and a live map actor's record has no `ULinkerLoad` or `UPackage` outer, so the recovered `SetLinker(NULL, -1)` export-slot clear has no live slot. Pawn, Mover, based-child and networked targets stay explicitly refused. Next boundary: destroy a spawned actor with an owned resource and verify registry/index/GC cleanup. |
| References | UObject header Name/Outer/Class/Linker/state references, typed property walks, inherited structs, PawnList links and canonical map references are checked. Evidence: [`script-reference-serialization.md:10-139`](script-reference-serialization.md), [`pawn-list.md:29-60`](pawn-list.md). | Raw native pointers, dynamic containers and the complete cross-package live graph are not traversed. Next boundary: a live map/resource reference graph with null, shared and cyclic edges. |
| Execution order | Native level pawn startup order, Spawn callback order, mover reversal, LightSwitch fanout and DataLink termination order are compared. Evidence: [`pawn-list.md:29-60`](pawn-list.md), [`script-spawn.md:278-329`](script-spawn.md), [`script-datalink-live.md:10-24,61-72`](script-datalink-live.md). | Full level startup with every non-pawn callback, startup spawns and destruction is not established. Next boundary: replay the complete Training startup loop against all actor-array slots. |
| Serialization hooks | UObject/Actor/reference serialization, class/property metadata, tagged-default measurement, complex `SerializeItem` and authored struct loading are covered. FString and dynamic-array `SerializeItem` now include the recovered save/load flags, CompactIndex encoding, allocation and recursive element paths through explicit archive/heap services. Evidence: [`script-reference-serialization.md:80-139`](script-reference-serialization.md), [`script-property-serialize-item.md`](script-property-serialize-item.md). | Native resource tails, raw heap integration, map/object archive composition and map/save persistence remain open. Next boundary: one Sound or non-prebound resource through its real load archive; full save/map persistence is Stage 6. |
| Native calls across Engine, game, UI/Extension and ConSys | The selected mover, light, trigger/damage, DataLink and Window routes cross all named package families and are checked by their focused validators. Evidence: [`script-coverage.md:56-60,94-109`](script-coverage.md), [`script-lights.md:43-63`](script-lights.md). | Package availability and selected bindings do not establish broad native compatibility; UI/extension event overrides, engine iterators, game AI and raw native services remain incomplete. Next boundary: broaden one cross-package event route only after its native call graph and frame ownership are recovered. |
| Script-controlled light switches and lighting changes | Training `LightSwitch.Frob` fans out to four original TriggerLights; TriggerToggle/Tick, PlayAnim and steady brightness lightmap refill/upload pass the live validator. Evidence: [`script-lights.md:13-39,43-63`](script-lights.md), [`script-light-cache.md:60-88,107-131`](script-light-cache.md), `scripts/validate-script-lights.mjs`. | The selected Stage 3 light requirement is met for this documented subset. General `bLightChanged` setter/clear lifetime, radius/effect/type/corona branches and moving-light rendering remain open; the next boundary is the original dirty-bit owner. |
| Deus Ex conversation and UI classes | `ConBindEvents`, the 18 Training direct Speech→End routes, six-control InfoLink construction/destruction, queue/reset, first-load Jaime portrait linker and exact speech timing/audio bytes pass. Mission00 `M00MeetPage` executes canonical MoveCamera export 50071 through its exact native false binder and the installed action into Speech export 50044. `ConEventCheckObject.BindActor` preserves its `NK_` clear and class-load branches; MeetKaplan and ChadThankful run their installed Inventory/NanoKey predicates and both next/fail actions. `ConEventTransferObject.BindActor` now preserves its from/to bark/normal name order and class load. All ten shipped DataLink references are pinned, and `DL_Rooftops` export 7448 runs through native 2053 to bind JCDenton and load `Image02_NYC_Warehouse`. Evidence: [`script-datalink-live.md`](script-datalink-live.md), [`script-conversation-events.md`](script-conversation-events.md), [`script-conversation-check-object-bind.md`](script-conversation-check-object-bind.md), [`script-conversation-transfer-object-bind.md`](script-conversation-transfer-object-bind.md), `scripts/validate-conversation-transfer-object-bind.mjs`. | TransferObject's DataVaultImage action is closed for the admitted route: `DL_Rooftops` runs `SetupEventTransferObject` end to end through `Spawn(event.giveObject)`, `DataVaultImage.SpawnCopy` over `Inventory.SpawnCopy`, `GiveTo`/`BecomeItem`, `DeusExPlayer.AddInventory` (whose belt/root arm the `DataVaultImage` test skips), `Pawn.AddInventory`, `GotoState('Idle2')`, `DeusExPlayer.AddImage` and one recorded `HUDReceivedDisplay.AddItem(item,1)`, returning `EA_NextEvent` with an empty label. Evidence: [`script-datavault-image.md`](script-datavault-image.md), `scripts/validate-datalink-transfer-object.mjs`. Native mixer, glyph/texture presentation and final HUD rendering are Stage 4. All nine shipped image classes are now admitted subclasses rather than pinned references: each is constructed through the `CreateExport` metaclass branch and admitted by linked ancestry, and the eight beyond `Image02_NYC_Warehouse` run the same `SetupEventTransferObject` body to a distinct carried DataVault entry. Next boundary: `ConEvent` targets outside this chain still need their own native construction. |

## Stage 4 and Stage 5 separation

The following are deliberately outside the Stage 3 gates:

* **Stage 4 presentation** (`roadmap.md:314-331`): LOD mesh rendering and visual
  animation, skins/textures, animated effects, audible `ClientHearSound`, audio
  mixing, glyph rasterization and final HUD/conversation rendering. The full
  GM_Trench payload, vertex-frame decode and PlayAnim state writes are Stage 3
  resource/runtime evidence; visual playback is not.
* **Stage 5 gameplay** (`roadmap.md:333-345`): AI navigation/perception,
  combat/health/death, weapons, inventory/keyring, skills, full augmentation and
  energy behavior, dialogue choices, objectives and mission systems. The current
  player startup proves the manager/default augmentation state and stops at the
  source-backed `NanoKeyRing.CreateKeyRing` boundary; completing inventory is a
  Stage 5 task, while the manager startup is a Stage 3 integration dependency.

## Smallest actual Stage 3 blocker set

1. **Live class/resource/object graph:** native metaclass and absent-export loads,
   native actor/resource construction, general spawn/destruction/references,
   load/save virtuals, heap/temporary ownership and live-world GC are still
   prepared or fixture-backed rather than complete.
2. **General native dispatch:** the selected package paths pass, but the runtime
   still lacks enough Engine, game, UI/Extension and ConSys native branches,
   including raw event memory and dynamic-container/heap services, to claim the
   required general script path.
3. **Generic conversation execution:** the direct 18-route Speech→End slice,
   canonical Mission00 MoveCamera→Speech transition, CheckObject actions, and
   all ten shipped TransferObject routes — bind through construction,
   `SpawnCopy`/`GiveTo`, `AddImage` and the received-items boundary — are green
   for all nine distinct image classes, which now reach the runtime through the
   recovered `CreateExport` metaclass branch and an ancestry-based admission
   gate. Live class/default loading now uses the recovered shared graph;
   non-prebound ConEvent targets outside this chain still require their own
   native construction and post-load services. Presentation audio/rendering belongs to Stage 4.

The selected light-switch/brightness route is evidence for the named lighting
subset and therefore is not in this minimal blocker list. Its general dirty/cache
branches remain documented follow-up work. The dependency order is:

```text
broader class/resource graph and canonical identity
  -> native actor/resource construction
  -> spawn/destruction/reference/serialization/GC ownership
  -> broad native dispatch and event-frame/heap services
  -> generic ConEvent/conversation execution
```

## One bounded next slice

**Slice 1 of this track is done.** `staticLoadObject`'s absent-export route now
reaches the recovered `ULinkerLoad::CreateExport` body instead of a host
`createExport` stub: `linkerCreateExport` in
`src/runtime/script-static-load-object.mjs` binds the `createExport` service
contract to `createLinkerExport`, and `resolveExport` refuses an absent
`_Object` bound to a service without the recovered body's `0x1012e230` marker.
The resolver's null return still falls to `StaticFindObject`, matching the
native body at `0x10161cc0` which returns `CreateExport`'s result directly.
`scripts/validate-static-load-createexport.mjs` drives
`DeusEx.Image02_NYC_Warehouse` from the real export table through
`staticLoadObject` into the body — metaclass `LoadClass`, the inert
NAME_Camera gate, `Preload`, `LinkerRoot` outer, `StaticConstructObject`,
`SetLinker`, `GObjLoaded`, the Created log, `SuperField` and `Bind` — with the
shared `DataVaultImage` super constructed once by the recursive
`IndexToObject`, the `_Object` early-out on a second load, and the
absent-export/unheld-return boundaries still explicit.

**The earlier slice remains:** `ULinkerLoad::CreateExport` (`0x1012e230`) is
translated in
[`script-create-export.md`](script-create-export.md) and
`src/runtime/script-create-export.mjs`, with its contract re-derived from the
installed Core.dll bytes — the thunk target, the `0x24` export stride, every
gate immediate, the `+0x5c` `Bind` slot, the five referenced strings, and name
index `0xa2` read back out of the hard-coded name table as `Camera`. All nine
shipped DataLink image classes are constructed from the real `DeusEx.u` export
table through the metaclass branch, sharing one `DataVaultImage` super that the
recursive `IndexToObject` constructs exactly once.

The generality check the previous audit named has passed: `spawnScriptInventoryActor`
no longer holds a class key. `inventoryImageChain` admits a class by its linked
`DataVaultImage -> Engine.Inventory -> Engine.Actor -> Core.Object` ancestry, and
the eight shipped image classes that were previously refused now run the complete
live `SetupEventTransferObject` route — Spawn, `SpawnCopy`, `GiveTo`,
`AddInventory`, `GotoState('Idle2')`, `AddImage` and one `AddItem` each — leaving
all nine distinct images carried (`scripts/validate-datalink-transfer-object.mjs`).

**Slice 2 is done.** `ULinkerLoad::Preload` (`0x10162000`) now serializes a
constructed export's own bytes from the real serial stream:
`scripts/validate-linker-preload.mjs` verifies `DataVaultImage`'s field chain,
linked offsets, `PropertiesSize`, class flags and every default tag byte-for-byte
against the decoded package, and asserts the parse consumed exactly the export
serial range. The native class-registration registry is completed for all 46
startup packages (`tools/class-registration-scan.py`), so every `RF_Native`
export binds with zero `Can't bind` warnings — matching the measured original
startup ([`original-startup-log.md`](original-startup-log.md)). Three classes
with no distinct C++ constructor (`Engine.Player`, `Fire.FractalTexture`,
`Fire.WaterTexture`) inherit the super constructor, which is bit-for-bit what
`UClass::Bind`'s fall-through produces. Evidence:
[`script-linker-preload.md`](script-linker-preload.md).

**Slice 3 is done in the preload harness.** The seven-class comparison covers
the shipped default-tag types, including indexed class/name values and structs
with owning strings. The recovered `Verify`/`VerifyImport` and
`IndexToObject`/`CreateImport` replace the harness's path-based import shortcut.
Verification populates SourceLinker/SourceIndex without constructing exports;
the real Engine.Inventory import constructs lazily through its owning linker.
Original reference cases precede the translation and compare the new boundaries
against Core.dll. See [`script-linker-imports.md`](script-linker-imports.md).

**What these slices do not close.** The current closure constructs 10,111
objects (plus 53 registered static re-initializations), serializes 9,316, and
reaches 412 class exports; exactly seven classes have individual field/default
comparisons. The earlier 39,414 count came from host eager export preparation,
which the original `Verify` does not perform and which has been removed. Neither
count establishes general compatibility. Native constructor defaults without
serialized tags, config/localization, live heap ownership, general resource
serializers and post-load cleanup remain incomplete.

**Slice 4 is integrated into Play.** The graph now lives in
`src/runtime/script-load-graph.mjs`, with the preload validator exercising that
same implementation. `ScriptClassLoader` maps native linked defaults into the
VM's typed fields and keeps class/super/field/object references canonical. Play's
class loads use it, including members/Children order and native state/class
flags. A native-mask guard bug exposed by this integration was fixed after four
original DLL cases established bit-31 writes. The VM boundary compares 502
original defaults across the seven classes; live doors, lights, augmentation
startup, Training DataLinks and all nine image transfers pass. See
[`script-load-graph.md`](script-load-graph.md).

**Slice 5 recovers load finalization.** Original Core instructions establish the
two-pass EndLoad sequence, conditional PostLoad flags, metadata base/Bind/super
order, array release and import-pointer cleanup. Seventeen native cases compare
those calls and writes, including callbacks that grow/replace the queue and the
native count assertion after PostLoad growth. StaticLoadObject now uses that
translation for populated queues with explicit services. All eight focused
loader validators pass. The live shared graph cannot flush only metadata while
skipping queued resources: their serializers, PostLoad overrides and native
registration inputs still need to be supplied. See
[`script-end-load.md`](script-end-load.md).

**Slice 6 connects metadata finalization and function binding.** All three
UFunction::Bind branches now match 12 original Core cases, including numbered
table reads, named DLL-export cell indirection, missing-export preservation,
native assertions and repeated owner lookup. The shared graph provides explicit
BeginLoad/EndLoad scopes, metadata virtual dispatch and required binding/output
services. With the original Core initializer table and DLL exports, its real
Core.Object closure finishes all 652 queued records and binds 164 functions
(4 scripted, 150 numbered native, 10 named native). UField's vtable address was
corrected against its original export. Resource Serialize/PostLoad admission
now preserves unsupported objects' load flags; the separately recovered
UPackage serializer wrapper admits real resource group packages. Full Play
finalization still needs resource serializers/overrides and the other original
native registration inputs. See [`script-function-bind.md`](script-function-bind.md).

Next, in order:

1. Connect the remaining prepared DynamicLoadObject resource route to the
   shared graph, supplying resource serialization/PostLoad and original native
   registration/DLL inputs to the recovered EndLoad behavior while preserving
   canonical ownership.
2. Recover native constructor defaults/config services and the remaining
   unsupported default-value boundaries, including SerializeBin struct bools.
3. Extend one native resource or ConEvent target beyond the current admitted
   chain through its original construction and serialization.

Keep mixer/rendering work in Stage 4.

## Visible browser bridge — 2026-09-19

Following the request for visible progress, the selected HUD scripts now also
feed a local browser renderer: the six-part health display, energy bar, compass,
and original InfoLink frame/bitmap-font presentation. Window.SetConfiguration
1430 is newly translated and compared against ten original DLL cases. The
previously recovered GC.DrawText glyph path renders real original font pages.
This is a bounded presentation bridge, not closure of Stage 3's general object,
native dispatch or conversation gates, or Stage 4's complete UI renderer.
See [evidence and remaining boundaries](script-play-hud.md).

## Mesh resources toward visible NPCs — 2026-09-19

The canonical Play resource now carries the complete version 68 LodMesh
payload, including four deferred arrays, sequence notifies, frame bounds,
native scalar fields, LOD arrays and resolved Texture edges. GM_Trench exposes
366 frames of 339 vertices and 71 sequences; PlayAnim uses that same resource.
The local XYZ frame accessor follows the original signed-word unpack loop.
Eight original-DLL comparisons cover real meshes, deferred/idempotent loads,
remapping and frame values. Original constructors also expose an error in the
old probe: its supposed unread tails were incorrect FArray initialization;
LightSwitch, Plant2 and SignFloor now load to the exact export end.

This closes the selected payload-data boundary, not native Mesh load-graph
construction/PostLoad/release or the renderer. Remaining work toward visible
NPCs includes original LOD interpretation, frame interpolation/transforms,
actor skin selection and lighting. See [mesh evidence](script-mesh-payload.md).

**Shared native load graph follow-up:** Primitive/Mesh/LodMesh's original
registration/default images and LodMesh's constructor, serializer and inherited
PostLoad are now admitted. The resource reader is shared with detached Play
preparation rather than duplicated. Original DLL execution compares complete
constructor bytes and arrays with global FNames/reference tokens; GM_Trench's
1-object and LightSwitch's 733-object scopes fully complete EndLoad, including
texture/metadata dependencies, while retaining deferred mesh archives. This
does not complete Play's larger queue or native destructor/heap ownership.
**Play identity bridge:** prepared meshes now use the existing class-loader
records and archives. Meshes already created by class defaults and first-load
resources share their canonical VM handles, payload views and Texture edges.
The narrow mesh service retains Play's explicit deferred-loading input without
assuming Texture clock/mip-bias services. The full pending Play queue is retained;
there is no filtered EndLoad or detached fallback on a native load failure.
Next: close remaining native resource/ownership boundaries and recover the
animation/geometry operations required for presentation.
See [native mesh load graph](script-mesh-load-graph.md).

## Animation controls follow-up — 2026-09-19

PlayAnim, LoopAnim and TweenAnim now have 37 complete original-execution
comparisons. The audit found and fixed PlayAnim's misread reverse divisions:
AnimLast is 1-1/NumFrames, tween starts at -1/NumFrames, and tween rates use the
original reciprocals. PlayAnim also preserves bStatic with the actual 0xc7 mask.
Loop continuation retains frame/tween progress and its distinct SimAnim rules.

The runtime controls now use linked bAnimFinished/bAnimLoop/bAnimNotify and
SimAnim Plane values. Original ScriptedPawn pivot helper bytecode executes on
Training's JaimeReyes0 and reaches the FinishAnim wait/poll boundary. The later
animation-tick follow-up below replaces the initial controlled completion flag
with original frame progression. These control calls establish the control-call
and state-representation boundaries.
See [animation controls](script-animation-controls.md).

## Animation tick follow-up — 2026-09-19

The original Actor.Tick main/blend phases now match 38 unchanged-DLL cases:
frame/tween progression, velocity scaling, loop/end behavior, notifies,
callback mutations and order, shared remaining time and the four-pass limit.
The original second loop can advance blends three times after one main update;
the translation retains this measured behavior. Simulated-pawn event suppression
and RemoteRole/Weapon replication gates are preserved.

The runtime bridge reads/writes linked fields and the current latent slot.
Training's JaimeReyes0 now runs original animation helper bytecode, completes
the tween and HitTorso animation, and releases FinishAnim during ProcessState
without manually setting its finished flag. Linked four-slot blend storage and
SimBlendAnim slot 2 also pass the integration check. This closes the requested
helper→animation→latent-poll boundary. Full-world actor admission, NPC startup and final mesh interpolation/rendering
remain open; standalone scheduling is covered by the subsequent level follow-up.
See [animation tick evidence](script-animation-tick.md).

## Standalone Actor.Tick follow-up — 2026-09-19

37 complete original Actor.Tick executions now compare against the standalone
authority translation. InStasis, owner deferral, bTicked, animation, ordinary or
local-player script dispatch, state/timer processing, lifespan and physics call
order, view-target/weapon updates and Pawn timers are covered. Native callback
effects are preserved at their original positions. Explicit service leaves
remain for actual physics, input, visibility and allocation; client/demo paths
are unsupported rather than approximated.

The linked runtime runs Training LightSwitch0's real Frob followed by the full
per-actor Tick and inherited DeusExDecoration.Tick. Its animation completes and
the original tick-tag bit changes across calls. Jaime's animation/FinishAnim
integration and the existing animation cases remain passing. General world
iteration/deferred retry was still open at that checkpoint. See the subsequent
level-scheduling result below and [actor tick evidence](script-actor-tick.md).

## Standalone level scheduling follow-up — 2026-09-19

31 complete original ULevel.Tick executions now match the scheduling
translation: ascending live array traversal, callback spawns/removals, signed
progress sums and deferred retries, pre-clamp clock accumulation, player distance
prepass, pause/input resets, EventManager gates and tag/cleanup ordering.
`processLevelTick` composes actual Actor.Tick and CleanupDestroyed. A focused
two-frame Training fixture verifies the owner-before-child dependency, Frob
animation completion, linked distance writes, dynamic null-slot compaction and
15 original player input fields. Native temporary-memory/counter services,
calendar and viewport remain explicit boundaries. Full-world admission, NPC
startup, visibility/physics integration and rendering remain open.
See [level tick evidence](script-level-tick.md). The focused scheduler/runtime
checks and build pass; the historical full sweep above was not repeated.

## Pawn tick visibility follow-up — 2026-09-19

ShowSelf and CheckEnemyVisible now have 24 complete original-DLL helper/LOS
comparisons, including full actor storage, live PawnList callback mutations,
probe/trace/random ordering and last-seen timestamp writes. Actor.Tick defaults
to these recovered helpers. The linked Training check executes Jaime's original
SeePlayer script through BSP sight checks and the player tick, and preserves
the class's disabled inherited EnemyNotVisible probe. These are controlled
runtime fixtures, not complete NPC startup. UObject validity, the native clock
and reached BSP/RNG services remain explicit boundaries.

The unverified AICanSee full-illumination fallback has been removed. Its reached
lighting branch initially required an explicit original service. The subsequent
AI-lighting follow-up below supplies that service. NPC startup/physics,
full-world enrollment and mesh rendering remain open. The
focused helper/runtime checks and build pass; no new full sweep is claimed.
See [tick visibility evidence](script-pawn-tick-visibility.md).


## AI visibility lighting follow-up — 2026-09-19

AIGetLightLevel (700) and AIVisibility (701) now have 41 complete original-DLL
worker/wrapper comparisons. They cover live actor-list changes, static-light
trace order, captured zone pointers with live ambient fields, cache refresh and
interpolation boundaries, velocity sensitivity and retained x87 return values.
AICanSee (705) now calls AIVisibility instead of bypassing it with raw lighting;
its 55-case perception comparison also checks every target's cache fields.

The runtime binds flag-6 rays to the existing level collision query. Three
Training map snapshots match the original DLL with 42 actual BSP/mover rays;
original LightSwitch.Frob and TriggerLight bytecode change the sampled value
from 0.166675508 to 0 and back. Linked native offsets, native dispatch and cache
interpolation pass. Region/time inputs are explicit fixtures: full-world
initialization and clock/field synchronization remain unfinished. This does
not add visible NPC rendering or complete Stage 3.

See [AI lighting evidence](script-ai-visibility.md). Focused checks and build
pass; no new full sweep is claimed.

## Mesh frame evaluation — 2026-09-19

The complete original ULodMesh::GetFrame body now has a shared runtime
translation. 46 full original-DLL calls with LightSwitch/GM_Trench compare all
output/padding bytes, cache header/vertex bytes, counts, locks and cache calls.
This includes frame wrapping, cached tween transitions, reduced/expanded vertex
counts, transforms, owner animation and four additive blend channels. Original
Core transforms and the pinned sine table establish the numerical contract.

`getActorMeshFrame` reads the canonical prepared mesh and live linked fields.
Training's JaimeReyes0 fixture uses his captured global UObject index; original
animation helpers and Tick change vertices and retain the previous cached pose
when starting a tween. Actor fields remain unchanged by GetFrame. This closes
the selected animation-state-to-vertex boundary. Native cache allocation/eviction,
triangle/LOD interpretation, materials/lighting, NPC startup and full-world
rendering remain open. See [frame evidence](script-lodmesh-frame.md).

## Mesh surface/skin selection — 2026-09-19

Full-resolution surface decoding now maps original face/wedge/material arrays
onto GetFrame output, preserving raw byte UVs and the special-vertex prefix.
Original Render instruction ranges verify every material/flag, packed wedge,
texture slot and vertex reference for 26 LightSwitch and 603 GM_Trench faces.
These are bounded data-layout comparisons, not full DrawLodMesh executions.

GetSkin, UMesh.GetTexture and Actor.GetMeshTexture1013 match 28 complete native
calls, including repeated virtual calls, bounds and fallback differences.
The shared runtime checks Jaime's authored skin identities and executes the
original SetSkinStyle/GetStyleTexture/ResetSkinStyle chain; LightSwitch reaches
the canonical mesh-texture fallback. Reduced LOD/morphing, mesh lighting,
texture animation/locking, draw submission and NPC startup remain open.
See [surface/skin evidence](script-lodmesh-materials.md).

Focused frame/material comparisons, the linked GM_Trench runtime check, syntax/
diff checks and the production build pass. The build retains its existing chunk
size warning. No full validator sweep or visible NPC rendering is claimed.

2026-09-25 batch 3 B: LoadMap selects and spawns the configured DeusExGameInfo,
then original InitGame spawns its Mutator; GameReplicationInfo is also a real
spawn. Cold Actor.ProcessEvent dispatch is gated by original bBegunPlay.
The event/lifecycle matrix now includes this measured route; real player Login
remains open. Its additional native Input/config and player-owned teardown
boundaries are recorded in the [batch 3 handoff](stage-3-batch3-handoff.md).
See [original evidence](script-loadmap-gameinfo.md).
