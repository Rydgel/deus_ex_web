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

## Play integration (2026-09-10)

`ScriptRuntime.invokeNative` now routes native `264` to `execActorPlaySound`
with `soundServices`: reflected fields through the typed storage, the level
native graph (`Model`, null `DemoRecDriver` on the Play level object), class
ancestry for `isA`, the enclosing script function's flags for the
`Frame.Node` gate, the recovered `FastLineCheck`, and native event dispatch
through `processNativeEvent` (script events via `ProcessEvent`; native events
fail at the existing hook boundary, e.g. `Pawn.ClientHearSound`).

### Global UObject index resolved by live capture (2026-09-11)

The channel-id input the Play host was missing — the emitter's **global UObject
index** — is now supplied from measured original evidence. The retail game's
`GObjObjects` registry was read out of the running process (see
[boot-replay.md](boot-replay.md); `tools/dump-gobjects-win.c`), giving the
training `LightSwitch0` actor its true global index **34242** — not a fabricated
or map-export index. `soundField('ObjectIndex')` returns it, so the
`(Index << 4) + (Slot << 1) + bNoOverride` formula (validated in
`test/script-sound.test.mjs`) now has its real input in Play.

This resolution is **general**, not per-actor. `ScriptRuntime.setOriginalObjectIndex`
installs a capture-backed provider, and `soundField('ObjectIndex')` resolves any
pre-placed object by `(class, name)` (caching the slot on first read), so every
placed emitter — not just the switch — gets its measured index with no
`registerGlobalObjectIndex` call. Runtime-spawned emitters are absent from the
load-time capture and instead take the slot the recovered `AddObject` rule assigns
from the measured registry state (the runtime-spawn index model in
[boot-replay.md](boot-replay.md); `test/script-object-index.test.mjs`,
`scripts/validate-object-index-model.mjs`). `registerGlobalObjectIndex` remains as
an explicit override.

### Live game keeps PlaySound a recorded boundary; the full native runs where a measured index exists

`execActorPlaySound` requires the emitter's global index, so it can only run
faithfully where that index is available. The **live game** does not have a
measured index for arbitrary emitters (there is no shippable index table yet, and
audible playback — `ClientHearSound` — is Stage 4), so it keeps PlaySound a
recorded boundary: `createScriptDoors` declares native `264` a host boundary
(`ScriptRuntime` `boundaryNatives`), and `invokeNative` delegates it to
`soundBoundary`, which records the mover sound through `callbacks.playSound`
without producing audio. This is the original Stage-3 behavior — a deferred effect,
not silence-by-omission — and it is what the browser gameplay and
`scripts/validate-gameplay.mjs` exercise.

The **full native** runs only where the measured index is present:
`scripts/validate-script-lights.mjs` installs the capture provider and opts `264`
back out of the boundary (`runtime.boundaryNatives.delete(264)`), so
`LightSwitch.Frob` drives the real `execActorPlaySound` (channel id **547874** and
the live `PawnList` traversal). Focused script harnesses that only assert a
native's call/argument order (`scripts/validate-script-decoration.mjs`,
`scripts/validate-script-runtime.mjs`) likewise declare `264` a boundary and record
it, rather than running the full listener graph. So `boundaryNatives` is the single
seam that decides, per host, whether PlaySound is recorded or executed.

### Live listener graph wired (2026-09-11)

`soundField` now maps the host's single `level` container onto the original's
split identities: `XLevel` is the ULevel (`Actors`, `Model`, `DemoRecDriver`),
and `Level` is the `LevelInfo` actor (`level.actors[0]`) carrying `PawnList`
(`level.pawnList`) and `NetMode` (`level.netMode`). The Play host keeps this
graph in the container rather than in the actors' native pointer fields, so the
sound path reads it from there instead of the (unpopulated) reflected pointers.

With this, `scripts/validate-script-lights.mjs` runs the actual `LightSwitch.Frob`
wrapper **end-to-end**: `Super.Frob` + `StartConversation`, native 264
`PlaySound('Switch4ClickOn', slot 1)` producing channel id **547874**
(`(34242 << 4) + (1 << 1) + 0`), a full traversal of the live `PawnList`
(JCDentonMale plus the intro cameras), and then the wrapper's own
`PlayAnim('On')`. At the switch's position the player is far away, so the original
distance gate leaves every listener unheard.

The remaining boundary is **`ClientHearSound`** — the native per-listener audio
event that actually queues playback on a channel — which is Stage 4 (audible
output). It is only reached when a listener is in range and unoccluded; the
listener traversal, distance and occlusion gates and channel id are all faithful
up to that point.

Float32 stores and native branch order are retained. JS number arithmetic is
used for retained x87 intermediates, following the existing bounded scene math
translation; this does not claim arbitrary extended-precision bit identity.

### Play runs the native for measured emitters — 2026-10-02

Play now runs `execActorPlaySound` for every emitter whose global index is
measured (`ScriptRuntime.measuredObjectIndex`: the map, pawn and player
tables) or modeled (`ScriptRuntime.soundObjectIndex`, 2026-10-14: the slot
`AddObject` gives a runtime spawn, [object-index-captures](object-index-captures.md)
"Runtime spawns"; the host registry's own slot is neither), and its listeners' `ClientHearSound` reaches Galaxy through the
recovered `APawn::execClientHearSound` and ProcessEvent's
`ProcessRemoteFunction` gate ([galaxy audio](galaxy-audio.md#play)). Native
265 runs `execStopSound`. The recorded seam below remains only for an emitter with neither index. The runtime's own
264 body now returns the channel id (or leaves the result untouched for a null
Sound) instead of its descriptor.

### Discarded-result family admission — 2026-09-25

Contract recorded before implementation: retail Core `ProcessInternal`
`0x1013f763–0x1013f78e` dispatches each non-Return statement into its local
scratch block (`ebp-0x408`). Only the Return operand uses the caller's result
pointer (`0x1013f790–0x1013f7a6`). `execContext` forwards the outer result
pointer to its value child (see [execution](script-execution.md)). Thus a
standalone native-264 statement, including a chain of Context value children,
discards the channel ID. A call in an argument, assignment, condition, Return,
or the receiver child of a Context does not establish that property.

An inspection of installed Engine.u and DeusEx.u decoded Function/State bodies
found 37/37 and 224/232 native-264 sites respectively in that standalone form.
The eight consumed-result sites are DeusExDecoration.Bump, DataLinkPlay.PlaySpeech,
BarkManager.StartBark, four ConPlay.PlaySpeech calls and DeusExWeapon.PlaySimSound.
Lamp.Frob offsets 43/89, HUDMedBotHealthScreen.DestroyWindow offset 48,
HUDMedBotAddAugsScreen.DestroyWindow offset 48 and HUDRechargeWindow.DestroyWindow
offset 37 are standalone discarded-result calls (expanded bytecode offsets).

The VM can mark these exact decoded native nodes once at compilation. Play's
existing deferred-audio seam may then admit every marked native-264 call,
evaluate its original argument expressions in order, record the effect, and
continue. Existing named effect labels and separately scoped channel-lifetime
routes remain intact. Unmarked calls gain no new admission; host calls without
bytecode metadata do not qualify. The returned zero is an unobserved boundary
placeholder, **not** an original channel ID. This does not implement listener
callbacks, demo recording, or audible playback; the full recovered native route
and its checks remain separate. Stage 4 audio remains explicitly deferred.

State bodies have the same scratch-result contract: retail Engine
`AActor::ProcessState` dispatch at `0x103e5c39–0x103e5c50` passes `ebp-0x40`
to each statement. The classification therefore covers Function and State
bodies without substituting their execution paths.

Verification: `npm test` passes 534 tests, including consumed argument/Return/
assignment/Context-receiver exclusions. `validate-script-sound-admission`
checks the installed bytecode census and exact consumed-result sites.
`validate-window-baseline-play` preserves both bot activation routes and named
raise-arm effects. `validate-trigger-actions` and `validate-triggers` now assert
that Radiation10 returns after recording Human.PlayTakeHitSound; the existing
health=98 and HitLegLeft animation assertions still hold. These establish the
new translation/admission boundary, not audible output or full Stage-3 coverage.
