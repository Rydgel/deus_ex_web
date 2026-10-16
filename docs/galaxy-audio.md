# Galaxy audio subsystem

Play's sound effects, ambient sounds, speech and music go through Galaxy's
own library: the translated subsystem (`src/runtime/galaxy-audio.mjs`)
drives the library's voices and music in an AudioWorklet, with the zone
reverb ("Effects through Galaxy's mixer" below). Speech (conversation,
DataLink and bark lines) takes the same channels and voices from the
browser's MP3 decode, as Galaxy's MPEG decoder is not ported ("Speech
through Galaxy's voices" below). This note records the original subsystem,
then its translation and how Play uses it.

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

1. Returns without a viewport. Calls `0x1060e840`, which is
   `EnterCriticalSection(0x1067b670)` (not a library tick; `0x10618920`
   leaves it at `0x1060abd6`), so Update runs under the Galaxy lock against
   the mixer thread ([galaxy-music](galaxy-music.md)).
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
    SongSection `+0x674`, CdTrack `+0x675`, Transition `+0x676`; fade ends at
    Latency × `-0.002/-0.0004/-0.006`, rates 1, `0.2`, `3.0`): see
    [galaxy-music](galaxy-music.md).

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
float store (the oracle runs it in double too). Step 12's gate and cadence
(a voice, an Actor, a SLOT_Talk id, IsA Pawn, time not below the next
analysis time, bIsSpeaking; next = float(next + 0.1)) are in the channel
loop, and the analysis of the voice's data is the optional
`services.lipSync(channel)` ([lip-sync](lip-sync.md)); the oracle harness
supplies none, so its runs skip the step. The music section (step 14)
is galaxy-music.mjs's, called after the channel loop inside the library's
`lock()`/`unlock()` (`services.library`, `services.music`; see
[galaxy-music](galaxy-music.md) "Phase 4"), then the reverb tail
([reverb](galaxy-music/reverb.md) §2; `config.useReverb`, the listener's
Region.Zone, `services.library.setSampleReverb`). Not translated: the 3D
hardware voices and step 12 for a non-streamed (WAV) Talk sample. Update's
category ratio reads the live SoundVolume/SpeechVolume bytes, which natives
268/269 change (galaxy-volumes.mjs).

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
object-index-captures.md) or the slot the model gives a runtime spawn
(`ScriptRuntime.soundObjectIndex`, "Runtime spawns" there), never the host
registry's own slot, so an ambient actor with neither is left out of the scan
and noted rather than given an invented id. `fastLineCheck` is the translated UModel::FastLineCheck.
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
one it finishes after its frames. That is what `voicePlaying` reports
under the Web Audio mapping (`?sfx=webaudio`, `?music=0`, headless runs),
and before the worklet first reports with Galaxy's voices (next section).
Under that mapping the browser (`main.mjs galaxyVoice`) plays each voice as
a buffer source at
`frequency/rate` with the WAV's loop points, a stereo panner at
`pan/16383.5 - 1` (0xc000 surround centred) and a gain of
`volume/32767 · digital/127`. That volume and pan law is the host's mapping
of Galaxy's units, not a measured mixer.

What reaches Galaxy: ambient sounds (Update's scan), script PlaySound
through its original chain, and interface sounds (Window.PlaySound, item 4). `XLevel->Engine->Audio` is linked before the map's
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
4. `Window.PlaySound` (Extension native 1473, [script-window-sound](script-window-sound.md)):
   menu, HUD and inventory interface sounds. The body calls Audio's PlaySound
   itself (`None, 0, Sound, pawn.Location + XAxis, Volume * 100/99, 100,
   Pitch`), with no ClientHearSound and no actor, so a channel takes a counter
   id and Update pans it from that position. Wired 2026-10-14
   (validate-window-sound-play, validate-window-sound-browser).
5. `execStopSound` (`0x103e27d0`, native 265) reads Id and calls Audio's
   StopSoundId (+0x78) when Audio is set, conversation speech stops
   included.
6. Speech: ConPlay, DataLinkPlay and BarkManager lines are PlaySound calls
   like any other (item 1, then "Speech through Galaxy's voices").

A runtime spawn (a fragment, a projectile, a LaserEmitter, a weapon that was `summon`ed or dropped) has no entry in the
capture. Its id is formed from the slot the original's `AddObject` rule gives it, continued from the map's measured registry
state and every creation and release since (`original-object-index.mjs`; [object-index-captures](object-index-captures.md)
"Runtime spawns"): `ScriptRuntime.soundObjectIndex` answers `measured` for the capture and `modeled` for such a slot, and the
sound takes the real chain above. Only an emitter with neither (an object that existed before the model was seeded and is not
in the capture) stays the recorded boundary that returns the placeholder channel 0; StopSound(0) can only match an idle
channel, because a real id carries a nonzero object index and slot-0 sounds take Galaxy's counter ids. Galaxy compares ids for equality and reads their slot bits only, so a unique, stable modeled id gives the
original's audible behaviour; its magnitude is the original's only where the model replays every creation (the weapon scene
of that note: the first 310, or without Mission06's flags 417, registry takes equal).

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

## Effects through Galaxy's mixer (2026-10-06)

Play's effect voices are Galaxy's own, mixed by the translated library in
the music worklet on bus B with the music on bus A, as the original's single
voice pool does. `?sfx=webaudio` keeps the Web Audio mapping above, for A/B.

**Library side** ([effects](galaxy-music/effects.md),
`native/galaxy-kernel/src/effects.rs`): glxLoadSample with its WAV loader
(RegisterSound's call), glxStartSample, glxControlSample, glxControlVoice
(the status poll) and glxStopSample. The mixer already mixed the effect
slots; `galaxy_render` stores bus A and adds bus B onto the same frames
(the renderer's placement at coincident heads). Since 2026-10-16 the worklet
plays the translated timer callback's secondary buffer instead
([mixer](galaxy-music/mixer.md) §9, [galaxy-music](galaxy-music.md) "Phase
5"): bus B at head B = A + D, music heard size − D bytes after the effects
rendered with it, as in the original. The effects reverb is the
renderer's hook between the mix and the conversions
([reverb](galaxy-music/reverb.md), `reverb.rs`).

**Transport** (`galaxy-music-library.mjs`, `galaxy-music-worklet.mjs`):

* the library service gains the ops loadSample, startSample, controlSample,
  stopSample and setSampleReverb (variable arity, `OP_ARITY`). Update's
  calls cross as one batch per critical section, as music's do; a PlaySound
  outside Update (its StopSound) is a batch of one. Nothing crosses the
  page in worker mode.
* RegisterSound runs on the simulation side, as on the original's game
  thread: the service's sample registry (`createSampleRegistry`, its own
  kernel instance) runs glxLoadSample at once, so Update has the record's
  C4Speed for its frequency, and the loadSample op carries the WAV bytes
  once. The worklet runs the same loader from the same empty sample heap
  and checks that the handle matches.
* The voice handle is glxStartSample's fixed voice, `0x1068dc00 + 0xa0 ·
  (channel + 1)`.
* The worklet reports each effect voice's Active byte with the order
  (`report.active`). `voiceActive()` returns it, replaying the ops not yet
  acknowledged (a start sets Active, a stop clears it). In the original,
  the mixer thread also clears Active asynchronously to Update's read.
* Before the first report (the worklet opens on the page's first gesture),
  the voice status comes from the host clock. A load path that is not
  translated (an ADPCM WAV, say) gives a silent host voice that finishes at
  once, and is noted; MP3s take the host decode ("Speech through Galaxy's
  voices").
* `dispose()` stops the voices with the map, as SetViewport's StopSound
  loop does at a Player start.
* UseReverb comes from DeusEx.ini (True as installed). Update hands the
  listener zone's glxReverb over each time it changes.

**What the simulation reads back is unchanged.** The voice status is the
library's Active byte, and PlaySound's result is the channel logic's.
`GetSpeechLength` is computed from the sound data. Speech joined these
voices on 2026-10-16 (next section).

**Verification.**

| Validator | What it shows |
| --- | --- |
| `validate-galaxy-effects.mjs` | The library entries and the reverb setter/renderer under Unicorn: 549 shipped and 14 synthetic WAVs, 25 cases, 556 voice calls, 1,134 callbacks, both buses' PCM bit-equal, the browser path at coincident heads, mutants 301–306. |
| `validate-galaxy-reverb.mjs` | The reverb setup and SSE kernel run natively on real x87/SSE (reverb.md §5). |
| `validate-galaxy-music-update.mjs` | Update's reverb tail against the original Update (13 cases × 3 control words, 246 setter blocks). |
| `validate-galaxy-effects-play.mjs` | Headless Play driving the worklet processor under Node in real time. Island: 7 samples, 3,812 voice ops, 3,618 voice-table checks against the channels, Active in sync, no underrun. Brooklyn Bridge Station: the reverb installed. Training. |
| `validate-galaxy-effects-browser.mjs` | Headless Chromium, worker mode. Island: Galaxy voices active, 0 handle mismatches, 0 underruns, no Web Audio voice. Brooklyn Bridge Station: the reverb engine installed. `?sfx=webaudio`: Web Audio voices and no worklet sample. Frame-time pairs. |

**Cost** (Linux host, Island, worker mode, 3 interleaved pairs):
- The main thread takes 3.31 ms per frame against 3.26 ms with
  `?sfx=webaudio`.
- The worker's Galaxy Update takes 0.86 ms against 0.77 ms: the voice ops
  are now encoded and posted.
- The worklet's `galaxy_render(882)` per 20 ms callback has a median of
  135 µs (p99 244 µs) with music and six effect voices, and 143 µs with
  the reverb on.

**Open.**
- ~~The original's two ring heads~~: reproduced since 2026-10-16 (the
  translated callback, oracle-checked); D's host part (the write cursor's
  lead) is measured on the reference machine and pinned (1,764 bytes, D = 8,820;
  [audio-output-scope](audio-output-scope.md) §5.1).
- ~~The timer thread's MXCSR is assumed to be 0x1f80.~~ Measured 0x1f80
  ([audio-output-scope](audio-output-scope.md) §5.1).
- The game thread's x87 control word is open: 0x007f would change the
  reverb coefficients.
- The MPEG and ADPCM sample paths and the 3D voices are not translated
  (speech plays from the browser's decode, next section).

Remaining: runtime spawns' global indices (the seeded spawn registry), the
demo-recording and networked ProcessRemoteFunction paths, and
UnregisterSound (Play never destroys a USound). Music is phase 4/5 of
[galaxy-music](galaxy-music.md).

## Speech through Galaxy's voices (2026-10-16)

**The original.** Speech is plain `Actor.PlaySound` (native 264); the
DeusEx.u bytecode (`scripts/dump-script-function.mjs DeusEx ...`):

* `ConPlay.PlaySpeech`: with `bForcePlay`, the player (when there is no
  speaker or the speaker is farther than 400) or else the speaker plays
  `PlaySound(Speech, SLOT_Talk, , , 65536)`. Otherwise the speaker plays it
  with Radius 65536 when `con.bCannotBeInterrupted || !con.bFirstPerson`
  (natives 132 `||`, 129 `!`), else `512 + initialRadius` (native 174,
  float addition). Then `StartSpeakingAnimation`.
* `DataLinkPlay.PlaySpeech`: `Player.PlaySound(Speech, SLOT_Talk)` (the
  execPlaySound defaults). `DataLinkPlay.StartConversation`:
  `Player.PlaySound(startSound, SLOT_None)`, the DataLinkStart WAV.
* `BarkManager.StartBark`: `newBarkPawn.PlaySound(speechAudio, SLOT_Talk, ,
  , 1024)`.
* Their stops are `Player.StopSound(playingSoundID)` (native 265,
  StopSoundId).

So speech takes "What reaches Galaxy" items 1-3 and 5, and Update gives a
slot-5 channel its distance factor, its pan and the speech category ratio,
without the occlusion test (step 5). RegisterSound's glxLoadSample takes the
MPEG path `0x10620b30` for these MP3s (a streamed record, type `0x4024`,
[lip-sync](lip-sync.md)), which glxStartSample's ring branch plays, fed by
the decoder thread `0x1060e340`.

**Before.** The three ConPlay/DataLinkPlay sites were taken out at the
player's ClientHearSound and played by the page at the fixed gain
`parameters[0]/100`: no channel, so no distance, pan or ratio (the
DataLinkStart WAV cue went that way too). Barks took the real chain, but the
translated glxLoadSample refuses an MP3 (fault `0x130`, the MPEG dispatch),
so a bark was a silent voice under Galaxy's voices and a noted "mp3 sample"
under the Web Audio mapping: barks were inaudible. A speech MP3 run through
the sample registry gives `{handle: 0, fault: 0x130}`; the DataLinkStart WAV
loads.

**Now.**

1. The chain: `script-conplay-live.mjs` no longer consumes natives 264 and
   265 at those sites. A 264 there runs the general route (the measured or
   modeled emitter index, `playSoundServices`; an emitter with neither takes
   the general route's boundary) and records what reaches the player's
   ClientHearSound (`soundRequests`, `onConversationSpeech`: diagnostics and
   validators only). StopSound is the original native.
2. RegisterSound of an MP3 sound (`script-audio-live.mjs` `hostSample`): a
   host-decoded record. Its rate is the MPEG frame header's, which the MPEG
   loader puts at `+0x3c` (44100 for the shipped speech), so step 13's
   frequency `ftol(rate · pitch · doppler)` is the original's. Its frame
   count is a walk over the MPEG frame headers (`mp3Frames`) until a decode
   gives the real one; only the host clock reads it.
3. (Replaced on 2026-10-16 by "Speech on Galaxy's ring transport" below: the record is now the MPEG loader's stand-in of type
   0x4024/0x4044 and plays on the ring transport. As first written:) The record (`effects.rs` `host_sample`, a stand-in, not a translation):
   what the WAVE loader writes for 16-bit mono PCM (type `0x24`, PANNING
   `0x4000`, Length, rate), allocated from the bump heap as glxLoadSample's
   `malloc(0x48)`, so the simulation's registry and the worklet agree on the
   handle (`loadHostSample` op). Its PCM lives in a separate pool from
   `0x80000000` (`HOST_POOL`), not an original allocation.
4. The decode: when a voice starts on such a record, the simulation asks the
   page (`onVoice({op: 'decode', sound, bytes, rate})`). `main.mjs`
   `decodeSpeech` decodes the MP3 in an OfflineAudioContext at the header's
   rate and converts it with `pcm16` (round to nearest, clamp; unverified
   against Galaxy's decoder), then answers `speech-pcm` (worker) or
   `game.attachSpeech` (inline). A failed decode answers an empty PCM: the
   voice plays nothing and finishes, noted.
5. The mixer: `attachSample` gives the record its PCM (Length the decoded
   frames, 31 zero bytes after them, as after a WAVE data chunk). The worklet
   holds a start whose record has no PCM yet: the slot is stopped (as
   glxStartSample stops it first), the start's arguments wait (a
   controlSample updates them, a stopSample or a new start drops them), the
   slot counts as Active for Update's "voice finished" poll, and
   glxStartSample runs when the PCM arrives. From then on it is an ordinary
   non-ring effect voice: glxControlSample from Update each frame, mixed on
   bus B with the zone reverb, Active cleared at its end. The original's ring
   voice starts at once on a zeroed ring that the decoder thread fills; here
   the decoded line starts whole once decoded (host timing, tens of
   milliseconds).
6. Release: when no voice plays the record, the simulation drops the PCM and
   `releaseSample` drops the worklet's; the next voice asks for the decode
   again. Memory follows the lines playing, not the map's whole speech (the
   original keeps the MP3 and a 64 KB ring).
7. Lip sync is Update's step 12 over Galaxy's own channels
   ([lip-sync](lip-sync.md)) on the same PCM. The mixer position is the
   worklet's read head (voice `+0x46` minus `+0x4e`, reported with the
   Active bits), or the host clock before the worklet reports and under the
   Web Audio mapping.
8. The Web Audio mapping (`?sfx=webaudio`, and headless runs without a
   worklet): the speech voice is a host voice like the WAVs; the page decodes
   the MP3 for each start and keeps no buffer.

Any MP3 USound takes this path, including UserInterface.Menu_SpeechTest
(11,388 bytes, 44100 Hz), which `MenuChoice_SpeechVolume.ScalePositionChanged`
plays with `Player.PlaySound(Menu_SpeechTest, SLOT_Talk, , true)` when the
speech volume slider moves; that site was not exercised in Play here.

**Original against substitute.** From the original: the script sites and
their radii, execPlaySound, CheckHearSound, execClientHearSound, PlaySound's
channel choice, Update's priority, volume, pan, ratio and voice calls every
frame, StopSoundId, NoteDestroy, step 12's gate, cadence and analysis,
glxStartSample's non-ring branch, glxControlSample and the mixer.
Substitutes, unverified: the browser's MP3 decode and its 16-bit rounding
(row 4.5.6, excluded by the user's decision of 2026-10-16); the non-streamed
record and the non-ring branch in place of the streamed record and the ring
branch; the hold until the decode arrives in place of the decoder thread's
fill; the PCM pool; the frame-count estimate.

**Verification.**

| Validator | What it shows |
| --- | --- |
| `validate-island-bark.mjs` | Island, the player placed at ComputerSecurity1: Terrorist30's bark (`ConAudioAIBarks_896`) holds a Galaxy channel with its BarkManager slot's id 573066, SLOT_Talk, Radius 1024, a host-decoded record at 44100 Hz, no silent-sample note. With the clock held, the listener's view swept around the emitter: each Update's voice volume and pan equal Update's formulas recomputed in doubles (within 2 units); straight on the volume falls 21503, 18457, 13977, 9497, 5017, 1657 at 64, 200, 400, 600, 800, 950 units to the `0x80` floor at 1100, the pan stays 16384; turned 60 degrees either way the pan is 25940 or 6827, and 22356 or 10410 inside `0.1 · Radius`. Terrorist18's own bark reaches no listener from there (CheckHearSound). |
| `validate-island-lipsync.mjs` | MeetPaul headless to its first choice: Paul's 4 lines on Galaxy channels with his SLOT_Talk ids (Radius 65536, ConPlay.PlaySpeech's third-person branch, so the volume stays at 32767), 9 decodes, each Update's voice volume and pan against the formulas over 1,955 Updates (pan 16267-16383), 438 analyses on step 12's cadence, Paul's letters and mouth sequences, no PCM kept after a Player start. |
| `validate-galaxy-effects-play.mjs` | The worklet processor under Node: on Island one of Paul's prepared lines through the original execClientHearSound: loadHostSample with the registry's handle, the start held (Active, not mixed) until the ffmpeg decode is attached, then the voice table's record, frequency, volume and pan, the read head advancing to the PCM's 16,128 frames, the voice ending on its own and the channel freed, one attach, one held start run, one release. |
| `validate-island-conversation.mjs`, `validate-instructor-conversation.mjs`, `validate-training-datalink-live.mjs`, `validate-crowbar-crate.mjs` | The conversation and DataLink flows with speech on Galaxy's channels; a Player start stops the speech channel. |
| `validate-native-galaxy-audio.mjs`, `validate-galaxy-volumes.mjs`, `validate-galaxy-effects.mjs`, `validate-galaxy-lipsync.mjs` | The oracle checks, unchanged: 165 cases and 1,954 calls, 768 volume cases, the library entries, 200 analyses bit-exact. |
| `validate-galaxy-effects-browser.mjs --pairs 0` | Headless Chromium, worker mode: Galaxy voices, the reverb and `?sfx=webaudio` as before. |

In headless Chromium (worker mode, MeetPaul placed as
`scripts/conversation-acceptance.mjs` places it; a scratch check, not
committed) Paul's first three lines were decoded on the page, held in the
worklet and started on their PCM (3 attaches, 3 held starts, 2 releases by
then), with 0 faults, 0 underruns, 0 handle mismatches, no Web Audio voice
on the page and no console error; with `?sfx=webaudio` the page started 27
voices, the speech among them, with 0 failures.

**Open.**

* The start: the original's ring voice starts at once and its decoder thread
  fills the ring ahead of the mixer; how far ahead, and the end of a ring
  voice (what the decoder thread and Active do at the end of the MP3), are
  not traced. Here the line starts whole after the host decode and ends at
  the decoded length.
* Step 12 for a WAV on SLOT_Talk (the non-streamed record, 0.1 s ahead) is
  not translated.
* The page converts the decode to 16-bit on its main thread once per line
  (as the earlier transport did for lip sync): a one-off cost at a line's
  start, not measured against the 8.3 ms frame budget.

## Speech on Galaxy's ring transport (2026-10-16)

Since this date speech no longer plays from a non-ring stand-in record: it plays on the original's ring transport, translated
(`native/galaxy-kernel/src/ring.rs`, the ring branches in `effects.rs`) and checked against the original under Unicorn (Stage 4 gate
row 4.3.7, check 5, `scripts/validate-galaxy-ring-voice.mjs`). Items 3 to 5 of "Speech through Galaxy's voices" above are replaced by
this section; the chain (items 1, 2, 6 to 8) is unchanged.

**What is translated** (addresses at the preferred base):

* **glxStartSample's ring branch** (`0x10612452..0x1061258f`): for a record of type `& 0xe000` or `& 0x40`, `malloc(0x1001f)` with the
  first 0x10000 bytes zeroed (the last 0x1f never written), the voice's type `|= 0x88` (looped, loop always), loop start = data start
  = the ring, loop end = end = ring + 0x7fff samples, the write position `V+0x88 = 0x10000` (a sentinel), the source offset `V+0x8c =
  0`, `V+0x90 = V+0x94 = 0x10000`. A pair's second voice (type 0x40) starts at time −2 like a `flags & 1` start; a pair's default pan
  (−1) is 0 and 0x7fff. No decode and no message at the start.
* **The refill posts** (`0x106151bb..0x1061520c`, already traced in `sequencer.rs`): at each sequencer tick, for every effect slot
  with `V+0x10`, `V+0x0f` and `V+0x11 & 8` and a ring type, `PostThreadMessageA(decoder, 0x400, slot, V+0x46 − V+0x52)` before the
  segment is mixed. A pair's second voice has `V+0x11 & 8` clear: one post feeds both rings.
* **The decoder thread's handler** (`0x1060e363..0x1060e80d`): the Link chain's mutexes; the read head in bytes; the first fill at
  `(read + 0x2000) & 0xffff`; `n = (read − write) mod 0x10000`, at most 0x8000 bytes per message; decoder calls of `min(n, 0x10000 −
  write)` bytes into the voice's ring and its Link voice's ring, the source offset advancing by what each call consumed, a second
  attempt after an empty answer; at the end of the stream (two empty answers, the record not looped) and **only when the read head
  is below the write position** (`cmp; jge`, ring-relative bytes), the loop bits `0x88` cleared and loop end = end = the write
  position; the rest of the ring (and the Link's) zeroed from the write position for `n` bytes; the write position and offset stored.
* **glxStopSample's ring free** (`0x10618503..0x10618530`): `free(V+0x4e · bps)`, then `V+0x4e`, `V+0x88..V+0x94` zeroed.

**Stand-ins, labelled.** The MPEG decoder `0x1061a690` is not ported (row 4.5.6, the user's decision): the record's source is the
browser's decode (interleaved for stereo) instead of the MP3 bytes, and `decode_leaf` copies what fits (mono: `min(Chunk, Remaining)`
bytes; stereo: `min(Chunk / 2, Remaining / 4)` frames, left to the voice's ring, right to the Link's); the oracle replaces `0x1061a690`
with the same leaf. So `+0x30` holds the PCM's byte length and `+0x44` the PCM, where the MPEG loader stores the MP3's (the other
fields are the loader's: `0x10620cd5..0x10620d99`, type 0x4024 for MPEG mode 3, 0x4044 for any other). A message is handled after the
timer callback that posted it, in post order (the original's HIGHEST-priority thread may run during the rest of the callback on
another core; the bytes it writes are behind the posted read head, or 0x2000 bytes ahead of it at the first fill, which the rest of
a callback does not reach). The ring of voice slot s is at `0x68000000 + s·0x10020` (the address is only ever used as a pointer).

**What the oracle settled** ([audio-output-scope](audio-output-scope.md) §2.3 and §2.4 were read from code; the 14 cases measure them):

* **The head start**: the first decoded sample sits 4,096 samples (0x2000 bytes, 92.9 ms) after the read head at the first refill
  post, which itself comes at the first sequencer tick after the start (e.g. 110 samples later at the default tempo).
* **The refills**: the first message fills 0x8000 bytes, the second the rest of the ring up to the read head, then one tick's worth
  each (882 or 970 bytes at the default tempo, the tick's 441/485 samples).
* **One sample lost per ring lap**: the mixer's ring loop is `[ring, ring + 0x7fff]` (mixer.md §2.3: the bound sample is mixed, then
  the position wraps to loop start + 1), 32,767 samples, while the decoder writes a 65,536-byte (32,768-sample) ring. Every lap after
  the first the mixer skips ring index 0, so one decoded sample is dropped every 32,767 samples (0.743 s at 44.1 kHz). Measured on
  the verified kernel: the lag between the samples mixed and the decoded index at the read head is 4,294 before the first wrap and
  4,293 after it.
* **The end**: a line whose data all fits in the first fill (under about 16,000 samples) ends right after its last sample. A longer
  line's end is set only once the read head has wrapped below the write position, so the voice keeps playing the zeroed ring for up
  to a lap: on the 100,000-frame test line Active cleared about 27,000 samples (0.61 s) after the last decoded sample. Update's
  "voice finished" poll (Active) frees the channel that much later than the speech's audio ends.
* **Stereo**: a 0x4044 record starts two voices, the channel's slot and the next, stopping what played on the next slot; one post
  feeds both rings; glxControlSample walks the Link to both. When the next slot is later restarted with a WAV while the pair's first
  voice still plays, the decoder writes the second channel and its zeroing through the stale Link at that voice's `+0x52`, the WAV's
  data and the heap after it (original memory corruption; the translation drops those writes, `HAZARD_RING_FOREIGN_WRITE`, and the
  oracle cases avoid it). A restart of the next slot with another ring voice is modelled (the pair writes into that ring).
* **The ring's tail**: the kernel reads `x[p + 1]` at the loop end, the never-written bytes `0x10000..0x10001` of the allocation
  (`HAZARD_UNWRITTEN_TAIL`; its weight is 0 at a step of exactly 0x10000).

**Play.** The registry and the worklet make the stand-in record (`loadHostSample` with the MPEG mode's channels); the page decodes
both channels of a stereo line (`decodeSpeech`, interleaved); the worklet holds a start until the PCM arrives (host timing, as
before), then glxStartSample runs the ring branch; after each timer callback the worklet handles the posted refills
(`galaxy_ring_deliver`); the voice ends when the decoder thread and the mixer end it. Lip sync reads the same samples the original
reads (Update's step 12 for a streamed record, `0x1060a0e9..0x1060a10e`): the worklet reports, with each read head, the ring's 1024
samples at `V+0x46 − V+0x52`, zero past the loop end `V+0x56` (`voiceWindow`), and the analysis runs on that window. Before the
worklet reports, and under the Web Audio mapping, the host clock's stand-in (the PCM at the clock's position, no head start) stays.

**Verification.**

| Validator | What it shows |
| --- | --- |
| `validate-galaxy-ring-voice.mjs` | 14 cases, 1,446 timer callbacks, 2,631 decoder messages, bit-equal with the original: the record, the voice records after every library call and every message, every live ring's 64 KB after every message, the callback's buffer calls, heads and mixed output (secondary buffer and staging ring digests), the mixer trace with its posts. Mono lines at 44,100, 47,000, 30,000 and 44,099 Hz, a stereo pair over a playing WAV with glxControlSample on the pair, a pair's default pan, a line shorter than the head start, a stop and restarts on one slot, two lines with music and an effect, a pair whose second slot is the first music voice, the record defaults (−1), three seeded random programs. Coverage: every instruction of the ring paths except the 8-bit, type 0x8000, ADPCM and stereo-PCM-WAV branches (none reachable with the shipped sounds) and null-pointer guards. Mutants 501 (no head start), 502 (loop end + 0x8000), 503 (no fill cap) and 504 (end without the read-head test) are caught; 505 (one attempt) is equivalent under the leaf. |
| `validate-galaxy-effects-play.mjs` | Island's bark through the worklet under Node: held until the ffmpeg decode, the ring's refills taken, the read head through the ring's first lap past the head start, the lip-sync window holding the line, the voice ending on its own. |

**Open.** The decoder's own output (row 4.5.6, excluded) and how the real MPEG decoder splits its answers (the leaf answers in
whole chunks; a decoder that answers nothing once mid-stream would take the second attempt, which the leaf never exercises); the
decoder thread's timing against the mixer on the reference machine (host).

## Row 4.3.6: the Underworld's sound calls equal the original's (2026-10-16)

The Linux capture `snd1` was out of reach, so the scene was captured again on the Mac under CrossOver (the commands and the
tracer config: [object-index-captures](object-index-captures.md) "Repeating the scene"). Five captures, each replayed and compared
(`live-sound-compare.mjs --gate`, `live-events-compare.mjs`, `live-acceptance.mjs compare`), found these causes; each fix is the
original's code or a measured host input:

| Capture | First difference | Cause | Fix (commit) |
| --- | --- | --- | --- |
| `sndm` | tick 210: GlassFragment9's `GlassBreakLarge` at 0.7 in the original, 2.0 in Play | CheckHearSound's FastLineCheck runs on `XLevel->Model`, which the moving brush tracker extends with every mover's fragments: the broken pane's fragments still stand between the player and its fragment, so the original took the blocked branch (x 0.35). Play's checks read the static BSP. Engine.dll's FastLineCheck under Unicorn and Play's agree on both models (1,493 lines on three maps, `validate-fast-line-check-tracked`) | every FastLineCheck reads the tracker's node block (90a08da) |
| `sndm` | tick 212: a GC (GC519) in the original where Play created a FlagBool | XGC::PushGC's node (0x100278d0 via XGC::operator new 0x10002c40) is a registered GC that takes a slot when DrawText first pushes a window's GC; XGC::Destroy deletes each node before the GC | PushGC takes the slot, destroyGc gives each node's back (baf9ad1) |
| `sndm`, `sndm2` | tick 213: Female6 flees in Play, dances on in the original; then footsteps, the recoil's yaw and the casings from the stream | AIProcess stops after 2 ms of rdtsc (`GTimestamp` is set on every RDTSC CPU) and resumes the ring next tick; under the tracer the original reaches a few receivers per tick | the tracer records where `firstProcess` was left (`aiFirst`), the replay stops there; the landing's pre-scene sender is freed at the end of the manager's Tick (dd1d407) |
| `sndm3` | tick 217: the original frees the bark's display item and windows, Play at 294 | the window system ticks with wall-clock time (TickWindows), about 210 ms per tick under the tracer, and before the level | windows tick first; the replay feeds the original's RootTick deltas (`roottick`); `Module.dll@` call addresses (Extension.dll is rebased) (ea0910c) |

**Result on `sndm5`** (main `.work/live-acceptance/06_HongKong_WanChai_Underworld/*-sndm5.*`, Mac): the gate's steps (`population`,
`play --tag sndm5 --no-ghost --object-trace 1:400`, `live-sound-compare --gate`) give 68 of 68 ticks with sound calls equal, 103 of
103 calls in order, sound, emitter, volume, radius, pitch and channel id, the registry's 557 of 557 takes equal; the AI event
manager's 654 calls and callbacks equal on all 400 ticks, and the 50 watched actors equal for 400 ticks. The scene: the pistol
summoned, picked up and drawn, three shots (the first breaks BreakableGlass0 and starts a TriadRedArrow conversation and bark), the
NPCs' HandleShot and Distress, footsteps, three shell casings bouncing.

What the row does not cover: speech PCM (row 4.5.6, excluded), Galaxy's output after PlaySound (row 4.3.7), other maps and scenes,
and the original running at full speed (the capture's own wall-clock pace, ~210 ms per tick under the tracer, sets the AI budget's
stops and the window time, which the replay takes as measured inputs).

## Hand-off: the sound gate (2026-10-16)

The task was the Stage 4 gate's sound rows (4.3.6, 4.3.7, 4.5.6, [stage-4-exit-criteria](stage-4-exit-criteria.md)). Only step 1 was done; the user then
decided to keep the browser's MP3 decoder for speech (no port of Galaxy's MPEG decoder; row 4.5.6 is the coordinator's to mark EXCLUDED) and the work stopped.

**Done: 4.3.6, the live scene's script sounds, is a gate check and it fails.**

* The stored original: the Underworld's `snd1` capture (a normal player, `summon DeusEx.WeaponPistol`, pickup, draw, three shots, 400 ticks; the tracer's `gplay` /
  `addobj` / `unhash` / `hear` call records) was copied, nothing overwritten, from worktree `agent-a011db8f1b061eb8e` into the main checkout's
  `.work/live-acceptance/06_HongKong_WanChai_Underworld/` (`original-trace-snd1.jsonl{,.strobe,.calls.jsonl}`, `registry-start-snd1.txt`, `registry-end-snd1.txt`,
  `watch-snd1.json`, `commands-snd1.json`, `deferred-snd1.json`). No other stored capture holds `gplay` records (searched the main `.work`, `.work/live` and
  every agent worktree); a second scene needs a new Wine capture with the four call lines (docs/object-index-captures.md "Repeating the scene").
* `scripts/live-sound-compare.mjs --gate`: per tick, the original's `PlaySound` calls and Play's are lined up in call order and each must equal in sound, emitter
  class, volume bits, radius, pitch bits and channel id; the last line is `GATE {json}`, exit status 1 while any tick differs.
* `scripts/validate-stage4-acceptance.mjs`: a `SOUNDS` check (`judgeSounds`): stage the capture, `live-acceptance.mjs population --seed 1` (writes
  `play-population.json`, which names the pre-placed actors whose own measured indices the slot model takes; without it the model measured 0 and every id differed),
  `live-acceptance.mjs play --seed 1 --tag snd1 --no-ghost --object-trace 1:400`, then the strict compare. **`--no-ghost` is required**: the capture's player is a
  normal one; without it Play's player is the cheat-flying ghost (Physics 4, 24 units up, `CheatFlying`), never picks up the pistol, and Play makes 32 calls
  instead of 110.
* Result (`--only '^4\.3\.6$'`, from a clean `.work`, 109 s, peak 1.3 GB, FAIL): 56 of 82 ticks with sound calls equal, 82 of 112 calls (Play made 110), **first
  differing tick 278**; ignoring order inside a tick 93 calls match, channel id equal in 89 (pre-placed emitters 85 of 85, runtime-spawned 4 of 8). The registry
  takes agree for the first 417 of 563/587, to tick 212, where the original creates a bark window's graphics context (`GC519`) and Play a `FlagBool`
  (`triadredarrow_barkfutz_played`).

**What differs (not yet attributed to a cause).** From tick 278 on: NPC footsteps (Secretary0, Female7, Female5, Female3, Businessman1; the original steps
`TileStep4`/`TileStep2`, Play `tilestep1`/`tilestep3`, one or a few ticks apart), and the shell casing's `ShellHit` calls (original `ShellCasing1` slot 50924,
Play slot 50797; `ShellCasing2` 50786 against 51053; tick 295's volumes 0.553 against 0.563 and tick 355's 0.736 against 0.513). The earlier doc
([object-index-captures](object-index-captures.md)) saw the shots hit other things in Play (blood actors against a wall). Next steps: run
`live-acceptance.mjs compare --tag snd1` to see the first tick at which the watched NPCs (the walkers above) or the player diverge; the footstep choice is
script (`PlayFootStep`'s random sound pick from the stream), so a stream-draw count difference upstream shifts every later pick; then the tick-212 bark window
(`ConPlayBark` and its `GC`/`Window` objects: the original's registry takes there, which Play does in another order) and the casing's slot (an event-freed slot order).

**Not done.**

* 4.5.6 (speech samples against Galaxy's decoder): not started. Existing evidence is in this file and [lip-sync](lip-sync.md): speech is MPEG-1 Layer III 44.1 kHz
  mono, loaded by `0x10618e60`, decoded by the MPEG decoder at `0x10620b30` into the streamed ring voices. Whether the game ships any ADPCM sample was not
  checked. The user keeps the browser decoder.
* 4.3.7 (what reaches the speakers): not started. *(Later on 2026-10-16: done, all five checks pass; see
  [audio-output-scope](audio-output-scope.md) §6.)* Candidates in [galaxy-music](galaxy-music.md): the music bus delay, the two ring heads' spacing (mixer.md
  1.3, derived and unmeasured), MPEG/ADPCM samples, 3D voices. A loopback recording of the original under Wine is the only measurement path; whether it is
  reliable enough, and which parts are host output by nature (the browser's resampler and device), is the decision still to be recorded.
* The worktree `agent-ad32397fa8ffa8fb9` was set up by symlinking `node_modules`, `Deus Ex GOTY Edition`, `Reference` and the `.cache` entries (not `.cache/wasm`),
  copying `ad/build/*.exe` and `ad/tools/dxinput.exe`, and `npm run build:wasm` (no warnings seen in the log tail).

