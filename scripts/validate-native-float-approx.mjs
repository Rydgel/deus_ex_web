import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { compileFunction, primitiveNativeIndices } from '../src/runtime/script-vm.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const python = process.env.DEUS_EX_NATIVE_PYTHON ?? '.cache/native-probe-env/bin/python';
const original = JSON.parse(execFileSync(python, ['scripts/native-float-approx-oracle.py', root], {
  encoding: 'utf8', maxBuffer: 1024 * 1024,
}));
const coreDll = await readFile(`${root}/System/Core.dll`);
const coreU = await readFile(`${root}/System/Core.u`, 'utf8');

const CORE_HASH = '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4';
assert.equal(createHash('sha256').update(coreDll).digest('hex'), CORE_HASH);
assert.match(coreU, /native\(210\)\s+static final operator\(24\)\s+bool\s+~=\s+\(\s*float A,\s*float B\s*\)/);
assert.equal(original.body, '0x101357e0');
assert.deepEqual(original.hashes, {
  'Engine.dll': '0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4',
  'Core.dll': CORE_HASH,
});

// Core's native export table thunk 0x10103170 jumps to the body below. The
// complete body pin includes the two operand evaluations, x87 fsub/fcom/fchs,
// threshold fcomp, result branches, and both stdcall returns.
const thunk = coreDll.subarray(0x3170, 0x3175);
assert.equal(thunk.toString('hex'), 'e96b260300');
assert.equal((0x10103175 + thunk.readInt32LE(1)) >>> 0, 0x101357e0);
const bodyHex = [
  '51568b74240c33d2c7442404000000008b460c8b4e088a104089460c8d4424045056',
  'ff1495b8411f108b460c33d2c744240c000000008d4c240c8a1040518b4e085689',
  '460cff1495b8411f10d9442404d864240c8b460c40d815c465171089460c5edfe0',
  'f6c4017402d9e0dc1db8651710dfe0f6c401740f8b54240cb801000000890259c2',
  '08008b4c240c33c0890159c20800',
].join('');
assert.equal(coreDll.subarray(0x357e0, 0x35873).toString('hex'), bodyHex);
const constants = new DataView(coreDll.buffer, coreDll.byteOffset);
assert.equal(constants.getFloat64(0x765b8, true), 0.0001);
assert.equal(constants.getFloat32(0x765c4, true), 0);

const floatBuffer = new ArrayBuffer(4);
const floatView = new DataView(floatBuffer);
const fromBits = bits => {
  floatView.setUint32(0, bits, true);
  return floatView.getFloat32(0, true);
};
function floatNative(a, b) {
  const bytes = [0x04, 0x60, 210, 0x01, 0x01, 0x01, 0x02, 0x16];
  return compileFunction({
    pkg: { imports: [], exports: [{ name: 'Value' }, { name: 'Amount' }] },
    entry: { path: 'Fixture.FloatApprox' }, bytes: Uint8Array.from(bytes), size: 14,
  }).run({ Value: a, Amount: b });
}

assert.ok(primitiveNativeIndices.includes(210));
assert.equal(original.results.length, 12);
for (const result of original.results) {
  assert.equal(result.codeAdvance, 3, `${result.name}: EX_EndFunctionParms cursor advance`);
  assert.equal(floatNative(fromBits(result.aBits), fromBits(result.bBits)), result.result, result.name);
}
assert.deepEqual(original.results.map(result => [result.name, result.result]), [
  ['equal', true],
  ['operand-rounding', true],
  ['signed-zero-left', true],
  ['signed-zero-right', true],
  ['threshold-nearest-below', true],
  ['threshold-nearest-above', false],
  ['threshold-nearest-above-negative', false],
  ['unordered-left', true],
  ['unordered-right', true],
  ['infinite-equal', true],
  ['infinite-finite', false],
  ['negative-infinite-finite', false],
]);
console.log(`Original Core native 210 passed ${original.results.length} float32/x87 comparison cases; strict threshold and unordered behavior match.`);
