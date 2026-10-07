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

**In progress.** Restored so far, each with its evidence below: original
mesh lighting (CPU kernels and an exact GPU path), static and animated light
maps, moving lights on light maps, BSP occlusion (OccludeBsp, the master
frame, dynamics, the moving brush tracker and child frames in the Rust core), mirrors on every static and mover plane
with nesting, Fire.dll fire and water textures, animated and auto-panned
surfaces, particles and sprites, light coronas, laser beams, volumetric fog
on BSP and mover surfaces, ambient sound, script sounds, sound effects and zone reverb
through Galaxy's mixer, Galaxy music, decals (movers included), and the third-person
conversation camera with lip sync. The render pass's translations run at its
24-bit precision ([render-pass precision](render-pass-precision.md)).
Twenty-six maps match the original's own frames at matched cameras and level time (122 of 130 views)
([visual acceptance](visual-acceptance.md)).
Open: child frames' own fog maps, per-fragment fog maps on movers, time-varying moving lights and spotlights, UnrealScript inside
the render events at 24 bits (the script VM computes at 64), the darkest-pixel
rounding visual acceptance found, and acceptance of live (unfrozen) scenes.
SpriteAnimOnce frames and animated mesh skins
are recovered or checked but unreachable: no shipped class, map actor or
script uses DT_SpriteAnimOnce or gives an actor an animated texture
([particles](particles.md#dt_spriteanimonce-0x10b252ac0x10b25392-restored-at-0x10b254d3),
[texture animation](texture-animation.md#play)). Full Stage 4 acceptance
remains open. Frame cost and
the Rust-core ports that keep these effects inside the frame budget are in
[play frame cost](play-frame-cost.md).

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

**Moving lights on light maps (2026-09-28).** Render.dll's SetupDynamics,
FDynamicLight::Filter, AddLight and the NonIncidence path are translated and
match the original on Training's BSP (square-root table, all radii, FGetHSV,
438 filtered surfaces, 72,255 texels). AugLight lights Training's dark room in
Play. Steady ordinary moving lights now use the original integer pipeline too:
4,096 table entries, 37,763 reference texels and 11 live camera-light lightmaps
match their documented original-code comparisons. Spotlights, other light
effects, the live renderer's FPU control word and original-game visual
acceptance remain open; see [ordinary moving lights](moving-normal-lighting.md)
and [moving lights](dynamic-lighting.md).

**Mesh lighting (2026-09-28).** NPCs, props and the first-person weapon are
lit by the recovered Render.dll FLightManager path (SetupForActor/Light) and
D3DDrv's diffuse conversion: 0 diffuse bytes differ from the native oracle
and on live Play inputs. PF_Modulated fragments emit pow(2·src, g)/2, the
exact equivalent of the display ramp after the D3D DESTCOLOR/SRCCOLOR blend,
which removed the bright band of the masked-out character glasses. See
[mesh lighting](mesh-lighting.md).

**GPU mesh path (2026-10-01).** GetFrame interpolation and DrawLodMesh
lighting run as WebGL2 passes by default. They are bit-exact with the CPU
kernels on Training and Island (every position component, every drawn
corner's colour byte, environment normals and UVs, visibility), using a
barrier against ANGLE/Metal's fast-math contraction; `?gpuMesh=0` keeps the
CPU reference and software WebGL keeps the CPU path. See [GPU mesh](gpu-mesh.md).

**Third-person conversations and lip sync (2026-10-01).** MeetPaul plays
through the original CreateConCamera, letterbox raw background, behind-view
player, gestures and the 3D view clip ([conversation camera](conversation-camera.md)).
Galaxy.dll's speech analysis runs in the Rust core, bit-exact with the DLL on
its inputs, and drives Pawn.nextPhoneme ([lip sync](lip-sync.md)); the
decoded speech and mixer position are host measurements.

**Training mirror floors (2026-09-28).** The 46 authored mirror surfaces at four
heights render reflected world/actor views, clipped at the original plane, with
the original translucent screen blend and depth writes. Twelve frame/clip cases
and the D3D blend-state trace match original DLL execution. The saved entrance
floor comparison has mean absolute RGB error 3.33/255, with existing lightmap
and mesh differences still explicit. Recursive mirrors, other orientations and
material modes, and mirror/sky combinations remain outside this slice. See
[mirror evidence](mirror-surfaces.md).

**All static mirrors (2026-10-02).** Every static mirrored BSP surface in the
maps renders: 211 surfaces on 80 node planes, including wall, ceiling and
oblique mirrors. Each surface is grouped by its node plane. All 252 frame cases
match the original instructions. The post-child branch, also executed from the
original, makes opaque mirrors PF_Invisible, so only the reflection shows;
ShinySurfaces at +0x5c is confirmed from the retail property registration.
Mover mirrors (13 brushes) follow their brush, with the plane
host-computed from the tracker polygon. Mirror/sky combinations remain an
explicit gap.

**Mirror seam, player and nesting (2026-10-02).** The child target's scissor
is its own, in target pixels, over the mirrored columns; the screen-space
scissor had left a seam between two viewpoints on Everett's and the 747's
mirrors. Child frames draw the player, as Render.dll passes no excluded
actor when Frame->Parent is set (0x10b1a161), and native captures show JC in
Everett's mirror. Nesting follows OccludeBsp's Recursion < 3 (0x10b18881):
children render before their parent and odd depths flip submission.
Everett's facing mirrors match the native captures. See
[mirror surfaces](mirror-surfaces.md).

**Conversations on every map (2026-10-02).** `census-map-startup --groups
converse` starts up to ten conversations per map and plays each to its end.
The families it found are closed with original evidence:
- the FOV tangent (Core appTan, [x87 tan](x87-tan.md));
- rotating and multi-key movers ([doors](doors.md#physmovingbrush));
- InterpolationPoint paths ([pathing](pathing.md));
- a destroyed mover's FarMoveActor
  ([check-encroachment](check-encroachment.md#moving-brush-source));
- CleanupDestroyed's reference pass ([script-cleanup](script-cleanup.md#play-wiring));
- a transfer object naming a missing class
  ([transfer bind](script-conversation-transfer-object-bind.md)).

All 83 maps are now Stage 3 complete, 77 of them clean. The rest stop only at
Stage 5 AI navigation natives (518, 523) and the ReachablePathnodes iterator.

**Ambient sound (2026-10-02).** Galaxy's PlaySound, StopSound, StopSoundId,
NoteDestroy and Update are oracle-exact ([galaxy audio](galaxy-audio.md)).
That covers channel stealing, priorities, the ambient scan and refresh,
listener-space pan, distance and occlusion factors, the volume ratios,
Doppler and the 2D voice calls. Every pre-placed actor now has its measured
GObjObjects index ([object-index captures](object-index-captures.md)). Play
runs Update after each frame, and the browser plays the ambient voices
through Web Audio with each WAV's own loop. The volume and pan law there is
a host mapping; Galaxy's mixer is not translated. Script PlaySound now runs
the original execPlaySound, ProcessEvent's ProcessRemoteFunction gate and
APawn::execClientHearSound into Galaxy for every emitter with a measured
index, the player included; StopSound runs execStopSound
([galaxy audio](galaxy-audio.md#play)). Runtime spawns keep the recorded
channel-0 boundary until the seeded spawn registry gives them original
indices. Music, zone reverb and the lip-sync branch of Update remain.

**Animated textures (2026-10-02).** BSP surfaces with AnimNext chains
(screens, LED pads, flashing lights) now advance through Engine.dll's
UTexture Get, Update, Tick and ConstantTimeTick, oracle-exact over 309
fabricated chains, with PostLoad's start state and UViewport::Lock's clock
([texture animation](texture-animation.md)). Without recovered BSP occlusion
every animated texture advances each frame, not only the drawn ones.
Auto-panned surfaces (skies, 39 in 36 maps) follow Render.dll's pan formula,
bit-exact over 400 cases, with the viewer-side zone's speeds and
Level.TimeSeconds. Animated mesh skins remain.

**Fire textures (2026-10-02).** Fire.dll's UFireTexture is translated whole
and byte-exact against the DLL ([fire textures](fire-texture.md)): every
spark type, DrawFlashRamp, both self-modifying fire updates, the shared
generator, the module tables and the load state (824 oracle cases). Laser
spots and beams, flames and the nano and biocell glows render as live mesh
skins in Play. The shared generator's draw order and seed are host choices;
sprites (and so sprite fires, smoke and sparks) are not drawn yet.

**Water textures (2026-10-02).** Fire.dll's water family is translated and
oracle-exact: CalculateWater, the 20 drop types, and the WetTexture
constructor, PostLoad and tick. Drtywater on Island's and Training's BSP
water is live ([fire textures](fire-texture.md#wet-textures)).

**Static light maps (2026-10-02).** BSP and brush light maps now come from
Render.dll's own static path ([static lighting](static-lighting.md)): the
shadow blur table and illumination, the zone ambient, the normal,
NonIncidence, spot and cylinder bodies and the colour merge. That is
oracle-exact for 15,745 light steps on every Training surface, plus
samples on Island and NYC Street. Surfaces lit by Cylinder, TorchWaver or
FireWaver lights (34 maps) are no longer dropped. Training's entrance
moved closer to the original-game capture in every compared region (worst
2.78 → 1.26 mean RGB levels). A surface without a texture draws the level's
DefaultTexture as Render.dll does, and a singular light-map basis takes the
original's non-finite texel grid (NYC Street, the Hotel, the Intro, the Free
Clinic).

**Animated lights (2026-10-02).** The light manager's per-frame noise, the
LightType functions (pulse, blink, flicker, strobe, subtle pulse) and the
merge's TorchWaver, FireWaver and WateryShimmer modulation are translated
(`validate-light-animation`: 240 noise frames, 1,280 LightType frames, 3,600
merged texels against the original). In Play, class 1 lights whose type or
merge varies stay out of the static light map; their light maps re-merge
each drawn frame with Level.TimeSeconds. The appFrand stream and Flicker's
per-light key are host choices, noted. Moving lights' own time variation is
still a steady snapshot.

**Movers from their brush polygons (2026-10-02).** As Engine's brush tracker
does (0x1037b5c0), each mover polygon draws as a level surface whose light
map is its iBrushPoly; this replaced a heuristic that refused 74 of 159
movers on four maps. UNATCO HQ, the Ship, Catacombs, Battery Park, Area 51
Bunker, OceanLab and Island draw every mover.

**Particles and sprites (2026-10-02).** DeusEx's ParticleIterator runs in
Play ([particles](particles.md)):
- native 3017 is oracle-exact over 288 updates;
- the renderer's RenderIterator protocol builds the iterator;
- CurrentItem moves the proxy through the particles;
- every admitted sprite actor draws, with Render.dll's sprite size, style
  and ScaleGlow, and its LastRenderTime feedback.

Street steam now rises from the vents. SpriteAnimOnce frames remain.

**Light coronas (2026-10-02).** DrawFrame's corona pass is translated
(oracle-exact over 200 frames: fade, visibility helper, DrawIcon arguments).
Play runs it each frame over the player leaf's lights with the translated
SingleLineCheck, and draws translucent screen tiles. Airfield and Battery
Park street lamps glow. See [coronas](coronas.md).

**Volumetric fog (2026-10-02).** Render.dll's fog maps are translated:
ComputeFromActor's volumetric constants and SetupForSurf's fog loop are
oracle-exact over 10,687 texels, and the loop runs in the Rust core. Play
draws the D3D PF_Highlighted pass (ONE/INVSRCALPHA) on fog-zone surfaces
each frame; 02_NYC_Bar's smoke haze renders. FLightManager::Fog, the mesh
vertex fog under PF_RenderFog, is translated and oracle-exact over 1,440
vertices but not yet applied to mesh rendering. The Rust fog loop keeps the
exact x87 answer through a certain-rounding fast path (0 differences over
45 million texel-lights from Play, 17–21× faster). Mesh and mover fog in
Play, animated volumetric brightness and the upload scale's evidence remain.
See [volumetric fog](volumetric-fog.md).

**Laser beams (2026-10-02).** LaserTrigger and BeamTrigger beams draw through
the original LaserIterator: CurrentItem is translated on the x87 model and
matches the original over 5,348 items, random beams included. DX's
FDynamicSprite snapshots each item, and DrawActorSprite swaps that snapshot
into the actor around DrawMesh. Play mirrors this with one LaserProxy
preview per segment. The Island doorway beams render. See [lasers](lasers.md).

**BSP occlusion (2026-10-04).** Render.dll's OccludeBsp, ClipBspSurf, span
buffers and BoundVisible run in the Rust core at the render pass's 24-bit
precision, bit-exact over 144 frames on four maps; the master frame and the
dynamics (sprite chunks, Filter, PreRender) are bit-exact too. Play draws
the visible world polygons, requested mirrors, sky and fog surfaces from it
instead of frustum culling (the Paris club tunnel went from 15 to 59 fps).
Each actor's Setup rectangle, child frames and the moving brush tracker
remain ([BSP occlusion](bsp-occlusion.md#what-is-left)).

**Decals and fog on movers (2026-10-07).** With the brush tracker,
movers' polygons are level surfaces whose Actor is the Mover.
- **Decals.** AttachDecal's trace and FindSurface run over the tracked
  model, so a bullet hole can land on a door. Its Mover branch copies
  MoverRotation and bases the decal on its Owner (SetBase(Owner, 1)). This
  is bit-equal to Engine.dll over 65 scenarios with 11 mover attaches.
  ClipDecal turns the decal by Rotation − MoverRotation, bit-equal over 107
  Render.dll cases.
- **Decals in Play.** The decal model follows the tracker. A BulletHole
  spawned on a Training door stays on the door's plane when the door is
  raised and turned.
- **Fog.** Drawn mover polygons in a fog zone get fog maps over their
  tracker surface's lattice. On 02_NYC_Bar, a door's fog map equals
  Render.dll's loop.

Open: a mover polygon draws one fog map, where the original draws one per
fragment. Script traces in Play still use the static model (Stage 5).
([decals](decals.md#movers), [volumetric fog](volumetric-fog.md#play)).

**Occlusion child frames (2026-10-07).** OccludeBsp's mirror and sky
requests make child frames, through Render.dll's CreateChildFrame (merging,
24-bit ComputeRenderSize, mirror and sky coordinates). OccludeFrame then
runs each child's SetupDynamics and OccludeBsp, newest first, depth first.
This runs in the Rust core and is bit-equal to the original over 172 child
frames on seven maps: mover mirrors, sky inside mirrors and recursion up to
3. Play draws every mirror and sky pass from its own frame: its visible
polygons, its mover fragments, and its Frame->Sprite, which it draws and
stamps (the player shows in mirrors). Mirrors now reflect the sky through
openings (Training's floor, 02_NYC_Smug's window). `?childFrames=off`
keeps the frustum passes ([BSP occlusion](bsp-occlusion.md#child-frames)).

**Moving brush tracker (2026-10-06).** Engine's FMovingBrushTracker runs in
the Rust core, bit-equal to the original over 239 oracle steps on five maps
(construction, Update, Flush, SurfIsDynamic and destruction). OccludeBsp
over the models it builds matches the original with Engine's SurfIsDynamic
on four maps. In Play each admitted mover is updated before the main
frame's OccludeBsp and drawn from the draw lists, so closed doors occlude
what lies behind them (Island's UNATCO HQ doors: 24 nodes drawn instead of
149). The pixels are unchanged, and mover mirrors are requested through
their polygons. Tracked movers are not stamped, as in the original, where
only DrawActorSprite stamps. Collision (Stage 5) and SaveGame (Stage 6)
remain; fog and decals on movers followed on 2026-10-07 (above)
([brush tracker](brush-tracker.md)).

**Galaxy music (2026-10-06).** Each map plays its song. Galaxy.dll's IT
loader, sequencer (238 cases, 1.83 million ticks), SSE mixer and
conversion, and Update's music section (718 oracle cases) are translated
and bit-equal with the DLL. The library runs in Rust inside an
AudioWorklet that the simulation worker feeds over a MessageChannel, so
music costs the main thread nothing per frame. Sound effects and zone
reverb followed the same day (below) ([Galaxy music](galaxy-music.md)).

**Decals (2026-10-06).** Shadow blobs under pawns draw in Play, and blood
pools, scorch marks and bullet holes will when combat spawns them.
Engine.dll's AttachDecal and DetachDecal (the trace, the surface finder,
the FDecal quad and Nodes, the MultiDecalLevel grid with non-coplanar
neighbours) and Render.dll's ClipDecal run in the Rust core, bit-equal to
the original (49 attach scenarios on each of Training and Island; 655
ClipDecal cases on three maps). The decal block stamps LastRenderedTime,
which DeusExDecal's lifetime reads, and the page draws the fragments with
D3D's modulated state; mirrors show none, as in the original. Mover
surfaces are not wired to the brush tracker's surfaces yet ([decals](decals.md)).

**Mesh fog (2026-10-06).** DrawLodMesh computes each vertex's volumetric
fog, but D3DDrv uses it only when UseVertexFog is set, which no shipped INI
does, so the shipped D3D configuration draws meshes unfogged, as Play does;
Glide's fog pass and UseVertexFog are unsupported options. Movers take the
fog-map pass on the brush tracker's surfaces, still to wire ([volumetric fog](volumetric-fog.md#mesh-fog)).

**Time-varying spatial lights (2026-10-06).** Render.dll's spatially dynamic
light effects now run in the Rust core: Searchlight, Rotor, SlowWave,
FastWave, Shock, Disco, Interference and CloudCast, plus Shell. They run at
the render pass's 24-bit precision, with Core appAtan2's FPATAN measured on
x87 hardware.
- *Evidence.* All 8 Searchlight, 8 Rotor, 5 Disco, 5 SlowWave and 1
  FastWave lights of the 83 maps match the original bodies: 3,082 cases,
  377,732 texels, 286,158 measured-FPATAN products.
- *Play.* The bodies rerun inside the light-map merge for each new
  Level.TimeSeconds, from a per-texel cache. Animated light maps now merge
  only for the surfaces OccludeBsp draws. The Paris club's dance floor and
  the Wan Chai garage searchlights animate, at about 0.8 ms per frame on
  the Linux host.
- *Moving lights.* The grenades' Shell ExplosionLight lights moving
  light maps with the original body.
- *Precision.* ComputeFromActor's rr2 and incidence are taken at 24 bits
  for these lights. The rest of the static path is still modelled at 64
  bits: incidence differs in 875 of 3,952 Training light steps and 13 of
  1.9 million texels, and the init-time tables' precision is unmeasured.
  See [static lighting](static-lighting.md#spatially-dynamic-effects).

**Time-varying moving lights (2026-10-07).** Moving (AddLight class 2)
lights now take the original per-frame path: GlobalLighting's LightType
function, the effect row's spatial body (normal, spot, NonIncidence,
Shell) with the unshadowed illumination, and the merge's waver modulation
from index 0. The float reconstruction is gone.
- *Reach.* `scripts/census-moving-lights.mjs` over the class defaults, the
  83 maps and the packages' scripts: BarrelFire and burning Fire
  (FireWaver), BarrelAmbrosia, BarrelVirus and the Dragon's Tooth
  (WateryShimmer), lit Flares (TorchWaver), AlarmLights (Spotlight, Strobe
  in Endgame 4) and one Flicker LaserTrigger. The other types and effects
  are not reached by class 2 and are documented as such.
- *Random stream.* PreRender's light noise now draws from the game's
  shared appFrand stream in the simulation, at its place in the frame; the
  page's light frame (class 1 animation too) takes its tables.
- *Evidence.* A `movingFrames` oracle runs the class 2 chain at 0x007f:
  2,448 contributions and 1,592 composed light maps over 8 frames match
  (validate-moving-light-effects), and in worker-mode Play the BarrelFire
  light maps around Island's BarrelFire3 match each frame's own inputs.
- *Cost.* Island 3.03 → 3.55 ms of page time per frame, Catacombs Tunnels
  (76 fires) 2.78 → 3.96 ms; the per-texel part is 0.18 ms of it, so it stays
  in JavaScript ([moving lights](dynamic-lighting.md#time-varying-moving-lights-2026-10-06)).
- *Mesh lighting.* SetupForActor's LineCheck now sees the movers the brush
  tracker put into the BSP, as Engine's UModel::LineCheck does (366 checks
  against the original under Unicorn). Helibase's helicopter is lit red by
  TriggerLight4 alone, and the 747's RepairBot loses Light10, as in the
  original's frames ([mesh lighting](mesh-lighting.md)).

**Sound effects and zone reverb through Galaxy's mixer (2026-10-06).**
Ambient sounds and script PlaySound now play through Galaxy's own voices
and mixer, in the music worklet, instead of the Web Audio mapping
(`?sfx=webaudio` keeps that for A/B).
- *Translated.* Galaxy.dll's glxLoadSample (the WAV loader),
  glxStartSample, glxControlSample, glxControlVoice and glxStopSample, in
  Rust ([effects](galaxy-music/effects.md)). Also the effects reverb: Update's
  zone block, glxSetSampleReverb, its x87 setup and its SSE kernel
  ([reverb](galaxy-music/reverb.md)). UseReverb is installed True; 21 zones
  in 16 maps reverb, e.g. Brooklyn Bridge Station.
- *Evidence.*
  - The sample entries match the DLL under Unicorn: all 549 shipped WAVs
    load identically, and 25 cases (556 voice calls, 1,134 callbacks)
    match in both buses' PCM.
  - The reverb setup was run natively on this host's x87 for every
    reachable CutoffHz. FCOS is not correctly rounded at 5,820 of the
    44,101 inputs, but the stored coefficients equal the model's at all of
    them.
  - 414 whole parameter blocks match, and so do 264 native SSE kernel
    calls.
- *Play.* The simulation worker sends Update's sample ops to the worklet
  in batches, and the worklet reports back which voices are still active.
  Island plays its six ambient voices with no underrun.
- *Cost.* On Island, in worker mode, with 3 interleaved pairs:
  - main thread 3.31 against 3.26 ms per frame, the Galaxy Update 0.86
    against 0.77 ms;
  - the worklet's 20 ms render is 135 µs median (p99 244 µs) with music
    and six effect voices, and 143 µs with reverb on.
- *Not covered.* The MP3 effect Menu_SpeechTest stays silent, and speech
  keeps its own transport. The ring heads' spacing and the game thread's
  x87 control word are unmeasured.

**Visual acceptance against the original (2026-10-06).**
`scripts/visual-acceptance.mjs` takes matched-camera raw frames on both
sides: the original DeusEx.exe under Wine (its own Shot bitmaps) and Play in
worker mode.
- *Same inputs.* Both run `ghost` and `ShowHud False`, then set Location and
  ViewRotation. Play runs them through the original console chain, which
  now imports bool parameters (Core `0x10166380`), and CheatFlying's
  AutonomousPhysics (native 3971, `0x103c8f30`) is translated.
- *Frozen levels.* Both freeze the level from its first tick with
  bPlayersOnly. The original reloads a revisited map from its travel state,
  so that state is moved aside first.
- *Results.* All 70 views of 14 maps line up in geometry, lighting, meshes,
  coronas, mirrors, fog and skies, with a uniform 1.13–1.41× raw brightness
  gap under Wine.
- *Pixel centres.* The original's 3D image sat half a pixel right of and
  below Play's: FX15's +0.5, D3DDrv's −0.5 and D3D's integer pixel centres.
  Play's camera now carries that offset, and the residual shift is (0, 0).
  This also removed a 1-pixel line on a masked sky polygon's wrap seam
  (Island).
- *Left.* The darkest pixels: raw 1 in the original, 0 in Play.
`tools/dump-actor-win.c` reads live actor fields from the running original.
See [visual acceptance](visual-acceptance.md).

**Persona list screens (2026-10-07).** Extension.dll's ListWindow family is
now admitted in Play's window host:
- construction, the lifecycle, all 69 natives (1720–1812), preferred
  size, Draw at the render pass's precision, mouse, keys and tick;
- the scrollbar draw for overflowing lists (XScaleWindow::Draw).

280 of 280 oracle cases are identical, and 19 deliberate mutations are
caught. The Conversations, Images and Logs screens open, draw and close in
Play, and `scripts/census-ui-screens.mjs` passes 11 of 11 player screens on
Training and Island. The Load/Save Game screens stop at the save-game
directory (native 3013, Stage 6). See
[ListWindow family](script-window-list-family.md).

**Mesh distance LOD (2026-10-07).** DrawLodMesh's LOD now runs in Play on
both mesh paths: the requested vertex count from distance, FOV, frame width,
DrawScale and LODBias, GetFrame at that count, the vertex morph toward the
collapse targets, FaceLevel admission, the wedge collapse and the
interpolated U/V bytes, with the normals, lighting and draw over the reduced
faces.
- *Evidence.* Re-derived from Render.dll at the render pass's 24 bits: the
  morph gate is byte +48 bit 0, appTan's extended FPTAN result is stored once
  as a float (a real-x87 probe under Wine confirms the model on 208,181
  FOVs), and URender::Init's 0.25/1/1/1 are the shipped settings. 228 oracle
  cases over six meshes are bit-equal for the JavaScript reference and the
  Rust kernel; at 0x037f the oracle differs in 665 checks.
- *Play.* `validate-lodmesh-lod-play` checks every drawn binding's selection,
  flags, start, admitted faces and vertices against the original ranges in
  worker mode (Island: 108 drawn rows, 59 morphing, 8 below ModelVerts, on
  both paths); the GPU morph and corner passes are bit-equal with the CPU
  path in `validate-gpu-mesh` (201 LOD captures, 96 with dropped faces). GPU
  time per frame 2.02 → 2.05 ms on Island (A/B). `?meshLod=off` draws full
  detail.
- *Left.* The morph rounds in Play's world space (the original's GetFrame
  output is camera space), a child frame whose own selection would draw
  differently is drawn with the main frame's (counted; none in the checked
  Training and Paris Club mirror views), and the particle and wire branches
  are not ported. See
  [LOD](script-lodmesh-lod.md).

**Typed characters (2026-10-07).** The `WM_CHAR` route is recovered and
wired: WinDrv's window procedure, XGameEngineExt::Key, UEngine::Key
(Console.KeyType), XInputExt::Key, XRootWindow::Key/HandleKeyboard and the
KeyPressed bodies with Alt accelerators. 15 oracle cases (81 steps) are
identical and 12 mutations are caught. Play types into the Say line, Goals
notes, the New Game name and a computer login, and reaches list hot keys
and accelerators. See [typed characters](script-window-typed-keys.md).

## 5. Implement the full gameplay systems

Expand movement and world simulation to swimming, ladders, water/damage zones,
movable objects, moving doors and elevators, and their collision/trigger behavior.
Implement AI navigation, sight/hearing, stealth, alert states, factions, and security
cameras/turrets/alarms. Connect perception to actual light and sound behavior.

Implement weapons, projectiles, damage/body health, death, inventory/equipment,
consumables, skills, augmentations/energy, lockpicking, electronics, and computer
hacking. Support dialogue choices, trading, objectives, notes, mission flags, and
scripted/cinematic events using original game data and behavior.

**Open Liberty Island blockers, bypassed only for performance runs.** UNATCO
Island reaches unimplemented original paths after Player start, and Play
pauses there by design. `bench-sim --bypass`, `profile-play-browser --bypass`
and local timing copies rewrite listed ones into early returns
(`scripts/bench-sim-hooks.mjs`). That rewrite is NOT original behavior: frames
after it are only a timing workload. Each bypass patch is removed when its
behavior lands; since native 708 (item 4) the list is empty, and the
forward-walk workload runs unbypassed to MeetPaul's first choice at tick 4720
(78.7 s, item 6).

1. ~~**Swimming.**~~ Done ([swimming](swimming.md)): startSwimming
   `0x103d2b70`, physSwimming `0x103d3cd0`, Swim `0x103d3850` and
   findWaterLine `0x103d3b10` are bit-exact against Engine.dll in
   `validate-native-swimming` (1093 cases, maxError 0, every instruction of the
   four bodies executed). The physWalking (`0x103cb3fd`, `0x103cb6d9`,
   `0x103cb97d`) and physFalling (`0x103d1cb6`) hand-offs are covered too.
   `validate-island-swimming` shows the fish GeneratorScouts running
   physSwimming in Play. The Island bench digest changed to `babe023941d42a3c`
   (JS and Rust VM agree at all 30 checkpoints). It is now `6a178ec7baf98078`:
   the pawn view's Touching identity fix changed only `OfficeChair0.Touching`
   from checkpoint 280 on
   ([pawn view identity](script-map-actor-move.md#pawn-view-identity)).
   Swimming was never the first
   boundary: in the forward-walk workload, the first GeneratePawn (tick 153)
   sets a scout to PHYS_Swimming and then reaches item 2 in the same call. The
   `performPhysics` default rewrite is no longer reached in either map's bench
   run. Falling *through* water (physFalling's water-zone integration
   `0x103d125a` and PlayerPawn foot-water `0x103d1039`) became an explicit
   boundary for pawns instead of a silent dry integration, and is now
   translated for every actor kind (item 5).
2. ~~**aiPickSearch's waterMove service**~~ Done
   ([pawn navigation](script-pawn-nav.md#swimming-contract-recovered-2026-09-29--swimreachable--swimmove)):
   `APawn::swimMove` `0x103c3ca0` and `APawn::swimReachable` `0x103c15a0`
   are ported and wired into aiPickSearch mode 3, the reach dispatcher,
   flyReachable and walkReach. `validate-pawn-swimming-reach` passes 360/360
   original-DLL cases (0 mismatches, 9/9 mutants) with every instruction of
   both bodies executed. Without any bypass the fish scouts' 20
   AIPickRandomDestination calls all find water destinations and their
   generators spawn 20 fish that swim. bench-sim's waterMove and
   `performPhysics` default patches are removed (both maps report `errors {}`
   without them; Training stays `04f77dc631509ae4`). The Island bench digest
   is now `340b445c6e983b80`, JS and Rust VMs equal at all 30 checkpoints; it
   first differs from `6a178ec7baf98078` at checkpoint 10 (tick 160), where
   the tick-153/155 GeneratePawn calls have spawned Fish0 and Fish1 (first
   differing field in digest order `LevelInfo0.PawnList`). Re-inserting the old
   waterMove early return on the new source reproduces `6a178ec7baf98078`
   exactly.
3. ~~**jumpArc `0x103c2f50`**~~ Done
   ([pawn navigation](script-pawn-nav.md#jumping-contract-recovered-2026-09-29--findbestjump--suggestjumpvelocity--jumplanding)):
   the body is `APawn::FindBestJump`, with `APawn::SuggestJumpVelocity`
   `0x103c2c80` and `APawn::jumpLanding` `0x103c2530`; all three are ported
   and walkReach's −1 path calls them. `validate-pawn-jump-reach` passes
   363/363 original-DLL cases (0 mismatches, 23/23 mutants) with every
   instruction of the three bodies executed. In unbypassed Play PaulDenton0's
   tick-1221 `ActorReachable(player)` now completes: the jump off the ledge
   lands in the bay, swimReachable cannot climb out toward the player, the
   verdict is false, and `GetNextWaypoint` takes FindPathToward's
   `PatrolPoint17` in the same tick (`validate-island-jump-reach`). The
   360-tick bench workload never reaches it: both maps' digests are unchanged
   (Training `04f77dc631509ae4`, Island `340b445c6e983b80`, JS and Rust equal
   at all 30 checkpoints, `errors {}`).
4. ~~**Native 708, `AIDirectionReachable`**~~ Done
   ([pawn navigation](script-pawn-nav.md#aidirectionreachable-native-708--execaidirectionreachable-0x103c8560)):
   the exec `0x103c8560` evaluates `(vector focus, int yaw, int pitch, float
   minDist, float maxDist, out vector bestDest)`, resolves `bestDest` through
   GPropAddr, and calls `APawn::AIDirectionReachable` `0x103c78a0` — the band
   search 709 already uses — with a literal 15.0f the body never reads, then
   stores the verdict dword. `validate-pawn-direction-reach` passes 285/285
   original-DLL cases through both the translated exec and Play's VM binding
   (0 mismatches, 8/8 mutants), executing every reachable instruction of the
   exec (111/111) and the band search (405/405). In unbypassed Play the
   former boundary at tick 1375 (PaulDenton0's `GetNextVector` after
   `ActorReachable(player)`) finds a step, and all eight GetNextVector calls
   through tick 1810 succeed as Paul follows the player
   (`validate-island-jump-reach`; `validate-island-swimming`'s 1400-tick run
   reaches no boundary). bench-sim's 708 `return false`, the last bypass
   patch, is removed; `--bypass` keeps its mechanism with an empty list. The
   360-tick bench workload never reached 708: both digests are unchanged
   (Training `04f77dc631509ae4`, Island `340b445c6e983b80`, JS and Rust VMs
   equal at all 30 checkpoints, `errors {}`).
5. ~~**physFalling in water**~~ Done 2026-09-30
   ([swimming](swimming.md#physfalling-water-paths-aactorphysfalling-0x103d0a50)):
   the Region.Zone water integration (`0x103d125a`), the Decoration bBobbing
   integration (`0x103d0f75`) and the PlayerPawn foot-water integration
   (`0x103d1086`), with their apex copies, run for every actor kind on the
   80-bit model. `validate-native-falling` passes 1898/1898 original-DLL
   cases (884 new, 0 mismatches, 14/14 mutants) with every instruction of the
   three integrations, their apex copies and branch tests executed. The
   non-Pawn host (`runSpawnedActorFalling`) now reads Region.Zone live, so
   the five Island crates stop integrating dry: `validate-island-falling-water`
   shows tick 1 of each equal to Engine.dll's physFalling on the same inputs;
   CrateBreakableMedGeneral5/8 and CrateBreakableMedCombat13 (Buoyancy 90)
   rise 6.44 units and stay pinned against the geometry above them, and
   CrateBreakableMedGeneral1/2 (Buoyancy 60) surface, waterlog through the
   original Decoration.ZoneChange, float (DeusExDecoration bFloating and its
   Tick rocking) and bob at the surface. The Island bench digest is now
   `7b23d044fafab37f` (JS and Rust VMs equal at all 30 checkpoints, two runs
   identical, `errors {}`); Training stays `04f77dc631509ae4`. It first
   differs from `340b445c6e983b80` at checkpoint 0 (tick 70), where only the
   five crates differ (Physics, Base, Location, DistanceFromPlayer; for 1 and
   2 also Velocity, Rotation, Buoyancy, bFloating, bSplash). Through
   checkpoint 5 (tick 120) only crate fields differ; from checkpoint 6 (tick
   130) other actors follow (first ElectricityEmitter5, LaserProxy6/7,
   GeneratorScout9) because the crates' second water entries (ticks 124 and
   125 in validate-island-falling-water's forward-key part) evaluate
   Decoration.ZoneChange's `FRand() < 0.05` settle test, an extra draw from
   the shared random stream. The unbypassed forward-walk
   boundary is unchanged: native 2051 at tick 1872 (item 6).
6. ~~**Native 2051, `Conversation.CreateConCamera`**~~ Done 2026-10-01
   ([conversation camera](conversation-camera.md)): execCreateConCamera
   `0x100106f0`, `GetCurrentRes` (WinDrv `0x11106d90`), the letterbox's raw
   background (Extension `0x1003c720`/`0x1003c5f0`/`0x1003c1d0`, bit-exact in
   `validate-root-raw-background`), Island's captured speaker indices, choice
   graphs and omitted button colours. MeetPaul now runs from tick 1872 to its
   first choice at tick 4720 (`validate-island-conversation`), where ConPlay
   waits for the player's input. Since then the 3D view draws inside the
   letterbox band (root render viewport, ba5c359) and the weapon choice runs
   through the root window's focus natives 1442–1447 (a59a7ac); each of the
   three choices plays to the end.

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
