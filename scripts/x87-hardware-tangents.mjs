/** Core appTan (0x10123260: fld qword; fptan; fstp st(0)) measured on real
 * x87 hardware: tools/x87-transcendental-probe.c --double-tan under Wine
 * (X87_PROBE_WINE, X87_PROBE_CC), the extended result stored to a qword as
 * the Engine caller stores it. Returns Map(argument bits -> result bits, both
 * 16 hex digits), or null with a reason printed when the runner is missing.
 * Captures stay in .cache/x87-hardware-tangents. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { x87storeDouble } from '../src/runtime/script-vm.mjs';

const io = new DataView(new ArrayBuffer(8));
export const hex64 = value => (io.setFloat64(0, value, true), io.getBigUint64(0, true).toString(16).padStart(16, '0'));

export function measureTangents(argumentBits, label = 'x87 hardware') {
  const wine = process.env.X87_PROBE_WINE || '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine';
  const cc = process.env.X87_PROBE_CC || 'i686-w64-mingw32-gcc';
  if (!existsSync(wine)) { console.log(`${label}: no real-x87 runner at ${wine} (set X87_PROBE_WINE); tangents come from the FPTAN model`); return null; }
  try { execFileSync('which', [cc], { stdio: 'ignore' }); } catch { console.log(`${label}: no compiler ${cc}; tangents come from the FPTAN model`); return null; }
  const capture = path.resolve('.cache/x87-hardware-tangents');
  mkdirSync(capture, { recursive: true });
  const executable = path.join(capture, 'tangent-probe.exe');
  execFileSync(cc, ['-O1', '-o', executable, path.resolve('tools/x87-transcendental-probe.c')], { timeout: 30000 });
  const input = [...new Set(argumentBits)].join('\n') + '\n';
  const csv = execFileSync(wine, [executable, '--double-tan'], { input, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CX_BOTTLE: process.env.X87_PROBE_BOTTLE || 'DeusEx' } });
  writeFileSync(path.join(capture, 'tangent-inputs.txt'), input);
  writeFileSync(path.join(capture, 'tangent-hardware.csv'), csv);
  const tangents = new Map();
  for (const line of csv.trim().split(/\r?\n/)) {
    const [argument, , significand, signExponent] = line.split(',');
    const se = parseInt(signExponent, 16), sig = BigInt(`0x${significand}`);
    if ((sig & 0x7ffn) === 0n) throw new Error('FPTAN output must retain real extended precision');
    const result = x87storeDouble({ neg: se >> 15, sig, exp: (se & 0x7fff) - 16383 - 63 });
    tangents.set(argument, hex64((result.neg ? -1 : 1) * Number(result.sig) * 2 ** result.exp));
  }
  if (tangents.size !== new Set(argumentBits).size) throw new Error('A tangent argument got no hardware result');
  return tangents;
}
