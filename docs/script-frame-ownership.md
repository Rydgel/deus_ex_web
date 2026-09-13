# Script call and event temporary ownership

The authority is the installed GOTY Core.dll, SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`,
disassembled in the ignored `.cache/research/Core.asm`. This trace corrects
two omissions in the earlier ProcessEvent notes before extending the VM.

## Recovered contract

`CallFunction` (`1013f4e0`) zeroes its whole parameter/local block, evaluates
arguments into that block, and runs ProcessInternal. The Return expression
writes the caller's result before CallFunction resumes. At `1013f625–1013f654`
the out records copy back in reverse order through CopyCompleteValue. Then
`1013f656–1013f678` walks Function `+68`, calls each property's DestroyValue
`+94` at `locals + Offset(+48)`, and reads Next `+54` after the callback.
All owning fields in this chain, including parameters, are temporaries of
this call. The already copied caller result and out destinations survive.
UFunction's inheritance virtual returns null (`1010ff00`), so this chain
contains its own properties; it does not inherit SuperFunction's locals.

`ProcessEvent` (`1013f7d0`) first calls IsPendingKill at `1013f84d` and
**returns for any nonzero result** (`1013f850–1013f852`). Only on zero does it
compare AX with iNative (`1013f858–1013f85c`). The prior notes' equality-only
interpretation missed the first branch.

ProcessEvent copies the raw parameter prefix into its temporary frame, zeroes
only the local suffix, executes, and copies the parameter prefix back. During
destructor traversal it tests signed property Offset against zero-extended
ParmsSize (`1013f963–1013f96e`). It calls DestroyValue **only for offsets at
or beyond ParmsSize** (`1013f970–1013f97a`). Parameters retain the ownership
transferred back to the caller. The earlier notes incorrectly described
unconditional destruction of the whole chain.

UFunction's loading Serialize branch (`101290c2–1012915c`) establishes the
parameter prefix: walk Children/Next while the child is a UProperty with
Parm `0x80`; increment NumParms and set ParmsSize to the property's
Offset + ElementSize * ArrayDim (stored as a word). ReturnParm `0x400` also
sets ReturnValueOffset. The first nonparameter terminates this pass.
For a valid linked function, the logical VM can therefore select the
destructor suffix by excluding parameter fields. Return properties belong
to the parameter prefix; the typed caller result reference described below
represents that field without transferring its ownership to the event frame.

UStruct::Link builds the owning chain in Children order by NeedCtorLink
`0x400000` (`10126466–101264a4`); see [link evidence](script-struct-link.md).
String and owning-struct destruction use the existing
[DestroyValue translation](script-property-destroy.md).

## Reference cases established before integration

- Ordinary call: an owning input/out string, string local and string return;
  the out destination/result keep their values after all owning temporary
  fields are destroyed, in linked child order.
- Event: string parameter + string local; the incoming local is zero, changed
  parameter bytes copy back, and only the local is destroyed.
- Owning struct local: destroy its owning members, preserving object identity
  and numeric members; nested frames use independent storage.
- Pending-kill result 1 with iNative 1: the original exits before dispatch,
  disproving the previous equality-only gate.
- Installed `DeusEx.ColorTheme.SetThemeName` has 13 expanded bytes:
  Let(instance `themeName`, local `newThemeName`), Return Nothing.
  `GetThemeName` returns that same instance property (8 expanded bytes,
  including its trailing void return). These original bodies establish that
  string parameter cleanup must preserve the assigned property and the
  getter's returned string. The validator exercises both through the VM,
  plus SetThemeName through the typed ProcessEvent entry. This is a script
  value boundary check, not UI construction or rendering coverage.

Logical strings are immutable JavaScript values and keyed structs are typed
value copies. This integration models value ownership and destruction order;
it does not claim native heap pointers or allocation identity. Dynamic
array/map storage, native ProcessEvent hooks, arbitrary raw native event blocks,
and exception/unwind cleanup remain explicit boundaries. A host error is an
unsupported execution stop, not an invented original script exception path.

## Verification

`node scripts/validate-script-frame-ownership.mjs` matches four focused cases
against the real `ProcessEvent` wrapper and FString destructors. The probe
binds the event body and IsPendingKill result explicitly, retaining original
copy loops, zeroing, gates and destruction traversal. It checks the changed
caller parameter before each local destructor, native heap event order, local
zeroing, and pending-kill values 1 and 65536. The logging allocator is the
existing destruction probe's service, not a recovered heap implementation.

`node --test test/script-frame-ownership.test.mjs` checks the new typed
integration boundaries: reverse out copyback, return preservation, event
parameter ownership, nested owning-struct local cleanup, and the corrected
entry gates. Existing real TriggerToggle/state/timer bytecode checks continue
to pass in `scripts/validate-script-runtime.mjs`.

## Return-bearing event blocks

The same original ProcessEvent body zero-extends UFunction.ReturnValueOffset
at `1013f928` and passes `Locals + ReturnValueOffset` as the script body's
result pointer (`1013f92f–1013f939`). This lies inside the caller-owned
parameter prefix for a declared ReturnParm. The subsequent raw prefix copyback
therefore includes the returned value; destruction still skips every property
whose Offset is below ParmsSize. An owning return string belongs to the caller,
just as an owning ordinary event parameter does.

The typed host represents this slot with an explicit result reference supplied
to ProcessEvent. Its initial value is copied into the event block before the
body; its final value is copied back before local destruction. Probe, pending
kill and native-index early exits leave that reference untouched. ProcessInternal
singular suppression similarly leaves the copied initial result unchanged.
This establishes a typed result block, not arbitrary raw native caller memory.
