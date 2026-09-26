# Live-world `Actor.Destroy`

[`script-destroy.md`](script-destroy.md) records the recovered
`ULevel::DestroyActor` contract from the hash-verified GOTY `Engine.dll`, and
`src/runtime/script-destroy.mjs` implements that order. That adapter
deliberately owns no world state: every native service is a caller callback, so
an unresolved branch fails explicitly instead of becoming a guess.

This document records how the live Play world supplies those services
(`src/runtime/script-world-destroy.mjs`, wired in `src/runtime/script-doors.mjs`)
and exactly which boundaries the live wiring still refuses.

## Why it is needed in Play

Training's `OrdersTrigger2` is a one-shot `OrdersTrigger` (`bTriggerOnceOnly`,
`Event` `mibwalker`) standing in the corridor past the first door. Its installed
body destroys it on the first relevant touch:

```text
singular function Touch(Actor Other)
{
    if (!IsRelevant(Other)) return;
    if (StartPatrolling())
        if (bTriggerOnceOnly)
            Destroy();
}
```

Before this wiring, walking into it raised `DestroyActor requires validate`.
That pauses Play, and a paused session ignores every later input — movement and
door use included — so the failure looked like "the door stopped responding"
rather than like a destruction gap.

## Services supplied by the live world

| Adapter callback | Live binding | Evidence |
| --- | --- | --- |
| `validate(receiver, level)` | Host eligibility gate below | `script-destroy.md`, "Gates and return values" |
| `modify` | Core `UObject::Modify` with `level.undo` (null in play, so it records nothing) | step 2 |
| `levelFor`, `read`, `write`, `isProbing`, `processEvent`, `setOwner`, `conditionalDestroy` | Already supplied by `ScriptRuntime.destroyActor` | steps 3, 6, 7, 11 |
| `endTouch(receiver, other, 1)` | `actor-touch.mjs` `endTouch`, dispatching the other side's `UnTouch` | step 7 |
| `level.collisionHash` | The live `FCollisionHash` (`level.hash`): `removeActor`, and `checkActorNotReferenced` as the verified no-op (`ret $0x4`) | step 5 |
| `level.engine.audio` | `null` — the verified original no-audio branch; audible playback is Stage 4 | step 10 |
| `setBase` | Not bound. A target with a `Base` or based children raises `DestroyActor requires setBase` | step 4 |

`level.hash` is read through a function, not captured, because the scene rebuilds
the hash object on reset.

## Host eligibility gate

`validate` returns `true` only for an ordinary attached actor of this live
level, and a `false` result makes the adapter raise its explicit
unsupported-branch error. It refuses:

* a different level container, an unattached identity, or an editor level;
* `netMode != 0` or a non-null `demoRecDriver` — the two unresolved
  level-owned hooks at `ULevel+0x3c` and `+0x88` are driver objects;
* any `Engine.Pawn` subclass except the player that LoadMap is retiring
  (`level.retiringPlayer`, with its `Player` already None). The class/network
  test at `0x10395c59-0x10395cd8` is resolved
  ([Actor.Destroy](script-destroy.md)): a None `Player` takes the normal path.
  Other pawns stay refused, because Play's NPC tick lists do not yet drop a
  destroyed pawn, and only the reload rebuilds a live player's host scene;
* any `Engine.Mover` or moving brush, whose brush model, encroachment and base
  contract are not recovered here.

## Core object record for a pre-placed map export

`ConditionalDestroy` -> `AActor::Destroy` -> `UObject::Destroy` needs the
target's native `UObject` record. Every attached map actor now carries one
(`mapActorNativeObject`), built from the map package's own export table:

* `name` and `flags` are the original export-table values. The observed
  transition for `OrdersTrigger2` is `ObjectFlags 0x02070001 -> 0x82870001`:
  Core `ConditionalDestroy` sets `0x00800000`, then `UObject::Destroy` sets
  `0x80000000`.
* `index` is the Core `GObjObjects` slot. It is an integer only when a measured
  capture-backed provider resolves it ([boot-replay.md](boot-replay.md)); in Play
  no capture is installed, so it stays `null` — "registered, slot unmeasured".
  It is never fabricated. `-1` remains the original unregistered marker that
  Core `ConditionalDestroy` rejects, so `null` correctly reaches the virtual
  call while still reporting an unknown slot to `soundField('ObjectIndex')`.

### Explicit boundaries in that record

* **`linker` is null.** This host decodes map packages with its own reader
  rather than constructing the map's `ULinkerLoad`, so the recovered
  `SetLinker(NULL, -1)` has no live export slot to clear. Nothing in the live
  runtime re-resolves a destroyed map export today; making that clear
  observable needs the map package's linker, which is separate open work.
* **`outer` is null**, because the map's `UPackage` object is not constructed
  here. The post-destroy `linkerIndex` bookkeeping that `UObject::Destroy`
  derives from `Outer` is therefore not meaningful for a map actor and is not
  asserted anywhere.
* **`CleanupDestroyed` is not run.** The target stays on the ULevel deferred
  chain (`level.pendingDeleted`), which is the recovered play behavior until the
  separately documented cleanup path runs; no early release is introduced.

## `Touching` is live state

The recovered scan reads each live actor's `Touching` slots. The browser keeps
those four slots on the host actor, where `beginTouch`/`endTouch` maintain them,
so the script `Touching` property is now bound to that live array in
`script-doors.mjs` instead of returning the map's serialized startup value. An
actor the scene never prepared for contact has no live slots and keeps its
serialized value.

## Player start

The original returns to the initial map state by reloading the level. This host
reuses actor identities across "Player start", so a small ledger records what a
destruction cleared — the `Level.Actors` slot and the native object's flags —
and restores them on reset, clearing the actor's authored property store so the
values `ExitProperties` released come back. The LoadMap tail partition
([script-loadmap-startup.md](script-loadmap-startup.md)) compacts and reorders
the array at the end of startup, so the recorded slot can hold a different
actor by then: the restore writes the slot when it is still null and inserts at
the recorded position when it is occupied — the partition re-derives the
static/dynamic order either way, and silently dropping the actor is never
correct. The touch slots are *not* restored
from the pre-destruction snapshot: `DestroyActor`'s `EndTouch` pass cleared both
sides of every live pair, so the surviving counterpart no longer holds the
destroyed actor and a one-sided restore would suppress the next `BeginTouch`'s
reciprocal `Touch` dispatch (the second session's `OrdersTrigger2.Touch` never
fires). `playerScene.reset()`'s `prepareActor` already rebuilds `touching` from
the serialized `Touching[i]` fields, which is the reload-equivalent state. The
live collision hash is rebuilt wholesale by the scene reset and is not touched
by the ledger.

The ledger records only serialized map exports, which the original reload
replaces in place at the same index. Spawned actors, including the retired
player that LoadMap destroys, are never ledgered: the reloaded `Level.Actors`
leaves them out, and LoadMap's collection releases them
([Player start collection](script-loadmap-gc.md)).

## Focused check

    node scripts/validate-world-destroy.mjs

It proves the authored route reaches `OrdersTrigger2`, that the only destruction
callback its body reaches is `Destroyed`, that `EndTouch(other, 1)` clears the
player side, that the actor leaves the collision hash and its `Level.Actors`
slot, the `bDeleteMe` and `ObjectFlags` transitions, the deferred-chain head and
`Deleted` link, that a repeated request is idempotent, that a Pawn other
than the retiring player is refused with the explicit unsupported-branch error, that Play continues past the old
pause point, and that reset restores the map state so the next session
reproduces the same destruction frame.
