/** x87 NaN results for float arithmetic computed with JavaScript doubles.
 *
 * Core's float operator bodies (Multiply_FloatFloat 0x10134e80 and the rest
 * in docs/script-float-vector-operators.md) FLD a float32, apply one x87
 * FMUL/FDIV/FADD/FSUB and FSTP the float32 result. JavaScript's double
 * arithmetic followed by Math.fround gives the same value, except when the
 * result is a NaN: then the host FPU picks the bits (and V8's tier picks the
 * operand order). The x87 rules, measured on the original bodies
 * (scripts/native-float-vector-operators-oracle.py) and on AMD x87 silicon:
 *
 * - a lone NaN operand propagates, quieted;
 * - a NaN pair keeps the larger float32 significand, the positive NaN on a
 *   tie, quieted (the rule is symmetric, so operand order does not matter);
 * - an invalid operation on non-NaN operands (inf - inf, 0 * inf, 0 / 0,
 *   inf / inf) stores the real indefinite 0xFFC00000. JavaScript gives the
 *   host's default NaN instead: 0x7FC00000 on arm64, 0xFFC00000 on x86.
 *
 * An undefined operand computes as JavaScript's NaN (0x7FC00000).
 * Signaling NaNs never reach these helpers: a float32 load quiets them. */

const f = Math.fround;
const io = new DataView(new ArrayBuffer(4));
const bitsOf = v => (io.setFloat32(0, f(v), true), io.getUint32(0, true));
const numberOf = b => (io.setUint32(0, b >>> 0, true), io.getFloat32(0, true));

export const X87_INDEFINITE = 0xffc00000;

/** The float32 NaN (as a JavaScript number) the x87 stores for a NaN result
 * of `a op b`. */
export const x87nanOf = (a, b) => {
  const x = bitsOf(a), y = bitsOf(b);
  const xNaN = (x & 0x7fffffff) > 0x7f800000, yNaN = (y & 0x7fffffff) > 0x7f800000;
  if (!xNaN && !yNaN) return numberOf(X87_INDEFINITE);
  const xs = x & 0x7fffff, ys = y & 0x7fffff;
  const keep = !yNaN || (xNaN && (xs > ys || (xs === ys && !(x >>> 31)))) ? x : y;
  return numberOf(keep | 0x400000);
};

/** `f(a op b)` with the x87 NaN result. */
export const x87mul32 = (a, b) => { const r = a * b; return r === r ? f(r) : x87nanOf(a, b); };
export const x87div32 = (a, b) => { const r = a / b; return r === r ? f(r) : x87nanOf(a, b); };
export const x87add32 = (a, b) => { const r = a + b; return r === r ? f(r) : x87nanOf(a, b); };
export const x87sub32 = (a, b) => { const r = a - b; return r === r ? f(r) : x87nanOf(a, b); };

/** `a op b` in doubles, an intermediate the original keeps on the x87
 * stack, with the x87 NaN result (as a float32 NaN, which is how the x87's
 * NaN payload reaches the float32 store). */
export const x87mul = (a, b) => { const r = a * b; return r === r ? r : x87nanOf(a, b); };
export const x87div = (a, b) => { const r = a / b; return r === r ? r : x87nanOf(a, b); };
export const x87add = (a, b) => { const r = a + b; return r === r ? r : x87nanOf(a, b); };
export const x87sub = (a, b) => { const r = a - b; return r === r ? r : x87nanOf(a, b); };

// ---- Comparisons ----------------------------------------------------------
// FCOM/FCOMP/FCOMPP of st0 against a source set the condition codes C0 (st0 <
// src), C3 (equal) and C2 (unordered); an unordered pair (a NaN) sets all
// three. The compiled branches read them with `fnstsw ax; test ah, mask`:
// mask 1 is C0, mask 0x41 is C0 | C3 (hardware rows: tools/x87-compare-probe.c,
// scripts/validate-x87-compare-hardware.mjs). JavaScript's comparisons are false
// for a NaN; these are the branches the DLL takes (the same for any ordered pair).
/** `test ah, 1` after FCOM(P) st0 = a against b: a < b, or unordered. */
export const x87C0 = (a, b) => a < b || a !== a || b !== b;
/** `test ah, 0x41`: a <= b, or unordered. */
export const x87C0C3 = (a, b) => a <= b || a !== a || b !== b;
/** The FCOM condition codes as the status word's C3 (0x4000), C2 (0x400) and C0 (0x100) bits. */
export const x87CompareFlags = (a, b) => {
  if (a !== a || b !== b) return 0x4500;
  return a < b ? 0x0100 : a === b ? 0x4000 : 0;
};
