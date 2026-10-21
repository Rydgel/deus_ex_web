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
| `UFloatProperty` | `0x10166940` | value 0 | `appAtof`, then skips to `,` `)` CR LF; never NULL (so a bare `AltFire` imports 0) |
| `UBoolProperty` | `0x10166380` | `ReadToken` yields an empty token, which matches no spelling: NULL | `ReadToken(0x400)`, then `appStricmp` against `1`, `True`, `True` (`0x101b1344`, `0x101b1348`, `0x101a7d4c`) to set the bit, `0`, `False`, `False` (`0x101b1354`, `0x101b1358`, `0x101a7dcc`) to clear it; anything else NULL. It never reads its port flags, so the console's flags 1 take the same fixed spellings as config I/O ([config text](script-config.md)), as `ShowHud False` uses |
| `UStrProperty` | `0x10167980` | the empty string | port flags 1 lack `PPF_Delimited` (2), so the whole remaining text (to a NUL) is the value, quotes and trailing words included; never NULL. Measured in the original (travel step 2): `GiveNanoKey TestKeyA "Test key A"` leaves `Description="Test key A"` and `GoalAdd GoalOne "Reach the dock" 1` leaves `Text="Reach the dock" 1` in the travel text |
| `UNameProperty` | `0x101674d0` | `ReadToken(0x400)` yields an empty token: `FName("")` is `None`, not NULL | `ReadToken(0x400)` (an identifier or a quoted token), then `FName(FNAME_Add)`; a NULL `ReadToken` ends the parse. The same body `set` uses ([console command](script-console-command.md)); `GiveNanoKey`'s `Name newKeyID` and `GoalAdd`'s `goalName` are the first parameters that reached it (travel step 2) |
| `UObjectProperty` | `0x10166e20` | `ReadToken` (`0x10164cb0`) yields an empty token, not `None`; `StaticFindObject` finds nothing, so it stores None and returns NULL | an actor/object name: not linked (explicit boundary) |
| `UClassProperty` | `0x10167110` | as `UObjectProperty` | [Class parameters](#class-parameters-2026-10-15) |

So `PutInHand` runs `PutInHand(None)`, and `DropItem` runs `DropItem(None,
False)`. Both parameters are optional, so the parse stops at the first one.
Any other parameter type stays an explicit boundary. An int past 32 bits is
also unrecovered.

## Class parameters (2026-10-15)

`PlayerPawn.CheatView(class<actor> aClass)` and `ViewClass(class<actor> aClass,
optional bool bQuiet)` take a class by name (`CheatView DeusEx.Female4`); the live
scenes use them to put the camera behind a pawn
([visual acceptance](visual-acceptance.md#pilot-4-10_paris_club-dancers-in-view-2026-10-15)).
Play stopped at `ScriptConsoleExec ImportText is not linked for class`. The
original path is `UClassProperty::ImportText` (vtable `0x10175ec4` slot `+0x84`,
a thunk `0x10101190` to `0x10167110`), which calls `UObjectProperty::ImportText`
(`0x10166e20`, thunk `0x10101a37`):

1. `ReadToken(Buffer, Temp, 0x400, DottedNames = 1)` (`0x101020db`); a NULL token is a NULL result.
2. The token `None` (`appStricmp`, `0x1010239c`) stores None and returns the buffer after the token.
3. Spaces are skipped (`0x10166eaf`) and **one wide character is consumed whatever it is** (`0x10166eba`, `add esi, 2`).
   A quote there is `Class'Package.Object'` (`0x10166ed6..0x10166f2f`: `ReadToken` the path, the closing quote,
   `StaticFindObject(UClass, ANY_PACKAGE, class name, 0)`, then the object inside it); Play does not link it
   (an explicit error). Any other character leaves the token to `StaticFindObject(PropertyClass, ANY_PACKAGE, token,
   0)` (`0x1010326a`, arguments `[property+0x5c]`, -1, the token, 0); the result is written to the parameter whether or not
   it is found, and a miss returns NULL.
4. `UClassProperty::ImportText` (`0x10167110..0x10167174`): a found value that is not exactly a `UClass`
   (`[object+0x24] == 0x101f1c18`) or whose SuperField chain (`+0x28`) does not reach `MetaClass` (`[property+0x64]`) is
   cleared to None, and the result stays the buffer.

A text that ends at the token returns a pointer **one wide character past the terminator** (`DeusEx.Female4` returns 15
of 14 characters): a parameter that follows (ViewClass's `bQuiet`) would parse the memory after the string, which has no
source; Play stops there with an error instead of guessing. `src/runtime/script-class-import-text.mjs` is the
translation; `ScriptRuntime.importClassText` supplies `StaticFindObject` over the classes Play has linked (a class
Play has not linked yet is an explicit error, not a miss, because the original's table holds every class of a loaded
package, and two linked classes with one bare name are an error because hash order is not recovered) and the metaclass
from the parameter (`metadata.metaClass`).

`scripts/native-class-import-oracle.py` runs `UClassProperty::ImportText` from the unchanged Core.dll through the real
vtable slot (`UObjectProperty::ImportText` and `ReadToken` run unchanged; `StaticFindObject` and `appStricmp` are host
leaves that record their arguments) over a fixture of named objects; `scripts/validate-class-import-text.mjs` compares
28 texts (the pointer, the stored value, every `StaticFindObject` argument): 12 found, 3 cleared by the metaclass check, 10
NULL, equal. The same validator runs `CheatView` in Play (00_Training): the first actor of the class becomes `ViewTarget`
with `bBehindView`, the next calls cycle through the class and back to None, and an unlinked class is the explicit error.

The executor rule (`0x10150978–0x101509df`) is translated. It applies only
to the first parameter, and only when that parameter IsA `UObjectProperty`
(object or class) and its `PropertyClass` (`+0x5c`) is null or an ancestor
of the executor's class. The parameter then takes the executor and parsing
continues with the next one. The name token is the shared `parseToken(64,
escapes)` from [script-console-command.md](script-console-command.md),
which is checked against Core.

## Callers

The reach census now sends each bound command line through
`scriptConsoleExec`, with no executor. The executor rule cannot match any
Training binding: `PutInHand` and `DropItem` take a first `Inventory`, and
the other bound commands take an int or nothing. `PutInHand`, `DropItem`,
`ActivateBelt N` and `ActivateAugmentation N` all run through it.

Play's keys and `PlayerPawn.ConsoleCommand` now reach this entry through
the original chain, `UEngine::InputEvent` → `XInputExt::Process` →
`ExecInputCommands` → `UWindowsViewport::Exec` → `UPlayer::Exec`. That
chain passes the Actor as executor; see
[script-console-command.md](script-console-command.md). The viewer keeps
its own stand-ins only for the movement, use, fire and belt keys.
