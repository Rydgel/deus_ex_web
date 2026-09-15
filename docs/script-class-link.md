# Core UClass::Link contract

This document records the class-link path reached by `UClass::Register` in
the installed Deus Ex GOTY `Core.dll` (SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`).  The
source is `.cache/reference/Core-rng.asm`; addresses below are image virtual
addresses from that file.  The JavaScript translation is
[`src/runtime/script-class-link.mjs`](../src/runtime/script-class-link.mjs).

## Entry and archive

UClass vtable `0x101758f4` has the `Link` entry at `+0x6c`.  The PE export
thunk `0x10102f2c` jumps to the body at `0x10127e30`.  The body is a
`thiscall` with `(FArchive&, INT)`, returns no value, and ends with `ret 8`.
`UClass::Register` body `0x10127800` constructs the archive on its stack and
calls this slot with the second argument `0`.

The local archive starts with vtable `0x101751f8` and these words:

| archive offset | value |
| --- | ---: |
| `+0x04` | `0x44` |
| `+0x08` | `0x44c` |
| `+0x0c` | `0` |
| `+0x10` | `0` |
| `+0x14` | `0` |
| `+0x18` | `0` |
| `+0x1c` | `1` |
| `+0x20` | `1` |
| `+0x24` | `1` |

`linkScriptClass` accepts the frame from the registration adapter, the
exported `CLASS_LINK_ARCHIVE_STATE` object, or the embedded `ULinkerLoad`
archive (vtable `0x1017a430`) passed by `ULinkerLoad::Preload`.  The
recovered body forwards its archive pointer and second argument verbatim to
`UState::Link` (`0x10127e59`-`0x10127e68`: `push eax`/`push ecx`/`call
0x1010282e`); it never reads the archive's fields, so the adapter no longer
validates the constructor words.  A nonzero second argument selects the
load-path `UStruct::Link` mode (`Link(Ar, 1)` from `UStruct::Serialize`'s
tail on a stream archive).

## Native order

The body performs the following operations in this order.

1. It calls the inherited `UState::Link` virtual (`0x1010282e` thunk,
   `0x10127640` body) with the same archive and second argument.
2. It reads global `DWORD [0x101e5544]`.  Any nonzero value returns from
   `UClass::Link` before either class array is touched.  The translation reads
   this value after the `linkState` callback, so a callback that models native
   linking can change the live gate.
3. It calls `FArray::Empty` (`0x10102824` thunk, `0x10107190` body) on the
   class's FArray at `+0x4b0` with `(ElementSize=4, Slack=0)`.  The body sets
   `Num` to zero, `Max` to zero, then calls `Realloc(4)`.
4. It obtains the superclass FArray at `Super + 0x4a4`.  With no superclass it
   constructs a temporary empty FArray (`0x101071c0`) and destroys it after
   the copy path.  The current `+0x4a4` is reset and reserved even for that
   empty source.  If the current and source FArray addresses differ, it
   reserves the source `Num` with helper `0x10102f40` (body `0x1012b1b0`,
   element size 8), then appends one pair at a time with `0x10111c80`.  Each
   pair copies two dwords from the source: field pointer and array index.  This
   is an actual append, so the destination Num increments for every copied
   pair.
5. It walks UField children.  Helper `0x1012b610` starts with the current
   UClass and its `+0x38` Children pointer.  It follows each candidate's
   `+0x2c` Next pointer, retaining candidates whose Class ancestry contains
   Core.Field (`UField::StaticClass` thunk `0x101018c5`, body `0x1010f250`,
   identity `0x101f2b18`).  When a child chain ends it invokes the current
   struct's virtual `+0x68` (`GetInheritanceSuper`, UClass thunk
   `0x10103337`) and begins at that struct's `+0x38` Children.  A missing
   `+0x68` binding is an explicit adapter error in the translation.
6. Each retained candidate is sent through `UField::GetOwnerClass` virtual
   `+0x60` (body `0x10125bc0`).  The native body follows `+0x18` Outer until
   the object Class equals UClass's class identity `0x101f1c18`.  If that
   owner is not the UClass being linked, the body jumps directly to final
   array shrink/sort; it does not continue to later candidates.
7. The candidate is tested with `UObject::IsA` (`0x1010266c`) against
   `UProperty::StaticClass` identity `0x102a7af0` (thunk `0x10101f0a`, body
   `0x10112670`).  For a property, the native body tests `PropertyFlags` byte
   `+0x3c` for bit `0x20` (`CPF_Net`).  A net property is appended to the
   `+0x4b0` FArray with element size 4.
8. For a direct property whose `+0x18` Outer equals the current UClass, the
   native body writes the current `+0x4a8` Num to property offset `+0x46` as
   a 16-bit value.  It then appends one 8-byte pair to `+0x4a4` for each
   `ArrayDim` at `+0x34`: `{property, arrayIndex}` with indices starting at
   zero.  Inherited properties therefore retain the copied superclass pairs;
   the current class's `+0x46` is assigned from the pre-append pair count.
9. A non-property UField takes a separate special branch only when its Class
   ancestry contains Core.Function identity `0x101f1718` (UFunction
   `StaticClass` thunk `0x101019fb`, body `0x1010fcd0`).  It requires byte
   `+0x6c` bit `0x40` and a null `+0x28` SuperFunction, then appends the
   function pointer to `+0x4b0` without adding a pair to `+0x4a4`.  Other
   non-property candidates are skipped after their Next pointer is loaded.
10. At `0x10128055`, it shrinks the `+0x4b0` FArray when `Max != Num` by
    writing `Max=Num` and calling `Realloc` (`0x10145440`).  It then calls
    the hand-coded quicksort helper `0x101012bc` -> `0x1012b690` with the
    data pointer and Num.  The helper returns immediately for fewer than two
    entries.  For comparisons where both candidate `+0x10` words are nonzero,
    it compares signed `candidate[+0x14] - pivot[+0x14]`; otherwise the
    comparison is equal. The recovered [native sorter](script-net-field-sort.md)
    now implements the original partition and small-range selection-sort
    movement, including equal keys. It sorts the live array in place.

## Translation API and storage boundary

`linkScriptClass(record, options)` returns `{record, classReps, netFields,
operations, skipped, globalLinkGate}`.  `linkUClass` is an alias.  Options can
be supplied as nested `services` or flat fields. The registration adapter's
`services.classLink` binding supplies the original archive and argument zero
while preserving option getters. Do not spread an options object with a live
global-gate getter before the call: that would read it before UState::Link.
When no archive is supplied, the adapter creates a fresh copy of the exact
local archive words for that call.
The relevant services are:

* The recovered [UState linker](script-state-link.md) supplies the inherited
  call by default; `stateLink` supplies its services. An explicit
  `linkState(record, archive, secondArgument, detail)` can override that binding.
* `readGlobal(address, detail)` or `globalLinkGate` supplies the live value at
  `0x101e5544`.  A record-level `globalLinkGate` is accepted for a fixture.
* `isA`, `isProperty`, `getFieldClass`, `getClassSuper`,
  `getInheritanceSuper`, `getOwnerClass`, and `getArrayStorage` bind native
  layouts where the logical record does not expose the corresponding raw
  slots.  Explicit record fields (`classIdentity`, `superClass`, `children`,
  `next`, `outer`, `propertyFlags`, `arrayDim`, and `isProperty`) cover the
  small logical fixture path.
* `sortNetFields(data, detail)` can override the recovered native helper for
  another concrete host binding. The default uses the original algorithm,
  never JavaScript's Array.sort, and retains the backing-store identity.

Native `nativeSlots` records use the FArray triples `data/Num/Max` at
`+0x4a4/+0x4a8/+0x4ac` and `+0x4b0/+0x4b4/+0x4b8`.  Logical records may expose
`classReps` (or `replicationRecords`) and `netFields` (or `netProperties`) as
arrays or `{data,num/capacity}` FArray objects.  The adapter writes the raw
`+0x46` field value as a two-byte quantity; it does not attach an unverified
semantic name to that slot.

The implementation routes the verified property `Link` bodies through
[`script-property-link.mjs`](../src/runtime/script-property-link.mjs), including
the complex Bool/Str/Array/FixedArray/Map/Struct classes. The remaining explicit
boundary is raw native pointer/layout memory behind an unbound `nativeSlots`
FArray, plus any metadata graph that the host has not loaded. No missing
property-type linker is replaced with a no-op or an invented layout.
