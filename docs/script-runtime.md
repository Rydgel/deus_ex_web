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
copy `out` values back in reverse order. Omitted trailing arguments and Nothing
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
FRand195, Sleep256, SetOwner272, Spawn278, Destroy279, SetTimer280, SetRotation299 and IsA303. Destroy requires an
explicit validated world adapter and native object registration. Probe controls use the complete 64-entry native
EName table. FRand shares the original random stream with player physics and
stores the native float32 result; SetRotation implements the recovered zero-delta
short path, with full movement branches explicitly unsupported. IsA compares the original short class name through the base chain.
Auto state selection follows serialized child order from the derived class
through its bases, choosing the first state with the original auto flag.
The selected state's bytecode must be prepared before execution. Sleep uses the
recovered half-tick wake threshold. `processActorScript` runs ProcessState then
the timer phase; its caller owns actor eligibility and the following physics
phase. Timer fields share the original typed script-property storage. The door
adapter uses this phase ordering, retaining its declared zero-delay scope.

Direct native304 AllActors expressions support the original live actor-array
scan, class/tag filters, Next/Pop, break and compiled return unwind. The caller
must supply a complete linked actor array; Play's partial collision array is
not used as a substitute. The original DeusExPlayer.GetLevelInfo bytecode passed
first-match and empty-result checks against a controlled linked actor array.

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
reference. Complete typed class layout, complex property virtuals and native
metadata loading are still dependencies of the full graph.
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
Byte/Int/Float/Name/Object/Class size and alignment directly to the struct linker.
Config/localization use the original class-flag gates; reached resource
I/O and import virtuals remain explicit services.

The original Core.Object constructor inputs now pass through the actual queue,
existing-package lookup, UObject/UField/UStruct registration, default storage,
all three Link bodies and config/localization gates in one focused composition.
The package and metaclass identities are prebound in this case; it is not a
complete native package loader. Complex property-type Link bindings and the full
loaded resource graph remain necessary for broader classes and live-world GC.

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
CameraPoint's inherited field. Opaque authored struct defaults and unresolved
native struct array strides remain unsupported.

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
