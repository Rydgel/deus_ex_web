/**
 * Core FloatToInt (token 0x44, 10131b40) and FloatToByte (0x43, 10131aa0)
 * against the game's own MSVCRT _ftol executed on REAL x87 silicon. Both
 * handlers FLD the float32 operand and call _ftol through 1016eec0 -> IAT
 * 102ab4b8; the shipped System/MSVCRT.dll exports it at 0x78004dc1 (fnstcw;
 * or ah,0xc; fldcw; fistp qword; fldcw; edx:eax).
 *
 * Builds tools/x87-ftol-probe.c, copies the game's MSVCRT.dll to a private
 * name so Wine's builtin msvcrt cannot be substituted, and runs it under
 * Wine/CrossOver. Every row's low DWORD is compared with the JavaScript VM's
 * FloatToInt and FloatToByte bytecode and the shared x87ftol helper; the Rust
 * VM is compared with the same floatToInt reference by
 * scripts/validate-script-vm-interp.mjs.
 *
 * Skips loudly (exit 0) when the toolchain or Wine is absent: this is a
 * hardware measurement, not a pure-software check.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gameDirectory } from './game-directory.mjs';
import { compileFunction, floatToInt, x87ftol } from '../src/runtime/script-vm.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wine = process.env.X87_PROBE_WINE
  || '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine';
const bottle = process.env.X87_PROBE_BOTTLE || 'DeusEx';
const cc = process.env.X87_PROBE_CC || 'i686-w64-mingw32-gcc';

const skip = reason => { console.log(`SKIP validate-x87-ftol-hardware: ${reason}`); process.exit(0); };
if (!existsSync(wine)) skip(`no CrossOver/Wine at ${wine} (set X87_PROBE_WINE)`);
try { execFileSync('which', [cc], { stdio: 'ignore' }); }
catch { skip(`no ${cc} on PATH (brew install mingw-w64)`); }

const cache = path.join(root, '.cache');
mkdirSync(cache, { recursive: true });
const exe = path.join(cache, 'x87-ftol-probe.exe');
const dll = path.join(cache, 'msvcrt-goty-ftol.dll');
copyFileSync(path.join(gameDirectory(), 'System', 'MSVCRT.dll'), dll);
execFileSync(cc, ['-O1', '-o', exe, path.join(root, 'tools', 'x87-ftol-probe.c')]);
const csv = execFileSync(wine, [exe, `Z:${dll.replaceAll('/', '\\')}`],
  { env: { ...process.env, CX_BOTTLE: bottle, WINEDEBUG: '-all' }, maxBuffer: 1 << 26, encoding: 'utf8' });

const io = new DataView(new ArrayBuffer(4));
const numOf = b => (io.setUint32(0, b >>> 0, true), io.getFloat32(0, true));
// Script float literals are finite (the package reader rejects others), so a
// nonfinite operand is Divide_FloatFloat (native 172): 0/0 is the x87
// indefinite NaN, +-1/0 an infinity.  _ftol ignores the NaN payload.
const literal = v => { const b = new Uint8Array(5); b[0] = 0x1e; new DataView(b.buffer).setFloat32(1, v, true); return [...b]; };
const operand = v => Number.isFinite(v) ? literal(v)
  : [0xac, ...literal(Number.isNaN(v) ? 0 : Math.sign(v)), ...literal(0), 0x16];
const bytecode = (token, v) => {
  const bytes = Uint8Array.from([0x04, token, ...operand(v)]);
  return compileFunction({ entry: { path: `fixture.${token.toString(16)}` }, pkg: {}, bytes, size: bytes.length }).run({});
};
// x87 operand for x87ftol: the float32 exactly, as FLDS loads it.
const x87of = v => {
  if (Number.isNaN(v)) return { nan: 1 };
  if (!Number.isFinite(v)) return { inf: 1, neg: v < 0 ? 1 : 0 };
  if (v === 0) return { neg: 0, sig: 0n, exp: 0 };
  let m = Math.abs(v), e = 0;
  while (!Number.isInteger(m)) { m *= 2; e--; }
  return { neg: v < 0 ? 1 : 0, sig: BigInt(m), exp: e };
};

let rows = 0, indefinite = 0, cw = null, offset = null;
for (const line of csv.split(/\r?\n/)) {
  if (!line) continue;
  if (line.startsWith('#cw=')) { cw = line.slice(4); continue; }
  if (line.startsWith('#ftol=')) { offset = line.slice(6); continue; }
  const [bitsHex, hiHex, loHex] = line.split(',');
  const bits = parseInt(bitsHex, 16) >>> 0, hi = parseInt(hiHex, 16) >>> 0, lo = parseInt(loHex, 16) | 0;
  const v = numOf(bits);
  if (hi === 0x80000000 && lo === 0) indefinite++;
  assert.equal(floatToInt(v), lo, `floatToInt ${bitsHex}`);
  assert.equal(x87ftol(x87of(v)), lo, `x87ftol ${bitsHex}`);
  assert.equal(bytecode(0x44, v), lo, `FloatToInt bytecode ${bitsHex}`);
  assert.equal(bytecode(0x43, v), lo & 255, `FloatToByte bytecode ${bitsHex}`);
  rows++;
}
assert.equal(offset, '00004dc1', 'the probe called the game MSVCRT _ftol export, not a builtin');
assert.ok(rows > 20000 && indefinite > 5000, 'the probe covers finite, NaN, infinity and int64-overflow inputs');
console.log(`Core FloatToInt/FloatToByte match the game's MSVCRT _ftol on real x87 for ${rows} float32 inputs (cw ${cw}; ${indefinite} integer-indefinite results give 0).`);
