# Core `Object.Log` native 231

`Object.Log` is a synchronous script-side logging call. Its source of truth is
the installed GOTY pair `System/Core.u` (package GUID
`e4a4c9bf49b7e34495a988b6c175bd29`) and `System/Core.dll` SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`.
`Object.uc` declares it at line 272:

```unrealscript
native(231) final static function Log( coerce string S, optional name Tag );
```

The decoded export is `Object.Log` (export 585), with native index 231,
function flags `9217`, expanded script size 10, and serialized script bytes
`29 3e 29 3b`. The parameters are a required coercing `StrProperty` `S` and
an optional non-coercing `NameProperty` `Tag`.

## Recovered call order

The exported thunk at `0x101031cf` jumps to `execLog` at `0x1013cae0`. The
native body performs these operations in this order:

1. It zero-initializes a 12-byte local `FString` (`Data`, `ArrayNum`,
   `ArrayMax`) and calls the FFrame expression table at `0x101f41b8` for `S`.
   The string evaluator is selected by the next byte, normally opcode `0x1f`.
2. It sets the local `Tag` DWORD to raw EName `0x302`, then calls the same
   expression table for the optional name. Opcode `0x21` replaces the default
   when a tag expression is present; opcode `0x16` is the EndFunctionParms
   evaluator when the optional argument is omitted.
3. It advances `FFrame.Code` once more to consume EndFunctionParms. Therefore
   both `[String, EndFunctionParms]` and `[String, Name, EndFunctionParms]`
   advance the code cursor by three bytes from the native entry.
4. A zero-length `FString` uses the static empty TCHAR buffer at `0x101ef654`.
   Otherwise the local data pointer is passed unchanged to
   `FOutputDevice::Logf` with the process-global `GLog` pointer at
   `0x101a7c34`, the raw tag DWORD, and the static UTF-16 `%s` format at
   `0x101aafd0`.
5. After `Logf` returns, the native destroys the local `FString`. The cleanup
   zeroes its count and capacity, reaches `FArray::Realloc` at `0x10145440`,
   removes the one element-sized allocation, and releases non-empty data via
   the `GMalloc` virtual `Free` call. Logging happens before this cleanup, so
   the output device sees valid text during the boundary call.

The body of `FOutputDevice::Logf` is at `0x10145380`. It formats into a stack
buffer and dispatches a virtual output-device `Log`; no browser equivalent is
assumed. The runtime leaves this as the explicit synchronous `logDevice`
service boundary.

## Runtime adapter

`src/runtime/script-log.mjs` exposes `execObjectLog` and
`OBJECT_LOG_CONTRACT`. `ScriptRuntime` routes native 231 to it through the
constructor's `logDevice` option. The service receives one frozen object:

```js
{ text, tag, tagIndex }
```

`text` is the terminated TCHAR text, so an embedded NUL is the end seen by
`%s`. The default is `{tag: 'ScriptLog', tagIndex: 0x302}`. A supplied logical
FName preserves its canonical spelling without lowercasing or manufacturing a
name-table index (`tagIndex: null`). The adapter evaluates argument 0 and then
argument 1 exactly once before checking that the host output service exists.
It requires an already typed string and resolved logical FName; conversion of
other host values remains unsupported until a corresponding FFrame coercion
service is recovered. A Promise-returning log service is rejected because the
original native cannot suspend, and the native's C++ `void` result is returned
as JavaScript `undefined`.

## Validation

`scripts/native-object-log-oracle.py` runs the hash-pinned Core body in the
existing x86 Unicorn harness. It stubs only the two FFrame evaluators,
`FOutputDevice::Logf`, and the allocator `Free`/`Realloc` edges; stepping,
default-tag assignment, format selection, and FString destruction remain
original instructions. `scripts/validate-native-object-log.mjs` compares five
oracle cases (empty, ordinary, embedded-zero, supplied `Log`, and supplied
`ScriptLog`) with the runtime adapter, checks Core.u metadata and Core.dll
instruction bytes, then exercises ScriptRuntime native dispatch. Run:

```sh
DEUS_EX_NATIVE_PYTHON=.cache/native-probe-env/bin/python \
  node scripts/validate-native-object-log.mjs
node --test test/script-log.test.mjs
```

Original binaries and oracle outputs remain local under the installed game and
`.cache`; they are not runtime assets or Git inputs.
