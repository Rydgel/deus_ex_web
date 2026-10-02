# Galaxy music (research, 2026-10-02)

Play plays no music. This note is the contract recovered for it, before any
implementation, from the hash-pinned GOTY `System/Galaxy.dll` (base
`0x10600000`), Engine.dll, the DX SDK headers (`GALAXY.H`, `EngineClasses.h`,
`UnAudio.h`) and the scripts. The detailed, address-anchored reports are:

| Report | Topic |
| --- | --- |
| [update-transition](galaxy-music/update-transition.md) | `UGalaxyAudioSubsystem::Update`'s music section, SetVolumes, UnregisterMusic, the library API, the script inputs, the 00_Intro sequence |
| [it-loader](galaxy-music/it-loader.md) | `glxLoadMusic` and the Impulse Tracker loader, in-memory layouts, effect translation |
| [sequencer](galaxy-music/sequencer.md) | tick timing, order list, row and effect processing, channel state to voice parameters |
| [mixer](galaxy-music/mixer.md) | the timer thread, voice pool, buses, SSE kernel, pan/volume, reverb, determinism |
| [census](galaxy-music/census.txt) | IT header and sample flags of the 35 songs |

The reports were written from disassembly alone; claims marked *derived*
there still need the oracle runs listed below. Nothing here is verified
against a running original yet beyond the existing `-log` output.

## Corrections to earlier notes (applied)

- `0x1060e840` is `EnterCriticalSection(0x1067b670)`, not a library tick;
  `0x10618920` leaves it. Update runs entirely under the Galaxy lock
  (`0x10609549`..`0x1060abd6`). [galaxy-audio](galaxy-audio.md) step 1 fixed.
- PlayerPawn: `+0x670` Song, **`+0x674` SongSection, `+0x675` CdTrack**,
  `+0x676` Transition (SDK header; `glxControlMusic(GLX_SETPOSITION2,
  ...SongSection)` assert string at `0x1064a34c`). galaxy-audio step 14 fixed.
- [galaxy-volumes](galaxy-volumes.md): `+0x40`/`+0x3c` are UseDigitalMusic /
  UseCDMusic, not a song handle. Fixed.
- `0x106300f4` is MSVCRT's `_ftol` import thunk.

## The music path

1. **Script inputs.** PostLogin's `ClientSetMusic(Level.Song, SongSection,
   CdTrack, Transition)` writes the four PlayerPawn bytes; DeusExPlayer's
   dynamic music (`UpdateDynamicMusic`) switches sections later. Play already
   runs these scripts; nothing reads the fields.
2. **Update (game thread, under the lock).** When Transition is set and the
   song or section differs, the current music fades: the fade factor `+0x900`
   drops by DeltaTime × 1 / 0.2 / 3 (Fade / SlowFade / FastFade) until below
   Latency × −0.002 / −0.0004 / −0.006 (about 1.08 / 5.08 / 0.41 s at
   Latency 40; the test reads the unrounded x87 value). A changed song is
   unregistered (glxStopMusic, glxUnloadMusic), the new UMusic's bytes are
   handed to `glxLoadMusic(&Mem{len = OriginalSize + 1024}, GLX_LOADFROMMEMORY)`
   (`0x10618be0`; `RegisterMusic` is `ret 4`), the UMusic's handle becomes −1
   and its byte array is emptied. Then SetVolumes (music volume
   `ftol(max(fade,0) · f32(MusicVolume/255) · 127)`, 76 at the installed 153),
   glxStopMusic, clear music voices, glxStartMusic, `glxControlMusic(2,
   SongSection)`, Transition = 0. Without a pending transition, Update copies
   the library's position back into SongSection each frame.
3. **Load.** The loader dispatches on the header (MIDI, MTM, FAR before
   `IMPM`); the IT loader (`0x10628990`) is integer-only, uses MSVCRT
   malloc, converts patterns once into Galaxy's own event stream, translates
   IT effects to Galaxy (MOD-style) commands with clamps and drops (speed
   > 0x20 clamped, S9x → pan 0xa4, Q loses its volume nibble, M/Y/V and the
   volume-column effects ignored), fills a per-channel parameter memory in
   order-list order (so D00/E00/F00 recall other effects' parameters), adds
   31 frames of padding after each sample and fades in each sample's first
   32 frames. Mix volume, channel volumes, sample global volume, vibrato and
   sustain loops are ignored. Empty patterns stay NULL.
4. **Mixing (winmm timer thread).** `timeSetEvent(Latency/2 = 20 ms)` calls
   `0x106142a0`, which locks, renders up to the DirectSound ring position in
   mixer calls of at most 512 frames (`0x10614920`), split further at tick
   boundaries. The mixer owns two free-running 16.16 counters: the voice
   update (portamento, vibrato, envelopes, period → step) and the sequencer
   tick (`P = 5·rate / (2·tempo)` samples). One 256-voice pool serves
   effects (first EffectsChannels = 16) and music. On SSE CPUs the kernel is
   the SSE one: linear interpolation with 15-bit weights, float32
   accumulation, round-to-nearest-even and 16-bit saturation; `UseFilter`
   has no effect there. Volume is a chain of Q15 factors; pan is equal-power
   from an x87-built sqrt table (ramped ±0x200 per chunk). Music voices go
   to a bus written just behind the play cursor, effects/speech to a bus
   saturating-added at write cursor + Latency, which would put music about
   1 s behind effects (derived, unmeasured). Reverb applies to effects only.

## Format contract (the 35 songs)

All Impulse Tracker 2.17 (`cwt 0x217`); no IT-compressed samples; 16-bit,
loops and ping-pong loops common. 34 are sample mode (`cmwt 0x100`);
`Lebedev_Music` uses instruments (`cmwt 0x200`); `Endgame1/2` use old
effects and Amiga slides (flags `0x13`), the rest linear slides (`0x09`).
Effects used: A B C D E F G H M O Q S T X Y; the volume column holds only
volumes. 00_Intro's `Intro_Music`: sample mode, 29 samples, 51 patterns,
speed 6, tempo 153, section 0.

## Determinism

Given the voice state, both counters and the sequence of mixer calls, the
output is deterministic and integer/SSE-exact. What the original does not
fix is the chunk schedule (timer jitter, cursor granularity, when a game-
thread change lands). A faithful port reproduces the mixer bit-exactly for
a chosen schedule: the browser will use the original's shape (20 ms
callbacks of 882 frames at 44.1 kHz, mixer calls of at most 512 frames, cut
at tick boundaries) on a fixed clock inside an AudioWorklet, and pin the two
counters' initial phases explicitly.

## Open questions (consolidated)

- x87 precision control at Galaxy Init and in Update (PC 53 vs 24, the D3D
  FPUSETUP question): the fade end frame, the ±1 of the music volume, and
  the sqrt pan table (at PC 53 it equals plain doubles).
- The music bus delay (about 1 s) needs a loopback recording.
- NULL patterns skipped rather than played as 64 empty rows; a section > 0
  start keeping speed 48 / tempo 120 and the previous song's tick period;
  the extra tick-0 pass at a pattern end; key-off and note-cut handling;
  global volume 0x80 read signed or unsigned; speed vs tempo for clamped
  Axx; the 1024-byte uninitialised slack after the module.
- Counter phases are free-running from library init.

## Plan

1. **Loader oracle** (Unicorn over Galaxy.dll, reusing
   `scripts/native-galaxy-audio-oracle.py`'s mapping): run `glxLoadMusic`
   on each song's bytes, dump the song globals, samples (with padding and
   fade-in), patterns and the parameter memory. Translate the loader in
   Rust and compare all 35 songs.
2. **Sequencer oracle:** after the start sequence, call the mixer with a
   fixed request schedule and record the 14 inner-mixer arguments and the
   voice records per tick (Intro from section 0 first, then the edge cases
   listed in the sequencer report). Translate in Rust.
3. **Mixer oracle:** install the SSE kernel (`0x10614080(7)`), mix
   fabricated and real voices for N blocks and compare PCM bit-exactly.
4. **Subsystem:** the Update music transition and SetVolumes on the shared
   x87 model, fed by the PlayerPawn fields from Play's scripts.
5. **Output:** the Rust mixer in an AudioWorklet (Wasm) at 44.1 kHz; speech
   and effects stay on Web Audio until the effects path is translated (the
   original mixes them in the same pool, which a later step should follow).
