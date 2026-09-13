# Typed script values and lvalues

`src/runtime/script-values.mjs` is the small typed-value boundary used by the
script VM. It takes an already linked field record, normally
`{ key, metadata }`, and getter/setter functions supplied by the object
runtime. It does not resolve packages or invent a JavaScript class layout.

The authority for the copy and array rules is the installed Deus Ex GOTY
`System/Core.dll`, SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`.
`execArrayElement` at `0x101028dd` enters `0x1012ef90`: it evaluates the
index before the array lvalue, reads `ArrayDimension` at property `+0x34` and
`ElementSize` at `+0x38`, logs an invalid signed index, clamps it to the first
or last element, and computes `base + index * ElementSize`. A non-null result
uses the property vtable `+0x8c`, `CopySingleValue`.

The ordinary local, instance, and default variable handlers at
`0x1012ebc0`, `0x1012ec60`, and `0x1012ed00` use the property vtable `+0x90`,
`CopyCompleteValue`. The generic **CopySingleValue** body at `0x10165560`
copies one `ElementSize` unit, while **CopyCompleteValue** at `0x10165600` loops over all
`ArrayDimension` elements and invokes the single-value copy. Consequently a
plain fixed-array field reference reads and writes the complete array; only an
indexed reference selects one element.

The native generic complete-copy loop rereads `ArrayDim` after each virtual
call and `ElementSize` before each iteration (`10165617`–`10165634`). Its
single-copy body uses forward `rep movsl` followed by `rep movsb`
(`1016557e`–`10165582`), not an overlap-safe memmove. A raw storage adapter must
preserve those reads and dword/byte writes; the logical VM copies below do not
represent overlapping native byte addresses.

`UObject::InitProperties` at `0x101520d0` copies an authored class default and
zeroes the remaining property storage. `zeroValue` models the fresh zeroed VM
slot. Authored tagged defaults remain the responsibility of the class loader.

Class default variables name writable class storage. `execDefaultVariable`
(`10101690` → `1012ed00`) reads the receiver's Class `+24`, its defaults data
`+4d4`, and the current operand's UProperty Offset `+48`. It stores their sum
as the assignment address at `101e32f8` and optionally copies the value through
property virtual `+90`. Reads and assignments therefore use the same class
default lvalue; they do not update already copied instance storage.

The typed runtime stores a class default as a field/index map. Updating one
replaces that field's value map, retaining UObject identity and the established
array/struct value-copy rules. Attached instances retain the default snapshot
from their attachment time for fields not yet materialized; constructed objects
already copy all reflected defaults through InitProperties. The binary reference
walker can consequently visit writable class defaults without redirecting
existing instance storage. Native default header fields require the separate
default-object construction binding; the original Core.Object header properties
all carry the skip-serialization bit `1000` and are omitted by SerializeBin.

The module exports four operations:

```js
zeroValue(field)
copyValue(field, value)
propertyReference(field, get, set)
arrayReference(index, reference, warning)
```

For example, a linked three-element float property can be used as follows:

```js
const field = { key: 'Core.Object.SomeValues', metadata: {
  type: 'float', arrayDim: 3, arrayDimension: 3,
} };
let storage = [1, 2, 3];
const whole = propertyReference(field, () => storage, value => { storage = value; });

whole.get();                    // [1, 2, 3], a fresh array
arrayReference(-1, whole, event => warn(event)).get(); // element 0, after warning
arrayReference(2, whole).set(9); // storage becomes [1, 2, 9]
```

Every reference retains the original `field`, `metadata`, and `key`. It also
reports `arrayDimension`, `elementSize`, `arrayIndex`, and `addressOffset`.
An ordinary fixed-array reference has `arrayIndex: null`,
`addressOffset: 0`, and an `array` descriptor containing the complete
dimension. An indexed reference has the selected index and its byte stride
offset, plus `array.container` pointing at the whole-array reference. The
logical values returned by `get` are copied, and `set` stores a new typed copy,
so mutating a returned vector or array cannot mutate storage through a stale
JavaScript alias.

`arrayReference` accepts an index thunk as well as a value. The thunk is called
before the reference is inspected, preserving the original index-first order.
The original signed integer is represented by the VM's signed 32-bit result;
non-finite JavaScript indexes are rejected because the original expression
result is an integer. An out-of-range index calls `warning` with an object such
as:

```js
{
  type: 'ArrayIndexOutOfBounds', key, index, dimension, clampedIndex,
  field, metadata,
}
```

It then clamps to `0` or `dimension - 1`. Omitting `warning` still performs the
same clamp.

The supported scalar metadata types are `byte`, `int`, `bool`, `float`,
`name`, `string`, `object`, and `class`. Byte/int/float values use the original
8/32-bit scalar shape; names are immutable logical names (`'None'` is zero),
strings are immutable logical strings, and object/class values preserve the
linked UObject identity because the original property stores a pointer.
`Vector` and `Rotator` are supported only when the linker supplies their full
lowercase original struct identities `core.object.vector` and
`core.object.rotator`. Vectors are three float components and rotators are
three signed integer components. A short struct name is intentionally not
accepted as proof of identity. Other structs are supported after the linker
supplies the canonical lowercase `structKey` and
`metadata.structFields = [{ key, name, metadata }, ...]` records from
`readStructMetadata`. Their VM value is an object keyed by each member's full
`key`; zeroing and copying recurse through those typed member records, and
object/class members retain the original linked object identity. A missing
member record or unresolved nested type raises `UnsupportedScriptValueError`.
Numeric `metadata.bitMask` is honored for
`BoolProperty` references: reads expose the selected logical bit and writes
preserve unrelated bits in the backing dword.

The focused real-data struct is `Engine.Actor.PointRegion` (Engine.u v68,
export 1075). `readStructMetadata(engine, 1075)` returns
`structKey: 'engine.actor.pointregion'` and the three linked members
`engine.actor.pointregion.zone` (`object`), `.ileaf` (`int`), and
`.zonenumber` (`byte`) in UField.Next order. Its serialized 20-byte payload
contains the common `None`, base/next/script/children/name/line/text/script
header and no extra struct fields. Header-only callers can pass
`{ includeChildren: false }`; unresolved inherited or imported child links are
then retained for the AssetStore linker, while a complete local value shape
requires `structFields`.

`ArrayProperty` (dynamic arrays), `MapProperty`, unresolved `StructProperty`
identity/fields, nested arrays, and a `FixedArrayProperty` without linked
`innerMetadata` and a fixed count throw `UnsupportedScriptValueError` with
code `UNSUPPORTED_SCRIPT_VALUE`. Fixed arrays of linked primitive or struct
values are copied as complete arrays. A generic struct's physical byte stride
is left null until the linker supplies an established `elementSize`. The
[loaded struct linker](script-struct-layout.md) now supplies that size from the
recovered native Link bodies for scalar/string/bool/nested struct members;
unlinked layouts still reject indexing explicitly. Generic authored defaults use the linked
[SerializeBin struct decoder](script-struct-values.md), including strings and
canonical object/class references. Unresolved member serializers remain an explicit
loader error and are never replaced with a guessed object.

The generic struct behavior follows the installed original Core.dll
(`SHA-256 8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`):
`UStructProperty::CopySingleValue` at `0x10169c40` visits each linked
UProperty and dispatches its `CopyCompleteValue` slot; the inherited generic
`UProperty::CopyCompleteValue` at `0x10165600` walks every `ArrayDimension`
with `ElementSize` stride; and `UStructProperty::DestroyValue` at
`0x10169cf0` dispatches each member's destructor recursively. The JavaScript
object shape above is the linked VM representation of those field-by-field
operations; it does not claim an untraced native padding layout.
