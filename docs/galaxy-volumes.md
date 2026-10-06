# Galaxy instant volumes (natives 268–270)

`MissionIntro` and `MissionEndgame` turn the sound effects down for their
cinematic conversations: `FirstFrame` saves `SoundVolume`, sets 32 and calls
`Player.SetInstantSoundVolume(SoundVolume)`; `PreTravel` restores it.

## Engine side

`Actor.SetInstantSoundVolume/SpeechVolume/MusicVolume(byte)` (natives 268,
269, 270; Engine.dll exec `0x103e2850`, `0x103e28d0`, `0x103e2950`) read the
byte, step past `EX_EndFunctionParms`, and call
`XLevel->Engine->Audio` (`+0xac`, `+0x40`, `+0x4c`) at vtable `+0x90`, `+0x94`,
`+0x98` when the engine has an audio subsystem. In the game that is always
`UGalaxyAudioSubsystem` (`DeusEx.ini` `AudioDevice=Galaxy.GalaxyAudioSubsystem`;
Galaxy.dll `606e71d1…`, vtable `0x1063d0e4`).

## Galaxy side

| Slot | Method | Body |
| --- | --- | --- |
| `+0x90` | `SetInstantSoundVolume` | `0x106063d0` |
| `+0x94` | `SetInstantSpeechVolume` | `0x106064f0` |
| `+0x98` | `SetInstantMusicVolume` | `0x10606610` |

The subsystem's config bytes are `MusicVolume` `+0x69`, `SoundVolume` `+0x6a`
and `SpeechVolume` `+0x6b`. `K` is the double `1/255` at `0x1063d548`; the
float `127.0` is at `0x1063d530`.

- **Sound and speech.** `a = SoundVolume * K` stays in an 80-bit register
  (FILD, FMUL m64); `b = float32(SpeechVolume * K)` is stored to a temporary.
  `FCOM` keeps `b` when `a < b` (C0, unordered included), else `a`. That value
  times `127.0f` goes through Galaxy's own `_ftol` (truncation) into
  `0x1060ec00(volume, 0)`. For a volume in 0..127 with no fade it stores the
  digital master volume `0x1069817c` and the fade target `0x10697ce4`, sets
  the fade step `0x10697ca0` to 0 and returns 0. Only then is the argument
  stored: `+0x6a` for 268 (so `a` is the new sound byte, `b` the stored speech
  byte), `+0x6b` for 269 (`a` the stored sound byte, `b` the new speech byte).
  The digital volume is therefore the louder of sound and speech: the intro's
  `SetInstantSoundVolume(32)` leaves it at 127 with the installed
  `SpeechVolume=255`.
- **Music.** `float32(clamp(MusicVolume * K, 0, 1))`; with the
  UseDigitalMusic config flag (`+0x40`) it goes to `0x1060eb60` and with
  UseCDMusic (`+0x3c`) to `0x1060e9a0` (both `ftol(x * 127.0)`); then `+0x69`
  is the argument. (Earlier notes called `+0x40`/`+0x3c` a song handle; they
  are the config bools, see [galaxy-music](galaxy-music.md).)

## Translation

`src/runtime/galaxy-volumes.mjs` holds the three bytes and the digital
volume, computed on the shared x87 model. Play's ConPlay host
(`script-conplay-live.mjs`) creates it from `DeusEx.ini`
`[Galaxy.GalaxyAudioSubsystem]` (`appAtoi`, low byte, as
`UByteProperty::ImportText`; a missing key throws rather than guessing a
default) and handles natives 268–270 with it. It lives as long as the host,
across Player-start reloads, as the subsystem outlives levels.

In Play the three bytes belong to the live audio subsystem
(`script-audio-live.mjs` creates the volumes and ConPlay uses them): native
270 runs the SetInstantMusicVolume translation of galaxy-music.mjs
(glxSetMusicVolume with UseDigitalMusic, verified with both config flags in
validate-galaxy-music-update.mjs), 268/269 also send the digital volume to
the library as glxSetSampleVolume, and Update's category ratio and
SetVolumes read the live bytes. The browser still mixes speech with the
per-sound volume only, applying neither the subsystem bytes nor the digital
volume.

## Validation

`scripts/native-galaxy-volume-oracle.py` runs the three Galaxy bodies, Galaxy's
`_ftol` and its volume setters in Unicorn (critical sections are the only
leaves) for every pair of 16 byte values per native, and
`scripts/validate-galaxy-volumes.mjs` compares the bytes and the digital
volume, fade step and target with `galaxy-volumes.mjs`: 768 cases equal. Music
without a song leaves every Galaxy global untouched, as modeled.
