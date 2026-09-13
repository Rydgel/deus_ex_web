/**
 * Original Core.Object::execVRand (native 252).
 *
 * The GOTY body samples three independent appFrand values as
 * `2 * appFrand() - 1`, stores each sample as a float32, rejects points whose
 * x87 squared magnitude is greater than one, then normalizes the accepted
 * stored vector.  The reciprocal is kept in x87 extended precision until
 * each component is stored.  The small extended-precision helpers below
 * model the finite, normal values reached by the original MSVCRT stream so
 * the float32 result keeps the native boundary-bit behavior.
 */

const f = Math.fround;
const TWO_POW_23 = 1n << 23n;
const TWO_POW_24 = 1n << 24n;
const TWO_POW_63 = 1n << 63n;
const TWO_POW_64 = 1n << 64n;
const float32Bits = new DataView(new ArrayBuffer(8));
const float64Bits = float32Bits;

function bits32(value) {
  float32Bits.setFloat32(0, value, true);
  return float32Bits.getUint32(0, true);
}

function fromBits32(bits) {
  float32Bits.setUint32(0, bits >>> 0, true);
  return float32Bits.getFloat32(0, true);
}

function bits64(value) {
  float64Bits.setFloat64(0, value, true);
  return float64Bits.getBigUint64(0, true);
}

function bitLength(value) {
  return value === 0n ? 0 : value.toString(2).length;
}

/** Round a positive integer right shift to nearest, ties to even. */
function roundRight(value, shift) {
  if (shift <= 0) return value << BigInt(-shift);
  const amount = BigInt(shift);
  const quotient = value >> amount;
  const remainder = value & ((1n << amount) - 1n);
  const half = 1n << (amount - 1n);
  return remainder > half || (remainder === half && (quotient & 1n))
    ? quotient + 1n
    : quotient;
}

function roundSqrtInteger(value) {
  let root = integerSqrt(value);
  const remainder = value - root * root;
  // The midpoint between root and root+1 is root²+root+1/4.  The integer
  // remainder therefore only needs the strict `> root` comparison, while the
  // expanded form keeps the rounding rule clear for future callers.
  if (remainder * 4n > root * 4n + 1n ||
      remainder * 4n === root * 4n + 1n && (root & 1n)) root++;
  return root;
}

function integerSqrt(value) {
  if (value < 0n) throw new Error('Original VRand square root received a negative value');
  if (value < 2n) return value;
  let root = 1n << BigInt(Math.ceil(bitLength(value) / 2));
  for (;;) {
    const next = (root + value / root) >> 1n;
    if (next >= root) return root;
    root = next;
  }
}

/**
 * Normalized finite x87 value: value = significand * 2 ** (exponent - 63),
 * with a 64-bit significand in [2^63, 2^64).
 */
function fromDouble(value) {
  const bits = bits64(value);
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  if (exponentBits === 0 || exponentBits === 0x7ff) {
    throw new Error('Original VRand reached an unsupported non-normal square magnitude');
  }
  const significand = (bits & ((1n << 52n) - 1n)) | (1n << 52n);
  return { significand: significand << 11n, exponent: exponentBits - 1023 };
}

/** x87 FSQRT of the double stored by VRand before calling appSqrt. */
function sqrtExtended(value) {
  const input = fromDouble(value);
  const exponent = Math.floor(input.exponent / 2);
  const radicand = input.significand << BigInt(input.exponent - 2 * exponent + 63);
  let significand = roundSqrtInteger(radicand);
  if (significand >= TWO_POW_64) {
    significand >>= 1n;
    return { significand, exponent: exponent + 1 };
  }
  return { significand, exponent };
}

/** x87 `fdivrl 1.0` after FSQRT, rounded to extended precision. */
function reciprocalExtended(value) {
  const exponent = value.significand === TWO_POW_63
    ? -value.exponent
    : -value.exponent - 1;
  const numerator = 1n << BigInt(126 - value.exponent - exponent);
  let significand = numerator / value.significand;
  const remainder = numerator % value.significand;
  const comparison = remainder * 2n - value.significand;
  if (comparison > 0n || (comparison === 0n && (significand & 1n))) significand++;
  if (significand >= TWO_POW_64) {
    significand >>= 1n;
    return { significand, exponent: exponent + 1 };
  }
  return { significand, exponent };
}

function fromFloat32(value) {
  const bits = bits32(value);
  const exponentBits = (bits >>> 23) & 0xff;
  if (exponentBits === 0 || exponentBits === 0xff) {
    throw new Error('Original VRand reached an unsupported non-normal float32 component');
  }
  return {
    negative: Boolean(bits & 0x80000000),
    significand: TWO_POW_23 | BigInt(bits & 0x7fffff),
    exponent: exponentBits - 127,
  };
}

/** x87 FMUL by a float32 operand followed by the native float32 store. */
function multiplyAndStore(value, component) {
  const input = fromFloat32(component);
  const product = value.significand * input.significand;
  const length = bitLength(product);
  let exponent = length - 1 + value.exponent + input.exponent - 86;
  let significand = roundRight(product, length - 64);
  if (significand >= TWO_POW_64) {
    significand >>= 1n;
    exponent++;
  }
  let stored = roundRight(significand, 40);
  if (stored >= TWO_POW_24) {
    stored >>= 1n;
    exponent++;
  }
  if (exponent < -126 || exponent > 127) {
    throw new Error('Original VRand reached an unsupported float32 result range');
  }
  let bits = ((exponent + 127) << 23) | Number(stored - TWO_POW_23);
  if (input.negative) bits |= 0x80000000;
  return fromBits32(bits);
}

function exactParts32(value) {
  const input = fromFloat32(value);
  return {
    negative: input.negative,
    significand: input.significand,
    exponent: input.exponent - 23,
  };
}

function exactParts64(value) {
  const bits = bits64(value);
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  if (exponentBits === 0 || exponentBits === 0x7ff) {
    throw new Error('Original VRand reached an unsupported non-normal appFrand sample');
  }
  return {
    negative: Boolean(bits >> 63n),
    significand: (bits & ((1n << 52n) - 1n)) | (1n << 52n),
    exponent: exponentBits - 1023 - 52,
  };
}

function squareParts32(value) {
  const input = exactParts32(value);
  return {
    negative: false,
    significand: input.significand * input.significand,
    exponent: input.exponent * 2,
  };
}

/**
 * The rejection comparison retains z's x87 sample while multiplying it by
 * the stored float32 z.  That product can exceed binary64 precision, so keep
 * the comparison as an exact signed binary sum instead of using a rounded
 * JavaScript multiplication.
 */
function insideUnitSphere(x, y, zRaw, z) {
  const terms = [
    squareParts32(x),
    squareParts32(y),
    (() => {
      const left = exactParts64(zRaw), right = exactParts32(z);
      return {
        negative: left.negative !== right.negative,
        significand: left.significand * right.significand,
        exponent: left.exponent + right.exponent,
      };
    })(),
  ];
  const base = Math.min(...terms.map(term => term.exponent));
  let sum = 0n;
  for (const term of terms) {
    const magnitude = term.significand << BigInt(term.exponent - base);
    sum += term.negative ? -magnitude : magnitude;
  }
  const one = base < 0 ? 1n << BigInt(-base) : 1n >> BigInt(base);
  return sum <= one;
}

function sample(rng) {
  const retained = rng.frand();
  if (!Number.isFinite(retained)) throw new Error('Original VRand requires finite appFrand samples');
  const raw = 2 * retained - 1;
  return { raw, stored: f(raw) };
}

/** Execute the recovered Core native 252 contract against a shared RNG. */
export function execVRand(rng) {
  if (typeof rng?.frand !== 'function') {
    throw new Error('VRand requires the shared original RNG stream');
  }
  let x, y, z;
  for (;;) {
    x = sample(rng);
    y = sample(rng);
    z = sample(rng);
    if (insideUnitSphere(x.stored, y.stored, z.raw, z.stored)) break;
  }
  const stored = [x.stored, y.stored, z.stored];
  const squared = (stored[2] * stored[2] + stored[1] * stored[1]) + stored[0] * stored[0];
  if (squared === 0) return [NaN, NaN, NaN];
  const inverse = reciprocalExtended(sqrtExtended(squared));
  return stored.map(component => multiplyAndStore(inverse, component));
}

export const VRAND_NATIVE = Object.freeze({
  index: 252,
  coreSha256: '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4',
  thunk: 0x101031ed,
  body: 0x10139080,
  f32One: 0x10177f9c,
  f64One: 0x101765a8,
});
