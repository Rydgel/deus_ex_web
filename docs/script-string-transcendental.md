# Core string </<=/>=, Asc, ^^, int /=, vector *= and the Sin/Cos/Tan/Atan natives

The authority for these natives is the installed GOTY `System/Core.u` and
hash-pinned `System/Core.dll`; the CRT imports the bodies call come from the
shipped `System/MSVCRT.dll`, which the oracle loads and executes for real:

```text
Core.dll SHA-256    8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4
MSVCRT.dll SHA-256  e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210
Object.uc           the native() declarations quoted below
```

Each thunk is the exported `UObject::exec*` entry; its `E9` jump targets the
recovered body.  Native indices, parameter `out` flags and serialized script
bytes come from the Core.u exports, not from the declaration text.

| Index | Declaration | Thunk | Body | Key instructions |
| --- | --- | --- | --- | --- |
| 115 | `static final operator(24) bool < (string A, string B)` | `0x1010153c` | `0x1013ae20` | two evaluator calls through `0x101f41b8`, `b954f61e10`/`b854f61e10` `mov reg,0x101ef654` empty-buffer substitutions at `0x1013aeaf`/`0x1013aec0`, `e8f563fcff` `call 0x101012c1` (appStrcmp) at `0x1013aec7`, `0f9cc2` `setl` at `0x1013aed7`, `8910` dword store |
| 120 | `static final operator(24) bool <= (string A, string B)` | `0x10102bb2` | `0x1013b1c0` | same shape; `0f9ec2` `setle` at `0x1013b277` |
| 121 | `static final operator(24) bool >= (string A, string B)` | `0x1010309e` | `0x1013b390` | same shape; `0f9dc2` `setge` at `0x1013b447` |
| 131 | `static final operator(30) bool ^^ (bool A, bool B)` | `0x1010288d` | `0x10132b90` | `85c0` `test`/`0f94c2` `sete dl` on operand B and `85f6` `test`/`0f94c0` `sete al` on operand A at `0x10132be6`-`0x10132bfa`, `33d0` `xor edx,eax` at `0x10132bfd`, `8911` dword store |
| 160 | `static final operator(34) int /= (out int A, float B)` | `0x10102d6a` | `0x10134370` | `893df8321e10` `mov [GPropAddr],0` at `0x10134391`, `8b3d`/`jne`/`lea edi,[esp+8]` out-target fallback, `d81dc4651710` `fcomp [0x101765c4]` + `dfe0` `fnstsw ax` + `f6c440` `test ah,0x40` + `7519` `jne 0x10134401`, `db07` `fild [edi]` + `d8742410` `fdiv [esp+0x10]` + `call 0x1016eec0` (_ftol); the `0x10134401` path flds the same `0.0` constant, calls `_ftol`, and stores `0` to **both** `[edi]` and `[edx]` |
| 237 | `static final function int Asc(string S)` | `0x10101c76` | `0x1013c630` | `b854f61e10` `mov eax,0x101ef654` on `ArrayNum==0` at `0x1013c68e`, `668b08` `mov cx,word [eax]` at `0x1013c699`, `890a` dword store |
| 297 | `static final operator(34) vector *= (out vector A, vector B)` | `0x1010245a` | `0x10138910` | `c705f8321e1000000000` `mov [GPropAddr],0`, `8b3d`+`jne`/`lea edi,[esp+0x14]` fallback, per component `d94424xx` `fld` operand B / `d8 4f xx` `fmul [edi+off]` / `d9 5f xx` `fstp [edi+off]`, three-dword result copy `8902`/`894a04`/`894208` |
| 187 | `static final function float Sin(float A)` | `0x10102388` | `0x10135d20` | `d944240c` `fld` f32, `dd1c24` `fstp qword` widen, `e841d6fcff` `call 0x101033a0` → `0x10123240`, `d919` `fstp [ecx]` f32 store |
| 188 | `static final function float Cos(float A)` | `0x10101faa` | `0x10135dd0` | same shape; `e8a1bbfcff` `call 0x101019b0` → `0x10123250` |
| 189 | `static final function float Tan(float A)` | `0x101022ed` | `0x10135e80` | same shape; `e803c7fcff` `call 0x101025c2` → `0x10123260` |
| 190 | `static final function float Atan(float A)` | `0x10102126` | `0x10135f30` | same shape; `e8bcb2fcff` `call 0x1010122b` → `0x10123270` |

Shared helpers carry the string compare, the int64 truncation and — contrary
to the CRT-import assumption the task started with — the **x87 hardware
instructions** for the four transcendentals:

| Helper | Thunk | Body | Key instructions |
| --- | --- | --- | --- |
| `appStrcmp` → shipped MSVCRT `wcscmp` | `0x101012c1` | `0x10123540` | `8b442408`/`8b4c2404` reload both args, `ff15ecb42a10` `call [0x102ab4ec]` — IAT resolves to `msvcrt.dll wcscmp` (verified by the import-directory walk) |
| `_ftol` IAT thunk → shipped MSVCRT | `0x1016eec0` | MSVCRT `0x78004dc1` | `ff25b8b42a10` `jmp [0x102ab4b8]`; the real `_ftol` sets RC=truncate and `fistp qword` |
| `fsin` thunk (cdecl double) | `0x101033a0` | `0x10123240` | `dd442404` `fld qword [esp+4]`, `d9fe` `fsin`, `c3` `ret` |
| `fcos` thunk | `0x101019b0` | `0x10123250` | `dd442404` `fld qword [esp+4]`, `d9ff` `fcos`, `c3` `ret` |
| `fptan` thunk | `0x101025c2` | `0x10123260` | `dd442404` `fld qword [esp+4]`, `d9f2` `fptan`, `ddd8` `fstp st(0)` — pops the `1.0` FPTAN pushes over its result, `c3` `ret` |
| `fpatan` thunk | `0x1010122b` | `0x10123270` | `dd442404` `fld qword [esp+4]`, `d9e8` `fld1`, `d9f3` `fpatan` — computes `atan2(x, 1)`, `c3` `ret` |

## Recovered semantics

As with the other operator natives, each body steps operand tokens through
the evaluator table at `0x101f41b8` left to right and consumes
`EX_EndFunctionParms` (`0x16`).  String operands arrive as 12-byte FString
temporaries `{data, ArrayNum, ArrayMax}`; vector operands as three float32
words; the `out` operands arrive through `GPropAddr` (`0x101e32f8`).

### 115 `<`, 120 `<=`, 121 `>=` — `0x1013ae20` / `0x1013b1c0` / `0x1013b390`

Each body builds two FString temporaries, then — after the second operand
evaluates — reads each temporary's **ArrayNum** (`cmp eax,ebx` against the
zero base): when it is zero the data pointer used for the compare is the
runtime empty-string buffer `0x101ef654` (BSS, a lone NUL).  The **pointer
field is never consulted** — proven by `slt-numzero-ptr` (a valid pointer
with `ArrayNum==0` behaves as empty: `'' < 'a'` → 1) and by
`slt-nullptr-num` (a null pointer with `ArrayNum==5` reaches `wcscmp(0,…)`
— on the emulated zero page the read answers nonzero, giving `0`, not the
`1` an empty-substituted compare would produce; the real game would read
whatever lives at linear address 0, so that storage shape remains
unsupported).

`appStrcmp` forwards to the shipped MSVCRT `wcscmp`: an **unsigned** UTF-16
code-unit compare, **case-sensitive**, terminating at the first NUL unit.
The bool is `setl`/`setle`/`setge` on the signed int result — `appStrcmp`
returns an `int` the body `test`s, it does not return 0/1.  Cases:

- `slt-mixed-case` — `'Abc' < 'abc'` → 1: the comparison is case-sensitive
  (`'A'` 0x41 < `'a'` 0x61), i.e. `wcscmp`, not `wcsicmp`.
- `slt-unsigned-hi`/`slt-unsigned-top` — code units above 0x7FFF compare
  **unsigned**: `'耀'` (U+8000) > `'a'` → not less; `U+8000 < U+FFFF` → 1.
- `slt-surrogate` — a lone lead surrogate `\ud83d` < `U+E000` → 1:
  UTF-16 code units, no code-point semantics.
- `slt-prefix-*` — the shorter text's terminating NUL orders prefixes.
- `slt-empty-*`/`slt-embedded-zero` — empty-vs-empty and an operand whose
  logical text ends at an embedded NUL (`"a\0b"` vs `"a"` → equal → `0`).

### 237 `Asc` — `0x1013c630`

The FString operand's ArrayNum==0 substitutes `0x101ef654`; the result is
`movzx word [data]` — the first UTF-16 code unit zero-extended into a dword.
An empty string therefore returns the empty buffer's leading NUL → `0`
(`asc-empty`); a lone surrogate returns the unit itself (`asc-surrogate` →
`0xd83d` = 55357); `asc-unsigned-top` returns `0xffff` = 65535.
`asc-nullptr-num` reads `[0]` on a null pointer with nonzero ArrayNum —
same unsupported storage shape as above.

### 131 `^^` — `0x10132b90`

Both dword operands are `test`ed for zero and each folded through `sete`
(`operand == 0`); the two flags are `xor`ed and stored.  That is logical
inequality after zero-truth coercion: `Boolean(A) !== Boolean(B)`, and any
nonzero bit pattern is true — `xor-nonzero-*` (5 ^^ 0 → 1, 2 ^^ 3 → 0),
`xor-neg` (0xffffffff ^^ 1 → 0), `xor-signbit`.

### 160 `/=` — `0x10134370`

The first operand evaluates as an lvalue: `GPropAddr` is cleared before the
evaluator runs and `edi = GPropAddr` afterwards, falling back to a stack
temporary when it stays zero — the standard out-native handoff.  The second
operand is a float32 temporary.

The body then `fcomp`s the divisor against the embedded float32 `0.0` at
`0x101765c4`, `fnstsw`/`test ah,0x40` reads **C3**, and `jne 0x10134401`
takes the fallback when C3 is set — i.e. when the divisor is **equal to
zero OR unordered (NaN)**.  That path `fld`s the same `0.0` constant, calls
`_ftol`, and stores `0` to **both** `[edi]` and `[edx]` — the previous out
value is **not** kept (an earlier task description said otherwise; the
disassembly and the `diveq-zero`/`diveq-negzero`/`diveq-nan` oracle cases
prove the write of 0).

Otherwise `fild [edi]` loads the int32 exactly and `fdiv dword [esp+0x10]`
divides it by the float32 divisor on the 80-bit x87 stack; `_ftol`
truncates to int64 and **only the low DWORD** is stored to both the out
int and the result.  There is no guard for non-zero non-NaN divisors:
`A / inf` produces a signed zero (`diveq-inf` → 0 through `_ftol`), and a
quotient outside int64 produces the integer indefinite — low DWORD `0`
(`diveq-overflow64`, `diveq-denormal-div`).

- `diveq-wrap`, `diveq-intmin-half`, `diveq-intmin-negone` — int64-range
  quotients keep only their low DWORD (`INT_MAX/0.5` → `0xfffffffe`,
  `INT_MIN/0.5` → `0`, `INT_MIN/-1` → `0x80000000`).
- `diveq-extended` — `INT_MAX / 4.665708e-10f`: the exact 64-bit quotient
  `4602696374922633487.56…` truncates to low DWORD `0x843de10f`; a 53-bit
  double quotient rounds up to `4602696374922633728` and would store
  `0x843de200`.  The VM therefore divides through `x87div` — exact rational
  BigInt division rounded once to the 64-bit significand — not `A / B` in
  double.
- `diveq-nonlvalue` — `GPropAddr` stays 0, the temporary is written and
  discarded, the result still returns.

### 297 `*=` — `0x10138910`

Same `GPropAddr` out handoff (clear, lvalue-evaluate operand 0, `edi =
GPropAddr` or the `[esp+0x14]` temporary).  Operand 1 evaluates into a
12-byte float32 temporary; per component the body runs `fld [temp+off]` /
`fmul [edi+off]` / `fstp [edi+off]` — operand B on the stack times the
target in memory — then copies the three mutated words to the result.  FMUL
is commutative for finite operands; for NaN pairs the proven
larger-significand/positive-tie selection rules apply regardless of which
operand is on the stack (`muleq-nan-tie`), so the operand order is
order-faithful but not test-distinguishable.  `muleq-snan` quiets a
signaling operand; `muleq-inf-zero` produces the real indefinite
`0xffc00000` for `inf*0`; `muleq-denormal` multiplies denormals.

### 187 `Sin`, 188 `Cos`, 189 `Tan`, 190 `Atan` — `0x10135d20` … `0x10135f30`

All four bodies share one shape: `fld` the float32 operand, `fstp qword
[esp]` to widen it to a `double` argument (exact), `call` a Core thunk that
executes the x87 hardware instruction on the pushed double, then one
`fstp dword` result store.  The thunks are **not** MSVCRT imports — each
holds `fld qword [esp+4]` followed by `fsin`, `fcos`, `fptan` (+ `fstp
st(0)` popping the pushed `1.0`), or `fld1`+`fpatan`:

| native | thunk | body | instruction |
| --- | --- | --- | --- |
| 187 `Sin` | `0x101033a0` | `0x10123240` | `fsin` |
| 188 `Cos` | `0x101019b0` | `0x10123250` | `fcos` |
| 189 `Tan` | `0x101025c2` | `0x10123260` | `fptan`; `fstp st(0)` |
| 190 `Atan` | `0x1010122b` | `0x10123270` | `fld1`; `fpatan` |

#### The Unicorn oracle cannot measure these four instructions

The oracle used everywhere else in this project executes the original
instruction bytes, and for integer and basic floating-point work that is
authoritative.  It is **not** authoritative here.  Unicorn's softfloat
implements `FSIN`/`FCOS`/`FPTAN`/`FPATAN` by converting the operand to a
host `double`, calling the host libm, and widening the result back — so
every emulated result carries a 53-bit significand.  That is directly
observable: across the probe sweeps **every** emulated result has its low
11 significand bits clear, where real results keep them.  Comparing a
`Math.cos`-based binding against that oracle is close to circular, because
both sides are the same libm `cos` on the same double.

Four edge behaviors recorded from the emulator in the first pass at this
batch were artifacts, and all four are contradicted by the hardware:

| behavior | Unicorn | real x87 |
| --- | --- | --- |
| `FSIN`/`FCOS`/`FPTAN` of `±inf` | operand passes through | `#IA`, QNaN indefinite `0xffc00000` |
| `FCOS` of a negative NaN | sign cleared (`0xffc00001` → `0x7fc00001`) | sign kept (`0xffc00001` → `0xffc00001`) |
| out-of-range boundary | `|x| > 2^63` (exclusive) | `|x| >= 2^63` (inclusive — `0x5f000000` passes through) |
| `FPTAN` out of range | result `+0` | no push, the thunk's `fstp st(0)` empties the stack and the store underflows to the indefinite |

#### Measured on real silicon

[`tools/x87-transcendental-probe.c`](../tools/x87-transcendental-probe.c)
reproduces the shipped sequence (float32 → `fstp qword` → instruction →
`fstp dword`) and is built with `i686-w64-mingw32-gcc` and run under
CrossOver/Wine, so the instructions execute through Rosetta 2 on the real
FPU.  The probe reports the x87 control word it ran with (`0x037f`, PC=3,
64-bit extended precision) and emits every result's float32 bits, full
80-bit significand and status word.  The recovered rules:

- a NaN operand is **quieted** (bit 22 set) and keeps its sign and payload,
  for all four instructions;
- `±inf` raises `#IA` on `FSIN`/`FCOS`/`FPTAN` and yields the QNaN
  indefinite, while `FPATAN` legitimately returns `±π/2`
  (`0x3fc90fdb` / `0xbfc90fdb`);
- a finite `|x| >= 2^63` is out of range for `FSIN`/`FCOS`: `C2` is set and
  the operand passes through unchanged.  `FPTAN` also declines to push, so
  the thunk's `fstp st(0)` empties the stack and the result store
  underflows to the indefinite;
- for finite in-range operands `f(Math.sin/cos/tan/atan(x))` reproduces the
  hardware **exactly below `|x| = 2^26`**.  Above that the FPU's internal
  66-bit π argument reduction parts company with libm's exactly-reduced
  result — by far more than one ulp (`fcos(0x5effffff)` is `0xbf7a7091` on
  hardware and `0xbf79cabe` through `Math.cos`).

`Atan` is the exception: `FPATAN` performs no argument reduction, and
`f(Math.atan(x))` matched the hardware on **every** sampled float32 bit
pattern across the whole exponent range, including infinities and NaNs.

The VM therefore binds 187/188/189/190 to the measured edge rules plus
`f(Math.X(x))`, and **refuses** a finite `|x| >= 2^26` operand for
sin/cos/tan rather than returning a value the original would not produce.
That boundary is the x87 argument reduction, which this project has not
reimplemented.

## Validation

```text
node scripts/validate-native-string-transcendental.mjs        # string/int/vector natives
node scripts/validate-x87-transcendental-hardware.mjs         # 187-190, real x87
```

The second validator builds `tools/x87-transcendental-probe.c` and runs it in
the CrossOver bottle, comparing every VM result bit-exactly against the
hardware and requiring that refused operands are exactly those above the
`2^26` reduction bound.  It also asserts the probe is not another softfloat:
if every result carried a 53-bit significand it fails rather than passing
silently.  It skips loudly when mingw-w64 or CrossOver is absent.

In `validate-native-string-transcendental.mjs` the four transcendental
natives are checked **structurally only** — index, `FFrame` cursor advance,
operand evaluation order and result store width, all of which the emulator
models correctly — plus a cross-check that below `2^26` the emulator and the
VM agree exactly.  Their result values are not asserted against the emulator.


`scripts/native-string-transcendental-oracle.py` executes the unchanged
bodies in the local x86 emulator using the collision-harness base:
evaluator-table replacement evaluators supply float32/int32/bool/vector/
FString operands (a dict form writes the `{data, ArrayNum, ArrayMax}`
fields verbatim to exercise the num-vs-pointer substitution branch), the
`lint`/`lvector` kinds publish operand 0 through `GPropAddr`, and the probe
records evaluation events, mutated variables, `GPropAddr`, result bits and
post-result tail bytes.  The string bodies run to the instruction after
their result store; the SEH-protected FString destructor tail is compiler
cleanup (an empty `FString::Remove` count early-outs) with no observable
effect on the result — same convention as the string-operations oracle.
The probe loads the **real shipped MSVCRT.dll** (hash-pinned) so `wcscmp`
and `_ftol` execute the original CRT code, and emulates the minimal
kernel32 surface those paths can touch.  Signaling-NaN inputs are rerun
through the original body in their quieted form so the
JavaScript-observable bits are pinned (the `js*` fields).

For the transcendental natives the oracle additionally runs a deterministic
sweep — a fixed targeted edge set (zeros, ±1, π/2 multiples small and
huge, denormals, the 2^63 boundary, infinities, quiet and signaling NaN
payloads, plus up to 256 inputs whose double result sits near a float32
rounding midpoint) followed by 2^20 LCG float32 bit patterns — and packs
the (input, output) pairs so the validator can compare **every sampled
input** against the JavaScript implementation bit-for-bit.

`scripts/validate-native-string-transcendental.mjs` pins both DLL hashes,
all thunk/body targets including the helper chain, the instruction pins
above, the `wcscmp`/`_ftol` IAT import names from a real import-directory
walk, the Core.u declarations, native indices, serialized script bytes and
parameter `out` flags — then compares all 165 original cases against the
VM bit-exact: case-sensitive unsigned UTF-16 compare with the
ArrayNum==0 substitution, first-unit `Asc`, the `^^` zero-truth XOR, the
`/=` C3 fallback that stores 0 (not the previous value) and its 64-bit
truncation discriminator, the `*=` GPropAddr mutation with the discarded-
temporary fallback, result-store widths, left-to-right operand order and
`FFrame` cursor advance — and then replays the full transcendental sweep
through the bound VM implementation.

Sweep outcome.  The emulator cross-check asserts exact agreement with the VM
below `2^26`, counts operands the VM refuses above it, and reports — without
asserting — how often the emulator's own edges disagree.  Those disagreement
counts are a measure of the emulator, not of the original:

```text
sin  627790 in-range agree,  151794 refused above 2^26,      3 emulator-edge
cos  627235 in-range agree,  151372 refused above 2^26,   2067 emulator-edge
tan  627608 in-range agree,  151785 refused above 2^26, 265962 emulator-edge
atan 779200 in-range agree,       0 refused,                 0 emulator-edge
```

The real-hardware validator is the authority for the values; it compares
every result bit-exactly and passes across the whole float32 range:

```text
x87 control word 037f; 600084 real-hardware results compared bit-exact
(|x| < 2^128): cos 150021 (+21485 refused above 2^26), sin 150021
(+21485 refused), tan 150021 (+21485 refused), atan 150021
```

### Sin (187) — rebound

187 was bound as a bare `f(Math.sin(a))` before this batch and was carried
in as audit-only.  The audit found it unfaithful across the entire
out-of-range region, and since 188/189 needed the measured edge model
anyway, 187 now shares it: the four natives are one code path.  The
previously documented "`|x|>2^63` passthrough divergence" is therefore
closed rather than recorded.

## Unverified scope

- The x87 transcendental results are measured on **real silicon through
  Rosetta 2** (CrossOver/Wine), not on Unicorn, whose softfloat computes
  these four instructions in host double precision; see *The Unicorn
  oracle cannot measure these four instructions* above.  Rosetta 2 is
  itself a translation layer: it reproduced every architecturally
  specified edge (`#IA` on `±inf`, the inclusive `2^63` range check, NaN
  quieting with sign and payload preserved) and produced full 64-bit
  significands, but a microcode difference between CPU generations on an
  unsampled in-range argument is not excluded by this instrument.
- `f(Math.sin/cos/tan(x))` is bound only below `|x| = 2^26`: **no
  divergence in ~1.4M sampled float32 bit patterns per function** at or
  below that bound, and the VM refuses larger finite operands rather than
  answering. `f(Math.atan(x))` is bound across the whole range: **no
  divergence in 200,021 samples spanning every exponent**. These are
  empirical bounds, not proofs of identity; a last-ulp double difference
  surviving float32 narrowing on an unsampled input remains possible.
- The x87's 66-bit π argument reduction is **not reimplemented**. That is
  the only reason for the `2^26` bound, and it is the boundary to close if
  a caller ever needs a larger angle.
- NaN payload/sign propagation through JavaScript depends on the engine
  preserving the float64 NaN bits through `Math.fround`/`Math.X` — true on
  the tested V8; the validator compares bit patterns so a different engine
  would fail loudly, not silently approximate.
- `FString` storage with `data == null` and `ArrayNum != 0` cannot be
  expressed by the logical JavaScript string adapter: in the probe the
  mapped zero page answered the `wcscmp`/`movzx` reads (which is what
  proves the substitution keys on `ArrayNum`); in the real game it reads
  arbitrary process memory.  Unsupported.
- Embedded-zero storage maps to the logical adapter's first-NUL
  truncation — proven equivalent to `wcscmp`'s stop-at-NUL by the
  `*-embedded-zero` cases.
- `187 Sin` was rebound onto the measured model with 188/189/190 once the
  hardware probe existed; the bare `f(Math.sin)` binding it carried in is
  gone, and the divergence the audit recorded is closed rather than
  documented.
- For `297`, the FMUL operand order (operand B on the stack, the out target
  as the memory operand) follows the disassembly; under the proven
  NaN-selection rules no case can distinguish it from the reverse order.
- The probe establishes the GOTY Core/MSVCRT builds only.
- `GPropObject` (`0x101e32c0`) is written by the real variable evaluators
  but never read by these bodies, so the probe does not populate it.
- Other natives sharing these patterns — including the explicitly excluded
  320 `RotRand`, 536 `SaveConfig` and 751 `CriticalDelete` — remain
  unbound.
