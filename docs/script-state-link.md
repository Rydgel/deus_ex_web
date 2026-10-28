# Original UState::Link

`src/runtime/script-state-link.mjs` translates the reached `UState::Link`
virtual from the installed Deus Ex GOTY `Core.dll`.  The binary is the
authority; the package readers and public engine sources are not used to fill
untraced branches.

```text
Core.dll SHA-256  8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4
UState::Link thunk  0x1010282e
UState::Link body   0x10127640
UStruct::Link thunk 0x10101933
UStruct::Link body  0x10126060
```

The body receives `(FArchive&, INT)` and returns `void`.  Its first operation
is the inherited `UStruct::Link` call at `0x10127677`, with the same archive
and second argument. The translation now calls the recovered
[UStruct linker](script-struct-link.md) by default:

```js
linkScriptState(stateOrClass, {
  archive,
  secondArgument: 0,
  services: {
    structLink: structServices,
  },
});
```

An explicit `linkStruct`/`linkUStruct` callback can override that binding.
There is no no-op fallback for the inherited call. The adapter reads the
live `+0x28` Super only after `linkStruct` returns, matching
`0x1012767c`.  `secondArgument` is validated as a signed integer and passed
unchanged; class registration reaches it as zero.  `UState::Link` itself does
not inspect the archive words.

## State hash table

After the inherited call, the body initializes the 256-entry table beginning
at `this+0x84`:

* with a non-null Super, it copies exactly `0x400` bytes from
  `Super+0x84` to `this+0x84` (`0x10127683–0x101276b0`);
* with a null Super, it zero-fills exactly `0x400` bytes at `this+0x84`
  (`0x101276b2–0x101276d1`).

The table is 256 four-byte heads.  It is the hash table used by the original
`FindObjectField` path: a child name's low eight bits select
`state+0x84+(NameIndex & 0xff)*4`, and each child chain uses `UField+0x30`.
The table is not the serialized label-entry array at `+0x44`; label decoding
and `LabelTableOffset` remain owned by the script metadata/bytecode reader.

The JavaScript adapter accepts one explicit live table representation:

* a 256-entry `record.hashBuckets`, `stateHashBuckets`, or
  `labelHashBuckets` array;
* `nativeSlots` (`src/runtime/native-slots.mjs`) holding either an array at `+0x84`, or all 256
  four-byte slots at `+0x84 + 4*i`; or
* `services.getHashBuckets`/`getStateHashTable`, `getHashBucket` plus
  `setHashBucket`, or `allocateHashBuckets` with a 256-entry `get`/`set`
  adapter.

The native UClass constructor does not initialize the +0x84 block.  A
`nativeSlots` host must therefore write all 256 raw slots before this
call.  Undefined source words are rejected rather than guessed as zero.  A
logical JavaScript array uses `null` for the zero pointer; a typed array or
raw native word storage uses numeric zero.  The same storage remains live
after the call and is returned as `hashBuckets`.

## Child enumeration and writes

The child scan starts from `this+0x38` and follows `+0x2c`.  The helper called
by the body at `0x101276e7` is `0x101015a5 -> 0x1012b590`.  That iterator
accepts only objects whose class ancestry contains **Core.Struct**, identity
`0x101f2618`.  Thus the state table receives direct `UFunction` and `UState`
children; ordinary `UProperty`/`UField` children are skipped.  When a chain
has no remaining Core.Struct child, the helper invokes
`GetInheritanceSuper` through slot `+0x68` and starts at that struct's
`+0x38` Children.  The state-link caller then compares the candidate's
`+0x18` Outer with the original state.  A first candidate from an inherited
struct fails that comparison and ends the scan without reading its `Next`.

For each direct candidate, the native order is:

1. read the candidate FName index at `+0x20` and mask it with `0xff`;
2. read the current head from the selected `+0x84` bucket;
3. write that head to the candidate's `+0x30` hash-next word;
4. write the candidate pointer to the selected state bucket;
5. read the candidate's `+0x2c` Next and continue the iterator.

`linkScriptState` records those writes as `write-hash-next` and
`write-hash-head` operations, and returns the ordered `linkedChildren` list.
Name input must be a numeric FName index or an explicit `getNameIndex`
result; a short name string is not hashed with a fabricated value.  Child
class testing uses `services.isA` when supplied, otherwise an explicit
boolean `isStruct` predicate or a raw class ancestry ending at Core.Struct.
Pointer fields retain the live record object (including its `nativeSlots`);
numeric native addresses are used only for identity comparisons.

## Metadata and unsupported branches

`UState::Link` does **not** write `ProbeMask` (`+0x6c/+0x70`), `IgnoreMask`
(`+0x74/+0x78`), `StateFlags` (`+0x7c`), or `LabelTableOffset` (`+0x80`).
These serialized state fields are deliberately returned unchanged by the
metadata reader; `metadataWrites` and `probeMaskWrites` are empty in the
link result.  The +0x84 table writes above are the only state-specific writes
in the traced body.

The state-specific body does not decode label entries or invent an absent
native table; its inherited UStruct linker owns property Link dispatch.
Missing archive, reached property-link services, child
layout, FName index, Outer, Next, or hash-table storage bindings fail with an
explicit error at the reached boundary.  The evidence is for this GOTY
`Core.dll` image only.
