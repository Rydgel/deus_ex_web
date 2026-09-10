import { finishVectorSize } from './mover-finish.mjs';

const f = Math.fround;

/** Native Object.uc indices used by the bounded mover script paths. */
export const moverPrimitiveIndices = new Set([166, 186, 214, 225]);

function arity(args, expected, index) {
  if (!Array.isArray(args) || args.length !== expected) {
    throw new TypeError(`Mover native ${index} expects ${expected} argument${expected === 1 ? '' : 's'}`);
  }
}

function vector(value, index) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TypeError(`Mover native ${index} expects a three-component vector`);
  }
  // A bytecode argument has already crossed a float property boundary in the
  // original VM. Keep that boundary here for direct callers as well.
  return value.map(component => f(Number(component)));
}

function postfixDecrement(ref) {
  if (!ref?.reference || typeof ref.get !== 'function' || typeof ref.set !== 'function') {
    throw new TypeError('Native 166 requires an addressable int reference');
  }
  // Core 0x101348a0 copies the old dword to Result before decrementing the
  // same address. JS bitwise conversion preserves the original signed-int
  // wrap at INT_MIN/INT_MAX.
  const oldValue = Number(ref.get()) | 0;
  ref.set((oldValue - 1) | 0);
  return oldValue;
}

function absoluteFloat(value) {
  const value32 = f(Number(value));
  // Core 0x10135c60 compares the stored float with +0 and only applies FCHS
  // for a strictly negative value. This preserves -0, unlike Math.abs.
  return value32 < 0 ? f(-value32) : value32;
}

function divideVector(value, divisor) {
  const value32 = vector(value, 214);
  const divisor32 = f(Number(divisor));
  // Core 0x10137ab0 forms 1.0/divisor in retained x87 precision, then
  // multiplies each float component and stores each result as float. Keeping
  // this reciprocal unrounded matches that order for ordinary float32 input.
  const reciprocal = 1 / divisor32;
  return value32.map(component => f(component * reciprocal));
}

/**
 * Execute the four native operations needed by Mover.InterpolateEnd and
 * DeusExMover.FinishNotify. Arguments are evaluated values, except native
 * 166's first argument, which must be a { reference, get, set } lvalue.
 */
export function executeMoverPrimitive(index, args) {
  if (!moverPrimitiveIndices.has(index)) {
    throw new Error(`Unsupported mover native index ${index}`);
  }
  switch (index) {
    case 166:
      arity(args, 1, index);
      return postfixDecrement(args[0]);
    case 186:
      arity(args, 1, index);
      return absoluteFloat(args[0]);
    case 214:
      arity(args, 2, index);
      return divideVector(args[0], args[1]);
    case 225:
      arity(args, 1, index);
      return finishVectorSize(vector(args[0], index));
    default:
      // The set check above makes this unreachable, but retaining an explicit
      // branch keeps failures clear if the set and dispatcher diverge.
      throw new Error(`Unsupported mover native index ${index}`);
  }
}
