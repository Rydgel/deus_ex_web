import { decodeScript } from '../unreal/bytecode.mjs';
import { moverPrimitiveIndices, executeMoverPrimitive } from './script-mover-primitives.mjs';
import { decorationPrimitiveIndices, decorationOutPrimitiveIndices, executeDecorationPrimitive, vectorToRotator, rotatorToVector } from './script-decoration-primitives.mjs';
import { scriptStringText, scriptStringEqual, scriptStringComplementEqual, scriptStringCompare, scriptConcat, scriptAt, scriptLen, scriptInStr, scriptMid, scriptLeft, scriptRight, scriptCaps, scriptChr, scriptNameToString, scriptObjectToString, scriptFloatToString } from './script-string-operations.mjs';
import { getAxes } from './camera.mjs';
import { rotatorSin } from './coords.mjs';

const f = Math.fround;
const primitiveNatives=new Set([112,114,115,119,120,121,122,123,124,125,126,127,128,129,131,135,138,139,140,141,142,143,144,145,146,147,148,149,150,151,154,155,156,157,158,160,163,164,165,168,169,171,172,173,174,175,176,177,179,180,181,182,184,185,187,188,189,190,193,194,196,203,210,211,212,213,215,216,217,218,219,221,222,223,224,226,229,234,235,236,237,242,243,244,245,248,249,250,251,254,255,276,287,288,296,297,300,316,317,318,319]);
for(const index of moverPrimitiveIndices)primitiveNatives.add(index);
for(const index of decorationPrimitiveIndices)primitiveNatives.add(index);
export const primitiveNativeIndices=Object.freeze([...primitiveNatives,130,132].sort((a,b)=>a-b));
// Natives whose out parameters survive as references: each index maps to
// the argument positions the original body writes through GPropAddr.  All
// pre-existing out natives use argument 0; GetAxes (229) writes arguments
// 1-3, so a non-lvalue in any other position still gets a plain copy.
const outArgZero=Object.freeze(new Set([0]));
const primitiveOutNatives=new Map([[229,new Set([1,2,3])]]);
for(const index of [135,138,139,140,160,163,164,165,166,182,184,185,221,222,223,224,297,318,319,...decorationOutPrimitiveIndices])
  primitiveOutNatives.set(index,outArgZero);
export const refValue = v => v?.reference ? v.get() : v;
export const reference = (object, key) => ({ reference: true, get: () => object[key], set: value => (object[key] = value) });
export const assign = (ref, value) => { if (!ref?.reference) throw new Error('Script assignment requires a variable'); return ref.set(value); };

// The float/vector natives read and write float32 memory words, so their
// NaN payloads and signed zeros must cross through DataView bit patterns
// rather than JavaScript arithmetic on the NaN values themselves.
const f32io = new DataView(new ArrayBuffer(4));
export const f32bits = v => (f32io.setFloat32(0, f(v), true), f32io.getUint32(0, true));
export const f32num = b => (f32io.setUint32(0, b >>> 0, true), f32io.getFloat32(0, true));
export const X87_INDEFINITE = 0xffc00000;

/** 80-bit x87 stack model for Core's float/vector operator natives.  The
 * bodies FLD float32 temporaries and keep intermediates on the x87 stack —
 * 64-bit significand, round-to-nearest-even — until an FST/FSTP store rounds
 * once to float32.  A finite value is {neg,sig,exp} with
 * value = (-1)^neg * sig * 2^exp; {inf:true} is an infinity; {nan:bits} keeps
 * the float32 NaN payload (the larger-significand operand propagates quieted;
 * invalid operations produce the real indefinite 0xffc00000). */
// Loaded floats and most intermediates fit in 128 bits. Count their high
// 32-bit limb without allocating a binary string (hot in mesh GetFrame).
// Convert only an exact uint32 limb to Number: converting the whole BigInt
// would round values just below powers of two up and miscount their width.
export const x87width = x => {
  if (x < 0n) return x.toString(2).length;
  if (x < 0x100000000n) return 32 - Math.clz32(Number(x)) || 1;
  if (x < 0x10000000000000000n) return 64 - Math.clz32(Number(x >> 32n));
  if (x < 0x1000000000000000000000000n) return 96 - Math.clz32(Number(x >> 64n));
  if (x < 0x100000000000000000000000000000000n) return 128 - Math.clz32(Number(x >> 96n));
  return x.toString(2).length;
};
// Round a positive significand to `width` bits, nearest-even; returns
// [significand, rightShiftApplied].
const x87round = (sig, width) => {
  const n = x87width(sig);
  if (n <= width) return [sig, 0];
  const sh = BigInt(n - width);
  let q = sig >> sh;
  const rem = sig - (q << sh), half = 1n << (sh - 1n);
  if (rem > half || (rem === half && (q & 1n))) q += 1n;
  return x87width(q) > width ? [q >> 1n, n - width + 1] : [q, n - width];
};
export const x87load = v => {
  const b = f32bits(v), neg = b >>> 31, e = (b >>> 23) & 0xff, m = b & 0x7fffff;
  if (e === 0xff) return m ? { nan: b } : { neg, inf: true };
  return { neg, sig: BigInt(e ? m | 0x800000 : m), exp: e ? e - 150 : -149 };
};
// NaN selection: the operand with the larger significand wins and stores
// quieted; a lone NaN operand quiets the same way.  On equal significands
// the positive payload propagates — pinned by the subeq/mulv/dot tie cases
// (positive st0 or st(i) over negative) and by MirrorVectorByNormal's FSUB
// m32 where the positive memory operand beats the negative stack operand.
export const x87nan = (a, b) => {
  const ap = a.nan & 0x7fffff, bp = b.nan & 0x7fffff;
  const w = bp > ap || (bp === ap && !(b.nan >>> 31)) ? b : a;
  return { nan: (w.nan | 0x400000) >>> 0 };
};
export const x87quiet = v => ({ nan: (v.nan | 0x400000) >>> 0 });
export const x87mul = (a, b) => {
  if (a.nan !== undefined) return b.nan === undefined ? x87quiet(a) : x87nan(a, b);
  if (b.nan !== undefined) return x87quiet(b);
  if (a.inf || b.inf) {
    const other = a.inf ? b : a;
    return !other.inf && other.sig === 0n ? { nan: X87_INDEFINITE } : { neg: a.neg ^ b.neg, inf: true };
  }
  if (a.sig === 0n || b.sig === 0n) return { neg: a.neg ^ b.neg, sig: 0n, exp: 0 };
  const [sig, sh] = x87round(a.sig * b.sig, 64);
  return { neg: a.neg ^ b.neg, sig, exp: a.exp + b.exp + sh };
};
// FSUB operand negation: sign flips on finite and infinite values while a
// NaN subtrahend propagates its own payload unchanged.
export const x87neg = v => v.nan === undefined ? { ...v, neg: v.neg ^ 1 } : v;
export const x87add = (a, b) => {
  if (a.nan !== undefined) return b.nan === undefined ? x87quiet(a) : x87nan(a, b);
  if (b.nan !== undefined) return x87quiet(b);
  if (a.inf || b.inf) {
    if (a.inf && b.inf) return a.neg === b.neg ? a : { nan: X87_INDEFINITE };
    return a.inf ? a : b;
  }
  if (a.sig === 0n) return b.sig === 0n ? { neg: a.neg & b.neg, sig: 0n, exp: 0 } : b;
  if (b.sig === 0n) return a;
  const exp = Math.min(a.exp, b.exp);
  const sum = (a.neg ? -(a.sig << BigInt(a.exp - exp)) : a.sig << BigInt(a.exp - exp))
    + (b.neg ? -(b.sig << BigInt(b.exp - exp)) : b.sig << BigInt(b.exp - exp));
  if (sum === 0n) return { neg: a.neg & b.neg, sig: 0n, exp: 0 };
  const neg = sum < 0n ? 1 : 0;
  const [sig, sh] = x87round(neg ? -sum : sum, 64);
  return { neg, sig, exp: exp + sh };
};
// 1.0 / b held on the x87 stack (native 222 divides the embedded double
// 1.0 at 0x101765a8 by the float32 divisor and never stores it to float32).
export const x87recip = b => {
  const n = x87width(b.sig), num = 1n << BigInt(63 + n);
  let q = num / b.sig;
  const twice = (num - q * b.sig) * 2n;
  if (twice > b.sig || (twice === b.sig && (q & 1n))) q += 1n;
  let exp = -(63 + n) - b.exp;
  if (x87width(q) > 64) { q >>= 1n; exp += 1; }
  return { neg: b.neg, sig: q, exp };
};
// x87 FDIV of two loaded values: a NaN operand propagates quieted (the
// larger significand wins on a NaN pair), 0/0 and inf/inf produce the real
// indefinite, x/0 is a signed infinity and x/inf a signed zero.  A finite
// quotient keeps its correctly-rounded 64-bit significand — native 160
// truncates it through _ftol, where the extended precision is observable:
// INT_MAX / 4.665708e-10f truncates to low DWORD 0x843de10f while the
// 53-bit double quotient rounds up to give 0x843de200.
export const x87div = (a, b) => {
  if (a.nan !== undefined) return b.nan === undefined ? x87quiet(a) : x87nan(a, b);
  if (b.nan !== undefined) return x87quiet(b);
  const neg = a.neg ^ b.neg;
  if (a.inf || b.inf) {
    if (a.inf && b.inf) return { nan: X87_INDEFINITE };
    return a.inf ? { neg, inf: true } : { neg, sig: 0n, exp: 0 };
  }
  if (b.sig === 0n) return a.sig === 0n ? { nan: X87_INDEFINITE } : { neg, inf: true };
  if (a.sig === 0n) return { neg, sig: 0n, exp: 0 };
  // Shift the dividend up so the integer quotient carries ~96 bits, then
  // round the top 64 with the exact remainder: q = floor(num/den) and the
  // dropped fraction is low/2^shift + rem/(den*2^shift).
  const k = 96 + x87width(b.sig) - x87width(a.sig);
  const num = a.sig << BigInt(k);
  const q = num / b.sig, rem = num - q * b.sig;
  const shift = x87width(q) - 64;
  let sig = q >> BigInt(shift);
  const low = q - (sig << BigInt(shift));
  const lost2 = (low * b.sig + rem) * 2n, unit = b.sig << BigInt(shift);
  if (lost2 > unit || (lost2 === unit && (sig & 1n))) sig += 1n;
  let exp = a.exp - b.exp - k + shift;
  if (x87width(sig) > 64) { sig >>= 1n; exp += 1; }
  return { neg, sig, exp };
};
// The FST/FSTP float32 store: round the 64-bit significand to 24 bits with
// nearest-even, honoring denormal and overflow boundaries.
export const x87store = v => {
  if (v.nan !== undefined) return f32num(v.nan);
  if (v.inf) return f32num((v.neg << 31) | 0x7f800000);
  let e = v.exp + x87width(v.sig) - 1;
  if (e > 127) return f32num((v.neg << 31) | 0x7f800000);
  if (v.sig === 0n) return f32num(v.neg << 31);
  if (e >= -126) {
    const shift = v.exp + 23 - e;
    let sig;
    if (shift >= 0) sig = v.sig << BigInt(shift);
    else {
      const sh = BigInt(-shift);
      let q = v.sig >> sh;
      const rem = v.sig - (q << sh), half = 1n << (sh - 1n);
      if (rem > half || (rem === half && (q & 1n))) q += 1n;
      if (x87width(q) > 24) { q >>= 1n; if (++e > 127) return f32num((v.neg << 31) | 0x7f800000); }
      sig = q;
    }
    return f32num((v.neg << 31) | ((e + 127) << 23) | Number(sig - (1n << 23n)));
  }
  const shift = v.exp + 149;
  let q;
  if (shift >= 0) q = v.sig << BigInt(shift);
  else {
    const sh = BigInt(-shift);
    q = v.sig >> sh;
    const rem = v.sig - (q << sh), half = 1n << (sh - 1n);
    if (rem > half || (rem === half && (q & 1n))) q += 1n;
  }
  return f32num(q >= (1n << 23n) ? (v.neg << 31) | 0x800000 : (v.neg << 31) | Number(q));
};
// The FST/FSTL double store: round the 64-bit significand to 53 bits with
// nearest-even, keeping the value in the model (SafeNormal's fstl at
// 0x10144c04 is the only float64 store in the bound natives).
export const x87storeDouble = v => {
  if (v.nan !== undefined || v.inf || v.sig === 0n) return v;
  const [sig, sh] = x87round(v.sig, 53);
  return { neg: v.neg, sig, exp: v.exp + sh };
};
// Integer square root (floor) for the FSQRT model below.
const x87isqrt = n => {
  if (n < 2n) return n;
  let x = 1n << BigInt((x87width(n) + 1) >> 1);
  for (;;) { const y = (x + n / x) >> 1n; if (y >= x) return x; x = y; }
};
// x87 FSQRT of a nonnegative finite value: correctly-rounded 64-bit
// significand.  The CRT thunk 0x101032ba -> 0x10123290 executes it as
// `fld qword; fsqrt; ret` on the pushed double argument.
export const x87sqrt = v => {
  if (v.inf) return { neg: 0, inf: true };
  if (v.sig === 0n) return v;
  let sig = v.sig, exp = v.exp;
  if (exp & 1) { sig <<= 1n; exp -= 1; }
  const w = x87width(sig), sh = BigInt(w & 1 ? 127 - w : 128 - w);
  const n2 = sig << sh;
  let q = x87isqrt(n2);
  // Round the real root to nearest (a root is never exactly halfway):
  // q + 1 wins iff n2 - q*q > q.
  if (n2 - q * q > q) q += 1n;
  let e = exp / 2 - Number(sh) / 2;
  if (x87width(q) > 64) { q >>= 1n; e += 1; }
  return { neg: 0, sig: q, exp: e };
};
// The embedded double 1e-08 at 0x101765d8 that SafeNormal's FCOMP compares
// against: on less-than OR unordered (C0) the body returns exactly (0,0,0).
// The compare runs on the 80-bit register, not the stored double.
export const x87below1em8 = v => {
  if (v.nan !== undefined) return true;
  if (v.inf) return v.neg === 1;
  if (v.sig === 0n || v.neg) return true;
  const shift = v.exp + 79;
  return shift >= 0 ? (v.sig << BigInt(shift)) < 0x15798ee2308c3an
    : v.sig < (0x15798ee2308c3an << BigInt(-shift));
};
// FILD dword: the int32 rotator field becomes an exact 80-bit value
// (natives 287/288 load each component this way before FMUL).
export const x87int32 = v => (v |= 0, { neg: v < 0 ? 1 : 0, sig: BigInt(v < 0 ? -v : v), exp: 0 });
// The shipped MSVCRT _ftol (Core thunk 0x1016eec0 -> IAT 0x102ab4b8):
// FNSTCW -> set RC=truncate -> FISTP qword -> restore; the low DWORD is the
// result.  A NaN/infinity or a truncated value outside int64 range raises
// the invalid-operation exception, which stores the integer indefinite
// 0x8000000000000000 — whose low DWORD is 0.
export const x87ftol = v => {
  if (v.nan !== undefined || v.inf) return 0;
  let n = v.exp >= 0 ? v.sig << BigInt(v.exp) : v.sig >> BigInt(-v.exp);
  if (v.neg) n = -n;
  return n > 0x7fffffffffffffffn || n < -0x8000000000000000n ? 0
    : Number(BigInt.asIntN(32, n));
};
// FVector::SafeNormal (Core.dll 0x10144be0, thiscall reached through thunk
// 0x101031c0 by natives 226 and 300): the squared length is accumulated
// left-associatively in 80-bit — (x*x + y*y) + z*z — stored to a double by
// FSTL, and the 80-bit register value is FCOMP'd against the embedded
// 1e-08: below or unordered returns (0,0,0).  Otherwise the FDIVR
// reciprocal of the CRT sqrt of that double stays on the stack and each
// component multiplies into a float32 store.
export const x87safeNormal = v => {
  const x = x87load(v[0]), y = x87load(v[1]), z = x87load(v[2]);
  const s = x87add(x87add(x87mul(x, x), x87mul(y, y)), x87mul(z, z));
  if (s.nan !== undefined || x87below1em8(s)) return [0, 0, 0];
  const r = s.inf ? { neg: 0, sig: 0n, exp: 0 } : x87recip(x87sqrt(x87storeDouble(s)));
  return v.map(c => x87store(x87mul(x87load(c), r)));
};
// The embedded double 3.0 at 0x10177f90 (Smerp's cubic coefficient).
const x87three = { neg: 0, sig: 3n, exp: 0 };
// Vector/rotator operand shape: three number components (NaN and infinity
// included — they are float32 bit patterns the original loads too).
const isVec3 = v => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number');

/** Original bytecode execution with linked engine services.
 * Unsupported instructions/native indices fail, rather than being approximated. */
// x87 FSIN/FCOS/FPTAN/FPATAN as the Core thunks run them, measured on real
// silicon through Rosetta 2 rather than modelled (tools/x87-transcendental-probe.c;
// 1.4M+ sampled float32 bit patterns per function, see
// docs/script-string-transcendental.md):
//   * a NaN operand is quieted (bit 22 set) and keeps its sign and payload —
//     FCOS does NOT clear a negative NaN's sign;
//   * +-inf raises #IA on FSIN/FCOS/FPTAN and yields the QNaN indefinite,
//     while FPATAN legitimately returns +-pi/2;
//   * a finite |x| >= 2^63 is out of FSIN/FCOS range: C2 is set and the
//     operand passes through unchanged.  FPTAN also declines to push, so the
//     thunk's `fstp st(0)` empties the stack and the result store underflows
//     to the indefinite.  The boundary is inclusive: 2^63 itself passes through.
// Above X87_REDUCTION_LIMIT the FPU's 66-bit pi argument reduction diverges
// from the exactly-reduced libm result, so those inputs are refused rather
// than answered with a value the original would not produce.
const X87_REDUCTION_LIMIT = 2 ** 26;
const X87_TRANSCENDENTAL = {
  sin: { fn: Math.sin, overRange: 'passthrough' },
  cos: { fn: Math.cos, overRange: 'passthrough' },
  tan: { fn: Math.tan, overRange: 'indefinite' },
  atan: { fn: Math.atan, overRange: null },
};
function x87Transcendental(name, operand) {
  const { fn, overRange } = X87_TRANSCENDENTAL[name];
  const bits = f32bits(operand), magnitude = bits & 0x7fffffff;
  if (magnitude > 0x7f800000) return f32num((bits | 0x400000) >>> 0);
  if (magnitude === 0x7f800000)
    return overRange === null ? f(fn(f32num(bits))) : f32num(X87_INDEFINITE);
  const x = f32num(bits);
  if (overRange !== null && Math.abs(x) >= 2 ** 63)
    return overRange === 'passthrough' ? x : f32num(X87_INDEFINITE);
  if (overRange !== null && Math.abs(x) >= X87_REDUCTION_LIMIT)
    throw new Error(`Core ${name} operand ${x} is above the measured 2^26 bound `
      + "where the x87's 66-bit pi argument reduction diverges from Math." + name);
  return f(fn(x));
}

/** execSwitch's comparison: appMemcmp over the switch value's size, or
 * appStricmp of the two FStrings when that size is 0. Names are FName
 * indices, so equal names are the ASCII-folded equal spellings. */
function switchCaseEqual(key, value, size) {
  if (size === 0) return scriptStringComplementEqual(key, value);
  if (typeof key === 'number' && typeof value === 'number') return Object.is(key, value);
  if (typeof key === 'string' && typeof value === 'string') return scriptStringComplementEqual(key, value);
  if (typeof key === 'boolean' || typeof value === 'boolean') return Boolean(key) === Boolean(value);
  if (key === value) return true;
  if (key && value && typeof key === 'object' && typeof value === 'object' && !key.reference && !value.reference &&
      (Array.isArray(key) || Object.getPrototypeOf(key) === Object.prototype))
    throw new Error('EX_Switch over a struct value is not recovered');
  return false;
}

export function compileFunction(fn) {
  const decoded = decodeScript(fn), { statements } = decoded;
  for (const { node } of statements.values()) if ([0x06, 0x07].includes(node.op) && !statements.has(node.target)) throw new Error('Script jump is not an instruction boundary');
  for(const {node} of statements.values())if(node.op===0x2f&&statements.get(node.target)?.node.op!==0x30){
    throw new Error('Iterator target is not an IteratorPop instruction');
  }

  function native(index, args, receiver, services, frame) {
    if(moverPrimitiveIndices.has(index))return executeMoverPrimitive(index,args);
    if(decorationPrimitiveIndices.has(index))return executeDecorationPrimitive(index,args);
    const values = args.map(refValue), [a, b] = values;
    // The recovered natives 193/226/229/248/300 are bound only for calls
    // whose operand count and shapes match the declared Core signature; a
    // malformed call keeps the services.native fallback unbound indices use.
    const claimed =
      index===193 ? values.length===1 && typeof a==='number'
      : index===226 ? values.length===1 && isVec3(a)
      : index===229 ? values.length===4 && isVec3(a)
      : index===248 ? values.length===3 && values.every(v => typeof v==='number')
      : index===300 ? values.length===2 && isVec3(a) && isVec3(b)
      : index===173 ? values.length===2 && typeof a==='number' && typeof b==='number'
      : index===160 ? values.length===2 && typeof a==='number' && typeof b==='number'
      : index===237 ? values.length===1 && typeof a==='string'
      : [115,120,121].includes(index) ? values.length===2 && typeof a==='string' && typeof b==='string'
      : [188,189,190].includes(index) ? values.length===1 && typeof a==='number'
      : index===287 ? values.length===2 && isVec3(a) && typeof b==='number'
      : index===288 ? values.length===2 && typeof a==='number' && isVec3(b)
      : [142,203,276,297,317,318,319].includes(index) ? values.length===2 && isVec3(a) && isVec3(b)
      : true;
    if (!claimed) {
      if (services.native) return services.native({index,args,receiver,script:fn,frame});
      throw new Error(`VM does not support native ${index}`);
    }
    // Core.Object native declarations and original Engine.u CheckBob bytecode.
    switch (index) {
      case 112: return scriptConcat(a,b);
      case 168: return scriptAt(a,b);
      case 114: return a === b;
      case 119: return a !== b;
      case 122: return scriptStringEqual(a,b);
      case 123: return !scriptStringEqual(a,b);
      case 124: return scriptStringComplementEqual(a,b);
      // LessThan/LessEqual/GreaterEqual_StrStr (115/120/121): two FString
      // temporaries evaluate left-to-right; an operand whose ArrayNum is
      // zero is substituted with the runtime empty-string buffer at
      // 0x101ef654 (the pointer is not consulted), then appStrcmp — the
      // shipped MSVCRT wcscmp — compares unsigned UTF-16 code units
      // case-sensitively and the body stores setl/setle/setge on the signed
      // result.
      case 115: return scriptStringCompare(a,b)<0;
      case 120: return scriptStringCompare(a,b)<=0;
      case 121: return scriptStringCompare(a,b)>=0;
      case 125: return scriptLen(a);
      case 126: return scriptInStr(a,b);
      case 127: return scriptMid(a,b,values.length>2?values[2]:undefined);
      case 128: return scriptLeft(a,b);
      case 234: return scriptRight(a,b);
      case 129: return !a;
      case 146: return ((a | 0) + (b | 0)) | 0;
      case 147: return ((a | 0) - (b | 0)) | 0;
      // Core's Multiply_IntInt (144) evaluates both int32 operands into
      // temporaries, multiplies with the original signed 32-bit IMUL, and
      // stores the low DWORD in ReturnValue.
      case 144: return Math.imul(a | 0, b | 0);
      // Core's Divide_IntInt (145) evaluates signed dwords and uses the
      // original zero-divisor guard before x86 IDIV.  The one overflowing
      // signed pair (INT_MIN / -1) reaches the processor divide exception;
      // keep that reached exceptional path explicit instead of returning a
      // JavaScript Infinity or a guessed wrapped quotient.
      case 145: {
        const dividend=a|0, divisor=b|0;
        if(divisor===0)return 0;
        if(dividend===-0x80000000&&divisor===-1)
          throw new Error('Original Divide_IntInt signed overflow (x86 divide exception) is unsupported');
        return (Math.trunc(dividend/divisor))|0;
      }
      // Core's int bitwise operators evaluate the int32 operands into DWORD
      // temporaries and execute NOT (141), NEG (143), AND (156), XOR (157) or
      // OR (158); the shifts execute SHL (148), SAR (149) or SHR (196) with
      // the count masked to 5 bits (CL & 31), which is also the JavaScript
      // shift semantics.  196 stores the unsigned SHR result back as an int.
      case 141: return ~(a | 0);
      case 143: return (-(a | 0)) | 0;
      case 148: return (a | 0) << (b | 0);
      case 149: return (a | 0) >> (b | 0);
      case 156: return (a | 0) & (b | 0);
      case 157: return (a | 0) ^ (b | 0);
      case 158: return (a | 0) | (b | 0);
      case 196: return ((a | 0) >>> (b | 0)) | 0;
      // DivideEqual_IntFloat (160): the float32 divisor is FCOMP'd against
      // the embedded 0.0 at 0x101765c4 and C3 tested — an equal OR
      // unordered (NaN) divisor takes the path that loads the same 0.0,
      // runs _ftol and stores 0 to BOTH the out int and the result (the
      // previous value is NOT kept).  Otherwise FILD loads the int32 and
      // FDIV divides by the float32 divisor on the 80-bit stack before
      // _ftol truncates to int64 and stores the low DWORD.  The out
      // operand arrives through GPropAddr like every out native.
      case 160: {
        const divisor=x87load(b);
        const v=divisor.nan!==undefined||(!divisor.inf&&divisor.sig===0n)?0
          :x87ftol(x87div(x87int32(a),divisor));
        if(args[0]?.reference)assign(args[0],v);
        return v;
      }
      case 150: return (a | 0) < (b | 0);
      case 151: return (a | 0) > (b | 0);
      case 154: return (a | 0) === (b | 0);
      case 155: return (a | 0) !== (b | 0);
      // EqualEqual/NotEqual_RotatorRotator (142/203): three plain CMP dword
      // pairs on the pitch/yaw/roll words — == stores 1 only when all match,
      // != stores 0 only then.  Raw int32 words, no angle normalization.
      case 142: return a.every((v,i)=>(v|0)===(b[i]|0));
      case 203: return a.some((v,i)=>(v|0)!==(b[i]|0));
      // The int/byte out-parameter operators receive arg0 through the
      // original GPropAddr handoff: lvalue arguments mutate the variable,
      // anything else mutates a discarded stack temporary.  The byte
      // operators load and store single bytes (wrapping mod 256); the
      // preoperators return the NEW value while the postoperators write the
      // OLD value to the result before incrementing or decrementing.
      case 135: { const v=((a & 255) + (b & 255)) & 255; if(args[0]?.reference)assign(args[0], v); return v; }
      case 138: { const v=((a & 255) - 1) & 255; if(args[0]?.reference)assign(args[0], v); return v; }
      case 139: { const v=a & 255; if(args[0]?.reference)assign(args[0], (v + 1) & 255); return v; }
      case 140: { const v=a & 255; if(args[0]?.reference)assign(args[0], (v - 1) & 255); return v; }
      case 163: { const v=((a | 0) + 1) | 0; if(args[0]?.reference)assign(args[0], v); return v; }
      case 164: { const v=((a | 0) - 1) | 0; if(args[0]?.reference)assign(args[0], v); return v; }
      case 165: if(args[0]?.reference)assign(args[0], ((a | 0) + 1) | 0); return a | 0;
      case 171: return f(a * b);
      case 172: return f(a / b);
      // Percent_FloatFloat (173): both operands are stored float32, widened
      // to doubles and passed cdecl to the shipped MSVCRT _CIfmod — which
      // classifies the x87 operand pair and either runs its fxch/FPREM loop
      // or a domain-error/NaN action before the body stores one float32.
      // The CRT path (not raw FPREM) is authoritative: a zero or infinite
      // divisor and an infinite dividend are domain errors producing the
      // real x87 indefinite; a zero dividend or an exactly-zero remainder
      // produces +0 through the CRT path; a NaN operand propagates its
      // payload quieted (the larger significand wins on a NaN/NaN pair).
      // For finite nonzero operands the FPREM result equals the exact fmod,
      // which is always representable in float32, so the single store is
      // bit-exact.
      case 173: {
        const x=x87load(a),y=x87load(b);
        if(x.nan!==undefined)return x87store(y.nan===undefined?x87quiet(x):x87nan(x,y));
        if(y.nan!==undefined)return x87store(x87quiet(y));
        if(y.sig===0n||x.inf||y.inf)return x87store({nan:X87_INDEFINITE});
        const r=a%b;
        return f(r===0?0:r);
      }
      case 174: return f(a + b);
      case 175: return f(a - b);
      // Core's preoperator float - loads the operand as a float32 and uses
      // x87 FCHS before storing the float32 ReturnValue.
      case 169: return f(-f(a));
      case 176: return a < b;
      case 177: return a > b;
      case 179: return a >= b;
      // Core's fcomps handlers compare the float32 expression results. The
      // original tests C3 only: unordered (either operand NaN) is treated as
      // equal by native 180 and as not-not-equal by native 181.
      case 180: {
        const x=f(a), y=f(b);
        return Number.isNaN(x)||Number.isNaN(y)||x===y;
      }
      // Core's ComplementEqual_FloatFloat (210) evaluates both operands into
      // float32 temporaries, subtracts them in x87 precision, and tests the
      // absolute difference against the embedded double 0.0001.  The native
      // fcom path treats unordered (NaN) as below the threshold, so NaN is
      // deliberately accepted here just as it is by the original C0 test.
      case 210: {
        const x=f(a), y=f(b), difference=x-y;
        return Number.isNaN(difference)||Math.abs(difference)<0.0001;
      }
      case 181: {
        const x=f(a), y=f(b);
        return !(Number.isNaN(x)||Number.isNaN(y)||x===y);
      }
      case 182: return assign(args[0], f(a * b));
      case 184: return assign(args[0], f(a + b));
      // These three operators are used by DeusExPlayer.ClientFlash and the
      // preceding TakeDamage/DXReduceDamage path.  Core evaluates operands
      // left-to-right, loads each serialized float as float32, and stores
      // every result component as float32.  The first operand of 185/223 is
      // an out-lvalue and is therefore retained by primitiveOutNatives.
      case 185: return assign(args[0], f(f(a) - f(b)));
      // Sin (187)/Cos (188)/Tan (189)/Atan (190): each body widens the
      // float32 operand to a double and calls a Core thunk that runs the
      // bare x87 instruction — 0x10123240 fsin, 0x10123250 fcos,
      // 0x10123260 fptan (+fstp st(0) discarding the pushed 1.0),
      // 0x10123270 fld1+fpatan — then stores one float32.  The edge rules
      // below are MEASURED on real x87 silicon through Rosetta 2
      // (tools/x87-transcendental-probe.c, scripts/validate-x87-
      // transcendental-hardware.mjs); Unicorn's softfloat computes these
      // four instructions in host double precision and reports different
      // edges, so it is not the authority here.  See
      // docs/script-string-transcendental.md.
      case 187: return x87Transcendental('sin', a);
      case 188: return x87Transcendental('cos', a);
      case 189: return x87Transcendental('tan', a);
      case 190: return x87Transcendental('atan', a);
      // Core's float/vector operators: every operand evaluator stores its
      // result as float32, and each FST/FSTP in the bodies is where the
      // original rounds to float32 — anything still on the x87 stack keeps
      // the 64-bit extended significand until that store.
      // SubtractPre_Vector (211) applies x87 FCHS per component — a pure
      // sign-bit flip that preserves even sNaN payloads unquieted.
      case 211: return a.map(v => f32num(f32bits(v) ^ 0x80000000));
      // EqualEqual/NotEqual_VectorVector (217/218) FCOMP each float32
      // component and test only C3 (test ah,0x40): unordered operands — any
      // NaN — compare equal, and signed zeros compare equal.
      case 217: {
        const x=a.map(f),y=b.map(f);
        return x.every((v,i)=>Number.isNaN(v)||Number.isNaN(y[i])||v===y[i]);
      }
      case 218: {
        const x=a.map(f),y=b.map(f);
        return x.some((v,i)=>!Number.isNaN(v)&&!Number.isNaN(y[i])&&v!==y[i]);
      }
      // Dot (219): the three float32 products and both FADDP partial sums
      // stay on the x87 stack until the single FSTP result store, so the
      // accumulation rounds once at 64-bit precision — never at float32 —
      // before the store.  The original sums y*z first, then adds x:
      // px + (py + pz), proven by dot-order-cancel (the +1 dies inside
      // -2^200 + 1 at 64 bits, yielding 0 where left-association gives 1)
      // and dot-partial-extended (2^-55 survives where a double rounds to
      // 0).  FADDP ties hand the inner add to py and the outer add to px,
      // matching x87nan's first-operand preference on equal significands
      // (dot-nan-tie-inner / dot-nan-tie-outer).
      case 219: {
        const px=x87mul(x87load(a[0]),x87load(b[0]));
        const py=x87mul(x87load(a[1]),x87load(b[1]));
        const pz=x87mul(x87load(a[2]),x87load(b[2]));
        return x87store(x87add(px,x87add(py,pz)));
      }
      // The out-vector operators mutate their first operand through the
      // GPropAddr lvalue handoff; a non-lvalue first operand mutates the
      // discarded stack temporary instead and still returns the result.
      case 221: {
        const s=x87load(b),out=a.map(v=>x87store(x87mul(x87load(v),s)));
        if(args[0]?.reference)assign(args[0],out);
        return out;
      }
      // DivideEqual_VectorFloat (222) has no zero-divisor guard: it computes
      // the FDIVR reciprocal of the embedded double 1.0 in 80-bit, keeps it
      // on the stack, and multiplies each component — so /= 0 produces
      // signed infinities and the real indefinite NaN, and /= inf produces
      // signed zeros.  Verified by diveq-recip-extended and the divisor
      // sweep cases against the original body.
      case 222: {
        const d=x87load(b);
        const r=d.nan!==undefined?x87quiet(d):d.inf?{neg:d.neg,sig:0n,exp:0}
          :d.sig===0n?{neg:d.neg,inf:true}:x87recip(d);
        const out=a.map(v=>x87store(x87mul(x87load(v),r)));
        if(args[0]?.reference)assign(args[0],out);
        return out;
      }
      case 224: {
        const out=a.map((v,i)=>x87store(x87add(x87load(v),x87neg(x87load(b[i])))));
        if(args[0]?.reference)assign(args[0],out);
        return out;
      }
      // Normal (226): a thiscall to FVector::SafeNormal — see x87safeNormal
      // for the recovered 80-bit accumulation, the 1e-08 FCOMP boundary and
      // the reciprocal-multiply store sequence.
      case 226: return x87safeNormal(a);
      // GetAxes (229): void — the rotator argument evaluates normally while
      // X, Y and Z publish through GPropAddr (primitiveOutNatives keeps
      // argument positions 1-3 as references; a non-lvalue expression falls
      // back to the body's discarded stack temporary).  The recovered body
      // composes the quantized-sine roll/pitch/yaw matrices, which is
      // exactly the camera.mjs getAxes already proven bit-exact against the
      // original (docs/camera.md); it is reused, not reimplemented.
      case 229: {
        const axes=getAxes(a);
        for(let i=1;i<4;i++)if(args[i]?.reference)assign(args[i],axes[i-1]);
        return undefined;
      }
      // Smerp (248): A + (B-A)*(3*Alpha^2 - 2*Alpha^3).  FMULP (a*a),
      // FMUL m64 (the embedded double 3.0), FMUL st(2) (a*a*a), FADD
      // st0+st0, FSUBP, FSUB m32 (B-A), FMULP and FADD m32 keep every
      // intermediate on the 80-bit stack — the only rounding is the final
      // FSTP float32 store.
      case 248: {
        const al=x87load(a),aa=x87load(b),bb=x87load(values[2]);
        const p=x87mul(al,al),cube=x87mul(al,p);
        const s=x87add(x87mul(p,x87three),x87neg(x87add(cube,cube)));
        return x87store(x87add(x87mul(s,x87add(bb,x87neg(aa))),aa));
      }
      // Min (249) is a signed dword compare: A>B ? B : A.
      case 249: return Math.min(a|0,b|0);
      // Sqrt (193): the float32 operand is promoted to a double (exact) for
      // the CRT sqrt thunk — its x87 FSQRT keeps a 64-bit-significand root —
      // then a single FSTP stores float32.  By Figueroa's double-rounding
      // bound (64 >= 2*24+2) this is the correctly-rounded float32 root.
      // Negative nonzero operands produce the x87 real indefinite; a NaN
      // operand propagates quieted; -0 stays -0.
      case 193: {
        const d=x87load(a);
        return d.nan!==undefined?x87store(x87quiet(d))
          :d.neg&&(d.inf||d.sig!==0n)?x87store({nan:X87_INDEFINITE})
          :x87store(x87sqrt(d));
      }
      // Square (194): A loaded as float32, multiplied once in x87, a single
      // FSTP float32 store — including -0 -> +0 and NaN payload propagation.
      case 194: { const d=x87load(a); return x87store(x87mul(d,d)); }
      // Multiply_VectorVector (296): each component product stores to
      // float32 with its own FSTP — no cross-component accumulation.
      case 296: return a.map((v,i)=>x87store(x87mul(x87load(v),x87load(b[i]))));
      // MultiplyEqual_VectorVector (297): the first operand arrives through
      // the original GPropAddr handoff (an lvalue mutates its variable, a
      // non-lvalue mutates the discarded stack temporary); each component
      // FLDs the float32 second operand and FMULs the target in place, and
      // the three updated words copy to the return vector.  The body
      // computes arg1*st0 x arg0*mem per component — written in that order
      // though FMUL is commutative under the proven NaN-selection rules.
      case 297: {
        const out=a.map((v,i)=>x87store(x87mul(x87load(b[i]),x87load(v))));
        if(args[0]?.reference)assign(args[0],out);
        return out;
      }
      // MirrorVectorByNormal (300): V - 2*N'*(V.N') with N' = SafeNormal(N).
      // The 80-bit dot product stores once to float32 (FSTP) and that stored
      // value feeds all three product terms.  2N'.x stays on the stack;
      // 2N'.y/2N'.z and the y/z products each take an FSTP float32 store,
      // while only the x product remains in 80-bit through the closing FSUB.
      case 300: {
        const n=x87safeNormal(b);
        const nx=x87load(n[0]),ny=x87load(n[1]),nz=x87load(n[2]);
        const vx=x87load(a[0]),vy=x87load(a[1]),vz=x87load(a[2]);
        const twoX=x87add(nx,nx);
        const twoY=x87load(x87store(x87add(ny,ny))),twoZ=x87load(x87store(x87add(nz,nz)));
        const dot=x87load(x87store(x87add(x87add(x87mul(vy,ny),x87mul(vz,nz)),x87mul(vx,nx))));
        const prodX=x87mul(twoX,dot);
        const prodY=x87load(x87store(x87mul(twoY,dot))),prodZ=x87load(x87store(x87mul(twoZ,dot)));
        return [x87store(x87add(vx,x87neg(prodX))),x87store(x87add(vy,x87neg(prodY))),x87store(x87add(vz,x87neg(prodZ)))];
      }
      case 212: return a.map(v => f(f(v) * f(b)));
      case 213: return b.map(v => f(f(a) * f(v)));
      // Multiply_RotatorFloat (287) / Multiply_FloatRotator (288): each int32
      // component is FILD'd and FMUL'd against the float32 scalar — the
      // product stays on the x87 stack — then the shipped MSVCRT _ftol
      // (RC=truncate FISTP m64) returns the low DWORD.  The 80-bit product
      // matters: rot 0x7fffffff x 1.0000001f is exact-below-2147483903 at 64
      // bits (truncates to 2147483902) while a double product rounds up to
      // 2147483903.  Nonfinite scalars and int64 overflow produce the
      // integer indefinite, whose low DWORD is 0.
      case 287: {
        const s=x87load(b);
        return a.map(v=>x87ftol(x87mul(x87int32(v),s)));
      }
      case 288: {
        const s=x87load(a);
        return b.map(v=>x87ftol(x87mul(x87int32(v),s)));
      }
      case 215: return a.map((v,i) => f(v + b[i]));
      case 216: return a.map((v,i) => f(v - b[i]));
      case 223: return assign(args[0], a.map((v,i) => f(f(v) + f(b[i]))));
      case 235: return scriptCaps(a);
      case 236: return scriptChr(a);
      // Asc (237): the FString operand substitutes the runtime empty-string
      // buffer when its ArrayNum is zero (pointer not consulted), then the
      // result is the first UTF-16 code unit zero-extended (MOVZX word) —
      // an empty string reads the buffer's leading NUL and returns 0.
      case 237: {
        const text=scriptStringText(a);
        return text.length?text.charCodeAt(0):0;
      }
      // EqualEqual_BoolBool (242) / NotEqual_BoolBool (243): pure Core operators.
      case 242: return Boolean(a) === Boolean(b);
      case 243: return Boolean(a) !== Boolean(b);
      // XorXor_BoolBool (131): each dword operand is TEST/SETE'd (==0) and
      // the two flags XORed — logical inequality after zero-truth coercion;
      // any nonzero bit pattern is true.
      case 131: return Boolean(a) !== Boolean(b);
      case 244: return a > b ? b : a;
      case 245: return a >= b ? a : b;
      case 250: return Math.max(a | 0, b | 0);
      case 251: return (a | 0) < (b | 0) ? b | 0 : (a | 0) < (values[2] | 0) ? a | 0 : values[2] | 0;
      // Loaded FNames are represented by canonical case-insensitive spelling,
      // independently of each package's serialized name-table index.
      case 254: return String(a||'None').toLowerCase()===String(b||'None').toLowerCase();
      case 255: return String(a||'None').toLowerCase()!==String(b||'None').toLowerCase();
      case 316: return a.map((v,i) => ((v | 0) + (b[i] | 0)) | 0);
      // Subtract_RotatorRotator (317): three independent dword SUBs on the
      // pitch/yaw/roll words — int32 wrap, no angle normalization.
      case 317: return a.map((v,i)=>((v|0)-(b[i]|0))|0);
      // AddEqual/SubtractEqual_RotatorRotator (318/319): the first operand
      // arrives through the original GPropAddr handoff — an lvalue mutates
      // its variable in place, anything else mutates a discarded stack
      // temporary; the three updated words are copied to the return rotator.
      case 318: {
        const out=a.map((v,i)=>((v|0)+(b[i]|0))|0);
        if(args[0]?.reference)assign(args[0],out);
        return out;
      }
      case 319: {
        const out=a.map((v,i)=>((v|0)-(b[i]|0))|0);
        if(args[0]?.reference)assign(args[0],out);
        return out;
      }
      // Rotate_VectorRotator (276): the body builds each angle's
      // forward-rotation FCoords — yaw first, then pitch, then roll — and
      // accumulates M = M @ R_angleᵀ through the shared FCoords transform
      // (0x1011a710): every new row component is the x87 dot
      // (x*ax + y*ay) + z*az stored once to float32, and the origin row's
      // subtracted intermediates likewise stay on the stack.  The final
      // block dots V against M's three axes with the same shape.
      case 276: {
        const dot=(t,r)=>x87store(x87add(
          x87add(x87mul(t[0],x87load(r[0])),x87mul(t[1],x87load(r[1]))),
          x87mul(t[2],x87load(r[2]))));
        const [pitch,yaw,roll]=b.map(v=>v|0);
        const sy=rotatorSin(yaw),cy=rotatorSin((yaw+0x4000)|0);
        const sp=rotatorSin(pitch),cp=rotatorSin((pitch+0x4000)|0);
        const sr=rotatorSin(roll),cr=rotatorSin((roll+0x4000)|0);
        let m=[[0,0,0],[1,0,0],[0,1,0],[0,0,1]];
        for(const r of [[[0,0,0],[cy,sy,0],[-sy,cy,0],[0,0,1]],
          [[0,0,0],[cp,0,sp],[0,1,0],[-sp,0,cp]],
          [[0,0,0],[1,0,0],[0,cr,-sr],[0,sr,cr]]])
          m=m.map((v,i)=>{
            const t=i?v.map(x87load)
              :v.map((x,j)=>x87add(x87load(x),x87neg(x87load(r[0][j]))));
            return [dot(t,r[1]),dot(t,r[2]),dot(t,r[3])];
          });
        return [dot(a.map(x87load),m[1]),dot(a.map(x87load),m[2]),dot(a.map(x87load),m[3])];
      }
      default:
        if (services.native) return services.native({index,args,receiver,script:fn,frame});
        throw new Error(`VM does not support native ${index}`);
    }
  }
  const compiled = {
    name: fn.entry.path, size: fn.size, decoded,
    createFrame(instance, locals = {}, services = {}, { offset = 0, state = false } = {}) {
      const frame = { instance, locals, script: fn, cursor: offset, latent: 0, state, returned: false, result: undefined, iterators:[] };
      const call = (node, receiver) => {
        const target={kind:node.op===0x1c?'final':node.op===0x38?'global':'virtual',
          receiver,name:node.name,index:node.functionIndex,script:fn,node,frame};
        // CallFunction copies each evaluated argument before evaluating the next.
        // The linked runtime must retain control of that evaluation order.
        if(services.invoke)return services.invoke({...target,argumentCount:node.args.length,
          evaluateArgument:index=>evaluate(node.args[index],instance)});
        if (!services.call) throw new Error(`Script call is not linked: ${node.name ?? node.functionIndex}`);
        // Context changes receiver; arguments retain the caller FFrame.Object.
        const args = node.args.map(arg => evaluate(arg, instance));
        return services.call({...target,args});
      };
      const evaluate = (n, receiver = instance) => {
        switch (n.op) {
          case 'literal': return Array.isArray(n.value) ? n.value.slice() : n.value;
          case 'native': {
            if (n.index===130 || n.index===132) {
              const first=Boolean(refValue(evaluate(n.args[0],instance))),second=n.args[1];
              if(second?.op!==0x18)throw new Error('Original short-circuit call requires Skip');
              return n.index===130 ? first&&Boolean(refValue(evaluate(second.value,instance)))
                : first||Boolean(refValue(evaluate(second.value,instance)));
            }
            if(!primitiveNatives.has(n.index)&&services.invokeNative)return services.invokeNative({index:n.index,receiver,script:fn,frame,
              argumentCount:n.args.length,evaluateArgument:index=>evaluate(n.args[index],instance)});
            const args=n.args.map((arg,index)=>{
              const result=evaluate(arg,instance);
              if(!primitiveNatives.has(n.index)||primitiveOutNatives.get(n.index)?.has(index))return result;
              const value=refValue(result);return Array.isArray(value)?value.slice():value;
            });
            return native(n.index,args,receiver,services,frame);
          }
          case 0x00: return services.localReference?.(locals,fn,n) ?? reference(locals, n.name);
          case 0x01: return services.fieldReference?.(receiver,fn,n) ?? reference(receiver,n.name);
          case 0x02:
            if(!services.defaultReference)throw new Error('Default property is not linked');
            return services.defaultReference(receiver,fn,n);
          case 0x0e:
            // Core execEatString 1013a920: Step one expression against the
            // current object into a zeroed local FString, then destroy it.
            evaluate(n.value,receiver);
            return undefined;
          case 0x09:
            // Core execAssert 1012fcc0 reads a uint16 source line, evaluates
            // one bool, then reports NAME_Critical on zero (1012fcf9).
            if(!refValue(evaluate(n.value,instance)))
              throw new Error(`Script assertion failed: ${fn.entry.path}, line ${n.target}`);
            return undefined;
          case 0x0f: return assign(evaluate(n.left), refValue(evaluate(n.right)));
          case 0x14: return assign(evaluate(n.left),Boolean(refValue(evaluate(n.right))));
          case 0x17: return instance;
          case 0x12: case 0x19: {
            // execClassContext (0x1012edb0) shares execContext's null/skip
            // contract: a null context logs 'Accessed None', skips the value
            // bytes and zeroes valueSize of result; a non-null context
            // evaluates the value expression against it (a class for 0x12 —
            // `SomeClass.default.Member` resolves Default on that class).
            const context=refValue(evaluate(n.context,receiver));
            if(context!==null && context!==undefined)return evaluate(n.value,context);
            services.warning?.({type:'Accessed None',script:fn.entry.path,offset:n.offset});
            if(!n.valueSize)return undefined;
            if(!services.zeroContextResult)throw new Error('Null context requires linked result type');
            return services.zeroContextResult(fn,n.value,n.valueSize);
          }
          case 0x1b: case 0x1c: case 0x38:return call(n,receiver);
          case 0x1a:
            if(!services.arrayReference)throw new Error('Array property is not linked');
            return services.arrayReference(refValue(evaluate(n.left,instance)),evaluate(n.right,receiver),fn,n);
          case 0x20:
            if(!n.objectIndex)return null;
            if(!services.objectReference)throw new Error('Object constant is not linked');
            return services.objectReference(fn,n.objectIndex,n);
          case 0x21:return n.name;
          case 0x13: case 0x2e: {
            // SerializeExpr stores the target object before the child.  The
            // native handlers then evaluate that child against the current
            // FFrame.Object and pass its resulting UObject to the cast test.
            if(typeof services.objectReference!=='function')throw new Error('Object cast target is not linked');
            if(typeof services.castObject!=='function')throw new Error('Object cast is not linked');
            const target=services.objectReference(fn,n.fieldIndex,n);
            const object=refValue(evaluate(n.value,instance));
            return services.castObject(object,target,n.op===0x13?'meta':'dynamic');
          }
          case 0x2d:{
            const field=evaluate(n.value,receiver);
            if(!field?.reference)throw new Error('BoolVariable requires a property');
            return {reference:true,get:()=>Boolean(refValue(field)),set:value=>assign(field,Boolean(value))};
          }
          case 0x39: return rotatorToVector(refValue(evaluate(n.value,instance)));
          case 0x3a: return refValue(evaluate(n.value)) & 255;
          case 0x3c: return f(refValue(evaluate(n.value)) & 255);
          case 0x3d: return refValue(evaluate(n.value)) & 255;
          case 0x3f: return f(refValue(evaluate(n.value)) | 0);
          case 0x43: {
            // execFloatToByte 10131aa0: float32 local -> _ftol -> store AL.
            const value = f(refValue(evaluate(n.value)));
            if (!Number.isFinite(value) || value < -(2 ** 63) || value >= 2 ** 63)
              throw new Error('Original FloatToByte _ftol nonfinite/overflow conversion is not implemented');
            return Math.trunc(value) & 255;
          }
          case 0x44: {
            // Core10131b40: float32 local -> _ftol -> store low DWORD.
            const value=f(refValue(evaluate(n.value)));
            if(!Number.isFinite(value)||value<-(2**63)||value>=2**63)
              throw new Error('Original FloatToInt _ftol nonfinite/overflow conversion is not implemented');
            return Math.trunc(value)|0;
          }
          case 0x50: return vectorToRotator(refValue(evaluate(n.value,instance)));
          // Core execIntToString 10131600: evaluate one signed DWORD,
          // FString::Printf with the UTF-16 "%i" constant at 101aaf70.
          case 0x53: return String(refValue(evaluate(n.value,instance)) | 0);
          // Core execFloatToString 10131ca0: Printf("%f", (double)F).
          case 0x55: return scriptFloatToString(refValue(evaluate(n.value,instance)));
          case 0x56: return scriptObjectToString(refValue(evaluate(n.value,instance)));
          case 0x57: return scriptNameToString(refValue(evaluate(n.value,instance)));
          case 0x36: {
            const field=evaluate(n.value,receiver);
            if(services.structReference)return services.structReference(field,fn,n);
            const value=refValue(field);return reference(value,Array.isArray(value)?{X:0,Y:1,Z:2,Pitch:0,Yaw:1,Roll:2}[n.name]:n.name);
          }
          case 0x0b: return undefined;
          case 0x11: {
            // CreateNanoKeyInfo: new(Self) class'NanoKeyInfo'. Four operands
            // are outer, optional name, optional flags, class. EX_Nothing
            // leaves the P_GET defaults (NAME_None, flags 0).
            if (typeof services.newObject !== 'function') throw new Error('new is not linked');
            const outer = refValue(evaluate(n.args[0], instance));
            const nameNode = n.args[1], flagsNode = n.args[2];
            const name = nameNode.op === 0x0b ? 'None' : refValue(evaluate(nameNode, instance));
            const flags = flagsNode.op === 0x0b ? 0 : refValue(evaluate(flagsNode, instance));
            const classRef = refValue(evaluate(n.args[3], instance));
            return services.newObject({ outer, name, flags, classRef });
          }
          case 0x0d: {
            // EX_GotoLabel: redirect the state frame's Code to the label
            // offset resolved through the current state chain.
            if(!frame.state)throw new Error('GotoLabel requires a state frame');
            if(!services.gotoLabel)throw new Error('GotoLabel service is not linked');
            services.gotoLabel(instance,refValue(evaluate(n.value,instance)));
            return undefined;
          }
          default: throw new Error(`VM expression opcode 0x${n.op.toString(16)} is not supported`);
        }
      };
      frame.resume = () => {
        // Host runaway guard; HUDMultiSkills.RefreshKey visits all 255 input keys.
        let budget = 16384;
        // A native iterator owns its body loop until Next/Pop, including when
        // a body statement changes the actor's latent action.
        while (frame.cursor !== null && (!frame.latent||frame.iterators.length) && !frame.returned) {
          if (!budget--) throw new Error(`VM instruction budget exceeded in ${fn.name??fn.objectName??'script'}`);
          const entry = statements.get(frame.cursor); if (!entry) throw new Error('VM instruction pointer outside script');
          const n = entry.node;
          // Native state calls may replace Code. Advance before dispatch so a
          // GotoLabel or Stop during the statement is not overwritten afterward.
          frame.cursor = entry.next;
          if(n.op===0x2f){
            if(!services.iterator)throw new Error('Original iterator native is not linked');
            // The foreach operand is either a direct native iterator (AllActors,
            // ...) or one called in a context (execContext, e.g.
            // FrobTarget.BasedActors). execContext changes the iterator native's
            // Object to the context; the argument expressions still evaluate in
            // the caller's frame. Its null contract also applies: a null context
            // logs Accessed None and runs zero iterations.
            const after=statements.get(n.target).next;
            let call=n.value,receiver=instance,skipped=false;
            if(call.op===0x19){
              const context=refValue(evaluate(call.context,instance));
              if(context===null||context===undefined){
                services.warning?.({type:'Accessed None',script:fn.entry.path,offset:call.offset});
                frame.cursor=after;skipped=true;
              }else{receiver=context;call=call.value;}
            }
            if(!skipped){
              if(call.op!=='native')throw new Error('Original iterator native is not linked');
              const iterator=services.iterator({index:call.index,receiver,script:fn,frame,
                argumentCount:call.args.length,evaluateArgument:index=>evaluate(call.args[index],instance)});
              const continuation={iterator,body:entry.next,after};
              if(iterator.next())frame.iterators.push(continuation);
              else frame.cursor=continuation.after;
            }
          }else if(n.op===0x31){
            const current=frame.iterators.at(-1);
            if(!current)throw new Error('IteratorNext without an active iterator');
            if(current.iterator.next())frame.cursor=current.body;
            else{frame.iterators.pop();frame.cursor=current.after;}
          }else if(n.op===0x30){
            if(!frame.iterators.pop())throw new Error('IteratorPop without an active iterator');
          }else if (n.op === 0x04) {
            if(frame.iterators.length)throw new Error('Return requires compiled iterator unwind');
            frame.result=refValue(evaluate(n.value));frame.returned=true;frame.cursor=null;
          }
          else if (n.op === 0x08) {
            if(!frame.state)throw new Error('Stop requires a state frame');
            frame.cursor=null;
          } else if (n.op === 0x05) {
            // Core execSwitch (0x1012f850) owns the case scan: evaluate the
            // switch value, then walk the EX_Case chain. A 0xffff case (default
            // or the terminator) or a matching value enters the code after that
            // case; a mismatch continues at the case's next-case offset.
            const key = refValue(evaluate(n.value));
            for (let at = entry.next;;) {
              const header = statements.get(at);
              if (!header || header.node.op !== 0x0a) throw new Error('EX_Switch requires its EX_Case chain');
              if (header.node.target === 0xffff) { frame.cursor = header.next; break; }
              if (switchCaseEqual(key, refValue(evaluate(header.node.value)), n.valueSize)) { frame.cursor = header.next; break; }
              at = header.node.target;
            }
          } else if (n.op === 0x0a) {
            // Core execCase (0x1012fa20) is reached only by falling into a
            // case: it steps over its expression, so stacked labels and case
            // bodies without a break fall through.
            if (n.target !== 0xffff) evaluate(n.value);
          } else if (n.op === 0x06 || n.op === 0x07 && !refValue(evaluate(n.value))) frame.cursor = n.target;
          else if (n.op !== 0x07) evaluate(n);
        }
        return frame.result;
      };
      return frame;
    },
    run(instance, locals = {}, services = {}) { return compiled.createFrame(instance,locals,services).resume(); },
  };
  return compiled;
}
