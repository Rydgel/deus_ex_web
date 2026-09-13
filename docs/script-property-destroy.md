# `UProperty::DestroyValue`

This note records the property-value destruction contract recovered from the
hash-verified Deus Ex GOTY `System/Core.dll` (SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`).  The
raw disassembly is in `.cache/research/Core.asm`; the focused native replay is
`scripts/native-property-destroy-oracle.py`.  Public Unreal headers are not
the authority for this translation.

The virtual is property vtable slot `+0x94`.  The relevant bodies are:

| Property | Body | Native operation |
| --- | ---: | --- |
| `UProperty` (base; inherited by scalar, bool, name, object, class) | `0x10165590` | `retl $0x4`; no storage access |
| `UStructProperty` | `0x10169cf0` | walk linked struct children recursively |
| `UFixedArrayProperty` | `0x101682e0` | walk `ArrayCount` inline elements |
| `UArrayProperty` | `0x10168bb0` | destroy owned elements, free and clear `TArray` |
| `UMapProperty` | `0x10168f50` | `retl $0x4`; no storage access |
| `UStrProperty` | `0x10167ba0` | destroy each inline `FString` |

The browser dispatcher is
`src/runtime/script-property-destroy.mjs`.  It accepts a linked property
record and a mutable value reference (`{get, set}`), or a directly mutable
logical/native-shaped value.  `services` supplies storage references and the
allocator boundary for values whose native data pointer is represented.  A
missing required storage or allocator service raises
`UnsupportedScriptPropertyDestroyError`; the module does not fabricate a
pointer, clear unrelated fields, or substitute a resource operation.

## Native layouts and offsets

The `FString` and `TArray` layouts in this build are both the standard
`Data, ArrayNum, ArrayMax` ordering:

| Record | `+0x0` | `+0x4` | `+0x8` |
| --- | --- | --- | --- |
| `FString` | character data pointer | `ArrayNum` | `ArrayMax` |
| `TArray` | element data pointer | `ArrayNum` | `ArrayMax` |

This is established by `FArray::Realloc` (`0x10145440`), which multiplies
`this+0x8` by its element size, and `FArray::Remove` (`0x101454f0`), which
writes the post-removal count to `this+0x4`.  Earlier SerializeItem notes that
called FString `+0x4` `ArrayMax` and `+0x8` `ArrayNum`; that labeling is stale.

The property fields used by these bodies are:

| Field | Offset |
| --- | ---: |
| `ArrayDim` | `+0x34` |
| `ElementSize` | `+0x38` |
| `PropertyFlags` | `+0x3c` |
| `Offset` | `+0x48` |
| destructor-chain `Next` | `+0x54` |
| `Inner` / struct reference | `+0x5c` |
| fixed-array `ArrayCount` | `+0x60` |
| inner struct destructor/constructor-link head | `+0x68` |

The dynamic-array inner property flag `0x00400000` is the linked
`CPF_NeedCtorLink` bit observed by the native body.  The implementation names
the bit `needDestruction`; it does not infer ownership from a JavaScript value
kind.

## Per-type behavior

`UProperty::DestroyValue` and `UMapProperty::DestroyValue` return immediately.
The same no-op body is the verified base implementation for the scalar,
`BoolProperty`, `NameProperty`, `ObjectProperty`, and `ClassProperty` records.
Destroying these values does not zero a number, clear an object reference, or
walk a struct member merely because that member has a scalar type.

`UStrProperty::DestroyValue` reads `ArrayDim` and `ElementSize`, then invokes
the `FString` destructor once per element in increasing element order.  The
FString destructor (`0x101075a0`) performs this sequence for each record:

1. Write `ArrayNum (+0x4) = 0` and `ArrayMax (+0x8) = 0`.
2. Call `FArray::Realloc(2)`.  Because `ArrayMax` is already zero, the
   allocator receives zero bytes and the original allocation tag pointer
   `0x101ab50c`; the returned pointer is stored back in `Data`.
3. Call `FArray::Remove(0, 0, 2)`, which returns immediately.
4. Read the current `Data` pointer.  If it is non-null, call `GMalloc`
   virtual `+0x08` (`Free`) on that pointer.
5. Write `Data (+0x0) = 0`, `ArrayMax (+0x8) = 0`, then `ArrayNum (+0x4) = 0`.

The native body does not read text or preserve an authored default.  A
logical JavaScript string has no native allocation pointer; the dispatcher
therefore supports it as an explicit logical host value and sets it to `''`,
without claiming that a native allocator call occurred.  A native-shaped
FString record with a pointer requires `services.realloc` and, when Realloc
returns a non-null pointer, `services.free`.

`UFixedArrayProperty::DestroyValue` reads `ArrayCount (+0x60)` and `Inner
+0x5c`.  For each index `i` from zero through `ArrayCount - 1`, it invokes
`Inner.DestroyValue(Data + i * Inner.ElementSize)`.  The fixed-array body does
not free or reset the containing inline storage.  It invokes Inner regardless
of Inner's `NeedCtorLink` flag.

`UArrayProperty::DestroyValue` reads `Inner (+0x5c)` and the current `TArray`
header.  If `Inner.PropertyFlags & 0x00400000` is set, it invokes
`Inner.DestroyValue` for `ArrayNum` elements at `Data + i * Inner.ElementSize`
in increasing order.  It then always performs the dynamic-container cleanup:

1. If `Data` is non-null, call `GMalloc` virtual `+0x08` (`Free(Data)`).
2. Write `Data (+0x0) = 0`, `ArrayMax (+0x8) = 0`, and `ArrayNum (+0x4) = 0`.

An inner scalar still leaves each scalar element untouched, but the outer
array data allocation and all three header words are cleared.  The body does
not recurse into an unowned inner property.

`UStructProperty::DestroyValue` reads the inner `UStruct`'s destructor/constructor-
linked property head at `+0x68` (distinct from the ordinary `UStruct Children`
head at `+0x38`), then follows each child through property `Next (+0x54)`.  For every
child and every outer `ArrayDim` index it invokes the child destructor at:

```text
Data + outerIndex * StructProperty.ElementSize + child.Offset
```

The child chain order is the linked order supplied by `UStruct::Link`; no
reverse pass is performed.  The struct body does not clear its own bytes.  A
child with the base no-op destructor therefore leaves its numeric/object
storage unchanged; owning children recurse through this same dispatcher.

## Dispatcher boundary

The canonical entry point is:

```js
destroyScriptProperty(property, reference, services = {}, context = {})
```

`reference` can be a `{get, set}` lvalue, a logical string/array/struct value,
or a native-shaped record.  The following optional services are recognized:

* `readSlot` / `writeSlot` resolve linked property fields by their native
  offsets when aliases are not available.
* `elementReference(reference, index, property, details)` resolves an Inner
  element for a raw pointer or other host storage.
* `memberReference(reference, property, details)` resolves a struct child for
  raw storage.  A logical keyed struct automatically uses the child's linked
  key/name when present.
* `structFields(struct, details)` supplies a linked destructor-chain sequence
  when the struct record does not expose `structFields`/`fields`; it may return
  an explicit array or a raw `+0x68` head.  `nextProperty` may supply the
  `+0x54` chain step.
* `realloc(pointer, bytes, details)` and `free(pointer, details)` implement the
  explicit `GMalloc` virtuals.  They may instead be provided as
  `services.allocator.realloc/free`.
* `trace(event)` or a `trace` array records dispatcher operations for focused
  verification.  Tracing is observational and does not replace a required
  service.

Logical keyed structs are resolved by a child `key`/`name` in the supplied
value object.  They may omit the native member `Offset` and the outer
`ElementSize`; the returned trace keeps `addressOffset: null` in that case.
Raw/native struct storage still requires a member reference adapter (and the
linked offsets/stride it uses).  The linked child chain is consumed lazily, so
`Next (+0x54)` is read after the current child's complete ArrayDim pass, as in
the native loop.  Explicit field arrays supplied by a host are treated as
already resolved orderings.  An absent `+0x68`/`+0x54` slot is unsupported;
only an explicit null means the native chain has ended.

For direct JavaScript arrays and strings, the host representation has no
native pointer to release.  The dispatcher mutates their logical value (array
to empty storage, string to `''`) and reports `storage: 'logical'`; it calls
an allocator only for a numeric/native pointer or when an explicit host
adapter exposes one.  Raw byte buffers and unlinked child/Inner records stay
unsupported until a reference service identifies their native address.

## Native oracle evidence

`native-property-destroy-oracle.py` runs all six bodies in an x86 Unicorn
emulator against the original DLL.  Its fake GMalloc records calls while
returning the old Realloc pointer, so the conditional FString Free path is
visible.  The observed cases are:

* primitive and map sentinel words unchanged;
* two FString elements each issue `Realloc(pointer, 0, 0x101ab50c)`, then
  `Free(pointer)`, and end as `[0, 0, 0]`;
* an unowned scalar Inner leaves element words unchanged while the TArray
  header is cleared and its data is freed;
* an owned FString Inner destroys each element before freeing/clearing the
  outer TArray;
* FixedArray and Struct FString members recurse in increasing index order and
  leave no outer storage-reset operation.

Run it with:

```sh
.cache/native-probe-env/bin/python scripts/native-property-destroy-oracle.py \
  'Deus Ex GOTY Edition'
```

The bounded JavaScript/native comparison invokes that oracle and checks seven
reference cases across the six bodies. Allocator events compare both order
and pointer identity, mapped to the original input's element/container roles;
header and element results are compared directly with the native output:

```sh
DEUS_EX_NATIVE_PYTHON=.cache/native-probe-env/bin/python \
  node scripts/validate-property-destroy.mjs
```

`ScriptRuntime.exitProperties` now supplies the linked destructor-chain field
references and the parsed struct `+0x5c`/`+0x68` adapter.  GC, object-registry
release, native subclass destructors, and unresolved allocator/resource
implementations remain outside this module.
