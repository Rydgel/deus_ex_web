# Original `Actor.SetOwner`

This note records the owner transition used by the original Deus Ex GOTY
Engine.dll. The source declaration is `.cache/reference/Actor.uc`: `Owner` is
the `Actor` field at line 136, `SetOwner` is native 272 at line 707, and the
notifications are `GainedChild(Actor Other)` and `LostChild(Actor Other)` at
lines 787–788. The native evidence is `.cache/reference/Engine.asm` from the
installed Engine.dll (SHA-256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`).

## Script wrapper, native 272

The exported `execSetOwner` thunk is `0x1030242d`; its body is
`0x103e32c0`. The wrapper performs this ABI before calling the actor method:

```text
op = *Frame.Code; Frame.Code++
NewOwner = Step(Frame, op, temporary four-byte object slot)
Frame.Code++                         // consume EndFunctionParms (0x16)
this.SetOwner(NewOwner)              // AActor method
```

The `Step` dispatch uses the Core `GNatives` table at `0x10599a38`. The
wrapper does not write a result value. The method thunk is
`0x10301eab`, which jumps to `AActor::SetOwner` at `0x10369b70`.

## Native transition

The method reads `Owner` from `this+0x3c` and has only two null tests. Its
control flow is:

```text
oldOwner = this.Owner
if oldOwner != None:
    oldOwner.FindFunctionChecked(NAME_LostChild, 0)
    oldOwner.ProcessEvent(function, { Other: this }, None)

this.Owner = NewOwner

if NewOwner != None:
    NewOwner.FindFunctionChecked(NAME_GainedChild, 0)
    NewOwner.ProcessEvent(function, { Other: this }, None)
```

The old-owner event uses the hardcoded name global at `0x10583724`; the new
owner event uses `0x10583728`. Both dynamic calls resolve through the Core
import slot `0x10599a88` (`FindFunctionChecked`) and invoke the owner object's
vtable slot `+0x10` (`ProcessEvent`). The event parameter block contains one
actor pointer, the receiver being re-owned. The corresponding event helper
bodies at `0x10323310` (`LostChild`) and `0x10323360` (`GainedChild`) confirm
the same name-resolution and `ProcessEvent` call shape.

There is no equality test between old and new owners, no `this == NewOwner`
test, and no traversal to reject an ownership cycle. Setting the same owner,
self-owning, and creating a cycle all follow the same event/assignment path.
When the old owner is `None`, `LostChild` is skipped; when `NewOwner` is
`None`, `GainedChild` is skipped. The write is unconditional between those
two tests.

The method body contains no call to `Modify`, no level/actor-array update, no
tick scheduling, and no explicit replication operation. The synchronous
`ProcessEvent` calls are the only callback boundaries. A callback can re-enter
`SetOwner` or mutate `Owner`; the outer method keeps its original `oldOwner`
local and still writes its saved `NewOwner` after `LostChild` returns. The
`GainedChild` callback runs after that write and can perform further reentrant
changes. No singular or recursion guard is present in this method.

## Runtime helper contract

`src/runtime/script-owner.mjs` exports `setScriptOwner(receiver, newOwner,
{ read, write, processEvent })`. The callbacks are required so the host must
make the unresolved object storage and dynamic event boundary explicit:

```js
setScriptOwner(child, owner, {
  read: (actor, property) => actor.values[property],
  write: (actor, property, value) => { actor.values[property] = value; },
  processEvent: (actor, name, args) => runtime.processEvent(actor, name, args),
});
```

The helper calls `read(receiver, 'Owner')` once, dispatches
`processEvent(oldOwner, 'LostChild', [receiver])` when present, writes
`write(receiver, 'Owner', newOwner)`, then dispatches
`processEvent(newOwner, 'GainedChild', [receiver])` when present. It returns
`undefined`, matching the native's void declaration. It does not add implicit
cycle checks, actor-array membership, Modify, tick, garbage collection, or
network behavior; those belong to separately traced native boundaries.
