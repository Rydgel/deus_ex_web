// Render-pass precision audit helper (docs/render-pass-precision.md).
//
// URender::PreRender sets x87 precision control 24 (control word 0x007f)
// until PostRender; most render-pass oracles ran at 0x037f. A validator that
// supports the audit reads ORACLE_CW (for example ORACLE_CW=0x007f), passes
// it to its oracle for the render-pass segments (the light-manager tables
// stay at their init control word), and checks through `auditAssert()`.
// Without ORACLE_CW the checks are node:assert/strict, unchanged. With it,
// failing checks are counted instead of thrown, and `report()` prints, per
// check label (digits folded), how many checks failed and, for numeric
// arrays, how many elements differ and by how much.
import strictAssert from 'node:assert/strict';

/** The control word requested for the render-pass segments, or null. */
export function auditControlWord() {
  const value = process.env.ORACLE_CW;
  return value ? value : null;
}

const io = new DataView(new ArrayBuffer(8));
const f32Bits = v => (io.setFloat32(0, v, true), io.getUint32(0, true));

function elementDiffs(actual, expected) {
  const a = [...actual], e = [...expected];
  let count = Math.abs(a.length - e.length), maxAbs = 0;
  for (let i = 0; i < Math.min(a.length, e.length); i++) {
    const x = a[i], y = e[i];
    if (Object.is(x, y) || JSON.stringify(x) === JSON.stringify(y)) continue;
    count++;
    if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x - y)) maxAbs = Math.max(maxAbs, Math.abs(x - y));
  }
  return { count, maxAbs, length: e.length };
}

/** An assert-like object: node:assert/strict when the audit is off. */
export function auditAssert(enabled = auditControlWord() !== null) {
  if (!enabled) return Object.assign((value, message) => strictAssert.ok(value, message), strictAssert, { report() {}, enabled: false });
  const labels = new Map();
  let checks = 0;
  const key = message => String(message ?? '(no message)').replace(/-?\d+(\.\d+)?/g, '#');
  const record = (message, detail) => {
    const k = key(message), entry = labels.get(k) ?? { failed: 0, elements: 0, of: 0, maxAbs: 0, example: null };
    entry.failed++;
    if (detail) { entry.elements += detail.count; entry.of += detail.length; entry.maxAbs = Math.max(entry.maxAbs, detail.maxAbs); }
    entry.example ??= String(message);
    labels.set(k, entry);
  };
  const soft = (run, message, detail) => {
    checks++;
    try { run(); } catch (error) { if (error.code !== 'ERR_ASSERTION') throw error; record(message, detail?.()); return false; }
    return true;
  };
  const m = message => (message === undefined ? [] : [message]);
  const audit = (value, message) => soft(() => strictAssert.ok(value, ...m(message)), message);
  // Every other node:assert/strict method, softened the same way.
  for (const name of Object.keys(strictAssert)) {
    if (typeof strictAssert[name] !== 'function' || name === 'AssertionError' || name === 'strict') continue;
    audit[name] = (...args) => soft(() => strictAssert[name](...args), name === 'fail' ? args[0] : args.at(-1));
  }
  return Object.assign(audit, {
    enabled: true,
    ok: (value, message) => soft(() => strictAssert.ok(value, ...m(message)), message),
    equal: (a, e, message) => soft(() => strictAssert.equal(a, e, ...m(message)), message),
    notEqual: (a, e, message) => soft(() => strictAssert.notEqual(a, e, ...m(message)), message),
    deepEqual: (a, e, message) => soft(() => strictAssert.deepEqual(a, e, ...m(message)), message,
      () => (a && e && typeof a === 'object' && typeof e === 'object' && Symbol.iterator in Object(a) && Symbol.iterator in Object(e)
        ? elementDiffs(a, e) : null)),
    deepStrictEqual: (a, e, message) => soft(() => strictAssert.deepStrictEqual(a, e, ...m(message)), message),
    strictEqual: (a, e, message) => soft(() => strictAssert.strictEqual(a, e, ...m(message)), message),
    /** Adds `n` differing elements of `of` to a named tally. */
    tally(label, n, of = 0, maxAbs = 0) {
      const k = `tally: ${key(label)}`, entry = labels.get(k) ?? { cases: 0, differing: 0, of: 0, maxAbs: 0 };
      entry.cases++; entry.differing += n; entry.of += of; entry.maxAbs = Math.max(entry.maxAbs, maxAbs);
      labels.set(k, entry);
    },
    report(title = 'precision audit') {
      const failures = [...labels].filter(([k]) => !k.startsWith('tally: '));
      const out = { title, controlWord: auditControlWord(), checks, failedChecks: failures.reduce((n, [, v]) => n + v.failed, 0),
        labels: Object.fromEntries(labels) };
      console.log(JSON.stringify(out, null, 1));
      return out;
    },
  });
}

/** Units in the last place between two float32 values (by bit pattern). */
export function f32Ulps(a, b) {
  const x = f32Bits(a), y = f32Bits(b);
  const ordered = w => (w & 0x80000000 ? 0x80000000 - (w & 0x7fffffff) : 0x80000000 + w);
  return Math.abs(ordered(x) - ordered(y));
}
