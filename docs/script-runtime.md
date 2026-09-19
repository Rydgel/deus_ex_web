# Linked original script runtime

The compatibility authority is the installed package bytecode and original
Core/Engine instructions. [Metadata](script-metadata.md),
[bytecode decoding](script-bytecode.md), [calls and contexts](script-execution.md),
[typed values](script-values.md), [events](script-events.md), [iterators](script-iterators.md),
[sleep](script-sleep.md), [timers](script-timers.md),
[ownership](script-owner.md), and [object cleanup](script-object-lifecycle.md) record those
contracts separately from the browser adapters.

`ScriptRuntime` loads class inheritance and authored defaults, retaining full
package identities for properties, functions, states and object/resource
references. It prepares a declared function/state subset before execution;
script calls remain synchronous and an unprepared function is an explicit error.
The instance storage adapter addresses fields by their linked export identity.
It does not conflate identically named fields from unrelated classes.

Virtual lookup searches the active state's inherited methods before class
methods. Global calls skip the state; final calls use the bytecode's original
function reference. Ordinary function calls allocate zeroed typed locals, copy
arguments as each expression is evaluated, execute the original bytecode, and
copy `out` values back in reverse order, then destroy owning temporaries using
the recovered property dispatcher. The caller's return value is copied before
out copyback and destruction. Omitted trailing arguments and Nothing
holes retain the original zero-initialized slots. Indexed native calls preserve their
separate engine-service boundary. Unindexed native implementations remain an
explicit host binding requirement.

`ScriptState` retains the selected state independently of the node containing
inherited code. GotoLabel clears latent actions, finds the original label offset,
and replaces the continuation without running it immediately. ProcessState polls
an existing latent action before resuming statements; a newly installed latent
action suspends until the next actor phase. State changes preserve original
EndState/BeginState order, reentrant transitions and probe masks. The ordinary
ProcessEvent path uses its separate parameter copyback and shared singular-call
guard. Native event hooks and complete actor eligibility/world tick ordering
remain separate integration work.

The common native dispatcher supplies GotoState113, Enable117, Disable118,
FRand195, VRand252, Sleep256, PlayAnim259, LoopAnim260, FinishAnim261,
SetOwner272, Spawn278, Destroy279, SetTimer280, TweenAnim294, SetRotation299 and IsA303. Destroy requires an
explicit validated world adapter and native object registration. Probe controls use the complete 64-entry native
EName table. FRand shares the original random stream with player physics and
stores the native float32 result. VRand shares that stream, performs the
original three-component rejection sample, and preserves the recovered x87
reciprocal/float32 store behavior. FinishAnim installs latent action `0x181`
from the original animation-field gates and its poll clears only on the native
`bAnimFinished` bit. `processActorAnimation` now translates the original main/
blend phase, notifies and AnimEnd and sets that bit through the linked fields;
38 original DLL cases and Jaime's helper→tick→FinishAnim integration pass.
The standalone `processActorTick` entry now supplies the recovered per-actor
admission and animation/event/state/timer/physics ordering, with 37 complete
original function executions compared; see [actor tick](script-actor-tick.md).
`processLevelTick` now composes standalone world scheduling with that actor
entry and CleanupDestroyed. 31 complete original-DLL references cover the
ordering/clock/pause boundaries; a two-frame Training fixture verifies owner
deferral and the linked runtime. Callers still supply a prepared original actor
array, native host services and startup; this does not enroll the full Play
world. See [level tick](script-level-tick.md).
Actor.Tick now defaults to the recovered ShowSelf/CheckEnemyVisible helpers,
sharing the original LOS worker and live PawnList. 24 complete original-DLL
helper/LOS cases pass, and the Training integration runs the actual SeePlayer
script with BSP sight checks. UObject validity and a numeric double level clock
remain required when reached. AICanSee now calls the recovered AIVisibility
cache/movement worker, backed by AIGetLightLevel over live level lights and
flag-6 collision queries. Natives 700/701 dispatch through the same functions;
41 original worker/wrapper cases and three Training map snapshots pass.
AIVisibility uses reflected LevelInfo.TimeSeconds, whose synchronization and
Region initialization remain part of full-world startup/tick integration.
See [AI lighting](script-ai-visibility.md) and [tick visibility](script-pawn-tick-visibility.md).
See [animation tick](script-animation-tick.md). Animation control calls share the original linked booleans and SimAnim
Plane; 37 original exec comparisons establish their frame/tween, continuation
and replication-field writes (see [animation controls](script-animation-controls.md)).
`getActorMeshFrame` now translates ULodMesh::GetFrame using the same prepared
mesh, linked animation/transform fields and global UObject identity service.
Its persistent main/four-blend caches, interpolation and transforms match 46
complete original-DLL calls. Jaime's original helper→animation tick→vertex
fixture checks the runtime boundary. Full-resolution surface decoding and
skin selection now share this prepared resource. GetMeshTexture1013 preserves
its own bounds and fallback rules, checked in 28 full native calls; original
SetSkinStyle/ResetSkinStyle execute on Jaime. Reduced LOD, mesh lighting and
Play rendering remain open. See [mesh frames](script-lodmesh-frame.md) and
[surface/skin selection](script-lodmesh-materials.md).
SetRotation implements the recovered zero-delta
short path, with full movement branches explicitly unsupported. IsA compares the original short class name through the base chain.
Auto state selection follows serialized child order from the derived class
through its bases, choosing the first state with the original auto flag.
The selected state's bytecode must be prepared before execution. Sleep uses the
recovered half-tick wake threshold. `processActorScript` runs ProcessState then
the timer phase; its caller owns actor eligibility and the following physics
phase. Timer fields share the original typed script-property storage. The door
adapter uses this phase ordering, retaining its declared zero-delay scope.

Core string primitives include `ComplementEqual_StrStr` native 124,
`Object.At_StrStr` native 168, `Object.Right` native 234 and `Object.Chr`
native 236. At evaluates both
operands and returns `A + L" " + B`; its separator is the original Core `.data`
TCHAR U+0020. ComplementEqual views both operands as terminated FString text,
applies the original ASCII case-insensitive `appStricmp` comparison, and
returns a normalized bool; Chr evaluates one int, keeps its low UTF-16 word,
and returns one code unit or the raw empty form for zero.
Right keeps original UTF-16 unit indexing and the negative/oversized count
clamps used by the CheckObject NanoKey path. The Chr adapter preserves the original two-byte cursor advance and requires a
signed int32 input. Raw FString storage, allocator behavior and CRT locale
behavior remain outside the logical adapter; see [Core Chr](script-chr.md).

Core `Object.Log` native 231 evaluates its required string before the optional
name, defaults to raw EName `0x302` (`ScriptLog`), and passes terminated text to
the `%s` `GLog->Logf` call. The `logDevice` service is a synchronous host
boundary for that process-global output device; the native's temporary FString
is destroyed after the boundary returns. See [Object.Log evidence](script-object-log.md).

Direct native304 AllActors expressions support the original live actor-array
scan, class/tag filters, Next/Pop, break and compiled return unwind. The caller
must supply a complete linked actor array; Play's partial collision array is
not used as a substitute. The original DeusExPlayer.GetLevelInfo bytecode passed
first-match and empty-result checks against a controlled linked actor array.

Window natives1410/1425/1460 now supply the recovered NewChild lifecycle helper,
native parent-chain root query and parent reconfiguration through
`windowLifecycle` services. Reconfiguration keeps diagnostic/global state,
virtual callbacks and ResizeChild explicit; its hidden-window body also runs
in the composed construction fixture.
The window ProcessScript bridge preserves checked/state-aware function lookup,
GIsScriptable gating and the selected UFunction through ProcessEvent. Original
InfoLink initialization scripts assign the player and authored theme colors,
then reach SetSize1431 in the focused typed fixture. Native construction, theme startup and the full
window/control graph remain open; see [window construction calls](script-window-child.md),
[script dispatch](script-window-script.md) and [hierarchy](script-window-hierarchy.md).

`attach` connects storage to an existing loaded object identity. It deliberately
does not run construction or startup. Explicit construction/spawn methods supply
the scoped lifecycle paths described below. Core GC orchestration now has its
own source-backed module; complete native serialization and save serialization
remain open Stage 3 work.
`initExecution` separately translates the Core frame setup: it replaces
the old continuation, installs the class sentinel with all probes enabled, and
sets ObjectFlags bit `0x02000000`. The original constructor leaves LatentAction
unwritten; the host represents that value as unresolved and rejects polling
until state entry or another established operation initializes it. This helper
does not perform AActor's level validation or native subclass overrides; see
[spawn evidence](script-spawn.md).

The [destruction adapter](script-destroy.md) now implements the recovered play
gates, relationship/event order, collision removal and deferred actor chain.
The caller must validate native subclass, network and editor scope and provide
any reached native world services. Registered objects have separate native
identity/flags/linker records; Core conditional destruction guards reentrancy,
releases linked string properties and detaches the old linker export. Native
Actor destruction handles its explicitly bound auxiliary object before the
Core base hook. Pending finalization is handled by the separate level cleanup
path below. These lifecycle methods are not wired to Play's partial actor world.

The [level cleanup](script-cleanup.md) preserves the permanent actor-array prefix,
defers reference cleanup/finalization until 128 pending actors or an explicit
force, and clears direct object arrays before nested struct references. Editor
cleanup preserves its separate iteration/Modify order. Native IsPendingKill is
selected from verified vtable bindings, separately from UObject destruction and
GC flags. Non-null event managers require their original native service.
The [CameraPoint final destructor](script-object-release.md) now runs inherited
ConditionalDestroy calls, four explicitly bound native FString destructors,
unhashing, free-index insertion, state-frame release and object allocation release.
`releaseObject` requires the verified CameraPoint vtable and explicit native
member/process/allocator services. `validate-script-cleanup.mjs` checks this
post-Destroy path with original metadata and native empty-string fixture records,
including stale object/array/PointRegion references and subsequent index reuse.

The [reference serializer](script-reference-serialization.md) visits UObject
header/state references and typed object/name properties, with native field order,
fixed arrays, recursive structs and the original property-flag filters.
`serializeReferences` connects its reflected-property traversal to live typed
storage. The recovered [Actor serializer](script-actor-serialization.md) delegates
to [UObject's collector serializer](script-object-serialization.md), now connected
to live actor storage by `serializeActorGc`. This includes the route marker,
header references, active state/code references, frame release and property-size
call. `validate-script-serialization.mjs` exercises original CameraPoint/Idle
metadata with a recording archive, including a valid code cursor at offset zero.
The [metadata serializers](script-class-serialization.md) preserve the native
UField/UStruct/UState/UClass chain. [Property-object serializers](script-property-serialization.md)
retain Category names, class/struct/inner-type references and native raw widths;
the same integration check uses the original Actor.Owner metadata through
UProperty and UField. The [bytecode-reference serializer](script-bytecode-serialization.md)
follows the native expanded cursor, including separate boolean-variable prefixes;
the integration check also traverses original CameraPoint.Idle through UState,
UStruct and SerializeExpr. Collection and execution now share mutable slots for
each bytecode operand occurrence; a focused collector-to-VM check covers reference
clearing without aliasing other occurrences. The
[tagged-default serializer](script-tagged-properties.md) now owns the recovered
property walk, default comparison, tag construction, two value-serialization
calls and None terminator. It now uses the recovered
[measuring archive](script-property-measure-archive.md), including MapObject and
MapName, the compact-index branch and the byte counter. A selected original
Actor.Owner field passes through that archive and real GC into its live default
reference. The five complex [property Identical virtuals](script-property-identical.md)
(Str/Array/FixedArray/Map/Struct) are translated and routed by the tagged
walker's `+0x6c` comparison, so identical complex properties are skipped without
a tag. The complex [SerializeItem virtuals](script-property-serialize-item.md)
(Str/Array/FixedArray/Struct/Map/Bool) are translated and emulator-verified for
the collector/measure path, including the FString ArrayNum code-unit count,
the one-byte bool write, fixed-array stride recursion and inherited struct
member traversal; native metadata loading remains a dependency of the full graph.
Class-default variable references now expose writable typed storage, matching
`execDefaultVariable`'s native assignment address. `serializeDefaultReferences`
visits those live fields; objects retain the defaults they copied when they were
created, including fields materialized lazily in the browser runtime. The original
CameraPoint Target field is covered across default assignment, instance creation
and reference clearing. Native Core.Object header fields remain an explicit
binding boundary, separate from reflected default fields.
Native class/resource overrides and the complete loaded registry remain required
before this can collect the live world. Replacing executing class/state identities
is explicitly unsupported by the current runtime storage adapter.
Dynamic arrays/maps require a concrete serializer service.

The [Core GC driver](script-gc.md) marks through mutable reference holders,
preserves shared/cyclic references, applies the original root masks, then runs
conditional destruction, class final release and name deletion in separate
ordered passes. It includes the original archive counter, flags and purge gates.
The GC storage bridge translates canonical script references into registered
native records while preserving mutable typed slots. [FName allocation and
deletion](script-names.md) now implement the recovered hash, lookup, flag and
free-index behavior; a focused bridge check connects actual name marking,
deletion and index reuse. Native object serializers and class destructors remain
explicit services. A registry of fully loaded game/resource objects and the
original native name-table initialization are still needed before this collector
can run over the live game world. The [native class registration
trace](script-native-class-registration.md) records the DLL-defined metaclass
identities and inheritance needed for that loader. Its constructor translation
now composes the recovered UObject queue insertion with UStruct/UClass's exact
native slot writes, including the self-Super rule and distinct constructor
pointers. Registration-facing fields and metadata serializer slots share storage;
the [native registration adapter](script-native-registration-order.md) preserves
the queue/depth rules and returns immediately for already registered objects.
The [UClass registration/default initializer](script-class-registration.md)
publishes the actual default-array storage before the reached callbacks,
requires FName conversion and a concrete raw default-header writer, and preserves
inherited typed property-copy order. Its shared registration host now supplies
the recovered [UField/UStruct prefix](script-struct-registration.md) and FName
conversion directly. Its `classLink` binding now invokes the recovered
[UClass::Link](script-class-link.md) layer with the registration archive.
The native net-field sorter is connected, including original equal-key movement.
The recovered [UStruct](script-struct-link.md) and [UState](script-state-link.md)
linkers now build live property/reference chains and the 256-bucket field hash
table. The [scalar property Link bodies](script-scalar-property-link.md) supply
Byte/Int/Float/Name/Object/Class size and alignment directly to the struct linker,
and the complex bodies are all translated: [UBoolProperty::Link](script-bool-property-link.md)
packs consecutive bools into one DWORD via a shifting bitmask, honoring the
per-container MergeBools rule (class/state/struct pack; UFunction does not), and
the [complex property Link bodies](script-complex-property-link.md) cover
Str/Array/FixedArray/Map/Struct (FString/TArray/TMap header sizes, the
Inner*Count product, the recovered struct-size alignment rule, and the
need-destruction flag with its FixedArray/Struct propagation rules). The
`src/runtime/script-property-link.mjs` dispatcher routes each child to its
verified body so the struct linker links mixed scalar/bool/string/array/struct
layouts.
Config/localization use the original class-flag gates; reached resource
I/O and import virtuals remain explicit services.

The original Core.Object constructor inputs now pass through the actual queue,
existing-package lookup, UObject/UField/UStruct registration, default storage,
all three Link bodies and config/localization gates in one focused composition.
The package and metaclass identities are prebound in this case; it is not a
complete native package loader. All complex property-type Link bodies
(Struct/Array/FixedArray/Map/Str/Bool) are translated, as are the complex
[Identical](script-property-identical.md) value virtuals, as are the complex
[SerializeItem](script-property-serialize-item.md) bodies. FString and dynamic
array save/load directions are recovered through explicit archive and heap
services; the full loaded resource graph, raw allocator integration and native
resource-tail serializers remain necessary for broader classes and live-world
GC. The [property-copy dispatcher](script-property-copy.md)
now implements native CopySingleValue/CopyCompleteValue over raw byte cursors,
including owning arrays and strings, and is the default route from class-default
initialization. Native heap pointer resolution/reallocation remain explicit
services. This is separate from the existing logical VM copy adapter and does
not complete temporary event ownership or the loaded class/resource graph.

The recovered [DestroyValue dispatcher](script-property-destroy.md) now supplies
the corresponding string, dynamic-array, fixed-array and struct cleanup bodies;
base/scalar and map destruction preserve their original no-op behavior.
`exitProperties` uses the dispatcher with the class destructor chain and typed
field references. Logical structs resolve owning fields by their linked keys,
preserving inline dimensions and nonowning numeric/object members. Missing raw
byte offsets remain explicit (`addressOffset: null` for logical storage).
The VM's dynamic-array/map value storage remains unsupported; native heap
reallocation/free and raw member/element references require explicit services.
The same typed destruction bridge now handles ordinary function-call locals
and the nonparameter local suffix of ProcessEvent. Event parameter values
retain ownership after copyback; typed return-bearing events use an explicit
caller result reference and preserve it through local cleanup. Raw native event
memory and native hooks
remain unsupported. See [frame ownership](script-frame-ownership.md). Full
native subclass destruction and live-world GC ownership remain open.

[Object lookup and name resolution](script-object-lookup.md) now use the live
object hash and FName table, exact/inherited class matching, qualified Outer
resolution and the original all-packages search order. Fresh CameraPoint
construction and Spawn checks use that lookup, including actual interned names
and hash insertion. [CreatePackage](script-package-construction.md) composes this
lookup with the recovered allocation arguments and UPackage constructor order.
The shared registration check uses its existing-package branch. New-package
allocation, DLL binding and config aliases retain explicit reached services;
lookup never fabricates a missing object or interns an unknown name.

Generic struct storage now follows linked original member identities, including
inherited/imported struct members. Typed member writes preserve UObject identity
and copy value storage. Original `Actor.Region`/`PointRegion` is checked through
CameraPoint's inherited field. Authored struct defaults now decode through the
original SerializeBin member order, including canonical class/object references,
strings, nested structs and fixed dimensions. All 364 previously opaque DeusEx
class-default struct entries pass the focused loading check, together with
Training map inventory/Region overrides; see [struct values](script-struct-values.md).
Loaded script structs now obtain their native strides and ownership flags from
the recovered UStruct/property Link bodies; see [struct layouts](script-struct-layout.md).
Transient archive-state branches and dynamic arrays/maps remain unsupported.

The [fresh construction helpers](script-construction.md) translate per-class
unique naming, header initialization, template property copies, free-index reuse,
hash insertion and the subsequent class-native constructor dispatch.
`constructObject` requires explicit native template, complete object lookup/name
table and verified constructor bindings. It creates no state frame or level actor
entry. Unsupported
config/localization and object replacement paths fail before construction.
`node scripts/validate-script-construction.mjs` checks the original CameraPoint
metadata and verified native constructor with an explicit template/registry.

The Play host now links the complete [map actor array and authored properties](script-map-actors.md),
preserving null slots, canonical actor identities and inherited resource
provenance. This enables native AllActors to see non-colliding targets such as
the training TriggerLights. Per-class startup, events and native physics remain
limited to prepared behavior.

The [Spawn binding](script-spawn.md) now supports the verified CameraPoint native
class in an explicitly supplied standalone world. It preserves native argument
evaluation/default-copy order, appends the level actor slot, constructs in the
level's Outer package, initializes typed world/region/ownership fields, and runs
original Spawned/PreBeginPlay/BeginPlay/PostBeginPlay/SetInitialState/
PostPostBeginPlay events. PreBeginPlay executes the original GameInfo and base
Mutator relevance chain and consumes the shared FRand stream. The recovered zone
helper assigns the center region. The script's SpawnTag is applied after startup
returns; startup sees the class-name Tag. The single native pending-delete check
remains immediately after BeginPlay.

`node scripts/validate-script-spawn.mjs` exercises this complete scoped path,
including actual class defaults and auto-state bytecode. Its object registry,
name table, preexisting game/mutator/level identities, native template tail and
empty BSP world are explicit fixture inputs. General native CDO loading, map
bootstrap, collision placement/encroachment, undo, spawning during ticks,
SpawnNotify callbacks and other native subclasses remain separate work. The
CameraPoint Idle body is installed but does not run until a subsequent actor
script phase. This spawn path is not wired to Play's partial actor world.

Null Context results now use [statically linked return/property types](script-null-context.md).
The fixed scalar, object/class/name and Vector/Rotator paths check the encoded
zeroing width and produce fresh typed zero values without evaluating the skipped
expression. Virtual return types come from the context property's declared class,
including nested contexts; no live null receiver or short-name guess is used.
Dynamic arrays, other iterator natives, arbitrary native calls, and opaque or
dynamic null-context results remain explicit unsupported boundaries.

`node scripts/validate-script-lifecycle.mjs` checks the original Actor.SetOwner
and Destroy native declarations with original CameraPoint property metadata in
a controlled standalone world. It covers child ownership cleanup, string
release, preservation of ordinary fields/state, PointRegion copy/member writes, pending-chain insertion,
pending-kill event suppression and repeated destruction. This validates the
translation and typed storage boundaries; the fixture supplies registry/world
identities and does not establish actor construction or final collection.

## Focused integration

Run `node scripts/validate-script-runtime.mjs` with the ignored original game
installation present. It executes the actual Engine.u Actor.BeginEvent,
Mover.TriggerToggle.Trigger, DoOpen, DoClose and InterpolateTo bytecode against
linked class defaults and typed parameter/property storage. The original
TriggerToggle state bytecode selects and resumes Open/Close, including replacing
a pending latent continuation and reversing interpolation at alpha 0.25.
It also executes the original state DelayTime/Sleep branch and Actor.SetTimer,
checking same-phase wake/resumption and the one-shot timer's typed fields.
The original Actor.SetInitialState selects CameraPoint's auto Idle state after
the recovered execution-frame initialization, including its probe-mask reset
and latent-slot initialization.

The check verifies object identity, copied parameters/vectors, fixed-array key
lookup, original key/alpha/rate/replication assignments, state cursor changes,
and the original GotoState selection followed by native boundaries
3970 → 264 → 301 on each direction. GotoState executes in the common runtime;
the fixture's host services cover already-moving-brush physics, deferred audio,
and FinishInterpolation suspension.
It does not execute native audio, arbitrary physics transitions, the original
native ProcessState function, or completion callbacks in this fixture. Existing
native scheduler and mover physics evidence remains in [door-state.md](door-state.md)
and [doors.md](doors.md). Passing this check establishes the translation and
linking boundary for this subset, not Stage 3 completion or whole-game fidelity.

The Play scene now connects the selected training doors through
[the script door adapter](script-doors.md). Original bytecode owns Trigger,
Open/Close state code, InterpolateTo, InterpolateEnd, completion and FinishNotify.
The existing source-backed native movement supplies collision and interpolation;
audio playback and Frob permission/group selection remain separate boundaries.
A focused training-map integration check passed targeted use, mid-move reversal,
both completion directions and Player start reset. The runtime is independent of
SurrealEngine; broader Stage 3 lifecycle and native coverage remain open.
