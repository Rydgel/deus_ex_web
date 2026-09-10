# GC serialization of script expressions

`src/runtime/script-bytecode-serialization.mjs` implements the reference
portion of the collector branch of `UStruct::SerializeExpr` from the installed
GOTY `System/Core.dll`.  The traced binary has SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`.
The virtual thunk at `0x1010281f` enters body `0x101289c0`; its token jump
table is at `0x10128e44`.

The native body reads one token through `FArchive::Serialize` at
`0x101289fb–0x10128a02`, then reads the same byte from the expanded script
buffer and advances the mutable script cursor.  In the collector archive,
raw `Serialize` is a no-op, but the cursor and the virtual reference calls
remain meaningful.  UObject operands use archive vtable `+0x18` and FName
operands use `+0x1c`; both operands occupy four expanded script bytes even
when their package indices use a shorter compact encoding.

The jump-table entries in the traced body route property/object operands
`0x00/0x01/0x02/0x29` to `0x10128af2`, ObjectConst `0x20` to `0x10128be2`,
FinalFunction `0x1c` to `0x10128aa6`, cast/member operands `0x13`/`0x2e`/`0x36`
to `0x10128c6c`/`0x10128db6`, and StructCmp `0x32`/`0x33` to `0x10128d8f`.
Virtual/extended function names `0x1b`/`0x38` use `0x10128acc`, NameConst
`0x21` uses `0x10128bfa`, and LabelTable `0x0c` enters the aligned loop at
`0x10128d44`.  These handlers call the archive object/name virtual slots
before their recursive child calls, which establishes the table's order.

## API

```js
serializeGcScriptExpression(script, decoded, offset, archive, {
  objectOperand(node, slot),
  nameOperand(node, slot),
}) // -> next expanded offset
```

`decoded` is the result of `decodeScript` and must retain its `expressions`
`Map` and expanded `size`.  The helper accepts package versions 68 and 69;
version 61 and other executable layouts remain unsupported.  `archive` must
provide `objectReference(reference, context)`/`serializeObject` and
`nameReference(reference, context)`/`serializeName`.  The archive must be the
collector mode when it supplies state words; the expected values are exported
as `SCRIPT_BYTECODE_GC_ARCHIVE_STATE` (`+0x0c/+0x10/+0x14/+0x18 = 0` and
`+0x1c/+0x20/+0x24 = 1`, with version `+0x04 = 0x44` and licensee
`+0x08 = 0x44c`).

Each operand callback must return a live mutable holder:

```js
{
  reference: true,
  get: () => currentValue,
  set: value => { /* write through the original slot */ },
}
```

The archive receives that holder directly.  A copied object/name value is
rejected because the collector's operator works on the serialized lvalue.
The function advances one native `SerializeExpr` call at a time, so a
`UStruct::Serialize` adapter can retain the result and continue until its
expanded `ScriptSize`:

```js
for (let offset = 0; offset < scriptSize;) {
  offset = serializeGcScriptExpression(script, decoded, offset, archive, operands);
}
```

For a label table, `nameOperand` receives each decoded label entry and slot
`label`, including the terminating `None` name.  Function-call name operands
use slot `function-name`; NameConst uses `name`.  Object callbacks receive
the decoded expression node and these slots:

| token(s) | serialized operand | callback slot | native order |
| --- | --- | --- | --- |
| `0x00`, `0x01`, `0x02`, `0x29` | property/field object | `property` | object |
| `0x13`, `0x2e` | cast target class object | `cast-class` | object, child expression |
| `0x1c` | final function object | `function` | object, argument expressions, `EndParm` |
| `0x20` | object constant | `object` | object |
| `0x32`, `0x33` | struct property object | `struct-property` | object, left child, right child |
| `0x36` | struct member property object | `struct-member` | object, child expression |

Virtual/extended function tokens `0x1b` and `0x38` archive their FName first,
then each argument through `EndParm`.  LabelTable `0x0c` archives its FName
entries in table order before the raw four-byte label targets.  Those targets
use the collector's no-op raw serializer and do not produce reference calls.
Object and name references nested in arithmetic, context, conversion,
iterator, assignment, and native argument expressions are visited in the
same recursive cursor order.

## Cursor details and limits

The traversal follows the native cursor rather than blindly returning the
logical parent node's `end`.  This matters for BoolVariable (`0x2d`): the
original jump table maps it to the common epilogue at `0x10128dec`, which
consumes only the token.  The execution decoder retains the following
variable expression as `node.value`, but native `SerializeExpr` reaches that
expanded offset on the next call.  The adapter therefore returns
`node.offset + 1` and lets the outer cursor loop visit the child separately;
references in that child remain live and are not dropped when it is nested in
Let/LetBool.

Native tokens `0x60–0x6f` consume one expanded native-index byte and then
recurse through argument expressions until `0x16` (`EndParm`); tokens `0x70`
and above recurse directly through the same argument list.  Conversion tokens
`0x39–0x5f` recurse through one child.  Fixed-width raw branches, literals,
control tokens, and `EndParm` only advance the cursor and emit no references.

The decoder's explicit unsupported branches remain unsupported here rather
than being guessed: unknown/reserved tokens such as `0x03`, `0x15`, `0x2b`,
`0x34`, `0x35`, and `0x37` fail with
`UnsupportedScriptBytecodeSerializationError`.  This module performs no
save/load encoding, no compact-index rewriting, and no archive raw-byte
observer work; those are separate native paths.

The focused test uses decoded version-68 bytes to verify label/function names,
object order, mutable writes, expanded offsets, and explicit rejection of an
unsupported token.  The real `CameraPoint.Idle` UState serializer also passes
with all linked bytecode object/name operands.

## Live execution storage

`ScriptObjects.link` retains a separate writable object pointer for each decoded
operand occurrence. The package-index map remains a resolution cache used while
linking metadata; it is not the execution buffer. `operandReference` exposes the
live occurrence and `serializeExpression` passes it to this collector traversal.
Object constants, field accesses, cast targets, struct members and final function
calls read those same occurrence slots during execution. FName operands retain
their decoded values because the concrete mark archive changes name-entry flags,
never FName values; rewriting them through this GC adapter is rejected.

This distinction follows the original execution handlers. `execObjectConst`
(`10102e1e` → `10130aa0`) reads the pointer at the current FFrame.Code location,
advances Code by four and copies the pointer to its result. `execFinalFunction`
(`10102cb1` → `10130280`) likewise reads and advances the current pointer slot
before invoking the target. Neither re-resolves a package index while running.
Field handlers `1012ebc0`, `1012ec60`, `1012ed00` and `1012f3d0` operate on their
expanded operand locations as well.

`test/script-objects.test.mjs` connects the actual collector/bridge to one of two
ObjectConst occurrences originally sharing an index. The excluded reference is
cleared in that occurrence; the second occurrence and resolution cache remain
intact, and the next VM evaluation reads the changed value. The original
CameraPoint.Idle integration now uses these live execution slots. This establishes
the storage boundary, not a complete world/resource collector or save/load linker.
