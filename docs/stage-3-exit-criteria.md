# Stage 3 exit criteria — concrete, finite definition

Status: adopted 2026-09-25 as the Stage 3 gate, replacing the open-ended
"general compatibility" gate with a finite, testable one. The acceptance test is
`scripts/validate-stage3-training-conformance.mjs` (see "Acceptance test"
below). The native counts below are measured from
`.cache/script-runtime-inventory.json` (`node scripts/inventory-script-runtime.mjs`)
on the installed GOTY packages, 2026-09-20.

## Why the current gate never terminates

The roadmap done-criterion is *general* original game-behavior execution, but the
method is per-path bit-exact recovery. Those do not converge: there is always
another class, native branch or ConEvent target. The completion audit says as
much — "a green focused validator proves only the named original path, not
general compatibility." A finite gate has to name a concrete program to run.

**The concrete program is `00_Training`.** It is the map the runtime already
boots, ticks and renders, and its behavior is a bounded subset of the engine.
Define Stage 3 as: *Training executes its Stage-3 behavior end to end on original
bytecode with zero unimplemented-boundary pauses.*

## The native tail is finite and mostly not Stage 3

> **2026-09-23 correction:** the inventory now counts an index as bound only
> when a runtime dispatch site routes it ([coverage](script-coverage.md)). That
> gives 305 bound and 276 unbound (1,386 call sites). The earlier 294/287 split
> counted 51 translated modules that nothing dispatches (ListWindow, EditWindow,
> button, TextWindow) and missed 62 dispatched indices, including 260, 294,
> 705, 709 and 2105-2107. The bucket table below predates that correction and
> has not been recomputed.

581 distinct direct native indices are decoded across all packages; 294 are
bound, 287 are not. Bucketing the 287 unsupported by subsystem:

| Bucket | Indices | Decoded call-sites | In Stage 3 gate? |
| --- | ---: | ---: | --- |
| **S3 core runtime** | 93 | 455 | yes (upper bound) |
| S4 UI / rendering (Window, Tile, List, Edit, GC, Text) | 175 | 712 | no — Stage 4 |
| S5 AI / combat (AICanSee, FindPathToward, reachable) | 10 | 70 | no — Stage 5 |
| index-0 / no-decl (mostly ConSys) | 9 | 27 | case-by-case |

The 93 "S3" indices are a static upper bound and overcount: they include natives
already bound through scoped routes the decode-time inventory does not track
(e.g. `IsValidEnemy` 2105, `GetPawnAllianceType` 2107/2106,
`AIPickRandomDestination` 709). They cluster into three families:

1. **Animation-state setters** — `LoopAnim` 260, `TweenAnim` 294, `IsAnimating`
   282, `GetAnimGroup` 293, `PlayBlendAnim` 1010, `GetMeshTexture` 1013. These
   set the `AnimSequence`/`AnimFrame` fields the pose already reads; the *visual*
   playback is Stage 4, but the *state write* gates gameplay bytecode and belongs
   to Stage 3.
2. **AI event callbacks** — `AISetEventCallback` 710, `AIClearEventCallback` 711,
   `AIDirectionReachable` 708. Borderline Stage 5; needed only if a Training pawn
   actually reaches them (see conformance run).
3. **Config / lifecycle** — `SaveConfig` 536, `CriticalDelete` 751, `RotRand`
   320, `LastRendered` 723.

Only the indices a Training conformance run actually hits are in the gate. The
static 93 is the ceiling; the reachable count is expected to be well under half.

## Exit criteria (all must hold)

1. **Training startup conformance.** Every map actor runs the full
   `PreBeginPlay → … → PostPostBeginPlay` chain and Player-start reset re-runs it,
   with **no unimplemented-boundary throw**. The original `LoadMap` passes
   dispatch to every non-null slot ([LoadMap startup](script-loadmap-startup.md)),
   so a class the host leaves out of those passes counts against this criterion,
   as does a failure Play catches into `npcFailures`. Currently-recorded startup boundaries
   that must each be closed or reclassified as an allowed no-op:
   - weapon `SpawnActor` for armed NPCs
   - `PlayerReplicationInfo` startup for cameras
   - `FindPathToward` (Stage 5 — allowed as no-op if no Training pawn requires it)
   - root-window conversation check
   - environment-mapped surfaces (Stage 4 render — allowed no-op)
2. **Training tick conformance.** All map pawns tick through
   `ULevel::Tick`/`performPhysics` for a fixed simulated duration with no
   boundary throw; the recorded ambient `PlaySound`/`ClientHearSound` sites stay
   nonfatal no-ops (Stage 4).
3. **Training interaction conformance.** Each authored Stage-3 interaction runs
   its original body to completion: TriggerToggle starting doors, the `darkdoor`
   pair, `LightSwitch.Frob` → four TriggerLights, pushable-decoration bump, and
   the Training DataLink transmission lifecycle.
4. **Lifecycle generality (the blocker-set #1 subset Training needs).** These
   must run on the recovered general route, not a fixture, *for the objects
   Training instantiates*:
   - class/default load through the shared graph (done)
   - spawn through `ULevel::SpawnActor` incl. the `FindSpot` collision-placement
     branch (currently the next boundary)
   - destroy through `ULevel::DestroyActor` incl. `CleanupDestroyed`
   - one non-prebound resource through its real serializer/PostLoad
     (DynamicLoadObject route → shared graph)
5. **No new host substitutes.** Zero code paths fabricate or suppress behavior
   the original bytecode would produce (the standing project rule).

Explicitly **out of the Stage 3 gate**: mesh/HUD rendering, audio mixing,
animation *playback* (Stage 4); AI navigation/perception, combat, inventory,
skills, missions (Stage 5). Their natives may be called as recorded no-ops.

## Acceptance test

`scripts/validate-stage3-training-conformance.mjs` is the gate. It shares its
boot and probe engine with the census (`scripts/training-probe-lib.mjs`) and runs
without `--continue`, so an unsupported native throws exactly as in Play. It:
- instruments the `ScriptRuntime` prototype before `createGame`, so the LoadMap
  startup inside boot is observed, and records every failure Play catches into
  `npcFailures` after each boot, probe and Player-start reset;
- asks Play for the serialized map actors its LoadMap event passes exclude;
- ticks 10 s after boot, runs every census probe with a reset after each, then
  ticks 10 s after the last reset;
- tolerates only named out-of-Stage-3 boundaries (`ClientTravel` and
  `SaveGame` 3011, both Stage 6) and keeps unprobed families (Fire/AltFire)
  and unmeasured criteria (4, 5) open;
- lists every class `ULevel::SpawnActor` was asked for, with its spawned,
  gate-rejected and thrown counts (criterion 4's spawn part);
- prints every non-primitive native reached through `invokeNative` and which
  of them are unsupported.

It exits nonzero while any criterion is open (`--report` prints the same
scoreboard and exits 0) and writes `.cache/stage3-training-conformance.json`.
When it passes, Stage 3 is done, with a printed, finite list of exactly what was
exercised.

First scoreboard (2026-09-25, 89 probes, 4 boots, 233 s, peak 2,169 MiB):

| Criterion | Result |
| --- | --- |
| 1. startup | open: 240 map actors excluded from the LoadMap passes (80 SpotLight, 66 Light, 25 DeusExMover, 19 AmbientSound, 18 DataLinkTrigger, 12 PathNode, …); one preparation failure (the `ScriptedPawn.InitialAllianceInfo.bPermanent` struct bool default). No swallowed startup or reset failure. |
| 2. tick | pass for the admitted actors: both 10 s legs end on no boundary |
| 3. interactions | open: `Beam` spawn (`ActivateAugmentation 9`), `LargeTextWindow` `XTextParams` layout (the `DataCube0 -> ShowGoalsWindow` sequence probe), Fire/AltFire not probed. `ClientTravel` and `SaveGame` tolerated as Stage 6. |
| 4. lifecycle, 5. substitutes | not measured by the run yet |

195 distinct non-primitive natives were reached; the only unsupported ones are
the two tolerated Stage 6 natives.

After the general SpawnActor (2026-09-25, 90 probes, 4 boots, 167 s, peak
2,826 MiB; [spawn](script-spawn.md)):

| Criterion | Result |
| --- | --- |
| 1. startup | unchanged: 240 excluded map actors, the struct-bool preparation failure |
| 2. tick | pass |
| 3. interactions | open: `LargeTextWindow` `XTextParams`, Fire/AltFire not probed. `Beam` is closed: AugLight's `ActivateAugmentation 9` spawns its Beams through the ALight ClassConstructor. |
| 4. lifecycle | SpawnActor measured: 101 classes, 3,051 actors through the one general body, 0 threw; 194 null returns, all `Shadow` from the original post-BeginPlay pending-delete test, as before. DestroyActor/CleanupDestroyed and resource loading are not measured yet. |
| 5. substitutes | per-class spawn routes removed; the GameInfo stand-in and the player-startup adapter remain |

A sizing experiment that admitted every map actor to the LoadMap passes (then
reverted) found only three failure families: the 25 movers' startup reaches
`Original move service is not linked: moveActor`, `DeusExLevelInfo` spawns
`Mission00` through the original route and meets the per-class spawn gate, and
one tick throws `Original state latent slot is uninitialized before state entry`.
Every other excluded class completed its original startup unchanged.

## First step — reach census (2026-09-24)

`node scripts/census-training-reach.mjs --continue` is the report-only first
step. It boots `00_Training`, ticks 10 s, then probes through Play's public
entries:

- `game.use()` on one actor per class with an overriding `Frob` (32 classes);
- decoration `Bump` (13) and non-pawn `Touch` (6);
- every `User.ini` exec binding except axis/button aliases and Fire (36).

Each probe runs 30 painted ticks. A screen it opened is closed with Escape
through `XRootWindow::Process`. A probe that throws or leaves a screen open
gets a fresh boot, so later probes are not charged for it. The full run takes
about 220 s and peaks at 2.3 GB. It writes `.cache/training-reach-census.json`.

`--continue` returns the declared zero value from an unsupported native and
records it. One probe then lists every native on its path, not just the first.
Values after such a return are not original behavior. This is planning data,
never evidence.

Result: 88 probes, 74 complete and 14 end on a boundary. The whole reached
frontier:

| Family | Boundary | First probe |
| --- | --- | --- |
| Persona screen layout/admission | `TextWindow` `ParentRequestedGranularity` override — **closed** ([checkbox](script-window-checkbox.md)) | ShowInventoryWindow |
| | `CheckboxWindow` family not admitted — **closed**; Goals opens and closes | ShowGoalsWindow |
| | `XRadioBoxWindow::DescendantRemoved` `0x10038cb0` on close — **closed**; Inventory opens and closes | ShowInventoryWindow |
| Persona screen teardown | 3016 `UnloadTexture` — **closed**; 536 `SaveConfig` — **closed** with GConfig and class-load `LoadConfig` ([config](script-config.md)); 264 `PlaySound` in `DestroyWindow` — **admitted as deferred Stage-4 audio** by the discarded-result bytecode check ([sound](script-sound.md)) | Goals, MedicalBot, RepairBot close |
| Map-actor movement linking | `FarMoveActor` for a non-held map actor (carry: `GrabDecoration`) — **closed** ([map-actor move](script-map-actor-move.md)); lift, carry, throw and Player start | Plant2, two crates, FlagTrigger0 |
| | `MoveActor` for a non-spawned rider (pickup) — **closed**; Candybar and HazMatSuit were a reset leak | CombatKnife, Candybar, HazMatSuit |
| Exec invocation | exec with omitted optional parameters — **closed** ([console exec](script-console-exec.md)) | PutInHand, DropItem |
| | null-Context result of a native token — **closed** ([null context](script-null-context.md)) | SwitchAmmo |
| Spawn admission | `Beam` subclass: needs the collision view, `MakeNoise`/`AIStartEvent`, and a light that renders only in Stage 4 | ActivateAugmentation 9 (AugLight) |
| Resource graph | `DynamicLoadObject` of `DXFonts` — **closed**: Font registration, constructor, Serialize and PostLoad recovered, and the first load runs StaticLoadObject/CreateExport/EndLoad over the shared graph ([font load](script-font-load.md)); `GetDeusExVersion` 1099 closed on the same path | ShowMainMenu |
| Outside Stage 3 | 3011 `SaveGame`, `ClientTravel`, audible `PlaySound` (discarded-result calls now recorded without stopping) | QuickSave, Teleporter0 |

The SDK headers ([SDK reference](sdk-reference.md)) name each screen row's exact
retail functions. `CheckboxWindow` adds `Init`, `CleanUp`,
`ParentRequestedPreferredSize` and `Draw` to the recovered toggle chain. The
Inventory row is `XTextWindow::ParentRequestedGranularity` `0x10046880`.

Choose work by family, not by site. The two movement rows used the
already-recovered `MoveActor`/`FarMoveActor` bodies, which Play admitted only
for the player, spawned views and held items. Admitting map actors closed all
seven probes in one change. After that batch and the console-exec and
native-token Context changes, the census reads 88 probes and 2 ending on a
boundary (Beam, DXFonts). `SaveConfig` 536 is now closed as well
([config](script-config.md)). It brought the installed `.ini` values into
class defaults at load time.

The discarded-result `PlaySound` family is now admitted at the deferred-audio
seam ([sound](script-sound.md)): the VM marks only standalone native nodes,
including Context value children. Installed Engine/DeusEx bytecode has 261
such sites and eight consumed-result sites, which gain no new admission.
Existing named effects and separately scoped channel lifetimes remain intact.
This lets Lamp toggles, bot-screen close and Human pain-sound scripts continue;
audible playback remains Stage 4. The remaining unsupported natives in the
census are the Stage 4/5 `SaveGame`/`ClientTravel`.

Post-batch census (2026-09-25): 88 probes, two terminal boundaries (Beam and
DXFonts), three boots, 191 s, peak 2,339 MiB. Unsupported native-264 calls fell
from four probes to zero; the two terminal boundaries are unchanged. This is
reach coverage, not completion of the startup/tick, Fire, conversation or walking
acceptance criteria above.

Post-DXFonts census (2026-09-25, later): 88 probes, two terminal boundaries,
three boots, 154 s, peak 1,787 MiB. `ShowMainMenu` now opens and closes the main
menu through original code ([font load](script-font-load.md)). Because it no
longer ends in a reboot, `ShowGoalsWindow` now runs after the DataCube read in
the same boot, so its screen has a note. `PopulateNotes` then reaches
`LargeTextWindow`, whose `XTextParams` struct has no native window layout yet.
This is a newly reachable persona-screen path, not a regression. Beam
(AugLight) is unchanged.

The census groups by native index. Its index-0 row was labelled
`PlayerPawn.ClientTravel`, but the `ShowMainMenu` hit counted in it was
`PlayerPawn.ConsoleCommand("FLUSH")`. That native now runs through the
recovered console-command chain. FLUSH reaches `UEngine::Exec`'s
`Flush(1)`, and Escape opens and closes `MenuMain` in Play
([console commands](script-console-command.md)). `SaveGame` 3011 is the
other reported native. Since batch 3 milestone C the menu pauses the level:
the real Login gives the player a PlayerReplicationInfo, so GameInfo.SetPause
sets Pauser. Play's tick then takes ULevel::Tick's paused branch
([player login](script-player-login.md#other-natives-newly-reached-by-login)).

The first census found two items with existing evidence; both are now closed:

- **`Window.IsFocusWindow` (1448)** was on every persona button's
  `SetButtonMetrics`. Its exec (`0x100528c0`) consumes `EX_EndFunctionParms`,
  calls `XWindow::IsFocusWindow` (`0x1004ca20`) and stores the 32-bit result.
  `scripts/native-window-toggle-set-oracle.py` already runs that callee
  unchanged, so the dispatcher reuses the translated `getRootWindow` and root
  `+0x5c8` focus test. The MedicalBot and RepairBot screens now open and close
  on original code. `native-exec-diff` does not compare 1448: its case needs a
  receiver self-pointer that the harness cannot express.
- **VM opcode `0x0e` `EX_EatString`** blocked `ShowMainMenu`. Core
  `execEatString` (`0x1013a920`) zeroes a local `FString`, steps one
  expression against the current object into it, then destroys it. The VM now
  evaluates and discards the expression.

After batch 3 milestone A (2026-09-25, 90 probes, 4 boots, 269 s, peak
1,921 MiB):

| Criterion | Result |
| --- | --- |
| 1. startup | pass: 0 excluded actors, 0 preparation/startup/reset failures. All 312 admitted serialized actors receive the original passes; PickupDistributor destroys itself after distributing keys in PostPostBeginPlay. |
| 2. tick | pass: both 10 s legs, no boundary |
| 3. interactions | open: LargeTextWindow XTextParams and unprobed Fire/AltFire (batch 4); only ClientTravel/SaveGame tolerated as Stage 6 |
| 4. lifecycle | 102 classes, 3,063 actors spawned, 273 original null returns, 0 spawn throws; destroy/resource measurement remains open |
| 5. substitutes | GameInfo stand-in and player-startup adapter remain for milestones B/C |

Focused checks include original null-Code ProcessState guard, original struct
bool payloads, exact once-per-pass load/reset for all 312 serialized actors,
doors, lights, DataLinks, mission timer and instructor conversation. `npm test`:
534/534. No full sweep at this checkpoint; one is reserved for the batch end.

## Batch 3 milestone B — original GameInfo

Measured 2026-09-25: 90 probes, 4 boots, 258 s, peak 2482 MiB.

| Criterion | Result |
| --- | --- |
| 1. startup | PASS: zero exclusions or preparation failures |
| 2. tick | PASS, including reset |
| 3. interactions | OPEN: LargeTextWindow layout and unprobed Fire/AltFire (batch 4) |
| 4. lifecycle | OPEN: DestroyActor/CleanupDestroyed and resource loading not measured |
| 5. substitutes | OPEN: player-startup adapter remains; GameInfo and its Mutator now come from original LoadMap/InitGame |

General SpawnActor: 105 classes, 3332 accepted actors, 273 original-gate
rejections, zero throws. Original Actor.ProcessEvent's cold-level gate and
GameReplicationInfo's shadowed Region field are covered by focused checks.
See [GameInfo evidence](script-loadmap-gameinfo.md).

## Batch 3 milestone C: original player Login

Measured 2026-09-25: 90 probes, 4 boots, 203 s, peak 2745 MiB.

| Criterion | Result |
| --- | --- |
| 1. startup | PASS |
| 2. tick | PASS, including reset |
| 3. interactions | OPEN: LargeTextWindow layout and unprobed Fire/AltFire (batch 4). The real player now reaches Teleporter0's `GameInfo.SendPlayer`, whose `ClientTravel` is the tolerated Stage 6 native. |
| 4. lifecycle | OPEN: DestroyActor/CleanupDestroyed and resource loading not measured |
| 5. substitutes | Not audited by the run. The GameInfo, the player (PRI and subsystems) and Player start now come from the original LoadMap/SpawnPlayActor/Login. The player-startup adapter and the reset that kept the player are gone. |

General SpawnActor: 107 classes, 11514 accepted actors, 273 original-gate
rejections, zero throws. The count grew because every reset now logs in a
full player graph. The 201 distinct natives reached include the newly
recovered InitRootWindow, ResetKeyboard (through the InputExt ResetConfig),
CheckFlag, CreateDumpLocationObject and GETPING/StringToInt. Esc pauses the
level through the PRI's PlayerName and ULevel::Tick's paused branch. Player
start reloads the map and logs in `JCDentonMale<n+1>`.

Update 2026-09-26: LoadMap destroys the old player before the load, and its
own collection purges the whole retired generation
([Player start collection](script-loadmap-gc.md)). Play now runs that
retirement and collection. The registry, FName table and window heap stay
constant across resets. The gate keeps the same results. Its standalone
peak fell from 2832 MiB to about 2.0–2.5 GiB, and in the 4-job sweep it
completes at a 5.4 GiB runner footprint instead of being killed at the cap.
It stays red for the other open items.

## Batch 4: Fire, lifecycle and substitutes measured; LargeText/Edit windows

Measured 2026-09-26: 94 probes, 3 boots, about 110 s, peak about 1.9 GiB.

| Criterion | Result |
| --- | --- |
| 1. startup | PASS |
| 2. tick | PASS, including reset |
| 3. interactions | PASS. New Fire/AltFire probes (empty hand, combat knife, crowbar, multitool) run the original weapon bodies. The Goals screen's note editor runs the recovered LargeTextWindow/EditWindow family ([LargeText and Edit windows](script-large-text-window.md)). Tolerated: ClientTravel and SaveGame (Stage 6). |
| 4. lifecycle | PASS. DestroyActor, CleanupDestroyed (now at the end of every Play tick, as in ULevel::Tick) and shared-graph DynamicLoadObject are measured with no failures or host removals. |
| 5. substitutes | OPEN, 6 items (down from 11): the InfoLink display window still lives in the DataLink shell (QueryPreferredSize answered 0), the live DataLink host still replaces DeusExPlayer.StartDataLinkTransmission's dispatch and DataLinkPlay.StartConversation/Timer, the level tick admits actor categories, the player tick is Play's movement port, and FrobTarget comes from the host highlight trace. |

Removed from criterion 5 in this batch:
- SetCollision (262): every Training receiver runs the recovered
  AActor::SetCollision; the host flag-write fallback is now a boundary.
- SetPhysics (3970): DeusExDecorations run the recovered AActor::setPhysics
  (0x103c95f0; Rolling runs FindBase like Walking) instead of only storing
  Physics; a mover's equal-Physics call returns as the body does.
- Door use: movers go through ParseRightClick/ParseLeftClick -> DoFrob ->
  DeusExMover.Frob like every other target, and `use()` no longer turns a
  thrown Frob into a message.
- ConditionalBindMultiplayerKeys runs the original body; its SET InputExt
  commands go through UObject::StaticExec's SET branch, GlobalSetProperty and
  SaveConfig ([input console](script-input-console.md)).

The LargeText/Edit bodies are checked against Extension.dll by
`scripts/validate-text-layout-diff.mjs` (147 cases identical), which also
found and fixed a MakeAreaDirty bug in the edit model.

## Batch 5: original world scheduler and DataLinkPlay

Measured 2026-09-27. The gate passed criteria 1–4 and lists only the two
batch-6 substitutes (94 probes, 3 boots; 281 s in the final four-job sweep,
peak 1634 MiB in the gate's watchdog and 4.0 GiB runner group footprint).
The census completed 93 probes in one boot, 232 s, peak 735 MiB,
with zero terminal boundaries. ClientTravel and SaveGame remain the two
tolerated Stage-6 natives.

| Criterion | Result |
| --- | --- |
| 1. startup | PASS: no excluded actors or preparation/startup/reset failures. |
| 2. tick | PASS: both 10 s legs and reset, now through the original ULevel::Tick over the actual Level.Actors and FirstDynamicActor. |
| 3. interactions | PASS: original DataLinkPlay start/timer/state/queue/end, doors, lights, decorations and the existing interaction probes. |
| 4. lifecycle | PASS: 107 classes, 12024 accepted spawns, 285 original-gate rejections, no throws; 1047 accepted destroys across 13 classes; 5460 cleanup passes, 93 compacted slots, no host removals; shared-graph resource loading. |
| 5. substitutes | OPEN, 2 items (down from 6): only the controlled player movement/hand port and host FrobTarget remain for batch 6. The four batch-5 routes are absent from the measured audit. |

The standalone gate newly observed CreateHistoryObject (3002). Its audit
classification now points to the already-recovered exec and constructor chain
in [instructor conversation](script-instructor-conversation.md), also covering
CreateHistoryEvent (3003). This is reuse of existing native evidence, not an
allowed no-op. The original calls now arrive through DataLinkPlay.SetupHistory.

Play has no actor-category tick passes or skip-forever failure list. The
original owner retry and paused branches run on the real level; an actor error
freezes the frame at an explicit boundary until reload. Actor.Tick invokes
the retained player port at its controlled-PlayerPawn branch. Map actors and
spawned actors keep their own native-field storage adapters on a single script
identity; [level integration](script-level-tick.md) documents their join.
The map Acceleration binding now shares native storage with script reads, so
original SetPhysics clearing and reload cannot leave a stale VM value; the
existing public pickup validator checks that boundary.

The measured Training modes are None, Falling, Rotating and MovingBrush;
Bump reaches Rolling. Nine map pickups now receive the falling physics that
the category loop omitted. Original AActor::performPhysics dispatch and the
MovingBrush velocity bracket pass 114 same-heap DLL comparisons, including
x87 store boundaries and calls into the rotation tail. The existing 1174-case
rotation/PendingTouch differential and falling, rolling and translating-mover
body evidence are reused. Projectile/pathing/trailer and unrecovered
active mover branches remain explicit boundaries when reached; the measured
Training routes do not need them. See [actor physics](actor-physics.md).

[DataLinkPlay](script-datalink-original.md) now executes the installed scripts
as an ordinary spawned actor. There are no live StartDataLinkTransmission or
StartConversation replacements, host playback timers or 1460–1466 zero-layout
stubs. The original HUD creates its native InfoLink window. The newly reached
[ComputerWindow playback](script-window-computer-playback.md) passes 28
same-heap Extension.dll comparisons; terminal-input and graphic-queue branches
not used by InfoLink remain explicit boundaries. Rendering reads the native
HUD draw list, and audio transport consumes the actual PlaySound requests.
Preparation follows Login's full DataLink list, including Mission00.Timer's
`DL_Lockpick` after crate destruction, rather than just the 18 map-trigger
entries. The unchanged crowbar/crate integration check covers that path.

Browser-pane checks walked through the starting transmissions, rendered native
text/portrait, opened the entrance door, and exercised plant contact,
carry/drop and pushing. WebAudio recorded successful cue/speech source starts
with zero failures and a running context; physical audibility is not asserted.
The local capture is `.cache/batch5-browser-infolink.png`. A focused carry/drop
probe additionally observed 27 falling calls before the plant settled with
Physics=None, Base=LevelInfo and zero velocity. The existing settle/roll and
push-sound timer validators now use full game ticks with their assertions
unchanged; the settled plant moved 3.02 units over 10 Rolling ticks. The timer
check caught and verified the fix for speech transport intercepting unrelated
StopSound calls. These are integration checks;
the original bytecode/native references remain the behavior authority.

The broader gameplay smoke now distinguishes its supported scopes. Training
retains its full-world walking, interaction, collision and reset assertions.
NYC first asserts the real `UNATCOTroop3` boundary at original
`ScriptedPawn.PutInWorld -> SetLocation` (native 267): map-pawn FarMoveActor is
not linked. It then uses a fresh scene for its existing isolated player-port
landing/walking/collision checks. This is not a claim of NYC world support;
the former skip-forever behavior had hidden the NPC failure. An additional
NYC reset diagnostic reached a recursive LoadMap-GC stack overflow and remains
unresolved. See [level integration](script-level-tick.md).

Final full sweep:
`NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python npm run validate -- --jobs 4`
completed with **400 passed, 0 skipped, 2 known failures** in 1198.6 seconds
(four jobs). No new red remains. Stage 3 is still open solely for the two
batch-6 substitutes above; `validate-npc-mesh-preview` retains its known
unchanged-pose geometry-upload assertion failure. The local sweep log is
`.cache/batch5-sweep-final.log`.

Unit tests: 542/542. The final production build passes after correcting an
existing reassigned `const` in list-number formatting. Final integration checks
also cover the map acceleration binding and the explicitly scoped NYC fixture
described above. Delivery remains local; no deployment or push was made.
