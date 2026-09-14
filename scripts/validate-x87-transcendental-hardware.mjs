/**
 * Validate the VM's Core Sin/Cos/Tan/Atan (187-190) against REAL x87 silicon.
 *
 * The Unicorn oracle behind scripts/native-string-transcendental-oracle.py runs
 * the original Core.dll bytes, but its softfloat implements FSIN/FCOS/FPTAN/
 * FPATAN by round-tripping through a host double: every emulated result has its
 * low 11 significand bits clear, and its NaN, infinity and out-of-range edges
 * disagree with the hardware.  This validator instead builds
 * tools/x87-transcendental-probe.c and runs it under CrossOver/Wine so the
 * instructions execute through Rosetta 2 on the real FPU, then compares the
 * VM's bound results bit-exactly.
 *
 *   node scripts/validate-x87-transcendental-hardware.mjs [sweep] [maxExp]
 *
 * Skips loudly (exit 0) when the toolchain or bottle is absent: this is a
 * hardware measurement, not a pure-software check.
 */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFunction } from '../src/runtime/script-vm.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wine = process.env.X87_PROBE_WINE
  || '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine';
const bottle = process.env.X87_PROBE_BOTTLE || 'DeusEx';
const cc = process.env.X87_PROBE_CC || 'i686-w64-mingw32-gcc';
const sweep = process.argv[2] ?? '300000';
const maxExp = process.argv[3] ?? '26';

const skip = reason => {
  console.log(`SKIP validate-x87-transcendental-hardware: ${reason}`);
  process.exit(0);
};
if (!existsSync(wine)) skip(`no CrossOver/Wine at ${wine} (set X87_PROBE_WINE)`);
try { execFileSync('which', [cc], { stdio: 'ignore' }); }
catch { skip(`no ${cc} on PATH (brew install mingw-w64)`); }

const exe = path.join(root, '.cache', 'x87-transcendental-probe.exe');
mkdirSync(path.join(root, '.cache'), { recursive: true });
execFileSync(cc, ['-O1', '-o', exe, path.join(root, 'tools', 'x87-transcendental-probe.c')]);
const csv = execFileSync(wine, [exe, sweep, maxExp],
  { env: { ...process.env, CX_BOTTLE: bottle }, maxBuffer: 1 << 30, encoding: 'utf8' });

const NATIVE = { sin: 187, cos: 188, tan: 189, atan: 190 };
const view = new DataView(new ArrayBuffer(16));
const floatLiteral = bits => {
  view.setUint32(0, bits >>> 0, true);
  return { bytes: [0x1e, view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)], cost: 5 };
};
// One-call fixture, identical in shape to the other native validators.
const fixture = (index, args) => compileFunction({
  pkg: { imports: [], exports: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }] },
  entry: { path: `Fixture.Native${index}` },
  bytes: Uint8Array.from([0x04, ...(index > 0xff ? [0x60 | (index >> 8), index & 0xff] : [index]),
    ...args.flatMap(arg => arg.bytes), 0x16]),
  size: 3 + (index > 0xff ? 1 : 0) + args.reduce((n, arg) => n + arg.cost, 0),
});
// Non-finite operands cannot be encoded as a float literal (the decoder
// refuses them), so they cross through an instance variable exactly as the
// other native validators do.
const variable = index => ({ bytes: [0x01, index], cost: 5 });
const io = new DataView(new ArrayBuffer(4));
const bitsOf = v => (io.setFloat32(0, Math.fround(v), true), io.getUint32(0, true));
const numOf = b => (io.setUint32(0, b >>> 0, true), io.getFloat32(0, true));

const stats = {}, refused = {};
let rows = 0, defaultCw = null;
for (const line of csv.split('\n')) {
  if (!line) continue;
  if (line.startsWith('#')) { defaultCw = line.split('=')[1]; continue; }
  const [name, inBits, outBits, significand] = line.split(',');
  const index = NATIVE[name];
  assert.ok(index, `unknown probe function ${name}`);
  const input = parseInt(inBits, 16) >>> 0, expected = parseInt(outBits, 16) >>> 0;
  stats[name] = stats[name] || { n: 0, lowClear: 0 };
  stats[name].n++; rows++;
  if ((BigInt('0x' + significand) & 0x7ffn) === 0n) stats[name].lowClear++;

  let actual;
  try {
    const finite = (input & 0x7f800000) !== 0x7f800000;
    actual = finite
      ? bitsOf(fixture(index, [floatLiteral(input)]).run({}))
      : bitsOf(fixture(index, [variable(1)]).run({ A: numOf(input) }));
  } catch (error) {
    // Above the measured 2^26 reduction bound the VM refuses rather than
    // answering; that is only legitimate for genuinely out-of-bound operands.
    io.setUint32(0, input, true);
    const x = Math.abs(io.getFloat32(0, true));
    assert.ok(x >= 2 ** 26 && x < 2 ** 63,
      `${name} ${inBits}: refused an operand inside the supported range: ${error.message}`);
    refused[name] = (refused[name] || 0) + 1;
    continue;
  }
  assert.equal(actual, expected,
    `${name}(${inBits}): VM ${actual.toString(16).padStart(8, '0')} != hardware ${outBits}`);
}
assert.ok(rows > 1000, `probe produced only ${rows} rows`);

// The probe must be running real silicon, not another softfloat: a double
// round-trip leaves every low 11 significand bits clear.  Genuine hardware
// results keep them for ordinary computed values.
const computed = Object.entries(stats).filter(([name]) => name !== 'atan');
for (const [name, s] of computed)
  assert.ok(s.lowClear < s.n,
    `${name}: every result had a 53-bit significand — the probe is not running real x87`);

console.log(`x87 control word ${defaultCw}; ${rows} real-hardware results compared bit-exact `
  + `(|x| < 2^${maxExp}): ` + Object.entries(stats)
    .map(([k, s]) => `${k} ${s.n}${refused[k] ? ` (+${refused[k]} refused above 2^26)` : ''}`).join(', '));
