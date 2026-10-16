# E — Galaxy.dll sample entries and effect voices

Galaxy.dll SHA256 `606e71d1…`, preferred base `0x10600000`. Structures are
the SDK's `GALAXY.H` (`glxSample`, `glxVoice`, `glxMemory`), which match the
offsets below. This note is the contract for the library side of sound
effects: what UGalaxyAudioSubsystem calls (docs/galaxy-audio.md, Update
steps 11 and 13) and how the shared mixer (mixer.md) plays it. Translated in
`native/galaxy-kernel/src/effects.rs` and verified against the original under
Unicorn (`scripts/native-galaxy-effects-oracle.py`,
`scripts/validate-galaxy-effects.mjs`, §6).

## 1. RegisterSound and glxLoadSample

**RegisterSound** (vtable `+0x68`, body `0x10606af0`): returns at once when
`USound +0x50` (the Galaxy sample handle) is set. Otherwise it stores `-1`
there, loads the lazy `FSoundData` (`+0x28`, vtable 0), logs
"Register sound: %s (%i)", asserts `Data.Num > 0` (line `0x2a4`), and calls
`glxLoadSample(&glxMemory{'MEMO', 0xc, Data, Num, 0}, 2)` (`0x10606bac`).
The result is the handle; 0 goes to `GError` ("Couldn't register sound"), a
fatal error in UE1. The lazy data is then unloaded (vtable 1).
**UnregisterSound** (`+0x6c`, `0x10606cd0`) stops every channel holding the
sound and calls glxUnloadSample `0x10619500` (stops any voice on the sample,
frees articulation, data and record). Play has no USound destruction, so it
never unregisters (§7).

**glxLoadSample** `0x10618e60(Stream, Flags)`: selects the stream functions
by Flags (1 stdio, 2 memory: seek `0x10618aa0`, read `0x10618b10`, tell
`0x10618bd0`), `malloc(0x48)` (through `[0x1064a738]`) zeroed, peeks 0x50
bytes and seeks back, then dispatches: `+8 == 'AS  '` → `0x1062b640`;
`+0 == '.snd'` → `0x1062b4c0`; `+8 == 'WAVE'` → the WAV loader; `+0x4c ==
'SCRS'` → `0x1062b410`; anything else → `0x10620b30` (the MPEG path that
speech takes, docs/lip-sync.md).

**Census of shipped sounds** (all packages, 10,629 Sound exports): 10,080
MP3 (all in `DeusExConAudio*.u` but one, `DeusExSounds.UserInterface.Menu_SpeechTest`)
and 549 RIFF WAVE (DeusExSounds 398, Ambient 85, MoverSFX 66). Every WAV is
PCM (format 1), mono, 16-bit, `fmt ` chunk of 16 bytes, at 22050 Hz (539),
11025 (6), 16000 (2) or 44100 (2); chunk orders `fmt data [smpl] [LIST]
[cue LIST]`; 143 have a `smpl` chunk, 130 with one forward loop (type 0; 111
loop the whole sound, end = frames − 1) and 13 with none.

**WAV loader** `0x10619940(Sample, Stream, Flags)`:

1. Reads the 12-byte RIFF header; `remaining = ((size + 1) & ~1) − 4`.
2. While `remaining != 0`: reads an 8-byte chunk header. **A read of
   nothing jumps back to the `remaining` test** (`0x10619996` → `0x10619cbb`)
   with nothing changed, so a RIFF size past the data, or chunk sizes that
   overrun it (remaining wraps), never return (verified: the oracle times
   out, cases `load-spin-*`; the translation stops with `UNSUPPORTED_SPIN`).
   No shipped WAV does this.
3. `fmt `: reads 16 bytes (tag, channels, rate, avg, align, bits) into
   frame locals; tag 1 seeks `size − 16`, any other tag reads 4 more bytes
   and seeks `size − 20`.
4. `data`, tag 1 (`0x10619a26..0x10619b0d`): Type = `0x20` (GLX_PANNING) for
   mono or `0x40` (GLX_STEREOSAMPLE) for stereo, `| 4` for 16-bit; FourCC
   'SAMP', Size 0x40, Panning 0x4000, Volume 0x7fff, Length = size / align
   (`div`), LoopStart = LoopEnd = 0, C4Speed = the fmt rate. With Flags 8
   (streaming) Type `|= 0x8000` and Data = malloc(0x10000). Otherwise Data =
   malloc(size + 0x1f), `read(Data, align, Length)` (fread semantics: whole
   items), **31 zero bytes after `size`** (`0x10619acc`), and for 8-bit
   `Data[i] += 0x80` over Length bytes (unsigned to signed). Tag 0x11 (IMA
   ADPCM) and 0x55 (MPEG) have their own paths; other tags leave the body
   unskipped.
5. `smpl`: reads 0x3c bytes (the header and one loop) and seeks
   `size − 0x3c` (a chunk with no loops is 0x24 bytes, so the read runs 24
   bytes into the next chunk and the seek comes back). With a loop count:
   LoopStart = start, LoopEnd = end (the WAV's inclusive last frame, used as
   the loop bound), Type `|= 8 | (type & 1 ? 0x10 : 0)` (looped, ping-pong).
6. Other chunks are skipped; every chunk then skips its pad byte and
   `remaining −= 8 + even(size)`.
7. Returns the Sample when a PCM data chunk was read, else 0 (the record
   leaks).

## 2. glxStartSample `0x10612310(Voice, Sample, Frequency, Volume, Panning, Flags)`

The subsystem calls it as `(channel + 1, sample, ftol(C4Speed · Pitch ·
Doppler), volume, pan, 0)` (`0x1060a40a..0x1060a435`) and asserts a nonzero
result (line `0x754`).

* Returns 0 when `glxEffectChannels [0x1068828d]` is 0, Sample is null or
  its FourCC is not 'SAMP'. `count = Type & 0x40 ? 2 : 1`. Takes the lock and
  polls 3D voices (`0x106126f0`: nothing while the output type `[0x1069817a]`
  is 0).
* Per voice `i < count`: Voice 0 searches a free effect voice (DX never
  passes 0); otherwise the voice is `0x1068dc00 + 0xa0·(Voice + i)`, slot
  `Voice − 1 + i`. glxStopSample on it, then, when `Sample->Data` is set:
  StartTime = `Flags & 1 ? 0xfffffffe : glxCurrentTick [0x10697ce0]`;
  NoteNo 0x3c, InstNo 0, SmpNo 0, Active 1, Enabled 1, Flags = `Flags | 8`
  (first voice) or `Flags & 0xf5`; Velocity, Expression, InsVol and
  InsVolFade 0x7fff; InsArt and the other envelope fields 0; SmpHdr =
  Sample; SmpPtr = SmpStart = Data (`>> 1` for 16-bit), SmpFrac 0, SmpType =
  Type, SmpLoopStart/LoopEnd/End = SmpStart + LoopStart/LoopEnd/Length,
  Custom1..4 = 0 (the ring path, Type `& 0xe000` or `& 0x40`, allocates a
  0x10000-byte ring instead); C4Speed = Frequency (−1: the sample's);
  SmpVol = SmpBaseVol = Volume (−1: the sample's); Panning = BasePanning =
  Panning (−1: a stereo pair's 0 / 0x7fff, else the sample's when
  GLX_PANNING, else unchanged); step `+0x62 = (C4/rate) << 16 + ((C4 %
  rate) << 16) / rate`; SmpPeriod = SmpBasePeriod = `6848·0x20ab / C4`
  (player mode bit 0, set by an Amiga-slide module) or 0x3c00; VibIndex =
  TremIndex = 0; Mutex = CreateMutexA(0, TRUE, 0), Link 0, the previous
  voice's Link = this voice.
* Releases the mutexes and returns the first voice.

The voice keeps glxInit's other defaults: Volume `+0x12 = 0x7e02`, Reverb
send `+0x1e = 0x7f`, Chorus send `+0x1c = 0`. So the mixer's volume chain
for an effect voice is `0x7e02 · 2m² · 0x7fff⁴ · SmpVol` with m the effects
master `[0x1069817c]` (glxSetSampleVolume), on bus B (Flags bit 7 clear),
with the full reverb send.

## 3. glxControlSample `0x1060d280(Voice, Frequency, Volume, Panning)`

Over the voice and its Link chain: C4Speed, SmpVol = SmpBaseVol, Panning =
BasePanning (−1: the header's when the voice's SmpType has GLX_PANNING, else
the current +0x14), the step. Null → 0x11, else 0. **The step is recomputed
positive even on a ping-pong loop's backward pass**: the next mixer run then
has a negative count and moves the bus pointers back (mixer.md §8.3,
`HAZARD_BUS_UNDERRUN`), far enough to leave the bus block; no shipped effect
has a ping-pong loop, so DX never reaches it. The subsystem's own store of
`+0x16` after the call (`0x1060a333`) writes the value the call just wrote.

## 4. glxControlVoice `0x1060cf00` and glxStopSample `0x10618410`

**glxControlVoice(Voice, Command, P1, P2):** null → 0x11. Command 2
(GLX_GETSTATUS) returns Active (`+0x0f`; the 3D branch needs Flags bit 2 and
an output type of 2..5); this is the subsystem's "voice finished" poll
(Update step 5). Command 0 sets Enabled (P1 0 or 1, else 0x11). Command 1
sets the Vol byte `+0x3f` (P2 0) or a slide `+0x40` toward `+0x41` (P1 0..127,
else 0x11). Other commands 0x11.

**glxStopSample(Voice):** null → 0x11. Counts the chain's voices with a
mutex and waits on them (`WaitForMultipleObjects(n, h, TRUE, 1000)`); with
none (a voice never started, or already stopped) the wait fails (n = 0 is
invalid) and nothing changes. Otherwise, per voice: the 3D release, the ring
free (ring types), StartTime 0, Active 0, Flags 8, CloseHandle, Mutex and
Link 0. Returns 0. A finished voice (Active cleared by the mixer at the
sample's end, mixer.md §2.3) keeps its mutex until it is stopped.

## 5. Mixing and output

The mixer entry already mixes slots `[0, glxEffectChannels)` (mixer.md §1.5,
§2.2): bus B (d04 dry, d0c reverb send, d14 chorus send), in slot order. The
renderer converts bus A with the store and bus B with the saturating add
(mixer.md §1.3, §2.6). The browser's `galaxy_render` converts both onto the
same frames, which is the renderer's own placement with `posB = posA` (its
start-up/underrun resync); the original's steady state puts bus B about a
ring ahead of bus A (mixer.md §1.3, derived and unmeasured), host timing the
browser does not reproduce.

## 6. Verification

`node scripts/validate-galaxy-effects.mjs` (cached oracle in
`.cache/galaxy-effects`, about 1 minute cold):

* **Loader:** all 549 shipped WAVs and 14 synthetic WAVs (8-bit with the
  +0x80 conversion, stereo, ping-pong loop, a `fmt ` extension, a non-PCM
  data chunk, odd chunks and pads, `smpl` before `data`, two data chunks, no
  data, a truncated data chunk, 24-bit, `smpl` with no and with two loops,
  block align 4): the result and every byte of the record and its Data
  block. Two more synthetic WAVs never return in the original and stop the
  translation with UNSUPPORTED_SPIN.
* **Voices:** 20 programs with 556 entry calls and 1,134 timer callbacks
  (start, control, stop, status/mode/volume control, the sample defaults,
  null voices, restarts, steps 0 to 6.8 frames per frame, surround pan,
  effects master changes and ramps, 16 voices, Intro_Music and an Amiga-mode
  module playing alongside, 8 seeded random programs, and 4 programs with
  the effects reverb installed, changed and freed, reverb.md): each call's result,
  the first 32 voice records after it, the mixer trace (U/T/K/M/R), and the
  renderer's int16 PCM of both buses per callback, all bit-equal; the
  browser path (`galaxy_render`) against the original renderer at
  coincident heads in 8 of them and in Quotes_Music section 4, whose
  bus-B underrun writes the browser now adds as the original does.
* **Coverage** of the entries: every unreached run is listed with its
  reason in the validator (other loaders, ADPCM/MPEG/streaming, the ring
  path and stereo pairs, Voice 0, 3D branches).
* **Mutants** 301–304 (loop end + 1, control keeping the step, default pan
  ignoring GLX_PANNING, unzeroed pad) and the reverb's 305–306 are each
  caught.

## 7. Not translated / open

* glxLoadSample's other loaders and the MPEG path (speech, and
  Menu_SpeechTest); ADPCM/MPEG WAVs, streaming and the ring path of
  glxStartSample (compressed, streamed and stereo samples) and the decoder
  thread `0x1060e340` that feeds them. Speech MP3s instead take a stand-in
  record from the browser's decode (`effects.rs` `host_sample`,
  `host_sample_attach`, `host_sample_release`: the WAVE loader's 16-bit mono
  record, its PCM in a separate pool, the non-ring branch;
  [galaxy-audio](../galaxy-audio.md) "Speech through Galaxy's voices"),
  which no oracle covers.
* glxUnloadSample in Play, which never destroys a USound. The kernel has it
  (`glx_unload_sample`, `galaxy_sample_unload`, 2026-10-16) for the replay of
  the original's capture (row 4.3.7, whose scene unregisters a sound), checked
  against the original by the case `voices-unload`; a 3D voice's release in it
  is not translated (Use3dHardware False).
* 3D hardware voices (Use3dHardware False).
* The real heap behind the address model: records and data take a bump
  heap's addresses at `0x60000000`; voice handles are the voices' addresses
  at the preferred base; mutex handles are the oracle's counter. No path
  reads an address's value.
