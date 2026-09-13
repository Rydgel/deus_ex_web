# Standalone script events: `UObject::ProcessEvent`

This note records the ordinary, standalone event wrapper recovered from the
original Deus Ex GOTY Core binary. It covers `UObject::ProcessEvent` and the
script implementation it enters. Networking, replication, and the native DLL
extension implementation behind the virtual hook are outside this trace.

The source binary is `Deus Ex GOTY Edition/System/Core.dll`, SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`. The
export thunk `ProcessEvent@UObject` is at `0x1010305d`; its body is
`0x1013f7d0` in `.cache/research/Core.asm`. The export has three explicit
arguments after `this` (`UFunction*, Params, Result`) and ends with
`ret $0xc`. The body does not read its third explicit argument (`Result`,
`[ebp+0x10]`).

## Entry gates and dispatch order

The observed order is:

```text
ProcessEvent(this, Function, Params, ignoredResult):
    if global[0x101e5540] == 0:
        return

    name = Function.u32(+0x20)
    if 0x12c <= name < 0x16c and this.StateFrame(+0x0c) != null:
        mask = MakeProbeMask(name - 0x12c)       // 0x1016eea0
        enabled = (mask.low  & StateFrame.u32(+0x1c)) |
                  (mask.high & StateFrame.u32(+0x20))
        if enabled == 0:
            return

    filterResult = this.vtable[+0x2c]()
    if filterResult != 0:
        return
    if uint16(filterResult) != Function.u16(+0x70):
        return

    if Function.u32(+0x6c) & 0x400:              // FUNC_Native
        if this.vtable[+0x18](Function, Params, 0) != 0:
            return

    depth[0x101e556c]++
    run the temporary-frame script path
    depth[0x101e556c]--
```

The initial global test is at `0x1013f7eb`–`0x1013f804`; its symbolic name
and the conditions that set it are unresolved here. The probe range and mask
test are at `0x1013f80d`–`0x1013f843`. `MakeProbeMask` shifts a 64-bit value
for the requested bit. Bits 0 through 31 are compared with the low state word
at `StateFrame+0x1c`; bits 32 through 63 use the high word at `+0x20`. The
same range and mask convention is independently present in `IsProbing` at
`0x10115670`.

The virtual call at `+0x2c` is the exported `IsPendingKill` slot
(`0x101028a1`); the base implementation at `0x1010ab80` returns zero. Core
first rejects its nonzero result (`1013f850–1013f852`), then compares the
zero 16-bit result with the function's 16-bit field at `+0x70`. Thus only
`IsPendingKill() == 0` and `iNative == 0` pass. The earlier equality-only
interpretation omitted the first branch; [frame ownership](script-frame-ownership.md)
records the correction and native comparison.

The `FUNC_Native` test is the high-byte bit test at `0x1013f862`–`0x1013f868`,
which is flag `0x400`. The hook receives `(Function, incoming Params, 0)` at
`0x1013f86a`–`0x1013f875`; a nonzero return means it handled the event and
skips the temporary frame. A zero return falls through to the script path.
The hook's implementation-specific behavior is deliberately not inferred.

There is no `FUNC_Defined` (`0x2`) branch in `ProcessEvent`. There is also no
`FUNC_Singular` (`0x20`) branch in `ProcessEvent`. The latter is enforced by
`ProcessInternal` (`0x1013f690`) after its native hook: it tests the function's
`0x20` bit against the target word at `this+0x1c`, skips a reentrant call when
the bit is already set, sets it while the script body runs, and clears it on
return. The same `ProcessInternal` path is reached by `CallFunction`'s script
fallback, so the singular guard is shared by both call origins. A hook-handled
native function exits before that `ProcessInternal` guard.

## Temporary frame and parameter ABI

After all gates, the body increments the standalone-event depth at
`0x1013f880`–`0x1013f88a`. The counter is balanced after destruction at
`0x1013f985`–`0x1013f98b`; timing bookkeeping around the first/last depth is
not part of the event ABI.

The exact body sequence (`0x1013f8aa`–`0x1013f984`) is:

1. Read the total parameter/local block size from `Function+0x3c` and ask the
   FMemStack allocator at `0x1016efa0` for
   `(((size + 7) & ~7) + 3) & ~3` bytes.
2. Read the parameter byte count as an unsigned 16-bit value from
   `Function+0x76`.
3. Copy exactly that many bytes from the incoming `Params` pointer to the
   temporary block with `rep movsd` plus `rep movsb`.
4. Zero the remainder `[paramBytes, totalSize)`; this is the local-variable
   area.
5. Build a fresh `FFrame` (vtable `0x101752b8`) with these fields:

   | FFrame offset | value written by `ProcessEvent` |
   | ---: | --- |
   | `+0x04` | `Function` |
   | `+0x08` | target `this` |
   | `+0x0c` | script code pointer `Function+0x44` |
   | `+0x10` | temporary parameter/local block |

6. Compute `Result = temporary + uint16(Function+0x78)` and call the
   implementation pointer at `Function+0x7c` with `ECX=this`, the fresh frame,
   and this result pointer. For a script implementation this enters
   `ProcessInternal`; a void body consumes `Return, Nothing` (`0x04, 0x0b`).
7. Copy exactly `paramBytes` bytes from the temporary block back to the
   original `Params` pointer.
8. Walk the property destruction chain starting at `Function+0x68`. For each
   property whose signed Offset `+0x48` is at or beyond unsigned ParmsSize
   `+0x76`, call its vtable `+0x94` (`DestroyValue`) on that temporary slot,
   then follow `property+0x54`. The parameter prefix is skipped
   (`1013f963–1013f96e`); its ownership has been copied back to Params.
9. Decrement the event depth and return. The temporary is FMemStack storage;
   no result is returned to the ProcessEvent caller.

In compact form:

```text
tmp = FMemStack.alloc(round4(round8(Function[+0x3c])))
copyBytes(tmp, Params, uint16(Function[+0x76]))
zeroBytes(tmp + uint16(Function[+0x76]),
          Function[+0x3c] - uint16(Function[+0x76]))
frame = FFrame(Node=Function, Object=this,
               Code=Function[+0x44], Locals=tmp)
Function[+0x7c](frame, tmp + uint16(Function[+0x78]))
copyBytes(Params, tmp, uint16(Function[+0x76]))
destroyPropertyChain(Function[+0x68], tmp, onlyOffsetsAtOrBeyond=paramBytes)
```

This is a raw block ABI. `ProcessEvent` does not parse argument expressions,
publish `0x101e32f8` out addresses, or maintain the reverse-order out-record
list used by `CallFunction` (documented in `script-execution.md`). An out
property is copied back as part of the same contiguous parameter byte range;
there is no extra `CopyCompleteValue` pass. The temporary still receives the
initial bytes copied from `Params`, so an out slot is not implicitly zeroed
unless the caller supplied zero bytes for it.

The incoming `Result` argument is ignored, even when non-null. A return
property, if present, is written at `temporary + Function+0x78`; bytes within
the parameter copyback range still reach the caller's `Params`. Ignoring the
separate Result pointer does not establish that a return property is discarded.
The typed host now represents a ReturnParm in that parameter range using the
fourth `processEvent(receiver,name,args,resultReference)` argument. This is a
reference to the caller's logical ReturnParm slot, not the ignored native
Result argument. Its value is copied in and back with the other parameters,
and survives local destruction; the original pointer/copyback path is checked
in [frame ownership](script-frame-ownership.md). Optional defaults are not synthesized;
the caller must provide the already formed parameter block. A null `Params`
pointer with a nonzero `Function+0x76` count is not a valid or traced case. A
zero count causes the copy loops to execute zero iterations, so the no-arg
events below do not read a parameter pointer.

The difference from `CallFunction` is therefore structural:

| Concern | Standalone `ProcessEvent` | `CallFunction` script path |
| --- | --- | --- |
| Arguments | raw `Params` bytes copied in | caller bytecode expressions evaluated into each property slot |
| Out parameters | included in one forward block copyback | address records, reverse property copyback |
| Locals | tail of block zeroed | fresh block zeroed before expression evaluation |
| Return | external result ignored; return-slot bytes follow the parameter copyback range | `ProcessInternal` receives caller result pointer |
| Optional arguments | caller supplies full block | early terminator leaves omitted trailing slots zero |
| Destruction | local suffix of property chain after block copyback | whole property chain after out copyback |

## State and callback reentrancy

`ProcessEvent` reads `this+0x0c` only for the probe mask gate. It does not
install, switch, or restore that `StateFrame`; state lookup and state
transitions occur outside this wrapper. The new FFrame's `Node` is the
UFunction and its `Object` is the target object, so a state transition made by
the callback can replace the target's StateFrame while the current temporary
frame continues to execute. A nested event observes the then-current state
frame when it enters its own gates.

The event depth counter at `0x101e556c` permits nested callbacks. Every nested
`ProcessEvent` allocates an independent temporary block and FFrame, and its
parameter copyback/destruction completes before the outer implementation
continues. The counter's timing side effects occur only on the outermost
entry/last exit; they do not merge the frames. `ProcessInternal` separately
tracks script recursion at `0x101f81c0` and applies the `FUNC_Singular` bit as
described above.

There is no general reentrancy suppression in `ProcessEvent`: a non-singular
event can call itself or another event recursively. A singular script event on
the same target is skipped by `ProcessInternal` while its outer body owns the
target bit. If the implementation pointer is handled by the native hook, the
script singular guard is not entered.

## Focused event declarations and probe names

Core's hardcoded-name initialization at `0x1014d6a4`–`0x1014d95f` calls
`AllocateNameEntry` with the following native EName indices. These are the
indices used by the `ProcessEvent` probe range; they are separate from a
package's serialized name table.

The complete 64-entry range is now recovered in `src/unreal/probe-names.mjs`;
its wider initialization span and all entries are recorded in
[the object/probe native contract](script-object-natives.md). Loaded function
names outside that complete table bypass the ProcessEvent probe-mask gate.

| event name | native EName | probe bit (`EName-0x12c`) |
| --- | ---: | ---: |
| `Trigger` | `0x132` | low state word bit `6` |
| `Timer` | `0x134` | low state word bit `8` |
| `BeginState` | `0x13c` | low state word bit `16` |
| `EndState` | `0x13d` | low state word bit `17` |
| `InterpolateEnd` | `0x146` | low state word bit `26` |

The local UnrealScript declarations are in
`.cache/research/pawn-startup/core.object.uc` (`BeginState()` and
`EndState()`) and `.cache/research/pawn-startup/engine.actor.uc` (`Timer()` and
`InterpolateEnd(actor Other)`). The package linker reports:

| function | package metadata | parameter children |
| --- | --- | --- |
| `Object.BeginState` | flags `0x800` (`FUNC_Event`), script size `2` | none |
| `Object.EndState` | flags `0x800` (`FUNC_Event`), script size `2` | none |
| `Actor.Timer` | flags `0x800` (`FUNC_Event`), script size `2` | none |
| `Actor.InterpolateEnd` | flags `0x800` (`FUNC_Event`), native index `0`, script size `2` | `Other`: `ObjectProperty`, `Parm` (`0x80`) |
| `Mover.InterpolateEnd` | flags `0x2` (`FUNC_Defined`), script size `225` | `Other`: `ObjectProperty`, `Parm`; `OldKeyNum`: byte local |
| `Mover.Timer` | flags `0x102`, script body present | none |

The three no-argument declarations have no parameter children, so their
`paramBytes` copy loop is empty and their two-byte script body is the minimal
void return sequence. `Actor.InterpolateEnd` has one by-value object parameter
(`Other`); in the 32-bit property ABI it occupies one object-pointer slot in
the raw incoming block. It is neither out, return, nor optional. The base
event's two-byte body still causes that slot to be copied in and back out; a
script override can read it through its local frame. `Mover.InterpolateEnd`
shows why `FUNC_Defined` must not be treated as a `ProcessEvent` gate: its
resolved script function carries that flag and still uses the same indirect
implementation path.

## Boundaries left unresolved

The disassembly establishes the gate order and byte-level frame ABI, but it
does not identify the symbolic owner of global `0x101e5540`, define behavior
for malformed `Params`, construct omitted optional arguments, or specify the
native hook's implementation. Function resolution/state installation before
`ProcessEvent`, replication routes, and network event serialization are
separate paths and are intentionally not inferred here.
