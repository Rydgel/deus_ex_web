# Audible output: scope for Stage 4 gate row 4.3.7 (2026-10-16)

Row 4.3.7 of [stage-4-exit-criteria](stage-4-exit-criteria.md) ("audible output: the output Galaxy produces for the speakers") is
`MISSING` and had no plan. This note is the plan, for the user to adopt or change. Nothing here is implemented. It records:

1. the chain from Galaxy's mixer to the speakers, in the original and in Play, with the status of each stage (§1);
2. what was traced in Galaxy.dll for it on 2026-10-16 (§2: read from code with capstone, **not** oracle-checked);
3. each open part: what the original does, what Play does, and how it could be measured, with a judgement of each route (§3);
4. the census of the shipped sound formats, ADPCM included (§4, `scripts/census-sound-formats.mjs`);
5. the capture plan for what needs the running original (§5; nothing was run under CrossOver or Wine);
6. a proposed criterion (§6) and the decisions left to the user (§7).

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
| 9 | Ring voices (streamed, compressed or stereo records): glxStartSample's ring branch `0x10612562..0x1061258f`, the refill posts `0x106151f5`, the decoder thread's ring logic | §2.3, §2.4 | **U**. Play plays speech through the non-ring branch from a stand-in record (`effects.rs` `host_sample`), **T** |
| 10 | Hardware 3D voices (`0x10612800`, `0x106126f0`, the A3D/EAX open) | §2.6 | **U**, unreachable on the reference machine (§2.6) |
| 11 | The output buffer: Galaxy's 176,400-byte staging ring `[0x10697ccc]` copied into a 1 s DirectSound secondary buffer `[0x10697cc8]`, 44,100 Hz, 16-bit, stereo, flags `GLOBALFOCUS | GETCURRENTPOSITION2`, looping | [mixer](galaxy-music/mixer.md) §1.2 | the boundary of "the output Galaxy produces". Galaxy never calls SetVolume, SetPan or SetFrequency on the buffer (§2.2) |
| 12 | DirectSound's mixing of the buffer into the device format (kmixer on XP, WASAPI shared mode on Vista and later, Wine's dsound on the reference machine), resampling, the driver and the DAC | | **H** |

### 1.2 Play

| # | Stage | Code | Status |
| --- | --- | --- | --- |
| P1 | Update, PlaySound and the library calls on the simulation side (worker, or the page with `?sim=inline`) | `src/runtime/galaxy-audio.mjs`, `galaxy-music-library.mjs` | **O2** as row 1 |
| P2 | Batches over a MessagePort to the worklet, applied whole between callbacks | `galaxy-music-library.mjs`, `src/viewer/galaxy-music-worklet.mjs` | **H** |
| P3 | The kernel in the worklet: `galaxy_render(882)` = the mixer, then bus A stored and bus B added onto the same frames | `native/galaxy-kernel/src/mixer.rs` `render`, `host.rs` | **O2** for the frames it renders; the placement is the original's resync placement used for every callback (§3.1) |
| P4 | Speech PCM: the page's `OfflineAudioContext(1, 1, rate).decodeAudioData`, channel 0, `pcm16` (round half up, clamp), attached to the stand-in record; the start waits for the decode | `src/viewer/main.mjs` `decodeSpeech`, `galaxy-lipsync-channels.mjs` `pcm16` | substitute, **T**; content excluded with 4.5.6 |
| P5 | The worklet's ring: 2,048 frames, int16 / 32768 into float32, 128-frame quanta | `galaxy-music-worklet.mjs` `render`, `process` | **H** (exact conversion; the latency is the host's) |
| P6 | The AudioContext at 44,100 Hz (refuses any other rate), its destination, the browser's resampler when the device runs at another rate, the OS mixer, the device | `galaxy-music-output.mjs`, `main.mjs` | **H** |

No stage is "translated but unchecked" apart from the speech stand-in (P4 and row 9's substitute). Everything Play computes between the
library calls and the int16 frames is the original's code, oracle-checked; what differs is **where in time** those frames go (rows 6, 7, 9)
and the speech PCM (row 3).

## 2. Galaxy.dll traces of 2026-10-16

Read from the disassembly (capstone over the hash-pinned DLL, a scratch helper outside Git); none of this has been run under the oracle yet.

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

**Play.** `galaxy_render(882)` places both buses on the same frames (the original's resync placement, kept for every callback), so music
and effects rendered together sound together, and an Update's change sounds after the worklet's ring plus the browser's output latency (tens
of milliseconds). The worklet could reproduce the placement exactly: keep a 176,400-byte staging ring, take the worklet's consumption
position as the play cursor and play + D − 7,056 as the write cursor, and run the translated callback (§6, check 1) around the existing
`render_ring`. Effects would then be D later than now, music about 1 s later.

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
| The cursor schedule (R per callback) | Host: the play cursor's granularity (Wine mixes in periods) and timer jitter; the PCM depends on the call boundaries ([mixer](galaxy-music/mixer.md) §5) | Fixed 882-frame callbacks | Poll (§5.1) records R; capture (§5.2) records it for replay. Keep host |
| The timer thread's MXCSR (0x1f80 assumed) | Windows/Wine thread default; Galaxy has no `ldmxcsr` | 0x1f80 | GetThreadContext with `CONTEXT_EXTENDED_REGISTERS` on the game's threads in §5.1 (whether Wine fills the FXSAVE area for that flag is unverified) |
| The pan table's precision (`[0x10698390]`, 64 KB, built at Init after D3D's setup) | PC 24, 53 or 64 give different tables ([mixer](galaxy-music/mixer.md) §4) | PC 64 (`MUSIC_PAN_PC`) | One read of the table in §5.1 against the three variants: exact |
| The heap behind the mixer's two hazards (reads before a sample, negative run counts) | Real heap contents | The bump-heap model | Only a live heap dump; rare songs; leave open |
| The DirectSound or WinMM path, the kernel taken | DS expected (`[0x10698178] = 1`), SSE kernel (`[0x10697cfc]`) | DS-shaped, SSE | §5.1 reads both |

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

## 5. Capture plan (the running original; not run)

Nothing here was run: another session uses the bottle. All of it follows the existing live tooling: `tools/dx-live-win.c` built as
`ad/build/dx-live-win.exe` (`i686-w64-mingw32-gcc -O2 -o ad/build/dx-live-win.exe tools/dx-live-win.c -lpsapi`), the game started by
`node ad/scripts/original-game.mjs launch <map>.dx` under the lock that `scripts/live-original.sh` takes (`.work/wine-deusex.lock`), and the
tracer run with `$DX_WINE` (Mac: `CX_BOTTLE=DeusEx /Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine`; Linux host:
`WINEPREFIX=~/.wine-deusex wine`). Store the results under `.work/audio-output/` (outside Git). Resolve Galaxy.dll's load base in the
process (as the tracer does for Core and Engine) and rebase every address below.

### 5.1 `dx-live-win.exe galaxy poll <count> <interval_ms>` (new mode, read-only)

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

### 5.2 `dx-live-win.exe galaxy capture <config>` (new mode, debugger)

For a bit-exact replay. Breakpoints:

* `0x106142bf` (the callback holds the lock): a `cb` record with the QPC time;
* `0x106142d9` (after GetCurrentPosition): play `[esp+0x20]`, write `[esp+0x24]`;
* `0x10614657` (after the copies): R (`ebx`), A and B before the advance, `ahead`, and the bytes `[A, A+R)` and `[B, B+R)` of the staging ring
  `[0x10697ccc]` (wrapping); for the resync branch (`0x10614387`), the whole 176,400-byte ring after its copy (`0x10614447`);
* the library entries, each logged **after its EnterCriticalSection returns** (so the game thread's calls order correctly against the timer
  thread's), with their arguments and return value: glxStartSample, glxControlSample, glxControlVoice, glxStopSample, the music and effects
  master setters (`0x1060eb60`, `0x1060ec00`), glxLoadMusic `0x10618be0` (with the UMusic's name from RegisterMusic's caller), glxStartMusic
  `0x106122a0`, glxStopMusic `0x106183a0`, glxUnloadMusic `0x10619450`, glxControlMusic `0x1060d0e0`, glxSetSampleReverb `0x106113d0` (its
  0x6c-byte block), glxLoadSample `0x10618e60` (with the USound's path from RegisterSound `0x10606af0`), and Update's inline library stores
  that `host.rs` already names (`galaxy_music_clear_active`, the voice `+0x0f` stores at `0x1060a83d`; `galaxy_music_break`, `[0x10697ca8] = 1`
  at `0x1060a88d`; [update-transition](galaxy-music/update-transition.md) §2). This is the op set of `galaxy-music-library.mjs` `MUSIC_OP`, so the
  replay feeds the existing host entries.

Window: arm at a LoadMap (SetViewport's stop loop clears the effect voices; Update loads the map's song fresh), and at the first callback
after it snapshot, under the lock, the voice table (`0x1068dca0`, 256 × 0xa0), Galaxy's globals block (`0x10697c00..0x10698400`, which holds
the heads, counters, tick lengths, masters and the reverb state) and the reverb context if any. Every sound registered before the window
is mapped from its handle to its USound name by a registry dump (each USound's `+0x50`). Scene: 00_Training from its load, 30 s: the song's
load and start, the ambient voices, the player's footsteps, a LightSwitch click; then a `MUSICORDER 2` console command with an ambient voice
playing (the resync of §2.2).

Replay (a new validator): the translated library opened as the snapshot says, the samples and the song loaded from the packages by
name, the logged ops applied in order between callbacks, and each callback run by a Rust translation of `0x106142a0` fed the logged
`(play, write)`; every copied byte and position compared with the log. The breakpoints slow the game: the schedule is whatever it was, and
it is recorded.

### 5.3 Loopback (optional, confirmation only)

* Mac: route CrossOver's output to the installed BlackHole 2ch device and record it with `ffmpeg -f avfoundation -i ":BlackHole 2ch" -ar
  44100 out.wav`; set the device to 44,100 Hz in Audio MIDI Setup first, or dsound and CoreAudio resample.
* Linux host: PipeWire runs at 48 kHz float by default; create a sink at the game's rate (`pactl load-module module-null-sink sink_name=dxloop
  rate=44100 channels=2`), point Wine at it, record with `parec -d dxloop.monitor --rate=44100 --channels=2 --format=s16le --file-format=wav`,
  and check PipeWire's allowed rates so the graph does not resample.
* Scene: a known effect started in the same frame as a song section change, and the offset between their onsets measured by
  cross-correlation with the sounds' own PCM. Expected: about 960 ms minus the write lead measured in §5.1.

## 6. Proposed criterion for row 4.3.7

**Scene and claim.** "Galaxy's output buffer": for a recorded scene of the running original (00_Training from its LoadMap, 30 s, §5.2),
every byte the timer callback copies into the DirectSound buffer, and the ring position it lands at, equals what the translated library
produces when replayed with the original's library calls and cursor positions; and Play's worklet places bus B D bytes ahead of bus A as
the original does, with D the measured value. Evidence O1 (the stored capture) and O2 (the callback oracle).

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
3. `galaxy-output-replay` [stored capture + oracle]: §5.2's replay, every copied byte equal.
4. `galaxy-output-play` [node]: the worklet processor under Node with two heads at the stored D: its output equals `render_ring`'s staging
   ring read at its play position, and an effect started in the batch of a song change sounds `size − D` bytes before the song's first
   frame.
5. If the user adopts the ring transport for speech (§7, item 4): `galaxy-ring-voice` [oracle], the ring branch, the refill posts and the
   decoder thread with the MPEG decoder as a PCM leaf, against the translation: first audible sample, refills, end, the stereo pair.

Until checks 1 to 4 pass the row stays `MISSING`; with the exclusions adopted its text would name the two-head placement, the ring
transport (if adopted) and the capture as the missing parts.

## 7. Decisions for the user

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
