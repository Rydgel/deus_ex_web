# Core UStruct::Link

The installed GOTY Core.dll (SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`)
exports `UStruct::Link` at thunk `10101933`, body `10126060–1012654e`.
The source below comes from `.cache/research/Core.asm` and the PE export table.

## Property layout and call order

The receiver is a native UStruct-family record; arguments are FArchive and an
integer controlling layout recomputation. A zero argument, used by UClass
registration, walks direct children without archive Preload, calls each
UProperty virtual `+68` with the archive and previous direct property, then
restores that property's saved Offset `+48`. It preserves PropertiesSize `+3c`.
The first child whose Outer `+18` differs from the receiver terminates this pass.

A nonzero argument first zeros PropertiesSize. It calls GetInheritanceSuper
`+68`; if nonnull, it calls that virtual again for archive Preload `+10`, then
again for the superclass GetPropertiesSize `+64`, rounded up to four bytes.
It preloads each direct child before the Outer check and property-type test.
After a property's Link call, PropertiesSize becomes
`Offset + ElementSize(+38) * ArrayDim(+34)`. The final size is aligned to four.
The prior-property argument changes only after a property, not every child.

The UStruct, UState and UClass GetInheritanceSuper bodies (`1010f7a0`,
`10110500`, `10111580`) return `+28`. UFunction's override `1010ff00` returns
null even when SuperFunction is nonnull. An adapter must preserve that virtual
distinction. UStruct GetPropertiesSize `1010f7c0` reads `+3c`.

## Reference and property chains

The body then builds these live singly linked lists, clearing each final tail:

| Struct head | Property next | Selection | Original iterator |
| --- | --- | --- | --- |
| `+58` | `+60` | UObjectProperty ancestry (`102a61f0`) | `10102d3d ->1012b260` |
| `+5c` | `+60` | UStructProperty ancestry (`102a3ef0`) | `101028f6 ->1012b2e0` |
| `+60` | `+4c` | all UProperty ancestry (`102a7af0`) | `10102f9a ->1012b1e0` |
| `+64` | `+50` | property flag `4000` | same property walk |
| `+68` | `+54` | property flag `400000` | same property walk |

Each iterator follows Children `+38`, Next `+2c`, then the virtual inheritance
super and its Children. It tests each candidate's Class `+24` and Class Super
`+28`, preserving derived-before-inherited order. The first two entire passes
finish before the third begins. In the third pass, per-property net-condition
work precedes the destructor-chain write, config-chain write, and all-property
chain write, in that order (`10126466–101264a4`).

## Replication conditions

For a property with flag `20`, the routine reads live global `101e5544`.
Nonzero skips only this property's condition work. On zero, it stores Self in
property `+58`, constructs a fresh base FArchive (vtable `101751f8`, version
`44/44c`, flags `0,0,0,0,1,1,1`, extra `+28=0`), zero-extends the word at
property `+44`, calls GetOwnerClass `+60`, and invokes that owner's
SerializeExpr virtual `+7c` with a mutable expression cursor and this archive.
The resulting cursor is memoized by property identity.

It restarts the property iterator and considers preceding net properties. It
requires a memoized end cursor for each, compares `end - RepOffset` lengths,
then calls the preceding and current property's GetOwnerClass in that order.
Equal-length bytes from each owner's expanded Script Data `+44` are compared
with appMemcmp. Equality writes the current property's `+58` into the preceding
property's `+58`; later equal conditions therefore become the representative.
The source includes object pointers in expanded script memory, so serialized
package bytes are not an adequate substitute for this comparison.

The temporary native memo table has 12-byte entries and initially eight hash
buckets (`1012b120`); this adapter uses identity-keyed temporary storage for its
lookups and cursor values. It does not expose native temporary heap addresses
or allocator accounting. Unsupported property virtual Link bodies, expanded
script serialization, and expanded script memory remain required services
whenever reached.

## Host binding

`linkScriptStruct(record, {archive, secondArgument, services})` reads and writes
live `nativeSlots` (`src/runtime/native-slots.mjs`), or explicit `readSlot`/`writeSlot` services. Missing
fields are errors; a pointer zero is a known null. Known UStruct/UState/UClass
vtables supply the recovered inheritance-super behavior; other overrides need
`getInheritanceSuper`. `isA` and `getOwnerClass` may bind canonical host objects;
without them, the helper follows the original class/outer chains.

`linkProperty(property, archive, previousProperty)` can bind a property's native
Link virtual. By default, the recovered [scalar Link dispatcher](script-scalar-property-link.md)
handles verified Byte/Int/Float/Name/Object/Class property vtables using live
slot services, optionally supplied through `services.scalarPropertyLink`.
Other property types still require their original virtual implementation.
Nonzero layout uses `preload(object, archive)` or archive.preload.
Net-condition branches require `readGlobal`, `serializeExpression(owner, cursor,
archive)` and `readScriptBytes(owner, offset, length)`; the last must return
actual expanded bytes with current object/name operands. Unsupported property
types and missing native bindings are never replaced with empty callbacks.
