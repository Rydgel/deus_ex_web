# Shared map actor identities and properties

The script host now receives the original serialized `Level.Actors` array,
including non-colliding actors and null slots. `readLevel` decodes this array
from the installed map; native AllActors reads it in ascending order and reloads
the live array after each body, as recovered at Engine `103e43f0` in
[the iterator contract](script-iterators.md). A collision-only array cannot
implement that native: training's four TriggerLight actors do not collide.

`mapActorArray` in `script-map-properties.mjs` preserves each serialized slot,
reuses the collision world's LevelInfo identity for map slot zero, and appends
the existing spawned player. The native SpawnActor append at
`103951bc–103951d6` preserves earlier holes; see [Spawn evidence](script-spawn.md).
This binding supplies actor identities, not the still-incomplete native startup
of every actor class.

## Standalone export admission

Not every serialized actor reference produces an object. The standalone map
linker runs `ULinkerLoad::CreateExport` with `ContextFlags = GIsClient |
GIsServer` (`0x00030000`, the same word `script-load-graph.mjs` installs on the
game linker), and two gates run before construction ([the recovered
body](script-create-export.md)):

- `0x1012e278`–`0x1012e283`: `Export.ObjectFlags & ContextFlags` must be
  nonzero. Exports authored with only `RF_LoadForEdit` never reach
  construction in a local game — Training's 992 `Brush` exports (`0x2340001`)
  and the four UnrealEd viewport cameras `Camera4`–`Camera7` (`0x2340000`).
- `0x1012e2fd`–`0x1012e318`: `LoadClass->Name == NAME_Camera` refuses a
  `Camera`-class export regardless of its flags.

A refused export's `_Object` stays null: it is never constructed, never joins
`Level.Actors` as a live identity, `PawnList` or the collision hash, and its
startup — including `Pawn.PreBeginPlay`'s `PlayerReplicationInfo` spawn for
the PlayerPawn-ancestry cameras — never runs. `mapExportAdmitted`
(`script-map-properties.mjs`) is the shared predicate; `createGame` applies
it before building the live actor map, `mapActorArray` maps each refused
serialized slot to `null` like an authored zero reference, and a map-authored
reference to a refused export resolves to `null` the same way. The serialized
order and the zero slots are preserved — AllActors, the other iterators and
the recovered `ULevel::Tick` scheduling already skip null entries. Evidence:
`scripts/validate-map-actor-admission.mjs`.

The shared binding also exposes each map export's actual Name and its linked
Class identity. These native header fields do not come from the zero/default
property payload; mutation still requires the native rename/reconstruction path.

Before class/default/function references are linked, `ScriptObjects.bindIdentity`
publishes each map export's live host object. Resolving that export through
metadata, tagged references or bytecode therefore produces the same identity
as AllActors. Replacing an already resolved, different identity is rejected
instead of leaving earlier references pointing to stale objects.

`prepareMapProperties` links each authored tag to its original UProperty and
overlays it on that class's typed defaults. This follows the existing recovered
[tagged-property](script-tagged-properties.md) and
[default-storage](script-values.md) contracts. Map object/class references
resolve in the map package; inherited resource defaults retain their declaring
package's canonical identity. Static-array overrides replace only their authored
elements. Generic StructProperty overrides now reload their omitted diagnostic
payload bytes from the original map export, decode the linked SerializeBin
member stream, and resolve nested object/class references in the map's package.
Missing fields and unresolved member serializers fail explicitly. See
[struct value loading](script-struct-values.md).

The previous scalar-only `ClassDefaults` merge remains useful for collision
construction, but it deliberately omits inherited resource references. Script
property storage now uses the linked runtime defaults so, for example,
LightSwitch.Mesh resolves to `DeusExDeco.LightSwitch` instead of None. Runtime
writes are separate from authored values so reset can restore the original map.

The focused original-training composition checked all 1,337 serialized slots:
the 29 authored nulls stay null, the 312 admitted exports keep their live
identities, and the 996 standalone-refused exports (992 `Brush`, 4 `Camera`)
resolve to null rather than a live object — see the admission contract above.
It also checked the appended JC identity, the inherited switch mesh and
AllActors' `cratelight` fanout:
TriggerLight0, TriggerLight1, TriggerLight2, TriggerLight3. The iterator clears
its out reference at exhaustion. Existing door opening and reset also passed
through the expanded shared host. These checks do not claim that every attached
actor's events, native resources or physics execute yet.
Liberty Island's expanded 3,688-slot scene also initialized and completed its
existing spawn landing through this host.
