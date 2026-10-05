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
there still need the oracle runs listed below. The loader (it-loader) is now
verified against the original under Unicorn (see "Loader: implemented");
the sequencer, mixer and Update reports are not yet.

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

## Phase 2 status (sequencer, 2026-10-02, in progress)

**Done and verified.**

- Oracle `scripts/native-galaxy-music-sequencer-oracle.py` (subclasses the
  phase-1 loader oracle). Init runs from the DLL: glxInit's tail with the pan
  table (CPUID flags of the reference machine: MMX, SSE), glxSetCallback(DX's
  0x10601064), the output open's tail (44100 Hz, 16-bit stereo, flags 7:
  `0x10697cfc` = 0x47, MIDI-mode periods). Cases are JSON programs (load,
  start = Update 0x1060a822..0x1060a88d, pin counters, pinned ring fill, 882-frame
  callbacks). The inner kernel `[0x10698354]` is a recording `ret` stub (14
  args); trace records M/R/U/T/K/P/L/S/E, one 8-byte SHA-256 digest per tick
  group. Coverage uses self-deleting per-instruction hooks (no measurable cost).
- Measured: Unicorn 2.1.4 honours x87 PC; the pan table at PC 64 differs from
  PC 53 only at entry 0x7fff (32766 vs 32767), PC 24 at 54 entries. Intro
  first tick: order 0, speed 6, tempo 153, P = 720·65536 + 38550, first
  voice-update reload 0x2c1999 (1 ms, MIDI mode from the open), as derived.
- Rust translation `native/galaxy-kernel/src/sequencer.rs` (mixer entry
  without the PCM kernel, voice update with envelopes, sequencer tick, IT
  handler, note delay, ramps, period to step, stop/start/control/volumes,
  setup) and `x87.rs` (exact PC-parameterised pan table). The loader now
  replays the oracle's bump-heap addresses (`HEAP_BASE`) so voice records and
  pattern pointers compare raw; the phase-1 dump still writes MARK
  (`validate-galaxy-music-loader.mjs` passes unchanged).
- **Intro_Music section 0, counters pinned 0/0: 2449 ticks (2000 callbacks,
  40 s) bit-equal per tick to the original**, first attempt.

**Written but unverified.** Everything beyond that one case: the other 34
songs and sections, section > 0 starts, null-pattern skips, same-song section
switches, chained songs, other counter phases, the instrument envelopes
(Lebedev uses the pan envelope), Amiga mode (Endgame1/2), every effect not in
Intro, the generated .rdata tables (formula + the original's exceptions:
Amiga 110 = 382 and 117 = 255, finetune 7 = 34468) and the Rust pan table
against Unicorn's (only the oracle side was measured). No mutants run yet.

**Next step.** Write `scripts/validate-galaxy-music-sequencer.mjs`: build the
case list (every song × sections 0..5 run `until: loop`, margin 64; same-song
switch at ~500 ticks; Title→Intro chain; 2–3 counter phases; the phase-1
synthetic modules plus new ones for arpeggio, tremolo, K/L, S3/S4, SBx, SCx,
SEx, T<0x20, C row > 0, EDx ≥ speed, A00), run the oracle once into
`.cache/galaxy-music/sequencer` (~8 min for the whole corpus without
coverage cost), replay exact callback counts in Rust, compare digests, diff
the first 256 groups' full records on mismatch, check the pan tables (oracle
should dump PC 64/53/24 tables and the 1112-dword table block at
0x1063daa0), report coverage with reasons for unreached runs, and catch the
mutants defined in sequencer.rs (101..109). Then update sequencer.md.

**Rerun the checks.**

```
npm run build:wasm
node scripts/validate-galaxy-music-loader.mjs          # phase 1, unchanged
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python
$NATIVE_PROBE_PYTHON scripts/native-galaxy-music-sequencer-oracle.py "Deus Ex GOTY Edition" \
  .cache/galaxy-music/modules .work/music/phase2/cases-test2.json .work/music/phase2/out
node .work/music/phase2/smoke.mjs .work/music/phase2/out intro-long 2000   # expect ALL EQUAL
```

(`.work/music/phase2` also holds `dec.py`, a trace decoder, and `gdis.py`,
the disassembler used for the translation.)

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
- NULL patterns skipped rather than played as 64 empty rows (which slots
  are NULL is now proven, see the loader section); a section > 0 start
  keeping speed 48 / tempo 120 and the previous song's tick period; the
  extra tick-0 pass at a pattern end; key-off and note-cut handling; speed
  vs tempo for clamped Axx. (Answered by the loader oracle: the 1024-byte
  slack is never read for the 35 songs; GV `0x80` lands in the music master
  byte, which SetVolumes overwrites.)
- Whether the mixer can read the never-written tail of a looped sample's
  allocation (972 bytes over 119 DX samples).
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
   listed in the sequencer report). Translate in Rust.
3. **Mixer oracle:** install the SSE kernel (`0x10614080(7)`), mix
   fabricated and real voices for N blocks and compare PCM bit-exactly.
4. **Subsystem:** the Update music transition and SetVolumes on the shared
   x87 model, fed by the PlayerPawn fields from Play's scripts.
5. **Output:** the Rust mixer in an AudioWorklet (Wasm) at 44.1 kHz; speech
   and effects stay on Web Audio until the effects path is translated (the
   original mixes them in the same pool, which a later step should follow).

## Phase 5 handoff (browser output, WIP, 2026-10-05)

Paused mid-implementation at the user's request. Branch
`worktree-agent-aba9719feccacd206` (worktree
`.claude/worktrees/agent-aba9719feccacd206`).

**Done (committed, WIP).**

- `native/galaxy-kernel/src/host.rs` (`mod host;` in lib.rs): per-op exports
  `galaxy_host_open(effects_channels, pc, ahead)` (glxInit state, Init's
  0x1060ebc0, the output open at 44100/16-bit/stereo/flags 7, pinned ring
  fill), `galaxy_music_load(len)` (glxLoadMusic without the validator dump;
  input from `galaxy_input(len)` filled with module + 1024 slack),
  `galaxy_music_unload/stop/start()`, `galaxy_music_control(cmd, arg)`,
  `galaxy_music_clear_active(first, count)`, `galaxy_music_break()`,
  `galaxy_music_order()`, `galaxy_music_state()` (order | playing<<8 |
  songLength<<16 | loaded<<24), `galaxy_set_music_volume(v, mode)`,
  `galaxy_set_sample_volume(v, mode)`, and a block marked
  `// TEMPORARY: replaced by the mixer agent's galaxy_render` with
  `galaxy_render(frames) -> *const i16` (re-pins `ahead`, runs the mixer
  calls for real, returns silence; 0 on a fault) and `galaxy_fault()`.
- Node smoke check (not yet a validator): Intro_Music loads (status 0,
  2.3 ms), start sequence, 3000 × `galaxy_render(882)` in 13.7 ms; the order
  goes 0xff → 0 → 1 at callback 313 … 11 at 2882. `ahead` pin chosen:
  172872 bytes (176400 − 882·4, the steady-state fill at a render's start;
  only nonzero matters). Pan table PC: 64.
- `src/runtime/galaxy-music-library.mjs` (my section only, for merging with
  the Update agent's `createMirrorMusicLibrary`): `MUSIC_OP`, `MUSIC_SLACK`,
  `encodeMusicBatch(id, ops, {owned})` (Int32 [code, a, b] per op, module
  bytes transferred once), `createMusicLibraryProxy(post)` (the `library`
  interface; lock depth makes batches; ops outside lock are single-op
  batches; `order()` = reported order when no unacknowledged order-touching
  batch, else a replay of the pending ops over the reported state;
  `report(data)`, `status()`), `connectMusicLibraryPort(port)`,
  `driveMusicLibrary(library, assets, {song, section} | {unregister})`
  (validation driver: Update's first-music call order).

**Not done.**

1. The worklet `src/viewer/galaxy-music-worklet.mjs`, self-contained (no
   imports, so Vite's `new URL(..., import.meta.url)` asset copy works):
   export `forEachMusicOp`/`decodeMusicBatch` for the Node round-trip check;
   processor `galaxy-music`: page port messages `init {wasm}`,
   `connect {port, effectsChannels, pc, ahead}` (a new sim side: close the
   old port, drop its queued batches, `galaxy_host_open`), `status` (reply on
   demand only); sim port: `batch` applied on arrival (between callbacks;
   queued until the wasm is ready); `process()` renders 882-frame callbacks
   into a 2048-frame Float32 ring whenever it holds < 128 frames (int16 /
   32768), reuses the PCM view unless the memory buffer changed, posts
   `{type: 'report', batch, state}` to the sim port after a callback only
   when the applied batch or the state changed; underruns = quanta short of
   frames (only a fault or a not-yet-open library can cause them in this
   pull design); refuse to open unless `sampleRate === 44100`.
2. **Design change from the user (not yet implemented):** no batches or
   reports through the page. The page creates a `MessageChannel` per sim
   side; port2 goes to the sim worker (new worker message `{type: 'music',
   port}` → `connectMusicLibraryPort`, passed as `musicLibrary` to
   `createSimHost`), port1 to the worklet node (`connect`), queued until the
   node exists. ?sim=inline: the page keeps port2 and uses the proxy itself.
   The page only creates the context/node (on a gesture: one AudioContext
   `{sampleRate: 44100}` shared with the Web Audio voices, resumed by a
   document pointerdown/keydown listener), wires ports, and reads status.
   `?music=0` disables it (for the A/B).
3. Plumbing: sim-host option `musicLibrary` → createGame → createScriptDoors
   → `createLiveAudio({library})` (one line in script-doors.mjs, outside my
   files); sim-host `disposeAudio()` calling
   `runtime.audio?.dispose?.()`, called by `dispose()`, and by inline
   `loadMap` before the next host is created (the worker already disposes
   first); EffectsChannels from DeusEx.ini (clamp 0..32) sent with
   `connect`; `deusExViewer.status().music` (worklet status on demand, the
   sim's `library.status()` via `snapshot.status.music`);
   `deusExViewer.musicScript(args)` → worker `call('musicScript', args)`
   (sim-client `call(method, args)`).
4. `scripts/validate-galaxy-music-host.mjs`: Node round-trip of the encoding;
   headless Chromium (`--autoplay-policy=no-user-gesture-required`, own Vite
   server; filter `**/.claude/worktrees/**` out of `fs.deny` when the root is
   a worktree) in ?sim=worker and ?sim=inline: drive Intro_Music section 0,
   check callbacks render, the order advances, reports reach the sim
   (`acknowledged == issued`), no console errors; frame-time A/B of the
   page's `framePhases` with music on vs `?music=0`. Firefox has no
   Playwright build here (not installed).
5. Docs: this section becomes "Phase 5: Output"; a note in the Audio row of
   docs/sim-worker.md.

**Note for the coordinator:** `src/runtime/galaxy-kernel.wasm` is
gitignored (as are the other kernels), not committed; rebuild it with the
command below.

**Resume.**

```
cd .claude/worktrees/agent-aba9719feccacd206
ln -s ../../../.cache .cache   # and node_modules, Reference, "Deus Ex GOTY Edition" (absolute targets in the main checkout)
cp ../../../src/runtime/{script-vm,lodmesh-kernel}.wasm src/runtime/
cargo build --manifest-path native/galaxy-kernel/Cargo.toml --locked --release \
  --target wasm32-unknown-unknown --target-dir .work/wasm-target
cp .work/wasm-target/wasm32-unknown-unknown/release/galaxy_kernel.wasm src/runtime/galaxy-kernel.wasm
```
