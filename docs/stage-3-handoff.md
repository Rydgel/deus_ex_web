# Stage 3 handoff — 2026-09-10 (updated 2026-09-13)

The original 2026-09-10 stop preserved an unfinished Stage 3 checkpoint at the
user's request. This document keeps that history, while the current checkpoint
and later progress are recorded below. Stage 2 is
committed as `3a74d2b` (`Implement source-backed Stage 2 playable slice`).
The work has since resumed; earlier agent research notes remain preserved below.

See the [Stage 3 completion audit](stage-3-completion-audit.md) for a current
roadmap-aligned requirement matrix and remaining completion gates.

After this handoff, the user reported disabled Play. A bounded loader fix was
made: Vite's local manifest omitted Sounds/Music and `.uax`/`.umx`, so the
expanded map host failed with `Missing package: Training_Music`. The two-line
fix in `vite.config.mjs` now serves those original package types locally.
Verification through the actual HTTP manifest/file endpoints initialized
training Play and advanced JC to grounded successfully. Reload the page to
discard the old manifest. This fix is included in the checkpoint.

## Latest — original DeusExMover.Frob and the SpawnActor gate order (2026-09-13)

Two source-backed corrections on top of the checkpoint below.

**`ULevel::SpawnActor` gate order.** `ScriptRuntime.spawnActor` selected a
subclass startup before running any original gate, so `Spawn(class'Actor')`
threw `SpawnActor engine.actor subclass startup is not implemented` instead of
returning null. The original prologue (`0x10394f81`-`0x103950b0`, abstract test
at `0x10394fc2`) rejects a null, abstract, non-Actor or static/nondeletable
class before any class-specific behaviour. Those four gates are now
`spawnActorRejectedByGates` in `script-spawn.mjs` and run ahead of the runtime's
own admission gate. `scripts/validate-script-spawn.mjs` is green again; the
object-spawning gap itself is unchanged.

**Original `DeusExMover.Frob` in Play.** `doors.mjs` decided by itself whether a
door could be used — it re-implemented the frobbable/destroyed, locked and
one-way gates in JavaScript, built the like-tagged group from the viewer's own
mover list, and substituted its own `"It's locked"` text. `DeusEx.u` export
15897 now runs through `ProcessEvent` instead, so Training's locked (`gundoor`,
`keydoor`, `MedDoor`) and non-frobbable (`paddoor`, `hackdoor`,
`bodydoorsopen`) doors refuse the way the original refuses them, with the class's
own localized `msgLocked`, and double doors open through the body's
`AllActors(class'DeusExMover', Tag)` fanout. `ClientMessage` stays a recorded
boundary (root-window/console delivery is Stage 4) and the Lockpick/NanoKeyRing
branches stay unreached because Play frobs with `frobWith = None`.
Evidence and boundaries: [script-mover-frob.md](script-mover-frob.md);
check with `node scripts/validate-mover-frob.mjs`.


## Current checkpoint — live player startup and DataLink lifecycle (2026-09-13)

The resumed work addressed original property value copying and destruction,
which are dependencies of class loading and cleanup. Native
[CopySingleValue/CopyCompleteValue](script-property-copy.md) dispatch now uses
raw byte cursors and is the default inherited-property route in class-default
initialization. The [DestroyValue dispatcher](script-property-destroy.md) is
connected to the logical VM's object `ExitProperties`, including owning struct
members. Ordinary calls now destroy owning typed temporaries after return/out
copyback, and ProcessEvent destroys only its local suffix while preserving
parameter ownership. The pending-kill gate was corrected against the original
instructions and a focused native comparison; see
[frame ownership](script-frame-ownership.md). Native allocation/reference
services, array/map temporary storage, raw native event memory, and the complete
loaded class graph remain explicit boundaries.

Generic authored structs now load through their original SerializeBin member
order. All 364 formerly opaque DeusEx class-default entries (14 struct names)
decode, and Training map inventory/Region records preserve canonical nested
references and inherited array entries. See [struct loading](script-struct-values.md).
The loaded struct layout bridge now replays the recovered UStruct/property Link
bodies to supply native member offsets, bool masks, ownership flags and array
strides; keyed logical storage keeps those native masks separate. Dynamic
arrays/maps and transient archive-state branches remain explicit boundaries.
See [struct layouts](script-struct-layout.md).

The bounded [resource graph](script-resources.md) now shares canonical export
identities with the VM, follows package Outer/Class references, and prepares the
LightSwitch LodMesh eager payload before PlayAnim runs. It also decodes the
original switch Sound format-name/lazy header and PCM WAV payloads, preparing
both sound constants from Frob bytecode before use. Native lazy payload ownership,
resource destruction and full live-world GC remain incomplete.

The same audit corrected FString's native header interpretation: `ArrayNum` is
at `+4`, `ArrayMax` at `+8`. Collector/measure serialization now uses the used
count; a valid `'abc'` record with `Num=4, Max=20` measures 8 bytes. Raw empty
(`Num=0`) and allocated empty (`Num=1`) remain distinct. See
[SerializeItem evidence](script-property-serialize-item.md).

Native 267 `Actor.SetLocation` now dispatches through its recovered wrapper:
one vector evaluation, `Actor+0xac` level lookup, and
`FarMoveActor(level, actor, destination, 0, 0)` with Boolean propagation. It
requires an explicit native actor/relocation adapter so arbitrary script actors
cannot fall into player-specific collision callbacks. See
[SetLocation evidence](script-set-location.md).

Core native 252 `Object.VRand` now reproduces the installed three-`appFrand`
rejection loop, float32 component stores, retained-Z comparison and x87 output
stores across 33 hash-pinned Core.dll cases. Engine native 261 `FinishAnim`
installs latent action `0x181` and its poll clears only after `bAnimFinished`;
the recovered rate, tween and animation-flag gates are preserved. The original
main/blend animation phase now produces that flag and completes Jaime's wait
in a focused runtime check. General world actor scheduling/startup remains open.
See [animation tick](script-animation-tick.md),
[VRand evidence](script-vrand.md) and [FinishAnim evidence](script-finish-anim.md).

### Latest UI checkpoint — live Training DataLink lifecycle

Normal movement into a Training `DataLinkTrigger` now enters the installed
selection and spawn path. The source-backed catalog links all 18 authored map
routes to their canonical Mission00 Conversation, Speech and End objects, exact
speech text and encoded MP3 payload. Unknown tags remain rejected. `DL_Start`
still begins by walking into `DataLinkTrigger23`; there is no replay or close
button.

The installed 736-byte `HUDInfoLinkDisplay.CreateControls` body now constructs
all six controls. Recovered native Window, TextWindow and ComputerWindow code
establishes the 431×114 shell, portrait/static pair, incoming/queued title
controls, 42×6 text grid and 293×1 divider. Window Show/IsVisible, background,
tile color and recursive destruction have focused hash-pinned native checks.
The browser draws those recovered bounds and colors and plays each route's exact
speech bytes; glyph rasterization, final HUD texture drawing and the original
ClientHearSound mixer remain presentation adapters or boundaries.

The first route executes installed player selection, DataLinkPlay Spawn,
SetConversation/SetTrigger and ConPlayBase start/termination. The translated
DataLinkPlay scheduler calls the prepared HUD methods at the original state
edges, including cursor/icon visibility, screen clear, speaker/portrait/text,
and end-title blinking. Speech completion now executes the installed
`PlayNextEvent` and `ProcessAction(EA_NextEvent)` bodies, enters the prepared
`PlayEvent` state, dispatches the linked End object through inherited
`SetupEventEnd`, and returns `EA_End` through the installed `ProcessAction`
before `TerminateConversation`. Completion runs
`DataLinkTrigger.DatalinkFinished`, writes the route's played flag, disables
the one-shot trigger, clears the HUD reference and removes the play actor. The installed
`DeusExHUD.DestroyInfoLinkWindow` now recursively destroys the display and all
six controls; its original `DescendantRemoved` event clears the HUD reference.
Distinct eligible routes can queue behind one active play, the installed
`PopDataLink` selects the next Conversation, and original `CreateControls`
constructs a fresh display tree before it starts. Reset uses the same destroy
and reconstruction path. See [live DataLink lifecycle](script-datalink-live.md),
[InfoLink content](script-infolink-content.md), [ComputerWindow](script-window-computer.md),
and [Window destruction](script-window-destroy.md). Stage 3 remains unfinished.

The generic conversation boundary has also advanced beyond the prepared
Speech→End routes. Mission00 `Conversation0`/`M00MeetPage` now executes authored
MoveCamera export 50071 through the hash-pinned native false-return binder at
`0x100098f0`; installed `SetupEvent` keeps `EA_NextEvent`, and installed
`ProcessAction` advances to Speech export 50044. `ConEventCheckObject.BindActor`
preserves the installed `NK_` clear and `CreatePackage` → `StaticLoadObject`
class-load branches. Authored non-DataLink MeetKaplan export 2555 now runs installed
`SetupEventCheckObject` and `Pawn.FindInventoryType`; a present WeaponRifle
applies `EA_NextEvent` through original ProcessAction, while an empty Inventory
emits `EA_JumpToLabel("NoRifle")`. Authored non-DataLink ChadThankful export
21066 also executes native 234 `Right`, `StringToName`, and
`NanoKeyRing.HasKey`, emitting next-event for its matching key and
`EA_JumpToLabel("NeedKey")` without it. Installed GetEventFromLabel applies
`NoRifle` to export 2559 and `NeedKey` to export 21101. TransferObject now has
its exact from/to actor and class-load binder; all ten shipped DataLink image
references are pinned, and `DL_Rooftops` binds JCDenton through native 2053.
Its DataVaultImage construction/inventory action and native metaclass loading
remain open. Camera presentation is Stage 4. See
[conversation bind evidence](script-conversation-base-bind.md) and the
[CheckObject binder](script-conversation-check-object-bind.md) and
[TransferObject binder](script-conversation-transfer-object-bind.md).

### Playable checkpoint — Training dark-room doors

The original `DeusExMover19/20` pair (`Tag=darkdoor`, `Event=padoor`) now works
through normal Play use. Admission requires the complete canonical level actor
array to prove that `padoor` has zero recipients. The original `Mover` bytecode
still performs native 304 `AllActors` enumeration on open and close; the focused
validator observes one exhausted iterator and zero matches per panel. Both
panels reach their authored second keys after two seconds, normal player
movement crosses the open doorway, second use closes them, and reset restores
their original state. The starting doors remain supported. The local Training
page exposes **Dark door preview**, which calls the normal use route and visibly
opens the pair. See [the milestone record](stage-3-next-milestone.md) and
[door runtime evidence](script-doors.md). Stage 3 remains unfinished.

### Gameplay checkpoint — M3 step 4

The current checkpoint runs original Orders/Flag functions in Play. Training's
OrdersTrigger0 queues JaimeReyes1's `Patrolling`/`gunroom` order through the
original SetOrders/FollowOrders helpers; FlagTrigger0 changes its mission bool
on Touch/UnTouch through recovered FlagBase natives. Native GetPlayerPawn now
follows the first viewport's Actor through the explicit engine/client graph.
DamageTrigger.Touch schedules its original timer and the callback now enters the
prepared `TakeDamage -> AddDamageDisplay -> DXReduceDamage -> StopPoison ->
UsingChargedPickup -> SetDamagePercent -> PlayDXTakeDamageHit -> PlayHit ->
Human.PlayTakeHitSound` chain with the live player `AugmentationManager1`. The
former explicitly null `AugmentationSystem` was a browser lifecycle gap; the
focused startup validator now proves the normal manager, exact 21-class list,
and defaults. Because `AugEnviro` is unowned, Radiation10 writes
`adjustedDamage=10` and returns false, then body health becomes
`HealthLegLeft=90`/`Health=98`. The canonical
`DeusExCharacters.GM_Trench` payload passes the complete original
`ULodMesh::Serialize` oracle, decodes all 71 sequences in the browser and drives
native PlayAnim 259 with original optional-argument defaults; the live hit state
is `HitLegLeft`, frame `-0.25`, rate `2.5`, tween `2.5`, last `0.75`
(corrected against original exec in [animation controls](script-animation-controls.md)). Execution then
stops at the exact `Human.PlayTakeHitSound -> Actor.PlaySound(264)` audio
boundary. The focused native-145 comparison also establishes signed division,
the zero-divisor guard, left-to-right operand evaluation, cursor advancement,
and the `INT_MIN / -1` processor exception; see [Core Divide_IntInt](script-divide-int.md).
Base
Trigger relevance/fanout remains covered. Subsequent AI state execution, other
damage branches, and flag expiration remain open. See [trigger actions](script-trigger-actions.md),
[damage primitives](script-core-damage-primitives.md), [Core Divide_IntInt](script-divide-int.md),
and [player startup](script-player-augmentation-startup.md).
Stage 3 remains unfinished.

The M3 step 1 `DL_Start` route has grown into the 18-route Training lifecycle
described above. The catalog is still deliberately limited to direct
Speech-to-End chains; generic DataLink ConEvent playback remains open.

## Working rules

- Follow [AGENTS.md](../AGENTS.md): independently translate original data,
  bytecode and native instructions. Do not substitute guessed behavior.
- Keep delivery local; do not commit, push or deploy without a request.
- Keep JavaScript; no performance/WASM detour.
- Use focused checks at new translation/integration boundaries. Do not rerun
  passing checks without a change or unresolved concern. Nonvisual Stage 3
  work has no visual-comparison gate.
- Use bounded subagent tasks when useful, with explicit file ownership; prefer
  the configured `luna_worker`. Preserve existing uncommitted work.
- The user can run the original game through CrossOver and has extraction
  tools available. Reuse the existing `tools/` capture utilities and native
  probes; request an original-game measurement when the next behavior contract
  needs evidence that the available data and instructions do not establish.

## Implemented, with scope limits

| Area | Current result | Reference |
| --- | --- | --- |
| VM and doors | Original selected door functions/state bytecode run in Play; typed fields/parameters, inheritance, events, state transitions, timers and selected latent/native paths work. The Training dark-room pair now admits its nonempty `padoor` event after a complete level scan proves zero recipients, while the original `AllActors` enumeration still runs. | [Runtime scope](script-runtime.md), [doors](script-doors.md), [dark-room milestone](stage-3-next-milestone.md) |
| Object lifecycle | Source-backed construction, ownership, destruction, metadata/linking, serialization and GC components; concrete CameraPoint paths and Core.Object registration have focused coverage. Full native world/resource graph remains incomplete. | [Roadmap Stage 3](roadmap.md#3-execute-game-behavior) |
| Property values | Raw native copy feeds class defaults; destruction covers logical objects and owning string/struct call/event temporaries. Generic authored structs decode and link their native strides. FString and TArray `SerializeItem` now cover collector, save and load directions, including CompactIndex, allocation and recursive element behavior through explicit archive/heap services. Map temporaries, raw heap integration and full archive composition remain open. | [SerializeItem](script-property-serialize-item.md), [frame ownership](script-frame-ownership.md), [struct loading](script-struct-values.md), [struct layouts](script-struct-layout.md) |
| Map actor host | Full serialized actor array, null slots, canonical identities, typed authored properties and inherited resource references. Training preserves all 1,337 original slots, then appends JC and the bounded player subsystem actors. | [Map actors](script-map-actors.md), [player startup](script-player-augmentation-startup.md) |
| Script lights | Player Frob, LightSwitch fanout, PlayAnim and original TriggerLight ticking run in Play. Steady brightness changes now refill dependent lightmap pixels and upload existing atlas tiles. General native dirty-flag lifetime and other light changes remain unresolved. | [Lights](script-lights.md), [light cache](script-light-cache.md) |
| Sound native | PlaySound264 and CheckHearSound translated: live argument defaults, optional demo recording, channel IDs, listener traversal, distance/occlusion gates. Native events and live host graph are explicit services; no audible playback yet. | [Sound](script-sound.md), `src/runtime/script-sound.mjs` |
| Sound BSP trace | Original UModel.FastLineCheck translated and used by the sound helper. This differs from movement LineCheck in flags and plane-boundary rules. | [FastLineCheck](fast-line-check.md), `src/runtime/fast-line-check.mjs` |
| Sound storage | Original Switch4ClickOn bytes now pass a combined canonical linker-archive attach, lazy byte load, WAV period, cursor restore and storage release check. Audio-null loading is supported; a live audio subsystem and the full resource loader remain open. | [Lazy byte arrays](script-lazy-byte-array.md), [period](script-sound-period.md), `scripts/validate-sound-archive-integration.mjs` |
| Conversation binding | Shared 2052/2053 dispatch covers Speech, Animation/Trade, MoveCamera, CheckObject, TransferObject and thirteen verified inherited BindActor classes. CheckObject preserves the recovered `NK_` clear and synchronous class-load branches. MeetKaplan and ChadThankful apply both next and fail actions. TransferObject preserves the recovered from/to bark/normal comparisons and class load; `DL_Rooftops` binds its real player/image references through native 2053. The original property linker and a targeted Training capture identify bFirstPerson at offset80, mask4. | [Events](script-conversation-events.md), [CheckObject](script-conversation-check-object-bind.md), [TransferObject](script-conversation-transfer-object-bind.md), [action binding](script-conversation-action-bind.md), [live capture](stage3-live-capture.md) |
| Conversation loading/timing | ConBindEvents passes through recovered ResolveName/StaticLoadObject and constructs/purges typed ConListItems. The Jaime portrait now constructs its canonical `ULinkerLoad` on first access before the existing CreateExport identity returns. Shared2055/2056 speech lookup, FString cleanup and original DL_Start MP3 lazy loading/timing pass the combined route. Native metaclass/null-export loading, the general loader graph and ClientHearSound mixer remain open. | [Static loading](script-static-load-object.md), [speech lookup](script-conversation-speech-audio.md), [speech timing](script-conversation-sound-length.md), [preview audio](script-infolink-audio.md) |
| DataLink lifecycle/UI | All 18 Training routes resolve canonical Mission00 Speech-to-End chains and exact audio. Installed selection/spawn/start/termination and trigger completion surround the translated playback schedule; the fixed queue advances with original HUD destruction, `PopDataLink`, and fresh shell construction. Mission00 MoveCamera→Speech executes its installed action path. The two CheckObject references proven here are non-DataLink. Exactly ten shipped DataLinks contain TransferObject image deliveries; `DL_Rooftops` now executes the original actor/class bind through native 2053. Its SetupEvent inventory action, native rendering and native audio mixing remain open. | [Live lifecycle](script-datalink-live.md), [Training catalog](script-training-datalinks.md), [TransferObject](script-conversation-transfer-object-bind.md), [DataLink](script-datalink-transmission.md) |
| Mission triggers | OrdersTrigger queues the Training pawn's original patrol order, FlagTrigger uses recovered FlagBase storage, and DamageTrigger enters the original Radiation10 chain with the live AugmentationManager. Unowned AugEnviro yields `adjustedDamage=10`/false; body health becomes `HealthLegLeft=90`/`Health=98`, and prepared GM_Trench PlayAnim stores `HitLegLeft` frame `-0.25`, rate `2.5`, tween `2.5`, last `0.75`. Execution stops at the exact `Human.PlayTakeHitSound -> Actor.PlaySound(264)` audio boundary. Core native 145 has its separate signed-division and exceptional-path evidence. | [Trigger actions](script-trigger-actions.md), [damage primitives](script-core-damage-primitives.md), [Core Divide_IntInt](script-divide-int.md), [scene routing](scene-events.md), [player startup](script-player-augmentation-startup.md), [PlayAnim](script-play-anim.md) |
| Atlas | Existing tiles are updated after the selected steady TriggerLight script tick, preserving UVs and padding. Native GPU/cache allocation is not modeled. | [Light cache](script-light-cache.md) |
| Plant scripts | The recovered Plant7 Bump/Timer and decoration physics path now moves and settles the plant in the focused Play host. Burning, carried-decoration, sound and AI branches remain explicit boundaries. | [Plant contact](script-plant-contact.md), [rolling](rolling.md) |

**Superseded historical note:** the original handoff stopped with Plant7 contact
reaching `Unsupported original scene event: Plant7.Bump`. The 2026-09-11
decoration-physics work recovered the Bump/rolling route and validated it in Play;
the remaining branches are listed in the current table and progress notes.

## What remains

1. **Finish broader DataLink event playback.** The Jaime portrait now creates
   its canonical `ULinkerLoad`, Mission00 MoveCamera→Speech passes, and the
   CheckObject native class binder is recovered, and authored MeetKaplan and
   ChadThankful apply their full predicates and action targets. TransferObject's
   actor/class binder and shipped DataLink catalog are recovered. Construct the
   real DataVaultImage Spawn/SpawnCopy/AddImage route and native metaclass/null-export
   class graph next; these remain explicit boundaries.
2. **Finish the remaining LightSwitch native/presentation integration.** The recovered fixture route runs
   `Super.Frob` → `PlaySound` channel id 547874 → live PawnList traversal →
   `PlayAnim('On')`; the measured global index and conversation binding are also
   covered. Player Frob, the four-light fanout and original light ticking are
   already wired in Play (M2 step 2 below). Play still records PlaySound;
   `ClientHearSound` audible playback and switch mesh rendering belong to Stage 4.
3. **Resolve other native light-cache branches when extending lighting.** The
   steady brightness route now uses the recovered live RGB multiplication and
   cached color-header comparison to refill dependent browser lightmaps. Six
   original Render.dll branch cases and the Play-to-atlas check pass. General
   `bLightChanged` setter/clear lifetime and geometry/effect changes remain
   unresolved; do not extend the brightness-only route by assumption.
4. **Extend decoration behavior beyond the training push path.** Burning and
   carried-decoration branches still need their original state/carry, Fire,
   audio and particle dependencies. Preserve explicit boundaries until those
   native/state contracts are recovered.
5. **Finish the Stage 3 runtime graph.** Property `Link`, complex `Identical`,
   collector/measure and FString/TArray loading/saving `SerializeItem`, raw
   value copying and value destruction translations have bounded coverage.
   Class defaults and logical object
   ExitProperties use the new dispatchers. The remaining foundation is the
   complete class/resource loader and
   raw native layout graph, config/localization resources, broader spawning,
   generic tagged save serialization, native heap ownership beyond explicit
   SerializeItem adapters, array/map temporary storage and raw native event
   memory, full serialization/release/GC integration and general global
   object identity.
6. **Expand actual native coverage.** Orders/Flag actions and Damage scheduling
   now run through original functions; subsequent AI/damage/flag-expiration
   behavior remains open, alongside broader Engine/game behavior and Deus Ex UI and
   conversation systems; use [the coverage inventory](script-coverage.md).

## Progress since this handoff

- **Training DataLink catalog and complete InfoLink control graph (2026-09-12).**
  All 18 authored Training triggers resolve to their canonical Mission00 direct
  Speech-to-End chains, Jaime speaker, exact text and MP3 bytes/timing. The
  installed CreateControls body constructs `winQueued`, ComputerWindow
  `winText`, and `winLine` in addition to the earlier controls. Prepared HUD
  calls now drive startup blink, speech publication and end blink; one active
  play can queue a second route and advance through original `PopDataLink`.
  The installed SetSpeaker body now runs through recovered Core `Left`, native
  concatenation, canonical Texture loading/casting and original TextWindow text.
  Native Window Show/IsVisible, surface setters, ComputerWindow and recursive
  destruction each have focused original-DLL validation. The live end path now
  calls original `DeusExHUD.DestroyInfoLinkWindow`; `DescendantRemoved` clears
  the HUD field and queued/reset paths reconstruct a distinct six-control child
  through original `CreateControls`. General ConEvent playback remains open.
- **Verified InfoLink first controls (2026-09-12).** Native1431 SetSize/Resize,
  native1432 SetPos/Move and native1422 SetBackgroundStyle/XGC::SetStyle match
  the unchanged Extension.dll storage and callback order. The original
  HUDInfoLinkDisplay `CreateControls` bytecode now fully constructs
  `winPortrait` and `winStatic` at 20,25 with size 64x64, then native TextWindow
  `winName` at 94,15 with size 293x15, including original alignment, font,
  packed color, margins, accelerator scan and title. The local browser shows
  all three bounds; execution stops at `winQueued`. The later live-lifecycle
  increment publishes this shell; the remaining three controls stay open.

- **Training dark-room door milestone (2026-09-12).** The paired
  `DeusExMover19/20` panels now open, permit normal player passage, close and
  reset through the original TriggerToggle state. Their authored `padoor`
  fanout executes against the complete canonical actor array and finds zero
  recipients. A focused integration validator, 11 movement tests, production
  build and local browser preview pass. Stage 3 overall remains unfinished;
  this checkpoint has no invented completion percentage.

- **Native default copying checkpoint (2026-09-12).** The reusable
  [InitProperties adapter](script-object-properties.md) now matches three
  unchanged Core executions for explicit templates, class-default fallback,
  suffix zeroing, header preservation, owning-property zero/copy order and a
  callback-mutated Next link. It remains a standalone component; full fresh
  Window/GC allocation and default-resource loading are not complete.
  [Native property offset research](script-native-property-offsets.md)
  identifies the ECppProperty constructor store but leaves Extension's exact
  static-constructor/default-tag path unresolved. At the user's request this
  batch was wrapped up to conserve usage. The reported 40–50% Stage 3 remaining
  is a rough scope estimate, not a measured completion ratio.

  Stopped worker research established the next parent-event blocks without
  implementing them: ChildRequestedVisibilityChange is Window export1729,
  flags0x802, childWin at0 and bool at4 (8-byte parameter block), event name
  literal10098268 -> global1009b3e8. ChildRequestedReconfiguration is export1727,
  flags0x802, childWin at0 and return bool at4, event name literal1009822c ->
  global1009b350. Its native body
  10003580..100035ae zeroes the return word before ProcessScript(thirdArg0),
  then returns the copied-back dword. Both wrappers still need their focused
  native comparisons and typed event bridge. Size research remains recorded
  in the DataLink document. Native1431 was implemented and validated in the
  later InfoLink shell checkpoint above.

- **Window lifecycle components (2026-09-12).** Shared1410 now preserves
  NewChild's canonical arguments, default visibility, callback order and
  pre-Unlock destruction decision. Shared1425 follows the native parent links
  and unsigned type-byte gate. Original ProcessScript/Core checked lookup
  comparisons establish scriptability and exact UFunction dispatch; the typed
  InfoLink InitWindow chain assigns its player and executes the eight prepared
  original style/theme/preference functions through SetSize1431. The prepared
  CreateControls body now completes `winPortrait`, `winStatic` and `winName`,
  then stops at the next `TextWindow` allocation for `winQueued`.
  XWindow::Init now has unchanged-native comparisons for storage/callback/font
  order, preserving packed-color bytes left by the native stack. AddChild and
  RemoveChild match original pointer mutations. The composed lifecycle fixture
  combines these with Window/GC constructors and original Window events, while
  allocation and visibility remain explicit leaves. Shared1460 and NewChild's
  final request now run AskParentForReconfigure through explicit raw/global
  services; hidden/root/parent native comparisons and the hidden child
  integration pass. SetFonts
  now executes its recovered two pointer stores with an original comparison.
  Shared-runtime tests436/436, ProcessEvent ownership comparison and build pass.
  Final constructor validation also passes for XExtensionObject, XWindow and
  XGC, including patterned storage and original UClass.Bind inheritance.
  An integration audit made checked lookup and ProcessEvent share fresh reads
  of GIsScriptable: unchecked lookup may find a function even when the event's
  independent gate suppresses execution. Focused checks and the full suite/build
  pass after that correction. The next runtime work remains actual fresh UI
  allocation/default storage, visibility and reconfiguration callbacks, and the
  final three InfoLink controls. The later DL_Start lifecycle now publishes the
  verified partial shell, without claiming native subtree destruction/rendering.
  See [child construction](script-window-child.md), [Init](script-window-init.md),
  [hierarchy](script-window-hierarchy.md), and [event dispatch](script-window-script.md).
  The new [native layout contract](script-window-layout.md) establishes
  ExtensionObject/Window/GC sizes `0x28/0x14c/0xb8`, the GC template/working
  pointer direction, and the reflected Color alpha byte. GC's untouched
  underlineTexture slot at `+0x84` has the authored `Extension.Solid` default;
  authentic raw default allocation remains the next dependency.
  [SetVisibility/SetChildVisibility](script-window-visibility.md) also now
  match three unchanged-native reference paths: root transition, hidden
  ancestor suppression, and parent dispatch/context restoration. They remain
  standalone components until the parent event parameter block and focus/
  initialization/reconfiguration leaves are connected. This batch's shared
  suite remains 436/436 and the build passes; focused font, reconfiguration,
  layout-immediate, visibility and InfoLink style checks pass.

- **Animation/trade conversation event binding (2026-09-12).** Both original
  event vtables select ConSys100071b0. The shared runtime now dispatches that
  body through native2053 with typed actor/event fields. Original Core property
  Link identifies its Conversation+50 mask4 gate as `bFirstPerson`; package
  Children order and native Link output agree. Native bark/fallback/miss
  cases and both typed event-class integrations pass. Action playback remains
  separate. See [action binding](script-conversation-action-bind.md).

- **Lazy archive boundaries (2026-09-12).** Original Core Attach/Detach now
  has a concrete canonical ULinkerLoad archive adapter, including growth,
  duplicate removal, logging and loader-field clearing. Original Engine generic
  byte-array serialization now keeps ArrayNum as a live compact-index lvalue
  and rereads it after allocation. The focused native comparison verifies
  callback mutations at these boundaries. Full package/resource ownership
  remains open. See [linker archive](script-linker-lazy-loader.md) and
  [lazy bytes](script-lazy-byte-array.md).

- **Canonical conversation binding and item lifetime (2026-09-12).** Shared
  natives2100/2101/2102 now run the recovered mission wrapper with an explicit
  StaticLoadObject service, then canonical BindConversations/Purge. Typed
  ConListItems pass through fresh allocation, the original constructor contract,
  and scalar release through Core lifecycle services. Full original wrapper,
  list and item-constructor/deleting bodies have focused native comparisons.
  Training verifies the two instructor bindings, owner counts and index release.
  An oracle audit corrected1001e1cc to its original zero-filled empty TCHAR;
  literal text `None` is not an empty name. Live Play loader/registry bootstrap
  and normal conversation/window startup remain open. See
  [mission wrapper](script-conversation-wrapper.md),
  [native list](script-native-conversation-list.md), and
  [item construction](script-conversation-construction.md).

- **Inherited DataLinkPlay startup (2026-09-12).** The shared Spawn route now
  accepts the exact DataLinkPlay→ConPlayBase→Actor chain, with mutable
  UClass.Bind constructor propagation verified against original Core.dll.
  The focused fixture executes the original Actor startup and player
  StartDataLinkTransmission through Spawn, SetConversation, native event
  binding and the authored busy-conversation return. UI/history/audio remains
  unbound. The shared suite passed436 tests and the local build passed before
  the subsequent empty-name oracle correction; focused original comparisons
  check that correction separately. See [actor construction](script-scripted-actor-construction.md)
  and [class binding](script-class-bind.md).
- **Original conversation start boundary (2026-09-12).** Shared natives
  2052/2053 now traverse the canonical event chain with exact Speech/End
  dispatch and an explicit GObjObjects provider. The adapter retains the
  caller's typed fixed-array lvalue, correcting lost ConActorsBound writes.
  Original ConPlayBase.StartConversation succeeds in the Mission00 fixture,
  including bound actor, distance, mission, radius and start-flag checks.
  Native2054 preserves bound actor fields, matching the original no-write
  traversal. The normal DataLinkPlay override path and live world/UI startup
  remain open; its busy-conversation return is covered above.
  See [event binding](script-conversation-events.md),
  [speech binding](script-conversation-speech.md) and
  [numeric conversion](script-numeric-conversions.md).
- **Native Sound lifecycle contract (2026-09-12).** The USound constructor,
  serializer and destructor branches now have original instruction contracts
  and focused service translations. FSoundData's retained pointer dispatches
  FArchive.DetachLazyLoader; it is not an audio-device release. Concrete linker
  attachment, allocation and resource lifecycle integration remain incomplete.
  See [construction](script-sound-construction.md) and
  [lifetime](script-sound-lifecycle.md).
  The [generic lazy byte-array Load](script-lazy-byte-array.md) now preserves
  original Tell/Seek/serialize/sign/restore order and has full native body
  comparisons. The Sound helper no longer adds an unconditional byte-count
  copy after its virtual Load; the original Load owns that conditional write.
- **Original DataLink selection and queue (2026-09-12).** Shared VM dispatch
  now connects Extension.StringToName to an explicitly supplied FName service.
  Original GetActiveDataLink passes its null-readiness, case-folding,
  display-once and authored flag-list checks against canonical Conversation
  objects. The original Push/Pop/InsertDataLink bodies preserve the fixed
  eight-slot queue, including mutation before SetConversation's missing-window
  failure. These are controlled logical fixtures, not live native allocation or
  window startup. See [DataLink contract](script-datalink-transmission.md).
- **Native state queries (2026-09-12).** IsInState walks the native state/super
  chain; GetStateName returns the current node name, including a class sentinel.
  Six original Core.dll frame/node cases pass. The original ConPlayBase function
  now reaches its Dying rejection through shared native dispatch. See
  [state queries](script-state-queries.md).
- **Sound resource decoding (2026-09-12).** The shared resource graph decodes
  the two original switch sounds, retains their format FName separately from
  UObject edges, and prepares them from the LightSwitch Frob constants. Native
  lazy ownership and audio remain open. See [Sound payload](script-sound-resource.md).
- **Original trigger actions and Core primitives (2026-09-13).** Orders and
  Flag actions now run through original functions in Play; DamageTrigger's
  native timer reaches the recorded damage-system boundary. Shared VM string
  equality, inequality, concatenation, ASCII-only Caps, NameToString,
  `Chr` native 236 and `ComplementEqual_StrStr` native 124 now follow original
  Core instructions. Chr preserves the original int low-word conversion,
  zero/nonzero FString forms, one-time operand evaluation and two-byte cursor
  advance; its 16-case original-DLL oracle and focused VM/unit validator pass.
  The native 124 oracle covers eight FFrame/appStricmp cases, including
  terminator handling, ASCII case folding and non-ASCII preservation; four
  native Caps-loop cases and three GNames conversion cases also pass, including
  the original DataLinkTrigger.Touch argument conversion. `Divide_IntInt`
  native 145 now preserves signed truncation, the zero-divisor return and the
  original signed-overflow fault. `Object.Log` native 231 preserves argument
  order, the optional `ScriptLog` EName default, `%s` termination and FString
  cleanup through an explicit synchronous output-device service. See [string
  operations](script-string-operations.md), [Core Chr evidence](script-chr.md),
  [native 124 evidence](script-complement-equal.md),
  [integer division](script-divide-int.md) and [Object.Log](script-object-log.md).
  `At_StrStr` native 168 is now registered through the shared string VM path.
  Its original-DLL oracle and validator establish the raw `.data` separator
  TCHAR U+0020, FFrame order/cursor advance and temporary FString result
  ownership. See the [native 168 evidence](script-at-string.md).
- **Loaded conversation property identities (2026-09-12).** `prepareObject`
  loads typed tagged values onto canonical non-Actor exports, using inherited
  defaults and the existing struct decoder. Original Conversation57 and its
  Speech79/End77 chain preserve forward and back references. Native construction,
  state/payload loading and lifecycle flags remain separate boundaries. See
  [loaded properties](script-loaded-objects.md).

- **Typed return-bearing event blocks (2026-09-12).** ProcessEvent now accepts
  an explicit caller result reference. Original Core.dll execution confirms
  `Locals + ReturnValueOffset`, parameter-prefix copyback, and exclusion of an
  owning return string from local destruction. Original ColorTheme.GetThemeName
  bytecode runs through that event entry and preserves its returned string.
  Focused tests also cover early gates and singular suppression.
- **Loaded struct layouts (2026-09-12).** Original UStruct/property Link bodies
  now link original struct metadata for VM strides. Six schema cases match
  original-instruction-derived sizes; inherited Plane/BoundingVolume, packed
  bools and IconInfo[2].Color.R exercise the new integration. Native offsets and
  masks remain separate from logical JavaScript storage.
- **Steady lightmap updates and mesh resources (2026-09-12).** The original
  TriggerLight script tick now drives dependent lightmap refill and atlas
  updates in Play. The installed-map validator observes four off/on/reset syncs
  while retaining the same cached object. LightSwitch's eager LodMesh payload
  is prepared in the canonical resource graph before PlayAnim. Native cache
  branches and full resource ownership remain scoped in their evidence docs.

- **Generic authored struct loading (2026-09-12).** Linked SerializeBin member
  order now loads the original class-default and map struct payloads, including
  canonical object/class references, strings, names, booleans, nested structs
  and fixed dimensions. Every formerly opaque DeusEx class-default struct
  payload (364 entries, 14 types) consumes exactly its recorded bytes. Original
  inventory, UI string/class/key and alliance cases pass, as do Training
  UNATCOTroop2 map imports, Region.Zone identity and untouched inherited array
  entries. The three new boundary tests, 386-test full suite, live Frob validator
  and build pass. See [struct loading](script-struct-values.md). This implements
  logical loaded values, not native raw layout, config/localization resources,
  or dynamic array/map storage.
  The Training/Liberty Island gameplay validator also passes. A single local
  Node 26.8.2 measurement of `createGame` after Training map parsing took
  539 ms, with heap-used delta 159.5 MiB and RSS delta 325.3 MiB (no forced
  GC). It loaded 109 script classes, 35 functions and 7,367 canonical objects.
  These deltas include setup/package work and unreclaimed allocations; they
  are not retained-memory or browser-renderer measurements. No optimization
  was added.

- **VM frame ownership and event-gate correction (2026-09-12).** Original
  CallFunction/ProcessEvent instructions now drive typed temporary destruction.
  Calls copy return and reverse-order out values before destroying all owning
  fields; events copy back parameters and destroy only the local suffix. The
  previous event evidence missed both the nonzero IsPendingKill early return
  and the parameter-prefix destructor skip; those notes and the runtime are
  corrected. Four native wrapper cases match the original, four focused tests
  cover typed/nested ownership, and real ColorTheme setter/getter bytecode
  preserves strings across cleanup. The 383-test suite, original script-runtime
  validator and build pass. See [frame ownership](script-frame-ownership.md).
  This closes the logical string/struct frame cleanup gap, not native heap
  ownership, array/map storage, return-event blocks or the loaded world graph.

- **Property copying, cleanup integration and FString count correction
  (2026-09-12).** The recovered raw copy dispatcher is now the default route
  for inherited owning class-default fields. Its focused comparison matches
  12 Core.dll cases, including forward overlapping copies, live metadata,
  strings, array recursion and inherited struct traversal. The class-default
  property chain now reads each Next after its copy callback. Struct copying
  requires the original inheritance virtual to be explicitly bound.
  `ScriptRuntime.exitProperties` now uses the recovered destruction dispatcher
  for typed owning fields, with a focused keyed-struct integration check that
  preserves ordinary scalar/object members and fixed dimensions. The audit
  also corrected collector/measure FString serialization from capacity to
  used count. Native allocator behavior remains an explicit harness/service
  boundary, and full temporary ownership and class/resource loading remain open.
  Commands for this checkpoint are `node scripts/validate-property-copy.mjs`,
  `node scripts/validate-property-destroy.mjs`, the property copy/destruction/
  serialization, class-registration, tagged-property and lifecycle Node tests,
  and `npm run build`. Verification passed: 12 native copy cases, seven native
  destruction cases, 38 focused Node tests and the build. Original CameraPoint
  construction and cleanup checks also pass. Work remains local and uncommitted.

- **Decoration physics completed; plant pushing moves the plant (2026-09-11).**
  `AActor::physRolling` (Engine.dll `0x103d4b80`) is translated in
  `src/runtime/rolling.mjs` and validated against a new Unicorn oracle,
  `scripts/native-rolling-oracle.py` (`scripts/validate-native-rolling.mjs`,
  **294 cases, bit-exact — `maxError 0`, `TOLERANCE = 0`**, including the wall/slope
  slides and the falling-time refund; `test/rolling.test.mjs`, five checks). The
  friction/fluid x87 store asymmetries (X full-double vs Y/Z stepped, Z
  acceleration extended) were fitted to the original stores. `decoration-physics.mjs`
  now selects `falling()`/`rolling()` by `Physics` and `script-doors.mjs` runs the
  physics phase after each decoration's `ProcessState` and timer phase, using
  `collision.queries` and the per-position zone; `DeusExDecoration.Landed`, the
  inherited `Actor.HitWall`/`Actor.Landed`, the decoration `SetPhysics` native and
  a non-Pawn `processHitWall` gate are bound. Decorations settle to `PHYS_None` at
  load, so a settled Plant7 takes `Bump`'s `SetPhysics(PHYS_Rolling)` branch and
  rolls when pushed. The whole chain is guarded end-to-end in the live Play host by
  `scripts/validate-decoration-settle-roll.mjs` (Plant7 `PHYS_Falling` → `PHYS_None`
  → Bump → `PHYS_Rolling`, then a nonzero horizontal roll). `scripts/validate-plant-push.mjs`,
  the full 353-test suite and the Firefox runtime check pass. See [rolling.md](rolling.md)
  and [script-plant-contact.md](script-plant-contact.md). Not committed.

- **Non-Pawn `processHitWall` recovered and oracle-validated** (2026-09-11):
  the last unvalidated decoration-physics path. Disassembly of `0x103cecc0` shows
  two source branches selected by an inlined `this->IsA(APawn)` (`0x103ced17`);
  both first return for a Pawn wall. The **non-Pawn** branch (`0x103cee37`) skips
  the entire Pawn subtree (zero-accel return, SafeNormal/`MinHitWall` dot gate,
  walking normal/direction flatten, `MoveTimer=-1`/`bFromWall`) and is only
  `if IsProbing(HitWall) dispatch HitWall(normal,wall)` with the normal
  unmodified. Added `processDecorationHitWall` (`walking-callbacks.mjs`); the
  walking-callbacks oracle/validator gained a non-Pawn source (self-contained
  class with null SuperField) — now **102 cases, zero mismatches** (54 Pawn + 48
  non-Pawn sweeping wall/probe/Physics/normal). `script-doors.mjs` now wires
  `onHitWall` to it with the runtime's live `isProbing` (new public
  `ScriptRuntime.isProbing`) and `ProcessEvent`, replacing the ad-hoc branch that
  leaned on `ProcessEvent`'s incidental probe gate; `decoration-physics.mjs`
  decorates the wall actor's `isPawn` and dropped the stale "unvalidated" pause.
  Full suite **354/354**; `validate-plant-push` and `validate-decoration-settle-roll`
  still pass. See [walking-callbacks.md](walking-callbacks.md) and
  [script-plant-contact.md](script-plant-contact.md). Not committed.

- **physRolling `bBounce` branch oracle-validated** (2026-09-11): the last
  unvalidated pure-physics path in decoration physics. Disassembly of physRolling
  shows the wall handler at `0x103d4fd3` tests actor+0x1ec bit0x10 (`bBounce`):
  after the same unconditional `eventHitWall`, it refunds
  `remainingTime += (1-Hit.Time)*timeTick` for the first two bounces and skips the
  slide, dropping straight to the floor probe (`0x103d4fdc-0x103d4ff7`). The
  rolling oracle/validator gained a `bounce` flag and 27 wall-contact cases; the
  corpus is now **321 cases, maxError 0**. The refund's rounding was aligned to the
  native's single float32 store (it was already bit-exact on the sampled cases; the
  real gap was the missing coverage). `bBounce` is caller-selected and reached by
  no training decoration (plants do not bounce); physRolling performs no explicit
  velocity reflection — the bounce velocity is the end-of-tick displacement store.
  Burning (`GotoState('Burning')` → `BeginState` spawns 8 `Fire` actors with
  lights/audio/particles) and carried-decoration (`CarriedDecoration == Self`
  early return, needs the carry system) are the remaining Bump branches; the first
  is a Stage-4 boundary and neither is exercised in training. See
  [rolling.md](rolling.md). Not committed.

- **General scene-event dispatch — router + Frob (item #2, M1 + M2 step 1)**
  (2026-09-11): `scene-events.mjs` was a hand-written matrix that ran real bytecode
  for one case (decoration `Bump`), deferred Trigger Touch/UnTouch, and
  `unsupported()`-paused everything else. **M1** replaced the pause/defer fallback
  with a **general VM router**: `scene-events.mjs` delegates any actor/event outside
  its recovered native-semantics branches (player, TriggerToggle mover,
  Triggers-defer) to a late-bound `hooks.dispatchEvent` (`player-scene.mjs`), wired
  in `game.mjs` to `script-doors.mjs`'s new `dispatchEvent` — resolve the event fn
  via `runtime.lookup`, run it via `runtime.processEvent`; `{handled:false}` = the
  original empty-event no-op, a prepared body that hits an unbuilt native throws the
  original specific pause (boundary moved into the real bytecode). Synchronous (the
  tick dispatches synchronously), so functions are prepared at setup. `bumpDecoration`
  folded in (push-sound timer tracking preserved). `test/scene-events.test.mjs` (4).
  **M2 step 1**: `game.use()` routes a non-mover frob through the router as
  `Frob(player,None)`; a plain decoration runs its real `DeusExDecoration.Frob`
  (empty `Actor.Frob`, `StartConversation` early-false on null `ConListItems`, no
  Event fanout) — `actor.frob`/`deusexplayer.startconversation`/`deusexdecoration.frob`
  prepared in the door host. `scripts/validate-frob.mjs` confirms the plant Frob runs
  and `game.use()` routes it; the mover path is intact.
  **M2 step 2 — LightSwitch → TriggerLights (roadmap item #3, done):** the door host
  now shares a `createScriptLights` controller (`script-doors.mjs`) that advances the
  four TriggerLights into `TriggerToggle` at load and ticks their Alpha; `lightswitch.frob`
  + `actor.trigger` are prepared. Frobbing `LightSwitch0` runs its full override —
  `Super.Frob`'s `AllActors('cratelight')` fanout dispatches `Actor.Trigger` to each
  light's real state Trigger (toggling all four, both directions), the real
  `execPlayAnim` native sets the switch `AnimSequence`; its visual animation is
  Stage 4, while script-controlled light brightness/cache invalidation remains
  Stage 3 and unresolved. `PlaySound(264)` is a recorded Stage-4 audio boundary.
  `scripts/validate-frob.mjs`
  now asserts the full switch→4-light toggle.
  **M3 step 1 — Trigger Touch/UnTouch, record-as-boundary (2026-09-12):** the 25
  training triggers are almost all mission triggers (≈18 DataLink, 4 Orders, Damage,
  Flag) whose Touch reaches unbuilt subsystems; naive routing would pause play. Chosen
  approach (record-as-boundary): route Touch/UnTouch through the router, run real
  gating, and record the unbuilt subsystem effect instead of pausing. Added two
  mechanisms — runtime **`boundaryFunctions`** (a Map of scripted functions the host
  short-circuits with a recorded effect + safe return, parallel to `boundaryNatives`)
  and a **record-as-boundary fallback** in scene-events' trigger branch (an
  unprepared-helper / boundary-native error is recorded as a deferred mission-script
  effect, real errors rethrow). **DataLinkTrigger boundary:** its Touch runs the
  real `EvaluateFlag`, then `StartDataLinkTransmission` through a
  `boundaryFunctions` entry that records the datalink tag and returns `false`.
  At that checkpoint, voice/UI and the native transmission were unsupported.
  This paragraph records the historical false-return checkpoint. The later
  live-lifecycle increment supersedes it for `DL_Start`: script now observes
  the original success and completion branches. Added VM operators `==`/`!=` bool
  (natives 242/243). Datalinks
  override Touch at class level, so no base Trigger state advancement was needed
  for this route; Orders/Damage/Flag defer at `Trigger.IsRelevant` and are the
  next increment.
  `scripts/validate-triggers.mjs`; `test/scene-events.test.mjs` (8). Full suite
  **362/362**; frob/plant-push/settle-roll/gameplay/script-lights green. See
  [scene-events.md](scene-events.md). Not committed.

- **M3 step 2 — base Trigger + VM Switch/ClassIsChildOf (2026-09-12):** base
  `Trigger.Touch` runs its real `IsRelevant` gate and `Event`/`AllActors` →
  `Actor.Trigger` fanout. This needed two general recoveries: the VM **EX_Switch/
  EX_Case** control-flow opcode (0x05/0x0a — `switch(TriggerType)`; previously
  unsupported, blocking every trigger's `IsRelevant`) and the native **`ClassIsChildOf`**
  (258, a pure class-ancestry test, alongside `IsA`). Base `Trigger.Touch`/`IsRelevant`/
  `UnTouch` prepared; base Trigger.Touch is class-level so **no state advancement was
  needed** (my earlier assumption was wrong). Training's only base `Trigger0` is
  `TT_ClassProximity` for `Carcass` (opens its body doors when a corpse touches), so
  the player is a real no-op — no more false "mission script" deferral; the carcass
  fanout is unexercised in the training start (no carcass). `scripts/validate-triggers.mjs`
  now asserts the switch across two TriggerTypes + ClassIsChildOf gating. Full suite
  **362/362**; all validators green. **M3 next:** Orders/Damage/Flag subsystems (their
  `IsRelevant` now passes; they defer at their subsystem action). See
  [scene-events.md](scene-events.md). Not committed.

- **Conversation binding (ConBindEvents) implemented** (2026-09-11): the
  DeusEx conversation model was recovered from `DeusExConText.u` — a per-mission
  `ConversationList` → `ConItem` linked list → `Conversation` with `conName`,
  `conOwnerName` (the bind key) and `bInvoke*` flags. `ConBindEvents` (native
  2101 on DeusExDecoration, 2100 on DeusExPlayer, run in `PostPostBeginPlay`)
  links a `ConListItem` onto every actor whose `BindName` equals a conversation's
  `conOwnerName`; invoke/bark filtering is all downstream in `StartConversation`.
  `src/runtime/script-conversation-binding.mjs` + `ScriptRuntime.prepareConversations`
  / `bindConversationEvents` (invokeNative 2100/2101) implement it;
  `scripts/validate-conversation-binding.mjs` validates against real Mission00
  data and in the Play host (full suite 338/338). **Key finding:** training uses
  `ConList_Mission00` (470 conversations); the only training bindings are the two
  UNATCO instructors (`UNATCOTroop0/3`, `BindName MunitionsTrooper`) →
  `MunitionsTrooperFrob`/`Take`. **Every decoration binds nothing**, so the
  LightSwitch's `StartConversation → None` is correct original behavior, not a gap
  — conversation binding was never a LightSwitch blocker. A **live capture**
  (`tools/dump-conlist-win.c`, reading `Actor.ConListItems` at +0x2dc) confirmed
  the rule, the +0x2dc offset, and the **prepend order** (bound order is the
  reverse of mission-list order: Frob then Take) — the code was corrected to
  match, and UNATCOTroop1/2 bind None as expected. Open: non-training
  mission-number derivation; see
  [script-conversation-binding.md](script-conversation-binding.md).
  Nothing committed.
- **Global UObject index recovered by live capture** (2026-09-11): the retail
  game's `GObjObjects` registry was read out of the running process under
  CrossOver/Wine (`tools/dump-gobjects-win.c`, a sibling Win32 process using
  `ReadProcessMemory`; parsed by `scripts/original-gobjects.mjs`). This supplies
  the true global index of any object directly and reproducibly — the training
  `LightSwitch0` actor is **34242** — and it **disproves the `N0 + exportIndex`
  model**: the global index is the recursive `CreateExport` construction order,
  so a map package's exports interleave with class members and imported
  resources rather than forming a contiguous block (see
  [boot-replay.md](boot-replay.md)). The ~29-minute static `N0` emulation is
  superseded. `ScriptRuntime.registerGlobalObjectIndex` records the measured
  index and `soundField('ObjectIndex')` returns it (the channel-id formula is
  validated in `test/script-sound.test.mjs`). Nothing committed.
- **General object-index model** (2026-09-11, "Plan B"): generalises the single
  measured index into an index provider that also covers objects the load-time
  capture cannot — runtime spawns. A capture-backed provider on `ScriptRuntime`
  (`setOriginalObjectIndex`, from `scripts/original-gobjects.mjs`) resolves any
  pre-placed object's slot by `(class, name)`, never guessing (an ambiguous key
  yields null); `soundField('ObjectIndex')` consults it, so no per-actor
  `registerGlobalObjectIndex` is needed. Runtime spawns take the slot the
  recovered Core `AddObject` rule assigns from the measured registry state:
  `seedScriptObjectRegistry({count, freeIndices})` seeds the high-water mark and
  freed slots, then `ScriptObjectRegistry.add` reuses the last freed slot LIFO
  else appends. The `00_Training` capture is itself a valid state of that model
  (count **42167**, one freed slot **42156**, runtime-spawn tail `GC*`/
  `AIReceiverEvent*`/`UNATCOTroopCarcass0` at the top). Validated by
  `test/script-object-index.test.mjs` (pure rule) and
  `scripts/validate-object-index-model.mjs` (rule cross-checked against the live
  capture and the PlaySound formula); `scripts/validate-script-lights.mjs` now
  installs the provider instead of a manual registration. Open only as later
  integration: wiring the seeded registry into the live `createGame` spawn path
  (spawns are still gated to CameraPoint) and a shippable load-time index table
  (the `.cache` capture is local evidence). Nothing committed.
- **Native 264 live listener graph wired; LightSwitch.Frob runs end-to-end**
  (2026-09-11): `soundField` maps the host's single `level` container onto the
  original's split identities — `XLevel` = ULevel (`Actors`/`Model`), `Level` =
  `LevelInfo` actor (`level.actors[0]`) with `PawnList`/`NetMode`. With the
  measured index, `scripts/validate-script-lights.mjs` runs the actual
  `LightSwitch.Frob` wrapper to completion: `Super.Frob` + `StartConversation`,
  native 264 `PlaySound('Switch4ClickOn', slot 1)` → channel id **547874**
  (`(34242<<4)+(1<<1)+0`), a full live `PawnList` traversal (JC + intro cameras,
  all out of range at the switch's position), then the wrapper's own
  `PlayAnim('On')`. Full suite 338/338. The remaining boundary on this route is
  **`ClientHearSound`** (native per-listener audible playback, Stage 4), reached
  only when a listener is in range; the traversal, distance/occlusion gates and
  channel id are faithful up to it. Nothing committed.
- **GOTY LodMesh serialization recovered** (2026-09-10): the original
  `ULodMesh::Serialize` was executed against real payloads in the unicorn
  harness (`scripts/native-lodmesh-oracle.py`), establishing the tagged
  prefix, bbox/sphere layout, lazy-array markers and the eager AnimSeq table;
  see [lodmesh-serialization.md](lodmesh-serialization.md). The LightSwitch
  sequence table is decoded (`All`/`Still`/`Off`/`On`, NumFrames 2/1/1/1,
  Rate 30.0), resolving the SurrealEngine-reader mismatch recorded in
  [script-play-anim.md](script-play-anim.md).
- `src/runtime/lodmesh.mjs` decodes the script-visible mesh payload and
  `src/runtime/play-anim.mjs` implements native `execPlayAnim` (259) from the
  transcribed contract (`test/play-anim.test.mjs`, 5 checks). At this intermediate
  point, Play integration of the LightSwitch.Frob route, conversation binding and
  sound integration remained open; the later progress above supersedes that
  status. Nothing committed.
- **PlayAnim wired into the shared script runtime** (2026-09-10, later; intermediate
  status superseded by the later index/binding progress above):
  `ScriptRuntime.invokeNative` handles native `259` — it decodes the
  receiver's `Mesh` payload once per identity (`meshPayload`) and drives
  `execPlayAnim` through `script-anim.mjs`'s view over the linked
  `AnimSequence/AnimFrame/AnimRate/TweenRate/AnimLast` fields. The
  `+0x224` = `AnimMinRate` and `+0x228` = `OldAnimRate` are now bound from the
  original animation-tick body (`0x103a1cd2` clamp read, Actor.uc declaration
  order) and `+0x144` = `Velocity` from docs/camera.md; only the flags word
  stayed on the instance (`animationState`) at that checkpoint. The 2026-09-19
  [animation controls audit](script-animation-controls.md) replaces it with
  linked flags/SimAnim and corrects the original reciprocal arithmetic.
  `scripts/validate-script-lights.mjs` drives
  the real LightSwitch mesh through 259 in the Play host (Off/On/All paths,
  SimAnim tail, mirror copies). At this intermediate point, running the complete
  `LightSwitch.Frob` wrapper still required global object-index assignment and
  post-startup conversation binding; later progress above supplies both.
- **Native 264 (PlaySound) wired** (2026-09-10, later; intermediate status
  superseded by the later listener/index progress above): `invokeNative` routes
  `264` to the translated `execActorPlaySound` with runtime services — typed
  field reads, level native graph (`Model`, null demo driver on the Play level
  object), ancestry `isA`, the enclosing-function flags gate and native event
  dispatch (`processNativeEvent`). The `PawnList` listener path reaches the real
  pawn graph; at that intermediate point the actual `LightSwitch.Frob` wrapper
  still stopped at the documented global-index boundary. The later live index
  and listener progress above supersedes that boundary for the fixture (native
  audible playback remains a separate Stage 4 boundary).
- **Engine boot replay chain recovered** (2026-09-10; historical static-index
  hypothesis superseded by the live capture above): the full
  load chain `DeusEx.exe` → `appInit` → `UEngine::Init` → `UGameEngine::Browse`
  → `LoadMap` → `LoadPackage` → `GetPackageLinker` → `LoadAllObjects` →
  `CreateExport` → `StaticConstructObject` → `AddObject` is transcribed with
  every IAT slot named; see [boot-replay.md](boot-replay.md). Within a map
  load, global UObject indices are assigned in ascending export-table order
  (the loader walks exports 0..N-1; our parser already reproduces that table),
  so a map actor's registry index is `N0 + exportIndex`. `N0` — the boot
  population at LoadMap entry — is the remaining constant; it is recoverable
  statically from DLL static constructors plus boot packages, and the shipped
  engine has no registry-dump console command (UE1's `obj list`/`getall` are
  absent from Core.dll/Engine.dll), so a live measured capture cannot
  substitute for the replay.
- **Boot replay harness runs the native registration** (2026-09-10, this
  round): `scripts/native-boot-replay.py` executes the original DLL bootstrap in
  the Unicorn harness. Each DLL's `_initterm` static array is recovered from
  `_DllMainCRTStartup` → `_CRT_INIT` (Core, Engine, Fire, IpDrv, Extension,
  ConSys; DeusEx statically links its CRT and uses the internal `_initterm` at
  `0x1001bf67`). All eight native DLLs overlap Engine's mapped image, so the
  shared oracle now rebases images with PE `.reloc` fixups
  (`scripts/native-collision-oracle.py`, `Image.rebase`). The harness bootstraps
  a fake `FMalloc`, `GObjObjects`/hash/FName globals, the Win32 heap/critical
  section/locale imports and a no-op `appFailAssert`. All 2,376 initializers
  across nine DLLs (Core, Engine, Window, Fire, IpDrv, Extension, ConSys,
  DeusEx, DeusExText) run with zero failures. Calling `FName::StaticInit`
  (`0x1014bbc0`) as `appInit` does seeds the hardcoded name table (`None` at
  index 0) and makes `ProcessRegistrants` complete: the original constructor/
  queue, `UObject::Register`, `CreatePackage`, `StaticAllocateObject`,
  `AddObject` (`0x10157830`) and `HashObject` assign **298** global
  `GObjObjects` indices deterministically, covering the package objects, every
  native class and its default object. `--json` emits the index→name table.
  `UObject::LoadConfig`/`LoadLocalized` are stubbed with their correct thiscall
  returns as an explicit index-recovery boundary. See
  [boot-replay.md](boot-replay.md). **The exact order is not yet the original
  one:** the exe statically imports only Window/Core/Engine, and the game DLLs
  load per-package from `UObject::BindPackage` (`0x10152ff0`), called at the end
  of the `UPackage` constructor, which runs `appGetDllHandle` and then
  `ProcessRegistrants`. So indices are package-driven. The package-loader replay
  now works (`--package-load`, with `--packages=`, `--budget=`,
  `--package-budget=`, `--out=`, `--json`): only Core/Engine/Window preload;
  `appGetDllHandle` loads DLLs on demand; `appFindPackageFile` resolves files; a
  fake `FFileManager`/`FArchive` serves bytes (the linker opens through vtable
  `+0x00`); `UObject::StaticInit` creates the transient package; and the
  `CreateExport` flag mask at `linker+0xa0` needs `GIsClient`/`GIsServer` set
  (all-zero skipped every export). `LoadPackage(Core)` walks 699 exports and
  `LoadPackage(Engine)` 5622, giving **6356** deterministic indices; the table
  is saved to the ignored `.cache/boot-replay-core-engine.json`. Ranged
  `UC_HOOK_CODE` hooks now work (the earlier attempt mis-passed the range into
  `user_data`), doubling speed, but `Core,Engine,DeusEx` still exceeds a
  ~29-minute bounded run: the remaining cost is raw linker emulation, not hook
  overhead. Since the user can run the original game, the preferred path for the
  actual `N0`/indices is a live registry capture:
  `tools/dump-gobjects.py` reads `GObjObjects`/`GNames` from the running process
  (recovered `Core.dll` offsets) and prints `slot index Class.Name`; the
  `LightSwitch0` index is the value the sound native needs. The harness tables
  stay as an order/cross-check reference. See [boot-replay.md](boot-replay.md).
## Historical research recovered at the original stop

These notes record the 2026-09-10 state and preserve investigation anchors.
Later progress above supersedes the status of animation, conversation binding and
global object identity. The corrected lighting evidence is in
[script-light-cache.md](script-light-cache.md). Do not read the historical status sentences below as the current
checkpoint.

- **Animation (historical status superseded by the PlayAnim work above):** Engine.dll PlayAnim259 thunk `103011b8`, body `103e0160`.
  Defaults Rate=1, TweenTime=-1; Actor.Mesh `+174`; sequence lookup virtual
  `+68`. GetAnimSeq bodies `1031c000`/`1031c050` scan mesh `+84` data, `+88`
  count, stride `20` hex, matching FName at entry+0. Animation stores include
  Actor `+54/+58/+5c/+60`, `+220/+224/+228`, and SimAnim `+22c..+23c`.
  DeusExDeco.LightSwitch is LodMesh export606, 1,272 bytes. At the original
  stop, serialized sequence decoding and native implementation remained
  unfinished; the later PlayAnim implementation is recorded above.
- **Conversation binding (historical status superseded by the binding work above):** DeusEx.dll ConBindEvents2101 body `1000ea50`,
  wrapper `1000e9d0`. It finds the first DeusExLevelInfo in Level.Actors,
  derives the conversation package/mission path (default training path
  `DeusExConText.ConList_Mission00`), loads DConversationList, then calls
  ConSys BindConversations `10010b70`. Purge `10010cf0` precedes binding;
  DConListItem links into actor+`2dc`, conversation ownerRefCount at+`74`.
  Training list exists with 470 entries. Agent reported empty switch binding
  names and zero matches; at the original stop this was not an
  implemented/validated startup path. The later binding implementation and its
  no-match LightSwitch result are recorded above. Do not replace StartConversation
  with unconditional false.
- **Surface cache (historical status updated):** Render.dll SetupForSurf `10b06c90` reaches
  FLightInfo::ComputeFromActor `10b05fa0`, which reads live brightness at `10b060b3`.
  Cache gates `10b0645e` and `10b06994` test actor flags+28 mask `400`
  (bLightChanged). Training lights are excluded from SetupDynamics without
  bDynamicLight (`800`). TriggerLight.Tick writes brightness directly;
  the bLightChanged setter/clear were not established. The resumed native trace
  recovered first-cache color-header comparison after live brightness multiplies
  RGB at `10b0612f–148`, and the steady brightness-only host refill is now
  connected and checked against original Render.dll branches. Other changes remain
  unsupported; arbitrary invalidation is not established by that route.

## Verification already performed

- Current checkpoint: `npm test` passes all 486 tests and `npm run build`
  succeeds. The Training catalog, live walking route, all-route/queue lifecycle,
  complete InfoLink shell, ComputerWindow, Show/IsVisible, surface setters and
  recursive Window destruction focused validators all pass. The original-DLL
  string oracle also covers nine native `Left` and eight native `Right` cases,
  and the live route checks
  that installed SetSpeaker assigns the canonical Jaime Reyes Texture object.
- `node scripts/validate-conversation-transfer-object-bind.mjs` passed the
  installed package/DLL class, property, vtable, body and import checks, all ten
  shipped DataLink references, and the `DL_Rooftops` native2053 JCDenton bind.
- `node --test test/script-sound.test.mjs` passed the focused sound ordering,
  live listener/default reads, ViewTarget and occlusion checks.
- `node --test test/fast-line-check.test.mjs` passed. Its plane/flag and
  two-node slab reference results were first obtained from the original DLL
  through the existing NativeCollision emulator.
- `node scripts/validate-script-lights.mjs` passes against the actual createGame
  host, including the preserved 1,337-entry map prefix, appended player subsystem
  actors, canonical resources, four-light fanout, original brightness/corona
  changes, reversal and reset. Recovered Training conversation binding leaves the
  LightSwitch conversation list null.
- Earlier focused object identity, VM conversion and atlas-update checks passed;
  training doors still opened/reset and Liberty Island spawned/landed. The last
  production build passed before the latest standalone sound/BSP additions.
- No additional visual gate or full-suite rerun is needed merely to resume.

Original binaries/assets remain ignored in `Deus Ex GOTY Edition`. Existing
disassemblies: `.cache/reference/Engine.asm`, `.cache/reference/Render.asm`,
`.cache/research/Core.asm`. Native probes use
`.cache/native-probe-env/bin/python` and `scripts/native-collision-oracle.py`.
Start with the documented gaps above instead of repeating completed research.
