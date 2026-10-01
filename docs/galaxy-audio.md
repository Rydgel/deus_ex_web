# Galaxy audio subsystem (research, in progress)

Play plays only speech today (DataLink and conversations through Web Audio).
Sound effects, ambient sounds and music reach the engine's `PlaySound`
bookkeeping (channel ids, [script-sound](script-sound.md)) and the instant
volumes ([galaxy-volumes](galaxy-volumes.md)) but no browser voice. This note
records the original subsystem, then its translation
(`src/runtime/galaxy-audio.mjs`) and how Play uses it.

The audio device is `UGalaxyAudioSubsystem` (`DeusEx.ini`
`AudioDevice=Galaxy.GalaxyAudioSubsystem`), Galaxy.dll SHA256
`606e71d13bbd3c4db2460aabcf60d87b1c79bb49d77725cf9e087513c7d06353`, preferred
base `0x10600000`, vtable `0x1063d0e4`. The SDK's `UAudioSubsystem`
(`Engine/Inc/UnAudio.h`) names the slots:

| Slot | Method | Thunk | Body |
| --- | --- | --- | --- |
| `+0x58` | `Init` | `0x1060104b` | |
| `+0x5c` | `SetViewport` | `0x106010dc` | |
| `+0x60` | `Update(FPointRegion, FCoords&)` | `0x10601136` | `0x10609510` |
| `+0x68` | `RegisterSound` | `0x1060100f` | |
| `+0x74` | `PlaySound(Actor, Id, Sound, Location, Volume, Radius, Pitch)` | `0x10601221` | `0x10608100` |
| `+0x78` | `StopSoundId(Id)` (DEUS_EX) | `0x10601186` | |
| `+0x7c` | `NoteDestroy(Actor)` | `0x10601203` | |
| `+0x90..+0x98` | instant volumes | | see galaxy-volumes.md |

## Subsystem fields

`+0x58` float: the ambient volume factor (multiplies every ambient
SoundVolume). `+0x64`: the channel count. `+0x7c`: the viewport (`UViewport`;
`+0x30` its Actor, whose `+0x60c` ViewTarget, when set, is the listener
actor). `+0x80 + 0x40*i`: channel `i`. `+0x880` double: the last Update time.
`+0x8fc`: the counter for ids of slot 0 (decremented, shifted left 4).

## Channel record (0x40 bytes, filled by PlaySound)

| Offset | Field |
| --- | --- |
| `+0x00` | Galaxy voice handle (0 when idle) |
| `+0x04` | Actor |
| `+0x08` | Id (`Index<<4 | Slot<<1 | NoOverride` as built by execPlaySound) |
| `+0x0c` | 0 |
| `+0x10` | Sound |
| `+0x14` | Location (3 floats; Update copies the actor's every frame) |
| `+0x20` | Volume |
| `+0x24` | Radius |
| `+0x28` | Pitch |
| `+0x2c` | Priority |
| `+0x30` | play time (Update adds the frame's DeltaTime) |
| `+0x34` | 0 |
| `+0x38` | -1.0f |
| `+0x3c` | 0 |

## PlaySound (`0x10608100`)

1. Asserts `Radius != 0` (line `0x3e0`). Returns 0 without a viewport
   (`+0x7c`) or a Sound.
2. An Id whose slot bits (`Id & 0xe`) are 0 becomes `(--counter) << 4`.
3. The listener is the viewport Actor, or its ViewTarget (`+0x60c`).
   `Priority = float32((1.0 - sqrt(dx²+dy²+dz²) / Radius) * Volume)`: the
   squares sum in extended, Core `appSqrt` (IAT `0x10699730`) takes the
   double, the division and `fsubr` of double 1.0 stay extended, one FST.
4. Channel choice over the `+0x64` channels: a channel whose Id equals the
   new Id except for bit 0 is taken; but when the new Id has NoOverride (bit
   0) set, PlaySound returns 0 instead. Otherwise the channel with the lowest
   Priority below the new one (FCOM C0: strictly less) is taken, the running
   minimum updating as it goes. No candidate returns 0.
5. The chosen channel is stopped (`0x1060125d`), then the record above is
   written; returns 1.

## Update (`0x10609510`), the parts read so far

1. Returns without a viewport. Calls `0x1060e840` (Galaxy library tick).
2. DeltaTime: the RDTSC or `appSeconds` time minus `+0x880` (which is then
   advanced), clamped to `[0, 1]`.
3. **Ambient scan** when the viewport Actor exists, its ShowFlags
   (`APlayerPawn +0x5fc`) test `0x4800`, and `Level.Pauser` (`ALevelInfo
   +0x4e0`, an FString) is empty (`appStricmp` with `""`; IAT `0x106998bc`),
   i.e. the game is not paused: for every actor of
   XLevel with an AmbientSound (`+0x1c8`) and
   `|actor - listener|² < ((SoundRadius+1)·25)²` (SoundRadius `+0x1c4`,
   double `25` at `0x1063d788`), when no channel carries
   `Id = (actor.Index << 4) + 8` (slot 4), it calls its own PlaySound
   (vtable `+0x74`) with that Id, AmbientSound, the actor's Location,
   `Volume = SoundVolume (+0x1c5) · AmbientFactor (+0x58) · 1/255`,
   `Radius = (SoundRadius+1)·25` and `Pitch = SoundPitch (+0x1c6) · k`
   (double at `0x1063d778`).
4. **Ambient refresh:** each slot-4 channel whose actor left that range or
   changed AmbientSound is stopped. Otherwise its Volume becomes
   `2·SoundVolume·AmbientFactor/255`. An actor with a light (LightType
   `+0x1e0` nonzero) scales it by LightBrightness (`+0x1e2`)/255 and passes it
   to the renderer's GlobalLighting (`Viewport → Client +0x18 → Engine +0x28 →
   Render +0x48`, vtable `+0x88`, with ShowFlags bit `0x800`), so an ambient
   sound follows its actor's light effect (flicker, pulse). Radius and Pitch
   are refreshed as in step 3.
5. **Per channel** with an Id: a voice that Galaxy reports finished
   (`0x1060cf00(voice, 2, 0, 0)` returns 0) frees its channel. The play time
   advances by DeltaTime. A channel with an Actor takes its Location.
   Priority is refreshed with the PlaySound formula. The location is put in
   listener space (three float-stored dot products with the listener
   `FCoords` axes after subtracting its origin). Pan is
   `appAtan2(local.x, |local.z|)` (Core, doubles), multiplied by
   `dist/(0.1·Radius)` when the source is closer than `0.1·Radius`, then
   `ftol(angle · 28671.125f · (1/π) + 16383.0)` clamped to `0..0x7fff`
   (16383 is centre). The distance factor is `clamp(1 - dist/Radius, 0, 1)`.
   Slot 5 (`Id & 0xf` of `0xa`/`0xb`, interface sounds) skips the 3D path.
   Otherwise, for an actor source and a listener that IsA APawn,
   `UModel::FastLineCheck` (Engine import) on `XLevel+0x98` (the level's
   Model) runs from the source to the listener's eye (`Location + (0, 0,
   EyeHeight +0x3f8)`, EyeHeight a float add); a blocked line means occluded.
6. **Occlusion** (`+0x3c`): occluded, `min(occ + DeltaTime, 0.5)`; clear (or
   not tested), `max(occ - DeltaTime, 0)`; stored float. The factor is
   `max(1 - 2·occ, 0.33)`.
7. **Category ratio** (SoundVolume `+0x6a`, SpeechVolume `+0x6b`; the
   digital master is the louder, see galaxy-volumes.md): for speech (slot 5)
   `Speech/Sound` when Sound > Speech, `Sound·(1/255)` when equal, else 1;
   for every other sound `Sound/Speech` when Sound < Speech, `Sound/255` when
   equal, else 1 (FILD/FIDIV of the bytes; the equal case is the original's).
8. **Voice volume** `= ftol(ratio · factor · distanceFactor · Volume ·
   32767.0f)` clamped to `0..0x7fff`, then raised to at least `0x80`.
9. **Pan:** ReverseStereo (`+0x4c`) mirrors it (`0x7fff - pan`); a source
   behind the listener (`local.z < 0`) with UseSurround (`+0x34`) gets
   `0xc000`.
10. **Doppler** for an ambient channel (slot 4) with an actor:
    `1 - dot(SafeNormal(actor - listener), actor.Velocity) / DopplerSpeed`
    (`+0x5c`), clamped to `[0.5, 2.0]`; 1 otherwise.
11. A Sound without a Galaxy sample (`USound +0x50`) is registered
    (vtable `+0x68`).
12. A speaking pawn's channel (speech, time past `+0x34`) samples the voice
    for the lip-sync amplitude (the FFT over `0x10676890`, already translated
    for conversations) and advances `+0x34` by 0.1.
13. **Voice:** frequency `= ftol(SamplesPerSec (sample +0x3c) · Pitch ·
    Doppler)`. An existing voice is driven by `0x1060d280(voice, frequency,
    volume, pan)` (or `0x1060d420` with the position scaled by `0.0025` and
    the velocity when 3D), and its word `+0x16` takes the pan. Otherwise a
    3D voice is tried when `+0x74` is set (`0x10612800`), and failing that
    `0x10612310(channel + 1, sample, frequency, volume, pan, 0)` starts the 2D
    voice (asserted nonzero, line `0x754`). Reverb (`0x106011cc`) applies to
    3D voices only when `+0x78` is set.
14. The rest of Update is the music transition (PlayerPawn Song `+0x670`,
    SongSection `+0x675`, CdTrack `+0x674`, Transition `+0x676` with the fade
    times `-0.002/-0.0004/-0.006` per Latency and `0.2`/`3.0` rates).

**StopSound** (`0x10607e50`) stops a channel's voice (`0x10618590` for 3D,
`0x10618410` otherwise) and resets the record to zeros with `-1.0f` at
`+0x38`.

## Configuration (`DeusEx.ini [Galaxy.GalaxyAudioSubsystem]`)

The native StaticConstructor registers each config property with its offset
(`0x10604da0`-`0x10605320`): UseDirectSound `+0x2c`, UseFilter `+0x30`,
UseSurround `+0x34`, UseStereo `+0x38`, UseCDMusic `+0x3c`, UseDigitalMusic
`+0x40`, UseReverb `+0x44`, Use3dHardware `+0x48`, ReverseStereo `+0x4c`,
LowSoundQuality `+0x50`, AmbientFactor `+0x58`, DopplerSpeed `+0x5c`,
Latency `+0x60`, EffectsChannels `+0x64`, OutputRate `+0x68`, MusicVolume
`+0x69`, SoundVolume `+0x6a`, SpeechVolume `+0x6b`. The installed values:
UseSurround False, Use3dHardware False (so `+0x74` stays clear and every voice
is 2D), ReverseStereo False, EffectsChannels 16, DopplerSpeed 6500,
AmbientFactor 0.7, SoundVolume 204, SpeechVolume 255.

Constants: doubles `25.0` (`0x1063d788`), `1/64` (`0x1063d778`, SoundPitch
scale), `0.1` (`0x1063d768`), `1/π` (`0x1063d758`), `16383.0`
(`0x1063d748`), `1.0`, `0.0`, `1/255` (`0x1063d548`); floats `0.0`,
`28671.125` (`0x1063d764`), `127.0`. Imports: Core `appSqrt`, `appAtan2`,
`appSecondsSlow`, `appStricmp`, `UObject::IsValid`, `appFailAssert`; Engine
`APawn::PrivateStaticClass`.

Init (`0x10605580`) clamps Latency to 10..250, EffectsChannels to 0..32 and
DopplerSpeed to at least 1.0, and stops every channel, so an idle channel
holds zeros and `-1.0f` at `+0x38`. StopSound copies a 16-dword stack buffer
whose words 5-10 (Location, Volume, Radius, Pitch) it never writes; an idle
channel keeps stack garbage there, which nothing reads before PlaySound
overwrites it.

## Translation

`createGalaxyAudio(config, services)` holds the channel records and the slot-0
counter and translates PlaySound, StopSound and Update steps 2-11 and 13 on
the x87 model (extended sums, float stores, Core `appSqrt` as FSQRT of the
stored double, Galaxy's `_ftol`). The Galaxy library's voices are services:
`startVoice(index, sample, frequency, volume, pan)` (the 2D start),
`controlVoice`, `voicePlaying` and `stopVoice`. So are the world's reads,
`fastLineCheck`, `globalLighting`, `sample(sound)` (`{rate}`), `index(actor)`
and `atan2`. FPATAN is a transcendental: `atan2` is the host's double, which
can differ from the hardware's extended result in its last bits before the
float store (the oracle runs it in double too). Not translated: the music
transition, the zone reverb, the 3D hardware voices and the lip-sync
sampling (step 12).

## Validation

`scripts/native-galaxy-audio-oracle.py` runs the original PlaySound and Update
on a subsystem buffer with the case's config. Init's StopSound loop runs
first, so idle channels hold what Init leaves. The voice library calls, the
FastLineCheck and GlobalLighting imports, IsValid and appSecondsSlow are
recording or answering leaves; Core's appSqrt, appAtan2, appStricmp (over a
`_wcsicmp` leaf) and SafeNormal execute. `scripts/validate-native-galaxy-audio.mjs`
scripts 165 cases:

- a basic play, start, control and finished voice;
- channel stealing over four channels, with NoOverride and slot-0 ids;
- ambient scan and refresh with light scaling (GlobalLighting), Doppler and
  leaving range;
- occlusion ramping up and down, the speech ratio, ReverseStereo and surround;
- equal volumes and a ViewTarget listener;
- 160 seeded random sequences (with NoteDestroy and StopSoundId).

All 1,954 calls match: every return, the 110 voice starts
and 144 voice controls (index, sample, frequency, volume, pan), the stops and
status queries, each FastLineCheck and GlobalLighting request, and every bit
of every channel record (the idle channels' uninitialized words masked).

## Play

`src/runtime/script-audio-live.mjs` builds the subsystem when Play starts,
from `DeusEx.ini [Galaxy.GalaxyAudioSubsystem]` with Init's clamps
(Use3dHardware True would be refused: its voices are not translated). The
world services read the live actors. The listener is the player and its
ViewTarget. `index` is the actor's measured global index
(`ScriptRuntime.measuredObjectIndex`: the map, pawn and player tables of
object-index-captures.md). A runtime spawn's host registry slot is not the
original index (the seeded spawn registry is not wired into Play,
boot-replay.md), so an ambient actor without a measured index is left out of
the scan and noted rather than given an invented id (Island's LaserEmitters). `fastLineCheck` is the translated UModel::FastLineCheck.
`globalLighting` follows Render.dll's `URender::GlobalLighting`
(`0x10b05e90`): the light type's function (mesh-lighting.mjs; Steady when not
realtime; Pulse, Flicker, SubtlePulse and the palette types are noted, as for
mesh lighting), then a clamp to `[0, 1]` (floats `0x10b2a5c4`/`0x10b2a5b0`).

UGameEngine::Draw calls `Audio->Update(Region, Frame->Coords)` after drawing
(`0x1038f638`), so Play updates Galaxy after each HUD frame with the scene
frame's coords for the view (`buildWindowSceneFrame`, the 12 floats at
`frame+0x34`) and the wall-clock time (performance.now, the original's
appSecondsSlow). A Player-start reload stops every channel; the original's
level change of the subsystem is not traced.

Samples: every AmbientSound of the level is decoded before the first tick (the
WAV payload of the USound export), and any other sound the first time Galaxy
needs it, synchronously from its loaded package (a script that sets
AmbientSound later, Warehouse's dogs). A sample the host cannot decode plays as
an empty voice that finishes at once, and is noted. Voices are host records with a clock: a
voice's position advances by the elapsed time times its last frequency;
with the WAV's own `smpl` loop it wraps between the loop points, and without
one it finishes after its frames. That is what `voicePlaying` reports.
Galaxy's sample loader and mixer are not translated. The browser
(`main.mjs galaxyVoice`) plays each voice as a buffer source at
`frequency/rate` with the WAV's loop points, a stereo panner at
`pan/16383.5 - 1` (0xc000 surround centred) and a gain of
`volume/32767 · digital/127`. That volume and pan law is the host's mapping
of Galaxy's units, not a measured mixer.

What reaches Galaxy: ambient sounds (Update's scan), and script PlaySound
through its original chain. `XLevel->Engine->Audio` is linked before the map's
startup and Login (script-doors.mjs `level.engine.audio`):

1. `execPlaySound` (`0x103e1f60`, script-sound.mjs) for an emitter whose
   global index is measured: the pre-placed actors of the map table and the
   player, whose index is the one JCDentonMale instance of the same map's
   open capture (`mapPlayerIndex`; JCDentonMale1 there, 41639 on Training,
   47368 on Island). CheckHearSound walks the PawnList, or the viewports for a
   simulated function, and dispatches `ClientHearSound` to each listener in
   range.
2. Core ProcessEvent sends a native function to the receiver's
   `ProcessRemoteFunction` (vtable +0x18) first (`0x1013f862`).
   `AActor::ProcessRemoteFunction` (`0x103e5d90`) returns 0 for a static
   function, a bDeleteMe actor, and at NM_Standalone without a demo driver, so
   the native runs (`UFunction::Func`, `0x1013f936`). With a demo driver and a
   ServerConnection it returns Absorb (Role <= SimulatedProxy without
   FUNC_Simulated). The demo-recording and networked paths are not translated
   and throw (process-remote-function.mjs).
3. `APawn::execClientHearSound` (`0x103dfc40`): Volume `f32(X·0.01)` and Pitch
   `f32(Z·0.01)` (an x87 fmul by the qword 0.01 at `0x10429858`), Radius `Y`,
   or 1600 when it compares equal to 0.0 or unordered. Only a PlayerPawn whose
   Player is a UViewport, with Audio set, plays; an Actor with bDeleteMe goes as
   None. Then Galaxy's PlaySound (vtable +0x74).
4. `execStopSound` (`0x103e27d0`, native 265) reads Id and calls Audio's
   StopSoundId (+0x78) when Audio is set. Conversation speech stops are
   consumed by the speech transport first.

A runtime spawn (a fragment, a projectile, a LaserEmitter) has no measured
index, so its PlaySound stays the recorded boundary that returns the
placeholder channel 0; StopSound(0) can only match an idle channel, because a
real id carries a nonzero object index and slot-0 sounds take Galaxy's
counter ids. Speech keeps its own transport.

`scripts/validate-native-client-hear-sound.mjs` runs the original
execClientHearSound, execStopSound and ProcessRemoteFunction on fabricated
objects (`native-client-hear-sound-oracle.py`; a replaced GNatives evaluator
and recording vtable stubs): 702 cases cover every gate, 400 random parameter
vectors (bits, with NaN, infinities, denormals and ±0) and the standalone
remote-function branches, and match as bits. A signaling NaN in SoundLocation
survives the native's integer copies but not a JS number, so those 18 inputs
expect the quieted word; the runtime's floats never carry an sNaN.

In Play, Training's LightSwitch click lands on a Galaxy channel with id 547874
(validate-frob), Plant7's push sound returns `pushSoundId` from its measured
index and its Timer's StopSound reaches StopSoundId (validate-plant-push), the
Radiation10 pain sound and the bot arm sounds return the original ids
(validate-trigger-actions, validate-triggers, validate-window-baseline-play),
and booted Training and Island start the player's footstep voices.

A booted UNATCO Island run of 180 frames starts six ambient voices (boat idle,
strong and harbour wind, ...) with their WAV loops, and controls them every
frame without an error.

**StopSoundId** (`0x10607ef0`) stops the first channel whose Id matches
except for bit 0. **NoteDestroy** (`0x106083a0`) asserts a non-null, valid
actor; each channel holding it is stopped when it is an ambient channel
(slot 4), and otherwise forgets the actor and keeps playing at its last
Location. Both are in the oracle's random sequences. Play links ULevel's
`XLevel->Engine->Audio` (`level.engine.audio`) so DestroyActor's NoteDestroy
reaches Galaxy (script-destroy.mjs).

Remaining: runtime spawns' global indices (the seeded spawn registry), the
demo-recording and networked ProcessRemoteFunction paths, RegisterSound
(sample decoding and loop points), the Galaxy library's voice functions and
mixer (how a volume, pan and frequency become samples), music (RegisterMusic,
the tracker player), then the oracle cases and the Web Audio mapping.
