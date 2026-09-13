# Original string operations for mission scripts

Authority is the installed GOTY `Core.u` TextBuffer/bytecode and `Core.dll`
(SHA-256 `8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`).
This contract was traced before adding the VM operations below.

`Object` declares string equality at native 122, inequality at 123, and `Caps`
at 235. Equality's exported thunk `10101b81` jumps to `1013b560`; inequality's
`1010304e` jumps to `1013b730`. Both evaluate the two FString operands in
order, advance past EndFunctionParms, and pass their null-terminated text to
`appStrcmp` (`101012c1 → 10123540`). That helper calls MSVCRT `wcscmp` through
IAT `102ab4ec`. An FString with ArrayNum zero uses the static empty string.
Equality normalizes the comparison at `1013b613–1013b618` using neg/sbb/inc;
inequality uses neg/sbb/neg at `1013b7e3–1013b7e9`. Therefore both compare
UTF-16 text up to the first zero unit, case-sensitively. Native temporary
destruction follows the return-value write. The logical VM uses immutable
strings; the general raw allocator remains a separate boundary.

## Len, InStr, and Mid (natives 125–127)

The installed `Core.Object` declarations are `Len(coerce string S)` at native
125, `InStr(coerce string S, coerce string t)` at native 126, and
`Mid(coerce string S, int i, optional int j)` at native 127. Their exported
thunks are `101018ac`, `10103300`, and `10101d3e`; the wrappers enter
`1013bad0`, `1013bc40`, and `1013bdf0` respectively. The original wrappers
evaluate each expression once in declaration order and advance over
`EndFunctionParms` by 2, 3, and 4 bytes in the focused probe, including the
omitted optional `Mid` count.

`execLen` reads `FString.ArrayNum` directly through `FString::Len` at
`10108410`: zero ArrayNum returns zero, otherwise the native returns
`ArrayNum - 1`. This counts UTF-16 code units, so `A😃Z` has length 4. A raw
FString whose storage is `a`, zero, `b`, zero reports 3 because the header still
contains four units; the logical JavaScript adapter rejects embedded-zero
storage because it has no independent ArrayNum header.

`execInStr` calls `FString::InStr` at `10108900` with start index zero. The
ordinary branch reaches `appStrstr` (`1010203b → 101234e0`) and the CRT
`wcsstr` import, then converts a found pointer to a UTF-16 code-unit offset;
no match is `-1`. The search is case-sensitive, an empty needle returns zero,
and both strings stop at their first zero unit. Thus the logical helper uses
terminated text and UTF-16 `indexOf` indexing; a needle after an embedded zero
cannot match.

`execMid` evaluates `S`, `i`, and the optional `j`, initializes omitted `j` to
`0xffff`, and calls `FString::Mid` at `101086e0`. A negative or out-of-range
start produces the raw empty FString. A zero count is empty; a negative count
selects the remainder, while an omitted count selects at most 65535 units and
a larger positive count clamps to the end. The result copies the selected
UTF-16 units plus a terminator and can
split a surrogate pair (`Mid("A😃Z",1,1)` is the lone high surrogate). As with
the other count-storage operations, the logical adapter rejects raw
embedded-zero storage even though the native body follows its independent
ArrayNum.

String concatenation `$` is native 112, `1010187a → 1013aa70`. It evaluates
both converted string operands and calls `FString::operator+(FString)` at
`1013aaf6` (`101013fc → 10107be0`). That wrapper supplies the right operand's
text (or the static empty string for ArrayNum zero) to
`operator+(TCHAR*)` (`10101fc3 → 101079b0`). The latter copies the first
operand's ArrayNum units, adds the right text's length, and copies the right
text over the left terminator (`10107a21–10107a43`). Its empty-left branch
allocates only for nonempty right text (`10107a45–10107a88`). The result
contains no inserted separator. The logical adapter supports ordinary
terminated strings; embedded-zero/count-storage cases remain explicit errors.

`At_StrStr` (`@`) is native 168, with thunk `10101e2e` entering
`1013ac30`. It evaluates `A` and `B`, constructs `A + TCHAR[101aafcc]`, then
appends `B` through the same FString operator. The hash-pinned Core.dll raw
`.data` bytes at `101aafcc` are `20 00 00 00`, establishing the original
UTF-16 separator U+0020; the initializer audit found no process-startup write
because this is already a raw image literal. The logical helper returns
`A + ' ' + B`, rejects embedded-zero storage, and is checked by the
[native 168 oracle/validator](script-at-string.md).

`Left` is native 128, declared by the installed `Core.Object` as
`Left(coerce string S, int i)`. Its exported thunk `10101ba4` jumps to
`execLeft` at `1013bfd0`, which evaluates the FString and int operands in that
order and calls `FString::Left` through `10101492` to body `10108430`. The body
uses the FString used count minus its terminator as the content length, clamps a
negative `i` to zero, clamps a larger `i` to that content length, and copies the
selected UTF-16 units plus a terminator. Zero selected units produce the raw
empty FString form. The logical helper preserves UTF-16 unit indexing; malformed
embedded-zero storage remains explicit because JavaScript strings do not carry
the original independent ArrayNum header. Nine cases execute these unchanged
Core.dll instructions, including negative/oversized counts, a 16-unit
`HUDInfoLinkDisplay.SetSpeaker` case, and a surrogate-pair split.

`Right` is native 234. Its exported wrapper thunk `10101f19` jumps to
`execRight` at `1013c1a0`, evaluates the FString followed by the int, and calls
`FString::Right` through thunk `10101929` to body `101085f0`. The body derives
the content length from `ArrayNum-1`, clamps a negative count to zero and an
oversized count to the full length, then starts the copy at `length-count`.
The result uses the same raw-empty versus allocated UTF-16 copy behavior as
`Left`. Eight unchanged Core.dll cases cover empty, negative, zero, partial,
exact, oversized, and surrogate-splitting inputs. This native is required by
the authored `SetupEventCheckObject` NanoKey path to remove its `NK_` prefix.

`Chr` is native 236, declared as `Chr(int i)`. Its thunk `1010279d` jumps to
`execChr` at `1013c520`. The wrapper evaluates the int once, advances past
`EndFunctionParms`, narrows the result with `movw` to one UTF-16 unit, and
assigns a two-unit FString (character plus terminator) directly to the caller
result. The low word is kept without range clamping, so negative and oversized
int32 values wrap modulo `0x10000`; a zero low word produces the raw empty
FString form. The logical adapter preserves lone surrogate units and requires
a signed int32 input. Its original-DLL oracle covers the result counts,
allocation headers, evaluation event and two-byte cursor advance; see
[`script-chr.md`](script-chr.md).

`execCaps` is `10101af5 → 1013c370`, which evaluates its string, advances Code
past EndFunctionParms at `1013c3bb–1013c3c6`, and calls
`FString::Caps` (`10103224 → 10108c50`). This copies the null-terminated input
then visits the input ArrayNum code units. The exact loop at
`10108cea–10108d16` changes only unsigned units `0x61..0x7a`, subtracting
`0x20`; it leaves accented letters and UTF-16 surrogate units unchanged.
JavaScript Unicode uppercasing would be incorrect. An input with an embedded
zero and a larger used count would make this native loop overrun its shortened
copy; that raw malformed-storage case is explicitly unsupported by Caps.

`execNameToString` is `10103152 → 101320b0`. Its registration at `10132150`
loads `intUObjectexecNameToString` (`101aa778`, value `10103152`) and assigns
GNatives slot `0x57` (`101f4314`). It evaluates a four-byte FName index,
loads `GNames[index]` through `102961f0` at `101320db–101320e6`, then uses
the entry's text at `+0x0c`. It copies that spelling into the output FString,
with length including the terminator for nonempty text (`101320eb–10132141`).
It neither lowercases nor adds an object-style number suffix. The VM's logical
name value is already a spelling, so this conversion preserves it. Reproducing
which capitalization wins in the complete native global name-loading order
remains a loader boundary; this operation does not invent a second name table.

Reference cases are `HUDInfoLinkDisplay.SetSpeaker`'s `Left(BindName,16)`,
`ConPlayBase.SetupEventCheckObject`'s `Right(objectName, Len(objectName)-3)`,
original `DataLinkTrigger.Touch`'s NameToString operand,
the `Caps` and equality expressions in `DeusExPlayer.GetActiveDataLink`, and
the empty Message inequality in `Engine.Trigger.Touch`. A small original-DLL
probe checks the Caps loop including non-ASCII units and the NameToString
GNames lookup/copy. Its bound expression evaluator, string-length import and
preallocated output are explicit harness services, not native heap evidence.

## Extension StringToName (native 1024)

`Extension.ExtensionObject.StringToName` is inherited by Window. The installed
`Extension.dll` SHA-256 is
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`.
Its exported function is the body at `10037940`; it does not read a Window
field. It evaluates one FString and advances past EndFunctionParms at
`1003798d–10037997`. Starting at `100379a5`, it scans UTF-16 code units until
zero, accepting only ASCII letters, digits, underscore and hyphen. At the
first other unit it calls `GError.Logf` with the full terminated input and
invalid unit (`100379fa–10037a15`); it does not edit or trim the text.
The call resolves through Core's `FOutputDevice::Logf` import. The concrete
error-device behavior is an explicit service, including any exception it raises.
If that service returns, control continues to the FName constructor.

At `10037a18–10037a1f`, it calls imported
`FName(const TCHAR*,EFindName)` with the original text and mode `1`
(`FNAME_Add`). The result index is written at `10037a25–10037a2b`, before
FString cleanup. The logical helper requires the shared name table's interning
service; it must not return the input string as a fabricated FName. The existing
[name table](script-names.md) supplies recovered lookup/add behavior when the
host has initialized that table. Empty text follows that constructor's None
path. First-invalid-unit and interning call order are checked against original
Extension instructions with explicit expression/error/interning harness services.

## Shared native dispatch

`ScriptRuntime` routes Extension native 1024 through `extensionStringToName`.
The host must supply `nameServices.internName(text, findType)` returning the
resolved FName spelling used by the logical VM, and `nameServices.logError`
when an invalid character is encountered. The runtime does not initialize a
second name table or infer root-window readiness. A native comparison covers
the scan and error/intern call order; an original GetActiveDataLink bytecode
case covers the shared native call and its result flowing into FlagBase.
