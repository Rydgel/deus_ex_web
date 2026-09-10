# Original actor sound dispatch

Authority: installed GOTY Engine.dll, SHA-256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`,
`.cache/reference/Engine.asm`, its PE imports/exports and original Actor/Pawn UC.
This covers native PlaySound264 and CheckHearSound; actual audio playback and
native ClientHearSound/DemoPlaySound event implementations are separate boundaries.

## PlaySound wrapper

Export `10302612` enters `103e1f60–103e261b`. It evaluates Sound, Slot,
Volume, bNoOverride, Radius, Pitch in order. Before evaluating each argument,
its local is initialized: null, byte1, current TransientSoundVolume `+1cc`,
integer0, current TransientSoundRadius `+1d0`, float1. In particular, earlier
argument evaluation can change the actor before either default is read, and
both defaults are read even when explicit arguments replace them.

After EndFunctionParms, null Sound returns without writing the native result
(`103e2117–211d`). Otherwise Radius<=0 or unordered becomes float800
(`103e2122–2139`). The wrapper then checks Actor.XLevel `+ac`, its demo driver
`+88`, and that driver's ServerConnection `+38`. If the driver exists without
a server connection and Actors(0).NetMode `+518` is not3, it looks up
**DemoPlaySound** and calls receiver ProcessEvent with a six-parameter block.
The identifying exports are `ENGINE_DemoPlaySound=105835e4`; import10599a88
is UObject.FindFunctionChecked. This branch is demo recording, not the audio
device entry point. These temporary event parameters do not alias the original
native locals used below.

At `103e22d9–2302`, the live UObject index `+4` produces the signed32 channel
ID `(Index << 4) + (Slot << 1) + bNoOverride`. A package export index is not a
valid replacement for this global UObject index.

The routine stores RadiusSquared as float32, then constructs a float32 vector
`[100*Volume, Radius, 100*Pitch]` (`103e2305–2378`; constant104299a8=100).
The radius-zero alternative is1000, although the earlier normalization removes
zero on the ordinary path. It inspects the enclosing Frame.Node `+4`: only
UFunction ancestry (IAT1059a0c8) yields FunctionFlags `+6c` for this gate.

If NetMode is3, or the enclosing UFunction has flag100 (Simulated), the native
walks `Level.Engine(+40).Client(+44).Viewports` (`+2c/+30`). It reloads the
live array count/data, obtains each viewport's Actor `+30`, and calls
CheckHearSound only for a nonnull pawn whose XLevel matches the emitter's live
XLevel. A null Client skips the loop. Otherwise it follows the emitter's
LevelInfo `+a8`, PawnList `+54c`, and each Pawn.NextPawn `+498`; only bIsPlayer
(`Pawn+318 &2`) receives CheckHearSound. NextPawn is read after the callback.
The channel ID is written to Result only after listener processing (`103e2610`).

Both uses of Actors(0) assert a nonnull ALevelInfo. A missing required level,
class, index, frame or array binding is an explicit host error.

## CheckHearSound

Export `10302856` enters `103e1b00–103e1c8d`. Arguments are listener pawn,
channel ID, sound, parameter vector and RadiusSquared. It uses PlayerPawn
ancestry (`1058c160`) to select ViewTarget `+60c` when nonnull, otherwise the
pawn. It copies that actor's Location `+114` for the listener position.

Threshold is float32(RadiusSquared * float32(0.7692307829856873)), the exact
constant at10432b64. Distance is the squared difference from emitter.Location;
the native sums Z²+Y², then X², retains the expression for the first comparison,
and stores a float32 distance for the later blocked-line comparison. The first
gate accepts strictly less or unordered (x87 C0); equality is rejected.

It calls UModel.FastLineCheck through `10301a37` with listener position then
the emitter position. If blocked, it scales the retained threshold by exact
float32(0.6000000238418579), at10431bdc, unless emitter.Owner `+bc` is the
listener pawn. It always scales parameter X (volume) by exact
float32(0.3499999940395355), at1042ac04, on this blocked path. A stored
float32 distance greater than the adjusted threshold returns; equality or
unordered passes (C0|C3).

The accepted path calls listener ProcessEvent with **ClientHearSound**
(`ENGINE_ClientHearSound=1058366c`): emitter, ID, Sound, freshly read emitter
Location, and the possibly attenuated parameters. Resource decoding, the
native event hook, viewport/audio lifetime and network replication are still
required to produce sound. The helper now uses the separately recovered
[original FastLineCheck](fast-line-check.md), whose flag and plane-boundary
rules differ from the general movement ray.

## Host boundary

`execActorPlaySound(call, services)` returns a descriptor with `resultWritten`,
the optional result and ordered listener outcomes. The caller owns native
result storage; null Sound must preserve it. Services supply live typed actor
fields, XLevel, the native global object index, enclosing function flags,
demo driver, viewport array, class ancestry, FastLineCheck and native events.
`checkActorHearSound` translates the recovered spatial/listener path separately.
Reached missing services fail; there are no fabricated audio IDs or listeners.

The implementation is `src/runtime/script-sound.mjs`. Its `read(object,name)`
service covers reflected fields and native graph slots: ObjectIndex (+4),
XLevel, DemoRecDriver, ServerConnection, Actors, Engine, Client, Viewports,
viewport Actor, and Model. Null native pointers are represented as null;
missing bindings are errors. `isA(object,classPath)` supplies actual ancestry.
`frameFunctionFlags(call)` returns the enclosing UFunction flags, or null for
a nonfunction node. An optional `fastLineCheck(model,start,end)` service
supplies the original trace for another native model representation; the
default uses the recovered compiled-BSP implementation.
`processNativeEvent(receiver,name,args)` owns the native event dispatch.
None of these services is inferred from a map export index or a fake listener.

`node --test test/script-sound.test.mjs` checks translation boundaries in one
focused fixture: default-read timing, demo event argument isolation and live
index changes, null-sound result preservation, PawnList mutation, simulated
viewport traversal, ViewTarget distance and owner-dependent occlusion. This
does not establish full Play integration or actual audio playback.

Float32 stores and native branch order are retained. JS number arithmetic is
used for retained x87 intermediates, following the existing bounded scene math
translation; this does not claim arbitrary extended-precision bit identity.
