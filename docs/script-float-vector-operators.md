# Core float/vector operator natives

The authority for these operators is the installed GOTY `System/Core.u` and
hash-pinned `System/Core.dll`:

```text
Core.dll SHA-256  8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4
Object.uc         the ten native() declarations quoted below
```

Each thunk below is the exported `UObject::exec*` entry; its `E9` jump targets
the recovered body.  Native indices, parameter `out` flags, operator
precedence and serialized script bytes are taken from the Core.u exports, not
assumed from the declaration text.

| Index | Declaration | Thunk | Body | Key instruction |
| --- | --- | --- | --- | --- |
| 194 | `static final function float Square(float A)` | `0x1010136b` | `0x101361f0` | `d84c2404` `fmul [esp+4]` at `0x10136224`, one `d919` `fstp [ecx]` |
| 211 | `static final preoperator vector - (vector A)` | `0x101030e4` | `0x10137710` | `d9e0` `fchs` at `0x10137737`/`0x1013774d`/`0x1013775e`, one `fstp` per component |
| 217 | `static final operator(24) bool == (vector A, vector B)` | `0x10101663` | `0x10138430` | `d85c2410` `fcomp` at `0x10138475`, `dfe0` `fnstsw`, `f6c440` `test ah,0x40` |
| 218 | `static final operator(26) bool != (vector A, vector B)` | `0x10102379` | `0x10138530` | `d85c2410` `fcomp` at `0x10138575`, `dfe0` `fnstsw`, `f6c440` `test ah,0x40` |
| 219 | `static final operator(16) float Dot(vector A, vector B)` | `0x10102874` | `0x10138630` | `dec1` `faddp` at `0x10138686` and `0x10138694`, one `d91a` `fstp [edx]` at `0x10138696` |
| 221 | `static final operator(34) vector *= (out vector A, float B)` | `0x1010261c` | `0x10138810` | `d80f` `fmul [edi]` at `0x10138877`, `fstp [edi]`/`[edi+4]`/`[edi+8]` |
| 222 | `static final operator(34) vector /= (out vector A, float B)` | `0x10102da1` | `0x10138a10` | `dc3da8651710` `fdivr qword [0x101765a8]` at `0x10138a73`, `d80f` `fmul [edi]` |
| 224 | `static final operator(34) vector -= (out vector A, vector B)` | `0x1010120d` | `0x10138c10` | `d8642408` `fsub [esp+8]` at `0x10138c69`, `fstp [edi]`/`[edi+4]`/`[edi+8]` |
| 249 | `static final function int Min(int A, int B)` | `0x1010190b` | `0x10134a20` | `3bc1` `cmp eax,ecx`, `7f0a` `jg` — signed compare |
| 296 | `static final operator(16) vector * (vector A, vector B)` | `0x10102ffe` | `0x101379c0` | `d84c2410` `fmul` at `0x10137a02`, `fstp` at `0x10137a0e`/`0x10137a24`/`0x10137a37` |

## Recovered semantics

Every body reads each operand token from `FFrame.Code`, advances the cursor,
dispatches through the evaluator table at `0x101f41b8`, then consumes
`EX_EndFunctionParms` (`0x16`).  Operands evaluate strictly left to right.
Each operand evaluator stores its result to memory as float32, so every
operand enters the x87 pipeline already rounded to float32 — the vector
components are three consecutive float32s.

### Where rounding occurs

The bodies compute on the x87 stack, whose registers hold a 64-bit
significand (80-bit extended) and round to float32 **only on a store**
(`fst`/`fstp`).  The rounding placement below comes from the store
instructions in each body, and each claim is proven by an oracle case that
fails under any other placement:

- **249 `Min`** — dword compare: `cmp`/`jg` signed, `Min(-1, 1) = -1`
  (`min-unsigned-trap` fails if the operands were treated unsigned).
- **194 `Square`** — `fmul [esp+4]` then a single `fstp`: result is the
  float32 round of the exact square.  `-0` squares to `+0`
  (`square-neg-zero`), `inf` to `+inf`, NaN propagates quieted.
- **211 `-vector`** — `fchs` per component: a pure sign-bit flip.  NaN
  payloads and even the signaling bit survive unquieted — the original
  returns sNaN `0x7FA00000` negated as `0xFFA00000` (`negv-payload-nan`).
- **296 `vector * vector`** — plain componentwise multiply; each of the
  three products stores through its own `fstp`, so each component rounds
  to float32 independently with no 80-bit accumulation.  `inf * 0`
  produces the x87 real indefinite `0xFFC00000` (`mulv-inf-zero`), which
  JavaScript arithmetic cannot produce — `Inf*0` in JS gives `0x7FC00000`.
- **217 `==` / 218 `!=`** — each component is `fcomp`-ed and only status
  bit C3 is tested (`test ah,0x40`).  Unordered — any NaN operand — reads
  as equal, so `==` returns true for NaN components (`eqv-nan-x`,
  `eqv-both-nan`, `eqv-snan`) and `!=` returns false (`nev-nan`).  Signed
  zeros compare equal.  All three components are checked (`eqv-diff-z`).
- **219 `Dot`** — the three `fmul` products and both `faddp` partial sums
  stay on the x87 stack; the only float32 store is the final `fstp` at
  `0x10138696`.  The sum is `A.x*B.x + (A.y*B.y + A.z*B.z)` — the first
  `faddp` folds the y and z products, the second adds x.  Proven by:
  - `dot-order-cancel` (products `2^200, -2^200, 1` → `0x00000000`): the
    `+1` is lost inside `-2^200 + 1` at 64-bit precision, so the answer is
    `+0`.  A left-associative `(px + py) + pz` in *any* precision gives
    `1.0`.
  - `dot-partial-extended` (products `1, -1, 2^-55` → `0x24000000`): the
    partial `-1 + 2^-55` is exact in the 64-bit significand but rounds to
    `-1` in a 53-bit double, so any JavaScript `a*b + (c*d + e*f)` double
    evaluation yields `0`.
  - `dot-extended-products` → `+Inf`: the products overflow float32
    individually yet cancel at 80-bit; per-product `Math.fround` rounding
    gives `Inf + (-Inf)` = NaN.
- **221 `*=`** — `fmul [edi]` per component against the float32 scalar;
  three `fstp` component stores through the `GPropAddr` pointer, result
  copied to `ReturnValue`.
- **222 `/=`** — **no divide-by-zero guard**: `fdivr qword [0x101765a8]`
  divides the embedded double `1.0` by the float32 divisor and keeps the
  reciprocal on the x87 stack at 80-bit, then `fmul [edi]` per component
  with three `fstp` stores.  Proven by `diveq-recip-extended`
  (`0xD9BDFD0B`; a float32-rounded reciprocal stores `0xD9BDFD0A`) and
  `diveq-near-mid` (`2^24/(2^24-1)` → `0x3F800001`, the correctly-rounded
  quotient).  `/= 0` yields signed infinities and the indefinite NaN for
  the zero component (`diveq-zero-divisor` → `+Inf, -Inf, 0xFFC00000`);
  `/= -0` flips the infinities' signs.  `/= inf` gives signed zeros.
- **224 `-=`** — `fsub` per component, three `fstp` stores.  `-0 - -0 =
  +0`, `-0 - +0 = -0` (`subeq-neg-zero`), `inf - inf` gives the
  indefinite NaN (`subeq-inf`).

### NaN propagation

Arithmetic ops (`fmul`, `faddp`, `fsub`, `fdivr`, `fmul [edi]`) quiet
signaling NaNs (set bit `0x400000`) and propagate the NaN operand with the
**larger significand** — including the quiet bit in the comparison
(`mulv-nan-bigA`: `0x7FC00010` beats `0x7FC00002`; `mulv-snan-qnan`: qNaN
`0x7FC00001`, significand `0x400001`, beats sNaN `0x7F800002`,
significand `0x000002`).  On equal significands the source operand wins —
for `fmul [mem]`/`fsub [mem]` that is the memory operand (A), and for
`faddp st(i), st(0)` it is the stack top, which is the product computed
last (`mulv-nan-tie`, `subeq-nan-tie`, `muleq-nan-tie`,
`dot-nan-tie-inner`, `dot-nan-tie-outer` all verified).  Invalid
operations (`inf*0`, `inf-inf`, `inf+(-inf)`, `0*inf`) yield the x87 real
indefinite `0xFFC00000`.  `fchs` (211) is the exception: it never quiets,
it flips the sign bit of whatever pattern it is given.

JavaScript cannot hold a signaling NaN — a `DataView` float32 load quiets
it before the VM sees the value — so the VM observes the *quieted*
operand.  The oracle therefore reruns every sNaN-input case against the
original body with the quieted operand bits (the `js*` fields), and the
validator compares the VM against that run: the VM is verified
bit-identical to the original for every input JavaScript can represent.
The raw sNaN results remain recorded in the oracle output as evidence of
the original's true behavior; the only divergence confined behind the
representation boundary is NaN-winner selection when the quiet bit
changes the significand ordering (raw `mulv-snan-qnan` → `0x7FC00001`,
quieted input → `0x7FC00002`/`0x7FE00000` — the VM matches the quieted
run exactly).

### Host-arithmetic operators: the x87 NaN result

Fourteen more operators are a single x87 operation per result, so both VMs
compute them with doubles (or, for 214, the 222 kernel) and only their NaN
results needed the original's rules.  Thunks and bodies come from the Core.dll
exports; the pinned instructions are checked by the validator:

| Index | Declaration | Thunk | Body | Key instructions |
| --- | --- | --- | --- | --- |
| 171 | `float * (float A, float B)` | `0x10101efb` | `0x10134e80` | `fld [esp+0xc]`, `fmul [esp+4]` at `0x10134ed7`, `fstp [edx]` |
| 172 | `float / (float A, float B)` | `0x10102c0c` | `0x10134f50` | `fld [esp+4]`, `fdiv [esp+0xc]` at `0x10134fa0`, `fstp [edx]` |
| 174 | `float + (float A, float B)` | `0x101020cc` | `0x10135100` | `fadd [esp+4]` at `0x10135157` |
| 175 | `float - (float A, float B)` | `0x1010265d` | `0x101351d0` | `fsub [esp+0xc]` at `0x10135227` |
| 182 | `float *= (out float A, float B)` | `0x101021f3` | `0x101358e0` | GPropAddr clear, `fmul [edi]` at `0x10135949`, `fst [edi]`, `fstp [edx]` |
| 184 | `float += (out float A, float B)` | `0x101024dc` | `0x10135aa0` | `fadd [edi]` at `0x10135b09`, `fst [edi]`, `fstp [edx]` |
| 185 | `float -= (out float A, float B)` | `0x10101645` | `0x10135b80` | `fld [edi]`, `fsub [esp+0x10]` at `0x10135be7` |
| 212 | `vector * (vector A, float B)` | `0x10103247` | `0x101377e0` | one `fmul m32` and `fstp` per component |
| 213 | `vector * (float A, vector B)` | `0x10102897` | `0x101378d0` | one `fmul m32` and `fstp` per component |
| 214 | `vector / (vector A, float B)` | `0x10101c8f` | `0x10137ab0` | `fdivr qword [0x101765a8]` (1.0) kept on the stack, `fmul st(1)` per component, final `fstp st(0)` |
| 215 | `vector + (vector A, vector B)` | `0x101029a5` | `0x10137bb0` | one `fadd m32` and `fstp` per component |
| 216 | `vector - (vector A, vector B)` | `0x10101992` | `0x10137ca0` | one `fsub m32` and `fstp` per component |
| 223 | `vector += (out vector A, vector B)` | `0x10101447` | `0x10138b10` | GPropAddr clear, `fadd [edi+k]`, `fstp [edi+k]` |
| 225 | `float VSize (vector A)` | `0x10102d88` | `0x10138d10` | `(z*z + y*y) + x*x` by `fmul`/`faddp`, `fstp qword`, CRT sqrt thunk `0x101032ba` (Sqrt's), `fstp dword` |

Doubles give the same finite value as each single x87 operation (a float32
product is exact in a double, and a correctly rounded double sum, difference
or quotient rounds to the correctly rounded float32).  Only NaN results
differ, because JavaScript and Rust leave them to the host FPU: arm64's
default NaN is `0x7FC00000`, x86's `0xFFC00000`, and the operand a NaN pair
keeps depends on V8's tier (Maglev keeps the second) and LLVM's operand
order.  Before 2026-10-01 both VMs kept "the first NaN operand" and the host's
default NaN, so they agreed with each other on one CPU and with the original
on neither: `validate-script-vm-interp` failed on x86 only, because it
hard-coded arm64's `0x7FC00000` for `inf * 0`.

The original stores, for every operator in the table (oracle cases
`mulf-*`, `divf-*`, `addf-*`, `subf-*`, `muleqf-*`, `addeqf-*`, `subeqf-*`,
`mulvf-*`, `mulfv-*`, `divvf-*`, `addv-*`, `subv-*`, `addeqv-*`, `vsize-*`):

- **invalid operation**: `inf*0`, `0*inf`, `inf + -inf`, `inf - inf`,
  `0/0`, `inf/inf` store the real indefinite `0xFFC00000`, in either operand
  order (`mulf-inf-zero`, `mulf-zero-neg-inf`, `divf-zero-zero`,
  `divf-inf-inf`, `addv-inf`, `subv-inf`, `divvf-zero`, `divvf-inf`);
- **NaN pair**: the larger significand, either order (`*-nan-pair-a`,
  `*-nan-pair-b`; `vsize-nan-zy`/`vsize-nan-yz`);
- **equal significands, opposite signs**: the positive NaN, either order
  (`*-nan-tie`, `*-nan-tie-b`, `*-indefinite-nan`: indefinite against
  `0x7FC00000` keeps `0x7FC00000`);
- **a lone NaN operand**: that NaN, quieted.

The rule is symmetric, so operand order never matters.  It was measured
twice: in the Unicorn oracle on the original bodies, and on real x87
silicon (AMD Ryzen 9 8945HS, control word `0x037F`):
`tools/x87-nan-probe.c` runs `fmul`/`fdiv`/`fadd`/`fsub` m32 and
`fmulp`/`faddp` on 5,536 operand pairs (every invalid operation of a
16-value grid, 4,384 NaN pairs, 536 opposite-sign ties) and
`scripts/validate-x87-nan-hardware.mjs` compares every row with the VMs'
helper.  Intel's documented rule (larger significand) agrees; a future Intel
measurement that disagreed would be a finding, since the game ran on both.

Both VMs now apply it explicitly.  `src/runtime/x87-nan.mjs` keeps the
double result when it is not a NaN and otherwise builds the x87's float32
NaN from the operands' float32 bits (`x87nanOf`); `interp.rs` `x87_nan` does
the same, returning that float32 NaN widened, so Rust and JavaScript give the
same f64 bits on every CPU.  214 now runs the 222 kernel in both VMs (it was
`v * (1 / f(divisor))` in doubles): the bodies are the same instruction
sequence apart from the out parameter, and the kernel's 80-bit reciprocal is
observable (`divvf-recip-extended` stores `0xD9BDFD0B`, `divvf-near-mid`
`0x3F800001`).  182/184/185/223 with a non-lvalue first operand now return
the result and leave the variable alone, as the original's stack temporary
does (`muleqf-nonlvalue`, `addeqf-nonlvalue`, `subeqf-nonlvalue`,
`addeqv-nonlvalue`); the JavaScript VM threw before.

The tick bookkeeping that `tick.rs` transcribes (actor-tick.mjs LifeSpan,
SightCounter, PainTime/SpeechTime, script-timers.mjs, script-sleep.mjs,
animation-tick.mjs) applies the same helpers per operation of its
transcription.  Those Engine.dll bodies are x87 code too, but their NaN
results have no oracle cases: the rule is applied, not measured there.

### Out parameters

221/222/224 take `out vector A`: the body clears `GPropAddr`
(`0x101e32f8`, `c705f8321e1000000000`) before the arg0 `Step`, and the
variable evaluators publish the variable's address there while still
copying the value to the destination.  With an lvalue the body mutates
through `GPropAddr` (`muleq-basic`, `diveq-basic`, `subeq-basic` verify
`variableBits`); with a non-lvalue first operand `GPropAddr` stays zero
and the mutation lands on the discarded stack temporary while the result
is still returned (`muleq-nonlvalue`, `diveq-nonlvalue`,
`subeq-nonlvalue` — the `0xa5a5a5a5` sentinel survives).

## Validation

`scripts/native-float-vector-operators-oracle.py` executes the unchanged
bodies in the local x86 emulator.  Its replacement evaluators only supply
operand values — float32/int/vector stores for non-lvalue operands and the
`GPropAddr` lvalue contract for `lvector`/`lfloat` — and record evaluation
events, the mutated variable, `GPropAddr`, the result bits and the
post-result tail bytes.

`scripts/validate-native-float-vector-operators.mjs` pins the DLL hash,
the thunk/body targets, the instruction pins above, the `fdivr` constant
word (`1.0` at `0x101765a8`), the `GPropAddr` clears, Core.u declarations,
indices, precedence, serialized script bytes and parameter `out` flags —
then compares all 237 original cases against the VM bit-exact: arithmetic,
signed-zero, denormal, infinity, NaN payload and NaN-tie results, the
rounding-placement proofs named above, lvalue mutation and the temporary
fallback, left-to-right operand evaluation, `FFrame` cursor advance and
result-store width.  NaN results compare after folding in the quiet bit,
the one adjustment forced by JavaScript's representation of stored NaNs.

## Unverified scope

The probe establishes the GOTY Core build only.  `GPropObject`
(`0x101e32c0`) is written by the real variable evaluators but never read
by these bodies, so the probe does not populate it.  Signaling-NaN
*inputs* are unrepresentable in JavaScript (they arrive quieted); those
cases are validated against the original's behavior on the quieted
operands rather than on the raw sNaN patterns — the raw outcomes are
recorded in the oracle for the record.  For the per-component ops
(221/222/224/296) and `Square`, a 5.9M-pair sweep found no case where the
64-bit x87 intermediate and the correctly-rounded double differ after the
float32 store (products of float32 operands are exact in double), so the
extended-precision model's observable role there is NaN/indefinite and
reciprocal handling; for `Dot` the 64-bit accumulation and summation
order are directly proven by the cases above.  Other natives sharing
these bodies' patterns but outside the listed indices remain unbound.

Invalid-operation sites still left to the host FPU (audited 2026-10-01):

- `script-decoration-primitives.mjs` 275 (`vector << rotator`, JavaScript
  only): three dot products in doubles; its x87 operation tree is not traced,
  so its NaN results follow the host.
- The physics and collision transcriptions (trace, hash, walk, move_pawn and
  their JavaScript references) compute in doubles; a NaN there needs
  degenerate geometry (a zero-length normalization, `inf - inf`).  Rust and
  JavaScript run the same host operations, so they agree on one CPU, but
  their NaN bits are the host's, not verified against the original.
- The x87 kernel (`x87.rs`, the BigInt model) compares raw significands, so
  a signaling NaN *loaded* by FLD m32 (which the hardware quiets on load,
  making it win as a quiet NaN) is unmodeled; neither VM can hold one.
