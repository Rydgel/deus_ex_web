# Runtime roadmap

Target: original Deus Ex game data running locally in a desktop browser. Preserve
the original levels and behavior as the project progresses. Begin with keyboard
and mouse; mobile support is undecided.

Delivery stays local unless the user requests hosting.

Build an independent browser reimplementation by reverse-engineering the original
game's data formats, script bytecode, and native behavior. The original game is
the compatibility authority. SurrealEngine and other public sources can inform
research, but this project does not depend on their runtime or feature coverage.
Implement missing systems here rather than waiting for another engine to support them.

The fidelity target is **100% of original behavior** within each claimed support
scope. Use original evidence for every behavior; do not substitute invented
lookalikes. A working prototype or passing internal tests does not establish
compatibility. Unverified differences remain open work.

For every next subsystem, research the original before implementing it: identify
the responsible data, script and native routines; record constants, state changes,
call order and unknowns; establish original reference cases; then translate and
validate the behavior before connecting it to Play mode. Behavior without enough
original evidence stays explicitly unsupported. Audit existing prototypes as
their subsystems are addressed.

The first completion target is the original single-player campaign. Multiplayer,
mod compatibility, mobile/controller support, and hosting are separate later scope
decisions; they are not implied by campaign completion.

## 0. Obtain and validate data

Read an installed game directory. Validate all package tables, hash the inputs,
and resolve cross-package object references. Detect missing packages, unsupported
versions, and case differences in Windows filenames explicitly.

Done when `00_Training.dx`, its dependencies, and `DeusEx.u` parse from real data
and the inventory has no unexplained failures. **Complete:** the extracted
installation supplies 219 readable packages (215 at version 68, four at version
61), with no unresolved package dependencies. Data stays in the ignored
`Deus Ex GOTY Edition/` directory.

## 1. Render an original map

Decode tagged object properties, BSP nodes/surfaces/vertices, actor transforms,
texture palettes/mip levels, and basic surface flags. Define and test coordinate,
winding, unit, and UV conversions. Choose a browser renderer after measuring the
decoded geometry. Keep decoding separate from rendering.

Done when the browser renders recognizably correct training-map geometry and
textures from original packages, with an inspection camera and useful diagnostics.
This is a map viewer, before gameplay.

**Complete:** the browser renders original training geometry with 70 textures,
24,427 triangles, and 25 static doors/movers, with no render errors. Drag or
pointer-lock camera controls, map selection, wireframe, actor markers, surface
inspection, and diagnostics work. Local folder selection also works in the
production build without uploading game data. All 23 unit/format tests and five
browser tests pass. The [rendering contract](rendering.md) records conventions,
evidence, and limits. Stage 1 used flat inspection lighting; Stage 1.5 adds static
lighting and the required class defaults. Procedural water is static, with no actor
meshes or gameplay. Unknown level tails and property types remain explicitly opaque.
All 88 compiled world models decode, but
visual acceptance currently covers training.

## 1.5. Restore original lighting

**Complete for training's static lighting.** The independent implementation reads
inherited light defaults, original shadow masks and mover polygon lightmaps, and
applies the colour, falloff and brightness behavior checked in the original DLLs.
Training has 5,212 prepared lightmaps, 16,088 shadow masks, zero missing lightmaps
and zero render errors. Two cameras use coordinates read from original save states;
the main shadow patterns and coloured areas match native captures. Six sampled
wall/ceiling/door regions differ by less than three mean RGB levels per channel.
Display brightness is separate from light intensity; an unlit inspection toggle
and explicit unsupported-effect notes remain available. See [lighting evidence](lighting.md).

Reconstruct static surface lighting using the original lightmap metadata, shadow
data, light properties, and any required class defaults. Apply light colour,
brightness, radius, zone ambient light, and relevant surface flags. Retain an
unlit inspection toggle to compare geometry and textures independently of lighting.

Done when fixed-camera views of training reproduce the original game's main
light/shadow patterns, coloured illumination, and dark areas, checked against
reference views from the original game. Unlit surfaces should retain their intended
appearance, and missing lighting support must remain visible in diagnostics.

Script-controlled lights belong with behavior in Stage 3; moving-actor lighting
and remaining dynamic lighting effects belong with the broader renderer in Stage 4.

## 2. Make a small playable slice

**Playable slice delivered; remaining acceptance deferred at the user's request.**
Play connects original CheckBob bytecode,
source-ordered crouch/jump controls, camera math, dry walking/falling/landing,
stairs, actor collision/point recovery, relocation, and cached target selection.
The selected Training door pair uses original state timing, interpolation,
encroachment/player pushing and completion callbacks. JC shares the scene actor
hash and original motion flags; the scene has a reproducible original RNG stream.

Combined physics matches 10 original sequences, 63 frames and 2,547 ordered
queries. Nine composed moving-door scenes match exactly. The source-ordered input
and camera comparison adds five sequences/27 frames and 27 original native eye
expressions. These counts cover their documented boundaries, not whole-game
fidelity. Final original visual/motion comparison and real window/tab pause
acceptance remain tracked, but no longer hold up Stage 3.
See [movement evidence](movement.md). JavaScript remains the implementation;
performance work is limited to basic playability.

Add pointer-lock input, a fixed simulation step, first-person movement, player
spawn handling, gravity, jumping, crouching, stair stepping, and BSP collision.
Add actor collision and traces needed by the selected interaction. Implement one door or pickup using
the actual map's properties. Use training to constrain the first behavior subset;
use Liberty Island as the next integration map.

Done when a player spawns in the original training map, walks without passing
through ordinary floors/walls, and performs the selected interaction. Browser
reload should reproduce the same initial state.

Before broad gameplay implementation, prototype the script/native execution path
described in Stage 3 to validate our runtime design against original behavior.

## 3. Execute game behavior

**Complete (2026-09-27).** The adopted gate passes with only printed Stage 6
tolerances; see [Stage 3 close](stage-3-exit-criteria.md#stage-3-close). The
September 10 handoff and September 20 completion audit are historical
checkpoints.

**Beyond Training (2026-09-28).** The same standard now covers every
single-player map: the all-maps startup census reports 83/83 maps
[Stage 3 complete](stage-3-exit-criteria.md#stage-3-beyond-training-the-all-maps-startup-census).
Each map's original startup, Login, ticking and Player-start reload reach only
boundaries classified as Stage 4, 5 or 6.

**Gate (adopted 2026-09-25):** Stage 3 is done when
`scripts/validate-stage3-training-conformance.mjs` passes — Training's startup,
ticking and every probed interaction on original bytecode with no boundary
outside the named Stage 6 ones. See [Stage 3 exit criteria](stage-3-exit-criteria.md)
for the criteria and the current scoreboard.

Batch 3 A admits all 312 original map exports to LoadMap startup, including
Mission00 spawning and PickupDistributor's key distribution/self-destruction.
Movers reuse the recovered brush move service; TriggerLight startup is shared.
The struct-bool preparation boundary is closed. Batch 3 B supplies real
GameInfo/InitGame, and batch 3 C adds original player Login and startup.
Batch 4 covers fire/lifecycle and window interaction; batch 5 runs the original
world scheduler, actor cleanup and DataLinkPlay lifecycle. Batch 6 replaces the
controlled-player port and host highlight, and walks the authored route from
PlayerStart1 to `DL_part2` on public input.


**Implementation history.** Extend the existing bounded VM to execute original functions
and state bytecode, starting with class/property metadata and the selected
mover's script path. Use focused source/native and integration checks; visual
comparison is not an acceptance gate for nonvisual runtime logic.

The linked VM now executes original training-door functions and state bytecode
in Play, including event entry, reversal and completion. Class inheritance,
typed property/parameter storage, state transitions and the selected latent/native
path are implemented. Original automatic state selection and Core execution-frame
initialization are translated, with CameraPoint startup state selection checked
against its original bytecode. Ownership and destruction now use the recovered
event/cleanup order with explicit native world and object bindings; original
CameraPoint metadata is covered by a focused lifecycle check. Fresh object
construction now has source-backed naming, template copying, registration and
the concrete CameraPoint native constructor. The scoped Spawn binding now runs
CameraPoint construction, original startup/relevance scripts, zone assignment
and automatic state selection, preserving the native callback/Tag order. Broader
actor spawning, native resource classes, complete garbage-collection integration, native coverage and the
remaining required systems below are still open; see [runtime scope](script-runtime.md).
Core marking/purge orchestration and deferred actor-reference cleanup now follow
the recovered native order. Typed reference traversal and CameraPoint final
release/index reuse have focused source-backed coverage. Complete world/resource
serialization and broader native release bindings remain explicit integration work.
Actor/UObject collector serialization now connects to live script storage,
including active CameraPoint state/code references. FName marking, deletion and
index reuse are connected through the typed GC bridge; native class/resource
loading and their complete serializer graph are still required for live-world GC.
Class/state/property metadata and bytecode-reference serializers now follow
the recovered native order. GC updates now reach live bytecode operand storage.
Tagged-default traversal and its native measuring archive are translated, with
an original Owner field connected to live default storage and the collector.
Complete typed class layout and complex-property virtual bindings are still
required for the full graph.
Native UObject registration, UStruct/UClass construction and UClass's default-object
initialization now have source-backed translations. UField/UStruct registration
and real object lookup are connected to the shared host. The constructor, registration
and serializer adapters share mutable native class fields. Registration now
connects to the recovered UClass::Link layer and existing-package construction.
The recovered UStruct/UState linkers and net-field sort are connected. Original
Core.Object registration now executes through the real constructor, registry,
default initialization, all three link layers and config/localization gates.
Scalar property linking supplies the recovered size/alignment behavior for
Byte/Int/Float/Name/Object/Class fields through the actual struct linker.
All six complex property Link bodies are now translated: UBoolProperty packs
bools, UStrProperty/UArrayProperty/UMapProperty set their container sizes
(0xc/0xc/0x14) and the need-destruction bit, UFixedArrayProperty multiplies
Inner by its count and copies the Inner's destruction bit, and
UStructProperty uses the inner struct's PropertiesSize, the recovered
size-based alignment rule and the inner destroy-chain head. The property-link
dispatcher routes every property class to its verified body, so mixed
scalar/bool/string/array/struct layouts link through the recovered native
bodies. Config/localization resource services and the live loaded graph remain
required; the scoped adapters do not yet complete native class loading.
The five complex property Identical value virtuals (Str/Array/FixedArray/Map/
Struct) are translated from the original Core.dll and routed by the tagged
property walker's +0x6c comparison, so identical complex defaults are skipped
without a tag. The complex SerializeItem virtuals
(Str/Array/FixedArray/Struct/Map/Bool) are translated and emulator-verified for
the collector/measure path, including the FString ArrayNum code-unit count, the
one-byte bool write, fixed-array stride recursion and inherited struct member
traversal. FString and dynamic-array `SerializeItem` also cover original save
and load directions, including CompactIndex encoding, archive flags,
reallocation and recursive element mutation through explicit services. Raw
CopySingleValue/CopyCompleteValue bodies are now translated and routed by
native property class, and class-default initialization uses the dispatcher
for its inherited owning fields. Native heap resolution/reallocation remain
explicit services; logical VM frame ownership and the full resource graph are
not established by this integration. The recovered DestroyValue bodies now
dispatch strings, arrays, fixed arrays and linked struct members; the logical
`ScriptRuntime.exitProperties` route uses them for its supported owning fields.
Raw heap cleanup still requires explicit allocator/reference services. Dynamic
array/map temporary ownership, full archive composition and config/localization
resource services remain open. Owning FString/struct call and event
temporaries now follow recovered return/out-copy/destruction order. Generic
authored structs decode all 364 previously opaque DeusEx defaults and obtain
their array strides from recovered UStruct/property Link bodies.
The Play script host now preserves the full serialized map actor array, including
non-colliding actors and null slots, with canonical references and typed authored
properties. Training's four TriggerLights can be found through native AllActors;
their player interaction now runs end-to-end in Play (item #3): the door host shares
a `createScriptLights` controller that advances them into `TriggerToggle` and ticks
them, and frobbing `LightSwitch0` runs its full `Frob` — the `cratelight` AllActors
fanout dispatches `Actor.Trigger` to each light's real state Trigger, toggling all
four (`scripts/validate-frob.mjs`, docs/scene-events.md). Their steady brightness
changes now refill dependent lightmaps after script ticks and update existing
atlas tiles. Native ComputeFromActor multiplies live brightness into RGB before
comparing its cached color header, rebuilding when a component differs. This
decision is checked by executing the original Render.dll instructions. General
dirty-flag setter/clear and non-brightness changes remain open. See
[light cache](script-light-cache.md). Switch mesh rendering belongs to Stage 4.
The original PlaySound dispatch and hearing gates are translated, including
the separate BSP FastLineCheck used for sound obstruction. The emitter's global
UObject index — the channel-id input — is now supplied from a measured live
capture of the running game's registry (`LightSwitch0` = 34242;
[boot-replay.md](boot-replay.md)), which also disproves the earlier
`N0 + exportIndex` model in favour of the recursive construction order. This is
generalised beyond one actor: a capture-backed provider resolves any pre-placed
object's slot by `(class, name)`, and runtime spawns (absent from the load-time
capture) take the slot the recovered `AddObject` rule assigns from the measured
registry state — the seeded append + LIFO free-list model, cross-checked against
the capture (count 42167, one freed slot, runtime-spawn tail) in
`test/script-object-index.test.mjs` and `scripts/validate-object-index-model.mjs`.
The live listener graph is now wired (`XLevel` ULevel / `Level` LevelInfo / `PawnList`), so
`LightSwitch.Frob` runs end-to-end in `scripts/validate-script-lights.mjs`
(`Super.Frob` → `PlaySound` channel id 547874 → live PawnList traversal →
`PlayAnim('On')`). The remaining boundary is the native `ClientHearSound` audible
playback (Stage 4); this does not yet add audible switch or plant sounds in Play.
The [native coverage inventory](script-coverage.md) tracks engine, game, UI and
conversation declarations separately from implemented call paths.
Conversation binding now runs through `ConBindEvents` (native 2101/2100), which links each
actor's mission conversations by `BindName` ↔ `conOwnerName`
([script-conversation-binding.md](script-conversation-binding.md)). In training
only the two UNATCO instructors bind (their `MunitionsTrooper` conversations);
decorations bind nothing, so the LightSwitch's `StartConversation → None` is
correct. Shared native 2052/2053 event dispatch has exact binders for Speech,
Animation/Trade, MoveCamera, CheckObject, TransferObject, and thirteen inherited
event classes. CheckObject's two authored references execute their installed
Inventory/NanoKey predicates and both next/fail actions. TransferObject preserves
the recovered from/to bark/normal comparisons and class-load order. Exactly ten
shipped DataLinks contain its one-count DataVaultImage delivery; `DL_Rooftops`
event export 7448 now runs through native 2053, binds JCDenton as `toActor`,
and loads canonical class `Image02_NYC_Warehouse`. See
[the TransferObject evidence](script-conversation-transfer-object-bind.md).
The TransferObject action now completes for that admitted route: source-backed
`Image02_NYC_Warehouse` construction inherits Engine.AInventory's native
constructor through the recovered `UClass::Bind` copy, and
`ConPlayBase.SetupEventTransferObject` runs Spawn, `DataVaultImage.SpawnCopy`
over `Inventory.SpawnCopy`, `GiveTo`/`BecomeItem`, `DeusExPlayer.AddInventory`,
`GotoState('Idle2')`, `DeusExPlayer.AddImage` and one recorded
`HUDReceivedDisplay.AddItem` before returning `EA_NextEvent`. This is the first
collision-carrying `ULevel::SpawnActor` subclass: its pre-startup hash gate,
the Deus Ex `PreBeginPlay` fake shrink, a live `CheckEncroachment`, the
`DataVaultImage.Pickup` auto-state entry and the deferred `FindBase` tail are
asserted as one observed sequence, and the abstract parent is refused by the
prologue gate. See [the DataVaultImage route](script-datavault-image.md).
Admission no longer names a class key. The recovered
`ULinkerLoad::CreateExport` (`0x1012e230`) supplies native metaclass class
loading: a null `ClassIndex` selects the hard-coded `Core.Class` identity, so a
class export is constructed through the metaclass, `SuperField` is installed
from the export's `SuperIndex`, and `UClass::Bind` copies the nearest native
`ClassConstructor` down the chain. All nine shipped DataLink image classes are
built from the real `DeusEx.u` export table through that branch, and the
general `ULevel::SpawnActor` constructs them through the AInventory
ClassConstructor `UClass::Bind` copied down, so the eight beyond
`Image02_NYC_Warehouse` run the same live transfer route without being named in
the runtime. See [the CreateExport body](script-create-export.md). The body ends
at `Bind` and leaves `RF_NeedLoad` set, as the original does: serializing a
constructed export's own bytes through the linker archive is still open, and
imports resolve to prebound identities. Native conversation audio mixing and
final UI rendering belong to Stage 4.

The latest scene-event increment routes Trigger Touch/UnTouch through the VM
and implements base Trigger relevance via Switch/Case and ClassIsChildOf.
Original Orders/Flag actions now run in Play; DamageTrigger schedules and
advances its original timer through the prepared Training Radiation10 chain:
`TakeDamage`, damage display/reduction, poison clearing, percentage update and
body-health recomputation. Core natives 144, 145, 169, 185, 210, 213 and 223 match
focused original DLL cases for integer overflow/division, the zero-divisor guard,
float32 rounding, strict approximate comparison, unordered values, vectors and
out-lvalues. The [Divide_IntInt evidence](script-divide-int.md) records native
145's signed-overflow exception boundary. The earlier null
`AugmentationSystem` was caused by the browser skipping the player's standalone
startup lifecycle. The live path now creates `AugmentationManager1`; unowned
`AugEnviro` leaves Radiation10 at `adjustedDamage=10`/false before execution
reaches the prepared `PlayDXTakeDamageHit`, `PlayHit`, and
`Human.PlayTakeHitSound` bodies. The live path writes `HealthLegLeft=90` and
`Health=98`, and native PlayAnim 259 stores the canonical `GM_Trench`
`HitLegLeft` state (`frame=-4`, `rate=2.5`, `tween=0.4f`, `last=-3`) after the
original optional-argument hole is honored. Execution then stops at the exact
`Actor.PlaySound(264)` audio boundary from `Human.PlayTakeHitSound`; subsequent
AI event dispatch, other damage branches, audible playback, presentation and
flag expiration remain open.
All 18 DataLink routes authored by Training now resolve canonical Mission00
Conversation/Speech/End objects and exact audio. The first transmission executes
installed player selection, DataLinkPlay Spawn, SetConversation/SetTrigger,
ConPlayBase start/termination and trigger completion. The live HUD reference is
published, played flags are set, and one-shot triggers leave collision. The
source-translated playback schedule calls prepared HUD operations on a complete
six-control shell. Its direct Speech-to-End transition now executes installed
`PlayNextEvent`/`ProcessAction`, prepared `PlayEvent.SetupEvent`, inherited
`SetupEventEnd`, and `EA_End` termination. End-of-transmission runs the original HUD destroy body and
recursive Window removal; queued and reset paths construct a distinct shell,
with queue selection still owned by original `PopDataLink`. The shipped
`DL_Rooftops` TransferObject actor/class bind is also admitted, and its
DataVaultImage inventory action now runs end to end — as do the other nine
shipped references, whose eight further image classes reach the runtime through
the recovered `CreateExport` metaclass branch rather than by name. Broader
ConEvent actions, final native rendering, and native audio mixing remain
explicit gaps. See
[the live lifecycle](script-datalink-live.md),
[TransferObject binding](script-conversation-transfer-object-bind.md), and
[scene events](scene-events.md).

Plant/decorative-object collisions now push the plant in Play: a player bump
runs the inherited `DeusExDecoration.Bump`, and the decoration's recovered
non-Pawn physics (`physFalling` and `physRolling`, [rolling.md](rolling.md))
advances it. Decorations settle to `PHYS_None` at load, so a settled plant takes
the `SetPhysics(PHYS_Rolling)` branch and rolls when pushed; a falling wall
contact uses the recovered non-Pawn `processHitWall` gate. Audible playback and
AI propagation remain Stage-4 boundaries, and whole-scene rolling acceptance is
not yet claimed. The
[plant contact trace](script-plant-contact.md) identifies the original pushable
defaults, script dependencies and required actor physics. A pushed decoration
also reads the pushing player's Microfibral Muscle level through the installed
`AugmentationManager.GetClassLevel`, which the live `AugmentationManager1`
startup made reachable; that body is now prepared, so a bump no longer pauses
Play once the player owns an augmentation system.

Live actor destruction is now wired. The recovered `ULevel::DestroyActor`
order runs against the real Play world: Training's `OrdersTrigger2.Touch`
destroys its one-shot trigger through the host eligibility gate, Core
`UObject::Modify`, the `Destroyed` event, `EndTouch(other, 1)` on the touching
player, `FCollisionHash::RemoveActor`, the saved `Level.Actors` slot,
`bDeleteMe`, both Core object-flag transitions and the deferred-deletion chain.
Before this, walking past the first Training door paused Play at
`DestroyActor requires validate`, and a paused session ignored every later
input — which is what made the door appear to stop responding after the second
DataLink. `CleanupDestroyed`, native subclass destructors, resource release and
the map package's `ULinkerLoad`/`UPackage` identities remain explicit
boundaries, and Pawn, Mover, based-child and networked targets stay refused.
See [live-world Actor.Destroy](script-world-destroy.md).

Build our own UnrealScript VM and implementations of the native engine and Deus Ex
functions it calls. Analyze original package bytecode, class data, and native code
or observed game behavior as needed. Prototype one representative script/class/native
call path, compare it with the original, and measure memory and loading cost before
expanding coverage. This stage extends our browser runtime; it does not port or
wrap SurrealEngine.

Required systems include class inheritance, default properties, states, events,
timers, latent functions, garbage collection, and native function dispatch.
Resolve imported objects, instantiate native actor/resource types, and implement
object spawning/destruction, references, execution order, and serialization hooks.
Track native calls across the game's engine, UI/extension, and game packages;
package availability alone does not establish native compatibility.
Include script-controlled light switches and lighting changes in behavior coverage.
Deus Ex-specific conversation and UI classes need explicit coverage. Package
script bytecode alone does not replace behavior implemented by the native DLLs.

Done when a documented subset of original game classes executes and its behavior
is compared with the original game. A handwritten door demo alone is not evidence
of general script compatibility.

## 4. Restore the remaining presentation

Decode and render original character, weapon, and prop meshes, skins, animation
sequences, sprites, attachments, and the first-person weapon view. Restore animated
and procedural textures, water/fire effects, particles, decals, sky/fog, mirrors
and other required surface effects, including the polished training floor's
reflection. Extend lighting to moving actors and dynamic
effects; compare colours, brightness, and transparency with the original renderer.

Decode sound and music resources and implement positional effects, ambient sound,
speech, and music transitions. Restore fonts, menus, HUD, inventory and conversation
screens, subtitles, readable books/datacubes, and computer/security interfaces.
Respect available text/localization resources and expose audio, display, and input
settings. Implement these pieces alongside the runtime calls and gameplay that use them.

Done when representative scenes reproduce the original animated actors, effects,
sound, text, and interfaces, including synchronized speech and conversation camera
behavior where used. A feature being decoded is not evidence that it renders or plays correctly.

## 5. Implement the full gameplay systems

Expand movement and world simulation to swimming, ladders, water/damage zones,
movable objects, moving doors and elevators, and their collision/trigger behavior.
Implement AI navigation, sight/hearing, stealth, alert states, factions, and security
cameras/turrets/alarms. Connect perception to actual light and sound behavior.

Implement weapons, projectiles, damage/body health, death, inventory/equipment,
consumables, skills, augmentations/energy, lockpicking, electronics, and computer
hacking. Support dialogue choices, trading, objectives, notes, mission flags, and
scripted/cinematic events using original game data and behavior.

Done when training and Liberty Island support representative combat, stealth,
exploration, conversation, and alternate-route objectives, with the systems
interacting correctly. Extend the same compatibility checks as later missions
exercise additional behavior; a single successful route does not cover a mission.

## 6. Persist progress and complete the campaign

Implement game saves, quicksave/load, map transitions, and restoration of previously
visited maps. Persist the player, inventory, skills/augmentations, mission flags,
actors, and object references consistently. Store progress locally in the browser,
with save export/import, format versioning, and clear storage failure handling.
Compatibility with original desktop save files is a separate decision.

Done when reloads and return visits preserve expected world state, and the campaign
can be completed through representative choices and endings without progression
blockers. Validate each mission's conversations, events, and transitions against
the original game; keep a per-mission compatibility checklist.

## 7. Make the browser runtime reliable

Measure loading time, frame time, memory, and audio latency throughout development.
The current real-Play frame account and plan is [frame cost](play-frame-cost.md).
Add visibility/culling, batching, caching, and asset lifetime management where
measurements justify them. Validate supported desktop browsers, graphics capability
errors, resize/fullscreen, pointer-lock loss, pause/tab suspension, audio activation,
local file access, and persistent storage behavior.

Done when declared browser/performance targets pass repeatable tests, long sessions
and repeated map changes remain stable, and failures offer useful recovery paths.
Retain automated format/runtime tests and fixed-camera visual comparisons throughout
the earlier stages; this milestone closes coverage gaps rather than postponing testing.

## Architecture constraints

- Keep game assets outside source control and let users supply their local data.
- Keep an explicit support matrix for package/resource types, native functions,
  gameplay systems, maps, and browsers. Report unsupported behavior in diagnostics.
- Validate each milestone against original-game reference captures and behavior;
  preserve hashes and reproducible camera/input sequences for regression checks.
- Keep binary decoding independent of rendering and DOM code; the initial reader
  already shares one implementation between Node and browser APIs.
- Prefer a narrow, testable slice of original behavior before broad approximations.
- Keep asset loading asynchronous and design for browser memory limits.
- Record package versions, hashes, and external source revisions so failures can
  be reproduced against the same input.
- Keep external engine code as attributed research material rather than a required
  runtime. Public implementations are evidence to check against the original game,
  not a limit on our compatibility targets.
- WebAssembly may be considered for parts of our implementation if measurements
  justify it. That is an implementation choice, not a switch to another game engine
  or an assumption that the Windows binaries can compile to the web.
  The [GetFrame vertex kernel](lodmesh-wasm.md) is the first measured Rust/Wasm
  component. Gameplay and runtime control flow remain JavaScript; changes to
  the kernel's operations also require updating and validating its JS fallback.
