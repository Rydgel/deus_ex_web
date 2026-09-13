# Core Sqrt / Normal / GetAxes / Smerp / MirrorVectorByNormal natives

The authority for these five natives is the installed GOTY `System/Core.u`
and hash-pinned `System/Core.dll`:

```text
Core.dll SHA-256  8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4
Object.uc         the five native() declarations quoted below
```

Each thunk is the exported `UObject::exec*` entry; its `E9` jump targets the
recovered body.  Native indices, parameter `out` flags and serialized script
bytes come from the Core.u exports, not from the declaration text.

| Index | Declaration | Thunk | Body | Key instructions |
| --- | --- | --- | --- | --- |
| 193 | `static final function float Sqrt(float A)` | `0x101027c0` | `0x10136140` | `d944240c` `fld [esp+0xc]` / `dd1c24` `fstp qword [esp]` at `0x1013616f`-`0x10136174`, `d919` `fstp [ecx]` at `0x10136186` |
| 226 | `static final function vector Normal(vector A)` | `0x10101730` | `0x10138de0` | `e8a8a3fcff` `call 0x101031c0` (SafeNormal thiscall) at `0x10138e13`, then a 12-byte result copy at `0x10138e1f`-`0x10138e2a` |
| 229 | `static final function GetAxes(rotator A, out vector X, out vector Y, out vector Z)` | `0x10102d06` | `0x10139e90` | `893df8321e10` `mov [GPropAddr],edi` clears at `0x10139ed2`/`0x10139f04`/`0x10139f3d`, `d90495a4321b10` `fld [edx*4+0x101b32a4]` quantized-sine lookups at `0x10139fb5`/`0x10139fcf` |
| 248 | `static final function float Smerp(float Alpha, float A, float B)` | `0x10101587` | `0x10136710` | `dc0d907f1710` `fmul qword [0x10177f90]` (embedded `3.0`) at `0x10136793`, one `d919` `fstp [ecx]` at `0x101367b5` |
| 300 | `static final function vector MirrorVectorByNormal(vector Vect, vector Normal)` | `0x10101d2f` | `0x101392a0` | `e8cd9efcff` `call 0x101031c0` at `0x101392ee`, `d95c2438` `fstp [esp+0x38]` dot store at `0x10139341`, `d8e1` `fsub st(1)` at `0x10139365` |

Two shared helpers carry the numerics:

| Helper | Thunk | Body | Key instructions |
| --- | --- | --- | --- |
| `FVector::SafeNormal` (thiscall, `ecx` = vector, pushed out buffer) | `0x101031c0` | `0x10144be0` | `dd542404` `fst qword [esp+4]` at `0x10144c04`, `dc1dd8651710` `fcomp qword [0x101765d8]` (embedded `1e-08`) at `0x10144c08`, `f6c401` `test ah,1` / `7415` `je` at `0x10144c10`-`0x10144c13`, `dc3da8651710` `fdivr qword [0x101765a8]` (embedded `1.0`) at `0x10144c39` |
| CRT `sqrt` (cdecl double in, x87 root out) | `0x101032ba` | `0x10123290` | `d9fa` `fsqrt` at `0x10123294` |

## Recovered semantics

As with the float/vector operator natives, each body steps operand tokens
through the evaluator table at `0x101f41b8` left to right and consumes
`EX_EndFunctionParms` (`0x16`).  Every operand evaluator leaves its result in
memory as float32 words (three consecutive words for vectors, three dwords
for rotators), so operands enter the x87 pipeline already float32-rounded.

### 193 `Sqrt` — `0x10136140`

The evaluated float32 operand is loaded (`fld dword`) and stored straight to
a double temporary (`fstp qword`, an exact widening), which is passed to the
CRT `sqrt` thunk.  That thunk executes `fld qword` + `fsqrt` + `ret`: a
correctly-rounded 80-bit root of the double.  A single `fstp dword [ecx]`
stores the float32 result.  Because the operand is float32 (24-bit
significand) the double round trip is lossless, so the result is
`f32(x87sqrt(A))` — and by the double-rounding bound (64 >= 2*24+2) that is
the correctly-rounded float32 root, so `Math.fround(Math.sqrt(A))` would
agree on every finite input; the oracle still pins it directly:

- `sqrt-one`/`sqrt-four`/`sqrt-half`/`sqrt-quarter`/`sqrt-two`,
  `sqrt-tenth`, `sqrt-max`, `sqrt-almost-max`, `sqrt-round-*` — positive
  values, including `0x7F7FFFFF`.
- `sqrt-min-normal`, `sqrt-denormal-1`/`sqrt-denormal-2`/
  `sqrt-denormal-mid` — denormal operands.
- `sqrt-neg-tiny`, `sqrt-neg-one`, `sqrt-neg-max`, `sqrt-neg-inf` →
  `0xFFC00000`: a negative nonzero operand produces the x87 real
  indefinite, which JavaScript's `Math.sqrt` cannot produce (JS gives
  `0x7FC00000`).
- `sqrt-zero` → `+0`, `sqrt-neg-zero` → `0x80000000`: `fsqrt` preserves
  `-0`.
- `sqrt-inf` → `+inf`; `sqrt-nan`, `sqrt-nan-payload`,
  `sqrt-neg-nan-payload`, `sqrt-snan`, `sqrt-neg-snan` — NaN propagates
  quieted, sign and payload preserved.

### 226 `Normal` — `0x10138de0` → `FVector::SafeNormal` `0x10144be0`

`Normal` only evaluates the vector into a local, performs the `SafeNormal`
thiscall and copies the returned 12 bytes to the result pointer.  All
numerics live in `SafeNormal`:

```text
fld [esi+8] ; fld [esi+4] ; fld [esi]     ; z, y, x pushed (x on top)
fld st0 ; fmul st1                         ; x*x
fld st2 ; fmul st3 ; faddp st1             ; x*x + y*y
fld st3 ; fmul st4 ; faddp st1             ; (x*x + y*y) + z*z   LEFT-assoc
fst qword [esp+4]                        ; store DOUBLE, keep on stack
fcomp qword [1e-08] ; test ah,1 ; je       ; C0: below OR unordered -> (0,0,0)
; else: push the stored double; call sqrt; fdivr [1.0]   ; recip on stack
fld st0 ; fmul [esi]   ; fstp [eax]        ; out.x = f32(x * recip)
fld st0 ; fmul [esi+4] ; fstp [eax+4]      ; out.y
fmul [esi+8]           ; fstp [eax+8]      ; out.z
```

The rounding decisions the instructions force:

- **Squared-length association is left-associative** `(x²+y²)+z²`, opposite
  of `Dot`'s `px + (py+pz)`.  `normal-assoc` has a sum where the two
  associations disagree after the float32 output store and the original
  matches the left-associative value.
- **The threshold compare runs on the 80-bit register**, not the stored
  double: `fst` keeps st(0) loaded for the `fcomp`.  `normal-window-80bit`
  is a vector whose squared length is `< 1e-08` in 80-bit but rounds to
  `1e-08` as a double — the original returns `(0,0,0)`, proving the
  extended register is compared.  `normal-below-threshold` /
  `normal-above-threshold` pin the boundary on both sides; an unordered
  (NaN) sum also takes the C0 branch and returns `(0,0,0)`
  (`normal-nan-*`, `normal-snan-x`).
- **The double store feeds `sqrt`.**  At `0x10144c2a`-`0x10144c33` the body
  reloads the two dwords it just stored and pushes them as the `sqrt`
  argument, so `sqrt` receives the 53-bit double rather than the 80-bit
  register.  This is read from the instruction sequence; it is **not**
  separately proven by a validator case, and no cheap one exists — see
  Unverified scope.
- **Normalization is reciprocal-multiply, not divide**: `fdivr [1.0]`
  leaves `1.0/sqrt` on the stack at 80-bit precision and each component is
  an `fmul` into its own `fstp`.  `normal-recip-mul` separates that from a
  float32 reciprocal (component differs in the last bit); the divide shape
  is identical to native 222.
- Denormals (`normal-denormal`, `normal-denormal-x`), infinities
  (`normal-inf-*`: `+inf` sum → recip `+0`, so an infinite component's
  `inf*0` yields the real indefinite `0xFFC00000` while finite components
  become signed zeros), near-overflow (`normal-near-overflow`,
  `normal-huge`) and signed zeros (`normal-neg-zero`,
  `normal-neg-zero-comp`) are pinned.

### 229 `GetAxes` — `0x10139e90`

The body evaluates the rotator, then each out argument in turn.  Before each
out `Step` it clears `GPropAddr` (`0x101e32f8`); variable evaluators publish
the lvalue's address there, so a non-lvalue out argument leaves it zero and
the axis lands on a discarded stack temporary — exactly the
`primitiveOutNatives` contract, here needed for argument positions 1-3
(which is why the VM's out-argument set is per-index).  The body copies an
initialized identity matrix from `0x101b3230`, looks up quantized sines in
the BSS table at `0x101b32a4` (runtime-filled by the `GMath` constructor at
`0x10102978` with `this` = `0x101b3218`), and composes inverse
roll/pitch/yaw matrix multiplies, writing each output row through its saved
`GPropAddr` pointer.  The result pointer is never written — the function is
`void`.

This is precisely the `getAxes(rotation)` in `src/runtime/camera.mjs` that
`docs/camera.md` already proves bit-exact (555/555 original cases against
the same body and sine table); the VM reuses it rather than reimplementing.
The oracle additionally pins through this native's own thunk:

- `axes-zero`, `axes-yaw-90`, `axes-pitch-90`, `axes-roll-90`,
  `axes-mixed`, `axes-negative`, `axes-arbitrary`, `axes-arbitrary-2`,
  `axes-wrap`, `axes-max`, `axes-quantized` — rotation composition,
  wraparound and sine-table quantization.
- `axes-nonlvalue-xyz` (all three outs non-lvalues: `GPropAddr` reads back
  zero, sentinels survive, result buffer untouched),
  `axes-nonlvalue-yz`/`axes-nonlvalue-mixed` (the lvalue outs mutate while
  the non-lvalue positions discard), and `axes-out-values-ignored`
  (preexisting out contents — including a signaling-NaN bit pattern —
  never read, only written).

### 248 `Smerp` — `0x10136710`

Evaluates `Alpha`, `A`, `B` into three float32 locals, then:

```text
fld [Alpha] ; fld st0 ; fmulp st1        ; a²
fld st0 ; fmul qword [3.0]               ; 3a²        (st1 = a²)
fld [Alpha] ; fmul st2                   ; a³
fadd st0,st0 ; fsubp st1                 ; 3a² − 2a³
; (a `pop esi` shifts [esp+x] by 4 — the next three memory operands
;  address B then A through the pre-pop slots)
fld [B] ; fsub [A] ; fmulp st1           ; s·(B−A)
fadd [A] ; fstp [ecx]                    ; A + s·(B−A), single store
```

Every intermediate stays on the 80-bit stack; the only rounding is the final
`fstp` float32 store.  Named cases:

- `smerp-zero`, `smerp-one`, `smerp-half`, `smerp-quarter`, `smerp-eq`,
  `smerp-neg`, `smerp-swap` — interior and boundary alphas.
- `smerp-x87-intermediate` — the x87 path stores `0xBC556902` where
  per-operation float32 rounding stores `0xFC737CCC`.
- `smerp-denormal-alpha` (`0x00000001` alpha), `smerp-denormal-ab`,
  `smerp-neg-alpha`, `smerp-over-one` — alpha outside `[0,1]` is not
  clamped.
- `smerp-nan-alpha`/`smerp-nan-a`/`smerp-nan-b`/`smerp-nan-payload`/
  `smerp-snan-alpha` — payload propagation through the
  `fmul`/`fsub`/`fadd` chain; `smerp-nan-mul-tie` and `smerp-nan-add-tie`
  pin the equal-significand tie (the positive payload wins; see the NaN
  notes in `script-float-vector-operators.md`).
- `smerp-inf-a`/`smerp-inf-b`/`smerp-inf-alpha` — `inf*0` produces the
  real indefinite; `smerp-neg-zero-a`/`smerp-neg-zero-b` pin signed-zero
  handling through the `fsub`/`fadd` memory-operand order.

### 300 `MirrorVectorByNormal` — `0x101392a0`

Evaluates `Vect` at `[esp+0x10]` and `Normal` at `[esp+4]`, calls
`SafeNormal` on `Normal` (same thiscall as native 226 — zero/NaN/tiny
normals therefore mirror to the original vector direction `V − 0`), copies
the normalized `n'` over `Normal`'s slot, then:

```text
fld [n'.x] ; fadd st0,st0                ; 2n'.x  stays on stack in 80-bit
fld [n'.y] ; fadd st0,st0 ; fstp [t2y]   ; f32(2n'.y) stored
fld [n'.z] ; fadd st0,st0 ; fstp [t2z]   ; f32(2n'.z) stored
fld [V.y] ; fmul [n'.y]                  ; py
fld [V.z] ; fmul [n'.z] ; faddp          ; py+pz
fld [V.x] ; fmul [n'.x] ; faddp          ; dot = (py+pz)+px   (undoubled n')
fstp [d]                                 ; dot stored float32  <-- KEY STORE
fmul [d]            ; st0 = 2n'.x * f32(dot), kept 80-bit, never stored
fld [t2y] ; fmul [d] ; fstp [pdy]        ; f32( f32(2n'.y) * f32(dot) )
fld [t2z] ; fmul [d] ; fstp [pdz]        ; f32( f32(2n'.z) * f32(dot) )
fld [V.x] ; fsub st1 ; fstp [out.x]      ; f32(V.x − prodX80)
fld [V.y] ; fsub [pdy] ; fstp [out.y]
fld [V.z] ; fsub [pdz] ; fstp [out.z]
```

so `MirrorVectorByNormal(V, N) = V − 2n'(V·n')` with `n' = SafeNormal(N)`,
and the rounding placement is asymmetric:

- the dot uses the **undoubled** normalized components, associates
  `(py+pz)+px`, and stores **once to float32** — that stored value feeds all
  three products (`mirror-d32-store` fails if the 80-bit dot is reused);
- `2n'.x` never rounds (80-bit through the `fsub st(1)`), while `2n'.y` /
  `2n'.z` round to float32 first (`mirror-yz-preround`);
- the x product stays 80-bit into the subtract, while the y/z products are
  each float32-stored before their `fsub m32` (`mirror-x-keep80`);
- `mirror-nan-dot-tie` / `mirror-nan-sub-tie` pin NaN payload selection on
  both the dot `faddp` chain and the final `fsub`;
- `mirror-zero-normal`/`mirror-below-normal` (at or below the same `1e-08`
  boundary — `SafeNormal` returns `(0,0,0)` so the result is exactly `V`),
  `mirror-unnormalized`, `mirror-neg-normal`, `mirror-neg-zero`,
  `mirror-denormal`, `mirror-near-overflow`, `mirror-inf-v`/`mirror-inf-n`,
  `mirror-nan-v`/`mirror-nan-n`, `mirror-snan-v`.

## Validation

`scripts/native-normal-axes-oracle.py` executes the unchanged bodies in the
local x86 emulator using the float/vector harness: evaluator-table
replacement evaluators supply float32/vector/rotator operands, the
`lvector` kind supplies the `GPropAddr` lvalue contract per out position,
and the probe records evaluation events, mutated variables, `GPropAddr`,
result bits and post-result tail bytes.  It also calls the `GMath`
constructor at `0x10102978` first so the `0x101b32a4` sine table the
`GetAxes` body indexes is genuinely initialized.

`scripts/validate-native-normal-axes.mjs` pins the DLL hash, all thunk/body
targets (including the `SafeNormal` and CRT-`sqrt` helpers), the instruction
pins above, the embedded doubles `1.0`/`1e-08`/`3.0`, the Core.u
declarations, native indices, serialized script bytes and parameter `out`
flags — then compares all 111 original cases against the VM bit-exact:
threshold boundary on both sides of `1e-08` plus the 80-bit-compare window,
squared-length association, reciprocal-multiply, every rounding-placement
proof named above, NaN payloads/ties, signed zeros, denormals, infinities,
`GetAxes` lvalue mutation vs. the discarded-temporary fallback, untouched
result buffer, left-to-right operand order and `FFrame` cursor advance.

The VM side reuses the existing BigInt 80-bit x87 model in
`src/runtime/script-vm.mjs`; the only additions are `x87storeDouble` (the
`fst qword` double store), `x87sqrt` (the CRT thunk's `fsqrt`),
`x87below1em8` (the `fcomp` boundary on the retained register),
`x87safeNormal` (the shared thiscall) and the `x87three` constant.  A
call-shape guard binds these five indices only for operand counts and
shapes matching the declared signatures; a malformed call keeps the
`services.native` fallback that unbound indices use.

## Unverified scope

- The probe establishes the GOTY Core build only.
- `GPropObject` (`0x101e32c0`) is written by the real variable evaluators
  but never read by these bodies, so the probe does not populate it.
- Signaling-NaN *inputs* arrive quieted in JavaScript; the oracle reruns
  those inputs through the original body with the quieted bits and the VM
  is verified against that run (the `js*` fields), same as the
  float/vector operators.
- `GetAxes`'s three matrix-multiply helper bodies (`0x1011a710`,
  `0x10117690`, `0x10118990`) are exercised end-to-end through the native
  and already proven by the camera oracle; the validator pins the body's
  own instruction sequence but does not re-pin every helper instruction.
- `SafeNormal`'s x87 stack cleanup (`fstp st(3)`/`fstp st(0)`/`fstp st(0)`)
  is bookkeeping with no numeric effect and is not separately proven.
- The `fst qword` narrowing of the squared length from the 80-bit register
  to a double, before `sqrt`, is **modelled from the instruction sequence
  but unproven by observation**.  Replacing `x87storeDouble(s)` with `s`
  passes every case in this validator, and a sweep of 2,000,000 random
  float32 vectors found no input where the two differ in the float32
  output.  That matches the error bound: the 53-vs-64-bit difference is
  relative 2^-53, halved by `sqrt`, so the final product would have to fall
  within about 2^-54 relative of a float32 rounding boundary.  The step is
  retained because the original performs it, not because a test requires
  it.  The separate claim that the *threshold comparison* reads the 80-bit
  register is proven, by `normal-window-80bit`.
- `MirrorVectorByNormal` calls `SafeNormal` through the same thunk as
  `Normal`; any other caller of `SafeNormal` (e.g. Engine bodies) is
  outside this batch.
- Other natives sharing these patterns — including the explicitly excluded
  173 `%`, 188 `Cos`, 189 `Tan`, 190 `Atan`, 320 `RotRand`, 536
  `SaveConfig` and 751 `CriticalDelete` — remain unbound.
