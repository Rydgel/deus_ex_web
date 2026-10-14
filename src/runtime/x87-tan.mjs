/** Core appTan (x87 FPTAN on a double, the extended result stored as a qword)
 * for 0 < x < pi/2: the scene frame's FOV half-angle (docs/x87-tan.md).
 *
 * FPTAN's 64-bit result is within about one unit of its last place, and above
 * pi/4 its argument reduction uses a 66-bit pi. Stored to a double, it is the
 * correctly rounded double of the true tangent unless the true value lies
 * within those errors of a halfway point between two doubles. The model
 * computes tan(x) for the exact double x to 256 bits, returns the correctly
 * rounded double, and refuses an argument whose tangent falls inside that
 * band: 8 extended units plus (1 + tan^2) * 2^-64 for the reduction.
 * scripts/validate-x87-tan-hardware.mjs compares it with real FPTAN. */

const P = 256n, ONE = 1n << P;

function decompose(x) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x, true);
  const bits = view.getBigUint64(0, true), exponent = Number((bits >> 52n) & 0x7ffn);
  if (bits >> 63n || exponent === 0 || exponent === 0x7ff) return null;
  return {sig: (bits & ((1n << 52n) - 1n)) | (1n << 52n), exp: exponent - 1075};
}

/** tan(x) * 2^256 for the exact double x (Taylor series of sin and cos). */
function tanFixed(x) {
  const {sig, exp} = decompose(x);
  const fixed = exp >= 0 ? (sig << BigInt(exp)) << P : (sig << P) >> BigInt(-exp);
  const square = (fixed * fixed) >> P;
  let sin = fixed, cos = ONE, sinTerm = fixed, cosTerm = ONE;
  for (let n = 1; n < 120; n++) {
    sinTerm = -(sinTerm * square >> P) / BigInt((2 * n) * (2 * n + 1));
    cosTerm = -(cosTerm * square >> P) / BigInt((2 * n - 1) * (2 * n));
    sin += sinTerm; cos += cosTerm;
    if (sinTerm === 0n && cosTerm === 0n) break;
  }
  if (cos <= 0n) return null;
  return (sin << P) / cos;
}

/** The doubles appTan can store for `x`: one, the correctly rounded tangent,
 * or, when the true tangent lies within FPTAN's error of the halfway point
 * between two doubles, both of them (lower first). Null outside (0, pi/2).
 * Measured on AMD x87 silicon (208,181 arguments): FPTAN missed the correctly
 * rounded double 39 times, each within 0.581 extended units of the halfway
 * point, at every tangent size; the band is 8 extended units. */
function computeTanCandidates(x) {
  if (!(x > 0 && x < Math.PI / 2) || !decompose(x)) return null;
  const t = tanFixed(x);
  if (t === null || t <= 0n) return null;
  // The double keeps 53 bits from the leading one.
  const width = t.toString(2).length, shift = BigInt(width - 53);
  const truncated = t >> shift, remainder = t - (truncated << shift), half = 1n << (shift - 1n);
  const band = 8n << BigInt(width - 64);
  const double = mantissa => {
    let exponent = width - 53 - Number(P);
    if (mantissa >> 53n) { mantissa >>= 1n; exponent++; }
    return Number(mantissa) * 2 ** exponent;
  };
  const distance = remainder > half ? remainder - half : half - remainder;
  if (distance <= band) return [double(truncated), double(truncated + 1n)];
  return [double(remainder > half ? truncated + 1n : truncated)];
}

/** The floats DrawLodMesh can store for appTan(`x`) (Render 0x10b0ebd0..
 * 0x10b0ebe2, docs/script-lodmesh-lod.md): Core's appTan leaves FPTAN's
 * extended result in ST0 and the caller's FSTP m32 rounds it once to a
 * float (precision control does not apply to FPTAN or to a store). One
 * candidate, or both neighbours (lower first) when the true tangent lies
 * within the same 8-extended-unit band of a float rounding midpoint.
 * scripts/validate-x87-tan-hardware.mjs measures it on real FPTAN. */
function computeTanFloatCandidates(x) {
  if (!(x > 0 && x < Math.PI / 2) || !decompose(x)) return null;
  const t = tanFixed(x);
  if (t === null || t <= 0n) return null;
  const width = t.toString(2).length, shift = BigInt(width - 24);
  const truncated = t >> shift, remainder = t - (truncated << shift), half = 1n << (shift - 1n);
  const band = 8n << BigInt(width - 64);
  // A 24-bit mantissa times its power of two is exact in a double; the
  // float's range holds every tangent of a FOV in (0, 180).
  const float = mantissa => Math.fround(Number(mantissa) * 2 ** (width - 24 - Number(P)));
  const distance = remainder > half ? remainder - half : half - remainder;
  if (distance <= band) return [float(truncated), float(truncated + 1n)];
  return [float(remainder > half ? truncated + 1n : truncated)];
}

// Both are pure functions of one double (the frame's FOV half-angle) that Play
// asks for every frame and every child frame with the same argument: the
// results are kept, frozen, for the latest arguments (a few FOVs; a zoom
// sweeps many, hence the bound).
const memoized = compute => {
  const cache = new Map();
  return x => {
    let result = cache.get(x);
    if (result === undefined) {
      result = compute(x);
      if (result) Object.freeze(result);
      if (cache.size >= 64) cache.delete(cache.keys().next().value);
      cache.set(x, result);
    }
    return result;
  };
};
export const x87TanCandidates = memoized(computeTanCandidates);
export const x87TanFloatCandidates = memoized(computeTanFloatCandidates);
