# Core rotator ==/!=/-/+=/-=, float %, rotator*float and vector>>rotator natives

The authority for these nine natives is the installed GOTY `System/Core.u`
and hash-pinned `System/Core.dll`; the two CRT imports they call come from
the shipped `System/MSVCRT.dll`, which the oracle loads and executes for
real:

```text
Core.dll SHA-256    8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4
MSVCRT.dll SHA-256  e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210
Object.uc           the nine native() declarations quoted below
```

Each thunk is the exported `UObject::exec*` entry; its `E9` jump targets the
recovered body.  Native indices, parameter `out` flags and serialized script
bytes come from the Core.u exports, not from the declaration text.

| Index | Declaration | Thunk | Body | Key instructions |
| --- | --- | --- | --- | --- |
| 142 | `static final operator(24) bool == (rotator A, rotator B)` | `0x10102b30` | `0x10139400` | three `cmp` dword pairs at `0x1013944d`/`0x1013945a`/`0x10139466`, `b801000000` `mov eax,1` / `33c0` `xor eax,eax` results, `8902` dword store |
| 173 | `static final operator(18) float % (float A, float B)` | `0x101031d9` | `0x10135020` | `dd1c24` `fstp qword [esp]` widening of B at `0x10135077` then A at `0x10135084`, `e871c7fcff` `call 0x101017fd` (fmod) at `0x10135087`, one `d91a` `fstp [edx]` at `0x10135093` |
| 203 | `static final operator(26) bool != (rotator A, rotator B)` | `0x10102086` | `0x101394f0` | same three `cmp`s at `0x1013953d`/`0x1013954a`/`0x10139556` with the 0/1 result stores inverted |
| 276 | `static final operator(22) vector >> (vector A, rotator B)` | `0x10101cc6` | `0x101380e0` | `f3a5` identity `rep movsd` from `0x101b3230` at `0x10138150`, `8d0c95a4321b10` `lea ecx,[edx*4+0x101b32a4]` quantized-sine index at `0x10138155`, three `call 0x101027f7` transform invocations, closing `fmul`/`faddp` dot chain and three `fstp dword` stores |
| 287 | `static final operator(16) rotator * (rotator A, float B)` | `0x10101f64` | `0x101395e0` | `db442408` `fild [esp+8]` / `d84c2418` `fmul [esp+0x18]` / `e885580300` `call 0x1016eec0` per component, three dword result stores |
| 288 | `static final operator(16) rotator * (float A, rotator B)` | `0x10101c12` | `0x101396d0` | same `fild`/`fmul`/`call 0x1016eec0` triplet; the float operand is evaluated first into `[esp+8]` |
| 317 | `static final operator(20) rotator - (rotator A, rotator B)` | `0x1010164a` | `0x10139bb0` | three `sub` dword pairs at `0x10139c05`/`0x10139c0b`/`0x10139c11`, three dword stores |
| 318 | `static final operator(34) rotator += (out rotator A, rotator B)` | `0x10102059` | `0x10139c90` | `c705f8321e1000000000` `mov [GPropAddr],0`, `8b3df8321e10` `mov edi,[GPropAddr]` with `8d7c2414` `lea edi,[esp+0x14]` fallback, three `add` + `[edi]` stores, 12-byte result copy |
| 319 | `static final operator(34) rotator -= (out rotator A, rotator B)` | `0x10102a2c` | `0x10139d90` | same `GPropAddr` handoff; the three component ops are `sub` |

Shared helpers carry the CRT numerics and the matrix composition:

| Helper | Thunk | Body | Key instructions |
| --- | --- | --- | --- |
| CRT `fmod` prelude (cdecl doubles, `jmp` into `_CIfmod`) | `0x101017fd` | `0x10123230` | `dd442404` `fld qword [esp+4]` / `dd44240c` `fld qword [esp+0xc]` / `e9d7bc0400` `jmp 0x1016ef14` |
| `_CIfmod` IAT thunk → shipped MSVCRT | `0x1016ef14` | MSVCRT `0x78033780` | `ff25f0b42a10` `jmp [0x102ab4f0]`; the real `_CIfmod` does `fxch st(1)` then an `fprem` loop inside SEH/domain-error handling |
| `_ftol` IAT thunk → shipped MSVCRT | `0x1016eec0` | MSVCRT `0x78004dc1` | `ff25b8b42a10` `jmp [0x102ab4b8]`; the real `_ftol` sets RC=truncate and `fistp qword` |
| `FVector(x,y,z)` ctor used three times by 276 | `0x10102860` | `0x10117690` | three `fstp dword` stores, `c20c00` `ret 0xc` |
| `FCoords` ctor (copies the composed vectors) | `0x10102af4` | `0x10118990` | `rep movsd` field copies |
| `FCoords` transform — `M' = M @ R_arg^T` | `0x101027f7` | `0x1011a710` | `d86204` origin-subtract on row 0 only, `fmul`/`faddp` chain `dec3`/`dec5`/`dec2` at `0x1011a766`-`0x1011a76a` giving the left-associative `(x·a.x + y·a.y) + z·a.z`, three `fstp dword` row stores |

## Recovered semantics

As with the other operator natives, each body steps operand tokens through
the evaluator table at `0x101f41b8` left to right and consumes
`EX_EndFunctionParms` (`0x16`).  Rotator operands arrive as three int32
dwords (pitch, yaw, roll); vector operands as three float32 words; float
operands as one float32 word.

### 142 `==` and 203 `!=` — `0x10139400` / `0x101394f0`

Three independent `cmp` instructions compare pitch, yaw and roll as raw
dwords — no angle normalization, no `& 0xffff` masking.  `==` writes dword
`1` when all three match and `0` on the first `jne`; `!=` is the same body
with the stores inverted.  The bool result is a dword store, not a byte.

- `req-eq`/`req-ne-*`, `rne-eq`/`rne-ne-*` — equal rotators and each
  single-component difference on both natives.
- `req-wrap`/`rne-wrap` — a pitch of `0x10000` does **not** equal `0`;
  equality is on the stored dword, not the 16-bit angle class.
- `req-neg` — negative (sign-bit) components compare as raw dwords.

### 173 `%` — `0x10135020` → CRT `fmod` → MSVCRT `_CIfmod`

The body loads operand B (`fld dword`), widens it to a double temporary
(`fstp qword [esp]` — an exact float32→double widening), then does the same
for A, and calls the `fmod` import thunk `cdecl`: `fmod(A, B)`.  The
`fmod` body reloads both doubles and tail-jumps to `_CIfmod`, the MSVC
compiler intrinsic, which leaves the divisor in `st0`, the dividend in
`st1` and runs an `fxch; fprem` loop wrapped in SEH and `_matherr` domain
machinery.  One `fstp dword` stores the float32 result.

Because the operands are float32 the double widening is lossless, so the
in-loop `fprem` divides the exact operand values; the results the oracle
records through the **real shipped `_CIfmod`** are:

- `mod-basic`, `mod-neg-*`, `mod-frac-*` — normal `fmod` semantics:
  `5 % 3 = 2`, `-5.5 % 2 = -1.5`, the result keeps the dividend's sign.
- `mod-div-zero`/`mod-div-negzero` — divisor `±0` is a domain error
  through the CRT path and yields the x87 real indefinite `0xFFC00000`,
  not a quiet `0x7FC00000`.
- `mod-inf-dividend`, `mod-inf-divisor` — an **infinite operand in either
  position** produces `0xFFC00000` through the CRT domain path (so
  `5 % inf` is indefinite, not `5`).
- `mod-zero-dividend` → `+0`, `mod-negzero-dividend` → `+0`: the CRT
  normalizes a `-0` remainder to `+0` (raw `fprem` alone would return
  `-0`, so this is a real `_CIfmod` behavior, not an x87 one).
- `mod-exact` — an exactly-divisible pair gives `+0`.
- `mod-smaller` — `|A| < |B|` returns A.
- `mod-denormal-*` — denormal operands compute normally.
- `mod-nan-*`, `mod-snan-*`, `mod-neg-nan` — a NaN operand propagates its
  quieted payload and takes precedence over the domain-error path
  (`NaN % 0` returns the NaN payload, not the indefinite).

The VM models the result as `f32(A rem B)` for finite nonzero operands and
the observed indefinite/`+0` rules for the domain cases; NaN handling runs
through the same quieted-payload channel as the other natives.

### 287 `rotator * float` and 288 `float * rotator` — `0x101395e0` / `0x101396d0`

Per component, pitch→yaw→roll:

```text
fild dword [component]      ; exact int32 -> 80-bit
fmul dword [scalar]         ; * float32, product stays 80-bit
call 0x1016eec0             ; _ftol: RC=truncate, fistp qword -> eax:edx
mov [result+off], eax       ; low DWORD only
```

The 80-bit product matters: `rmul-extended` multiplies `0x7fffffff` by
`1.0000001` — the exact extended product `2147483902.5` truncates to
`0x7fffffde`'s neighbor `0x800000fe` after the int64 low-DWORD store, where
a double product (`2147483903.0`) would differ.  `fmulr-order` covers the
float-first evaluation order of 288.

`_ftol`'s contract, measured through the shipped MSVCRT body:

- truncates toward zero (`rmul-trunc-*`: `2.9` scale on a component gives
  the truncated, not rounded, value);
- an out-of-int64 or non-finite product returns the integer indefinite —
  low DWORD `0` (`rmul-inf`, `rmul-nan`, `rmul-huge-*`);
- an in-int64 but out-of-int32 product keeps only its low 32 bits —
  `INT_MAX * 1.12499988` stores `0x8ffffefe` (`rmul-max-component`).

### 276 `vector >> rotator` — `0x101380e0`

The body copies the identity `FCoords` constant from `0x101b3230` (BSS
filled by the `GMath` constructor at `0x10102978`, `this` = `0x101b3218`),
then for each angle — **yaw, then pitch, then roll** — builds the forward
single-axis rotation rows through the `FVector`/`FCoords` ctors and folds
them into the accumulator with the transform helper
(`M' = M @ R_angle^T`, left-associative `(x·a.x+y·a.y)+z·a.z` 80-bit dots,
float32 row stores).  Sines come from the quantized table at `0x101b32a4`
with `(angle + 0x4000) >> 2` for the cosine — the same table
`rotationSineTable` in `src/runtime/coords.mjs` reproduces and
`native-coords` validated at all 16,384 entries.

The closing block computes `result[j] = f32(V · M.axis_j)` — the vector
dotted against each composed axis row, each a left-associative 80-bit dot
with one float32 store.  `rot-yaw-90` is the discriminator: the composed
result differs from a `getAxes`-derived lookup by one ulp, so the VM
reimplements the body's own composition (same table, same transform
structure, its own rounding placement) instead of reusing `getAxes`.

- `rot-identity`, `rot-axis-*`, `rot-neg`, `rot-arb-*`, `rot-mixed` —
  composition across yaw/pitch/roll combinations.
- `rot-yaw-90`, `rot-pitch-90`, `rot-roll-90` — quarter turns through the
  quantized table, including the composed-matrix vs `getAxes` ulp case.
- `rot-wrap`, `rot-extreme` — index wraparound and extreme angles.
- `rot-nan-v`, `rot-inf-v`, `rot-neg-zero-v` — non-finite vector
  components propagate through the dots.
- `rot-denormal` — denormal vector components.

### 317 `rotator - rotator` — `0x10139bb0`

Three independent `sub` dwords — mod-2^32 wraparound, no angle
normalization.  `rsub-basic`, `rsub-neg`, `rsub-wrap-*` (a result that
crosses `0x80000000`/`0` stays a wrapped int32, e.g. `0 - 1 =
0xffffffff`), `rsub-extreme`.

### 318 `+=` and 319 `-=` — `0x10139c90` / `0x10139d90`

Both clear `GPropAddr` (`0x101e32f8`), evaluate operand 0 — a variable
evaluator publishes the lvalue's address there — and take `edi =
GPropAddr`, falling back to a stack temporary when it stays zero (a
non-lvalue `out` argument).  Operand 1 is then evaluated, three dword
`add`/`sub` pairs compute the wrapped result **through `edi`** (so an
lvalue is mutated in place), and the three words at `edi` are copied to
the result pointer.  Exactly the `primitiveOutNatives` contract, this time
on argument position 0:

- `addeq-lvalue`/`subeq-lvalue` — the receiver field mutates and the
  returned rotator copies the updated words.
- `addeq-nonlvalue`/`subeq-nonlvalue` — `GPropAddr` reads back zero, the
  computed result still returns, and nothing is mutated.
- `addeq-wrap-*`/`subeq-wrap-*` — the writes wrap mod 2^32.
- `addeq-order`/`subeq-order` — operand evaluation is left to right.

## Validation

`scripts/native-rotator-modulo-oracle.py` executes the unchanged bodies in
the local x86 emulator using the collision-harness base: evaluator-table
replacement evaluators supply float32/vector/rotator operands, the new
`lrotator` kind supplies the `GPropAddr` lvalue contract for operand 0 of
318/319, and the probe records evaluation events, mutated variables,
`GPropAddr`, result bits and post-result tail bytes.  The probe loads the
**real shipped MSVCRT.dll** into the image (hash-pinned), resolves the
`_ftol`/`_CIfmod` IAT slots to it, and emulates the minimal kernel32
surface the CRT error paths touch (TLS slots with `__TlsIndex`
initialized to 0, `GetLastError`, heap stubs).  It calls the `GMath`
constructor first so the `0x101b32a4` sine table is genuinely
initialized.  Signaling-NaN inputs are rerun through the original body in
their quieted form so the JavaScript-observable bits are pinned.

`scripts/validate-native-rotator-modulo.mjs` pins both DLL hashes, all
thunk/body targets including the helper chain, the instruction pins above,
the `_ftol`/`_CIfmod` IAT import names from a real import-directory walk,
the Core.u declarations, native indices, serialized script bytes and
parameter `out` flags — then compares all 121 original cases against the
VM bit-exact: CRT domain errors and NaN payloads through `%`, the 80-bit
vs double product discriminator for `*`, truncation/indefinite `_ftol`
semantics, the composed-`FCoords` `>>` result (including the `getAxes`
ulp difference), raw-dword `==`/`!=`, wrapped `–`/`+=`/`–=`, lvalue
mutation vs. the discarded-temporary fallback, result-store widths,
left-to-right operand order and `FFrame` cursor advance.

The VM side reuses the existing BigInt 80-bit x87 model in
`src/runtime/script-vm.mjs` plus the existing `primitiveOutNatives`
reference/`assign` mechanism (indices 318/319 added with out position 0).
The only new helpers are `x87int32` (the `fild` load of a signed dword)
and `x87ftol` (the `_ftol` contract: truncate-to-zero `fistp qword`, low
DWORD, integer-indefinite → `0`).  A call-shape guard binds these nine
indices only for operand counts and shapes matching the declared
signatures; a malformed call keeps the `services.native` fallback that
unbound indices use.

## Unverified scope

- The left-associative reading of the transform's dot,
  `(x*a.x + y*a.y) + z*a.z`, is **derived from the `de c3`/`de c5`/`de c2`
  `faddp` operands at `0x1011a766`-`0x1011a76a` but is not proven by any
  validator case**.  Replacing it with the right-associative form passes
  every case here, and a sweep of 300,000 random (vector, rotator) pairs
  found no input where the two differ in the float32 output.  That is
  expected: the partial sums accumulate at 64 bits and the result stores at
  24, so an association difference would have to land within about 2^-64
  relative of a float32 rounding boundary.  Unlike `Dot` (219), whose
  association is proven by a constructed catastrophic-cancellation case,
  the matrix entries here come from the quantized sine table and are not
  free, so no such case was constructed.  The form is retained because it
  is what the instruction encodings read as, not because a test requires it.
- The probe establishes the GOTY Core/MSVCRT builds only.
- `GPropObject` (`0x101e32c0`) is written by the real variable evaluators
  but never read by these bodies, so the probe does not populate it.
- Signaling-NaN *inputs* arrive quieted in JavaScript; the oracle reruns
  those inputs through the original body with the quieted bits and the VM
  is verified against that run (the `js*` fields), same as the
  float/vector operators.
- `_CIfmod`'s SEH/`_matherr` framing is executed for real by the probe;
  the VM models only its observable results (finite `rem`, the domain
  indefinite, `+0` normalization, NaN-payload precedence).  Any CRT
  behavior dependent on the runtime `_matherr` hook is outside this
  binding — the game installs none.
- `_ftol`'s exception semantics past the low DWORD (the `edx` high word
  the body discards) are not separately modeled; every case where the
  int64 result's high dword could matter is pinned only through the
  stored low dword.
- The 276 body's per-angle `FCoords` construction reuses the proven
  `FVector`/`FCoords`/transform helpers and sine table; the validator
  pins the body's own instruction sequence and the helper thunks but does
  not re-pin every helper instruction.
- Other natives sharing these patterns — including the explicitly
  excluded 237 `Asc`, 115/120/121 string compares, 131 `^^`, 160 `/=`,
  297 `*=`, 188 `Cos`, 189 `Tan`, 190 `Atan`, 320 `RotRand`, 536
  `SaveConfig` and 751 `CriticalDelete` — remain unbound.
