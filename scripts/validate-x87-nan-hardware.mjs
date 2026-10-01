/**
 * Validate the x87 NaN rules both script VMs apply (src/runtime/x87-nan.mjs,
 * native/script-vm/src/interp.rs x87_nan) against REAL x87 silicon.
 *
 * Core's float operator bodies FLD a float32, apply one FMUL/FDIV/FADD/FSUB
 * (m32, or FMULP/FADDP between registers) and FSTP the float32 result
 * (docs/script-float-vector-operators.md). JavaScript and Rust compute the
 * value with doubles and replace a NaN result with the x87's: the indefinite
 * 0xFFC00000 for an invalid operation, the larger significand of a NaN pair,
 * the positive NaN on a tie. This validator builds tools/x87-nan-probe.c, runs
 * it under Wine/CrossOver so the instructions execute on the real FPU (through
 * Rosetta 2 on the Mac), and compares every row bit-exactly with the helpers
 * the JavaScript VM calls; scripts/validate-script-vm-interp.mjs compares Rust
 * with those helpers.
 *
 * Skips loudly (exit 0) when the toolchain or Wine is absent: this is a
 * hardware measurement, not a pure-software check.
 */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { x87mul32, x87div32, x87add32, x87sub32 } from '../src/runtime/x87-nan.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wine = process.env.X87_PROBE_WINE
  || '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine';
const bottle = process.env.X87_PROBE_BOTTLE || 'DeusEx';
const cc = process.env.X87_PROBE_CC || 'i686-w64-mingw32-gcc';

const skip = reason => {
  console.log(`SKIP validate-x87-nan-hardware: ${reason}`);
  process.exit(0);
};
if (!existsSync(wine)) skip(`no CrossOver/Wine at ${wine} (set X87_PROBE_WINE)`);
try { execFileSync('which', [cc], { stdio: 'ignore' }); }
catch { skip(`no ${cc} on PATH (brew install mingw-w64)`); }

const exe = path.join(root, '.cache', 'x87-nan-probe.exe');
mkdirSync(path.join(root, '.cache'), { recursive: true });
execFileSync(cc, ['-O1', '-o', exe, path.join(root, 'tools', 'x87-nan-probe.c')]);
const csv = execFileSync(wine, [exe],
  { env: { ...process.env, CX_BOTTLE: bottle, WINEDEBUG: '-all' }, maxBuffer: 1 << 26, encoding: 'utf8' });

const io = new DataView(new ArrayBuffer(4));
const bitsOf = v => (io.setFloat32(0, Math.fround(v), true), io.getUint32(0, true));
const numOf = b => (io.setUint32(0, b >>> 0, true), io.getFloat32(0, true));
// FLD m32 a, F<op> m32 b: st0 = a op b. FLD b, FLD a, F<op>P: st(1) op st0
// for the commutative forms.
const OPS = { fmul: x87mul32, fdiv: x87div32, fadd: x87add32, fsub: x87sub32, fmulp: x87mul32, faddp: x87add32 };
const isNaN32 = b => (b & 0x7fffffff) > 0x7f800000;

let rows = 0, nanRows = 0, invalid = 0, pairs = 0, ties = 0, cw = null;
for (const line of csv.split(/\r?\n/)) {
  if (!line) continue;
  if (line.startsWith('#cw=')) { cw = line.slice(4); continue; }
  const [op, aHex, bHex, rHex] = line.split(',');
  const a = parseInt(aHex, 16) >>> 0, b = parseInt(bHex, 16) >>> 0, expected = parseInt(rHex, 16) >>> 0;
  const fn = OPS[op];
  assert.ok(fn, `unknown probe op ${op}`);
  const actual = bitsOf(fn(numOf(a), numOf(b)));
  assert.equal(actual.toString(16), expected.toString(16), `${op} ${aHex} ${bHex}`);
  rows++;
  if (isNaN32(expected)) {
    nanRows++;
    if (!isNaN32(a) && !isNaN32(b)) invalid++;
    else if (isNaN32(a) && isNaN32(b)) {
      pairs++;
      if ((a & 0x7fffff) === (b & 0x7fffff) && a !== b) ties++;
    }
  }
}
assert.equal(cw, '037f', 'the probe runs with the default x87 control word');
// The grid's 30 invalid operations: 8 inf*0 sign/order pairs per multiply form,
// 2 inf + -inf per add form, 2 inf - inf, 4 0/0 and 4 inf/inf.
assert.ok(rows > 5000 && invalid === 30 && pairs > 1000 && ties > 300, 'the probe covers invalid operations, NaN pairs and ties');
console.log(`x87 NaN rules match real x87 silicon on ${rows} rows (cw ${cw}): ${nanRows} NaN results, ${invalid} invalid operations, ${pairs} NaN pairs, ${ties} opposite-sign ties.`);
