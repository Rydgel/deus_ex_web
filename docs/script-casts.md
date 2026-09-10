# Original object casts

This note records the object cast path recovered from the installed Deus Ex
GOTY Core.dll. The binary used here is `.cache/research/Core.asm`, the
disassembly of SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`.
The exported thunks are `UObject::execDynamicCast` at `0x10101edd` and
`UObject::execMetaCast` at `0x10103189`; they jump to `0x10130ed0` and
`0x10130fa0` respectively.

Both handlers read the four-byte expanded target object at `FFrame.Code`, then
read the child opcode at `Code+4`. They advance `Code` by five expanded bytes
before calling the child through the original expression jump table
(`0x101f41b8`). The child receives the current `FFrame.Object` and writes its
result to a temporary UObject pointer. The target is therefore available before
child evaluation, and the cast call has no independent side effects.

`execDynamicCast` (`0x10130ed0`–`0x10130f35`) behaves as follows:

1. Evaluate the child expression in FFrame.Object, even inside a different Context receiver.
2. A null child result produces a null result.
3. For a non-null child, start at `child->Class` (`+0x24`) and compare each
   class identity to the embedded target. Follow `Class->SuperClass` (`+0x28`)
   until null.
4. On a match, return the original child pointer. On a mismatch, return null.

The original code has one invalid-target edge: after exhausting the class chain,
it sets success when the target pointer is null (`test target; sete`). Normal
serialized casts have a class target; this null-target behavior is preserved as
the service boundary's responsibility rather than guessed in the VM.

The installed `DeusEx.u` export `DeusExDecoration.Bump` (export index 1448,
expanded script size 1087) provides a real operand check. Its first cast is at
expanded offset 6:

```text
opcode 0x2e, target object index 1 (DeusExPlayer),
child opcode 0x00, child object/field index 713 (Other)
```

The following assignment is `Player = DeusExPlayer(Other)`. The package stores
compact indices, while the expanded offsets above are the offsets used by the
native interpreter.

`execMetaCast` (`0x10130fa0`–`0x1013101d`) is a class-object cast, and has two
ancestry checks:

1. Evaluate the child in FFrame.Object. Null fails.
2. Start at `child->Class` and walk `+0x28` until the hardcoded identity
   `0x101f1c18`. The address is the original `UClass` static-class identity:
   `0x10110d60` returns it, and the native `UClass` initialization at
   `0x10128793` passes it to the constructor.
3. If that metaclass check succeeds, start at the child class object itself and
   walk its `SuperClass` chain (`+0x28`). Return the original child pointer if
   the embedded target is found; otherwise return null.

The VM keeps these native identity rules behind an explicit host boundary:

```js
services.objectReference(script, node.fieldIndex)
services.castObject(value, targetRecord, 'dynamic' | 'meta')
```

For either opcode the VM obtains `targetRecord` first, evaluates the child and
unwraps a property reference, then calls `castObject`. The service owns package
identity and class ancestry. A dynamic service must test an object's linked
class chain; a meta service must test a class object and its linked class-object
superclass chain. In the current linker, serialized `Class` records are the
available meta records; native-only metaclass identities remain unresolved and
must fail explicitly. Missing cast services or target-link services are errors,
and no coercion to a short class name is performed.

`MetaCast` has no confirmed serialized GOTY function fixture in the package scan
used for this pass. Its native contract above is established directly from the
original Core.dll body. Versions outside package versions 68 and 69 remain
unsupported by the script decoder.

The linked runtime prepares class operands before execution and compares
canonical class record identities. Attached script instances supply their linked
class directly; other loaded objects can use `prepareObjectType` where their
class is serialized. `MetaCast` accepts a prepared serialized Class record and
walks its original class-object base chain. Native-only resource/metadata class
registration is still a separate unsupported boundary. The null-target edge
differs between the opcodes: DynamicCast preserves a non-null child, while
MetaCast returns null (`10130ffd`–`10131012` never compares the null terminator).
