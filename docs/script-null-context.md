# Null object contexts in the original VM

This note records the null branch of `execContext` (script opcode `0x19`).
`execClassContext` (script opcode `0x12`, `0x1012edb0`) shares the same
decoded shape and the same null-context contract — `Accessed None`, skip the
value bytes, zero `valueSize` of result — so `prepareContextResults`
recognizes both opcodes. The authority is the installed Deus Ex GOTY
`Core.dll`, rather than a public engine implementation. The binary is SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`; the
disassembly is `.cache/research/Core.asm`.

## Stream shape

After the context child has been serialized, an expanded context expression
has this metadata and value expression:

```text
[skip:u16][valueSize:u8][value opcode and operands]
```

The original loader expands compact object and name references to four-byte
slots when it computes script offsets. Thus `skip` is an expanded-byte count,
not a physical package-byte count. It starts immediately after the three
metadata bytes. The value opcode itself is at `Code + 3` when the context
handler is entered.

For a non-null context, the native body reads that opcode, advances `Code` by
four bytes, changes the expression receiver to the context object, and
dispatches the value expression with the caller's `Result` pointer. It does
not use `skip` or `valueSize` in this path. The frame's `Object` remains the
caller object, so later argument expressions still use the caller receiver.

## Exact null path

`execContext` is exported by the thunk at `0x10102964`; its body is
`0x101300d0`. The body first dispatches the context child into a local
four-byte pointer-sized result initialized to zero. It tests that local result
for null. The null path at `0x1013011e`–`0x10130178` is, in order:

1. Call `Logf` at `0x1010280b` with the UTF-16 string at `0x101aaf4c`, which
   is exactly `Accessed None`, and the current frame. There is no property or
   field name in this native log call.
2. Clear the global lvalue address slot at `0x101e32f8`.
3. Read `skip` from `Stack.Code` as a little-endian `u16` and read
   `valueSize` from `Stack.Code + 2` as a byte. The body copies that byte into
   its saved argument slot.
4. Clear the global lvalue property slot at `0x101e32c0`.
5. Set `Stack.Code = Stack.Code + 3 + skip`, thereby skipping the value
   expression without dispatching or evaluating any of its operands.
6. If the outer `Result` pointer is null, return after the cursor update.
   Otherwise, zero exactly `valueSize` bytes at that pointer. The body masks
   the saved value with `0xff`, writes whole dwords with `rep stosl`, then
   writes the remaining one to three bytes with `rep stosb`.

The warning therefore precedes metadata reads and cursor advancement, and
cursor advancement precedes result zeroing. No property copy, destructor,
constructor, default initializer, event, function call, or argument evaluation
runs on this branch. The two lvalue globals are cleared even when the outer
`Result` pointer is null.

In pseudocode, preserving the native ordering:

```text
contextResult = 0
dispatch(contextChild, &contextResult)
if contextResult != 0:
    valueOpcode = Stack.Code[3]
    Stack.Code += 4
    dispatch(valueOpcode, Result, receiver=contextResult)
else:
    Logf("Accessed None", Frame)
    globalLValueAddress = 0
    skip = u16(Stack.Code + 0)
    valueSize = u8(Stack.Code + 2)
    globalLValueProperty = 0
    Stack.Code += 3 + skip
    if Result != 0:
        memset(Result, 0, valueSize)
```

Nested contexts can produce more than one warning. An inner context is still
dispatched as the outer context's child. If `Level` itself is null in
`Level.Game.IsRelevant(Self)`, the inner context warns and returns a zeroed
result; the outer context then observes null, warns, and skips its own value.
If `Level` is valid but `Game` is null, only the outer context warns: the
inner context has a non-null receiver and its `Game` field simply evaluates to
the null pointer that the outer context tests.

## What `valueSize` means

`execContext` does not derive a type or call a property method. It trusts the
single encoded byte at `Code + 2`. The only directly established native size
helper is `UProperty::GetSize`, exported at `0x1010260d` and implemented at
`0x101127f0`:

```text
GetSize(property) = property[0x38] * property[0x34]
                   = ElementSize * ArrayDim
```

That helper is a linker/property-layout cross-check; the `execContext` body
does not call it. The compiler has already emitted the context result width in
the script stream. For a direct property expression, the observed byte agrees
with the property storage width for the focused fixed-size types. For a
function call, it agrees with the linked return slot width. A linker should
use the encoded byte as the zeroing authority and metadata as the type
interpretation, rather than recomputing a different width from a short name.
The byte load and the later `0xff` mask also bound native zeroing to 0–255
bytes.

The following consequences are supported by real v68 script streams and the
native raw-memory operation:

| Result expression type | Observed encoded width | Native null result | Host interpretation | Status |
| --- | ---: | --- | --- | --- |
| `ByteProperty` | `1` | one zero byte | numeric byte `0` | established |
| `IntProperty`, `FloatProperty`, scalar bool result | `4` | one zero dword | `0`, `+0.0`, or `false` | established for fixed scalar expressions |
| `ObjectProperty`, `ClassProperty` | `4` | null pointer bits | `null` object/class reference | established |
| `NameProperty` | `4` | zero FName bits | canonical `None` name | raw width established; host FName mapping is linker policy |
| `Vector`, `Rotator` | `12` | three zero dwords | a fresh three-component zero value | established for these fixed structs |
| fixed primitive array | element width times array dimension | all bytes zero | fresh array of typed zero elements | only where linked element width is known and fits the byte |
| `StrProperty`/dynamic string | observed `0` in the focused streams | zero bytes written | preserve the caller's existing result state | no empty-string assignment is established here |
| arbitrary or UObject-containing `StructProperty` | encoded width | raw bytes zeroed | requires linked typed storage rules | raw memset established; recursive host value is unsupported here |
| void/no-result expression | `0` | zero bytes written | no result write | established |

The zero is a raw memory operation. It does not apply a `BoolProperty` bit
mask, run a struct's `DestroyValue`, or construct a valid dynamic-string or
dynamic-array object. In a browser host, an implementation may expose typed
zero values for the fixed cases above, but it must create fresh arrays/struct
objects and must not return a shared mutable value. A zero-width string or
opaque result must not be silently changed to `''` or an invented struct.

The current browser VM models the zero-width case by returning `undefined`
without invoking its zero-result service. That matches the native fact that
zero bytes are written, but it does not claim that a native `FString` object
was constructed. Any caller-side initialization of a result slot remains
outside `execContext`.

## Real package fixtures

The focused checks used the installed `Engine.u` (v68, SHA-256
`1742d16f49492a02391fa6a9ca25887f0cc4f30ec9964925226217d8858737da`) with the
local metadata reader and expanded-bytecode decoder.

`Engine.Actor.PreBeginPlay` is export `207`, expanded script size `204`. Its
source is `.cache/reference/Actor.uc:1011–1027`; the autodestruction condition
at line 1025 contains `Level.Game.IsRelevant(Self)`. The decoded contexts are:

```text
offset 149: Level.NetMode
  skip=5, valueSize=1, value ends at expanded offset 163
  null cursor: metadata start 155 + 3 + 5 = 163

offset 172: Level.Game.IsRelevant(Self)
  inner context offset 173: Level.Game, skip=5, valueSize=4, ends at 187
  outer context: skip=7, valueSize=4, value ends at 197
  null cursor: metadata start 187 + 3 + 7 = 197
```

When `Level` is valid and `Game` is null, the outer context logs
`Accessed None`, skips the virtual `IsRelevant` call and its `Self` argument,
and supplies a four-byte zero used as false by the surrounding `!` test. If
`Level` is also null, both context levels log and zero their respective
results.

`Engine.GameInfo.IsRelevant` is export `3741`, expanded script size `542`.
Its source is `.cache/research/pawn-startup/engine.gameinfo.uc:435–447`:

```uc
if ( BaseMutator.AlwaysKeep(Other) )
    return true;
if ( BaseMutator.IsRelevant(Other, bSuperRelevant) )
    ...
else return false;
```

The linked `BaseMutator` field is an `ObjectProperty` of class `Mutator`
(Engine field export `183`). The first context is at expanded offset `3`,
with `skip=11`, `valueSize=4`, and virtual call `AlwaysKeep` at offset `12`.
The linked function's `ReturnValue` is a `BoolProperty` (`Parm|OutParm|ReturnParm`)
and the compiled context width is four bytes. If `BaseMutator` is null, the
call and its argument are skipped, the zero result makes the first condition
false, and the second context at offset `28` likewise logs and skips
`BaseMutator.IsRelevant`. The source then takes its false return path. During
normal `GameInfo.InitGame`, `BaseMutator` is spawned at source line `579`; the
null case remains reachable before that initialization or after a deliberately
cleared link and is a real serialized-script path, not a synthetic opcode.

## Minimal typed-result service boundary

The VM boundary can remain:

```js
services.zeroContextResult(functionMetadata, valueNode, encodedSize)
```

The service should resolve the expression result in this order:

1. A direct field node (`LocalVariable`, `InstanceVariable`,
   `DefaultVariable`, or a linked member) resolves its canonical field record
   and `readPropertyMetadata` result, including `type`, `structKey`,
   `arrayDim`, and any linked element/struct metadata.
2. A final, global, or virtual function node resolves the selected linked
   function and its `ReturnParm` property. `GameInfo.IsRelevant` and
   `Mutator.AlwaysKeep` demonstrate the bool-return case.
3. A conversion, native result, literal, or unresolved cross-package type
   requires an explicit registered result type. Do not infer object, name,
   string, or struct identity from `encodedSize` alone.

For a known fixed type, verify that its established storage width equals
`encodedSize`, then return a fresh typed zero (`null`, `0`, `false`, `None`, or
a new zero vector/array/struct). For `encodedSize === 0`, preserve the native
no-write behavior; the current VM already returns without calling this
service. For an unresolved dynamic/opaque type, throw an explicit unsupported
error instead of invoking a constructor or inventing a default. The service
must not call events, setters, property destruction, default-value loading, or
the skipped value expression.

This evidence covers the GOTY Core implementation and v68/v69 package
metadata. Older package versions, arbitrary dynamic arrays/strings, and
recursive zero construction for non-POD structs remain unsupported until their
original serializers and property lifetimes are traced.

## Browser linker helper

`src/runtime/script-context-results.mjs` implements the sparse typed-result
boundary without changing the VM. After the script's operand references have
been linked, prepare one map for the exact decoded script object:

```js
const contextResults = await prepareContextResults(runtime, script, decoded);
const zero = zeroContextResult(contextResults, contextNode.value, contextNode.valueSize);
```

The map is keyed by each `Context.value` object identity. Its descriptors carry
`{ source, key, field, metadata, type, width, zero }`; `zeroContextResult`
checks `valueSize === width` and calls `zero` to obtain a fresh value. Passing
the `Context` node itself is also accepted as a convenience. A missing
descriptor or width mismatch raises `UnsupportedScriptContextResultError`.

Preparation is deliberately sparse. Direct property nodes (`LocalVariable`,
`InstanceVariable`, `DefaultVariable`, and the established field form),
`StructMember`, and a `BoolVariable` wrapper can produce fixed scalar,
object/class, name, Vector, or Rotator descriptors. For a virtual/global call,
the helper follows the context expression's serialized `ObjectProperty` and
its `propertyClassRef`, loads that class by full package identity, and selects
the method from its linked class hierarchy. A final call uses its serialized
function reference. Both paths read the target function's `ReturnParm` with
`readFunctionMetadata`; they never compile or execute the target body.

Unresolved class links, native-only targets, dynamic/string/map/fixed-array
values, conversions, and arbitrary structs are omitted during preparation and
fail only if execution reaches their null Context. No short-name-only lookup or
runtime null receiver is used to select a virtual target.

Against the installed `Engine.u`, the helper prepared all three Contexts in
`Actor.PreBeginPlay`: `Level.NetMode` (`byte`, width 1), `Level.Game`
(`object`, width 4), and the statically selected `GameInfo.IsRelevant`
`ReturnValue` (`bool`, width 4). It prepared 18 fixed results in
`GameInfo.IsRelevant`, including the statically selected `Mutator.AlwaysKeep`
and `Mutator.IsRelevant` bool returns. These checks used `ScriptRuntime`'s
full object identities and class loader; no function body was prepared by the
context-result helper itself.

### Native tokens (2026-09-24)

A final native call is compiled as its `GNatives` token (`op: 'native'`,
e.g. `inHand.IsA('DeusExWeapon')` → 303) and carries no function reference.
The compiler resolved it through the Context object's class, so preparation
follows the same `ObjectProperty` class link. Then, in that class chain, it
selects the serialized function whose `iNative` equals the token, and reads
its `ReturnParm` as for a final call. The encoded width check is unchanged.
`DeusExPlayer.SwitchAmmo` with `inHand` None now logs `Accessed None` and
skips `CycleAmmo`, as in the original. Before this change it stopped on
`Unsupported null Context result at offset 12`.
