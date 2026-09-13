# Native object property initialization

The authority is installed GOTY Core.dll, SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`.
UObject::InitProperties is export thunk `0x1010102d`, body `0x101520d0`.
The accepted StaticAllocateObject call is already recorded in
[construction](script-construction.md): Data is fresh storage, Count and
PropertySize are the class size, Class is the selected class, and Defaults
is the explicit template or null. This adapter preserves the existing header;
it does not allocate/register an object or construct class defaults.

The original five stack arguments are Data, Count, Class, Defaults,
PropertySize. Count must cover the `0x28`-byte UObject header. At
`0x10152117..0x10152144`, a nonnull Defaults argument bypasses class default
selection. Otherwise a nonnull Class supplies Defaults.Num at `+0x4d8`;
only when Num is nonzero does the body read Defaults.Data at `+0x4d4` and
replace PropertySize with Num. A null Data pointer skips copying.

For a usable source, `0x10152146..0x10152180` copies exactly
`PropertySize - 0x28` bytes from Defaults+0x28 to Data+0x28, first in four-byte
units, then remaining bytes. It does not copy the header or clamp this range
to Count. The supported valid-storage path rejects insufficient storage
explicitly. `0x10152185..0x101521a9` zeroes the remaining destination suffix
through Count, starting at PropertySize if a copy happened, otherwise 0x28.

After the copy/zero operations, a nonnull Class supplies the constructor-linked
property head at `+0x68`. For each property, `0x101521b8..0x10152203`:

1. Read signed Offset at `+0x48`; skip its body when Offset >= PropertySize.
2. Read ElementSize at `+0x38` and ArrayDim at `+0x34`, and zero their product
   at Data+Offset.
3. Read Offset again and invoke property virtual `+0x90` CopyCompleteValue
   with destination Data+Offset and source Defaults+Offset.
4. Read the live Next pointer at `+0x54` after that call.

The list is not every reflected property: it is the owning/constructor-linked
subset established by UStruct::Link. Raw pointers such as GC.underlineTexture
remain from the first byte copy. Callback bodies use the existing recovered
property-copy dispatcher, with explicit native heap services for owning values.
Invalid sizes, missing raw class/property slots, cycles, and a null source
reached by an eligible owning property remain explicit errors.

`initializeNativeObjectProperties` exposes class/property reads through
`read(object, offset, kind)` and accepts Uint8Array storage. Native pointers
are canonical records or null; the Defaults.Data slot returns its byte storage.
The output records the selected source and size, not a newly allocated object.
Focused unchanged-native references establish explicit-template precedence,
class-default fallback, suffix zeroing, header preservation, and the live
owning-property callback/Next sequence. Allocation, class-default loading,
registration and native constructor dispatch remain separate operations.
