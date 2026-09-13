/** Validate Core.Object.Divide_IntInt (native 145) against the original DLL. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { readFunctionMetadata } from '../src/unreal/script-metadata.mjs';
import { compileFunction, primitiveNativeIndices } from '../src/runtime/script-vm.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const python = process.env.DEUS_EX_NATIVE_PYTHON ?? '.cache/native-probe-env/bin/python';
const oracle = JSON.parse(execFileSync(python, [
  path.resolve('scripts/native-divide-int-oracle.py'), root,
], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }));

const CORE_HASH = '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4';
const coreDll = await readFile(`${root}/System/Core.dll`);
const coreU = await readFile(`${root}/System/Core.u`, 'utf8');
assert.equal(createHash('sha256').update(coreDll).digest('hex'), CORE_HASH, 'Core.dll hash');
assert.deepEqual(oracle.hashes, { 'Core.dll': CORE_HASH });
assert.deepEqual(oracle.addresses, {
  nativeIndex: 145,
  thunk: '0x10101677',
  body: '0x10133710',
  idiv: '0x1013376c',
  evaluatorTable: '0x101f41b8',
});
assert.deepEqual(oracle.tokens, { IntConst: '0x1d', EndFunctionParms: '0x16' });
assert.match(coreU, /native\(145\)\s+static final operator\(16\)\s+int\s+\/\s+\(\s*int A,\s*int B\s*\)/);

// The thunk is at image RVA 0x1677 and jumps to the body at RVA 0x33710.
assert.equal(coreDll.subarray(0x1677, 0x167c).toString('hex'), 'e994200300');
const bodyHex = '51568b74240c5733ff8b460c33d2897c24088b4e088a104089460c8d4424085056ff1495b8411f108b460c33d2897c24108d4c24108a1040518b4e085689460cff1495b8411f108b4e0c41894e0c8b4c24103bcf74138b4424085f99f7f98b5424105e890259c208008b44241489385f5e59c2';
assert.equal(coreDll.subarray(0x33710, 0x33783).toString('hex'), bodyHex);
assert.equal(coreDll.subarray(0x33710 + 0x52, 0x33710 + 0x56).toString('hex'), '3bcf7413');
assert.equal(coreDll.subarray(0x33710 + 0x5c, 0x33710 + 0x5e).toString('hex'), 'f7f9');

const files = [];
for (const name of await readdir(`${root}/System`))
  files.push({ path: name, read: () => readFile(`${root}/System/${name}`) });
const core = await new AssetStore(files).get('Core');
const exportIndex = core.exportsByPath.get('object.divide_intint');
assert.ok(exportIndex, 'missing Core.Object.Divide_IntInt');
const metadata = readFunctionMetadata(core, exportIndex);
assert.equal(metadata.nativeIndex, 145);
assert.equal(metadata.operatorPrecedence, 16);
assert.equal(metadata.scriptSize, 10);
assert.deepEqual([...metadata.scriptBytes], [0x29, 0x7e, 0x01, 0x29, 0x7f, 0x01]);
assert.deepEqual(metadata.parameters.filter(parameter => !parameter.return).map(parameter => [
  parameter.name, parameter.type, parameter.optional,
]), [
  ['A', 'int', false],
  ['B', 'int', false],
]);
assert.ok(primitiveNativeIndices.includes(145), 'native 145 is linked');

const fixture = bytes => compileFunction({
  pkg: { imports: [], exports: [{ name: 'A' }, { name: 'B' }] },
  entry: { path: 'Fixture.DivideIntInt' },
  bytes: Uint8Array.from(bytes),
  size: 14,
});
const binary = [0x04, 0x60, 145, 0x01, 0x01, 0x01, 0x02, 0x16];
const vm = fixture(binary);
const execute = (dividend, divisor, receiver = { A: dividend, B: divisor }) => vm.run(receiver);

for (const original of oracle.cases) {
  assert.equal(original.codeAdvance, 3, `${original.name}: FFrame cursor advance`);
  assert.deepEqual(original.events, [original.dividend, original.divisor],
    `${original.name}: left-to-right operand evaluation`);
  if (original.divisor === 0) {
    assert.equal(original.status, 'ok', `${original.name}: zero-divisor status`);
    assert.equal(original.result, 0, `${original.name}: zero-divisor result`);
    assert.equal(original.didIdiv, false, `${original.name}: zero-divisor guard`);
    assert.equal(execute(original.dividend, original.divisor), 0,
      `${original.name}: VM result`);
  } else if (original.dividend === -(2 ** 31) && original.divisor === -1) {
    assert.equal(original.status, 'cpu-exception', `${original.name}: overflow status`);
    assert.equal(original.exception, 'UC_ERR_EXCEPTION', `${original.name}: overflow exception`);
    assert.equal(original.didIdiv, true, `${original.name}: IDIV reached`);
    assert.throws(() => execute(original.dividend, original.divisor),
      /Divide_IntInt signed overflow \(x86 divide exception\)/,
      `${original.name}: VM exception`);
  } else {
    assert.equal(original.status, 'ok', `${original.name}: status`);
    assert.equal(original.didIdiv, true, `${original.name}: IDIV reached`);
    const expected = (Math.trunc(original.dividend / original.divisor)) | 0;
    assert.equal(original.result, expected, `${original.name}: original quotient`);
    assert.equal(execute(original.dividend, original.divisor), expected,
      `${original.name}: VM quotient`);
  }
}

const evaluation = [];
const receiver = {};
for (const [name, value] of [['A', 19], ['B', -4]]) {
  Object.defineProperty(receiver, name, {
    enumerable: true,
    get() { evaluation.push(name); return value; },
  });
}
assert.equal(execute(0, 0, receiver), -4, 'getter fixture quotient');
assert.deepEqual(evaluation, ['A', 'B'], 'VM evaluates Divide_IntInt operands left to right');
assert.equal(execute(0x1_0000_0001, 0x1_0000_0002), 0, 'int operands are int32 values');

console.log(`Original Core native 145 passed ${oracle.cases.length} signed division, zero-guard, overflow, operand-order, and FFrame cursor cases.`);
