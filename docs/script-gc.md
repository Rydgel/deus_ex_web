# Core garbage collection

This contract is taken from the hash-verified GOTY `Core.dll` in
`.cache/research/Core.asm` and `.cache/reference/Core-rng.asm`. It covers the
Core mark archive and object/name purge driver. Reflected `UObject::Serialize`,
class-specific destruction, hash removal, registry-slot release, and allocator
freeing remain explicit host callbacks; this driver does not replace those
operations with a JavaScript approximation.

## Entry points and registry records

`UObject::CollectGarbage` is the exported thunk at `0x101010c8` and body
`0x10158500`. Its body logs collection, constructs the special mark archive by
calling `0x1010213a` (body `0x1015eac0`), calls `SerializeRootSet` through thunk
`0x10101a46` (body `0x101580b0`), then calls `PurgeGarbage` through thunk
`0x1010335a` (body `0x101581f0`). Marking therefore occurs even when the later
purge is disabled by `NOGC`.

The host registry passed to `src/runtime/script-gc.mjs` has three live arrays:

| Host field | Original record | Required behavior |
| --- | --- | --- |
| `objects` | `GObjObjects` data `0x1029e628`, count `0x1029e62c`, capacity `0x1029e630` | Preserve index order and null holes while the callbacks run. |
| `roots` or `rootSet` | root-set FArray data `0x1029e5f8`, count `0x1029e5fc`, capacity `0x1029e600` | Hold mutable `UObject*` slots; a rejected root is written back as null. |
| `names` | GNames data `0x102961f0`, count `0x102961f4` | Hold mutable FName-entry records whose flags are at entry `+0x4`. |

Object records expose `flags` or `objectFlags`, representing the ObjectFlags
word at `UObject+0x1c`. A host may provide `readFlags`, `writeFlags`, and
`isUObject` services when those words or the class ancestry test are stored in
native layouts. The source checks each registry entry with the UObject class
chain rooted at `0x1029e0d0`; the module's permissive default predicate is only
for records that are already known to be UObject records.

The header positions relevant to a registry adapter are object index `+0x04`,
hash-next `+0x08`, state-frame pointer `+0x0c`, linker `+0x10`, retained
linker/Outer index `+0x14`, ObjectFlags `+0x1c`, and FName index `+0x20`. GC
only reads the flags and name-table entry flags directly. The deleting
destructor service owns the index/hash/state-frame writes described in
[script-object-release](script-object-release.md); the mark driver must not
clear those fields early.

The root array is visited through real holders. `archive.serializeObject({
value })` is also a holder and can be used by reflected property code. The
module rejects a direct object argument because the native `UObject**` contract
requires a mutable slot for the raw archive-exclusion null write.

## Mark archive

The special archive constructor at `0x1015eac0` installs vtable `0x1017a2f0`,
initializes its current-object slot at archive `+0x2c`, and resets the reference
counter at `0x102a26a4`. It then scans every UObject registry entry and ORs
`0x00000042` into the object flags. It scans the name table and ORs `0x00000002`
into each FName entry's flags. The object archive vtable entries used by this
driver are `+0x18 -> 0x101031a7 -> 0x1015ec90` and
`+0x1c -> 0x10102360 -> 0x1015ee00`.

The object serializer at `0x1015ec90` receives a `UObject**` holder and first
increments the global archive reference counter at `0x102a26a4` at
`0x1015ecb8–0x1015ecbf`. This happens for every visit, including null,
archive-excluded, and already-marked references. It then applies these exact gates:

1. A null holder returns unchanged.
2. ObjectFlags bit `0x00000400` is rejected. The instruction is
   `testb $0x4,%dh`; `%dh` addresses bits 8 through 15, so this is `0x400`,
   not `0x04000000`.
3. A non-null object whose `0x00000002` bit is already clear is returned as a
   visited reference. The native branch at `0x1015ecee–0x1015ecf2` returns
   without writing the holder, so a cyclic property edge remains intact. Only
   the `0x400` exclusion writes a non-null holder back to null.
4. For a new candidate, the routine clears `0x00000002 | 0x40000000` from the
   object flags. It saves the prior archive current object, stores this object
   in archive `+0x2c`, and, when the prior flags contain `0x00000040`,
   dispatches the object's virtual Serialize entry (`vtable +0x28`) with the
   archive. It then restores the prior current object.
5. After a Serialize callback, the `JNE` at `0x1015ed20` skips the diagnostic
   when `0x40000000` remains set. A clear route marker is the diagnosed
   failure; the host exposes it as `onSerializeRouteFailure` when it needs the
   original warning. When the prior flags lacked `0x40`, Core does not dispatch
   Serialize and instead logs a separate missing-route warning at
   `0x1015ed45`; the module exposes that as `onSerializeMissingRoute`.

The reflected serializer decides which fields recurse. A cyclic graph is safe:
the candidate bit is cleared before the callback, so a back edge is visited and
counted but does not dispatch a second Serialize call. The `serializeObject`
callback receives the archive and must route UObject references through
`archive.serializeObject`;
the module falls back to `object.serialize(archive)` only for simple host
records.

The name serializer at `0x1015ee00` receives an FName holder, looks up the
entry through `0x102961f0`, and clears only entry flag bit `0x2`. It does not
invoke a name callback during marking. `serializeName` and `serializeFName` in
the module expose this operation.

## Root-set order and masks

`SerializeRootSet` first serializes the root FArray at `0x1029e5f8` in its
current live order. It then scans `GObjObjects` by index. For a valid UObject,
the first caller mask requires any matching bit, `(flags & keepFlags) != 0`, and
the second mask requires all bits, `(flags & requiredFlags) == requiredFlags`.
`CollectGarbage` passes the caller's `keepFlags` and fixed `requiredFlags`
`0x40`. Each registry candidate is passed through a temporary local
`UObject*`, so an archive rejection cannot erase the GObjObjects slot.

The JavaScript driver preserves this order with `collectGarbage(registry,
keepFlags, services)`. It exposes `createGarbageArchive` and `purgeGarbage` for
callers that already own part of the native lifecycle. Its exported constants
are:

| Constant | Raw value | Observed use |
| --- | ---: | --- |
| `GC_FLAGS.unreachable` | `0x00000002` | Candidate bit cleared by a successful object mark; set on every name during archive construction. |
| `GC_FLAGS.archiveSerialize` | `0x00000040` | Candidate bit retained from the mark constructor; permits reflected Serialize recursion and is the fixed root-scan required mask. |
| `GC_FLAGS.archiveMark` | `0x00000042` | Constructor OR mask for valid UObject records. |
| `GC_FLAGS.archiveExcluded` | `0x00000400` | Object archive exclusion from the `%dh` test. |
| `GC_FLAGS.native` | `0x04000000` | Purge's separate native-object gate. |
| `GC_FLAGS.serializeRoute` | `0x40000000` | Cleared before Serialize; a clear marker after Serialize is diagnosed. |

## Purge order

`PurgeGarbage` starts by testing the startup `NOGC` parameter at
`0x101e5594`. When set, it logs “Not purging garbage” and returns before
setting the collection-active global. Otherwise it logs “Purging garbage”,
sets `0x102a264c = 1`, and performs three index-ordered passes over the live
registries:

1. The object destruction pass visits every non-null GObjObjects slot and
   counts it. Entries with bit `0x2` set are candidates for
   `ConditionalDestroy` (Core thunk `0x10102270`, body `0x1014fdb0`). Entries
   with raw bit `0x04000000` are skipped unless the ProcessRegistrants gate
   `0x101e559c` is set. The callback is called once per candidate in array
   order.
2. The final-release pass again visits GObjObjects in index order. It selects
   bit-`0x2` entries without raw `0x04000000` and invokes the class scalar
   deleting destructor through the equivalent of vtable `+0x0c`, with argument
   `1`. The callback is named `finalDelete(object, 1)` in the module. It must
   perform class cleanup before Core's final UObject release; see
   [script-object-release](script-object-release.md).
3. The name pass visits GNames in index order. It selects entries with flag
   `0x2` and without raw `0x04000000`, logs the original index/text diagnostic,
   and calls `FName::DeleteEntry` (Core thunk `0x10102680`). The module invokes
   `deleteName(index, name)` only after both object passes, preserving the
   destruction-before-name order. [The FName module](script-names.md) supplies
   the recovered DeleteEntry body, including hash unlinking, allocator release
   and the free-name index stack.

Core resets `0x102a264c` to zero after the name pass and reports the object
pre-count, destroyed count, and reference counter. The module sets a host
`registry.garbageCollecting` flag or calls `setGarbageCollecting`; it resets the
flag in a `finally` block if a required hook throws. The original binary does
not show an entry test that prevents a nested Purge; per-object re-entry is
guarded by `ConditionalDestroy`, so a host must keep that guard in its supplied
callback.

The module requires `conditionalDestroy`, `finalDelete` (or `deleteObject`), and
`deleteName` services. It does not silently skip those hooks. Native-class
destructors are selected by the host's `finalDelete` callback; the generic
driver only supplies the original ordering and scalar argument. Native-flagged
objects remain in the registry when `0x101e559c` is clear, matching the two
independent native gates in the original passes.

`AddToRoot` (body `0x10157400`) appends a pointer to the root FArray without
changing object flags; `RemoveFromRoot` (body `0x101574b0`) removes the first
matching pointer. The driver leaves registry slots and root-array ownership to
those explicit host operations. `ProcessRegistrants` (body `0x10152a40`) is a
separate outermost-depth driver that sets `0x101e559c` before invoking Purge;
the JavaScript registry can represent that gate as `registrantsActive: true` or
through `services.nativePurgeEnabled`.

## Validation and boundaries

`test/script-gc.test.mjs` checks a reachable two-object cycle, an unreachable
object, a referenced and unreferenced name, root-mask selection, raw excluded
root holder nulling, and the required destruction → scalar release → name deletion
order. It uses fixture callbacks for the reflected serializer and native
destructor boundaries. It does not claim that those callbacks implement the
full native class graph.

Both reference operators return the archive itself (`1015ecd8` for objects,
`1015ee00` for names), allowing the original metadata helpers to chain calls.
The script storage bridge likewise returns itself. A null object pointer is
valid; a null FName-entry binding is not. Even `None` must resolve to its actual
index-zero name entry, as the native name operator always dereferences GNames.

The collector's MapName and MapObject virtuals are different from its marking
operators. Vtable `1017a2f0` has `+20 ->10101541 ->10106960` and
`+24 ->10102c84 ->10106980`; both bodies are `xor eax,eax; ret 4`. They
return zero without inspecting, resolving or marking the argument. The native
archive and typed bridge now expose those operations for the
[tagged-property measuring archive](script-property-measure-archive.md).
The original Actor.Owner property is checked through this archive and the real
collector: measurement counts four bytes without a mark visit, then the real
operator clears the excluded pointer in the live class-default lvalue. This is
a selected-property check, not a complete UClass graph.

That Owner case uses the original `Actor+0x3c` offset recovered in
[SetOwner](script-owner.md). Its object-property tag ID is `5`: the
UObjectProperty virtual `+0x9c` (`10102d6f ->101655f0`) reads the low byte of
its class's Name word, and Core's native name initialization at
`1014bcc8–1014bcd8` hardcodes `ObjectProperty` as name index 5. The fixture
supplies these recovered layout values explicitly; package metadata alone does
not yet provide the complete native property layout.

`createScriptGcBridge` in `src/runtime/script-gc-bridge.mjs` maps canonical
script object identities and FName text values to live registered records. Its
object holder writes back through the original typed reference when the archive
clears an excluded pointer; shared references retain their identity. Missing or
stale registry bindings fail explicitly. The name operator marks the existing
entry without rewriting the script name. `test/script-gc-bridge.test.mjs` checks
this boundary with the actual FName table, including purge and index reuse;
object serialization/destruction remain recorded fixture boundaries there.

The [Actor](script-actor-serialization.md) and
[UObject](script-object-serialization.md) serializers are connected to live script
storage by `ScriptRuntime.serializeActorGc`. The original CameraPoint/Idle
integration check uses a recording archive to check header, continuation and
reflected references, plus original property/state metadata and
[bytecode operands](script-bytecode-serialization.md). A complete class/resource graph is still required before
using this composition for live-world collection. The archive exposes the
constructor's version/licensee words (`+0x04=0x44`, `+0x08=0x44c`) as well as its
GC flags so metadata serializers can follow their native version gates.

The original `IsReferenced` body (`0x101585b0`) and `AttemptDelete` body
(`0x10158660`) construct the same mark archive and add optional root-filter
behavior; they are not folded into the collection driver until their caller
contracts are needed. `SerializeRootSet`'s reflected property graph, class
destructor chains, `UnhashObject`, state-frame release, and allocator free are
also explicit boundaries owned by their respective host services.
