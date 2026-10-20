/**
 * The x87 comparisons FindSpot, AdjustSpot and PointCheck branch on, measured on
 * REAL x87 silicon, against the helpers Play's translations use
 * (src/runtime/x87-nan.mjs x87C0 / x87C0C3 / x87CompareFlags).
 *
 * Engine's code compares with FCOM/FCOMP/FCOMPP and reads the status word with
 * `fnstsw ax; test ah, mask`: AdjustSpot's `Hit.Time < 1` is C0 (0x103983b3-
 * 0x103983c1), FindSpot's displacement test C0 (0x1039896f-0x1039897c), the
 * PointCheck traversal's front/back tests C0 and C0 | C3 (0x103f1b30-0x103f1bc6).
 * An unordered pair (a NaN) sets C3, C2 and C0, which JavaScript's `<` does not
 * model. The probe (tools/x87-compare-probe.c) runs the three instruction forms
 * over finite values, zeros, infinities and NaNs of both signs and payloads, and
 * FISTP of the same values with every exception masked (the hash cells' integer
 * indefinite, 0x10359223: NaN, infinities and out-of-range values store INT_MIN).
 * Every row is compared bit for bit with the helpers.
 *
 * Skips loudly (exit 0) when the toolchain or Wine is absent: this is a
 * hardware measurement, not a pure-software check.
 */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { x87C0, x87C0C3, x87CompareFlags } from '../src/runtime/x87-nan.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wine = process.env.X87_PROBE_WINE
  || (existsSync('/usr/bin/wine') ? '/usr/bin/wine' : '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine');
const bottle = process.env.X87_PROBE_BOTTLE || 'DeusEx';
const cc = process.env.X87_PROBE_CC || 'i686-w64-mingw32-gcc';

const skip = reason => { console.log(`SKIP validate-x87-compare-hardware: ${reason}`); process.exit(0); };
if (!existsSync(wine)) skip(`no CrossOver/Wine at ${wine} (set X87_PROBE_WINE)`);
try { execFileSync('which', [cc], { stdio: 'ignore' }); }
catch { skip(`no ${cc} on PATH (brew install mingw-w64)`); }

const exe = path.join(root, '.cache', 'x87-compare-probe.exe');
mkdirSync(path.join(root, '.cache'), { recursive: true });
execFileSync(cc, ['-O1', '-o', exe, path.join(root, 'tools', 'x87-compare-probe.c')]);
const csv = execFileSync(wine, [exe],
  { env: { ...process.env, CX_BOTTLE: bottle, WINEDEBUG: '-all' }, maxBuffer: 1 << 26, encoding: 'utf8' });

const io = new DataView(new ArrayBuffer(4));
const numOf = b => (io.setUint32(0, b >>> 0, true), io.getFloat32(0, true));
// FISTP to int32 in round-to-nearest-even; the masked invalid result is the integer indefinite.
const toInt = v => {
  if (!Number.isFinite(v) || v >= 2 ** 31 || v < -(2 ** 31)) return 0x80000000;
  const floor = Math.floor(v), diff = v - floor;
  return (diff < .5 ? floor : diff > .5 ? floor + 1 : floor + (floor % 2 !== 0 ? 1 : 0)) >>> 0;
};
let rows = 0, unordered = 0, indefinite = 0, cw = null;
for (const line of csv.split(/\r?\n/)) {
  if (!line) continue;
  if (line.startsWith('#cw=')) { cw = line.slice(4); continue; }
  const [op, aHex, bHex, rHex] = line.split(','), a = numOf(parseInt(aHex, 16)), b = numOf(parseInt(bHex, 16)), got = parseInt(rHex, 16) >>> 0;
  if (op === '3') {
    assert.strictEqual(got, toInt(a), `FISTP ${aHex}: probe ${rHex}, expected ${toInt(a).toString(16)}`);
    if (got === 0x80000000) indefinite++;
  } else {
    // FCOM: st0 = a against the source b; AH's bits C0 0x01, C2 0x04, C3 0x40.
    const flags = (x87CompareFlags(a, b) >> 8) & 0x45;
    assert.strictEqual(got, flags, `op ${op} ${aHex} ? ${bHex}: probe ${rHex}, model ${flags.toString(16)}`);
    assert.strictEqual(Boolean(got & 1), x87C0(a, b), `C0 of ${aHex} ? ${bHex}`);
    assert.strictEqual(Boolean(got & 0x41), x87C0C3(a, b), `C0|C3 of ${aHex} ? ${bHex}`);
    if (a !== a || b !== b) { unordered++; assert.strictEqual(got, 0x45, 'an unordered pair sets C3, C2 and C0'); }
  }
  rows++;
}
assert.ok(rows > 1000 && unordered > 100 && indefinite > 5, 'the probe covered the NaN rows');
console.log(`PASS validate-x87-compare-hardware: ${rows} rows (${unordered} unordered, ${indefinite} FISTP indefinite), control word ${cw}, all equal to the helpers`);
