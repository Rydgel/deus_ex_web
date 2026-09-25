# Console exec commands — 2026-09-24

A `User.ini` key binding such as `ActivateBelt 3` or `PutInHand` reaches the
player through `UObject::ScriptConsoleExec`. The census stopped `PutInHand`
and `DropItem` with `Incomplete ProcessEvent parameter block`, because it
called the exec function with only the arguments the command line held.
`ScriptRuntime.scriptConsoleExec` is now the translated entry.

## Body

Core.dll `?ScriptConsoleExec@UObject@@UAEHPBGAAVFOutputDevice@@PAV1@@Z`
(thunk `0x10101870`, body `0x10150860`):

1. Returns 0 while `GIsScriptable` (`0x101e5540`) is clear.
2. `ParseToken(Str, MsgStr, 64, 1)` (`0x10147ba0`) reads the name:
   - leading spaces and tabs are skipped;
   - a quoted token honours backslash escapes, and an unquoted one ends at
     a space or tab;
   - at most 63 characters are kept.

   An empty token returns 0.
3. `FName(MsgStr, FNAME_Find)` then `FindFunction(Name, 0)` selects the
   function, state first. The call returns 0 when the name is `None`, no
   function matches, or `FunctionFlags & FUNC_Exec` (`+0x6c`, `0x200`) is
   clear.
4. `ParmsSize` (`+0x76`) bytes are allocated with `alloca` and zeroed.
5. For each field while `PropertyFlags & (CPF_Parm|CPF_ReturnParm)` is
   `CPF_Parm`:
   - A first `UObjectProperty` whose class the `Executor` argument is an
     instance of receives the executor.
   - Otherwise `ParseNext` (`0x10147b50`) skips space, tab, CR, LF and `;`
     comments, and the property's `ImportText` (vtable `+0x84`, port flags 1)
     parses in place.
   - A NULL result ends the loop. For a `CPF_OptionalParm` (`0x10`)
     parameter the call proceeds. A required parameter logs `BadProperty`
     and skips `ProcessEvent`.
6. `ProcessEvent(Function, Parms, 0)` (vtable `+0x10`) runs. Then every
   parameter's `DestroyValue` (`+0x94`) runs, and the call returns 1.

The `ImportText` bodies the bound commands reach:

| Property | Body | Empty text | Text |
| --- | --- | --- | --- |
| `UIntProperty` | `0x10165f00` | value left 0, returns the buffer | `appAtoi` only when the text starts with `-` or a digit; skips every `-`/digit; never NULL |
| `UObjectProperty` | `0x10166e20` | `ReadToken` (`0x10164cb0`) yields an empty token, not `None`; `StaticFindObject` finds nothing, so it stores None and returns NULL | not linked (explicit boundary) |

So `PutInHand` runs `PutInHand(None)`, and `DropItem` runs `DropItem(None,
False)`. Both parameters are optional, so the parse stops at the first one.
Any other parameter type, and the executor match, stay explicit boundaries.
An int past 32 bits is also unrecovered.

## Callers

The reach census now sends each bound command line through
`scriptConsoleExec`, with no executor. The executor rule cannot match any
Training binding: `PutInHand` and `DropItem` take a first `Inventory`, and
the other bound commands take an int or nothing. `PutInHand`, `DropItem`,
`ActivateBelt N` and `ActivateAugmentation N` all run through it.

Play's viewer still maps its keys to fixed calls (`ActivateBelt`, `use()`,
`pressFire()`). Routing the whole `User.ini` binding table through
`UInput::Exec` and this entry is separate input work.
