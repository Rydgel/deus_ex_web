# Core object destruction and property cleanup

The authority is the hash-verified original GOTY Core.dll recorded in
[execution evidence](script-execution.md). These operations act on an explicitly
registered object identity. They do not construct an actor, remove world
relationships, or reclaim the object registry entry.

## Conditional and base destruction

`UObject::ConditionalDestroy` (thunk `0x10102270`, body `0x1014fdb0`)
returns zero if the internal object index at `+0x04` is `-1`, or if the
ObjectFlags word at `+0x1c` already has `0x00800000`. Otherwise it sets that
bit before calling the object's virtual `+0x24` destruction hook. A recursive
call consequently does not run the hook again. Afterward it diagnoses a
missing `0x80000000` flag and returns one. The warning does not replace that
return with failure.

`UObject::Destroy` (body `0x1014fa50`) sets `0x80000000` before calling
`ExitProperties(this,Class)`, then `SetLinker(NULL,-1)`. Finally it writes
`Outer->ObjectIndex`, or zero for a null Outer, to the internal word at
`+0x14`. This word previously held the linker export index. Neither operation
clears the script state frame, pending actor links, primitive fields or object
references. The actor-specific prelude remains a distinct native virtual hook;
see [actor destruction](script-destroy.md).

`SetLinker` (thunk `0x10101631`, body `0x1014fb20`) first handles the old
linker when present. Its export array is at `Linker+0x84`, export stride is
`0x24`, and the object pointer is at export `+0x1c`. It asserts that this
pointer is non-null and equals this object, then clears the pointer
(`0x1014fb54–0x1014fb9e`). It stores the new linker and index at object
`+0x10/+0x14` (`0x1014fba4–0x1014fbb0`). It does not populate a new
linker's export entry; that belongs to the caller's loading/construction path.

## Destructor chain

`ExitProperties` (body `0x10152250`) starts at `Class+0x68` and follows
property `+0x54`. Each call is property virtual `+0x94`, receiving the object's
data plus property offset `+0x48` (`0x10152271–0x1015229e`). It does not
iterate all properties and reset them to defaults.

`UStruct::Link` (body `0x10126060`) builds this chain from the original
ordered property iterator. At `0x10126466` it tests property flags bit
`0x00400000`, appends matching properties to the chain beginning at struct
`+0x68`, and advances its tail to property `+0x54`. This retains derived
children followed by inherited children. Original Engine.u property metadata
retains the bit: Actor.BindName is `0x400001`, FamiliarName is `0x408001`;
Actor.Owner and Actor.Region have no such bit.

`UStrProperty::DestroyValue` (thunk `0x101031c5`, body `0x10167ba0`)
iterates the fixed array dimension at property `+0x34`, advances by element
size `+0x38`, and invokes the FString destructor for each element. The
FString destructor (thunk `0x10101339`, body `0x101075a0`) clears its length
and capacity, then calls array Realloc with element size two. Thus releasing
a string leaves the script-visible empty value; it does not preserve its
old text or reset it to an authored class default.

## Runtime binding

`script-object-lifecycle.mjs` translates conditional destruction, base
destruction and linker detachment against a native object record with
`identity`, `index`, `flags`, `outer`, `linker` and `linkerIndex`. A linker
contains export records whose `object` is the same script identity. The native
record's `destroy` callback selects the established native class hook.

`ScriptRuntime.bindNativeObject` binds Class, Name, Outer and ObjectFlags to
that record. For Actor ancestry, event pending-kill filtering reads bDeleteMe:
the original `AActor::IsPendingKill` thunk `0x10302167`, body `0x1030df80`,
returns `(ActorFlags >> 7) & 1`. Other objects retain the base false result.
Raw ObjectInternal pointer values are not emulated by this binding.

Class loading now retains the original property order and destructor chain.
`exitProperties` implements the string cleanup above, including fixed arrays of
strings. Other owning property destructors remain explicit unsupported cases.
Base destruction leaves ordinary property values and the state continuation
intact. Registering/allocating identities, AActor's auxiliary native object at
`+0x314`, native subclass hooks, and final garbage collection remain separate
work; merely binding an existing record does not claim those operations.

`destroyActorBase` implements AActor's destruction prelude when its native
record explicitly supplies the auxiliary pointer at Actor `+0x314`. A non-null
pointer is conditionally destroyed, then cleared, before the Core base hook.
Its concrete native class still determines which destruction callback is bound.

`modifyScriptObject` implements the ordinary UObject.Modify body (thunk
`0x101014d8`, body `0x10150170`). With the undo global at `0x101e3318`
non-null and object flag `1` set, it calls undo virtual `+0x00` with this
object (`0x1015018e–0x101501b0`). Otherwise it returns without mutation.
The host supplies the undo boundary explicitly; a null undo subsystem is the
original no-transaction case, not a simulated editor transaction.
