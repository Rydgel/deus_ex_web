/** The Core primitive casts added in src/runtime/script-core-casts.mjs against
 * the original handlers (scripts/native-core-cast-oracle.py, Unicorn over the
 * hash-checked Core.dll), through the JavaScript VM's bytecode path. The
 * string-producing casts 0x4c/0x52/0x54 are constant or MSVCRT-backed and are
 * covered by validate-msvcrt-text-hardware.mjs plus the fixed expectations
 * below. See docs/script-core-casts.md. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
import {compileFunction} from '../src/runtime/script-vm.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? process.env.DEUS_EX_NATIVE_PYTHON ?? '.cache/native-probe-env/bin/python';
const cases = JSON.parse(execFileSync(python, ['scripts/native-core-cast-oracle.py', gameDirectory()], {encoding: 'utf8'}));

const literal = {
  0x24: v => [0x24, v & 255],
  0x1d: v => { const b = new Uint8Array(5); b[0] = 0x1d; new DataView(b.buffer).setInt32(1, v, true); return [...b]; },
  0x1e: v => { const b = new Uint8Array(5); b[0] = 0x1e; new DataView(b.buffer).setFloat32(1, v, true); return [...b]; },
};
// The package reader rejects non-finite literals, so NaN/Inf come from Divide_FloatFloat (native 172).
const floatOperand = v => Number.isFinite(v) ? literal[0x1e](v)
  : [0xac, ...literal[0x1e](Number.isNaN(v) ? 0 : Math.sign(v)), ...literal[0x1e](0), 0x16];
const run = (token, operand) => {
  const bytes = Uint8Array.from([0x04, token, ...operand]);
  return compileFunction({entry: {path: `fixture.${token.toString(16)}`}, pkg: {}, bytes, size: bytes.length}).run({});
};
const operandKind = {0x3b: 'byte', 0x3e: 'int', 0x40: 'bool', 0x41: 'bool', 0x42: 'bool', 0x45: 'float'};
let compared = 0;
for (const c of cases) {
  assert.equal(c.codeAdvance, 1, 'the handler consumes exactly its operand token');
  const kind = operandKind[c.token];
  if (kind === 'bool' && c.input > 1) continue;   // the VM's bool is a JavaScript boolean: only the 0/1 operands exist
  const input = typeof c.input === 'string' ? {inf: Infinity, '-inf': -Infinity, nan: NaN}[c.input] : c.input;
  const operand = kind === 'byte' ? literal[0x24](input) : kind === 'int' ? literal[0x1d](input)
    : kind === 'bool' ? [input ? 0x27 : 0x28] : floatOperand(input);
  const got = run(c.token, operand);
  const want = c.token === 0x3b || c.token === 0x3e || c.token === 0x45 ? Boolean(c.result) : c.result;
  assert.equal(got, want, `cast 0x${c.token.toString(16)} of ${c.input}`);
  compared++;
}
// 0x52 ByteToString / 0x54 BoolToString: Printf("%i", byte) and the "True"/"False" constants.
for (const v of [0, 7, 255]) assert.equal(run(0x52, literal[0x24](v)), String(v));
assert.equal(run(0x54, [0x27]), 'True');
assert.equal(run(0x54, [0x28]), 'False');
console.log(`Core casts 0x3b 0x3e 0x40 0x41 0x42 0x45: ${compared} oracle cases identical; ByteToString/BoolToString constants checked`);
