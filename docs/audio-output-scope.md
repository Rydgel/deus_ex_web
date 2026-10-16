# Audible output: scope for Stage 4 gate row 4.3.7 (2026-10-16)

Row 4.3.7 of [stage-4-exit-criteria](stage-4-exit-criteria.md) ("audible output: the output Galaxy produces for the speakers") is
`MISSING` and had no plan. This note is the plan. **The user adopted all six recommendations of §7 on 2026-10-16**, so §6 is the row's
criterion, with check 5 (the speech ring transport) included. All five checks are implemented and pass (§6 "Status"); the
two captures of the running original are stored (§5.1, §5.2). It records:

1. the chain from Galaxy's mixer to the speakers, in the original and in Play, with the status of each stage (§1);
2. what was traced in Galaxy.dll for it on 2026-10-16 (§2: read from code with capstone, **not** oracle-checked);
3. each open part: what the original does, what Play does, and how it could be measured, with a judgement of each route (§3);
4. the census of the shipped sound formats, ADPCM included (§4, `scripts/census-sound-formats.mjs`);
5. the captures of the running original under CrossOver, what they found and how they are replayed (§5);
6. the row's criterion (§6) and the user's decisions behind it (§7).

Galaxy.dll is the GOTY `System/Galaxy.dll` (SHA256 `606e71d1…`, preferred base `0x10600000`), as in [galaxy-audio](galaxy-audio.md) and
[galaxy-music](galaxy-music.md). Addresses in Engine.dll are at its preferred base `0x10300000`.

## 1. The chain

Status labels: **O2** translated and oracle-checked (Play's code equals the DLL's on an oracle); **T** translated or substituted in Play but
not checked against the original; **H** host by nature (an OS, driver, browser or scheduling property, not Galaxy's code); **U** untranslated
(Play does something else or nothing).

### 1.1 The original

| # | Stage | Code | Status in Play |
| --- | --- | --- | --- |
| 1 | Voice control on the game thread: `Update` (`0x10609510`), `PlaySound`, `StopSoundId`, `NoteDestroy`; their library calls glxStartSample `0x10612310`, glxControlSample `0x1060d280`, glxControlVoice `0x1060cf00`, glxStopSample `0x10618410`, the volume setters, glxSetSampleReverb `0x106113d0`, Update's music section | [galaxy-audio](galaxy-audio.md), [update-transition](galaxy-music/update-transition.md) | **O2** (rows 4.3.1, 4.3.3, 4.3.4; 165 cases / 1,954 calls, 768 volume cases, Update's music and reverb tails) |
| 2 | Sample loaders: glxLoadSample `0x10618e60` dispatching to the WAV loader `0x10619940` (PCM tag 1) | [effects](galaxy-music/effects.md) §1 | **O2** (all 549 shipped WAVs, 14 synthetic) |
| 3 | The MPEG loader `0x10620b30`, the MPEG decoder `0x1061a690` and the decoder thread `0x1060e340` (speech, 10,080 MP3s) | [lip-sync](lip-sync.md), §2.3 below | **U**; Play's substitute is the browser decode into a non-ring record ([galaxy-audio](galaxy-audio.md) "Speech through Galaxy's voices"). The decoder's PCM is row 4.5.6, excluded by the user |
| 4 | The other loaders and bodies: IMA ADPCM WAV (`0x10619b12`, decoder `0x1061a170`), MPEG-in-WAV (`0x10619c14`), `'AS  '` `0x1062b640`, `.snd` `0x1062b4c0`, `SCRS` `0x1062b410` | §2.5, §4 | **U**, unreachable: no shipped sound takes them (§4) |
| 5 | The hand-over: every glx call takes the recursive critical section `0x1067b670`; Update holds it from `0x10609549` to `0x1060abd6`, so a frame's changes reach the **next** timer callback | [mixer](galaxy-music/mixer.md) §0, §1.1 | **H** in Play: one batch per critical section over a MessagePort, applied between two worklet callbacks, so 0 to 23 ms of output later ([galaxy-music](galaxy-music.md) "Phase 5") |
| 6 | The timer callback `0x106142a0` (winmm `timeSetEvent`, every Latency/2 = 20 ms): DirectSound cursors, the two ring heads A `0x10697cd4` and B `0x10697cd8`, the fill count `ahead` `0x10697cdc`, the start-up resync, the Lock/copy/Unlock | [mixer](galaxy-music/mixer.md) §1.3, §2.2 below | **U**. Play renders 882 frames whenever its ring holds less than a 128-frame quantum, at coincident heads |
| 7 | The cursor schedule: how far the play cursor moved in each 20 ms (the bytes R each callback renders), and the write cursor's lead over the play cursor at the first callback | §3.1 | **H** (timer jitter, the DirectSound implementation's cursor granularity and write lead) |
| 8 | The renderer `0x106146a0`, the mixer `0x10614920` (segmenting, sequencer tick, envelopes, refill posts), the SSE kernel `0x10622730`, the reverb hook `0x10622d33`, the conversions `0x10622fe4` (bus A stored, bus B saturating-added) | [mixer](galaxy-music/mixer.md) §1.4–§2.6, §8 | **O2** (rows 4.3.2–4.3.4; `render_ring` against the original renderer with bus B half a ring ahead, `render` at coincident heads) |
| 9 | Ring voices (streamed, compressed or stereo records): glxStartSample's ring branch `0x10612562..0x1061258f`, the refill posts `0x106151f5`, the decoder thread's ring logic | §2.3, §2.4 | **O2** since 2026-10-16 (check 5), with the MPEG decoder as a PCM leaf; the record's source is the browser's decode (`effects.rs` `host_sample`, labelled) |
| 10 | Hardware 3D voices (`0x10612800`, `0x106126f0`, the A3D/EAX open) | §2.6 | **U**, unreachable on the reference machine (§2.6) |
| 11 | The output buffer: Galaxy's 176,400-byte staging ring `[0x10697ccc]` copied into a 1 s DirectSound secondary buffer `[0x10697cc8]`, 44,100 Hz, 16-bit, stereo, flags `GLOBALFOCUS | GETCURRENTPOSITION2`, looping | [mixer](galaxy-music/mixer.md) §1.2 | the boundary of "the output Galaxy produces". Galaxy never calls SetVolume, SetPan or SetFrequency on the buffer (§2.2) |
| 12 | DirectSound's mixing of the buffer into the device format (kmixer on XP, WASAPI shared mode on Vista and later, Wine's dsound on the reference machine), resampling, the driver and the DAC | | **H** |

### 1.2 Play

| # | Stage | Code | Status |
| --- | --- | --- | --- |
| P1 | Update, PlaySound and the library calls on the simulation side (worker, or the page with `?sim=inline`) | `src/runtime/galaxy-audio.mjs`, `galaxy-music-library.mjs` | **O2** as row 1 |
| P2 | Batches over a MessagePort to the worklet, applied whole between callbacks | `galaxy-music-library.mjs`, `src/viewer/galaxy-music-worklet.mjs` | **H** |
| P3 | The kernel in the worklet: the translated timer callback (`output.rs`) every 882 frames of consumption, with play = the consumption position and write = play + `WRITE_LEAD` (since 2026-10-16; before, `galaxy_render(882)` at coincident heads) | `native/galaxy-kernel/src/output.rs`, `mixer.rs` `render_ring`, `host.rs` | **O2** (check 1: the callback; check 4: the worklet plays its buffer, music size − D after effects). D's host part is the measured `WRITE_LEAD` 1,764 (§5.1, check 2), a labelled host input |
| P4 | Speech PCM: the page's `OfflineAudioContext(1, 1, rate).decodeAudioData`, channel 0, `pcm16` (round half up, clamp), attached to the stand-in record; the start waits for the decode | `src/viewer/main.mjs` `decodeSpeech`, `galaxy-lipsync-channels.mjs` `pcm16` | substitute, **T**; content excluded with 4.5.6 |
| P5 | The worklet reads the secondary buffer at its play cursor: int16 / 32768 into float32, 128-frame quanta split at each callback | `galaxy-music-worklet.mjs` `process` | **H** (exact conversion; the latency is the host's) |
| P6 | The AudioContext at 44,100 Hz (refuses any other rate), its destination, the browser's resampler when the device runs at another rate, the OS mixer, the device | `galaxy-music-output.mjs`, `main.mjs` | **H** |

No stage is "translated but unchecked" apart from the speech stand-in (P4 and row 9's substitute). Everything Play computes between the
library calls and the int16 frames is the original's code, oracle-checked; since 2026-10-16 that includes where the frames go (row 6,
checks 1 and 4) and the ring voices (row 9, check 5); D's host part (row 7) is measured and pinned (check 2); what differs is the cursor
schedule (host) and the speech PCM (row 3).

## 2. Galaxy.dll traces of 2026-10-16

Read from the disassembly (capstone over the hash-pinned DLL, a scratch helper outside Git). §2.2 has since been run under the
oracle (check 1, below); §2.3 and §2.4 are check 5's.

### 2.1 The output is opened once per session

`UGalaxyAudioSubsystem::SetViewport` (`0x10605c40`, thunk `0x106010dc`):

* logs "Galaxy SetViewport: %s", stops every channel (`0x10605ca6..0x10605cb4`, StopSound `0x1060125d` per channel);
* returns at once when the new viewport is the current one (`+0x7c`, `0x10605cb6..0x10605cbb` → `0x10605f30`);
* otherwise, with an old viewport, unregisters every UMusic (`0x10605cc9..0x10605d62`) and stops the output (`0x10618710`, "glxStopOutput()" on failure); then, with a new one, opens the output (`0x10613350` at `0x10605e7a` with the viewport's window for DirectSound, `0x10605eef` for WinMM).

Engine.dll calls it from `UGameEngine::Init` with the new viewport (`0x1038979c`), from `UGameEngine::LoadMap` (`0x1038c549`, `0x1038dfdb`) and
`UGameEngine::Browse` (`0x1038ba23`) with `Audio->GetViewport()` (vtable `+0x84` = `0x10606190`, `mov eax, [ecx+0x7c]`), i.e. the same viewport,
and from `UViewport::Destroy` (`0x103733a3`) with NULL. So a map load stops the channels and keeps the output; the output, its ring heads
and `ahead` are set up once, at engine init. The stored CrossOver startup log (`.cache/original-startup-deusex.log`, NT 6.2) agrees: "Galaxy
is using DirectSound", "Galaxy initialized", then three "Galaxy SetViewport: WindowsViewport0" lines (Init, then two at the 00_Training
LoadMap) and no "Safely failed to initialize Galaxy".

### 2.2 The timer callback `0x106142a0`

**Settled by the oracle (2026-10-16, check 1 `galaxy-output-callback`):** the callback is translated
(`native/galaxy-kernel/src/output.rs`) and bit-equal with the original under Unicorn over 17 cases and 405 callbacks, 352 of 352
instructions covered ([mixer](galaxy-music/mixer.md) §9). Everything below holds; the oracle added that GetCurrentPosition failing
skips the whole callback, that the `A == B` re-seat runs at every callback (not only the first), that the resync's Lock copies
`size` bytes whatever the returned length, that a failed Lock skips only that head's copy (the heads still advance by R), and that
`ahead` stays at `size` after the first callback, so only the first callback and `MUSICORDER` reach the resync.

The disassembly confirms [mixer](galaxy-music/mixer.md) §1.3 and adds:

* GetCurrentPosition (`+0x10`, `0x106142d6`) fills play at `[esp+0x20]` and write at `[esp+0x24]`; `play = (play % size) & ~(nBlockAlign−1)`;
  `target = ((write % size) + ⌊nAvgBytesPerSec · Latency / 1000⌋) % size & mask` (the division is `mul 0x10624dd3; shr 6`). WAVEFORMATEX is at
  `0x1067b6d8` (`nAvgBytesPerSec` `0x1067b6e0`, `nBlockAlign` `0x1067b6e4`), Latency at `0x1064a65c`. Installed: +7,056 bytes.
* When A equals B (only after the open, which zeroes both), A = play and B = target (`0x1061433c..0x1061434e`). Then `lenA = (play − A) mod
  size`, `lenB = (target − B) mod size`, `ahead −= min(lenA, lenB)`.
* `ahead ≤ 0` (`0x10614381`): `ahead = (B − A) mod size`, the renderer runs with **both** heads at B over `n = (A − B) mod size` bytes, the whole
  buffer is locked (`DSBLOCK_ENTIREBUFFER`) and the staging ring copied in. The callback then **continues into the normal render** at
  `0x10614484` in the same call (the resync's renders raise `ahead` to `size`). At the first callback lenA = lenB = 0, so that render is
  empty.
* Normal render: `R = 0x106146a0(staging, size, A, B, lenA, lenB)`, Lock/copy at A then at B (each with the `DSERR_BUFFERLOST` →
  Restore, Play, Lock retry), `A += R`, `B += R` modulo size (`0x10614657..0x1061467b`).
* The only calls on the secondary buffer are GetCurrentPosition, Lock, Unlock, Play and Restore here, and CreateSoundBuffer, Play and
  Release in the open (`0x10613841..0x106138a4`). No SetVolume, SetPan or SetFrequency: DirectSound plays Galaxy's bytes at 0 dB, centred,
  at the buffer's rate.
* Writers of `ahead` (`0x10697cdc`): the DirectSound and WinMM opens (zero), the two callbacks, the mixer (`0x10615641`, `ahead += frames <<
  shift`), glxControlMusic command 1 (`0x1060d193`, zero), and `0x1060deb0` (lock, zero, unlock), which has **no caller or pointer** in the
  image. glxControlMusic is called with command 1 only by the console command `MUSICORDER` (`0x106071a8`, while a song is registered,
  `+0x888`); Update's call (`0x1060a863`) is command 2, which does not touch `ahead`. This answers update-transition.md's "What is `0x10697cdc`?".

**Consequences** (derived, unmeasured):

* In steady state `D = (B − A) mod size` never changes for the session (§2.1): `D = (write − play at the first callback) + 7,056`.
* A frame rendered by a mixer call goes to A + 4f on bus A (music) and B + 4f on bus B (effects, ambient sounds, interface sounds,
  speech). A trails the play cursor and B leads it by D, so **a music frame is heard `size − D` bytes after the effects frame the same
  call rendered**: 42,336 frames (960 ms) minus a quarter of the write lead. An effect is heard about D (40 ms plus the write lead) after
  its callback, music about 1 s after.
* A `MUSICORDER` resync while effect voices play renders about 0.96 s of them at B, then the normal render adds the next R bytes of the
  same voices at B again: for one lap the effects bus would carry each voice at t and t + 0.96 s together. Console only, and so far a
  reading of the code.

### 2.3 Ring voices: start, refill, end

**Settled by the oracle (2026-10-16, check 5 `galaxy-ring-voice`):** translated (`native/galaxy-kernel/src/ring.rs`) and bit-equal with
the original over 14 cases ([galaxy-audio](galaxy-audio.md) "Speech on Galaxy's ring transport"). The reading below holds, with two
corrections: the end is set only when the read head is below the write position, so a line longer than the first fill plays up to a
further ring lap of zeros before Active clears (0.61 s on a 100,000-frame line); and the mixer's ring loop is 32,767 samples against
the decoder's 32,768, so one decoded sample is skipped every lap after the first.

* **Start** (glxStartSample, Type `& 0xe000` or `& 0x40`): `malloc(0x1001f)`, 64 KB zeroed (`0x106124e9..0x10612502`); Type `|= 0x88`
  (looped, loop always); loop start = start, loop end = end = start + 0x7fff samples; the write position `V+0x88 = 0x10000` (a sentinel),
  the source offset `V+0x8c = 0`, `V+0x90 = V+0x94 = 0x10000` (`0x10612562..0x1061258f`). No decode and no message at the start: the voice
  is Active and the mixer mixes zeros.
* **Refill**: at each sequencer tick the mixer posts `PostThreadMessageA(decoder, 0x400, slot, V+0x46 − V+0x52)` (the read head in
  samples) for each active ring voice (`0x106151f5`, [mixer](galaxy-music/mixer.md) §1.1). At the default tempo without music a tick is
  about 459 frames (10.4 ms), with a song `5·rate/(2·tempo)` frames.
* **First fill** (`0x1060e4bd..0x1060e4d7`): with the sentinel, the write position becomes `(read_bytes + 0x2000) & 0xffff`, where
  `read_bytes` is the posted read head times 2 for 16-bit. The decoded audio therefore starts **0x2000 bytes = 4,096 samples (92.9 ms at
  44.1 kHz) after the read head at the first post**, itself up to one tick after the start: the voice plays at least 4,096 samples of
  silence before its first decoded sample.
* **Fill amount** (`0x1060e4d9..0x1060e4ff`): `(read − write) mod 0x10000` bytes, at most 0x8000 per message, decoded by `0x1061a690` (Type
  `& 0x4000`), `0x1061a170` (`& 0x2000`) or `0x10619800`, into the voice's ring and its Link voice's ring.
* **End** (`0x1060e693..0x1060e700`): when the decoder returns nothing and the sample is not looped (record Type `& 8` clear), and the read
  head is below the write position, the voice's loop bits `0x88` are cleared and its loop end and end (`+0x56`, `+0x5a`) set to the write
  position; the rest of the ring is zeroed. The mixer then ends the voice and clears Active ([mixer](galaxy-music/mixer.md) §2.3). Units: the
  thread works in bytes, the voice's positions are in samples for 16-bit data (`shr 1`).

### 2.4 The MPEG loader's record type, and the stereo lines

**Settled (check 5):** the pair, its Link and one post feeding both rings run as read; Play now decodes both channels and starts the
pair (`decodeSpeech`, the record 0x4044).

`0x10620ccc..0x10620cff`: the record's Type is `0x4024` (streamed, panning, 16-bit) for a mono MPEG stream and `0x4044` (streamed,
**stereo**, 16-bit) for any other mode (the `sub 3; neg; sbb; and 0x20` on the header's mode). Panning `0x4000`, volume `0x7fff`, rate
`+0x3c` from the table at `0x10640f40`. A stereo record starts **two** voices in glxStartSample (`count = Type & 0x40 ? 2 : 1`): the
channel's slot and the next slot, stopping whatever played there, both at the pan Update passes (not the pair's 0/0x7fff), and
glxControlSample drives both through the Link chain ([effects](galaxy-music/effects.md) §2, §3). The census (§4) finds four such lines.
Play decodes them and keeps channel 0 only (`getChannelData(0)`), on one voice.

### 2.5 ADPCM

The WAV loader's tag `0x11` branch (`0x10619b12..0x10619c12`) allocates a `0x4020`-byte decoder state at `+0x40` (block align,
channels, samples per block), types the record `0x2024` (mono) or `0x2044` (stereo), reads the compressed data whole (or, streamed,
`0x8000` and a 64 KB buffer) and returns. Such a sample is a ring voice expanded by the decoder thread with `0x1061a170`. Tag `0x55` hands
the stream to the MPEG loader (`0x10619c14` → `0x10620b30`).

### 2.6 The 3D gate

`+0x74` (3D voices) is written only in Init (`0x10605806..0x1060590b`), and only when Init's probe left the hardware type `[0x1069817a]` at 2
("Aureal A3D 1.x"), 3 ("EAX 1.x"), 4 ("Aureal A3D 2.x") or 5 ("EAX 2.x"), each with its "3D sound hardware found!" log line; the value is
`Use3dHardware (+0x48) && !ParseParam(cmdline, "no3dsound")`. The shipped Sound menu offers the option (`MenuChoice_Use3dHardware`, "Enables
Hardware 3D Sound Support"), but the stored CrossOver startup log has no hardware line, so `+0x74` stays 0 on the reference machine even if
the option is ticked, and the open's flags bit 3 (the A3D CLSIDs) is never set.

## 3. The open parts

### 3.1 The ring heads' spacing and the music bus delay (one mechanism)

**Original.** §2.2: bus A at A (just behind the play cursor), bus B at B = A + D, D fixed for the session at the first callback after
engine init. D has a Galaxy part, `⌊176400 · 40 / 1000⌋ = 7,056` bytes, and a host part, the write cursor's lead over the play cursor at
that instant. On the reference machine that lead is **Wine's dsound's**, not a Windows driver's. Music sounds `size − D` bytes (about
0.96 s minus the lead) after effects rendered at the same time, which also means about 1 s between an Update that changes the song or
section and the change being heard.

**Play (since 2026-10-16).** The worklet keeps the 176,400-byte staging ring and the secondary buffer (`output.rs`), takes its own
consumption position as the play cursor and play + `WRITE_LEAD` as the write cursor (D = 7,056 + `WRITE_LEAD`), and runs the translated
callback every 882 frames; its output is the buffer at the play cursor. `validate-galaxy-output-play.mjs` (check 4) shows the output equals a
reference loop on a second kernel instance frame for frame, that it is the staging ring at the cursor after every callback, and that an effect
started in the batch of a song change sounds size − D bytes before the song's first frame (leads 0 and 1764). `WRITE_LEAD` is 1,764 (`galaxy-music-worklet.mjs`), CrossOver's lead as §5.1 measured it (D = 8,820). Before, `galaxy_render(882)` placed both buses on the same
frames (the resync placement for every callback). The first callback's resync renders size − D bytes at once (about 8 ms of the audio thread,
on the buffer's silent start); a `MUSICORDER` resync does the same while playing and can glitch the browser's output once.

**Routes.**

| Route | What it gives | Reliability |
| --- | --- | --- |
| Oracle: `0x106142a0` under Unicorn with a fabricated IDirectSoundBuffer (vtable leaves: GetCurrentPosition answers a scripted cursor pair, Lock hands out a buffer and records the range, Unlock, Play, Restore record), the real renderer and mixer behind it | The head logic, `ahead`, the resync (including the `MUSICORDER` case of §2.2), R and the copied bytes for any cursor sequence, against a Rust translation | High: integer code only (`div`, `mul 0x10624dd3`), the same harness as the mixer oracle. Gives the placement, never D |
| Tracer, poll mode (§5.1): ReadProcessMemory of A, B, `ahead` and the format words in the running game | D exactly (`(B − A) mod size`), the per-callback R as A's increments, the output path and kernel actually taken | Exact values, no perturbation (no breakpoint). Measures the reference machine's D, i.e. CrossOver's dsound write lead, which is a host property of that machine |
| Tracer, capture mode (§5.2): breakpoints in the callback and on the library entries, the copied segments dumped | The bytes Galaxy copies, their positions and the cursor schedule, for a bit-exact replay through the translation | Exact; the breakpoints slow the game and change the schedule, which does not matter because the replay uses the recorded schedule. The hardest tool to build |
| Loopback recording of the running original (§5.3) | The acoustic offset between an effect and a music event through dsound and the device | Millisecond timing by cross-correlation, never bit-exact: Wine's dsound converts to float, may resample to the device rate and adds its own latency. Confirmation of the 0.96 s offset only |

### 3.2 MPEG samples (speech)

Three separate questions:

1. **The decoded PCM.** Galaxy's decoder `0x1061a690` against the browser's decode. Row 4.5.6, excluded by the user's decision of
   2026-10-16. Not part of this row. (The census finds no ID3, Xing or LAME header in any of the 10,080 MP3s, so neither decoder has
   gapless information; how each treats the decoder delay is part of 4.5.6.)
2. **The ring transport**, which is Galaxy's code, not the decoder's (§2.3, §2.4). Original: the voice starts at once on a zeroed ring;
   its audio begins at least 4,096 samples (92.9 ms) after the read head at the first refill post, plus up to one sequencer tick; it ends
   after the decoded data; lip sync's window reads the same ring ([lip-sync](lip-sync.md)), so the mouth starts with the sound. Play: the
   start waits for the page's decode (host time), then the whole line plays from its first sample through the non-ring branch and ends at
   the decoded length. So Play's speech starts about 93 ms earlier relative to the voice's start, give or take the decode wait; the
   voice's Active span is about 93 ms shorter.
3. **The four stereo lines** (§2.4, §4): the original plays both channels as a pair on two slots at the same pan (and stops the next
   channel's sound); Play plays the left channel on one slot.

**Routes.** Oracle: glxStartSample's ring branch, the mixer's refill posts and the decoder thread body `0x1060e340` under Unicorn, with the
MPEG decoder `0x1061a690` replaced by a leaf that returns given PCM (the browser's, or any test signal): the first audible sample, the
refill sizes, the end and the stereo pair, exactly. High reliability for what the ring logic does with a decoder's output; it says
nothing about the decoder (4.5.6). The decoder thread's progress is real-time in the original (a HIGHEST-priority thread answering
messages); with 64 KB of ring and a 93 ms head start it is unlikely to fall behind 44.1 kHz mono speech, which
[lip-sync](lip-sync.md) already assumes and nothing has measured. Tracer: a poll of one speech
voice's `V+0x46`, `V+0x52`, `V+0x88`, `V+0x8c` during a line confirms the head start and the decoder's lead live. Loopback: the speech onset
against the DataLinkStart cue; weak, because the scripts' own timing sits between the two.

### 3.3 ADPCM samples

None shipped (§4): every WAV is PCM, and no sound reaches the `'AS  '`, `.snd` or `SCRS` loaders or tag `0x55`. The ADPCM branch and its
decoder are unreachable in the shipped game. Route: none needed; the census script is the evidence. Exclude.

### 3.4 3D voices

Unreachable on the reference machine (§2.6): no A3D or EAX hardware, so `+0x74` stays 0 whatever the menu says, and Update starts 2D
voices only. A machine with EAX or A3D drivers would take another path; the reference is not such a machine. Route: the poll of §5.1 can
read `[0x1069817a]` and the subsystem's `+0x74` live to confirm. Exclude, as row 4.2.32 excludes options the shipped D3D configuration does
not use.

### 3.5 Smaller open items in the same chain

| Item | Original | Play | Route |
| --- | --- | --- | --- |
| The cursor schedule (R per callback) | Host. **Measured (§5.1):** the play cursor moves in 2,048-byte steps (Wine's dsound mixes 512-frame periods), so R is 2,048, 4,096 or 6,144 bytes (4,096 two times in three), at a median interval of 20.0 ms (16.7 to 61.4 ms) | Fixed 882-frame callbacks | Kept host (§7 item 6); the capture (§5.2) would record it for replay |
| The timer thread's MXCSR | **Measured (§5.1): 0x1f80** on every thread but the game thread (the three TIME_CRITICAL threads, the winmm timer's among them; Wine fills the FXSAVE area) | 0x1f80 | Settled |
| The pan table's precision (`[0x10698390]`, 64 KB, built at Init) | **Measured (§5.1): the PC 53 variant** word for word (PC 64 differs at `T[0x7fff]`): the game thread's control word at Galaxy Init is the Windows default 0x027f | PC 53 (`MUSIC_PAN_PC`, changed from 64 on 2026-10-16) | Settled |
| The heap behind the mixer's two hazards (reads before a sample, negative run counts) | Real heap contents | The bump-heap model | Only a live heap dump; rare songs; leave open |
| The DirectSound or WinMM path, the kernel taken | **Measured (§5.1):** DirectSound (`[0x10698178] = 1`), format bits 7, SSE kernel (mode 0x47; MMX 1, SSE 1, 3DNow 0), 3D type 0 and the subsystem's `+0x74` 0 | DS-shaped, SSE | Settled |

## 4. Census of the shipped sound formats

`node scripts/census-sound-formats.mjs [--json out.json]` reads every package of the installation (System `*.u`, Sounds `*.uax`, Maps
`*.dx`, Music `*.umx`, Textures `*.utx`; 219 packages, one at a time, peak 340 MB), takes each Sound export's data and classifies it by
glxLoadSample's dispatch (`0x10618f1c..0x10618f9c`: `'AS  '` at +8, `.snd` at +0, `WAVE` at +8, `SCRS` at +0x4c, else MPEG), the WAV
`fmt ` tag, and the first MPEG frame header. Result (2026-10-16):

| Count | Kind | Packages |
| --- | --- | --- |
| 10,076 | MPEG-1 Layer III, 44,100 Hz, mono | the 18 `DeusExConAudio*.u`, and `DeusExSounds.UserInterface.Menu_SpeechTest` |
| 4 | MPEG-1 Layer III, 44,100 Hz, joint stereo | `DeusExConAudioHK_Shared.ConAudioHK_Shared_681`, `_1531`, `_1532`; `DeusExConAudioMission01.ConAudioMission01_450` |
| 549 | RIFF WAVE, PCM (tag 1), mono, 16-bit: 539 at 22,050 Hz, 6 at 11,025, 2 at 16,000, 2 at 44,100; 130 with a `smpl` loop | `DeusExSounds.u` 398, `Ambient.uax` 85, `MoverSFX.uax` 66 |
| 0 | IMA ADPCM (tag 0x11), MPEG-in-WAV (tag 0x55), any other tag, stereo or 8-bit WAV, `'AS  '`, `.snd`, `SCRS` | |

10,629 Sound exports in all, none in a map, a music or a texture package; no MP3 has an ID3v2 tag or a Xing, Info or LAME header, and
every first frame is at byte 0. This agrees with the census in [effects](galaxy-music/effects.md) §1 and extends it to every package and
to the MPEG modes.

## 5. Captures of the running original (run 2026-10-16 under CrossOver)

Both captures were run on the Mac (the bottle "DeusEx", under the sessions' `.work/bottle.lock`) and are stored in the main checkout's
`.work/audio-output/`. They follow the existing live tooling: `tools/dx-live-win.c` built as
`ad/build/dx-live-win.exe` (`i686-w64-mingw32-gcc -O2 -o ad/build/dx-live-win.exe tools/dx-live-win.c -lpsapi`), the game started by
`node ad/scripts/original-game.mjs launch <map>.dx` under the lock that `scripts/live-original.sh` takes (`.work/wine-deusex.lock`), and the
tracer run with `$DX_WINE` (Mac: `CX_BOTTLE=DeusEx /Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine`; Linux host:
`WINEPREFIX=~/.wine-deusex wine`). Store the results under `.work/audio-output/` (outside Git). Resolve Galaxy.dll's load base in the
process (as the tracer does for Core and Engine) and rebase every address below.

### 5.1 `dx-live-win.exe galaxy poll <count> <interval_ms> <prefix>` (read-only; built and run 2026-10-16)

**Run and stored.** `scripts/galaxy-output-capture.sh` (the bottle "DeusEx", under the lock): 00_Training at its first frame, `galaxy poll
3000 1`, a console `open 00_Training`, the poll again. Stored with the gate's originals in the main checkout's `.work/audio-output/`
(`training-load{1,2}.{json,pan.bin,poll.txt}`, outside Git). The player and its XLevel differ between the two polls (JCDentonMale0 at
0x04a8a000, JCDentonMale1 at 0x04a88c00): the load happened. Results, the same in an earlier launch: **D = 8,820 bytes in all 6,000
samples, across the map load**, so the write lead is 1,764 bytes (441 frames, 10 ms; Play's `WRITE_LEAD`); WAVEFORMATEX PCM, 2 channels,
44,100 Hz, 176,400 bytes/s, block 4, 16-bit; DirectSound, format bits 7, the open flag 1, kernel mode 0x47 (the SSE row), Latency 40,
16 effect slots; no 3D (type 0, `+0x74` 0); the pan table the PC 53 variant; MXCSR 0x1f80 on the other threads (the game thread's control
word was 0x007f when sampled inside Render.dll, its MXCSR 0x1fa4: control 0x1f80 with sticky flags); R and the intervals as in §3.5;
`ahead` 176,400 between callbacks (lower values are reads inside a callback, between its subtraction and its render). The decoder
thread is the one at priority 2 (HIGHEST) inside `win32u.dll` (GetMessageA). `validate-galaxy-output-poll.mjs` (check 2) reads the
store and fails if Play's constants differ.

The plan as written:

Like `strobe poll`: no debugger, ReadProcessMemory with QPC timestamps. Per sample: `size [0x10697cd0]`, `A [0x10697cd4]`, `B [0x10697cd8]`,
`ahead [0x10697cdc]`, the likely frames counter `[0x10698194]`, `cnt1 [0x10698204]`, `cnt2 [0x1069834c]`. Once, at the start: WAVEFORMATEX (18
bytes at `0x1067b6d8`), the output path `[0x10698178]` (1 DirectSound, 2 WinMM), the format bits `[0x10698179]`, the 3D type
`[0x1069817a]`, the kernel mode `[0x10697cfc]`, the output rate `[0x10697d18]`, the effect slot count `[0x1068828d]`, the latency
`[0x1064a65c]`, the subsystem's `+0x74` (from the Audio object of the live UGameEngine), the 64 KB pan table at `[0x10698390]` written to a
file, and each thread's MXCSR through GetThreadContext(`CONTEXT_EXTENDED_REGISTERS`) (the timer thread is the one whose sampled EIP
falls in winmm.dll or in `0x106142a0..0x1061565b`).

Run: the game on 00_Training at its first frame (as `live-original.sh` waits for the player), then `galaxy poll 3000 1` (3 s at 1 ms) and
again after a map load. Settles: D (`(B − A) mod size`, constant across the run and across the load if §2.1 holds), the write lead
`D − 7056`, R's distribution, DS against WinMM ([mixer](galaxy-music/mixer.md) §6.3), SSE, the pan table's precision variant (§6.2), the
MXCSR (§8.5) and the 3D type. A short run; worth doing first.

### 5.2 `dx-live-win.exe galaxy capture <out> <seconds> <map> [stop file]` (debugger; built and run 2026-10-16)

**Run and stored.** `scripts/galaxy-output-capture.sh replay` (the bottle "DeusEx", under `.work/bottle.lock`, 2026-10-16 23:05 CEST, load average 4.2). The tracer
starts DeusEx.exe itself under the debugger and arms its breakpoints at Galaxy.dll's `LOAD_DLL_DEBUG_EVENT`, so the record begins before
glxInit and the replay starts from `Library::new` with nothing to restore. The scene: the title map (the launched engine loads `entry.dx`
then `DX.dx` whatever the command line says), a console `open 00_Training` (SetViewport stops the channels and keeps the output; the
song changes), about 35 s later (the load, the player back) a walk forward and back and a jump (dxinput: `W` 2.5 s, `S` 2.5 s, `Space`, `W` 1.5 s: footsteps and a
landing on the effect voices), 20 s of the level, a console `musicorder 2` (glxControlMusic(1, 2): the resync while the song and effect
voices play), 15 s more; then the tracer detaches and the game is quit. The INI copies keep the shipped Galaxy volumes
(`MusicVolume=153`, `SoundVolume=204`, `SpeechVolume=255`; `original-game.mjs writeIni` would silence them). Stored as
`replay-training.bin` (4,263,809 bytes, SHA256 `abdd181a…1ba4ae`) and `replay-training.log`, made by the tracer of commit 02a7aeb
(`ad/build/dx-live-win.exe` built from `tools/dx-live-win.c`). Replayed (check 3): 25,994 records; 4,851 timer callbacks and both resyncs (the first callback's
and `MUSICORDER`'s); **34,222,080 copied bytes equal** (17.0 M nonzero samples, peak 18,232), the first 23 callbacks byte for byte; 5 PCM
samples, 2 music loads, 6 starts, 9 controls, 13 status polls, 12 stops (6 from the subsystem, returning to `0x10607e7e`; 6 inside
glxStartSample, `0x10612419`), 1 unload (of a sample never started), 1 reverb block. The log holds 2 first-chance access violations and 30
first-chance C++ exceptions on the game thread, each handled by the game (none in the earlier captures; the record and its replay are
unaffected). Beside it, unread by the gate, `earlier/`: the same scene by the tracer before the stops carried their return address
(`replay-training-4byte-stops.bin`, 5,644 callbacks), a launch with the music alone (`replay-training-music.bin`, 2,941 callbacks) and the
title map with a walk (`replay-title-walk.bin`, 3,349 callbacks); each replays equal.

**The record.** Typed records (`u32 type, u32 length, u32 thread`, payload), in event order:

* the library calls, each at a site **after its own EnterCriticalSection returns** (or, for Update's inline stores, inside Update's
  critical section), so they order correctly against the timer callbacks, which hold the same lock (`0x1067b670`) throughout: glxInit
  (EffectsChannels), the output open, the two master setters, glxLoadMusic (the module and its 1,024-byte slack as bytes) and its status,
  glxUnloadMusic, glxStartMusic, glxStopMusic, glxControlMusic, Update's clear-active (`0x1060a82a`) and break-flag (`0x1060a88d`)
  stores, glxStartSample (at `0x10612375`) and its result, glxControlSample, glxControlVoice and its result, glxStopSample with its voice
  and **return address** (a stop inside glxStartSample, which stops the voice first, or inside glxUnloadSample is part of that call),
  glxSetSampleReverb (its 0x6c-byte block), glxUnloadSample, Update's lock;
* each sample at its **first glxStartSample** (inside the lock): the 0x48-byte record and its data (PCM: `Length × bytes × channels +
  0x1f`; MPEG: the record's source bytes), again when the record changed; an unloaded sample's address leaves the cache (it may be reused);
* each timer callback: GetCurrentPosition's result and cursors (`0x106142d9`), each Lock's result (`0x10614421`, `0x1061451c`,
  `0x106145f4`) and `DSERR_BUFFERLOST` retry (`0x106143e1`, `0x106144d7`, `0x106145af`), the resync's staging ring as a 32-bit FNV-1a
  (`0x106143b3`), and after the copies (`0x10614657`) R, the heads before the advance, `ahead` and a 32-bit FNV-1a of each copied
  segment (`[A, A+R)`, `[B, B+R)` of the staging ring, wrapping), the segments themselves for the first 24 callbacks; the heads after
  (`0x10614681`);
* the stream decoder thread: each handled message (`0x1060e363`), each MPEG decoder call's arguments, answer and output bytes
  (`0x1060e5a1`), the message's end (`0x1060e80d`).

**What CrossOver's debugger forced** (each found by a crash or a garbled record, and the design changed until the capture ran clean):

* **Two int3 traps at once are garbled.** With breakpoints on the game thread outside the lock (glxLoadSample, RegisterSound), a trap
  coinciding with one of the timer thread's was reported for the wrong thread, or a thread resumed past its int3 (illegal instruction at
  `0x10606bb2`, an access violation at `0x1061451d`). Every game-thread site is now inside the library lock, which the timer thread holds
  for its whole callback, so the two never trap together; samples are read at their first start instead of at their load.
* **A breakpoint on a `call` corrupts the game when stepped off.** Update's unlock call (`0x1060abd6`: EDI 0 in UGameEngine::Draw after
  Update returns) and glxStartSample's 3D poll call (`0x10612370`: EIP 1) both crashed it; the sites moved one instruction on (the start's
  to `0x10612375`, same stack) or were dropped (Update's unlock: the lock marker is enough).
* The launched engine ignores the command-line map (above), and the INI copy silences Galaxy (above).
* Suspending the other threads while one steps off a breakpoint did not prevent the garbling, and is not used. CrossOver also reports
  some of the tracer's int3s from inside its exception dispatcher (the event's context is the dispatcher's); the tracer recovers the
  faulting context from the thread's stack and continues there.

**The replay** (`validate-galaxy-output-replay.mjs`, check 3): the translated library (the Rust kernel) from `Library::new`, opened as
the capture says (PC 53, Latency 40, EffectsChannels), the calls applied in the captured order, each sample from its captured bytes (an
MPEG record becomes the stand-in fed by the captured decoder answers), each timer callback run by `output.rs` with the captured cursors
and Lock results, each decoder message where the original handled it. It compares, and fails at the first difference: each callback's R,
heads before and after, `ahead`, the two segments' FNV-1a, the resync ring's FNV-1a, the first 24 callbacks byte for byte;
glxLoadMusic's status, glxStartSample's and glxControlVoice's results; each decoder message against the replay's own refill posts. A
wrong translation must be caught **at a callback's comparison**: mutants 201 (the kernel step without `& ~1`), 202 (rounding half away
from zero), 402 (the resync returns), 403 (`ahead <= 0` tested unsigned), and the replay with every glxStartSample, glxControlSample and
glxControlVoice dropped (the effect voices are in the compared bytes) all fail there. The scene cannot catch the mutants of paths it
does not reach: 204 (no saturation: peak 18,232), 401 (the cursors are already block-aligned), 404 (no `DSERR_BUFFERLOST`), 405 (the heads
meet only at the open), 301 and 304 (the loader's: the replay takes each record and its padded data from the capture), 302 (every
glxControlSample of the scene repeats its voice's start values, so no step changes), 303 (no start passes pan −1), 305 and 306 (the one
glxSetSampleReverb block is all zeros: the reverb kernel never runs). The oracle checks (check 1, `galaxy-effects`, `galaxy-reverb`)
catch those.

**Not in the scene: speech.** The capture holds no MPEG sample and no decoder message: nothing in the scene speaks. A scene with speech
was not attempted: the decoder thread's sites are outside the library lock (its message loop does not take it), so they can trap together
with the timer thread's, which garbles the record or crashes the game (above). Speech's ring transport is covered by check 5's oracle
(`galaxy-ring-voice`, against Galaxy.dll's own instructions), and its PCM is row 4.5.6's (excluded). A live speech capture needs the
decoder sites made safe first (one thread trapping at a time, for example by single-stepping the decoder thread only while the timer
thread is outside its callback).

*The design first written here* (a snapshot of the globals block, the voice table and the music player at a LoadMap, samples mapped by
USound name, segments copied whole) was dropped before it was built: the Rust library has typed state and cannot be restored from a raw
image, so the capture traces from the launch instead, with load inputs as bytes and segments hashed in the tracer.

### 5.3 Loopback (optional, confirmation only)

* Mac: route CrossOver's output to the installed BlackHole 2ch device and record it with `ffmpeg -f avfoundation -i ":BlackHole 2ch" -ar
  44100 out.wav`; set the device to 44,100 Hz in Audio MIDI Setup first, or dsound and CoreAudio resample.
* Linux host: PipeWire runs at 48 kHz float by default; create a sink at the game's rate (`pactl load-module module-null-sink sink_name=dxloop
  rate=44100 channels=2`), point Wine at it, record with `parec -d dxloop.monitor --rate=44100 --channels=2 --format=s16le --file-format=wav`,
  and check PipeWire's allowed rates so the graph does not resample.
* Scene: a known effect started in the same frame as a song section change, and the offset between their onsets measured by
  cross-correlation with the sounds' own PCM. Expected: about 960 ms minus the write lead measured in §5.1.

## 6. Criterion for row 4.3.7 (adopted 2026-10-16)

**Scene and claim.** "Galaxy's output buffer": for a recorded scene of the running original (the launch to the title map, a console
`open 00_Training`, a walk and a jump, `MUSICORDER 2`: about 75 s with music and PCM effect voices, §5.2), every byte the timer callback
copies into the DirectSound buffer, and the ring position it lands at, equals what the translated library produces when replayed with
the original's library calls and cursor positions; and Play's worklet places bus B D bytes ahead of bus A as the original does, with D
the measured value. Evidence O1 (the stored captures) and O2 (the callback and ring oracles). The captured scene has no speech: the ring
transport is claimed on O2 alone (check 5; §5.2 "Not in the scene").

**Not claimed (host output, excluded):**

* the cursor schedule (timer jitter and dsound's cursor granularity): Play keeps its fixed 882-frame callbacks, so Play's live PCM equals
  the original's only under a replayed schedule;
* D's host part (the write lead at the first callback): measured once on the reference machine and pinned as a labelled host input, as
  PlayerTraveling is for Stage 3;
* everything after the DirectSound buffer: dsound or the OS mixer, resampling, the driver, the device; in Play the worklet ring, the
  AudioContext destination, the browser's resampler and output latency;
* when a frame's library calls land (the next callback in both; Play's batch crossing adds up to one callback);
* the speech PCM (row 4.5.6, the user's decision).

**Not claimed (unreachable, excluded):** hardware 3D voices (no A3D or EAX on the reference machine, §2.6); ADPCM WAVs and the `'AS  '`,
`.snd`, `SCRS` and MPEG-in-WAV loaders (none shipped, §4); the WinMM fallback and the non-SSE kernels (the reference takes DirectSound and
SSE, confirmed by §5.1).

**Checks** (all new):

1. `galaxy-output-callback` [oracle]: a Rust translation of `0x106142a0` against the original under Unicorn with a scripted DirectSound
   buffer: the first callback, steady state, wraps at the ring's end, a cursor jump of more than a ring, `DSERR_BUFFERLOST`, and the
   `MUSICORDER` resync with effect voices playing; heads, `ahead`, R, every Lock range and copied byte.
2. `galaxy-output-poll` [stored capture]: §5.1's values stored with the gate's originals; the check reads D, the path, the kernel, the pan
   table's variant and the MXCSR from the store and fails if Play's constants differ.
3. `galaxy-output-replay` [stored capture]: §5.2's replay, every copied byte equal (Node and the store; no Unicorn: the original's
   side is the capture).
4. `galaxy-output-play` [node]: the worklet processor under Node with two heads at the stored D: its output equals `render_ring`'s staging
   ring read at its play position, and an effect started in the batch of a song change sounds `size − D` bytes before the song's first
   frame.
5. `galaxy-ring-voice` [oracle] (the ring transport for speech, adopted in §7 item 4): the ring branch, the refill posts and the
   decoder thread with the MPEG decoder as a PCM leaf, against the translation: first audible sample, refills, end, the stereo pair.

Until checks 1 to 5 pass the row stays `MISSING`; its text names the two-head placement, the ring transport and the capture as the
missing parts.

**Status (2026-10-16, branch `claude/galaxy-output-437-5085f1`): all five checks pass.** Check 1
(`validate-galaxy-output-callback.mjs`: 17 cases, 405 callbacks, 809 Locks, 352 of 352 instructions, bit-equal); check 2
(`validate-galaxy-output-poll.mjs`: D = 8,820 bytes in every sample of two polls across a map load, Play's constants equal,
`MUSIC_PAN_PC` changed from 64 to 53 on that evidence); check 3 (`validate-galaxy-output-replay.mjs` on the stored
`replay-training.bin`: 4,851 callbacks, both resyncs, 34,222,080 copied bytes equal, mutants 201, 202, 402, 403 and the replay without
the effect voices all caught at a callback's comparison); check 4 (`validate-galaxy-output-play.mjs`); check 5
(`validate-galaxy-ring-voice.mjs`: 14 cases, 2,631 decoder messages, bit-equal). glxUnloadSample, which the capture's scene calls
(UnregisterSound), is in the kernel and checked against the original by `validate-galaxy-effects.mjs` (case `voices-unload`). Checks 2 and 3
read the main checkout's `.work/audio-output/` and print `SKIP` without it. The row can move to `PASS`; its limits are the exclusions
above and speech's live timing (ring voices are checked against the original's instructions, not against a capture).

## 7. Decisions (adopted 2026-10-16)

The user accepted all six recommendations below on 2026-10-16. Each *Recommended* line is now the decision.

1. **Reproduce the two ring heads in Play?** Music would sound about 0.96 s after effects rendered with it, and effects D later than now,
   as in the original. *Recommended: yes.* It is Galaxy's own code, deterministic given D, cheap (`render_ring` exists and is
   oracle-checked) and audible (music cues against the picture, the intro). The alternative keeps coincident heads and records the
   music delay as an accepted difference; the row then cannot claim the original's output.
2. **D's host part.** *Recommended: measure the write lead on the reference machine (§5.1) and pin `7,056 + lead` as a labelled host
   input.* It is a property of CrossOver's dsound, not of Galaxy; another machine would give another value, as another Windows driver would
   have.
3. **The gate's route.** *Recommended: the Unicorn oracle for the callback, the tracer's poll, then the capture and replay; the loopback
   only as an optional confirmation*, since it cannot be bit-exact and measures the host's mixing as much as Galaxy's.
4. **Speech's ring transport.** Translate glxStartSample's ring branch, the refill posts and the decoder thread's ring logic, with the
   browser's decode as the decoder (4.5.6 stays excluded), or keep the non-ring stand-in and exclude speech timing too. *Recommended:
   translate it.* It is a small piece of Galaxy's own code and restores the 93 ms head start, the end, the four stereo lines and their
   second slot.
5. **Exclusions.** *Recommended: adopt them*: 3D voices (unreachable on the reference machine), ADPCM and the other loaders (none
   shipped), the WinMM fallback and the non-SSE kernels.
6. **The callback schedule.** *Recommended: keep Play's fixed 882-frame callbacks as host timing* and claim bit-equality only under a
   replayed schedule; reproducing the original's jitter is neither possible nor meaningful.
