# Original `FSoundData::GetPeriod` and `FWaveModInfo::ReadWaveInfo`

This note records the bounded period calculation recovered from the installed
Deus Ex GOTY `Engine.dll` (SHA-256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`).  The
instruction source is `.cache/reference/Engine.asm`; the original WAV input
comes from `Deus Ex GOTY Edition/System/DeusExSounds.u`.  This is a metadata
and duration calculation boundary.  It does not load an archive, allocate
native sound storage, or play audio.

## Entry points and call order

The exported `FSoundData::GetPeriod` thunk `0x10303bc5` enters body
`0x1036f7a0`.  The body first calls the generic lazy-array `Load` thunk
`0x10301168` at `0x1036f7cc`, with the embedded array at
`FSoundData+0x0c`.  That call is unconditional; the generic helper itself
returns without touching the archive when the signed `FSoundData+0x08` saved
position is nonpositive.  A host binding therefore supplies an explicit
lazy-load callback before it resolves the byte array.  A positive saved
position without such a callback is unsupported here.

The body then passes `FSoundData+0x0c` to `ReadWaveInfo` thunk `0x10301c67`,
which enters body `0x1036fd10` with a temporary `FWaveModInfo` at the caller's
stack frame.  `GetPeriod` initializes its result to `0.0f`; a failed parser or
a zero denominator returns that value.

If parsing succeeds, the body reads the format's sample rate, bits per sample,
and channel count.  It writes `22050` (`0x5622`) to a local when the sample
rate is zero, but the subsequent multiply reads the original sample-rate
pointer again.  The fallback therefore does not affect the denominator.  The
denominator is two sequential x86 `imull` operations, so only the low signed
32 bits are retained:

```text
denominator = signed32(bitsPerSample * channels * rawSampleRate)
```

The data chunk size is loaded as a zero-high-word 64-bit integer, multiplied by
the single-precision constant at `0x1042b148` (measured value `8.0f`), and
divided by that denominator.  The result is stored and returned as a 32-bit
float:

```text
period = f32((dataChunkSize * 8.0) / denominator)
```

The size here is the `data` chunk's own 32-bit size, not the complete WAV or
the enclosing `TArray.Num`.

## `ReadWaveInfo` fields and scan

The argument at `[EBP+8]` is the embedded `TArray`: data pointer at `+0`,
element count at `+4`, and allocation maximum at `+8`.  The function first
stores `data + ArrayNum` in `FWaveModInfo+0x2c`, then checks only the four-byte
tag at `data+8`:

```text
*(data + 8) == 'WAVE'
```

It does not check the `RIFF` tag at byte zero or the RIFF size field.  After the
WAVE gate it stores `data+4` at `FWaveModInfo+0x1c`, then scans from
`data+0x0c`.  The native loop continues only while `cursor+8 < end`; after
leaving that loop it rereads the four-byte tag at the cursor unconditionally.
Unknown chunks advance by `8 + ((size + 1) & ~1)`, preserving the native
two-byte padding rule.  The first `fmt ` chunk supplies these
pointer fields:

| `FWaveModInfo` offset | Native value |
| ---: | --- |
| `+0x00` | `fmtData + 4` (sample-rate pointer) |
| `+0x04` | `fmtData + 8` (average-bytes-per-second pointer) |
| `+0x08` | `fmtData + 12` (block-align pointer) |
| `+0x0c` | `fmtData + 14` (bits-per-sample pointer) |
| `+0x10` | `fmtData + 2` (channels pointer) |
| `+0x14` | zero-extended `*(uint16*)(fmtData + 14)` |

The function independently scans from `data+0x0c` for the first `data`
chunk, using the same strict loop and padded stepping.  It records:

| `FWaveModInfo` offset | Native value |
| ---: | --- |
| `+0x18` | `dataHeader + 4` (data-size pointer) |
| `+0x20` | `dataHeader + 8` (data bytes pointer) |
| `+0x24` | data bytes pointer plus the chunk size |
| `+0x28` | the chunk size value |
| `+0x38` | the same chunk size value |

The optional third scan starts from `data+0x0c` for `smpl`.  When the final
native `cur+4 < end` gate and tag comparison succeed, it stores
`smplData+0x1c` at `+0x30` (the sample-loop count in the standard `smpl`
layout) and `smplData+0x24` at `+0x34` (the first loop record).  The function
returns one after the WAVE, `fmt `, and `data` stages; `smpl` is not required.

The native body does not validate PCM encoding, format size, RIFF bounds, or
data bounds before dereferencing these fields.  A browser host cannot safely
reproduce an invalid native memory read, so the translation rejects truncated
or overrun headers as an explicit `unsupported` error.  In particular, it
does not silently turn the post-loop tag read into a missing-chunk result when
the supplied byte capacity cannot satisfy that read.  The optional `smpl`
path retains its separate `cur+4 < end` gate.  The translation does not add
RIFF or PCM requirements to a well-bounded input.

## Measured reference cases

The two package exports below use version-68 serialized Sound payloads with
the inline WAV bytes beginning at payload offset 9:

| Export | WAV bytes | `data` bytes | Native `GetPeriod` |
| --- | ---: | ---: | ---: |
| `Special.Switch4ClickOn` | 11238 | 11118 | `0.2521088421344757` |
| `Special.Switch4ClickOff` | 13366 | 13246 | `0.30036282539367676` |

Both are PCM mono, 22050 Hz, 16 bits/sample.  A focused synthetic buffer with
an arbitrary four-byte prefix (no `RIFF` tag), an odd-sized unknown chunk
before `fmt `, a zero sample rate, and a valid `smpl` chunk returns
`ReadWaveInfo=1`, records the padded offsets and loop fields, and returns
period `0.0`.  A buffer whose byte-8 tag is not `WAVE` returns
`ReadWaveInfo=0` and `GetPeriod=0.0`, even if otherwise valid chunks follow
it.  These cases are emitted by
`scripts/native-sound-period-oracle.py` and compared by
`scripts/validate-sound-period.mjs`.

The host API in `src/runtime/script-sound-period.mjs` exposes the bounded
`readWaveInfo(bytes, {arrayNum})` parser and `getPeriod(soundData, {bytes,
lazyLoad})`.  `soundData.lazyField08` is required signed storage; an absent
field is an unsupported record.  `getPeriod` invokes a supplied synchronous
`lazyLoad(soundData)` callback before reading the array, rejects a Promise
return, then applies the native nonpositive-position and zero-denominator
behavior.  It leaves archive services, Sound.Load owner writes, native
allocation, and playback to their separate Stage 3/Stage 4 boundaries.
