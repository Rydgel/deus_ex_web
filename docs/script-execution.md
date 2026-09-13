# Original script execution contract

This note records the execution contracts recovered from the installed Deus Ex
GOTY binaries. It is the source of truth for the VM call/context work in
`src/runtime/script-vm.mjs`; it does not define a replacement script language.

The primary binary is `Deus Ex GOTY Edition/System/Core.dll`, SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4` (790,528
bytes). The Engine and DeusEx package source and metadata used for the focused
examples are in `.cache/reference/{Object,Mover,DeusExMover}.uc` and the
package linker output. The complete native disassembly is
`.cache/research/Core.asm`; offsets below are virtual addresses in that file.
The decoder evidence for the expanded script stream is in
`.cache/research/SerializeExpr-stage3.asm` and [script-bytecode.md](script-bytecode.md).

## FFrame and ProcessInternal

The original `FFrame` has these relevant dword fields (constructor and access
helpers at `0x10115850`–`0x1011594f`):

| offset | field | use |
| ---: | --- | --- |
| `+0x04` | `Node` | current function/state object |
| `+0x08` | `Object` | caller expression object; the stable `Self`/instance lookup object for argument expressions |
| `+0x0c` | `Code` | bytecode cursor |
| `+0x10` | `Locals` | parameter/local storage |

`FFrame::Step` reads one opcode byte at `Code`, advances `Code` by one, and
dispatches `opcodeTable[opcode](ECX, Stack, Result)`. The ECX value is the
current expression receiver. It is independent of `Stack.Object`: a Context
expression can change ECX for the nested value while leaving the caller object
used by later argument evaluation unchanged.

`UObject::ProcessInternal` is at `0x1013f690`. It first calls the object's
vtable slot `+0x18` with the function, a local scratch result area, and the
frame. A nonzero return means the object hook handled the function. Otherwise
it loops until opcode `0x04` (`Return`). For a Return it consumes the Return
byte and the following value-expression opcode, dispatches that value with the
outer result pointer, and then exits. A void function therefore normally ends
with `0x04 Return, 0x0b Nothing`; a value function writes through the original
result pointer while processing the value expression. The recursion-depth guard
at `0x101f81c0` warns above 250 nested calls. `ProcessEvent` at `0x1013f7d0`
is a separate native/event wrapper and must not be substituted for ordinary
script `ProcessInternal` calls.

## CallFunction: parameter frame, locals, out and return

`UObject::CallFunction` is at `0x1013f4e0`. Its effective inputs are the target
receiver `this`, caller `FFrame*` at `[ebp+8]`, caller result pointer at
`[ebp+0xc]`, and `UFunction*` at `[ebp+0x10]`.

The call path is:

1. If `Function+0x70` is nonzero (`iNative`), call the function pointer at
   `Function+0x7c` directly with the *caller* frame and result, then return.
   This path does not allocate a parameter block or perform script out
   copyback.
2. Otherwise, if `FunctionFlags` at `Function+0x6c` has `FUNC_Native` bit
   `0x400`, call the object vtable slot `+0x18` with the function, a local
   scratch block and the caller frame. A nonzero hook result marks the native
   implementation handled. The argument parse and cleanup then run. If the
   hook returns zero, the fallback function pointer at `Function+0x7c` is
   called immediately with the caller frame and result, and this wrapper
   returns without parsing a temporary frame (`1013f53d–1013f553`).
3. For an ordinary script function, read the parameter/local block size from
   the exact field consumed at `Function+0x3c`. Allocate
   `(size + 7) & ~7`, then `(rounded + 3) & ~3` bytes and zero the original
   block. The disassembly proves this offset and rounding sequence; the
   generic field names in the linker sources do not prove that `+0x3c` should
   be called `ParmsSize`.
4. Build a callee frame with vtable `0x101752b8`:
   `Node=Function`, `Object=this`, `Code=Function+0x44`, and
   `Locals=zeroed temporary block`.
5. Walk the property declaration chain beginning at the exact field read at
   `Function+0x38`. For each property, read the caller's next opcode. If it is
   `0x16 EndFunctionParms`, stop; otherwise advance over that opcode and
   dispatch it with destination `temporary + property+0x48`. Set
   `0x101e32f8` to zero before every argument expression. **ECX is
   `callerFrame->Object` (`callerStack+0x08`) during this dispatch, not the
   target receiver `this`.** Thus `Other.Foo(Self, SomeInstanceField)` uses
   `Other` for the callee but evaluates `Self` and instance fields against the
   original caller object. After the terminator, advance the caller Code by
   one byte to consume `0x16`.
6. For a property whose flags byte has bit `0x100` (`OutParm`, tested at
   `property+0x3d`), the argument expression leaves its address in
   `0x101e32f8`; save `{property,address}` for copyback. The expression still
   receives the non-null temporary destination from step 5. Variable lvalue
   handlers (`LocalVariable`, `InstanceVariable`, `DefaultVariable`, and the
   composed array/struct lvalues) therefore copy the caller's current value
   into that temporary through the property vtable slot `+0x90`; CallFunction
   itself issues no separate initial copy. The temporary was zeroed before
   evaluation, and the callee then reads/writes it. The saved records are
   copied back in reverse order after the function returns: source
   `temporary + property+0x48`, destination saved address, via the property
   vtable slot `+0x90` (`CopyCompleteValue`).

   The native handlers make this distinction explicit: `execLocalVariable`
   (`0x1012ebc0`) and `execInstanceVariable` (`0x1012ec60`) always publish
   their lvalue address, and when Result is non-null call that property's
   `+0x90` copy with `(Result,address)`; `execDefaultVariable`
   (`0x1012ed00`) follows the same pattern using class defaults.
7. If the native hook did not handle the function, call `ProcessInternal` with
   the callee frame and the original caller result pointer. This is where the
   script Return expression writes the return value.
8. Destroy every temporary property in the chain starting at the exact field
   read at `Function+0x68`, using source `temporary + property+0x48` and the
   property vtable slot `+0x94` (`DestroyValue`); follow `property+0x54`.

The trailing-argument omission path is established by the initial terminator
test at `1013f5af–1013f5b9` and loop test at `1013f5fb–1013f605`: an early
EndFunctionParms stops argument evaluation, leaving later parameter slots in
the zeroed block from `1013f577–1013f58b`. No OptionalParm flag or default-value
initializer is consulted in this script call path. An explicit Nothing argument
likewise writes no value, retaining that slot's zero initialization. The runtime
can therefore accept missing trailing arguments and Nothing holes; excess
arguments remain outside its supported ABI. The logical VM now destroys owning
strings/structs after copying return and out values, using the recovered
DestroyValue dispatcher; see [frame ownership](script-frame-ownership.md).

In pseudocode, the script path is therefore:

```text
tmp = zero(round4(round8(Function[0x3c])))
callee = FFrame(Node=Function, Object=this, Code=Function[0x44], Locals=tmp)
for prop in chain(Function[0x38]):
    op = caller.readByte()
    if op == EndFunctionParms: break
    caller.Code += 1
    caller.dispatch(op, caller.Object, tmp + prop[0x48])
    if prop.flags & 0x100:
        outRecords.push(prop, globalOutAddress)
caller.readByte()                         // consume EndFunctionParms
ProcessInternal(callee, callerResult)
for prop,address in reverse(outRecords): CopyCompleteValue(address, tmp+prop[0x48])
for prop in chain(Function[0x68]): DestroyValue(tmp+prop[0x48])
```

The block is zeroed before argument evaluation. There is no default-value read
in this call path. Optional parameters therefore remain an unresolved edge for
a caller that omits an argument; the compiler normally emits the default as an
argument expression. An `OutParm` expression that is not addressable leaves no
copyback record; its exact diagnostic/failure behavior is unresolved. The
focused Mover and DeusExMover functions have no optional or out parameters, so
this omission does not affect their recovered calls. Return conversion/copy
rules beyond the property handlers visible above remain unresolved.

The offsets `+0x38`, `+0x3c`, `+0x44`, `+0x68`, `+0x6c`, `+0x70`, and `+0x7c`
are stated as offsets observed by this call path. `UStruct::Serialize`'s
generic load order (`ScriptText`, `Children`, `FriendlyName`, line/text
positions, script) is insufficient to assign the first two names without the
original SDK's exact UFunction layout.

## Function opcodes and lookup order

The expression wrappers only decode their function reference; `CallFunction`
consumes the argument list. `execVirtualFunction` (`0x101301e0`) reads a
four-byte function name/reference, advances Code by four, calls
`FindFunctionChecked(name, 0)`, and invokes the current receiver's vtable slot
`+0x44` (`CallFunction`). `execGlobalFunction` (`0x10130300`) is identical
except it passes lookup flag `1`. `execFinalFunction` (`0x10130280`) reads a
four-byte function object reference, advances Code by four, and directly calls
the receiver's `+0x44`; it performs no name lookup.

`FindObjectField` implementation `0x10150b50` searches the active state first
when flag is zero: `this+0x0c` is the state frame, its class is at state
`+0x18`, and the state class hash bucket is at `stateClass+0x84+(Name&0xff)`;
the chain uses `field+0x30` and compares the field name at `field+0x20`.
It then always searches the object class at `this+0x24` through the same hash
layout. Flag one skips the state table and searches the class table only.
`FindFunctionChecked` (`0x10150bf0`, wrapper `0x1010263f`) validates the found
field as a UFunction and reports a missing/invalid function. Consequently:

* Virtual dispatch is active-state override first, then class inheritance.
* Global dispatch bypasses the active state and uses class lookup.
* Final dispatch uses the embedded function object directly.

`Context` changes the ECX receiver for lookup and the eventual call but does
not mutate the frame's `Object`; nested CallFunction argument expressions still
use the caller frame Object. This is the observed receiver/context split.

## Context, null context and Boolean control flow

`execContext` (`0x101300d0`) dispatches the context expression with the current
receiver and a local result pointer. At that point Code is positioned at
`[skip:u16][valueSize:u8][value opcode]`. For a non-null context it reads the
value opcode at `Code+3`, sets Code to `Code+4`, switches ECX to the context,
and dispatches the value expression with the outer result. `Stack.Object` is
unchanged.

For a null context it logs `Accessed None`, clears the lvalue globals
`0x101e32f8` and `0x101e32c0`, reads `skip=u16(Code)` and `valueSize=byte(Code+2)`,
then sets `Code = Code + 3 + skip`. If the outer result is non-null it zeroes
exactly `valueSize` bytes (dword count plus remainder); with no result it only
advances. The skip is measured from the byte after the three metadata bytes,
which lands after the encoded value expression and its trailing
`EndFunctionParms` where present. `execClassContext` (`0x1012edb0`) has the same
null/skip behavior; for a non-null value it additionally validates the context
against the expected class through vtable `+0x64`. The exact class assertion
policy after that check remains unresolved.

Token `0x2d` (`BoolVariable`) is a prefix, not a complete leaf. Its body
(`0x1012f300`) consumes the following child opcode, dispatches that child with
Result null so the child sets `0x101e32c0` (property) and `0x101e32f8` (address),
then writes a scalar 0/1 to the outer Result using the bool mask at
`property+0x5c`. A missing address yields false. `LetBool`
(`0x1012ff30`) dispatches its LHS child with Result null, saves the address and
property globals, dispatches RHS into a four-byte temporary, and changes only
the selected bit: true uses `*address |= property[0x5c]`; false uses
`*address &= ~property[0x5c]`.

Native bool AND (`130`, body `0x10132a90`) and OR (`132`, body `0x10132c70`)
evaluate the first child, then inspect a following `0x18 Skip` token. The
two-byte skip points from the first byte after Skip's three-byte encoding to
the end of the second expression. AND with a false first operand, and OR with
a true first operand, write the short-circuit result and set Code directly to
`childStart + skip`; they do not dispatch the second child. Otherwise they
dispatch the second child and increment Code once more to consume trailing
`0x16 EndFunctionParms`. A generic evaluator must preserve this control flow;
evaluating both native arguments eagerly calls functions that the original
never calls.

## Fixed and dynamic array element access

The export `execArrayElement` (`0x101028dd`) enters body `0x1012ef90`. The
bytecode children are evaluated in this order:

1. Dispatch the first child with the caller frame Object and a local signed
   integer result. This is the index expression.
2. Clear `0x101e32c0`, dispatch the second child with the current receiver and
   Result null. This is the array variable lvalue; it leaves the array property
   and base address in `0x101e32c0`/`0x101e32f8`.

If either property or address is null, the handler returns without producing a
value. Otherwise it reads the fixed array dimension at property `+0x34` and
element size at `+0x38`. An index `< 0` or `>= dimension` logs the index and
dimension, then clamps: negative values become zero, values at/above the upper
bound become `dimension-1`. It computes
`address = base + signedIndex * elementSize` and updates `0x101e32f8` to that
lvalue. If the outer Result is non-null it calls the property's vtable `+0x8c`
with `(Result, address)` to copy the selected element; with Result null the
adjusted global address remains available for Let/out assignment.

`execDynArrayElement` (`0x10102572`, body `0x1012f190`) uses the same index-first
ordering, global lvalue handoff, bounds log/clamp shape, element-size multiply,
and optional `+0x8c` copy. It first validates that the resolved property is an
array property and then uses the property-provided dimension/element fields.
The exact dynamic-array storage/header interpretation is not established by
this focused trace; do not infer a JavaScript backing-array policy from it.

## Struct member access and component convention

`execStructMember` (`0x10101267`, body `0x1012f3d0`) reads a four-byte member
property reference/name from Code and advances Code by four, then validates the
member's owning struct/class chain. It allocates and zeroes a temporary the
size of that struct (`0x1012f474`–`0x1012f4a2`) and dispatches the struct
expression with that temporary as a **non-null Result** (`0x1012f4ab`). The
child runs with the saved current receiver (`0x1012f4b1`); it may both copy an
rvalue into the temporary and publish a genuine struct lvalue in
`0x101e32f8`. If that global address is non-null, the member's `+0x48` data
offset is added (`0x1012f4d7`) and the adjusted lvalue is left in
`0x101e32f8`. If the outer Result is non-null, the member property vtable
`+0x90` copies **from the temporary plus the member offset** into the outer
Result (`0x1012f4ea`–`0x1012f4f6`). Thus a struct rvalue still supplies a value,
while a child lvalue additionally supplies an address for Let/out assignment.
The handler validates the expected struct/property classes and asserts/logs on
mismatches; the full diagnostic text and all failure cleanup paths are outside
this target.

Struct members use the same property convention as object fields: address is
the base plus the member's data offset, `ArrayDimension` and `ElementSize`
govern array indexing, bools use the property bit mask at `+0x5c`, and property
virtual slots perform typed copy/destroy. The recovered code does not justify
flattening vector/rotator components into separate object properties. Their
three components remain one struct value; component operations must preserve
the source property offset and the original typed native operation.

## GotoState and state-event transition order

The original `UObject::GotoState` body is `0x1012e8f0` and the native wrapper
is `execGotoState` at `0x1013dd00`; both are in the Core.dll named above.
`GotoState` returns `0` immediately when `this+0x0c` has no `FStateFrame`. With
a frame, it first clears `FStateFrame+0x24`, the latent/action slot, before
resolving the requested state. The current state node is at `FStateFrame+0x18`;
its name at `+0x20` is used as the old name except when the node is the object
class sentinel (`this+0x24`), in which case the old name is zero.

`0x2a3` is the hardcoded `NAME_Auto` value, not `NAME_None`: Core startup
allocates that EName as the string `Auto` at `0x1014c979`–`0x1014c98c`. An
explicit non-Auto name is resolved by `FindState` (`0x10101483`). `Auto` walks
the class/state chain and selects the first state whose state-flags word has
bit `0x2`; its resolved name then becomes the requested name. A missing
explicit state, or an Auto request with no matching auto state, uses the object
class as the frame's no-state sentinel, clears frame code/latent state and
recomputes the class-sentinel masks, then returns `0`.

The Auto iterator helper is thunk `0x101012b7`, body `0x10143f50`.
It starts at class `Children` (`+0x38`), follows each field's `Next`
(`+0x2c`), skips fields whose class ancestry does not include UState
(`0x101f2118`), then obtains the enclosing class's inherited parent through
virtual `+0x68` and resumes at that parent's children. The selection loop
tests state flags `+0x7c` bit `0x2` at `0x1012e99b` and retains the first
matching state pointer. Export-table order and state-name deduplication are
not part of this algorithm. In particular, a derived non-auto state does not
hide a same-named base auto state from this scan. The runtime links this
ordered child list while loading classes; the selected state's bytecode must
still be prepared before synchronous execution.

For a valid target, the different-state path is ordered as follows:

1. If the old name is nonzero and differs from the target, test the EndState
   probe (`EName 0x13d`, constructed at `0x1012e9c9`). When it is probed and
   object flag `0x2000` is clear, clear object flag `0x1000`, set `0x2000`,
   resolve `EndState`, and dispatch it through the object's vtable `+0x10`
   (`0x1012e9e0`–`0x1012ea08`). Clear `0x2000` after the callback. If the
   callback left `0x1000` set, return `2` immediately; the outer transition
   does not install its target.
2. Install the target node at frame `+0x04` and `+0x18`, clear frame code
   `+0x0c`, and recompute the event masks as
   `(class.ProbeMask | state.ProbeMask) & state.IgnoreMask` into frame
   `+0x1c/+0x20` (`0x1012ea1f`–`0x1012ea47`).
3. If the target name is zero, return `0`. If it equals the old name, skip
   BeginState and return `1` after setting object flag `0x1000`.
4. For a different target, test the BeginState probe (`EName 0x13c`,
   constructed at `0x1012ea5f`). If probed, clear object flag `0x1000`
   (`0x1012ea78`–`0x1012ea82`), then resolve and dispatch BeginState
   through vtable `+0x10` (`0x1012ea57`–`0x1012ea96`). If that callback leaves
   `0x1000` set, return `2`; otherwise set `0x1000` and return `1`. The same
   final flag set and return `1` occur when BeginState is not probed.

The `0x2000` bit is therefore an EndState reentrancy guard, while the
`0x1000` bit is the callback-visible transition marker. In particular, if
EndState calls GotoState, the nested call sees `0x2000` and skips a second
EndState, installs its own target and BeginState, and sets `0x1000`; the outer
call then returns `2` and leaves the nested transition in place. A state change
from BeginState similarly leaves the nested result in place and makes the
outer BeginState path return `2`. The assembly establishes these flag tests and
returns; symbolic names for the two object bits are unresolved.

`execGotoState` evaluates NewState and Label, compares NewState with the
current name, and uses vtable `+0x30` for GotoState and `+0x34` for GotoLabel.
If the names differ it calls GotoState and calls GotoLabel only when the return
is exactly `1`; a return of `0` or `2` suppresses the label. If the names are
already equal, it skips GotoState and calls GotoLabel directly, so a same-state
relabel performs no BeginState/EndState but still uses GotoLabel's latent reset
and code relocation. A missing Label is replaced by EName `0x64` (`Begin`),
whose Core startup allocation is at `0x1014c00d`–`0x1014c01d`, at
`0x1013dd95`–`0x1013dda2`. Consequently the ordinary call order for a different
state is `EndState → frame install/mask reset → BeginState → GotoLabel(label)`;
the last step is skipped for `GotoState` failure/reentrant return.

`NAME_None` is the zero FName value. Passing `GotoState(None)` through the
wrapper differs from same-state relabeling when a state is active: the current
name is nonzero, so the wrapper calls GotoState, which resolves no node, moves
the frame to the class sentinel, clears code/latent state, recomputes the
sentinel masks, and returns
`0` without calling GotoLabel. With no active state both names are zero, so the
wrapper takes its same-name branch and attempts the default `Begin` label on the
no-state frame; no state code is installed. Explicit current-state names use
the same-name GotoLabel branch. The exact logging text for missing states and
labels is outside this contract.

`IsProbing` at `0x10115670` tests the state-frame mask only for native EName
indices in `[0x12c,0x16c)`. The bit is `EName-0x12c` in the two dwords at
frame `+0x1c/+0x20`; names outside that range, and objects without a state
frame, return true. BeginState/EndState therefore occupy bits16/17 of the
low word. The runtime keeps these native EName indices separate from package
name-table indices.

## Focused target inventory

The package decoder and the original source give these implementation targets
(version 68):

| function | export | script header / expanded bytes | native declarations used | calls/control relevant to this VM |
| --- | ---: | ---: | --- | --- |
| `Engine.Mover.TriggerToggle.Trigger` | 3275 | 108 / 78 | `113,119,132,150,154` | Context `SavedTrigger` → virtual `Actor.BeginEvent`; native OR/`==`/`<`; two `GotoState` natives; jump/return |
| `Engine.Mover.DoOpen` | 3110 | 90 / 70 | `146,171,172,264` | final `InterpolateTo`; `LetBool`; sound and float arithmetic; return |
| `DeusEx.DeusExMover.TriggerToggle.Trigger` | 14021 | 29 / 23 | `129` | conditional BoolVariable `bDestroyed`; final `Super.Trigger`; return |
| `DeusEx.DeusExMover.Frob` | 15897 | 1324 / 989 | `114,119,123,129,130,132,155,171,172,177,216,219,229,255,280,303,304,714` | contexts, virtual/final calls, AllActors iterator, Let/LetBool, short-circuit bools |
| `DeusEx.DeusExMover.DoOpen` | 15892 | 184 / 140 | `119,130,155,255,304` | final `Super.DoOpen`; contexts, iterator, Let/LetBool, return |

The source signatures for the first three call targets are
`Trigger(Actor Other, Pawn EventInstigator)`, `DoOpen()`, and
`DeusExMover.Frob(Actor Frobber, Inventory frobWith)`; these focused functions
have no optional/out parameters. `Mover.TriggerToggle.Trigger` assigns
`SavedTrigger` and `Instigator`, calls `SavedTrigger.BeginEvent()` through a
Context/Virtual pair when non-null, then selects Open when `KeyNum==0` or
`KeyNum<PrevKeyNum`, otherwise Close. `DeusExMover.TriggerToggle.Trigger`
guards `bDestroyed` before invoking `Super.Trigger`.

The Frob inventory above is an opcode/native coverage target, not a claim that
every native has been implemented by the browser runtime. Original source lines
are `.cache/reference/Mover.uc:448,735` and
`.cache/reference/DeusExMover.uc:487,667,701`; the bytecode/header counts were
obtained from the linked Engine/DeusEx v68 exports with the local decoder.

## Unresolved branches

The following are intentionally explicit until a separate source/instruction
trace establishes them: return-property conversion and destruction details for nontrivial return
types; native hook behavior when a hook both mutates the frame and returns zero;
the complete `ClassContext` class assertion/failure policy; dynamic-array
header/storage semantics; struct class mismatch diagnostics; and arbitrary
native iterator/property types beyond the focused target inventory. None is
needed to establish the parameter/caller-object contract for the listed mover
functions.

## Validation

The call-path findings were read directly from `Core.asm` at
`0x1013f4e0` (`CallFunction`), `0x1013f690` (`ProcessInternal`),
`0x101301e0/0x10130280/0x10130300` (Virtual/Final/Global),
`0x10150b50/0x10150bf0` (lookup), `0x101300d0/0x1012edb0` (Context),
`0x1012f300/0x1012ff30` (BoolVariable/LetBool),
`0x10132a90/0x10132c70` (short-circuit), and
`0x1012ef90/0x1012f190/0x1012f3d0` (array/dynamic-array/struct member),
`0x1012e8f0/0x1013dd00` (GotoState/execGotoState).
The focused linked export inventory decodes the five tabled functions and
matches the listed source signatures and native indices. This document is
evidence for the VM contract; it is not an exhaustive native harness or a
claim of full script coverage.
