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

The focused original-training composition checked all 1,337 serialized slots
(including 29 nulls), the appended JC identity, canonical resolution of every
non-null actor, the inherited switch mesh and AllActors' `cratelight` fanout:
TriggerLight0, TriggerLight1, TriggerLight2, TriggerLight3. The iterator clears
its out reference at exhaustion. Existing door opening and reset also passed
through the expanded shared host. These checks do not claim that every attached
actor's events, native resources or physics execute yet.
Liberty Island's expanded 3,688-slot scene also initialized and completed its
existing spawn landing through this host.
