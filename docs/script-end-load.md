# Original EndLoad and metadata PostLoad

Source: installed GOTY `Core.dll`, SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`.
The contract below was recovered from its instructions before translation.
Original binaries, disassembly and probe captures remain outside Git.

## EndLoad contract

`UObject::EndLoad` thunk `0x10102f27` reaches `0x10155510`. Its normal
return is `0x1015568e`; exception reporting/unwinding is a separate boundary.

1. Assert load nest (`0x102a2650`) is positive (source line `0x90d`),
   decrement it and return if the result is nonzero.
2. Log using receiver at `0x101a7c3c`, name `0x308` and format
   `0x101af3d4`, through thunk `0x10102a95`.
3. Walk the **live** loaded-object array (`0x1029e638`, count
   `0x1029e63c`). For each object with flags `+0x1c & 0x200`, assert its
   linker `+0x10` is nonnull (line `0x91d`), then call Preload through the
   linker's embedded archive `+0xa4`, virtual slot `+0x10`. Re-read data
   and count each iteration: objects appended by Preload are visited.
4. Snapshot the resulting count. Walk the live array again, calling
   `ConditionalPostLoad` thunk `0x10101384` on **every** entry. This is a
   direct call; ConditionalPostLoad owns the flags gate and virtual dispatch.
   Re-read count after each call; assert final count equals the snapshot
   (line `0x929`). An appended entry is visited before this assertion.
5. Set loaded Num and Max (`0x1029e640`) to zero, then call original
   FArray::Realloc (`0x10101753` -> `0x10145440`) with element size 4.
   The allocator receives old data, byte count zero and tag `0x101ab50c`.
6. If import counter `0x102a2658` is nonzero, capture loader-array data
   `0x1029e608` and walk its live count `0x1029e60c`. Each linker owns
   an import array at `+0x78`, count `+0x7c`, stride 28. Clear only each
   record's Object at `+0x10` when nonnull and its object's flags lack
   `0x04000000`. Preserve SourceLinker and SourceIndex. Nulls and objects
   with that native flag remain unchanged. Reset the counter to zero.

There is no sorting or second Preload pass after PostLoad. BeginLoad does not
reset the import counter. The earlier empty-lifecycle account incorrectly
collapsed the two object passes; the first pass tests RF_NeedLoad, not
RF_NeedPostLoad.

## PostLoad contract

`ConditionalPostLoad` (`0x10101384` -> `0x1014ff70`, normal return
`0x1014ffeb`) returns immediately unless flags contain `0x01000000`.
Before calling virtual PostLoad (`vtable + 0x20`), it clears both that bit
and `0x20000000` with mask `0xdeffffff`. On return it requires
`0x20000000`; if absent, it calls GetFullName(this, 0), then error Logf
(`0x1010280b`) with receiver at `0x101a7c38` and format `0x101adce0`.
The control flow returns if that output service returns. Fatal output and
exception unwinding are explicit services, not inferred JavaScript behavior.

| Original body | Recovered work |
| --- | --- |
| UObject::PostLoad `0x1014f9b0` | OR flags with `0x20000000`. |
| UField::PostLoad `0x10125bf0` | UObject::PostLoad, then virtual Bind at `+0x5c`. |
| UStruct::PostLoad `0x10128f30` | UField::PostLoad. |
| UFunction::PostLoad `0x101291a0` | UStruct::PostLoad. |
| UClass::PostLoad `0x10127d70` | Assert ClassWithin `+0x49c` (line `0x362`), UStruct::PostLoad, then ConditionalPostLoad of the current nonnull SuperField `+0x28`. |

Class binding precedes the superclass ConditionalPostLoad call. The superclass
pointer is read after Bind. Clearing the conditional bit before dispatch also
prevents recursive ConditionalPostLoad from reentering the same object.

## Scope of integration

The translation extends StaticLoadObject's existing lifecycle with these two
passes and import cleanup. Preload, virtual PostLoad/Bind, allocator
and output edges remain explicit synchronous services. The class loader's
queued graph also contains native resources; completing metadata PostLoad does
not authorize treating their serializer tails or PostLoad overrides as empty.
Full Play EndLoad still requires those resource services and original native
binding-table/DLL inputs. Function Bind and metadata dispatch are now connected
to explicit services in the shared graph; the original Core.Object queue is
the first complete metadata-scope integration. See
[`script-function-bind.md`](script-function-bind.md).
Native constructor defaults, config/localization, heap collection and
SEH unwinding are not established by this contract.

## Focused verification

`scripts/native-end-load-oracle.py` executes the original EndLoad,
ConditionalPostLoad and five metadata PostLoad bodies. Seventeen bounded cases
compare ordered calls, exact flags, queue/nest/counter state, import writes and
the reached assertion line against `scripts/validate-end-load.mjs`. Fixture
Preload and Bind are explicit external services, not claims of complete
serialization or function binding. Assertions stop at the native diagnostic
call; its formatting/fatal behavior is outside this probe.

References cover nested and empty scopes; separate preload/postload passes;
Preload and Logf appending a relocated array; PostLoad append followed by the
native count assertion; native/non-native/null import retention; conditional
reentry; missing base-call diagnostics; Field/Struct/Function binding; class
binding before superclass postload; re-reading SuperField after Bind; and
ClassWithin/linker/nest assertions.

`validate-static-load-object.mjs` also connects a populated export-service
queue through the real StaticLoadObject helper into Preload,
ConditionalPostLoad, UObject::PostLoad, array release and import cleanup. This
is a host-wiring check against the separately established native contracts,
not a claim that its fixture services implement resource serialization.
