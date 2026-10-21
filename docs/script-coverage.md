# Script and native coverage inventory

Run `node scripts/inventory-script-runtime.mjs` against the local installation.
It writes `.cache/script-runtime-inventory.json`, including package hashes,
native declarations, direct native call counts, final calls to native functions,
virtual call names and decoded opcode counts. Original bytecode and resource
payloads are not copied into the report.

The current installation produces this inventory:

| Package | Functions | States | Native declarations |
| --- | ---: | ---: | ---: |
| Core | 170 | 0 | 165 |
| Engine | 1,263 | 65 | 158 |
| Extension | 555 | 0 | 453 |
| ConSys | 51 | 0 | 11 |
| DeusEx | 4,933 | 185 | 57 |
| UWindow | 723 | 1 | 0 |
| DeusExUI | 0 | 0 | 0 |
| Fire | 0 | 0 | 0 |
| Total | 7,695 | 251 | 844 |

All 7,946 function/state streams decode without format errors. This is decoding
coverage, not execution coverage. The streams contain 581 distinct direct native
indices. Fifty native declarations have index zero (11 Core, 39 Engine) and need
their named/native-hook route; they cannot be treated as one shared native-zero
implementation. The inventory does not resolve every virtual call or count its
runtime frequency.

Which natives Play handles is no longer counted from a catalogue kept in this
script: that catalogue drifted (the script stopped running when a dispatcher
moved). The declaration is `src/runtime/native-registry.mjs`: for each
dispatcher of the `invokeNative` chain (the VM primitive switch, the runtime's
branches, latent polls and iterators, the window host, the Play host
`nativeCall`, the trigger/ConPlay handlers and the log, dump, travel, HUD and
overlay overrides) the indices and function keys its code routes, which
`test/native-registry.test.mjs` compares with the code on every `npm test`. This
script reads the registry for its supported-index count; a listed index can
still be partial or conditional (`partial`, `when`). The per-native census of
all 891 declarations, by status, family and caller, is
[native-census.md](native-census.md) (`scripts/census-natives.mjs`).


[Superseded by the census; kept as the 2026-09-23 record.] The 2026-09-23 inventory routes **324 of the 581** direct indices (115
primitives, 209 through dispatch sites), covering 37,975 of 39,280 decoded
direct call sites. **257 indices (1,305 call sites) have no dispatch path.**
Nineteen of the routed indices are this date's window-host additions, verified
together by the [differential exec-body harness](native-exec-diff.md). The
first corrected count, before those additions, was 305/276. That replaced an
earlier count of 295/286, which came from a scan of `nativeIndex:` module
declarations. That scan counted 51 direct indices whose
translated modules are imported only by their own validators, mainly the
ListWindow, EditWindow, button/checkbox and TextWindow setters and
`Window.IsKeyDown`. It missed 62 indices the runtime does dispatch, such as
LoopAnim 260, TweenAnim 294, AICanSee 705, AIPickRandomDestination 709 and
the alliance natives 2105-2107. The report now lists such modules under
`translatedWithoutDispatch` (now 68 modules, 45 of them direct indices with 600
call sites); they become supported only when a dispatch site routes them. The
most-called indices still unsupported are `Window.IsKeyDown` 1470 (53 call
sites), `Object.SaveConfig` 536 (49), `TextWindow.GetText` 1552 (47),
`TextWindow.AppendText` 1551 (40) and the ListWindow row/column natives.
For example, mover SetPhysics only accepts an already active MovingBrush mode,
and PlaySound records a deferred effect without producing audio. Stage 2 contains
additional recovered engine helpers whose general script call bindings remain
open work.

Core `Object.Chr` native 236 is now linked through the primitive string path.
Its original-DLL oracle and validator cover int32 low-word conversion,
zero/nonzero FString result headers, the two-byte FFrame cursor advance, and
single evaluation of the int operand; lone UTF-16 surrogate units are retained.
See [the Core Chr evidence](script-chr.md).

Core `Object.Right` native 234 is linked through the same primitive path. Its
original FString body and eight DLL probe cases establish negative/oversized
count clamps, raw empty results and UTF-16 unit slicing. The authored
CheckObject NanoKey setup now consumes it before `StringToName` and
`NanoKeyRing.HasKey`; see [string operation evidence](script-string-operations.md).

Core `Object.At_StrStr` native 168 now runs through the shared string primitive
path. Its original-DLL oracle and validator establish the raw `.data` separator
TCHAR U+0020, FFrame operand order/cursor advance, temporary FString ownership
and VM dispatch; see [the native 168 evidence](script-at-string.md). It occurs
in 216 decoded direct call sites.

Core `Object.VRand` native 252 now runs through the shared original random
stream. Its original-DLL oracle and validator establish the three-component
unit-sphere rejection loop, exact three-call cadence, x87 reciprocal and
float32 output stores; see [the native 252 evidence](script-vrand.md).

Engine `Actor.FinishAnim` native 261 now dispatches its recovered animation
field gates and latent action `0x181`; the matching poll clears only when the
original `bAnimFinished` flag is present. The recovered main/blend animation
phase now sets that flag and releases Jaime's wait in the runtime integration
check. General world actor scheduling/startup remains open. See
[FinishAnim](script-finish-anim.md) and [animation tick](script-animation-tick.md).

Core `Object.Log` native 231 now preserves the original FFrame argument order,
optional `ScriptLog` EName default, `%s` formatting, and temporary FString
cleanup through an explicit synchronous `logDevice` host boundary; see
[the Object.Log evidence](script-object-log.md).

Engine `Actor.SetLocation` native 267 now dispatches the recovered wrapper
through an explicit level/native-actor/FarMoveActor adapter.  The wrapper
evaluates one vector and passes `Test=0,bNoCheck=0`; a missing adapter remains
an explicit boundary.  See [the SetLocation evidence](script-set-location.md).

UI and conversation work therefore includes native implementations in Extension
and ConSys, in addition to loading the corresponding script packages. Frequently
called incompletely bound families include strings, object/class queries, actor spawning,
flag storage and Window construction/layout. Inventory order is a guide for
selecting original routines to trace; it does not replace their source contract.

The [runtime scope](script-runtime.md) documents the currently executable subset.
Shared native dispatch now includes Core string `ComplementEqual_StrStr`
native 124, `At_StrStr` native 168, state queries 281/284 and Extension StringToName1024 with an
explicit FName/error service. DataLink selection and
fixed queue helpers execute original functions against canonical conversation
objects. All 18 DataLink routes authored by `00_Training` now resolve their
canonical Mission00 direct Speech-to-End chains and execute installed player
selection/Spawn/SetConversation/SetTrigger plus ConPlayBase start/termination
against the Play actor graph. Speech completion runs installed
`PlayNextEvent`/`ProcessAction`, the prepared `PlayEvent.SetupEvent`, inherited
`SetupEventEnd`, and the returned `EA_End` termination path while preserving
the canonical Speech/End identities. The concrete Speech BindActor translation writes
the canonical event object.
The subsequent conversation and window work adds shared2055/2056 speech
lookup/timing and native1410/1425/1460 child-lifecycle/root-query/reconfiguration paths with explicit
services. Every selected route's original MP3 passes catalog identity and timing
checks. Typed InfoLink initialization executes its original superclass/style
events, assigns the player and authored theme colors, and constructs all six
controls through recovered Window, TextWindow and ComputerWindow paths. The
installed SetSpeaker body also runs through recovered Core `Left`, native
concatenation and Core `DynamicLoadObject`. Its package identity is prepared
before the first call, which then constructs the canonical `ULinkerLoad` and
executes the recovered StaticLoadObject lifecycle, export hash/import-class
match and existing-object return for the canonical Jaime Reyes Texture.
Native metaclass loading remains explicit. The
source-translated timer/event schedule owns a spawned DataLinkPlay through HUD
publication, `DatalinkFinished`, played-flag storage and one-shot trigger
removal. A queued route advances through original `PopDataLink`. Exact native
HUD destruction now recursively removes the six-control tree, dispatches the
original HUD `DescendantRemoved`, and reconstructs a distinct tree for a queued
route or reset. Generic ConEvents, native rendering and native audio mixing
remain incomplete.
The live Training DamageTrigger now enters its original timer and prepared
`TakeDamage -> AddDamageDisplay -> DXReduceDamage -> StopPoison ->
UsingChargedPickup -> SetDamagePercent -> PlayDXTakeDamageHit -> PlayHit ->
Human.PlayTakeHitSound` chain. Core natives 144, 145, 169, 185, 210, 213 and 223
preserve the recovered integer overflow/division, zero-divisor guard, float32,
x87 threshold, unordered, vector and out-lvalue behavior. The old null
`AugmentationSystem` was a browser
lifecycle gap; the current startup creates `AugmentationManager1`. With
unowned `AugEnviro`, Radiation10 writes `adjustedDamage=10` and returns false,
then the original body writes `HealthLegLeft=90` and `Health=98`. The canonical
`DeusExCharacters.GM_Trench` resource and native PlayAnim 259 are prepared and
validated in the live damage route, including the original optional-argument
hole (`HitLegLeft`, frame `-0.25`, rate `2.5`, tween `2.5`, last `0.75`), using
the original-execution correction in [animation controls](script-animation-controls.md). The next
explicit boundary is `Actor.PlaySound(264)` from `Human.PlayTakeHitSound`; the
normal scene route records that unsupported audio operation without inventing
playback.
The current checkpoint is in [the handoff](stage-3-handoff.md).
Core GC marking/purge orchestration and deferred actor-reference cleanup have
source-backed modules with explicit native lifecycle/serialization boundaries.
Actor/UObject collector serialization is bound to live CameraPoint storage,
including active state references. FName table operations and the typed GC
reference bridge also have focused integration coverage. These are components
of collection, not a complete class/resource graph or save serializer.
Native metadata overrides cover the UField/UStruct/UState/UClass chain and
property subclasses, with original Owner-property and Idle-state integration
checks. Bytecode collection follows native cursor order and shares operand
storage with execution. Tagged-default traversal/default filtering is translated;
its native measuring archive is connected through the GC bridge to live Owner
default storage. The complex [property Identical virtuals](script-property-identical.md)
(Str/Array/FixedArray/Map/Struct) are translated and routed by the tagged
walker's +0x6c comparison, and the complex [SerializeItem virtuals](script-property-serialize-item.md)
  (Str/Array/FixedArray/Struct/Map/Bool) are translated and emulator-verified
  for collector/measure plus the FString/TArray loading/saving branches,
  including CompactIndex, count mutation, growth, and element recursion.
  Native [CopySingleValue/CopyCompleteValue](script-property-copy.md)
dispatch now operates on raw byte storage and is connected to class-default
initialization. Owning copies require explicit native heap services. The
recovered [DestroyValue dispatcher](script-property-destroy.md) also handles
linked owning members and is used by the logical VM's object ExitProperties
and [function/event temporary cleanup](script-frame-ownership.md) paths.
The latter now covers owning strings/structs, preserves event parameters,
and has a focused original ProcessEvent comparison. Generic tagged save
serialization, array/map temporary storage, raw native event memory, raw heap
services beyond the explicit SerializeItem adapters, and complete typed class
storage remain explicit dependencies.
Native UObject queue/registration, UStruct/UClass construction and UClass default
storage initialization now have bounded translations. UField/UStruct registration
and native hash/path lookup are connected, including CreatePackage's existing
package path. Registration can invoke the recovered UClass::Link layer;
native net-field ordering and UStruct/UState linking are connected. The original
Core.Object registration composition passes through those layers and the native
config/localization gates without stand-in callbacks. Byte/Int/Float/Name/Object/Class
property Link bodies now compose with the struct linker, and all six complex
property Link bodies (Bool/Str/Array/FixedArray/Map/Struct) are translated with
focused coverage, so mixed layouts link through the recovered native bodies.
Config/localization resource services remain open. Constructor fields
share mutable storage with the registration/serialization adapters. These paths
do not yet constitute the complete native class loader.
Broader actor creation/destruction, native class registration, complete garbage
collection integration, serialization, broader native dispatch and game/UI
behavior remain Stage 3 work.
