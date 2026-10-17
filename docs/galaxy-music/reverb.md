# R — Galaxy.dll effects reverb

Galaxy.dll SHA256 `606e71d1…`, preferred base `0x10600000`; `glxReverb` is
GALAXY.H's (0x6c bytes: Time +8, Volume +0xc, HFDamp +0x10, Direct[4]
+0x14, Delay[6] {Time, Gain} +0x34, Data +0x64, Code +0x68). Translated in
`native/galaxy-kernel/src/reverb.rs` (setter, setup, kernel) and
`src/runtime/galaxy-audio.mjs` (Update's reverb tail); evidence in §5.

## 1. Reachability

The installed `DeusEx.ini` has `UseReverb=True` (subsystem `+0x44`). With
class defaults applied, 21 zones in 16 shipped maps set `bReverbZone`: 18
of them only set the flag and share one block (for example
00_Intro.ZoneInfo1, 02_NYC_BatteryPark.ZoneInfo1 and ZoneInfo5,
03_NYC_AirfieldHeliBase.ZoneInfo1), and 04_NYC_BatteryPark.ZoneInfo0
(MasterGain 110), 06_HongKong_Storage.ZoneInfo0 (CutoffHz 8000) and
06_HongKong_WanChai_Garage.ZoneInfo0 (its own delays and gains) differ: 4
distinct blocks. 03_NYC_BrooklynBridgeStation's LevelInfo0 is one (the
level's default zone: the whole station reverbs). UNATCO Island has none. Speech and music do
not reach it: the hook processes bus B (effects; the subsystem's speech keeps
its own transport in Play), and the music-bus reverb is installed only by the
unreferenced "AE  " loader (mixer.md §3).

## 2. Update's reverb tail (`0x1060aa15..0x1060ab93`, game thread, inside the lock)

A zeroed 0x6c-byte block on the stack. When UseReverb is set and the
listener's `Region.Zone` (AActor `+0xc8`; the listener is the viewport
Actor's ViewTarget, else the Actor, `[ebp-0x40]`) has bit 0 of `+0x3bc`
(bReverbZone):

* Volume `+0xc` = `f32(FILD(MasterGain +0x3c4) · FMUL m64 1/255)`;
* HFDamp `+0x10` = `f32(FILD(clamp(CutoffHz +0x3c8, 0, 44100)))` (`jl 0`,
  `jl 0xac44`);
* for i < 6: Time = `FILD(Delay[i] +0x3cc) · 0.002f`, then `< 0.001f` (C0) →
  0.001f, else not `< 0.34f` → 0.34f; Gain = `FILD(Gain[i] +0x3d2) ·
  (1/255)f`, then 0.001f / 0.999f the same way; both stored as float32 at
  `+0x34 + 8i`, `+0x38 + 8i`.

The block is compared with the copy at `subsystem +0x88e` (`REPE CMPSD` of
0x1b dwords; Init clears it at `0x10605f54`). When it differs it is copied
there and passed to glxSetSampleReverb (`0x1060ab8e`); a nonzero result logs
"glxSetSampleReverb(&Reverb) failed: %i". Leaving a reverb zone therefore
hands over a zero block once. Then (`+0x78`, 3D hardware) the EAX listener
commit, and the lock is released.

## 3. glxSetSampleReverb `0x106113d0` and the setup `0x106109f0`

**Setter**, under the lock: a NULL block, or Volume equal to 0.0 (FCOMP C3:
also unordered), clears the hook `[0x10688288]`, frees the context
`[0x10688284]` (MSVCRT free) and returns 0 (the EAX branch is output type
3/5 only). Otherwise `block.Data = context`, the block is copied to the
library's `glxSampleReverb` (`0x10688220`), and with MMX and SSE the hook
becomes `0x10622d33` and the context is `realloc(context, 0x60188)` (or
malloc) before the SSE setup runs on it (3DNow `0x106220e7`/`0x106101b0`,
MMX `0x1062135b`/`0x1060f660`, none without MMX). The setup's result is not
checked: a block it refuses leaves the context as it was (uninitialised on a
fresh malloc); Update never builds one.

**Setup** (x87, the game thread's control word): returns 0x11 for Volume
below -1.0f or above 1.0f, or HFDamp above the rate. Otherwise:

* the whole context zeroed (`REP STOSD` 0x18062 dwords: every reverb change
  restarts the delay lines); `+0xc0`, `+0xc4` = 1.0f; `+0xb8`, `+0xbc` =
  Volume (the output gain of both lanes);
* the low-pass coefficient: `x = HFDamp · 6.282f / (int)rate` (FLD m32,
  FMUL m32 `0x1063ed04`, FIDIV), `a = 1.0 − FCOS(x)` (FSUBR m64), `k =
  f32(FSQRT((a + 2.0f) · a) − a)`, and `1 − k` (FLD 1.0f, FSUB m32 k);
* for each delay i: `g = 1.0f − Gain` (0.999f when it equals 1.0), the tap
  `ctx+0x08+4i = −_ftol(rate · Time)` (Time 0.0 → 0.001f), `ctx+0x20+4i =
  f32(−g)`, `+0x38+4i = f32(g)`, `+0x50+4i = f32(1.0f − g·g)`, `+0x68+4i = k`,
  `+0x80+4i = 1 − k`;
* a loop over the six delays computes `glxSampleReverb.Time` (+8) with
  FYL2X (`0x10610e2a..0x10610e8b`); then for output type 0 the setup
  returns 0 (`0x10610e8d..0x10610e98`, `0x10611216`). Everything after is
  the EAX property set (FYL2X, FCOS, FSQRT, `_CIpow`). Only the EAX branch
  reads `Time`, so the translation does not compute it.

## 4. The SSE kernel `0x10622d33(ctx, dry, send, count, 0)`

Called by the renderer after each mixer call of k > 0 frames on (d04, d0c)
(mixer.md §1.3; between the mix and the conversions). Two lanes (left,
right) in xmm registers, float32 under MXCSR 0x1f80. Per frame:

```
x0 = swap(x0); x0 = (x0 + send[f]) · 0.5                 ; shufps 1, addps, mulps [0x1064d300]
for line l in 0..3 (delays 2l, 2l+1; lines at ctx+0xc8, +0x200c8, +0x40108):
  x1 = x0; x0 = x0 · (−g)
  y  = (line[(tap + pos) & 0x3fff] (lane-wise taps), ) ; movss/unpcklps
  s_l = y · k + s_l · (1 − k)                            ; the low-pass state, ctx+0x98/0xa0/0xa8
  line[pos] = x1 + s_l · g
  x0 = x0 + y · (1 − g²)
dry[f] += x0 · Volume; pos = (pos + 1) & 0x3fff          ; ctx+4
```

`x0` (ctx+0xb0) feeds back, swapped, into the next frame. The kernel reads
`[0x1064d300]` and counts in `[0x1064d328]`; it has no x87.

## 5. Verification

* **Update's tail** (`validate-galaxy-music-update.mjs`, the original Update
  under Unicorn, `native-galaxy-audio-oracle.py --music`, glxSetSampleReverb
  a recording leaf): 13 reverb cases × the control words 0x037f/0x027f/0x007f
  (entering, changing, leaving zones, UseReverb 0, bit-field values, clamp
  edges of every field, 60 random zones, nonzero results and the log line):
  246 setter calls with every byte of their blocks, the cache compare, and
  coverage 112/112 of the tail.
* **Setup and FCOS on real x87** (`validate-galaxy-reverb.mjs`,
  `native-galaxy-reverb-hw.c` maps Galaxy.dll at its base and runs the
  original setup natively; this Linux host's AMD x87):
  * every input the subsystem can produce (CutoffHz 0..44100 at 44100 Hz):
    the FCOS input equal; FCOS itself differs from the correctly rounded
    cosine at 5820 inputs (by at most 2^-64 absolute); the stored k and
    1 − k equal at all 44,101. The model is the correctly rounded cosine
    (a 100-bit fixed-point Taylor sum): exact for the setup's output, not
    for FCOS.
  * 414 whole parameter blocks equal (the 4 distinct shipped blocks, 400
    random Update blocks, 10 refused and edge blocks).
  * Control words: under 0x027f k and every block equal 0x037f's; under
    0x007f, 30,050 cutoffs and 398 blocks differ. Play uses 0x037f (the
    project's open FPUSETUP question).
* **Kernel on the host SSE unit**: 264 native calls (65,739 frames, the
  delay lines wrapping, denormal and zero tails) on 6 contexts: every dry
  output and context header, and the whole 0x60188-byte contexts, equal.
* **The same steps on the Mac (2026-10-17), through Rosetta 2, not x87
  hardware.** `native-galaxy-reverb-hw.c` also builds as a Windows executable
  (`i686-w64-mingw32-gcc`; `VirtualAlloc` maps Galaxy.dll at `0x10600000` in
  place of `mmap`) and `validate-galaxy-reverb.mjs` runs it under CrossOver's
  Wine (bottle DeusEx) when `gcc -m32` is not available. On Apple silicon the
  x87 and SSE instructions then run as Rosetta 2 translates them: a software
  implementation of the x87, not the unit the original ran on. Results:
  the FCOS input equal at every cutoff; k and 1 − k equal at all 44,101;
  414/414 parameter blocks equal; under 0x027f nothing differs from 0x037f,
  under 0x007f 30,050 cutoffs and 398 blocks do (the Linux counts); the
  kernel's 264 calls (65,739 frames) and 6 whole contexts equal. Rosetta's
  FCOS itself is off the correctly rounded cosine at 6,989 inputs (AMD's at
  5,820), by at most 2^-64 absolute as on AMD (status words 0x3800, 0x3820,
  0x3a20): another implementation's last-bit pattern, which no stored
  coefficient sees. The Linux path is unchanged (`mmap`, `aligned_alloc`);
  it was not rerun, the host being out of reach.
* **Setter and renderer under Unicorn** (`validate-galaxy-effects.mjs`,
  the oracle's FCOS replaced by the model's value for its input): 4
  programs with 13 reverb changes (install, change, Volume 0 free, reinstall,
  random zones), voices and music: every setter result, hook and context
  header, the mixer trace and both buses' PCM per callback (two heads), and
  the browser path; kernel coverage 117/117; mutants 305 (no cross-feed)
  and 306 (low-pass weights swapped) caught.

## 6. Open

* The game thread's x87 control word (0x037f assumed; 0x007f would change
  the coefficients and taps, §5).
* `glxSampleReverb.Time` (EAX-only) is not computed.
* Intel x87 FCOS is not measured (AMD on the Linux host; Rosetta 2's
  software x87 on the Mac, whose different last-bit pattern leaves k and
  1 − k unchanged at every input); a third pattern would still have to.
