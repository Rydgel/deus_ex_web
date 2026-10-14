// The light manager's tables in the running original against Play's builders (docs/render-pass-precision.md "Measured in the
// running original"). `scripts/original-fpu.sh` dumps the five tables at the end of a run of the original under Wine
// (.work/fpu/*.bin); URender::Init builds them on the game thread before any frame at x87 control word 0x027f (measured), so a
// bit-exact match here shows that Play's builders (the 64-bit x87 model) equal the original's tables at that word, whatever the
// oracle's init word. The dumps are an ignored local capture: without them this validator is skipped.
//
//   node scripts/validate-original-light-tables.mjs [dir]       (default .work/fpu)
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { squareRootTable, normalLightTable } from '../src/runtime/dynamic-lighting.mjs';
import { shadowTable, rsqrtTables } from '../src/runtime/static-lighting.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = process.argv[2] ?? path.join(root, '.work/fpu');
const need = ['sqrt', 'normal', 'shadow', 'rsqrt-mantissa', 'rsqrt-exponent'].map(name => path.join(dir, `${name}.bin`));
if (!need.every(existsSync)) { console.log(`SKIP validate-original-light-tables: no dumps in ${dir} (scripts/original-fpu.sh)`); process.exit(0); }
const words = file => { const b = readFileSync(file); return new Uint32Array(b.buffer, b.byteOffset, b.length / 4); };
const bitsOf = floats => new Uint32Array(floats.buffer, floats.byteOffset, floats.length);
const compare = (name, original, play) => {
  assert.equal(original.length, play.length, `${name}: ${original.length} original entries, ${play.length} in Play`);
  let different = 0, first = -1;
  for (let i = 0; i < original.length; i++) if (original[i] !== play[i]) { different++; if (first < 0) first = i; }
  console.log(`${name}: ${original.length} entries, ${different} differ${different ? ` (first ${first}: original 0x${original[first].toString(16)}, Play 0x${play[first].toString(16)})` : ''}`);
  assert.equal(different, 0, `${name} differs from the original's table`);
};
compare('square-root table (0x10b3e1b8)', words(need[0]), squareRootTable());
compare('normal-falloff table (0x10b34a6c)', words(need[1]), bitsOf(normalLightTable()));
compare('shadow-blur table (0x10b3cae0)', readFileSync(need[2]), shadowTable);
const rsqrt = rsqrtTables();
compare('x^-0.5 mantissas (0x10b33650)', words(need[3]), bitsOf(rsqrt.mantissa));
compare('x^-0.5 exponents (0x10b3d384)', words(need[4]), bitsOf(rsqrt.exponent));
console.log('PASS validate-original-light-tables');
