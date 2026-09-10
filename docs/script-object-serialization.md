# GC-mode UObject serialization

`src/runtime/script-object-serialization.mjs` implements the collector archive
path of the installed GOTY `System/Core.dll`.
The binary used for the trace has SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`.
This module is a host adapter: the caller supplies live UObject/FName lvalues
and the collector archive supplies mark/recursion policy.  It does not
implement save, load, network, tagged-property, or native subclass serializers.

## Native order

The exported UObject Serialize thunk `0x1010178f` enters body `0x10150210`.
The native registration table confirms that `0x101f1c18` is
`Core.Class` (`UClass::PrivateStaticClass`, registration `0x10128750`), while
the serialized `Core.Object` class identity is `0x1029e0d0`; the special
vtable gate below therefore applies to class objects, not ordinary UObject
instances.
The native UObject slots are StateFrame `+0x0c`, Linker `+0x10`, retained
linker/outer index `+0x14`, Outer `+0x18`, ObjectFlags `+0x1c`, Name `+0x20`,
Class `+0x24`, and reflected storage after `+0x28`.

The collector constructor at `0x1015eac0` installs vtable `0x1017a2f0` and
writes archive words `+0x0c`, `+0x10`, `+0x14`, `+0x18` to zero and
`+0x1c`, `+0x20`, `+0x24` to one.  `serializeGcObject` validates this exact
state; other FArchive modes have different branches and must use a separate
serializer.

The collector vtable's `+0x10` Preload entry is `0x101011cc`; that thunk jumps
to `0x101068e0`, whose body is `retl $0x4`.  Preload is therefore a native
no-op for this archive.  The adapter accepts an optional `preloadObject` hook
for hosts that need an observable trace, while omitting the hook preserves the
installed binary's behavior.

At `0x1015023b–0x1015024f`, UObject::Serialize ORs
`ObjectFlags` with `0x40000000` before any archive callback.  The collector
archive clears this route marker before dispatch and checks it after the
virtual Serialize returns.  The module deliberately leaves the bit set after
callbacks so the archive can diagnose a missing base serializer.

For the collector's zero-mode words, the identity sequence is unconditional
and is kept in this order:

1. Preload the Class through archive `+0x10` (unless the Class is the native
   hard-coded `Core.Class` metaclass at `0x101f1c18`).
2. Archive Name through archive `+0x1c`.
3. Archive Outer through archive `+0x18`.
4. Archive Class through archive `+0x18`.
5. Archive Linker through archive `+0x18`.

The first four entries are not a metadata-name lookup.  `layout.name`,
`layout.outer`, `layout.class`, and `layout.linker` must each be a mutable
`{get,set}` holder (or a callback returning one).  Name is required in the GC
path: the collector's `0x1015ee00` name operator clears the FName entry's
unreachable bit.  It is therefore not safe to use the earlier object-only
header helper, which allows the Name callback to be absent.

## FStateFrame

The body enters the frame path when `FArchive+0x14 == 0` and
`ObjectFlags & 0x02000000` is set.  If StateFrame `+0x0c` is null, the native
allocator creates a 0x28-byte frame.  Its body writes the current Class to
`+0x04` (the first archived frame object, named Node below) and `+0x18`, the
object to `+0x08`, `+0x0c/+0x10/+0x14` to zero, and the two `+0x1c/+0x20`
raw words to `-1`; it does not write `+0x24` before the first raw archive call.
It then stores the frame back in the object.  The host must provide
`createStateFrame(object, classValue, context)`
to cross that allocation boundary; this module does not fabricate allocator
identity or vtable state.

With a frame present, the exact archive order from `0x10150315–0x1015034e`
is:

1. `Node` (`FStateFrame +0x04`) through archive `+0x18`.
2. `State`/current state function (`+0x18`) through archive `+0x18`.
3. Probe mask (`+0x1c`, 8 raw bytes) through archive `+0x04`.
4. Latent/action word (`+0x24`, 4 raw bytes) through archive `+0x04`.

When the post-archive Node is non-null, the native body preloads it through
archive `+0x10`.  It then represents `Frame+0x0c` as a code offset relative to
Node `+0x44`, with Node `+0x48` as the span.  A null code pointer becomes
offset `-1`.  The original range assertion at source line 0x200 is guarded by
nonzero `FArchive+0x10`, so it is not reached in GC mode; this implementation
still reports a post-archive out-of-range offset and stores it, matching the
native diagnostic-and-store sequence.  If the post-archive Node is null, the
native branch writes `Frame+0x0c = null` and skips preload/code conversion.

`FCompactIndex` (`0x10102950` -> `0x10159b50`) takes its GC branch because
archive `+0x0c` and `+0x10` are zero.  That branch calls raw archive
`+0x04` for exactly four bytes, so `serializeRaw(reference, 4, context)` is
the correct host boundary; no compact variable-length encoding is performed
in this mode.  After the call, `-1` restores a null code pointer and any other
offset writes `Node+0x44+offset`.  An out-of-range post-archive offset is
reported through `onCodeOffsetWarning` and is still written, matching the
native diagnostic-and-store sequence.

When the frame flag is clear but StateFrame `+0x0c` is still non-null, the
branch at `0x10150457–0x10150467` frees that frame and stores null back to the object slot.  The
host supplies `freeStateFrame(frame, object, context)` for this operation.
`frameLayout` (or `frameSlots`) names the `node`, `state`, `probeMask`,
`latentAction`, and `codePointer` holders explicitly.  `nodeCodeRange(node)`
returns `{start, size}` in the host's code-pointer representation.  The code
slot is required for every present frame because the null-Node branch clears
it even when no code conversion follows.

## Reflected body and size call

After the frame path, the body reloads the Class pointer.  For GC's zero
archive words, the conditional Class vtable `+0x74` tagged-property gate at
`0x10150435–0x1015044c` is skipped.  Unless the class is the hard-coded
`Core.Class` metaclass at `0x101f1c18`, Class vtable `+0x70` calls
`UStruct::SerializeBin` (`0x1010285b` -> `0x10126610`).

Callers may provide `serializeProperties(object, archive, context)` for this
class slot.  Otherwise the module invokes the established typed walker with
`fields` and `propertyReference(field)`.  That walker retains the original
property-link order, raw `SkipSerialization`/`Transient` gates, fixed-array
stride, nested struct, UObject/Class, and Name callbacks documented in
`script-reference-serialization.md`.

Finally, the body calls Class vtable `+0x64` for the serialized property size,
then archive `+0x14` (`FArchive::CountBytes`) with that same size twice for
both ordinary objects and the `Core.Class` metaclass
(`0x101504a2–0x101504b2`).  `getPropertiesSize(object)` is the explicit host
adapter for `+0x64`; `countBytes(first, second, context)` observes the two
arguments.  The installed base `FArchive::CountBytes` body at `0x10106900`
is a no-op, so an absent count adapter is a faithful no-op, while a missing
property-size adapter remains an explicit error.

## API and limits

The main entry point is:

```js
serializeGcObject(object, archive, {
  layout: {
    flags, name, outer, class, linker, stateFrame,
  },
  frameLayout: {node, state, probeMask, latentAction, codePointer},
  createStateFrame,
  nodeCodeRange,
  serializeRaw,
  serializeProperties, // or fields + propertyReference
  getPropertiesSize,
  countBytes,
  isCoreClassObject,
});
```

The return value reports `archiveState`, the final route-marker bit and
flags, header/state-frame reference counts, raw/preload calls, code-offset
warnings, reflected property result, serialized size, and CountBytes result.
The focused test
`test/script-object-serialization.test.mjs` checks the source order, exact
raw widths, code-offset round trip, route marker, stale-frame release, and
Core.Class metaclass gate.

Unresolved native allocation, Node code storage, FName-table writes, and
class-specific Serialize overrides remain explicit adapters.  Dynamic array
serialization, save/load archives, and the nonzero FArchive branches are
outside this bounded GC implementation.
