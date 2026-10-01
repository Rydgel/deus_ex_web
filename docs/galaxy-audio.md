# Galaxy audio subsystem (research, in progress)

Play plays only speech today (DataLink and conversations through Web Audio).
Sound effects, ambient sounds and music reach the engine's `PlaySound`
bookkeeping (channel ids, [script-sound](script-sound.md)) and the instant
volumes ([galaxy-volumes](galaxy-volumes.md)) but no browser voice. This note
records the original subsystem before any translation, following AGENTS.md.
Nothing here is implemented yet.

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
   squares sum in extended, the CRT `sqrt` (IAT `0x10699730`) takes the
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
   Otherwise, for an actor source and a listener that IsA APawn, a level line
   check (XLevel `+0x98`) runs from the source to the listener's eye
   (`Location + (0, 0, EyeHeight +0x3f8)`) — occlusion, still being read.

Constants: doubles `25.0` (`0x1063d788`), `1/64` (`0x1063d778`, SoundPitch
scale), `0.1` (`0x1063d768`), `1/π` (`0x1063d758`), `16383.0`
(`0x1063d748`), `1.0`, `0.0`, `1/255` (`0x1063d548`); floats `0.0`,
`28671.125` (`0x1063d764`), `127.0`. Imports: Core `appSqrt`, `appAtan2`,
`appSecondsSlow`, `appStricmp`, `UObject::IsValid`, `appFailAssert`; Engine
`APawn::PrivateStaticClass`.

Remaining: the rest of Update (occlusion result, Doppler if any, the Galaxy
voice start/update calls and their volume/pan/pitch units), StopSound,
StopSoundId, NoteDestroy, RegisterSound (sample decoding), music
(RegisterMusic, the tracker player) and the Galaxy library's mixer, then the
oracle cases and the Web Audio mapping.
