/** Validate Core.Object.ComplementEqual_StrStr (native 124) against Core.dll. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { readFunctionMetadata } from '../src/unreal/script-metadata.mjs';
import { compileFunction, primitiveNativeIndices } from '../src/runtime/script-vm.mjs';
import { scriptStringComplementEqual, scriptStringText } from '../src/runtime/script-string-operations.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const python = process.env.DEUS_EX_NATIVE_PYTHON ?? '.cache/native-probe-env/bin/python';
const oracle = JSON.parse(execFileSync(python, [
  path.resolve('scripts/native-complement-equal-oracle.py'), root,
], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }));

const coreDll = await readFile(`${root}/System/Core.dll`);
const coreU = await readFile(`${root}/System/Core.u`);
const coreHash = createHash('sha256').update(coreDll).digest('hex');
const coreUHash = createHash('sha256').update(coreU).digest('hex');
const CORE_HASH = '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4';
const CORE_U_HASH = '4fb22ee4e3a6868dfabb2b46b15fad8e5094f5fda5927a14ff11670a744ec36c';
assert.equal(coreHash, CORE_HASH, 'Core.dll hash');
assert.equal(coreUHash, CORE_U_HASH, 'Core.u hash');
assert.equal(oracle.hashes['Core.dll'], CORE_HASH, 'oracle Core.dll hash');
assert.equal(oracle.addresses.nativeIndex, 124);
assert.equal(oracle.addresses.thunk, '0x10101f50');
assert.equal(oracle.addresses.body, '0x1013b900');
assert.equal(oracle.addresses.appStricmp, '0x1010239c');
assert.match(coreU.toString('latin1'), /ComplementEqual_StrStr/);
const thunk = coreDll.subarray(0x1f50, 0x1f55);
assert.equal(thunk.toString('hex'), 'e9ab990300', 'native 124 export thunk bytes');
assert.equal((0x10101f55 + thunk.readInt32LE(1)) >>> 0, 0x1013b900,
  'native 124 thunk target');

const files = [];
for (const name of await readdir(`${root}/System`))
  files.push({ path: name, read: () => readFile(`${root}/System/${name}`) });
const core = await new AssetStore(files).get('Core');
const exportIndex = core.exportsByPath.get('object.complementequal_strstr');
assert.ok(exportIndex, 'missing Core.Object.ComplementEqual_StrStr');
const metadata = readFunctionMetadata(core, exportIndex);
assert.equal(metadata.nativeIndex, 124);
assert.equal(metadata.scriptSize, 10);
assert.deepEqual(metadata.parameters.filter(parameter => !parameter.return).map(parameter => [
  parameter.name, parameter.type, parameter.optional,
]), [
  ['A', 'string', false],
  ['B', 'string', false],
]);

assert.ok(primitiveNativeIndices.includes(124), 'native 124 is linked');
const nativeFixture = bytes => compileFunction({
  pkg: { imports: [], exports: [{ name: 'Value' }, { name: 'Amount' }] },
  entry: { path: 'Fixture.ComplementEqual' },
  bytes: Uint8Array.from(bytes),
  // Compact object references occupy four expanded bytes each.
  size: 14,
});
const vm = nativeFixture([0x04, 0x60, 124, 0x01, 0x01, 0x01, 0x02, 0x16]);

const expectedValues = [1, 1, 1, 0, 1, 0, 1, 1];
for (const [index, result] of oracle.cases.entries()) {
  assert.equal(result.codeAdvance, 3, `${result.left}/${result.right}: Code advance`);
  assert.deepEqual(result.events.map(event => event.kind), ['string', 'string'],
    `${result.left}/${result.right}: operand evaluation order`);
  assert.deepEqual(result.events.map(event => event.value), [result.left, result.right],
    `${result.left}/${result.right}: evaluated operands`);
  assert.equal(result.comparisons.length, 1, `${result.left}/${result.right}: appStricmp call count`);
  const comparison = result.comparisons[0];
  assert.equal(comparison.left, scriptStringText(result.left));
  assert.equal(comparison.right, scriptStringText(result.right));
  assert.equal(comparison.result === 0, result.value === 1,
    `${result.left}/${result.right}: bool normalization follows appStricmp`);
  assert.equal(result.value, expectedValues[index],
    `${result.left}/${result.right}: original result`);
  assert.equal(result.value, scriptStringComplementEqual(result.left, result.right) ? 1 : 0,
    `${result.left}/${result.right}: translated result`);
}

assert.equal(vm.run({ Value: 'MiXeD', Amount: 'mixed' }), true,
  'VM native 124 dispatch case');
assert.equal(vm.run({ Value: 'MiXeD', Amount: 'other' }), false,
  'VM native 124 mismatch case');

console.log(`Original Core native 124 passed ${oracle.cases.length} FFrame/appStricmp cases; ` +
  'ASCII-only folding, terminator handling, operand order and VM dispatch match.');
