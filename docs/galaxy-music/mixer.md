# D — Galaxy.dll software mixer and output

Galaxy.dll SHA256 `606e71d1…`, preferred base `0x10600000`. Every claim
cites the instruction or data address it comes from. Field names are
`V+0xNN` (voice record) unless a string confirms a name; "likely" marks an
interpretation. §0–§7 were written from code before anything was run. The
SSE kernel (§2.5), the conversion (§2.6), the renderer (§1.3) and the bus
clear (§1.4) are now translated (`native/galaxy-kernel/src/mixer.rs`) and
verified against the original under Unicorn and on the host CPU. §8 has the
evidence, the corrections and what is still open. The items that still need
a measurement are listed in §6, §7 and §8.5.

## 0. Corrections and headline findings

* **`0x1060e840` is not a library tick.** It is `EnterCriticalSection(0x1067b670); return 0`
  (`0x1060e840..0x1060e84d`). The matching unlock is `0x10618920`
  (`LeaveCriticalSection(0x1067b670)`). `UGalaxyAudioSubsystem::Update` takes the
  lock at `0x10609549` and releases it at `0x1060abd6`, so Update runs entirely under
  the library lock. Other subsystem lock/unlock pairs: `0x10601751/0x10601762`,
  `0x10619460/0x106194e3`, `0x1061951a/0x1061959a`, `0x106195ea/0x10619663`.
  docs/galaxy-audio.md step 1 ("Galaxy library tick") is wrong. I am flagging it here
  only; docs were not edited.
* **The mixer runs on a winmm multimedia-timer thread** (`timeSetEvent`, periodic,
  `Latency/2` ms). The game thread never mixes.
* **One voice pool and one mixer serve both music and effects, but there are two
  output buses written at two ring positions.** Module voices (`V+0x11` bit 7) go to
  bus A, which overwrites the staging ring just behind the play cursor. Everything
  else (sounds, ambient, speech) goes to bus B, which is **saturating-added** at
  write cursor + Latency. If this reading is right, music is heard about
  `ring − D` frames (about 1 s minus the effects latency) later than effects rendered
  at the same moment (§1.3). This is derived from code and still needs a recording
  probe.
* **On any SSE CPU (the reference machine, and CrossOver/Rosetta) the mixer is the SSE
  kernel.** It always interpolates linearly with 15-bit weights and accumulates in
  float32. `UseFilter` has no effect on this path. The volume tables are used only by
  the non-SSE kernels.
* **The x87 FPU is used in only two places in the chain:** the sqrt pan table, built
  once at library init, and the reverb coefficient setup (which uses
  `fcos`/`fyl2x`). The mixing and conversion kernels use SSE and MMX only.

## 1. Architecture

### 1.1 Threads, lock, entry points

| Thread | Created at | Body | Role |
| --- | --- | --- | --- |
| game thread | — | subsystem `Update` `0x10609510` (under lock), PlaySound → 2D start `0x10612310`, control `0x1060d280`, status `0x1060cf00`, stop `0x10618410` / `0x10618590` | Sets voice state. Each library call takes `0x1067b670` itself (recursive critical section). |
| stream decoder | `CreateThread(0, 0, 0x1060e340, 0, 0, &0x1067b6f4)` at `0x1060e2c1`, `SetThreadPriority(…, 2)` at `0x1060e2cf` (2 = HIGHEST) | `GetMessageA` loop `0x1060e340..0x1060e830`. On message `0x400` (wParam = voice index) it waits on the voice's mutexes (`V+0x98`, chained through `V+0x9c`; `WaitForMultipleObjects(n, h, TRUE, 1000)` at `0x1060e3c7`) and decodes into the voice's 64 KB ring. Decoder by sample format: `0x4000` → `0x1061a690` (MP3, per docs/lip-sync.md); `0x2000` → `0x1061a170`; otherwise `0x10619800` (`0x1060e57f..0x1060e5d2`). | Does **not** take `0x1067b670`. |
| mixer | `timeSetEvent(delay, 0, cb, 0, TIME_PERIODIC=1)` after `timeBeginPeriod(1)`. DirectSound: `0x10613aee`, cb `0x106142a0`. WaveOut fallback: `0x10614043`, cb `0x10618100`. | The callback takes `0x1067b670` (`0x106142b9`), renders, copies, unlocks (`0x10614686`). | The only place samples are produced. |

The mixer posts refill requests to the decoder from inside the mixer, once per
sequencer tick (§1.5): `PostThreadMessageA(0x1067b6f4, 0x400, voiceIndex,
V+0x46 − V+0x52)` at `0x106151f5`. This happens for each effects-slot voice with
`V+0xf`, `V+0x10` and `V+0x11` bit 3 set, and with format `& 0xe000` or `& 0x40`
(`0x106151bb..0x1061520c`).

Library init `0x1060df30` is called from subsystem Init at `0x1060560c`. It does the
following:
* CPUID → `0x1068dc80` MMX (edx bit 23), `0x10698340` SSE (edx bit 25, then an
  SEH-guarded `movaps` OS test at `0x1060dfe1`), `0x10698190` 3DNow (ext edx bit 31)
  (`0x1060df6f..0x1060dff2`).
* Subsystem Init then **clears** each flag whose Core counterpart is 0:
  `GIsMMX` → `0x106056a0`, `GIsKatmai` → `0x106056b0`, `GIs3DNow` → `0x106056c1`.
  Core sets `GIsKatmai` from CPUID SSE unless the command line contains `NOKNI`
  (Core.dll `0x1016dd8a..0x1016ddbe`, string `0x101b2c7c`). The CrossOver DeusEx.log
  reports "CPU Features: CMov FPU RDTSC MMX KNI".
* Voice table `0x1068dca0`, stride `0xa0`, 256 slots up to `0x10697ca0`. Each slot
  starts with magic `'VOIC'` (`0x43494f56`) and `+4 = 0x98`.
* Init values per slot (`0x1060e009..0x1060e05e`): `+0x0c=0xbc`, `+0x11=8`,
  `+0x12=0x7e02` (= 127²·2), `+0x14=+0x16=0x4000`, `+0x1a=0x7fff`, `+0x1c=0`,
  `+0x1e=0x7f`, `+0x3f=+0x41=0x7f`.
* Heap blocks (`GlobalAlloc(GPTR)`):
  * `0x10698344`: 0x28000 bytes (non-SSE tables, §2.7).
  * `0x10698184`: 0x61c0 bytes. Six 64-byte-aligned bus buffers of 0x1040 bytes are
    carved from it: `0x10697d00..0x10697d14` = d00 d04 d08 d0c d10 d14
    (`0x1060e1c8..0x1060e20d`).
  * `0x10698354`: 0x2000 bytes, the **code buffer** the kernels are copied into.
  * `0x10697ccc`: 0x2ee00 bytes, the staging ring.
  * `0x10698390`: 0x10000 bytes, the sqrt pan table, filled at
    `0x1060e259..0x1060e283` (§2.2, §4).
* **Module-slot reset `0x1060e850`** (loop `0x1060e879..0x1060e8e9`, gated by
  `0x10698349 == 0`) gives slots `0x1068828d..255` different defaults. It first
  zeroes all 0xa0 bytes (`rep stosd` from V, which also clears `'VOIC'`, `+0x10`,
  `+0x11`, `+0x18`, `+0x24`, `+0x2a`). With `edx = V + 0xd + 0xa0` it then stores:
  * byte `[edx−0xa0]` V+0x0d = 0;
  * word `[edx−0x91]` V+0x1c = 0;
  * word `[edx−0x8f]` V+0x1e = 0x28;
  * byte `[edx−0x6c]` V+0x41 = 0x64;
  * byte `[edx−0x6e]` V+0x3f = 0x64;
  * word `[edx−0x9b]` V+0x12 = 0x4e20 (= 100²·2);
  * word `[edx−0x93]` V+0x1a = 0x7fff;
  * word `[edx−0x97]` V+0x16 = 0x4000;
  * word `[edx−0x99]` V+0x14 = 0x4000;
  * byte `[edx−0xa1]` V+0x0c = 0xbc.

  Compared with library init: V+0x12 is 0x4e20 instead of 0x7e02, V+0x1e is 0x28
  instead of 0x7f, and V+0x3f/V+0x41 are 0x64 instead of 0x7f. `0x1060eb10` later sets
  V+0x10 = 1 for the module slots. Module note-on `0x10611e30` sets V+0x1c/V+0x1e
  again (default 0x28, `0x10612177..0x1061219b`).
* Default output rate `0x10697d18 = 0x5622` (22050). Initial counters:
  `0x10698204 = 0x10697d20 = 0x160ccc`, `0x1069834c = 0x1069818c = 0xe5b000`.
  Tempo `0x10698188 = 0x78`, `0x10698342 = 0x30`. Masters `0x10697cf0 = 0x1069817c = 0x7f`.

### 1.2 Output open (`0x10613350`, called from subsystem SetViewport `0x10605e7a` / `0x10605eef`)

* **Arguments** `(hwnd, rate, flags, latency)`:
  * `hwnd` comes from viewport vtable `+0x80` when UseDirectSound (`+0x2c`) is set,
    otherwise 0, which takes the WinMM path (`0x10605e56..0x10605eef`).
  * `rate = {8000, 11025, 16000, 22050, 32000, 44100, 48000}[OutputRate byte +0x68]`
    (`0x10605e1e..0x10605e52`). Installed: 44100.
  * `flags = 2 | (UseFilter +0x30 ? 4 : 0) | (UseStereo +0x38 ? 1 : 0) | (+0x74 ? 8 : 0)`
    (`0x10605dab..0x10605dcd`). Installed: 7.
  * `latency` = Latency `+0x60`, clamped to 5..495 and stored at `0x1064a65c`
    (`0x106133f5..0x10613420`).
* **DirectSound object.** `CoCreateInstance(CLSID_DirectSound 0x10643168,
  IID_IDirectSound 0x10643178)`. A3D CLSIDs (`0x1063d958`, `0x1063d968`) are tried
  only when flags bit 3 is set. Calls in order:
  * `Initialize(NULL)` (`+0x28`).
  * `SetCooperativeLevel(hwnd, 2)` (DSSCL_PRIORITY).
  * `GetCaps`. The open fails over to WinMM if `DSCAPS_EMULDRIVER` (0x20) is set
    (`0x10613575`).
  * Primary buffer from DSBUFFERDESC `{0x24, 0x11}` at `0x1069816c`.
  * Format search loops (`0x106136ff..0x106138f7`): channels {2, 1} outer, bits
    {16, 8} middle, rates {48000, 44100, 32000, 22050, 16000, 11025, 8000} inner.
    The first combination that passes all of these is taken:
    * `rate ≤ requested`;
    * stereo allowed by flags bit 0, 16-bit allowed by flags bit 1;
    * primary `SetFormat` (`+0x38`) succeeds;
    * `CreateSoundBuffer` succeeds for `{0x24, flags 0x18000 (GLOBALFOCUS |
      GETCURRENTPOSITION2), bytes = nAvgBytesPerSec}` (a 1-second secondary at
      `0x10697cc8`);
    * `Play(0, 0, DSBPLAY_LOOPING)` (`+0x30`) succeeds.

    WAVEFORMATEX is at `0x1067b6d8`. Installed result: 44100 Hz, 16-bit, stereo.
    Ring size `0x10697cd0 = 176400` bytes; the staging ring is silenced first
    (`0x10613857..0x10613884`).
* **WinMM path** (`0x10613c20..0x10614053`): the same search, `waveOutOpen`, one
  looping `WAVEHDR` (`dwFlags 0xc`, `dwLoops −1`) over the 1-second staging buffer,
  callback `0x10618100`. Same mixer.
* **After a successful open** (`0x10613937..0x10613b16`):
  * `0x10698179` = output format bits: 1 stereo, 2 16-bit, 4 = flags bit 2 (filter),
    0x80 8-bit. Installed: **7**.
  * `0x10698178 = 1` (DS) or 2 (WinMM).
  * Ring heads `0x10697cd4 = 0x10697cd8 = 0` and `0x10697cdc = 0`.
  * Mixer setup `0x10614080((fmt & 0x85) | 2)` (§2.1).
  * Every voice's step `V+0x62` is rescaled by `oldRate/newRate` with 64-bit
    `__allmul` / `__alldiv` (`0x106139de..0x10613a08`), then `0x10697d18 = rate`.
  * Tick lengths are recomputed (§1.5).
  * `0x10698394 = 1` (open).
  * Driver name `0x10698358` = "Directsound(tm) output driver v4.0" `0x1064a714`
    or "Windows(r) wave output driver 4.0" `0x1064a6f0`.
* **Timer period** = `clamp(Latency, 5, 495) >> 1` ms (`sar eax, 1` at `0x10613ae9`).
  Installed: 20 ms.
* CrossOver evidence: the bottle's DeusEx.log prints "Galaxy is using DirectSound"
  (`0x106057a9`). That line comes from Init's probe `0x1060d860`, which performs the
  same EMULDRIVER check (`0x1060d9e5`). So the open most likely takes the DS path
  there too. Not confirmed: the log has no line from the open itself.

### 1.3 Timer callback (`0x106142a0`, DirectSound) — ring cursor logic

Names: `size = 0x10697cd0`, `A = 0x10697cd4` (music head), `B = 0x10697cd8`
(effects head), `ahead = 0x10697cdc` (bytes rendered and not yet consumed),
`mask = ~(blockAlign − 1)`.

1. `0x106126f0`: polls hardware 3D voices. It does nothing while `0x1069817a = 0`
   (Use3dHardware False).
2. `GetCurrentPosition(&play, &write)` (`+0x10`, `0x106142d6`). Then
   `play = (play % size) & mask` and
   `target = ((write % size) + floor(nAvgBytesPerSec · latency / 1000)) % size & mask`.
   The division by 1000 is `mul 0x10624dd3; shr 6` (`0x106142f5..0x1061433a`).
   Installed: +7056 bytes (1764 frames).
3. If `A == B`, set `A = play` and `B = target`. This happens on the first callback,
   because open zeroes both (`0x1061433c..0x1061434e`).
4. `lenA = (play − A) mod size`, `lenB = (target − B) mod size`,
   `ahead −= min(lenA, lenB)` (`0x10614353..0x1061437b`).
5. **If `ahead ≤ 0`** (start-up or underrun, `0x10614381`):
   * `ahead = (B − A) mod size`.
   * Render `0x106146a0(staging, size, B, B, n, n)` with `n = (A − B) mod size`. Both
     buses go to the **same** position B, covering the whole ring except `[A, B)`.
   * `Lock(0, size, …, DSBLOCK_ENTIREBUFFER)`, copy the whole staging ring, `Unlock`.
     `DSERR_BUFFERLOST` (`0x88780096`) leads to `Restore` (`+0x50`), `Play(LOOPING)`,
     Lock again (`0x10614387..0x10614471`).
6. **Normal render** if `ahead ≠ 0`: `R = 0x106146a0(staging, size, A, B, lenA, lenB)`.
   Then:
   * `Lock(A, R)` and copy from `staging + A`;
   * `Lock(B, R)` and copy from `staging + B` (same lost-buffer retry);
   * `A = (A + R) % size`, `B = (B + R) % size` (`0x10614484..0x1061467b`).
7. `LeaveCriticalSection`.

`0x106146a0(buf, size, posA, posB, lenA, lenB)` (`0x106146a0..0x10614911`):
* `shift = stereo + 16bit` from `0x10698179` (2 here). Frames to render
  `= min(lenA, lenB) >> shift`.
* Loop while both remaining lengths and `ahead` are nonzero:
  1. `k = 0x10614920(d00, d04, d08, d0c, d10, d14, n)` (k ≤ 512).
  2. Effect hooks, each called as `fn(ctx, dry, send, k, 0)` only when both `fn` and
     `ctx` are nonzero:
     * `[0x10684ea8]` with ctx `[0x10684ea4]` on (d00, d08);
     * `[0x10688288]` / `[0x10688284]` on (d04, d0c);
     * `[0x10698388]` / `[0x10698384]` on (d00, d10);
     * `[0x106981c8]` / `[0x106981c4]` on (d04, d14).
  3. `conv = [0x10697ca4]` (§2.6):
     * `conv(d00, k1, buf + posA, fmt)` and the wrapped remainder at `buf`, with
       **fmt = `0x10698179`** (store);
     * `conv(d04, …, buf + posB, fmt | 0x40)` (add).
  4. `posA`, `posB` advance by `k << shift` modulo `size`. Returns the total bytes.

**Resulting placement.** In steady state `B − A = D` is constant. D equals the first
callback's `(write − play) + latencyBytes`; it is never re-measured, except by an
underrun resync.
* Bus A (music) is written over the staging bytes just behind the play cursor, so it
  is heard about one ring (1 s) after it is rendered.
* Bus B (effects) is added at B, so it is heard about D after it is rendered.
* At any ring position the output is `sat16(sat16(rne(A_bus[T])) + sat16(rne(B_bus[T + size − D])))`
  in mixer frames. The music overwrite always lands before the effects add for the
  same lap, because A trails the play cursor and B is ahead of it.

Corroboration: music control `0x1060d0e0` mode 1 sets `0x10697cdc = 0`
(`0x1060d193`, reached from `0x106071a8`). That forces the step-5 resync, which drops
the pre-buffered music. This only makes sense if music is buffered about 1 s deep.
**Unmeasured. See §7.** The callback itself is now translated and oracle-checked (§9); D
is the open measurement (audio-output-scope.md §5.1).

The WinMM callback `0x10618100` has the same structure: `waveOutGetPosition`, the
same `A` / `B` / `ahead`, two `0x106146a0` calls (`0x10618213`, `0x10618241`), and no
Lock/copy because the wave buffer is the staging ring.

### 1.4 Mixer `0x10614920(d00, d04, d08, d0c, d10, d14, n)` — segmenting

* Clamps `n` to 512 frames (`0x1061492a..0x1061493c`).
* `cl = 1 + (0x10697cfc & 1) + ((0x10697cfc >> 1) & 1)` is the **bus frame shift**:
  3 for the SSE and x86 kernels (8 bytes per stereo frame), 2 for MMX-only.
* Zeroes `n << cl` bytes of all six buses (`0x1061497a..0x106149f4`).
* Then it loops while frames remain and `ahead != 0` (`0x106149fc`):
  * `seg = min((n − done) << 16, cnt1 & ~0xffff, cnt2 & ~0xffff)` (16.16 fixed point),
    with `cnt1 = 0x10698204` (envelope counter) and `cnt2 = 0x1069834c` (sequencer
    counter) (`0x10614a08..0x10614a2a`).
  * `cnt1 −= seg`. **If `cnt1 < 0x10000`:** run the per-voice envelope pass
    `0x10614a42..0x1061517f` (only voices with an instrument pointer `V+0x20 ≠ 0`,
    i.e. module voices; see the C hand-off), then `cnt1 += 0x10697d20`.
  * `cnt2 −= seg`. **If `cnt2 < 0x10000`:** call `0x10615710` (sequencer tick, agent C),
    post the stream refills (§1.1), call `0x10617f50` (master fades), then
    `cnt2 += 0x1069818c` (`0x1061519b..0x10615224`).
  * **Both tick passes run before the segment is mixed.** A tick whose nominal time is
    `seg + frac` frames ahead therefore governs the `seg` frames that precede it.
    Segments are also cut by the request length (512-frame clamp and timer-callback
    length), so a tick's new state starts at the last segment boundary before the
    tick. That boundary can be a real-time-dependent callback boundary.
  * Mix every voice slot `0 .. 0x1068828d + 0x10698348 − 1` for `seg >> 16` frames
    (§2.2), advance the bus pointers, `ahead += frames << shift`
    (`0x106155d6..0x10615641`), `0x10698194 += frames` (likely a frames-played
    counter).
* **Tick lengths** (`0x10613a10..0x10613ac4`, recomputed by the tick at
  `0x106158b4..0x10615978`):
  * If `0x10697ce8 & 2` (set by the module loaders, e.g. `0x10624c8f`, `0x1062524e`,
    `0x10625a91`, `0x1062a323`):
    `0x1069818c = 0x10697d20 = floor(5·rate / (2·tempo)) << 16 + floor(((5·rate) mod 2·tempo) << 16 / 2·tempo)`.
  * Otherwise `0x1069818c = 60·rate·65536 / (tempo · 0x10698342)` (same q/r form) and
    `0x10697d20 = floor(rate · 65536 / 1000)` (1 ms; `shl 14`, `mul 0x10624dd3`,
    `shr 4`).
  * Tempo is `0x10698188`.
* **`cnt1` and `cnt2` are written only by library init and the mixer** (writers:
  `0x1060e169`, `0x1060e178`, `0x10614a37`, `0x10615196`, `0x106151a3`, `0x10615224`).
  Song start never resets them, so the phase of the first tick of a song is inherited
  from everything mixed since the library was initialized.

### 1.5 Voice pool and buses

* **Pool.** 256 slots. The first `0x1068828d` slots are effect voices: set to
  EffectsChannels (16) by `0x1060ebc0` from subsystem Init `0x106056df`, which also
  marks `V+0x10 = 1`. The 2D start maps subsystem `channel+1` to slot `channel`
  (`0x106123fd..0x10612405`). The next `0x10698348` slots are module voices, set by
  the module loaders, e.g. `0x10624b75`, `0x1062b245`.
* **Bus select** (`0x106152c0..0x10615315`). If `V+0x11` bit 7 is set → bus A
  (d00, d08, d10) with master `0x10697cf0`. Otherwise → bus B (d04, d0c, d14) with
  master `0x1069817c`.
  * Module note-on sets `V+0x11 = 0x80` (`0x10616bf6`, `0x10617189`).
  * The 2D start sets `V+0x11 = flags | 8` (`0x1061248e..0x10612499`). The subsystem
    passes `flags = 0`, so `V+0x11 = 8`: bus B.
  * Speech, ambient and every other sound share bus B.
* **Buses per group.** Dry (d00/d04) is the only bus converted to output. Send 1
  (d08/d0c), level `V+0x1e`, feeds the reverb hooks. Send 2 (d10/d14), level `V+0x1c`,
  feeds the chorus hooks (§3).

## 2. Inner loops

### 2.1 Kernel dispatch (`0x10614080(mode)`)

The kernel is a code template copied into the code buffer `[0x10698354]`, with
absolute table addresses patched in. Each setup returns the conversion routine's
address, which is stored at `0x10697ca4`. The mixer calls the kernel through
`call [0x10698354]` (`0x106154e0`).

| Condition (`0x10614080..0x10614169`) | Setup | Mixer template | Conversion template | `0x10697cfc` |
| --- | --- | --- | --- | --- |
| MMX & SSE & stereo | `0x106231d1` | `0x10622730` (0x603 bytes, no patches) | `0x10622fe4` (0x1ed) | mode `| 0x43` |
| MMX & !SSE & 3DNow & stereo | `0x1062255c` | — | — | mode `| 0x43` |
| MMX & !SSE & !3DNow & stereo | `0x10621872` | `0x10620dc0` (0x59b) | `0x106215f4` (0x27e) | `(mode & ~2) | 0x41` |
| otherwise (mono or no MMX) | `0x1062414f` | stereo `0x10623578` (0x96e, patched) / mono `0x10623210` (0x368, patched) | `0x10623eed` (0x262) | mode `| 2` |

`mode = (0x10698179 & 0x85) | 2`, which is 7 installed. **A modern CPU, or
CrossOver/Rosetta (KNI reported), takes the SSE row** unless the game is started with
`-NOKNI`. The SSE conversion routine is not usable for mono: `and cl, 1` sets ZF and a
`shl` by 0 leaves it set, so `je` exits (`0x10622ff3..0x10622ffb`). The SSE path is
only selected for stereo anyway.

### 2.2 Per-voice setup inside the mixer (`0x1061525a..0x10615432`)

Here `esi = V + 0x14`; the offsets below are given relative to V.

* **Skip** the voice unless all of these hold: `V+0x10 ≠ 0`, `V+0xf ≠ 0` (playing),
  `step V+0x62 ≠ 0` (`0x1061525f..0x1061527a`). A zero step is skipped, so the
  `idiv` below never divides by zero.
* **Kernel mode** `[esp+0x34]`:
  * bit 0 = `V+0x4c` bit 2 (16-bit sample);
  * bit 1 = (`0x10697cfc` bit 2, i.e. UseFilter) and `step < 0x10000` (signed `setge`),
    so interpolation is also used for every backwards step;
  * bit 2 = `V+0x14` bit 15 (surround flag) (`0x10615280..0x106152bc`).
* **Pan ramp, per segment** (`0x10615318..0x10615349`). `d = (V+0x16 & 0x7fff) − (V+0x14 & 0x7fff)`,
  clamped to ±0x200, added to the full word `V+0x14`. The control `0x1060d280`
  writes **both** `V+0x14` and `V+0x16` (`0x1060d306..0x1060d30a`), and the 2D start
  does the same (`0x106125e6..0x106125ea`). The subsystem's extra `V+0x16` store
  (`0x1060a333`) writes the same value. **So effect voices never ramp: the pan jumps
  at the next segment.** No volume ramp and no de-click exist in any path.
* **Effective pan** (`0x1061534c..0x1061537f`): `p = V+0x14 & 0x7fff`. Then
  `p += (((0x4000 − |p − 0x4000|) · (s16)V+0x36) >> 15) · (u16)V+0x3c >> 15`
  (pan envelope and separation; both are 0 for effect voices).
* **Volume chain** (`0x10615307..0x106153d1`, verbatim order; each step is a signed
  32-bit `imul` then `sar 15`):
  ```
  m   = (s8)master; mm = m*m*2                         ; 0x10615307/0x10615315/0x10615327
  v   = (u16)V+0x12 * mm      >> 15                    ; 0x10615383..0x10615396
  v   = v * (u16)V+0x18       >> 15
  v   = v * (u16)V+0x1a       >> 15
  v   = v * (s16)V+0x24       >> 15
  v   = v * (u16)V+0x2a       >> 15
  v   = v * (u16)V+0x66       >> 15                    ; V+0x66 = control volume
  ```
  Worked default for an effect voice (`V+0x12 = 0x7e02`, master 127, four `0x7fff`
  factors): `32258·32258 >> 15 = 31756 → 31755 → 31754 → 31753 → 31752`, then
  `· V+0x66 >> 15`. If `v == 0` the voice is not mixed, but its position still
  advances (`0x106154a4`).
* **Pan law, equal power.** Table `T = [0x10698390]` with
  `T[i] = ftol(sqrt(i · K) · 32767.0)`, where `K = f64 0x1063ec38 = fl(1/32767)` and
  32767.0 is `0x1063ec30`. Then `L = T[0x7fff − p] · v >> 15` and `R = T[p] · v >> 15`
  (`0x106153c4..0x106153f0`). L is the first lane of the stereo pair.
  `T[0x3fff] = 23169`, `T[0x4000] = 23170`; `T[0x7fff]` depends on the x87 precision
  (§4).
* **Sends:** `s1L = V+0x1e · L >> 7`, `s1R = V+0x1e · R >> 7`, `s2L = V+0x1c · L >> 7`,
  `s2R = V+0x1c · R >> 7` (`0x106153e2..0x10615426`).
* **Kernel call** (`0x106154a8..0x106154e6`, cdecl, 14 arguments):
  `(bus0, bus1, bus2, count, pos V+0x46, frac V+0x4a, step V+0x62, L, R, s1L, s1R, s2L, s2R, mode)`.

### 2.3 Boundaries, loops, ping-pong (`0x10615434..0x106155a1`)

Repeated until the segment's frames are used up:

1. `bound`:
   * if `V+0x4c & 8` (loop) and (`V+0x4c & 0x80`, or `!(V+0x0c & 0x80)`, or
     `step < 0`): `bound = V+0x56` (loop end, which is the loop start while travelling
     backwards);
   * otherwise `bound = V+0x5a` (sample end).

   `V+0x0c` bit 7 is likely note-off: it releases a sustain-style loop on forward
   travel (`0x10615442..0x10615463`).
2. `d = clamp(bound − pos, −32767, 32767)`.
   `frames = ((d << 16) − (u16)frac) / step + 1`, using signed `idiv` that truncates
   toward zero. Then `frames = min(frames, remaining)` (`0x10615466..0x106154a2`).
   This overshoots by one frame when the division is exact.
3. Mix `frames` (if `v ≠ 0`). Then `t = step·frames + frac`; `V+0x4a = (u16)t`;
   `V+0x46 += t >> 16` (arithmetic) (`0x106154e9..0x10615507`). **The outer state uses
   the full-precision step.**
4. `over = (step < 0) ? bound − pos : pos − bound` (`0x1061550a..0x10615517`).
   If `over ≥ 0`:
   * **Looping** (same condition as in step 1):
     * if `V+0x4c & 0x10` (ping-pong): swap `V+0x52` and `V+0x56`, negate the step;
     * then `pos = V+0x52 + over` (`0x1061551d..0x10615550`).

     So forward → backward keeps `pos` past the old loop end: no reflection, and
     `frac` is unchanged. Backward → forward reflects: `pos = loopStart + (loopStart − pos)`.
   * **Not looping:** `V+0xf = 0` (voice ends). If `V+0x11 & 2`, call
     `[0x1069838c](V, 0, 0)`; the subsystem installs `0x10601064` via `0x1060e980` at
     `0x10605673`. The subsystem's poll `0x1060cf00(voice, 2, …)` returns `V+0xf`
     (`0x1060d019..0x1060d020`), so Update frees the channel.

**Positions.** `V+0x46` is a byte pointer for 8-bit data and a byte pointer / 2 for
16-bit data (`0x10612509..0x10612511`); the kernel reads `[esi]` for 8-bit and
`[esi+esi]` for 16-bit. 2D-start state:
* non-ring samples: `V+0x4e` = data start, `V+0x52` = start + loop start (`+0x34`),
  `V+0x56` = start + loop end (`+0x38`), `V+0x5a` = start + length (`+0x30`)
  (`0x1061252d..0x1061254b`);
* ring path, taken for format `& 0xe000` or `& 0x40` (`0x10612520..0x1061258f`):
  `V+0x4c |= 0x88`, loop `[ring, ring + 0x7fff]`.

Format `0x40` makes the 2D start allocate two voices (`count = 1 + (fmt & 0x40 ? 1 : 0)`,
`0x10612355..0x10612366`) and hard-pan them 0 / 0x7fff (`0x106125c7..0x106125da`).
It likely means a stereo pair. It is **not** the streamed bit: the streamed bit is
`0x4000`.

### 2.4 Step from frequency

* Effect voices: `V+0x62 = (freq / rate) << 16 + ((freq % rate) << 16) / rate`,
  unsigned. This equals `floor(freq · 65536 / rate)`. Sites: 2D start
  `0x106125ee..0x1061261c`, control `0x1060d30e..0x1060d33c`. `freq = V+0x5e`; a
  frequency of −1 means the sample rate (`+0x3c`).
* Module voices: `0x10615660(V, period)`, called from the envelope pass at
  `0x106150ee`.
  * If `0x10697ce8 & 1`: `freq = 57269824 / period` (`0x369de40`).
  * Otherwise: `freq = (C5 · tbl[(period % 3072) >> 2]) >> (period / 3072 + 10)`,
    with `tbl` at `0x1063df80` (`__allmul` / `__allshr`).
  * Then the same q/r division. The step is negated when `V+0x52 > V+0x56`
    (backwards).
  * `period` is clamped to `0..0x7800` (`0x106150c6..0x106150d3`).

### 2.5 SSE mixing kernel (template `0x10622730`) — per-frame arithmetic

* **Setup** (`0x10622734..0x1062281d`):
  * if `mode & 4`, negate the low words of R, s1R and s2R (phase-inverted surround);
  * `frac &= 0xfffe`, `step &= ~1`;
  * gain vectors as float32 pairs: `[0x1064d2b0] = (L, R)·2⁻³⁰`,
    `[0x1064d2c0] = (s1L, s1R)·2⁻³⁰`, `[0x1064d2d0] = (s2L, s2R)·2⁻³⁰`.
    Each is computed as `cvtsi2ss` of a sign-extended word, times
    `f32 0x1064d2f0 = 2⁻³⁰` (exact), and stored twice.
* **Position:** `edx = frac << 16 | count` and `esp = (step & 0xfffe) << 16` (ESP is
  saved in `[0x1064d32c]`), `ebp = (step & ~1) >> 16` (arithmetic). Per fetch:
  `add edx, esp; adc esi, ebp`. This is a 16.16 accumulator in the high word.
* **Interpolation is always linear.** No branch reads mode bit 1 (only `& 4` at
  `0x10622734` and `& 1` at `0x1062281d`). For frame k, at integer position `p_k` with
  even fraction `f_k = (frac&~1) + k·(step&~1)` (mod 2¹⁶, carries into `p_k`):
  ```
  8-bit : a = (s8)x[p_k] << 8,  b = (s8)x[p_k+1] << 8      (bytes are signed)
  16-bit: a = (s16)x[p_k],      b = (s16)x[p_k+1]
  o_k   = b·(f_k>>1) + a·(32767 − (f_k>>1))              (pmaddwd, int32; weights sum to 32767)
  ```
  The weights live in `mm3` as `[f/2, 32767 − f/2]` for two frames. They advance by
  `mm4 = [s/2, −s/2]` per frame and are masked with `0x7fff7fff7fff7fff`
  (`0x1064d2e0`) (`0x106227c7..0x10622819`, `0x10622871..0x10622883`).
* **Accumulation, per frame and per bus**, all IEEE float32 SSE:
  `bus[2k..2k+1] = bus + fl(fl(cvtpi2ps(o_k)) · gain)`, using `cvtpi2ps`, `mulps` and
  `addps`. The three buses get the same `o_k` with their own gains.
* **Pipelining:** two frames are pre-computed. The main loop stores four frames per
  iteration (`0x10622918..0x10622a05`). A one-frame `movlps` prologue runs when bus0
  is not 16-byte aligned (`0x10622889..0x10622912`), and a one-frame tail runs at
  `0x10622a15..0x10622a92` (`psubw mm3, mm4` steps the weights back one frame). Every
  stored frame k gets exactly `o_k` above; this is verified (§8). The kernel reads up
  to two sample pairs past the last frame; this does not affect the output.
* **Frame count** (§8.2): the count is the 16-bit `dx`. When bus0 is not 16-byte
  aligned, the prologue stores one frame **before** the count is tested, so a run
  of count 0 at an odd bus frame still adds one frame.
* **Lanes:** gain lane 0 (the first float of a stereo bus frame, the left output
  sample) is kernel arg 7 = `tab[0x7fff − P]·V >> 15`; lane 1 is arg 8 =
  `tab[P]·V >> 15`. Mode bit 2 negates the low word of args 8, 10 and 12.
* **Chunk dependence.** The kernel uses `step & ~1` and `frac & ~1`, while the outer
  update (§2.3) uses the full step. The kernel's positions and weights therefore drift
  from the true 16.16 position by up to `k · (step & 1)` / 65536 within a call, and
  the drift is reset at every call. **The output depends on where calls start**:
  segment, 512-frame, callback and loop boundaries.
* **Bus summation order** is slot order 0 → N−1, per frame.

### 2.6 SSE conversion kernel (template `0x10622fe4`)

Called as `conv(bus, frames, dst, fmt)`. It processes `frames << (fmt & 1)` scalars.

| fmt | Path | Per scalar |
| --- | --- | --- |
| 16-bit, no `0x40` (bus A) | `0x10623180..0x106231ca` | `dst = sat16(cvtps2pi(x))`. `cvtps2pi`/`cvtss2si` round with MXCSR (RNE), then `packssdw`. |
| 16-bit, `0x40` (bus B) | `0x1062311e..0x1062317c` | `dst = sat16(dst + sat16(rne(x)))` (`packssdw`, `paddsw`) |
| 8-bit (`fmt & 2 = 0`) | `0x10623009..0x10623117` | `(sat16(rne(x)) +s 0x80) >>a 8`, `packsswb`, then `^0x80` bias when `fmt & 0x80`. The add path uses `paddsb` on the unbiased value. |

Installed: bus A is converted with fmt `0x07` (overwrite) and bus B with fmt `0x47`
(saturating add). An out-of-int32 float would convert to `0x80000000` and saturate to
−32768. That would need more than 65536 full-scale voices, so it cannot happen.
Verified for both 16-bit paths (§8). The 8-bit paths are not translated. With
`fmt & 0x80 = 0` they add `mm5`, which is set only when `fmt & 0x80`, so they
add whatever the previous MMX code left there (`0x10623009..0x1062301a`).

### 2.7 Non-SSE kernels (not the reference path; listed so they are not mistaken for it)

* **x86 stereo** `0x10623578`: per-call volume quantization through the byte table
  `0x1064d338` (index `gain >> 3`) into 64 levels. Tables at `[0x10698344]`, built by
  `0x10614080` (`0x10614173..0x106141c1`):
  * `+0` and `+0x10000`: `(s8)s · v²·16` and `((u8)s · v²·16) >> 8` for v = 0..63;
  * `+0x20000` (`0x106886a0`): 8-bit clip table;
  * `+0x22000` (`0x10697cf4`): 17 pairs from weights `0x1063da5c`
    = {64, 63, 62, 59, 55, 50, 44, 38, 32, 26, 20, 14, 9, 5, 2, 1, 0}.

  Integer int32 accumulators. Mode bit 1 selects interpolation (`0x106235e9`);
  otherwise nearest. **UseFilter only matters here**, and in mono.
* **MMX** `0x10620dc0`: 4-byte bus frames, i.e. 16-bit lanes (shift 2).
* **3DNow** `0x1062255c`: never chosen when SSE is present.

### 2.8 Master volumes and fades

* Music master `0x10697cf0` (0..127) is set by `0x1060eb60(vol, fade)`. With fade 0
  the setter stores the value; otherwise it stores step `0x106886a4` and target
  `0x106886a5`. Its subsystem callers are `0x106062b5` and `0x10606697`.
* Effects master `0x1069817c` is set by `0x1060ec00` (galaxy-volumes.md), with step
  `0x10697ca0` and target `0x10697ce4`.
* The masters are applied squared ×2 in the chain (§2.2).
* Fades step the master toward the target once per **sequencer tick**, never
  overshooting (`0x10617f50..`).
* Library init and the module reset `0x1060e850` set the music master to 127
  (`0x1060e931`).

## 3. Reverb (UseReverb=True)

* **Effects bus only.** Update (`0x1060aa15..0x1060ab93`) zeroes a 0x6c-byte block. If
  UseReverb (`+0x44`) is set, and the listener region's zone (`[ebp−0x40]+0xc8`) has
  bit 0 of `+0x3bc` set (likely bReverbZone), it fills these floats with x87:
  * `+0x0c = MasterGain(+0x3c4)/255` (`fild`, `fmul m64 0x1063d548`, `fstp`);
  * `+0x10 = clamp(CutoffHz +0x3c8, 0, 44100)`;
  * six pairs at `+0x34 + 8i`: `clamp(Delay[i] +0x3cc · 0.002f, 0.001f, 0.34f)` and
    `clamp(Gain[i] +0x3d2 · (1/255)f, 0.001f, 0.999f)`
    (`0x1063d6c4`, `0x1063d6c0`, `0x1063d6bc`, `0x1063d724`, `0x1063d6b8`).

  When the block differs from the cached copy at `subsystem+0x88e`, Update calls the
  library's **effects-bus** reverb setter `0x106113d0` (`0x1060ab8e`). Init clears it
  (`0x10605f54`). `MasterGain == 0.0` frees the reverb (`0x106113eb..0x106113f9`).
* **Kernel:** `0x10622d33` for SSE (`0x106220e7` 3DNow, `0x1062135b` MMX, none without
  MMX). It is hooked as (d04 dry, d0c send), so it processes every non-module voice
  through its send level `V+0x1e`. That send is `0x7f` from library init; the 2D start
  does not touch it. The only other writers are dead (`0x1060d1c0`) or module-only
  (`0x10611e30` sets 0x28).
* The kernel itself is float32 SSE: three 16384-frame stereo delay lines
  (`ctx+0xc8`, `+0x200c8`, `+0x40108`), an input low-pass, output gain `ctx+0xb8`.
* **Music bus:** no reverb or chorus is reachable. The music-reverb setter
  `0x1060f3c0` is called only from the `'RVRB'`/`'CHRS'` chunk reader `0x106244d0`.
  That reader is called only by the `"AE  "` file loader `0x106189e0`, which has no
  call site, pointer or export. The chorus setters `0x1060ec60` (music) and
  `0x10611230` (effects) are likewise unreferenced. So the docs' "3D voices only when
  +0x78" refers to the subsystem's own call `0x106011cc → 0x10601600` (hardware-3D
  path), not to this software reverb.

## 4. Floating point in the chain

* **Mixing and conversion kernels:** SSE (float32) and MMX only; no x87.
  * Scan with zero x87 instructions: `0x106142a0..0x10614911`,
    `0x10614920..0x1061565b`, `0x10615660..0x1061570e`, `0x10617f50..`, `0x1060d280..`,
    `0x10612310..`, `0x10613350..0x106142a0`, kernels `0x10622730..0x106231d0`
    (`femms` only in the 3DNow kernels).
  * Galaxy contains no `fldcw`, `fnstcw`, `ldmxcsr` or `stmxcsr`.
  * The kernels run on the winmm timer thread. **Assumption:** the thread's MXCSR is
    the Windows default `0x1f80` (RNE, no FTZ/DAZ). Rounding points: `cvtpi2ps`,
    `mulps`, `addps`, `cvtps2pi`/`cvtss2si`.
* **sqrt pan table** (`0x1060e259..0x1060e283`, game thread, subsystem Init): per entry
  `fild dword`, `fmul m64 K`, `fsqrt`, `fmul m64 32767.0`, then MSVCRT `_ftol` (stub
  `0x106300f4`, truncation). The result depends on the x87 precision control. I
  computed this exactly in Python with rationals:
  * PC=53: identical to `Math.trunc(Math.sqrt(i*K)*32767)`;
  * PC=64: only `T[32767] = 32766` (instead of 32767), because `32767·K` rounds below
    1.0;
  * PC=24: 53 entries are +1 (first ones: 669, 937, 1472, 2206, …).

  The CrossOver DeusEx.log shows D3D device setup (lines 83–110) **before** Galaxy Init
  (line 121). So the table is built under the post-D3D control word, which is the
  project's open FPUSETUP question.
* **Reverb setup** `0x106109f0..0x10611221` (game thread, inside Update): roughly
  80 `fld`, 60 `fstp`/`fst`, `fmul`, `fdiv`, `fidiv` operations, plus **`fcos` ×3**
  (`0x10610ac1`, `0x10611164`, `0x1061119b`), **`fyl2x` ×6** (`0x10610e5d`,
  `0x10611052`, `0x1061106a`, `0x106110ef`, `0x10611103`, `0x10611122`), `fsqrt` ×2,
  and `_ftol` ×7 for the delay lengths (`0x10610b2a`, `0x10610bc0`, `0x10610c4c`,
  `0x10610cd7`, `0x10610d63`, `0x10610def`, `0x1061112a`). The constant 6.282f is at
  `0x1063ed04`. The transcendental results must be measured on hardware.
* The subsystem side (frequency `ftol(rate·pitch·doppler)` at `0x1060a308..0x1060a319`,
  volume, pan) is already translated (docs/galaxy-audio.md).

## 5. What is deterministic and what is real-time

* **Deterministic** given the voice state, the counters `cnt1`/`cnt2` and the call
  sequence: everything inside `0x10614920`, the kernels, the conversion and the hooks.
* **Real-time** in the original:
  * frames per callback (DS cursor granularity, timer jitter);
  * the music/effects ring offset D;
  * when a game-thread change lands (the next callback);
  * underrun resyncs;
  * stream-decoder progress.

  Request boundaries change the output through three mechanisms: the per-call
  step/frac truncation (§2.5), the per-segment pan ramp and gain refresh, and the
  start time of a tick's state (§1.4). A bit-exact translation can reproduce the
  mixer for a **given** chunk schedule. It cannot reproduce the schedule.

## 6. Unresolved branches / open questions

1. **Two-head placement and the music delay** (§1.3) is read from code and
   unmeasured. Confirm by recording.
2. **The live sqrt table variant** (PC 24/53/64) depends on the game thread's control
   word at Galaxy Init. *Measured 2026-10-16 (audio-output-scope.md §5.1): the running
   original's table is the PC 53 variant (control word 0x027f at Init); the timer thread's
   MXCSR is 0x1f80.* As first written:
   word at Galaxy Init. Also the timer thread's MXCSR (assumed `0x1f80`).
3. *Measured 2026-10-16: the CrossOver open takes the DS path (`[0x10698178] = 1`, the
   SSE kernel, mode 0x47).* **Whether the CrossOver/Windows open takes the DS path** (EMULDRIVER, primary
   `SetFormat` acceptance). Init's probe passed; the open was not observed.
4. **Envelope pass `0x10614a42..0x1061517f` and sequencer tick `0x10615710`**: module
   voices only. Hand-off to agent C:
   * ticks are processed before the segment they end;
   * `cnt1`/`cnt2` phases are free-running from library init;
   * tick-length formulas are in §1.4;
   * the envelope pass gates on `V+0x0f ≠ 0` and `V+0x20 ≠ 0` (`0x10614a6a..0x10614a80`).
     A voice without an instrument pointer gets no envelopes, no envelope writes of
     volume `V+0x66` (`0x1061515a`) or period `V+0x6a` (`0x106150df`) and no per-tick step recompute through `0x10615660`.
5. **Hand-off to agent B:**
   * 8-bit data must be signed in memory;
   * interpolation reads `x[pos+1]` with no loop awareness, so the post-loop-end
     padding written by the loader determines the last interpolated sample;
   * how `V+0x46`/`0x52`/`0x56`/`0x5a` are derived for module samples;
   * `V+0x4c` bits: 4 = 16-bit, 8 = loop, 0x10 = ping-pong, 0x80 = loop always,
     0x40 = pair, 0x2000 / 0x4000 / 0x8000 = decoded or streamed.
6. **Decoder-thread race:** refills are posted once per sequencer tick (about 10.4 ms
   at the default tempo 120 with `0x10698342 = 48`). The ring logic is translated and
   oracle-checked (galaxy-audio.md "Speech on Galaxy's ring transport"): each message
   fills up to the read head, so the decoder is a ring ahead once two messages ran; the
   thread's scheduling on the reference machine is host timing.
7. **`V+0x0c` bit 7** (likely note-off) and `V+0x4c & 0x80` semantics need agent C's
   writers.
8. **Not read:** the 3DNow and MMX kernels in detail; the x86 kernel beyond its
   dispatch; the hardware-3D path (`0x10612800`, `0x106126f0`); the decoders
   `0x1061a690`, `0x1061a170`, `0x10619800`.
9. ~~**SSE pipelining** (§2.5) is by reading.~~ Verified (§8): odd bus offsets,
   n = 0..9, 15..17 and 511..513, full template coverage.

## 7. How I would probe this

**A. Unicorn oracle for the mixer.** This follows the pattern of the existing
`scripts/native-galaxy-*-oracle.py` loaders: the Galaxy image mapped unchanged, Python
leaves for imports.

1. **Map and set up the image.**
   * Map Galaxy.dll and the heap blocks:
     * `[0x10698344]` (0x28000);
     * `[0x10698354]` (0x2000, mapped **RWX**);
     * `[0x10698390]` (0x10000);
     * six buses (64-aligned, 0x1040 each, at `0x10697d00..14`);
     * a staging ring at `[0x10697ccc]`.
   * Set `0x1068dc80 = 1`, `0x10698340 = 1`, `0x10698190 = 0`, `0x10698179 = 7`,
     `0x10697d18 = 44100`.
   * Run **`0x10614080(7)` in the emulator**, so the SSE kernel and conversion routine
     are copied exactly as the original does; this also fills `0x10697ca4` and
     `0x10697cfc`.
   * Fill the sqrt table three ways (PC 24/53/64, from the exact rational model) and
     keep the variant as an oracle input. Unicorn's QEMU x87 precision-control support
     is not trusted here.
   * Enable SSE (set `CR4.OSFXSR`/`OSXMMEXCPT` if the Unicorn build needs it) and set
     MXCSR to `0x1f80`. `cvtpi2ps`, `cvtps2pi`, `mulps` and `addps` go through QEMU
     softfloat and are IEEE-exact, unlike x87 transcendentals.
2. **Globals and stubs.**
   * Set `0x1068828d`/`0x10698348` to the slot counts, the masters, and `ahead = 1`.
   * Set `cnt1`/`cnt2` to large values to suppress ticks, or to chosen phases for tick
     cases.
   * Hook `0x10615710` and `0x10617f50` as **recording leaves**. Stub
     `PostThreadMessageA` and record its arguments.
3. **Fabricate voices** in slots: `+0x0c`, `+0x0f = 1`, `+0x10 = 1`, `+0x11` (8 or
   0x80), `+0x12`, `+0x14`/`+0x16`, `+0x18`/`+0x1a`/`+0x24`/`+0x2a`, `+0x1c`/`+0x1e`,
   `+0x20 = 0`, `+0x36`/`+0x3c`, `+0x46` (data address, /2 for 16-bit), `+0x4a`,
   `+0x4c`, `+0x52`/`+0x56`/`+0x5a`, `+0x62`, `+0x66`. Sample data with guard bytes
   after the end.
4. **Run** `0x10614920(d00..d14, n)` directly, or `0x106146a0(ring, size, posA, posB, lenA, lenB)`
   to include the hooks and conversion. Compare against the JS/Rust model bit for bit:
   * the six float32 buses;
   * the int16 ring;
   * `V+0x46`, `V+0x4a`, `V+0x14`, `V+0x52`/`V+0x56`/`V+0x62` after ping-pong, `V+0xf`;
   * the `ahead` counter;
   * the recorded tick and post calls.
5. **Cases:**
   * 8-bit and 16-bit;
   * steps 0x10000, 0x8000, odd low bits (0x10001, 0x17fff), > 1, < 0;
   * n = 1..8, 511, 512, 513, and odd-frame bus offsets (the `movlps` prologue);
   * loop / ping-pong / one-shot ends, including an exact division in the
     frames-to-boundary formula;
   * pans 0, 0x3fff, 0x4000, 0x7fff, and the 0x8000 surround bit;
   * masters 0..127 and `v = 0` skips;
   * 16 to 48 voices summed (order);
   * saturation in both conversions (bus A store, bus B add onto a full-scale ring);
   * segment splitting at chosen `cnt1`/`cnt2` phases;
   * the SFX reverb with parameters taken from real Island zones. Its `fcos`/`fyl2x`
     results get hardware values injected, the same way as the lip-sync twiddles.
   * A random-sequence mode: voice starts and stops, control changes, chunk schedules.

**B. Hardware and live measurements** (CrossOver bottle, following the existing
live-capture technique):

* Read `[0x10698390]` (64 KB) from the running game: settles the precision variant.
* Read `0x10697cfc`, `0x10698179`, `0x10698178`, `0x10697cd0`: confirms the kernel,
  output format, DS vs WinMM, and ring size.
* Read `0x10697cd4`/`0x10697cd8` over time: gives D and the per-callback R.
* **Record the output** (loopback) while one frame starts a short click sound and a
  music section change (or `0x1060d0e0` mode 2). The offset between them should be
  about `ring − D` if §1.3 is right.

## 8. Phase 3: translation and verification (2026-10-06)

### 8.1 What runs

* **Rust:** `native/galaxy-kernel/src/mixer.rs` contains:
  * the kernel (`mix_kernel`), called from `sequencer.rs`'s `mix_voice` after
    the K record;
  * the bus clear (`clear_buses`, from `mix`);
  * the conversion;
  * `render_ring` (0x106146a0 over a staging ring);
  * `render` (the same loop, bus A only, for the browser).

  The six buses are one `Vec<f32>` in d00..d14 order at stride 0x1040, as
  glxInit carves them (`0x1060e1d6..0x1060e20d`: `d00 = align64(block)`).
* **Oracle:** `scripts/native-galaxy-music-sequencer-oracle.py --real-kernel`.
  * The code buffer keeps the kernel and conversion that the real
    0x10614080(7) copied (setup 0x106231d1: kernel 0x603 bytes, then the
    conversion 0x1ed bytes). The oracle checks this copy against the
    templates.
  * MXCSR is 0x1f80. Unicorn 2.1.4 starts with MXCSR 0 and with CR4 =
    0x50200, which already has OSFXSR set.
  * Each 20 ms callback calls the renderer on a 176400-byte ring. The first
    callback wraps at the end of the ring, and bus B is half a ring ahead.
  * K is recorded at the call site 0x106154e0, before the kernel modifies its
    stack arguments. M and R are recorded at the mixer entry and at its `ret`.
    The trace is byte-equal to the stub mode's, which checks the hook points.
  * Fabricated programs drive the kernel, the conversion and the renderer
    directly, with synthetic voice records and sample memory at FAB =
    0x50000000.
* **Host CPU:** `scripts/native-galaxy-mixer-hw.c` (`gcc -m32`) copies the
  two templates into executable memory and the page 0x1064d000 (gain
  vectors, mask, 2^-30, saved ESP) to a fixed mapping. It then runs the
  oracle's kernel and conversion programs natively.

### 8.2 Evidence

`node scripts/validate-galaxy-mixer.mjs` checks the following.

* **Songs:** 11 cases. For each it compares the sequencer trace, the int16
  PCM of both buses per callback, the six float32 buses after every mixer
  call of the first 8 callbacks, and `galaxy_render`'s bus-A output. All
  are bit-equal.

  | Case | Section | Callbacks |
  | --- | --- | --- |
  | Intro | 0 | 2000 (40 s, 2449 ticks) |
  | Intro, counters at another phase | 0 | 400 |
  | Title, UNATCO, HongKong, Lebedev (instrument mode), Endgame1 (Amiga), Area51 | 0 | 500 each |
  | NavalBase | 0 | 400 |
  | OceanLab2 | 2 | 250 |
  | Quotes | 4 | 250 |

* **Fabricated programs:** 17 programs, 1198 groups, all bit-equal.
  * **Kernel calls:** 3 × 278 direct calls:
    * 8- and 16-bit samples;
    * steps 0x10000, 0x8000, 0x10001, 0x17fff, 0xffff, 1, 3, 0x2fffe,
      0x7fffe and negative steps;
    * fractions 0, 1, 0x8000 and 0xffff;
    * counts 0..9, 15..17 and 511..513 at bus frame offsets 0..7;
    * gain words 0, ±1, 0x7fff and 0x8000, plus values above 16 bits;
    * surround on and off;
    * buses prefilled with denormals, signed zeros, and tiny and large
      values, or zeroed.
  * **Conversions:** 270 direct calls:
    * ties ±0.5, ±1.5, ±2.5 and ±3.5;
    * ±32767.5 and the saturation edges;
    * ±2^31, values out of range, ±inf, quiet and signalling NaN, and
      denormals;
    * the store and add formats 0x07/0x47/0x87/0xc7, and mono 0x06/0x46
      (a no-op);
    * 0..520 frames.
  * **Renderer:** 13 programs of synthetic voices:
    * forward loops, ping-pong in both directions, one-shot ends including
      an exact division, and key-off release;
    * pans 0, 0x3fff, 0x7fff and 0xc000, plus surround, ramps, the pan
      envelope term and both sends;
    * `v = 0` skips, a step of 0, and master 0;
    * saturation of the bus A store and of the bus B add onto a ring
      filled with 0x7f00;
    * request sizes 1..8 and 511..513;
    * 48 voices, and 3 random programs.
  * **Count 0 at an odd offset:** 381 runs of count ≤ 0 at odd bus offsets
    in `mix-count-zero`.
* **Unicorn against the hardware:** all 1104 kernel and conversion
  operations give the same bytes on the host CPU (AMD, Linux, MXCSR 0x1f80)
  as under Unicorn. So Unicorn's `cvtpi2ps`, `mulps`, `addps`, `cvtps2pi`,
  `cvtss2si`, `pmaddwd`, `packssdw` and `paddsw` are exact here, including
  for denormals and NaN.
* **Coverage:**
  * kernel template: 443 of 443 instructions;
  * conversion: 75 of 154; the unreached part is the 8-bit paths, which are
    not translated;
  * renderer: 174 of 222; the unreached part is the four effect-hook
    calls, which are null for DX.
* **Mutants:** each is caught.
  * 201, full step: by 10 programs;
  * 202, round half away: by 12;
  * 203, f64 arithmetic: by 16;
  * 204, no saturation: by 6.
* **Rust unit tests** (`cargo test`):
  * hand-computed frames: o = 16809471 rounds to 16809472 under
    `cvtpi2ps`, the gain word is sign-extended from 16 bits, surround
    negation, and the count-0 prologue frame;
  * conversion edges;
  * frame counts.

### 8.3 Corrections and findings

* **Negative run counts write over the buses.** Quotes_Music reaches this in
  all five sections within 30 s.
  * The cause is a 9xx offset that puts a voice below the start of its
    backward ping-pong loop. With bound − pos > 0 and step < 0, the run count
    `(d<<16 − frac)/step + 1` is negative (−6752 in Quotes section 4).
  * At an aligned bus offset the kernel stores no frame for that run (the
    count word is negative; §2.5 frame count). The mixer then
    adds the negative count to `remaining`, which grows from 157 to 6909, and
    moves the bus pointers 54 KB back (`0x1061557f..0x1061559d`).
  * The next run writes 6909 frames from there. Those writes cover the non-SSE
    table block before the bus block (allocated just before it,
    `0x1060e1b4`, never read on the SSE path) and the buses d00..d10 at
    shifted frames.
  * The model keeps the six buses as one block, applies the writes that land
    on them, and drops the writes below d00 (`HAZARD_BUS_UNDERRUN`). This is
    bit-equal to the oracle, whose allocator places the blocks in call order.
    Whether Windows' heap does the same is not measured. If it does not,
    the original writes over other heap data there.
* **Reads before a sample.** For a backward run, `step & ~1` moves the kernel
  up to `count/65536` frames below the true position. When the loop start is
  the sample's first frame, the last frame reads `x[start − 1]`, which is 1
  or 2 bytes before the allocation. NavalBase, OceanLab2 (16-bit), Area51
  and MJ12 (8-bit) all reach this the same way: a ping-pong loop from frame 0
  on its backward pass, with the last frame at position −1.
  * The original reads heap memory there: a block header or a neighbour,
    depending on the platform. That byte's weight is at most about
    `count/2` of 32767.
  * The model reads the neighbouring allocation of the bump-heap address
    model, or 0 in a block's 16-byte rounding gap, and flags
    `HAZARD_FOREIGN_READ`. The oracle zeroes its heap between cases, so the
    two agree, and the cases are bit-equal. The game's value is unknown.
* **Never-written sample tails** (the loader's 972 bytes): no read in the
  sweep (`HAZARD_UNWRITTEN_TAIL` never set).
* **Count 0 at an odd bus offset** stores one frame (§2.5). In
  `mix-count-zero` this is reached by a loop shorter than one step: the
  position drifts past the loop end, and a count-0 run then pulls it back by
  the loop length.

### 8.4 Interface

* Rust: `pub fn render(&mut self, frames: i32, out: &mut [i16]) -> Result<i32, u32>`
  on `Library`. It returns the frames rendered; fewer than `frames` only when
  `ahead` is 0. It does not allocate.
* Wasm exports:
  * `galaxy_render(frames: u32) -> *const i16`: 2·frames interleaved int16
    (left, right), valid until the next call, or 0 on a fault. It first pins
    `ahead` (0x10697cdc) to the `galaxy_seq_ahead` value, or to
    `DEFAULT_AHEAD` = 7056 when none was set. Only zero or nonzero gates the
    mixer, so the PCM does not depend on the value.
  * `galaxy_fault() -> u32`: the fault code, sticky until `galaxy_reset`.
  * Faults: 0x120 bus write past d14 or far below d00; 0x121 8-bit output
    or an odd ring position; 0x122 the dispatch would not pick the SSE
    kernel (no `galaxy_seq_setup`); 0x106 a read with no model memory.
  * `galaxy_mixer_hazards() -> u32`: bit 1 unwritten tail, 2 foreign read,
    4 bus underrun.
  * Validator-only exports: `galaxy_mixer_buses`, `_memory`, `_kernel`,
    `_scratch`, `_convert`, `_ring`, `galaxy_render_ring`, `galaxy_poke`,
    `galaxy_voices_ptr`, `galaxy_mixer_bus_log*`, `galaxy_mixer_ahead_now`.
* **Chunk schedule.** The output depends on where mixer calls start (§2.5,
  §5). To reproduce the original's schedule, call `galaxy_render(882)` once
  per 20 ms of output (one timer callback at Latency 40 and 44.1 kHz) and
  buffer the result. Do not call it per 128-frame AudioWorklet quantum.
* **Cost:** a median of 81–110 µs per `galaxy_render(882)` in Node's Wasm
  (p99 about 200 µs) over the whole corpus.

### 8.5 Open

* ~~The timer thread's MXCSR on the reference machine.~~ Measured 0x1f80
  (audio-output-scope.md §5.1).
* ~~The bus placement (§1.3) and the CrossOver open path (§6.1, §6.3).~~ The
  callback is oracle-checked (§9) and D measured: 8,820 bytes (§5.1 of the
  scope), the DS path and the SSE kernel taken.
* The real heap's contents next to sample allocations
  (`HAZARD_FOREIGN_READ`) and the block adjacency behind
  `HAZARD_BUS_UNDERRUN`.
* ~~Bus B in the browser.~~ Wired (2026-10-06): `render` (galaxy_render)
  stores bus A, then adds bus B onto the same frames, the renderer's own
  placement when posB equals posA. The effect voices are the library's
  ([effects](effects.md)). The browser path is compared with the original
  renderer at coincident heads in validate-galaxy-effects.mjs, including
  Quotes_Music section 4, where the underrun writes music onto d04.
* ~~Reverb (§3).~~ Translated (2026-10-06): the renderer's effects hook
  runs the SSE reverb kernel between the mix and the conversions
  ([reverb](reverb.md)). The non-SSE kernels (§2.7) are not translated.
* Cost with effects: on Island, `galaxy_render(882)` takes 135 µs median
  (p99 244 µs) with music and six or seven effect voices, and 143 µs with
  the reverb on Brooklyn Bridge Station (validate-galaxy-effects-play.mjs,
  Node's Wasm on the Linux host).
* The other songs and sections depend on the sequencer validation. The
  `--sweep` option runs the Rust kernel alone over all 35 songs and 1157
  sections (1500 callbacks each). It finds no fault, which checks
  robustness, not fidelity.

### 8.6 Rerun

```
cargo build --manifest-path native/galaxy-kernel/Cargo.toml --locked --release \
  --target wasm32-unknown-unknown --target-dir .work/wasm-target
cp .work/wasm-target/wasm32-unknown-unknown/release/galaxy_kernel.wasm src/runtime/galaxy-kernel.wasm
cargo test --manifest-path native/galaxy-kernel/Cargo.toml --target-dir .work/native-target
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-galaxy-mixer.mjs [--refresh] [--sweep]
```

The oracle outputs (about 25 s to produce) are cached in
`.cache/galaxy-music/mixer` and keyed by the oracle scripts and the case
list. The host-CPU check builds `.cache/galaxy-music/mixer/hw/galaxy-mixer-hw`.

## 9. The DirectSound timer callback, translated (2026-10-16)

`0x106142a0..0x10614693` is translated in `native/galaxy-kernel/src/output.rs`
(`output_callback`) around the existing renderer (`render_ring`, §8) and checked
against the original under Unicorn by `scripts/validate-galaxy-output-callback.mjs`
(Stage 4 gate row 4.3.7, check 1, [audio-output-scope](../audio-output-scope.md) §6).

### 9.1 What the disassembly settles

Read with capstone over the hash-pinned DLL, then run under the oracle (§9.2). It
confirms §1.3 and adds:

* **Signature.** stdcall with the five dwords of a winmm `TIMECALLBACK` (`ret 0x14`),
  all unused. The first gate is the open flag `[0x10698394]` (`0x106142a3..0x106142aa`,
  return without the lock).
* **The 3D poll `0x106126f0`** walks the effect slots: for a slot with `V+0x88 ≠ 0` and
  `V+0x11 & 4`, a status query through the hardware buffer when the 3D type
  `[0x1069817a]` is 2, 3, 4 or 5 (`0x10612725..0x10612736`); with type 0 (the reference
  machine) nothing happens. `V+0x88` is also a ring voice's write position (§2.3 of the
  scope); its `0x10000` sentinel passes the first test and `V+0x11 = 8` drops it.
* **GetCurrentPosition failing** (`jne 0x10614681`) skips everything: no render, no
  head or `ahead` change, straight to LeaveCriticalSection.
* **The cursor arithmetic** (`0x106142e1..0x1061433a`): `mask = ~((dword[0x1067b6e4] &
  0xffff) − 1)` (nBlockAlign; the dword read also holds wBitsPerSample, masked off),
  `play = (play mod size) & mask`, `target = ((write mod size) + L) mod size & mask`
  with `L = hi32((nAvgBytesPerSec · Latency) · 0x10624dd3) >> 6` (the product is a
  32-bit `imul`). All divisions unsigned.
* **The re-seat** `A == B → A = play, B = target` runs at **every** callback, not only
  the first: coincident heads (an empty resync, below) are seated again.
* **`ahead` is signed**: `ahead −= min(lenA, lenB)` (`cmp; jl` signed), resync when
  `ahead ≤ 0` (`test; jg`).
* **The resync** (`0x10614387..0x10614471`): `n = (A − B) mod size`, `ahead = (B − A)
  mod size`, `render(staging, size, B, B, n, n)` (its result discarded), then
  `Lock(0, size, &p1, &b1, NULL, NULL, DSBLOCK_ENTIREBUFFER)` and a copy of **`size`
  bytes** from the staging ring's start into `p1` whatever `b1` says, then
  `Unlock(p1, b1, NULL, 0)`. The staging bytes in `[A, B)` are not rendered by it: the
  whole-buffer copy carries what was there (the open's silence at the first callback,
  stale music and effects after a `MUSICORDER` resync). The callback then **continues**
  into the normal render (`0x10614484`) unless `ahead` is 0 (`je 0x10614681`: only when
  `A == B`, which renders nothing).
* **The normal render**: `R = render(staging, size, A, B, lenA, lenB)`, then for A and
  then B `Lock(head, R, &p1, &b1, &p2, &b2, 0)`, a copy of `b1` bytes from `staging +
  head` into `p1` and of `b2` bytes from **`staging + 0`** into `p2` (the callback relies
  on DirectSound's split at the buffer's end), `Unlock(p1, b1, p2, b2)`. At the first
  callback `lenA = lenB = 0`, so R = 0 and both zero-length Locks and Unlocks are still
  issued.
* **Lock failures.** `DSERR_BUFFERLOST` (`0x88780096`) → `Restore` (`+0x50`), `Play(0, 0,
  DSBPLAY_LOOPING)` (`+0x30`), Lock again, once. Any other failure, or a second failure,
  skips that head's copy and Unlock; **the heads still advance by R**
  (`0x10614657..0x1061467b`). Unlock's and Play's results are never read.
* **No other method** of the secondary buffer is called (vtable `+0x10`, `+0x2c`, `+0x30`,
  `+0x4c`, `+0x50`; the oracle fails a case on any other entry).
* Consequence for `ahead`: after the first callback it is `size` (the resync sets it to
  D, the resync's render adds `size − D`), and each callback subtracts `min(lenA, lenB)`
  and the render adds the same (both multiples of nBlockAlign). It stays at `size`, so a
  cursor jump can never make it `≤ 0`: only the first callback, `glxControlMusic(1, n)`
  (`MUSICORDER`, `ahead = 0`) and the dead `0x1060deb0` reach the resync.

### 9.2 Evidence

`scripts/native-galaxy-output-oracle.py` extends the effects oracle (`--real-kernel`
state, the sample entries; §8.1) with the state the output open leaves:
`[0x10697cc8]` a fabricated IDirectSoundBuffer, the staging ring `[0x10697ccc]`
silenced, `[0x1064a65c]` the latency (40, the `.data` value), and `[0x10698394] = 1`
(the open's last store `0x10613aca`, which the sequencer oracle's open tail stops short
of). The callback owns A, B and `ahead` from the open tail's zeros. The fabricated
buffer's five methods are Python leaves that answer a scripted cursor pair and Lock
result and the DirectSound split of a looping buffer (the same host model as
`output.rs` `Secondary`: ENTIREBUFFER the whole buffer, a range past the end a second
region at 0, `offset ≥ size` or `bytes > size` `DSERR_INVALIDPARAM`; Wine's
`IDirectSoundBufferImpl_Lock` behaviour as recalled, **not measured**, and unable to
change the bytes for the ranges Galaxy asks for).

`node scripts/validate-galaxy-output-callback.mjs`: 17 cases, 405 callbacks, 26
resyncs, 809 Locks (21 split at the end, 11 `DSERR_BUFFERLOST`), every one bit-equal:
per callback, every call on the buffer with its arguments and results, A, B, `ahead`,
R, and digests of the secondary buffer and the staging ring (every copied byte), with
the mixer trace (M/R/K/U/T) and the end state between them, and the full secondary
buffer after each of the first 24 callbacks. Cases: the first callback (silent, and with
music and three effect voices), 80 steady callbacks with jittered cursors and write
leads, both heads wrapping with odd and out-of-range cursors (`% size`, the mask),
cursor jumps of more than one and two rings, write leads that make lenA ≠ lenB,
`DSERR_BUFFERLOST` on each Lock (once, twice, on the resync's Lock), `DSERR_INVALIDPARAM`,
GetCurrentPosition failing, `MUSICORDER 2` and `0` with Intro_Music and effect voices
playing, an underrun from a fabricated small `ahead`, coincident cursors (`target =
play`: the empty resync and the re-seat), the closed output, latencies 5, 250 and 495,
and four seeded random programs. Coverage of `0x106142a0..0x10614693`: 352 of 352
instructions. Mutants 401 (no cursor mask), 402 (the resync returns), 403 (`ahead`
tested unsigned), 404 (no BUFFERLOST retry) and 405 (re-seat only at the first
callback) are each caught.

### 9.3 Interface

* `Library::open_output(rate, latency)`: the DirectSound setup after the open's tail
  (latency clamp and store, ring size = nAvgBytesPerSec, the 1-second secondary buffer
  zeroed, the staging ring silenced, heads and `ahead` zeroed). `galaxy_host_open`
  calls it at Latency 40; `galaxy_output_open(latency)` reopens at another.
* `galaxy_output_callback(play, write)`: one callback with GetCurrentPosition answering
  the pair; 0 or the fault. `galaxy_output_secondary()` the buffer's bytes (what the
  host plays); `galaxy_output_state(i)`: 0 size, 1 A, 2 B, 3 `ahead`, 4 the last R
  (`0xffffffff` when no normal render ran), 5 callbacks.
* Validator only: `galaxy_output_staging`, `galaxy_output_position_result`,
  `galaxy_output_lock_result`, `galaxy_output_log*`.
* Faults: 0x140 a copy outside the staging ring or the buffer, 0x141 a ring size of 0
  or odd, 0x142 (reserved) a hardware 3D type.
