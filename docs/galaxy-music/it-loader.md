# B: Galaxy module loader, Impulse Tracker branch

Research note (topic B). Source of truth: the hash-pinned GOTY `System/Galaxy.dll`
(preferred base `0x10600000`). Every claim cites the instruction address that
establishes it. Struct and global names come from `GALAXY.H` in the DX SDK
(`Reference/DeusExSDK1112f/.../DxHeaders/Galaxy/Hdr/GALAXY.H`, Galaxy rev 5.00b,
29-09-1999). Each name is marked either **(binary-confirmed)**, when the binary's
offsets, strides or FourCCs match the header layout independently, or
**(header candidate)**, when it is only the most plausible header name for an
address. The binary log string `glxLoadMusic(&Mem, GLX_LOADFROMMEMORY )`
(UTF-16 at `0x1064a3ec`, used at `0x1060a791`) confirms the name of the
dispatcher.

There is no x87 or SSE code anywhere in this path (dispatcher
`0x10618be0`-`0x10618e59`, IT loader `0x10628990`-`0x1062a384`, sample loader
`0x1062fb10`-`0x1062fe1e`): it is all integer arithmetic.

## 1. Entry point and call chain

| VA | Role | Evidence |
| --- | --- | --- |
| `0x10618be0` | `int glxLoadMusic(void *Stream, int Flags)` (cdecl): format detector and dispatcher | its only caller is `0x1060a77e`, followed by the log string above |
| `0x10628990` | IT loader, `int (void *Stream)` (cdecl) | only caller `0x10618d1b`, after the `'IMPM'` match |
| `0x1062fb10` | shared sample-data loader, `int (glxSample *s, void *Stream)` | 14 callers, one per module format; IT calls it at `0x106295c4` and `0x1062993e` |
| `0x1060e850` | music state reset before a load (named from its behaviour: returns 2 when `0x10698349` is set, otherwise resets voices and song scalars inside `EnterCriticalSection`/`LeaveCriticalSection`, IAT `0x10699a40`/`0x10699a1c`) | only call at `0x10618c12` |
| `0x10619450` | `glxUnloadMusic`: frees patterns and instruments, clears `0x10698348` | only caller `0x10606f0c`, inside `UGalaxyAudioSubsystem::UnregisterMusic` (strings `glxUnloadMusic()` at `0x10606f1d`/`0x10606f54`) |

**The caller** (`0x1060a741`-`0x1060a7a7`, inside the subsystem Update music
code; agent A owns it) builds a `glxMemory` **(binary-confirmed)** on the stack:

| Offset | Value | Field |
| --- | --- | --- |
| `+0x00` | `0x4f4d454d` (`'MEMO'`) | `FourCC` |
| `+0x04` | `0xc` | `Size` |
| `+0x08` | `UMusic+0x34` (`Data.Data`) | `Data` |
| `+0x0c` | `UMusic+0x38` (`Data.Num`) | `Length` |
| `+0x10` | `0` | `DataPos` |

It calls `glxLoadMusic(&Mem, 2)` (2 = `GLX_LOADFROMMEMORY`). Just before
that, at `0x1060a702`-`0x1060a735`, the caller runs an inlined
`FArray::Add(0x400, 1)` on `Data`: `Num += 0x400`, and when Num exceeds Max,
`Max = Num + 3*Num/8 + 32` and `FArray::Realloc` (IAT `0x10699854`) is called.
So the stream `Length` is the module size **plus 1024 uninitialised bytes**.
A nonzero return is logged through `GLog->Logf` (IAT `0x1069986c` /
`0x10699868`) as `"%s failed: %i"` (`0x106497ec`). Whatever the result,
`UMusic+0x48` is then set to `-1` (`0x1060a7b5`). After that, slot `+4` of
the vtable at `UMusic+0x28` is called (`0x1060a7c8`); this is likely
`TLazyArray::Unload`, and slot `+0` at `0x1060a700` is likely `Load`. Both
are inferred, not confirmed, and are agent A's boundary, as are the handle
semantics.

**Return values** (numbering from GALAXY.H `GLXERR_*`):

| Code | Meaning | Where |
| --- | --- | --- |
| 0 | ok | `0x1062a37d` |
| 1 | music already loaded (`0x10698348` != 0) | `0x10618bfc` |
| 2 | music playing (`0x1060e850` found `0x10698349` != 0) | `0x1060e970` |
| 9 | out of memory | `0x106289af`, `0x10628cb8`, `0x1062926e`, `0x10629667` |
| 0xa | out of pattern memory | `0x10629adf` |
| 0xb | out of sample memory | `0x1062fb87` |
| 0x10 | damaged file (short sample read) | `0x1062fbab` |
| 0x11 | null stream | `0x10618bf2` |

The module is not returned as a handle. The loader fills Galaxy's **global**
song state (section 6); only one song exists at a time.

## 2. Stream I/O and memory interfaces

**I/O vector** `0x1064a744` seek, `0x1064a748` read, `0x1064a74c` write,
`0x1064a750` tell. `glxLoadMusic` rewrites it on every call (`0x10618c24`-`0x10618c78`):

- Flags bit 0 selects the stdio wrappers `0x10618970` / `990` / `9b0` / `9d0`
  (MSVCRT `fseek` / `fread` / `fwrite` / `ftell` through the thunks
  `0x106303c0` / `c6` / `cc` / `d2`).
- Flags bit 1 selects the memory stream `0x10618aa0` / `0x10618b10` /
  `0x10618b70` / `0x10618bd0`. Bit 1 is tested second, so it wins when both
  bits are set.

**Memory stream semantics** (it reads `glxMemory` +8 Data, +0xc Length,
+0x10 DataPos):

- **seek** `(h, off, whence)` `0x10618aa0`:
  - whence 0: `pos = off`.
  - whence 1: `pos += off`.
  - whence 2: `pos = Length + off`.
  - In each case, an unsigned `pos > Length` clamps to `Length`.
  - Returns 0, or 1 for an unknown whence.
- **read** `(dst, size, count, h)` `0x10618b10`, fread semantics: when
  `Length - pos < size*count`, it sets `count = (Length - pos)/size`
  (unsigned `div`). It copies `size*count` bytes, advances pos and returns
  count. A read past the end is short and leaves the destination untouched.
- **tell** `0x10618bd0` returns `DataPos`.

**Memory interface** `0x1064a738` malloc, `0x1064a73c` realloc, `0x1064a740`
free:

- Their static initial values are `0x10618930` / `0x10618940` / `0x10618960`.
  These call MSVCRT `malloc` / `realloc` / `free` through the thunks
  `0x10630248` / `0x1063025a` / `0x10630242`, which resolve to IAT entries
  `0x10699ab0` / `0x10699a9c` / `0x10699ab4`.
- The setter `glxSetMemInterface` (`0x10619750`; it writes
  `0x1064a738`-`0x1064a740` at `0x10619756`-`0x1061978b`) has **no caller**:
  no rel32 call or jmp, and no absolute reference anywhere in the image.
- The UE wrappers `galaxyMalloc` `0x10604020` and `galaxyRealloc`
  `0x106040c0` (both go through `GMalloc`, IAT `0x106996b4`, tags
  "Galaxy malloc" / "Galaxy realloc") are reached only through thunks
  `0x10601091` / `0x1060105f`. Those thunks are referenced nowhere in the
  file.
- **So every loader allocation is MSVCRT heap, not Core `appMalloc`.**

## 3. `glxLoadMusic` (`0x10618be0`): detection order

1. A null Stream returns `0x11` (`0x10618bed`).
2. A nonzero byte `0x10698348` returns 1 (`0x10618bfc`).
3. Calls `0x1060e850` (reset, section 6.3). A result of 2 is returned
   (`0x10618c17`).
4. Sets the I/O vector from Flags (section 2).
5. Reads `0x30` bytes into a local buffer `B` (`0x10618c8c`), then seeks
   `-0x30` with whence 1 (`0x10618c97`). The stream is back at its entry
   position.
6. Compares, in this order:

| Test | Format | Loader |
| --- | --- | --- |
| dword `B[0]` == `'MThd'` (`0x1064a7cc`) | MIDI | `0x1062b130` |
| 3 bytes `B[0]` == `"MTM"` (`0x1064a7c8`) | MTM | `0x1062aa90` |
| dword `B[0]` == `'FAR\xfe'` (`0x1064a7c0`) | FAR | `0x1062a510` |
| dword `B[0]` == `'IMPM'` (`0x1064a7b8`, `0x10618d0d`) | **IT** | **`0x10628990(Stream)`** |
| dword `B[8]` == `'AM  '` (`0x1064a7b0`) | RIFF AM | `0x10628000(Stream, Flags)` |
| dword `B[0x2c]` == `'SCRM'` (`0x1064a7a8`) | S3M | `0x10627490` |
| dword `B[0x2c]` == `'PTMF'` (`0x1064a7a0`) | PTM | `0x10626ca0` |
| 14 bytes `"MAS_UTrack_V00"` (`0x1064a790`) | ULT | `0x106263d0` |
| 17 bytes `"Extended Module: "` (`0x1064a77c`) | XM | `0x10625940` |
| word `'if'` / `'JN'` (`0x1064a778` / `0x1064a774`) | 669 | `0x106247b0` |
| 8 bytes `B[0x14]` == `"!Scream!"` / `"BMOD2STM"` | STM | `0x10624d10` |
| otherwise | MOD (checks `'M.K.'` at `0x106253cc`) | `0x106252f0` |

The IT loader's return value is returned unchanged. `cwt`/`cmwt` are never
examined, here or in the IT loader.

## 4. IT loader (`0x10628990`): parse order

The function is a frame-pointer, unoptimised body with locals at `[ebp-x]`.
`S` = Stream; `base` = `tell(S)` at entry (`0x10628a1d`, `[ebp-0x34]`; 0 for
the memory stream). Every file offset is sought with whence 0 as
`base + offset`.

### 4.1 Scratch buffers (malloc, freed only on success at `0x1062a349`-`0x1062a374`)

| Local | Size | Holds |
| --- | --- | --- |
| `[ebp-0x2c]` | `0xc0` (`0x10628998`) | IT header (bytes `0x00`-`0xbf`) |
| `[ebp-0x18]` | `0x226` (`0x106289b9`) | IMPI, read through the end of the pitch envelope |
| `[ebp-0x40]` | `0x50` (`0x106289da`) | IMPS header |
| `[ebp-0x58]` | `0xe008` (`0x106289f8`) | 8-byte pattern header plus up to `0xe000` packed bytes |

A failed allocation returns 9. Every error return jumps straight to
`0x1062a37f` and **leaks** whatever was already allocated, including partial
song state.

### 4.2 Header

| Step | IT offset | Action | Address |
| --- | --- | --- | --- |
| read | `0x00` | `read(hdr, 1, 0xc0)` | `0x10628a38` |
| songname | `+0x04` | memcpy 26 bytes to `0x106981e0` | `0x10628a4f` |
| clear | | memset `0x106845a8`, `0x400` (pattern offset table, 256 dwords) | `0x10628a63` |
| GV | `+0x30` | byte to `0x10697cf0`, then `movsx` / `cmp 0x7f` / `jle` clamp. **The clamp is ineffective for 128..255** (they sign-extend negative), so GV=128, which every DX song has, is stored as `0x80`. | `0x10628a6e`-`0x10628a83` |
| IS | `+0x32` | zero-extended to word `0x10697cea` | `0x10628a8d` |
| IT (tempo) | `+0x33` | zero-extended to word `0x1069817e` | `0x10628a9c` |
| OrdNum | `+0x20` | `n = min(OrdNum, 0xff)`, byte to `0x1069834a` | `0x10628aad`-`0x10628ad0` |
| orders | `0xc0` | `read(0x10698220, 1, n)`, then `seek(OrdNum - n, whence 1)` | `0x10628ae9`, `0x10628b0c` |
| ins offsets | | `read(0x10684268, 4, InsNum(+0x22))` | `0x10628b2a` |
| smp offsets | | `read(0x10684a28, 4, SmpNum(+0x24))` | `0x10628b48` |
| pat offsets | | `read(0x106845a8, 4, PatNum(+0x26))`. Entries `>= PatNum` stay 0. | `0x10628b66` |
| channel pan | `+0x40+i`, i<32 | `v <= 0x40`: `min(2v, 0x7f)`; else `0xa0` (covers 100 = surround and every disabled channel, >= 128); to `0x106886c0[i]`. Only 32 channels. | `0x10628b6f`-`0x10628bd3` |
| song length | | `i` = first index with `orders[i] == 0xff` (scans the 256-byte table, up to `i == 0x100`). If `i < n`, `n = i`. Then `n -= 1` (byte; an `0xff` at index 0 wraps to 0xff). Stored at `0x1069834a`, "length of song, base zero". | `0x10628bd5`-`0x10628c20` |
| mode | `+0x2c` bit 2 | set: instrument path at `0x10628c3a`; clear: sample path at `0x106295ec` | `0x10628c26` |

**Header fields never read:** `+0x1e` PHiligt, `+0x28` Cwt, `+0x2a` Cmwt,
`+0x2c` bits other than 2 and 3, `+0x2e` Special, `+0x31` MV, `+0x34` Sep,
`+0x35` PWD, message, `+0x80` channel volumes. I confirmed this by
enumerating every `[hdr + off]` access in `0x10628990`-`0x1062a384`.

### 4.3 Sample mode (flags bit 2 clear). This is the path for 34 of the 35 DX songs.

For `i` in `0 .. SmpNum-1` (`0x106295ec`):

1. `seek(base + smpoff[i])`, then `read(smp, 1, 0x50)` (`0x10629624`, `0x10629639`).
2. `ins = malloc(0x192)` (that is `0x14a + 0x48`, one sample) goes to
   `glxInstruments[0][i]` at `0x106882a0 + 4i`. Null returns 9.
3. memset `ins`, `0x14a` (header only); `+0x00 = 'INST'`;
   `+0x04 = 0x142`, which is **not** updated for the sample;
   `+0x09` (Program) `= i`; memcpy 26 bytes of IMPS name `+0x14` to
   `ins+0x0a` (`0x10629671`-`0x106296d3`).
4. `memcmp(smp, 'IMPS' at 0x1064e74c, 4)`. On a mismatch it skips to the
   next i. The instrument stays with `Samples=0` and **uninitialised** bytes
   `0x14a`-`0x191` (`0x106296f0`).
5. memset the sample (`ins+0x14a`, `0x48`); `ins+0x148` (Samples) `= 1`;
   memset `ins+0x2a` (Split, `0x80`). Every key therefore maps to sample 0.
   memcpy 26 bytes of the name to sample `+0x08` (`ins+0x152`).
6. Sample fields: the common IMPS conversion in section 4.4 (`0x10629764`-`0x1062990b`).
7. `seek(base + IMPS+0x48)`, then `0x1062fb10(sample, S)`. A nonzero
   result is returned. The call happens **even when Length is 0**; the
   callee returns at once.

### 4.4 IMPS to `glxSample` conversion (both modes)

`s` is the `glxSample` at `ins + 0x14a + n*0x48` (binary-confirmed layout,
section 6.2).

| `glxSample` field | Value | Address (sample mode / instrument mode) |
| --- | --- | --- |
| `+0x30` Length | IMPS `+0x30` dword (frames) | `0x10629771` / `0x10629387` |
| `+0x34` LoopStart | IMPS `+0x34` | `0x10629787` / `0x106293a4` |
| `+0x38` LoopEnd | IMPS `+0x38` | `0x1062979d` / `0x106293c1` |
| `+0x2a` Volume | `IMPS+0x13 (Vol) << 9`, word, then a re-read word `> 0x7fff` becomes `0x7fff` (64 gives `0x7fff`) | `0x106297a6` / `0x106293cb` |
| `+0x2c` Type | `0x80` \| `(Flg & 0x02) << 1` (4 = 16-bit) \| `(Flg & 0x10) >> 1` (8 = loop) \| `(Flg & 0x40) >> 2` (0x10 = ping-pong) \| `(DfP & 0x80) >> 2` (0x20 = use default pan) \| `((Cvt & 1) ^ 1) << 1` (2 = unsigned) | `0x106297f0`-`0x10629894` / `0x1062942a`-`0x106294ee` |
| `+0x28` Panning | `(IMPS+0x2f DfP & 0x7f) << 9`, clamp `0x7fff` | `0x1062989b` / `0x106294f6` |
| `+0x2e` Reserved | 0 | `0x106298f2` / `0x10629568` |
| `+0x3c` C4Speed | IMPS `+0x3c` (C5Speed) raw | `0x10629908` / `0x10629585` |
| `+0x40` Articulation | 0 (memset) | |
| `+0x08` Message | 26 bytes (sample mode) or **22 bytes** (instrument mode, `push 0x16` at `0x1062933e`) of IMPS `+0x14` | |

Type bit names from GALAXY.H: 1 DELTA, 2 UNSIGNED, 4 16BITSAMPLE, 8 LOOPED,
0x10 BIDILOOP, 0x20 PANNING, 0x40 STEREOSAMPLE, 0x80 ALWAYSLOOP. The binary
confirms the semantics of 1, 2, 4, 8, 0x10 and 0x40 (section 5). 0x80 is
set unconditionally; its effect is unresolved.

**IMPS fields never read:** `+0x10` (0), `+0x11` GvL, Flg bit 0 (sample
present), bit 2 (stereo), bit 3 (compressed), bit 5 (sustain loop), bit 7
(sustain ping-pong), Cvt bits 1-7, `+0x40`/`+0x44` sustain points,
`+0x4c`-`+0x4f` vibrato. The IMPS signature is checked **only in sample
mode**.

### 4.5 Instrument mode (flags bit 2 set; only Lebedev_Music, cmwt 0x200)

For `i` in `0 .. InsNum-1` (`0x10628c3a`):

1. `seek(base + insoff[i])`, then `read(ib, 1, 0x226)` (`0x10628c72`, `0x10628c8a`).
2. `ins = malloc(0x14a)` goes to `glxInstruments[0][i]`. Null returns 9.
   memset `0x14a`; `'INST'`; `Size 0x142`; Program `= i`; memcpy 26 bytes
   of IMPI `+0x20` (name) to `ins+0x0a`. This happens **before** the
   signature test.
3. `memcmp(ib, 'IMPI' at 0x1064e744, 4)`. A mismatch skips to the next i.
   The instrument stays allocated with `Samples=0` (`0x10628d41`).
4. **Key map** (`0x10628d47`-`0x10628df9`):
   - `ib[0x1e]` (NoS) is reused as a counter, `= 0`.
   - memset `remap` at `0x106844a8`, `0x100`.
   - For `k < 120`: `s = ib[0x41 + 2k]`, the sample byte. **The note byte
     `ib[0x40+2k]` is ignored**, so there is no key transposition. When
     `s != 0`: if `remap[s-1] == 0`, then `remap[s-1] = ++ib[0x1e]`. Then
     `ins+0x2a+k` (Split) `= remap[s-1] - 1`.
   - Keys with `s == 0` keep Split 0, which plays the instrument's first
     sample. Split[120..127] stay 0.
5. **Envelopes.** Only nodes 0-9 are copied, whatever Num says. IT node
   = (y byte, tick word).

| Envelope | Galaxy fields (in `ins`) | Source |
| --- | --- | --- |
| Volume nodes | `+0xbe+4j` Time = tick word `ib[0x137+3j]`; `+0xc0+4j` Value = `ib[0x136+3j] << 9` (unsigned), clamp `0x7fff` | `0x10628dfe`-`0x10628e8d` |
| Volume fade | `+0xe6` = `IMPI+0x14 << 5`, the re-read word clamped to `0x7fff` | `0x10628e92`-`0x10628ed4` |
| Pitch nodes | `+0xee+4j` Time = `ib[0x1db+3j]`; `+0xf0+4j` = `(sbyte)ib[0x1da+3j] << 7`, clamp only if `> 0x7fff` (never) | `0x10628edd`-`0x10628f6b` |
| Pan nodes | `+0x11e+4j` Time = `ib[0x189+3j]`; `+0x120+4j` = `(sbyte)ib[0x188+3j] << 10`, clamp `0x7fff` (+32 gives `0x7fff`, -32 gives `0x8000`) | `0x10628f70`-`0x10628ffe` |
| VolFlag `+0xb8` | `f = ib[0x130]`: `(f&1) \| ((f&2)<<1) \| ((f&4)>>1)`. IT loop bit becomes 4, IT sustain bit becomes 2. | `0x10629003` |
| VolSize `+0xba` / VolSustain `+0xbb` / VolLS `+0xbc` / VolLE `+0xbd` | `ib[0x131]&0xf` / `ib[0x134]&0xf` (**SLB**) / `ib[0x132]&0xf` / `ib[0x133]&0xf` | `0x10629045`-`0x106290b7` |
| PitFlag `+0xe8` | `(ib[0x1d4]&1) \| ((ib[0x1d4]&2)<<1) \| ((ib[0x182]&4)>>1)`. **The sustain bit is taken from the pan envelope flags** (`0x106290e2`). | `0x106290bd`-`0x106290f9` |
| PitSize `+0xea` / PitSustain `+0xeb` / PitLS `+0xec` / PitLE `+0xed` | `ib[0x1d5]` / `ib[0x1d9]` (**SLE**) / `ib[0x1d6]` / `ib[0x1d7]`, each `&0xf` | `0x106290ff`-`0x10629171` |
| PanFlag `+0x118` | same transform as VolFlag, applied to `ib[0x182]` | `0x10629177`-`0x106291b3` |
| PanSize `+0x11a` / PanSustain `+0x11b` / PanLS `+0x11c` / PanLE `+0x11d` | `ib[0x183]` / `ib[0x187]` (**SLE**) / `ib[0x184]` / `ib[0x185]`, each `&0xf` | `0x106291b9`-`0x1062922b` |

   The Articulation vibrato and tremolo fields (`+0xaa`-`+0xb7`),
   PitFadeOut (`+0x116`) and PanFadeOut (`+0x146`) stay 0 from the memset.
6. `ins = realloc(ins, 0x14a + NoS*0x48)` (`0x1062924e`). Null returns 9.
7. For `n < NoS` (`0x10629278`):
   - `j` = the smallest index with `remap[j] == n+1`, an unbounded scan.
   - `seek(base + smpoff[j])`, then `read(smp, 1, 0x50)`. **No `'IMPS'` check.**
   - memset the sample, `0x48`; `ins+0x148` (Samples) `+= 1`; memcpy
     **22 bytes** of the name to sample `+0x08`.
   - **If IMPS Length (`+0x30`) == 0, skip** (`0x1062936e`). The sample
     stays zero apart from its name: FourCC 0, Data NULL.
   - Otherwise apply section 4.4, `seek(base + IMPS+0x48)`, then
     `0x1062fb10(s, S)`.
   - A sample shared by several instruments is loaded once per instrument.
     IT samples referenced by no key are never loaded.

**IMPI fields never read:** NNA `0x11`, DCT `0x12`, DCA `0x13`, PPS/PPC
`0x16`/`0x17`, GbV `0x18`, DfP `0x19`, RV/RP `0x1a`/`0x1b`, TrkVers, IFC/IFR
`0x3a`/`0x3b`, MIDI fields, SLE of the volume envelope (`0x135`), SLB of the
pitch and pan envelopes, nodes 10-24, the filter bit of the pitch envelope,
and cmwt (the new IMPI layout is always assumed).

### 4.6 Patterns: unpacked into Galaxy's own event stream at load

The pattern data is **re-encoded at load**, not kept packed (`0x1062995c`-`0x1062a30a`).

**Converter state** is six per-channel `[64]` byte arrays. They are zeroed
**once per load** (`0x1062995c`-`0x106299bf`), **not per pattern**:

| Array | VA |
| --- | --- |
| `lastmask` | `0x10684228` |
| `lastnote` | `0x106849e8` |
| `lastins` | `0x106841e8` |
| `lastvol` | `0x10684468` |
| `lastcmd` | `0x106849a8` |
| `lastcmdval` | `0x106841a8` |

**Order of conversion.** For `o = 0 .. songlen` (the inclusive base-zero
length, `0x106299c2`):

- `p = orders[o]`. Skip `p >= 0xfe`, or `glxPatterns[p]` (`0x10697d40+4p`)
  already set, or `patoff[p] == 0` (`0x106299f6`-`0x10629a1f`).
- So each pattern is converted once, at its **first appearance in the order
  list**, and the converter state flows across patterns in that sequence.
- Patterns referenced by no order, empty IT patterns (offset 0) and
  orders `>= PatNum` **are never allocated**; their `glxPatterns[p]` stays
  NULL.

**Per pattern:**

1. `P = malloc(0x28)`, **not null-checked**, goes to `glxPatterns[p]`;
   memset `0x28`.
2. Header (`0x10629a64`-`0x10629aa7`): `P+0x00 = 'PATT'`, `P+0x04 = 0x1e`
   (sic; the struct is 0x28), `P+0x08` Tracks `= 1`, `P+0x0c = 'TRAK'`,
   `P+0x10 = 0x14`.
3. `ev = malloc(0xc101)` goes to `P+0x24` (Track[0].Events). Null returns
   `0xa` (`0x10629adf`). The size is `1 + 256*(1 + 32*6)`: 256 rows, each
   holding 32 maximal 6-byte events and a terminator.
4. `seek(base + patoff[p])`, then `read(buf, 1, 8)`, then
   `read(buf+8, 1, Length = word buf[0])`. There is no bound against
   `0xe000`; the DX maximum is 2989.
5. Write `*ev++ = Rows(word buf[2]) - 1`, keep `rowsLeft = Rows - 1`
   (`0x10629b37`-`0x10629b51`).
6. **Row loop.** While `*cur != 0`, process one channel entry. A 0 byte ends
   the row: `cur++`, `*ev++ = 0`, loop while `rowsLeft-- != 0`. Exactly
   `Rows` rows are consumed and nothing checks the packed length
   (`0x1062a2a9`-`0x1062a2cf`).
7. `P+0x24 = realloc(ev0, ev - ev0)`; the result is not null-checked
   (`0x1062a2f4`).

**Channel entry** (`0x10629b66`-`0x1062a2a4`):

- Defaults: `note = ins = cmd = val = 0`, `vol = 0xff` (meaning "none").
- `cv = *cur++`; `ch = (cv - 1) & 0x3f`.
- `mask = (cv & 0x80) ? *cur++ : lastmask[ch]`; `lastmask[ch] = mask`.
- mask `0x01`: `note = *cur++`.
  - If `note < 0x78`: `note += 1`.
  - If `note == 0xfe` (cut): `note = 0`, **`vol = 0`**.
  - If `note == 0xff` (off): `note = 0x80`.
  - `0x78`..`0xfd` pass through raw.
  - `lastnote[ch] = note` (the transformed value).
- mask `0x02`: `ins = *cur++`; `lastins[ch] = ins`. The raw IT number,
  1-based.
- mask `0x04`: `v = *cur++`. If `v <= 0x40`: `v = min((byte)(v<<1), 0x7f)`
  and `vol &= v`. Whatever the branch, `lastvol[ch] = v`. **Raw volume
  column values above `0x40` are not emitted.**
- mask `0x08`: `cmd = *cur++`; `lastcmd[ch] = cmd`; `val = *cur++`. If
  `cmd` is not A/D/E/F/K/L (1, 4, 5, 6, 0xb, 0xc), `lastcmdval[ch] = val`
  (`0x10629d18`-`0x10629d63`).
- mask `0x10`: `note = lastnote[ch]`. mask `0x20`: `ins = lastins[ch]`.
- mask `0x40`: `v = lastvol[ch]`; if `v <= 0x7f`, `vol &= v`. Raw stored
  values `0x41`-`0x7f` **would** be emitted here.
- mask `0x80`: `cmd = lastcmd[ch]`, `val = lastcmdval[ch]`.
- Effect translation (section 7) through the jump table `0x1062a385`.

**Emitted event, byte-exact** (`0x1062a18a`-`0x1062a29e`):

```
event  := head [val cmd]? [ins note]? [vol]?
head   := ch (bits 0-4) | 0x80 if (cmd|val)!=0 | 0x40 if (note|ins)!=0 | 0x20 if vol!=0xff
pattern:= (Rows-1) { event* 0x00 } x Rows
```

The fields always come in that order: effect pair, then instrument/note
pair, then volume. If `head & 0xe0 == 0`, or `ch >= 0x20`, the event is
**discarded** (`ev` rewound to `head`, `0x1062a29e`). Otherwise
`0x10698348 = max(0x10698348, ch)` (`0x1062a26e`-`0x1062a296`). A kept
`head` is never 0, so it cannot collide with the row terminator.

### 4.7 Finalisation (`0x1062a30f`-`0x1062a37d`)

- `0x10697ce8 = (((flags & 8) >> 3) ^ 1) | 2`: 2 for linear slides (flags
  0x09/0x0d), 3 for Amiga slides (Endgame1/2, flags 0x13). Flags bits 0, 1,
  4 and 5 (stereo, vol0mix, old effects, compat Gxx) are ignored.
- `0x10698348 += 1`: the channel count, highest kept channel + 1, at least 1.
- `0x106886a6 = 0x1c5`; `0x10698180 = 0xff00`.
- free the four scratch buffers; return 0.

## 5. Sample data loader (`0x1062fb10`), shared by all formats

The argument `s` is a `glxSample`; `bps = (Type & 4) ? 2 : 1` (`0x1062fb1a`-`0x1062fb2c`).

1. If `!(Type & 8)`: `Type &= 0xe7`, which also clears the high byte (`0x1062fb30`).
2. Unsigned word `Volume > 0x7fff` becomes `0x7fff` (`0x1062fb39`).
3. `LoopEnd > Length` (unsigned) becomes `LoopEnd = Length` (`0x1062fb48`).
   `LoopEnd == LoopStart` gives `Type &= 0xe7` (`0x1062fb55`).
   `LoopStart > LoopEnd` is not checked.
4. `Length == 0` returns 0. Data stays NULL, FourCC and Size stay 0 (`0x1062fb65`).
5. `Data(+0x44) = malloc((Length + 0x1f) * bps)`. Null returns `0xb`.
   `read(Data, bps, Length)`; a count other than Length returns `0x10`
   (`0x1062fb6d`-`0x1062fbb0`).
6. `+0x00 = 'SAMP'` (`0x504d4153`), `+0x04 = 0x40` (`0x1062fbb6`).
7. If `Type & 0x43`, convert (`0x1062fbc6`-`0x1062fd00`):
   - Stereo (`0x40`) without `Reserved & 0x80`: de-interleave into halves.
   - Per frame, delta (bit 1): word delta when `Type & 0x20`, otherwise a
     byte-wise delta, including both bytes of 16-bit samples.
   - Unsigned (bit 2): `+0x80` per byte, or `+0x8000` per word.
   - Then, if `!(Reserved & 1)`: `Type &= ~3`, `Reserved |= 0x80`.
   - For IT only the unsigned branch is reachable. Every non-empty DX
     sample has Cvt bit 0 set (signed), so DX skips this block entirely.
8. **Padding** of 31 frames past the loop end or the sample end (`0x1062fd04`-`0x1062fdd5`):
   - **Ping-pong loop:** `D[LoopEnd+k] = D[LoopEnd-1-k]` for `k = 0..30`.
     This overwrites frames past LoopEnd, and reads before `D[0]` when
     `LoopEnd < 31`; no DX sample is affected.
   - **Forward loop:** `D[LoopEnd+k] = D[LoopStart+k]`.
   - **No loop:** `D[Length+k] = trunc(D[Length-1] * (32-k) / 32)` for
     `k = 0..30`, a signed linear fade (`cdq`, `and 0x1f`, `add`, `sar 5`
     is C truncating division).
9. **Fade-in, always** (`0x1062fdd7`-`0x1062fe16`): `D[c] = trunc(D[c]*c/32)`
   for `c = 0..31`, after the padding. The loop body is altered when
   `LoopStart < 32` (26 DX samples), while forward-loop padding copied the
   pre-fade values.
10. Return 0.

## 6. In-memory layouts

### 6.1 Song globals

| VA | Type | IT loader writes | Reset `0x1060e850` / init `0x1060e0xx` | Name |
| --- | --- | --- | --- | --- |
| `0x106981e0` | u8[26 written] | song name | - | `glxSongName[32]` (header candidate) |
| `0x10697cf0` | u8 | GV (`0x80` for DX) | `0x7f` | unnamed global volume |
| `0x10697cea` | u16 | IS | `0x30` | `glxInitialSpeed` (header candidate; the header says "Default 48") |
| `0x1069817e` | u16 | tempo | `0x78` | `glxInitialTempo` (header candidate; the header says "Default 120") |
| `0x1069834a` | u8 | song length, base zero | 0 | `glxSongLength` (header candidate) |
| `0x10698220` | u8[256] | the first `n` order bytes; the rest is not cleared by this loader | zeroed at init `0x1060e076` | `glxOrders[256]` (header candidate) |
| `0x106886c0` | u8[256] | `[0..31]` | `0x40` each at init `0x1060e100` | `glxInitialPanning[256]` (header candidate); the player copies `<<8` into voices at `0x1061599f` |
| `0x106882a0` | ptr[2][128] | `[0][i]` | zeroed `0x1060e06a` (`rep stosd`, 0x100 dwords), freed `0x106194b5` | `glxInstruments` (binary-confirmed: 256 slots, bank = `idx>>7 & 1` at `0x106195b9`) |
| `0x10697d40` | ptr[256] | `[p]` | zeroed `0x1060e082`, freed `0x10619465` | `glxPatterns` (binary-confirmed) |
| `0x10697ce8` | u8 | 2 or 3 | 0 | `glxPlayerMode` (header candidate) |
| `0x106886a6` | u16 | `0x1c5` | 0 | `glxMinPeriod` (header candidate) |
| `0x10698180` | u16 | `0xff00` | `0x7800` | `glxMaxPeriod` (header candidate) |
| `0x10698348` | u8 | channel count | 0 (init, unload `0x106194dc`) | doubles as the "music loaded" test in `glxLoadMusic` |
| `0x10698349` | u8 | - | 0 | music playing (set 1 at `0x106122eb`) |

Loader-static scratch, overwritten by the next load:

| VA | Holds |
| --- | --- |
| `0x10684268` | instrument offsets (u32; room for 128 before `0x10684468`) |
| `0x10684a28` | sample offsets (u32; extent unknown) |
| `0x106845a8` | pattern offsets, u32[256] |
| `0x106844a8` | remap[256] |
| `0x106841a8`, `0x106841e8`, `0x10684228`, `0x10684468`, `0x106849a8`, `0x106849e8` | the six `[64]` converter arrays |

### 6.2 `glxInstrument` (binary-confirmed against GALAXY.H, pack 1)

| Offset | Field |
| --- | --- |
| `+0x00` | FourCC `'INST'` (checked by unload `0x106195de`) |
| `+0x04` | Size `0x142` |
| `+0x08` | Bank (0) |
| `+0x09` | Program (index) |
| `+0x0a` | Message[32] (26 bytes written) |
| `+0x2a` | Split[128] |
| `+0xaa` | `glxArti` (0x9e bytes): `+0xaa` VibType, `+0xab` VibDelay, `+0xad` VibDepth, `+0xaf` VibSpeed, `+0xb1` TremType, `+0xb2` TremDelay, `+0xb4` TremDepth, `+0xb6` TremSpeed (all 0 for IT); `+0xb8` VolFlag, `+0xb9` reserved, `+0xba` VolSize, `+0xbb` VolSustain, `+0xbc` VolLS, `+0xbd` VolLE, `+0xbe` Volume[10]{u16 Time, s16 Value}, `+0xe6` VolFadeOut, `+0xe8` PitFlag … `+0xee` Pitch[10], `+0x116` PitFadeOut, `+0x118` PanFlag … `+0x11e` Panning[10], `+0x146` PanFadeOut |
| `+0x148` | Samples (u16) |
| `+0x14a` | `glxSample[Samples]`, stride `0x48` |

Allocation: instrument mode `realloc` to `0x14a + NoS*0x48`; sample mode a
single `malloc(0x192)`.

**`glxSample`** (0x48 bytes; the unload frees `+0x44` at `0x1061961c`):

| Offset | Field |
| --- | --- |
| `+0x00` | FourCC `'SAMP'` (or 0 if empty) |
| `+0x04` | Size `0x40` |
| `+0x08` | Message[32] |
| `+0x28` | Panning (u16) |
| `+0x2a` | Volume (u16) |
| `+0x2c` | Type (u16) |
| `+0x2e` | Reserved (u16) |
| `+0x30` | Length |
| `+0x34` | LoopStart |
| `+0x38` | LoopEnd |
| `+0x3c` | C4Speed |
| `+0x40` | Articulation ptr (0) |
| `+0x44` | Data ptr |

Data holds `(Length+31)` frames of signed 8- or 16-bit PCM, with padding and
fade-in per section 5. The allocation is MSVCRT `malloc`.

### 6.3 `glxPattern` / `glxTrack` (binary-confirmed: Tracks `+8`, track stride `0x1c`, Events `+0x24` freed at `0x1061947b`)

| Offset | Field |
| --- | --- |
| `+0x00` | `'PATT'` |
| `+0x04` | `0x1e` |
| `+0x08` | Tracks (1) |
| `+0x0c` | Track[0]: `'TRAK'` |
| `+0x10` | `0x14` |
| `+0x14` | Flags |
| `+0x18` | Status |
| `+0x1c` | TimeToNext |
| `+0x20` | Cursor (all 0 at load) |
| `+0x24` | Events pointer, the stream of section 4.6, `realloc`'d to its exact length |

### 6.4 Allocation summary (all MSVCRT through `0x1064a738`/`3c`)

| Allocation | Size | Lifetime |
| --- | --- | --- |
| scratch | `0xc0`, `0x226`, `0x50`, `0xe008` | freed at the end of a successful load only |
| instrument | `0x14a` then `0x14a+0x48*NoS`, or `0x192` | until unload `0x106195b0` |
| sample data | `(Length+0x1f)*bps` | until unload |
| pattern | `0x28` | until unload `0x10619494` |
| events | `0xc101`, then realloc to the used length | until unload |

## 7. Effect translation (IT command to Galaxy command, `0x10629e13` table `0x1062a385`)

The output numbering is ProTracker-like. This is **inferred**, not
symbol-confirmed: S1x→E3x (glissando), S3x→E4x (vibrato waveform), S4x→E7x
(tremolo waveform) and SBx→E6x (loop) match the ProTracker E-subcommands.

| IT | Galaxy cmd | Value transform | Address |
| --- | --- | --- | --- |
| A | `0xf` | `00` becomes `last`; `last = v`; **`v > 0x20` becomes `0x20`** | `0x10629e27` |
| B | `0xb` | raw | `0x10629e66` |
| C | `0xd` | raw (IT hex row; BCD versus hex is up to the player) | `0x10629e6f` |
| D | `0xa` / `0xe` | `00` becomes `last`; `last = v`. `xF` with `x != 0` gives `0xe`, `0xA0 \| x`. `v >= 0xF1` gives `0xe`, `0xB0 \| (v&0xf)`. Otherwise `0xa`, and if `v&0xf != 0`, `v &= 0xf` (the down nibble wins). | `0x10629e78` |
| E | `2` / `0xe` | `00` becomes `last`; `last = v`. `>= 0xF0` gives `0xe`, `0x20 \| (v&0xf)`. `>= 0xE0` gives `0xe`, `0x20 \| (((v&0xf)+2) >> 2)`. Otherwise `2`. | `0x10629f1f` |
| F | `1` / `0xe` | same as E with `0x10` and cmd `1` | `0x10629fa2` |
| G | `3` | raw (no 00 substitution) | `0x1062a025` |
| H | `4` | raw | `0x1062a02e` |
| J | `0` | raw | `0x1062a037` |
| K | `6` | `00` becomes `last`; `last = v` | `0x1062a040` |
| L | `5` | `00` becomes `last`; `last = v` | `0x1062a06d` |
| O | `9` | raw | `0x1062a09b` |
| Q | `0xe` | `0x90 \| (v&0xf)`; the volume nibble is dropped | `0x1062a0a4` |
| R | `7` | raw | `0x1062a0bf` |
| S | `0xe` | sub-table `0x1062a415` → `0x1062a3e5`: S0x `0x0x`, S1x `0x3x`, S3x `0x4x`, S4x `0x7x`, S8x `0x8x`, **S9x becomes cmd `8`, `0xa4` for every x**, SBx `0x6x`, SCx/SDx/SEx/SFx raw. S2x/S5x/S6x/S7x/SAx become `0`/`0`. | `0x1062a0c8` |
| T | `0xf` if `v >= 0x20`; **otherwise it stays `0x14` with v** | | `0x1062a167` |
| X | `8` | raw | `0x1062a17a` |
| I, M, N, P, U, V, W, none, and anything `> X` (Y, Z) | `0` | `0` | `0x1062a180` |

**Load-time effect memory.** `lastcmdval[ch]` (`0x106841a8`) is a single
slot per channel shared by **all** commands:

- At parse it is written with the raw value for every command except
  A/D/E/F/K/L (`0x10629d5d`).
- For A/D/E/F/K/L the switch substitutes `00` from the slot and writes back.
- So `H44` followed by `D00` on the same channel produces volslide `0x44`
  (cmd `0xa`, then `v&0xf != 0`, so `0x04`).
- `G`/`H`/`O`… with `00` **overwrite the slot with 0**.
- The memory is resolved statically, in first-use order (section 4.6), not
  in playback order. Replicate this exactly.

## 8. What the DX songs exercise (scans of the 35 `.umx`, reading only the IT bytes)

- **NULL patterns.** These DX songs reference patterns that are never
  allocated:
  - Empty IT patterns: Area51Bunker 40, BatteryPark 51, HKClub2 30, HKClub 30,
    HongKongCanal 20, HongKongHelipad 51, HongKong 40, NYCBar2 30,
    NYCStreets2 30, NYCStreets 30, NavalBase 11/21, OceanLab2 40,
    ParisChateau 2, ParisClub2 30, ParisClub 30, Tunnels 30, UNATCOReturn
    50, Vandenberg 11, VersaLife 60.
  - Orders `>= PatNum`: Endgame2 22, Endgame3 22-24, HongKongCanal 50,
    Lebedev 40, LibertyIsland 46/47/60, MJ12 70, NavalBase 60, OceanLab 80.
  - Observed but not verified: in the player tick, a NULL `glxPatterns`
    entry branches `0x10615a46` → `0x1061588c`, which increments the order
    and fetches the next entry in the same call. That suggests such an
    order takes no time, unlike IT's 64 empty rows. This is a question for
    the player agent.
- **A > 0x20 clamps to `0xf`/`0x20`:** A40 in Endgame2, Endgame3, Lebedev
  and NavalBase; AFF in LibertyIsland; A25 in UNATCO. **S9x** appears only
  as S91, becoming `8`/`0xa4`. **T** is always `>= 0x50`. **C** is always
  C00.
- **Dropped commands:** M in NavalBase (199), Y in Area51 (16), SA2 in
  Vandenberg (2). No volume-column value is above 64 (census).
- **MV (`+0x31`) is ignored** (48..100 across songs). Two samples have GvL
  other than 64 (MJ12 #21 = 36, UNATCO #9 = 57) and play at full sample
  volume. Every channel pan is 32, which gives initial pan `0x40`. Every
  non-empty sample is signed (Cvt=1). There are no sustain loops on looped
  samples, no stereo or compressed samples, and no `LoopEnd < 31` ping-pong
  loops. The maximum packed pattern is 2989 bytes. The scan recorded only
  each song's maximum row count: 64 in every song except Area51, whose
  maximum is 96. The highest channel used is 30, so no event is dropped by
  the `ch >= 32` rule.
- **Lebedev** (instrument mode): the note maps are identity; NNA 0, fade 0,
  GbV 128, DfP `0xa0` (all ignored); instruments 3, 8 and 13 have a pan
  envelope with flags 7, 4 nodes, loop 0-3, sustain 0-3. That gives
  PanFlag 7, PanSustain 3 (from SLE), and PitFlag gets bit 2 from the pan
  flags. These are quirks to replicate.

## 9. Divergence from the other formats (only where IT differs)

Per-loader period limits and player mode:

| Loader | `0x106886a6` / `0x10698180` | `0x10697ce8` |
| --- | --- | --- |
| IT `0x1062a337` | `0x1c5` / `0xff00` | 2 or 3 |
| XM `0x10626353` | `0x1c5` / `0xff00` | computed |
| S3M | `0x716` / `0x3580` at `0x10627e24`, or `0x1c5` / `0xff00` at `0x10627e48` | 3 |
| MOD, STM, 669, ULT, PTM, MTM | `0x716` / `0x3580` | 3 (669 gives 2) |
| FAR | `0x716` / `0x3580` | 2 |
| MIDI | `0` / `0x7800` | 4 |

IT and XM alone use the wide limits.

## 10. Unresolved branches and open questions

1. Type bit `0x80` is set for every IT sample (GALAXY.H names it
   `GLX_ALWAYSLOOP`). Its effect in the mixer is unknown.
2. Initial pan `0xa0` (disabled and surround channels) becomes `0xa000` in
   the voice (`0x106159a7`). The player's handling, and that of S9x's
   `8`/`0xa4`, is not traced. No DX channel uses it.
3. GV is stored as `0x80` for every DX song (the ineffective clamp at
   `0x10628a77`). Whether the player reads `0x10697cf0` signed or unsigned
   (readers `0x106152df`, `0x10617f50`…) decides between full and
   inverted/zero volume.
4. Galaxy cmd `0xf` with `v = 0x20` (from A>0x20): is it speed 32 or
   tempo 32? Galaxy cmd `0x14` (T<0x20) in the player? cmd `0xd`: BCD or
   hex?
5. How a NULL `glxPatterns` entry is played (section 8). Verify it in the
   player before relying on it.
6. The `+0x400` uninitialised slack that the caller adds to the stream
   Length (`0x1060a711`). It only matters for truncated modules, where a
   short sample read is otherwise `0x10`. Caller semantics belong to
   agent A.
7. The return-2 path (`0x1060e850` sees `0x10698349`) and who unloads
   before a reload (the `0x10698348` gate) belong to agent A.
8. The extent of the sample-offset table at `0x10684a28` (no limit is
   checked; DX has at most 99 samples).
9. The IT loader runs **without** the music critical section `0x1067b670`;
   `0x1060e850` enters it and leaves it before returning. Thread-safety
   against the mixer is unknown.

## 11. How I would probe this (Unicorn oracle)

Run **`0x10628990` directly**, not `0x10618be0`. The dispatcher's only IT
effect is the 0x30-byte peek, and `0x1060e850` calls KERNEL32 critical
sections through the IAT.

**Preconditions:**

- Map the image at `0x10600000`.
- Set `0x1064a744`/`48`/`4c`/`50` to `0x10618aa0` / `0x10618b10` /
  `0x10618b70` / `0x10618bd0`. These are pure code with no imports.
- Point `0x1064a738`/`3c`/`40` at stubs backed by an allocator in Unicorn
  memory. The realloc stub must **copy the old contents** when it grows a
  block: instrument mode grows `0x14a` to `0x14a+NoS*0x48` at
  `0x1062924e`, and the event buffers shrink at `0x1062a2f4`. A plain bump
  allocator that skips the copy would silently corrupt the instrument
  header. Log every (size, ptr) so the allocation table can be checked.
- Hook the CRT thunks `0x106303d8` (memcmp), `0x106303de` (memset) and
  `0x106303e4` (memcpy), or point their IAT slots at native stubs.
- Byte `0x10698348 = 0`; zero `0x10697d40` and `0x106882a0` (0x400 each);
  zero `0x10698220`.
- Build a `glxMemory` (`'MEMO'`, `0xc`, ptr, len, 0) over the IMPM bytes of
  the UMusic export. Add the caller's +0x400 slack as zeros, and once as a
  random fill to show it is unused for intact files.
- `call 0x10628990` with that pointer.

**Dump:**

- Return value.
- Scalars `0x1069834a`, `0x10697cf0`, `0x10697cea`, `0x1069817e`,
  `0x10697ce8`, `0x10698348`, `0x106886a6`, `0x10698180`.
- `0x106981e0[0..25]`, `0x10698220[0..255]`, `0x106886c0[0..31]`.
- Each non-NULL `glxInstruments[0][i]`: header, Split, the 0x9e
  Articulation bytes, Samples, and each `glxSample` plus `(Length+31)*bps`
  Data bytes.
- Each non-NULL `glxPatterns[p]`: 0x28 header plus Events up to the
  realloc'd size.

**Compare** against a Python model written from this note, byte for byte.
Cases:

- Lebedev (instrument mode, pan envelopes, PitFlag quirk).
- Endgame1 (flags 0x13, Amiga mode 3).
- Area51Bunker (empty pattern 40 stays NULL; effect memory across patterns;
  `reuse-last-cmd` is heavy).
- Endgame3 (orders `>= PatNum`, A40).
- A synthetic IT that exercises D/E/F fine and extra-fine slides, `H44`
  then `D00`, note cut and off, `ch >= 32`, an unsigned 16-bit sample, a
  ping-pong loop, and Length < 32.

Then run `0x1062fb10` alone on hand-built `glxSample` records to cover the
delta and stereo branches of other formats if they are ever needed.
