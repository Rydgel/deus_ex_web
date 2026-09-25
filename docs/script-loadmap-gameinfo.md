# LoadMap GameInfo selection and InitGame

Evidence recovered on 2026-09-25 from retail Engine.dll SHA-256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`,
`UGameEngine::LoadMap` body `0x1038c1f0`. Original disassembly is cached
locally at `.cache/loadmap-gameinfo.asm`; original extracted scripts remain
in `.cache/reference`. SDK layouts supply member and virtual-slot names;
the accesses and control flow below come from retail instructions.

## Input and class selection

The first LoadMap argument is a `const FURL&`; its address is `[ebp+8]`.
At `0x1038d3a6..0x1038d42c`, LoadMap initializes a 1024-WCHAR Options
buffer, a 256-WCHAR Game buffer and an FString Error to empty. The loop
`0x1038d438..0x1038d4b3` reads URL.Op data at `+0x28` and count at `+0x2c`,
with 12-byte FString entries. For each entry, in array order, it appends
`?` then that entry to Options (`appStrcat` import `0x10599f44`, calls
`0x1038d44c` and `0x1038d479`). It also calls original `Parse(entry,
"GAME=", Game, 256)` at `0x1038d4a9`. These literal strings are stored at
`0x1047ee6c` and `0x1047ee5c`. Options contains neither map nor portal.
Parsing duplicates, escaping and oversized buffers must retain the original
helper's semantics; they are not established merely by this call site.

At `0x1038d4bd`, ULevel::IsServer (virtual `+0x84`) gates GameInfo creation.
A non-null LevelInfo.Game (`+0x544`, tested `0x1038d4d4`) also skips creation.
For a server with no existing Game, precedence is:

1. Nonempty parsed GAME buffer: load that class (`0x1038d50b`).
2. Otherwise, non-null LevelInfo.DefaultGameType (`+0x540`, `0x1038d4e6`).
3. Otherwise load `ini:Engine.Engine.DefaultGame` when engine.Client
   (`+0x44`) exists; load `ini:Engine.Engine.DefaultServerGame` otherwise
   (`0x1038d4f0..0x1038d501`).

The class-loading call at `0x1038d521` is the imported StaticLoadClass,
with GameInfo as required base (`0x1057ba08`, retail export
`AGameInfo::PrivateStaticClass`), null outer and filename, load flags 1,
and the previously prepared PackageMap pointer `[ebp-0x50]`.

The selected class is passed to ULevel::SpawnActor virtual `+0x9c` at
`0x1038d59d`. The argument construction `0x1038d55a..0x1038d59a` supplies
NAME_None, null Owner and Instigator, zero Location and Rotation, null
Template, bNoCollisionFail=0 and bRemoteOwned=0. The return value is written
to LevelInfo.Game at `0x1038d5a8`, followed by the original non-null assertion.
**That assignment happens after SpawnActor returns:** during GameInfo's own
SpawnActor native startup chain LevelInfo.Game is still null. Do not preassign
it. Its script event calls are suppressed by the Actor.ProcessEvent gate
below while bBegunPlay is false; calling the native chain does not mean that
the cold script callbacks execute.

## Cold startup and InitGame

Game creation is before the bBegunPlay check (`0x1038d6f6`), before the shared
Touching clear, and before the shared InitExecution pass. Retain normal
SpawnActor's native chain and its ProcessEvent calls, with the recovered
Actor.ProcessEvent gate. LoadMap subsequently visits the same actor as a live
member of the array after setting bBegunPlay; those shared script callbacks
then execute. The earlier version of this page incorrectly equated the cold
native calls with actual script callback execution.

The cold path orders operations as follows:

| Native range | Operation |
| --- | --- |
| `0x1038d7f7..0x1038d824` | Clear all actors' Touching slots |
| `0x1038d824..0x1038d869` | IsServer test and client-only actor pass |
| `0x1038d869..0x1038d885` | Shared InitExecution pass |
| `0x1038d885..0x1038d899` | LevelInfo flags OR `0x42` (bBegunPlay and bStartup) |
| `0x1038d897..0x1038d997` | If Game non-null, call its InitGame |
| `0x1038d99a` onward | Shared PreBeginPlay pass |

This corrects the previous documentation's ordering of the IsServer/client
pass relative to InitExecution; the client pass precedes InitExecution.

InitGame builds a two-FString parameter record at `[ebp-0x2c]`: Options at
0, Error at 12. It copies the Options buffer through an FString temporary,
looks up function name global `0x1058362c` using FindFunctionChecked at
`0x1038d94f`, then calls Game's ProcessEvent virtual `+0x10` at
`0x1038d95f`. Error is copied back to the local FString at `0x1038d969`.
There is no Error-dependent branch before the following PreBeginPlay pass.
A browser implementation must preserve the out argument and must not
substitute a host relevance object for the receiver.

## Training reference cases and script effects

Original `00_Training.dx` LevelInfo0 export 1 has no serialized Game or
DefaultGameType overrides. Engine.LevelInfo's original class default
DefaultGameType is null (checked by loading the class through ScriptRuntime).
The installed original `System/DeusEx.ini` Engine.Engine section specifies
`DefaultGame=DeusEx.DeusExGameInfo`. Therefore the standalone client path
with no GAME override selects DeusEx.DeusExGameInfo. This conclusion depends
on these input conditions, not on the map's name.

For an explicitly supplied empty URL.Op array, the native concatenation
loop executes zero iterations and InitGame receives exactly `""`. For
`["Difficulty=2", "Name=JC"]` the instruction contract gives exactly
`"?Difficulty=2?Name=JC"`. These are recovered native reference cases, not
claims of an original executable capture of a menu session. Training's
serialized ULevel URL has map `Index.dx` and an empty options array; that is
**not** proof of the incoming runtime FURL passed to LoadMap. A direct browser
Training entry can explicitly model `00_Training` with an empty options
array, but must expose that input assumption rather than claim menu-travel
option inheritance has been verified. `DeusExPlayer.StartTrainingMission` contains
`Level.Game.SendPlayer(Self, "00_Training")`; tracing SendPlayer/travel and
FURL option inheritance is a separate boundary.

DeusExGameInfo declares no InitGame override. The original Engine.GameInfo
InitGame source (embedded in Engine.u, extracted to `.cache/reference/GameInfo.uc`)
performs these effects in order: logs Options; clamps MaxPlayers to at most
32 using GetIntOption; optionally updates Difficulty, AdminPassword and
GameSpeed; **spawns MutatorClass and assigns BaseMutator**; adds comma-separated
Mutator option classes through DynamicLoadObject and AddMutator; optionally
updates GamePassword; enables bLocalLog/bWorldLog when the corresponding
options case-insensitively equal `true`. Empty options still spawn the base
mutator. Runtime must execute that original body and resolve inherited
functions; no host-created replacement mutator is warranted.

## Boundaries

This research establishes the original instruction contract and original
script source; it does not itself validate a new runtime implementation.
Focused integration should check class choice, exact Options, out Error,
Game assignment timing, GameInfo's cold SpawnActor event suppression plus shared
passes, and BaseMutator creation by the script. Loaded-game/preexisting Game,
network/client-only behavior, invalid class options, option overflow and
travel option inheritance remain outside the direct cold standalone case.


## Actor.ProcessEvent cold-level gate — measured correction

Retail AActor::ProcessEvent (`0x10369100..0x10369126`) reads actor.Level at
`+0xa8`, tests bit 2 at LevelInfo `+0x4f0` (`0x10369106`) and returns with
12-byte argument cleanup when it is clear. It forwards the same receiver,
Function, Parms and Result to Core.UObject::ProcessEvent only when bBegunPlay
is set (`0x1036911e`). bStartup alone does not permit events. This applies to
Actor ProcessEvent dispatch, not ordinary script-to-script CallFunction.

The existing `native-loadmap-state-oracle.py` family harness now executes
this unchanged retail wrapper with flags 0, 0x40, 2 and 0x42. The cold cases
use a null Function pointer: neither reaches Core or dereferences Function.
The begun cases reach Core exactly once and preserve the receiver and all
three argument pointers. Every case returns with the original stack cleanup.
Only the downstream Core entry is observed as a service boundary; its event
execution remains covered by the separate event/frame family harnesses.
`validate-loadmap-startup.mjs` asserts these four original outputs along with
its existing LoadMap/timestamp measurements.

This is not a null-pointer tolerance rule. The Actor wrapper unconditionally
dereferences Level; it has no null-Level check. Likewise, it does not test the
Function or its code pointer on the begun path before forwarding to Core.
A missing level or invalid hot function must not be excused by an invented
guard. The early bBegunPlay gate must run before resolving/preparing or
executing an event in the browser, which is particularly important for cold
GameInfo construction.
