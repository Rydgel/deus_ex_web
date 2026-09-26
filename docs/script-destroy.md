# `Actor.Destroy` and deferred deletion

This is the source-first contract recovered from the hash-verified GOTY
`Engine.dll` (Engine addresses use image base `0x10300000`; Core addresses are
explicitly labeled and use Core image base `0x10100000`). The authoritative
script declaration is
`.cache/reference/Actor.uc`: `Destroy` is native `279`, returns whether the
request was accepted, and says that deletion is latent until the end of the
tick. The native implementation is in
`.cache/reference/Engine.asm`; public `ULevel.cpp` is used only as a
cross-check for actor-array compaction.

The bounded case is a valid, ordinary, dynamically spawned `Actor` in play.
It is not static or `bNoDelete`, is authoritative, has no owner/base/touching
relationships, is not registered for collision, and uses a level with no
`FCollisionHash` object for the minimal host path. It has no Pawn, network,
editor, or queued-event subclass behavior. The other branches below are
recorded so a host runtime does not silently treat them as the ordinary case.

## Entry points

| Symbol | Address | Observed ABI and effect |
| --- | --- | --- |
| `AActor::execDestroy` (native 279) | export thunk `0x10302324`, body `0x103e38e0` | Advances the script bytecode, calls `XLevel->DestroyActor(this, false)`, and writes the returned `bool`. The `false` is `bNetForce`. |
| `ULevel::DestroyActor` | export thunk `0x10302568`, body `0x10395ba0` | Performs the gates, synchronous callbacks, relationship cleanup, actor-array removal, `bDeleteMe` marking, and deferred-chain insertion. |
| `ULevel::CleanupDestroyed` | export thunk `0x10301811`, body `0x103965a0` | Processes the pending chain when forced or when it reaches 128 entries. |
| `UEventManager::DestroyActor` | export thunk `0x10301032`, body `0x10382760` | Removes queued event records that reference a pending actor. |
| `AActor::Destroy` (virtual final object hook) | export thunk `0x10301f8c`, body `0x10368f60` | Not the script native. It conditionally passes the optional native pointer at `Actor+0x314` to `ConditionalDestroy`, clears that pointer, then calls `UObject::Destroy`. |

## Core object finalization

`UObject::ConditionalDestroy` is called through Engine IAT `0x10599b08`
(Core export thunk `0x10102270`, body `0x1014fdb0`); `UObject::Destroy` is
called through IAT `0x10599ae0` (Core export thunk `0x101025f4`, body
`0x1014fa50`). These object hooks are separate from the script-visible
`execDestroy` request. Core `ConditionalDestroy` tests and sets the UObject
internal flag word at `UObject+0x1c` with mask `0x00800000`, then calls the
object's virtual `+0x24`; Core `UObject::Destroy` sets mask `0x80000000` in the
same word, exits properties, and clears the linker. The exact public names of
those two raw masks are not assumed here. They are distinct from Actor's
`Actor+0x28` boolean word and its `bDeleteMe` mask `0x80`.

More precisely, `ConditionalDestroy` returns zero without the virtual call
when `UObject+0x04` (`ObjectInternal[1]`) is `-1` or when its
`UObject+0x1c` word already has `0x00800000`. Otherwise it sets that bit,
calls virtual `+0x24`, records/logs if the high object bit is still absent,
and returns one (`0x1014fdb0–0x1014fe30`). `UObject::Destroy` then ORs
`0x80000000` into `UObject+0x1c`, calls `ExitProperties(this, Class)` (Core
body `0x10152250`), calls `SetLinker(NULL, -1)` (Core body `0x10101631`), and
updates its native outer/internal bookkeeping (`0x1014fa50–0x1014fac6`): if
`Outer` at `UObject+0x18` is non-null it copies `Outer+0x04` to
`UObject+0x14`, otherwise it writes zero.
Neither Core body writes the UObject `FStateFrame` pointer at `this+0x0c` or
clears its code/latent fields. Any state-frame release is therefore outside
these destruction bodies and remains a GC/host integration responsibility;
the trace does not justify clearing it early.

`AActor::Destroy` itself (`0x10368f60`) reads only the optional pointer at
`Actor+0x314` for its actor-specific prelude. When non-null it calls
`ConditionalDestroy(pointer)` and then writes zero back to `Actor+0x314`; it
does not identify that pointer as the script `Deleted` chain and does not write
`bDeleteMe` or the `FStateFrame`. It then invokes Core `UObject::Destroy` on
the actor. The pointer's producer/consumer and its object type remain
unresolved.

## Gates and return values

`DestroyActor` first performs null and `UObject::IsValid` checks
(`0x10395bc5–0x10395c0e`). The invalid path emits the original diagnostic;
the normal contract below assumes a valid actor and level.

In play (`GIsEditor == 0`), the first Actor boolean word at native `Actor+0x28`
is tested as follows:

* mask `0x05` (`bStatic` bit 0 or `bNoDelete` bit 2 from `Actor.uc`) returns
  `false` (`0x10395c1f–0x10395c28`);
* mask `0x80` is `bDeleteMe`; an already-marked actor returns `true`
  (`0x10395c2a–0x10395c2e`), making repeated requests idempotent;
* when `Role != ROLE_Authority` (script enum value 4), the request is rejected
  unless `bNetForce` is true or the same word has `bNetTemporary` mask
  `0x01000000` (`0x10395c32–0x10395c44`). The script wrapper always passes
  `bNetForce == false`.

`GIsEditor != 0` jumps over these play gates and enters the cleanup path.
A separate class/network test follows (`0x10395c59–0x10395cd8`, resolved
2026-09-26):

* A receiver that is not an `APlayerPawn` (`0x1058c160`) skips the test.
* For an `APlayerPawn`, a null `Player` (`+0x5d4`) or a `Player` that is not
  a `UNetConnection` (`0x10590c40`) continues on the normal path. The test
  reuses the `bNetForce` argument slot for its result, which nothing reads
  afterwards.
* Only a `UNetConnection` with channel 0 (`+0xe64`) non-null and `State`
  (`+0x60`) other than `USOCK_Closed` (1) is diverted. It calls that
  channel's `Close` (vtable `+0x5c`) and returns `false`.

LoadMap nulls `Player` before destroying the viewport actor, so that
destruction always takes the normal path
([Player start collection](script-loadmap-gc.md)).

## Accepted request: exact observed order

For a request that passes the gates, `ULevel::DestroyActor` does the following.
The order is significant because each script/native callback can change the
target or request destruction of another actor.

1. It obtains the target's index with `GetActorIndex` (`0x10301c71`, called at
   `0x10395d1d`). A later assertion checks that the saved `Level.Actors[index]`
   still equals the target before the slot is cleared.
2. If the editor transaction global is active, it records the actor and index
   with the undo subsystem. It then calls the actor vtable slot `+0x1c`, which
   resolves to `UObject::Modify` (`0x10395d58`; AActor vtable at
   `0x104568dc`).
3. If the current state has a probed `EndState`, it resolves EName `0x13d`
   and dispatches that event through `ProcessEvent` (`0x10395d65–0x10395db0`).
   If the callback sets `bDeleteMe`, the function returns `true` immediately
   through the common accepted path (`0x10395db3–0x10395dce`).
4. If the target has a `Base` (`Actor.uc`), it calls `SetBase(NULL, true)`
   (`0x10395e01–0x10395e20`). It then scans `Level.Actors` and calls the same
   operation on every actor whose Base is the target; the count comes from the
   target's native standing-count byte (`0x10395e22–0x10395e83`). The explicit
   target `bDeleteMe` check after its own `SetBase` can return `true`; the
   native loop has no additional target-flag check after each based child call.
5. If `XLevel+0xf8` (the level's `FCollisionHash`) is non-null, it checks
   `bCollideActors` at target `Actor+0x1dc` mask `0x1`. For a colliding actor it
   calls the hash vtable `+0x0c`, which is `FCollisionHash::RemoveActor`
   (export thunk `0x1030199c`, body `0x103583a0`); the hash removal occurs
   before the actor is removed from `Level.Actors`. The hash is then called
   unconditionally at vtable `+0x20`, `FCollisionHash::CheckActorNotReferenced`
   (export thunk `0x10301979`, body `0x10359630`, whose observed body is
   `ret $0x4`) (`0x10395e91–0x10395eb6`). A level with no collision hash skips
   this whole block. A host that supports a hash must preserve both the
   `bCollideActors` gate and the post-removal integrity-hook call.
6. It resolves the global `ENGINE_Destroyed` FName at `0x1058372c` and
   dispatches the target's dynamic `Destroyed` event through `ProcessEvent`
   (`0x10395eb9–0x10395ed9`). A subclass can recurse into other destruction;
   `bDeleteMe` is tested immediately afterward and returns `true` if set.
7. It makes one live scan of every current `Level.Actors` entry. If an
   entry's `Owner` is the target (Owner is the script `Actor.Owner` field), it
   calls that child `SetOwner(NULL)` (`0x10395ef2–0x10395f1e`) and checks the
   target flag. It then checks all four `Touching` slots on that same entry.
   When a slot is the target, it calls `target.EndTouch(other, 1)`
   (`0x10395f59–0x10395f79`) and checks the target flag after each call. The
   loop reloads the live actor array for each entry; it is not two independent
   owner and touching passes. `SetOwner` itself dispatches the old owner's
   `LostChild` and the new owner's `GainedChild`; the existing touch contract
   documents that `EndTouch` clears both sides before the synchronous
   `UnTouch` event.
8. If the target still has an Owner, it resolves `ENGINE_LostChild` at
   `0x10583724` and dispatches `Owner.LostChild(target)` directly through
   `ProcessEvent` (`0x10395fc0–0x10395ff8`). The target flag is checked after
   this callback as well.
9. It invokes up to two level-owned virtual callbacks at vtable `+0x74`: one
    from `XLevel+0x3c`, and one from `XLevel+0x88` when that object's `+0x38`
    field is zero (`0x1039602f–0x10396057`). Their concrete object identities
    are unresolved in this trace. The `UNetDriver` vtable has a matching
    `NotifyActorDestroyed` entry (export thunk `0x1030190b`, body
    `0x10409d70`), but the two ULevel fields are not proven to be that driver.
10. It writes `NULL` to `Level.Actors[index]` and sets target `bDeleteMe`
    (Actor boolean word mask `0x80`) (`0x1039605a–0x1039609c`). It then calls
    the optional audio notification hook through
    `XLevel+0x40` (the `UEngine*` stored by the `ULevel` constructor at
    `0x1039cb24`), `UEngine+0x4c` (the `UAudioSubsystem*`), and that object's
    vtable `+0x7c` (`0x1039609f–0x103960ac`). The public cross-check
    `Source/Engine/Inc/UnAudio.h` names this virtual `NoteDestroy(AActor*)`.
    The Engine.dll abstract `UAudioSubsystem` vtable slot is `_purecall`
    (`0x104135ca` -> MSVCRT IAT `0x1059a348`), while a concrete audio driver
    may override it. `UEngine::InitAudio` (`0x1037fe50`) only leaves `+0x4c`
    populated after an audio class is available and construction/init succeeds;
    a failed init clears it again. `UEngine::Exit`
    (`0x10380b5a–0x10380b6f`) null-checks and clears it. Thus
    the outer engine pointer is required for this path, but a null
    `UEngine+0x4c` is a legitimate no-audio state and skips the virtual call.
11. It calls `UObject::ConditionalDestroy(target)` through IAT `0x10599b08`
    (`0x103960af–0x103960b7`). Core `ConditionalDestroy` checks the UObject
    internal word at `+0x1c`, sets mask `0x00800000` when not already set, and
    calls the object's virtual `+0x24`; for an Actor this reaches
    `AActor::Destroy` at `0x10368f60`. The call performs object lifecycle
    cleanup but does not remove the actor from the ULevel pending chain. In
    the editor it calls ULevel vtable `+0x98` with `1` (`0x10396114`), which
    resolves to `CleanupDestroyed`.
12. In play it prepends the target to the ULevel pending-deletion chain:
    `target.nativeDeleted = XLevel.pendingDeleted`, then
    `XLevel.pendingDeleted = target` (`target+0xf8`, `XLevel+0x100`,
    `0x103960cd–0x103960d9`). It returns `true`.

The script `Actor.Deleted` property is documented as “Next actor in
just-deleted chain” (`Actor.uc:193`). Keep the two `+0xf8` fields distinct:
`XLevel+0xf8` is the `FCollisionHash`, while the target's pending-chain link
is `target+0xf8`. The `+0x314` pointer read by `AActor::Destroy` is not proven
to be `Deleted`; it is an optional native pointer that is passed to
`ConditionalDestroy` and then cleared. These raw offsets are binary-layout
observations, not a host object-layout contract.

## Deferred cleanup

`ULevel::CleanupDestroyed(force)` first calls ULevel vtable `+0x7c`
(`CompactActors`, export `0x10302248`, body `0x103963e0`) when not in the
editor and `force == 0` (`0x103965bb–0x103965dc`). It counts the pending chain
through the native link. With fewer than `0x80` (128) entries and
`force == 0`, it returns without finalizing (`0x103965df–0x1039660b`).

When forced or at the threshold, it visits every non-null current actor and
calls its class vtable `+0x78` cleanup hook (`0x10396611–0x10396632`). In play
it then walks the pending chain, verifies each node still has `bDeleteMe`,
advances the ULevel head, removes queued event records with
`UEventManager::DestroyActor` (`0x1039678e`, body `0x10382760`), and calls the
pending actor's class vtable `+0x0c` with argument `1` (`0x10396680–0x103967ad`).
The concrete names of the class `+0x78` and `+0x0c` hooks are not resolved in
this bounded trace. `UEventManager::DestroyActor` scans event chains, deletes
records owned by the actor, and clears references in records that point at it.

The exported `AActor::Destroy` final object hook (`0x10368f60`) is reached
synchronously by `ConditionalDestroy` in step 11, but it is not the script
native entry. It should not be used as evidence that the JavaScript actor
object can be reclaimed immediately. The exact outer tick
call site that chooses `CleanupDestroyed(false)` is outside this document;
the public `ULevel.cpp` reference corroborates actor-array compaction after
ticking but is not original-binary authority.

## Safe minimal host boundary

For an ordinary standalone actor with no relationship, collision, network,
editor, Pawn, or queued-event branches, a faithful minimal adapter can model:

1. `Destroy()` passing `false` for `bNetForce` and returning `false` for the
   static/no-delete or non-authority gates, `true` for an already-deleting
   actor, and otherwise entering the accepted path.
2. `Modify`, a probed `EndState` when present, and `Destroyed` in the observed
   order. `Destroyed` remains a real callback boundary even when the base
   Actor body is empty, because subclasses can override it.
3. Removal of the actor identity from `Level.Actors` and setting `bDeleteMe`.
4. The `XLevel+0x40`/optional `UEngine+0x4c` audio `NoteDestroy` boundary,
   followed by the Core object-flag transition
   (`ConditionalDestroy` → `AActor::Destroy` → `UObject::Destroy`),
   `ExitProperties`, and `SetLinker(NULL, -1)`. A null `UEngine+0x4c` skips
   the audio call as in the original no-audio path.
5. Linking the actor at the head of the deferred-deletion chain, then
   returning `true`. The actor remains addressable until the level cleanup
   path runs; leave `FStateFrame` code/latent fields untouched until a
   separately recovered final cleanup path.

Do not silently fold the following into that adapter: editor transactions or
`GIsEditor` gates; the `UNetConnection` channel close; non-null collision-hash
wiring beyond the recovered `RemoveActor` and `CheckActorNotReferenced`
calls; the concrete audio-driver implementation beyond the optional
`NoteDestroy` boundary; the unresolved level `+0x3c` and `+0x88` hooks; Pawn
`Destroyed`/`RemovePawn`/inventory behavior; or EventManager and final object
cleanup. Owner/base/touch relationships are dispatched only through the
explicit hooks described below. The unresolved branches need their own
recovered contracts and must preserve the native callback reentrancy checks
when enabled.

## Browser adapter implementation

The live Play wiring for these callbacks — the host eligibility gate, the
level's real `FCollisionHash`, the Core object record for a pre-placed map
export and the boundaries it still refuses — is recorded in
[live-world `Actor.Destroy`](script-world-destroy.md).

`src/runtime/script-destroy.mjs` exports the named function
`destroyScriptActor(receiver, callbacks, netForce = false)`. `callbacks` must
provide `levelFor`, `read`, `write`, and `validate`. `levelFor(receiver)` must
return a level with a live `actors` array, `pendingDeleted`,
`engine.audio` (an audio service or `null`), and `collisionHash` (a collision
hash service or `null`). `read` and `write` use the original property names
(`bStatic`, `bNoDelete`, `bDeleteMe`, `Role`, `bNetTemporary`, `Base`, `Owner`,
`Touching`, optional `StandingCount`, `bCollideActors`, and `Deleted`); the
adapter does not require a browser-specific actor layout.

`validate(receiver, level)` is mandatory and must return exactly `true`. It is
the host boundary for world ownership, native-subclass/class eligibility,
network/editor state, and any unresolved level-owned destruction callbacks.
The adapter throws an explicit unsupported-branch error for a false result or
an editor level. A repeated request on an already `bDeleteMe` actor returns
`true` before looking up its actor-array slot, so a pending actor can be
requested again after its slot has been nulled.

After the play gates, the adapter saves `actors.indexOf(receiver)` and
requires `modify`, `isProbing`, `processEvent`, and `conditionalDestroy` at
the native call boundaries. It calls a probed `EndState`, performs the
Base/standing-child work, collision-hash work, `Destroyed`, one combined live
Owner/Touching scan, and the final Owner `LostChild` event in the order above.
`setBase`, `setOwner`, and `endTouch` are required only when their matching
relationship branch is reached; `endTouch` receives `(receiver, other, 1)`.
The scan reloads `actors` as it advances. The target `bDeleteMe` flag is tested
after EndState, the target SetBase, Destroyed, each SetOwner, each EndTouch,
and final LostChild callback, matching the recovered reentrant exits. The
native based-child loop has no target-flag check after a child SetBase call.

If `StandingCount` is absent while a live actor still has `Base === receiver`,
the adapter throws before mutating the target relationship. A provided
collision hash must expose `checkActorNotReferenced`, and must expose
`removeActor` when `bCollideActors` is true. A provided audio service must
expose `noteDestroy`; a null service is the verified no-audio branch. Before
array removal, the saved slot must still contain the receiver or the adapter
throws rather than clearing another actor. It then nulls that slot, writes
`bDeleteMe`, calls optional `NoteDestroy`, calls the mandatory
`conditionalDestroy`, writes `Deleted` to the prior `pendingDeleted` head, and
prepends the receiver to that chain. No early `pendingKill` flag is introduced.
