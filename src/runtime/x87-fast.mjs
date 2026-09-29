/** Exact fast paths for x87 sequences that end in an f32 store.
 *
 * The x87 model (script-vm.mjs) rounds intermediates to a 64-bit significand
 * and the final FST to f32. When a double computation approximates the same
 * real value within a proven bound, and every value inside that bound rounds
 * to one f32 (no neighbouring midpoint lies within it), that f32 is the x87
 * result: both the double and the extended value round to it. Otherwise the
 * caller runs the exact model. This never approximates the x87 result; it
 * only skips the exact model where its answer is already determined.
 */
const bits = new DataView(new ArrayBuffer(4));
// Spacing above an f32 with biased exponent e (normal numbers), 2^(e-150).
const spacing = Float64Array.from({ length: 256 }, (_, e) => 2 ** (e - 150));

/** The f32 nearest `value` when every real within `bound` of `value` rounds
 * to that same f32 under nearest-even; undefined when that is not certain, or
 * for zero, subnormal, overflow or non-finite results. */
export function unambiguousF32(value, bound) {
  const f = Math.fround(value);
  if (!(f !== 0 && Number.isFinite(f) && bound >= 0)) return undefined;
  bits.setFloat32(0, f);
  const word = bits.getUint32(0), exponent = (word >>> 23) & 255;
  if (exponent === 0 || exponent >= 254) return undefined;
  const up = spacing[exponent];
  // Below a power of two the spacing halves.
  const down = (word & 0x7fffff) === 0 ? up / 2 : up;
  const magnitude = Math.abs(value), target = Math.abs(f);
  return magnitude - bound > target - down / 2 && magnitude + bound < target + up / 2 ? f : undefined;
}

/** A relative error bound of k units of 2^-53, for the accumulated double and
 * extended roundings of a short computation (callers justify k). */
export const ulps53 = k => k * 2 ** -53;

/** Error-free TwoSum test: whether `sum` (a double evaluation of a + b) is
 * the exact sum. An exact double sum is also the exact 64-bit x87 sum. */
export function exactSum(a, b, sum) {
  const part = sum - a;
  return (a - (sum - part)) + (b - part) === 0 && Number.isFinite(sum);
}
