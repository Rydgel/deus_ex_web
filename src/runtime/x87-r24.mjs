/** The double form of x87 precision control 24 (x87-pc24.mjs), a leaf
 * module: `r24` rounds a finite double to a 24-bit significand with the
 * x87's wide exponent; the double add, subtract, multiply, divide or square
 * root of two 24-bit values followed by r24 is the PC 24 result while the
 * double is normal (53 >= 2*24 + 2). `r24sum` and `r24prod` round the exact
 * sum or product of doubles of any precision once. */
const MIN_NORMAL = 2 ** -126, MAX_F32 = 3.4028234663852886e38;
/** A finite double rounded to a 24-bit significand, nearest-even, with the
 * x87's exponent range (no overflow or denormalization). */
export function r24(x) {
  const a = Math.abs(x);
  if (a >= MIN_NORMAL && a <= MAX_F32) return Math.fround(x);
  // Zero, non-finite values and double subnormals (unreachable from float
  // operands in a few operations; not modelled) pass through.
  if (x === 0 || !Number.isFinite(x) || a < 2 ** -1022) return x;
  // Scale by an exact power of two into binary32's range, round, scale back.
  const k = Math.floor(Math.log2(a));
  const scale = 2 ** -k;
  return Math.fround(x * scale) / scale;
}

/** r24 of the exact value s + e, where s is the double nearest it and
 * |e| ≤ half an ulp of s: r24(s) unless s lies exactly on a 24-bit rounding
 * midpoint, where the sign of e decides. */
function r24split(s, e) {
  const r = r24(s);
  if (e === 0 || r === s || !Number.isFinite(s)) return r;
  const other = 2 * s - r;
  if (other === r || r24(other) !== other) return r;
  return e > 0 ? Math.max(r, other) : Math.min(r, other);
}

/** The PC 24 sum of two finite doubles of any precision (a double constant
 * plus a register value): the exact sum rounded once (TwoSum). */
export function r24sum(a, b) {
  const s = a + b, t = s - a, e = (a - (s - t)) + (b - t);
  return r24split(s, e);
}

const SPLIT = 134217729; // 2^27 + 1 (Veltkamp)
/** The PC 24 product of two finite doubles of any precision: the exact
 * product (Dekker's two-product) rounded once. */
export function r24prod(a, b) {
  const p = a * b;
  if (!Number.isFinite(p) || p === 0) return r24(p);
  const ca = SPLIT * a, ah = ca - (ca - a), al = a - ah;
  const cb = SPLIT * b, bh = cb - (cb - b), bl = b - bh;
  const e = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
  return r24split(p, e);
}
