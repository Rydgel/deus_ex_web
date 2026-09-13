# ConSys conversation event binding

This document records the recovered native bodies for `Conversation.BindEvents`
and `Conversation.BindActorEvents`. The implementation in
`src/runtime/script-conversation-events.mjs` models only these two native
methods and their fixed-array/list traversal. It does not reproduce the
conversation playback state machine, audio lookup, or the native constructors
owned by the conversation construction work.

The evidence is the installed GOTY `ConSys.u` package, its `ConSys.dll`
(`SHA-256 f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa`),
and disassembly at PE image base `0x10000000`:

| script method | metadata | exec wrapper | C++ body |
| --- | --- | ---: | ---: |
| `Conversation.BindEvents` | native `2052`, 2 args, script size 10 | `0x10010780` | `DConversation::BindEvents` `0x1000fec0` |
| `Conversation.BindActorEvents` | native `2053`, 1 arg, script size 5 | `0x10010840` | `DConversation::BindActorEvents` `0x100101d0` |

The script declaration is:

```text
intrinsic(2052) final function BindEvents(Actor conBoundActors[10], Actor invokeActor);
intrinsic(2053) final function BindActorEvents(Actor actorToBind);
```

## `BindActorEvents` (2053)

The body reads the conversation event head at native offset `this + 0x58`
(`Conversation.eventList`). If it is null, it returns immediately. Otherwise,
for each node it performs the virtual call at event vtable slot `+0x58`
(`DConEvent::BindActor`) with this exact argument order:

```text
event.BindActor(actorToBind, actorToBind, conversation)
```

It then reads the next pointer at event offset `+0x38`
(`ConEvent.nextEvent`) and repeats until null. The native body does not inspect
the virtual return value and does not write `conBoundActors`.

The host therefore supplies explicit `read`, `write`, `isA`, and `reference`
services. `read(conversation, "eventList")` and
`read(event, "nextEvent")` must return the authored/canonical reference value;
`reference` must resolve a reached non-null value to the canonical object
identity. Missing reached references throw an explicit boundary error. A
cycle is rejected by the host to avoid hanging on malformed data; the shipped
native itself has no cycle guard.

## `BindEvents` (2052)

The exec wrapper decodes the `Actor[10]` out argument and the `invokeActor`,
then the C++ body zeroes exactly `0x28` bytes at the array address. The body
then performs three complete passes over the global `UObject::GObjObjects`
array. The class token for each pass is read from the imported Engine class
identities in this order:

1. `APawn::PrivateStaticClass` (`ConSys.dll` IAT `0x10013158`),
2. `ADecoration::PrivateStaticClass` (`0x10013154`),
3. `APlayerPawn::PrivateStaticClass` (`0x10013150`).

The helper at `0x10010a00` advances an index and selects the next object whose
class ancestry satisfies the requested class. The selected objects retain the
original `GObjObjects` order; the outer class-pass order above is also
observable. An actor can therefore be visited more than once when it satisfies
more than one pass (for example, a player is both `Pawn` and `PlayerPawn`).

For each selected object, `BindEventsToActor` applies these gates in order:

1. read the candidate actor's `BindName` (a zero-length/null `FString` is
   substituted with the native empty TCHAR at1001e1cc); it must differ from
   empty text under the imported `appStricmp` comparison;
2. if `invokeActor` is non-null and is not the candidate object, compare its
   `BindName` with the candidate's `BindName`; equal names skip that candidate.
   At `1001016e` the original JE branches to the return after appStricmp returns
   zero. Different names proceed to the event chain. This disambiguates the
   supplied invoking actor from others sharing its BindName;
3. walk the conversation event chain and call each event's virtual
   `BindActor(invokeActor, candidate, conversation)`;
4. when that call returns true, call `AddBoundActor(conBoundActors,
   candidate)`.

`AddBoundActor` scans exactly ten slots in ascending index order. It returns
without a write when it finds the same canonical actor already present. At the
first null slot it writes the actor and returns. A full array produces no
write. The native has no growth or overflow path.

The implementation keeps these operations explicit. `objects()` supplies the
canonical global object sequence, `isA(object, classToken)` performs the class
ancestry check, and `reference(value, label)` preserves object identity when a
package/export reference or host wrapper is encountered. `read` obtains actor
names and event links; `readArray`/`writeArray` expose the ten native fixed-array
slots. The event virtual call is an explicit `bindActor` service because the
vtable dispatch and event-specific writes are native behavior outside the two
`DConversation` bodies. A reached event without that service is an error rather
than an invented false result; a null event head returns before that service is
needed.

## Event-specific boundary

`DConEvent::BindActor` itself returns false (`0x10002350`). Several subclasses
override the slot, including `DConEventSpeech` (`0x1000b070`),
`DConEventAnimation`/`DConEventTrade` (`0x100071b0`),
`DConEventCheckObject` (`0x10007bf0`), and `DConEventTransferObject`
(`0x1000bc40`). Those bodies have their own actor-field reads and writes. The
CheckObject body is recovered through its exact `NK_`/class-loader
[binder](script-conversation-check-object-bind.md), and TransferObject through
its exact actor/class [binder](script-conversation-transfer-object-bind.md).
The native service passes canonical objects and all three
arguments to the host event binder. The focused validator uses explicit
callback fixture returns to exercise the surrounding loops without claiming
semantics for a binder it has not prepared.

The canonical Mission00 reference used by validation is
`Conversation57 -> ConEventSpeech79 -> ConEventEnd77`. Its authored fields are
resolved by `ScriptRuntime.prepareObject`; this task does not allocate a new
`Conversation`, `ConEvent`, or `ConListItem`. Allocation and constructor
integration remain with the conversation construction/trigger work.

## Runtime integration boundary

Install the callback returned by `createConversationEventsNativeService` as the
`ScriptRuntime` native handler for indices 2052 and 2053. The Play host must
provide canonical `reference` resolution, object-field `read`/`write`, the
ordered live `objects` (`GObjObjects`) sequence, class-ancestry `isA`, and
fixed-array `readArray`/`writeArray` access. Supply `bindActor` by dispatching
the reached event's concrete native body; `script-conversation-speech.mjs`
provides the recovered Speech implementation. Animation/Trade use the shared
[action binder](script-conversation-action-bind.md), CheckObject uses its
[native loader binder](script-conversation-check-object-bind.md), TransferObject
uses its [actor/class binder](script-conversation-transfer-object-bind.md), MoveCamera
uses its exact false-return binder, and thirteen exact classes use the verified
[inherited body](script-conversation-base-bind.md). Other event subclasses
remain explicit boundaries. The callback returns `undefined` for both native
methods, as the original void wrappers do.

Shared ScriptRuntime dispatch now supplies canonical fields and class ancestry
for 2052/2053, using an explicit `conversationObjects` provider for the live
GObjObjects array. The iterator reloads that array and its count at each advance.
Exact Speech, Animation, Trade, CheckObject, TransferObject, and MoveCamera classes have
recovered concrete dispatch, along with the thirteen verified inherited-false
classes. Other classes throw.
Native2054 also executes the recovered no-write ClearBindEvents traversal.
Typed out arguments retain their property lvalue and publish each slot write
through `arrayReference`; reading a complete fixed array first would mutate a
copy and lose the original caller-visible stores.

The original ConPlayBase.StartConversation now passes a positive Mission00
fixture through those shared bodies, its real ConActorsBound[10] property,
Conversation.CheckActorDistances, and AllActors(DeusExLevelInfo). Bound actors,
mission fields, root-window identity and bConversationStarted are verified.
The fixture supplies its object/actor arrays and logical window explicitly;
it does not establish native world allocation, UI initialization, or the full
DataLinkPlay.StartConversation override.

## Validation scope

`scripts/validate-native-conversation-events.mjs` executes the complete original
BindEvents, BindEventsToActor, AddBoundActor and BindActorEvents bodies in
`scripts/native-conversation-events-oracle.py`. Explicit fixtures supply the
GObjObjects registry, class identities, ASCII CRT comparison and event virtual
returns. Translation/native comparisons cover actor order, same-name exclusion,
live registry growth during a callback, fixed-array duplicate/full behavior,
and the ignored false return in BindActorEvents. The generated exec wrappers
and full process bootstrap remain outside this body probe.

`scripts/validate-script-conversation-events.mjs` checks the installed package
metadata, hashes and instruction bytes for both wrappers/bodies, then drives
the service with canonical object fixtures. It verifies the three class passes,
name gates, repeated player visits, event argument order, exact ten-slot
duplicate/full-array behavior, and the null-event early returns. The focused
Node test checks the pure fixed-array/list helpers and unresolved-reference
errors. No original assets or binary captures are added to Git.

Unresolved branches are deliberate: TransferObject's later
`SetupEventTransferObject` inventory action, native metaclass class loading, the complete live
`GObjObjects` provider, UObject lifecycle/constructor allocation, and general conversation
playback/audio are separate services. Returning false, inventing
actors, growing the fixed array, or silently treating a missing event link as
null would not be original-backed behavior.

The Num0 fallback at1001e1cc is zero-filled native data. It is empty text;
the literal BindName `None` remains nonempty and reaches event callbacks.
