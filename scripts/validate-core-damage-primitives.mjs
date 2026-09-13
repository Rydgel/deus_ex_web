/** Validate the Core arithmetic operators used before Training's radiation
 * damage path reaches the existing PlayAnim/mesh boundary.  The native cases
 * come from the hash-gated Core.dll oracle; the JS cases run the same original
 * bytecode VM expression shapes and compare float32 result/lvalue bits. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { AssetStore } from '../src/unreal/assets.mjs';
import { readFunctionMetadata } from '../src/unreal/script-metadata.mjs';
import { compileFunction } from '../src/runtime/script-vm.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const python = process.env.DEUS_EX_NATIVE_PYTHON ?? '.cache/native-probe-env/bin/python';
const native = JSON.parse(execFileSync(python, [
  'scripts/native-core-damage-primitives-oracle.py', root,
], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));

assert.deepEqual(native.hashes, {
  'Core.dll': '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4',
});
assert.deepEqual(native.addresses, {
  multiplyIntInt: { index: 144, thunk: 0x10102fae, body: 0x10133640 },
  negateFloat: { index: 169, thunk: 0x101014d3, body: 0x10134cf0 },
  subtractEqualFloat: { index: 185, thunk: 0x10101645, body: 0x10135b80 },
  multiplyFloatVector: { index: 213, thunk: 0x10102897, body: 0x101378d0 },
  addEqualVector: { index: 223, thunk: 0x10101447, body: 0x10138b10 },
});
assert.deepEqual(native.tokens, {
  FloatConst: '0x1e', IntConst: '0x1d', VectorConst: '0x23', EndFunctionParms: '0x16',
});

const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music']) {
  for (const name of await readdir(`${root}/${directory}`)) {
    const path = `${directory}/${name}`;
    files.push({ path, read: () => readFile(`${root}/${path}`) });
  }
}
const assets = new AssetStore(files);
const core = await assets.get('Core');
const declarations = [
  ['object.multiply_intint', 144],
  ['object.subtract_prefloat', 169],
  ['object.subtractequal_floatfloat', 185],
  ['object.multiply_floatvector', 213],
  ['object.addequal_vectorvector', 223],
];
for (const [path, index] of declarations) {
  const exportIndex = core.exportsByPath.get(path);
  assert.ok(exportIndex, `missing Core declaration ${path}`);
  assert.equal(readFunctionMetadata(core, exportIndex).nativeIndex, index);
}

const coreDll = await readFile(`${root}/System/Core.dll`);
const bytesAt = (rva, length) => [...coreDll.subarray(rva, rva + length)];
const thunks = [
  [0x2fae, [0xe9, 0x8d, 0x06, 0x03, 0x00]],
  [0x14d3, [0xe9, 0x18, 0x38, 0x03, 0x00]],
  [0x1645, [0xe9, 0x36, 0x45, 0x03, 0x00]],
  [0x2897, [0xe9, 0x34, 0x50, 0x03, 0x00]],
  [0x1447, [0xe9, 0xc4, 0x76, 0x03, 0x00]],
];
for (const [rva, bytes] of thunks) assert.deepEqual(bytesAt(rva, bytes.length), bytes);
assert.deepEqual(bytesAt(0x33640, 8), [0x51, 0x56, 0x8b, 0x74, 0x24, 0x0c, 0x33, 0xd2]);
assert.deepEqual(bytesAt(0x34cf0, 8), [0x51, 0x56, 0x8b, 0x74, 0x24, 0x0c, 0x33, 0xd2]);
assert.deepEqual(bytesAt(0x35b80, 8), [0x51, 0x56, 0x8b, 0x74, 0x24, 0x0c, 0x33, 0xd2]);
assert.deepEqual(bytesAt(0x378d0, 8), [0x83, 0xec, 0x1c, 0x56, 0x8b, 0x74, 0x24, 0x24]);
assert.deepEqual(bytesAt(0x38b10, 8), [0x83, 0xec, 0x18, 0x33, 0xd2, 0xc7, 0x05, 0xf8]);

const pkg = { imports: [], exports: [
  { name: 'A' }, { name: 'B' }, { name: 'C' },
] };
const compile = (bytes, size) => compileFunction({
  pkg, entry: { path: 'Fixture.CoreDamagePrimitives' }, bytes: Uint8Array.from(bytes), size,
});
const run = (index, fields, bytes) => {
  const instance = { ...fields };
  // Expanded object references occupy four bytes even though this fixture's
  // serialized compact indices occupy one byte each.
  const result = compile(bytes, index === 169 ? 9 : 14).run(instance);
  return { result, instance };
};
const floatBits = value => {
  const buffer = new ArrayBuffer(4), view = new DataView(buffer);
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
};
const floatBitsList = value => Array.isArray(value) ? value.map(floatBits) : [floatBits(value)];

// Field references are one-byte expanded object indices in these fixtures.
const unaryFloat = index => [0x04, 0x60, index, 0x01, 0x01, 0x16];
const binary = index => [0x04, 0x60, index, 0x01, 0x01, 0x01, 0x02, 0x16];

const jsCases = [
  ['multiplyIntInt', 144, { A: 300, B: -7 }, binary(144), -2100],
  ['multiplyIntInt overflow', 144, { A: 0x40000000, B: 4 }, binary(144), 0],
  ['negateFloat', 169, { A: 3.5 }, unaryFloat(169), -3.5],
  ['negateFloat signed zero', 169, { A: -0 }, unaryFloat(169), 0],
  ['subtractEqualFloat', 185, { A: 1 + 2 ** -25, B: 0.25 }, binary(185), Math.fround(1 - 0.25)],
  ['subtractEqualFloat signed zero', 185, { A: -0, B: 0 }, binary(185), -0],
  ['multiplyFloatVector', 213, { A: 0.1, B: [1, -2, 50] }, binary(213), [0.1, -0.2, 5]],
  ['addEqualVector', 223, { A: [0.1, -2, 3], B: [0.2, 4, -5] }, binary(223), [0.3, 2, -2]],
];
assert.equal(native.cases.length, jsCases.length);
for (const [caseIndex, [name, index, fields, bytecode, expected]] of jsCases.entries()) {
  const { result, instance } = run(index, fields, bytecode);
  const nativeCase = native.cases[caseIndex];
  assert.ok(nativeCase, `missing native case ${name}`);
  if (index === 144) {
    assert.equal(result, expected, `${name} JS result`);
    assert.equal(nativeCase.result[0], expected, `${name} native result`);
  } else {
    const expectedBits = floatBitsList(expected);
    assert.deepEqual(floatBitsList(result), expectedBits, `${name} JS result`);
    if (index === 185 || index === 223) {
      assert.deepEqual(floatBitsList(instance.A), expectedBits, `${name} out lvalue`);
      assert.deepEqual(nativeCase.lvalueBits, expectedBits, `${name} native out lvalue`);
    } else {
      assert.deepEqual(nativeCase.resultBits, expectedBits, `${name} native result`);
    }
    assert.deepEqual(nativeCase.resultBits, floatBitsList(result), `${name} native/JS result`);
  }
  if (index === 185 || index === 223) {
    const expectedBits = floatBitsList(expected);
    assert.deepEqual(floatBitsList(instance.A), expectedBits, `${name} out lvalue`);
    assert.deepEqual(nativeCase.lvalueBits, expectedBits, `${name} native out lvalue`);
  }
  assert.equal(nativeCase.codeAdvance, index === 169 ? 2 : 3, `${name} FFrame advance`);
}

console.log(`Original Core.dll arithmetic natives passed ${native.cases.length} focused FFrame, float32, vector-lvalue, and overflow cases.`);
