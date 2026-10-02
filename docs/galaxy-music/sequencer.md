# C — Galaxy module sequencer (IT music player)

Galaxy.dll SHA256 `606e71d1…` (preferred base 0x10600000). Research only; every
claim is anchored to an instruction or data address. Status tags:

- **[read]** read directly in the instructions cited.
- **[derived]** follows from the cited code by control-flow reasoning, not yet run.
- **[B]** read in the IT loader `0x10628990`; agent B owns the loader and should confirm.
- **[host]** depends on run-time history or the host's render sizes; not deterministic from the song.

Raw offsets only. "voice" = Galaxy's 0xa0-byte voice record; "ch" = music channel 0..31.

## 0. Corrections to the existing notes

1. `0x1060e840` is **not** a library tick: it is `EnterCriticalSection(0x1067b670); return 0`
   (`0x1060e840..0x1060e84d`). `0x10618920` is the matching unlock
   (`LeaveCriticalSection(0x1067b670)`, `0x10618920..0x1061892d`). `Update` locks at
   `0x10609549` and unlocks at `0x1060abd6`, so the whole Update (music load → SetVolumes →
   start → set position) is atomic with respect to the mixer thread. [read]
2. `docs/galaxy-audio.md` (§Update step 14) has the two bytes swapped:
   **SongSection = PlayerPawn +0x674, CdTrack = +0x675**. Evidence: SDK
   `Engine/Inc/EngineClasses.h` (DX 1112f, line 1819–1822: `Song; SongSection; CdTrack;
   Transition`), Update passes `[edx+0x674]` to `glxControlMusic` at `0x1060a85a..0x1060a863`
   under the assert string `glxControlMusic( GLX_SETPOSITION2, Viewport->Actor->SongSection )`
   (`0x1064a34c`) and `[eax+0x675]` to `glxStartCDAudio` at `0x1060a8e9..0x1060a8f3` under
   `glxStartCDAudio( Viewport->Actor->CdTrack, … )` (`0x1063cd5c`). [read]
3. Music API names (from the subsystem's assert strings, `0x1063cc14..0x1064a44c`):
   `glxLoadMusic(&Mem, GLX_LOADFROMMEMORY=2)` = `0x10618be0`; `glxStopMusic()` = `0x106183a0`;
   `glxStartMusic()` = `0x106122a0`; `glxControlMusic(cmd,arg)` = `0x1060d0e0`;
   `glxUnloadMusic()` = `0x10619450`; `glxStartCDAudio` = `0x10611c70`; `glxStopCDAudio` =
   `0x10618290` (MCI only); `glxSetCallback` = `0x1060e980`; `glxSetSampleReverb` =
   `0x106113d0`. Console `MUSICORDER n` (`0x10649f98`) → `glxControlMusic(1, n)` at `0x106071a8`.

## 1. Architecture and threading

| Piece | Address | Role |
| --- | --- | --- |
| Timer callback | `0x106142a0` | `timeSetEvent(period/2, …, 0x106142a0, …, TIME_PERIODIC)` at `0x10613aee`; locks `0x1067b670`, polls HW voices (`0x106126f0`), locks the DirectSound ring and calls the renderer. |
| Renderer | `0x106146a0` | Calls the mixer `0x10614920` in runs, then the 4 effect units (`[0x10684ea8]`,`[0x10688288]`,`[0x10698388]`,`[0x106981c8]`), then the output converter `[0x10697ca4]`. |
| Mixer | `0x10614920` | Per call ≤ 0x200 samples (`0x1061492a..0x1061493c`). Owns both tick counters; runs the **voice update** (envelopes, porta, LFOs, period→step) and the **sequencer tick**, then mixes. |
| Sequencer tick | `0x10615710` | Pattern/order bookkeeping; calls the format's track handler. |
| IT track handler | `0x10616eb0` | Row parsing + effect dispatch (mode `[0x10697ce8]&6 == 2`). |
| Note-delay trigger | `0x10617d40` | EDx note trigger. |
| Post-tick ramps | `0x10617f50` | Master music/SFX volume ramps, per-voice channel-volume ramp → `+0x12`. |
| Period → step | `0x10615660` | Linear/Amiga frequency and 16.16 step. |
| Reset (in load) | `0x1060e850` | Called by `glxLoadMusic` at `0x10618c12` before the format loader. |

Track handler choice (`0x106157fc..0x10615823`): `[0x10697ce8] & 6` = 0 → `0x106168b0`,
2 → `0x10616eb0`, 4 → `0x10615a60`. The IT loader sets `[0x10697ce8] = 2 | !(IT flags & 8)`
(`0x1062a30f..0x1062a323`) [B]: bit0 = Amiga slides, bit1 = tracker timing. So IT always
runs `0x10616eb0`; Endgame1/2 (IT flags 0x13, no linear bit) get value 3 (Amiga).
Handlers `0x106168b0`, `0x10615a60` and the MIDI path were **not analysed**.

Everything in the sequencer path is integer arithmetic; see §10 for the only x87 code.

## 2. Timing

### 2.1 Two 16.16 counters inside the mixer

| Global | Meaning | Reload |
| --- | --- | --- |
| `0x10698204` | voice-update countdown | `+= [0x10697d20]` at `0x1061518a..0x10615196` |
| `0x1069834c` | sequencer countdown | `+= [0x1069818c]` at `0x10615213..0x10615224` |
| `0x10697d18` | output rate (dword; init 0x5622 = 22050 at `0x1060e12e`, set by `0x10613a0a`) | |

Per mixer iteration (`0x106149fc..0x10615229`) [read]:

```
n    = (count - done) << 16
if [0x10698204] < n: n = [0x10698204] & 0xffff0000
if [0x1069834c] < n: n = [0x1069834c] & 0xffff0000
[0x10698204] -= n
if [0x10698204] < 0x10000: voice update for voices 0..[0x1068828d]+[0x10698348]-1; [0x10698204] += [0x10697d20]
[0x1069834c] -= n
if [0x1069834c] < 0x10000:
    call 0x10615710 (sequencer tick)
    post PostThreadMessageA(…,0x400,…) for finished SFX voices (0x106151b0..0x1061520c)
    call 0x10617f50 (ramps)
    [0x1069834c] += [0x1069818c]
mix n>>16 samples for every active voice
```

So a tick fires at the **start** of the chunk whose length is the integer part of the
counter; the samples of that chunk already use the new state. Tick k lands at sample
`t(k+1) = t(k) + floor(c(k))`, `c(k+1) = frac(c(k)) + P`. When both counters expire in the
same iteration the **voice update runs before the sequencer tick** (it then uses the previous
tick's effect state). [read]

### 2.2 Tick period

Computed identically at `0x10613a10..0x10613ac4` (rate change), `0x106158c7..0x10615978`
(song start, order 0) and `0x10617ba1..0x10617c47` (Fxx) [read]. With `T = [0x10698188]`
(word, tempo), `S = [0x10698342]` (word), `R = [0x10697d18]`, all unsigned 32-bit `div`:

- tracker mode (`[0x10697ce8] & 2`, IT): `D = 2*T`;
  `P = ((5R / D) << 16) + (((5R % D) << 16) / D)`; `[0x1069818c] = [0x10697d20] = P`
  (voice update and sequencer share the period).
- MIDI mode: `D = T*S`; `P = ((60R / D) << 16) + (((60R % D) << 16) / D)`;
  `[0x10697d20] = (R << 14) * 0x10624dd3 >> 32 >> 4` (= R·65536/1000, 1 ms).

Example, Intro (T=153): R=22050 → P = 360·65536 + 19275 (360.2941 samples);
R=44100 → 720·65536 + 38550.

Initial values at glxInit: `[0x10698204] = [0x10697d20] = 0x160ccc`,
`[0x1069834c] = [0x1069818c] = 0xe5b000` (`0x1060e164..0x1060e17d`). Neither countdown is ever
reset on load/start, so the **phase of the first tick and the phase offset between voice
update and sequencer are history-dependent** [host] (see §12).

### 2.3 Rows and ticks (track handler `0x10616eb0`)

Track record (pattern + 0xc, 0x1c bytes; IT patterns have one track, `[pat+8] = 1` set at
`0x10629a85` [B]): `+0x10` tick countdown, `+0x14` read pointer (0 = not started/finished),
`+0x18` data start. Globals: `0x10697ce6` tick-in-row (word), `0x10698342` speed (word),
`0x10698141` current row (byte, 0xff before the first row), `0x106981cc` last row index,
`0x1068828c` pattern-delay count, `0x10697ca8` break flag, `0x10698140` "skip rows + 1".

Per call [read]:

1. `+0x14 == 0` → start: `+0x10 = 0`, `+0x14 = +0x18`, first byte → `0x106981cc`
   (the loader stores rows−1 at `0x10629b3c..0x10629b4c` [B]), go to row tick.
   Else if `+0x10 != 0` → effect-only tick (step 7).
2. Row tick (`0x10616f05`): `tick = 0`; `speed = [0x10698342]`.
3. Pattern delay `[0x1068828c] != 0` → decrement (`0x106173fa`), **no parse**, run effects with
   tick 0 on the unchanged cmd/param (step 7).
4. Break flag set, or `row == [0x106981cc]` → pattern ends: read pointer = 0, but the
   effect loop still runs once with tick 0 on the **previous row's** cmd/param (step 7).
5. Clear per-row fields of every music voice (`0x10616f4b..0x10616f8e`): `+0x6e +0x70 +0x78
   +0x7a +0x7e +0x80` (words) and cmd `+0x86`, param `+0x87`.
6. Row skip after a break (`0x10616f90..0x10616fd9`): while `[0x10698140] > 1`, skip one row of
   events (flag byte; +2 if 0x80, +2 if 0x40, +1 if 0x20; until a 0 byte), `[0x10698140]--`,
   `row++`. No bounds check against the pattern length. Then parse one row (§5) and `row++`
   (`0x106173d4`).
7. Effect loop over all music voices (`0x10617408..0x10617c6e`), §6.
8. End (`0x10617c7c..0x10617cb0`): if `tick == 0` reload countdown from the **current** speed
   (so Fxx on tick 0 applies to this row); `tick++`; `+0x10 = countdown − 1`; `+0x14 = ptr`.

A row therefore lasts `speed` ticks; speed 1 parses every tick.

**Pattern-end extra pass [derived]**: when a pattern ends (step 4) the effect loop runs with
tick 0 on the old row, then `0x10615710` advances the order and calls the handler again in
the **same** tick, which parses row 0 of the next pattern and runs the effect loop again
with tick 0. Tick-0 actions of the last parsed row (or the row that set the break) execute
twice: 9xx re-sets the sample position, EAx/EBx fine volume slides apply twice, E9x
retriggers, EDx with x=0 retriggers, E6x decrements the global loop counter twice. Fine porta
(E1x/E2x) is cleared by the row-0 clear before the next voice update, so it is not doubled.
In the shipped songs, pattern-ending rows carry 86 O (9xx) and 22 Q (E9x) commands (scan of
all 35 songs in conversion order).

### 2.4 Order list (`0x10615710`)

Globals: `0x10698201` current order (byte, 0xff = before start), `0x10698220[256]` order
bytes, `0x1069834a` last playable order index, `0x10697d40[256]` pattern pointers,
`0x10698208` current pattern, `0x10698349` playing, `0x10698200` loop flag (1 after reset).
The IT loader sets `0x1069834a = (index of the first 0xff, or OrdNum) − 1`
(`0x10628aa8..0x10628c20`) [B].

When no pattern is current (`0x10615860..0x10615a4e`) [read]:

1. Callback `[0x1069838c](0, &[0x10698208], 0)`. DX installs `0x10604220`
   (`0x10605673`), which, like the default `0x1060e310`, just stores 0. No host patterns.
2. `order++` (byte); break flag = 0; `row = 0xff`.
3. If the new order is 0: `speed = [0x10697cea]`, `tempo = [0x1069817e]` (IS/IT from the
   header, `0x10628a8d..0x10628aa1` [B]), recompute P (§2.2), and set each music voice's
   pan `+0x14 = +0x16 = [0x106886c0 + ch] << 8` (`0x1061597e..0x106159b9`).
4. If `order <= [0x1069834a]` and `orders[order] != 0xff`: a value ≥ 0xfe (`+++`) is skipped;
   otherwise `pattern = [0x10697d40 + 4*orders[order]]`. **A null pattern pointer is also
   skipped** (loop back to 2). The loader converts only patterns with a non-zero file offset
   (`0x10629a14..0x10629a1f`) [B]; IT's empty patterns (offset 0) are therefore skipped
   instead of playing 64 empty rows. 21 songs have such an entry at order 2 (25 songs have
   at least one). [derived]
5. Else (past the end or 0xff): `playing = 0`, `order = 0xff`; if loop flag, `playing = 1`
   and continue at 2 (wraps to order 0 → step 3 resets speed/tempo/pan). [read] If the loop
   flag is 0 the callback is called and, since it returns no pattern, the walk still restarts
   order 0 within this tick, with `playing = 0` stopping later ticks
   (`0x10615a15..0x10615a4e`) [derived; DX never clears the loop flag].

The new pattern's first row is parsed in the same sequencer tick.

### 2.5 Start / section request

- Reset `0x1060e850` (in `glxLoadMusic`): `speed = 0x30 (48)`, `tempo = 0x78 (120)`,
  `[0x10697cea] = 48`, `[0x1069817e] = 120`, `order = 0xff`, pattern = 0, break = 0,
  skip = 1, loop flag = 1, `[0x10697cf0] = 0x7f`, porta limits `0x106886a6 = 0`,
  `0x10698180 = 0x7800`, mode = 0; every voice from `[0x1068828d]` to 255 zeroed then
  `+0x0c=0xbc, +0x12=0x4e20, +0x14=+0x16=0x4000, +0x1a=0x7fff, +0x1c=0, +0x1e=0x28,
  +0x3f=+0x41=0x64` (`0x1060e879..0x1060e8e9`). Refused (returns 2) while playing. [read]
- The IT loader then sets IS/IT, last order, pans, mode, `0x106886a6 = 0x1c5`,
  `0x10698180 = 0xff00` (`0x1062a337..0x1062a340`) and channel count `[0x10698348]` =
  highest used channel + 1. It does **not** set the current speed/tempo. [B]
- Update (`0x1060a815..0x1060a88d`): when SongSection ≠ 255: `glxStopMusic`, clear `+0x0f`
  of 32 voices from the subsystem's first music voice, `glxStartMusic` (playing = 1, music
  voices `+0x10 = 1`), `glxControlMusic(2, SongSection)`, then `[0x10697ca8] = 1`.
  SongSection = 255 → only `glxStopMusic`.
- `glxControlMusic` (`0x1060d0e0`): cmd 1 and 2: `N = arg`; if `N < 0`, `N += order + 2`;
  if `N > [0x1069834a]` return 0x11 (no change); else `order = N − 1`. Cmd 1 also sets the
  break flag and zeroes `[0x10697cdc]` (ring fill count) under a nested lock. Cmd 3: loop
  flag = arg.

Consequence [derived]: section N is reached by the first sequencer tick's `order++`. For
N = 0 (or N past the end) the order wraps through 0 and speed/tempo/pans are reset from the
header. **For N > 0 nothing is reset**: speed stays 48 and tempo 120 from the reset, the
tick period stays whatever `[0x1069818c]` held (the previous song's, or glxInit's), and the
voices' pans stay 0x4000, until an Fxx in the pattern recomputes them. In the shipped songs
most orders start with both A and T on row 0 (table from a scan of all songs); orders
without them would play at speed 48.

## 3. Global state (sequencer)

| Address | Size | Meaning | Key refs |
| --- | --- | --- | --- |
| `0x1068828c` | b | pattern delay count | `0x10617b50`, `0x106173fa` |
| `0x1068828d` | b | number of SFX voices = index of music voice 0 (init 8, `0x1060e0ef`) | everywhere |
| `0x10698348` | b | music channel count | loader `0x1062a296`, `0x1062a331` |
| `0x10698349` | b | playing | `0x106122eb`, `0x106183e6`, F00 `0x10617c4f` |
| `0x10698201` | b | current order | §2.4 |
| `0x10698141` | b | current row | `0x106173dc` |
| `0x10698140` | b | rows to skip + 1 | `0x1061790f`, `0x10617a2a` |
| `0x106981cc` | b | last row index of current pattern | `0x10616eea` |
| `0x10697ca8` | b | break flag | `0x1061789e`, `0x10617915`, `0x10617a30`, Update `0x1060a88d` |
| `0x10697ce6` | w | tick in row | `0x10616f05`, `0x10617c98` |
| `0x10698342` | w | speed (ticks/row) | `0x10617b9a`, `0x106158b4` |
| `0x10698188` | w | tempo | `0x10617b8e`, `0x106158c1` |
| `0x10697cea`/`0x1069817e` | w | initial speed / tempo | loader |
| `0x1068dc81` | b | pattern-loop start row (global) | `0x10617a4e` |
| `0x10697d1c` | b | pattern-loop counter (global) | `0x106179f1..0x10617a10` |
| `0x106886a6` | w | porta-up limit (IT: 0x1c5) | `0x10617501`, `0x10617960` |
| `0x10698180` | w | porta-down limit (IT: 0xff00) | `0x10617532`, `0x1061798f` |
| `0x10697cf0` | sb | music master volume (current) | §8.3 |
| `0x106886a5`/`0x106886a4` | sb | its target / step | `0x1060eb60`, `0x10617f50` |
| `0x10697ce0` | d | free-running sequencer tick count (incremented every call, `0x10615715`) | |

## 4. Voice record (base `0x1068dca0 + v*0xa0`; music ch → `v = [0x1068828d] + ch`)

Only fields the player or the voice update touch; names are descriptive, not symbols.

| Off | Size | Meaning | Written |
| --- | --- | --- | --- |
| +0x0c | b | note (0..119; bit 7 = key off) | `0x106170ce`, `0x1061738e` |
| +0x0d | b | instrument index (IT inst − 1) | `0x10617055` |
| +0x0e | b | sample index within instrument | `0x1061717b` |
| +0x0f | b | active (mixer + voice update gate) | 0 at `0x10617108`, 1 at `0x10617342`; 0 by key-off `0x10614f1a`, end `0x10615555` |
| +0x10 | b | enabled (start/stop music) | `0x106122e0`, `0x106183db` |
| +0x11 | b | 0x80 = music voice (selects music buffers and master) | `0x10617189` |
| +0x12 | w | channel-volume gain `2·(+0x3f)²` (music: 20000) | `0x106180f1` |
| +0x14/+0x16 | w | pan current / target (bit 15 = surround) | §8.4 |
| +0x18 | w | velocity gain (IT: 0x7fff at every note) | `0x106170c6` |
| +0x1a | w | gain (0x7fff from reset) | reset |
| +0x1c/+0x1e | w | send 2 / send 1 levels (/128; reset 0 / 0x28) | reset |
| +0x20 | d | LFO/envelope block pointer (instrument +0xaa, or sample `+0x40`) | `0x1061714f`, `0x10617194` |
| +0x24..+0x3e | | three envelope states, §9 | |
| +0x3f/+0x40/+0x41 | b | channel volume current / step / target (100/–/100) | `0x10618089..0x106180dd` |
| +0x42 | d | sample record pointer | `0x10617174` |
| +0x46 | d | position (sample units) | `0x106171a3`, 9xx `0x106177fa` |
| +0x4a | w | position fraction | |
| +0x4c | w | sample format flags (copy of sample `+0x2c`) | `0x106171cb` |
| +0x4e | d | start | |
| +0x52/+0x56 | d | loop start / loop end (swapped during a ping-pong reverse pass) | |
| +0x5a | d | end | |
| +0x5e | d | C5 speed (sample `+0x3c`) | `0x106171c4`, E5x `0x106179bc` |
| +0x62 | d | step, signed 16.16 | `0x10617318`, `0x10615700` |
| +0x66 | w | output volume 0..0x7fff (includes tremolo) | effects, `0x1061515a` |
| +0x68 | w | base volume | effects |
| +0x6a | w | final period (after LFO/clamp) | `0x106150df` |
| +0x6c | w | base period | note-on, porta |
| +0x6e/+0x70/+0x72 | w | vibrato depth / speed / phase | |
| +0x74/+0x75 | b | vibrato / tremolo waveform (bit 2 = no phase reset) | |
| +0x76/+0x78/+0x7a | w | tremolo phase / speed / depth | |
| +0x7c | w | porta target period | |
| +0x7e | w | porta speed (period units per voice update) | |
| +0x80 | w | arpeggio period delta (signed) | |
| +0x82/+0x83/+0x84/+0x85 | b | memories: vibrato, tremolo, tone porta, sample offset | |
| +0x86/+0x87 | b | Galaxy command / parameter of the current row | |

## 5. Pattern data as the player reads it

Per pattern track: byte `rows−1`, then rows. Each row is a list of events terminated by a
0 byte. Event (`0x10616fdd..0x106173ce`):

- flag byte: bits 0..4 channel, 0x80 effect, 0x40 note, 0x20 volume;
- if 0x80: `param` → `+0x87`, then `cmd` → `+0x86`;
- if 0x40: `inst` (1-based, 0 = none), then `note+1` (0 = none, ≥0x80 = key off: 0x80 from
  IT `===`; IT `^^^` is emitted as volume 0 instead, see §7) [B for the encodings];
- if 0x20: volume byte `v`, stored as `+0x66 = +0x68 = v << 8`.

The IT loader emits these from IT's packed data (`0x10629b57..0x1062a2a4`) [B]: volume
column 0..64 → `min(2v, 0x7f)`; volume-column effects (>64) dropped; channels ≥ 32 dropped.

## 6. Row processing and note trigger (`0x10616fdd..0x106173ce`) [read]

Instrument byte `i ≠ 0`: `+0x0d = i−1`; if the old block (`+0x20`) has envelopes enabled
(flags at block+0x0e/+0x3e/+0x6e bit 0), reset their states.

Note byte `n1`: 0 → nothing. `n1 & 0x80` → `+0x0c = n1` (key off). Otherwise:
`+0x18 = 0x7fff`, `+0x0c = n1−1`, and unless the row's command is 3, 5 or EDx, trigger:

1. `+0x0f = 0`; MIDI-style slot `[0x10688862 + 0x2a6*ch + 4*n1] = 0`.
2. `inst = [0x106882a0 + 4*(+0x0d)]`; null → stop (voice stays inactive).
3. `+0x20 = inst + 0xaa`; `s = inst[0x2a + note]` (keymap); `s ≥ word inst[0x148]` → stop.
4. `smp = inst + 0x14a + 0x48*s` → `+0x42`; `+0x0e = s`; `smp[0x44]` (data) null → stop.
5. `+0x11 = 0x80`; `smp[0x40]` non-null → `+0x20 = smp[0x40]`.
6. `p = smp[0x44]`, halved if `smp[0x2c] & 4` (16-bit). `+0x4a = 0`, `+0x46 = +0x4e = p`,
   `+0x52 = p + smp[0x34]`, `+0x56 = p + smp[0x38]`, `+0x5a = p + smp[0x30]`,
   `+0x5e = smp[0x3c]`, `+0x4c = smp[0x2c]`; if `smp[0x2c] & 0x20`: `+0x14 = +0x16 = smp[0x28]`.
7. LFO seeds from the block: `+0x74 = b[0]` (`+0x72 = 0` unless bit 2), `+0x70 = b[5]`,
   `+0x6e = b[3]`, `+0x75 = b[7]` (`+0x76 = 0` unless bit 2), `+0x78 = b[0xc]`, `+0x7a = b[0xa]`.
8. Envelope states reset: `+0x24 +0x28 = 0, +0x2a = 0x7fff, +0x2c = 0`;
   `+0x34 +0x30 = 0, +0x2e = 0x7fff, +0x2d = 0`; `+0x36 +0x3a = 0, +0x3c = 0x7fff, +0x3e = 0`.
9. Period `P0` for note `k = n1−1` (0..0x77, else 0): Amiga: `c5 ? (amiga[k]*0x20ab)/c5 : 0`
   (unsigned 32-bit); linear: `(0x78 − k) << 8`. `+0x6a = +0x6c = P0` (word).
10. If `P0 ≠ 0`, step from `P0` (same arithmetic as `0x10615660`, §8.1) → `+0x62`;
    negated if `+0x52 > +0x56`.
11. `+0x0f = 1`; slot = voice.

Then for every note `k` in 0..0x77 (triggered or not): porta target `+0x7c` = the same `P0`
(Amiga uses the **current** `+0x5e`; 16-bit store) (`0x10617349..0x10617388`).

If the instrument byte is non-zero and `+0x42` is set: `+0x66 = +0x68 = smp[0x2a]`
(default volume) from the **current** `+0x42`, i.e. the old sample when the trigger was
skipped (porta, EDx, instrument-only rows) (`0x10617391..0x106173aa`). The volume byte then
overrides it.

## 7. Effects

### 7.1 Galaxy command dispatch (`0x10617426..0x10617c56`)

Runs every tick for every music voice, active or not, if `cmd ≠ 0 or param ≠ 0`. Index =
`cmd & 0xf` (table `0x10617cc0`); E = `param >> 4` (table `0x10617d00`). `t` = tick in
row. Volume clamps are `[0, 0x7fff]`. "slide(x)" = `x ≤ 0xf ? vol −= x<<9 : vol += (x>>4)<<9`
applied to `+0x66`, result to `+0x66` and `+0x68`.

| Cmd | t = 0 | t > 0 | Address |
| --- | --- | --- | --- |
| 0 arpeggio | — | `+0x80 = (+0x6c * arp[t%3 → 0, x, y]) >> 15 − +0x6c` | `0x10617457` |
| 1 porta up | — | `+0x7e = x<<4`, `+0x7c = [0x106886a6]` | `0x106174dc` |
| 2 porta down | — | `+0x7e = x<<4`, `+0x7c = [0x10698180]` | `0x1061750d` |
| 3 tone porta | `x ≠ 0 → +0x84 = x` | `+0x7e = +0x84 << 4` | `0x1061753e` |
| 4 vibrato | merge non-zero nibbles of x into `+0x82` | `+0x6e = (m&0xf)<<5`, `+0x70 = (m>>4)<<10` | `0x10617562` |
| 5 porta+slide | — | slide(x); `+0x7e = +0x84<<4` | `0x1061758c` |
| 6 vib+slide | — | slide(x); vibrato from `+0x82` | `0x10617612` |
| 7 tremolo | merge into `+0x83` | `+0x7a = (m&0xf)<<11`, `+0x78 = (m>>4)<<10` | `0x106176db` |
| 8 pan | `x<0x80: x`; `0x80: 0x7f`; `0x84..0xc4: ((x−4)&0x7f)*2 min 0x7f, |0x80`; else `0xc0`; `+0x14 = +0x16 = that<<8` | — | `0x10617757` |
| 9 offset | `x ≠ 0 → +0x85 = x`; `pos = +0x4e + (+0x85<<8)`, `≥ +0x5a → +0x5a−1`; frac 0 | — | `0x106177bd` |
| A vol slide | — | slide(x) | `0x1061780c` |
| B jump | if no pattern delay and `x ≤ [0x1069834a]` and (loop flag or `x > order`): `order = x−1`, break | — | `0x10617854` |
| C set vol | `+0x66 = +0x68 = min(x<<8, 0x7fff)` | — | `0x106178aa` |
| D break | if no pattern delay: `[0x10698140] = 10*(x>>4) + (x&0xf) + 1`, break (BCD) | — | `0x106178de` |
| E1/E2 | `+0x7e = (x&0xf)<<4`, target as 1/2 | `+0x7e = 0` | `0x1061794a`, `0x10617979` |
| E0, E3, EF | nothing | | `0x10617c56` |
| E4/E7 | `+0x74`/`+0x75 = x & 7` (every tick) | | `0x1061799f`, `0x10617a59` |
| E5 | `+0x5e = (ft[x&0xf] * 0x20ab) >> 15` (every tick) | | `0x106179a9` |
| E6 loop | if no delay/break: `x&0xf = 0` → loop row = current row; else `counter = (old == 0) ? x&0xf : old − 1`; non-zero → skip = loop row+1, break, `order−−` | — | `0x106179c4` |
| E8 | `+0x14 = +0x16 = ((x&0xf)<<11) + 0x400` (every tick) | | `0x10617a63` |
| E9 retrig | `x&0xf ≠ 0` and `t % (x&0xf) == 0`: pos = `+0x4e`, frac 0 | same | `0x10617a80` |
| EA/EB | `+0x66 = +0x68 = clamp(+0x66 ± (x&0xf)<<9)` | — | `0x10617ab0`, `0x10617ae5` |
| EC cut | — | `t > (x&0xf)` → `+0x66 = +0x68 = 0` | `0x10617b11` |
| ED delay | `0x10617d40`: when `t == x&0xf`, trigger `+0x0c/+0x0d` (no envelope reset, no `+0x11`, no slot) | same | `0x10617b34` |
| EE delay | `[0x1068828c] = x&0xf`, clear this voice's cmd/param | — | `0x10617b42` |
| F speed/tempo | `x = 0` → stop (`playing = 0`); `x ≤ 0x20` → speed; else tempo; recompute P (§2.2) | — | `0x10617b69` |

Notes [read]: the B check uses the pattern-delay count; E6's loop row and counter are global,
not per channel; ED without a note re-triggers the voice's last note/instrument; an EDx with
`x ≥ speed` never triggers; arpeggio scales the period multiplicatively even in linear mode
(where the period is `(120−note)·256`), so its intervals are wrong there.

### 7.2 IT letter → Galaxy command (loader switch `0x10629e20`, table `0x1062a385`) [B]

Two memory layers exist:

- **Loader layer (static, at load time):** one byte per channel, `0x106841a8[ch]`, zeroed once
  before converting all patterns (`0x10629982`) and carried across patterns in **order-list
  conversion order** (each pattern converted once, at its first order). When an event has a
  new command, its raw param is stored there unless the command is A, D, E, F, K or L
  (`0x10629d18..0x10629d63`). For A/D/E/F/K/L a zero param is replaced by the stored byte,
  then the byte is set to the (resolved) param. IT's "last command" (mask 0x80) reuses
  `0x106849a8[ch]` and this byte. So D00 can recall a G, O, S, H… param. In the shipped songs
  there are 7,902 D00, 141 E00 and 81 F00 recalls; about 250 of the D00s resolve to a
  non-D/K/L param (G 128, O 76, S 13, H 12, T 6, A 4; e.g. BatteryPark order 3, row 22,
  ch 10 recalls S8A → slide down 10).
- **Player layer (per voice):** `+0x82` vibrato, `+0x83` tremolo, `+0x84` tone porta, `+0x85`
  offset (§7.1).

| IT | Used (count) | Galaxy event | Behaviour notes |
| --- | --- | --- | --- |
| A | 2026 | F, `x = x?x:mem`, `min(x, 0x20)` | A>0x20 (10 in the songs, e.g. A40, AFF) → speed 32; A00 with mem 0 would stop the song |
| B | 255 | B x | jump; past the last order ignored |
| C | 112 (all C00) | D x | BCD row, `C0x` correct, `C10+` not |
| D | most used | `x = x?x:mem`; `(x&0xf)==0xf && x&0xf0` → E Ah (fine up `x>>4`); `x ≥ 0xf1` → E Bh (fine down `x&0xf`); else A with `x&0xf` if non-zero, else `x` | |
| E | 1312 | `x = x?x:mem`; `≥0xf0` → E 2(x&0xf); `0xe0..0xef` → E 2(((x&0xf)+2)>>2); else 2 x | extra fine rounded to fine |
| F | 982 | as E with E1 / 1 | |
| G | 16713 | 3 x | |
| H | 271 | 4 x | Galaxy depth `y<<5`, speed `x<<10` |
| J | 0 | 0 x | |
| K / L | 0 | 6 / 5 with mem recall | |
| M | 200 | dropped (`0x1062a180`) | channel volume ignored |
| O | 9914 | 9 x | high offset (SAx) dropped |
| Q | 380 | E 9(x&0xf) | volume change dropped; Q00 (115) → no retrigger |
| R | 0 | 7 x | |
| S0x/S1x | 1 / 0 | E0x / E3x | no effect |
| S3x/S4x | 0 | E4x / E7x | waveform `x&7` (3..7 index past the 3 tables) |
| S8x | 4680 | E8x | pan `(x<<11)+0x400` |
| S9x | 426 (S91) | 8 with 0xa4 | surround, centre (`0xc000`) |
| SBx | 0 | E6x | |
| SCx/SDx/SEx/SFx | 0 / 19 / 0 / 0 | ECx / EDx / EEx / EFx | |
| S2x, S5x–S7x, SAx | 2 (SA2) | dropped | |
| T | 965 (all ≥ 0x58) | `x ≥ 0x20` → F x; else cmd 0x14 | T20 would set speed 32; T0x/T1x would run as vibrato (0x14 & 0xf = 4) |
| X | 1 (XA4) | 8 x | Galaxy 8xx centre is 0x40 and 0x80 is full right, unlike IT's 0x80 centre |
| Y | 704 | dropped | |
| I, N, P, U, V, W, Z | 0 | dropped | |

Notes, volume column [B]: IT `^^^` (4281 uses) becomes "volume 0" (no note), so the voice
keeps running silent and a later volume event can bring it back; IT `===` (5 order
occurrences, all in Title) becomes key off; volume-column effects are dropped.

Usage counts come from a scan of the 35 IT modules (orders up to the first 0xff), not from
the original.

## 8. Channel state → voice parameters

### 8.1 Period → step (`0x10615660`, also inline at `0x106172a4` and `0x10617eaf`) [read]

Input: period `p` (≠ 0; 0 leaves the step unchanged), `c5 = +0x5e`, `R = [0x10697d18]`.

- Amiga: `f = 0x369de40 / p` (signed `idiv`; 0x369de40 = 57,269,824 = 4·14,317,456).
- Linear: `q = p / 0xc00`, `r = p % 0xc00` (signed `idiv`); `f = low32(((int64)lin[r>>2] *
  (uint32)c5) >>arith (q + 10))` via `__allmul 0x10630320` and `__allshr 0x10630360`
  (shift count computed as `(p*0x2aaaaaab >> 32 >> 9) + sign + 10` = `q + 10`).
- `step = ((f / R) << 16) + (((f % R) << 16) / R)` (unsigned); `step = −step` if `+0x52 > +0x56`.

So the low 2 bits of a linear period are ignored; at `p = 60·256` (C-5) `f = c5`.

### 8.2 Voice update (mixer, `0x10614a60..0x10615161`; every voice with `+0x0f` and `+0x20`) [read]

1. Envelopes (§9).
2. Key off (`+0x0c & 0x80`, `0x10614e9b`): if the volume envelope is disabled (all sample-mode
   IT songs), `+0x0f = 0` and `+0x2a = 0` → the voice stops at this voice update. Else
   fade `+0x2a −= block[0x3c]` (and `+0x2e −= block[0x6c]`, `+0x3c −= block[0x9c]`); below
   the fade step → stop.
3. Porta (`0x10614ff1..0x10615057`): move `+0x6c` toward `+0x7c` by `min(+0x7e, |diff|)`.
4. Vibrato/pitch (`0x1061505e..0x106150ee`): `ph = (+0x72 + +0x70) & 0xffff`;
   `v = lfo[(+0x74<<6) + (ph>>10)] * (int16)+0x6e >>arith 8`;
   `e = (uint16)+0x2e * (int16)+0x34 >>arith 15`;
   `P = v + e + (int16)+0x80 + +0x6c`, clamped to `[0, 0x7800]`; `+0x72 = ph`, `+0x6a = P`;
   `0x10615660(voice, P)`. The note-on step was computed from the unclamped `P0`; low notes
   in Amiga mode would jump at the first update (not reached by Endgame1/2: max period 15485).
5. Tremolo (`0x106150f3..0x1061515a`): `ph = +0x76 + +0x78`;
   `+0x66 = clamp(lfo[(+0x75<<6) + (ph>>10)] * (int16)+0x7a >>arith 8 + +0x68, 0, 0x7fff)`;
   `+0x76 = ph`. Volume slides read `+0x66`, so they start from the tremolo-modulated value.

### 8.3 Volume (mixer per chunk, `0x106152c0..0x106153d1`) [read]

`M = 2 * m * m` with `m = (signed char)[0x10697cf0]` for music voices (`+0x11 & 0x80`),
`(signed char)[0x1069817c]` for SFX. Then, each step a 32-bit `imul` followed by `sar 15`:

```
V = +0x12 (20000 for music voices)
V = V * M        >> 15
V = V * +0x18    >> 15     (0x7fff)
V = V * +0x1a    >> 15     (0x7fff)
V = V * (int16)+0x24 >> 15 (volume envelope; 0x7fff when disabled, 0x10614c8f)
V = V * +0x2a    >> 15     (fade, 0x7fff)
V = V * +0x66    >> 15     (note volume incl. tremolo)
```

`m` comes from SetVolumes `0x106061b0` → `0x1060eb60(ftol(fade * MusicVolume * 127.0f), 0)`
(`0x10606289..0x106062b5`, agent A): rate 0 sets current = target at once. The header GV
(`[IT+0x30]`, 128 in every song) is stored to `[0x10697cf0]` by the loader as signed −128
(`0x10628a6e..0x10628a83`, clamp uses `movsx`) but SetVolumes overwrites it inside the same
Update lock, so it is never mixed. Not used anywhere in the music volume: IT mixing volume
(`[IT+0x31]`, never read by the loader), sample global volume (not read in the sample-mode
path `0x10629787..0x1062990b` [B]), channel volume (header and M), V/W. The loader reads
the header flags word only twice (`0x10628c2b` bit 2 instruments, `0x1062a314` bit 3
linear), so the stereo flag (bit 0; set in all 35 songs), old-effects (bit 4) and
link-G-memory (bit 5) are ignored, as is separation (`[IT+0x34]`). The music level is
therefore `note·(20000/32768)·(2m²/32768)` before the pan law. The 20000 is the MIDI-style
channel volume 100 from the reset (`+0x3f = +0x41 = 100`, ramped by `0x10618082..0x106180f9`).

Default volume: sample `+0x2a = min(Vol << 9, 0x7fff)` (`0x106297a9..0x106297e7`) [B];
volume column `min(2v, 0x7f) << 8` (64 → 0x7f00 vs 0x7fff from the sample default).

### 8.4 Pan (`0x10615280..0x106153d4`) [read]

- Slew: per voice, once per mixer **chunk** (each pass of the outer loop in `0x10614920`):
  `d = (+0x16 & 0x7fff) − (+0x14 & 0x7fff)` clamped to ±0x200, `+0x14 += d` (bit 15 of the
  current value kept). Chunk lengths are set by tick boundaries and by the ≤0x200-sample
  requests from `0x106146a0`, so the slew rate is [host].
- `p0 = +0x14 & 0x7fff`; `P = p0 + (((0x4000 − |p0 − 0x4000|) * (int16)+0x36 >> 15) *
  (uint16)+0x3c >> 15)` (pan envelope term; 0 without envelopes; no clamp, so an envelope
  could index the table out of range — instrument mode only).
- `A = tab[P] * V >> 15`, `B = tab[0x7fff − P] * V >> 15`, `tab = [0x10698390]` (§10).
- Sends: `(+0x1e * A) >> 7`, `(+0x1e * B) >> 7` (send 1), `(+0x1c * A) >> 7`, `(+0x1c * B) >> 7` (send 2).
- Mode bits (`0x10615280..0x106152bc`): bit 0 = 16-bit (`+0x4c & 4`), bit 1 = interpolate
  (global `[0x10697cfc] & 4` and `step < 0x10000`, signed), bit 2 = surround (`+0x14 & 0x8000`).

Sources: header channel pan `min(2p, 0x7f)` or 0xa0 for p > 64 (`0x10628b87..0x10628bcc`) [B]
(every song: 32 → 0x4000); sample default pan `min((DfP&0x7f)<<9, 0x7fff)` when DfP bit 7
(`0x1062989b..0x106298df`) [B]; 8xx; E8x. A header value of 0xa0 means surround with
`P = 0x2000`.

Music send buffers: music voices mix into `[0x10697d00]` (dry), `[0x10697d08]` (send 1) and
`[0x10697d10]` (send 2); SFX into `0x10697d04/0c/14` (`0x106152c7..0x10615303`,
`0x10614727..0x10614750`). The music effect units `[0x10684ea8]` and `[0x10698388]` are
written only by `0x1060f3c0` (called only from the 'AE' loader `0x106244d0`, reached only from
`0x106189e0`, which has no static caller) and `0x1060ec60` (no static caller), and zeroed at
glxInit (`0x1060e182`). So for DX's IT music the default send 1 = 0x28 is computed but never
reaches the output. [derived]

### 8.5 Mixer hand-off (`0x10615434..0x106155a1`) [read]

Format bits `+0x4c` come from the sample's `+0x2c`, which the IT sample-mode loader builds
at `0x106297f0..0x10629894` [B]: bit 1 = unsigned (`!(Cvt & 1)`), bit 2 = 16-bit, bit 3 =
loop, bit 4 = ping-pong, bit 5 = use default pan, **bit 7 always set**. IT sustain loops
(flag 0x20) are not mapped (no shipped sample has one), and with bit 7 always set the
"released by key off" branch at `0x1061544e` is unreachable for IT.

Per run: boundary = `+0x5a` (end) unless looping (`+0x4c & 8`) and not released (key off
with `+0x4c & 0x80` clear and step ≥ 0 uses the end); looping uses `+0x56`.
`count = (((clamp(boundary − pos, −0x7fff, 0x7fff) << 16) − frac) / step) + 1`, ≤ remaining.
If `V ≠ 0`, call `[0x10698354]` with 14 cdecl args:

| arg | value |
| --- | --- |
| 0, 1, 2 | dry, send-1, send-2 buffer pointers (advanced per run) |
| 3 | sample count |
| 4, 5, 6 | position `+0x46`, fraction `+0x4a`, step `+0x62` |
| 7, 8 | B = `tab[0x7fff−P]·V>>15`, A = `tab[P]·V>>15` |
| 9, 10 | send-1 B, send-1 A |
| 11, 12 | send-2 B, send-2 A |
| 13 | mode bits |

B is the full side at `P = 0`; which output channel it feeds is agent D's (inner mixer).
After the run: `frac += step*count` (low 16 bits kept), `pos += (step*count + frac) >> 16`;
crossing the boundary loops (`pos = loop start + overshoot`; ping-pong `+0x4c & 0x10` swaps
`+0x52/+0x56` and negates the step) or deactivates the voice. The voice advances even when
`V == 0`.

## 9. Instrument mode (Lebedev only) — map

Block (instrument +0xaa, or sample `+0x40`): `+0x00` vib flags, `+0x03` depth, `+0x05` speed,
`+0x07` trem flags, `+0x0a` depth, `+0x0c` speed; envelope 1 at `+0x0e` (flags: 1 on,
2 sustain, 4 loop; `+0x10` count, `+0x11` sustain point, `+0x12/0x13` loop start/end,
`+0x14 + 4i` (tick, value)), fade `+0x3c`; envelope 2 at `+0x3e` (points `+0x44`), fade
`+0x6c`; envelope 3 at `+0x6e` (points `+0x74`), fade `+0x9c`. Voice: env 1 → `+0x24` value,
`+0x26` delta, `+0x28` tick, `+0x2c` point, `+0x2a` fade (volume); env 2 → `+0x34/+0x32/+0x30/
+0x2d`, `+0x2e` (pitch term, §8.2); env 3 → `+0x36/+0x38/+0x3a/+0x3e`, `+0x3c` (pan term).
Code: `0x10614a86..0x10614e99`; delta per point = `(next.value − value) / (next.tick − tick)`
(`idiv`, truncation); sustain hold unless key off; tracker mode skips the MIDI sustain jump
(`0x10614eba`, `0x10614f34`, `0x10614f97`). No NNA: a channel owns one voice, so a new note
cuts the previous one. Which IT envelope lands in which slot is the loader's (B).

## 10. Tables and x87

Data (dwords unless noted) [read]; formulas checked numerically against every entry:

| Address | Entries | Content |
| --- | --- | --- |
| `0x1063daa0` | 3×64 | LFO: 0 sine `trunc(255·sin(2πk/64))`, 1 ramp 255→−255, 2 square ±255. Index `(wave<<6)+(phase>>10)`; waves 3..7 read on into the next tables. |
| `0x1063dda0` | 120 | Amiga periods: `round(6848·2^(−(n−60)/12))` for n ≥ 21, 65280 below. |
| `0x1063df80` | 768 | Linear: `floor(32768·2^(−k/768))`. |
| `0x1063eb80` | 16 | Arpeggio: `round(32768·2^(−n/12))`. |
| `0x1063ebc0` | 16 | Finetune: ≈`32768·2^(f/96)`, f = 0..7, −8..−1 (entry 7 = 34468 is 1 above the rounded value). |

x87: the sequencer, voice update and step code are integer only. The only floating point
on this path:

- Pan table, glxInit `0x1060e246..0x1060e283`: for i in 0..0x7fff:
  `fild dword i; fmul qword [0x1063ec38] (1/32767 as double); fsqrt; fmul qword [0x1063ec30]
  (32767.0); call _ftol (0x106300f4 → MSVCRT, truncation)`, stored as words in a
  GlobalAlloc block `[0x10698390]`. Intermediates stay on the stack at the control word's
  precision. A model of the rounding gives identical tables for PC=53 and PC=64 except
  i = 0x7fff (32767 vs 32766); PC=24 differs at 53 entries. The control word at glxInit is
  unknown (see the D3D FPUSETUP memory note).
- `m` for the master volume: `ftol(fade * MusicVolume * 127.0f)` in SetVolumes (agent A).

## 11. Walk-through: Intro_Music from section 0 [derived]

Load: speed 48 / tempo 120 placeholders, IS 6, IT 153. Update: SetVolumes sets m; start;
`glxControlMusic(2, 0)` → order 0xff; break = 1. First sequencer tick: order 0 → speed 6,
tempo 153, P recomputed, pans 0x4000; pattern 0 row 0 parsed; effects with tick 0. Five more
ticks of effects, then row 1, and so on. The first tick's position relative to the start of
the output is set by the free-running counter (§2.1).

## 12. Unresolved branches / open questions

1. **Counter phases [host]**: the voice-update and sequencer countdowns are never reset. When
   both expire in one chunk the voice update runs first and uses the previous tick's effect
   state; otherwise it runs a fixed offset before or after each tick. The first tick of a new
   song also comes at an arbitrary point, with the previous song's period. The translation
   has to pick a phase; the oracle must pin both counters.
2. **Pan slew rate [host]**: ±0x200 per mixer chunk, and chunk lengths depend on the render
   request sizes of `0x106146a0`/`0x106142a0`.
3. **Section > 0 start [derived]**: speed 48, tempo 120 and the stale period until an Fxx;
   pans not reset. Needs an oracle run and, ideally, the game's SongSection usage (agent A).
4. **Pattern-end extra tick-0 pass [derived]**, including the 86 O and 22 Q on ending rows.
5. **Null patterns skipped [derived]** (order 2 in 21 songs) and the section mapping that
   results.
6. **D00/E00/F00 recalling foreign params [derived]**, resolved in conversion order (≈250).
7. **Key off → voice stops at the next voice update [derived]** for sample-mode songs.
8. Inner mixer: which of A/B is left, the surround and interpolation implementations, and
   the output converter `[0x10697ca4]` (agent D).
9. DX values of `[0x10697d18]` (rate), `[0x1068828d]` (SFX voices) and `[0x10697cfc]`
   (interpolation flag) at run time (agents A/D).
10. Not analysed: track handlers `0x106168b0` (mode 0, MIDI) and `0x10615a60` (mode 4), MIDI
    paths in the voice update, the 'AE'/'AM' formats, instrument-mode envelope details beyond
    §9, the loader's instrument path (`0x10628c3a` onward).
11. Edge cases read but not exercised by the songs: break to a row ≥ the pattern length (no
    bounds check in the skip loop); SBx on a pattern's last row (counter decremented twice per
    pass, can loop forever); EDx with a key-off note (keymap index 0x80+); porta without a
    note after E/F (target left at the porta limit); all orders null/+++ (the order walk
    spins).
12. Pan table precision (PC at glxInit) and `_ftol` edge at i = 0x7fff.

## 13. How I would probe this

Unicorn oracle over the unmodified DLL (reuse the loader/mapping from
`scripts/native-galaxy-audio-oracle.py`):

1. Map Galaxy.dll; zero BSS (`0x10650000..0x106983c4`). Stub `EnterCriticalSection`/
   `LeaveCriticalSection` (no-ops), `GlobalAlloc`/`malloc`/`free`/`realloc`, `memcpy`/`memset`
   bridges, `PostThreadMessageA`, `_ftol` (or run it). Run the init block around
   `0x1060e0c1..0x1060e29a` (or poke its results), then set `[0x10697d18]` to DX's rate,
   `[0x1068828d]` to DX's SFX voice count and `[0x10697cfc]` as in the game (ask A/D).
   Optionally inject a hardware-measured pan table (CrossOver, as for the FFT twiddles).
2. Extract the IT bytes from the .umx and call `glxLoadMusic(&{'MEMO', 0xc, data, size}, 2)`
   (`0x10618be0`; it installs the memory I/O pointers at `0x1064a744..0x1064a750`).
3. Replay Update's sequence: `0x1060eb60(m, 0)`, `glxStopMusic`, clear `+0x0f` of the music
   voices, `glxStartMusic`, `glxControlMusic(2, section)`, `[0x10697ca8] = 1`.
4. Set `[0x10698204]`, `[0x1069834c]` (and `[0x1069818c]`, `[0x10697d20]`) to chosen values,
   set `[0x10697cdc]` non-zero, then call `0x10614920(d00, d04, d08, d0c, d10, d14, n)` with
   scratch buffers in fixed-size requests.
5. Hooks: at `0x106154e0` record the 14 args (or run the real inner mixer for D); at
   `0x106151b0` (after each `0x10615710`) dump the globals of §3, `[0x1069818c]`, and the music
   voice records `0x1068dca0 + v*0xa0`; at `0x106150ee` record each voice update's period.
   Index by `[0x10697ce0]`. Compare tick by tick with the translation.
6. Cases, in priority order: Intro from section 0 for a few hundred ticks; a pattern
   boundary with O on the ending row (Quotes, UNATCOReturn, Tunnels) and with Q; a section
   > 0 start, including a section that lands on a null pattern (HongKong order 2); D00 after
   S8x (BatteryPark order 3, row 22, ch 10); key off (Title order 9, row 0, ch 10); SDx
   (HongKong order 4); A40 (NavalBase order 8); Endgame1 (Amiga); Lebedev (instruments); the
   same song with different counter phases to bound item 12.1.
