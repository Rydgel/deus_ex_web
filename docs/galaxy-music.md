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
| [effects](galaxy-music/effects.md) | glxLoadSample's WAV loader and the sample voices (start, control, status, stop) |
| [reverb](galaxy-music/reverb.md) | Update's zone block, glxSetSampleReverb, the x87 setup and the SSE reverb kernel |
| [census](galaxy-music/census.txt) | IT header and sample flags of the 35 songs |

The reports were written from disassembly alone; claims marked *derived*
there still need the oracle runs listed below. The loader (it-loader) is now
verified against the original under Unicorn (see "Loader: implemented").
The mixer's SSE kernel, conversion and renderer are verified too (see
"Phase 3 status", and mixer.md §8), and so is the sequencer (see "Phase 2
status": every song from sections 0..5 plus synthetic cases, tick by tick).
The Update music section is translated and verified (see "Phase 4").

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

## Loader: implemented (2026-10-02)

`glxLoadMusic`'s IT branch runs in Rust (`native/galaxy-kernel`, built to
`src/runtime/galaxy-kernel.wasm`, JS bridge `src/runtime/galaxy-music-loader.mjs`).
The kernel owns Galaxy's song state as the DLL lays it out: the song scalars,
name, orders, initial pan, the IT loader's statics `0x106841a8..0x10684e28`
(one block, so table overruns land where the original's do), the 256 voice
records (raw `0xa0`-byte layout, as the reset leaves them), and the
instrument/pattern slots in their original byte layouts. Translated:
the dispatcher `0x10618be0` (IT only), the reset `0x1060e850`, the memory
stream, the IT loader `0x10628990`, the sample loader `0x1062fb10` for every
Type an IT sample can carry, `glxUnloadMusic` `0x10619450`/`0x106195b0`, and
the glxInit state section plus `0x1060ebc0(EffectsChannels)` as the initial
state. Module bytes come from `src/unreal/music-module.mjs` (the Music
export's lazy array, exactly what Update hands over).

**Oracle.** `scripts/native-galaxy-music-oracle.py` runs the real
`glxLoadMusic(&Mem{'MEMO', 0xc, Data, size + 1024, 0}, 2)` under Unicorn,
after executing glxInit's state section (`0x1060dfff..0x1060e1b4`) and
`0x1060ebc0(16)` for real. Stubbed leaves only: Enter/LeaveCriticalSection,
MSVCRT malloc/realloc (copy-on-grow)/free/memcpy/memset/memcmp, every call
logged. It dumps everything the player reads (format in the bridge) plus the
allocation log and the stream log (every seek/read/tell with its position),
so the parse order is compared, not asserted. Three passes: fresh with fill
0, fresh with fill `0xa5` and a different slack (to measure what the original
never initialises), and a chain where each song loads after the real
`glxUnloadMusic` of the previous one.

**Verification** (`scripts/validate-galaxy-music-loader.mjs`):

- All 35 songs byte-equal to the original, fresh (57,414,482 dump bytes) and
  chained (57,431,867). The chain differs from fresh only where the original
  carries state: the order table tail, the loader statics, and the unload's
  frees.
- 9 synthetic IT modules (`scripts/galaxy-music-synthetic.mjs`) for the
  branches the songs never reach: every effect letter and S sub-command,
  A00/K00/L00 recall, E/F extra-fine slides, note cut/off and raw notes,
  volume-column values above 64 reused through mask `0x40`, channels ≥ 32,
  unsigned 8/16-bit samples, LoopEnd > Length, empty loops, loops shorter than
  the padding, Vol 128 (stores 0) and 200, pan clamps, a non-`IMPS` sample,
  instrument mode (key remap, all envelope clamps, the PitFlag quirk, a bad
  `IMPI`, Length-0 and non-`IMPS` samples, fade `0x800` wrapping to 0),
  OrdNum 0 / 300 / past the file, truncation into the slack and past it
  (status `0x10` with the original's partial state), bad sample offsets.
  All equal, 436,279 bytes.
- Instruction coverage of the original loader functions: 2318 of 2616
  (songs alone 2173). The 25 unreached runs are listed with reasons in the
  validator: out-of-memory returns (not modeled), two dead clamps (`movsx`
  GV, pitch nodes), non-IT formats and the stdio stream (kernel:
  `UNSUPPORTED_FORMAT`), stereo/delta conversion (the IT loader never sets
  Type `0x40`/`0x01`; kernel: `UNSUPPORTED_CODING`), seek whence 2, the
  sample-loader Volume clamp (the IT conversion pre-clamps), and the
  "already loaded" / "music playing" gates (translated; reached only with
  the player).
- 8 mutants all caught: no fade-in, 30-frame padding, D fine slides swapped,
  note cut keeping its volume, effect memory reset per pattern (changes 27
  patterns' events), order tail cleared (chain only), S9x untranslated
  (songs); the Volume clamp done on the dword (synthetic only: no song has
  Vol > 64).
- Hazard flags match what the oracle measured: slack reads, short reads,
  uninitialised instrument records, never-written sample tails.

**Answers.**

- *Slack:* no read of any of the 35 songs reaches the 1024 bytes Update
  appends, and every dump is identical under a different slack. The slack
  is only read for a truncated module (synthetic case: the last sample's
  data then comes from uninitialised memory; kernel `HAZARD_SLACK_READ`).
  Separately, 24 of the 35 songs' Data end with 1024 zero bytes the loader
  never reads (the other 11 end at the last sample's data).
- *Uninitialised output:* the only fill-dependent bytes for the songs are
  972 bytes in 119 looped samples: the allocation tail
  `[max(LoopEnd+31, Length), Length+31)` frames, which the padding never
  writes. The kernel zero-fills them; whether the mixer can read them is a
  mixer question (phase 3).
- *NULL patterns:* 25 songs have orders whose pattern stays NULL (empty IT
  pattern or index ≥ PatNum), e.g. order 2 in 21 songs. Which slots stay
  NULL is now proven; how the player steps over them is phase 2.
- *GV:* the loader stores the header GV (`0x80` for every song; the clamp
  cannot fire) into `0x10697cf0`, which is the music master volume of
  `glxSetMusicVolume` `0x1060eb60`. Derived from Update's call order (not
  from this oracle): SetVolumes at `0x1060a810` overwrites it right after
  the load when UseDigitalMusic.
- *Converter memory:* the six `[64]` arrays and the offset tables are
  referenced by no code but the IT loader (xref scan), so the player never
  reads them; they persist between loads and the chain proves the stale
  parts never change a song's output.
- *Faults of the original:* a pattern header read from zero slack (Rows 0)
  makes the converter write past its `0xc101`-byte block; the original
  crashes. The kernel stops with `UNSUPPORTED_PATTERN` there, and with an
  `UNSUPPORTED_*` status wherever the original would leave an allocation.

**Phase 2 inputs.** The sequencer reads, from the kernel: the voice records
as the reset leaves them (music voices from `0x1068828d` = 16), the order list,
`0x1069834a` (base-zero song length), `0x10698348` (channel count),
speed/tempo (`0x10697cea`/`0x1069817e` and the reset's `0x10698342`/`0x10698188`),
the player mode `0x10697ce8`, the period limits, initial pan, the pattern
event streams (format: it-loader §4.6) and the instrument/sample records with
their padded data. The kernel does not yet expose typed accessors; phase 2
adds them next to the sequencer translation.

## Phase 2 status (sequencer, verified 2026-10-06)

The module player in `native/galaxy-kernel/src/sequencer.rs` (mixer entry up
to the inner kernel, voice update with envelopes, sequencer tick, IT
handler, note delay, ramps, period to step, glxStop/Start/ControlMusic,
glxSetMusic/SampleVolume, glxInit's and the output open's tails) and the pan
table model in `x87.rs` equal the original, tick by tick, on every case run.
Details and the claims each case settles: [sequencer.md](galaxy-music/sequencer.md)
(tags *verified by X*, §14).

**Oracle.** `scripts/native-galaxy-music-sequencer-oracle.py` runs the
original player under Unicorn (glxInit's tail, glxSetCallback, the output
open's tail, then the case's library calls and 882-frame timer callbacks;
the inner kernel is a recording stub). The trace per tick group holds the
globals, the music voice records, the 14 kernel arguments and the refill
posts; one 8-byte SHA-256 digest per group. Cases are cached per case and
run over up to four processes. A fault of the original ends a case and is
located: a mixer call that never returns, an emulator error, or (synthetic
cases) a heap read outside every live block.

**Validator** `scripts/validate-galaxy-music-sequencer.mjs`: the Rust
kernel replays each case through the `galaxy_seq_*` exports with the
oracle's callback counts and must give the same digests; a mismatch is
decoded field by field from both traces.

- 238 cases, 1,833,842 ticks in 1,412,462 callbacks, all equal:
  - the 35 songs from sections 0..5, each until its first wrap or backward
    jump plus 64 ticks (no song has fewer than 6 orders);
  - UNATCO switching from section 0 to 3 after 400 callbacks, Intro switching
    to section 200 (glxControlMusic returns 0x11, the break still ends the
    pattern), Title → unload → Intro, Title → unload → Endgame1 section 4;
  - MUSICORDER 5, −1, −20, 100 and 0 on Intro (glxControlMusic cmd 1, the
    console's only music command); loop flag 0 (cmd 3, no DX caller);
  - counter phases: voice update first (Intro), tick first (Endgame1), both
    in one chunk (Lebedev);
  - the 9 phase-1 synthetic modules and 9 sequencer modules
    (`sequencerModules()` in `scripts/galaxy-music-synthetic.mjs`): every
    effect the songs never play, Amiga slides, envelopes, order/row edges,
    and the Linear module at music master 127.
- Three cases end at an original fault, each matched by the kernel's
  UNSUPPORTED_* stop in the same callback: every order skipped
  (Sequencer_AllSkipped, Synthetic_OrdersPastEnd: the order walk spins,
  UNSUPPORTED_SPIN) and a break past the pattern's end
  (Sequencer_BreakPastEnd: the row skip reads past its events,
  UNSUPPORTED_READ).
- Tables: the Rust pan table equals Unicorn's glxInit loop at PC 64, 53 and
  24 (PC 53 differs from PC 64 at 1 entry, PC 24 at 54); the generated
  .rdata block (LFO, Amiga, linear, arpeggio, finetune; 1112 dwords) equals
  the DLL's.
- Coverage of the original player functions: 2436 of 2680
  instructions; the 35 unreached runs are listed in the validator with a
  reason each (MIDI player mode, effects-voice paths, DX calling the volume
  setters with rate 0, Galaxy commands no IT effect produces, dead code).
- Mutants 101..109: 8 caught; 105 (pan slew ±0x100) is equivalent for
  music, since every music pan write sets current and target together and
  the slew run never executes (coverage).
- With master's mixer merged, the same replay also runs the real SSE kernel
  (`mix_kernel`) on all 238 cases without a fault; its PCM is not
  compared here (phase 3's `validate-galaxy-mixer.mjs` does that).

**Settled by the oracle** (were *derived*): the pattern-end extra pass;
null patterns skipped in the same tick; a section > 0 start keeps speed 48 /
tempo 120 and the previous song's tick period (Endgame1 from section 4 plays
its first order at 48 ticks per row: 459.375-frame ticks fresh, 950.431
after Title); key off stopping a sample-mode voice at the next voice update;
loop flag 0; SBx on a pattern's last row rearming itself; a first note
delayed by EDx mixed through the effects path at volume 0.

**Kernel additions.** Mutant 102 (no pattern-end pass) is implemented;
`galaxy_seq_control(cmd, arg)` and `galaxy_seq_callback_count()` are new
exports (additive).

**Open.** The game's counter phases and x87 PC at glxInit stay host
questions; which sections the game requests is Update's (agent A).

**Rerun.**

```
cargo build --manifest-path native/galaxy-kernel/Cargo.toml --locked --release \
  --target wasm32-unknown-unknown --target-dir .work/wasm-target
cp .work/wasm-target/wasm32-unknown-unknown/release/galaxy_kernel.wasm src/runtime/galaxy-kernel.wasm
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-galaxy-music-sequencer.mjs \
  [--jobs N] [--cases REGEX] [--no-mutants] [--refresh]
```

The oracle cache is `.cache/galaxy-music/sequencer-corpus` (keyed by the
oracle and loader scripts, the DLL, each program and module); a cold run
takes about 20 minutes with four oracle processes of about 1.2 GB each; a
cached run about 5 minutes (310 s on the Linux host; replay with the real SSE
kernel, coverage, mutants). The cache lives in the checkout's `.cache`, so a
worktree without `.cache/galaxy-music` runs cold: link it, or expect 20 to 24
minutes (the recorded oracle seconds sum to 4561, 1141 on four processes).
The validator header declares `runner-timeout: 2400`, which
`run-validators.mjs` honours (the limit is the largest of that, ten minutes
and four times the recorded time), so a cold run in a sweep is not killed at
the default ten minutes.

## Phase 3 status (mixer, 2026-10-06)

The module player now produces PCM. `native/galaxy-kernel/src/mixer.rs`
translates three original routines and wires them into the sequencer's mixer
entry. Details, evidence and findings are in
[mixer.md §8](galaxy-music/mixer.md).

* **Translated:**
  * the SSE mixing kernel (template 0x10622730);
  * the SSE conversion (template 0x10622fe4): the 16-bit store for bus A and
    the saturating add for bus B;
  * the renderer 0x106146a0.

  The sequencer's `mix_voice` calls the kernel after its K record, and
  `mix` zeroes the six buses.

**Bit-exact** against the original running under Unicorn
(`native-galaxy-music-sequencer-oracle.py --real-kernel`):

* 11 song cases. In each, the sequencer trace, both buses' int16 PCM per
  20 ms callback, the six float32 buses of the first 8 callbacks, and the
  browser path `galaxy_render` are all equal. The cases are:
  * Intro section 0, 2000 callbacks;
  * Intro at another counter phase;
  * Title, UNATCO, HongKong, Lebedev, Endgame1 and Area51;
  * NavalBase, OceanLab2 and Quotes.
* 17 fabricated programs (1198 groups). They make direct kernel and
  conversion calls and run the renderer on synthetic voices. They cover the
  edges listed in mixer.md §7A: 8- and 16-bit samples, the steps listed
  there, counts 0..9 and 511..513 at odd bus offsets, the pans, `v = 0`,
  saturation, denormals and conversions out of range.

**Also checked:**

* The same kernel and conversion programs give byte-identical results on the
  host CPU, running the original templates natively. So Unicorn's SSE/MMX
  arithmetic is exact for this code.
* Coverage: kernel template 443 of 443 instructions.
* Mutants 201–204 are caught.

**New original behaviour found and modelled:**

* **Negative run counts** (Quotes): the bus pointers move back, and the next
  run writes over the neighbouring buses.
* **Reads 1–2 bytes before a sample** (NavalBase, OceanLab2, Area51, MJ12):
  the `step & ~1` drift on the backward pass of a ping-pong loop that starts
  at frame 0.

Both are bit-equal to the oracle and flagged as hazards. The game's values
depend on its heap, which is unmeasured. No read of the loader's
never-written sample tails was seen.

**Interface** (the browser host builds on these):

* `galaxy_render(frames: u32) -> *const i16` returns 2·frames interleaved
  int16 samples, or 0 on a fault.
* `galaxy_fault() -> u32` gives the fault code.
* `Library::render(&mut self, frames: i32, out: &mut [i16]) -> Result<i32, u32>`
  is the Rust form.

Call order: `galaxy_reset(16)`, `galaxy_seq_setup(pc)`, load, start, then
`galaxy_render(882)` once per 20 ms of output, buffered. The output depends on
where mixer calls start, so a different request size gives a different (not
the original's) schedule. `galaxy_render` takes 81–110 µs (median) per call in
Wasm and does not allocate.

**Open:**

* the timer thread's MXCSR (0x1f80 assumed);
* the music/effects bus placement, about 1 s apart (mixer.md §1.3);
* heap adjacency and contents behind the two hazards;
* ~~bus B and the reverb, which are not used by the browser~~ (wired
  2026-10-06, [effects](galaxy-music/effects.md), [reverb](galaxy-music/reverb.md));
* the other songs and sections: their sequencer traces are now verified
  (Phase 2, all 35 songs × sections 0..5, with the real kernel running in
  the replay without a fault), but their PCM is not compared with the
  oracle. `validate-galaxy-mixer.mjs --sweep` runs every song and section on
  the Rust kernel alone and finds no fault.

**Rerun:**

```
cargo build --manifest-path native/galaxy-kernel/Cargo.toml --locked --release \
  --target wasm32-unknown-unknown --target-dir .work/wasm-target
cp .work/wasm-target/wasm32-unknown-unknown/release/galaxy_kernel.wasm src/runtime/galaxy-kernel.wasm
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-galaxy-mixer.mjs [--refresh] [--sweep]
```

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
  the sqrt pan table (at PC 53 it equals plain doubles). Measured in phase 4:
  SetVolumes' sample volume is 126 under 0x037f and 127 under 0x027f/0x007f
  at the installed volumes, and 0x007f rounds Update's dt to 24 bits.
- The music bus delay (about 1 s) needs a loopback recording.
- Answered by the sequencer oracle (Phase 2): NULL patterns are skipped in
  the same tick; a section > 0 start keeps speed 48 / tempo 120 and the
  previous song's tick period; the pattern-end pass repeats the ending row's
  tick-0 effects; key off stops a sample-mode voice at the next voice update.
  (Answered by the loader oracle: the 1024-byte slack is never read for the
  35 songs; GV `0x80` lands in the music master byte, which SetVolumes
  overwrites.)
- Whether the mixer can read the never-written tail of a looped sample's
  allocation (972 bytes over 119 DX samples). No read was seen in the
  `--sweep` run of 1157 sections × 30 s on the Rust kernel, which flags any
  such read. This is a sweep, not a proof.
- The heap memory the kernel reads 1–2 bytes before a sample, and the
  adjacency of the GlobalAlloc blocks that Quotes' negative run counts write
  into (mixer.md §8.3).
- The timer thread's MXCSR (0x1f80 assumed).
- Counter phases are free-running from library init.

## Plan

1. **Loader oracle** (Unicorn over Galaxy.dll, reusing
   `scripts/native-galaxy-audio-oracle.py`'s mapping): run `glxLoadMusic`
   on each song's bytes, dump the song globals, samples (with padding and
   fade-in), patterns and the parameter memory. Translate the loader in
   Rust and compare all 35 songs. **Done** (see "Loader: implemented").
2. **Sequencer oracle:** after the start sequence, call the mixer with a
   fixed request schedule and record the 14 inner-mixer arguments and the
   voice records per tick (Intro from section 0 first, then the edge cases
   listed in the sequencer report). Translate in Rust. **Done** (see
   "Phase 2 status").
3. **Mixer oracle:** install the SSE kernel (`0x10614080(7)`), mix
   fabricated and real voices for N blocks and compare PCM bit-exactly.
   **Done** (see "Phase 3 status").
4. **Subsystem:** the Update music transition and SetVolumes on the shared
   x87 model, fed by the PlayerPawn fields from Play's scripts.
   **Done** (see "Phase 4").
5. **Output:** the Rust mixer in an AudioWorklet (Wasm) at 44.1 kHz; speech
   and effects stay on Web Audio until the effects path is translated (the
   original mixes them in the same pool, which a later step should follow).
   **Host done** (see "Phase 5: Output"); audible once the PCM kernel
   replaces the temporary `galaxy_render`.

## Phase 4: Subsystem music section (2026-10-06)

Play's scripts now drive the library. Each Galaxy Update runs the original's
music section on the PlayerPawn fields that PostLogin's `ClientSetMusic`,
`MusicEvent` and `DeusExPlayer.UpdateDynamicMusic` write. It loads, fades,
restarts and unregisters songs through the library service object, and
writes the library's order position back into SongSection. The details,
evidence and case list are in
[update-transition.md §10](galaxy-music/update-transition.md).

**Files.**

- `src/runtime/galaxy-music.mjs`: `createGalaxyMusic(config, services)`
  returns `{state, update(dt, actor), setVolumes(), setInstantMusicVolume(byte),
  unregisterMusic(song)}`. It translates:
  - Update `0x1060a50b..0x1060aa15`;
  - SetVolumes `0x106061b0`;
  - SetInstantMusicVolume `0x10606610`;
  - UnregisterMusic `0x10606e60`;
  - the UMusic Data lifecycle: Engine's lazy Load `0x1030cbb0` and Unload
    `0x1030cd90`, and `Data.Add(1024)`.

  `state` holds `+0x888` (current), `+0x88c`, `+0x88d` and `+0x900`
  (MusicFade). `config.precision` (64, 53 or 24) is the x87 precision
  control. Play uses 64, which is what galaxy-audio.mjs assumes.
- `src/runtime/galaxy-music-objects.mjs`: the UMusic behind a
  `PlayerPawn.Song` reference, which is either a map's LevelInfo.Song import
  (the resource registry's export reference) or a DynamicLoadObject load-graph
  object.
- `src/runtime/galaxy-music-library.mjs`, first section:
  `createMirrorMusicLibrary()`, a recording host stand-in with no loader
  and no sequencer. The host transport is the second section.
- `galaxy-audio.mjs`: Update takes `services.library`'s `lock()` after the
  viewport test and releases it at the end. It calls `services.music.update`
  after the channel loop.
- `script-audio-live.mjs`: `createLiveAudio({..., library})`, which defaults
  to the mirror. It reads the four fields from the viewport actor, gives
  `dispose()`, and shares the subsystem's volume bytes with natives 268–270
  (`galaxy-volumes.mjs`, `script-conplay-live.mjs`).

**Why JavaScript.** Update's body is JavaScript (galaxy-audio.mjs over the
BigInt x87 model), and this section sits inside it. In the steady state
(Transition 0) it reads one field, calls `library.order()` once and writes
one byte: about 0.1 µs per frame, with no allocation and no BigInt work. The
x87 work runs only while a transition is pending. Measured headless:

| | Median | Notes |
| --- | --- | --- |
| Steady state, microbenchmark (lock, update, unlock) | 98–132 ns | per frame |
| Steady state, in place | 3–5 µs | includes the timing wrapper's own field read and clock calls |
| Transition frames | 29–38 µs | the load frame is the maximum, 1.6–1.9 ms: it copies 1.4–1.8 MB of module into the grown Data buffer, once per song load |
| Whole Galaxy Update, with / without the section (interleaved) | 308–314 / 306–312 µs (00_Intro), 821–863 / 834–849 µs (Island) | within noise; the sign flips between runs |

**Verified against the original** (`validate-galaxy-music-update.mjs`):

- 718 cases, 37,496 ops and 32,471 Update frames; every op's events and
  state are equal.
- **Tier 1** has recording glx leaves and covers:
  - Transition 0..6 × Latency 10/40/250 × the six case families;
  - the control words 0x037f, 0x027f and 0x007f, replayed at 64, 53 and 24
    bits;
  - fade-edge, song-flip, failure, large-dt, Destroy, CdTrack, SetVolumes and
    SetInstantMusicVolume cases.
- **Tier 2** runs the real library with DX songs and checks the mirror's
  results and modelled bytes after every op.
- The original's code paths are covered except the CD audio calls, the
  exception handlers and the appFailAssert tails.

**Findings.**

- **SetVolumes' sample volume** at the installed volumes (204/255) is 126
  under 0x037f and 127 under 0x027f or 0x007f. SpeechVolume·(1/255) stays in
  a register, and at 64 bits it is just below 1.
- **Under 0x007f** the prologue's dt is rounded to 24 bits, so fades end on a
  different frame in 13 of 243 scenarios.
- **Under 0x027f** only one fade-edge case ends on a different frame.
- **The game thread's control word is still open**: it decides the ±1 above.

**Play** (`validate-galaxy-music-play.mjs`, headless, one map per process):

- **00_Intro.** The first painted frame issues one batch that loads
  Intro_Music (1,843,231 + 1024 bytes) and starts section 0, with no fade.
  - SongSection then follows `order()`. It is 0xff with the mirror, which has
    no sequencer.
  - Player start issues no library op. The new PostLogin fades for 65 frames
    (the first has dt 0: the reset restarts the clock) and restarts the
    section on the loaded module, with no unload or load.
  - `dispose()` issues glxStopMusic and glxUnloadMusic.
- **00_Training** goes through the browser host's proxy (createGame's
  `musicLibrary`). The first frame posts one encoded load+start batch with
  Training_Music's bytes plus slack, and `dispose()` posts the unregister.
  Credits_Music by DynamicLoadObject, as CreditsScrollWindow loads it, then
  the level song, then the credits again: each switch is one batch, and the
  last reloads the emptied graph UMusic through its linker archive.
- **01_NYC_UNATCOIsland.** UpdateDynamicMusic's MeetPaul switch
  (`ClientSetMusic(Level.Song, 4, 255, MTRAN_Fade)`, tick 1871) fades for 64
  frames, then restarts section 4 on the loaded module.

**State digests.**

- bench-sim's digests do not change, because bench-sim never paints the HUD,
  so Galaxy Update does not run.
- Play's state digest (`state-digest.mjs`, the page and the worker) changes
  after the first painted frame. A field diff of 00_Intro after 300 frames
  against a run with the section disabled shows exactly two changed fields:
  the player's Transition (3 → 0) and SongSection (0 → 255).
- validate-sim-split compares two pages of one build, so it is unaffected.

**Not verified or open.**

- Which x87 control word the game thread uses (§8.1 of
  update-transition.md).
- The mirror cannot know a song's length, so it counts a glxControlMusic
  position above 0 as uncertain. The host's proxy has the same limit until a
  report arrives.
- A same-song map change keeps the UMusic in the original and fades. Play
  builds a fresh runtime per map, and `dispose()` unregisters it, so the next
  map reloads the song without a fade.
- The DynamicLoadObject route (credits, PlayMusicWindow) is checked by
  calling DynamicLoadObject from the validator, not yet by those windows in a
  map.
- The CD branch is refused (`UseCDMusic=True` throws). The installed config
  has it False.

**Rerun.**

```
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-galaxy-music-update.mjs [--reuse]
node scripts/validate-galaxy-music-play.mjs [--map 00_Intro|00_Training|01_NYC_UNATCOIsland]
```

## Phase 5: Output (browser host, 2026-10-06)

Play's music is the library itself: the Rust kernel runs in an AudioWorklet
and plays bus A. Since 2026-10-06 its effect voices play there too, on bus
B with the zone reverb ([galaxy-audio](galaxy-audio.md) "Effects through
Galaxy's mixer"; `?sfx=webaudio` keeps the Web Audio mapping `galaxyVoice`).
Conversation speech keeps its own transport (`playConversationSpeech`).

**Threads.** The original mixes on a winmm timer thread (§1.3 of
[mixer](galaxy-music/mixer.md)) and the game thread's Update calls glx*
under the same lock. In the browser:

| Original | Browser |
| --- | --- |
| library state (glxInit, voices, song) | the worklet's kernel instance (`src/viewer/galaxy-music-worklet.mjs`) |
| timer callback 0x106142a0, every 20 ms | a callback of exactly 882 frames whenever the worklet's ring holds less than one 128-frame quantum |
| mixer calls of n = remaining frames (≤ 512) | the same: `galaxy_render(882)` re-pins `ahead` and runs the mixer entry until the callback is rendered |
| Update's glx* calls under the lock | one batch per critical section, from the simulation's `library` service |
| Update's read of `[0x10698201]` | `library.order()` (below) |

**Files.**

- `native/galaxy-kernel/src/host.rs`: one thin export per library call:
  `galaxy_host_open(effectsChannels, pc, ahead)` (glxInit's state, Init's
  0x1060ebc0, the output open), `galaxy_music_load(len)` (glxLoadMusic
  without the validators' dump), `galaxy_music_unload/stop/start()`,
  `galaxy_music_control(cmd, arg)`, `galaxy_music_clear_active(first,
  count)` (Update's voice +0x0f stores), `galaxy_music_break()` (Update's
  `[0x10697ca8] = 1`), `galaxy_music_order()`, `galaxy_music_state()`,
  `galaxy_set_music_volume/galaxy_set_sample_volume(v, mode)`. Until the
  mixer agent's PCM kernel lands, a block marked `TEMPORARY` provides
  `galaxy_render(frames) -> *const i16` and `galaxy_fault()`: the
  sequencer, voice update and per-voice hand-off run for real, and the PCM
  is silence.
- `src/runtime/galaxy-music-library.mjs` (the transport section):
  `createMusicLibraryProxy(post)`, `connectMusicLibraryPort(port)`,
  `encodeMusicBatch`, `MUSIC_OP`, `MUSIC_SLACK`, and `driveMusicLibrary`
  (validation only: Update's first-music call order for a song and section).
- `src/viewer/galaxy-music-worklet.mjs`: the processor `galaxy-music`.
- `src/viewer/galaxy-music-output.mjs`: the page's part (node, channels,
  status).

**Batches.** The proxy turns each call into an op `[code, a, b]`; the ops
between `lock()` and `unlock()` (nested locks count, as the critical
section is recursive) cross as one batch, a call outside a lock as a batch
of one, an empty critical section as nothing. A batch is an Int32Array plus
the module buffers, transferred, so a module's bytes cross once. The worklet
applies a batch whole when it arrives, which is always between two
callbacks: the same atomicity Update has against the timer callback.

**Channels.** Nothing about music crosses the page per frame. The page
creates one MessageChannel per simulation side and hands one port to the
worklet node and the other to the simulation: the worker (`{type: 'music',
port}`, sim-worker.mjs), or the page's own library with `?sim=inline`.
The library service lives as long as its simulation side (the worker, or
the page), across map loads, as the original's library lives as long as the
subsystem. A new simulation side (new game files, hence a new worker)
reopens the library in the worklet.

**Order read-back.** After applying a batch, and after a callback that
changed it, the worklet posts `{type: 'report', batch, state}` to the
simulation (`state` = order | playing << 8 | song length << 16 | loaded <<
24). `order()` returns the reported order when the report covers every
batch the simulation issued; otherwise it replays the unacknowledged ops
that touch the order over the reported state: glxLoadMusic's reset seeds
0xff (when nothing is loaded or playing), glxControlMusic 1|2 stores
value − 1 (relative values add order + 2; a position past the reported song
length is refused, as the original's 0x11). Two assumptions are labelled in
the code: a pending load is taken to succeed, and a control after a pending
load is taken to be in range (the song length is not known yet). Sequencer
progress between reports is not modelled. This is host timing: in the
original the mixer thread also advances the order asynchronously to
Update's read.

**Startup and lifetime.**

- The context is the page's AudioContext created at `{sampleRate: 44100}`
  (the installed OutputRate) on the first gesture (any pointerdown or
  keydown when music is on); the Web Audio voices and speech share it. The
  worklet refuses any other rate.
- The page fetches `galaxy-kernel.wasm` and posts the bytes; the worklet
  compiles them (some worklet scopes have no fetch). Batches that arrive
  first wait in the worklet until the library is open.
- `galaxy_host_open(EffectsChannels, 64, 172872)`: EffectsChannels from
  DeusEx.ini (16, clamped to 0..32 as Init does); pan table built at x87
  precision control 64 (the sequencer oracle's 0x037f; open question
  above); the ring fill `ahead` (0x10697cdc) pinned to 176400 − 882·4 bytes
  before every callback. The mixer only tests `ahead` against 0, so any
  nonzero pin renders the same; glxControlMusic(1)'s ring flush
  (`ahead = 0`) has nothing to flush here and the next callback re-pins it.
- Map change: `createSimHost` takes `musicLibrary` and passes it through
  `createGame` and `createScriptDoors` to `createLiveAudio({library})`.
  `disposeAudio()` (also run by `dispose()`) calls the live audio's
  `dispose()`, which issues UnregisterMusic; the worker disposes the old
  host before building the next, and the page (`?sim=inline`) calls
  `disposeAudio()` before building the next host, so that batch reaches the
  worklet before any of the next map's. On the page, a map load that fails
  after this point leaves the old map running without its music
  registration (host limitation).
- `?music=0`: no worklet and no channel; `createLiveAudio` gets no library
  (the headless mirror).

**Output.** Bus A as the store path converts it to int16 (the PCM kernel's
contract), played as float = int16 / 32768, stereo, interleaved left, right.
The ring holds at most 882 + 127 frames (about 23 ms). Underruns count the
quanta played as silence while the library is open (only a fault can cause
one in this pull schedule); audio device glitches are not visible to the
worklet. No volume control exists in the viewer.

**Host timing, not the original's.**

- The callback schedule is fixed (882 frames back to back); the original's
  play-cursor jitter and the request lengths it causes are not reproduced.
- A batch takes effect at the next callback, about 0 to 23 ms of output
  later; in the original, Update's changes reach the next timer callback.
- The original writes music about one ring (1 s) behind the play cursor
  (§1.3, derived and unmeasured); the browser plays it within one callback.
- The counters (0x10698204, 0x1069834c) run free from the library's open,
  as in the original, so a song's first tick phase depends on when it
  starts.

**Status.** `deusExViewer.status().music`: `{enabled, error, context,
output: {running, error, worklet}, library}`, with the worklet's counters
(`open`, `connects`, `batches`, `ops`, `loads`, `callbacks`, `quanta`,
`underruns`, `reports`, `fault`, `error`, `state`, the last load/control
results) and the simulation's (`issued`, `acknowledged`, `order`,
`reportedOrder`, `reports`, module bytes; in the worker they ride the
game status the snapshot already carries every 15th frame).
`deusExViewer.musicStatus()` returns fresh copies; `deusExViewer.musicDrive({song, section} |
{unregister: true})` issues Update's library calls (validation).

**Verification** (`scripts/validate-galaxy-music-host.mjs`, Linux host,
headless Chromium with `--use-angle=gl`). These are host checks; the
translated entries themselves are verified by the loader and sequencer
validators.

- Node: the batch encoding round-trips through structured clone into the
  worklet's decoder (11 ops, 3 modules; whole-buffer modules transferred,
  views copied). The proxy makes one batch per critical section (nested
  locks, empty sections send nothing), and its order mirror and reports
  behave as described above. The worklet processor runs under Node with
  Intro_Music section 0 driven through the proxy: 701 callbacks from 4824
  quanta, the order at 0, 1, 2 at callbacks 1, 314, 628, and the proxy's
  `order()` equal to the library's.
- Host path against the oracle-verified path: `galaxy_host_open` plus the
  per-op exports and `galaxy_render(882)` give the same sequencer trace
  (U/T/K/P/E records, 66,952 over 2000 Intro_Music callbacks) as
  `galaxy_seq_setup/load/start/callbacks` with the same counters and ring
  pin. Leaving out the `setBreakFlag` op changes the digest.
- Browser, `?sim=worker` and `?sim=inline`, 00_Training: after a gesture
  the worklet opens the library. A driven Intro_Music start (1,844,255
  bytes with the slack) reaches order 1 after 6.5 s (313 callbacks of
  20 ms). The simulation's acknowledged count equals its issued count and
  its `order()` equals the library's. There are no underruns, faults or
  console errors. After a reload of the map the library is not reconnected,
  and an unregister plus a Training_Music start load and play.
  Since phase 4 the map's own Update drives this instead of `musicDrive`
  (2026-10-06): Training's first painted frame loads and starts
  Training_Music (1,450,961 bytes with the slack, one batch). The order
  reaches 1 after 8.2–8.3 s, and the simulation's issued and acknowledged
  counts and `order()` agree with the library. The map reload's
  `dispose()` unregisters the song, and the new runtime's first Update loads
  it again: 2 loads in 4 batches, no reconnect, no underruns or faults.
  This holds in both modes.
- Main-thread frame time (`framePhases` total per animate(), Training,
  `?sim=worker`, Intro_Music playing against `?music=0`, interleaved pairs
  of 300 frames): 9.89 / 10.12 ms with music, 10.18 / 11.13 ms without
  (medians 10.01 and 10.66). An earlier 200-frame pair gave 10.08 against
  10.05. The difference is within run-to-run noise (other agents were
  running oracles on the machine). No underruns during the measurement.

**Not verified.** Firefox (no Playwright Firefox build here; the code uses
only AudioWorklet, MessagePort transfer, WebAssembly in the worklet and
`AudioContext({sampleRate})`, all supported there, but untested). Audible
output waits for the PCM kernel. Since phase 4 the Update translation drives
the library (`validate-galaxy-music-play.mjs` checks the proxy path headless
on 00_Training); `driveMusicLibrary` remains a validation driver.

