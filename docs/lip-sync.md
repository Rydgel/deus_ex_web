# Conversation lip sync (Galaxy.dll)

Status: implemented in Play (October 1, 2026). The analysis is bit-exact
with Galaxy.dll on its inputs; the inputs themselves (the decoded speech and
the mixer position) are host measurements, real-time in the original too.

Files: `native/script-vm/src/lipsync.rs` (the analysis, Rust), the
`lipsync` group of `src/runtime/script-vm-kernel.mjs` (its bindings),
`src/runtime/galaxy-lipsync-channels.mjs` (the channels and the update),
`src/viewer/game.mjs` `lipSyncServices` (IsA Pawn, bIsSpeaking,
nextPhoneme) and `src/viewer/main.mjs` (the speech decode and the per-frame
update). Validators: `validate-galaxy-lipsync` (kernel against the original)
and `validate-island-lipsync` (MeetPaul end to end).

## Who drives the mouth

`Pawn.LipSynch(deltaTime)` (Pawn.uc) runs from the Tick of
`ScriptedPawn` state Conversation and of DeusExPlayer's conversation states.
While `bIsSpeaking` it maps `nextPhoneme` to a blend animation:
"A" MouthA, "E" MouthE, "F" MouthF, "M" MouthM, "O" MouthO, "T" MouthT,
"U" MouthU, "X" MouthClosed, and calls `TweenBlendAnim(seq, tweentime)` when
the letter changes. `ConPlay.StartSpeakingAnimation` sets `bIsSpeaking` and
`bWasSpeaking` on the speaker; `StopSpeakingAnimation` clears `bIsSpeaking`.

No script writes `nextPhoneme`. The only native writer is the audio
subsystem: `UGalaxyAudioSubsystem::Update` (Galaxy.dll, body `0x10609510`,
export thunk `0x10601136`) analyses the speech it is playing and copies a
one-letter string into `APawn.nextPhoneme` (+0x588, FString; `bIsSpeaking` is
bit 0 of +0x578; offsets from `scripts/sdk-layouts.mjs --class APawn`).

## Channels and timing

`PlaySound` (`0x10608100`, export `0x10601221`) fills a 64-byte channel
record: +0x04 Actor, +0x08 Id, +0x10 the USound played, +0x14..+0x1c
location, +0x20 volume, +0x24 radius, +0x28 pitch, +0x2c Sound, +0x30 time
= 0.0, +0x34 next analysis time = 0.0, +0x38 = -1.0 (see below). +0x00 is the
Galaxy voice once it plays.

`Update` measures wall-clock time (`appSeconds`, or rdtsc ×
`GSecondsPerCycle` with `GTimestamp`), subtracts the previous update's
(+0x880 of the subsystem), clamps the double delta to [0, 1]
(`0x10609595..0x106095e8`) and, per active channel, stores
`time = float(time + delta)` (`0x10609a3c`, fld dword / fadd qword / fstp
dword). So lip sync follows real time, once per audio update (each frame),
not game time.

Analysis runs for a channel (`0x1060a05b..0x1060a0d4`) when:

* its voice (+0x00) is non-null;
* its Actor is non-null and the sound id's slot is SLOT_Talk
  (`(Id & 0xf)` is 10 or 11, `0x10609c86..0x10609ca3`);
* the Actor IsA Pawn (class chain walk against APawn's static class);
* `time >= next` (`fld [+0x30]; fcomp [+0x34]`, C0 skips);
* the Pawn's `bIsSpeaking` is set.

After an analysis `next = float(next + 0.1)` (double 0.1 at `0x1063d768`,
`0x1060a259`). When `bIsSpeaking` is clear, `next` does not advance.

## The analysed window

The voice's format word (+0x4c) is copied from the sample record's (+0x2c)
when the voice starts (`0x1061207c`); bit 4 means 16-bit, so bytes per
sample is `(flags & 4) ? 2 : 1` (`0x1060a0da..0x1060a0e8`).

Speech in `DeusExConAudio*.u` is MP3 (frames `FF FB 30 C4`: MPEG-1 Layer III,
44.1 kHz, mono). Galaxy's loader (`0x10618e60`, called by RegisterSound
`0x10606bac` with a memory descriptor `{'MEMO', 0xc, data, size}` and flags 2)
was run under Unicorn on `ConAudioMission01_0`: the record's format word is
`0x4024` (0x4000 streamed, 0x20, 0x04 16-bit), +0x30 is the MP3 byte length
(11076), +0x3c the rate (44100), +0x44 the data.

A streamed voice (`0x10612049..0x106120f7`) decodes into a zeroed 64 KB
buffer: start/loop start +0x52 = buffer (in sample units), loop end +0x56 =
end +0x5a = start + 0x7fff, position +0x46 = start. The mixer (base
`voice + 0x14`, e.g. `0x10615460..0x10615507`) advances `[voice+0x46]` as it
mixes, so +0x46 is the mixer's read head.

For a streamed record (`format & 0x4000`, `0x1060a0e9`), the window starts at
ring position `[0x46] - [0x52]`, the data is the ring (`[0x52] * bps`), and
the end is `[0x56] * bps`: the next 1024 samples to be mixed, zero-filled
past the end of the ring (no wrap). Non-streamed records instead use the
record's data from `int(int(rate × time) + rate × 0.1)` (0.1 s ahead), which
speech never takes.

+0x38 is set once per channel to `0x10608bd0`'s mean absolute amplitude of the
whole buffer and is never read again; it is not observable.

## The analysis (bit-exact targets)

1. `0x10609180` (data, start, bps, end): for 1024 samples, `w[i]` = the
   16-bit sample (unsigned `hi<<8|lo`, minus 65536 above 32767; 8-bit:
   byte × 256 then the same) or 0 past the end, times `(1 - |i - 1024| ×
   (1/1024))` (a ramp, i/1024) times 1/32768. For 8-bit the index is
   `byteOffset >> 1`, so samples land in the first 512 slots (unused by
   speech).
2. `0x10609310`: 1024-point radix-2 FFT, 10-bit bit-reversed copy of `w`
   into real `0x10676890` with imaginary `0x10674858` zeroed, twiddles by the
   recurrence `w = 2·cos(δ)·w1 − w2` with `δ = float(2π_f / m)`, stage
   values from x87 `fsin`/`fcos` (the cosines stay on the x87 stack).
3. Inline (`0x1060a1be`): `real[i] = |real[i]|` for 1024 bins.
4. `0x10608d70(rate)`: result defaults to "X". `n = ftol(300 × 1024 /
   float(rate))`; the mean of bins `0..n` gates it, then the peak bin among
   the first 512 must exceed 5.0; its frequency
   `ftol(index) × rate × (1/1024)` picks T (>2000), F (>1500), A (>600),
   O (>400), U (>250), else E. "M" is unreachable (its threshold, 1000, is
   tested after `≤ 250`).

The FFT's `fsin`/`fcos` are x87 transcendentals; Unicorn computes them in
double, so their extended results must be measured on hardware
([[native-oracle-not-authoritative-x87-transcendentals]] in the project
memory). Galaxy's Update runs on the game thread: the D3D control-word
question (single precision under FPUSETUP) applies as everywhere else; this
work assumes 0x037f like the other oracles.

## Hardware twiddles

`tools/galaxy-fft-twiddle-probe.c` runs the exact setup sequence for every
stage on a real x87 (CrossOver/Rosetta, control word 0x037f) and prints
sin(-2d) and sin(-d) as stored floats and cos(-2d), cos(-d) as 80-bit values;
the table is in `lipsync.rs` (`TWIDDLES`) and the local capture in
`.cache/galaxy-fft-twiddles.csv` (status word 0x0020, inexact only). Each
stage's cos(-2d) equals the previous stage's cos(-d), as the inputs are exact.

```
i686-w64-mingw32-gcc -O1 -o .cache/galaxy-fft-twiddle-probe.exe tools/galaxy-fft-twiddle-probe.c
CX_BOTTLE=DeusEx /Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine \
  .cache/galaxy-fft-twiddle-probe.exe > .cache/galaxy-fft-twiddles.csv
```

## Validation

`scripts/native-galaxy-lipsync-oracle.py` runs Galaxy.dll (hash
`606e71d1…`) unchanged in Unicorn over the whole block `0x1060a0da..0x1060a268`
with a fabricated channel, voice ring, record, pawn and locals frame. Two
boundaries are replaced: Core `FArray::Realloc` (the FString growth) and
MSVCRT `wcslen` are Python bridges, and after each FFT `fsin`/`fcos` the
emulator's ST(0) (`FP[TOP]`, written as a (significand, sign/exponent) pair)
takes the hardware value. A `classify` mode runs `0x10608d70` alone on crafted
bins.

`validate-galaxy-lipsync` compares the Rust kernel with it on 200 analyses
(sines on every band and on the bin edges of each threshold, near-tie
two-tone mixes, an amplitude sweep across the 5.0 gate, noise, square waves,
positions near the ring end, silence and 60 windows of Island speech decoded
by ffmpeg when it is installed): every window, FFT real and imaginary float32
and the letter match bit for bit, all seven reachable letters occur, and
`next` becomes 0.1. 180 classifier cases cover exact ties across bands (the
first maximum wins), the 5.0 gate and one float above, the mean gate with
negative bins, NaN and infinite bins, signed zeros and ten rates from 301 to
200000. Of eight planted mutations seven fail it; the survivor (comparing the
first band's frequency after its float store) is equivalent, since
`index * rate / 1024` near 2000 Hz is below 2^24/1024 and exact in float. The
original's results are cached in `.cache/galaxy-lipsync-reference-*.json` by
input, oracle and twiddle table.

`validate-island-lipsync` runs MeetPaul headless to its first choice and feeds
the speech the player hears through the channels (PCM from ffmpeg, position
from the channel's own time): Paul's speech is on SLOT_Talk, the opening
DataLink's non-Talk channel is never analysed, every analysis follows 0.1 s of
channel time with `next` advancing by float sums (the one non-Talk speech,
the opening DataLink, plays on JC in slot 0), Paul's `nextPhoneme` takes
several letters, and Pawn.LipSynch tweens only `Mouth*` sequences into blend
slot 0. In the browser, Paul's letters and mouth sequences follow the playing
speech (sampled every 100 ms) on his channel 571418 (35713 << 4 | Talk).

## Inputs that only the host can supply

These are real-time in the original and differ run to run there too:

* the decoded PCM: Galaxy's own MP3 decoder output (not translated). The
  host decodes the same MP3 at its native rate (an OfflineAudioContext at
  44100, since the default context resamples) and converts to 16-bit; the
  decoder's output and rounding are unverified against Galaxy's.
* the mixer position at each update: from the playing source,
  `(currentTime − start) × rate × playbackRate`, taken modulo the 0x7fff
  ring length; assumes the decoder stays ≥ 1024 samples ahead of the mixer.
* channel lifetime: created from the conversation speech request
  (ClientHearSound), ended by StopSound or when the source ends (the
  original polls the voice's state, `0x1060cf00`).
* the update runs once per Play frame after the game tick with the frame's
  wall-clock delta. The original's `Audio->Update` is called from
  `UGameEngine::Draw` (`0x1038f638`, Audio vtable +0x60 with the view's
  PointRegion and the frame's Coords, right after the master frame is
  created), not from `UGameEngine::Tick` (which never reads `Audio`, +0x4c):
  each frame the level tick, where LipSynch reads `nextPhoneme`, comes before
  the update that writes it, so a letter takes effect at the next tick, as in
  Play. A failed second decode (the 16-bit PCM) leaves that speech without
  lip sync and is counted in `status().audio.lipSyncFailures`.
* a speech that is not MP3 (no MPEG frame header) gets no lip sync: the
  non-streamed path (record data, 0.1 s ahead) is not translated.

## Not done

* Cost: one analysis takes about 2.4 ms (the Wasm kernel on the reference
  M2 Pro, Node), once per 0.1 s of a speaking channel: a spike every sixth
  frame or so at 60 fps during speech, against the 8.3 ms frame budget. Most
  of it is the 80-bit model's u128 arithmetic in the FFT; a faster exact path
  (float products are exact in f64, only the extended sums need care) is
  future work, measured against this kernel.

* Galaxy's MP3 decoder is not translated; the host's decode and its float to
  16-bit rounding are unverified against it.
* Whether the decoder stays at least 1024 samples ahead of the mixer, so the
  window never holds stale ring data, is assumed.
* The D3D control-word question (single precision under FPUSETUP) is open as
  for every x87 translation; this one assumes 0x037f.
* Lip sync for speech heard without ClientHearSound's conversation transport
  (barks through other PlaySound sites) is not wired.
