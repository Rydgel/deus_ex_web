# Stage 3 completion audit — 2026-09-13 (updated)

This audit applies the required systems and done criterion in
[`roadmap.md:293-312`](roadmap.md#3-execute-game-behavior). A green focused
validator proves only the named original path that it exercises; it does not
turn an adapter or a package decode into general compatibility.

## Current validation snapshot

The current worktree passes the focused checks below:

```text
npm test                                                     486/486
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
```

The full local sweep is green: 486 `npm test` cases, all 165 `scripts/validate-*.mjs`
(the 82 oracle-backed probes need
`NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python`), and `npm run build`.

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
| Class inheritance | Linked Core/Engine/DeusEx class chains, UField/UStruct/UState/UClass registration and property-link dispatch are exercised by the runtime and class-registration tests. Evidence: [`script-class-registration.md:8-17,96-100`](script-class-registration.md), [`script-class-link.md:37-97`](script-class-link.md). The recovered `ULinkerLoad::CreateExport` now runs the metaclass branch: a null `ClassIndex` selects the hard-coded `Core.Class` identity, `StaticConstructObject` allocates through it, `SuperField` is installed from the export's `SuperIndex` and `UClass::Bind` copies the nearest native `ClassConstructor` down. Evidence: [`script-create-export.md`](script-create-export.md), `scripts/validate-create-export.mjs`. | The complete first-load class graph is still absent, and `CreateExport` stops at `Bind`: the constructed class keeps `RF_NeedLoad`, and its field chain/defaults still come from this project's decoded-package path rather than a live linker-archive preload. Next boundary: serialize one constructed export's own bytes through `ULinkerLoad::Preload` instead of completing it from the decoded package. |
| Default properties | Native CDO header/default allocation and inherited property copying are covered; 364 authored DeusEx struct defaults decode, and the augmentation manager/default list passes the live validator. Evidence: [`script-class-registration.md:102-143`](script-class-registration.md), [`script-struct-values.md`](script-struct-values.md), [`script-player-augmentation-startup.md:37-69`](script-player-augmentation-startup.md). | All classes/resources do not yet receive native CDO initialization, dynamic-container storage, config or localization values. Next boundary: one fresh non-prebound CDO containing an owning string/array property. |
| States | Original `TriggerToggle` Open/Close and `CameraPoint` Auto/Idle state selection run through VM state frames. Evidence and check: [`script-runtime.md:322-337`](script-runtime.md), `scripts/validate-script-runtime.mjs`. | Arbitrary state graphs, inherited state probes and state-frame persistence are not established. Next boundary: one non-door actor with inherited `BeginState`/`EndState` and a second transition. |
| Events | Spawn callbacks, Touch/UnTouch/Tick/Frob, trigger actions and the direct DataLink event path use original ProcessEvent/bytecode. Using a door is now the original `DeusExMover.Frob` body's decision — its frobbable/destroyed gates, lock branch with the class's localized `ClientMessage`, and the like-tagged `AllActors` fanout replaced a host reimplementation in `doors.mjs`. Evidence: [`script-spawn.md:284-329`](script-spawn.md), [`script-mover-frob.md`](script-mover-frob.md), `scripts/validate-trigger-actions.mjs`, `scripts/validate-mover-frob.mjs`, `scripts/validate-training-datalink-live.mjs`. | Generic ProcessEvent coverage, native event memory, exception/unwind and all subclass event overrides remain open. Next boundary: an authored event with owning struct/array parameters through live frame allocation and cleanup. |
| Timers | TriggerToggle `DelayTime`/`Sleep`, `Actor.SetTimer`, DamageTrigger timer scheduling and the DataLink end timer are compared against original order. Evidence: [`script-runtime.md:326-332`](script-runtime.md), [`script-trigger-actions.md:86-106`](script-trigger-actions.md). | A general scheduler for multiple actors, reentrant destruction and every timer flag is not proven. Next boundary: two live actor timers with one callback destroying or rescheduling the other. |
| Latent functions | `InterpolateTo`, `FinishInterpolation` suspension/reversal and state Sleep/DelayTime are covered in the selected mover path. Native 261 `FinishAnim` now installs latent action `0x181`, preserves the recovered rate/tween/flag gates, and clears the slot only when `bAnimFinished` is set. Evidence: [`script-runtime.md:322-344`](script-runtime.md), [`script-finish-anim.md`](script-finish-anim.md). | The browser does not yet advance arbitrary native mesh animation state to produce `bAnimFinished`; general latent-slot serialization is also unsupported. Next boundary: drive one authored non-mover animation through its original animation tick into the `0x181` poll. |
| Garbage collection | Core mark/purge ordering, typed reference holders, FName deletion/index reuse and CameraPoint cleanup have focused source-backed tests. Evidence: [`script-gc.md:170-221`](script-gc.md), [`script-reference-serialization.md:10-78`](script-reference-serialization.md). | The live world still lacks the complete class/resource graph, native destructors/allocators, dynamic array/map ownership and raw native event memory. Next boundary: collect a real map/resource subgraph containing a cycle, a lazy resource and a pending actor. |
| Native function dispatch | Selected Core arithmetic/string/state primitives, including `At_StrStr` 168, `Right` 234, `VRand` 252 and the ten float/vector operator natives (`Dot` 219, `==`/`!=` 217/218, `*` 296, unary `-` 211, `Square` 194, `*=` 221, `/=` 222, `-=` 224, `Min` 249) plus `Sqrt` 193, `Normal` 226, `GetAxes` 229 (whose three `out vector` arguments required per-position `GPropAddr` handling in the VM), `Smerp` 248 and `MirrorVectorByNormal` 300 — all with their recovered x87 rounding placement, the `SafeNormal` `1e-08` boundary and the shared CRT `sqrt` — and the nine rotator/modulo natives (`==`/`!=` 142/203 raw-dword rotator compares, `%` 173 through the shipped-MSVCRT `_CIfmod` path, `>>` 276 vector/rotator composition through the same quantized-sine helpers as `GetAxes` but with its own rounding placement, `*` 287/288 rotator-float products through the real `_ftol`, `-` 317 wrapped dword subtraction, `+=`/`-=` 318/319 out-parameter mutation through `GPropAddr`), and the ten string/transcendental natives (`<`/`<=`/`>=` 115/120/121 through appStrcmp — the shipped-MSVCRT `wcscmp`, case-sensitive unsigned UTF-16 with the `ArrayNum==0` empty-buffer substitution, `Asc` 237 first-UTF-16-unit, `^^` 131 zero-truth XOR, `/=` 160 int-by-float through the 80-bit quotient and real `_ftol` with its C3 zero-or-NaN-divisor fallback storing 0, `*=` 297 componentwise out-vector multiply through `GPropAddr`, `Sin`/`Cos`/`Tan`/`Atan` 187/188/189/190 through the bare x87 `fsin`/`fcos`/`fptan`/`fpatan` thunks, whose NaN, `±inf` and inclusive `2^63` out-of-range edges were measured on **real silicon through CrossOver/Rosetta 2** after the Unicorn oracle was shown to compute these four instructions in host double precision; `Math.sin/cos/tan` reproduce the hardware below `|x|=2^26` and larger finite operands are refused because the x87's 66-bit π argument reduction is not reimplemented, while `Math.atan` matches across the whole float32 range). Engine `FinishAnim` 261 and `SetLocation` 267 plus mover/actor/sound/animation functions, Extension flag/window functions and ConSys/DataLink functions dispatch through the VM. The four tracing natives are bound at their recovered exec contracts: `Trace` 277 (`SingleLineCheck`, `bTraceActors ? 0x37 : 6`, zeroed `FCheckResult` copyback), `FastTrace` 548 (`Level->Model->FastLineCheck`, AL byte mask), `TraceActors` 309 and `TraceTexture` 1000 (one `MultiLineCheck` at iterator start, `checkActors=1`, per-hit out publish, `Item -> node.iSurf -> surf` texture walk on `LevelInfo` ancestry). The four collision-query natives are bound the same way: `SetCollisionSize` 283 (collide-bit-gated hash remove/store/add on collision-view actors), `IsOverlapping` 718 (strict horizontal/vertical cylinders, Primitive+Brush and world-actor exclusions, null `checkActor` short circuit) and the `RadiusActors` 310/`VisibleActors` 311/`BasedActors` 306 level-array iterators (BaseClass ancestry filtering, per-resume out clear; 310/311 add the pre-stored optional `Loc`, 311 adds the hidden-flag skip, the `Radius==0.0` gate bypass and a per-resume `FastLineCheck`, 306 tests `candidate->+0xc4 == receiver`) and `SetBase` 298 (`SetBase(NewBase, 1)` — self-ancestry guard, world exclusion, byte StandingCount, Detach→store→Attach→BaseChange), `Move` 266 (zeroed FCheckResult with Time=1.0f/Item=-1, raw Rotation copy, `Level->MoveActor` vtable +0x88 with four trailing zeros and verbatim dword result through an explicit level `moveActor` boundary) and `MakeNoise` 512 (0xf1/0xf2 LevelInfo warns on both paths, NetMode==3 skip, dual-slot instigator noise memory with strict f64 freshness/loud thresholds and f32(T) stamps, PawnList dispatch that skips PlayerPawn-ancestry listeners for player noises else requires bidirectional IsA, and the recovered hearing gate — 4e6/1.6e7 loudness² ranges, dist²==0 early accept, Stimulus write plus threshold compare, Model FastLineCheck — ending in `ProcessEvent(HearNoise,{L,this})`). Evidence: [`script-coverage.md:23-37,56-96`](script-coverage.md), [`script-at-string.md`](script-at-string.md), [`script-trace.md`](script-trace.md), [`script-actor-queries.md`](script-actor-queries.md), [`script-string-operations.md`](script-string-operations.md), [`script-vrand.md`](script-vrand.md), [`script-finish-anim.md`](script-finish-anim.md), [`script-set-location.md`](script-set-location.md), [`script-int-operators.md`](script-int-operators.md), [`script-float-vector-operators.md`](script-float-vector-operators.md), [`script-normal-axes.md`](script-normal-axes.md), [`script-rotator-modulo.md`](script-rotator-modulo.md), [`script-string-transcendental.md`](script-string-transcendental.md), [`script-move-noise.md`](script-move-noise.md). | Of 581 decoded direct native indices, 375 remain outside the recorded scoped bindings; native-zero declarations, arbitrary iterator calls and many native branches are unsupported. The 267 wrapper still requires an explicit native actor and FarMoveActor adapter. |
| Imported objects | Canonical package/export identities, Outer/Class edges, hash lookup and existing-object `StaticLoadObject` return work for the Training graph. The Jaime portrait now constructs its canonical `ULinkerLoad` on first access and preserves BeginLoad → ResolveName → linker/export → CreateExport → EndLoad order. Evidence: [`script-resources.md:10-48`](script-resources.md), [`script-static-load-object.md`](script-static-load-object.md), `scripts/validate-training-datalink-live.mjs`. Native metaclass loading is closed for the constructor half: `createLinkerExport` builds a previously absent class export from the real `DeusEx.u` export table, and its recursive `IndexToObject` constructs the shared `DataVaultImage` super through the same body. Evidence: [`script-create-export.md`](script-create-export.md). | `staticLoadObject` still reaches this body only through a host `createExport` service; the two are not yet wired together for an absent export. Import references resolve to prebound identities rather than through their own linker, and null-export construction, general file search/error routes and nonempty post-load cleanup remain explicit. Next boundary: wire `staticLoadObject`'s absent-export route to `createLinkerExport` and resolve one import through its own `ULinkerLoad`. |
| Native actor/resource types | `Engine.Actor`-based CameraPoint construction is source/native checked; the Training LightSwitch LodMesh eager table, Sound header/WAV bytes and GM_Trench sequences are decoded. Evidence: [`script-spawn.md:211-302`](script-spawn.md), [`script-resources.md:65-93`](script-resources.md), [`script-play-anim.md:1-19`](script-play-anim.md). | General native actor subclasses, resource constructors/serializers/destructors, texture payloads and lazy mesh tails are not live. Next boundary: one non-prebound resource constructor and serializer attached to the canonical registry. |
| Object spawning | The scoped CameraPoint Spawn path preserves native argument/default order, naming, template copy, actor-array insertion, callbacks, zone and auto-state; player subsystem actors and DataLinkPlay use prepared spawn routes. The prologue's null/abstract/non-Actor/static gates now run ahead of this runtime's own admission gate. `Image02_NYC_Warehouse` adds the first **collision-carrying** subclass: it runs the pre-startup hash gate, the `PreBeginPlay` fake shrink, a live `CheckEncroachment` with its `DestroyActor` failure edge, the `Pickup` auto-state entry and the `FindBase` tail gate, all asserted as one observed sequence against the instrumented level hash and script dispatch. Evidence: [`script-spawn.md:211-302`](script-spawn.md), [`script-datavault-image.md`](script-datavault-image.md), `scripts/validate-inventory-spawn.mjs`. | Collision **placement** (`FindSpot`), undo, SpawnNotify bodies, spawn-during-tick and arbitrary native subclasses remain open. The admission gate no longer names a class key: `inventoryImageChain` admits any concrete class whose linked ancestry reaches `DataVaultImage -> Engine.Inventory -> Engine.Actor -> Core.Object`, which is the shape `UClass::Bind`'s constructor copy-down actually depends on, and a native subclass or one declaring its own fields is refused rather than given the AInventory body. All eight previously inadmissible shipped image classes now run the complete live route (`scripts/validate-datalink-transfer-object.mjs`). Next boundary: one map actor spawned through `ULevel::SpawnActor` with `bCollideWorld`/`bCollideWhenPlacing` set, so the `FindSpot` branch at `0x103950fb`-`0x103951ae` runs instead of being refused. |
| Object destruction | Actor/level destruction order, owner/touch cleanup, pending-kill gates, Window tree destruction and CameraPoint final release have focused translations. The recovered `ULevel::DestroyActor` order now runs in the live Play world: Training's `OrdersTrigger2.Touch` destroys its one-shot trigger through the host eligibility gate, `Destroyed`, `EndTouch(other,1)`, `FCollisionHash::RemoveActor`, the actor-array slot, `bDeleteMe`, both Core object-flag transitions and the deferred chain. Evidence: [`script-destroy.md:96-140`](script-destroy.md), [`script-world-destroy.md`](script-world-destroy.md), [`script-window-destroy.md:82-131`](script-window-destroy.md), `scripts/validate-world-destroy.mjs`. | `CleanupDestroyed`, native subclass destructors, allocator/free-list ownership and resource release are still not wired, and a live map actor's record has no `ULinkerLoad` or `UPackage` outer, so the recovered `SetLinker(NULL, -1)` export-slot clear has no live slot. Pawn, Mover, based-child and networked targets stay explicitly refused. Next boundary: destroy a spawned actor with an owned resource and verify registry/index/GC cleanup. |
| References | UObject header Name/Outer/Class/Linker/state references, typed property walks, inherited structs, PawnList links and canonical map references are checked. Evidence: [`script-reference-serialization.md:10-139`](script-reference-serialization.md), [`pawn-list.md:29-60`](pawn-list.md). | Raw native pointers, dynamic containers and the complete cross-package live graph are not traversed. Next boundary: a live map/resource reference graph with null, shared and cyclic edges. |
| Execution order | Native level pawn startup order, Spawn callback order, mover reversal, LightSwitch fanout and DataLink termination order are compared. Evidence: [`pawn-list.md:29-60`](pawn-list.md), [`script-spawn.md:278-329`](script-spawn.md), [`script-datalink-live.md:10-24,61-72`](script-datalink-live.md). | Full level startup with every non-pawn callback, startup spawns and destruction is not established. Next boundary: replay the complete Training startup loop against all actor-array slots. |
| Serialization hooks | UObject/Actor/reference serialization, class/property metadata, tagged-default measurement, complex `SerializeItem` and authored struct loading are covered. FString and dynamic-array `SerializeItem` now include the recovered save/load flags, CompactIndex encoding, allocation and recursive element paths through explicit archive/heap services. Evidence: [`script-reference-serialization.md:80-139`](script-reference-serialization.md), [`script-property-serialize-item.md`](script-property-serialize-item.md). | Native resource tails, raw heap integration, map/object archive composition and map/save persistence remain open. Next boundary: one Sound or non-prebound resource through its real load archive; full save/map persistence is Stage 6. |
| Native calls across Engine, game, UI/Extension and ConSys | The selected mover, light, trigger/damage, DataLink and Window routes cross all named package families and are checked by their focused validators. Evidence: [`script-coverage.md:56-60,94-109`](script-coverage.md), [`script-lights.md:43-63`](script-lights.md). | Package availability and selected bindings do not establish broad native compatibility; UI/extension event overrides, engine iterators, game AI and raw native services remain incomplete. Next boundary: broaden one cross-package event route only after its native call graph and frame ownership are recovered. |
| Script-controlled light switches and lighting changes | Training `LightSwitch.Frob` fans out to four original TriggerLights; TriggerToggle/Tick, PlayAnim and steady brightness lightmap refill/upload pass the live validator. Evidence: [`script-lights.md:13-39,43-63`](script-lights.md), [`script-light-cache.md:60-88,107-131`](script-light-cache.md), `scripts/validate-script-lights.mjs`. | The selected Stage 3 light requirement is met for this documented subset. General `bLightChanged` setter/clear lifetime, radius/effect/type/corona branches and moving-light rendering remain open; the next boundary is the original dirty-bit owner. |
| Deus Ex conversation and UI classes | `ConBindEvents`, the 18 Training direct Speech→End routes, six-control InfoLink construction/destruction, queue/reset, first-load Jaime portrait linker and exact speech timing/audio bytes pass. Mission00 `M00MeetPage` executes canonical MoveCamera export 50071 through its exact native false binder and the installed action into Speech export 50044. `ConEventCheckObject.BindActor` preserves its `NK_` clear and class-load branches; MeetKaplan and ChadThankful run their installed Inventory/NanoKey predicates and both next/fail actions. `ConEventTransferObject.BindActor` now preserves its from/to bark/normal name order and class load. All ten shipped DataLink references are pinned, and `DL_Rooftops` export 7448 runs through native 2053 to bind JCDenton and load `Image02_NYC_Warehouse`. Evidence: [`script-datalink-live.md`](script-datalink-live.md), [`script-conversation-events.md`](script-conversation-events.md), [`script-conversation-check-object-bind.md`](script-conversation-check-object-bind.md), [`script-conversation-transfer-object-bind.md`](script-conversation-transfer-object-bind.md), `scripts/validate-conversation-transfer-object-bind.mjs`. | TransferObject's DataVaultImage action is closed for the admitted route: `DL_Rooftops` runs `SetupEventTransferObject` end to end through `Spawn(event.giveObject)`, `DataVaultImage.SpawnCopy` over `Inventory.SpawnCopy`, `GiveTo`/`BecomeItem`, `DeusExPlayer.AddInventory` (whose belt/root arm the `DataVaultImage` test skips), `Pawn.AddInventory`, `GotoState('Idle2')`, `DeusExPlayer.AddImage` and one recorded `HUDReceivedDisplay.AddItem(item,1)`, returning `EA_NextEvent` with an empty label. Evidence: [`script-datavault-image.md`](script-datavault-image.md), `scripts/validate-datalink-transfer-object.mjs`. Native mixer, glyph/texture presentation and final HUD rendering are Stage 4. All nine shipped image classes are now admitted subclasses rather than pinned references: each is constructed through the `CreateExport` metaclass branch and admitted by linked ancestry, and the eight beyond `Image02_NYC_Warehouse` run the same `SetupEventTransferObject` body to a distinct carried DataVault entry. Next boundary: `ConEvent` targets outside this chain still need their own native construction. |

## Stage 4 and Stage 5 separation

The following are deliberately outside the Stage 3 gates:

* **Stage 4 presentation** (`roadmap.md:314-331`): lazy mesh geometry and visual
  animation, skins/textures, animated effects, audible `ClientHearSound`, audio
  mixing, glyph rasterization and final HUD/conversation rendering. The eager
  GM_Trench sequence decode and PlayAnim state writes are already Stage 3 runtime
  evidence; visual playback is not.
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
   and all ten shipped TransferObject routes — bind through construction,
   `SpawnCopy`/`GiveTo`, `AddImage` and the received-items boundary — are green
   for all nine distinct image classes, which now reach the runtime through the
   recovered `CreateExport` metaclass branch and an ancestry-based admission
   gate. Export **serialization** through the linker archive, and every
   non-prebound ConEvent target outside this chain, still require their original
   services. Presentation audio/rendering belongs to Stage 4.

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

**The previous slice is done.** Native metaclass class loading is recovered:
`ULinkerLoad::CreateExport` (`0x1012e230`) is translated in
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

**What this slice did not close.** `CreateExport` ends at `UClass::Bind` and
leaves `RF_NeedLoad` set, exactly as the original does. Serializing the
constructed export's own bytes is a different recovered body, so the field
chain, defaults and Link order still come from this project's decoded-package
path; `scripts/validate-create-export.mjs` compares the two rather than claiming
the linker produced them. `staticLoadObject` also still reaches `CreateExport`
only through a host service, and import references resolve to prebound
identities.

Next, in order:

1. Wire `staticLoadObject`'s absent-export route to `createLinkerExport`, so a
   first load reaches the recovered body instead of a host `createExport` stub.
2. Recover `ULinkerLoad::Preload` and serialize one constructed class export's
   own bytes, replacing the decoded-package completion for that class.
3. Resolve one cross-package import through its own `ULinkerLoad` rather than a
   prebound identity.

Keep mixer/rendering work in Stage 4.
