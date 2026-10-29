import { brushToWorld } from './coords.mjs';
import { traceKernel, TRACE_DIFFERENTIAL } from './trace-kernel.mjs';

const f = Math.fround;
const ZERO3 = Object.freeze([0, 0, 0]);
// BRUSH_BOUNDS=js keeps the reference alone for a benchmark A/B that leaves the other kernels in place (TRACE_KERNEL=js drops them all).
const REFERENCE_ONLY = typeof process !== 'undefined' && process.env?.BRUSH_BOUNDS === 'js';
// This native corner expression retains 64-bit x87 significands. A quarter-turn
// sine can move an exact float32 midpoint by less than a JS double ULP. Keep
// binary significands here instead of silently rounding that term away.
const bits = new DataView(new ArrayBuffer(4));
function binary(value) {
  bits.setFloat32(0, value, true);
  const word = bits.getUint32(0, true), exponent = (word >>> 23) & 255;
  if (exponent === 255) throw new Error('Nonfinite brush bounds are unsupported');
  return { n: BigInt((word & 0x7fffff) | (exponent ? 0x800000 : 0)) * (word >>> 31 ? -1n : 1n),
    e: exponent ? exponent - 150 : -149 };
}
function rounded(value, precision = 64) {
  const sign = value.n < 0n ? -1n : 1n, n = value.n * sign;
  const shift = n.toString(2).length - precision;
  if (shift <= 0) return value;
  const shiftBits = BigInt(shift), unit = 1n << shiftBits, half = unit >> 1n;
  let kept = n >> shiftBits;
  const remainder = n & (unit - 1n);
  if (remainder > half || (remainder === half && (kept & 1n))) kept++;
  return { n: kept * sign, e: value.e + shift };
}
function sum(a, b) {
  const e = Math.min(a.e, b.e);
  return rounded({ n: (a.n << BigInt(a.e - e)) + (b.n << BigInt(b.e - e)), e });
}
function product(a, b) { return rounded({ n: a.n * b.n, e: a.e + b.e }); }
function nativePoint(corner, coords) {
  const delta = corner.map((v, i) => {
    const origin = binary(coords[i]);
    return sum(binary(v), { n: -origin.n, e: origin.e });
  });
  return [3, 6, 9].map(i => {
    const value = sum(sum(product(delta[0], binary(coords[i])), product(delta[1], binary(coords[i + 1]))),
      product(delta[2], binary(coords[i + 2])));
    const stored = rounded(value, 24);
    return f(Number(stored.n) * 2 ** stored.e);
  });
}
const copyBounds = model => ({ min: model.bounds.min.slice(), max: model.bounds.max.slice(), valid: model.bounds.valid });

/** Original UModel.GetCollisionBoundingBox (Engine 0x103f0e70).
 * Source validity is ignored with an owner; native visits all eight corners.
 * Evidence and native comparisons: docs/brush-bounds.md.
 *
 * With an owner the Rust twin answers (native/script-vm/src/bounds.rs, through
 * the trace kernel instance) once the kernel is loaded: the same bits as the
 * reference below on everything it accepts, and `undefined` hands the cases the
 * reference throws on or rounds twice on (non-finite or zero scale, float32
 * subnormal results) back to it. TRACE_KERNEL=js keeps the reference alone;
 * TRACE_DIFFERENTIAL=1 runs it beside every kernel answer and throws on any
 * difference (docs/rotating-brushes.md "Rust twin").
 */
export function brushCollisionBounds(model, owner = null) {
  if (owner == null) return copyBounds(model);
  const kernel = REFERENCE_ONLY ? null : traceKernel;
  if (kernel) {
    const result = kernel.brushBounds(model, owner);
    if (result !== undefined) {
      if (TRACE_DIFFERENTIAL) {
        const expected = brushCollisionBoundsReference(model, owner);
        const same = (a, b) => a.every((v, i) => Object.is(v, b[i]));
        if (!same(result.min, expected.min) || !same(result.max, expected.max) || result.valid !== expected.valid)
          throw new Error(`brush bounds kernel differential mismatch: ${JSON.stringify({ model: model.bounds, owner, kernel: result, javascript: expected })}`);
      }
      return result;
    }
  }
  return brushCollisionBoundsReference(model, owner);
}

/** The JavaScript body: the reference the kernel is held to. */
export function brushCollisionBoundsReference(model, owner) {
  const coords = brushToWorld(owner), bounds = model.bounds;
  let min, max;
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) {
    const corner = [bounds[x ? 'max' : 'min'][0], bounds[y ? 'max' : 'min'][1], bounds[z ? 'max' : 'min'][2]];
    const point = nativePoint(corner, coords);
    if (!min) { min = point.slice(); max = point.slice(); }
    else for (let i = 0; i < 3; i++) {
      if (point[i] < min[i]) min[i] = point[i];
      if (point[i] > max[i]) max[i] = point[i];
    }
  }
  return { min, max, valid: true };
}

/** Original UPrimitive.GetCollisionBoundingBox (Engine 0x103d8460).
 * X/Z use stored float32 extents; Y retains the radius+1 x87 intermediate.
 */
export function primitiveCollisionBounds(model, owner = null) {
  if (owner == null) return copyBounds(model);
  const radius = f(owner.CollisionRadius ?? 0) + 1, height = f(f(owner.CollisionHeight ?? 0) + 1);
  // (the extent and the rounded location without arrays of their own)
  const location = owner.Location ?? ZERO3, ex = f(radius), x = f(location[0]), y = f(location[1]), z = f(location[2]);
  return { min: [f(x - ex), f(y - radius), f(z - height)], max: [f(x + ex), f(y + radius), f(z + height)], valid: true };
}
