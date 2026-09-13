# Original Sound constructor

The hash-verified GOTY Engine.dll USound default-constructor thunk `10303af3`
jumps to `1034cdc0`. Its normal path executes these writes and calls in order:

1. Call imported Core UObject constructor at IAT `10599b58`; the recovered
   Core constructor installs vtable `10179dfc` and preserves allocated headers.
2. Zero the embedded TArray's Data, Num and Max at Sound+34/+38/+3c.
3. Call imported FArray::Realloc at IAT `10599a20` with this=Sound+34 and
   element size 1, even though the count and capacity are zero.
4. Zero Sound+2c and +30, store this at +40, and install FSoundData vtable
   `1042999c` at +28.
5. Install USound vtable `10429580` at +0 and write float32 -1 at +4c.

The instructions are `1034cdde–1034ce17`. The body does not write format FName
+44, serialized byte count +48, or the unresolved +50 field; these retain the
caller/template values. The +30 field is zeroed but its broader lazy-loader
meaning is not established by this constructor.

`constructSoundNative` represents the embedded FSoundData/TArray as nested
logical storage. It requires the reached Realloc service and leaves allocation,
registration, default copying and package serialization to the existing object
and resource hosts. No JavaScript cleanup substitutes for Realloc. The focused
probe executes the entire original constructor with Realloc recorded as an
explicit service and compares final fields and call-time state.
