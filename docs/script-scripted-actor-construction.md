# `DataLinkPlay` scripted Actor construction

This is the source and native record for constructing the installed
`DeusEx.DataLinkPlay` class. It closes the constructor-selection question for
this class while keeping the remaining `ULevel::SpawnActor` and ConSys/UI
services explicit. The authority is the local GOTY build:

| file | SHA-256 |
| --- | --- |
| `System/Core.dll` | `8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4` |
| `System/Engine.dll` | `0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4` |
| `System/DeusEx.u` | `257f5c166739b3d13884a8b8e98a47dda458b325fa929b3b3b99be056cb74480` |

The implementation record is
[`src/runtime/script-scripted-actor-construction.mjs`](../src/runtime/script-scripted-actor-construction.mjs).
It is a strict selector and layout report. It does not select the Actor
constructor for arbitrary script classes.

## Package chain and source

The installed package records are:

| class | export | export flags | serialized `ClassFlags` | serialized super |
| --- | ---: | ---: | ---: | --- |
| `DeusEx.DataLinkPlay` | 1154 | `0x000f0004` | `0x3a` | export 4533, `ConPlayBase` |
| `DeusEx.ConPlayBase` | 4533 | `0x000f0004` | `0x32` | import `-3`, `Engine.Actor` |
| `Engine.Actor` | 2 | `0x040f0004` | `0x833` | import `-3`, `Core.Object` |

The extracted original declarations are exact:

```unrealscript
class DataLinkPlay expands ConPlayBase transient;
class ConPlayBase expands Actor;
```

Neither script declaration contains `native`, and neither class declares a
`PreBeginPlay`, `Spawned`, `BeginPlay`, `PostBeginPlay`,
`PostPostBeginPlay`, or `SetInitialState` override. Their startup behavior is
therefore inherited from `Actor.uc`.

## Constructor selection in Core

Core `UClass::Bind` is the thunk at `0x10102afe`, with body `0x10127a20`.
The body first calls `UField::Bind` and then reads `ClassConstructor` at
`UClass+0x4e0`. If that slot is empty, it tests the runtime UObject flags at
`UClass+0x1c` against `0x04000000`. Only a class with that native flag takes
the `GetDllExport` path, which formats the C++ constructor name and checks the
returned class identity before copying the exported pointer.

For a script-only class the native flag is clear. The body instead reads the
superclass at `UClass+0x28`, calls the superclass `Bind` virtual at slot
`+0x5c`, reads the superclass `ClassConstructor` at `+0x4e0`, and stores that
pointer into the current class. The final body assertion at `0x10127b66`
requires the slot to be non-null. The relevant instructions are:

```text
0x10127a84  mov eax,[esi+0x4e0]
0x10127a92  test [esi+0x1c],0x04000000
0x10127b42  mov eax,[esi+0x4e0]
0x10127b4c  mov edi,[esi+0x28]
0x10127b53  call [edx+0x5c]       ; Super->Bind()
0x10127b5a  mov eax,[edi+0x4e0]
0x10127b60  mov [esi+0x4e0],eax
0x10127b66  assert ClassConstructor != null
```

`DataLinkPlay` and `ConPlayBase` consequently do not look for a
`DataLinkPlay` or `ConPlayBase` export in `DeusEx.dll`. The chain is:

```text
DataLinkPlay::Bind
  -> ConPlayBase::Bind
       -> Engine.Actor::Bind
            -> registered AActor ClassConstructor
  <- copy Actor constructor to ConPlayBase
<- copy ConPlayBase constructor to DataLinkPlay
```

This is an inherited native constructor selection, established by Core's
body, rather than a guessed generic fallback.

## Engine Actor constructor

Engine's AActor registration routine is `0x1035ed30` (file offset
`0x5ed30`). It passes the following values to Core's UClass constructor:

```text
InternalConstructor = 0x10302dab
raw registration flags = 0x04084004
instance size = 0x318
static class = 0x1057cdf0
```

The null-guarded thunk at `0x10323530` jumps to the constructor body at
`0x10323550`. The body calls the UObject default constructor through Engine
IAT `0x10599b58`, calls the Core FName default constructor four times from
`Actor+0x68` in four-byte steps, calls the Core FPlane default constructor
four times from `Actor+0x26c` in `0x10` steps, then stores AActor's vtable
`0x104268dc` at object offset `+0`. It has no DataLinkPlay-specific writes.

`StaticConstructObject` performs the class-default property initialization
and object registration before dispatching `[Class+0x4e0](object)`. Thus the
script fields/defaults are supplied by the class link/default-object path;
the inherited AActor body only installs the native Actor object behavior.

## PropertiesSize and linked fields

`UStruct::Link` is Core thunk `0x10101933`, body `0x10126060`. With a nonzero
layout argument it:

1. zeros `UStruct+0x3c` (`PropertiesSize`);
2. calls `GetInheritanceSuper` at virtual slot `+0x68` and preloads the
   superclass;
3. reads the superclass `GetPropertiesSize` at virtual slot `+0x64`, rounds
   it to four bytes, and uses it as the running size;
4. walks direct `Children`, calls each property `Link`, and updates the size
   to `Offset + ElementSize * ArrayDim`;
5. rounds the final size to four bytes.

The `GetPropertiesSize` body is `0x1010f7c0` and reads `+0x3c`. The separate
`UClass::Register` body at `0x10127800` later calls the class virtual `+0x6c`
(`UClass::Link`, body `0x10127e30`) with layout argument zero; that mode
preserves serialized property offsets. The bounded trace does not claim a
specific package-loader caller for the nonzero mode; the arithmetic and the
class/property metadata are directly recovered.

The exact linked own-field order and derived offsets are:

### `ConPlayBase` (starts at `Actor+0x318`)

| field | type/array | offset | size or mask |
| --- | --- | ---: | ---: |
| `playMode` | byte | `0x318` | 1 |
| `displayMode` | byte | `0x319` | 1 |
| `RootWindow` | object | `0x31c` | 4 |
| `con`, `startCon`, `Player`, `invokeActor`, `currentEvent`, `lastEvent`, `lastActor` | 7 objects | `0x320`–`0x338` | 28 |
| `playingSoundId`, `lastSpeechTextLength`, `missionNumber` | 3 ints | `0x33c`–`0x344` | 12 |
| `MissionLocation` | `FString` | `0x348` | `0xc` |
| `History`, `startActor` | 2 objects | `0x354`–`0x358` | 8 |
| `saveRadiusDistance`, `initialRadius` | 2 ints | `0x35c`–`0x360` | 8 |
| `bConversationStarted` | bool | `0x364` | mask 1 |
| `bForcePlay` | bool | `0x364` | mask 2 |
| `conWinThird` | object | `0x368` | 4 |
| `ConActors[10]` | objects | `0x36c` | `0x28` |
| `ConActorsBound[10]` | objects | `0x394` | `0x28` |
| `conActorCount` | int | `0x3bc` | 4 |

The resulting `ConPlayBase.PropertiesSize` is `0x3c0`. The two adjacent
bools share a DWORD because `UField::MergeBools` returns true for class
properties; their masks are the recovered `UBoolProperty::Link` masks.

### `DataLinkPlay` (starts at `ConPlayBase+0x3c0`)

| field | type/array | offset | size or mask |
| --- | --- | ---: | ---: |
| `datalink` | object | `0x3c0` | 4 |
| `startSound` | object | `0x3c4` | 4 |
| `eventTimer` | float | `0x3c8` | 4 |
| `bStartTransmission` | bool | `0x3cc` | mask 1 |
| `bEndTransmission` | bool | `0x3cc` | mask 2 |
| `blinkRate`, `startDelay`, `endDelay`, `perCharDelay` | 4 floats | `0x3d0`–`0x3dc` | 16 |
| `bSilent` | bool | `0x3e0` | mask 1 |
| `infoLinkNames[17]` | `S_InfoLinkNames` | `0x3e4` | `17 * 0x18 = 0x198` |
| `dataLinkQueue[8]` | objects | `0x57c` | `0x20` |
| `DataLinkTrigger` | object | `0x59c` | 4 |
| `EndTransmission` | `FString` | `0x5a0` | `0xc` |

The source struct `S_InfoLinkNames` contains two strings. Its linked struct
size is `0x18`. The resulting `DataLinkPlay.PropertiesSize` is `0x5ac`.
These offsets and sizes are retained as recovered evidence; runtime instances
use the existing linked property/struct machinery rather than a duplicate
JavaScript layout calculator.

## Defaults and inherited startup

The package `ClassDefaults` merge provides these authored scalar values:

```text
blinkRate=0.5             startDelay=1.5          endDelay=1
perCharDelay=0.0299999993 bHidden=True            bMovable=True
bDetectable=True          Role=4                  RemoteRole=1
LastRenderTime=-10        LODBias=1               bDifficulty0..3=True
bSinglePlayer=True        bNet=True               bNetSpecial=True
OddsOfAppearing=1         DrawType=1              Style=1
DrawScale=1               ScaleGlow=1              Fatness=128
SoundRadius=32            SoundVolume=128         SoundPitch=64
TransientSoundVolume=1    CollisionRadius=22      CollisionHeight=22
bJustTeleported=True      Mass=100                ConStartInterval=5
NetPriority=1             NetUpdateFrequency=100  EndTransmission="END TRANSMISSION..."
```

The scalar map has no authored entries for `bStatic`, `bNoDelete`,
`bCollideWhenPlacing`, `bCollideActors`, `bCollideWorld`, `bBlockActors`,
`bBlockPlayers`, or `bGameRelevant`. `InitProperties` starts from the class
default buffer and native zero initialization, so those absent values are
false/zero. No DataLinkPlay native constructor changes them.

`Actor.PreBeginPlay` is inherited. DataLinkPlay is not a `Decoration`,
`Inventory`, or `Pawn`, so the collision-height shrink branch is skipped. The
remaining original branch is:

```unrealscript
if (!bGameRelevant && (Level.NetMode != NM_Client) &&
    !Level.Game.IsRelevant(Self))
    Destroy();
```

Consequently a live non-client spawn requires a real `Level.NetMode` and
`Level.Game.IsRelevant(Self)` binding. The spawn adapter does not reimplement
this decision in JavaScript: it dispatches `PreBeginPlay` through the runtime's
original bytecode/event path. On `NM_Client` (`3`) the relevance call is
skipped by that original branch.

## Relationship to the CameraPoint spawn path

The generic level sequence can be shared conditionally: class/default gates,
level actor-array insertion and Outer, native construction, `Tag`/transform,
owner/instigator, `InitExecution`, native `Spawned`, script
`Spawned`/`PreBeginPlay`/`BeginPlay`, initial-state handling, and the remaining
level callbacks. The class-specific constructor cannot be copied:

* CameraPoint selects its own Engine constructor thunk and vtable
  (`0x103033af` and `0x10427178`); DataLinkPlay selects inherited AActor
  `0x10302dab` and `0x104268dc`.
* DataLinkPlay has no CameraPoint native class registration and must use its
  linked `0x5ac` property size.
* DataLinkPlay's collision/block defaults are clear, so the placement/hash
  branches can only be skipped after those defaults are checked. A later
  script write that enables collision leaves this bounded construction record.
* `PreBeginPlay` introduces the required game-relevance service described
  above. A constructor result alone does not establish that the actor remains
  in the level.

## Implemented DataLinkPlay spawn boundary

> **2026-09-25:** the per-class spawn entry points named below
> (`spawnScriptDataLinkPlay`, `spawnScriptInventoryActor` and the host
> `resolveConstructor` service) were replaced by the one general
> `ULevel::SpawnActor` body, which reads each class's bound ClassConstructor;
> see [spawn](script-spawn.md) "Native constructor family". The recovered
> sequence recorded here is unchanged.

`spawnScriptDataLinkPlay` in [`src/runtime/script-spawn.mjs`](../src/runtime/script-spawn.mjs)
accepts exactly `deusex.datalinkplay`. It checks the linked
`DataLinkPlay -> ConPlayBase -> Engine.Actor -> Core.Object` identity chain,
the recovered class defaults, and the explicit level/transaction/collision
preconditions before appending an actor slot. It then reuses the established
CameraPoint level ordering for the verified common path: fresh property
initialization, inherited AActor construction, object/level/transform fields,
owner and instigator, `InitExecution`, `Spawned`, `PreBeginPlay`, `BeginPlay`,
zone assignment, `PostBeginPlay`, encroachment guard, `SetInitialState`, and
`PostPostBeginPlay`.

The DataLink branch has no generic Actor fallback. Before the level array is
mutated it calls the host's `resolveConstructor(cls)` service. That service
must return the result of the live class registry's Core `UClass::Bind` chain,
with `classKey=deusex.datalinkplay`, `inherited=true`, constructor
`0x10302dab`, AActor vtable `0x104268dc`, and linked `PropertiesSize=0x5ac`.
The result is passed to `construct(cls, options, {constructorSelection})`,
where the host dispatches its existing fresh-object path. The adapter never
evaluates a JavaScript substitute for `Actor.PreBeginPlay`.

The corresponding `ScriptRuntime` wiring is intentionally small: import
`spawnScriptDataLinkPlay`, choose it when `cls.record.key` is
`deusex.datalinkplay`, and pass a `resolveConstructor` service that reads the
bound `ClassConstructor` slots for the exact three-class chain. The construction
callback must accept the adapter's third argument and dispatch the selected
`0x10302dab` pointer through the existing `constructObject`/native-constructor
service. The CameraPoint branch continues to use its existing constructor
service and two-argument construction call.

`scripts/validate-script-scripted-actor-spawn.mjs` exercises one actual
DataLinkPlay fixture with the installed package class, recovered AActor
constructor body, and original inherited startup events. The focused test
`test/script-scripted-actor-spawn.test.mjs` checks the exact class gate,
constructor report, mutation order, and rejection of an unrelated constructor
selection. These checks cover the bounded startup path; DataLink display,
audio, ConSys binding, and later transmission behavior remain separate.

## Root integration boundary

The host integration should:

1. populate the class registry's `ClassConstructor` for `Engine.Actor` from
   the verified registration and recursively bind `ConPlayBase` and
   `DataLinkPlay` through `UClass::Bind`; expose the resulting report through
   `resolveConstructor(cls)` as described above;
2. run the existing fresh-object property/default path with the selected
   class constructor after `InitProperties`, retaining the `0x318`, `0x3c0`,
   and `0x5ac` sizes and bool masks above. The spawn adapter passes the
   DataLink selection as its third construction argument;
3. use the ordinary actor level sequence only after binding the level Outer,
   actor array/region, and `Level.Game.IsRelevant`; and
4. prepare the DataLinkPlay script functions and separately bind RootWindow,
   HUD/info-link, player sound, ConSys conversation, and trigger services
   before `StartConversation` is attempted.

The last group belongs to the conversation/event work. UI rendering, audio
playback, and ConSys event binding are outside this construction task.

Shared ScriptRuntime now selects this exact DataLinkPlay spawn path, obtains
the constructor through the lifecycle's resolveConstructor service, and
dispatches the accepted pointer to the recovered Actor constructor. The spawn
validator uses that shared entry point. Its explicit class records now run
the mutable [UClass.Bind translation](script-class-bind.md) before providing
the constructor, so both inherited slots are written by the recovered
recursive binding path. Original native execution verifies the corresponding
write and call order. The fixture still supplies initial registration records
and world services; complete package-loader startup remains unestablished.

## Remaining evidence boundary

The AActor constructor and Core inheritance path are byte-level recovered.
The exact dynamic package-loader call site that invokes nonzero
`UStruct::Link` was not identified in this bounded pass; the layout report is
derived from that recovered body, the linked package field order, and the
measured `S_InfoLinkNames` struct size. A live map measurement of
`Level.Game.IsRelevant(DataLinkPlay)` is also not available here. Those are
explicit host services/validation requirements rather than silently accepted
defaults.
