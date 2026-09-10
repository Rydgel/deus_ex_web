# Original Core object and probe natives

This note records the five Core natives used by the original Deus Ex GOTY
scripts. The declarations are from `.cache/reference/Object.uc` lines 260–288;
the implementation evidence is `.cache/research/Core.asm` from the original
`System/Core.dll` (SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`). The
native index is part of the script ABI and is separate from the address of the
export thunk.

```unrealscript
native(114) static final operator(24) bool == ( Object A, Object B );
native(117) final function Enable( name ProbeFunc );
native(118) final function Disable( name ProbeFunc );
native(254) static final operator(24) bool == ( name A, name B );
native(303) final function bool IsA( name ClassName );
```

The original export thunks and bodies are:

| native | Core export thunk | body | result |
| ---: | ---: | ---: | --- |
| 114 object `==` | `0x10102315` | `0x1013c940` | bool dword written to `Result` |
| 117 `Enable` | `0x10102d79` | `0x1013de80` | void; no result write |
| 118 `Disable` | `0x10102054` | `0x1013dfb0` | void; no result write |
| 254 name `==` | `0x101014ce` | `0x1013c7a0` | bool dword written to `Result` |
| 303 `IsA` | `0x10102801` | `0x1013ee60` | bool dword written to `Result` |

## Shared native argument stepping

The comparison natives call the original frame `Step` routine once per
operand, in declaration order. The first value is stepped into a four-byte
local, then the second value into another four-byte local. The frame's object
context (`FFrame.Object` at `+0x08`) is passed unchanged to both evaluations,
so a context expression can observe the same receiver and side effects occur
left to right. After the second `Step`, each native increments `Frame.Code` once
to consume the `0x16` end-of-function-parameters token before writing its
result.

`Enable`, `Disable`, and `IsA` use the same `Step` path for their one `name`
argument and advance `Frame.Code` once after it. `Enable` and `Disable` are
native statement calls: their C++ bodies return with `ret $8`, and they do not
fill the caller's `Result` slot. `IsA` is a value-returning native and writes a
bool dword as described below.

## Object equality, native 114

`UObject::execEqualEqual_ObjectObject` at `0x1013c940` compares the two values
with one integer `cmp` and writes `0` or `1` to the result pointer. It is raw
object identity:

```text
A = Step(ObjectExpressionA)
B = Step(ObjectExpressionB)
Result = (A == B)                 // pointer equality, including None
Frame.Code++                     // consume EndFunctionParms
```

The operator does not compare object names, classes, outers, flags, or property
contents, and it does not call an object method. Two null object values compare
equal; a null value and any non-null pointer compare unequal. The operands are
not coerced through `refValue` by Core: `Step` supplies the value for the
property type selected by the bytecode.

## Name equality, native 254

`UObject::execEqualEqual_NameName` at `0x1013c7a0` has the same two-Step ABI and
writes the result of a raw four-byte `FName` comparison:

```text
A = Step(NameExpressionA)
B = Step(NameExpressionB)
Result = (A == B)                 // FName value/index identity
Frame.Code++
```

The operator does not lower strings, compare display text, or resolve package
names. Name construction and lookup may canonicalize a source spelling before
it reaches the operator, but this body itself only compares the loaded FName
words. `NAME_None` is the zero FName value in the original stream and compares
equal only to another zero value.

## IsA, native 303

`UObject::execIsA` at `0x1013ee60` steps one `name ClassName` argument, consumes
`EndFunctionParms`, and starts at the receiver's class pointer. The relevant
original object offsets are:

| object | offset | value used |
| --- | ---: | --- |
| receiver | `+0x24` | `UClass* Class` |
| each class/state node | `+0x20` | FName `Name` |
| each class/state node | `+0x28` | `UStruct* BaseStruct` |

Its control flow is equivalent to:

```text
candidate = receiver.Class
while candidate != None:
    if candidate.Name == ClassName:
        Result = 1
        return
    candidate = candidate.BaseStruct
Result = 0
```

The name comparison is exact FName identity. The walk includes the receiver's
own class and every base struct/class until a null link. A null receiver class
therefore returns false. The native does not compare full package paths, object
names, class flags, object flags, or probe masks, and it does not treat null or
`None` as a wildcard. A name collision between classes in different packages is
not disambiguated by this body because it compares the class `Name` field only.

## Probe names and masks

`Object.uc` documents `Enable` and `Disable` as probe-message controls. In this
GOTY Core build both bodies accept only native EName indices in the half-open
range `0x12c <= ProbeFunc < 0x16c` (decimal 300 through 363). The bit number is
`ProbeFunc - 0x12c`, giving a 64-bit mask split into two dwords:

```text
makeMask(bit):
    if bit < 32:  low = 1 << bit,       high = 0
    else:        low = 0,               high = 1 << (bit - 32)
```

The helper implementing this split is at `0x1016eea0`; its invalid `bit >= 64`
path returns both dwords zero, although these natives reject such indices before
calling it. These are native EName identities, not package-local serialized
name-table indices. The ProcessEvent probe gate consumes the resulting current
frame bits as described in `docs/script-events.md`.

### Enable, native 117

The body reads the receiver's class at `this+0x24` and state frame at
`this+0x0c`. The current state node is at `FStateFrame+0x18`. The mask fields
observed by the body are:

| value | low dword | high dword |
| --- | ---: | ---: |
| `UState.ProbeMask` | `UState+0x6c` | `UState+0x70` |
| `UState.IgnoreMask` | `UState+0x74` | `UState+0x78` |
| current `FStateFrame` probe mask | `FStateFrame+0x1c` | `FStateFrame+0x20` |

After evaluating `ProbeFunc`, the native computes one requested bit and merges
it as follows:

```text
classMask = receiver.Class.ProbeMask
stateMask = receiver.StateFrame.Func.ProbeMask
allowed   = (classMask | stateMask) & receiver.StateFrame.Func.IgnoreMask
receiver.StateFrame.ProbeMask |= requestedBit & allowed
```

Only the selected bit is changed. Enable does not modify the class's or state's
stored ProbeMask, does not modify IgnoreMask, and cannot enable a probe that is
absent from both class/state ProbeMask values or masked out by the current
state's IgnoreMask. It writes only the current `FStateFrame+0x1c/+0x20` words.

If the EName is outside the valid range, or `this+0x0c` is null, the body takes
its diagnostic return path and leaves the masks unchanged. That path calls the
Core `Logf` helper with the name-table lookup rooted at `0x102961f0` and the
Enable diagnostic format at `0x101ab0a8`, then advances `Frame.Code` once. The
format strings themselves are not treated as a gameplay result here. For a
valid name, the body does not check `FStateFrame+0x18` or `this+0x24` before
reading their mask fields; a receiver without the normal class/current-state
invariant is outside this traced safe case.

### Disable, native 118

Disable uses the same valid native EName range and state-frame pointer. It
computes the selected bit and clears it directly from the current frame mask:

```text
requestedBit = makeMask(ProbeFunc - 0x12c)
receiver.StateFrame.ProbeMask &= ~requestedBit
```

The low and high dwords are cleared independently at `FStateFrame+0x1c` and
`+0x20`. Disable does not consult or change the receiver class mask, current
state ProbeMask, or IgnoreMask. It therefore suppresses a currently enabled
probe even when the class/state declarations would otherwise allow it.

An out-of-range EName or null `this+0x0c` takes the diagnostic return path and
leaves the frame mask unchanged. The Disable diagnostic uses the same name-table
root `0x102961f0` and a separate format at `0x101ab0f4`, then consumes the end
marker by advancing `Frame.Code`. Unlike Enable, the valid Disable path does not
dereference `FStateFrame+0x18` or the receiver class, so those additional
pointers are not required by this body once a state frame exists.

## Unsupported and unverified edges

The traces cover the original GOTY Core build and the declarations in its
`Object.uc`. They do not establish behavior for other UE1/Deus Ex binaries,
non-native-name probe inputs, malformed FName values, or a receiver whose
native object layout is incomplete. The diagnostic path's exact localized log
text and behavior for an out-of-bounds name-table index were not inferred. The
native `ClassIsChildOf` function (258), inequality operators, state installation,
and the code that initially constructs or replaces `FStateFrame` are separate
paths and are intentionally outside this note.

## Complete hardcoded probe EName table

The original Core startup initializer contains one `AllocateNameEntry` call for
every native index in the half-open range `0x12c <= index < 0x16c`. The first
call is at `0x1014d5dd` (index push at `0x1014d5d3`) and the last is at
`0x1014de3b` (index push at `0x1014de31`). Each call passes the address of a
UTF-16 string in the original `.data` image, beginning at `0x101acbc0` and
ending at `0x101ad0a8`. The complete decoded sequence is:

```text
0x12c Spawned
0x12d Destroyed
0x12e GainedChild
0x12f LostChild
0x130 Probe4
0x131 Probe5
0x132 Trigger
0x133 UnTrigger
0x134 Timer
0x135 HitWall
0x136 Falling
0x137 Landed
0x138 ZoneChange
0x139 Touch
0x13a UnTouch
0x13b Bump
0x13c BeginState
0x13d EndState
0x13e BaseChange
0x13f Attach
0x140 Detach
0x141 ActorEntered
0x142 ActorLeaving
0x143 KillCredit
0x144 AnimEnd
0x145 EndedRotation
0x146 InterpolateEnd
0x147 EncroachingOn
0x148 EncroachedBy
0x149 FootZoneChange
0x14a HeadZoneChange
0x14b PainTimer
0x14c SpeechTimer
0x14d MayFall
0x14e Probe34
0x14f Die
0x150 Tick
0x151 PlayerTick
0x152 Expired
0x153 Probe39
0x154 SeePlayer
0x155 EnemyNotVisible
0x156 HearNoise
0x157 UpdateEyeHeight
0x158 SeeMonster
0x159 SeeFriend
0x15a SpecialHandling
0x15b BotDesireability
0x15c Probe48
0x15d Probe49
0x15e Probe50
0x15f Probe51
0x160 Probe52
0x161 Probe53
0x162 Probe54
0x163 Probe55
0x164 Probe56
0x165 Probe57
0x166 Probe58
0x167 Probe59
0x168 Probe60
0x169 Probe61
0x16a Probe62
0x16b All
```

There are no unassigned holes in this range. The `Probe4`, `Probe5`,
`Probe34`, and `Probe39`–`Probe62` strings are the literal names allocated by
Core and remain valid EName entries; they are not placeholders that can be
removed from the table. The implementation-facing lower-case map is in
`src/unreal/probe-names.mjs`.
