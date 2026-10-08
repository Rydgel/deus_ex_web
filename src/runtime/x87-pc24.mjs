/** x87 arithmetic under precision control 24, the render pass's
 * (docs/render-pass-precision.md): URender::PreRender sets PC 24
 * (control word 0x007f) until PostRender. Every FADD, FSUB, FMUL, FDIV and
 * FSQRT then rounds its result to a 24-bit significand, nearest-even, while
 * the register keeps its 15-bit exponent; loads are exact and FST rounds to
 * binary32 (script-vm.mjs x87store).
 *
 * `p24add` and the others take and return script-vm.mjs's x87 values and
 * round the exact result once to 24 bits, so they are the PC 24 result for
 * any operands: loaded floats, double constants, wide integers. Special
 * operands (NaN, infinities) and zeros follow the 80-bit model's rules,
 * whose result is then rounded the same way.
 *
 * `r24` is the double form for code that computes in JavaScript numbers:
 * the 24-bit rounding of a finite double with the wide exponent. The double
 * add, subtract, multiply, divide or square root of two 24-bit values
 * followed by r24 is the PC 24 result while the double is normal (53 >=
 * 2*24 + 2 makes the double rounding innocuous). */
import { x87add, x87mul, x87div, x87neg, x87sqrt, x87width } from './script-vm.mjs';

/** Round a magnitude `sig·2^exp` to 24 significant bits, nearest-even. */
function round24(neg, sig, exp) {
  if (sig === 0n) return { neg, sig: 0n, exp: 0 };
  const n = x87width(sig);
  if (n <= 24) return { neg, sig, exp };
  const sh = BigInt(n - 24);
  let q = sig >> sh;
  const rem = sig - (q << sh), half = 1n << (sh - 1n);
  if (rem > half || (rem === half && (q & 1n))) q += 1n;
  return { neg, sig: q, exp: exp + Number(sh) };
}
const special = v => v.nan !== undefined || v.inf;

/** An x87 model value rounded to a 24-bit significand. */
export const p24 = v => (special(v) ? v : round24(v.neg, v.sig, v.exp));

export function p24mul(a, b) {
  if (special(a) || special(b) || a.sig === 0n || b.sig === 0n) return p24(x87mul(a, b));
  return round24(a.neg ^ b.neg, a.sig * b.sig, a.exp + b.exp);
}

export function p24add(a, b) {
  if (special(a) || special(b) || a.sig === 0n || b.sig === 0n) return p24(x87add(a, b));
  const exp = Math.min(a.exp, b.exp);
  const sum = (a.neg ? -(a.sig << BigInt(a.exp - exp)) : a.sig << BigInt(a.exp - exp))
    + (b.neg ? -(b.sig << BigInt(b.exp - exp)) : b.sig << BigInt(b.exp - exp));
  // An exact zero sum is +0 under round-to-nearest (x87add's rule).
  if (sum === 0n) return { neg: a.neg & b.neg, sig: 0n, exp: 0 };
  return sum < 0n ? round24(1, -sum, exp) : round24(0, sum, exp);
}
export const p24sub = (a, b) => p24add(a, x87neg(b));

export function p24div(a, b) {
  if (special(a) || special(b) || a.sig === 0n || b.sig === 0n) return p24(x87div(a, b));
  // A quotient of at least 26 bits plus a sticky bit for the remainder.
  const k = Math.max(0, 26 + x87width(b.sig) - x87width(a.sig));
  const num = a.sig << BigInt(k), q = num / b.sig, sticky = num - q * b.sig === 0n ? 0n : 1n;
  return round24(a.neg ^ b.neg, (q << 1n) | sticky, a.exp - b.exp - k - 1);
}

export function p24sqrt(v) {
  if (special(v) || v.sig === 0n || v.neg) return p24(x87sqrt(v));
  // floor(sqrt(sig·2^shift)) with at least 26 bits, and a sticky bit.
  let sig = v.sig, exp = v.exp;
  if (exp & 1) { sig <<= 1n; exp -= 1; }
  const want = 2 * 27, w = x87width(sig), shift = BigInt(w >= want ? 0 : (want - w + 1) & ~1);
  const n = sig << shift;
  let x = 1n << BigInt((x87width(n) + 1) >> 1);
  for (;;) { const y = (x + n / x) >> 1n; if (y >= x) break; x = y; }
  const sticky = x * x === n ? 0n : 1n;
  return round24(0, (x << 1n) | sticky, (exp - Number(shift)) / 2 - 1);
}

export { r24, r24sum, r24prod } from './x87-r24.mjs';
