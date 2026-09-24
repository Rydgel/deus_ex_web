# Stage 3 exit criteria — concrete, finite definition

Status: proposal to replace the open-ended "general compatibility" gate with a
finite, testable one. Numbers below are measured from
`.cache/script-runtime-inventory.json`
(`node scripts/inventory-script-runtime.mjs`) on the installed GOTY packages,
2026-09-20.

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

1. **Training startup conformance.** Every pawn-ancestry map actor runs the full
   `PreBeginPlay → … → PostPostBeginPlay` chain and Player-start reset re-runs it,
   with **no unimplemented-boundary throw**. Currently-recorded startup boundaries
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

## Acceptance test to build

A single `scripts/validate-stage3-training-conformance.mjs` that:
- boots `00_Training`, runs startup, ticks N simulated seconds, fires each
  interaction in (3), then Player-start reset and repeats;
- asserts **zero** unimplemented-boundary throws for anything not on the
  explicit Stage-4/5 no-op allowlist;
- prints the set of native indices actually reached and which remain unbound, so
  the reachable-tail denominator is a number this test reports, not an estimate.

When that validator is green and the (4) lifecycle items run generally for
Training's objects, Stage 3 is done — with a printed, finite list of exactly what
was exercised.

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
| Persona screen layout/admission | `TextWindow` `ParentRequestedGranularity` override | ShowInventoryWindow |
| | `CheckboxWindow` family not admitted | ShowGoalsWindow |
| Persona screen teardown | native 3016 `UnloadTexture`; 264 `PlaySound` in `DestroyWindow` | MedicalBot, RepairBot close |
| Map-actor movement linking | `FarMoveActor` for a non-held map actor (carry: `GrabDecoration`) | Plant2, two crates, FlagTrigger0 |
| | `MoveActor` for a non-spawned rider (pickup) | CombatKnife, Candybar, HazMatSuit |
| Exec invocation | exec with omitted optional parameters | PutInHand, DropItem |
| | null-Context result shape | SwitchAmmo |
| Spawn admission | `Beam` subclass | ActivateAugmentation 9 (AugLight) |
| Resource graph | `DynamicLoadObject` of `DXFonts` | ShowMainMenu |
| Outside Stage 3 | 3011 `SaveGame`, `ClientTravel`, audible `PlaySound` (Lamp.Frob, AugLight) | QuickSave, Teleporter0 |

The SDK headers ([SDK reference](sdk-reference.md)) name each screen row's exact
retail functions. `CheckboxWindow` adds `Init`, `CleanUp`,
`ParentRequestedPreferredSize` and `Draw` to the recovered toggle chain. The
Inventory row is `XTextWindow::ParentRequestedGranularity` `0x10046880`.

Choose work by family, not by site. The two movement rows use the
already-recovered `MoveActor`/`FarMoveActor` bodies, which Play admits only
for the player, spawned views and held items. Admitting map actors closes all
seven probes in one change. `PlaySound` is admitted one exact caller at a time
([bot activation](script-window-bot-activation.md)). A static bytecode check
that each call discards the channel id could admit every such caller in one
change.

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
